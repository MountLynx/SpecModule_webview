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
├── web/                     # 前端 SPA（下一阶段，先留空目录）
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
- [ ] 图端点（图构建器 + 节点状态图共用）
  - [ ] `POST /api/graph/render {module, spec?, tasklist?, run_id?}` — translator + graph_builder 渲染图结构，传 run_id 时叠加节点运行状态
- [ ] 实时推送
  - [ ] `WS /api/runs/{id}/stream` — 后端轮询 status.json / run.sqlite 的 tick 变化（与 feed 同一数据源，不改库），推 phase/tick/fired/outputs 增量
- [ ] 测试：pytest + TestClient，造最小 fixture run（直接构造 run.sqlite）覆盖每个端点

### 阶段 1 —— 运行时可视化（数据面阶段 0 已备齐）

- [ ] 实时运行状态：tick 流实时推送 → 状态面板
- [ ] 节点状态图：graph/render + status 叠加 → tickflow 图节点状态可视化（已 fire / 可 fire / 失败）
- [ ] 历史审阅时间线：复用 `build_timeline`，逐 tick 看产出/错误
- [ ] 产出对比：前后（原始 vs 整理 vs 润色）对比面板

### 阶段 2 —— 可视化管理

- [ ] 模块列表（store.list_modules）
- [ ] 运行列表/选择器 + 检查点管理（列表、命名）

### 阶段 3 —— tasklist 图构建器（可选 / 远期）

- [ ] 图编辑（拖拽节点，graph/render 往返验证）

## 数据契约与错误处理

- 数据结构**全部复用** query.py 的 to_dict 出口（`timeline_to_dict` / `checkpoints_to_dict` /
  snapshot dict），status 字段形状与 feed.py 一致；**唯一新写的数据形状是 graph 结构**
  （nodes: id/label/type/inputs；edges: from/to）——库侧 graph_builder 输出 tickflow Graph，
  不适合直接给前端，由 server/api/graph.py 做序列化适配。
- 错误处理继承查询层容错哲学：查询层返回 None（无运行 / DB 读失败）→ 后端映射 404 +
  `{error: "无运行记录"}`；`create_checkpoint` 的 KeyError（消息带可用清单）→ 4xx 原样透出；
  未知 run_id → 404。

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
`httpx`（测试）。

## 变更日志

- 2026-08-27：初始 roadmap 完善——定稿阶段 0 HTTP 后端层设计（技术选型 FastAPI 薄层、
  端点清单、graph 结构为唯一新数据形状、错误处理契约），新增统一 API 原则与 api.md 同步条款。
