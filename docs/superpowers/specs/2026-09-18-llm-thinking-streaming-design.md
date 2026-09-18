# LLM 思考通道全链路真流式设计

日期：2026-09-18
状态：已确认（用户逐项决策）

## 背景与证据

- 用户报告 run 视图 NodePanel「最新输出（实时）」不是流式。实测今日 run `academic_writer_4799c7`：三次 LLM 调用（Organize/Polish/Finalize）总时长 5.3s/9.3s/5.3s，**首 token 滞后 5.0s/9.2s/4.9s，全部 token 到达窗口仅 0.23s/0.10s/0.45s**——思考期（占调用 95% 时间）全程静默，正文零点几秒砸完，加 server 1s 批推，肉眼即「憋半天一次性出现」。
- 根因在上游 `llm/client.py`：`OpenAIClient._stream` 只转发 `delta.content`，`reasoning_content`/`reasoning`（DeepSeek 方言，配置 `think: true`）被静默丢弃；`AnthropicClient._stream` 用 `stream.text_stream` 同样丢 `thinking_delta`。全文件无一处处理 reasoning。
- **webview 两条消费链路本身已是流式管道**：stream.log 逐记录 flush（`infra/stream.py:56`）→ server WS 逐秒追尾批推（records 泛化透传）；treechat 回合经 harness EventBus `LlmToken` → SSE `token` 帧逐帧下发。瓶颈单点在上游通道缺失。
- 对照组：`ppt_master_41c912` 长输出调用有 5.1s 渐进 token 窗口——正文通道对长文本正常工作。

## 参考项目调查结论

**nanobot**（正面参照）：`chat_stream(on_content_delta, on_thinking_delta, on_tool_call_delta)` 三通道平行回调（`providers/base.py:1297`）；reasoning 是带生命周期的独立事件流（`reasoning_delta`/`reasoning_end` 成对 + `stream_id`，渠道按 `show_reasoning` 能力 opt-in）；WebUI 思考行低强调渲染、正文到达自动收口（`ReasoningRow.tsx`），rAF 合帧防逐 token 重渲；方言覆盖 `delta.reasoning_content`/`delta.reasoning`/Mistral content 数组内嵌 think 块；正文通道内联 `<think>` 增量剥离（跨 chunk 安全游标提取）。

**OpenHarness**（反面参照 + 手法来源）：事件协议无 thinking 通道——Anthropic `thinking_delta` 被过滤、OpenAI `reasoning_content` 累积后挂猴子补丁属性不外发，UI 只有 "Thinking..." spinner——正是本系统现状。可取手法：跨 chunk `<think>` 剥离缓冲（`openai_client.py:461`）、前端 delta 合帧（50ms/384 字符阈值）。

两项目流式**传输**均为裸协议（WS/SSE/stdio JSON-lines），现成库仅用于终端渲染（Rich Live / textual）；Web 前端均为手写 React + 自定义协议。webview 已有对应物（SSE/WS + React），无需引库。

## 用户决策（设计输入）

1. 思考期展示形态 → **思考块流式 + 正文到达自动收起**（nanobot WebUI 风格；否决仅 spinner、否决两处不同策略）。
2. provider 覆盖面 → **双客户端 + 方言全覆盖**（OpenAI 兼容 `reasoning_content`/`reasoning` + 内联 `<think>` 剥离；Anthropic `thinking_delta`）；tool_call 增量流 / TTFT 统计按 YAGNI 排除。
3. 接口形状 → **方案 A：双回调通道**（`complete(..., on_token, on_thinking)` 平行对称；否决单通道加元数据 B——破坏所有现有 `on_token` 消费端签名，零功能收益）。
4. run 视图推送节奏 → **1s 收紧到 0.2s**。
5. treechat CLI REPL 本期不做（接口留好随时可加）。

## 目标与非目标

**目标**

1. LLM 思考增量从 provider 到 UI 全链路可见：思考期流式生长，不再静默。
2. run 视图 NodePanel 与 treechat ChatView 两消费端渲染思考块（低强调、自动收口）。
3. 内联 `<think>` 剥离保护 content 通道（顺带修思考文本泄入 JSON 输出的隐患）。
4. run 视图 WS 推送 0.2s。

**非目标**

- 请求侧 think 参数映射（reasoning_effort 现状保留——现配置已能拿到 reasoning_content）。
- `chat()` 多轮底层接口加 thinking（无消费端）。
- tool_call 增量流、TTFT 统计、treechat CLI 流式渲染。
- provider 自身突发（短正文 0.2s 砸完）——上游物理事实，不在修复范围。

## 设计

### 1. 库接口（SpecModule 仓库 `llm/client.py`）

`complete()` 增加可选 `on_thinking: Callable[[str], None] | None`，与 `on_token` 对称。流式开关改为「任一回调提供即走 `_stream`」；只传 `on_token` 的旧调用行为完全不变（thinking 增量照旧静默丢弃，向后兼容）。

- **OpenAIClient._stream**：每 delta 先 `getattr(delta, "reasoning_content", None)` 再 `getattr(delta, "reasoning", None)` → `on_thinking`（新 `_safe_on_thinking` 包装，回调异常不破主流程，镜像 `_safe_on_token`）。content 通道加跨 chunk 安全的内联 `<think>` 剥离缓冲（hold-back 未闭合 tag：think 内增量转投 `on_thinking`，think 外增量照走 `on_token`；tag 自身被 chunk 劈开也能处理）。
- **AnthropicClient._stream**：`stream.text_stream` 改为遍历原始事件——`content_block_delta` 且 `delta.type == "thinking_delta"` → `on_thinking`；`text_delta` → `on_token`；`get_final_message()` 聚合不变。
- **RoutingClient.complete** 透传 `on_thinking`。

### 2. harness 事件 + stream.log 契约（SpecModule 仓库）

- `infra/events.py`：新事件 `LlmThinking`（镜像 `LlmToken`：node/tick/chunk）。
- `core/harness.py`：`on_thinking` 闭包 → `bus.emit(LlmThinking(...))`，传入 `complete(on_thinking=...)`。
- `model/module.py` `_on_stream_event`：`LlmThinking` → `w.write({"type": "thinking", "node": ..., "chunk": ...})`。
- `infra/stream.py` 记录格式表补一行 `{"type": "thinking", "ts", "node", "chunk"}`。
- `query.read_stream` 泛化读零改动；server WS records 透传已泛化（只剥 `off` 键）——thinking 记录**零服务端代码**自动流转；老消费端不识别新记录自然忽略（append-only、向后兼容）。

### 3. server WS（本仓库）

`server/ws.py` `_POLL_SECONDS` 1.0 → 0.2（纯增量文件短读，开销可忽略）；status 签名推送节奏不变。

### 4. 前端 run 视图（本仓库）

- `web/src/ws.ts`：`StreamBuffer` 加 `thinking: Record<string, string>` 平行缓冲；`r.type === "thinking" && r.node` → 累积；`run_start` 同时清两缓冲。
- `RunView.tsx`：`liveThinking` 与 `liveText` 同 gating（phase === "running" 且流缓冲属当前 run）。
- `NodePanel.tsx`：正文块上方渲染思考块——置灰斜体流式生长，正文首 token 到达自动收起为「已思考 N 字」单行（点击可展开）。

### 5. treechat（本仓库）

- `module_bridge.run_turn`：订阅 `LlmThinking` → `on_event({"event": "thinking", "key": e.node, "text": e.chunk})`；**不经 FieldStreamShaper**（思考是原始文本非 JSON 字段，直接透传）。
- `webapp/app.py` SSE 转发泛化（`evt.pop("event")`），零改动；帧序扩展为 `start → (node_start | thinking | token | node_end)* → done | error`。
- `ChatView.tsx` RunBlock：每节点思考行（低强调、斜体、muted），正文 token 到达自动收口。SSE 逐 token 到达频率高，**加 rAF 合帧**（OpenHarness 50ms 阈值同款）防高频重渲染。

### 6. 测试

**SpecModule 仓库**：

- OpenAI 兼容客户端假 stream 分方言：`reasoning_content`、`reasoning`、内联 `<think>` 跨 chunk 劈开（tag 被切断场景）→ on_thinking/on_token 分派正确、content 干净。
- Anthropic 客户端：`thinking_delta` 事件 → on_thinking。
- harness：LlmThinking 事件发射 + stream.log thinking 记录落盘（fake client 带 on_thinking）。
- 向后兼容：仅 on_token 调用行为不变（thinking 丢弃、仍走流式）。
- 基线：`uv run pytest ../SpecModule/module_harness/tests/ -q -m "not smoke"`。

**本仓库**：

- server：fixture stream.log 带 thinking 行 → WS 推送含 thinking 记录（现有 endpoint 测试模式）。
- treechat：run_turn 假客户端发 thinking → SSE thinking 帧；shaper 不吃 thinking。
- web：`npm run build`（tsc 门禁）。

### 7. 提交切分

- **SpecModule 仓库**（遵守其 AGENTS.md）：① `feat:` 客户端 thinking 通道 + harness 事件/流记录 + 测试；② `docs:` api.md 补录（on_thinking 参数、LlmThinking 事件、stream.log 记录格式）。
- **本仓库**：① `feat(web):` WS 0.2s + thinking 缓冲/NodePanel 渲染；② `feat(treechat):` thinking SSE 帧 + RunBlock 渲染 + 测试；③ `docs:` roadmap.md 变更日志。
- 依赖经 `[tool.uv.sources]` editable 锚 ../SpecModule 直接生效，无需发版。

## 风险与边界

- stream.log 因 thinking 记录变大（思考文本可达正文数倍）——append-only 观测通道可接受；`stream_log=False` 可关。
- resume 重放按 run_start 锚定清缓冲，已有机制覆盖 thinking 记录。
- thinking 帧使 SSE/WS 载荷变大——逐帧量级不变（chunk 粒度），仅帧数增多。
- Vite dev 代理对 WS/SSE 无缓冲干扰（现状已验证可用）。
