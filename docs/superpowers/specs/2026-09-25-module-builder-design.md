# 模块构建器：组件库 + 可视化创建 packed 模块（设计定稿）

> 2026-09-25 定稿。用户指令核心：**新板块——module 的可视化创建；只有 script 不方便
> 完全图形化，以代码文件上传形式提供。**
> 关键决策（问答收敛）：目标形态 packed（三种 kind 功能边界一致，packed 就是为结构化
> 操作准备的）；v1 只做从零新建；库组件被引用时**拷贝进包**（包永远自包含，零上游
> 改动）；界面组织走「构建」板块 + 画布中心（方案 A）。

## 定位与范围

- **v1 = 从零新建 packed 模块**：可视化搭建 tasklist 图（节点/边/guard/join）、
  spec_schema、default_spec、元数据 → 组装标准 pack 目录 → 库校验 → 安装进 store。
- **配套组件库**：harness/command/script/guard 定义与现成模块可沉淀入库反复选用；
  script/guard 走代码文件上传；模块可「以 submodule 形式存入库」。
- **明确后排**（不进 v1）：编辑/反解已安装模块、output 侧 spec_schema、库组件版本
  管理、prompt 模板文件、entry 形态生成、批量装库。

## 复用语义：拷贝进包

库的 loader 是**逐包自包含解析**（`requires` 须由本包 `provides` 或内置集满足，无跨包
解析机制）。因此组件库定位为 **webview 管理的资产池**：创建模块时，被引用的组件
**拷贝**进新包对应目录；submodule 引用在组装时从 store 整包 copytree 进
`submodules/<键>/`。包自包含 ⇒ 直接吃现有 `validate_pack_dir` / `install_pack` 语义，
**零上游改动**。运行时全局引用（改 loader 语义）是上游 feature，不做。

## 总体架构与数据流

```
组件库(store_home/library/) ──选用──→ 前端草稿(画布+表单) ──保存──→ library/drafts/<名>.json
                                                                        │ 校验/安装
                                                                        ▼
                                            server 组装临时 pack 目录 → validate_pack_dir（库函数）
                                                                        ▼
                                            install_pack(source="webview-builder")
                                              → store/modules/<名>/ + manifests/<名>.json
                                                                        ▼
                                            既有模块库视图可见 → 复用发起表单 mock 试运行
```

### 前端改动面

| 文件 | 改动 |
|---|---|
| `web/src/components/ActivityBar.tsx` | `Tab` 联合加 `"build"`，`TABS` 加项（lucide `Hammer`） |
| `web/src/components/TabBar.tsx` | `TabKind` 加 `"build"` + 图标分支 |
| `web/src/App.tsx` | `DynTab.kind` 加 `"build"`（多草稿多实例页签，id=`build:<名>`）+ tabItems/渲染分支/`openBuilder` 回调 + 侧栏 `build` 分支 |
| `web/src/components/LibraryPanel.tsx` | **新**：侧栏组件库面板（分组浏览/上传/删除/草稿列表/新建模块入口） |
| `web/src/components/builder/ModuleBuilder.tsx` | **新**：创建器主区（操作条 + 画布 + 配置面板 + DSL 预览） |
| `web/src/components/builder/EditableCanvas.tsx` | **新**：React Flow 编辑画布（编辑接线独立于只读 GraphView） |
| `web/src/api.ts` | 库/草稿/组装端点封装与类型 |

### 后端：`server/api/build.py`（新 router，app.py 注册）

- **组件库 CRUD**
  - `GET /api/library` → `{harnesses, commands, scripts, guards, submodules, drafts}` 分组清单
  - `POST /api/library/harnesses|commands`（JSON 表单体，用库 `HarnessConfig.from_dict` /
    `CommandConfig.from_dict` 实例化验形）
  - `POST /api/library/scripts|guards`（multipart 文件上传，仅 `.py`，stem=注册名）
  - `DELETE /api/library/{kind}/{name}`（submodule 仅移除索引，不删包）
- **草稿 CRUD**：`GET / PUT / DELETE /api/library/drafts/{name}`
- **组装安装**（请求体均为 `{draft: "<名>"}`，锚定已持久化草稿——前端先存草稿再校验/安装）
  - `POST /api/modules/packs/validate`（dry-run：组装临时目录 → `validate_pack_dir`，不落 store）
  - `POST /api/modules/packs`（组装 + validate + `install_pack`，成功返回模块详情）

### 统一 API 原则判断

组件库与组装是 webview 独有功能（库 loader 无跨包概念、无第二消费端），不违规；
组装只消费库现有 `validate_pack_dir` / `install_pack` / `store_home`，本层零校验逻辑。
新消费的库函数按增量补录 `../SpecModule/docs/references/api.md`（实施时做）。

## 组件库模型

物理位置锚定 `store.store_home()/library/`（与 `modules/`、`manifests/` 同根；
`SPECMODULE_HOME` 可覆盖，测试隔离走同一路径）：

```
library/
├── harnesses/<名>.json    # HarnessConfig.to_dict() 形状（表单创建）
├── commands/<名>.json     # CommandConfig 形状（表单创建）
├── scripts/<名>.py        # 文件上传，stem = 注册函数名
├── guards/<名>.py         # 同上，供 Flow guard 边引用
├── submodules.json        # 索引 [{name, added_at}]，指向已安装 packed 模块（不复制包体）
└── drafts/<名>.json       # 模块草稿
```

- **harness 表单**（对照 `HarnessConfig`）：`name`、`prompt_core`（多行，`{key}` 占位）、
  `prompt_modes`（键值对）、`notdo`（列表）、`model`/`temperature`/`think`、
  `mode`（text|image + image_size/image_dir）、`output_format`、`api_params`（JSON）。
- **command 表单**（对照 `CommandConfig`）：`command`/`timeout`/`cwd`/`env`/
  `capture_output`/`shell`。
- **script/guard**：只走文件上传（代码不适合图形化）；注册名 = 文件 stem，须过标识符
  校验；同名上传 = 覆盖更新。
- **submodule 入库**：从已安装 packed 模块列表挑名字记入索引；组装时才拷贝——索引轻，
  卸载过的模块组装时报缺失。
- **命名纪律**：全部复用 `validate_module_name`（`^[A-Za-z_][A-Za-z0-9_]*$`）；
  harness/command 同名保存 = 更新。

## 草稿数据模型（drafts/<名>.json）

```json
{
  "meta": {"name": "my_mod", "version": "0.1.0", "description": "..."},
  "spec_schema": [{"field": "raw_text", "type": "str"}],
  "default_spec": {},
  "nodes": [
    {"id": "n_1", "label": "Summarize", "type": "harness", "harness": "summarize",
     "is_start": true, "join": "AND", "position": {"x": 0, "y": 0},
     "inputs": {"text": "{spec.text}"}, "overrides": {"temperature": 0.3}}
  ],
  "edges": [{"id": "e_1", "from": "Summarize", "to": "Review", "guard": "has_issues"}],
  "updated_at": "..."
}
```

- 节点 `label` = tasklist 任务名（Flow 引用名，标识符）；`type` ∈
  harness|script|command|submodule，引用字段同名（`harness`/`script`/`command`/`submodule`）。
- script/guard/submodule 引用清单不单独维护——内嵌在节点/边上，组装时服务端从图推导。
- `overrides` = TaskDefinition 逐项覆盖（model/temperature/promptmode/prompt/
  outputformat/notdo/timeout/cwd 等）；submodule 节点用 `outputs` 映射替代 overrides。
- 新建草稿即弹名称（标识符校验）并建档，页签 `build:<名>`；重开恢复画布布局
  （`position` 持久化）。

## ModuleBuilder 交互

- **顶部操作条**：模块名（页签标签）+ 元数据对话框（名称/版本/描述）+「Spec」按钮
  （schema 编辑器：字段行 = 名 + 类型下拉 str/int/float/bool/list/dict/any + 增删行；
  default_spec 用现有 SpecForm 填值）+ Flow DSL 预览开关 + `[校验]` `[安装进 store]`。
- **主区画布**（EditableCanvas）：React Flow 编辑接线（`useNodesState`/`onConnect`）+
  dagre 自动布局按钮 + MiniMap/Controls/主题 token 复用；工具条「+节点」按四类型添加
  （harness/command 从库选、script 从库 scripts 选、submodule 从库索引选）；拖 handle
  连线；Delete 删除。
- **右侧配置面板**（点选滑出）：
  - 节点：label、`is_start` 开关、`join`（AND/OR）、类型特定区（库组件选择器 + 覆盖
    参数；submodule 另有 outputs 映射表）、**inputs 映射**（行编辑：字段名 → 生产者
    下拉 = 上游节点名 / `{spec.字段}`（schema 自动补全）/ 原始 token）。
  - 边：guard 选择（从库 guards，可空）。
- **安装成功直达**：切模块库页签选中新模块 → 复用现有发起表单 mock 试运行。

## Flow DSL / tasklist 生成

**服务端纯函数**（`server/api/build.py` 内 draft → `{Tasks, Flow}` 唯一实现；组装与
dry-run 共用）。**正确性最终由 `validate_pack_dir` 把关**——生成有误会被校验抓住。
UI 的 Flow DSL 预览面板展示 `validate` 端点返回的生成结果（前端零重复实现，不引入
前端测试设施——生态无 vitest，不破例）。

- Flow：起点节点加 `[...]`；guard 边 `A --|名|--> B`；非 AND join 节点追加
  `<名>.join: OR` 行；多起点支持（`[A] --> B` 多行）。
- Tasks：每节点 `{type, <type字段>: 引用名, inputs, ...overrides}`（submodule 节点为
  `outputs` 映射）。
- `POST /api/modules/packs/validate` 响应附生成的 `tasklist`（`{Tasks, Flow}`），
  前端预览面板直接展示（单一实现，见下节）。

## 组装安装（服务端流程）

1. 载入草稿 → `tempfile.mkdtemp` 建 pack 骨架。
2. 写 `module.json`：`{name, version, description, submodule: false,
   spec_schema: {"input": {...}}, requires: [], modules: [<submodule 键>],
   tasklist: {Tasks, Flow}}`。spec_schema v1 只编辑 input 侧（output 留空后排）。
3. 只拷**被引用的**组件进包（scripts/guards/harnesses/commands）；submodule 从
   `store/modules/<名>/` 整包 copytree 进 `submodules/<键>/`。
4. `validate_pack_dir`（零落盘）→ 失败 400 带结构化错误列表。
5. `install_pack(src, source="webview-builder")` → 成功返回模块详情（`detail_to_dict`）；
   **store 同名已存在 → 409 不覆盖**（库语义，提示改名或先卸载）。

## 错误契约

- 上传非 `.py` / stem 非标识符 → 400；harness/command 保存实例化验形失败 → 400 带
  `str(e)`；JSON body 缺必填（prompt_core/command）同路透出。
- 草稿：名称非法 → 400；不存在 → 404。
- 组装：submodule 源包已卸载 → 400 带缺失清单；validate 失败 → 400（errors 列表，
  前端文本列表 + 按节点名定位）；安装同名 → 409。
- 遵循全仓契约：查询 None → 404、操作异常 4xx 带 `str(e)`、未知资源 404。

## 测试与验收

- **pytest**（`SPECMODULE_HOME`/`SPECMODULE_BASE` 指 tmp_path 隔离）：库 CRUD 与上传
  契约（含非 .py 拒绝、覆盖更新）、草稿 CRUD、组装目录结构断言（module.json 形状/
  组件拷贝/submodule 嵌套/requires+modules 双向一致）、validate 失败 400、安装后
  `list_modules` 可见、同名 409。
- **前端**：`npm run build`（tsc）门禁 + 手工端到端（无单测设施，不引入）。
- **端到端验收**：构建器建「harness + script + guard 循环」最小模块 → 安装 → mock
  试运行跑通。

## 文档归档

- 本设计定稿落 `docs/superpowers/specs/`；roadmap.md 功能路线图加「模块构建器」阶段；
  完成后归档 finish.md；`../SpecModule/docs/references/api.md` 补录
  `validate_pack_dir` / `install_pack` / `store_home`（实施时）。
