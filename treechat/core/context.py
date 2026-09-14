"""上下文组装 —— system(会话指令+pinned 卡片) + history/current 分离 + V1 窗口策略。

V1 窗口：超预算丢最旧 history 并在 system 末尾注入显式警示（不静默）；
system 与卡片整块保留。V2 将升级为"摘要卡片 + compact 事件"（spec §4.1）。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Protocol

from .cards import Card
from .conversation import MsgNode
from .errors import TreeChatError

_CHARS_PER_TOKEN = 4


def estimate_tokens(text: str) -> int:
    """V1 估算：chars/4（后续可换 provider usage 精确计费，见 spec §10）。"""
    return max(1, len(text) // _CHARS_PER_TOKEN)


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
    """V1 默认策略：system+卡片整块保留，history 从最新往回装填，丢最旧。"""

    budget_tokens: int = 100_000
    estimator: Callable[[str], int] = estimate_tokens

    def fit(self, system: str, history: list[dict[str, str]]):
        used = self.estimator(system)
        kept: list[dict[str, str]] = []
        for msg in reversed(history):
            cost = self.estimator(msg["content"])
            if kept and used + cost > self.budget_tokens:
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
    """path = path_to(本条 user 节点)；末条即 current（叶子分支 path 长度 1 → history 空）。"""
    if not path or path[-1].role != "user":
        raise TreeChatError("assemble 需要以 user 节点结尾的路径")
    history = [{"role": n.role, "content": n.text} for n in path[:-1]]
    history = _merge_consecutive(history)
    sys_text = build_system(system, cards)
    if strategy is not None:
        sys_text, history, _ = strategy.fit(sys_text, history)
    return AssembledContext(system=sys_text, history=history, current=path[-1].text)
