# 界面美化（B·状态染色方向）设计

- 日期：2026-09-19
- 状态：已与用户逐项确认（风格方向 / 面板版本 / 胶囊体系 / 图标 / 跟随按钮 / 范围）
- 视觉决策过程：brainstorm 视觉伴侣（`.superpowers/brainstorm/1030-1789778386/content/`，style-direction / node-panel / run-view-composite 三屏）
- 范围：仅 `web/` 前端，后端与库零改动；不新增依赖（lucide-react、tailwindcss-animate 已在 package.json）

## 1. 目标与非目标

**目标**：以「B·状态染色」语言统一全应用——图视图节点/连线状态浸染、NodePanel V2 结构升级、壳层（页签/活动栏/列表）图标与间距统一、chat 轻对齐；建立可复用的设计令牌（状态色三阶、胶囊两态、字号四档、图标映射）。

**非目标**：不动布局结构与信息架构；不做镜头自动回跟；不改 chat 消息结构；不动后端/WS 契约。

## 2. 设计令牌层（index.css + 共享类）

### 2.1 状态色三阶

现有 `--ph-running/done/aborted/cancelled/truncated`（亮暗各一套）保留为主色阶；为每色新增洗淡变体（亮暗各自调好）：

```css
/* 例：亮色 done */
--ph-done: #16a34a;          /* 既有：主色（图标/描边/强调文本） */
--ph-done-bg: #ecfdf3;       /* 新增：节点/卡片浸染底 */
--ph-done-border: #b2e5c3;   /* 新增：浸染态描边 */
/* running/aborted/cancelled/truncated 同构；dark 块同套补齐 */
```

idle 无须变量（白底 + dashed 中性边即可）。所有消费点只引用变量，禁止硬编码色值。

### 2.2 胶囊两态

- 默认：浅描边胶囊（`border + rounded-full + bg-card + text-muted`）
- 选中/强调：primary 反色——亮色黑底白字（`--primary`≈`240 4% 16%`）、暗色白底黑字，由现有 `primary/primary-foreground` 变量驱动
- 状态胶囊（running/done/…）用对应 `--ph-*-bg/border` 着色，**不用** primary 反色（反色只表达"选中"，不表达"状态"）
- 实现为共享组件 `components/ui/pill.tsx`（variants: `default | emphasis | running | done | failed | …`），TabBar 激活页签、RunList 选中行、跟随按钮激活态、NodePanel 状态胶囊统一走它

### 2.3 字号四档

`11`（辅助/mono 元信息）、`12`（正文小）、`13`（正文）、`15`（强调）。消灭 11.5/12.5 等碎阶（Tailwind arbitrary 值统一替换）。`run_id`/`tick`/输出正文保持 mono。

### 2.4 图标映射（lucide-react，线性，12/14 两档）

| 场景 | 图标 |
|---|---|
| 暂停/继续 | Pause / Play |
| 存检查点 | Bookmark |
| 恢复/回退 | RotateCcw |
| 强制结束/终止 | Square（终止） |
| 跟随镜头 | LocateFixed |
| 关闭 | X |
| 复制 | Copy |
| 节点完成/失败/待执行 | Check / X / Circle（运行态用 CSS spinner，不用 Loader 图标） |
| 页签：chat/run/模块 | MessageSquare / Play / LayoutGrid |
| 卡片引用（chat） | FileText（替换现有 📄 emoji） |

chat RunBlock 现有 `✓ ✗ ◌` 字符图标全部替换为 lucide。全应用不再出现字符/emoji 图标。

## 3. 图视图皮肤（GraphView / StatusNode / 边）

### 3.1 节点（StatusNode 重写样式，结构不变）

按 `badgeOf` 结果浸染（合成稿 run-view-composite.html 为基准）：

| 状态 | 底 | 边 | 左侧图标 | 文本 |
|---|---|---|---|---|
| done | `--ph-done-bg` | 1px `--ph-done-border` | Check（`--ph-done`） | `--ph-done` 加深文本色 |
| running | `--ph-running-bg` | 1.5px `--ph-running-border` + 4px 同色 10% 光环 | CSS spinner（border 旋转） | 同色系 |
| failed/aborted | `--ph-aborted-bg` | 1.5px `--ph-aborted-border` | X | 同色系 |
| idle | `card` | 1px dashed 中性 | Circle 空心 | muted |

×N 徽章：半透明白底胶囊、文本随节点状态色。选中态：外圈 2px `--ring` 描边（React Flow selected）。节点尺寸/dagre 布局/Handle 位置不动。

### 3.2 边与画布

- 默认边：保持 React Flow 默认 bezier（不改 edge type），中性色描边 + 小箭头（markerEnd）
- 活跃边（运行中自 fireable 节点出发）：`--ph-running` 描边 + React Flow `animated` 虚线流动
- MiniMap：`nodeColor` 按状态取 `--ph-*-bg`；Controls 保持默认但随 colorMode
- 画布背景：点阵（`variant={Dots}`）密度微调，中性色

### 3.3 跟随状态按钮

「回到当前」升级为常显状态按钮（画布左上角）：

- 跟随中（followRef=true 且 phase=running）：`--ph-running` 系高亮胶囊 + LocateFixed 图标 + 文案「跟随中」
- 已解锁（用户拖动后）：中性胶囊 + 文案「已解锁」
- 终态/未运行：中性胶囊 + 文案「回到当前」，点击 = fitView 全图（沿用现有语义）
- 点击/快捷键 **F**：重新跟随并平滑回中当前 fireable 节点（fitView 现有机制）；终态时 F 等价于回到当前
- 键盘监听挂画布容器，输入框聚焦时不触发

## 4. 节点面板 V2（NodePanel 重排）

结构（自上而下）：

1. **粘性头部**：状态图标（同 3.1 表）+ 节点名（13px 加粗）+「状态 · ×N」状态胶囊 + X 关闭；`sticky top-0` 带底边框
2. **输入胶囊区**：`类型 harness` / `start` / 各输入键名为标签胶囊（mono 键名）；整组 hover `title` 显示完整输入 JSON（信息不丢失）
3. **思考块**：**与 chat RunBlock 思考行同一组件/类**（见 §6.1）——左边框 2px（running 蓝）、斜体、muted、240px 滚动上限、点击展开/收起（保留现有自动收起逻辑）
4. **最新输出卡**：头部条（「输出 · 流式/终态」标签 + Copy 按钮，复制成功 1.5s 内变 Check）+ 正文区；边框/头部条随节点状态色（`--ph-*-border/bg`）
5. **运行记录时间线**：左侧竖线 + 状态圆点（ok=绿实心 / failed=红），行内「tick N + 状态词」；点击展开全文（现有 openTick 逻辑保留）

面板宽度拖拽（ResizeHandle 未提交改动）保留；流式正文/思考的自动滚动逻辑不动。

## 5. 壳层统一

- **TabBar**：页签前缀图标（MessageSquare/Play/LayoutGrid），激活页签 = emphasis 胶囊（黑底白字），非激活 hover 微底色
- **ActivityBar**：图标换 lucide 同族（Chat/树状 Structure/卡片 Layers/模块 Blocks/运行 History/设置 Settings）
- **RunList 行**：状态点（`--ph-*` 主色）+ phase 文案 + 相对时间；hover/选中态统一
- **RunControls 按钮**：全部图标化（§2.4 映射）+ 阶段化文案保留
- **ModuleList/ModuleDetail/SpecForm/各 Dialog**：按钮图标、间距、字阶对齐令牌；`dialogTheme` 类同步微调
- 侧栏（左）各面板 section 标题统一 `11px 半粗 muted + 图标` 样式

## 6. Chat 轻对齐

### 6.1 思考块统一（用户明确要求）

现状两处思考渲染：chat `RunBlock`（`ChatView.tsx:130`：`border-l-2 border-border pl-2 text-[11.5px] italic` + max-h 240）与 NodePanel 思考块。本轮**抽出共享组件** `components/ThinkBlock.tsx`，两处同源：左边框 2px running 蓝、斜体、muted 文本、240px 滚动上限。手动展开/收起为**可选 prop**：NodePanel 开启（保留现有自动收起+手动覆盖逻辑），chat 维持现状仅自动（不新增交互）；差异仅外层容器尺寸。chat 与 run 侧栏视觉完全对齐。

### 6.2 其他

- `✓ ✗ ◌` → lucide Check/X/Circle；`📄` → FileText
- 间距/字号/按钮跟齐 §2 令牌；Composer、侧栏面板（ChatListPanel/TreePanel/CardsPanel/SettingsPanel）只做间距字号与胶囊态对齐，不动结构

## 7. 动效与可访问性

仅四处动效：spinner（运行图标）、活跃边虚线流动、跟随按钮状态过渡（150ms）、输出卡复制成功反馈。全部用 CSS（tailwindcss-animate / 自定义 keyframes），`prefers-reduced-motion: reduce` 时 spinner 与流动降级为静态着色。焦点可见性（focus-visible ring）保持现有水平不回退。

## 8. 验收

1. `cd web && npm run build`（tsc --noEmit + vite build）通过
2. 亮/暗两主题人工核对：运行视图（含运行中 run 的 spinner/流动边/思考块）、模块库、chat、各对话框
3. 无字符/emoji 图标残留（grep `✓|✗|◌|📄` 于 web/src 应为 0 命中——合法文本内容除外）
4. 思考块：chat 与 NodePanel 同屏对比视觉一致
5. F 快捷键：画布聚焦时切换跟随；输入框聚焦时无效

## 9. 实施切分建议（供 writing-plans 展开）

按依赖序：① 令牌层（CSS 变量 + Pill 组件）→ ② 图视图皮肤（StatusNode/边/跟随按钮）→ ③ NodePanel V2（含 ThinkBlock 抽取）→ ④ 壳层 → ⑤ chat 对齐 → ⑥ 全局核对（字号阶清零、图标清点、暗色/动效降级）。
