# tests/treechat/test_refine_spec.py
"""refine_spec：call_harness 无头 module run（能力类工具样例，D3）。

假客户端沿 test_llm_bridge.py 的 CardOkClient 形状（LLMResponse.content 载
JSON）——call_harness 消费 response.content/usage/finish_reason 后经
json_object 校验产出 HarnessCallResult.value，非任务草稿里的 .value 对象。
FakeRefineClient 记录渲染 prompt：锁「values 键 ↔ prompt_core 占位符」契约
（占位符改名等漂移会让字面 {schema} 进线上 prompt，这里当场红）。
async 测试沿仓库既有模式：普通 def + asyncio.run 包裹（无 pytest-asyncio 配置）。
"""

from __future__ import annotations

import asyncio
import json

from llm import LLMResponse

from server.deps import get_search_paths
from treechat.tools import ToolContext, all_tools, dispatch_tool

# 带 spec_schema 的最小 entry 模块（mini_graph 无 schema，渲染契约需有 schema 的模块）；
# search_paths(base) 含 base/modules，discover_modules 收集模块级 entry 变量。
SCHEMA_DEMO = '''\
"""review 渲染契约测试 fixture 模块（带 spec_schema 的最小 entry）。"""

from __future__ import annotations

from module_harness.cli.entry import ModuleEntry

entry = ModuleEntry(
    name="schema_demo",
    description="带 spec_schema 的最小测试模块",
    templates={},
    default_spec={"topic": "demo"},
    spec_schema={"topic": "str"},
)
'''


class FakeRefineClient:
    """complete 返回固定 spec JSON，并记录渲染 prompt（渲染契约断言用）。"""

    def __init__(self):
        self.prompts: list[str] = []

    async def complete(self, **kwargs):
        self.prompts.append(kwargs.get("prompt") or "")
        return LLMResponse(content=json.dumps(
            {"topic": "量子纠缠", "style": "科普"}, ensure_ascii=False))


class FakeListClient:
    """complete 返回 JSON 数组——触发工具侧「不是 JSON 对象」校验分支。"""

    async def complete(self, **kwargs):
        return LLMResponse(content=json.dumps(["a", "b"]))


def _ctx(base, client=None):
    return ToolContext(base_dir=base, search=get_search_paths(base),
                       client=client)


def _dispatch(name, args, ctx):
    return asyncio.run(dispatch_tool(all_tools(), name, args, ctx))


def _write_schema_demo(base):
    """往 base/modules/ 写带 spec_schema 的 fixture 模块（单文件 entry 格式）。"""
    modules = base / "modules"
    modules.mkdir(exist_ok=True)
    (modules / "schema_demo.py").write_text(SCHEMA_DEMO, encoding="utf-8")


def test_refine_spec_renders_draft_and_schema(base):
    """渲染契约：prompt 同时含草稿文本与 schema 内容（占位符真被替换）。"""
    _write_schema_demo(base)
    client = FakeRefineClient()
    out = _dispatch("refine_spec", {"module": "schema_demo",
                                    "draft": "写一篇量子纠缠科普"},
                    _ctx(base, client))
    assert out == {"spec": {"topic": "量子纠缠", "style": "科普"}}
    (prompt,) = client.prompts
    assert "写一篇量子纠缠科普" in prompt
    assert "'topic': 'str'" in prompt
    assert "{schema}" not in prompt and "{draft}" not in prompt


def test_refine_spec_schema_absent_hint(base):
    """mini_graph 无 spec_schema → schema 段渲染缺省说明句而非字面 {}。"""
    client = FakeRefineClient()
    out = _dispatch("refine_spec", {"module": "mini_graph",
                                    "draft": "写一篇量子纠缠科普"},
                    _ctx(base, client))
    assert out == {"spec": {"topic": "量子纠缠", "style": "科普"}}
    (prompt,) = client.prompts
    assert "模块未声明 spec_schema" in prompt


def test_refine_spec_unknown_module(base):
    ctx = _ctx(base, FakeRefineClient())
    out = _dispatch("refine_spec", {"module": "ghost", "draft": "x"}, ctx)
    assert "error" in out


def test_refine_spec_requires_client(base):
    ctx = _ctx(base)
    out = _dispatch("refine_spec", {"module": "mini_graph", "draft": "x"}, ctx)
    assert "error" in out


def test_refine_spec_rejects_non_object_output(base):
    """LLM 输出合法 JSON 但不是对象 → TreeChatError → dispatch 兜底 error dict。"""
    ctx = _ctx(base, FakeListClient())
    out = _dispatch("refine_spec", {"module": "mini_graph", "draft": "x"}, ctx)
    assert "error" in out
    assert "JSON 对象" in out["error"]
