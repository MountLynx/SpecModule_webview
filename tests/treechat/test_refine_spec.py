# tests/treechat/test_refine_spec.py
"""refine_spec：call_harness 无头 module run（能力类工具样例，D3）。

假客户端沿 test_llm_bridge.py 的 CardOkClient 形状（LLMResponse.content 载
JSON）——call_harness 消费 response.content/usage/finish_reason 后经
json_object 校验产出 HarnessCallResult.value，非任务草稿里的 .value 对象。
async 测试沿仓库既有模式：普通 def + asyncio.run 包裹（无 pytest-asyncio 配置）。
"""

from __future__ import annotations

import asyncio
import json

from llm import LLMResponse

from server.deps import get_search_paths
from treechat.tools import ToolContext, all_tools, dispatch_tool


class FakeRefineClient:
    """complete 返回固定 spec JSON（走 call_harness 的 json_object 校验路径）。"""

    async def complete(self, **kwargs):
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


def test_refine_spec_returns_spec(base):
    ctx = _ctx(base, FakeRefineClient())
    out = _dispatch("refine_spec", {"module": "mini_graph",
                                    "draft": "写一篇量子纠缠科普"}, ctx)
    assert out == {"spec": {"topic": "量子纠缠", "style": "科普"}}


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
