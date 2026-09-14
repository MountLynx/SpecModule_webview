# treechat 对话引擎收编（vendor 进 webview）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `../Treechat` 的后端包与其全套测试收编进本仓库，webview 自包含、摆脱 editable 兄弟依赖；原仓库收尾提交后冻结（收编退役，用户裁定「复制到本仓库比较好」）。

**Architecture:** 保持顶级包名 `treechat` 不变 → `server/chat.py`、测试、文档的 import/URL 零改动；收编后挂载常开（可缺席降级契约退役）；前端 `web/src/chat/` 已是移植副本，前后对称。依赖零新增——treechat 唯一依赖 `specmodule`（`llm`/`module_harness` 均由其提供），本项目已声明。

**关键事实（探查结论）：**
- treechat 后端 22 文件 / 2461 行：`core/`（引擎）+ `session.py` + `module_bridge.py`/`llm_bridge.py` + `modules/`（direct/grilling）+ `cli/`（REPL）+ `webapp/`（服务层）。
- 测试 14 文件 / 133 例 / ~1800 行，自包含（无兄弟仓库路径 hack），自带 conftest 假客户端。
- TreeChat 仓库存在未提交功能改动（mode_modules 接线 / message_field / session_delete 锁修复，与测试成对，133 例绿）——收编前必须先在原仓库提交，来源才干净；webview 此前验证跑的正是该工作区状态。
- webview 引用面极小：`server/chat.py` 唯一 import 点、`tests/test_chat_mount.py` 唯一 importorskip、前端两句提示文案、AGENTS/roadmap 文档。
- vendored 后 `webapp` 静态回退路径（`parents[2]/webui/dist`）在本仓库布局不存在，但挂载恒传 `_DISABLED_STATIC`，无影响。

---

### Task 0: TreeChat 仓库收尾提交

- [ ] `cd ../Treechat && git add -A && git commit`（模式接线收口 + message_field + session_delete 锁修复 + docs issue + .gitignore）。
- [ ] `python -m pytest tests -q` → 133 passed；此后该仓库冻结不再改动。

### Task 1: 收编包代码 + pyproject + 环境切换

- [ ] `cp -r ../Treechat/treechat ./treechat`，剔除 `__pycache__`；确认仅 .py、行数 2461 与原仓库一致。
- [ ] `pyproject.toml`：`[tool.setuptools.packages.find] include = ["server*", "treechat*"]`；新增 `[project.scripts] treechat = "treechat.cli.repl:main"`。
- [ ] `pip uninstall -y treechat && pip install -e .`（官方 Python 3.13 环境）；`python -c "import treechat; print(treechat.__file__)"` 指向本仓库。

### Task 2: 收编测试

- [ ] `mkdir tests/treechat && cp ../Treechat/tests/*.py tests/treechat/`（14 文件含 conftest；目录级 fixture 与根 conftest 无名冲突）。
- [ ] `python -m pytest tests/treechat -q` → 133 passed。

### Task 3: 挂载去降级 + 测试去 skip

- [ ] `server/chat.py`：删 try/except ImportError 与「未安装」stderr 分支，直接 import 顶级 `treechat`；docstring 改写（收编说明、挂载常开）；保留 `-> bool` 恒 True（测试断言零改动）。
- [ ] `tests/test_chat_mount.py`：删 `pytest.importorskip("treechat")` 与 noqa 延迟导入结构；`from pathlib import Path` 归位文件头并删函数内重复 import。
- [ ] `server/app.py` 挂载处注释：「未安装时自动跳过」→「引擎已收编、挂载常开」。
- [ ] `python -m pytest tests/test_chat_mount.py tests/treechat -q` → 141 passed。

### Task 4: 前端防御文案

- [ ] `ChatListPanel.tsx`：「服务端安装 treechat 后重启即可」→「对话功能内置于服务端——请确认后端已启动/升级后刷新」。
- [ ] `SettingsPanel.tsx`：删「`pip install -e "../Treechat"` 后重启生效」→「对话功能内置于服务端，无需额外安装」。
- [ ] `App.tsx` 探测注释同步（404 仅剩防御意义）。
- [ ] `cd web && npx tsc --noEmit` 零错误。

### Task 5: 文档同步

- [ ] `AGENTS.md`：Project Overview 状态句（已收编/冻结）；Key Directories 增 `treechat/` 条目、`chat.py` 描述改「挂载常开」；Development Commands 删 `pip install -e "../Treechat"` 段；Runtime deps 句更新；统一 API 原则补反向收编偏差记录。
- [ ] `roadmap.md` 变更日志追加收编条目（历史 specs/plans 不改写）。

### Task 6: 全量验证 + 提交

- [ ] `python -m pytest tests/ -q` → 228 passed（95 webview + 133 treechat）。
- [ ] `cd web && npm run build` → 通过。
- [ ] 端到端冒烟：`python -m uvicorn server.app:app --port 8010` 后台起 → `curl /treechat/api/health`、`/treechat/api/modes` 正常 → 停。
- [ ] 提交：TreeChat 一笔（Task 0）；webview 两笔——①收编代码+测试+挂载简化+pyproject；②前端文案+AGENTS/roadmap/本计划。

**不做：** 不改 treechat 代码逻辑（逐字拷贝）；不动历史 specs/plans 文档；不删 `../Treechat` 仓库（存档由用户处置）；`.treechat/` 数据目录保持 gitignored。
