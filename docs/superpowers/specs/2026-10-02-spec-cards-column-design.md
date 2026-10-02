# 运行图 spec 值卡常驻列与溯源统一（设计定稿）

> 2026-10-02 定稿。用户指令核心：**运行监控时图上能直接看见 spec 的内容**——
> 在一侧划一片区域存放各个 spec 的值卡，点击值卡出虚线指向其被消费的 node；
> node 侧边栏点输入胶囊时若来源是 spec 不再另出浮卡，直接显示该 spec 值卡与
> 该 node 的虚线。方案问答收敛：展示形态 = 每键一卡常驻（非摘要条、非按需浮卡）；
> 区域形态 = 画布内一列真实节点（非固定 DOM 面板）。

## 背景与成因

- spec 存档已随 run 拉到前端（`RunView` 挂载后 `fetchInputs` → `spec`，经 props
  传入 GraphView 供溯源值卡取值），**数据面零缺口**，问题纯在展示链路。
- 现状唯一可见路径是三级链路：点节点 → NodePanel 找到输入胶囊 → 点 `{spec.key}`
  胶囊 → 弹出临时浮卡（DataCardNode）。埋得太深，且一次只能看一个键、卡随溯源
  消失——监控运行时「这个 run 在干嘛」的上下文不可见。

## 设计

### 1. 数据来源（零后端改动）

spec 已由 `GET /api/runs/{id}/inputs`（`query.read_module_inputs`）暴露并拉取；
本次纯前端。`spec` 为 `Record<string, unknown> | null`。

### 2. 新组件 `SpecCardNode`（`web/src/components/SpecCardNode.tsx`）

- 仿 DataCardNode/ArtifactNode 的第三种图上卡：每个 spec 键一张卡，id
  `specCard::<key>`（id 为不透明串，键含特殊字符无解析风险）。
- 头部 `spec.<key>`（truncate + title），正文 = 该键值（字符串原样、其余 JSON
  化；`spec` 无该键 → `（无存档值）`），mono、`nowheel` 滚动、break-all——
  正文滚动语义与 DataCardNode 同款。
- **常驻卡**：无关闭按钮（区别于溯源浮卡）；trace 命中该键时边框高亮（emphasis）。
- `selectable: false`、点击不进节点面板；可拖动（复用 GraphView 既有 overrides
  机制，拖过位置会话内保留，换 run/module 清空——与全部图上元素同纪律）。
- 右侧隐藏 handle（source）：spec 是数据源，溯源虚线**从卡出**、指入消费节点
  （卡列在左，出线朝图区）。

### 3. 布局：画布内一列（不进 dagre）

- spec 卡**不参与 dagre**（无布局边，进 dagre 会被当作无依赖节点散置）：手动
  定位在 dagre 布局包围盒左侧一列——`x = minX - SPEC_CARD_SIZE.width - 48`，
  `y` 自 `minY` 起纵向堆叠（间距 16）。位置每轮节点组装按同一规则重算，确定性
  等价于缓存；用户拖过的以 overrides 覆盖。
- 随图平移缩放（画布内一列的既定取舍）：图拉远卡跟着远，点卡片/trace 变化的
  镜头飞行负责拉回。
- `measured` 带回纪律同现有三类卡——防 WS 推送采纳重置后虚线边整体消失。

### 4. 溯源交互（核心变化）

- **点 spec 卡**：置 trace = `{ source: {kind:"spec", key}, consumerId: null,
  field: null }`；虚线从该卡指向**所有**消费该键的节点（inputs 值解析为
  `{spec.key}` 引用的全部节点，经 `resolveInputSource` 判定）；镜头飞卡片 +
  全部消费节点；再点同卡收起（toggle，与胶囊同语义）。
- **NodePanel 点 `{spec.key}` 输入胶囊**：不再弹浮卡——高亮左侧已有卡 + 虚线
  卡→该节点（trace = `{source, consumerId: 该节点, field: 胶囊键}`，chip
  emphasis 判定不变）。
- **上游溯源（node 来源）不变**：DataCardNode 浮卡照旧（节点→浮卡→消费节点
  两段虚线）。
- **兜底（旧 run 不劣化）**：spec 无存档（`spec == null`，含 translating 期
  存档未落窗口与旧 run）或键缺失 → 保留现有 DataCardNode spec 浮卡回退分支
  （正文 `（无存档值）`）。即：有卡走卡，无卡走浮卡。
- 单一溯源态不变：任一时刻至多一条 trace；点选节点/画布空白清空（既有语义，
  spec 卡点击不改 selected 故互不干扰）。

### 5. TraceState 扩展

`{consumerId, field}` 允许 `null`（卡直点 = 溯源目标为全部消费节点）；胶囊点入
仍带具体节点。`resolveInputSource` 不动。下游判空处：镜头飞行 ids、虚线边端点、
NodePanel chip emphasis（null 不命中任何 chip，天然成立）。

### 6. 边界与不变量

- `spec` 为 null / 空对象 → 无卡列，画布照旧（零噪音）。
- translating 期存档未落 → 既有补拉逻辑覆盖（RunView spec 缺档兜底 effect
  不动）；卡列在 spec 到位后随渲染出现。
- 键多 → 卡列纵向变长，fitView 自动收纳；**不做折叠/分页**（YAGNI，疼了再开
  issue）。
- MiniMap：spec 卡独立底色（muted 变体，区别于状态/产物/浮卡）。
- 不动 WS 协议、不动服务端、不引新依赖、不动构建器画布、不动上游溯源浮卡。

## 验收

- `npm run build`（tsc --noEmit + vite build）过。
- 浏览器实证（mock run）：spec 各键卡常驻左侧一列；点卡出虚线指全部消费节点、
  再点收起；NodePanel 点 spec 胶囊高亮已有卡 + 单条虚线（不再弹浮卡）；上游
  溯源浮卡照旧；拖动卡不弹回；spec 无存档 run 无卡列、胶囊回退浮卡；亮暗主题
  正常。
