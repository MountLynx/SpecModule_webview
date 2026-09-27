"""agent_bridge —— ops 模式的回合执行体：纯 Python 工具调用循环（spec D2）。

不走 harness：harness body 只会调单轮 complete()，而循环的本质是累积 messages
（含 tool 角色）喂回模型（llm 包 chat() 多轮接口）。统一性保留在 chat 层契约：
分派/锁/持久化/SSE 词汇/LLMError 语义与 harness 模式一致。
"""
from __future__ import annotations

import json
from dataclasses import replace
from typing import Any

from llm import Message

from .core.context import assemble
from .module_bridge import OnEvent, TurnOutcome, _merge_usage
from .tools.base import ToolContext, ToolDef, all_tools, default_tool_context, dispatch_tool, tool_schemas

MAX_ITERATIONS = 12
"""单回合工具迭代上限（触顶收束，防模型空转烧 token）。"""

AGENT_SYSTEM = """\
你是 SpecModule 模块运营台：通过工具查看模块库、完善 spec、发起与监控运行、控制运行。
纪律：
- 运行状态永远通过工具新鲜获取，绝不编造 run 的 phase/tick/输出；
- run_module 立即返回 run_id（运行在后台子进程进行，不等待完成）；终文必须包含 run_id；
- 工具返回 {"error": ...} 时如实向用户转述，同一操作不要重试超过一次；
- 回答保持简洁中文；一次只做用户要求的事，不额外发起运行。
"""


def build_messages(conv, user_seq: int, window) -> list[Message]:
    """assemble 复用（pinned 卡注入 system，与 module_bridge.build_spec 同源）。

    window=None = 不裁剪（测试用；生产经 session 缺省 TokenWindowStrategy）。
    """
    pinned = [c for c in conv.cards.pinned_cards()
              if c.owner_seq is None and not c.id.startswith("spec:")]
    ctx = assemble(conv.path_to(user_seq), conv.system, pinned, strategy=window)
    messages: list[Message] = []
    system = AGENT_SYSTEM + ("\n\n" + ctx.system if ctx.system else "")
    messages.append(Message(role="system", content=system))
    for m in ctx.history:
        messages.append(Message(role=m["role"], content=m["content"]))
    messages.append(Message(role="user", content=ctx.current))
    return messages


def summarize_result(name: str, result: Any) -> str:
    """tool_result 帧的渲染摘要（全量载荷不回传前端）。"""
    if isinstance(result, dict) and result.get("error"):   # 真值判定：run_status 成功载荷恒含 "error": None 键
        return str(result["error"])[:200]
    if name == "list_modules":
        return f"{len(result.get('modules', []))} 个模块"
    if name == "module_detail":
        return f"模块 {result.get('name', '?')}"
    if name == "run_module":
        return f"run {result.get('run_id')} 已发起"
    if name == "run_status":
        return f"phase={result.get('phase', '?')} tick={result.get('tick', '?')}"
    if name == "run_snapshot":
        return f"tick={result.get('tick', '?')} 快照"
    if name == "run_timeline":
        return f"{len(result.get('entries', []))} 条时间线"
    if name == "run_control":
        action = (result.get("control") or {}).get("action")
        return f"控制请求 {action or ''} 已写入"
    if name == "refine_spec":
        return f"spec 已完善（{len(result.get('spec', {}))} 字段）"
    return json.dumps(result, ensure_ascii=False)[:200]


async def run_agent_turn(conv, user_seq: int, *, client: Any, window,
                         tool_context: ToolContext | None = None,
                         tools: list[ToolDef] | None = None,
                         on_event: OnEvent | None = None) -> TurnOutcome:
    """一次 ops 回合 = 工具调用循环。LLMError 上抛（悬而未答轮，retry 契约同
    harness 模式）；工具失败永远喂回模型（model-recoverable），不炸回合。

    ctx.client 为 None 时回填会话客户端（能力工具如 refine_spec 消费）——
    mount/default 两条装配路径的 ToolContext 都不带 client，统一在此补齐。
    """
    emit = on_event or (lambda evt: None)
    ctx = tool_context or default_tool_context()
    if ctx.client is None:
        ctx = replace(ctx, client=client)   # 能力工具复用会话客户端（mounted/standalone 两路同覆盖）
    tool_list = tools if tools is not None else all_tools()
    schemas = tool_schemas(tool_list)
    messages = build_messages(conv, user_seq, window)
    usage_total: dict[str, int] = {}

    for _ in range(MAX_ITERATIONS):
        resp = await client.chat(messages, tools=schemas)
        _merge_usage(usage_total, resp.usage)
        if not resp.tool_calls:
            return TurnOutcome(message_text=resp.content, usage=usage_total)
        messages.append(Message(role="assistant", content=resp.content,
                                tool_calls=resp.tool_calls))
        for tc in resp.tool_calls:   # 顺序执行（v1；会话锁本就串行化回合）
            name = str(tc.get("name", ""))
            args = tc.get("arguments") or {}
            emit({"event": "tool_call", "id": tc["id"], "name": name, "args": args})
            result = await dispatch_tool(tool_list, name, args, ctx)
            run_id = result.get("run_id") if isinstance(result, dict) else None
            emit({"event": "tool_result", "id": tc["id"], "name": name,
                  "ok": not (isinstance(result, dict) and result.get("error")),
                  "summary": summarize_result(name, result),
                  "runId": run_id if isinstance(run_id, str) else None})
            messages.append(Message(role="tool", tool_call_id=tc["id"],
                                    content=json.dumps(result, ensure_ascii=False)))
    # 边角：末轮工具已执行、结果不再回喂模型（结果已经 tool_result 帧直达前端）
    return TurnOutcome(
        message_text=(f"已达单轮工具调用上限（{MAX_ITERATIONS}）。"
                      "请拆分操作，或开新轮继续。"),
        usage=usage_total)
