# 运行列表与轮询机制根修设计

日期：2026-09-15
状态：已确认（用户逐项决策）

## 背景与证据

webview 前端对 `GET /api/runs` 周期轮询，运行历史一多整页卡死。实测（4821 个历史 run 目录，其中 2924 个带 run.sqlite）：

| 环节 | 耗时 |
|---|---|
| `GET /api/runs` 端点整体 | ~12.5s（浏览器内排队后 28~35s） |
| `query.list_runs` 全量枚举 | 10.2s，其中给旧 run 逐个开 `SqliteBackend` 查 latest_tick 占 6.6s |
| 逐 run `control.read_control` 叠加 paused | 0.16s（非瓶颈） |
| 单 run 端点（status/graph/...） | 0.27s 量级（无问题） |

根因是机制性的：**列表端点每次轮询全量枚举并逐个打开全部历史 run**，成本随历史线性增长，任何局部优化只能续命。

## 用户决策（设计输入）

1. 监控单位是页签：打开的 run 页签各自轮询单 run 端点（已快），列表无需周期轮询。
2. 列表更新策略 = **手动刷新 + 按需事件钩子**，保留完整历史浏览诉求（尾部以计数透出）。
3. 上游机制选 **方案 A**：新增惰性原语 `recent_runs`，不引入索引文件等持久状态。

## 目标与非目标

**目标**
1. 列表单次获取成本与历史规模解耦（任意规模 < 200ms 量级）。
2. 前端去掉列表周期轮询，改为手动 + 钩子刷新。
3. 共享机制收编上游库（统一 API 原则），webview 保持薄映射。

**非目标**
- 不做索引文件；不给 CLI `runs` 加分页/limit 参数。
- 不自动清理历史残渣目录（见「范围外建议」）。
- 页签内监控（status/图/时间线/控制）不动。

## 上游库改动（SpecModule 仓库，独立提交）

### 新增 `query.recent_runs(base_dir=None, limit=100) -> dict`

- `os.scandir` 扫 runs 根，取目录名 + status.json mtime（scandir 在 Windows 自带 find 数据，不额外打开文件；4821 目录 0.01s），按 mtime 降序。
- 只对前 `limit` 条读 status.json 构建完整行，行形状与 `list_runs` 一致（run_id/module/phase/tick/error/updated_at/has_sqlite）；**不开 SQLite 查 tick**（旧 run 无 status.json tick 键 → None；运行中 run 每 tick 重写 status.json，必然带 tick 且 mtime 新近、必然在前 N 内）。
- 返回 `{"runs": [...], "total": <run 目录总数>}`；`total` 供 UI 透出「共 N 条，更早历史用 CLI 查看」。
- 容错沿用 `list_runs`：status.json 缺失/损坏 → phase="unknown" 收入不跳过；runs 根不存在 → `{"runs": [], "total": 0}`。
- 内部与 `list_runs` 共享单行构建辅助（抽 `_run_row`），避免两份行形状实现。

### `_latest_tick_light` 换只读裸 sqlite3

- 现实现 `SqliteBackend.__init__` 每次 open 都 `PRAGMA journal_mode=WAL` + 建表检查（写锁，实测 2.3ms/次）。
- 换 `sqlite3.connect("file:<path>?mode=ro", uri=True)`（路径经 `Path.as_uri()` 百分号编码，兼容中文/空格）+ 同一条 `SELECT MAX(tick) FROM snapshots WHERE session_id = ?`；任何 `sqlite3.Error` → None（「失败 → None」契约不变）。
- `list_runs`（CLI 全量列表）从 ~10.2s → ~4s，语义零变化。

## webview 后端（本仓库）

- `GET /api/runs` 改为 `query.recent_runs` 薄调用，对返回的 N 行叠加 `paused`（read_control，N 行 ≈ 3ms），响应形状 `{"runs": [...], "total": n}`。
- 其余端点不动。

## webview 前端

- 去掉列表 `setInterval` 轮询；列表成长驻 state，刷新触发点：
  1. 首次进入（app 启动 / 首次需要渲染列表）；
  2. 手动刷新按钮（常驻）；
  3. 发起运行成功（POST /api/runs 202）后；
  4. 删除 run 成功后；
  5. 打开页签内 run 到达终态（WS 终帧）时。
- 列表尾部按 `total` 显示「共 N 条 · 更早历史用 `specmodule runs` 查看」。
- 单 run 页签的 WS 流与状态轮询完全不变。

## 测试 / 文档 / 提交切分

- **库仓库**：`test_run_history.py` 增 `TestRecentRuns`（空根、非目录跳过、limit 截断、mtime 排序、损坏 status 容错、tick 不回落 sqlite、total 计数）；`_latest_tick_light` 只读路径由既有 `test_tick_from_latest_snapshot` 覆盖。跑库测试基线。`docs/references/api.md` 补录 `recent_runs`。独立提交。
- **本仓库**：`/api/runs` 端点测试改断言新形状（含 total）；AGENTS.md 端点表行更新；roadmap.md 变更日志记录。独立提交。
- 前端无测试设施，浏览器实测（刷新按钮、各钩子、尾部提示）。

## 范围外建议

`.specmodule/runs` 现存 4821 个历史目录（多为 `bad_*` 测试残渣）在新机制下无害；日后可手动归档或 `specmodule delete-run` 清理。
