# TreeChat 整合第一期（壳层重组）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有顶部三视图重组进 VSCode 式壳（活动栏 + 侧边栏 + 主区，侧栏导航范式），视觉基建立 TreeChat webui 的 Tailwind + shadcn neutral 主题。

**Architecture:** 纯前端重组——`server/`、`api.ts`、`ws.ts`、`dagre.ts` 零改动。App 壳持有 `activeTab/openModuleName/openRunId`，列表常驻侧边栏，主区内容随选择变化（模块详情+发起、RunView）。旧全宽 RunsView 压缩为侧栏 RunList；ModulesView 拆成 ModuleList（侧栏）+ ModuleDetail（主区，RunDialog 弹窗退役表单内嵌）；其余组件换皮（内联样式 → Tailwind class + CSS 变量）。

**Tech Stack:** React 18 + Vite 5 + TS（现状）+ Tailwind CSS 3.4 + tailwindcss-animate + clsx/tailwind-merge/class-variance-authority + lucide-react。**不引入 Radix**（二期随对话 UI 带入），**不引入 router**，**不加测试框架**（本仓库前端验收门 = `npm run build`，见 AGENTS.md）。

**规格:** `docs/superpowers/specs/2026-09-10-treechat-integration-phase1-shell-design.md`（实施前先读一遍）。

**通用纪律：**

- 每个任务结束跑 `cd web && npm run build`，必须绿再 commit。
- 本仓库 tsconfig 若开 `noUnusedLocals`：每次替换 import 后随手删掉不再使用的旧 import。
- 提交只 add 本任务涉及的文件（工作区可能有本任务之外的未提交改动，不要裹挟）。
- 颜色令牌映射表（Task 5/6 换皮时统一套用）：

| 旧字面量 | 新令牌 |
|---|---|
| `#b91c1c`（错误红） | `hsl(var(--destructive))` / className `text-destructive` |
| `#b45309` / `#92400e`（警示琥珀） | `var(--ph-truncated)` |
| `#16a34a`（成功绿） | `var(--ph-done)` |
| `#dc2626`（危险红/abort） | `var(--ph-aborted)` |
| `#2563eb`（running 蓝） | `var(--ph-running)` |
| `#d97706`（cancelled） | `var(--ph-cancelled)` |
| `#6b7280` / `#9ca3af`（灰字） | `hsl(var(--muted-foreground))` / className `text-muted-foreground` |
| `#e5e7eb` / `#f3f4f6`（边框/分隔） | `hsl(var(--border))` / className `border-border` |
| `#f9fafb` / `#f3f4f6`（浅底） | `hsl(var(--secondary))` / className `bg-secondary` |
| `#fff`（面板底） | `hsl(var(--card))` / className `bg-card` |
| `#111827` / `#374151`（正文字） | `hsl(var(--foreground))` / className `text-foreground` |

---

### Task 1: Tailwind 基建移植（依赖、配置、主题、cn、ui 基件）

**Files:**
- Modify: `web/package.json`（npm install 自动改）
- Create: `web/tailwind.config.js`
- Create: `web/postcss.config.js`
- Modify: `web/index.html`（head 加主题初始化脚本，防暗色闪烁）
- Modify: `web/src/index.css`（全量替换：主题变量 + tailwind directives）
- Create: `web/src/lib/utils.ts`
- Create: `web/src/components/ui/button.tsx`
- Create: `web/src/components/ui/input.tsx`

- [ ] **Step 1.1: 安装依赖（注意 pin Tailwind v3，v4 配置范式不同不能用）**

```bash
cd web
npm install clsx tailwind-merge class-variance-authority lucide-react
npm install -D tailwindcss@^3.4.17 postcss autoprefixer tailwindcss-animate
```

Expected: 安装成功无 peer 冲突。`node_modules/tailwindcss/package.json` 版本为 3.x。

- [ ] **Step 1.2: 创建 `web/tailwind.config.js`**

```js
/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: { DEFAULT: "hsl(var(--primary))", foreground: "hsl(var(--primary-foreground))" },
        secondary: { DEFAULT: "hsl(var(--secondary))", foreground: "hsl(var(--secondary-foreground))" },
        destructive: { DEFAULT: "hsl(var(--destructive))", foreground: "hsl(var(--destructive-foreground))" },
        muted: { DEFAULT: "hsl(var(--muted))", foreground: "hsl(var(--muted-foreground))" },
        accent: { DEFAULT: "hsl(var(--accent))", foreground: "hsl(var(--accent-foreground))" },
        card: { DEFAULT: "hsl(var(--card))", foreground: "hsl(var(--card-foreground))" },
        sidebar: { DEFAULT: "hsl(var(--sidebar))", selected: "hsl(var(--sidebar-selected))" },
        activitybar: { DEFAULT: "hsl(var(--activitybar))", foreground: "hsl(var(--activitybar-foreground))" },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        control: "calc(var(--radius) + 2px)",
        panel: "calc(var(--radius) + 8px)",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
```

- [ ] **Step 1.3: 创建 `web/postcss.config.js`**

```js
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

- [ ] **Step 1.4: 全量替换 `web/src/index.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

/* shadcn neutral 调色板（移植自 TreeChat webui：中性灰阶 + 暖调边框/侧栏）
   + 运行 phase 语义色（沿用旧 PHASE_COLOR 现值，供亮暗两态共用） */
@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 240 3% 12%;
    --card: 0 0% 100%;
    --card-foreground: 240 3% 12%;
    --primary: 240 4% 16%;
    --primary-foreground: 0 0% 98%;
    --secondary: 240 5% 96%;
    --secondary-foreground: 240 4% 16%;
    --muted: 0 0% 96.1%;
    --muted-foreground: 240 4% 46%;
    --accent: 240 5% 96%;
    --accent-foreground: 240 4% 16%;
    --destructive: 0 84.2% 60.2%;
    --destructive-foreground: 0 0% 98%;
    --border: 40 8% 90.5%;
    --input: 40 8% 90.5%;
    --ring: 240 4% 16%;
    --radius: 0.4375rem;
    --sidebar: 40 8% 96.8%;
    --sidebar-selected: 40 1% 89.4%;
    --activitybar: 40 6% 92%;
    --activitybar-foreground: 240 4% 30%;

    --ph-running: #2563eb;
    --ph-done: #16a34a;
    --ph-aborted: #dc2626;
    --ph-cancelled: #d97706;
    --ph-truncated: #b45309;
  }

  .dark {
    --background: 0 0% 19%;
    --foreground: 0 0% 93%;
    --card: 0 0% 22%;
    --card-foreground: 0 0% 93%;
    --primary: 240 5% 98%;
    --primary-foreground: 240 4% 16%;
    --secondary: 0 0% 26%;
    --secondary-foreground: 0 0% 93%;
    --muted: 0 0% 26%;
    --muted-foreground: 0 0% 63%;
    --accent: 0 0% 26%;
    --accent-foreground: 0 0% 93%;
    --destructive: 0 72% 51%;
    --destructive-foreground: 0 0% 98%;
    --border: 0 0% 28%;
    --input: 0 0% 28%;
    --ring: 0 0% 80%;
    --sidebar: 0 0% 17%;
    --sidebar-selected: 0 0% 29.8%;
    --activitybar: 0 0% 14%;
    --activitybar-foreground: 0 0% 70%;
  }

  * {
    @apply border-border;
  }

  html,
  body,
  #root {
    height: 100%;
  }

  body {
    @apply bg-background text-foreground;
    font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC",
      "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    overflow: hidden;
  }

  ::selection {
    background: hsl(var(--primary) / 0.15);
  }
}

/* 细滚动条（应用式布局） */
* {
  scrollbar-width: thin;
  scrollbar-color: hsl(var(--border)) transparent;
}
```

- [ ] **Step 1.5: `web/index.html` head 加主题初始化（跟随系统，localStorage `specmodule-webview.theme` 可覆盖；放任何 CSS 加载前防闪烁）**

在 `<head>` 内、`<title>` 之前插入：

```html
    <script>
      (function () {
        var t = localStorage.getItem("specmodule-webview.theme");
        if (t === "dark" || (!t && window.matchMedia("(prefers-color-scheme: dark)").matches)) {
          document.documentElement.classList.add("dark");
        }
      })();
    </script>
```

（本期不做 UI 切换按钮——与 TreeChat 行为一致，改 localStorage 即覆盖。）

- [ ] **Step 1.6: 创建 `web/src/lib/utils.ts`**

```ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 相对时间（unix 毫秒 → 「x 分钟前」；跨天回落日期） */
export function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 单行摘要（换行折叠 + 截断） */
export function oneLine(text: string, max = 40): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}
```

- [ ] **Step 1.7: 创建 `web/src/components/ui/button.tsx`（移植 TreeChat 版，原样）**

```tsx
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow hover:opacity-90",
        outline: "border border-input bg-transparent shadow-sm hover:bg-accent",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        destructive: "bg-destructive text-destructive-foreground shadow-sm hover:opacity-90",
      },
      size: {
        default: "h-8 px-3",
        sm: "h-7 rounded-control px-2 text-[13px]",
        icon: "h-7 w-7",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props} />
  ),
);
Button.displayName = "Button";

export { Button, buttonVariants };
```

- [ ] **Step 1.8: 创建 `web/src/components/ui/input.tsx`（移植 TreeChat 版，原样）**

```tsx
import * as React from "react";
import { cn } from "../../lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        "flex h-8 w-full rounded-control border border-input bg-transparent px-2.5 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "flex min-h-[64px] w-full rounded-control border border-input bg-transparent px-2.5 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";

export { Input, Textarea };
```

- [ ] **Step 1.9: 构建验证**

Run: `cd web && npm run build`
Expected: 绿（旧组件仍是内联样式，不受影响；新文件未被引用也能过 tsc）。若报 `tailwindcss-animate` 找不到，确认 Step 1.1 的 `-D` 安装命令执行完整。

- [ ] **Step 1.10: Commit**

```bash
git add web/package.json web/package-lock.json web/tailwind.config.js web/postcss.config.js web/index.html web/src/index.css web/src/lib/utils.ts web/src/components/ui/button.tsx web/src/components/ui/input.tsx
git commit -m "feat(web): Tailwind 基建移植（TreeChat shadcn neutral 主题 + cn + ui 基件 + 亮暗主题初始化）"
```

---

### Task 2: RunList 侧栏组件（旧全宽表格 → 紧凑列表）

**Files:**
- Create: `web/src/components/RunList.tsx`

（本任务只新增文件；App 仍用旧 RunsView，Task 4 切换。新文件不被引用不影响 tsc。）

- [ ] **Step 2.1: 创建 `web/src/components/RunList.tsx`（完整文件）**

```tsx
// 运行历史侧栏列表：紧凑行（phase 色点 + 模块名 + 相对时间 + run_id + tick/
// 错误摘要）+ 行内控制（暂停/继续/取消/恢复/删除）。语义与旧全宽 RunsView
// 一致：整行点击打开 run；删除终态确认、running 提示先取消 + force 二次确认。
import { useState } from "react";
import {
  TERMINAL_PHASES,
  deleteRun,
  type ControlAction,
  type RunSummary,
} from "../api";
import { cn, oneLine, relativeTime } from "../lib/utils";
import { Button } from "./ui/button";

/** phase → 色点类（语义色定义于 index.css :root） */
const PHASE_DOT: Record<string, string> = {
  running: "bg-[var(--ph-running)]",
  done: "bg-[var(--ph-done)]",
  aborted: "bg-[var(--ph-aborted)]",
  cancelled: "bg-[var(--ph-cancelled)]",
  truncated: "bg-[var(--ph-truncated)]",
  unknown: "bg-muted-foreground/60",
};

/** 非英文 phase 的展示标签（其余原样显示） */
const PHASE_LABEL: Record<string, string> = {
  truncated: "已截断",
  unknown: "未知",
};

/** 行内小控制钮统一规格 */
const ctlBtn = "h-5 rounded-[5px] px-1.5 text-[10.5px]";

interface RunListProps {
  runs: RunSummary[];
  current: string | null;
  onSelect: (id: string) => void;
  onControl: (id: string, action: ControlAction) => void;
  onResume: (id: string) => void;
  /** 删除成功回调（壳层刷新列表；删的是当前打开的 run 则清 runId） */
  onDeleted: (runId: string) => void;
}

export function RunList({
  runs,
  current,
  onSelect,
  onControl,
  onResume,
  onDeleted,
}: RunListProps) {
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const del = async (r: RunSummary) => {
    setErr(null);
    let force = false;
    if (r.phase === "running") {
      const ok = window.confirm(
        `运行 ${r.run_id} 进行中——建议先取消再删除。\n确定强制删除？（不会停止进程，进程可能继续写已被删的目录）`,
      );
      if (!ok) return;
      force = true;
    } else if (!window.confirm(`删除运行 ${r.run_id}？（整个 run 目录，不可恢复）`)) {
      return;
    }
    setBusyId(r.run_id);
    try {
      await deleteRun(r.run_id, force);
      onDeleted(r.run_id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-3.5 pb-2 pt-2.5 text-[12.5px] font-bold">
        运行历史
        <span className="font-normal text-muted-foreground">{runs.length} 条</span>
        {err && <span className="truncate font-normal text-[11.5px] text-destructive">{err}</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
        {runs.map((r) => {
          const terminal = TERMINAL_PHASES.has(r.phase);
          const moduleName = r.module ?? r.run_id;
          return (
            <div
              key={r.run_id}
              onClick={() => onSelect(r.run_id)}
              className={cn(
                "mb-px cursor-pointer rounded-[7px] px-2.5 py-[7px] hover:bg-accent",
                r.run_id === current && "bg-sidebar-selected",
              )}
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "h-2 w-2 shrink-0 rounded-full",
                    PHASE_DOT[r.phase] ?? "bg-muted-foreground/60",
                  )}
                />
                <span className="truncate text-[12.5px] font-semibold">{moduleName}</span>
                {r.module == null && (
                  <span className="shrink-0 text-[10px] font-normal text-muted-foreground">
                    （启发式）
                  </span>
                )}
                <span className="ml-auto shrink-0 text-[10.5px] text-muted-foreground">
                  {relativeTime(r.updated_at * 1000)}
                </span>
              </div>
              <div className="mt-0.5 truncate font-mono text-[10.5px] text-muted-foreground">
                {r.run_id}
              </div>
              <div className="mt-0.5 text-[10.5px] text-muted-foreground">
                {PHASE_LABEL[r.phase] ?? r.phase}
                {r.paused && <span className="text-[var(--ph-cancelled)]"> · 已暂停</span>}
                {r.tick != null ? ` · tick ${r.tick}` : ""}
                {!r.has_sqlite && " · 无 run.sqlite"}
              </div>
              {r.error && (
                <div className="mt-0.5 text-[10.5px] leading-snug text-destructive">
                  {oneLine(r.error, 80)}
                </div>
              )}
              <div className="mt-[5px] flex gap-1" onClick={(e) => e.stopPropagation()}>
                {r.phase === "running" && !r.paused && (
                  <Button variant="outline" size="sm" className={ctlBtn} title="暂停"
                    onClick={() => onControl(r.run_id, "pause")}>
                    ⏸ 暂停
                  </Button>
                )}
                {r.phase === "running" && r.paused && (
                  <Button variant="outline" size="sm" className={ctlBtn} title="继续"
                    onClick={() => onControl(r.run_id, "unpause")}>
                    ▶ 继续
                  </Button>
                )}
                {r.phase === "running" && (
                  <Button variant="outline" size="sm" className={cn(ctlBtn, "text-destructive")}
                    title="取消"
                    onClick={() => {
                      if (window.confirm(`取消运行 ${r.run_id}？`)) onControl(r.run_id, "cancel");
                    }}>
                    ✕ 取消
                  </Button>
                )}
                {terminal && (
                  <Button variant="outline" size="sm" className={ctlBtn} title="恢复/回退"
                    onClick={() => onResume(r.run_id)}>
                    ↻ 恢复
                  </Button>
                )}
                <Button variant="outline" size="sm"
                  className={cn(ctlBtn, "text-destructive")} title="删除该 run 目录"
                  disabled={busyId === r.run_id}
                  onClick={() => del(r)}>
                  删除
                </Button>
              </div>
            </div>
          );
        })}
        {!runs.length && (
          <div className="px-3 py-3 text-[11.5px] leading-relaxed text-muted-foreground">
            暂无运行记录——到「模块库」发起一个运行，或用 CLI 在运行根目录起 run。
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2.2: 构建验证**

Run: `cd web && npm run build`
Expected: 绿。

- [ ] **Step 2.3: Commit**

```bash
git add web/src/components/RunList.tsx
git commit -m "feat(web): RunList 侧栏紧凑运行列表（行内控制 + phase 色点 + 相对时间，语义承旧 RunsView）"
```

---

### Task 3: 模块库拆分——ModuleList（侧栏）+ ModuleDetail（主区，发起表单内嵌）

**Files:**
- Create: `web/src/components/ModuleList.tsx`
- Create: `web/src/components/ModuleDetail.tsx`

（同 Task 2：只新增，Task 4 切换引用后删旧文件。）

- [ ] **Step 3.1: 创建 `web/src/components/ModuleList.tsx`（完整文件）**

```tsx
// 模块库侧栏列表：store.list_modules 摘要（模块数据归本组件自取）+
// 「扫描来源」尾行。选中项由壳层持有（openModuleName），主区 ModuleDetail 联动。
import { useCallback, useEffect, useState } from "react";
import { fetchModules, type ModuleInfo } from "../api";
import { cn } from "../lib/utils";

/** kind 徽章底色（沿用旧 KIND_COLOR 现值） */
const KIND_BADGE: Record<string, string> = {
  entry: "bg-[#2563eb]",
  packed: "bg-[#7c3aed]",
  pip: "bg-[#0891b2]",
};

interface ModuleListProps {
  selected: string | null;
  onSelect: (name: string) => void;
}

export function ModuleList({ selected, onSelect }: ModuleListProps) {
  const [modules, setModules] = useState<ModuleInfo[]>([]);
  const [searchPaths, setSearchPaths] = useState<string[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const refresh = useCallback(() => {
    fetchModules()
      .then((d) => {
        setModules(d.modules);
        setSearchPaths(d.search_paths);
        setLoadErr(null);
      })
      .catch((e) => setLoadErr(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(refresh, [refresh]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-3.5 pb-2 pt-2.5 text-[12.5px] font-bold">
        模块库
        <span className="font-normal text-muted-foreground">{modules.length} 个</span>
        {loadErr && (
          <span className="truncate font-normal text-[11.5px] text-destructive">{loadErr}</span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
        {modules.map((m) => (
          <div
            key={`${m.kind}:${m.name}`}
            onClick={() => onSelect(m.name)}
            className={cn(
              "mb-px cursor-pointer rounded-[7px] px-2.5 py-[7px] hover:bg-accent",
              m.name === selected && "bg-sidebar-selected",
            )}
          >
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "shrink-0 rounded-full px-1.5 text-[9.5px] leading-4 text-white",
                  KIND_BADGE[m.kind] ?? "bg-muted-foreground",
                )}
              >
                {m.kind}
              </span>
              <span className="truncate text-[12.5px] font-semibold">{m.name}</span>
              {m.version && (
                <span className="ml-auto shrink-0 text-[10.5px] text-muted-foreground">
                  v{m.version}
                </span>
              )}
            </div>
            {m.description && (
              <div className="mt-0.5 truncate text-[10.5px] text-muted-foreground">
                {m.description}
              </div>
            )}
          </div>
        ))}
        {!modules.length && !loadErr && (
          <div className="px-3 py-3 text-[11.5px] text-muted-foreground">未发现模块</div>
        )}
      </div>
      {/* 扫描来源：排查「为什么看不到我的模块」 */}
      <div className="border-t px-3.5 py-2 text-[10.5px] leading-relaxed text-muted-foreground">
        <div className="mb-1 font-semibold">扫描来源（优先序）</div>
        {searchPaths.length ? (
          searchPaths.map((p) => (
            <div key={p} className="break-all font-mono">
              {p}
            </div>
          ))
        ) : (
          <div>（无——base_dir/modules、$SPECMODULE_PATH、store/modules 均不存在）</div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3.2: 创建 `web/src/components/ModuleDetail.tsx`（完整文件）**

原 RunDialog 的表单逻辑（模板选择/SpecForm/run_id/max_ticks/mock/提交守卫）内嵌为主区面板；detail 按 name 自取；注意所有 hooks 必须在早退 return 之前。

```tsx
// 模块详情主区面板：detail_to_dict 全量 + 发起运行表单（原 RunDialog 逻辑内嵌，
// 弹窗退役）。按 name 自取详情；发起成功经 onLaunched 上抛壳层（切运行页签开 run）。
import { useEffect, useState } from "react";
import {
  fetchModuleDetail,
  postLaunch,
  type LaunchResult,
  type ModuleDetail as ModuleDetailData,
} from "../api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { SpecForm } from "./SpecForm";

/** 与 server 缺省生成一致的 6 位 hex（前端预填，可改）。 */
function randHex6(): string {
  const b = new Uint8Array(3);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

const KIND_BADGE: Record<string, string> = {
  entry: "bg-[#2563eb]",
  packed: "bg-[#7c3aed]",
  pip: "bg-[#0891b2]",
};

interface ModuleDetailProps {
  name: string;
  /** 启动成功（202）回调：壳层切「运行历史」页签并打开新 run */
  onLaunched: (result: LaunchResult) => void;
}

export function ModuleDetail({ name, onLaunched }: ModuleDetailProps) {
  const [detail, setDetail] = useState<ModuleDetailData | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  // ── 发起表单状态（与原 RunDialog 相同）──
  const [template, setTemplate] = useState<string>("");
  const [runId, setRunId] = useState<string>("");
  const [maxTicks, setMaxTicks] = useState(100);
  const [mock, setMock] = useState(false);
  // SpecForm 上报：spec = 当前有效对象（null = JSON 非法）；touched = 动过字段
  const [spec, setSpec] = useState<Record<string, unknown> | null>({});
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setDetailErr(null);
    setErr(null);
    setBusy(false);
    fetchModuleDetail(name)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        setTemplate(d.default_template ?? d.templates[0] ?? "");
        setRunId(`${d.name}_${randHex6()}`);
        setSpec(d.default_spec ? { ...d.default_spec } : {});
        setTouched(false);
      })
      .catch((e) => {
        if (!cancelled) setDetailErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [name]);

  if (detailErr) {
    return <div className="p-4 text-[12.5px] text-destructive">{detailErr}</div>;
  }
  if (!detail) {
    return <div className="p-4 text-[12.5px] text-muted-foreground">加载中…</div>;
  }

  const specEmpty = spec == null || Object.keys(spec).length === 0;
  const submitDisabled =
    busy ||
    spec == null || // JSON 非法（无效 spec 无从提交）
    (specEmpty && detail.default_spec == null); // 空且无缺省 → CLI 也无米下锅
  const hint =
    spec == null
      ? "spec JSON 非法——修正后才能启动"
      : specEmpty && detail.default_spec == null
        ? "spec 为空且模块无 default_spec——请至少填写一个字段"
        : null;

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await postLaunch({
        module: detail.name,
        // 未动过字段 → 不传 spec（CLI 回落 entry.default_spec，语义最准）
        spec: touched ? spec : null,
        template: template || null,
        run_id: runId.trim() || null,
        max_ticks: maxTicks,
        mock,
      });
      onLaunched(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5">
      <div className="max-w-[760px] text-[13px]">
        <div className="flex items-center gap-2">
          <span className="text-[16px] font-bold">{detail.name}</span>
          <span
            className={`rounded-full px-1.5 text-[9.5px] leading-4 text-white ${KIND_BADGE[detail.kind] ?? "bg-muted-foreground"}`}
          >
            {detail.kind}
          </span>
          {detail.version && (
            <span className="text-[12px] text-muted-foreground">v{detail.version}</span>
          )}
        </div>
        {detail.description && (
          <div className="mt-1.5 text-muted-foreground">{detail.description}</div>
        )}
        <div className="mt-2 break-all font-mono text-[11.5px] text-muted-foreground">
          {detail.path}
        </div>

        {detail.submodules.length > 0 && (
          <div className="mt-4">
            <div className="text-[12.5px] font-semibold">子模块</div>
            <div className="mt-1">{detail.submodules.join("、")}</div>
          </div>
        )}

        <div className="mt-4">
          <div className="text-[12.5px] font-semibold">模板</div>
          {detail.templates.length ? (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {detail.templates.map((t) => (
                <span
                  key={t}
                  className={
                    "rounded-md border px-2 py-0.5 text-[11px] " +
                    (t === detail.default_template
                      ? "border-transparent bg-primary text-primary-foreground"
                      : "border-border bg-card")
                  }
                  title={t === detail.default_template ? "默认模板" : undefined}
                >
                  {t}
                  {t === detail.default_template ? "（默认）" : ""}
                </span>
              ))}
            </div>
          ) : (
            <div className="mt-1 text-muted-foreground">（无模板——模块自带流程定义）</div>
          )}
        </div>

        {detail.spec_schema && (
          <div className="mt-4">
            <div className="text-[12.5px] font-semibold">spec 字段</div>
            <table className="mt-1.5 border-collapse text-[12px]">
              <tbody>
                {Object.entries(detail.spec_schema).map(([k, t]) => (
                  <tr key={k}>
                    <td className="border border-border px-2.5 py-0.5 font-mono">{k}</td>
                    <td className="border border-border px-2.5 py-0.5 text-muted-foreground">
                      {t}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-4">
          <div className="text-[12.5px] font-semibold">default_spec</div>
          <pre className="mt-1.5 overflow-x-auto rounded-md border bg-secondary p-2 font-mono text-[11.5px] leading-relaxed">
            {detail.default_spec != null
              ? JSON.stringify(detail.default_spec, null, 2)
              : "（无——运行时留空 spec 将使用模板缺省）"}
          </pre>
        </div>

        {/* ── 发起运行（原 RunDialog 表单）── */}
        <div className="mt-5 border-t pt-4">
          <div className="text-[12.5px] font-bold">发起运行</div>
          {detail.templates.length > 1 && (
            <div className="mt-3">
              <div className="mb-1 text-[12px] font-semibold">模板</div>
              <select
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
                className="w-full max-w-[320px] rounded-control border border-input bg-transparent px-2 py-1 text-[13px]"
              >
                {detail.templates.map((t) => (
                  <option key={t} value={t}>
                    {t}
                    {t === detail.default_template ? "（默认）" : ""}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="mt-3">
            <SpecForm
              key={detail.name}
              schema={detail.spec_schema}
              defaultSpec={detail.default_spec}
              onChange={(s, t) => {
                setSpec(s);
                setTouched(t);
              }}
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-1.5 text-[12.5px]">
              run id
              <Input value={runId} onChange={(e) => setRunId(e.target.value)} className="w-[200px]" />
            </label>
            <label className="flex items-center gap-1.5 text-[12.5px]">
              max ticks
              <Input
                type="number"
                value={maxTicks}
                min={1}
                onChange={(e) => setMaxTicks(Number(e.target.value) || 100)}
                className="w-[70px]"
              />
            </label>
            <label className="flex items-center gap-1.5 text-[12.5px]">
              <input
                type="checkbox"
                checked={mock}
                onChange={(e) => setMock(e.target.checked)}
              />
              --mock（免 key 冒烟）
            </label>
          </div>
          {hint && <div className="mt-2 text-[12px] text-[var(--ph-truncated)]">{hint}</div>}
          {err && <div className="mt-2 text-[12.5px] text-destructive">{err}</div>}
          <div className="mt-4 flex items-center gap-3">
            <Button onClick={submit} disabled={submitDisabled}>
              {busy ? "启动中…" : "▶ 发起运行"}
            </Button>
            <span className="text-[11px] text-muted-foreground">
              202 后自动切到「运行历史」打开新 run
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3.3: 构建验证**

Run: `cd web && npm run build`
Expected: 绿。

- [ ] **Step 3.4: Commit**

```bash
git add web/src/components/ModuleList.tsx web/src/components/ModuleDetail.tsx
git commit -m "feat(web): 模块库拆分 ModuleList/ModuleDetail——发起表单内嵌主区，为侧栏导航壳做准备"
```

---

### Task 4: ActivityBar + App 壳重写（切换引用，删旧文件）

**Files:**
- Create: `web/src/components/ActivityBar.tsx`
- Modify: `web/src/App.tsx`（全量重写）
- Delete: `web/src/components/RunsView.tsx`
- Delete: `web/src/components/ModulesView.tsx`
- Delete: `web/src/components/RunDialog.tsx`

- [ ] **Step 4.1: 创建 `web/src/components/ActivityBar.tsx`（完整文件）**

```tsx
// 最左活动栏（VSCode 式，结构移植自 TreeChat webui）：图标 = 侧边栏页签；
// 底部设置占位。二期对话功能（对话/对话树/卡片）在此之上追加图标。
import type { ComponentType } from "react";
import { Boxes, List, Settings } from "lucide-react";
import { cn } from "../lib/utils";

export type Tab = "modules" | "runs";

const TABS: { key: Tab; label: string; icon: ComponentType<{ className?: string }> }[] = [
  { key: "modules", label: "模块库", icon: Boxes },
  { key: "runs", label: "运行历史", icon: List },
];

interface Props {
  tab: Tab;
  onTab: (t: Tab) => void;
}

export function ActivityBar({ tab, onTab }: Props) {
  const item = (key: Tab, label: string, Icon: ComponentType<{ className?: string }>) => (
    <button
      key={key}
      title={label}
      onClick={() => onTab(key)}
      className={cn(
        "relative flex h-12 w-full items-center justify-center transition-colors",
        tab === key ? "text-foreground" : "text-activitybar-foreground hover:text-foreground",
      )}
    >
      {tab === key && (
        <span className="absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-full bg-foreground" />
      )}
      <Icon className="h-5 w-5" />
    </button>
  );

  return (
    <nav className="flex h-full w-12 shrink-0 flex-col items-center bg-activitybar text-activitybar-foreground">
      <div className="flex w-full flex-col">{TABS.map((t) => item(t.key, t.label, t.icon))}</div>
      <div className="flex-1" />
      <button
        title="设置（占位）"
        disabled
        className="flex h-12 w-full cursor-default items-center justify-center text-activitybar-foreground/50"
      >
        <Settings className="h-5 w-5" />
      </button>
    </nav>
  );
}
```

- [ ] **Step 4.2: 全量重写 `web/src/App.tsx`**

```tsx
// App 壳层：VSCode 式三段布局（活动栏 + 侧边栏 + 主区）——侧栏导航范式：
// 列表常驻侧边栏，主区内容随选择变化（模块详情/发起、运行图），不再互斥切换。
// 壳层持有跨视图状态：当前页签、打开的模块/run、runs 轮询、恢复对话框请求。
// 不引 router（useState 范式，与 TreeChat webui 一致）。
import { useCallback, useEffect, useState } from "react";
import {
  fetchRuns,
  postControl,
  type ControlAction,
  type LaunchResult,
  type RunSummary,
} from "./api";
import { ActivityBar, type Tab } from "./components/ActivityBar";
import { ModuleDetail } from "./components/ModuleDetail";
import { ModuleList } from "./components/ModuleList";
import { RunList } from "./components/RunList";
import { RunView, type ResumeRequestMsg } from "./components/RunView";

/** 主区空态（两页签同构落点） */
function EmptyState({ icon, title, hint }: { icon: string; title: string; hint: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 text-muted-foreground">
      <div className="text-[34px]">{icon}</div>
      <div className="text-[13.5px]">{title}</div>
      <div className="text-[11.5px] opacity-70">{hint}</div>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState<Tab>("runs");
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [openModuleName, setOpenModuleName] = useState<string | null>(null);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  // 打开恢复对话框的请求：带目标 runId（避免全局计数器泄漏到无关 run 的切换）+ seq 去重
  const [resumeRequest, setResumeRequest] = useState<ResumeRequestMsg | null>(null);

  const refreshRuns = useCallback(() => {
    fetchRuns()
      .then(setRuns)
      .catch(() => {});
  }, []);
  useEffect(() => {
    refreshRuns();
    const t = setInterval(refreshRuns, 5000);
    return () => clearInterval(t);
  }, [refreshRuns]);

  // 打开 run：主区换内容（侧栏列表常驻，不再切走）
  const openRun = useCallback((id: string) => {
    setOpenRunId(id);
  }, []);

  // RunList 行内 ↻：打开目标 run 并请求恢复对话框（RunControls 按 runId + seq 守卫）
  const handleListResume = useCallback((rid: string) => {
    setTab("runs");
    setOpenRunId(rid);
    setResumeRequest({ runId: rid, seq: Date.now() });
  }, []);

  // 恢复请求已被 RunControls 消费（防 run 切换重挂载后陈旧请求重放误开对话框）
  const consumeResumeRequest = useCallback(() => setResumeRequest(null), []);

  // RunList 行内控制：失败静默——列表 5s 轮询刷新后状态即真相
  const handleListControl = useCallback(
    async (rid: string, action: ControlAction) => {
      try {
        await postControl(rid, action);
      } catch {
        // 行内静默：刷新后状态即真相
      }
      refreshRuns();
    },
    [refreshRuns],
  );

  // 删除成功：刷新列表；删的是当前打开的 run 则清空主区回空态
  const handleDeleted = useCallback(
    (deletedId: string) => {
      refreshRuns();
      setOpenRunId((cur) => (cur === deletedId ? null : cur));
    },
    [refreshRuns],
  );

  // 模块库发起运行成功（202）：切「运行历史」页签并打开新 run
  const handleLaunched = useCallback(
    (r: LaunchResult) => {
      refreshRuns();
      setTab("runs");
      setOpenRunId(r.run_id);
    },
    [refreshRuns],
  );

  return (
    <div className="flex h-full w-full overflow-hidden">
      <ActivityBar tab={tab} onTab={setTab} />

      {/* 侧边栏（页签内容） */}
      <aside className="flex h-full w-[280px] shrink-0 flex-col border-r bg-sidebar">
        {tab === "modules" ? (
          <ModuleList selected={openModuleName} onSelect={setOpenModuleName} />
        ) : (
          <RunList
            runs={runs}
            current={openRunId}
            onSelect={openRun}
            onControl={handleListControl}
            onResume={handleListResume}
            onDeleted={handleDeleted}
          />
        )}
      </aside>

      {/* 主区（内容随选择变化） */}
      <main className="flex h-full min-w-0 flex-1 flex-col bg-background">
        {tab === "modules" ? (
          openModuleName ? (
            <ModuleDetail key={openModuleName} name={openModuleName} onLaunched={handleLaunched} />
          ) : (
            <EmptyState icon="📦" title="未选择模块" hint="从左侧模块库选择，查看详情并发起运行" />
          )
        ) : openRunId ? (
          <RunView
            key={openRunId}
            runId={openRunId}
            resumeRequest={resumeRequest}
            onResumeRequestConsumed={consumeResumeRequest}
            onRequestResume={(rid) => setResumeRequest({ runId: rid, seq: Date.now() })}
            onRefreshRuns={refreshRuns}
          />
        ) : (
          <EmptyState
            icon="🧭"
            title="未打开任何 run"
            hint="从左侧运行历史选择，或到「模块库」发起一个运行"
          />
        )}
      </main>
    </div>
  );
}
```

注意 `key={openRunId}` / `key={openModuleName}`：切换目标即重挂载，组件内部按 runId 清派生状态的 effect 继续保留（双保险，行为不变）。

- [ ] **Step 4.3: 删除旧文件**

```bash
git rm web/src/components/RunsView.tsx web/src/components/ModulesView.tsx web/src/components/RunDialog.tsx
```

（先 `grep -rn "RunsView\|ModulesView\|RunDialog" web/src --include=*.tsx --include=*.ts` 确认除 App.tsx 外无其他引用；App.tsx 已重写。）

- [ ] **Step 4.4: 构建验证**

Run: `cd web && npm run build`
Expected: 绿。

- [ ] **Step 4.5: 手动冒烟（`cd web && npm run dev` + `uvicorn server.app:app --port 8000`，或已有 dev 环境）**

- 活动栏两图标可切换页签；侧栏列表常驻
- 点 run 行 → 主区出图；再点另一 run → 主区切换，侧栏滚动位置与高亮正确
- 删除当前打开的 run → 主区回空态
- 模块页签选模块 → 主区详情 + 发起表单；发起成功 → 自动切「运行历史」并打开新 run
- 暗色系统偏好下界面为暗色（或 devtools 执行 `localStorage.setItem("specmodule-webview.theme","dark"); location.reload()` 验证）

- [ ] **Step 4.6: Commit**

```bash
git add web/src/App.tsx web/src/components/ActivityBar.tsx
git commit -m "feat(web): VSCode 式壳层重组——活动栏+侧栏导航+主区，列表常驻随选随切（侧栏导航范式）"
```

（`git rm` 的删除已暂存，与上一条 commit 合并提交；若分commit，删除单独 `git commit -m "refactor(web): 移除旧顶部三视图组件"`。）

---

### Task 5: 对话框/控制条/表单换皮（dialogTheme + lib/json，dialogStyles 退役）

**Files:**
- Create: `web/src/components/dialogTheme.ts`
- Create: `web/src/lib/json.ts`
- Modify: `web/src/components/RunControls.tsx`（全量重写）
- Modify: `web/src/components/ResumeDialog.tsx`（定点替换）
- Modify: `web/src/components/CheckpointDialog.tsx`（定点替换）
- Modify: `web/src/components/SpecForm.tsx`（颜色令牌替换）
- Delete: `web/src/components/dialogStyles.ts`

- [ ] **Step 5.1: 创建 `web/src/lib/json.ts`（jsonFieldError 从 dialogStyles 迁来，逻辑原样）**

```ts
/** textarea 即时 JSON 校验：返回错误文案或 null（合法/空）。 */
export function jsonFieldError(text: string, mustBeObject: boolean): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (mustBeObject && (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))) {
      return "必须是 JSON 对象";
    }
    return null;
  } catch {
    return "不是合法 JSON";
  }
}
```

- [ ] **Step 5.2: 创建 `web/src/components/dialogTheme.ts`（旧 dialogStyles 的 class 化继任者）**

```ts
// 对话框共享 Tailwind 类（旧 dialogStyles.ts 内联样式的继任者）。
// overlay/panel 对应旧 overlayStyle/dialogStyle；label 对应 fieldLabel。
export const overlayCls =
  "fixed inset-0 z-[1000] flex items-center justify-center bg-black/45";
export const panelCls =
  "flex max-h-[86vh] w-[520px] max-w-[92vw] flex-col gap-2.5 overflow-auto rounded-lg bg-card p-4 text-[13px] text-card-foreground shadow-xl";
/** 窄面板变体（CheckpointDialog 用） */
export const panelNarrowCls = "w-[420px]";
export const labelCls = "text-[12.5px] font-semibold";
/** 全宽基础输入（select/旧 input 共用；ui/input 的 Input 组件之外的场合） */
export const fieldCls =
  "w-full rounded-control border border-input bg-transparent px-2.5 py-1 text-[13px]";
export const errTextCls = "text-[12px] text-destructive";
export const warnTextCls = "text-[12px] text-[var(--ph-truncated)]";
export const okTextCls = "text-[12px] text-[var(--ph-done)]";
/** textarea 非法 JSON 描红（对应旧 badTextarea） */
export const badOutlineCls = "outline outline-2 outline-destructive";
```

- [ ] **Step 5.3: 全量重写 `web/src/components/RunControls.tsx`（按钮 → ui/button，逻辑原样）**

```tsx
// 头部控制条：phase 感知的运行控制（暂停/继续/取消/终止恢复进程）+ 存检查点 +
// 终态恢复/回退入口。控制逻辑（含 resumeRequest runId+seq 守卫）不变，仅换皮。
import { useCallback, useEffect, useRef, useState } from "react";
import { postControl, TERMINAL_PHASES, type ControlAction } from "../api";
import { Button } from "./ui/button";
import { ResumeDialog } from "./ResumeDialog";
import { CheckpointDialog } from "./CheckpointDialog";

interface RunControlsProps {
  runId: string;
  phase: string | null;
  paused: boolean;
  /** 模块选择器当前值（缺省启发式 = runId），恢复对话框的模块名预填 */
  moduleHint: string | null;
  /** 动作成功后的回调（App 据此刷新 run 列表等） */
  onAction: () => void;
  /** 打开恢复对话框的请求（黄条/行内按钮发起；带目标 runId + seq） */
  resumeRequest: { runId: string; seq: number } | null;
  /** 恢复请求已消费（App 据此清空，防重挂载重放） */
  onResumeRequestConsumed?: () => void;
  /** 本 server 拉起的恢复子进程在跑（/process 轮询） */
  procRunning: boolean;
  onTerminate: () => void;
}

export function RunControls({
  runId,
  phase,
  paused,
  moduleHint,
  onAction,
  resumeRequest,
  onResumeRequestConsumed,
  procRunning,
  onTerminate,
}: RunControlsProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [cpOpen, setCpOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const act = useCallback(
    async (action: ControlAction) => {
      setBusy(true);
      setErr(null);
      try {
        await postControl(runId, action);
        onAction();
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [runId, onAction],
  );

  const running = phase === "running";
  const resumable = phase != null && (TERMINAL_PHASES.has(phase) || running);

  // 外部请求打开恢复对话框（ref 记上次已响应的 seq——只响应当前 run 的新请求）
  const lastSeqRef = useRef<number | null>(null);
  useEffect(() => {
    if (
      resumeRequest &&
      resumeRequest.runId === runId &&
      resumeRequest.seq !== lastSeqRef.current
    ) {
      lastSeqRef.current = resumeRequest.seq;
      setDialogOpen(true);
      onResumeRequestConsumed?.();
    }
  }, [resumeRequest, runId, onResumeRequestConsumed]);

  return (
    <div className="ml-auto flex items-center gap-2">
      {paused && (
        <span className="text-[12.5px] font-semibold text-[var(--ph-cancelled)]">⏸ 已暂停</span>
      )}
      {running && !paused && (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => act("pause")}>
          暂停
        </Button>
      )}
      {running && paused && (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => act("unpause")}>
          继续
        </Button>
      )}
      {running && (
        <Button
          variant="outline"
          size="sm"
          className="text-destructive"
          disabled={busy}
          onClick={() => {
            if (window.confirm("取消该运行？（已落盘，可稍后恢复/回退）")) act("cancel");
          }}
        >
          取消
        </Button>
      )}
      <Button variant="outline" size="sm" disabled={busy} onClick={() => setCpOpen(true)}>
        存检查点…
      </Button>
      {procRunning && (
        <Button
          variant="outline"
          size="sm"
          className="text-destructive"
          disabled={busy}
          onClick={() => {
            if (window.confirm("硬终止恢复子进程？（不写终态，status 停留 running；之后可强制恢复）")) {
              onTerminate();
            }
          }}
        >
          终止进程
        </Button>
      )}
      {resumable && (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => setDialogOpen(true)}>
          恢复 / 回退…
        </Button>
      )}
      {err && <span className="text-[12px] text-destructive">{err}</span>}
      {dialogOpen && (
        <ResumeDialog
          runId={runId}
          moduleHint={moduleHint}
          phaseRunning={running}
          onClose={() => setDialogOpen(false)}
          onStarted={() => {
            setDialogOpen(false);
            onAction();
          }}
        />
      )}
      {cpOpen && (
        <CheckpointDialog
          runId={runId}
          onClose={() => setCpOpen(false)}
          onCreated={onAction}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 5.4: `web/src/components/CheckpointDialog.tsx` 定点替换**

1) import 区：
   - 删 `import { btnStyle, dialogStyle, fieldLabel, overlayStyle } from "./dialogStyles";`
   - 增 `import { cn } from "../lib/utils";`、`import { Button } from "./ui/button";`、`import { labelCls, overlayCls, panelCls, panelNarrowCls } from "./dialogTheme";`
2) JSX 替换（逐处）：
   - `<div style={overlayStyle} onClick={onClose}>` → `<div className={overlayCls} onClick={onClose}>`
   - `<div style={{ ...dialogStyle, width: 420 }} onClick={(e) => e.stopPropagation()}>` → `<div className={cn(panelCls, panelNarrowCls)} onClick={(e) => e.stopPropagation()}>`
   - 标题 `<div style={{ fontWeight: 700, fontSize: 14 }}>` → `<div className="text-[13.5px] font-bold">`（两处：标题行与 done 分支无标题样式的不动）
   - `style={fieldLabel}` → `className={labelCls}`（label/tick 两处）
   - 两个 `<input ... style={{ width: "100%", boxSizing: "border-box" }} ...>` → 删 style、加 `className="w-full"`
   - 错误行 `{err && <div style={{ color: "#b91c1c" }}>{err}</div>}` → `{err && <div className="text-[12.5px] text-destructive">{err}</div>}`
   - 底部按钮组 `<div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>` → `<div className="mt-1 flex justify-end gap-2">`（两处：done 分支「关闭」、表单分支「取消/保存」）
   - 4 个 `<button style={btnStyle} ...>` → `<Button variant="outline" size="sm" ...>`（「保存检查点」主按钮用默认 variant：`<Button size="sm" ...>`）
   - `（覆盖同名旧检查点）`、`<code>` 等 JSX 内容一律不动。

- [ ] **Step 5.5: `web/src/components/ResumeDialog.tsx` 定点替换**

1) import 区：
   - 删 `import { btnStyle, dialogStyle, fieldLabel, jsonFieldError, overlayStyle } from "./dialogStyles";`
   - 增 `import { jsonFieldError } from "../lib/json";`、`import { cn } from "../lib/utils";`、`import { Button } from "./ui/button";`、`import { badOutlineCls, errTextCls, fieldCls, labelCls, okTextCls, overlayCls, panelCls, warnTextCls } from "./dialogTheme";`
2) 删本地 `const badTextarea: React.CSSProperties = { outline: "2px solid #dc2626" };`（被 `badOutlineCls` 取代）
3) JSX 替换（逐处）：
   - `<div style={overlayStyle} onClick={onClose}>` → `<div className={overlayCls} onClick={onClose}>`
   - `<div style={dialogStyle} onClick={(e) => e.stopPropagation()}>` → `<div className={panelCls} onClick={(e) => e.stopPropagation()}>`
   - 标题 `<div style={{ fontWeight: 700, fontSize: 14 }}>` → `<div className="text-[13.5px] font-bold">`
   - `style={fieldLabel}` → `className={labelCls}`（4 处：回退目标/模块名/spec/tasklist/预检）
   - 回退目标 `<select ... style={{ width: "100%" }}>` → 删 style、加 `className={fieldCls}`
   - 模块名 `<input ... style={{ width: "100%", boxSizing: "border-box" }}>` → `className="w-full"`
   - spec textarea：`style={{ width: "100%", fontFamily: "monospace", boxSizing: "border-box", ...(specErr ? badTextarea : {}) }}` → `className={cn("w-full font-mono", specErr && badOutlineCls)}`
   - tasklist textarea：同上，`tasklistErr && badOutlineCls`（保留 placeholder 与 rows）
   - 错误/警示/成功文案（用 dialogTheme 常量）：
     - `style={{ color: "#b91c1c", fontSize: 12 }}` → `className={errTextCls}`（spec/tasklist 校验行、hard_errors 区）
     - `style={{ color: "#b45309", fontSize: 12 }}` → `className={warnTextCls}`（warnings 区、预检不可用行）
     - `style={{ color: "#16a34a", fontSize: 12 }}` → `className={okTextCls}`（预检通过行）
     - `{err && <div style={{ color: "#b91c1c" }}>{err}</div>}` → `{err && <div className="text-[12.5px] text-destructive">{err}</div>}`
   - 文件上传行 `<div style={{ marginTop: 4 }}>` → `<div className="mt-1">`
   - 选项行 `<div style={{ display: "flex", gap: 16, alignItems: "center" }}>` → `<div className="flex flex-wrap items-center gap-4">`
   - 底部 `<div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>` → `<div className="mt-1 flex justify-end gap-2">`；两个按钮 → `<Button variant="outline" size="sm" onClick={onClose} disabled={busy}>取消</Button>` 与 `<Button size="sm" onClick={submit} disabled={...}>{busy ? "启动中…" : "启动恢复"}</Button>`
   - 预检 `(检查中…)` 的 `style={{ fontWeight: 400, color: "#6b7280" }}` → `className="font-normal text-muted-foreground"`
   - 「目标时点已执行」`style={{ fontSize: 11, color: "#6b7280" }}` → `className="text-[11px] text-muted-foreground"`
   - 逻辑（targets/preflight/submit/onTasklistFile/firedOf/targetLabel）一行不动。

- [ ] **Step 5.6: `web/src/components/SpecForm.tsx` 颜色令牌替换（布局内联样式保留，颜色换令牌）**

该文件仍用内联样式对象（换皮收益低、diff 大，本期只做颜色令牌化保证暗色可用）。逐条替换文件内出现的颜色字面量（按本任务开头映射表）：

- `color: "#b91c1c"` → `color: "hsl(var(--destructive))"`（errStyle 等）
- `outline: "2px solid #dc2626"` → `outline: "2px solid hsl(var(--destructive))"`（badOutline）
- `#b45309` → `"var(--ph-truncated)"`；`#16a34a` → `"var(--ph-done)"`；`#6b7280`/`#9ca3af` → `"hsl(var(--muted-foreground))"`
- 边框 `#e5e7eb`/`#f3f4f6` → `"hsl(var(--border))"`；浅底 `#f9fafb` → `"hsl(var(--secondary))"`
- import 行：`import { jsonFieldError } from "./dialogStyles";` → `import { jsonFieldError } from "../lib/json";`

- [ ] **Step 5.7: 删除 `web/src/components/dialogStyles.ts`**

```bash
grep -rn "dialogStyles" web/src --include=*.tsx --include=*.ts
# Expected: 无输出（所有引用已迁移）
git rm web/src/components/dialogStyles.ts
```

- [ ] **Step 5.8: 构建验证**

Run: `cd web && npm run build`
Expected: 绿。

- [ ] **Step 5.9: Commit**

```bash
git add web/src/lib/json.ts web/src/components/dialogTheme.ts web/src/components/RunControls.tsx web/src/components/ResumeDialog.tsx web/src/components/CheckpointDialog.tsx web/src/components/SpecForm.tsx
git commit -m "refactor(web): 对话框/控制条/表单换皮——ui/button + dialogTheme class，jsonFieldError 迁 lib/json，dialogStyles 退役"
```

---

### Task 6: RunView / NodePanel / StatusNode / GraphView 换皮（含 React Flow 暗色）

**Files:**
- Modify: `web/src/components/RunView.tsx`（定点替换）
- Modify: `web/src/components/NodePanel.tsx`（全量重写）
- Modify: `web/src/components/StatusNode.tsx`（全量重写）
- Modify: `web/src/components/GraphView.tsx`（定点替换）

- [ ] **Step 6.1: `web/src/components/StatusNode.tsx` 全量重写（配色读 CSS 变量，逻辑/badgeOf 原样）**

```tsx
// 自定义节点：名称 + 类型 + 状态色边框 + ×N 次数徽章。配色读 index.css 主题
// 变量——亮暗主题自动生效。
import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { NodeState } from "../api";

export type StatusNodeData = {
  label: string;
  type: string;
  isStart: boolean;
  state?: NodeState;
};

export type StatusFlowNode = Node<StatusNodeData, "status">;

const BORDER: Record<string, string> = {
  running: "var(--ph-running)",
  failed: "var(--ph-aborted)",
  aborted: "var(--ph-aborted)",
  done: "var(--ph-done)",
  idle: "hsl(var(--muted-foreground))",
};

export function badgeOf(state?: NodeState): string {
  if (!state) return "idle";
  if (state.running) return "running";
  if (state.last_status && state.last_status !== "ok") return state.last_status;
  if (state.fired_count > 0) return "done";
  return "idle";
}

function StatusNodeInner({ data }: NodeProps<StatusFlowNode>) {
  const badge = badgeOf(data.state);
  const color = BORDER[badge] ?? BORDER.idle;
  return (
    <div
      style={{
        border: `2px solid ${color}`,
        borderRadius: 8,
        padding: "6px 10px",
        minWidth: 150,
        background: "hsl(var(--card))",
        color: "hsl(var(--card-foreground))",
        boxShadow: badge === "running" ? `0 0 0 4px color-mix(in srgb, ${color} 20%, transparent)` : undefined,
      }}
    >
      <Handle type="target" position={Position.Left} />
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
        <strong>{data.label}</strong>
        {data.state && data.state.fired_count > 0 && (
          <span
            title="运行次数"
            style={{
              fontSize: 11,
              background: "hsl(var(--secondary))",
              color: "hsl(var(--secondary-foreground))",
              borderRadius: 8,
              padding: "0 6px",
            }}
          >
            ×{data.state.fired_count}
          </span>
        )}
      </div>
      <div style={{ fontSize: 11, color: "hsl(var(--muted-foreground))" }}>
        {data.type}
        {data.isStart ? " · start" : ""}
        {badge === "running" ? " · 运行中" : ""}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export const StatusNode = memo(StatusNodeInner);
```

- [ ] **Step 6.2: `web/src/components/NodePanel.tsx` 全量重写（数据流逻辑原样，样式 → Tailwind）**

```tsx
// 节点面板：元信息 + 最新输出（实时）+ firing 历史（点击展开全文）+ 实时流文本。
import { useEffect, useRef, useState } from "react";
import { fetchNodeTimeline, type GraphNode, type TimelineEntry } from "../api";

function pretty(v: unknown): string {
  if (v === undefined) return "（尚无输出）";
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}

export function NodePanel({
  runId,
  node,
  outputs,
  liveText,
  onClose,
}: {
  runId: string;
  node: GraphNode;
  outputs: Record<string, unknown>;
  /** 该节点当前执行的流式文本（phase=running 且有 token 时非空；终态后由 outputs 接管） */
  liveText?: string;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [openTick, setOpenTick] = useState<number | null>(null);

  const liveRef = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    if (liveRef.current) liveRef.current.scrollTop = liveRef.current.scrollHeight;
  }, [liveText]);

  useEffect(() => {
    setEntries([]);
    setOpenTick(null);
    let cancelled = false;
    fetchNodeTimeline(runId, node.id)
      .then((t) => { if (!cancelled) setEntries(t.entries); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [runId, node.id]);

  const latest = outputs[node.id];

  return (
    <aside className="w-[380px] shrink-0 overflow-y-auto border-l bg-sidebar">
      <header className="flex items-center justify-between px-3.5 py-2.5">
        <h3 className="m-0 text-[13px] font-bold">{node.id}</h3>
        <button className="text-muted-foreground hover:text-foreground" onClick={onClose}>×</button>
      </header>
      <div className="px-3.5 pb-3.5 text-[11.5px]">
        <p className="m-0 text-muted-foreground">
          类型 {node.type}
          {node.is_start ? " · start" : ""} · 输入 {JSON.stringify(node.inputs)}
        </p>
        {liveText ? (
          <section>
            <h4 className="mb-1.5 mt-3 text-[12px] font-semibold">
              实时输出<span className="text-[11px] font-normal text-[var(--ph-running)]">（流式）</span>
            </h4>
            <pre
              ref={liveRef}
              className="m-0 max-h-[240px] overflow-y-auto whitespace-pre-wrap rounded-md border bg-card p-2 text-[11.5px]"
            >
              {liveText.slice(-10000)}
            </pre>
          </section>
        ) : null}
        <section>
          <h4 className="mb-1.5 mt-3 text-[12px] font-semibold">最新输出（实时）</h4>
          <pre className="m-0 whitespace-pre-wrap rounded-md border bg-card p-2 text-[11.5px]">
            {pretty(latest)}
          </pre>
        </section>
        <section>
          <h4 className="mb-1.5 mt-4 text-[12px] font-semibold">运行记录（{entries.length} 次）</h4>
          {entries
            .slice()
            .reverse()
            .map((e) => (
              <div key={e.tick} className="border-b py-1.5">
                <div
                  className="flex cursor-pointer items-center justify-between"
                  onClick={() => setOpenTick(openTick === e.tick ? null : e.tick)}
                >
                  <span>tick {e.tick}</span>
                  <span className={e.status === "ok" ? "text-[var(--ph-done)]" : "text-[var(--ph-aborted)]"}>
                    {e.status}
                  </span>
                </div>
                {e.error && openTick !== e.tick && (
                  <div className="mt-0.5 text-[11.5px] text-[var(--ph-aborted)]">{e.error}</div>
                )}
                {openTick === e.tick && (
                  <pre className="mb-0 mt-1.5 whitespace-pre-wrap rounded-md border bg-card p-2 text-[11.5px]">
                    {pretty(e.output)}
                    {e.error ? `\nerror: ${e.error}` : ""}
                  </pre>
                )}
              </div>
            ))}
        </section>
      </div>
    </aside>
  );
}
```

- [ ] **Step 6.3: `web/src/components/RunView.tsx` 定点替换（逻辑零改动）**

1) import 区增：`import { Button } from "./ui/button";`
2) `procLogView`（约 329-349 行）整体替换为：

```tsx
  const procLogView = procLog && (
    <div className="mt-2.5">
      <div className="text-[12px] text-muted-foreground">process.log 尾部：</div>
      <pre className="mt-1 max-h-[260px] overflow-y-auto whitespace-pre-wrap break-all rounded-md border bg-secondary p-2 font-mono text-[12px]">
        {procLog}
      </pre>
    </div>
  );
```

3) 根节点与 header（约 352-381 行）替换为：

```tsx
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b px-3.5 py-2 text-[12.5px] text-muted-foreground">
        <span className="truncate font-mono">
          {`${runId} · ${statusView?.phase ?? payload?.phase ?? "…"}${
            statusView?.tick != null ? ` · tick ${statusView.tick}` : ""
          }${statusView?.error ? ` · ${statusView.error}` : ""}`}
        </span>
        <RunControls
          key={runId}
          runId={runId}
          phase={statusView?.phase ?? payload?.phase ?? null}
          paused={paused}
          moduleHint={moduleOverride}
          onAction={onRefreshRuns}
          resumeRequest={resumeRequest}
          onResumeRequestConsumed={onResumeRequestConsumed}
          procRunning={procRunning}
          onTerminate={terminateProc}
        />
      </header>
```

（RunControls 子元素逐 prop 原样保留——上方代码即完整替换块。）

4) 停滞黄条（约 382-404 行）替换为：

```tsx
      {stalled && (
        <div className="flex items-center gap-2.5 bg-[color-mix(in_srgb,var(--ph-truncated)_14%,transparent)] px-3.5 py-1.5 text-[12px] text-[var(--ph-truncated)]">
          <span>
            进程长时间无输出——可能已失联/崩溃。若确认进程已退出，可强制恢复。
          </span>
          <Button variant="outline" size="sm" onClick={() => onRequestResume(runId)}>
            打开恢复/回退…
          </Button>
        </div>
      )}
```

5) 错误区与等待区（约 405-440 行）替换为：

```tsx
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        {error && (
          <div className="p-3 text-[12.5px] text-destructive">
            图加载失败：{error.message}
            {needModulePicker && (
              <div className="mt-2 flex items-center gap-2">
                <select
                  onChange={(e) => setModuleOverride(e.target.value || null)}
                  defaultValue=""
                  className="rounded-control border border-input bg-transparent px-2 py-1 text-[12.5px]"
                >
                  <option value="">选择模块…</option>
                  {modules.map((m) => (
                    <option key={`${m.kind}:${m.name}`} value={m.name}>
                      {m.name}（{m.kind}）
                    </option>
                  ))}
                </select>
                {moduleOverride && <span>已切换模块：{moduleOverride}</span>}
              </div>
            )}
            {procLogView}
          </div>
        )}
        {waitingMaterial && (
          <div className="p-3 text-[12.5px] text-[var(--ph-truncated)]">
            运行迟迟未落盘——可能启动失败，见下方日志
            {procLogView}
          </div>
        )}
        {payload ? (
          <GraphView
            payload={payload}
            status={statusView}
            selected={selected}
            onSelect={setSelected}
          />
        ) : (
          !error && !waitingMaterial && <div className="p-3 text-[12.5px]">图加载中…</div>
        )}
      </div>
```

（NodePanel 挂载段不动——NodePanel 自身已在 Step 6.2 换皮。）

- [ ] **Step 6.4: `web/src/components/GraphView.tsx` 定点替换（暗色画布 + 回到当前按钮）**

1) import 区增：`import { Button } from "./ui/button";`
2) `<ReactFlow ... >` 开标签加 `colorMode="system"`（@xyflow/react v12 原生属性：Controls/MiniMap/Background 跟随系统亮暗）：

```tsx
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onMoveStart={onMoveStart}
        onNodeClick={(_, n) => onSelect(n.id)}
        onPaneClick={() => onSelect(null)}
        colorMode="system"
        fitView
        minZoom={0.2}
        maxZoom={2}
      >
```

3) 「回到当前」按钮替换：

```tsx
      <Button
        variant="outline"
        size="sm"
        className="absolute left-2 top-2 z-10"
        onClick={() => {
          followRef.current = true;
          const ids = fireableInView();
          if (ids.length) centerOn(ids);
        }}
      >
        回到当前
      </Button>
```

- [ ] **Step 6.5: 构建验证 + 全局字面量扫尾**

Run: `cd web && npm run build`
Expected: 绿。

Run: `grep -rn "#e5e7eb\|#f3f4f6\|#f9fafb\|#6b7280\|#9ca3af\|#b91c1c\|#111827\|#374151" web/src --include=*.tsx --include=*.ts`
Expected: 仅 `ModulesView.tsx` 相关历史文件若尚存则已在 Task 4 删除；`SpecForm.tsx` 已令牌化。若有漏网（如 `#fff`），按映射表补换后重跑 build。

- [ ] **Step 6.6: Commit**

```bash
git add web/src/components/RunView.tsx web/src/components/NodePanel.tsx web/src/components/StatusNode.tsx web/src/components/GraphView.tsx
git commit -m "refactor(web): 运行视图面换皮——节点/面板/黄条/错误区走主题变量，React Flow colorMode=system 暗色适配"
```

---

### Task 7: 终验 + 文档同步

**Files:**
- Modify: `roadmap.md`（变更日志追加一行）
- Modify: `AGENTS.md`（`web/` 目录描述更新为新组件结构）

- [ ] **Step 7.1: 全量验收**

```bash
cd web && npm run build        # Expected: 绿
cd .. && python -m pytest tests/ -q   # Expected: 全绿（server 零改动回归基线）
```

- [ ] **Step 7.2: 手动全链路冒烟（dev 起后端 + 前端，或指向真实运行根）**

- [ ] 侧栏导航：两页签切换、列表常驻、点行切 run
- [ ] 模块：选模块 → 详情（模板/schema/default_spec）→ 发起运行（SpecForm 表单+JSON 双模式）→ 自动切运行页签开新 run
- [ ] 运行：WS 实时 tick 前进、节点徽章计数、跟随镜头、点节点 → NodePanel（最新输出/历史）
- [ ] 控制：行内 ⏸/▶；RunControls 暂停/继续/取消；存检查点；终态恢复/回退（预检 hard_errors 禁启停）；running 强制删除二次确认
- [ ] 异常态：发起后落盘等待门（202→status 404 静默轮询→放行）；黄条停滞提示 → 恢复对话框
- [ ] 主题：系统亮/暗切换（或 localStorage 覆盖）全界面生效，含图节点/React Flow 控件/对话框

- [ ] **Step 7.3: `roadmap.md` 变更日志追加**

在「## 变更日志」节顶部加：

```markdown
- 2026-09-10 **TreeChat 整合第一期：壳层重组**——web/ 引入 Tailwind + shadcn neutral
  主题（TreeChat webui 基建移植：cn/ui 基件/ActivityBar 结构），App 重写为 VSCode 式
  三段壳（活动栏 + 侧边栏 280px + 主区），侧栏导航范式：运行历史压缩为 RunList 侧栏
  常驻、模块库拆 ModuleList/ModuleDetail（发起表单内嵌主区，RunDialog 退役）、亮暗
  主题跟随系统。`server/`/api.ts/ws.ts/dagre.ts 零改动。设计：
  `docs/superpowers/specs/2026-09-10-treechat-integration-phase1-shell-design.md`。
  二期将并入 TreeChat 对话引擎（对话/树/卡片页签 + 服务层挂载）。
```

- [ ] **Step 7.4: `AGENTS.md` `web/` 目录描述更新**

把 `web/` 一行中组件清单改为：

```
`web/` — Vite + React + TS + Tailwind + React Flow + dagre SPA：`src/App.tsx`（VSCode 式壳：
活动栏 + 侧边栏导航 + 主区，跨视图状态 runId/runs 轮询/恢复请求）、`src/index.css`（shadcn
neutral 主题变量，TreeChat 基建）+ `components/`（ActivityBar 活动栏、ModuleList/ModuleDetail
模块库、RunList 运行历史侧栏、RunView/GraphView/StatusNode/NodePanel 运行视图、RunControls
控制条、ResumeDialog/CheckpointDialog、SpecForm、ui/ 基件）+ `src/api.ts`（端点载荷类型）+
`src/lib/utils.ts`（cn/relativeTime）+ `src/lib/json.ts`
```

- [ ] **Step 7.5: Commit**

```bash
git add roadmap.md AGENTS.md
git commit -m "docs: roadmap 变更日志 + AGENTS.md 组件清单同步（TreeChat 整合第一期壳层重组）"
```

---

## 明确不做（本期，防执行走样）

- Radix 依赖、现有对话框迁 Radix、window.confirm 升级应用内对话框（二期）
- SpecForm/对话框的全量 Tailwind 重排（本期只做颜色令牌化 + 布局保留，规格已注明）
- 主题 UI 切换按钮（localStorage 手改即可，与 TreeChat 一致）
- router、任何 `server/`/`api.ts`/`ws.ts`/`dagre.ts` 改动、前端测试框架
