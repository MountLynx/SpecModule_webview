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

- [ ] 脚手架：`server/` 目录 + `pyproject.toml`（fastapi + uvicorn）+ `app.py` 入口（CORS 开 localhost dev 端口）
- [ ] 运行时读端点（全部 import query.py / status.py）
  - [ ] `GET /api/runs` — 运行列表 + 每 run phase/tick 摘要（管理面 + 运行选择器）
  - [ ] `GET /api/runs/{id}/status` — `query_run_status` 全量：phase/tick/fired/outputs/node_states/error/updated_at
  - [ ] `GET /api/runs/{id}/timeline?filter=...` — `build_timeline`，支持 failed/tick/node 过滤
  - [ ] `GET /api/runs/{id}/checkpoints` — `build_checkpoints`
  - [ ] `GET /api/runs/{id}/snapshot?tick=N` — `load_snapshot_summary`（缺省最新）
  - [ ] `GET /api/runs/{id}/feed` — **feed.py 兼容组合端点**（status+timeline+checkpoints），前端 v1 先吃这份数据
- [ ] 管理端点（薄层写操作）
  - [ ] `POST /api/runs/{id}/checkpoints {label}` — `query.create_checkpoint`（纯数据操作，运行中也能用）
  - [ ] `GET /api/modules` — `store.list_modules` 摘要
- [ ] 图端点（运行时图视图消费）
  - [ ] `GET /api/runs/{id}/graph?module=` — 库侧 `build_run_graph`（module_inputs 归档重建，见下节设计）+ `graph_to_dict` 序列化 + 叠加每节点运行摘要（fired_count/last_status/last_tick/running）
  - [ ] 无 run 直渲染端点（原 `POST /api/graph/render`）推迟至阶段 3 图构建器（库函数保留 tasklist 直渲染通道）
- [ ] 实时推送
  - [ ] `WS /api/runs/{id}/stream` — 后端 ~1s 轮询 status.json mtime + run.sqlite latest_tick（与 feed 同一数据源，不改库），变化才推 `{phase, tick, fireable, fired, outputs, error, updated_at}`
- [ ] 测试：pytest + TestClient，造最小 fixture run（直接构造 run.sqlite）覆盖每个端点

### 阶段 1 —— 运行时可视化（数据面阶段 0 已备齐）

本轮切片（2026-08-29 定稿，设计见「运行时图视图设计」节）：

- [ ] 运行时图视图：图结构 + 节点状态徽章（已完成/运行中/失败/未运行/次数）+ 跟随镜头 + 点击节点面板（firing 历史 / 实时输出）

后续切片：

- [ ] 状态面板：tick 流实时推送 → 全量状态侧栏
- [ ] 历史审阅时间线：复用 `build_timeline`，逐 tick 看产出/错误
- [ ] 产出对比：前后（原始 vs 整理 vs 润色）对比面板

### 阶段 2 —— 可视化管理

- [ ] 模块列表（store.list_modules）
- [ ] 运行列表/选择器 + 检查点管理（列表、命名）

### 阶段 3 —— tasklist 图构建器（可选 / 远期）

- [ ] 图编辑（拖拽节点，graph/render 往返验证）

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
