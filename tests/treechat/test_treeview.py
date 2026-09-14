"""/tree ASCII 渲染。"""
from treechat.cli.treeview import render_tree
from treechat.core.conversation import Conversation


def _build(tmp_path):
    conv = Conversation.create(tmp_path / "s.jsonl", name="t")
    u1 = conv.append_user("主干问")                 # 2
    a1 = conv.append_assistant(u1, "主干答")        # 3
    conv.set_pointer(u1)
    u2 = conv.append_user("分支问")                 # 4
    a2 = conv.append_assistant(u2, "分支答")        # 5
    cid = conv.add_card("标题", "正文", from_path=[u2, a2])
    leaf = conv.append_user("叶子提问", leaf=True)  # 7
    conv.set_pointer(a2)
    return conv, cid, leaf, a2


def test_render_marks_pointer_trunk_and_cards(tmp_path):
    conv, cid, leaf, a2 = _build(tmp_path)
    text = render_tree(conv)
    assert "◆" in text                       # 主干末端 #3
    assert "*" in text                       # 指针 #5
    assert f"[{cid}]" in text                # 卡片来源标注
    assert "#7 user" in text                 # 叶子根可见
    lines = text.splitlines()
    assert lines[0].startswith("#2")         # 第一根在顶部


def test_render_empty(tmp_path):
    conv = Conversation.create(tmp_path / "e.jsonl", name="e")
    assert render_tree(conv) == "（空会话）"
