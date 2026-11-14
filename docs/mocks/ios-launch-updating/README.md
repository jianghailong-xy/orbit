# iOS 打开时的「正在收取」提示（2026-11-14）

owner 11-14（手机截图）问：iOS 刚打开时能不能有收取中之类的提示和状态，先出效果图。

**owner 11-14 定了：「A，按建议，旧行不压淡」。**

| 图 | 内容 |
|---|---|
| `01-placement.png` | ① 放在哪：今天 · A 工作区名下一行小字（定了）· B 标题换成 Updating… · C 顶部进度条 + 浮条 |
| `02-states.png` | ② A 的各个状态和出现 / 消失的时间；1′「旧行变淡」不做 |

## 定了

- 冷启动和从后台回来时开始一轮；0.4 s 内读回来什么都不出现；出现了至少留 0.6 s。
- 0.4 s 起 `Updating…`（列表还没有行时是 `Loading sessions…`），4 s 起 `Connecting…`，读失败或 15 s 起 `Offline · Tap to retry`，直到有一次读成功。
- 只在 Open 列表；Completed / Trash 不显示。macOS 不画。
- 列表没存过时用灰色占位行代替居中的 Loading…。
- 旧行不压淡。

实现：`OrbitKit/App/OpenListFreshness.swift`（规则和测试），`AppModel.openListStatus`，`WorkspaceTitle` 的 `status`。

## 怎么来的

`board.html` 是手画的板子（样例数据，名字都是编的），`node capture/render.mjs <本目录>` 按 `.board[data-png]` 截 2x PNG。
