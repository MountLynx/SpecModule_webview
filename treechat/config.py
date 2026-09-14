"""TreeChatConfig —— 运行配置。"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class TreeChatConfig:
    """会话存储位置与默认参数。

    data_dir 默认 `~/.treechat`，测试/嵌入方按需覆盖。
    """

    data_dir: Path = field(default_factory=lambda: Path.home() / ".treechat")
    budget_tokens: int = 100_000
    model: str | None = None
    """默认模型覆盖；None = 走 SpecModule 配置链的默认模型。"""
    mode_modules: dict[str, str] = field(default_factory=lambda: {"grilling": "grilling"})
    """category 值 → 模块注册表名（spec §4）。未知/缺省 category 回落直答（resolve_module）。"""

    def __post_init__(self) -> None:
        """允许嵌入方传 str，统一归一为 Path。"""
        self.data_dir = Path(self.data_dir)

    def sessions_dir(self) -> Path:
        return self.data_dir / "sessions"
