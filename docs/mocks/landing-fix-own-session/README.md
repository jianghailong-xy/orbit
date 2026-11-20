# 落地失败先交给任务自己的会话（2026-11-20）

契约修订 42（草稿）的效果图：`docs/project-integration-line-contract.md` §12，待 owner 裁决附录 A 的 Q30–Q33。

部件照 `../landing-session/v4/` 与 `../landings-one-window/`（main 上的落地窗口）。英文是上线文案，中文是说明；项目与任务名是示例数据。只画了 iPhone。

| 图 | 内容 |
|---|---|
| `01-path.png` | ① 一次落地冲突走的路：现在（三个会话、两次裁决）与改后（一个会话、不重新裁决） |
| `02-iphone.png` | ② a 现在的落地窗口 · b 任务自己的会话里收到的卡 · c 落地窗口的 Fixing 状态与记录 · d 它修不了，交回协调会话 |
| `03-decisions.png` | ③ 待定的四条 |

渲染：`board.html` 的每个 `section[data-png]` 用 playwright-core 与 chromium 截成 2x PNG，字体取自 `/var/tmp/landing-mock-render/fonts`。
