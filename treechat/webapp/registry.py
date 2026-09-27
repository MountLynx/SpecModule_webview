"""SessionRegistry —— WebUI 侧的打开会话登记表。

sid → TreeChatSession 进程内缓存（指针跨请求存活）+ 每会话 asyncio.Lock
（串行化轮次/卡片提炼）。LLM 客户端创建失败不阻塞会话管理——换上
_UnconfiguredClient，轮次时显式 LLMError（spec「诚实状态」哲学）。
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Callable

from ..config import TreeChatConfig
from ..core.conversation import Conversation
from ..core.errors import TreeChatError
from ..session import TreeChatSession

ClientFactory = Callable[[str | None], Any]


class _UnconfiguredClient:
    """LLM 未配置时的替身客户端：轮次调用显式失败，不静默。"""

    config = None

    async def complete(self, **kwargs) -> None:
        raise LLMErrorUnconfigured(
            "LLM 未配置：请完成 SpecModule 配置链（项目根 config.json / .env → ~/.specmodule）")


class LLMErrorUnconfigured(TreeChatError):
    """未配置 LLM 时的轮次失败（与 llm.LLMError 同层处理）。"""


def session_path(config: TreeChatConfig, sid: str) -> Path:
    """sid → 会话文件路径。拒绝路径穿越（/ \ .. 等），resolve 后必须落在 sessions_dir 内。"""
    if (not sid or sid in (".", "..") or "/" in sid or "\\" in sid
            or "\x00" in sid or sid.strip() != sid):
        raise TreeChatError(f"非法会话 ID: {sid!r}")
    d = config.sessions_dir()
    p = d / f"{sid}.jsonl"
    if p.resolve().parent != d.resolve():
        raise TreeChatError(f"非法会话 ID: {sid!r}")
    return p


class SessionRegistry:
    """打开会话的进程内登记表。"""

    def __init__(self, config: TreeChatConfig,
                 client_factory: ClientFactory | None = None,
                 tool_context: Any = None) -> None:
        self.config = config
        self.tool_context = tool_context
        self._client_factory: ClientFactory = client_factory or self._default_factory
        self._sessions: dict[str, TreeChatSession] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    @staticmethod
    def _default_factory(model: str | None) -> Any:
        from .. import llm_bridge
        return llm_bridge.create_client(model)

    # ── 打开/创建/关闭 ──

    def get(self, sid: str) -> TreeChatSession:
        """取打开的会话，未打开则加载（LLM 客户端创建失败降级为替身）。"""
        if sid in self._sessions:
            return self._sessions[sid]
        path = session_path(self.config, sid)
        if not path.exists():
            raise TreeChatError(f"会话不存在: {sid}")
        conv = Conversation.open(path)
        try:
            client = self._client_factory(None)
        except Exception:  # noqa: BLE001 —— 配置链任何失败都降级，不阻塞管理功能
            client = _UnconfiguredClient()
        s = TreeChatSession(conversation=conv, client=client,
                            mode_modules=self.config.mode_modules,
                            tool_context=self.tool_context)
        self._sessions[sid] = s
        return s

    def create(self, sid: str, name: str, system: str = "") -> TreeChatSession:
        path = session_path(self.config, sid)
        if path.exists():
            raise FileExistsError(f"会话已存在: {sid}")
        conv = Conversation.create(path, name, system)
        try:
            client = self._client_factory(None)
        except Exception:  # noqa: BLE001
            client = _UnconfiguredClient()
        s = TreeChatSession(conversation=conv, client=client,
                            mode_modules=self.config.mode_modules,
                            tool_context=self.tool_context)
        self._sessions[sid] = s
        return s

    def drop(self, sid: str) -> None:
        self._sessions.pop(sid, None)

    # ── 并发 ──

    def lock(self, sid: str) -> asyncio.Lock:
        if sid not in self._locks:
            self._locks[sid] = asyncio.Lock()
        return self._locks[sid]
