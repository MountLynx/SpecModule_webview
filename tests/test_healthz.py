"""GET /healthz：每用户后端就绪探针契约（网关 spawn 后轮询此端点）。"""

from __future__ import annotations


def test_healthz(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"ok": True}
