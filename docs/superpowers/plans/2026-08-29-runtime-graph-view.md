# 运行时图视图实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付阶段 0 全部 HTTP 后端 + 阶段 1 的运行时图视图切片：解析好的图结构（node 名与边）、节点状态徽章（已完成/运行中/未运行/失败/次数）、跟随镜头（当前 tick 居中）、点击节点看 firing 历史与实时输出。

**Architecture:** 库侧把 CLI `visualize` 的组合（模块解析 → Mock registry → module_inputs 归档 → TasklistTranslator.build）收编为共享层函数 `query.build_run_graph` + 序列化 `query.graph_to_dict`；webview 的 FastAPI 薄层做端点映射与状态叠加；前端 React Flow 画布经 WS 增量刷新。

**Tech Stack:** Python ≥3.10 + FastAPI + uvicorn + pytest + httpx（后端）；Vite + React 18 + TypeScript + @xyflow/react + @dagrejs/dagre（前端）；specmodule 库（editable 安装 sibling 检出）。

**Spec:** `roadmap.md`（本仓库，2026-08-29 定稿节「运行时图视图设计」，commit 372c4f5）。

## Global Constraints

- 两个仓库：本仓库 `SpecModule_webview`（下称 **webview**）与库仓库 `../SpecModule`（下称 **库**）。库仓库提交独立进行，遵守其 AGENTS.md。
- 薄层原则：HTTP 端点 = 库调用 + 传输级映射；查询 None → 404 `{"error": "无运行记录", ...}`；操作 KeyError → 4xx 携带 `str(e)` 消息；未知 run_id → 404；畸形参数 → 422。
- `base_dir` 一律显式传（env `SPECMODULE_BASE`，缺省 cwd），绝不依赖隐式 cwd。
- Python ≥3.10；pip only；无 lint/format/type 工具配置（生态约定，不得引入）。
- 前端不引入测试框架（生态无先例）；验证 = `npm run build` 通过 + 端到端走查。
- 库代码风格：`from __future__ import annotations` 首行；中文 docstring；查询层容错（DB 读失败 → None，监控方不被搞崩）。
- 测试隔离：绝不触碰真实 `~/.specmodule`；fixture run 一律造在 `tmp_path` 下。
- 库 API 文档同步：消费/新增库 API 时同步补录 `../SpecModule/docs/references/api.md`（做到哪里写哪里）。
- 运行命令均在仓库根执行（webview 在自身根、库任务在库根）。

---

## Part 1 — 库仓库（../SpecModule）

### Task 1: `query.graph_to_dict` 序列化函数

**Files:**
- Modify: `../SpecModule/module_harness/query.py`（文件末尾追加）
- Test: `../SpecModule/module_harness/tests/test_graph_query.py`（新建）

**Interfaces:**
- Consumes: `tickflow.Graph`（nodes: `dict[str, Node]`，Node 含 `is_start`/`join`；edges: `list[Edge]`，Edge 含 `src`/`dst`/`guard`；`starts` property）、`spec.Tasklist`（`tasks: dict[str, TaskDefinition]`，TaskDefinition 含 `type: str`、`inputs: dict[str, str] | None`）
- Produces: `graph_to_dict(graph: Graph, tasklist: Tasklist) -> dict[str, Any]`，形状 `{"nodes": [{"id","label","type","is_start","join","inputs"}], "edges": [{"from","to","guard"}], "starts": [str]}`

- [ ] **Step 1: 写失败测试**

新建 `../SpecModule/module_harness/tests/test_graph_query.py`：

```python
# module_harness/tests/test_graph_query.py
"""共享查询层：build_run_graph / graph_to_dict（运行图重建 + 序列化）。"""

from __future__ import annotations

from tickflow import parse as parse_graph

from module_harness.query import graph_to_dict
from module_harness.spec import Tasklist


def _mini_tasklist() -> Tasklist:
    return Tasklist.from_json({
        "Tasks": {
            "A": {"type": "script", "script": "A"},
            "B": {"type": "script", "script": "B", "inputs": {"value": "A"}},
            "C": {"type": "submodule", "submodule": "child"},
        },
        "Flow": "[A] --> B\nA --|pick|--> C",
    })


class TestGraphToDict:
    def test_shape(self):
        # registry=None 时 guard 校验会炸（_validate 查 has_guard），这里只测
        # 无 guard 图的序列化；带 guard 的经 build_run_graph 覆盖（Task 2）。
        tl = Tasklist.from_json({
            "Tasks": {
                "A": {"type": "script", "script": "A"},
                "B": {"type": "script", "script": "B", "inputs": {"value": "A"}},
            },
            "Flow": "[A] --> B",
        })
        g = parse_graph("[A] --> B", registry=None)
        d = graph_to_dict(g, tl)
        assert d["starts"] == ["A"]
        assert d["nodes"] == [
            {"id": "A", "label": "A", "type": "script", "is_start": True,
             "join": "AND", "inputs": {}},
            {"id": "B", "label": "B", "type": "script", "is_start": False,
             "join": "AND", "inputs": {"value": "A"}},
        ]
        assert d["edges"] == [{"from": "A", "to": "B", "guard": None}]
```

注意：`parse_graph("[A] --> B", registry=None)` 走模块级默认 registry——无 guard 无 body 声明时 `_validate` 不查任何东西，可通过。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ../SpecModule && python -m pytest module_harness/tests/test_graph_query.py -q`
Expected: FAIL，`ImportError: cannot import name 'graph_to_dict'`

- [ ] **Step 3: 实现 graph_to_dict**

在 `query.py` 末尾追加（imports 区已有 `from typing import Any`；文件头部已 `TYPE_CHECKING` 无则在本块内直接局部导入类型注解所需名字——因文件有 `from __future__ import annotations`，注解按字符串处理，无需运行期导入）：

```python
def graph_to_dict(graph: Any, tasklist: Any) -> dict[str, Any]:
    """tickflow Graph + Tasklist → 前端可视化结构（唯一新数据形状）。

    nodes 的 ``type``/``inputs`` 取 tasklist 原始声明（Graph 节点 inputs 有
    field/producer 双键污染，不直接透出）；``inputs`` 即 ``{field: producer}``。
    Graph 中存在而 tasklist 无对应 task 的节点按 ``type="unknown"`` 降级
    （存档与代码漂移时不阻断渲染）。CLI/MCP/Web 共用。
    """
    tasks = tasklist.tasks
    nodes = []
    for name, n in graph.nodes.items():
        t = tasks.get(name)
        nodes.append({
            "id": name,
            "label": name,
            "type": t.type if t is not None else "unknown",
            "is_start": bool(n.is_start),
            "join": n.join,
            "inputs": dict(t.inputs) if (t is not None and t.inputs) else {},
        })
    return {
        "nodes": nodes,
        "edges": [
            {"from": e.src, "to": e.dst, "guard": e.guard} for e in graph.edges
        ],
        "starts": list(graph.starts),
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ../SpecModule && python -m pytest module_harness/tests/test_graph_query.py -q`
Expected: PASS（1 passed）

### Task 2: `query.build_run_graph` 组合函数（收编 CLI visualize）

**Files:**
- Modify: `../SpecModule/module_harness/query.py`（`graph_to_dict` 之后追加）
- Test: `../SpecModule/module_harness/tests/test_graph_query.py`（追加）

**Interfaces:**
- Consumes: `store.resolve_module(name) -> ModuleSource | None`（ModuleSource 含 `is_packed`/`path`）；`checkpoint.ModuleInputStore(module_id, base_dir=None)` 的 `load_module_inputs() -> {"spec": dict, "tasklist": dict} | None`；`entry.discover_modules(dir) -> dict[str, ModuleEntry]`（ModuleEntry 含 `build_registry`/`default_template`/`templates`/`submodules`）；`loader.ModuleLoader().load(path, lazy_client=True)` → SubModule（`_build_registry(False, llm_client=..., event_bus=...)`/`tasklist`/`modules`）；`llm.mock.MockLLMClient`；`graph_builder.TasklistTranslator(registry, module_id=, modules=, llm_client=).build(tasklist, spec)`；`spec.Tasklist.from_json` / `spec.Spec`
- Produces: `build_run_graph(module_name: str, run_id: str | None = None, *, base_dir: Path | None = None, template: str | None = None, tasklist: dict[str, Any] | Tasklist | None = None, src: Any = None) -> tuple[Any, Any] | None`——返回 `(Graph, Tasklist)`；无存档且未传 tasklist → `None`；模块未找到/加载失败/构建失败 → `ValueError`（消息可直接面向用户）。`src` 为预解析的 ModuleSource（CLI 显式 `--modules-dir` 分支直通用，保持其旧语义）。

- [ ] **Step 1: 写失败测试**

`test_graph_query.py` 追加（文件头部 import 区补 `import json`、`from module_harness.query import build_run_graph`，fixture 模块写到 `tmp_path` 下并用 `SPECMODULE_PATH` 让 store 发现）：

```python
MINI_MODULE_PY = '''\
"""graph_query 测试模块：script 流水线 + guard 分支。"""
from __future__ import annotations

from module_harness.entry import ModuleEntry
from module_harness.events import EventBus
from module_harness.registry import HarnessRegistry


def _registry_for(llm_client, template_name, event_bus):
    reg = HarnessRegistry(llm_client=llm_client, event_bus=event_bus or EventBus.null())

    @reg.script("A")
    def a(view):
        return {"value": "from A"}

    @reg.script("B")
    def b(view):
        return {"greeting": "hello"}

    @reg.script("C")
    def c(view):
        return {"note": "guarded"}

    @reg.guard("pick_c")
    def pick_c(view):
        return True

    return reg


entry = ModuleEntry(
    name="graph_mini",
    description="graph_query 测试模块",
    templates={},
    build_registry=_registry_for,
)
'''

MINI_TASKLIST_JSON = {
    "Tasks": {
        "A": {"type": "script", "script": "A"},
        "B": {"type": "script", "script": "B", "inputs": {"value": "A"}},
        "C": {"type": "script", "script": "C"},
    },
    "Flow": "[A] --> B\nA --|pick_c|--> C",
}


import pytest


@pytest.fixture()
def mini_env(tmp_path, monkeypatch):
    """测试模块目录进 SPECMODULE_PATH（store 统一搜索路径发现），base=tmp_path。"""
    mods = tmp_path / "mods"
    mods.mkdir()
    (mods / "graph_mini.py").write_text(MINI_MODULE_PY, encoding="utf-8")
    monkeypatch.setenv("SPECMODULE_PATH", str(mods))
    monkeypatch.delenv("SPECMODULE_MODULES", raising=False)
    return tmp_path


def _seed_archive(base, run_id, spec=None, tasklist=None):
    from module_harness.checkpoint import ModuleInputStore

    st = ModuleInputStore(run_id, base)
    st.save_module_inputs(spec or {}, tasklist or MINI_TASKLIST_JSON)
    st.close()


class TestBuildRunGraph:
    def test_from_archive(self, mini_env):
        _seed_archive(mini_env, "graph_mini")
        res = build_run_graph("graph_mini", "graph_mini", base_dir=mini_env)
        assert res is not None
        graph, tl = res
        assert sorted(graph.nodes) == ["A", "B", "C"]
        assert ("A", "C", "pick_c") in [(e.src, e.dst, e.guard) for e in graph.edges]
        assert tl.tasks["B"].inputs == {"value": "A"}

    def test_tasklist_dict_channel(self, mini_env):
        res = build_run_graph(
            "graph_mini", "graph_mini",
            base_dir=mini_env, tasklist=MINI_TASKLIST_JSON,
        )
        assert res is not None
        assert sorted(res[0].nodes) == ["A", "B", "C"]

    def test_no_archive_returns_none(self, mini_env):
        assert build_run_graph("graph_mini", "graph_mini", base_dir=mini_env) is None

    def test_module_not_found_raises(self, mini_env):
        with pytest.raises(ValueError, match="未找到"):
            build_run_graph("ghost", "ghost", base_dir=mini_env)

    def test_graph_to_dict_via_build(self, mini_env):
        from module_harness.query import graph_to_dict as g2d

        _seed_archive(mini_env, "graph_mini")
        graph, tl = build_run_graph("graph_mini", "graph_mini", base_dir=mini_env)
        d = g2d(graph, tl)
        types = {n["id"]: n["type"] for n in d["nodes"]}
        assert types == {"A": "script", "B": "script", "C": "script"}
        guards = [e["guard"] for e in d["edges"]]
        assert "pick_c" in guards and None in guards
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ../SpecModule && python -m pytest module_harness/tests/test_graph_query.py -q`
Expected: FAIL，`ImportError: cannot import name 'build_run_graph'`

- [ ] **Step 3: 实现 build_run_graph**

`query.py` 的 `graph_to_dict` 之后追加（全部依赖局部导入，保持 query.py 导入面不变——库内既有模式）：

```python
def build_run_graph(
    module_name: str,
    run_id: str | None = None,
    *,
    base_dir: Path | None = None,
    template: str | None = None,
    tasklist: Any = None,
    src: Any = None,
) -> tuple[Any, Any] | None:
    """从运行存档（或直接给定 tasklist）重建 tickflow Graph——可视化共用。

    原 CLI ``visualize`` 组合的共享层收编（CLI/Web 共用，零 LLM——registry 用
    MockLLMClient 占位）：模块解析 → Mock registry → module_inputs 存档 →
    TasklistTranslator.build。

    - ``tasklist``：dict（{Tasks, Flow}）或 Tasklist 对象；给出时跳过存档
      （直渲染通道）。
    - ``src``：预解析 ModuleSource（CLI 显式 --modules-dir 分支直通）；缺省
      ``store.resolve_module`` 统一搜索路径解析。
    - 返回 ``(Graph, Tasklist)``；无存档且未传 tasklist → None；模块未找到/
      加载失败/tasklist 构建失败 → ValueError（消息可直接面向用户）。
    """
    from llm.mock import MockLLMClient

    from . import store
    from .checkpoint import ModuleInputStore
    from .events import EventBus
    from .graph_builder import TasklistTranslator
    from .registry import HarnessRegistry
    from .spec import Spec, Tasklist

    if src is None:
        src = store.resolve_module(module_name)
        if src is None:
            raise ValueError(f"模块 '{module_name}' 未找到（specmodule list 查看全部）")
    run_id = run_id or module_name
    event_bus = EventBus()

    tl: Tasklist | None = None
    spec_data: dict | None = None
    if isinstance(tasklist, Tasklist):
        tl = tasklist
    elif isinstance(tasklist, dict):
        tl = Tasklist.from_json(tasklist)
    elif tasklist is None:
        istore = ModuleInputStore(run_id, base_dir)
        try:
            inputs = istore.load_module_inputs()
        finally:
            istore.close()
        if inputs is not None:
            tl = Tasklist.from_json(inputs["tasklist"])
            spec_data = inputs["spec"]
    else:
        raise TypeError(f"tasklist 类型不支持: {type(tasklist)!r}")

    if src.is_packed:
        from .loader import ModuleLoader

        sub = ModuleLoader().load(src.path, lazy_client=True)
        registry = sub._build_registry(
            False, llm_client=MockLLMClient(), event_bus=event_bus
        )
        modules = sub.modules
        if tl is None:
            tl = sub.tasklist
    else:
        from .entry import discover_modules

        entry = discover_modules(src.path.parent).get(module_name)
        if entry is None:
            raise ValueError(f"模块 '{module_name}' 入口解析失败")
        template_name = template or entry.default_template
        if entry.build_registry is not None:
            registry = entry.build_registry(
                MockLLMClient(), template_name, event_bus
            )
        else:
            registry = HarnessRegistry(
                llm_client=MockLLMClient(), event_bus=event_bus
            )
        modules = entry.submodules
    if tl is None:
        return None
    builder = TasklistTranslator(
        registry, module_id=run_id, modules=modules, llm_client=MockLLMClient()
    )
    graph, _ = builder.build(tl, Spec(spec_data) if spec_data is not None else None)
    return graph, tl
```

（存档通道把存档 spec 传给 build——`{spec.xxx}` 引用注册期解析需要；直渲染通道 spec 为 None。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ../SpecModule && python -m pytest module_harness/tests/test_graph_query.py -q`
Expected: PASS（6 passed）

### Task 3: CLI `_cmd_visualize` 重构为薄调用

**Files:**
- Modify: `../SpecModule/module_harness/cli.py:711-785`（`_cmd_visualize` 整体替换）
- Test: 既有 `module_harness/tests/test_cli.py::TestVisualize`（不改动，作为回归）

**Interfaces:**
- Consumes: Task 2 的 `build_run_graph`（签名同上）；既有 `_load_tasklist`（返回 Tasklist）、`discover_modules`、`store.ModuleSource`
- Produces: CLI 行为不变（退出码/输出文本/stderr 提示逐字保持）

- [ ] **Step 1: 替换 `_cmd_visualize` 实现**

`cli.py` 中 `_cmd_visualize` 整体替换为（原函数体 711-785 行；`_load_tasklist` 返回 Tasklist 对象，直接作为 `tasklist` 参数传入——`build_run_graph` 接受 Tasklist 实例）：

```python
def _cmd_visualize(args: argparse.Namespace) -> int:
    """渲染 tasklist 对应图（mermaid）——看"这次流水线长什么样"。

    组合逻辑在共享层 ``query.build_run_graph``（Web 可视化共用，统一 API 原则）；
    CLI 只留参数接线 + mermaid 出口。数据源与错误提示语义与旧实现逐字一致。
    """
    # 显式 --modules-dir：该目录 entry 优先（旧语义，仅此目录；未命中回落统一搜索）
    src = None
    if args.modules_dir != "modules" or (args.modules_dir == "modules"
                                         and not (Path.cwd() / "modules").is_dir()):
        entries = discover_modules(Path(args.modules_dir))
        if args.module in entries:
            src = store.ModuleSource(
                name=args.module, kind="entry",
                path=Path(args.modules_dir) / f"{args.module}.py",
            )
    tasklist = _load_tasklist(args.tasklist) if args.tasklist else None
    run_id = args.run_id or args.module
    try:
        from .query import build_run_graph

        res = build_run_graph(
            args.module, run_id, tasklist=tasklist, src=src,
        )
    except ValueError as e:
        print(f"错误: {e}", file=sys.stderr)
        _print_visualize_hint(args, src)
        return 1
    if res is None:
        print(
            f"无运行记录: {run_id}（先执行 specmodule run，或传 --tasklist 直接渲染）",
            file=sys.stderr,
        )
        return 1
    graph, _ = res
    text = graph.to_mermaid()
```

函数结尾（`--out` 写文件 / stdout 打印部分）保持原 785 行之后的内容不动。

- [ ] **Step 2: 新增 `_print_visualize_hint` 辅助**

`cli.py` 中 `_cmd_visualize` 上方新增（错误路径按需解析 entry，提示文本与旧实现逐字一致）：

```python
def _print_visualize_hint(args: argparse.Namespace, src) -> None:
    """visualize 构建失败时按需给出模板提示（旧实现的提示语义保留）。"""
    if src is not None:
        return  # 显式 --modules-dir 命中：旧实现此分支无提示
    resolved = store.resolve_module(args.module)
    if resolved is None or resolved.is_packed:
        return
    entry = discover_modules(resolved.path.parent).get(args.module)
    if entry is None or not entry.templates:
        return
    template_hint = "、".join(entry.templates)
    print(
        "提示: registry 按模板 "
        f"'{args.template or entry.default_template}' 构建，"
        "tasklist 与之不匹配时会出现未注册元件——可用模板: "
        f"{template_hint}；存档/文件的 tasklist 可能来自其他模板，"
        "试试对应 --template（如仍失败可传 --tasklist 直接渲染文件）",
        file=sys.stderr,
    )
```

- [ ] **Step 3: 跑 CLI visualize 回归**

Run: `cd ../SpecModule && python -m pytest module_harness/tests/test_cli.py -q -k "Visualize or visualize"`
Expected: PASS（TestVisualize 全部用例，含 `test_tasklist_registry_mismatch_hint` 的 `可用模板: resume_hello` 断言与 `test_no_run_no_tasklist` 的 `无运行记录` 断言）

- [ ] **Step 4: 库全量基线**

Run: `cd ../SpecModule && python -m pytest module_harness/tests/ -q -m "not smoke"`
Expected: 全部 PASS（无新增失败）

- [ ] **Step 5: 库仓库提交（功能一笔）**

```bash
cd ../SpecModule
git add module_harness/query.py module_harness/cli.py module_harness/tests/test_graph_query.py
git commit -m "feat: 共享层 build_run_graph/graph_to_dict——CLI visualize 收编 + Web 图渲染共用"
```

### Task 4: api.md 补录（库仓库 docs 一笔）

**Files:**
- Modify: `../SpecModule/docs/references/api.md`（查询层小节追加两个条目，按文件内既有条目格式）

- [ ] **Step 1: 补录两个 API 条目**

打开 `api.md`，在查询层（query.py）相关小节按既有条目格式追加，内容要点（措辞按文件风格微调）：

```markdown
### build_run_graph(module_name, run_id=None, *, base_dir=None, template=None, tasklist=None, src=None) -> tuple[Graph, Tasklist] | None

从运行存档（module_inputs 表）或直接给定的 tasklist 重建 tickflow Graph——可视化共用
（CLI visualize / Web 图渲染）。零 LLM：registry 以 MockLLMClient 占位构建。

- `tasklist`：dict（{Tasks, Flow}）或 Tasklist 对象，给出时跳过存档（直渲染通道）
- `src`：预解析 ModuleSource（CLI 显式 --modules-dir 分支直通）；缺省 store 统一搜索路径解析
- 返回 `(Graph, Tasklist)`；无存档且未传 tasklist → None；模块未找到/加载/构建失败 → ValueError
- packed/pip 模块无存档时回落模块自带 tasklist

### graph_to_dict(graph, tasklist) -> dict

tickflow Graph + Tasklist → 前端可视化结构（唯一新数据形状，Web/TUI 共用）：

`{"nodes": [{"id","label","type","is_start","join","inputs"}], "edges": [{"from","to","guard"}], "starts": [...]}`

`type`/`inputs` 取 tasklist 原始声明（Graph 节点 inputs 有 field/producer 双键污染，
不直接透出）；Graph 节点无对应 task 时 `type="unknown"` 降级。
```

- [ ] **Step 2: 库仓库提交（docs 一笔）**

```bash
cd ../SpecModule
git add docs/references/api.md
git commit -m "docs: api.md 补录 build_run_graph/graph_to_dict"
```

---

## Part 2 — webview 后端（本仓库）

### Task 5: 脚手架 + `GET /api/runs`

**Files:**
- Create: `pyproject.toml`、`server/__init__.py`、`server/app.py`、`server/deps.py`、`server/api/__init__.py`、`server/api/runs.py`
- Create: `tests/__init__.py`、`tests/conftest.py`、`tests/test_runs_api.py`、`tests/modules/mini_graph.py`
- Modify: `.gitignore`（追加 `web/node_modules/`、`web/dist/`、`.venv/`、`__pycache__/`）

**Interfaces:**
- Consumes: `query.query_run_status(module_id, base_dir)` → `ModuleStatus | None`（字段 `module_id/phase/status/tick/fireable/fired/outputs/node_states/error/updated_at`）
- Produces: `deps.get_base_dir() -> Path`（env `SPECMODULE_BASE`，缺省 `.`）、`deps.is_valid_run_id(run_id) -> bool`、`deps.validate_run_id(run_id) -> str`（非法抛 `HTTPException(400)`）；`GET /api/runs` → `{"runs": [{"run_id","phase","tick","error","updated_at"}]}`（updated_at 降序）

- [ ] **Step 1: 安装依赖（一次性）**

```bash
pip install -e ../SpecModule
pip install -e ".[dev]"
```

- [ ] **Step 2: 写 pyproject.toml**

```toml
[project]
name = "specmodule-webview"
version = "0.1.0"
description = "SpecModule 可视化消费通道：FastAPI 薄层 + React SPA"
requires-python = ">=3.10"
dependencies = ["specmodule", "fastapi>=0.110", "uvicorn>=0.29"]

[project.optional-dependencies]
dev = ["httpx>=0.27", "pytest>=8"]

[build-system]
requires = ["setuptools>=61"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
include = ["server*"]
```

- [ ] **Step 3: 写 server/deps.py**

```python
# server/deps.py
"""共享依赖：base_dir 解析（env SPECMODULE_BASE，缺省 cwd）+ run_id 校验。

base_dir 每次请求现读 env（测试可 monkeypatch）；run_id 作为路径段使用，
必须拒绝穿越与分隔符（Module 缺省 mod_<hex> / SubModule <name>_<hex> /
CLI 自定义均落在白名单字符内）。
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from fastapi import HTTPException

_RUN_ID_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]*$")


def get_base_dir() -> Path:
    """运行根目录：env SPECMODULE_BASE，缺省 cwd（服务器进程 cwd ≠ 运行根）。"""
    return Path(os.environ.get("SPECMODULE_BASE") or ".").resolve()


def is_valid_run_id(run_id: str) -> bool:
    return bool(_RUN_ID_RE.fullmatch(run_id)) and ".." not in run_id


def validate_run_id(run_id: str) -> str:
    if not is_valid_run_id(run_id):
        raise HTTPException(status_code=400, detail={"error": f"非法 run_id: {run_id!r}"})
    return run_id
```

- [ ] **Step 4: 写 server/api/runs.py（本任务只实现 list_runs，其余端点 Task 6 补）**

```python
# server/api/runs.py
"""运行时读端点：薄映射 module_harness 查询层（只 import 不实现）。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from module_harness import query
from server.deps import get_base_dir, validate_run_id

router = APIRouter(prefix="/api/runs")


def not_found(run_id: str) -> HTTPException:
    return HTTPException(status_code=404, detail={"error": "无运行记录", "run_id": run_id})


@router.get("")
def list_runs(base_dir: Path = Depends(get_base_dir)) -> dict:
    """运行列表：扫描 runs/ 目录 + query_run_status 摘要（updated_at 降序）。"""
    runs_root = base_dir / ".specmodule" / "runs"
    out: list[dict[str, Any]] = []
    if runs_root.is_dir():
        for d in runs_root.iterdir():
            if not d.is_dir():
                continue
            st = query.query_run_status(d.name, base_dir=base_dir)
            if st is None:
                continue
            out.append({
                "run_id": st.module_id,
                "phase": st.phase,
                "tick": st.tick,
                "error": st.error,
                "updated_at": st.updated_at,
            })
    out.sort(key=lambda r: r["updated_at"], reverse=True)
    return {"runs": out}
```

- [ ] **Step 5: 写 server/app.py**

```python
# server/app.py
"""FastAPI 入口：CORS（dev SPA 端口）+ 路由挂载 + 错误体展平。"""

from __future__ import annotations

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from server.api import graph, manage, runs
from server.ws import router as ws_router

app = FastAPI(title="SpecModule Webview", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(HTTPException)
def flatten_http_exception(request: Request, exc: HTTPException) -> JSONResponse:
    """HTTPException(detail=dict) 直接作为响应体（错误契约 {error, ...} 顶层字段）。"""
    return JSONResponse(status_code=exc.status_code, content=exc.detail)


app.include_router(runs.router)
app.include_router(manage.router)
app.include_router(graph.router)
app.include_router(ws_router)
```

注意：本步先注释掉 `graph`/`manage`/`ws_router` 三行 import 与挂载（对应模块 Task 7-9 才创建），每个任务落地时解除一行。

- [ ] **Step 6: 写测试模块 fixture `tests/modules/mini_graph.py`**

```python
"""webview 测试模块：[A] --> B、A --|pick_c|--> C（script 流水线 + guard 分支）。

B/C 带 1.5s sleep 仅为端到端走查时能观察到"运行中"状态；单元测试只造存档
不执行 body，不受影响。
"""

from __future__ import annotations

import time

from module_harness.entry import ModuleEntry
from module_harness.events import EventBus
from module_harness.registry import HarnessRegistry


def _registry_for(llm_client, template_name, event_bus):
    reg = HarnessRegistry(llm_client=llm_client, event_bus=event_bus or EventBus.null())

    @reg.script("A")
    def a(view):
        return {"value": "from A"}

    @reg.script("B")
    def b(view):
        time.sleep(1.5)
        return {"greeting": "hello " + view.A.value["value"]}

    @reg.script("C")
    def c(view):
        time.sleep(1.5)
        return {"note": "guarded branch"}

    @reg.guard("pick_c")
    def pick_c(view):
        return True

    return reg


entry = ModuleEntry(
    name="mini_graph",
    description="webview 测试模块（script 流水线 + guard 分支）",
    templates={},
    build_registry=_registry_for,
    default_spec={"topic": "demo"},
)
```

- [ ] **Step 7: 写 tests/conftest.py**

```python
# tests/conftest.py
"""fixture run 构造（隔离模式：只写 tmp_path，绝不触碰真实 ~/.specmodule）。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

HERE = Path(__file__).parent
TEST_MODULES = HERE / "modules"

MINI_TASKLIST: dict[str, Any] = {
    "Tasks": {
        "A": {"type": "script", "script": "A"},
        "B": {"type": "script", "script": "B", "inputs": {"value": "A"}},
        "C": {"type": "script", "script": "C"},
    },
    "Flow": "[A] --> B\nA --|pick_c|--> C",
}


def seed_run(
    base: Path,
    run_id: str,
    *,
    firings: list[dict] | None = None,
    snapshots: dict[int, dict] | None = None,
    status: dict | None = None,
    inputs: dict | None = None,
) -> Path:
    """造最小 fixture run：run.sqlite（firings/snapshots/module_inputs）+ status.json。"""
    from module_harness.checkpoint import ModuleInputStore
    from tickflow.persistence import SqliteBackend
    from tickflow.state import NodeState

    run_dir = base / ".specmodule" / "runs" / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    backend = SqliteBackend(run_dir / "run.sqlite")
    for f in firings or []:
        backend.save_firing(run_id, NodeState(**f))
    for tick, snap in (snapshots or {}).items():
        backend.save_snapshot(run_id, tick, snap)
    backend.close()
    if inputs is not None:
        st = ModuleInputStore(run_id, base)
        st.save_module_inputs(inputs["spec"], inputs["tasklist"])
        st.close()
    if status is not None:
        (run_dir / "status.json").write_text(
            json.dumps(status, ensure_ascii=False), encoding="utf-8"
        )
    return run_dir


@pytest.fixture()
def base(tmp_path, monkeypatch):
    monkeypatch.setenv("SPECMODULE_BASE", str(tmp_path))
    monkeypatch.setenv("SPECMODULE_PATH", str(TEST_MODULES))
    return tmp_path


@pytest.fixture()
def client(base):
    from server.app import app

    return TestClient(app)
```

- [ ] **Step 8: 写失败测试 `tests/test_runs_api.py`（列表部分）**

```python
# tests/test_runs_api.py
"""GET /api/runs 与运行读端点：形状 + 错误契约（None → 404）。"""

from __future__ import annotations

from tests.conftest import seed_run


class TestRunsList:
    def test_empty(self, client):
        r = client.get("/api/runs")
        assert r.status_code == 200
        assert r.json() == {"runs": []}

    def test_sorted_by_updated_at_desc(self, base, client):
        seed_run(base, "r_old", status={"module_id": "r_old", "phase": "done", "updated_at": 1.0})
        seed_run(base, "r_new", status={"module_id": "r_new", "phase": "running", "updated_at": 2.0})
        r = client.get("/api/runs")
        assert r.status_code == 200
        runs = r.json()["runs"]
        assert [x["run_id"] for x in runs] == ["r_new", "r_old"]
        assert runs[0]["phase"] == "running"
        assert runs[0]["tick"] is None      # 无 run.sqlite → tick None

    def test_skips_dirs_without_status(self, base, client):
        (base / ".specmodule" / "runs" / "junk").mkdir(parents=True)
        r = client.get("/api/runs")
        assert r.json() == {"runs": []}
```

- [ ] **Step 9: 跑测试**

Run: `python -m pytest tests/ -q`
Expected: PASS（3 passed；`server/api/manage.py` 等尚不存在——app.py 中相关行已注释）

- [ ] **Step 10: 提交**

```bash
git add pyproject.toml server/ tests/ .gitignore
git commit -m "feat: 脚手架 + GET /api/runs（deps：base_dir/run_id 校验，错误体展平）"
```

### Task 6: 运行读端点全家（status/timeline/checkpoints/snapshot/feed + POST checkpoints）

**Files:**
- Modify: `server/api/runs.py`（`list_runs` 之后追加）
- Test: `tests/test_runs_api.py`（追加）

**Interfaces:**
- Consumes: `query_run_status` / `build_timeline`+`filter_failed`+`filter_tick`+`filter_node`+`timeline_to_dict` / `build_checkpoints`+`checkpoints_to_dict` / `load_snapshot_summary` / `create_checkpoint`（全部 `base_dir` 显式传）
- Produces: `GET /api/runs/{id}/status|timeline|checkpoints|snapshot|feed`、`POST /api/runs/{id}/checkpoints`；错误契约见 Global Constraints

- [ ] **Step 1: 追加失败测试**

```python
class TestRunStatus:
    def test_ok(self, base, client):
        seed_run(
            base, "mod_a",
            firings=[{"tick": 1, "node": "A", "output": "a1"}],
            snapshots={1: {"tick": 1, "status": "idle", "fireable": [], "fired": ["A"]}},
            status={"module_id": "mod_a", "phase": "done", "updated_at": 3.0},
        )
        r = client.get("/api/runs/mod_a/status")
        assert r.status_code == 200
        d = r.json()
        assert d["module_id"] == "mod_a"
        assert d["phase"] == "done"
        assert d["tick"] == 1
        assert d["fired"] == ["A"]
        assert d["outputs"] == {"A": "a1"}

    def test_phase_only_run(self, base, client):
        seed_run(base, "mod_b", status={"module_id": "mod_b", "phase": "aborted",
                                        "error": "boom", "updated_at": 1.0})
        r = client.get("/api/runs/mod_b/status")
        assert r.status_code == 200
        assert r.json()["phase"] == "aborted"
        assert r.json()["error"] == "boom"

    def test_missing_404(self, client):
        r = client.get("/api/runs/ghost/status")
        assert r.status_code == 404
        assert r.json()["error"] == "无运行记录"
        assert r.json()["run_id"] == "ghost"

    def test_bad_run_id_400(self, client):
        r = client.get("/api/runs/../etc/status")
        assert r.status_code in (400, 404)   # 路径归一化后仍须拒绝


class TestTimeline:
    def _seed(self, base):
        seed_run(
            base, "mod_t",
            firings=[
                {"tick": 1, "node": "A", "output": "a1"},
                {"tick": 1, "node": "B", "output": "b1", "status": "failed", "error": "boom"},
                {"tick": 2, "node": "A", "output": "a2"},
            ],
            status={"module_id": "mod_t", "phase": "done", "updated_at": 1.0},
        )

    def test_all(self, base, client):
        self._seed(base)
        r = client.get("/api/runs/mod_t/timeline")
        assert r.status_code == 200
        d = r.json()
        assert d["latest_tick"] == 2
        assert len(d["entries"]) == 3

    def test_filter_node(self, base, client):
        self._seed(base)
        r = client.get("/api/runs/mod_t/timeline", params={"node": "A"})
        assert [e["tick"] for e in r.json()["entries"]] == [1, 2]

    def test_filter_failed(self, base, client):
        self._seed(base)
        r = client.get("/api/runs/mod_t/timeline", params={"failed": "true"})
        assert [e["node"] for e in r.json()["entries"]] == ["B"]

    def test_missing_404(self, client):
        assert client.get("/api/runs/ghost/timeline").status_code == 404


class TestCheckpoints:
    def test_list_and_create(self, base, client):
        seed_run(
            base, "mod_c",
            snapshots={1: {"tick": 1, "status": "idle", "fireable": [], "fired": ["A"]}},
            status={"module_id": "mod_c", "phase": "done", "updated_at": 1.0},
        )
        r = client.get("/api/runs/mod_c/checkpoints")
        assert r.status_code == 200
        assert r.json()["checkpoints"][0]["target"] == "1"

        r = client.post("/api/runs/mod_c/checkpoints", json={"label": "milestone"})
        assert r.status_code == 200
        assert r.json() == {"label": "manual:milestone", "tick": 1, "overwritten": False}

    def test_create_missing_400(self, base, client):
        seed_run(base, "mod_d", status={"module_id": "mod_d", "phase": "done", "updated_at": 1.0})
        r = client.post("/api/runs/mod_d/checkpoints", json={"label": "x"})
        assert r.status_code == 400
        assert "快照" in r.json()["error"] or "运行" in r.json()["error"]

    def test_missing_404(self, client):
        assert client.get("/api/runs/ghost/checkpoints").status_code == 404


class TestSnapshot:
    def test_latest(self, base, client):
        seed_run(
            base, "mod_s",
            firings=[{"tick": 1, "node": "A", "output": "a1"},
                     {"tick": 2, "node": "A", "output": "a2"}],
            snapshots={1: {"tick": 1, "status": "running", "fireable": ["A"], "fired": []},
                       2: {"tick": 2, "status": "idle", "fireable": [], "fired": ["A"]}},
            status={"module_id": "mod_s", "phase": "done", "updated_at": 1.0},
        )
        r = client.get("/api/runs/mod_s/snapshot")
        assert r.status_code == 200
        assert r.json()["tick"] == 2
        assert r.json()["outputs"] == {"A": "a2"}

    def test_bad_tick_400(self, base, client):
        seed_run(
            base, "mod_s2",
            snapshots={1: {"tick": 1, "status": "idle", "fireable": [], "fired": []}},
            status={"module_id": "mod_s2", "phase": "done", "updated_at": 1.0},
        )
        r = client.get("/api/runs/mod_s2/snapshot", params={"tick": 9})
        assert r.status_code == 400

    def test_missing_404(self, client):
        assert client.get("/api/runs/ghost/snapshot").status_code == 404


class TestFeed:
    def test_compat_shape(self, base, client):
        seed_run(
            base, "mod_f",
            firings=[{"tick": 1, "node": "A", "output": "a1"}],
            snapshots={1: {"tick": 1, "status": "idle", "fireable": [], "fired": ["A"]}},
            status={"module_id": "mod_f", "phase": "done", "updated_at": 1.0},
        )
        r = client.get("/api/runs/mod_f/feed")
        assert r.status_code == 200
        d = r.json()
        # feed.py 兼容：字段名 status/timeline/checkpoints；status 为 None 或精简 dict
        assert set(d) == {"run_id", "status", "timeline", "checkpoints"}
        assert d["status"]["phase"] == "done"
        assert d["timeline"]["entries"][0]["node"] == "A"
        assert d["checkpoints"]["checkpoints"][0]["target"] == "1"

    def test_missing_404(self, client):
        r = client.get("/api/runs/ghost/feed")
        assert r.status_code == 404
        assert r.json()["error"] == "无运行记录"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python -m pytest tests/test_runs_api.py -q`
Expected: 新增用例 FAIL（404，路由不存在）

- [ ] **Step 3: 实现端点**

`server/api/runs.py` 的 `list_runs` 之后追加（import 区补 `from pydantic import BaseModel`）：

```python
class CheckpointBody(BaseModel):
    label: str
    tick: int | None = None


@router.get("/{run_id}/status")
def run_status(run_id: str, base_dir: Path = Depends(get_base_dir)) -> dict:
    validate_run_id(run_id)
    st = query.query_run_status(run_id, base_dir=base_dir)
    if st is None:
        raise not_found(run_id)
    return {
        "module_id": st.module_id,
        "phase": st.phase,
        "status": st.status,
        "tick": st.tick,
        "fireable": st.fireable,
        "fired": st.fired,
        "outputs": st.outputs,
        "node_states": st.node_states,
        "error": st.error,
        "updated_at": st.updated_at,
    }


@router.get("/{run_id}/timeline")
def run_timeline(
    run_id: str,
    node: str | None = None,
    tick: int | None = None,
    failed: bool = False,
    base_dir: Path = Depends(get_base_dir),
) -> dict:
    validate_run_id(run_id)
    tl = query.build_timeline(run_id, base_dir=base_dir)
    if tl is None:
        raise not_found(run_id)
    if failed:
        tl = query.filter_failed(tl)
    if tick is not None:
        tl = query.filter_tick(tl, tick)
    if node is not None:
        tl = query.filter_node(tl, node)
    return query.timeline_to_dict(tl)


@router.get("/{run_id}/checkpoints")
def run_checkpoints(run_id: str, base_dir: Path = Depends(get_base_dir)) -> dict:
    validate_run_id(run_id)
    cl = query.build_checkpoints(run_id, base_dir=base_dir)
    if cl is None:
        raise not_found(run_id)
    return query.checkpoints_to_dict(cl)


@router.post("/{run_id}/checkpoints")
def create_checkpoint(
    run_id: str, body: CheckpointBody, base_dir: Path = Depends(get_base_dir)
) -> dict:
    validate_run_id(run_id)
    try:
        return query.create_checkpoint(
            run_id, body.label, tick=body.tick, base_dir=base_dir
        )
    except KeyError as e:
        raise HTTPException(status_code=400, detail={"error": e.args[0], "run_id": run_id})


@router.get("/{run_id}/snapshot")
def run_snapshot(
    run_id: str, tick: int | None = None, base_dir: Path = Depends(get_base_dir)
) -> dict:
    validate_run_id(run_id)
    try:
        snap = query.load_snapshot_summary(run_id, tick=tick, base_dir=base_dir)
    except KeyError as e:
        raise HTTPException(status_code=400, detail={"error": e.args[0], "run_id": run_id})
    if snap is None:
        raise not_found(run_id)
    return snap


@router.get("/{run_id}/feed")
def run_feed(run_id: str, base_dir: Path = Depends(get_base_dir)) -> dict:
    """feed.py 兼容组合端点（v1 前端契约：status/timeline/checkpoints 字段名不变）。"""
    validate_run_id(run_id)
    st = query.query_run_status(run_id, base_dir=base_dir)
    tl = query.build_timeline(run_id, base_dir=base_dir)
    cl = query.build_checkpoints(run_id, base_dir=base_dir)
    if st is None and tl is None:
        raise not_found(run_id)
    return {
        "run_id": run_id,
        "status": st and {
            "phase": st.phase,
            "tick": st.tick,
            "fired": st.fired,
            "outputs": st.outputs,
            "error": st.error,
        },
        "timeline": query.timeline_to_dict(tl) if tl else None,
        "checkpoints": query.checkpoints_to_dict(cl) if cl else None,
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python -m pytest tests/ -q`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add server/api/runs.py tests/test_runs_api.py
git commit -m "feat: 运行读端点全家（status/timeline/checkpoints/snapshot/feed + POST checkpoints）"
```

### Task 7: `GET /api/modules`（manage）

**Files:**
- Create: `server/api/manage.py`
- Modify: `server/app.py`（解除 manage 挂载注释）
- Test: `tests/test_manage_api.py`

**Interfaces:**
- Consumes: `store.list_modules(search=None, include_pip=True) -> dict[str, list[ModuleSource]]`
- Produces: `GET /api/modules` → `{"modules": [{"name","kind","version","description","path"}]}`（按 name 排序）

- [ ] **Step 1: 写失败测试**

```python
# tests/test_manage_api.py
"""GET /api/modules：store.list_modules 薄映射。"""

from __future__ import annotations


class TestModules:
    def test_lists_fixture_module(self, client):
        r = client.get("/api/modules")
        assert r.status_code == 200
        mods = r.json()["modules"]
        names = [m["name"] for m in mods]
        assert "mini_graph" in names
        mini = next(m for m in mods if m["name"] == "mini_graph")
        assert mini["kind"] == "entry"
        assert mini["path"].endswith("mini_graph.py")

    def test_sorted_and_shaped(self, client):
        r = client.get("/api/modules")
        mods = r.json()["modules"]
        assert mods == sorted(mods, key=lambda m: m["name"])
        for m in mods:
            assert set(m) == {"name", "kind", "version", "description", "path"}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python -m pytest tests/test_manage_api.py -q`
Expected: FAIL（404）

- [ ] **Step 3: 实现**

```python
# server/api/manage.py
"""管理面端点：模块枚举（store.list_modules 薄映射）。"""

from __future__ import annotations

from fastapi import APIRouter

from module_harness import store

router = APIRouter(prefix="/api")


@router.get("/modules")
def list_modules() -> dict:
    out = []
    for _name, sources in store.list_modules().items():
        for s in sources:
            out.append({
                "name": s.name,
                "kind": s.kind,
                "version": s.version,
                "description": s.description,
                "path": str(s.path),
            })
    out.sort(key=lambda m: (m["name"], m["kind"]))
    return {"modules": out}
```

`server/app.py` 解除 `manage` 的 import 与挂载注释。

- [ ] **Step 4: 跑测试确认通过 + 提交**

Run: `python -m pytest tests/ -q`
Expected: PASS

```bash
git add server/api/manage.py server/app.py tests/test_manage_api.py
git commit -m "feat: GET /api/modules（store.list_modules 薄映射）"
```

### Task 8: `GET /api/runs/{id}/graph`（图 + 节点状态叠加）

**Files:**
- Create: `server/api/graph.py`
- Modify: `server/app.py`（解除 graph 挂载注释）
- Test: `tests/test_graph_api.py`

**Interfaces:**
- Consumes: Task 2 `query.build_run_graph`（返回 `(Graph, Tasklist) | None`）、Task 1 `query.graph_to_dict`、`query_run_status`、`build_timeline`
- Produces: `GET /api/runs/{id}/graph?module=` → `{"run_id","module","phase","tick","graph":{nodes,edges,starts},"node_states": {"<node>": {"fired_count","last_status","last_tick","running"}}}`；无存档 → 404 `{"error":"无运行记录",...}`；模块解析失败 → 404 `{"error": "<ValueError 消息>", ...}`（前端据此弹模块选择器）

- [ ] **Step 1: 写失败测试**

```python
# tests/test_graph_api.py
"""GET /api/runs/{id}/graph：归档重建 + 节点状态叠加。"""

from __future__ import annotations

from tests.conftest import MINI_TASKLIST, seed_run


def _seed_graph_run(base, **kw):
    """run_id=mini_graph（启发式 module=run_id 命中 tests/modules 的 entry 模块）。"""
    firings = kw.pop("firings", [
        {"tick": 1, "node": "A", "output": "a1"},
        {"tick": 1, "node": "B", "output": "b1"},
    ])
    status = kw.pop("status", {"module_id": "mini_graph", "phase": "done", "updated_at": 2.0})
    return seed_run(
        base, "mini_graph",
        firings=firings, status=status,
        inputs={"spec": {"topic": "demo"}, "tasklist": MINI_TASKLIST},
        **kw,
    )


class TestGraph:
    def test_shape_with_overlay(self, base, client):
        _seed_graph_run(base)
        r = client.get("/api/runs/mini_graph/graph")
        assert r.status_code == 200
        d = r.json()
        assert d["run_id"] == "mini_graph"
        assert d["module"] == "mini_graph"
        assert d["phase"] == "done"
        g = d["graph"]
        assert sorted(n["id"] for n in g["nodes"]) == ["A", "B", "C"]
        assert all(n["type"] == "script" for n in g["nodes"])
        guards = [e["guard"] for e in g["edges"]]
        assert "pick_c" in guards
        assert g["starts"] == ["A"]
        ns = d["node_states"]
        assert ns["A"] == {"fired_count": 1, "last_status": "ok", "last_tick": 1, "running": False}
        assert ns["C"]["fired_count"] == 0 and ns["C"]["last_status"] is None

    def test_running_badge_from_fireable(self, base, client):
        _seed_graph_run(
            base,
            firings=[{"tick": 1, "node": "A", "output": "a1"}],
            status={"module_id": "mini_graph", "phase": "running", "updated_at": 2.0},
        )
        r = client.get("/api/runs/mini_graph/graph")
        # phase=running 且 B/C 无 firing → running 标记（fireable 需快照，无 DB 快照时
        # fireable 为空——本用例只断言契约字段存在与 False 回退）
        assert r.status_code == 200
        assert all(isinstance(v["running"], bool) for v in r.json()["node_states"].values())

    def test_module_param_override(self, base, client):
        # run_id ≠ 模块名：?module= 显式指定
        seed_run(
            base, "custom_run",
            status={"module_id": "custom_run", "phase": "done", "updated_at": 1.0},
            inputs={"spec": {}, "tasklist": MINI_TASKLIST},
        )
        r = client.get("/api/runs/custom_run/graph", params={"module": "mini_graph"})
        assert r.status_code == 200
        assert r.json()["module"] == "mini_graph"

    def test_no_archive_404(self, base, client):
        seed_run(base, "mini_graph", status={"module_id": "mini_graph", "phase": "done", "updated_at": 1.0})
        r = client.get("/api/runs/mini_graph/graph")
        assert r.status_code == 404
        assert r.json()["error"] == "无运行记录"

    def test_module_unresolvable_404_with_message(self, base, client):
        seed_run(
            base, "orphan_run",
            status={"module_id": "orphan_run", "phase": "done", "updated_at": 1.0},
            inputs={"spec": {}, "tasklist": MINI_TASKLIST},
        )
        r = client.get("/api/runs/orphan_run/graph")   # module=orphan_run 不存在
        assert r.status_code == 404
        assert "未找到" in r.json()["error"]

    def test_invalid_run_id_400(self, client):
        r = client.get("/api/runs/bad..id/graph")
        assert r.status_code == 400
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python -m pytest tests/test_graph_api.py -q`
Expected: FAIL（404）

- [ ] **Step 3: 实现**

```python
# server/api/graph.py
"""图端点：module_inputs 归档重建（库共享层）+ 每节点运行摘要叠加。"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException

from module_harness import query
from server.deps import get_base_dir, validate_run_id

router = APIRouter(prefix="/api/runs")


@router.get("/{run_id}/graph")
def run_graph(
    run_id: str,
    module: str | None = None,
    base_dir: Path = Depends(get_base_dir),
) -> dict:
    """图结构 + 节点状态叠加。

    module 缺省 = run_id（CLI 缺省 run_id 即模块名的启发式）；解析失败 404 携
    ValueError 消息（前端弹模块选择器）。「运行中」= phase=running 且节点在最新
    快照 fireable 集合（快照 tick N 的 fireable = 第 N+1 个 tick 的 fire 候选）。
    """
    validate_run_id(run_id)
    module_name = module or run_id
    try:
        res = query.build_run_graph(module_name, run_id, base_dir=base_dir)
    except ValueError as e:
        raise HTTPException(
            status_code=404,
            detail={"error": e.args[0], "run_id": run_id, "module": module_name},
        )
    if res is None:
        raise HTTPException(
            status_code=404,
            detail={"error": "无运行记录", "run_id": run_id, "module": module_name},
        )
    graph, tasklist = res
    graph_dict = query.graph_to_dict(graph, tasklist)

    st = query.query_run_status(run_id, base_dir=base_dir)
    tl = query.build_timeline(run_id, base_dir=base_dir)
    by_node: dict[str, list] = {}
    for e in tl.entries if tl else []:
        by_node.setdefault(e.node, []).append(e)
    node_states = {}
    for n in graph_dict["nodes"]:
        entries = by_node.get(n["id"], [])
        last = entries[-1] if entries else None
        node_states[n["id"]] = {
            "fired_count": len(entries),
            "last_status": last.status if last else None,
            "last_tick": last.tick if last else None,
            "running": bool(
                st is not None
                and st.phase == "running"
                and n["id"] in st.fireable
            ),
        }
    return {
        "run_id": run_id,
        "module": module_name,
        "phase": st.phase if st else None,
        "tick": st.tick if st else None,
        "graph": graph_dict,
        "node_states": node_states,
    }
```

`server/app.py` 解除 `graph` 的 import 与挂载。

- [ ] **Step 4: 跑测试确认通过 + 提交**

Run: `python -m pytest tests/ -q`
Expected: PASS

```bash
git add server/api/graph.py server/app.py tests/test_graph_api.py
git commit -m "feat: GET /api/runs/{id}/graph（归档重建 + 节点状态叠加）"
```

### Task 9: `WS /api/runs/{id}/stream`

**Files:**
- Create: `server/ws.py`
- Modify: `server/app.py`（解除 ws 挂载注释）
- Test: `tests/test_ws.py`

**Interfaces:**
- Consumes: `query_run_status`（轮询源 = status.json + run.sqlite，与 feed 同源）
- Produces: WS 消息 `{"type":"status","phase","status","tick","fireable","fired","outputs","error","updated_at"}`（首连即推当前状态；变化才推，~1s 轮询）；run 不存在 → `{"type":"error","error":"无运行记录"}` + close 4404；终态（done/aborted/cancelled）推完 close 1000

- [ ] **Step 1: 写失败测试**

```python
# tests/test_ws.py
"""WS /api/runs/{id}/stream：首推、变化推送、终态关闭、未知 run 拒连。"""

from __future__ import annotations

import pytest
from starlette.websockets import WebSocketDisconnect

from tests.conftest import seed_run


class TestStream:
    def test_initial_push_on_connect(self, base, client):
        seed_run(base, "ws_run", status={"module_id": "ws_run", "phase": "running", "updated_at": 1.0})
        with client.websocket_connect("/api/runs/ws_run/stream") as ws:
            msg = ws.receive_json()
            assert msg["type"] == "status"
            assert msg["phase"] == "running"
            assert msg["outputs"] == {}

    def test_terminal_close(self, base, client):
        seed_run(base, "ws_done", status={"module_id": "ws_done", "phase": "done", "updated_at": 1.0})
        with client.websocket_connect("/api/runs/ws_done/stream") as ws:
            msg = ws.receive_json()
            assert msg["phase"] == "done"
            with pytest.raises(WebSocketDisconnect):
                ws.receive_json()   # 服务端 close(1000)

    def test_unknown_run_error_close(self, base, client):
        with client.websocket_connect("/api/runs/ghost/stream") as ws:
            msg = ws.receive_json()
            assert msg["type"] == "error"
            assert msg["error"] == "无运行记录"
            with pytest.raises(WebSocketDisconnect):
                ws.receive_json()

    def test_invalid_run_id(self, base, client):
        with client.websocket_connect("/api/runs/bad..id/stream") as ws:
            msg = ws.receive_json()
            assert msg["type"] == "error"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python -m pytest tests/test_ws.py -q`
Expected: FAIL（无路由）

- [ ] **Step 3: 实现**

```python
# server/ws.py
"""tick 流实时推送：后端轮询 status.json/run.sqlite（feed 同源，不改库）。"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from module_harness import query
from server.deps import get_base_dir, is_valid_run_id

router = APIRouter()

_TERMINAL = ("done", "aborted", "cancelled")
_POLL_SECONDS = 1.0


@router.websocket("/api/runs/{run_id}/stream")
async def run_stream(websocket: WebSocket, run_id: str) -> None:
    """变化才推：sig=(phase, tick, updated_at) 比对；终态推完 close(1000)。

    查询为同步短读（SQLite WAL 跨进程读，毫秒级），v1 直接在事件循环内调用。
    """
    await websocket.accept()
    if not is_valid_run_id(run_id):
        await websocket.send_json({"type": "error", "error": f"非法 run_id: {run_id!r}"})
        await websocket.close(code=4400)
        return
    base_dir = get_base_dir()
    last_sig: tuple | None = None
    try:
        while True:
            st = query.query_run_status(run_id, base_dir=base_dir)
            if st is None:
                if last_sig is None:
                    await websocket.send_json(
                        {"type": "error", "error": "无运行记录", "run_id": run_id}
                    )
                    await websocket.close(code=4404)
                    return
            else:
                sig = (st.phase, st.tick, st.updated_at)
                if sig != last_sig:
                    last_sig = sig
                    await websocket.send_json({
                        "type": "status",
                        "phase": st.phase,
                        "status": st.status,
                        "tick": st.tick,
                        "fireable": st.fireable,
                        "fired": st.fired,
                        "outputs": st.outputs,
                        "error": st.error,
                        "updated_at": st.updated_at,
                    })
                    if st.phase in _TERMINAL:
                        await websocket.close(code=1000)
                        return
            await asyncio.sleep(_POLL_SECONDS)
    except WebSocketDisconnect:
        return
```

`server/app.py` 解除 `ws_router` 的 import 与挂载。

- [ ] **Step 4: 跑全量测试 + 提交**

Run: `python -m pytest tests/ -q`
Expected: PASS

```bash
git add server/ws.py server/app.py tests/test_ws.py
git commit -m "feat: WS /api/runs/{id}/stream（~1s 轮询变化推送，终态关闭）"
```

---

## Part 3 — 前端（web/）

> 前端无测试框架（生态约定）。每个任务 = 写代码 → `npm run build`（tsc 类型检查 + 构建）通过 → 提交。Node ≥18。

### Task 10: Vite 脚手架 + api/ws/dagre 基础层

**Files:**
- Create: `web/package.json`、`web/vite.config.ts`、`web/tsconfig.json`、`web/index.html`、`web/src/main.tsx`、`web/src/index.css`、`web/src/api.ts`、`web/src/ws.ts`、`web/src/dagre.ts`

**Interfaces:**
- Consumes: Part 2 全部端点（路径与形状见各任务 Produces）
- Produces: `api.ts` 类型（`RunSummary/GraphNode/GraphEdge/NodeState/GraphPayload/StatusCore/StatusMsg/StatusResp/TimelineEntry`）+ 取数函数（`fetchRuns/fetchStatus/fetchGraph/fetchNodeTimeline`）；`ws.ts` 的 `useRunStream(runId) -> StatusMsg | null`（终态停重连、断线 1s 退避重连）；`dagre.ts` 的 `layoutGraph(nodes, edges) -> Map<id, {x,y}>`

- [ ] **Step 1: 写 web/package.json**

```json
{
  "name": "specmodule-webview",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@dagrejs/dagre": "^1.1.4",
    "@xyflow/react": "^12.3.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.10",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.2",
    "typescript": "~5.6.2",
    "vite": "^5.4.8"
  }
}
```

- [ ] **Step 2: 写 web/vite.config.ts**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:8000", changeOrigin: true, ws: true },
    },
  },
});
```

- [ ] **Step 3: 写 web/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "isolatedModules": true,
    "esModuleInterop": true
  },
  "include": ["src"]
}
```

- [ ] **Step 4: 写 web/index.html**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>SpecModule Webview</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: 写 web/src/index.css 与 main.tsx**

```css
/* web/src/index.css */
* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body { font-family: system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; color: #111827; }
```

```tsx
// web/src/main.tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

- [ ] **Step 6: 写 web/src/api.ts**

```ts
// web/src/api.ts
// 后端形状与 Part 2 各端点 Produces 一一对应。

export interface RunSummary {
  run_id: string;
  phase: string;
  tick: number | null;
  error: string | null;
  updated_at: number;
}

export interface GraphNode {
  id: string;
  label: string;
  type: "harness" | "script" | "command" | "submodule" | "unknown";
  is_start: boolean;
  join: "AND" | "OR";
  inputs: Record<string, string>;
}

export interface GraphEdge {
  from: string;
  to: string;
  guard: string | null;
}

export interface NodeState {
  fired_count: number;
  last_status: "ok" | "failed" | "aborted" | null;
  last_tick: number | null;
  running: boolean;
}

export interface GraphPayload {
  run_id: string;
  module: string;
  phase: string | null;
  tick: number | null;
  graph: { nodes: GraphNode[]; edges: GraphEdge[]; starts: string[] };
  node_states: Record<string, NodeState>;
}

export interface StatusCore {
  phase: string;
  status: string | null;
  tick: number | null;
  fireable: string[];
  fired: string[];
  outputs: Record<string, unknown>;
  error: string | null;
  updated_at: number;
}

export interface StatusMsg extends StatusCore {
  type: "status";
}

export interface StatusResp extends StatusCore {
  module_id: string;
  node_states: Record<string, Record<string, unknown>>;
}

export interface TimelineEntry {
  tick: number;
  node: string;
  status: string;
  output: unknown;
  error: string | null;
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`);
  }
  return body as T;
}

export const fetchRuns = () =>
  getJson<{ runs: RunSummary[] }>("/api/runs").then((d) => d.runs);

export const fetchStatus = (runId: string) =>
  getJson<StatusResp>(`/api/runs/${encodeURIComponent(runId)}/status`);

export const fetchGraph = (runId: string, module?: string) =>
  getJson<GraphPayload>(
    `/api/runs/${encodeURIComponent(runId)}/graph${
      module ? `?module=${encodeURIComponent(module)}` : ""
    }`,
  );

export interface ModuleInfo {
  name: string;
  kind: string;
  version: string;
  description: string;
  path: string;
}

export const fetchModules = () =>
  getJson<{ modules: ModuleInfo[] }>("/api/modules").then((d) => d.modules);

export const fetchNodeTimeline = (runId: string, node: string) =>
  getJson<{ entries: TimelineEntry[] }>(
    `/api/runs/${encodeURIComponent(runId)}/timeline?node=${encodeURIComponent(node)}`,
  );
```

- [ ] **Step 7: 写 web/src/ws.ts**

```ts
// web/src/ws.ts
// WS 客户端：首连即收当前状态；断线 1s 退避重连；终态后停止重连。
import { useEffect, useRef, useState } from "react";
import type { StatusMsg } from "./api";

const TERMINAL = new Set(["done", "aborted", "cancelled"]);

type WsMsg = StatusMsg | { type: "error"; error: string };

export function useRunStream(runId: string | null): StatusMsg | null {
  const [msg, setMsg] = useState<StatusMsg | null>(null);
  const terminalRef = useRef(false);

  useEffect(() => {
    if (!runId) {
      setMsg(null);
      return;
    }
    terminalRef.current = false;
    let ws: WebSocket | null = null;
    let timer: number | undefined;
    let closed = false;

    const connect = () => {
      if (closed || terminalRef.current) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(
        `${proto}://${location.host}/api/runs/${encodeURIComponent(runId)}/stream`,
      );
      ws.onmessage = (ev) => {
        const data = JSON.parse(ev.data) as WsMsg;
        if (data.type === "status") {
          setMsg(data);
          if (TERMINAL.has(data.phase)) terminalRef.current = true;
        }
      };
      ws.onclose = () => {
        if (!closed && !terminalRef.current) timer = window.setTimeout(connect, 1000);
      };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [runId]);

  return msg;
}
```

- [ ] **Step 8: 写 web/src/dagre.ts**

```ts
// web/src/dagre.ts
// 分层布局（LR）：dagre 自动算坐标，节点视在尺寸 190×64。
import dagre from "@dagrejs/dagre";
import type { GraphEdge, GraphNode } from "./api";

const NODE_W = 190;
const NODE_H = 64;

export function layoutGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 60, ranksep: 110 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of edges) g.setEdge(e.from, e.to);
  dagre.layout(g);
  const pos = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    const p = g.node(n.id);
    if (p) pos.set(n.id, { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 });
  }
  return pos;
}
```

- [ ] **Step 9: 安装 + 构建验证 + 提交**

Run:
```bash
cd web && npm install && npm run build
```
Expected: 构建成功（main.tsx 引用的 App.tsx 尚不存在——本步先建最小占位 `web/src/App.tsx`：`export default function App() { return <div />; }`，Task 11 替换）

```bash
git add web/
git commit -m "feat(web): Vite 脚手架 + api/ws/dagre 基础层"
```

### Task 11: RunList + App 布局（run 选择 → 图加载）

**Files:**
- Create: `web/src/components/RunList.tsx`
- Modify: `web/src/App.tsx`（替换占位）

**Interfaces:**
- Consumes: `fetchRuns/fetchStatus/fetchGraph`、`useRunStream`、Task 12 `GraphView`、Task 13 `NodePanel`（本任务以最小占位组件先行：`GraphView` 渲染 phase 头部，`NodePanel` 后补）
- Produces: App 状态流——`runId` 选中 → `fetchGraph`（失败显示错误 + 提示）+ `fetchStatus`（初始 outputs）→ WS 增量；`statusView: StatusCore | null = stream ?? initialStatus`

- [ ] **Step 1: 写 RunList.tsx**

```tsx
// web/src/components/RunList.tsx
import type { RunSummary } from "../api";

const PHASE_COLOR: Record<string, string> = {
  running: "#2563eb",
  done: "#16a34a",
  aborted: "#dc2626",
  cancelled: "#d97706",
};

export function RunList({
  runs,
  current,
  onSelect,
}: {
  runs: RunSummary[];
  current: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <aside
      style={{
        width: 230,
        flexShrink: 0,
        borderRight: "1px solid #e5e7eb",
        overflowY: "auto",
      }}
    >
      <div style={{ padding: "10px 12px", fontWeight: 600 }}>运行列表</div>
      {runs.map((r) => (
        <div
          key={r.run_id}
          onClick={() => onSelect(r.run_id)}
          style={{
            padding: "8px 12px",
            cursor: "pointer",
            background: r.run_id === current ? "#eef2ff" : undefined,
          }}
        >
          <div style={{ fontSize: 13 }}>{r.run_id}</div>
          <div style={{ fontSize: 11, color: PHASE_COLOR[r.phase] ?? "#6b7280" }}>
            {r.phase}
            {r.tick != null ? ` · tick ${r.tick}` : ""}
          </div>
        </div>
      ))}
      {!runs.length && (
        <div style={{ padding: 12, fontSize: 12, color: "#9ca3af" }}>暂无运行记录</div>
      )}
    </aside>
  );
}
```

- [ ] **Step 2: 写 App.tsx**

```tsx
// web/src/App.tsx
import { useCallback, useEffect, useState } from "react";
import {
  fetchGraph,
  fetchModules,
  fetchRuns,
  fetchStatus,
  type GraphPayload,
  type ModuleInfo,
  type RunSummary,
  type StatusCore,
  type StatusResp,
} from "./api";
import { useRunStream } from "./ws";
import { GraphView } from "./components/GraphView";
import { NodePanel } from "./components/NodePanel";

export default function App() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [payload, setPayload] = useState<GraphPayload | null>(null);
  const [initialStatus, setInitialStatus] = useState<StatusResp | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moduleOverride, setModuleOverride] = useState<string | null>(null);
  const [modules, setModules] = useState<ModuleInfo[]>([]);
  const stream = useRunStream(runId);

  const refreshRuns = useCallback(() => {
    fetchRuns()
      .then(setRuns)
      .catch(() => {});
  }, []);
  useEffect(() => {
    refreshRuns();
    const t = setInterval(refreshRuns, 5000);
    return () => clearInterval(t);
  }, [refreshRuns]);

  useEffect(() => {
    if (!runId) return;
    setPayload(null);
    setSelected(null);
    setError(null);
    setInitialStatus(null);
    fetchStatus(runId)
      .then(setInitialStatus)
      .catch(() => {});
    fetchGraph(runId, moduleOverride ?? undefined)
      .then(setPayload)
      .catch((e: Error) => setError(e.message));
    fetchModules()
      .then(setModules)
      .catch(() => {});
  }, [runId, moduleOverride]);

  const statusView: StatusCore | null = stream ?? initialStatus;
  const selectedNode = payload?.graph.nodes.find((n) => n.id === selected) ?? null;
  const needModulePicker = !!error && error.includes("未找到");

  return (
    <div style={{ display: "flex", height: "100%" }}>
      <RunList runs={runs} current={runId} onSelect={setRunId} />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <header
          style={{
            padding: "8px 14px",
            borderBottom: "1px solid #e5e7eb",
            fontSize: 13,
            color: "#6b7280",
          }}
        >
          {runId
            ? `${runId} · ${statusView?.phase ?? payload?.phase ?? "…"}${
                statusView?.tick != null ? ` · tick ${statusView.tick}` : ""
              }${statusView?.error ? ` · ${statusView.error}` : ""}`
            : "SpecModule 运行时图视图"}
        </header>
        <div style={{ flex: 1, position: "relative" }}>
          {error && (
            <div style={{ padding: 12, color: "#b91c1c" }}>
              图加载失败：{error}
              {needModulePicker && (
                <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                  <select onChange={(e) => setModuleOverride(e.target.value || null)} defaultValue="">
                    <option value="">选择模块…</option>
                    {modules.map((m) => (
                      <option key={`${m.kind}:${m.name}`} value={m.name}>
                        {m.name}（{m.kind}）
                      </option>
                    ))}
                  </select>
                  {moduleOverride && <span>已切换模块：{moduleOverride}</span>}
                </div>
              )}
            </div>
          )}
          {payload ? (
            <GraphView
              payload={payload}
              status={statusView}
              selected={selected}
              onSelect={setSelected}
            />
          ) : (
            !error && <div style={{ padding: 12 }}>选择左侧 run 开始查看</div>
          )}
        </div>
      </div>
      {payload && selected && selectedNode && (
        <NodePanel
          runId={runId!}
          node={selectedNode}
          outputs={statusView?.outputs ?? {}}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 3: 最小占位组件（Task 12/13 替换）**

`web/src/components/GraphView.tsx`：

```tsx
// web/src/components/GraphView.tsx（占位，Task 12 完整实现）
import type { GraphPayload, StatusCore } from "../api";

export function GraphView(_props: {
  payload: GraphPayload | null;
  status: StatusCore | null;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  return <div style={{ padding: 12, fontSize: 12, color: "#9ca3af" }}>图视图（待实现）</div>;
}
```

`web/src/components/NodePanel.tsx`：

```tsx
// web/src/components/NodePanel.tsx（占位，Task 13 完整实现）
import type { GraphNode } from "../api";

export function NodePanel(_props: {
  runId: string;
  node: GraphNode;
  outputs: Record<string, unknown>;
  onClose: () => void;
}) {
  return <aside style={{ width: 380, borderLeft: "1px solid #e5e7eb" }} />;
}
```

- [ ] **Step 4: 构建 + 提交**

Run: `cd web && npm run build`
Expected: 构建成功

```bash
git add web/src
git commit -m "feat(web): RunList + App 布局（run 选择 → 图加载 → WS 增量状态）"
```

### Task 12: GraphView + StatusNode（徽章/跟随/guard 标签/minimap）

**Files:**
- Create: `web/src/components/StatusNode.tsx`
- Modify: `web/src/components/GraphView.tsx`（替换占位）

**Interfaces:**
- Consumes: `GraphPayload/StatusCore`、`layoutGraph`、`@xyflow/react` v12（`ReactFlow/ReactFlowProvider/useReactFlow/Handle/MiniMap/Controls/Background`）
- Produces: `GraphView({payload, status, selected, onSelect})`；徽章优先级 running > failed/aborted（最近 firing）> done（有 firing）> idle；跟随模式默认开，`onMoveStart`（用户触发）即关，按钮「回到当前」重开

- [ ] **Step 1: 写 StatusNode.tsx**

```tsx
// web/src/components/StatusNode.tsx
// 自定义节点：名称 + 类型 + 状态色边框 + ×N 次数徽章。
import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { NodeState } from "../api";

export type StatusNodeData = {
  label: string;
  type: string;
  isStart: boolean;
  state?: NodeState;
};

export type StatusFlowNode = Node<StatusNodeData, "status">;

const BORDER: Record<string, string> = {
  running: "#2563eb",
  failed: "#dc2626",
  aborted: "#dc2626",
  done: "#16a34a",
  idle: "#9ca3af",
};

export function badgeOf(state?: NodeState): string {
  if (!state) return "idle";
  if (state.running) return "running";
  if (state.last_status && state.last_status !== "ok") return state.last_status;
  if (state.fired_count > 0) return "done";
  return "idle";
}

function StatusNodeInner({ data }: NodeProps<StatusFlowNode>) {
  const badge = badgeOf(data.state);
  const color = BORDER[badge] ?? BORDER.idle;
  return (
    <div
      style={{
        border: `2px solid ${color}`,
        borderRadius: 8,
        padding: "6px 10px",
        minWidth: 150,
        background: "#fff",
        boxShadow: badge === "running" ? `0 0 0 4px ${color}33` : undefined,
      }}
    >
      <Handle type="target" position={Position.Left} />
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
        <strong>{data.label}</strong>
        {data.state && data.state.fired_count > 0 && (
          <span
            title="运行次数"
            style={{ fontSize: 11, background: "#eef2ff", borderRadius: 8, padding: "0 6px" }}
          >
            ×{data.state.fired_count}
          </span>
        )}
      </div>
      <div style={{ fontSize: 11, color: "#6b7280" }}>
        {data.type}
        {data.isStart ? " · start" : ""}
        {badge === "running" ? " · 运行中" : ""}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export const StatusNode = memo(StatusNodeInner);
```

- [ ] **Step 2: 写 GraphView.tsx（完整版）**

```tsx
// web/src/components/GraphView.tsx
// 画布：dagre 分层布局 + 状态徽章 + guard 边标签 + 跟随镜头（手动即解锁）。
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { layoutGraph } from "../dagre";
import type { GraphPayload, StatusCore } from "../api";
import { StatusNode, type StatusFlowNode, type StatusNodeData } from "./StatusNode";

const nodeTypes: NodeTypes = { status: StatusNode };

type Props = {
  payload: GraphPayload;
  status: StatusCore | null;
  selected: string | null;
  onSelect: (id: string | null) => void;
};

function GraphCanvas({ payload, status, selected, onSelect }: Props) {
  const { fitView } = useReactFlow();
  const followRef = useRef(true); // 跟随模式（默认开；用户拖动即关）
  const fitLockRef = useRef(false); // 程序化 fitView 期间不误判为手动

  const nodes = useMemo<StatusFlowNode[]>(() => {
    const pos = layoutGraph(payload.graph.nodes, payload.graph.edges);
    const live: Record<string, (StatusNodeData & { state?: StatusNodeData["state"] })["state"]> = {
      ...payload.node_states,
    };
    if (status) {
      for (const n of payload.graph.nodes) {
        live[n.id] = {
          fired_count: live[n.id]?.fired_count ?? 0,
          last_status: live[n.id]?.last_status ?? null,
          last_tick: live[n.id]?.last_tick ?? null,
          running: status.phase === "running" && status.fireable.includes(n.id),
        };
      }
    }
    return payload.graph.nodes.map((n) => ({
      id: n.id,
      type: "status" as const,
      position: pos.get(n.id) ?? { x: 0, y: 0 },
      data: { label: n.label, type: n.type, isStart: n.is_start, state: live[n.id] },
      selected: selected === n.id,
    }));
  }, [payload, status, selected]);

  const edges = useMemo<Edge[]>(() => {
    return payload.graph.edges.map((e, i) => ({
      id: `e${i}`,
      source: e.from,
      target: e.to,
      label: e.guard ?? undefined,
      animated:
        !!status &&
        status.phase === "running" &&
        status.fireable.includes(e.from),
    }));
  }, [payload, status]);

  const fireableInView = useCallback((): string[] => {
    if (!status || status.phase !== "running") return [];
    return status.fireable.filter((id) =>
      payload.graph.nodes.some((n) => n.id === id),
    );
  }, [status, payload]);

  const centerOn = useCallback(
    (ids: string[]) => {
      fitLockRef.current = true;
      fitView({ nodes: ids.map((id) => ({ id })), duration: 600, padding: 0.25 }).then(
        () => {
          window.setTimeout(() => {
            fitLockRef.current = false;
          }, 80);
        },
      );
    },
    [fitView],
  );

  useEffect(() => {
    const ids = fireableInView();
    if (followRef.current && ids.length) centerOn(ids);
  }, [fireableInView, centerOn]);

  const onMoveStart = useCallback(() => {
    if (!fitLockRef.current) followRef.current = false;
  }, []);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <button
        onClick={() => {
          followRef.current = true;
          const ids = fireableInView();
          if (ids.length) centerOn(ids);
        }}
        style={{ position: "absolute", top: 8, left: 8, zIndex: 10 }}
      >
        回到当前
      </button>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onMoveStart={onMoveStart}
        onNodeClick={(_, n) => onSelect(n.id)}
        onPaneClick={() => onSelect(null)}
        fitView
        minZoom={0.2}
        maxZoom={2}
      >
        <MiniMap />
        <Controls />
        <Background />
      </ReactFlow>
    </div>
  );
}

export function GraphView(props: Props) {
  return (
    <ReactFlowProvider>
      <GraphCanvas {...props} />
    </ReactFlowProvider>
  );
}
```

- [ ] **Step 3: 构建 + 手动烟测（可选）+ 提交**

Run: `cd web && npm run build`
Expected: 构建成功（若后端在跑可 `npm run dev` 目测一次）

```bash
git add web/src/components
git commit -m "feat(web): GraphView + StatusNode（状态徽章/次数/guard 标签/跟随镜头）"
```

### Task 13: NodePanel（元信息 + firing 历史 + 实时输出）

**Files:**
- Modify: `web/src/components/NodePanel.tsx`（替换占位）

**Interfaces:**
- Consumes: `fetchNodeTimeline(runId, node)`、`GraphNode`、`outputs`（App 传入的 `statusView.outputs`，WS 自动刷新）
- Produces: `NodePanel({runId, node, outputs, onClose})`——元信息（type/start/inputs）、最新输出全文（JSON 美化，实时）、运行记录列表（tick 降序，点击行展开 output/error 全文）

- [ ] **Step 1: 写 NodePanel.tsx（完整版）**

```tsx
// web/src/components/NodePanel.tsx
// 节点面板：元信息 + 最新输出（实时）+ firing 历史（点击展开全文）。
import { useEffect, useState } from "react";
import { fetchNodeTimeline, type GraphNode, type TimelineEntry } from "../api";

function pretty(v: unknown): string {
  if (v === undefined) return "（尚无输出）";
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}

export function NodePanel({
  runId,
  node,
  outputs,
  onClose,
}: {
  runId: string;
  node: GraphNode;
  outputs: Record<string, unknown>;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [openTick, setOpenTick] = useState<number | null>(null);

  useEffect(() => {
    setEntries([]);
    setOpenTick(null);
    fetchNodeTimeline(runId, node.id)
      .then((t) => setEntries(t.entries))
      .catch(() => {});
  }, [runId, node.id]);

  const latest = outputs[node.id];

  return (
    <aside
      style={{
        width: 380,
        flexShrink: 0,
        borderLeft: "1px solid #e5e7eb",
        overflowY: "auto",
        padding: 12,
      }}
    >
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ margin: 0 }}>{node.id}</h3>
        <button onClick={onClose}>×</button>
      </header>
      <p style={{ color: "#6b7280", fontSize: 12 }}>
        类型 {node.type}
        {node.is_start ? " · start" : ""} · 输入 {JSON.stringify(node.inputs)}
      </p>
      <section>
        <h4 style={{ margin: "12px 0 6px" }}>最新输出（实时）</h4>
        <pre
          style={{
            background: "#f9fafb",
            padding: 8,
            borderRadius: 6,
            fontSize: 12,
            whiteSpace: "pre-wrap",
            margin: 0,
          }}
        >
          {pretty(latest)}
        </pre>
      </section>
      <section>
        <h4 style={{ margin: "16px 0 6px" }}>运行记录（{entries.length} 次）</h4>
        {entries
          .slice()
          .reverse()
          .map((e) => (
            <div key={e.tick} style={{ borderBottom: "1px solid #f3f4f6", padding: "6px 0" }}>
              <div
                style={{ display: "flex", justifyContent: "space-between", cursor: "pointer" }}
                onClick={() => setOpenTick(openTick === e.tick ? null : e.tick)}
              >
                <span>tick {e.tick}</span>
                <span style={{ color: e.status === "ok" ? "#16a34a" : "#dc2626" }}>
                  {e.status}
                </span>
              </div>
              {e.error && openTick !== e.tick && (
                <div style={{ fontSize: 12, color: "#dc2626" }}>{e.error}</div>
              )}
              {openTick === e.tick && (
                <pre
                  style={{
                    fontSize: 12,
                    whiteSpace: "pre-wrap",
                    background: "#f9fafb",
                    padding: 8,
                    margin: "6px 0 0",
                  }}
                >
                  {pretty(e.output)}
                  {e.error ? `\nerror: ${e.error}` : ""}
                </pre>
              )}
            </div>
          ))}
      </section>
    </aside>
  );
}
```

- [ ] **Step 2: 构建 + 提交**

Run: `cd web && npm run build`
Expected: 构建成功

```bash
git add web/src/components/NodePanel.tsx
git commit -m "feat(web): NodePanel（元信息/实时输出/firing 历史）"
```

### Task 14: 端到端走查 + 收尾（roadmap 勾选/变更日志）

**Files:**
- Modify: `roadmap.md`（勾选阶段 0/本轮切片完成项 + 变更日志追加）

- [ ] **Step 1: 三终端起环境**

```bash
# 终端 1（后端，仓库根）
SPECMODULE_BASE="$(pwd)" uvicorn server.app:app --port 8000

# 终端 2（前端 dev，web/）
cd web && npm run dev

# 终端 3（造真实 run，仓库根；tasklist 用测试 fixture 的形状）
cat > /tmp/mini_tasklist.json <<'EOF'
{"Tasks": {"A": {"type": "script", "script": "A"},
           "B": {"type": "script", "script": "B", "inputs": {"value": "A"}},
           "C": {"type": "script", "script": "C"}},
 "Flow": "[A] --> B\nA --|pick_c|--> C"}
EOF
SPECMODULE_PATH="$(pwd)/tests/modules" python -m module_harness.cli run \
  --module mini_graph --tasklist /tmp/mini_tasklist.json
```

（Git Bash 下 `$(pwd)` 可用；PowerShell 用 `$PWD.Path`。）

- [ ] **Step 2: 走查清单（浏览器 http://localhost:5173）**

- [ ] 运行列表出现 `mini_graph`，phase 从 running → done（5s 内刷新）
- [ ] 图渲染：3 节点（A 标 start）、边 A→B 无标签、A→C 带 `pick_c` 标签
- [ ] 运行窗口内（B/C 各 sleep 1.5s）：B/C 边框蓝色呼吸光晕（运行中）、镜头居中当前 fire 节点；拖动画布后跟随停止，「回到当前」恢复
- [ ] 运行结束后：A/B/C 绿框 + `×1` 次数徽章
- [ ] 点击 B：右栏元信息（type script · 输入 {"value":"A"}）+ 最新输出 `{"greeting": "hello from A"}` + 运行记录 1 条可展开
- [ ] 点击 C：guard 分支输出 `{"note": "guarded branch"}`（若 pick_c 路径 fire；未 fire 则未运行徽章 + 空记录——两种均为正确表现）
- [ ] 地址栏直接 `GET http://127.0.0.1:8000/api/runs/mini_graph/feed` 返回 feed 兼容形状

- [ ] **Step 3: 全量测试回归（两仓库）**

```bash
python -m pytest tests/ -q
cd ../SpecModule && python -m pytest module_harness/tests/ -q -m "not smoke"
```
Expected: 均 PASS

- [ ] **Step 4: roadmap 收尾 + 提交**

`roadmap.md`：勾选阶段 0 全部条目与阶段 1「运行时图视图」条目（`- [ ]` → `- [x]`）；变更日志追加：

```markdown
- 2026-08-29（实施）：阶段 0 后端 + 运行时图视图落地。库侧收编 build_run_graph/
  graph_to_dict（库仓库两笔提交）；webview 端点全家 + WS + React Flow 图视图。
  已知偏差：模块名溯源（module=run_id 启发式 + ?module= 覆盖）待上游 status.json
  补 module 字段后移除。
```

```bash
git add roadmap.md
git commit -m "docs: 阶段 0 + 运行时图视图完成勾选与变更日志"
```

---

## Self-Review 结论（写计划时已核）

1. **Spec 覆盖**：roadmap「运行时图视图设计」各节——数据流（Task 5-9 端点 + Task 10-13 前端）、图数据源收编（Task 1-4）、节点徽章语义（Task 8 叠加 + Task 12 前端）、模块解析失败弹选择器（Task 10 `fetchModules` + Task 11 App 错误分支）、错误契约（各端点任务）、测试与提交顺序（每任务提交 + Task 14 回归）——均有对应任务。
2. **占位符**：无 TBD/TODO；App.tsx/GraphView/NodePanel 的"占位"是任务间接口（后续任务整体替换），非内容缺失。
3. **类型一致性**：`build_run_graph` 返回 `(Graph, Tasklist) | None` 在 Task 2/3/8 一致；`StatusCore` 派生链（`StatusMsg`/`StatusResp`）在 api.ts/ws.ts/App.tsx 一致；`node_states` 形状在 Task 8（后端）与 api.ts `NodeState` 一致；`fetchGraph(runId, module?)` 在 Task 10 定义、Task 11 消费一致。
