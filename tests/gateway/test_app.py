"""网关组装：认领流 / 会话门（401 vs 307）/ 静态托管 / 反代分发。

后端管理器与反代目标打桩——不 spawn 子进程、不发真 HTTP；
真 spawn 端到端在 test_integration.py。
"""

from __future__ import annotations

import httpx
import pytest
from starlette.applications import Starlette
from starlette.routing import Route
from starlette.testclient import TestClient

from server.gateway.app import build_gateway_app
from server.gateway.identity import COOKIE_NAME


class FakeManager:
    """不 spawn：直接回登记端口。"""

    def __init__(self):
        self.calls: list[str] = []

    def ensure_running(self, entry, user_dir):
        self.calls.append(entry.name)
        return entry.port

    def shutdown_all(self):
        pass


def _fake_backend():
    """进程内假后端（ASGITransport 真流式语义）。"""
    async def api(request):
        from starlette.responses import JSONResponse as J
        return J({"runs": [], "total": 0, "path": request.url.path})

    return Starlette(routes=[Route("/api/{rest:path}", api, methods=["GET", "POST"])])


@pytest.fixture
def gateway(gw_root, monkeypatch):
    app = build_gateway_app(gw_root, static_dir=None, port_base=9101)
    state = app.state.gateway
    fake = FakeManager()
    monkeypatch.setattr(state, "manager", fake)

    def proxy_for(entry):
        from server.gateway.proxy import BackendProxy
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=_fake_backend()),
                                   base_url="http://backend")
        return BackendProxy(entry.port, client=client)

    monkeypatch.setattr(state, "proxy_for", proxy_for)
    return app, state, fake


def _client(app) -> TestClient:
    return TestClient(app, follow_redirects=False)


class TestClaim:
    def test_claim_new_sets_cookie(self, gateway):
        app, state, _ = gateway
        c = _client(app)
        r = c.post("/claim", json={"name": "评委甲"})
        assert r.status_code == 200
        body = r.json()
        assert body["ok"] is True and body["display"] == "评委甲"
        assert len(body["token"]) >= 32
        assert COOKIE_NAME in c.cookies

    def test_claim_rejects_bad_name(self, gateway):
        app, _, _ = gateway
        r = _client(app).post("/claim", json={"name": "x"})
        assert r.status_code == 400

    def test_claim_name_taken(self, gateway):
        app, state, _ = gateway
        c = _client(app)
        first = c.post("/claim", json={"name": "tester"}).json()
        r = c.post("/claim", json={"name": "tester"})
        assert r.status_code == 409
        # 令牌匹配 → 找回（localStorage 通道）
        r = c.post("/claim", json={"name": "tester", "token": first["token"]})
        assert r.status_code == 200

    def test_passcode_gate(self, gw_root, monkeypatch):
        monkeypatch.setenv("GATEWAY_PASSCODE", "contest2026")
        app = build_gateway_app(gw_root, static_dir=None)
        c = TestClient(app)
        assert c.post("/claim", json={"name": "tester"}).status_code == 401
        assert c.post("/claim", json={"name": "tester", "passcode": "wrong"}).status_code == 401
        assert c.post("/claim", json={"name": "tester", "passcode": "contest2026"}).status_code == 200


class TestAuthGate:
    def test_unauthed_api_401(self, gateway):
        app, _, _ = gateway
        r = _client(app).get("/api/runs")
        assert r.status_code == 401
        r = _client(app).get("/treechat/api/modes")
        assert r.status_code == 401

    def test_unauthed_page_redirects_claim(self, gateway):
        app, _, _ = gateway
        r = _client(app).get("/")
        assert r.status_code == 307
        assert r.headers["location"] == "/claim"

    def test_authed_api_proxies(self, gateway):
        app, state, fake = gateway
        c = _client(app)
        c.post("/claim", json={"name": "tester"})
        r = c.get("/api/runs")
        assert r.status_code == 200
        assert r.json() == {"runs": [], "total": 0, "path": "/api/runs"}
        assert fake.calls == ["tester"]  # ensure_running 被走过

    def test_logout_clears(self, gateway):
        app, _, _ = gateway
        c = _client(app)
        c.post("/claim", json={"name": "tester"})
        c.post("/logout")
        assert _client(app).get("/api/runs").status_code == 401  # 新会话无凭据


class TestStatic:
    def test_serves_dist_after_auth(self, gw_root):
        dist = gw_root / "dist"
        dist.mkdir()
        (dist / "index.html").write_text("<html>spa</html>", encoding="utf-8")
        app = build_gateway_app(gw_root, static_dir=dist)
        c = TestClient(app, follow_redirects=False)
        assert c.get("/").status_code == 307  # 未认领 → 认领页
        c.post("/claim", json={"name": "tester"})
        r = c.get("/")
        assert r.status_code == 200 and "spa" in r.text
