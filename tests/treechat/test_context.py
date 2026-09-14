"""上下文组装：history/current 分离、连续同角色合并、卡片块、V1 窗口策略。"""
import pytest

from treechat.core.cards import Card
from treechat.core.context import TokenWindowStrategy, assemble
from treechat.core.conversation import MsgNode
from treechat.core.errors import TreeChatError


def _node(seq, role, text, parent=None):
    return MsgNode(seq=seq, parent=parent, role=role, text=text)


def _path(*texts_roles):
    nodes = []
    for i, (role, text) in enumerate(texts_roles, start=1):
        nodes.append(_node(i, role, text))
    return nodes


def test_assemble_splits_history_and_current():
    path = _path(("user", "q1"), ("assistant", "a1"), ("user", "q2"))
    ctx = assemble(path, system="S", cards=[])
    assert ctx.current == "q2"
    assert ctx.history == [
        {"role": "user", "content": "q1"},
        {"role": "assistant", "content": "a1"},
    ]
    assert ctx.system == "S"


def test_leaf_path_history_empty():
    ctx = assemble(_path(("user", "概念提问")), system="", cards=[])
    assert ctx.history == []
    assert ctx.current == "概念提问"


def test_assemble_requires_user_tail():
    with pytest.raises(TreeChatError, match="user 节点"):
        assemble(_path(("user", "q"), ("assistant", "a")), system="", cards=[])


def test_merge_consecutive_same_role():
    path = _path(("user", "q1"), ("user", "q2(未答)"), ("user", "q3"))
    ctx = assemble(path, system="", cards=[])
    assert ctx.history == [{"role": "user", "content": "q1\n\nq2(未答)"}]
    assert ctx.current == "q3"


def test_pinned_cards_block_in_system():
    cards = [Card(id="card_1", title="标题", body="正文", from_path=[1])]
    ctx = assemble(_path(("user", "q")), system="S", cards=cards)
    assert ctx.system == "S\n\n[参考卡片 card_1: 标题]\n正文"


def test_window_drops_oldest_with_warning_but_keeps_cards():
    cards = [Card(id="card_1", title="T", body="B" * 200, from_path=[1])]
    path = _path(*[("user" if i % 2 == 0 else "assistant", f"msg{i}长" * 30) for i in range(1, 9)])
    strat = TokenWindowStrategy(budget_tokens=200)
    ctx = assemble(path, system="S", cards=cards, strategy=strat)
    assert "[参考卡片 card_1: T]" in ctx.system          # 卡片整块保留
    assert "因窗口预算未纳入" in ctx.system               # 显式警示
    assert len(ctx.history) < 8                          # 丢了最旧
    assert ctx.history[-1]["content"].startswith("msg7") # 保留最新（msg8=current，不在 history）


def test_window_within_budget_no_warning():
    path = _path(("user", "q1"), ("assistant", "a1"), ("user", "q2"))
    ctx = assemble(path, system="S", cards=[], strategy=TokenWindowStrategy(budget_tokens=10_000))
    assert "因窗口预算未纳入" not in ctx.system
    assert len(ctx.history) == 2
