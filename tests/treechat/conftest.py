"""共享假客户端与 session 工厂。"""
import json

import pytest
from llm import LLMError, LLMResponse


class FakeCardClient:
    """带 complete() 的假客户端：返回合法卡片 JSON（走 call_harness 校验路径）。"""

    async def complete(self, **kwargs):
        return LLMResponse(content=json.dumps({"title": "卡片标题", "body": "卡片正文"}))


class FakeModuleClient:
    """带 complete() 的假客户端（module run 路径，spec §9）。

    responses 按调用顺序弹出（一次 module run 的各节点各取一个）；
    on_token 被真实调用（content 三等分发射），驱动 harness 全套事件。
    默认回复 "mock reply"（直答文本断言用）。
    """

    def __init__(self, responses: list[str] | None = None,
                 reply: str = "mock reply") -> None:
        self.responses = list(responses) if responses is not None else None
        self.default_reply = reply
        self.calls: list[dict] = []
        self.fail = False
        self.config = type("Config", (), {"model": "fake-model"})()

    async def complete(self, **kwargs):
        self.calls.append(kwargs)
        if self.fail:
            raise LLMError("模拟基础设施故障")
        content = self.responses.pop(0) if self.responses else self.default_reply
        on_thinking = kwargs.get("on_thinking")
        if on_thinking:
            on_thinking("思考过程。")
        on_token = kwargs.get("on_token")
        if on_token:
            step = max(1, len(content) // 3)
            for i in range(0, len(content), step):
                on_token(content[i:i + step])
        return LLMResponse(content=content, usage={"input_tokens": 1, "output_tokens": 2})


@pytest.fixture
def fake_module():
    return FakeModuleClient()


@pytest.fixture
def fake_card_client():
    return FakeCardClient()
