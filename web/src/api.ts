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
  paused?: boolean;
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

async function postJson<T>(url: string, payload: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
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

// ------------------------------------------------------------------
// 控制面：cancel/pause/unpause + 恢复/回退
// ------------------------------------------------------------------

export type ControlAction = "cancel" | "pause" | "unpause";

export interface ControlView {
  run_id: string;
  control: { action: ControlAction; reason: string | null; requested_at: number } | null;
  paused: boolean;
}

export const fetchControl = (runId: string) =>
  getJson<ControlView>(`/api/runs/${encodeURIComponent(runId)}/control`);

export const postControl = (runId: string, action: ControlAction, reason?: string) =>
  postJson<ControlView>(`/api/runs/${encodeURIComponent(runId)}/control`, {
    action,
    reason: reason ?? null,
  });

export interface CheckpointTarget {
  target: string;
  tick: number;
  kind: "tick" | "manual";
  fired: string[];
  label: string | null;
}

export const fetchCheckpoints = (runId: string) =>
  getJson<{ module_id: string; checkpoints: CheckpointTarget[] }>(
    `/api/runs/${encodeURIComponent(runId)}/checkpoints`,
  ).then((d) => d.checkpoints);

export interface RunInputs {
  run_id: string;
  spec: Record<string, unknown> | null;
  tasklist: Record<string, unknown> | null;
}

export const fetchInputs = (runId: string) =>
  getJson<RunInputs>(`/api/runs/${encodeURIComponent(runId)}/inputs`);

export interface ResumeRequest {
  module?: string | null;
  target?: string | null; // tick 号或 "manual:<label>"；null = 续最新
  spec?: Record<string, unknown> | null;
  tasklist?: Record<string, unknown> | null;
  max_ticks?: number;
  mock?: boolean;
  /** phase=running 也放行（max_ticks 截断的残留 running 态） */
  force?: boolean;
}

export const postResume = (runId: string, body: ResumeRequest) =>
  postJson<{ started: boolean; run_id: string; pid: number }>(
    `/api/runs/${encodeURIComponent(runId)}/resume`,
    body,
  );

export interface ProcessInfo {
  run_id: string;
  running: boolean;
  pid: number | null;
  started_at: number | null;
  log: string | null;
}

export const fetchProcess = (runId: string) =>
  getJson<ProcessInfo>(`/api/runs/${encodeURIComponent(runId)}/process`);
