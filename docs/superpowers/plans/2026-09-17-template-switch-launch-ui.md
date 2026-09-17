# 启动界面优化（三）：模板切换联动 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 模块启动界面「模板」徽章成为唯一可点选择点，切换后 spec 字段表/spec 参考/SpecForm 联动换源，提交语义修复 CLI 回落错位；兼修上游 templates 形状变更导致的前端详情面板渲染崩溃。

**Architecture:** 上游库 per-template spec 通道已就位（`detail_to_dict` 的 `templates` 已是 `[{name, description, spec_schema, default_spec}]` 解析对象列表，回落逻辑库内 `spec_for` 单点），server 层纯透传零改动。本计划只动前端（`api.ts` 类型 + `ModuleDetail.tsx`）+ 补 server 形状锚定测试。SpecForm 以 `key={name}:{template}` 重挂载实现「切换即重置」——组件零改动。

**Tech Stack:** React + TS + Tailwind（web/，门禁 `npm run build` = tsc --noEmit + vite build）；pytest + httpx TestClient（server 测试，uv 运行）。

**Spec:** `docs/superpowers/specs/2026-09-17-template-switch-launch-ui-design.md`

**提交纪律:** 按 spec 提交切分，全部代码改动收口为**一个 feat commit**（含 roadmap 变更日志；设计文档已在 brainstorming 阶段单独提交 9e3b603）；计划归档另立 docs commit（镜像 0006835/0d46a8d 先例）。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `tests/test_manage_api.py` | 修改 | 增双模板 entry fixture + `templates` 解析对象列表形状锚定（覆盖生效 + 回落 entry 级） |
| `web/src/api.ts` | 修改 | `TemplateInfo` 接口 + `ModuleDetail.templates` 类型修正（string[] → TemplateInfo[]） |
| `web/src/components/ModuleDetail.tsx` | 修改 | 徽章可点合一、description 联动、三处换源、提交单点判定、select 移除 |
| `roadmap.md` | 修改 | 变更日志追加条目 |

上游 SpecModule 仓库零改动、无依赖动作（editable 锚定即生效）。

---

### Task 1: server 双模板形状锚定测试

**Files:**
- Modify: `tests/test_manage_api.py`（文件末尾追加）

**背景:** 上游已实施 per-template spec（SpecModule e821fa0），`store.detail_to_dict` 出口已是对象列表。本测试**预期直接 PASS**——它锚定的是消费端可见的透传契约（上游回落语义的可见性回归），不是 TDD 红灯；若 FAIL 说明上游回归，停止并报告，不要改库代码。

- [ ] **Step 1: 在 `tests/test_manage_api.py` 末尾追加 fixture 与测试**

模块级常量（放在文件顶部 `BASE_MODULE_SRC` 之后）：

```python
# 双模板 + per-template spec 覆盖：detail_to_dict templates 解析对象列表形状锚定
TWO_TEMPLATE_SRC = '''"""双模板 + per-template spec 覆盖测试模块。"""
from module_harness.cli.entry import ModuleEntry, TemplateSpec
from module_harness.infra.events import EventBus
from module_harness.core.registry import HarnessRegistry


def _registry_for(llm_client, template_name, event_bus):
    reg = HarnessRegistry(llm_client=llm_client, event_bus=event_bus or EventBus.null())

    @reg.script("A")
    def a(view):
        return {"done": True}

    return reg


entry = ModuleEntry(
    name="tmpl_mod",
    description="双模板测试模块",
    templates={
        "alpha": {"description": "alpha 描述"},
        "beta": {"description": "beta 描述"},
    },
    default_template="alpha",
    default_spec={"topic": "anchor"},
    spec_schema={"topic": "str"},
    template_specs={
        "beta": TemplateSpec(spec_schema={"raw_text": "str"}, default_spec={"raw_text": "x"})
    },
    build_registry=_registry_for,
)
'''
```

测试类（放在文件末尾 `TestModuleDetail` 之后）：

```python
class TestModuleDetailTemplates:
    def test_templates_parsed_objects_with_fallback(self, base_no_search_env, client):
        """templates 为解析后对象列表：beta 覆盖生效、alpha 回落 entry 级（消费端形状锚）。"""
        mods_dir = base_no_search_env / "modules"
        mods_dir.mkdir()
        (mods_dir / "tmpl_mod.py").write_text(TWO_TEMPLATE_SRC, encoding="utf-8")
        d = client.get("/api/modules/tmpl_mod").json()
        assert d["default_template"] == "alpha"
        assert d["templates"] == [
            {
                "name": "alpha",
                "description": "alpha 描述",
                "spec_schema": {"topic": "str"},
                "default_spec": {"topic": "anchor"},
            },
            {
                "name": "beta",
                "description": "beta 描述",
                "spec_schema": {"raw_text": "str"},
                "default_spec": {"raw_text": "x"},
            },
        ]
```

- [ ] **Step 2: 运行测试验证通过**

Run: `uv run pytest tests/test_manage_api.py -q`
Expected: 全部 PASS（含新用例）。若新用例 FAIL → 上游回落/形状回归，停止并报告。

- [ ] **Step 3: 不提交**（与 Task 2/3 收口同一 feat commit）

---

### Task 2: api.ts 类型修正（预期构建转红）

**Files:**
- Modify: `web/src/api.ts:163-175`

- [ ] **Step 1: 插入 `TemplateInfo` 接口并修正 `ModuleDetail.templates` 类型**

将（`web/src/api.ts:163-175`）：

```ts
/** 模块详情（store.detail_to_dict 形状；templates/submodules 为排序出名列表） */
export interface ModuleDetail {
  name: string;
  kind: string;
  path: string;
  version: string;
  description: string;
  default_template: string | null;
  templates: string[];
  default_spec: Record<string, unknown> | null;
  spec_schema: Record<string, string> | null;
  submodules: string[];
}
```

替换为：

```ts
/** 单模板解析对象（store.detail_to_dict 出口；spec 两键库内 spec_for 已按模板回落，前端零回落逻辑） */
export interface TemplateInfo {
  name: string;
  description: string; // 模板 JSON 自带，缺省 ""
  spec_schema: Record<string, string> | null;
  default_spec: Record<string, unknown> | null;
}

/** 模块详情（store.detail_to_dict 形状；templates 为解析后对象列表，submodules 为排序出名列表） */
export interface ModuleDetail {
  name: string;
  kind: string;
  path: string;
  version: string;
  description: string;
  default_template: string | null;
  templates: TemplateInfo[];
  default_spec: Record<string, unknown> | null;
  spec_schema: Record<string, string> | null;
  submodules: string[];
}
```

- [ ] **Step 2: 运行构建验证转红（ModuleDetail.tsx 消费点类型报错）**

Run: `cd web && npm run build`
Expected: **FAIL**——tsc 在 `ModuleDetail.tsx` 报类型错误（`d.templates[0]` 非 string、`key={t}`/`{t}`/`value={t}` 模板对象不合法等）。红灯 = 类型已如实反映上游形状、消费点待修，属预期中间态。

- [ ] **Step 3: 不提交**（与 Task 3 收口同一 feat commit）

---

### Task 3: ModuleDetail.tsx 模板切换联动改造（构建回绿）

**Files:**
- Modify: `web/src/components/ModuleDetail.tsx`（8 处 hunk，下述逐个给出）

以下 hunk 按文件自上而下顺序排列。`selected`/`activeSpec`/`activeSchema` 三个派生值是全部换源的唯一来源；`??  detail.*` 仅服务无模板模块（`selected == null`）路径。

- [ ] **Step 1: Hunk A——详情加载初始选中值（约 :62）**

将：

```tsx
        setTemplate(d.default_template ?? d.templates[0] ?? "");
```

替换为：

```tsx
        setTemplate(d.default_template ?? d.templates[0]?.name ?? "");
```

- [ ] **Step 2: Hunk B——派生值 + 提交禁用判空换源（:82-92）**

将：

```tsx
  const specEmpty = spec == null || Object.keys(spec).length === 0;
  const submitDisabled =
    busy ||
    spec == null || // JSON 非法（无效 spec 无从提交）
    (specEmpty && detail.default_spec == null); // 空且无缺省 → CLI 也无米下锅
  const hint =
    spec == null
      ? "spec JSON 非法——修正后才能启动"
      : specEmpty && detail.default_spec == null
        ? "spec 为空且模块无 default_spec——请至少填写一个字段"
        : null;
```

替换为：

```tsx
  // 选中模板派生值（per-template 解析对象已含库内回落；?? 仅服务无模板模块）
  const selected = detail.templates.find((t) => t.name === template) ?? null;
  const activeSchema = selected?.spec_schema ?? detail.spec_schema;
  const activeSpec = selected?.default_spec ?? detail.default_spec;
  const specEmpty = spec == null || Object.keys(spec).length === 0;
  const submitDisabled =
    busy ||
    spec == null || // JSON 非法（无效 spec 无从提交）
    (specEmpty && activeSpec == null); // 空且无参考 → CLI 也无米下锅
  const hint =
    spec == null
      ? "spec JSON 非法——修正后才能启动"
      : specEmpty && activeSpec == null
        ? "spec 为空且无参考 spec——请至少填写一个字段"
        : null;
```

- [ ] **Step 3: Hunk C——submit 提交语义单点判定（:99-104）**

将：

```tsx
      const r = await postLaunch({
        module: detail.name,
        // 未动过字段 → 不传 spec（CLI 回落 entry.default_spec，语义最准）；
        // spec 参考点击 → 显式传参考值（与表单当前值无关，见设计文档）
        spec: specOverride ?? (touched ? spec : null),
        template: template || null,
```

替换为：

```tsx
      // spec 显式性单点判定：能被 CLI 回落复现（未动过且与 entry 级 default_spec 相同）
      // → 不传（回落语义最准）；否则显式传表单当前值——切到带覆盖声明的模板后 pristine
      // 值与 entry 级不等，自然显式传，所见即所跑（修复 CLI 回落恒指 entry 级的错位）。
      // spec 参考点击 → 走 specOverride 显式通道，不受判定影响（见设计（一）/（三））。
      const fallbackEquals =
        !touched && JSON.stringify(spec) === JSON.stringify(detail.default_spec ?? null);
      const r = await postLaunch({
        module: detail.name,
        spec: specOverride ?? (fallbackEquals ? null : spec),
        template: template || null,
```

- [ ] **Step 4: Hunk D——模板徽章可点 + description 联动（:148-171）**

将整个「模板」区块：

```tsx
        <div className="mt-4">
          <div className="text-[12.5px] font-semibold">模板</div>
          {detail.templates.length ? (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {detail.templates.map((t) => (
                <span
                  key={t}
                  className={
                    "rounded-md border px-2 py-0.5 text-[11px] " +
                    (t === detail.default_template
                      ? "border-transparent bg-primary text-primary-foreground"
                      : "border-border bg-card")
                  }
                  title={t === detail.default_template ? "默认模板" : undefined}
                >
                  {t}
                  {t === detail.default_template ? "（默认）" : ""}
                </span>
              ))}
            </div>
          ) : (
            <div className="mt-1 text-muted-foreground">（无模板——模块自带流程定义）</div>
          )}
        </div>
```

替换为：

```tsx
        <div className="mt-4">
          <div className="text-[12.5px] font-semibold">模板</div>
          {detail.templates.length ? (
            <>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {detail.templates.map((t) => {
                  const isDefault = t.name === detail.default_template;
                  return (
                    <button
                      key={t.name}
                      type="button"
                      onClick={() => setTemplate(t.name)}
                      title={isDefault ? "默认模板" : undefined}
                      className={
                        "rounded-md border px-2 py-0.5 text-[11px] transition-colors " +
                        (t.name === template
                          ? "border-transparent bg-primary text-primary-foreground"
                          : "border-border bg-card hover:border-primary/60")
                      }
                    >
                      {t.name}
                      {isDefault ? "（默认）" : ""}
                    </button>
                  );
                })}
              </div>
              {selected?.description && (
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {selected.description}
                </div>
              )}
            </>
          ) : (
            <div className="mt-1 text-muted-foreground">（无模板——模块自带流程定义）</div>
          )}
        </div>
```

- [ ] **Step 5: Hunk E——spec 字段表换源（:173-188）**

将：

```tsx
        {detail.spec_schema && (
          <div className="mt-4">
            <div className="text-[12.5px] font-semibold">spec 字段</div>
            <table className="mt-1.5 border-collapse text-[12px]">
              <tbody>
                {Object.entries(detail.spec_schema).map(([k, t]) => (
```

替换为：

```tsx
        {activeSchema && (
          <div className="mt-4">
            <div className="text-[12.5px] font-semibold">spec 字段</div>
            <table className="mt-1.5 border-collapse text-[12px]">
              <tbody>
                {Object.entries(activeSchema).map(([k, t]) => (
```

- [ ] **Step 6: Hunk F——spec 参考换源（:191-223，四处 `detail.default_spec`）**

将「spec 参考」区块中四处数据源替换（条件、两次 submit 调用、stringify）：

```tsx
          {detail.default_spec != null ? (
```
→
```tsx
          {activeSpec != null ? (
```

```tsx
                onClick={() => submit({ ...detail.default_spec })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    submit({ ...detail.default_spec });
                  }
                }}
```
→
```tsx
                onClick={() => submit({ ...activeSpec })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    submit({ ...activeSpec });
                  }
                }}
```

```tsx
                {JSON.stringify(detail.default_spec, null, 2)}
```
→
```tsx
                {JSON.stringify(activeSpec, null, 2)}
```

（空态 `<pre>`「（模块未声明参考 spec——留空将使用模板缺省）」维持不变。）

- [ ] **Step 7: Hunk G——删除发起表单内 select（:228-244）**

整块删除：

```tsx
          {detail.templates.length > 1 && (
            <div className="mt-3">
              <div className="mb-1 text-[12px] font-semibold">模板</div>
              <select
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
                className="w-full max-w-[320px] rounded-control border border-input bg-transparent px-2 py-1 text-[13px]"
              >
                {detail.templates.map((t) => (
                  <option key={t} value={t}>
                    {t}
                    {t === detail.default_template ? "（默认）" : ""}
                  </option>
                ))}
              </select>
            </div>
          )}
```

- [ ] **Step 8: Hunk H——SpecForm 换源 + 模板 key 重挂载（:246-254）**

将：

```tsx
            <SpecForm
              key={detail.name}
              schema={detail.spec_schema}
              defaultSpec={detail.default_spec}
              onChange={(s, t) => {
                setSpec(s);
                setTouched(t);
              }}
            />
```

替换为：

```tsx
            <SpecForm
              key={`${detail.name}:${template}`}
              schema={activeSchema}
              defaultSpec={activeSpec}
              onChange={(s, t) => {
                setSpec(s);
                setTouched(t);
              }}
            />
```

（`key` 加模板段：切模板即重挂载——初始上报机制把新模板 pristine 值推回父级，即「切换重置」；SpecForm 组件本身零改动。）

- [ ] **Step 9: 运行构建验证回绿**

Run: `cd web && npm run build`
Expected: PASS（tsc --noEmit + vite build 全绿）。

---

### Task 4: roadmap 变更日志 + feat 收口提交

**Files:**
- Modify: `roadmap.md`（「## 变更日志」节末尾追加）

- [ ] **Step 1: roadmap.md 变更日志追加条目**

在「## 变更日志」节末尾（2026-09-16 启动界面优化一条目之后）追加：

```markdown
- 2026-09-17 **启动界面优化三：模板切换联动**——上游 per-template spec 通道（设计二）就位后
  消费端跟进：详情「模板」徽章可点切换（高亮跟随、「（默认）」缀标锚定默认模板、description
  显示于徽章下方），发起表单 `<select>` 移除两处合一；spec 字段表/spec 参考/SpecForm 随选中
  模板换源（库内 spec_for 解析值；切换即重置为新模板参考值，SpecForm 按 name:template key
  重挂载零改动）；提交 spec 显式性改 submit 单点判定（未动过且与 entry 级 default_spec 相同
  → 不传走回落；否则显式传——修复切模板后 CLI 回落恒指 entry 级与表单所见错位）。兼修
  api.ts templates 类型未跟上游形状变更导致的详情面板渲染崩溃。server 补双模板形状锚定测试。
  设计：docs/superpowers/specs/2026-09-17-template-switch-launch-ui-design.md
```

- [ ] **Step 2: 全量验证**

Run: `uv run pytest tests/test_manage_api.py -q`
Expected: PASS

Run: `cd web && npm run build`
Expected: PASS

- [ ] **Step 3: feat 收口提交（一个 commit，spec 提交切分）**

```bash
git add web/src/api.ts web/src/components/ModuleDetail.tsx tests/test_manage_api.py roadmap.md
git commit -m "feat(web): 启动界面模板切换联动——徽章可点合一+换源+提交单点判定（兼修新载荷形状崩溃）"
```

---

### Task 5: 手动验收（浏览器，academic_writer 试剂）

**前置:** 后端 `uv run uvicorn server.app:app --port 8000`；前端 `cd web && npm run dev`（:5173）。主代理可用 browser-use 执行；或交用户走查。

- [ ] **Step 1: 崩溃修复 + 徽章交互**

打开 http://localhost:5173 → 活动栏「模块」→ academic_writer，逐项核对：
1. 详情面板正常渲染（不再空白/报错——崩溃修复）；
2. 徽章两枚：`academic_writer（默认）` 初始选中（黑底）；点击 `academic_writer_detailed` → 高亮移动到它，「（默认）」缀标留在前者；
3. 徽章行下方 description 跟随切换（默认/详细两段描述文案不同）；
4. 发起表单内**无** select 下拉。

- [ ] **Step 2: 联动与提交语义**

5. 两模板同契约 → 切换后 spec 字段表（`raw_text: str`）与表单预填值不变（切换重置后 pristine 值相同，属诚实表现）；
6. spec 参考块显示 JSON，点击 → 202 → 自动切「运行历史」打开新 run（提交模板 = 当前选中）；
7. 选 detailed 模板 + 勾选 `--mock` 发起 → 运行图里事实审阅 loop **内联展开**（对照默认模板发起的 submodule 黑盒图）——证明 `template` 参数真实生效。

- [ ] **Step 3: 单模板/无模板对照**

8. ppt_master（单模板）：单徽章呈选中态、点击无变化、description 照常显示、发起正常；
9. 任一 packed/pip 无模板模块：「（无模板——模块自带流程定义）」空态、无徽章、spec 表单走模块级声明。

发现问题 → 回 Task 3 修复（fix-up 并入同一 feat commit 或紧随 fix commit）。

---

### Task 6: 计划归档

- [ ] **Step 1: 归档提交**

```bash
git add docs/superpowers/plans/2026-09-17-template-switch-launch-ui.md
git commit -m "docs: 启动界面优化（三）模板切换联动实施计划归档"
```
