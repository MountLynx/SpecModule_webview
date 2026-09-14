"""Conversation：三种 parent 语义 / 指针 / path_to / trunk / fork_point / 卡片事件 / 重放。"""
import pytest

from treechat.core.cards import Card
from treechat.core.conversation import Conversation
from treechat.core.errors import TreeChatError


def _conv(tmp_path, name="t"):
    return Conversation.create(tmp_path / "s.jsonl", name=name, system="sys0")


def test_create_and_first_user_is_root(tmp_path):
    conv = _conv(tmp_path)
    assert (conv.name, conv.system, conv.pointer) == ("t", "sys0", None)
    seq = conv.append_user("第一句")
    assert conv.nodes[seq].parent is None
    assert conv.pointer is None  # 指针只在 assistant 后推进


def test_turn_appends_and_pointer_advances(tmp_path):
    conv = _conv(tmp_path)
    u = conv.append_user("q")
    a = conv.append_assistant(u, "a", model="m")
    assert conv.pointer == a
    assert conv.nodes[a].parent == u
    u2 = conv.append_user("q2")
    assert conv.nodes[u2].parent == a


def test_branch_semantics_via_set_pointer(tmp_path):
    conv = _conv(tmp_path)
    u = conv.append_user("q")
    a = conv.append_assistant(u, "a")
    conv.set_pointer(u)  # 回到 user 节点开分支
    b = conv.append_user("追问")
    assert conv.nodes[b].parent == u


def test_leaf_creates_second_root(tmp_path):
    conv = _conv(tmp_path)
    conv.append_user("q")
    leaf = conv.append_user("概念提问", leaf=True)
    assert conv.nodes[leaf].parent is None


def test_append_assistant_requires_user_target(tmp_path):
    conv = _conv(tmp_path)
    u = conv.append_user("q")
    a = conv.append_assistant(u, "a")
    with pytest.raises(TreeChatError, match="user 节点"):
        conv.append_assistant(a, "x")


def test_path_to_and_trunk_longest_wins(tmp_path):
    conv = _conv(tmp_path)
    u1 = conv.append_user("q1")
    a1 = conv.append_assistant(u1, "a1")
    u2 = conv.append_user("q2")
    a2 = conv.append_assistant(u2, "a2")          # 主干：1-2-3-4
    conv.set_pointer(u1)
    b1 = conv.append_user("分支问")               # 分支：1-5
    conv.append_assistant(b1, "分支答")           # 1-5-6
    assert [n.seq for n in conv.path_to(a2)] == [u1, a1, u2, a2]
    assert conv.trunk_end() == a2                 # 4 节点 > 3 节点
    assert conv.nodes[conv.trunk_end()].role == "assistant"


def test_trunk_tie_prefers_newer_end(tmp_path):
    conv = _conv(tmp_path)
    u1 = conv.append_user("q1")
    a1 = conv.append_assistant(u1, "a1")          # 路径1：2 节点
    conv.set_pointer(None)
    u2 = conv.append_user("leaf", leaf=True)
    conv.append_assistant(u2, "a2")               # 路径2：2 节点，末端更新
    assert conv.trunk_end() == conv.pointer


def test_fork_point(tmp_path):
    conv = _conv(tmp_path)
    u1 = conv.append_user("q")
    a1 = conv.append_assistant(u1, "a")
    u2 = conv.append_user("q2")
    conv.set_pointer(a1)
    b1 = conv.append_user("分支问")
    assert conv.fork_point(u2) == a1              # a1 有两个子节点
    assert conv.fork_point(b1) == a1
    assert conv.fork_point(a1) is None            # 不含自身


def test_cards_default_pinned_and_pin_events(tmp_path):
    conv = _conv(tmp_path)
    u = conv.append_user("q")
    conv.append_assistant(u, "a")
    cid = conv.add_card("标题", "正文", from_path=[u, conv.pointer], instruction="总结")
    assert [c.id for c in conv.cards.pinned_cards()] == [cid]
    conv.unpin(cid)
    assert conv.cards.pinned_cards() == []
    conv.pin(cid)
    assert len(conv.cards.pinned_cards()) == 1


def test_system_update_event(tmp_path):
    conv = _conv(tmp_path)
    conv.update_system("新指令")
    assert conv.system == "新指令"


def test_unanswered_user(tmp_path):
    conv = _conv(tmp_path)
    u = conv.append_user("q")                      # 悬而未答
    assert conv.unanswered_user() == u
    a = conv.append_assistant(u, "a")
    assert conv.unanswered_user() is None
    leaf = conv.append_user("q2", leaf=True)       # 新悬而未答叶子
    assert conv.unanswered_user() == leaf
    conv.append_assistant(leaf, "a2")
    assert conv.unanswered_user() is None


def test_reopen_replays_identical_view(tmp_path):
    p = tmp_path / "s.jsonl"
    conv = Conversation.create(p, name="t", system="s")
    u = conv.append_user("q")
    a = conv.append_assistant(u, "a", model="m")
    cid = conv.add_card("t", "b", from_path=[u, a])
    conv.unpin(cid)
    conv.update_system("s2")
    conv.set_pointer(u)
    conv2 = Conversation.open(p)
    assert conv2.name == "t" and conv2.system == "s2"
    # set_pointer 不落事件 → 重放后指针 = 文件序最后一个 assistant（spec §2.2）
    assert conv2.pointer == a
    assert set(conv2.nodes) == set(conv.nodes)
    assert conv2.cards.get(cid) == conv.cards.get(cid)
    assert conv2.cards.pinned_cards() == []


def test_replay_rejects_dangling_parent(tmp_path):
    p = tmp_path / "s.jsonl"
    Conversation.create(p, name="t")
    store_lines = p.read_text(encoding="utf-8")
    p.write_text(store_lines + '{"seq":2,"type":"assistant_msg","parent":9,"text":"x","model":"","usage":{}}\n',
                 encoding="utf-8")
    with pytest.raises(TreeChatError, match="parent"):
        Conversation.open(p)


def test_set_pointer_unknown_node_raises(tmp_path):
    conv = _conv(tmp_path)
    with pytest.raises(TreeChatError, match="指针目标"):
        conv.set_pointer(99)


def test_session_rename_category_archive_replay(tmp_path):
    conv = _conv(tmp_path, name="原名")
    conv.rename("改名")
    conv.set_category("工作")
    conv.set_archived(True)
    assert (conv.name, conv.category, conv.archived) == ("改名", "工作", True)
    # 重放同一性：重新 open 派生态一致
    reopened = Conversation.open(tmp_path / "s.jsonl")
    assert (reopened.name, reopened.category, reopened.archived) == ("改名", "工作", True)
    # 反向操作也落事件
    reopened.set_archived(False)
    reopened.set_category("")
    reopened2 = Conversation.open(tmp_path / "s.jsonl")
    assert (reopened2.category, reopened2.archived) == ("", False)
    assert reopened2.name == "改名"


def test_rename_node_sets_label_and_replays(tmp_path):
    conv = _conv(tmp_path)
    u = conv.append_user("问题")
    conv.rename_node(u, "概念澄清")
    assert conv.nodes[u].label == "概念澄清"
    assert Conversation.open(tmp_path / "s.jsonl").nodes[u].label == "概念澄清"
    # 空串 = 清除命名
    conv.rename_node(u, "")
    assert Conversation.open(tmp_path / "s.jsonl").nodes[u].label == ""


def test_rename_node_unknown_seq_rejected(tmp_path):
    conv = _conv(tmp_path)
    with pytest.raises(TreeChatError, match="不存在"):
        conv.rename_node(99, "x")


def test_edit_and_delete_card_replay(tmp_path):
    conv = _conv(tmp_path)
    cid = conv.add_card("原标题", "原正文", from_path=[1])
    conv.edit_card(cid, "新标题", "新正文")
    card = conv.cards.get(cid)
    assert (card.title, card.body) == ("新标题", "新正文")
    assert card.from_path == [1]  # 其余字段不动
    # 重放同一性
    reopened = Conversation.open(tmp_path / "s.jsonl")
    assert reopened.cards.get(cid) == card
    # 删除（默认 pinned 一并清除）+ 重放一致
    assert conv.cards.is_pinned(cid)
    conv.delete_card(cid)
    assert conv.cards.all_cards() == []
    assert Conversation.open(tmp_path / "s.jsonl").cards.all_cards() == []
    # 删除后可新建同 id 概念上不冲突（id 随机）；对未知卡片操作抛错
    with pytest.raises(TreeChatError, match="未知卡片"):
        conv.edit_card(cid, "t", "b")
    with pytest.raises(TreeChatError, match="未知卡片"):
        conv.delete_card(cid)


def test_failed_card_ops_leave_no_poison_events(tmp_path):
    """对未知卡片 edit/delete/pin 失败 → 不落事件（否则文件重放必失败被锁死）。"""
    conv = _conv(tmp_path)
    cid = conv.add_card("t", "b", from_path=[1])
    with pytest.raises(TreeChatError, match="未知卡片"):
        conv.pin("card_nope")
    with pytest.raises(TreeChatError, match="未知卡片"):
        conv.unpin("card_nope")
    with pytest.raises(TreeChatError, match="未知卡片"):
        conv.edit_card("card_nope", "t", "b")
    with pytest.raises(TreeChatError, match="未知卡片"):
        conv.delete_card("card_nope")
    # 文件完好：重放得到与内存一致的视图
    reopened = Conversation.open(tmp_path / "s.jsonl")
    assert [c.id for c in reopened.cards.all_cards()] == [cid]
    assert reopened.cards.is_pinned(cid)


def test_add_card_explicit_id_replays(tmp_path):
    """显式 card_id 落盘并在重放后保持（spec 卡片固定 ID 依赖此能力）。"""
    conv = Conversation.create(tmp_path / "s.jsonl", name="t")
    cid = conv.add_card("设计树", "# 树", from_path=[], card_id="spec:tree")
    assert cid == "spec:tree"
    assert conv.cards.get("spec:tree").title == "设计树"
    # 重放同一性
    reopened = Conversation.open(tmp_path / "s.jsonl")
    assert reopened.cards.get("spec:tree").body == "# 树"
