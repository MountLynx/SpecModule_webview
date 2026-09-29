# ppt_master 入口补 default_spec 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 ppt_master 入口声明参考 spec（`default_spec`），webview 发起页「spec 参考」自动预填/可试运行，CLI 无 spec 时回落 demo deck。

**Architecture:** 全部上游改动（SpecModule 仓库 example 线）：entry 字典加一个键 + 一条双闸测试；store 安装副本（`~/.specmodule/modules/ppt_master.py`，带 `_lib` bootstrap 头）手工对齐同段；webview 零代码改动，端到端只做验证。设计定稿：`docs/superpowers/specs/2026-09-29-ppt-master-default-spec-design.md`。

**Tech Stack:** Python ≥3.10 / pytest / uv；SpecModule 仓库（`../SpecModule`，独立 git 提交）；本仓库（SpecModule_webview）仅验证。

**注意：**
- 两个仓库分开提交；webview 仓库**不产生代码提交**（其工作区既存的 `uv.lock` 改动与本任务无关，不碰）。
- 设计已定稿的 default_spec 内容逐字采用，不要改写文案。

---

### Task 1: 库侧——双闸测试 + entry default_spec（SpecModule 仓库）

**Files:**
- Modify: `../SpecModule/example/test_ppt_master_module.py`（文件末尾追加测试 + 头部补导入）
- Modify: `../SpecModule/example/modules/ppt_master.py:22-34`（entry 字典）

- [ ] **Step 1: 写失败测试**

`../SpecModule/example/test_ppt_master_module.py` 头部导入区（现有 9-19 行的 import 块）补三行：

```python
import copy
from pathlib import Path

from example.ppt_master.spec_schema import validate_ppt_spec
from module_harness.cli.entry import discover_modules
```

（`import re` / `from typing import Any` 等既有导入不动；`copy`、`Path` 按 stdlib→三方顺序与既有风格同块放置。）

文件末尾追加测试：

```python
def test_entry_default_spec_is_valid_reagent(tmp_path, monkeypatch):
    """入口 default_spec 是 webview「spec 参考」/CLI 无 spec 通道的试剂：
    契约校验 + 翻译层双闸全通（缺省回填后形状即 translator 所依赖）。"""
    monkeypatch.setattr(workspace, "_ENVELOPE_DIR", tmp_path)
    entries = discover_modules(Path(__file__).parent / "modules")
    spec = copy.deepcopy(entries["ppt_master"].default_spec)
    assert spec is not None, "ppt_master 入口未声明 default_spec"
    validate_ppt_spec(spec)  # 回填缺省（原地进行，故上一步 deepcopy）
    reg = _build_registry(llm_client=object())
    errors = _validated_tasklist(spec, reg)
    assert not errors, errors
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd ../SpecModule && uv run pytest example/test_ppt_master_module.py::test_entry_default_spec_is_valid_reagent -v
```

预期：FAIL，`AssertionError: ppt_master 入口未声明 default_spec`。

- [ ] **Step 3: entry 补 default_spec**

`../SpecModule/example/modules/ppt_master.py` 的 entry 字典，把：

```python
    default_spec=None,   # 页册因项目而异，无零配置缺省（示例 spec 见 fixtures/）
```

替换为：

```python
    default_spec={
        "project": "demo_deck",
        "source": {"kind": "topic", "topic": (
            "用大模型做代码评审：LLM 分析 diff，生成按 severity 分类的"
            " comments；在 200 个 PR 上 accuracy 85%，比规则 baseline 高 15 个百分点。"
        )},
        # placeholder 图像：试跑零图像 API 依赖（省略则规划者裁量可能选 ai，
        # 只配 LLM key 的环境会中途失败）；实战在 spec 里换 ai/user。
        "images": {"sources": ["placeholder"]},
        "roster": [
            {"id": "p01", "title": "LLM 代码评审", "role": "cover"},
            {"id": "p02", "title": "方法：diff → 分类 comments",
             "points": ["LLM 分析 diff", "按 severity 分类：critical/warning/suggestion"]},
            {"id": "p03", "title": "实验：200 PR accuracy 85%",
             "points": ["比规则 baseline 高 15 个百分点"]},
            {"id": "p04", "title": "结语与未来工作", "role": "closing"},
        ],
    },   # 参考预填值（webview spec 参考/CLI 无 spec 回落）；全字段契约见 spec_schema.py
```

- [ ] **Step 4: 跑测试确认通过（整文件）**

```bash
cd ../SpecModule && uv run pytest example/test_ppt_master_module.py -q
```

预期：全绿（新增 1 例 + 既有 5 例）。

- [ ] **Step 5: 提交（SpecModule 仓库）**

```bash
cd ../SpecModule && git add example/modules/ppt_master.py example/test_ppt_master_module.py && git commit -m "feat(example): ppt_master 补 default_spec——webview spec 参考试运行试剂"
```

---

### Task 2: store 安装副本同步 + 双仓验证

**Files:**
- Modify: `~/.specmodule/modules/ppt_master.py`（安装版 entry，带 `_lib` bootstrap 头；只动 entry 字典同一段，头部与 `_lib/` 不动）

- [ ] **Step 1: store 副本对齐同段 default_spec**

`~/.specmodule/modules/ppt_master.py` 的 entry 字典，把：

```python
    default_spec=None,   # 页册因项目而异，无零配置缺省（示例 spec 见 fixtures/）
```

替换为（与 Task 1 Step 3 同段，逐字粘贴，含注释与尾注）：

```python
    default_spec={
        "project": "demo_deck",
        "source": {"kind": "topic", "topic": (
            "用大模型做代码评审：LLM 分析 diff，生成按 severity 分类的"
            " comments；在 200 个 PR 上 accuracy 85%，比规则 baseline 高 15 个百分点。"
        )},
        # placeholder 图像：试跑零图像 API 依赖（省略则规划者裁量可能选 ai，
        # 只配 LLM key 的环境会中途失败）；实战在 spec 里换 ai/user。
        "images": {"sources": ["placeholder"]},
        "roster": [
            {"id": "p01", "title": "LLM 代码评审", "role": "cover"},
            {"id": "p02", "title": "方法：diff → 分类 comments",
             "points": ["LLM 分析 diff", "按 severity 分类：critical/warning/suggestion"]},
            {"id": "p03", "title": "实验：200 PR accuracy 85%",
             "points": ["比规则 baseline 高 15 个百分点"]},
            {"id": "p04", "title": "结语与未来工作", "role": "closing"},
        ],
    },   # 参考预填值（webview spec 参考/CLI 无 spec 回落）；全字段契约见 spec_schema.py
```

- [ ] **Step 2: 验证 store 副本（bootstrap 导入 + 契约校验）**

```bash
cd ../SpecModule && uv run python -c "
import copy, sys
from pathlib import Path
sys.path.insert(0, str(Path.home() / '.specmodule' / 'modules'))
import ppt_master
from example.ppt_master.spec_schema import validate_ppt_spec
spec = copy.deepcopy(ppt_master.entry.default_spec)
validate_ppt_spec(spec)
assert spec['project'] == 'demo_deck' and len(spec['roster']) == 4
print('store 副本 default_spec OK')
"
```

预期：输出 `store 副本 default_spec OK`（`example` 经 _lib bootstrap 解析到安装副本，同码同闸）。

- [ ] **Step 3: webview 端到端——模块详情透出**

```bash
uv run python -c "
from fastapi.testclient import TestClient
from server.app import app
d = TestClient(app).get('/api/modules/ppt_master').json()
ds = d.get('default_spec')
assert ds and ds['project'] == 'demo_deck', ds
print('模块详情 default_spec 透出 OK；roster 页数:', len(ds['roster']))
"
```

预期：输出 `模块详情 default_spec 透出 OK；roster 页数: 4`（server 锚 `~/.specmodule` 读 store entry → `detail_to_dict` 透传）。

- [ ] **Step 4: 双仓回归**

```bash
uv run pytest ../SpecModule/module_harness/tests/ -q -m "not smoke"   # 库基线
uv run pytest tests/ -q                                              # 本仓库套件（零改动应全绿）
```

预期：两套全绿。

- [ ] **Step 5: 收尾**

无 webview 代码提交（设计文档已于此前的 `c69f083` 提交；琐碎不记 finish.md）。向用户汇报：发起页「spec 参考」预填效果、「用参考 spec 尝试运行」已点亮、CLI 无 spec 回落语义变化。
