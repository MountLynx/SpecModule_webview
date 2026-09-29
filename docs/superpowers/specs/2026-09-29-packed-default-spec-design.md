# packed 模块 default_spec（spec 参考）契约补齐（设计定稿）

> 2026-09-29 定稿。用户指令核心：**新建模块没有设置 spec 参考的地方**。
> 方案 A（问答收敛通过）：上游库补齐 packed manifest 的 `default_spec` 契约键，
> webview 组装/反解两头接通——创建器 SpecDialog 死区块（issue #22）原样激活，
> 发起页「spec 参考」对 packed 模块生效。库仓库独立提交 + `api.md` 补录。

## 定位与范围

- **问题本质不是 UI 缺失**：创建器顶栏「Spec」对话框已有 default_spec（参考值）
  编辑区，发起页（模块库）已有「spec 参考」区块——两层契约没通，编辑是死区块：
  1. webview `_assemble_pack` 组 manifest 不写 `default_spec`（`server/api/build.py`）；
  2. 上游 packed 形态无此契约：`ResolvedModule.default_spec` 对 packed 恒 None
     （`infra/store.py`），`ModuleLoader` 读 manifest 不认此键（`cli/loader.py`），
     `entry_to_pack` 还带着「default_spec 样例值不保留」的诚实警告
     （`infra/entry_pack.py`）——同一缺口的三处表征。
- **统一 API 原则**：spec 参考是模块契约的一部分（模块面对所有消费端暴露的
  接口），不是 webview 私有数据——根修在上游 manifest 契约，webview 只做薄映射。
- **不引入 per-template 概念**：packed 单 tasklist，`default_spec` 模块级一份，
  与 `spec_schema` 单层对齐；entry 形态的 per-template 覆盖语义不变。

## 库侧（SpecModule 仓库，遵守其 AGENTS.md）

1. `module_harness/model/submodule.py` — `SubModule` 基类新增类属性
   `default_spec: dict[str, Any] | None = None`（与 `spec_schema` 同惯例：
   manifest 驱动的注册信息，子类/生成类可覆盖）。
2. `module_harness/cli/loader.py` — `ModuleLoader.load` 读可选
   `manifest["default_spec"]`：缺省 None；存在则须为 dict，否则
   `ModuleManifestError`（装载/校验期统一拒绝）；装进生成的 SubModule 类属性
   （`type(name, (SubModule,), {...})` 增键）。
3. `module_harness/infra/store.py`：
   - `ResolvedModule.default_spec`：packed 分支改返回
     `self.submodule.default_spec`（不再恒 None）；
   - `spec_for`：packed 分支返回 `(self.spec_schema, self.default_spec)`；
   - 撤销「default_spec 恒 None」的 docstring 说法。
   - `detail_to_dict` 零改动——模块级 `default_spec` 本就原样透传。
4. `module_harness/infra/entry_pack.py` — `entry_to_pack` 把 `entry.default_spec`
   写进 manifest（非空才写），撤掉「default_spec 样例值不保留」警告；entry
   convert 端点的 warnings 诚实缺口随之收窄（webview `convert` 透传，零改动）。
5. **CLI run/resume 零改动**：`_resolve_spec(res, args)` 已走 `res.default_spec`
   （`cli/cli.py`）——`ResolvedModule` 修好后 packed 自动获得
   `--spec > --spec-file > default_spec` 回落链，与 entry 形态对齐。
6. 库测试（`module_harness/tests/`）+ `docs/references/api.md` 补录 manifest
   契约键（packed `default_spec` 可选、形状 dict、缺省 = 无参考）。

## webview 侧（本仓库）

1. `server/api/build.py`：
   - `_assemble_pack`：`draft.default_spec` 非空 dict → manifest 写入该键；
     空 `{}`/缺省不写键——缺键 = 无参考，manifest 保持最小形状；
   - `_validate_draft`：`default_spec` 存在时须为对象（Fix B 同款形状检查，
     PUT 即拒形状逃逸）；
   - `decompile_module`：`draft["default_spec"] = manifest.get("default_spec")
     or {}`（替换硬编码 `{}`）——反解→更新往返保真。
2. 前端**零改动**：SpecDialog（`builder/ModuleBuilder.tsx`）编辑区原样激活；
   发起页（`ModuleDetail.tsx`）`detail.default_spec` 有值后「spec 参考」预填、
   「用参考 spec 尝试运行」自动生效。

## 端到端数据流

创建器 SpecDialog 填参考值 → 草稿 `default_spec`（PUT drafts，形状校验）→
组装写进 `module.json` → `validate_pack_dir`（ModuleLoader 校验形状）→ install →
模块详情 `detail.default_spec` → 发起页「spec 参考」预填/试运行；CLI run 无
`--spec` 时回落参考值；反解回读草稿，同名更新不丢。

## 边界与错误处理

- manifest `default_spec` 非 dict → `ModuleManifestError`（装载/校验期拒绝，
  HTTP 400）；草稿侧非对象 → PUT 400。
- `{}` 视同无参考（组装不写键、反解回 `{}`）。
- 反解读外部 pack 的 `default_spec` 形状前置检查同 spec_schema 惯例：真值非
  dict → 400（不进 500）。

## 测试与验收

- 库基线：`uv run pytest ../SpecModule/module_harness/tests/ -q -m "not smoke"`
  全绿（新增：loader 读键/形状拒收、detail 面透出、run 回落 packed、
  entry_to_pack 保留 default_spec）。
- 本仓库：`uv run pytest tests/ -q` 全绿（新增：组装含 default_spec → manifest
  有键；安装后详情透出；反解回读；空/缺省不写键）。
- 端到端：创建器建模块（schema + 参考 spec）→ 安装 → 模块库发起页出现参考 →
  「用参考 spec 尝试运行」发起成功 → 反解再更新参考不丢。
- 收尾：关闭 issue #22；`roadmap/finish.md` 归档（文档纪律）。
