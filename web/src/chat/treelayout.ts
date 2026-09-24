/**
 * git 图式树布局 —— 纯函数。
 *
 * 行序 = 距起点的远近（非发生时间）：每棵树按 BFS 深度分块（同块内按父节点出现序 + seq 稳定），
 * 多棵树（parent=null 起链；父缺失/成环的孤儿按 seq 兜底各自成树）按根 seq 顺序拼接，
 * 树间留半行间隔。晚发生但从早期节点分出的分支因此落在与原同级分支相邻的行——母边跨行短，
 * 不会为「越晚越靠下」拉出横穿全图的长线（那正是连线重叠的根源）。每行仍只放一个节点。
 *
 * lane 分配（行空间占用制，每棵树重置）：
 * - 根链（首子链）走 lane 0；首子继承父 lane（家族链延续）；新枝取 > 父 lane 的最低可用 lane（只向右）
 * - lane 被一个分支家族从其起点行占用至首子链末端行（chainEndRow），过后释放复用；
 *   同 lane 的行区间互不重叠 ⇒ 竖直连线不穿别家节点
 *
 * 连线：同 lane = 直线；跨 lane = 三次贝塞尔（两条水平控制线取同一高度，默认跨行中点）。
 * 若走廊穿过节点圆点或与已有连线中部重合，则就地上下搜清障高度，仍不行则换更右 lane 重试；
 * 贴共享端点竖直列的短共线段是分叉常态（git 图同款形态），不作违规。
 */
import type { Node } from "./types";

export const ROW_H = 44;
export const LANE_W = 26;
export const X0 = 22;
/** 节点圆点半径 */
export const DOT_R = 5;
/** 树与树之间的垂直间隔（px） */
export const TREE_GAP = ROW_H / 2;

/** 曲线须与圆点保持的净距（DOT_R + 线宽/2 + 余量） */
const DOT_CLEAR = DOT_R + 2.5;
/** 连线彼此近似重合判定：连续贴近采样数 × 距离阈值。
 *  阈值取窄：只抓长距并行贴近（真重合），放行十字交叉（交叉处贴近弧长仅数 px） */
const EDGE_CLEAR = 2.8;
const EDGE_RUN = 4;
/** 清障豁免：贴共享端点竖直列的判定宽度 */
const COL_EPS = 4;
/** 贝塞尔采样数（清障检查用） */
const SAMPLES = 28;
/** 新枝 lane 搜索上限（父 lane 之上再右几列） */
const LANE_SEARCH = 6;

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
  /** 贝塞尔两条水平控制线的 y（直线边不用，取端点中点占位） */
  ctrl: number;
}

export interface TreeLayout {
  nodes: LayoutNode[];
  edges: Edge[];
  laneCount: number;
  height: number;
  /** 行标签统一缩进（最右 lane 圆点右侧留白）：连线全部留在标签左边的图区，不压行文字 */
  gutter: number;
}

interface Pt {
  x: number;
  y: number;
}

function sampleBezier(x0: number, y0: number, x1: number, y1: number, cy: number): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    const u = 1 - t;
    pts.push({
      x: u * u * u * x0 + 3 * u * u * t * x0 + 3 * u * t * t * x1 + t * t * t * x1,
      y: u * u * u * y0 + 3 * u * u * t * cy + 3 * u * t * t * cy + t * t * t * y1,
    });
  }
  return pts;
}

function sampleLine(a: Pt, b: Pt): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    pts.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return pts;
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

  // ── 1) 行序：每棵树 BFS（子按 seq 序入队），根按 seq 序；成环残留各自成树兜底 ──
  const visited = new Set<number>();
  const order: Node[] = [];
  const heads: number[] = [];
  const walkTree = (head: Node) => {
    if (visited.has(head.seq)) return;
    heads.push(head.seq);
    visited.add(head.seq);
    const queue: Node[] = [head];
    for (let qi = 0; qi < queue.length; qi++) {
      const n = queue[qi];
      order.push(n);
      for (const kid of children.get(n.seq) ?? []) {
        if (!visited.has(kid.seq)) {
          visited.add(kid.seq);
          queue.push(kid);
        }
      }
    }
  };
  for (const n of sorted) if (n.parent === null || !bySeq.has(n.parent)) walkTree(n);
  for (const n of sorted) walkTree(n);
  const headSet = new Set(heads);

  // ── 2) 行号 + y（树间留 TREE_GAP） ──
  const rowOf = new Map<number, number>();
  const yOf = new Map<number, number>();
  let treeIdx = 0;
  order.forEach((n, row) => {
    if (row > 0 && headSet.has(n.seq)) treeIdx++;
    rowOf.set(n.seq, row);
    yOf.set(n.seq, row * ROW_H + ROW_H / 2 + treeIdx * TREE_GAP);
  });

  // ── 3) 首子链末端行 = lane 占用区间终点（首子链是 BFS 树的子链，无环） ──
  const endMemo = new Map<number, number>();
  const chainEndRow = (seq: number): number => {
    const memo = endMemo.get(seq);
    if (memo !== undefined) return memo;
    const fk = firstKid.get(seq);
    const end = fk !== undefined ? chainEndRow(fk) : rowOf.get(seq)!;
    endMemo.set(seq, end);
    return end;
  };

  // ── 4) lane 分配（行空间占用 + 走廊清障）+ 坐标 + 边 ──
  const laneUntil = new Map<number, number>(); // lane → 占用至（含）某行
  const isFree = (lane: number, row: number): boolean =>
    (laneUntil.get(lane) ?? -1) < row;
  const laneX = (lane: number) => X0 + lane * LANE_W;

  const posBySeq = new Map<number, LayoutNode>();
  const out: LayoutNode[] = [];
  const edges: Edge[] = [];
  const dots: { x: number; y: number; seq: number }[] = []; // 已落点圆点（清障障碍物）
  const edgeGeoms: { poly: Pt[]; from: Pt; to: Pt }[] = []; // 已有连线采样（清障障碍物）
  let maxLane = 0;

  /** 曲线是否穿点（自身端点除外） */
  const clearOfDots = (pts: Pt[], fromSeq: number, toSeq: number): boolean =>
    pts.every((p) =>
      dots.every((d) => {
        if (d.seq === fromSeq || d.seq === toSeq) return true;
        const dx = d.x - p.x;
        const dy = d.y - p.y;
        return dx * dx + dy * dy >= DOT_CLEAR * DOT_CLEAR;
      }),
    );

  /** 曲线是否与已有连线中部重合（贴共享端点竖直列的短共线段豁免——分叉常态） */
  const hitsEdge = (pts: Pt[], from: Pt, to: Pt): boolean => {
    for (const g of edgeGeoms) {
      const yMin = Math.min(g.from.y, g.to.y) - EDGE_CLEAR;
      const yMax = Math.max(g.from.y, g.to.y) + EDGE_CLEAR;
      const xMin = Math.min(g.from.x, g.to.x) - EDGE_CLEAR;
      const xMax = Math.max(g.from.x, g.to.x) + EDGE_CLEAR;
      if (pts.every((p) => p.y < yMin || p.y > yMax || p.x < xMin || p.x > xMax)) continue;
      const shared: Pt[] = [];
      for (const a of [from, to])
        for (const b of [g.from, g.to])
          if (Math.hypot(a.x - b.x, a.y - b.y) < 0.5) shared.push(a);
      const lo = Math.min(g.from.y, g.to.y) - 1;
      const hi = Math.max(g.from.y, g.to.y) + 1;
      let run = 0;
      for (const p of pts) {
        if (shared.some((c) => Math.abs(p.x - c.x) < COL_EPS && p.y >= lo && p.y <= hi)) continue;
        let near = false;
        for (const q of g.poly) {
          const dx = q.x - p.x;
          const dy = q.y - p.y;
          if (dx * dx + dy * dy < EDGE_CLEAR * EDGE_CLEAR) {
            near = true;
            break;
          }
        }
        run = near ? run + 1 : 0;
        if (run >= EDGE_RUN) return true;
      }
    }
    return false;
  };

  /** 就近搜清障控制带：默认跨行中点，向上下每 11px 一步，限制在两端点之间 */
  const pickCtrl = (
    x0: number, y0: number, x1: number, y1: number, fromSeq: number, toSeq: number,
  ): number | null => {
    const mid = (y0 + y1) / 2;
    const steps = Math.ceil((y1 - y0) / 2 / 11);
    for (let k = 0; k <= steps; k++) {
      for (const cy of k === 0 ? [mid] : [mid + 11 * k, mid - 11 * k]) {
        if (cy < y0 + 4 || cy > y1 - 4) continue;
        const pts = sampleBezier(x0, y0, x1, y1, cy);
        if (!clearOfDots(pts, fromSeq, toSeq) || hitsEdge(pts, { x: x0, y: y0 }, { x: x1, y: y1 }))
          continue;
        return cy;
      }
    }
    return null;
  };

  for (const n of order) {
    const row = rowOf.get(n.seq)!;
    const y = yOf.get(n.seq)!;
    let lane = 0; // 三个分支（树头/首子/新枝）必赋值；此初值仅过 TS definite-assignment
    let ctrl: number | null = null;
    let parentPos: LayoutNode | undefined;
    if (headSet.has(n.seq)) {
      laneUntil.clear(); // 每棵树重置：新主干回 lane 0
      lane = 0;
    } else {
      parentPos = posBySeq.get(n.parent!)!;
      if (firstKid.get(n.parent!) === n.seq) {
        lane = parentPos.lane; // 首子：家族链延续（父链占用已覆盖其行区间）
      } else {
        // 新枝：> 父 lane 的最低可用 lane；走廊清不了障时逐列右移重试
        let picked = false;
        for (let cand = parentPos.lane + 1; cand <= parentPos.lane + LANE_SEARCH; cand++) {
          if (!isFree(cand, row)) continue;
          const cy = pickCtrl(parentPos.x, parentPos.y, laneX(cand), y, parentPos.seq, n.seq);
          if (cy !== null) {
            lane = cand;
            ctrl = cy;
            picked = true;
            break;
          }
        }
        if (!picked) {
          // 兜底：首个空闲 lane + 中点控制带（清障尽力而为）
          lane = parentPos.lane + 1;
          while (!isFree(lane, row)) lane++;
          ctrl = (parentPos.y + y) / 2;
        }
      }
    }
    laneUntil.set(lane, chainEndRow(n.seq));
    maxLane = Math.max(maxLane, lane);

    const x = laneX(lane);
    if (parentPos) {
      const curve = parentPos.lane !== lane;
      const c = curve ? ctrl! : (parentPos.y + y) / 2;
      edges.push({
        from: { x: parentPos.x, y: parentPos.y },
        to: { x, y },
        curve,
        ctrl: c,
      });
      edgeGeoms.push({
        poly: curve ? sampleBezier(parentPos.x, parentPos.y, x, y, c) : sampleLine(parentPos, { x, y }),
        from: { x: parentPos.x, y: parentPos.y },
        to: { x, y },
      });
    }
    const pos = { seq: n.seq, row, lane, x, y };
    out.push(pos);
    posBySeq.set(n.seq, pos);
    dots.push({ x, y, seq: n.seq });
  }

  const laneCount = maxLane + 1;
  return {
    nodes: out,
    edges,
    laneCount,
    height: order.length * ROW_H + Math.max(heads.length - 1, 0) * TREE_GAP,
    gutter: X0 + Math.max(laneCount - 1, 0) * LANE_W + DOT_R + 8,
  };
}
