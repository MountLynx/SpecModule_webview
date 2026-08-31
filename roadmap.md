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

- [ ] 模块列表（store.list_modules）
- [ ] 运行列表/选择器 + 检查点管理（列表、命名）——含手动检查点创建 UI 入口
  （`POST /checkpoints` 端点阶段 0 已备，界面无入口，见「控制功能缺口盘点」①）
- [x] 运行控制（2026-08-31 落地，设计见「运行控制设计」节）：运行中取消/暂停/继续
  （跨进程 control.json 通道）+ 结束后恢复/回退（spec/tasklist 可改重传，子进程拉官方 CLI）

控制功能缺口切片（2026-08-31 走查后盘点，详单见「控制功能缺口盘点」节）：

- [ ] 恢复预检：dry-run 端点（薄调库 `check_resume_compat`，不 spawn）+ 对话框展示
  warnings / hard_errors（②）
- [ ] 恢复对话框 tasklist 预填/展示（对齐 spec 的编辑重传体验）（③）
- [ ] 截断 running 态提示：tick 停滞检测（排除暂停中）+ 引导强制恢复（④）
- [ ] 恢复子进程硬终止端点（terminate；需权衡绕过库优雅收尾的代价）（⑤）
- [ ] 回退目标展示 fired 上下文（checkpoints 载荷已含，纯前端）（⑥）
- [ ] 小项：RunList 行内控制按钮；spec/tasklist 编辑器增强（⑦）

### 阶段 3 —— tasklist 图构建器（可选 / 远期）

- [ ] 图编辑（拖拽节点，graph/render 往返验证）
- [ ] 无 run 直渲染端点（POST /api/graph/render，库函数已留 tasklist 通道）

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
  解析失败前端弹模块选择器（数据 `/api/modules`）。模块名入 status.json 的彻底溯源记为
  后续上游改进，本轮不做（偏差已记录）。

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
