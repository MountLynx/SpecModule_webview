# 运行图 spec 值卡虚线分组框（设计定稿）

> 2026-10-03 定稿。用户指令核心：**spec 值卡用虚线框圈一个区域放进去**——
> 卡列与主图之间目前没有视觉分组，多卡堆叠后与图上节点混看；要一片可辨识的
> 「spec 输入区」。方案问答收敛：交互程度 = 纯视觉圈选（框不拦截鼠标、不做
> 组拖动）。

## 背景与成因

- spec 值卡常驻列已落地（2026-10-02 设计）：每键一卡、dagre 包围盒左侧一列、
  逐卡可拖（overrides）。数据链路、溯源交互均已稳定，本次纯展示层增量。
- 现状卡列与主图区零视觉分隔——既无边框也无标识，卡多了之后「这是一组输入」
  的结构感缺失。

## 方案比较（采纳 A）

- **A 背景区域节点（采纳）**：新增一种纯展示 React Flow 节点类型，渲染为圆角
  虚线框 + 标签，几何每轮从 spec 卡有效位置派生、压在卡片下层。改动集中
  GraphView 组装 + 一个新小组件，不触碰 dagre 布局 / 拖动覆盖 / WS 重渲染
  （measured 保留）链路。
- **B React Flow 父子分组（parentId + GroupNode）**：语义正规且白送组拖动；
  但 spec 卡位置体系要从画布绝对坐标改父节点相对坐标，动到拖动覆盖表与
  measured 保留链路，回归风险高——组拖动已明确不做，为用不上的能力付重构成本。
- **C 节点层外 SVG 覆盖层**：需自行同步 pan/zoom 变换与拖动重算，无架构收益。

## 设计

### 1. 范围（零后端改动）

纯前端派生。区域只圈 spec 值卡（`specCard` 节点）；溯源浮卡（dataCard）与
卫星产物卡（artifact）不圈。

### 2. 新组件 `SpecRegionNode`（`web/src/components/SpecRegionNode.tsx`）

- 纯展示：圆角虚线边框（中性淡色，与数据流虚线同族 `hsl(var(--foreground) /
  0.25)` 左右）+ 左上角小标签 `spec 输入`（mono 小号，muted 色，不拦截事件）。
- 无 Handle、无边；`selectable: false`、`draggable: false`；节点 style
  `pointerEvents: "none"`——框所在位置鼠标事件穿透到画布（拖画布/框选照常）。
- 节点 id 常量 `SPEC_REGION_NODE_ID = "specRegion"`（单一实例，不复用不拼键）。

### 3. GraphView 组装

- `specCards.length > 0` 时追加一个 `specRegion` 节点（排在节点数组**最前**：
  React Flow 同 zIndex 按数组序稳定渲染，先排先画 = 底层；自身永不选中故不会
  被 elevate 到卡上）。
- 几何 = 所有 spec 卡**有效位置**（`posOf(specCardNodeId(key))`：基准列或
  overrides 覆盖）+ `SPEC_CARD_SIZE` 求包围盒，四周扩 padding（顶部 ~26 放
  标签、其余 ~14）得 position/width/height（显式设，同其他节点纪律）。
- 派生发生在节点组装 useMemo 内（经 `posOf` 传导）：拖动写 overrides 即重算，
  框实时跟随；`specPos` 身份稳定，无卡时零派生。
- MiniMap：`minimapColor` 对该类型返回透明色，小图不出现灰块。
- 不进 dagre、不进 `structureKey`、不参与溯源镜头飞行 ids；无边 ⇒ 无需
  measured 带回（该纪律只服务于连线端点）。初始 fitView 与「回到当前」自然
  纳入框（fitView 全图语义本就含卡列，含框无差）。

### 4. 拖动与重置语义

- 框无自身状态：几何每轮从有效位置派生——单卡拖动框实时跟随、永远包住所有卡；
  「重置布局」清 overrides 后框随卡回基准列。
- 零新增持久化、零新增覆盖键、零新增交互入口。

### 5. 边界与不变量

- `spec` 为 null / 空对象 → 无卡即无框（与无卡列现状一致）。
- 单卡也圈（框 = 单卡 + padding）。
- 卡拖远 → 框扩展包住（诚实的包围盒；压底层故不会遮挡主图交互）。
- 不动 WS 协议、不动服务端、不引新依赖、不动构建器画布、不动溯源链路。

## 验收

- `npm run build`（tsc --noEmit + vite build）过。
- 浏览器实证（有 spec 存档的 run）：虚线框圈住全部 spec 卡、左上角标签
  `spec 输入`；卡可点（溯源）/可拖，框不拦截画布拖拽与框选；单卡拖动框实时
  跟随；「重置布局」后框回基准列；无 spec 存档 run 无框；MiniMap 无灰块；
  亮暗主题正常。
