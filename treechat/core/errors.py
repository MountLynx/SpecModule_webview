"""TreeChat 异常层级。"""
from __future__ import annotations


class TreeChatError(RuntimeError):
    """TreeChat 基础异常（显式失败，不静默兜底）。"""


class EventFormatError(TreeChatError):
    """事件格式非法（未知类型 / 缺字段 / 多余字段 / 损坏行 / seq 断裂）。"""
