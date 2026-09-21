"""事件模型：roundtrip + 校验（必填字段严格校验；有默认值字段允许缺席，旧文件兼容）。"""
import pytest

from treechat.core.errors import EventFormatError
from treechat.core.events import (
    AssistantMsg, CardCreate, CardDelete, CardEdit, NodeRename, Pin,
    SessionArchive, SessionCategory, SessionMeta, SessionRename, SystemUpdate,
    Unpin, UserMsg, event_from_dict, event_to_dict,
)


def test_roundtrip_all_types():
    cases = [
        SessionMeta(name="n1", created_at="2026-09-06T00:00:00+00:00", system="s"),
        UserMsg(parent=None, text="hi"),
        UserMsg(parent=2, text="branch"),
        AssistantMsg(parent=2, text="ok", model="m1", usage={"input_tokens": 1}),
        SystemUpdate(text="new rules"),
        CardCreate(card_id="card_ab12", title="t", body="b", from_path=[1, 2], instruction="i"),
        Pin(card_id="card_ab12"),
        Unpin(card_id="card_ab12"),
        CardEdit(card_id="card_ab12", title="新标题", body="新正文"),
        CardDelete(card_id="card_ab12"),
        SessionRename(name="新名"),
        SessionCategory(category="工作"),
        SessionArchive(archived=True),
        NodeRename(node=3, label="关键节点"),
    ]
    for ev in cases:
        d = event_to_dict(seq=7, event=ev)
        assert d["seq"] == 7
        seq, back = event_from_dict(d)
        assert seq == 7
        assert back == ev


def test_unknown_type_rejected():
    with pytest.raises(EventFormatError, match="未知事件类型"):
        event_from_dict({"seq": 1, "type": "magic"})


def test_missing_field_rejected():
    with pytest.raises(EventFormatError, match="缺字段"):
        event_from_dict({"seq": 1, "type": "user_msg", "parent": None})


def test_extra_field_rejected():
    with pytest.raises(EventFormatError, match="多余字段"):
        event_from_dict({"seq": 1, "type": "pin", "card_id": "c", "junk": 1})


def test_missing_seq_or_type_rejected():
    with pytest.raises(EventFormatError):
        event_from_dict({"type": "pin", "card_id": "c"})


def test_old_card_create_without_optional_fields_loads():
    """旧格式 card_create（无 owner_seq/doc_key）→ 缺省全局卡，重放零迁移。"""
    seq, ev = event_from_dict({
        "seq": 5, "type": "card_create", "card_id": "card_a", "title": "t",
        "body": "b", "from_path": [2],
    })
    assert seq == 5
    assert ev.owner_seq is None and ev.doc_key == ""


def test_old_user_msg_without_module_loads():
    seq, ev = event_from_dict({"seq": 2, "type": "user_msg", "parent": None, "text": "问"})
    assert ev.module == ""


def test_card_create_owner_fields_roundtrip():
    ev = CardCreate(card_id="doc:tree@2", title="设计树", body="# 树", from_path=[],
                    owner_seq=2, doc_key="tree")
    d = event_to_dict(seq=9, event=ev)
    assert d["owner_seq"] == 2 and d["doc_key"] == "tree"
    seq, back = event_from_dict(d)
    assert back == ev


def test_user_msg_module_roundtrip():
    ev = UserMsg(parent=None, text="问", module="grilling")
    _seq, back = event_from_dict(event_to_dict(seq=3, event=ev))
    assert back == ev


def test_old_assistant_msg_without_usage_loads():
    seq, ev = event_from_dict({"seq": 4, "type": "assistant_msg", "parent": 2, "text": "ok"})
    assert ev.usage == {}
