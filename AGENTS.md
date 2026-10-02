# Repository Guidelines

## Project Overview

`SpecModule_webview` is the **visualization consumption channel** for the SpecModule LLM framework: an independent frontend SPA + FastAPI thin backend that visualizes and manages specmodule runs. The library lives in the sibling repo [SpecModule](https://github.com/MountLynx/SpecModule) (PyPI package `specmodule`). The library's own stdlib visualization switch (`module_harness/orchestrate/feed.py`, zero-dependency http.server) only provides the minimal "see it running" form; **all rich interaction lives here**.

**Thin layer, zero business logic.** The library's query functions map 1:1 to HTTP endpoints; `module_harness/infra/query.py` was explicitly designed as the shared query layer for CLI/MCP/Web consumers. Import it, never reimplement. Anything that looks like logic belongs upstream in the library repo (see 统一 API 原则 below).

**Current state: 阶段 0 HTTP 后端层 + 阶段 1 运行时图视图 + 运行控制（cancel/pause/resume/rollback）已落地**（2026-08-29 / 2026-08-31 实施，设计定稿见 roadmap/finish.md「运行时图视图设计」「运行控制设计」节）：`server/` FastAPI 薄层（运行读端点 + 图端点 + 控制面端点 + WS 流）与 `web/` SPA（Vite + React + Tailwind + React Flow + dagre）均已实现、测试全绿；**TreeChat 整合一/二/三期已落地且对话引擎已收编**（2026-09-10 / 2026-09-14，见 docs/superpowers：一期壳层重组 + 二期对话引擎并入与顶部页签制 + 三期 chat as modules——对话回合 SSE 流式 + 模式入口；2026-09-14 起引擎以顶级 `treechat/` 包收编进本仓库、挂载常开，前端 `web/src/chat/` 为移植副本,原 `../Treechat` 仓库冻结）；后续（业务 run 联动收口（chat spec 卡片 → 发起业务 run）、状态面板/审阅时间线/产出对比）按 roadmap/roadmap.md 推进。Acceptance target: M1 + M2 modules fully wired — runtime visualization + output comparison.

## Architecture & Data Flow

```
browser SPA → HTTP / WS → FastAPI thin layer (server/) → specmodule library (module_harness) → tickflow engine (tickflow-py)
                                                                  │
                                                                  └→ <base_dir>/.specmodule/runs/<run_id>/run.sqlite + status.json + stream.log
```

Library interfaces → endpoint mapping (all verified in `../SpecModule/module_harness/`):

| Endpoint | Library call | Shape |
|---|---|---|
| `GET /api/runs` | `query.recent_runs(base_dir=None, limit=100)`（库共享快速列表：status.json mtime 前 N 条完整行 + total 计数，2026-09-15 根修）+ 逐行 `control.read_control` 叠加 `paused` | `{runs: [{run_id, module, phase, tick, error, updated_at, has_sqlite, paused}], total}`；成本与历史规模解耦（更早历史不展开，UI 提示 CLI `runs` 查看）；前端列表不做周期轮询——手动刷新 + 事件钩子（发起/删除/行内控制/页签终态）；`module` = status.json 溯源字段（旧 run → None，前端回落 run_id 启发式）；status.json 缺失/损坏 → `phase="unknown"` 收入不跳过（删除入口对坏目录可用） |
| `GET /api/runs/{id}/status` | `query_run_status(module_id, base_dir=None) -> ModuleStatus \| None` | `{module_id, phase, status, tick, fireable, fired, outputs, node_states, error, updated_at}` |
| `GET /api/runs/{id}/timeline` | `build_timeline` + `timeline_to_dict`; filters `filter_failed/filter_tick/filter_node` | `{module_id, latest_tick, entries: [{tick, node, status, output, error}]}`; entry status `ok\|failed\|aborted` |
| `GET /api/runs/{id}/checkpoints` | `build_checkpoints` + `checkpoints_to_dict` | `{module_id, checkpoints: [{target, tick, kind, fired, label}]}`; `target` = direct resume arg (`"<tick>"` or `"manual:<label>"`) |
| `GET /api/runs/{id}/snapshot` | `load_snapshot_summary(module_id, *, tick=None, base_dir=None) -> dict \| None` | `{tick, status, fireable, fired, outputs}`（outputs = 各节点最新值） |
| `GET /api/runs/{id}/feed` | `query_run_status` + `build_timeline` + `build_checkpoints` 组合（镜像 feed.py 的 JSON 组合） | feed.py 兼容结构：`{run_id, status, timeline, checkpoints}` — v1 前端基准 |
| `POST /api/runs/{id}/checkpoints` | `create_checkpoint(module_id, label, *, tick=None, base_dir=None) -> dict` | `{label, tick, overwritten}`；label 自动补 `manual:` 前缀；无运行/无快照/tick 不存在 → `KeyError` 带可用清单 |
| `GET /api/modules` | `store.list_modules(search=store.search_paths(base_dir), include_pip=True)`（搜索路径显式锚定 base_dir） | `{modules: [{name, kind: entry\|packed\|pip, version, description, path}], search_paths: [str]}`（实际扫描目录，UI 透出「扫描来源」） |
| `GET /api/modules/{name}` | `store.resolve_module_full(name, search=...) -> ResolvedModule \| None` + `store.detail_to_dict` | `{name, kind, path, version, description, default_template, templates: [名], default_spec, spec_schema, submodules: [名]}`；未找到 → 404；加载失败（ValueError）→ 400 带 str(e) |
| `GET /api/runs/{id}/graph?module=` | `build_run_graph(module_name, run_id, *, base_dir=None, ...) -> (Graph, Tasklist) \| None`（module_inputs 归档重建，零 LLM）+ `graph_to_dict` 序列化（均库共享层）+ `query.node_artifacts` 产物叠加 | `{run_id, module, phase, tick, graph: {nodes: [{id, label, type, is_start, join, inputs}], edges: [{from, to, guard}], starts}, node_states: {id: {fired_count, last_status, last_tick, running}}, artifacts: {node_id: [{index, key, name, path, kind, size, modified}]}}`（artifacts = 按节点产物 overlay，`kind` ∈ deliverable\|intermediate，None→`{}`）；模块名解析序 `?module=` > status.json `module` 溯源字段 > run_id 启发式，解析失败 404 带 `ValueError` 消息；无直渲染通道（`POST /api/graph/render` 推迟阶段 3） |
| `GET /api/runs/{id}/nodes/{node}/artifacts/{index}` | `query.node_artifacts(run_id, base_dir=None)` 现算 overlay → node/index 命中 → `FileResponse`（attachment） | 200 流式下载（中间产物与交付物统一通道）；404 无 run/无该节点/序号越界/文件已删（存在性锚定使已删文件不进 overlay）；410 仅计算→响应竞态护栏；客户端只给 node+index，路径永不为客户端输入 |
| `GET /api/runs/{id}/control` | `control.read_control(module_id, base_dir=None) -> dict \| None` | `{run_id, control: {action, reason, requested_at} \| null, paused}`；`paused` = `control.action == "pause"`；未知 run → 404 |
| `POST /api/runs/{id}/control` | `control.request_control(module_id, action, *, reason=None, base_dir=None) -> dict`（action ∈ `cancel\|pause\|unpause`） | 写 control.json（运行进程 tick 边界协作消费）→ 同 GET 形状；非法 action → 400；未知 run → 404 |
| `GET /api/runs/{id}/inputs` | `query.read_module_inputs(module_id, base_dir=None) -> dict \| None` | `{run_id, spec \| null, tasklist \| null}`（module_inputs 存档；恢复对话框预填上次输入） |
| `POST /api/runs` | **子进程拉起官方 CLI**：`[sys.executable, -m module_harness.cli, run, --module M, --run-id id, (--spec-file f), (--template t), --max-ticks N, (--mock)]`，`cwd=SPECMODULE_BASE`，stdout → `<run_dir>/process.log`（复用 resume 的 spawn 机制/注册表） | body `{module, spec?, template?, run_id?, max_ticks?=100, mock?=false}` → 202 `{started, run_id, pid, module}`；`run_id` 缺省 server 生成 `{module}_{6hex}`；模块未解析 → 404 `code=module_unresolved`、加载失败（ValueError）→ 400、非法 run_id → 400、run 目录已存在 → 409（防覆盖历史）、注册表同 run_id 活进程 → 409 |
| `DELETE /api/runs/{id}` | `query.delete_run(run_id, base_dir=None) -> bool` + 消费端活性防护 | `{run_id, deleted: true}`；不存在 → 404；`phase=running` 且无 `?force=true` → 409「先取消或强制删除」；注册表有活子进程 → 409（force 也不例外——进程仍在写该目录） |
| `POST /api/runs/{id}/resume` | **子进程拉起官方 CLI**：`[sys.executable, -m module_harness.cli, resume, target?, --module M, --run-id id, (--spec-file f)\|(--tasklist f), --max-ticks N, (--mock)]`，`cwd=SPECMODULE_BASE` | body `{module?, target?, spec?, tasklist?, max_ticks?=100, mock?=false}` → 202 `{started, run_id, pid, module, target}`；无 status.json → 404、无 run.sqlite → 400、运行中/已有恢复进程 → 409、模块未解析 → 404 `code=module_unresolved`、非法 target → 400 |
| `GET /api/runs/{id}/process` | server 内存进程注册表 + `process.log` 尾（8KB） | `{run_id, running, pid, started_at, log}`（resume 子进程观测；CLI 启动期失败只在此可见） |
| `POST /api/runs/{id}/resume/preflight` | `query.check_resume_compat_from_run(module, run_id, new_tasklist=..., target=..., base_dir=...)`（库共享组合函数） | `{target, target_tick, executed_nodes, hard_errors, warnings}`；不 spawn 不写状态；兼容性 hard_errors 是 200 载荷；无 run.sqlite → 404、tasklist 非法/建图失败（ValueError）→ 400；`module` 缺省 = status.json 溯源 > run_id 启发式（注：库内部建图仍按 cwd 锚定解析，base_dir/modules 独有模块的预检需 SPECMODULE_PATH，残留缺口转 [issue #7](https://github.com/MountLynx/SpecModule_webview/issues/7)） |
| `POST /api/runs/{id}/process/terminate` | server 注册表 `Popen.terminate()`（Windows=硬杀） | `{run_id, terminated: true, pid}`；注册表无活进程 → 409（CLI 手起 run 不在观测范围）；不代写终态——status 残留 running 由前端停滞提示引导强制恢复 |
| `GET /api/runs/{id}/artifacts` | `query.read_artifacts(run_id, base_dir=None)` | `{run_id, artifacts: [{index, name, kind, path, size, modified}]}`；无 run → 404；无/损坏清单 → 空数组；清单由库终态（done/truncated）收尾写 `<run_dir>/artifacts.json`——tasklist 顶层 `Artifacts` 声明制（glob + pick=latest/all），cancelled/aborted 不收集 |
| `GET /api/runs/{id}/artifacts/{index}` | 清单 index → `FileResponse`（attachment） | 200 流式下载——客户端只给 index，路径按清单自查（无遍历面）；index 越界 → 404；文件已删 → 410；前端 RunView 终态产物条消费 |
| `/treechat/api/*`（整树挂载） | `treechat/webapp create_app`（treechat 库自带服务层，`server/chat.py mount_chat` 零重复接线） | 会话 CRUD/卡片/健康 + `GET /api/modes`（模式枚举）；**轮次 turn/retry 为 SSE 流式**（`event: start` 节点预告 → `token` 逐 token / `node_start`/`node_end` 节点进度 → `done`/`error` 终帧，`done`/`error` 全量回流 ConvState）；LLM 失败 → SSE `error` 帧 `{error, state}`（user 节点已落盘可重试；REST 502 契约已退役）；模式 = 对话型 module（会话创建带 `category`，mode↔module 映射走 treechat 配置，v1 内置 direct/grilling——grilling 已吸收 domain-modeling）；`session_delete` 与轮次共用 registry 锁（删除排在在飞轮次后，无幽灵文件）；`client_factory` 锚定 `project_root=base_dir`（与 SpecModule 共用配置链/env/llm 客户端）；会话数据 `<base_dir>/.treechat`（`TREECHAT_DATA_DIR` 可覆盖）；treechat 未安装 → 跳过挂载，其余端点不受影响 |
| `GET /api/library` + `GET/PUT/DELETE /api/library/{kind}/{name}` | `store.store_home()/library/` 目录操作；harness/command 经 `HarnessConfig/CommandConfig.from_dict` 实例化验形；submodule 登记经 `store.resolve_module`（仅 packed/pip）；草稿经 `_validate_draft` 轻校验 | kind ∈ harnesses/commands/scripts/guards/submodules/drafts；code 类仅 UTF-8 .py（stem=注册名）；`GET /library` 分组清单 `{harnesses, commands, scripts, guards, submodules, drafts}` |
| `POST /api/modules/packs[/validate]` | 草稿 → `draft_to_tasklist`（本层唯一 tasklist 生成实现）→ 组装临时 pack（引用组件拷贝进包 + submodule 整包 copytree）→ `store.validate_pack_dir` → `store.install_pack(source="webview-builder")` | body `{draft}`；validate 200 `{ok, manifest, tasklist}`（dry-run 零落盘）/ 400；install 200 模块详情（detail_to_dict）/ 400 校验·组件缺失 / 409 同名已存在（防遮蔽） |
| `POST /api/modules/{name}/convert` | 库 `entry_to_pack`（`module_harness/infra/entry_pack.py` 共享物化层，CLI publish 同用）→ `store.install_pack(source="webview-entry-convert")` → `store.install_submodules`（包内 submodule 递归登记为独立 packed 模块——反解/更新组装按名解析的前提；失败回滚卸载父包，skipped 交 warnings）→ entry 文件重命名 `.bak` 退位（失败回滚卸载，零半状态） | body `{template?}`（多模板 entry 指定转化模板，缺省 default_template）；200 `{module: 详情(kind 翻转 packed), warnings: [诚实缺口——动态翻译通道/闭包依赖/多模板丢弃/default_spec 不保留 + submodule 跳过登记（已存在防遮蔽/目录键≠manifest name）]}`；非 entry 400 / 未找到 404 / 同名其他来源·store 同名 409（退位后须唯一命中）/ 提取失败·登记失败·退位失败 400；产物自包含可装载（script/guard 注册名 ≠ 源码 def 名自动补别名行），装完接入既有反解编辑闭环 |

**Run lifecycle.** `Module.run()` is a coroutine that completes when the run finishes — in-process cancel = cancel the asyncio task; `max_ticks` (default 100) is the only run limit. `status.json` phase machine: `idle → translating → reviewing → building → ready → running → done | aborted | cancelled | truncated`（truncated = max_ticks 耗尽，终态可 resume）。 `status.json` is written atomically by the Module at every phase; `run.sqlite` gets a snapshot every tick (persist mode). The `feed.py` polling pattern (`GET /feed.json?run_id=` composing status+timeline+checkpoints) is the reference for both the compat endpoint and the WS stream design.

**Run control (cross-process).** cancel/pause ride the library `control.json` protocol (`module_harness/infra/control.py`; library hooks consume requests at tick boundaries — **cancel is consumed at `on_tick_end`**: the engine rewrites `runner.status` at every tick end, so a CANCELLED set at tick_start is clobbered; pause holds at tick_start until unpause/cancel). `Module(control=False)` disables. Requests are one-shot (delete-on-consume) and `run()/resume()` clears stale requests at start. Resume/rollback after end = the library `Module.resume(rollback_to)` semantics (tick / `manual:<label>` / latest, with compat hard-checks), executed by the server **spawning the official CLI** (`specmodule resume`) as a subprocess — CLI wiring (spec resolution, LLM client, module resolution) is reused wholesale, never duplicated in server code; spec/tasklist go through temp files (`--spec-file`/`--tasklist`, Windows argv length limits). The child writes `status.json`/`run.sqlite` → the existing WS stream monitors it with zero extra plumbing. An in-memory registry (`{run_id: Popen}`) enforces single-writer (409 on double spawn); server restart loses the registry but the child keeps running (monitoring only depends on artifacts).

**Monitoring.** Progress rides runner hooks `hooks={"on_tick_start": cb(tick, fireable), "on_fire": cb(NodeState), …}` and `EventBus` typed events. Persistence is file-based and cross-process readable: `run.sqlite` (tables `snapshots`, `firings`, `checkpoints`, `module_inputs`; WAL) + `status.json`.

**Key constraints**
- `base_dir` 缺省锚**用户主目录**（env `SPECMODULE_BASE` 可覆盖，测试/多运行根才需要设）——数据根统一 `~/.specmodule`：runs（`~/.specmodule/runs/`）、模块 store、chat 会话（`~/.treechat/`）同根；本地启动 webview 不再散落运行记录进仓库目录（2026-09-16 根修：此前 cwd 锚定导致 module 索引连到原仓库 example、`../SpecModule/.specmodule/runs` 积累 5109 条测试 run）。**模块搜索锚定同一纪律**：所有模块枚举/解析调用（`list_modules`/`resolve_module`/`resolve_module_full`）显式传 `search=store.search_paths(base_dir)`（`server/deps.py get_search_paths`）——server 模块视图 ≡ spawn 子进程 CLI 视图，放运行根 `modules/` 下的模块不被误判 module_unresolved；`GET /api/modules` 载荷附 `search_paths` 透出实际扫描目录。
- Failed runs write only `status.json` (no `run.sqlite`) — status/timeline endpoints must tolerate a run dir without sqlite (query layer returns `None` — map to 404, never raise).
- Single-writer per `run_id` (WAL) — serialize any cross-process operations touching the same run.
- `run_id`: Module default `mod_<8hex>`, SubModule `{name}_<6hex>`; consumers may supply their own (CLI `--run-id`). Webview treats `run_id` as opaque path segment.
- **Real-time without touching the library**: the WS stream (`/api/runs/{id}/stream`) polls `query_run_status` + `control.read_control`（paused 标志）+ `query.node_run_summary`（按节点累计运行摘要）+ `query.node_artifacts`（按节点产物 overlay，与 node_states 同拍）+ `query.read_stream`（stream.log 追尾，锚定最后一条 `run_start`）on the server side（0.2s），status 按 `(phase, tick, updated_at, paused)` 签名变化才推（附按节点累计 `node_states` 与 `artifacts`——客户端纯覆盖、免逐 tick 增量记账，轮询跳拍/断线重连不丢完成态；附 `stream_mtime` 辅助心跳）、新 stream 记录批量推 `{"type": "stream", records}`（先于 status）、终态（含 truncated）推完 close(1000) — no library hooks, no push mechanism in the library.
- CORS: dev SPA runs on a Vite dev server; open the dev origin only. Prod: FastAPI serves the built static assets — same origin, no CORS needed.
- **不重复构建（统一 API 原则）**：同步完善 API 文档与 CLI 先行的目的就是统一 API——出现第二个消费端（本仓库/TUI/Web）时，共享逻辑收编进库（共享层函数/入口方法），消费端只留传输级薄映射；消费端代码里出现与 CLI 重复的接线/校验逻辑即为违规——要么本轮收编上游，要么记录偏差并排期收编。上游不是不可动，视情况而定：值得统一的改动直接改 sibling 库仓库（遵守其 AGENTS.md），api.md 补录、库仓库独立提交，发新版后同步依赖。**graph 序列化已收编进库**（2026-08-29：`query.build_run_graph`/`graph_to_dict`，CLI visualize 与 Web 共用）——图结构是库侧唯一新数据形状；本层不再维护图构建/序列化代码，消费端只留薄映射。**对话引擎反向收编为偏差记录**（2026-09-14）：treechat 不会发 PyPI、webview 是唯一 Web 消费端、前端已是移植副本——继续做 editable 兄弟依赖只剩环境摩擦（可缺席降级随之退役），故整包收编为本仓库顶级 `treechat/` 包；specmodule 库面的共享逻辑纪律不变，treechat 内部对 module_harness 的消费仍全部经 bridge 单点。
- **库 API 文档同步完善**：消费新的 specmodule API 时，同步补录 `../SpecModule/docs/references/api.md`（做到哪里写哪里，按消费增量生长）；文档变更在库仓库独立提交（`docs:` 前缀，遵循其 AGENTS.md），本仓库侧的完成记录归档进 `roadmap/finish.md`（2026-09-24 起不再维护主文档变更日志）。

## Key Directories

- repo root — this repo:
  - `server/` — FastAPI thin layer: `app.py` (entry: CORS + router wiring), `deps.py` (base_dir/搜索路径解析 + run_id 校验), `api/runs.py` (runtime read endpoints), `api/graph.py` (run 图重建：`build_run_graph`/`graph_to_dict` 薄调用 + 每节点运行摘要叠加), `api/manage.py` (模块枚举 + 模块详情), `api/control.py` (控制面端点: cancel/pause/unpause + 发起/删除/resume 端点壳——编排已提取 `server/runservice.py` 共享层), `runservice.py` (spawn 编排/进程注册表共享层——HTTP 端点与 ops 工具共用), `api/build.py` (组件库/草稿 CRUD + pack 组装安装 + entry 模块转 packed convert), `chat.py` (TreeChat 整树挂载 `/treechat`——base_dir 锚定配置链与会话数据目录,挂载常开), `ws.py` (tick 流实时推送)
  - `treechat/` — 对话引擎（2026-09-14 自 `../Treechat` 收编为本仓库顶级包,原独立仓库冻结,演进直接在此进行）：`core/`（会话树/卡片/上下文/事件/存储）+ `session.py`（会话门面）+ `module_bridge.py`/`llm_bridge.py`（module_harness 桥——spec 组装/事件订阅/结构化输出取回 + LLM 客户端与卡片提炼）+ `tools/`（工具箱基座 + 数据类 7 工具 + refine_spec 能力类——ops agent 消费面）+ `agent_bridge.py`（ops 回合工具循环——chat() 多轮，D2 决策）+ `modules/`（内嵌对话型 module：direct 直答、grilling 拷问、agent——`agent.py` AgentMode ops 模式）+ `cli/`（REPL,console script `treechat`）+ `webapp/`（FastAPI 服务层,被 `server/chat.py` 整树挂载）；其测试收编于 `tests/treechat/`（133 例）
  - `web/` — Vite + React + TS + Tailwind + React Flow + dagre SPA（页签制壳：顶部页签栏 + 活动栏 + 侧边栏）：`src/App.tsx`（壳层：顶部页签模型（modules 固定 + chat/run 多实例）/runs 轮询/按 sid 多实例会话状态/SSE 流式回合（运行迹按 sid，后台页签持续流式）/恢复请求）+ `src/ws.ts`（WS 客户端，消息按 runId 打包防陈旧流）+ `components/`（TabBar 顶部页签栏、ActivityBar 活动栏（chat/tree/cards/modules/runs/settings）、ModuleList/ModuleDetail 模块库（发起表单内嵌主区）、RunList 运行历史侧栏、RunView 运行视图容器、GraphView/StatusNode 图与徽章、NodePanel 节点面板、RunControls 控制条 + 恢复对话框、LibraryPanel 组件库侧栏（构建板块）、builder/（ModuleBuilder 创建器/EditableCanvas 画布/NodePanel 配置面板）、library/（harness/command 表单对话框）、dialogTheme 对话框共享类、ui/ 基件含 Radix dialog/dropdown-menu/alert-dialog）+ `src/chat/`（TreeChat 移植：types/api（锚 `/treechat` 前缀；api 含 streamSse 流式回合 + modes）/treelayout/Markdown/ChatView（含 RunBlock 回合运行块）/Composer + ChatListPanel（创建选模式）/TreePanel/CardsPanel/SettingsPanel（模式只读）侧栏面板）+ `src/api.ts`（端点载荷类型）+ `src/lib/utils.ts`（cn/relativeTime）+ `src/lib/json.ts`
  - `tests/` — pytest + httpx TestClient
  - `roadmap/` — 计划目录（2026-09-24 起，替代根目录 roadmap.md）：`roadmap.md`（方向规划与排期，实时更新——只记未完成阶段/切片/常驻原则，实施前重读）+ `finish.md`（已完成归档：落地阶段清单、定稿设计、历史变更日志；完成的工作按需追加归档，琐碎者不记）。**文档纪律**：问题与遗留项一律开 GitHub issue 跟踪（roadmap.md「问题与遗留」节有索引），不在文档里积压；主文档不追加变更日志。
- `../SpecModule/` — the consumed library (read-only for this repo):
  - `module_harness/` — `query.py` (timeline/checkpoint queries + `read_module_inputs`), `status.py` (`ModuleStatus`), `control.py` (跨进程控制文件协议：cancel/pause/unpause + hook 工厂), `graph_builder.py` (`TasklistTranslator`), `translator.py`, `store.py` (module store), `module.py` (`Module` orchestrator), `feed.py` (reference JSON composition + polling pattern), `entry.py`, `cli.py` (21-subcommand `specmodule` CLI: + `cancel`/`pause`/`unpause`)
  - `docs/references/api.md` — 库面编程 API 参考（按消费增量生长，本仓库消费新 API 必须同步补录）；`cli-usage.md` — parameter semantics for every operation
  - `AGENTS.md` — sibling guidelines (architecture rules, gotchas); mirror its conventions
- Run artifacts (created at runtime): `<base_dir>/.specmodule/runs/<run_id>/`（`run.sqlite` + `status.json` + `stream.log`——LLM 流式 JSONL，`Module(stream_log=False)` 关闭）; module store: `$SPECMODULE_HOME` or `~/.specmodule/` (`modules/`, `manifests/`, `cache/`, `config.json`, `.env`, `rules.txt`). example 实践线模块（`academic_writer`/`ppt_master`）已按 entry 式安装进 `~/.specmodule/modules/`（2026-09-16，SpecModule@18573a2：顶层入口文件 + `_lib/example` 自包含实现包，入口引导把 `_lib` 加入 sys.path；`llm`/`module_harness` 是 specmodule 发行包自带顶级包，走安装链解析、不随 store 拷贝）。

## Development Commands

```bash
# environment (uv：创建 .venv + uv.lock 锁定；specmodule 经 tool.uv.sources 锚定 ../SpecModule editable)
uv sync

# run tests
uv run pytest tests/ -q                     # this repo's suite（webview + 收编的 treechat 133 例）
uv run pytest ../SpecModule/module_harness/tests/ -q -m "not smoke"   # library baseline (no LLM keys)
uv run pytest ../SpecModule/module_harness/tests/smoke/ -v -s         # real-LLM smoke (needs config.json + .env)

# run the backend (start from project root — imports resolve against the library)
uv run uvicorn server.app:app --reload --port 8000
# 运行根缺省已锚用户主目录（数据根统一 ~/.specmodule），本地启动无需设 env；
# 仅测试隔离 / 多运行根时覆盖：
SPECMODULE_BASE=<运行根目录> uv run uvicorn server.app:app --port 8000

# frontend (web/ only; node_modules/ and dist/ are gitignored)
cd web && npm install && npm run dev   # dev server on :5173, /api 与 /treechat 代理到 :8000（SSE/WS 走 HTTP 代理）
npm run build                          # tsc --noEmit + vite build (acceptance gate)
```

运行业务模块需要其所在目录可被库发现：模块在 cwd/modules 或 `$SPECMODULE_PATH`（os.pathsep 分隔）下（测试用 `SPECMODULE_PATH=tests/modules`）。

无 uv 时的 pip 回落：`pip install -e "../SpecModule" -e . pytest httpx`（dev 组在 `[dependency-groups]`，pip ≥25.1 也可 `pip install --group dev -e .`）。

# library CLI reference (semantics of the API surface)
uv run python -m module_harness.cli run --module <name> --spec '{"...": "..."}' --mock
uv run python -m module_harness.cli status --run-id <id>
uv run python -m module_harness.cli review --run-id <id>
```

Python ≥3.10 (library dev'd on 3.13). No lint/format/type tooling in this ecosystem — don't introduce any.

## Git & Branches

- **双线同步纪律**：`feat/multiuser-gateway` 是与 main 同步演进的带用户隔离功能（多用户网关）的长期分支——**改动的提交需分别在 main 和 feat/multiuser-gateway 上落地**，不允许只落单线。惯例：main 上提交 → 切分支 `git merge main` 并入（提交信息 `merge: main 并入 feat/multiuser-gateway——<主题> 同步`，见既有 merge 链）；推送时两线各自 `git push`。

## Code Conventions & Common Patterns

- **Thin mapping**: one endpoint = one library call + shape conversion. No validation beyond what the library raises, no caching, no parallel state — the library's run state is the single source of truth.
- `from __future__ import annotations` as first line; `@dataclass` models with `field(default_factory=...)`; typed public signatures; explicit `__all__` in `__init__.py`; Chinese docstrings (library convention).
- **Error handling** — mirror the library's split:
  - Queries **never raise**; missing/corrupt data → `None` → HTTP 404 with `{error: "无运行记录"}` and the run_id.
  - Operations raise typed exceptions (`KeyError` with available targets list from `create_checkpoint`, etc.) — map to 4xx with `str(e)` included.
  - Unknown run_id → 404; malformed query params → 422 (FastAPI validation).
- **Async**: WS handlers and any awaited library entry points (`Module.run`) are `async`; query endpoints are synchronous (query layer is sync).
- **base_dir**: resolved once per server (env `SPECMODULE_BASE`, default cwd), passed explicitly to every query call — never rely on implicit cwd.
- **feed.json compat**: the `/api/runs/{id}/feed` endpoint must keep the feed.py response shape (status/timeline/checkpoints field names) as the v1 frontend contract; richer endpoints extend it, they don't break it.
- **Mock pattern** for key-free tests: `mock_llm.complete = AsyncMock(return_value=LLMResponse(content='{"ok": true}', usage={}, finish_reason="end_turn"))` — only needed if tests exercise `Module.run`; endpoint tests use fixture run artifacts instead.
- Spec is a free-form dict; `--spec` inline > `--spec-file` > `entry.default_spec`. Two mutually exclusive channels: template (translator) or tasklist dict — 当前图端点从 module_inputs 存档重建，无直渲染通道；无 run 直渲染 `POST /api/graph/render`（库函数已留 tasklist 通道）推迟阶段 3，届时消费层核对 `entry.build_module` 的 `template_name` XOR `tasklist` 契约（`ValueError` 冲突）。

## Important Files

- `roadmap/roadmap.md` — the plan: direction & schedule only（方向规划与排期——未完成阶段/切片 + 常驻原则），实时更新。Re-read before implementing. 已完成的工作归档 `roadmap/finish.md`；问题与遗留开 GitHub issue，不进文档。
- `../SpecModule/module_harness/infra/query.py` — the shared query layer to import (timeline/checkpoint dict shapes).
- `../SpecModule/module_harness/orchestrate/feed.py` — reference JSON composition + polling pattern for the compat endpoint and WS stream.
- `../SpecModule/module_harness/infra/status.py` — `ModuleStatus` fields + phase machine.
- `../SpecModule/module_harness/orchestrate/graph_builder.py`, `translator.py` — graph render backend (tickflow `Graph` output); 序列化 `query.graph_to_dict` 与归档重建 `query.build_run_graph` 均在库共享层（`server/api/graph.py` 只薄调用 + 状态叠加）。
- `../SpecModule/module_harness/infra/store.py` — `list_modules` for the management surface.
- `../SpecModule/docs/references/api.md` — 库面编程 API 参考（按消费增量生长，本仓库消费新 API 必须同步补录）；`cli-usage.md` — parameter semantics for every operation.
- `../SpecModule/AGENTS.md` — sibling guidelines (architecture rules, gotchas); mirror its conventions.

## Runtime/Tooling Preferences

- **Python ≥3.10**; 包管理：**uv**（2026-09-14 起，`uv sync` 建 `.venv` + 提交 `uv.lock`；specmodule 经 `[tool.uv.sources]` 锚 `../SpecModule` editable；无 uv 时 pip 回落见开发命令）。生态其余仓库（SpecModule 等）惯例仍是 pip，不强制跟随。
- Runtime deps: `specmodule` (pulls `tickflow-py` — imported as `tickflow`; import name ≠ package name) + `fastapi` + `uvicorn` (本项目依赖, per roadmap); test dep: `httpx`; 对话引擎 `treechat` 已收编为本仓库顶级包（随 `pip install -e .` 一起安装,挂载常开,无缺席降级;原 `../Treechat` 独立仓库已冻结）。
- No formatter/linter/type-checker configs anywhere in the ecosystem; keep it that way (stdlib + pytest only).
- API keys live in `.env` (gitignored); `config.json` never stores secrets. The webview backend itself needs no API keys (it only reads run artifacts) — keys matter only for tests that exercise real `Module.run`.
- Sibling consumer repos (`SpecModule_tui/`, `SpecModule_mcp/`) are the precedent for this repo's thin-consumer shape; `SpecModule_mcp/AGENTS.md` is the closest structural model for this file.

## Testing & QA

- **pytest** + `httpx` TestClient (FastAPI's ASGI test client). No pytest config, no coverage tooling, no thresholds — match the ecosystem.
- **Isolation pattern** (library convention, required): real run stores under `tmp_path` — `tmp_path/.specmodule/runs/<id>/run.sqlite` + `status.json`; construct a minimal fixture run by writing a `status.json` (phase-only) and/or a `run.sqlite` via `tickflow.persistence.SqliteBackend` (or reuse library test helpers). Never touch real `~/.specmodule`.
- **测试垃圾随时清理**：测试产生的 run 工件一律落 `tmp_path`（isolation pattern）；凡出现在任一仓库目录下的 `.specmodule/runs/*` 都是泄漏的测试垃圾，发现即删、不得积累（2026-09-16 曾因 cwd 锚定在 `../SpecModule/.specmodule/runs` 积累 5109 条、本仓库 75 条，已清理）。
- Endpoint tests: build fixture run artifacts → hit endpoints via TestClient → assert response shapes match the mapping table above, including the error contract (None → 404).
- Feed compat: assert `/api/runs/{id}/feed` shape stays byte-compatible with `feed.py`'s `_serve_feed` output.
- Library baseline before merging anything: `uv run pytest ../SpecModule/module_harness/tests/ -q -m "not smoke"`.
- Acceptance (roadmap): M1 + M2 modules fully wired — runtime visualization + output comparison, verified end-to-end against real run artifacts.
