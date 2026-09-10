# tests/test_chat_mount.py
"""TreeChat 挂载测试：/treechat/api/* 经 server.chat.mount_chat 引入的行为契约。

隔离：不依赖全局 app——mount_chat 注入 tmp base_dir，会话文件落在
tmp/.treechat/sessions；LLM 客户端替换走子应用 registry（app.state.chat_registry，
对齐 treechat 自家 conftest 的假客户端模式）。treechat 缺席时整模块跳过。
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

pytest.importorskip("treechat")

from llm import LLMError, LLMResponse  # noqa: E402

from server.chat import mount_chat  # noqa: E402


class FakeChatClient:
    """带 chat() 的假客户端：固定回复 / 可选失败（对齐 treechat conftest）。"""

    def __init__(self, reply: str = "mock reply", fail: bool = False) -> None:
        self.reply, self.fail = reply, fail
        self.config = type("Config", (), {"model": "fake-model"})()

    async def chat(self, messages):
        if self.fail:
            raise LLMError("模拟基础设施故障")
        return LLMResponse(content=self.reply,
                           usage={"input_tokens": 1, "output_tokens": 2})


@pytest.fixture
def env(tmp_path):
    """隔离挂载的三元组：(TestClient, base_dir, 子应用 registry)。"""
    app = FastAPI()
    assert mount_chat(app, base_dir=tmp_path) is True
    return TestClient(app), tmp_path, app.state.chat_registry


# ── 健康 / 挂载 ──

def test_health_reports_workspace_data_dir(env):
    c, base, _ = env
    r = c.get("/treechat/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert "llmConfigured" in body
    from pathlib import Path
    assert Path(body["dataDir"]) == base / ".treechat"


def test_treechat_data_dir_env_override(tmp_path, monkeypatch):
    override = tmp_path / "custom chats"
    monkeypatch.setenv("TREECHAT_DATA_DIR", str(override))
    app = FastAPI()
    assert mount_chat(app, base_dir=tmp_path) is True
    r = TestClient(app).get("/treechat/api/health")
    assert r.status_code == 200
    from pathlib import Path
    assert Path(r.json()["dataDir"]) == override


# ── 会话生命周期 ──

def test_session_lifecycle(env):
    c, _, _ = env
    # 创建：sid = name；重名 409
    r = c.post("/treechat/api/sessions", json={"name": "日常", "system": "简洁"})
    assert r.status_code == 200
    assert c.post("/treechat/api/sessions", json={"name": "日常"}).status_code == 409
    # 枚举
    sessions = c.get("/treechat/api/sessions").json()
    assert [s["sid"] for s in sessions] == ["日常"]
    assert sessions[0]["nodeCount"] == 0
    # 全量状态（空会话形状）
    st = c.get("/treechat/api/sessions/日常").json()
    assert st["sid"] == "日常" and st["name"] == "日常" and st["system"] == "简洁"
    assert st["nodes"] == [] and st["pointer"] is None and st["cards"] == []
    # 重命名 / 分类 / 归档 → 全量状态回流
    st = c.post("/treechat/api/sessions/日常/rename", json={"name": "工作"}).json()
    assert st["name"] == "工作"
    st = c.post("/treechat/api/sessions/日常/category", json={"category": "跑腿"}).json()
    assert st["category"] == "跑腿"
    st = c.post("/treechat/api/sessions/日常/archive", json={"archived": True}).json()
    assert st["archived"] is True
    # 删除（sid 恒为创建名，rename 只改显示名）：204 → 404 → 再删 404
    assert c.delete("/treechat/api/sessions/日常").status_code == 204
    assert c.get("/treechat/api/sessions/日常").status_code == 404
    assert c.delete("/treechat/api/sessions/日常").status_code == 404


def test_illegal_and_unknown_sid(env):
    c, _, _ = env
    # 路径穿越 sid（a%5Cb = a\b）：delete 走 session_path 校验 → 400
    assert c.delete("/treechat/api/sessions/a%5Cb").status_code == 400
    # 未知 sid：GET/DELETE 404
    assert c.get("/treechat/api/sessions/不存在").status_code == 404
    assert c.delete("/treechat/api/sessions/不存在").status_code == 404


# ── 轮次（stub client 注入 registry）──

def _reopen_with(registry, sid: str, client: FakeChatClient) -> None:
    """替换 client_factory 后 drop 重开：registry.get 会用新工厂建会话客户端。"""
    registry._client_factory = lambda model: client
    registry.drop(sid)


def test_turn_success(env):
    c, _, reg = env
    c.post("/treechat/api/sessions", json={"name": "t"})
    _reopen_with(reg, "t", FakeChatClient(reply="这是回复"))
    r = c.post("/treechat/api/sessions/t/turn", json={"text": "你好"})
    assert r.status_code == 200
    st = r.json()
    assert [n["role"] for n in st["nodes"]] == ["user", "assistant"]
    assert st["nodes"][1]["text"] == "这是回复"
    assert st["nodes"][1]["model"] == "fake-model"
    # seq 计数含 meta 事件（首节点 seq=2），指针落在末节点——不硬编码具体值
    assert st["pointer"] == st["nodes"][-1]["seq"]
    assert st["unansweredUser"] is None


def test_turn_llm_failure_contract(env):
    """LLM 失败 → 502 {error, state}：user 节点已落盘（悬而未答），前端据此更新。"""
    c, _, reg = env
    c.post("/treechat/api/sessions", json={"name": "f"})
    _reopen_with(reg, "f", FakeChatClient(fail=True))
    r = c.post("/treechat/api/sessions/f/turn", json={"text": "你好"})
    assert r.status_code == 502
    body = r.json()
    assert "模拟基础设施故障" in body["error"]
    st = body["state"]
    assert [n["role"] for n in st["nodes"]] == ["user"]
    assert st["unansweredUser"] == st["nodes"][0]["seq"]
    # 重试换好客户端 → 补 assistant，问题不丢不重复
    _reopen_with(reg, "f", FakeChatClient(reply="补上了"))
    r = c.post("/treechat/api/sessions/f/retry")
    assert r.status_code == 200
    st = r.json()
    assert [n["role"] for n in st["nodes"]] == ["user", "assistant"]
    assert st["nodes"][0]["text"] == "你好"


def test_retry_without_pending_conflict(env):
    c, _, reg = env
    c.post("/treechat/api/sessions", json={"name": "r"})
    _reopen_with(reg, "r", FakeChatClient())
    assert c.post("/treechat/api/sessions/r/retry").status_code == 409
