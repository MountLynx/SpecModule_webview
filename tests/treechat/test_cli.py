"""CLI：非交互命令 + REPL 对话/where/help/quit/retry。"""
import asyncio

from llm import LLMError
from treechat.cli.repl import main, run_repl
from treechat.config import TreeChatConfig


def _make_input(lines):
    it = iter(lines)

    async def input_fn(prompt=""):
        try:
            return next(it)
        except StopIteration:
            raise EOFError

    return input_fn


def _make_say():
    out = []

    def say(text=""):
        out.append(str(text))

    return say, out


def _open_session(tmp_path, fake_module, fake_card_client):
    from treechat.core.conversation import Conversation
    from treechat.core.context import TokenWindowStrategy
    from treechat.session import TreeChatSession
    conv = Conversation.create(tmp_path / "t.jsonl", name="t", system="sys")
    s = TreeChatSession(conversation=conv, client=fake_module,
                        window=TokenWindowStrategy(budget_tokens=10_000),
                        card_llm=fake_card_client)
    return s


def test_main_new_creates_session(tmp_path, capsys, fake_module, monkeypatch):
    # create/open 走 create_client → env 配置链，单测不依赖环境 → 假客户端替身
    from treechat import llm_bridge
    monkeypatch.setattr(llm_bridge, "create_client", lambda model=None: fake_module)
    config = TreeChatConfig(data_dir=tmp_path)
    # new 会进 REPL；喂 /quit 立即退出
    code = main(["new", "甲", "--system", "s"], config=config,
                input_fn=_make_input(["/quit"]))
    assert code == 0
    assert (config.sessions_dir() / "甲.jsonl").exists()


def test_main_open_passes_config_mode_modules(tmp_path, fake_module, monkeypatch, capsys):
    """CLI 打开会话时必须透传 config.mode_modules，否则绑定覆盖失效。"""
    from treechat import llm_bridge
    from treechat.core.conversation import Conversation
    monkeypatch.setattr(llm_bridge, "create_client", lambda model=None: fake_module)
    config = TreeChatConfig(data_dir=tmp_path, mode_modules={})  # 解绑 grilling
    conv = Conversation.create(config.sessions_dir() / "g.jsonl", name="g")
    conv.set_category("grilling")
    fake_module.responses = ["直接回答"]  # 成功回落 direct 时只会调用一次
    code = main(["open", "g"], config=config,
                input_fn=_make_input(["问题", "/quit"]))
    assert code == 0
    assert "直接回答" in capsys.readouterr().out


def test_main_list(tmp_path, capsys):
    config = TreeChatConfig(data_dir=tmp_path)
    config.sessions_dir().mkdir(parents=True)
    from treechat.core.conversation import Conversation
    Conversation.create(config.sessions_dir() / "乙.jsonl", name="乙")
    code = main(["list"], config=config)
    assert code == 0
    assert "乙" in capsys.readouterr().out


def test_repl_bare_input_and_where(tmp_path, fake_module, fake_card_client):
    s = _open_session(tmp_path, fake_module, fake_card_client)
    say, out = _make_say()
    code = run_repl(s, TreeChatConfig(data_dir=tmp_path),
                    input_fn=_make_input(["你好", "/where", "/quit"]), say=say)
    assert code == 0
    assert any("mock reply" in line for line in out)
    assert any("/where" in line or "指针" in line for line in out)


def test_repl_llm_failure_surface_and_retry(tmp_path, fake_module, fake_card_client):
    s = _open_session(tmp_path, fake_module, fake_card_client)
    say, out = _make_say()
    fake_module.fail = True
    code = run_repl(s, TreeChatConfig(data_dir=tmp_path),
                    input_fn=_make_input(["问题", "/retry", "/quit"]), say=say)
    fake_module.fail = False
    assert code == 0
    assert any("LLM 调用失败" in line for line in out)
    assert any("悬而未答" in line for line in out)


def test_repl_help_and_unknown_command(tmp_path, fake_module, fake_card_client):
    s = _open_session(tmp_path, fake_module, fake_card_client)
    say, out = _make_say()
    run_repl(s, TreeChatConfig(data_dir=tmp_path),
             input_fn=_make_input(["/help", "/nope", "/quit"]), say=say)
    assert any("命令" in line for line in out)
    assert any("未知命令" in line for line in out)


def test_repl_branch_trunk_leaf_flow(tmp_path, fake_module, fake_card_client):
    s = _open_session(tmp_path, fake_module, fake_card_client)
    say, out = _make_say()
    run_repl(
        s, TreeChatConfig(data_dir=tmp_path),
        input_fn=_make_input([
            "主干一问",            # 轮2（assistant 事件3）
            "/branch 2",           # 指针 → #2
            "分支一问",            # 轮4（2 轮 > 主干 1 轮，分支即成主干）
            "/trunk",              # 谁最长谁是主干 → 指针 #4
            "/leaf",               # 下一条 = 叶子
            "叶子一问",            # 叶子轮6
            "/quit",
        ]),
        say=say,
    )
    conv = s.conversation
    assert conv.nodes[4].parent == 2          # 分支挂在 #2
    assert conv.nodes[6].parent is None       # 叶子根
    assert conv.pointer == 6                  # /trunk 后又轮转到叶子轮末端
    assert any("新枝" in line for line in out)
    assert any("叶子" in line for line in out)


def test_repl_tree_command(tmp_path, fake_module, fake_card_client):
    s = _open_session(tmp_path, fake_module, fake_card_client)
    say, out = _make_say()
    run_repl(s, TreeChatConfig(data_dir=tmp_path),
             input_fn=_make_input(["问一句", "/tree", "/quit"]), say=say)
    assert any("◆" in line for line in out)
    assert any("#" in line for line in out)


def test_repl_branch_unknown_seq_errors(tmp_path, fake_module, fake_card_client):
    s = _open_session(tmp_path, fake_module, fake_card_client)
    say, out = _make_say()
    run_repl(s, TreeChatConfig(data_dir=tmp_path),
             input_fn=_make_input(["/branch 99", "/quit"]), say=say)
    assert any("错误" in line for line in out)


def test_repl_card_flow(tmp_path, fake_module, fake_card_client):
    s = _open_session(tmp_path, fake_module, fake_card_client)
    say, out = _make_say()
    run_repl(
        s, TreeChatConfig(data_dir=tmp_path),
        input_fn=_make_input([
            "讨论一下",            # 2u 3a
            "/card 总结成卡片",     # 默认当前分支段 [2,3]
            "/cards",
            "/quit",
        ]),
        say=say,
    )
    conv = s.conversation
    assert len(conv.cards.all_cards()) == 1
    card = conv.cards.all_cards()[0]
    assert card.instruction == "总结成卡片"
    assert any("卡片已创建" in line for line in out)
    assert any("📌" in line or card.id in line for line in out)


def test_repl_card_show_and_unknown_pin(tmp_path, fake_module, fake_card_client):
    s = _open_session(tmp_path, fake_module, fake_card_client)
    say, out = _make_say()
    # 第一段：先创建卡片（id 运行时才产生，不能在输入列表里急切引用）
    run_repl(s, TreeChatConfig(data_dir=tmp_path),
             input_fn=_make_input(["问", "/card 总结", "/quit"]), say=say)
    cid = s.conversation.cards.all_cards()[0].id
    say2, out2 = _make_say()
    run_repl(s, TreeChatConfig(data_dir=tmp_path),
             input_fn=_make_input([f"/card show {cid}", "/unpin card_nope", "/quit"]),
             say=say2)
    assert any("卡片标题" in line for line in out2)
    assert any("未知卡片" in line for line in out2)


def test_repl_card_edit_and_delete(tmp_path, fake_module, fake_card_client):
    s = _open_session(tmp_path, fake_module, fake_card_client)
    say, out = _make_say()
    run_repl(s, TreeChatConfig(data_dir=tmp_path),
             input_fn=_make_input(["问", "/card 总结", "/quit"]), say=say)
    cid = s.conversation.cards.all_cards()[0].id
    say2, out2 = _make_say()
    run_repl(s, TreeChatConfig(data_dir=tmp_path),
             input_fn=_make_input([
                 f"/card edit {cid} 新标题",
                 f"/card show {cid}",
                 f"/card edit {cid}",       # 省略新标题 = 查看
                 f"/card delete {cid}",
                 f"/card delete {cid}",     # 已删除 → 显式报错
                 "/quit",
             ]),
             say=say2)
    card = s.conversation.cards.get(cid) if cid in s.conversation.cards.ids() else None
    assert card is None  # 已删除
    assert any("卡片已改名" in line for line in out2)
    assert any("新标题" in line for line in out2)
    assert sum("卡片已删除" in line for line in out2) == 1
    assert any("未知卡片" in line for line in out2)
    # 删除已落盘：重放后仍无卡片
    from treechat.core.conversation import Conversation
    assert Conversation.open(tmp_path / "t.jsonl").cards.all_cards() == []


def test_repl_system_and_model_show(tmp_path, fake_module, fake_card_client):
    s = _open_session(tmp_path, fake_module, fake_card_client)
    say, out = _make_say()
    run_repl(
        s, TreeChatConfig(data_dir=tmp_path),
        input_fn=_make_input(["/system", "/system 新指令", "/system", "/model", "/quit"]),
        say=say,
    )
    assert s.conversation.system == "新指令"
    assert any("新指令" in line for line in out)
    assert any("当前模型" in line for line in out)


def test_repl_retry_command(tmp_path, fake_module, fake_card_client):
    s = _open_session(tmp_path, fake_module, fake_card_client)
    say, out = _make_say()
    fake_module.fail = True
    run_repl(s, TreeChatConfig(data_dir=tmp_path),
             input_fn=_make_input(["问题", "/quit"]), say=say)
    fake_module.fail = False
    say2, out2 = _make_say()
    run_repl(s, TreeChatConfig(data_dir=tmp_path),
             input_fn=_make_input(["/retry", "/quit"]), say=say2)
    assert any("mock reply" in line for line in out2)
