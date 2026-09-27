# tests/test_chat_mount.py
"""TreeChat 挂载测试：/treechat/api/* 经 server.chat.mount_chat 引入的行为契约。

隔离：不依赖全局 app——mount_chat 注入 tmp base_dir，会话文件落在
tmp/.treechat/sessions；LLM 客户端替换走子应用 registry（app.state.chat_registry，
对齐 treechat 自家 conftest 的假客户端模式）。对话引擎已收编为本仓库顶级包，
测试常开（原 importorskip 随可缺席降级一并退役）。

三期（chat as modules）：回合契约升级为 SSE 流式（start 预告 → 逐 token/节点进度 →
done/error 终帧；REST 非流式退役），LLM 失败经 SSE error 帧回传。
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from llm import LLMError, LLMResponse

from server.chat import mount_chat


class FakeChatClient:
    """带 complete() 的假客户端：固定回复 / 可选失败（对齐 treechat conftest）。

    module 回合路径走 complete(on_token=...)——on_token 真实回调（三等分发射），
    驱动 SSE token 事件。
    """

    def __init__(self, reply: str = "mock reply", fail: bool = False) -> None:
        self.reply, self.fail = reply, fail
        self.config = type("Config", (), {"model": "fake-model"})()

    async def complete(self, **kwargs):
        if self.fail:
            raise LLMError("模拟基础设施故障")
        on_token = kwargs.get("on_token")
        if on_token:
            step = max(1, len(self.reply) // 3)
            for i in range(0, len(self.reply), step):
                on_token(self.reply[i:i + step])
        return LLMResponse(content=self.reply,
                           usage={"input_tokens": 1, "output_tokens": 2})


@pytest.fixture
def env(tmp_path):
    """隔离挂载的三元组：(TestClient, base_dir, 子应用 registry)。

    with 形式：整个测试期共享同一 portal/事件循环（lifespan 启动），
    registry 的 asyncio.Lock 跨请求存续才有真实锁语义（SSE 回合流必需）。
    """
    app = FastAPI()
    assert mount_chat(app, base_dir=tmp_path) is True
    with TestClient(app) as c:
        yield c, tmp_path, app.state.chat_registry


def sse_events(client, url, **kwargs):
    """POST 流式端点 → [(event, data)]（帧解析，对齐 treechat test_webapp）。"""
    events = []
    with client.stream("POST", url, **kwargs) as resp:
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        event = None
        for line in resp.iter_lines():
            if line.startswith("event: "):
                event = line[len("event: "):]
            elif line.startswith("data: ") and event is not None:
                events.append((event, json.loads(line[len("data: "):])))
                event = None
    return events


# ── 健康 / 挂载 ──

def test_health_reports_workspace_data_dir(env):
    c, base, _ = env
    r = c.get("/treechat/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert "llmConfigured" in body
    assert Path(body["dataDir"]) == base / ".treechat"


def test_treechat_data_dir_env_override(tmp_path, monkeypatch):
    override = tmp_path / "custom chats"
    monkeypatch.setenv("TREECHAT_DATA_DIR", str(override))
    app = FastAPI()
    assert mount_chat(app, base_dir=tmp_path) is True
    r = TestClient(app).get("/treechat/api/health")
    assert r.status_code == 200
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
    events = sse_events(c, "/treechat/api/sessions/t/turn", json={"text": "你好"})
    kinds = [e for e, _ in events]
    # SSE 序列：start 预告 → 节点事件（含逐 token）→ done 终帧
    assert kinds[0] == "start"
    assert "node_start" in kinds and "token" in kinds
    assert kinds[-1] == "done"
    st = events[-1][1]["state"]
    # 节点 = 轮次（一问一答）：单轮 input/output 同体
    assert [n["input"] for n in st["nodes"]] == ["你好"]
    assert st["nodes"][-1]["output"] == "这是回复"
    assert st["nodes"][-1]["model"] == "fake-model"
    # seq 计数含 meta 事件（首节点 seq=2），指针落在最新完成轮——不硬编码具体值
    assert st["pointer"] == st["nodes"][-1]["seq"]
    assert st["unanswered"] is None


def test_turn_llm_failure_contract(env):
    """LLM 失败 → SSE error 帧：轮已落盘（悬而未答，output 为空）。"""
    c, _, reg = env
    c.post("/treechat/api/sessions", json={"name": "f"})
    _reopen_with(reg, "f", FakeChatClient(fail=True))
    events = sse_events(c, "/treechat/api/sessions/f/turn", json={"text": "你好"})
    assert events[-1][0] == "error"
    assert "模拟基础设施故障" in events[-1][1]["error"]
    st = events[-1][1]["state"]
    assert st["nodes"][0]["output"] is None
    assert st["unanswered"] == st["nodes"][0]["seq"]
    # 重试换好客户端 → done 帧补 assistant，问题不丢不重复
    _reopen_with(reg, "f", FakeChatClient(reply="补上了"))
    events = sse_events(c, "/treechat/api/sessions/f/retry")
    assert events[-1][0] == "done"
    st = events[-1][1]["state"]
    assert st["nodes"][0]["output"] == "补上了"
    assert st["nodes"][0]["input"] == "你好"


def test_modes_endpoint_and_categorized_session(env):
    """模式枚举透传（BUILT_IN：direct/grilling/ops——grilling 已吸收 domain-modeling）
    + 分类创建会话（三期模式入口的挂载级契约）。"""
    c, _, _ = env
    modes = c.get("/treechat/api/modes").json()
    assert [m["key"] for m in modes] == ["direct", "grilling", "ops"]
    assert modes[0]["displayName"] == "直答"
    assert modes[1]["displayName"] == "拷问"
    assert modes[2]["displayName"] == "模块运营"
    assert modes[1]["description"] and modes[2]["description"]
    r = c.post("/treechat/api/sessions", json={"name": "g", "category": "grilling"})
    assert r.status_code == 200 and r.json()["category"] == "grilling"
    assert c.get("/treechat/api/sessions/g").json()["category"] == "grilling"


def test_retry_without_pending_conflict(env):
    c, _, reg = env
    c.post("/treechat/api/sessions", json={"name": "r"})
    _reopen_with(reg, "r", FakeChatClient())
    assert c.post("/treechat/api/sessions/r/retry").status_code == 409
