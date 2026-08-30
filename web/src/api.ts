// 后端形状与 Part 2 各端点 Produces 一一对应。

export interface RunSummary {
  run_id: string;
  phase: string;
  tick: number | null;
  error: string | null;
  updated_at: number;
}

export interface GraphNode {
  id: string;
  label: string;
  type: "harness" | "script" | "command" | "submodule" | "unknown";
  is_start: boolean;
  join: "AND" | "OR";
  inputs: Record<string, string>;
}

export interface GraphEdge {
  from: string;
  to: string;
  guard: string | null;
}

export interface NodeState {
  fired_count: number;
  last_status: "ok" | "failed" | "aborted" | null;
  last_tick: number | null;
  running: boolean;
}

export interface GraphPayload {
  run_id: string;
  module: string;
  phase: string | null;
  tick: number | null;
  graph: { nodes: GraphNode[]; edges: GraphEdge[]; starts: string[] };
  node_states: Record<string, NodeState>;
}

export interface StatusCore {
  phase: string;
  status: string | null;
  tick: number | null;
  fireable: string[];
  fired: string[];
  outputs: Record<string, unknown>;
  error: string | null;
  updated_at: number;
}

export interface StatusMsg extends StatusCore {
  type: "status";
}

export interface StatusResp extends StatusCore {
  module_id: string;
  node_states: Record<string, Record<string, unknown>>;
}

export interface TimelineEntry {
  tick: number;
  node: string;
  status: string;
  output: unknown;
  error: string | null;
}

/** 服务端错误：message 面向用户，code/status 供前端分支（如模块解析失败弹选择器）。 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, message: string, code: string | null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const b = body as { error?: string; code?: string };
    throw new ApiError(r.status, b.error ?? `HTTP ${r.status}`, b.code ?? null);
  }
  return body as T;
}

export const fetchRuns = () =>
  getJson<{ runs: RunSummary[] }>("/api/runs").then((d) => d.runs);

export const fetchStatus = (runId: string) =>
  getJson<StatusResp>(`/api/runs/${encodeURIComponent(runId)}/status`);

export const fetchGraph = (runId: string, module?: string) =>
  getJson<GraphPayload>(
    `/api/runs/${encodeURIComponent(runId)}/graph${
      module ? `?module=${encodeURIComponent(module)}` : ""
    }`,
  );

export interface ModuleInfo {
  name: string;
  kind: string;
  version: string;
  description: string;
  path: string;
}

export const fetchModules = () =>
  getJson<{ modules: ModuleInfo[] }>("/api/modules").then((d) => d.modules);

export const fetchNodeTimeline = (runId: string, node: string) =>
  getJson<{ entries: TimelineEntry[] }>(
    `/api/runs/${encodeURIComponent(runId)}/timeline?node=${encodeURIComponent(node)}`,
  );
