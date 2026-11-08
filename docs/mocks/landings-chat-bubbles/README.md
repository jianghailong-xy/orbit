# Landings 窗口像聊天框（2026-11-02，方案 C · 气泡）

owner 11-02（iPhone 截图）：「优化这个页面，使其更像聊天框」。10-31 的方案 B（`../landings-chat-style`，照会话里 agent 的回复画：一句话 + `Steps` 工具行）给 owner 看了，owner 选「先改效果图」。

本图换成聊天软件的画法：每次落地是 Orbit 发来的一条气泡消息，左边是 Orbit 的头像（App 图标），日期是居中的小胶囊，没结的两张状态卡是最后两条消息，底部是输入框的样子。用的都是今天已有的英文（不加新句子），服务端、契约都不动。

画在 main 1f3a7abf8 上，手机按 owner 的 iPhone Pro Max（440×956 pt，取值量自 owner 的截图）。英文是上线文案，中文是说明；项目和任务名是示例数据。只画了 iPhone，web 和 Android 等方向定了再画。

| 图 | 内容 |
|---|---|
| `01-history.png` | ① owner 截图的那一屏：a 现在 · b 改后 |
| `02-bottom.png` | ② 窗口最底（等决定的、正在跑的）：c 现在 · d 改后 |
| `03-open-press.png` | ③ 改后：e 点开一条（记录在气泡下面展开）· f 长按一条（气泡浮起，菜单不变） |
| `04-decisions.png` | ④ 规则对照、和 10-31 方案 B 比、待定、落地、代价 |

## 待定

1. **时刻放哪**：每条气泡底下一行的右边（推荐），还是只在隔了 10 分钟以上的两组之间画一个居中时刻。
2. **底部**：输入框样子的只读框 + `Open coordinator`（推荐，契约 LS6 不动），还是真能打字、发给协调会话（要改 LS6）。
3. **头像**：每组一个 Orbit 图标（推荐），还是不画。

渲染：`board.html` 自包含；`node /var/tmp/landings-chat-bubbles/render.mjs <本目录>` 用 playwright 按 `.board[data-png]` 截 2x PNG（截之前调 `window.drawMarks()` 画标号），字体 Inter + Noto Sans SC（`/var/tmp/landings-chat-mock/fonts.conf`）。
