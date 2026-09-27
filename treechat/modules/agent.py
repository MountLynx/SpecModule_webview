"""ops 模式定义 —— agent 形态模式（非 harness，spec D2）。

AgentMode 不是 ConversationalModule：不走 module_bridge 固定管线，回合由
agent_bridge 工具循环执行。只暴露 webapp SSE start 帧消费的元数据形状
（key/display_name/description/node_order/node_label）。
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class AgentMode:
    key: str
    display_name: str
    description: str
    node_order: list[str]
    node_labels: dict[str, str] = field(default_factory=dict)

    def node_label(self, key: str) -> str:
        return self.node_labels.get(key, key)


AGENT_MODE = AgentMode(
    key="ops", display_name="模块运营",
    description="对话式运营业务模块：查看模块库、完善 spec、发起运行、监控与控制。",
    node_order=["ops"], node_labels={"ops": "助手"})
