# TreeChat 模块运营模式（ops agent）：chat × module 打通（设计定稿）

> 2026-09-26 定稿。用户指令核心：**treechat 能看 module 信息、交互完善 spec、发起
> 运行、查看结果、监控与控制；问是否直接复用 SpecModule_mcp。**
> 关键决策（问答收敛）：不走 MCP——进程内工具桥严格更优（D1）；agent 循环用
> `client.chat(messages, tools)` 纯 Python 循环、不进 harness（D2）；循环内的
> **能力组件**用 module 写、数据组件保持薄函数——两层工具箱（D3）；run 永不进
> 回合关键路径（无 wait_run，监控职责划界）（D4）；run 编排统一走 webview spawn
> 模型，runservice 从 control.py 提取共享（D5）。

## 定位与范围

- **v1 = ops 对话模式**：treechat 新增 agent 形态模式 `ops`（模块运营）。回合 =
  工具调用循环：查模块库 → 取模块详情（spec_schema）→ 对话内完善 spec → 发起
  run（spawn CLI，秒回 run_id）→ 问答式查状态/快照/时间线 → cancel/pause/unpause。
- **监控职责划界**：chat 负责对话式发起与问答式查询；实时仪表盘归 UI——前端
  RunBlock 用既有 `ws.ts` 按 runId 订阅 tick 流，点开跳 RunView 页签。监控不经过
  LLM（不阻塞、不烧 token、无陈旧状态）。
- **明确后排**（不进 v1）：MCP 传输 / 接 SpecModule_mcp；agent 循环塞进 harness；
  wait_run / 有界等待；run 终态自动通知会话（引擎层事件机制）；checkpoint / resume
  / inputs / preflight / delete_run 工具（UI 对话框职责）；shell / 文件系统类工具；
  流式最终回复（`chat_stream` 上游候选）；工具轨迹持久化（v1 只 SSE + 助手文含
  run_id）；多节点能力工具的 `tool_progress` 帧。

## 决策记录

- **D1 不走 SpecModule_mcp**：MCP 的 run 是其进程内 daemon 线程（server 死则 run
  灭、cancel 只对本 server 启动的 run 有效）——与 webview spawn CLI 模型冲突，控制
  面分裂；工具面缺 module detail（spec_schema 是 spec 完善的校验锚）/ pause /
  inputs / preflight；agent 循环横竖要建，走 MCP 还要多付 stdio 子进程 + JSON-RPC
  客户端成本。MCP 仓库正确定位不变：服务外部 MCP 宿主（Claude Code 等）。
- **D2 循环不进 harness**：harness body 只会调单轮 `complete()`，agent 循环的本质
  是累积 `messages`（含 tool 角色）喂回模型，`complete()` 世界观无法表达；工具报错
  要喂回模型自纠，与 Failure 重试/停机语义相反；引擎卖点（持久化/控制/resume）对
  秒级临时回合全是死重（treechat 直构 Module 时本就全关）。统一的价值保留在 chat
  层契约（分派/锁/持久化/SSE 词汇/错误语义），不在引擎层。
- **D3 两层工具箱**：数据类工具（查询/控制，无 LLM）= 薄函数，与 server/api 同构；
  能力类工具（内部含 LLM 结构化调用）= `call_harness`（单节点）或小 tasklist
  ephemeral Module run（多节点）。skill 在 specmodule 词表里就是 harness。能力工具
  以 module 形态写成后可提升进 store，与业务 module 的 submodule 成为同一类资产。
  边界：能力工具是无头 module run——吃结构化参数吐结构化结果，不挂会话上下文、
  不做文档卡。
- **D4 不阻塞**：`run_module` 走 runservice spawn，秒回 run_id（202 语义）；回合
  时长恒为 LLM 绑定（秒级），会话锁只被秒级回合持有。run 进行中用户可随时插话
  （暂停/查状态/改 spec 重发），每个插话都是新短回合。run 的事实不主动进上下文，
  助手认知永远经工具新鲜获取。
- **D5 编排统一**：spawn CLI + 内存进程注册表 + 互斥是 webview 消费端编排（非库
  逻辑），从 `server/api/control.py` 提取为 `server/runservice.py`，HTTP 端点与
  treechat 工具共用——单一注册表、单一 spawn 模型，treechat 发起的 run 即刻进
  Runs 页签、被既有 WS 流监控。

## 总体架构与数据流

```
用户消息（ops 轮）
   │ session.complete_outcome ── isinstance(AgentMode) 分派
   ▼
agent_bridge.run_agent_turn（Python 循环，≤12 轮迭代）
   ├─ core.context.assemble → messages（system + history + 当前 user）
   ├─ client.chat(messages, tools) ─── llm 包多轮接口（两后端，见 S0）
   │      │ 返回 tool_calls
   │      ▼
   │   工具注册表分派（treechat/tools/）
   │      ├─ 数据类：module_harness 查询/控制 + runservice（spawn）
   │      └─ 能力类：call_harness（refine_spec；无头 module run）
   │      每次调用 → SSE tool_call / tool_result 帧
   ▼
TurnOutcome(message_text=终文, usage=累计) → 落盘 assistant_msg → done 帧
                                                    │
业务 run：runservice spawn CLI 子进程（分钟级，与回合零耦合）─→ run.sqlite/status.json
                                                    └→ 既有 WS 流 → 前端 RunBlock 实时进度
```

## S0 上游小改：`chat()` 的工具消息形状（../SpecModule）

`llm/client.py` 的 `OpenAIClient._convert_messages` 已支持 assistant(tool_calls) 与
tool 角色；**`AnthropicClient._convert_messages` 不支持**（tool 消息会原样透传被
Anthropic API 拒绝）。ops agent 是 `chat()` 的正当新消费端，按统一 API 原则收编
上游：Anthropic 转换补 assistant + tool_calls → `tool_use` 块、tool 角色 →
`tool_result` 用户消息块；`docs/references/api.md` 补录 `chat()` 工具循环契约；
库仓库独立提交。**fallback**：若本轮不动上游，v1 ops 模式限 OpenAI 兼容后端
（Anthropic 后端回合显式报错提示）。

## S1 runservice 提取（`server/runservice.py`）

从 `server/api/control.py` 提取编排段，端点变薄调用；**异常不携带 HTTP 语义**
（工具侧复用同一路径）：

- 自定义异常：`RunServiceError` 基类 + `ModuleUnresolvedError`（端点映射 404）/
  `RunExistsError`（409）/ `ProcessBusyError`（409）/ `InvalidInputError`（400，
  含非法 target 等）。库抛的 `ValueError` 原样上抛（端点 400）。
- `launch_run(module, *, spec, template, run_id, max_ticks, mock, base_dir, search) -> dict`：
  模块解析+加载校验 → run_id 校验 → run 目录已存在 409 语义 → 注册表互斥 →
  spawn CLI `run`（spec 落临时文件 `--spec-file`）→ `{run_id, pid, module}`。
- `resume_run(run_id, *, module, target, spec, tasklist, max_ticks, mock, force,
  base_dir, search) -> dict`：镜像现 post_resume 全部校验链与 spawn 段。
- `terminate_process(run_id) -> dict` / `process_info(run_id, base_dir) -> dict`。
- `_Proc` / `_PROCS` / `_reap` / `_spawn` / 临时文件生命周期整体迁入；
  `server.api.control` 保留端点壳（Depends / HTTPException 映射 / DELETE run 薄映射，
  DELETE 的活性防护调 `runservice.reap`）。测试 monkeypatch 面随迁
  （`server.runservice._spawn`）。

## S2 ops 模式与回合分派（treechat/）

- **`treechat/modules/agent.py`**：`AgentMode` dataclass——`key="ops"`、
  `display_name="模块运营"`、description、`node_order=["ops"]`、`node_label()`
  （SSE start 帧消费同形状，但**不是** ConversationalModule，不走 harness 管线）。
  `BUILT_IN` 收录（类型放宽为 union）；`DEFAULT_MODE_MAP` 增 `"ops": "ops"`
  （会话 category 与 per-turn `module="ops"` 双通道可用）。
- **分派点**：`session.complete_outcome` 在 `module_for(seq)` 后
  `isinstance(module, AgentMode)` 分支 → `agent_bridge.run_agent_turn(...)`；
  其余路径不变。返回复用 `TurnOutcome`（`done=False`，ops 轮不触发自动退出
  category；documents 空）。
- **`treechat/agent_bridge.py`**：循环体——assemble 组 messages（pinned 卡注入
  system，与 build_spec 同源）；每迭代 `await client.chat(messages, tools=注册表
  schemas)`；有 tool_calls → 顺序执行（逐个分派，assistant+tool_calls 与 tool
  结果消息追加进 messages，发 SSE 帧）→ 下一迭代；无 → 终文收束。单轮迭代上限
  `MAX_ITERATIONS = 12`（触顶：停止循环，终文附「已达单轮工具上限，请拆分操作」）。
  usage 跨迭代累计。`LLMError` 上抛（悬而未答轮，retry 契约与 harness 模式一致）。
- **系统提示**（agent_bridge 内模板 + 注册表工具清单自动拼接）：角色（模块运营
  台）、纪律（run 状态永远经工具新鲜获取、不得编造；`run_module` 秒回、终文必须
  含 run_id；工具报错如实转述）。

## S3 工具注册表与 v1 工具清单（`treechat/tools/`）

```python
@dataclass(frozen=True)
class ToolDef:
    name: str
    description: str
    parameters: dict          # JSON Schema（OpenAI function 形；anthropic 侧转换已有）
    handler: Callable[[dict, ToolContext], Awaitable[dict]]

@dataclass(frozen=True)
class ToolContext:
    base_dir: Path
    search: list[Path]        # store.search_paths(base_dir)，与 server/deps 同纪律
    client: Any               # 能力工具复用会话 LLM 客户端
```

- 成功 → 载荷 dict 原样；失败 → handler 抛异常，分派器 catch-all →
  `{"error": str(e)}` 喂回模型（模型可自纠，不炸回合）。
- **ToolContext 装配**：`server/chat.py` mount 时以 base_dir/search 构建（锚定
  server.deps 同一解析），经 webapp `create_app(tool_context=...)` 传入 registry；
  treechat 独立运行（CLI webui）时回落 home 锚定缺省。

数据类 v1（7 个，全部薄映射，读侧直接调库、发起/控制走 runservice）：

| 工具 | 映射 | 载荷要点 |
|---|---|---|
| `list_modules` | `store.list_modules(search=ctx.search, include_pip=True)` | name/kind/version/description |
| `module_detail` | `store.resolve_module_full` + `detail_to_dict` | 含 default_spec/**spec_schema**/templates/submodules |
| `run_module` | `runservice.launch_run(...)` | **秒回** `{run_id, pid, module}` |
| `run_status` | `query_run_status(run_id, base_dir)` | phase/tick/fireable/fired/outputs/error |
| `run_snapshot` | `query.load_snapshot_summary` | 各节点最新输出 |
| `run_timeline` | `build_timeline` + `timeline_to_dict` | v1 带 `failed_only`/`tick` 过滤 + 上限 |
| `run_control` | `control.request_control` | action ∈ cancel/pause/unpause + reason |

能力类 v1（1 个）：**`refine_spec`**——args `{module, draft, requirements?}`；
handler：`module_detail` 取 spec_schema → `call_harness(REFINE_HARNESS_CONFIG,
{schema, draft, requirements}, llm_client=ctx.client)`（HarnessConfig + json_object
output_format，同 extract_card 形制）→ 显式校验产出为 JSON object →
`{spec: {...}}`。这是「chat spec 卡片 → 发起业务 run」的收口件：agent 流 =
list_modules → module_detail → refine_spec →（用户确认）→ run_module。

## SSE 帧契约（v1 增量）

既有帧（start/token/thinking/node_start/node_end/done/error）不变；ops 轮新增：

- `tool_call`：`{id, name, args}` —— 分派前发；
- `tool_result`：`{id, name, ok, summary, runId?}` —— 分派后发；summary 为渲染用
  短句（如 `"5 个模块"` / `"run ab12cd 已发起"` / 错误消息），全量载荷不回传前端；
  runId 存在时前端订阅该 run 的 WS 流。

前端 `streamSse` 分发是泛型的（`onEvent({event, data})`），新帧天然穿透；仅扩
`SseEvent` 类型与 RunBlock 渲染。ops 轮无 token 流（`chat()` 非流式）：RunBlock
过程由工具块构成，终文随 done 全量状态落定。

## 前端改动面

| 文件 | 改动 |
|---|---|
| `web/src/chat/types.ts` | `SseEvent` 联合加 `toolCall`/`toolResult` 变体 |
| `web/src/chat/ChatView.tsx`（RunBlock） | 工具块渲染：名称 + args 折叠 + 结果行（✓/✗ + summary）；runId → `ws.ts` 订阅该 run 实时 tick/phase 行内显示；点击块 → 打开 RunView 页签（既有 openRun 通道） |
| `web/src/chat/ChatListPanel.tsx` | 无改动——ops 经 `/api/modes` 自动进创建选择器 |

## 错误契约

- 工具异常（含 runservice 四类、库 ValueError/KeyError、任何意外）→ 分派器
  catch-all → `{"error": ...}` 喂回模型 + `tool_result ok=false` 帧；**回合不炸**。
- `client.chat()` 抛 `LLMError`（基础设施）→ 回合失败，user 节点悬而未答，SSE
  error 帧 + retry——与 harness 模式同契约。
- 未配置 LLM：`_UnconfiguredClient` 无 `chat` → 分派前探测缺方法 → 同 LLMError
  路径诚实报错。
- 工具面 = server API 已有面的子集，无新增特权；无 shell/文件系统工具。

## 测试与验收

- **S0**（若做上游）：库测试补 Anthropic 工具消息转换形状用例（../SpecModule 仓库）。
- **runservice**：迁移后既有 `tests/` 控制面端点测试全绿（monkeypatch 面更新为
  `server.runservice._spawn`）；launch/resume 校验链单测（409/404/400 语义等价）。
- **agent 循环**：`FakeAgentClient`（脚本化 chat() 序列，带 tool_calls）——循环
  终止 / 迭代上限触顶 / 工具报错喂回后继续 / usage 累计 / LLMError 上抛。
- **webapp SSE**：TestClient 流断言帧序列（start → tool_call/tool_result* →
  done，state 含 assistant 终文）；`TurnBody.module="ops"` 与 category 会话两通道。
- **工具映射**：fixture run 工件（tmp_path isolation pattern）断言各数据工具载荷
  形状与错误契约；refine_spec 用假 client 断言 schema 注入与输出校验。
- **前端**：`npm run build`（tsc）门禁 + 手工端到端。
- **端到端验收场景**：ops 会话——「看看有什么模块」→ list_modules；「用
  academic_writer 写一篇关于 X 的短文，spec 帮我完善」→ module_detail + refine_spec
  → 展示 spec；「可以，跑起来」→ run_module（RunBlock 出现 run_id + WS 实时进度）；
  「先停一下」→ run_control pause；「现在什么状态」→ run_status。

## 实施切分

S0 上游 chat() 工具消息形状（小，可独立）→ S1 runservice 提取（纯重构，测试保持
绿）→ S2 agent 模式 + 循环 + 数据工具（后端闭环）→ S3 SSE 帧 + webapp 接线 →
S4 前端 RunBlock（build 门禁）→ S5 refine_spec + 端到端闭环验收。

## 文档归档

- 本设计定稿落 `docs/superpowers/specs/`；roadmap.md「TreeChat 后续」节替换为本
  spec 指引 + 切分清单；完成后归档 finish.md。
- 若做 S0：`../SpecModule/docs/references/api.md` 补录 `chat()` 工具循环契约
  （库仓库独立提交）。
