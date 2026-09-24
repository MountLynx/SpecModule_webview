"""卡片模型与注册表——全局卡（会话级、pin 注入）+ 节点卡（挂轮、沿路径取版本）。"""
from __future__ import annotations

from dataclasses import dataclass, field

from .errors import TreeChatError


def doc_card_id(doc_key: str, seq: int) -> str:
    """节点文档卡确定性 ID：重放幂等、UI key 稳定、与 card_ 随机 ID 天然不冲突。"""
    return f"doc:{doc_key}@{seq}"


@dataclass
class Card:
    """上下文产出卡片。body 必须自包含（提炼 prompt 的硬约束）。

    owner_seq=None = 全局卡（pin 语义照旧）；owner_seq=seq = 节点卡（作用域由
    树位置决定，不支持 pin）。doc_key 非空 = 模块文档版本节点卡。
    """

    id: str
    title: str
    body: str
    from_path: list[int] = field(default_factory=list)
    instruction: str = ""
    created_at: str = ""
    owner_seq: int | None = None
    doc_key: str = ""

    @property
    def is_node(self) -> bool:
        return self.owner_seq is not None


class CardRegistry:
    """id → Card + pinned 状态。card_create 事件默认 pinned（全局卡；节点卡恒不 pin）。"""

    def __init__(self) -> None:
        self._cards: dict[str, Card] = {}
        self._pinned: set[str] = set()

    def add(self, card: Card, *, pinned: bool = True) -> None:
        if card.id in self._cards:
            raise TreeChatError(f"卡片 id 重复: {card.id}")
        self._cards[card.id] = card
        if pinned and not card.is_node:
            self._pinned.add(card.id)

    def pin(self, card_id: str) -> None:
        card = self._require(card_id)
        if card.is_node:
            raise TreeChatError(f"节点卡不支持 pin: {card_id}（作用域由树位置决定）")
        self._pinned.add(card_id)

    def unpin(self, card_id: str) -> None:
        card = self._require(card_id)
        if card.is_node:
            raise TreeChatError(f"节点卡不支持 unpin: {card_id}（与 pin 对称——节点卡恒不 pin）")
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
