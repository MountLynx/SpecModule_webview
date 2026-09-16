# 模块启动界面优化（三）：模板切换联动设计

日期：2026-09-17
状态：已确认（用户逐项决策）

## 背景与证据

- 设计二（per-template spec 上游扩展，`2026-09-16-per-template-spec-upstream-proposal.md`）已由用户在上游实施完毕：`detail_to_dict` 的 `templates` 已是解析后对象列表 `[{name, description, spec_schema, default_spec}]`（回落逻辑库内 `ModuleEntry.spec_for` 单点），CLI run/resume 的 schema 校验已按模板解析（SpecModule e821fa0 / 3e81063）。server 层纯透传（`server/api/manage.py` 无形状逻辑）零改动即就位；现有 server 测试只锚空 templates 场景，不受形状变更影响。
- **前端当前已崩**：`web/src/api.ts` 类型停留在 `templates: string[]`，`ModuleDetail.tsx` 徽章把模板对象直接当 React 子元素渲染（`{t}`）→ 任何带模板的模块（academic_writer / ppt_master 等）详情面板一打开即渲染崩溃（tsc 不报——类型声明本身是错的）。本轮首先是必要的形状修复，其次才是 UX 改造。
- 交互现状（设计二「消费端契约预期」节锁定的问题）：详情区「模板」徽章纯静态不可点（默认模板黑底高亮），发起表单内另有 `<select>` 下拉（仅 `templates.length > 1` 时渲染）——两处重复；切换模板零联动（徽章高亮、SpecForm、spec 参考、spec 字段表均不跟随选中）。
- 提交语义坑：上游 CLI 的 default_spec 回落仍指 entry 级（`cli.py:131 _resolve_spec`，设计二有意只改 schema 校验、不动回落）——若沿用「未动过 → 不传 spec」，切到非默认模板后 CLI 会拿 entry 级值按新模板 schema 校验：跨契约时校验失败或用了与表单所见不同的值；默认模板自带覆盖声明时同理不一致。

## 用户决策（设计输入）

1. 切换模板时已动过（touched）的表单输入 → **重置为新模板参考值**（重挂载语义，同设计二提案原文；否决「保留同名字段输入」——跨契约时同名字段可能语义已变，保留反而危险）。
2. 实施方案 → **A：key 重挂载 + submit 单点判定**（SpecForm 组件零改动；否决受控重置 B——组件 API 复杂化无实益；抽 TemplatePicker 独立组件 C 暂不做，ModuleDetail 膨胀时再说）。
3. 界面形态 → 按设计二「消费端契约预期」节执行（徽章可点合一、select 移除、联动换源）。

## 目标与非目标

**目标**

1. 前端修复新载荷形状——带模板模块详情面板恢复正常渲染（`api.ts` 类型 + 徽章渲染）。
2. 模板区成为唯一模板选择点：徽章可点切换，高亮跟随选中，「（默认）」缀标锚定默认模板不随选移动；选中模板 description 显示于徽章下方。
3. 选中模板联动：spec 字段表、spec 参考、SpecForm 全部换源为该模板解析值；发起提交 `template` = 选中模板、spec 显式性 submit 单点判定。

**非目标**

- 上游任何改动（per-template 通道已就位；CLI default_spec 回落仍 entry 级是有意保持——由前端显式传参对齐语义，不改库）。
- server 层改动（纯透传已就位；仅补形状锚定测试）。
- 抽 TemplatePicker 独立组件（单消费点，YAGNI）。
- 切换时保留用户输入 / 弹确认框（已定重置）。
- spec 字段级合并机制（替换语义是库契约，设计一/二一贯，不动）。

## 设计

### 数据与类型（`web/src/api.ts`）

`ModuleDetail.templates: string[]` → `TemplateInfo[]`：

```ts
/** 单模板解析对象（store.detail_to_dict 出口；spec 两键库内 spec_for 已按模板回落） */
export interface TemplateInfo {
  name: string;
  description: string; // 模板 JSON 自带，缺省 ""
  spec_schema: Record<string, string> | null;
  default_spec: Record<string, unknown> | null;
}
```

类型注释同步说明「spec 两键已由库按模板解析，前端零回落逻辑」。前端所有 per-template 取值只读 `TemplateInfo`，不重复实现回落。

### 模板选择 UI（`web/src/components/ModuleDetail.tsx`）

- 选中模板状态：复用现有 `template` state（语义已是「选中模板」），初始值链不变（`default_template ?? templates[0].name ?? ""`）。`selected = detail.templates.find(t => t.name === template) ?? null`。
- 「模板」区徽章 `<span>` → `<button>`：高亮跟随选中（选中 = `bg-primary text-primary-foreground`，未选 = 卡片底 + hover 提升可点暗示）；「（默认）」文字缀标与 `title` 仍锚定 `default_template`，不随选中移动。
- 徽章行下方显示选中模板 `description`（非空时，11px muted 一行）——设计二顺带修复「模板描述在消费端不可见」。
- 发起表单内 `<select>` 整块删除——两处合一，模板区成为唯一选择点。

### 联动换源（「下方的都跟着换」）

| 区块 | 现数据源 | 改为 |
|---|---|---|
| spec 字段表 | `detail.spec_schema` | `selected?.spec_schema ?? detail.spec_schema` |
| spec 参考（可点试运行） | `detail.default_spec` | `selected?.default_spec ?? detail.default_spec`；点击 = 以该参考值 + 当前选中模板发起（既有 `specOverride` 通道） |
| SpecForm | entry 级 schema/defaultSpec | selected 解析值；`key={detail.name}:{template}` 重挂载 |

- 重挂载即「切换重置」：SpecForm 零改动，其初始上报机制天然把新模板 pristine 值（touched=false、spec=该模板解析 default_spec）推回父级。
- 提交禁用判空同步换源：`specEmpty && (selected?.default_spec ?? detail.default_spec) == null`；`hint` 文案同源。
- `??  detail.*` 仅服务 `selected == null`（无模板模块）一条路径；有模板时 per-template 解析值已含 entry 回落，直接用。

### 提交语义（单点判定，修复回落错位）

`submit` 内一次 JSON 比较：

```ts
// spec 载荷：能被 CLI 回落复现 → 不传（回落语义最准）；否则显式传表单当前值
const fallbackEquals =
  !touched && JSON.stringify(spec) === JSON.stringify(detail.default_spec ?? null);
spec: fallbackEquals ? null : spec,
```

- 切换模板后重挂载上报 pristine 新值：与 entry 级相等（同契约）→ 不传，CLI 回落精确复现所见；不等（该模板带覆盖声明）→ 显式传，所见即所跑。两分支语义都对。
- 规则同时覆盖「默认模板自带覆盖」边角：初始未动也会因值不等而显式传。
- spec 参考点击走既有显式 `specOverride` 通道（设计一），不受该判定影响；参考值随模板换源后，点击 = 选中模板的参考 + 选中模板。
- `template` 载荷 = 选中模板名（现状语义平移；`""` → null，无模板模块维持 null）。
- 键序说明：比较两侧同源于 detail 载荷（pristine 值 = `{...defaultSpec}` 展开保序），小对象 stringify 开销可忽略；touched 值本就不等，无键序风险。

### 边界场景

- **无模板**（packed/pip，`templates=[]`）：「（无模板——模块自带流程定义）」空态不变、无徽章、无 description；selected=null 全走 entry 级——现状保持。
- **单模板**：单徽章呈选中态，点击无变化（幂等 setState）；description 照常显示。
- **busy 中切模板**：无碍（请求体在提交瞬间已快照，in-flight 不受 state 变化影响）。

## 测试与验收

- **server 测试**（`tests/test_manage_api.py`）：新增双模板 entry fixture（`templates={"alpha": {"description": "alpha 描述"}, "beta": {"description": "beta 描述"}}` + `default_template="alpha"` + `template_specs={"beta": TemplateSpec(spec_schema={"raw_text": "str"}, default_spec={"raw_text": "x"})}` + entry 级 `spec_schema`/`default_spec`），断言 `templates` 对象列表形状：对象键集 `{name, description, spec_schema, default_spec}`、alpha 两键回落 entry 级、beta 覆盖生效、description 取模板 JSON——锚定消费端可见的透传契约（上游回落语义的可见性回归）。
- **前端门禁**：`cd web && npm run build`（tsc --noEmit + vite build）。
- **手动验收**（academic_writer，dev server）：
  1. 详情面板正常渲染（崩溃修复）；徽章可点、高亮跟随、「（默认）」缀标不随选移动、description 跟随、表单内 select 消失；
  2. 两模板同契约 → 切换时表单字段与值不变（诚实表现，切换重置后的 pristine 值相同）；
  3. 以 detailed 模板 + `--mock` 发起 → 运行图事实审阅 loop 内联展开（对照默认模板 submodule 黑盒）——证明 `template` 参数真实生效；
  4. spec 参考点击 → 以当前选中模板发起。

## 提交切分

本仓库一个 commit：`web/src/api.ts` + `web/src/components/ModuleDetail.tsx` + `tests/test_manage_api.py` + 本设计文档 + roadmap.md 变更日志。上游零改动、无依赖版本动作（editable 锚定即生效）。
