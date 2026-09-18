"""module_bridge：spec 组装 / 回合执行 / 失败翻译（spec §2）。"""
import asyncio
import json
from dataclasses import replace

import pytest
from llm import LLMError

from treechat.core.conversation import Conversation
from treechat.core.context import TokenWindowStrategy
from treechat.module_bridge import build_spec, run_turn
from treechat.modules import BUILT_IN


def _conv(tmp_path, system=""):
    conv = Conversation.create(tmp_path / "s.jsonl", name="t", system=system)
    u1 = conv.append_user("第一问")
    a1 = conv.append_assistant(u1, "第一答")
    u2 = conv.append_user("第二问")
    return conv, u2


def test_build_spec_common_fields(tmp_path):
    conv, u2 = _conv(tmp_path, system="简洁回答")
    spec = build_spec(BUILT_IN["direct"], conv, u2, TokenWindowStrategy())
    # brief = 用户输入原文（一字不改）
    assert spec["brief"] == "第二问"
    # history = 转录（system 置顶 + [role] 行），不含当前 user 节点
    assert spec["history"].startswith("## 系统设定\n简洁回答")
    assert "[user] 第一问" in spec["history"] and "[assistant] 第一答" in spec["history"]
    assert "第二问" not in spec["history"]


def test_build_spec_injects_document_fields_from_spec_cards(tmp_path):
    conv, u2 = _conv(tmp_path)
    conv.set_category("grilling")
    conv.add_card("设计树", "# 用户手改的树", from_path=[], card_id="spec:tree")
    conv.add_card("CONTEXT 词表草稿", "**Order**: 订单", from_path=[], card_id="spec:glossary")
    spec = build_spec(BUILT_IN["grilling"], conv, u2, TokenWindowStrategy())
    assert spec["tree_md"] == "# 用户手改的树"
    assert spec["glossary_md"] == "**Order**: 订单"


def test_build_spec_missing_cards_empty_and_excluded_from_history(tmp_path):
    conv, u2 = _conv(tmp_path)
    conv.add_card("普通卡", "普通正文", from_path=[], instruction="")  # 用户卡：进转录
    conv.add_card("设计树", "# 树", from_path=[], card_id="spec:tree")  # spec 卡：不进
    spec = build_spec(BUILT_IN["grilling"], conv, u2, TokenWindowStrategy())
    assert spec["glossary_md"] == ""                      # 无卡片 → 空串
    assert "普通正文" in spec["history"]                   # 用户 pinned 卡照旧进转录
    assert "# 树" not in spec["history"]                  # spec 卡不入转录（防双份注入）


def _run(module, conv, seq, client, on_event=lambda e: None):
    return asyncio.run(run_turn(module, conv, seq, client=client,
                                window=TokenWindowStrategy(), on_event=on_event))


def test_run_turn_direct_text(tmp_path, fake_module):
    conv, u2 = _conv(tmp_path)
    events = []
    out = _run(BUILT_IN["direct"], conv, u2, fake_module, on_event=events.append)
    assert out.message_text == "mock reply"
    assert out.done is False and out.documents == []
    assert out.usage["output_tokens"] == 2
    kinds = [e["event"] for e in events]
    assert kinds[0] == "node_start" and kinds[-1] == "node_end"
    assert any(e["event"] == "token" and e["text"] for e in events)


def test_run_turn_emits_thinking_events(tmp_path, fake_module):
    """LlmThinking → SSE thinking 帧：原始文本透传，不经 FieldStreamShaper。"""
    conv, u2 = _conv(tmp_path)
    events = []
    out = _run(BUILT_IN["direct"], conv, u2, fake_module, on_event=events.append)
    think = [e for e in events if e["event"] == "thinking"]
    assert think and all(e["key"] and isinstance(e["text"], str) for e in think)
    assert "".join(e["text"] for e in think) == "思考过程。"
    # thinking 帧先于同节点正文 token 帧（思考在前）
    kinds = [e["event"] for e in events]
    assert kinds.index("thinking") < kinds.index("token")


def test_run_turn_direct_prompt_content(tmp_path, fake_module):
    conv, u2 = _conv(tmp_path, system="sys-1")
    _run(BUILT_IN["direct"], conv, u2, fake_module)
    prompt = fake_module.calls[0]["prompt"]
    assert "## 系统设定\nsys-1" in prompt and "[user] 第一问" in prompt
    assert "第二问" in prompt


def test_run_turn_grilling_documents_and_events(tmp_path, fake_module):
    conv, u2 = _conv(tmp_path)
    conv.set_category("grilling")
    fake_module.responses = [
        "# 树-v1",
        json.dumps({"questions_md": "❓ Q1", "done": False, "terms_md": ""}),
        json.dumps({"glossary_md": "**Order**: 订单", "adr_candidates": ""}),
    ]
    events = []
    out = _run(BUILT_IN["grilling"], conv, u2, fake_module, on_event=events.append)
    assert out.message_text == "❓ Q1" and out.done is False
    assert out.usage == {"input_tokens": 3, "output_tokens": 6}  # 三次 LLM 调用聚合
    assert {c: (t, b) for c, t, b in out.documents} == {
        "spec:tree": ("设计树", "# 树-v1"),
        "spec:glossary": ("CONTEXT 词表草稿", "**Order**: 订单"),
    }
    # 三节点事件序列；FrontierFormat 事件经整形器解码（token 拼接 = questions_md 内容）
    starts = [e["key"] for e in events if e["event"] == "node_start"]
    assert starts == ["TreeUpdate", "FrontierFormat", "Resolution"]
    frontier_tokens = "".join(e["text"] for e in events
                              if e["event"] == "token" and e["key"] == "FrontierFormat")
    assert frontier_tokens == "❓ Q1"  # 原始 JSON 不上线（流整形）
    ends = {e["key"]: e["refs"] for e in events if e["event"] == "node_end"}
    assert ends["TreeUpdate"] == [{"type": "card", "cardId": "spec:tree", "title": "设计树"}]
    assert ends["Resolution"] == [{"type": "card", "cardId": "spec:glossary",
                                   "title": "CONTEXT 词表草稿"}]


def test_run_turn_document_message_field_is_declared_by_module(tmp_path, fake_module):
    """bridge 不硬编码 questions_md：模块声明什么，消息就取什么。"""
    conv, u2 = _conv(tmp_path)
    conv.set_category("grilling")
    fake_module.responses = [
        "# 树-v1",
        json.dumps({"questions_md": "❓ Q1", "done": False, "terms_md": ""}),
        json.dumps({"glossary_md": "**Order**: 订单", "adr_candidates": ""}),
    ]
    module = replace(BUILT_IN["grilling"], message_field="")
    out = _run(module, conv, u2, fake_module)
    assert out.message_text == ""  # 空声明 = 无消息；旧 bridge 会硬取到 "❓ Q1"
    assert [card_id for card_id, _, _ in out.documents] == ["spec:tree", "spec:glossary"]


def test_run_turn_llm_failure_raises(tmp_path, fake_module):
    conv, u2 = _conv(tmp_path)
    fake_module.fail = True
    events = []
    with pytest.raises(LLMError):
        _run(BUILT_IN["direct"], conv, u2, fake_module, on_event=events.append)
    # infra 路径：HarnessFailed → failed node_end（SSE 通道不失真）
    ends = {e["key"]: e["outcome"] for e in events if e["event"] == "node_end"}
    assert ends["A"] == "failed"


def test_run_turn_validation_failure_emits_failed_node_end(tmp_path, fake_module):
    """校验失败节点最终 node_end outcome 必须是 failed（OutputValidated 补发）。

    LlmCallCompleted 在格式校验之前发射——失败节点会先有一帧 ok；
    前端按 key 覆盖 outcome（后者胜），故这里断言最后一帧为 failed。
    """
    conv, u2 = _conv(tmp_path)
    conv.set_category("grilling")
    fake_module.responses = [
        "# 树", "不是 JSON", json.dumps({"glossary_md": "g", "adr_candidates": ""}),
    ]
    events = []
    with pytest.raises(LLMError):
        _run(BUILT_IN["grilling"], conv, u2, fake_module, on_event=events.append)
    ends = {e["key"]: e["outcome"] for e in events if e["event"] == "node_end"}
    assert ends["FrontierFormat"] == "failed"


def test_run_turn_validation_failure_raises(tmp_path, fake_module):
    """json 节点输出不合法 → harness Failure（非 HarnessFailed）→ 仍翻译为 LLMError。"""
    conv, u2 = _conv(tmp_path)
    conv.set_category("grilling")
    fake_module.responses = [
        "# 树", "不是 JSON", json.dumps({"glossary_md": "g", "adr_candidates": ""}),
    ]
    with pytest.raises(LLMError):
        _run(BUILT_IN["grilling"], conv, u2, fake_module)
