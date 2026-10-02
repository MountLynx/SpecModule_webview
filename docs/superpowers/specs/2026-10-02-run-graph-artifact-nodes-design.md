# 运行图产物节点：中间产物上图（设计定稿）

> 2026-10-02 定稿。用户指令核心：**产物条不直观——不只是最终产物，所有以链接形式
> 存在的中间产物都要在运行图中显示**。方案 A（问答收敛通过）：卫星产物节点。

## 背景与数据事实

- **最终产物**走声明制：tasklist 顶层 `Artifacts`（glob + pick）→ 终态收集写
  `artifacts.json` → RunView 顶部 ArtifactsStrip 下载条。与图完全脱节——痛点本体。
- **中间产物**实际存在且是结构化文件引用：节点输出 dict 里的 `file` / `pptx` /
  `_image_path` 等键的值（ppt_master 实测：P01-P04 `file` → `svg_output/page_pNN.svg`
  四张页面、NotesGen `file` → `notes/total.md`、Report `pptx` → 两个导出路径）。
  数据源 = `run.sqlite` firings 表每节点末条 output（与 `node_run_summary` 同源）。
- **路径解析锚**：run 子进程 cwd = base_dir（spawn 纪律），输出中的相对路径按
  base_dir 解析即真实文件（已验证 svg_output 四张页面存在）；绝对路径直通。
  **存在性锚定**（解析后 `os.path.isfile` 命中才收）= 天然过滤器：`"ok"`、markdown
  长文、stdout blob 一律不命中，零启发式关键词。

## 库侧（SpecModule 仓库；独立提交 + api.md 补录）

### 新增 `query.node_artifacts(module_id, base_dir=None) -> dict[str, list[dict]] | None`

按节点提取输出中的文件引用（图产物叠加共享层；CLI visualize 未来可复用）：

- **提取源**：`build_timeline` 每节点末条 output（append 序末条即最新，与
  `node_run_summary` 同源同容错；db 缺失/读失败 → None，查询不 raise）。
- **遍历**：output 递归展开（dict/list），收集字符串值；候选预筛 = 非空、无换行、
  ≤512 字符 → 解析（绝对直通；相对锚 `base_dir or Path.cwd()`——与 runs_root
  同一锚定纪律）→ `os.path.isfile` 命中才收。
- **条目形状**：`{index, key, name, path, kind, size, modified}`——
  `key` = 值在输出内的 dot-path（`file` / `pptx.1`）；`name` = basename；
  `path` = 解析后绝对路径（前端 tooltip）；`kind` ∈ `deliverable|intermediate`
  （与 artifacts.json 清单按 path 全等比对，命中即 deliverable）；size/modified
  惯例同 `collect_artifacts`（本地时区裸 ISO8601）；`index` = 该节点列表序
  （节点级下载通道引用）。
- **去重**：节点内按解析路径去重；跨节点按 path 全局去重（timeline append 序
  先到先得）——同一文件多处引用只挂一张卫星卡。
- **边界**：目录值跳过（isfile 纪律同 artifacts.py「v1 只收文件」）；`_image_path`
  等审计键照收（存在即真）。

## 服务端（webview 仓库）

- `GET /api/runs/{id}/graph` 载荷叠加 **`artifacts: Record<node_id, entry[]>`**
  （None → `{}`）；每次调用现算（firings 毫秒级读 + 十几次 stat，tick 节奏无压力）。
- **WS status 推送叠加同名字段**：与 `node_states` 同拍（仅 sig 变化时计算）——
  运行中产物卫星卡随 tick 实时冒出；客户端整体覆盖。
- 新端点 **`GET /api/runs/{id}/nodes/{node}/artifacts/{index}`**：现算 overlay →
  node/index 两级命中 → `FileResponse`（attachment）。404（无 run/无该节点/越界）、
  410（计算后文件被删，OSError 捕获）。客户端只给 node+index，路径永不为客户端
  输入——与清单下载通道同一安全纪律。交付物/中间物统一走此通道（前端单一分支），
  ArtifactsStrip 的清单 index 通道保持不变。
- base_dir / 搜索路径锚定走既有 `deps.py`。

## 前端（web/）

- `api.ts`：`GraphArtifactEntry` 类型；`GraphPayload.artifacts`；`StatusMsg.artifacts?`。
- `dagre.ts`：`layoutGraph` 接受带尺寸节点（status 190×64 / artifact 176×34）；
  卫星节点经 producer→artifact 边参与 dagre（TB 叶节点，自动排在生产者下方）。
- 新 `ArtifactNode.tsx`（nodeTypes `"artifact"`）：紧凑卡——文件图标 + 名称
  （truncate）+ 大小 + 「交付物」徽标（done 绿 pill，kind=deliverable 时）；
  title = 绝对路径 + modified；顶部隐藏 handle（虚线入线锚点）。**点击 = 触发
  下载**（不进 NodePanel、不改变选中态）。
- `GraphView`：
  - `payload.artifacts` → 卫星节点（id `artifact::{node}::{index}`，跨重算稳定，
    measured 带回——同 status 节点纪律，防 WS 采纳重置测量导致连线消失）+
    虚线边（id `ea::{i}`，中性色 + 小箭头）。
  - `minimapColor` 卫星节点独立配色（中性偏文件色调）。
  - `onNodeClick` 分流：artifact → 下载；dataCard → 忽略；status → 既有选中。
- `RunView`：WS `artifacts` 整体覆盖 merge 进 payload（与 node_states 同模式）；
  终态重拉 graph 以库侧为准。
- ArtifactsStrip / NodePanel 不动。

## 边界与非目标

- **卫星卡无占位态**（用户补充定稿）：仅在实际产出落盘（firings 有记录）后出现
  ——新发起的运行初始图零卫星卡，节点真实产出后随 WS 推送冒出；历史/终态 run
  打开即见全部实际产物。
- 无 run.sqlite（失败 run）→ `artifacts = {}`，无卫星节点。
- resume/重跑：overlay 随最新 firings 整体重算——旧引用不在最新输出 → 卫星消失
  （诚实反映当前真相）。
- 目录引用（如 Init `output_dir`）v1 不收；http(s) 外链 v1 不做（后排开 issue）。
- 卫星卡不做内联预览（点 = 下载）；SVG/图片预览后排。
- 卫星卡不参与 trace 值卡与跟随镜头逻辑（follow 只看 status 节点，行为不变）。

## 测试

- **库**：新增 `query.node_artifacts` 用例（tmp_path fixture run：提取/解析/
  存在性过滤/去重/交付物比对/None 容错）；合并前库基线 `-m "not smoke"` 全绿。
- **webview**：TestClient——graph 载荷 `artifacts` 字段形状；节点产物下载端点
  200 / 404 / 410。
- **前端**：`npm run build`（tsc 门）；真实 run（ppt_master_a37223）目验 +
  浏览器验证（卫星卡渲染/点击下载/运行中实时冒出）。

## 提交与同步

1. SpecModule：`feat(query): node_artifacts——节点输出文件引用提取（图产物叠加共享层）`
   + api.md 补录（`docs:` 独立提交）；库基线全绿。
2. webview main：`feat(server)`（graph/WS 叠加 + 下载端点 + 测试）→ `feat(web)`
   （卫星节点 + 布局 + merge）。
3. `merge: main 并入 feat/multiuser-gateway——运行图产物节点同步`；两线各自 push。
4. 归档 `roadmap/finish.md`；URL 外链预览后排开 issue。
