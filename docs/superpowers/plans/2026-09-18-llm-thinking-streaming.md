# LLM 思考通道全链路真流式——实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LLM 思考增量从 provider 到 UI 全链路可见——`complete(on_thinking=)` 双回调通道、`LlmThinking` 事件、stream.log `thinking` 记录、run 视图与 treechat 两消费端思考块渲染。

**Architecture:** 上游 SpecModule 库加思考通道（OpenAI 兼容 reasoning 方言 + 内联 `<think>` 剥离 + Anthropic thinking_delta），harness 经 EventBus 发 `LlmThinking` → stream.log 新记录类型（server WS 泛化透传零改动）→ 前端平行缓冲渲染；treechat 订阅同事件 → SSE `thinking` 帧 → ChatView 思考行。两个仓库独立提交，依赖经 editable 锚直接生效。

**Tech Stack:** Python 3.10+ / FastAPI / pytest-asyncio（strict）；Vite + React + TS + Tailwind。

**Spec:** `docs/superpowers/specs/2026-09-18-llm-thinking-streaming-design.md`

**仓库约定：**
- Task 1-4 在 **`../SpecModule`**（上游库仓库，pip 惯例；提交前先 `git -C ../SpecModule status --short` 确认无无关脏文件，只 add 本任务触碰的文件）。测试命令从本仓库根跑（uv 环境含 editable specmodule）。
- Task 5-9 在 **本仓库**。
- 所有 pytest 命令从本仓库根（`C:\Users\xingy\Desktop\开发\SpecModule_webview`）执行。

---

## Part 1 — 上游 SpecModule 库

### Task 1: OpenAI 兼容客户端 on_thinking 通道 + 内联 `<think>` 剥离

**Files:**
- Modify: `../SpecModule/llm/client.py`（`_safe_on_token` 后加助手与剥离器；OpenAIClient.complete 签名与门控 565-566；`_stream` 593-619 重写）
- Create: `../SpecModule/llm/tests/test_stream_thinking.py`

- [ ] **Step 1: 写失败测试**

新建 `../SpecModule/llm/tests/test_stream_thinking.py`（本文件在 Task 2 继续追加，桩助手放这里共用）：

```python
# llm/tests/test_stream_thinking.py
"""on_thinking 通道：reasoning 方言分派 + 内联 <think> 剥离 + Anthropic thinking_delta。

SDK 不进依赖（conftest 假 SDK 建构造级客户端）——流行为用桩对象替换 client._client
（_stream 只触 chat.completions.create / messages.stream 两个入口）。
"""

from __future__ import annotations

import pytest

from llm.client import AnthropicClient, OpenAIClient, RoutingClient, _ThinkTagStripper
from llm.config import LLMConfig


# ── OpenAI 兼容桩 ──────────────────────────────────────────────

class _Delta:
    def __init__(self, content=None, reasoning_content=None, reasoning=None):
        self.content = content
        self.reasoning_content = reasoning_content
        self.reasoning = reasoning


class _Choice:
    def __init__(self, delta, finish_reason=None):
        self.delta = delta
        self.finish_reason = finish_reason


class _Chunk:
    def __init__(self, delta, finish_reason=None, usage=None):
        self.choices = [_Choice(delta, finish_reason)]
        self.usage = usage


class _StubCompletions:
    def __init__(self, chunks):
        self._chunks = chunks
        self.last_kwargs: dict | None = None

    async def create(self, **kwargs):
        self.last_kwargs = kwargs        # 门控断言用：记下最近一次请求参数
        return _AsyncChunks(self._chunks)


class _AsyncChunks:
    def __init__(self, chunks):
        self._chunks = chunks

    def __aiter__(self):
        return self._gen()

    async def _gen(self):
        for c in self._chunks:
            yield c


class _StubOpenAISDK:
    """桩到 `self._client.chat.completions.create(**kwargs)` 这条链。"""

    def __init__(self, chunks):
        self.chat = type("Chat", (), {"completions": _StubCompletions(chunks)})()


def _openai_client(monkeypatch, chunks) -> OpenAIClient:
    """真构造（config 完整，_stream/complete 读 config.base_url）+ 流桩换 _client。"""
    from conftest import _install_fake_sdk

    cap: dict = {}
    _install_fake_sdk(monkeypatch, "openai", "AsyncOpenAI", cap)
    c = OpenAIClient(LLMConfig(provider="openai", api_key="k", model="m"))
    c._client = _StubOpenAISDK(chunks)
    return c


# ── 用例 ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_openai_reasoning_content_dialect(monkeypatch):
    """reasoning_content 方言 → on_thinking；content → on_token。"""
    c = _openai_client(monkeypatch, [
        _Chunk(_Delta(reasoning_content="想")),
        _Chunk(_Delta(reasoning_content="清楚")),
        _Chunk(_Delta(content="答"), finish_reason="stop"),
    ])
    think, toks = [], []
    content, _, usage, finish = await c._stream({"model": "m"}, toks.append, think.append)
    assert "".join(think) == "想清楚"
    assert "".join(toks) == "答"
    assert content == "答" and finish == "stop" and usage == {}


@pytest.mark.asyncio
async def test_openai_reasoning_attr_fallback(monkeypatch):
    """无 reasoning_content 时回落 delta.reasoning（部分网关方言）。"""
    c = _openai_client(monkeypatch, [_Chunk(_Delta(reasoning="推理中"))])
    think, _ = [], []
    await c._stream({"model": "m"}, None, think.append)
    assert "".join(think) == "推理中"


@pytest.mark.asyncio
async def test_openai_inline_think_split_across_chunks(monkeypatch):
    """内联 <think> 标签被 chunk 劈开也能完整剥离：外→token，内→thinking。"""
    c = _openai_client(monkeypatch, [
        _Chunk(_Delta(content="a<th")),
        _Chunk(_Delta(content="ink>隐藏的</th")),
        _Chunk(_Delta(content="ink>b"), finish_reason="stop"),
    ])
    think, toks = [], []
    content, *_ = await c._stream({"model": "m"}, toks.append, think.append)
    assert "".join(toks) == "ab"
    assert "".join(think) == "隐藏的"
    assert content == "ab"          # 返回 content 不含思考文本


@pytest.mark.asyncio
async def test_openai_unclosed_think_flush(monkeypatch):
    """流结束仍未闭合的 <think>：缓冲整体按思考吐出（flush 路径）。"""
    c = _openai_client(monkeypatch, [
        _Chunk(_Delta(content="答案<think>内幕")),
    ])
    think, toks = [], []
    content, *_ = await c._stream({"model": "m"}, toks.append, think.append)
    assert "".join(toks) == "答案"
    assert "".join(think) == "内幕"
    assert content == "答案"


@pytest.mark.asyncio
async def test_on_thinking_alone_triggers_stream(monkeypatch):
    """只传 on_thinking 也走流式接口（complete 门控：任一回调即流式）。"""
    c = _openai_client(monkeypatch, [_Chunk(_Delta(reasoning_content="想"), finish_reason="stop")])
    think = []
    await c.complete("p", model="m", on_thinking=think.append)
    assert c._client.chat.completions.last_kwargs is not None
    assert c._client.chat.completions.last_kwargs.get("stream") is True
    assert think == ["想"]


def test_stripper_literal_bracket_not_tag():
    """普通文本里的零散 '<' 不误剥（hold-back 后原样吐出）。"""
    s = _ThinkTagStripper()
    c1, t1 = s.feed("1 < 2 且 <b>加粗</b>")
    c2, t2 = s.flush()
    assert (c1 + c2) == "1 < 2 且 <b>加粗</b>"
    assert (t1 + t2) == ""
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest ../SpecModule/llm/tests/test_stream_thinking.py -v`
Expected: FAIL/ERROR——`ImportError: cannot import name '_ThinkTagStripper'`（或 `_stream` 签名不符 TypeError）

- [ ] **Step 3: 实现——助手 + 剥离器**

`../SpecModule/llm/client.py`：在 `_safe_on_token`（第 129-136 行）之后插入：

```python
def _safe_on_thinking(on_thinking: Callable[[str], None] | None, chunk: str) -> None:
    """调用 on_thinking，回调异常不得影响主流程（同 _safe_on_token）。"""
    if on_thinking is None or not chunk:
        return
    try:
        on_thinking(chunk)
    except Exception:
        log.exception("on_thinking 回调异常；已忽略")


class _ThinkTagStripper:
    """跨 chunk 安全的内联 ``<think>…</think>`` 剥离器。

    部分兼容网关不单设 reasoning 通道，思考文本带标签内联在 content 里。
    feed() 逐 chunk 喂入，返回 (content_delta, thinking_delta)：标签外增量
    归 content、标签内增量归 thinking；hold-back 缓冲处理标签自身被 chunk
    劈开的情况；flush() 在流结束吐出残留（未闭合标签按思考处理）。
    """

    _OPEN = "<think>"
    _CLOSE = "</think>"

    def __init__(self) -> None:
        self._inside = False
        self._buf = ""      # hold-back：可能是未判定标签前缀的尾部

    def feed(self, chunk: str) -> tuple[str, str]:
        self._buf += chunk
        content_parts: list[str] = []
        thinking_parts: list[str] = []
        while self._buf:
            if self._inside:
                end = self._buf.find(self._CLOSE)
                if end >= 0:
                    thinking_parts.append(self._buf[:end])
                    self._buf = self._buf[end + len(self._CLOSE):]
                    self._inside = False
                    continue
                keep = self._holdback(self._CLOSE)
            else:
                start = self._buf.find(self._OPEN)
                if start >= 0:
                    content_parts.append(self._buf[:start])
                    self._buf = self._buf[start + len(self._OPEN):]
                    self._inside = True
                    continue
                keep = self._holdback(self._OPEN)
            emit = len(self._buf) - keep
            if emit:
                (thinking_parts if self._inside else content_parts).append(self._buf[:emit])
                self._buf = self._buf[emit:]
            break
        return "".join(content_parts), "".join(thinking_parts)

    def flush(self) -> tuple[str, str]:
        """流结束：按当前内/外状态吐出残留 hold-back。"""
        if not self._buf:
            return "", ""
        out = self._buf
        self._buf = ""
        return ("", out) if self._inside else (out, "")

    def _holdback(self, tag: str) -> int:
        """缓冲尾部可能是 tag 真前缀的最大长度（ TagLen-1 向下探）。"""
        for n in range(min(len(self._buf), len(tag) - 1), 0, -1):
            if tag.startswith(self._buf[-n:]):
                return n
        return 0
```

- [ ] **Step 4: 实现——OpenAIClient.complete 门控与 `_stream`**

`OpenAIClient.complete`（第 506 行起）签名在 `on_token`（第 516 行）后加一行：

```python
        on_thinking: Callable[[str], None] | None = None,
```

第 565-566 行门控与调用改为：

```python
            if on_token or on_thinking:
                content, tool_calls, usage, finish = await self._stream(kwargs, on_token, on_thinking)
```

`_stream`（第 593-619 行）整体替换为：

```python
    async def _stream(self, kwargs: dict, on_token, on_thinking) -> tuple:
        kwargs["stream"] = True
        # stream_options 仅官方 OpenAI 必然支持；兼容接口（base_url 非空）省略以免被拒
        if not self.config.base_url:
            kwargs["stream_options"] = {"include_usage": True}
        content = ""
        tool_calls: list[dict[str, Any]] = []
        usage: dict[str, int] = {}
        finish: str | None = None
        stripper = _ThinkTagStripper()
        stream = await self._client.chat.completions.create(**kwargs)
        async for chunk in stream:
            if chunk.usage:
                usage = {
                    "input_tokens": chunk.usage.prompt_tokens or 0,
                    "output_tokens": chunk.usage.completion_tokens or 0,
                }
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            # 思考增量：DeepSeek/Kimi 的 reasoning_content，部分网关用 reasoning；
            # 无原生通道时由 <think> 剥离器从 content 转移（见下）
            reasoning = getattr(delta, "reasoning_content", None) or getattr(delta, "reasoning", None)
            if reasoning:
                _safe_on_thinking(on_thinking, reasoning)
            if delta.content:
                c_delta, t_delta = stripper.feed(delta.content)
                content += c_delta        # 返回值用剥离后文本（思考不泄入 JSON 输出）
                if c_delta:
                    _safe_on_token(on_token, c_delta)
                if t_delta:
                    _safe_on_thinking(on_thinking, t_delta)
            if chunk.choices[0].finish_reason:
                finish = chunk.choices[0].finish_reason
        tail_c, tail_t = stripper.flush()
        if tail_c:
            content += tail_c
            _safe_on_token(on_token, tail_c)
        if tail_t:
            _safe_on_thinking(on_thinking, tail_t)
        return content, tool_calls, usage, finish
```

注意 docstring：`complete()` 的参数文档（第 237/516 行附近的参数注释区）补一行说明：

```
        - ``on_thinking``：思考/推理增量回调（reasoning_content/reasoning 方言 +
          content 内联 <think> 剥离；Anthropic thinking_delta）；仅传 on_token 时
          思考增量静默丢弃（向后兼容）
```

- [ ] **Step 5: 跑测试确认通过**

Run: `uv run pytest ../SpecModule/llm/tests/test_stream_thinking.py -v`
Expected: 全部 PASS（6 个用例）

- [ ] **Step 6: 回归——既有 llm 测试不破**

Run: `uv run pytest ../SpecModule/llm/tests/ -q`
Expected: 全部 PASS（既有用例只传 on_token，行为不变）

- [ ] **Step 7: 提交（SpecModule 仓库）**

```bash
git -C ../SpecModule add llm/client.py llm/tests/test_stream_thinking.py
git -C ../SpecModule commit -m "feat: llm on_thinking 思考通道——OpenAI 兼容 reasoning 方言 + 内联 think 标签剥离"
```

### Task 2: Anthropic 客户端 thinking_delta + RoutingClient 透传

**Files:**
- Modify: `../SpecModule/llm/client.py`（AnthropicClient.complete 227-288；`_stream` 312-330 重写；RoutingClient.complete 756-780）
- Modify: `../SpecModule/llm/tests/test_stream_thinking.py`（追加）

- [ ] **Step 1: 追加失败测试**（加到 `test_stream_thinking.py` 末尾）

```python
# ── Anthropic 桩 ────────────────────────────────────────────────

class _ADelta:
    def __init__(self, dtype, **fields):
        self.type = dtype
        self.__dict__.update(fields)


class _AEvent:
    def __init__(self, delta):
        self.delta = delta


class _StubAnthropicStream:
    def __init__(self, events, final):
        self._events, self._final = events, final

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def __aiter__(self):
        return self._gen()

    async def _gen(self):
        for e in self._events:
            yield e

    async def get_final_message(self):
        return self._final


class _AFinal:
    def __init__(self):
        self.content = []
        self.usage = type("U", (), {"input_tokens": 1, "output_tokens": 2})()
        self.stop_reason = "end_turn"


class _StubAnthropicSDK:
    def __init__(self, stream):
        self.messages = type("M", (), {"stream": lambda self_, **kw: stream})()


def _anthropic_client(events) -> AnthropicClient:
    """_stream 只触 self._client——__new__ 跳过构造（无需 anthropic 包与 config）。"""
    c = AnthropicClient.__new__(AnthropicClient)
    c._client = _StubAnthropicSDK(_StubAnthropicStream(events, _AFinal()))
    return c


@pytest.mark.asyncio
async def test_anthropic_thinking_delta_passthrough():
    """thinking_delta → on_thinking；text_delta → on_token；content 聚合正确。"""
    c = _anthropic_client([
        _AEvent(_ADelta("thinking_delta", thinking="推理")),
        _AEvent(_ADelta("text_delta", text="结论")),
        _AEvent(_ADelta("text_delta", text="如下")),
    ])
    think, toks = [], []
    content, tool_calls, usage, finish = await c._stream({}, None, toks.append, think.append)
    assert "".join(think) == "推理"
    assert "".join(toks) == "结论如下"
    assert content == "结论如下" and usage == {"input_tokens": 1, "output_tokens": 2}
    assert finish == "end_turn" and tool_calls == []


@pytest.mark.asyncio
async def test_routing_passes_on_thinking_through():
    """RoutingClient.complete 透传 on_thinking 到被路由客户端（镜像 test_routing 桩法）。"""
    from unittest.mock import AsyncMock

    from llm.client import LLMResponse

    client = RoutingClient(LLMConfig(provider="openai", api_key="k", model="m"))
    mock = AsyncMock()
    mock.complete.return_value = LLMResponse(content="y")
    client._clients[None] = mock   # 预置槽位 → _client_for 直接命中，不建真客户端
    think = []
    await client.complete("p", on_thinking=think.append)
    kw = mock.complete.call_args.kwargs
    assert callable(kw["on_thinking"])
```

（`AnthropicClient`/`RoutingClient`/`LLMConfig` 已在 Task 1 建文件时写入顶部 import。`_anthropic_client` 用 `__new__` 是安全的——重写后的 `_stream` 只触 `self._client`，不读 config。）

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest ../SpecModule/llm/tests/test_stream_thinking.py -v`
Expected: 新增 2 用例 FAIL——`_stream() takes 3 positional arguments but 4 were given`（Anthropic 签名未改）；`kw["on_thinking"]` KeyError（Routing 未透传）

- [ ] **Step 3: 实现——AnthropicClient**

`AnthropicClient.complete`（第 227 行起）签名在 `on_token`（第 237 行）后加：

```python
        on_thinking: Callable[[str], None] | None = None,
```

第 285-288 行门控改为：

```python
            if on_token or on_thinking:
                content, tool_calls, usage, finish = await self._stream(kwargs, forced_tool, on_token, on_thinking)
            else:
                content, tool_calls, usage, finish = await self._nonstream(kwargs, forced_tool)
```

`_stream`（第 312-330 行）整体替换为：

```python
    async def _stream(self, kwargs: dict, forced_tool: str | None, on_token, on_thinking) -> tuple:
        content = ""
        tool_calls: list[dict[str, Any]] = []
        async with self._client.messages.stream(**kwargs) as stream:
            async for event in stream:
                delta = getattr(event, "delta", None)
                dtype = getattr(delta, "type", None)
                if dtype == "thinking_delta":
                    piece = getattr(delta, "thinking", None) or ""
                    if piece:
                        _safe_on_thinking(on_thinking, piece)
                elif dtype == "text_delta":
                    text = getattr(delta, "text", "") or ""
                    if text:
                        content += text
                        _safe_on_token(on_token, text)
            final = await stream.get_final_message()
        for block in final.content:
            if block.type == "tool_use":
                tool_calls.append({"id": block.id, "name": block.name, "arguments": block.input})
                if forced_tool and block.name == forced_tool:
                    content = json.dumps(block.input, ensure_ascii=False)
        usage = {
            "input_tokens": final.usage.input_tokens or 0,
            "output_tokens": final.usage.output_tokens or 0,
        }
        return content, tool_calls, usage, final.stop_reason
```

（原 `stream.text_stream` 只吐 text、thinking_delta 被静默丢弃；原始事件遍历后二者分道。）

- [ ] **Step 4: 实现——RoutingClient.complete 透传**

第 766 行 `on_token: ...` 后加参数，末尾 `return await self._client_for(model).complete(...)` 的 kwargs 里补一行：

```python
            on_thinking=on_thinking,
```

- [ ] **Step 5: 跑测试确认通过 + 全量回归**

Run: `uv run pytest ../SpecModule/llm/tests/ -q`
Expected: 全部 PASS

- [ ] **Step 6: 提交（SpecModule 仓库）**

```bash
git -C ../SpecModule add llm/client.py llm/tests/test_stream_thinking.py
git -C ../SpecModule commit -m "feat: Anthropic thinking_delta 透传 + RoutingClient on_thinking 透传"
```

### Task 3: LlmThinking 事件 + harness 发射 + stream.log thinking 记录

**Files:**
- Modify: `../SpecModule/module_harness/infra/events.py:35-37`（LlmToken 后加事件）
- Modify: `../SpecModule/module_harness/__init__.py:40,133`（import + `__all__`）
- Modify: `../SpecModule/module_harness/core/harness.py:20,163-186`（import + on_thinking 闭包 + complete 传参）
- Modify: `../SpecModule/module_harness/model/module.py:30,415,438-447`（import + 订阅 + 落盘分支）
- Modify: `../SpecModule/module_harness/infra/stream.py:12-17`（记录格式表）
- Modify: `../SpecModule/module_harness/tests/test_stream_log.py`（追加用例）

- [ ] **Step 1: 写失败测试**（追加到 `test_stream_log.py` 末尾；fake 类加在 `_ImageLLM` 后）

```python
class _ThinkingLLM:
    """思考通道 fake：先经 on_thinking 发思考块再走 on_token 正文。"""

    async def complete(self, *, prompt, on_token=None, on_thinking=None, **kw):
        if on_thinking:
            on_thinking("推演")
            on_thinking("片刻")
        for c in ("你", "好"):
            if on_token:
                on_token(c)
        return LLMResponse(content='{"ok": true}')


class TestThinkingChannel:
    @pytest.mark.asyncio
    async def test_thinking_records_in_stream_log(self, tmp_path, monkeypatch):
        mod = _harness_module(_ThinkingLLM(), tmp_path, monkeypatch)
        await mod.run()
        recs = _read_records(stream_log_path("mod_stream", tmp_path))
        th = [r for r in recs if r["type"] == "thinking"]
        assert [r["node"] for r in th] == ["A", "A"]
        assert "".join(r["chunk"] for r in th) == "推演片刻"
        # 顺序约束：thinking 先于正文 token（call_start < thinking < token < call_end）
        kinds = [r["type"] for r in recs]
        assert kinds.index("call_start") < kinds.index("thinking") < kinds.index("token")

    @pytest.mark.asyncio
    async def test_thinking_bus_event(self, tmp_path, monkeypatch):
        from module_harness import LlmThinking

        reg = HarnessRegistry(llm_client=_ThinkingLLM(), event_bus=EventBus())
        seen: list = []
        reg._event_bus.subscribe(LlmThinking, seen.append)
        mod = _harness_module(_ThinkingLLM(), tmp_path, monkeypatch, registry=reg)
        await mod.run()
        assert [e.chunk for e in seen] == ["推演", "片刻"]
        assert all(e.node == "A" and e.tick == 0 for e in seen)

    @pytest.mark.asyncio
    async def test_no_thinking_records_without_callback(self, tmp_path, monkeypatch):
        # 旧式 fake（complete 签名不收 on_thinking）→ 无 thinking 记录，其余行为不变
        mod = _harness_module(_StreamingLLM(["x"]), tmp_path, monkeypatch)
        await mod.run()
        recs = _read_records(stream_log_path("mod_stream", tmp_path))
        assert not [r for r in recs if r["type"] == "thinking"]
```

注意：`_harness_module` 的 registry 参数——先查其签名（第 79-101 行）：它内部自建 `HarnessRegistry(llm_client=llm, event_bus=EventBus())`，不接受 registry 注入。为支持第二个用例，给 `_harness_module` 加可选参数 `registry=None`，函数体内 `reg = registry or HarnessRegistry(llm_client=llm, event_bus=EventBus())`（`Module(registry=reg)` 不变）。

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest ../SpecModule/module_harness/tests/test_stream_log.py -v -k Thinking`
Expected: FAIL——`ImportError: cannot import name 'LlmThinking'`；通过不了的是事件不存在/无 thinking 记录

- [ ] **Step 3: 实现**

`events.py` 第 36-37 行（LlmToken 类体）之后加：

```python
@dataclass
class LlmThinking(HarnessEvent):
    """LLM 思考/推理增量（reasoning 通道；正文走 LlmToken）。"""
    chunk: str
```

`module_harness/__init__.py`：import 块（第 40 行 `LlmToken,` 处）加 `LlmThinking,`；`__all__`（第 133 行 `"LlmToken",` 处）加 `"LlmThinking",`。

`harness.py`：第 20 行 import 的 `LlmToken,` 后加 `LlmThinking,`；`on_token` 闭包（第 163-166 行）后加：

```python
            def on_thinking(chunk: str) -> None:
                bus.emit(LlmThinking(
                    timestamp=time.monotonic(), node=node, tick=0,
                    chunk=chunk,
                ))
```

`llm.complete(...)` 调用（第 179 行起）在 `on_token=on_token,` 后加一行 `on_thinking=on_thinking,`。

`module.py`：第 30 行区域 import 加 `LlmThinking,`；`_open_stream_log` 订阅元组（第 415 行）`LlmToken,` 后加 `LlmThinking,`；`_on_stream_event`（第 438-447 行）`LlmToken` 分支后加：

```python
        elif isinstance(event, LlmThinking):
            w.write({"type": "thinking", "node": event.node, "chunk": event.chunk})
```

`stream.py` 记录格式 docstring（第 12-17 行）在 `token` 行后加：

```
    {"type": "thinking",  "ts", "node", "chunk"}
```

并把首行说明「记录格式」处补一句「`thinking` 为推理通道增量（`LlmThinking` 事件；旧客户端无此通道时不产生）」。

- [ ] **Step 4: 跑测试确认通过 + harness/module 全量回归**

Run: `uv run pytest ../SpecModule/module_harness/tests/test_stream_log.py ../SpecModule/module_harness/tests/test_harness.py ../SpecModule/module_harness/tests/test_module.py -q`
Expected: 全部 PASS

- [ ] **Step 5: 提交（SpecModule 仓库）**

```bash
git -C ../SpecModule add module_harness/infra/events.py module_harness/__init__.py module_harness/core/harness.py module_harness/model/module.py module_harness/infra/stream.py module_harness/tests/test_stream_log.py
git -C ../SpecModule commit -m "feat: LlmThinking 事件——harness 思考通道发射 + stream.log thinking 记录落盘"
```

### Task 4: api.md 补录（SpecModule 仓库 docs 提交）

**Files:**
- Modify: `../SpecModule/docs/references/api.md`（「Module 运行」节 stream.log 句 + 「llm 引导」节表后）

- [ ] **Step 1: 补录**

「Module 运行」节（第 165-166 行）：

```
LLM 流式输出经 EventBus 订阅落盘 `stream.log`（JSONL，append-only：`run_start` 为每次执行
边界，后接 `call_start`/`token`/`thinking`/`call_end`/`call_error`；`ts` 为 wall-clock；
`EventBus.null()` 场景仅 `run_start`）；增量读走 `query.read_stream`。
```

（原列表 `call_start`/`token`/`call_end`/`call_error` 中插入 `thinking`。）

「llm 引导」节表格后追加一段：

```markdown
流式调用：`complete(..., on_token=None, on_thinking=None)`——提供任一回调即走流式接口。
`on_token` 收正文增量（原行为不变）；`on_thinking` 收思考/推理增量（OpenAI 兼容
`reasoning_content`/`reasoning` 方言 + content 内联 `<think>` 标签剥离——返回的
`LLMResponse.content` 不含思考文本；Anthropic `thinking_delta`）。回调异常不破主流程；
仅传 `on_token` 时思考增量静默丢弃（向后兼容）。对应 harness 事件 `LlmThinking`
（stream.log 记录 `{"type": "thinking", "ts", "node", "chunk"}`）。
```

- [ ] **Step 2: 提交（SpecModule 仓库，docs 独立提交）**

```bash
git -C ../SpecModule add docs/references/api.md
git -C ../SpecModule commit -m "docs: api.md 补录 on_thinking 流式通道与 LlmThinking/thinking 记录"
```

---

## Part 2 — 本仓库（webview）

### Task 5: server WS 0.2s 节奏 + thinking 记录透传测试

**Files:**
- Modify: `server/ws.py:20,36`（`_POLL_SECONDS` + docstring）
- Modify: `tests/test_ws.py`（追加用例）

- [ ] **Step 1: 写失败测试**（`TestStream` 类内追加）

```python
    def test_stream_records_include_thinking(self, base, client):
        """thinking 记录随 stream 消息透传（剥 off；node/chunk 字段原样）。"""
        run_id = "ws_think"
        seed_run(base, run_id, status={"module_id": run_id, "phase": "running", "updated_at": 1.0})
        self._write_stream_log(base, run_id, [
            json.dumps({"type": "run_start", "ts": 1.0, "pid": 1, "max_ticks": 100}) + "\n",
            json.dumps({"type": "thinking", "node": "A", "chunk": "推演"}) + "\n",
            json.dumps({"type": "token", "node": "A", "chunk": "答"}) + "\n",
        ])
        with client.websocket_connect(f"/api/runs/{run_id}/stream") as ws:
            stream_msg = ws.receive_json()
            assert stream_msg["type"] == "stream"
            assert [r["type"] for r in stream_msg["records"]] == ["run_start", "thinking", "token"]
            th = stream_msg["records"][1]
            assert th["node"] == "A" and th["chunk"] == "推演"
            assert all("off" not in r for r in stream_msg["records"])
```

- [ ] **Step 2: 跑测试**

Run: `uv run pytest tests/test_ws.py -v -k thinking`
Expected: PASS——透传是泛化的，本用例锚定该契约不被回归破坏（若 FAIL 则 server 层有人加了形状过滤，需修）。此测试先于实现写，目的是**锚定零改动契约**。

- [ ] **Step 3: 收紧轮询**

`server/ws.py` 第 20 行：

```python
_POLL_SECONDS = 0.2
```

第 32-37 行 docstring：把其中「v1 直接在事件循环内调用」一句改为「0.2s 拍直接在事件循环内调用（思考流式肉眼连续；status 按 sig 变化才推不变）」，其余（含「receive 竞速轮询间隔」句）原样保留。

- [ ] **Step 4: 全量回归 + 提交**

Run: `uv run pytest tests/ -q`
Expected: 全部 PASS

```bash
git add server/ws.py tests/test_ws.py
git commit -m "feat(web): WS 流推送收紧 0.2s + thinking 记录透传契约测试"
```

### Task 6: treechat 回合 SSE thinking 帧

**Files:**
- Modify: `tests/treechat/conftest.py:31-41`（FakeModuleClient 发 thinking）
- Modify: `treechat/module_bridge.py:14-16,94-98,118-122`（import + on_thinking + 订阅）
- Modify: `tests/treechat/test_module_bridge.py`（追加用例）

webapp `app.py` 零改动（`evt.pop("event")` 泛化转发；现有 webapp 测试已覆盖转发机制，不为新帧名单独加用例）。

- [ ] **Step 1: 写失败测试**（`test_module_bridge.py` 追加）

```python
def test_run_turn_emits_thinking_events(tmp_path, fake_module):
    """LlmThinking → SSE thinking 帧：原始文本透传，不经 FieldStreamShaper。"""
    conv, u2 = _conv(tmp_path)
    events = []
    out = _run(BUILT_IN["direct"], conv, u2, fake_module, on_event=events.append)
    think = [e for e in events if e["event"] == "thinking"]
    assert think and all(e["key"] and isinstance(e["text"], str) for e in think)
    assert "".join(e["text"] for e in think) == "思考过程。"
    # thinking 帧先于同节点正文 token 帧（思考在前）
    kinds = [e["event"] for e in events]
    assert kinds.index("thinking") < kinds.index("token")
```

fake 客户端改造（`conftest.py` FakeModuleClient.complete，第 36-40 行区域）：

```python
        on_thinking = kwargs.get("on_thinking")
        if on_thinking:
            on_thinking("思考过程。")
        on_token = kwargs.get("on_token")
```

（插在 `on_token = kwargs.get("on_token")` 之前；其余不变。）

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/treechat/test_module_bridge.py -v -k thinking`
Expected: FAIL——events 里没有 thinking 帧（module_bridge 未订阅 LlmThinking）

- [ ] **Step 3: 实现**

`treechat/module_bridge.py`：第 14-16 行 import 的 `LlmToken` 后加 `LlmThinking`；`on_token` 回调（第 94-98 行）后加：

```python
    def on_thinking(e) -> None:
        # 思考是原始文本非 JSON 字段——不经 FieldStreamShaper 直接透传
        on_event({"event": "thinking", "key": e.node, "text": e.chunk})
```

订阅区（第 118-122 行）`bus.subscribe(LlmToken, on_token)` 后加一行：

```python
    bus.subscribe(LlmThinking, on_thinking)
```

- [ ] **Step 4: 跑测试确认通过 + treechat 全量回归**

Run: `uv run pytest tests/treechat/ -q`
Expected: 全部 PASS（133+ 例）

- [ ] **Step 5: 提交**

```bash
git add treechat/module_bridge.py tests/treechat/conftest.py tests/treechat/test_module_bridge.py
git commit -m "feat(treechat): 回合 SSE thinking 帧——订阅 LlmThinking 原样透传思考文本"
```

### Task 7: run 视图前端——thinking 缓冲 + NodePanel 思考块

**Files:**
- Modify: `web/src/ws.ts:8-12,54-71,78`（StreamBuffer + 累积分派 + 初始化）
- Modify: `web/src/components/RunView.tsx:322-327,417-423`（liveThinking + props）
- Modify: `web/src/components/NodePanel.tsx`（props + 思考块渲染）

- [ ] **Step 1: ws.ts thinking 缓冲**

`StreamBuffer`（第 9-12 行）改为：

```ts
/** 流缓冲：按节点累积的流式文本/思考文本 + 版本号（每批消息自增，驱动订阅方 effect）。 */
export interface StreamBuffer {
  text: Record<string, string>;
  thinking: Record<string, string>;
  seq: number;
}
```

`data.type === "stream"` 处理（第 55-70 行）改为：

```ts
          setState((prev) => {
            if (!prev || prev.runId !== runId) return prev;
            const text = { ...prev.stream.text };
            const thinking = { ...prev.stream.thinking };
            let seq = prev.stream.seq;
            for (const r of data.records) {
              if (r.type === "run_start") {
                // 新执行边界：清空缓冲（resume 重跑的流从零开始显示）
                for (const k of Object.keys(text)) delete text[k];
                for (const k of Object.keys(thinking)) delete thinking[k];
                seq += 1;
              } else if (r.type === "token" && r.node) {
                text[r.node] = (text[r.node] ?? "") + (r.chunk ?? "");
                seq += 1;
              } else if (r.type === "thinking" && r.node) {
                thinking[r.node] = (thinking[r.node] ?? "") + (r.chunk ?? "");
                seq += 1;
              }
            }
            return { ...prev, stream: { text, thinking, seq } };
          });
```

status 分支的缓冲初值（第 78 行）`{ text: {}, seq: 0 }` → `{ text: {}, thinking: {}, seq: 0 }`。

- [ ] **Step 2: RunView liveThinking**

第 322-327 行改为：

```tsx
  const selectedNode = payload?.graph.nodes.find((n) => n.id === selected) ?? null;
  // 选中节点的流式文本/思考文本：仅 running 且流缓冲属于当前 run 时给出（终态后 outputs 接管）
  const liveText =
    statusView?.phase === "running" && streamState?.runId === runId && selectedNode
      ? streamState.stream.text[selectedNode.id]
      : undefined;
  const liveThinking =
    statusView?.phase === "running" && streamState?.runId === runId && selectedNode
      ? streamState.stream.thinking[selectedNode.id]
      : undefined;
```

`<NodePanel ...>` 调用（第 417-423 行）`liveText={liveText}` 后加一行：

```tsx
            liveThinking={liveThinking}
```

- [ ] **Step 3: NodePanel 思考块**

props（第 11-24 行）加 `liveThinking`：

```tsx
export function NodePanel({
  runId,
  node,
  outputs,
  liveText,
  liveThinking,
  onClose,
}: {
  runId: string;
  node: GraphNode;
  outputs: Record<string, unknown>;
  /** 该节点当前执行的流式文本（phase=running 且有 token 时非空；终态后由 outputs 接管） */
  liveText?: string;
  /** 该节点当前执行的思考文本（reasoning 通道；正文 token 到达后自动收起） */
  liveThinking?: string;
  onClose: () => void;
}) {
```

组件体加收起状态（`const [openTick, setOpenTick] = useState<number | null>(null);` 后）：

```tsx
  // 思考块展开态：null = 自动（思考中展开、正文到达收起）；用户点击后以手动为准
  const [thinkExpand, setThinkExpand] = useState<boolean | null>(null);
  useEffect(() => {
    setThinkExpand(null);
  }, [node.id]);
  const thinkAuto = !liveText;
  const thinkShown = liveThinking && (thinkExpand ?? thinkAuto);
```

自动滚动 effect（第 29-31 行）依赖加 liveThinking：

```tsx
  useEffect(() => {
    if (liveRef.current) liveRef.current.scrollTop = liveRef.current.scrollHeight;
  }, [liveText, liveThinking]);
```

渲染区：`{liveText ? (...) : null}`（第 62-74 行）替换为：

```tsx
        {liveText || liveThinking ? (
          <section>
            <h4 className="mb-1.5 mt-3 text-[12px] font-semibold">
              实时输出<span className="text-[11px] font-normal text-[var(--ph-running)]">（流式）</span>
            </h4>
            {liveThinking ? (
              <div className="mb-1.5">
                <button
                  className="text-left text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  onClick={() => setThinkExpand(!(thinkExpand ?? thinkAuto))}
                >
                  {thinkShown ? "▼ 思考中…" : `▶ 已思考 ${liveThinking.length} 字`}
                </button>
                {thinkShown ? (
                  <pre
                    ref={liveRef}
                    className="m-0 mt-1 max-h-[240px] overflow-y-auto whitespace-pre-wrap rounded-md border border-dashed bg-card p-2 text-[11.5px] italic text-muted-foreground"
                  >
                    {liveThinking.slice(-6000)}
                  </pre>
                ) : null}
              </div>
            ) : null}
            {liveText ? (
              <pre className="m-0 max-h-[240px] overflow-y-auto whitespace-pre-wrap rounded-md border bg-card p-2 text-[11.5px]">
                {liveText.slice(-10000)}
              </pre>
            ) : null}
          </section>
        ) : null}
```

（原 `liveRef` 挂到思考 pre 上；正文 pre 不需要自动滚动 ref。）

- [ ] **Step 4: 构建门禁**

Run: `cd web && npm run build`
Expected: tsc + vite build 通过

- [ ] **Step 5: 提交**

```bash
git add web/src/ws.ts web/src/components/RunView.tsx web/src/components/NodePanel.tsx
git commit -m "feat(web): run 视图思考块——ws thinking 缓冲 + NodePanel 流式思考渲染（正文到达自动收起）"
```

### Task 8: chat 前端——thinking 事件 + rAF 合帧 + RunBlock 思考行

**Files:**
- Modify: `web/src/chat/types.ts:92-98`（RunNodeState.thinking）
- Modify: `web/src/App.tsx`（合帧缓冲 + handleEvent thinking 分支 + start 分支 + 卸载清理）
- Modify: `web/src/chat/ChatView.tsx:115-145`（RunBlock 思考行）

- [ ] **Step 1: types.ts**

`RunNodeState`（第 92-98 行）加字段：

```ts
export interface RunNodeState {
  key: string;
  label: string;
  text: string;
  /** 思考通道累计文本（thinking 帧；正文到达后 UI 自动收起） */
  thinking: string;
  outcome: "running" | "ok" | "failed";
  refs: CardRef[];
}
```

- [ ] **Step 2: App.tsx 合帧缓冲**

组件内（`updRun` 定义之后、`handleEvent` 之前）加：

```tsx
  // ── 流式合帧：token/thinking 增量入 ref 缓冲，requestAnimationFrame 逐帧刷入
  // state（SSE 逐 token 到达，逐条 setState + 全文 Markdown 重解析会打爆渲染）──
  const pendingDeltaRef = useRef(new Map<string, Map<string, { text: string; thinking: string }>>());
  const rafRef = useRef<number | null>(null);

  const flushDeltas = useCallback(() => {
    rafRef.current = null;
    const pending = pendingDeltaRef.current;
    if (pending.size === 0) return;
    pendingDeltaRef.current = new Map();
    for (const [sid, deltas] of pending) {
      updRun(sid, (r) => r && { ...r, nodes: r.nodes.map((n) => {
        const d = deltas.get(n.key);
        if (!d) return n;
        return { ...n, text: n.text + d.text, thinking: n.thinking + d.thinking };
      }) });
    }
  }, [updRun]);

  const bufferDelta = useCallback((sid: string, key: string, kind: "text" | "thinking", chunk: string) => {
    let perSid = pendingDeltaRef.current.get(sid);
    if (!perSid) {
      perSid = new Map();
      pendingDeltaRef.current.set(sid, perSid);
    }
    const cur = perSid.get(key) ?? { text: "", thinking: "" };
    cur[kind] += chunk;
    perSid.set(key, cur);
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(flushDeltas);
  }, [flushDeltas]);

  useEffect(() => () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
  }, []);
```

（`useRef`/`useEffect` 已在现有 import 里，确认未引入则补。）

`handleEvent` 改动：

- `start` 分支（第 208-213 行）：nodes 映射加 `thinking: ""`，并在开头丢弃该 sid 的陈旧缓冲：

```tsx
    if (ev.event === "start") {
      pendingDeltaRef.current.delete(sid);
      updRun(sid, () => ({
        userSeq: d.userSeq, module: d.module, finished: false,
        nodes: d.nodes.map((n: { key: string; label: string }) => (
          { ...n, text: "", thinking: "", outcome: "running" as const, refs: [] })),
      }));
    }
```

- `token` 分支（第 211-213 行）改为合帧：

```tsx
    } else if (ev.event === "token") {
      bufferDelta(sid, d.key, "text", d.text);
    } else if (ev.event === "thinking") {
      bufferDelta(sid, d.key, "thinking", d.text);
    } else if (ev.event === "node_end") {
```

- `handleEvent` 的 `useCallback` 依赖数组（第 236 行）加 `bufferDelta`。

- [ ] **Step 3: ChatView RunBlock 思考行**

RunBlock 节点渲染（第 128-130 行区域），在 `{n.outcome === "running" && n.text && <Markdown text={n.text} />}` 之前插入：

```tsx
            {/* 思考行：思考中流式展示（斜体低强调），正文到达自动收起 */}
            {n.outcome === "running" && n.thinking && !n.text && (
              <div className="whitespace-pre-wrap border-l-2 border-border pl-2 text-[11.5px] italic text-muted-foreground">
                {n.thinking.slice(-800)}
              </div>
            )}
```

- [ ] **Step 4: 构建门禁**

Run: `cd web && npm run build`
Expected: tsc + vite build 通过

- [ ] **Step 5: 提交**

```bash
git add web/src/chat/types.ts web/src/App.tsx web/src/chat/ChatView.tsx
git commit -m "feat(web): chat 回合思考行 + token/thinking rAF 合帧（防逐 token 重渲染风暴）"
```

### Task 9: roadmap 变更日志 + 全量验证 + 手动冒烟

**Files:**
- Modify: `roadmap.md`（变更日志节追加）

- [ ] **Step 1: 追加 roadmap 变更日志条目**（沿用现有条目格式，写明两仓提交号——执行时回填实际 hash）：

```markdown
- 2026-09-18 LLM 思考通道全链路真流式：上游 SpecModule `complete(on_thinking=)` 双回调
  （OpenAI 兼容 reasoning_content/reasoning 方言 + 内联 <think> 剥离 + Anthropic
  thinking_delta，SpecModule <hash-a>/<hash-b>/<hash-c>，api.md 已补录 <hash-d>）；
  harness LlmThinking 事件 → stream.log thinking 记录 → server WS 泛化透传（推送节奏
  1s→0.2s）→ NodePanel 思考块（正文到达自动收起）；treechat 回合 SSE thinking 帧 →
  ChatView 思考行 + rAF 合帧。设计：docs/superpowers/specs/2026-09-18-llm-thinking-streaming-design.md
```

- [ ] **Step 2: 全量验证**

Run: `uv run pytest tests/ -q`
Expected: 全部 PASS
Run: `cd web && npm run build`
Expected: 通过
Run: `uv run pytest ../SpecModule/module_harness/tests/ -q -m "not smoke"`
Expected: 库基线全绿（合并前基线）

- [ ] **Step 3: 手动端到端冒烟**（需 `.env` 有 DEEPSEEK_API_KEY；跳过不影响提交）

```bash
uv run uvicorn server.app:app --reload --port 8000   # 终端 1
cd web && npm run dev                                 # 终端 2
```

浏览器 `http://localhost:5173` → modules → academic_writer 发起运行（含 think 模型）→ 选中节点：思考期思考块斜体流式生长，正文到达自动收起为「已思考 N 字」；chat 页签发起对话同验思考行。确认后停两个进程。

- [ ] **Step 4: 提交**

```bash
git add roadmap.md
git commit -m "docs: roadmap 变更日志——LLM 思考通道全链路真流式（上游 on_thinking + 两消费端思考块）"
```

---

## 任务依赖与执行顺序

Task 1 → 2 → 3 → 4 串行（同文件递进、同仓库提交）。Task 5 依赖 Task 3（thinking 记录形状）。Task 6 依赖 Task 3。Task 7 依赖 Task 5（缓冲字段）。Task 8 独立于 7（可并行）。Task 9 收尾。全序：1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9。
