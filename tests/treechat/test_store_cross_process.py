"""SessionStore 跨进程文件锁：并发 append 后 seq 连续（issue #16）。

无锁时两个进程各自 load→last=0→seq=1 必撞车（EventFormatError seq 不连续）；
filelock 串行化后 2×N 事件全量可读。
"""

from __future__ import annotations

import subprocess
import sys
import textwrap
from pathlib import Path

from treechat.core.store import SessionStore

_WRITER = textwrap.dedent("""
    import sys
    from pathlib import Path
    sys.path.insert(0, sys.argv[3])
    from treechat.core.store import SessionStore
    from treechat.core.events import UserMsg
    store = SessionStore(Path(sys.argv[1]))
    for i in range(20):
        store.append(UserMsg(parent=None, text=f"{sys.argv[2]}-{i}"))
""")

_REPO = Path(__file__).resolve().parents[2]


def _spawn_writer(repo: Path, path: Path, tag: str) -> subprocess.Popen:
    """子进程写手：repo 根注入 sys.path（venv 内 treechat 本可导入，显式更稳）。"""
    return subprocess.Popen([sys.executable, "-c", _WRITER, str(path), tag, str(repo)])


def test_concurrent_appends_stay_continuous(tmp_path):
    path = tmp_path / "s.jsonl"
    procs = [_spawn_writer(_REPO, path, tag) for tag in ("a", "b")]
    for p in procs:
        assert p.wait(timeout=30) == 0
    store = SessionStore(path)
    events = store.load()
    assert [seq for seq, _ in events] == list(range(1, 41))  # 连续 1..40，无重复无撕裂
