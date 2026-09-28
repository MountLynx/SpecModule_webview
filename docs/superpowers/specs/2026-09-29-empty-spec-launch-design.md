# 空 spec 模块发起运行放行——设计定稿（2026-09-29）

## 问题

创建器可以产出**无输入字段**的 packed 模块（`spec_schema.input = {}`，如 RRA），库面全链路合法；
但模块库发起运行处被守卫拦截：「spec 为空且无参考 spec——请至少填写一个字段」，
无字段模块在 Web 侧**永远发不起来**。CLI 对 `--spec '{}'` 全然放行——前端比库严了一档。

## 根因（三层）

1. **库面设计**：packed/pip 形态 `default_spec` 恒为 None（`store.ResolvedModule.spec_for`
   对 submodule 返回 `(schema, None)`；entry 转 packed 的 warnings「default_spec 不保留」
   是同一决定）——packed 模块的「spec 参考」区永远显示「未声明参考 spec」，属预期而非 bug。
2. **前端守卫不区分「声明零字段」**：`ModuleDetail` 把「spec 空」一律当「没填」
   （`specEmpty && activeSpec == null` 即禁用），没有读 `activeSchema` 的语义。
3. **附带发现（不在本轮修）**：创建器 SpecDialog 的「default_spec（参考值）」编辑区是
   死区块——组装 manifest 不含该键（`_assemble_pack`），库 packed 形态也无此契约键，
   填了不进包。开 GitHub issue 记录，行为不动。

## 方案（A，定稿）：守卫按 schema 语义放行

`activeSchema`（选中模板 > 模块级）为**空对象**（模块声明无输入字段）时：

- 放行空 spec：提交显式 `{}`（`fallbackEquals` 判定不受影响——packed `default_spec`
  恒 null，`JSON.stringify({}) !== "null"`，spec 走显式通道 → `--spec-file {}`，CLI 合法）。
- 提示文案改为中性色（非警示）：「该模块声明无输入字段——将以空 spec {} 发起」。

其余维持现状：

- schema **非空** → 空 spec 仍拦（等于把 CLI 的缺字段校验错误提前到 UI，价值不变）。
- schema **未声明**（null，典型外部 entry）→ 仍拦（保守，不扩大放行面；JSON 非法仍拦）。
- 服务端零改动：`POST /api/runs` 的 `spec: dict | None` 无空拦截，`{}` 直通
  `--spec-file`（`_resolve_spec` 对 JSON 对象无内容要求）。

## 为什么即便一个输入也建议用命名字段（设计立场，不改行为）

图任务里用户输入进 prompt 的唯一通道是节点 inputs 的 `{spec.字段}` 常量引用
（或 `{spec}` 整体 JSON）——没有字段，节点只能吃常量/上游输出，模块无外部输入口；
spec_schema 同时驱动发起表单、submodule input 校验与 grilling 的 spec 补全。
字段名即语义（`topic` vs `raw_text`）。空 spec 模块只适合真正零外部输入的自包含流程。

## 影响面与验收

- 改动仅 `web/src/components/ModuleDetail.tsx`（守卫判定 + hint 文案与色调）。
- 验收：`npm run build`（tsc 门）；RRA（packed 无字段）发起表单不再拦截、可正常 202。
- convert 链路顺带受益：`entry_to_pack` manifest 恒写 `spec_schema: {"input": …}`，
  无字段 entry 转 packed 后同样吃到放行。
