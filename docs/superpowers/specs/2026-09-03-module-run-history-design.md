# 完整前端：模块库 + 运行历史管理 + 发起运行（2026-09-03 定稿）

> 需求：可视化管理升级为完整 specmodule 前端——①本地 module 管理（浏览+详情）
> ②运行历史查看+删除 ③选择 module 输入 spec（模板化 spec 填表）④运行 module。
> 定位：roadmap 阶段 2「可视化管理」切片的实现轮次。

## 范围决策（ brainstorming 澄清记录）

- 模块管理 = **浏览 + 详情**；store 生命周期（install/uninstall/update/publish）
  与 init 脚手架入口**不做**，记 roadmap 后排。
- 运行历史 = **查看 + 单条删除**；重命名、复跑（同 spec 重启）、中间快照复跑
  入口、批量删除记 roadmap 后排。
- 前端导航 = **顶部视图切换**（无 router）；每个视图自包含组件，壳层薄，
  视图组织形式后续可改而视图内部不动。
- 库侧收编 = **全量**（统一 API 原则完全兑现）；运行发起端点两案相同：
  子进程拉官方 CLI `run`，完全镜像现有 resume 端点模式（进程内 Module.run
  属消费端重复接线，违规）。

## 库侧收编（SpecModule 仓库，独立提交，遵循其 AGENTS.md）

1. **`query.list_runs(base_dir=None) -> list[dict]`** — run 枚举收编（现状
   server 自己扫目录即违规点）。扫 `<base_dir>/.specmodule/runs/*/`，每 run
   读 status.json + run.sqlite 存在性，返回
   `[{run_id, module, phase, tick, error, updated_at, has_sqlite}]`，
   updated_at 降序。status.json 损坏/缺失的 run 以 `phase="unknown"` 收入
   不跳过（删除入口要对坏目录可用）。module 取 status.json 的 `module`
   字段（见 4），缺失 → None。
2. **`query.delete_run(run_id, base_dir=None) -> bool`** — 删除 run 目录整树
   （含 sqlite WAL 侧车）。run_id 含路径分隔符/`..` 直接拒（返回 False）；
   目录不存在 → False（端点映射 404）。放 query.py 有 `create_checkpoint`
   先例。运行中进程库侧不可知，活性防护是消费端职责（见 server 表）。
3. **模块详情归一读取** — CLI 私有类 `_ResolvedModule`（cli.py：entry/packed
   归一的 `description`/`default_template`/`default_spec`/`spec_schema`/
   `templates`/`submodules` 访问）提炼为公共 **`store.ResolvedModule`** +
   **`store.resolve_module_full(name, search=None) -> ResolvedModule | None`**
   （未找到 → None；packed 加载失败抛 ValueError 带原因）。CLI
   `_resolve_module_cmd` 改为复用（保留 `--modules-dir` 旧语义分支）。
   另收编 detail 字典出口 `store.detail_to_dict(resolved)`：
   `{name, kind, path, version, description, default_template,
   templates: [名...], default_spec, spec_schema, submodules: [名...]}`。
4. **status.json 补 `module` 字段（溯源缺口销项）** — `Module.__init__` 增
   可选 `module: str | None = None`；`entry.build_module` 自动传
   `module=self.name`（CLI/MCP/web 零改动受益）；`_write_phase` 写入
   `"module"` 键；`query_run_status` 读出 `ModuleStatus.module: str | None`
   （旧 run 无此字段 → None，消费端回落 run_id 启发式）。roadmap「已知偏差」
   节的模块溯源项正式移除。
5. **CLI 补子命令** — `specmodule runs [--json]`（list_runs 列表展示）+
   `specmodule delete-run <run_id>`（删除并打印移除的目录；不存在报错退出非零）。
6. **api.md 补录**以上全部（统一 API 原则条款）；库仓库独立提交（feat×2 +
   docs）→ 发版 → 本仓库同步依赖。

## server 端（本仓库，全部薄映射）

| 端点 | 映射 | 错误契约 |
|---|---|---|
| `GET /api/runs` | `query.list_runs` + 逐 run `control.read_control` 叠加 `paused` | 查询层不抛；server 删除自己的目录扫描代码 |
| `GET /api/modules/{name}` | `store.resolve_module_full` + `store.detail_to_dict` | 未找到 404；ValueError（加载失败）400 带 str(e) |
| `DELETE /api/runs/{id}` | `query.delete_run` | 不存在 404；`phase=running` 且无 `?force=true` → 409「先取消」；注册表有活子进程 → 409 |
| `POST /api/runs` | spawn 官方 CLI `run` | 见下 |

**`POST /api/runs`（发起运行，镜像 resume 端点模式）**：

```
body {module, spec?, template?, run_id?, max_ticks=100, mock=false}
→ 校验：模块可解析 404 code=module_unresolved；run_id 非法 400；
  run 目录已存在 409（防覆盖既有历史）；注册表同 run_id 活进程 409
→ run_id 缺省 server 生成 {module}_{6hex}（对齐 SubModule 命名惯例）
→ spec 非 null 落临时文件走 --spec-file；null → 不传，CLI 自动回落
  entry.default_spec；两皆无 → CLI 报错落 process.log（server 不重复校验）
→ Popen([python, -m module_harness.cli, run, --module M, --run-id id,
        (--spec-file f), (--template t), --max-ticks N, (--mock)],
       cwd=SPECMODULE_BASE, stdout=<run_dir>/process.log)
→ 202 {started, run_id, pid, module}
```

- 注册表 `_PROCS` 与 resume 共用 → `/process` 观测与 `/terminate` 硬终止对
  新 run 自动生效。
- tasklist 通道不开放（属恢复/阶段 3 直渲染场景）。
- template 可选 → `--template`；缺省 CLI 回落 `default_template`。
- 新 run 的 status.json 由子进程 Module 写出后即被现有 WS 流与 runs 列表
  覆盖（零额外管道）；spawn 后图 404 窗口期（module_inputs 未归档）由前端
  失败区兜底（见前端节）。

## 前端（web/，无新依赖）

**App 壳层**：顶部视图切换（模块库 / 运行历史 / 运行视图），`useState` 存
视图名，不引 router。每个视图自包含组件；有当前 run 时默认运行视图。

**ModulesView 模块库**：左列表（名称/kind 徽章/版本/描述）+ 右详情面板
（描述、来源路径、模板列表 default 标注、spec_schema 字段表、default_spec
预览）。头部「运行…」按钮 → RunDialog。

**RunDialog 运行对话框**（交互模式镜像 ResumeDialog）：

- **SpecForm 填表区（本轮核心特性）**：
  - 有 `spec_schema` → 按声明字段渲染类型化控件：`str`→文本框（长文本
    textarea）、`int`/`float`→数字框、`bool`→勾选框、`list`/`dict`/`any`→
    字段级 JSON 子编辑器（即时校验）；未声明字段不出现（JSON 模式可补）
  - 无 schema 有 `default_spec` → 按 default_spec 键生成同款表单（值类型
    按预填值推断）
  - 两者皆无 → 纯 JSON 编辑器
  - 「表单 ⇄ JSON」双模式随时切换，双向同步，JSON 即时校验（复用恢复
    对话框编辑器增强）
- 模板选择：多模板显示 select（default 预选），单模板隐藏
- run_id 预填 `{module}_{6hex}` 可改 + max_ticks + `--mock` 勾选
- spec 为空且模块无 default_spec → 提交禁用并提示
- 提交 202 → 切运行视图打开新 run

**RunsView 运行历史**：RunList 升格全宽历史视图：module 名（status.module
回落启发式）、phase 徽章、tick、更新时间、错误摘要；行内「查看」进运行
视图、「删除」——终态确认框后删；running 态提示先取消或「强制删除」
（force 二次确认）。

**运行视图**：GraphView/NodePanel/RunControls/WS 流原样搬入容器，功能
不变。增强：图加载失败区（新 run 无 module_inputs 归档的 404 窗口）挂
process.log 尾部展示（`GET /process` 轮询复用）——CLI 启动期失败界面可见。

## 测试与提交顺序

- **库侧**：list_runs / delete_run / ResolvedModule+detail_to_dict /
  status module 字段 单测（tmp_path fixture store）；库基线
  `python -m pytest ../SpecModule/module_harness/tests/ -q -m "not smoke"` 全绿。
- **本仓库 server**：新端点测试覆盖映射 + 错误契约（404/400/409/202）；
  spawn 一律 monkeypatch `_spawn`；fixture 模块 `tests/modules/` entry 文件
  （SPECMODULE_PATH）；`GET /api/runs` 载荤断言含 module/has_sqlite/paused。
- **前端**：不引测试框架（生态惯例）；验收 = `npm run build` 通过 + M1/M2
  mock E2E：模块库发起 academic_writer（双模板表单）→ 运行 → 图视图实时 →
  历史列表 module 名正确 → 删除 run。
- **提交顺序**：库仓库 feat×2 + docs×1 → 发版 → 本仓库同步依赖 → server +
  web + roadmap 变更日志 + AGENTS.md 端点表更新。

## 记入 roadmap 后排（本轮不做）

store 生命周期管理界面（install/uninstall/update/publish）、init 脚手架
入口、run 重命名、复跑（同 spec 重启）、中间快照复跑入口、批量删除。
