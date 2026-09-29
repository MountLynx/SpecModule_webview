# packed 模块 default_spec 契约补齐 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** packed 模块 manifest 增设可选 `default_spec` 契约键（spec 参考），创建器 SpecDialog 死区块激活、发起页「spec 参考」对 packed 生效（关闭 issue #22）。

**Architecture:** 上游 SpecModule 库先补契约（SubModule 类属性 + pack()/loader 读写 + ResolvedModule 透出 + entry_to_pack 保留），webview 侧只做薄映射（组装写键 / 草稿形状检查 / 反解回读），前端零改动。库经 `[tool.uv.sources]` editable 锚定 `../SpecModule`，库改动即时生效于本仓库 venv。

**Tech Stack:** Python 3.10+（库 dev'd on 3.13）、pytest + unittest.mock、FastAPI TestClient（httpx）、无 lint/type 工具（生态惯例）。

**设计文档:** `docs/superpowers/specs/2026-09-29-packed-default-spec-design.md`

**工作目录约定:** 所有命令默认在本仓库根 `SpecModule_webview/` 执行；库仓库为兄弟目录 `../SpecModule`（下文写作 `SpecModule_webview/../SpecModule`）。库仓库的提交**必须独立于本仓库**（`git -C ../SpecModule`）。

---

### Task 1: 库——SubModule.default_spec 类属性 + pack() 导出

**Files:**
- Modify: `../SpecModule/module_harness/model/submodule.py`（类属性区 ~行 47-58、`pack()` 的 manifest 组装 ~行 240-252）
- Test: `../SpecModule/module_harness/tests/test_submodule.py`（文件末尾追加新测试类）

- [ ] **Step 1: 写失败测试**

在 `../SpecModule/module_harness/tests/test_submodule.py` 末尾追加（`json`/`pytest` 顶部已 import；`Translator` 是文件内 ~行 51 定义的 SubModule 子类，`ModuleLoader`/`ModuleManifestError` 已 import）：

```python
class TestDefaultSpecContract:
    """packed default_spec 契约：pack() 导出 ⇄ ModuleLoader 读回（round-trip）。"""

    def test_pack_exports_default_spec(self, tmp_path, monkeypatch):
        monkeypatch.setattr(Translator, "default_spec", {"name": "world"},
                            raising=False)
        out = Translator().pack(tmp_path / "dist")
        manifest = json.loads((out / "module.json").read_text(encoding="utf-8"))
        assert manifest["default_spec"] == {"name": "world"}

    def test_pack_omits_absent_default_spec(self, tmp_path):
        out = Translator().pack(tmp_path / "dist")
        manifest = json.loads((out / "module.json").read_text(encoding="utf-8"))
        assert "default_spec" not in manifest
```

- [ ] **Step 2: 跑测试确认失败**

```bash
uv run pytest ../SpecModule/module_harness/tests/test_submodule.py::TestDefaultSpecContract -v
```

预期：`test_pack_exports_default_spec` FAIL（pack() 尚未读该属性，manifest 无键 → KeyError）；`test_pack_omits_absent_default_spec` PASS（键本来就不写，作为缺席分支回归保留）。

- [ ] **Step 3: 实现**

`../SpecModule/module_harness/model/submodule.py` — 类属性区（`spec_schema: SpecSchema = SpecSchema()` 一行之后）新增：

```python
    default_spec: dict[str, Any] | None = None
```

（`Any` 已在文件顶部 typing import 中；若缺则补 `from typing import Any`。）

`pack()` 内 manifest 组装（`manifest = {...}` 字典字面量之后、写 `module.json` 之前）插入：

```python
        if self.default_spec is not None:
            manifest["default_spec"] = dict(self.default_spec)
```

- [ ] **Step 4: 跑测试确认通过**

```bash
uv run pytest ../SpecModule/module_harness/tests/test_submodule.py -v
```

预期：全 PASS（含既有 TestSubModule/TestPackArea 等）。

- [ ] **Step 5: 提交（库仓库）**

```bash
git -C ../SpecModule add module_harness/model/submodule.py module_harness/tests/test_submodule.py
git -C ../SpecModule commit -m "feat(submodule): SubModule 增 default_spec 类属性，pack() 导出 manifest 契约键"
```

---

### Task 2: 库——ModuleLoader 读 manifest default_spec（形状拒收）

**Files:**
- Modify: `../SpecModule/module_harness/cli/loader.py`（`load()` 内 `schema_data` 块 ~行 110-113 之后 + 生成类 `type(name, (SubModule,), {...})` ~行 125-139）
- Test: `../SpecModule/module_harness/tests/test_submodule.py`（追加进 Task 1 的 `TestDefaultSpecContract` 类）

- [ ] **Step 1: 写失败测试**

追加进 `TestDefaultSpecContract` 类（`mock_llm` fixture 是文件内既有 fixture，`test_load_returns_instance` 同款用法）：

```python
    def test_load_default_spec(self, tmp_path, mock_llm):
        out = Translator().pack(tmp_path / "dist")
        mp = out / "module.json"
        manifest = json.loads(mp.read_text(encoding="utf-8"))
        manifest["default_spec"] = {"name": "world"}
        mp.write_text(json.dumps(manifest), encoding="utf-8")
        module = ModuleLoader(llm_client=mock_llm).load(out)
        assert module.default_spec == {"name": "world"}

    def test_load_rejects_non_dict_default_spec(self, tmp_path, mock_llm):
        out = Translator().pack(tmp_path / "dist")
        mp = out / "module.json"
        manifest = json.loads(mp.read_text(encoding="utf-8"))
        manifest["default_spec"] = ["oops"]
        mp.write_text(json.dumps(manifest), encoding="utf-8")
        with pytest.raises(ModuleManifestError):
            ModuleLoader(llm_client=mock_llm).load(out)
```

- [ ] **Step 2: 跑测试确认失败**

```bash
uv run pytest ../SpecModule/module_harness/tests/test_submodule.py::TestDefaultSpecContract -v
```

预期：`test_load_default_spec` FAIL（Task 1 后类属性存在但恒 None，`None != {"name": "world"}`）；`test_load_rejects_non_dict_default_spec` FAIL（未拒收，DID NOT RAISE）。

- [ ] **Step 3: 实现**

`../SpecModule/module_harness/cli/loader.py` `load()` — 在 `spec_schema = SpecSchema(...)` 构造块之后插入：

```python
        default_spec = manifest.get("default_spec")
        if default_spec is not None and not isinstance(default_spec, dict):
            raise ModuleManifestError("default_spec 必须是对象（{字段: 参考值}）")
```

生成类字典 `cls = type(name, (SubModule,), {...})` 中（`"spec_schema": spec_schema,` 一行之后）新增：

```python
            "default_spec": dict(default_spec) if default_spec is not None else None,
```

- [ ] **Step 4: 跑测试确认通过**

```bash
uv run pytest ../SpecModule/module_harness/tests/test_submodule.py -q
```

预期：全 PASS。

- [ ] **Step 5: 提交（库仓库）**

```bash
git -C ../SpecModule add module_harness/cli/loader.py module_harness/tests/test_submodule.py
git -C ../SpecModule commit -m "feat(loader): manifest 读可选 default_spec（须为对象，拒收形状逃逸）"
```

---

### Task 3: 库——ResolvedModule.default_spec / spec_for packed 分支透出

**Files:**
- Modify: `../SpecModule/module_harness/infra/store.py`（`ResolvedModule.default_spec` ~行 280-284、`spec_for` ~行 305-316）
- Test: `../SpecModule/module_harness/tests/test_store.py`（文件末尾追加新测试类；`import json` / `from module_harness import store` / `_PackedMod` 均已在文件内）

- [ ] **Step 1: 写失败测试**

在 `../SpecModule/module_harness/tests/test_store.py` 末尾追加（`fake_home` 为既有 fixture，`test_packed_spec_for_passthrough` 同款用法）：

```python
class TestPackedDefaultSpec:
    """packed default_spec 契约：manifest 键 → ResolvedModule/detail 透出。"""

    def test_packed_default_spec_passthrough(self, fake_home, tmp_path):
        packs = tmp_path / "packs"
        out = _PackedMod.make().pack(packs / "packed_mod")
        mp = out / "module.json"
        manifest = json.loads(mp.read_text(encoding="utf-8"))
        manifest["default_spec"] = {"name": "world"}
        mp.write_text(json.dumps(manifest), encoding="utf-8")
        res = store.resolve_module_full("packed_mod", search=[packs])
        assert res is not None
        assert res.default_spec == {"name": "world"}
        assert res.spec_for(None) == ({"name": "str"}, {"name": "world"})
        assert res.spec_for("anything") == ({"name": "str"}, {"name": "world"})
        assert store.detail_to_dict(res)["default_spec"] == {"name": "world"}
```

- [ ] **Step 2: 跑测试确认失败**

```bash
uv run pytest ../SpecModule/module_harness/tests/test_store.py::TestPackedDefaultSpec -v
```

预期：FAIL（`res.default_spec` 为 None；`spec_for` 返回 `(schema, None)`）。

- [ ] **Step 3: 实现**

`../SpecModule/module_harness/infra/store.py` — `ResolvedModule.default_spec` 属性整体替换为：

```python
    @property
    def default_spec(self) -> dict[str, Any] | None:
        if self.submodule is not None:
            return self.submodule.default_spec
        return self.entry.default_spec if self.entry is not None else None
```

`spec_for` 方法两处精确替换——

docstring 段，把：

```python
        此处零复制）；packed/pip 无 per-template 概念，透传模块级
        schema（default_spec 恒 None）。
```

替换为：

```python
        此处零复制）；packed/pip 无 per-template 概念，透传模块级
        schema 与 default_spec（manifest 可选键，无键 → None）。
```

方法体，把：

```python
        return self.spec_schema, None
```

替换为：

```python
        return self.spec_schema, self.default_spec
```

同文件既有测试 `test_packed_spec_for_passthrough`（~行 349）的 docstring「default_spec 恒 None」改为「无键 → None」——断言不动（manifest 无键时 loader 返回 None，语义仍成立，作为缺席分支回归）。

- [ ] **Step 4: 跑测试确认通过**

```bash
uv run pytest ../SpecModule/module_harness/tests/test_store.py -q
```

预期：全 PASS。

- [ ] **Step 5: 提交（库仓库）**

```bash
git -C ../SpecModule add module_harness/infra/store.py module_harness/tests/test_store.py
git -C ../SpecModule commit -m "feat(store): ResolvedModule.default_spec/spec_for packed 分支接通 manifest 契约"
```

---

### Task 4: 库——entry_to_pack 保留 default_spec（撤销诚实警告）

**Files:**
- Modify: `../SpecModule/module_harness/infra/entry_pack.py`（警告 ~行 123-124、manifest 组装 ~行 184-195）
- Test: `../SpecModule/module_harness/tests/test_entry_pack.py`（`test_materializes_self_contained_pack` ~行 95-108）

- [ ] **Step 1: 翻转失败测试**

`test_entry_pack.py` 的 `test_materializes_self_contained_pack` 中，把：

```python
        assert any("default_spec" in w for w in result.warnings)
```

替换为（fixture `entry` 的 `default_spec={"name": "world"}`，manifest 已由上方 `validate_pack_dir(pack)` 取得）：

```python
        assert manifest["default_spec"] == {"name": "world"}
        assert not any("default_spec" in w for w in result.warnings)
```

- [ ] **Step 2: 跑测试确认失败**

```bash
uv run pytest ../SpecModule/module_harness/tests/test_entry_pack.py::TestEntryToPack::test_materializes_self_contained_pack -v
```

预期：FAIL（manifest 无该键，KeyError）。

- [ ] **Step 3: 实现**

`../SpecModule/module_harness/infra/entry_pack.py` — 删除警告行：

```python
    if entry.default_spec:
        warnings.append("entry 级 default_spec 样例值不保留（packed manifest 无此契约键）")
```

`manifest = {...}` 字典字面量之后、`(pack / "module.json").write_text(...)` 之前插入：

```python
    if entry.default_spec:
        manifest["default_spec"] = dict(entry.default_spec)
```

- [ ] **Step 4: 跑测试确认通过**

```bash
uv run pytest ../SpecModule/module_harness/tests/test_entry_pack.py -q
```

预期：全 PASS。

- [ ] **Step 5: 提交（库仓库）**

```bash
git -C ../SpecModule add module_harness/infra/entry_pack.py module_harness/tests/test_entry_pack.py
git -C ../SpecModule commit -m "feat(entry_pack): entry 级 default_spec 写入 pack manifest，撤销不保留警告"
```

---

### Task 5: 库——CLI run packed 回落回归测试（零实现改动，纯验证）

**Files:**
- Test: `../SpecModule/module_harness/tests/test_cli.py`（`TestRun` 类内追加；模块写入 helper 加在 `TestRun` 类定义之前）

`_resolve_spec` 已走 `res.default_spec`（`cli/cli.py`）——Task 3 修复 `ResolvedModule` 后 packed 自动获得 `--spec > --spec-file > default_spec` 回落。本任务只补测试钉住行为（对应设计「CLI run/resume 零改动」验收项）。

- [ ] **Step 1: 写失败测试**

`test_cli.py` — 在 `class TestRun:` 定义之前追加 helper（`json` 顶部已 import；packed 模块直接手写目录，与 `test_store.py::_PackedMod` 同构但不依赖其 helper）：

```python
def _write_packed(modules, name, default_spec):
    """modules/ 下种最小 packed 模块（single script task）；default_spec None = 不写键。"""
    p = modules / name
    (p / "scripts").mkdir(parents=True)
    manifest = {
        "name": name, "description": "packed 夹具", "submodule": False,
        "spec_schema": {"input": {}, "output": {}},
        "requires": [], "modules": [],
        "tasklist": {"Tasks": {"Greet": {"type": "script", "script": "greet"}},
                     "Flow": "[Greet]"},
    }
    if default_spec is not None:
        manifest["default_spec"] = default_spec
    (p / "module.json").write_text(json.dumps(manifest), encoding="utf-8")
    (p / "scripts" / "greet.py").write_text(
        "def greet(view):\n    return {'hi': 1}\n", encoding="utf-8")
    return p
```

`TestRun` 类内（`test_missing_spec` 之后）追加：

```python
    def test_packed_run_default_spec_fallback(self, cwd, modules_dir, capsys):
        # packed 无模板/spec 通道：manifest 无 default_spec → 报缺 spec；有键 → 回落发起
        _write_packed(cwd / "modules", "packed_nods", None)
        assert _run(cwd, "--module", "packed_nods", "--mock") == 1
        assert "缺少 spec" in capsys.readouterr().err
        _write_packed(cwd / "modules", "packed_ds", {"anything": 1})
        assert _run(cwd, "--module", "packed_ds", "--mock") == 0
        assert "运行完成" in capsys.readouterr().out
```

- [ ] **Step 2: 跑测试确认失败**

```bash
uv run pytest "../SpecModule/module_harness/tests/test_cli.py::TestRun::test_packed_run_default_spec_fallback" -v
```

预期：FAIL 在第二段（`packed_ds` 期望退出 0，实际 `_resolve_spec` 拿不到 default_spec 报「缺少 spec」退出 1）；第一段（无键 → 缺 spec）本就成立。

- [ ] **Step 3: 确认通过（实现已在 Task 3 落地，无需改码）**

```bash
uv run pytest ../SpecModule/module_harness/tests/test_cli.py -q
```

预期：全 PASS。若 FAIL，回到 Task 3 核对 `ResolvedModule.default_spec` packed 分支。

- [ ] **Step 4: 提交（库仓库）**

```bash
git -C ../SpecModule add module_harness/tests/test_cli.py
git -C ../SpecModule commit -m "test(cli): packed run 无 spec 回落 manifest default_spec 回归钉子"
```

---

### Task 6: 库——api.md 补录 + 全量基线回归

**Files:**
- Modify: `../SpecModule/docs/references/api.md`（~行 104-108、~行 120、~行 125-126）

- [ ] **Step 1: api.md 三处补录**

① `ResolvedModule` 归一说明（~行 104-108），把：

```
`submodules` 屏蔽两形态差异，消费端不感知来源。归一方法 `spec_for(template_name)`：entry 形态委托
`ModuleEntry.spec_for`（回落逻辑唯一驻点），packed/pip 无 per-template 概念、透传模块级 schema
（default_spec 恒 None）。
```

替换为：

```
`submodules` 屏蔽两形态差异，消费端不感知来源。归一方法 `spec_for(template_name)`：entry 形态委托
`ModuleEntry.spec_for`（回落逻辑唯一驻点），packed/pip 无 per-template 概念、透传模块级 schema 与
`default_spec`（packed manifest 的可选 `default_spec` 键——对象形状，缺省/无键 → None；loader
装载期拒收非对象）。
```

② `entry_to_pack` 行的 manifest 形状（~行 120），把：

```
manifest：`{name, version: "0.1.0", description, submodule: False, spec_schema: {input, output: {}}, requires: [], modules, tasklist}`。
```

替换为：

```
manifest：`{name, version: "0.1.0", description, submodule: False, spec_schema: {input, output: {}}, requires: [], modules, tasklist}`；entry 级 `default_spec` 非空时写入 manifest（packed 契约键）。
```

③ 诚实边界段（~行 125-126），把：

```
body 物化后装载通过、运行期才炸（提示在组件库检查脚本文本）；`default_spec` 样例值不
保留（packed manifest 无此契约键）。
```

替换为：

```
body 物化后装载通过、运行期才炸（提示在组件库检查脚本文本）。
```

- [ ] **Step 2: 库全量基线回归**

```bash
uv run pytest ../SpecModule/module_harness/tests/ -q -m "not smoke"
```

预期：全绿（0 failed；smoke 除外）。

- [ ] **Step 3: 提交（库仓库，docs 独立提交）**

```bash
git -C ../SpecModule add docs/references/api.md
git -C ../SpecModule commit -m "docs(api): packed manifest default_spec 契约键补录——ResolvedModule/spec_for/entry_to_pack"
```

---

### Task 7: webview——草稿形状检查 + 组装写键

**Files:**
- Modify: `server/api/build.py`（`_validate_draft` ~行 137-150 之后、`_assemble_pack` manifest 组装 ~行 409-420）
- Test: `tests/test_build_api.py`（`TestDrafts`、`TestValidatePack` 类）

- [ ] **Step 1: 写失败测试**

`tests/test_build_api.py` — `TestDrafts` 类内追加（`draft_json` 是文件内既有 helper，`SCRIPT` 是既有常量）：

```python
    def test_default_spec_shape_400(self, client, base):
        r = client.put("/api/library/drafts/bad_spec",
                       json=draft_json("bad_spec", default_spec=["oops"]))
        assert r.status_code == 400 and "default_spec" in r.json()["error"]
```

`TestValidatePack` 类内追加：

```python
    def test_validate_empty_default_spec_omitted(self, client, base):
        """default_spec 空 {} 视同无参考——manifest 不写键（缺键 = 无参考）。"""
        client.put("/api/library/scripts/echo", content=SCRIPT.encode("utf-8"))
        client.put("/api/library/drafts/plain", json=draft_json("plain"))
        r = client.post("/api/modules/packs/validate", json={"draft": "plain"})
        assert r.status_code == 200
        assert "default_spec" not in r.json()["manifest"]
```

并在既有 `test_validate_ok_returns_tasklist` 的断言区（`assert d["manifest"]["name"] == "loop_mod"` 之后）追加一行（`seed_builder` 的草稿带 `"default_spec": {"raw_text": "demo"}`）：

```python
        assert d["manifest"]["default_spec"] == {"raw_text": "demo"}
```

- [ ] **Step 2: 跑测试确认失败**

```bash
uv run pytest tests/test_build_api.py::TestDrafts::test_default_spec_shape_400 tests/test_build_api.py::TestValidatePack -v
```

预期：PUT 测试 FAIL（200 而非 400）；manifest 断言 FAIL（KeyError: 'default_spec'）；omitted 测试 PASS（键本来就不写）。

- [ ] **Step 3: 实现**

`server/api/build.py` `_validate_draft` — 在 `spec_schema_output` 检查块（~行 147-149）之后、`return draft` 之前插入：

```python
    # default_spec 形状检查：须为对象（缺省/空 = 无参考；组装侧真值才写 manifest）
    ds = draft.get("default_spec")
    if ds is not None and not isinstance(ds, dict):
        raise _draft_err("default_spec 须为对象（{字段: 参考值}）")
```

`_assemble_pack` — `manifest = {...}` 字典字面量之后、`(pack / "module.json").write_text(...)` 之前插入：

```python
        if draft.get("default_spec"):
            manifest["default_spec"] = dict(draft["default_spec"])
```

- [ ] **Step 4: 跑测试确认通过**

```bash
uv run pytest tests/test_build_api.py -q
```

预期：全 PASS。

- [ ] **Step 5: 提交（本仓库）**

```bash
git add server/api/build.py tests/test_build_api.py
git commit -m "feat(web): 组装 manifest 写入 default_spec 契约键——草稿形状检查 + 空值省略"
```

---

### Task 8: webview——安装详情透出 + 反解回读

**Files:**
- Modify: `server/api/build.py`（`decompile_module` ~行 623-628 形状前置检查区、draft 组装 ~行 690-698）
- Test: `tests/test_build_api.py`（`TestInstallPack`、`TestDecompile` 类）

- [ ] **Step 1: 写失败测试**

`TestInstallPack.test_install_ok_and_visible` 的断言区（`assert d["name"] == "loop_mod" and d["kind"] == "packed"` 之后）追加：

```python
        # 安装详情透出参考 spec（库 ResolvedModule packed 分支 + 组装写键的端到端）
        assert d["default_spec"] == {"raw_text": "demo"}
```

`TestDecompile.test_round_trip` 末尾的：

```python
        assert draft["default_spec"] == {}  # packed 模块无 default_spec 概念
```

替换为：

```python
        assert draft["default_spec"] == {"raw_text": "demo"}  # 反解回读参考 spec
```

`TestDecompile` 类内追加（`seed_pack_module` 是文件内既有 helper，返回模块目录 Path）：

```python
    def test_decompile_non_dict_default_spec_400(self, client, base):
        """外部手写 pack 的 default_spec 形状逃逸 → 400 不 500。"""
        p = seed_pack_module(base, name="bad_ds")
        mp = p / "module.json"
        manifest = json.loads(mp.read_text(encoding="utf-8"))
        manifest["default_spec"] = ["oops"]
        mp.write_text(json.dumps(manifest), encoding="utf-8")
        r = client.post("/api/modules/bad_ds/decompile")
        assert r.status_code == 400 and "default_spec" in r.json()["error"]
```

- [ ] **Step 2: 跑测试确认失败**

```bash
uv run pytest tests/test_build_api.py::TestInstallPack::test_install_ok_and_visible tests/test_build_api.py::TestDecompile -v
```

预期：`test_round_trip` FAIL（实际 `{"raw_text": "demo"}` ≠ 断言中的 `{}`——Task 7 组装已写键）；`test_decompile_non_dict_default_spec_400` FAIL（期望 400，实际 200——形状守卫未落地时该键被静默丢弃）；install 断言预期 PASS（跨仓库集成验证：Task 7 写键 + 库 Task 3 的 store 透出已就位，若此处失败说明库侧回退，须排查 Task 3）。

- [ ] **Step 3: 实现**

`server/api/build.py` `decompile_module` — 在 `spec_schema.input` 形状前置检查块（~行 623-628）之后插入：

```python
    default_spec = manifest.get("default_spec")
    if default_spec is not None and not isinstance(default_spec, dict):
        raise HTTPException(status_code=400, detail={
            "error": "default_spec 须为对象（参考 spec）", "module": name})
```

draft 组装字典（~行 690-698）中把：

```python
        "default_spec": {},
```

替换为：

```python
        "default_spec": dict(default_spec or {}),
```

- [ ] **Step 4: 跑测试确认通过**

```bash
uv run pytest tests/test_build_api.py -q
```

预期：全 PASS。

- [ ] **Step 5: 提交（本仓库）**

```bash
git add server/api/build.py tests/test_build_api.py
git commit -m "feat(web): 反解回读 manifest default_spec——编辑闭环参考 spec 往返保真 + 形状前置检查"
```

---

### Task 9: webview——全量回归 + 收尾（关 #22、文档归档）

**Files:**
- Modify: `roadmap/roadmap.md`（「问题与遗留」索引 ~行 93）
- Modify: `roadmap/finish.md`（完成归档）

- [ ] **Step 1: 双仓库全量回归**

```bash
uv run pytest tests/ -q
uv run pytest ../SpecModule/module_harness/tests/ -q -m "not smoke"
```

预期：双绿。

- [ ] **Step 2: 端到端验收（可选人工）**

后端起服务 + 前端 dev：创建器 → Spec 对话框填输入字段与参考值 → 安装 → 模块库发起页出现「spec 参考」预填 →「用参考 spec 尝试运行」发起成功。（自动化覆盖已由 Task 6/7 断言链保证，此步为体验确认。）

- [ ] **Step 3: roadmap 索引摘除 #22**

`roadmap/roadmap.md` ~行 93 删除整行：

```
- [#22 UI 谎言：创建器 SpecDialog 的 default_spec 编辑区不落盘（组装 manifest 无此键，库 packed 形态无 default_spec 契约）](https://github.com/MountLynx/SpecModule_webview/issues/22)
```

- [ ] **Step 4: finish.md 归档**

`roadmap/finish.md` 末尾追加（标题层级对齐该文件既有条目）：

```markdown
## packed 模块 default_spec 契约补齐（2026-09-29）

设计定稿 `docs/superpowers/specs/2026-09-29-packed-default-spec-design.md`，计划
`docs/superpowers/plans/2026-09-29-packed-default-spec.md`。上游库（SpecModule 独立提交）：
SubModule.default_spec 类属性 + pack() 导出 + loader 读键（非对象拒收）+
ResolvedModule/spec_for packed 分支透出 + entry_to_pack 保留（撤销「不保留」警告）+
api.md 补录；CLI run/resume 零改动自动获得 `--spec > --spec-file > default_spec` 回落。
webview：组装写键（空 {} 省略）+ 草稿/反解形状前置检查 + 反解回读往返保真。
创建器 SpecDialog 参考值编辑区激活（关闭 #22），发起页「spec 参考」对 packed 生效。
```

- [ ] **Step 5: 关闭 issue #22**

```bash
gh issue close 22 --repo MountLynx/SpecModule_webview \
  --comment "已落地：库侧补齐 packed manifest default_spec 契约（SpecModule 独立提交），webview 组装/反解接通，创建器 SpecDialog 参考值编辑区激活。设计 docs/superpowers/specs/2026-09-29-packed-default-spec-design.md。"
```

- [ ] **Step 6: 提交（本仓库）**

```bash
git add roadmap/roadmap.md roadmap/finish.md
git commit -m "docs(roadmap): packed default_spec 契约落地归档——#22 关闭、遗留索引摘除"
```
