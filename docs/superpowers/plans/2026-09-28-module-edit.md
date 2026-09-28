# 已安装模块编辑（反解 → 画布 → 装回）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** packed 模块可从模块详情一键反解为构建器草稿（图/spec/元数据还原画布），编辑后同名覆盖更新（库 `apply_update`）或改名另装。

**Architecture:** 两个新后端端点（`POST /api/modules/{name}/decompile` 反解落草稿 + 组件导入报告；`POST /api/modules/packs/update` 组装→校验→apply_update）。图反解零自研——走 `query.build_run_graph` 的 tasklist 直渲染通道 + `query.graph_to_dict`（实测 join 返回大写 AND/OR，与草稿模型一致；`{spec.x}` 常量 inputs 无 spec 建图不炸）。前端：ModuleDetail 编辑按钮 + 反解报告面板，ModuleBuilder 自动布局 + 「更新模块」按钮。spec 定稿：`docs/superpowers/specs/2026-09-28-module-edit-design.md`。

**Tech Stack:** FastAPI + pytest/httpx TestClient（后端）；Vite + React + TS（前端，`npm run build` = tsc 门禁）；库共享层 `module_harness.store/query`（零上游代码改动）。

**基线状态（计划编写时已验证）:** 工作区有 5 个未提交文件（在途的构建器打磨，见 Task 1）；`uv run pytest tests/ -q --ignore=tests/treechat` 148 passed；`cd web && npm run build` 绿。

---

### Task 1: 提交在途的构建器打磨改动（前置清理）

工作区现有未提交改动（AddNodeDialog + useFormDraft 表单草稿恢复 + 组件库变更广播）是上一个会话的完整工作单元，门禁已验证绿。先独立提交，后续任务的提交才不会被混入。

**Files:**
- Modify: `web/src/api.ts`、`web/src/components/LibraryPanel.tsx`、`web/src/components/builder/ModuleBuilder.tsx`、`web/src/components/library/ComponentForms.tsx`
- Create: `web/src/lib/formDraft.ts`

- [x] **Step 1: 确认改动范围与门禁**

```bash
cd "C:\Users\xingy\Desktop\开发\SpecModule_webview"
git status --short   # 应只有下列 5 项，无其他意外文件
cd web && npm run build   # 期望 tsc 无错 + vite 构建成功
```

- [x] **Step 2: 提交**

```bash
cd "C:\Users\xingy\Desktop\开发\SpecModule_webview"
git add web/src/api.ts web/src/components/LibraryPanel.tsx web/src/components/builder/ModuleBuilder.tsx web/src/components/library/ComponentForms.tsx web/src/lib/formDraft.ts
git commit -m "feat(web): 构建器添加节点对话框 + 表单在途草稿恢复（useFormDraft）+ 组件库变更广播"
```

---

### Task 2: 后端——spec_schema output 侧透传（`_validate_draft` + `_assemble_pack` 小改）

反解需要把已装包 manifest 的 `spec_schema.output`（外部 pack 可能有）经草稿透传到更新后的包，防静默丢失。草稿加可选 `spec_schema_output` 字段：UI 不编辑，组装时原样写回 manifest。

**Files:**
- Modify: `server/api/build.py:90-144`（`_validate_draft`）、`server/api/build.py:395-409`（`_assemble_pack` 的 manifest 构造）
- Test: `tests/test_build_api.py`

- [x] **Step 1: 写失败测试（加在 `TestValidatePack` 类之后，文件尾部新类 `TestSchemaOutputPassthrough`）**

```python
class TestSchemaOutputPassthrough:
    """spec_schema.output 透传：外部 pack 的 output 侧经草稿往返不丢。"""

    def test_output_side_roundtrip_via_validate(self, client, base):
        seed_builder(client)
        draft = client.get("/api/library/drafts/loop_mod").json()
        draft["spec_schema_output"] = {"summary": "str"}
        assert client.put("/api/library/drafts/loop_mod", json=draft).status_code == 200
        r = client.post("/api/modules/packs/validate", json={"draft": "loop_mod"})
        assert r.status_code == 200
        assert r.json()["manifest"]["spec_schema"]["output"] == {"summary": "str"}

    def test_output_side_non_dict_400(self, client, base):
        seed_builder(client)
        draft = client.get("/api/library/drafts/loop_mod").json()
        draft["spec_schema_output"] = "oops"
        r = client.put("/api/library/drafts/loop_mod", json=draft)
        assert r.status_code == 400 and "spec_schema_output" in r.json()["error"]

    def test_no_output_side_unchanged(self, client, base):
        """无透传字段的草稿 manifest 形状不变（向后兼容）。"""
        seed_builder(client)
        r = client.post("/api/modules/packs/validate", json={"draft": "loop_mod"})
        assert r.json()["manifest"]["spec_schema"] == {"input": {"raw_text": "str"}}
```

- [x] **Step 2: 跑测试确认失败**

```bash
cd "C:\Users\xingy\Desktop\开发\SpecModule_webview"
uv run pytest tests/test_build_api.py::TestSchemaOutputPassthrough -v
```

Expected: `test_output_side_roundtrip_via_validate` FAIL（manifest 无 output 键）、`test_output_side_non_dict_400` FAIL（200 而非 400）、`test_no_output_side_unchanged` PASS（现状行为）。

- [x] **Step 3: 实现——`_validate_draft` 末尾（`return draft` 之前）加：**

```python
    out = draft.get("spec_schema_output")
    if out is not None and not isinstance(out, dict):
        raise _draft_err("spec_schema_output 须为对象（output 侧透传字段）")
```

- [x] **Step 4: 实现——`_assemble_pack` 中 schema/manifest 构造改为（注意：`sub_names = sorted(...)` 行是既有代码，位于 schema 与 manifest 之间，替换时必须保留）：**

```python
        meta = draft["meta"]
        schema = {f["field"]: f["type"] for f in draft.get("spec_schema", [])}
        sub_names = sorted(  # ← 既有行，勿丢
            {n["submodule"] for n in draft["nodes"] if n["type"] == "submodule"})
        spec_schema: dict = {"input": schema}
        if draft.get("spec_schema_output"):
            spec_schema["output"] = draft["spec_schema_output"]
        manifest = {
            "name": meta["name"],
            "version": meta.get("version", "0.1.0"),
            "description": meta.get("description", ""),
            "submodule": False,
            "spec_schema": spec_schema,
            "requires": [],
            "modules": sub_names,
            "tasklist": draft_to_tasklist(draft),
        }
```

- [x] **Step 5: 跑测试确认通过 + 回归**

```bash
uv run pytest tests/test_build_api.py -q
```

Expected: 全部 PASS。

- [x] **Step 6: 提交**

```bash
git add server/api/build.py tests/test_build_api.py
git commit -m "feat(build): 草稿 spec_schema_output 透传——外部 pack 的 output 侧往返不丢"
```

---

### Task 3: 后端——`POST /api/modules/packs/update`（同名覆盖更新）

组装 → `validate_pack_dir` 显式先行（失败 400 零写入）→ `store.apply_update`（库语义：旧包移 `.bak` → 拷入 → 刷 manifest 哈希/source 保留 → 失败自动回滚）。未安装 404、entry 目标 400。

**Files:**
- Modify: `server/api/build.py`（文件尾新增路由）
- Test: `tests/test_build_api.py`

- [ ] **Step 1: 写失败测试（文件尾新类）**

```python
class TestUpdatePack:
    """同名覆盖更新：校验先行 + apply_update；未安装 404；entry 目标 400。"""

    def _install_loop(self, client) -> None:
        seed_builder(client)
        assert client.post("/api/modules/packs", json={"draft": "loop_mod"}).status_code == 200

    def test_update_roundtrip(self, client, base):
        self._install_loop(client)
        draft = client.get("/api/library/drafts/loop_mod").json()
        draft["meta"]["version"] = "0.3.0"
        draft["meta"]["description"] = "更新后的描述"
        assert client.put("/api/library/drafts/loop_mod", json=draft).status_code == 200
        r = client.post("/api/modules/packs/update", json={"draft": "loop_mod"})
        assert r.status_code == 200
        assert r.json()["version"] == "0.3.0"
        manifest = json.loads(
            (base / "home" / "manifests" / "loop_mod.json").read_text(encoding="utf-8"))
        assert manifest["version"] == "0.3.0"
        pkg = json.loads(
            (base / "home" / "modules" / "loop_mod" / "module.json").read_text(encoding="utf-8"))
        assert pkg["description"] == "更新后的描述"

    def test_update_not_installed_404(self, client, base):
        seed_builder(client)  # 只存草稿，未安装
        r = client.post("/api/modules/packs/update", json={"draft": "loop_mod"})
        assert r.status_code == 404 and "未安装" in r.json()["error"]

    def test_update_entry_target_400(self, client, base):
        # mini_graph（entry 形态，tests/modules 夹具）：造同名草稿命中 entry 解析
        draft = draft_json("mini_graph")
        client.put("/api/library/drafts/mini_graph", json=draft)
        r = client.post("/api/modules/packs/update", json={"draft": "mini_graph"})
        assert r.status_code == 400 and "entry" in r.json()["error"]

    def test_update_validate_fail_store_intact(self, client, base):
        """组装校验失败 → 400 且 store 包内容一个字节不动（校验先于任何写入）。"""
        self._install_loop(client)
        pkg = base / "home" / "modules" / "loop_mod" / "module.json"
        before = pkg.read_bytes()
        assert client.delete("/api/library/harnesses/summarize").status_code == 200
        r = client.post("/api/modules/packs/update", json={"draft": "loop_mod"})
        assert r.status_code == 400
        assert pkg.read_bytes() == before
```

注意：`test_update_roundtrip` 直接修改 seed_builder 存的草稿——更新端点不依赖 Task 4 的反解端点，本任务独立可验。

- [ ] **Step 2: 跑测试确认失败**

```bash
uv run pytest tests/test_build_api.py::TestUpdatePack -v
```

Expected: 全部 FAIL（404 Not Found——路由不存在；TestClient 对未知路由返回 404，`test_update_not_installed_404` 可能「假通过」，以其余用例失败为准）。

- [ ] **Step 3: 实现（`server/api/build.py` 文件尾追加）**

```python
# ── 已装模块更新（同名覆盖）───────────────────────────────────────────


@router.post("/modules/packs/update")
def update_pack_route(
    body: dict,
    search: list[Path] = Depends(get_search_paths),
) -> dict:
    """同名覆盖更新已装 packed 模块：组装 → validate_pack_dir（先于任何写入）→
    apply_update（库语义：旧包移 .bak → 拷入 → 刷 manifest，失败自动回滚）。

    未安装 → 404（安装走 POST /api/modules/packs）；entry/pip 目标 → 400
    （pip 同名体不覆盖——避免 store 副本遮蔽 pip 原体）。
    """
    draft = _load_draft_for_assembly(body)
    name = draft["meta"]["name"]
    resolved = store.resolve_module_full(name, search=search)
    if resolved is None:
        raise HTTPException(status_code=404, detail={
            "error": f"模块 '{name}' 未安装——全新安装走 POST /api/modules/packs",
            "module": name})
    if resolved.kind != "packed":
        raise HTTPException(status_code=400, detail={
            "error": f"更新目标 '{name}' 为 {resolved.kind} 形态，仅 packed 可更新",
            "module": name})
    pack = None
    try:
        pack = _assemble_pack(draft, search)
        store.validate_pack_dir(pack)
        store.apply_update(name, pack)
    except (ValueError, TypeError, KeyError) as e:
        raise HTTPException(status_code=400, detail={"error": str(e), "module": name})
    finally:
        if pack is not None:
            shutil.rmtree(pack, ignore_errors=True)
    updated = store.resolve_module_full(name, search=get_search_paths())
    if updated is None:
        raise HTTPException(status_code=500, detail={"error": "更新后详情读取失败", "module": name})
    return store.detail_to_dict(updated)
```

- [ ] **Step 4: 跑测试确认通过 + 回归**

```bash
uv run pytest tests/test_build_api.py -q
```

Expected: 全部 PASS（`test_update_roundtrip` 中的 decompile 行见 Step 1 注意）。

- [ ] **Step 5: 提交**

```bash
git add server/api/build.py tests/test_build_api.py
git commit -m "feat(build): POST /api/modules/packs/update——草稿同名覆盖更新已装 packed 模块（校验先行 + apply_update）"
```

---

### Task 4: 后端——`POST /api/modules/{name}/decompile`（反解为构建器草稿）

已装 packed 模块 → 图结构（库直渲染通道，Flow 零反解析）+ Tasks 原始声明 → 草稿落盘；包内组件语义比对导入组件库（imported/existed/conflicts 三态报告）；submodule 引用不可解析 → warnings。

**Files:**
- Modify: `server/api/build.py`（import 区 + 文件尾新增函数与路由）
- Test: `tests/test_build_api.py`

- [ ] **Step 1: 写失败测试（文件尾新类）**

```python
class TestDecompile:
    """已装 packed 模块反解：图 round-trip + 组件导入三态报告 + output 侧保全。"""

    def _install_loop(self, client) -> None:
        seed_builder(client)
        assert client.post("/api/modules/packs", json={"draft": "loop_mod"}).status_code == 200

    def test_round_trip(self, client, base):
        self._install_loop(client)
        r = client.post("/api/modules/loop_mod/decompile")
        assert r.status_code == 200
        d = r.json()
        assert d["draft"] == "loop_mod"
        # 包内组件与库逐字节同源（copy2 拷入）→ 全部 existed，无冲突无警告
        assert sorted(d["report"]["existed"]) == [
            "guards/has_issues", "harnesses/summarize", "scripts/echo"]
        assert d["report"]["imported"] == [] and d["report"]["conflicts"] == []
        assert d["report"]["warnings"] == []
        draft = client.get("/api/library/drafts/loop_mod").json()
        labels = {n["label"]: n for n in draft["nodes"]}
        assert set(labels) == {"Summarize", "Echo"}
        s = labels["Summarize"]
        assert s["type"] == "harness" and s["harness"] == "summarize"
        assert s["is_start"] is True and s["join"] == "AND"
        assert s["inputs"] == {"text": "{spec.raw_text}"}
        assert s["position"] == {"x": 0, "y": 0}
        e = labels["Echo"]
        assert e["type"] == "script" and e["script"] == "echo"
        assert e["join"] == "OR" and e["is_start"] is False
        assert "overrides" not in e  # 草稿无 overrides 声明 → 不出现该键
        # 边：guard 保留、from/to 指向存在的节点 id
        ids = {n["id"] for n in draft["nodes"]}
        assert len(draft["edges"]) == 2
        assert all(ed["from"] in ids and ed["to"] in ids for ed in draft["edges"])
        assert sorted(ed["guard"] for ed in draft["edges"] if ed["guard"]) == ["has_issues"]
        # spec_schema 反转 + meta 还原
        assert draft["spec_schema"] == [{"field": "raw_text", "type": "str"}]
        assert draft["meta"] == {"name": "loop_mod", "version": "0.2.0", "description": "循环测试"}
        assert draft["default_spec"] == {}  # packed 模块无 default_spec 概念

    def test_import_missing_components(self, client, base):
        """装好后删库组件 → 反解把包内副本重新导入（imported）。"""
        self._install_loop(client)
        for kind, name in [("harnesses", "summarize"), ("scripts", "echo"), ("guards", "has_issues")]:
            assert client.delete(f"/api/library/{kind}/{name}").status_code == 200
        r = client.post("/api/modules/loop_mod/decompile")
        assert r.status_code == 200
        assert sorted(r.json()["report"]["imported"]) == [
            "guards/has_issues", "harnesses/summarize", "scripts/echo"]
        # 导入内容与包内副本一致（回读比对）
        lib = client.get("/api/library/harnesses/summarize").json()
        assert lib["name"] == "summarize"

    def test_conflict_skip_and_report(self, client, base):
        """同名异内容：跳过包内副本沿用库版本，conflicts 报告且库内容未被改写。"""
        self._install_loop(client)
        changed = {"name": "summarize", "prompt_core": "改过的提示词：{text}", "temperature": 0.9}
        assert client.put("/api/library/harnesses/summarize", json=changed).status_code == 200
        r = client.post("/api/modules/loop_mod/decompile")
        assert r.status_code == 200
        assert r.json()["report"]["conflicts"] == ["harnesses/summarize"]
        assert client.get("/api/library/harnesses/summarize").json() == changed

    def test_output_side_preserved(self, client, base):
        """手改包 manifest 加 output 侧 → 反解透传 → 更新后新包仍有 output。"""
        self._install_loop(client)
        pkg = base / "home" / "modules" / "loop_mod" / "module.json"
        manifest = json.loads(pkg.read_text(encoding="utf-8"))
        manifest["spec_schema"]["output"] = {"summary": "str"}
        pkg.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        assert client.post("/api/modules/loop_mod/decompile").status_code == 200
        draft = client.get("/api/library/drafts/loop_mod").json()
        assert draft["spec_schema_output"] == {"summary": "str"}
        assert client.post("/api/modules/packs/update", json={"draft": "loop_mod"}).status_code == 200
        new_manifest = json.loads(pkg.read_text(encoding="utf-8"))
        assert new_manifest["spec_schema"]["output"] == {"summary": "str"}

    def test_unknown_module_404(self, client, base):
        r = client.post("/api/modules/ghost_mod/decompile")
        assert r.status_code == 404

    def test_entry_module_400(self, client, base):
        r = client.post("/api/modules/mini_graph/decompile")
        assert r.status_code == 400 and "entry" in r.json()["error"]
```

- [ ] **Step 2: 跑测试确认失败**

```bash
uv run pytest tests/test_build_api.py::TestDecompile -v
```

Expected: 全部 FAIL（路由不存在 → 404；`test_unknown_module_404` 可能假通过，以其余失败为准）。

- [ ] **Step 3: 实现——import 区（`from module_harness import store` 行）改为：**

```python
from module_harness import query, store
```

- [ ] **Step 4: 实现——`server/api/build.py` 文件尾追加：**

```python
# ── 已装模块反解（编辑闭环入口）───────────────────────────────────────


def _gen_id(prefix: str) -> str:
    """节点/边短随机 id（与前端 genId 同形：前缀_6hex）。"""
    import secrets
    return f"{prefix}_{secrets.token_hex(3)}"


def _component_content_eq(src: Path, dst: Path, kind: str) -> bool:
    """组件内容等价：harness/command 按 JSON 语义比对（parse 后相等），
    scripts/guards 按文本比对；任一侧损坏（非法 JSON/非 UTF-8）→ 不等价。"""
    try:
        if kind in _CFG_CLS:
            return (json.loads(src.read_text(encoding="utf-8"))
                    == json.loads(dst.read_text(encoding="utf-8")))
        return src.read_text(encoding="utf-8") == dst.read_text(encoding="utf-8")
    except (ValueError, UnicodeDecodeError, OSError):
        return False


def _import_pack_component(
    root: Path, pack: Path, kind: str, name: str | None, report: dict,
) -> None:
    """包内组件 → 组件库：缺则写入（imported）；在则内容比对——一致 existed，
    不一致 conflicts（沿用库版本，不覆盖共享资产）。包内缺失 → warnings。"""
    if not name:
        return
    src = pack / kind / f"{name}{_EXT[kind]}"
    if not src.is_file():
        report["warnings"].append(f"包内组件缺失: {kind}/{name}")
        return
    dst = root / kind / f"{name}{_EXT[kind]}"
    if dst.is_file():
        (report["existed"] if _component_content_eq(src, dst, kind)
         else report["conflicts"]).append(f"{kind}/{name}")
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    report["imported"].append(f"{kind}/{name}")


@router.post("/modules/{name}/decompile")
def decompile_module(name: str, search: list[Path] = Depends(get_search_paths)) -> dict:
    """已装 packed 模块 → 构建器草稿（图结构走库直渲染通道，Flow 零反解析）。

    节点 type/引用/inputs/overrides/outputs 取 manifest tasklist 原始声明，
    is_start/join/边取 graph_to_dict；spec_schema.input 反转为草稿字段，
    output 侧存 spec_schema_output 透传。组件导入三态报告；submodule 引用
    不可解析 → warnings（更新组装时会失败，提前透出）。同名草稿覆盖
    （UI 侧 confirm）。entry/pip 形态 → 400；未找到 → 404。
    """
    _check_name(name)
    resolved = store.resolve_module_full(name, search=search)
    if resolved is None:
        raise HTTPException(status_code=404, detail={
            "error": f"模块 '{name}' 未找到", "module": name})
    if resolved.kind != "packed":
        raise HTTPException(status_code=400, detail={
            "error": f"模块 '{name}' 为 {resolved.kind} 形态，仅 packed 可反解编辑",
            "module": name})
    pack = Path(resolved.source.path)
    try:
        manifest = json.loads((pack / "module.json").read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeDecodeError) as e:
        raise HTTPException(status_code=400, detail={
            "error": f"module.json 读取失败: {e}", "module": name})
    tasklist = manifest.get("tasklist")
    if not isinstance(tasklist, dict) or not isinstance(tasklist.get("Tasks"), dict):
        raise HTTPException(status_code=400, detail={
            "error": "manifest 缺少 tasklist.Tasks", "module": name})
    try:
        built = query.build_run_graph(name, tasklist=tasklist, src=resolved.source)
        g = query.graph_to_dict(*built)
    except ValueError as e:
        raise HTTPException(status_code=400, detail={
            "error": f"反解建图失败: {e}", "module": name})

    root = library_root()
    report: dict = {"imported": [], "existed": [], "conflicts": [], "warnings": []}
    tasks: dict = tasklist["Tasks"]
    graph_nodes = {n["id"]: n for n in g["nodes"]}
    id_of: dict[str, str] = {}
    nodes: list[dict] = []
    for label, t in tasks.items():
        if label not in graph_nodes:
            raise HTTPException(status_code=400, detail={
                "error": f"task '{label}' 不在 Flow 图中（tasklist 与 Flow 不一致）",
                "module": name})
        gn = graph_nodes[label]
        if gn["join"] not in ("AND", "OR"):
            raise HTTPException(status_code=400, detail={
                "error": f"节点 {label} 的 join {gn['join']!r} 超出草稿模型（AND/OR）",
                "module": name})
        ntype = t.get("type")
        if ntype not in _NODE_TYPES:
            raise HTTPException(status_code=400, detail={
                "error": f"节点 {label} 类型非法: {ntype!r}", "module": name})
        ref_field = _REF_FIELD[ntype]
        nid = _gen_id("n")
        id_of[label] = nid
        node: dict = {
            "id": nid, "label": label, "type": ntype, ref_field: t.get(ref_field),
            "is_start": bool(gn["is_start"]), "join": gn["join"],
            "position": {"x": 0, "y": 0},
            "inputs": dict(t.get("inputs") or {}),
        }
        if ntype == "submodule":
            if t.get("outputs"):
                node["outputs"] = dict(t["outputs"])
            src = store.resolve_module(t.get(ref_field), search=search)
            if src is None:
                report["warnings"].append(
                    f"submodule '{t.get(ref_field)}' 未安装——更新组装前需先安装或替换引用")
        else:
            overrides = {k: v for k, v in t.items() if k not in ("type", ref_field, "inputs")}
            if overrides:
                node["overrides"] = overrides
            lib_kind = {"harness": "harnesses", "command": "commands", "script": "scripts"}[ntype]
            _import_pack_component(root, pack, lib_kind, t.get(ref_field), report)
        nodes.append(node)
    edges = [
        {"id": _gen_id("e"), "from": id_of[e["from"]], "to": id_of[e["to"]],
         "guard": e.get("guard")}
        for e in g["edges"]
    ]
    for e in g["edges"]:
        if e.get("guard"):
            _import_pack_component(root, pack, "guards", e["guard"], report)
    schema = manifest.get("spec_schema") or {}
    draft: dict = {
        "meta": {"name": name, "version": manifest.get("version", "0.1.0"),
                 "description": manifest.get("description", "")},
        "spec_schema": [{"field": f, "type": t}
                        for f, t in (schema.get("input") or {}).items()],
        "default_spec": {},
        "nodes": nodes,
        "edges": edges,
    }
    if schema.get("output"):
        draft["spec_schema_output"] = schema["output"]
    _save_draft(name, json.dumps(draft, ensure_ascii=False).encode("utf-8"))
    return {"draft": name, "report": report}
```

- [ ] **Step 5: 跑测试确认通过 + 回归**

```bash
uv run pytest tests/test_build_api.py -q
```

Expected: 全部 PASS。

- [ ] **Step 6: 提交**

```bash
git add server/api/build.py tests/test_build_api.py
git commit -m "feat(build): POST /api/modules/{name}/decompile——已装 packed 模块反解为构建器草稿（直渲染通道 + 组件导入三态报告）"
```

---

### Task 5: 库 api.md 补录 `apply_update`（库仓库独立提交）

**Files:**
- Modify: `../SpecModule/docs/references/api.md`（store 章节，`install_pack` 行之后）

- [ ] **Step 1: 确认未录**

```bash
grep -n "apply_update" "C:\Users\xingy\Desktop\开发\SpecModule\docs\references\api.md"
```

Expected: 无输出（未补录）。若已有则跳过本任务。

- [ ] **Step 2: 在 `api.md` 的 store 章节表格 `install_pack` 行（约 97 行）之后追加一行（表格列结构对齐相邻行）：**

```markdown
| `apply_update` | `(name: str, src: Path) -> None` | 同名覆盖更新已装模块：旧包目录移 `.<名>.bak` → 来源整包 copytree（`.git` 不复制）→ 重写 `manifests/<名>.json`（`source` 保留旧值、version/哈希/installed_at 刷新）→ 清理备份；任一步失败回滚备份（零残留）。**只做"确认后"的执行**——差异检测用 `check_updates`，调用方负责先校验来源（webview 更新端点在调用前显式 `validate_pack_dir`）。无安装 manifest 的模块不设防（`load_manifest` 仅用于保留 source）；来源非法由 copytree 后的 validate 阶段抛错并回滚 |
```

- [ ] **Step 3: 库仓库提交（遵循其 AGENTS.md，docs: 前缀）**

```bash
cd "C:\Users\xingy\Desktop\开发\SpecModule"
git add docs/references/api.md
git commit -m "docs: api.md 补录 store.apply_update——webview 更新端点消费增量"
```

---

### Task 6: 前端——api.ts 端点封装与类型

**Files:**
- Modify: `web/src/api.ts`（BuilderDraft 接口 + 文件尾端点区）

- [ ] **Step 1: `BuilderDraft` 接口（约 402 行）加可选透传字段：**

```typescript
export interface BuilderDraft {
  meta: BuilderMeta;
  spec_schema: SpecField[];
  default_spec: Record<string, unknown>;
  /** output 侧 schema 透传（外部 pack 反解保全；UI 不编辑） */
  spec_schema_output?: Record<string, string>;
  nodes: BuilderNode[];
  edges: BuilderEdge[];
  updated_at?: string;
}
```

- [ ] **Step 2: 文件尾（`genId` 之后）追加：**

```typescript
// ── 已装模块编辑（反解 + 同名更新）──────────────────────────────────

export interface DecompileReport {
  imported: string[];  // 组件库新建（kind/name）
  existed: string[];   // 库中已有且内容一致
  conflicts: string[]; // 同名异内容——沿用库版本
  warnings: string[];  // submodule 未安装等组装前须知
}
export interface DecompileResult { draft: string; report: DecompileReport }

export const decompileModule = (name: string) =>
  postJson<DecompileResult>(`/api/modules/${name}/decompile`, {});

export const updatePack = (draftName: string) =>
  postJson<ModuleDetail>("/api/modules/packs/update", { draft: draftName });
```

- [ ] **Step 3: 门禁**

```bash
cd "C:\Users\xingy\Desktop\开发\SpecModule_webview\web" && npm run build
```

Expected: 构建成功。

- [ ] **Step 4: 提交**

```bash
cd "C:\Users\xingy\Desktop\开发\SpecModule_webview"
git add web/src/api.ts
git commit -m "feat(web): api 封装——decompileModule/updatePack + 草稿 spec_schema_output 类型"
```

---

### Task 7: 前端——ModuleDetail 编辑按钮 + 反解报告面板 + App 接线

**Files:**
- Modify: `web/src/components/ModuleDetail.tsx`
- Modify: `web/src/App.tsx:493`（ModuleDetail 渲染处）

- [ ] **Step 1: ModuleDetail import 区改为（加 Hammer、fetchDraft、decompileModule、DecompileResult）：**

```tsx
import { Hammer, Play } from "lucide-react";
import {
  decompileModule,
  fetchDraft,
  fetchModuleDetail,
  postLaunch,
  type DecompileResult,
  type LaunchResult,
  type ModuleDetail as ModuleDetailData,
} from "../api";
```

- [ ] **Step 2: Props 接口（约 31 行）加 `onEdit`：**

```tsx
interface ModuleDetailProps {
  name: string;
  /** 启动成功（202）回调：壳层切「运行历史」页签并打开新 run */
  onLaunched: (result: LaunchResult) => void;
  /** 编辑（反解完成、用户点「打开构建器」）回调：壳层开 build 页签 */
  onEdit: (name: string) => void;
}
```

组件签名改为 `export function ModuleDetail({ name, onLaunched, onEdit }: ModuleDetailProps)`。

- [ ] **Step 3: 状态区（约 49 行 `const [err, ...]` 之后）加：**

```tsx
  // ── 编辑（反解）状态：报告面板留在详情页，用户看完再进构建器 ──
  const [decompiling, setDecompiling] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);
  const [report, setReport] = useState<DecompileResult | null>(null);
```

- [ ] **Step 4: `submit` 函数之后加 runEdit：**

```tsx
  const runEdit = async (moduleName: string) => {
    if (decompiling) return;
    setDecompiling(true);
    setEditErr(null);
    try {
      // 同名草稿已存在 → 反解会覆盖，显式确认（fetchDraft 失败视为不存在）
      const existing = await fetchDraft(moduleName).catch(() => null);
      if (existing && !window.confirm(`已存在同名草稿「${moduleName}」，重新反解将覆盖——继续？`)) {
        return;
      }
      setReport(await decompileModule(moduleName));
    } catch (e) {
      setEditErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDecompiling(false);
    }
  };
```

- [ ] **Step 5: 头部行（`detail.version` span 之后、约 141 行）加编辑按钮（仅 packed）：**

```tsx
          {detail.kind === "packed" && (
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              disabled={decompiling}
              onClick={() => runEdit(detail.name)}
            >
              <Hammer className="h-3.5 w-3.5" />
              {decompiling ? "反解中…" : "编辑"}
            </Button>
          )}
```

- [ ] **Step 6: 路径行（`detail.path` div 之后、约 148 行）加编辑错误与报告面板：**

```tsx
        {editErr && <div className="mt-2 text-[12px] text-destructive">{editErr}</div>}
        {report && (
          <div className="mt-4 rounded-md border p-3 text-[12px]">
            <div className="font-semibold">反解完成：草稿「{report.draft}」</div>
            <ul className="mt-1.5 space-y-0.5 text-muted-foreground">
              {report.report.imported.map((x) => <li key={x}>＋ 导入组件库：{x}</li>)}
              {report.report.existed.map((x) => <li key={x}>＝ 组件库已有（内容一致）：{x}</li>)}
              {report.report.conflicts.map((x) => (
                <li key={x} className="text-[var(--ph-truncated)]">⚠ 同名冲突——沿用组件库版本：{x}</li>
              ))}
              {report.report.warnings.map((x) => (
                <li key={x} className="text-[var(--ph-truncated)]">⚠ {x}</li>
              ))}
            </ul>
            <div className="mt-2 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setReport(null)}>关闭</Button>
              <Button size="sm" onClick={() => onEdit(report.draft)}>打开构建器</Button>
            </div>
          </div>
        )}
```

- [ ] **Step 7: App.tsx（约 493 行）接线：**

```tsx
<ModuleDetail key={openModuleName} name={openModuleName} onLaunched={handleLaunched} onEdit={openBuilder} />
```

- [ ] **Step 8: 门禁**

```bash
cd "C:\Users\xingy\Desktop\开发\SpecModule_webview\web" && npm run build
```

Expected: 构建成功。

- [ ] **Step 9: 提交**

```bash
cd "C:\Users\xingy\Desktop\开发\SpecModule_webview"
git add web/src/components/ModuleDetail.tsx web/src/App.tsx
git commit -m "feat(web): 模块详情编辑入口——反解报告面板（三态导入报告 + warnings）+ 打开构建器"
```

---

### Task 8: 前端——ModuleBuilder 自动布局 + 「更新模块」按钮

**Files:**
- Modify: `web/src/components/builder/ModuleBuilder.tsx`

- [ ] **Step 1: import 区——lucide 加 `RefreshCw`，api 加 `fetchModules`、`updatePack`：**

```tsx
import { Download, GitMerge, LayoutGrid, RefreshCw, ShieldCheck, Table2 } from "lucide-react";
```

```tsx
import {
  fetchDraft, fetchLibrary, fetchModules, genId, installPack, onLibraryChanged,
  putDraft, updatePack, validatePack,
  type BuilderDraft, type BuilderNode, type LibraryIndex, type ModuleDetail,
  type SpecField, type SpecTypeName, type ValidatePackResult,
} from "../../api";
```

- [ ] **Step 2: `installed` 状态改带 mode（约 50 行）：**

```tsx
  const [installed, setInstalled] =
    useState<{ detail: ModuleDetail; mode: "install" | "update" } | null>(null);
```

- [ ] **Step 3: `load` 改为反解产物自动布局（约 56 行）：**

```tsx
  const load = useCallback(() => {
    setLoadErr(null);
    fetchDraft(name)
      .then((d) => {
        // 反解产物无布局（全零坐标）——载入即自动重排一次（随自动保存落盘）
        setDraft(
          d.nodes.length > 0 && d.nodes.every((n) => n.position.x === 0 && n.position.y === 0)
            ? relayout(d)
            : d,
        );
      })
      .catch((e) => setLoadErr(e instanceof Error ? e.message : String(e)));
    fetchLibrary().then(setLibrary).catch(() => {}); // 库清单失败不阻塞——添加节点时提示
  }, [name]);
```

- [ ] **Step 4: 已装模块检测（`onLibraryChanged` effect 之后加）：**

```tsx
  // 已装模块清单（name→kind）：草稿名命中已装 packed 模块 → 显示「更新模块」
  const [moduleKinds, setModuleKinds] = useState<Record<string, string>>({});
  const refreshModuleKinds = useCallback(() => {
    fetchModules()
      .then((ms) => setModuleKinds(Object.fromEntries(ms.modules.map((m) => [m.name, m.kind]))))
      .catch(() => {});
  }, []);
  useEffect(() => { refreshModuleKinds(); }, [refreshModuleKinds]);
```

- [ ] **Step 5: `runCheck` 改三态 + 用草稿当前名（约 122 行）。改名后安装/更新都应作用于草稿当前 `meta.name`（所见即所装；旧实现用页签名，改名后会装到旧草稿文件的内容）：**

```tsx
  const runCheck = useCallback(async (mode: "validate" | "install" | "update") => {
    if (busy) return;
    setBusy(true);
    setCheckErrors(null);
    setCheckResult(null);
    try {
      await saveNow();
      const dname = draftRef.current?.meta.name ?? name;
      if (mode === "install") {
        const detail = await installPack(dname);
        setInstalled({ detail, mode: "install" });
        refreshModuleKinds();
      } else if (mode === "update") {
        const detail = await updatePack(dname);
        setInstalled({ detail, mode: "update" });
        refreshModuleKinds();
      } else {
        setCheckResult(await validatePack(dname));
      }
    } catch (e) {
      setCheckErrors([e instanceof Error ? e.message : String(e)]);
    } finally {
      setBusy(false);
    }
  }, [busy, name, saveNow, refreshModuleKinds]);
```

- [ ] **Step 6: 顶栏按钮区（约 206 行 `ml-auto` div）改为——更新与安装互斥展示（已装同名 packed → 更新；改名后自动切回安装 = 另存新模块）：**

```tsx
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => runCheck(false)}>
            <ShieldCheck className="h-3.5 w-3.5" />校验
          </Button>
          {isInstalledPacked ? (
            <Button size="sm" disabled={busy}
                    title="以草稿内容覆盖更新已装模块（旧包自动备份，失败回滚）"
                    onClick={() => {
                      if (window.confirm(`更新已装模块「${draft.meta.name}」？store 内旧包将被替换。`)) {
                        runCheck("update");
                      }
                    }}>
              <RefreshCw className="h-3.5 w-3.5" />更新模块
            </Button>
          ) : (
            <Button size="sm" disabled={busy} onClick={() => runCheck("install")}>
              <Download className="h-3.5 w-3.5" />安装进 store
            </Button>
          )}
        </div>
```

- [ ] **Step 7: 组件体内（`if (!draft)` 守卫之后、return 之前）计算命中：**

```tsx
  const isInstalledPacked = moduleKinds[draft.meta.name] === "packed";
```

- [ ] **Step 8: 成功横幅（约 247 行 `installed &&` 块）按 mode 区分文案：**

```tsx
      {installed && (
        <div className={overlayCls} onClick={() => setInstalled(null)}>
          <div className={panelCls} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-1.5 text-[13px] font-semibold">
              <GitMerge className="h-4 w-4 text-emerald-500" />
              {installed.mode === "update" ? "更新成功" : "安装成功"}：{installed.detail.name}
            </div>
            <div className="text-[12px] text-muted-foreground">
              {installed.mode === "update"
                ? "已覆盖更新 store 内模块（旧包已备份替换）。可继续编辑或发起运行验证。"
                : `已装入 store（${installed.detail.kind}）。可在模块库发起运行。`}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setInstalled(null)}>留在创建器</Button>
              <Button size="sm" onClick={() => onInstalled(installed.detail.name)}>去模块库试运行</Button>
            </div>
          </div>
        </div>
      )}
```

- [ ] **Step 9: 门禁**

```bash
cd "C:\Users\xingy\Desktop\开发\SpecModule_webview\web" && npm run build
```

Expected: 构建成功。

- [ ] **Step 10: 提交**

```bash
cd "C:\Users\xingy\Desktop\开发\SpecModule_webview"
git add web/src/components/builder/ModuleBuilder.tsx
git commit -m "feat(web): 构建器更新模块按钮（同名覆盖）+ 反解草稿自动布局 + 安装/更新按草稿当前名"
```

---

### Task 9: 全量验收 + 归档

- [ ] **Step 1: 后端全量（含 treechat）**

```bash
cd "C:\Users\xingy\Desktop\开发\SpecModule_webview"
uv run pytest tests/ -q
```

Expected: 全部 PASS（基线 148 + treechat 133 + 本轮新增约 14 例）。

- [ ] **Step 2: 库基线回归（零上游改动，确认无涟漪）**

```bash
uv run pytest ../SpecModule/module_harness/tests/ -q -m "not smoke"
```

Expected: 全部 PASS。

- [ ] **Step 3: 前端门禁**

```bash
cd web && npm run build
```

Expected: 构建成功。

- [ ] **Step 4: 手工端到端（可选，留给用户验证）**

启动后端 + 前端，验证闭环：模块库选一个 packed 模块 → 「编辑」→ 看反解报告 → 「打开构建器」→ 画布自动布局 → 改节点/版本 → 「更新模块」→ 模块库详情 version 已变 → 发起 mock 运行验证新逻辑生效。

- [ ] **Step 5: 归档——`roadmap/roadmap.md` 模块构建器节的后排行（约 71 行）改为：**

```markdown
- [x] 后排：编辑/反解已安装模块（2026-09-28，反解回构建器 + apply_update 同名更新；output 侧仅透传保全，编辑 UI 与库版本管理仍后排）
```

- [ ] **Step 6: 归档——`roadmap/finish.md` 按其既有条目格式追加一段（落地内容/关键决策/新端点/设计定稿与计划指引）：**

```markdown
## 已安装模块编辑（反解 → 画布 → 装回）——2026-09-28

- 设计定稿：`docs/superpowers/specs/2026-09-28-module-edit-design.md`；实施计划：`docs/superpowers/plans/2026-09-28-module-edit.md`。
- `POST /api/modules/{name}/decompile`：packed 模块反解为构建器草稿（`build_run_graph` tasklist 直渲染通道 + `graph_to_dict`，Flow 零反解析；join 实测返回大写 AND/OR 与草稿模型一致）+ 包内组件导入组件库三态报告（imported/existed/conflicts，冲突沿用库版本）+ submodule 未安装 warnings + `spec_schema.output` 经草稿 `spec_schema_output` 透传保全。
- `POST /api/modules/packs/update`：草稿同名覆盖更新已装模块（组装 → validate_pack_dir 显式先行 → 库 `apply_update` 备份回滚）；未安装 404、entry/pip 400。
- 前端：模块详情 packed 模块「编辑」按钮 + 反解报告面板；构建器「更新模块」按钮（与安装互斥展示，按草稿当前 meta.name 作用）+ 反解草稿载入自动 dagre 布局。
- 库侧零代码改动；api.md 补录 `apply_update`（库仓库独立 docs 提交）。
```

- [ ] **Step 7: 提交归档**

```bash
cd "C:\Users\xingy\Desktop\开发\SpecModule_webview"
git add roadmap/roadmap.md roadmap/finish.md
git commit -m "docs: 已安装模块编辑落地归档——roadmap 后排勾选 + finish.md 记录"
```

---

## 自审记录（计划完成后已核）

1. **Spec 覆盖**：反解端点（Task 4）、更新端点（Task 3）、output 透传（Task 2）、组件导入三态（Task 4）、submodule warnings（Task 4）、前端 api（Task 6）/ModuleDetail+报告面板（Task 7）/App 接线（Task 7）/ModuleBuilder 更新+自动布局（Task 8）、api.md（Task 5）、roadmap+finish 归档（Task 9）、测试（Tasks 2-4）、门禁（Task 9）——spec 各节均有对应任务。
2. **占位符扫描**：无 TBD/TODO；所有代码步骤给出完整代码。
3. **类型一致性**：`DecompileResult/DecompileReport`（Task 6 定义，Task 7 消费）；`runCheck` 三态签名（Task 8 定义并同文件消费）；`installed` 带 mode 形状（Task 8 内自洽）；后端 `report` 四键全为字符串列表（Task 4 实现 = spec 契约 = Task 7 渲染）。
