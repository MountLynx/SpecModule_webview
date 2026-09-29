# 部署（参赛：公网阿里云 · 月级寿命）

## 形态

```
评委浏览器 → IP:PORT（或 nginx TLS） → 边缘网关（本文件） → 每用户一个后端进程（127.0.0.1:8101+）
```

网关职责：认领页（输入名字即进入，无密码）+ 按用户反代（SSE/WS 透传）+ 静态 SPA 托管 +
后端进程懒启动/崩溃自愈。每用户后端 = 现有 `server.app:app` 原封不动，仅 env 三件套不同——
隔离随 OS 进程成立。设计定稿：`docs/superpowers/specs/2026-09-29-multiuser-gateway-design.md`。

## 步骤

```bash
# 0. 依赖（uv：itsdangerous / filelock / httpx 已入正式依赖）
uv sync
# 1. 前端构建
cd web && npm install && npm run build && cd ..
# 2. 准备共享演示模块（SPECMODULE_HOME 锚到 <root>/shared 安装，组件落 shared/library）
SPECMODULE_HOME=/opt/specmodule-webview/shared uv run python -m module_harness.cli install <pack>
#    （或直接把模块目录拷进 <root>/shared/modules）
# 3. 启动网关（systemd 常驻见下）
uv run python -m server.gateway --root /opt/specmodule-webview --static web/dist --port 8000
```

评委侧：浏览器开 `http://<服务器IP>:8000` → 输入名字 → 进入（此后该浏览器免登录）。
同名异机会被拒绝（令牌绑定首台浏览器），换名字重开即可。

## systemd 单元样例

```ini
[Unit]
Description=SpecModule Gateway
After=network.target

[Service]
WorkingDirectory=/opt/specmodule-webview
ExecStart=/opt/specmodule-webview/.venv/bin/python -m server.gateway --root /opt/specmodule-webview --static web/dist --port 8000
Restart=always
Environment=GATEWAY_SECURE_COOKIES=off
# 可选全站口令（认领页多一个口令框）：Environment=GATEWAY_PASSCODE=***

[Install]
WantedBy=multi-user.target
```

## 可选 nginx TLS（有域名/证书时）

```nginx
server {
    listen 443 ssl;
    server_name <域名>;
    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;      # WS
        proxy_set_header Connection "upgrade";
        proxy_buffering off;                          # SSE
        proxy_read_timeout 3600s;
    }
}
```
TLS 部署时 systemd 里加 `Environment=GATEWAY_SECURE_COOKIES=on`。

## 运维语义（诚实清单）

- **单 worker 约束**：每用户后端 `--workers 1` 由网关硬编码，勿改——进程内注册表/锁
  语义依赖单进程。
- **网关/后端重启**：在跑的 run 进程随组终止，status 残留 `running` → UI 停滞提示 →
  强制恢复；产物全落盘，重启不丢数据。systemd 正常重启会触发网关 shutdown 钩子
  （逐后端组终止）；**`kill -9` / 断电不跑钩子** → 后端孤儿存活并占住端口，此时
  `fuser -k 8101/*`（或按 `users/<dir>/backend.log` 里的 pid）清理孤儿后再起网关。
- **后端崩溃**：下次请求自动拉起（就绪探测 15s），评委 F5 一次即恢复。
- **用户管理**：`uv run python -m server.gateway.cli --root <root> list` /
  `remove <名> [--purge]`（无发放——登记由认领动态生长）；`--purge` 前先停网关，
  否则运行中的后端可能正写该目录。
- **令牌不可找回**：评委清 localStorage 且 Cookie 过期 → 该空间失联，换名字重开
  （月级场景可接受）。
- **内存**：每用户后端约 150-250MB，10 评委满载 ≈ 2.5GB；`users/<dir>/backend.log`
  持续追加（每次启动续写），月级赛期一般无需轮转，介意则部署 cron 截尾。
- **dev 不受影响**：本地开发仍走 `npm run dev`（vite :5173 → :8000 直连后端），
  网关只在部署时使用（`--static` 目录缺席时网关不挂静态）。
