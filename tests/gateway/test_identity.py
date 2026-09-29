"""认领身份层：规范化 / registry 读写 / 令牌认领与找回 / 移除。"""

from __future__ import annotations

import pytest

from server.gateway.identity import (
    InvalidNameError,
    NameTakenError,
    Registry,
    dir_for,
    normalize_name,
    token_matches,
)


class TestNormalize:
    def test_cjk_and_case(self):
        assert normalize_name("  评委甲 ") == "评委甲"
        assert normalize_name("Alice") == "alice"

    def test_rejects(self):
        for bad in ["", "a", "x" * 33, "有 空格", "a/b", ".."]:
            with pytest.raises(InvalidNameError):
                normalize_name(bad)


def test_dir_hash_stable_and_short():
    assert dir_for("评委甲") == dir_for("评委甲")
    assert len(dir_for("评委甲")) == 16
    assert "/" not in dir_for("评委甲") and "\\" not in dir_for("评委甲")


class TestClaim:
    def test_new_allocates_port_and_dirs(self, gw_root):
        reg = Registry(gw_root, port_base=8101)
        entry, token = reg.claim(normalize_name("评委甲"))
        assert entry.port == 8101
        assert entry.dir == dir_for("评委甲")
        assert len(token) >= 32
        assert (gw_root / "users" / entry.dir / ".specmodule" / "runs").is_dir()
        assert token_matches(entry, token) and not token_matches(entry, "wrong")

    def test_port_increments(self, gw_root):
        reg = Registry(gw_root)
        e1, _ = reg.claim("a1")
        e2, _ = reg.claim("b2")
        assert (e1.port, e2.port) == (8101, 8102)

    def test_recover_with_matching_token(self, gw_root):
        reg = Registry(gw_root)
        e1, token = reg.claim("tester")
        e2, token2 = reg.claim("tester", token)
        assert (e2.dir, e2.port, token2) == (e1.dir, e1.port, token)

    def test_name_taken_on_mismatch_or_absent(self, gw_root):
        reg = Registry(gw_root)
        reg.claim("tester")
        with pytest.raises(NameTakenError):
            reg.claim("tester")
        with pytest.raises(NameTakenError):
            reg.claim("tester", "wrong-token")

    def test_display_keeps_raw(self, gw_root):
        reg = Registry(gw_root)
        entry, _ = reg.claim("tester", display="Tester 甲")
        assert entry.name == "tester" and entry.display == "Tester 甲"


class TestPersistence:
    def test_survives_new_instance(self, gw_root):
        reg = Registry(gw_root)
        e1, token = reg.claim("persist")
        reg2 = Registry(gw_root)
        e2 = reg2.get("persist")
        assert e2 is not None and e2.dir == e1.dir
        assert token_matches(e2, token)
        raw_text = (gw_root / "registry.json").read_text(encoding="utf-8")
        assert token not in raw_text  # 明文令牌不落盘（只存 SHA-256）

    def test_provision_seeds_shared_library(self, gw_root):
        shared = gw_root / "shared" / "library"
        shared.mkdir(parents=True)
        (shared / "h.json").write_text("{}", encoding="utf-8")
        reg = Registry(gw_root)
        entry, _ = reg.claim("seeder")
        assert (gw_root / "users" / entry.dir / ".specmodule" / "library" / "h.json").is_file()


class TestRemove:
    def test_remove_keeps_data_by_default(self, gw_root):
        reg = Registry(gw_root)
        entry, _ = reg.claim("gone")
        assert reg.remove("gone") is True
        assert reg.get("gone") is None
        assert (gw_root / "users" / entry.dir).is_dir()

    def test_purge_removes_data(self, gw_root):
        reg = Registry(gw_root)
        entry, _ = reg.claim("gone")
        assert reg.remove("gone", purge=True) is True
        assert not (gw_root / "users" / entry.dir).exists()

    def test_remove_missing(self, gw_root):
        assert Registry(gw_root).remove("nobody") is False
