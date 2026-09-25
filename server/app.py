# server/app.py
"""FastAPI 入口：CORS（dev SPA 端口）+ 路由挂载 + 错误体展平。"""

from __future__ import annotations

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from server.api import runs
from server.api import manage
from server.api import graph
from server.api import control
from server.api import build
from server.chat import mount_chat
from server.deps import get_base_dir
from server.ws import router as ws_router

app = FastAPI(title="SpecModule Webview", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(HTTPException)
def flatten_http_exception(request: Request, exc: HTTPException) -> JSONResponse:
    """HTTPException(detail=dict) 直接作为响应体（错误契约 {error, ...} 顶层字段）。"""
    return JSONResponse(status_code=exc.status_code, content=exc.detail)


app.include_router(runs.router)
app.include_router(manage.router)
app.include_router(build.router)
app.include_router(graph.router)
app.include_router(control.router)
app.include_router(ws_router)
# TreeChat 对话服务（/treechat/api/*）：引擎已收编为本仓库顶级包，挂载常开
mount_chat(app, get_base_dir())
