# TreeChat ops agent（chat × module 打通）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** treechat 新增 ops 对话模式（agent 工具循环）：查模块库 → 完善 spec → 发起 run（秒回 run_id）→ 问答式查状态/快照/时间线 → cancel/pause/unpause；实时监控归前端 RunBlock + 既有 WS 流。

**Architecture:** 进程内工具桥（不走 MCP）。agent 循环 = 纯 Python `client.chat(messages, tools)` 循环（≤12 迭代）；工具箱两层——数据类薄映射（module_harness 查询/控制 + `server/runservice.py` spawn 编排）、能力类 `call_harness` 无头 module run。run 永不进回合关键路径。SSE 帧扩展 `tool_call`/`tool_result`，前端泛型分发天然穿透。

**Tech Stack:** FastAPI + module_harness（库共享层）+ llm 包 `chat()` 多轮接口 + pytest/httpx；前端 Vite + React + TS。

**Spec:** `docs/superpowers/specs/2026-09-26-treechat-ops-agent-design.md`（决策 D1-D5）

**测试命令约定**：`uv run pytest tests/ -q`（本仓库，工作目录 = SpecModule_webview 根）；库侧用 `uv run pytest ../SpecModule/llm/tests/ -q`。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `../SpecModule/llm/client.py` | `AnthropicClient._convert_messages` 补工具消息形状 | 修改 |
| `../SpecModule/llm/tests/test_message_conversion.py` | 工具消息转换测试 | 新建 |
| `../SpecModule/docs/references/api.md` | `chat()` 工具循环契约补录 | 修改 |
| `server/runservice.py` | spawn 编排 + 进程注册表共享层（异常不携带 HTTP 语义） | 新建 |
| `server/api/control.py` | 端点薄化为 runservice 调用 + HTTPException 映射 | 重写 |
| `treechat/tools/base.py` | ToolDef / ToolContext / 注册表 / dispatch / schema 导出 | 新建 |
| `treechat/tools/data_tools.py` | 7 个数据类工具（薄映射） | 新建 |
| `treechat/tools/__init__.py` | 包出口（base + 副作用注册） | 新建 |
| `treechat/agent_bridge.py` | agent 循环（build_messages / run_agent_turn / summarize） | 新建 |
| `treechat/modules/agent.py` | `AgentMode` 定义（非 harness 模式） | 新建 |
| `treechat/modules/__init__.py` | BUILT_IN 收录 ops + resolve_module 内建直查 | 修改 |
| `treechat/session.py` | complete_outcome 分派 + tool_context 字段 | 修改 |
| `treechat/webapp/registry.py` | SessionRegistry 透传 tool_context | 修改 |
| `treechat/webapp/app.py` | create_app(tool_context=...) | 修改 |
| `server/chat.py` | mount 时构建 ToolContext 注入 | 修改 |
| `treechat/tools/refine_spec.py` | 能力类工具样例（call_harness） | 新建（任务 7） |
| `web/src/chat/types.ts` | ToolStep 类型 + RunTrace.tools | 修改 |
| `web/src/App.tsx` | handleEvent 工具帧 + ChatView 传 onOpenRun | 修改 |
| `web/src/chat/ChatView.tsx` | RunBlock 工具块 + RunProgress（WS 订阅） | 修改 |
| `tests/test_control_api.py` | monkeypatch 面 → runservice | 修改 |
| `tests/treechat/test_tools.py` / `test_agent_bridge.py` / `test_agent_turn.py` | 新测试 | 新建 |

---

### Task 1: S0 上游——`chat()` Anthropic 工具消息形状

`OpenAIClient._convert_messages` 已支持 assistant(tool_calls) 与 tool 角色；`AnthropicClient._convert_messages`（`../SpecModule/llm/client.py:414`）不支持——tool 消息原样透传会被 Anthropic API 拒绝。ops agent 是 `chat()` 的正当新消费端，按统一 API 原则收编上游。

**Files:**
- Modify: `../SpecModule/llm/client.py`（`AnthropicClient._convert_messages`）
- Create: `../SpecModule/llm/tests/test_message_conversion.py`
- Modify: `../SpecModule/docs/references/api.md`

- [ ] **Step 1: 写失败测试**

```python
# ../SpecModule/llm/tests/test_message_conversion.py
"""chat() 多轮接口的消息转换：工具循环（assistant+tool_calls / tool 角色）必须
在两个后端都正确映射——Anthropic 走 tool_use / tool_result 内容块。

回归锚点：此前 Anthropic 侧 tool 消息原样透传（{"role": "tool", ...}），会被
Anthropic API 拒绝——ops agent 工具循环（webview 仓库）依赖此形状。
"""
from __future__ import annotations

from llm.client import AnthropicClient, Message, OpenAIClient


def _anthropic() -> AnthropicClient:
    # 跳过 __init__：_convert_messages 是纯函数，不依赖 SDK 安装/客户端就绪
    return AnthropicClient.__new__(AnthropicClient)


class TestAnthropicConversion:
    def test_tool_result_maps_to_user_block(self):
        msgs = [Message(role="tool", content='{"ok": true}', tool_call_id="tc_1")]
        _, out = _anthropic()._convert_messages(msgs)
        assert out == [{"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "tc_1", "content": '{"ok": true}'}]}]

    def test_assistant_tool_calls_map_to_tool_use_blocks(self):
        msgs = [Message(role="assistant", content="查一下", tool_calls=[
            {"id": "tc_1", "name": "run_status", "arguments": {"run_id": "r1"}}])]
        _, out = _anthropic()._convert_messages(msgs)
        assert out == [{"role": "assistant", "content": [
            {"type": "text", "text": "查一下"},
            {"type": "tool_use", "id": "tc_1", "name": "run_status",
             "input": {"run_id": "r1"}}]}]

    def test_system_separated_and_plain_roundtrip(self):
        msgs = [Message(role="system", content="s"), Message(role="user", content="u")]
        system, out = _anthropic()._convert_messages(msgs)
        assert system == "s"
        assert out == [{"role": "user", "content": "u"}]


class TestOpenAIConversion:
    def test_tool_roundtrip_keeps_ids(self):
        msgs = [
            Message(role="assistant", content="", tool_calls=[
                {"id": "tc_1", "name": "run_status", "arguments": {"run_id": "r1"}}]),
            Message(role="tool", content='{"phase": "done"}', tool_call_id="tc_1"),
        ]
        out = OpenAIClient.__new__(OpenAIClient)._convert_messages(msgs)
        assert out[0]["tool_calls"][0]["id"] == "tc_1"
        assert out[1] == {"role": "tool", "tool_call_id": "tc_1",
                          "content": '{"phase": "done"}'}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest ../SpecModule/llm/tests/test_message_conversion.py -v`
Expected: `TestAnthropicConversion` 两个用例 FAIL（tool 角色原样透传 / tool_calls 丢失）；`TestOpenAIConversion` PASS。

- [ ] **Step 3: 实现——替换 `AnthropicClient._convert_messages` 整个方法**

```python
    def _convert_messages(self, messages: list[Message]) -> tuple[str | None, list[dict[str, Any]]]:
        """分离 system 消息并转换其余消息；工具循环形状：assistant+tool_calls →
        tool_use 内容块，tool 角色 → tool_result 用户消息块（Anthropic 契约）。"""
        system_prompt = None
        api_messages = []
        for msg in messages:
            if msg.role == "system":
                system_prompt = msg.content
            elif msg.role == "assistant" and msg.tool_calls:
                blocks: list[dict[str, Any]] = []
                if msg.content:
                    blocks.append({"type": "text", "text": msg.content})
                for tc in msg.tool_calls:
                    blocks.append({"type": "tool_use", "id": tc["id"],
                                   "name": tc["name"], "input": tc.get("arguments", {})})
                api_messages.append({"role": "assistant", "content": blocks})
            elif msg.role == "tool":
                api_messages.append({"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": msg.tool_call_id or "",
                     "content": msg.content},
                ]})
            else:
                api_messages.append({"role": msg.role, "content": msg.content})
        return system_prompt, api_messages
```

- [ ] **Step 4: 跑测试确认通过 + llm 全套回归**

Run: `uv run pytest ../SpecModule/llm/tests/test_message_conversion.py -v` → PASS
Run: `uv run pytest ../SpecModule/llm/tests/ -q` → 全绿

- [ ] **Step 5: 库仓库提交（代码）**

```bash
cd ../SpecModule
git add llm/client.py llm/tests/test_message_conversion.py
git commit -m "fix(llm): chat() 工具消息形状——Anthropic _convert_messages 补 tool_use/tool_result 映射"
```

- [ ] **Step 6: api.md 补录 + 库仓库文档提交**

在 `../SpecModule/docs/references/api.md` 的 llm 客户端小节追加：

```markdown
### llm.chat —— 多轮聊天（工具循环底层接口）

`RoutingClient.chat(messages, tools)` 及两后端同名方法。消费端（agent 循环）契约：

- `messages: list[Message]`——`Message(role, content, tool_calls, tool_call_id)`；
  工具循环序列：assistant(tool_calls) 后必须紧跟对应 tool(tool_call_id) 消息；
- `tools: list[dict]`——`{"name", "description", "input_schema"}`（两后端转换器
  统一吃 `input_schema` 键，OpenAI 侧映射为 function.parameters）；
- 返回 `LLMResponse(content, tool_calls, usage, finish_reason)`——`tool_calls`
  元素 `{"id", "name", "arguments"}`（arguments 已解析为 dict）；
- `chat()` 非流式（流式经 `complete()` 的 on_token 通道，两接口独立）；
- 工具报错由消费端以 tool 消息喂回模型自纠；客户端只区分调用成功/失败（LLMError）。
```

```bash
cd ../SpecModule
git add docs/references/api.md
git commit -m "docs: api.md 补录 llm.chat() 工具循环契约（消息形状/两后端映射）"
```

---

### Task 2: S1 runservice 提取（纯重构）

把 `server/api/control.py` 的 spawn 编排段提取为 `server/runservice.py`，HTTP 端点与 treechat 工具共用（单一注册表、单一 spawn 模型）。服务层异常不携带 HTTP 语义；库 `ValueError` 原样上抛。

**Files:**
- Create: `server/runservice.py`
- Modify: `server/api/control.py`（整文件重写）
- Modify: `tests/test_control_api.py:32-43`（stub_spawn fixture）

- [ ] **Step 1: 先改测试 monkeypatch 面（红）**

`tests/test_control_api.py` 顶部 import 与 fixture 替换：

```python
from server import runservice
```

```python
@pytest.fixture()
def stub_spawn(monkeypatch):
    """替换 runservice._spawn：记录 argv/cwd，返回 FakePopen；进程注册表隔离。"""
    calls: list[dict[str, Any]] = []

    def _fake_spawn(argv, cwd, log_fh):
        calls.append({"argv": list(argv), "cwd": cwd})
        return FakePopen()

    monkeypatch.setattr(runservice, "_spawn", _fake_spawn)
    monkeypatch.setattr(runservice, "_PROCS", {})
    return calls
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/test_control_api.py -q`
Expected: FAIL（`server.runservice` 尚不存在 → ImportError）。

- [ ] **Step 3: 新建 `server/runservice.py`（完整内容）**

```python
# server/runservice.py
"""运行编排共享层：spawn 官方 CLI 子进程 + 内存进程注册表。

server/api/control.py（HTTP 端点）与 treechat ops agent 工具共用——单一注册表、
单一 spawn 模型（treechat 发起的 run 即刻进 Runs 页签，被既有 WS 流监控）。
异常不携带 HTTP 语义：RunServiceError 子类由调用方各自映射（端点 → HTTPException，
工具 → {"error": ...} 喂回模型）；库抛的 ValueError 原样上抛（端点 400）。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

from module_harness.infra import store
from module_harness.infra.status import query_run_status

from server.deps import is_valid_run_id

_LOG_TAIL_BYTES = 8 * 1024


class RunServiceError(Exception):
    """运行编排失败基类。"""


class ModuleUnresolvedError(RunServiceError):
    """模块未找到（端点映射 404 code=module_unresolved）。"""

    def __init__(self, module: str) -> None:
        self.module = module
        super().__init__(f"模块 '{module}' 未找到")


class RunNotFoundError(RunServiceError):
    """目标 run 无 status.json（控制/恢复只对已落盘运行有意义）。"""


class RunExistsError(RunServiceError):
    """run 目录已存在（防覆盖历史）。"""

    def __init__(self, message: str, run_id: str) -> None:
        self.run_id = run_id
        super().__init__(message)


class ProcessBusyError(RunServiceError):
    """注册表互斥冲突 / 运行进行中 / 无被跟踪进程。"""


class InvalidInputError(RunServiceError):
    """非法 run_id / 非法回退目标 / 无可恢复快照。"""


class _Proc:
    """一个被跟踪的子进程（互斥 + 日志 + 临时文件生命周期）。"""

    def __init__(self, popen: subprocess.Popen, tmp_paths: list[Path]) -> None:
        self.popen = popen
        self.started_at = time.time()
        self.tmp_paths = tmp_paths


_PROCS: dict[str, _Proc] = {}


def reap(run_id: str) -> _Proc | None:
    """惰性收割：子进程已退出 → 清理临时文件并移出注册表。返回仍活着的条目。"""
    proc = _PROCS.get(run_id)
    if proc is None:
        return None
    if proc.popen.poll() is None:
        return proc
    for p in proc.tmp_paths:
        try:
            p.unlink(missing_ok=True)
        except OSError:
            pass
    del _PROCS[run_id]
    return None


def _spawn(argv: list[str], cwd: str, log_fh: Any) -> subprocess.Popen:
    """spawn 薄封装（测试 monkeypatch 点）。"""
    return subprocess.Popen(argv, cwd=cwd, stdout=log_fh, stderr=subprocess.STDOUT)


def _require_run(run_id: str, base_dir: Path) -> None:
    if query_run_status(run_id, base_dir=base_dir) is None:
        raise RunNotFoundError(run_id)


def _dump_arg(payload: Any, run_id: str, tmp_paths: list[Path], flag: str,
              argv: list[str]) -> None:
    """spec/tasklist 落临时文件走 CLI 文件通道（--spec-file/--tasklist，
    Windows argv 长度限制）。"""
    fd, name = tempfile.mkstemp(prefix=f"webview_{run_id}_", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False)
    tmp_paths.append(Path(name))
    argv += [flag, name]


def _launch(argv: list[str], run_id: str, tmp_paths: list[Path], base_dir: Path,
            extra: dict) -> dict:
    """公共 spawn 段：建目录 + 日志接管 + 注册表登记 + 202 载荷。"""
    run_dir = base_dir / ".specmodule" / "runs" / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    log_fh = (run_dir / "process.log").open("wb")
    try:
        popen = _spawn(argv, cwd=str(base_dir), log_fh=log_fh)
    except OSError:
        log_fh.close()
        for p in tmp_paths:
            p.unlink(missing_ok=True)
        raise
    _PROCS[run_id] = _Proc(popen, tmp_paths)
    return {"started": True, "run_id": run_id, "pid": popen.pid, **extra}


def launch_run(module: str, *, spec: dict | None = None, template: str | None = None,
               run_id: str | None = None, max_ticks: int = 100, mock: bool = False,
               base_dir: Path, search: list[Path]) -> dict:
    """发起运行：spawn 官方 CLI `run`（校验链镜像原 post_run，秒回不等待）。"""
    resolved = store.resolve_module_full(module, search=search)  # ValueError 原样上抛
    if resolved is None:
        raise ModuleUnresolvedError(module)
    run_id = run_id or f"{module}_{uuid.uuid4().hex[:6]}"
    if not is_valid_run_id(run_id):
        raise InvalidInputError(f"非法 run_id: {run_id!r}")
    run_dir = base_dir / ".specmodule" / "runs" / run_id
    if run_dir.exists():
        raise RunExistsError(f"运行已存在: {run_id}（防覆盖历史，请换 run_id）", run_id)
    if reap(run_id) is not None:
        raise ProcessBusyError("该 run_id 已有运行进程在跑")

    tmp_paths: list[Path] = []
    argv = [sys.executable, "-m", "module_harness.cli", "run",
            "--module", module, "--run-id", run_id]
    if spec is not None:
        _dump_arg(spec, run_id, tmp_paths, "--spec-file", argv)
    if template:
        argv += ["--template", template]
    argv += ["--max-ticks", str(max_ticks)]
    if mock:
        argv.append("--mock")
    return _launch(argv, run_id, tmp_paths, base_dir, {"module": module})


def resume_run(run_id: str, *, module: str | None = None,
               target: int | str | None = None, spec: dict | None = None,
               tasklist: dict | None = None, max_ticks: int = 100,
               mock: bool = False, force: bool = False,
               base_dir: Path, search: list[Path]) -> dict:
    """恢复/回退：spawn 官方 CLI `resume`（校验链镜像原 post_resume）。"""
    _require_run(run_id, base_dir)
    if not (base_dir / ".specmodule" / "runs" / run_id / "run.sqlite").exists():
        raise InvalidInputError("无可恢复快照（运行未落盘 run.sqlite）")
    if reap(run_id) is not None:
        raise ProcessBusyError("该 run 已有恢复进程在跑")
    st = query_run_status(run_id, base_dir=base_dir)
    if st is not None and st.phase == "running" and not force:
        raise ProcessBusyError("运行进行中——先取消/暂停再恢复")
    module_name = module or run_id
    if store.resolve_module(module_name, search=search) is None:
        raise ModuleUnresolvedError(module_name)
    target_str: str | None = None
    if target is not None:
        target_str = str(target)
        if not (target_str.isdigit() or target_str.startswith("manual:")):
            raise InvalidInputError(f"非法回退目标: {target_str!r}（tick 号或 manual:<label>）")

    tmp_paths: list[Path] = []
    argv = [sys.executable, "-m", "module_harness.cli", "resume"]
    if target_str is not None:
        argv.append(target_str)
    argv += ["--module", module_name, "--run-id", run_id]
    if spec is not None:
        _dump_arg(spec, run_id, tmp_paths, "--spec-file", argv)
    if tasklist is not None:
        _dump_arg(tasklist, run_id, tmp_paths, "--tasklist", argv)
    argv += ["--max-ticks", str(max_ticks)]
    if mock:
        argv.append("--mock")
    return _launch(argv, run_id, tmp_paths, base_dir,
                   {"module": module_name, "target": target_str})


def terminate_process(run_id: str) -> dict:
    """被跟踪子进程硬终止（Windows = 硬杀）；不代写终态——status 残留 running
    由 UI 停滞提示引导强制恢复。"""
    proc = reap(run_id)
    if proc is None:
        raise ProcessBusyError("无本 server 启动的恢复进程")
    proc.popen.terminate()
    return {"run_id": run_id, "terminated": True, "pid": proc.popen.pid}


def process_info(run_id: str, base_dir: Path) -> dict:
    """被跟踪子进程观测：是否在跑 + process.log 尾（8KB）。"""
    proc = reap(run_id)
    log_path = base_dir / ".specmodule" / "runs" / run_id / "process.log"
    log_tail: str | None = None
    if log_path.exists():
        try:
            log_tail = log_path.read_text(encoding="utf-8", errors="replace")[
                -_LOG_TAIL_BYTES:
            ]
        except OSError:
            log_tail = None
    return {
        "run_id": run_id,
        "running": proc is not None,
        "pid": proc.popen.pid if proc else None,
        "started_at": proc.started_at if proc else None,
        "log": log_tail,
    }
```

- [ ] **Step 4: 重写 `server/api/control.py`（完整内容）**

```python
# server/api/control.py
"""控制面 HTTP 端点：控制文件薄映射 + 运行编排（共享层 runservice）+ inputs/删除。

- control 两端点 / inputs / DELETE：库 `control.*` / `query.read_module_inputs` /
  `query.delete_run` 薄映射 + 消费端活性防护（runservice.reap）。
- POST /runs、/{id}/resume、/process/*：`server.runservice` 薄调用——编排异常映射
  ModuleUnresolved→404(code=module_unresolved)、RunNotFound→404、
  RunExists/ProcessBusy→409、InvalidInput→400、库 ValueError→400。
- 进程注册表 / spawn / 临时文件生命周期在 runservice（treechat ops 工具共用）。
- preflight = 恢复预检 dry-run（薄调库 check_resume_compat_from_run）。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from module_harness.infra import control, query
from module_harness.infra.status import query_run_status
from server import runservice
from server.deps import get_base_dir, get_search_paths, validate_run_id

router = APIRouter(prefix="/api/runs")


def _not_found(run_id: str) -> HTTPException:
    return HTTPException(status_code=404, detail={"error": "无运行记录", "run_id": run_id})


def _require_run(run_id: str, base_dir: Path) -> dict[str, Any]:
    """目标 run 必须已有 status.json（控制/恢复都只对已落盘的运行有意义）。"""
    st = query_run_status(run_id, base_dir=base_dir)
    if st is None:
        raise _not_found(run_id)
    return {"phase": st.phase}


# ------------------------------------------------------------------
# 运行控制（cancel/pause/unpause —— 控制文件薄映射）
# ------------------------------------------------------------------


def _control_view(run_id: str, base_dir: Path) -> dict[str, Any]:
    req = control.read_control(run_id, base_dir=base_dir)
    return {
        "run_id": run_id,
        "control": req,
        "paused": bool(req and req.get("action") == "pause"),
    }


@router.get("/{run_id}/control")
def get_control(run_id: str, base_dir: Path = Depends(get_base_dir)) -> dict:
    validate_run_id(run_id)
    _require_run(run_id, base_dir)
    return _control_view(run_id, base_dir)


class ControlBody(BaseModel):
    action: str
    reason: str | None = None


@router.post("/{run_id}/control")
def post_control(
    run_id: str, body: ControlBody, base_dir: Path = Depends(get_base_dir)
) -> dict:
    validate_run_id(run_id)
    _require_run(run_id, base_dir)
    try:
        control.request_control(
            run_id, body.action, reason=body.reason, base_dir=base_dir
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail={"error": e.args[0], "run_id": run_id})
    return _control_view(run_id, base_dir)


# ------------------------------------------------------------------
# 运行输入存档（resume 预填）
# ------------------------------------------------------------------


@router.get("/{run_id}/inputs")
def get_inputs(run_id: str, base_dir: Path = Depends(get_base_dir)) -> dict:
    validate_run_id(run_id)
    _require_run(run_id, base_dir)
    inputs = query.read_module_inputs(run_id, base_dir=base_dir) or {}
    return {
        "run_id": run_id,
        "spec": inputs.get("spec"),
        "tasklist": inputs.get("tasklist"),
    }


# ------------------------------------------------------------------
# 发起运行 + 运行历史删除
# ------------------------------------------------------------------


class LaunchBody(BaseModel):
    module: str
    spec: dict[str, Any] | None = None   # None → CLI 回落 entry.default_spec
    template: str | None = None          # None → CLI 回落 default_template
    run_id: str | None = None            # 缺省 server 生成 {module}_{6hex}
    max_ticks: int = 100
    mock: bool = False


@router.post("", status_code=202)
def post_run(body: LaunchBody, base_dir: Path = Depends(get_base_dir)) -> dict:
    """发起运行：runservice spawn 官方 CLI `run`（校验链/编排见共享层 docstring）。"""
    try:
        return runservice.launch_run(
            body.module, spec=body.spec, template=body.template, run_id=body.run_id,
            max_ticks=body.max_ticks, mock=body.mock, base_dir=base_dir,
            search=get_search_paths(base_dir))
    except runservice.ModuleUnresolvedError as e:
        raise HTTPException(status_code=404, detail={
            "error": str(e), "module": e.module, "code": "module_unresolved"})
    except runservice.RunExistsError as e:
        raise HTTPException(status_code=409,
                            detail={"error": str(e), "run_id": e.run_id})
    except runservice.ProcessBusyError as e:
        raise HTTPException(status_code=409, detail={"error": str(e)})
    except runservice.InvalidInputError as e:
        raise HTTPException(status_code=400, detail={"error": str(e)})
    except ValueError as e:
        raise HTTPException(status_code=400,
                            detail={"error": e.args[0], "module": body.module})


@router.delete("/{run_id}")
def delete_run(
    run_id: str, force: bool = False, base_dir: Path = Depends(get_base_dir)
) -> dict:
    """运行历史单条删除：库 `query.delete_run` 薄映射 + 消费端活性防护
    （注册表活子进程 409，force 也不例外——进程仍在写该目录）。"""
    validate_run_id(run_id)
    if runservice.reap(run_id) is not None:
        raise HTTPException(
            status_code=409,
            detail={"error": "该 run 有本 server 启动的进程在跑——先终止再删除", "run_id": run_id},
        )
    st = query_run_status(run_id, base_dir=base_dir)
    if st is not None and st.phase == "running" and not force:
        raise HTTPException(
            status_code=409,
            detail={"error": "运行进行中——先取消或用 force=true 强制删除", "run_id": run_id},
        )
    if not query.delete_run(run_id, base_dir=base_dir):
        raise _not_found(run_id)
    return {"run_id": run_id, "deleted": True}


# ------------------------------------------------------------------
# 恢复/回退 + 进程观测
# ------------------------------------------------------------------


class ResumeBody(BaseModel):
    module: str | None = None      # 缺省 = run_id（同图端点启发式）
    target: int | str | None = None  # tick 号 / "manual:<label>" / None 续最新
    spec: dict[str, Any] | None = None
    tasklist: dict[str, Any] | None = None
    max_ticks: int = 100
    mock: bool = False
    force: bool = False  # phase=running 也放行（max_ticks 截断的残留 running 态）


class PreflightBody(BaseModel):
    module: str | None = None      # 缺省 = status.json 溯源 > run_id 启发式
    target: int | str | None = None
    tasklist: dict[str, Any] | None = None  # None = 归档 tasklist（纯续跑预检）


@router.get("/{run_id}/process")
def get_process(run_id: str, base_dir: Path = Depends(get_base_dir)) -> dict:
    """resume 子进程观测：是否在跑 + 日志尾（CLI 启动失败只在这能看到）。"""
    validate_run_id(run_id)
    return runservice.process_info(run_id, base_dir)


@router.post("/{run_id}/process/terminate")
def post_terminate(run_id: str, base_dir: Path = Depends(get_base_dir)) -> dict:
    """恢复子进程硬终止：注册表握有 Popen（Windows = 硬杀）；无活进程 → 409。"""
    validate_run_id(run_id)
    try:
        return runservice.terminate_process(run_id)
    except runservice.ProcessBusyError as e:
        raise HTTPException(status_code=409, detail={"error": str(e)})


@router.post("/{run_id}/resume", status_code=202)
def post_resume(
    run_id: str, body: ResumeBody, base_dir: Path = Depends(get_base_dir)
) -> dict:
    """恢复/回退：runservice spawn 官方 CLI `resume`（校验链/编排见共享层 docstring）。"""
    validate_run_id(run_id)
    try:
        return runservice.resume_run(
            run_id, module=body.module, target=body.target, spec=body.spec,
            tasklist=body.tasklist, max_ticks=body.max_ticks, mock=body.mock,
            force=body.force, base_dir=base_dir, search=get_search_paths(base_dir))
    except runservice.RunNotFoundError:
        raise _not_found(run_id)
    except runservice.ModuleUnresolvedError as e:
        raise HTTPException(status_code=404, detail={
            "error": str(e), "run_id": run_id, "module": e.module,
            "code": "module_unresolved"})
    except runservice.ProcessBusyError as e:
        raise HTTPException(status_code=409, detail={"error": str(e), "run_id": run_id})
    except runservice.InvalidInputError as e:
        raise HTTPException(status_code=400, detail={"error": str(e), "run_id": run_id})


@router.post("/{run_id}/resume/preflight")
def post_preflight(
    run_id: str, body: PreflightBody, base_dir: Path = Depends(get_base_dir)
) -> dict:
    """恢复预检 dry-run：薄调库 check_resume_compat_from_run，不 spawn 不写状态。

    兼容性 hard_errors/warnings 是 200 正常载荷（对话框内联展示）；
    ValueError（tasklist 非法 / 模块未解析）→ 400；无 run.sqlite → 404。
    """
    validate_run_id(run_id)
    _require_run(run_id, base_dir)
    st = query_run_status(run_id, base_dir=base_dir)
    # module 解析序对齐图端点：body.module > status.json 溯源 > run_id 启发式
    module_name = body.module or (st.module if st is not None else None) or run_id
    try:
        result = query.check_resume_compat_from_run(
            module_name, run_id,
            new_tasklist=body.tasklist, target=body.target, base_dir=base_dir,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail={"error": e.args[0], "run_id": run_id})
    if result is None:
        raise _not_found(run_id)
    return result
```

- [ ] **Step 5: 全量回归**

Run: `uv run pytest tests/ -q`
Expected: 全绿（控制面端点契约不变——404/409/400 语义与载荷形状逐一对齐原实现）。
若有载荷形状断言失败：对照原 payload 修 service 消息或端点 detail，**不许改测试断言语义**。

- [ ] **Step 6: 提交**

```bash
git add server/runservice.py server/api/control.py tests/test_control_api.py
git commit -m "refactor(server): runservice 提取——spawn 编排/进程注册表共享层，control.py 端点薄化（ops agent S1）"
```

---

### Task 3: S2a 工具箱基座 + 7 个数据类工具

**Files:**
- Create: `treechat/tools/base.py`、`treechat/tools/data_tools.py`、`treechat/tools/__init__.py`
- Test: `tests/treechat/test_tools.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/treechat/test_tools.py
"""数据类工具：薄映射契约（fixture run 工件，隔离模式不触真实 ~/.specmodule）。"""
from __future__ import annotations

import pytest

from server.deps import get_search_paths
from tests.conftest import seed_run
from treechat.tools import ToolContext, all_tools, dispatch_tool


@pytest.fixture()
def ctx(base):
    """base fixture：SPECMODULE_BASE/SPECMODULE_PATH/SPECMODULE_HOME 隔离。"""
    return ToolContext(base_dir=base, search=get_search_paths(base))


def _tool(name: str):
    return next(t for t in all_tools() if t.name == name)


async def test_list_modules(ctx):
    out = await dispatch_tool(all_tools(), "list_modules", {}, ctx)
    names = [m["name"] for m in out["modules"]]
    assert "mini_graph" in names          # tests/modules/mini_graph.py（SPECMODULE_PATH）
    mini = next(m for m in out["modules"] if m["name"] == "mini_graph")
    assert set(mini) == {"name", "kind", "version", "description"}
    assert mini["kind"] == "entry"


async def test_module_detail(ctx):
    out = await dispatch_tool(all_tools(), "module_detail", {"name": "mini_graph"}, ctx)
    assert out["name"] == "mini_graph"
    assert out["default_spec"] == {"topic": "demo"}
    assert "spec_schema" in out


async def test_module_detail_unknown(ctx):
    out = await dispatch_tool(all_tools(), "module_detail", {"name": "ghost"}, ctx)
    assert "error" in out


async def test_run_module_spawns_via_runservice(ctx, monkeypatch):
    """run_module 走 runservice.launch_run（spawn 桩）——同一编排层。"""
    from server import runservice

    class FakePopen:
        pid = 4321

        def poll(self):
            return None

    monkeypatch.setattr(runservice, "_spawn", lambda argv, cwd, log_fh: FakePopen())
    out = await dispatch_tool(all_tools(), "run_module",
                              {"module": "mini_graph", "mock": True}, ctx)
    assert out["started"] is True
    assert out["run_id"].startswith("mini_graph_")


async def test_run_status_of_seeded_run(ctx, base):
    seed_run(base, "ops_r1", firings=[{"tick": 1, "node": "A", "output": "a1"}],
             status={"module_id": "mini_graph", "phase": "done", "updated_at": 2.0})
    out = await dispatch_tool(all_tools(), "run_status", {"run_id": "ops_r1"}, ctx)
    assert out["phase"] == "done"
    assert out["module_id"] == "mini_graph"


async def test_run_status_unknown(ctx):
    out = await dispatch_tool(all_tools(), "run_status", {"run_id": "ghost"}, ctx)
    assert out == {"error": "无运行记录", "run_id": "ghost"}


async def test_run_snapshot_and_timeline(ctx, base):
    seed_run(base, "ops_r2",
             firings=[{"tick": 1, "node": "A", "output": "a1"},
                      {"tick": 2, "node": "B", "output": "b1"}],
             snapshots={2: {"tick": 2, "status": "running",
                            "fireable": [], "fired": ["A", "B"]}},
             status={"module_id": "mini_graph", "phase": "done", "updated_at": 3.0})
    snap = await dispatch_tool(all_tools(), "run_snapshot", {"run_id": "ops_r2"}, ctx)
    assert snap["tick"] == 2
    tl = await dispatch_tool(all_tools(), "run_timeline", {"run_id": "ops_r2"}, ctx)
    assert len(tl["entries"]) == 2
    tl_f = await dispatch_tool(all_tools(), "run_timeline",
                               {"run_id": "ops_r2", "failed_only": True}, ctx)
    assert tl_f["entries"] == []


async def test_run_control_writes_control_file(ctx, base):
    seed_run(base, "ops_r3",
             status={"module_id": "mini_graph", "phase": "running", "updated_at": 2.0})
    out = await dispatch_tool(all_tools(), "run_control",
                              {"run_id": "ops_r3", "action": "pause"}, ctx)
    assert out["paused"] is True
    assert out["control"]["action"] == "pause"


async def test_unknown_tool(ctx):
    out = await dispatch_tool(all_tools(), "nope", {}, ctx)
    assert out == {"error": "未知工具: nope"}


async def test_handler_exception_becomes_error_dict(ctx, monkeypatch):
    async def boom(args, ctx):
        raise RuntimeError("炸了")

    tools = list(all_tools()) + [
        _tool("list_modules").__class__(name="boom", description="",
                                        parameters={"type": "object"}, handler=boom)]
    out = await dispatch_tool(tools, "boom", {}, ctx)
    assert out == {"error": "炸了"}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/treechat/test_tools.py -q`
Expected: FAIL（`treechat.tools` 不存在）。

- [ ] **Step 3: 新建 `treechat/tools/base.py`**

```python
"""工具箱基座：ToolDef / ToolContext / 注册表 / 分派（D3 两层工具箱）。

数据类工具 = 薄映射（module_harness 查询/控制 + server.runservice 编排）；
能力类工具 = call_harness 无头 module run（refine_spec，见 refine_spec.py）。
两类对 agent 循环无差别：tool = (schema, handler)，handler(args, ctx) -> dict。
成功返回载荷 dict 原样；失败 handler 可抛异常或直接返回 {"error": ...}——
dispatch_tool 统一 catch-all 兜底，工具失败永远喂回模型而不炸回合。
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable

from module_harness.infra import store

Handler = Callable[[dict, "ToolContext"], Awaitable[dict]]


@dataclass(frozen=True)
class ToolDef:
    name: str
    description: str
    parameters: dict
    """JSON Schema（OpenAI function 形）；两后端转换器统一吃 input_schema 键。"""
    handler: Handler


@dataclass(frozen=True)
class ToolContext:
    """工具执行上下文（mount 时装配；standalone 回落 home 锚定缺省）。"""

    base_dir: Path
    search: list[Path]
    """store.search_paths(base_dir)——与 server/deps 同纪律。"""
    client: Any = None
    """能力工具复用会话 LLM 客户端；数据类工具不消费。"""


def default_tool_context() -> ToolContext:
    base_dir = Path(os.environ.get("SPECMODULE_BASE") or Path.home()).resolve()
    return ToolContext(base_dir=base_dir, search=store.search_paths(base_dir))


_REGISTRY: dict[str, ToolDef] = {}


def register(tool: ToolDef) -> ToolDef:
    _REGISTRY[tool.name] = tool
    return tool


def all_tools() -> list[ToolDef]:
    """注册表快照（晚绑定：refine_spec 等后续注册自动入列）。"""
    return list(_REGISTRY.values())


def tool_schemas(tools: list[ToolDef]) -> list[dict]:
    return [{"name": t.name, "description": t.description,
             "input_schema": t.parameters} for t in tools]


async def dispatch_tool(tools: list[ToolDef], name: str, args: dict,
                        ctx: ToolContext) -> dict:
    """按名单分派（agent 循环可传自定义子集）；未知工具/异常 → error dict。"""
    tool = next((t for t in tools if t.name == name), None)
    if tool is None:
        return {"error": f"未知工具: {name}"}
    try:
        return await tool.handler(args, ctx)
    except Exception as exc:  # noqa: BLE001 —— 工具失败喂回模型，不炸回合
        return {"error": str(exc) or type(exc).__name__}
```

- [ ] **Step 4: 新建 `treechat/tools/data_tools.py`**

```python
"""数据类工具 v1（7 个）：server/api 同构的薄映射。

发起走 server.runservice（spawn 编排共享层——惰性导入：treechat 与 server 同仓库
同 venv，standalone CLI 不触达该导入）；读/控制直调 module_harness。
"""
from __future__ import annotations

from module_harness.infra import control, query, store
from module_harness.infra.status import query_run_status

from .base import ToolContext, ToolDef, register


async def _no_run(run_id: str) -> dict:
    return {"error": "无运行记录", "run_id": run_id}


async def _list_modules(args: dict, ctx: ToolContext) -> dict:
    out = []
    for _name, sources in store.list_modules(search=ctx.search).items():
        for s in sources:
            out.append({"name": s.name, "kind": s.kind, "version": s.version,
                        "description": s.description})
    out.sort(key=lambda m: (m["name"], m["kind"]))
    return {"modules": out}


async def _module_detail(args: dict, ctx: ToolContext) -> dict:
    name = args["name"]
    resolved = store.resolve_module_full(name, search=ctx.search)  # ValueError 原样
    if resolved is None:
        return {"error": f"模块 '{name}' 未找到"}
    return store.detail_to_dict(resolved)


async def _run_module(args: dict, ctx: ToolContext) -> dict:
    from server import runservice  # 惰性：见模块 docstring

    return runservice.launch_run(
        args["module"], spec=args.get("spec"), template=args.get("template"),
        run_id=args.get("run_id"), max_ticks=int(args.get("max_ticks") or 100),
        mock=bool(args.get("mock")), base_dir=ctx.base_dir, search=ctx.search)


async def _run_status(args: dict, ctx: ToolContext) -> dict:
    st = query_run_status(args["run_id"], base_dir=ctx.base_dir)
    if st is None:
        return await _no_run(args["run_id"])
    return {"module_id": st.module_id, "phase": st.phase, "status": st.status,
            "tick": st.tick, "fireable": st.fireable, "fired": st.fired,
            "outputs": st.outputs, "node_states": st.node_states,
            "error": st.error, "updated_at": st.updated_at}


async def _run_snapshot(args: dict, ctx: ToolContext) -> dict:
    # KeyError（非法 tick）由 dispatch 兜底转 error dict
    snap = query.load_snapshot_summary(args["run_id"], tick=args.get("tick"),
                                       base_dir=ctx.base_dir)
    if snap is None:
        return await _no_run(args["run_id"])
    return snap


async def _run_timeline(args: dict, ctx: ToolContext) -> dict:
    tl = query.build_timeline(args["run_id"], base_dir=ctx.base_dir)
    if tl is None:
        return await _no_run(args["run_id"])
    if args.get("failed_only"):
        tl = query.filter_failed(tl)
    if args.get("tick") is not None:
        tl = query.filter_tick(tl, int(args["tick"]))
    if args.get("node"):
        tl = query.filter_node(tl, str(args["node"]))
    return query.timeline_to_dict(tl)


async def _run_control(args: dict, ctx: ToolContext) -> dict:
    run_id = args["run_id"]
    if query_run_status(run_id, base_dir=ctx.base_dir) is None:
        return await _no_run(run_id)
    control.request_control(run_id, args["action"], reason=args.get("reason"),
                            base_dir=ctx.base_dir)  # ValueError（非法 action）原样
    req = control.read_control(run_id, base_dir=ctx.base_dir)
    return {"run_id": run_id, "control": req,
            "paused": bool(req and req.get("action") == "pause")}


register(ToolDef(
    name="list_modules",
    description="列出当前运行根可发现的全部模块（entry/packed/pip），含名称/种类/版本/描述。",
    parameters={"type": "object", "properties": {}},
    handler=_list_modules))

register(ToolDef(
    name="module_detail",
    description=("查询单个模块详情：default_spec、spec_schema（spec 字段与类型——"
                 "完善 spec 的校验锚）、templates、submodules。"),
    parameters={"type": "object",
                "properties": {"name": {"type": "string", "description": "模块名"}},
                "required": ["name"]},
    handler=_module_detail))

register(ToolDef(
    name="run_module",
    description=("发起一次模块运行：spawn 官方 CLI 子进程，立即返回 run_id"
                 "（运行在后台进行，不等待完成；进度用 run_status 查询）。"),
    parameters={"type": "object",
                "properties": {
                    "module": {"type": "string", "description": "模块名"},
                    "spec": {"type": "object", "description": "spec 字典（可选，缺省用模块 default_spec）"},
                    "template": {"type": "string", "description": "模板名（可选）"},
                    "run_id": {"type": "string", "description": "自定义 run_id（可选）"},
                    "max_ticks": {"type": "integer", "description": "tick 上限，缺省 100"},
                    "mock": {"type": "boolean", "description": "mock LLM 试运行"},
                },
                "required": ["module"]},
    handler=_run_module))

register(ToolDef(
    name="run_status",
    description="查询运行状态：phase/tick/fireable/fired/outputs/node_states。",
    parameters={"type": "object",
                "properties": {"run_id": {"type": "string"}},
                "required": ["run_id"]},
    handler=_run_status))

register(ToolDef(
    name="run_snapshot",
    description="检视运行快照摘要（缺省最新，可指定 tick）：各节点最新输出。",
    parameters={"type": "object",
                "properties": {"run_id": {"type": "string"},
                               "tick": {"type": "integer", "description": "可选 tick 号"}},
                "required": ["run_id"]},
    handler=_run_snapshot))

register(ToolDef(
    name="run_timeline",
    description="运行历史时间线：逐 tick 的节点产出/错误；可只看失败项。",
    parameters={"type": "object",
                "properties": {"run_id": {"type": "string"},
                               "failed_only": {"type": "boolean"},
                               "tick": {"type": "integer"},
                               "node": {"type": "string"}},
                "required": ["run_id"]},
    handler=_run_timeline))

register(ToolDef(
    name="run_control",
    description="运行控制：action ∈ cancel（取消）/ pause（暂停）/ unpause（继续）。",
    parameters={"type": "object",
                "properties": {"run_id": {"type": "string"},
                               "action": {"type": "string",
                                          "enum": ["cancel", "pause", "unpause"]},
                               "reason": {"type": "string", "description": "可选原因"}},
                "required": ["run_id", "action"]},
    handler=_run_control))
```

- [ ] **Step 5: 新建 `treechat/tools/__init__.py`**

```python
"""treechat 工具箱（spec 2026-09-26 D3 两层工具箱）。"""
from .base import ToolContext, ToolDef, all_tools, default_tool_context, dispatch_tool, register, tool_schemas
from . import data_tools  # noqa: F401  —— 副作用注册

__all__ = ["ToolContext", "ToolDef", "all_tools", "default_tool_context",
           "dispatch_tool", "register", "tool_schemas"]
```

- [ ] **Step 6: 跑测试确认通过**

Run: `uv run pytest tests/treechat/test_tools.py -q` → 全绿
（若 `run_status` 断言缺字段：对照 `module_harness/infra/status.py` ModuleStatus 实际字段名修正 `_run_status` 载荷——形状须与 `server/api/runs.py:48` 端点一致。）

- [ ] **Step 7: 提交**

```bash
git add treechat/tools/ tests/treechat/test_tools.py
git commit -m "feat(treechat): 工具箱基座 + 7 个数据类工具（薄映射，发起走 runservice 共享层）"
```

---

### Task 4: S2b agent 循环（agent_bridge）

**Files:**
- Create: `treechat/agent_bridge.py`
- Test: `tests/treechat/test_agent_bridge.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/treechat/test_agent_bridge.py
"""agent 循环：脚本化 chat() 假客户端——终止/工具分派/错误喂回/迭代上限/usage。"""
from __future__ import annotations

import pytest
from llm import LLMError, LLMResponse, Message

from treechat import agent_bridge
from treechat.core.conversation import Conversation
from treechat.tools.base import ToolContext, ToolDef


@pytest.fixture()
def conv(tmp_path):
    c = Conversation.create(tmp_path / "c1.jsonl", "c1", system="运营纪律")
    c.append_user("帮我看看模块")
    return c


async def _echo(args, ctx):
    return {"echo": args.get("text")}


ECHO = ToolDef(name="echo", description="回声",
               parameters={"type": "object",
                           "properties": {"text": {"type": "string"}},
                           "required": ["text"]},
               handler=_echo)


class ScriptClient:
    """chat() 按脚本弹出 LLMResponse（Exception 元素 = 抛出）；记录调用消息副本。"""

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls: list[list[Message]] = []

    async def chat(self, messages, tools=None):
        self.calls.append(list(messages))
        r = self.responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


def _call(resp: LLMResponse, name: str, args: dict) -> LLMResponse:
    resp.tool_calls = [{"id": "t1", "name": name, "arguments": args}]
    return resp


async def test_plain_reply_no_tools(conv):
    client = ScriptClient([LLMResponse(content="你好", usage={"input_tokens": 2, "output_tokens": 1})])
    outcome = await agent_bridge.run_agent_turn(conv, 0, client=client, window=None,
                                                tools=[ECHO])
    assert outcome.message_text == "你好"
    assert outcome.usage == {"input_tokens": 2, "output_tokens": 1}
    assert outcome.done is False and outcome.documents == []


async def test_system_and_history_assembled(conv):
    client = ScriptClient([LLMResponse(content="ok")])
    await agent_bridge.run_agent_turn(conv, 0, client=client, window=None, tools=[ECHO])
    msgs = client.calls[0]
    assert msgs[0].role == "system" and "模块运营台" in msgs[0].content
    assert "运营纪律" in msgs[0].content           # 会话 system 注入
    assert msgs[-1].role == "user" and msgs[-1].content == "帮我看看模块"


async def test_tool_call_loop_and_result_fed_back(conv):
    client = ScriptClient([
        _call(LLMResponse(content=""), "echo", {"text": "hi"}),
        LLMResponse(content="回声完成"),
    ])
    events: list[dict] = []
    outcome = await agent_bridge.run_agent_turn(conv, 0, client=client, window=None,
                                                tools=[ECHO],
                                                on_event=events.append)
    assert outcome.message_text == "回声完成"
    kinds = [e["event"] for e in events]
    assert kinds == ["tool_call", "tool_result"]
    assert events[0]["name"] == "echo" and events[0]["args"] == {"text": "hi"}
    assert events[1]["ok"] is True
    # 第二次调用的消息含 assistant(tool_calls) + tool 结果
    second = client.calls[1]
    assert second[-2].role == "assistant" and second[-2].tool_calls[0]["id"] == "t1"
    assert second[-1].role == "tool"
    assert '"echo"' in second[-1].content


async def test_tool_error_becomes_result_not_crash(conv):
    client = ScriptClient([
        _call(LLMResponse(content=""), "echo", {}),
        LLMResponse(content="已处理错误"),
    ])
    events: list[dict] = []

    async def boom(args, ctx):
        raise RuntimeError("炸了")

    tools = [ToolDef(name="echo", description="", parameters={"type": "object"},
                     handler=boom)]
    outcome = await agent_bridge.run_agent_turn(conv, 0, client=client, window=None,
                                                tools=tools, on_event=events.append)
    assert outcome.message_text == "已处理错误"
    assert events[1]["ok"] is False
    assert "炸了" in client.calls[1][-1].content


async def test_unknown_tool_fed_back(conv):
    client = ScriptClient([
        _call(LLMResponse(content=""), "nope", {}),
        LLMResponse(content="没有这个工具"),
    ])
    events: list[dict] = []
    await agent_bridge.run_agent_turn(conv, 0, client=client, window=None,
                                      tools=[ECHO], on_event=events.append)
    assert events[1]["ok"] is False
    assert "未知工具" in client.calls[1][-1].content


async def test_iteration_cap(conv):
    responses = [_call(LLMResponse(content=""), "echo", {"text": "x"})
                 for _ in range(agent_bridge.MAX_ITERATIONS)]
    client = ScriptClient(responses)
    outcome = await agent_bridge.run_agent_turn(conv, 0, client=client, window=None,
                                                tools=[ECHO])
    assert "上限" in outcome.message_text
    assert len(client.calls) == agent_bridge.MAX_ITERATIONS


async def test_llm_error_propagates(conv):
    client = ScriptClient([LLMError("模拟基础设施故障")])
    with pytest.raises(LLMError):
        await agent_bridge.run_agent_turn(conv, 0, client=client, window=None,
                                          tools=[ECHO])


async def test_usage_accumulates(conv):
    client = ScriptClient([
        _call(LLMResponse(content="", usage={"input_tokens": 3, "output_tokens": 1}),
              "echo", {"text": "x"}),
        LLMResponse(content="done", usage={"input_tokens": 5, "output_tokens": 2}),
    ])
    outcome = await agent_bridge.run_agent_turn(conv, 0, client=client, window=None,
                                                tools=[ECHO])
    assert outcome.usage == {"input_tokens": 8, "output_tokens": 3}


async def test_summarize_result():
    assert agent_bridge.summarize_result("run_module", {"run_id": "m_abc"})
    assert "已发起" in agent_bridge.summarize_result("run_module", {"run_id": "m_abc"})
    assert "error 描述" in agent_bridge.summarize_result("x", {"error": "error 描述"})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/treechat/test_agent_bridge.py -q` → FAIL（模块不存在）。

- [ ] **Step 3: 新建 `treechat/agent_bridge.py`（完整内容）**

```python
"""agent_bridge —— ops 模式的回合执行体：纯 Python 工具调用循环（spec D2）。

不走 harness：harness body 只会调单轮 complete()，而循环的本质是累积 messages
（含 tool 角色）喂回模型（llm 包 chat() 多轮接口）。统一性保留在 chat 层契约：
分派/锁/持久化/SSE 词汇/LLMError 语义与 harness 模式一致。
"""
from __future__ import annotations

import json
from typing import Any

from llm import LLMError, Message

from .core.context import assemble
from .module_bridge import OnEvent, TurnOutcome, _merge_usage
from .tools.base import ToolContext, ToolDef, all_tools, default_tool_context, dispatch_tool, tool_schemas

MAX_ITERATIONS = 12
"""单回合工具迭代上限（触顶收束，防模型空转烧 token）。"""

AGENT_SYSTEM = """\
你是 SpecModule 模块运营台：通过工具查看模块库、完善 spec、发起与监控运行、控制运行。
纪律：
- 运行状态永远通过工具新鲜获取，绝不编造 run 的 phase/tick/输出；
- run_module 立即返回 run_id（运行在后台子进程进行，不等待完成）；终文必须包含 run_id；
- 工具返回 {"error": ...} 时如实向用户转述，同一操作不要重试超过一次；
- 回答保持简洁中文；一次只做用户要求的事，不额外发起运行。
"""


def build_messages(conv, user_seq: int, window) -> list[Message]:
    """assemble 复用（pinned 卡注入 system，与 module_bridge.build_spec 同源）。"""
    pinned = [c for c in conv.cards.pinned_cards()
              if c.owner_seq is None and not c.id.startswith("spec:")]
    ctx = assemble(conv.path_to(user_seq), conv.system, pinned, strategy=window)
    messages: list[Message] = []
    system = AGENT_SYSTEM + ("\n\n" + ctx.system if ctx.system else "")
    messages.append(Message(role="system", content=system))
    for m in ctx.history:
        messages.append(Message(role=m["role"], content=m["content"]))
    messages.append(Message(role="user", content=ctx.current))
    return messages


def summarize_result(name: str, result: Any) -> str:
    """tool_result 帧的渲染摘要（全量载荷不回传前端）。"""
    if isinstance(result, dict) and "error" in result:
        return str(result["error"])[:200]
    if name == "list_modules":
        return f"{len(result.get('modules', []))} 个模块"
    if name == "module_detail":
        return f"模块 {result.get('name', '?')}"
    if name == "run_module":
        return f"run {result.get('run_id')} 已发起"
    if name == "run_status":
        return f"phase={result.get('phase', '?')} tick={result.get('tick', '?')}"
    if name == "run_snapshot":
        return f"tick={result.get('tick', '?')} 快照"
    if name == "run_timeline":
        return f"{len(result.get('entries', []))} 条时间线"
    if name == "run_control":
        action = (result.get("control") or {}).get("action")
        return f"控制请求 {action or ''} 已写入"
    if name == "refine_spec":
        return f"spec 已完善（{len(result.get('spec', {}))} 字段）"
    return json.dumps(result, ensure_ascii=False)[:200]


async def run_agent_turn(conv, user_seq: int, *, client: Any, window,
                         tool_context: ToolContext | None = None,
                         tools: list[ToolDef] | None = None,
                         on_event: OnEvent | None = None) -> TurnOutcome:
    """一次 ops 回合 = 工具调用循环。LLMError 上抛（悬而未答轮，retry 契约同
    harness 模式）；工具失败永远喂回模型（model-recoverable），不炸回合。"""
    emit = on_event or (lambda evt: None)
    ctx = tool_context or default_tool_context()
    tool_list = tools if tools is not None else all_tools()
    schemas = tool_schemas(tool_list)
    messages = build_messages(conv, user_seq, window)
    usage_total: dict[str, int] = {}

    for _ in range(MAX_ITERATIONS):
        resp = await client.chat(messages, tools=schemas)
        _merge_usage(usage_total, resp.usage)
        if not resp.tool_calls:
            return TurnOutcome(message_text=resp.content, usage=usage_total)
        messages.append(Message(role="assistant", content=resp.content,
                                tool_calls=resp.tool_calls))
        for tc in resp.tool_calls:   # 顺序执行（v1；会话锁本就串行化回合）
            name = str(tc.get("name", ""))
            args = tc.get("arguments") or {}
            emit({"event": "tool_call", "id": tc["id"], "name": name, "args": args})
            result = await dispatch_tool(tool_list, name, args, ctx)
            run_id = result.get("run_id") if isinstance(result, dict) else None
            emit({"event": "tool_result", "id": tc["id"], "name": name,
                  "ok": not (isinstance(result, dict) and "error" in result),
                  "summary": summarize_result(name, result),
                  "runId": run_id if isinstance(run_id, str) else None})
            messages.append(Message(role="tool", tool_call_id=tc["id"],
                                    content=json.dumps(result, ensure_ascii=False)))
    return TurnOutcome(
        message_text="已达单轮工具调用上限（12）。请拆分操作，或开新轮继续。",
        usage=usage_total)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/treechat/test_agent_bridge.py -q` → 全绿
（若 `treechat.module_bridge` 无 `OnEvent` 导出名：它定义于 module_bridge.py:23，直接 `from .module_bridge import OnEvent` 可用；若 `_merge_usage` 未导出则同文件内直接使用。）

- [ ] **Step 5: 提交**

```bash
git add treechat/agent_bridge.py tests/treechat/test_agent_bridge.py
git commit -m "feat(treechat): agent_bridge 工具循环——chat() 多轮 + 迭代上限 + 错误喂回（ops agent S2b）"
```

---

### Task 5: S2c+S3 AgentMode、回合分派、ToolContext 贯通、webapp SSE 集成

**Files:**
- Create: `treechat/modules/agent.py`、`tests/treechat/test_agent_turn.py`
- Modify: `treechat/modules/__init__.py`、`treechat/session.py`、`treechat/webapp/registry.py`、`treechat/webapp/app.py`、`server/chat.py`、`tests/treechat/test_modules.py`

- [ ] **Step 1: 新建 `treechat/modules/agent.py`**

```python
"""ops 模式定义 —— agent 形态模式（非 harness，spec D2）。

AgentMode 不是 ConversationalModule：不走 module_bridge 固定管线，回合由
agent_bridge 工具循环执行。只暴露 webapp SSE start 帧消费的元数据形状
（key/display_name/description/node_order/node_label）。
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class AgentMode:
    key: str
    display_name: str
    description: str
    node_order: list[str]
    node_labels: dict[str, str] = field(default_factory=dict)

    def node_label(self, key: str) -> str:
        return self.node_labels.get(key, key)


AGENT_MODE = AgentMode(
    key="ops", display_name="模块运营",
    description="对话式运营业务模块：查看模块库、完善 spec、发起运行、监控与控制。",
    node_order=["ops"], node_labels={"ops": "助手"})
```

- [ ] **Step 2: 改 `treechat/modules/__init__.py`（完整内容）**

```python
"""嵌入式对话型模块注册表（spec §4）—— treechat 对 harness 的内部组织，不对外发现。"""
from __future__ import annotations

from .agent import AGENT_MODE, AgentMode
from .base import ConversationalModule, DocumentDef, FieldStreamShaper
from .direct import DIRECT
from .grilling import GRILLING

__all__ = ["BUILT_IN", "DEFAULT_MODE_MAP", "AGENT_MODE", "AgentMode",
           "ConversationalModule", "DocumentDef", "FieldStreamShaper",
           "resolve_module"]

BUILT_IN: dict[str, ConversationalModule | AgentMode] = {
    "direct": DIRECT, "grilling": GRILLING, "ops": AGENT_MODE,
}
DEFAULT_MODE_MAP: dict[str, str] = {"grilling": "grilling", "ops": "ops"}


def resolve_module(category: str,
                   mode_modules: dict[str, str] | None = None) -> ConversationalModule | AgentMode:
    """会话 category（模式 key）→ 模式定义。

    内建 key 直查（identity——内建模式不经映射表也能命中，防嵌入方自定义
    mode_modules 覆盖掉 ops）；其余走映射表，未知/缺省回落直答（spec §4）。
    """
    if category in BUILT_IN:
        return BUILT_IN[category]
    mapping = DEFAULT_MODE_MAP if mode_modules is None else mode_modules
    name = mapping.get(category or "", "direct")
    return BUILT_IN.get(name, DIRECT)
```

- [ ] **Step 3: 改 `treechat/session.py`**

3a. 字段与构造（`TreeChatSession` dataclass）：

```python
from .modules import AgentMode, ConversationalModule, resolve_module
from . import agent_bridge, llm_bridge, module_bridge
```

`TreeChatSession` 加字段（放 `mode_modules` 之后）：

```python
    tool_context: Any = None
    """ops 回合的工具执行上下文（ToolContext；None = agent_bridge 内回落缺省）。"""
```

`create` / `open` 类方法签名加 `tool_context: Any = None` 参数，构造传
`tool_context=tool_context`。

3b. `module_for` 返回注解放宽：

```python
    def module_for(self, user_seq: int) -> ConversationalModule | AgentMode:
```

3c. `complete_outcome` 分派——把：

```python
        module = self.module_for(user_seq)
        outcome = await module_bridge.run_turn(
            module, conv, user_seq, client=self.client, window=self.window,
            on_event=on_event or (lambda evt: None))
```

替换为：

```python
        module = self.module_for(user_seq)
        if isinstance(module, AgentMode):
            outcome = await agent_bridge.run_agent_turn(
                conv, user_seq, client=self.client, window=self.window,
                tool_context=self.tool_context,
                on_event=on_event or (lambda evt: None))
        else:
            outcome = await module_bridge.run_turn(
                module, conv, user_seq, client=self.client, window=self.window,
                on_event=on_event or (lambda evt: None))
```

（ops 回合 `outcome.done` 恒 False、`documents` 空——后续落盘逻辑零改动。）

- [ ] **Step 4: 改 `treechat/webapp/registry.py`**

```python
    def __init__(self, config: TreeChatConfig,
                 client_factory: ClientFactory | None = None,
                 tool_context: Any = None) -> None:
        self.config = config
        self.tool_context = tool_context
        self._client_factory: ClientFactory = client_factory or self._default_factory
        self._sessions: dict[str, TreeChatSession] = {}
        self._locks: dict[str, asyncio.Lock] = {}
```

`get` / `create` 两处 `TreeChatSession(conversation=..., client=..., mode_modules=self.config.mode_modules)` 追加 `tool_context=self.tool_context`。

- [ ] **Step 5: 改 `treechat/webapp/app.py` 工厂签名**

```python
def create_app(config: TreeChatConfig | None = None, *,
               client_factory: Any = None,
               static_dir: Path | None = None,
               tool_context: Any = None) -> FastAPI:
    config = config or TreeChatConfig()
    registry = SessionRegistry(config, client_factory, tool_context=tool_context)
```

- [ ] **Step 6: 改 `server/chat.py` mount 装配（`mount_chat` 内，`sub = create_app(...)` 前）**

```python
    from module_harness.infra import store as mh_store
    from treechat.tools import ToolContext

    # ops 工具上下文：与 server 同一 base_dir/搜索路径纪律（deps 同款解析）
    tool_context = ToolContext(base_dir=root, search=mh_store.search_paths(root))
    sub = create_app(config, client_factory=client_factory,
                     static_dir=_DISABLED_STATIC, tool_context=tool_context)
```

- [ ] **Step 7: `tests/treechat/test_modules.py` 追加 resolve 用例**

```python
def test_builtin_identity_and_ops():
    """内建 key 直查（identity）——ops/grilling 不经映射表也命中；未知回落直答。"""
    assert resolve_module("ops").key == "ops"
    assert resolve_module("grilling").key == "grilling"
    assert resolve_module("").key == "direct"
    assert resolve_module("zzz").key == "direct"
    assert resolve_module("mycat", {"mycat": "grilling"}).key == "grilling"
```

- [ ] **Step 8: 写 webapp SSE 集成测试 `tests/treechat/test_agent_turn.py`**

```python
"""ops 回合（agent 循环）SSE 集成：脚本化 chat() 假客户端 → 帧序列断言。"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from llm import LLMError, LLMResponse

from treechat.config import TreeChatConfig
from treechat.webapp.app import create_app


class FakeAgentClient:
    """chat() 脚本化假客户端（Exception 元素 = 抛出）；complete 供健康探测。"""

    def __init__(self, responses) -> None:
        self.responses = list(responses)
        self.calls: list[list] = []
        self.config = type("Config", (), {"model": "fake-model"})()

    async def complete(self, **kwargs):
        return LLMResponse(content="ok")

    async def chat(self, messages, tools=None):
        self.calls.append(list(messages))
        r = self.responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


def _frames(client: TestClient, url: str, **kw) -> list[tuple[str, dict | None]]:
    events: list[tuple[str, dict | None]] = []
    event = data_raw = ""
    with client.stream("POST", url, **kw) as resp:
        assert resp.status_code == 200
        for line in resp.iter_lines():
            if line.startswith("event: "):
                event = line[7:]
            elif line.startswith("data: "):
                data_raw += line[6:]
            elif line == "" and event:
                events.append((event, json.loads(data_raw) if data_raw else None))
                event = data_raw = ""
    return events


def _by_event(frames):
    out: dict[str, list] = {}
    for e, d in frames:
        out.setdefault(e, []).append(d)
    return out


def _make_client(tmp_path, responses):
    fake = FakeAgentClient(responses)
    config = TreeChatConfig(data_dir=tmp_path)
    client = TestClient(create_app(config, client_factory=lambda model=None: fake))
    client.fake = fake  # type: ignore[attr-defined]
    return client


def test_ops_turn_frame_sequence(tmp_path):
    client = _make_client(tmp_path, [
        LLMResponse(content="", tool_calls=[
            {"id": "t1", "name": "list_modules", "arguments": {}}],
            usage={"input_tokens": 3, "output_tokens": 1}),
        LLMResponse(content="模块清单已列出。", usage={"input_tokens": 5, "output_tokens": 2}),
    ])
    client.post("/api/sessions", json={"name": "s1", "category": "ops"})
    frames = _frames(client, "/api/sessions/s1/turn", json={"text": "看看有什么模块"})
    by = _by_event(frames)
    assert frames[0][0] == "start"
    assert by["start"][0]["module"] == "ops"
    assert by["start"][0]["nodes"] == [{"key": "ops", "label": "助手"}]
    assert by["tool_call"][0] == {"id": "t1", "name": "list_modules", "args": {}}
    assert by["tool_result"][0]["ok"] is True
    assert by["tool_result"][0]["summary"].endswith("个模块")
    assert "done" in by
    done = by["done"][0]
    assert done["done"] is False                       # ops 轮不触发自动退出 category
    nodes = done["state"]["nodes"]
    assert any(n["output"] == "模块清单已列出。" for n in nodes)
    state = done["state"]
    assert state["category"] == "ops"
    # 第二次 chat 的消息含 tool 角色（结果喂回）
    second = client.fake.calls[1]
    assert any(m.role == "tool" and m.tool_call_id == "t1" for m in second)


def test_per_turn_module_override(tmp_path):
    """会话默认 direct，单轮 module="ops" 也能分派 agent 循环。"""
    client = _make_client(tmp_path, [LLMResponse(content="ops 回复")])
    client.post("/api/sessions", json={"name": "s1"})
    frames = _frames(client, "/api/sessions/s1/turn",
                     json={"text": "hi", "module": "ops"})
    assert _by_event(frames)["start"][0]["module"] == "ops"


def test_tool_error_fed_back(tmp_path):
    client = _make_client(tmp_path, [
        LLMResponse(content="", tool_calls=[
            {"id": "t1", "name": "run_status", "arguments": {"run_id": "ghost"}}]),
        LLMResponse(content="查无此 run。"),
    ])
    client.post("/api/sessions", json={"name": "s1", "category": "ops"})
    frames = _frames(client, "/api/sessions/s1/turn", json={"text": "查 ghost"})
    by = _by_event(frames)
    assert by["tool_result"][0]["ok"] is False
    tool_msg = next(m for m in client.fake.calls[1] if m.role == "tool")
    assert "error" in tool_msg.content


def test_llm_error_leaves_unanswered(tmp_path):
    client = _make_client(tmp_path, [LLMError("模拟基础设施故障")])
    client.post("/api/sessions", json={"name": "s1", "category": "ops"})
    frames = _frames(client, "/api/sessions/s1/turn", json={"text": "hi"})
    by = _by_event(frames)
    assert "error" in by
    assert by["error"][0]["state"]["unanswered"] is not None   # 悬而未答可 retry
```

- [ ] **Step 9: 跑新测试 + treechat 全套回归**

Run: `uv run pytest tests/treechat/test_agent_turn.py tests/treechat/test_modules.py -q` → 全绿
Run: `uv run pytest tests/ -q` → 全绿

- [ ] **Step 10: 提交**

```bash
git add treechat/modules/ treechat/session.py treechat/webapp/ server/chat.py tests/treechat/
git commit -m "feat(treechat): ops 模式落地——AgentMode 分派 + ToolContext 贯通 + SSE tool 帧集成（ops agent S2c/S3）"
```

---

### Task 6: S4 前端——工具块渲染 + WS 实时进度 + run 跳转

**Files:**
- Modify: `web/src/chat/types.ts`、`web/src/App.tsx`、`web/src/chat/ChatView.tsx`

- [ ] **Step 1: `web/src/chat/types.ts` 追加 ToolStep 并扩展 RunTrace**

```ts
/** 工具步骤（ops 回合；tool_call/tool_result 帧，瞬态不持久化） */
export interface ToolStep {
  id: string;
  name: string;
  /** JSON.stringify(args) 原文（折叠展示） */
  args: string;
  status: "running" | "ok" | "failed";
  summary: string;
  /** 非空 = 该工具发起了 run（块内订阅 WS 实时进度） */
  runId: string | null;
}
```

`RunTrace` 增加 `tools: ToolStep[];`（注释：ops 回合的工具轨迹；harness 回合恒空）。

- [ ] **Step 2: `web/src/App.tsx`——start 帧初始化 + handleEvent 工具帧**

`start` 分支的 `updRun` 对象里追加 `tools: []`（`nodes: d.nodes.map(...)` 同级）。

`handleEvent` 的 `node_end` 与 `done` 分支之间插入：

```ts
    } else if (ev.event === "tool_call") {
      updRun(sid, (r) => r && { ...r, tools: [...(r.tools ?? []), {
        id: d.id, name: d.name, args: JSON.stringify(d.args ?? {}),
        status: "running" as const, summary: "", runId: null }] });
    } else if (ev.event === "tool_result") {
      updRun(sid, (r) => r && { ...r, tools: (r.tools ?? []).map((t) =>
        t.id === d.id ? { ...t, status: d.ok ? "ok" as const : "failed" as const,
                          summary: d.summary ?? "", runId: d.runId ?? null } : t) });
```

（注意：插入后原有 `} else if (ev.event === "done") {` 分支保持不动。）

- [ ] **Step 3: `web/src/chat/ChatView.tsx`——Props + RunBlock 工具区**

3a. Props 接口加：

```ts
  /** 工具块 runId 点击：打开 RunView 页签 */
  onOpenRun: (runId: string) => void;
```

3b. import 区加 `import { useRunStream } from "../ws";` 和 `import type { ToolStep } from "./types";`（ToolStep 并入现有 types import）。

3c. `RunBlock`（`ChatView.tsx:226`）签名改 `function RunBlock({ run, onLocateDoc, onOpenRun }: { run: RunTrace; onLocateDoc: (seq: number) => void; onOpenRun: (rid: string) => void })`；标题行下方、节点列表之前插入工具区：

```tsx
      {(run.tools?.length ?? 0) > 0 && (
        <div className="flex flex-col gap-1.5">
          {run.tools!.map((t) => (
            <ToolItem key={t.id} step={t} onOpenRun={onOpenRun} />
          ))}
        </div>
      )}
```

调用点 `p.run && <RunBlock run={p.run} onLocateDoc={p.onLocateDoc} />` 改为
`p.run && <RunBlock run={p.run} onLocateDoc={p.onLocateDoc} onOpenRun={p.onOpenRun} />`。

3d. 文件末尾追加两个组件：

```tsx
/** 工具步骤块：名称 + 结果摘要；args 折叠；runId 块内订阅 WS 实时进度并可跳转 */
function ToolItem({ step, onOpenRun }: { step: ToolStep; onOpenRun: (rid: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-panel border border-border/50 bg-background px-2.5 py-1.5">
      <button onClick={() => setOpen((v) => !v)}
              className="flex w-full items-center gap-1.5 text-left text-[12px]">
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
          {step.status === "failed" ? (
            <X className="h-3 w-3 text-[var(--ph-aborted)]" strokeWidth={3} />
          ) : step.status === "ok" ? (
            <Check className="h-3 w-3 text-[var(--ph-done)]" strokeWidth={3} />
          ) : (
            <Circle className="h-3 w-3 animate-pulse text-muted-foreground/50" />
          )}
        </span>
        <span className="shrink-0 font-mono text-foreground/80">{step.name}</span>
        <span className={cn("min-w-0 flex-1 truncate",
                            step.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
          {step.summary}
        </span>
      </button>
      {open && (
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-control bg-secondary/60 px-2 py-1 text-[11px] text-muted-foreground">
          {step.args}
        </pre>
      )}
      {step.runId && <RunProgress runId={step.runId} onOpenRun={onOpenRun} />}
    </div>
  );
}

/** runId 内嵌进度：复用 useRunStream（按 runId 打包/防陈旧流；终态停连） */
function RunProgress({ runId, onOpenRun }: { runId: string; onOpenRun: (rid: string) => void }) {
  const st = useRunStream(runId);
  const phase = st?.msg.phase ?? "…";
  return (
    <button onClick={() => onOpenRun(runId)}
            className="mt-1 flex w-full items-center gap-1.5 rounded-control bg-primary/[0.06] px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-primary/10">
      <span className="font-mono">{runId}</span>
      <span>phase={phase}</span>
      {st?.msg.tick != null && <span>tick={st.msg.tick}</span>}
      <span className="ml-auto shrink-0 text-primary">打开运行视图 →</span>
    </button>
  );
}
```

- [ ] **Step 4: `web/src/App.tsx` ChatView 调用处传 onOpenRun**

定位 `<ChatView`（grep `web/src/App.tsx` 中 `<ChatView`），props 追加 `onOpenRun={openRunTab}`（`openRunTab` 定义于 App.tsx:187）。

- [ ] **Step 5: build 门禁 + 手工冒烟**

Run: `cd web && npm run build` → tsc 零错误 + vite build 成功。

手工冒烟（后端起 `uv run uvicorn server.app:app --port 8000`，前端 `npm run dev`）：ops 会话发「看看有什么模块」→ 工具块出现 `list_modules` ✓ summary → 终文渲染。

- [ ] **Step 6: 提交**

```bash
git add web/src/chat/types.ts web/src/App.tsx web/src/chat/ChatView.tsx
git commit -m "feat(web): ops 回合工具块——tool_call/tool_result 渲染 + runId WS 实时进度 + RunView 跳转（ops agent S4）"
```

---

### Task 7: S5 refine_spec 能力工具（能力类样例）

**Files:**
- Create: `treechat/tools/refine_spec.py`
- Modify: `treechat/tools/__init__.py`（一行 import）
- Test: `tests/treechat/test_refine_spec.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/treechat/test_refine_spec.py
"""refine_spec：call_harness 无头 module run（能力类工具样例，D3）。"""
from __future__ import annotations

import json

import pytest

from server.deps import get_search_paths
from treechat.tools import ToolContext, all_tools, dispatch_tool


class FakeRefineClient:
    """complete 返回固定 spec JSON（走 call_harness 校验路径）。"""

    async def complete(self, **kwargs):
        return type("R", (), {"value": {"topic": "量子纠缠", "style": "科普"}})()


async def test_refine_spec_returns_spec(tmp_path):
    ctx = ToolContext(base_dir=tmp_path, search=get_search_paths(tmp_path),
                      client=FakeRefineClient())
    out = await dispatch_tool(all_tools(), "refine_spec",
                              {"module": "mini_graph", "draft": "写一篇量子纠缠科普"}, ctx)
    assert out == {"spec": {"topic": "量子纠缠", "style": "科普"}}


async def test_refine_spec_unknown_module(tmp_path):
    ctx = ToolContext(base_dir=tmp_path, search=get_search_paths(tmp_path),
                      client=FakeRefineClient())
    out = await dispatch_tool(all_tools(), "refine_spec",
                              {"module": "ghost", "draft": "x"}, ctx)
    assert "error" in out


async def test_refine_spec_requires_client(tmp_path):
    ctx = ToolContext(base_dir=tmp_path, search=get_search_paths(tmp_path))
    out = await dispatch_tool(all_tools(), "refine_spec",
                              {"module": "mini_graph", "draft": "x"}, ctx)
    assert "error" in out
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/treechat/test_refine_spec.py -q` → FAIL（无 refine_spec 工具）。

- [ ] **Step 3: 新建 `treechat/tools/refine_spec.py`（完整内容）**

```python
"""refine_spec —— 能力类工具样例：call_harness 单节点无头 module run（spec D3）。

吃结构化参数（module + draft）、吐结构化结果（完整 spec dict）；不挂会话上下文、
不做文档卡（与 ConversationalModule 的对话职责划界）。spec_schema 来自
module_detail——schema 是完善 spec 的校验锚。写成型后可提升进 store，
与业务 module 的 submodule 成为同一类资产。
"""
from __future__ import annotations

from module_harness import call_harness
from module_harness.core.config import HarnessConfig
from module_harness.core.outputfmt import OutputFormat
from module_harness.infra import store

from .base import ToolContext, ToolDef, register
from ..core.errors import TreeChatError

REFINE_HARNESS_CONFIG = HarnessConfig(
    prompt_core="""\
你是 spec 完善器。把用户草稿完善成符合目标模块 spec_schema 的完整 spec。

## 目标模块
{module}

## spec_schema（字段与类型）
{schema}

## 用户草稿
{draft}

## 补充要求
{requirements}

要求：按 schema 字段补全 spec；草稿未覆盖的字段按合理缺省填写；
不得输出 schema 之外的字段。
""",
    prompt_modes={"default": "按核心模板执行。"},
    output_format=OutputFormat(
        type="json_object",
        instruction="输出 JSON 对象：键为 spec 的各字段，值为符合 schema 类型的值",
    ),
    notdo=["不要在 JSON 之外输出任何文字"],
)


async def _refine_spec(args: dict, ctx: ToolContext) -> dict:
    if ctx.client is None:
        return {"error": "无 LLM 客户端（能力工具需要模型调用）"}
    name = args["module"]
    resolved = store.resolve_module_full(name, search=ctx.search)  # ValueError 原样
    if resolved is None:
        return {"error": f"模块 '{name}' 未找到"}
    detail = store.detail_to_dict(resolved)
    result = await call_harness(
        REFINE_HARNESS_CONFIG,
        {"module": name, "schema": detail.get("spec_schema") or {},
         "draft": str(args.get("draft") or ""),
         "requirements": str(args.get("requirements") or "无")},
        llm_client=ctx.client,
        promptmode="default",
    )
    value = result.value
    if not isinstance(value, dict):
        raise TreeChatError(f"spec 完善输出不是 JSON 对象: {value!r}")
    return {"spec": value}


register(ToolDef(
    name="refine_spec",
    description=("把草稿需求完善成符合目标模块 spec_schema 的完整 spec"
                 "（LLM 结构化调用；可先用 module_detail 查 schema）."),
    parameters={"type": "object",
                "properties": {
                    "module": {"type": "string", "description": "目标模块名"},
                    "draft": {"type": "string",
                              "description": "草稿需求（自然语言或部分 spec）"},
                    "requirements": {"type": "string", "description": "补充要求（可选）"},
                },
                "required": ["module", "draft"]},
    handler=_refine_spec))
```

- [ ] **Step 4: `treechat/tools/__init__.py` 注册 refine_spec**

import 区 `from . import data_tools` 行后加：

```python
from . import refine_spec  # noqa: F401  —— 能力类工具注册
```

- [ ] **Step 5: 跑测试确认通过 + 全量回归**

Run: `uv run pytest tests/treechat/test_refine_spec.py -q` → 全绿
Run: `uv run pytest tests/ -q` → 全绿

- [ ] **Step 6: 提交**

```bash
git add treechat/tools/refine_spec.py treechat/tools/__init__.py tests/treechat/test_refine_spec.py
git commit -m "feat(treechat): refine_spec 能力工具——call_harness 无头 module run，spec 完善收口（ops agent S5）"
```

---

### Task 8: 收尾——全量验证 + 端到端验收 + 文档归档

**Files:**
- Modify: `roadmap/roadmap.md`、`roadmap/finish.md`

- [ ] **Step 1: 全量测试 + 库基线 + 前端门禁**

```bash
uv run pytest tests/ -q                       # 本仓库全绿
uv run pytest ../SpecModule/module_harness/tests/ -q -m "not smoke"   # 库基线全绿
cd web && npm run build                       # tsc + vite 成功
```

- [ ] **Step 2: 端到端手工验收（真实 server + mock run，无需 API key）**

```bash
uv run uvicorn server.app:app --port 8000     # 终端 1
cd web && npm run dev                          # 终端 2
```

浏览器验收清单（对应 spec「端到端验收场景」）：
1. 新建会话选模式「模块运营」→ 发「看看有什么模块」→ 工具块 `list_modules` ✓、终文列模块。
2. 发「用 academic_writer 写一篇关于 X 的短文，spec 帮我完善，mock 试运行」→
   预期链：`module_detail` → `refine_spec` →（终文含 spec 摘要）→ 用户确认后
   「可以，跑起来」→ `run_module`（mock: true）→ 工具块出现 run_id + phase 实时行
   → Runs 页签同步出现该 run → 点工具块跳 RunView。
3. 发「先暂停」→ `run_control pause`；发「现在什么状态」→ `run_status` phase=paused；
   发「继续」→ unpause；「取消掉」→ cancel。
4. 回归：direct/grilling 会话行为不变（固定管线回合、token 流式照常）。

- [ ] **Step 3: roadmap/finish.md 归档**

- `roadmap/roadmap.md`「TreeChat 后续」节：六条切片勾掉已完成者，剩余仅留真实
  后排项（S0 若未做则保留一行说明 fallback 生效状态）。
- `roadmap/finish.md` 追加落地条目：ops agent（设计 spec 链接 + 切片清单 +
  上游两提交哈希 + 「组件提升 store」后排备注）。

- [ ] **Step 4: 提交**

```bash
git add roadmap/
git commit -m "docs: ops agent 落地归档——roadmap 切片勾选 + finish.md 记录"
```

---

## 计划自审记录

- **Spec 覆盖**：D1（MCP 不采用——纯决策，无代码）→ Task 2/3 的 runservice 共享与薄映射是其落地对照；D2 循环 → Task 4；D3 两层工具箱 → Task 3 + Task 7；D4 不阻塞 → `run_module` 秒回（Task 2/3）+ 前端 WS（Task 6）；D5 编排统一 → Task 2。S0→T1、S1→T2、S2→T3/4/5、S3→T5、S4→T6、S5→T7；验收与归档 → T8。无缺口。
- **占位符扫描**：无 TBD/「适当处理」；所有代码步骤给出完整代码。
- **类型一致性**：`ToolContext(base_dir, search, client)`（T3 定义，T5/T7 消费一致）；`dispatch_tool(tools, name, args, ctx)`（T3 定义，T4/T7 调用一致）；`run_agent_turn(conv, user_seq, *, client, window, tool_context, tools, on_event)`（T4 定义，T5 session 分派一致）；`AgentMode(key, display_name, description, node_order, node_label())`（T5 定义，webapp start 帧消费一致）；SSE 帧 `tool_call{id,name,args}` / `tool_result{id,name,ok,summary,runId}`（T4 发射 = T6 消费一致）。
