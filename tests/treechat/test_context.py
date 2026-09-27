"""上下文组装：轮次展开 history/current、连续同角色合并、卡片块、V1 窗口策略。"""
import pytest

from treechat.core.cards import Card
from treechat.core.context import TokenWindowStrategy, assemble, estimate_tokens
from treechat.core.conversation import MsgNode
from treechat.core.errors import TreeChatError


def _turn(seq, input, output=None, parent=None):
    return MsgNode(seq=seq, parent=parent, input=input, output=output)


def _path(*turns):
    """turns = (input, output | None) 序列，seq 从 1 递增。"""
    return [_turn(i, inp, out) for i, (inp, out) in enumerate(turns, start=1)]


def test_assemble_splits_history_and_current():
    path = _path(("q1", "a1"), ("q2", None))
    ctx = assemble(path, system="S", cards=[])
    assert ctx.current == "q2"
    assert ctx.history == [
        {"role": "user", "content": "q1"},
        {"role": "assistant", "content": "a1"},
    ]
    assert ctx.system == "S"


def test_unanswered_turn_contributes_user_side_only():
    path = _path(("q1", None), ("q2", None))
    ctx = assemble(path, system="", cards=[])
    assert ctx.history == [{"role": "user", "content": "q1"}]


def test_leaf_path_history_empty():
    ctx = assemble(_path(("概念提问", None)), system="", cards=[])
    assert ctx.history == []
    assert ctx.current == "概念提问"


def test_assemble_requires_unanswered_tail():
    with pytest.raises(TreeChatError, match="未答轮次"):
        assemble(_path(("q", "a")), system="", cards=[])


def test_merge_consecutive_same_role():
    path = _path(("q1", None), ("q2(未答)", None), ("q3", None))
    ctx = assemble(path, system="", cards=[])
    assert ctx.history == [{"role": "user", "content": "q1\n\nq2(未答)"}]
    assert ctx.current == "q3"


def test_pinned_cards_block_in_system():
    cards = [Card(id="card_1", title="标题", body="正文", from_path=[1])]
    ctx = assemble(_path(("q", None)), system="S", cards=cards)
    assert ctx.system == "S\n\n[参考卡片 card_1: 标题]\n正文"


def test_window_drops_oldest_with_warning_but_keeps_cards():
    cards = [Card(id="card_1", title="T", body="B" * 200, from_path=[1])]
    turns = [(f"msg{i}长" * 30, None if i == 8 else f"ans{i}长" * 30) for i in range(1, 9)]
    strat = TokenWindowStrategy(budget_tokens=200)
    ctx = assemble(_path(*turns), system="S", cards=cards, strategy=strat)
    assert "[参考卡片 card_1: T]" in ctx.system          # 卡片整块保留
    assert "因窗口预算未纳入" in ctx.system               # 显式警示
    assert len(ctx.history) < 14                         # 7 完成轮 × 2 条，丢了最旧
    assert ctx.history[-2]["content"].startswith("msg7") # 保留最新轮（msg8=current，不在 history）
    assert ctx.history[-1]["content"].startswith("ans7")


def test_window_within_budget_no_warning():
    path = _path(("q1", "a1"), ("q2", None))
    ctx = assemble(path, system="S", cards=[], strategy=TokenWindowStrategy(budget_tokens=10_000))
    assert "因窗口预算未纳入" not in ctx.system
    assert len(ctx.history) == 2


def test_estimate_tokens_cjk_counts_per_char():
    assert estimate_tokens("一二三四五六七八九十") == 10   # 中文 1 字 1 token（旧算法 = 2）
    assert estimate_tokens("abcdefgh") == 2                # ASCII 保留 4 chars/token
    assert estimate_tokens("abc中文") == 2                 # 混合分段：2 CJK + 3//4 ASCII
    assert estimate_tokens("，。！") == 3                   # CJK 标点/全角同区间


def test_window_oversized_system_drops_all_history():
    # system 独占超预算：首条 history 消息不豁免，清空且警示照常注入
    ctx = assemble(_path(("q1", "a1"), ("q2", None)),
                   system="x" * 500, cards=[],
                   strategy=TokenWindowStrategy(budget_tokens=100))
    assert ctx.history == []
    assert "因窗口预算未纳入" in ctx.system
