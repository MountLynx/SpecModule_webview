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
    # 让 LLM 失败：轮已落盘（input 有、output 无）
    fake_module.fail = True
    with pytest.raises(RuntimeError):
        asyncio.run(s.turn("问题"))
    assert s.conversation.nodes[2].input == "问题"         # seq1=meta, seq2=轮
    assert s.conversation.nodes[2].output is None
    assert s.conversation.pointer is None
    # 恢复后 retry：回填原轮 output，不重复问题
    fake_module.fail = False
    a = asyncio.run(s.turn_retry(2))
    assert a == 2
    assert s.conversation.pointer == 2
    assert s.conversation.nodes[2].output == "mock reply"
    assert [n.seq for n in s.conversation.nodes.values()].count(2) == 1


def test_turn_happy_path(tmp_path, fake_module, fake_card_client):
    s = _session(tmp_path, fake_module, fake_card_client)
    a = asyncio.run(s.turn("你好"))
    assert a == 2                                          # 返回轮 seq
    assert s.conversation.nodes[a].output == "mock reply"
    assert s.conversation.nodes[a].model == "fake-model"


def test_turn_leaf_no_context(tmp_path, fake_module, fake_card_client):
    s = _session(tmp_path, fake_module, fake_card_client)
    asyncio.run(s.turn("主对话"))
    asyncio.run(s.turn("叶子提问", leaf=True))
    prompt = fake_module.calls[-1]["prompt"]
    assert "叶子提问" in prompt          # brief 原话
    assert "[user]" not in prompt        # 叶子：无 history 转录


def test_branch_segment_fork_turn_included(tmp_path, fake_module, fake_card_client):
    s = _session(tmp_path, fake_module, fake_card_client)
    asyncio.run(s.turn("主干问"))                  # meta=1 → 轮=2（assistant 事件 seq=3）
    conv = s.conversation
    conv.set_pointer(2)                            # 回该轮开分支
    asyncio.run(s.turn("分支问"))                  # 轮=4（assistant 事件 seq=5）
    assert conv.pointer == 4
    assert s.branch_segment() == [2, 4]            # 无分叉（#2 单子）→ 整段路径
    conv.set_pointer(2)
    asyncio.run(s.turn("另一支"))                  # 轮=6 → #2 有两个子轮，成 fork
    assert s.branch_segment() == [2, 6]            # fork 轮 #2 含其自身
    conv.set_pointer(4)
    b = conv.append_user("user fork 下的问题")     # 轮=8, parent=4 → #4 亦成 fork
    conv.append_assistant(b, "答")
    assert s.branch_segment(8) == [2, 4, 8]        # 最近的 fork 是 #2（#4 单子）


def test_pointer_cannot_target_assistant_event_seq(tmp_path, fake_module, fake_card_client):
    """assistant 事件不再产生节点：旧式「回 assistant 节点」指针目标不存在。"""
    s = _session(tmp_path, fake_module, fake_card_client)
    asyncio.run(s.turn("主干问"))                  # 轮=2（assistant 事件 seq=3）
    with pytest.raises(TreeChatError, match="指针目标不存在"):
        s.conversation.set_pointer(3)


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
    assert len(listed) == 1 and listed[0].node_count == 1  # 轮数（assistant 回填不计）


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


def test_list_library_cards_excludes_node_cards(tmp_path, fake_module, fake_card_client, monkeypatch):
    """卡库 = 跨会话复用的全局卡；节点卡（挂轮的文档/提炼版本）不进卡库。"""
    from treechat import llm_bridge
    monkeypatch.setattr(llm_bridge, "create_client", lambda model=None: fake_module)
    config = TreeChatConfig(data_dir=tmp_path)
    s1 = TreeChatSession.create(config.sessions_dir() / "会话一.jsonl", "会话一")
    s1.card_llm = fake_card_client  # 提炼走假卡片客户端（与 _session 助手一致）
    asyncio.run(s1.turn("问"))
    c1 = asyncio.run(s1.make_card("总结"))                       # 全局卡（owner_seq=None）
    a = s1.conversation.pointer
    s1.conversation.add_card("节点卡", "节点正文", from_path=[],
                             owner_seq=a, doc_key="")            # 节点卡（挂轮）
    lib = list_library_cards(config)
    assert [(e.sid, e.card.id) for e in lib] == [("会话一", c1)]  # 节点卡被过滤
    assert all(e.card.owner_seq is None for e in lib)


def test_complete_dispatch_grilling_writes_node_doc_cards(tmp_path, fake_module, fake_card_client):
    s = _session(tmp_path, fake_module, fake_card_client)
    s.conversation.set_category("grilling")
    fake_module.responses = [
        "# 树-v1",
        json.dumps({"questions_md": "❓ Q1", "done": False, "terms_md": ""}),
        json.dumps({"glossary_md": "**Order**: 订单", "adr_candidates": ""}),
    ]
    a = asyncio.run(s.turn("做一个订单系统"))
    tree = s.conversation.cards.get(f"doc:tree@{a}")
    assert tree.owner_seq == a and tree.doc_key == "tree" and tree.body == "# 树-v1"
    assert not s.conversation.cards.is_pinned(f"doc:tree@{a}")
    assert s.conversation.cards.get(f"doc:glossary@{a}").body == "**Order**: 订单"
    assert s.conversation.nodes[a].output == "❓ Q1"


def test_doc_version_edit_feeds_next_turn(tmp_path, fake_module, fake_card_client):
    s = _session(tmp_path, fake_module, fake_card_client)
    s.conversation.set_category("grilling")
    fake_module.responses = [
        "# 树-v1",
        json.dumps({"questions_md": "Q1", "done": False, "terms_md": ""}),
        json.dumps({"glossary_md": "g1", "adr_candidates": ""}),
    ]
    a1 = asyncio.run(s.turn("第一问"))
    # 双通道直填：用户编辑该轮的树版本
    s.conversation.edit_card(f"doc:tree@{a1}", "设计树", "# 用户手改的树")
    fake_module.responses = [
        "# 树-v2",
        json.dumps({"questions_md": "Q2", "done": False, "terms_md": ""}),
        json.dumps({"glossary_md": "g2", "adr_candidates": ""}),
    ]
    a2 = asyncio.run(s.turn("第二问"))
    cards = s.conversation.cards.all_cards()
    assert len([c for c in cards if c.id == f"doc:tree@{a1}"]) == 1  # edit 非重复创建
    assert s.conversation.cards.get(f"doc:tree@{a1}").body == "# 用户手改的树"
    assert s.conversation.cards.get(f"doc:tree@{a2}").body == "# 树-v2"  # 逐轮各一版
    # 第二轮 TreeUpdate 的 prompt 读到的是手改正文（双通道闭合）
    assert "用户手改的树" in fake_module.calls[-3]["prompt"]
    # 树正文不入 history 转录：手改正文在该 prompt 中恰好出现一次（tree_md 字段处）
    assert fake_module.calls[-3]["prompt"].count("用户手改的树") == 1


def test_retry_after_crash_residue_reuses_doc_id(tmp_path, fake_module, fake_card_client):
    """崩溃残留（文档已落、assistant 未落）→ retry 经 edit 分支复用 ID，不撞预检。"""
    s = _session(tmp_path, fake_module, fake_card_client)
    s.conversation.set_category("grilling")
    seq = s.send("第一问")
    # 模拟残留：文档卡已在盘上（模拟进程死于 doc 循环后、append_assistant 前）
    s.conversation.add_card("设计树", "# 残留树", from_path=[], owner_seq=seq,
                            doc_key="tree", card_id=f"doc:tree@{seq}")
    fake_module.responses = [
        "# 树-retry",
        json.dumps({"questions_md": "❓ Q1", "done": False, "terms_md": ""}),
        json.dumps({"glossary_md": "g1", "adr_candidates": ""}),
    ]
    a = asyncio.run(s.turn_retry(seq))  # 不得抛「卡片 id 重复」
    cards = [c for c in s.conversation.cards.all_cards() if c.id == f"doc:tree@{a}"]
    assert len(cards) == 1
    assert cards[0].body == "# 树-retry"
    assert s.conversation.nodes[a].output == "❓ Q1"


def test_done_switches_category_to_direct(tmp_path, fake_module, fake_card_client):
    s = _session(tmp_path, fake_module, fake_card_client)
    s.conversation.set_category("grilling")
    fake_module.responses = [
        "# 树-终",
        json.dumps({"questions_md": "决策汇总", "done": True, "terms_md": ""}),
        json.dumps({"glossary_md": "", "adr_candidates": ""}),
    ]
    asyncio.run(s.turn("最后问"))
    assert s.conversation.category == ""  # 拷问收敛 → 自动退出拷问态（空 = 直答）


def test_send_records_module_and_retry_locks_it(tmp_path, fake_module, fake_card_client):
    """轮上记录模式：grilling 会话里的直答插轮，retry 永远用原轮模式。"""
    from llm import LLMError

    s = _session(tmp_path, fake_module, fake_card_client)
    s.conversation.set_category("grilling")
    seq = s.send("直答插轮", module="direct")
    fake_module.fail = True
    with pytest.raises(LLMError):
        asyncio.run(s.complete(seq))
    fake_module.fail = False
    asyncio.run(s.turn_retry(seq))
    # direct 单节点 prompt 含"请直接回答"；若是 grilling 会是 TreeUpdate 的"设计树"
    assert "请直接回答用户最新消息" in fake_module.calls[-1]["prompt"]
    assert s.conversation.nodes[seq].module == "direct"


def test_send_default_records_empty_module(tmp_path, fake_module, fake_card_client):
    s = _session(tmp_path, fake_module, fake_card_client)
    seq = s.send("普通问")
    assert s.conversation.nodes[seq].module == ""  # 空 = complete 按会话 category 解析


def test_make_card_with_owner(tmp_path, fake_module, fake_card_client):
    s = _session(tmp_path, fake_module, fake_card_client)
    a = asyncio.run(s.turn("主对话"))
    cid = asyncio.run(s.make_card("总结", from_seqs=[a], owner_seq=a))
    c = s.conversation.cards.get(cid)
    assert c.owner_seq == a and not s.conversation.cards.is_pinned(cid)


def test_unknown_category_falls_back_to_direct(tmp_path, fake_module, fake_card_client):
    s = _session(tmp_path, fake_module, fake_card_client)
    s.conversation.set_category("工作")  # 旧装饰值
    a = asyncio.run(s.turn("问"))
    assert s.conversation.nodes[a].output == "mock reply"
    assert "spec:tree" not in [c.id for c in s.conversation.cards.all_cards()]


def test_session_mode_modules_override(tmp_path, fake_module, fake_card_client):
    """mode_modules 覆盖绑定对非内建 category 生效（工作 → grilling）。

    内建 key 直查（identity）：自定义映射解绑不了 grilling/ops——
    解绑语义只对映射表里的非内建 category 有效（spec §4）。
    """
    s = _session(tmp_path, fake_module, fake_card_client)
    s.mode_modules = {"工作": "grilling"}
    s.conversation.set_category("工作")
    fake_module.responses = [
        "# 树-v1",
        json.dumps({"questions_md": "❓ Q1", "done": False, "terms_md": ""}),
        json.dumps({"glossary_md": "**Order**: 订单", "adr_candidates": ""}),
    ]
    a = asyncio.run(s.turn("做一个订单系统"))
    assert s.conversation.nodes[a].output == "❓ Q1"    # 走的是 grilling 管线（非直答）
