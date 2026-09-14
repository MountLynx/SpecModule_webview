"""会话存储 —— JSONL 追加日志（append + fsync）+ 分级加载。

完整性策略（spec §2.3）：
- 末行 JSON 不完整（崩溃撕裂尾）→ UserWarning 并忽略
- 中间行 JSON 损坏 / 行内容非法（未知类型、缺字段）/ seq 不连续 → EventFormatError 硬报错带行号
"""
from __future__ import annotations

import json
import os
import warnings
from pathlib import Path

from .errors import EventFormatError
from .events import SessionMeta, event_from_dict, event_to_dict


class SessionStore:
    """一个会话的 JSONL 事件文件。进程内顺序追加（V1 单进程，无文件锁）。"""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._last_seq = 0
        self._loaded = False

    def load(self) -> list[tuple[int, object]]:
        """加载并返回全部 (seq, event)。空/缺失文件返回 []。"""
        events: list[tuple[int, object]] = []
        if not self.path.exists():
            self._loaded = True
            return events
        with open(self.path, encoding="utf-8") as f:
            lines = f.readlines()
        total = len(lines)
        for lineno, raw in enumerate(lines, start=1):
            stripped = raw.strip()
            if not stripped:
                continue
            try:
                d = json.loads(stripped)
            except json.JSONDecodeError as exc:
                if lineno == total:
                    warnings.warn(
                        f"会话文件末行不完整（可能为崩溃残留），已忽略: {self.path}",
                        stacklevel=2,
                    )
                    break
                raise EventFormatError(f"第 {lineno} 行 JSON 损坏: {exc}") from exc
            try:
                seq, event = event_from_dict(d)
            except EventFormatError as exc:
                raise EventFormatError(f"第 {lineno} 行事件非法: {exc}") from exc
            expected = events[-1][0] + 1 if events else 1
            if seq != expected:
                raise EventFormatError(f"第 {lineno} 行 seq 不连续：得到 {seq}，期望 {expected}")
            events.append((seq, event))
        self._last_seq = events[-1][0] if events else 0
        self._loaded = True
        return events

    def append(self, event: object) -> int:
        """追加事件（fsync 持久化），返回分配的 seq。父目录不存在则自动创建。"""
        if not self._loaded:
            self.load()
        seq = self._last_seq + 1
        line = json.dumps(event_to_dict(seq, event), ensure_ascii=False)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
            f.flush()
            os.fsync(f.fileno())
        self._last_seq = seq
        return seq


def read_session_meta(path: Path) -> SessionMeta:
    """读首行 session_meta（会话枚举用；不做全文件校验，打开时才全量 load）。"""
    with open(path, encoding="utf-8") as f:
        first = f.readline().strip()
    if not first:
        raise EventFormatError(f"空会话文件: {path}")
    seq, event = event_from_dict(json.loads(first))
    if not isinstance(event, SessionMeta):
        raise EventFormatError(f"首行不是 session_meta: {path}")
    return event
