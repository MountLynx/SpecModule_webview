# tests/test_control_api.py
"""控制面端点：control GET/POST、inputs、resume（spawn 桩）、process 观测。"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest

from server import runservice
from tests.conftest import MINI_TASKLIST, seed_run


class FakePopen:
    """_spawn 桩：不真起进程，pid/poll 可控。"""

    def __init__(self) -> None:
        self.pid = 4321
        self.exit_code: int | None = None
        self.terminated = False

    def poll(self) -> int | None:
        return self.exit_code

    def terminate(self) -> None:
        self.terminated = True


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


def _seed_resumable(base, run_id="mini_graph", **kw):
    """可恢复 fixture run：status done + run.sqlite（snapshots）+ inputs。"""
    status = kw.pop("status", {"module_id": run_id, "phase": "done", "updated_at": 2.0})
    return seed_run(
        base, run_id,
        firings=[{"tick": 1, "node": "A", "output": "a1"}],
        snapshots={1: {"tick": 1, "status": "running", "fireable": ["B"], "fired": ["A"]}},
        status=status,
        inputs={"spec": {"topic": "demo"}, "tasklist": MINI_TASKLIST},
        **kw,
    )


# ------------------------------------------------------------------
# control GET/POST
# ------------------------------------------------------------------


class TestControlEndpoints:
    def test_get_control_empty(self, base, client):
        seed_run(base, "c_run", status={"module_id": "c_run", "phase": "running", "updated_at": 1.0})
        r = client.get("/api/runs/c_run/control")
        assert r.status_code == 200
        d = r.json()
        assert d["control"] is None
        assert d["paused"] is False

    def test_post_control_writes_file(self, base, client):
        seed_run(base, "c_run", status={"module_id": "c_run", "phase": "running", "updated_at": 1.0})
        r = client.post("/api/runs/c_run/control",
                        json={"action": "cancel", "reason": "手动停止"})
        assert r.status_code == 200
        d = r.json()
        assert d["control"]["action"] == "cancel"
        assert d["control"]["reason"] == "手动停止"
        # 薄映射：文件确实落在 run 目录（库协议原样）
        assert (base / ".specmodule" / "runs" / "c_run" / "control.json").exists()

    def test_post_pause_view(self, base, client):
        seed_run(base, "c_run", status={"module_id": "c_run", "phase": "running", "updated_at": 1.0})
        r = client.post("/api/runs/c_run/control", json={"action": "pause"})
        assert r.status_code == 200
        assert r.json()["paused"] is True
        g = client.get("/api/runs/c_run/control").json()
        assert g["paused"] is True

    def test_post_bad_action_400(self, base, client):
        seed_run(base, "c_run", status={"module_id": "c_run", "phase": "running", "updated_at": 1.0})
        r = client.post("/api/runs/c_run/control", json={"action": "explode"})
        assert r.status_code == 400
        assert "未知控制动作" in r.json()["error"]

    def test_unknown_run_404(self, client):
        assert client.get("/api/runs/ghost/control").status_code == 404
        r = client.post("/api/runs/ghost/control", json={"action": "cancel"})
        assert r.status_code == 404
        assert r.json()["error"] == "无运行记录"


# ------------------------------------------------------------------
# inputs
# ------------------------------------------------------------------


class TestInputsEndpoint:
    def test_inputs_roundtrip(self, base, client):
        _seed_resumable(base)
        r = client.get("/api/runs/mini_graph/inputs")
        assert r.status_code == 200
        d = r.json()
        assert d["spec"] == {"topic": "demo"}
        assert d["tasklist"] == MINI_TASKLIST

    def test_inputs_missing_archive(self, base, client):
        seed_run(base, "bare", status={"module_id": "bare", "phase": "done", "updated_at": 1.0})
        d = client.get("/api/runs/bare/inputs").json()
        assert d["spec"] is None and d["tasklist"] is None

    def test_unknown_run_404(self, client):
        assert client.get("/api/runs/ghost/inputs").status_code == 404


# ------------------------------------------------------------------
# resume（spawn 桩）
# ------------------------------------------------------------------


class TestResumeEndpoint:
    def test_resume_spawns_cli(self, base, client, stub_spawn):
        _seed_resumable(base)
        r = client.post("/api/runs/mini_graph/resume", json={
            "target": "1", "spec": {"topic": "改后的主题"}, "mock": True, "max_ticks": 50,
        })
        assert r.status_code == 202
        assert r.json() == {
            "started": True, "run_id": "mini_graph", "pid": 4321,
            "module": "mini_graph", "target": "1",
        }
        call = stub_spawn[0]
        argv = call["argv"]
        assert argv[:4] == [runservice.sys.executable, "-m", "module_harness.cli", "resume"]
        assert "1" in argv  # 回退目标位置参数
        assert argv[argv.index("--module") + 1] == "mini_graph"
        assert argv[argv.index("--run-id") + 1] == "mini_graph"
        assert argv[argv.index("--max-ticks") + 1] == "50"
        assert "--mock" in argv
        spec_path = Path(argv[argv.index("--spec-file") + 1])
        assert json.loads(spec_path.read_text(encoding="utf-8")) == {"topic": "改后的主题"}
        assert call["cwd"] == str(base)

    def test_resume_default_module_heuristic(self, base, client, stub_spawn):
        """module 缺省 = run_id（同图端点启发式）；target/spec/tasklist 全缺省。"""
        _seed_resumable(base)
        r = client.post("/api/runs/mini_graph/resume", json={})
        assert r.status_code == 202
        argv = stub_spawn[0]["argv"]
        assert argv[argv.index("--module") + 1] == "mini_graph"
        assert "--spec-file" not in argv and "--tasklist" not in argv
        assert argv.index("resume") + 1 == argv.index("--module")  # 无位置目标

    def test_resume_tasklist_file(self, base, client, stub_spawn):
        _seed_resumable(base)
        new_tl = {"Tasks": {"A": {"type": "script", "script": "A"}}, "Flow": "[A]"}
        r = client.post("/api/runs/mini_graph/resume",
                        json={"target": "manual:cp1", "tasklist": new_tl})
        assert r.status_code == 202
        argv = stub_spawn[0]["argv"]
        assert "manual:cp1" in argv
        tl_path = Path(argv[argv.index("--tasklist") + 1])
        assert json.loads(tl_path.read_text(encoding="utf-8")) == new_tl

    def test_resume_404_unknown_run(self, client, stub_spawn):
        r = client.post("/api/runs/ghost/resume", json={"module": "mini_graph"})
        assert r.status_code == 404

    def test_resume_400_without_sqlite(self, base, client, stub_spawn):
        # 仅 status.json 的失败 run（无 run.sqlite）——库 resume 无快照可恢复
        run_dir = base / ".specmodule" / "runs" / "bare"
        run_dir.mkdir(parents=True)
        (run_dir / "status.json").write_text(
            json.dumps({"module_id": "bare", "phase": "aborted", "updated_at": 1.0}),
            encoding="utf-8",
        )
        r = client.post("/api/runs/bare/resume", json={"module": "mini_graph"})
        assert r.status_code == 400
        assert "无可恢复快照" in r.json()["error"]

    def test_resume_409_while_running(self, base, client, stub_spawn):
        _seed_resumable(base, status={"module_id": "mini_graph", "phase": "running", "updated_at": 3.0})
        r = client.post("/api/runs/mini_graph/resume", json={})
        assert r.status_code == 409
        assert "运行进行中" in r.json()["error"]

    def test_resume_force_bypasses_running_guard(self, base, client, stub_spawn):
        """force 逃生门：max_ticks 截断的残留 running 态可强制恢复。"""
        _seed_resumable(base, status={"module_id": "mini_graph", "phase": "running", "updated_at": 3.0})
        r = client.post("/api/runs/mini_graph/resume", json={"force": True, "mock": True})
        assert r.status_code == 202
        assert stub_spawn[0]["argv"][3] == "resume"

    def test_resume_409_double_spawn(self, base, client, stub_spawn):
        _seed_resumable(base)
        assert client.post("/api/runs/mini_graph/resume", json={}).status_code == 202
        r = client.post("/api/runs/mini_graph/resume", json={})
        assert r.status_code == 409
        assert len(stub_spawn) == 1  # 第二次未 spawn

    def test_resume_404_module_unresolved(self, base, client, stub_spawn):
        _seed_resumable(base)
        r = client.post("/api/runs/mini_graph/resume", json={"module": "no_such_mod"})
        assert r.status_code == 404
        d = r.json()
        assert d["code"] == "module_unresolved"
        assert d["module"] == "no_such_mod"

    def test_resume_400_bad_target(self, base, client, stub_spawn):
        _seed_resumable(base)
        r = client.post("/api/runs/mini_graph/resume", json={"target": "not-a-target"})
        assert r.status_code == 400
        assert "非法回退目标" in r.json()["error"]


# ------------------------------------------------------------------
# POST /api/runs（发起运行——子进程拉起 CLI run，spawn 桩）
# ------------------------------------------------------------------


class TestLaunchEndpoint:
    def test_launch_spawns_cli_run(self, base, client, stub_spawn):
        r = client.post("/api/runs", json={
            "module": "mini_graph", "spec": {"topic": "新主题"},
            "template": "t1", "run_id": "my_run", "max_ticks": 5, "mock": True,
        })
        assert r.status_code == 202
        assert r.json() == {
            "started": True, "run_id": "my_run", "pid": 4321, "module": "mini_graph",
        }
        call = stub_spawn[0]
        argv = call["argv"]
        assert argv[:4] == [runservice.sys.executable, "-m", "module_harness.cli", "run"]
        assert argv[argv.index("--module") + 1] == "mini_graph"
        assert argv[argv.index("--run-id") + 1] == "my_run"
        assert argv[argv.index("--template") + 1] == "t1"
        assert argv[argv.index("--max-ticks") + 1] == "5"
        assert "--mock" in argv
        spec_path = Path(argv[argv.index("--spec-file") + 1])
        assert json.loads(spec_path.read_text(encoding="utf-8")) == {"topic": "新主题"}
        assert call["cwd"] == str(base)
        # run 目录先行创建 + 日志落盘位置（CLI 启动期失败可见）
        assert (base / ".specmodule" / "runs" / "my_run" / "process.log").exists()

    def test_launch_default_run_id_and_fallbacks(self, base, client, stub_spawn):
        """run_id 缺省 = {module}_{6hex}；spec/template/mock 缺省不进 argv。"""
        r = client.post("/api/runs", json={"module": "mini_graph"})
        assert r.status_code == 202
        body = r.json()
        assert re.fullmatch(r"mini_graph_[0-9a-f]{6}", body["run_id"])
        argv = stub_spawn[0]["argv"]
        assert argv[argv.index("--run-id") + 1] == body["run_id"]
        assert "--spec-file" not in argv  # CLI 回落 entry.default_spec
        assert "--template" not in argv   # CLI 回落 default_template
        assert "--mock" not in argv
        assert argv[argv.index("--max-ticks") + 1] == "100"

    def test_launch_404_module_unresolved(self, base, client, stub_spawn):
        r = client.post("/api/runs", json={"module": "no_such_mod"})
        assert r.status_code == 404
        d = r.json()
        assert d["code"] == "module_unresolved"
        assert d["module"] == "no_such_mod"
        assert stub_spawn == []  # 未 spawn
        assert not (base / ".specmodule" / "runs").exists() or not any(
            (base / ".specmodule" / "runs").iterdir()
        )

    def test_launch_400_load_failure(self, base, client, stub_spawn):
        """模块可发现但加载失败（坏 pack 清单）→ ValueError → 400。"""
        pack = base / "modules" / "broken_pack"
        pack.mkdir(parents=True)
        (pack / "module.json").write_text(
            json.dumps({"name": "broken_pack"}), encoding="utf-8"
        )
        r = client.post("/api/runs", json={"module": "broken_pack"})
        assert r.status_code == 400
        assert "加载失败" in r.json()["error"]
        assert stub_spawn == []

    def test_launch_400_bad_run_id(self, base, client, stub_spawn):
        r = client.post("/api/runs", json={"module": "mini_graph", "run_id": "bad id"})
        assert r.status_code == 400
        assert "非法 run_id" in r.json()["error"]
        assert stub_spawn == []

    def test_launch_409_run_dir_exists(self, base, client, stub_spawn):
        """防覆盖既有历史：run 目录已存在 → 409。"""
        run_dir = base / ".specmodule" / "runs" / "taken"
        run_dir.mkdir(parents=True)
        (run_dir / "status.json").write_text(
            json.dumps({"module_id": "taken", "phase": "done", "updated_at": 1.0}),
            encoding="utf-8",
        )
        r = client.post("/api/runs", json={"module": "mini_graph", "run_id": "taken"})
        assert r.status_code == 409
        assert "运行已存在" in r.json()["error"]
        assert stub_spawn == []

    def test_launch_409_active_process_in_registry(self, base, client, stub_spawn):
        """注册表同 run_id 活进程 → 409（互斥对发起运行与 resume 同源）。"""
        runservice._PROCS["busy_run"] = runservice._Proc(FakePopen(), [])
        r = client.post("/api/runs", json={"module": "mini_graph", "run_id": "busy_run"})
        assert r.status_code == 409
        assert "已有运行进程" in r.json()["error"]
        assert r.json()["run_id"] == "busy_run"  # 409 载荷带 run_id（对齐原契约）
        assert stub_spawn == []  # 未 spawn


# ------------------------------------------------------------------
# DELETE /api/runs/{id}（运行历史单条删除 + 活性防护）
# ------------------------------------------------------------------


class TestDeleteRunEndpoint:
    def test_delete_terminal_run(self, base, client):
        seed_run(base, "dead", status={"module_id": "dead", "phase": "done", "updated_at": 1.0})
        r = client.delete("/api/runs/dead")
        assert r.status_code == 200
        assert r.json() == {"run_id": "dead", "deleted": True}
        assert not (base / ".specmodule" / "runs" / "dead").exists()

    def test_delete_404_unknown(self, client):
        r = client.delete("/api/runs/ghost")
        assert r.status_code == 404
        assert r.json()["error"] == "无运行记录"

    def test_delete_400_bad_run_id(self, client):
        assert client.delete("/api/runs/bad%20id").status_code == 400

    def test_delete_running_needs_force(self, base, client):
        seed_run(base, "live", status={"module_id": "live", "phase": "running", "updated_at": 1.0})
        r = client.delete("/api/runs/live")
        assert r.status_code == 409
        assert "运行进行中" in r.json()["error"]
        assert (base / ".specmodule" / "runs" / "live").exists()
        # force 二次确认通道：强制删除残留/失控态
        r = client.delete("/api/runs/live", params={"force": "true"})
        assert r.status_code == 200
        assert not (base / ".specmodule" / "runs" / "live").exists()

    def test_delete_live_process_blocked_even_with_force(self, base, client, stub_spawn):
        """注册表有本 server 拉起的活子进程 → 不可删（force 也不例外）。"""
        assert client.post(
            "/api/runs", json={"module": "mini_graph", "run_id": "proc_run", "mock": True},
        ).status_code == 202
        r = client.delete("/api/runs/proc_run")
        assert r.status_code == 409
        assert "先终止" in r.json()["error"]
        r = client.delete("/api/runs/proc_run", params={"force": "true"})
        assert r.status_code == 409
        # 子进程退出（惰性收割）后可删
        runservice._PROCS["proc_run"].popen.exit_code = 0
        r = client.delete("/api/runs/proc_run")
        assert r.status_code == 200
        assert not (base / ".specmodule" / "runs" / "proc_run").exists()


# ------------------------------------------------------------------
# process 观测 + 收割
# ------------------------------------------------------------------


class TestProcessEndpoint:
    def test_process_idle(self, base, client):
        seed_run(base, "idle_run", status={"module_id": "idle_run", "phase": "done", "updated_at": 1.0})
        d = client.get("/api/runs/idle_run/process").json()
        assert d["running"] is False
        assert d["pid"] is None
        assert d["log"] is None

    def test_process_running_then_reaped(self, base, client, stub_spawn):
        _seed_resumable(base)
        client.post("/api/runs/mini_graph/resume", json={"spec": {"k": "v"}})
        d = client.get("/api/runs/mini_graph/process").json()
        assert d["running"] is True and d["pid"] == 4321
        assert d["log"] is not None  # process.log 已创建
        # 子进程退出 → 惰性收割：running 翻转 + 临时 spec 文件清理
        argv = stub_spawn[0]["argv"]
        tmp = Path(argv[argv.index("--spec-file") + 1])
        assert tmp.exists()
        proc = runservice._PROCS["mini_graph"]
        proc.popen.exit_code = 0
        d = client.get("/api/runs/mini_graph/process").json()
        assert d["running"] is False
        assert not tmp.exists()
        assert "mini_graph" not in runservice._PROCS


# ------------------------------------------------------------------
# resume/preflight（恢复预检 dry-run——薄调库 check_resume_compat_from_run）
# ------------------------------------------------------------------


def _seed_preflight(base, run_id="mini_graph"):
    """预检 fixture：快照含 marking + firings + inputs 存档（模块 mini_graph 可解析）。"""
    return seed_run(
        base, run_id,
        firings=[{"tick": 0, "node": "A", "output": "a1"}],
        snapshots={1: {"tick": 1, "status": "running", "fireable": ["B"], "fired": ["A"],
                       "marking": {"slots": {"B|A": True}, "armed_starts": ["A"]}}},
        status={"module_id": run_id, "phase": "done", "updated_at": 2.0},
        inputs={"spec": {"topic": "demo"}, "tasklist": MINI_TASKLIST},
    )


class TestPreflightEndpoint:
    def test_preflight_clean(self, base, client):
        _seed_preflight(base)
        r = client.post("/api/runs/mini_graph/resume/preflight", json={})
        assert r.status_code == 200
        d = r.json()
        assert d["hard_errors"] == []
        assert d["target"] == "1" and d["target_tick"] == 1
        assert d["executed_nodes"] == ["A"]

    def test_preflight_hard_errors_inline_200(self, base, client):
        """兼容性硬错误是正常载荷（200），不是 HTTP 错误。"""
        _seed_preflight(base)
        bad = {"Tasks": {"A": {"type": "script", "script": "A"},
                         "B": {"type": "script", "script": "B",
                               "inputs": {"value": "Z"}}},
               "Flow": "[A] --> B"}
        r = client.post("/api/runs/mini_graph/resume/preflight",
                        json={"tasklist": bad})
        assert r.status_code == 200
        assert any("不在新图中" in e for e in r.json()["hard_errors"])

    def test_preflight_bad_tasklist_400(self, base, client):
        _seed_preflight(base)
        r = client.post("/api/runs/mini_graph/resume/preflight",
                        json={"tasklist": {"bogus": True}})
        assert r.status_code == 400

    def test_preflight_module_unresolved_400(self, base, client):
        _seed_preflight(base)
        r = client.post("/api/runs/mini_graph/resume/preflight",
                        json={"module": "no_such_mod"})
        assert r.status_code == 400
        assert "未找到" in r.json()["error"]

    def test_preflight_404_without_sqlite(self, base, client):
        run_dir = base / ".specmodule" / "runs" / "bare"
        run_dir.mkdir(parents=True)
        (run_dir / "status.json").write_text(
            json.dumps({"module_id": "bare", "phase": "aborted", "updated_at": 1.0}),
            encoding="utf-8",
        )
        r = client.post("/api/runs/bare/resume/preflight", json={})
        assert r.status_code == 404

    def test_preflight_module_tracing_default(self, base, client):
        """module 缺省解析序：status.json 溯源 > run_id 启发式（UI 后缀 run_id 免传 module）。"""
        seed_run(
            base, "mini_graph_ab12cd",
            firings=[{"tick": 0, "node": "A", "output": "a1"}],
            snapshots={1: {"tick": 1, "status": "running", "fireable": ["B"], "fired": ["A"],
                           "marking": {"slots": {"B|A": True}, "armed_starts": ["A"]}}},
            status={"module_id": "mini_graph_ab12cd", "module": "mini_graph",
                    "phase": "done", "updated_at": 2.0},
            inputs={"spec": {"topic": "demo"}, "tasklist": MINI_TASKLIST},
        )
        r = client.post("/api/runs/mini_graph_ab12cd/resume/preflight", json={})
        assert r.status_code == 200
        assert r.json()["target"] == "1"   # mini_graph 溯源命中（否则 400 module_unresolved）

    def test_preflight_unknown_run_404(self, client):
        assert client.post("/api/runs/ghost/resume/preflight",
                           json={}).status_code == 404

    def test_preflight_invalid_target_inline_200(self, base, client):
        """非法/不存在 target 是 200 载荷 hard_error（区别于 /resume 的 400 预校验）。"""
        _seed_preflight(base)
        r = client.post("/api/runs/mini_graph/resume/preflight",
                        json={"target": 999})
        assert r.status_code == 200
        assert any("不存在" in e for e in r.json()["hard_errors"])


# ------------------------------------------------------------------
# process/terminate（恢复子进程硬终止——注册表内进程；不代写终态）
# ------------------------------------------------------------------


class TestTerminateEndpoint:
    def test_terminate_409_without_process(self, base, client):
        seed_run(base, "t_run", status={"module_id": "t_run", "phase": "done", "updated_at": 1.0})
        r = client.post("/api/runs/t_run/process/terminate")
        assert r.status_code == 409
        assert "无本 server 启动的恢复进程" in r.json()["error"]
        assert r.json()["run_id"] == "t_run"  # 409 载荷带 run_id（对齐原契约）

    def test_terminate_running_process(self, base, client, stub_spawn):
        _seed_resumable(base)
        assert client.post("/api/runs/mini_graph/resume", json={}).status_code == 202
        r = client.post("/api/runs/mini_graph/process/terminate")
        assert r.status_code == 200
        d = r.json()
        assert d["terminated"] is True and d["pid"] == 4321
        assert runservice._PROCS["mini_graph"].popen.terminated is True
