# 已安装模块的编辑：反解 → 画布编辑 → 装回（设计定稿）

> 2026-09-28 定稿。用户指令核心：**新增已有 module 的编辑功能**（模块构建器后排项
> 「编辑/反解已安装模块」）。关键决策（问答收敛）：形态走**反解回构建器编辑**（非
> 元数据轻编辑/就地改包）；包内嵌组件导入组件库遇同名冲突**跳过并报告**（不静默
> 覆盖、不重命名）；装回双通道——**同名更新**（库 `apply_update`）+ **改名另装**
> （现有安装端点不动）。

## 定位与范围

- **编辑对象**：全部 packed 模块（pack 校验强制 manifest 带 `tasklist`，与创建来源
  无关——builder 产物与外部手工 pack 同权）。entry 模块（manifest 无 tasklist）与
  pip 模块（非 store 管理，覆盖会在搜索序里遮蔽 pip 原体）排除，UI 不出编辑入口。
- **闭环**：模块详情「编辑」→ 反解为构建器草稿（图/spec/元数据还原画布）→ 编辑 →
  校验 → 装回（同名更新或改名另装）。
- **零上游代码改动**：反解所需的图重建走 `query.build_run_graph` 的 tasklist 直渲染
  通道（无 run 建图，零 LLM）+ `query.graph_to_dict`；覆盖更新走 `store.apply_update`
  （备份 → 替换 → 失败自动回滚）。唯一库侧动作：`api.md` 补录 `apply_update` 消费。

## 数据流

```
store/modules/<名>/ (module.json + 组件目录)
    │  POST /api/modules/{name}/decompile
    │    ├ manifest.tasklist ── build_run_graph(tasklist 直渲染) ── graph_to_dict
    │    ├ 包内组件 → 语义比对 → 导入组件库（报告三态）
    │    └ spec_schema.output → 草稿透传字段（防静默丢失）
    ▼
library/drafts/<模块名>.json ── ModuleBuilder 画布编辑 ── [校验]
    │
    ├─ 改 meta.name → [安装进 store]（现有端点，另存新模块）
    └─ 名字未改 → [更新模块] → POST /api/modules/packs/update
              → _assemble_pack → validate_pack_dir（先于任何写入）
              → store.apply_update（备份+回滚）
```

## 后端（`server/api/build.py` 增补，无新文件）

### `POST /api/modules/{name}/decompile`

1. `store.resolve_module_full(name, search=get_search_paths())` → None 映射 404；
   `kind != "packed"` → 400。
2. 读包 `module.json`（缺失/解析失败 → 400）；取 `manifest["tasklist"]`。
3. `query.build_run_graph(name, tasklist=manifest["tasklist"], src=resolved.source)`
   → `(Graph, Tasklist)`；`query.graph_to_dict` 归一。建图失败（ValueError，如
   Flow 引用缺失组件）→ 400 透传消息。
4. **合成草稿**（module.json ↔ 图结构互补）：
   - 节点：`type`/引用字段/`inputs`/`overrides`/`outputs` 取自 `Tasks` 字典原始声明
     （`graph_to_dict` 不透出 overrides）；`is_start`/`join` 取自图节点。
   - 边：图边 `{from, to, guard}`（label 引用）→ 草稿边（节点 id 引用，服务端
     mint `n_<6hex>` 并映射）；guard 名随边保留。
   - `spec_schema.input` → `draft.spec_schema`（`{field,type}` 反转）；manifest
     `spec_schema.output` 存在 → `draft.spec_schema_output` 透传字段。
   - `default_spec` 恒 `{}`——packed 模块无 default_spec 概念（现状组装本就丢弃，
     语义一致）。
   - `position` 置 `{x:0, y:0}`——反解产物无布局，前端载入后自动重排。
   - `meta`：name/version/description 取 manifest。
5. **组件导入**（包内自包含副本 → webview 组件库）：harnesses/commands 按 JSON
   语义比对（parse 后相等），scripts/guards 按文本比对；库内同名不存在 → 写入
   （`imported`）；存在且内容一致 → 跳过（`existed`）；存在且内容不一致 → 跳过
   沿用库版本（`conflicts`）。submodule 目录不拷（引用按名组装，见 6）。
6. **submodule 引用检查**：逐个 `store.resolve_module`——可解析即不动（不写
   submodules.json 索引，组装不依赖索引）；不可解析 → `warnings`（提示更新组装
   时会失败，需先安装该 submodule 或替换引用）。
7. 落草稿 `drafts/<模块名>.json`（同名已存在 → 覆盖，UI 侧 confirm；
   `updated_at` 刷新），响应：

```json
{"draft": "<模块名>",
 "report": {"imported": ["harnesses/summarize"],
            "existed": ["scripts/check.py"],
            "conflicts": ["guards/has_issues"],
            "warnings": ["submodule 'sub_x' 未安装——更新组装前需先处理"]}}
```

报告四类均为字符串列表（`kind/name` 形状），前端直接渲染清单。
```

### `POST /api/modules/packs/update`（body `{draft}`）

1. `get_draft`（404 契约同现有）→ `meta.name`。
2. `resolve_module_full(meta.name)` → None 映射 404（`模块 '<名>' 未安装——安装走
   POST /api/modules/packs`）；`kind != "packed"` → 400（pip 同名体不覆盖）。
3. `_assemble_pack` → `validate_pack_dir` **显式先行**（失败 400，零写入；
   `apply_update` 内部虽带回滚，校验前置保持「先校验后写盘」纪律）。
4. `store.apply_update(name, pack)`（库语义：旧包移 `.bak` → 拷入 → 刷 manifest
   哈希/source 保留 → 失败自动回滚还原）。
5. 返回模块详情（`resolve_module_full` 现算 + `detail_to_dict`，同安装端点）。

### 既有函数小改（向后兼容）

- `_validate_draft`：允许可选 `spec_schema_output`（dict，缺省不校验内容——透传
  字段，builder UI 不编辑）。
- `_assemble_pack`：`draft.get("spec_schema_output")` 非空 → 写入 manifest
  `spec_schema.output`。无此字段行为不变。

## 前端

| 文件 | 改动 |
|---|---|
| `web/src/api.ts` | `decompileModule(name)` / `updatePack(draftName)` 端点封装 + `DecompileReport` 类型；`BuilderDraft` 加可选 `spec_schema_output` |
| `web/src/components/ModuleDetail.tsx` | packed 模块加「编辑」按钮 → 新 prop `onEdit(name)` |
| `web/src/App.tsx` | `onEdit` 接 `openBuilder` 前的反解编排：同名草稿存在 confirm 覆盖 → POST decompile → 报告面板（导入清单 + ⚠ 冲突/警告 + 「打开构建器」）→ `openBuilder` |
| `web/src/components/builder/ModuleBuilder.tsx` | ① 载入后全节点 position 为零 → 自动 dagre 重排一次（反解产物）；② 草稿名命中已装 packed 模块 → 操作条出现「更新模块」（confirm → saveNow → updatePack → 成功复用 installed 横幅）；「安装进 store」保留（改名另装）。已装判断：挂载拉 `GET /api/modules` 清单 + 安装/更新成功后刷新 |

- 反解报告面板放模块详情页内联（反解后停留详情页，用户看完报告再点「打开构建器」，
  避免报告被页签切换吞掉）。
- 草稿与已装模块同名命中判定用 `GET /api/modules` 返回的清单（含 kind 过滤 packed）。

## 错误契约

- 404：模块不存在 / 草稿不存在 / 更新目标未安装（含用户在编辑中改了 `meta.name`
  后点更新——按草稿当前名解析，不追踪原始名，404 消息引导走安装端点）。
- 400：非 packed 形态（entry/pip）、manifest 缺失或损坏、反解建图失败
  （ValueError 消息透传）、更新组装 validate 失败。
- 无 409：更新走 `apply_update`（备份回滚），同名冲突场景不适用；改名撞已装名仍由
  现有安装端点 409。
- 全程先校验后写盘；`apply_update` 失败自动回滚（库语义，本层零补偿逻辑）。

## 测试与验收

- **pytest**（`SPECMODULE_HOME` → tmp_path 隔离）：
  - 反解 round-trip：经**真实组装安装链路**造 fixture（现有端点造模块）→ decompile
    → 断言节点（type/引用/inputs/overrides/is_start/join）/边（含 guard）/起点还原、
    组件导入报告三态、spec_schema 反转正确。
  - output 侧保全：手写 manifest 带 `spec_schema.output` → decompile →
    `spec_schema_output` 透传 → update → 新 manifest 含 output。
  - 冲突路径：预置同名异内容库组件 → decompile → conflicts 报告且库内容未变。
  - 更新链路：安装 → 反解 → 改 draft → update → store 内容/manifest 哈希刷新；
    未安装名 404；validate 失败 400 且 store 不变。
  - 错误契约：未知模块 404、entry/pip 400。
- **前端**：`npm run build`（tsc）门禁 + 手工端到端（装→改→更新→再发起运行生效）。
- 库基线不受影响（零上游代码改动）：`uv run pytest ../SpecModule/module_harness/tests/ -q -m "not smoke"`。

## 文档归档

- `../SpecModule/docs/references/api.md` 补录 `apply_update` 消费（库仓库独立
  `docs:` 提交）。
- 本仓库：本设计定稿落 `docs/superpowers/specs/`；完成后 roadmap.md 后排项勾选 +
  finish.md 归档。
