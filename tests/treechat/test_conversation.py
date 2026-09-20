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


def test_assistant_fills_parent_turn_and_pointer_advances(tmp_path):
    conv = _conv(tmp_path)
    u = conv.append_user("q")
    ret = conv.append_assistant(u, "a", model="m")
    assert ret == u                       # 返回轮 seq，无新节点
    assert conv.pointer == u              # 指针推进到轮
    assert conv.nodes[u].output == "a"
    assert conv.nodes[u].model == "m"
    u2 = conv.append_user("q2")
    assert conv.nodes[u2].parent == u


def test_legacy_assistant_seq_recorded(tmp_path):
    """assistant 事件 seq 记入 legacy（→ 轮 seq），供历史引用归一化。"""
    conv = _conv(tmp_path)
    u = conv.append_user("q")
    conv.append_assistant(u, "a")
    assert len(conv.legacy) == 1
    assert next(iter(conv.legacy.values())) == u
    assert next(iter(conv.legacy)) > u    # 事件行号在 user 事件之后


def test_branch_semantics_via_set_pointer(tmp_path):
    conv = _conv(tmp_path)
    u = conv.append_user("q")
    conv.append_assistant(u, "a")
    conv.set_pointer(u)  # 回到该轮开分支
    b = conv.append_user("追问")
    assert conv.nodes[b].parent == u


def test_leaf_creates_second_root(tmp_path):
    conv = _conv(tmp_path)
    conv.append_user("q")
    leaf = conv.append_user("概念提问", leaf=True)
    assert conv.nodes[leaf].parent is None


def test_append_assistant_requires_existing_turn(tmp_path):
    conv = _conv(tmp_path)
    conv.append_user("q")
    with pytest.raises(TreeChatError, match="目标轮不存在"):
        conv.append_assistant(99, "x")


def test_path_to_and_trunk_longest_wins(tmp_path):
    conv = _conv(tmp_path)
    u1 = conv.append_user("q1")
    conv.append_assistant(u1, "a1")
    u2 = conv.append_user("q2")
    conv.append_assistant(u2, "a2")               # 主干：2 轮
    conv.set_pointer(u1)
    b1 = conv.append_user("分支问")               # 分支：2 轮（平局）
    conv.append_assistant(b1, "分支答")
    assert [n.seq for n in conv.path_to(u2)] == [u1, u2]
    u3 = conv.append_user("q3")                   # 回主干续一轮 → 3 轮胜出
    assert conv.trunk_end() == u3
    assert conv.nodes[conv.trunk_end()].input == "q3"


def test_trunk_tie_prefers_newer_end(tmp_path):
    conv = _conv(tmp_path)
    u1 = conv.append_user("q1")
    conv.append_assistant(u1, "a1")               # 路径1：1 轮
    conv.set_pointer(None)
    u2 = conv.append_user("leaf", leaf=True)
    conv.append_assistant(u2, "a2")               # 路径2：1 轮，末端更新
    assert conv.trunk_end() == conv.pointer


def test_fork_point(tmp_path):
    conv = _conv(tmp_path)
    u1 = conv.append_user("q")
    conv.append_assistant(u1, "a")
    u2 = conv.append_user("q2")
    conv.set_pointer(u1)
    b1 = conv.append_user("分支问")
    assert conv.fork_point(u2) == u1              # u1 有两个子轮
    assert conv.fork_point(b1) == u1
    assert conv.fork_point(u1) is None            # 不含自身


def test_cards_default_pinned_and_pin_events(tmp_path):
    conv = _conv(tmp_path)
    u = conv.append_user("q")
    conv.append_assistant(u, "a")
    cid = conv.add_card("标题", "正文", from_path=[u], instruction="总结")
    assert [c.id for c in conv.cards.pinned_cards()] == [cid]
    conv.unpin(cid)
    assert conv.cards.pinned_cards() == []
    conv.pin(cid)
    assert len(conv.cards.pinned_cards()) == 1


def test_system_update_event(tmp_path):
    conv = _conv(tmp_path)
    conv.update_system("新指令")
    assert conv.system == "新指令"


def test_unanswered_latest_without_output(tmp_path):
    conv = _conv(tmp_path)
    u = conv.append_user("q")                      # 悬而未答
    assert conv.unanswered() == u
    conv.append_assistant(u, "a")
    assert conv.unanswered() is None
    leaf = conv.append_user("q2", leaf=True)       # 新悬而未答叶子
    assert conv.unanswered() == leaf
    conv.append_assistant(leaf, "a2")
    assert conv.unanswered() is None
    leaf2 = conv.append_user("q3", leaf=True)
    assert conv.unanswered() == leaf2              # 多个未答取最新


def test_reopen_replays_identical_view(tmp_path):
    p = tmp_path / "s.jsonl"
    conv = Conversation.create(p, name="t", system="s")
    u = conv.append_user("q")
    conv.append_assistant(u, "a", model="m")
    cid = conv.add_card("t", "b", from_path=[u])
    conv.unpin(cid)
    conv.update_system("s2")
    conv.set_pointer(None)
    conv2 = Conversation.open(p)
    assert conv2.name == "t" and conv2.system == "s2"
    # set_pointer 不落事件 → 重放后指针 = 最新完成轮次（spec §2.2）
    assert conv2.pointer == u
    assert set(conv2.nodes) == set(conv.nodes)
    assert conv2.cards.get(cid) == conv.cards.get(cid)
    assert conv2.cards.pinned_cards() == []


def test_replay_old_format_chained_parents(tmp_path):
    """旧格式真实形态：user 消息 parent 指向 assistant 节点 seq（旧指针语义）→ 重放归一化为轮。"""
    p = tmp_path / "old.jsonl"
    lines = [
        '{"seq":1,"type":"session_meta","name":"old","created_at":"t","system":""}',
        '{"seq":2,"type":"user_msg","parent":null,"text":"q1"}',
        '{"seq":3,"type":"assistant_msg","parent":2,"text":"a1","model":"","usage":{}}',
        '{"seq":4,"type":"user_msg","parent":3,"text":"q2"}',
        '{"seq":5,"type":"assistant_msg","parent":4,"text":"a2","model":"","usage":{}}',
        '{"seq":6,"type":"node_rename","node":5,"label":"旧命名"}',
    ]
    p.write_text("\n".join(lines) + "\n", encoding="utf-8")
    conv = Conversation.open(p)
    assert [n.seq for n in conv.nodes.values()] == [2, 4]
    assert conv.nodes[4].parent == 2              # user4.parent=3(assistant seq) → 轮2
    assert conv.nodes[4].output == "a2"
    assert conv.nodes[2].label == ""
    assert conv.nodes[4].label == "旧命名"        # rename node=5(assistant seq) → 轮4
    assert conv.pointer == 4


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
