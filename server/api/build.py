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

from module_harness import store
from module_harness.cli.command import CommandConfig
from module_harness.cli.scaffold import validate_module_name
from module_harness.core.config import HarnessConfig
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
        manifest = {
            "name": meta["name"],
            "version": meta.get("version", "0.1.0"),
            "description": meta.get("description", ""),
            "submodule": False,
            "spec_schema": {"input": schema},
            "requires": [],
            "modules": sub_names,
            "tasklist": draft_to_tasklist(draft),
        }
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
