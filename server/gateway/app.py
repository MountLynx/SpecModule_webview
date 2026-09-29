"""边缘网关组装：认领页 + 会话门 + 静态托管 + 反代路由分发。

唯一认证原语是「用户名认领」（无密码）：首访输入名字即建档领令牌，浏览器
（HttpOnly Cookie + localStorage 双落）此后免登录。路由按 Cookie 身份在服务端
完成、URL 空间不变——SPA 零改动。WS 走独立端点（BaseHTTPMiddleware 不覆盖
websocket），自行读 Cookie 鉴权。
"""
from __future__ import annotations

import asyncio
import base64
import hmac
import os
import secrets
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from itsdangerous import BadSignature, SignatureExpired, TimestampSigner
from starlette.responses import HTMLResponse, JSONResponse, RedirectResponse
from starlette.staticfiles import StaticFiles
from starlette.websockets import WebSocket

from server.gateway.identity import (
    COOKIE_NAME,
    InvalidNameError,
    NameTakenError,
    Registry,
    TOKEN_TTL,
    UserEntry,
    normalize_name,
    token_matches,
)
from server.gateway.process import BackendManager, BackendStartupError
from server.gateway.proxy import BackendProxy

_API_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]

# %PASSCODE% 占位：GATEWAY_PASSCODE 设了才注入口令输入框（网关内联页，无构建步骤）
_CLAIM_PAGE = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>进入 SpecModule</title>
<style>
body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#0f172a;color:#e2e8f0;margin:0}
.card{background:#1e293b;padding:2rem 2.5rem;border-radius:12px;min-width:320px;box-shadow:0 10px 30px rgba(0,0,0,.4)}
h2{margin:0 0 1.25rem;font-size:1.15rem}
label{display:block;font-size:.85rem;color:#94a3b8}
input{width:100%;box-sizing:border-box;margin:.4rem 0 1rem;padding:.6rem .75rem;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;font-size:1rem}
input:focus{outline:2px solid #38bdf8;border-color:transparent}
button{width:100%;padding:.65rem;border:0;border-radius:8px;background:#38bdf8;color:#0f172a;font-weight:600;font-size:1rem;cursor:pointer}
button:hover{background:#7dd3fc}
.err{color:#f87171;min-height:1.2em;font-size:.85rem;margin:.25rem 0 .75rem}
</style></head>
<body><form class="card" id="f">
<h2>输入你的名字进入</h2>
<label>名字<input name="name" autofocus autocomplete="off" maxlength="32"></label>
%PASSCODE%
<p class="err" id="err"></p>
<button type="submit">进入</button>
</form>
<script>
const f = document.getElementById('f'), err = document.getElementById('err');
async function tryClaim(payload) {
  const r = await fetch('/claim', {method: 'POST',
    headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
  const b = await r.json().catch(() => ({}));
  if (r.ok) {
    localStorage.setItem('wv_name', payload.name.trim());
    localStorage.setItem('wv_token', b.token);
    location.href = '/';
    return true;
  }
  err.textContent = b.error || ('进入失败 (' + r.status + ')');
  return false;
}
f.addEventListener('submit', (e) => {
  e.preventDefault();
  const payload = {name: f.elements['name'].value};
  if (f.elements['passcode']) payload.passcode = f.elements['passcode'].value;
  const n = localStorage.getItem('wv_name'), t = localStorage.getItem('wv_token');
  if (t && n && n === payload.name.trim()) payload.token = t;  // 本机找回通道
  tryClaim(payload);
});
(async () => {  // 已认领过的浏览器：自动进入
  const n = localStorage.getItem('wv_name'), t = localStorage.getItem('wv_token');
  if (n && t) await tryClaim({name: n, token: t});
})();
</script></body></html>"""


def _load_or_create_secret(root: Path) -> str:
    key_path = root / "secret_key"
    if not key_path.exists():
        key_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(secrets.token_hex(32))
    return key_path.read_text(encoding="utf-8").strip()


class GatewayState:
    """网关单例状态：registry + 进程管理器 + 签名器 + 每端口反代缓存。"""

    def __init__(self, root: Path, static_dir: Path | None = None,
                 port_base: int = 8101) -> None:
        self.root = Path(root)
        self.registry = Registry(self.root, port_base=port_base)
        self.manager = BackendManager(self.root)
        self.signer = TimestampSigner(_load_or_create_secret(self.root), salt="wv-session")
        self.passcode = os.environ.get("GATEWAY_PASSCODE", "").strip()
        self.secure_cookies = os.environ.get("GATEWAY_SECURE_COOKIES", "").lower() == "on"
        self._proxies: dict[int, BackendProxy] = {}

    def proxy_for(self, entry: UserEntry) -> BackendProxy:
        if entry.port not in self._proxies:
            self._proxies[entry.port] = BackendProxy(entry.port)
        return self._proxies[entry.port]

    def make_cookie(self, name: str, token: str) -> str:
        # itsdangerous 2.2 对非 ASCII 输入返回原始 UTF-8 字节（Cookie latin-1 装不下）——
        # 载荷先 base64-url 编码，签名全程纯 ASCII
        payload = base64.urlsafe_b64encode(f"{name}:{token}".encode("utf-8")).decode("ascii")
        signed = self.signer.sign(payload)
        return signed.decode("ascii") if isinstance(signed, bytes) else signed

    def read_identity(self, cookies: dict) -> UserEntry | None:
        """Cookie → (registry 校验通过的用户)；缺失/过期/令牌不符 → None。"""
        raw = cookies.get(COOKIE_NAME)
        if not raw:
            return None
        try:
            payload = self.signer.unsign(raw, max_age=TOKEN_TTL)
            if isinstance(payload, bytes):
                payload = payload.decode("ascii")
            name, _, token = base64.urlsafe_b64decode(payload).decode("utf-8").partition(":")
        except (BadSignature, SignatureExpired, ValueError, UnicodeError):
            return None
        entry = self.registry.get(name)
        if entry is None or not token_matches(entry, token):
            return None
        return entry


def build_gateway_app(root: Path, static_dir: Path | None = None,
                      port_base: int = 8101) -> FastAPI:
    state_holder: dict[str, GatewayState] = {}

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        yield
        # 关闭语义（spec）：网关退出 → 逐后端进程组终止（后端 + 其 run 子进程一起走）；
        # kill -9 等钩子不跑的场景见 deploy/README.md 孤儿处理
        state_holder["gateway"].manager.shutdown_all()

    app = FastAPI(title="SpecModule Gateway", docs_url=None, redoc_url=None,
                  openapi_url=None, lifespan=lifespan)
    state = GatewayState(root, static_dir, port_base)
    state_holder["gateway"] = state
    app.state.gateway = state

    @app.middleware("http")
    async def auth_gate(request: Request, call_next):
        path = request.url.path
        if path in ("/claim", "/_gateway/health"):
            return await call_next(request)
        entry = state.read_identity(request.cookies)
        if entry is None:
            if path.startswith("/api") or path.startswith("/treechat"):
                return JSONResponse({"error": "未认领身份，请先输入名字"}, status_code=401)
            return RedirectResponse("/claim", status_code=307)
        request.state.entry = entry
        return await call_next(request)

    @app.get("/_gateway/health")
    def gateway_health() -> dict:
        return {"ok": True}

    @app.get("/claim")
    def claim_page() -> HTMLResponse:
        if state.passcode:
            page = _CLAIM_PAGE.replace(
                "%PASSCODE%",
                '<label>访问口令<input name="passcode" type="password" autocomplete="off"></label>')
        else:
            page = _CLAIM_PAGE.replace("%PASSCODE%", "")
        return HTMLResponse(page)

    @app.post("/claim")
    async def claim(request: Request) -> JSONResponse:
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "请求体需为 JSON"}, status_code=400)
        if state.passcode and not hmac.compare_digest(
                str(body.get("passcode", "")), state.passcode):
            return JSONResponse({"error": "访问口令不正确"}, status_code=401)
        try:
            norm = normalize_name(str(body.get("name", "")))
        except InvalidNameError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        try:
            entry, token = state.registry.claim(
                norm, body.get("token"), display=str(body.get("name", "")))
        except NameTakenError as exc:
            return JSONResponse({"error": str(exc)}, status_code=409)
        resp = JSONResponse({"ok": True, "display": entry.display, "token": token})
        resp.set_cookie(COOKIE_NAME, state.make_cookie(norm, token), max_age=TOKEN_TTL,
                        httponly=True, samesite="lax", secure=state.secure_cookies,
                        path="/")
        return resp

    # 登出端点刻意不设：认领页 JS 会用 localStorage 令牌自动重认领，登出形同虚设；
    # 换用户 = 换名字（新空间）或部署者 cli remove

    async def _forward(request: Request):
        entry: UserEntry = request.state.entry
        try:
            # to_thread：spawn + 就绪探测最长 15s，不能冻结事件循环
            # （比赛开局多评委同时首启，SSE/WS 泵必须继续流动）
            await asyncio.to_thread(state.manager.ensure_running,
                                    entry, state.registry.user_dir(entry))
        except BackendStartupError as exc:
            return JSONResponse({"error": str(exc)}, status_code=502)
        except OSError as exc:  # 日志/spawn 层失败同样按网关侧 502 语义
            return JSONResponse({"error": f"后端启动失败: {exc}"}, status_code=502)
        return await state.proxy_for(entry).forward(request)

    @app.api_route("/api/{rest:path}", methods=_API_METHODS)
    async def proxy_api(request: Request, rest: str):
        return await _forward(request)

    @app.api_route("/treechat/{rest:path}", methods=_API_METHODS)
    async def proxy_treechat(request: Request, rest: str):
        return await _forward(request)

    @app.websocket("/api/runs/{run_id}/stream")
    async def ws_bridge(websocket: WebSocket, run_id: str) -> None:
        entry = state.read_identity(websocket.cookies)
        if entry is None:
            await websocket.close(code=4401)
            return
        try:
            await asyncio.to_thread(state.manager.ensure_running,
                                    entry, state.registry.user_dir(entry))
        except (BackendStartupError, OSError):
            await websocket.close(code=1011)
            return
        await state.proxy_for(entry).bridge_ws(websocket, entry.port)

    if static_dir is not None and Path(static_dir).is_dir():
        app.mount("/", StaticFiles(directory=static_dir, html=True), name="spa")
    return app
