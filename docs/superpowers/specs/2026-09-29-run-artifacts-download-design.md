# run 产物清单 + 下载（设计定稿）

> 2026-09-29 定稿。用户指令核心：**像 ppt 这种 module 会产出文件，本地给 file://
> 链接就行，云端没有下载手段**。方案 A（问答收敛通过）：产出语义收编上游库——
> run 产物清单（声明制）+ webview 下载端点，本地/云端同一 HTTP 交互，
> `file://` 方案整体放弃（跨源页面本就打不开）。库仓库独立提交 + `api.md` 补录。

## 定位与范围

- **缺口比"缺下载按钮"深一层**：`哪些文件是这个 run 的产出`这个语义在库里不存在。
  实测 ppt_master（run `ppt_master_41c912`）：产物写 `<cwd>/<spec.output.dir>/`
  （缺省回填 `projects/<project>`，约 30MB），**不在 run 目录**；节点 outputs 里的
  文件引用是机器本地绝对路径字符串（`{"status":"ok","file":"C:\\..."}`）；
  最终 .pptx 落 `<output.dir>/exports/<project>_<时间戳>.pptx`——**命名不可静态
  预测且同项目多次运行会积累**。
- **云端部署下 server 与 CLI 子进程同机**（架构决定），文件在服务器磁盘存在，
  缺的只是传输通道 → 下载走 HTTP 端点（`Content-Disposition: attachment`），
  本地场景顺手解决，无需两套逻辑。
- **统一 API 原则**：产物清单是 run 的契约数据（CLI/未来消费端同样受益），根修在
  上游库；webview 只做薄映射 + 前端渲染，不做任何"哪些输出算产物"的启发式识别。
- **非目标（v1）**：目录打包 zip 下载、产物在线预览（inline）、cancelled/aborted
  run 的部分产物清单、chat 会话侧文件、`{spec.xxx}` 模板插值机制（见下）。

## 设计定稿相对讨论稿的一处收敛

讨论稿曾含「`path` 支持 `{spec.xxx}` 插值」。定稿**砍掉插值机制**：声明路径为
具体 glob 串，插值由翻译脚本自己完成——翻译脚本本就是持有 spec 的 Python 函数
（ppt_master 的 `tl_generate` 直接用回填后的 `spec["output"]["dir"]` 拼路径），
库侧机制不做任何模板小语言。首个消费方即验证此路线；静态 tasklist 模块若将来
需要 spec 派生路径再议。

## 库侧（SpecModule 仓库，遵守其 AGENTS.md）

### 1. 声明——Tasklist 顶层 `Artifacts` 字段

`module_harness/model/spec.py`：`Tasklist` 增加可选字段
`artifacts: list[ArtifactDecl] = field(default_factory=list)`；新增
`@dataclass ArtifactDecl`：

```python
@dataclass
class ArtifactDecl:
    name: str            # 展示名（前端 label，可中文）
    path: str            # 具体 glob 串；相对路径按运行进程 cwd 解析
    kind: str = "intermediate"   # "deliverable" | "intermediate"
    pick: str = "all"    # "all" | "latest"（匹配集中取 mtime 最新一个）
```

- 序列化键对齐既有大写惯例：dict 形态 `"Artifacts"`（与 `"Tasks"`/`"Flow"`
  并列）；`from_json` 读 `data.get("Artifacts", [])` 逐项
  `ArtifactDecl.from_dict`（轻校验：name/path 非空字符串、kind/pick 枚举成员，
  违规 `ValueError` 带字段路径）；`to_dict` 对称回写。
- **兼容性边界**：`Artifacts` 不参与 resume 兼容性校验
  （`check_resume_compat` 只看节点结构）；随 `module_inputs` 存档
  （`to_dict()`）自然往返；`build_run_graph` 重建与它无关，不受影响。
- 声明由**模块作者**写：翻译脚本形态在构建 tasklist 时注入；静态 tasklist
  直接写进 dict。库只提供机制，不做输出启发式。

### 2. 收集——终态收尾写 `artifacts.json`

新文件 `module_harness/infra/artifacts.py`（`artifacts_path`/`collect_artifacts`/
`write_artifacts_manifest`，`__all__` 显式）：

- 时机：`model/module.py` `_run_with_phases` 的 else 分支，`_finalize_phase`
  之后（done/truncated 两终态共用路径；resume 经同一函数自动覆盖）。
  cancelled/aborted 不收集不写清单（诚实：v1 不保证部分产物）。
- 规则：`glob.glob(decl.path, recursive=True)` 过滤 `is_file()`；`pick=latest`
  取 mtime 最大一个，`pick=all` 按 path 排序全收；相对路径按收集时
  `os.getcwd()`（= spawn cwd）解析为**绝对路径**落清单。声明存在但零匹配 →
  仍写空清单（区分"收集过但没产出"与"没收集过"）。
- 清单文件：`<run_dir>/artifacts.json`，条目
  `{"name", "kind", "path", "size", "modified"}`（绝对路径 + 字节数 +
  ISO8601 本地时间）。不搬文件本体（30MB 项目目录无必要，路径在服务器上
  仍有效）。落盘门槛：run 目录存在（status_file/persist 模式）；无声明的
  run 不产生该文件。
- 前端永远只按 index 引用清单条目，路径不暴露为客户端输入 → 无遍历面。

### 3. 读端——共享查询层 + CLI

- `infra/query.py` `read_artifacts(run_id, base_dir=None) -> dict | None`：
  无 run 目录 → `None`（映射 404，与 read_control 同模式）；无/损坏清单 →
  `{"run_id", "artifacts": []}`；正常 → 条目列表附 `index`（数组序）。
- CLI 子命令 `specmodule artifacts <run-id>`（CLI 先行原则，镜像
  `status`/`review` 的形态）：打印清单表格（index/name/kind/size/path）。

### 4. ppt_master 声明落地（同仓库 `_lib/example`，验证机制）

`ppt_master/translator.py` `tl_generate`：用回填后的 spec 组一条声明——
`name=f"{spec['project']} 演示文稿"`、`kind="deliverable"`、`pick="latest"`、
`path=f"{spec['output']['dir']}/exports/*.pptx"`，随 tasklist 返回。
（中间产物如 notes/images 不声明——v1 交付物先行。）

## server 侧（本仓库，纯薄映射，`server/api/runs.py`）

| 端点 | 库调用 | 契约 |
|---|---|---|
| `GET /api/runs/{id}/artifacts` | `query.read_artifacts` | 200 `{run_id, artifacts: [{index, name, kind, path, size, modified}]}`；无 run → 404 `{error, run_id}`；无清单 → 空数组 |
| `GET /api/runs/{id}/artifacts/{index}` | 清单索引 → `FileResponse` | 200 流式，`Content-Disposition: attachment`（Starlette 对非 ASCII 文件名自动补 `filename*` UTF-8），下载文件名 = `Path(path).name`；index 越界 → 404；清单有但文件已被删 → 410；无 run → 404 |

`index` 用 FastAPI path 参数（`int` 校验，非整数 422）。`path` 字段照实透出
（节点 outputs 本就含绝对路径，单端点隐藏是安全剧场；调试 curl 有用）。

## 前端（本仓库 `web/`）

- `src/api.ts`：`RunArtifact` 类型 + `fetchRunArtifacts(runId)`。
- `RunView`：终态（done/truncated/aborted/cancelled）翻转时及终态 run 首载时
  拉取；控制条下方渲染**产物条**（ArtifactsStrip）：文件图标 + name + 体积
  （`modified` 进 title 提示）+ 下载按钮 chips 行，`kind=deliverable` 加强调
  徽标；清单为空不渲染。本地/云端同一 `<a href download>` 交互。
- outputs 文本区维持原样——不做路径识别（启发式已被声明机制替代）。

## 测试

- **库**（`module_harness/tests/`，新 `test_artifacts.py`）：
  `collect_artifacts`（glob 展开/pick 两种/相对→绝对/零匹配空清单/目录条目跳过）；
  `_run_with_phases` 写入时机（done/truncated 写、cancelled/aborted 不写、
  无声明不产文件）；`ArtifactDecl`/`Tasklist` 序列化往返；`read_artifacts`
  （无 run → None、无/损坏清单 → 空列表、正常形状）；CLI `artifacts` 输出。
  声明模块用 tests 内 fixture 小模块，不依赖 ppt_master 真跑。
- **本仓库**（`tests/`）：清单端点契约（200 形状/404/空清单/损坏清单）；下载
  端点（200 attachment 头 + 字节一致/越界 404/文件已删 410/无 run 404）。
  fixture run 目录按隔离惯例落 `tmp_path`。
- 库基线回归：`uv run pytest ../SpecModule/module_harness/tests/ -q -m "not smoke"`。

## 提交切片

1. SpecModule `feat(artifacts)`：ArtifactDecl/Tasklist.Artifacts + 收集器 +
   `_run_with_phases` 挂点 + `read_artifacts` + CLI `artifacts` + 测试。
2. SpecModule `feat(example)`：ppt_master `tl_generate` 注入声明；顺手记录
   （不修）vendor `svg_to_pptx.py` ImportError 的既有缺陷。
3. SpecModule `docs:`：`api.md` 补录（Tasklist.Artifacts / collect /
   read_artifacts / CLI）+ 版本 bump。
4. 本仓库 `feat(server)`：两端点 + 测试。
5. 本仓库 `feat(web)`：api.ts + ArtifactsStrip；AGENTS.md 端点映射表补两行。

## 部署注记

本地 uv.sources 锚 `../SpecModule` editable，切片 1-3 合入即生效；**云端部署
需库发 PyPI 新版**后同步依赖版本——实施完成时发一条 issue 备忘部署侧动作。
