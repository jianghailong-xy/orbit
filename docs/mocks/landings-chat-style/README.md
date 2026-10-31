# Landings 窗口改成聊天的样子（2026-10-31，方案 B）

owner 10-31：「评估下这个页面的设计，是否可以和 Session 聊天保持一致的交互风格」（web Landings 窗口截图，项目 Runner 链路 v1），评估给了三条路（A 换画法保留日期组 / B 完全像聊天 / C 只修细节），owner 选「B 先出效果图」。

画在 main d6f363a6c 上。web 的帧都是真实控制台截图（vite + `src/web/ui-migration` 的 fixtures，数据照 owner 截图里的项目）：「现在」是 `ProjectLandingsWindow` 原样，「改后」是会话页本身，换上落地的内容，用的全是会话已有的部件（`chat-turn-head`、`chat-tool-group`、`chat-tool-card`、`chat-result`、`chat-turn-foot`、`chat-status-card`）。iPhone 的「改后」照 iOS 会话手画，「现在」是 10-27 那张图（`../landings-one-window`，已照它实现）去掉标注。英文是上线文案，中文是说明。

| 图 | 内容 |
|---|---|
| `01-history.png` | ⓪ 会话长这样 · ① 往上翻历史：现在 / 改后 |
| `02-open.png` | ② 点开一次落地（合入 main 的一轮）：现在 / 改后 |
| `03-now.png` | ③ 窗口最底：等决定的、正在跑的、底栏：现在 / 改后 |
| `04-iphone.png` | ④ iPhone：现在 / 改后（往上翻、最底） |
| `05-rules.png` | ⑤ 规则表、代价、改哪些、待定 |

## 待定

1. web 每条上面的 `Worked for` 回合头：要（推荐），还是省掉换密度。iPhone 不加。
2. 那一句话放在步骤前面（推荐），还是照会话放在步骤后面。
3. iPhone 的时间：每条下面一行（推荐），还是放进 `Steps` 那一行。
4. 每一步的时刻：点开那一步才看（推荐），还是常驻。
5. 先改哪端：web + iPhone 一起（推荐），Android 随后。

另：owner 截图里每轮合入 main 出现两行是 bug（`landingSessionId` 是 UUID、会话 `id` 是 base62，web 和 Swift 直接比字符串），和本图无关，单独修。本图「现在」按修好以后画。

渲染：`/var/tmp/landings-chat-mock`（`capture.mjs` 截帧，`proposal.mjs` 改后的画法，`gen.mjs` 生成 `board.html`，`render-board.mjs` 按 `data-png` 截成 2x PNG）。
