# 落地合成一个窗口（2026-10-27）

owner 10-27：「这个 landing 有好多个，是否可以合并到一个会话窗口里，先给我设计图」，随后补了一句「和 Merged into main 也合并到一个会话里」。

画在 main 0f43132c3 上，部件照 `../landing-session/v4/`（main 上已实现的落地页、Landings 组与头）。英文是上线文案，中文是说明；项目与任务名是示例数据。只画了 iPhone，web 与 Android 等方向定了再画。

| 图 | 内容 |
|---|---|
| `01-project-page.png` | ① 项目 sessions 页：a 现在（Landings 组一条一行，Merged into main 在时间线里）· b 改后（Landings 只剩一行，时间线只剩会话） |
| `02-one-window.png` | ② 落地窗口：c 现在（一次落地一个会话）· d 改后（一个项目一个窗口；结了的按天分组，没结的在最下面的 Now） |
| `03-open-and-doors.png` | ③ 改后：e 点一行在原地展开（Merged into main 那一轮的回执与记录）· f 从别处的 Open landing › 进来 · g 长按一张卡的门 |
| `04-decisions.png` | ④ 待定与落地 |

## 待定

1. **方案 A 只合窗口（推荐）**：服务端、契约 §2.9、agent 的 `landingSessionId` 都不动，只改三端客户端；**方案 B 一个项目只有一个落地会话**：迁移、契约修订、服务端与 agent 工具都要改，看到的和 A 一样。
2. **结了的落地在窗口里留多久**：全部保留、按天往上翻（推荐），还是只留 24 小时、更早的折成一行。

渲染：`board.html` 用 playwright-core 与 chromium 按 `#part-N` 截成 2x PNG，字体取自 `/var/tmp/landing-mock-render/fonts`。
