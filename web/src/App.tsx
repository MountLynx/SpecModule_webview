// App 壳层（二期·页签制）：顶部页签栏——📦 模块库固定页签 + chat 会话 / run 视图
// 动态页签多实例共存。活动栏六页签：tree/cards 为「页签配套功能」（内容随激活
// chat 页签切换）；chat/modules/runs/settings 为「全局功能」（不随页签变，只变
// 列表选中高亮）。会话状态按 sid 多实例（一期 TreeChat webui 为单活动会话）。
// 不引 router（useState 范式，两仓库一致）。
import { useCallback, useEffect, useState } from "react";
import {
  fetchRuns,
  postControl,
  type ControlAction,
  type LaunchResult,
  type RunSummary,
} from "./api";
import * as chatApi from "./chat/api";
import type { ConvState, Health, SessionSummary } from "./chat/types";
import { CardsPanel } from "./chat/CardsPanel";
import { ChatListPanel } from "./chat/ChatListPanel";
import { ChatView } from "./chat/ChatView";
import { Composer } from "./chat/Composer";
import { SettingsPanel } from "./chat/SettingsPanel";
import { TreePanel } from "./chat/TreePanel";
import { ActivityBar, type Tab } from "./components/ActivityBar";
import { ModuleDetail } from "./components/ModuleDetail";
import { ModuleList } from "./components/ModuleList";
import { RunList } from "./components/RunList";
import { RunView, type ResumeRequestMsg } from "./components/RunView";
import { TabBar, type TabItem } from "./components/TabBar";

/** 主区空态 */
function EmptyState({ icon, title, hint }: { icon: string; title: string; hint: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 text-muted-foreground">
      <div className="text-[34px]">{icon}</div>
      <div className="text-[13.5px]">{title}</div>
      <div className="text-[11.5px] opacity-70">{hint}</div>
    </div>
  );
}

/** 单个会话的随行 UI 态（切页签不丢） */
interface ChatUi {
  branchParent: number | null;
  leafMode: boolean;
  selectedSeq: number | null;
  cardSeqs: number[];
  cardGenOpen: boolean;
  busy: boolean;
  error: string | null;
}
const EMPTY_CHAT_UI: ChatUi = {
  branchParent: null, leafMode: false, selectedSeq: null,
  cardSeqs: [], cardGenOpen: false, busy: false, error: null,
};

/** 动态页签：kind + 原始 key（sid / runId）；页签 id = `${kind}:${key}` */
interface DynTab { kind: "chat" | "run"; key: string }
const tabId = (t: DynTab) => `${t.kind}:${t.key}`;

export default function App() {
  // ── 壳层 ──
  const [sidebarTab, setSidebarTab] = useState<Tab>("runs");
  const [dynTabs, setDynTabs] = useState<DynTab[]>([]);
  const [activeId, setActiveId] = useState<string>("modules");
  const [openModuleName, setOpenModuleName] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  // 打开恢复对话框的请求：runId + seq 守卫（一期机制原样）
  const [resumeRequest, setResumeRequest] = useState<ResumeRequestMsg | null>(null);

  // ── 对话（全局枚举 + 按 sid 多实例状态）──
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [chatServiceUp, setChatServiceUp] = useState<boolean | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [convs, setConvs] = useState<Record<string, ConvState>>({});
  const [chatUi, setChatUi] = useState<Record<string, ChatUi>>({});

  const getChatUi = useCallback(
    (sid: string): ChatUi => chatUi[sid] ?? EMPTY_CHAT_UI, [chatUi]);
  const updUi = useCallback((sid: string, patch: Partial<ChatUi>) => {
    setChatUi((prev) => ({ ...prev, [sid]: { ...(prev[sid] ?? EMPTY_CHAT_UI), ...patch } }));
  }, []);

  const refreshRuns = useCallback(() => {
    fetchRuns().then(setRuns).catch(() => {});
  }, []);
  useEffect(() => {
    refreshRuns();
    const t = setInterval(refreshRuns, 5000);
    return () => clearInterval(t);
  }, [refreshRuns]);

  // 对话服务探测：404 = treechat 未挂载（服务未启用）；其余错误不翻转状态
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
  }, [refreshSessions]);

  // ── 页签开/关 ──

  const ensureTab = useCallback((kind: "chat" | "run", key: string) => {
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
  useEffect(() => {
    if (!activeChatSid || convs[activeChatSid]) return;
    let alive = true;
    chatApi.getState(activeChatSid)
      .then((st) => { if (alive) setConvs((prev) => ({ ...prev, [activeChatSid]: st })); })
      .catch((e) => { if (alive) updUi(activeChatSid, { error: String(e) }); });
    return () => { alive = false; };
  }, [activeChatSid, convs, updUi]);

  // ── 对话操作（对齐 TreeChat webui App 接线，状态升级为按 sid）──

  const createSession = async (name: string, system: string) => {
    await chatApi.createSession(name, system);
    refreshSessions();
    openChat(name); // sid = 创建名（rename 只改显示名）
  };

  const deleteSession = async (sid: string) => {
    await chatApi.deleteSession(sid);
    closeTab(`chat:${sid}`);
    setConvs((prev) => { const n = { ...prev }; delete n[sid]; return n; });
    setChatUi((prev) => { const n = { ...prev }; delete n[sid]; return n; });
    refreshSessions();
  };

  const mutateConv = async (sid: string, fn: (s: string) => Promise<ConvState>) => {
    const st = await fn(sid);
    setConvs((prev) => ({ ...prev, [sid]: st }));
    refreshSessions();
  };

  const send = async (sid: string, text: string) => {
    const ui = getChatUi(sid);
    if (ui.busy) return;
    const parent = ui.branchParent ?? undefined;
    const leaf = ui.leafMode || undefined;
    updUi(sid, { busy: true, error: null, branchParent: null, leafMode: false });
    try {
      const r = await chatApi.turn(sid, { text, parent, leaf });
      setConvs((prev) => ({ ...prev, [sid]: r.state }));
      if (r.error) updUi(sid, { error: r.error });
      refreshSessions();
    } catch (e) {
      updUi(sid, { error: e instanceof Error ? e.message : String(e) });
    } finally {
      updUi(sid, { busy: false });
    }
  };

  const retry = async (sid: string) => {
    if (getChatUi(sid).busy) return;
    updUi(sid, { busy: true });
    try {
      const st = await chatApi.retry(sid);
      setConvs((prev) => ({ ...prev, [sid]: st }));
      updUi(sid, { error: null });
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

  // RunList 行内 ↻：打开目标 run 页签并请求恢复对话框（runId + seq 守卫不变）
  const handleListResume = useCallback((rid: string) => {
    openRunTab(rid);
    setResumeRequest({ runId: rid, seq: Date.now() });
  }, [openRunTab]);

  const consumeResumeRequest = useCallback(() => setResumeRequest(null), []);

  // RunList 行内控制：失败静默——列表 5s 轮询刷新后状态即真相
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
      <aside className="flex h-full w-[280px] shrink-0 flex-col border-r bg-sidebar">
        {sidebarTab === "chat" && (
          <ChatListPanel
            serviceAvailable={chatServiceUp !== false}
            sessions={sessions}
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
            selectedSeq={activeUi.selectedSeq}
            onSelect={(seq) => activeChatSid && updUi(activeChatSid, { selectedSeq: seq })}
            onRenameNode={async (seq, label) => {
              if (activeChatSid) await mutateConv(activeChatSid, (s) => chatApi.renameNode(s, seq, label));
            }}
            onBranchFrom={(seq) => activeChatSid && updUi(activeChatSid, { branchParent: seq })}
            cardSeqs={activeUi.cardSeqs}
            onToggleCardSeq={(seq) => activeChatSid && updUi(activeChatSid, {
              cardSeqs: activeUi.cardSeqs.includes(seq)
                ? activeUi.cardSeqs.filter((s) => s !== seq)
                : [...activeUi.cardSeqs, seq],
            })}
            onGenerateCard={() => {
              if (!activeChatSid) return;
              updUi(activeChatSid, { cardGenOpen: true });
              setSidebarTab("cards"); // 卡片生成对话框挂在 CardsPanel，须切过去才可见
            }}
          />
        )}
        {sidebarTab === "cards" && (
          <CardsPanel
            conv={activeConv}
            genOpen={activeUi.cardGenOpen}
            onGenOpenChange={(o) => activeChatSid && updUi(activeChatSid, { cardGenOpen: o })}
            cardSeqs={activeUi.cardSeqs}
            onClearCardSeqs={() => activeChatSid && updUi(activeChatSid, { cardSeqs: [] })}
            onCreateCard={async (req) => { if (activeChatSid) await createCard(activeChatSid, req); }}
            onPin={async (cid, pinned) => { if (activeChatSid) await mutateConv(activeChatSid, (s) => chatApi.pinCard(s, cid, pinned)); }}
            onEditCard={async (cid, body) => { if (activeChatSid) await mutateConv(activeChatSid, (s) => chatApi.editCard(s, cid, body)); }}
            onDeleteCard={async (cid) => { if (activeChatSid) await mutateConv(activeChatSid, (s) => chatApi.deleteCard(s, cid)); }}
            onImportCard={async (body) => { if (activeChatSid) await mutateConv(activeChatSid, (s) => chatApi.importCard(s, body)); }}
          />
        )}
        {sidebarTab === "modules" && (
          <ModuleList selected={openModuleName} onSelect={selectModule} />
        )}
        {sidebarTab === "runs" && (
          <RunList
            runs={runs}
            current={activeRunId}
            onSelect={openRunTab}
            onControl={handleListControl}
            onResume={handleListResume}
            onDeleted={handleDeleted}
          />
        )}
        {sidebarTab === "settings" && (
          <SettingsPanel health={health} serviceAvailable={chatServiceUp !== false} />
        )}
      </aside>

      {/* 主区：顶部页签栏 + 激活页签内容 */}
      <main className="flex h-full min-w-0 flex-1 flex-col bg-background">
        <TabBar tabs={tabItems} activeId={activeId} onSelect={setActiveId} onClose={closeTab} />
        <div className="min-h-0 flex-1">
          {activeId === "modules" ? (
            openModuleName ? (
              <ModuleDetail key={openModuleName} name={openModuleName} onLaunched={handleLaunched} />
            ) : (
              <EmptyState icon="📦" title="未选择模块" hint="从左侧模块库选择，查看详情并发起运行" />
            )
          ) : activeChatSid ? (
            activeConv ? (
              <div className="flex h-full flex-col">
                <header className="flex h-11 shrink-0 items-center gap-2 border-b px-4">
                  <span className="truncate text-[13.5px] font-semibold">{activeConv.name}</span>
                  {activeConv.category && (
                    <span className="rounded-full bg-foreground/[0.07] px-2 py-0.5 text-[11px] text-muted-foreground">
                      {activeConv.category}
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
                </header>
                <ChatView
                  conv={activeConv}
                  busy={activeUi.busy}
                  error={activeUi.error}
                  onRetry={() => activeChatSid && retry(activeChatSid)}
                />
                <Composer
                  branchParent={activeUi.branchParent}
                  leafMode={activeUi.leafMode}
                  busy={activeUi.busy}
                  disabled={false}
                  onClearBranch={() => activeChatSid && updUi(activeChatSid, { branchParent: null })}
                  onToggleLeaf={() => activeChatSid && updUi(activeChatSid, { leafMode: !activeUi.leafMode })}
                  onSend={(text) => activeChatSid && send(activeChatSid, text)}
                />
              </div>
            ) : (
              <EmptyState
                icon="💬"
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
          ) : null}
        </div>
      </main>
    </div>
  );
}
