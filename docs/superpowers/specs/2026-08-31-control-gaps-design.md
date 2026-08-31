# 控制功能缺口补齐设计（2026-08-31 定稿）

> 来源：roadmap「控制功能缺口盘点」①-⑦ + 阶段 2 切片清单。本轮范围：**全部 7 项**。
> 设计原则：统一 API 原则（sibling AGENTS.md 规则 6「有确认的第二消费端才收编」）+
> webview 薄层零业务逻辑；spec/tasklist 编辑重传体验对齐。

## 背景与缺口清单

主链路（取消/暂停/继续、恢复/回退、预填重传、子进程观测）已闭环（2026-08-31），
剩余缺口：

| # | 缺口 | 本轮方案 |
|---|------|---------|
| ① | 手动检查点创建无 UI 入口 | header「存检查点…」按钮 + 小对话框 |
| ② | 恢复前看不到兼容性预检 | 库侧收编组合函数 + dry-run 端点 + 对话框集成 |
| ③ | tasklist 更改重传无编辑起点 | 对话框 textarea 预填（对齐 spec） |
| ④ | 截断 running 态与真运行不可分 | tick 停滞提示（排除 paused）+ 引导强制恢复 |
| ⑤ | 恢复子进程无硬终止 | terminate 端点（注册表进程，不代写终态） |
| ⑥ | 回退目标缺 fired 上下文 | 下拉项展示执行摘要（纯前端，载荷已有） |
| ⑦ | 行内控制按钮 + 编辑器校验 | RunList 行内按钮 + textarea 即时 JSON 校验 |

关键事实：`check_resume_compat` 本体在库（`checkpoint.py`），但**从运行产物出发的
组合**（executed_nodes 提取、目标快照解析含 marking、新 tasklist 建图）只在
`module.py` resume 内联存在——webview dry-run 构成第二个消费端，收编有据。

## 一、库侧收编（SpecModule 仓库，先行）

`module_harness/query.py` 新增：

1. **私有助手 `_executed_nodes(backend, module_id, tick) -> set[str]`**
   firings 表中 `tick < 快照 tick` 的去重节点——把 `module.py:437` 的提取规则
   抽成单一事实源；`module.py` resume 改为调用（纯提取，既有 resume 回归测试
   守护）。注意 `tick == N` 的 firing 属 restore 后重跑部分，不算已执行。
2. **公开组合函数 `check_resume_compat_from_run`**（`__init__.py` `__all__` 导出）：

   ```python
   def check_resume_compat_from_run(
       module_name: str,
       run_id: str,
       *,
       new_tasklist: dict | Tasklist | None = None,  # None = 归档 tasklist（纯续跑预检）
       target: int | str | None = None,              # tick / "manual:<label>" / None 最新
       base_dir: Path | None = None,
   ) -> dict | None
   ```

   组合步骤：目标快照解析（tick → `_resolve_tick_snapshot`；`manual:` →
   checkpoints 表查 tick；解析失败**不 raise**，作为 `hard_errors[0]` 返回并附
   可用清单——错误契约与 module.py 的 KeyError 文案一致，但查询函数选择返回
   而非抛出）→ executed_nodes（助手）→ 旧输入存档（`read_module_inputs`）→
   建图（`build_run_graph` 同款 Mock registry 通道，零 LLM 免 key；图结构与
   真实 runner 一致）→ `check_resume_compat`（marking.slots / armed_starts 取自
   目标快照）。

   错误契约：
   - run.sqlite 缺失/读失败 → `None`（查询容错哲学）→ server 404；
   - tasklist 非法 / 建图失败 → `ValueError` 透传（同 `build_run_graph` 契约）
     → server 400；
   - 返回 `{"target": str, "target_tick": int, "executed_nodes": [str],
     "hard_errors": [str], "warnings": [str]}`。

   `_resolve_target` 不合并：module.py 版本 raise KeyError（带可用清单）、
   预检版本返回 hard_error，错误契约不同，强行统一反而扭曲两边语义。

3. **api.md 补录**（docs: 独立一笔）；库测试：fixture run.sqlite（module_inputs
   + snapshots + firings + checkpoints）断言 hard_errors / warnings / target 解析
   （tick、manual、非法、缺省）/ executed_nodes / None 容错。

发版后本仓库 `pip install -e "../SpecModule"` 同步依赖。

## 二、server 两个新端点（薄映射）

- **`POST /api/runs/{id}/resume/preflight`**，body
  `{module?, target?, tasklist?}`（spec 不参与——兼容性校验只看
  tasklist/图/marking）→ 直调库函数：`None` → 404、`ValueError` → 400、
  其余原样返回。不 spawn、不写任何状态。
- **`POST /api/runs/{id}/process/terminate`**——注册表 `_PROCS` 经 `_reap` 后
  无活进程 → 409「无本 server 启动的恢复进程」（CLI 手起的原始 run 不在观测
  范围，明确不支持）；有 → `popen.terminate()`（Windows 即硬杀，POSIX 为
  SIGTERM）。**不代写终态 phase**：status.json 是库的产物格式，webview 不碰；
  terminate 后 status 停留 `running` 属预期残留，由 ④ 停滞提示引导走强制恢复
  收尾。临时文件由既有惰性收割清理。返回 `{run_id, terminated: true, pid}`。

本仓库 AGENTS.md 端点映射表补两行。

## 三、前端改造（web/）

**恢复对话框**（`RunControls.tsx`）：

- **③ tasklist 预填**：file-only 改为 textarea（`/inputs.tasklist` 预填，
  JSON.stringify 2 空格；dirty 语义同 spec——用户改过则不覆盖）；文件上传变
  「载入到编辑区」（解析后填入 textarea）。提交时非空 → parse → 传 `tasklist`。
- **② 预检集成**：对话框打开即自动调 preflight（当前 module/target/tasklist
  表单值）；module / target / tasklist 任一变更防抖（~500ms）重跑。结果内联：
  `hard_errors` 红色列表
  且**禁用「启动恢复」**；`warnings` 橙色列表不阻断。接口 404/400 显示后端消息。
- **⑥ fired 上下文**：目标下拉每项显示执行摘要
  （`tick 47 · 已执行 12 节点：A→B→C…`，超 3 个省略号）；manual 项按 `tick`
  字段 join 同 tick 快照条目取 fired（checkpoints 载荷 manual 条目 `fired` 为
  空，但含 `tick`）；选中后下拉下方小字展示完整 fired 列表。
- **⑦ 编辑器校验**：spec/tasklist textarea onChange 即时 `JSON.parse`，非法
  红框 + 行内错误文案（不阻断输入；提交仍拦截）。

**检查点创建 ①**：header 控制条加「存检查点…」按钮（选中 run 即显示；
运行中/暂停/终态均可建——纯数据操作）→ 小对话框：label 必填 + tick 可选
（缺省最新）→ `POST /checkpoints`；成功提示 label 与 `overwritten`；错误透出
后端消息（无快照等 KeyError 文案）。

**停滞提示 ④**：App 层跟踪——`phase=running && !paused` 时距**最后一条 WS
消息**超过 120s → 头部黄条「tick 长时间未前进，进程可能已截断/失联；确认
进程已退出可在恢复/回退中勾选强制恢复」（链接打开恢复对话框，**不预勾**
force）。阈值取宽：真实运行中单 tick 可含多次 LLM 调用，tick 间隔 5-10 分钟
属常态——提示是引导信号不是告警，误报由用户看进程一眼消解。paused 排除；
切 run 重置计时。

**terminate 按钮 ⑤ 的前端出口**：App 在 `phase=running` 期间每 3s 轮询
`GET /process`；`process.running` 为 true 时头部显示「终止进程」按钮
（confirm 后 `POST /process/terminate`，成功后刷新）——只对本 server 拉起的
恢复子进程可见（注册表外，如 CLI 手起的原始 run，不显示按钮）。

**行内控制 ⑦**：RunList 每行 phase 感知小按钮——running：暂停 / 取消
（confirm）；paused：继续；终态：恢复…（切换选中该 run 并打开对话框，行内
不做无参直接恢复）。`stopPropagation` 不干扰行选中。

## 四、测试与提交顺序

- **库先行**：feat 一笔（两函数 + module.py 复用 + `__init__` 导出 + 库测试）
  → `docs:` 一笔（api.md）→ 发版。合并前库基线
  `python -m pytest ../SpecModule/module_harness/tests/ -q -m "not smoke"` 全绿。
- **本仓库**：同步依赖；`test_control_api.py` 增 preflight（fixture run.sqlite
  走真库函数，断言 404 / 400 / 结果形状）与 terminate（沿用现有 `_spawn`
  monkeypatch 造 Popen 手法，断言 409 / terminated / 注册表状态）；前端不引
  测试框架：`npm run build`（tsc 门）+ M1 mock run 走查，7 项逐一验收。
- **收尾**：本仓库一笔提交（server + web + tests + roadmap 销项打勾 +
  变更日志 + AGENTS.md 端点表两行）。

## 五、明确不做（YAGNI）

- CLI `resume --dry-run`：库函数已就位，CLI 需要时一行薄加；
- 检查点删除 / 改名：库无此 API（create 的 overwritten 是唯一覆盖语义）；
- terminate 后代写终态 phase：webview 不写库产物格式；
- 停滞检测的进程级活性探测（心跳文件等）：库语义无活性探测，webview 不该猜。
