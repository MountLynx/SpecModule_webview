# chat 轮次节点合并 + 树图导航化 UX 设计

- 日期：2026-09-20
- 状态：已与用户确认（方案 B：点击=指针挪到该节点；操作条移到每轮末尾；轮次合并）
- 范围：`treechat/` 后端（核心视图 + webapp + CLI）+ `web/src/chat/` 前端 + `web/src/chat/treelayout.ts`；事件日志格式零改动

## 1. 问题（用户实测反馈）

1. **叶子与分支重合**：无上下文叶子链起点取「最低空闲 lane」，紧贴主干 lane（间距 22px），
   主干连线擦行而过，视觉上像从主干分出的枝。
2. **输入/输出各占一个节点**：一次问答两个点，树图无谓翻倍；且 assistant 节点单独存在
   没有独立语义（分支、命名、提炼都以「轮」为单位）。
3. **树点选与对话流脱节**：底部详情卡与主区内容重复；点选不跳转对应分支；分支/卡片
   操作藏在详情卡里，主区对话反而没有操作入口。

## 2. 方案总纲（与用户对齐的决策）

- **轮次合并（后端派生视图层）**：事件日志保持 `user_msg`/`assistant_msg` 追加不动
  （防丢/重试语义不变）；重放派生改为**一轮一节点**——`assistant_msg` 回填父节点
  output 并把指针推进到该轮。旧会话文件重放自动合并，**零迁移**。
- **点击 = 指针挪到该节点（方案 B）**：`set_pointer` 纯内存不落盘；点击树上节点 →
  主区渲染该节点所在完整分支（`path_to`）→ 滚动并高亮到它。单一规则，无「在不在
  当前流」双逻辑——被点击的节点必然在视图内。
- **详情卡删除**：正文与主区重复；命名/选入卡片范围/从此分支三个操作移到主区
  **每轮对话组末尾**（悬停浮现操作条），命名对话框随迁 ChatView。
- **Composer 提示真实化**：删 `branchParent` 暂存态；指针 ≠ 主干末端时常显
  「从 #N 分支」（所见即分支点）；`leafMode` 保留。

## 3. 后端设计（treechat/）

### 3.1 轮次节点（core/conversation.py）

- `MsgNode` → `{seq, parent, input: str, output: str | None, model: str, label: str}`；
  `role` 退役（每个节点就是一轮问答）。
- `_apply`：`UserMsg(parent, text)` → 建 input 节点；`AssistantMsg(parent, text, model)`
  → 校验 parent 是轮次节点后回填 `output/model`，`pointer = parent`（推进到轮而非新节点）。
  同轮二次 `assistant_msg` 按「最后事件胜」覆盖（retry 天然成立）。
- **旧文件兼容**：重放语义即合并——旧格式的 assistant 节点在重放时回填其父轮，
  无需迁移。重放期记录 `legacy: {旧assistant_seq → 轮seq}`，供卡片 fromPath 归一化。
- 派生量随动：
  - `unanswered()` → 无 output 的最新轮（原 `unanswered_user` 改名，语义等价）；
  - `append_assistant` 保持原名（命名的仍是「追加 assistant 事件」这一存储动作），
    参数 user_seq 即目标轮 seq；
  - `path_to` / `trunk` / `fork_point`：role 逻辑退役，fork_point 恒为轮次节点，
    `branch_segment` 含 fork_point 自身（与原 user-fork 行为一致）；
  - `complete` 守卫：目标轮必须存在且 output 为空（防覆盖已答轮）。

### 3.2 上下文组装（core/context.py)

- 路径 → messages：中间轮 = `[{user, input}, {assistant, output}]`（output 为空跳过）；
  末轮只贡献 input 作为 current。`_merge_consecutive` 保留兜底。

### 3.3 会话门面与序列化（session.py / webapp/app.py）

- `session.py`：`complete` 校验改轮次语义；`branch_segment` 去 role 分支；
  `make_card` 转写 `[user]/[assistant]` 由轮的 input/output 生成；`node_count` 计
  `UserMsg` 事件数（轮数）。
- `_state`：nodes 序列化 `{seq, parent, input, output, model, label}`；
  `unansweredUser` → `unanswered`；卡片 `fromPath` 经 legacy 映射归一化后输出。
- **新端点** `POST /api/sessions/{sid}/pointer`：body `{seq: int | null}` →
  `set_pointer` → 全量状态（导航落点；纯内存，不落事件）。

### 3.4 CLI（cli/）

- 树视图一行一轮：`#seq [label] input → output 摘要`；REPL 的 send/retry/branch
  命令语义不变（目标均为轮 seq）。

## 4. 前端设计（web/src/chat/）

### 4.1 类型与数据（types.ts / api.ts）

- `Node` → `{seq, parent, input, output, model, label}`；`ConvState.unanswered`；
  `api.ts` 增 `setPointer(sid, seq)`。

### 4.2 ChatView（主区对话流）

- 每轮渲染为**对话组**：用户气泡（右）+ 助手 Markdown（左）；`output === null` 时
  只渲染用户气泡（流式/错误仍由 RunBlock / 错误条承担，位置在流之后不变）。
- **轮末操作条**（组尾悬停浮现）：命名 / 选入卡片范围（toggle，高亮已选）/ 从此分支
  （= 导航到该轮 + 聚焦输入框）。命名对话框从 TreePanel 迁入。
- 滚动两路：路径尾部变化（新消息）→ 贴底；`focusSeq`（树导航/从此分支）→
  滚到该轮 + 闪烁高亮（1.5s 后清除）。

### 4.3 TreePanel（侧栏树图）

- 删除：底部详情卡、命名对话框、`selectedSeq` 选中态。
- 行点击 = `onNavigate(seq)`：POST pointer → 更新会话状态 → `focusSeq` 聚焦；
  指针行即高亮行（指针环样式保留）。
- 保留：图例（指针/主干末端/叶子根）、卡片范围汇总条 + 生成卡片（多选改由聊天气泡
  操作条承担）、叶子根虚线圈。
- 标签摘要改为 `input`（无 output 时加「待答」标记）。

### 4.4 Composer

- 删 `branchParent`；提示条改为读会话状态：`pointer !== trunkEnd` 时显示
  「从 #pointer 分支」（不可关闭——它是事实陈述）；`leafMode` 交互保留。

### 4.5 树布局（treelayout.ts）

- **叶子 lane 缓冲**：根链（parent === null，非首节点）取「最低空闲且前一 lane 也
  空闲」的 lane（无则退回最低空闲），与既有链条强制隔一 lane，消除贴干错觉。
- `LANE_W` 22 → 26。

## 5. 兼容性与影响面

- 事件日志格式不变 → 旧会话、CLI、webapp 全部平滑；`#seq` 展示值变为轮 seq
  （旧 assistant seq 不再展示，卡片徽标经归一化仍落在正确轮行）。
- tests/treechat 133 例大面积机械更新（role 断言 → input/output 断言、unanswered
  改名、pointer 端点新增用例）；webview 侧 server 测试不受影响（chat 仅挂载冒烟）。
- `roadmap.md` 变更日志补记。

## 6. 非目标

- 不改事件存储格式、不做迁移工具；不动 SSE 帧结构（`start.userSeq` 语义=轮 seq）；
  不做「重新回答已答轮」；卡片提炼范围选点仍单粒度（轮）。
