// App 壳层（二期·页签制）：顶部页签栏——模块库固定页签 + chat 会话 / run 视图
// /构建草稿 动态页签多实例共存。活动栏六页签：tree 为「页签配套功能」（内容随激活
// chat 页签切换）；chat/modules/build/runs/settings 为「全局功能」（不随页签变，只变
// 列表选中高亮）。会话状态按 sid 多实例（一期 TreeChat webui 为单活动会话）。
// 不引 router（useState 范式，两仓库一致）。
// 三期（chat as modules）：回合升级 SSE 流式——回调闭包绑定发起 sid，按 sid 多实例
// 写入运行迹（后台页签的会话持续流式更新是多实例共存的题中之义，无需 active-tab 守卫）；
// 模式 = 对话型 module（创建选择/徽章显示名/设置只读，全走 GET /api/modes 动态清单）。
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Boxes, MessageSquare, PanelRight } from "lucide-react";
import {
  fetchRuns,
  postControl,
  type ControlAction,
  type LaunchResult,
  type RunSummary,
} from "./api";
import * as chatApi from "./chat/api";
import type { ConvState, Health, Mode, RunTrace, SessionSummary, SseEvent } from "./chat/types";
import { CardsSidebar } from "./chat/CardsSidebar";
import { ChatListPanel } from "./chat/ChatListPanel";
import { ChatView } from "./chat/ChatView";
import { Composer } from "./chat/Composer";
import { SettingsPanel } from "./chat/SettingsPanel";
import { TreePanel } from "./chat/TreePanel";
import { ActivityBar, type Tab } from "./components/ActivityBar";
import { LibraryPanel } from "./components/LibraryPanel";
import { ModuleDetail } from "./components/ModuleDetail";
import { ModuleList } from "./components/ModuleList";
import { RunList } from "./components/RunList";
import { RunView, type ResumeRequestMsg } from "./components/RunView";
import { ResizeHandle, useResizableWidth } from "./components/ResizeHandle";
import { ModuleBuilder } from "./components/builder/ModuleBuilder";
import { TabBar, type TabItem } from "./components/TabBar";

/** 主区空态（图标在标题上方，居中） */
function EmptyState({ icon, title, hint }: { icon: ReactNode; title: string; hint: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 text-muted-foreground">
      {icon}
      <div className="text-[13px]">{title}</div>
      <div className="text-[12px] opacity-70">{hint}</div>
    </div>
  );
}

/** 单个会话的随行 UI 态（切页签不丢） */
interface ChatUi {
  leafMode: boolean;
  /** 树图导航聚焦轮（滚动 + 闪烁）；发送/回合收口即清，恢复贴底 */
  focusSeq: number | null;
  cardSeqs: number[];
  cardGenOpen: boolean;
  /** 右侧卡片栏开合（按会话记忆） */
  cardsOpen: boolean;
  busy: boolean;
  error: string | null;
  /** 回合运行迹（SSE 流式瞬态；done/error 后保留收口，新回合即清） */
  run: RunTrace | null;
}
const EMPTY_CHAT_UI: ChatUi = {
  leafMode: false, focusSeq: null,
  cardSeqs: [], cardGenOpen: false, cardsOpen: true, busy: false, error: null, run: null,
};

/** 动态页签：kind + 原始 key（sid / runId / 构建草稿名）；页签 id = `${kind}:${key}` */
interface DynTab { kind: "chat" | "run" | "build"; key: string }
const tabId = (t: DynTab) => `${t.kind}:${t.key}`;

export default function App() {
  // ── 壳层 ──
  const [sidebarTab, setSidebarTab] = useState<Tab>("runs");
  const [dynTabs, setDynTabs] = useState<DynTab[]>([]);
  const [activeId, setActiveId] = useState<string>("modules");
  const [openModuleName, setOpenModuleName] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runsTotal, setRunsTotal] = useState(0);
  // 打开恢复对话框的请求：runId + seq 守卫（一期机制原样）
  const [resumeRequest, setResumeRequest] = useState<ResumeRequestMsg | null>(null);
  // 左侧栏拖宽（持久化，双击手柄复位）
  const leftBar = useResizableWidth({
    storageKey: "specmodule-webview.sidebar.left",
    initial: 280, min: 200, max: 520, side: "left",
  });

  // ── 对话（全局枚举 + 按 sid 多实例状态）──
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [chatServiceUp, setChatServiceUp] = useState<boolean | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [modes, setModes] = useState<Mode[]>([]);
  // 已删会话的流事件兜底：后端 delete 与轮次共用 registry 锁（删除必排在在飞轮次后），
  // 此 ref 只兜异常路径（断流竞态等），对齐 webui 单会话守卫的意图；finally 移除，
  // 同名 sid 重建会话不受影响。
  const deletedSids = useRef(new Set<string>());
  const [convs, setConvs] = useState<Record<string, ConvState>>({});
  const [chatUi, setChatUi] = useState<Record<string, ChatUi>>({});

  const getChatUi = useCallback(
    (sid: string): ChatUi => chatUi[sid] ?? EMPTY_CHAT_UI, [chatUi]);
  const updUi = useCallback((sid: string, patch: Partial<ChatUi>) => {
    setChatUi((prev) => ({ ...prev, [sid]: { ...(prev[sid] ?? EMPTY_CHAT_UI), ...patch } }));
  }, []);
  const updRun = useCallback((sid: string, fn: (r: RunTrace | null) => RunTrace | null) => {
    setChatUi((prev) => {
      const ui = prev[sid] ?? EMPTY_CHAT_UI;
      return { ...prev, [sid]: { ...ui, run: fn(ui.run) } };
    });
  }, []);

  // ── 流式合帧：token/thinking 增量入 ref 缓冲，requestAnimationFrame 逐帧刷入
  // state（SSE 逐 token 到达，逐条 setState + 全文 Markdown 重解析会打爆渲染）──
  const pendingDeltaRef = useRef(new Map<string, Map<string, { text: string; thinking: string }>>());
  const rafRef = useRef<number | null>(null);

  const flushDeltas = useCallback(() => {
    rafRef.current = null;
    const pending = pendingDeltaRef.current;
    if (pending.size === 0) return;
    pendingDeltaRef.current = new Map();
    for (const [sid, deltas] of pending) {
      updRun(sid, (r) => r && { ...r, nodes: r.nodes.map((n) => {
        const d = deltas.get(n.key);
        if (!d) return n;
        return { ...n, text: n.text + d.text, thinking: n.thinking + d.thinking };
      }) });
    }
  }, [updRun]);

  const bufferDelta = useCallback((sid: string, key: string, kind: "text" | "thinking", chunk: string) => {
    let perSid = pendingDeltaRef.current.get(sid);
    if (!perSid) {
      perSid = new Map();
      pendingDeltaRef.current.set(sid, perSid);
    }
    const cur = perSid.get(key) ?? { text: "", thinking: "" };
    cur[kind] += chunk;
    perSid.set(key, cur);
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(flushDeltas);
  }, [flushDeltas]);

  useEffect(() => () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
  }, []);

  // 列表不做周期轮询（2026-09-15 根修，specs/2026-09-15-run-list-decoupling）：
  // 首次加载 + 事件钩子（发起/删除/行内控制/页签终态）触发；页签内监控走 WS
  const refreshRuns = useCallback(() => {
    fetchRuns()
      .then((d) => {
        setRuns(d.runs);
        setRunsTotal(d.total);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    refreshRuns();
  }, [refreshRuns]);

  // 对话服务探测：404 = /treechat 未挂载（引擎已收编、挂载常开，此态仅剩防御意义：
  // 后端过旧或未启动）；其余错误不翻转状态
  const refreshSessions = useCallback(() => {
    chatApi.listSessions()
      .then((ss) => { setSessions(ss); setChatServiceUp(true); })
      .catch((e) => {
        if (e instanceof chatApi.ApiError && e.status === 404) setChatServiceUp(false);
      });
  }, []);
  useEffect(() => {
    refreshSessions();
    chatApi.health().then(setHealth)
      .catch((e) => {
        if (e instanceof chatApi.ApiError && e.status === 404) setChatServiceUp(false);
      });
    chatApi.listModes().then(setModes).catch(() => setModes([]));
  }, [refreshSessions]);

  // ── 页签开/关 ──

  const ensureTab = useCallback((kind: "chat" | "run" | "build", key: string) => {
    setDynTabs((prev) =>
      prev.some((t) => t.kind === kind && t.key === key) ? prev : [...prev, { kind, key }]);
  }, []);
  const openChat = useCallback((sid: string) => {
    ensureTab("chat", sid);
    setActiveId(`chat:${sid}`);
  }, [ensureTab]);
  const openRunTab = useCallback((rid: string) => {
    ensureTab("run", rid);
    setActiveId(`run:${rid}`);
  }, [ensureTab]);
  // 构建板块：打开/新建草稿 → build 页签（侧栏随之切组件库）
  const openBuilder = useCallback((name: string) => {
    ensureTab("build", name);
    setActiveId(`build:${name}`);
    setSidebarTab("build");
  }, [ensureTab]);

  // 关闭激活页签 → 激活同位置后一页签，没有则前一页签，再没有回落模块库
  const closeTab = useCallback((id: string) => {
    const idx = dynTabs.findIndex((t) => tabId(t) === id);
    if (idx === -1) return;
    const rest = dynTabs.filter((t) => tabId(t) !== id);
    setDynTabs(rest);
    if (activeId === id) {
      const fallback = rest[idx] ?? rest[idx - 1];
      setActiveId(fallback ? tabId(fallback) : "modules");
    }
  }, [dynTabs, activeId]);

  // 激活 chat 页签的会话状态懒加载（切回已打开页签走缓存不重拉）
  const activeChatSid = activeId.startsWith("chat:") ? activeId.slice(5) : null;
  const activeRunId = activeId.startsWith("run:") ? activeId.slice(4) : null;
  const activeBuildName = activeId.startsWith("build:") ? activeId.slice(6) : null;
  useEffect(() => {
    if (!activeChatSid || convs[activeChatSid]) return;
    let alive = true;
    chatApi.getState(activeChatSid)
      .then((st) => { if (alive) setConvs((prev) => ({ ...prev, [activeChatSid]: st })); })
      .catch((e) => { if (alive) updUi(activeChatSid, { error: String(e) }); });
    return () => { alive = false; };
  }, [activeChatSid, convs, updUi]);

  // ── 对话操作（对齐 TreeChat webui App 接线，状态升级为按 sid）──

  const createSession = async (name: string, system: string, category: string) => {
    await chatApi.createSession(name, system, category);
    refreshSessions();
    openChat(name); // sid = 创建名（rename 只改显示名）
  };

  const deleteSession = async (sid: string) => {
    deletedSids.current.add(sid);
    try {
      await chatApi.deleteSession(sid);
      closeTab(`chat:${sid}`);
      setConvs((prev) => { const n = { ...prev }; delete n[sid]; return n; });
      setChatUi((prev) => { const n = { ...prev }; delete n[sid]; return n; });
      refreshSessions();
    } finally {
      deletedSids.current.delete(sid);
    }
  };

  const mutateConv = async (sid: string, fn: (s: string) => Promise<ConvState>) => {
    const st = await fn(sid);
    setConvs((prev) => ({ ...prev, [sid]: st }));
    refreshSessions();
  };

  // ── 轮次（SSE 流式；回调闭包绑定发起 sid，按 sid 多实例写入）──

  const handleEvent = useCallback((sid: string, ev: SseEvent) => {
    if (deletedSids.current.has(sid)) return; // 会话已删：丢弃残余流事件
    const d = ev.data;
    if (ev.event === "start") {
      pendingDeltaRef.current.delete(sid); // 丢弃陈旧缓冲
      updRun(sid, () => ({
        userSeq: d.userSeq, module: d.module, finished: false,
        nodes: d.nodes.map((n: { key: string; label: string }) => (
          { ...n, text: "", thinking: "", outcome: "running" as const, refs: [] })),
        tools: [],
      }));
    } else if (ev.event === "node_start") {
      updRun(sid, (r) => r && { ...r, nodes: r.nodes.map((n) =>
        n.key === d.key ? { ...n, outcome: "running" as const } : n) });
    } else if (ev.event === "token") {
      bufferDelta(sid, d.key, "text", d.text);
    } else if (ev.event === "thinking") {
      bufferDelta(sid, d.key, "thinking", d.text);
    } else if (ev.event === "node_end") {
      updRun(sid, (r) => r && { ...r, nodes: r.nodes.map((n) =>
        n.key === d.key ? { ...n, outcome: d.outcome, refs: d.refs ?? [] } : n) });
    } else if (ev.event === "tool_call") {
      updRun(sid, (r) => r && { ...r, tools: [...(r.tools ?? []), {
        id: d.id, name: d.name, args: JSON.stringify(d.args ?? {}),
        status: "running" as const, summary: "", runId: null }] });
    } else if (ev.event === "tool_result") {
      updRun(sid, (r) => r && { ...r, tools: (r.tools ?? []).map((t) =>
        t.id === d.id ? { ...t, status: d.ok ? "ok" as const : "failed" as const,
                          summary: d.summary ?? "", runId: d.runId ?? null } : t) });
    } else if (ev.event === "done") {
      setConvs((prev) => ({ ...prev, [sid]: d.state }));
      updRun(sid, (r) => r && { ...r, finished: true });
      updUi(sid, { error: null, focusSeq: null }); // 新轮落位 → 贴底跟随
      refreshSessions();
    } else if (ev.event === "error") {
      if (d.state) setConvs((prev) => ({ ...prev, [sid]: d.state }));
      updRun(sid, (r) => r && { ...r, finished: true, errored: true,
        tools: r.tools.map((t) => t.status === "running"
          ? { ...t, status: "failed" as const, summary: t.summary || "回合中断" } : t) });
      updUi(sid, { error: d.error });
    }
  }, [updRun, updUi, refreshSessions, bufferDelta]);

  // 树图导航 / 轮末「从此分支」：指针挪到目标轮（后端内存态）+ 主区聚焦该轮；
  // 回合运行迹随导航清除（它只属于发起时的分支上下文，切换即过期）
  const navigateTurn = useCallback(async (sid: string, seq: number) => {
    updUi(sid, { focusSeq: null, run: null });
    try {
      const st = await chatApi.setPointer(sid, seq);
      setConvs((prev) => ({ ...prev, [sid]: st }));
      updUi(sid, { focusSeq: seq });
    } catch (e) {
      updUi(sid, { error: e instanceof Error ? e.message : String(e) });
    }
  }, [updUi]);

  const send = async (sid: string, text: string, module?: string) => {
    const ui = getChatUi(sid);
    if (ui.busy) return;
    const leaf = ui.leafMode || undefined;
    updUi(sid, { busy: true, error: null, leafMode: false, focusSeq: null, run: null });
    try {
      // 斜杠切换：setCategory 返回的新 ConvState 即时写回——模式 chip 本轮就回显新模式
      //（不等回合结束 refreshSessions），失败不阻断回合（turn 自带 module，本轮模式不变）
      if (module) await chatApi.setCategory(sid, module)
        .then((st) => setConvs((prev) => ({ ...prev, [sid]: st })))
        .catch(() => {});
      await chatApi.turn(sid, { text, leaf, module }, (ev) => handleEvent(sid, ev));
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

  const createCard = async (sid: string, req: Parameters<typeof chatApi.createCard>[1]) => {
    updUi(sid, { busy: true });
    try {
      const st = await chatApi.createCard(sid, req);
      setConvs((prev) => ({ ...prev, [sid]: st }));
      refreshSessions();
    } catch (e) {
      updUi(sid, { error: e instanceof Error ? e.message : String(e) });
    } finally {
      updUi(sid, { busy: false });
    }
  };

  // ── run 操作（一期语义平移到页签制）──

  // RunList 行内恢复按钮：打开目标 run 页签并请求恢复对话框（runId + seq 守卫不变）
  const handleListResume = useCallback((rid: string) => {
    openRunTab(rid);
    setResumeRequest({ runId: rid, seq: Date.now() });
  }, [openRunTab]);

  const consumeResumeRequest = useCallback(() => setResumeRequest(null), []);

  // RunList 行内控制：失败静默——控制动作后显式刷新列表，状态即真相
  const handleListControl = useCallback(
    async (rid: string, action: ControlAction) => {
      try {
        await postControl(rid, action);
      } catch {
        // 行内静默：刷新后状态即真相
      }
      refreshRuns();
    },
    [refreshRuns],
  );

  // 删除成功：刷新列表；删的是打开中的 run 则关页签（closeTab 负责激活回落）
  const handleDeleted = useCallback(
    (deletedId: string) => {
      refreshRuns();
      closeTab(`run:${deletedId}`);
    },
    [refreshRuns, closeTab],
  );

  // 模块库发起运行成功（202）：开 run 页签并激活；侧栏切「运行历史」看列表高亮
  const handleLaunched = useCallback(
    (r: LaunchResult) => {
      refreshRuns();
      openRunTab(r.run_id);
      setSidebarTab("runs");
    },
    [refreshRuns, openRunTab],
  );

  // 模块库列表点选：主区回模块库页签显详情
  const selectModule = useCallback((name: string) => {
    setOpenModuleName(name);
    setActiveId("modules");
  }, []);

  // ── 页签栏条目（label 动态解析：会话跟随 rename；run 用 module 名回落 run_id）──
  const tabItems: TabItem[] = [
    { id: "modules", kind: "modules", label: "模块库", closable: false },
    ...dynTabs.map((t) =>
      t.kind === "chat"
        ? { id: tabId(t), kind: "chat" as const, label: convs[t.key]?.name ?? t.key, closable: true }
        : t.kind === "build"
          ? { id: tabId(t), kind: "build" as const, label: t.key, closable: true }
          : {
              id: tabId(t), kind: "run" as const,
              label: runs.find((r) => r.run_id === t.key)?.module || t.key, closable: true,
            },
    ),
  ];

  // ── 激活 chat 页签的配套态（tree/cards 面板绑定）──
  const activeConv = activeChatSid ? convs[activeChatSid] ?? null : null;
  const activeUi = activeChatSid ? getChatUi(activeChatSid) : EMPTY_CHAT_UI;

  return (
    <div className="flex h-full w-full overflow-hidden">
      <ActivityBar tab={sidebarTab} onTab={setSidebarTab} />

      {/* 侧边栏：内容随活动栏页签切换（全局列表 + 页签配套面板） */}
      <aside className="flex h-full shrink-0 flex-col border-r bg-sidebar" style={{ width: leftBar.width }}>
        {sidebarTab === "chat" && (
          <ChatListPanel
            serviceAvailable={chatServiceUp !== false}
            sessions={sessions}
            modes={modes}
            activeSid={activeChatSid}
            onOpen={openChat}
            onCreate={createSession}
            onRename={(sid, name) => mutateConv(sid, (s) => chatApi.renameSession(s, name))}
            onCategory={(sid, cat) => mutateConv(sid, (s) => chatApi.setCategory(s, cat))}
            onArchive={(sid, a) => mutateConv(sid, (s) => chatApi.setArchived(s, a))}
            onDelete={deleteSession}
          />
        )}
        {sidebarTab === "tree" && (
          <TreePanel
            conv={activeConv}
            onNavigate={(seq) => activeChatSid && navigateTurn(activeChatSid, seq)}
            cardSeqs={activeUi.cardSeqs}
            onToggleCardSeq={(seq) => activeChatSid && updUi(activeChatSid, {
              cardSeqs: activeUi.cardSeqs.includes(seq)
                ? activeUi.cardSeqs.filter((s) => s !== seq)
                : [...activeUi.cardSeqs, seq],
            })}
            onGenerateCard={() => {
              if (!activeChatSid) return;
              updUi(activeChatSid, { cardGenOpen: true, cardsOpen: true });
            }}
          />
        )}
        {sidebarTab === "modules" && (
          <ModuleList selected={openModuleName} onSelect={selectModule} />
        )}
        {sidebarTab === "build" && (
          <LibraryPanel
            activeDraft={activeBuildName}
            onOpenDraft={openBuilder}
            onCreated={openBuilder}
            onDeleted={(name) => closeTab(`build:${name}`)}
          />
        )}
        {sidebarTab === "runs" && (
          <RunList
            runs={runs}
            total={runsTotal}
            current={activeRunId}
            onSelect={openRunTab}
            onControl={handleListControl}
            onResume={handleListResume}
            onDeleted={handleDeleted}
            onRefresh={refreshRuns}
          />
        )}
        {sidebarTab === "settings" && (
          <SettingsPanel health={health} serviceAvailable={chatServiceUp !== false} modes={modes} />
        )}
      </aside>

      <ResizeHandle dragging={leftBar.dragging} {...leftBar.handleProps} />

      {/* 主区：顶部页签栏 + 激活页签内容 */}
      <main className="flex h-full min-w-0 flex-1 flex-col bg-background">
        <TabBar tabs={tabItems} activeId={activeId} onSelect={setActiveId} onClose={closeTab} />
        <div className="min-h-0 flex-1">
          {activeId === "modules" ? (
            openModuleName ? (
              <ModuleDetail key={openModuleName} name={openModuleName} onLaunched={handleLaunched} onEdit={openBuilder} />
            ) : (
              <EmptyState icon={<Boxes className="h-8 w-8 text-muted-foreground/40" />} title="未选择模块" hint="从左侧模块库选择，查看详情并发起运行" />
            )
          ) : activeChatSid ? (
            activeConv ? (
              <div className="flex h-full min-h-0">
                <div className="flex h-full min-w-0 flex-1 flex-col">
                  <header className="flex h-11 shrink-0 items-center gap-2 border-b px-4">
                    <span className="truncate text-[13px] font-semibold">{activeConv.name}</span>
                    {activeConv.category && (
                      <span className="rounded-full bg-foreground/[0.07] px-2 py-0.5 text-[11px] text-muted-foreground">
                        {modes.find((m) => m.key === activeConv.category)?.displayName ?? activeConv.category}
                      </span>
                    )}
                    {activeConv.archived && (
                      <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                        已归档
                      </span>
                    )}
                    {activeConv.system && (
                      <span title={`system: ${activeConv.system}`}
                            className="max-w-[30%] truncate text-[11px] text-muted-foreground/70">
                        system: {activeConv.system}
                      </span>
                    )}
                    <span className="ml-auto font-mono text-[11px] text-muted-foreground/70">
                      指针 #{activeConv.pointer ?? "—"}
                      {health && !health.llmConfigured && " · LLM 未配置"}
                    </span>
                    <button title="卡片栏" onClick={() => updUi(activeChatSid, { cardsOpen: !activeUi.cardsOpen })}
                            className="ml-1 shrink-0 rounded-control p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
                      <PanelRight className="h-4 w-4" />
                    </button>
                  </header>
                  <ChatView
                    conv={activeConv}
                    busy={activeUi.busy}
                    error={activeUi.error}
                    run={activeUi.run}
                    focusSeq={activeUi.focusSeq}
                    cardSeqs={activeUi.cardSeqs}
                    modes={modes}
                    onToggleCardSeq={(seq) => activeChatSid && updUi(activeChatSid, {
                      cardSeqs: activeUi.cardSeqs.includes(seq)
                        ? activeUi.cardSeqs.filter((s) => s !== seq)
                        : [...activeUi.cardSeqs, seq],
                    })}
                    onRenameTurn={async (seq, label) => {
                      if (activeChatSid) await mutateConv(activeChatSid, (s) => chatApi.renameNode(s, seq, label));
                    }}
                    onBranchFrom={(seq) => activeChatSid && navigateTurn(activeChatSid, seq)}
                    onRetry={() => activeChatSid && retry(activeChatSid)}
                    onLocateDoc={(seq) => updUi(activeChatSid, { cardsOpen: true, focusSeq: seq })}
                    onOpenRun={openRunTab}
                  />
                  <Composer
                    leafMode={activeUi.leafMode}
                    busy={activeUi.busy}
                    disabled={false}
                    modes={modes}
                    category={activeConv.category}
                    onToggleLeaf={() => activeChatSid && updUi(activeChatSid, { leafMode: !activeUi.leafMode })}
                    onSwitchMode={(key) => activeChatSid && mutateConv(activeChatSid, (s) => chatApi.setCategory(s, key))}
                    onSend={(text, module) => activeChatSid && send(activeChatSid, text, module)}
                  />
                </div>
                {activeUi.cardsOpen && (
                  <aside className="flex h-full w-80 shrink-0 flex-col border-l bg-sidebar">
                    <CardsSidebar
                      conv={activeConv}
                      onNavigate={(seq) => navigateTurn(activeChatSid, seq)}
                      onCollapse={() => updUi(activeChatSid, { cardsOpen: false })}
                      onPromoteCard={async (c) => {
                        await mutateConv(activeChatSid, (s) => chatApi.importCard(s, {
                          title: c.title, body: c.body,
                          instruction: `升自节点卡 ${c.id}`,
                        }));
                      }}
                      genOpen={activeUi.cardGenOpen}
                      onGenOpenChange={(o) => updUi(activeChatSid, { cardGenOpen: o })}
                      cardSeqs={activeUi.cardSeqs}
                      onClearCardSeqs={() => updUi(activeChatSid, { cardSeqs: [] })}
                      onCreateCard={async (req) => { await createCard(activeChatSid, req); }}
                      onPin={async (cid, pinned) => { await mutateConv(activeChatSid, (s) => chatApi.pinCard(s, cid, pinned)); }}
                      onEditCard={async (cid, body) => { await mutateConv(activeChatSid, (s) => chatApi.editCard(s, cid, body)); }}
                      onDeleteCard={async (cid) => { await mutateConv(activeChatSid, (s) => chatApi.deleteCard(s, cid)); }}
                      onImportCard={async (body) => { await mutateConv(activeChatSid, (s) => chatApi.importCard(s, body)); }}
                    />
                  </aside>
                )}
              </div>
            ) : (
              <EmptyState
                icon={<MessageSquare className="h-8 w-8 text-muted-foreground/40" />}
                title="加载会话…"
                hint={activeUi.error ?? ""}
              />
            )
          ) : activeRunId ? (
            <RunView
              key={activeRunId}
              runId={activeRunId}
              resumeRequest={resumeRequest}
              onResumeRequestConsumed={consumeResumeRequest}
              onRequestResume={(rid) => setResumeRequest({ runId: rid, seq: Date.now() })}
              onRefreshRuns={refreshRuns}
            />
          ) : activeBuildName ? (
            <ModuleBuilder
              key={activeBuildName}
              name={activeBuildName}
              onInstalled={(moduleName) => {
                setOpenModuleName(moduleName);
                setActiveId("modules");
                setSidebarTab("modules");
              }}
            />
          ) : null}
        </div>
      </main>
    </div>
  );
}
