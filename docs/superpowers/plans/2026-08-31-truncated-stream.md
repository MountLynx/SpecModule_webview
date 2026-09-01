# truncated 终态 + stream.log 流式落盘 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** max_ticks 截断产出真实终态 phase `truncated`；LLM 流式输出经 EventBus 订阅落盘 `stream.log`（JSONL），webview 据此实现节点流式显示与终态化截断处理。

**Architecture:** 库侧先行（`../SpecModule` 三个独立 commit：truncated phase → stream.py writer + Module 内置订阅接线 → query.read_stream 共享读端），webview 随后薄适配（ws.py 追尾推送 + 前端类型/流缓冲/NodePanel 实时区）。数据生产全在库侧，消费端零业务逻辑（统一 API 原则）。

**Tech Stack:** Python 3.10+ / pytest / FastAPI TestClient（webview）；React + TS + Vite（web/，`tsc --noEmit` 为门禁）。库仓库 editable install（`pip install -e ../SpecModule`），webview 测试自动用到新库代码，无需重装。

**Spec:** `docs/superpowers/specs/2026-08-31-truncated-stream-design.md`（本计划的任务边界以它为准）

**约定（全计划通用）**
- 库仓库路径 `C:\Users\xingy\Desktop\开发\SpecModule`（下称 `Lib`），webview 仓库 `C:\Users\xingy\Desktop\开发\SpecModule_webview`。库改动在 Lib 仓库**独立提交**（遵循其 AGENTS.md：中文 docstring、`from __future__ import annotations` 首行、显式 `__all__`、api.md 同步补录）。
- 生态无 formatter/linter，不引入；测试只 pytest。
- 每个任务先跑测试看到失败再实现（TDD），提交信息用中文 `feat:`/`docs:` 前缀。

---

### Task 1: 库侧——max_ticks 截断终态 `truncated`

**Files:**
- Modify: `Lib/module_harness/module.py`（`_finalize_phase` 391-403 行、调用点 373 行、`_write_phase` docstring 131-133 行）
- Modify: `Lib/module_harness/status.py:28`（phase 注释）
- Modify: `Lib/module_harness/tests/test_run_status.py`（翻转 325-343 行测试 + 新增续跑测试）
- Modify: `Lib/docs/references/api.md`（48-49 行 phase 枚举 + 执行段落）

- [x] **Step 1: 翻转现有截断测试（先改测试）**

`Lib/module_harness/tests/test_run_status.py` 中 `test_max_ticks_cutoff_not_done`（325-343 行）整体替换为：

```python
    @pytest.mark.asyncio
    async def test_max_ticks_cutoff_truncated(self, tmp_path, monkeypatch, mock_llm):
        """max_ticks 截断（status 仍 RUNNING）→ 终态 phase=truncated，error 带上限。"""

        def echo(view):
            return {"ok": True}

        mod = self._make_module(
            mock_llm, tmp_path, monkeypatch,
            registry=self._script_reg(mock_llm, echo=echo),
            tasklist=Tasklist(
                tasks={"A": TaskDefinition(type="script", script="echo")},
                flow="[A]",
            ),
        )
        # 单节点 + max_ticks=1：tick 0 跑 A 后 tick_count=1 >= max_ticks，
        # run_until_idle 退出但 status 仍 RUNNING → 截断终态（可 resume 续跑）
        await mod.run(max_ticks=1)
        st = self._read_status(tmp_path)
        assert st["phase"] == "truncated"
        assert "max_ticks=1" in st["error"]
```

同类末尾（`test_max_ticks_cutoff_truncated` 之后）新增续跑测试：

```python
    @pytest.mark.asyncio
    async def test_truncated_then_resume_done(self, tmp_path, monkeypatch, mock_llm):
        """truncated 是可恢复终态：截断 → 新 Module resume 续跑 → done。"""

        def echo(view):
            return {"ok": True}

        tasklist = Tasklist(
            tasks={"A": TaskDefinition(type="script", script="echo")},
            flow="[A]",
        )
        mod = self._make_module(
            mock_llm, tmp_path, monkeypatch,
            registry=self._script_reg(mock_llm, echo=echo),
            tasklist=tasklist,
        )
        await mod.run(max_ticks=1)
        assert self._read_status(tmp_path)["phase"] == "truncated"

        mod2 = self._make_module(
            mock_llm, tmp_path, monkeypatch,
            registry=self._script_reg(mock_llm, echo=echo),
            tasklist=tasklist,
        )
        await mod2.resume()
        assert self._read_status(tmp_path)["phase"] == "done"
```

- [x] **Step 2: 跑测试确认失败**

```bash
cd "C:\Users\xingy\Desktop\开发\SpecModule"
python -m pytest module_harness/tests/test_run_status.py -q
```

预期：`test_max_ticks_cutoff_truncated` FAIL（实际 phase == "running"）；`test_truncated_then_resume_done` FAIL。

- [x] **Step 3: 实现 truncated 映射**

`Lib/module_harness/module.py` 三处：

(a) `_finalize_phase`（391-403 行）整段替换（签名加 `max_ticks`）：

```python
    def _finalize_phase(self, runner: AsyncRunner, max_ticks: int) -> None:
        """按 runner.status 映射终态 phase（run/resume 共用）。"""
        from tickflow.runner import RunStatus
        if runner.status == RunStatus.ABORTED:
            self._write_phase("aborted", error=runner.cancel_reason or "aborted")
        elif runner.status == RunStatus.CANCELLED:
            self._write_phase("cancelled", error=runner.cancel_reason or "cancelled")
        elif runner.status == RunStatus.FAILED:
            self._write_phase("aborted", error="all nodes failed")
        elif runner.status == RunStatus.RUNNING:
            # max_ticks 耗尽（pause 挂起发生在 run_until_idle 内部不返回，
            # RUNNING 是唯一来源）→ 真终态：监控方拿到可 resume 的确定性信号
            self._write_phase(
                "truncated", error=f"max_ticks={max_ticks} 截断（可 resume 续跑）"
            )
        else:
            self._write_phase("done")
```

(b) `_run_with_phases` 内调用点（原 373 行 `self._finalize_phase(runner)`）改为：

```python
                self._finalize_phase(runner, max_ticks)
```

(c) `_write_phase` docstring 中 phase 取值一行（原 132 行）替换为：

```python
        phase 取值：idle/translating/reviewing/building/ready/running/
        done/aborted/cancelled/truncated。status_file=False 时不写盘（零残留）。
```

`Lib/module_harness/status.py:28` 注释改为：

```python
    phase: str                 # idle/translating/reviewing/building/ready/running/done/aborted/cancelled/truncated
```

- [x] **Step 4: 跑测试确认通过**

```bash
python -m pytest module_harness/tests/test_run_status.py -q
python -m pytest module_harness/tests/ -q -m "not smoke"
```

预期：全部 PASS（基线全绿，确认无其他测试依赖旧行为）。

- [x] **Step 5: api.md 补录**

`Lib/docs/references/api.md`：

(a) 48-50 行 `ModuleStatus` 字段描述中 phase 枚举改为：

```
`phase`（`idle → translating → reviewing → building → ready →
running → done | aborted | cancelled | truncated`）
```

(b) 「## Module 运行」节执行段落（约 131-136 行），在 "`max_ticks` 是唯一运行上限（每次 LLM 调用超时 60s）" 之后插入一句：

```markdown
`max_ticks` 耗尽 → phase 落 **`truncated`**（终态，`error` 记 `max_ticks=N 截断（可 resume 续跑）`）——
监控方拿到可续跑的确定性信号，无需静默启发式。
```

- [x] **Step 6: 提交（Lib 仓库）**

```bash
cd "C:\Users\xingy\Desktop\开发\SpecModule"
git add module_harness/module.py module_harness/status.py module_harness/tests/test_run_status.py docs/references/api.md
git commit -m "feat: max_ticks 截断终态 truncated——监控方拿到可续跑确定性信号"
```

---

### Task 2: 库侧——stream.py writer + Module 内置接线（stream_log）

**Files:**
- Create: `Lib/module_harness/stream.py`
- Modify: `Lib/module_harness/module.py`（imports 23 行、`__init__` 签名 77 行附近 + 属性、`_run_with_phases` 355-374 行、新增 `_open_stream_log`/`_close_stream_log`/`_on_stream_event`）
- Test: `Lib/module_harness/tests/test_stream_log.py`（新建）

- [x] **Step 1: 写失败测试**

新建 `Lib/module_harness/tests/test_stream_log.py`：

```python
# module_harness/tests/test_stream_log.py
"""stream.log 流式落盘：writer 记录形状 + Module 内置接线（默认开）。"""

from __future__ import annotations

import json
import os

import pytest

from llm.client import LLMError, LLMResponse
from module_harness.config import HarnessConfig
from module_harness.events import EventBus
from module_harness.module import Module
from module_harness.registry import HarnessRegistry
from module_harness.spec import TaskDefinition, Tasklist
from module_harness.stream import StreamLogWriter, stream_log_path


def _read_records(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


class TestStreamLogWriter:
    def test_record_shape_and_order(self, tmp_path):
        w = StreamLogWriter(tmp_path / "d" / "stream.log")   # 目录不存在 → 懒建
        w.write({"type": "run_start", "pid": 123, "max_ticks": 100})
        w.write({"type": "token", "node": "A", "chunk": "你"})
        w.write({"type": "token", "node": "A", "chunk": "好"})
        w.close()
        w.close()   # 幂等
        recs = _read_records(tmp_path / "d" / "stream.log")
        assert [r["type"] for r in recs] == ["run_start", "token", "token"]
        assert recs[0]["pid"] == 123 and recs[0]["max_ticks"] == 100
        assert "".join(r["chunk"] for r in recs[1:]) == "你好"
        assert all(isinstance(r["ts"], float) and r["ts"] > 0 for r in recs)

    def test_event_records(self, tmp_path):
        w = StreamLogWriter(tmp_path / "stream.log")
        w.write({"type": "call_start", "node": "A", "model": "m", "prompt_chars": 3})
        w.write({"type": "call_end", "node": "A", "content_chars": 5, "finish_reason": "end_turn"})
        w.write({"type": "call_error", "node": "A", "reason": "boom", "failure_type": "infrastructure"})
        w.close()
        recs = _read_records(tmp_path / "stream.log")
        assert [r["type"] for r in recs] == ["call_start", "call_end", "call_error"]
        assert recs[2]["failure_type"] == "infrastructure"

    def test_write_failure_logged_not_raised(self, tmp_path, caplog):
        # 父路径是文件 → open 必败；写失败仅 log 不抛（观测不阻断运行）
        (tmp_path / "f").write_text("x", encoding="utf-8")
        w = StreamLogWriter(tmp_path / "f" / "s.log")
        w.write({"type": "run_start", "pid": 1, "max_ticks": 1})
        w.close()


class _StreamingLLM:
    """流式 fake：先经 on_token 发 chunk 再返回（走 harness 流式通道）。"""

    def __init__(self, chunks):
        self._chunks = chunks

    async def complete(self, *, prompt, on_token=None, **kw):
        for c in self._chunks:
            on_token(c)
        return LLMResponse(content='{"ok": true}')


class _ErrorLLM:
    async def complete(self, *, prompt, on_token=None, **kw):
        raise LLMError("连接超时")


def _harness_module(llm, tmp_path, monkeypatch, module_id="mod_stream", **kw):
    monkeypatch.chdir(tmp_path)
    reg = HarnessRegistry(llm_client=llm, event_bus=EventBus())
    reg.harness("probe", HarnessConfig(prompt_core="x={spec}"))
    return Module(
        spec={"x": 1},
        tasklist=Tasklist(
            tasks={"A": TaskDefinition(type="harness", harness="probe",
                                       inputs={"spec": "{spec}"})},
            flow="[A]",
        ),
        llm_client=llm,
        registry=reg,
        review_harness=None,
        module_id=module_id,
        **kw,
    )


class TestModuleWiring:
    @pytest.mark.asyncio
    async def test_full_chain_records(self, tmp_path, monkeypatch):
        llm = _StreamingLLM(["你", "好"])
        mod = _harness_module(llm, tmp_path, monkeypatch)
        await mod.run()
        recs = _read_records(stream_log_path("mod_stream", tmp_path))
        types = [r["type"] for r in recs]
        assert types[0] == "run_start"
        assert types.count("run_start") == 1
        assert recs[0]["max_ticks"] == 100 and recs[0]["pid"] == os.getpid()
        assert {"call_start", "token", "call_end"} <= set(types)
        tokens = [r for r in recs if r["type"] == "token"]
        assert "".join(t["chunk"] for t in tokens) == "你好"
        end = next(r for r in recs if r["type"] == "call_end")
        assert end["node"] == "A"
        assert end["content_chars"] == len('{"ok": true}')

    @pytest.mark.asyncio
    async def test_llm_error_writes_call_error(self, tmp_path, monkeypatch):
        # LLMError 在 harness body 内被捕获 → Failure(infrastructure) → 引擎
        # ABORTED → run() 正常返回（不抛），phase 落 aborted
        mod = _harness_module(_ErrorLLM(), tmp_path, monkeypatch)
        await mod.run()
        st = json.loads(
            (tmp_path / ".specmodule" / "runs" / "mod_stream" / "status.json")
            .read_text(encoding="utf-8")
        )
        assert st["phase"] == "aborted"
        recs = _read_records(stream_log_path("mod_stream", tmp_path))
        err = next(r for r in recs if r["type"] == "call_error")
        assert err["reason"] == "连接超时"
        assert err["failure_type"] == "infrastructure"

    @pytest.mark.asyncio
    async def test_stream_log_disabled(self, tmp_path, monkeypatch):
        mod = _harness_module(_StreamingLLM(["a"]), tmp_path, monkeypatch,
                              stream_log=False)
        await mod.run()
        assert not stream_log_path("mod_stream", tmp_path).exists()

    @pytest.mark.asyncio
    async def test_two_executions_append(self, tmp_path, monkeypatch):
        llm = _StreamingLLM(["x"])
        mod = _harness_module(llm, tmp_path, monkeypatch)
        await mod.run(max_ticks=1)
        mod2 = _harness_module(llm, tmp_path, monkeypatch)
        await mod2.resume()
        recs = _read_records(stream_log_path("mod_stream", tmp_path))
        starts = [r for r in recs if r["type"] == "run_start"]
        assert len(starts) == 2
        assert starts[0]["max_ticks"] == 1 and starts[1]["max_ticks"] == 100

    @pytest.mark.asyncio
    async def test_writer_detached_on_exception(self, tmp_path, monkeypatch):
        class _BoomLLM:
            async def complete(self, *, prompt, on_token=None, **kw):
                raise RuntimeError("boom")

        mod = _harness_module(_BoomLLM(), tmp_path, monkeypatch)
        with pytest.raises(RuntimeError):
            await mod.run()
        # finally 已摘当前 writer；已落盘记录完整可读
        assert mod._stream_writer is None
        recs = _read_records(stream_log_path("mod_stream", tmp_path))
        assert recs[0]["type"] == "run_start"
```

- [x] **Step 2: 跑测试确认失败**

```bash
cd "C:\Users\xingy\Desktop\开发\SpecModule"
python -m pytest module_harness/tests/test_stream_log.py -q
```

预期：全部 FAIL（`ModuleNotFoundError: module_harness.stream` / `Module` 无 `stream_log` 参数）。

- [x] **Step 3: 实现 stream.py**

新建 `Lib/module_harness/stream.py`：

```python
# module_harness/stream.py
"""LLM 流式输出落盘——stream.log（跨进程流式观测通道）。

Harness 每个LLM chunk 经 EventBus 发 ``LlmToken``，但 EventBus 是进程内的——
独立消费进程（Web/TUI）看不到。本模块把流式事件序列化为 JSONL 追加写
``.specmodule/runs/<run_id>/stream.log``（与 status.json/run.sqlite 同目录），
跨进程可读。写失败仅 log 不抛（观测不阻断运行，同 _write_phase 哲学）。

记录格式（``ts`` 由写入方统一打 wall-clock——harness 事件的 timestamp 是
``time.monotonic()``，进程本地时钟，不落盘、不跨进程比较）::

    {"type": "run_start",  "ts", "pid", "max_ticks"}
    {"type": "call_start", "ts", "node", "model", "prompt_chars"}
    {"type": "token",      "ts", "node", "chunk"}
    {"type": "call_end",   "ts", "node", "content_chars", "finish_reason"}
    {"type": "call_error", "ts", "node", "reason", "failure_type"}

append-only：每次执行以 ``run_start`` 开边界，不截断旧执行（崩溃残留可事后
查看）。不带 tick 字段——harness 事件恒为 tick=0，落盘假数据不如不写。
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

__all__ = ["StreamLogWriter", "stream_log_path"]


def stream_log_path(module_id: str, base_dir: Path | None = None) -> Path:
    """``<base_dir>/.specmodule/runs/<module_id>/stream.log``。"""
    return (base_dir or Path.cwd()) / ".specmodule" / "runs" / module_id / "stream.log"


class StreamLogWriter:
    """stream.log 追加写器：懒开句柄、逐记录 flush（无 fsync）、close 幂等。"""

    def __init__(self, path: Path) -> None:
        self._path = path
        self._fh: Any = None

    def write(self, record: dict[str, Any]) -> None:
        """单条 JSONL 记录落盘（ts 在此统一打 wall-clock）。失败仅 log。"""
        record = {"ts": time.time(), **record}
        try:
            if self._fh is None:
                self._path.parent.mkdir(parents=True, exist_ok=True)
                self._fh = self._path.open("a", encoding="utf-8")
            self._fh.write(json.dumps(record, ensure_ascii=False) + "\n")
            self._fh.flush()
        except OSError:
            log.exception("写 stream.log 失败（不阻断运行）: %s", self._path)

    def close(self) -> None:
        if self._fh is not None:
            try:
                self._fh.close()
            except OSError:
                log.exception("关闭 stream.log 失败: %s", self._path)
            self._fh = None
```

- [x] **Step 4: Module 接线**

`Lib/module_harness/module.py` 五处：

(a) imports（23 行）扩展：

```python
from .events import (
    EventBus,
    ConsistencyReviewed,
    HarnessFailed,
    LlmCallCompleted,
    LlmCallStarted,
    LlmToken,
)
```

同区新增（32 行 `from .control import ...` 之后）：

```python
from .stream import StreamLogWriter, stream_log_path
```

(b) `__init__` 签名（77 行 `control: bool = True,` 之后）加参数：

```python
        # True（默认）：LLM 流式输出落盘 stream.log（跨进程流式观测，见
        # stream.py）。EventBus.null() 场景只有 run_start 记录（事件被
        # null bus 吞掉，属预期）。
        stream_log: bool = True,
```

`__init__` 体（96 行 `self.control = control` 之后）加属性：

```python
        self.stream_log = stream_log
        # stream.log 接线状态：订阅只挂一次（防多次执行重复订阅记录翻倍）；
        # writer 每次执行重建（_run_with_phases 生命周期），事件回调读当前属性
        self._stream_subscribed = False
        self._stream_writer: StreamLogWriter | None = None
```

(c) `_run_with_phases`（355-374 行）整段替换：

```python
    async def _run_with_phases(self, runner: AsyncRunner, max_ticks: int) -> list:
        """归档本次输入 → 运行 → 按结果映射终态 phase（run/resume 共用）。"""
        if self.control:
            # 新执行清场：作废陈旧控制请求（崩溃残留的 pause 不拖住新执行）。
            # 位于写 running phase 之前——监控方看到 running 才放开控制按钮，
            # 此时清场已完成，清场与首请求的竞态窗口关闭。
            clear_control(self.module_id, base_dir=self._base_dir)
        writer = self._open_stream_log(max_ticks)
        try:
            self._archive_module_inputs()
            self._write_phase("running")
            try:
                firings = await runner.run_until_idle(max_ticks=max_ticks)
            except asyncio.CancelledError:
                self._write_phase("cancelled", error="cancelled")
                raise
            except Exception as e:
                self._write_phase("aborted", error=str(e))
                raise
            else:
                self._finalize_phase(runner, max_ticks)
            return firings
        finally:
            self._close_stream_log(writer)

    def _open_stream_log(self, max_ticks: int) -> StreamLogWriter | None:
        """stream_log=True 时开本次执行的 writer 并写 run_start 边界。

        run_start 先于 running phase 写入——监控方见到 running 时锚点记录
        必已存在（status.json 原子写在同一执行线程、顺序在后）。事件订阅
        只挂一次（守卫 flag），回调经 Module 当前 writer 属性落盘。
        """
        if not self.stream_log:
            return None
        if not self._stream_subscribed:
            bus = self._reg._event_bus
            for evt in (LlmCallStarted, LlmToken, LlmCallCompleted, HarnessFailed):
                bus.subscribe(evt, self._on_stream_event)
            self._stream_subscribed = True
        writer = StreamLogWriter(stream_log_path(self.module_id, self._base_dir))
        self._stream_writer = writer
        writer.write({"type": "run_start", "pid": os.getpid(), "max_ticks": max_ticks})
        return writer

    def _close_stream_log(self, writer: StreamLogWriter | None) -> None:
        """执行结束（含异常路径）摘除当前 writer 并关闭。"""
        self._stream_writer = None
        if writer is not None:
            writer.close()

    def _on_stream_event(self, event: Any) -> None:
        """EventBus → stream.log 记录（四类事件 → 四种记录，见 stream.py）。"""
        w = self._stream_writer
        if w is None:
            return
        if isinstance(event, LlmCallStarted):
            w.write({"type": "call_start", "node": event.node,
                     "model": event.model, "prompt_chars": event.prompt_chars})
        elif isinstance(event, LlmToken):
            w.write({"type": "token", "node": event.node, "chunk": event.chunk})
        elif isinstance(event, LlmCallCompleted):
            w.write({"type": "call_end", "node": event.node,
                     "content_chars": event.content_chars,
                     "finish_reason": event.finish_reason})
        elif isinstance(event, HarnessFailed):
            w.write({"type": "call_error", "node": event.node,
                     "reason": event.reason, "failure_type": event.failure_type})
```

- [x] **Step 5: 跑测试确认通过**

```bash
python -m pytest module_harness/tests/test_stream_log.py module_harness/tests/test_run_status.py -q
python -m pytest module_harness/tests/ -q -m "not smoke"
```

预期：全绿（含库基线——`stream_log` 默认开不破坏既有测试；`EventBus.null()` 场景只多 `run_start` 落盘）。

- [x] **Step 6: 提交（Lib 仓库）**

```bash
cd "C:\Users\xingy\Desktop\开发\SpecModule"
git add module_harness/stream.py module_harness/module.py module_harness/tests/test_stream_log.py
git commit -m "feat: LLM 流式落盘 stream.log——Module 内置订阅，跨进程流式观测"
```

---

### Task 3: 库侧——query.read_stream 共享读端 + api.md 补录

**Files:**
- Modify: `Lib/module_harness/query.py`（新增 `read_stream`；imports 11-14 行加 json）
- Test: `Lib/module_harness/tests/test_stream_log.py`（追加 TestReadStream 类）
- Modify: `Lib/docs/references/api.md`（query 表 + Module 构造块 + stream.log 说明）

- [x] **Step 1: 写失败测试**

`Lib/module_harness/tests/test_stream_log.py` 追加（imports 区补 `from module_harness.query import read_stream`）：

```python
class TestReadStream:
    def _write_log(self, tmp_path, lines, run_id="r1"):
        p = stream_log_path(run_id, tmp_path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("".join(lines), encoding="utf-8")
        return p

    def test_missing_returns_none(self, tmp_path):
        assert read_stream("ghost", base_dir=tmp_path) is None

    def test_incremental_with_off(self, tmp_path):
        self._write_log(tmp_path, [
            json.dumps({"type": "run_start", "pid": 1}) + "\n",
            json.dumps({"type": "token", "node": "A", "chunk": "hi"}) + "\n",
        ])
        r1 = read_stream("r1", base_dir=tmp_path)
        assert [r["type"] for r in r1["records"]] == ["run_start", "token"]
        assert r1["next_offset"] == r1["file_size"]
        assert r1["records"][0]["off"] == 0
        assert r1["records"][1]["off"] > r1["records"][0]["off"]
        r2 = read_stream("r1", offset=r1["next_offset"], base_dir=tmp_path)
        assert r2["records"] == []

    def test_partial_line_not_consumed(self, tmp_path):
        self._write_log(tmp_path, [
            json.dumps({"type": "run_start"}) + "\n",
            '{"type": "tok',
        ])
        r = read_stream("r1", base_dir=tmp_path)
        assert [x["type"] for x in r["records"]] == ["run_start"]
        with stream_log_path("r1", tmp_path).open("a", encoding="utf-8") as fh:
            fh.write('e", "node": "A"}\n')
        r2 = read_stream("r1", offset=r["next_offset"], base_dir=tmp_path)
        assert r2["records"][0]["type"] == "token"
        assert r2["records"][0]["node"] == "A"

    def test_corrupt_line_skipped(self, tmp_path):
        self._write_log(tmp_path, [
            json.dumps({"type": "run_start"}) + "\n",
            "not json{{\n",
            json.dumps({"type": "token", "node": "A", "chunk": "x"}) + "\n",
        ])
        r = read_stream("r1", base_dir=tmp_path)
        assert [x["type"] for x in r["records"]] == ["run_start", "token"]

    def test_offset_beyond_size_clamped(self, tmp_path):
        """offset 超过文件大小（文件被替换/重建）→ 钳回 0 自愈。"""
        self._write_log(tmp_path, [json.dumps({"type": "run_start"}) + "\n"])
        r = read_stream("r1", offset=10_000, base_dir=tmp_path)
        assert [x["type"] for x in r["records"]] == ["run_start"]
```

- [x] **Step 2: 跑测试确认失败**

```bash
cd "C:\Users\xingy\Desktop\开发\SpecModule"
python -m pytest module_harness/tests/test_stream_log.py -q
```

预期：`ImportError: cannot import name 'read_stream'`。

- [x] **Step 3: 实现 read_stream**

`Lib/module_harness/query.py`：

(a) imports 区（11-14 行）补：

```python
import json
```

(b) 文件头部 docstring 下 imports 之后新增（`from .stream import stream_log_path` 加在 import 区；函数放在 `_executed_nodes` 之前）：

```python
from .stream import stream_log_path


def read_stream(
    run_id: str, *, offset: int = 0, base_dir: Path | None = None
) -> dict[str, Any] | None:
    """增量读 stream.log（LLM 流式观测共享读端；Web WS 追尾/未来 TUI 共用）。

    二进制 seek(offset) 读到 EOF，按完整行切分；每条记录附行首字节偏移
    ``off``（锚定策略——只显示最近一次执行——由消费方据 off 自行定位，展示
    策略不进库）。末尾不完整行不消费（next_offset 停在其行首，等补齐后
    下次读出）；JSON 解析失败的行跳过（崩溃瞬间可能出半行）；
    ``offset > file_size``（文件被替换/重建）钳回 0 自愈。文件缺失 → None。

    返回 ``{"records": [...], "next_offset": int, "file_size": int}``。
    """
    path = stream_log_path(run_id, base_dir)
    if not path.exists():
        return None
    try:
        size = path.stat().st_size
        start = offset if offset <= size else 0
        with path.open("rb") as fh:
            fh.seek(start)
            data = fh.read()
    except OSError:
        log.exception("读 stream.log 失败（返回 None）: %s", path)
        return None
    nl = data.rfind(b"\n")
    if nl < 0:
        return {"records": [], "next_offset": start, "file_size": size}
    pos = start
    records: list[dict[str, Any]] = []
    for line in data[:nl].split(b"\n"):
        line_off = pos
        pos += len(line) + 1
        if not line.strip():
            continue
        try:
            rec = json.loads(line.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            log.warning("跳过损坏的 stream.log 行（off=%d）", line_off)
            continue
        rec["off"] = line_off
        records.append(rec)
    return {"records": records, "next_offset": start + nl + 1, "file_size": size}
```

- [x] **Step 4: 跑测试确认通过**

```bash
python -m pytest module_harness/tests/test_stream_log.py -q
python -m pytest module_harness/tests/ -q -m "not smoke"
```

预期：全绿。

- [x] **Step 5: api.md 补录**

`Lib/docs/references/api.md`：

(a) 「## module_harness.query」函数表末尾（`check_resume_compat_from_run` 行之后）加：

```markdown
| `read_stream` | `(run_id: str, *, offset: int = 0, base_dir: Path \| None = None) -> dict \| None` | 增量读 `stream.log`（LLM 流式观测共享读端）：按完整行切分、每条记录附行首字节偏移 `off`；末尾不完整行不消费（`next_offset` 停在其行首）；坏行跳过；`offset > file_size` 钳回 0 自愈；缺失 → `None`。返回 `{"records", "next_offset", "file_size"}`；"只显示最近执行"的锚定策略由消费方据 `off` 定位最后一条 `run_start` |
```

(b) 「## Module 运行」构造代码块（124-126 行 `persist`/`status_file`/`control` 之后）加一行：

```python
    stream_log: bool = True,        # False = 不写 stream.log（LLM 流式观测通道）
```

(c) 执行段落（Task 1 改过的附近），在 truncated 句之后补：

```markdown
LLM 流式输出经 EventBus 订阅落盘 `stream.log`（JSONL，append-only：`run_start` 为每次执行
边界，后接 `call_start`/`token`/`call_end`/`call_error`；`ts` 为 wall-clock；
`EventBus.null()` 场景仅 `run_start`）；增量读走 `query.read_stream`。
```

- [x] **Step 6: 提交（Lib 仓库）**

```bash
cd "C:\Users\xingy\Desktop\开发\SpecModule"
git add module_harness/query.py module_harness/tests/test_stream_log.py docs/references/api.md
git commit -m "feat: query.read_stream 共享读端——增量读/半行容忍/坏行跳过"
```

---

### Task 4: webview——ws.py 流追尾 + truncated 终态 + stream_mtime

**Files:**
- Modify: `SpecModule_webview/server/ws.py`（整文件重写，89 → ~130 行）
- Test: `SpecModule_webview/tests/test_ws.py`（追加 3 个测试 + 辅助函数）

- [x] **Step 1: 写失败测试**

`SpecModule_webview/tests/test_ws.py` 追加（`class TestStream` 内；文件头 imports 区补 `import json`）：

```python
    def _write_stream_log(self, base, run_id, lines):
        p = base / ".specmodule" / "runs" / run_id / "stream.log"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("".join(lines), encoding="utf-8")
        return p

    def test_stream_anchor_relay_and_truncated(self, base, client):
        """锚定最后一条 run_start（前一执行残留不推）；增量补推；truncated 终态 close(1000)。"""
        run_id = "ws_stream"
        seed_run(base, run_id, status={"module_id": run_id, "phase": "running", "updated_at": 1.0})
        log = self._write_stream_log(base, run_id, [
            json.dumps({"type": "token", "node": "OLD", "chunk": "残留"}) + "\n",
            json.dumps({"type": "run_start", "ts": 1.0, "pid": 1, "max_ticks": 100}) + "\n",
            json.dumps({"type": "token", "node": "A", "chunk": "你好"}) + "\n",
            '{"type": "token", "node": "A", "chu',   # 半行：本轮不推
        ])
        with client.websocket_connect(f"/api/runs/{run_id}/stream") as ws:
            stream_msg = ws.receive_json()
            assert stream_msg["type"] == "stream"
            assert [r["type"] for r in stream_msg["records"]] == ["run_start", "token"]
            assert all("off" not in r for r in stream_msg["records"])
            status_msg = ws.receive_json()
            assert status_msg["type"] == "status"
            assert status_msg["phase"] == "running"
            assert isinstance(status_msg["stream_mtime"], float)
            # 半行补齐 → 下一拍增量推出
            with log.open("a", encoding="utf-8") as fh:
                fh.write('e", "node": "A"}\n')
            more = ws.receive_json()
            assert more["type"] == "stream"
            assert more["records"][0]["chunk"] == "你好"
            # 截断终态 → 推完 close(1000)
            (base / ".specmodule" / "runs" / run_id / "status.json").write_text(
                json.dumps({
                    "module_id": run_id, "phase": "truncated",
                    "error": "max_ticks=1 截断（可 resume 续跑）", "updated_at": 2.0,
                }, ensure_ascii=False),
                encoding="utf-8",
            )
            final = ws.receive_json()
            assert final["type"] == "status"
            assert final["phase"] == "truncated"
            with pytest.raises(WebSocketDisconnect) as ei:
                ws.receive_json()
            assert ei.value.code == 1000

    def test_stream_mtime_null_without_log(self, base, client):
        seed_run(base, "ws_nomt", status={"module_id": "ws_nomt", "phase": "done", "updated_at": 1.0})
        with client.websocket_connect("/api/runs/ws_nomt/stream") as ws:
            msg = ws.receive_json()
            assert msg["stream_mtime"] is None

    def test_no_stream_without_running(self, base, client):
        """非 running 阶段连接（done 终态）：不锚定流、只推 status 后关闭。"""
        seed_run(base, "ws_nostream", status={"module_id": "ws_nostream", "phase": "done", "updated_at": 1.0})
        with client.websocket_connect("/api/runs/ws_nostream/stream") as ws:
            msg = ws.receive_json()
            assert msg["type"] == "status"
            with pytest.raises(WebSocketDisconnect):
                ws.receive_json()
```

- [x] **Step 2: 跑测试确认失败**

```bash
cd "C:\Users\xingy\Desktop\开发\SpecModule_webview"
python -m pytest tests/test_ws.py -q
```

预期：新测试 FAIL（`stream_mtime` KeyError / truncated 未 close / stream 消息缺失）；既有 5 个 PASS。

- [x] **Step 3: 重写 server/ws.py**

整文件替换为：

```python
# server/ws.py
"""tick 流实时推送：status.json/run.sqlite 签名推送 + stream.log 追尾（不改库）。"""

from __future__ import annotations

import asyncio
import os

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from module_harness import control
from module_harness.query import read_stream
from module_harness.status import query_run_status
from module_harness.stream import stream_log_path
from server.deps import get_base_dir, is_valid_run_id

router = APIRouter()

_TERMINAL = ("done", "aborted", "cancelled", "truncated")
_POLL_SECONDS = 1.0


def _stream_mtime(base_dir, run_id: str) -> float | None:
    try:
        return os.path.getmtime(stream_log_path(run_id, base_dir))
    except OSError:
        return None


@router.websocket("/api/runs/{run_id}/stream")
async def run_stream(websocket: WebSocket, run_id: str) -> None:
    """变化才推：status 按 sig=(phase, tick, updated_at, paused)；stream.log
    追尾锚定最后一条 run_start（含，前端以此为清缓冲信号），新记录批量推。
    推送顺序 stream 先于 status；终态（含 truncated）补发最后一批流后
    close(1000)。查询为同步短读（SQLite WAL 跨进程读 + 文件增量读，毫秒级），
    v1 直接在事件循环内调用。receive 竞速轮询间隔：本协议无客户端→服务端
    消息，receive 任务仅为在两次轮询之间察觉客户端断连。
    """
    await websocket.accept()
    if not is_valid_run_id(run_id):
        try:
            await websocket.send_json({"type": "error", "error": f"非法 run_id: {run_id!r}"})
            await websocket.close(code=4400)
        except Exception:
            return
        return
    base_dir = get_base_dir()
    last_sig: tuple | None = None
    stream_offset: int | None = None   # None = 未锚定（锚定后为下一读起点）
    recv_task = asyncio.create_task(websocket.receive())
    try:
        while True:
            st = query_run_status(run_id, base_dir=base_dir)
            if st is None:
                if last_sig is None:
                    try:
                        await websocket.send_json(
                            {"type": "error", "error": "无运行记录", "run_id": run_id}
                        )
                        await websocket.close(code=4404)
                    except Exception:
                        return
                    return
            else:
                # paused 走 control.json（status.json 无此状态）；签名比对含
                # paused——挂起/释放即使 phase/tick 不变也要推，前端换按钮
                req = control.read_control(run_id, base_dir=base_dir)
                paused = bool(req and req.get("action") == "pause")
                # 流追尾：running 起锚定（库侧 run_start 先于 running phase
                # 写入，见到 running 必已存在）；已锚定后每拍增量读
                if st.phase == "running" and stream_offset is None:
                    anchored = read_stream(run_id, offset=0, base_dir=base_dir)
                    if anchored is not None:
                        stream_offset = next(
                            (r["off"] for r in reversed(anchored["records"])
                             if r.get("type") == "run_start"),
                            0,
                        )
                if stream_offset is not None:
                    chunk = read_stream(run_id, offset=stream_offset, base_dir=base_dir)
                    if chunk is not None:
                        stream_offset = chunk["next_offset"]
                        if chunk["records"]:
                            try:
                                await websocket.send_json({
                                    "type": "stream",
                                    "records": [
                                        {k: v for k, v in r.items() if k != "off"}
                                        for r in chunk["records"]
                                    ],
                                })
                            except Exception:
                                return
                sig = (st.phase, st.tick, st.updated_at, paused)
                if sig != last_sig:
                    last_sig = sig
                    try:
                        await websocket.send_json({
                            "type": "status",
                            "phase": st.phase,
                            "status": st.status,
                            "tick": st.tick,
                            "fireable": st.fireable,
                            "fired": st.fired,
                            "outputs": st.outputs,
                            "error": st.error,
                            "updated_at": st.updated_at,
                            "paused": paused,
                            "stream_mtime": _stream_mtime(base_dir, run_id),
                        })
                    except Exception:
                        return
                    if st.phase in _TERMINAL:
                        try:
                            await websocket.close(code=1000)
                        except Exception:
                            return
                        return
            done, _ = await asyncio.wait({recv_task}, timeout=_POLL_SECONDS)
            if done:
                recv_task.exception()  # 取回异常（若有），避免 never-retrieved 告警
                return
    except WebSocketDisconnect:
        return
    finally:
        if not recv_task.done():
            recv_task.cancel()
```

- [x] **Step 4: 跑测试确认通过**

```bash
python -m pytest tests/test_ws.py -q
python -m pytest tests/ -q
```

预期：全绿（webview 全套不受影响）。

- [x] **Step 5: 提交（webview 仓库）**

```bash
cd "C:\Users\xingy\Desktop\开发\SpecModule_webview"
git add server/ws.py tests/test_ws.py
git commit -m "feat(ws): stream.log 追尾推送 + truncated 终态 + stream_mtime"
```

---

### Task 5: webview 前端——流消息处理 + truncated 终态集/徽章 + 黄条文案

**Files:**
- Modify: `web/src/api.ts`（4 行 TERMINAL_PHASES、46-55 行 StatusCore、StatusMsg 附近加类型、191 行 force 注释）
- Modify: `web/src/ws.ts`（整文件重写）
- Modify: `web/src/components/RunList.tsx`（4-9 行 PHASE_COLOR + 徽章标签）
- Modify: `web/src/App.tsx`（303-305 行黄条文案）

- [x] **Step 1: api.ts 类型**

(a) 3-4 行替换：

```ts
/** 终态集合：done/aborted/cancelled/truncated（截断）——轮询与控制条分支共用（收口定义源）。 */
export const TERMINAL_PHASES = new Set(["done", "aborted", "cancelled", "truncated"]);
```

(b) `StatusCore`（46-55 行）末尾（`updated_at: number;` 之后）加字段：

```ts
  /** stream.log 最后修改时间（LLM 流式心跳辅助；无 stream.log 为 null） */
  stream_mtime: number | null;
```

(c) `StatusMsg` 定义（57-60 行）之后新增：

```ts
/** stream.log 记录（LLM 流式输出；run_start = 新执行边界，前端据此清缓冲） */
export interface StreamRecord {
  type: "run_start" | "call_start" | "token" | "call_end" | "call_error";
  ts: number;
  node?: string;
  chunk?: string;
  [k: string]: unknown;
}

export interface StreamMsg {
  type: "stream";
  records: StreamRecord[];
}
```

(d) 190-191 行 `force` 注释更新（截断已终态化，running 残留只剩进程终止场景）：

```ts
  /** phase=running 也放行（进程被终止后的残留 running 态） */
```

- [x] **Step 2: ws.ts 整文件替换**

```ts
// WS 客户端：首连即收当前状态；stream 记录按节点累积缓冲（run_start 清缓冲）；
// 断线 1s 退避重连；终态后停止重连。
import { useEffect, useRef, useState } from "react";
import { TERMINAL_PHASES, type StatusMsg, type StreamMsg } from "./api";

type WsMsg = StatusMsg | StreamMsg | { type: "error"; error: string };

/** 流缓冲：按节点累积的流式文本 + 版本号（每批消息自增，驱动订阅方 effect）。 */
export interface StreamBuffer {
  text: Record<string, string>;
  seq: number;
}

/** 流状态按 runId 打包：StatusMsg 本身无 run_id 字段，消费端据此丢弃切 run 瞬间的陈旧消息。 */
export interface StreamState {
  runId: string;
  msg: StatusMsg;
  stream: StreamBuffer;
}

export function useRunStream(runId: string | null): StreamState | null {
  const [state, setState] = useState<StreamState | null>(null);
  const terminalRef = useRef(false);

  useEffect(() => {
    // 切换 run 先清旧消息，避免 header 短暂显示上一个 run 的 phase
    setState(null);
    if (!runId) return;
    terminalRef.current = false;
    let ws: WebSocket | null = null;
    let timer: number | undefined;
    let closed = false;

    const connect = () => {
      if (closed || terminalRef.current) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(
        `${proto}://${location.host}/api/runs/${encodeURIComponent(runId)}/stream`,
      );
      ws.onmessage = (ev) => {
        const data = JSON.parse(ev.data) as WsMsg;
        if (data.type === "error") {
          // 服务端错误关闭（如 run 不存在）→ 停止重连，避免错误-关闭-重连循环
          terminalRef.current = true;
          return;
        }
        if (data.type === "stream") {
          setState((prev) => {
            if (!prev || prev.runId !== runId) return prev;
            const text = { ...prev.stream.text };
            let seq = prev.stream.seq;
            for (const r of data.records) {
              if (r.type === "run_start") {
                // 新执行边界：清空缓冲（resume 重跑的流从零开始显示）
                for (const k of Object.keys(text)) delete text[k];
                seq += 1;
              } else if (r.type === "token" && r.node) {
                text[r.node] = (text[r.node] ?? "") + (r.chunk ?? "");
                seq += 1;
              }
            }
            return { ...prev, stream: { text, seq } };
          });
          return;
        }
        if (data.type === "status") {
          // 保留流缓冲（status 与 stream 交替到达，互相不重置）
          setState((prev) => ({
            runId,
            msg: data,
            stream: prev?.runId === runId ? prev.stream : { text: {}, seq: 0 },
          }));
          if (TERMINAL_PHASES.has(data.phase)) terminalRef.current = true;
        }
      };
      ws.onclose = () => {
        if (!closed && !terminalRef.current) timer = window.setTimeout(connect, 1000);
      };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [runId]);

  return state;
}
```

注：stream 消息每批都会产生新 StreamState 对象（seq 自增）→ App 的停滞计时 effect（`[streamState, runId]`）随之推进——**存活检测由此零改动升级**。

- [x] **Step 3: RunList 徽章**

`web/src/components/RunList.tsx` 4-9 行替换：

```ts
const PHASE_COLOR: Record<string, string> = {
  running: "#2563eb",
  done: "#16a34a",
  aborted: "#dc2626",
  cancelled: "#d97706",
  truncated: "#b45309",
};

/** 非英文 phase 的展示标签（其余原样显示） */
const PHASE_LABEL: Record<string, string> = {
  truncated: "已截断",
};
```

62-65 行的 `<span>` 显示改为：

```tsx
              <span>
                {PHASE_LABEL[r.phase] ?? r.phase}
                {r.tick != null ? ` · tick ${r.tick}` : ""}
              </span>
```

终态 ↻ 按钮无需改动（`TERMINAL_PHASES.has(r.phase)` 自动覆盖 truncated）。

- [x] **Step 4: App 黄条文案**

`web/src/App.tsx` 303-305 行替换（截断已终态化，黄条只剩真失联语义）：

```tsx
            <span>
              进程长时间无输出——可能已失联/崩溃。若确认进程已退出，可强制恢复。
            </span>
```

- [x] **Step 5: 构建门禁 + 提交**

```bash
cd "C:\Users\xingy\Desktop\开发\SpecModule_webview\web"
npm run build
```

预期：tsc --noEmit + vite build 通过。

```bash
cd "C:\Users\xingy\Desktop\开发\SpecModule_webview"
git add web/src/api.ts web/src/ws.ts web/src/components/RunList.tsx web/src/App.tsx
git commit -m "feat(web): 流消息缓冲 + truncated 终态集/徽章 + 黄条文案收窄"
```

---

### Task 6: webview 前端——NodePanel 实时输出区

**Files:**
- Modify: `web/src/components/NodePanel.tsx`（props + 实时区 + 自动滚底）
- Modify: `web/src/App.tsx`（selectedNode 之后算 liveText + NodePanel 传参）

- [x] **Step 1: NodePanel 实时区**

`web/src/components/NodePanel.tsx`：

(a) 3 行 imports 替换：

```tsx
import { useEffect, useRef, useState } from "react";
```

(b) 组件签名（11-21 行）加 prop：

```tsx
export function NodePanel({
  runId,
  node,
  outputs,
  liveText,
  onClose,
}: {
  runId: string;
  node: GraphNode;
  outputs: Record<string, unknown>;
  /** 该节点当前执行的流式文本（phase=running 且有 token 时非空；终态后由 outputs 接管） */
  liveText?: string;
  onClose: () => void;
}) {
```

(c) `const [entries, setEntries] = ...`（22 行）之后加自动滚底：

```tsx
  const liveRef = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    if (liveRef.current) liveRef.current.scrollTop = liveRef.current.scrollHeight;
  }, [liveText]);
```

(d) 「最新输出（实时）」section（55-69 行）**之前**插入实时区：

```tsx
      {liveText ? (
        <section>
          <h4 style={{ margin: "12px 0 6px" }}>
            实时输出<span style={{ color: "#2563eb", fontSize: 11 }}>（流式）</span>
          </h4>
          <pre
            ref={liveRef}
            style={{
              background: "#eff6ff",
              padding: 8,
              borderRadius: 6,
              fontSize: 12,
              whiteSpace: "pre-wrap",
              margin: 0,
              maxHeight: 240,
              overflowY: "auto",
            }}
          >
            {liveText.slice(-10000)}
          </pre>
        </section>
      ) : null}
```

（`slice(-10000)` 渲染上限：超长流式输出只显示尾部，防 DOM 卡顿；缓冲本身不动。）

- [x] **Step 2: App 接线**

`web/src/App.tsx`：`const selectedNode = ...`（243 行）之后加：

```tsx
  // 选中节点的流式文本：仅 running 且流缓冲属于当前 run 时给出（终态后 outputs 接管）
  const liveText =
    statusView?.phase === "running" && streamState?.runId === runId && selectedNode
      ? streamState.stream.text[selectedNode.id]
      : undefined;
```

NodePanel 渲染（345-352 行）`outputs` 之后加 prop：

```tsx
          liveText={liveText}
```

- [x] **Step 3: 构建门禁**

```bash
cd "C:\Users\xingy\Desktop\开发\SpecModule_webview\web"
npm run build
```

预期：通过。

- [x] **Step 4: 提交（webview 仓库）**

```bash
cd "C:\Users\xingy\Desktop\开发\SpecModule_webview"
git add web/src/components/NodePanel.tsx web/src/App.tsx
git commit -m "feat(web): NodePanel 实时输出区——LLM 流式显示"
```

---

### Task 7: webview——文档 + 全量验证

**Files:**
- Modify: `roadmap.md`（变更日志 + 缺口④ 根除记录）
- Modify: `AGENTS.md`（phase 机器、WS 形状、产物清单）

- [x] **Step 1: roadmap.md 变更日志**

「变更日志」节顶部插入条目（日期 2026-08-31）：

```markdown
- **2026-08-31 截断终态 + LLM 流式落盘（库 A/B 两案，spec：2026-08-31-truncated-stream-design.md）**：
  库侧 `_finalize_phase` 将 max_ticks 耗尽映射为新终态 **`truncated`**（error 记上限）——
  控制缺口 ④ 的"截断 running 态"从根消除，黄条启发式只对真失联触发；库侧新增
  `stream.log`（Module `stream_log=True` 默认开，EventBus 订阅 `LlmCallStarted/LlmToken/
  LlmCallCompleted/HarnessFailed` 五类 JSONL 记录 append 落盘）+ `query.read_stream`
  共享增量读端；webview WS 追尾推送（锚定最后一条 `run_start`）+ `stream_mtime`、
  NodePanel 实时输出区、truncated 终态按钮矩阵。库仓库独立提交 ×3（含 api.md 补录）。
```

「控制功能缺口盘点」节缺口 ④ 条目下补一行（沿用该节格式）：

```markdown
  - **根除（2026-08-31）**：库 truncated 终态落地后，截断不再是 running 残留；
    黄条只对进程真失联触发（流式心跳 + 终态关闭）。
```

- [x] **Step 2: AGENTS.md 更新**

(a) "Run lifecycle" 段 phase 机器更新：

```
`status.json` phase machine: `idle → translating → reviewing → building → ready → running → done | aborted | cancelled | truncated`（truncated = max_ticks 耗尽，终态可 resume）。
```

(b) "Key constraints" 的 "**Real-time without touching the library**" 条目更新：轮询源与推送形状补 stream：

```
the WS stream (`/api/runs/{id}/stream`) polls `query_run_status` + `control.read_control`（paused 标志）+ `query.read_stream`（stream.log 追尾，锚定最后一条 `run_start`）on the server side（~1s），status 按 `(phase, tick, updated_at, paused)` 签名变化才推（附 `stream_mtime` 辅助心跳）、新 stream 记录批量推 `{"type": "stream", records}`（先于 status）、终态（含 truncated）推完 close(1000)
```

(c) 运行产物描述（架构图与 "Run artifacts" 目录项）把产物清单补为 `run.sqlite + status.json + stream.log`（LLM 流式 JSONL，`stream_log=False` 关闭）。

- [x] **Step 3: 全量验证（两仓库）**

```bash
cd "C:\Users\xingy\Desktop\开发\SpecModule_webview"
python -m pytest tests/ -q
python -m pytest ../SpecModule/module_harness/tests/ -q -m "not smoke"
cd web && npm run build
```

预期：webview 全绿（≥70 tests）、库基线全绿（≥570 tests）、tsc + vite 通过。

- [x] **Step 4: 提交（webview 仓库）**

```bash
cd "C:\Users\xingy\Desktop\开发\SpecModule_webview"
git add roadmap.md AGENTS.md
git commit -m "docs: truncated + stream.log 落地记录——roadmap 变更日志 + AGENTS.md 端点形状"
```
