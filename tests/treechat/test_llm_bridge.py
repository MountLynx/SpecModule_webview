"""llm_bridge：create_client 配置链 / extract_card 结构校验（对话轮次在 module_bridge）。"""
import asyncio
import json

import pytest
from llm import LLMError, LLMResponse

from treechat import llm_bridge
from treechat.core.errors import TreeChatError


class CardOkClient:
    """带 complete() 的假客户端：返回合法卡片 JSON。"""

    async def complete(self, **kwargs):
        return LLMResponse(content=json.dumps({"title": "卡片标题", "body": "卡片正文"}))


class CardBadClient:
    async def complete(self, **kwargs):
        return LLMResponse(content=json.dumps({"foo": 1}))


class BoomClient:
    async def complete(self, **kwargs):
        raise LLMError("鉴权失败")


def test_extract_card_ok():
    out = asyncio.run(llm_bridge.extract_card("转录", "总结", llm_client=CardOkClient()))
    assert out == {"title": "卡片标题", "body": "卡片正文"}


def test_extract_card_rejects_missing_keys():
    with pytest.raises(TreeChatError, match="title/body"):
        asyncio.run(llm_bridge.extract_card("t", "i", llm_client=CardBadClient()))


def test_extract_card_propagates_harness_call_error():
    from module_harness import HarnessCallError
    with pytest.raises((HarnessCallError, LLMError, TreeChatError)):
        asyncio.run(llm_bridge.extract_card("t", "i", llm_client=BoomClient()))
