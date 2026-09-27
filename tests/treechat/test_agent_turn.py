"""ops 回合（agent 循环）SSE 集成：脚本化 chat() 假客户端 → 帧序列断言。

隔离：四个用例统一走 conftest 的 base fixture（SPECMODULE_BASE/PATH/HOME 隔离）——
list_modules/run_status 工具真实执行，base_dir 锚定 tmp_path 不扫真实环境；
tool_context 经 _make_client 显式注入（ToolContext + server.deps.get_search_paths，
与 mount_chat 同款装配）——集成测试走注入路径而非环境变量回落。
"""
from __future__ import annotations

import json

from fastapi.testclient import TestClient
from llm import LLMError, LLMResponse

from server.deps import get_search_paths
from treechat.config import TreeChatConfig
from treechat.tools import ToolContext
from treechat.webapp.app import create_app


class FakeAgentClient:
    """chat() 脚本化假客户端（Exception 元素 = 抛出）；complete 供健康探测。"""

    def __init__(self, responses) -> None:
        self.responses = list(responses)
        self.calls: list[list] = []
        self.config = type("Config", (), {"model": "fake-model"})()

    async def complete(self, **kwargs):
        return LLMResponse(content="ok")

    async def chat(self, messages, tools=None):
        self.calls.append(list(messages))
        r = self.responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


def _frames(client: TestClient, url: str, **kw) -> list[tuple[str, dict | None]]:
    events: list[tuple[str, dict | None]] = []
    event = data_raw = ""
    with client.stream("POST", url, **kw) as resp:
        assert resp.status_code == 200
        for line in resp.iter_lines():
            if line.startswith("event: "):
                event = line[7:]
            elif line.startswith("data: "):
                data_raw += line[6:]
            elif line == "" and event:
                events.append((event, json.loads(data_raw) if data_raw else None))
                event = data_raw = ""
    return events


def _by_event(frames):
    out: dict[str, list] = {}
    for e, d in frames:
        out.setdefault(e, []).append(d)
    return out


def _make_client(base, responses):
    fake = FakeAgentClient(responses)
    config = TreeChatConfig(data_dir=base)
    tool_context = ToolContext(base_dir=base, search=get_search_paths(base))
    client = TestClient(create_app(config, client_factory=lambda model=None: fake,
                                   tool_context=tool_context))
    client.fake = fake  # type: ignore[attr-defined]
    return client


def test_ops_turn_frame_sequence(base):
    client = _make_client(base, [
        LLMResponse(content="", tool_calls=[
            {"id": "t1", "name": "list_modules", "arguments": {}}],
            usage={"input_tokens": 3, "output_tokens": 1}),
        LLMResponse(content="模块清单已列出。", usage={"input_tokens": 5, "output_tokens": 2}),
    ])
    client.post("/api/sessions", json={"name": "s1", "category": "ops"})
    frames = _frames(client, "/api/sessions/s1/turn", json={"text": "看看有什么模块"})
    by = _by_event(frames)
    assert frames[0][0] == "start"
    assert by["start"][0]["module"] == "ops"
    assert by["start"][0]["nodes"] == [{"key": "ops", "label": "助手"}]
    assert by["tool_call"][0] == {"id": "t1", "name": "list_modules", "args": {}}
    assert by["tool_result"][0]["ok"] is True
    assert by["tool_result"][0]["summary"].endswith("个模块")
    assert "done" in by
    done = by["done"][0]
    assert done["done"] is False                       # ops 轮不触发自动退出 category
    nodes = done["state"]["nodes"]
    assert any(n["output"] == "模块清单已列出。" for n in nodes)
    state = done["state"]
    assert state["category"] == "ops"
    # 第二次 chat 的消息含 tool 角色（结果喂回）
    second = client.fake.calls[1]
    assert any(m.role == "tool" and m.tool_call_id == "t1" for m in second)


def test_per_turn_module_override(base):
    """会话默认 direct，单轮 module="ops" 也能分派 agent 循环。"""
    client = _make_client(base, [LLMResponse(content="ops 回复")])
    client.post("/api/sessions", json={"name": "s1"})
    frames = _frames(client, "/api/sessions/s1/turn",
                     json={"text": "hi", "module": "ops"})
    assert _by_event(frames)["start"][0]["module"] == "ops"


def test_tool_error_fed_back(base):
    client = _make_client(base, [
        LLMResponse(content="", tool_calls=[
            {"id": "t1", "name": "run_status", "arguments": {"run_id": "ghost"}}]),
        LLMResponse(content="查无此 run。"),
    ])
    client.post("/api/sessions", json={"name": "s1", "category": "ops"})
    frames = _frames(client, "/api/sessions/s1/turn", json={"text": "查 ghost"})
    by = _by_event(frames)
    assert by["tool_result"][0]["ok"] is False
    tool_msg = next(m for m in client.fake.calls[1] if m.role == "tool")
    assert "error" in tool_msg.content


def test_llm_error_leaves_unanswered(base):
    client = _make_client(base, [LLMError("模拟基础设施故障")])
    client.post("/api/sessions", json={"name": "s1", "category": "ops"})
    frames = _frames(client, "/api/sessions/s1/turn", json={"text": "hi"})
    by = _by_event(frames)
    assert "error" in by
    assert by["error"][0]["state"]["unanswered"] is not None   # 悬而未答可 retry


def test_ops_turn_unconfigured_client(base):
    """client_factory 抛错 → 替身客户端：ops 回合 chat() 干净降级为 error 帧。"""
    def broken_factory(model=None):
        raise RuntimeError("配置链不可用")

    client = TestClient(create_app(TreeChatConfig(data_dir=base),
                                   client_factory=broken_factory))
    client.post("/api/sessions", json={"name": "s1", "category": "ops"})
    frames = _frames(client, "/api/sessions/s1/turn", json={"text": "hi"})
    by = _by_event(frames)
    assert "error" in by
    assert "LLM 未配置" in by["error"][0]["error"]   # 非 AttributeError 内部错误
