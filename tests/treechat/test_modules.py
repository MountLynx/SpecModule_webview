"""嵌入式模块定义：注册表 / resolve / 流整形器 / normalize（spec §2-§4）。"""
from treechat.modules import BUILT_IN, DEFAULT_MODE_MAP, resolve_module
from treechat.modules.base import FieldStreamShaper
from treechat.modules.grilling import TASKLIST, normalize_grilling


class TestFieldStreamShaper:
    def test_whole_chunk(self):
        sh = FieldStreamShaper("questions_md")
        assert sh.feed('{"questions_md": "你好", "done": false}') == "你好"

    def test_key_split_across_chunks(self):
        sh = FieldStreamShaper("questions_md")
        out = sh.feed('{"questi') + sh.feed('ons_md": "abc"}')
        assert out == "abc"

    def test_escapes_and_split_inside_escape(self):
        sh = FieldStreamShaper("questions_md")
        out = sh.feed('{"questions_md": "a\\nb\\"c') + sh.feed('d"}')
        assert out == 'a\nb"cd'

    def test_unicode_escape_split(self):
        sh = FieldStreamShaper("questions_md")
        out = sh.feed('{"questions_md": "\\u0') + sh.feed('041"}')
        assert out == "A"

    def test_field_absent_no_output(self):
        sh = FieldStreamShaper("questions_md")
        assert sh.feed('{"done": false, "terms_md": "x"}') == ""

    def test_content_after_close_ignored(self):
        sh = FieldStreamShaper("questions_md")
        assert sh.feed('{"questions_md": "内容", "done": true}') == "内容"

    def test_pretty_printed_json_drip_feed(self):
        sh = FieldStreamShaper("questions_md")
        out = ""
        for ch in '{\n  "questions_md":\n      "line one\\nline two"\n}':
            out += sh.feed(ch)
        assert out == "line one\nline two"

    def test_surrogate_pair_decoded(self):
        sh = FieldStreamShaper("f")
        out = sh.feed('{"f": "\\ud83d\\ude00"}')
        assert out == "\U0001F600"

    def test_trailing_backslash_split(self):
        sh = FieldStreamShaper("f")
        out = sh.feed('{"f": "a\\') + sh.feed('nb\\"c"}')
        assert out == 'a\nb"c'


def test_registry_builtin_modes():
    assert set(BUILT_IN) == {"direct", "grilling", "ops"}


def test_resolve_category_mapping_and_fallback():
    assert resolve_module("").key == "direct"
    assert resolve_module("grilling").key == "grilling"
    assert resolve_module("工作").key == "direct"          # 旧值回落直答（spec §4）
    assert resolve_module("grilling", {}).key == "grilling"  # 内建 key 直查：映射解绑不了内建（identity）
    assert resolve_module("g", {"g": "grilling"}).key == "grilling"
    assert DEFAULT_MODE_MAP == {"grilling": "grilling", "ops": "ops"}


def test_builtin_identity_and_ops():
    """内建 key 直查（identity）——ops/grilling 不经映射表也命中；未知回落直答。"""
    assert resolve_module("ops").key == "ops"
    assert resolve_module("grilling").key == "grilling"
    assert resolve_module("").key == "direct"
    assert resolve_module("zzz").key == "direct"
    assert resolve_module("mycat", {"mycat": "grilling"}).key == "grilling"


def test_direct_tasklist_single_node_start():
    """tickflow 语法：无出边节点以 [A] 声明 start（parser.py grammar）。"""
    tl = BUILT_IN["direct"].tasklist
    assert tl["Flow"] == "[A]"
    assert tl["Tasks"]["A"]["inputs"] == {"history": "{spec.history}", "brief": "{spec.brief}"}


def test_direct_registry_registers_answer():
    from treechat.modules.direct import build_registry
    reg = build_registry(object(), None)
    assert "answer" in reg._harness_cfgs


def test_grilling_tasklist_shape():
    assert list(TASKLIST["Tasks"]) == ["TreeUpdate", "FrontierFormat", "Resolution", "normalize"]
    assert (TASKLIST["Flow"] == "TreeUpdate --> FrontierFormat\n"
                               "FrontierFormat --> Resolution\n"
                               "Resolution --> normalize")
    assert TASKLIST["Tasks"]["FrontierFormat"]["inputs"]["tree"] == "TreeUpdate"
    assert TASKLIST["Tasks"]["normalize"]["inputs"] == {
        "tree": "TreeUpdate", "frontier": "FrontierFormat", "resolution": "Resolution"}


def test_grilling_flow_parses():
    """回归守护：Flow 必须可被 tickflow 解析（边逐行声明；单行链会 ParseError）。"""
    from module_harness.model.translator import prepare_flow
    from tickflow.parser import parse as parse_flow
    graph = parse_flow(prepare_flow(TASKLIST["Flow"]))
    assert {n for n, node in graph.nodes.items() if node.is_start} == {"TreeUpdate"}


def test_normalize_splits_documents_and_adr_section():
    out = normalize_grilling(
        "# 树",
        {"questions_md": "❓ Q1", "done": True, "terms_md": "**Order**: 订单"},
        {"glossary_md": "**Order**: 订单", "adr_candidates": "ADR-0001 用 PG"},
    )
    assert out == {
        "questions_md": "❓ Q1", "done": True, "tree_md": "# 树",
        "glossary_md": "**Order**: 订单\n\n## ADR 候选\n\nADR-0001 用 PG\n",
    }


def test_normalize_empty_adr_no_section():
    out = normalize_grilling("# 树", {"questions_md": "q", "done": False},
                             {"glossary_md": "g", "adr_candidates": ""})
    assert out["glossary_md"] == "g" and out["done"] is False


def test_normalize_empty_glossary_with_adr_no_leading_blank():
    out = normalize_grilling("", {"questions_md": "q", "done": False},
                             {"glossary_md": "", "adr_candidates": "ADR-0001"})
    assert out["glossary_md"] == "## ADR 候选\n\nADR-0001\n"


def test_normalize_done_string_false_guard():
    """LLM 偶发返回字符串 "false"：不得被 bool() 兜底成 True（任意大小写）。"""
    assert normalize_grilling("", {"done": "false"}, {})["done"] is False
    assert normalize_grilling("", {"done": "False"}, {})["done"] is False


def test_grilling_registry_registers_nodes():
    from treechat.modules.grilling import build_registry
    reg = build_registry(object(), None)
    assert set(reg._harness_cfgs) == {"tree_update", "frontier", "resolution"}
    assert "normalize_grilling" in reg._script_names


def test_grilling_def_metadata():
    g = BUILT_IN["grilling"]
    assert g.display_name == "拷问"
    assert g.node_order == ["TreeUpdate", "FrontierFormat", "Resolution"]
    assert g.message_field == "questions_md"
    assert g.display_fields == {"FrontierFormat": "questions_md", "Resolution": "glossary_md"}
    assert {d.key for d in g.documents} == {"tree", "glossary"}
    assert g.node_docs["TreeUpdate"] == ["tree"]
    assert g.spec_schema == {"brief": "str", "history": "str",
                             "tree_md": "str", "glossary_md": "str"}
