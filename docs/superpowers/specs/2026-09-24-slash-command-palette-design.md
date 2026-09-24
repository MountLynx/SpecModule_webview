# 斜杠指令面板完整升级（参考 nanobot）设计

- 日期：2026-09-24
- 状态：已认可
- 范围：`web/src/chat/`——仅交互体验完善，指令集不扩展，后端零改动
- 参照：`../参考/nanobot`（`webui/src/components/thread/ThreadComposer.tsx` 的 SlashCommandPalette + `webui/src/lib/slash-command.ts`）

## 背景与目标

Composer 已有斜杠模式切换雏形（`/direct`/`/grilling`：候选面板仅鼠标点击补全、无键盘导航、无描述展示、无最近使用）。nanobot 的斜杠面板是成熟参照：键盘全路径导航、命令元数据（图标/标题/描述/等宽命令）、视口自适应布局、最近使用持久化、文本间接层。本轮把本仓库面板升级到同一水准。

## 交互行为（面板打开时）

| 按键/动作 | 行为 |
|---|---|
| `↑` / `↓` | 循环移动选中项 |
| `Tab` / `Enter` | 补全选中项为 `/key `（光标置于空格后，面板关闭）。**行为变化**：面板打开时 Enter 不再发送 |
| `Escape` | 关闭面板；继续输入任意字符即重新打开（onChange 重置 dismissed） |
| 鼠标悬停 | 同步选中项 |
| 鼠标点击 | 补全（同 Enter/Tab） |
| form 外 `pointerdown` | 面板关闭（document 捕获监听） |

- 面板打开条件：沿用现有原始行首 `/` 判定（trim 后判定会让次行 `/` 开头的多行消息误判，已有决策保留）；`busy`/`disabled` 时不唤起。
- 发送路径、解析逻辑（`matchMode`）、未知命令提示条（原文照发）、仅切换模式（`/mode` 无余文 → `onSwitchMode`）全部保留不动。补全优先于发送：面板不在（Escape 过或已成完整命令）时 Enter 照常发送。
- IME 组合输入中（`event.nativeEvent.isComposing`）Enter 不补全也不发送。

## 组件与数据流

```
web/src/chat/
  useSlashPalette.ts   # hook：触发符注册表（扩展点）+ 过滤 + 选中态 + dismissed + 最近使用
  SlashPalette.tsx     # 纯展示面板：listbox/option 无障碍 + 图标/标题/描述/等宽命令 + 选中项滚动跟随
  Composer.tsx         # 保留：斜杠判定/解析/发送/chip 区 + 接线 hook 与面板
```

- **触发符扩展点**：hook 以 `{ char: string; at: "line-start" | "caret" }` 形状注册触发源；本轮仅注册 `/`（line-start）。未来第二触发符（如 `#` 节点引用补全，caret 位置）按同形状接入，面板组件复用。
- **过滤**：haystack（key + displayName + description）小写包含；查询为空时全部列出、最近使用的排前；命中截断 8 条。
- **文本间接层（i18n key 层适配）**：`resolveCommandText(mode)` 静态覆盖映射（**现为空表**）→ 后端 `displayName`/`description` 回落。保留 nanobot 的 `t(key, {defaultValue})` 间接层形状，但不引入 i18n 框架（生态零 i18n 依赖）；未来接 i18n 时只替换该函数实现。
- **上下文徽章**：会话默认模式（`category` 命中项）在面板中带「当前」徽章（对应 nanobot `/model` 的 current badge）。
- **图标**：`modeIcon(key)` 静态映射（direct → MessageSquare、grilling → Flame；实施时核对 lucide-react ^1.43 可用图标名）+ 未知 key 默认图标。

## 面板布局（复刻 nanobot 测量逻辑）

- `useLayoutEffect` 测量：`visualViewportBounds`（visualViewport.offsetTop/height 回落 window.innerHeight）+ 沿父链收集 `overflow-y: auto|scroll|hidden|clip` 容器求可视上下界 → `placement`（above/below）+ `maxHeight`（上限 288px、最小可用 144px 阈值、gap 8px）。
- 监听：`visualViewport` resize/scroll + window resize + document scroll（捕获），面板开合/条数变化时重算。
- 面板宽 = 输入区宽（`calc(100%-0.5rem)` 水平居中），列表超高内部滚动（maxHeight 扣除面板内边距）；选中项 `scrollIntoView({ block: "nearest" })` 跟随。
- 样式沿用本仓库设计语言：`rounded-panel border bg-card shadow-md p-1`，条目 `rounded-control hover:bg-accent`，等宽命令字 `font-mono text-[11px] text-muted-foreground`。

## 最近使用

- localStorage key `treechat.web.slashRecents.v1`，字符串数组，最近 5 条（最新在前，去重）。
- read/store helper 带 try/catch——localStorage 不可用（隐私模式等）降级为内存内有效，补全不受影响。
- 空查询时 recents 排前 + 「最近」徽章；补全选中后写入。

## 边界与错误处理

- 选中索引越界（过滤结果变化）回 0；`useEffect` 守卫。
- candidates > 8 截断（nanobot 同款 SLASH 限额）。
- 模式清单为空 → 面板不显示。
- 现有语义保留：未知命令提示条显示可用清单、原文照常发送。

## 测试与验收

- 本仓库前端无测试框架（生态惯例，不引入），验收 = `npm run build`（tsc --noEmit + vite build）+ 后端套件不回归（`uv run pytest tests/ -q`，本轮后端零改动应全绿）。
- 手工验证清单：
  1. `/` 唤起面板，↑↓ 循环、Tab/Enter 补全、Escape 关闭、继续输入重开；
  2. 悬停同步选中；点击补全；
  3. 补全后 `/grilling 继续拷问` 发送 → 本轮模式徽章为拷问；`/grilling` 单独发送 → 会话默认切换；
  4. 最近使用排序 + 「最近」徽章；刷新页面后仍生效；localStorage 禁用时补全仍可用；
  5. 未知命令（`/nope xxx`）提示条 + 原文发送；
  6. IME 组合中 Enter 不误发；
  7. 面板不遮内容：聊天区高度不足时 maxHeight 收缩（above 空间不足时 below 回落）。

## 明确不做（本轮边界）

- 指令集不扩展（仅 `/` 模式补全）；第二触发符仅留 hook 扩展点。
- nanobot 的 `/stop` 流式置顶等命令上下文排序不适用（无 stop 命令）。
- 后端零改动（`GET /api/modes` 载荷已有 key/displayName/description）。
- 不引入 i18n 框架、不引入前端测试框架。
