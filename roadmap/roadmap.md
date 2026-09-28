# SpecModule Web 可视化（可视化形态）

> 生态项目之一。本目录是 SpecModule 的**可视化消费通道**，独立于库仓库。
> 富交互图编辑器在此，库内的 stdlib 可视化开关只做极简运行 feed。
> **只 import 不实现**——消费 `module_harness` 共享层，绝不重实现查询逻辑；
> 消费新的库 API 时**同步补录** `../SpecModule/docs/references/api.md`（做到哪里写哪里）。

## 文档维护规则（2026-09-24 起）

- 本文件**只记方向规划与排期**，实时更新；已完成的工作归档到
  [finish.md](finish.md)（琐碎者可直接不记录），不在此追加变更日志。
- **问题与遗留项开 GitHub issue**（后排清单、已知偏差、上游缺口），不在文档里积压；
  实施中新发现的缺口同样走 issue。
- 设计定稿长文仍落 `docs/superpowers/specs/`，本文件只留一行指引。

## 定位

独立前端 SPA + FastAPI 薄层，消费 `module_harness/query.py`、`status.py`、`graph_builder.py`、
`store.py` 等共享层函数；后端 = 查询层的 HTTP 适配器（薄层），前端独立 SPA 消费 HTTP/WS API。

## 架构（已定）

```
浏览器面板（SPA）
    │  HTTP / WS
    ▼
server/：FastAPI 薄层 ── 消费 module_harness 共享层，只 import 不实现
    │
    ▼
specmodule 库（module_harness → tickflow 引擎）
```

```
SpecModule_webview/
├── server/                  # FastAPI 薄层：app.py 入口 + deps.py（base_dir/搜索路径解析）
│   ├── api/                 #   runs.py 运行读 + graph.py 图 + manage.py 模块 + control.py 控制面/发起/删除/resume
│   ├── chat.py              #   TreeChat 整树挂载 /treechat（挂载常开）
│   └── ws.py                #   tick 流实时推送
├── web/                     # 前端 SPA（Vite + React + TS + Tailwind + React Flow + dagre）
├── treechat/                # 对话引擎顶级包（2026-09-14 收编，演进在本仓库进行）
├── tests/                   # pytest + httpx TestClient（含收编的 treechat 133 例）
└── pyproject.toml           # fastapi + uvicorn（仅本项目依赖）
```

## 当前状态

阶段 0（HTTP 后端）+ 阶段 1（运行时图视图）+ 阶段 2（可视化管理 + 运行控制）已落地；
TreeChat 整合一/二/三期已落地（对话引擎已收编为本仓库 `treechat/` 顶级包，挂载常开）。
已完成明细与历史变更记录见 [finish.md](finish.md)；问题与遗留见 GitHub issues。

## 功能路线图

### 阶段 1 —— 运行时可视化（剩余切片）

- [ ] 状态面板：tick 流实时推送 → 全量状态侧栏
- [ ] 历史审阅时间线：复用 `build_timeline`，逐 tick 看产出/错误
- [ ] 产出对比：前后（原始 vs 整理 vs 润色）对比面板

### 阶段 3 —— tasklist 图构建器（可选 / 远期）

- [ ] 图编辑（拖拽节点，graph/render 往返验证）
- [ ] 无 run 直渲染端点（POST /api/graph/render，库函数已留 tasklist 通道）

### 模块构建器 —— 组件库 + 可视化创建 packed 模块

设计定稿：[specs/2026-09-25-module-builder-design.md](../docs/superpowers/specs/2026-09-25-module-builder-design.md)

- [x] 组件库 CRUD（harness/command 表单化、scripts/guards 上传、submodule 索引）
- [x] 模块草稿 + 画布创建器（React Flow 编辑态：节点/边/guard/join/inputs 映射）
- [x] 组装安装闭环（拷贝进包 → validate_pack_dir → install_pack → 试运行）
- [x] 后排：编辑/反解已安装模块（2026-09-28，反解回构建器 + apply_update 同名更新；output 侧仅透传保全，编辑 UI 与库版本管理仍后排）
- [x] 后排：entry 模块可编辑——转 packed 接入编辑闭环（2026-09-29，库收编 `entry_to_pack` 物化层 + CLI publish 复用；convert 端点安装+entry 文件 `.bak` 退位；设计定稿 [specs/2026-09-29-entry-to-packed-convert-design.md](../docs/superpowers/specs/2026-09-29-entry-to-packed-convert-design.md)）

### TreeChat 后续 —— ops agent（chat × module 打通）

已全部落地（S0-S5，2026-09-27），明细归档见 [finish.md](finish.md)。设计定稿：
[specs/2026-09-26-treechat-ops-agent-design.md](../docs/superpowers/specs/2026-09-26-treechat-ops-agent-design.md)
（进程内工具桥，不走 MCP；run 永不进回合关键路径）

## 问题与遗留

GitHub issues 跟踪，不在此积压：

- [#5 后排清单](https://github.com/MountLynx/SpecModule_webview/issues/5)——等真实使用中疼了再动的功能项（store 生命周期界面 / init 脚手架 / run 重命名 / 复跑 / 中间快照复跑入口 / 批量删除）
- [#6 同页签 resume 后 RunView 不重挂载、WS 不 re-arm](https://github.com/MountLynx/SpecModule_webview/issues/6)
- [#7 上游缺口：预检/建图缺省路径 cwd 锚定（search= 透传）](https://github.com/MountLynx/SpecModule_webview/issues/7)
- [#8 上游缺口：latest_tick 取历史最大值，深回退后 status.tick 偏高](https://github.com/MountLynx/SpecModule_webview/issues/8)
- [#9 技术债：paused 判定一行式三处内联（待第三形态收编库 control.paused()）](https://github.com/MountLynx/SpecModule_webview/issues/9)
- [#10 UI 小项：RunList 行内控制按钮无 busy 态](https://github.com/MountLynx/SpecModule_webview/issues/10)
- [#12 refine_spec 只取模块级 spec_schema——per-template 覆盖的模块会拿到空 schema](https://github.com/MountLynx/SpecModule_webview/issues/12)
- [#20 上游边缘：store.apply_update 对非 store-home 安装的 packed 模块会写 store 副本遮蔽原体；回滚窗口在备份清理后收窄（validate/哈希/manifest 写入失败不恢复旧版）](https://github.com/MountLynx/SpecModule_webview/issues/20)
- [#21 技术债：update 端点 OSError 捕获粒度（TEMP 失败误报「文件被占用」）；反解 _validate_draft 400 缺 module 键；build.py packs 面拆分候选](https://github.com/MountLynx/SpecModule_webview/issues/21)
- [#22 UI 谎言：创建器 SpecDialog 的 default_spec 编辑区不落盘（组装 manifest 无此键，库 packed 形态无 default_spec 契约）](https://github.com/MountLynx/SpecModule_webview/issues/22)

## 数据契约与错误处理

- 数据结构**全部复用** query.py 的 to_dict 出口（`timeline_to_dict` / `checkpoints_to_dict` /
  snapshot dict），status 字段形状与 feed.py 一致；**唯一新数据形状是 graph 结构**
  （nodes: id/label/type/inputs；edges: from/to）——序列化 `graph_to_dict` 已收编库共享层
  （CLI visualize 共用），`server/api/graph.py` 只留薄映射与状态叠加。
- 错误处理继承查询层容错哲学：查询层返回 None（无运行 / DB 读失败）→ 后端映射 404 +
  `{error: "无运行记录"}`；`create_checkpoint` 的 KeyError（消息带可用清单）→ 4xx 原样透出；
  未知 run_id → 404。

## 与原仓库的同步（统一 API 原则）

- **不重复构建**：HTTP 端点 = 库调用 + 传输级薄映射。出现第二个 Web 消费形态或 TUI 也需要
  相同逻辑（如 graph 序列化）时，共享逻辑**收编进库**（共享层函数），消费端只留薄映射；
  消费端代码里出现与 CLI/其他消费端重复的接线/校验逻辑即为违规——要么本轮收编上游，
  要么记录偏差并排期收编。值得统一的改动直接改 sibling 库仓库（遵守其 AGENTS.md），
  api.md 补录、库仓库独立提交，发新版后同步依赖。
- **库 API 文档同步完善**：消费新的 specmodule API 时，同步补录
  `../SpecModule/docs/references/api.md`（做到哪里写哪里，按消费增量生长）；文档变更在库仓库
  独立提交（`docs:` 前缀，遵循其 AGENTS.md），本仓库侧的完成记录归档进
  [finish.md](finish.md)。

## 验收

M1 + M2 双 module 全量接入：运行可视化 + 产出对比。

## 依赖

`specmodule` 库（`pip install specmodule`）+ Web 框架（FastAPI + uvicorn，仅本项目依赖）+
`httpx`（测试）；`web/` 前端：npm（Vite + React + React Flow + dagre，仅 web/ 内管理）。
