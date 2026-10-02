<!--
  SpecModule 框架知识 · 策展快照 v1（2026-09-30）

  压缩自兄弟库文档：README.md + docs/concepts/SpecModule.md
  + docs/guides/{tutorial-first-module,store-walkthrough,config-guide}.md。
  同步纪律：库面演进（概念增删/命令面变化/阶段机调整）时同步本文件；
  只写可从上述文档核实的内容，细节以库文档为准。
-->

# SpecModule 框架知识

## 定位

SpecModule 是一个**可审计、可调试、可完全掌控**的 LLM 使用框架（Python，PyPI 包名 `specmodule`）。

核心思想：把一次 LLM 任务拆成多个可组合的**节点**（Petri 网式有向图：支持 AND/OR 汇合、条件边、循环），引擎同步步进执行，**每 tick 落盘轻量快照**。所有节点的输入输出全部留痕，因此运行可审阅（tick 时间线）、可调试、可从任意 tick 精确回退重跑。

设计原则：**完全掌控**（无隐式行为，配置错误直接报错、框架不猜不兜底）；**审计即设计**（快照/回滚/跨进程查询是内置能力）；**模型能力无关**（工具逻辑放独立 script 节点，不依赖模型的工具调用能力）。

## 架构分层

- `tickflow`（外部 pip 包 `tickflow-py`，import 名 `tickflow`）：Petri 网工作流引擎——节点/边/guard/join/循环，同步步进。
- `llm/`：LLM 客户端层（Anthropic + OpenAI 兼容后端）。配置回退链：`os.environ` → 项目根 `.env`（key）/`config.json`（provider 与 model 注册表）/`rules.txt`（注入每次调用的 system 最前）→ `~/.specmodule/` 同名文件兜底。
- `module_harness/`：上层抽象——`Module` 编排器（run/resume/rollback）、`HarnessRegistry`（注册 harness/script/command）、spec→tasklist 翻译与一致性审核、store 模块管理、`specmodule` CLI。
- 运行产物：`<工作目录>/.specmodule/runs/<run_id>/`（`run.sqlite` 逐 tick 快照 + `status.json` 阶段机 + `stream.log`），**跨进程可查**，不依赖运行进程存活。阶段机：idle → translating → reviewing → building → ready → running → done | aborted | cancelled | truncated。

## 模块 = 四个概念

| 概念 | 是什么 |
|---|---|
| **spec** | 「想要什么」——结构化键值对，无预定义 schema，字段含义由模块作者定义 |
| **tasklist** | 「如何做」——`{Tasks, Flow}`：每个 Task 一个执行节点；Flow 是 tickflow DSL（`[A]` 起始、`-->` 数据边、`--|guard|-->` 条件边） |
| **执行元件** | 三类节点：**harness**（LLM 调用：三层 prompt——`prompt_core` 必要能力 / `prompt_modes` 按情境选择性注入 / `prompt_extra` 人工补充，配输出格式校验与流式）；**script**（纯 Python 函数，承担通常 agent 里 tool 的职责——单节点最小单元、无工具循环、上下文压力小）；**command**（shell 命令） |
| **submodule** | tasklist 固定、spec 强模板化的「固定箱子」；pack 打包发布、可被其他模块组合 |

harness prompt 里的 `{字段}` 占位符由 Task 的 `inputs` 解析（可引用 `{spec.xxx}` 或上游节点输出）；script 用 `view.field("绑定名")` 读上游输出（绑定名 = Task inputs 的键）。

## 两种输入通道

- **spec-only（翻译通道）**：只给 spec，模块模板（`TasklistTemplate`）把它翻译成 tasklist 再执行。翻译器两种：harness 翻译器（LLM 按 spec 内容动态设计流程）、script 翻译器（确定性、零 LLM 成本）。适合流程由内容驱动、多变的场景。
- **spec + tasklist（直写通道）**：两者都给，先过**一致性审核**（spec↔tasklist 语义检查，不一致 `ConsistencyError` 阻塞），spec 作为目标约束，用于判断执行是否偏移。适合流程固定可预测。
- 运行中另有**对齐检查**：每 n tick 用 LLM 判断产出是否偏离 spec，偏离则截断提醒——与运行前的一致性审核是两回事。

## 使用闭环（跑别人的模块）

```bash
pip install specmodule
specmodule setup                  # 交互配置 provider/model/key → 写 ~/.specmodule/
specmodule install <pack 目录 | git URL>   # 获取模块；list / info 查看
specmodule run --module <名> --spec '{"text": "……"}' [--mock]
```

- `--mock`：内置假 LLM，免 key 免网络冒烟——验证流水线形状，不验证内容。
- 流程二选一（互斥）：`--template <名>`（翻译通道）或 `--tasklist <文件>`（直写通道）。
- spec 解析优先级：`--spec` 内联 > `--spec-file` > 模块 `default_spec`。
- 观察调试：`status`（状态）、`review`（tick 时间线，`--failed` 只看失败）、`checkpoints` + `rollback <tick>`（精确回退）、`resume`（中断后续跑）、`snapshot`、`runs`（历史枚举）、`artifacts`（产物清单）；运行控制 `cancel` / `pause` / `unpause`。
- 更新/卸载：`update`（按安装清单 sha256 脏检测，本地改过的文件交互确认、绝不静默覆盖）、`uninstall`。
- 模块搜索路径（前面优先）：`cwd/modules` → `$SPECMODULE_PATH` → `~/.specmodule/modules`（store）→ pip entry points。

## 写模块（开发者路径）

`specmodule init` 生成脚手架 → 一个模块一个 py 文件，声明 `ModuleEntry`（`build_registry` 注册 harness/script；`templates` 声明翻译通道；`default_spec` 兜底）→ 写 tasklist → `specmodule publish` 发布进 store（pack 格式：`module.json` 清单 + `harnesses/` + `scripts/` + `commands/` + `guards/` + `submodules/`），其他使用者即可 `install` 运行。

## 生态与当前界面

可视化消费端即**当前界面 SpecModule_webview**（模块库 / 运行视图 / 组件库 / 对话）；对话内切换「模块运营」模式可实际查看模块库、完善 spec、发起与监控运行。其他消费端：TUI、MCP（独立仓库）。设计上 SDK 先行：查询接口是共享层，CLI/Web 等消费端只是薄封装。

## 这份知识的边界

本文件是策展快照，覆盖全貌与上手。更深的细节以库文档为准：CLI 参数全集 `docs/references/cli-usage.md`（或 `specmodule --help`）、harness/模板语法 `spec-harness-syntax.md`、执行语义（join/死锁陷阱）`tickflow-integration.md`、编程 API `api.md`。知识里没有的细节如实说不知道，不编造。
