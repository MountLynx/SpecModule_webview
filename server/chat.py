# server/chat.py
"""TreeChat 服务挂载：整树引入 treechat/webapp（/treechat 前缀），零重复接线。

对话引擎已收编为本仓库顶级 `treechat/` 包（2026-09-14，原独立仓库冻结），
挂载常开、无缺席降级；依赖 specmodule（llm 客户端 + module_harness），与
server 其余部分同源。挂载职责只剩配置锚定：
- 会话数据目录：<base_dir>/.treechat（TREECHAT_DATA_DIR 可覆盖）——与 .specmodule
  同级的「工作区自包含」纪律；
- LLM 客户端：llm_bridge.create_client(project_root=base_dir)——复用 SpecModule
  配置回退链（项目根 config.json/.env → ~/.specmodule），与 run 侧共用同一配置、
  env 与客户端基建。

挂载是一次性动作，base_dir/data_dir 在挂载时定死（子应用无法逐请求重锚）；
测试用 mount_chat(app, base_dir=tmp) 注入隔离根，不依赖全局 app。
"""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI

from treechat.config import TreeChatConfig
from treechat.llm_bridge import create_client
from treechat.webapp.app import create_app

# 传给 create_app 的不存在路径：禁用其静态托管（前端归本仓库 SPA，不用 webui/dist）
_DISABLED_STATIC = Path("__chat_static_disabled__")


def mount_chat(app: FastAPI, base_dir: Path | None = None) -> bool:
    """挂载 TreeChat 子应用（/treechat/api/*）；恒返回 True（引擎已收编，挂载常开）。

    base_dir 缺省走 deps 纪律（SPECMODULE_BASE or cwd）；子应用 registry 暴露在
    app.state.chat_registry 供测试替换 LLM 客户端。
    """
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
