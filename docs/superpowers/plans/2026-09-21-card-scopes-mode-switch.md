# 卡片双层作用域 + 会话内模式切换 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TreeChat 卡片分「节点卡/全局卡」双层（模块文档逐轮版本化挂轮，分支取分支点时点版本），模式支持会话内切换（chip + 斜杠 + 逐轮记录 + done 自动直答），前端卡片迁入右侧边栏。

**Architecture:** `CardCreate` 事件增可选字段 `owner_seq`/`doc_key`（旧文件缺省即全局卡，零迁移）；grilling 文档从固定 ID 覆盖改为逐轮追加节点卡（确定性 ID `doc:<key>@<seq>`）；`Conversation.doc_body` 沿路径取最近祖先版本（legacy `spec:*` 全局卡回退）。前端 chat 页改三段式，卡片功能整体迁入新增的右侧边栏。

**Tech Stack:** Python 3.10+ / FastAPI / pytest+httpx（后端）；Vite+React+TS+Tailwind / Radix（前端，无测试设施，验收门 `npm run build`）。

**Spec:** `docs/superpowers/specs/2026-09-21-card-scopes-mode-switch-design.md`

**测试约定：** 后端每步跑 `uv run pytest tests/treechat/<file> -q`（在仓库根执行）；全量 `uv run pytest tests/ -q`。测试垃圾只落 `tmp_path`。

---

### Task 1: 事件模型扩展 + 序列化放松（events.py）

**Files:**
- Modify: `treechat/core/events.py`
- Test: `tests/treechat/test_events.py`

- [ ] **Step 1: 写失败测试**——追加到 `tests/treechat/test_events.py`：

```python
def test_old_card_create_without_optional_fields_loads():
    """旧格式 card_create（无 owner_seq/doc_key）→ 缺省全局卡，重放零迁移。"""
    seq, ev = event_from_dict({
        "seq": 5, "type": "card_create", "card_id": "card_a", "title": "t",
        "body": "b", "from_path": [2],
    })
    assert seq == 5
    assert ev.owner_seq is None and ev.doc_key == ""


def test_old_user_msg_without_module_loads():
    seq, ev = event_from_dict({"seq": 2, "type": "user_msg", "parent": None, "text": "问"})
    assert ev.module == ""


def test_card_create_owner_fields_roundtrip():
    ev = CardCreate(card_id="doc:tree@2", title="设计树", body="# 树", from_path=[],
                    owner_seq=2, doc_key="tree")
    d = event_to_dict(seq=9, event=ev)
    assert d["owner_seq"] == 2 and d["doc_key"] == "tree"
    seq, back = event_from_dict(d)
    assert back == ev


def test_user_msg_module_roundtrip():
    ev = UserMsg(parent=None, text="问", module="grilling")
    _seq, back = event_from_dict(event_to_dict(seq=3, event=ev))
    assert back == ev
```

（`CardCreate`/`UserMsg` 已在文件头部导入则不用重复；没有则补。）

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/treechat/test_events.py -q`
Expected: FAIL（`CardCreate.__init__() got an unexpected keyword argument 'owner_seq'` / 断言失败）

- [ ] **Step 3: 实现**——`treechat/core/events.py` 三处修改：

`UserMsg` 增字段：

```python
@dataclass
class UserMsg:
    parent: int | None
    text: str
    module: str = ""
    """本轮实际使用的模式 key（空 = complete 时按会话 category 解析；旧文件缺省）。"""
```

`CardCreate` 增字段：

```python
@dataclass
class CardCreate:
    card_id: str
    title: str
    body: str
    from_path: list[int]
    instruction: str = ""
    created_at: str = ""
    owner_seq: int | None = None
    """节点卡归属轮 seq；None = 全局卡（旧文件缺省即全局）。"""
    doc_key: str = ""
    """模块文档标识（非空 = 文档版本节点卡）；用户卡恒为空串。"""
```

`event_from_dict` 的缺字段校验放松为「**必填字段**缺失才报错」（有默认值的字段允许缺席——旧文件兼容的关键）：

```python
    names = {f.name for f in dc_fields(cls)}
    kwargs = {k: v for k, v in d.items() if k not in ("seq", "type")}
    required = {f.name for f in dc_fields(cls)
                if f.default is MISSING and f.default_factory is MISSING}
    missing = required - kwargs.keys()
```

（头部导入改为 `from dataclasses import MISSING, asdict, dataclass, field, fields as dc_fields`；`field` 若原本未用可去掉。）

现有 `test_missing_field_rejected`（user_msg 缺 `text`）不受影响——`text` 是必填字段；`test_extra_field_rejected` 的多余字段严格性保持不变。

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/treechat/test_events.py tests/treechat/test_store.py tests/treechat/test_conversation.py -q`
Expected: 全 PASS（store/conversation 全量重放路径不受放松影响）

- [ ] **Step 5: Commit**

```bash
git add treechat/core/events.py tests/treechat/test_events.py
git commit -m "feat(treechat): card_create 增 owner_seq/doc_key、user_msg 增 module——可选字段缺省兼容旧文件"
```

---

### Task 2: 卡片模型（cards.py——Card 归属字段、节点卡 pin 拒绝、确定性文档卡 ID）

**Files:**
- Modify: `treechat/core/cards.py`
- Test: `tests/treechat/test_cards.py`

- [ ] **Step 1: 写失败测试**——追加到 `tests/treechat/test_cards.py`：

```python
def test_node_card_pin_rejected():
    reg = CardRegistry()
    reg.add(Card(id="doc:tree@2", title="设计树", body="# 树",
                 owner_seq=2, doc_key="tree"), pinned=False)
    with pytest.raises(TreeChatError, match="节点卡不支持 pin"):
        reg.pin("doc:tree@2")
    assert reg.pinned_cards() == []


def test_doc_card_id_deterministic():
    assert doc_card_id("tree", 12) == "doc:tree@12"
    assert doc_card_id("glossary", 3) == "doc:glossary@3"


def test_card_is_node_property():
    assert Card(id="doc:tree@2", title="t", body="b", owner_seq=2).is_node
    assert not Card(id="card_x", title="t", body="b").is_node
```

（文件头部按需补导入：`from treechat.core.cards import Card, CardRegistry, doc_card_id`、`from treechat.core.errors import TreeChatError`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/treechat/test_cards.py -q`
Expected: FAIL（ImportError: `doc_card_id`）

- [ ] **Step 3: 实现**——`treechat/core/cards.py` 全文替换为：

```python
"""卡片模型与注册表——全局卡（会话级、pin 注入）+ 节点卡（挂轮、沿路径取版本）。"""
from __future__ import annotations

from dataclasses import dataclass, field

from .errors import TreeChatError


def doc_card_id(doc_key: str, seq: int) -> str:
    """节点文档卡确定性 ID：重放幂等、UI key 稳定、与 card_ 随机 ID 天然不冲突。"""
    return f"doc:{doc_key}@{seq}"


@dataclass
class Card:
    """上下文产出卡片。body 必须自包含（提炼 prompt 的硬约束）。

    owner_seq=None = 全局卡（pin 语义照旧）；owner_seq=seq = 节点卡（作用域由
    树位置决定，不支持 pin）。doc_key 非空 = 模块文档版本节点卡。
    """

    id: str
    title: str
    body: str
    from_path: list[int] = field(default_factory=list)
    instruction: str = ""
    created_at: str = ""
    owner_seq: int | None = None
    doc_key: str = ""

    @property
    def is_node(self) -> bool:
        return self.owner_seq is not None


class CardRegistry:
    """id → Card + pinned 状态。card_create 事件默认 pinned（全局卡；节点卡恒不 pin）。"""

    def __init__(self) -> None:
        self._cards: dict[str, Card] = {}
        self._pinned: set[str] = set()

    def add(self, card: Card, *, pinned: bool = True) -> None:
        if card.id in self._cards:
            raise TreeChatError(f"卡片 id 重复: {card.id}")
        self._cards[card.id] = card
        if pinned and not card.is_node:
            self._pinned.add(card.id)

    def pin(self, card_id: str) -> None:
        card = self._require(card_id)
        if card.is_node:
            raise TreeChatError(f"节点卡不支持 pin: {card_id}（作用域由树位置决定）")
        self._pinned.add(card_id)

    def unpin(self, card_id: str) -> None:
        self._require(card_id)
        self._pinned.discard(card_id)

    def update(self, card_id: str, title: str, body: str) -> None:
        """整体替换标题与正文（card_edit 重放语义）。"""
        card = self.get(card_id)
        card.title, card.body = title, body

    def remove(self, card_id: str) -> Card:
        """删除卡片并移除 pin 状态（card_delete 重放语义）。返回被删卡片。"""
        card = self._require(card_id)
        self._pinned.discard(card_id)
        return self._cards.pop(card_id)

    def get(self, card_id: str) -> Card:
        self._require(card_id)
        return self._cards[card_id]

    def pinned_cards(self) -> list[Card]:
        return [c for cid, c in self._cards.items() if cid in self._pinned]

    def is_pinned(self, card_id: str) -> bool:
        return card_id in self._pinned

    def all_cards(self) -> list[Card]:
        return list(self._cards.values())

    def ids(self) -> set[str]:
        return set(self._cards)

    def _require(self, card_id: str) -> Card:
        if card_id not in self._cards:
            raise TreeChatError(f"未知卡片: {card_id}")
        return self._cards[card_id]
```

要点：`add` 里 `pinned and not card.is_node` 双保险（即使调用方误传 pinned=True，节点卡也不进 pin 集）。

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/treechat/test_cards.py -q`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add treechat/core/cards.py tests/treechat/test_cards.py
git commit -m "feat(treechat): 卡片双层模型——Card 增归属轮/doc_key，节点卡 pin 拒绝，确定性文档卡 ID"
```

---

### Task 3: Conversation——节点卡重放/追加 + 逐轮模式 + doc_body 版本解析

**Files:**
- Modify: `treechat/core/conversation.py`
- Test: `tests/treechat/test_conversation.py`

- [ ] **Step 1: 写失败测试**——追加到 `tests/treechat/test_conversation.py`（按文件现有导入风格补 `from treechat.core.cards import doc_card_id`、`pytest`、`TreeChatError`）：

```python
def _conv_with_doc(tmp_path):
    """主干两轮 + 第一轮产出 tree v1 的标准夹具。"""
    conv = Conversation.create(tmp_path / "s.jsonl", name="t")
    u1 = conv.append_user("第一问")
    conv.add_card("设计树", "# 树-v1", from_path=[], owner_seq=u1, doc_key="tree",
                  card_id=doc_card_id("tree", u1))
    conv.append_assistant(u1, "第一答")
    u2 = conv.append_user("第二问")
    return conv, u1, u2


def test_user_msg_records_module(tmp_path):
    conv = Conversation.create(tmp_path / "s1.jsonl", name="t")
    u = conv.append_user("问", module="grilling")
    assert conv.nodes[u].module == "grilling"
    conv2 = Conversation.open(tmp_path / "s1.jsonl")  # 重放同一性
    assert conv2.nodes[u].module == "grilling"


def test_add_card_node_doc_replay(tmp_path):
    conv = Conversation.create(tmp_path / "s2.jsonl", name="t")
    u = conv.append_user("问")
    cid = conv.add_card("设计树", "# 树", from_path=[], owner_seq=u, doc_key="tree",
                        card_id=doc_card_id("tree", u))
    assert cid == "doc:tree@2"
    conv2 = Conversation.open(tmp_path / "s2.jsonl")
    c = conv2.cards.get("doc:tree@2")
    assert c.owner_seq == 2 and c.doc_key == "tree"
    assert not conv2.cards.is_pinned("doc:tree@2")  # 节点卡恒不 pin


def test_add_card_owner_missing_node_raises_without_event(tmp_path):
    conv = Conversation.create(tmp_path / "s3.jsonl", name="t")
    with pytest.raises(TreeChatError, match="归属节点不存在"):
        conv.add_card("t", "b", from_path=[], owner_seq=99)
    assert len(conv.store.load()) == 1  # 只有 meta——毒事件未落盘


def test_doc_body_branch_takes_fork_point_version(tmp_path):
    """核心保证①：从上游开分支 = 拿分支点时点版本，而非最新覆盖。"""
    conv, u1, u2 = _conv_with_doc(tmp_path)
    conv.add_card("设计树", "# 树-v2", from_path=[], owner_seq=u2, doc_key="tree",
                  card_id=doc_card_id("tree", u2))
    conv.set_pointer(u1)
    ub = conv.append_user("分支提问")
    assert conv.nodes[ub].parent == u1
    assert conv.doc_body("tree", ub) == "# 树-v1"


def test_doc_body_leaf_empty(tmp_path):
    """核心保证②：叶子无祖先 → 无文档（真·无上下文）。"""
    conv, _u1, _u2 = _conv_with_doc(tmp_path)
    leaf = conv.append_user("叶子", leaf=True)
    assert conv.doc_body("tree", leaf) == ""


def test_doc_body_skips_self_and_uses_nearest_ancestor(tmp_path):
    """核心保证③：模式往返不丢卡——中间直答轮无版本，回退到最近 grill 版本；
    且不含 seq 自身（文档由本轮回答产出）。"""
    conv, u1, _u2 = _conv_with_doc(tmp_path)
    conv.append_user("直答一")
    conv.append_user("直答二")
    un = conv.append_user("继续")
    assert conv.doc_body("tree", un) == "# 树-v1"


def test_doc_body_legacy_global_fallback(tmp_path):
    conv = Conversation.create(tmp_path / "s4.jsonl", name="t")
    u = conv.append_user("问")
    conv.add_card("设计树", "# 旧树", from_path=[], card_id="spec:tree")
    assert conv.doc_body("tree", u) == "# 旧树"
    assert conv.doc_body("glossary", u) == ""  # 无回退源 → 空串


def test_doc_body_node_version_beats_legacy(tmp_path):
    conv, _u1, _u2 = _conv_with_doc(tmp_path)
    conv.add_card("设计树", "# 旧树", from_path=[], card_id="spec:tree")
    assert conv.doc_body("tree", conv.append_user("续")) == "# 树-v1"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/treechat/test_conversation.py -q`
Expected: FAIL（`append_user() got an unexpected keyword argument 'module'` 等）

- [ ] **Step 3: 实现**——`treechat/core/conversation.py` 五处修改：

① `MsgNode` 增字段：

```python
@dataclass
class MsgNode:
    """轮次节点（一问一答）。id = seq（user_msg 事件行号）；output=None = 悬而未答。

    label = 用户命名（node_rename 事件派生）；module = 本轮实际模式 key（空 = 会话默认）。
    """

    seq: int
    parent: int | None
    input: str
    output: str | None = None
    model: str = ""
    label: str = ""
    module: str = ""
```

② `_apply` 两处——`UserMsg` 传 module、`CardCreate` 传归属：

```python
            case UserMsg():
                self._add_node(seq, ev.parent, ev.text, module=ev.module)
```
```python
            case CardCreate():
                self.cards.add(Card(
                    id=ev.card_id, title=ev.title, body=ev.body,
                    from_path=list(ev.from_path), instruction=ev.instruction,
                    created_at=ev.created_at,
                    owner_seq=ev.owner_seq, doc_key=ev.doc_key,
                ), pinned=ev.owner_seq is None)
```

③ `_add_node` 与 `append_user`：

```python
    def _add_node(self, seq: int, parent: int | None, text: str,
                  module: str = "") -> None:
        if parent is not None and parent not in self.nodes:
            # 旧格式兼容：user_msg 的 parent 指向 assistant 节点 seq（旧指针语义）
            parent = self.legacy.get(parent)
        if parent is not None and parent not in self.nodes:
            raise TreeChatError(f"parent 指向不存在的节点: seq={seq} parent={parent}")
        self.nodes[seq] = MsgNode(seq=seq, parent=parent, input=text, module=module)
        self.children.setdefault(parent, []).append(seq)
```
```python
    def append_user(self, text: str, *, leaf: bool = False,
                    module: str = "") -> int:
        """追加 user_msg：默认 parent=指针；leaf=True 强制 parent=None。

        module = 本轮使用的模式 key（空 = complete 时按会话 category 解析）。
        """
        target = None if leaf else self.pointer
        ev = UserMsg(parent=target, text=text, module=module)
        seq = self.store.append(ev)
        self._apply(seq, ev)
        return seq
```

④ `add_card` 增归属参数（先验证再落盘，防毒事件）：

```python
    def add_card(self, title: str, body: str, from_path: list[int],
                 instruction: str = "", card_id: str | None = None, *,
                 owner_seq: int | None = None, doc_key: str = "") -> str:
        """追加 card_create，返回 card_id。

        owner_seq=None = 全局卡（默认 pinned）；owner_seq=seq = 节点卡（恒不 pin）。
        card_id 显式指定时原样落盘（节点文档卡固定 doc:<key>@<seq>）；None 走 _new_card_id。
        """
        if owner_seq is not None and owner_seq not in self.nodes:
            raise TreeChatError(f"卡片归属节点不存在: {owner_seq}")
        ev = CardCreate(
            card_id=card_id or _new_card_id(self.cards.ids()), title=title, body=body,
            from_path=list(from_path), instruction=instruction, created_at=_now(),
            owner_seq=owner_seq, doc_key=doc_key,
        )
        seq = self.store.append(ev)
        self._apply(seq, ev)
        return ev.card_id
```

⑤ 视图区（`fork_point` 之后）新增 `doc_body`：

```python
    def doc_body(self, doc_key: str, seq: int) -> str:
        """文档正文解析：路径上最近祖先的同 doc_key 节点卡 → 旧全局 spec: 卡回退 → 空串。

        路径不含 seq 自身——文档由本轮的回答产出，提问时只有祖先版本可用。
        三条推论（测试钉死）：分支 = 从 #K 开新轮拿 #K 时点版本；叶子 = 路径空 → 无文档；
        中间直答轮不产生版本也不打断回溯（模式往返不丢卡）。
        """
        versions = {c.owner_seq: c.body for c in self.cards.all_cards()
                    if c.doc_key == doc_key and c.owner_seq is not None}
        for node in reversed(self.path_to(seq)[:-1]):
            if node.seq in versions:
                return versions[node.seq]
        try:
            return self.cards.get(f"spec:{doc_key}").body
        except TreeChatError:
            return ""
```

⑥ **`pin` 防毒事件守卫**（Task 2 质量审查发现的计划缺口，2026-09-21 修订）：现有预检
只验证存在性——节点卡会通过预检但 `_apply` 时 `CardRegistry.pin` 必抛，而 `Pin` 事件已
先落盘 → 重放必失败、会话文件锁死。`pin` 方法整体替换为：

```python
    def pin(self, card_id: str) -> None:
        card = self.cards.get(card_id)  # 先验证再落盘：失败不落事件（否则重放必失败的毒事件会锁死文件）
        if card.is_node:
            raise TreeChatError(f"节点卡不支持 pin: {card_id}（作用域由树位置决定）")
        self._append_apply(Pin(card_id=card_id))
```

对应测试（Step 1 一并追加）：

```python
def test_pin_node_card_raises_without_event(tmp_path):
    """pin 节点卡：预检拒绝、不落事件（毒事件防线）。"""
    conv = Conversation.create(tmp_path / "s5.jsonl", name="t")
    u = conv.append_user("问")
    cid = conv.add_card("设计树", "# 树", from_path=[], owner_seq=u, doc_key="tree",
                        card_id=doc_card_id("tree", u))
    with pytest.raises(TreeChatError, match="节点卡不支持 pin"):
        conv.pin(cid)
    assert len(conv.store.load()) == 3  # meta + user + card，Pin 未落盘
```

（连带补 Task 2 审查的 Minor：`tests/treechat/test_cards.py` 追加注册表双保险测试）

```python
def test_registry_add_node_card_ignores_pinned_true():
    reg = CardRegistry()
    reg.add(Card(id="doc:tree@2", title="t", body="b", owner_seq=2), pinned=True)
    assert reg.pinned_cards() == []
```

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/treechat/test_conversation.py tests/treechat/test_events.py tests/treechat/test_cards.py -q`
Expected: 全 PASS（既有的 `spec:tree` 显式 card_id 测试不受影响——全局卡语义未变）

- [ ] **Step 5: Commit**

```bash
git add treechat/core/conversation.py tests/treechat/test_conversation.py
git commit -m "feat(treechat): Conversation 节点卡重放/追加 + 逐轮模式记录 + doc_body 沿路径版本解析"
```

---

### Task 4: DocumentDef 改 doc_key（base.py + grilling.py）

**Files:**
- Modify: `treechat/modules/base.py`、`treechat/modules/grilling.py`
- Test: `tests/treechat/test_modules.py`

- [ ] **Step 1: 改失败测试**——`tests/treechat/test_modules.py` 第 140-141 行替换为：

```python
    assert {d.key for d in g.documents} == {"tree", "glossary"}
    assert g.node_docs["TreeUpdate"] == ["tree"]
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/treechat/test_modules.py -q`
Expected: FAIL（`DocumentDef` has no attribute `key`）

- [ ] **Step 3: 实现**——`treechat/modules/base.py` 的 `DocumentDef` 替换为：

```python
@dataclass(frozen=True)
class DocumentDef:
    """模块维护的一份共同文档 → 每轮产出一张节点卡（doc_key 沿路径取版本）。"""

    key: str      # 文档标识（节点卡 doc_key；上下文沿路径解析的锚）
    field: str    # 归一化输出中的文档字段名
    title: str
```

`treechat/modules/grilling.py` 的 `GRILLING` 定义中两处替换：

```python
    node_docs={"TreeUpdate": ["tree"], "Resolution": ["glossary"]},
    ...
    documents=[DocumentDef(key="tree", field="tree_md", title="设计树"),
               DocumentDef(key="glossary", field="glossary_md",
                           title="CONTEXT 词表草稿")],
```

然后清理残余引用——确认没有别处用 `DocumentDef(card_id=...)` 或 `.card_id`：

Run: `grep -rn "DocumentDef(" treechat/ && grep -rn "\.card_id\|card_id=" treechat/modules/`
Expected: 只剩 key 形态；`treechat/module_bridge.py` 的引用由 Task 5 处理（此时该文件仍引用 `d.card_id` 会挂，属预期中间态——Task 4、5 连续执行后跑测试）

- [ ] **Step 4: Commit**（中间态不跑全量，Task 5 收口）

```bash
git add treechat/modules/base.py treechat/modules/grilling.py tests/treechat/test_modules.py
git commit -m "refactor(treechat): DocumentDef.card_id → doc_key，grilling 文档键 tree/glossary"
```

---

### Task 5: module_bridge——文档沿路径解析 + pinned 按归属过滤 + doc refs

**Files:**
- Modify: `treechat/module_bridge.py`
- Test: `tests/treechat/test_module_bridge.py`

- [ ] **Step 1: 更新测试**——`tests/treechat/test_module_bridge.py`：

① `test_build_spec_injects_document_fields_from_spec_cards`（第 34 行起）改名为
`test_build_spec_document_fields_resolve` 并替换实现（覆盖两条解析路径）：

```python
def test_build_spec_document_fields_resolve(tmp_path):
    """文档字段：路径上节点卡版本优先（grilling 主路径）。"""
    conv, u2 = _conv(tmp_path)
    conv.add_card("设计树", "# 树-节点版", from_path=[], owner_seq=2, doc_key="tree",
                  card_id=doc_card_id("tree", 2))
    spec = build_spec(BUILT_IN["grilling"], conv, u2,
                      TokenWindowStrategy(budget_tokens=10_000))
    assert spec["tree_md"] == "# 树-节点版"
    assert spec["glossary_md"] == ""  # 路径无版本且无 legacy → 空串


def test_build_spec_document_fields_legacy_global_fallback(tmp_path):
    """旧会话兼容：路径无节点版本时回退读旧全局 spec: 卡。"""
    conv, u2 = _conv(tmp_path)
    conv.add_card("设计树", "# 用户手改的树", from_path=[], card_id="spec:tree")
    conv.add_card("CONTEXT 词表草稿", "**Order**: 订单", from_path=[], card_id="spec:glossary")
    spec = build_spec(BUILT_IN["grilling"], conv, u2,
                      TokenWindowStrategy(budget_tokens=10_000))
    assert spec["tree_md"] == "# 用户手改的树"
    assert spec["glossary_md"] == "**Order**: 订单"
```

② `test_run_turn_grilling_documents_and_events` 中 documents 与 refs 断言替换（第 128-139 行区域）：

```python
    assert {c: (t, b) for c, t, b in out.documents} == {
        "tree": ("设计树", "# 树-v1"),
        "glossary": ("CONTEXT 词表草稿", "**Order**: 订单"),
    }
```
```python
    ends = {e["key"]: e["refs"] for e in events if e["event"] == "node_end"}
    assert ends["TreeUpdate"] == [{"type": "doc", "docKey": "tree", "title": "设计树"}]
    assert ends["Resolution"] == [{"type": "doc", "docKey": "glossary",
                                   "title": "CONTEXT 词表草稿"}]
```

③ `test_run_turn_document_message_field_is_declared_by_module` 末行断言（第 155 行）替换：

```python
    assert [key for key, _, _ in out.documents] == ["tree", "glossary"]
```

④ 新增 pinned 归属过滤测试：

```python
def test_build_spec_pinned_injection_excludes_node_cards(tmp_path):
    """全局卡 pin 注入照旧；节点卡不进 system（文档走模块 spec 字段，防双份注入）。"""
    conv, u2 = _conv(tmp_path)
    conv.add_card("全局参考", "全局正文", from_path=[])           # 全局卡，默认 pinned
    conv.add_card("设计树", "# 树-节点版", from_path=[], owner_seq=2,
                  doc_key="tree", card_id=doc_card_id("tree", 2))
    spec = build_spec(BUILT_IN["grilling"], conv, u2,
                      TokenWindowStrategy(budget_tokens=10_000))
    assert "全局正文" in spec["history"]        # system 进 history 首段
    assert spec["history"].count("# 树-节点版") == 0  # 节点卡不入转录
    assert spec["tree_md"] == "# 树-节点版"
```

（头部按需补 `from treechat.core.cards import doc_card_id`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/treechat/test_module_bridge.py -q`
Expected: FAIL（documents 键还是 spec:tree / refs 还是 cardId）

- [ ] **Step 3: 实现**——`treechat/module_bridge.py` 四处修改：

① `TurnOutcome.documents` 注释更新：

```python
    documents: list[tuple[str, str, str]] = dc_field(default_factory=list)
    """[(doc_key, title, body)] —— session 落盘为该轮的文档版本节点卡。"""
```

② `build_spec` 替换：

```python
def build_spec(module: ConversationalModule, conv, user_seq: int, window) -> dict[str, Any]:
    """组装 spec：brief 原话 + history 裁剪转录 + 文档字段（沿路径最近节点卡版本）。

    TokenWindowStrategy 的裁剪职责在此接管（窗口选择沿用现策略，出口为转录）。
    全局 pinned 卡注入 system；节点卡不进 system——文档经模块自己的 spec 字段进
    prompt（防双份注入）；旧会话的 spec:* 全局卡由 doc_body 回退读取。
    """
    pinned = [c for c in conv.cards.pinned_cards() if c.owner_seq is None]
    ctx = assemble(conv.path_to(user_seq), conv.system, pinned, strategy=window)
    lines: list[str] = []
    if ctx.system:
        lines.append("## 系统设定\n" + ctx.system)
    for m in ctx.history:
        lines.append(f"[{m['role']}] {m['content']}")
    spec: dict[str, Any] = {"brief": ctx.current, "history": "\n\n".join(lines)}
    for doc in module.documents:
        spec[doc.field] = conv.doc_body(doc.key, user_seq)
    return spec
```

（`from .core.errors import TreeChatError` 若只剩此处使用则删除导入。）

③ `run_turn` 中 `doc_titles` 与 refs：

```python
    doc_titles = {d.key: d.title for d in module.documents}
```
```python
        refs = [{"type": "doc", "docKey": cid, "title": doc_titles.get(cid, cid)}
                for cid in module.node_docs.get(e.node, [])]
```

④ 末尾 documents 组装：

```python
    documents = [(d.key, d.title, str(value.get(d.field, "") or ""))
                 for d in module.documents if str(value.get(d.field, "") or "").strip()]
```

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/treechat/test_module_bridge.py tests/treechat/test_modules.py -q`
Expected: 全 PASS（Task 4+5 连续执行后的收口验证；原 37-49 行的 spec 卡测试已被新测试取代则删旧留新）

- [ ] **Step 5: Commit**

```bash
git add treechat/module_bridge.py tests/treechat/test_module_bridge.py
git commit -m "feat(treechat): build_spec 文档沿路径解析 + pinned 按归属过滤；回合输出 doc_key 与 doc refs"
```

---

### Task 6: session——逐轮模式/retry 锁定 + 文档节点卡落盘 + done 自动直答

**Files:**
- Modify: `treechat/session.py`
- Test: `tests/treechat/test_session.py`

- [ ] **Step 1: 更新测试**——`tests/treechat/test_session.py`：

① 替换 `test_complete_dispatch_grilling_creates_spec_cards`（第 173 行起）为：

```python
def test_complete_dispatch_grilling_writes_node_doc_cards(tmp_path, fake_module, fake_card_client):
    s = _session(tmp_path, fake_module, fake_card_client)
    s.conversation.set_category("grilling")
    fake_module.responses = [
        "# 树-v1",
        json.dumps({"questions_md": "❓ Q1", "done": False, "terms_md": ""}),
        json.dumps({"glossary_md": "**Order**: 订单", "adr_candidates": ""}),
    ]
    a = asyncio.run(s.turn("做一个订单系统"))
    tree = s.conversation.cards.get(f"doc:tree@{a}")
    assert tree.owner_seq == a and tree.doc_key == "tree" and tree.body == "# 树-v1"
    assert not s.conversation.cards.is_pinned(f"doc:tree@{a}")
    assert s.conversation.cards.get(f"doc:glossary@{a}").body == "**Order**: 订单"
    assert s.conversation.nodes[a].output == "❓ Q1"
```

② 替换 `test_spec_card_refresh_edits_and_prompts_read_card_body`（第 188 行起）为
（语义平移：逐轮版本 + 用户直填改版本 + 下一轮读到改后版本）：

```python
def test_doc_version_edit_feeds_next_turn(tmp_path, fake_module, fake_card_client):
    s = _session(tmp_path, fake_module, fake_card_client)
    s.conversation.set_category("grilling")
    fake_module.responses = [
        "# 树-v1",
        json.dumps({"questions_md": "Q1", "done": False, "terms_md": ""}),
        json.dumps({"glossary_md": "g1", "adr_candidates": ""}),
    ]
    a1 = asyncio.run(s.turn("第一问"))
    # 双通道直填：用户编辑该轮的树版本
    s.conversation.edit_card(f"doc:tree@{a1}", "设计树", "# 用户手改的树")
    fake_module.responses = [
        "# 树-v2",
        json.dumps({"questions_md": "Q2", "done": False, "terms_md": ""}),
        json.dumps({"glossary_md": "g2", "adr_candidates": ""}),
    ]
    a2 = asyncio.run(s.turn("第二问"))
    cards = s.conversation.cards.all_cards()
    assert len([c for c in cards if c.id == f"doc:tree@{a1}"]) == 1  # edit 非重复创建
    assert s.conversation.cards.get(f"doc:tree@{a1}").body == "# 用户手改的树"
    assert s.conversation.cards.get(f"doc:tree@{a2}").body == "# 树-v2"  # 逐轮各一版
    # 第二轮 TreeUpdate 的 prompt 读到的是手改正文（双通道闭合）
    assert "用户手改的树" in fake_module.calls[3]["prompt"]
    # 树正文不入 history 转录：手改正文在该 prompt 中恰好出现一次（tree_md 字段处）
    assert fake_module.calls[3]["prompt"].count("用户手改的树") == 1
```

③ 新增四个测试：

```python
def test_done_switches_category_to_direct(tmp_path, fake_module, fake_card_client):
    s = _session(tmp_path, fake_module, fake_card_client)
    s.conversation.set_category("grilling")
    fake_module.responses = [
        "# 树-终",
        json.dumps({"questions_md": "决策汇总", "done": True, "terms_md": ""}),
        json.dumps({"glossary_md": "", "adr_candidates": ""}),
    ]
    asyncio.run(s.turn("最后问"))
    assert s.conversation.category == ""  # 拷问收敛 → 自动退出拷问态（空 = 直答）


def test_send_records_module_and_retry_locks_it(tmp_path, fake_module, fake_card_client):
    """轮上记录模式：grilling 会话里的直答插轮，retry 永远用原轮模式。"""
    from llm import LLMError

    s = _session(tmp_path, fake_module, fake_card_client)
    s.conversation.set_category("grilling")
    seq = s.send("直答插轮", module="direct")
    fake_module.fail = True
    with pytest.raises(LLMError):
        asyncio.run(s.complete(seq))
    fake_module.fail = False
    asyncio.run(s.turn_retry(seq))
    # direct 单节点 prompt 含"请直接回答"；若是 grilling 会是 TreeUpdate 的"设计树"
    assert "请直接回答用户最新消息" in fake_module.calls[-1]["prompt"]
    assert s.conversation.nodes[seq].module == "direct"


def test_send_default_records_empty_module(tmp_path, fake_module, fake_card_client):
    s = _session(tmp_path, fake_module, fake_card_client)
    seq = s.send("普通问")
    assert s.conversation.nodes[seq].module == ""  # 空 = complete 按会话 category 解析


def test_make_card_with_owner(tmp_path, fake_module, fake_card_client):
    s = _session(tmp_path, fake_module, fake_card_client)
    a = asyncio.run(s.turn("主对话"))
    cid = asyncio.run(s.make_card("总结", from_seqs=[a], owner_seq=a))
    c = s.conversation.cards.get(cid)
    assert c.owner_seq == a and not s.conversation.cards.is_pinned(cid)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/treechat/test_session.py -q`
Expected: FAIL（send 无 module 参数 / 文档卡还是 spec:tree / done 不切 category）

- [ ] **Step 3: 实现**——`treechat/session.py` 五处修改：

① 头部增导入：`from .core.cards import doc_card_id`。

② `TreeChatSession` 轮次区替换 `send`、`complete_outcome`，并新增 `module_for`：

```python
    def module_for(self, user_seq: int):
        """轮次生效模块：轮上记录优先，回落会话 category（resolve_module 兜底直答）。"""
        conv = self.conversation
        return resolve_module(conv.nodes[user_seq].module or conv.category,
                              self.mode_modules)

    def send(self, text: str, *, leaf: bool = False, module: str = "") -> int:
        """落 user_msg（先持久化，防丢）；module = 本轮模式 key（空 = 会话默认）。"""
        return self.conversation.append_user(text, leaf=leaf, module=module)
```

`complete_outcome` 中分派行与文档落盘段替换（`complete_outcome` 的模块解析行
`module = resolve_module(conv.category, self.mode_modules)` 改为
`module = self.module_for(user_seq)`；文档 for 循环替换为）：

```python
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
```

（`complete_outcome` docstring 的「回合产出的文档落为固定 ID 的 pinned 卡片」同步改为
「回合产出的文档落为该轮的文档版本节点卡」。）

③ `turn` 增透传：

```python
    async def turn(self, text: str, *, leaf: bool = False,
                   module: str = "") -> int:
        """send + complete 一步走。失败时 user 节点已落盘（悬而未答），turn_retry 重试。"""
        seq = self.send(text, leaf=leaf, module=module)
        return await self.complete(seq)
```

④ `make_card` 增归属参数：

```python
    async def make_card(self, instruction: str, *, seq: int | None = None,
                        from_seqs: list[int] | None = None,
                        owner_seq: int | None = None) -> str:
        """提炼卡片：默认当前分支段；from_seqs 显式区间；owner_seq 非空 = 挂该轮（节点卡）。"""
```

（函数体末行改为 `return self.conversation.add_card(out["title"], out["body"], seqs,
instruction, owner_seq=owner_seq)`，其余不变。）

⑤ **`Conversation.add_card` 显式 card_id 冲突预检**（Task 3 质量审查 fast-follow，2026-09-21 修订）：
显式 `card_id` 重复目前在 `store.append` **之后**才被 `CardRegistry.add` 抛出——毒事件向量，
且确定性 ID（`doc:<key>@<seq>`）使碰撞概率高于随机 ID。`treechat/core/conversation.py`
的 `add_card` 在归属校验之后、`store.append` 之前增：

```python
        if card_id is not None and card_id in self.cards.ids():
            raise TreeChatError(f"卡片 id 重复: {card_id}")
```

对应测试（Step 1 一并追加到 test_conversation.py）：

```python
def test_add_card_duplicate_explicit_id_raises_without_event(tmp_path):
    """显式 card_id 重复：预检拒绝、不落事件（毒事件防线，Task 3 质量审查 fast-follow）。"""
    conv = Conversation.create(tmp_path / "s6.jsonl", name="t")
    conv.add_card("第一张", "b", from_path=[], card_id="card_fixed")
    with pytest.raises(TreeChatError, match="卡片 id 重复"):
        conv.add_card("第二张", "b", from_path=[], card_id="card_fixed")
    assert len(conv.store.load()) == 2  # meta + 第一张，重复未落盘
```

（session `complete_outcome` 调用点的「if cid in conv.cards.ids(): edit_card」守卫保留
——崩溃残留复用 ID 走 edit 语义，与预检不冲突：预检拦的是会写出重复事件的路径。）

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/treechat/test_session.py tests/treechat/test_conversation.py -q`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add treechat/session.py treechat/core/conversation.py tests/treechat/test_session.py tests/treechat/test_conversation.py
git commit -m "feat(treechat): 逐轮模式记录/retry 锁定原模式 + 文档节点卡落盘 + done 自动切直答 + add_card id 冲突预检"
```

---

### Task 7: webapp——载荷透出 + turn/卡片请求带归属

**Files:**
- Modify: `treechat/webapp/app.py`
- Test: `tests/treechat/test_webapp.py`

- [ ] **Step 1: 更新测试**——`tests/treechat/test_webapp.py`：

① 替换 `test_turn_sse_grilling_refreshes_spec_cards`（第 176 行起）末段断言（state 相关部分）为：

```python
    state = events[-1][1]["state"]
    cards = {c["id"]: c for c in state["cards"] if c["docKey"]}
    assert set(cards) == {"doc:tree@3", "doc:glossary@3"}
    assert cards["doc:tree@3"]["title"] == "设计树"
    assert cards["doc:tree@3"]["ownerSeq"] == 3 and cards["doc:tree@3"]["docKey"] == "tree"
    assert cards["doc:glossary@3"]["ownerSeq"] == 3
    assert all(c["pinned"] is False for c in cards.values())  # 节点卡不 pin
    assert next(n for n in state["nodes"] if n["seq"] == 3)["input"] == "做个订单系统"
    # 未显式传 module → 轮上记录留空（complete 时按会话 category 解析，start 帧已验 grilling）
    assert next(n for n in state["nodes"] if n["seq"] == 3)["module"] == ""
    assert next(n for n in state["nodes"] if n["seq"] == 3)["output"] == "❓ Q1"
    assert events[-1][1]["done"] is False
```

（seq 算术不变：meta=1 → category=2 → user=3 → 文档卡 4/5 → assistant=6 回填轮 3。
测试名同步改为 `test_turn_sse_grilling_writes_node_doc_cards`。）

② 新增三个测试：

```python
def test_turn_records_explicit_module(api):
    """turn 带 module：轮上记录 + start 帧用该模式（无需改会话 category）。"""
    api.post("/api/sessions", json={"name": "m1", "category": "grilling"})
    events = sse_events(api, "/api/sessions/m1/turn",
                        json={"text": "插一轮直答", "module": "direct"})
    assert events[0][1]["module"] == "direct"
    state = api.get("/api/sessions/m1").json()
    assert state["category"] == "grilling"  # 会话默认未被 turn 改动
    assert state["nodes"][0]["module"] == "direct"


def test_card_create_with_owner_seq(api):
    api.post("/api/sessions", json={"name": "c1"})
    events = sse_events(api, "/api/sessions/c1/turn", json={"text": "问"})
    seq = events[-1][1]["state"]["pointer"]
    st = api.post("/api/sessions/c1/cards",
                  json={"instruction": "总结", "mode": "seqs", "seqs": [seq],
                        "ownerSeq": seq}).json()
    card = next(c for c in st["cards"] if c["ownerSeq"] == seq)
    assert card["docKey"] == "" and card["pinned"] is False


def test_card_import_with_owner_seq(api):
    api.post("/api/sessions", json={"name": "i1"})
    events = sse_events(api, "/api/sessions/i1/turn", json={"text": "问"})
    seq = events[-1][1]["state"]["pointer"]
    st = api.post("/api/sessions/i1/cards/import",
                  json={"title": "挂节点的卡", "body": "正文", "ownerSeq": seq}).json()
    card = next(c for c in st["cards"] if c["title"] == "挂节点的卡")
    assert card["ownerSeq"] == seq
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/treechat/test_webapp.py -q`
Expected: FAIL（载荷无 docKey/ownerSeq/module）

- [ ] **Step 3: 实现**——`treechat/webapp/app.py` 五处修改：

① 请求体三个：

```python
class TurnBody(BaseModel):
    text: str
    parent: int | None = None
    """显式分支目标（历史节点 seq）；缺省 = 当前指针。"""
    leaf: bool = False
    """无上下文叶子提问（优先于 parent）。"""
    module: str = ""
    """本轮使用的模式 key（空 = 会话 category）。"""
```

```python
class CardBody(BaseModel):
    instruction: str = "总结为卡片"
    mode: Literal["branch", "all", "range", "seqs"] = "branch"
    start: int | None = None
    end: int | None = None
    seqs: list[int] = []
    """seqs 模式的显式节点列表（树图选点提炼；空列表 → 400）。"""
    ownerSeq: int | None = None
    """提炼结果挂到该轮（节点卡）；None = 全局卡。"""
```

```python
class CardImportBody(BaseModel):
    title: str
    body: str
    instruction: str = ""
    ownerSeq: int | None = None
    """挂到该轮（节点卡）；None = 全局卡。"""
```

② `_state` 的 nodes 与 cards 序列化：

```python
        "nodes": [
            {"seq": n.seq, "parent": n.parent, "input": n.input,
             "output": n.output, "label": n.label, "model": n.model,
             "module": n.module}
            for n in conv.nodes.values()
        ],
        "cards": [
            {"id": c.id, "title": c.title, "body": c.body,
             "fromPath": [conv.legacy.get(seq, seq) for seq in c.from_path],
             "instruction": c.instruction, "createdAt": c.created_at,
             "pinned": conv.cards.is_pinned(c.id),
             "ownerSeq": c.owner_seq, "docKey": c.doc_key}
            for c in conv.cards.all_cards()
        ],
```

③ `_turn_stream` 的 send 与模块解析（`work()` 内）：`body.leaf` 分支两处 send 都带
`module=body.module`；模块解析行替换：

```python
                        if body.leaf:
                            seq = s.send(body.text, leaf=True, module=body.module)
                        else:
                            if body.parent is not None:
                                s.conversation.set_pointer(body.parent)
                            seq = s.send(body.text, module=body.module)
                        module = s.module_for(seq)
```

④ 卡片端点透传：`cards_create` 的 `await s.make_card(body.instruction, from_seqs=seqs)` 改为 `await s.make_card(body.instruction, from_seqs=seqs, owner_seq=body.ownerSeq)`；`cards_import` 的 `s.conversation.add_card(body.title, body.body, from_path=[], instruction=body.instruction)` 改为 `... instruction=body.instruction, owner_seq=body.ownerSeq)`。

⑤ 导入清理：`from ..modules import BUILT_IN, resolve_module` 改为 `from ..modules import BUILT_IN`（resolve_module 已无使用处；`/api/modes` 用 BUILT_IN 不受影响）。

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/treechat/test_webapp.py -q`
Expected: 全 PASS

- [ ] **Step 5: 全后端回归**

Run: `uv run pytest tests/treechat/ -q`
Expected: 全 PASS（约 133+ 例；test_cli 的 `/cards` 输出断言若因 Task 8 未做而无关——本步应已全绿，若 test_smoke 因无 LLM 配置跳过属正常）

- [ ] **Step 6: Commit**

```bash
git add treechat/webapp/app.py tests/treechat/test_webapp.py
git commit -m "feat(treechat): webapp 载荷透出 ownerSeq/docKey/module；turn 与卡片请求带归属"
```

---

### Task 8: CLI 最小适配（/cards 列表标注节点卡）

**Files:**
- Modify: `treechat/cli/commands.py`（`/cards` 分支，约第 140-147 行）

- [ ] **Step 1: 实现**——列表行替换为：

```python
            for c in cards:
                pin_mark = "📌" if c in conv.cards.pinned_cards() else ""
                owner = f"（节点 #{c.owner_seq}）" if c.owner_seq is not None else ""
                say(f"[{c.id}] {c.title} {pin_mark}{owner}  来源 {c.from_path}")
```

（全局卡输出文本与原先逐字符一致——现有 test_cli 断言不受影响；`/pin` 对节点卡会
得到引擎的明确报错，无需 CLI 特判。）

- [ ] **Step 2: 跑测试确认通过**

Run: `uv run pytest tests/treechat/test_cli.py -q`
Expected: 全 PASS

- [ ] **Step 3: Commit**

```bash
git add treechat/cli/commands.py
git commit -m "fix(treechat): CLI /cards 列表标注节点卡归属轮"
```

---

### Task 9: 前端类型与 API（types.ts / api.ts）

**Files:**
- Modify: `web/src/chat/types.ts`、`web/src/chat/api.ts`

- [ ] **Step 1: types.ts 修改**——`Node` 增 `module`、`Card` 增归属、`CardRef` 改形状、删除末尾死代码 `export type Tab = ...`（无任何导入方）：

```ts
/** 轮次节点（一问一答；id = seq 稳定可引用）。output = null 悬而未答 */
export interface Node {
  seq: number;
  parent: number | null;
  input: string;
  output: string | null;
  label: string;
  model: string;
  /** 本轮实际使用的模式 key（空 = 会话默认；grilling 会话里的直答插轮可见） */
  module: string;
}

/** 上下文产出卡片（ownerSeq=null 全局卡 / 非空节点卡） */
export interface Card {
  id: string;
  title: string;
  body: string;
  fromPath: number[];
  instruction: string;
  createdAt: string;
  pinned: boolean;
  ownerSeq: number | null;
  /** 非空 = 模块文档版本节点卡（沿路径取最近祖先版本） */
  docKey: string;
}
```

```ts
/** node_end 的文档引用（链接片） */
export interface CardRef {
  type: "doc";
  docKey: string;
  title: string;
}
```

- [ ] **Step 2: api.ts 修改**——`turn` body 增 `module`、`CardReq` 增 `ownerSeq`、`importCard` 增 `ownerSeq`：

```ts
export function turn(
  sid: string,
  body: { text: string; parent?: number; leaf?: boolean; module?: string },
  onEvent: (e: SseEvent) => void,
): Promise<void> {
  return streamSse(`/treechat/api/sessions/${encodeURIComponent(sid)}/turn`, body, onEvent);
}
```

```ts
export interface CardReq {
  instruction: string;
  mode: "branch" | "all" | "range" | "seqs";
  start?: number;
  end?: number;
  seqs?: number[];
  /** 提炼结果挂到该轮（节点卡）；缺省 = 全局卡 */
  ownerSeq?: number;
}
```

```ts
export const importCard = (sid: string, body: { title: string; body: string; instruction?: string; ownerSeq?: number }) =>
  req<ConvState>(`/treechat/api/sessions/${encodeURIComponent(sid)}/cards/import`, json("POST", body));
```

- [ ] **Step 3: 构建门**（此刻 ChatView/RunBlock 的 CardRef 用法会报类型错——Task 11 修复；先确认错误仅限预期文件）

Run: `cd web && npx tsc --noEmit 2>&1 | head -20`
Expected: 仅 ChatView.tsx 相关的 CardRef/refs 类型错误（Task 9 单独不 commit，与 Task 10/11 连续执行后统一提交；若希望每任务独立提交，可跳过本步在 Task 11 后验证）

- [ ] **Step 4: Commit**（与 Task 10/11 合并提交亦可；独立提交时等 Task 11 构建门过后补）

```bash
git add web/src/chat/types.ts web/src/chat/api.ts
git commit -m "feat(web): chat 类型/API 增节点卡归属与逐轮模式字段"
```

---

### Task 10: CardsSidebar 组件（节点卡区 + 全局卡区组合）

**Files:**
- Create: `web/src/chat/CardsSidebar.tsx`
- Modify: `web/src/chat/CardsPanel.tsx`（导出 CardEditForm；标题改「全局卡片」）

- [ ] **Step 1: CardsPanel.tsx 三处小改**——① `function CardEditForm` 改为 `export function CardEditForm`；② 面板头 `<span className="text-[11px] font-semibold text-muted-foreground">卡片</span>` 改为 `<span className="text-[11px] font-semibold text-muted-foreground">全局卡片</span>`；③ 卡片条目标题行（`<span className="font-mono text-[11px] text-muted-foreground">{c.id}</span>` 之前）插入旧版文档徽标：

```tsx
                {c.id.startsWith("spec:") && (
                  <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-px text-[10px] text-amber-600">旧版文档</span>
                )}
```

- [ ] **Step 2: 新建 `web/src/chat/CardsSidebar.tsx`**，全文：

```tsx
import { CornerUpRight, FileText, MapPin, PanelRightClose, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import * as api from "./api";
import type { Card, ConvState } from "./types";
import { activePath } from "./types";
import { cn } from "../lib/utils";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { Markdown } from "./Markdown";
import { CardEditForm, CardsPanel } from "./CardsPanel";

interface Props {
  conv: ConvState | null;
  onNavigate: (seq: number) => void;
  onCollapse: () => void;
  /** 节点卡升为全局（复制为全局 pinned 卡——跨分支传递入口） */
  onPromoteCard: (c: Card) => Promise<void>;
  // ↓ 透传全局卡区（CardsPanel）
  genOpen: boolean;
  onGenOpenChange: (open: boolean) => void;
  cardSeqs: number[];
  onClearCardSeqs: () => void;
  onCreateCard: (req: api.CardReq) => Promise<void>;
  onPin: (cid: string, pinned: boolean) => Promise<void>;
  onEditCard: (cid: string, body: { title: string; body: string }) => Promise<void>;
  onDeleteCard: (cid: string) => Promise<void>;
  onImportCard: (body: { title: string; body: string; instruction?: string }) => Promise<void>;
}

/** chat 页右侧边栏：上半「节点卡片」（指针轮产出 + 文档版本链），下半「全局卡片」 */
export function CardsSidebar(p: Props) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 px-3 pb-1 pt-3">
        <FileText className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[11px] font-semibold text-muted-foreground">卡片</span>
        <button title="收起卡片栏" onClick={p.onCollapse}
                className="ml-auto rounded-control p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
          <PanelRightClose className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <NodeCardsSection conv={p.conv} onNavigate={p.onNavigate} onEdit={p.onEditCard}
                          onDelete={p.onDeleteCard} onPromote={p.onPromoteCard} />
        <CardsPanel conv={p.conv} genOpen={p.genOpen} onGenOpenChange={p.onGenOpenChange}
                    cardSeqs={p.cardSeqs} onClearCardSeqs={p.onClearCardSeqs}
                    onCreateCard={p.onCreateCard} onPin={p.onPin} onEditCard={p.onEditCard}
                    onDeleteCard={p.onDeleteCard} onImportCard={p.onImportCard} />
      </div>
    </div>
  );
}

/** 节点卡片：当前指针轮的产出（模块文档版本 + 用户挂节点的卡） */
function NodeCardsSection({ conv, onNavigate, onEdit, onDelete, onPromote }: {
  conv: ConvState | null;
  onNavigate: (seq: number) => void;
  onEdit: (cid: string, body: { title: string; body: string }) => Promise<void>;
  onDelete: (cid: string) => Promise<void>;
  onPromote: (c: Card) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [versionsOf, setVersionsOf] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<Card | null>(null);
  if (!conv) return null;
  const pointer = conv.pointer;
  const nodeCards = conv.cards.filter((c) => c.ownerSeq === pointer);
  // 版本链 = 活跃路径上该文档的各版本（点击跳转该轮——分支到旧节点后其版本即生效）
  const docVersions = (docKey: string) => {
    const seqs = new Set(activePath(conv).map((n) => n.seq));
    return conv.cards
      .filter((c) => c.docKey === docKey && c.ownerSeq !== null && seqs.has(c.ownerSeq))
      .sort((a, b) => (a.ownerSeq ?? 0) - (b.ownerSeq ?? 0));
  };
  return (
    <div className="pb-2">
      <div className="flex items-center gap-1 px-1 pb-1 text-[11px] font-semibold text-muted-foreground">
        节点卡片
        <span className="font-normal opacity-80">
          {pointer === null ? "（未选中节点）" : `#${pointer}`}
        </span>
      </div>
      {pointer === null ? (
        <div className="rounded-panel border border-dashed px-2.5 py-3 text-[12px] text-muted-foreground">
          在树页签点选轮次，查看该轮产出的卡片。
        </div>
      ) : nodeCards.length === 0 ? (
        <div className="rounded-panel border border-dashed px-2.5 py-3 text-[12px] text-muted-foreground">
          该轮无产出卡片。
        </div>
      ) : (
        nodeCards.map((c) => (
          <div key={c.id} className="mb-1.5 rounded-panel border px-2.5 py-2">
            <div className="flex cursor-pointer items-center gap-1.5"
                 onClick={() => setExpanded(expanded === c.id ? null : c.id)}>
              {c.docKey !== "" && (
                <span className="rounded-full bg-primary/10 px-1.5 py-px text-[10px] text-primary">文档</span>
              )}
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{c.title}</span>
              <span className="font-mono text-[10px] text-muted-foreground/60">{c.id}</span>
            </div>
            {expanded === c.id && (
              <div className="pt-1.5">
                <Markdown text={c.body} />
                <div className="flex flex-wrap gap-1 pt-1.5">
                  {c.docKey !== "" && (
                    <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[12px]"
                            onClick={() => setVersionsOf(versionsOf === c.id ? null : c.id)}>
                      <MapPin className="h-3 w-3" /> 版本链
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[12px]"
                          title="复制为全局卡片（跨分支传递）"
                          onClick={() => onPromote(c)}>
                    <CornerUpRight className="h-3 w-3" /> 升为全局
                  </Button>
                  <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[12px]"
                          onClick={() => setEditTarget(c)}>
                    <Pencil className="h-3 w-3" /> 编辑
                  </Button>
                  <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[12px] text-destructive hover:text-destructive"
                          onClick={() => onDelete(c.id)}>
                    <Trash2 className="h-3 w-3" /> 删除
                  </Button>
                </div>
                {versionsOf === c.id && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1 border-t border-border pt-1.5 text-[12px]">
                    <span className="text-muted-foreground">沿活跃路径：</span>
                    {docVersions(c.docKey).map((v) => (
                      <button key={v.id} onClick={() => onNavigate(v.ownerSeq ?? pointer)}
                              className={cn("rounded-full border px-1.5 py-px font-mono hover:bg-accent",
                                            v.ownerSeq === pointer && "border-primary text-primary")}>
                        #{v.ownerSeq}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))
      )}
      <Dialog open={editTarget !== null} onOpenChange={(o) => !o && setEditTarget(null)}>
        <DialogContent>
          {editTarget && (
            <CardEditForm
              card={editTarget}
              onSubmit={async (title, body) => {
                await onEdit(editTarget.id, { title, body });
                setEditTarget(null);
              }}
              onCancel={() => setEditTarget(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add web/src/chat/CardsSidebar.tsx web/src/chat/CardsPanel.tsx
git commit -m "feat(web): 卡片右侧边栏组件——节点卡区（版本链/升为全局/编辑）+ 全局卡区组合"
```

---

### Task 11: App 布局三段式 + ActivityBar 收编 + ChatView/RunBlock 徽章与 ref 片

**Files:**
- Modify: `web/src/components/ActivityBar.tsx`、`web/src/App.tsx`、`web/src/chat/ChatView.tsx`

- [ ] **Step 1: ActivityBar.tsx**——`Tab` 类型去掉 `"cards"`，TABS 数组删除 cards 条目，lucide 导入去掉 `Layers`（不再使用），头部注释「chat/tree/cards 中 tree/cards 是…」改为「chat/tree 中 tree 是…」：

```ts
import { Boxes, GitFork, List, MessageSquare, Settings } from "lucide-react";
```
```ts
export type Tab = "chat" | "tree" | "modules" | "runs" | "settings";
```
```ts
const TABS: { key: Tab; label: string; icon: ComponentType<{ className?: string }> }[] = [
  { key: "chat", label: "对话", icon: MessageSquare },
  { key: "tree", label: "对话树（随激活对话页签）", icon: GitFork },
  { key: "modules", label: "模块库", icon: Boxes },
  { key: "runs", label: "运行历史", icon: List },
];
```

- [ ] **Step 2: App.tsx**——八处修改：

① 导入区：`import { CardsPanel } from "./chat/CardsPanel";` 改为
`import { CardsSidebar } from "./chat/CardsSidebar";`（CardsPanel 由 CardsSidebar 内部引用）。

② `ChatUi` 增字段与默认值：

```ts
interface ChatUi {
  leafMode: boolean;
  focusSeq: number | null;
  cardSeqs: number[];
  cardGenOpen: boolean;
  /** 右侧卡片栏开合（按会话记忆） */
  cardsOpen: boolean;
  busy: boolean;
  error: string | null;
  run: RunTrace | null;
}
const EMPTY_CHAT_UI: ChatUi = {
  leafMode: false, focusSeq: null,
  cardSeqs: [], cardGenOpen: false, cardsOpen: true, busy: false, error: null, run: null,
};
```

③ `send` 增 module 参数（切换即写会话 category，逐轮记录双保险）：

```tsx
  const send = async (sid: string, text: string, module?: string) => {
    const ui = getChatUi(sid);
    if (ui.busy) return;
    const leaf = ui.leafMode || undefined;
    updUi(sid, { busy: true, error: null, leafMode: false, focusSeq: null, run: null });
    try {
      if (module) await chatApi.setCategory(sid, module).catch(() => {});
      await chatApi.turn(sid, { text, leaf, module }, (ev) => handleEvent(sid, ev));
      refreshSessions();
    } catch (e) {
      updUi(sid, { error: e instanceof Error ? e.message : String(e) });
    } finally {
      updUi(sid, { busy: false });
    }
  };
```

④ 删除整个 `{sidebarTab === "cards" && (<CardsPanel ... />)}` 块；TreePanel 的
`onGenerateCard` 改为：

```tsx
            onGenerateCard={() => {
              if (!activeChatSid) return;
              updUi(activeChatSid, { cardGenOpen: true, cardsOpen: true });
            }}
```

⑤ chat 页主区改为三段式——`activeConv ? ( ... )` 内层整体包裹（header/ChatView/Composer
原样移入左列）：

```tsx
            activeConv ? (
              <div className="flex h-full min-h-0">
                <div className="flex h-full min-w-0 flex-1 flex-col">
                  <header className="flex h-11 shrink-0 items-center gap-2 border-b px-4">
                    {/* ……原 header 内容不动，末尾加一个开栏按钮： */}
                    <button title="卡片栏" onClick={() => updUi(activeChatSid, { cardsOpen: !activeUi.cardsOpen })}
                            className="ml-1 shrink-0 rounded-control p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
                      <PanelRight className="h-4 w-4" />
                    </button>
                  </header>
                  <ChatView /* 原有 props 不动，新增 modes 与卡片过滤变化见 ChatView 步骤 */ />
                  <Composer /* 见下 */ />
                </div>
                {activeUi.cardsOpen && (
                  <aside className="flex h-full w-80 shrink-0 flex-col border-l bg-sidebar">
                    <CardsSidebar
                      conv={activeConv}
                      onNavigate={(seq) => navigateTurn(activeChatSid, seq)}
                      onCollapse={() => updUi(activeChatSid, { cardsOpen: false })}
                      onPromoteCard={async (c) => {
                        await mutateConv(activeChatSid, (s) => chatApi.importCard(s, {
                          title: c.title, body: c.body,
                          instruction: `升自节点卡 ${c.id}`,
                        }));
                      }}
                      genOpen={activeUi.cardGenOpen}
                      onGenOpenChange={(o) => updUi(activeChatSid, { cardGenOpen: o })}
                      cardSeqs={activeUi.cardSeqs}
                      onClearCardSeqs={() => updUi(activeChatSid, { cardSeqs: [] })}
                      onCreateCard={async (req) => { await createCard(activeChatSid, req); }}
                      onPin={async (cid, pinned) => { await mutateConv(activeChatSid, (s) => chatApi.pinCard(s, cid, pinned)); }}
                      onEditCard={async (cid, body) => { await mutateConv(activeChatSid, (s) => chatApi.editCard(s, cid, body)); }}
                      onDeleteCard={async (cid) => { await mutateConv(activeChatSid, (s) => chatApi.deleteCard(s, cid)); }}
                      onImportCard={async (body) => { await mutateConv(activeChatSid, (s) => chatApi.importCard(s, body)); }}
                    />
                  </aside>
                )}
              </div>
            ) : (
```

⑥ Composer 接线替换：

```tsx
                <Composer
                  leafMode={activeUi.leafMode}
                  busy={activeUi.busy}
                  disabled={false}
                  modes={modes}
                  category={activeConv.category}
                  onToggleLeaf={() => activeChatSid && updUi(activeChatSid, { leafMode: !activeUi.leafMode })}
                  onSwitchMode={(key) => activeChatSid && mutateConv(activeChatSid, (s) => chatApi.setCategory(s, key))}
                  onSend={(text, module) => activeChatSid && send(activeChatSid, text, module)}
                />
```

⑦ ChatView 接线：props 增 `modes={modes}`；`onOpenCards={() => updUi(activeChatSid, { cardsOpen: true })}`（替换原 `setSidebarTab("cards")`）。

⑧ 导入 `PanelRight` 图标：`import { Boxes, MessageSquare, PanelRight } from "lucide-react";`

- [ ] **Step 3: ChatView.tsx**——三处修改：

① Props 增 `modes: Mode[]`（`import type { ..., Mode } from "./types"`），并透传给 TurnItem。

② `MessageMeta` 增模式徽章（assistant 行）：TurnItem 的 assistant meta 调用改为
`<MessageMeta model={node.model} module={node.module} modes={p.modes} cards={[]} align="left" />`，
MessageMeta 实现增参：

```tsx
function MessageMeta({ seq, label, model, module, modes, cards, align }: {
  seq?: number;
  label?: string;
  model?: string;
  module?: string;
  modes: Mode[];
  cards: Card[];
  align: "left" | "right";
}) {
  const modeName = module ? modes.find((m) => m.key === module)?.displayName ?? module : null;
  return (
    <div className={cn("flex items-center gap-1.5 pb-1 text-[11px] text-muted-foreground/70",
                      align === "right" && "flex-row-reverse")}>
      {seq !== undefined && <span className="font-mono">#{seq}</span>}
      {label && <span className="rounded-full bg-primary/10 px-1.5 py-px text-foreground/80">{label}</span>}
      {modeName && <span className="rounded-full border border-border px-1.5 py-px">{modeName}</span>}
      {model && <span className="truncate">{model}</span>}
      {cards.map((c) => (
        <span key={c.id} title={`${c.id} · ${c.title}`}
              className="rounded-full border border-border px-1.5 py-px">
          [{c.id.replace("card_", "c_")}]
        </span>
      ))}
    </div>
  );
}
```

③ 来源片只统计全局卡 + RunBlock ref 片改文案：

```tsx
  const cardsBySeq = new Map<number, Card[]>();
  for (const c of conv.cards)
    if (c.ownerSeq === null)
      for (const s of c.fromPath) cardsBySeq.set(s, [...(cardsBySeq.get(s) ?? []), c]);
```

```tsx
            {n.outcome === "ok" && n.refs.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-1">
                {n.refs.map((r) => (
                  <button key={r.docKey} onClick={onOpenCards}
                          className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-px text-[12px]
                                     text-muted-foreground hover:bg-foreground/[0.05]">
                    <FileText className="h-3 w-3 shrink-0" />
                    {r.title} → 已挂到 #{run.userSeq}
                  </button>
                ))}
              </div>
            )}
```

- [ ] **Step 4: 构建门**

Run: `cd web && npm run build`
Expected: tsc --noEmit 零错误 + vite build 成功（若报 CardsSidebar 未使用导出等，按报错清理）

- [ ] **Step 5: Commit**

```bash
git add web/src/components/ActivityBar.tsx web/src/App.tsx web/src/chat/ChatView.tsx
git commit -m "feat(web): chat 页三段式布局——右栏挂载/cards 页签退役/逐轮模式徽章/文档 ref 片"
```

---

### Task 12: Composer——模式切换 chip + 斜杠命令

**Files:**
- Modify: `web/src/chat/Composer.tsx`（全文替换）

- [ ] **Step 1: 全文替换 `web/src/chat/Composer.tsx`**：

```tsx
import { ChevronDown, Leaf, SendHorizontal, Slash, X } from "lucide-react";
import { useRef, useState } from "react";
import type { Mode } from "./types";
import { cn } from "../lib/utils";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";

interface Props {
  leafMode: boolean;
  busy: boolean;
  disabled: boolean;
  modes: Mode[];
  /** 当前会话默认模式 key（空 = 直答） */
  category: string;
  onToggleLeaf: () => void;
  /** 切换会话默认模式（写 category 事件） */
  onSwitchMode: (key: string) => void;
  /** module 非空 = 斜杠切换并本轮生效（send 会同时写 category） */
  onSend: (text: string, module?: string) => void;
}

/** 模式匹配：key 全等 > 显示名全等 > key 唯一前缀 */
function matchMode(token: string, modes: Mode[]): Mode | null {
  const t = token.toLowerCase();
  if (!t) return null;
  return (
    modes.find((m) => m.key === t) ??
    modes.find((m) => m.displayName === token) ??
    (() => {
      const byPrefix = modes.filter((m) => m.key.startsWith(t));
      return byPrefix.length === 1 ? byPrefix[0] : null;
    })()
  );
}

/** 输入区：模式 chip（切换会话默认）+ 叶子模式 chip + 斜杠快速切换 + 发送 */
export function Composer(p: Props) {
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  const trimmed = text.trim();
  const slash = trimmed.startsWith("/");
  // 候选（命令面板）：斜杠后、未出现空白前的 token 前缀过滤
  const partial = slash ? trimmed.slice(1) : "";
  const candidates = slash && !partial.includes(" ")
    ? p.modes.filter((m) => m.key.startsWith(partial.toLowerCase())
                          || m.displayName.includes(partial))
    : [];
  // 已成完整命令（空白分隔）时的解析结果
  const parsed = slash && partial.includes(" ")
    ? (() => {
        const token = partial.split(/\s+/, 1)[0];
        const rest = trimmed.slice(1 + token.length).trim();
        const hit = matchMode(token, p.modes);
        return { hit, rest, unknown: hit === null };
      })()
    : null;

  const current = p.modes.find((m) => m.key === p.category);

  const send = () => {
    const t = text.trim();
    if (!t || p.busy || p.disabled) return;
    if (t.startsWith("/")) {
      const token = t.slice(1).split(/\s+/, 1)[0];
      const rest = t.slice(1 + token.length).trim();
      const hit = matchMode(token, p.modes);
      if (hit) {
        setText("");
        taRef.current?.focus();
        if (rest) p.onSend(rest, hit.key);   // 切换 + 余文直接作为该轮消息
        else p.onSwitchMode(hit.key);        // 仅切换
        return;
      }
      // 未知命令：提示条已显示，不阻断——原文发出（设计决策）
    }
    p.onSend(t);
    setText("");
    taRef.current?.focus();
  };

  return (
    <div className="shrink-0 px-6 pb-4 pt-1">
      <div className="mx-auto max-w-3xl">
        {(p.leafMode || slash) && (
          <div className="flex flex-wrap items-center gap-1.5 pb-1.5 text-[12px] text-muted-foreground">
            {p.leafMode && (
              <span className="flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5">
                <Leaf className="h-3 w-3" /> 叶子模式（无上下文）
                <button title="取消叶子模式" onClick={p.onToggleLeaf}>
                  <X className="h-3 w-3 hover:text-foreground" />
                </button>
              </span>
            )}
            {slash && candidates.length === 0 && (parsed === null || parsed.unknown) && (
              <span className="rounded-full border border-dashed border-destructive/50 px-2 py-0.5 text-destructive">
                未知命令——可用：{p.modes.map((m) => `/${m.key}`).join(" ")}（原文将照常发送）
              </span>
            )}
          </div>
        )}
        <div className={cn(
          "flex items-end gap-2 rounded-panel border bg-card p-2 shadow-sm transition-colors focus-within:ring-1 focus-within:ring-ring",
          p.disabled && "opacity-60",
        )}>
          {/* 模式 chip：点击下拉切换会话默认模式 */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button title="对话模式（会话默认，斜杠可临时切换）" disabled={p.disabled}
                      className="flex h-8 shrink-0 items-center gap-0.5 rounded-control px-2 text-[12px]
                                 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
                <Slash className="h-3 w-3 opacity-60" />
                {current?.displayName ?? "直答"}
                <ChevronDown className="h-3 w-3 opacity-60" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {p.modes.map((m) => (
                <DropdownMenuItem key={m.key}
                                  className={cn(m.key === p.category && "bg-accent")}
                                  onSelect={() => p.onSwitchMode(m.key)}>
                  <span>{m.displayName}</span>
                  <span className="pl-1.5 font-mono text-[11px] text-muted-foreground">/{m.key}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="relative min-w-0 flex-1">
            {/* 斜杠命令面板（建议列表，点击补全） */}
            {slash && candidates.length > 0 && (
              <div className="absolute bottom-full left-0 z-10 mb-1 w-56 rounded-panel border bg-card p-1 shadow-md">
                {candidates.map((m) => (
                  <button key={m.key}
                          onClick={() => { setText(`/${m.key} `); taRef.current?.focus(); }}
                          className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-[13px] hover:bg-accent">
                    <span className="font-mono text-[11px] text-muted-foreground">/{m.key}</span>
                    <span>{m.displayName}</span>
                  </button>
                ))}
              </div>
            )}
            <textarea
              ref={taRef}
              rows={1}
              value={text}
              disabled={p.disabled}
              placeholder={p.disabled ? "先选择或创建一个对话" : "输入消息…（/ 切换模式，Enter 发送，Shift+Enter 换行）"}
              onChange={(e) => {
                setText(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              className="max-h-40 min-h-[24px] w-full resize-none bg-transparent px-1.5 py-1 text-[14px] outline-none placeholder:text-muted-foreground/70"
            />
          </div>
          <button
            title="叶子模式：下一条为无上下文提问"
            onClick={p.onToggleLeaf}
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-control transition-colors",
              p.leafMode ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <Leaf className="h-4 w-4" />
          </button>
          <button
            title="发送"
            onClick={send}
            disabled={!text.trim() || p.busy || p.disabled}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            <SendHorizontal className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 构建门**

Run: `cd web && npm run build`
Expected: 成功

- [ ] **Step 3: 手动走查**（启动 `uv run uvicorn server.app:app --port 8000` + `cd web && npm run dev`）：

1. 新建 grilling 会话 → 发一轮 → Composer chip 显示「拷问」；下拉切「直答」→ 发轮 → 消息元信息行该轮徽章显示「直答」；
2. 输入 `/g` → 面板出「/grilling 拷问」；点选补全 → 回车仅切换；输入 `/direct 直答插一轮` 回车 → 该轮以直答作答且 chip 变「直答」；
3. grilling 轮后从树页签点上游轮 → 右栏节点卡区显示该轮的「设计树」版本 → 版本链展开列路径版本 → 点击跳转；
4. 输入 `/foo hi` → 提示条出现且消息原文发出。

- [ ] **Step 4: Commit**

```bash
git add web/src/chat/Composer.tsx
git commit -m "feat(web): Composer 模式切换 chip + 斜杠快速切换（切并发送/未知命令不阻断）"
```

---

### Task 13: 收尾——回归、roadmap 变更日志、验收走查

**Files:**
- Modify: `roadmap.md`（变更日志）

- [ ] **Step 1: 后端全量回归**

Run: `uv run pytest tests/ -q`
Expected: 全 PASS（webview + treechat 全套）

- [ ] **Step 2: 库基线回归**（未触碰库，防御性确认）

Run: `uv run pytest ../SpecModule/module_harness/tests/ -q -m "not smoke"`
Expected: 全 PASS

- [ ] **Step 3: roadmap.md 变更日志**——在变更日志节追加：

```markdown
- 2026-09-21 卡片双层作用域 + 会话内模式切换（specs/2026-09-21-card-scopes-mode-switch-design）：
  card_create 增 owner_seq/doc_key（节点卡/全局卡双层，旧文件零迁移）；grilling 文档逐轮
  版本化挂轮（doc:<key>@<seq>），上下文沿路径取最近祖先版本——分支取分支点时点版本、
  叶子空文档、模式往返不丢卡；会话内模式切换（chip + 斜杠 + 逐轮记录 + retry 锁定原模式
  + done 自动切直答）；前端卡片迁入右侧边栏（节点卡区版本链/升为全局 + 全局卡区）。
```

- [ ] **Step 4: Commit**

```bash
git add roadmap.md
git commit -m "docs: roadmap 变更日志——卡片双层作用域 + 会话内模式切换"
```

---

## 任务依赖与顺序

Task 1→2→3 严格串行（事件→卡片→会话视图）；Task 4→5 串行且连续执行（base 改名与 bridge 收口是同一原子变更，4 不单独跑全量）；Task 6 依赖 3+5；Task 7 依赖 6；Task 8 依赖 2（独立小改）。前端 Task 9→10→11 有类型联动（9 单独不构建通过属预期，10/11 后收口）；Task 12 依赖 11（App 传新 props）。Task 13 收尾。
