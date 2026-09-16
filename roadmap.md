# SpecModule Web 可视化（可视化形态）

> 生态项目之一。本目录是 SpecModule 的**可视化消费通道**，独立于库仓库。
> 富交互图编辑器在此，库内的 stdlib 可视化开关只做极简运行 feed。
> **只 import 不实现**——消费 `module_harness` 共享层，绝不重实现查询逻辑；
> 消费新的库 API 时**同步补录** `../SpecModule/docs/references/api.md`（做到哪里写哪里）。

## 定位

独立前端 SPA + FastAPI 薄层，消费 `module_harness/query.py`、`status.py`、`graph_builder.py`、
`store.py` 等共享层函数；后端 = 查询层的 HTTP 适配器（薄层），前端独立 SPA 消费 HTTP/WS API。

## 架构（已定）

```
浏览器面板（SPA）
    │  HTTP / WS
    ▼
server/：FastAPI 薄层 ── 消费 module_harness 共享层，只 import 不实现
    │
    ▼
specmodule 库（module_harness → tickflow 引擎）
```

```
SpecModule_webview/
├── server/                  # FastAPI 薄层
│   ├── app.py               # 入口：CORS + 路由挂载
│   ├── deps.py              # base_dir 解析（env SPECMODULE_BASE，缺省 cwd）+ run_id 校验
│   ├── api/
│   │   ├── runs.py          # 运行时读端点（状态/时间线/检查点/快照/feed）
│   │   ├── graph.py         # tasklist → 图结构渲染（图构建器 + 节点状态图共用）
│   │   └── manage.py        # 模块/运行枚举 + 检查点写操作
│   └── ws.py                # tick 流实时推送
├── web/                     # 前端 SPA（Vite + React + TS + React Flow + dagre）
├── tests/                   # pytest + httpx TestClient
└── pyproject.toml           # fastapi + uvicorn（仅本项目依赖）
```

## 功能路线图

### 阶段 0 —— HTTP 后端层（本轮）

- [x] 脚手架：`server/` 目录 + `pyproject.toml`（fastapi + uvicorn）+ `app.py` 入口（CORS 开 localhost dev 端口）
- [x] 运行时读端点（全部 import query.py / status.py）
  - [x] `GET /api/runs` — 运行列表 + 每 run phase/tick 摘要（管理面 + 运行选择器）
  - [x] `GET /api/runs/{id}/status` — `query_run_status` 全量：phase/tick/fired/outputs/node_states/error/updated_at
  - [x] `GET /api/runs/{id}/timeline?node=&tick=&failed=` — `build_timeline`，支持 failed/tick/node 过滤
  - [x] `GET /api/runs/{id}/checkpoints` — `build_checkpoints`
  - [x] `GET /api/runs/{id}/snapshot?tick=N` — `load_snapshot_summary`（缺省最新）
  - [x] `GET /api/runs/{id}/feed` — **feed.py 兼容组合端点**（status+timeline+checkpoints），前端 v1 先吃这份数据
- [x] 管理端点（薄层写操作）
  - [x] `POST /api/runs/{id}/checkpoints {label}` — `query.create_checkpoint`（纯数据操作，运行中也能用）
  - [x] `GET /api/modules` — `store.list_modules` 摘要
- [x] 图端点（运行时图视图消费）
  - [x] `GET /api/runs/{id}/graph?module=` — 库侧 `build_run_graph`（module_inputs 归档重建，见下节设计）+ `graph_to_dict` 序列化 + 叠加每节点运行摘要（fired_count/last_status/last_tick/running）
- [x] 实时推送
  - [x] `WS /api/runs/{id}/stream` — 后端 ~1s 轮询 status.json mtime + run.sqlite latest_tick（与 feed 同一数据源，不改库），变化才推 `{phase, tick, fireable, fired, outputs, error, updated_at}`
- [x] 测试：pytest + TestClient，造最小 fixture run（直接构造 run.sqlite）覆盖每个端点

### 阶段 1 —— 运行时可视化（数据面阶段 0 已备齐）

本轮切片（2026-08-29 定稿，设计见「运行时图视图设计」节）：

- [x] 运行时图视图：图结构 + 节点状态徽章（已完成/运行中/失败/未运行/次数）+ 跟随镜头 + 点击节点面板（firing 历史 / 实时输出）

后续切片：

- [ ] 状态面板：tick 流实时推送 → 全量状态侧栏
- [ ] 历史审阅时间线：复用 `build_timeline`，逐 tick 看产出/错误
- [ ] 产出对比：前后（原始 vs 整理 vs 润色）对比面板

### 阶段 2 —— 可视化管理

- [x] 模块列表 + 模块详情（2026-09-03 落地，见「变更日志」）：`GET /api/modules`
  （搜索路径显式锚定 base_dir + 载荷附 `search_paths` 扫描来源）+ `GET /api/modules/{name}`
  （`resolve_module_full`/`detail_to_dict` 详情面）——前端 ModulesView + RunDialog/SpecForm
- [x] 运行历史管理（2026-09-03 落地）：`GET /api/runs` 改 `query.list_runs`
  （module/has_sqlite 溯源载荷）+ `DELETE /api/runs/{id}`（`query.delete_run` +
  running/活子进程活性防护）——前端 RunsView 全宽历史
- [x] 发起运行（2026-09-03 落地）：`POST /api/runs`（子进程拉官方 CLI `run`，
  完全镜像 resume 的 spawn 机制）——前端 RunDialog（SpecForm 表单⇄JSON 填表）
- [x] 运行列表/选择器 + 检查点管理（列表、命名）——含手动检查点创建 UI 入口
  （`POST /checkpoints` 端点阶段 0 已备，界面无入口，见「控制功能缺口盘点」①）
- [x] 运行控制（2026-08-31 落地，设计见「运行控制设计」节）：运行中取消/暂停/继续
  （跨进程 control.json 通道）+ 结束后恢复/回退（spec/tasklist 可改重传，子进程拉官方 CLI）

控制功能缺口切片（2026-08-31 走查后盘点，详单见「控制功能缺口盘点」节）：

- [x] 恢复预检：dry-run 端点（薄调库 `check_resume_compat`，不 spawn）+ 对话框展示
  warnings / hard_errors（②）
- [x] 恢复对话框 tasklist 预填/展示（对齐 spec 的编辑重传体验）（③）
- [x] 截断 running 态提示：tick 停滞检测（排除暂停中）+ 引导强制恢复（④）
- [x] 恢复子进程硬终止端点（terminate；需权衡绕过库优雅收尾的代价）（⑤）
- [x] 回退目标展示 fired 上下文（checkpoints 载荷已含，纯前端）（⑥）
- [x] 小项：RunList 行内控制按钮；spec/tasklist 编辑器增强（⑦）

### 阶段 3 —— tasklist 图构建器（可选 / 远期）

- [ ] 图编辑（拖拽节点，graph/render 往返验证）
- [ ] 无 run 直渲染端点（POST /api/graph/render，库函数已留 tasklist 通道）

### 后排清单（2026-09-03 盘点，等真实使用中疼了再动）

- store 生命周期管理界面（install/uninstall/update/publish）
- init 脚手架入口（`modules/<name>.py` 实例骨架生成）
- run 重命名
- 复跑（同 spec 重启新 run）
- 中间快照复跑入口（RunsView 直达 resume 对话框并预选快照目标）
- 批量删除运行历史

## 数据契约与错误处理

- 数据结构**全部复用** query.py 的 to_dict 出口（`timeline_to_dict` / `checkpoints_to_dict` /
  snapshot dict），status 字段形状与 feed.py 一致；**唯一新数据形状是 graph 结构**
  （nodes: id/label/type/inputs；edges: from/to）——序列化 `graph_to_dict` 收编库共享层
  （2026-08-29 定稿，CLI visualize 共用），`server/api/graph.py` 只留薄映射与状态叠加。
- 错误处理继承查询层容错哲学：查询层返回 None（无运行 / DB 读失败）→ 后端映射 404 +
  `{error: "无运行记录"}`；`create_checkpoint` 的 KeyError（消息带可用清单）→ 4xx 原样透出；
  未知 run_id → 404。

## 运行时图视图设计（2026-08-29 定稿）

本轮交付：阶段 0 全部后端 + 阶段 1 的运行时图视图切片。界面美化单独轮次，本轮样式只求功能可辨。

### 数据流

```
CLI 在别处启动 run ──► <base_dir>/.specmodule/runs/<run_id>/{status.json, run.sqlite}
                                    │
浏览器 SPA（React + React Flow）     │ 后端 ~1s 轮询（feed.py 同款，不改库）
    ▲  HTTP 初始载荷                │
    │  WS 增量推送                  │
    └── server/ FastAPI 薄层 ───────┘
```

打开 run：`GET /api/runs/{id}/graph` 一次拉齐（图结构 + 每节点运行摘要）→
`WS /api/runs/{id}/stream` 推 tick 增量 → 前端本地更新徽章/镜头/节点面板，不重拉全量。

### 图数据源（收编 CLI visualize 组合进库）

- 库侧新增 `query.build_run_graph(module_name, run_id, *, base_dir=None, template=None, tasklist=None) -> Graph | None`：
  模块解析（store 统一搜索路径）→ Mock registry（渲染零 LLM 免 key）→ `module_inputs` 归档 →
  `TasklistTranslator.build`；CLI `visualize` 重构为薄调用（mermaid 出口不变）。
  **开发中同步补录 `../SpecModule/docs/references/api.md`**（统一 API 原则，AGENTS.md 条款）。
- `query.graph_to_dict(graph, tasklist) -> dict` 为唯一新数据形状：nodes 含 `type`
  （取 `tasklist.tasks[key].type`，submodule 画单节点不展开）与原始 inputs 声明
  （避开 Graph 节点 inputs 的 field/producer 双键污染）。
- **`registry=None` 纯产物解析路线已否决**（实证）：tickflow `_validate` 对每条 guard 边查
  `reg.has_guard`，空 registry 即 `ParseError`——必须构建真实 registry，故图渲染依赖模块可解析。
- run→模块名映射：v1 启发式 `module = run_id`（CLI 缺省 run_id 即模块名），`?module=` 可覆盖；
  解析失败前端弹模块选择器（数据 `/api/modules`）。~~模块名入 status.json 的彻底溯源记为
  后续上游改进，本轮不做（偏差已记录）~~ **已销项（2026-09-03）**：库 0bdf171 落地
  status.json `module` 溯源字段（`entry.build_module` 自动传入，旧 run → None），
  runs 列表消费该字段回落启发式。

### 节点徽章语义

- 运行中 = `phase=running` 且节点 ∈ 最新快照 `fireable`（实现期核对快照 fireable/fired 精确语义）
- 已完成/失败 = timeline 该节点最近 firing 的 status（ok/failed/aborted）；未运行 = timeline 无 firing
- 运行次数 = timeline 该节点 firing 计数（前端初始一次拉全量，WS 增量累加）
- 点击节点（含运行中）→ NodePanel：元信息（type/inputs/join）+ firing 历史列表
  （`/timeline?node=`）+ 最新输出全文（WS 自动刷新，JSON 美化）

### 前端（web/）

Vite + React + TS + React Flow + dagre（分层布局自动算坐标）。组件三件：
`RunList`（左栏 run 选择器）/ `GraphView`（自定义节点：名称 + 类型 + 状态色 + 次数徽章，
guard 边标签，minimap，**跟随模式**：每 tick 平滑居中当前 fire 节点包围盒，手动操作画布即
暂停 +「回到当前」按钮）/ `NodePanel`（右栏）。

### 错误契约（继承查询层哲学）

- 查询 None → 404 `{error: "无运行记录", run_id}`；模块解析失败 → 404 + 提示消息（前端触发模块选择器）
- 无 `module_inputs` 归档的失败 run（translating/building 期即失败）→ 图 404，界面只显示 phase/error
- WS：run 不存在 → 拒连并带原因；运行结束 phase 终态后推送完毕正常关闭

### 测试与提交顺序

- 后端 pytest + fixture run（`SqliteBackend` 造 run.sqlite 含 module_inputs 行 + status.json）+
  fixture entry 模块（tests/modules/ 最小 harness+script+guard 接线）；合并前库基线
  `python -m pytest ../SpecModule/module_harness/tests/ -q -m "not smoke"`。
- 前端不引入测试框架（生态无先例）；验收 = 构建通过 + M1/M2 mock run 端到端走查。
- 提交顺序：库仓库先行（功能一笔 + `docs:` api.md 补录一笔，遵守其 AGENTS.md）→ 发新版 →
  本仓库同步依赖并提交 server/ web/ roadmap。开发全程按统一 API 原则边开发边完善库 API 与 api.md。

## 运行控制设计（2026-08-31 定稿并落地）

运行监控补控制功能两件事：①运行中取消/暂停 ②结束后恢复/回退（resume/rollback），
回退支持 spec 或 tasklist 更改重传。

### 分工（统一 API 原则）

- **库侧收编 `module_harness/control.py`**（库仓库独立提交）：控制文件协议
  `control.json`（status.json 的反向通道；单发一次性、消费即删、`run()/resume()`
  开始清场）+ `control_tick_start`（pause 在 tick_start 挂起）/`control_tick_end`
  （cancel 消费）hook 工厂 + CLI `cancel/pause/unpause` + `query.read_module_inputs`。
  **cancel 必须在 tick_end 消费**：引擎每 tick 末尾无条件重写 `runner.status`，
  tick_start 期设置的 CANCELLED 被同 tick 赋值冲掉（真实子进程 E2E 实测缺陷，
  已修并附真实 AsyncRunner 回归测试）。`Module(control=False)` 关闭通道。
- **本仓库只留传输级薄映射**：control 两端点 = `request_control`/`read_control`
  直调；恢复/回退 = 子进程拉起官方 CLI（`specmodule resume`）——spec/LLM/模块
  解析接线全复用 CLI，server 不重复（消费端重复接线即违规）。

### 恢复/回退（结束后）

`POST /api/runs/{id}/resume {module?, target?, spec?, tasklist?, max_ticks?, mock?}`：

```
前置校验（status.json→404 / run.sqlite→400 / 运行中或已有恢复进程→409 /
模块可解析→404 code=module_unresolved / target 形状→400）
→ spec/tasklist 落系统临时文件（Windows argv 长度限制，走 --spec-file/--tasklist）
→ Popen([python, -m module_harness.cli, resume, target?, --module, --run-id, …],
        cwd=SPECMODULE_BASE, stdout=<run_dir>/process.log)
→ 202 {started, run_id, pid, module, target}
```

子进程写 status.json/run.sqlite → 既有 WS 自然续监控，零额外管道。内存注册表
`{run_id: Popen}` 单写者互斥 + 惰性收割（退出即清临时文件）；`GET /process`
出 running/pid/日志尾（CLI 启动期失败只在此可见）。UI 恢复对话框：回退目标
（`/checkpoints` 列表，缺省最新续跑）+ 模块名（moduleHint 缺省 run_id 启发式）
+ spec 预填（`/inputs` 读 module_inputs 存档，可改重传）+ tasklist 文件上传（可选，
模板通道互斥）+ `--mock`/max_ticks。头部控制条 phase 感知：running→暂停/取消、
paused→继续（WS `paused` 字段驱动徽章）、终态→恢复/回退入口。

### 已知偏差

- ~~CLI resume/rollback 对无 `default_template` 的模块需显式 `--tasklist`~~
  **已修复**（2026-08-31 库仓库 f76e8c5）：流程来源兜底——显式参数 >
  `default_template` > module_inputs 归档 tasklist。
- 库查询 latest_tick 取历史最大 tick——深回退后 `status.tick` 偏高直至运行追上
  （上游可改为按写入序取最新，本轮不动）。

### 控制功能缺口盘点（2026-08-31 走查后）

> **2026-08-31 本轮全部补齐**：② 预检经库侧收编 check_resume_compat_from_run（库 0.1.4），⑤ terminate 附头部按钮出口，①③④⑥⑦ 见阶段 2 切片；下文为盘点原文存档。

主链路（取消/暂停/继续、恢复/回退、预填重传、子进程观测）已闭环；以下为盘点出的
剩余缺口，①②③ 为值得排期的真缺口，④-⑦ 已知边界/小项，等真实使用中疼了再动。

1. **手动检查点创建无 UI 入口**。`POST /checkpoints` 端点阶段 0 已备，但界面无任何
   命名检查点入口——「当前状态值得存点供以后回退」只能去 CLI 做。回退对话框能消费
   `manual:<label>` 目标却不能生产它。归入「检查点管理」切片。
2. **恢复前看不到兼容性预检**。`check_resume_compat` 的提示性警告（已执行节点被修改
   不生效、某节点从检查点出发永不 fire 等）与硬错误明细只落在 `process.log`；硬错误
   要等子进程失败后翻日志。库函数现成，加薄 dry-run 端点（不 spawn 只跑 check）+
   对话框展示。
3. **tasklist 更改重传只能从零上传**。`/inputs` 已返回归档 tasklist，对话框只预填
   spec——改 tasklist 没有编辑起点。对齐 spec 做法（预填编辑区或可查看）。
4. **截断 running 态无法与真运行区分**。max_ticks 截断后 phase 停在 running 但进程
   已退：暂停/取消按钮对死进程点击无效且无提示。库语义无活性探测、webview 不该猜；
   可加 tick 停滞提示（需排除暂停中的 run）引导走强制恢复。
   - **根除（2026-08-31）**：库 truncated 终态落地后，截断不再是 running 残留；
     黄条只对进程真失联触发（流式心跳 + 终态关闭）。
5. **恢复子进程无硬终止**。只有协作式取消（tick 边界生效）；子进程卡在单次长 LLM
   调用时只能等。terminate 端点技术上 trivial（注册表握有 Popen），但绕过库的优雅
   收尾（不写终态 phase），提供与否需先想清楚。
6. **回退目标缺上下文**。checkpoints 载荷含每 tick 的 `fired` 节点列表，对话框未
   展示——「tick 47」与「tick 47（刚完成 Normalize）」对选目标差别很大。纯前端。
7. **小项**：RunList 行内无控制按钮（须进入 run 才能操作）；spec/tasklist 编辑器为
   纯 textarea（提交时才校验 JSON）。

## 与原仓库的同步（统一 API 原则）

- **不重复构建**：HTTP 端点 = 库调用 + 传输级薄映射。出现第二个 Web 消费形态或 TUI 也需要
  相同逻辑（如 graph 序列化）时，共享逻辑**收编进库**（共享层函数），消费端只留薄映射；
  消费端代码里出现与 CLI/其他消费端重复的接线/校验逻辑即为违规——要么本轮收编上游，
  要么记录偏差并排期收编。值得统一的改动直接改 sibling 库仓库（遵守其 AGENTS.md），
  api.md 补录、库仓库独立提交，发新版后同步依赖。
- **库 API 文档同步完善**：消费新的 specmodule API 时，同步补录
  `../SpecModule/docs/references/api.md`（做到哪里写哪里，按消费增量生长）；文档变更在库仓库
  独立提交（`docs:` 前缀，遵循其 AGENTS.md），并在此 roadmap 末尾变更日志记录。

## 验收

M1 + M2 双 module 全量接入：运行可视化 + 产出对比。

## 依赖

`specmodule` 库（`pip install specmodule`）+ Web 框架（FastAPI + uvicorn，仅本项目依赖）+
`httpx`（测试）；`web/` 前端：npm（Vite + React + React Flow + dagre，仅 web/ 内管理）。

## 变更日志

- 2026-08-27：初始 roadmap 完善——定稿阶段 0 HTTP 后端层设计（技术选型 FastAPI 薄层、
  端点清单、graph 结构为唯一新数据形状、错误处理契约），新增统一 API 原则与 api.md 同步条款。
- 2026-08-29：运行时图视图设计定稿——前端选型 React + React Flow + dagre；镜头跟随+手动解锁；
  图数据源收编 CLI visualize 为库共享函数 `build_run_graph`/`graph_to_dict`（`registry=None`
  纯产物解析因 guard 校验否决）；graph 端点改为 `GET /api/runs/{id}/graph`（无 run 直渲染推迟
  阶段 3）；WS 推送载荷定形；阶段 0/1 清单随之更新。
- 2026-08-29（实施）：阶段 0 后端 + 运行时图视图落地。库侧收编 build_run_graph/graph_to_dict（库仓库 feat+docs 两笔）；webview 端点全家 + WS + React Flow 图视图，E2E 走查通过。已知偏差：模块名溯源（module=run_id 启发式 + ?module= 覆盖）待上游 status.json 补 module 字段后移除；E2E 后端启动需 SPECMODULE_PATH 指向模块目录。
- 2026-08-30（审查修复）：AGENTS.md 对齐实现——端点映射表改 `GET /api/runs/{id}/graph`（序列化已收编库共享层）、当前状态/目录/开发命令更新；图端点错误体补契约字段 `code: "module_unresolved"`（前端模块选择器改按 code 分支，与错误文本解耦）；`test_bad_run_id_400` 拆分断言（严格 400 用例 + 路径穿越 404 用例）。
- 2026-08-31（运行控制落地）：运行中取消/暂停 + 结束后恢复/回退（spec/tasklist 可改
  重传）。库侧收编 control.json 协议（`control_tick_start`/`control_tick_end` hook 工厂 +
  CLI `cancel/pause/unpause` + `read_module_inputs`；cancel 消费点在 tick_end——修 E2E
  实测的终态冲掉缺陷；库仓库 feat+docs+fix 三笔）；本仓库控制面四端点
  （control/inputs/resume/process，resume 为子进程拉官方 CLI）+ WS `paused` 字段 +
  头部控制条与恢复对话框。真实子进程全链路走查：暂停冻结 tick → 继续前进 → 取消落
  cancelled → 续跑 → 回退 tick 4 换 spec 重传归档。已知偏差两条（见设计节）。
- 2026-08-31（控制缺口盘点）：全链路走查后盘点剩余缺口并写入「控制功能缺口盘点」节、
  阶段 2 增补对应切片项——①检查点管理 UI（入口缺失）②恢复兼容性预检（dry-run 端点 +
  对话框展示）③tasklist 预填重传；已知边界④截断 running 态提示⑤恢复子进程硬终止
  ⑥回退目标 fired 上下文⑦行内控制/编辑器小项。另：已知偏差中「resume 需显式
  --tasklist」已由库仓库 f76e8c5（流程来源兜底）修复，标记销项。
- 2026-08-31（控制缺口补齐）：7 项缺口全部落地。库侧收编
  `query.check_resume_compat_from_run`（executed_nodes 规则同步抽 `_executed_nodes`
  单一事实源；库仓库 feat+fix+docs 三笔，0.1.4）；本仓库 preflight/terminate 两端点 +
  `GET /api/runs` 补 paused；前端恢复对话框（tasklist 预填编辑区、预检内联展示、
  fired 上下文、JSON 即时校验、文件载入改编辑区）+ 检查点创建对话框 + 停滞黄条 +
  terminate 按钮 + RunList 行内控制。已知偏差：paused 判定表达式在
  runs.py/control.py/_control_view/ws.py 三处消费端各自内联（一行式，收编库
  `control.paused()` 待真实第三形态出现再动）；行内控制按钮无 busy 态（双击幂等）。
- **2026-08-31 截断终态 + LLM 流式落盘（库 A/B 两案，spec：2026-08-31-truncated-stream-design.md）**：
  库侧 `_finalize_phase` 将 max_ticks 耗尽映射为新终态 **`truncated`**（error 记上限）——
  控制缺口 ④ 的"截断 running 态"从根消除，黄条启发式只对真失联触发；库侧新增
  `stream.log`（Module `stream_log=True` 默认开，EventBus 订阅 `LlmCallStarted/LlmToken/
  LlmCallCompleted/HarnessFailed` 五类 JSONL 记录 append 落盘）+ `query.read_stream`
  共享增量读端；webview WS 追尾推送（锚定最后一条 `run_start`）+ `stream_mtime`、
  NodePanel 实时输出区、truncated 终态按钮矩阵。库仓库独立提交 ×3（含 api.md 补录）。
- 2026-09-01（审阅修复 + M2 实测）：resume 端点响应码对齐设计 **202**（实现/测试曾按
  200，三方不一致销项）；库侧预检 `check_resume_compat_from_run` 缺省目标分支补快照
  读取守卫（读失败归 `hard_errors`，不再静默降级，库 4db64dc）。M2（ppt_writer）真实
  模块全链路 E2E 走查通过：CLI mock 双 run（done + truncated）→ 图/时间线/检查点/
  快照/手动检查点 → preflight（target=1, executed=[Render]）→ resume **202** 存档缺省
  续跑 done → WS 流锚定（stream 先于 status、仅新执行 run_start）/stream_mtime/
  paused/close(1000) → terminate 硬终止 + 残留 running + force 恢复 → 产物 pptx 机器
  校验。实测认知两条：resume 的 running 窗口仅 ~30ms（轮询不可捕获，E2E 用 pause 钉住）；
  unpause 后中间态被 WS 1s 轮询合并进终态推送（变化才推的合并语义）。
- **2026-09-03 完整前端：模块库 + 运行历史管理 + 发起运行**（spec：
  2026-09-03-module-run-history-design.md，统一 API 原则全量兑现）。库侧收编 3 笔
  （c16c54e `query.list_runs`/`delete_run` + CLI `runs`/`delete-run`；0bdf171
  `store.ResolvedModule`/`resolve_module_full`/`detail_to_dict` + `search_paths(base_dir)`
  发现锚定 + status.json `module` 溯源字段；c5e64c3 api.md 补录）——roadmap「已知偏差」
  的模块溯源项正式销项。本仓库 server：`GET /api/runs` 改 `list_runs` 薄映射（删除自扫
  目录代码，载荷增 module/has_sqlite；unknown 态收入不跳过）；新端点
  `GET /api/modules/{name}`（未找到 404 / 加载失败 400）、`DELETE /api/runs/{id}`
  （不存在 404 / running 无 force 409 / 注册表活子进程 409——force 也不豁免）、
  `POST /api/runs`（spawn 官方 CLI `run`，完全镜像 resume 的 spawn 段：spec 临时文件
  `--spec-file`、run_id 缺省 `{module}_{6hex}`、202 载荷；module_unresolved 404 /
  ValueError 400 / run 目录已存在 409 / 活进程 409）；**模块搜索路径显式化**（进程边界
  修复）：deps 增 `get_search_paths`（`store.search_paths(base_dir)`），`GET /api/modules`
  载荷附 `search_paths` 扫描来源、resume 预检 `resolve_module` 显式传 search——放运行根
  `modules/` 下的模块不再被误判 module_unresolved，E2E 无需 SPECMODULE_PATH 绕过；
  graph 端点模块名解析序升级为 `?module=` > status.json `module` 溯源 > run_id 启发式
  （`src=` 直通锚定解析，UI 发起的 `{module}_{hex}` run_id 免手动选模块）；preflight
  module 缺省对齐同序。已知的残留库面缺口：`check_resume_compat_from_run` 内部建图与
  `build_run_graph` 缺省路径仍按 cwd 锚定解析（graph 端点已经 `src=` 绕开）——库侧补
  `search=` 透传记后排。
  前端（无新依赖）：App 壳层顶部视图切换（模块库/运行历史/运行视图，无 router）；
  ModulesView 左列表右详情（模板 default 标注/spec_schema 字段表/default_spec 预览/
  扫描来源行）；RunDialog + SpecForm（spec_schema/default_spec 驱动类型化表单 ⇄ JSON
  双模式双向同步、字段级 JSON 子编辑器失焦校验、spec 空且无 default_spec 提交禁用）；
  RunsView 升格全宽历史（module 名溯源回落启发式、phase 徽章、错误摘要、行内查看/
  删除——running 先取消可 force 强删二次确认）；运行视图图加载失败区挂 process.log 尾
  （3s 轮询，CLI 启动期失败界面可见）。AGENTS.md 端点表同步三行 + base_dir 纪律补
  搜索锚定。测试：本仓库 84 项全绿；后排新增清单（store 生命周期界面/init 脚手架/
  run 重命名/复跑/中间快照复跑入口/批量删除）。
- 2026-09-10 **TreeChat 整合第一期：壳层重组**——web/ 引入 Tailwind + shadcn neutral
  主题（TreeChat webui 基建移植：cn/ui 基件/ActivityBar 结构），App 重写为 VSCode 式
  三段壳（活动栏 + 侧边栏 280px + 主区），侧栏导航范式：运行历史压缩为 RunList 侧栏
  常驻、模块库拆 ModuleList/ModuleDetail（发起表单内嵌主区，RunDialog 退役）、亮暗
  主题跟随系统（localStorage `specmodule-webview.theme` 覆盖）。`server/`/api.ts/ws.ts/
  dagre.ts 零改动。设计：
  `docs/superpowers/specs/2026-09-10-treechat-integration-phase1-shell-design.md`；
  计划：`docs/superpowers/plans/2026-09-10-treechat-integration-phase1-shell.md`。
  二期将并入 TreeChat 对话引擎（对话/树/卡片页签 + 服务层挂载）。
- 2026-09-10 **TreeChat 整合第二期：对话引擎并入 + 顶部页签制**——server 增
  `chat.py mount_chat`：`treechat/webapp create_app` 整树挂载于 `/treechat`（统一 API
  原则——库自带服务层零重复接线），`client_factory` 锚定 `project_root=base_dir` 复用
  SpecModule 配置回退链（与 run 侧共用 config/env/llm 客户端），会话数据落
  `<base_dir>/.treechat`（`TREECHAT_DATA_DIR` 可覆盖），treechat 未安装自动降级跳过；
  测试 `tests/test_chat_mount.py` 7 例（健康/生命周期/stub 轮次/502 契约/非法 sid）。
  前端（新增 Radix dialog/dropdown-menu/alert-dialog + react-markdown + remark-gfm）：
  壳层重写为**顶部页签制**——📦 模块库固定页签 + chat 会话/run 视图动态页签多实例
  共存（点选侧栏列表项=开/激活页签，关闭激活页签回落相邻→模块库）；活动栏追加
  💬对话/🌿对话树/🗂卡片/⚙设置，**侧边栏语义**：对话树/卡片为「页签配套功能」（内容
  随激活 chat 页签切换），对话列表/模块库/运行历史/设置为「全局功能」（不随页签变，
  只变选中高亮）；会话状态升级按 sid 多实例（convs + 随行 UI 态缓存，切页签不丢）；
  TreeChat 前端移植于 `src/chat/`（api 锚 `/treechat` 前缀；ChatList/Tree/Cards/Settings
  由 webui tabs 改造为面板，conv 可空判空内聚）；vite proxy 追加 `/treechat`。
  对话⇄run 联动留三期。设计：
  `docs/superpowers/specs/2026-09-10-treechat-integration-phase2-chat-tabs-design.md`；
  计划：`docs/superpowers/plans/2026-09-10-treechat-integration-phase2-chat-tabs.md`。
- 2026-09-11 **Chat as Modules 设计定稿（三期方向重定义）**——grilling 定位拷问收敛。
  定位声明：specmodule 是 agent harness 框架（能力由 harness 结构提供，LLM 是图里的
  组件）；取代语义：skill 中的「流程约束与提示词」类 → module 化；agent loop 降级为
  图级守卫循环（预算=max_ticks、收尾=guard）。核心命题：**不是在 chat 里用 module，
  而是用 module 拼出一个 chat**——每回合 = 一次对话型 module run（in-process、
  ephemeral、审计宿主=会话树、无运行视图），模式 = 对话型 module（复用 category），
  输入即 spec（brief 原话 + bridge 组装 history），spec 文档 = 共同维护的卡片
  （服务层自动刷新 + 卡片直填/对话框引用双通道）。v1 三个对话型 module（直答=单
  harness 节点退化形态、grilling、domain-modeling——自用户 skill_by_me 两个 skill
  移植，零外部工具依赖），v1 上流式（EventBus on_token → SSE）；嵌入式 module 随
  treechat 包内嵌分发。业务 run 联动机制不变（webview 编排 spawn + WS 跟踪卡片），
  spec-builder 一键转化 v1.1、推荐输出=自动路由种子 v2。落地顺序：TreeChat 仓库先行
  （module_bridge/SSE/嵌入式 modules/category 模式化）→ 本仓库挂载集成与前端模式入口。
  库依赖五项（brief 约定文档化 / scaffold 对话型模板 / persist 语义确认 / on_token
  事件面 api.md / 远期 agent 节点原语）。设计：
  `docs/superpowers/specs/2026-09-11-chat-as-modules-design.md`。
- 2026-09-14 **TreeChat 整合三期迁移：chat as modules 集成**——TreeChat 仓库先行完成
  （module_bridge/SSE 传输层/嵌入式对话型 module/category 模式化），本仓库挂载集成落地：
  后端零改动（`server/chat.py` 挂载契约不变，editable 安装自动跟随 SSE/modes 新契约）；
  挂载测试升级 SSE 回合契约 8 例（start 预告 → 逐 token/节点进度 → done/error 终帧、
  LLM 失败 error 帧——REST 502 契约退役；`/treechat/api/modes` 与分类创建回归）。
  前端移植 webui 增量：SSE 流式回合（streamSse 逐帧解析 + 断流检测；ChatView RunBlock
  节点预告/逐 token 全文/卡片链接片收口）、会话创建模式选择（direct 映射空分类）、
  页签徽章模式显示名、设置页模式只读展示；**SSE 按 sid 多实例推广**——回调闭包绑定
  发起 sid 写入对应运行迹，后台页签会话持续流式（webui 单活动会话的 activeSidRef
  守卫不需要；删除竞态由后端 session_delete 与轮次共用 registry 锁 + deletedSids
  兜底）。偏差记录（vs 原设计）：v1 对话型 module 实为两个——**grilling 吸收
  domain-modeling**（节点序 TreeUpdate → FrontierFormat → Resolution，Resolution
  裁决 + spec:glossary 词表卡片），message_field 改由模块声明（不再硬编码
  questions_md）——前端全走 /api/modes 动态清单，偏差对前端透明。业务 run 联动
  （spec 卡片 → 一键发起业务 run）不在 TreeChat 本次改动内，留三期收口后续。计划：
  `docs/superpowers/plans/2026-09-14-chat-as-modules-migration.md`。
- 2026-09-14 **对话引擎收编：treechat 后端整包并入本仓库**——treechat 不会发 PyPI、
  webview 是唯一 Web 消费端、前端已是移植副本，editable 兄弟依赖只剩环境摩擦
  （interpreters 错位即 ImportError），故整包收编：顶级 `treechat/` 包（22 文件 /
  2461 行，core 引擎/session/module·llm bridge/modules/cli/webapp，逐字拷贝零改动）+
  全套测试收编 `tests/treechat/`（133 例，自包含无兄弟路径）；pyproject 增
  `treechat*` 打包与 `treechat` console script（REPL 入口保留）；`server/chat.py`
  去可缺席降级（import 常开、恒 True 返回），`tests/test_chat_mount.py` 去
  importorskip；前端「安装 treechat」防御文案改「服务未挂载请确认后端已启动」；
  依赖零新增（treechat 唯一依赖 specmodule，本项目已声明）。原 `../Treechat`
  仓库收尾提交（模式接线收口 + message_field + session_delete 锁修复，133 例绿）
  后冻结，演进直接在本仓库进行。计划：
  `docs/superpowers/plans/2026-09-14-treechat-vendoring.md`。
- 2026-09-14 **uv 项目环境**——`uv sync`/`uv run` 为标准流程：dev 依赖迁
  `[dependency-groups]`（PEP 735，原 optional-dependencies 退役），specmodule 经
  `[tool.uv.sources]` 锚 `../SpecModule` editable（uv.lock 提交锁定；`.venv/` 已
  gitignore）；pip 回落路径见 AGENTS.md 开发命令；生态其余仓库仍 pip 不强制跟随。
- 2026-09-15 **运行列表与轮询机制根修**——实测 4821 个历史 run 下 `GET /api/runs`
  单次 12.5s（`list_runs` 10.2s，其中给 2924 个旧 run 逐个开 `SqliteBackend` 查
  tick 占 6.6s），前端 5s 周期轮询把页面拖死。收编上游：库新增 `query.recent_runs`
  （status.json mtime 排序只展开前 N 条 + total 计数，phase 迁移刷新排序键故活跃
  run 靠前，成本与历史规模解耦）、`_latest_tick_light` 换只读连接（免建连写锁，
  CLI 全量 `runs` 10s→4s）；webview `/api/runs` 改薄映射，前端列表去 5s 轮询改
  手动刷新 + 事件钩子（发起/删除/行内控制/页签终态），尾部按 total 提示更早历史
  走 CLI。已知后续：同页签 resume 不重挂载 RunView、WS 不 re-arm，恢复跑完的
  终态钩子不触发（预存 WS 生命周期限制，去轮询后显性化；列表靠手动刷新/其他
  钩子兜底），留后续处理。设计/计划：
  `docs/superpowers/specs/2026-09-15-run-list-decoupling-design.md`、
  `docs/superpowers/plans/2026-09-15-run-list-decoupling.md`。
- 2026-09-16 **数据根锚定 home + example 模块安装进 store + 测试垃圾清理**——
  module 索引一直连到原仓库 `example/`，cwd 锚定使测试 run 持续积累
  （`../SpecModule/.specmodule/runs` 5109 条 + 本仓库 75 条，纯垃圾已清）。
  根修三件事：① `server/deps.py get_base_dir` 缺省从 cwd 改为用户主目录——
  数据根统一 `~/.specmodule`（runs/store/chat 同根），本地启动无需设
  `SPECMODULE_BASE`，覆盖语义不变；② example 实践线模块（`academic_writer`
  = M1 验收模块 + `ppt_master`）按 store 规范安装进 `~/.specmodule/modules/`：
  顶层 entry 入口 + `_lib/example` 自包含实现包（入口引导 sys.path，
  `llm`/`module_harness` 为发行包自带顶级包走安装链），server 视图 ≡ spawn
  子进程视图（cwd=home `cli list` 验证）；③ AGENTS.md 增补「测试垃圾随时
  清理」纪律（run 工件一律 tmp_path，仓库目录下 `.specmodule/runs/*` 发现
  即删）。
- 2026-09-16 **启动界面优化一：spec 参考试运行**——「default_spec」区块更名「spec 参考」，
  有参考时整块可点、直接以参考 spec 发起运行（走既有 submit 路径，单一启动入口；无参考
  维持空态不可点；可点块带键盘可达性 role/tabIndex/Enter+Space，对齐 ModuleList 既有模式；
  busy 时视觉反馈+点击无效）。试剂 academic_writer 上游补 `default_spec`/`spec_schema`
  （SpecModule 仓库独立提交 d96924c + store 安装副本同步），详情「spec 字段」表随之亮起。
  设计：docs/superpowers/specs/2026-09-16-spec-reference-launch-ui-design.md
