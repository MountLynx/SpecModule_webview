"""/tree ASCII 渲染（纯展示层；第二消费方出现再上收查询层）。"""
from __future__ import annotations

from ..core.conversation import Conversation


def render_tree(conv: Conversation) -> str:
    """根列表逐棵渲染；标注 ◆ 主干末端、* 指针、[card_x] 卡片来源。"""
    if not conv.nodes:
        return "（空会话）"
    lines: list[str] = []
    trunk_end = conv.trunk_end()
    card_by_seq: dict[int, list[str]] = {}
    for c in conv.cards.all_cards():
        for s in c.from_path:
            card_by_seq.setdefault(s, []).append(c.id)

    def emit(seq: int, prefix: str = "", branch: str = "") -> None:
        n = conv.nodes[seq]
        marks: list[str] = []
        if seq == trunk_end:
            marks.append("◆")
        if seq == conv.pointer:
            marks.append("*")
        if seq in card_by_seq:
            marks.append("[" + ",".join(card_by_seq[seq]) + "]")
        text = n.text.replace("\n", " ")[:32]
        suffix = (" " + " ".join(marks)) if marks else ""
        lines.append(f"{prefix}{branch}#{seq} {n.role}{suffix} {text}")

    def walk(seq: int, prefix: str) -> None:
        kids = conv.children.get(seq, [])
        for i, k in enumerate(kids):
            last = i == len(kids) - 1
            emit(k, prefix, "└─ " if last else "├─ ")
            walk(k, prefix + ("   " if last else "│  "))

    for root in conv.children.get(None, []):
        emit(root)
        walk(root, "")
    return "\n".join(lines)
