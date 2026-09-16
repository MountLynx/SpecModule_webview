# 模块启动界面优化（二）：per-template spec 上游扩展提案

日期：2026-09-16
状态：提案已确认（用户定案：上游声明式扩展、覆盖式+回落；**上游实施由用户执行，本文档为实施依据**；webview 消费端联动另立轮次）

## 背景与证据

启动界面（`web/src/components/ModuleDetail.tsx`）模板区现状：

- 详情区「模板」徽章为纯静态 `<span>`（列出全部 + 默认模板高亮），发起表单里另有 `<select>` 下拉（仅 `templates.length > 1` 时渲染）——两处重复且位置割裂；切换模板零可见反馈（SpecForm、spec 参考展示、徽章高亮均不跟随选中）。
- per-template 数据现状：模板 JSON 自带 `description`（`TasklistTemplate` 契约字段，academic_writer 两模板描述不同且有意义），但 `detail_to_dict` 瘦身为名字列表（`store.py` → `templates: sorted(resolved.templates)`），描述在消费端不可见。
- spec 契约锚定现状：`spec_schema`/`default_spec` 是 entry 级（`cli/entry.py`）；CLI 校验单点 `_check_spec_schema`（`cli/cli.py:169`），调用点为 `_cmd_run` 与 `_run_resume_cmd`（run + resume/rollback 共用），且当前**先校验后定模板名**（顺序需调换）。

「换模板 → spec 变」的场景盘点（本轮设计输入，用户确认）：

- 现有实证：academic_writer 默认 vs 详细——**同契约不同流程形式**（submodule 黑盒 vs 内联展开）；ppt_master 与四个 builtin 模板均单模块单模板。框架当前把 spec 契约锚在模块（entry 级 schema + CLI validate 按模块校验）、模板锚在流程形式。
- 真实但尚未实例化的场景：①同一产出、不同输入通道（如 ppt_master 未来「从主题生成」vs「从既有文档改写」——字段集不同，拆模板比 spec 字段二选一干净）；②深度模式带额外参数（超集关系）；③LLM harness 翻译器模板（prompt 决定 `{spec.*}` 引用，多模板天然可不同）。
- 结论：场景真实、当前无试剂，但 webview 启动界面的模板切换联动需要该数据管道先行——先扩上游契约，消费端随后。

## 用户决策（设计输入）

1. 方案档位：**上游声明式扩展**（ModuleEntry per-template spec 声明能力）——不做纯前端 `{spec.*}` 占位符推导（最佳努力、动态翻译器失真），也不止步于仅透出描述。
2. 声明形态：**覆盖式+回落**——entry 级字段保留为缺省，新增 per-template 覆盖声明，只声明有差异的模板。
3. 本轮只产出本提案文档；上游（SpecModule 仓库）由用户实施。

## 目标与非目标

**目标**

1. ModuleEntry 支持按模板覆盖 spec_schema/default_spec：覆盖式+回落语义，单点解析函数。
2. CLI run/resume/rollback 的 spec 校验按选中模板解析 schema。
3. `detail_to_dict` 载荷透出 per-template 解析结果（name/description/spec_schema/default_spec）——回落逻辑在库内，消费端零解析（薄层纪律）。

**非目标**

- packed/pip 模块通道（无 templates，归一为空 dict；SubModule 无 per-template 概念）。
- 模板 JSON 内嵌 spec 声明（混淆「流程模板」与「输入契约」两个关注点，已否决）。
- webview 端模板徽章切换合并 UI（另立轮次，契约见「消费端契约预期」节）。
- `{spec.*}` 占位符推导（声明式已定案，推导退役）。
- 字段级合并/字段级默认值机制（spec 替换语义是库契约，与设计（一）一致，不动）。

## 上游 API 设计（SpecModule 仓库）

### ModuleEntry 增量

```python
@dataclass
class TemplateSpec:
    """单模板的 spec 覆盖声明：未声明字段逐项回落 entry 级。"""
    spec_schema: dict[str, str] | None = None
    default_spec: dict[str, Any] | None = None


@dataclass
class ModuleEntry:
    ...
    template_specs: dict[str, TemplateSpec] = field(default_factory=dict)  # {模板名: 覆盖声明}
```

- `__post_init__` 校验：`template_specs` 键 ⊆ `templates` 键；未知模板名 → `ValueError` 带差集与可用清单（与 `default_template` 校验同风格）。
- **字段级独立回落**：覆盖对象里 `spec_schema is None` → 回落 `entry.spec_schema`；`default_spec is None` → 回落 `entry.default_spec`。两键互不联动（只覆盖 default_spec 时 schema 仍回落模块级——契约稳定、样例值可换）。

### 解析单点：ModuleEntry.spec_for

```python
def spec_for(self, template_name: str | None) -> tuple[dict[str, str] | None, dict[str, Any] | None]:
    """按模板解析 (spec_schema, default_spec)：覆盖 > entry 级回落。

    template_name None（tasklist 直通通道）或该模板未列覆盖 → 全回落
    entry 级；未注册模板 → ValueError（与 build_module 同文案风格）。
    """
```

- 唯一解析入口：CLI 校验、detail 载荷、未来消费端全部经它——不允许第二份回落逻辑。

### CLI 校验改造（cli/cli.py）

- `_check_spec_schema(entry, spec, template_name)`：schema 取 `entry.spec_for(template_name)[0]`（函数内不再直接读 `entry.spec_schema`——解析已含回落）。
- 两处调用点 `_cmd_run` 与 `_run_resume_cmd`：**先定 `template_name = args.template or res.default_template`，再校验**——当前顺序相反，需调换两行。
- resume/rollback 语义：恢复本就可选与存档不同的模板（cli-usage.md「模板与存档来源」节），按**本次选择的模板**解析校验——行为不变，仅 schema 来源变 per-template。
- `--tasklist` 与 `--template` 互斥校验在两命令入口已有，不重复。

### detail_to_dict 载荷（infra/store.py）

`templates` 从名字列表改为**解析后对象列表**（排序保稳定）：

```json
"templates": [
  {"name": "academic_writer",
   "description": "…（模板 JSON 自带 description，缺省 \"\"）",
   "spec_schema": {"…": "…"},
   "default_spec": {"…": "…"}}
]
```

- `description` 取模板 JSON 的 `description` 字段（顺带修复描述在消费端不可见的现状）。
- `spec_schema`/`default_spec` = `entry.spec_for(name)` 解析结果——回落逻辑在库内，消费端（webview/TUI/MCP）零解析。
- **形状变更（breaking）**：`templates: [名]` → `templates: [{…}]`。api.md 同步补录并标注；实施时检查 TUI/MCP 兄弟消费端是否依赖旧形状，若有则同步适配。
- 其余键（`default_template`/`default_spec`/`spec_schema`/`submodules`）不变——模块级缺省仍可独立消费。

## 消费端契约预期（webview，另立轮次实施）

记录 payload 必须服务的启动界面形态，上游实施时以本节为验收镜：

1. 详情区「模板」徽章改为可点击切换（单选，默认模板初始选中），发起表单内 `<select>` 移除——两处合并为一处。
2. 选中模板联动：徽章高亮跟随选中；模板 description 显示于徽章下方；SpecForm 以该模板解析结果重挂载（schema/default_spec 换源）。本试剂两模板同契约 → 表单不变，属诚实表现。
3. 发起提交 `template` 参数 = 当前选中模板（现状 select 的语义平移）。

## 示例与迁移

- academic_writer：**不动**。两模板同契约，entry 级声明（设计（一）已定）即回落路径的自然回归证明；不伪造差异。
- 首个真实差异场景出现时（如 ppt_master 双输入通道）用 `template_specs` 声明，作为 per-template 通道的首个试剂。
- scaffold 生成骨架可在注释中示例 `template_specs`（可选，不阻塞）。

## 测试要点（上游）

1. `__post_init__`：template_specs 未知模板键 → ValueError；空 dict 合法。
2. `spec_for` 矩阵：无覆盖 / 只覆盖 schema / 只覆盖 default_spec / 全覆盖 / `template_name=None` / 未注册模板名。
3. `detail_to_dict`：templates 对象列表形状、描述缺省 `""`、解析结果与 `spec_for` 一致；packed 模块 `templates: []` 不受影响。
4. CLI：run 与 resume 以 `--template X` 选覆盖模板时按覆盖 schema 校验（最小 fixture：两模板不同 schema 的 entry）；回落路径（无覆盖）行为与现状一致。
5. 库基线：`uv run pytest module_harness/tests/ -q -m "not smoke"`。

## api.md 补录清单（SpecModule 仓库）

- `ModuleEntry` 字段段：补 `template_specs`；新增 `TemplateSpec` 数据类行。
- `ModuleEntry.spec_for` 方法行（解析语义 + ValueError 契约）。
- `detail_to_dict` 行：templates 形状变更（名字列表 → 解析对象列表）+ 破坏性标注。
- 设计（一）的 `default_spec`/`spec_schema` 为既有字段，不在本清单。

## 实施与提交切分（SpecModule 仓库，用户执行）

1. `cli/entry.py`：TemplateSpec + `ModuleEntry.template_specs` + `__post_init__` 校验 + `spec_for`。
2. `cli/cli.py`：`_check_spec_schema` 签名 + 两处调用点顺序调换。
3. `infra/store.py`：`detail_to_dict` templates 形状。
4. `docs/references/api.md` 补录（docs: 前缀，独立提交）。
5. 库基线全绿后，本仓库另立「启动界面优化（三）：模板切换联动」实施轮消费新载荷。
