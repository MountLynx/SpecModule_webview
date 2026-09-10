# server/chat.py
"""TreeChat 服务挂载：整树引入 treechat/webapp（/treechat 前缀），零重复接线。

统一 API 原则——treechat/webapp 就是 treechat 库的服务层，本层只做挂载与配置锚定：
- 会话数据目录：<base_dir>/.treechat（TREECHAT_DATA_DIR 可覆盖）——与 .specmodule
  同级的「工作区自包含」纪律；
- LLM 客户端：llm_bridge.create_client(project_root=base_dir)——复用 SpecModule
  配置回退链（项目根 config.json/.env → ~/.specmodule），与 run 侧共用同一配置、
  env 与客户端基建；
- treechat 未安装 → 跳过挂载并提示（对话功能下线，其余端点不受影响）。

挂载是一次性动作，base_dir/data_dir 在挂载时定死（子应用无法逐请求重锚）；
测试用 mount_chat(app, base_dir=tmp) 注入隔离根，不依赖全局 app。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

from fastapi import FastAPI

# 传给 create_app 的不存在路径：禁用其静态托管（前端归本仓库 SPA，不用 treechat/dist）
_DISABLED_STATIC = Path("__chat_static_disabled__")


def mount_chat(app: FastAPI, base_dir: Path | None = None) -> bool:
    """挂载 TreeChat 子应用（/treechat/api/*）；返回是否挂载（treechat 缺席 = False）。

    base_dir 缺省走 deps 纪律（SPECMODULE_BASE or cwd）；子应用 registry 暴露在
    app.state.chat_registry 供测试替换 LLM 客户端。
    """
    try:
        from treechat.config import TreeChatConfig
        from treechat.llm_bridge import create_client
        from treechat.webapp.app import create_app
    except ImportError as exc:
        print(f"[chat] treechat 未安装，对话服务跳过挂载"
              f"（pip install -e ../Treechat 启用）: {exc}", file=sys.stderr)
        return False

    from server.deps import get_base_dir

    root = Path(base_dir) if base_dir is not None else get_base_dir()
    data_dir = Path(os.environ.get("TREECHAT_DATA_DIR") or (root / ".treechat"))
    config = TreeChatConfig(data_dir=data_dir)

    def client_factory(model: str | None):
        # 显式锚定 project_root=base_dir：与 server 的 base_dir 纪律一致，
        # 运行根下的 config.json/.env 优先，缺省回落 ~/.specmodule
        return create_client(model, project_root=root)

    sub = create_app(config, client_factory=client_factory, static_dir=_DISABLED_STATIC)
    app.mount("/treechat", sub)
    app.state.chat_registry = sub.state.registry
    return True
