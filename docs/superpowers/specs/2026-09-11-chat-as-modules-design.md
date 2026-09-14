# Chat as Modules：用 module 拼出 chat（TreeChat 整合三期设计）

> 2026-09-11 定稿。本文档是一次 grilling 定位拷问的产出（Q1–Q21 全前沿收敛）。
> 用户指令核心：module 的定位是取代 skill 成为 LLM 的执行层——
> **「不是在 chat 里用 module，而是用 module 拼出一个 chat。」**

## 定位声明（跨仓库哲学）

- **specmodule 是 agent harness 框架**：能力主要由 harness 结构（图 / 守卫 / 预算 / tick 审计）
  提供，LLM 是图里的组件，不是自由裁量主体。
- **取代语义**：skill 中的「流程约束与提示词」类 → module 化（grilling / domain-modeling /
  brainstorm 等流程可预期的能力是典型）；知识信息型 skill 不在取代范围。
- **agent loop 的位置**：不被禁止，但降级为**图级守卫循环**——探索轮预算 = `max_ticks`、
  收尾 = guard、工具 = script/command 节点，每个 firing 落审计（`fact_review_loop` 即同构
  参照）。DeepTutor 的循环工程经验（预算、settlement、工具面收敛）按此转译。
  节点内工具循环（LLM 自选下一工具的「agent 节点」原语）是库远期可选项，仅当图级
  守卫循环确实覆盖不了时立项。
- **两类 run 的分界**（执行进程 + 审计宿主两条线）：

| | 对话型 module（嵌入式） | 业务型 module |
|---|---|---|
| 执行 | treechat 服务进程内 `Module.run()` | webview 编排层 spawn 官方 CLI 子进程 |
| 时长 | 秒级（2–3 个节点） | 分钟级以上 |
| 产物 | ephemeral，审计宿主 = 会话树 | `.specmodule/runs/`，RunList / RunView / WS 监控 |
| 分发 | 随 treechat 包内嵌 | 用户的 module store |

## 形态：一次对话 = 一次 module run

- **每回合就是一次完整的 module run**：接收 spec → 处理 → 产出；第二次对话 = 新 run。
  现有 `llm_bridge.chat_turn`（单次 completion 拼 messages）的路径由 module 执行取代，
  `create_client`（SpecModule 配置回退链）保留复用。
- **模式 = 对话型 module**：创建会话时选模式，模式即所选的对话型 module。会话级承载，
  复用 treechat 现有 `category` 字段（装饰标签升级为功能字段；旧值回落直答）。
  模式↔module 映射走 treechat 配置（内置默认三模式），webview SettingsPanel 只读展示。
- **输入即 spec**：用户输入一字不改进 `brief`；对话历史由 bridge 组装进 `history`
  （接管现 `TokenWindowStrategy` 的裁剪预算职责）；模块按自身 spec_schema 声明额外字段
  （如工作文档）。约定 `input={"brief": "str"}` 为对话型 module 的公共形状——库侧
  `SpecSchema.validate` 现状零改动即可支撑（只强校验声明字段）。
- **spec 文档 = 共同维护的卡片**：不是累积上下文（重复语义膨胀，且用户可能改掉旧需求），
  而是一张持续演进的 pinned 卡片。服务层解析 run 结构化输出自动刷新
  （`{document_md, questions, status}`）；编辑双通道：清单类在卡片里直填、
  改动类在对话框写并引用卡片。卡片 pinned 机制照旧自动进上下文。

## v1 对话型 module（三个，零外部工具依赖，key-free 可测）

| module | 移植自 | 图结构 | spec | 输出 | 工作文档 |
|---|---|---|---|---|---|
| 直答 | — | 单 harness 节点（退化形态） | `{brief, history}` | 回复文本 | 无 |
| grilling | `skill_by_me/.../productivity/grilling` | TreeUpdate → FrontierFormat | `{brief, tree_md, answers}` | `{tree_md, questions_md, done}` | 设计树卡片 |
| domain-modeling | `skill_by_me/.../engineering/domain-modeling` | TermChallenge → ScenarioStress → Resolution | `{brief, context_md, code_material}` | `{context_diff, questions, adr_candidates}` | CONTEXT.md 词表草稿卡片 |

- **grilling**：一轮 run = 一轮拷问——「树更新 → 前沿计算 → 问题清单」，`done` 时输出
  决策汇总。设计树就是那张共同维护的卡片，逐轮回答即逐轮 run。
- **domain-modeling**：一轮 run = 一次术语/关系拷问——对照词表找冲突、构造边界场景、
  裁决或追问；ADR 走三条件门（难逆转 / 无上下文会费解 / 真实权衡）。v1 代码材料作为
  spec 输入贴入，按路径读代码的 script 节点留 v1.1。
- v1.1 及以后：检索/工具 script 节点（问答模式的图级守卫循环）、spec-builder
  （设计树 → 业务 module 的参考 spec + 推荐 module 组合）、brainstorm 变体。

## 执行机制（TreeChat 仓库侧）

- **in-process `Module.run()`**：对话型模块节点少、秒级完成，不 spawn 子进程——
  spawn 开销对聊天延迟不可接受，业务 run 的 subprocess 编排语义也不适用于回合级调用。
- **bridge 收敛**：`module_bridge` 与 `llm_bridge` 并列，treechat 只经 bridge 摸
  module_harness（组装 spec、订阅事件、取回结构化输出）——为了对话模块可测试
  （bridge 可 mock），不是为了抽象。treechat 直接依赖 module_harness（兄弟库同作者，
  llm/config 依赖已存在一半，不做注入式间接层）。
- **ephemeral 默认**：对话型 run 不落 run 目录、不进 RunList、无运行视图——审计宿主
  就是会话树（JSONL 事件日志），这是「嵌入式」的题中之义。库 `persist/audit=False`
  的确切语义实施期核对；调试走 bridge 日志。
- **流式 v1 就上**：每回合从单次调用变成 2–3 个串行 LLM 节点，黑盒等待不可接受。
  库 `complete(on_token=...)` / `LlmToken` / 节点边界事件面已存在（stream.log 同源），
  bridge 订阅 → SSE 传输层（REST 非流式退役）→ 前端逐 token 渲染 + 节点级进度
  （「审阅中…」）。纯 spinner 不接受。
- **嵌入式分发**：三个对话型 module 随 treechat 包内嵌（packed 形态），bridge 包内
  直载，不依赖用户环境 module store；webview 模块库以 pip kind 顺带可见（展示价值）。

## 本仓库（SpecModule_webview）侧

- `server/chat.py` 挂载契约不变（`client_factory` 锚 `project_root=base_dir`、
  数据目录 `<base_dir>/.treechat`）；vite proxy 增 SSE 通道。
- 前端：会话创建选模式（category）、模式徽章（直答灰 / module 绿）、卡片直填与
  引用双通道、逐 token 渲染。
- **业务 run 联动**（三期本义，机制不变）：从 chat 的 spec 卡片一键发起业务 run
  （`POST /api/runs` 子进程编排 + run 页签跟踪卡片接现有 WS 流）。发起权在 webview
  编排层，treechat 保持纯对话层——避免同一 run 出现两个互不知情的 spawn 方。
- **自动路由种子（v2，非本期）**：spec-builder 按需拉取 module 目录
  （`store.list_modules` 锚 base_dir）产出推荐组合——自动路由不是新机制，只是把
  「用户选模式」换成「信 spec-builder 推荐」，同一机制两档自动化。

## 落地路径

1. **TreeChat 仓库先行**（`C:\Users\xingy\Desktop\开发\TreeChat`，遵守其 AGENTS.md）：
   module_bridge、SSE 传输层、三个嵌入式对话型 module、category 模式化、配置化映射。
2. **本仓库迁移集成**：挂载升级回归、前端模式入口与流式渲染、卡片双通道、
   业务 run 联动（三期收口）。
3. 库依赖（见下节）先行或并行，库仓库独立提交 + api.md 补录（统一 API 原则）。

## 库依赖清单（SpecModule 仓库）

1. `brief` 输入约定文档化——「输入即 spec」的模块声明惯例（引擎零改动，补文档 + example）。
2. scaffold 对话型模块模板——单 harness 节点（直答形）+ 多轮文档型（grilling 形）骨架。
3. `persist=False / audit=False` 运行语义确认与文档化（ephemeral run 的确切边界）。
4. on_token / EventBus 事件面补录 api.md（`LlmToken`、节点边界事件——bridge 订阅契约）。
5. （远期可选）agent 节点原语——节点内工具循环（工具注册表 + 节点级预算），
   图级守卫循环覆盖不了时再立项。

## 测试与验收

- treechat：bridge 单测（mock module）；三个对话型 module 的 mock LLM 轮次
  （直答单节点 / grilling 多轮 done 收敛 / domain-modeling 词表 diff）；SSE 事件序列
  （token → 节点进度 → 终态结构化输出）。
- webview：挂载回归（现 7 例不破）、模式创建会话、业务 run 联动走查（spec 卡片 →
  发起 → run 页签跟踪）。
- 全程 key-free（mock LLM），真 LLM 冒烟单独走。

## 明确不做（本期）

- 问答模式 / 检索与外部工具节点 / brainstorm 变体（v1.1）；DeepTutor 只是形式参照
  （模式化、流程化、流式事件面），非严格参考。
- 自动路由（v2）、spec-builder、业务 spec 一键转化后的自动发起。
- 节点内工具循环（agent 节点原语）、运行时动态改图。
- 对话型 run 的运行视图 / RunList 集成（ephemeral 是设计而非缺陷）。
- 模式映射编辑器（SettingsPanel 只读展示）。
