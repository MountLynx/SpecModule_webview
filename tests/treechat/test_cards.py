"""CardRegistry：默认 pinned、pin/unpin、未知 id 显式报错。"""
import pytest

from treechat.core.cards import Card, CardRegistry, doc_card_id
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


def test_node_card_pin_rejected():
    reg = CardRegistry()
    reg.add(Card(id="doc:tree@2", title="设计树", body="# 树",
                 owner_seq=2, doc_key="tree"), pinned=False)
    with pytest.raises(TreeChatError, match="节点卡不支持 pin"):
        reg.pin("doc:tree@2")
    assert reg.pinned_cards() == []


def test_node_card_unpin_rejected():
    """unpin 对节点卡与 pin 对称：显式拒绝而非静默 no-op。"""
    reg = CardRegistry()
    reg.add(Card(id="doc:tree@2", title="设计树", body="# 树",
                 owner_seq=2, doc_key="tree"), pinned=False)
    with pytest.raises(TreeChatError, match="节点卡不支持 unpin"):
        reg.unpin("doc:tree@2")


def test_registry_add_node_card_ignores_pinned_true():
    reg = CardRegistry()
    reg.add(Card(id="doc:tree@2", title="t", body="b", owner_seq=2), pinned=True)
    assert reg.pinned_cards() == []


def test_doc_card_id_deterministic():
    assert doc_card_id("tree", 12) == "doc:tree@12"
    assert doc_card_id("glossary", 3) == "doc:glossary@3"


def test_card_is_node_property():
    assert Card(id="doc:tree@2", title="t", body="b", owner_seq=2).is_node
    assert not Card(id="card_x", title="t", body="b").is_node
