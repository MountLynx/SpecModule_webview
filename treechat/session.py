"""TreeChatSession —— 编程 API 门面：轮次 + 卡片（组合 Conversation 与 module_bridge）。

轮次持久时序（spec §2.2）：send 先落 user_msg（建轮）；complete 按轮上记录
（缺省会话 category）分派模块回合后落 assistant_msg（回填该轮 output）。
LLM 失败 → 悬而未答轮保留，turn_retry 对原轮补 assistant（问题不丢、不重复）。
节点 = 轮次（一问一答）。
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from . import agent_bridge, llm_bridge, module_bridge
from .config import TreeChatConfig
from .core.cards import doc_card_id
from .core.context import TokenWindowStrategy, WindowStrategy
from .core.conversation import Conversation
from .core.errors import EventFormatError, TreeChatError
from .core.events import (
    SessionArchive, SessionCategory, SessionMeta, SessionRename,
    UserMsg, event_from_dict,
)
from .modules import AgentMode, ConversationalModule, resolve_module


@dataclass
class TreeChatSession:
    """一个打开的会话 + LLM 客户端 + 窗口策略。"""

    conversation: Conversation
    client: Any
    window: WindowStrategy | None = field(default_factory=TokenWindowStrategy)
    card_llm: Any = None
    """卡片提炼客户端（需支持 complete）；None = 复用 client（真客户端两者都有）。"""
    mode_modules: dict[str, str] | None = None
    """category → 模块名映射覆盖；None = 内置默认映射。Web/CLI 创建时传 config.mode_modules。"""
    tool_context: Any = None
    """ops 回合的工具执行上下文（ToolContext；None = agent_bridge 内回落缺省）。"""

    # ── 构造 ──

    @classmethod
    def create(cls, path: Path, name: str, system: str = "", *,
               model: str | None = None,
               window: WindowStrategy | None = None,
               mode_modules: dict[str, str] | None = None,
               tool_context: Any = None) -> "TreeChatSession":
        conv = Conversation.create(path, name, system)
        return cls(conversation=conv, client=llm_bridge.create_client(model),
                   window=_window_or_default(window),
                   mode_modules=mode_modules, tool_context=tool_context)

    @classmethod
    def open(cls, path: Path, *, model: str | None = None,
             window: WindowStrategy | None = None,
             mode_modules: dict[str, str] | None = None,
             tool_context: Any = None) -> "TreeChatSession":
        conv = Conversation.open(path)
        return cls(conversation=conv, client=llm_bridge.create_client(model),
                   window=_window_or_default(window),
                   mode_modules=mode_modules, tool_context=tool_context)

    # ── 轮次 ──

    def module_for(self, user_seq: int) -> ConversationalModule | AgentMode:
        """轮次生效模块：轮上记录优先，回落会话 category（resolve_module 兜底直答）。"""
        conv = self.conversation
        return resolve_module(conv.nodes[user_seq].module or conv.category,
                              self.mode_modules)

    def send(self, text: str, *, leaf: bool = False, module: str = "") -> int:
        """落 user_msg（先持久化，防丢）；module = 本轮模式 key（空 = 会话默认）。"""
        return self.conversation.append_user(text, leaf=leaf, module=module)

    async def complete(self, user_seq: int) -> int:
        """组装 → 模块回合 → 落 assistant_msg → 指针推进。LLMError 上抛。"""
        seq, _ = await self.complete_outcome(user_seq)
        return seq

    async def complete_outcome(self, user_seq: int, *,
                               on_event: Callable[[dict], None] | None = None,
                               ) -> tuple[int, module_bridge.TurnOutcome]:
        """complete 全信息版：返回 (assistant seq, 回合结果)。webapp SSE 消费。

        分派：轮上记录模式 > 会话 category → resolve_module（spec §4）。回合产出
        的文档落为该轮的文档版本节点卡。
        """
        conv = self.conversation
        if user_seq not in conv.nodes or conv.nodes[user_seq].output is not None:
            raise TreeChatError(f"complete 目标必须是未答轮次: {user_seq}")
        module = self.module_for(user_seq)
        if isinstance(module, AgentMode):
            outcome = await agent_bridge.run_agent_turn(
                conv, user_seq, client=self.client, window=self.window,
                tool_context=self.tool_context,
                on_event=on_event or (lambda evt: None))
        else:
            outcome = await module_bridge.run_turn(
                module, conv, user_seq, client=self.client, window=self.window,
                on_event=on_event or (lambda evt: None))
        cfg = getattr(self.client, "config", None)
        model = getattr(cfg, "model", "") if cfg is not None else ""
        for doc_key, title, body in outcome.documents:
            cid = doc_card_id(doc_key, user_seq)
            if cid in conv.cards.ids():
                # 崩溃残留（文档已落盘、assistant 未落）重试时复用确定性 ID，防毒事件
                conv.edit_card(cid, title, body)
            else:
                conv.add_card(title, body, from_path=[], owner_seq=user_seq,
                              doc_key=doc_key, card_id=cid)
        seq = conv.append_assistant(user_seq, outcome.message_text,
                                    model=model, usage=outcome.usage)
        if outcome.done and conv.category:  # 拷问收敛 → 自动退出拷问态（空 = 直答）
            conv.set_category("")
        return seq, outcome

    async def turn(self, text: str, *, leaf: bool = False,
                   module: str = "") -> int:
        """send + complete 一步走。失败时 user 节点已落盘（悬而未答），turn_retry 重试。"""
        seq = self.send(text, leaf=leaf, module=module)
        return await self.complete(seq)

    async def turn_retry(self, user_seq: int) -> int:
        """对悬而未答的 user 节点重新调 LLM。"""
        return await self.complete(user_seq)

    # ── 卡片 ──

    def branch_segment(self, seq: int | None = None) -> list[int]:
        """默认提炼范围（spec §3.2）：fork_point 起到 seq（默认指针）。

        节点即轮次，fork_point 恒为轮并含其自身（提问属于这段讨论）。
        """
        target = seq if seq is not None else self.conversation.pointer
        if target is None:
            raise TreeChatError("空会话没有可提炼范围")
        path = self.conversation.path_to(target)
        fp = self.conversation.fork_point(target)
        if fp is None:
            return [n.seq for n in path]
        idx = next(i for i, n in enumerate(path) if n.seq == fp)
        return [n.seq for n in path[idx:]] or [target]

    async def make_card(self, instruction: str, *, seq: int | None = None,
                        from_seqs: list[int] | None = None,
                        owner_seq: int | None = None) -> str:
        """提炼卡片：默认当前分支段；from_seqs 显式区间；owner_seq 非空 = 挂该轮（节点卡）。"""
        seqs = from_seqs if from_seqs is not None else self.branch_segment(seq)
        if not seqs:
            raise TreeChatError("提炼范围为空")
        missing = [s for s in seqs if s not in self.conversation.nodes]
        if missing:
            raise TreeChatError(f"提炼范围含不存在的节点: {missing[:3]}")
        lines = []
        for s in seqs:
            n = self.conversation.nodes[s]
            lines.append(f"[user] {n.input}")
            if n.output is not None:
                lines.append(f"[assistant] {n.output}")
        transcript = "\n\n".join(lines)
        client = self.card_llm if self.card_llm is not None else self.client
        out = await llm_bridge.extract_card(transcript, instruction, llm_client=client)
        return self.conversation.add_card(out["title"], out["body"], seqs,
                                          instruction, owner_seq=owner_seq)

    def export_card(self, card_id: str, file_path: Path) -> Path:
        card = self.conversation.cards.get(card_id)
        out = Path(file_path)
        out.write_text(card_markdown(card), encoding="utf-8")
        return out


def _window_or_default(window: WindowStrategy | None) -> WindowStrategy:
    """create/open 的 window=None = 用默认 V1 窗口策略（而非关闭窗口）。"""
    return window if window is not None else TokenWindowStrategy()


@dataclass
class SessionSummary:
    """会话枚举条目。sid = 文件名 stem（稳定 ID），name = 含 rename 的显示名。"""

    sid: str
    path: Path
    name: str
    created_at: str
    system: str
    category: str
    archived: bool
    node_count: int
    mtime: float
    """文件修改时间 = 最近活动时间（事件日志不带 user/assistant 时间戳）。"""


def read_session_summary(path: Path) -> SessionSummary:
    """全文件轻解析派生会话摘要：显示名/分类/归档/节点数。

    撕裂尾（末行不完整）容忍并忽略；中间损坏/未知类型抛 EventFormatError
    （由 list_sessions 跳过该文件——打开时才硬报错的既有纪律）。
    """
    name = created_at = system = category = ""
    archived = False
    node_count = 0
    with open(path, encoding="utf-8") as f:
        lines = f.readlines()
    total = len(lines)
    first_meta = False
    seen_valid = False
    for lineno, raw in enumerate(lines, start=1):
        stripped = raw.strip()
        if not stripped:
            continue
        try:
            d = json.loads(stripped)
        except json.JSONDecodeError:
            if lineno == total and seen_valid:
                break  # 撕裂尾：末行 JSON 不完整 → 容忍并忽略
            raise
        try:
            seq, ev = event_from_dict(d)
        except EventFormatError:
            if lineno == total and seen_valid:
                break  # 末行事件残缺同样容忍（打开时才硬报错）
            raise
        seen_valid = True
        if not first_meta:
            first_meta = isinstance(ev, SessionMeta)
            if not first_meta:
                raise EventFormatError(f"首行不是 session_meta: {path}")
        match ev:
            case SessionMeta():
                name, created_at, system = ev.name, ev.created_at, ev.system
            case SessionRename():
                name = ev.name
            case SessionCategory():
                category = ev.category
            case SessionArchive():
                archived = ev.archived
            case UserMsg():
                node_count += 1  # 轮数（assistant_msg 回填父轮，不计）
    return SessionSummary(
        sid=path.stem, path=path, name=name, created_at=created_at,
        system=system, category=category, archived=archived,
        node_count=node_count, mtime=path.stat().st_mtime,
    )


def list_sessions(config: TreeChatConfig) -> list[SessionSummary]:
    """枚举 data_dir/sessions 下的会话（坏文件跳过——打开时才硬报错）。"""
    d = config.sessions_dir()
    if not d.exists():
        return []
    out: list[SessionSummary] = []
    for p in sorted(d.glob("*.jsonl")):
        try:
            out.append(read_session_summary(p))
        except (TreeChatError, json.JSONDecodeError, OSError):
            continue
    return out


@dataclass
class LibraryCard:
    """跨会话卡库条目（只读枚举）。「引用」= 复制导入，不建立跨文件引用。"""

    sid: str
    session_name: str
    card: Card
    pinned: bool


def card_markdown(card: Card) -> str:
    """卡片导出格式（CLI 与 Web 导出共用）：`# 标题\\n\\n正文\\n`。"""
    return f"# {card.title}\n\n{card.body}\n"


def list_library_cards(config: TreeChatConfig) -> list[LibraryCard]:
    """全库枚举：所有会话的全局卡片（重放派生，坏文件跳过——与 list_sessions 同纪律）。

    卡库语义 = 跨会话复用的提炼/导入卡：只收 owner_seq=None 的全局卡；
    节点卡（挂轮的文档/提炼版本，每轮一张）不进卡库（card_markdown/导入
    不受影响——导入即全局复制）。
    只读扫描：不建 LLM 客户端、不进会话注册表。
    """
    d = config.sessions_dir()
    if not d.exists():
        return []
    out: list[LibraryCard] = []
    for p in sorted(d.glob("*.jsonl")):
        try:
            conv = Conversation.open(p)
        except (TreeChatError, json.JSONDecodeError, OSError):
            continue
        for c in conv.cards.all_cards():
            if c.owner_seq is not None:
                continue  # 节点卡：作用域由树位置决定，不跨会话复用
            out.append(LibraryCard(sid=p.stem, session_name=conv.name, card=c,
                                   pinned=conv.cards.is_pinned(c.id)))
    return out
