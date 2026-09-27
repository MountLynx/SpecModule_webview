# tests/treechat/test_agent_bridge.py
"""agent 循环：脚本化 chat() 假客户端——终止/工具分派/错误喂回/迭代上限/usage。

async 测试沿用本仓库既有模式（tests/treechat/test_session.py / test_tools.py）：
普通 def + asyncio.run 包裹（pyproject 无 pytest-asyncio 配置，不引入新插件依赖）。
user_seq 取 conv.unanswered()——store seq 从 1 起（meta=1, user=2），fixture 追加的
悬而未答轮即最新未答节点。
"""

from __future__ import annotations

import asyncio

import pytest
from llm import LLMError, LLMResponse, Message

from treechat import agent_bridge
from treechat.core.conversation import Conversation
from treechat.tools.base import ToolContext, ToolDef


@pytest.fixture()
def conv(tmp_path):
    c = Conversation.create(tmp_path / "c1.jsonl", "c1", system="运营纪律")
    c.append_user("帮我看看模块")
    return c


async def _echo(args, ctx):
    return {"echo": args.get("text")}


ECHO = ToolDef(name="echo", description="回声",
               parameters={"type": "object",
                           "properties": {"text": {"type": "string"}},
                           "required": ["text"]},
               handler=_echo)


class ScriptClient:
    """chat() 按脚本弹出 LLMResponse（Exception 元素 = 抛出）；记录调用消息副本。"""

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls: list[list[Message]] = []

    async def chat(self, messages, tools=None):
        self.calls.append(list(messages))
        r = self.responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


def _call(resp: LLMResponse, name: str, args: dict) -> LLMResponse:
    resp.tool_calls = [{"id": "t1", "name": name, "arguments": args}]
    return resp


def _call_many(resp: LLMResponse, calls: list[tuple[str, str, dict]]) -> LLMResponse:
    """多 tool_calls 单响应：calls = [(id, name, args), ...]。"""
    resp.tool_calls = [{"id": i, "name": n, "arguments": a} for i, n, a in calls]
    return resp


class SpyStrategy:
    """window 消费观测：fit 被调用即置位，并在 system 注入标记验证结果被采用。"""

    def __init__(self):
        self.fitted = False

    def fit(self, system, history):
        self.fitted = True
        return system + "〔已裁剪〕", history, None


async def _run_status_ok(args, ctx):
    """run_status 成功形状：恒含 "error": None 键（镜像 data_tools._run_status）。"""
    return {"module_id": "mini", "phase": "running", "status": "running",
            "tick": 3, "fireable": [], "fired": [], "outputs": {},
            "node_states": {}, "error": None, "updated_at": 2.0}


async def _run_status_err(args, ctx):
    return {"error": "boom"}    # 真错误：handler 直接返回 error dict（不抛）


RUN_STATUS = ToolDef(name="run_status", description="状态",
                     parameters={"type": "object", "properties": {}},
                     handler=_run_status_ok)
RUN_ERR = ToolDef(name="run_status", description="状态(错误)",
                  parameters={"type": "object", "properties": {}},
                  handler=_run_status_err)


def test_plain_reply_no_tools(conv):
    client = ScriptClient([LLMResponse(content="你好",
                                       usage={"input_tokens": 2, "output_tokens": 1})])
    outcome = asyncio.run(agent_bridge.run_agent_turn(
        conv, conv.unanswered(), client=client, window=None, tools=[ECHO]))
    assert outcome.message_text == "你好"
    assert outcome.usage == {"input_tokens": 2, "output_tokens": 1}
    assert outcome.done is False and outcome.documents == []


def test_system_and_history_assembled(conv):
    client = ScriptClient([LLMResponse(content="ok")])
    asyncio.run(agent_bridge.run_agent_turn(
        conv, conv.unanswered(), client=client, window=None, tools=[ECHO]))
    msgs = client.calls[0]
    assert msgs[0].role == "system" and "模块运营台" in msgs[0].content
    assert "运营纪律" in msgs[0].content           # 会话 system 注入
    assert msgs[-1].role == "user" and msgs[-1].content == "帮我看看模块"


def test_tool_call_loop_and_result_fed_back(conv):
    client = ScriptClient([
        _call(LLMResponse(content=""), "echo", {"text": "hi"}),
        LLMResponse(content="回声完成"),
    ])
    events: list[dict] = []
    outcome = asyncio.run(agent_bridge.run_agent_turn(
        conv, conv.unanswered(), client=client, window=None, tools=[ECHO],
        on_event=events.append))
    assert outcome.message_text == "回声完成"
    kinds = [e["event"] for e in events]
    assert kinds == ["tool_call", "tool_result"]
    assert events[0]["name"] == "echo" and events[0]["args"] == {"text": "hi"}
    assert events[1]["ok"] is True
    # 第二次调用的消息含 assistant(tool_calls) + tool 结果
    second = client.calls[1]
    assert second[-2].role == "assistant" and second[-2].tool_calls[0]["id"] == "t1"
    assert second[-1].role == "tool"
    assert '"echo"' in second[-1].content


def test_tool_context_client_backfilled(conv):
    """显式 tool_context（client=None）→ 会话客户端回填进 ctx。

    mount/default 装配的 ToolContext 都不带 client；能力工具（refine_spec）
    消费 ctx.client，不回填则生产即死。
    """
    received: list[ToolContext] = []

    async def spy(args, ctx):
        received.append(ctx)
        return {"ok": True}

    spy_tool = ToolDef(name="echo", description="", parameters={"type": "object"},
                       handler=spy)
    base = conv.store.path.parent
    ctx = ToolContext(base_dir=base, search=[])   # client 留 None
    client = ScriptClient([
        _call(LLMResponse(content=""), "echo", {}),
        LLMResponse(content="done"),
    ])
    asyncio.run(agent_bridge.run_agent_turn(
        conv, conv.unanswered(), client=client, window=None,
        tool_context=ctx, tools=[spy_tool]))
    assert received[0].client is client                # handler 收到的就是会话客户端
    assert received[0].base_dir == base                # 其余字段原样保留（replace 语义）


def test_tool_error_becomes_result_not_crash(conv):
    client = ScriptClient([
        _call(LLMResponse(content=""), "echo", {}),
        LLMResponse(content="已处理错误"),
    ])
    events: list[dict] = []

    async def boom(args, ctx):
        raise RuntimeError("炸了")

    tools = [ToolDef(name="echo", description="", parameters={"type": "object"},
                     handler=boom)]
    outcome = asyncio.run(agent_bridge.run_agent_turn(
        conv, conv.unanswered(), client=client, window=None, tools=tools,
        on_event=events.append))
    assert outcome.message_text == "已处理错误"
    assert events[1]["ok"] is False
    assert "炸了" in client.calls[1][-1].content


def test_unknown_tool_fed_back(conv):
    client = ScriptClient([
        _call(LLMResponse(content=""), "nope", {}),
        LLMResponse(content="没有这个工具"),
    ])
    events: list[dict] = []
    asyncio.run(agent_bridge.run_agent_turn(
        conv, conv.unanswered(), client=client, window=None, tools=[ECHO],
        on_event=events.append))
    assert events[1]["ok"] is False
    assert "未知工具" in client.calls[1][-1].content


def test_iteration_cap(conv):
    responses = [_call(LLMResponse(content=""), "echo", {"text": "x"})
                 for _ in range(agent_bridge.MAX_ITERATIONS)]
    client = ScriptClient(responses)
    outcome = asyncio.run(agent_bridge.run_agent_turn(
        conv, conv.unanswered(), client=client, window=None, tools=[ECHO]))
    assert "上限" in outcome.message_text
    assert len(client.calls) == agent_bridge.MAX_ITERATIONS


def test_llm_error_propagates(conv):
    client = ScriptClient([LLMError("模拟基础设施故障")])
    with pytest.raises(LLMError):
        asyncio.run(agent_bridge.run_agent_turn(
            conv, conv.unanswered(), client=client, window=None, tools=[ECHO]))


def test_usage_accumulates(conv):
    client = ScriptClient([
        _call(LLMResponse(content="", usage={"input_tokens": 3, "output_tokens": 1}),
              "echo", {"text": "x"}),
        LLMResponse(content="done", usage={"input_tokens": 5, "output_tokens": 2}),
    ])
    outcome = asyncio.run(agent_bridge.run_agent_turn(
        conv, conv.unanswered(), client=client, window=None, tools=[ECHO]))
    assert outcome.usage == {"input_tokens": 8, "output_tokens": 3}


def test_run_status_error_none_key_is_success(conv):
    """run_status 成功载荷恒含 "error": None 键（镜像 HTTP 端点形状）——真值判定
    不误判失败。回归锁：按键存在判定曾致每次成功状态查询 ok=False / summary="None"。"""
    client = ScriptClient([
        _call(LLMResponse(content=""), "run_status", {"run_id": "r1"}),
        LLMResponse(content="它在跑"),
    ])
    events: list[dict] = []
    outcome = asyncio.run(agent_bridge.run_agent_turn(
        conv, conv.unanswered(), client=client, window=None, tools=[RUN_STATUS],
        on_event=events.append))
    assert outcome.message_text == "它在跑"
    assert events[1]["ok"] is True
    assert events[1]["summary"] == "phase=running tick=3"    # 不是 "None"
    # 真错误（{"error": "boom"}，handler 直接返回不抛）→ ok=False 如实转述
    client2 = ScriptClient([
        _call(LLMResponse(content=""), "run_status", {"run_id": "r2"}),
        LLMResponse(content="出错了"),
    ])
    events2: list[dict] = []
    asyncio.run(agent_bridge.run_agent_turn(
        conv, conv.unanswered(), client=client2, window=None, tools=[RUN_ERR],
        on_event=events2.append))
    assert events2[1]["ok"] is False
    assert events2[1]["summary"] == "boom"
    assert "boom" in client2.calls[1][-1].content


def test_multi_tool_calls_in_one_response(conv):
    """一次响应多 tool_calls：逐对 emit、两条 tool 消息按序回喂
    （Anthropic 聚合契约依赖连续 tool 消息形状）。"""

    async def up(args, ctx):
        return {"up": args.get("v")}

    async def down(args, ctx):
        return {"down": args.get("v")}

    tools = [ToolDef(name="up", description="", parameters={"type": "object"},
                     handler=up),
             ToolDef(name="down", description="", parameters={"type": "object"},
                     handler=down)]
    client = ScriptClient([
        _call_many(LLMResponse(content=""), [("a1", "up", {"v": "1"}),
                                             ("a2", "down", {"v": "2"})]),
        LLMResponse(content="都好了"),
    ])
    events: list[dict] = []
    outcome = asyncio.run(agent_bridge.run_agent_turn(
        conv, conv.unanswered(), client=client, window=None, tools=tools,
        on_event=events.append))
    assert outcome.message_text == "都好了"
    assert [e["event"] for e in events] == ["tool_call", "tool_result",
                                            "tool_call", "tool_result"]
    assert [e["id"] for e in events] == ["a1", "a1", "a2", "a2"]
    tool_msgs = [m for m in client.calls[1] if m.role == "tool"]
    assert [m.tool_call_id for m in tool_msgs] == ["a1", "a2"]
    assert '"up"' in tool_msgs[0].content and '"down"' in tool_msgs[1].content


def test_window_strategy_consumed(conv):
    """build_messages 经 run_agent_turn 消费 window 策略（fit 被调用且结果被采用）。"""
    spy = SpyStrategy()
    client = ScriptClient([LLMResponse(content="ok")])
    asyncio.run(agent_bridge.run_agent_turn(
        conv, conv.unanswered(), client=client, window=spy, tools=[ECHO]))
    assert spy.fitted
    assert "〔已裁剪〕" in client.calls[0][0].content


def test_summarize_result():
    assert agent_bridge.summarize_result("run_module", {"run_id": "m_abc"})
    assert "已发起" in agent_bridge.summarize_result("run_module", {"run_id": "m_abc"})
    assert "error 描述" in agent_bridge.summarize_result("x", {"error": "error 描述"})
