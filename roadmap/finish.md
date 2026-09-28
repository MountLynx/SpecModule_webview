# 已完成归档

> 方向规划与排期见 [roadmap.md](roadmap.md)；问题与遗留见 GitHub issues。
> 2026-09-24 起 roadmap 主文档只记方向与排期，本文承接已完成的阶段清单、定稿设计与历史变更日志。

## 阶段 0 —— HTTP 后端层（2026-08-29 落地）

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
  - [x] `GET /api/runs/{id}/graph?module=` — 库侧 `build_run_graph`（module_inputs 归档重建）+ `graph_to_dict` 序列化 + 叠加每节点运行摘要（fired_count/last_status/last_tick/running）
- [x] 实时推送
  - [x] `WS /api/runs/{id}/stream` — 后端 ~1s 轮询 status.json mtime + run.sqlite latest_tick（与 feed 同一数据源，不改库），变化才推 `{phase, tick, fireable, fired, outputs, error, updated_at}`
- [x] 测试：pytest + TestClient，造最小 fixture run（直接构造 run.sqlite）覆盖每个端点

## 阶段 1 —— 运行时可视化：运行时图视图切片（2026-08-29 落地）

- [x] 运行时图视图：图结构 + 节点状态徽章（已完成/运行中/失败/未运行/次数）+ 跟随镜头 + 点击节点面板（firing 历史 / 实时输出）

剩余切片（状态面板/历史审阅时间线/产出对比）见 [roadmap.md](roadmap.md)。

## 阶段 2 —— 可视化管理（2026-09-03 落地）

- [x] 模块列表 + 模块详情（2026-09-03 落地）：`GET /api/modules`
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

后排清单（2026-09-03 盘点，等真实使用中疼了再动）已整体转
[GitHub issue #5](https://github.com/MountLynx/SpecModule_webview/issues/5)
（store 生命周期管理界面 / init 脚手架入口 / run 重命名 / 复跑 / 中间快照复跑入口 / 批量删除运行历史）。

## 运行时图视图设计（2026-08-29 定稿并落地）

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
  （上游可改为按写入序取最新，本轮不动）。（已转
  [issue #8](https://github.com/MountLynx/SpecModule_webview/issues/8)）

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

## 历史变更日志（2026-08-27 ~ 2026-09-24）

> 存档。后续完成记录按需追加于此，roadmap 主文档不再记日志。

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
  `control.paused()` 待真实第三形态出现再动；→
  [issue #9](https://github.com/MountLynx/SpecModule_webview/issues/9)）；行内控制按钮无 busy 态（双击幂等；→
  [issue #10](https://github.com/MountLynx/SpecModule_webview/issues/10)）。
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
  发现锚定 + status.json `module` 溯源字段；c5e64c3 api.md 补录）——已知偏差的模块溯源项
  正式销项。本仓库 server：`GET /api/runs` 改 `list_runs` 薄映射（删除自扫
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
  `search=` 透传记后排（→
  [issue #7](https://github.com/MountLynx/SpecModule_webview/issues/7)）。
  前端（无新依赖）：App 壳层顶部视图切换（模块库/运行历史/运行视图，无 router）；
  ModulesView 左列表右详情（模板 default 标注/spec_schema 字段表/default_spec 预览/
  扫描来源行）；RunDialog + SpecForm（spec_schema/default_spec 驱动类型化表单 ⇄ JSON
  双模式双向同步、字段级 JSON 子编辑器失焦校验、spec 空且无 default_spec 提交禁用）；
  RunsView 升格全宽历史（module 名溯源回落启发式、phase 徽章、错误摘要、行内查看/
  删除——running 先取消可 force 强删二次确认）；运行视图图加载失败区挂 process.log 尾
  （3s 轮询，CLI 启动期失败界面可见）。AGENTS.md 端点表同步三行 + base_dir 纪律补
  搜索锚定。测试：本仓库 84 项全绿；后排清单转
  [issue #5](https://github.com/MountLynx/SpecModule_webview/issues/5)（store 生命周期界面/init 脚手架/
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
  钩子兜底），留后续处理（→
  [issue #6](https://github.com/MountLynx/SpecModule_webview/issues/6)）。设计/计划：
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
- 2026-09-17 **启动界面优化三：模板切换联动**——上游 per-template spec 通道（设计二）就位后
  消费端跟进：详情「模板」徽章可点切换（高亮跟随、「（默认）」缀标锚定默认模板、description
  显示于徽章下方），发起表单 `<select>` 移除两处合一；spec 字段表/spec 参考/SpecForm 随选中
  模板换源（库内 spec_for 解析值；切换即重置为新模板参考值，SpecForm 按 name:template key
  重挂载零改动）；提交 spec 显式性改 submit 单点判定（未动过且与 entry 级 default_spec 相同
  → 不传走回落；否则显式传——修复切模板后 CLI 回落恒指 entry 级与表单所见错位）。兼修
  api.ts templates 类型未跟上游形状变更导致的详情面板渲染崩溃。server 补双模板形状锚定测试。
  设计：docs/superpowers/specs/2026-09-17-template-switch-launch-ui-design.md
- 2026-09-17 **上游收编：resume/rollback 存档模板溯源**——启动界面优化三验收发现的图重建
  缺口（非默认模板 run 报 harness not found）补修后，联动缺口随即显性：CLI resume/rollback
  模板解析仍是 `args.template or default_template`（cli.py），非默认模板发起的 run 续跑会被
  静默按默认模板重译——compat 硬错误拦不住（只查新图自洽与新成为 start），轻则警告后续跑
  出残缺输出，且归档新输入会覆盖 module_inputs 污染溯源；webview 恢复对话框因不传 template
  全量中招，preflight（按归档校验）与实跑行为不一致。上游两连提交收编：703103c 存档记录
  所选模板（module_inputs.template）+ 图重建/预检按存档模板注册 harness（缺口修复）；
  d9cf92a resume/rollback 模板解析改「显式 --template > 存档模板 > default_template >
  归档 tasklist」（与既有 tasklist 兜底同原则；存档模板已注销 → 报错不静默回落；webview
  零改动受益）。兼修 webview dev 环境两缺口（289c032）：补 pytest-asyncio/jsonschema——
  uv 迁移后上游基线 129 用例因缺插件假红。基线 676 passed 全绿。
- 2026-09-18 **运行视图布局重排：图转竖向 + 连线上下进出 + 节点详情右侧栏**——运行图
  dagre 分层 `rankdir` LR→TB：节点为宽扁长方形，沿短边纵向逐层延伸、同层节点横向并排，
  一屏纵向可容纳更多层，信息密度高于横向；StatusNode 连接点左/右→上/下（连线自上节点
  底部连至下节点顶部），内层盒子 `height:100%` 填满 wrapper 使连接点贴合节点边缘。
  流节点显式携带布局标称尺寸（`NODE_SIZE`）——React Flow MiniMap 按 userNode 自身尺寸
  过滤渲染，无尺寸会被整体画空（缩略图空白根因）。节点详情面板（NodePanel）为图区右侧
  全高侧栏（380px，与图区 flex 并排）。兼记一坑：Vite watcher 漏掉同批对 StatusNode 的
  第二次写入，模块缓存冻在半新半旧中间态（target 已 top / source 仍 right），reload 无效，
  对该文件再次真实内容修改强制重转换后才生效。`npm run build` 通过 + dev 页面截图走查。
- 2026-09-18 **启动界面优化四：spec 表单水印 + spec 参考显式按钮**——SpecForm 未动过的
  字段渲染为空框 + 灰色 placeholder(=默认值)，聚焦即隐；values 里始终保留默认值，提交
  语义与实值预填完全一致（所见即所跑）。ModuleDetail「spec 参考」pre 由点击运行改为纯
  展示（whitespace-pre-wrap 防长行溢出），另设「用参考 spec 尝试运行」outline 按钮显式
  触发（上一会话遗留提交）。
- 2026-09-18 **LLM 思考通道全链路真流式**：上游 SpecModule `complete(on_thinking=)` 双回调——
  OpenAI 兼容 `reasoning_content`/`reasoning` 方言 + content 内联 `<think>` 剥离（流式/非流式
  均剥，返回 content 不含思考文本）+ Anthropic `thinking_delta` + RoutingClient 透传
  （SpecModule 11abbda/0c40601/d2e4746/32035f2，api.md 已补录 a6df7fd）；harness 发
  `LlmThinking` 事件 → stream.log `thinking` 记录 → server WS 泛化透传（推送节奏 1s→0.2s，
  透传契约测试钉住）→ NodePanel 思考块（思考中自动展开、正文到达自动收起「已思考 N 字」，
  双 ref 分对象自动滚动）。treechat 回合 SSE `thinking` 帧（不经 FieldStreamShaper 原样透传，
  grilling 形状用例钉住）→ ChatView 思考行 + token/thinking rAF 合帧（防逐 token 重渲染风暴，
  帧 ~16ms 合帧刷入）。兼收上游测试卫生根修（a9fb175：module_harness 测试 run 工件锚定
  tmp_path，基线跑不再向 cwd 泄漏垃圾）。设计：
  docs/superpowers/specs/2026-09-18-llm-thinking-streaming-design.md
- 2026-09-18 **两侧侧边栏可拖宽**：新增共用 `ResizeHandle` 组件 + `useResizableWidth` hook
  （components/ResizeHandle.tsx）——手柄为夹在侧栏与相邻区之间的细竖条（pointer capture
  拖拽，拖动期间 body 禁选中 + 全局 col-resize 光标；双击复位），左侧栏（280px，
  200–520）与右侧节点面板（380px，260–720）各接一份，宽度 localStorage 持久化
  （`specmodule-webview.sidebar.*`；右栏随节点切换重挂载靠持久化恢复）。`npm run build`
  通过 + mock run 全链路浏览器走查（拖宽/钳制/持久化/复位/节点切换保持）。
- 2026-09-19 **界面美化（B·状态染色方向）全量落地**：状态色三阶令牌（`--ph-*-bg/border/text`
  亮暗）+ Pill 胶囊两态（选中=primary 反色）/Spinner 基件；图视图染色节点（浸染底+
  lucide 状态图标+运行光环）与活跃边蓝色流动、Minimap 着色、跟随状态按钮（跟随中/
  已解锁/回到当前 + F 快捷键，修饰键组合让位）；NodePanel V2（粘性状态头部/输入标签
  胶囊/输出卡三态——script 运行占位+流式+终态复制，节点级 live 判定（run 运行中且该
  节点在流式或 fireable 执行集）/时间线运行记录（终态自动刷新））；ThinkBlock 共享
  思考块（chat 与 run 侧栏同源）；控制条/列表/对话框/页签 lucide 图标化 + TabBar 激活
  胶囊（primary 反色）；字号阶收敛 11/12/13/15。设计：
  docs/superpowers/specs/2026-09-19-ui-polish-status-tint-design.md；实施计划：
  docs/superpowers/plans/2026-09-19-ui-polish-status-tint.md
- 2026-09-20（chat 轮次节点合并 + 树图导航化）：节点改为「一轮一问答」（事件日志零改动
  零迁移——assistant_msg 重放语义改为回填父轮 output 并推进指针到轮；旧会话中 user 的
  parent 指向 assistant seq 的真实旧数据经 legacy 映射重放归一化，卡片 fromPath 序列化
  同步归一化）。`unanswered_user` → `unanswered`（无 output 最新轮）；上下文组装按轮展开
  input/output；branch_segment 恒含 fork 轮；node_count 计轮数。新增
  `POST /api/sessions/{sid}/pointer`（内存 set_pointer 导航端点）。前端：树图点选 = 纯
  导航（指针挪到该轮 + 主区切分支 + 滚动闪烁聚焦），侧栏详情卡删除，命名/选入卡片范围/
  从此分支迁至主区轮末悬停操作条；Composer「从 #N 分支」提示改直读 pointer≠trunkEnd
  （branchParent 暂存态退役）；treelayout 根链落 lane 强制隔一 lane（修叶子链贴主干被
  误读成分支）+ LANE_W 22→26。旧会话实测（test直答 12 消息 → 6 轮）全链路走查通过。
  设计：docs/superpowers/specs/2026-09-20-chat-turn-node-ux-design.md；实施计划：
  docs/superpowers/plans/2026-09-20-chat-turn-node-ux.md
- 2026-09-21 卡片双层作用域 + 会话内模式切换（specs/2026-09-21-card-scopes-mode-switch-design）：
  card_create 增 owner_seq/doc_key（节点卡/全局卡双层，旧文件零迁移）；grilling 文档逐轮
  版本化挂轮（doc:<key>@<seq>），上下文沿路径取最近祖先版本——分支取分支点时点版本、
  叶子空文档（legacy spec:* 卡回退）、模式往返不丢卡；会话内模式切换（Composer chip +
  斜杠快速切换 + UserMsg 逐轮记录 + retry 锁定原模式 + done 自动切直答）；前端卡片迁入
  右侧边栏（节点卡区版本链/升为全局/导出/删除确认 + 全局卡区按 ownerSeq 过滤），cards
  活动栏页签退役。审查后排：RunBlock 文档 ref 片仅开栏不定位到目标轮；斜杠切换+发送时
  模式 chip 回显滞后一个回合；引擎 unpin 对节点卡静默成功（与 pin 的显式拒绝不对称）。
- 2026-09-23 审查后排三项清账：① 引擎 unpin 对节点卡改显式拒绝（`cards.py` 与 pin 对称
  抛 `TreeChatError`，测试钉住；webapp/CLI 既有 TreeChatError 映射直接透出，重放防线——
  节点卡恒不 pin，正常事件流不产生节点卡 unpin）；② 斜杠切换+发送时 `send()` 把
  setCategory 返回的 ConvState 即时写回本地（此前丢弃，chip 要等回合结束 refreshSessions
  才追上）——模式 chip 本轮即回显新模式，写 category 失败仍不阻断回合（turn 自带 module）；
  ③ RunBlock 文档 ref 片点击从「只开栏」升级为携带 `run.userSeq` 的定位回调（prop 更名
  onOpenCards→onLocateDoc）：开卡片栏 + 复用 focusSeq 滚动闪烁机制聚焦挂载轮。基线
  278 passed + `npm run build` 通过。
- 2026-09-23 对话树布局重排（treelayout v2，修连线重叠）：行序从「seq 时间序」改为
  「距起点远近」——每棵树 BFS 深度分块（同块内按父序+seq 稳定），多棵树按根 seq 拼接、
  树间半行间隔；晚发生但从早期节点分出的分支落在与原同级分支相邻的行（此前沉底导致
  母边横穿全图，与其它分支曲线在共用控制带精确重合——重叠的直接根源）。lane 占用从
  seq 空间改行空间（首子继承/新枝只向右/lane 被家族从起点行占到首子链末端行，防 BFS
  行序下竖线穿别家节点）；曲线控制带由布局清障选定并随 `Edge.ctrl` 下发渲染端（默认
  跨行中点，穿点或与既有线中部并行贴近时上下搜清障带，贴共享端点竖直列的短共线豁免
  ——git 分叉常态）；行标签统一缩进到最右 lane 右侧（gutter），深 lane 竖线不再压浅
  lane 行文字（BFS 行序下链条不再行连续的必然要求）。每行仍只放一个节点。验证：布局
  不变量红→绿（用户样例 + 300 随机树全过：行号双射/父先于子/树内深度单调/线不穿点/
  线线不重合）+ `npm run build` + 浏览器实测（test 会话 6 节点：#23 与 #7 同级相邻，
  两条曲线控制带 y=66/132 彻底分离）。
- 2026-09-23 「叶子」措辞退役 → 「新起点」：parent=null 节点实为独立分支起点（可自带
  子树，布局按独立树处理），「叶子」是图论误称。改动仅用户可见文案——Web 图例/Composer
  chip 与按钮 title（图标 Leaf→Sprout）+ treechat CLI `/leaf` 帮助与提示文案（test_cli
  断言同步）；标识符与 API 参数（`leaf`/`leafMode`/`onToggleLeaf`/`/leaf` 命令名）不动。
  278 passed + `npm run build` 通过。
- 2026-09-24 斜杠指令面板完整升级（参考 nanobot ThreadComposer）：`web/src/chat/` 新增
  `useSlashPalette` 状态机 hook（触发符注册扩展点/过滤排序/选中态/最近使用 localStorage）+
  `SlashPalette` 展示面板（listbox 无障碍/图标+描述+徽章/视口自适应 above/below/滚动跟随），
  Composer 键盘全路径导航（↑↓ 循环/Tab/Enter 补全/Escape 关闭后续输入重开）、「当前」徽章、
  静态覆盖文本间接层；面板打开时 Enter=补全（行为变化，已认可）；指令集不扩展、后端零改动。
  子代理双审查（规格合规+代码质量）修复三处：recordRecent 副作用移出 setState updater、
  面板测量补 items.length 依赖、「当前」徽章归一化直答缺省+补全空项守卫。设计
  docs/superpowers/specs/2026-09-24-slash-command-palette-design.md，计划
  docs/superpowers/plans/2026-09-24-slash-command-palette.md
- 2026-09-24 **文档结构重组**——roadmap 持续膨胀（变更日志逐次追加、已完成阶段滞留主文档、
  遗留项散落各节）。新规：roadmap 目录化，`roadmap/roadmap.md` 只记方向规划与排期（实时
  更新），已完成归档进本文件；问题与遗留转 GitHub issues（#5 后排清单、#6 resume 后
  RunView/WS 不重挂、#7 上游 search= 透传、#8 latest_tick 语义、#9 paused 三处内联、
  #10 行内控制 busy 态）。
- 2026-09-25 **模块构建器落地：组件库 + 可视化创建 packed 模块**（设计定稿
  docs/superpowers/specs/2026-09-25-module-builder-design.md）。要点：组件库锚
  `store_home/library/`（harness/command JSON + scripts/guards 代码 + submodule 索引 +
  drafts，被引用组件**拷贝进包**——包自包含直接吃库 `validate_pack_dir`/`install_pack`
  语义，零上游改动）；`server/api/build.py` 统一面（`/api/library/{kind}/{name}` CRUD +
  `/api/modules/packs[/validate]` 组装安装，`draft_to_tasklist` 为本层唯一 tasklist 生成
  实现——组装与 dry-run 预览共用）；前端构建板块（ActivityBar build 页签 + LibraryPanel
  侧栏 + builder/ 画布创建器，多草稿多实例页签/防抖自动保存/校验·安装/tasklist 预览）。
  测试：pytest 40 例新增（全套 318 绿）+ tsc 门禁 + API 级端到端验收。执行修正：受控
  v12 画布 onNodeDrag live 通路、组装临时目录自清理、孤立起点 [名] 标记行、编辑对话框
  回填、自动保存竞态。上游联动：SpecModule 01d830b（ModuleLoader lazy_client 沿
  submodule 递归传播——validate_pack_dir 零 LLM 客户端语义在 submodule 场景被破坏）+
  23f6754 / 3a36b5d（api.md validate_pack_dir / install_pack 补录）。计划：
  docs/superpowers/plans/2026-09-25-module-builder.md。
- 2026-09-27 **TreeChat ops agent 落地：chat × module 打通**（进程内工具桥，不走 MCP；run 永不进
  回合关键路径。设计定稿
  docs/superpowers/specs/2026-09-26-treechat-ops-agent-design.md）。切片：S0 上游 `chat()` 工具消息
  形状 + Anthropic 聚合（库仓库 8dea85d / a7fecc4 / 67643d2，api.md 补录）；S1 runservice 提取
  （spawn 编排/进程注册表共享层，control.py 端点薄化，b86fa6e / 7d235ca / 44f75fb）；S2a 工具箱
  基座 + 7 个数据类工具（薄映射，发起走 runservice 共享层，ac10d89 / d724ff5）；S2b agent 循环
  （chat() 多轮 + 迭代上限 + 错误喂回，e625998 / 3993da5）；S2c/S3 ops 模式分派 + ToolContext 贯通
  + SSE tool 帧接线（8290b4a / 1d1b2ee）；S4 前端 RunBlock 工具块 + runId WS 实时进度 + RunView
  跳转（8e4f8d3 / de1a0c6）；S5 refine_spec 能力工具（call_harness 无头 module run，spec 完善
  收口，0a0f955 / 3efecb7）。实施修正（审查产出）：agent 循环 error 真值判定（run_status 恒含
  `error: None` 键，非 None 才判失败）；`run_agent_turn` 回填会话 client 进 ToolContext
  （refine_spec 前置）；runservice `_launch` 成功路径关闭父进程 log_fh（control.py 时代遗留句柄
  泄漏）；runservice 409 载荷补回 `run_id` 键契约。**语义备注**：ops 模式落地将 `resolve_module`
  改内建 key 直查（identity）后，嵌入方 `mode_modules` 不再能解绑/重映射内建模式 key（原「空
  映射解绑 grilling」语义移除）；Map 映射仍对非内建 category 生效。后排/遗留：per-template
  spec_schema 缺口（[#12](https://github.com/MountLynx/SpecModule_webview/issues/12)）；工具轨迹不
  持久化（v1 瞬态）；多节点能力工具的 tool_progress 帧；checkpoint/resume/delete 工具（UI 对话框
  职责）；流式终文（chat_stream 上游候选）；run 终态自动通知会话（引擎层事件机制）——spec 后排明列；
  能力工具提升进 store（refine_spec 型组件与业务 submodule 同类资产）——spec D3 后排。
  验收：pytest 357 绿 + 库基线 680 绿 + `npm run build`
  过 + API 级端到端（live server：ops 回合 SSE 帧序 start(ops)→tool_call/tool_result（list_modules、
  run_module 带 runId、run_status）→done 全部正确，mock run `academic_writer_dcbf1a` phase=done 且
  status 端点一致；control 步骤因 run 已在回合内终态按约跳过；会话/run 即席清理零残留；浏览器
  手工验收留用户）。计划：docs/superpowers/plans/2026-09-27-treechat-ops-agent.md。

## 已安装模块编辑（反解 → 画布 → 装回）——2026-09-28

- 设计定稿：`docs/superpowers/specs/2026-09-28-module-edit-design.md`；实施计划：`docs/superpowers/plans/2026-09-28-module-edit.md`（subagent-driven 执行，逐任务双审）。
- `POST /api/modules/{name}/decompile`：packed 模块反解为构建器草稿（`build_run_graph` tasklist 直渲染通道 + `graph_to_dict`，Flow 零反解析；join 返回大写 AND/OR 与草稿模型一致）+ 包内组件导入组件库三态报告（imported/existed/conflicts，冲突沿用库版本）+ submodule 未安装 warnings + `spec_schema.output` 经草稿 `spec_schema_output` 透传保全；外部 pack 漂移（Tasks/Flow 不一致、input 侧非 dict）→ 400 兜底，草稿校验前置于组件导入（零半入库）。
- `POST /api/modules/packs/update`：草稿同名覆盖更新已装模块（组装 → validate_pack_dir 显式先行 → 库 `apply_update`；未安装 404、entry/pip 400、损坏目标/文件占用 → 400）；roundtrip 测试断言落盘 manifest/包内容（apply_update 此前上游零测试覆盖）。
- 前端：模块详情 packed 模块「编辑」按钮 + 反解报告面板（404 收窄防误覆盖）；构建器「更新模块」按钮（与安装互斥展示，按草稿当前 meta.name 作用——所见即所装）+ 反解草稿载入自动 dagre 布局。
- 库侧零代码改动；api.md 补录 `apply_update`（含回滚窗口精确语义，库仓库独立 docs 提交）。
- 遗留：上游 apply_update 遮蔽/回滚窗口边缘、OSError 粒度等 → GitHub issues（见 roadmap 索引）。
