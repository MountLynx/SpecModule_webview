# ppt_master 入口补 default_spec（参考 spec）（设计定稿）

> 2026-09-29 定稿。用户指令：**ppt-master 新增参考 spec**（问答收敛：入口加
> `default_spec`）。镜像上游先例 d96924c（academic_writer 补 default_spec/
> spec_schema——webview spec 参考试运行试剂），把同样的试剂补给 ppt_master。
> 姊妹篇：《packed 模块 default_spec（spec 参考）契约补齐》（同日）——那边
> 修 packed 形态的契约通道，本篇给 entry 形态的 ppt_master 填上实际内容。

## 定位与范围

- ppt_master 入口现状 `default_spec=None`（注释「页册因项目而异，无零配置缺省」
  ），webview 发起页「spec 参考」区块因此显示「模块未声明参考 spec」。
- 参考语义澄清：`default_spec` 是**参考预填值**（webview 表单预填 + 一键试跑
  ），不是「零配置即可产出正式 PPT」的承诺——原注释顾虑的是后者，两者不冲突。
- webview 侧**零代码改动**：发起页 `detail.default_spec` 有值后预填、「用参考
  spec 尝试运行」自动生效、未动过的表单走 `spec:null` CLI 回落通道（与
  `entry.default_spec` 两端一致，机制既有）。

## 库侧（SpecModule 仓库，遵守其 AGENTS.md）

1. `example/modules/ppt_master.py` — entry 增 `default_spec`（声明在 entry 级，
   单模板模块不走 `template_specs` 覆盖，与 academic_writer 先例同款）：

   ```python
   default_spec={
       "project": "demo_deck",
       "source": {"kind": "topic", "topic": (
           "用大模型做代码评审：LLM 分析 diff，生成按 severity 分类的"
           " comments；在 200 个 PR 上 accuracy 85%，比规则 baseline 高 15 个百分点。"
       )},
       "images": {"sources": ["placeholder"]},  # 试跑零图像 API 依赖；实战换 ai/user
       "roster": [
           {"id": "p01", "title": "LLM 代码评审", "role": "cover"},
           {"id": "p02", "title": "方法：diff → 分类 comments",
            "points": ["LLM 分析 diff", "按 severity 分类：critical/warning/suggestion"]},
           {"id": "p03", "title": "实验：200 PR accuracy 85%",
            "points": ["比规则 baseline 高 15 个百分点"]},
           {"id": "p04", "title": "结语与未来工作", "role": "closing"},
       ],
   },
   ```

   取舍：主题沿用 academic_writer 参考值的「LLM 代码评审」叙事（example 线
   内容自洽）；topic 通道自包含无外部文件依赖；`images` 显式 `placeholder`
   （省略则规划者裁量可能选 `ai`，只配 LLM key 的环境试跑会中途死在图像后端
   ——参考值的首要职责是试跑能跑完）。

2. `example/test_ppt_master_module.py` — 新增一条测试：加载 entry（与
   `test_discover_academic_writer` 同机制），断言 `default_spec` 通过
   `validate_ppt_spec` 契约校验，且经文件内 `_validated_tasklist` helper 翻译
   层全通（roster/页 id 在两层被钉住）。

3. **store 安装副本同步**：`~/.specmodule/modules/ppt_master.py`（带 `_lib`
   bootstrap 头的安装版）对齐同一段 `default_spec`——只动 entry 字典，头部
   与 `_lib/` 实现包不动（本次不改包代码）。

## 语义变化（明确接受项）

CLI `specmodule run/resume --module ppt_master` 不带 spec 时，从报错变为跑
demo deck——参考 spec 的应有效果，与 academic_writer 行为对齐。

## 测试与验收

- SpecModule：`uv run pytest example/test_ppt_master_module.py -q` 全绿；基线
  `uv run pytest module_harness/tests/ -q -m "not smoke"` 全绿。
- store 副本：导入安装版 entry 断言 `default_spec` 非空且通过
  `validate_ppt_spec`。
- webview 端到端：起 server → `GET /api/modules/ppt_master` 载荷含
  `default_spec` → 发起页预填/试运行按钮点亮；`uv run pytest tests/ -q`
  无回归（本仓库无代码改动）。
- 收尾：库仓库一笔提交
  `feat(example): ppt_master 补 default_spec——webview spec 参考试运行试剂`；
  webview 仓库仅本设计文档一笔（琐碎不记 finish.md）。
