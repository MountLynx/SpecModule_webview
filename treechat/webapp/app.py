"""TreeChat WebUI 服务 —— FastAPI 应用工厂（轮次 SSE 流式；其余 REST；静态托管 webui/dist）。

约定：除枚举/健康检查外，所有变更接口返回变更后的完整会话状态（ConvState），
会话规模小，全量最简单且无客户端同步 bug。节点 = 轮次（一问一答）。轮次
（/turn、/retry）为 text/event-stream：start → (node_start | (token | thinking)*
| node_end)* → done | error；LLM 失败发 error 帧——轮已落盘（悬而未答），
前端展示错误条并可 /retry。
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from ..config import TreeChatConfig
from ..core.errors import TreeChatError
from ..llm_bridge import LLMError
from ..modules import BUILT_IN
from ..session import card_markdown, list_library_cards, list_sessions
from .registry import LLMErrorUnconfigured, SessionRegistry, session_path


# ── 请求体 ──

class CreateBody(BaseModel):
    name: str
    system: str = ""
    category: str = ""
    """模式 key（spec §4）；空 = 直答。"""


class NameBody(BaseModel):
    name: str


class CategoryBody(BaseModel):
    category: str


class ArchiveBody(BaseModel):
    archived: bool


class LabelBody(BaseModel):
    label: str


class PointerBody(BaseModel):
    seq: int | None
    """导航目标轮 seq（内存 set_pointer，不落事件）；null = 清指针。"""


class TurnBody(BaseModel):
    text: str
    parent: int | None = None
    """显式分支目标（历史节点 seq）；缺省 = 当前指针。"""
    leaf: bool = False
    """无上下文叶子提问（优先于 parent）。"""
    module: str = ""
    """本轮使用的模式 key；空 = 会话 category。"""


class CardBody(BaseModel):
    instruction: str = "总结为卡片"
    mode: Literal["branch", "all", "range", "seqs"] = "branch"
    start: int | None = None
    end: int | None = None
    seqs: list[int] = []
    """seqs 模式的显式节点列表（树图选点提炼；空列表 → 400）。"""
    ownerSeq: int | None = None
    """提炼结果挂到该轮 = 节点卡；None = 全局卡。"""


class PinBody(BaseModel):
    pinned: bool


class CardEditBody(BaseModel):
    title: str
    body: str


class CardImportBody(BaseModel):
    title: str
    body: str
    instruction: str = ""
    ownerSeq: int | None = None
    """同 CardBody.ownerSeq：挂到该轮 = 节点卡；None = 全局卡。"""


# ── 序列化 ──

def _state(sid: str, s: Any) -> dict[str, Any]:
    """TreeChatSession → ConvState dict（全量会话状态；节点 = 轮次）。"""
    conv = s.conversation
    return {
        "sid": sid,
        "name": conv.name,
        "system": conv.system,
        "category": conv.category,
        "archived": conv.archived,
        "pointer": conv.pointer,
        "trunkEnd": conv.trunk_end(),
        "unanswered": conv.unanswered(),
        "nodes": [
            {"seq": n.seq, "parent": n.parent, "input": n.input,
             "output": n.output, "label": n.label, "model": n.model,
             "module": n.module}
            for n in conv.nodes.values()
        ],
        "cards": [
            {"id": c.id, "title": c.title, "body": c.body,
             "fromPath": [conv.legacy.get(seq, seq) for seq in c.from_path],
             "instruction": c.instruction, "createdAt": c.created_at,
             "ownerSeq": c.owner_seq, "docKey": c.doc_key,
             "pinned": conv.cards.is_pinned(c.id)}
            for c in conv.cards.all_cards()
        ],
    }


def _summary_dict(m) -> dict[str, Any]:
    return {
        "sid": m.sid, "name": m.name, "category": m.category,
        "archived": m.archived, "nodeCount": m.node_count,
        "createdAt": m.created_at, "mtimeMs": int(m.mtime * 1000),
    }


# ── 应用工厂 ──

def create_app(config: TreeChatConfig | None = None, *,
               client_factory: Any = None,
               static_dir: Path | None = None,
               tool_context: Any = None) -> FastAPI:
    config = config or TreeChatConfig()
    registry = SessionRegistry(config, client_factory, tool_context=tool_context)
    app = FastAPI(title="TreeChat WebUI", docs_url=None, redoc_url=None)
    app.state.registry = registry
    app.state.llm_probed = False
    app.state.llm_configured = False
    _bg_tasks: set[asyncio.Task] = set()  # 后台回合任务强引用（防 fire-and-forget 被 GC）

    def _open(sid: str):
        try:
            return registry.get(sid)
        except TreeChatError as exc:
            raise HTTPException(404, str(exc)) from exc

    async def _run(sid: str, work) -> dict[str, Any]:
        """加会话锁执行异步操作，返回全量状态。"""
        async with registry.lock(sid):
            s = _open(sid)
            try:
                await work(s)
            except (LLMError, LLMErrorUnconfigured) as exc:
                return JSONResponse(status_code=502,
                                    content={"error": str(exc), "state": _state(sid, s)})
            except TreeChatError as exc:
                raise HTTPException(400, str(exc)) from exc
            return _state(sid, s)

    # ── 健康 / 枚举 ──

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        if not app.state.llm_probed:
            try:
                registry._client_factory(None)
                app.state.llm_configured = True
            except Exception:  # noqa: BLE001 —— 探测只回答"配置链是否可用"
                app.state.llm_configured = False
            app.state.llm_probed = True
        return {"ok": True, "llmConfigured": app.state.llm_configured,
                "dataDir": str(config.data_dir)}

    @app.get("/api/modes")
    def modes() -> list[dict[str, str]]:
        """对话模式清单（会话创建选择器 / 设置只读展示共用）。"""
        return [{"key": m.key, "displayName": m.display_name,
                 "description": m.description} for m in BUILT_IN.values()]

    @app.get("/api/sessions")
    def sessions() -> list[dict[str, Any]]:
        out = [_summary_dict(m) for m in list_sessions(config)]
        out.sort(key=lambda x: x["mtimeMs"], reverse=True)
        return out

    @app.post("/api/sessions")
    def sessions_create(body: CreateBody) -> dict[str, Any]:
        try:
            s = registry.create(body.name, body.name, body.system)
        except FileExistsError as exc:
            raise HTTPException(409, str(exc)) from exc
        except TreeChatError as exc:
            raise HTTPException(400, str(exc)) from exc
        if body.category:
            s.conversation.set_category(body.category)
        return {
            "sid": body.name, "name": s.conversation.name,
            "category": s.conversation.category, "archived": False,
            "nodeCount": 0, "createdAt": "", "mtimeMs": 0,
        }

    @app.get("/api/sessions/{sid}")
    async def session_state(sid: str) -> dict[str, Any]:
        s = _open(sid)
        return _state(sid, s)

    @app.delete("/api/sessions/{sid}")
    async def session_delete(sid: str) -> Response:
        try:
            path = session_path(config, sid)
        except TreeChatError as exc:
            raise HTTPException(400, str(exc)) from exc
        # 同会话轮次/卡片提炼持同一把 registry 锁；等它跑完再删，
        # 避免追加写在 unlink 之后重新创建只带后续事件的幽灵文件。
        async with registry.lock(sid):
            if not path.exists():
                registry.drop(sid)
                raise HTTPException(404, f"会话不存在: {sid}")
            path.unlink()
            Path(str(path) + ".lock").unlink(missing_ok=True)  # SessionStore 锁文件随会话清理
            registry.drop(sid)
        return Response(status_code=204)

    # ── 会话管理 ──

    @app.post("/api/sessions/{sid}/rename")
    async def rename(sid: str, body: NameBody) -> dict[str, Any]:
        async with registry.lock(sid):
            s = _open(sid)
            try:
                s.conversation.rename(body.name)
            except TreeChatError as exc:
                raise HTTPException(400, str(exc)) from exc
            return _state(sid, s)

    @app.post("/api/sessions/{sid}/category")
    async def category(sid: str, body: CategoryBody) -> dict[str, Any]:
        async with registry.lock(sid):
            s = _open(sid)
            s.conversation.set_category(body.category)
            return _state(sid, s)

    @app.post("/api/sessions/{sid}/archive")
    async def archive(sid: str, body: ArchiveBody) -> dict[str, Any]:
        async with registry.lock(sid):
            s = _open(sid)
            s.conversation.set_archived(body.archived)
            return _state(sid, s)

    @app.post("/api/sessions/{sid}/nodes/{seq}/rename")
    async def node_rename(sid: str, seq: int, body: LabelBody) -> dict[str, Any]:
        async with registry.lock(sid):
            s = _open(sid)
            try:
                s.conversation.rename_node(seq, body.label)
            except TreeChatError as exc:
                raise HTTPException(400, str(exc)) from exc
            return _state(sid, s)

    @app.post("/api/sessions/{sid}/pointer")
    async def pointer(sid: str, body: PointerBody) -> dict[str, Any]:
        """导航 = 内存 set_pointer（不落事件）；树图点选跳转的落点。"""
        async with registry.lock(sid):
            s = _open(sid)
            try:
                s.conversation.set_pointer(body.seq)
            except TreeChatError as exc:
                raise HTTPException(400, str(exc)) from exc
            return _state(sid, s)

    # ── 轮次 ──

    def _sse(event: str, data: dict[str, Any]) -> str:
        return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

    def _turn_stream(sid: str, body: TurnBody | None):
        """回合 SSE 流（POST /turn、/retry 共用）：work 任务持锁跑回合，事件经队列转帧。

        客户端断开：work 不取消，继续跑完落盘（spec §6）——流中事件自然丢弃，
        重连后 GET state 对账。不做断线重放。
        """

        async def gen():
            queue: asyncio.Queue[str] = asyncio.Queue()

            async def work() -> None:
                async with registry.lock(sid):
                    try:
                        s = registry.get(sid)
                        if body is None:  # retry：悬而未答轮（端点已预检 409）
                            seq = s.conversation.unanswered()
                            if seq is None:  # 预检后竞态：轮次已被回答
                                raise TreeChatError("没有待重试的轮次")
                        else:
                            if body.leaf:
                                seq = s.send(body.text, leaf=True,
                                             module=body.module)
                            else:
                                if body.parent is not None:
                                    s.conversation.set_pointer(body.parent)
                                seq = s.send(body.text, module=body.module)
                        module = s.module_for(seq)
                        queue.put_nowait(_sse("start", {
                            "userSeq": seq, "module": module.key,
                            "nodes": [{"key": k, "label": module.node_label(k)}
                                      for k in module.node_order]}))

                        def on_event(evt: dict) -> None:
                            queue.put_nowait(_sse(evt.pop("event"), evt))

                        _, outcome = await s.complete_outcome(seq, on_event=on_event)
                        queue.put_nowait(_sse("done", {"state": _state(sid, s),
                                                       "done": outcome.done}))
                    except (LLMError, LLMErrorUnconfigured) as exc:
                        try:
                            state = _state(sid, registry.get(sid))
                        except TreeChatError:
                            state = None
                        queue.put_nowait(_sse("error", {"error": str(exc), "state": state}))
                    except TreeChatError as exc:
                        queue.put_nowait(_sse("error", {"error": str(exc), "state": None}))
                    except Exception as exc:  # 意外错误也必须终结流
                        queue.put_nowait(_sse("error", {"error": f"内部错误: {exc}", "state": None}))
                    finally:
                        queue.put_nowait("")

            task = asyncio.create_task(work())
            _bg_tasks.add(task)
            task.add_done_callback(_bg_tasks.discard)
            while True:
                frame = await queue.get()
                if frame == "":
                    break
                yield frame
                if frame.startswith("event: done") or frame.startswith("event: error"):
                    break

        return gen()

    @app.post("/api/sessions/{sid}/turn")
    async def turn(sid: str, body: TurnBody):
        _open(sid)  # 未知 sid → 404（流外 HTTP 错误）
        return StreamingResponse(_turn_stream(sid, body),
                                 media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache"})

    @app.post("/api/sessions/{sid}/retry")
    async def retry(sid: str):
        s0 = _open(sid)
        if s0.conversation.unanswered() is None:
            raise HTTPException(409, "没有待重试的轮次")
        return StreamingResponse(_turn_stream(sid, None),
                                 media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache"})

    # ── 卡片 ──

    @app.post("/api/sessions/{sid}/cards")
    async def cards_create(sid: str, body: CardBody):
        async def work(s) -> None:
            conv = s.conversation
            if body.mode == "all":
                if conv.pointer is None:
                    raise TreeChatError("空会话没有可提炼范围")
                seqs = [n.seq for n in conv.path_to(conv.pointer)]
            elif body.mode == "range":
                if body.start is None or body.end is None or body.start > body.end:
                    raise TreeChatError("区间模式需要 start ≤ end")
                seqs = list(range(body.start, body.end + 1))
            elif body.mode == "seqs":
                if not body.seqs:
                    raise TreeChatError("seqs 模式需要非空节点列表")
                seqs = body.seqs
            else:
                seqs = None  # 默认当前分支段
            await s.make_card(body.instruction, from_seqs=seqs,
                              owner_seq=body.ownerSeq)
        return await _run(sid, work)

    @app.post("/api/sessions/{sid}/cards/import")
    async def cards_import(sid: str, body: CardImportBody) -> dict[str, Any]:
        """导入卡片 = 直接落 card_create（不经 LLM；跨会话卡库的复制导入语义）。"""
        async with registry.lock(sid):
            s = _open(sid)
            try:
                s.conversation.add_card(body.title, body.body,
                                        from_path=[], instruction=body.instruction,
                                        owner_seq=body.ownerSeq)
            except TreeChatError as exc:
                raise HTTPException(400, str(exc)) from exc
            return _state(sid, s)

    @app.patch("/api/sessions/{sid}/cards/{cid}")
    async def card_edit(sid: str, cid: str, body: CardEditBody) -> dict[str, Any]:
        async with registry.lock(sid):
            s = _open(sid)
            try:
                s.conversation.edit_card(cid, body.title, body.body)
            except TreeChatError as exc:
                raise HTTPException(400, str(exc)) from exc
            return _state(sid, s)

    @app.delete("/api/sessions/{sid}/cards/{cid}")
    async def card_delete(sid: str, cid: str) -> dict[str, Any]:
        async with registry.lock(sid):
            s = _open(sid)
            try:
                s.conversation.delete_card(cid)
            except TreeChatError as exc:
                raise HTTPException(400, str(exc)) from exc
            return _state(sid, s)

    @app.get("/api/sessions/{sid}/cards/{cid}/export")
    async def card_export(sid: str, cid: str):
        s = _open(sid)
        try:
            card = s.conversation.cards.get(cid)
        except TreeChatError as exc:
            raise HTTPException(400, str(exc)) from exc
        return Response(
            content=card_markdown(card), media_type="text/markdown; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{cid}.md"'},
        )

    @app.get("/api/cards")
    def cards_library() -> list[dict[str, Any]]:
        """跨会话卡库（只读枚举；复制导入语义，不建立跨文件引用）。"""
        out = []
        for e in list_library_cards(config):
            c = e.card
            out.append({
                "sid": e.sid, "sessionName": e.session_name,
                "id": c.id, "title": c.title, "body": c.body,
                "fromPath": list(c.from_path), "instruction": c.instruction,
                "createdAt": c.created_at, "pinned": e.pinned,
            })
        return out

    @app.post("/api/sessions/{sid}/cards/{cid}/pin")
    async def card_pin(sid: str, cid: str, body: PinBody) -> dict[str, Any]:
        async with registry.lock(sid):
            s = _open(sid)
            try:
                (s.conversation.pin if body.pinned else s.conversation.unpin)(cid)
            except TreeChatError as exc:
                raise HTTPException(400, str(exc)) from exc
            return _state(sid, s)

    # ── 静态前端（构建产物存在才挂载；放最后避免遮蔽 /api）──

    dist = static_dir or (Path(__file__).resolve().parents[2] / "webui" / "dist")
    if dist.exists():
        app.mount("/", StaticFiles(directory=dist, html=True), name="static")

    @app.exception_handler(HTTPException)
    async def http_exc_handler(request: Request, exc: HTTPException):
        return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})

    return app


def run_server(config: TreeChatConfig | None = None, *,
               host: str = "127.0.0.1", port: int = 8700) -> int:
    """启动 WebUI（CLI `treechat webui` 入口）。"""
    try:
        import uvicorn
    except ImportError:
        print("需要安装 webui 依赖: pip install -e \".[webui]\"")
        return 1
    dist = Path(__file__).resolve().parents[2] / "webui" / "dist"
    if not dist.exists():
        print(f"提示: 前端未构建（{dist} 不存在），仅提供 API。"
              "构建见 webui/README.md")
    uvicorn.run(create_app(config), host=host, port=port, log_level="warning")
    return 0
