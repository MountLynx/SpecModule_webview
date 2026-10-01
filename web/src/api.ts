// 后端形状与 Part 2 各端点 Produces 一一对应。

/** 终态集合：done/aborted/cancelled/truncated（截断）——轮询与控制条分支共用（收口定义源）。 */
export const TERMINAL_PHASES = new Set(["done", "aborted", "cancelled", "truncated"]);

export interface RunSummary {
  run_id: string;
  /** 源模块名（status.json 溯源字段；旧 run 无 → null，前端回落 run_id 启发式） */
  module: string | null;
  phase: string;
  tick: number | null;
  error: string | null;
  updated_at: number;
  has_sqlite: boolean;
  paused: boolean;
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
  /** 运行中覆盖（在最新快照 fireable 集合）——仅 graph 载荷携带，WS 累计推送无此键 */
  running?: boolean;
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
  /** 按节点累计运行摘要（{fired_count, last_status, last_tick}，无 running 键）。
   *  仅 WS 推送携带——服务端按 firings 表全量重建，客户端纯覆盖（跳拍/重连不丢）。 */
  node_states?: Record<string, NodeState>;
  /**
   * 仅 WS 推送携带——HTTP status 端点无此字段，故挂在 StatusMsg 而非 StatusCore。 */
  stream_mtime: number | null;
}

/** stream.log 记录（LLM 流式输出；run_start = 新执行边界，前端据此清缓冲） */
export interface StreamRecord {
  type: "run_start" | "call_start" | "token" | "thinking" | "call_end" | "call_error";
  ts: number;
  node?: string;
  chunk?: string;
  [k: string]: unknown;
}

export interface StreamMsg {
  type: "stream";
  records: StreamRecord[];
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

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const b = body as { error?: string; code?: string };
    throw new ApiError(r.status, b.error ?? `HTTP ${r.status}`, b.code ?? null);
  }
  return body as T;
}

async function getJson<T>(url: string): Promise<T> {
  return request<T>(url);
}

async function postJson<T>(url: string, payload: unknown): Promise<T> {
  return request<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/** GET /api/runs 载荷：最近 N 条完整行 + 历史总目录数（尾部只计不展开）。 */
export interface RunsPayload {
  runs: RunSummary[];
  total: number;
}

export interface RunArtifact {
  index: number;
  name: string;
  kind: "deliverable" | "intermediate";
  path: string;
  size: number;
  modified: string;
}

export interface RunArtifactsPayload {
  run_id: string;
  artifacts: RunArtifact[];
}

export const fetchRuns = () => getJson<RunsPayload>("/api/runs");

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

export interface ModulesPayload {
  modules: ModuleInfo[];
  /** 实际扫描目录（server 随 base_dir 锚定；排查「为什么看不到我的模块」） */
  search_paths: string[];
}

export const fetchModules = () => getJson<ModulesPayload>("/api/modules");

/** 单模板解析对象（store.detail_to_dict 出口；spec 两键库内 spec_for 已按模板回落，前端零回落逻辑） */
export interface TemplateInfo {
  name: string;
  description: string; // 模板 JSON 自带，缺省 ""
  spec_schema: Record<string, string> | null;
  default_spec: Record<string, unknown> | null;
}

/** 模块详情（store.detail_to_dict 形状；templates 为解析后对象列表，submodules 为排序出名列表） */
export interface ModuleDetail {
  name: string;
  kind: string;
  path: string;
  version: string;
  description: string;
  default_template: string | null;
  templates: TemplateInfo[];
  default_spec: Record<string, unknown> | null;
  spec_schema: Record<string, string> | null;
  submodules: string[];
}

export const fetchModuleDetail = (name: string) =>
  getJson<ModuleDetail>(`/api/modules/${encodeURIComponent(name)}`);

// ------------------------------------------------------------------
// 运行历史管理 + 发起运行
// ------------------------------------------------------------------

export const deleteRun = (runId: string, force = false) =>
  request<{ run_id: string; deleted: boolean }>(
    `/api/runs/${encodeURIComponent(runId)}${force ? "?force=true" : ""}`,
    { method: "DELETE" },
  );

/** 发起运行 body（spec null → CLI 回落 entry.default_spec；template null → default_template） */
export interface LaunchRequest {
  module: string;
  spec?: Record<string, unknown> | null;
  template?: string | null;
  run_id?: string | null;
  max_ticks?: number;
  mock?: boolean;
}

export interface LaunchResult {
  started: boolean;
  run_id: string;
  pid: number;
  module: string;
}

export const postLaunch = (body: LaunchRequest) =>
  postJson<LaunchResult>("/api/runs", body);


export const fetchNodeTimeline = (runId: string, node: string) =>
  getJson<{ entries: TimelineEntry[] }>(
    `/api/runs/${encodeURIComponent(runId)}/timeline?node=${encodeURIComponent(node)}`,
  );

/** GET /api/runs/{id}/nodes/{name}/state 载荷：单节点可变状态（LLM 链审计——
 *  _prompt/_llm_raw/_usage/_llm_calls 等；节点未执行 → found=false + available 清单）。 */
export interface NodeStatePayload {
  run_id: string;
  node: string;
  path: string;
  tick: number | null;
  found: boolean;
  value: Record<string, unknown> | null;
  available: string[] | null;
}

export const fetchNodeState = (runId: string, node: string) =>
  getJson<NodeStatePayload>(
    `/api/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(node)}/state`,
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
  /** phase=running 也放行（进程被终止后的残留 running 态） */
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

// ------------------------------------------------------------------
// 控制面补齐：预检 / terminate / 检查点创建
// ------------------------------------------------------------------

export interface PreflightResult {
  target: string | null;
  target_tick: number | null;
  executed_nodes: string[];
  hard_errors: string[];
  warnings: string[];
}

export const postPreflight = (runId: string, body: {
  module?: string | null;
  target?: string | null;
  tasklist?: Record<string, unknown> | null;
}) =>
  postJson<PreflightResult>(
    `/api/runs/${encodeURIComponent(runId)}/resume/preflight`, body);

export const postTerminate = (runId: string) =>
  postJson<{ run_id: string; terminated: boolean; pid: number | null }>(
    `/api/runs/${encodeURIComponent(runId)}/process/terminate`, {});

export const postCheckpoint = (
  runId: string, body: { label: string; tick?: number | null },
) =>
  postJson<{ label: string; tick: number; overwritten: boolean }>(
    `/api/runs/${encodeURIComponent(runId)}/checkpoints`, body);

// ------------------------------------------------------------------
// 模块构建器：组件库 / 草稿 / 组装安装
// ------------------------------------------------------------------

export type LibraryKind =
  | "harnesses" | "commands" | "scripts" | "guards" | "submodules" | "drafts";

export interface LibraryIndex {
  harnesses: string[];
  commands: string[];
  scripts: string[];
  guards: string[];
  submodules: { name: string; added_at: string }[];
  drafts: string[];
}

export const fetchLibrary = () => getJson<LibraryIndex>("/api/library");

/** 单组件详情：harness/command = 配置 JSON；scripts/guards = {name, code}；draft = 草稿 */
export const fetchLibraryItem = (kind: LibraryKind, name: string) =>
  getJson<Record<string, unknown>>(
    `/api/library/${kind}/${encodeURIComponent(name)}`);

export const putLibraryJson = (kind: LibraryKind, name: string, payload: unknown) =>
  request<{ saved: boolean }>(`/api/library/${kind}/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

/** 上传代码（scripts/guards）：raw body UTF-8 文本，stem = 注册函数名 */
export const putLibraryCode = (kind: LibraryKind, name: string, code: string) =>
  request<{ saved: boolean }>(`/api/library/${kind}/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "text/x-python" },
    body: code,
  });

export const deleteLibraryItem = (kind: LibraryKind, name: string) =>
  request<{ deleted: boolean }>(`/api/library/${kind}/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });

// 组件库变更通知：侧栏组件库增删改后广播（window 事件，无共同父级的双实例解耦）——
// ModuleBuilder 等在开消费方监听后重拉清单，不必重开页签。对齐 runs 列表「事件钩子」思路。
export const LIBRARY_CHANGED = "specmodule:library-changed";
export const notifyLibraryChanged = () => window.dispatchEvent(new Event(LIBRARY_CHANGED));
export function onLibraryChanged(cb: () => void): () => void {
  window.addEventListener(LIBRARY_CHANGED, cb);
  return () => window.removeEventListener(LIBRARY_CHANGED, cb);
}

export interface BuilderMeta { name: string; version: string; description: string }

export type SpecTypeName = "str" | "int" | "float" | "bool" | "list" | "dict" | "any";
export interface SpecField { field: string; type: SpecTypeName }

export type BuilderNodeType = "harness" | "script" | "command" | "submodule";

export interface BuilderNode {
  id: string;
  /** = tasklist 任务名（Flow 引用名，标识符） */
  label: string;
  type: BuilderNodeType;
  harness?: string; script?: string; command?: string; submodule?: string;
  is_start: boolean;
  join: "AND" | "OR";
  position: { x: number; y: number };
  inputs: Record<string, string>;
  /** harness/command 节点的 TaskDefinition 逐项覆盖 */
  overrides?: Record<string, unknown>;
  /** submodule 输出映射 {本节点字段: 子输出字段} */
  outputs?: Record<string, string>;
}

export interface BuilderEdge { id: string; from: string; to: string; guard: string | null }

export interface BuilderDraft {
  meta: BuilderMeta;
  spec_schema: SpecField[];
  default_spec: Record<string, unknown>;
  /** output 侧 schema 透传（外部 pack 反解保全；UI 不编辑） */
  spec_schema_output?: Record<string, string>;
  nodes: BuilderNode[];
  edges: BuilderEdge[];
  updated_at?: string;
}

export const emptyDraft = (name: string): BuilderDraft => ({
  meta: { name, version: "0.1.0", description: "" },
  spec_schema: [],
  default_spec: {},
  nodes: [],
  edges: [],
});

export const fetchDraft = (name: string) =>
  fetchLibraryItem("drafts", name) as unknown as Promise<BuilderDraft>;

export const putDraft = (d: BuilderDraft) => putLibraryJson("drafts", d.meta.name, d);

export const deleteDraft = (name: string) => deleteLibraryItem("drafts", name);

export interface ValidatePackResult {
  ok: boolean;
  manifest: Record<string, unknown>;
  tasklist: { Tasks: Record<string, unknown>; Flow: string };
}

export const validatePack = (draftName: string) =>
  postJson<ValidatePackResult>("/api/modules/packs/validate", { draft: draftName });

export const installPack = (draftName: string) =>
  postJson<ModuleDetail>("/api/modules/packs", { draft: draftName });

/** 节点类型 → 草稿引用字段（builder/NodePanel 与画布共用） */
export const NODE_REF_FIELD: Record<BuilderNodeType, keyof BuilderNode> = {
  harness: "harness", script: "script", command: "command", submodule: "submodule",
};

/** 生成短随机 id（节点 n_xxx / 边 e_xxx） */
export const genId = (prefix: string) =>
  `${prefix}_${Math.random().toString(36).slice(2, 8)}`;

// ── 已装模块编辑（反解 + 同名更新）──────────────────────────────────

export interface DecompileReport {
  imported: string[];  // 组件库新建（kind/name）
  existed: string[];   // 库中已有且内容一致
  conflicts: string[]; // 同名异内容——沿用库版本
  warnings: string[];  // submodule 未安装等组装前须知
}
export interface DecompileResult { draft: string; report: DecompileReport }

export const decompileModule = (name: string) =>
  postJson<DecompileResult>(`/api/modules/${encodeURIComponent(name)}/decompile`, {});

export const updatePack = (draftName: string) =>
  postJson<ModuleDetail>("/api/modules/packs/update", { draft: draftName });

// ── entry 模块转化（转 packed 后接入编辑闭环）────────────────────────

export interface ConvertResult { module: ModuleDetail; warnings: string[] }

export const convertModule = (name: string, template?: string) =>
  postJson<ConvertResult>(
    `/api/modules/${encodeURIComponent(name)}/convert`,
    template ? { template } : {},
  );

export async function fetchRunArtifacts(
  runId: string,
): Promise<RunArtifactsPayload> {
  return getJson<RunArtifactsPayload>(
    `/api/runs/${encodeURIComponent(runId)}/artifacts`,
  );
}
