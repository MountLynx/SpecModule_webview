/**
 * git 图式树布局 —— 纯函数。
 *
 * 行序 = seq 序（追加序，新消息在底部）。lane 分配规则：
 * - 根（含叶子链起点、孤儿兜底）取最低空闲 lane
 * - 首子继承父 lane（主干延续）；其余子节点（新枝）取「最低空闲且 ≠ 父 lane」
 * - lane 占用至该 lane 上链条的末端（chainEnd = 只沿首子链延伸），过后释放复用
 */
import type { Node } from "./types";

export const ROW_H = 44;
export const LANE_W = 22;
export const X0 = 22;
/** 节点圆点半径 */
export const DOT_R = 5;

export interface LayoutNode {
  seq: number;
  row: number;
  lane: number;
  x: number;
  y: number;
}

export interface Edge {
  from: { x: number; y: number };
  to: { x: number; y: number };
  /** lane 是否变化（决定直线/贝塞尔曲线） */
  curve: boolean;
}

export interface TreeLayout {
  nodes: LayoutNode[];
  edges: Edge[];
  laneCount: number;
  height: number;
}

export function layoutTree(nodes: Node[]): TreeLayout {
  const sorted = [...nodes].sort((a, b) => a.seq - b.seq);
  const bySeq = new Map(sorted.map((n) => [n.seq, n]));
  const children = new Map<number, Node[]>();
  for (const n of sorted) {
    if (n.parent !== null && bySeq.has(n.parent)) {
      const list = children.get(n.parent) ?? [];
      list.push(n);
      children.set(n.parent, list);
    }
  }
  const firstKid = new Map<number, number>(); // parent → 首子 seq
  for (const [parent, kids] of children) firstKid.set(parent, kids[0].seq);

  // lane 上链条的末端：只沿首子链延伸（链终即 lane 释放点）
  const chainMemo = new Map<number, number>();
  const chainEnd = (seq: number): number => {
    const memo = chainMemo.get(seq);
    if (memo !== undefined) return memo;
    const fk = firstKid.get(seq);
    const end = fk !== undefined ? chainEnd(fk) : seq;
    chainMemo.set(seq, end);
    return end;
  };

  const laneUntil = new Map<number, number>();
  const takeFreeLane = (seq: number, exclude?: number): number => {
    let lane = 0;
    while (lane === exclude || (laneUntil.get(lane) ?? -1) >= seq) lane++;
    return lane;
  };

  const out: LayoutNode[] = [];
  const edges: Edge[] = [];
  let maxLane = 0;

  sorted.forEach((n, row) => {
    let lane: number;
    let parentPos: LayoutNode | undefined;
    if (n.parent !== null) parentPos = out.find((p) => p.seq === n.parent);
    if (!parentPos) {
      lane = takeFreeLane(n.seq); // 根 / 叶子链起点 / 孤儿兜底
    } else if (firstKid.get(n.parent!) === n.seq) {
      lane = parentPos.lane; // 首子：主干延续
    } else {
      lane = takeFreeLane(n.seq, parentPos.lane); // 新枝
    }
    laneUntil.set(lane, chainEnd(n.seq));
    maxLane = Math.max(maxLane, lane);

    const y = row * ROW_H + ROW_H / 2;
    const x = X0 + lane * LANE_W;
    if (parentPos) {
      edges.push({
        from: { x: parentPos.x, y: parentPos.y },
        to: { x, y },
        curve: parentPos.lane !== lane,
      });
    }
    out.push({ seq: n.seq, row, lane, x, y });
  });

  return {
    nodes: out,
    edges,
    laneCount: maxLane + 1,
    height: sorted.length * ROW_H,
  };
}
