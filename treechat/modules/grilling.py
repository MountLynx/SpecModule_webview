"""拷问模块 —— grilling 轮次引擎 + domain-modeling 文档纪律（spec §3.2）。

移植自 skill_by_me/skills/productivity/grilling 与 engineering/domain-modeling
（组合形态 grill-with-docs 的融合实现）。一轮 run：更新设计树 → 前沿计算+术语
审查 → 词表裁决 → 归一化输出 {questions_md, done, tree_md, glossary_md}。
"""
from __future__ import annotations

from .base import ConversationalModule, DocumentDef

TREE_UPDATE_PROMPT = """\
你在主持一场「拷问」式设计对话，负责维护一棵设计树：每个决策是一个分支，\
挂在它的前提决策之下。

## 现有设计树
{tree_md}

## 本轮回答
{brief}

## 对话历史
{history}

把本轮回答合并进设计树：已 settled 的决策落为分支，并更新受影响的下游分支。
输出更新后的完整设计树（markdown），不要输出任何其他内容。"""

FRONTIER_PROMPT = """\
你在主持一场「拷问」式设计对话。除设计树外，你还对照项目的领域词表工作：\
本轮新 settled 的术语若与词表冲突、缺失或含糊，把应立/应改的词条整理进 terms_md。

## 设计树
{tree}

## 领域词表（可为空）
{glossary_md}

## 本轮回答
{brief}

## 对话历史
{history}

规则：
- frontier = 前置已 settled、现在就能问的问题；依赖未决答案的问题属于以后的轮次
- 整批提问：每条编号（Q1、Q2…），各给推荐答案（➡️ 开头）
- 事实自己查证，不问用户；决策必须问用户
- 领域关系有争议时，用具体的边界场景发问，逼出概念的精确边界
- frontier 清空（每个分支都已 visited，无遗留默认假设）时 done=true，\
questions_md 改为决策汇总

输出 JSON 对象：{"questions_md": "本轮问题清单 markdown", "done": false, \
"terms_md": "应立/应改词条 markdown，无则为空串"}
不要在 JSON 之外输出任何文字。"""

RESOLUTION_PROMPT = """\
你在维护项目的领域词表（CONTEXT.md 格式：术语加粗、一两句定义、_Avoid_ 列表；\
只收本项目特有的概念，通用编程概念不收）。

## 现有词表
{glossary_md}

## 前沿节点输出（JSON；其中 terms_md 字段为待裁决词条，可为空）
{terms_md}

## 设计树（上下文参照）
{tree}

仅把前沿节点输出中 terms_md 字段的待裁决词条并入词表：与既有条目冲突的以本轮\
裁决为准，统一格式，输出词表全文。
同时评估本轮 settled 的决策是否值得立 ADR——三条件全部满足才候选：\
难逆转 / 无上下文会费解 / 真实权衡。

输出 JSON 对象：{"glossary_md": "词表全文 markdown", "adr_candidates": \
"ADR 候选 markdown，无则为空串"}
不要在 JSON 之外输出任何文字。"""

TASKLIST = {
    "Tasks": {
        "TreeUpdate": {
            "type": "harness", "harness": "tree_update",
            "inputs": {"tree_md": "{spec.tree_md}", "brief": "{spec.brief}",
                       "history": "{spec.history}"},
        },
        "FrontierFormat": {
            "type": "harness", "harness": "frontier",
            "inputs": {"tree": "TreeUpdate", "glossary_md": "{spec.glossary_md}",
                       "brief": "{spec.brief}", "history": "{spec.history}"},
        },
        "Resolution": {
            "type": "harness", "harness": "resolution",
            "inputs": {"glossary_md": "{spec.glossary_md}", "terms_md": "FrontierFormat",
                       "tree": "TreeUpdate"},
        },
        "normalize": {
            "type": "script", "script": "normalize_grilling",
            "inputs": {"tree": "TreeUpdate", "frontier": "FrontierFormat",
                       "resolution": "Resolution"},
        },
    },
    # tickflow _EDGE_RE 锚定行尾：一行只能一条边，链式边必须逐行声明
    "Flow": "TreeUpdate --> FrontierFormat\nFrontierFormat --> Resolution\nResolution --> normalize",
}


def normalize_grilling(tree: str, frontier: dict, resolution: dict) -> dict:
    """归一化到 document 契约形态（spec §3）：消息 + 双文档字段 + done。"""
    glossary = str((resolution or {}).get("glossary_md", "") or "")
    adrs = str((resolution or {}).get("adr_candidates", "") or "").strip()
    if adrs:
        base = glossary.rstrip()
        glossary = (base + "\n\n" if base else "") + "## ADR 候选\n\n" + adrs + "\n"
    raw_done = (frontier or {}).get("done", False)
    if isinstance(raw_done, str) and raw_done.lower() == "false":
        raw_done = False   # LLM 偶发返回字符串 "false"，不得被 bool() 兜底成 True
    return {
        "questions_md": str((frontier or {}).get("questions_md", "") or ""),
        "done": bool(raw_done),
        "tree_md": str(tree or ""),
        "glossary_md": glossary,
    }


def build_registry(llm_client, event_bus):
    from module_harness import HarnessConfig, HarnessRegistry, OutputFormat

    reg = HarnessRegistry(llm_client=llm_client, event_bus=event_bus)

    def normalize(view):
        return normalize_grilling(view.field("tree"), view.field("frontier"),
                                  view.field("resolution"))

    reg.harness("tree_update", HarnessConfig(prompt_core=TREE_UPDATE_PROMPT))
    reg.harness("frontier", HarnessConfig(
        prompt_core=FRONTIER_PROMPT,
        output_format=OutputFormat(
            type="json_object",
            instruction='输出 JSON 对象：{"questions_md": "...", "done": false, "terms_md": "..."}'),
        notdo=["不要在 JSON 之外输出任何文字"],
    ))
    reg.harness("resolution", HarnessConfig(
        prompt_core=RESOLUTION_PROMPT,
        output_format=OutputFormat(
            type="json_object",
            instruction='输出 JSON 对象：{"glossary_md": "...", "adr_candidates": "..."}'),
        notdo=["不要在 JSON 之外输出任何文字"],
    ))
    reg.script("normalize_grilling")(normalize)
    return reg


GRILLING = ConversationalModule(
    key="grilling", display_name="拷问",
    description="设计树拷问 + 领域词表沉淀（每轮刷新两张卡片）",
    spec_schema={"brief": "str", "history": "str", "tree_md": "str", "glossary_md": "str"},
    tasklist=TASKLIST, build_registry=build_registry,
    node_order=["TreeUpdate", "FrontierFormat", "Resolution"],
    message_field="questions_md",
    node_labels={"TreeUpdate": "更新设计树", "FrontierFormat": "整理前沿问题",
                 "Resolution": "裁决与词表更新"},
    display_fields={"FrontierFormat": "questions_md", "Resolution": "glossary_md"},
    node_docs={"TreeUpdate": ["tree"], "Resolution": ["glossary"]},
    documents=[DocumentDef(key="tree", field="tree_md", title="设计树"),
               DocumentDef(key="glossary", field="glossary_md",
                           title="CONTEXT 词表草稿")],
)
