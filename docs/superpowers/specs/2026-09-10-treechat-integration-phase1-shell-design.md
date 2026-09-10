# TreeChat 整合 · 第一期：壳层重组设计

> 2026-09-10 定稿。用户已确认五节设计与高保真示意（mockup 见
> `.superpowers/brainstorm/763-1788999512/content/shell-mockup.html`，gitignore 不入库）。

## 背景与总规划（三期）

决策：把 [TreeChat](../../../TreeChat)（对话树一等公民 + 卡片式上下文产出的对话引擎，自带
VSCode 式布局 WebUI）**深度整合**进本仓库——对话最终成为运行管理的助手，对话 ⇄ 运行
上下文互通。整合按三期推进，每期独立 spec → plan → 实施 → 验收：

| 期 | 内容 | 状态 |
|---|---|---|
| ① 壳层重组 | VSCode 式布局（活动栏 + 侧边栏 + 主区）+ TreeChat 视觉基建，现有三视图迁入 | **本期，本文档** |
| ② 对话引擎并入 | 对话/对话树/卡片页签 + `treechat/webapp` 服务层挂载进 `server/` | 后续 spec |
| ③ run 感知 | 对话 ⇄ 运行上下文互通：卡片注入 run 上下文、对话可引用当前 run 状态 | 后续 spec |

期①不动任何对话功能；期②进来时活动栏在现有图标之上追加 💬🌿🗂；期③依赖期②。

## 第一期目标

现有顶部三视图（模块库 / 运行历史 / 运行视图，互斥切换）重组进 VSCode 式壳，
视觉基建立 TreeChat webui 的技术栈与主题。**纯前端重组——`server/` 零改动。**

核心范式升级：**侧栏导航式**（列表 = 导航器，主区 = 文档）。运行历史列表与运行视图
不再二选一——列表常驻侧栏，点 run 主区换内容，随时切换。

## 信息架构

```
┌────┬───────────────┬─────────────────────────────────┐
│活动│ 侧边栏 280px  │ 主区（内容随选择变化）           │
│栏  │               │                                 │
│ ▣  │ 模块库页签    │ 模块库页签时：                   │
│ ≡  │  · 模块列表   │   未选模块 → 空态提示            │
│    │  · 扫描来源   │   选中模块 → 详情 + SpecForm     │
│    │               │   （发起表单内嵌，RunDialog 退役）│
│ ⚙  │ ───────────── │ 运行历史页签时：                 │
│底部│ 运行历史页签  │   未选 run → 空态提示            │
│    │  · 紧凑run列表│   选中 run → RunView 原样入主区  │
└────┴───────────────┴─────────────────────────────────┘
```

- **活动栏**（46px 图标条，lucide 图标）：`Boxes` 模块库 / `List` 运行历史两页签，
  底部 `Settings` 占位（无功能，为二三期对话图标留位）。选中态高亮（左侧竖条 accent）。
- **侧边栏**：
  - 模块库页签 = 现 ModulesView 左列表（名称 + kind 徽章 + 版本）+「扫描来源」尾行。
    选中模块 → 主区显详情。
  - 运行历史页签 = 现 RunsView 全宽表格压缩为紧凑列表行：module 名（旧 run 回落
    run_id 启发式）+ phase 色点 + tick + 相对时间；行内控制钮（暂停/继续/取消/
    恢复/删除）收进行内按钮区；错误摘要两行截断；`paused`、无 sqlite、未知模块等
    现有标注全保留。当前打开 run 高亮。
- **主区**：
  - 模块详情面：detail_to_dict 全量（templates/default_spec/spec_schema/submodules）
    + SpecForm 内嵌 + 「发起运行」按钮。**RunDialog 弹窗退役**（表单进主区是侧栏
    导航范式的自然结果）。
  - RunView：控制条 + GraphView + NodePanel + 落盘等待门（materialized）逻辑
    **原样保留**，仅换皮。
  - 空态：未选中时的引导提示（两页签同构）。

## 技术栈与移植清单

新增依赖（`web/package.json`）：

- `tailwindcss@^3.4 + postcss + autoprefixer + tailwindcss-animate`
- `clsx + tailwind-merge + class-variance-authority`（cn 工具 + cva 变体）
- `lucide-react`（图标）
- **Radix 留待二期**随对话 UI（dialog/dropdown-menu/alert-dialog）带入；本期现有
  对话框（Checkpoint/Resume）保留手写实现仅换皮。

从 TreeChat webui 移植改造（复制 + 适配 content 路径/命名）：

| 文件 | 说明 |
|---|---|
| `tailwind.config.js` | shadcn neutral 色板映射（含 sidebar/activitybar 语义色），content 指本仓库 `web/src` |
| `postcss.config.js` | tailwind + autoprefixer |
| `src/index.css` | 主题变量全量替换：`--background/--foreground/--sidebar/--activitybar/...` 亮暗双套 + tailwind directives |
| `src/lib/utils.ts` | `cn()` |
| `src/components/ui/button.tsx`、`ui/input.tsx` | 无 Radix 依赖的两个基建组件 |
| ActivityBar 结构 | 图标页签机制同构移植，页签集合换成本仓库的 |

改造原则：

- 现有内联样式（`CSSProperties` 对象）全部迁为 Tailwind class；`dialogStyles.ts` 退役。
- React Flow / StatusNode 节点配色改读 CSS 变量——亮暗主题自动生效。
- phase 语义色（PHASE_COLOR：running/done/aborted/cancelled/truncated）保留现值，
  定义为 CSS 变量。
- 主题跟随系统（`prefers-color-scheme`），localStorage 可手动覆盖——与 TreeChat
  行为一致。

## 状态与数据流（App.tsx 重写为壳）

- 壳层状态：`activeTab: "modules" | "runs"`、`openModuleName: string | null`、
  `openRunId: string | null`、`runs` 5s 轮询（不变）、`resumeRequest`（runId + seq
  守卫机制不变）。
- 范式变化：
  - 打开 run **不再切走列表**——侧栏常驻，主区换内容。
  - 删除当前打开的 run → 清 `openRunId` 回空态。
  - 模块库发起运行成功（202）→ 切「运行历史」页签 + 打开新 run。
- 模块数据（fetchModules/fetchModuleDetail）与 run 数据（props 下发）的获取职责
  维持现状：模块列表数据归模块页签组件自取，runs 列表仍由壳层轮询下发。
- 仍不引 router（两仓库一致的 useState 范式）。

## 错误处理与兼容边界

- **`server/`、`web/src/api.ts`、`web/src/ws.ts`、`web/src/dagre.ts` 零改动。**
- 现有交互语义全保留：
  - 删除 run：终态确认；running 提示先取消 + force 二次确认（window.confirm 本期
    不升级为 Radix dialog）。
  - 行内控制失败静默（5s 轮询后状态即真相）。
  - WS 按 runId 打包防陈旧流；恢复对话框 runId + seq 防陈旧重放。
  - 落盘等待门（202 后 404 静默轮询 → 放行 WS/图；120s 超时示错挂 process.log；
    phase 去抖自愈图 404）。

## 验收标准

1. `cd web && npm run build` 绿（tsc --noEmit + vite build）。
2. 三段式壳渲染；亮/暗主题跟随系统切换生效。
3. 全链路回归（dev server + 真实/fixture run）：选模块 → 详情/发起 → run 打开 →
   WS 实时 tick → 行内控制（pause/cancel）→ 恢复对话框 → 删除（含 force 路径）。
4. `python -m pytest tests/ -q` 仍绿（server 未动的回归基线）。

## 明确不做（本期）

- 任何对话功能（期②）、任何 run 感知（期③）。
- Radix 依赖与现有对话框迁移。
- window.confirm 升级为应用内对话框。
- router 引入、`server/` 任何改动。
