# Repository Guidelines

## Project Overview

`SpecModule_webview` is the **visualization consumption channel** for the SpecModule LLM framework: an independent frontend SPA + FastAPI thin backend that visualizes and manages specmodule runs. The library lives in the sibling repo [SpecModule](https://github.com/MountLynx/SpecModule) (PyPI package `specmodule`). The library's own stdlib visualization switch (`module_harness/feed.py`, zero-dependency http.server) only provides the minimal "see it running" form; **all rich interaction lives here**.

**Thin layer, zero business logic.** The library's query functions map 1:1 to HTTP endpoints; `module_harness/query.py` was explicitly designed as the shared query layer for CLI/MCP/Web consumers. Import it, never reimplement. Anything that looks like logic belongs upstream in the library repo (see 统一 API 原则 below).

**Current state: planning complete, backend layer not yet implemented.** This repo currently contains `roadmap.md` (阶段 0 HTTP 后端层 design finalized: FastAPI thin layer, endpoint list, data contracts) + this file. Phase 0 implements the `server/` FastAPI layer; the SPA (`web/`) comes in later phases. Acceptance target: M1 + M2 modules fully wired — runtime visualization + output comparison.

## Architecture & Data Flow

```
browser SPA → HTTP / WS → FastAPI thin layer (server/) → specmodule library (module_harness) → tickflow engine (tickflow-py)
                                                                  │
                                                                  └→ <base_dir>/.specmodule/runs/<run_id>/run.sqlite + status.json
```

Library interfaces → endpoint mapping (all verified in `../SpecModule/module_harness/`):

| Endpoint | Library call | Shape |
|---|---|---|
| `GET /api/runs` | `store.list_modules` 无关；run 枚举：扫描 `runs/` 目录 + `query_run_status` 摘要 | `[{run_id, phase, tick, error, updated_at}]` |
| `GET /api/runs/{id}/status` | `query_run_status(module_id, base_dir=None) -> ModuleStatus \| None` | `{module_id, phase, status, tick, fireable, fired, outputs, node_states, error, updated_at}` |
| `GET /api/runs/{id}/timeline` | `build_timeline` + `timeline_to_dict`; filters `filter_failed/filter_tick/filter_node` | `{module_id, latest_tick, entries: [{tick, node, status, output, error}]}`; entry status `ok\|failed\|aborted` |
| `GET /api/runs/{id}/checkpoints` | `build_checkpoints` + `checkpoints_to_dict` | `{module_id, checkpoints: [{target, tick, kind, fired, label}]}`; `target` = direct resume arg (`"<tick>"` or `"manual:<label>"`) |
| `GET /api/runs/{id}/snapshot` | `load_snapshot_summary(module_id, *, tick=None, base_dir=None) -> dict \| None` | `{tick, status, fireable, fired, outputs}`（outputs = 各节点最新值） |
| `GET /api/runs/{id}/feed` | `query_run_status` + `build_timeline` + `build_checkpoints` 组合（镜像 feed.py 的 JSON 组合） | feed.py 兼容结构：`{run_id, status, timeline, checkpoints}` — v1 前端基准 |
| `POST /api/runs/{id}/checkpoints` | `create_checkpoint(module_id, label, *, tick=None, base_dir=None) -> dict` | `{label, tick, overwritten}`；label 自动补 `manual:` 前缀；无运行/无快照/tick 不存在 → `KeyError` 带可用清单 |
| `GET /api/modules` | `store.list_modules(search=None, include_pip=True) -> dict[str, list[ModuleSource]]` | `{name, kind: entry\|packed\|pip, version, description, path}` |
| `POST /api/graph/render` | `TasklistTranslator(registry, module_id).build(tasklist, spec)` → tickflow `Graph`；序列化适配在本层 | `{nodes: [{id, label, type, inputs}], edges: [{from, to}]}` (+ `run_id` 时叠加节点状态) |

**Run lifecycle.** `Module.run()` is a coroutine that completes when the run finishes — no timeout/cancel API; `max_ticks` (default 100) is the only run limit. `status.json` phase machine: `idle → translating → reviewing → building → ready → running → done | aborted | cancelled`. `status.json` is written atomically by the Module at every phase; `run.sqlite` gets a snapshot every tick (persist mode). The `feed.py` polling pattern (`GET /feed.json?run_id=` composing status+timeline+checkpoints) is the reference for both the compat endpoint and the WS stream design.

**Monitoring.** Progress rides runner hooks `hooks={"on_tick_start": cb(tick, fireable), "on_fire": cb(NodeState), …}` and `EventBus` typed events. Persistence is file-based and cross-process readable: `run.sqlite` (tables `snapshots`, `firings`, `checkpoints`, `module_inputs`; WAL) + `status.json`.

**Key constraints**
- `base_dir` defaults to `cwd` — a server process's cwd differs from the user's run root; pass `base_dir` explicitly and consistently (one runs root per server, via `SPECMODULE_BASE` env, default cwd).
- Failed runs write only `status.json` (no `run.sqlite`) — status/timeline endpoints must tolerate a run dir without sqlite (query layer returns `None` — map to 404, never raise).
- Single-writer per `run_id` (WAL) — serialize any cross-process operations touching the same run.
- `run_id`: Module default `mod_<8hex>`, SubModule `{name}_<6hex>`; consumers may supply their own (CLI `--run-id`). Webview treats `run_id` as opaque path segment.
- **Real-time without touching the library**: the WS stream polls `status.json` / `run.sqlite` tick changes on the server side (same data source as feed.py) — no library hooks, no push mechanism in the library.
- CORS: dev SPA runs on a Vite dev server; open the dev origin only. Prod: FastAPI serves the built static assets — same origin, no CORS needed.
- **不重复构建（统一 API 原则）**：同步完善 API 文档与 CLI 先行的目的就是统一 API——出现第二个消费端（本仓库/TUI/Web）时，共享逻辑收编进库（共享层函数/入口方法），消费端只留传输级薄映射；消费端代码里出现与 CLI 重复的接线/校验逻辑即为违规——要么本轮收编上游，要么记录偏差并排期收编。上游不是不可动，视情况而定：值得统一的改动直接改 sibling 库仓库（遵守其 AGENTS.md），api.md 补录、库仓库独立提交，发新版后同步依赖。**graph 序列化是本层唯一的新数据形状**——若 TUI 或其他消费端也需要相同图结构，收编进库共享层，而非在本层继续维护。
- **库 API 文档同步完善**：消费新的 specmodule API 时，同步补录 `../SpecModule/docs/references/api.md`（做到哪里写哪里，按消费增量生长）；文档变更在库仓库独立提交（`docs:` 前缀，遵循其 AGENTS.md），并在本仓库 roadmap.md 变更日志记录。

## Key Directories

- repo root — this repo:
  - `server/` — FastAPI thin layer: `app.py` (entry: CORS + router wiring), `deps.py` (base_dir resolution + run_id validation), `api/runs.py` (runtime read endpoints), `api/graph.py` (tasklist → graph render), `api/manage.py` (module/run enumeration + checkpoint writes), `ws.py` (tick stream push)
  - `web/` — frontend SPA (later phases)
  - `tests/` — pytest + httpx TestClient
  - `roadmap.md` — the plan: architecture, endpoint list, phase breakdown, acceptance criteria. Re-read before implementing.
- `../SpecModule/` — the consumed library (read-only for this repo):
  - `module_harness/` — `query.py` (timeline/checkpoint queries), `status.py` (`ModuleStatus`), `graph_builder.py` (`TasklistTranslator`), `translator.py`, `store.py` (module store), `module.py` (`Module` orchestrator), `feed.py` (reference JSON composition + polling pattern), `entry.py`, `cli.py` (18-subcommand `specmodule` CLI)
  - `docs/references/api.md` — 库面编程 API 参考（按消费增量生长，本仓库消费新 API 必须同步补录）；`cli-usage.md` — parameter semantics for every operation
  - `AGENTS.md` — sibling guidelines (architecture rules, gotchas); mirror its conventions
- Run artifacts (created at runtime): `<base_dir>/.specmodule/runs/<run_id>/`; module store: `$SPECMODULE_HOME` or `~/.specmodule/` (`modules/`, `manifests/`, `cache/`, `config.json`, `.env`, `rules.txt`).

## Development Commands

```bash
# install the library (the only runtime dependency)
pip install specmodule
# or editable against the sibling checkout
pip install -e "../SpecModule"

# install this repo's dev deps (fastapi + uvicorn + httpx)
pip install -e .[dev]   # or: pip install fastapi uvicorn httpx

# run tests
python -m pytest tests/ -q                  # this repo's suite
python -m pytest ../SpecModule/module_harness/tests/ -q -m "not smoke"   # library baseline (no LLM keys)
python -m pytest ../SpecModule/module_harness/tests/smoke/ -v -s         # real-LLM smoke (needs config.json + .env)

# run the backend (start from project root — imports resolve against the library)
uvicorn server.app:app --reload --port 8000
# with explicit run root (recommended — server cwd ≠ run root)
SPECMODULE_BASE=<运行根目录> uvicorn server.app:app --port 8000

# library CLI reference (semantics of the API surface)
python -m module_harness.cli run --module <name> --spec '{"...": "..."}' --mock
python -m module_harness.cli status --run-id <id>
python -m module_harness.cli review --run-id <id>
```

Python ≥3.10 (library dev'd on 3.13). No lint/format/type tooling in this ecosystem — don't introduce any.

## Code Conventions & Common Patterns

- **Thin mapping**: one endpoint = one library call + shape conversion. No validation beyond what the library raises, no caching, no parallel state — the library's run state is the single source of truth.
- `from __future__ import annotations` as first line; `@dataclass` models with `field(default_factory=...)`; typed public signatures; explicit `__all__` in `__init__.py`; Chinese docstrings (library convention).
- **Error handling** — mirror the library's split:
  - Queries **never raise**; missing/corrupt data → `None` → HTTP 404 with `{error: "无运行记录"}` and the run_id.
  - Operations raise typed exceptions (`KeyError` with available targets list from `create_checkpoint`, etc.) — map to 4xx with `str(e)` included.
  - Unknown run_id → 404; malformed query params → 422 (FastAPI validation).
- **Async**: WS handlers and any awaited library entry points (`Module.run`) are `async`; query endpoints are synchronous (query layer is sync).
- **base_dir**: resolved once per server (env `SPECMODULE_BASE`, default cwd), passed explicitly to every query call — never rely on implicit cwd.
- **feed.json compat**: the `/api/runs/{id}/feed` endpoint must keep the feed.py response shape (status/timeline/checkpoints field names) as the v1 frontend contract; richer endpoints extend it, they don't break it.
- **Mock pattern** for key-free tests: `mock_llm.complete = AsyncMock(return_value=LLMResponse(content='{"ok": true}', usage={}, finish_reason="end_turn"))` — only needed if tests exercise `Module.run`; endpoint tests use fixture run artifacts instead.
- Spec is a free-form dict; `--spec` inline > `--spec-file` > `entry.default_spec`. Two mutually exclusive channels: template (translator) or tasklist dict — `graph/render` accepts either, mirroring `entry.build_module`'s `template_name` XOR `tasklist` contract (`ValueError` otherwise).

## Important Files

- `roadmap.md` — the plan: architecture, endpoint list, data contracts, phase breakdown, change log. Re-read before implementing.
- `../SpecModule/module_harness/query.py` — the shared query layer to import (timeline/checkpoint dict shapes).
- `../SpecModule/module_harness/feed.py` — reference JSON composition + polling pattern for the compat endpoint and WS stream.
- `../SpecModule/module_harness/status.py` — `ModuleStatus` fields + phase machine.
- `../SpecModule/module_harness/graph_builder.py`, `translator.py` — graph render backend (tickflow `Graph` output; serialization adaptation lives in `server/api/graph.py`).
- `../SpecModule/module_harness/store.py` — `list_modules` for the management surface.
- `../SpecModule/docs/references/api.md` — 库面编程 API 参考（按消费增量生长，本仓库消费新 API 必须同步补录）；`cli-usage.md` — parameter semantics for every operation.
- `../SpecModule/AGENTS.md` — sibling guidelines (architecture rules, gotchas); mirror its conventions.

## Runtime/Tooling Preferences

- **Python ≥3.10**, pip + setuptools; package manager: pip only (no uv/poetry in ecosystem).
- Runtime deps: `specmodule` (pulls `tickflow-py` — imported as `tickflow`; import name ≠ package name) + `fastapi` + `uvicorn` (本项目依赖, per roadmap); test dep: `httpx`.
- No formatter/linter/type-checker configs anywhere in the ecosystem; keep it that way (stdlib + pytest only).
- API keys live in `.env` (gitignored); `config.json` never stores secrets. The webview backend itself needs no API keys (it only reads run artifacts) — keys matter only for tests that exercise real `Module.run`.
- Sibling consumer repos (`SpecModule_tui/`, `SpecModule_mcp/`) are the precedent for this repo's thin-consumer shape; `SpecModule_mcp/AGENTS.md` is the closest structural model for this file.

## Testing & QA

- **pytest** + `httpx` TestClient (FastAPI's ASGI test client). No pytest config, no coverage tooling, no thresholds — match the ecosystem.
- **Isolation pattern** (library convention, required): real run stores under `tmp_path` — `tmp_path/.specmodule/runs/<id>/run.sqlite` + `status.json`; construct a minimal fixture run by writing a `status.json` (phase-only) and/or a `run.sqlite` via `tickflow.persistence.SqliteBackend` (or reuse library test helpers). Never touch real `~/.specmodule`.
- Endpoint tests: build fixture run artifacts → hit endpoints via TestClient → assert response shapes match the mapping table above, including the error contract (None → 404).
- Feed compat: assert `/api/runs/{id}/feed` shape stays byte-compatible with `feed.py`'s `_serve_feed` output.
- Library baseline before merging anything: `python -m pytest ../SpecModule/module_harness/tests/ -q -m "not smoke"`.
- Acceptance (roadmap): M1 + M2 modules fully wired — runtime visualization + output comparison, verified end-to-end against real run artifacts.
