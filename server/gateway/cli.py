"""网关用户登记 CLI：list / remove（无发放——登记由认领动态生长）。"""
from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

from server.gateway.identity import Registry, normalize_name


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="SpecModule 网关用户登记")
    ap.add_argument("--root", default=os.environ.get("GATEWAY_ROOT", "gateway-data"))
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    p_rm = sub.add_parser("remove")
    p_rm.add_argument("name")
    p_rm.add_argument("--purge", action="store_true",
                      help="连同数据目录一起删除（破坏性，默认仅移出登记）")
    args = ap.parse_args(argv)
    registry = Registry(Path(args.root).resolve())
    if args.cmd == "list":
        users = sorted(registry.all(), key=lambda u: u.created_at)
        if not users:
            print("（空——尚无人认领）")
        for u in users:
            stamp = time.strftime("%Y-%m-%d %H:%M", time.localtime(u.created_at))
            print(f"{u.display}\tport={u.port}\tdir={u.dir}\t{stamp}")
        return 0
    name = normalize_name(args.name)
    if registry.remove(name, purge=args.purge):
        print(f"已移除 {name}" + ("（含数据目录）" if args.purge else "（数据目录保留，--purge 可删）"))
    else:
        print(f"无此用户: {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
