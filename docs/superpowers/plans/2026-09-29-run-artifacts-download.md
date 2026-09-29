# run 产物清单 + 下载 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** run 结束后，webview（本地/云端同一交互）能列出并下载该 run 声明的产物文件——库侧声明制产物清单（`Tasklist.Artifacts` → `artifacts.json`），webview 两个薄映射端点 + 前端产物条，ppt_master 作为首个声明落地模块。

**Architecture:** 产物语义收编上游库（统一 API 原则）：模块作者经 tasklist 顶层 `Artifacts` 显式声明产出（glob 串 + pick 语义），Module 在 done/truncated 终态收尾收集为 run 目录 `artifacts.json`（文件本体不搬，只记绝对路径 + size/mtime）；`query.read_artifacts` 共享读端 + CLI `artifacts` 子命令；webview 只做传输薄映射（清单端点 + 按 index 的 FileResponse 下载，无路径遍历面）和前端渲染。

**Tech Stack:** Python ≥3.10（stdlib argparse/glob/json/pathlib + FastAPI）· pytest · React + TS + Tailwind（web/）· uv（webview 根统一驱动两个仓库的测试）。

**设计依据:** [2026-09-29-run-artifacts-download-design.md](../specs/2026-09-29-run-artifacts-download-design.md)（已获用户批准）。

---

## 执行者须知（先读）

- 两个 git 仓库：**库** `C:\Users\xingy\Desktop\开发\SpecModule`（下文相对路径 `../SpecModule`，Task 1-6 在此提交）与 **webview** `C:\Users\xingy\Desktop\开发\SpecModule_webview`（Task 7-9 在此提交）。所有 pytest 命令都从 **webview 根**跑（uv 已把 specmodule 锚到 `../SpecModule` editable）。
- 生态无 linter/formatter——不引入、不跑。库代码惯例：`from __future__ import annotations` 首行、中文 docstring、`@dataclass`、显式 `__all__`。
- 测试隔离铁律：所有 fixture 工件落 `tmp_path`（测试自带的 `monkeypatch.chdir` / `base_dir=tmp_path` 已保证），绝不写真实 `~/.specmodule`。
- 环境是 Windows + Git Bash；路径一律正斜杠写法在 pytest/uv 下均可。

---

## Task 1（库）: `ArtifactDecl` + `Tasklist.Artifacts` 模型

**Files:**
- Modify: `../SpecModule/module_harness/model/spec.py`（`TaskDefinition` 之后、`Tasklist` 之前插入 `ArtifactDecl`；改 `Tasklist`）
- Test: `../SpecModule/module_harness/tests/test_artifacts.py`（新建，本 Task 只写模型部分，后续 Task 续加）

- [ ] **Step 1: 写失败测试**

创建 `../SpecModule/module_harness/tests/test_artifacts.py`：

```python
# module_harness/tests/test_artifacts.py
"""run 产物清单：声明模型 / 收集器 / 终态挂点 / 查询读端 / CLI。"""

from __future__ import annotations

import json
import os
from unittest.mock import AsyncMock, MagicMock

import pytest

from module_harness.infra.artifacts import (
    artifacts_path,
    collect_artifacts,
    write_artifacts_manifest,
)
from module_harness.infra.query import read_artifacts
from module_harness.model.module import Module
from module_harness.model.spec import ArtifactDecl, TaskDefinition, Tasklist


# ── ArtifactDecl / Tasklist.Artifacts（模型层）─────────────────────────


class TestArtifactDecl:
    def test_from_dict_roundtrip(self):
        d = {"name": "deck", "path": "exports/*.pptx",
             "kind": "deliverable", "pick": "latest"}
        decl = ArtifactDecl.from_dict(d)
        assert decl.name == "deck"
        assert decl.kind == "deliverable"
        assert decl.pick == "latest"
        assert decl.to_dict() == d

    def test_defaults(self):
        decl = ArtifactDecl.from_dict({"name": "n", "path": "p/*"})
        assert decl.kind == "intermediate"
        assert decl.pick == "all"

    def test_blank_name_rejected(self):
        with pytest.raises(ValueError, match="name"):
            ArtifactDecl.from_dict({"name": " ", "path": "p/*"})

    def test_blank_path_rejected(self):
        with pytest.raises(ValueError, match="path"):
            ArtifactDecl.from_dict({"name": "n", "path": ""})

    def test_bad_kind_rejected(self):
        with pytest.raises(ValueError, match="kind"):
            ArtifactDecl.from_dict({"name": "n", "path": "p/*", "kind": "x"})

    def test_bad_pick_rejected(self):
        with pytest.raises(ValueError, match="pick"):
            ArtifactDecl.from_dict({"name": "n", "path": "p/*", "pick": "x"})


class TestTasklistArtifacts:
    @staticmethod
    def _tl(artifacts):
        return Tasklist(
            tasks={"A": TaskDefinition(type="script", script="A")},
            flow="[A]",
            artifacts=artifacts,
        )

    def test_from_json_parses_artifacts(self):
        tl = Tasklist.from_json({
            "Tasks": {"A": {"type": "script", "script": "A"}},
            "Flow": "[A]",
            "Artifacts": [{"name": "deck", "path": "exports/*.pptx"}],
        })
        assert len(tl.artifacts) == 1
        assert tl.artifacts[0].kind == "intermediate"

    def test_from_json_without_artifacts_defaults_empty(self):
        tl = Tasklist.from_json({
            "Tasks": {"A": {"type": "script", "script": "A"}},
            "Flow": "[A]",
        })
        assert tl.artifacts == []

    def test_from_json_non_list_rejected(self):
        with pytest.raises(ValueError, match="Artifacts"):
            Tasklist.from_json({
                "Tasks": {"A": {"type": "script", "script": "A"}},
                "Flow": "[A]",
                "Artifacts": "nope",
            })

    def test_to_dict_roundtrip_and_omits_empty(self):
        tl = self._tl([ArtifactDecl(name="deck", path="exports/*.pptx")])
        d = tl.to_dict()
        assert d["Artifacts"] == [{
            "name": "deck", "path": "exports/*.pptx",
            "kind": "intermediate", "pick": "all",
        }]
        assert Tasklist.from_json(d).artifacts[0].path == "exports/*.pptx"
        # 空声明不出现在序列化——旧格式 tasklist 往返零扰动
        assert "Artifacts" not in self._tl([]).to_dict()
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest ../SpecModule/module_harness/tests/test_artifacts.py -q`
Expected: FAIL（`ImportError: cannot import name 'ArtifactDecl'`）

- [ ] **Step 3: 实现模型**

`../SpecModule/module_harness/model/spec.py`——在 `TaskDefinition` 类之后（`@dataclass\nclass Tasklist:` 之前）插入：

```python
@dataclass
class ArtifactDecl:
    """run 产物声明（tasklist 顶层 ``Artifacts`` 项）：模块作者显式声明产出。

    path 是具体 glob 串（相对路径按运行进程 cwd 解析；spec 派生路径由翻译
    脚本自行插值，库不做模板机制）。收集语义见 infra/artifacts.py。
    """

    name: str                    # 展示名（消费端 label，可中文）
    path: str                    # 具体 glob 串；相对路径按运行进程 cwd 解析
    kind: str = "intermediate"   # "deliverable"（交付物）| "intermediate"（中间产物）
    pick: str = "all"            # "all"（全收）| "latest"（匹配集取 mtime 最新一个）

    _KINDS = ("deliverable", "intermediate")
    _PICKS = ("all", "latest")

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "ArtifactDecl":
        if not isinstance(d, dict):
            raise ValueError("Artifacts 项应为 dict")
        name = d.get("name")
        if not isinstance(name, str) or not name.strip():
            raise ValueError("Artifacts 项 'name' 应为非空字符串")
        path = d.get("path")
        if not isinstance(path, str) or not path.strip():
            raise ValueError("Artifacts 项 'path' 应为非空字符串")
        kind = d.get("kind", "intermediate")
        if kind not in cls._KINDS:
            raise ValueError(
                f"Artifacts 项 'kind' 应为 {'/'.join(cls._KINDS)} 之一，得 {kind!r}"
            )
        pick = d.get("pick", "all")
        if pick not in cls._PICKS:
            raise ValueError(
                f"Artifacts 项 'pick' 应为 {'/'.join(cls._PICKS)} 之一，得 {pick!r}"
            )
        return cls(name=name, path=path, kind=kind, pick=pick)

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "path": self.path,
                "kind": self.kind, "pick": self.pick}
```

`Tasklist` 改为（docstring、字段、`from_json`、`to_dict` 四处）：

```python
@dataclass
class Tasklist:
    """完整的 tasklist：Tasks + Flow + Artifacts（产物声明，可选）。"""

    tasks: dict[str, TaskDefinition]
    flow: str
    artifacts: list[ArtifactDecl] = field(default_factory=list)

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "Tasklist":
        if "Tasks" not in data:
            raise ValueError("tasklist 缺少 'Tasks' 字段")
        if "Flow" not in data:
            raise ValueError("tasklist 缺少 'Flow' 字段")
        tasks = {
            key: TaskDefinition.from_dict(td)
            for key, td in data["Tasks"].items()
        }
        raw_artifacts = data.get("Artifacts", [])
        if not isinstance(raw_artifacts, list):
            raise ValueError("tasklist 'Artifacts' 应为 list")
        artifacts = [ArtifactDecl.from_dict(a) for a in raw_artifacts]
        return cls(tasks=tasks, flow=data["Flow"], artifacts=artifacts)

    def to_dict(self) -> dict[str, Any]:
        """JSON 可序列化 dict（与 ``from_json`` 对称）——唯一实现（S4）。"""
        out: dict[str, Any] = {
            "Tasks": {k: dataclasses.asdict(v) for k, v in self.tasks.items()},
            "Flow": self.flow,
        }
        if self.artifacts:
            out["Artifacts"] = [a.to_dict() for a in self.artifacts]
        return out
```

（`field` 已在文件头导入——`from dataclasses import dataclass, field`。）

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest ../SpecModule/module_harness/tests/test_artifacts.py -q`
Expected: PASS（10 passed）

- [ ] **Step 5: 提交（库仓库）**

```bash
cd ../SpecModule && git add module_harness/model/spec.py module_harness/tests/test_artifacts.py && git commit -m "feat(artifacts): Tasklist 顶层 Artifacts 声明——ArtifactDecl 模型 + 序列化往返（run 产物清单 1/3）" && cd -
```

---

## Task 2（库）: `infra/artifacts.py` 收集器 + 清单落盘

**Files:**
- Create: `../SpecModule/module_harness/infra/artifacts.py`
- Test: `../SpecModule/module_harness/tests/test_artifacts.py`（续加）

- [ ] **Step 1: 在 test_artifacts.py 末尾追加失败测试**

```python
# ── 收集器（infra/artifacts.py）───────────────────────────────────────


class TestCollectArtifacts:
    def test_glob_relative_resolved_absolute(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "exports").mkdir()
        (tmp_path / "exports" / "deck.pptx").write_bytes(b"PK")
        entries = collect_artifacts(
            [ArtifactDecl(name="deck", path="exports/*.pptx")])
        assert len(entries) == 1
        e = entries[0]
        assert e["path"] == str(tmp_path / "exports" / "deck.pptx")
        assert e["name"] == "deck"
        assert e["kind"] == "intermediate"
        assert e["size"] == 2
        assert "T" in e["modified"]  # ISO8601 本地时间

    def test_pick_all_sorted(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "exports").mkdir()
        for n in ("b.pptx", "a.pptx"):
            (tmp_path / "exports" / n).write_bytes(b"x")
        entries = collect_artifacts(
            [ArtifactDecl(name="deck", path="exports/*.pptx")])
        assert [os.path.basename(e["path"]) for e in entries] == ["a.pptx", "b.pptx"]

    def test_pick_latest_by_mtime(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "exports").mkdir()
        old = tmp_path / "exports" / "deck_1.pptx"
        new = tmp_path / "exports" / "deck_2.pptx"
        old.write_bytes(b"old")
        new.write_bytes(b"new")
        os.utime(old, (1000000000, 1000000000))
        entries = collect_artifacts(
            [ArtifactDecl(name="deck", path="exports/*.pptx", pick="latest")])
        assert len(entries) == 1
        assert entries[0]["path"] == str(new)

    def test_zero_match_skipped(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        assert collect_artifacts(
            [ArtifactDecl(name="deck", path="exports/*.pptx")]) == []

    def test_directory_match_skipped(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "exports" / "sub").mkdir(parents=True)
        assert collect_artifacts(
            [ArtifactDecl(name="x", path="exports/*")]) == []

    def test_multiple_decls_accumulate(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "exports").mkdir()
        (tmp_path / "notes").mkdir()
        (tmp_path / "exports" / "a.pptx").write_bytes(b"x")
        (tmp_path / "notes" / "total.md").write_text("# n", encoding="utf-8")
        entries = collect_artifacts([
            ArtifactDecl(name="deck", path="exports/*.pptx"),
            ArtifactDecl(name="notes", path="notes/*.md"),
        ])
        assert [e["name"] for e in entries] == ["deck", "notes"]


class TestWriteManifest:
    def test_writes_manifest_with_run_id(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        run_dir = tmp_path / ".specmodule" / "runs" / "r1"
        run_dir.mkdir(parents=True)
        (tmp_path / "exports").mkdir()
        (tmp_path / "exports" / "deck.pptx").write_bytes(b"PK")
        write_artifacts_manifest(
            "r1", [ArtifactDecl(name="deck", path="exports/*.pptx")])
        raw = json.loads(
            (run_dir / "artifacts.json").read_text(encoding="utf-8"))
        assert raw["run_id"] == "r1"
        assert len(raw["artifacts"]) == 1

    def test_zero_match_writes_empty_list(self, tmp_path, monkeypatch):
        """声明存在但零匹配 → 空清单（区分"收集过没产出"与"没收集"）。"""
        monkeypatch.chdir(tmp_path)
        run_dir = tmp_path / ".specmodule" / "runs" / "r1"
        run_dir.mkdir(parents=True)
        write_artifacts_manifest("r1", [ArtifactDecl(name="x", path="nope/*")])
        raw = json.loads(
            (run_dir / "artifacts.json").read_text(encoding="utf-8"))
        assert raw["artifacts"] == []

    def test_no_decls_no_file(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        run_dir = tmp_path / ".specmodule" / "runs" / "r1"
        run_dir.mkdir(parents=True)
        write_artifacts_manifest("r1", [])
        assert not (run_dir / "artifacts.json").exists()

    def test_no_run_dir_no_side_effect(self, tmp_path, monkeypatch):
        """纯内存模式（run 目录不存在）不落盘、不建目录。"""
        monkeypatch.chdir(tmp_path)
        write_artifacts_manifest("r1", [ArtifactDecl(name="x", path="nope/*")])
        assert not (tmp_path / ".specmodule").exists()
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest ../SpecModule/module_harness/tests/test_artifacts.py -q`
Expected: FAIL（`ModuleNotFoundError: No module named 'module_harness.infra.artifacts'`）

- [ ] **Step 3: 实现 infra/artifacts.py**

创建 `../SpecModule/module_harness/infra/artifacts.py`：

```python
# module_harness/infra/artifacts.py
"""run 产物收集与清单——artifacts.json（跨进程读的声明制产物通道）。

模块作者经 tasklist 顶层 ``Artifacts`` 声明产出（``ArtifactDecl``：name/kind/
path/pick）；Module 终态（done/truncated）收尾时收集——glob 展开 → 绝对路径
+ size/mtime 落 ``<run_dir>/artifacts.json``，文件本体不搬。cancelled/aborted
不收集（部分产物不保证）。清单是消费端唯一下载依据：客户端只按 index 引用
条目，路径永不为客户端输入（无遍历面）。
"""

from __future__ import annotations

import glob
import json
import logging
import os
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..model.spec import ArtifactDecl

log = logging.getLogger(__name__)

__all__ = ["artifacts_path", "collect_artifacts", "write_artifacts_manifest"]


def artifacts_path(module_id: str, base_dir: Path | None = None) -> Path:
    """``<base_dir>/.specmodule/runs/<module_id>/artifacts.json``。"""
    return (base_dir or Path.cwd()) / ".specmodule" / "runs" / module_id / "artifacts.json"


def collect_artifacts(decls: list["ArtifactDecl"]) -> list[dict]:
    """声明 → 清单条目（glob 展开，绝对路径 + size/mtime）。

    pick="latest" 在该声明的匹配集内取 mtime 最新一个；pick="all" 按 path
    排序全收；目录命中跳过（v1 只收文件）。零匹配的声明跳过——清单只含
    真实存在的文件（零匹配整体仍写空清单，见 write_artifacts_manifest）。

    标注经 ``from __future__ import annotations`` 字符串化，ArtifactDecl
    仅运行期类型引用（TYPE_CHECKING 导入）——避免与 model.spec 导入环
    （model.module 会导入本模块）。
    """
    entries: list[dict] = []
    for decl in decls:
        matches = [p for p in glob.glob(decl.path, recursive=True)
                   if os.path.isfile(p)]
        if not matches:
            continue
        if decl.pick == "latest":
            matches = [max(matches, key=os.path.getmtime)]
        else:
            matches = sorted(matches)
        for m in matches:
            abs_path = os.path.abspath(m)
            st = os.stat(abs_path)
            entries.append({
                "name": decl.name,
                "kind": decl.kind,
                "path": abs_path,
                "size": st.st_size,
                "modified": datetime.fromtimestamp(
                    st.st_mtime).isoformat(timespec="seconds"),
            })
    return entries


def write_artifacts_manifest(
    module_id: str, decls: list["ArtifactDecl"], base_dir: Path | None = None
) -> None:
    """终态收集 → artifacts.json 原子写（tmp + os.replace，同 status.json）。

    run 目录不存在（纯内存模式）不落盘；无声明不产文件；声明存在但零匹配
    → 写空清单。失败仅 log 不阻断运行（对齐 _write_phase 哲学）。
    """
    if not decls:
        return
    path = artifacts_path(module_id, base_dir)
    if not path.parent.exists():
        return
    tmp = path.with_suffix(".json.tmp")
    try:
        tmp.write_text(
            json.dumps(
                {"run_id": module_id, "artifacts": collect_artifacts(decls)},
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        os.replace(tmp, path)
    except OSError:
        log.exception("写 artifacts.json 失败（不阻断运行）: %s", path)
```

（注：`TYPE_CHECKING` 守卫 + 函数内延迟导入是为避免与 `model.spec` 的导入环——`model.module` 会导入本模块。）

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest ../SpecModule/module_harness/tests/test_artifacts.py -q`
Expected: PASS（20 passed）

- [ ] **Step 5: 提交（库仓库）**

```bash
cd ../SpecModule && git add module_harness/infra/artifacts.py module_harness/tests/test_artifacts.py && git commit -m "feat(artifacts): 收集器 + artifacts.json 原子落盘——glob/pick 语义 + 容错门槛（run 产物清单 1/3）" && cd -
```

---

## Task 3（库）: Module 终态挂点（done/truncated 收集）

**Files:**
- Modify: `../SpecModule/module_harness/model/module.py`（import 块 + `_run_with_phases` else 分支 + 新方法 `_collect_artifacts`）
- Test: `../SpecModule/module_harness/tests/test_artifacts.py`（续加）

**设计说明:** done 与 truncated 共用 `_run_with_phases` 的 else 分支（`_finalize_phase` 之后），单点挂接即覆盖两个终态；cancelled/aborted 走 except 路径天然不收集。resume 经同一函数自动获得收集。

- [ ] **Step 1: 在 test_artifacts.py 末尾追加失败测试**

```python
# ── Module 终态挂点（model/module.py）────────────────────────────────


@pytest.fixture
def mock_llm():
    client = MagicMock()
    client.complete = AsyncMock()
    return client


@pytest.fixture
def registry(mock_llm):
    from module_harness.core.registry import HarnessRegistry
    from module_harness.infra.events import EventBus

    reg = HarnessRegistry(llm_client=mock_llm, event_bus=EventBus.null())

    @reg.script("A")
    def a(view):
        return {"text": "hello"}

    @reg.script("B")
    def b(view):
        return {"echo": view.field("value")}

    return reg


def _decl_tl(decl_path: str) -> Tasklist:
    """两节点顺序图 + 一条产物声明（path 指向调用方 tmp_path）。"""
    return Tasklist(
        tasks={
            "A": TaskDefinition(type="script", script="A"),
            "B": TaskDefinition(type="script", script="B", inputs={"value": "A"}),
        },
        flow="[A] --> B",
        artifacts=[ArtifactDecl(name="deck", path=decl_path,
                                kind="deliverable", pick="latest")],
    )


class TestModuleTerminalCollection:
    @pytest.mark.asyncio
    async def test_done_writes_manifest(self, mock_llm, registry, tmp_path):
        (tmp_path / "exports").mkdir()
        (tmp_path / "exports" / "deck_1.pptx").write_bytes(b"old")
        (tmp_path / "exports" / "deck_2.pptx").write_bytes(b"new")
        os.utime(tmp_path / "exports" / "deck_1.pptx", (1000000000, 1000000000))
        mod = Module(
            spec={}, tasklist=_decl_tl(str(tmp_path / "exports" / "*.pptx")),
            llm_client=mock_llm, registry=registry, review_harness=None,
            base_dir=tmp_path, module_id="art_done",
        )
        await mod.run(max_ticks=10)
        data = read_artifacts("art_done", base_dir=tmp_path)
        assert data is not None and len(data["artifacts"]) == 1
        assert data["artifacts"][0]["path"] == str(tmp_path / "exports" / "deck_2.pptx")

    @pytest.mark.asyncio
    async def test_aborted_writes_no_manifest(
        self, mock_llm, registry, tmp_path, monkeypatch,
    ):
        (tmp_path / "exports").mkdir()
        (tmp_path / "exports" / "deck.pptx").write_bytes(b"PK")
        from tickflow.runner import AsyncRunner

        async def boom(self, *, max_ticks):
            raise RuntimeError("引擎炸了")

        monkeypatch.setattr(AsyncRunner, "run_until_idle", boom)
        mod = Module(
            spec={}, tasklist=_decl_tl(str(tmp_path / "exports" / "*.pptx")),
            llm_client=mock_llm, registry=registry, review_harness=None,
            base_dir=tmp_path, module_id="art_abort",
        )
        with pytest.raises(RuntimeError):
            await mod.run(max_ticks=10)
        assert not artifacts_path("art_abort", base_dir=tmp_path).exists()

    @pytest.mark.asyncio
    async def test_no_decls_no_manifest(self, mock_llm, registry, tmp_path):
        tl = Tasklist(
            tasks={"A": TaskDefinition(type="script", script="A")}, flow="[A]")
        mod = Module(
            spec={}, tasklist=tl, llm_client=mock_llm, registry=registry,
            review_harness=None, base_dir=tmp_path, module_id="art_nodecl",
        )
        await mod.run(max_ticks=5)
        assert not artifacts_path("art_nodecl", base_dir=tmp_path).exists()
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest ../SpecModule/module_harness/tests/test_artifacts.py -q`
Expected: 3 个新测试 FAIL（`Module` 没有 `_collect_artifacts` 的挂接——done 用例断言清单为 None/空）

- [ ] **Step 3: 实现挂点**

`../SpecModule/module_harness/model/module.py` 三处：

(a) import 块——把 `from ..infra.checkpoint import (` 一行之前加：

```python
from ..infra.artifacts import write_artifacts_manifest
```

(b) `_run_with_phases` 的 else 分支（原代码）：

```python
            else:
                self._finalize_phase(runner, max_ticks)
            return firings
```

改为：

```python
            else:
                self._finalize_phase(runner, max_ticks)
                self._collect_artifacts()
            return firings
```

(c) 在 `_finalize_phase` 方法之后、`async def resume` 之前新增：

```python
    def _collect_artifacts(self) -> None:
        """终态收集声明产物 → run 目录 artifacts.json（done/truncated 共用路径）。

        cancelled/aborted 走不到这里（部分产物不保证，见 infra/artifacts.py）；
        无声明的 run 不产生清单文件；纯内存模式（run 目录不存在）不落盘。
        resume 经 _run_with_phases 共用路径自动收集。
        """
        decls = self._last_tasklist.artifacts if self._last_tasklist else []
        if decls:
            write_artifacts_manifest(self.module_id, decls, self._base_dir)
```

- [ ] **Step 4: 跑测试确认通过 + 库基线回归**

Run: `uv run pytest ../SpecModule/module_harness/tests/test_artifacts.py -q`
Expected: PASS（23 passed）

Run: `uv run pytest ../SpecModule/module_harness/tests/ -q -m "not smoke"`
Expected: 全绿（`Tasklist` 构造处全部兼容——`artifacts` 带缺省值；`to_dict` 空声明不产新键，旧断言不受扰动）

- [ ] **Step 5: 提交（库仓库）**

```bash
cd ../SpecModule && git add module_harness/model/module.py module_harness/tests/test_artifacts.py && git commit -m "feat(artifacts): Module 终态收尾收集挂点——done/truncated 写清单、cancelled/aborted 不收集（run 产物清单 1/3）" && cd -
```

---

## Task 4（库）: `query.read_artifacts` + CLI `artifacts`

**Files:**
- Modify: `../SpecModule/module_harness/infra/query.py`（import + 新函数）
- Modify: `../SpecModule/module_harness/cli/cli.py`（import tuple + `_cmd_artifacts` + parser 注册 + 模块 docstring 用法行）
- Test: `../SpecModule/module_harness/tests/test_artifacts.py`（续加）

- [ ] **Step 1: 在 test_artifacts.py 末尾追加失败测试**

```python
# ── 查询读端（query.read_artifacts）──────────────────────────────────


class TestReadArtifacts:
    @staticmethod
    def _seed(tmp_path, run_id="r1", manifest=None):
        run_dir = tmp_path / ".specmodule" / "runs" / run_id
        run_dir.mkdir(parents=True, exist_ok=True)
        if manifest is not None:
            (run_dir / "artifacts.json").write_text(
                json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        return run_dir

    def test_no_run_dir_none(self, tmp_path):
        assert read_artifacts("ghost", base_dir=tmp_path) is None

    def test_no_manifest_empty(self, tmp_path):
        self._seed(tmp_path)
        assert read_artifacts("r1", base_dir=tmp_path) == {
            "run_id": "r1", "artifacts": [],
        }

    def test_corrupt_manifest_empty(self, tmp_path):
        run_dir = self._seed(tmp_path)
        (run_dir / "artifacts.json").write_text("{broken", encoding="utf-8")
        assert read_artifacts("r1", base_dir=tmp_path)["artifacts"] == []

    def test_entries_indexed(self, tmp_path):
        self._seed(tmp_path, manifest={"run_id": "r1", "artifacts": [
            {"name": "a", "kind": "deliverable", "path": "C:/x.pptx",
             "size": 1, "modified": "2026-09-29T10:00:00"},
        ]})
        data = read_artifacts("r1", base_dir=tmp_path)
        assert data["artifacts"][0]["index"] == 0
        assert data["artifacts"][0]["name"] == "a"


# ── CLI（specmodule artifacts）───────────────────────────────────────


class TestCliArtifacts:
    def test_lists_artifacts(self, tmp_path, monkeypatch, capsys):
        run_dir = tmp_path / ".specmodule" / "runs" / "r1"
        run_dir.mkdir(parents=True)
        (run_dir / "artifacts.json").write_text(json.dumps({
            "run_id": "r1",
            "artifacts": [{"name": "deck", "kind": "deliverable",
                           "path": "x/deck.pptx", "size": 2048,
                           "modified": "2026-09-29T10:00:00"}],
        }, ensure_ascii=False), encoding="utf-8")
        monkeypatch.chdir(tmp_path)
        from module_harness.cli import main

        assert main(["artifacts", "--run-id", "r1"]) == 0
        out = capsys.readouterr().out
        assert "deck" in out and "deck.pptx" in out

    def test_unknown_run_errors(self, tmp_path, monkeypatch, capsys):
        monkeypatch.chdir(tmp_path)
        from module_harness.cli import main

        assert main(["artifacts", "--run-id", "ghost"]) == 1
        assert "ghost" in capsys.readouterr().err
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest ../SpecModule/module_harness/tests/test_artifacts.py -q`
Expected: 新用例 FAIL（`ImportError: cannot import name 'read_artifacts'`）

- [ ] **Step 3a: 实现 query.read_artifacts**

`../SpecModule/module_harness/infra/query.py`——import 区（`from .stream import stream_log_path` 之后）加：

```python
from .artifacts import artifacts_path
```

在 `read_module_inputs` 函数之后（`# ── run 枚举与删除` 注释之前）插入：

```python
def read_artifacts(
    run_id: str, base_dir: Path | None = None
) -> dict[str, Any] | None:
    """读 run 产物清单（artifacts.json：声明制产物，终态收尾收集）。

    消费场景：Web 产物列表/下载端点、CLI ``artifacts``。run 目录不存在 →
    None（同 read_module_inputs 容错）；清单缺失/损坏 → 空列表（收集过
    但零产出与从未收集对消费端都是"无产物可下载"，不再区分）。条目附
    ``index``（数组序）——下载通道按 index 引用，路径永不为客户端输入。
    """
    path = artifacts_path(run_id, base_dir)
    if not path.parent.exists():
        return None
    entries: list[dict[str, Any]] = []
    if path.exists():
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(raw, dict) and isinstance(raw.get("artifacts"), list):
                entries = raw["artifacts"]
        except (OSError, ValueError):
            log.exception("读取 artifacts.json 失败（返回空清单）: %s", path)
    return {
        "run_id": run_id,
        "artifacts": [{**e, "index": i} for i, e in enumerate(entries)],
    }
```

- [ ] **Step 3b: 实现 CLI 子命令**

`../SpecModule/module_harness/cli/cli.py`：

(a) import tuple（`from ..infra.query import (` 块）在 `load_snapshot_summary,` 与 `run_db_path,` 之间加一行 `read_artifacts,`。

(b) 在 `_cmd_checkpoints` 函数之后加：

```python
def _cmd_artifacts(args: argparse.Namespace) -> int:
    """列出 run 声明的产物清单（终态收集的 artifacts.json）。"""
    run_id = args.run_id or _latest_run_id()
    if run_id is None:
        print("无运行记录（先执行 specmodule run）", file=sys.stderr)
        return 1
    data = read_artifacts(run_id)
    if data is None:
        print(f"无运行记录: {run_id}（先执行 specmodule run）", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
        return 0
    arts = data["artifacts"]
    if not arts:
        print(f"run {run_id} 无产物（未声明或未收集）")
        return 0
    print(f"run {run_id} 产物 {len(arts)} 项：")
    for a in arts:
        print(f"  [{a['index']}] {a['name']} ({a['kind']}, "
              f"{a['size'] / 1024:.1f} KB) {a['path']}")
    return 0
```

(c) parser 注册——`p_checkpoints` 的 `set_defaults` 行之后加：

```python
    p_artifacts = sub.add_parser("artifacts", help="列出 run 声明的产物清单")
    p_artifacts.add_argument("--run-id", help="运行 id（默认最近运行）")
    p_artifacts.add_argument("--json", action="store_true", help="JSON 输出")
    p_artifacts.set_defaults(func=_cmd_artifacts)
```

(d) 模块 docstring 用法清单（`用法（无打包…）`代码块内，`runs` 行附近）加一行：

```
    python -m module_harness.cli artifacts [--run-id xxx] [--json]
```

- [ ] **Step 4: 跑测试确认通过 + CLI 回归**

Run: `uv run pytest ../SpecModule/module_harness/tests/test_artifacts.py -q`
Expected: PASS（29 passed）

Run: `uv run pytest ../SpecModule/module_harness/tests/test_cli.py ../SpecModule/module_harness/tests/test_query.py -q`
Expected: 全绿

- [ ] **Step 5: 提交（库仓库）**

```bash
cd ../SpecModule && git add module_harness/infra/query.py module_harness/cli/cli.py module_harness/tests/test_artifacts.py && git commit -m "feat(artifacts): query.read_artifacts 共享读端 + CLI artifacts 子命令（run 产物清单 1/3 完）" && cd -
```

---

## Task 5（库）: ppt_master 声明落地

**Files:**
- Modify: `../SpecModule/example/ppt_master/translator.py`（`tl_generate` 的 return，文件内唯一 return 点）
- Test: `../SpecModule/example/test_ppt_master_translator.py`（扩展既有 `test_tl_generate_writes_envelope_and_returns_tasks`）

**说明:** `spec["output"]["dir"]` 在 `validate_ppt_spec` 缺省回填后恒存在（缺省 `projects/<project>`）；`_spec(2)` 夹具 project="t" → 回填 `projects/t`。

- [ ] **Step 1: 扩展既有测试（先失败）**

`../SpecModule/example/test_ppt_master_translator.py` 的 `test_tl_generate_writes_envelope_and_returns_tasks`，在 `assert (tmp_path / "projects" / "t").is_dir()` 之后加：

```python
    assert out["Artifacts"] == [{
        "name": "t 演示文稿",
        "kind": "deliverable",
        "pick": "latest",
        "path": "projects/t/exports/*.pptx",
    }]
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest ../SpecModule/example/test_ppt_master_translator.py -q`
Expected: FAIL（`KeyError: 'Artifacts'`）

- [ ] **Step 3: 修改 tl_generate return**

`../SpecModule/example/ppt_master/translator.py` 中 `tl_generate` 末尾（唯一 return 点）：

```python
    return {"Tasks": tasks, "Flow": flow}
```

改为：

```python
    return {
        "Tasks": tasks,
        "Flow": flow,
        # 产物声明：最终交付物 = exports/ 下最新导出的 pptx（命名带时间戳，
        # 同项目多次运行积累——pick=latest 取 mtime 最新；output.dir 已回填）
        "Artifacts": [{
            "name": f"{spec['project']} 演示文稿",
            "kind": "deliverable",
            "pick": "latest",
            "path": f"{spec['output']['dir']}/exports/*.pptx",
        }],
    }
```

- [ ] **Step 4: 跑测试确认通过 + ppt 全量回归**

Run: `uv run pytest ../SpecModule/example/test_ppt_master_translator.py -q`
Expected: PASS

Run: `uv run pytest ../SpecModule/example/test_ppt_master_module.py ../SpecModule/example/test_ppt_master_translator.py -q`
Expected: 全绿（tasklist 多一个顶层键不影响既有断言）

- [ ] **Step 5: 提交（库仓库）**

```bash
cd ../SpecModule && git add example/ppt_master/translator.py example/test_ppt_master_translator.py && git commit -m "feat(example): ppt_master tl_generate 注入 Artifacts 声明——交付物 = 最新导出 pptx（run 产物清单 2/3）" && cd -
```

---

## Task 6（库）: api.md 补录 + 版本 bump

**Files:**
- Modify: `../SpecModule/docs/references/api.md`
- Modify: `../SpecModule/pyproject.toml`（version）

- [ ] **Step 1: api.md 表格补行**

`../SpecModule/docs/references/api.md` 的 query 函数表（`## module_harness.infra.query` 节），在 `read_module_inputs` 行之后插入一行：

```markdown
| `read_artifacts` | `(run_id: str, base_dir: Path \| None = None) -> dict \| None` | 读 run 产物清单（tasklist 顶层 `Artifacts` 声明制，Module 终态 done/truncated 收尾收集落 `artifacts.json`，文件本体不搬、条目路径为收集时绝对路径）；返回 `{run_id, artifacts: [{index, name, kind, path, size, modified}]}`（index=数组序，下载只按 index 引用——路径永不为客户端输入）；run 目录不存在 → `None`；清单缺失/损坏 → 空列表 |
```

- [ ] **Step 2: api.md 声明契约段落**

同文件，表格之后的 `CLI 对应子命令` 段落改为（补 artifacts 子命令 + 声明契约说明）：

```markdown
CLI 对应子命令：`specmodule runs [--json]`（`list_runs` 列表展示）、`specmodule delete-run <run_id>`（删除并打印移除的目录；不存在报错退出非零）、`specmodule artifacts [--run-id xxx] [--json]`（产物清单）——参数语义见 [cli-usage.md](cli-usage.md)。

run 产物声明（2026-09-29）：tasklist 顶层可带 `"Artifacts": [{name, path, kind, pick}]`
（`ArtifactDecl`，model/spec.py）——`name` 展示名；`path` 具体 glob 串（相对路径按
运行进程 cwd 解析，spec 派生路径由翻译脚本自行插值，库不做模板机制）；`kind` ∈
`deliverable`（交付物）| `intermediate`（缺省）；`pick` ∈ `all`（缺省，按 path 排序
全收）| `latest`（匹配集 mtime 最新一个）。Module 在终态 done/truncated 收尾收集
（`_run_with_phases` → `infra/artifacts.py`；cancelled/aborted 不收集；声明存在但
零匹配 → 写空清单），落 `<run_dir>/artifacts.json`（原子写）。无声明的 run 不产生
清单文件。`Artifacts` 不参与 resume 兼容性校验，随 module_inputs 存档自然往返。
```

- [ ] **Step 3: 版本 bump**

`../SpecModule/pyproject.toml`：`version = "0.3.0"` → `version = "0.4.0"`。

- [ ] **Step 4: 提交（库仓库）**

```bash
cd ../SpecModule && git add docs/references/api.md pyproject.toml && git commit -m "docs: api.md 补录产物清单契约（read_artifacts / Artifacts 声明 / CLI）+ 0.4.0（run 产物清单 3/3）" && cd -
```

---

## Task 7（webview）: server 两端点 + 测试

**Files:**
- Modify: `server/api/runs.py`（import + 两端点）
- Modify: `tests/conftest.py`（`seed_run` 加 `artifacts` 参数）
- Test: `tests/test_runs_api.py`（续加）

- [ ] **Step 1: conftest seed_run 扩展（先写测试基建）**

`tests/conftest.py` 的 `seed_run`：签名加 `artifacts: list[dict] | None = None`（放在 `inputs` 之后），函数体在 `if status is not None:` 块之前加：

```python
    if artifacts is not None:
        (run_dir / "artifacts.json").write_text(
            json.dumps({"run_id": run_id, "artifacts": artifacts},
                       ensure_ascii=False),
            encoding="utf-8",
        )
```

- [ ] **Step 2: 写失败测试**

`tests/test_runs_api.py` 末尾追加：

```python
class TestRunArtifacts:
    @staticmethod
    def _manifest(run_id, path="x/deck.pptx"):
        return [{"name": "deck", "kind": "deliverable", "path": path,
                 "size": 4, "modified": "2026-09-29T10:00:00"}]

    def test_list_shape(self, base, client):
        seed_run(base, "r_art", artifacts=self._manifest("r_art"))
        r = client.get("/api/runs/r_art/artifacts")
        assert r.status_code == 200
        body = r.json()
        assert body["run_id"] == "r_art"
        a = body["artifacts"][0]
        assert set(a) == {"index", "name", "kind", "path", "size", "modified"}
        assert a["index"] == 0 and a["name"] == "deck"

    def test_list_unknown_run_404(self, client):
        r = client.get("/api/runs/ghost/artifacts")
        assert r.status_code == 404
        assert r.json()["detail"]["error"] == "无运行记录"

    def test_list_no_manifest_empty(self, base, client):
        seed_run(base, "r_empty", status={"module_id": "r_empty", "phase": "done"})
        r = client.get("/api/runs/r_empty/artifacts")
        assert r.status_code == 200
        assert r.json() == {"run_id": "r_empty", "artifacts": []}

    def test_list_corrupt_manifest_empty(self, base, client):
        run_dir = seed_run(base, "r_bad")
        (run_dir / "artifacts.json").write_text("{broken", encoding="utf-8")
        r = client.get("/api/runs/r_bad/artifacts")
        assert r.status_code == 200
        assert r.json()["artifacts"] == []

    def test_download_streams_file(self, base, client):
        run_dir = seed_run(base, "r_dl")
        f = base / "out" / "deck.pptx"
        f.parent.mkdir(parents=True)
        f.write_bytes(b"PKPK")
        (run_dir / "artifacts.json").write_text(json.dumps({
            "run_id": "r_dl", "artifacts": self._manifest("r_dl", str(f)),
        }, ensure_ascii=False), encoding="utf-8")
        r = client.get("/api/runs/r_dl/artifacts/0")
        assert r.status_code == 200
        assert r.content == b"PKPK"
        assert r.headers["content-disposition"].startswith("attachment")
        assert "deck.pptx" in r.headers["content-disposition"]

    def test_download_index_out_of_range_404(self, base, client):
        seed_run(base, "r_oob", artifacts=self._manifest("r_oob"))
        assert client.get("/api/runs/r_oob/artifacts/5").status_code == 404
        assert client.get("/api/runs/r_oob/artifacts/-1").status_code == 404

    def test_download_file_deleted_410(self, base, client):
        seed_run(base, "r_gone", artifacts=self._manifest("r_gone"))
        r = client.get("/api/runs/r_gone/artifacts/0")
        assert r.status_code == 410

    def test_download_unknown_run_404(self, client):
        assert client.get("/api/runs/ghost/artifacts/0").status_code == 404

    def test_download_non_integer_index_422(self, base, client):
        seed_run(base, "r_nan", artifacts=self._manifest("r_nan"))
        assert client.get("/api/runs/r_nan/artifacts/xyz").status_code == 422
```

- [ ] **Step 3: 跑测试确认失败**

Run: `uv run pytest tests/test_runs_api.py::TestRunArtifacts -q`
Expected: FAIL（404 Not Found——路由不存在）

- [ ] **Step 4: 实现两端点**

`server/api/runs.py`——import 区改为：

```python
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
```

文件末尾追加：

```python
@router.get("/{run_id}/artifacts")
def run_artifacts(run_id: str, base_dir: Path = Depends(get_base_dir)) -> dict:
    """run 产物清单：query.read_artifacts（声明制，终态收集 artifacts.json）。"""
    validate_run_id(run_id)
    data = query.read_artifacts(run_id, base_dir=base_dir)
    if data is None:
        raise not_found(run_id)
    return data


@router.get("/{run_id}/artifacts/{index}")
def run_artifact_download(
    run_id: str, index: int, base_dir: Path = Depends(get_base_dir)
) -> FileResponse:
    """产物下载：客户端只给 index，路径按清单自查（无遍历面）。

    index 是清单数组序——清单由库终态收集落盘，路径永不为客户端输入；
    Starlette 对非 ASCII 文件名自动补 filename* UTF-8（中文名安全）。
    """
    validate_run_id(run_id)
    data = query.read_artifacts(run_id, base_dir=base_dir)
    if data is None:
        raise not_found(run_id)
    arts = data["artifacts"]
    if index < 0 or index >= len(arts):
        raise HTTPException(
            status_code=404,
            detail={"error": "产物序号不存在", "run_id": run_id, "index": index},
        )
    entry = arts[index]
    p = Path(entry["path"])
    if not p.is_file():
        raise HTTPException(
            status_code=410,
            detail={"error": "产物文件已不存在", "run_id": run_id, "path": entry["path"]},
        )
    return FileResponse(p, filename=p.name, content_disposition_type="attachment")
```

- [ ] **Step 5: 跑测试确认通过 + webview 全量回归**

Run: `uv run pytest tests/test_runs_api.py::TestRunArtifacts -q`
Expected: PASS（9 passed）

Run: `uv run pytest tests/ -q`
Expected: 全绿

- [ ] **Step 6: 提交（webview 仓库）**

```bash
git add server/api/runs.py tests/conftest.py tests/test_runs_api.py && git commit -m "feat(server): run 产物清单 + 按 index 下载两端点——read_artifacts 薄映射 + FileResponse（410/越界 404 契约）"
```

---

## Task 8（webview）: 前端产物条

**Files:**
- Modify: `web/src/api.ts`（类型 + fetch 函数）
- Create: `web/src/components/ArtifactsStrip.tsx`
- Modify: `web/src/components/RunView.tsx`（import + state/effect + 渲染）

**验收门:** `cd web && npm run build`（tsc --noEmit + vite build）。

- [ ] **Step 1: api.ts 类型与 fetch**

`web/src/api.ts`——在 `RunsPayload` 接口之后加类型：

```ts
export interface RunArtifact {
  index: number;
  name: string;
  kind: "deliverable" | "intermediate";
  path: string;
  size: number;
  modified: string;
}

export interface RunArtifactsPayload {
  run_id: string;
  artifacts: RunArtifact[];
}
```

文件末尾（与其他 `fetch*` 函数并列）加：

```ts
export async function fetchRunArtifacts(
  runId: string,
): Promise<RunArtifactsPayload> {
  return getJson(`/api/runs/${encodeURIComponent(runId)}/artifacts`);
}
```

- [ ] **Step 2: ArtifactsStrip 组件**

创建 `web/src/components/ArtifactsStrip.tsx`：

```tsx
// 产物条（RunView 终态）：声明制产物清单（GET /api/runs/{id}/artifacts）的
// 下载 chips——本地/云端同一 HTTP 下载交互；清单为空不渲染。
import { FileDown } from "lucide-react";
import type { RunArtifact } from "../api";

function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

export function ArtifactsStrip({
  runId,
  artifacts,
}: {
  runId: string;
  artifacts: RunArtifact[];
}) {
  if (artifacts.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b bg-secondary/40 px-3.5 py-1.5 text-[12px]">
      <span className="shrink-0 text-muted-foreground">产物</span>
      {artifacts.map((a) => (
        <a
          key={a.index}
          href={`/api/runs/${encodeURIComponent(runId)}/artifacts/${a.index}`}
          download
          title={`${a.name} · ${a.modified}\n${a.path}`}
          className="flex items-center gap-1.5 rounded-[5px] border bg-card px-2 py-0.5 transition-colors hover:border-foreground/30 hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <FileDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className={a.kind === "deliverable" ? "font-medium" : ""}>
            {a.name}
          </span>
          <span className="text-muted-foreground">{fmtSize(a.size)}</span>
          {a.kind === "deliverable" && (
            <span className="rounded bg-[var(--ph-done-bg)] px-1 text-[10px] text-[var(--ph-done-text)]">
              交付物
            </span>
          )}
        </a>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: RunView 接线**

`web/src/components/RunView.tsx` 三处：

(a) import 块——`../api` 导入改为（加 `fetchRunArtifacts` 与 `type RunArtifact`）：

```tsx
import {
  ApiError,
  fetchControl,
  fetchGraph,
  fetchInputs,
  fetchModules,
  fetchProcess,
  fetchRunArtifacts,
  fetchStatus,
  postTerminate,
  TERMINAL_PHASES,
  type GraphPayload,
  type ModuleInfo,
  type RunArtifact,
  type StatusCore,
  type StatusResp,
} from "../api";
import { resolveInputSource, type TraceState } from "../lib/inputSource";
import { useRunStream } from "../ws";
import { ArtifactsStrip } from "./ArtifactsStrip";
import { GraphView } from "./GraphView";
```

(b) 在 `const statusView: StatusCore | null = stream ?? initialStatus;`（约 331 行）之前插 state，之后插 effect：

```tsx
  // 产物清单：终态（done/aborted/cancelled/truncated）拉取——终态翻转与
  // 终态 run 首载都经 phase 变化触发；非终态清空（resume 重跑后旧清单失效）
  const [artifacts, setArtifacts] = useState<RunArtifact[]>([]);
```

```tsx
  const runPhase = statusView?.phase ?? payload?.phase ?? null;
  useEffect(() => {
    if (runPhase == null || !TERMINAL_PHASES.has(runPhase)) {
      setArtifacts([]);
      return;
    }
    let cancelled = false;
    fetchRunArtifacts(runId)
      .then((d) => {
        if (!cancelled) setArtifacts(d.artifacts);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [runId, runPhase]);
```

(c) 渲染——`</header>`（约 465 行）之后、`{stalled && (` 之前插：

```tsx
      <ArtifactsStrip runId={runId} artifacts={artifacts} />
```

- [ ] **Step 4: 构建验收**

Run: `cd web && npm run build`
Expected: tsc 零错误 + vite build 成功

- [ ] **Step 5: 提交（webview 仓库）**

```bash
git add web/src/api.ts web/src/components/ArtifactsStrip.tsx web/src/components/RunView.tsx && git commit -m "feat(web): RunView 终态产物条——清单 chips + HTTP 下载（本地/云端同一交互）"
```

---

## Task 9（webview）: AGENTS.md 端点映射表补录

**Files:**
- Modify: `AGENTS.md`（端点映射表，`/api/runs/{id}/process/terminate` 行之后）

- [ ] **Step 1: 补两行映射**

`AGENTS.md` 端点表在 `POST /api/runs/{id}/process/terminate` 行之后插入：

```markdown
| `GET /api/runs/{id}/artifacts` | `query.read_artifacts(run_id, base_dir=None)` | `{run_id, artifacts: [{index, name, kind, path, size, modified}]}`；无 run → 404；无/损坏清单 → 空数组；清单由库终态（done/truncated）收尾写 `<run_dir>/artifacts.json`——tasklist 顶层 `Artifacts` 声明制（glob + pick=latest/all），cancelled/aborted 不收集 |
| `GET /api/runs/{id}/artifacts/{index}` | 清单 index → `FileResponse`（attachment） | 200 流式下载——客户端只给 index，路径按清单自查（无遍历面）；index 越界 → 404；文件已删 → 410；前端 RunView 终态产物条消费 |
```

- [ ] **Step 2: 提交（webview 仓库）**

```bash
git add AGENTS.md && git commit -m "docs(agents): 端点映射表补录 artifacts 清单/下载两端点"
```

---

## 收尾验收（全部任务后）

- [ ] 库基线：`uv run pytest ../SpecModule/module_harness/tests/ -q -m "not smoke"` 全绿
- [ ] webview 全量：`uv run pytest tests/ -q` 全绿
- [ ] 前端构建：`cd web && npm run build` 成功
- [ ] E2E 冒烟（可选，需 mock 模块即可）：库侧 `uv run python -m module_harness.cli run --module hello --spec '{"name":"world"}'`（hello 无声明不产清单）→ 确认无 artifacts.json；有声明路径由 Task 3 集成测试覆盖
- [ ] 收尾归档：`roadmap/finish.md` 按仓库纪律追加完成记录；云端部署待办（库发 PyPI 0.4.0 后同步依赖）开 GitHub issue 备忘
