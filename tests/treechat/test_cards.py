"""CardRegistry：默认 pinned、pin/unpin、未知 id 显式报错。"""
import pytest

from treechat.core.cards import Card, CardRegistry
from treechat.core.errors import TreeChatError


def _card(cid="card_0001", title="t", body="b"):
    return Card(id=cid, title=title, body=body, from_path=[1], instruction="")


def test_add_defaults_pinned():
    reg = CardRegistry()
    reg.add(_card())
    assert [c.id for c in reg.pinned_cards()] == ["card_0001"]


def test_add_opt_out_pin_and_repin():
    reg = CardRegistry()
    reg.add(_card(), pinned=False)
    assert reg.pinned_cards() == []
    reg.pin("card_0001")
    assert len(reg.pinned_cards()) == 1
    reg.unpin("card_0001")
    assert reg.pinned_cards() == []


def test_unknown_id_raises():
    reg = CardRegistry()
    with pytest.raises(TreeChatError, match="未知卡片"):
        reg.pin("card_nope")
    with pytest.raises(TreeChatError, match="未知卡片"):
        reg.get("card_nope")


def test_duplicate_id_raises():
    reg = CardRegistry()
    reg.add(_card())
    with pytest.raises(TreeChatError, match="重复"):
        reg.add(_card())


def test_update_replaces_title_and_body():
    reg = CardRegistry()
    reg.add(_card())
    reg.update("card_0001", "新标题", "新正文")
    card = reg.get("card_0001")
    assert card.title == "新标题" and card.body == "新正文"
    assert card.from_path == [1]  # 其余字段不动


def test_remove_deletes_and_unpins():
    reg = CardRegistry()
    reg.add(_card())  # 默认 pinned
    removed = reg.remove("card_0001")
    assert removed.id == "card_0001"
    assert reg.all_cards() == [] and reg.pinned_cards() == []
    with pytest.raises(TreeChatError, match="未知卡片"):
        reg.get("card_0001")


def test_update_and_remove_unknown_raise():
    reg = CardRegistry()
    with pytest.raises(TreeChatError, match="未知卡片"):
        reg.update("card_nope", "t", "b")
    with pytest.raises(TreeChatError, match="未知卡片"):
        reg.remove("card_nope")
