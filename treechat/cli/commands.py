"""斜杠命令路由。返回 True 表示退出 REPL。

state（REPL 会话态，repl 层持有）：{"leaf_next": bool}；/retry 目标由
`conv.unanswered_user()` 视图给出（跨 REPL 打开仍然有效）。
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Callable


from .. import llm_bridge
from ..config import TreeChatConfig
from ..core.errors import TreeChatError
from ..llm_bridge import LLMError
from ..session import TreeChatSession

Say = Callable[[str], None]

_HELP = """\
命令：
  /tree                 树视图（* 指针 ◆ 主干末端 [卡片]）
  /branch <seq>         指针挪到历史节点 → 下一条输入长新枝
  /trunk                指针跳回主干末端
  /leaf                 下一条输入 = 无上下文叶子提问
  /retry                对最后一个悬而未答节点重新调 LLM
  /card [all|<a>-<b>|指令]   提炼卡片（默认当前分支段）
  /cards；/card show <id>；/card edit <id> [新标题]；/card delete <id>
  /pin /unpin <id>；/card export <id> <file>
  /where                当前位置
  /system [新指令]       查看/修改会话级 system
  /model [名]           查看/切换模型
  /help；/quit
"""

_RANGE_RE = re.compile(r"^(\d+)-(\d+)$")


def _reply_line_of(seq: int, text: str) -> str:
    return f"[#{seq}] {text}"


async def _card_command(session: TreeChatSession, rest: str, say: Say) -> None:
    """/card 子命令：show / edit / delete / export / all / <a>-<b> / 默认当前分支段。"""
    conv = session.conversation
    tokens = rest.split(maxsplit=1)
    head = tokens[0] if tokens else ""
    tail = tokens[1].strip() if len(tokens) > 1 else ""
    if head == "show" and tail:
        card = conv.cards.get(tail)
        say(f"[{card.id}] {card.title}\n{card.body}")
        return
    if head == "edit" and tail:
        sub = tail.split(maxsplit=1)
        cid = sub[0]
        if len(sub) < 2:
            card = conv.cards.get(cid)  # 省略新标题 = 查看（正文多行编辑在 WebUI）
            say(f"[{card.id}] {card.title}\n{card.body}\n（改标题: /card edit {cid} <新标题>）")
            return
        card = conv.cards.get(cid)
        conv.edit_card(cid, sub[1], card.body)
        say(f"卡片已改名: [{cid}] {sub[1]}")
        return
    if head == "delete" and tail:
        card = conv.cards.get(tail)
        conv.delete_card(tail)
        say(f"卡片已删除: [{tail}] {card.title}")
        return
    if head == "export" and tail:
        sub = tail.split(maxsplit=1)
        if len(sub) < 2:
            say("用法: /card export <id> <file>")
            return
        path = session.export_card(sub[0], Path(sub[1]))
        say(f"已导出 → {path}")
        return
    instruction = tail or "总结为卡片"
    if head == "all":
        if conv.pointer is None:
            say("（空会话）")
            return
        seqs = [n.seq for n in conv.path_to(conv.pointer)]
        cid = await session.make_card(instruction, from_seqs=seqs)
    elif (m := _RANGE_RE.match(head)):
        seqs = list(range(int(m.group(1)), int(m.group(2)) + 1))
        cid = await session.make_card(instruction, from_seqs=seqs)
    else:
        cid = await session.make_card(rest or "总结为卡片")
    say(f"卡片已创建: [{cid}] {conv.cards.get(cid).title}（默认 pinned，/unpin 可移除）")


async def handle_command(session: TreeChatSession, config: TreeChatConfig,
                         line: str, *, state: dict[str, Any], say: Say) -> bool:
    """处理斜杠命令；返回 True = 退出 REPL。业务错误显式显示，不中断会话。"""
    parts = line[1:].strip().split(maxsplit=1)
    cmd = parts[0] if parts else "help"
    rest = parts[1].strip() if len(parts) > 1 else ""
    conv = session.conversation
    try:
        if cmd in ("quit", "q"):
            return True
        if cmd == "help":
            say(_HELP)
        elif cmd == "where":
            depth = len(conv.path_to(conv.pointer)) if conv.pointer else 0
            say(f"指针: #{conv.pointer} · 路径深度 {depth} · 会话 {conv.name}")
        elif cmd == "tree":
            from .treeview import render_tree
            say(render_tree(conv))
        elif cmd == "branch":
            if not rest:
                say("用法: /branch <seq>")
            else:
                try:
                    conv.set_pointer(int(rest))
                except ValueError:
                    raise TreeChatError(f"seq 必须是数字: {rest}") from None
                say(f"指针 → #{conv.pointer}；下一条输入长新枝")
        elif cmd == "trunk":
            end = conv.trunk_end()
            if end is None:
                say("（空会话）")
            else:
                conv.set_pointer(end)
                say(f"指针 → 主干末端 #{end}")
        elif cmd == "leaf":
            state["leaf_next"] = True
            say("下一条输入 = 无上下文叶子提问")
        elif cmd == "retry":
            seq = conv.unanswered_user()
            if seq is None:
                say("没有待重试的节点")
            else:
                await session.complete(seq)
                node = conv.nodes[conv.pointer]
                say(_reply_line_of(node.seq, node.text))
        elif cmd == "card":
            await _card_command(session, rest, say)
        elif cmd == "cards":
            cards = conv.cards.all_cards()
            if not cards:
                say("（无卡片）")
            for c in cards:
                pin_mark = "📌" if c in conv.cards.pinned_cards() else ""
                say(f"[{c.id}] {c.title} {pin_mark}  来源 {c.from_path}")
        elif cmd == "pin":
            conv.pin(rest)
            say(f"已 pin {rest}")
        elif cmd == "unpin":
            conv.unpin(rest)
            say(f"已 unpin {rest}")
        elif cmd == "system":
            if rest:
                conv.update_system(rest)
                say("system 已更新")
            else:
                say(f"system: {conv.system or '（空）'}")
        elif cmd == "model":
            if rest:
                session.client = llm_bridge.create_client(rest)
                say(f"模型已切换（当前会话内有效）: {rest}")
            else:
                cfg = getattr(session.client, "config", None)
                say(f"当前模型: {getattr(cfg, 'model', '（未知）')}")
        else:
            say(f"未知命令: /{cmd}（/help 查看命令）")
    except LLMError as exc:
        dangling = conv.unanswered_user()
        say(f"LLM 调用失败：{exc}"
            + (f"\n节点 #{dangling} 悬而未答；/retry 重试" if dangling else ""))
    except TreeChatError as exc:
        say(f"错误：{exc}")
    return False
