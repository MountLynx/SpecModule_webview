"""直答模块 —— 单 harness 节点退化形态（spec §3.1）。行为与旧 chat_turn 等价。"""
from __future__ import annotations

from .base import ConversationalModule

ANSWER_PROMPT = """## 对话历史
{history}

## 用户
{brief}

请直接回答用户最新消息。"""

TASKLIST = {
    "Tasks": {
        "A": {
            "type": "harness", "harness": "answer",
            "inputs": {"history": "{spec.history}", "brief": "{spec.brief}"},
        },
    },
    # tickflow parser：无出边节点以 [A] 独行声明 start（Graph/tickflow/parser.py 语法节）
    "Flow": "[A]",
}


def build_registry(llm_client, event_bus):
    from module_harness import HarnessConfig, HarnessRegistry

    reg = HarnessRegistry(llm_client=llm_client, event_bus=event_bus)
    reg.harness("answer", HarnessConfig(prompt_core=ANSWER_PROMPT))
    return reg


DIRECT = ConversationalModule(
    key="direct", display_name="直答",
    description="单节点直接回答（无工作文档）",
    spec_schema={"brief": "str", "history": "str"},
    tasklist=TASKLIST, build_registry=build_registry,
    node_order=["A"], shape="text",
)
