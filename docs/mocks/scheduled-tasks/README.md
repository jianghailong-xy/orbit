# Scheduled tasks · 设计板（第 4 版）

依据 [`docs/scheduled-tasks-design.md`](../../scheduled-tasks-design.md) 第 4 版，D1–D4 已定（2026-11-14）。页面布局是第 3 版定的：只放在左侧抽屉，Scheduled 页参考 macOS / iOS 提醒事项（Reminders）的「计划」列表，不进任何工作区的会话列表。第 4 版加的是：创建卡四行（目标、May、Costs、Today）、超出信封才弹卡、原话 / 备注 / 用量、执行调整自己的任务、一次性的定时。

| 板 | 内容 |
| --- | --- |
| [`02-agent-first.png`](02-agent-first.png) | iOS，第 4 版新增的部分：创建卡、信封卡、详情面板的原话 / 备注 / 用量、执行调整自己的任务、Waiting on you；谁负责什么。它取代 `01-board.png` 里的创建卡 |
| [`01-board.png`](01-board.png) | iOS，第 3 版的页面：左侧抽屉、时间线、底部弹出的详情、在会话里修改、执行会话、在列表里直接说一句（未重画，创建卡以上一张为准） |
| [`web/01-board.png`](web/01-board.png) | Web 1/2，第 4 版：时间线（含一次性的）、显示过去的执行 + 详情面板、输入行、草稿 + 创建确认、空状态 |
| [`web/02-board.png`](web/02-board.png) | Web 2/2，第 4 版：在会话里创建、超出信封才弹卡、扩大权限、Waiting on you、执行调整自己的任务、执行会话；谁负责什么 |

## 怎么做的

- iOS 板是手绘 HTML（`01-board.html`、`02-agent-first.html`）。
- Web 各帧是真实的 Web 控制台（`src/web` 构建 + `src/web/ui-migration` fixtures），新增部分由 `web/capture/` 下的脚本注入，用的是控制台自己的样式类和颜色变量：[`scheduled-page.mjs`](web/capture/scheduled-page.mjs) 拍 1/2 的五帧，[`capture.mjs`](web/capture/capture.mjs) 拍 2/2 的六帧（`create budget change waiting selfend run`），都直接写进 `web/`。它们借用 `/mnt/data/tmp/runner-res-mock/` 的 kit（`lib.mjs`、`run-ns.sh`、`dist`）：`cd /mnt/data/tmp/runner-res-mock && unshare -n ./run-ns.sh dist <脚本> [scene…]`。
- 板子用 [`render.mjs`](render.mjs) 渲染，它会等字体加载完再截图：`node render.mjs "$PWD/web/board.html?b=1" $PWD/web/01-board.png`。
- 名称、时间、版本号、PR 号、用户名都是演示数据。
