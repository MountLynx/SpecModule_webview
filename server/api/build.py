# server/api/build.py
"""构建面端点：组件库/草稿统一 CRUD + pack 组装安装（模块构建器后端）。

组件库锚 store_home()/library/（与 modules/、manifests/ 同根，SPECMODULE_HOME
可覆盖）；harness/command 校验走库 from_dict 实例化，script/guard 只收标识符
命名的 UTF-8 .py 文本（stem=注册名，loader 语义）；组装只调 validate_pack_dir/
install_pack——本层零校验逻辑；tasklist 生成本层唯一实现（draft_to_tasklist）。
"""

from __future__ import annotations

import json
import shutil
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request

from module_harness import query, store
from module_harness.cli.command import CommandConfig
from module_harness.cli.scaffold import validate_module_name
from module_harness.core.config import HarnessConfig
from module_harness.infra.entry_pack import entry_to_pack
from server.deps import get_search_paths

router = APIRouter(prefix="/api")

_KINDS = ("harnesses", "commands", "scripts", "guards")
_EXT = {"harnesses": ".json", "commands": ".json", "scripts": ".py", "guards": ".py"}
_PY_KINDS = ("scripts", "guards")


def library_root() -> Path:
    """组件库根：store_home()/library（惰性建目录）。"""
    d = store.store_home() / "library"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _check_name(name: str) -> str:
    if not validate_module_name(name):
        raise HTTPException(
            status_code=400, detail={"error": f"非法名称: {name!r}（须为 Python 标识符）"})
    return name


def _kind_listing(root: Path, kind: str) -> list[str]:
    d = root / kind
    return sorted(p.stem for p in d.glob(f"*{_EXT[kind]}")) if d.is_dir() else []


def _read_submodule_index() -> list[dict]:
    p = library_root() / "submodules.json"
    if not p.is_file():
        return []
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except ValueError:
        return []
    return (
        [e for e in data if isinstance(e, dict) and isinstance(e.get("name"), str)]
        if isinstance(data, list) else []
    )


def _now() -> str:
    from datetime import datetime
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _write_submodule_index(entries: list[dict]) -> None:
    p = library_root() / "submodules.json"
    p.write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")


def _list_drafts() -> list[str]:
    d = library_root() / "drafts"
    return sorted(p.stem for p in d.glob("*.json")) if d.is_dir() else []


_NODE_TYPES = ("harness", "script", "command", "submodule")
_REF_FIELD = {"harness": "harness", "script": "script",
              "command": "command", "submodule": "submodule"}
_SCHEMA_TYPES = ("str", "int", "float", "bool", "list", "dict", "any")


def _draft_err(msg: str):
    return HTTPException(status_code=400, detail={"error": msg})


def _validate_draft(draft, name: str) -> dict:
    """草稿结构校验（轻量：形状与命名纪律；引用完整性留给组装期 validate_pack_dir）。"""
    if not isinstance(draft, dict):
        raise _draft_err("草稿须为 JSON 对象")
    meta = draft.get("meta")
    if not isinstance(meta, dict) or not meta.get("name"):
        raise _draft_err("草稿缺 meta.name")
    if meta["name"] != name:
        raise _draft_err(f"meta.name({meta['name']})与路径({name})不一致")
    nodes = draft.get("nodes")
    if not isinstance(nodes, list):
        raise _draft_err("nodes 须为数组")
    labels: list[str] = []
    for n in nodes:
        if (not isinstance(n, dict) or not isinstance(n.get("id"), str) or not n["id"]
                or not isinstance(n.get("label"), str) or not n["label"]):
            raise _draft_err("节点缺 id/label")
        if not validate_module_name(n["label"]):
            raise _draft_err(f"节点名须为标识符: {n['label']!r}")
        if n.get("type") not in _NODE_TYPES:
            raise _draft_err(f"节点类型非法: {n.get('type')!r}")
        if not n.get(_REF_FIELD[n["type"]]):
            raise _draft_err(f"节点 {n['label']} 缺引用（{n['type']}）")
        # Fix B：inputs/overrides/outputs 须为对象——形状逃逸会让组装路径的
        # dict()/update() 抛 TypeError，PUT 侧即拒
        for opt in ("inputs", "overrides", "outputs"):
            if opt in n and not isinstance(n[opt], dict):
                raise _draft_err(f"节点 {n['label']} 的 {opt} 须为对象")
        labels.append(n["label"])
    dupes = sorted({x for x in labels if labels.count(x) > 1})
    if dupes:
        raise _draft_err(f"节点名重复: {dupes}")
    # Fix A：id 重复会静默塌图（两节点同 id → Flow 错乱），与名重复同级拒绝
    ids = [n["id"] for n in nodes]
    id_dupes = sorted({x for x in ids if ids.count(x) > 1})
    if id_dupes:
        raise _draft_err(f"节点 id 重复: {id_dupes}")
    edges = draft.get("edges")
    if not isinstance(edges, list):
        raise _draft_err("edges 须为数组")
    node_ids = {n["id"] for n in nodes}
    for e in edges:
        if (not isinstance(e, dict) or not isinstance(e.get("from"), str)
                or e["from"] not in node_ids or not isinstance(e.get("to"), str)
                or e["to"] not in node_ids):
            raise _draft_err("边引用了不存在的节点 id")
    schema = draft.get("spec_schema", [])
    if not isinstance(schema, list) or any(
        not isinstance(f, dict) or not isinstance(f.get("field"), str) or not f["field"]
        or not validate_module_name(f["field"])
        or f.get("type") not in _SCHEMA_TYPES
        for f in schema
    ):
        raise _draft_err(f"spec_schema 须为 [{{field,type}}]，type ∈ {'/'.join(_SCHEMA_TYPES)}")
    # Fix D：spec_schema.output 透传——外部 pack 的 output 侧经草稿往返不丢
    #（形状检查非业务校验；None/缺省 = 无透传，组装侧不写 output 键）
    out = draft.get("spec_schema_output")
    if out is not None and not isinstance(out, dict):
        raise _draft_err("spec_schema_output 须为对象（output 侧透传字段）")
    # default_spec 形状检查：须为对象（缺省/空 = 无参考；组装侧真值才写 manifest）
    ds = draft.get("default_spec")
    if ds is not None and not isinstance(ds, dict):
        raise _draft_err("default_spec 须为对象（{字段: 参考值}）")
    return draft


def _save_draft(name: str, raw: bytes) -> dict:
    """草稿保存：JSON 解析 + 轻量结构校验后落 drafts/<name>.json（盖 updated_at）。"""
    try:
        draft = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as e:
        raise _draft_err(f"草稿 JSON 无效: {e}")
    draft = _validate_draft(draft, name)
    draft["updated_at"] = _now()
    p = library_root() / "drafts" / f"{name}.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(draft, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"saved": True, "kind": "drafts", "name": name}


def get_draft(name: str) -> dict:
    """草稿详情：API 自写文件的读防护（磁盘上手改损坏 → 400 而非 500）。"""
    _check_name(name)
    p = library_root() / "drafts" / f"{name}.json"
    if not p.is_file():
        raise HTTPException(status_code=404, detail={"error": f"草稿 '{name}' 不存在"})
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (ValueError, UnicodeDecodeError) as e:
        raise HTTPException(
            status_code=400, detail={"error": f"草稿 '{name}' 读取失败: {e}"})


def _delete_draft(name: str) -> dict:
    """删除草稿文件，不存在 → 404。"""
    _check_name(name)
    p = library_root() / "drafts" / f"{name}.json"
    if not p.is_file():
        raise HTTPException(status_code=404, detail={"error": f"草稿 '{name}' 不存在"})
    p.unlink()
    return {"deleted": True, "kind": "drafts", "name": name}


def draft_to_tasklist(draft: dict) -> dict:
    """草稿 → tasklist dict（{Tasks, Flow}）——组装与 validate 共用的唯一实现。

    edges 的 from/to 是节点 id；起点标记 `[名]` 只在该起点节点首条出边出现一次
    （tickflow 允许多起点，各起点各自的边各自带标记）；孤立起点（零出边）补
    `[名]` 标记行（裸名整行只在单节点 Flow 可解析，标记行任何位置都可解析且
    注册起点）；join 覆盖（非 AND）追加 `<名>.join: OR` 行。生成正确性最终由
    validate_pack_dir 把关。
    """
    nodes = draft["nodes"]
    label_of = {n["id"]: n["label"] for n in nodes}
    starts = {n["id"] for n in nodes if n.get("is_start")}
    tasks: dict[str, dict] = {}
    for n in nodes:
        field = _REF_FIELD[n["type"]]
        d: dict = {"type": n["type"], field: n[field]}
        if n["type"] == "submodule":
            if n.get("outputs"):
                d["outputs"] = dict(n["outputs"])
        else:
            d.update(n.get("overrides") or {})
        if n.get("inputs"):
            d["inputs"] = dict(n["inputs"])
        tasks[n["label"]] = d
    lines: list[str] = []
    marked: set[str] = set()
    for e in draft["edges"]:
        src = label_of[e["from"]]
        if e["from"] in starts and e["from"] not in marked:
            src = f"[{src}]"
            marked.add(e["from"])
        arrow = f"--|{e['guard']}|-->" if e.get("guard") else "-->"
        lines.append(f"{src} {arrow} {label_of[e['to']]}")
    # Fix C：孤立起点（零出边）没有行可打标记——补 `[名]` 标记行。裸名整行
    # 只在整条 Flow 为单名时可解析（混合流 parse 拒收）；[名] 行任意位置
    # 可解析且注册起点，单节点模块 Flow 也不为空。
    for n in nodes:
        if n["id"] in starts and n["id"] not in marked:
            lines.append(f"[{n['label']}]")
    for n in nodes:
        if n.get("join", "AND") == "OR":
            lines.append(f"{n['label']}.join: OR")
    return {"Tasks": tasks, "Flow": "\n".join(lines)}


@router.get("/library")
def library_index() -> dict:
    """组件库分组清单（名字列表 + submodule 索引 + 草稿名）。"""
    root = library_root()
    return {
        "harnesses": _kind_listing(root, "harnesses"),
        "commands": _kind_listing(root, "commands"),
        "scripts": _kind_listing(root, "scripts"),
        "guards": _kind_listing(root, "guards"),
        "submodules": _read_submodule_index(),
        "drafts": _list_drafts(),
    }


_CFG_CLS = {"harnesses": HarnessConfig, "commands": CommandConfig}


@router.get("/library/{kind}/{name}")
def library_item(kind: str, name: str) -> dict:
    """单组件详情：harness/command = 存储 JSON；scripts/guards = {name, code}；
    submodules = 索引条目（{name, added_at}，未登记 → 404）。"""
    _check_name(name)
    if kind in _CFG_CLS:
        p = library_root() / kind / f"{name}.json"
        if not p.is_file():
            raise HTTPException(status_code=404, detail={"error": f"{kind}/{name} 不存在"})
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except (ValueError, UnicodeDecodeError) as e:
            raise HTTPException(
                status_code=400, detail={"error": f"{kind}/{name} 读取失败: {e}"})
    if kind in _PY_KINDS:
        p = library_root() / kind / f"{name}.py"
        if not p.is_file():
            raise HTTPException(status_code=404, detail={"error": f"{kind}/{name} 不存在"})
        try:
            code = p.read_text(encoding="utf-8")
        except (ValueError, UnicodeDecodeError) as e:
            raise HTTPException(
                status_code=400, detail={"error": f"{kind}/{name} 读取失败: {e}"})
        return {"name": name, "code": code}
    if kind == "drafts":
        return get_draft(name)
    if kind == "submodules":
        for e in _read_submodule_index():
            if e.get("name") == name:
                return e
        raise HTTPException(status_code=404, detail={"error": f"submodule '{name}' 未登记"})
    raise HTTPException(status_code=404, detail={"error": f"未知组件类别: {kind}"})


def _save_config(kind: str, name: str, raw: bytes) -> dict:
    """harness/command 保存：库 from_dict 实例化验形（消费库而非自写校验）。"""
    cls = _CFG_CLS[kind]
    try:
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("须为 JSON 对象")
        cls.from_dict(data)
    except (ValueError, TypeError, UnicodeDecodeError) as e:
        raise HTTPException(status_code=400, detail={"error": f"{kind} 配置无效: {e}"})
    if data.get("name") != name:
        raise HTTPException(
            status_code=400,
            detail={"error": f"name 字段({data.get('name')})与路径({name})不一致"})
    p = library_root() / kind / f"{name}.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"saved": True, "kind": kind, "name": name}


def _save_code(kind: str, name: str, raw: bytes) -> dict:
    """scripts/guards 上传：UTF-8 .py 文本，stem = 注册函数名（loader 语义）。"""
    try:
        code = raw.decode("utf-8")
    except UnicodeDecodeError as e:
        raise HTTPException(status_code=400, detail={"error": f"脚本须为 UTF-8 文本: {e}"})
    p = library_root() / kind / f"{name}.py"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(code, encoding="utf-8")
    return {"saved": True, "kind": kind, "name": name}


def _add_submodule(name: str, search: list[Path]) -> dict:
    """登记已安装 packed 模块为可引用 submodule（索引记名，组装时才拷包）。"""
    src = store.resolve_module(name, search=search)
    if src is None:
        raise HTTPException(status_code=404, detail={"error": f"模块 '{name}' 未找到"})
    if src.kind not in ("packed", "pip"):
        raise HTTPException(status_code=400, detail={
            "error": f"模块 '{name}' 为 {src.kind} 形态，仅 packed/pip 可作 submodule"})
    entries = _read_submodule_index()
    if not any(e.get("name") == name for e in entries):
        entries.append({"name": name, "added_at": _now()})
        entries.sort(key=lambda e: e["name"])
        _write_submodule_index(entries)
    return {"saved": True, "kind": "submodules", "name": name}


@router.put("/library/{kind}/{name}")
async def save_library_item(
    kind: str, name: str, request: Request,
    search: list[Path] = Depends(get_search_paths),
) -> dict:
    """保存（PUT = create-or-update）：JSON 配置 / 代码文本 / 草稿 / submodule 登记。"""
    _check_name(name)
    if kind in _CFG_CLS:
        return _save_config(kind, name, await request.body())
    if kind in _PY_KINDS:
        return _save_code(kind, name, await request.body())
    if kind == "drafts":
        return _save_draft(name, await request.body())
    if kind == "submodules":
        return _add_submodule(name, search)
    raise HTTPException(status_code=404, detail={"error": f"未知组件类别: {kind}"})


@router.delete("/library/{kind}/{name}")
def delete_library_item(kind: str, name: str) -> dict:
    """删除组件：json/py 按类别扩展名定位，不存在 → 404；submodules 按
    名过滤索引条目（幂等——未登记也返回 deleted，不 404）。"""
    _check_name(name)
    if kind in _KINDS:
        p = library_root() / kind / f"{name}{_EXT[kind]}"
        if not p.is_file():
            raise HTTPException(status_code=404, detail={"error": f"{kind}/{name} 不存在"})
        p.unlink()
        return {"deleted": True, "kind": kind, "name": name}
    if kind == "drafts":
        return _delete_draft(name)
    if kind == "submodules":
        _write_submodule_index([e for e in _read_submodule_index() if e.get("name") != name])
        return {"deleted": True, "kind": "submodules", "name": name}
    raise HTTPException(status_code=404, detail={"error": f"未知组件类别: {kind}"})


# ── pack 组装 + dry-run 校验 ──────────────────────────────────────────


def _load_draft_for_assembly(body: dict) -> dict:
    name = (body or {}).get("draft")
    if not name:
        raise HTTPException(status_code=400, detail={"error": "缺 draft 名"})
    return get_draft(name)


def _find_packed_source(name: str, search: list[Path]) -> Path:
    """已安装 packed 模块的包目录（submodule 整包拷贝源）。缺失抛 ValueError。"""
    src = store.resolve_module(name, search=search)
    if src is None:
        raise ValueError(f"submodule 源包未找到（可能已卸载）: {name}")
    if src.kind not in ("packed", "pip"):
        raise ValueError(f"submodule 源 '{name}' 非 packed 形态: {src.kind}")
    return Path(src.path)


def _assemble_pack(draft: dict, search: list[Path]) -> Path:
    """草稿 → 临时 pack 目录（不落 store；失败自清理，成功后调用方负责 rmtree）。

    只拷被引用组件（包自包含——拷贝进包语义）；submodule 整包 copytree 进
    submodules/<键>/，manifest modules 列表与目录双向一致。
    """
    pack = Path(tempfile.mkdtemp(prefix="specmodule_build_"))
    try:
        meta = draft["meta"]
        root = library_root()
        schema = {f["field"]: f["type"] for f in draft.get("spec_schema", [])}
        sub_names = sorted(
            {n["submodule"] for n in draft["nodes"] if n["type"] == "submodule"})
        # spec_schema.output 透传：草稿带 spec_schema_output 时原样写回 manifest
        #（外部 pack 的 output 侧经反解→更新往返不静默丢失；缺省形状不变）
        spec_schema: dict = {"input": schema}
        if draft.get("spec_schema_output"):
            spec_schema["output"] = draft["spec_schema_output"]
        manifest = {
            "name": meta["name"],
            "version": meta.get("version", "0.1.0"),
            "description": meta.get("description", ""),
            "submodule": False,
            "spec_schema": spec_schema,
            "requires": [],
            "modules": sub_names,
            "tasklist": draft_to_tasklist(draft),
        }
        if draft.get("default_spec"):
            manifest["default_spec"] = dict(draft["default_spec"])
        (pack / "module.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

        def copy_kind(kind: str, names, ext: str) -> None:
            for nm in sorted(names):
                src = root / kind / f"{nm}{ext}"
                if not src.is_file():
                    raise ValueError(f"库组件缺失: {kind}/{nm}")
                dst = pack / kind
                dst.mkdir(exist_ok=True)
                shutil.copy2(src, dst / src.name)

        copy_kind("harnesses", {n["harness"] for n in draft["nodes"] if n["type"] == "harness"}, ".json")
        copy_kind("commands", {n["command"] for n in draft["nodes"] if n["type"] == "command"}, ".json")
        copy_kind("scripts", {n["script"] for n in draft["nodes"] if n["type"] == "script"}, ".py")
        copy_kind("guards", {e["guard"] for e in draft["edges"] if e.get("guard")}, ".py")
        for nm in sub_names:
            shutil.copytree(_find_packed_source(nm, search), pack / "submodules" / nm)
        return pack
    except BaseException:
        shutil.rmtree(pack, ignore_errors=True)
        raise


@router.post("/modules/packs/validate")
def validate_pack(body: dict, search: list[Path] = Depends(get_search_paths)) -> dict:
    """dry-run：组装临时目录 → validate_pack_dir（零落盘），附生成的 tasklist 供 UI 预览。"""
    draft = _load_draft_for_assembly(body)
    pack = None
    try:
        pack = _assemble_pack(draft, search)
        manifest = store.validate_pack_dir(pack)
    except (ValueError, TypeError, KeyError) as e:
        # KeyError/TypeError：手改草稿绕过 PUT 校验的形状逃逸——兜 400 不 500
        raise HTTPException(status_code=400, detail={"error": str(e)})
    finally:
        if pack is not None:
            shutil.rmtree(pack, ignore_errors=True)
    # manifest 即我们写入的 module.json 解析回读，tasklist 与 draft_to_tasklist
    # 同一 dict——直接复用，不重算（validate_pack_dir 缺 tasklist 即抛，必存在）
    return {"ok": True, "manifest": manifest, "tasklist": manifest["tasklist"]}


@router.post("/modules/packs")
def install_pack_route(
    body: dict,
    search: list[Path] = Depends(get_search_paths),
) -> dict:
    """组装 + validate + install_pack（source="webview-builder"）→ 返回模块详情。

    同名已存在（store 或任何搜索来源，防遮蔽）→ 409；校验/组装失败 → 400。
    """
    draft = _load_draft_for_assembly(body)
    name = draft["meta"]["name"]
    if store.resolve_module(name, search=search) is not None:
        raise HTTPException(status_code=409, detail={
            "error": f"模块 '{name}' 已存在——改名或先卸载", "module": name})
    pack = None
    try:
        pack = _assemble_pack(draft, search)
        store.install_pack(pack, source="webview-builder")
    except (ValueError, TypeError, KeyError) as e:
        status = 409 if "已存在" in str(e) else 400
        raise HTTPException(status_code=status, detail={"error": str(e), "module": name})
    finally:
        if pack is not None:
            shutil.rmtree(pack, ignore_errors=True)
    # install_pack 首次落盘时才创建 store/modules——请求起始算好的 search 不含它
    # （search_paths 只收已存在目录），装后详情须现算搜索路径
    resolved = store.resolve_module_full(name, search=get_search_paths())
    if resolved is None:
        raise HTTPException(status_code=500, detail={"error": "安装后详情读取失败", "module": name})
    return store.detail_to_dict(resolved)


# ── 已装模块更新（同名覆盖）───────────────────────────────────────────


@router.post("/modules/packs/update")
def update_pack_route(
    body: dict,
    search: list[Path] = Depends(get_search_paths),
) -> dict:
    """同名覆盖更新已装 packed 模块：组装 → validate_pack_dir（先于任何写入）→
    apply_update（库语义：旧包移 .bak → 拷入 → 刷 manifest，失败自动回滚）。

    未安装 → 404（安装走 POST /api/modules/packs）；entry/pip 目标 → 400
    （pip 同名体不覆盖——避免 store 副本遮蔽 pip 原体）；已装包损坏 → 400；
    包文件被占用（Windows 运行中进程持锁）→ 400。
    """
    draft = _load_draft_for_assembly(body)
    name = draft["meta"]["name"]
    try:
        resolved = store.resolve_module_full(name, search=search)
    except ValueError as e:
        # 已装包损坏（ModuleLoader 加载失败）→ 400 而非 500（manage.py 同款防护）
        raise HTTPException(status_code=400, detail={"error": str(e), "module": name})
    if resolved is None:
        raise HTTPException(status_code=404, detail={
            "error": f"模块 '{name}' 未安装——全新安装走 POST /api/modules/packs",
            "module": name})
    if resolved.kind != "packed":
        raise HTTPException(status_code=400, detail={
            "error": f"更新目标 '{name}' 为 {resolved.kind} 形态，仅 packed 可更新",
            "module": name})
    pack = None
    try:
        pack = _assemble_pack(draft, search)
        store.validate_pack_dir(pack)
        store.apply_update(name, pack)
    except OSError as e:
        # Windows 现实场景：运行中子进程持有包文件——OSError 在 .bak 挪移即抛
        # （早于任何 store 变更），映射 400 不丢数据
        raise HTTPException(status_code=400, detail={
            "error": f"更新失败：模块文件被占用（可能有运行中的进程正在使用）: {e}",
            "module": name})
    except (ValueError, TypeError, KeyError) as e:
        raise HTTPException(status_code=400, detail={"error": str(e), "module": name})
    finally:
        if pack is not None:
            shutil.rmtree(pack, ignore_errors=True)
    updated = store.resolve_module_full(name, search=get_search_paths())
    if updated is None:
        raise HTTPException(status_code=500, detail={"error": "更新后详情读取失败", "module": name})
    return store.detail_to_dict(updated)


# ── 已装模块反解（编辑闭环入口）───────────────────────────────────────


def _gen_id(prefix: str) -> str:
    """节点/边短随机 id（与前端 genId 同形：前缀_6hex）。"""
    import secrets
    return f"{prefix}_{secrets.token_hex(3)}"


def _component_content_eq(src: Path, dst: Path, kind: str) -> bool:
    """组件内容等价：harness/command 按 JSON 语义比对（parse 后相等），
    scripts/guards 按文本比对；任一侧损坏（非法 JSON/非 UTF-8）→ 不等价。"""
    try:
        if kind in _CFG_CLS:
            return (json.loads(src.read_text(encoding="utf-8"))
                    == json.loads(dst.read_text(encoding="utf-8")))
        return src.read_text(encoding="utf-8") == dst.read_text(encoding="utf-8")
    except (ValueError, UnicodeDecodeError, OSError):
        return False


def _import_pack_component(
    root: Path, pack: Path, kind: str, name: str | None, report: dict,
) -> None:
    """包内组件 → 组件库：缺则写入（imported）；在则内容比对——一致 existed，
    不一致 conflicts（沿用库版本，不覆盖共享资产）。包内缺失 → warnings。"""
    if not name:
        return
    src = pack / kind / f"{name}{_EXT[kind]}"
    if not src.is_file():
        report["warnings"].append(f"包内组件缺失: {kind}/{name}")
        return
    dst = root / kind / f"{name}{_EXT[kind]}"
    if dst.is_file():
        (report["existed"] if _component_content_eq(src, dst, kind)
         else report["conflicts"]).append(f"{kind}/{name}")
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    report["imported"].append(f"{kind}/{name}")


@router.post("/modules/{name}/decompile")
def decompile_module(name: str, search: list[Path] = Depends(get_search_paths)) -> dict:
    """已装 packed 模块 → 构建器草稿（图结构走库直渲染通道，Flow 零反解析）。

    节点 type/引用/inputs/overrides/outputs 取 manifest tasklist 原始声明，
    is_start/join/边取 graph_to_dict；spec_schema.input 反转为草稿字段，
    output 侧存 spec_schema_output 透传。组件导入三态报告；submodule 引用
    不可解析 → warnings（更新组装时会失败，提前透出）。同名草稿覆盖
    （UI 侧 confirm）。entry/pip 形态 → 400；未找到 → 404。
    """
    _check_name(name)
    # 损坏已装包 → resolve_module_full 抛 ValueError（ModuleLoader 拒收），兜 400
    # （manage.py module_detail 同款先例；update_pack_route 同）
    try:
        resolved = store.resolve_module_full(name, search=search)
    except ValueError as e:
        raise HTTPException(status_code=400, detail={
            "error": str(e), "module": name})
    if resolved is None:
        raise HTTPException(status_code=404, detail={
            "error": f"模块 '{name}' 未找到", "module": name})
    if resolved.kind != "packed":
        raise HTTPException(status_code=400, detail={
            "error": f"模块 '{name}' 为 {resolved.kind} 形态，仅 packed 可反解编辑",
            "module": name})
    pack = Path(resolved.source.path)
    try:
        manifest = json.loads((pack / "module.json").read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeDecodeError) as e:
        raise HTTPException(status_code=400, detail={
            "error": f"module.json 读取失败: {e}", "module": name})
    tasklist = manifest.get("tasklist")
    if not isinstance(tasklist, dict) or not isinstance(tasklist.get("Tasks"), dict):
        raise HTTPException(status_code=400, detail={
            "error": "manifest 缺少 tasklist.Tasks", "module": name})
    # spec_schema.input 形状前置检查：真值非 dict（外部手写 list 等）会让
    # 反转 .items() 抛 AttributeError → 500
    schema = manifest.get("spec_schema") or {}
    if not isinstance(schema.get("input") or {}, dict):
        raise HTTPException(status_code=400, detail={
            "error": "spec_schema.input 须为对象（{field: type}）", "module": name})
    # default_spec 形状前置检查：须为对象（参考 spec）。库 loader 装载期已拒收
    # 非 dict（resolve_module_full 先于此读 manifest 即抛），此处守 HTTP 层形状
    # 契约、错误信息本地化——双保险不依赖加载时序
    default_spec = manifest.get("default_spec")
    if default_spec is not None and not isinstance(default_spec, dict):
        raise HTTPException(status_code=400, detail={
            "error": "default_spec 须为对象（参考 spec）", "module": name})
    tasks: dict = tasklist["Tasks"]
    try:
        built = query.build_run_graph(name, tasklist=tasklist, src=resolved.source)
        # tasklist 为 dict 时 build_run_graph 必返回 tuple（None 仅在无存档且未传 tasklist 的情况）
        g = query.graph_to_dict(*built)
    except (ValueError, KeyError) as e:
        # KeyError：Tasks 有 Flow 无（外部 pack 漂移）→ graph_builder 裸 KeyError
        raise HTTPException(status_code=400, detail={
            "error": f"反解建图失败: {e}", "module": name})
    # Flow 有 Tasks 无 → graph_to_dict 降级 type="unknown" 节点（读路径渲染容忍
    # 漂移，写路径合成拒绝）：预检防边合成期 id_of KeyError
    drift = sorted(n["id"] for n in g["nodes"] if n["id"] not in tasks)
    if drift:
        raise HTTPException(status_code=400, detail={
            "error": f"Flow 引用了 Tasks 中不存在的节点: {drift}", "module": name})

    root = library_root()
    report: dict = {"imported": [], "existed": [], "conflicts": [], "warnings": []}
    graph_nodes = {n["id"]: n for n in g["nodes"]}
    id_of: dict[str, str] = {}
    nodes: list[dict] = []
    for label, t in tasks.items():
        if label not in graph_nodes:
            raise HTTPException(status_code=400, detail={
                "error": f"task '{label}' 不在 Flow 图中（tasklist 与 Flow 不一致）",
                "module": name})
        gn = graph_nodes[label]
        if gn["join"] not in ("AND", "OR"):
            raise HTTPException(status_code=400, detail={
                "error": f"节点 {label} 的 join {gn['join']!r} 超出草稿模型（AND/OR）",
                "module": name})
        ntype = t.get("type")
        if ntype not in _NODE_TYPES:
            raise HTTPException(status_code=400, detail={
                "error": f"节点 {label} 类型非法: {ntype!r}", "module": name})
        ref_field = _REF_FIELD[ntype]
        nid = _gen_id("n")
        id_of[label] = nid
        node: dict = {
            "id": nid, "label": label, "type": ntype, ref_field: t.get(ref_field),
            "is_start": bool(gn["is_start"]), "join": gn["join"],
            "position": {"x": 0, "y": 0},
            "inputs": dict(t.get("inputs") or {}),
        }
        if ntype == "submodule":
            if t.get("outputs"):
                node["outputs"] = dict(t["outputs"])
            src = store.resolve_module(t.get(ref_field), search=search)
            if src is None:
                report["warnings"].append(
                    f"submodule '{t.get(ref_field)}' 未安装——更新组装前需先安装或替换引用")
        else:
            overrides = {k: v for k, v in t.items() if k not in ("type", ref_field, "inputs")}
            if overrides:
                node["overrides"] = overrides
        nodes.append(node)
    edges = [
        {"id": _gen_id("e"), "from": id_of[e["from"]], "to": id_of[e["to"]],
         "guard": e.get("guard")}
        for e in g["edges"]
    ]
    draft: dict = {
        "meta": {"name": name, "version": manifest.get("version", "0.1.0"),
                 "description": manifest.get("description", "")},
        "spec_schema": [{"field": f, "type": t}
                        for f, t in (schema.get("input") or {}).items()],
        "default_spec": dict(default_spec or {}),
        "nodes": nodes,
        "edges": edges,
    }
    if schema.get("output"):
        draft["spec_schema_output"] = schema["output"]
    # 校验前置——草稿先过 _validate_draft（纯检查），再动组件库：失败零导入
    #（重试幂等，但不留困惑的半入库状态）
    _validate_draft(draft, name)
    for n in nodes:
        if n["type"] == "submodule":
            continue
        lib_kind = {"harness": "harnesses", "command": "commands", "script": "scripts"}[n["type"]]
        _import_pack_component(root, pack, lib_kind, n[_REF_FIELD[n["type"]]], report)
    for e in edges:
        if e.get("guard"):
            _import_pack_component(root, pack, "guards", e["guard"], report)
    _save_draft(name, json.dumps(draft, ensure_ascii=False).encode("utf-8"))
    return {"draft": name, "report": report}


# ── entry 模块转化（转 packed 后接入既有编辑闭环）─────────────────────


@router.post("/modules/{name}/convert")
def convert_entry_route(
    name: str,
    body: dict | None = None,
    search: list[Path] = Depends(get_search_paths),
) -> dict:
    """entry 模块 → packed：库 entry_to_pack 物化 → install_pack → entry 文件
    退位（重命名 .bak，可逆；失败回滚卸载）。

    body {template?}：多模板 entry 指定转化模板（缺省 default_template）。
    非 entry 形态 → 400；同名其他来源（退位后须唯一命中）→ 409；模板非法/
    提取失败 → 400（ValueError 消息透传）；store 同名已存在 → 409。
    """
    _check_name(name)
    try:
        resolved = store.resolve_module_full(name, search=search)
    except ValueError as e:
        # entry 加载失败（导入抛错）→ 400 而非 500（manage.py/update 同款防护）
        raise HTTPException(status_code=400, detail={"error": str(e), "module": name})
    if resolved is None:
        raise HTTPException(status_code=404, detail={
            "error": f"模块 '{name}' 未找到", "module": name})
    if resolved.kind != "entry":
        raise HTTPException(status_code=400, detail={
            "error": f"模块 '{name}' 为 {resolved.kind} 形态，仅 entry 可转化",
            "module": name})
    # 防遮蔽：退位后名字必须唯一命中转化产物——同名其他来源先拒
    others = [s for s in store.list_modules(search=search).get(name, [])
              if s.path != resolved.source.path]
    if others:
        raise HTTPException(status_code=409, detail={
            "error": f"模块 '{name}' 存在同名其他来源（"
                     f"{', '.join(s.kind for s in others)}）——转化退位后会被遮蔽，"
                     "先处理同名来源", "module": name})
    if resolved.entry is None:
        raise HTTPException(status_code=500, detail={
            "error": "entry 解析异常", "module": name})
    template = (body or {}).get("template")
    tmp = Path(tempfile.mkdtemp(prefix="specmodule_convert_"))
    try:
        result = entry_to_pack(resolved.entry, template_name=template, out_dir=tmp / "pack")
        store.install_pack(result.pack_dir, source="webview-entry-convert", name=name)
    except (ValueError, TypeError, KeyError) as e:
        status = 409 if "已存在" in str(e) else 400
        raise HTTPException(status_code=status, detail={"error": str(e), "module": name})
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    # 退位：entry 文件重命名 .bak（discover 只 glob *.py）——失败回滚卸载，
    # 不留「entry 退位但包没装上」的半状态
    entry_file = Path(resolved.source.path)
    try:
        entry_file.rename(entry_file.with_name(entry_file.name + ".bak"))
    except OSError as e:
        store.uninstall_pack(name)
        raise HTTPException(status_code=400, detail={
            "error": f"entry 文件退位失败（已回滚安装）: {e}", "module": name})
    detail = store.resolve_module_full(name, search=get_search_paths())
    if detail is None:
        raise HTTPException(status_code=500, detail={
            "error": "转化后详情读取失败", "module": name})
    return {"module": store.detail_to_dict(detail), "warnings": result.warnings}
