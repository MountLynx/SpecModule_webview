"""module_bridge：spec 组装 / 回合执行 / 失败翻译（spec §2）。"""
import asyncio
import json
from dataclasses import replace

import pytest
from llm import LLMError

from treechat.core.cards import doc_card_id
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


def test_build_spec_document_fields_resolve(tmp_path):
    """文档字段：路径上节点卡版本优先（grilling 主路径）。"""
    conv, u2 = _conv(tmp_path)
    conv.add_card("设计树", "# 树-节点版", from_path=[], owner_seq=2, doc_key="tree",
                  card_id=doc_card_id("tree", 2))
    spec = build_spec(BUILT_IN["grilling"], conv, u2,
                      TokenWindowStrategy(budget_tokens=10_000))
    assert spec["tree_md"] == "# 树-节点版"
    assert spec["glossary_md"] == ""  # 路径无版本且无 legacy → 空串


def test_build_spec_document_fields_legacy_global_fallback(tmp_path):
    """旧会话兼容：路径无节点版本时回退读旧全局 spec: 卡（单份注入）。"""
    conv, u2 = _conv(tmp_path)
    conv.add_card("设计树", "# 用户手改的树", from_path=[], card_id="spec:tree")
    conv.add_card("CONTEXT 词表草稿", "**Order**: 订单", from_path=[], card_id="spec:glossary")
    spec = build_spec(BUILT_IN["grilling"], conv, u2,
                      TokenWindowStrategy(budget_tokens=10_000))
    assert spec["tree_md"] == "# 用户手改的树"
    assert spec["glossary_md"] == "**Order**: 订单"
    assert spec["history"].count("# 用户手改的树") == 0  # 仅经 tree_md 字段，不经 pinned 卡块


def test_build_spec_pinned_injection_excludes_node_cards(tmp_path):
    """全局卡 pin 注入照旧；节点卡不进 system（文档走模块 spec 字段，防双份注入）。"""
    conv, u2 = _conv(tmp_path)
    conv.add_card("全局参考", "全局正文", from_path=[])           # 全局卡，默认 pinned
    conv.add_card("设计树", "# 树-节点版", from_path=[], owner_seq=2,
                  doc_key="tree", card_id=doc_card_id("tree", 2))
    spec = build_spec(BUILT_IN["grilling"], conv, u2,
                      TokenWindowStrategy(budget_tokens=10_000))
    assert "全局正文" in spec["history"]        # system 进 history 首段
    assert spec["history"].count("# 树-节点版") == 0  # 节点卡不入转录
    assert spec["tree_md"] == "# 树-节点版"


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
    # thinking 与节点配对：key 必属某 start 帧通告的节点
    starts = {e["key"] for e in events if e["event"] == "node_start"}
    assert {e["key"] for e in think} <= starts


def test_run_turn_grilling_thinking_bypasses_shaper(tmp_path, fake_module):
    """json 形状节点（带 display_fields/shaper）的 thinking 帧也原样透传。

    FrontierFormat 有 FieldStreamShaper（token 流被整形）——若 thinking 误经
    shaper，seek 态匹配不到字段锚，"思考过程。" 会被整体吞掉、本断言失败。
    """
    conv, u2 = _conv(tmp_path)
    conv.set_category("grilling")
    fake_module.responses = [
        "# 树-v1",
        json.dumps({"questions_md": "❓ Q1", "done": False, "terms_md": ""}),
        json.dumps({"glossary_md": "**Order**: 订单", "adr_candidates": ""}),
    ]
    events = []
    _run(BUILT_IN["grilling"], conv, u2, fake_module, on_event=events.append)
    frontier = "".join(e["text"] for e in events
                       if e["event"] == "thinking" and e["key"] == "FrontierFormat")
    assert frontier == "思考过程。"  # 原始文本透传，未经整形


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
        "tree": ("设计树", "# 树-v1"),
        "glossary": ("CONTEXT 词表草稿", "**Order**: 订单"),
    }
    # 三节点事件序列；FrontierFormat 事件经整形器解码（token 拼接 = questions_md 内容）
    starts = [e["key"] for e in events if e["event"] == "node_start"]
    assert starts == ["TreeUpdate", "FrontierFormat", "Resolution"]
    frontier_tokens = "".join(e["text"] for e in events
                              if e["event"] == "token" and e["key"] == "FrontierFormat")
    assert frontier_tokens == "❓ Q1"  # 原始 JSON 不上线（流整形）
    ends = {e["key"]: e["refs"] for e in events if e["event"] == "node_end"}
    assert ends["TreeUpdate"] == [{"type": "doc", "docKey": "tree", "title": "设计树"}]
    assert ends["Resolution"] == [{"type": "doc", "docKey": "glossary",
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
    assert [key for key, _, _ in out.documents] == ["tree", "glossary"]


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
