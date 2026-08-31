# 控制功能缺口补齐 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `docs/superpowers/specs/2026-08-31-control-gaps-design.md` 补齐控制缺口全部 7 项——②恢复预检（库侧收编 + dry-run 端点 + 对话框集成）、⑤terminate（端点 + 头部按钮）、①检查点创建 UI、③tasklist 预填、④停滞提示、⑥fired 上下文、⑦行内控制 + 编辑器校验。

**Architecture:** 库仓库先行——`query.py` 收编 `check_resume_compat_from_run` 组合函数（第二个消费端是本仓库 preflight 端点）+ `_executed_nodes` 单一事实源助手；本仓库 server 只加薄端点（preflight / terminate / list paused 字段）；前端全部落在现有 `RunControls`（对话框拆分独立文件）、`RunList`、`App` 三处。

**Tech Stack:** Python ≥3.10 + FastAPI + httpx TestClient（本仓库 / 库同栈）；React + TS + Vite（web/，无测试框架，`npm run build` 即 tsc 门）。

**约定（全程适用）：**

- 库仓库 = `../SpecModule`（独立 git 仓库，遵守其 AGENTS.md）；本仓库 = `SpecModule_webview`。两个仓库**分开提交**。
- 命令一律从本仓库根目录执行（`C:\Users\xingy\Desktop\开发\SpecModule_webview`），库仓库命令显式 `cd ../SpecModule`。
- 所有 Python 文件首行 `from __future__ import annotations`；中文 docstring；不引入 linter/formatter。
- 测试隔离：只写 `tmp_path` 下的 `.specmodule/runs/`，绝不碰真实 `~/.specmodule`。

**背景速览（零上下文工程师版）：**

- SpecModule 运行落盘 `<base>/.specmodule/runs/<run_id>/{run.sqlite, status.json}`。`run.sqlite`（tickflow `SqliteBackend`）有 snapshots / firings / checkpoints / module_inputs 四表；WAL 模式多连接安全。
- `check_resume_compat(new_tasklist, graph, executed_nodes, old_tasklist, marking_slots, armed_starts)` 在 `module_harness/checkpoint.py`：返回 `ResumeCheck(hard_errors, warnings)`，hard_errors 非空则拒绝 resume。目前唯一调用方 `module.py` 的 `resume()` 内联组合了全部材料（目标快照解析、executed_nodes 提取、旧输入存档、建图）。
- marking 快照形状：`snap["marking"] = {"slots": {"dst|src": bool, ...}, "armed_starts": [node, ...]}`。
- webview 现有控制面：`server/api/control.py`（control/inputs/resume/process 四端点 + 内存进程注册表 `_PROCS`）；前端 `web/src/components/RunControls.tsx`（头部控制条 + ResumeDialog 内联组件）。

---

## Task 1: 库——`_executed_nodes` 助手提取 + module.py 复用（纯重构）

**Files:**
- Modify: `../SpecModule/module_harness/query.py`（在 `run_db_path` 之后、`build_timeline` 之前加助手）
- Modify: `../SpecModule/module_harness/module.py`（resume 内 executed_nodes 块，约 437-444 行）

- [ ] **Step 1: 确认重构基线为绿**

Run: `cd ../SpecModule && python -m pytest module_harness/tests/test_module.py module_harness/tests/test_checkpoint.py -q`
Expected: 全部 PASS（这是 resume 路径的既有守护）。

- [ ] **Step 2: 在 `query.py` 加 `_executed_nodes` 助手**

在 `query.py` 的 `def run_db_path(...)` 函数体之后插入：

```python
def _executed_nodes(backend: Any, module_id: str, tick: int) -> set[str]:
    """firings 表中 tick < 快照 tick 的去重节点（resume 已执行判定，单一事实源）。

    快照 tick N 在 tick N-1 结束后落盘，tick == N 的 firing 属 restore 后
    会被重跑的部分，不算已执行。firings 按 module_id 累积（跨多次 run），
    前一轮 run 的记录也会计入——仅影响提示性警告 1/3 的准确性，不影响硬错误。
    """
    return {
        d["node"]
        for d in backend.list_firings(module_id)
        if d.get("node") and int(d.get("tick", 0)) < tick
    }
```

- [ ] **Step 3: `module.py` resume 改用助手**

`module.py` 顶部 import 区（`from .checkpoint import (...)` 之后）加一行：

```python
from .query import _executed_nodes
```

把 resume 中的内联提取（`# 已执行节点：firings 表中 tick < 快照 tick 的去重节点…` 注释 + 集合推导，约 437-444 行）整体替换为（保留原语义注释压缩到助手中，调用处只留一行）：

```python
            executed_nodes = _executed_nodes(backend, self.module_id, int(snap.get("tick", 0)))
```

- [ ] **Step 4: 跑测试确认重构无回归**

Run: `cd ../SpecModule && python -m pytest module_harness/tests/test_module.py module_harness/tests/test_checkpoint.py module_harness/tests/test_query.py -q`
Expected: 与 Step 1 相同数量 PASS，0 fail。

- [ ] **Step 5: Commit（库仓库）**

```bash
cd ../SpecModule && git add module_harness/query.py module_harness/module.py && git commit -m "refactor: executed_nodes 提取规则收编 query._executed_nodes 单一事实源"
```

---

## Task 2: 库——`check_resume_compat_from_run` 组合函数 + 测试 + 导出

**Files:**
- Modify: `../SpecModule/module_harness/query.py`（新公开函数，放在 `read_module_inputs` 之后）
- Modify: `../SpecModule/module_harness/__init__.py`（query import 块 + `__all__`）
- Create: `../SpecModule/module_harness/tests/test_resume_preflight.py`

- [ ] **Step 1: 写失败测试**

Create `../SpecModule/module_harness/tests/test_resume_preflight.py`：

```python
# module_harness/tests/test_resume_preflight.py
"""query.check_resume_compat_from_run：从运行产物做恢复预检（不 spawn）。"""

from __future__ import annotations

import pytest

from module_harness.query import check_resume_compat_from_run

MINI_TASKLIST_JSON = {
    "Tasks": {
        "A": {"type": "script", "script": "A"},
        "B": {"type": "script", "script": "B", "inputs": {"value": "A"}},
        "C": {"type": "script", "script": "C"},
    },
    "Flow": "[A] --> B\nA --|pick_c|--> C",
}

MINI_MODULE_PY = '''\
"""resume_preflight 测试模块：script 流水线 + guard 分支。"""
from __future__ import annotations

from module_harness.entry import ModuleEntry
from module_harness.events import EventBus
from module_harness.registry import HarnessRegistry


def _registry_for(llm_client, template_name, event_bus):
    reg = HarnessRegistry(llm_client=llm_client, event_bus=event_bus or EventBus.null())

    @reg.script("A")
    def a(view):
        return {"value": "from A"}

    @reg.script("B")
    def b(view):
        return {"greeting": "hello"}

    @reg.script("C")
    def c(view):
        return {"note": "guarded"}

    @reg.guard("pick_c")
    def pick_c(view):
        return True

    return reg


entry = ModuleEntry(
    name="preflight_mini",
    description="resume_preflight 测试模块",
    templates={},
    build_registry=_registry_for,
)
'''


@pytest.fixture()
def mini_env(tmp_path, monkeypatch):
    """测试模块目录进 SPECMODULE_PATH，base=tmp_path（同 test_graph_query 范式）。"""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("SPECMODULE_HOME", str(tmp_path / "home"))
    mods = tmp_path / "mods"
    mods.mkdir()
    (mods / "preflight_mini.py").write_text(MINI_MODULE_PY, encoding="utf-8")
    monkeypatch.setenv("SPECMODULE_PATH", str(mods))
    monkeypatch.delenv("SPECMODULE_MODULES", raising=False)
    return tmp_path


def _seed_run(base, run_id="preflight_mini", *, tasklist=None, firings=None,
              snapshots=None, inputs=True):
    """run.sqlite（firings/snapshots/checkpoints）+ module_inputs 存档。"""
    from module_harness.checkpoint import ModuleInputStore
    from tickflow.persistence import SqliteBackend
    from tickflow.state import NodeState

    backend = SqliteBackend(base / ".specmodule" / "runs" / run_id / "run.sqlite")
    for f in firings if firings is not None else [
        {"tick": 0, "node": "A", "output": "a1"},
    ]:
        backend.save_firing(run_id, NodeState(**f))
    for tick, snap in (snapshots if snapshots is not None else {
        1: {"tick": 1, "status": "running", "fireable": ["B"], "fired": ["A"],
            "marking": {"slots": {"B|A": True}, "armed_starts": ["A"]}},
    }).items():
        backend.save_snapshot(run_id, tick, snap)
    backend.close()
    if inputs:
        st = ModuleInputStore(run_id, base)
        st.save_module_inputs({"topic": "demo"}, tasklist or MINI_TASKLIST_JSON)
        st.close()


class TestCheckResumeCompatFromRun:
    def test_default_target_clean(self, mini_env):
        """缺省（最新快照续跑、归档 tasklist）：硬错误为空，材料齐全。"""
        _seed_run(mini_env)
        d = check_resume_compat_from_run("preflight_mini", "preflight_mini",
                                         base_dir=mini_env)
        assert d is not None
        assert d["hard_errors"] == []
        assert d["target"] == "1" and d["target_tick"] == 1
        assert d["executed_nodes"] == ["A"]

    def test_manual_target_resolves(self, mini_env):
        _seed_run(mini_env)
        backend_store(mini_env, "preflight_mini", "manual:cp1")  # 打手动检查点
        d = check_resume_compat_from_run("preflight_mini", "preflight_mini",
                                         target="manual:cp1", base_dir=mini_env)
        assert d is not None
        assert d["target"] == "manual:cp1" and d["target_tick"] == 1

    def test_bad_target_is_hard_error_not_raise(self, mini_env):
        _seed_run(mini_env)
        d = check_resume_compat_from_run("preflight_mini", "preflight_mini",
                                         target="nope", base_dir=mini_env)
        assert d is not None
        assert d["target"] is None and d["target_tick"] is None
        assert any("不存在" in e for e in d["hard_errors"])

    def test_unknown_producer_hard_error(self, mini_env):
        """新 tasklist 引用图中不存在的 producer → 硬错误 1。"""
        _seed_run(mini_env)
        bad = {
            "Tasks": {
                "A": {"type": "script", "script": "A"},
                "B": {"type": "script", "script": "B", "inputs": {"value": "Z"}},
            },
            "Flow": "[A] --> B",
        }
        d = check_resume_compat_from_run("preflight_mini", "preflight_mini",
                                         new_tasklist=bad, base_dir=mini_env)
        assert d is not None
        assert any("不在新图中" in e for e in d["hard_errors"])

    def test_modified_executed_node_warns(self, mini_env):
        """已执行节点定义被改 → 警告 1（对比 module_inputs 存档）。"""
        _seed_run(mini_env, firings=[
            {"tick": 0, "node": "A", "output": "a1"},
            {"tick": 0, "node": "B", "output": "b1"},
        ])
        modified = {
            "Tasks": {
                "A": {"type": "script", "script": "A"},
                "B": {"type": "script", "script": "B_v2", "inputs": {"value": "A"}},
                "C": {"type": "script", "script": "C"},
            },
            "Flow": "[A] --> B\nA --|pick_c|--> C",
        }
        d = check_resume_compat_from_run("preflight_mini", "preflight_mini",
                                         new_tasklist=modified, base_dir=mini_env)
        assert d is not None
        assert d["hard_errors"] == []
        assert any("被修改" in w for w in d["warnings"])

    def test_no_db_returns_none(self, mini_env):
        assert check_resume_compat_from_run(
            "preflight_mini", "preflight_mini", base_dir=mini_env) is None

    def test_bad_tasklist_raises_valueerror(self, mini_env):
        _seed_run(mini_env)
        with pytest.raises(ValueError):
            check_resume_compat_from_run("preflight_mini", "preflight_mini",
                                         new_tasklist={"bogus": True},
                                         base_dir=mini_env)

    def test_module_unresolved_raises_valueerror(self, mini_env):
        _seed_run(mini_env)
        with pytest.raises(ValueError, match="未找到"):
            check_resume_compat_from_run("ghost", "preflight_mini",
                                         base_dir=mini_env)


def backend_store(base, run_id, label):
    """给最新快照打手动检查点（测试助手）。"""
    from module_harness.query import create_checkpoint

    create_checkpoint(run_id, label.removeprefix("manual:"), base_dir=base)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ../SpecModule && python -m pytest module_harness/tests/test_resume_preflight.py -q`
Expected: FAIL / ERROR——`ImportError: cannot import name 'check_resume_compat_from_run'`。

- [ ] **Step 3: 在 `query.py` 实现组合函数**

在 `query.py` 的 `read_module_inputs` 函数之后加入：

```python
def check_resume_compat_from_run(
    module_name: str,
    run_id: str,
    *,
    new_tasklist: Any = None,
    target: int | str | None = None,
    base_dir: Path | None = None,
) -> dict[str, Any] | None:
    """恢复预检：从运行产物组合材料跑兼容性校验——不 spawn、不写状态。

    resume（module.py）内联组合的第二消费端收编：目标快照解析 →
    executed_nodes（_executed_nodes）→ 旧输入存档（read_module_inputs）→
    建图（build_run_graph 同款 Mock registry 通道，零 LLM；new_tasklist
    给出时走直渲染通道）→ check_resume_compat（marking.slots / armed_starts
    取自目标快照）。

    - ``new_tasklist``：dict 或 Tasklist；None = 用归档 tasklist（纯续跑预检）。
    - ``target``：tick 号 / ``"manual:<label>"`` / None（最新快照）。

    错误契约：run.sqlite 缺失/读失败 → None（查询容错，调用方映射 404）；
    tasklist 非法 / 建图失败 → ValueError（消息可直接面向用户，调用方映射
    400）；目标解析失败**不 raise**——作为 ``hard_errors[0]`` 返回（消息与
    module.py 的 KeyError 文案一致并附可用清单），``target``/``target_tick``
    为 None。

    返回 ``{"target": str | None, "target_tick": int | None,
    "executed_nodes": [str], "hard_errors": [str], "warnings": [str]}``。
    """
    from .checkpoint import check_resume_compat, tasklist_from_dict

    db_path = run_db_path(run_id, base_dir)
    if not db_path.exists():
        return None
    from tickflow.persistence import SqliteBackend

    backend = SqliteBackend(db_path)
    try:
        hard_errors: list[str] = []
        warnings: list[str] = []
        snap: dict[str, Any] | None = None
        target_tick: int | None = None
        ticks = backend.list_snapshots(run_id)
        manual = [lbl for lbl, _ in backend.list_checkpoints(run_id)]
        if not ticks and not manual:
            hard_errors.append(f"无可恢复快照: {run_id}（运行未产生任何 tick 快照）")
        elif isinstance(target, (int, str)) and (
            isinstance(target, int)
            or (isinstance(target, str) and target.isdigit())
        ):
            t = int(target)
            if t in ticks:
                snap = backend.load_snapshot(run_id, t)
                target_tick = t
            else:
                hard_errors.append(
                    f"回退目标 {target!r} 不存在"
                    f"（可用 tick: {ticks or '无'}；manual: {manual or '无'}）"
                )
        elif isinstance(target, str) and target.startswith("manual:"):
            snap = backend.load_checkpoint(run_id, target)
            if snap is None:
                hard_errors.append(
                    f"回退目标 {target!r} 不存在"
                    f"（可用 tick: {ticks or '无'}；manual: {manual or '无'}）"
                )
            else:
                target_tick = int(snap.get("tick", 0))
        elif target is not None:
            hard_errors.append(
                f"回退目标 {target!r} 不存在"
                f"（可用 tick: {ticks or '无'}；manual: {manual or '无'}）"
            )
        else:
            target_tick = max(ticks)
            snap = backend.load_snapshot(run_id, target_tick)

        executed: set[str] = set()
        if snap is not None:
            executed = _executed_nodes(backend, run_id, int(snap.get("tick", 0)))
    finally:
        backend.close()

    if hard_errors:
        return {"target": None, "target_tick": None, "executed_nodes": [],
                "hard_errors": hard_errors, "warnings": []}

    old_tl = None
    old_inputs = read_module_inputs(run_id, base_dir=base_dir)
    if old_inputs is not None:
        old_tl = tasklist_from_dict(old_inputs["tasklist"])

    try:
        built = build_run_graph(module_name, run_id, base_dir=base_dir,
                                tasklist=new_tasklist)
    except ValueError:
        raise
    except Exception as e:
        raise ValueError(f"预检建图失败: {e}") from e
    if built is None:
        raise ValueError("无 tasklist 可预检（无归档且未传 new_tasklist）")
    graph, new_tl = built

    marking = (snap or {}).get("marking") or {}
    check = check_resume_compat(
        new_tl, graph, executed,
        old_tasklist=old_tl,
        marking_slots=marking.get("slots"),
        armed_starts=marking.get("armed_starts"),
    )
    target_str = target if isinstance(target, str) else (
        str(target) if target is not None else str(target_tick))
    return {
        "target": target_str,
        "target_tick": target_tick,
        "executed_nodes": sorted(executed),
        "hard_errors": list(check.hard_errors),
        "warnings": list(check.warnings),
    }
```

- [ ] **Step 4: `__init__.py` 导出**

`../SpecModule/module_harness/__init__.py` 的 `from .query import (...)` 块内（`build_checkpoints,` 与 `build_timeline,` 之间）加一行 `check_resume_compat_from_run,`；`__all__` 列表中 `"check_resume_compat",` 旁加 `"check_resume_compat_from_run",`。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd ../SpecModule && python -m pytest module_harness/tests/test_resume_preflight.py -q`
Expected: 8 passed。

- [ ] **Step 6: 库全量基线**

Run: `cd ../SpecModule && python -m pytest module_harness/tests/ -q -m "not smoke"`
Expected: 全绿（0 failed）。

- [ ] **Step 7: Commit（库仓库）**

```bash
cd ../SpecModule && git add module_harness/query.py module_harness/__init__.py module_harness/tests/test_resume_preflight.py && git commit -m "feat: query.check_resume_compat_from_run——运行产物恢复预检组合（webview dry-run 消费）"
```

---

## Task 3: 库——api.md 补录 + 版本号（docs 提交）

**Files:**
- Modify: `../SpecModule/docs/references/api.md`（query 函数表，`read_module_inputs` 行后）
- Modify: `../SpecModule/pyproject.toml`（version patch +1）

- [ ] **Step 1: api.md 表加一行**

在 `api.md` 第 25 行 `read_module_inputs` 表行之后插入（保持表格竖线对齐风格）：

```markdown
| `check_resume_compat_from_run` | `(module_name: str, run_id: str, *, new_tasklist: dict \| Tasklist \| None = None, target: int \| str \| None = None, base_dir: Path \| None = None) -> dict \| None` | 恢复预检：从运行产物组合兼容性校验材料（目标快照解析 + executed_nodes + 旧输入存档 + Mock registry 建图）跑 `check_resume_compat`——不 spawn、不写状态；`new_tasklist`/`target` 缺省用归档值（纯续跑预检）；目标解析失败不抛错、作为 `hard_errors[0]` 返回（附可用清单）；run.sqlite 缺失/读失败 → `None`；tasklist 非法/建图失败 → `ValueError`（消息可面向用户）。Web resume/preflight 端点消费；CLI `resume --dry-run` 需要时薄加 |
```

- [ ] **Step 2: bump 版本**

`../SpecModule/pyproject.toml` 的 `version = "x.y.z"` patch 位 +1（先读当前值再改）。

- [ ] **Step 3: Commit（库仓库）**

```bash
cd ../SpecModule && git add docs/references/api.md pyproject.toml && git commit -m "docs: api.md 补录 check_resume_compat_from_run + bump version"
```

---

## Task 4: 本仓库——同步依赖验证

**Files:** 无代码变更。

- [ ] **Step 1: 验证新函数可导入**

Run: `python -c "from module_harness.query import check_resume_compat_from_run; print('ok')"`
Expected: `ok`（editable 安装自动生效；若报 ImportError 则先 `pip install -e "../SpecModule"` 再验证）。

---

## Task 5: 本仓库——`POST /api/runs/{id}/resume/preflight` 端点

**Files:**
- Modify: `server/api/control.py`（ResumeBody 之后加 PreflightBody + 端点）
- Test: `tests/test_control_api.py`

- [ ] **Step 1: 写失败测试**

`tests/test_control_api.py` 追加（文件顶部 import 区补 `from tests.conftest import MINI_TASKLIST, seed_run` 已有，无需改）：

```python
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

    def test_preflight_unknown_run_404(self, client):
        assert client.post("/api/runs/ghost/resume/preflight",
                           json={}).status_code == 404
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python -m pytest tests/test_control_api.py::TestPreflightEndpoint -q`
Expected: FAIL——404 Not Found（路由不存在）或 405。

- [ ] **Step 3: 实现端点**

`server/api/control.py`：文件 docstring 的端点清单说明后补一行注释 ` - preflight/terminate = 恢复预检 dry-run / 恢复子进程硬终止（见各端点 docstring）。`；在 `ResumeBody` 类之后加：

```python
class PreflightBody(BaseModel):
    module: str | None = None      # 缺省 = run_id（同 resume 启发式）
    target: int | str | None = None
    tasklist: dict[str, Any] | None = None  # None = 归档 tasklist（纯续跑预检）
```

在 `post_resume` 端点之后加：

```python
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
    try:
        result = query.check_resume_compat_from_run(
            body.module or run_id, run_id,
            new_tasklist=body.tasklist, target=body.target, base_dir=base_dir,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail={"error": e.args[0], "run_id": run_id})
    if result is None:
        raise _not_found(run_id)
    return result
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python -m pytest tests/test_control_api.py -q`
Expected: 全部 PASS（含既有测试）。

- [ ] **Step 5: Commit**

```bash
git add server/api/control.py tests/test_control_api.py && git commit -m "feat: POST /resume/preflight 恢复预检 dry-run 端点（薄调库 check_resume_compat_from_run）"
```

---

## Task 6: 本仓库——`POST /api/runs/{id}/process/terminate` 端点

**Files:**
- Modify: `server/api/control.py`（get_process 之后加端点）
- Test: `tests/test_control_api.py`（FakePopen 补 terminate 方法 + 新测试类）

- [ ] **Step 1: 写失败测试**

`tests/test_control_api.py` 的 `FakePopen` 类补一个方法（`poll` 之后）：

```python
    def terminate(self) -> None:
        self.terminated = True
```

`__init__` 里补一行 `self.terminated = False`。文件末尾追加：

```python
# ------------------------------------------------------------------
# process/terminate（恢复子进程硬终止——注册表内进程；不代写终态）
# ------------------------------------------------------------------


class TestTerminateEndpoint:
    def test_terminate_409_without_process(self, base, client):
        seed_run(base, "t_run", status={"module_id": "t_run", "phase": "done", "updated_at": 1.0})
        r = client.post("/api/runs/t_run/process/terminate")
        assert r.status_code == 409
        assert "无本 server 启动的恢复进程" in r.json()["error"]

    def test_terminate_running_process(self, base, client, stub_spawn):
        _seed_resumable(base)
        assert client.post("/api/runs/mini_graph/resume", json={}).status_code == 200
        r = client.post("/api/runs/mini_graph/process/terminate")
        assert r.status_code == 200
        d = r.json()
        assert d["terminated"] is True and d["pid"] == 4321
        assert control_api._PROCS["mini_graph"].popen.terminated is True
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python -m pytest tests/test_control_api.py::TestTerminateEndpoint -q`
Expected: `test_terminate_409_without_process` FAIL（404 路由不存在）。

- [ ] **Step 3: 实现端点**

`server/api/control.py` 的 `get_process` 之后加：

```python
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python -m pytest tests/test_control_api.py -q`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add server/api/control.py tests/test_control_api.py && git commit -m "feat: POST /process/terminate 恢复子进程硬终止端点（不代写终态，409 出注册表外）"
```

---

## Task 7: 本仓库——`GET /api/runs` 摘要加 `paused` 字段

**Files:**
- Modify: `server/api/runs.py`（import + list_runs）
- Test: `tests/test_runs_api.py`

- [ ] **Step 1: 写失败测试**

`tests/test_runs_api.py` 追加（沿用该文件既有 import；若 `control` 未导入则测试内局部写 control.json）：

```python
def test_list_runs_paused_flag(base, client):
    """行内控制按钮的数据支撑：paused 取自 control.json 薄映射。"""
    seed_run(base, "p_run", status={"module_id": "p_run", "phase": "running", "updated_at": 1.0})
    d = client.get("/api/runs").json()
    row = next(r for r in d["runs"] if r["run_id"] == "p_run")
    assert row["paused"] is False
    client.post("/api/runs/p_run/control", json={"action": "pause"})
    d = client.get("/api/runs").json()
    row = next(r for r in d["runs"] if r["run_id"] == "p_run")
    assert row["paused"] is True
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python -m pytest tests/test_runs_api.py::test_list_runs_paused_flag -q`
Expected: FAIL——`KeyError: 'paused'`。

- [ ] **Step 3: 实现**

`server/api/runs.py`：import 行 `from module_harness import query` 改为 `from module_harness import control, query`；`list_runs` 中 `out.append({...})` 前加一行，并在 dict 里加字段：

```python
            req = control.read_control(d.name, base_dir=base_dir)
            out.append({
                "run_id": st.module_id,
                "phase": st.phase,
                "tick": st.tick,
                "error": st.error,
                "updated_at": st.updated_at,
                "paused": bool(req and req.get("action") == "pause"),
            })
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python -m pytest tests/test_runs_api.py tests/test_control_api.py -q`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add server/api/runs.py tests/test_runs_api.py && git commit -m "feat: GET /api/runs 摘要补 paused 字段（read_control 薄映射，行内控制按钮数据源）"
```

---

## Task 8: 前端——api.ts 类型与调用 + TERMINAL_PHASES 收口

**Files:**
- Modify: `web/src/api.ts`

- [ ] **Step 1: 加类型与调用**

`web/src/api.ts`：`RunSummary` 接口加字段 `paused: boolean;`（`error` 之后）。`TERMINAL_PHASES` 导出（文件顶部 import 之后）：

```ts
export const TERMINAL_PHASES = new Set(["done", "aborted", "cancelled"]);
```

文件末尾（fetchProcess 之后）追加：

```ts
// ------------------------------------------------------------------
// 控制面补齐：预检 / terminate / 检查点创建
// ------------------------------------------------------------------

export interface PreflightResult {
  target: string | null;
  target_tick: number | null;
  executed_nodes: string[];
  hard_errors: string[];
  warnings: string[];
}

export const postPreflight = (runId: string, body: {
  module?: string | null;
  target?: string | null;
  tasklist?: Record<string, unknown> | null;
}) =>
  postJson<PreflightResult>(
    `/api/runs/${encodeURIComponent(runId)}/resume/preflight`, body);

export const postTerminate = (runId: string) =>
  postJson<{ run_id: string; terminated: boolean; pid: number | null }>(
    `/api/runs/${encodeURIComponent(runId)}/process/terminate`);

export const postCheckpoint = (
  runId: string, body: { label: string; tick?: number | null },
) =>
  postJson<{ label: string; tick: number; overwritten: boolean }>(
    `/api/runs/${encodeURIComponent(runId)}/checkpoints`, body);
```

- [ ] **Step 2: 构建验证**

Run: `cd web && npm run build`
Expected: tsc 无错误（`RunSummary.paused` 新字段此时无消费方，不报错；build 通过）。

- [ ] **Step 3: Commit**

```bash
git add web/src/api.ts && git commit -m "feat(web): api.ts 补预检/terminate/检查点调用与 paused 字段 + TERMINAL_PHASES 收口"
```

---

## Task 9: 前端——对话框拆分 + ③tasklist 预填 + ⑦JSON 即时校验

**Files:**
- Create: `web/src/components/dialogStyles.ts`
- Create: `web/src/components/ResumeDialog.tsx`（自 `RunControls.tsx` 迁出 + 改造）
- Modify: `web/src/components/RunControls.tsx`（瘦身为控制条）

- [ ] **Step 1: 建 `dialogStyles.ts`**

```ts
// 对话框共享内联样式（RunControls 系对话框公用，避免逐文件复制）。
import type { CSSProperties } from "react";

export const btnStyle: CSSProperties = {
  fontSize: 12,
  padding: "3px 10px",
  cursor: "pointer",
};

export const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(15, 23, 42, 0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

export const dialogStyle: CSSProperties = {
  background: "#fff",
  borderRadius: 8,
  padding: 16,
  width: 520,
  maxWidth: "92vw",
  maxHeight: "86vh",
  overflow: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 10,
  fontSize: 13,
};

export const fieldLabel: CSSProperties = { fontWeight: 600, marginBottom: 2 };

/** textarea 即时 JSON 校验：返回错误文案或 null（合法/空）。 */
export function jsonFieldError(text: string, mustBeObject: boolean): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (mustBeObject && (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))) {
      return "必须是 JSON 对象";
    }
    return null;
  } catch {
    return "不是合法 JSON";
  }
}
```

- [ ] **Step 2: 建 `ResumeDialog.tsx`（迁出 + ③⑦ 改造）**

把 `RunControls.tsx` 中 `ResumeDialogProps` 接口、`ResumeDialog` 组件及 `overlayStyle`/`dialogStyle`/`fieldLabel` 三个样式常量整体迁到新文件 `web/src/components/ResumeDialog.tsx`，并做以下改造（完整新文件如下；`btnStyle` 从 `./dialogStyles` 导入）：

```tsx
import { useEffect, useState } from "react";
import {
  ApiError,
  fetchCheckpoints,
  fetchInputs,
  postResume,
  type CheckpointTarget,
} from "../api";
import { btnStyle, dialogStyle, fieldLabel, jsonFieldError, overlayStyle } from "./dialogStyles";

interface ResumeDialogProps {
  runId: string;
  moduleHint: string | null;
  /** phase=running 时出示强制恢复选项（max_ticks 截断的残留 running 态） */
  phaseRunning: boolean;
  onClose: () => void;
  onStarted: () => void;
}

function ResumeDialog({ runId, moduleHint, phaseRunning, onClose, onStarted }: ResumeDialogProps) {
  const [targets, setTargets] = useState<CheckpointTarget[] | null>(null);
  const [target, setTarget] = useState<string>("");
  const [module, setModule] = useState(moduleHint ?? runId);
  const [specText, setSpecText] = useState<string>("");
  const [specDirty, setSpecDirty] = useState(false);
  const [tasklistText, setTasklistText] = useState<string>("");
  const [tasklistDirty, setTasklistDirty] = useState(false);
  const [mock, setMock] = useState(false);
  const [force, setForce] = useState(false);
  const [maxTicks, setMaxTicks] = useState(100);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const specErr = jsonFieldError(specText, true);
  const tasklistErr = jsonFieldError(tasklistText, true);

  useEffect(() => {
    let cancelled = false;
    fetchCheckpoints(runId)
      .then((list) => {
        if (!cancelled) setTargets(list);
      })
      .catch(() => {
        if (!cancelled) setTargets([]);
      });
    fetchInputs(runId)
      .then((inputs) => {
        if (cancelled) return;
        if (!specDirty) setSpecText(inputs.spec != null ? JSON.stringify(inputs.spec, null, 2) : "{}");
        // ③ tasklist 预填：对齐 spec——归档有值才填，用户改过（dirty）不覆盖
        if (!tasklistDirty && inputs.tasklist != null) {
          setTasklistText(JSON.stringify(inputs.tasklist, null, 2));
        }
      })
      .catch(() => {
        if (!cancelled && !specDirty) setSpecText("{}");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const submit = async () => {
    let spec: Record<string, unknown> | null = null;
    const trimmedSpec = specText.trim();
    if (trimmedSpec) {
      try {
        spec = JSON.parse(trimmedSpec);
      } catch {
        setErr("spec 不是合法 JSON");
        return;
      }
      if (spec == null || typeof spec !== "object" || Array.isArray(spec)) {
        setErr("spec 必须是 JSON 对象");
        return;
      }
    }
    let tasklist: Record<string, unknown> | null = null;
    const trimmedTl = tasklistText.trim();
    if (trimmedTl) {
      try {
        tasklist = JSON.parse(trimmedTl);
      } catch {
        setErr("tasklist 不是合法 JSON");
        return;
      }
      if (tasklist == null || typeof tasklist !== "object" || Array.isArray(tasklist)) {
        setErr("tasklist 必须是 JSON 对象");
        return;
      }
    }
    setBusy(true);
    setErr(null);
    try {
      await postResume(runId, {
        module: module || null,
        target: target || null,
        spec,
        tasklist,
        max_ticks: maxTicks,
        mock,
        force: phaseRunning && force,
      });
      onStarted();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onTasklistFile = async (file: File | null) => {
    if (!file) return;
    try {
      // 文件上传 = 载入到编辑区（编辑起点，而非独立提交通道）
      const data = JSON.parse(await file.text());
      setTasklistText(JSON.stringify(data, null, 2));
      setTasklistDirty(true);
      setErr(null);
    } catch {
      setErr("tasklist 文件不是合法 JSON");
    }
  };

  const badTextarea: React.CSSProperties = { outline: "2px solid #dc2626" };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={dialogStyle} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>
          恢复 / 回退：<code>{runId}</code>
        </div>
        <div>
          <div style={fieldLabel}>回退目标（缺省 = 最新快照续跑）</div>
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            style={{ width: "100%" }}
          >
            <option value="">最新快照（续跑）</option>
            {(targets ?? []).map((c) => (
              <option key={c.target} value={c.target}>
                {c.kind === "manual"
                  ? `${c.target}（${c.label ?? "手动检查点"}）`
                  : `tick ${c.target}`}
              </option>
            ))}
          </select>
        </div>
        <div>
          <div style={fieldLabel}>模块名（须与先前 run 一致）</div>
          <input
            value={module}
            onChange={(e) => setModule(e.target.value)}
            style={{ width: "100%", boxSizing: "border-box" }}
          />
        </div>
        <div>
          <div style={fieldLabel}>
            spec（JSON，可改后重传；留空 = 用模块缺省 spec）
          </div>
          <textarea
            value={specText}
            onChange={(e) => {
              setSpecText(e.target.value);
              setSpecDirty(true);
            }}
            rows={8}
            spellCheck={false}
            style={{
              width: "100%",
              fontFamily: "monospace",
              boxSizing: "border-box",
              ...(specErr ? badTextarea : {}),
            }}
          />
          {specErr && <div style={{ color: "#b91c1c", fontSize: 12 }}>spec {specErr}</div>}
        </div>
        <div>
          <div style={fieldLabel}>
            tasklist（JSON，可改后重传；留空 = 用归档/模块缺省流程；与模板通道互斥）
          </div>
          <textarea
            value={tasklistText}
            onChange={(e) => {
              setTasklistText(e.target.value);
              setTasklistDirty(true);
            }}
            rows={8}
            spellCheck={false}
            placeholder="留空使用归档 tasklist；或从文件载入"
            style={{
              width: "100%",
              fontFamily: "monospace",
              boxSizing: "border-box",
              ...(tasklistErr ? badTextarea : {}),
            }}
          />
          {tasklistErr && <div style={{ color: "#b91c1c", fontSize: 12 }}>tasklist {tasklistErr}</div>}
          <div style={{ marginTop: 4 }}>
            <input
              type="file"
              accept=".json,application/json"
              onChange={(e) => onTasklistFile(e.target.files?.[0] ?? null)}
            />
          </div>
        </div>
        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          <label>
            <input
              type="checkbox"
              checked={mock}
              onChange={(e) => setMock(e.target.checked)}
            />{" "}
            --mock（免 key 冒烟）
          </label>
          <label>
            max ticks{" "}
            <input
              type="number"
              value={maxTicks}
              min={1}
              onChange={(e) => setMaxTicks(Number(e.target.value) || 100)}
              style={{ width: 70 }}
            />
          </label>
          {phaseRunning && (
            <label>
              <input
                type="checkbox"
                checked={force}
                onChange={(e) => setForce(e.target.checked)}
              />{" "}
              强制恢复（运行中残留态）
            </label>
          )}
        </div>
        {err && <div style={{ color: "#b91c1c" }}>{err}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button style={btnStyle} onClick={onClose} disabled={busy}>
            取消
          </button>
          <button style={btnStyle} onClick={submit} disabled={busy}>
            {busy ? "启动中…" : "启动恢复"}
          </button>
        </div>
      </div>
    </div>
  );
}

export { ResumeDialog };
export type { ResumeDialogProps };
```

- [ ] **Step 3: 瘦身 `RunControls.tsx`**

`RunControls.tsx` 删掉已迁出的 `ResumeDialogProps`/`ResumeDialog`/`overlayStyle`/`dialogStyle`/`fieldLabel`，并把文件头部 import 区整体替换为（迁出的 `fetchCheckpoints`/`fetchInputs`/`postResume`/`CheckpointTarget` 引用随迁出删除，避免 tsc noUnusedLocals 报错）：

```tsx
import { useCallback, useState } from "react";
import { postControl, type ControlAction } from "../api";
import { btnStyle } from "./dialogStyles";
import { ResumeDialog } from "./ResumeDialog";
```

组件 JSX 与其余逻辑不动（`btnStyle` 改用导入值）。

- [ ] **Step 4: 构建验证**

Run: `cd web && npm run build`
Expected: tsc 通过。

- [ ] **Step 5: Commit**

```bash
git add web/src/components/dialogStyles.ts web/src/components/ResumeDialog.tsx web/src/components/RunControls.tsx && git commit -m "feat(web): ResumeDialog 拆独立文件 + tasklist 预填编辑区（③）+ JSON 即时校验（⑦）"
```

---

## Task 10: 前端——②预检集成进恢复对话框

**Files:**
- Modify: `web/src/components/ResumeDialog.tsx`

- [ ] **Step 1: 加预检状态与防抖 effect**

`ResumeDialog.tsx`：import 区补 `postPreflight, type PreflightResult`。组件 state 区（`err` 之后）加：

```tsx
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [preflightErr, setPreflightErr] = useState<string | null>(null);
  const [preflightBusy, setPreflightBusy] = useState(false);
```

组件内（inputs 加载 effect 之后）加预检 effect——打开即跑，module/target/tasklist 任一变更防抖 500ms 重跑；tasklist 非法 JSON 时跳过（行内校验已示错）：

```tsx
  // ② 恢复预检：当前表单（module/target/tasklist）下 dry-run，hard_errors 禁启停
  useEffect(() => {
    let alive = true;
    const trimmed = tasklistText.trim();
    let parsedTl: Record<string, unknown> | null = null;
    if (trimmed) {
      try {
        parsedTl = JSON.parse(trimmed);
      } catch {
        setPreflight(null); // 非法 JSON：行内校验已示错，跳过预检
        return;
      }
    }
    const t = setTimeout(() => {
      setPreflightBusy(true);
      postPreflight(runId, {
        module: module || null,
        target: target || null,
        tasklist: parsedTl,
      })
        .then((r) => {
          if (alive) {
            setPreflight(r);
            setPreflightErr(null);
          }
        })
        .catch((e) => {
          if (alive) {
            setPreflight(null);
            setPreflightErr(e instanceof ApiError ? e.message : String(e));
          }
        })
        .finally(() => {
          if (alive) setPreflightBusy(false);
        });
    }, 500);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [runId, module, target, tasklistText]);
```

- [ ] **Step 2: 结果展示区 + 禁用逻辑**

JSX 中 mock/maxTicks 行之后、`{err && ...}` 之前插入：

```tsx
        <div>
          <div style={fieldLabel}>
            兼容性预检
            {preflightBusy && <span style={{ fontWeight: 400, color: "#6b7280" }}>（检查中…）</span>}
          </div>
          {preflightErr && <div style={{ color: "#b45309", fontSize: 12 }}>预检不可用：{preflightErr}</div>}
          {preflight && (
            <>
              {preflight.hard_errors.length > 0 && (
                <div style={{ color: "#b91c1c", fontSize: 12 }}>
                  {preflight.hard_errors.map((e, i) => <div key={i}>✗ {e}</div>)}
                </div>
              )}
              {preflight.warnings.length > 0 && (
                <div style={{ color: "#b45309", fontSize: 12 }}>
                  {preflight.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
                </div>
              )}
              {preflight.hard_errors.length === 0 && preflight.warnings.length === 0 && (
                <div style={{ color: "#16a34a", fontSize: 12 }}>✓ 未发现兼容性问题（回退目标 tick {preflight.target_tick}）</div>
              )}
            </>
          )}
        </div>
```

启动按钮禁用条件改为（替换原 `disabled={busy}`）：

```tsx
          <button
            style={btnStyle}
            onClick={submit}
            disabled={busy || (preflight != null && preflight.hard_errors.length > 0)}
          >
```

- [ ] **Step 3: 构建验证**

Run: `cd web && npm run build`
Expected: tsc 通过。

- [ ] **Step 4: Commit**

```bash
git add web/src/components/ResumeDialog.tsx && git commit -m "feat(web): 恢复对话框集成兼容性预检（自动 dry-run + hard_errors 禁用启动）"
```

---

## Task 11: 前端——⑥回退目标 fired 上下文

**Files:**
- Modify: `web/src/components/ResumeDialog.tsx`

- [ ] **Step 1: fired 摘要工具 + 下拉文案**

`ResumeDialog.tsx`：import 补 `type CheckpointTarget`（已在）。文件底部（export 之前）加：

```tsx
/** manual 条目 fired 为空但含 tick——按 tick join 同 tick 快照条目取 fired。 */
function firedOf(c: CheckpointTarget, targets: CheckpointTarget[] | null): string[] {
  if (c.fired.length > 0) return c.fired;
  const tickEntry = (targets ?? []).find((t) => t.kind === "tick" && t.tick === c.tick);
  return tickEntry?.fired ?? [];
}

function targetLabel(c: CheckpointTarget, targets: CheckpointTarget[] | null): string {
  const base = c.kind === "manual"
    ? `${c.target}（${c.label ?? "手动检查点"}）`
    : `tick ${c.target}`;
  const fired = firedOf(c, targets);
  if (fired.length === 0) return base;
  const head = fired.slice(0, 3).join("→");
  const more = fired.length > 3 ? `…` : "";
  return `${base} · 已执行 ${fired.length} 节点：${head}${more}`;
}
```

- [ ] **Step 2: 下拉 option 与选中详情**

JSX：select 内 options 映射替换为（`{c.kind === "manual" ? ... : ...}` 三元换成 `targetLabel`）：

```tsx
            {(targets ?? []).map((c) => (
              <option key={c.target} value={c.target}>
                {targetLabel(c, targets)}
              </option>
            ))}
```

`</select>` 之后（同一个包裹 div 内）加选中项完整 fired 列表：

```tsx
          {(() => {
            const sel = (targets ?? []).find((c) => c.target === target);
            const fired = sel ? firedOf(sel, targets) : [];
            return fired.length > 0 ? (
              <div style={{ fontSize: 11, color: "#6b7280" }}>
                目标时点已执行：{fired.join("、")}
              </div>
            ) : null;
          })()}
```

- [ ] **Step 3: 构建验证**

Run: `cd web && npm run build`
Expected: tsc 通过。

- [ ] **Step 4: Commit**

```bash
git add web/src/components/ResumeDialog.tsx && git commit -m "feat(web): 回退目标展示 fired 上下文（执行摘要 + 选中详情，⑥）"
```

---

## Task 12: 前端——①检查点创建对话框 + header 入口

**Files:**
- Create: `web/src/components/CheckpointDialog.tsx`
- Modify: `web/src/components/RunControls.tsx`

- [ ] **Step 1: 建 `CheckpointDialog.tsx`**

```tsx
import { useState } from "react";
import { ApiError, postCheckpoint } from "../api";
import { btnStyle, dialogStyle, fieldLabel, overlayStyle } from "./dialogStyles";

interface CheckpointDialogProps {
  runId: string;
  onClose: () => void;
  /** 创建成功（App 据此刷新 run 列表） */
  onCreated: () => void;
}

function CheckpointDialog({ runId, onClose, onCreated }: CheckpointDialogProps) {
  const [label, setLabel] = useState("");
  const [tickText, setTickText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ label: string; tick: number; overwritten: boolean } | null>(null);

  const submit = async () => {
    if (!label.trim()) {
      setErr("label 必填");
      return;
    }
    const tick = tickText.trim() ? Number(tickText.trim()) : null;
    if (tick != null && (!Number.isFinite(tick) || tick < 0)) {
      setErr("tick 必须是非负整数");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await postCheckpoint(runId, { label: label.trim(), tick });
      setDone(r);
      onCreated();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={{ ...dialogStyle, width: 420 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>
          存手动检查点：<code>{runId}</code>
        </div>
        {done ? (
          <>
            <div>
              已保存 <code>{done.label}</code>（tick {done.tick}）
              {done.overwritten && "（覆盖同名旧检查点）"}
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button style={btnStyle} onClick={onClose}>关闭</button>
            </div>
          </>
        ) : (
          <>
            <div>
              <div style={fieldLabel}>label（回退目标形如 manual:&lt;label&gt;）</div>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="如 before-policy-change"
                style={{ width: "100%", boxSizing: "border-box" }}
              />
            </div>
            <div>
              <div style={fieldLabel}>tick（缺省 = 最新快照）</div>
              <input
                value={tickText}
                onChange={(e) => setTickText(e.target.value)}
                placeholder="留空 = 最新"
                style={{ width: "100%", boxSizing: "border-box" }}
              />
            </div>
            {err && <div style={{ color: "#b91c1c" }}>{err}</div>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button style={btnStyle} onClick={onClose} disabled={busy}>取消</button>
              <button style={btnStyle} onClick={submit} disabled={busy}>
                {busy ? "保存中…" : "保存检查点"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export { CheckpointDialog };
```

- [ ] **Step 2: `RunControls.tsx` 加入口**

import 区加 `import { CheckpointDialog } from "./CheckpointDialog";`。组件 state 区加 `const [cpOpen, setCpOpen] = useState(false);`。JSX：`{resumable && (...恢复/回退…按钮)}` 之前加：

```tsx
      <button style={btnStyle} disabled={busy} onClick={() => setCpOpen(true)}>
        存检查点…
      </button>
```

文件末尾 JSX（`{dialogOpen && ...}` 之后）加：

```tsx
      {cpOpen && (
        <CheckpointDialog
          runId={runId}
          onClose={() => setCpOpen(false)}
          onCreated={onAction}
        />
      )}
```

- [ ] **Step 3: 构建验证**

Run: `cd web && npm run build`
Expected: tsc 通过。

- [ ] **Step 4: Commit**

```bash
git add web/src/components/CheckpointDialog.tsx web/src/components/RunControls.tsx && git commit -m "feat(web): 手动检查点创建 UI 入口（header 存检查点对话框，①）"
```

---

## Task 13: 前端——④停滞提示 + ⑤terminate 按钮（App 层）

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/components/RunControls.tsx`

- [ ] **Step 1: App 加停滞检测**

`App.tsx`：import 补 `fetchProcess, postTerminate`。组件内（`paused` state 之后）加：

```tsx
  const [stalled, setStalled] = useState(false);
  // 打开恢复对话框的请求：带目标 runId（避免全局计数器泄漏到无关 run 的切换）+ seq 去重
  const [resumeRequest, setResumeRequest] = useState<{ runId: string; seq: number } | null>(null);
  const [procRunning, setProcRunning] = useState(false);
  const lastMsgAtRef = useRef<number>(Date.now());
  const liveRef = useRef(false);
```

既有「run 切换清状态」effect（`useEffect(() => { if (!runId) return; ... }, [runId])`）内补两行：

```tsx
    lastMsgAtRef.current = Date.now();
    setStalled(false);
```

既有 WS 增量 effect 顶部（`if (!streamState || streamState.runId !== runId) return;` 之后）补一行：

```tsx
    lastMsgAtRef.current = Date.now();
```

（该 effect 内已有 `setPaused` 等逻辑，不动。）组件内再加三个 effect + 一个回调：

```tsx
  // 停滞检测：running 且未暂停时，距最后一条 WS 消息超过 120s → 引导强制恢复。
  // 阈值取宽：单 tick 含多次 LLM 调用，5-10 分钟 tick 间隔属常态，提示是引导信号。
  useEffect(() => {
    liveRef.current = statusView?.phase === "running" && !paused;
  }, [statusView?.phase, paused]);

  useEffect(() => {
    const t = setInterval(() => {
      if (liveRef.current && Date.now() - lastMsgAtRef.current > 120_000) {
        setStalled(true);
      }
    }, 5_000);
    return () => clearInterval(t);
  }, []);

  // ⑤ terminate 按钮：running 期间轮询 /process（只对本 server 拉起的恢复子进程可见）
  useEffect(() => {
    if (statusView?.phase !== "running") {
      setProcRunning(false);
      return;
    }
    let cancelled = false;
    const poll = () =>
      fetchProcess(runId!)
        .then((p) => {
          if (!cancelled) setProcRunning(p.running);
        })
        .catch(() => {});
    poll();
    const t = setInterval(poll, 3_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [runId, statusView?.phase]);

  const terminateProc = useCallback(async () => {
    if (!runId) return;
    try {
      await postTerminate(runId);
    } catch {
      // 409（进程已退/注册表清空）等：静默，下一次 poll 自然纠正
    }
    refreshRuns();
  }, [runId, refreshRuns]);
```

- [ ] **Step 2: 黄条 + 按钮接线**

JSX：`</header>` 之后、`<div style={{ flex: 1, position: "relative" }}>` 之前插入：

```tsx
        {stalled && (
          <div
            style={{
              padding: "6px 14px",
              background: "#fef3c7",
              color: "#92400e",
              fontSize: 12,
              display: "flex",
              gap: 10,
              alignItems: "center",
            }}
          >
            <span>
              tick 长时间未前进——进程可能已截断/失联。若确认进程已退出，可强制恢复。
            </span>
            <button
              style={{ fontSize: 12, cursor: "pointer" }}
              onClick={() => setResumeRequest({ runId: runId!, seq: Date.now() })}
            >
              打开恢复/回退…
            </button>
          </div>
        )}
```

`<RunControls ... />` 加 props（`onAction={refreshRuns}` 之后）：

```tsx
                resumeRequest={resumeRequest}
                procRunning={procRunning}
                onTerminate={terminateProc}
```

- [ ] **Step 3: RunControls 接收新 props**

`RunControls.tsx`：props 接口加三个字段并在解构中接收：

```tsx
  /** 打开恢复对话框的请求（黄条/行内按钮发起；带目标 runId + seq） */
  resumeRequest: { runId: string; seq: number } | null;
  /** 本 server 拉起的恢复子进程在跑（/process 轮询） */
  procRunning: boolean;
  onTerminate: () => void;
```

import 行改 `import { useCallback, useEffect, useRef, useState } from "react";`。组件内加 effect（ref 记上次已响应的 seq——只响应当前 run 的新请求）：

```tsx
  const lastSeqRef = useRef<number | null>(null);
  useEffect(() => {
    if (
      resumeRequest &&
      resumeRequest.runId === runId &&
      resumeRequest.seq !== lastSeqRef.current
    ) {
      lastSeqRef.current = resumeRequest.seq;
      setDialogOpen(true);
    }
  }, [resumeRequest, runId]);
```

JSX：`{resumable && ...}` 按钮之前加终止按钮：

```tsx
      {procRunning && (
        <button
          style={{ ...btnStyle, color: "#b91c1c" }}
          disabled={busy}
          onClick={() => {
            if (window.confirm("硬终止恢复子进程？（不写终态，status 停留 running；之后可强制恢复）")) {
              onTerminate();
            }
          }}
        >
          终止进程
        </button>
      )}
```

- [ ] **Step 4: 构建验证**

Run: `cd web && npm run build`
Expected: tsc 通过。

- [ ] **Step 5: Commit**

```bash
git add web/src/App.tsx web/src/components/RunControls.tsx && git commit -m "feat(web): tick 停滞黄条引导强制恢复（④）+ 恢复子进程硬终止按钮（⑤前端出口）"
```

---

## Task 14: 前端——⑦RunList 行内控制按钮

**Files:**
- Modify: `web/src/components/RunList.tsx`
- Modify: `web/src/App.tsx`

- [ ] **Step 1: RunList 加行内按钮**

`RunList.tsx` 完整替换为：

```tsx
import { postControl, TERMINAL_PHASES, type ControlAction, type RunSummary } from "../api";

const PHASE_COLOR: Record<string, string> = {
  running: "#2563eb",
  done: "#16a34a",
  aborted: "#dc2626",
  cancelled: "#d97706",
};

const miniBtn: React.CSSProperties = {
  fontSize: 11,
  padding: "1px 6px",
  cursor: "pointer",
};

export function RunList({
  runs,
  current,
  onSelect,
  onControl,
  onResume,
}: {
  runs: RunSummary[];
  current: string | null;
  onSelect: (id: string) => void;
  onControl: (id: string, action: ControlAction) => void;
  onResume: (id: string) => void;
}) {
  return (
    <aside
      style={{
        width: 230,
        flexShrink: 0,
        borderRight: "1px solid #e5e7eb",
        overflowY: "auto",
      }}
    >
      <div style={{ padding: "10px 12px", fontWeight: 600 }}>运行列表</div>
      {runs.map((r) => {
        const terminal = TERMINAL_PHASES.has(r.phase);
        return (
          <div
            key={r.run_id}
            onClick={() => onSelect(r.run_id)}
            style={{
              padding: "8px 12px",
              cursor: "pointer",
              background: r.run_id === current ? "#eef2ff" : undefined,
            }}
          >
            <div style={{ fontSize: 13 }}>{r.run_id}</div>
            <div
              style={{
                fontSize: 11,
                color: PHASE_COLOR[r.phase] ?? "#6b7280",
                display: "flex",
                gap: 6,
                alignItems: "center",
              }}
            >
              <span>
                {r.phase}
                {r.tick != null ? ` · tick ${r.tick}` : ""}
              </span>
              <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}
                    onClick={(e) => e.stopPropagation()}>
                {r.phase === "running" && !r.paused && (
                  <button style={miniBtn} title="暂停"
                          onClick={() => onControl(r.run_id, "pause")}>⏸</button>
                )}
                {r.phase === "running" && r.paused && (
                  <button style={miniBtn} title="继续"
                          onClick={() => onControl(r.run_id, "unpause")}>▶</button>
                )}
                {r.phase === "running" && (
                  <button
                    style={{ ...miniBtn, color: "#b91c1c" }}
                    title="取消"
                    onClick={() => {
                      if (window.confirm(`取消运行 ${r.run_id}？`)) {
                        onControl(r.run_id, "cancel");
                      }
                    }}
                  >✕</button>
                )}
                {terminal && (
                  <button style={miniBtn} title="恢复/回退"
                          onClick={() => onResume(r.run_id)}>↻</button>
                )}
              </span>
            </div>
          </div>
        );
      })}
      {!runs.length && (
        <div style={{ padding: 12, fontSize: 12, color: "#9ca3af" }}>暂无运行记录</div>
      )}
    </aside>
  );
}
```

- [ ] **Step 2: App 接线 + TERMINAL_PHASES 收口**

`App.tsx`：本地 `const TERMINAL_PHASES = new Set([...])` 行删除，改为从 `./api` import（import 块加 `TERMINAL_PHASES`）。`RunControls.tsx` 同样删除本地 `TERMINAL_PHASES` 定义改 import from `../api`。App 组件内加处理函数：

```tsx
  const handleListControl = useCallback(
    async (rid: string, action: ControlAction) => {
      try {
        await postControl(rid, action);
      } catch {
        // 行内静默：刷新后状态即真相
      }
      refreshRuns();
    },
    [refreshRuns],
  );

  const handleListResume = useCallback((rid: string) => {
    setRunId(rid);
    setResumeRequest({ runId: rid, seq: Date.now() });
  }, []);
```

（import 补 `postControl, type ControlAction`。）`<RunList ...>` 调用加 props：

```tsx
      <RunList
        runs={runs}
        current={runId}
        onSelect={setRunId}
        onControl={handleListControl}
        onResume={handleListResume}
      />
```

- [ ] **Step 3: 构建验证**

Run: `cd web && npm run build`
Expected: tsc 通过（注意 `ControlAction` import 需加进 App.tsx 的 type import）。

- [ ] **Step 4: Commit**

```bash
git add web/src/components/RunList.tsx web/src/App.tsx web/src/components/RunControls.tsx && git commit -m "feat(web): RunList 行内控制按钮（phase/paused 感知，⑦）+ TERMINAL_PHASES 收口 api.ts"
```

---

## Task 15: 收尾——roadmap 销项 + AGENTS.md 端点表 + 全量验证

**Files:**
- Modify: `roadmap.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: 后端全量测试**

Run: `python -m pytest tests/ -q`
Expected: 全绿。

- [ ] **Step 2: 库基线**

Run: `cd ../SpecModule && python -m pytest module_harness/tests/ -q -m "not smoke"`
Expected: 全绿。

- [ ] **Step 3: 前端构建**

Run: `cd web && npm run build`
Expected: tsc + vite build 通过。

- [ ] **Step 4: AGENTS.md 端点映射表补两行**

`AGENTS.md` 库接口→端点映射表 `GET /api/runs/{id}/process` 行之后加：

```markdown
| `POST /api/runs/{id}/resume/preflight` | `query.check_resume_compat_from_run(module, run_id, new_tasklist=..., target=..., base_dir=...)`（库共享组合函数） | `{target, target_tick, executed_nodes, hard_errors, warnings}`；不 spawn 不写状态；兼容性 hard_errors 是 200 载荷；无 run.sqlite → 404、tasklist 非法/建图失败（ValueError）→ 400 |
| `POST /api/runs/{id}/process/terminate` | server 注册表 `Popen.terminate()`（Windows=硬杀） | `{run_id, terminated: true, pid}`；注册表无活进程 → 409（CLI 手起 run 不在观测范围）；不代写终态——status 残留 running 由前端停滞提示引导强制恢复 |
```

`GET /api/runs` 行的 Shape 列补 `paused`：`[{run_id, phase, tick, error, updated_at, paused}]`。

- [ ] **Step 5: roadmap 销项**

`roadmap.md`：阶段 2 控制缺口切片 6 个条目全部 `- [x]`；「控制功能缺口盘点」节开头补一句：`（2026-08-31 本轮全部补齐：② 预检经库侧收编 check_resume_compat_from_run，⑤ terminate 附头部按钮出口，其余见阶段 2 切片；下文为盘点原文存档。）`；变更日志追加：

```markdown
- 2026-08-31（控制缺口补齐）：7 项缺口全部落地。库侧收编
  `query.check_resume_compat_from_run`（executed_nodes 规则同步抽 `_executed_nodes`
  单一事实源；库仓库 feat+docs+refactor 三笔）；本仓库 preflight/terminate 两端点 +
  `GET /api/runs` 补 paused；前端恢复对话框（tasklist 预填编辑区、预检内联展示、
  fired 上下文、JSON 即时校验、文件载入改编辑区）+ 检查点创建对话框 + 停滞黄条 +
  terminate 按钮 + RunList 行内控制。
```

- [ ] **Step 6: Commit**

```bash
git add roadmap.md AGENTS.md && git commit -m "docs: 控制缺口 7 项销项——阶段 2 切片打勾 + 端点表补 preflight/terminate/paused + 变更日志"
```

---

## 验收走查清单（实施完成后人工/浏览器过一遍）

1. 打开 mock run → header 出现「存检查点…」→ 建 label → 成功提示（①）
2. 恢复/回退对话框：tasklist 编辑区已预填归档 JSON（③）；改坏 JSON → 红框行内错误（⑦）
3. 对话框打开 ~0.5s 后出现预检结果；选不存在目标 → hard_error 红列表 + 启动禁用（②）
4. 目标下拉显示「已执行 N 节点：A→B→C」；选中显示完整列表（⑥）
5. M1 mock run 运行中：列表行 ⏸/✕ 可用；暂停后 ▶；终态后 ↻ 打开对话框（⑦）
6. resume 一个 mock run 后 header 出现「终止进程」；点击确认后进程消失（⑤）
7. 终止/截断的 run：phase=running 停留，120s 后黄条出现 → 按钮打开对话框可勾选强制恢复（④）
