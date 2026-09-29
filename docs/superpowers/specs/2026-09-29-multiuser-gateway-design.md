# webview 多用户隔离：每用户进程 + 边缘网关（设计定稿）

> 2026-09-29 定稿。用户指令核心：**在分支上为 webview 准备简易用户与隔离系统，处理生产环境并发，用稳定现成库或工程实现**。
> 部署事实（澄清收敛）：公网阿里云单机、月级寿命、参赛演示、5-10 评委、并发不高、
> **无域名（IP:PORT 直连为默认形态，TLS 可选）**；评委各自动手体验（自发起 run + chat）；
> 默认演示模块人人可见可运行，自建数据（runs/会话/模块）按评委隔离；
> 认证零摩擦——**无密码、无账号发放**。

## 定位与范围

- **交付物**：边缘网关（`server/gateway/`，新增）+ 每用户一个原封不动的现有后端进程。
  现有 server 代码唯一改动是 `app.py` 加 3 行 `/healthz`；SPA 前端**零改动**。
- **隔离边界 = OS 进程**：runs、chat 会话、模块 store、进程注册表、文件锁全部随进程
  天然按用户切开，不依赖应用层锚定纪律（单进程多用户方案里一处漏锚即评委互串）。
- **明确不做**：自助注册 / 改密 / SPA 内管理 UI / 账号发放流程 / 空闲进程回收 /
  每用户 LLM key / 配额审计 / HTTPS 强制（部署文档给可选 nginx TLS 样例，默认直连）。

## 方案选型

**选定：每用户一个后端进程 + 边缘网关（JupyterHub 的 Hub + single-user server 形态）。**

- 隔离是结构性的而非纪律性的——这是对月级寿命参赛部署最值钱的性质；
- 现有热路径零改动（base_dir 纪律、内存注册表、chat 挂载原样），比赛前回归风险≈0；
- 构建器装包走每用户 `SPECMODULE_HOME` 自动落位，共享模块经 `SPECMODULE_PATH`
  叠加可见——全部踩在既有库机制上。

否决项（备查）：

| 方案 | 否决理由 |
|---|---|
| A 单进程多用户 + 请求级重锚 | treechat 子应用挂载时锚定（`mount_chat` 注释明示子应用无法逐请求重锚）需实质重构；`store.install_pack` 写 env 锚定的 `store_home()` 需上游参数化；隔离靠应用层纪律 |
| C 单进程 + 共享口令门 | 不满足「评委各自动手、数据隔离」硬需求 |
| IP 隔离 | 会场/办公室 NAT 后评委共享同一公网 IP → 全部合并进同一数据空间，恰好摧毁隔离目标；同一评委换设备又被拆成两人 |

## 总体架构

```
浏览器 SPA（原样）
   │  HTTP(S)
   ▼
边缘网关 server/gateway/（唯一新应用层，单进程）
   │  ① /claim           → 认领页（网关内联 HTML，无构建步骤）
   │  ② /（静态）         → 托管 web/dist（SPA 无 URL 路由，/ → index.html 即可）
   │  ③ /api/*  /treechat/* → 验 Cookie → httpx 反代到该用户后端（SSE 流式透传）
   │  ④ /api/runs/*/stream  → 验 Cookie → websockets 双向桥接 WS
   ▼  127.0.0.1:8101..（registry 分配）
每用户一个后端 = 现有 server.app:app，--workers 1，仅 env 不同：
   SPECMODULE_BASE=<root>/users/<dir>
   SPECMODULE_HOME=<root>/users/<dir>/.specmodule
   SPECMODULE_PATH=<user_store>/modules<os.pathsep><shared>/modules
```

- **路由按 Cookie 身份在网关服务端完成，URL 空间不变**——SPA 请求的仍是绝对
  `/api/...`，前端一行不改。未认领访问 API 返 401、访问页面重定向 `/claim`。
- CORS 面收窄：后端只绑 127.0.0.1 供网关访问；dev 直连 :5173 的 CORS 配置保留不动。

## 数据布局（部署根）

```
<deploy_root>/                          # 如 /opt/specmodule-webview
├── registry.json                       # 用户登记（网关动态生长，CLI list/remove）
├── secret_key                          # 网关签名密钥（部署时生成，gitignore）
├── shared/
│   ├── modules/                        # 共享演示模块（只读；部署者预装）
│   └── library/                        # 共享组件种子（建户时拷入用户 store library/；
│                                       #   对齐 store 语义——SPECMODULE_HOME=<root>/shared 安装时组件落 library/）
└── users/
    └── <dir>/                          # dir = sha256(规范化名)[:16]——中文名路径安全
        ├── backend.log                 # 该用户后端进程日志
        ├── .specmodule/
        │   ├── runs/                   # 该用户的 runs（隔离）
        │   ├── modules/                # 该用户 store（SPECMODULE_HOME）——自建模块落此（隔离）
        │   └── library/                # 该用户组件库（建户时从 shared/library 播种）
        └── .treechat/                  # 该用户会话（隔离）
```

- **模块可见序**（`store.search_paths` 既有语义，零改动）：
  `<base>/modules` → `$SPECMODULE_PATH`（用户 store modules 在前、共享 modules 在后）
  → `store_home()/modules`（用户 store，重复出现无害）。同名时用户自建遮蔽共享——
  正合「默认展示 + 自建隔离」。共享目录只读，评委不可写。
- **LLM key 共享自动生效**：`llm_bridge` 配置链回落 `Path.home()/.specmodule`
  （字面 home，不受 `SPECMODULE_HOME` 影响，已核验）——用户种子零配置。
- spawn 子进程 CLI 一致性：后端 env 三件套被子进程继承，server 模块视图 ≡ run 子进程视图
  （既有同进程边界纪律自动成立）。

## 认证：用户名认领（无密码 · 无发放 · 零管理）

```
首次访问 → 认领页「输入你的名字」（一个输入框；GATEWAY_PASSCODE 设了则多一个口令框）
         → 名字规范化 + 查重 → 未认领 → 建档 + 建目录 + 分配端口 + 懒启动后端
         → 签发 Cookie + localStorage 令牌 → 进入
已认领   → Cookie 或 localStorage 令牌匹配 → 直接进入（浏览器从此免登录）
同名异机 → 令牌不匹配 → 「该名字已被其他设备使用，请换一个名字」
```

| 项 | 决定 | 依据 |
|---|---|---|
| 登记 | `registry.json` 动态生长：`{规范化名: {display, token_sha256, port, dir, created_at}}`；端口 8101 起递增分配、登记时定死 | 无密码可存，令牌只存 SHA-256 |
| 令牌 | 每用户随机 token；Cookie（itsdangerous `TimestampSigner`，TTL 30d 覆盖赛期）+ localStorage 双落 | 撞名事故消除：认领绑定「名字 + 首台浏览器」 |
| Cookie 标志 | `HttpOnly + SameSite=Lax`；`Secure` 由 `GATEWAY_SECURE_COOKIES` 控制（默认关——纯 IP:PORT 无 TLS 下 Secure Cookie 永不回传） | |
| 名字规范化 | 小写化 + 首尾去空白 + 长度上限（2~32）；目录名取哈希，原名存 `display` | 评委输中文名也安全；规范化名做键避免 Unicode 撞目录 |
| 可选门禁 | env `GATEWAY_PASSCODE`：设了则认领页多一个**全站共享口令**字段（无用户维度），默认关闭 | 挡路人误入；与威胁模型匹配（无秘密可保，传输面只剩 run 内容） |
| Cookie Secure 开关 | env `GATEWAY_SECURE_COOKIES`（默认 `off`；nginx TLS 部署时显式设 `on`） | 确定性配置优于运行时探测 scheme |
| 管理 CLI | `python -m server.gateway.cli list` / `remove <名> [--purge]`（purge 才删数据目录——破坏性动作显式） | 不再发放/重置 |
| 认领竞态 | 同名首认领进程内 asyncio lock 串行化（网关单进程，够用） | |

## 进程生命周期（全部收在网关 `ensure_running`）

```
请求到达 → registry 无此用户 → 401 → 认领
       → 有 → Popen 活着？ → 活：直接反代
                          → 死/未启：spawn uvicorn（127.0.0.1:<port> --workers 1）
                                    → 轮询 GET /healthz 就绪（15s 超时 → 502 友好错误）→ 反代
```

- **spawn**：`sys.executable -m uvicorn server.app:app`，env = 网关 env + 用户三件套；
  后端日志落 `users/<dir>/backend.log`（追加）。
- **崩溃自愈**：反代前廉价检查 `poll()`，死了拉起再代理——评委 F5 一次（约 3s）无感恢复，
  无独立守护进程。
- **`/healthz`**：`server/app.py` 加 `GET /healthz → {"ok": true}`（现有代码唯一改动）。
- **关闭语义（诚实声明）**：网关退出 → 逐后端**进程组终止**（POSIX `start_new_session` +
  `killpg`；Windows `CREATE_NEW_PROCESS_GROUP` 分支），后端与其在跑的 run 子进程一起走；
  status 残留 `running` → 既有「停滞提示 → 强制恢复」语义兜底。全部产物落盘，重启不丢数据。

## 并发收口

| # | 项 | 处理 |
|---|---|---|
| 1 | 单写者注册表 vs 多 worker | 网关硬编码 `--workers 1` + 部署文档注明：每用户进程的注册表/锁语义依赖单进程（进程每用户方案的结构性收益） |
| 2 | 并发请求面 | 查询端点 sync def → FastAPI 线程池；WS 循环/SSE 异步——5-10 评委 × 数页签无压力，不加措施 |
| 3 | treechat 会话文件跨进程写（issue #16） | 本轮顺手修：treechat 存储层加 `filelock`（每会话锁文件，webapp 与 CLI 共用）——本仓库拥有 treechat，闭环真实挂账 issue |
| 4 | 认领竞态 | 进程内 asyncio lock 串行化（见上） |
| 5 | 反代超时 | connect 短超时；流式响应不设总超时（SSE/长连接）；WS 双向泵 + 关闭传播 |
| 6 | SQLite WAL / recent_runs | 每用户进程后无跨用户争用；人均 runs 规模小，无需措施 |
| 7 | 登录防爆破 | **删除**（无密码可爆破；可选口令不限流——月级寿命不值得） |

## 交付物

```
server/gateway/
├── __main__.py     # python -m server.gateway 启动网关（port/静态目录/部署根经 env/argv）
├── app.py          # 认领页 + 会话检查 + 静态托管 + 路由分发
├── proxy.py        # httpx 反代（SSE 流式透传）+ websockets WS 双向桥
├── identity.py     # 规范化/令牌/registry.json 读写/ensure_running
└── cli.py          # list / remove
server/app.py       # + /healthz（3 行）
treechat/           # 存储层 + filelock（关 issue #16）
deploy/README.md    # 启动步骤（建 shared、起网关）+ systemd 样例 + 可选 nginx TLS 样例
```

新依赖：`itsdangerous`、`httpx`（dev 组 → 正式依赖）、`filelock`；`websockets`
已随 `uvicorn[standard]` 在场（实施时核验，缺席则显式声明）。分支 `feat/multiuser-gateway`。

## 测试策略

- **identity**：tmp registry 全流程——认领 / 同名异机令牌拒绝 / 中文名规范化与哈希目录映射 /
  口令开关 / `remove`+`--purge`。
- **proxy**：路由与身份用 `httpx.MockTransport` 单测；端到端起真 uvicorn（线程 + 临时端口 +
  tmp env）小规模集成——覆盖 SSE 透传、后端死而后自愈、401/重定向。
- **WS 桥**：真后端线程 + websocket 客户端穿过网关，断言消息双向与关闭传播。
- **filelock**：双进程争用同一会话文件，断言串行化。
- 纪律照旧：`tmp_path` 隔离、不碰真实 `~/.specmodule`；测试后端进程必须显式回收
  （防测试垃圾进程残留）。

## 风险与诚实缺口

- **WS 桥是最精巧部件**（双向泵 + 关闭传播 + 半开连接）——用稳定库 + 集成测试兜底；
- 后端 spawn 假定与网关同 venv（部署形态成立，文档注明）；
- 进程组终止的平台差异以部署目标（Linux）为主实现，Windows 开发机降级为 `terminate()`；
- 网关单点：网关挂 = 全站挂（月级参赛部署可接受，systemd `Restart=always` 兜底）；
- 评委浏览器清 localStorage 且 Cookie 过期后无法找回旧空间（令牌只存哈希，无找回通道）
  ——文档注明「换名字重开即可」，月级场景可接受。
