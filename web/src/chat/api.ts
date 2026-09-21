import type { ConvState, Health, LibraryCard, Mode, SessionSummary, SseEvent } from "./types";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function req<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      /* 非 JSON 错误体 */
    }
    throw new ApiError(msg, res.status);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
});

// ── 枚举 / 健康 ──

export const listSessions = () => req<SessionSummary[]>("/treechat/api/sessions");
export const health = () => req<Health>("/treechat/api/health");

// ── 会话管理 ──

export const createSession = (name: string, system: string, category = "") =>
  req<SessionSummary>("/treechat/api/sessions", json("POST", { name, system, category }));
export const listModes = () => req<Mode[]>("/treechat/api/modes");
export const deleteSession = (sid: string) =>
  req<void>(`/treechat/api/sessions/${encodeURIComponent(sid)}`, { method: "DELETE" });
export const getState = (sid: string) =>
  req<ConvState>(`/treechat/api/sessions/${encodeURIComponent(sid)}`);
export const renameSession = (sid: string, name: string) =>
  req<ConvState>(`/treechat/api/sessions/${encodeURIComponent(sid)}/rename`, json("POST", { name }));
export const setCategory = (sid: string, category: string) =>
  req<ConvState>(`/treechat/api/sessions/${encodeURIComponent(sid)}/category`, json("POST", { category }));
export const setArchived = (sid: string, archived: boolean) =>
  req<ConvState>(`/treechat/api/sessions/${encodeURIComponent(sid)}/archive`, json("POST", { archived }));
export const renameNode = (sid: string, seq: number, label: string) =>
  req<ConvState>(`/treechat/api/sessions/${encodeURIComponent(sid)}/nodes/${seq}/rename`, json("POST", { label }));
/** 树图导航：指针挪到目标轮（内存语义，不落事件） */
export const setPointer = (sid: string, seq: number | null) =>
  req<ConvState>(`/treechat/api/sessions/${encodeURIComponent(sid)}/pointer`, json("POST", { seq }));

// ── 轮次（SSE 流式）──

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
  body: { text: string; parent?: number; leaf?: boolean; module?: string },
  onEvent: (e: SseEvent) => void,
): Promise<void> {
  return streamSse(`/treechat/api/sessions/${encodeURIComponent(sid)}/turn`, body, onEvent);
}
export function retry(sid: string, onEvent: (e: SseEvent) => void): Promise<void> {
  return streamSse(`/treechat/api/sessions/${encodeURIComponent(sid)}/retry`, {}, onEvent);
}

// ── 卡片 ──

export interface CardReq {
  instruction: string;
  mode: "branch" | "all" | "range" | "seqs";
  start?: number;
  end?: number;
  seqs?: number[];
  /** 提炼结果挂到该轮（节点卡）；缺省 = 全局卡 */
  ownerSeq?: number;
}
export const createCard = (sid: string, body: CardReq) =>
  req<ConvState>(`/treechat/api/sessions/${encodeURIComponent(sid)}/cards`, json("POST", body));
export const pinCard = (sid: string, cid: string, pinned: boolean) =>
  req<ConvState>(`/treechat/api/sessions/${encodeURIComponent(sid)}/cards/${cid}/pin`, json("POST", { pinned }));
export const editCard = (sid: string, cid: string, body: { title: string; body: string }) =>
  req<ConvState>(`/treechat/api/sessions/${encodeURIComponent(sid)}/cards/${encodeURIComponent(cid)}`, json("PATCH", body));
export const deleteCard = (sid: string, cid: string) =>
  req<ConvState>(`/treechat/api/sessions/${encodeURIComponent(sid)}/cards/${encodeURIComponent(cid)}`, { method: "DELETE" });
export const importCard = (sid: string, body: { title: string; body: string; instruction?: string; ownerSeq?: number }) =>
  req<ConvState>(`/treechat/api/sessions/${encodeURIComponent(sid)}/cards/import`, json("POST", body));
/** 跨会话卡库（复制导入语义：导入 = 在当前会话建独立副本） */
export const listLibraryCards = () => req<LibraryCard[]>("/treechat/api/cards");
/** 导出端点（Content-Disposition 附件下载，直接给 <a href> 用） */
export const cardExportUrl = (sid: string, cid: string) =>
  `/treechat/api/sessions/${encodeURIComponent(sid)}/cards/${encodeURIComponent(cid)}/export`;
