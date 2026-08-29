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
    review_harness=None,
    default_spec={"topic": "demo"},
)
