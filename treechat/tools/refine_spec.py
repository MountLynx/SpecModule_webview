# treechat/tools/refine_spec.py
"""refine_spec —— 能力类工具样例：call_harness 单节点无头 module run（spec D3）。

吃结构化参数（module + draft）、吐结构化结果（完整 spec dict）；不挂会话上下文、
不做文档卡（与 ConversationalModule 的对话职责划界）。spec_schema 来自
module_detail——schema 是完善 spec 的校验锚（prompt 锚定，不硬校验——
硬校验由 run 侧 CLI spec 校验兜底）。写成型后可提升进 store，
与业务 module 的 submodule 成为同一类资产。结构对照 llm_bridge.py 的
CARD_HARNESS_CONFIG + extract_card（call_harness 校验 json_object + 显式键校验）。
"""
from __future__ import annotations

from module_harness import call_harness
from module_harness.core.config import HarnessConfig
from module_harness.core.outputfmt import OutputFormat
from module_harness.infra import store

from .base import ToolContext, ToolDef, register
from ..core.errors import TreeChatError

REFINE_PROMPT_CORE = """\
你是 spec 完善器。把用户草稿完善成符合目标模块 spec_schema 的完整 spec。

## 目标模块
{module}

## spec_schema（字段与类型）
{schema}

## 用户草稿
{draft}

## 补充要求
{requirements}

要求：
- 按 schema 字段补全 spec；草稿未覆盖的字段按合理缺省填写
- 不得输出 schema 之外的字段
"""

REFINE_HARNESS_CONFIG = HarnessConfig(
    prompt_core=REFINE_PROMPT_CORE,
    prompt_modes={"default": "按核心模板执行。"},
    output_format=OutputFormat(
        type="json_object",
        instruction="输出 JSON 对象：键为 spec 的各字段，值为符合 schema 类型的值",
    ),
    notdo=["不要在 JSON 之外输出任何文字"],
)


async def _refine_spec(args: dict, ctx: ToolContext) -> dict:
    if ctx.client is None:
        return {"error": "无 LLM 客户端（能力工具需要模型调用）"}
    name = args["module"]
    resolved = store.resolve_module_full(name, search=ctx.search)  # ValueError 原样
    if resolved is None:
        return {"error": f"模块 '{name}' 未找到"}
    detail = store.detail_to_dict(resolved)
    schema = detail.get("spec_schema")
    result = await call_harness(
        REFINE_HARNESS_CONFIG,
        {"module": name,
         "schema": (str(schema) if schema else
                    "（模块未声明 spec_schema——参考模块描述与 default_spec 字段）"),
         "draft": str(args.get("draft") or ""),
         "requirements": str(args.get("requirements") or "无")},
        llm_client=ctx.client,
        promptmode="default",
    )
    value = result.value
    if not isinstance(value, dict):
        raise TreeChatError(f"spec 完善输出不是 JSON 对象: {value!r}")
    return {"spec": value}


register(ToolDef(
    name="refine_spec",
    description=("把草稿需求完善成符合目标模块 spec_schema 的完整 spec"
                 "（LLM 结构化调用；可先用 module_detail 查 schema）。"),
    parameters={"type": "object",
                "properties": {
                    "module": {"type": "string", "description": "目标模块名"},
                    "draft": {"type": "string",
                              "description": "草稿需求（自然语言或部分 spec）"},
                    "requirements": {"type": "string", "description": "补充要求（可选）"},
                },
                "required": ["module", "draft"]},
    handler=_refine_spec))
