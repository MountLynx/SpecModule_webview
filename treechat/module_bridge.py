"""module_bridge —— treechat 唯一直接触碰 module_harness Module/图面的地方（spec §2）。

llm_bridge 保留 client 创建与卡片提炼（call_harness）；本模块负责对话回合的
模块执行：组装 spec → 直构 ephemeral Module → 订阅事件 → 取回归一化输出。
测试替换点：带 complete() 的假客户端（tests/conftest.py 的 FakeModuleClient）。
"""
from __future__ import annotations

from dataclasses import dataclass, field as dc_field
from typing import Any, Callable

from llm import LLMError
from module_harness import EventBus, Module, Tasklist
from module_harness.infra.events import (
    HarnessFailed, LlmCallCompleted, LlmCallStarted, LlmToken, LlmThinking,
    OutputValidated,
)
from tickflow import Failure

from .core.context import assemble
from .core.errors import TreeChatError
from .modules.base import ConversationalModule, FieldStreamShaper

OnEvent = Callable[[dict], None]
"""SSE 事件回调：dict 必带 "event" 键，其余为载荷（webapp 直接转 SSE 帧）。"""


@dataclass
class TurnOutcome:
    """一次模块回合的结果（spec §2 取回）。"""

    message_text: str
    usage: dict[str, int] = dc_field(default_factory=dict)
    done: bool = False
    documents: list[tuple[str, str, str]] = dc_field(default_factory=list)
    """[(card_id, title, body)] —— session 落盘为固定 ID 的 pinned 卡片。"""


def build_spec(module: ConversationalModule, conv, user_seq: int, window) -> dict[str, Any]:
    """组装 spec：brief 原话 + history 裁剪转录 + 文档字段（spec 卡片正文）。

    TokenWindowStrategy 的裁剪职责在此接管（窗口选择沿用现策略，出口为转录）；
    spec:* 卡片不进转录（文档经模块自己的 spec 字段进 prompt，防双份注入）。
    """
    pinned = [c for c in conv.cards.pinned_cards() if not c.id.startswith("spec:")]
    ctx = assemble(conv.path_to(user_seq), conv.system, pinned, strategy=window)
    lines: list[str] = []
    if ctx.system:
        lines.append("## 系统设定\n" + ctx.system)
    for m in ctx.history:
        lines.append(f"[{m['role']}] {m['content']}")
    spec: dict[str, Any] = {"brief": ctx.current, "history": "\n\n".join(lines)}
    for doc in module.documents:
        try:
            spec[doc.field] = conv.cards.get(doc.card_id).body
        except TreeChatError:
            spec[doc.field] = ""
    return spec


def _merge_usage(total: dict[str, int], usage: dict | None) -> None:
    for k, v in (usage or {}).items():
        total[k] = total.get(k, 0) + (v or 0)


async def run_turn(module: ConversationalModule, conv, user_seq: int, *,
                   client: Any, window, on_event: OnEvent) -> TurnOutcome:
    """执行一次对话回合 = 一次 ephemeral module run（spec §2/§6）。

    失败（LLM 错误 / 节点 Failure）翻译为 LLMError 上抛——调用方保证此时
    user 节点已落盘（悬而未答，可 retry）。
    """
    spec = build_spec(module, conv, user_seq, window)
    bus = EventBus()
    reg = module.build_registry(client, bus)
    m = Module(
        spec=spec, tasklist=Tasklist.from_json(module.tasklist),
        llm_client=client, event_bus=bus, registry=reg,
        review_harness=None,            # 固定流程，发布前已验证（spec §3）
        persist=False, status_file=False, control=False, stream_log=False,
        module_id=f"turn_{conv.name}_{user_seq}",
    )

    shapers: dict[str, FieldStreamShaper | None] = {}
    # None = 节点未声明 display_fields，token 原样透传（设计性 passthrough）
    failures: list[str] = []
    usage_total: dict[str, int] = {}
    doc_titles = {d.card_id: d.title for d in module.documents}

    def on_started(e) -> None:
        shapers[e.node] = module.shaper(e.node)
        on_event({"event": "node_start", "key": e.node,
                  "label": module.node_label(e.node)})

    def on_token(e) -> None:
        shaper = shapers.get(e.node)
        text = shaper.feed(e.chunk) if shaper is not None else e.chunk
        if text:
            on_event({"event": "token", "key": e.node, "text": text})

    def on_thinking(e) -> None:
        # 思考是原始文本非 JSON 字段——不经 FieldStreamShaper 直接透传
        on_event({"event": "thinking", "key": e.node, "text": e.chunk})

    def on_completed(e) -> None:
        _merge_usage(usage_total, e.usage)
        refs = [{"type": "card", "cardId": cid, "title": doc_titles.get(cid, cid)}
                for cid in module.node_docs.get(e.node, [])]
        on_event({"event": "node_end", "key": e.node, "outcome": "ok", "refs": refs})

    def on_output_validated(e) -> None:
        # LlmCallCompleted 在 harness 格式校验之前发射——校验失败节点已收到
        # ok 帧，此处补发 failed 帧（前端按 key 覆盖 outcome，后者胜）。
        # 与 HarnessFailed 互斥：infra 错误在校验前 return，不发本事件。
        if not e.passed:
            on_event({"event": "node_end", "key": e.node,
                      "outcome": "failed", "refs": []})

    def on_failed(e) -> None:
        failures.append(e.reason)
        on_event({"event": "node_end", "key": e.node, "outcome": "failed", "refs": []})

    bus.subscribe(LlmCallStarted, on_started)
    bus.subscribe(LlmToken, on_token)
    bus.subscribe(LlmThinking, on_thinking)
    bus.subscribe(LlmCallCompleted, on_completed)
    bus.subscribe(OutputValidated, on_output_validated)
    bus.subscribe(HarnessFailed, on_failed)

    # max_ticks=10：内置模块最长链 4 tick，10 充裕；未来超长链模块需参数化
    # 并检测截断（run_until_idle 达上限不报错，截断静默）。
    firings = await m.run(max_ticks=10)
    for f in firings:
        if isinstance(f.output, Failure):
            failures.append(str(f.output.error))
    if failures or not firings:
        raise LLMError(failures[-1] if failures else "模块无输出")

    if module.shape == "text":
        return TurnOutcome(message_text=str(firings[-1].output), usage=usage_total)
    value = firings[-1].output
    if not isinstance(value, dict):
        raise LLMError(f"模块输出不是 JSON 对象: {value!r}")
    documents = [(d.card_id, d.title, str(value.get(d.field, "") or ""))
                 for d in module.documents if str(value.get(d.field, "") or "").strip()]
    message_text = (str(value.get(module.message_field, "") or "")
                    if module.message_field else "")
    return TurnOutcome(
        message_text=message_text,
        usage=usage_total, done=bool(value.get("done", False)),
        documents=documents,
    )
