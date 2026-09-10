import type { ConvState, Health, LibraryCard, SessionSummary } from "./types";

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

export const createSession = (name: string, system: string) =>
  req<SessionSummary>("/treechat/api/sessions", json("POST", { name, system }));
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

// ── 轮次 ──

export interface TurnResult {
  error?: string;
  state: ConvState;
}
/** turn 特殊处理：LLM 失败返回 502 {error, state}——user 节点已落盘，前端要更新状态 */
export async function turn(
  sid: string,
  body: { text: string; parent?: number; leaf?: boolean },
): Promise<TurnResult> {
  const res = await fetch(`/treechat/api/sessions/${encodeURIComponent(sid)}/turn`, {
    headers: { "Content-Type": "application/json" },
    method: "POST",
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (res.status === 502) return { error: data.error, state: data.state };
  if (!res.ok) throw new ApiError(data?.error ?? res.statusText, res.status);
  return { state: data as ConvState };
}
export const retry = (sid: string) =>
  req<ConvState>(`/treechat/api/sessions/${encodeURIComponent(sid)}/retry`, json("POST", {}));

// ── 卡片 ──

export interface CardReq {
  instruction: string;
  mode: "branch" | "all" | "range" | "seqs";
  start?: number;
  end?: number;
  seqs?: number[];
}
export const createCard = (sid: string, body: CardReq) =>
  req<ConvState>(`/treechat/api/sessions/${encodeURIComponent(sid)}/cards`, json("POST", body));
export const pinCard = (sid: string, cid: string, pinned: boolean) =>
  req<ConvState>(`/treechat/api/sessions/${encodeURIComponent(sid)}/cards/${cid}/pin`, json("POST", { pinned }));
export const editCard = (sid: string, cid: string, body: { title: string; body: string }) =>
  req<ConvState>(`/treechat/api/sessions/${encodeURIComponent(sid)}/cards/${encodeURIComponent(cid)}`, json("PATCH", body));
export const deleteCard = (sid: string, cid: string) =>
  req<ConvState>(`/treechat/api/sessions/${encodeURIComponent(sid)}/cards/${encodeURIComponent(cid)}`, { method: "DELETE" });
export const importCard = (sid: string, body: { title: string; body: string; instruction?: string }) =>
  req<ConvState>(`/treechat/api/sessions/${encodeURIComponent(sid)}/cards/import`, json("POST", body));
/** 跨会话卡库（复制导入语义：导入 = 在当前会话建独立副本） */
export const listLibraryCards = () => req<LibraryCard[]>("/treechat/api/cards");
/** 导出端点（Content-Disposition 附件下载，直接给 <a href> 用） */
export const cardExportUrl = (sid: string, cid: string) =>
  `/treechat/api/sessions/${encodeURIComponent(sid)}/cards/${encodeURIComponent(cid)}/export`;
