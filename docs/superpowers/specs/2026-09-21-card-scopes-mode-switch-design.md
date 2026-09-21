# 卡片双层作用域（节点卡/全局卡）+ 会话内模式切换 设计

- 日期：2026-09-21
- 状态：已与用户确认（存储方案 A：统一双层；切换器 + 斜杠 + 逐轮记录 + done 自动直答；
  节点卡范围 = 模块产物文档 + 用户卡可选挂节点）
- 范围：`treechat/`（core/session/module_bridge/modules/webapp/cli）+ `web/src/chat/`；
  事件日志格式只增不改（旧文件零迁移）

## 1. 问题（用户实测反馈）

1. **会话内无法切换模式**：`category` 建会话时定死，引擎每轮虽按 `conv.category`
   现解析模块、后端也有 `POST /category`，但聊天页内无切换入口；拷问进行中想插一个
   直答问题做不到。
2. **叶子并非无上下文**：`build_spec` 对任何轮注入全部 pinned 卡 + `spec:*` 文档——
   grilling 叶子轮照样拿到最新设计树/词表，`leaf=True` 只清了对话历史。
3. **文档无版本、分支错位**：grilling 的 `spec:tree`/`spec:glossary` 是会话级固定 ID
   卡片，每轮 `edit_card` 整体覆盖。从上游 #K 开分支时读到的仍是**最新一轮**覆盖后的
   版本，不是 #K 时点的版本——「讨论到一半发现前面有缺漏，从某处重来」场景直接失效。

## 2. 方案总纲（与用户对齐的决策）

- **卡片统一双层（方案 A）**：`CardCreate` 事件增可选字段 `owner_seq`（挂哪个轮，
  None = 全局卡）与 `doc_key`（模块文档标识，用户卡为空）。一个 Card 概念、一套
  事件/注册表/API，右侧栏两个分区 = 同一列表按 `owner_seq` 的两种过滤。
- **文档版本化**：grilling 每轮产出从「固定 ID 覆盖」改为「新节点卡追加」
  （确定性 ID `doc:<key>@<seq>`）。上下文组装沿路径取最近祖先版本——分支点语义、
  叶子空文档、模式往返不丢卡，三条规则一句话说清。
- **模式 = 切换器 + 斜杠 + 逐轮记录**：Composer 模式 chip 切换（写 category 事件）；
  行首 `/` 命令面板快速切换；`UserMsg` 记录本轮实际模式，retry 永远用原轮模式；
  回合 `done=true` 自动切回直答。
- **前端右侧边栏**：chat 页主区 = 中列 + 右栏（可折叠）。右栏上半「节点卡片」
  （当前指针节点的产出 + 文档版本链），下半「全局卡片」（现 CardsPanel 全部功能）；
  左侧 ActivityBar 移除 cards 页签。

## 3. 后端设计（treechat/）

### 3.1 卡片模型与事件（core/cards.py / core/events.py / core/conversation.py）

- `CardCreate` 增字段：`owner_seq: int | None = None`、`doc_key: str = ""`。
  旧文件缺省即全局卡，重放零迁移。
  - `owner_seq=None` → **全局卡**：pin/编辑/删除/导入/提炼，语义全同现状；
  - `owner_seq=<seq>` → **节点卡**：`doc_key` 非空 = 模块文档版本；`doc_key=""` =
    用户提炼/导入时显式挂到某轮的卡（展示/追溯用，不进上下文）。
- `Card` 数据类同步增 `owner_seq`/`doc_key`；`CardRegistry` 纪律：
  节点卡 `pinned` 恒 False（pin 是全局卡专属；对节点卡 pin 为 no-op 或拒绝，实现取拒绝并报错）。
- 节点文档卡 ID 确定性：`doc:{doc_key}@{seq}`（重放幂等、UI key 稳定、与 `card_` 随机
  ID 天然不冲突）。
- `Conversation.add_card` 增 `owner_seq`/`doc_key` 参数；`edit_card`/`delete_card`
  对两种卡通用——**删除路径上的文档版本 = 下游轮次回退到上一版本**，即「从某版重来」
  的机制本身。
- `DocumentDef.card_id`（`"spec:tree"`）改名 `doc_key`（`"tree"`/`"glossary"`）；
  `node_docs` 的值同步改为 doc_key。`build_spec` 注入过滤从 `id.startswith("spec:")`
  改为按 owner 过滤（见 3.2）。

### 3.2 上下文组装（module_bridge.build_spec）

- pinned 注入：`pinned = [c for c in conv.cards.pinned_cards() if c.owner_seq is None]`
  （全局卡常驻层，所有轮含叶子照旧注入 system）。
- 文档字段解析 `resolve_doc(conv, doc_key, user_seq)`：
  1. 沿 `path_to(user_seq)[:-1]` **从最近祖先向根**找第一个 `owner_seq` 节点且
     `doc_key` 匹配的节点卡，取其 body；
  2. 路径上无 → 回退读旧全局 `spec:{doc_key}` 卡（旧 grilling 会话无缝继续）；
  3. 仍无 → 空串。
- 三条推论（设计保证，测试钉死）：
  - **分支** = 从 #K 开新轮 → 拿 #K 时点版本（不再读最新覆盖）；
  - **叶子** = 路径为空 → 无文档（新会话真·无上下文；grilling 叶子从空树开始，
    产出的新树只挂叶子上，不污染其他分支）；
  - **模式往返不丢卡**：g1(grill)→d2→d3→g4，g4 沿路径拿到 g1 的版本。

### 3.3 会话门面（session.py）

- `UserMsg` 事件增可选 `module: str = ""`（本轮实际使用的模式 key；缺省空 = complete
  时按会话 category 解析——旧轮天然兼容）。`MsgNode` 增 `module` 字段随动。
- `send(text, *, leaf=False, module: str = "")`：落盘时记录；`complete_outcome` 的模块
  解析改为 `node.module or conv.category or "direct"` 经 `resolve_module`。
- **retry 语义**：`turn_retry` → `complete` 读轮上记录的模式——中途切换不影响旧轮重试。
- **文档落盘**：`outcome.documents` 载荷从 `(card_id, title, body)` 改为
  `(doc_key, title, body)`；session 逐项写节点卡
  （`add_card(..., owner_seq=user_seq, doc_key=key, card_id=f"doc:{key}@{user_seq}")`），
  不再 `edit_card` 覆盖。
- **done 自动直答**：`outcome.done=True` 且当前 category 非空 → 追加
  `session_category("")` 事件（空 = 直答）。任何模块的 done 都触发（通用规则）。

### 3.4 WebUI 服务（webapp/app.py）

- `_state`：cards 增 `ownerSeq: number|null`、`docKey: string`；nodes 增
  `module: string`。全量状态纪律不变。
- `TurnBody` 增 `module: str = ""`（空 = 会话 category）；`_turn_stream` 传给 `send`。
- `CardBody` 增 `ownerSeq: int | None = None`（提炼时挂节点）；`CardImportBody` 同。
- 无新端点；`POST /category` 已存在直接复用。
- node_end 的 refs 载荷从 `{type:"card", cardId}` 改为
  `{type:"doc", docKey, title}`（无外部消费者，直接改）。

### 3.5 CLI 最小适配（cli/）

- 卡片列表区分两种（节点卡标注归属轮 + doc_key）；`/card` 仍默认提炼全局卡；
  `/retry` 受益于轮上模式记录，无需改。斜杠切模式不做（Web 专属体验）。

## 4. 前端设计（web/src/chat/）

### 4.1 布局：chat 页三段式

- 主区 = 中列（header + ChatView + Composer）+ **右侧边栏**（宽 ~320，可折叠，
  开合状态入 ChatUi 按会话记忆）。
- ActivityBar `Tab` 类型移除 `"cards"`；tree 页签保留（选点驱动节点区 +
  选入卡片范围）；生成卡片对话框迁入右栏。

### 4.2 右侧边栏（新组件 CardsSidebar）

- **节点卡片**区（上半）：当前指针节点的产出 = `ownerSeq === pointer` 的卡。
  - 模块文档版本卡（设计树/词表）+ 用户挂节点卡；展开正文、编辑、删除、
    **升为全局**（复制为全局 pinned 卡——跨分支传递入口）、导出。
  - 文档卡附**版本链**展开：沿活跃路径列该 doc_key 的各版本（`#3` `#7` …），
    点击跳转该轮（配合「从上游重来」：分支到旧节点后其版本即生效）。
  - 指针无产出 → 空态「该轮无产出卡片」。
- **全局卡片**区（下半）：现 CardsPanel 功能整体迁入（pin/编辑/删除/导入/
  跨会话卡库/生成卡片）；旧全局 `spec:*` 卡保留可见，带「旧版文档」徽标
  （回退读取仍有效，节点版本出现后即以其为准；旧卡可手动删）。

### 4.3 模式切换 UI

- Composer 左侧模式 chip：显示当前模式（category），下拉列 `GET /api/modes`
  清单，选择即 `setCategory`。
- **斜杠命令**：输入行首 `/` 弹命令面板，按 key/显示名前缀过滤（`/g` → 拷问）。
  - 仅命令 token + 回车 = 只切换（清空输入）；
  - token + 空格 + 文本 = 切换并把余文作为该轮消息发出（send 带 `module`）；
  - 未知命令：提示条提示，**不阻断发送原文**（小决策，已与用户对齐）。
- 消息元信息：`MessageMeta` 显示该轮 `module` 徽章（grilling 会话里的直答插轮可见）；
  全局卡 fromPath 来源片照旧。
- RunBlock 文档 ref 片改为「{title} → 已挂到 #seq」，点击打开右栏并定位节点区。

## 5. 测试

- core：`CardCreate` 新字段 roundtrip、旧格式重放（缺省 = 全局卡）、节点卡 pin 拒绝、
  确定性 ID。
- build_spec/resolve_doc：分支取 #K 版本、叶子空、g→d→d→g 不丢卡、legacy `spec:*`
  回退、节点版本出现后胜过 legacy。
- session：`UserMsg.module` 记录与 complete 解析、retry 用原轮模式、done 自动
  `session_category("")`、documents → 节点卡落盘（确定性 ID、空 body 跳过）。
- webapp：`_state` 新载荷形状、turn 带 `module`、cards create 带 `ownerSeq`。
- 前端无测试设施，验收门 = `npm run build`（tsc --noEmit + vite build）+ 手动走查
  （切模式/斜杠/分支取版本/右栏两分区）。

## 6. 已知取舍

- `_state` 全量载荷随节点卡逐轮增长（百轮 grilling ≈ 两百张文档卡条目）——会话规模
  小可接受，超限再增量。
- 模式为会话级事件（最后写入胜），分支跳转不回滚模式——模式是「下一轮用什么的
  用户意图」，与文档的树位置语义正交；轮上记录已保证 retry 不变味。
- CLI 不做斜杠切模式；提炼卡挂节点的入口 v1 仅 Web（CLI `/card` 保持全局）。
