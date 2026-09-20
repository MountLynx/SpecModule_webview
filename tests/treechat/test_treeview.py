"""/tree ASCII 渲染。"""
from treechat.cli.treeview import render_tree
from treechat.core.conversation import Conversation


def _build(tmp_path):
    conv = Conversation.create(tmp_path / "s.jsonl", name="t")
    u1 = conv.append_user("主干问")                 # 2（assistant 事件 seq=3）
    conv.append_assistant(u1, "主干答")
    conv.set_pointer(u1)
    u2 = conv.append_user("分支问")                 # 4（assistant 事件 seq=5）
    conv.append_assistant(u2, "分支答")
    cid = conv.add_card("标题", "正文", from_path=[u2])
    leaf = conv.append_user("叶子提问", leaf=True)  # 7（卡片事件 seq=6）
    conv.set_pointer(u2)
    return conv, cid, leaf, u2


def test_render_marks_pointer_trunk_and_cards(tmp_path):
    conv, cid, leaf, u2 = _build(tmp_path)
    text = render_tree(conv)
    assert "◆" in text                       # 主干末端
    assert "*" in text                       # 指针 #4
    assert f"[{cid}]" in text                # 卡片来源标注
    assert f"#7 " in text                    # 叶子根可见
    assert "→" in text                       # 一行 = 问 → 答
    lines = text.splitlines()
    assert lines[0].startswith("#2")         # 第一根在顶部


def test_render_empty(tmp_path):
    conv = Conversation.create(tmp_path / "e.jsonl", name="e")
    assert render_tree(conv) == "（空会话）"
