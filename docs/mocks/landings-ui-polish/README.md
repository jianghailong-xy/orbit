# Landings 窗口 · iPhone UI 优化（2026-11-10）

owner 11-10（iPhone 截图）：「landing 窗口渲染成这样了，请优化 UI」。owner 看过本图后选了全部推荐：「按推荐的来，开始改」。

| 图 | 内容 |
|---|---|
| `01-landings-ui.png` | a 现在（owner 截图）· b 改后（同一屏）、改动说明、待定 |

改动（iOS/macOS 先改，web 和 Android 随后照同一套）：

1. 去掉头像：窗口里每条都是 Orbit 发的。
2. `Merged into main` 由气泡改成居中的一行事件。
3. 底栏贴底、不透明、一行：锁 + `Orbit runs these landings`，右边 `Open coordinator`。
4. 日期胶囊、落地气泡、点开 / 长按、`Now` 的卡不变。
5. iPhone 标题栏合成系统导航栏的一行（返回、`Landings` / 项目名、⋯）；副行只写项目名。macOS 保留自己的头。

渲染：`board.html` 自包含（`frames/today-ios.png` 是 owner 的截图缩到 880 宽）；用 playwright 按 `.board[data-png]` 截 2x PNG，截之前调 `window.drawMarks()`。
