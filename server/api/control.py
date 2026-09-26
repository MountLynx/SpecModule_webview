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
        raise HTTPException(status_code=409, detail={"error": str(e), "run_id": e.run_id})
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
        raise HTTPException(status_code=409, detail={"error": str(e), "run_id": run_id})


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
