# Spec 参考试运行（启动界面优化一）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 启动界面「default_spec」区块更名「spec 参考」并在有参考时点击即以参考 spec 发起运行；试剂模块 academic_writer 上游补 `default_spec`/`spec_schema` 使参考真实可用。

**Architecture:** 纯前端交互增强——点击走既有 `submit()` 路径（唯一启动入口，无平行逻辑、无新状态）；上游 entry 数据补齐采用「仓库源 + store 安装副本」双同步（store 副本是文件级安装，不经包依赖链，无需发版）。server 零改动：`GET /api/modules/{name}` 已透传两字段（`store.detail_to_dict`），前端 `api.ts` 类型已就绪。

**Tech Stack:** React + TS + Tailwind（`web/`，验收门禁 `npm run build`）；pytest（上游 example 测试）；webview venv（`uv run`，specmodule editable）。

**设计文档:** `docs/superpowers/specs/2026-09-16-spec-reference-launch-ui-design.md`

**关键语义备忘（执行者必读）:**
- 库 spec 解析是**替换语义**（`--spec` > `--spec-file` > `entry.default_spec`，`module_harness/cli/cli.py:132`）——default_spec 只在调用方完全不传 spec 时兜底。
- 表单未动（touched=false）时提交不传 spec → CLI 回落 default_spec，与「点击参考显式传参考值」**结果等价**；点击参考的定位是可发现性增强。两入口分工：**点参考 = 用参考跑；发起运行 = 用表单当前 spec 跑**（表单改过也以参考为准）。
- 仓库 cwd 差异：本计划命令涉及三个目录——SpecModule 仓库（`C:/Users/xingy/Desktop/开发/SpecModule`）、webview 仓库（`C:/Users/xingy/Desktop/开发/SpecModule_webview`）、store 安装副本（`~/.specmodule/modules/`，不在任何 git 内）。上游测试用 webview 的 venv python 直接跑（specmodule editable 已装）。

---

### Task 1: 上游——试剂 entry 补 default_spec + spec_schema（SpecModule 仓库，TDD）

**Files:**
- Test: `C:/Users/xingy/Desktop/开发/SpecModule/example/test_academic_writer.py`（扩展既有 `test_discover_academic_writer`）
- Modify: `C:/Users/xingy/Desktop/开发/SpecModule/example/modules/academic_writer.py`（ModuleEntry 补两字段）

- [ ] **Step 1: 写失败测试**——在 `test_discover_academic_writer` 中、`assert "academic_writer_detailed" in entry.templates` 之后插入：

```python
    assert entry.spec_schema == {"raw_text": "str"}
    assert entry.default_spec == {
        "raw_text": (
            "灵感草稿：用大模型做代码评审——LLM 分析 diff，生成按 severity 分类的"
            " comments；在 200 个 PR 上 accuracy 85%，比规则 baseline 高 15 个百分点。"
        )
    }
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd "C:/Users/xingy/Desktop/开发/SpecModule" && "C:/Users/xingy/Desktop/开发/SpecModule_webview/.venv/Scripts/python.exe" -m pytest example/test_academic_writer.py -v
```

Expected: FAIL——`assert None == {'raw_text': 'str'}`（现 entry 未声明两字段）。

- [ ] **Step 3: 最小实现**——`example/modules/academic_writer.py` 的 `ModuleEntry(...)` 中、`default_template="academic_writer",` 之后插入（与测试字面量逐字一致）：

```python
    default_spec={
        "raw_text": (
            "灵感草稿：用大模型做代码评审——LLM 分析 diff，生成按 severity 分类的"
            " comments；在 200 个 PR 上 accuracy 85%，比规则 baseline 高 15 个百分点。"
        )
    },
    spec_schema={"raw_text": "str"},
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd "C:/Users/xingy/Desktop/开发/SpecModule" && "C:/Users/xingy/Desktop/开发/SpecModule_webview/.venv/Scripts/python.exe" -m pytest example/test_academic_writer.py -v
```

Expected: PASS。

- [ ] **Step 5: 库基线回归**（改动不碰库代码，按惯例跑）

```bash
cd "C:/Users/xingy/Desktop/开发/SpecModule_webview" && uv run pytest ../SpecModule/module_harness/tests/ -q -m "not smoke"
```

Expected: 全绿（无 failed/error）。

- [ ] **Step 6: 库仓库独立提交**（遵循其 AGENTS.md；`api.md` 不动——两字段是既有 API，非增量）

```bash
cd "C:/Users/xingy/Desktop/开发/SpecModule" && git add example/modules/academic_writer.py example/test_academic_writer.py && git commit -m "feat(example): academic_writer 补 default_spec/spec_schema——零配置参考输入（webview spec 参考试运行试剂）"
```

---

### Task 2: 同步 store 安装副本（~/.specmodule，非 git）

**Files:**
- Modify: `~/.specmodule/modules/academic_writer.py`（**保留**头部 `_lib` sys.path 引导——store 自包含布局，只有 `ModuleEntry(...)` 本体与仓库源同构）

- [ ] **Step 1: 补同两字段**——在该文件 `ModuleEntry(...)` 的 `default_template="academic_writer",` 之后、`review_harness=None,` 之前插入（内容与 Task 1 Step 3 逐字一致）：

```python
    default_spec={
        "raw_text": (
            "灵感草稿：用大模型做代码评审——LLM 分析 diff，生成按 severity 分类的"
            " comments；在 200 个 PR 上 accuracy 85%，比规则 baseline 高 15 个百分点。"
        )
    },
    spec_schema={"raw_text": "str"},
```

- [ ] **Step 2: 验证安装副本经库解析生效**（`search_paths(Path.home())` 读的就是安装副本）

```bash
cd "C:/Users/xingy/Desktop/开发/SpecModule_webview" && uv run python -c "
from module_harness import store
from pathlib import Path
r = store.resolve_module_full('academic_writer', search=store.search_paths(Path.home()))
d = store.detail_to_dict(r)
assert d['default_spec'] and d['default_spec']['raw_text'].startswith('灵感草稿'), d['default_spec']
assert d['spec_schema'] == {'raw_text': 'str'}, d['spec_schema']
print('installed copy OK')
"
```

Expected: `installed copy OK`。无提交步骤（store 不在 git 内）。

---

### Task 3: 前端——ModuleDetail.tsx 更名 + 可点试运行

**Files:**
- Modify: `C:/Users/xingy/Desktop/开发/SpecModule_webview/web/src/components/ModuleDetail.tsx`（三处：submit 签名 ~L94、展示块 ~L189-196、Button onClick ~L256）

本仓库 web/ 无单测 harness，验收门禁为 `npm run build`（tsc --noEmit + vite build，AGENTS.md 定死）——以构建门禁代替红绿循环。

- [ ] **Step 1: submit 增加可选显式 spec 参数 + busy 防重入**——整函数替换为：

```tsx
  const submit = async (specOverride?: Record<string, unknown>) => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await postLaunch({
        module: detail.name,
        // 未动过字段 → 不传 spec（CLI 回落 entry.default_spec，语义最准）；
        // spec 参考点击 → 显式传参考值（与表单当前值无关，见设计文档）
        spec: specOverride ?? (touched ? spec : null),
        template: template || null,
        run_id: runId.trim() || null,
        max_ticks: maxTicks,
        mock,
      });
      onLaunched(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
```

⚠️ submit 首参从无到有后，`onClick={submit}` 会把 React 事件对象当 specOverride 传入——Step 3 必须同步改为箭头包装。

- [ ] **Step 2: 展示块改造**——将现「default_spec」展示块（`<pre>{detail.default_spec != null ? ... : "（无——...）"}</pre>` 整段，约 L189-196）替换为：

```tsx
        <div className="mt-4">
          <div className="text-[12.5px] font-semibold">spec 参考</div>
          {detail.default_spec != null ? (
            <>
              <pre
                onClick={() => submit({ ...detail.default_spec })}
                title="点击用参考 spec 尝试运行"
                className="mt-1.5 cursor-pointer overflow-x-auto rounded-md border bg-secondary p-2 font-mono text-[11.5px] leading-relaxed transition-colors hover:border-primary/60"
              >
                {JSON.stringify(detail.default_spec, null, 2)}
              </pre>
              <div className="mt-1 text-[11px] text-muted-foreground">
                点击用参考 spec 尝试运行
              </div>
            </>
          ) : (
            <pre className="mt-1.5 overflow-x-auto rounded-md border bg-secondary p-2 font-mono text-[11.5px] leading-relaxed">
              （模块未声明参考 spec——留空将使用模板缺省）
            </pre>
          )}
        </div>
```

- [ ] **Step 3: 发起按钮改箭头包装**（防事件对象误传）——

```tsx
<Button onClick={() => submit()} disabled={submitDisabled}>
```

- [ ] **Step 4: 构建门禁**

```bash
cd "C:/Users/xingy/Desktop/开发/SpecModule_webview/web" && npm run build
```

Expected: tsc 零错误 + vite build 成功。

---

### Task 4: 端到端验收（试剂）

- [ ] **Step 1: server 层载荷确认**（不占端口，TestClient 直连；数据根缺省 = home，读安装副本）

```bash
cd "C:/Users/xingy/Desktop/开发/SpecModule_webview" && uv run python -c "
from fastapi.testclient import TestClient
from server.app import app
d = TestClient(app).get('/api/modules/academic_writer').json()
assert d['default_spec']['raw_text'].startswith('灵感草稿'), d['default_spec']
assert d['spec_schema'] == {'raw_text': 'str'}, d['spec_schema']
print('endpoint payload OK')
"
```

Expected: `endpoint payload OK`。

- [ ] **Step 2: 浏览器点击验收**（起 dev 栈：`uv run uvicorn server.app:app --port 8000` + `cd web && npm run dev`，开 http://localhost:5173）

academic_writer 详情页逐项确认：
1. 「spec 参考」显示 JSON（非空态文案），hover 有边框高亮，下方有「点击用参考 spec 尝试运行」提示行；
2. 「spec 字段」表出现 `raw_text | str` 行（上游 spec_schema 生效）；
3. 发起表单预填 `raw_text` 参考值；
4. 勾选 --mock，点击参考块 → 202 → 自动切「运行历史」页签打开新 run；
5. 对照 ppt_master：「spec 参考」显示空态文案、不可点、无提示行。

- [ ] **Step 3: 验收残留清理**——Step 2 产生的 mock run 落在真实数据根 `~/.specmodule/runs/`，验收完删除（mock run 秒级到终态 done，DELETE 无需 force）：

```bash
curl -s -X DELETE http://127.0.0.1:8000/api/runs/<验收run_id>
```

Expected: `{"run_id": "...", "deleted": true}`。

---

### Task 5: 本仓库提交（前端 + roadmap 变更日志）

- [ ] **Step 1: roadmap.md 末尾「变更日志」追加一条**（格式随现有条目 `- 日期 **标题**——…`）：

```markdown
- 2026-09-16 **启动界面优化一：spec 参考试运行**——「default_spec」区块更名「spec 参考」，
  有参考时整块可点、直接以参考 spec 发起运行（走既有 submit 路径，单一启动入口；无参考
  维持空态不可点）。试剂 academic_writer 上游补 `default_spec`/`spec_schema`
  （SpecModule 仓库独立提交 + store 安装副本同步），详情「spec 字段」表随之亮起。
  设计：docs/superpowers/specs/2026-09-16-spec-reference-launch-ui-design.md
```

- [ ] **Step 2: 提交**（设计文档已先行提交于 b5999ac，本提交收前端与日志）

```bash
cd "C:/Users/xingy/Desktop/开发/SpecModule_webview" && git add web/src/components/ModuleDetail.tsx roadmap.md && git commit -m "feat(web): spec 参考试运行——default_spec 区块更名+点击以参考发起；试剂上游补 default_spec/spec_schema"
```

- [ ] **Step 3: 收尾自检**——`git log --oneline -3`（本仓库见 Task 5 提交；`cd ../SpecModule && git log --oneline -1` 见 Task 1 提交）；`git status` 两仓库干净。
