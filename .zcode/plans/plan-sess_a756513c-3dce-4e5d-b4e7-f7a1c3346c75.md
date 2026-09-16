# 收编 treechat 对话引擎进本仓库(后端 vendor)

**Goal:** 把 `../Treechat` 的后端包(22 个 py / 2461 行)与其全套测试(15 文件 / 133 例)收编进本仓库,webview 自包含,摆脱 editable 兄弟依赖;TreeChat 原仓库收尾提交后冻结(你自行存档)。

**采用方案:** 收编退役(你未在问答中选择,依你"复制到本仓库比较好"的原话采用推荐项)。保持顶级包名 `treechat` 不变 → `server/chat.py`、测试、文档中的 import/URL 零改动。前端 `web/src/chat/` 已是移植副本,收编后前后对称。

**关键事实(已探查):**
- treechat 唯一依赖 `specmodule`(webview 已声明,`llm`/`module_harness` 均由 SpecModule 提供)→ **零新增第三方依赖**。
- TreeChat 仓库有**未提交的功能改动**(mode_modules 接线、message_field、session_delete 锁修复,与测试成对,133 例全绿跑的正是工作区状态)→ 收编前先在原仓库提交,来源才干净。
- webview 引用面:仅 `server/chat.py` import、`test_chat_mount.py` 一处 importorskip、前端两句提示文案、AGENTS/roadmap。
- vendored 后 `webapp` 的静态目录回退路径(`parents[2]/webui/dist`)在本仓库布局下不存在,但挂载始终显式传 `_DISABLED_STATIC`,无影响。

---

### Task 0: TreeChat 仓库收尾提交(原仓库)
- [ ] `cd ../Treechat && git add -A && git commit` 未提交的 13 文件(+docs/issues/):模式接线收口 + message_field + session_delete 锁修复,提交信息注明"收编进 webview 前收尾"。
- [ ] 复跑 `python -m pytest ../Treechat/tests -q` 确认 133 passed 后冻结(不再改动该仓库)。

### Task 1: 收编包代码 + pyproject
- [ ] `cp -r ../Treechat/treechat ./treechat`(剔除 `__pycache__`);确认仅 .py 文件。
- [ ] `pyproject.toml`:`packages.find` include 增 `"treechat*"`;新增 `[project.scripts] treechat = "treechat.cli.repl:main"`(保留 CLI REPL/webui 入口);dependencies 不变(specmodule 已覆盖)。
- [ ] 环境切换(官方 Python 3.13,即验证过的那个):`pip uninstall -y treechat && pip install -e .`;验证 `python -c "import treechat; print(treechat.__file__)"` 指向本仓库。

### Task 2: 收编测试
- [ ] `mkdir tests/treechat` 并拷入 ../Treechat/tests 的 15 个 .py(含其 conftest.py——目录级 fixture,与根 conftest 无名冲突)。
- [ ] 核对 `test_smoke.py`(7 行)内容,原样保留。
- [ ] `python -m pytest tests/treechat -q` → 133 passed;`python -m pytest tests/ -q` → 228 passed。

### Task 3: 挂载逻辑去降级 + 测试去 skip
- [ ] `server/chat.py`:删 try/except ImportError 与"未安装"stderr 分支,改为直接 import 顶级 `treechat`;docstring 改写(收编说明、挂载常开);保留 `-> bool` 返回 True(两处测试断言零改动)。
- [ ] `tests/test_chat_mount.py`:删 `pytest.importorskip("treechat")`,`from llm import ...` 等延迟导入归位文件头(去 noqa)。
- [ ] `server/app.py` L38 注释"未安装时自动跳过"→"挂载常开(引擎已收编)"。
- [ ] `python -m pytest tests/test_chat_mount.py tests/treechat -q` 全绿。

### Task 4: 前端防御文案更新
- [ ] `ChatListPanel.tsx` L52「服务端安装 treechat 后重启即可…」→「对话服务未挂载——请确认后端已启动」(该空态收编后为防御路径)。
- [ ] `SettingsPanel.tsx` L18 删「`pip install -e "../Treechat"` 后重启生效」→「对话功能内置于服务端,无需额外安装」。
- [ ] `App.tsx` L107 注释同步(404 探测改为防御性说明)。
- [ ] `cd web && npx tsc --noEmit` 零错误。

### Task 5: 文档同步
- [ ] `AGENTS.md`:Runtime deps(L140)与 L81 注释改为「对话引擎 treechat 已收编为本仓库顶级包(2026-09-14),挂载常开,原独立仓库冻结」;Project Overview 状态句、Key Directories 增 `treechat/` 条目(core 引擎/session/module·llm bridge/modules/cli/webapp);「统一 API 原则」补收编偏差记录(非 PyPI 库、唯一消费端、前端已移植——避免双源漂移)。
- [ ] `roadmap.md` 变更日志追加收编条目;历史 specs/plans 不改写。
- [ ] 另存实施计划到 `docs/superpowers/plans/2026-09-14-treechat-vendoring.md`。

### Task 6: 全量验证
- [ ] `python -m pytest tests/ -q` → 228 passed。
- [ ] `cd web && npm run build` → 通过。
- [ ] 端到端冒烟:后台起 `python -m uvicorn server.app:app --port 8010`,`curl /treechat/api/health` 与 `/treechat/api/modes` 返回正常后停掉(正是你报错的那条命令场景)。
- [ ] 提交:webview 两笔(①收编代码+测试+挂载简化;②文案+文档),TreeChat 一笔(收尾)。

**不做:** 不改 treechat 代码逻辑(逐字拷贝);不动历史 specs/plans 文档;不删 `../Treechat` 仓库(存档由你处置);`.treechat/` 数据目录保持 gitignored。
