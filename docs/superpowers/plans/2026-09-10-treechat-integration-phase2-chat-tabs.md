# TreeChat 整合第二期（对话引擎并入 + 顶部页签壳）实施计划

> 设计定稿：`../specs/2026-09-10-treechat-integration-phase2-chat-tabs-design.md`。
> 实施分支：`treechat-phase2-chat`（worktree `.worktrees/treechat-phase2-chat`）。
> 每任务一提交，任务内先库后壳、先数据后视图；acceptance gate = `npm run build` +
> `python -m pytest tests/ -q` 全绿。

## 任务 1：server 挂载 treechat/webapp + 测试

文件：
- `server/chat.py`（新）：`mount_chat(app, base_dir)` —— try-import treechat；
  `TreeChatConfig(data_dir=Path(os.getenv("TREECHAT_DATA_DIR", base_dir / ".treechat")))`；
  `client_factory=lambda model: llm_bridge.create_client(model, project_root=base_dir)`；
  `app.mount("/treechat", create_app(config, client_factory=…, static_dir=Path("<nEXIST>")))`；
  `app.state.chat_registry` 暴露子应用 registry 供测试注入。
- `server/app.py`：`from server.chat import mount_chat` + `mount_chat(app, BASE_DIR)`
  （base_dir 解析复用 deps 纪律：SPECMODULE_BASE or cwd）。
- `tests/test_chat_mount.py`（新）：module 级 `pytest.importorskip("treechat")`；
  TestClient fixture 用 `tmp_path` 作 SPECMODULE_BASE。

用例：
1. `GET /treechat/api/health` 200，`dataDir` 以 tmp base_dir 结尾（`.treechat`）。
2. 生命周期：POST sessions（409 重名）→ GET sessions 列表 → GET state（空会话形状）
   → rename/category/archive → DELETE 204 → GET 404。
3. 轮次：`app.state.chat_registry._client_factory = lambda m: FakeClient()` 后 drop 会话
   再 open（新 client 生效）→ POST turn → 断言 assistant 节点 + pointer 前进；
   FakeClient 抛 LLMError → 502 `{error, state}` 且 user 节点在 state。
4. 非法 sid（`../x`）→ 400；未知 sid → 404。

验收：`python -m pytest tests/ -q` 绿（treechat 已 `pip install -e ../Treechat`）。

## 任务 2：web 依赖 + 样式基建补齐

- `web/package.json`：+ `@radix-ui/react-dialog` `@radix-ui/react-dropdown-menu`
  `@radix-ui/react-alert-dialog` `react-markdown` `remark-gfm`（版本对齐 Treechat webui）。
- `web/src/index.css`：并入 Treechat 的滚动条样式（`*::-webkit-scrollbar*` +
  `scrollbar-color: foreground/0.2`）与 `.md` 排版块；一期 phase 色增量保留。
- `web/src/components/ui/dialog.tsx` / `dropdown-menu.tsx` / `alert-dialog.tsx`：
  自 Treechat webui 原样移植（button/input/utils 已一致，零改动）。

验收：`npm run build` 绿（无使用方时不报 unused——css 无所谓，组件要 tsc 通过）。

## 任务 3：chat 前端基座（types/api/树布局/主区视图）

文件（`web/src/chat/`，自 Treechat/webui/src 移植改造）：
- `types.ts`：原样。
- `api.ts`：路径加 `/treechat` 前缀。
- `treelayout.ts`：原样（vitest 测试不迁，靠 build+冒烟）。
- `Markdown.tsx` / `ChatView.tsx` / `Composer.tsx`：import 路径适配。

验收：`npm run build` 绿（未被引用的模块 tsc 也会全量检查）。

## 任务 4：chat 侧栏面板（ChatListPanel/TreePanel/CardsPanel/SettingsPanel）

文件（`web/src/chat/`，源 `components/tabs/*Tab.tsx`）：
- `ChatListPanel.tsx`（源 ChatListTab）：props 增 `serviceAvailable: boolean`，
  未启用时显「对话服务未启用」；回调签名不变。
- `TreePanel.tsx`（源 TreeTab）/ `CardsPanel.tsx`（源 CardsTab）：conv 缺失
  （无激活 chat 页签）时空态引导「从对话列表打开一个会话」——面板自身接收
  `conv: ConvState | null`，内部判空（替代原 App 永传空 conv 的写法）。
- `SettingsPanel.tsx`（源 SettingsTab）：健康状态面板（llmConfigured / dataDir /
  服务未启用态）。

验收：`npm run build` 绿。

## 任务 5：壳层重写——顶部页签制 + 活动栏扩展

- `web/src/components/TabBar.tsx`（新）：页签条——固定 `📦 模块库` + 动态页签
  （💬 会话名 / ▶ module??run_id，× 关闭钮），激活态高亮，横向滚动兜底。
- `web/src/components/ActivityBar.tsx`：页签集合扩为
  `chat | tree | cards | modules | runs` + 底部 `settings`（label 相应更新）。
- `web/src/App.tsx` 重写：
  - 页签模型 `tabs/activeId`（modules 固定在首位；同 id 打开=激活既有）。
  - 多会话状态 `convs` + 每 sid UI 态（branchParent/leafMode/selectedSeq/cardSeqs/
    busy/error）；openChat/createSession/deleteSession/turn/retry/卡片操作按
    Treechat webui App 的接线平移到多实例。
  - 会话健康：`chatHealth()` 一次拉取（404 → serviceAvailable=false）。
  - run 侧：openRun/handleListResume/handleListControl/handleDeleted/handleLaunched
    改为页签操作（发起运行 → 开 run 页签激活；删除 → 关页签；不再强切活动栏页签）。
  - 侧边栏按活动栏页签渲染六种面板；树/卡片绑激活 chat 页签态。
  - 主区按激活页签渲染 ModuleDetail / RunView / ChatView+Composer / 空态。

验收：`npm run build` 绿；手核页签开/关/切换回落逻辑代码路径。

## 任务 6：vite proxy + 文档同步

- `web/vite.config.ts`：proxy 追加 `"/treechat": { target: "http://127.0.0.1:8000", changeOrigin: true }`。
- `AGENTS.md`：dev commands 补 `pip install -e "../Treechat"`；目录描述补
  `server/chat.py`、`web/src/chat/`；端点表补 `/treechat/api/*` 挂载行。
- `roadmap.md`：变更日志记本期；三期规划表更新期②状态。

## 任务 7：终验

1. `cd web && npm run build` 绿。
2. `python -m pytest tests/ -q` 绿。
3. 库基线不受影响（未改 `../SpecModule`；如动了再跑）。
4. 冒烟清单（无 LLM key 可走通）：起后端 → SPA——建会话出页签 → 轮次 502 错误条 +
   重试 → 第二会话页签共存 → 树/卡片随激活页签切换 → 打开 run 页签共存 →
   关页签回落 → 删会话/删 run 关页签 → 服务未挂载时（卸载 treechat 场景可跳过）
   列表显未启用。
5. 合并 `treechat-phase2-chat` → main。
