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

/** 消息节点（id = seq，稳定可引用） */
export interface Node {
  seq: number;
  parent: number | null;
  role: "user" | "assistant";
  text: string;
  label: string;
  model: string;
}

/** 上下文产出卡片 */
export interface Card {
  id: string;
  title: string;
  body: string;
  fromPath: number[];
  instruction: string;
  createdAt: string;
  pinned: boolean;
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
  unansweredUser: number | null;
  nodes: Node[];
  cards: Card[];
}

export interface Health {
  ok: boolean;
  llmConfigured: boolean;
  dataDir: string;
}

/** 跨会话卡库条目（GET /api/cards；复制导入语义） */
export type LibraryCard = Card & {
  sid: string;
  sessionName: string;
};

/** 侧边栏页签 */
export type Tab = "chat" | "tree" | "cards" | "settings";

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
