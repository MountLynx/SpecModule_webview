# 运行列表与轮询机制根修 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 运行列表单次获取成本与历史规模解耦（上游新增 `recent_runs` 惰性原语 + 只读 tick 连接），前端列表去周期轮询改手动+钩子刷新。

**Architecture:** 两个仓库联动——上游 SpecModule 库新增共享查询原语（统一 API 原则：机制收编库，消费端薄映射）；webview 后端 `/api/runs` 改薄调用；前端去掉 `setInterval` 轮询，改手动刷新按钮 + 事件钩子（发起/删除/行内控制/页签终态）。

**Tech Stack:** Python ≥3.10 + pytest（库）；FastAPI + httpx TestClient（webview 后端）；Vite + React + TS（前端，`npm run build` = tsc --noEmit + vite build 验收门）。

**设计文档:** `docs/superpowers/specs/2026-09-15-run-list-decoupling-design.md`（背景实测数据/决策记录）

**仓库注意:** Task 1–4 在 **`../SpecModule`（兄弟仓库，独立 git）** 进行，提交遵循其 AGENTS.md（中文 docstring、`from __future__ import annotations`、文档 `docs:` 前缀独立提交）；Task 5–7 在 **本仓库（SpecModule_webview）** 进行。Task 1–4 不要在 webview 的 worktree 里做。

**背景实测（4821 个历史 run / 2924 个带 sqlite）:** `list_runs` 10.2s（其中 `_latest_tick_light` 逐 run 开 `SqliteBackend` 6.6s；`SqliteBackend.__init__` 每次建连都跑 `PRAGMA journal_mode=WAL` + 建表检查 = 写锁）；`os.scandir` 枚举目录名+mtime 仅 0.01s（不打开文件）。

---

### Task 1: 库——抽取 `_run_row` 单行构建辅助（纯重构，既有测试守护）

**Files:**
- Modify: `../SpecModule/module_harness/infra/query.py`（`list_runs`，约 412–482 行）
- Test: `../SpecModule/module_harness/tests/test_run_history.py`（既有，不改）

- [ ] **Step 1: 确认既有测试全绿（重构前基线）**

```bash
cd ../SpecModule && uv run pytest module_harness/tests/test_run_history.py -q
```

Expected: 全部 PASS（若有失败先停下排查，不得带病重构）。

- [ ] **Step 2: 抽取 `_run_row` 并让 `list_runs` 复用**

在 `_latest_tick_light` 之后、`list_runs` 之前插入（docstring 中文，风格照旧）：

```python
def _run_row(run_dir: Path, *, tick_fallback: bool) -> dict[str, Any]:
    """单 run 行构建（list_runs / recent_runs 共用）：读 status.json + sqlite 存在性。

    tick 语义：status.json 的 ``tick`` 键优先（前瞻兼容）；无键且
    ``tick_fallback`` 且有 sqlite 时回落 :func:`_latest_tick_light` 近似；
    否则 None。容错：status.json 缺失/损坏 → phase="unknown" 收入不跳过
    （删除入口要对坏目录可用），updated_at 记 0.0、module 记 None。
    """
    run_id = run_dir.name
    has_sqlite = (run_dir / "run.sqlite").exists()
    data: dict[str, Any] | None = None
    try:
        loaded = json.loads(
            (run_dir / "status.json").read_text(encoding="utf-8")
        )
        if isinstance(loaded, dict):
            data = loaded
    except (OSError, ValueError):
        data = None          # 缺失/损坏 → unknown（不跳过，删除入口可用）
    module: str | None = None
    error: str | None = None
    phase = "unknown"
    updated_at = 0.0
    if data is not None:
        if isinstance(data.get("module"), str):
            module = data["module"]
        raw_err = data.get("error")
        if raw_err is not None:
            error = str(raw_err)
        if data.get("phase"):
            phase = str(data["phase"])
        try:
            updated_at = float(data.get("updated_at", 0.0))
        except (TypeError, ValueError):
            updated_at = 0.0
    tick: int | None = None
    if data is not None and isinstance(data.get("tick"), int) \
            and not isinstance(data.get("tick"), bool):
        tick = data["tick"]
    elif tick_fallback and has_sqlite:
        tick = _latest_tick_light(run_dir / "run.sqlite", run_id)
    return {
        "run_id": run_id,
        "module": module,
        "phase": phase,
        "tick": tick,
        "error": error,
        "updated_at": updated_at,
        "has_sqlite": has_sqlite,
    }
```

`list_runs` 的函数体替换为（docstring 不动；原内联行构建逻辑全部移入 `_run_row`）：

```python
    root = _runs_root(base_dir)
    if not root.is_dir():
        return []
    try:
        run_dirs = sorted(d for d in root.iterdir() if d.is_dir())
    except OSError:
        log.exception("扫描 runs 目录失败（返回空列表）: %s", root)
        return []
    out = [_run_row(d, tick_fallback=True) for d in run_dirs]
    out.sort(key=lambda r: (r["updated_at"], r["run_id"]), reverse=True)
    return out
```

- [ ] **Step 3: 跑测试确认行为不变**

```bash
cd ../SpecModule && uv run pytest module_harness/tests/test_run_history.py -q
```

Expected: 全部 PASS。

- [ ] **Step 4: Commit**

```bash
cd ../SpecModule && git add module_harness/infra/query.py
git commit -m "refactor: query 单行构建抽 _run_row（list_runs 复用，行为不变）"
```

---

### Task 2: 库——`recent_runs` 惰性快速列表原语（TDD）

**Files:**
- Modify: `../SpecModule/module_harness/infra/query.py`（新增函数 + 顶部 `import os`）
- Test: `../SpecModule/module_harness/tests/test_run_history.py`

- [ ] **Step 1: 写失败测试（`TestRecentRuns`，追加在 `TestListRuns` 类之后）**

测试文件顶部 import 改为：

```python
from module_harness.infra.query import delete_run, list_runs, recent_runs
```

追加测试类：

```python
class TestRecentRuns:
    def test_empty_when_no_runs_root(self, tmp_path):
        assert recent_runs(base_dir=tmp_path) == {"runs": [], "total": 0}

    def test_files_skipped(self, tmp_path):
        root = tmp_path / ".specmodule" / "runs"
        root.mkdir(parents=True)
        (root / "stray.txt").write_text("x", encoding="utf-8")
        assert recent_runs(base_dir=tmp_path) == {"runs": [], "total": 0}

    def test_limit_and_total(self, tmp_path):
        """尾部只计不展开；total = 全量 run 目录数。"""
        for i in range(5):
            _write_status(tmp_path, f"run_{i}", updated_at=100.0 + i)
        out = recent_runs(base_dir=tmp_path, limit=2)
        assert out["total"] == 5
        assert [r["run_id"] for r in out["runs"]] == ["run_4", "run_3"]

    def test_mtime_sort_desc_tie_by_name(self, tmp_path):
        """按 status.json mtime 降序（与 updated_at 字段值无关）；同值按名降序。"""
        import os
        import time
        _write_status(tmp_path, "run_a", updated_at=1.0)
        _write_status(tmp_path, "run_b", updated_at=2.0)
        _write_status(tmp_path, "run_c", updated_at=3.0)
        now = time.time()
        for run_id, age in (("run_a", 600), ("run_b", 60), ("run_c", 600)):
            p = tmp_path / ".specmodule" / "runs" / run_id / "status.json"
            os.utime(p, (now - age, now - age))
        out = recent_runs(base_dir=tmp_path)
        # run_b mtime 最新居首；run_a/run_c 同 mtime 按名降序 → run_c 先
        assert [r["run_id"] for r in out["runs"]] == ["run_b", "run_c", "run_a"]

    def test_tick_no_sqlite_fallback(self, tmp_path):
        """recent_runs 不做 sqlite tick 近似：无 status.json tick 键 → None。"""
        run_dir = _write_status(tmp_path, "run_t", phase="running")
        backend = SqliteBackend(run_dir / "run.sqlite")
        backend.save_snapshot("run_t", 3, {
            "tick": 3, "marking": {}, "run_state": {"keep_records": True},
            "status": "running", "fireable": [], "fired": [],
        })
        backend.close()
        (row,) = recent_runs(base_dir=tmp_path)["runs"]
        assert row["tick"] is None
        # 全量语义不变：list_runs 仍近似出 3
        assert list_runs(base_dir=tmp_path)[0]["tick"] == 3

    def test_corrupt_status_in_top_n_included_as_unknown(self, tmp_path):
        """status.json 损坏的 run 在前 N 条内 → phase=unknown 收入不跳过。"""
        run_dir = tmp_path / ".specmodule" / "runs" / "bad_run"
        run_dir.mkdir(parents=True)
        (run_dir / "status.json").write_text("{{", encoding="utf-8")
        out = recent_runs(base_dir=tmp_path)
        assert out["total"] == 1
        assert out["runs"][0]["run_id"] == "bad_run"
        assert out["runs"][0]["phase"] == "unknown"
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd ../SpecModule && uv run pytest module_harness/tests/test_run_history.py::TestRecentRuns -q
```

Expected: FAIL——`ImportError: cannot import name 'recent_runs'`。

- [ ] **Step 3: 实现 `recent_runs`**

`query.py` 顶部 import 区（`import json` 旁）加：

```python
import os
```

在 `_run_row` 之后、`list_runs` 之前插入：

```python
def recent_runs(base_dir: Path | None = None, *, limit: int = 100) -> dict[str, Any]:
    """最近运行快速列表（Web 列表共享层）：单次成本与历史规模解耦。

    ``os.scandir`` 取目录名 + status.json mtime（Windows 上随枚举自带，不逐项
    打开文件），mtime 降序（同值按目录名降序）——运行中的 run 每 tick 重写
    status.json，mtime 必然新近、必然落在前 ``limit`` 条内。只对前 ``limit``
    条读 status.json 构建完整行（行形状同 :func:`list_runs`，经 ``_run_row``），
    且 tick **不回落 sqlite 近似**（旧 run 无 status.json tick 键 → None）。
    尾部不展开，以 ``total`` 透出全量目录数供消费端提示（更早历史走 CLI
    ``runs``）。容错同 ``list_runs``：runs 根不存在 / 扫描失败 →
    ``{"runs": [], "total": 0}``；limit ≤ 0 → 只计数不展开。
    """
    root = _runs_root(base_dir)
    if not root.is_dir():
        return {"runs": [], "total": 0}
    try:
        with os.scandir(root) as it:
            entries = [(e.name, e.stat().st_mtime) for e in it if e.is_dir()]
    except OSError:
        log.exception("扫描 runs 目录失败（返回空列表）: %s", root)
        return {"runs": [], "total": 0}
    entries.sort(key=lambda t: (t[1], t[0]), reverse=True)
    top = entries[:limit] if limit > 0 else []
    rows = [_run_row(root / name, tick_fallback=False) for name, _ in top]
    return {"runs": rows, "total": len(entries)}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd ../SpecModule && uv run pytest module_harness/tests/test_run_history.py -q
```

Expected: 全部 PASS（含既有 `TestListRuns`）。

- [ ] **Step 5: Commit**

```bash
cd ../SpecModule && git add module_harness/infra/query.py module_harness/tests/test_run_history.py
git commit -m "feat: 共享层 recent_runs——Web 快速列表惰性原语（mtime 前 N 条展开 + total 计数，历史规模解耦）"
```

---

### Task 3: 库——`_latest_tick_light` 换只读连接（perf，契约不变）

**Files:**
- Modify: `../SpecModule/module_harness/infra/query.py`（`_latest_tick_light`，约 393–409 行）
- Test: `../SpecModule/module_harness/tests/test_run_history.py`

- [ ] **Step 1: 写失败测试（坏 db 容错回归，追加到 `TestListRuns` 类内）**

```python
    def test_latest_tick_corrupt_db_is_none(self, tmp_path):
        """_latest_tick_light 容错：坏 db → tick=None，列表照常返回该 run。"""
        run_dir = tmp_path / ".specmodule" / "runs" / "run_bad"
        run_dir.mkdir(parents=True)
        (run_dir / "run.sqlite").write_text("not a db{{", encoding="utf-8")
        _write_status(tmp_path, "run_bad", updated_at=1.0)
        (row,) = list_runs(base_dir=tmp_path)
        assert row["run_id"] == "run_bad"
        assert row["tick"] is None
```

- [ ] **Step 2: 跑测试确认通过（旧实现也容错——本测试是回归守护，不是驱动失败）**

```bash
cd ../SpecModule && uv run pytest "module_harness/tests/test_run_history.py::TestListRuns::test_latest_tick_corrupt_db_is_none" -q
```

Expected: PASS（此任务由既有 `test_tick_from_latest_snapshot` + 本测试共同守护，属语义不变的替换）。

- [ ] **Step 3: 替换 `_latest_tick_light` 实现（docstring 一并更新）**

```python
def _latest_tick_light(db_path: Path, module_id: str) -> int | None:
    """轻量读最新 tick（只读连接单条 max 查询，不解析快照）；失败 → None。

    list 场景的权衡：不对每个 run 全量解析 run.sqlite，tick 用一条 max 查询
    近似（监控列表足够；详情走 query_run_status）。连接用只读 URI 模式而非
    ``SqliteBackend``：后者建连即 ``PRAGMA journal_mode=WAL`` + 建表检查（每次
    打开都是写锁，历史一大列表端点就不可用）；路径经 ``as_uri`` 百分号编码
    （中文/空格安全）。只读打开 WAL 库需 -shm 侧车在（活跃写入方必然已建），
    残留 -wal 且无 -shm 的脏库打不开 → 按契约记 None。
    """
    try:
        import sqlite3

        con = sqlite3.connect(f"{db_path.as_uri()}?mode=ro", uri=True)
        try:
            row = con.execute(
                "SELECT MAX(tick) FROM snapshots WHERE session_id = ?",
                (module_id,),
            ).fetchone()
        finally:
            con.close()
        return row[0] if row and row[0] is not None else None
    except Exception:
        log.exception("读取最新 tick 失败（记 None）: %s", db_path)
        return None
```

- [ ] **Step 4: 跑测试文件确认全绿（含既有 tick 近似测试——它守护只读路径正确性）**

```bash
cd ../SpecModule && uv run pytest module_harness/tests/test_run_history.py -q
```

Expected: 全部 PASS。特别确认 `test_tick_from_latest_snapshot`（只读连接在 SqliteBackend 干净关闭后的库上必须取到 3）。

- [ ] **Step 5: Commit**

```bash
cd ../SpecModule && git add module_harness/infra/query.py module_harness/tests/test_run_history.py
git commit -m "perf: _latest_tick_light 换只读连接——list_runs 免 SqliteBackend 建连写锁"
```

---

### Task 4: 库——全量基线 + api.md 补录（独立 docs 提交）

**Files:**
- Modify: `../SpecModule/docs/references/api.md`（`list_runs` 行之后、`delete_run` 行之前插入一行；并更新 `list_runs` 行的消费端表述）

- [ ] **Step 1: 库测试基线（合并前纪律）**

```bash
cd ../SpecModule && uv run pytest module_harness/tests/ -q -m "not smoke"
```

Expected: 全部 PASS。

- [ ] **Step 2: api.md 表格 `list_runs` 行（"CLI `runs` / Web 共用"）改为 "CLI `runs` 消费"，并在其后插入 `recent_runs` 行**

`list_runs` 行开头原片段：

```
| `list_runs` | `(base_dir: Path \| None = None) -> list[dict]` | 枚举全部运行（run 历史列表共享层，CLI `runs` / Web 共用）：扫
```

改为：

```
| `list_runs` | `(base_dir: Path \| None = None) -> list[dict]` | 枚举全部运行（run 历史全量列表共享层，CLI `runs` 消费）：扫
```

紧随其后插入新行：

```
| `recent_runs` | `(base_dir: Path \| None = None, *, limit: int = 100) -> dict` | 最近运行快速列表（Web 列表共享层，2026-09-15）：`os.scandir` 枚举 run 目录，排序键锚定各目录 status.json 自身 mtime（每目录一次元数据 stat，不打开文件内容；单条 stat 失败逐条跳过），mtime 降序（同值按目录名降序）——非终态 run 在 phase 迁移时重写 status.json 刷新 mtime，新发起的 run 必然靠前；长跑 run（长时间无 phase 迁移）可能滑出前 `limit`，粒度与 `list_runs` 的 updated_at 排序一致，尾部由 total + CLI `runs` 兜底；只对前 `limit` 条读 status.json 构建完整行（形状同 `list_runs`），**tick 不回落 sqlite**（旧 run 无 status.json tick 键 → None）；返回 `{"runs": [...], "total": <run 目录总数>}`（尾部只计不展开，单次成本与历史规模解耦）；容错同 `list_runs`（损坏/缺失 → `phase="unknown"` 不跳过），runs 根不存在 → `{"runs": [], "total": 0}` |
```

- [ ] **Step 3: Commit（docs 独立提交）**

```bash
cd ../SpecModule && git add docs/references/api.md
git commit -m "docs: api.md 补录 recent_runs + list_runs 消费端表述更新（Web 列表改走惰性原语）"
```

---

### Task 5: webview 后端——`GET /api/runs` 改薄映射 `recent_runs`（TDD）

**Files:**
- Modify: `server/api/runs.py:22-37`（列表端点）
- Test: `tests/test_runs_api.py`（`TestRunsList`）

- [ ] **Step 1: 改测试断言新形状（payload 形状 + mtime 确定性顺序 + total）**

`tests/test_runs_api.py` 顶部 import 区改为：

```python
from __future__ import annotations

import json
import os
import time

from tests.conftest import seed_run
```

`test_empty` 断言改为：

```python
    def test_empty(self, client):
        r = client.get("/api/runs")
        assert r.status_code == 200
        assert r.json() == {"runs": [], "total": 0}
```

`test_payload_shape_and_order` 整体替换为：

```python
    def test_payload_shape_and_order(self, base, client):
        """新载荷：query.recent_runs 形状（mtime 前 N 条）+ paused 叠加 + total 计数。"""
        seed_run(base, "r_old", status={"module_id": "r_old", "phase": "done", "updated_at": 1.0})
        seed_run(
            base, "r_new",
            firings=[{"tick": 1, "node": "A", "output": "a1"}],
            snapshots={1: {"tick": 1, "status": "running", "fireable": ["B"], "fired": ["A"]}},
            status={"module_id": "r_new", "module": "mini_graph",
                    "phase": "running", "updated_at": 2.0},
        )
        # 仅 status.json 的失败 run（无 run.sqlite）——has_sqlite False
        bare = base / ".specmodule" / "runs" / "r_bare"
        bare.mkdir(parents=True)
        (bare / "status.json").write_text(
            json.dumps({"module_id": "r_bare", "phase": "aborted",
                        "error": "boom", "updated_at": 3.0}),
            encoding="utf-8",
        )
        # mtime 锚定确定性顺序：r_bare > r_new > r_old（列表按 mtime 降序）
        now = time.time()
        for run_id, age in (("r_old", 600), ("r_new", 60), ("r_bare", 5)):
            p = base / ".specmodule" / "runs" / run_id / "status.json"
            os.utime(p, (now - age, now - age))
        r = client.get("/api/runs")
        assert r.status_code == 200
        body = r.json()
        assert body["total"] == 3
        runs = body["runs"]
        assert [x["run_id"] for x in runs] == ["r_bare", "r_new", "r_old"]
        row = next(x for x in runs if x["run_id"] == "r_new")
        assert set(row) == {
            "run_id", "module", "phase", "tick", "error",
            "updated_at", "has_sqlite", "paused",
        }
        # status.json 溯源字段 → module；sqlite 已落盘 → has_sqlite
        assert row["module"] == "mini_graph"
        assert row["has_sqlite"] is True
        assert row["tick"] == 1
        assert row["paused"] is False
        # 旧 run 无 module 字段 → None（前端回落 run_id 启发式）
        old = next(x for x in runs if x["run_id"] == "r_old")
        assert old["module"] is None
        # 无 sqlite 的失败 run：error 摘要透传 + has_sqlite False
        bare_row = next(x for x in runs if x["run_id"] == "r_bare")
        assert bare_row["has_sqlite"] is False
        assert bare_row["error"] == "boom"
        assert bare_row["tick"] is None
```

（`test_unknown_phase_run_included` 不改：空目录 phase=unknown 语义在 recent_runs 下不变。）

- [ ] **Step 2: 跑测试确认失败**

```bash
cd "C:\Users\xingy\Desktop\开发\SpecModule_webview" && uv run pytest tests/test_runs_api.py::TestRunsList -q
```

Expected: FAIL——`test_empty` 断言 `total` 键不存在、payload 测试 `body["total"]` KeyError。

- [ ] **Step 3: 改端点实现（薄映射）**

`server/api/runs.py` 列表端点整体替换：

```python
@router.get("")
def recent_runs(base_dir: Path = Depends(get_base_dir)) -> dict:
    """运行列表：query.recent_runs（mtime 前 N 条完整行 + total 计数）
    + 逐行 read_control 叠加 paused。

    成本与历史规模解耦——全量枚举不进列表端点（CLI `runs` 保留全量语义），
    更早历史 UI 只透出 total（提示 CLI 查看）；status.json 缺失/损坏的 run
    以 phase="unknown" 收入不跳过（删除入口要对坏目录可用）。
    """
    data = query.recent_runs(base_dir=base_dir)
    rows = []
    for row in data["runs"]:
        req = control.read_control(row["run_id"], base_dir=base_dir)
        rows.append({
            **row,
            "paused": bool(req and req.get("action") == "pause"),
        })
    return {"runs": rows, "total": data["total"]}
```

- [ ] **Step 4: 跑测试确认通过 + 全量后端测试**

```bash
cd "C:\Users\xingy\Desktop\开发\SpecModule_webview" && uv run pytest tests/test_runs_api.py -q && uv run pytest tests/ -q
```

Expected: 全部 PASS（含收编的 tests/treechat 133 例，一并跑）。

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\xingy\Desktop\开发\SpecModule_webview"
git add server/api/runs.py tests/test_runs_api.py
git commit -m "feat(web): /api/runs 改薄映射 recent_runs——列表成本与历史规模解耦"
```

---

### Task 6: webview 前端——去周期轮询，手动刷新 + 事件钩子 + total 提示

**Files:**
- Modify: `web/src/api.ts`（`fetchRuns`，约 129–130 行）
- Modify: `web/src/App.tsx`（70 行 state、98–105 行轮询、275 行注释、390–397 行 RunList props）
- Modify: `web/src/components/RunList.tsx`（props、header、footer）
- Modify: `web/src/ws.ts`（`useRunStream` 终态回调）
- Modify: `web/src/components/RunView.tsx`（73 行传回调）

- [ ] **Step 1: api.ts——payload 类型与 fetchRuns**

在 `RunSummary` 接口之后、`fetchRuns` 处替换：

```ts
/** GET /api/runs 载荷：最近 N 条完整行 + 历史总目录数（尾部只计不展开）。 */
export interface RunsPayload {
  runs: RunSummary[];
  total: number;
}

export const fetchRuns = () => getJson<RunsPayload>("/api/runs");
```

- [ ] **Step 2: App.tsx——去 setInterval，加 runsTotal state**

70 行 `const [runs, setRuns] = useState<RunSummary[]>([]);` 之后加一行：

```tsx
  const [runsTotal, setRunsTotal] = useState(0);
```

98–105 行整体替换为：

```tsx
  // 列表不做周期轮询（2026-09-15 根修，specs/2026-09-15-run-list-decoupling）：
  // 首次加载 + 事件钩子（发起/删除/行内控制/页签终态）触发；页签内监控走 WS
  const refreshRuns = useCallback(() => {
    fetchRuns()
      .then((d) => {
        setRuns(d.runs);
        setRunsTotal(d.total);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    refreshRuns();
  }, [refreshRuns]);
```

275 行注释更新：

```tsx
  // RunList 行内控制：失败静默——控制动作后显式刷新列表，状态即真相
```

（发起 `handleLaunched` / 删除 `handleDeleted` / 行内控制 `handleListControl` 已有 `refreshRuns()` 调用，不动。）

- [ ] **Step 3: RunList.tsx——props + header 刷新按钮 + footer total 提示**

`RunListProps` 增加两行：

```ts
interface RunListProps {
  runs: RunSummary[];
  /** 历史总目录数（尾部只计不展开；> runs.length 时显示提示） */
  total: number;
  current: string | null;
  onSelect: (id: string) => void;
  onControl: (id: string, action: ControlAction) => void;
  onResume: (id: string) => void;
  /** 删除成功回调（壳层刷新列表；删的是当前打开的 run 则清 runId） */
  onDeleted: (runId: string) => void;
  /** 手动刷新（列表不做周期轮询） */
  onRefresh: () => void;
}
```

函数签名解构加 `total,` `onRefresh,`。header 块（78–88 行区域）替换为：

```tsx
      <div className="flex items-center gap-2 px-3.5 pb-2 pt-2.5 text-[12.5px] font-bold">
        运行历史
        <span className="font-normal text-muted-foreground">{total} 条</span>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto h-5 px-1.5 text-[10.5px]"
          onClick={onRefresh}
        >
          ↻ 刷新
        </Button>
        {err && (
          <span title={err} className="min-w-0 truncate font-normal text-[11.5px] text-destructive">
            {err}
          </span>
        )}
      </div>
```

滚动容器末尾、空态提示之前（`{!runs.length && (` 之前）加 footer：

```tsx
        {total > runs.length && (
          <div className="px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
            共 {total} 条 · 仅展开最近 {runs.length} 条，更早历史用 CLI
            <code className="mx-1 font-mono">specmodule runs</code>
            查看
          </div>
        )}
```

- [ ] **Step 4: ws.ts——`useRunStream` 终态回调（ref 透传防重连）**

函数签名与 ref（21–23 行区域）：

```ts
export function useRunStream(
  runId: string | null,
  onTerminal?: () => void,
): StreamState | null {
  const [state, setState] = useState<StreamState | null>(null);
  const terminalRef = useRef(false);
  // 回调经 ref 透传：effect 只依赖 runId，回调换 identity 不触发 WS 重连
  const onTerminalRef = useRef(onTerminal);
  onTerminalRef.current = onTerminal;
```

error 帧分支（42–46 行）：

```ts
        if (data.type === "error") {
          // 服务端错误关闭（如 run 不存在）→ 停止重连，避免错误-关闭-重连循环
          if (!terminalRef.current) onTerminalRef.current?.();
          terminalRef.current = true;
          return;
        }
```

终态分支（73 行）：

```ts
          if (TERMINAL_PHASES.has(data.phase) && !terminalRef.current) {
            terminalRef.current = true;
            onTerminalRef.current?.();
          }
```

- [ ] **Step 5: RunView.tsx——把列表刷新接为终态回调**

73 行改为：

```tsx
  const streamState = useRunStream(materialized ? runId : null, onRefreshRuns);
```

- [ ] **Step 6: App.tsx——RunList 渲染处传新 props（390–397 行）**

```tsx
          <RunList
            runs={runs}
            total={runsTotal}
            current={activeRunId}
            onSelect={openRunTab}
            onControl={handleListControl}
            onResume={handleListResume}
            onDeleted={handleDeleted}
            onRefresh={refreshRuns}
          />
```

- [ ] **Step 7: 构建验收门（tsc --noEmit + vite build）**

```bash
cd "C:\Users\xingy\Desktop\开发\SpecModule_webview\web" && npm run build
```

Expected: 无类型错误，构建成功。

- [ ] **Step 8: Commit**

```bash
cd "C:\Users\xingy\Desktop\开发\SpecModule_webview"
git add web/src/api.ts web/src/App.tsx web/src/components/RunList.tsx web/src/ws.ts web/src/components/RunView.tsx
git commit -m "feat(web): 运行列表去周期轮询——手动刷新+事件钩子+尾部 total 提示"
```

---

### Task 7: webview 文档——AGENTS.md 端点表 + roadmap 变更日志

**Files:**
- Modify: `AGENTS.md`（端点映射表 `GET /api/runs` 行）
- Modify: `roadmap.md`（末尾变更日志追加条目）

- [ ] **Step 1: AGENTS.md `GET /api/runs` 行替换为**

```
| `GET /api/runs` | `query.recent_runs(base_dir=None, limit=100)`（库共享快速列表：status.json mtime 前 N 条完整行 + total 计数，2026-09-15 根修）+ 逐行 `control.read_control` 叠加 `paused` | `{runs: [{run_id, module, phase, tick, error, updated_at, has_sqlite, paused}], total}`；成本与历史规模解耦（更早历史不展开，UI 提示 CLI `runs` 查看）；前端列表不做周期轮询——手动刷新 + 事件钩子（发起/删除/行内控制/页签终态）；`module` = status.json 溯源字段（旧 run → None，前端回落 run_id 启发式）；status.json 缺失/损坏 → `phase="unknown"` 收入不跳过（删除入口对坏目录可用） |
```

- [ ] **Step 2: roadmap.md 变更日志末尾追加**

```
- 2026-09-15 **运行列表与轮询机制根修**——实测 4821 个历史 run 下 `GET /api/runs`
  单次 12.5s（`list_runs` 10.2s，其中给 2924 个旧 run 逐个开 `SqliteBackend` 查
  tick 占 6.6s），前端 5s 周期轮询把页面拖死。收编上游：库新增 `query.recent_runs`
  （status.json mtime 排序只展开前 N 条 + total 计数，phase 迁移刷新排序键故活跃
  run 靠前，成本与历史规模解耦）、`_latest_tick_light` 换只读连接（免建连写锁，
  CLI 全量 `runs` 10s→4s）；webview `/api/runs` 改薄映射，前端列表去 5s 轮询改
  手动刷新 + 事件钩子（发起/删除/行内控制/页签终态），尾部按 total 提示更早历史
  走 CLI。已知后续：同页签 resume 不重挂载 RunView、WS 不 re-arm，恢复跑完的
  终态钩子不触发（预存 WS 生命周期限制，去轮询后显性化；列表靠手动刷新/其他
  钩子兜底），留后续处理。设计/计划：
  webview `/api/runs` 改薄映射，前端列表去 5s 轮询改手动刷新 + 事件钩子（发起/
  删除/行内控制/页签终态），尾部按 total 提示更早历史走 CLI。设计/计划：
  `docs/superpowers/specs/2026-09-15-run-list-decoupling-design.md`、
  `docs/superpowers/plans/2026-09-15-run-list-decoupling.md`。
```

- [ ] **Step 3: Commit**

```bash
cd "C:\Users\xingy\Desktop\开发\SpecModule_webview"
git add AGENTS.md roadmap.md
git commit -m "docs: AGENTS/roadmap 同步运行列表根修（recent_runs 薄映射 + 去周期轮询）"
```

- [ ] **Step 4: 设计文档勘误补记（docs/superpowers/specs/2026-09-15-run-list-decoupling-design.md 末尾追加）**

```markdown

## 勘误（实施期修正，2026-09-15）

1. 排序键为各 run 目录 **status.json 自身 mtime**（每目录一次元数据 stat），
   非「scandir 自带 find 数据、不额外打开文件」——原表述针对的是目录自身
   mtime，而目录 mtime 会因 WAL 侧车（-wal/-shm）增删被污染，且不区分是
   哪个子项变化；status.json 文件 mtime 才精确刻画状态写入时刻。
2. status.json 按 **phase 迁移**重写（非每 tick）；长跑 run（长时间无
   phase 迁移）可能滑出前 N，粒度与 `list_runs` 的 updated_at 排序一致，
   尾部由 total + CLI `runs` 兜底。
```

追加后一并提交：

```bash
cd "C:\Users\xingy\Desktop\开发\SpecModule_webview"
git add docs/superpowers/specs/2026-09-15-run-list-decoupling-design.md
git commit -m "docs: 运行列表设计文档勘误（排序键锚定 status.json mtime + phase 迁移粒度）"
```

---

### Task 8: 端到端验证（手动，不提交）

- [ ] **Step 1: 起后端 + 前端**

```bash
# 终端 1（后端；沿用本机已验证的 env 组合）
cd "C:\Users\xingy\Desktop\开发\SpecModule_webview" && SPECMODULE_BASE="C:/Users/xingy/Desktop/开发/SpecModule" SPECMODULE_PATH="C:/Users/xingy/Desktop/开发/SpecModule/example/modules" PYTHONPATH="C:/Users/xingy/Desktop/开发/SpecModule" uv run uvicorn server.app:app --port 8000
# 终端 2
cd "C:\Users\xingy\Desktop\开发\SpecModule_webview\web" && npm run dev
```

- [ ] **Step 2: 计时验证列表端点**

```bash
curl -s -o /dev/null -w "%{time_total}s\n" http://localhost:8000/api/runs
```

Expected: **< 0.5s**（4821 目录下此前 12.5s）；响应体含 `"total": 4821` 量级计数。

- [ ] **Step 3: 浏览器验证（http://localhost:5173）**

1. 侧栏「运行历史」秒出列表（非 30s 白屏），头部显示真实总条数 + 「↻ 刷新」按钮；尾部出现「共 N 条 · 仅展开最近 100 条…」提示（total > 100 时）。
2. DevTools Network 面板确认 `/api/runs` **只有一次请求**（无 5s 周期轮询）。
3. 点「↻ 刷新」→ 恰好一次新请求。
4. 从「模块库」发起任一 mock/真实 run → 列表自动出现新 run（发起钩子）。
5. 打开运行页签观察到终态（或删除一个 run）→ 列表自动刷新（钩子生效）。
6. 页签内图/状态/时间线监控行为与改造前一致。

- [ ] **Step 4: 汇报**——向用户给出两个服务的启动命令与验证结论（服务不常驻，由用户按需拉起）。
