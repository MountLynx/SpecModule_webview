"""对话型模块定义基座 —— 纯嵌入承载（spec §2/§3）。

ConversationalModule 是模块定义的唯一形态：固定 tasklist + registry 构建器 +
显示元数据。不做 store/entry/pack 形态——这是拿 specmodule 当 treechat 的
agent harness 框架，模块不作为显式 module 被发现。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Callable


@dataclass(frozen=True)
class DocumentDef:
    """模块维护的一份共同文档 → 每轮产出一张节点卡（doc_key 沿路径取版本）。"""

    key: str      # 文档标识（节点卡 doc_key；上下文沿路径解析的锚）
    field: str    # 归一化输出中的文档字段名
    title: str


@dataclass(frozen=True)
class ConversationalModule:
    """对话型模块定义（spec §3）。一次回合 = 用它直构的一次 ephemeral Module run。"""

    key: str
    display_name: str
    description: str
    spec_schema: dict[str, str]                 # {字段: 类型}（声明性；SpecSchema 只强校验声明字段）
    tasklist: dict                              # 固定 tasklist JSON {"Tasks", "Flow"}
    build_registry: Callable[[Any, Any], Any]   # (llm_client, event_bus) -> HarnessRegistry
    node_order: list[str]                       # LLM 节点顺序（SSE start 预告）
    shape: str = "document"                     # "text"（直答退化形态）| "document"
    message_field: str = ""
    """document 形态归一化输出中作为 assistant 消息正文的字段名；空串 = 无消息。"""
    node_labels: dict[str, str] = field(default_factory=dict)
    display_fields: dict[str, str] = field(default_factory=dict)
    """json 输出节点的显示字段（SSE 流整形目标）；未声明的节点 passthrough。"""
    node_docs: dict[str, list[str]] = field(default_factory=dict)
    """节点 → 其产出对应的卡片 ID（node_end 链接片 refs）。"""
    documents: list[DocumentDef] = field(default_factory=list)

    def node_label(self, key: str) -> str:
        return self.node_labels.get(key, key)

    def shaper(self, node: str) -> "FieldStreamShaper | None":
        fld = self.display_fields.get(node)
        return FieldStreamShaper(fld) if fld else None


class FieldStreamShaper:
    """json_object 节点的显示字段增量提取（spec §2 桥接整形）。

    在滚动缓冲中定位 `"field"\\s*:\\s*"` 后边收边做 JSON 字符串解码
    （\\n \\t \\" \\\\ \\uXXXX，可跨 chunk），遇到未转义收引号即完成。
    \\uD83D\\uDE00 代理对合并为单一码点；未配对代理以 U+FFFD 兜底，
    保证输出恒为合法 UTF-8（不产生孤立代理项）。
    字段未出现时不产生输出（不推半截垃圾）；完成后剩余内容全部丢弃。
    """

    _ESCAPES = {'"': '"', "\\": "\\", "/": "/", "b": "\b", "f": "\f",
                "n": "\n", "r": "\r", "t": "\t"}

    def __init__(self, field_name: str) -> None:
        self._pattern = re.compile(r'"' + re.escape(field_name) + r'"\s*:\s*"')
        self._buf = ""
        self._state = "seek"      # seek | in_string | done
        self._escape = False      # 上个字符是反斜杠（跨 chunk 存续）
        self._unicode = None      # \\uXXXX 待续 hex；None=未在收集（跨 chunk 存续）
        self._hi = None           # 挂起的高位代理 D800-DBFF（跨 chunk 存续）

    def feed(self, chunk: str) -> str:
        if self._state == "done":
            return ""
        if self._state == "seek":
            self._buf += chunk
            m = self._pattern.search(self._buf)
            if m is None:
                # 保留尾部：key/冒号/引号可能被块切断。\s* 运行期间不裁剪——
                # 格式化 JSON 的缩进空白可任意长，匹配起点可能在更早处。
                keep = len(self._pattern.pattern) - 1
                if self._buf[-1:].isspace():
                    keep = len(self._buf)   # inside \s*; a match may start arbitrarily far back
                self._buf = self._buf[-keep:]
                return ""
            data = self._buf[m.end():]
            self._state = "in_string"
        else:
            data = self._buf + chunk
        self._buf = ""
        out: list[str] = []
        for ch in data:
            if self._state == "done":
                break
            if self._unicode is not None:
                self._unicode += ch
                if len(self._unicode) == 4:
                    hexs = self._unicode
                    self._unicode = None
                    try:
                        cp = int(hexs, 16)
                    except ValueError:
                        cp = -1
                    if 0xD800 <= cp <= 0xDBFF:
                        # 高位代理：挂起等待下一个 \uDC00-DFFF 配对（跨 chunk 存续）
                        if self._hi is not None:
                            out.append("\ufffd")   # 连续两个高位代理 → 前一个未配对
                        self._hi = cp
                    elif 0xDC00 <= cp <= 0xDFFF:
                        if self._hi is not None:
                            out.append(chr(0x10000 + ((self._hi - 0xD800) << 10)
                                           + (cp - 0xDC00)))
                            self._hi = None
                        else:
                            out.append("\ufffd")   # 孤立低位代理
                    else:
                        if self._hi is not None:
                            out.append("\ufffd")   # 高位代理后跟普通转义 → 未配对
                            self._hi = None
                        if cp >= 0:
                            out.append(chr(cp))
                continue
            if self._escape:
                self._escape = False
                if ch == "u":
                    self._unicode = ""
                else:
                    if self._hi is not None:
                        out.append("\ufffd")       # 高位代理后跟非 \u 转义 → 未配对
                        self._hi = None
                    if ch in self._ESCAPES:
                        out.append(self._ESCAPES[ch])
                    else:
                        out.append(ch)
                continue
            if ch == "\\":
                self._escape = True
                continue
            if ch == '"':
                self._state = "done"
                break
            if self._hi is not None:
                out.append("\ufffd")               # 高位代理后跟普通字符 → 未配对
                self._hi = None
            out.append(ch)
        else:
            if self._state == "in_string":
                # 未收尾：反斜杠/\\u 前缀已在状态里，无需回填
                pass
        return "".join(out)
