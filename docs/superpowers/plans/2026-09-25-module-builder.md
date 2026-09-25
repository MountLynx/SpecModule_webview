# 模块构建器（组件库 + 可视化创建 packed 模块）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新「构建」板块——组件库（harness/command 表单化、script/guard 代码上传、submodule 索引）+ 画布中心模块创建器，产出标准 pack → 库 `validate_pack_dir` 校验 → `install_pack` 安装进 store。

**Architecture:** 后端 `server/api/build.py` 一个 router（统一面 `/api/library/{kind}/{name}` CRUD + `/api/modules/packs[/validate]` 组装安装）；组件库锚 `store_home()/library/`；组装时被引用组件**拷贝进包**（包自包含，零上游改动）；tasklist 生成本层唯一实现 `draft_to_tasklist`（dry-run 返回生成结果供 UI 预览）。前端复用页签制壳层（DynTab kind `"build"`）、React Flow 编辑画布（独立于只读 GraphView）。

**Tech Stack:** FastAPI + pytest/httpx TestClient（后端）；Vite + React 18 + TS + Tailwind + @xyflow/react 12 + @dagrejs/dagre（前端，无单测设施，验收门禁 = `npm run build`）。

**Spec:** `docs/superpowers/specs/2026-09-25-module-builder-design.md`（拷贝进包语义、错误契约、范围外清单以 spec 为准）

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `server/api/build.py` | **新**：组件库/草稿统一 CRUD + `draft_to_tasklist` + `_assemble_pack` + validate/install 端点 |
| `server/app.py` | 注册 `build.router` |
| `tests/test_build_api.py` | **新**：构建面全部端点测试（conftest `base` fixture 已隔离 `SPECMODULE_HOME`） |
| `web/src/api.ts` | 追加构建器类型与端点封装 |
| `web/src/components/ActivityBar.tsx` / `TabBar.tsx` | 加 `"build"` 页签 |
| `web/src/App.tsx` | DynTab `"build"` 分支 + 侧栏/主区接线 |
| `web/src/components/LibraryPanel.tsx` | **新**：侧栏组件库面板 |
| `web/src/components/library/ComponentForms.tsx` | **新**：harness/command 表单对话框 |
| `web/src/components/builder/ModuleBuilder.tsx` | **新**：创建器主区（工具条/自动保存/校验安装/DSL 预览） |
| `web/src/components/builder/EditableCanvas.tsx` | **新**：React Flow 编辑画布 + BuilderNodeView |
| `web/src/components/builder/NodePanel.tsx` | **新**：节点/边配置面板 |
| `web/src/components/builder/layout.ts` | **新**：dagre 自动布局（id 基） |

**关键库契约**（已核实，`../SpecModule`）：
- `store.store_home()`：`SPECMODULE_HOME` 可覆盖，惰性 mkdir。
- `store.validate_pack_dir(path) -> dict`：module.json 语义 + `ModuleLoader().load(lazy_client=True)` 引用完整性；失败抛 `ValueError`。
- `store.install_pack(src, *, source, name=None) -> Path`：先校验后落盘；同名抛 `ValueError`（"已存在…先 uninstall"）。
- `store.resolve_module(name, search) -> ModuleSource | None`；`ModuleSource.kind ∈ entry|packed|pip`。
- `HarnessConfig`（`module_harness.core.config`）必填 `prompt_core`，JSON 需带 `name`；`CommandConfig`（`module_harness.cli.command`）必填 `command`，JSON 需带 `name`。
- loader 语义：`harnesses/*.json`、`commands/*.json` 按 JSON `name` 注册；`scripts/*.py`、`guards/*.py` 文件 stem 必须等于文件内定义的函数名。
- `cli.scaffold.validate_module_name(name) -> bool`：`^[A-Za-z_][A-Za-z0-9_]*$`。

---

### Task 1: 后端骨架——library_root + GET /api/library + 路由注册

**Files:**
- Create: `server/api/build.py`
- Modify: `server/app.py`
- Test: `tests/test_build_api.py`

- [ ] **Step 1: 写失败测试**

创建 `tests/test_build_api.py`：

```python
# tests/test_build_api.py
"""构建面端点：组件库 / 草稿 / 组装安装（SPECMODULE_HOME 隔离，绝不触碰真实 store）。"""

from __future__ import annotations

import json
from pathlib import Path

HARNESS = {"name": "summarize", "prompt_core": "总结：{text}", "temperature": 0.3}


def seed_library(home: Path) -> None:
    """直接在隔离 store home 下种组件库文件。"""
    root = home / "home" / "library"
    (root / "harnesses").mkdir(parents=True, exist_ok=True)
    (root / "harnesses" / "summarize.json").write_text(
        json.dumps(HARNESS, ensure_ascii=False), encoding="utf-8")
    (root / "scripts").mkdir(parents=True, exist_ok=True)
    (root / "scripts" / "echo.py").write_text(
        "def echo(view):\n    return {'message': view.field('data')}\n", encoding="utf-8")


class TestLibraryIndex:
    def test_empty_index(self, client, base):
        r = client.get("/api/library")
        assert r.status_code == 200
        assert r.json() == {
            "harnesses": [], "commands": [], "scripts": [], "guards": [],
            "submodules": [], "drafts": [],
        }

    def test_grouped_listing(self, client, base):
        seed_library(base)
        d = client.get("/api/library").json()
        assert d["harnesses"] == ["summarize"]
        assert d["scripts"] == ["echo"]
        assert d["commands"] == [] and d["guards"] == []
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/test_build_api.py -q`
Expected: FAIL——`/api/library` 返回 404（路由不存在）

- [ ] **Step 3: 最小实现**

创建 `server/api/build.py`：

```python
# server/api/build.py
"""构建面端点：组件库/草稿统一 CRUD + pack 组装安装（模块构建器后端）。

组件库锚 store_home()/library/（与 modules/、manifests/ 同根，SPECMODULE_HOME
可覆盖）；harness/command 校验走库 from_dict 实例化，script/guard 只收标识符
命名的 UTF-8 .py 文本（stem=注册名，loader 语义）；组装只调 validate_pack_dir/
install_pack——本层零校验逻辑；tasklist 生成本层唯一实现（draft_to_tasklist）。
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request

from module_harness import store
from module_harness.cli.scaffold import validate_module_name

router = APIRouter(prefix="/api")

_KINDS = ("harnesses", "commands", "scripts", "guards")
_EXT = {"harnesses": ".json", "commands": ".json", "scripts": ".py", "guards": ".py"}


def library_root() -> Path:
    """组件库根：store_home()/library（惰性建目录）。"""
    d = store.store_home() / "library"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _check_name(name: str) -> str:
    if not validate_module_name(name):
        raise HTTPException(
            status_code=400, detail={"error": f"非法名称: {name!r}（须为 Python 标识符）"})
    return name


def _kind_listing(root: Path, kind: str) -> list[str]:
    d = root / kind
    return sorted(p.stem for p in d.glob(f"*{_EXT[kind]}")) if d.is_dir() else []


def _read_submodule_index() -> list[dict]:
    p = library_root() / "submodules.json"
    if not p.is_file():
        return []
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except ValueError:
        return []
    return data if isinstance(data, list) else []


def _list_drafts() -> list[str]:
    d = library_root() / "drafts"
    return sorted(p.stem for p in d.glob("*.json")) if d.is_dir() else []


@router.get("/library")
def library_index() -> dict:
    """组件库分组清单（名字列表 + submodule 索引 + 草稿名）。"""
    root = library_root()
    return {
        "harnesses": _kind_listing(root, "harnesses"),
        "commands": _kind_listing(root, "commands"),
        "scripts": _kind_listing(root, "scripts"),
        "guards": _kind_listing(root, "guards"),
        "submodules": _read_submodule_index(),
        "drafts": _list_drafts(),
    }
```

`server/app.py` 两处改动——import 区加：

```python
from server.api import build
```

路由注册区（`app.include_router(manage.router)` 之后）加：

```python
app.include_router(build.router)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/test_build_api.py -q`
Expected: PASS（2 passed）

- [ ] **Step 5: 提交**

```bash
git add server/api/build.py server/app.py tests/test_build_api.py
git commit -m "feat(server): 构建面骨架——组件库根锚 store_home/library + 分组清单端点"
```

---

### Task 2: 统一 CRUD——harness/command 保存·详情·删除

**Files:**
- Modify: `server/api/build.py`
- Test: `tests/test_build_api.py`

- [ ] **Step 1: 写失败测试**

`tests/test_build_api.py` 追加：

```python
COMMAND = {"name": "run_ls", "command": "ls", "timeout": 30.0}


class TestConfigComponents:
    def test_save_and_index_and_detail(self, client, base):
        r = client.put("/api/library/harnesses/summarize", json=HARNESS)
        assert r.status_code == 200 and r.json()["saved"] is True
        r = client.put("/api/library/commands/run_ls", json=COMMAND)
        assert r.status_code == 200
        d = client.get("/api/library").json()
        assert d["harnesses"] == ["summarize"] and d["commands"] == ["run_ls"]
        # 详情 = 存储 JSON 原样（前端表单回填数据源）
        assert client.get("/api/library/harnesses/summarize").json()["prompt_core"] == "总结：{text}"

    def test_save_invalid_config_400(self, client, base):
        # harness 缺必填 prompt_core；command 缺必填 command
        r = client.put("/api/library/harnesses/bad", json={"name": "bad"})
        assert r.status_code == 400 and "无效" in r.json()["error"]
        r = client.put("/api/library/commands/bad", json={"name": "bad"})
        assert r.status_code == 400

    def test_save_name_mismatch_400(self, client, base):
        r = client.put("/api/library/harnesses/other", json=HARNESS)
        assert r.status_code == 400 and "不一致" in r.json()["error"]

    def test_save_bad_name_400(self, client, base):
        r = client.put("/api/library/harnesses/9bad", json={**HARNESS, "name": "9bad"})
        assert r.status_code == 400

    def test_update_overwrites(self, client, base):
        client.put("/api/library/harnesses/summarize", json=HARNESS)
        client.put("/api/library/harnesses/summarize",
                   json={**HARNESS, "temperature": 0.9})
        assert client.get("/api/library/harnesses/summarize").json()["temperature"] == 0.9

    def test_delete_and_404(self, client, base):
        client.put("/api/library/harnesses/summarize", json=HARNESS)
        assert client.delete("/api/library/harnesses/summarize").json()["deleted"] is True
        assert client.delete("/api/library/harnesses/summarize").status_code == 404
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/test_build_api.py -q`
Expected: 新增 6 例 FAIL（404/405——PUT/DELETE 路由不存在）

- [ ] **Step 3: 实现**

`server/api/build.py` import 区追加：

```python
from module_harness.cli.command import CommandConfig
from module_harness.core.config import HarnessConfig
```

模块级常量与文件末尾追加：

```python
_CFG_CLS = {"harnesses": HarnessConfig, "commands": CommandConfig}


@router.get("/library/{kind}/{name}")
def library_item(kind: str, name: str) -> dict:
    """单组件详情：harness/command = 存储 JSON；scripts/guards = {name, code}。"""
    _check_name(name)
    if kind in _CFG_CLS:
        p = library_root() / kind / f"{name}.json"
        if not p.is_file():
            raise HTTPException(status_code=404, detail={"error": f"{kind}/{name} 不存在"})
        return json.loads(p.read_text(encoding="utf-8"))
    if kind in ("scripts", "guards"):
        p = library_root() / kind / f"{name}.py"
        if not p.is_file():
            raise HTTPException(status_code=404, detail={"error": f"{kind}/{name} 不存在"})
        return {"name": name, "code": p.read_text(encoding="utf-8")}
    raise HTTPException(status_code=404, detail={"error": f"未知组件类别: {kind}"})


def _save_config(kind: str, name: str, raw: bytes) -> dict:
    """harness/command 保存：库 from_dict 实例化验形（消费库而非自写校验）。"""
    cls = _CFG_CLS[kind]
    try:
        data = json.loads(raw.decode("utf-8"))
        cls.from_dict(data)
    except (ValueError, TypeError, UnicodeDecodeError) as e:
        raise HTTPException(status_code=400, detail={"error": f"{kind} 配置无效: {e}"})
    if not isinstance(data, dict) or data.get("name") != name:
        raise HTTPException(
            status_code=400,
            detail={"error": f"name 字段({data.get('name') if isinstance(data, dict) else None})与路径({name})不一致"})
    p = library_root() / kind / f"{name}.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"saved": True, "kind": kind, "name": name}


@router.put("/library/{kind}/{name}")
async def save_library_item(kind: str, name: str, request: Request) -> dict:
    """保存（PUT = create-or-update）：JSON 配置 / 代码文本 / 草稿 / submodule 登记。"""
    _check_name(name)
    if kind in _CFG_CLS:
        return _save_config(kind, name, await request.body())
    raise HTTPException(status_code=404, detail={"error": f"未知组件类别: {kind}"})


@router.delete("/library/{kind}/{name}")
def delete_library_item(kind: str, name: str) -> dict:
    _check_name(name)
    if kind in _KINDS:
        p = library_root() / kind / f"{name}{_EXT[kind]}"
        if not p.is_file():
            raise HTTPException(status_code=404, detail={"error": f"{kind}/{name} 不存在"})
        p.unlink()
        return {"deleted": True, "kind": kind, "name": name}
    raise HTTPException(status_code=404, detail={"error": f"未知组件类别: {kind}"})
```

注意：`json.loads` 对非 dict 结果（如数组）不抛错，`cls.from_dict` 会抛 TypeError 被 400 捕获；`data.get("name")` 前置 isinstance 防御。

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/test_build_api.py -q`
Expected: PASS（8 passed）

- [ ] **Step 5: 提交**

```bash
git add server/api/build.py tests/test_build_api.py
git commit -m "feat(server): harness/command 组件保存·详情·删除（库 from_dict 实例化验形）"
```

---

### Task 3: scripts/guards 代码上传·详情·删除

**Files:**
- Modify: `server/api/build.py`
- Test: `tests/test_build_api.py`

- [ ] **Step 1: 写失败测试**

`tests/test_build_api.py` 追加：

```python
SCRIPT = "def echo(view):\n    return {'message': view.field('data')}\n"
GUARD = "def has_issues(view):\n    return True\n"


class TestCodeComponents:
    def test_save_and_detail(self, client, base):
        r = client.put("/api/library/scripts/echo", content=SCRIPT.encode("utf-8"))
        assert r.status_code == 200 and r.json()["saved"] is True
        r = client.put("/api/library/guards/has_issues", content=GUARD.encode("utf-8"))
        assert r.status_code == 200
        d = client.get("/api/library/scripts/echo").json()
        assert d == {"name": "echo", "code": SCRIPT}
        assert client.get("/api/library").json()["guards"] == ["has_issues"]

    def test_save_bad_name_400(self, client, base):
        r = client.put("/api/library/scripts/bad-name", content=b"x")
        assert r.status_code == 400

    def test_save_non_utf8_400(self, client, base):
        r = client.put("/api/library/scripts/echo", content=b"\xff\xfe\x00")
        assert r.status_code == 400

    def test_delete_and_404(self, client, base):
        client.put("/api/library/scripts/echo", content=SCRIPT.encode("utf-8"))
        assert client.delete("/api/library/scripts/echo").json()["deleted"] is True
        assert client.delete("/api/library/scripts/echo").status_code == 404
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/test_build_api.py -q`
Expected: 新增 4 例 FAIL（save 404——save_library_item 未分支 scripts/guards）

- [ ] **Step 3: 实现**

`server/api/build.py` 追加：

```python
def _save_code(kind: str, name: str, raw: bytes) -> dict:
    """scripts/guards 上传：UTF-8 .py 文本，stem = 注册函数名（loader 语义）。"""
    try:
        code = raw.decode("utf-8")
    except UnicodeDecodeError as e:
        raise HTTPException(status_code=400, detail={"error": f"脚本须为 UTF-8 文本: {e}"})
    p = library_root() / kind / f"{name}.py"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(code, encoding="utf-8")
    return {"saved": True, "kind": kind, "name": name}
```

`save_library_item` 的 `if kind in _CFG_CLS` 分支后追加：

```python
    if kind in ("scripts", "guards"):
        return _save_code(kind, name, await request.body())
```

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/test_build_api.py -q`
Expected: PASS（12 passed）

- [ ] **Step 5: 提交**

```bash
git add server/api/build.py tests/test_build_api.py
git commit -m "feat(server): scripts/guards 代码上传·详情·删除（UTF-8 .py，stem=注册名）"
```

---

### Task 4: submodule 索引（登记已安装 packed 模块）

**Files:**
- Modify: `server/api/build.py`
- Test: `tests/test_build_api.py`

- [ ] **Step 1: 写失败测试**

`tests/test_build_api.py` 追加。`seed_library` 后面加一个 packed 夹具函数：

```python
def seed_pack_module(home: Path, name: str = "sub_greet") -> Path:
    """隔离 store modules/ 下种最小 packed 模块（submodule 拷贝源夹具）。"""
    p = home / "home" / "modules" / name
    (p / "scripts").mkdir(parents=True)
    (p / "module.json").write_text(json.dumps({
        "name": name, "description": "子模块夹具", "submodule": True,
        "spec_schema": {"input": {}, "output": {}},
        "requires": [], "modules": [],
        "tasklist": {"Tasks": {"Greet": {"type": "script", "script": "greet"}},
                     "Flow": "[Greet]"},
    }, ensure_ascii=False), encoding="utf-8")
    (p / "scripts" / "greet.py").write_text(
        "def greet(view):\n    return {'hi': 1}\n", encoding="utf-8")
    return p


class TestSubmoduleIndex:
    def test_add_list_remove(self, client, base):
        seed_pack_module(base)
        r = client.put("/api/library/submodules/sub_greet")
        assert r.status_code == 200
        d = client.get("/api/library").json()
        assert d["submodules"] == [{"name": "sub_greet", "added_at": d["submodules"][0]["added_at"]}]
        # 重复登记幂等
        client.put("/api/library/submodules/sub_greet")
        assert len(client.get("/api/library").json()["submodules"]) == 1
        assert client.delete("/api/library/submodules/sub_greet").json()["deleted"] is True
        assert client.get("/api/library").json()["submodules"] == []

    def test_add_unknown_module_404(self, client, base):
        assert client.put("/api/library/submodules/nope").status_code == 404

    def test_add_entry_module_400(self, client, base):
        """entry 形态模块不能作 submodule（tests/modules 夹具 mini_graph 是 entry）。"""
        r = client.put("/api/library/submodules/mini_graph")
        assert r.status_code == 400 and "packed" in r.json()["error"]

    def test_detail_of_indexed(self, client, base):
        seed_pack_module(base)
        client.put("/api/library/submodules/sub_greet")
        d = client.get("/api/library/submodules/sub_greet").json()
        assert d["name"] == "sub_greet"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/test_build_api.py -q`
Expected: 新增 4 例 FAIL

- [ ] **Step 3: 实现**

`server/api/build.py` 追加（submodule 的 GET/PUT/DELETE 分支并进统一路由）：

```python
def _now() -> str:
    from datetime import datetime
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _write_submodule_index(entries: list[dict]) -> None:
    p = library_root() / "submodules.json"
    p.write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")


def _add_submodule(name: str, search: list[Path]) -> dict:
    """登记已安装 packed 模块为可引用 submodule（索引记名，组装时才拷包）。"""
    found = False
    for sources in store.list_modules(search=search).values():
        for s in sources:
            if s.name == name:
                found = True
                if s.kind not in ("packed", "pip"):
                    raise HTTPException(status_code=400, detail={
                        "error": f"模块 '{name}' 为 {s.kind} 形态，仅 packed 可作 submodule"})
                break
        if found:
            break
    if not found:
        raise HTTPException(status_code=404, detail={"error": f"模块 '{name}' 未找到"})
    entries = _read_submodule_index()
    if not any(e.get("name") == name for e in entries):
        entries.append({"name": name, "added_at": _now()})
        entries.sort(key=lambda e: e["name"])
        _write_submodule_index(entries)
    return {"saved": True, "kind": "submodules", "name": name}
```

- `save_library_item`：函数签名加 `search: list[Path] = Depends(get_search_paths)`（import 区 `from server.deps import get_search_paths`），末尾分支前加：

```python
    if kind == "submodules":
        return _add_submodule(name, search)
```

- `library_item`：`raise` 前加：

```python
    if kind == "submodules":
        for e in _read_submodule_index():
            if e.get("name") == name:
                return e
        raise HTTPException(status_code=404, detail={"error": f"submodule '{name}' 未登记"})
```

- `delete_library_item`：`raise` 前加：

```python
    if kind == "submodules":
        _write_submodule_index([e for e in _read_submodule_index() if e.get("name") != name])
        return {"deleted": True, "kind": "submodules", "name": name}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/test_build_api.py -q`
Expected: PASS（16 passed）

- [ ] **Step 5: 提交**

```bash
git add server/api/build.py tests/test_build_api.py
git commit -m "feat(server): submodule 索引——登记已安装 packed 模块（组装时拷包）"
```

---

### Task 5: 草稿 CRUD

**Files:**
- Modify: `server/api/build.py`
- Test: `tests/test_build_api.py`

- [ ] **Step 1: 写失败测试**

`tests/test_build_api.py` 追加：

```python
def draft_json(name: str = "my_mod", **over) -> dict:
    return {
        "meta": {"name": name, "version": "0.1.0", "description": "测试草稿"},
        "spec_schema": [{"field": "raw_text", "type": "str"}],
        "default_spec": {},
        "nodes": [
            {"id": "n1", "label": "Echo", "type": "script", "script": "echo",
             "is_start": True, "join": "AND", "position": {"x": 0, "y": 0}, "inputs": {}},
        ],
        "edges": [],
        **over,
    }


class TestDrafts:
    def test_save_load_index_delete(self, client, base):
        r = client.put("/api/library/drafts/my_mod", json=draft_json())
        assert r.status_code == 200
        assert client.get("/api/library").json()["drafts"] == ["my_mod"]
        d = client.get("/api/library/drafts/my_mod").json()
        assert d["meta"]["name"] == "my_mod" and "updated_at" in d
        assert client.delete("/api/library/drafts/my_mod").json()["deleted"] is True
        assert client.get("/api/library/drafts/my_mod").status_code == 404

    def test_name_mismatch_400(self, client, base):
        r = client.put("/api/library/drafts/other", json=draft_json("my_mod"))
        assert r.status_code == 400 and "不一致" in r.json()["error"]

    def test_structural_validation(self, client, base):
        # 节点名非标识符
        bad = draft_json()
        bad["nodes"][0]["label"] = "bad label"
        assert client.put("/api/library/drafts/my_mod", json=bad).status_code == 400
        # 节点名重复
        dup = draft_json()
        dup["nodes"].append(dict(dup["nodes"][0], id="n2"))
        assert client.put("/api/library/drafts/my_mod", json=dup).status_code == 400
        # 节点缺类型引用
        noref = draft_json()
        del noref["nodes"][0]["script"]
        assert client.put("/api/library/drafts/my_mod", json=noref).status_code == 400
        # 边引用不存在节点 id
        badedge = draft_json()
        badedge["edges"] = [{"id": "e1", "from": "ghost", "to": "n1", "guard": None}]
        assert client.put("/api/library/drafts/my_mod", json=badedge).status_code == 400
        # spec_schema 类型非法
        badschema = draft_json()
        badschema["spec_schema"] = [{"field": "x", "type": "long"}]
        assert client.put("/api/library/drafts/my_mod", json=badschema).status_code == 400
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/test_build_api.py -q`
Expected: 新增 2 例 FAIL（drafts 分支缺失 → 404）

- [ ] **Step 3: 实现**

`server/api/build.py` 追加：

```python
_NODE_TYPES = ("harness", "script", "command", "submodule")
_REF_FIELD = {"harness": "harness", "script": "script",
              "command": "command", "submodule": "submodule"}
_SCHEMA_TYPES = ("str", "int", "float", "bool", "list", "dict", "any")


def _draft_err(msg: str):
    return HTTPException(status_code=400, detail={"error": msg})


def _validate_draft(draft, name: str) -> dict:
    """草稿结构校验（轻量：形状与命名纪律；引用完整性留给组装期 validate_pack_dir）。"""
    if not isinstance(draft, dict):
        raise _draft_err("草稿须为 JSON 对象")
    meta = draft.get("meta")
    if not isinstance(meta, dict) or not meta.get("name"):
        raise _draft_err("草稿缺 meta.name")
    if meta["name"] != name:
        raise _draft_err(f"meta.name({meta['name']})与路径({name})不一致")
    nodes = draft.get("nodes")
    if not isinstance(nodes, list):
        raise _draft_err("nodes 须为数组")
    labels: list[str] = []
    for n in nodes:
        if not isinstance(n, dict) or not n.get("id") or not n.get("label"):
            raise _draft_err("节点缺 id/label")
        if not validate_module_name(n["label"]):
            raise _draft_err(f"节点名须为标识符: {n['label']!r}")
        if n.get("type") not in _NODE_TYPES:
            raise _draft_err(f"节点类型非法: {n.get('type')!r}")
        if not n.get(_REF_FIELD[n["type"]]):
            raise _draft_err(f"节点 {n['label']} 缺引用（{n['type']}）")
        labels.append(n["label"])
    dupes = sorted({x for x in labels if labels.count(x) > 1})
    if dupes:
        raise _draft_err(f"节点名重复: {dupes}")
    edges = draft.get("edges")
    if not isinstance(edges, list):
        raise _draft_err("edges 须为数组")
    node_ids = {n["id"] for n in nodes}
    for e in edges:
        if not isinstance(e, dict) or e.get("from") not in node_ids or e.get("to") not in node_ids:
            raise _draft_err("边引用了不存在的节点 id")
    schema = draft.get("spec_schema", [])
    if not isinstance(schema, list) or any(
        not isinstance(f, dict) or not validate_module_name(f.get("field", ""))
        or f.get("type") not in _SCHEMA_TYPES
        for f in schema
    ):
        raise _draft_err(f"spec_schema 须为 [{{field,type}}]，type ∈ {'/'.join(_SCHEMA_TYPES)}")
    return draft


def _save_draft(name: str, raw: bytes) -> dict:
    try:
        draft = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as e:
        raise _draft_err(f"草稿 JSON 无效: {e}")
    draft = _validate_draft(draft, name)
    draft["updated_at"] = _now()
    p = library_root() / "drafts" / f"{name}.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(draft, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"saved": True, "kind": "drafts", "name": name}


def get_draft(name: str) -> dict:
    _check_name(name)
    p = library_root() / "drafts" / f"{name}.json"
    if not p.is_file():
        raise HTTPException(status_code=404, detail={"error": f"草稿 '{name}' 不存在"})
    return json.loads(p.read_text(encoding="utf-8"))


def _delete_draft(name: str) -> dict:
    _check_name(name)
    p = library_root() / "drafts" / f"{name}.json"
    if not p.is_file():
        raise HTTPException(status_code=404, detail={"error": f"草稿 '{name}' 不存在"})
    p.unlink()
    return {"deleted": True, "kind": "drafts", "name": name}
```

三个统一路由各加 drafts 分支：
- `library_item`：submodules 分支前加 `if kind == "drafts": return get_draft(name)`
- `save_library_item`：scripts/guards 分支后加 `if kind == "drafts": return _save_draft(name, await request.body())`
- `delete_library_item`：submodules 分支前加 `if kind == "drafts": return _delete_draft(name)`

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/test_build_api.py -q`
Expected: PASS（18 passed）

- [ ] **Step 5: 提交**

```bash
git add server/api/build.py tests/test_build_api.py
git commit -m "feat(server): 模块草稿 CRUD（结构轻校验，引用完整性留给组装期）"
```

---

### Task 6: draft_to_tasklist 纯函数

**Files:**
- Modify: `server/api/build.py`
- Test: `tests/test_build_api.py`

- [ ] **Step 1: 写失败测试**

`tests/test_build_api.py` 追加（纯函数直测，不经 HTTP）：

```python
from server.api.build import draft_to_tasklist


class TestDraftToTasklist:
    def test_flow_dsl_generation(self):
        draft = {
            "meta": {"name": "m", "version": "0.1.0", "description": ""},
            "spec_schema": [], "default_spec": {},
            "nodes": [
                {"id": "a", "label": "Summarize", "type": "harness", "harness": "summarize",
                 "is_start": True, "join": "AND", "position": {"x": 0, "y": 0},
                 "inputs": {"text": "{spec.raw_text}"}, "overrides": {"temperature": 0.3}},
                {"id": "b", "label": "Echo", "type": "script", "script": "echo",
                 "is_start": False, "join": "OR", "position": {"x": 0, "y": 0},
                 "inputs": {"data": "Summarize"}},
            ],
            "edges": [{"id": "e1", "from": "a", "to": "b", "guard": "has_issues"}],
        }
        tl = draft_to_tasklist(draft)
        assert tl["Tasks"] == {
            "Summarize": {"type": "harness", "harness": "summarize", "temperature": 0.3,
                          "inputs": {"text": "{spec.raw_text}"}},
            "Echo": {"type": "script", "script": "echo", "inputs": {"data": "Summarize"}},
        }
        assert tl["Flow"] == "[Summarize] --|has_issues|--> Echo\nEcho.join: OR"

    def test_submodule_outputs_and_join_default(self):
        draft = {
            "meta": {"name": "m", "version": "0.1.0", "description": ""},
            "spec_schema": [], "default_spec": {},
            "nodes": [
                {"id": "s", "label": "Sub", "type": "submodule", "submodule": "sub_greet",
                 "is_start": True, "join": "AND", "position": {"x": 0, "y": 0},
                 "inputs": {}, "outputs": {"msg": "hi"}},
            ],
            "edges": [],
        }
        tl = draft_to_tasklist(draft)
        assert tl["Tasks"]["Sub"] == {"type": "submodule", "submodule": "sub_greet",
                                      "outputs": {"msg": "hi"}}
        assert tl["Flow"] == ""
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/test_build_api.py -q`
Expected: ImportError——`draft_to_tasklist` 不存在

- [ ] **Step 3: 实现**

`server/api/build.py` 追加：

```python
def draft_to_tasklist(draft: dict) -> dict:
    """草稿 → tasklist dict（{Tasks, Flow}）——组装与 validate 共用的唯一实现。

    edges 的 from/to 是节点 id；起点标记 `[名]` 只在该起点节点首条出边出现一次
    （tickflow 允许多起点，各起点各自的边各自带标记）；join 覆盖（非 AND）追加
    `<名>.join: OR` 行。生成正确性最终由 validate_pack_dir 把关。
    """
    nodes = draft["nodes"]
    label_of = {n["id"]: n["label"] for n in nodes}
    starts = {n["id"] for n in nodes if n.get("is_start")}
    tasks: dict[str, dict] = {}
    for n in nodes:
        field = _REF_FIELD[n["type"]]
        d: dict = {"type": n["type"], field: n[field]}
        if n["type"] == "submodule":
            if n.get("outputs"):
                d["outputs"] = dict(n["outputs"])
        else:
            d.update(n.get("overrides") or {})
        if n.get("inputs"):
            d["inputs"] = dict(n["inputs"])
        tasks[n["label"]] = d
    lines: list[str] = []
    marked: set[str] = set()
    for e in draft["edges"]:
        src = label_of[e["from"]]
        if e["from"] in starts and e["from"] not in marked:
            src = f"[{src}]"
            marked.add(e["from"])
        arrow = f"--|{e['guard']}|-->" if e.get("guard") else "-->"
        lines.append(f"{src} {arrow} {label_of[e['to']]}")
    for n in nodes:
        if n.get("join", "AND") == "OR":
            lines.append(f"{n['label']}.join: OR")
    return {"Tasks": tasks, "Flow": "\n".join(lines)}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/test_build_api.py -q`
Expected: PASS（20 passed）

- [ ] **Step 5: 提交**

```bash
git add server/api/build.py tests/test_build_api.py
git commit -m "feat(server): draft_to_tasklist——DSL 生成唯一实现（组装/预览共用）"
```

---

### Task 7: 组装 + validate 端点

**Files:**
- Modify: `server/api/build.py`
- Test: `tests/test_build_api.py`

- [ ] **Step 1: 写失败测试**

`tests/test_build_api.py` 追加。模块级准备函数（经 API 保存组件与草稿的完整夹具）：

```python
SCRIPT_REF = "def echo(view):\n    return {'message': view.field('data')}\n"
GUARD_REF = "def has_issues(view):\n    return True\n"


def seed_builder(client):
    """经 API 保存 harness/script/guard + 循环草稿（harness→script，guard 回边）。"""
    assert client.put("/api/library/harnesses/summarize", json=HARNESS).status_code == 200
    assert client.put("/api/library/scripts/echo", content=SCRIPT_REF.encode()).status_code == 200
    assert client.put("/api/library/guards/has_issues", content=GUARD_REF.encode()).status_code == 200
    draft = {
        "meta": {"name": "loop_mod", "version": "0.2.0", "description": "循环测试"},
        "spec_schema": [{"field": "raw_text", "type": "str"}],
        "default_spec": {"raw_text": "demo"},
        "nodes": [
            {"id": "a", "label": "Summarize", "type": "harness", "harness": "summarize",
             "is_start": True, "join": "AND", "position": {"x": 0, "y": 0},
             "inputs": {"text": "{spec.raw_text}"}},
            {"id": "b", "label": "Echo", "type": "script", "script": "echo",
             "is_start": False, "join": "OR", "position": {"x": 0, "y": 0},
             "inputs": {"data": "Summarize"}},
        ],
        "edges": [
            {"id": "e1", "from": "a", "to": "b", "guard": None},
            {"id": "e2", "from": "b", "to": "a", "guard": "has_issues"},
        ],
    }
    assert client.put("/api/library/drafts/loop_mod", json=draft).status_code == 200
    return draft


class TestValidatePack:
    def test_validate_ok_returns_tasklist(self, client, base):
        seed_builder(client)
        r = client.post("/api/modules/packs/validate", json={"draft": "loop_mod"})
        assert r.status_code == 200
        d = r.json()
        assert d["ok"] is True
        assert d["manifest"]["name"] == "loop_mod"
        assert d["tasklist"]["Flow"] == "[Summarize] --> Echo\nSummarize --|has_issues|--> Echo\nEcho.join: OR"
        # dry-run 不落 store
        assert "loop_mod" not in [m["name"] for m in client.get("/api/modules").json()["modules"]]

    def test_validate_missing_component_400(self, client, base):
        draft = {
            "meta": {"name": "broken", "version": "0.1.0", "description": ""},
            "spec_schema": [], "default_spec": {},
            "nodes": [{"id": "n1", "label": "E", "type": "script", "script": "ghost",
                       "is_start": True, "join": "AND", "position": {"x": 0, "y": 0}, "inputs": {}}],
            "edges": [],
        }
        client.put("/api/library/drafts/broken", json=draft)
        r = client.post("/api/modules/packs/validate", json={"draft": "broken"})
        assert r.status_code == 400 and "ghost" in r.json()["error"]

    def test_validate_400_loader_semantics(self, client, base):
        """库校验兜底：script 文件内函数名与 stem 不符 → ModuleLoader 拒绝。"""
        client.put("/api/library/scripts/wrongname", content=b"def other(view):\n    return {}\n")
        draft = {
            "meta": {"name": "wrongfn", "version": "0.1.0", "description": ""},
            "spec_schema": [], "default_spec": {},
            "nodes": [{"id": "n1", "label": "E", "type": "script", "script": "wrongname",
                       "is_start": True, "join": "AND", "position": {"x": 0, "y": 0}, "inputs": {}}],
            "edges": [],
        }
        client.put("/api/library/drafts/wrongfn", json=draft)
        r = client.post("/api/modules/packs/validate", json={"draft": "wrongfn"})
        assert r.status_code == 400

    def test_validate_unknown_draft_404(self, client, base):
        r = client.post("/api/modules/packs/validate", json={"draft": "ghost_draft"})
        assert r.status_code == 404
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/test_build_api.py -q`
Expected: 新增 4 例 FAIL（404——端点不存在）

- [ ] **Step 3: 实现**

`server/api/build.py` import 区追加 `import shutil`、`import tempfile`、`from fastapi import ... Response`（不需要 Response，略）。追加：

```python
def _load_draft_for_assembly(body: dict) -> dict:
    name = (body or {}).get("draft")
    if not name:
        raise HTTPException(status_code=400, detail={"error": "缺 draft 名"})
    return get_draft(name)


def _find_packed_source(name: str, search: list[Path]) -> Path:
    """已安装 packed 模块的包目录（submodule 整包拷贝源）。缺失抛 ValueError。"""
    for sources in store.list_modules(search=search).values():
        for s in sources:
            if s.name == name:
                if s.kind in ("packed", "pip"):
                    return Path(s.path)
                raise ValueError(f"submodule 源 '{name}' 非 packed 形态: {s.kind}")
    raise ValueError(f"submodule 源包未找到（可能已卸载）: {name}")


def _assemble_pack(draft: dict, search: list[Path]) -> Path:
    """草稿 → 临时 pack 目录（不落 store；调用方负责 rmtree）。失败抛 ValueError。

    只拷被引用组件（包自包含——拷贝进包语义）；submodule 整包 copytree 进
    submodules/<键>/，manifest modules 列表与目录双向一致。
    """
    meta = draft["meta"]
    pack = Path(tempfile.mkdtemp(prefix="specmodule_build_"))
    root = library_root()
    schema = {f["field"]: f["type"] for f in draft.get("spec_schema", [])}
    sub_names = sorted({n["submodule"] for n in draft["nodes"] if n["type"] == "submodule"})
    manifest = {
        "name": meta["name"],
        "version": meta.get("version", "0.1.0"),
        "description": meta.get("description", ""),
        "submodule": False,
        "spec_schema": {"input": schema},
        "requires": [],
        "modules": sub_names,
        "tasklist": draft_to_tasklist(draft),
    }
    (pack / "module.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    def copy_kind(kind: str, names: set, ext: str) -> None:
        for nm in sorted(names):
            src = root / kind / f"{nm}{ext}"
            if not src.is_file():
                raise ValueError(f"库组件缺失: {kind}/{nm}")
            dst = pack / kind
            dst.mkdir(exist_ok=True)
            shutil.copy2(src, dst / src.name)

    copy_kind("harnesses", {n["harness"] for n in draft["nodes"] if n["type"] == "harness"}, ".json")
    copy_kind("commands", {n["command"] for n in draft["nodes"] if n["type"] == "command"}, ".json")
    copy_kind("scripts", {n["script"] for n in draft["nodes"] if n["type"] == "script"}, ".py")
    copy_kind("guards", {e["guard"] for e in draft["edges"] if e.get("guard")}, ".py")
    for nm in sub_names:
        shutil.copytree(_find_packed_source(nm, search), pack / "submodules" / nm)
    return pack


@router.post("/modules/packs/validate")
def validate_pack(body: dict, search: list[Path] = Depends(get_search_paths)) -> dict:
    """dry-run：组装临时目录 → validate_pack_dir（零落盘），附生成的 tasklist 供 UI 预览。"""
    draft = _load_draft_for_assembly(body)
    pack = None
    try:
        pack = _assemble_pack(draft, search)
        manifest = store.validate_pack_dir(pack)
    except ValueError as e:
        raise HTTPException(status_code=400, detail={"error": str(e)})
    finally:
        if pack is not None:
            shutil.rmtree(pack, ignore_errors=True)
    return {"ok": True, "manifest": manifest, "tasklist": draft_to_tasklist(draft)}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/test_build_api.py -q`
Expected: PASS（24 passed）

- [ ] **Step 5: 提交**

```bash
git add server/api/build.py tests/test_build_api.py
git commit -m "feat(server): pack 组装 + dry-run 校验端点（拷贝进包/validate_pack_dir 兜底）"
```

---

### Task 8: install 端点（组装 → install_pack → 详情；同名 409）

**Files:**
- Modify: `server/api/build.py`
- Test: `tests/test_build_api.py`

- [ ] **Step 1: 写失败测试**

`tests/test_build_api.py` 追加：

```python
class TestInstallPack:
    def test_install_ok_and_visible(self, client, base):
        seed_builder(client)
        r = client.post("/api/modules/packs", json={"draft": "loop_mod"})
        assert r.status_code == 200
        d = r.json()
        assert d["name"] == "loop_mod" and d["kind"] == "packed"
        # 安装后模块库可见（store/modules 在搜索路径内）
        names = [m["name"] for m in client.get("/api/modules").json()["modules"]]
        assert "loop_mod" in names

    def test_install_duplicate_409(self, client, base):
        seed_builder(client)
        assert client.post("/api/modules/packs", json={"draft": "loop_mod"}).status_code == 200
        r = client.post("/api/modules/packs", json={"draft": "loop_mod"})
        assert r.status_code == 409 and "已存在" in r.json()["error"]

    def test_install_with_submodule(self, client, base):
        """submodule 索引 + 引用节点 → 组装时整包拷进 submodules/<键>/。"""
        seed_pack_module(base)
        client.put("/api/library/submodules/sub_greet")
        client.put("/api/library/scripts/greeter",
                   content=b"def greeter(view):\n    return {'ok': True}\n")
        draft = {
            "meta": {"name": "with_sub", "version": "0.1.0", "description": ""},
            "spec_schema": [], "default_spec": {},
            "nodes": [
                {"id": "g", "label": "Greeter", "type": "script", "script": "greeter",
                 "is_start": True, "join": "AND", "position": {"x": 0, "y": 0}, "inputs": {}},
                {"id": "s", "label": "Sub", "type": "submodule", "submodule": "sub_greet",
                 "is_start": False, "join": "AND", "position": {"x": 0, "y": 0},
                 "inputs": {"x": "Greeter"}},
            ],
            "edges": [{"id": "e1", "from": "g", "to": "s", "guard": None}],
        }
        client.put("/api/library/drafts/with_sub", json=draft)
        r = client.post("/api/modules/packs", json={"draft": "with_sub"})
        assert r.status_code == 200
        d = client.get("/api/modules/with_sub").json()
        assert "sub_greet" in d["submodules"]

    def test_install_missing_submodule_source_400(self, client, base):
        """登记后源包被删 → 组装期报缺失（索引轻、拷贝在组装时刻）。"""
        pack = seed_pack_module(base, "doomed")
        import shutil as _sh
        _sh.rmtree(pack)
        client.put("/api/library/submodules/doomed")
        client.put("/api/library/scripts/greeter",
                   content=b"def greeter(view):\n    return {'ok': True}\n")
        draft = {
            "meta": {"name": "orphan", "version": "0.1.0", "description": ""},
            "spec_schema": [], "default_spec": {},
            "nodes": [{"id": "s", "label": "Sub", "type": "submodule", "submodule": "doomed",
                       "is_start": True, "join": "AND", "position": {"x": 0, "y": 0}, "inputs": {}}],
            "edges": [],
        }
        client.put("/api/library/drafts/orphan", json=draft)
        r = client.post("/api/modules/packs", json={"draft": "orphan"})
        assert r.status_code == 400 and "doomed" in r.json()["error"]
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/test_build_api.py -q`
Expected: 新增 4 例 FAIL（404）

- [ ] **Step 3: 实现**

`server/api/build.py` 追加：

```python
@router.post("/modules/packs")
def install_pack_route(
    body: dict,
    search: list[Path] = Depends(get_search_paths),
) -> dict:
    """组装 + validate + install_pack（source="webview-builder"）→ 返回模块详情。

    同名已存在（store 或任何搜索来源，防遮蔽）→ 409；校验/组装失败 → 400。
    """
    draft = _load_draft_for_assembly(body)
    name = draft["meta"]["name"]
    if store.resolve_module(name, search=search) is not None:
        raise HTTPException(status_code=409, detail={
            "error": f"模块 '{name}' 已存在——改名或先卸载", "module": name})
    pack = None
    try:
        pack = _assemble_pack(draft, search)
        store.install_pack(pack, source="webview-builder")
    except ValueError as e:
        status = 409 if "已存在" in str(e) else 400
        raise HTTPException(status_code=status, detail={"error": str(e), "module": name})
    finally:
        if pack is not None:
            shutil.rmtree(pack, ignore_errors=True)
    resolved = store.resolve_module_full(name, search=search)
    if resolved is None:
        raise HTTPException(status_code=500, detail={"error": "安装后详情读取失败", "module": name})
    return store.detail_to_dict(resolved)
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `uv run pytest tests/test_build_api.py -q && uv run pytest tests/ -q`
Expected: 28 passed；全量套件绿（构建面不破坏既有端点）

- [ ] **Step 5: 提交**

```bash
git add server/api/build.py tests/test_build_api.py
git commit -m "feat(server): pack 安装端点——install_pack 落 store + 详情返回（同名 409 防遮蔽）"
```

---

### Task 9: 前端 api.ts——类型与端点封装

**Files:**
- Modify: `web/src/api.ts`（文件末尾追加）

- [ ] **Step 1: 实现**

`web/src/api.ts` 末尾追加：

```ts
// ------------------------------------------------------------------
// 模块构建器：组件库 / 草稿 / 组装安装
// ------------------------------------------------------------------

export type LibraryKind =
  | "harnesses" | "commands" | "scripts" | "guards" | "submodules" | "drafts";

export interface LibraryIndex {
  harnesses: string[];
  commands: string[];
  scripts: string[];
  guards: string[];
  submodules: { name: string; added_at: string }[];
  drafts: string[];
}

export const fetchLibrary = () => getJson<LibraryIndex>("/api/library");

/** 单组件详情：harness/command = 配置 JSON；scripts/guards = {name, code}；draft = 草稿 */
export const fetchLibraryItem = (kind: LibraryKind, name: string) =>
  getJson<Record<string, unknown>>(
    `/api/library/${kind}/${encodeURIComponent(name)}`);

export const putLibraryJson = (kind: LibraryKind, name: string, payload: unknown) =>
  request<{ saved: boolean }>(`/api/library/${kind}/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

/** 上传代码（scripts/guards）：raw body UTF-8 文本，stem = 注册函数名 */
export const putLibraryCode = (kind: LibraryKind, name: string, code: string) =>
  request<{ saved: boolean }>(`/api/library/${kind}/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "text/x-python" },
    body: code,
  });

export const deleteLibraryItem = (kind: LibraryKind, name: string) =>
  request<{ deleted: boolean }>(`/api/library/${kind}/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });

export interface BuilderMeta { name: string; version: string; description: string }

export type SpecTypeName = "str" | "int" | "float" | "bool" | "list" | "dict" | "any";
export interface SpecField { field: string; type: SpecTypeName }

export type BuilderNodeType = "harness" | "script" | "command" | "submodule";

export interface BuilderNode {
  id: string;
  /** = tasklist 任务名（Flow 引用名，标识符） */
  label: string;
  type: BuilderNodeType;
  harness?: string; script?: string; command?: string; submodule?: string;
  is_start: boolean;
  join: "AND" | "OR";
  position: { x: number; y: number };
  inputs: Record<string, string>;
  /** harness/command 节点的 TaskDefinition 逐项覆盖 */
  overrides?: Record<string, unknown>;
  /** submodule 输出映射 {本节点字段: 子输出字段} */
  outputs?: Record<string, string>;
}

export interface BuilderEdge { id: string; from: string; to: string; guard: string | null }

export interface BuilderDraft {
  meta: BuilderMeta;
  spec_schema: SpecField[];
  default_spec: Record<string, unknown>;
  nodes: BuilderNode[];
  edges: BuilderEdge[];
  updated_at?: string;
}

export const emptyDraft = (name: string): BuilderDraft => ({
  meta: { name, version: "0.1.0", description: "" },
  spec_schema: [],
  default_spec: {},
  nodes: [],
  edges: [],
});

export const fetchDraft = (name: string) =>
  fetchLibraryItem("drafts", name) as Promise<BuilderDraft>;

export const putDraft = (d: BuilderDraft) => putLibraryJson("drafts", d.meta.name, d);

export const deleteDraft = (name: string) => deleteLibraryItem("drafts", name);

export interface ValidatePackResult {
  ok: boolean;
  manifest: Record<string, unknown>;
  tasklist: { Tasks: Record<string, unknown>; Flow: string };
}

export const validatePack = (draftName: string) =>
  postJson<ValidatePackResult>("/api/modules/packs/validate", { draft: draftName });

export const installPack = (draftName: string) =>
  postJson<ModuleDetail>("/api/modules/packs", { draft: draftName });

/** 节点类型 → 草稿引用字段（builder/NodePanel 与画布共用） */
export const NODE_REF_FIELD: Record<BuilderNodeType, keyof BuilderNode> = {
  harness: "harness", script: "script", command: "command", submodule: "submodule",
};

/** 生成短随机 id（节点 n_xxx / 边 e_xxx） */
export const genId = (prefix: string) =>
  `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
```

- [ ] **Step 2: 类型门禁**

Run: `cd web && npm run build`
Expected: tsc 无错误，构建成功

- [ ] **Step 3: 提交**

```bash
git add web/src/api.ts
git commit -m "feat(web): 构建器 api 封装——组件库/草稿/组装安装类型与端点"
```

---

### Task 10: 壳层接线——ActivityBar / TabBar / App

**Files:**
- Modify: `web/src/components/ActivityBar.tsx`
- Modify: `web/src/components/TabBar.tsx`
- Modify: `web/src/App.tsx`

- [ ] **Step 1: ActivityBar 加 build 页签**

`ActivityBar.tsx`：

```tsx
import { Boxes, GitFork, Hammer, List, MessageSquare, Settings } from "lucide-react";
```

```tsx
export type Tab = "chat" | "tree" | "modules" | "build" | "runs" | "settings";
```

TABS 数组 `modules` 项后插入：

```tsx
  { key: "build", label: "构建（组件库·模块创建器）", icon: Hammer },
```

- [ ] **Step 2: TabBar 加 build kind**

`TabBar.tsx`：

```tsx
import { Box, Hammer, MessageSquare, Play, X } from "lucide-react";
```

```tsx
export type TabKind = "modules" | "chat" | "run" | "build";
```

Icon 行替换为：

```tsx
        const Icon =
          t.kind === "modules" ? Box :
          t.kind === "build" ? Hammer :
          t.kind === "chat" ? MessageSquare : Play;
```

- [ ] **Step 3: App.tsx 接线**

import 区追加：

```tsx
import { LibraryPanel } from "./components/LibraryPanel";
import { ModuleBuilder } from "./components/builder/ModuleBuilder";
```

`DynTab` 与 `ensureTab` 签名扩 kind：

```tsx
interface DynTab { kind: "chat" | "run" | "build"; key: string }
```

```tsx
  const ensureTab = useCallback((kind: "chat" | "run" | "build", key: string) => {
```

`openRunTab` 后加：

```tsx
  // 构建板块：打开/新建草稿 → build 页签（侧栏随之切组件库）
  const openBuilder = useCallback((name: string) => {
    ensureTab("build", name);
    setActiveId(`build:${name}`);
    setSidebarTab("build");
  }, [ensureTab]);
```

`activeRunId` 行后加：

```tsx
  const activeBuildName = activeId.startsWith("build:") ? activeId.slice(6) : null;
```

`tabItems` 的 map 分支追加 build 项（chat 分支后）：

```tsx
        : t.kind === "build"
          ? { id: tabId(t), kind: "build" as const, label: t.key, closable: true }
```

（原 run 分支改到最后的 `:` 之后，保持三元链完整。）

侧栏 `sidebarTab === "modules"` 分支后加：

```tsx
        {sidebarTab === "build" && (
          <LibraryPanel
            activeDraft={activeBuildName}
            onOpenDraft={openBuilder}
            onCreated={openBuilder}
            onDeleted={(name) => closeTab(`build:${name}`)}
          />
        )}
```

主区 `activeRunId ? (...) : null` 改为（RunView 分支后、null 前插入）：

```tsx
          ) : activeBuildName ? (
            <ModuleBuilder
              key={activeBuildName}
              name={activeBuildName}
              onInstalled={(moduleName) => {
                setOpenModuleName(moduleName);
                setActiveId("modules");
                setSidebarTab("modules");
              }}
            />
          ) : null}
```

- [ ] **Step 4: 类型门禁（ModuleBuilder/LibraryPanel 尚不存在，先建占位使壳层可编译）**

创建最小占位 `web/src/components/LibraryPanel.tsx`：

```tsx
// 侧栏组件库面板（Task 11 实现完整功能；占位保证壳层可编译）。
interface Props {
  activeDraft: string | null;
  onOpenDraft: (name: string) => void;
  onCreated: (name: string) => void;
  onDeleted: (name: string) => void;
}

export function LibraryPanel(_props: Props) {
  return <div className="flex-1 overflow-auto p-3 text-[12px] text-muted-foreground">组件库加载中…</div>;
}
```

创建最小占位 `web/src/components/builder/ModuleBuilder.tsx`：

```tsx
// 模块创建器主区（Task 12-14 实现完整功能；占位保证壳层可编译）。
interface Props {
  name: string;
  onInstalled: (moduleName: string) => void;
}

export function ModuleBuilder({ name }: Props) {
  return (
    <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
      创建器加载中：{name}
    </div>
  );
}
```

Run: `cd web && npm run build`
Expected: 构建成功

- [ ] **Step 5: 提交**

```bash
git add web/src/components/ActivityBar.tsx web/src/components/TabBar.tsx web/src/App.tsx web/src/components/LibraryPanel.tsx web/src/components/builder/ModuleBuilder.tsx
git commit -m "feat(web): 壳层接入构建板块——build 页签/侧栏分支/多草稿页签（面板占位）"
```

---

### Task 11: LibraryPanel + ComponentForms（组件库侧栏与表单对话框）

**Files:**
- Create: `web/src/components/library/ComponentForms.tsx`
- Modify: `web/src/components/LibraryPanel.tsx`（替换 Task 10 占位）

- [ ] **Step 1: 实现 ComponentForms.tsx**

```tsx
// harness/command 组件表单对话框（自绘 overlay，dialogTheme 共享类）。
// 字段对照库 HarnessConfig / CommandConfig；保存走 PUT /api/library/{kind}/{name}，
// 服务端 from_dict 实例化验形——前端不做深校验，错误透出。
import { useState } from "react";
import { Button } from "../ui/button";
import { Input, Textarea } from "../ui/input";
import { errTextCls, fieldCls, labelCls, overlayCls, panelCls } from "../dialogTheme";
import { putLibraryJson } from "../../api";

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface DialogProps {
  onClose: () => void;
  onSaved: (name: string) => void;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className={labelCls}>{label}</div>
      {children}
    </div>
  );
}

function Overlay({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className={overlayCls} onClick={onClose}>
      <div className={panelCls} onClick={(e) => e.stopPropagation()}>
        <div className="text-[13px] font-semibold">{title}</div>
        {children}
      </div>
    </div>
  );
}

/** 键值对行编辑（prompt_modes / env 共用） */
function KvRows({ value, onChange }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const entries = Object.entries(value);
  const set = (k: string, v: string) => onChange({ ...value, [k]: v });
  const del = (k: string) => {
    const next = { ...value };
    delete next[k];
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-1">
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-center gap-1">
          <Input value={k} disabled className="w-28 font-mono text-[12px]" />
          <span className="text-muted-foreground">=</span>
          <Input value={v} onChange={(e) => set(k, e.target.value)} className="flex-1 font-mono text-[12px]" />
          <Button variant="ghost" size="icon" title="删除" onClick={() => del(k)}>×</Button>
        </div>
      ))}
      <div className="flex items-center gap-1">
        <NewKeyInput onAdd={(k) => onChange({ ...value, [k]: "" })} />
      </div>
    </div>
  );
}

function NewKeyInput({ onAdd }: { onAdd: (k: string) => void }) {
  const [k, setK] = useState("");
  return (
    <>
      <Input value={k} placeholder="新键名" onChange={(e) => setK(e.target.value)} className="w-28 font-mono text-[12px]" />
      <Button variant="outline" size="sm" disabled={!k} onClick={() => { onAdd(k); setK(""); }}>添加键</Button>
    </>
  );
}

const HARNESS_EMPTY = {
  prompt_core: "", model: "", temperature: "", think: "", api_params: "",
  mode: "text", image_size: "", image_dir: "images",
  out_type: "", out_schema: "", out_instruction: "",
};

export function HarnessDialog({ initial, onClose, onSaved }: DialogProps & { initial: string | null }) {
  const [name, setName] = useState(initial ?? "");
  const [f, setF] = useState(HARNESS_EMPTY);
  const [promptModes, setPromptModes] = useState<Record<string, string>>({});
  const [notdo, setNotdo] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const upd = (patch: Partial<typeof f>) => setF((p) => ({ ...p, ...patch }));

  const save = async () => {
    if (!NAME_RE.test(name)) { setErr("名称须为 Python 标识符"); return; }
    if (!f.prompt_core.trim()) { setErr("prompt_core 必填"); return; }
    // 载荷只带非空字段；think/api_params 解析失败就地示错
    const payload: Record<string, unknown> = { name, prompt_core: f.prompt_core };
    if (Object.keys(promptModes).length) payload.prompt_modes = promptModes;
    if (notdo.trim()) payload.notdo = notdo.split(",").map((s) => s.trim()).filter(Boolean);
    if (f.model.trim()) payload.model = f.model.trim();
    if (f.temperature.trim()) payload.temperature = Number(f.temperature);
    if (f.think.trim()) {
      if (f.think === "true" || f.think === "false") payload.think = f.think === "true";
      else { try { payload.think = JSON.parse(f.think); } catch { setErr("think 须为 true/false/JSON"); return; } }
    }
    if (f.api_params.trim()) {
      try { payload.api_params = JSON.parse(f.api_params); } catch { setErr("api_params 须为合法 JSON"); return; }
    }
    if (f.mode === "image") { payload.mode = "image"; if (f.image_size.trim()) payload.image_size = f.image_size.trim(); payload.image_dir = f.image_dir || "images"; }
    if (f.out_type) {
      const of: Record<string, unknown> = { type: f.out_type };
      if (f.out_type === "json_schema" && f.out_schema.trim()) {
        try { of.schema = JSON.parse(f.out_schema); } catch { setErr("output schema 须为合法 JSON"); return; }
      }
      if (f.out_instruction.trim()) of.instruction = f.out_instruction;
      payload.output_format = of;
    }
    setBusy(true); setErr(null);
    try {
      await putLibraryJson("harnesses", name, payload);
      onSaved(name);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  return (
    <Overlay title={initial ? `编辑 harness：${initial}` : "新建 harness"} onClose={onClose}>
      <Row label="名称（注册名）">
        <Input value={name} disabled={!!initial} onChange={(e) => setName(e.target.value)} className="font-mono" />
      </Row>
      <Row label="prompt_core（必填，支持 {key} 占位）">
        <Textarea value={f.prompt_core} onChange={(e) => upd({ prompt_core: e.target.value })} rows={3} />
      </Row>
      <Row label="prompt_modes（动态选项集）"><KvRows value={promptModes} onChange={setPromptModes} /></Row>
      <Row label="notdo（否定性约束，逗号分隔）">
        <Input value={notdo} onChange={(e) => setNotdo(e.target.value)} />
      </Row>
      <div className="grid grid-cols-2 gap-2">
        <Row label="model"><Input value={f.model} onChange={(e) => upd({ model: e.target.value })} /></Row>
        <Row label="temperature"><Input value={f.temperature} onChange={(e) => upd({ temperature: e.target.value })} placeholder="0.3" /></Row>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Row label="think（true/false/JSON，空=不设）"><Input value={f.think} onChange={(e) => upd({ think: e.target.value })} /></Row>
        <Row label="mode">
          <select className={fieldCls} value={f.mode} onChange={(e) => upd({ mode: e.target.value })}>
            <option value="text">text</option>
            <option value="image">image</option>
          </select>
        </Row>
      </div>
      {f.mode === "image" && (
        <div className="grid grid-cols-2 gap-2">
          <Row label="image_size"><Input value={f.image_size} onChange={(e) => upd({ image_size: e.target.value })} placeholder="1024x1024" /></Row>
          <Row label="image_dir"><Input value={f.image_dir} onChange={(e) => upd({ image_dir: e.target.value })} /></Row>
        </div>
      )}
      <Row label="api_params（SDK 透传 JSON，空=不设）">
        <Textarea value={f.api_params} onChange={(e) => upd({ api_params: e.target.value })} rows={2} className="font-mono" />
      </Row>
      <div className="grid grid-cols-3 gap-2">
        <Row label="output_format">
          <select className={fieldCls} value={f.out_type} onChange={(e) => upd({ out_type: e.target.value })}>
            <option value="">（不约束）</option>
            <option value="json_object">json_object</option>
            <option value="json_schema">json_schema</option>
            <option value="text">text</option>
          </select>
        </Row>
        {f.out_type === "json_schema" && (
          <Row label="schema JSON">
            <Textarea value={f.out_schema} onChange={(e) => upd({ out_schema: e.target.value })} rows={2} className="font-mono" />
          </Row>
        )}
        {f.out_type && (
          <Row label="instruction"><Input value={f.out_instruction} onChange={(e) => upd({ out_instruction: e.target.value })} /></Row>
        )}
      </div>
      {err && <div className={errTextCls}>{err}</div>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
        <Button size="sm" disabled={busy} onClick={save}>保存</Button>
      </div>
    </Overlay>
  );
}

export function CommandDialog({ initial, onClose, onSaved }: DialogProps & { initial: string | null }) {
  const [name, setName] = useState(initial ?? "");
  const [command, setCommand] = useState("");
  const [timeout_, setTimeout_] = useState("60");
  const [cwd, setCwd] = useState("");
  const [env, setEnv] = useState<Record<string, string>>({});
  const [capture, setCapture] = useState(true);
  const [shell, setShell] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!NAME_RE.test(name)) { setErr("名称须为 Python 标识符"); return; }
    if (!command.trim()) { setErr("command 必填"); return; }
    const payload: Record<string, unknown> = { name, command, timeout: Number(timeout_) || 60 };
    if (cwd.trim()) payload.cwd = cwd.trim();
    if (Object.keys(env).length) payload.env = env;
    payload.capture_output = capture;
    payload.shell = shell;
    setBusy(true); setErr(null);
    try {
      await putLibraryJson("commands", name, payload);
      onSaved(name);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  return (
    <Overlay title={initial ? `编辑 command：${initial}` : "新建 command"} onClose={onClose}>
      <Row label="名称（注册名）">
        <Input value={name} disabled={!!initial} onChange={(e) => setName(e.target.value)} className="font-mono" />
      </Row>
      <Row label="shell 命令（必填）">
        <Textarea value={command} onChange={(e) => setCommand(e.target.value)} rows={2} className="font-mono" />
      </Row>
      <div className="grid grid-cols-2 gap-2">
        <Row label="timeout（秒）"><Input value={timeout_} onChange={(e) => setTimeout_(e.target.value)} /></Row>
        <Row label="cwd（空=缺省）"><Input value={cwd} onChange={(e) => setCwd(e.target.value)} /></Row>
      </div>
      <Row label="env（额外环境变量）"><KvRows value={env} onChange={setEnv} /></Row>
      <div className="flex gap-4 text-[12px]">
        <label className="flex items-center gap-1"><input type="checkbox" checked={capture} onChange={(e) => setCapture(e.target.checked)} />capture_output</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={shell} onChange={(e) => setShell(e.target.checked)} />shell</label>
      </div>
      {err && <div className={errTextCls}>{err}</div>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
        <Button size="sm" disabled={busy} onClick={save}>保存</Button>
      </div>
    </Overlay>
  );
}
```

注意：`ui/input` 须导出 `Textarea`（SpecForm 已 `import { Input, Textarea } from "./ui/input"`，存在）。

- [ ] **Step 2: 实现 LibraryPanel（替换占位）**

```tsx
// 侧栏组件库面板（构建板块）：分组浏览/上传/删除 + submodule 索引 + 草稿列表 + 新建模块。
// 组件详情浏览：harness/command 点开表单回填编辑；scripts/guards 点开只读代码预览。
import { useCallback, useEffect, useRef, useState } from "react";
import { FileCode, FlaskConical, Hammer, Plus, TerminalSquare, Trash2, Wrench, X } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { errTextCls, labelCls, overlayCls, panelCls } from "./dialogTheme";
import {
  deleteLibraryItem, fetchLibrary, fetchLibraryItem, fetchModules, putLibraryCode,
  putLibraryJson, type LibraryIndex,
} from "../api";
import { CommandDialog, HarnessDialog } from "./library/ComponentForms";

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface Props {
  activeDraft: string | null;
  onOpenDraft: (name: string) => void;
  onCreated: (name: string) => void;
  onDeleted: (name: string) => void;
}

function ItemRow({ name, active, onOpen, onDelete }: {
  name: string; active: boolean; onOpen: () => void; onDelete: () => void;
}) {
  return (
    <div className={`group flex h-7 items-center gap-1 rounded-control px-1.5 ${active ? "bg-accent" : "hover:bg-accent/60"}`}>
      <button className="min-w-0 flex-1 truncate text-left font-mono text-[12px]" onClick={onOpen} title={name}>
        {name}
      </button>
      <button title="删除" onClick={onDelete}
              className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100">
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function GroupHeader({ icon, title, action }: { icon: React.ReactNode; title: string; action?: React.ReactNode }) {
  return (
    <div className="flex h-7 items-center gap-1.5 px-1 text-[11px] font-semibold text-muted-foreground">
      {icon}{title}
      <span className="ml-auto">{action}</span>
    </div>
  );
}

export function LibraryPanel({ activeDraft, onOpenDraft, onCreated, onDeleted }: Props) {
  const [lib, setLib] = useState<LibraryIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editKind, setEditKind] = useState<"harnesses" | "commands" | null>(null);
  const [editName, setEditName] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ name: string; code: string } | null>(null);
  const [newDraftOpen, setNewDraftOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadKind = useRef<"scripts" | "guards">("scripts");

  const refresh = useCallback(() => {
    fetchLibrary().then(setLib).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const del = async (kind: Parameters<typeof deleteLibraryItem>[0], name: string) => {
    if (!window.confirm(`删除 ${kind}/${name}？`)) return;
    try {
      await deleteLibraryItem(kind, name);
      if (kind === "drafts") onDeleted(name);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const openEdit = (kind: "harnesses" | "commands", name: string | null) => {
    setEditKind(kind);
    setEditName(name);
  };

  const pickUpload = (kind: "scripts" | "guards") => {
    uploadKind.current = kind;
    fileRef.current?.click();
  };

  const onFile = async (f: File) => {
    const stem = f.name.replace(/\.py$/, "");
    if (!NAME_RE.test(stem)) {
      setError(`文件名 stem 须为 Python 标识符（注册名=stem）：${f.name}`);
      return;
    }
    try {
      await putLibraryCode(uploadKind.current, stem, await f.text());
      setError(null);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const openCodePreview = async (kind: "scripts" | "guards", name: string) => {
    try {
      const d = await fetchLibraryItem(kind, name);
      setPreview({ name, code: String(d.code ?? "") });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // submodule 候选 = 已安装 packed/pip 模块 − 已登记
  const [subCandidates, setSubCandidates] = useState<string[]>([]);
  useEffect(() => {
    fetchModules()
      .then((d) => setSubCandidates(
        d.modules.filter((m) => m.kind === "packed" || m.kind === "pip").map((m) => m.name)))
      .catch(() => {});
  }, [lib]);

  const addSubmodule = async (name: string) => {
    try {
      await putLibraryJson("submodules", name, {});
      setError(null);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="library-panel">
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b px-3">
        <span className="text-[13px] font-semibold">🛠 组件库</span>
        <Button size="sm" className="ml-auto" onClick={() => setNewDraftOpen(true)}>
          <Plus className="h-3.5 w-3.5" />新建模块
        </Button>
      </div>
      {error && <div className={`px-3 pt-2 ${errTextCls}`}>{error}</div>}
      <input ref={fileRef} type="file" accept=".py" className="hidden"
             onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
      <div className="min-h-0 flex-1 overflow-auto px-2 py-1.5">
        <GroupHeader icon={<Wrench className="h-3.5 w-3.5" />} title="Harness"
          action={<Button variant="ghost" size="icon" title="新建 harness" onClick={() => openEdit("harnesses", null)}><Plus className="h-3.5 w-3.5" /></Button>} />
        {lib?.harnesses.map((n) => (
          <ItemRow key={n} name={n} active={false} onOpen={() => openEdit("harnesses", n)} onDelete={() => del("harnesses", n)} />
        ))}
        <GroupHeader icon={<TerminalSquare className="h-3.5 w-3.5" />} title="Command"
          action={<Button variant="ghost" size="icon" title="新建 command" onClick={() => openEdit("commands", null)}><Plus className="h-3.5 w-3.5" /></Button>} />
        {lib?.commands.map((n) => (
          <ItemRow key={n} name={n} active={false} onOpen={() => openEdit("commands", n)} onDelete={() => del("commands", n)} />
        ))}
        <GroupHeader icon={<FileCode className="h-3.5 w-3.5" />} title="Scripts"
          action={<Button variant="ghost" size="icon" title="上传 .py" onClick={() => pickUpload("scripts")}><Plus className="h-3.5 w-3.5" /></Button>} />
        {lib?.scripts.map((n) => (
          <ItemRow key={n} name={n} active={false} onOpen={() => openCodePreview("scripts", n)} onDelete={() => del("scripts", n)} />
        ))}
        <GroupHeader icon={<FlaskConical className="h-3.5 w-3.5" />} title="Guards"
          action={<Button variant="ghost" size="icon" title="上传 .py" onClick={() => pickUpload("guards")}><Plus className="h-3.5 w-3.5" /></Button>} />
        {lib?.guards.map((n) => (
          <ItemRow key={n} name={n} active={false} onOpen={() => openCodePreview("guards", n)} onDelete={() => del("guards", n)} />
        ))}
        <GroupHeader icon={<Hammer className="h-3.5 w-3.5" />} title="子模块（可引用的已装 packed 模块）" />
        <div className="mb-1 px-1.5">
          <select className="w-full rounded-control border border-input bg-transparent px-1.5 py-1 text-[12px]"
                  value="" disabled={subCandidates.length === 0}
                  onChange={(e) => { if (e.target.value) addSubmodule(e.target.value); }}>
            <option value="">{subCandidates.length ? "+ 以 submodule 形式入库…" : "（无 packed 模块）"}</option>
            {subCandidates.filter((c) => !lib?.submodules.some((s) => s.name === c))
              .map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        {lib?.submodules.map((s) => (
          <ItemRow key={s.name} name={s.name} active={false} onOpen={() => {}} onDelete={() => del("submodules", s.name)} />
        ))}
        <GroupHeader icon={<Hammer className="h-3.5 w-3.5" />} title="模块草稿" />
        {lib?.drafts.length === 0 && (
          <div className="px-2 py-1 text-[12px] text-muted-foreground">（空——点「新建模块」开始）</div>
        )}
        {lib?.drafts.map((n) => (
          <ItemRow key={n} name={n} active={n === activeDraft} onOpen={() => onOpenDraft(n)} onDelete={() => del("drafts", n)} />
        ))}
      </div>

      {editKind && (
        editKind === "harnesses"
          ? <HarnessDialog initial={editName} onClose={() => setEditKind(null)}
                           onSaved={() => { setEditKind(null); refresh(); }} />
          : <CommandDialog initial={editName} onClose={() => setEditKind(null)}
                           onSaved={() => { setEditKind(null); refresh(); }} />
      )}
      {preview && (
        <div className={overlayCls} onClick={() => setPreview(null)}>
          <div className={panelCls} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center">
              <div className="text-[13px] font-semibold">{preview.name}</div>
              <button className="ml-auto rounded p-1 hover:bg-accent" onClick={() => setPreview(null)}>
                <X className="h-4 w-4" />
              </button>
            </div>
            <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[12px]">{preview.code}</pre>
          </div>
        </div>
      )}
      {newDraftOpen && (
        <NewDraftDialog onClose={() => setNewDraftOpen(false)}
                        onCreated={(name) => { setNewDraftOpen(false); onCreated(name); refresh(); }} />
      )}
    </div>
  );
}

function NewDraftDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (name: string) => void }) {
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (!NAME_RE.test(name)) { setErr("名称须为 Python 标识符（同时是包名/选择器）"); return; }
    setBusy(true); setErr(null);
    try {
      const { emptyDraft, putDraft } = await import("../api");
      await putDraft(emptyDraft(name));
      onCreated(name);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <div className={overlayCls} onClick={onClose}>
      <div className={panelCls} onClick={(e) => e.stopPropagation()}>
        <div className={labelCls}>新建模块草稿</div>
        <Input autoFocus value={name} placeholder="模块名（如 my_writer）"
               onChange={(e) => setName(e.target.value)}
               onKeyDown={(e) => e.key === "Enter" && create()} />
        {err && <div className={errTextCls}>{err}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" disabled={busy || !name} onClick={create}>创建</Button>
        </div>
      </div>
    </div>
  );
}
```

注意：LibraryPanel 在 `components/` 根，故 import 路径 `./library/ComponentForms`、`./ui/*`、`./dialogTheme`；`fetchModules/putLibraryCode` 等来自 `../api`。上面代码内 `import ... from "../api"` 与 `./ui/button` 需按实际位置写对（组件位于 `web/src/components/`，api 为 `../api`）。

- [ ] **Step 3: 类型门禁**

Run: `cd web && npm run build`
Expected: 构建成功（若 `ui/input` 无 Textarea 导出，按该文件实际导出名修正 import）

- [ ] **Step 4: 手工冒烟（后端已起时）**

Run: `cd web && npm run dev`，浏览器开 :5173 → 活动栏点「构建」→ 新建 harness（填 prompt_core 保存）→ 列表出现；上传一个 .py → scripts 组出现。
Expected: 全部操作成功，无控制台报错

- [ ] **Step 5: 提交**

```bash
git add web/src/components/LibraryPanel.tsx web/src/components/library/ComponentForms.tsx
git commit -m "feat(web): 组件库侧栏面板——分组浏览/harness与command表单/代码上传预览/submodule索引/草稿列表"
```

---

### Task 12: 画布——BuilderNodeView + EditableCanvas + 自动布局

**Files:**
- Create: `web/src/components/builder/BuilderNodeView.tsx`
- Create: `web/src/components/builder/EditableCanvas.tsx`
- Create: `web/src/components/builder/layout.ts`

- [ ] **Step 1: layout.ts（dagre 自动布局，id 基）**

```ts
// 构建器画布自动布局（TB，同只读图 dagre.ts 的取向；节点必须显式携带宽高）。
import dagre from "@dagrejs/dagre";
import type { BuilderDraft, BuilderNode } from "../../api";

export const BUILDER_NODE_SIZE = { width: 190, height: 64 };

/** 返回重排后的 nodes 数组（draft.nodes 替换用；位置取 dagre 左上角坐标）。 */
export function autoLayout(nodes: BuilderNode[], edges: BuilderDraft["edges"]): BuilderNode[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 40, ranksep: 80 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: BUILDER_NODE_SIZE.width, height: BUILDER_NODE_SIZE.height });
  for (const e of edges) g.setEdge(e.from, e.to);
  dagre.layout(g);
  return nodes.map((n) => {
    const p = g.node(n.id);
    return p
      ? { ...n, position: { x: p.x - BUILDER_NODE_SIZE.width / 2, y: p.y - BUILDER_NODE_SIZE.height / 2 } }
      : n;
  });
}
```

- [ ] **Step 2: BuilderNodeView.tsx**

```tsx
// 构建器自定义节点：类型徽章 + 任务名 + 组件引用名；起点节点左侧起点圆点。
// Handle 布局与 StatusNode 一致（上 target / 下 source，竖向流）。
import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Bot, Code2, SquareTerminal, Boxes } from "lucide-react";
import { cn } from "../../lib/utils";

export type BuilderNodeData = {
  label: string;
  nodeType: "harness" | "script" | "command" | "submodule";
  ref: string;
  isStart: boolean;
};
export type BuilderFlowNode = Node<BuilderNodeData, "builder">;

const TYPE_META = {
  harness: { icon: Bot, cls: "text-violet-500", text: "harness" },
  script: { icon: Code2, cls: "text-sky-500", text: "script" },
  command: { icon: SquareTerminal, cls: "text-amber-500", text: "command" },
  submodule: { icon: Boxes, cls: "text-emerald-500", text: "submodule" },
} as const;

function BuilderNodeInner({ data, selected }: NodeProps<BuilderFlowNode>) {
  const meta = TYPE_META[data.nodeType];
  const Icon = meta.icon;
  return (
    <div className={cn(
      "box-border flex h-full items-center gap-2 rounded-[10px] border bg-card px-2.5 py-1.5",
      selected ? "border-[1.5px] border-primary shadow-[0_0_0_2px_color-mix(in_srgb,hsl(var(--primary))_18%,transparent)]" : "border-border",
    )}>
      <Handle type="target" position={Position.Top} />
      {data.isStart && (
        <span title="起点" className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
      )}
      <Icon className={cn("h-3.5 w-3.5 shrink-0", meta.cls)} />
      <div className="min-w-0 flex-1 text-left">
        <div title={data.label} className="truncate text-[12px] font-semibold leading-tight">{data.label}</div>
        <div title={data.ref} className="truncate font-mono text-[11px] leading-tight text-muted-foreground">
          {meta.text} · {data.ref}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

export const BuilderNodeView = memo(BuilderNodeInner);
```

- [ ] **Step 3: EditableCanvas.tsx**

```tsx
// 编辑画布：draft.nodes/edges 为唯一数据源，React Flow 完全受控——
// 所有变更（连线/删除/拖拽落位/点选）都以 onChange 回写 draft，画布零独立状态。
import { useCallback, useMemo } from "react";
import {
  Background, Controls, MiniMap, ReactFlow, type Edge, type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { BuilderDraft, BuilderEdge, BuilderNode } from "../../api";
import { genId } from "../../api";
import { BUILDER_NODE_SIZE, autoLayout } from "./layout";
import { BuilderNodeView, type BuilderFlowNode } from "./BuilderNodeView";

const nodeTypes = { builder: BuilderNodeView };

export type Selection = { kind: "node" | "edge"; id: string } | null;

interface Props {
  draft: BuilderDraft;
  selected: Selection;
  onSelect: (s: Selection) => void;
  onChange: (fn: (d: BuilderDraft) => BuilderDraft) => void;
}

/** 草稿节点 → 画布布局重排（ModuleBuilder「自动布局」按钮与新建节点落位共用） */
export function relayout(draft: BuilderDraft): BuilderDraft {
  return { ...draft, nodes: autoLayout(draft.nodes, draft.edges) };
}

export function EditableCanvas({ draft, selected, onSelect, onChange }: Props) {
  const rfNodes: Node<BuilderFlowNode>[] = useMemo(
    () => draft.nodes.map((n) => ({
      id: n.id,
      type: "builder" as const,
      position: n.position,
      data: {
        label: n.label,
        nodeType: n.type,
        ref: String(n[n.type === "harness" ? "harness" : n.type === "script" ? "script" : n.type === "command" ? "command" : "submodule"] ?? ""),
        isStart: n.is_start,
      },
      selected: selected?.kind === "node" && selected.id === n.id,
    })),
    [draft.nodes, selected],
  );

  const rfEdges: Edge[] = useMemo(
    () => draft.edges.map((e) => ({
      id: e.id,
      source: e.from,
      target: e.to,
      label: e.guard ?? undefined,
      animated: !!e.guard,
      style: e.guard ? { stroke: "var(--ph-running, #3b82f6)", strokeWidth: 1.5 } : undefined,
      labelStyle: { fontSize: 11, fill: "hsl(var(--muted-foreground))" },
      labelBgStyle: { fill: "hsl(var(--card))" },
      selected: selected?.kind === "edge" && selected.id === e.id,
    })),
    [draft.edges, selected],
  );

  const patchNode = useCallback((id: string, patch: Partial<BuilderNode>) => {
    onChange((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }));
  }, [onChange]);

  const onNodeDragStop = useCallback(
    (_: unknown, node: Node) => patchNode(node.id, { position: node.position }),
    [patchNode],
  );

  const onConnect = useCallback((params: { source: string; target: string }) => {
    const edge: BuilderEdge = { id: genId("e"), from: params.source, to: params.target, guard: null };
    onChange((d) => ({ ...d, edges: [...d.edges, edge] }));
    onSelect({ kind: "edge", id: edge.id });
  }, [onChange, onSelect]);

  const removeNodes = useCallback((ids: string[]) => {
    const set = new Set(ids);
    onChange((d) => ({
      ...d,
      nodes: d.nodes.filter((n) => !set.has(n.id)),
      edges: d.edges.filter((e) => !set.has(e.from) && !set.has(e.to)),
    }));
    onSelect(null);
  }, [onChange, onSelect]);

  const removeEdges = useCallback((ids: string[]) => {
    const set = new Set(ids);
    onChange((d) => ({ ...d, edges: d.edges.filter((e) => !set.has(e.id)) }));
    onSelect(null);
  }, [onChange, onSelect]);

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      onNodeDragStop={onNodeDragStop}
      onConnect={onConnect}
      onNodesDelete={(ns) => removeNodes(ns.map((n) => n.id))}
      onEdgesDelete={(es) => removeEdges(es.map((e) => e.id))}
      onNodeClick={(_, n) => onSelect({ kind: "node", id: n.id })}
      onEdgeClick={(_, e) => onSelect({ kind: "edge", id: e.id })}
      onPaneClick={() => onSelect(null)}
      onInit={(_, instance) => instance.fitView({ padding: 0.2 })}
      fitView
      minZoom={0.2}
      deleteKeyCode={["Delete", "Backspace"]}
    >
      <Background gap={16} />
      <MiniMap pannable zoomable />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
```

注：`BUILDER_NODE_SIZE` 供 MiniMap 语义（节点自带宽高）——RF v12 受控节点不强制宽高字段，节点 DOM 自撑高度（min-w 由 BuilderNodeView 内容决定）；若 MiniMap 出现空节点，再给 rfNodes 补 `width/height` 字段（留此备注，验收时核对）。

- [ ] **Step 4: 类型门禁**

Run: `cd web && npm run build`
Expected: 构建成功（新文件尚无引用，tsc noUnusedLocals 若报未引用错误属预期——`tsconfig` 若开启 noUnusedLocals，此步先在 ModuleBuilder 占位内 import relayout 消化，或待 Task 14 接线后统一过门禁；此处以 `npx tsc --noEmit` 单独验证这三个文件无类型错误为准）

Run: `cd web && npx tsc --noEmit`
Expected: 无新增类型错误

- [ ] **Step 5: 提交**

```bash
git add web/src/components/builder/
git commit -m "feat(web): 构建器画布——受控 React Flow 编辑接线/自定义节点/dagre 自动布局"
```

---

### Task 13: NodePanel——节点/边配置面板

**Files:**
- Create: `web/src/components/builder/NodePanel.tsx`

- [ ] **Step 1: 实现**

```tsx
// 选中对象配置面板：节点（label/起点/join/组件引用/inputs 映射/覆盖参数/outputs）
// 或边（guard 选择）。组件引用从库清单选择；inputs 生产者支持下拉建议
// （上游任务名 / {spec.字段} / 原始 token）。
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { fieldCls, labelCls } from "../dialogTheme";
import {
  NODE_REF_FIELD, type BuilderDraft, type BuilderNode, type LibraryIndex,
} from "../../api";
import type { Selection } from "./EditableCanvas";

interface Props {
  draft: BuilderDraft;
  library: LibraryIndex | null;
  selected: Selection;
  onChange: (fn: (d: BuilderDraft) => BuilderDraft) => void;
}

const SPEC_TYPES = ["str", "int", "float", "bool", "list", "dict", "any"] as const;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b px-3 py-2.5 last:border-b-0">
      <div className="mb-1.5 text-[11px] font-semibold text-muted-foreground">{title}</div>
      {children}
    </div>
  );
}

function InputsEditor({ node, draft, onChange }: {
  node: BuilderNode; draft: BuilderDraft;
  onChange: (inputs: Record<string, string>) => void;
}) {
  const upstream = draft.nodes
    .filter((n) => n.id !== node.id)
    .map((n) => n.label);
  const specFields = draft.spec_schema.map((f) => `{spec.${f.field}}`);
  const suggestions = [...upstream, ...specFields, "{spec}", "{tasklist}", "{node}"];
  const entries = Object.entries(node.inputs);
  const listId = `inputs-sug-${node.id}`;
  return (
    <datalist-independent>
      <datalist id={listId}>
        {suggestions.map((s) => <option key={s} value={s} />)}
      </datalist>
      <div className="flex flex-col gap-1">
        {entries.map(([k, v]) => (
          <div key={k} className="flex items-center gap-1">
            <Input value={k} disabled className="w-24 font-mono text-[12px]" />
            <span className="text-[11px] text-muted-foreground">←</span>
            <Input value={v} list={listId} className="flex-1 font-mono text-[12px]"
                   onChange={(e) => onChange({ ...node.inputs, [k]: e.target.value })} />
            <Button variant="ghost" size="icon" title="删除"
                    onClick={() => { const next = { ...node.inputs }; delete next[k]; onChange(next); }}>×</Button>
          </div>
        ))}
        <NewInputRow onAdd={(k) => onChange({ ...node.inputs, [k]: "" })} />
      </div>
    </datalist-independent>
  );
}

function NewInputRow({ onAdd }: { onAdd: (k: string) => void }) {
  const [k, setK] = useState("");
  return (
    <div className="flex items-center gap-1">
      <Input value={k} placeholder="输入字段名" onChange={(e) => setK(e.target.value)}
             className="w-24 font-mono text-[12px]" />
      <Button variant="outline" size="sm" disabled={!k}
              onClick={() => { onAdd(k); setK(""); }}>添加输入</Button>
    </div>
  );
}

/** harness 覆盖参数（常用两项类型化 + 其余 JSON） */
function OverridesEditor({ node, onChange }: {
  node: BuilderNode; onChange: (patch: Record<string, unknown> | undefined) => void;
}) {
  const ov = (node.overrides ?? {}) as Record<string, unknown>;
  const set = (k: string, v: unknown) => {
    const next = { ...ov, [k]: v };
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div>
        <div className="mb-0.5 text-[11px] text-muted-foreground">model（覆盖库值，空=不覆盖）</div>
        <Input value={String(ov.model ?? "")} className="font-mono text-[12px]"
               onChange={(e) => set("model", e.target.value || undefined)} />
      </div>
      <div>
        <div className="mb-0.5 text-[11px] text-muted-foreground">temperature（空=不覆盖）</div>
        <Input value={ov.temperature === undefined ? "" : String(ov.temperature)}
               className="font-mono text-[12px]" placeholder="0.3"
               onChange={(e) => set("temperature", e.target.value === "" ? undefined : Number(e.target.value))} />
      </div>
      <div>
        <div className="mb-0.5 text-[11px] text-muted-foreground">其余覆盖（JSON：promptmode/prompt/outputformat/notdo/…，空=无）</div>
        <textarea
          className={`w-full rounded-control border border-input bg-transparent px-2 py-1 font-mono text-[12px]`}
          rows={2}
          value={JSON.stringify(
            Object.fromEntries(Object.entries(ov).filter(([k]) => !["model", "temperature"].includes(k))),
            null, 0)}
          onChange={(e) => {
            try {
              const parsed = JSON.parse(e.target.value || "{}");
              onChange({ ...parsed, ...(ov.model ? { model: ov.model } : {}), ...(ov.temperature !== undefined ? { temperature: ov.temperature } : {}) });
            } catch { /* 非法 JSON 编辑中：不打断输入 */ }
          }}
        />
      </div>
    </div>
  );
}

function NodePanelInner({ node, draft, library, onChange, onSelect }: {
  node: BuilderNode; draft: BuilderDraft; library: LibraryIndex | null;
  onChange: Props["onChange"]; onSelect: Props["onChange"] extends never ? never : (s: Selection) => void;
}) {
  const patch = (p: Partial<BuilderNode>) =>
    onChange((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === node.id ? { ...n, ...p } : n)) }));
  const refField = NODE_REF_FIELD[node.type];
  const options: string[] =
    node.type === "harness" ? library?.harnesses ?? [] :
    node.type === "script" ? library?.scripts ?? [] :
    node.type === "command" ? library?.commands ?? [] :
    library?.submodules.map((s) => s.name) ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <Section title="任务名（Flow 引用名，标识符）">
        <Input value={node.label} className="font-mono"
               onChange={(e) => patch({ label: e.target.value.replace(/\s/g, "_") })} />
      </Section>
      <Section title="组件引用（从组件库选择）">
        <select className={fieldCls} value={String(node[refField] ?? "")}
                onChange={(e) => patch({ [refField]: e.target.value } as Partial<BuilderNode>)}>
          <option value="">（选择 {node.type}）</option>
          {options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        <div className="mt-1 text-[11px] text-muted-foreground">
          缺组件？先到左侧组件库{node.type === "script" ? "上传" : "新建"}。
        </div>
      </Section>
      <Section title="流转">
        <div className="flex items-center gap-3 text-[12px]">
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={node.is_start} onChange={(e) => patch({ is_start: e.target.checked })} />
            起点节点
          </label>
          <label className="flex items-center gap-1">
            join
            <select className="rounded-control border border-input bg-transparent px-1 py-0.5"
                    value={node.join} onChange={(e) => patch({ join: e.target.value as "AND" | "OR" })}>
              <option value="AND">AND</option>
              <option value="OR">OR</option>
            </select>
          </label>
        </div>
      </Section>
      <Section title="inputs 映射（字段 ← 上游节点 / {spec.字段} / token）">
        <InputsEditor node={node} draft={draft}
                      onChange={(inputs) => patch({ inputs })} />
      </Section>
      {node.type === "harness" && (
        <Section title="LLM 覆盖参数（留空 = 用库组件值）">
          <OverridesEditor node={node}
                           onChange={(o) => patch({ overrides: o && Object.keys(o).length ? o : undefined })} />
        </Section>
      )}
      {node.type === "command" && (
        <Section title="command 覆盖（留空 = 用库组件值）">
          <div className="flex flex-col gap-1.5">
            <div>
              <div className="mb-0.5 text-[11px] text-muted-foreground">timeout（秒）</div>
              <Input value={node.overrides?.timeout === undefined ? "" : String(node.overrides.timeout)}
                     className="font-mono text-[12px]"
                     onChange={(e) => patch({ overrides: e.target.value === "" ? undefined : { ...node.overrides, timeout: Number(e.target.value) } })} />
            </div>
            <div>
              <div className="mb-0.5 text-[11px] text-muted-foreground">cwd</div>
              <Input value={String(node.overrides?.cwd ?? "")} className="font-mono text-[12px]"
                     onChange={(e) => patch({ overrides: e.target.value === "" ? undefined : { ...node.overrides, cwd: e.target.value } })} />
            </div>
          </div>
        </Section>
      )}
      {node.type === "submodule" && (
        <Section title="outputs 映射（本节点字段 ← 子输出字段，空=全量透出）">
          <div className="flex flex-col gap-1">
            {Object.entries(node.outputs ?? {}).map(([k, v]) => (
              <div key={k} className="flex items-center gap-1">
                <Input value={k} disabled className="w-24 font-mono text-[12px]" />
                <span className="text-[11px] text-muted-foreground">←</span>
                <Input value={v} className="flex-1 font-mono text-[12px]"
                       onChange={(e) => patch({ outputs: { ...node.outputs, [k]: e.target.value } })} />
                <Button variant="ghost" size="icon" onClick={() => {
                  const next = { ...node.outputs }; delete next[k]; patch({ outputs: next });
                }}>×</Button>
              </div>
            ))}
            <Button variant="outline" size="sm" className="self-start"
                    onClick={() => patch({ outputs: { ...node.outputs, [""]: "" } })}>
              添加映射
            </Button>
          </div>
        </Section>
      )}
      <Section title="危险操作">
        <Button variant="destructive" size="sm"
                onClick={() => {
                  onChange((d) => ({
                    ...d,
                    nodes: d.nodes.filter((n) => n.id !== node.id),
                    edges: d.edges.filter((e) => e.from !== node.id && e.to !== node.id),
                  }));
                  onSelect(null);
                }}>
          删除节点
        </Button>
      </Section>
    </div>
  );
}

function EdgePanelInner({ edge, draft, library, onChange, onSelect }: {
  edge: BuilderEdge; draft: BuilderDraft; library: LibraryIndex | null;
  onChange: Props["onChange"]; onSelect: (s: Selection) => void;
}) {
  const from = draft.nodes.find((n) => n.id === edge.from)?.label ?? edge.from;
  const to = draft.nodes.find((n) => n.id === edge.to)?.label ?? edge.to;
  const patch = (p: Partial<BuilderEdge>) =>
    onChange((d) => ({ ...d, edges: d.edges.map((e) => (e.id === edge.id ? { ...e, ...p } : e)) }));
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <Section title={`边：${from} → ${to}`}>
        <div className={labelCls}>guard 条件（guards 库；无 = 无条件边）</div>
        <select className={fieldCls} value={edge.guard ?? ""}
                onChange={(e) => patch({ guard: e.target.value || null })}>
          <option value="">（无条件）</option>
          {(library?.guards ?? []).map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <div className="mt-1 text-[11px] text-muted-foreground">
          XOR 分支（同一节点 ≥2 条带 guard 出边）汇入同一下游须把该下游 join 设为 OR。
        </div>
      </Section>
      <Section title="操作">
        <Button variant="destructive" size="sm"
                onClick={() => {
                  onChange((d) => ({ ...d, edges: d.edges.filter((e) => e.id !== edge.id) }));
                  onSelect(null);
                }}>
          删除边
        </Button>
      </Section>
    </div>
  );
}

export function NodePanel({ draft, library, selected, onChange, onSelect }: Props & { onSelect: (s: Selection) => void }) {
  if (!selected) {
    return (
      <div className="flex-1 p-3 text-[12px] leading-5 text-muted-foreground">
        点选节点/边编辑配置；拖节点间连线加边；Delete 删除选中。
      </div>
    );
  }
  const node = draft.nodes.find((n) => n.id === selected.id);
  if (selected.kind === "node" && node) {
    return <NodePanelInner node={node} draft={draft} library={library} onChange={onChange} onSelect={onSelect} />;
  }
  const edge = draft.edges.find((e) => e.id === selected.id);
  if (selected.kind === "edge" && edge) {
    return <EdgePanelInner edge={edge} draft={draft} library={library} onChange={onChange} onSelect={onSelect} />;
  }
  return <div className="flex-1 p-3 text-[12px] text-muted-foreground">选中对象已不存在。</div>;
}
```

注意两处修正执行时落实：① `InputsEditor` 里 `datalist-independent` 是笔误占位——直接返回 fragment（`<>...</>`）包 datalist 与行编辑器；② `NewInputRow` 需要 `import { useState } from "react"`。文件顶部 import 补 `import { useState } from "react"`。

- [ ] **Step 2: 类型门禁**

Run: `cd web && npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 3: 提交**

```bash
git add web/src/components/builder/NodePanel.tsx
git commit -m "feat(web): 构建器配置面板——节点(label/起点/join/引用/inputs/覆盖/outputs)+边(guard)"
```

---

### Task 14: ModuleBuilder 主组件（工具条/自动保存/校验安装/DSL 预览）+ 添加节点

**Files:**
- Modify: `web/src/components/builder/ModuleBuilder.tsx`（替换 Task 10 占位）

- [ ] **Step 1: 实现**

```tsx
// 模块创建器主区：顶栏（元数据/Spec/自动布局/添加节点/校验/安装）+ 编辑画布 +
// 右侧配置面板 + 底部 tasklist 预览（validate 返回的服务端生成结果）。
// 草稿自动保存：变更置脏 → 800ms 防抖 PUT；校验/安装前先显式保存。
import { useCallback, useEffect, useRef, useState } from "react";
import { Download, GitMerge, LayoutGrid, Save, ShieldCheck, Table2 } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SpecForm } from "../SpecForm";
import { errTextCls, fieldCls, labelCls, okTextCls, overlayCls, panelCls } from "../dialogTheme";
import {
  emptyDraft, fetchDraft, fetchLibrary, genId, installPack, putDraft, validatePack,
  type BuilderDraft, type BuilderNode, type LibraryIndex, type ModuleDetail,
  type SpecField, type SpecTypeName, type ValidatePackResult,
} from "../../api";
import { EditableCanvas, relayout, type Selection } from "./EditableCanvas";
import { NodePanel } from "./NodePanel";

interface Props {
  name: string;
  onInstalled: (moduleName: string) => void;
}

const ADD_TYPES: { type: BuilderNode["type"]; label: string }[] = [
  { type: "harness", label: "LLM 节点" },
  { type: "script", label: "Script 节点" },
  { type: "command", label: "Command 节点" },
  { type: "submodule", label: "子模块节点" },
];

export function ModuleBuilder({ name, onInstalled }: Props) {
  const [draft, setDraft] = useState<BuilderDraft | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [library, setLibrary] = useState<LibraryIndex | null>(null);
  const [selected, setSelected] = useState<Selection>(null);
  const [saveState, setSaveState] = useState<"clean" | "dirty" | "saving" | "error">("clean");
  const [checkResult, setCheckResult] = useState<ValidatePackResult | null>(null);
  const [checkErrors, setCheckErrors] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [metaOpen, setMetaOpen] = useState(false);
  const [specOpen, setSpecOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [installed, setInstalled] = useState<ModuleDetail | null>(null);
  const saveTimer = useRef<number | null>(null);
  const draftRef = useRef<BuilderDraft | null>(null);
  draftRef.current = draft;

  useEffect(() => {
    fetchDraft(name).then(setDraft).catch((e) => setLoadErr(e instanceof Error ? e.message : String(e)));
    fetchLibrary().then(setLibrary).catch(() => {});
  }, [name]);

  const onChange = useCallback((fn: (d: BuilderDraft) => BuilderDraft) => {
    setDraft((prev) => prev && fn(prev));
    setSaveState("dirty");
    setCheckResult(null);
    setCheckErrors(null);
  }, []);

  // 自动保存（防抖）：dirty → 800ms 后 PUT
  useEffect(() => {
    if (saveState !== "dirty" || !draft) return;
    saveTimer.current = window.setTimeout(async () => {
      setSaveState("saving");
      try {
        await putDraft(draft);
        setSaveState("clean");
      } catch {
        setSaveState("error");
      }
    }, 800);
    return () => { if (saveTimer.current) window.clearTimeout(saveTimer.current); };
  }, [draft, saveState]);

  const saveNow = useCallback(async () => {
    if (!draftRef.current) return;
    setSaveState("saving");
    try {
      await putDraft(draftRef.current);
      setSaveState("clean");
    } catch {
      setSaveState("error");
      throw new Error("草稿保存失败");
    }
  }, []);

  const runCheck = useCallback(async (install: boolean) => {
    setBusy(true);
    setCheckErrors(null);
    setCheckResult(null);
    try {
      await saveNow();
      if (install) {
        const detail = await installPack(name);
        setInstalled(detail);
      } else {
        setCheckResult(await validatePack(name));
      }
    } catch (e) {
      setCheckErrors([e instanceof Error ? e.message : String(e)]);
    } finally {
      setBusy(false);
    }
  }, [name, saveNow]);

  const addNode = useCallback((type: BuilderNode["type"]) => {
    const refPool =
      type === "harness" ? library?.harnesses ?? [] :
      type === "script" ? library?.scripts ?? [] :
      type === "command" ? library?.commands ?? [] :
      library?.submodules.map((s) => s.name) ?? [];
    const ref = refPool[0] ?? "";
    if (!ref) {
      setCheckErrors([`组件库暂无 ${type} 组件——先到左侧组件库${type === "script" ? "上传" : "新建"}。`]);
      setAddOpen(false);
      return;
    }
    const node: BuilderNode = {
      id: genId("n"),
      label: `${ref}_${draftRef.current?.nodes.length ?? 0}`,
      type,
      is_start: draftRef.current?.nodes.length === 0,
      join: "AND",
      position: { x: 60 + (draftRef.current?.nodes.length ?? 0) * 30, y: 60 + (draftRef.current?.nodes.length ?? 0) * 30 },
      inputs: {},
      [type]: ref,
    };
    onChange((d) => ({ ...d, nodes: [...d.nodes, node] }));
    setAddOpen(false);
    setSelected({ kind: "node", id: node.id });
  }, [library, onChange]);

  if (loadErr) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <div className={errTextCls}>草稿加载失败：{loadErr}</div>
        <Button variant="outline" size="sm" onClick={() => { setLoadErr(null); fetchDraft(name).then(setDraft).catch((e) => setLoadErr(String(e))); }}>重试</Button>
      </div>
    );
  }
  if (!draft) {
    return <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">加载草稿…</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶栏 */}
      <header className="flex h-11 shrink-0 items-center gap-1.5 border-b px-3">
        <span className="max-w-[200px] truncate text-[13px] font-semibold" title={draft.meta.name}>{draft.meta.name}</span>
        <span className={`text-[11px] ${saveState === "error" ? errTextCls : "text-muted-foreground"}`}>
          {saveState === "clean" && "已保存"}
          {saveState === "dirty" && "编辑中…"}
          {saveState === "saving" && "保存中…"}
          {saveState === "error" && "保存失败"}
        </span>
        <Button variant="ghost" size="sm" onClick={() => setMetaOpen(true)}>元数据</Button>
        <Button variant="ghost" size="sm" onClick={() => setSpecOpen(true)}>Spec</Button>
        <div className="mx-1 h-5 w-px bg-border" />
        <select className="rounded-control border border-input bg-transparent px-1.5 py-1 text-[12px]"
                value="" disabled={addOpen} onChange={(e) => e.target.value && addNode(e.target.value as BuilderNode["type"])}>
          <option value="">+ 添加节点…</option>
          {ADD_TYPES.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
        </select>
        <Button variant="ghost" size="sm" title="dagre 自动布局"
                onClick={() => onChange((d) => relayout(d))}>
          <LayoutGrid className="h-3.5 w-3.5" />
        </Button>
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => runCheck(false)}>
            <ShieldCheck className="h-3.5 w-3.5" />校验
          </Button>
          <Button size="sm" disabled={busy} onClick={() => runCheck(true)}>
            <Download className="h-3.5 w-3.5" />安装进 store
          </Button>
        </div>
      </header>

      {/* 主体：画布 + 配置面板 */}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <EditableCanvas draft={draft} selected={selected} onSelect={setSelected} onChange={onChange} />
        </div>
        <aside className="flex w-72 shrink-0 flex-col overflow-auto border-l bg-sidebar">
          <NodePanel draft={draft} library={library} selected={selected}
                     onChange={onChange} onSelect={setSelected} />
        </aside>
      </div>

      {/* 校验结果 / tasklist 预览 */}
      {(checkErrors || checkResult) && (
        <div className="max-h-44 shrink-0 overflow-auto border-t bg-muted/40 px-3 py-2">
          {checkErrors && checkErrors.map((m, i) => (
            <div key={i} className={errTextCls}>✗ {m}</div>
          ))}
          {checkResult && (
            <>
              <div className={`${okTextCls} mb-1`}>✓ 校验通过（Pack 语义：module.json + 引用完整性）</div>
              <div className="mb-1 font-mono text-[11px] text-muted-foreground">Flow</div>
              <pre className="whitespace-pre-wrap font-mono text-[12px]">{checkResult.tasklist.Flow || "（单节点无边）"}</pre>
              <div className="mb-1 mt-2 flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
                <Table2 className="h-3 w-3" />Tasks
              </div>
              <pre className="whitespace-pre-wrap font-mono text-[12px]">{JSON.stringify(checkResult.tasklist.Tasks, null, 2)}</pre>
            </>
          )}
        </div>
      )}

      {installed && (
        <div className={overlayCls} onClick={() => setInstalled(null)}>
          <div className={panelCls} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-1.5 text-[13px] font-semibold">
              <GitMerge className="h-4 w-4 text-emerald-500" />安装成功：{installed.name}
            </div>
            <div className="text-[12px] text-muted-foreground">
              已装入 store（{installed.kind}）。可在模块库发起运行。
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setInstalled(null)}>留在创建器</Button>
              <Button size="sm" onClick={() => onInstalled(installed.name)}>去模块库试运行</Button>
            </div>
          </div>
        </div>
      )}

      {metaOpen && (
        <MetaDialog draft={draft} onClose={() => setMetaOpen(false)}
                    onSave={(meta) => { onChange((d) => ({ ...d, meta })); setMetaOpen(false); }} />
      )}
      {specOpen && (
        <SpecDialog draft={draft} onClose={() => setSpecOpen(false)}
                    onSave={(spec_schema, default_spec) => {
                      onChange((d) => ({ ...d, spec_schema, default_spec }));
                      setSpecOpen(false);
                    }} />
      )}
    </div>
  );
}

function MetaDialog({ draft, onClose, onSave }: {
  draft: BuilderDraft; onClose: () => void;
  onSave: (meta: BuilderDraft["meta"]) => void;
}) {
  const [meta, setMeta] = useState(draft.meta);
  const [err, setErr] = useState<string | null>(null);
  const save = () => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(meta.name)) { setErr("模块名须为 Python 标识符"); return; }
    onSave(meta);
  };
  return (
    <div className={overlayCls} onClick={onClose}>
      <div className={panelCls} onClick={(e) => e.stopPropagation()}>
        <div className="text-[13px] font-semibold">模块元数据</div>
        <div>
          <div className={labelCls}>名称（包名/选择器，创建后建议不改——改名等于换草稿）</div>
          <Input value={meta.name} onChange={(e) => setMeta({ ...meta, name: e.target.value })} className="font-mono" />
        </div>
        <div>
          <div className={labelCls}>版本</div>
          <Input value={meta.version} onChange={(e) => setMeta({ ...meta, version: e.target.value })} className="font-mono" />
        </div>
        <div>
          <div className={labelCls}>描述</div>
          <Input value={meta.description} onChange={(e) => setMeta({ ...meta, description: e.target.value })} />
        </div>
        {err && <div className={errTextCls}>{err}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" onClick={save}>保存</Button>
        </div>
      </div>
    </div>
  );
}

const SPEC_TYPES: SpecTypeName[] = ["str", "int", "float", "bool", "list", "dict", "any"];

function SpecDialog({ draft, onClose, onSave }: {
  draft: BuilderDraft; onClose: () => void;
  onSave: (schema: SpecField[], defaultSpec: Record<string, unknown>) => void;
}) {
  const [schema, setSchema] = useState<SpecField[]>(draft.spec_schema);
  const [defaultSpec, setDefaultSpec] = useState<Record<string, unknown>>(draft.default_spec);
  const schemaObj = Object.fromEntries(schema.map((f) => [f.field, f.type]));
  const addField = () => setSchema((s) => [...s, { field: `field_${s.length + 1}`, type: "str" }]);
  return (
    <div className={overlayCls} onClick={onClose}>
      <div className={panelCls} onClick={(e) => e.stopPropagation()}>
        <div className="text-[13px] font-semibold">spec_schema 与参考 spec</div>
        <div>
          <div className={labelCls}>输入字段（{`type ∈ ${SPEC_TYPES.join("/")}`}）</div>
          <div className="flex flex-col gap-1">
            {schema.map((f, i) => (
              <div key={i} className="flex items-center gap-1">
                <Input value={f.field} className="w-40 font-mono text-[12px]"
                       onChange={(e) => setSchema((s) => s.map((x, j) => (j === i ? { ...x, field: e.target.value.replace(/\s/g, "_") } : x)))} />
                <select className={fieldCls} value={f.type}
                        onChange={(e) => setSchema((s) => s.map((x, j) => (j === i ? { ...x, type: e.target.value as SpecTypeName } : x)))}>
                  {SPEC_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <Button variant="ghost" size="icon" onClick={() => setSchema((s) => s.filter((_, j) => j !== i))}>×</Button>
              </div>
            ))}
            <Button variant="outline" size="sm" className="self-start" onClick={addField}>添加字段</Button>
          </div>
        </div>
        <div>
          <div className={labelCls}>default_spec（参考值；inputs 里用 {"{spec.字段}"} 引用）</div>
          <SpecForm
            key={`builder-spec:${schema.map((f) => `${f.field}:${f.type}`).join(",")}`}
            schema={schemaObj}
            defaultSpec={defaultSpec}
            onChange={(spec) => setDefaultSpec(spec ?? {})}
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" onClick={() => onSave(schema, defaultSpec)}>保存</Button>
        </div>
      </div>
    </div>
  );
}
```

注：`SpecForm` 的 props 形状以实际文件为准（`schema: Record<string, string>`、`defaultSpec`、`onChange(spec, touched)`——实施时对照 `SpecForm.tsx` 头注释调整参数名）；`SpecForm` 若不导出在 `components/SpecForm.tsx` 顶层（默认导出等），按实际导出修正 import。

- [ ] **Step 2: 类型门禁**

Run: `cd web && npm run build`
Expected: 构建成功

- [ ] **Step 3: 手工端到端验收（spec 验收标准）**

前置：`uv run uvicorn server.app:app --port 8000` + `cd web && npm run dev`。

1. 组件库：新建 harness（prompt_core 填写）→ 保存；上传 script `echo.py`（内容 `def echo(view):\n    return {"message": view.field("data")}`）；上传 guard `has_issues.py`（`def has_issues(view):\n    return True`）。
2. 新建模块草稿 `demo_mod` → 添加 script 节点（引用 echo，起点）→ 添加第二个 script 节点 → 连线（第二条边设 guard has_issues，下游 join 改 OR）→ Spec 加字段 → 校验（看 Flow DSL 预览）→ 安装。
3. 「去模块库试运行」→ 用参考 spec 发起 mock 运行 → RunView 出图跑通。
4. 校验失败路径：删掉库里的 script 再校验 → 400 错误透出。
5. 刷新页面 → 重开草稿 → 画布布局与配置保持。

Expected: 全链路成功，无控制台报错

- [ ] **Step 4: 全量回归**

Run: `uv run pytest tests/ -q`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add web/src/components/builder/ModuleBuilder.tsx
git commit -m "feat(web): 模块创建器主区——工具条/防抖自动保存/校验安装/tasklist预览/添加节点"
```

---

### Task 15: 文档收口（roadmap / AGENTS / api.md / finish.md）

**Files:**
- Modify: `roadmap/roadmap.md`
- Modify: `AGENTS.md`
- Modify: `../SpecModule/docs/references/api.md`（库仓库，独立提交）
- Modify: `roadmap/finish.md`

- [ ] **Step 1: roadmap.md 功能路线图加阶段**

「### TreeChat 后续」节前插入：

```markdown
### 模块构建器 —— 组件库 + 可视化创建 packed 模块（2026-09-25 立项）

设计定稿：[specs/2026-09-25-module-builder-design.md](../docs/superpowers/specs/2026-09-25-module-builder-design.md)

- [ ] 组件库 CRUD（harness/command 表单化、scripts/guards 上传、submodule 索引）
- [ ] 模块草稿 + 画布创建器（React Flow 编辑态：节点/边/guard/join/inputs 映射）
- [ ] 组装安装闭环（拷贝进包 → validate_pack_dir → install_pack → 试运行）
- [ ] 后排：编辑/反解已安装模块、output 侧 spec_schema、库版本管理
```

- [ ] **Step 2: AGENTS.md 同步**

「Key Directories」`server/` 条目追加 `build.py`（组件库/草稿/pack 组装安装）；`web/` 条目 components 清单追加 `LibraryPanel`、`library/`、`builder/`；端点映射表追加两行：

```markdown
| `GET /api/library` + `PUT/DELETE/GET /api/library/{kind}/{name}` | `store.store_home()/library/` 目录操作 + `HarnessConfig/CommandConfig.from_dict` 实例化验形 | kind ∈ harnesses/commands/scripts/guards/submodules/drafts；code 类仅 UTF-8 .py（stem=注册名）；`GET /library` 分组清单 |
| `POST /api/modules/packs[/validate]` | `draft_to_tasklist`（本层唯一实现）→ 组装临时 pack → `store.validate_pack_dir` → `store.install_pack(source="webview-builder")` | body `{draft}`；200 详情/校验结果（附生成的 tasklist）；400 校验/组件缺失；409 同名已存在（防遮蔽） |
```

- [ ] **Step 3: 库仓库 api.md 补录（独立提交）**

检查 `../SpecModule/docs/references/api.md` 是否已收录 `store_home` / `validate_pack_dir` / `install_pack` / `resolve_module`；缺什么补什么（函数签名 + 一句话语义 + 「webview 构建器消费」出处），不重排既有内容。库仓库提交：

```bash
cd ../SpecModule
git add docs/references/api.md
git commit -m "docs: api.md 补录 store 写端三函数（webview 模块构建器消费增量）"
```

- [ ] **Step 4: 全量验证**

Run: `uv run pytest tests/ -q && cd web && npm run build`
Expected: pytest 全绿 + 构建成功

- [ ] **Step 5: finish.md 归档 + 本仓库提交**

`roadmap/finish.md` 末尾追加落地记录（日期 2026-09-25、构建器一句话定位、组件库/创建器/组装安装三块要点、测试与验收结论）。提交：

```bash
git add roadmap/roadmap.md roadmap/finish.md AGENTS.md
git commit -m "docs: 模块构建器落地——roadmap 阶段立项/完成归档/AGENTS 端点表同步"
```

---

## Self-Review 记录

- **Spec 覆盖**：组件库（Task 1-4）、草稿（5）、DSL 生成（6）、dry-run+安装（7-8）、api 封装（9）、壳层（10）、库面板（11）、画布（12）、配置面板（13）、主组件与校验安装闭环+端到端（14）、文档（15）——spec 各节均有对应任务；错误契约（400/404/409）散布在对应端点任务并各有测试锚定。
- **占位扫描**：Task 13 的 `datalist-independent` 笔误与 `useState` import 已在任务内显式标注修正；Task 12 的 MiniMap 宽高备注为实施核对项而非占位；无 TBD/TODO。
- **类型一致性**：`BuilderDraft/BuilderNode/BuilderEdge/Selection/genId/NODE_REF_FIELD` 在 Task 9 定义、Task 12-14 消费一致；`draft_to_tasklist`（Task 6）与 `_assemble_pack`（Task 7）签名一致；端点路径前后端一致（`/api/library/{kind}/{name}`、`/api/modules/packs[/validate]`）。
