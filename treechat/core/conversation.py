"""Conversation —— 会话：SessionStore + 重放派生视图。

指针不变量：指向最新完成轮次的 assistant 节点（或 None）；它是下一条
user_msg 的默认 parent。分支 = set_pointer(历史节点) 后继续输入；叶子 =
append_user(leaf=True) 强制 parent=None。指针推进只发生在 assistant 落盘时。
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from .cards import Card, CardRegistry
from .errors import TreeChatError
from .events import (
    AssistantMsg, CardCreate, CardDelete, CardEdit, NodeRename, Pin,
    SessionArchive, SessionCategory, SessionMeta, SessionRename, SystemUpdate,
    Unpin, UserMsg,
)
from .store import SessionStore


@dataclass
class MsgNode:
    """消息节点。id = seq（稳定可引用）。label = 用户命名（node_rename 事件派生）。"""

    seq: int
    parent: int | None
    role: str  # "user" | "assistant"
    text: str
    model: str = ""
    label: str = ""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _new_card_id(existing: set[str]) -> str:
    while True:
        cid = "card_" + uuid4().hex[:4]
        if cid not in existing:
            return cid


class Conversation:
    """一个会话：持久层 + 重放派生视图（节点表/子索引/指针/卡片注册表）。"""

    def __init__(self, store: SessionStore) -> None:
        self.store = store
        self.name = ""
        self.system = ""
        self.category = ""
        self.archived = False
        self.pointer: int | None = None
        self.nodes: dict[int, MsgNode] = {}
        self.children: dict[int | None, list[int]] = {}
        self.cards = CardRegistry()

    # ── 构造 ──

    @classmethod
    def create(cls, path: Path, name: str, system: str = "") -> "Conversation":
        conv = cls(SessionStore(path))
        conv.store.append(SessionMeta(name=name, created_at=_now(), system=system))
        conv._replay(conv.store.load())
        return conv

    @classmethod
    def open(cls, path: Path) -> "Conversation":
        conv = cls(SessionStore(path))
        events = conv.store.load()
        if not events:
            raise TreeChatError(f"会话文件为空: {path}")
        conv._replay(events)
        return conv

    def _replay(self, events: list[tuple[int, object]]) -> None:
        for seq, ev in events:
            self._apply(seq, ev)

    # ── 事件应用（追加与重放共用一份语义）──

    def _apply(self, seq: int, ev: object) -> None:
        match ev:
            case SessionMeta():
                self.name, self.system = ev.name, ev.system
            case SystemUpdate():
                self.system = ev.text
            case UserMsg():
                self._add_node(seq, ev.parent, "user", ev.text)
            case AssistantMsg():
                self._add_node(seq, ev.parent, "assistant", ev.text, model=ev.model)
                self.pointer = seq
            case CardCreate():
                self.cards.add(Card(
                    id=ev.card_id, title=ev.title, body=ev.body,
                    from_path=list(ev.from_path), instruction=ev.instruction,
                    created_at=ev.created_at,
                ))
            case Pin():
                self.cards.pin(ev.card_id)
            case Unpin():
                self.cards.unpin(ev.card_id)
            case CardEdit():
                self.cards.update(ev.card_id, ev.title, ev.body)
            case CardDelete():
                self.cards.remove(ev.card_id)
            case SessionRename():
                self.name = ev.name
            case SessionCategory():
                self.category = ev.category
            case SessionArchive():
                self.archived = ev.archived
            case NodeRename():
                if ev.node not in self.nodes:
                    raise TreeChatError(f"node_rename 目标不存在: seq={ev.node}")
                self.nodes[ev.node].label = ev.label
            case _:
                raise TreeChatError(f"不可重放的事件: {ev!r}")

    def _add_node(self, seq: int, parent: int | None, role: str, text: str,
                  model: str = "") -> None:
        if parent is not None and parent not in self.nodes:
            raise TreeChatError(f"parent 指向不存在的节点: seq={seq} parent={parent}")
        self.nodes[seq] = MsgNode(seq=seq, parent=parent, role=role, text=text, model=model)
        self.children.setdefault(parent, []).append(seq)

    # ── 追加（持久化即真相）──

    def append_user(self, text: str, *, leaf: bool = False) -> int:
        """追加 user_msg：默认 parent=指针；leaf=True 强制 parent=None。"""
        target = None if leaf else self.pointer
        ev = UserMsg(parent=target, text=text)
        seq = self.store.append(ev)
        self._apply(seq, ev)
        return seq

    def append_assistant(self, user_seq: int, text: str, *,
                         model: str = "", usage: dict[str, int] | None = None) -> int:
        """在 user 节点下追加 assistant 回复并推进指针。"""
        node = self.nodes.get(user_seq)
        if node is None or node.role != "user":
            raise TreeChatError(f"append_assistant 目标必须是 user 节点: {user_seq}")
        ev = AssistantMsg(parent=user_seq, text=text, model=model, usage=dict(usage or {}))
        seq = self.store.append(ev)
        self._apply(seq, ev)
        return seq

    def add_card(self, title: str, body: str, from_path: list[int],
                 instruction: str = "", card_id: str | None = None) -> str:
        """追加 card_create（默认 pinned），返回 card_id。

        card_id 显式指定时原样落盘（spec 卡片固定 ID，spec §5）；None 走 _new_card_id。
        """
        ev = CardCreate(
            card_id=card_id or _new_card_id(self.cards.ids()), title=title, body=body,
            from_path=list(from_path), instruction=instruction, created_at=_now(),
        )
        seq = self.store.append(ev)
        self._apply(seq, ev)
        return ev.card_id

    def pin(self, card_id: str) -> None:
        self.cards.get(card_id)  # 先验证再落盘：失败不落事件（否则重放必失败的毒事件会锁死文件）
        self._append_apply(Pin(card_id=card_id))

    def unpin(self, card_id: str) -> None:
        self.cards.get(card_id)
        self._append_apply(Unpin(card_id=card_id))

    def edit_card(self, card_id: str, title: str, body: str) -> None:
        """整体替换卡片标题与正文（未知卡片抛错，不落事件）。"""
        self.cards.get(card_id)
        self._append_apply(CardEdit(card_id=card_id, title=title, body=body))

    def delete_card(self, card_id: str) -> None:
        """删除卡片（含 pin 状态；未知卡片抛错，不落事件）。"""
        self.cards.get(card_id)
        self._append_apply(CardDelete(card_id=card_id))

    def update_system(self, text: str) -> None:
        self._append_apply(SystemUpdate(text=text))

    def rename(self, name: str) -> None:
        """会话改名（session_rename 事件；sid/文件名不变，只改显示名）。"""
        self._append_apply(SessionRename(name=name))

    def set_category(self, category: str) -> None:
        """设置分类（空串 = 未分类）。"""
        self._append_apply(SessionCategory(category=category))

    def set_archived(self, archived: bool) -> None:
        self._append_apply(SessionArchive(archived=archived))

    def rename_node(self, seq: int, label: str) -> None:
        """节点命名（空串 = 清除）。"""
        if seq not in self.nodes:
            raise TreeChatError(f"节点不存在: {seq}")
        self._append_apply(NodeRename(node=seq, label=label))

    def _append_apply(self, ev: object) -> None:
        seq = self.store.append(ev)
        self._apply(seq, ev)

    def set_pointer(self, seq: int | None) -> None:
        """把指针挪到任意历史节点（/branch、/trunk 用；纯内存操作，不落事件）。"""
        if seq is not None and seq not in self.nodes:
            raise TreeChatError(f"指针目标不存在: {seq}")
        self.pointer = seq

    # ── 视图 ──

    def path_to(self, seq: int) -> list[MsgNode]:
        """根到该节点的消息路径（即该分支的完整上下文）。"""
        if seq not in self.nodes:
            raise TreeChatError(f"节点不存在: {seq}")
        path = []
        cur: int | None = seq
        while cur is not None:
            path.append(self.nodes[cur])
            cur = self.nodes[cur].parent
        return list(reversed(path))

    def trunk(self) -> list[MsgNode]:
        """最长根→叶路径（按节点数；平局取末端 seq 最大者）。纯视图规则。"""
        best: list[MsgNode] = []
        for root in self.children.get(None, []):
            stack = [root]
            while stack:
                seq = stack.pop()
                kids = self.children.get(seq, [])
                if kids:
                    stack.extend(kids)
                else:
                    p = self.path_to(seq)
                    if len(p) > len(best) or (
                        len(p) == len(best) and p[-1].seq > best[-1].seq
                    ):
                        best = p
        return best

    def trunk_end(self) -> int | None:
        t = self.trunk()
        return t[-1].seq if t else None

    def unanswered_user(self) -> int | None:
        """最新的悬而未答 user 节点（无子节点）；/retry 的目标。无则 None。"""
        best: int | None = None
        for s, n in self.nodes.items():
            if n.role == "user" and not self.children.get(s):
                if best is None or s > best:
                    best = s
        return best

    def fork_point(self, seq: int) -> int | None:
        """路径上最后一个拥有 ≥2 子节点的祖先（不含自身）；无则 None。

        卡片提炼默认范围的起点依据（spec §3.2）。
        """
        for node in reversed(self.path_to(seq)[:-1]):
            if len(self.children.get(node.seq, [])) >= 2:
                return node.seq
        return None
