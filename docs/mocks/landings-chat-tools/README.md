# Landings 窗口 · 照会话聊天的画法（2026-11-11，web）

owner 11-11：「图 1 的 landing 效果，是否可以和图 2 里的聊天效果保持一致的 UI 效果，先给我设计图」。图 1 是 web Landings 窗口（11-10 上线的气泡 + 点开的 15 行时间线），图 2 是会话里的后台任务行、`Working for` 回合头和 Bash 工具行。

只用会话已有的部件：后台任务行（`bgwake`）、工具行（`chat-tool-card`）、回合头（`chat-turn-head`）。改后三帧是真实 web 控制台截图（会话页换上落地内容，`capture/`）。

| 图 | 内容 |
|---|---|
| `01-history.png` | ⓪ 会话参照（owner 图 2）· ① 往上翻历史：现在（owner 图 1）/ 改后 |
| `02-open-and-now.png` | ② 点开一次落地、窗口最底（等决定的、正在跑的）· ③ 规则、待定、要动的文件 |

## 待定

1. 步骤并成 5 个工具行（推荐），还是 15 行每行一个。
2. 收着那行的胶囊：检查时长（推荐）还是 sha。
3. 等决定的那条默认展开（推荐）还是收着。
4. web 先（推荐），iPhone / Android 照同一套再出图。

渲染：`capture/run-ns.sh capture.mjs`（vite 跑本树的 src/web，ui-migration fixtures 答接口，`proposal.mjs` 画改后），`node /var/tmp/landings-chat-bubbles/render.mjs <本目录>` 按 `data-png` 截 2x PNG。
