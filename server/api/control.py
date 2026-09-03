# server/api/control.py
"""控制面端点：运行控制（cancel/pause/unpause）+ 发起运行 + 恢复/回退 + 进程观测。

- control 两端点 = 库 `control.request_control`/`read_control` 薄映射
  （控制文件协议，见库 api.md `module_harness.control`）。
- `GET /inputs` = 库 `query.read_module_inputs` 薄映射（resume 预填）。
- `POST /runs` / `POST /resume` = 子进程拉起官方 CLI（`run` / `resume`）：运行
  是长任务，且 spec/LLM/模块解析接线必须复用 CLI（消费端重复接线即违规）——
  server 只负责传输级编排（spawn + 互斥 + 日志落盘）；进度监控走既有 WS
  （子进程写 status.json，同一数据源）。
- `DELETE /{run_id}` = 库 `query.delete_run` 薄映射 + 消费端活性防护（运行中
  进程库侧不可知：注册表活子进程 409 / phase=running 须 force）。
- 进程注册表：内存态 {run_id: Popen}，单写者防重入（同 run 双 resume → 409）；
  server 重启丢注册表不影响子进程继续跑（监控只依赖落盘产物）。
- preflight = 恢复预检 dry-run（薄调库 check_resume_compat_from_run，不 spawn 不写状态）。
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

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from module_harness import control, query, store
from module_harness.status import query_run_status
from server.deps import get_base_dir, get_search_paths, validate_run_id

router = APIRouter(prefix="/api/runs")

_LOG_TAIL_BYTES = 8 * 1024


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
# 发起运行（子进程拉起 CLI run）+ 运行历史删除
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
    """发起运行：子进程拉起官方 CLI `run`（完全镜像 post_resume 的 spawn 段）。

    校验链：模块解析+加载（resolve_module_full；未找到 404 code=module_unresolved，
    加载失败 ValueError 400）→ run_id 校验（复用 deps.validate_run_id，400）→
    run 目录已存在 409（防覆盖既有历史）→ 注册表同 run_id 活进程 409。
    spec 非 null 落临时文件走 --spec-file（Windows argv 长度限制）；两皆无由
    CLI 落 process.log 报错（server 不重复校验）。新 run 的 status.json 由
    子进程写出后即被既有 WS 流与 runs 列表覆盖（零额外管道）。
    """
    try:
        resolved = store.resolve_module_full(body.module, search=get_search_paths(base_dir))
    except ValueError as e:
        raise HTTPException(status_code=400, detail={"error": str(e), "module": body.module})
    if resolved is None:
        raise HTTPException(
            status_code=404,
            detail={
                "error": f"模块 '{body.module}' 未找到",
                "module": body.module,
                "code": "module_unresolved",
            },
        )
    run_id = body.run_id or f"{body.module}_{uuid.uuid4().hex[:6]}"
    validate_run_id(run_id)
    run_dir = base_dir / ".specmodule" / "runs" / run_id
    if run_dir.exists():
        raise HTTPException(
            status_code=409,
            detail={"error": f"运行已存在: {run_id}（防覆盖历史，请换 run_id）", "run_id": run_id},
        )
    if _reap(run_id) is not None:
        raise HTTPException(
            status_code=409,
            detail={"error": "该 run_id 已有运行进程在跑", "run_id": run_id},
        )

    tmp_paths: list[Path] = []
    argv = [sys.executable, "-m", "module_harness.cli", "run",
            "--module", body.module, "--run-id", run_id]
    if body.spec is not None:
        fd, name = tempfile.mkstemp(prefix=f"webview_{run_id}_", suffix=".json")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(body.spec, fh, ensure_ascii=False)
        tmp_paths.append(Path(name))
        argv += ["--spec-file", name]
    if body.template:
        argv += ["--template", body.template]
    argv += ["--max-ticks", str(body.max_ticks)]
    if body.mock:
        argv.append("--mock")

    run_dir.mkdir(parents=True)
    log_fh = (run_dir / "process.log").open("wb")
    try:
        popen = _spawn(argv, cwd=str(base_dir), log_fh=log_fh)
    except OSError:
        log_fh.close()
        for p in tmp_paths:
            p.unlink(missing_ok=True)
        raise
    _PROCS[run_id] = _Proc(popen, tmp_paths)
    return {"started": True, "run_id": run_id, "pid": popen.pid, "module": body.module}


@router.delete("/{run_id}")
def delete_run(
    run_id: str, force: bool = False, base_dir: Path = Depends(get_base_dir)
) -> dict:
    """运行历史单条删除：库 `query.delete_run` 薄映射 + 消费端活性防护。

    运行中进程库侧不可知，活性防护是消费端职责：注册表有活子进程 → 409
    （自己 spawn 的进程不可删，force 也不例外——进程仍在写该目录）；库读出
    phase=running 且无 `?force=true` → 409「先取消或强制删除」（force 供
    max_ticks 截断残留态等死目录强制清理）；目录不存在（库返回 False）→ 404。
    """
    validate_run_id(run_id)
    if _reap(run_id) is not None:
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
# 恢复/回退（子进程拉起 CLI resume）+ 进程观测
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


class _Proc:
    """一个被跟踪的 resume 子进程（互斥 + 日志 + 临时文件生命周期）。"""

    def __init__(self, popen: subprocess.Popen, tmp_paths: list[Path]) -> None:
        self.popen = popen
        self.started_at = time.time()
        self.tmp_paths = tmp_paths


_PROCS: dict[str, _Proc] = {}


def _reap(run_id: str) -> _Proc | None:
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


def _target_str(target: int | str | None) -> str | None:
    if target is None:
        return None
    if isinstance(target, int):
        return str(target)
    return target


@router.get("/{run_id}/process")
def get_process(run_id: str, base_dir: Path = Depends(get_base_dir)) -> dict:
    """resume 子进程观测：是否在跑 + 日志尾（CLI 启动失败只在这能看到）。"""
    validate_run_id(run_id)
    proc = _reap(run_id)
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


@router.post("/{run_id}/process/terminate")
def post_terminate(run_id: str, base_dir: Path = Depends(get_base_dir)) -> dict:
    """恢复子进程硬终止：注册表握有 Popen，terminate 即可（Windows = 硬杀）。

    绕过库的优雅收尾（不写终态 phase）——status.json 停留 running 属预期
    残留，UI 由 tick 停滞提示引导走强制恢复收尾；webview 不代写库产物格式。
    注册表无活进程 → 409（CLI 手起的原始 run 不在观测范围，明确不支持）。
    临时文件由 _reap 惰性收割清理。
    """
    validate_run_id(run_id)
    proc = _reap(run_id)
    if proc is None:
        raise HTTPException(
            status_code=409,
            detail={"error": "无本 server 启动的恢复进程", "run_id": run_id},
        )
    proc.popen.terminate()
    return {"run_id": run_id, "terminated": True, "pid": proc.popen.pid}


@router.post("/{run_id}/resume", status_code=202)
def post_resume(
    run_id: str, body: ResumeBody, base_dir: Path = Depends(get_base_dir)
) -> dict:
    validate_run_id(run_id)
    _require_run(run_id, base_dir)
    if not (base_dir / ".specmodule" / "runs" / run_id / "run.sqlite").exists():
        raise HTTPException(
            status_code=400,
            detail={"error": "无可恢复快照（运行未落盘 run.sqlite）", "run_id": run_id},
        )
    if _reap(run_id) is not None:
        raise HTTPException(
            status_code=409,
            detail={"error": "该 run 已有恢复进程在跑", "run_id": run_id},
        )
    st = query_run_status(run_id, base_dir=base_dir)
    if st is not None and st.phase == "running" and not body.force:
        # force 逃生门：max_ticks 截断的 run phase 停在 running 但进程已退出，
        # 库语义无法区分"真在跑"与"残留态"——由用户判断（误用由 WAL 单写者
        # 风险自担，UI 仅在 running 态出示该选项）
        raise HTTPException(
            status_code=409,
            detail={"error": "运行进行中——先取消/暂停再恢复", "run_id": run_id},
        )
    module_name = body.module or run_id
    # 显式 search（随 base_dir 锚定）——放运行根 modules/ 下的模块不被误判
    if store.resolve_module(module_name, search=get_search_paths(base_dir)) is None:
        raise HTTPException(
            status_code=404,
            detail={
                "error": f"模块 '{module_name}' 未找到",
                "run_id": run_id,
                "module": module_name,
                "code": "module_unresolved",
            },
        )
    target = _target_str(body.target)
    if target is not None and not (
        target.isdigit() or target.startswith("manual:")
    ):
        raise HTTPException(
            status_code=400,
            detail={"error": f"非法回退目标: {target!r}（tick 号或 manual:<label>）",
                    "run_id": run_id},
        )

    # spec/tasklist 落临时文件——CLI 通道是 --spec-file/--tasklist（内联 --spec
    # 受 Windows 命令行长度限制；文件内容校验交给 CLI，server 不重复）
    tmp_paths: list[Path] = []
    argv = [sys.executable, "-m", "module_harness.cli", "resume"]
    if target is not None:
        argv.append(target)
    argv += ["--module", module_name, "--run-id", run_id]
    for payload, suffix in ((body.spec, "--spec-file"), (body.tasklist, "--tasklist")):
        if payload is None:
            continue
        fd, name = tempfile.mkstemp(prefix=f"webview_{run_id}_", suffix=".json")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False)
        tmp_paths.append(Path(name))
        argv += [suffix, name]
    argv += ["--max-ticks", str(body.max_ticks)]
    if body.mock:
        argv.append("--mock")

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
    return {
        "started": True,
        "run_id": run_id,
        "pid": popen.pid,
        "module": module_name,
        "target": target,
    }


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
