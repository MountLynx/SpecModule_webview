"""卡片模型与注册表。"""
from __future__ import annotations

from dataclasses import dataclass, field

from .errors import TreeChatError


@dataclass
class Card:
    """上下文产出卡片。body 必须自包含（提炼 prompt 的硬约束）。"""

    id: str
    title: str
    body: str
    from_path: list[int] = field(default_factory=list)
    instruction: str = ""
    created_at: str = ""


class CardRegistry:
    """id → Card + pinned 状态。card_create 事件默认 pinned（spec §3.3）。"""

    def __init__(self) -> None:
        self._cards: dict[str, Card] = {}
        self._pinned: set[str] = set()

    def add(self, card: Card, *, pinned: bool = True) -> None:
        if card.id in self._cards:
            raise TreeChatError(f"卡片 id 重复: {card.id}")
        self._cards[card.id] = card
        if pinned:
            self._pinned.add(card.id)

    def pin(self, card_id: str) -> None:
        self._require(card_id)
        self._pinned.add(card_id)

    def unpin(self, card_id: str) -> None:
        self._require(card_id)
        self._pinned.discard(card_id)

    def update(self, card_id: str, title: str, body: str) -> None:
        """整体替换标题与正文（card_edit 重放语义）。"""
        card = self.get(card_id)
        card.title, card.body = title, body

    def remove(self, card_id: str) -> Card:
        """删除卡片并移除 pin 状态（card_delete 重放语义）。返回被删卡片。"""
        card = self._require(card_id)
        self._pinned.discard(card_id)
        return self._cards.pop(card_id)

    def get(self, card_id: str) -> Card:
        self._require(card_id)
        return self._cards[card_id]

    def pinned_cards(self) -> list[Card]:
        return [c for cid, c in self._cards.items() if cid in self._pinned]

    def is_pinned(self, card_id: str) -> bool:
        return card_id in self._pinned

    def all_cards(self) -> list[Card]:
        return list(self._cards.values())

    def ids(self) -> set[str]:
        return set(self._cards)

    def _require(self, card_id: str) -> Card:
        if card_id not in self._cards:
            raise TreeChatError(f"未知卡片: {card_id}")
        return self._cards[card_id]
