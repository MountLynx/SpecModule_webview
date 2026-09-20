# chat 轮次节点合并 + 树图导航化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一次问答合并为一个树节点（事件日志零改动、旧文件零迁移），树点选变为纯导航（点击=指针挪到该节点+主区跳转高亮），节点操作条移到每轮对话末尾，修复叶子链与主干贴行的布局错觉。

**Architecture:** 改 treechat 重放派生视图（`assistant_msg` 回填父轮 output，指针推进到轮），序列化/CLI/测试随动；新增 `POST /api/sessions/{sid}/pointer` 内存导航端点；前端 `Node` 类型改 `{seq,parent,input,output,model,label}`，ChatView 渲染轮组+轮末操作条+聚焦滚动，TreePanel 删详情卡改导航，Composer 提示直读 `pointer !== trunkEnd`，treelayout 根链 lane 缓冲。

**Tech Stack:** Python 3.10+ / FastAPI / pytest+httpx（uv）；Vite+React+TS+Tailwind（无新增依赖）。

**Spec:** `docs/superpowers/specs/2026-09-20-chat-turn-node-ux-design.md`

---

### Task 1: 后端核心 —— conversation.py 轮次视图

**Files:**
- Modify: `treechat/core/conversation.py`
- Test: `tests/treechat/test_conversation.py`

- [ ] **Step 1: 改 MsgNode 与 _apply（先改测试再实现亦可，此处核心语义一次到位）**

```python
@dataclass
class MsgNode:
    """轮次节点（一问一答）。id = seq（user_msg 事件行号）；output=None = 悬而未答。"""

    seq: int
    parent: int | None
    input: str
    output: str | None = None
    model: str = ""
    label: str = ""
```

`__init__` 增 `self.legacy: dict[int, int] = {}`（旧格式 assistant 事件 seq → 轮 seq，卡片 fromPath 归一化用）。

`_apply` 分支改为：

```python
case UserMsg():
    self._add_node(seq, ev.parent, ev.text)
case AssistantMsg():
    self._fill_assistant(seq, ev.parent, ev.text, model=ev.model)
```

`_add_node` / `_fill_assistant`：

```python
def _add_node(self, seq: int, parent: int | None, text: str) -> None:
    if parent is not None and parent not in self.nodes:
        raise TreeChatError(f"parent 指向不存在的节点: seq={seq} parent={parent}")
    self.nodes[seq] = MsgNode(seq=seq, parent=parent, input=text)
    self.children.setdefault(parent, []).append(seq)

def _fill_assistant(self, event_seq: int, parent: int, text: str, *, model: str) -> None:
    """assistant_msg 回填父轮（不新建节点）；重放同一性 = 最后事件胜。"""
    node = self.nodes.get(parent)
    if node is None:
        raise TreeChatError(f"assistant_msg 目标轮不存在: seq={event_seq} parent={parent}")
    self.legacy[event_seq] = parent  # 旧格式 assistant seq 归一化锚点
    node.output = text
    node.model = model
    self.pointer = parent
```

`append_user` 不变（docstring 微调）。`append_assistant(user_seq, text, *, model="", usage=None)`：
校验改 `if user_seq not in self.nodes: raise TreeChatError(f"append_assistant 目标轮不存在: {user_seq}")`；
**返回 user_seq**（轮 seq；事件行号只进 legacy，不外泄）。

`unanswered_user` → 改名 `unanswered`，语义 = 无 output 的最新轮：

```python
def unanswered(self) -> int | None:
    """最新的悬而未答轮（无 output）；/retry 的目标。无则 None。"""
    best: int | None = None
    for s, n in self.nodes.items():
        if n.output is None and (best is None or s > best):
            best = s
    return best
```

模块 docstring 的指针不变量描述同步改为「指向最新完成轮次」。

- [ ] **Step 2: 更新 tests/treechat/test_conversation.py**

变换规则：`conv.nodes[x].text` → `.input`；assistant 断言从「新建节点」改为「回填父轮」：
`a = conv.append_assistant(u, "a")` 后 `a == u`、`conv.nodes[u].output == "a"`、
`conv.pointer == u`；`role` 断言删除；`unanswered_user()` → `unanswered()`。
新增用例：
- `test_assistant_fills_parent_turn_and_pointer`：pointer == user seq、output/model 回填；
- `test_legacy_assistant_seq_recorded`：`conv.legacy[a_event_seq] == u`（用 store.append 旁路或
  `conv.append_assistant` 后检查 `set(conv.legacy.values()) == {u}` 且 legacy 非空）；
- `test_replay_old_format_merges`：手工写三行事件（meta/user/assistant，旧格式语义=新格式事件，
  本就同构）重放后 nodes 只有 user 轮、output 已填；
- `test_unanswered_latest_without_output`。

- [ ] **Step 3: 跑测** `uv run pytest tests/treechat/test_conversation.py -q` → 全绿
- [ ] **Step 4: Commit** `feat(treechat): 轮次节点合并——assistant_msg 回填父轮，指针推进到轮`

### Task 2: context.py 轮次组装

**Files:** Modify `treechat/core/context.py`；Test `tests/treechat/test_context.py`

- [ ] **Step 1:** `assemble`（现 87 行附近）守卫与 history 改：

```python
if not path or path[-1].output is not None:
    raise TreeChatError("上下文组装目标必须是未答轮次")
history = []
for n in path[:-1]:
    history.append({"role": "user", "content": n.input})
    if n.output is not None:
        history.append({"role": "assistant", "content": n.output})
```

（`_merge_consecutive`、窗口策略不动。）
- [ ] **Step 2:** test_context 变换：fixture 节点构造改 `MsgNode(seq, parent, input=..., output=...)`；
  role 断言 → user/assistant message 序列断言。
- [ ] **Step 3:** `uv run pytest tests/treechat/test_context.py -q` → 绿；Commit `feat(treechat): 上下文组装按轮展开 input/output`

### Task 3: session.py 门面

**Files:** Modify `treechat/session.py`；Test `tests/treechat/test_session.py` `tests/treechat/test_cards.py`

- [ ] **Step 1:** `complete`/`complete_outcome` 守卫：
  `if user_seq not in conv.nodes or conv.nodes[user_seq].output is not None: raise TreeChatError(f"complete 目标必须是未答轮次: {user_seq}")`
- [ ] **Step 2:** `branch_segment` 去 role 分支：fork_point 恒为轮次节点，`segment = path[idx:]`（含 fork_point）。
- [ ] **Step 3:** `make_card` 转写：
  ```python
  lines.append(f"[user] {n.input}")
  if n.output is not None:
      lines.append(f"[assistant] {n.output}")
  ```
- [ ] **Step 4:** `read_session_summary`：`case UserMsg(): node_count += 1`（AssistantMsg 不再计数）。
  模块 docstring 轮次时序措辞更新。
- [ ] **Step 5:** test_session/test_cards 变换：`unanswered_user()` → `unanswered()`；`.text` → `.input`/`.output`；
  branch_segment 断言按「含 fork_point 轮」修正；node_count 断言减半。
- [ ] **Step 6:** `uv run pytest tests/treechat/test_session.py tests/treechat/test_cards.py -q` → 绿；Commit `feat(treechat): 会话门面轮次语义——complete 守卫/branch_segment/make_card/node_count`

### Task 4: webapp 序列化 + pointer 端点

**Files:** Modify `treechat/webapp/app.py`；Test `tests/treechat/test_webapp.py`

- [ ] **Step 1:** `_state` nodes 序列化 `{seq, parent, input, output, model, label}`；`"unansweredUser"` → `"unanswered": conv.unanswered()`；卡片 fromPath 归一化：`"fromPath": [conv.legacy.get(s, s) for s in c.from_path]`。
- [ ] **Step 2:** retry 预检与 `_turn_stream` 内 `unanswered_user()` → `unanswered()`。
- [ ] **Step 3:** 新端点（放在 node_rename 之后）：
  ```python
  class PointerBody(BaseModel):
      seq: int | None

  @app.post("/api/sessions/{sid}/pointer")
  async def pointer(sid: str, body: PointerBody) -> dict[str, Any]:
      """导航 = 内存 set_pointer（不落事件）；返回全量状态。"""
      async with registry.lock(sid):
          s = _open(sid)
          try:
              s.conversation.set_pointer(body.seq)
          except TreeChatError as exc:
              raise HTTPException(400, str(exc)) from exc
          return _state(sid, s)
  ```
- [ ] **Step 4:** test_webapp 变换：断言 payload `text/role` → `input/output`；`unansweredUser` → `unanswered`；
  新增：`POST .../pointer` 200 后 `pointer` 变更且再次 GET 保持（内存语义）；未知 seq → 400；
  旧格式会话文件（手写 jsonl 三行）GET 后 nodes 合并为轮 + 卡片 fromPath 归一化用例。
- [ ] **Step 5:** `uv run pytest tests/treechat/test_webapp.py -q` → 绿；Commit `feat(treechat): webapp 轮次序列化 + pointer 导航端点`

### Task 5: CLI

**Files:** Modify `treechat/cli/repl.py`、`treechat/cli/commands.py`、`treechat/cli/treeview.py`；Test `tests/treechat/test_cli.py` `tests/treechat/test_treeview.py`

- [ ] **Step 1:** repl.py：`conv.unanswered_user()` → `unanswered()`；回显 `node.output`（complete 后必非 None）。
- [ ] **Step 2:** commands.py：`unanswered_user()` 调用点改名；`.text` 消费点按轮改 `.input`/`.output`。
- [ ] **Step 3:** treeview.py emit 一行一轮：
  ```python
  text = n.input.replace("\n", " ")[:32]
  if n.output is not None:
      text += " → " + n.output.replace("\n", " ")[:32]
  lines.append(f"{prefix}{branch}#{seq}{suffix} {text}")
  ```
- [ ] **Step 4:** 测试变换 + 跑测 `uv run pytest tests/treechat/test_cli.py tests/treechat/test_treeview.py -q` → 绿；Commit `feat(treechat): CLI 轮次视图——树一行一轮/unanswered 改名`

### Task 6: 全量后端回归

- [ ] `uv run pytest tests/ -q` → 全绿（webview + treechat）；`uv run pytest ../SpecModule/module_harness/tests/ -q -m "not smoke"` 基线不受影响（本任务不触库，可跳过；若时间允许跑一次确认）。

### Task 7: 前端类型与 API

**Files:** Modify `web/src/chat/types.ts`、`web/src/chat/api.ts`

- [ ] types.ts：
  ```ts
  export interface Node {
    seq: number;
    parent: number | null;
    input: string;
    output: string | null;
    label: string;
    model: string;
  }
  ```
  `ConvState.unansweredUser` → `unanswered: number | null`；`activePath` 不变。
- [ ] api.ts 增：
  ```ts
  export const setPointer = (sid: string, seq: number | null) =>
    req<ConvState>(`/treechat/api/sessions/${encodeURIComponent(sid)}/pointer`, json("POST", { seq }));
  ```

### Task 8: ChatView 轮组 + 操作条 + 聚焦

**Files:** Modify `web/src/chat/ChatView.tsx`

- [ ] Props 扩展：`cardSeqs: number[]`、`onToggleCardSeq: (seq: number) => void`、
  `onRenameTurn: (seq: number, label: string) => Promise<void>`、`onBranchFrom: (seq: number) => void`、
  `focusSeq: number | null`。
- [ ] `MessageItem` → `TurnItem`：`data-seq={node.seq}` 容器内 = 用户气泡（`node.input`，meta：#seq/label/卡片徽标）
  + `node.output !== null && <Markdown text={node.output}>`（meta：model）。
- [ ] 轮末操作条（`opacity-0 group-hover:opacity-100`）：命名（开对话框）/ 选入卡片范围（toggle，选中态高亮）/ 从此分支（`onBranchFrom(node.seq)`）；命名 Dialog + 表单自 TreePanel 迁入（`renameTarget` 本地 state）。
- [ ] 滚动单效应：
  ```tsx
  useEffect(() => {
    if (p.focusSeq != null) {
      rootRef.current?.querySelector(`[data-seq="${p.focusSeq}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [path.length, p.busy, p.focusSeq]);
  ```
  （focusSeq 非空时聚焦滚动胜出；发送/回合 done 时 App 清 focusSeq，贴底恢复。）
  聚焦闪烁：focusSeq 变化时置本地 `flash` state，1.5s 后清除；flash 轮容器加 `ring-1 ring-primary/50` 渐隐。
- [ ] 空态文案更新（点选树节点 = 跳转查看该分支）。错误条 `conv.unansweredUser` → `conv.unanswered`。

### Task 9: TreePanel 导航化 + treelayout 缓冲

**Files:** Modify `web/src/chat/TreePanel.tsx`、`web/src/chat/treelayout.ts`

- [ ] TreePanel Props 收敛：`{ conv, onNavigate(seq), cardSeqs, onToggleCardSeq, onGenerateCard }`；
  删 `selectedSeq/onSelect/onRenameNode/onBranchFrom`、详情卡、命名对话框及其 import。
- [ ] 行点击 = `onNavigate(pos.seq)`；高亮行 = `pos.seq === conv.pointer`；行摘要 = `oneLine(node.input, 48)`
  + `node.output === null && <span>待答</span>` chip。
- [ ] treelayout：根链（`n.parent === null`）lane 选择改「最低空闲且前一 lane 也空闲」：
  ```ts
  const takeRootLane = (seq: number): number => {
    let lane = 0;
    for (;;) {
      const freeHere = (laneUntil.get(lane) ?? -1) < seq;
      const freeBelow = lane === 0 || (laneUntil.get(lane - 1) ?? -1) < seq;
      if (freeHere && freeBelow) return lane;
      lane++;
    }
  };
  ```
  分支（非首子）保持原 `takeFreeLane(seq, parentLane)`；`LANE_W` 22 → 26。文件头注释同步。

### Task 10: Composer + App 接线

**Files:** Modify `web/src/chat/Composer.tsx`、`web/src/App.tsx`

- [ ] Composer：删 `branchParent/onClearBranch` props；增 `branchFrom: number | null`（App 按
  `conv.pointer !== conv.trunkEnd ? conv.pointer : null` 传入）；chip 无关闭钮（事实陈述）。
- [ ] App ChatUi：删 `branchParent/selectedSeq`；增 `focusSeq: number | null`（EMPTY_CHAT_UI 同步）。
- [ ] `navigate(sid, seq)`：`updUi(sid, { focusSeq: null })` 先行清理 →
  `await mutateConv(sid, (s) => chatApi.setPointer(s, seq))` → `updUi(sid, { focusSeq: seq })`。
- [ ] `send()`：不再带 parent；发起时 `updUi(sid, { focusSeq: null, ... })`；SSE done/error 处理器
  `updUi(sid, { focusSeq: null })`（贴底恢复）。
- [ ] 接线：ChatView 传 cardSeqs/onToggleCardSeq/onRenameTurn/onBranchFrom=navigate/focusSeq；
  TreePanel 传 onNavigate=navigate + cardSeqs 三件套（从树面板迁来）；Composer 传 branchFrom。

### Task 11: 前端验收门 + 浏览器实测

- [ ] `cd web && npm run build`（tsc --noEmit + vite build）→ 零错误。
- [ ] 起后端 `uv run uvicorn server.app:app --port 8000` + 前端 `cd web && npm run dev`，
  浏览器开 http://localhost:5173/ ：旧会话（test直答）重放后树为轮节点、无残留 assistant 点；
  叶子链与主干隔一 lane；点击树节点主区切分支并滚动高亮；轮末操作条命名/选卡/从此分支可用；
  输入框「从 #N 分支」随指针常显。

### Task 12: 收尾

- [ ] `roadmap.md` 变更日志补记（轮次合并 / pointer 端点 / 树导航化 / lane 缓冲）。
- [ ] 全量 `uv run pytest tests/ -q` 复绿 + commit 收尾 `feat(web): 树图导航化 + 轮末操作条 + 叶子 lane 缓冲`。
