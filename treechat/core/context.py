"""上下文组装 —— system(会话指令+pinned 卡片) + history/current 分离 + V1 窗口策略。

V1 窗口：超预算丢最旧 history 并在 system 末尾注入显式警示（不静默）；
system 与卡片整块保留。V2 将升级为"摘要卡片 + compact 事件"（spec §4.1）。
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable, Protocol

from .cards import Card
from .conversation import MsgNode
from .errors import TreeChatError

_CHARS_PER_TOKEN = 4

# CJK 统一表意文字/扩展A/兼容、注音与假名、谚文、CJK 标点、全角形式——
# 这些区间在主流 tokenizer 约 1 字 1 token，不适用英文 4 chars/token 经验值。
_CJK_RE = re.compile(
    "[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff"
    "\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]"
)


def estimate_tokens(text: str) -> int:
    """V1 估算：CJK 字符按 ~1 token/字计，其余 chars/4（spec §10）。

    4 chars/token 对中文低估 2.5~4 倍——中文优先的会话里窗口会在真实
    超限之后才裁剪，等于不设防。CJK 按 1 字 1 token 保守高估，宁可早裁；
    provider usage 精确校准留作后续（issue #13）。
    """
    cjk = len(_CJK_RE.findall(text))
    return max(1, cjk + (len(text) - cjk) // _CHARS_PER_TOKEN)


def card_block(card: Card) -> str:
    return f"[参考卡片 {card.id}: {card.title}]\n{card.body}"


def build_system(system: str, cards: list[Card]) -> str:
    parts = [p for p in [system, *[card_block(c) for c in cards]] if p]
    return "\n\n".join(parts)


def _merge_consecutive(history: list[dict[str, str]]) -> list[dict[str, str]]:
    """合并连续同角色消息（失败重试的兄弟 user 节点 / user 下挂 user 的分支），
    保证 LLM API 的角色交替要求。"""
    merged: list[dict[str, str]] = []
    for msg in history:
        if merged and merged[-1]["role"] == msg["role"]:
            merged[-1]["content"] += "\n\n" + msg["content"]
        else:
            merged.append(dict(msg))
    return merged


class WindowStrategy(Protocol):
    """窗口策略协议：返回 (最终 system, 装填后 history, 警示或 None)。"""

    def fit(self, system: str, history: list[dict[str, str]]) -> tuple[
        str, list[dict[str, str]], str | None,
    ]: ...


@dataclass
class TokenWindowStrategy:
    """V1 默认策略：system+卡片整块保留，history 从最新往回装填，丢最旧。

    首条 history 消息不豁免预算检查——system 独占超预算时 history 为空，
    警示照常注入（裁剪必显式告知，不静默塞入超预算内容）。
    """

    budget_tokens: int = 100_000
    estimator: Callable[[str], int] = estimate_tokens

    def fit(self, system: str, history: list[dict[str, str]]):
        used = self.estimator(system)
        kept: list[dict[str, str]] = []
        for msg in reversed(history):
            cost = self.estimator(msg["content"])
            if used + cost > self.budget_tokens:
                break
            kept.append(msg)
            used += cost
        kept.reverse()
        dropped = len(history) - len(kept)
        warning = None
        if dropped:
            warning = f"（更早 {dropped} 条消息因窗口预算未纳入上下文）"
            system = system + ("\n\n" if system else "") + warning
        return system, kept, warning


@dataclass
class AssembledContext:
    system: str
    history: list[dict[str, str]]  # [{"role": ..., "content": ...}]，llm_bridge 转 Message
    current: str


def assemble(path: list[MsgNode], system: str, cards: list[Card],
             strategy: WindowStrategy | None = None) -> AssembledContext:
    """path = path_to(本条轮次)；末轮 input 即 current（叶子分支 path 长度 1 → history 空）。

    中间轮按 user/assistant 两条消息展开；output 为空的悬而未答轮只贡献 user 侧。
    """
    if not path or path[-1].output is not None:
        raise TreeChatError("assemble 需以未答轮次结尾的路径")
    history: list[dict[str, str]] = []
    for n in path[:-1]:
        history.append({"role": "user", "content": n.input})
        if n.output is not None:
            history.append({"role": "assistant", "content": n.output})
    history = _merge_consecutive(history)
    sys_text = build_system(system, cards)
    if strategy is not None:
        sys_text, history, _ = strategy.fit(sys_text, history)
    return AssembledContext(system=sys_text, history=history, current=path[-1].input)
