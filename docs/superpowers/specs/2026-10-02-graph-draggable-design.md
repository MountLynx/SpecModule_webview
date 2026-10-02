# 运行图节点拖动持久化（设计定稿）

> 2026-10-02 定稿。用户指令核心：**画布中的元素都可被拖动**。方案问答收敛：
> 位置覆盖表（官方 React Flow 标准模式在本仓库约束下的等价实现）。

## 背景与成因

- **构建器画布（EditableCanvas）无此问题**：`onNodeDrag` 全程把位置回写 draft，
  拖动天然持久——官方受控模式（`onNodesChange`/`applyNodeChanges`）的同款变体。
- **运行图（GraphView）拖动是「假拖」**：`nodes` memo 从 dagre 布局推导位置，
  依赖里有 `status`/`selected`——WS 推送（运行中高频）、点选节点都会触发整图
  位置重算，刚拖开的节点立刻弹回；溯源值卡显式 `draggable: false`；产物卫星卡
  同样弹回。
- 成熟库参照（reactflow.dev 官方 dagre 示例 "static layouting" + layouting
  学习页）：**布局只按图结构计算，拖动位置作为状态由拖动回调写回；数据推送
  永远不触发重排**。官方示例注释直言 "If the nodes or edges in the graph
  change, the layout won't recalculate!"。GraphView 现状恰是反模式（每次推送
  重排）。

## 设计

GraphView 节点由 WS payload 全量派生（纯覆盖纪律），不能把位置所有权整体交给
流内部状态——官方模式的等价实现 = **结构键控的 dagre 基准 + 用户覆盖表**：

1. **基准布局 `basePos`**：`layoutGraphSized` 结果按**结构内容键**（run_id +
   module + 节点 id 序 + 边集 + 卫星卡 id 序拼接串）memo 化——status/selected/
   推送不再触发重算；结构不变时沿用缓存（键控即内容指纹）。
2. **覆盖表 `overrides`**（`useState<Map<nodeId, {x,y}>>`）：`onNodeDrag` 全程
   实时写（拖拽跟手，防中途 WS 推送弹回——构建器已验证的同款模式）、
   `onNodeDragStop` 兜底；节点组装时位置 = `overrides.get(id) ?? basePos.get(id)`。
3. **三类元素全部可拖**：状态节点（本就可拖，只是站不住）、卫星产物卡（未禁拖，
   站不住）、溯源值卡（移除 `draggable: false`）。
4. **失效语义**：换 run / 换 module（`payload.run_id`/`payload.module` 变化）→
   清空覆盖表回 dagre；trace 变化 → 只清值卡自身覆盖（卡锚点语义随消费/上游
   节点走，卡的有效位置用覆盖后坐标锚定）；**同 run 内结构变化（新产物卡上图）
   不清用户已拖位置**（与官方 static 语义的唯一偏差——运行中排好的布局不被
   冲掉，已确认采纳）；「重置布局」按钮清空覆盖表。
5. **重置布局按钮**：左上角与跟随按钮同排，仅在有覆盖时出现（`overrides.size > 0`）。

## 边界与不变量

- 拖动不解锁跟随（`onMoveStart` 只感应视图移动）；拖动中的节点被跟随镜头带动
  属预期。
- `measured` 带回纪律不变——拖动引发的高频重渲染沿用既有防 WS 采纳重置机制
  （构建器同款开销，规模无虞）。
- 产物卡 `selectable: false` 不影响拖动（RF v12 拖动与选中独立）。
- 不动 WS 协议、不动服务端、不引新依赖、不动构建器画布。

## 验收

- `npm run build`（tsc --noEmit + vite build）过。
- 浏览器实证：拖动状态节点/产物卡/值卡在 WS 推送与点选后不弹回；换 run 回
  dagre；重置布局按钮出现/消失与清位正确。
