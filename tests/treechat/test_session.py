"""TreeChatSession：轮次持久时序 / 失败悬而未答 / 卡片默认范围 / 导出。"""
import asyncio
import json

import pytest

from treechat.config import TreeChatConfig
from treechat.core.errors import TreeChatError
from treechat.core.events import UserMsg
from treechat.session import (
    TreeChatSession, card_markdown, list_library_cards, list_sessions,
)


def _session(tmp_path, fake_module, fake_card_client, name="t"):
    path = tmp_path / "s.jsonl"
    conv_session = TreeChatSession.__new__(TreeChatSession)
    from treechat.core.conversation import Conversation
    conv = Conversation.create(path, name=name, system="sys")
    conv_session.conversation = conv
    conv_session.client = fake_module
    conv_session.card_llm = fake_card_client
    from treechat.core.context import TokenWindowStrategy
    conv_session.window = TokenWindowStrategy(budget_tokens=10_000)
    conv_session.mode_modules = None  # None = 内置默认映射
    return conv_session


def test_turn_persists_user_first_then_assistant(tmp_path, fake_module, fake_card_client):
    s = _session(tmp_path, fake_module, fake_card_client)
    # 让 LLM 失败：user 节点已落盘，无 assistant
    fake_module.fail = True
    with pytest.raises(RuntimeError):
        asyncio.run(s.turn("问题"))
    assert s.conversation.nodes[2].role == "user"          # seq1=meta, seq2=user
    assert s.conversation.pointer is None
    # 恢复后 retry：在原节点下补 assistant，不重复问题
    fake_module.fail = False
    a = asyncio.run(s.turn_retry(2))
    assert s.conversation.pointer == a
    assert s.conversation.nodes[a].parent == 2
    assert [n.seq for n in s.conversation.nodes.values()].count(2) == 1


def test_turn_happy_path(tmp_path, fake_module, fake_card_client):
    s = _session(tmp_path, fake_module, fake_card_client)
    a = asyncio.run(s.turn("你好"))
    assert s.conversation.nodes[a].text == "mock reply"
    assert s.conversation.nodes[a].model == "fake-model"
    assert s.conversation.path_to(a)[-1].role == "assistant"


def test_turn_leaf_no_context(tmp_path, fake_module, fake_card_client):
    s = _session(tmp_path, fake_module, fake_card_client)
    asyncio.run(s.turn("主对话"))
    asyncio.run(s.turn("叶子提问", leaf=True))
    prompt = fake_module.calls[-1]["prompt"]
    assert "叶子提问" in prompt          # brief 原话
    assert "[user]" not in prompt        # 叶子：无 history 转录


def test_branch_segment_default_and_user_fork(tmp_path, fake_module, fake_card_client):
    s = _session(tmp_path, fake_module, fake_card_client)
    a1 = asyncio.run(s.turn("主干问"))            # meta=1 → user=2, assistant=3
    conv = s.conversation
    conv.set_pointer(2)                            # 回 user 节点
    asyncio.run(s.turn("分支问"))                  # user=4, assistant=5
    assert conv.pointer == 5
    assert s.branch_segment() == [2, 4, 5]         # fork 在 #2(user) → 含其自身
    # fork 在 user 节点的情形：#2 下再开一支 → #2 有三个子
    conv.set_pointer(2)
    asyncio.run(s.turn("另一支"))                  # user=6, assistant=7
    assert s.branch_segment() == [2, 6, 7]
    # 从 user 节点分叉：#4 变成有两个子的 fork（4 的孩子是 5）——构造 user fork：
    conv.set_pointer(4)                            # 指回 user#4
    b = conv.append_user("user fork 下的问题")     # user=8, parent=4
    a = conv.append_assistant(b, "答")             # assistant=9
    assert s.branch_segment(9) == [4, 8, 9]        # fork #4 是 user → 含其自身


def test_branch_segment_assistant_fork_excluded(tmp_path, fake_module, fake_card_client):
    s = _session(tmp_path, fake_module, fake_card_client)
    asyncio.run(s.turn("主干问"))                  # user=2, assistant=3
    conv = s.conversation
    conv.set_pointer(3)                            # 回 assistant 节点
    asyncio.run(s.turn("甲支"))                    # user=4, assistant=5
    conv.set_pointer(3)                            # 同一 assistant 下再开一支
    asyncio.run(s.turn("乙支"))                    # user=6, assistant=7
    assert conv.pointer == 7
    # fork 在 #3(assistant) → 不含其自身，从分支的 user 节点起
    assert s.branch_segment() == [6, 7]


def test_make_card_defaults_pinned(tmp_path, fake_module, fake_card_client):
    s = _session(tmp_path, fake_module, fake_card_client)
    asyncio.run(s.turn("问"))
    cid = asyncio.run(s.make_card("总结为卡片"))
    card = s.conversation.cards.get(cid)
    assert (card.title, card.body) == ("卡片标题", "卡片正文")
    assert [c.id for c in s.conversation.cards.pinned_cards()] == [cid]


def test_export_card(tmp_path, fake_module, fake_card_client):
    s = _session(tmp_path, fake_module, fake_card_client)
    asyncio.run(s.turn("问"))
    cid = asyncio.run(s.make_card("总结"))
    out = s.export_card(cid, tmp_path / "card.md")
    text = out.read_text(encoding="utf-8")
    assert text.startswith("# 卡片标题") and "卡片正文" in text


def test_list_sessions(tmp_path, fake_module, fake_card_client, monkeypatch):
    # create_client 走 env 配置链（config.json），单测不依赖环境 → 假客户端替身
    from treechat import llm_bridge
    monkeypatch.setattr(llm_bridge, "create_client", lambda model=None: fake_module)
    config = TreeChatConfig(data_dir=tmp_path)
    config.sessions_dir().mkdir(parents=True)
    path = config.sessions_dir() / "甲.jsonl"
    s = TreeChatSession.create(path, "甲", system="sys")
    s.conversation.rename("甲改")
    s.conversation.set_category("工作")
    s.conversation.set_archived(True)
    # 坏文件（首行非 JSON）→ 枚举时跳过，打开时才硬报错
    (config.sessions_dir() / "坏.jsonl").write_text("not json", encoding="utf-8")
    listed = list_sessions(config)
    assert [m.sid for m in listed] == ["甲"]
    m = listed[0]
    assert (m.name, m.system, m.category, m.archived) == ("甲改", "sys", "工作", True)
    assert m.node_count == 0 and m.created_at  # 只有 meta，无消息节点
    assert m.path == path


def test_list_sessions_counts_nodes_and_tolerates_torn_tail(
        tmp_path, fake_module, fake_card_client, monkeypatch):
    from treechat import llm_bridge
    monkeypatch.setattr(llm_bridge, "create_client", lambda model=None: fake_module)
    config = TreeChatConfig(data_dir=tmp_path)
    s = TreeChatSession.create(config.sessions_dir() / "t.jsonl", "t")
    asyncio.run(s.turn("问题一"))
    # 撕裂尾：末行不完整 → 容忍并忽略该行
    p = config.sessions_dir() / "t.jsonl"
    with open(p, "a", encoding="utf-8") as f:
        f.write('{"seq":4,"type":"user_msg","parent":3,"text":"被截断的')
    listed = list_sessions(config)
    assert len(listed) == 1 and listed[0].node_count == 2


def test_make_card_rejects_unknown_seqs(tmp_path, fake_module, fake_card_client):
    s = _session(tmp_path, fake_module, fake_card_client)
    asyncio.run(s.turn("问"))
    with pytest.raises(TreeChatError, match="不存在的节点"):
        asyncio.run(s.make_card("总结", from_seqs=[2, 99]))


def test_list_library_cards_across_sessions(tmp_path, fake_module, fake_card_client, monkeypatch):
    from treechat import llm_bridge
    monkeypatch.setattr(llm_bridge, "create_client", lambda model=None: fake_module)
    config = TreeChatConfig(data_dir=tmp_path)
    s1 = TreeChatSession.create(config.sessions_dir() / "会话一.jsonl", "会话一")
    s2 = TreeChatSession.create(config.sessions_dir() / "会话二.jsonl", "会话二")
    s1.card_llm = fake_card_client  # 提炼走假卡片客户端（与 _session 助手一致）
    asyncio.run(s1.turn("问"))
    c1 = asyncio.run(s1.make_card("总结"))
    s1.conversation.unpin(c1)
    c2 = s2.conversation.add_card("手写卡", "手写正文", from_path=[])
    # 坏文件 → 跳过（与 list_sessions 同纪律）
    (config.sessions_dir() / "坏.jsonl").write_text('{"seq":1,"type":"magic"}', encoding="utf-8")
    lib = list_library_cards(config)
    assert [(e.sid, e.card.id) for e in lib] == [("会话一", c1), ("会话二", c2)]
    by_sid = {e.sid: e for e in lib}
    assert by_sid["会话一"].session_name == "会话一" and by_sid["会话一"].pinned is False
    assert by_sid["会话二"].pinned is True
    assert card_markdown(by_sid["会话二"].card) == "# 手写卡\n\n手写正文\n"


def test_complete_dispatch_grilling_creates_spec_cards(tmp_path, fake_module, fake_card_client):
    s = _session(tmp_path, fake_module, fake_card_client)
    s.conversation.set_category("grilling")
    fake_module.responses = [
        "# 树-v1",
        json.dumps({"questions_md": "❓ Q1", "done": False, "terms_md": ""}),
        json.dumps({"glossary_md": "**Order**: 订单", "adr_candidates": ""}),
    ]
    a = asyncio.run(s.turn("做一个订单系统"))
    cards = {c.id: c for c in s.conversation.cards.all_cards()}
    assert set(cards) == {"spec:tree", "spec:glossary"}
    assert cards["spec:tree"].title == "设计树" and cards["spec:tree"].body == "# 树-v1"
    assert s.conversation.cards.is_pinned("spec:tree")
    assert s.conversation.nodes[a].text == "❓ Q1"


def test_spec_card_refresh_edits_and_prompts_read_card_body(
        tmp_path, fake_module, fake_card_client):
    s = _session(tmp_path, fake_module, fake_card_client)
    s.conversation.set_category("grilling")
    fake_module.responses = [
        "# 树-v1",
        json.dumps({"questions_md": "Q1", "done": False, "terms_md": ""}),
        json.dumps({"glossary_md": "g1", "adr_candidates": ""}),
    ]
    asyncio.run(s.turn("第一问"))
    # 双通道直填：用户编辑 spec 卡
    s.conversation.edit_card("spec:tree", "设计树", "# 用户手改的树")
    fake_module.responses = [
        "# 树-v2",
        json.dumps({"questions_md": "Q2", "done": False, "terms_md": ""}),
        json.dumps({"glossary_md": "g2", "adr_candidates": ""}),
    ]
    asyncio.run(s.turn("第二问"))
    cards = {c.id: c for c in s.conversation.cards.all_cards()}
    assert len([c for c in cards.values() if c.id == "spec:tree"]) == 1  # edit 非重复创建
    assert cards["spec:tree"].body == "# 树-v2"
    # 第二轮 TreeUpdate 的 prompt 读到的是手改正文（双通道闭合）
    assert "用户手改的树" in fake_module.calls[3]["prompt"]
    # spec 卡不入 history 转录：手改正文在该 prompt 中恰好出现一次（tree_md 字段处）
    assert fake_module.calls[3]["prompt"].count("用户手改的树") == 1


def test_unknown_category_falls_back_to_direct(tmp_path, fake_module, fake_card_client):
    s = _session(tmp_path, fake_module, fake_card_client)
    s.conversation.set_category("工作")  # 旧装饰值
    a = asyncio.run(s.turn("问"))
    assert s.conversation.nodes[a].text == "mock reply"
    assert "spec:tree" not in [c.id for c in s.conversation.cards.all_cards()]


def test_session_mode_modules_override(tmp_path, fake_module, fake_card_client):
    s = _session(tmp_path, fake_module, fake_card_client)
    s.mode_modules = {}  # 解绑 grilling → 全回落直答
    s.conversation.set_category("grilling")
    a = asyncio.run(s.turn("问"))
    assert s.conversation.nodes[a].text == "mock reply"
