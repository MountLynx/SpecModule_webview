"""WebApp：REST API 覆盖（假客户端注入，无网络）。"""
import json

import pytest
from fastapi.testclient import TestClient
from llm import LLMError, LLMResponse

from treechat.config import TreeChatConfig
from treechat.webapp.app import create_app


class FakeLLM:
    """complete 单能力假客户端：responses 队列脚本化节点输出，默认卡片 JSON。"""

    def __init__(self) -> None:
        self.fail = False
        self.responses: list[str] = []
        self.calls: list[dict] = []
        self.config = type("Config", (), {"model": "fake-model"})()

    async def complete(self, **kwargs):
        self.calls.append(kwargs)
        if self.fail:
            raise LLMError("模拟基础设施故障")
        content = (self.responses.pop(0) if self.responses
                   else json.dumps({"title": "卡片标题", "body": "卡片正文"}))
        on_token = kwargs.get("on_token")
        if on_token:
            step = max(1, len(content) // 3)
            for i in range(0, len(content), step):
                on_token(content[i:i + step])
        return LLMResponse(content=content, usage={"input_tokens": 1, "output_tokens": 2})


@pytest.fixture
def api(tmp_path):
    fake = FakeLLM()
    config = TreeChatConfig(data_dir=tmp_path)
    # with 形式：整个测试期共享同一 portal/事件循环（lifespan 启动），
    # registry 的 asyncio.Lock 跨请求存续才有真实锁语义。
    with TestClient(create_app(config, client_factory=lambda model=None: fake)) as client:
        client.fake = fake
        yield client


def sse_events(client, url, **kwargs):
    """POST 流式端点 → [(event, data)]（帧解析）。"""
    events = []
    with client.stream("POST", url, **kwargs) as resp:
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        event = None
        for line in resp.iter_lines():
            if line.startswith("event: "):
                event = line[len("event: "):]
            elif line.startswith("data: ") and event is not None:
                events.append((event, json.loads(line[len("data: "):])))
                event = None
    return events


def test_health(api):
    r = api.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True and "llmConfigured" in body


def test_session_crud_and_management(api):
    # 创建（默认 200，返回 sid）
    r = api.post("/api/sessions", json={"name": "测试", "system": "sys"})
    assert r.status_code == 200 and r.json()["sid"] == "测试"
    # 重复创建 → 409
    assert api.post("/api/sessions", json={"name": "测试"}).status_code == 409
    # 枚举
    assert [s["sid"] for s in api.get("/api/sessions").json()] == ["测试"]
    # 改名 / 分类 / 归档（会话状态全量返回）
    st = api.post("/api/sessions/测试/rename", json={"name": "改名"}).json()
    assert st["name"] == "改名"
    st = api.post("/api/sessions/测试/category", json={"category": "工作"}).json()
    assert st["category"] == "工作"
    st = api.post("/api/sessions/测试/archive", json={"archived": True}).json()
    assert st["archived"] is True
    # 删除 → 204，之后 404
    assert api.delete("/api/sessions/测试").status_code == 204
    assert api.get("/api/sessions/测试").status_code == 404
    assert api.get("/api/sessions").json() == []


def test_session_delete_waits_for_inflight_turn_without_ghost(tmp_path):
    """删除必须和轮次共用 registry 锁：否则 unlink 后追加写会重建幽灵文件。"""
    import asyncio
    import threading
    import time

    class BlockingLLM(FakeLLM):
        def __init__(self) -> None:
            super().__init__()
            self.entered = threading.Event()
            self.release = threading.Event()

        async def complete(self, **kwargs):
            self.entered.set()
            await asyncio.to_thread(self.release.wait, 5)
            return await super().complete(**kwargs)

    fake = BlockingLLM()
    config = TreeChatConfig(data_dir=tmp_path)
    with TestClient(create_app(config, client_factory=lambda model=None: fake)) as client:
        sid = "t"
        assert client.post("/api/sessions", json={"name": sid}).status_code == 200
        turn_result: list = []
        delete_result: list = []
        delete_called = threading.Event()

        def run_turn() -> None:
            try:
                with client.stream("POST", f"/api/sessions/{sid}/turn",
                                   json={"text": "问题"}) as resp:
                    for _ in resp.iter_lines():
                        pass
                    turn_result.append(resp.status_code)
            except Exception as exc:  # noqa: BLE001
                turn_result.append(exc)

        def delete_session() -> None:
            delete_called.set()
            try:
                delete_result.append(client.delete(f"/api/sessions/{sid}").status_code)
            except Exception as exc:  # noqa: BLE001
                delete_result.append(exc)

        tt = threading.Thread(target=run_turn)
        td = threading.Thread(target=delete_session)
        try:
            tt.start()
            assert fake.entered.wait(5), "轮次未进入 LLM"  # 此时 registry 锁已被 work 持有
            td.start()
            assert delete_called.wait(5), "删除请求未启动"
            # 有锁：删除阻塞到轮次结束；无锁：会立刻 204。轮询兜住线程调度。
            for _ in range(20):
                if not td.is_alive():
                    break
                time.sleep(0.05)
            assert td.is_alive(), "session_delete 未等待在飞轮次"
            assert not delete_result, f"删除抢跑: {delete_result}"
        finally:
            fake.release.set()
            if tt.ident is not None:
                tt.join(5)
            if td.ident is not None:
                td.join(5)

        assert turn_result == [200]
        assert delete_result == [204]
        assert list(config.sessions_dir().glob("*.jsonl")) == []
        assert client.get("/api/sessions").json() == []


def test_turn_sse_sequence_and_state(api):
    sid = "t"
    api.post("/api/sessions", json={"name": sid})
    api.fake.responses = ["直答正文"]
    events = sse_events(api, f"/api/sessions/{sid}/turn", json={"text": "问一"})
    kinds = [e for e, _ in events]
    assert kinds[0] == "start"
    assert events[0][1] == {"userSeq": 2, "module": "direct",
                            "nodes": [{"key": "A", "label": "A"}]}
    assert "node_start" in kinds and "token" in kinds
    assert kinds[-1] == "done"
    state = events[-1][1]["state"]
    assert state["pointer"] == 2                       # 指针 = 轮（assistant 事件 seq=3 已回填）
    assert next(n for n in state["nodes"] if n["seq"] == 2)["output"] == "直答正文"


def test_turn_sse_grilling_writes_node_doc_cards(api):
    sid = "g"
    api.post("/api/sessions", json={"name": sid, "category": "grilling"})
    api.fake.responses = [
        "# 树-v1",
        json.dumps({"questions_md": "❓ Q1", "done": False, "terms_md": ""}),
        json.dumps({"glossary_md": "**Order**: 订单", "adr_candidates": ""}),
    ]
    events = sse_events(api, f"/api/sessions/{sid}/turn", json={"text": "做个订单系统"})
    start = events[0][1]
    assert start["module"] == "grilling"
    assert [n["key"] for n in start["nodes"]] == ["TreeUpdate", "FrontierFormat", "Resolution"]
    assert start["nodes"][0]["label"] == "更新设计树"
    # FrontierFormat 的 token 已整形解码（原始 JSON 不上线）
    tokens = "".join(d["text"] for e, d in events
                     if e == "token" and d["key"] == "FrontierFormat")
    assert tokens == "❓ Q1"
    # node_end 透传不失真：TreeUpdate ok 帧带文档链接 refs
    assert any(e == "node_end" and d["key"] == "TreeUpdate"
               and d["outcome"] == "ok" and d["refs"] for e, d in events)
    state = events[-1][1]["state"]
    cards = {c["id"]: c for c in state["cards"] if c["docKey"]}
    assert set(cards) == {"doc:tree@3", "doc:glossary@3"}
    assert cards["doc:tree@3"]["title"] == "设计树"
    assert cards["doc:tree@3"]["ownerSeq"] == 3 and cards["doc:tree@3"]["docKey"] == "tree"
    assert cards["doc:glossary@3"]["ownerSeq"] == 3
    assert all(c["pinned"] is False for c in cards.values())  # 节点卡不 pin
    assert next(n for n in state["nodes"] if n["seq"] == 3)["input"] == "做个订单系统"
    # 未显式传 module → 轮上记录留空（complete 时按会话 category 解析，start 帧已验 grilling）
    assert next(n for n in state["nodes"] if n["seq"] == 3)["module"] == ""
    assert next(n for n in state["nodes"] if n["seq"] == 3)["output"] == "❓ Q1"
    assert events[-1][1]["done"] is False


def test_turn_records_explicit_module(api):
    """turn 带 module：轮上记录 + start 帧用该模式（无需改会话 category）。"""
    api.post("/api/sessions", json={"name": "m1", "category": "grilling"})
    events = sse_events(api, "/api/sessions/m1/turn",
                        json={"text": "插一轮直答", "module": "direct"})
    assert events[0][1]["module"] == "direct"
    assert len(events[0][1]["nodes"]) == 1  # direct 单节点（防 start 帧与执行解析分歧）
    state = api.get("/api/sessions/m1").json()
    assert state["category"] == "grilling"  # 会话默认未被 turn 改动
    assert state["nodes"][0]["module"] == "direct"


def test_turn_sse_llm_failure_error_frame_then_retry(api):
    sid = "t"
    api.post("/api/sessions", json={"name": sid})
    api.fake.fail = True
    events = sse_events(api, f"/api/sessions/{sid}/turn", json={"text": "问题"})
    assert events[-1][0] == "error"
    assert "模拟基础设施故障" in events[-1][1]["error"]
    assert events[-1][1]["state"]["unanswered"] == 2  # 悬而未答轮已落盘
    api.fake.fail = False
    api.fake.responses = ["回复"]
    events = sse_events(api, f"/api/sessions/{sid}/retry")
    assert events[-1][0] == "done"
    assert events[-1][1]["state"]["pointer"] == 2


def test_turn_sse_unexpected_error_terminates_stream(api, monkeypatch):
    """意外异常（如落盘 OSError）也必须以 error 帧终结流——前端只等 done|error。"""
    sid = "t"
    api.post("/api/sessions", json={"name": sid})

    def boom(self, text, *, leaf=False, module=""):
        raise OSError("磁盘故障")
    monkeypatch.setattr("treechat.session.TreeChatSession.send", boom)
    events = sse_events(api, f"/api/sessions/{sid}/turn", json={"text": "问题"})
    assert events, "意外异常不应产生空流"
    assert events[-1][0] == "error"
    assert "磁盘故障" in events[-1][1]["error"]  # OSError 消息本身，非签名失配的内部错误


def test_turn_sse_invalid_parent_error_frame(api):
    api.post("/api/sessions", json={"name": "t"})
    events = sse_events(api, "/api/sessions/t/turn", json={"text": "x", "parent": 99})
    assert events[-1][0] == "error"


def test_turn_sse_branch_leaf_and_node_rename(api):
    sid = "t"
    api.post("/api/sessions", json={"name": sid})
    api.fake.responses = ["答一", "答分支", "答叶子"]
    ev = sse_events(api, f"/api/sessions/{sid}/turn", json={"text": "问一"})
    assert ev[-1][1]["state"]["pointer"] == 2
    ev = sse_events(api, f"/api/sessions/{sid}/turn", json={"text": "分支问", "parent": 2})
    st = ev[-1][1]["state"]
    assert st["pointer"] == 4
    assert next(n for n in st["nodes"] if n["seq"] == 4)["parent"] == 2
    ev = sse_events(api, f"/api/sessions/{sid}/turn", json={"text": "叶子问", "leaf": True})
    st = ev[-1][1]["state"]
    assert next(n for n in st["nodes"] if n["seq"] == 6)["parent"] is None
    st = api.post(f"/api/sessions/{sid}/nodes/4/rename", json={"label": "概念澄清"}).json()
    assert next(n for n in st["nodes"] if n["seq"] == 4)["label"] == "概念澄清"
    assert api.post(f"/api/sessions/{sid}/nodes/99/rename", json={"label": "x"}).status_code == 400


def test_turn_sse_leaf_wins_over_parent(api):
    sid = "t"
    api.post("/api/sessions", json={"name": sid})
    api.fake.responses = ["答一", "答叶子"]
    ev = sse_events(api, f"/api/sessions/{sid}/turn", json={"text": "问一"})
    assert ev[-1][1]["state"]["pointer"] == 2
    ev = sse_events(api, f"/api/sessions/{sid}/turn",
                    json={"text": "叶子问", "parent": 2, "leaf": True})
    st = ev[-1][1]["state"]
    assert next(n for n in st["nodes"] if n["seq"] == 4)["parent"] is None


def test_turn_and_retry_unknown_sid_404(api):
    # 未知 sid：流外 HTTP 404（不进 SSE 流）
    assert api.post("/api/sessions/ghost/turn", json={"text": "x"}).status_code == 404
    assert api.post("/api/sessions/ghost/retry").status_code == 404


def test_category_unknown_falls_back_direct(api):
    api.post("/api/sessions", json={"name": "t"})
    api.post("/api/sessions/t/category", json={"category": "工作"})
    api.fake.responses = ["直答"]
    events = sse_events(api, "/api/sessions/t/turn", json={"text": "问"})
    assert events[0][1]["module"] == "direct"


def test_retry_without_dangling_still_409(api):
    api.post("/api/sessions", json={"name": "t"})
    assert api.post("/api/sessions/t/retry").status_code == 409


def test_cards_flow(api):
    sid = "c"
    api.post("/api/sessions", json={"name": sid})
    api.post(f"/api/sessions/{sid}/turn", json={"text": "讨论"})
    st = api.post(f"/api/sessions/{sid}/cards", json={"instruction": "总结"}).json()
    assert len(st["cards"]) == 1 and st["cards"][0]["pinned"] is True
    cid = st["cards"][0]["id"]
    st = api.post(f"/api/sessions/{sid}/cards/{cid}/pin", json={"pinned": False}).json()
    assert st["cards"][0]["pinned"] is False
    # all 模式再提炼一张
    st = api.post(f"/api/sessions/{sid}/cards", json={"mode": "all"}).json()
    assert len(st["cards"]) == 2
    # 非法区间 → 400
    assert api.post(f"/api/sessions/{sid}/cards",
                    json={"mode": "range", "start": 9, "end": 99}).status_code == 400
    # seqs 模式：显式节点列表；空列表 → 400；assistant 事件 seq 已非节点 → 400；未知节点 → 400
    st = api.post(f"/api/sessions/{sid}/cards",
                  json={"mode": "seqs", "seqs": [2]}).json()
    assert len(st["cards"]) == 3
    assert api.post(f"/api/sessions/{sid}/cards",
                    json={"mode": "seqs", "seqs": []}).status_code == 400
    assert api.post(f"/api/sessions/{sid}/cards",
                    json={"mode": "seqs", "seqs": [2, 3]}).status_code == 400
    assert api.post(f"/api/sessions/{sid}/cards",
                    json={"mode": "seqs", "seqs": [2, 99]}).status_code == 400


def test_card_edit_delete_export_import(api):
    sid = "c"
    api.post("/api/sessions", json={"name": sid})
    api.post(f"/api/sessions/{sid}/turn", json={"text": "讨论"})
    st = api.post(f"/api/sessions/{sid}/cards", json={"instruction": "总结"}).json()
    cid = st["cards"][0]["id"]
    # 编辑：整体替换标题/正文，其余字段不动；重放一致（重开由 registry 缓存覆盖不了 → 全量状态即可）
    st = api.patch(f"/api/sessions/{sid}/cards/{cid}",
                   json={"title": "新标题", "body": "新正文"}).json()
    card = st["cards"][0]
    assert (card["title"], card["body"], card["fromPath"]) == ("新标题", "新正文", [2])
    # 导出：markdown 附件
    r = api.get(f"/api/sessions/{sid}/cards/{cid}/export")
    assert r.status_code == 200
    assert r.text.startswith("# 新标题") and "新正文" in r.text
    assert "attachment" in r.headers["content-disposition"]
    # 导入：不经 LLM 直接落卡（fake.complete 若被调用会覆盖同标题 → 用计数确认没走 LLM）
    calls_before = len(api.fake.calls)
    st = api.post(f"/api/sessions/{sid}/cards/import",
                  json={"title": "导入卡", "body": "导入正文", "instruction": "导入"}).json()
    assert len(api.fake.calls) == calls_before
    assert [c["title"] for c in st["cards"]] == ["新标题", "导入卡"]
    assert st["cards"][1]["pinned"] is True and st["cards"][1]["fromPath"] == []
    # 删除 → 全量状态不再含；未知卡片 400
    st = api.delete(f"/api/sessions/{sid}/cards/{cid}").json()
    assert [c["id"] for c in st["cards"]] != [cid]
    assert api.delete(f"/api/sessions/{sid}/cards/{cid}").status_code == 400
    assert api.patch(f"/api/sessions/{sid}/cards/{cid}",
                     json={"title": "t", "body": "b"}).status_code == 400


def test_card_create_with_owner_seq(api):
    api.post("/api/sessions", json={"name": "c1"})
    events = sse_events(api, "/api/sessions/c1/turn", json={"text": "问"})
    seq = events[-1][1]["state"]["pointer"]
    st = api.post("/api/sessions/c1/cards",
                  json={"instruction": "总结", "mode": "seqs", "seqs": [seq],
                        "ownerSeq": seq}).json()
    card = next(c for c in st["cards"] if c["ownerSeq"] == seq)
    assert card["docKey"] == "" and card["pinned"] is False


def test_card_import_with_owner_seq(api):
    api.post("/api/sessions", json={"name": "i1"})
    events = sse_events(api, "/api/sessions/i1/turn", json={"text": "问"})
    seq = events[-1][1]["state"]["pointer"]
    st = api.post("/api/sessions/i1/cards/import",
                  json={"title": "挂节点的卡", "body": "正文", "ownerSeq": seq}).json()
    card = next(c for c in st["cards"] if c["title"] == "挂节点的卡")
    assert card["ownerSeq"] == seq


def test_cards_library_across_sessions(api):
    api.post("/api/sessions", json={"name": "甲"})
    api.post("/api/sessions", json={"name": "乙"})
    api.post("/api/sessions/甲/turn", json={"text": "讨论"})
    api.post("/api/sessions/甲/cards", json={"instruction": "总结"})
    api.post("/api/sessions/乙/cards/import",
             json={"title": "乙卡", "body": "乙正文"})
    lib = api.get("/api/cards").json()
    assert sorted((e["sid"], e["title"]) for e in lib) == \
        sorted([("甲", "卡片标题"), ("乙", "乙卡")])
    by_sid = {e["sid"]: e for e in lib}
    assert by_sid["甲"]["sessionName"] == "甲" and by_sid["甲"]["pinned"] is True
    assert by_sid["乙"]["pinned"] is True
    # 复制导入：把甲的卡片导入乙 → 乙多一张，甲不变（各自独立副本）
    jia = by_sid["甲"]
    st = api.post("/api/sessions/乙/cards/import",
                  json={"title": jia["title"], "body": jia["body"],
                        "instruction": f"导入自「{jia['sessionName']}」"}).json()
    assert [c["title"] for c in st["cards"]] == ["乙卡", "卡片标题"]
    assert st["cards"][1]["id"] != jia["id"]  # 新 id，不建立跨文件引用


def test_pointer_endpoint_navigates_in_memory(api):
    sid = "t"
    api.post("/api/sessions", json={"name": sid})
    api.fake.responses = ["答一", "答二"]
    sse_events(api, f"/api/sessions/{sid}/turn", json={"text": "问一"})
    sse_events(api, f"/api/sessions/{sid}/turn", json={"text": "问二"})
    st = api.post(f"/api/sessions/{sid}/pointer", json={"seq": 2}).json()
    assert st["pointer"] == 2                       # 导航 = 内存挪指针
    assert api.get(f"/api/sessions/{sid}").json()["pointer"] == 2
    assert api.post(f"/api/sessions/{sid}/pointer", json={"seq": 99}).status_code == 400
    st = api.post(f"/api/sessions/{sid}/pointer", json={"seq": None}).json()
    assert st["pointer"] is None


def test_legacy_card_from_path_normalized(tmp_path):
    """旧格式引用（卡片 from_path 指向 assistant 事件 seq）经 legacy 映射归一化为轮 seq。"""
    fake = FakeLLM()
    config = TreeChatConfig(data_dir=tmp_path)
    config.sessions_dir().mkdir(parents=True)
    lines = [
        '{"seq":1,"type":"session_meta","name":"old","created_at":"t","system":""}',
        '{"seq":2,"type":"user_msg","parent":null,"text":"问"}',
        '{"seq":3,"type":"assistant_msg","parent":2,"text":"答","model":"","usage":{}}',
        '{"seq":4,"type":"card_create","card_id":"card_old","title":"T","body":"B",'
        '"from_path":[3],"instruction":"","created_at":"t"}',
    ]
    (config.sessions_dir() / "old.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")
    with TestClient(create_app(config, client_factory=lambda model=None: fake)) as client:
        st = client.get("/api/sessions/old").json()
        assert [n["seq"] for n in st["nodes"]] == [2]      # 重放自动合并为轮
        assert st["nodes"][0]["output"] == "答"
        assert st["cards"][0]["fromPath"] == [2]           # 旧 assistant seq 归一化 → 轮


def test_sid_path_traversal_rejected(api):
    # Starlette 对 %2F 的解码行为不同：可能 400（到达校验）或 404（路由拒绝），绝不 200
    r = api.get("/api/sessions/..%2F..%2Fsecret")
    assert r.status_code in (400, 404)
    assert api.post("/api/sessions", json={"name": "a/b"}).status_code == 400


def test_modes_endpoint(api):
    modes = api.get("/api/modes").json()
    assert [m["key"] for m in modes] == ["direct", "grilling", "ops"]
    assert all(set(m) == {"key", "displayName", "description"} for m in modes)


def test_create_session_with_category(api):
    r = api.post("/api/sessions", json={"name": "g", "category": "grilling"})
    assert r.json()["category"] == "grilling"
    assert api.get("/api/sessions/g").json()["category"] == "grilling"
