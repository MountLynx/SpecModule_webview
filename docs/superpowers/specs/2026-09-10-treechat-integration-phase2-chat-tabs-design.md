# TreeChat 整合 · 第二期：对话引擎并入 + 顶部页签壳

> 2026-09-10 定稿。用户指令：引入 TreeChat（先只引入，与 SpecModule 共用 config/env/client，
> 对话⇄run 联动不做）；顶部页签制——每个 chat 会话、每个 run 视图一个页签，可同时存在；
> 侧边栏分「页签配套功能（随选中页签切换，如对话树/卡片）」与「全局功能（不随页签变，
> 只变选中高亮）」。

## 背景与定位

一期壳层重组已合入 main（dbe139e）：VSCode 式三段布局（活动栏 + 侧边栏 + 主区），
侧栏导航范式。本期为三期总规划的**期② 对话引擎并入**，叠加用户新定的**顶部页签 IA**：

| 期 | 内容 | 状态 |
|---|---|---|
| ① 壳层重组 | VSCode 式布局 + TreeChat 视觉基建 | ✅ 已合入 |
| ② 对话引擎并入 + 顶部页签 | `treechat/webapp` 挂载进 `server/` + chat UI 移植 + 页签制壳 | **本期，本文档** |
| ③ run 感知 | 对话⇄运行上下文互通 | 后续 spec |

## 信息架构（页签制壳）

```
┌────┬──────────────────┬────────────────────────────────────────┐
│活动│ 侧边栏 280px      │ 页签栏：[📦模块库] [💬会话A ×] [▶run ×]  │
│栏  │                  ├────────────────────────────────────────┤
│ 💬 │ （内容随活动栏    │ 主区 = 激活页签内容                      │
│ 🌿 │   页签切换）      │  📦 → ModuleDetail / 空态               │
│ 🗂 │                  │  💬 → ChatView + Composer               │
│ 📦 │                  │  ▶  → RunView                           │
│ ≡  │                  │                                        │
│ ⚙  │                  │                                        │
└────┴──────────────────┴────────────────────────────────────────┘
```

- **活动栏**（现有图标之上追加，图标即侧边栏页签切换）：
  - `MessageSquare` 对话 —— 全局功能：会话列表（ChatListPanel：创建/重命名/分类/
    归档/删除/搜索，点击 = 打开/激活会话页签）。
  - `GitFork` 对话树 —— **页签配套功能**：绑定当前激活 chat 页签的会话树
    （分支/叶子/选点/从此分支/节点命名/选点提炼）。无激活 chat 页签 → 空态引导。
  - `Layers` 卡片 —— **页签配套功能**：绑定当前激活 chat 页签的卡片库
    （生成/pin/编辑/删除/导入/导出）。无激活 chat 页签 → 空态引导。
  - `Boxes` 模块库 / `List` 运行历史 —— 全局功能（一期原样）：点击打开/激活对应页签，
    当前列表项高亮跟随激活页签。
  - 底部 `Settings` 设置 —— 全局功能：健康状态（llmConfigured / dataDir，升自一期占位）。
- **顶部页签栏**（主区顶部，TabBar）：
  - `📦 模块库` 固定页签（不可关闭，始终存在；点模块库列表项激活它）。
  - 会话页签：`💬 {会话名}`，可关闭；label 跟随 rename。
  - run 页签：`▶ {module ?? run_id}`，可关闭；关闭 = 移出页签栏，不删数据。
  - 关闭激活页签 → 激活相邻页签，无相邻回落模块库页签。同 id 重复打开 = 激活既有页签。
- **侧边栏语义**（用户定稿）：页签配套功能（树/卡片）内容随激活页签切换；全局功能
  （对话列表/模块库/运行历史/设置）不随页签变，只变选中高亮。

## 服务层引入（server/）

**整树挂载，零重复接线**（统一 API 原则——`treechat/webapp` 就是 treechat 库的服务层）：

- 新文件 `server/chat.py`：`mount_chat(app, base_dir)`。
  - `create_app(config, client_factory=…, static_dir=…)` 挂到 `app.mount("/treechat", …)`，
    子应用端点即 `/treechat/api/*`（sessions CRUD / turn / retry / cards / health / cards 库）。
  - `static_dir` 传不存在路径——禁用其静态托管（前端归本仓库 SPA）。
  - **config**：`TreeChatConfig(data_dir=…)`，`TREECHAT_DATA_DIR` 环境变量可覆盖，
    缺省 `<base_dir>/.treechat`——与 `.specmodule` 同级的「工作区自包含」纪律。
  - **client**：`client_factory = lambda model: llm_bridge.create_client(model, project_root=base_dir)`
    ——复用 SpecModule 配置回退链（项目根 config.json/.env → ~/.specmodule）与同一 llm
    客户端基建，即用户要求的「共用 config/env/client」。
  - **降级**：treechat 未安装（`import treechat` 失败）→ 跳过挂载并日志提示，
    其余功能不受影响；前端对 `/treechat/api/*` 404 时对话框列表显「对话服务未启用」。
- `server/app.py`：启动时调 `mount_chat(app, BASE_DIR)`。
- `web/vite.config.ts`：proxy 追加 `"/treechat" → :8000`（纯 REST，无 WS）。

## 前端移植与改造（web/src）

新增依赖：`@radix-ui/react-dialog` / `@radix-ui/react-dropdown-menu` /
`@radix-ui/react-alert-dialog` / `react-markdown` / `remark-gfm`。

| 源（Treechat/webui/src） | 落位（web/src） | 改造 |
|---|---|---|
| `types.ts` | `chat/types.ts` | 原样（activePath/nodeRef 随行） |
| `api.ts` | `chat/api.ts` | 全部路径加 `/treechat` 前缀，其余原样 |
| `lib/treelayout.ts` | `chat/treelayout.ts` | 原样（其 vitest 测试不随迁，验收靠 build+冒烟） |
| `components/chat/ChatView·Composer·Markdown` | `chat/` | import 路径适配 |
| `components/tabs/ChatListTab·TreeTab·CardsTab·SettingsTab` | `chat/`（更名 *Panel） | tab 概念 → 侧栏面板；TreeTab/CardsTab 绑定改为 props 传激活会话态 |
| `components/ui/dialog·dropdown-menu·alert-dialog` | `components/ui/` | 原样带入（Radix 随对话 UI 进场，一期预留） |
| `index.css` 的滚动条样式 + `.md` 排版块 | 并入本仓库 `index.css` | phase 语义色等一期增量保留 |

- ui/button、ui/input、lib/utils（cn/relativeTime）两仓库已一致，零改动。
- 现有 `api.ts`/`ws.ts`/`dagre.ts` 零改动。

## 状态与数据流（App.tsx 再重写为页签制壳）

- **页签模型**：`tabs: Array<{kind:"modules"} | {kind:"chat", sid} | {kind:"run", runId}>`，
  `activeId: "modules" | "chat:{sid}" | "run:{runId}"`。主区只渲染激活页签（组件 key
  防串状态；run 页签切换的图重取沿用一期行为）。
- **会话态升级为多实例**：一期 TreeChat webui 是单活动会话；壳层按 sid 持有
  `convs: Record<sid, ConvState>` + UI 态（branchParent/leafMode/selectedSeq/cardSeqs/
  busy/error）。切页签不丢；轮次 502（LLM 失败，user 节点已落盘）照旧错误条 + 重试。
- **联动点**（页签制自然结果，均一期语义平移）：
  - 对话列表点击 → openChat（无则建页签 + 拉取 ConvState，有则激活）。
  - 删除会话 → 若页签开着则关页签（激活相邻/模块库）；刷新列表。
  - 运行历史点击 → openRun；删除 run → 关页签；发起运行 202 → 开 run 页签并激活
    （不再强制切「运行历史」活动栏页签——run 已是页签，列表高亮跟随即可）。
  - run 页签 label 用 `module ?? run_id`（runs 摘要已有 module 字段）。
- runs 5s 轮询、恢复对话框 runId+seq 守卫、落盘等待门等一期机制**原样保留**。

## 错误处理与兼容边界

- `/treechat/api/*` 404（未挂载）→ 对话列表/健康面板显「对话服务未启用」；
  其余视图不受影响。
- sid 非法（路径穿越）→ 子应用 400 原样透传；会话不存在 → 404（关页签容错）。
- run 侧错误契约、WS 语义、`server/` 既有端点零改动。

## 测试与验收

- `tests/test_chat_mount.py`（treechat 缺席时 `pytest.importorskip` 跳过）：
  挂载健康检查（dataDir 落在 tmp base_dir）、会话建/查/改/删生命周期、
  stub client 轮次（替换 `registry` client_factory）+ LLM 失败 502 {error, state} 契约、
  非法 sid 400 / 未知会话 404。
- `cd web && npm run build` 绿；`python -m pytest tests/ -q` 绿。
- 冒烟（dev server + 无 LLM key 也可走）：建会话 → 页签出现 → 轮次 502 错误条 →
  重试；多会话页签共存切换；树/卡片面板随激活页签切换；run 页签与会话页签并存；
  关页签/删会话/删 run 的页签回落。

## 明确不做（本期）

- 对话⇄run 任何联动（期③：卡片注入 run 上下文、对话引用 run 状态）。
- 流式输出（treechat webapp 本身 REST 非流式，随库走）。
- 会话数据迁入 `.specmodule`、treechat CLI/REPL 整合、其 webui 独立入口。
- 现有对话框（Checkpoint/Resume）迁 Radix。
