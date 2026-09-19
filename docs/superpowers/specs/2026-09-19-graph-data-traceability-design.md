# 图上数据溯源（输入胶囊定位 + spec/上游值卡）设计

- 日期：2026-09-19
- 状态：已与用户逐项确认（浮现形态=按需 / 位置=B 镜头飞到消费节点旁 / 上游胶囊统一到消费节点 + 数据流虚线）；2026-09-19 修订：**删除 NodePanel 侧栏内联「输入值」卡片**——图上值卡已承载接线语义与值展示，侧栏卡片重复多余；2026-09-19 二次修订：**上游值卡改落在数据流路径上**——卡顶虚线接上游节点底、卡底虚线接消费节点顶，溯源期间隐藏原上游→消费控制流实线
- 决策过程：brainstorm 视觉伴侣（`.superpowers/brainstorm/2036-1789817810/content/spec-card-placement.html`）
- 范围：仅 `web/` 前端；后端与 specmodule 库零改动、无新依赖

## 1. 目标与非目标

**目标**：统一交互模型——**点节点面板里可定位的输入胶囊（`{spec.key}` / 裸节点名）= 镜头飞到消费节点旁 → 浮现该输入的值卡 → 虚线指认数据从哪来**。`{spec.key}` 与上游节点输出两类引用同模型、同一卡片语言。

**非目标**：不做常驻 spec 图元素；不改 dagre 布局；不画全量数据流边（控制流图语义不变）；不做 `{spec}`/`{tasklist}`/`{node}` 整体 token 的卡片；不在前端重实现引用解析语义；**不保留 NodePanel 侧栏内联「输入值」卡片**（随本设计删除——图上值卡已承载值展示与接线语义，侧栏重复多余）。

## 2. 引用语法（库侧事实，本设计的依据）

`TaskDefinition.inputs` 的值只有两类可定位形态（`../SpecModule/module_harness/orchestrate/graph_builder.py:24-32`、`example/academic_writer.py:199-243`）：

| 形态 | 例 | 语义 |
|---|---|---|
| `{spec.key}` | `"{spec.raw_text}"` | 常量引用，库建图期对 spec 字典单层键查找 |
| 裸节点名 | `"Organize"`、`"Loop1"` | producer 引用（具名 bind），字段吃该上游节点的整个输出 |
| 其他 | `"{spec}"`/`"{tasklist}"`/`"{node}"`、字面量 | 整体 token / 字面量，不做定位 |

webview 只做**展示层映射**（两形态判断 + 卡片展示时按单层键取值），spec 原文来自 `GET /api/runs/{id}/inputs`（`fetchInputs` 已有），上游输出来自 status `outputs`（与 NodePanel 输出卡同源）。

## 3. 交互规格

### 3.1 交互矩阵

| 胶囊值 | 镜头 | 值卡 | 虚线 |
|---|---|---|---|
| `{spec.key}` | 飞到消费节点（胶囊所属节点） | 卡锚定消费节点右侧，正文 = spec 实际值 | specCard ↔ 消费节点（dashed、无箭头） |
| 裸节点名 | 同上（**不飞去上游**） | 卡锚定消费节点右侧，正文 = 上游节点最新输出 | 上游节点 → 消费节点（dashed、小箭头指消费） |
| 其他 | 不动 | 无——普通胶囊不可点（hover 仍见完整 JSON；内联「输入值」卡片已删除） | 无 |

同一时间只有一张值卡（点另一胶囊即切换）；收起三通道：卡上 ✕ / 点击画布空白 / 再点同一胶囊。胶囊 emphasis 只跟随溯源态（当前溯源中的来源胶囊保持 emphasis）；「其他」类胶囊不参与，无卡片语义。

### 3.2 值卡（React Flow 临时节点，新 nodeType `dataCard`）

- 位置（2026-09-19 二次修订）：spec 卡 = 消费节点右侧固定偏移；上游卡 = 上游节点与消费节点缺口右侧、垂直居中于缺口——卡顶接上游底、卡底接消费顶，值卡落在数据流路径上（图坐标，随缩放平移；不参与 dagre）
- 结构：头部 = 来源标识（spec 卡 `spec.<key>`；上游卡 `<上游节点> → <字段名>`）+ ✕ 关闭；正文 = 值（mono、卡整体固定 240×180 正文区滚动、`break-all`、`nowheel` 防滚轮缩放画布）（2026-09-19 终审修订：原 `max-h-[240px]` 落地为固定卡尺寸）
- 视觉：B 语言中性卡（`border-border` + 头部 `bg-secondary` + 阴影 `shadow-[0_6px_24px_...]` 抬升层次区别于图上节点）；亮暗主题走既有变量
- 回退：spec 无存档或字段缺失 → 正文显示引用串原文 + 尾注「（无存档值）」；上游尚无输出（`outputs[id] === undefined`）→「（尚无输出）」

### 3.3 数据流虚线（React Flow 临时边）

- spec 卡：`dataCard → 消费节点`，dashed、中性色、无箭头
- 上游卡（2026-09-19 二次修订）：两段虚线代替原「上游直连消费」单段——`上游节点底 → 卡顶`、`卡底 → 消费节点顶`，dashed、中性色（`hsl(var(--foreground) / 0.28)` 同默认边）、每段带小箭头（MarkerType.ArrowClosed）指流向；**溯源期间隐藏原上游→消费控制流实线**（由卡 + 两段虚线承接其视觉，收起即恢复）

### 3.4 镜头与状态

- 飞行复用 `centerOn`（fitView nodes 含消费节点 + 卡片节点，上游溯源另含上游节点使整条接线路径可见；padding ≥0.3 容纳卡片；fitLock 既有防误判机制）
- 飞行后跟随态置「已解锁」（与手动交互语义一致，F/按钮可再跟随）
- NodePanel 切节点（key 重挂载）或 RunView 切 run：临时节点/边无残留（溯源状态归零）

## 4. 组件与数据流

- **RunView**：随 runId 拉一次 `fetchInputs` 缓存 spec（null 容忍）；持有溯源状态 `trace: { consumerId: string; source: { kind: "spec"; key: string } | { kind: "node"; nodeId: string } } | null`；把 `onTraceInput(field, value)` 注入 NodePanel、把 `trace` + spec 注入 GraphView
- **NodePanel**：输入胶囊 onClick 上报（仅可定位类——`resolveInputSource` 判定非 null 才可点）；**现内联「输入值」卡片整块删除**（`openInput` 状态与对应 JSX 移除，「其他」类值不再有侧栏卡片）；胶囊激活强调态跟随 trace（当前溯源中的来源胶囊保持 emphasis）
- **GraphView**：`nodes`/`edges` useMemo 叠加临时 `dataCard` 节点与虚线边（trace 非空时）；`nodeTypes` 注册 `dataCard`；trace 变化即 centerOn 消费节点+卡片
- **来源判定**：纯函数 `resolveInputSource(value: string, nodeIds: Set<string>): { kind: "spec"; key: string } | { kind: "node"; nodeId: string } | null`——`{spec.` 前缀且 `}` 结尾 → spec（取中段）；值 ∈ nodeIds → node；否则 null。放 `web/src/lib/inputSource.ts`（独立小模块，供 NodePanel 判定是否可点与 GraphView 渲染共用）
- `api.ts` 无新端点、无类型变更

## 5. 边界与回退汇总

1. run 无 spec 存档（`inputs.spec == null`）或字段缺失 → 值卡显示引用串 +「（无存档值）」，虚线/飞行照常（来源仍是 spec 卡）
2. 上游节点尚无输出 → 「（尚无输出）」
3. `{spec}`/`{tasklist}`/`{node}` 整体 token、字面量 → `resolveInputSource` 返回 null，胶囊为普通样式不可点（不参与 emphasis 溯源态；hover 仍见完整 JSON，无卡片）
4. 消费节点不在当前图（moduleOverride 换模块后引用节点名失配）→ 按 3 回退（nodeIds 匹配失败即 null）
5. 卡片打开期间 WS 推送 outputs 更新 → 值卡随渲染更新（状态同源，无需订阅）

## 6. 验收

1. `cd web && npm run build` 通过
2. academic_writer run：点 Loop1 的 `original_text`（值 `{spec.raw_text}`）→ 镜头飞 Loop1、右侧浮 spec 值卡显示草稿原文、卡↔节点虚线；点 `draft_text`（值 `Organize`）→ 镜头仍飞 Loop1、卡显示 Organize 输出 JSON、原 Organize→Loop1 实线隐藏、两段虚线 Organize 底→卡顶→Loop1 顶带箭头
3. 三通道收起生效；点胶囊切换无叠卡；切节点/切 run 无残留
4. 亮暗双主题目测值卡与虚线可辨
5. 回退路径抽查：`{spec}` 整体 token（如有）胶囊不可点、无卡片浮现；侧栏不再出现内联「输入值」卡片

## 7. 实施切分建议（供 writing-plans 展开）

① `lib/inputSource.ts` 纯函数 → ② NodePanel 胶囊上报/emphasis 联动 + 内联值卡删除 + RunView 溯源状态 → ③ GraphView `dataCard` nodeType 与临时边渲染 + RunView spec 缓存/飞行接线 → ④ 走查（亮暗/回退/收起/无内联卡残留）。
