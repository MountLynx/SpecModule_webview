# entry→packed 转化可编辑 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** entry 模块经「物化 → 安装 → entry 文件退位」转为 packed，接入既有反解编辑闭环。

**Architecture:** 库收编共享转化函数 `entry_to_pack`（纯物化零副作用，CLI publish 与 Web convert 共用）；server 端点薄映射 + 安装/退位策略；前端转化按钮串联既有反解流程。

**Tech Stack:** Python ≥3.10（stdlib + tickflow + llm.mock）、FastAPI、React + TS。

**设计定稿:** `docs/superpowers/specs/2026-09-29-entry-to-packed-convert-design.md`

---

### Task 1: 库侧 `entry_pack.py` + 单测（SpecModule 仓库）

**Files:**
- Create: `../SpecModule/module_harness/infra/entry_pack.py`
- Test: `../SpecModule/module_harness/tests/test_entry_pack.py`

- [x] **Step 1: 写测试（先失败）**

```python
# module_harness/tests/test_entry_pack.py
"""entry → pack 物化共享层：组件提取/别名行/submodule 打包/错误契约。"""

from __future__ import annotations

import pytest

from module_harness.cli.entry import discover_modules
from module_harness.cli.loader import ModuleLoader
from module_harness.infra.entry_pack import entry_to_pack
from module_harness.infra.store import validate_pack_dir

ENTRY_PY = '''
from module_harness.cli.entry import ModuleEntry
from module_harness.core.config import HarnessConfig
from module_harness.core.registry import HarnessRegistry
from module_harness.infra.events import EventBus
from module_harness.model.spec import SpecSchema, Tasklist, TaskDefinition
from module_harness.model.submodule import SubModule, script

GREET = HarnessConfig.from_dict(
    {"name": "greet_h", "prompt_core": "你好 {name}", "temperature": 0.1})


def _registry(llm_client, template_name, event_bus):
    reg = HarnessRegistry(llm_client=llm_client, event_bus=event_bus or EventBus.null())
    reg.harness("greet_h", GREET)
    reg.script("shout")(_shout_impl)
    reg.guard("is_ok")(_is_ok_impl)
    return reg


def _shout_impl(view):
    return {"text": str(view.field("text")).upper()}


def _is_ok_impl(view):
    return True


class EchoSub(SubModule):
    name = "echo_sub"
    description = "回声子模块"
    spec_schema = SpecSchema(input={"text": "str"}, output={"echo": "str"})
    harnesses = [GREET]
    tasklist = Tasklist(
        tasks={"Echo": TaskDefinition(type="harness", harness="greet_h",
                                      inputs={"name": "{spec.text}"})},
        flow="[Echo]",
    )

    @script("echo_back")
    def echo_back(view):
        return {"echo": "done"}


TASKLIST = {
    "Tasks": {
        "Greet": {"type": "harness", "harness": "greet_h",
                  "inputs": {"name": "{spec.name}"}},
        "Shout": {"type": "script", "script": "shout", "inputs": {"text": "Greet"}},
        "Echo": {"type": "submodule", "submodule": "echo_sub",
                 "inputs": {"text": "Shout"}},
    },
    "Flow": "[Greet] --|is_ok|--> Shout --> Echo",
}

entry = ModuleEntry(
    name="hello_entry",
    description="测试 entry 模块",
    templates={"hello_entry": {"name": "hello_entry", "tasklist": TASKLIST}},
    submodules={"echo_sub": EchoSub},
    build_registry=_registry,
    default_template="hello_entry",
    default_spec={"name": "world"},
    spec_schema={"name": "str"},
    review_harness=None,
)
'''


@pytest.fixture
def entry(tmp_path):
    d = tmp_path / "modules"
    d.mkdir()
    (d / "hello_entry.py").write_text(ENTRY_PY, encoding="utf-8")
    return discover_modules(d)["hello_entry"]


def _pack(entry_obj, tmp_path, **kw):
    return entry_to_pack(entry_obj, out_dir=tmp_path / "packout", **kw)


class TestEntryToPack:
    def test_materializes_self_contained_pack(self, entry, tmp_path):
        result = _pack(entry, tmp_path)
        pack = result.pack_dir
        manifest = validate_pack_dir(pack)
        assert manifest["name"] == "hello_entry"
        assert manifest["tasklist"]["Flow"] == "[Greet] --|is_ok|--> Shout --> Echo"
        assert (pack / "harnesses" / "greet_h.json").is_file()
        scripts = (pack / "scripts" / "shout.py").read_text(encoding="utf-8")
        assert "shout = _shout_impl" in scripts      # 注册名 ≠ 函数名 → 别名行
        assert (pack / "guards" / "is_ok.py").is_file()
        assert (pack / "submodules" / "echo_sub" / "module.json").is_file()
        assert manifest["modules"] == ["echo_sub"]
        assert any("default_spec" in w for w in result.warnings)
        assert any("shout" in w for w in result.warnings)
        assert result.dropped_templates == []

    def test_loader_roundtrip(self, entry, tmp_path):
        result = _pack(entry, tmp_path)
        sub = ModuleLoader().load(result.pack_dir, lazy_client=True)
        assert callable(sub._scripts["shout"])
        assert callable(dict(sub.guards)["is_ok"])
        assert sub.modules["echo_sub"].name == "echo_sub"
        assert any(h.name == "greet_h" for h in sub.harnesses)

    def test_dropped_templates_listed(self, entry, tmp_path):
        entry.templates["second"] = dict(entry.templates["hello_entry"])
        result = _pack(entry, tmp_path)
        assert result.dropped_templates == ["second"]
        assert any("second" in w for w in result.warnings)

    def test_explicit_template(self, entry, tmp_path):
        entry.templates["second"] = dict(entry.templates["hello_entry"])
        result = _pack(entry, tmp_path, template_name="second")
        assert result.template_name == "second"

    def test_no_default_template_error(self, entry, tmp_path):
        entry.default_template = None
        with pytest.raises(ValueError, match="default_template"):
            _pack(entry, tmp_path)

    def test_unknown_template_error(self, entry, tmp_path):
        with pytest.raises(ValueError, match="未注册"):
            _pack(entry, tmp_path, template_name="nope")

    def test_missing_harness_error(self, entry, tmp_path):
        entry.templates["hello_entry"]["tasklist"]["Tasks"]["Ghost"] = {
            "type": "harness", "harness": "ghost_h"}
        with pytest.raises(ValueError, match="ghost_h"):
            _pack(entry, tmp_path)

    def test_harness_name_mismatch_error(self, entry, tmp_path):
        from module_harness.core.config import HarnessConfig
        from module_harness.core.registry import HarnessRegistry
        from module_harness.infra.events import EventBus

        cfg = HarnessConfig.from_dict({"name": "real_name", "prompt_core": "x"})

        def bad_registry(llm_client, template_name, event_bus):
            reg = HarnessRegistry(llm_client=llm_client, event_bus=EventBus.null())
            reg.harness("greet_h", cfg)   # 注册键 greet_h ≠ cfg.name
            return reg

        entry.build_registry = bad_registry
        with pytest.raises(ValueError, match="不一致"):
            _pack(entry, tmp_path)

    def test_submodule_missing_error(self, entry, tmp_path):
        entry.submodules.clear()
        with pytest.raises(ValueError, match="echo_sub"):
            _pack(entry, tmp_path)

    def test_missing_guard_error(self, entry, tmp_path):
        entry.templates["hello_entry"]["tasklist"]["Flow"] = "[Greet] --|ghost_g|--> Shout"
        with pytest.raises(ValueError, match="ghost_g"):
            _pack(entry, tmp_path)
```

- [x] **Step 2: 跑测试确认失败**

Run: `cd ../SpecModule && uv run pytest module_harness/tests/test_entry_pack.py -q`（无 uv 则 `python -m pytest`）
Expected: FAIL（`ModuleNotFoundError: entry_pack`）

- [x] **Step 3: 实现 `entry_pack.py`**

```python
# module_harness/infra/entry_pack.py
"""entry → pack 物化共享层：单文件 ModuleEntry 转自包含发布目录。

publish（CLI 单文件形态）与 Web convert 共用的唯一转化实现——纯物化零副作用：
只写临时目录，不碰 store（安装/entry 退位策略归调用方）。组件提取按 tasklist
引用驱动：harness/command 取配置 JSON，script/guard 取函数源码（注册名 ≠ 函数名
时文件尾补别名行——loader 按 stem 取函数），submodule 走类式 SubModule.pack()
整包导出。产物必须自包含可装载：提取失败抛 ValueError（消息可直接面向用户），
不静默出坏包。

诚实边界（warnings 交调用方透传）：translation 通道不保留（packed 无此契约，
按模板静态 tasklist 转化）；getsource 只取函数体文本，引用模块级常量/辅助函数
的 body 物化后装载通过、运行期才炸；default_spec 样例值不保留（packed manifest
无此契约键）。
"""

from __future__ import annotations

import inspect
import json
import logging
import re
import textwrap
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from ..core.builtins import BUILTIN_HARNESS_NAMES
from ..core.registry import HarnessRegistry
from ..infra.events import EventBus
from ..model.spec import Tasklist

if TYPE_CHECKING:
    from ..cli.entry import ModuleEntry

log = logging.getLogger(__name__)

# Flow 边的 guard 引用：`Review --|has_issues|--> Fix`
_GUARD_REF = re.compile(r"--\|([A-Za-z_][A-Za-z0-9_]*)\|")


@dataclass
class EntryPackResult:
    """entry_to_pack 产出：pack 目录 + 转化报告（调用方透传用户）。"""

    pack_dir: Path
    template_name: str
    dropped_templates: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def _write_fn_source(
    fn: Any, reg_name: str, pack: Path, kind: str, warnings: list[str]
) -> None:
    """注册函数 → ``<kind>/<reg_name>.py``：getsource + __future__ 头 +
    名不一致别名行（loader exec 后按 stem 取函数）。"""
    fn = inspect.unwrap(fn)
    try:
        src = textwrap.dedent(inspect.getsource(fn))
    except (OSError, TypeError) as e:
        raise ValueError(
            f"{kind} '{reg_name}' 源码不可静态导出（{e}）——"
            "闭包依赖/内置函数无法物化为自包含文件"
        ) from e
    text = "from __future__ import annotations\n\n" + src
    if fn.__name__ != reg_name:
        text += f"\n\n{reg_name} = {fn.__name__}\n"
        warnings.append(
            f"{kind} '{reg_name}' 注册名与函数名 {fn.__name__} 不一致——已补别名行")
    d = pack / kind
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{reg_name}.py").write_text(text, encoding="utf-8")


def entry_to_pack(
    entry: ModuleEntry,
    *,
    template_name: str | None = None,
    out_dir: Path | None = None,
) -> EntryPackResult:
    """ModuleEntry → 自包含 pack 目录（纯物化，不碰 store）。

    ``template_name`` 缺省回落 ``entry.default_template``（未声明 → ValueError）；
    其余模板进 ``dropped_templates``。tasklist 经 ``from_json → to_dict`` 规一化
    （无效模板早期失败）。registry 用 Mock client 构建（零 LLM）——只取配置与
    函数源码，不执行任何 body。``out_dir`` 缺省自建临时目录（调用方负责清理
    ``result.pack_dir``）。
    """
    import tempfile

    tname = template_name or entry.default_template
    if tname is None:
        raise ValueError(
            f"entry '{entry.name}' 未声明 default_template——转化需显式指定模板")
    if tname not in entry.templates:
        raise ValueError(
            f"模板 '{tname}' 未注册——可用: {', '.join(sorted(entry.templates))}")
    tpl = entry.templates[tname]
    dropped = sorted(set(entry.templates) - {tname})
    warnings: list[str] = []
    if dropped:
        warnings.append(
            f"未转化的模板: {', '.join(dropped)}（packed 单 tasklist，仅取 '{tname}'）")
    try:
        tasklist = Tasklist.from_json(tpl["tasklist"])
    except (KeyError, TypeError, ValueError) as e:
        raise ValueError(f"模板 '{tname}' 的 tasklist 无效: {e}") from e
    if tpl.get("translation"):
        warnings.append(
            "模板翻译通道未保留——按模板静态 tasklist 转化（packed 无 translation 契约）")
    if entry.default_spec:
        warnings.append("entry 级 default_spec 样例值不保留（packed manifest 无此契约键）")

    from llm.mock import MockLLMClient

    client = MockLLMClient()
    if entry.build_registry is not None:
        registry = entry.build_registry(client, tname, EventBus.null())
    else:
        registry = HarnessRegistry(llm_client=client, event_bus=EventBus.null())

    harness_files: dict[str, dict[str, Any]] = {}
    command_files: dict[str, dict[str, Any]] = {}
    script_bodies: dict[str, Any] = {}
    for key, task in tasklist.tasks.items():
        if task.type == "harness":
            name = task.harness or ""
            if name in BUILTIN_HARNESS_NAMES:
                continue
            cfg = registry.harness_config(name)
            if cfg is None:
                raise ValueError(
                    f"task '{key}' 引用的 harness '{name}' 未在 entry registry 注册")
            if cfg.name != name:
                raise ValueError(
                    f"harness 注册名 '{name}' 与配置名 '{cfg.name}' 不一致——"
                    "tasklist 引用与装载键必须相同")
            harness_files[name] = cfg.to_dict()
        elif task.type == "command":
            name = task.command or ""
            cc = registry.command_config(name)
            if cc is None:
                raise ValueError(
                    f"task '{key}' 引用的 command '{name}' 未在 entry registry 注册")
            if cc.name != name:
                raise ValueError(
                    f"command 注册名 '{name}' 与配置名 '{cc.name}' 不一致——"
                    "tasklist 引用与装载键必须相同")
            command_files[name] = cc.to_dict()
        elif task.type == "script":
            name = task.script or ""
            try:
                script_bodies[name] = registry.get_body(name)
            except KeyError as e:
                raise ValueError(
                    f"task '{key}' 引用的 script '{name}' 未在 entry registry 注册") from e
        elif task.type == "submodule":
            name = task.submodule or ""
            if name not in entry.submodules:
                raise ValueError(
                    f"task '{key}' 引用的 submodule '{name}' 不在 entry.submodules 中")

    flow_guards = set(_GUARD_REF.findall(tasklist.flow))
    missing_guards = sorted(flow_guards - set(registry.guard_names()))
    if missing_guards:
        raise ValueError(
            f"Flow 引用的 guard 未在 entry registry 注册: {', '.join(missing_guards)}")

    pack = (Path(out_dir) if out_dir is not None
            else Path(tempfile.mkdtemp(prefix="specmodule_entry_")))
    manifest = {
        "name": entry.name,
        "version": "0.1.0",
        "description": entry.description,
        "submodule": False,
        "spec_schema": {"input": dict(entry.spec_schema or {}), "output": {}},
        "requires": [],
        "modules": sorted(entry.submodules),
        "tasklist": tasklist.to_dict(),
    }
    (pack / "module.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    (pack / "harnesses").mkdir(parents=True, exist_ok=True)
    for fname, data in harness_files.items():
        (pack / "harnesses" / f"{fname}.json").write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    (pack / "commands").mkdir(parents=True, exist_ok=True)
    for fname, data in command_files.items():
        (pack / "commands" / f"{fname}.json").write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    for name, fn in script_bodies.items():
        _write_fn_source(fn, name, pack, "scripts", warnings)
    for gname in sorted(flow_guards):
        _write_fn_source(registry.get_guard(gname), gname, pack, "guards", warnings)
    for key in sorted(entry.submodules):
        sub_dir = pack / "submodules" / key
        sub_dir.mkdir(parents=True, exist_ok=True)
        try:
            entry.submodules[key]().pack(sub_dir)
        except Exception as e:
            raise ValueError(f"submodule '{key}' 打包失败: {e}") from e
    return EntryPackResult(
        pack_dir=pack, template_name=tname,
        dropped_templates=dropped, warnings=warnings,
    )
```

- [x] **Step 4: 跑测试确认通过**

Run: `cd ../SpecModule && uv run pytest module_harness/tests/test_entry_pack.py -q`
Expected: 10 passed

- [x] **Step 5: Commit（SpecModule 仓库）**

```bash
cd ../SpecModule && git add module_harness/infra/entry_pack.py module_harness/tests/test_entry_pack.py
git commit -m "feat(infra): entry_to_pack 共享物化层——单文件 ModuleEntry 转自包含 pack（publish/Web convert 共用）"
```

### Task 2: CLI publish 收编重构（SpecModule 仓库）

**Files:**
- Modify: `../SpecModule/module_harness/cli/cli.py`（`_cmd_publish` 单文件分支，约 1028–1131 行）
- Test: `../SpecModule/module_harness/tests/test_cli.py`（追加 `TestPublish`）

- [x] **Step 1: 追加 publish 测试（先失败）**

在 `test_cli.py` 顶部 import 区加 `from module_harness.tests.test_entry_pack import ENTRY_PY`，文件尾部追加：

```python
class TestPublish:
    def test_single_file_publish(self, tmp_path, monkeypatch):
        monkeypatch.setenv("SPECMODULE_HOME", str(tmp_path / "home"))
        (tmp_path / "modules").mkdir()
        (tmp_path / "modules" / "hello_entry.py").write_text(ENTRY_PY, encoding="utf-8")
        assert main(["publish", "--from-dir", str(tmp_path), "--name", "hello_entry"]) == 0
        dest = tmp_path / "home" / "modules" / "hello_entry"
        assert (dest / "module.json").is_file()
        assert (dest / "guards" / "is_ok.py").is_file()   # guard 不再静默丢弃
        assert (tmp_path / "home" / "manifests" / "hello_entry.json").is_file()

    def test_publish_no_entry(self, tmp_path, monkeypatch):
        monkeypatch.setenv("SPECMODULE_HOME", str(tmp_path / "home"))
        (tmp_path / "modules").mkdir()
        assert main(["publish", "--from-dir", str(tmp_path), "--name", "nope"]) == 1
```

（若 `main` 未在文件头 import，按文件既有 import 补。）

- [x] **Step 2: 跑测试确认失败**

Run: `cd ../SpecModule && uv run pytest module_harness/tests/test_cli.py::TestPublish -q`
Expected: test_single_file_publish FAIL（旧实现 guard 丢弃 → `guards/is_ok.py` 不存在；或旧 script 名 bug 装载失败）

- [x] **Step 3: 重构 `_cmd_publish` 单文件分支**

替换单文件分支（`# 单文件 entry 形态：...` 注释起至 `print(f"已发布（单文件转化）...` 前）为：

```python
    # 单文件 entry 形态：库共享物化（entry_to_pack）→ install（D9）。
    # 组件提取/别名行/submodule 打包的唯一实现收编 infra/entry_pack.py；
    # guards 现随 Flow 引用导出（旧实现静默丢弃），script 注册名 ≠ 函数名
    # 由别名行兜底（旧实现产物 loader 装载必炸）。
    entry_file = src / "modules" / f"{args.name}.py"
    if not entry_file.is_file():
        print(
            f"发布源无效: {src}（既不是 pack 目录，也没有 modules/{args.name}.py）",
            file=sys.stderr,
        )
        return 1
    from .entry import discover_modules
    from ..infra.entry_pack import entry_to_pack

    entries = discover_modules(src / "modules")
    entry = entries.get(args.name)
    if entry is None:
        print(f"模块 '{args.name}' 未找到（{entry_file} 无 entry 声明）", file=sys.stderr)
        return 1
    if entry.default_template is None:
        print(
            f"单文件形态 publish 失败（{args.name}）：entry 未声明 default_template。"
            "请用目录形态：specmodule init <name> --as-dir",
            file=sys.stderr,
        )
        return 1

    import shutil
    import tempfile

    tmp = Path(tempfile.mkdtemp())
    try:
        result = entry_to_pack(entry)
        dest = store.install_pack(result.pack_dir, source=args.from_dir, name=entry.name)
    except ValueError as e:
        print(f"发布失败: {e}", file=sys.stderr)
        return 1
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
```

（删除旧的内联提取块：MockLLMClient registry 构建、按 tasklist 提取、等价 SubModule 组装、旧 tempfile 块。`MockLLMClient`/`EventBus`/`HarnessRegistry`/`Tasklist`/`SpecSchema`/`SubModule`/`BUILTIN_HARNESS_NAMES` import 若无其他使用者一并清理。）

- [x] **Step 4: 跑测试确认通过 + 库基线**

Run: `cd ../SpecModule && uv run pytest module_harness/tests/test_cli.py module_harness/tests/test_entry_pack.py -q` 然后 `uv run pytest module_harness/tests/ -q -m "not smoke"`
Expected: 全绿

- [x] **Step 5: Commit**

```bash
cd ../SpecModule && git add module_harness/cli/cli.py module_harness/tests/test_cli.py
git commit -m "refactor(cli): publish 单文件转化收编 entry_to_pack——guards 导出 + script 名别名行修复"
```

### Task 3: 库文档补录（SpecModule 仓库）

**Files:**
- Modify: `../SpecModule/docs/references/api.md`（store/共享层节）
- Modify: `../SpecModule/docs/references/cli-usage.md`（publish 节）

- [x] **Step 1: api.md 补录 `entry_to_pack`**

在 store 共享层相关函数（`install_pack`/`apply_update` 一带）追加条目：签名
`entry_to_pack(entry, *, template_name=None, out_dir=None) -> EntryPackResult`、
语义（纯物化零副作用/模板选择/tasklist 规一化/组件提取驱动/别名行/submodule
整包/ValueError 错误契约/四类 warnings）、`EntryPackResult` 字段、消费端
（CLI publish / Web convert）。按该文档既有条目格式排版。

- [x] **Step 2: cli-usage.md publish 语义更新**

publish 单文件形态：guards 现随 Flow 引用导出；script 注册名 ≠ 函数名自动补
别名行；其余语义不变。按文档既有格式更新。

- [x] **Step 3: Commit（docs 前缀）**

```bash
cd ../SpecModule && git add docs/references/api.md docs/references/cli-usage.md
git commit -m "docs: api.md 补录 entry_to_pack；cli-usage.md publish 单文件转化语义更新"
```

### Task 4: server convert 端点 + 端点测试（webview 仓库）

**Files:**
- Modify: `server/api/build.py`（文件尾追加 convert 路由；头部 import 补 `entry_to_pack`）
- Test: `tests/test_build_api.py`（追加 `TestEntryConvert`）

- [x] **Step 1: 写端点测试（先失败）**

`tests/test_build_api.py` 追加（fixture 同文件既有风格；`seed_pack_module` 已存在）：

```python
ENTRY_PY = '''
from module_harness.cli.entry import ModuleEntry
from module_harness.core.config import HarnessConfig
from module_harness.core.registry import HarnessRegistry
from module_harness.infra.events import EventBus

GREET = HarnessConfig.from_dict(
    {"name": "greet_h", "prompt_core": "你好 {name}", "temperature": 0.1})


def _registry(llm_client, template_name, event_bus):
    reg = HarnessRegistry(llm_client=llm_client, event_bus=event_bus or EventBus.null())
    reg.harness("greet_h", GREET)
    reg.script("shout")(_shout_impl)
    reg.guard("is_ok")(_is_ok_impl)
    return reg


def _shout_impl(view):
    return {"text": str(view.field("text")).upper()}


def _is_ok_impl(view):
    return True


TASKLIST = {
    "Tasks": {
        "Greet": {"type": "harness", "harness": "greet_h",
                  "inputs": {"name": "{spec.name}"}},
        "Shout": {"type": "script", "script": "shout", "inputs": {"text": "Greet"}},
    },
    "Flow": "[Greet] --|is_ok|--> Shout",
}

entry = ModuleEntry(
    name="hello_entry",
    description="测试 entry 模块",
    templates={"hello_entry": {"name": "hello_entry", "tasklist": TASKLIST}},
    build_registry=_registry,
    default_template="hello_entry",
    default_spec={"name": "world"},
    spec_schema={"name": "str"},
    review_harness=None,
)
'''


def seed_entry_module(home: Path, name: str = "hello_entry") -> Path:
    """隔离 store modules/ 下种 entry 单文件。"""
    d = home / "modules"
    d.mkdir(parents=True, exist_ok=True)
    p = d / f"{name}.py"
    p.write_text(
        ENTRY_PY.replace("hello_entry", name) if name != "hello_entry" else ENTRY_PY,
        encoding="utf-8")
    return p


class TestEntryConvert:
    def test_convert_success(self, client, base):
        home = base / "home"
        seed_entry_module(home)
        r = client.post("/api/modules/hello_entry/convert", json={})
        assert r.status_code == 200
        data = r.json()
        assert data["module"]["kind"] == "packed"
        assert data["warnings"]                      # default_spec 丢弃 → 有 warning
        # entry 文件退位（.bak，可逆）
        assert not (home / "modules" / "hello_entry.py").exists()
        assert (home / "modules" / "hello_entry.py.bak").exists()
        # 产物装载语义完整（别名行 script 可解析）
        from module_harness.infra.store import validate_pack_dir
        manifest = validate_pack_dir(home / "modules" / "hello_entry")
        assert manifest["name"] == "hello_entry"
        assert "shout = _shout_impl" in (
            home / "modules" / "hello_entry" / "scripts" / "shout.py").read_text(encoding="utf-8")
        assert (home / "modules" / "hello_entry" / "guards" / "is_ok.py").is_file()
        # manifest 已写（同名更新闭环可用）
        assert (home / "manifests" / "hello_entry.json").is_file()

    def test_convert_non_entry_400(self, client, base):
        seed_pack_module(base / "home")
        r = client.post("/api/modules/sub_greet/convert", json={})
        assert r.status_code == 400

    def test_convert_unknown_404(self, client, base):
        r = client.post("/api/modules/nope/convert", json={})
        assert r.status_code == 404

    def test_convert_shadowed_409(self, client, base):
        home = base / "home"
        seed_entry_module(home)
        seed_pack_module(home, name="hello_entry")   # 同名 packed 已存在
        r = client.post("/api/modules/hello_entry/convert", json={})
        assert r.status_code == 409

    def test_convert_bad_template_400(self, client, base):
        seed_entry_module(base / "home")
        r = client.post("/api/modules/hello_entry/convert", json={"template": "nope"})
        assert r.status_code == 400
```

- [x] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/test_build_api.py::TestEntryConvert -q`
Expected: FAIL（404 Not Found——路由不存在）

- [x] **Step 3: 实现 convert 端点**

`server/api/build.py` 头部 import 区补：

```python
from module_harness.infra.entry_pack import entry_to_pack
```

文件尾追加：

```python
# ── entry 模块转化（转 packed 后接入既有编辑闭环）─────────────────────


@router.post("/modules/{name}/convert")
def convert_entry_route(
    name: str,
    body: dict | None = None,
    search: list[Path] = Depends(get_search_paths),
) -> dict:
    """entry 模块 → packed：库 entry_to_pack 物化 → install_pack → entry 文件
    退位（重命名 .bak，可逆；失败回滚卸载）。

    body {template?}：多模板 entry 指定转化模板（缺省 default_template）。
    非 entry 形态 → 400；同名其他来源（退位后须唯一命中）→ 409；模板非法/
    提取失败 → 400（ValueError 消息透传）；store 同名已存在 → 409。
    """
    _check_name(name)
    try:
        resolved = store.resolve_module_full(name, search=search)
    except ValueError as e:
        # entry 加载失败（导入抛错）→ 400 而非 500（manage.py/update 同款防护）
        raise HTTPException(status_code=400, detail={"error": str(e), "module": name})
    if resolved is None:
        raise HTTPException(status_code=404, detail={
            "error": f"模块 '{name}' 未找到", "module": name})
    if resolved.kind != "entry":
        raise HTTPException(status_code=400, detail={
            "error": f"模块 '{name}' 为 {resolved.kind} 形态，仅 entry 可转化",
            "module": name})
    # 防遮蔽：退位后名字必须唯一命中转化产物——同名其他来源先拒
    others = [s for s in store.list_modules(search=search).get(name, [])
              if s.path != resolved.source.path]
    if others:
        raise HTTPException(status_code=409, detail={
            "error": f"模块 '{name}' 存在同名其他来源（"
                     f"{', '.join(s.kind for s in others)}）——转化退位后会被遮蔽，"
                     "先处理同名来源", "module": name})
    if resolved.entry is None:
        raise HTTPException(status_code=500, detail={
            "error": "entry 解析异常", "module": name})
    template = (body or {}).get("template")
    tmp = Path(tempfile.mkdtemp(prefix="specmodule_convert_"))
    try:
        result = entry_to_pack(resolved.entry, template_name=template, out_dir=tmp / "pack")
        store.install_pack(result.pack_dir, source="webview-entry-convert", name=name)
    except (ValueError, TypeError, KeyError) as e:
        status = 409 if "已存在" in str(e) else 400
        raise HTTPException(status_code=status, detail={"error": str(e), "module": name})
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    # 退位：entry 文件重命名 .bak（discover 只 glob *.py）——失败回滚卸载，
    # 不留「entry 退位但包没装上」的半状态
    entry_file = Path(resolved.source.path)
    try:
        entry_file.rename(entry_file.with_name(entry_file.name + ".bak"))
    except OSError as e:
        store.uninstall_pack(name)
        raise HTTPException(status_code=400, detail={
            "error": f"entry 文件退位失败（已回滚安装）: {e}", "module": name})
    detail = store.resolve_module_full(name, search=get_search_paths())
    if detail is None:
        raise HTTPException(status_code=500, detail={
            "error": "转化后详情读取失败", "module": name})
    return {"module": store.detail_to_dict(detail), "warnings": result.warnings}
```

- [x] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/test_build_api.py -q`
Expected: 全绿

- [x] **Step 5: Commit**

```bash
git add server/api/build.py tests/test_build_api.py
git commit -m "feat(server): POST /api/modules/{name}/convert——entry 转 packed（安装+退位）"
```

### Task 5: 前端转化入口 + 串联反解（webview 仓库）

**Files:**
- Modify: `web/src/api.ts`（convertModule 封装）
- Modify: `web/src/components/ModuleDetail.tsx`（entry 形态按钮 + 转化编排）
- 修正: `docs/superpowers/specs/2026-09-29-entry-to-packed-convert-design.md`（App.tsx 行删除——串联在 ModuleDetail 内完成，无需壳层改动）

- [x] **Step 1: api.ts 封装**

`DecompileResult` 附近追加：

```ts
export interface ConvertResult { module: ModuleDetail; warnings: string[] }

export const convertModule = (name: string, template?: string) =>
  postJson<ConvertResult>(
    `/api/modules/${encodeURIComponent(name)}/convert`,
    template ? { template } : {},
  );
```

- [x] **Step 2: ModuleDetail 转化编排**

imports 补 `convertModule` 与 `Package`（lucide-react）。状态区补：

```tsx
const [converting, setConverting] = useState(false);
const [convertWarns, setConvertWarns] = useState<string[] | null>(null);
```

`runEdit` 后追加编排（转化 → 详情翻转 → 重置模板/spec 状态 → 串联既有反解）：

```tsx
const runConvert = async (d: ModuleDetailData) => {
  if (converting) return;
  if (!window.confirm(
    `把 entry 模块「${d.name}」转化为 packed？\n` +
    "转化产物装进 store 并接管同名；原 entry 文件将重命名为 .bak 备用（可随时改回）。")) {
    return;
  }
  // 多模板：packed 单流程只取一个——让用户指定（清空输入 = 默认模板）
  let template: string | undefined;
  if (d.templates.length > 1) {
    const picked = window.prompt(
      `该模块有 ${d.templates.length} 个模板，转化只取一个（其余丢弃）——输入模板名：\n` +
      d.templates.map((t) => `${t.name}${t.name === d.default_template ? "（默认）" : ""}`).join("\n"),
      d.default_template ?? d.templates[0]?.name ?? "",
    );
    if (picked === null) return;
    template = picked.trim() || undefined;
  }
  setConverting(true);
  setEditErr(null);
  try {
    const r = await convertModule(d.name, template);
    setConvertWarns(r.warnings.length ? r.warnings : null);
    // 详情翻转 packed：entry 时代的模板选择/spec 预填全部失效，重置
    setDetail(r.module);
    setTemplate(r.module.default_template ?? r.module.templates[0]?.name ?? "");
    setSpec({});
    setTouched(false);
    await runEdit(r.module.name);   // 串联既有反解闭环（报告面板 → 打开构建器）
  } catch (e) {
    setEditErr(e instanceof Error ? e.message : String(e));
  } finally {
    setConverting(false);
  }
};
```

头部按钮区（`detail.kind === "packed"` 编辑按钮旁）补 entry 分支：

```tsx
{detail.kind === "entry" && (
  <Button
    variant="outline"
    size="sm"
    className="ml-auto"
    disabled={converting || decompiling}
    onClick={() => runConvert(detail)}
  >
    <Package className="h-3.5 w-3.5" />
    {converting ? "转化中…" : "转为 packed 编辑"}
  </Button>
)}
```

报告面板前补转化 warnings 块（useEffect 重置区同步加 `setConvertWarns(null)`）：

```tsx
{convertWarns && (
  <div className="mt-4 rounded-md border p-3 text-[12px]">
    <div className="font-semibold">转化完成（entry → packed）注意项</div>
    <ul className="mt-1.5 space-y-0.5 text-muted-foreground">
      {convertWarns.map((x) => (
        <li key={x} className="text-[var(--ph-truncated)]">⚠ {x}</li>
      ))}
    </ul>
  </div>
)}
```

- [x] **Step 3: 类型/构建验证**

Run: `cd web && npm run build`
Expected: tsc 无错 + vite build 成功

- [x] **Step 4: spec 文档修正**

设计文档前端表中 App.tsx 行删除，改为注记「转化→反解串联在 ModuleDetail 内完成（runEdit 本就地），壳层零改动」。

- [x] **Step 5: Commit**

```bash
git add web/src/api.ts web/src/components/ModuleDetail.tsx docs/superpowers/specs/2026-09-29-entry-to-packed-convert-design.md
git commit -m "feat(web): entry 模块「转为 packed 编辑」——转化串联反解闭环 + warnings 透出"
```

### Task 6: 全量验证 + 归档

- [x] **Step 1: 全量测试**

```bash
uv run pytest tests/ -q                                    # webview 套件
uv run pytest ../SpecModule/module_harness/tests/ -q -m "not smoke"   # 库基线
cd web && npm run build                                    # 前端验收门
```
Expected: 全绿

- [x] **Step 2: 归档**

- `AGENTS.md` 端点映射表补 `POST /api/modules/{name}/convert` 行（entry_to_pack 库调用/形状 `{module, warnings}`/错误契约）；Key Directories 的 build.py 描述补「entry 转化」。
- `roadmap/roadmap.md` 模块构建器后排项注记 entry 转化落地。
- `roadmap/finish.md` 追加落地记录（含库仓库 commit 号、publish 两缺陷修复、诚实缺口清单）。
- Commit: `docs: entry 转 packed 落地归档——AGENTS 映射表 + roadmap/finish 记录`

---

## Self-Review

- **Spec coverage**: 库收编（Task 1-2）、publish 缺陷修复（Task 2）、api.md/cli-usage.md（Task 3）、convert 端点 + 409/400/404 契约 + 退位回滚（Task 4）、前端按钮/多模板/串联/warnings（Task 5）、归档（Task 6）。✓
- **Placeholder scan**: 无 TBD/「适当处理」；所有代码步骤含完整代码。✓
- **Type consistency**: `EntryPackResult(pack_dir/template_name/dropped_templates/warnings)` 各任务一致；`entry_to_pack` 签名一致；`ConvertResult{module, warnings}` 前后端一致。✓
- **已知实现细节决策**: guard 提取按 Flow 词引用正则 `_GUARD_REF`；harness/command 注册键 ≠ 配置名硬错误（tasklist 引用与装载键必须一致，spec「提取失败即硬错误」条款覆盖）；publish 保留 default_template 缺失的定制提示文案。
