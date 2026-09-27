# server/runservice.py
"""运行编排共享层：spawn 官方 CLI 子进程 + 内存进程注册表。

server/api/control.py（HTTP 端点）与 treechat ops agent 工具共用——单一注册表、
单一 spawn 模型（treechat 发起的 run 即刻进 Runs 页签，被既有 WS 流监控）。
注册表内存语义：单写者防重入（同 run 双 resume → 409）；server 重启丢注册表
不影响子进程继续跑（监控只依赖落盘产物）。
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

    def __init__(self, run_id: str) -> None:
        self.run_id = run_id
        super().__init__(f"无运行记录: {run_id}")


class RunExistsError(RunServiceError):
    """run 目录已存在（防覆盖历史）。"""

    def __init__(self, message: str, run_id: str) -> None:
        self.run_id = run_id
        super().__init__(message)


class ProcessBusyError(RunServiceError):
    """注册表互斥冲突 / 运行进行中 / 无被跟踪进程。"""

    def __init__(self, message: str, run_id: str | None = None) -> None:
        self.run_id = run_id
        super().__init__(message)


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
    log_fh.close()  # 父进程这份句柄关闭（子进程持继承句柄继续写；process_info 独立重开读）
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
        raise ProcessBusyError("该 run_id 已有运行进程在跑", run_id)

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
        raise ProcessBusyError("该 run 已有恢复进程在跑", run_id)
    st = query_run_status(run_id, base_dir=base_dir)
    if st is not None and st.phase == "running" and not force:
        raise ProcessBusyError("运行进行中——先取消/暂停再恢复", run_id)
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
