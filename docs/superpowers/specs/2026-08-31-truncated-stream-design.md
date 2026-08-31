# 设计：max_ticks 截断终态（truncated）+ LLM 流式落盘（stream.log）

日期：2026-08-31
状态：已定稿（用户确认方案 A1 + B1 + NodePanel 实时区）
前置：`2026-08-31-control-gaps-design.md`（控制缺口 7 项已落地，本设计根除其中的缺口 ④ 残留）

## 1. 背景与动机

控制缺口实施后仍有两个根子问题留在库里：

1. **截断无终态**：`Module._finalize_phase` 把 `RunStatus.RUNNING`（唯一来源 = max_ticks 耗尽；
   pause 挂起发生在 `run_until_idle` 内部不返回）刻意写成 `_write_phase("running")`。
   status.json 永远等不到终态 → webview WS 不 close、黄条靠 120s 静默启发式猜"进程失联还是
   真在跑"、RunList 把截断 run 显示成 running。启发式对长 tick（5-10 分钟，多 LLM 调用）必然误报。
2. **流式输出跨进程不可见**：harness 每个LLM chunk 无条件发 `LlmToken` 事件
   （`harness.py` `on_token`），但 EventBus 是进程内的——webview 监控的是另一个进程
   （CLI 拉起的 resume 子进程），一个 token 都看不到。NodePanel 只能等 firing 完成
   后从 run.sqlite 读 outputs，无法流式显示。

## 2. 目标 / 非目标

**目标**

- A：max_ticks 截断产出真实终态 phase `truncated`，监控方零猜测。
- B：LLM 流式输出落盘 `<run_dir>/stream.log`（JSONL），跨进程可读；库内自动接线，
  消费端（CLI run/resume、库用户、webview 子进程监控）零接线受益。
- webview：NodePanel 实时区流式显示；存活检测信号源升级（token 心跳替代 phase 边界心跳）；
  truncated 进入终态按钮矩阵；黄条只对真停滞出现。

**非目标**

- tick 内 pause/cancel（LLM 调用中途打断）——深改 harness/LLM client，ROI 存疑，继续推迟。
- stream.log 轮转/大小上限——单 run 文本量级 KB~MB，append 足够；真需要时另立项。
- 直渲染通道、TUI/MCP 消费端适配——不在本轮。

## 3. 方案总览（已选定）

| 决策点 | 选定方案 | 否决项 |
|---|---|---|
| A 截断语义 | **A1**：新终态 phase `truncated` | A2 加 bool 字段（status.json 仍无终态语义）；A3 映射 CANCELLED（污染取消语义） |
| B 接线位置 | **B1**：库内 Module 自动订阅 EventBus 写盘 | B2 harness on_token 直写（不知 base_dir/run_id，绕过事件总线）；B3 轮询 run.sqlite（firings 本来就只在完成后写） |
| stream.log 开关 | **默认开**，独立 flag `stream_log=True`（与 status_file/control 同级） | 挂 persist 下（flag 语义混杂）；默认关（webview 监控的 CLI 子进程无法透传 flag，端到端失效） |
| 前端展示 | **NodePanel 实时区**（选中节点的流式文本追加，终态后由 outputs 接管） | 独立日志侧栏（占屏、双轨）；两者都做（首轮工作量翻倍） |

实施顺序：库先行（两个独立 commit，遵守 `../SpecModule/AGENTS.md`，api.md 补录），
webview 随后薄适配。依赖关系：webview 开发环境是 editable install（`pip install -e ../SpecModule`），
无需等发版。

## 4. A：truncated 终态（库侧）

### 4.1 语义

phase 机器从 `running → done | aborted | cancelled` 扩为
`running → done | aborted | cancelled | truncated`：

- `truncated` = 引擎因 max_ticks 上限停止，图未到 idle，**可 resume 续跑**。
- `error` 字段携带原因（非异常，是停止原因，与 aborted 用 error 记 cancel_reason 同款）：
  `"max_ticks=N 截断（可 resume 续跑）"`。
- 映射点唯一：`module.py _finalize_phase` 的 `RunStatus.RUNNING` 分支改写。
  `_write_phase` docstring 与 `status.py` `ModuleStatus.phase` 注释同步更新。

### 4.2 兼容性盘点（phase 消费方）

| 消费方 | 现状 | 动作 |
|---|---|---|
| 库 `feed.py` / `query.py` | phase 直传不过滤 | 无需改 |
| 库 CLI `status`/`review` | phase 原样打印 | 无需改 |
| 库测试 `test_run_status.py::test_max_ticks_cutoff_not_done` | 断言"截断后保持 running" | **翻转**：断言 `truncated` + error 前缀，改名 `test_max_ticks_cutoff_truncated` |
| webview `api.ts TERMINAL_PHASES` / `ws.py _TERMINAL` | 白名单三元组 | 并入 `truncated` |
| webview 黄条/RunList/RunControls | running 启发式 | 见 §6 |
| TUI / MCP 兄弟仓库 | 无 phase 白名单（直传） | 不动，记录偏差 |

### 4.3 新测试（库）

- 翻转现有截断测试（见上表）。
- `truncated` 可续跑：max_ticks=1 跑到 truncated → 新 Module `resume()` → done（mock LLM）。

## 5. B：stream.log（库侧）

### 5.1 文件与记录格式

位置：`<base_dir>/.specmodule/runs/<run_id>/stream.log`（status.json 同目录）。
格式：JSON Lines，UTF-8，append-only（不因新执行截断——崩溃残留可事后查看）。
每次执行以一条 `run_start` 开边界。所有记录的 `ts` 由**写入方**打 wall-clock
（`time.time()`）——harness 事件的 `timestamp` 是 `time.monotonic()`（进程本地），
不落盘、不跨进程比较。

| type | 触发事件 | 字段 |
|---|---|---|
| `run_start` | `_run_with_phases` 开始（clear_control 之后、写 running phase 之前） | `ts`, `pid`, `max_ticks` |
| `call_start` | `LlmCallStarted` | `ts`, `node`, `model`, `prompt_chars` |
| `token` | `LlmToken` | `ts`, `node`, `chunk` |
| `call_end` | `LlmCallCompleted` | `ts`, `node`, `content_chars`, `finish_reason` |
| `call_error` | `HarnessFailed`（LLMError 路径，fill 补 call 的结束边界） | `ts`, `node`, `reason`, `failure_type` |

不带 tick 字段（harness 事件恒为 tick=0，落盘假数据不如不写）。

### 5.2 写入器：新模块 `module_harness/stream.py`

- `StreamLogWriter(path: Path)`：懒开文件句柄（`"a"`，目录 `mkdir(parents=True)`）；
  每记录 `write + flush`（无 fsync，OS 缓冲足够，token 频率下开销可忽略）；
  `close()` 幂等。写失败仅 log 不抛（镜像 `_write_phase` 哲学：观测不阻断运行）。
- 职责边界：stream.py 只出 writer 与记录构造；EventBus 接线放 Module 内部（见 5.3）。

### 5.3 Module 接线

- 新参数 `stream_log: bool = True`（`__init__` keyword-only，与 status_file/control 并排；
  docstring 注明 `EventBus.null()` 场景只有 `run_start`，无 token 记录）。
- 订阅一次（守卫 flag，防 run()/resume() 多次执行重复订阅导致记录翻倍）：
  向 `self._reg._event_bus` 订阅上表 4 类事件；回调不闭包具体 writer，而是读
  Module 的当前 writer 属性（每次执行重建，订阅只挂一次，无陈旧引用）。
- writer 生命周期 = 一次执行：`_run_with_phases` 开头建 writer（`stream_log=True` 时）→
  写 `run_start` → **然后**才 `_write_phase("running")`（保证 webview 见到 running 时
  锚点记录已存在）；`finally` 关闭（异常路径也关，已 flush 记录不丢）。

### 5.4 共享读端：`query.read_stream`

消费端（webview WS / 未来 TUI）不做文件解析，统一走共享层：

```python
def read_stream(run_id, *, offset=0, base_dir=None) -> dict | None
# 文件缺失 → None。
# 二进制 seek(offset) 读到 EOF；按 \n 切完整行；行首字节偏移记入每条记录的 "off"；
# 末尾不完整行不消费（next_offset 停在其行首，等下次补齐）；
# JSON 解析失败的行跳过（崩溃瞬间可能出半行）。
# 返回 {"records": [{...记录字段, "off": int}], "next_offset": int, "file_size": int}
```

锚定策略（"只显示最近一次执行"）**不进库**——ws.py 拿 `off` 自行定位最后一条
`run_start` 之后的首条记录（3 行逻辑，展示策略留在展示层）。

### 5.5 库测试（新 `test_stream_log.py` + 接线用例）

1. writer 单元：五类记录形状与顺序；`run_start` 在前；close 幂等。
2. Module 接线（默认 flag）：fake LLM client（`complete(..., on_token=cb)` 内先
   `cb("你好")` 再返回 `LLMResponse`）跑通 → stream.log 含
   run_start/call_start/token/call_end 全链。
3. LLMError 路径 → `call_error` 记录。
4. `stream_log=False` → 无文件；`status_file=False` 组合互不影响。
5. 两次执行（run 截断 → resume）→ 两条 `run_start`，append 不截断。
6. `read_stream`：缺失 None；offset 递进；半行不消费；坏行跳过；off 正确。
7. 运行中途抛异常 → writer 仍关闭，已写记录可读。

## 6. webview 适配（薄层）

### 6.1 `server/ws.py`

- `_TERMINAL` 并入 `"truncated"`。
- 每连接追加流追尾状态：`stream_offset: int | None`（None = 未锚定）。
- 轮询循环每拍：
  1. `query_run_status` 照旧；首次见到 `phase == "running"` 且未锚定 →
     `read_stream(offset=0)` 定位最后一条 `run_start`，以**它的 `off` 为起点（含
     run_start 本身——前端以该记录为清缓冲信号，锚定路径与增量路径行为一致）**，
     推 `{"type": "stream", "records": [...]}`（去掉 off），记住 offset。已锚定后
     每拍增量读，有新记录才推（天然按 1s 轮询批量，限频）。
  2. status 推送新增字段 `stream_mtime: float | null`
     （`stream.log` 的 mtime；缺失为 null）。主心跳是 WS 消息活动本身（stream
     记录即消息）；此字段为辅助：重连/初连时前端无需等首个 stream 消息即可取值，
     也供 UI 展示"最后输出时间"。
  3. 推送顺序：stream 先于 status；终态时先补发最后一批 stream 再推终态 status、
     `close(1000)`（truncated 同样走终态关闭）。

### 6.2 前端

- `api.ts`：`TERMINAL_PHASES += "truncated"`；`StatusMsg += stream_mtime: number | null`；
  `StreamMsg` 类型 `{type: "stream", records: StreamRecord[]}`。
- `ws.ts`：消息联合类型加 StreamMsg；`StreamState` 扩展流缓冲
  `{runId, msg, stream: {text: Record<node, string>, seq: number}}`——
  token 追加到对应节点缓冲；`run_start` 记录清空缓冲（新执行语义）；其余记录只增 seq。
- `App.tsx`：stalled 逻辑**零改动即升级**——lastMsgAt 本就随任意 WS 消息推进，
  stream 消息在 LLM 调用期间持续流动，120s 静默从"长 tick 必误报"变成"真无输出才触发"；
  paused 排除逻辑保留。黄条文案改为纯失联语义（截断不再可能出现：truncated 走终态关闭）。
  流缓冲透传 GraphView → NodePanel。
- `NodePanel.tsx`：新增 `liveText?: string`；`phase === "running"` 且选中节点有流文本时
  在 outputs 区上方渲染"实时输出"区（等宽字体、自动滚底）；终态后隐藏（outputs 接管）。
- `RunList.tsx`：`PHASE_COLOR["truncated"]`（琥珀 `#b45309`）；终态 ↻ 按钮矩阵经
  `TERMINAL_PHASES` 自动覆盖；徽章文本"已截断"。

### 6.3 webview 测试

- `tests/test_ws.py` 扩展：fixture run 目录手写 stream.log（含前一执行残留 + 最后执行
  run_start/token/半行）→ 连 WS：先收锚定后记录、status 带 `stream_mtime`；
  phase=truncated → 推完 close(1000)。缺 stream.log → `stream_mtime: null`、无 stream 消息。
  半行补齐后下一拍才推。
- 前端无测试框架：`npm run build`（tsc）为门禁，NodePanel 实时区人工目验。

## 7. 文档与提交

- 库仓库（独立提交，遵循其 AGENTS.md）：
  - commit 1 `feat: max_ticks 截断终态 truncated`（module.py/status.py/测试 + api.md phase 机器行）
  - commit 2 `feat: LLM 流式落盘 stream.log`（stream.py/module.py/query.py/测试 + api.md
    `stream_log` 参数、记录格式表、`read_stream` 签名）
- 本仓库：ws/前端适配 + 测试；roadmap.md 变更日志 + 缺口 ④ 根除记录；
  AGENTS.md 端点表（WS 消息形状 + stream_mtime）与运行约束更新。

## 8. 风险与权衡

- **phase 新增值**：一切 phase 白名单消费方需同步——本仓库同轮改；feed/CLI 直传无感；
  兄弟仓库无白名单（记录偏差，不做 preemptive 改动）。
- **stream.log 与 Windows 读写并发**：writer 持句柄 append，webview 读侧可能读到半行——
  reader 的"不完整行不消费"契约天然覆盖。
- **EventBus.null()**（嵌入式静默场景）：stream.log 只有 `run_start`，无 token——文档注明，
  属预期。
- **时钟语义**：记录 ts 为 wall-clock，仅用于展示排序与心跳，不作精确测量
  （库内精确测量仍用 monotonic 事件）。
- **双进程同写一 run**：违反既有单写者规则才会发生；append 模式下后果只是行交错，不致命。
