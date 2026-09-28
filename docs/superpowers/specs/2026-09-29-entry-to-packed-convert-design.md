# entry 模块可编辑：转化为 packed（设计定稿）

> 2026-09-29 定稿。用户指令核心：**entry 也要可编辑——转化为 packed 来实现**。
> 方案 A（问答收敛通过）：库收编共享转化函数 `entry_to_pack`（CLI `publish` 单文件
> 转化提取重构 + 修复两处产物缺陷）→ server `convert` 端点（安装 + entry 文件退位）
> → 前端「转为 packed 编辑」串联既有反解闭环。

## 定位与范围

- **转化对象**：仅 `kind="entry"` 的已装模块（搜索单文件 `<name>.py`，模块级
  `entry` 变量）。packed/pip 形态不适用（packed 已有编辑闭环；pip 不归 store 管理）。
- **转化语义**：entry 是代码优先形态（`build_registry` 闭包 + 模板 + Python
  submodule 类），packed 是数据优先形态（manifest tasklist + 组件文件）。转化 =
  选定一个模板物化为自包含 pack：harness/command 取配置 JSON、script/guard 取
  函数源码、submodule 走类式 `SubModule.pack()`。产物装进 store，entry 文件退位
  （重命名 `.bak`），此后该模块走既有「反解 → 草稿 → 构建器 → 同名更新」闭环。
- **统一 API 原则**：转化逻辑收编库共享层（`module_harness/infra/entry_pack.py`），
  CLI `publish` 与 webview convert 共用；webview 侧零转化逻辑（薄映射 + 安装/退位
  策略）。库仓库独立提交 + `api.md`/`cli-usage.md` 补录。
- **顺手修复 `publish` 两处产物缺陷**（收编重构的自然结果）：
  1. guards 静默丢弃（旧代码 `sub.guards = []`）——tickflow Registry 的
     `get_guard()` 本可内省，带 guard 的模板（如 detailed loop）转出来是坏的；
  2. script/guard 注册名 ≠ 函数名时（如 `tl_academic` vs `_tl_academic`），
     物化文件 loader 加载必炸（`ns.get(stem)` 取不到）——名不一致补别名行。

## 库侧（SpecModule 仓库）

### 新增 `module_harness/infra/entry_pack.py`

`entry_to_pack(entry, *, template_name=None, out_dir=None) -> EntryPackResult`
（纯物化零副作用——只写临时目录，不碰 store；调用方负责安装与清理）：

- `EntryPackResult` dataclass：`pack_dir: Path`、`template_name: str`、
  `dropped_templates: list[str]`、`warnings: list[str]`。
- 模板选择：`template_name` 显式传 → 必须在 `entry.templates`（否则 ValueError）；
  缺省回落 `entry.default_template`（未声明 → ValueError，同 publish 文案）。
  其余模板进 `dropped_templates`。
- tasklist：`Tasklist.from_json(template["tasklist"])` → `to_dict()` 规一化写入
  manifest（无效模板 → ValueError 早期失败）；translation 通道不保留（packed
  无此契约）——非确定性翻译脚本无法静态表达，见诚实缺口。
- 组件提取（Mock client 建 registry，零 LLM；`build_registry=None` → 空 registry，
  tasklist 引用内置 harness 时不提取——运行期由 `SubModule._build_registry` 统一
  注册内置集）：
  - `Tasks` 逐项按 type 分流：harness（非内置名）→ `registry.harness_config`
    → `harnesses/<名>.json`；command → `commands/<名>.json`；script → body 函数
    （`inspect.unwrap` 剥 `@reg.script` 事件包装）→ `scripts/<名>.py`；
  - guard：Flow 文本出现的 guard 名 ∩ `registry.guard_names()` →
    `guards/<名>.py`（`get_guard` 取函数）；
  - 源码物化：`textwrap.dedent(inspect.getsource(fn))` + 头部
    `from __future__ import annotations`；**注册名 ≠ `fn.__name__` 时文件尾补
    别名行 `<注册名> = <函数名>`**（loader 按 stem 取函数）；
  - 提取失败即硬错误（harness/command 配置缺失、getsource 失败如 lambda/内置
    函数、tasklist 引用的 submodule 不在 `entry.submodules`）——转化产物必须
    自包含可运行，不静默出坏包。
- submodule：`entry.submodules` 全量 `cls().pack(pack_dir/submodules/<键>/)`
  （类式自包含；manifest `modules` 列全键）。
- manifest：name/version("0.1.0")/description/submodule: False/
  `spec_schema: {"input": entry.spec_schema}`/requires: []/modules/tasklist。
- `default_spec` 样例值不保留（packed manifest 无此契约键）→ warning。

### CLI `publish` 收编重构（`cli/cli.py`）

单文件形态分支改为消费 `entry_to_pack`：物化 → `install_pack`，输出与现有
一致（发布成功/失败文案）。行为变化：guards 现在导出（修复）；script 名不一致
现在可装载（修复）。目录形态分支不动。`cli-usage.md` publish 语义同步。

## server（webview 仓库，`server/api/build.py` 增补）

### `POST /api/modules/{name}/convert`，body `{template?: str}`

1. `_check_name` → `resolve_module_full`（ValueError → 400 损坏包防护，同款先例）
   → None 映射 404；`kind != "entry"` → 400（`仅 entry 可转化`）。
2. **防遮蔽 409**：`store.list_modules(search)` 同名来源里排除该 entry 自身后
   仍有其他来源（packed/pip/异目录 entry）→ 409（退位后名字必须唯一命中转化产物）。
3. `entry_to_pack(entry, template_name=body.template)`（ValueError → 400）。
4. `store.install_pack(pack_dir, source="webview-entry-convert")`（ValueError
   「已存在」→ 409，其余 → 400）。
5. **entry 文件退位**：`src.path`（`resolve_module_full` 的来源文件）重命名
   `<name>.py` → `<name>.py.bak`（discover 只 glob `*.py`，`.bak` 不参与发现；
   可逆——用户随时改回）。重命名失败（OSError，如 Windows 文件占用）→ 回滚
   `uninstall_pack` + 400，零半状态。
6. 返回 `{module: detail_to_dict(现算详情, kind=packed), warnings: [...]}`。

安装先行、退位后置：任何失败路径都不留下「entry 退位但包没装上」的状态。

## 前端（webview 仓库）

| 文件 | 改动 |
|---|---|
| `web/src/api.ts` | `convertModule(name, template?)` 封装 + `ConvertResult` 类型 |
| `web/src/components/ModuleDetail.tsx` | entry 形态加「转为 packed 编辑」按钮：confirm 弹窗说明「entry 文件将重命名 .bak 退位、转化产物装进 store」；`templates.length > 1` 时弹模板选择（列出模板名，缺省 default_template）；warnings 在转化后报告区透出 |
| `web/src/App.tsx` | `onConvert` 编排：POST convert → 详情刷新（kind 翻转为 packed）→ 直接串联既有 `decompileModule` 反解流程（报告面板 → 打开构建器），转化 warnings 合并进报告区展示 |

转化与反解分两步调用、前端串联（端点保持单一职责）；反解报告面板复用现状。

## 诚实缺口（warnings 透出，不静默）

- **动态翻译通道丢失**：entry 模板经 translation script 产 tasklist；若脚本非
  「返回常量 tasklist」型（如按 spec 分形），转化只保留模板静态 tasklist——
  warning「模板翻译通道未保留，按静态 tasklist 转化」。
- **闭包依赖**：getsource 只取函数体文本；引用模块级常量/辅助函数的 body 物化后
  装载通过、运行期才炸——warning 列出全部物化 script/guard 名，提示在组件库
  检查脚本文本（转 packed 后即可编辑，正是闭环意义）。
- **多模板**：每次转化取一个，其余进 `dropped_templates`（warnings 展示）；
  需要另一模板形态 → 编辑 tasklist 演化（v1 不做多产物命名）。
- **default_spec 不保留**（前述）。

## 错误契约

- 404：模块不存在。
- 400：非 entry 形态、模板不存在/未声明 default_template、转化提取失败
  （ValueError 消息透传）、entry 文件退位失败（已回滚卸载）。
- 409：同名其他来源防遮蔽、store 同名已存在。
- 库侧 `entry_to_pack`：ValueError 携带可直接面向用户的消息；物化失败零残留
  （临时目录调用方清理）。

## 测试与验收

- **库侧**（`../SpecModule/module_harness/tests/`）：fixture entry 模块（含
  harness/script 注册名≠函数名/guard/submodule 类）→ `entry_to_pack` →
  `validate_pack_dir` 通过 → `ModuleLoader().load` 可装载（script/guard 函数
  可解析）；无 default_template、缺组件、getsource 失败 → ValueError。
- **webview**（`tests/`）：fixture store（tmp_path + entry 文件）→ convert 200
  （kind 翻转、entry 文件成 `.bak`、warnings 存在）；非 entry 400；同名其他来源
  409；未知模板 400。
- **验收**：`npm run build` + 全量 pytest；手工链路——对 store 里
  `academic_writer` 执行转化 → 反解 → 构建器出图。
