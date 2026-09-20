"""REPL 主循环（stdlib）+ 非交互入口。

asyncio 单循环贯穿 REPL 生命周期（客户端 httpx 绑定 loop，不能每轮
asyncio.run）；input 用 to_thread 避免阻塞 loop。
"""
from __future__ import annotations

import argparse
import asyncio
from typing import Awaitable, Callable


from .commands import handle_command
from ..llm_bridge import LLMError
from ..config import TreeChatConfig
from ..core.errors import TreeChatError
from ..session import TreeChatSession

Say = Callable[[str], None]
InputFn = Callable[[str], Awaitable[str]]


def _reply_line(seq: int | None, text: str) -> str:
    return f"[#{seq}] {text}" if seq is not None else text


async def _repl_async(session: TreeChatSession, config: TreeChatConfig, *,
                      input_fn: InputFn, say: Say) -> int:
    conv = session.conversation
    say(f"treechat · {conv.name} · /help 查看命令")
    state: dict = {"leaf_next": False}
    while True:
        try:
            line = (await input_fn("› ")).strip()
        except (EOFError, KeyboardInterrupt):
            say("")
            return 0
        if not line:
            continue
        try:
            if line.startswith("/"):
                if await handle_command(session, config, line, state=state, say=say):
                    return 0
            else:
                seq = session.send(line, leaf=state["leaf_next"])
                state["leaf_next"] = False
                say("…")
                await session.complete(seq)
                node = conv.nodes[conv.pointer]
                say(_reply_line(node.seq, node.output))
        except LLMError as exc:
            dangling = conv.unanswered()
            say(f"LLM 调用失败：{exc}"
                + (f"\n轮次 #{dangling} 悬而未答；/retry 重试" if dangling else ""))
        except TreeChatError as exc:
            say(f"错误：{exc}")


async def _stdin_line(prompt: str) -> str:
    return await asyncio.to_thread(input, prompt)


def run_repl(session: TreeChatSession, config: TreeChatConfig, *,
             input_fn: InputFn | None = None, say: Say | None = None) -> int:
    """REPL 主循环。input_fn/say 可注入（测试/嵌入方）。"""
    return asyncio.run(_repl_async(
        session, config,
        input_fn=input_fn or _stdin_line,
        say=say or print,
    ))


def main(argv: list[str] | None = None, config: TreeChatConfig | None = None,
         input_fn: InputFn | None = None) -> int:
    parser = argparse.ArgumentParser(prog="treechat", description="对话树对话引擎")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_new = sub.add_parser("new", help="新建会话并进入 REPL")
    p_new.add_argument("name")
    p_new.add_argument("--system", default="")
    p_open = sub.add_parser("open", help="打开会话进入 REPL")
    p_open.add_argument("name")
    sub.add_parser("list", help="列出会话")
    p_web = sub.add_parser("webui", help="启动 WebUI 服务（需 webui 依赖组）")
    p_web.add_argument("--host", default="127.0.0.1")
    p_web.add_argument("--port", type=int, default=8700)
    args = parser.parse_args(argv)
    config = config or TreeChatConfig()

    if args.cmd == "webui":
        from ..webapp.app import run_server  # 懒 import：无 fastapi 不影响 CLI 其余命令
        return run_server(config, host=args.host, port=args.port)

    if args.cmd == "list":
        from ..session import list_sessions
        for m in list_sessions(config):
            mark = " [归档]" if m.archived else ""
            cat = f" ({m.category})" if m.category else ""
            print(f"{m.name}{cat}{mark}\t{m.sid}\t{m.created_at}\t{m.node_count} 节点")
        return 0

    path = config.sessions_dir() / f"{args.name}.jsonl"
    if args.cmd == "new":
        if path.exists():
            print(f"会话已存在: {args.name}")
            return 1
        session = TreeChatSession.create(path, args.name, args.system,
                                         mode_modules=config.mode_modules)
    else:
        session = TreeChatSession.open(path, mode_modules=config.mode_modules)
    return run_repl(session, config, input_fn=input_fn)
