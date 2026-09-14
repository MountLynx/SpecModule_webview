"""SpecModule 依赖面 —— 对话轮次的模块执行在 module_bridge（spec §2）。

职责：① client 创建（create_client）；② 卡片提炼（call_harness 结构化调用
+ {title, body} 显式校验）。测试替换点：带 complete 的假客户端。
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from llm import LLMConfig, LLMError, create_llm_client
from module_harness import call_harness
from module_harness.core.config import HarnessConfig
from module_harness.core.outputfmt import OutputFormat

from .core.errors import TreeChatError

CARD_PROMPT_CORE = """\
你是上下文压缩器。把下面这段对话提炼成一张"卡片"：脱离原对话也能独立读懂的浓缩产出。

## 对话转录
{transcript}

## 提炼指令
{instruction}

要求：
- body 自包含：不出现"上面/刚才/对方/这段对话"等指代；保留事实、决策、结论与关键理由
- 去对话语气，写成结构化 markdown（可用小标题/列表）
- title 为一句话概括
"""

CARD_HARNESS_CONFIG = HarnessConfig(
    prompt_core=CARD_PROMPT_CORE,
    prompt_modes={"default": "按核心模板执行。"},
    output_format=OutputFormat(
        type="json_object",
        instruction='输出 JSON 对象：{"title": "一句话标题", "body": "markdown 正文"}',
    ),
    notdo=["不要在 JSON 之外输出任何文字"],
)


def create_client(model: str | None = None,
                  project_root: Path | None = None) -> Any:
    """env 驱动创建客户端（复用 SpecModule 配置回退链：项目根 → ~/.specmodule）。"""
    overrides: dict[str, Any] = {"model": model} if model else {}
    config = LLMConfig.from_env(
        project_root=project_root or Path.cwd(),
        store_root=Path.home() / ".specmodule",
        **overrides,
    )
    return create_llm_client(config)


async def extract_card(transcript: str, instruction: str, *,
                       llm_client: Any) -> dict[str, str]:
    """卡片提炼：call_harness 校验 json_object，再显式校验 {title, body} 键。"""
    result = await call_harness(
        CARD_HARNESS_CONFIG,
        {"transcript": transcript, "instruction": instruction},
        llm_client=llm_client,
        promptmode="default",
    )
    value = result.value
    if not isinstance(value, dict) or "title" not in value or "body" not in value:
        raise TreeChatError(f"卡片提炼输出缺 title/body: {value!r}")
    return {"title": str(value["title"]), "body": str(value["body"])}
