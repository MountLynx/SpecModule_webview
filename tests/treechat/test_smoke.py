"""脚手架冒烟：包可导入、配置可构造。"""
from treechat.config import TreeChatConfig


def test_import_and_config():
    cfg = TreeChatConfig(data_dir=".")
    assert cfg.sessions_dir().name == "sessions"
