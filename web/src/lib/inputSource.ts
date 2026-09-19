// 输入引用来源判定（图上数据溯源，展示层映射）：`{spec.key}` → spec 常量引用、
// 裸节点名 → 上游 producer 引用；其余（整体 token / 字面量）→ null 不可定位。
// 语法依据：../SpecModule/module_harness/orchestrate/graph_builder.py:24-32。
// NodePanel 判定胶囊可点与 GraphView 渲染值卡共用本模块。

export type InputSource =
  | { kind: "spec"; key: string }
  | { kind: "node"; nodeId: string };

/** 一次溯源：消费节点 + 触发上报的输入字段名 + 来源 */
export interface TraceState {
  consumerId: string;
  field: string;
  source: InputSource;
}

export function resolveInputSource(
  value: string,
  nodeIds: Set<string>,
): InputSource | null {
  if (value.startsWith("{spec.") && value.endsWith("}")) {
    const key = value.slice("{spec.".length, -1);
    if (key) return { kind: "spec", key };
  }
  if (nodeIds.has(value)) return { kind: "node", nodeId: value };
  return null;
}
