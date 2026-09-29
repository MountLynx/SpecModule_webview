"""python -m server.gateway 启动边缘网关。

--root 部署根（缺省 ./gateway-data 或 GATEWAY_ROOT）；--static 静态目录
（缺省 web/dist 或 GATEWAY_STATIC，目录缺席则不挂——dev 走 vite 直连不受影响）；
--port-base 用户端口起点（缺省 8101 或 GATEWAY_PORT_BASE）。
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path

import uvicorn

from server.gateway.app import build_gateway_app


def main() -> None:
    ap = argparse.ArgumentParser(description="SpecModule 边缘网关（每用户进程 + 认领反代）")
    ap.add_argument("--root", default=os.environ.get("GATEWAY_ROOT", "gateway-data"))
    ap.add_argument("--static", default=os.environ.get("GATEWAY_STATIC", "web/dist"))
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--port-base", type=int,
                    default=int(os.environ.get("GATEWAY_PORT_BASE", "8101")))
    args = ap.parse_args()
    root = Path(args.root).resolve()
    static = Path(args.static).resolve()
    app = build_gateway_app(root, static_dir=static if static.is_dir() else None,
                            port_base=args.port_base)
    print(f"gateway: root={root} static={'on' if static.is_dir() else 'off'} "
          f"port={args.port} port_base={args.port_base}")
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
