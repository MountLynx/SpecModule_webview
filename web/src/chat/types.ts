/** 会话摘要（枚举条目） */
export interface SessionSummary {
  sid: string;
  name: string;
  category: string;
  archived: boolean;
  nodeCount: number;
  createdAt: string;
  mtimeMs: number;
}

/** 轮次节点（一问一答；id = seq 稳定可引用）。output = null 悬而未答 */
export interface Node {
  seq: number;
  parent: number | null;
  input: string;
  output: string | null;
  label: string;
  model: string;
  /** 本轮实际使用的模式 key（空 = 会话默认；grilling 会话里的直答插轮可见） */
  module: string;
}

/** 上下文产出卡片（ownerSeq=null 全局卡 / 非空节点卡） */
export interface Card {
  id: string;
  title: string;
  body: string;
  fromPath: number[];
  instruction: string;
  createdAt: string;
  pinned: boolean;
  ownerSeq: number | null;
  /** 非空 = 模块文档版本节点卡（沿路径取最近祖先版本） */
  docKey: string;
}

/** 完整会话状态（后端全量返回） */
export interface ConvState {
  sid: string;
  name: string;
  system: string;
  category: string;
  archived: boolean;
  pointer: number | null;
  trunkEnd: number | null;
  unanswered: number | null;
  nodes: Node[];
  cards: Card[];
}

export interface Health {
  ok: boolean;
  llmConfigured: boolean;
  dataDir: string;
}

/** 跨会话卡库条目（GET /api/cards；只含全局卡，复制导入语义） */
export interface LibraryCard {
  sid: string;
  sessionName: string;
  id: string;
  title: string;
  body: string;
  fromPath: number[];
  instruction: string;
  createdAt: string;
  pinned: boolean;
}

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

/** node_end 的文档引用（链接片） */
export interface CardRef {
  type: "doc";
  docKey: string;
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
  /** 思考通道累计文本（thinking 帧；正文到达后 UI 自动收起） */
  thinking: string;
  outcome: "running" | "ok" | "failed";
  refs: CardRef[];
}

/** path_to(pointer)：指针所在活跃路径（根 → 指针节点） */
export function activePath(conv: ConvState): Node[] {
  const bySeq = new Map(conv.nodes.map((n) => [n.seq, n]));
  const path: Node[] = [];
  let cur: number | null = conv.pointer;
  while (cur !== null) {
    const n = bySeq.get(cur);
    if (!n) break;
    path.unshift(n);
    cur = n.parent;
  }
  return path;
}

/** seq → 引用文本（#12 风格） */
export function nodeRef(seq: number | null): string {
  return seq === null ? "—" : `#${seq}`;
}
