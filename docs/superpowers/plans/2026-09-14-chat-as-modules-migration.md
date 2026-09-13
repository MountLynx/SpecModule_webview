# Chat as Modules 三期迁移（TreeChat → webview）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 TreeChat 仓库已完成的「chat as modules」改动（模块化回合 + SSE 流式 + modes API）迁移集成到本仓库——挂载回归 + 前端模式入口与流式渲染。

**Architecture:** 后端零改动——treechat 以 editable 安装（`pip show treechat` Location 指向 `C:\Users\xingy\Desktop\开发\TreeChat`），`server/chat.py` 的挂载契约（`create_app(config, client_factory, static_dir)` / `app.state.registry`）在新版 webapp 中不变，SSE/modes 自动跟随；本仓库只需升级挂载测试到 SSE 契约。前端 `web/src/chat/` 是 TreeChat webui 的移植副本，需移植自移植基点（origin/main）以来的全部前端差异：types（Mode/RunTrace/SseEvent）、api（streamSse + turn/retry SSE + listModes + category）、ChatView（RunBlock）、ChatListPanel（创建选模式）、SettingsPanel（模式只读）、App.tsx（按 sid 多实例的 SSE 接线）。

**Tech Stack:** FastAPI TestClient（httpx streaming）+ Vite/React/TS + fetch 流式读取（无新依赖）。

---

## 实际实现与原设计的偏差（用户确认）

- **v1 对话型 module 只有两个**：`direct`（直答）+ `grilling`（拷问，key=`grilling`、
  displayName=`拷问`、description=`设计树拷问 + 领域词表沉淀（每轮刷新两张卡片）`）。
  **grilling 吸收了 domain-modeling**：节点序 `TreeUpdate → FrontierFormat → Resolution`，
  `Resolution` 节点承担术语拷问/裁决/词表更新，产出 `spec:glossary`（CONTEXT 词表草稿）卡片——
  原设计的 domain-modeling 独立模块不再存在。
- **message_field 由模块声明**：document 形态归一化输出中作为 assistant 消息正文的字段名
  （grilling 声明 `questions_md`；空串 = 无消息），bridge 不再硬编码 `questions_md`。
- 前端所有模式展示都走 `GET /api/modes` 动态清单，不硬编码模块名——偏差对前端透明。

## 多实例推广说明（webview 相对 webui 的有意差异）

TreeChat webui 是单活动会话，用 `activeSidRef` 守卫「SSE 回调在切会话后到达」。webview
壳层会话状态本就按 sid 多实例（`convs`/`chatUi` 记录），SSE 回调闭包绑定发起时的 sid、
写入对应 sid 的状态即可——后台页签的会话流式更新正是多实例共存的题中之义，**不需要
active-tab 守卫**。会话删除的幽灵文件问题由后端新契约兜底（`session_delete` 与轮次共用
registry 锁，删除必然排在在飞轮次完成之后），purge 时序天然安全。

---

### Task 1: 挂载测试升级——SSE 回合契约 + modes 端点回归

**Files:**
- Modify: `tests/test_chat_mount.py`

- [ ] **Step 1.1: 升级假客户端为 complete 能力（镜像 treechat tests/conftest.FakeModuleClient）**

替换 `FakeChatClient`（旧版只有 `chat()`，新回合路径走 `complete(on_token=...)`）：

```python
class FakeChatClient:
    """带 complete() 的假客户端：responses 队列脚本化节点输出（对齐 treechat conftest）。"""

    def __init__(self, reply: str = "mock reply", fail: bool = False) -> None:
        self.reply, self.fail = reply, fail
        self.config = type("Config", (), {"model": "fake-model"})()

    async def complete(self, **kwargs):
        if self.fail:
            raise LLMError("模拟基础设施故障")
        on_token = kwargs.get("on_token")
        if on_token:
            step = max(1, len(self.reply) // 3)
            for i in range(0, len(self.reply), step):
                on_token(self.reply[i:i + step])
        return LLMResponse(content=self.reply,
                           usage={"input_tokens": 1, "output_tokens": 2})
```

- [ ] **Step 1.2: env fixture 升级 `with TestClient` 形态 + 新增 sse_events 辅助**

registry 的 asyncio.Lock 须跨请求存续（对齐 treechat test_webapp.api fixture）：

```python
@pytest.fixture
def env(tmp_path):
    """隔离挂载的三元组：(TestClient, base_dir, 子应用 registry)。

    with 形式：整个测试期共享同一 portal/事件循环（lifespan 启动），
    registry 的 asyncio.Lock 跨请求存续才有真实锁语义（SSE 回合流必需）。
    """
    app = FastAPI()
    assert mount_chat(app, base_dir=tmp_path) is True
    with TestClient(app) as c:
        yield c, tmp_path, app.state.chat_registry


def sse_events(client, url, **kwargs):
    """POST 流式端点 → [(event, data)]（帧解析，对齐 treechat test_webapp）。"""
    import json
    events = []
    with client.stream("POST", url, **kwargs) as resp:
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        event = None
        for line in resp.iter_lines():
            if line.startswith("event: "):
                event = line[len("event: "):]
            elif line.startswith("data: ") and event is not None:
                events.append((event, json.loads(line[len("data: "):])))
                event = None
    return events
```

（`import json` 提到文件头部。）

- [ ] **Step 1.3: 重写 test_turn_success / test_turn_llm_failure_contract 为 SSE 契约**

```python
def test_turn_success(env):
    c, _, reg = env
    c.post("/treechat/api/sessions", json={"name": "t"})
    _reopen_with(reg, "t", FakeChatClient(reply="这是回复"))
    events = sse_events(c, "/treechat/api/sessions/t/turn", json={"text": "你好"})
    kinds = [e for e, _ in events]
    # SSE 序列：start 预告 → 节点事件（含逐 token）→ done 终帧
    assert kinds[0] == "start"
    assert "node_start" in kinds and "token" in kinds
    assert kinds[-1] == "done"
    st = events[-1][1]["state"]
    assert [n["role"] for n in st["nodes"]] == ["user", "assistant"]
    assert st["nodes"][1]["text"] == "这是回复"
    assert st["nodes"][1]["model"] == "fake-model"
    assert st["pointer"] == st["nodes"][-1]["seq"]
    assert st["unansweredUser"] is None


def test_turn_llm_failure_contract(env):
    """LLM 失败 → SSE error 帧（REST 502 契约退役）：user 节点已落盘（悬而未答）。"""
    c, _, reg = env
    c.post("/treechat/api/sessions", json={"name": "f"})
    _reopen_with(reg, "f", FakeChatClient(fail=True))
    events = sse_events(c, "/treechat/api/sessions/f/turn", json={"text": "你好"})
    assert events[-1][0] == "error"
    assert "模拟基础设施故障" in events[-1][1]["error"]
    st = events[-1][1]["state"]
    assert [n["role"] for n in st["nodes"]] == ["user"]
    assert st["unansweredUser"] == st["nodes"][0]["seq"]
    # 重试换好客户端 → done 帧补 assistant，问题不丢不重复
    _reopen_with(reg, "f", FakeChatClient(reply="补上了"))
    events = sse_events(c, "/treechat/api/sessions/f/retry")
    assert events[-1][0] == "done"
    st = events[-1][1]["state"]
    assert [n["role"] for n in st["nodes"]] == ["user", "assistant"]
    assert st["nodes"][0]["text"] == "你好"
```

- [ ] **Step 1.4: 新增 modes 端点 + 分类创建回归**

```python
def test_modes_endpoint_and_categorized_session(env):
    """模式枚举透传（BUILT_IN：direct/grilling——grilling 已吸收 domain-modeling）
    + 分类创建会话（三期模式入口的挂载级契约）。"""
    c, _, _ = env
    modes = c.get("/treechat/api/modes").json()
    assert [m["key"] for m in modes] == ["direct", "grilling"]
    assert modes[0]["displayName"] == "直答"
    assert modes[1]["displayName"] == "拷问"
    assert modes[1]["description"]
    r = c.post("/treechat/api/sessions", json={"name": "g", "category": "grilling"})
    assert r.status_code == 200 and r.json()["category"] == "grilling"
    assert c.get("/treechat/api/sessions/g").json()["category"] == "grilling"
```

- [ ] **Step 1.5: 运行挂载测试全绿**

Run: `python -m pytest tests/test_chat_mount.py -q`
Expected: 8 passed

- [ ] **Step 1.6: Commit**

```bash
git add tests/test_chat_mount.py
git commit -m "test(chat): 挂载测试升级 SSE 回合契约 + modes 端点回归（三期迁移）"
```

### Task 2: 前端 types + api 客户端（SSE 流式 + modes）

**Files:**
- Modify: `web/src/chat/types.ts`
- Modify: `web/src/chat/api.ts`

- [ ] **Step 2.1: types.ts 追加 Mode / SseEvent / CardRef / RunTrace / RunNodeState**

在 `LibraryCard` 之后、`Tab` 之前插入（自 webui/src/types.ts 逐字移植）：

```ts
/** 对话模式（GET /api/modes） */
export interface Mode {
  key: string;
  displayName: string;
  description: string;
}

/** SSE 事件（POST /turn、/retry 流式响应） */
export interface SseEvent {
  event: string;
  data: any;
}

/** node_end 的卡片引用（链接片） */
export interface CardRef {
  type: "card";
  cardId: string;
  title: string;
}

/** 回合运行迹（webui 瞬态：done 后保留链接片，新回合/刷新即清） */
export interface RunTrace {
  userSeq: number;
  module: string;
  nodes: RunNodeState[];
  finished: boolean;
  /** error 帧收口标记 */
  errored?: boolean;
}

export interface RunNodeState {
  key: string;
  label: string;
  text: string;
  outcome: "running" | "ok" | "failed";
  refs: CardRef[];
}
```

- [ ] **Step 2.2: api.ts——createSession 带 category、listModes、streamSse + SSE turn/retry**

`/treechat` 前缀锚定（本仓库差异）。imports 行替换为：

```ts
import type { ConvState, Health, LibraryCard, Mode, SessionSummary, SseEvent } from "./types";
```

会话管理段：`createSession` 换签名 + 新增 `listModes`：

```ts
export const createSession = (name: string, system: string, category = "") =>
  req<SessionSummary>("/treechat/api/sessions", json("POST", { name, system, category }));
export const listModes = () => req<Mode[]>("/treechat/api/modes");
```

轮次段：删除 `TurnResult` 接口与旧 `turn`/`retry`，替换为（自 webui 逐字移植，URL 加前缀）：

```ts
/** POST 流式端点：逐帧解析 SSE（event:/data:），onEvent 每事件回调 */
async function streamSse(url: string, body: unknown,
                         onEvent: (e: SseEvent) => void): Promise<void> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    let msg = res.statusText;
    try {
      const b = await res.json();
      if (b?.error) msg = b.error;
    } catch {
      /* 非 JSON 错误体 */
    }
    throw new ApiError(msg, res.status);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let sawTerminal = false;
  /** dispatch 一帧；返回是否终帧（done/error）。onEvent 异常正常上抛，不静默 */
  const dispatch = (frame: string): boolean => {
    let event = "";
    let dataRaw = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) dataRaw += line.slice(6);
    }
    if (!event) return false;
    let data: unknown;
    try {
      data = JSON.parse(dataRaw);
    } catch {
      return false; /* 残帧忽略 */
    }
    onEvent({ event, data });
    return event === "done" || event === "error";
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      if (dispatch(buf.slice(0, idx))) sawTerminal = true;
      buf = buf.slice(idx + 2);
    }
  }
  if (buf && dispatch(buf)) sawTerminal = true; /* 末帧被截断（无 \n\n 结尾）补发，仍以 sawTerminal 判定 */
  if (!sawTerminal) throw new ApiError("连接中断", 0);
}

export function turn(
  sid: string,
  body: { text: string; parent?: number; leaf?: boolean },
  onEvent: (e: SseEvent) => void,
): Promise<void> {
  return streamSse(`/treechat/api/sessions/${encodeURIComponent(sid)}/turn`, body, onEvent);
}
export function retry(sid: string, onEvent: (e: SseEvent) => void): Promise<void> {
  return streamSse(`/treechat/api/sessions/${encodeURIComponent(sid)}/retry`, {}, onEvent);
}
```

- [ ] **Step 2.3: Commit**

```bash
git add web/src/chat/types.ts web/src/chat/api.ts
git commit -m "feat(web): chat api 升级 SSE 流式回合契约 + modes API（类型与客户端）"
```

### Task 3: ChatView——RunBlock 流式运行块

**Files:**
- Modify: `web/src/chat/ChatView.tsx`

- [ ] **Step 3.1: Props 扩展 + RunBlock 渲染（自 webui 逐字移植，types 从 `./types` 导入）**

import 行：`import type { Card, ConvState, Node, RunTrace } from "./types";`

Props 接口替换为：

```ts
interface Props {
  conv: ConvState;
  busy: boolean;
  error: string | null;
  run: RunTrace | null;
  onRetry: () => void;
  onOpenCards: () => void;
}
```

消息流与 busy 指示之间插入运行块（`{path.map(...)}` 之后、`{p.busy && (` 之前）：

```tsx
        {p.run && <RunBlock run={p.run} onOpenCards={p.onOpenCards} />}
```

文件末尾追加 RunBlock 组件（逐字移植）：

```tsx
/** 回合运行块：节点预告 → 逐 token 全文 → 收口（文档节点折叠为卡片链接片）。 */
function RunBlock({ run, onOpenCards }: { run: RunTrace; onOpenCards: () => void }) {
  return (
    <div className="rounded-panel border border-border/60 bg-sidebar px-3 py-2">
      <div className="pb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        {run.errored ? "回合失败" : run.finished ? "回合完成" : "回合运行中"} · {run.module}
      </div>
      <div className="flex flex-col gap-2.5">
        {run.nodes.map((n) => (
          <div key={n.key}>
            <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <span>{n.outcome === "failed" ? "✗" : n.outcome === "ok" ? "✓" : "◌"}</span>
              <span className={n.outcome === "failed" ? "text-destructive" : ""}>{n.label}</span>
            </div>
            {n.outcome === "running" && n.text && <Markdown text={n.text} />}
            {n.outcome === "ok" && n.refs.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-1">
                {n.refs.map((r) => (
                  <button key={r.cardId} onClick={onOpenCards}
                          className="rounded-full border border-border px-2 py-px text-[11.5px]
                                     text-muted-foreground hover:bg-foreground/[0.05]">
                    📄 {r.title} → 已更新到卡片
                  </button>
                ))}
              </div>
            )}
            {n.outcome === "ok" && n.refs.length === 0 && !run.finished && n.text && (
              <Markdown text={n.text} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3.2: Commit**

```bash
git add web/src/chat/ChatView.tsx
git commit -m "feat(web): ChatView 增 RunBlock——节点预告/逐 token/卡片链接片"
```

### Task 4: ChatListPanel 模式选择 + SettingsPanel 模式只读

**Files:**
- Modify: `web/src/chat/ChatListPanel.tsx`
- Modify: `web/src/chat/SettingsPanel.tsx`

- [ ] **Step 4.1: ChatListPanel——modes 透传 + 创建对话框模式选择器**

import：`import type { Mode, SessionSummary } from "./types";`

Props：`onCreate` 换签名 + 新增 `modes`：

```ts
  modes: Mode[];
  onCreate: (name: string, system: string, category: string) => Promise<void>;
```

`ChatListPanelInner` 里 CreateForm 调用处传 modes：

```tsx
{dialog?.kind === "create" && <CreateForm onDone={setDialog} onCreate={p.onCreate} modes={p.modes} />}
```

CreateForm 替换（对齐 webui CreateForm；modes 为空回落「直答」option，direct key 映射空分类）：

```tsx
function CreateForm(p: {
  onDone: (d: DialogState) => void;
  onCreate: (name: string, system: string, category: string) => Promise<void>;
  modes: Mode[];
}) {
  const [name, setName] = useState("");
  const [system, setSystem] = useState("");
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <>
      <DialogTitle>新对话</DialogTitle>
      <DialogDescription>创建一个对话树会话。</DialogDescription>
      <div className="grid gap-2.5">
        <Input autoFocus placeholder="对话名称" value={name} maxLength={80}
               onChange={(e) => setName(e.target.value)} />
        <select value={category} onChange={(e) => setCategory(e.target.value)}
                className="h-9 rounded-control border border-border bg-background px-2 text-[13px]">
          {p.modes.length === 0 && <option value="">直答</option>}
          {p.modes.map((m) => (
            <option key={m.key} value={m.key === "direct" ? "" : m.key}>
              {m.displayName}
            </option>
          ))}
        </select>
        <Textarea placeholder="会话级 system 指令（可选）" value={system}
                  onChange={(e) => setSystem(e.target.value)} />
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => p.onDone(null)}>取消</Button>
        <Button disabled={!name.trim() || busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await p.onCreate(name.trim(), system, category);
                    p.onDone(null);
                  } finally {
                    setBusy(false);
                  }
                }}>
          创建
        </Button>
      </DialogFooter>
    </>
  );
}
```

- [ ] **Step 4.2: SettingsPanel——对话模式只读展示**

Props 增 `modes: Mode[]`；serviceAvailable 分支内、对话服务卡片之后插入（对齐 webui SettingsTab）：

```tsx
            <div>
              <div className="pb-1 font-medium text-foreground">对话模式（只读）</div>
              {modes.map((m) => (
                <div key={m.key} className="mb-1.5 rounded-panel border border-border/60 px-2.5 py-1.5">
                  <span className="font-medium text-foreground">{m.displayName}</span>
                  <span className="pl-1.5 font-mono text-[11px]">{m.key}</span>
                  <div className="text-[11.5px]">{m.description}</div>
                </div>
              ))}
            </div>
```

import：`import type { Health, Mode } from "./types";`

- [ ] **Step 4.3: Commit**

```bash
git add web/src/chat/ChatListPanel.tsx web/src/chat/SettingsPanel.tsx
git commit -m "feat(web): 会话创建模式选择 + 设置页模式只读展示"
```

### Task 5: App.tsx 壳层接线——SSE 按 sid 多实例

**Files:**
- Modify: `web/src/App.tsx`

- [ ] **Step 5.1: imports + modes 状态 + ChatUi.run**

- react import 增 `useRef`（删除会话页签时的流守卫兜底）——注意：多实例下 SSE 回调按 sid 写状态本不需要 active-tab 守卫；ref 只用于 `deletedSids` 兜底（见 Step 5.3）。
- types import 增 `RunTrace, SseEvent, Mode`。
- `ChatUi` 增字段 `run: RunTrace | null;`，`EMPTY_CHAT_UI` 增 `run: null`。
- 新增状态与拉取（health useEffect 旁）：

```tsx
  const [modes, setModes] = useState<Mode[]>([]);
  useEffect(() => {
    chatApi.listModes().then(setModes).catch(() => setModes([]));
  }, []);
```

- 新增 updRun 辅助（updUi 旁；run 节点更新需函数式变换）：

```tsx
  const updRun = useCallback((sid: string, fn: (r: RunTrace | null) => RunTrace | null) => {
    setChatUi((prev) => {
      const ui = prev[sid] ?? EMPTY_CHAT_UI;
      return { ...prev, [sid]: { ...ui, run: fn(ui.run) } };
    });
  }, []);
```

- [ ] **Step 5.2: handleEvent + send/retry 换 SSE**

```tsx
  // ── 轮次（SSE 流式；回调闭包绑定发起 sid，按 sid 多实例写入）──
  const handleEvent = useCallback((sid: string, ev: SseEvent) => {
    if (deletedSids.current.has(sid)) return; // 会话已删：丢弃残余流事件
    const d = ev.data;
    if (ev.event === "start") {
      updRun(sid, () => ({
        userSeq: d.userSeq, module: d.module, finished: false,
        nodes: d.nodes.map((n: { key: string; label: string }) => (
          { ...n, text: "", outcome: "running" as const, refs: [] })),
      }));
    } else if (ev.event === "node_start") {
      updRun(sid, (r) => r && { ...r, nodes: r.nodes.map((n) =>
        n.key === d.key ? { ...n, outcome: "running" as const } : n) });
    } else if (ev.event === "token") {
      updRun(sid, (r) => r && { ...r, nodes: r.nodes.map((n) =>
        n.key === d.key ? { ...n, text: n.text + d.text } : n) });
    } else if (ev.event === "node_end") {
      updRun(sid, (r) => r && { ...r, nodes: r.nodes.map((n) =>
        n.key === d.key ? { ...n, outcome: d.outcome, refs: d.refs ?? [] } : n) });
    } else if (ev.event === "done") {
      setConvs((prev) => ({ ...prev, [sid]: d.state }));
      updRun(sid, (r) => r && { ...r, finished: true });
      updUi(sid, { error: null });
      refreshSessions();
    } else if (ev.event === "error") {
      if (d.state) setConvs((prev) => ({ ...prev, [sid]: d.state }));
      updRun(sid, (r) => r && { ...r, finished: true, errored: true });
      updUi(sid, { error: d.error });
    }
  }, [updRun, updUi, refreshSessions]);

  const send = async (sid: string, text: string) => {
    const ui = getChatUi(sid);
    if (ui.busy) return;
    const parent = ui.branchParent ?? undefined;
    const leaf = ui.leafMode || undefined;
    updUi(sid, { busy: true, error: null, branchParent: null, leafMode: false, run: null });
    try {
      await chatApi.turn(sid, { text, parent, leaf }, (ev) => handleEvent(sid, ev));
      refreshSessions();
    } catch (e) {
      updUi(sid, { error: e instanceof Error ? e.message : String(e) });
    } finally {
      updUi(sid, { busy: false });
    }
  };

  const retry = async (sid: string) => {
    if (getChatUi(sid).busy) return;
    updUi(sid, { busy: true, error: null, run: null });
    try {
      await chatApi.retry(sid, (ev) => handleEvent(sid, ev));
      refreshSessions();
    } catch (e) {
      updUi(sid, { error: e instanceof Error ? e.message : String(e) });
    } finally {
      updUi(sid, { busy: false });
    }
  };
```

- [ ] **Step 5.3: deleteSession 幽灵流兜底 + createSession 带 category**

```tsx
  // 已删会话的流事件兜底：后端 delete 与轮次共用锁（删除排在在飞轮次后），
  // 此 ref 只兜异常路径（断流重试竞态等），对齐 webui 的守卫意图。
  const deletedSids = useRef(new Set<string>());
```

deleteSession：

```tsx
  const deleteSession = async (sid: string) => {
    deletedSids.current.add(sid);
    try {
      await chatApi.deleteSession(sid);
      closeTab(`chat:${sid}`);
      setConvs((prev) => { const n = { ...prev }; delete n[sid]; return n; });
      setChatUi((prev) => { const n = { ...prev }; delete n[sid]; return n; });
      refreshSessions();
    } finally {
      deletedSids.current.delete(sid); // 同名 sid 重建会话不受影响
    }
  };
```

createSession：

```tsx
  const createSession = async (name: string, system: string, category: string) => {
    await chatApi.createSession(name, system, category);
    refreshSessions();
    openChat(name); // sid = 创建名（rename 只改显示名）
  };
```

- [ ] **Step 5.4: 面板/主区 props 接线**

- `ChatListPanel` 增 `modes={modes}`。
- `SettingsPanel` 增 `modes={modes}`。
- 主区 header 徽章改显示名查找：

```tsx
{activeConv.category && (
  <span className="rounded-full bg-foreground/[0.07] px-2 py-0.5 text-[11px] text-muted-foreground">
    {modes.find((m) => m.key === activeConv.category)?.displayName ?? activeConv.category}
  </span>
)}
```

- `ChatView` 增 `run={activeUi.run}` 与 `onOpenCards={() => setSidebarTab("cards")}`。

- [ ] **Step 5.5: Commit**

```bash
git add web/src/App.tsx
git commit -m "feat(web): 壳层接入 SSE 流式回合——按 sid 多实例运行迹 + 模式入口接线"
```

### Task 6: vite proxy 注释 + roadmap/AGENTS 文档同步

**Files:**
- Modify: `web/vite.config.ts`（仅注释：SSE 走 HTTP 流式，无 WS）
- Modify: `roadmap.md`（变更日志追加 2026-09-14 三期迁移条目）
- Modify: `AGENTS.md`（`/treechat/api/*` 行改 SSE 契约 + modes；web/ 目录描述补 RunBlock/模式入口）

- [ ] **Step 6.1: vite.config.ts 注释更新**

```ts
      // TreeChat 对话服务（server 整树挂载于 /treechat；回合为 SSE 流式，HTTP 即可）
      "/treechat": { target: "http://127.0.0.1:8000", changeOrigin: true },
```

- [ ] **Step 6.2: roadmap.md 变更日志条目**

```markdown
- 2026-09-14 **TreeChat 整合三期迁移：chat as modules 集成**——TreeChat 仓库先行完成
  （module_bridge/SSE 传输/嵌入式对话型 module/category 模式化），本仓库挂载集成：
  后端零改动（`server/chat.py` 挂载契约不变，editable 安装自动跟随 SSE/modes）；
  挂载测试升级 SSE 回合契约（start/token/done 序列、LLM 失败 error 帧——REST 502 契约
  退役）+ `/treechat/api/modes` 与分类创建回归。前端移植 webui 增量：SSE 流式回合
  （streamSse 逐帧解析 + RunBlock 节点预告/逐 token 全文/卡片链接片收口）、会话创建
  模式选择、页签徽章显示名、设置页模式只读；**SSE 按 sid 多实例推广**（回调绑定发起
  sid，后台页签会话持续流式——webui 单活动会话的 activeSidRef 守卫不需要）。偏差记录：
  v1 对话型 module 实为两个——grilling 吸收 domain-modeling（Resolution 节点裁决 +
  spec:glossary 词表卡片），message_field 改模块声明。业务 run 联动（spec 卡片 →
  发起业务 run）留三期收口后续。设计：
  `docs/superpowers/specs/2026-09-11-chat-as-modules-design.md`；
  计划：`docs/superpowers/plans/2026-09-14-chat-as-modules-migration.md`。
```

- [ ] **Step 6.3: AGENTS.md 同步**

`/treechat/api/*` 行 Shape 改为：会话 CRUD/轮次（turn/retry 为 SSE 流式——start 预告 →
逐 token/节点进度 → done/error 终帧全量回流 ConvState）/卡片/健康/`GET /api/modes`
（模式枚举，会话创建带 category）；LLM 失败 → SSE error 帧 `{error, state}`（user 节点
已落盘可重试）；session delete 与轮次共用 registry 锁。web/ 目录描述补：ChatView
RunBlock、ChatListPanel 模式选择、SettingsPanel 模式只读。

- [ ] **Step 6.4: Commit**

```bash
git add web/vite.config.ts roadmap.md AGENTS.md
git commit -m "docs: AGENTS/roadmap 同步 chat as modules 三期迁移（SSE 契约/模式入口/偏差记录）"
```

### Task 7: 全量验证

- [ ] **Step 7.1: 后端套件全绿**

Run: `python -m pytest tests/ -q`
Expected: 全部通过（含升级后的 8 例挂载测试）

- [ ] **Step 7.2: 前端验收门**

Run: `cd web && npm run build`
Expected: tsc --noEmit 零错误 + vite build 成功

- [ ] **Step 7.3: 库基线**

Run: `python -m pytest ../SpecModule/module_harness/tests/ -q -m "not smoke"`
Expected: 不因本仓库改动破坏（本仓库未触碰库消费面，例行确认）

## Self-Review

- **Spec 覆盖**：设计「落地路径 2」中的 挂载升级回归（Task 1）/前端模式入口与流式渲染
  （Task 2–5）/卡片双通道（二期 CardsPanel 编辑通道 + 后端自动刷新已在，无需改动）已覆盖；
  业务 run 联动不在 TreeChat 本次改动内 → 记录为三期收口后续（roadmap 明示）。
- **偏差**：grilling 吸收 domain-modeling → 前端全走 /api/modes 动态清单，无硬编码，
  Task 1 测试按实际 BUILT_IN（direct/grilling）断言。
- **类型一致性**：`RunTrace`/`RunNodeState`/`CardRef`/`Mode`/`SseEvent` 与 webui 逐字一致；
  `chatApi.turn/retry` 签名（onEvent 回调）与 App.tsx 调用一致；`createSession(name, system,
  category)` 三处（api/ChatListPanel Props/App）签名一致。
