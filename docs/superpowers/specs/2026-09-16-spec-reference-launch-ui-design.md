# 模块启动界面优化（一）：spec 参考试运行设计

日期：2026-09-16
状态：已确认（用户逐项决策）

## 背景与证据

启动界面（`web/src/components/ModuleDetail.tsx`）的「default_spec」区块现状：

- 展示 `entry.default_spec`（库声明值），为 null 时显示「（无——运行时留空 spec 将使用模板缺省）」——纯信息展示，无交互。
- 库语义（`module_harness/cli/cli.py:132 _resolve_spec`）：`--spec` > `--spec-file` > `entry.default_spec`，**替换语义**——只要调用方给了 spec（哪怕一个字段），default_spec 整体不参与；三者全无 → 「缺少 spec」硬错误。它是「零配置可跑」的兜底，不是字段级默认值。
- 试剂 academic_writer 现状：`default_spec=null`、`spec_schema=null` → 详情区块空态无引导、发起表单空白、「spec 字段」表整块隐藏；但模块契约明确（`example/academic_writer.py:13`：input `{raw_text: str}` + 可选 `target_field`/`max_words`），且库里已有样例 spec（`example/spec.academic_writer.json`，单字段 `raw_text`）。
- 对照：ppt_master 刻意声明 `default_spec=None`（"页册因项目而异，无零配置缺省"）——声明值的含义就是"存在诚实的零配置输入"。

## 用户决策（设计输入）

1. 「spec 参考」= 现有 `default_spec` **纯前端改名**，不做历史回落、不做合成。
2. 点击参考 = **直接尝试运行**（方案 A：走既有 submit 路径，单一启动入口）。
3. academic_writer 缺声明值 → **上游补**：`default_spec` + `spec_schema` 一起。

## 目标与非目标

**目标**
1. 「default_spec」区块更名「spec 参考」，有参考时可一键试运行。
2. 试剂模块有真实参考值 + spec 字段表可见。
3. 薄层纪律：无平行启动逻辑、无新状态机、无历史/合成机制。

**非目标**
- 模板切换的可见性反馈（徽章高亮不跟随选中、切换零反馈）——另立设计。
- per-template spec schema（上游 `ModuleEntry` 契约是 entry 级单 schema，本设计不扩契约）。
- spec 字段级合并/字段级默认值机制（替换语义是库契约，不动）。
- 历史 run spec 回填发起表单（恢复对话框 resume 预填已具备该能力，不重复建设）。

## 上游库改动（SpecModule 仓库，独立提交）

`example/modules/academic_writer.py` 的 `ModuleEntry` 补两个字段：

```python
default_spec={
    "raw_text": (
        "灵感草稿：用大模型做代码评审——LLM 分析 diff，生成按 severity 分类的"
        " comments；在 200 个 PR 上 accuracy 85%，比规则 baseline 高 15 个百分点。"
    )
},
spec_schema={"raw_text": "str"},
```

- 值取自库内样例草稿压缩版：短、真实感、零配置可跑通两条模板。
- `spec_schema` 让 UI「spec 字段」表亮起（现因 null 整块隐藏），一并补齐启动引导。
- **同步已安装副本** `~/.specmodule/modules/academic_writer.py`：保留其 `_lib` sys.path 引导头（store 自包含布局），只在 `ModuleEntry(...)` 补同两字段。store 副本是文件级安装、不经包依赖链，**无需发版**；仓库源是事实源头，两处同时改。
- `docs/references/api.md` 不动：`default_spec`/`spec_schema` 是既有字段，非 API 增量。

## webview 前端（本仓库，仅 `web/src/components/ModuleDetail.tsx`）

1. **更名与空态**：区块标题「default_spec」→「spec 参考」；空态文案改「（模块未声明参考 spec——留空将使用模板缺省）」。
2. **可点参考**：`default_spec != null` 时 pre 块可点（`cursor-pointer` + hover 高亮），下方提示行「点击用参考 spec 尝试运行」；无参考时维持纯展示、不可点、无提示行。
3. **点击行为**：调用既有 `submit()`，spec 显式传参考值（`submit` 增加可选显式 spec 参数，绕过 touched 判断）；模板、run_id、max_ticks、mock 全取表单当前值。busy 时点击无效（与提交按钮同 disabled）。**表单已被改动时点参考同样以参考值为准**——两个入口的分工：「点击参考」= 用参考跑，「发起运行」= 用表单当前 spec 跑。
4. **等价性说明**：表单未动时直接「发起运行」本来就不传 spec、由 CLI 回落 `entry.default_spec`，与「点击参考」结果一致——本改动是**可发现性增强**（把参考变成看得见摸得着的入口），不加新状态、不建第二启动路径。
5. SpecForm 无需改：`defaultSpec` 预填链路已存在，上游补值后表单自动出现参考值供微调；`submitDisabled` 的 `specEmpty && default_spec == null` 判空语义不变。

## 测试与验收

- 前端门禁：`cd web && npm run build`（tsc --noEmit + vite build）。
- 库基线：`uv run pytest ../SpecModule/module_harness/tests/ -q -m "not smoke"`（entry 改动不碰库代码，按惯例跑）。
- 试剂验收（academic_writer）：
  1. 详情页「spec 参考」显示 JSON（非空态文案），「spec 字段」表出现 `raw_text` 行；
  2. 发起表单预填 `raw_text` 参考值；
  3. 点击参考块 → 202 → 自动切运行页签打开新 run（--mock 验证流程，真跑由用户定）。
- 空态对照（ppt_master）：「spec 参考」维持「（模块未声明参考 spec…）」，不可点、无提示行。

## 提交切分

1. SpecModule 仓库：`example/modules/academic_writer.py` 补字段，独立 commit（遵循其 AGENTS.md）。
2. `~/.specmodule/modules/academic_writer.py`：文件级同步（store 不在 git 内）。
3. 本仓库：`web/src/components/ModuleDetail.tsx` + 本设计文档 + roadmap.md 变更日志，一个 commit。
