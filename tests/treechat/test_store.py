"""SessionStore：追加/加载/撕裂尾分级/seq 连续性/首行元数据。"""
import json

import pytest

from treechat.core.errors import EventFormatError
from treechat.core.events import Pin, SessionMeta, UserMsg
from treechat.core.store import SessionStore, read_session_meta


def _meta(name="s1"):
    return SessionMeta(name=name, created_at="2026-09-06T00:00:00+00:00", system="")


def test_append_assigns_sequential_seq_and_load_roundtrip(tmp_path):
    store = SessionStore(tmp_path / "s.jsonl")
    s1 = store.append(_meta())
    s2 = store.append(UserMsg(parent=None, text="hi"))
    assert (s1, s2) == (1, 2)
    events = SessionStore(tmp_path / "s.jsonl").load()
    assert [seq for seq, _ in events] == [1, 2]
    assert events[0][1] == _meta()
    assert events[1][1] == UserMsg(parent=None, text="hi")


def test_append_continues_after_reopen(tmp_path):
    p = tmp_path / "s.jsonl"
    SessionStore(p).append(_meta())
    store = SessionStore(p)
    assert store.append(UserMsg(parent=None, text="x")) == 2


def test_torn_tail_last_line_ignored_with_warning(tmp_path):
    p = tmp_path / "s.jsonl"
    p.write_text(json.dumps({"seq": 1, "type": "session_meta", "name": "s",
                             "created_at": "t", "system": ""}) + "\n"
                 + '{"seq":2,"type":"user_msg","par', encoding="utf-8")
    with pytest.warns(UserWarning, match="末行不完整"):
        events = SessionStore(p).load()
    assert len(events) == 1


def test_corrupt_middle_line_hard_error_with_lineno(tmp_path):
    p = tmp_path / "s.jsonl"
    lines = [
        json.dumps({"seq": 1, "type": "session_meta", "name": "s", "created_at": "t", "system": ""}),
        "{not json",
        json.dumps({"seq": 3, "type": "pin", "card_id": "c"}),
    ]
    p.write_text("\n".join(lines) + "\n", encoding="utf-8")
    with pytest.raises(EventFormatError, match="第 2 行"):
        SessionStore(p).load()


def test_wellformed_but_invalid_last_line_still_hard_error(tmp_path):
    p = tmp_path / "s.jsonl"
    lines = [
        json.dumps({"seq": 1, "type": "session_meta", "name": "s", "created_at": "t", "system": ""}),
        json.dumps({"seq": 2, "type": "magic"}),
    ]
    p.write_text("\n".join(lines) + "\n", encoding="utf-8")
    with pytest.raises(EventFormatError, match="未知事件类型"):
        SessionStore(p).load()


def test_seq_gap_hard_error(tmp_path):
    p = tmp_path / "s.jsonl"
    lines = [
        json.dumps({"seq": 1, "type": "session_meta", "name": "s", "created_at": "t", "system": ""}),
        json.dumps({"seq": 3, "type": "pin", "card_id": "c"}),
    ]
    p.write_text("\n".join(lines) + "\n", encoding="utf-8")
    with pytest.raises(EventFormatError, match="seq 不连续"):
        SessionStore(p).load()


def test_read_session_meta(tmp_path):
    p = tmp_path / "s.jsonl"
    SessionStore(p).append(_meta(name="会话甲"))
    assert read_session_meta(p).name == "会话甲"


def test_read_session_meta_rejects_non_meta_first_line(tmp_path):
    p = tmp_path / "s.jsonl"
    p.write_text(json.dumps({"seq": 1, "type": "pin", "card_id": "c"}) + "\n", encoding="utf-8")
    with pytest.raises(EventFormatError, match="首行不是 session_meta"):
        read_session_meta(p)


def test_load_empty_and_missing_file(tmp_path):
    assert SessionStore(tmp_path / "nope.jsonl").load() == []
