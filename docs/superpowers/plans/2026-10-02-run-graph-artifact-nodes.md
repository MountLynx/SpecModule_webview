# 运行图产物节点（中间产物上图）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 节点输出里的文件引用（中间产物）与声明制交付物作为卫星卡出现在运行图上——产出即上图、点击下载。

**Architecture:** 库共享层新增 `query.node_artifacts`（firings 末条输出 → 存在性锚定提取，统一 API 原则）；server graph/WS 端点叠加 `artifacts` 字段 + 新增节点级下载端点（路径永不为客户端输入）；前端 dagre 尺寸化布局 + `ArtifactNode` 卫星卡（虚线接生产者、点击下载）。设计定稿：`docs/superpowers/specs/2026-10-02-run-graph-artifact-nodes-design.md`。

**Tech Stack:** Python ≥3.10（uv、pytest + tickflow SqliteBackend fixture）、FastAPI、React + TS + @xyflow/react + @dagrejs/dagre。

**依赖顺序:** Task 1-2 在 SpecModule 仓库（editable 安装，落地即对本仓库可见）；Task 3-7 依赖 Task 1；Task 8 收尾（全量验证 + 双线同步）。两个仓库路径：本仓库 `C:\Users\xingy\Desktop\开发\SpecModule_webview`，库仓库 `C:\Users\xingy\Desktop\开发\SpecModule`（下文用 `<LIB>` 指代）。

---

### Task 1: 库侧 `query.node_artifacts`（TDD，SpecModule 仓库）

> 执行修订（2026-10-02 质量审查）：提取循环改为「每节点严格末条 output」——
> 先按 append 序无条件覆盖收集 `last[node] = output`，再对该 dict 做存在性
> 提取与跨节点去重（原计划代码遍历全部 firing，refire 无引用时残留旧产物、
> 去重跨代泄漏）；测试 8 基础 + 3 回归 = 11。已按此落地（fix commit）。

**Files:**
- Create: `<LIB>/module_harness/tests/test_node_artifacts.py`
- Modify: `<LIB>/module_harness/infra/query.py`（imports + `read_artifacts` 之后新增函数）

- [ ] **Step 1: 前置检查库仓库状态**

Run: `git -C "C:\Users\xingy\Desktop\开发\SpecModule" status -sb`
Expected: 当前在默认分支（main），无与本任务冲突的未提交改动（无关脏文件不阻塞，提交时只加本任务文件）。

- [ ] **Step 2: 写失败测试**

创建 `<LIB>/module_harness/tests/test_node_artifacts.py`：

```python
# module_harness/tests/test_node_artifacts.py
"""query.node_artifacts：节点输出文件引用提取（存在性锚定 + 去重 + 交付物比对）。"""

from __future__ import annotations

import json

from tickflow.persistence import SqliteBackend
from tickflow.state import NodeState

from module_harness.infra.query import node_artifacts


def _seed(tmp_path, module_id="mod_x", firings=(), artifacts=None):
    run_dir = tmp_path / ".specmodule" / "runs" / module_id
    run_dir.mkdir(parents=True, exist_ok=True)
    backend = SqliteBackend(run_dir / "run.sqlite")
    for f in firings:
        backend.save_firing(module_id, NodeState(**f))
    backend.close()
    if artifacts is not None:
        (run_dir / "artifacts.json").write_text(
            json.dumps({"run_id": module_id, "artifacts": artifacts},
                       ensure_ascii=False),
            encoding="utf-8",
        )
    return tmp_path


def _touch(base, rel: str):
    p = base / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("x" * 11, encoding="utf-8")
    return p


class TestNodeArtifacts:
    def test_no_db_returns_none(self, tmp_path):
        assert node_artifacts("mod_x", base_dir=tmp_path) is None

    def test_relative_path_resolved_and_filtered(self, tmp_path):
        _touch(tmp_path, "projects/demo/page.svg")
        _seed(tmp_path, firings=[{
            "tick": 1, "node": "P1",
            "output": {"status": "ok", "file": "projects/demo/page.svg",
                       "note": "projects/demo/missing.svg"},
        }])
        result = node_artifacts("mod_x", base_dir=tmp_path)
        assert result is not None
        assert list(result) == ["P1"]
        (e,) = result["P1"]
        assert e["index"] == 0
        assert e["key"] == "file"
        assert e["name"] == "page.svg"
        assert e["kind"] == "intermediate"
        assert e["size"] == 11
        assert e["path"] == str(tmp_path / "projects" / "demo" / "page.svg")

    def test_nested_list_key_and_dedupe_within_node(self, tmp_path):
        a = _touch(tmp_path, "exports/a.pptx")
        _seed(tmp_path, firings=[{
            "tick": 1, "node": "R",
            "output": {"pptx": ["exports/a.pptx", "exports/a.pptx",
                                "exports/gone.pptx"]},
        }])
        result = node_artifacts("mod_x", base_dir=tmp_path)
        (e,) = result["R"]
        assert e["key"] == "pptx.0"
        assert e["path"] == str(a)

    def test_cross_node_dedupe_first_wins(self, tmp_path):
        _touch(tmp_path, "shared.bin")
        _seed(tmp_path, firings=[
            {"tick": 1, "node": "A", "output": {"file": "shared.bin"}},
            {"tick": 2, "node": "B", "output": {"file": "shared.bin"}},
        ])
        result = node_artifacts("mod_x", base_dir=tmp_path)
        assert list(result) == ["A"]

    def test_last_firing_wins(self, tmp_path):
        _touch(tmp_path, "old.bin")
        _touch(tmp_path, "new.bin")
        _seed(tmp_path, firings=[
            {"tick": 1, "node": "P", "output": {"file": "old.bin"}},
            {"tick": 2, "node": "P", "output": {"file": "new.bin"}},
        ])
        result = node_artifacts("mod_x", base_dir=tmp_path)
        (e,) = result["P"]
        assert e["name"] == "new.bin"

    def test_deliverable_kind_from_manifest(self, tmp_path):
        p = _touch(tmp_path, "exports/final.pptx")
        _seed(tmp_path, firings=[
            {"tick": 1, "node": "E", "output": {"file": "exports/final.pptx"}},
        ], artifacts=[{
            "name": "成品", "kind": "deliverable", "path": str(p),
            "size": 11, "modified": "2026-10-02T08:00:00",
        }])
        (e,) = node_artifacts("mod_x", base_dir=tmp_path)["E"]
        assert e["kind"] == "deliverable"

    def test_absolute_path_and_plain_strings_ignored(self, tmp_path):
        p = _touch(tmp_path, "abs.bin")
        _seed(tmp_path, firings=[{
            "tick": 1, "node": "M",
            "output": {"ok": "ok", "digest": "# 标题\n正文",
                       "abs_file": str(p)},
        }])
        result = node_artifacts("mod_x", base_dir=tmp_path)
        (e,) = result["M"]
        assert e["key"] == "abs_file"
        assert len(result["M"]) == 1

    def test_directory_value_skipped(self, tmp_path):
        (tmp_path / "projects" / "demo").mkdir(parents=True)
        _seed(tmp_path, firings=[{
            "tick": 1, "node": "I", "output": {"output_dir": "projects/demo"},
        }])
        assert node_artifacts("mod_x", base_dir=tmp_path) == {}
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd "C:\Users\xingy\Desktop\开发\SpecModule_webview" && uv run pytest ../SpecModule/module_harness/tests/test_node_artifacts.py -q`
Expected: FAIL —— `ImportError: cannot import name 'node_artifacts'`。

- [ ] **Step 4: 实现**

修改 `<LIB>/module_harness/infra/query.py`：

(a) imports 区（现有 `import json` / `import logging` / `import os` 之后）补两行：

```python
from collections.abc import Iterator
from datetime import datetime
```

(b) 在 `read_artifacts` 函数之后、`# ── run 枚举与删除` 注解行之前插入：

```python
_ARTIFACT_STR_MAX = 512


def _walk_strings(value: Any, prefix: str = "") -> Iterator[tuple[str, str]]:
    """递归展开 output（dict/list），产出 (dot-path, 字符串值)；其他类型跳过。"""
    if isinstance(value, str):
        yield prefix, value
    elif isinstance(value, dict):
        for k, v in value.items():
            yield from _walk_strings(v, f"{prefix}.{k}" if prefix else str(k))
    elif isinstance(value, (list, tuple)):
        for i, v in enumerate(value):
            yield from _walk_strings(v, f"{prefix}.{i}" if prefix else str(i))


def node_artifacts(
    module_id: str, base_dir: Path | None = None
) -> dict[str, list[dict[str, Any]]] | None:
    """按节点提取输出中的文件引用（图产物叠加共享层：Web 图/WS 推送共用）。

    提取源 = build_timeline 每节点末条 output（与 node_run_summary 同源同容错，
    append 序末条即最新 firing）；递归收集字符串值 → 解析（绝对直通；相对锚
    ``base_dir or Path.cwd()``——与 run 子进程 cwd 同一纪律）→ ``os.path.isfile``
    存在性锚定（"ok"/markdown/stdout blob 天然不命中，零启发式关键词）。

    条目：``{index, key, name, path, kind, size, modified}``——key 为值在输出内
    的 dot-path（``file`` / ``pptx.1``）；kind 与 artifacts.json 声明清单按
    path 全等比对（命中 = 清单 kind，缺省 intermediate）；节点内/跨节点均按
    解析路径去重（跨节点 timeline append 序先到先得）。目录值不收（isfile
    纪律同 collect_artifacts「v1 只收文件」）。db 缺失/读失败 → None。
    """
    tl = build_timeline(module_id, base_dir=base_dir)
    if tl is None:
        return None
    anchor = base_dir if base_dir is not None else Path.cwd()
    manifest: dict[str, dict[str, Any]] = {}
    data = read_artifacts(module_id, base_dir=base_dir)
    if data is not None:
        for e in data["artifacts"]:
            p = e.get("path")
            if isinstance(p, str):
                manifest[os.path.abspath(p)] = e
    result: dict[str, list[dict[str, Any]]] = {}
    claimed: set[str] = set()
    for entry in tl.entries:
        if entry.output is None:
            continue
        seen: set[str] = set()
        items: list[dict[str, Any]] = []
        for key, raw in _walk_strings(entry.output):
            if not raw or "\n" in raw or len(raw) > _ARTIFACT_STR_MAX:
                continue
            if os.path.isabs(raw):
                path = os.path.abspath(raw)
            else:
                path = os.path.abspath(anchor / raw)
            if path in seen or path in claimed or not os.path.isfile(path):
                continue
            seen.add(path)
            claimed.add(path)
            try:
                st = os.stat(path)
            except OSError:
                continue
            declared = manifest.get(path)
            kind = declared.get("kind") if declared else None
            items.append({
                "index": len(items),
                "key": key,
                "name": os.path.basename(path),
                "path": path,
                "kind": kind if kind in ("deliverable", "intermediate") else "intermediate",
                "size": st.st_size,
                "modified": datetime.fromtimestamp(
                    st.st_mtime).isoformat(timespec="seconds"),
            })
        if items:
            result[entry.node] = items
    return result
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd "C:\Users\xingy\Desktop\开发\SpecModule_webview" && uv run pytest ../SpecModule/module_harness/tests/test_node_artifacts.py -q`
Expected: 11 passed（8 基础 + 3 质量审查回归）。

- [ ] **Step 6: 库基线回归**

Run: `cd "C:\Users\xingy\Desktop\开发\SpecModule_webview" && uv run pytest ../SpecModule/module_harness/tests/ -q -m "not smoke"`
Expected: 全绿（0 failed）。

- [ ] **Step 7: 提交（库仓库）**

```bash
git -C "C:\Users\xingy\Desktop\开发\SpecModule" add module_harness/infra/query.py module_harness/tests/test_node_artifacts.py
git -C "C:\Users\xingy\Desktop\开发\SpecModule" commit -m "feat(query): node_artifacts——节点输出文件引用提取（图产物叠加共享层）"
```

### Task 2: api.md 补录（库仓库独立 docs 提交）

**Files:**
- Modify: `<LIB>/docs/references/api.md`（`module_harness.infra.query` 表格 `node_run_summary` 行之后）

- [ ] **Step 1: 插入表格行**

在 `node_run_summary` 那一行之后加一行（同一表格，管道符转义保持一致）：

```markdown
| `node_artifacts` | `(module_id: str, base_dir: Path \| None = None) -> dict[str, list[dict]] \| None` | 按节点提取输出中的文件引用（图产物叠加共享层：Web 图端点/WS 推送共用）。提取源 = `build_timeline` 每节点末条 output；递归收集字符串值 → 相对路径锚 base_dir 解析（与 run 子进程 cwd 同一纪律）→ `os.path.isfile` 存在性锚定；条目 `{index, key, name, path, kind, size, modified}`，kind 与 artifacts.json 按 path 全等比对（命中=清单 kind）；节点内/跨节点按解析路径去重（跨节点先到先得）；db 缺失/读失败 → `None` |
```

- [ ] **Step 2: 提交**

```bash
git -C "C:\Users\xingy\Desktop\开发\SpecModule" add docs/references/api.md
git -C "C:\Users\xingy\Desktop\开发\SpecModule" commit -m "docs: api.md 补录 query.node_artifacts"
```

### Task 3: server——graph 端点 + WS 推送叠加 `artifacts`（TDD）

**Files:**
- Modify: `server/api/graph.py:81-88`（返回载荷）
- Modify: `server/ws.py:100-116`（sig 变化分支）
- Test: `tests/test_graph_api.py`（追加类）、`tests/test_ws.py`（追加用例）

- [ ] **Step 1: 写失败测试**

`tests/test_graph_api.py` 文件末尾追加：

```python
class TestGraphArtifacts:
    def test_artifacts_overlay_intermediate(self, base, client):
        proj = base / "projects" / "demo"
        proj.mkdir(parents=True)
        (proj / "page_p01.svg").write_text("<svg/>", encoding="utf-8")
        _seed_graph_run(base, firings=[
            {"tick": 1, "node": "A",
             "output": {"status": "ok", "file": "projects/demo/page_p01.svg"}},
        ])
        r = client.get("/api/runs/mini_graph/graph")
        assert r.status_code == 200
        arts = r.json()["artifacts"]
        assert list(arts) == ["A"]
        e = arts["A"][0]
        assert e["index"] == 0
        assert e["key"] == "file"
        assert e["name"] == "page_p01.svg"
        assert e["kind"] == "intermediate"
        assert e["size"] == 6
        assert e["path"] == str(proj / "page_p01.svg")

    def test_artifacts_deliverable_tagged(self, base, client):
        proj = base / "projects" / "demo"
        proj.mkdir(parents=True, exist_ok=True)
        (proj / "out.pptx").write_bytes(b"PK")
        _seed_graph_run(base, artifacts=[
            {"name": "演示", "kind": "deliverable", "path": str(proj / "out.pptx"),
             "size": 2, "modified": "2026-10-02T08:00:00"},
        ], firings=[
            {"tick": 1, "node": "A", "output": {"pptx": ["projects/demo/out.pptx"]}},
        ])
        r = client.get("/api/runs/mini_graph/graph")
        assert r.json()["artifacts"]["A"][0]["kind"] == "deliverable"

    def test_artifacts_empty_without_file_refs(self, base, client):
        _seed_graph_run(base)  # 默认 firings 输出为纯字符串，无文件引用
        r = client.get("/api/runs/mini_graph/graph")
        assert r.status_code == 200
        assert r.json()["artifacts"] == {}
```

`tests/test_ws.py` 的 `TestStream` 类内追加两个用例：

```python
    def test_status_push_carries_artifacts(self, base, client):
        proj = base / "projects" / "demo"
        proj.mkdir(parents=True)
        (proj / "a.svg").write_text("<svg/>", encoding="utf-8")
        seed_run(
            base, "ws_art",
            firings=[{"tick": 1, "node": "A",
                      "output": {"file": "projects/demo/a.svg"}}],
            status={"module_id": "ws_art", "phase": "running", "updated_at": 1.0},
        )
        with client.websocket_connect("/api/runs/ws_art/stream") as ws:
            msg = ws.receive_json()
            assert msg["type"] == "status"
            assert list(msg["artifacts"]) == ["A"]
            assert msg["artifacts"]["A"][0]["name"] == "a.svg"

    def test_artifacts_key_always_present(self, base, client):
        seed_run(base, "ws_art2",
                 status={"module_id": "ws_art2", "phase": "running", "updated_at": 1.0})
        with client.websocket_connect("/api/runs/ws_art2/stream") as ws:
            msg = ws.receive_json()
            assert msg["artifacts"] == {}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd "C:\Users\xingy\Desktop\开发\SpecModule_webview" && uv run pytest tests/test_graph_api.py::TestGraphArtifacts tests/test_ws.py::TestStream::test_status_push_carries_artifacts tests/test_ws.py::TestStream::test_artifacts_key_always_present -q`
Expected: FAIL —— KeyError `'artifacts'`。

- [ ] **Step 3: 实现 graph 端点**

`server/api/graph.py` 返回字典（`run_graph` 末尾）在 `"node_states": node_states,` 之后加一行：

```python
        "artifacts": query.node_artifacts(run_id, base_dir=base_dir) or {},
```

- [ ] **Step 4: 实现 WS 推送**

`server/ws.py` sig 变化分支内，`node_states = query.node_run_summary(...)` 之后加：

```python
                    artifacts = query.node_artifacts(run_id, base_dir=base_dir) or {}
```

并在 status 推送字典的 `"node_states": node_states,` 之后加：

```python
                            "artifacts": artifacts,
```

- [ ] **Step 5: 运行确认通过**

Run: `cd "C:\Users\xingy\Desktop\开发\SpecModule_webview" && uv run pytest tests/test_graph_api.py tests/test_ws.py -q`
Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add server/api/graph.py server/ws.py tests/test_graph_api.py tests/test_ws.py
git commit -m "feat(server): graph/WS 叠加按节点产物字段（query.node_artifacts 薄映射）"
```

### Task 4: server——节点产物下载端点（TDD）

**Files:**
- Modify: `server/api/runs.py`（`run_artifact_download` 之后新增）
- Test: `tests/test_runs_api.py`（追加类）

- [ ] **Step 1: 写失败测试**

`tests/test_runs_api.py` 文件末尾追加（确认文件头已有 `from tests.conftest import seed_run`，没有则补）：

```python
class TestNodeArtifactDownload:
    """GET /nodes/{node}/artifacts/{index}：路径永不为客户端输入（overlay 自查）。"""

    def _seed(self, base):
        proj = base / "projects" / "demo"
        proj.mkdir(parents=True, exist_ok=True)
        (proj / "page.svg").write_text("<svg/>", encoding="utf-8")
        seed_run(base, "na_run", firings=[
            {"tick": 1, "node": "P", "output": {"file": "projects/demo/page.svg"}},
        ], status={"module_id": "na_run", "phase": "done", "updated_at": 1.0})
        return proj / "page.svg"

    def test_download_ok(self, base, client):
        self._seed(base)
        r = client.get("/api/runs/na_run/nodes/P/artifacts/0")
        assert r.status_code == 200
        assert r.content == b"<svg/>"
        assert "attachment" in r.headers["content-disposition"]

    def test_unknown_node_404(self, base, client):
        self._seed(base)
        r = client.get("/api/runs/na_run/nodes/NOPE/artifacts/0")
        assert r.status_code == 404

    def test_index_out_of_range_404(self, base, client):
        self._seed(base)
        r = client.get("/api/runs/na_run/nodes/P/artifacts/9")
        assert r.status_code == 404

    def test_deleted_file_410(self, base, client):
        f = self._seed(base)
        f.unlink()
        r = client.get("/api/runs/na_run/nodes/P/artifacts/0")
        assert r.status_code == 410

    def test_unknown_run_404(self, base, client):
        r = client.get("/api/runs/ghost/nodes/P/artifacts/0")
        assert r.status_code == 404
```

- [ ] **Step 2: 运行确认失败**

Run: `cd "C:\Users\xingy\Desktop\开发\SpecModule_webview" && uv run pytest tests/test_runs_api.py::TestNodeArtifactDownload -q`
Expected: FAIL —— 404 路由不存在（5 failed）。

- [ ] **Step 3: 实现**

`server/api/runs.py` 在 `run_artifact_download` 之后新增（imports 已齐：`Path`/`HTTPException`/`FileResponse`/`query`/`validate_run_id`）：

```python
@router.get("/{run_id}/nodes/{node}/artifacts/{index}")
def run_node_artifact_download(
    run_id: str, node: str, index: int, base_dir: Path = Depends(get_base_dir)
) -> FileResponse:
    """节点产物下载：query.node_artifacts 现算 overlay → node/index 命中。

    客户端只给 node+index，路径由服务端从 firings 输出自查——路径永不为
    客户端输入（与清单下载通道同一安全纪律）。中间产物与交付物统一走此
    通道；ArtifactsStrip 的清单 index 通道保持不变。
    """
    validate_run_id(run_id)
    arts = query.node_artifacts(run_id, base_dir=base_dir)
    if not arts or node not in arts:
        raise HTTPException(
            status_code=404,
            detail={"error": "节点无产物记录", "run_id": run_id, "node": node},
        )
    items = arts[node]
    if index < 0 or index >= len(items):
        raise HTTPException(
            status_code=404,
            detail={
                "error": f"产物序号越界（该节点共 {len(items)} 项）",
                "run_id": run_id, "node": node, "index": index,
            },
        )
    entry = items[index]
    p = Path(entry["path"])
    if not p.is_file():
        raise HTTPException(
            status_code=410,
            detail={"error": "产物文件已不存在", "run_id": run_id, "path": entry["path"]},
        )
    return FileResponse(p, filename=p.name, content_disposition_type="attachment")
```

- [ ] **Step 4: 运行确认通过**

Run: `cd "C:\Users\xingy\Desktop\开发\SpecModule_webview" && uv run pytest tests/test_runs_api.py -q`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add server/api/runs.py tests/test_runs_api.py
git commit -m "feat(server): 节点产物下载端点——overlay 自查路径，客户端零路径输入"
```

### Task 5: web——类型 + 共享 fmtSize + dagre 尺寸化布局

**Files:**
- Modify: `web/src/api.ts`（`GraphArtifactEntry` / `GraphPayload` / `StatusMsg`）
- Modify: `web/src/lib/utils.ts`（追加 `fmtSize`）
- Modify: `web/src/dagre.ts`（`layoutGraphSized` + `layoutGraph` 委托）
- Modify: `web/src/components/ArtifactsStrip.tsx`（本地 `fmtSize` 改用共享）

- [ ] **Step 1: api.ts 类型**

`GraphPayload` 定义处（`NodeState` 接口之后）加类型并扩展载荷：

```ts
/** 按节点产物叠加条目（库 query.node_artifacts 出口；index = 节点级下载通道引用） */
export interface GraphArtifactEntry {
  index: number;
  /** 值在节点输出内的 dot-path（file / pptx.1） */
  key: string;
  name: string;
  /** 解析后绝对路径（tooltip 用） */
  path: string;
  kind: "deliverable" | "intermediate";
  size: number;
  modified: string;
}
```

`GraphPayload` 接口加字段（`node_states` 之后）：

```ts
  /** 按节点产物叠加（存在性锚定提取）；无 → {} */
  artifacts: Record<string, GraphArtifactEntry[]>;
```

`StatusMsg` 接口加字段（`node_states?` 注释块之后，同风格注明仅 WS 携带）：

```ts
  /** 仅 WS 推送携带——按节点产物叠加整体覆盖（服务端现算，与 node_states 同拍） */
  artifacts?: Record<string, GraphArtifactEntry[]>;
```

- [ ] **Step 2: 共享 fmtSize**

`web/src/lib/utils.ts` 末尾追加：

```ts
/** 字节数 → 人类可读大小（B/KB/MB；产物条与产物卡共用） */
export function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}
```

`web/src/components/ArtifactsStrip.tsx`：删除本地 `function fmtSize(...)`（第 7-11 行），顶部 import 区加：

```ts
import { fmtSize } from "../lib/utils";
```

- [ ] **Step 3: dagre 尺寸化布局**

`web/src/dagre.ts` 整文件替换为：

```ts
// 分层布局（TB 自上而下）：宽扁节点沿短边（纵向）逐层延伸，同层节点横向
// 并排——一屏纵向容纳更多层，横向容纳更多同层节点，信息密度高于 LR。
import dagre from "@dagrejs/dagre";
import type { GraphEdge, GraphNode } from "./api";

const NODE_W = 190;
const NODE_H = 64;

/** 节点标称尺寸（= dagre 布局所用视在尺寸）；流节点必须显式携带，
 * 否则 React Flow MiniMap 按 userNode 尺寸过滤会把全部节点判为无尺寸而画空。 */
export const NODE_SIZE = { width: NODE_W, height: NODE_H };

/** 布局输入：id + 视在尺寸（状态节点与卫星产物卡尺寸不同，布局统一按尺寸计算） */
export interface LayoutNode {
  id: string;
  width: number;
  height: number;
}

export function layoutGraphSized(
  nodes: LayoutNode[],
  edges: { from: string; to: string }[],
): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 40, ranksep: 80 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: n.width, height: n.height });
  for (const e of edges) g.setEdge(e.from, e.to);
  dagre.layout(g);
  const pos = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    const p = g.node(n.id);
    if (p) pos.set(n.id, { x: p.x - n.width / 2, y: p.y - n.height / 2 });
  }
  return pos;
}

export function layoutGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
): Map<string, { x: number; y: number }> {
  return layoutGraphSized(
    nodes.map((n) => ({ id: n.id, width: NODE_W, height: NODE_H })),
    edges,
  );
}
```

- [ ] **Step 4: 构建门（允许类型暂红）**

Run: `cd "C:\Users\xingy\Desktop\开发\SpecModule_webview\web" && npm run build`
Expected: `GraphPayload.artifacts` 为新必填字段，RunView/GraphView 尚未供给——tsc 报缺字段属预期；统一过门在 Task 7 Step 2，本步不要求绿、不提交。

### Task 6: web——ArtifactNode 卫星卡 + GraphView 集成

**Files:**
- Create: `web/src/components/ArtifactNode.tsx`
- Modify: `web/src/components/GraphView.tsx`

- [ ] **Step 1: 创建 ArtifactNode.tsx**

```tsx
// 图上卫星产物卡（React Flow 节点）：文件图标 + 名称 + 大小 + 交付物徽标；
// 顶部隐藏 handle 接生产节点虚线。点击即下载（不进节点面板、不改选中态）。
// 卫星卡无占位态——仅节点真实产出（firings 有记录）后由 overlay 带上图。
import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { FileDown } from "lucide-react";
import type { GraphArtifactEntry } from "../api";
import { fmtSize } from "../lib/utils";

/** 卫星卡 id：artifact::{producer}::{index}——跨重算稳定（measured 保留前提） */
export function artifactNodeId(producer: string, index: number): string {
  return `artifact::${producer}::${index}`;
}

/** 卫星卡标称尺寸（dagre 布局与 MiniMap 用） */
export const ARTIFACT_SIZE = { width: 176, height: 34 };

export type ArtifactNodeData = {
  runId: string;
  producer: string;
  entry: GraphArtifactEntry;
};

export type ArtifactFlowNode = Node<ArtifactNodeData, "artifact">;

function ArtifactNodeInner({ data }: NodeProps<ArtifactFlowNode>) {
  const { runId, producer, entry } = data;
  const href = `/api/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(producer)}/artifacts/${entry.index}`;
  const download = () => {
    const a = document.createElement("a");
    a.href = href;
    a.download = entry.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  return (
    <div
      title={`${entry.name} · ${entry.modified}\n${entry.path}`}
      onClick={(e) => {
        e.stopPropagation();
        download();
      }}
      className="flex h-full w-full cursor-pointer items-center gap-1.5 rounded-[8px] border bg-card px-2 transition-colors hover:border-foreground/30 hover:bg-accent"
    >
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={false}
        className="opacity-0"
      />
      <FileDown className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span
        className={`min-w-0 flex-1 truncate text-[11px] ${
          entry.kind === "deliverable" ? "font-medium" : ""
        }`}
      >
        {entry.name}
      </span>
      <span className="shrink-0 text-[10px] text-muted-foreground">
        {fmtSize(entry.size)}
      </span>
      {entry.kind === "deliverable" && (
        <span className="shrink-0 rounded border border-[var(--ph-done-border)] bg-[var(--ph-done-bg)] px-1 text-[10px] leading-4 text-[var(--ph-done-text)]">
          交付物
        </span>
      )}
    </div>
  );
}

export const ArtifactNode = memo(ArtifactNodeInner);
```

- [ ] **Step 2: GraphView 集成**

`web/src/components/GraphView.tsx` 六处修改：

(a) import 区——dagre 行改为 `import { layoutGraphSized, NODE_SIZE } from "../dagre";`；DataCardNode import 之后加：

```ts
import {
  ARTIFACT_SIZE,
  ArtifactNode,
  artifactNodeId,
  type ArtifactFlowNode,
} from "./ArtifactNode";
```

(b) nodeTypes 行改为：

```ts
const nodeTypes: NodeTypes = { status: StatusNode, dataCard: DataCardNode, artifact: ArtifactNode };
```

(c) `GraphCanvas` 内、`nodes` useMemo 之前加卫星清单 memo：

```ts
  /** 卫星产物卡清单：仅保留生产者在当前图的条目（换模块后引用失配 → 与 trace 卡同一防悬空纪律） */
  const satellites = useMemo(() => {
    const artifacts = payload.artifacts ?? {};
    return Object.entries(artifacts).flatMap(([producer, entries]) =>
      payload.graph.nodes.some((n) => n.id === producer)
        ? entries.map((entry) => ({ producer, entry }))
        : [],
    );
  }, [payload]);
```

(d) `nodes` useMemo——声明类型改 `(StatusFlowNode | DataCardFlowNode | ArtifactFlowNode)[]`；布局调用替换为：

```ts
    const pos = layoutGraphSized(
      [
        ...payload.graph.nodes.map((n) => ({
          id: n.id,
          width: NODE_SIZE.width,
          height: NODE_SIZE.height,
        })),
        ...satellites.map(({ producer, entry }) => ({
          id: artifactNodeId(producer, entry.index),
          width: ARTIFACT_SIZE.width,
          height: ARTIFACT_SIZE.height,
        })),
      ],
      [
        ...payload.graph.edges,
        ...satellites.map(({ producer, entry }) => ({
          from: producer,
          to: artifactNodeId(producer, entry.index),
        })),
      ],
    );
```

节点 map 循环之后、trace 块之前插入卫星节点（measured 带回，同 status 节点纪律）：

```ts
    // 卫星产物卡：叶节点随 dagre 挂在生产者下方；measured 带回防 WS 采纳重置
    for (const { producer, entry } of satellites) {
      const id = artifactNodeId(producer, entry.index);
      const measured = getInternalNode(id)?.measured;
      list.push({
        id,
        type: "artifact",
        position: pos.get(id) ?? { x: 0, y: 0 },
        width: ARTIFACT_SIZE.width,
        height: ARTIFACT_SIZE.height,
        measured: measured ? { ...measured } : undefined,
        selectable: false,
        data: { runId: payload.run_id, producer, entry },
      });
    }
```

该 useMemo 依赖数组改为 `[payload, status, selected, trace, spec, onClearTrace, satellites]`。

(e) `edges` useMemo——控制流边 list 构建之后、trace 虚线块之前插入：

```ts
    // 生产者 → 卫星产物卡虚线（数据流视觉，中性色同默认边）
    const satStroke = "hsl(var(--foreground) / 0.28)";
    for (const { producer, entry } of satellites) {
      list.push({
        id: `ea::${producer}::${entry.index}`,
        source: producer,
        target: artifactNodeId(producer, entry.index),
        style: { stroke: satStroke, strokeWidth: 1.2, strokeDasharray: "5 3" },
        markerEnd: { type: MarkerType.ArrowClosed, color: satStroke, width: 12, height: 12 },
      });
    }
```

依赖数组加 `satellites`。

(f) `minimapColor` 开头 dataCard 分支之后加：

```ts
    if (n.type === "artifact") return "hsl(var(--primary) / 0.4)";
```

`onNodeClick` 守卫改为：

```ts
        onNodeClick={(_, n) => {
          if (n.type === "dataCard" || n.type === "artifact") return;
          onSelect(n.id);
        }}
```

### Task 7: web——RunView WS artifacts 覆盖 merge + 构建门 + 提交

**Files:**
- Modify: `web/src/components/RunView.tsx:250-275`（WS 累计覆盖 effect）

- [ ] **Step 1: WS merge**

`RunView.tsx` 的「WS 累计覆盖」effect 中，把 `const ns = stream.node_states; if (ns) { setPayload(...) }` 段替换为：

```ts
    const ns = stream.node_states;
    const arts = stream.artifacts;
    if (ns || arts) {
      setPayload(
        (prev) =>
          prev && {
            ...prev,
            ...(ns ? { node_states: { ...prev.node_states, ...ns } } : {}),
            ...(arts ? { artifacts: arts } : {}),
          },
      );
    }
```

（终态重拉 graph 的既有逻辑不动——overlay 以库侧为准。）

- [ ] **Step 2: 前端全量构建门**

Run: `cd "C:\Users\xingy\Desktop\开发\SpecModule_webview\web" && npm run build`
Expected: tsc + vite 全绿。

- [ ] **Step 3: webview 后端测试全量**

Run: `cd "C:\Users\xingy\Desktop\开发\SpecModule_webview" && uv run pytest tests/ -q`
Expected: 全绿（webview + treechat 套件）。

- [ ] **Step 4: 提交**

```bash
git add web/src/api.ts web/src/lib/utils.ts web/src/dagre.ts web/src/components/ArtifactsStrip.tsx web/src/components/ArtifactNode.tsx web/src/components/GraphView.tsx web/src/components/RunView.tsx
git commit -m "feat(web): 运行图卫星产物卡——产出即上图、点击下载、交付物徽标"
```

### Task 8: 端到端验证 + 双线同步 + 归档

**Files:**
- Modify: `roadmap/finish.md`（追加归档条目）
- 无代码改动（验证 + git 同步 + issue）

- [ ] **Step 1: 浏览器端到端验证（真实 run）**

后端/前端 dev 服务若未运行则后台启动：`uv run uvicorn server.app:app --port 8000`（项目根）与 `cd web && npm run dev`。用 browser-use 打开 `http://localhost:5173/`，进入 run `ppt_master_a37223` 页签，验证：
- P01-P04 下方各挂一张 `page_pNN.svg` 卫星卡、NotesGen 下方 `total.md`、Report 下方两张 pptx 卡（其一带「交付物」徽标）；
- 卫星卡虚线自生产节点垂下、dagre 布局无重叠、MiniMap 有独立配色；
- 点击任一卫星卡触发下载；节点卡本体点击仍开 NodePanel；
- 终态 run 打开即见全部实际产物（历史产物上图）。

任何一项不符 → 修复后重跑本步。

- [ ] **Step 2: 开后排 issue**

```bash
gh issue create -R MountLynx/SpecModule_webview -t "后排：卫星产物卡 http(s) 外链支持与内联预览" -b "运行图产物节点定稿的后排项：1) 输出中的 http(s) 链接目前不提取（存在性锚定只收本地文件）；2) 卫星卡点击=下载，SVG/图片内联预览未做。来源：docs/superpowers/specs/2026-10-02-run-graph-artifact-nodes-design.md「边界与非目标」。"
```

- [ ] **Step 3: 归档 finish.md**

`roadmap/finish.md` 适当位置（最新条目区）追加：

```markdown
## 2026-10-02 运行图产物节点（中间产物上图）

- 定稿：specs/2026-10-02-run-graph-artifact-nodes-design.md；呈现形态经问答收敛为卫星产物卡。
- 库：`query.node_artifacts`（存在性锚定提取，api.md 补录，SpecModule 独立提交）；server：graph/WS 叠加 `artifacts` + 节点产物下载端点（路径永不为客户端输入）；web：卫星卡（dagre 尺寸化布局、产出即上图、点击下载、交付物徽标）。
- 后排：http(s) 外链、卫星卡内联预览（GitHub issue）。
```

```bash
git add roadmap/finish.md
git commit -m "docs(roadmap): finish.md 归档运行图产物节点"
```

- [ ] **Step 4: 双线同步（webview）**

```bash
git checkout feat/multiuser-gateway && git merge main -m "merge: main 并入 feat/multiuser-gateway——运行图产物节点同步" && git checkout main
```

- [ ] **Step 5: 推送两线 + 库仓库**

```bash
git push origin main feat/multiuser-gateway
git -C "C:\Users\xingy\Desktop\开发\SpecModule" push
```

（若推送因凭据失败：如实报告，不重试硬闯。）

- [ ] **Step 6: uv.lock 核对**

Run: `cd "C:\Users\xingy\Desktop\开发\SpecModule_webview" && uv sync && git status --short uv.lock`
Expected: uv.lock 无变化（editable 路径依赖）；若有变化则 `git add uv.lock && git commit -m "chore: uv.lock 同步库版本"`。
