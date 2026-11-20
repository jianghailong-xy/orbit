# 落地是量出来的：客户端画什么（2026-11-20）

契约修订 42 第二部分（`docs/project-integration-line-contract.md` §12.11–12.18）的效果图，供 owner 裁决后再做客户端。部件取自 `../landing-session/v4/`（`kit.css` / `kit.js` / `web.css` / `web.js`）；英文是上线文案，中文是说明；项目与任务名是示例数据。Android 照 iPhone 的版式，不画。

| 图 | 内容 |
|---|---|
| `01-start-card.png` | ① 没有线的开始卡：去掉线与检查两段，一行 *Lands on the project’s branch when a task commits*（iPhone、web，现在与改后） |
| `02-project-page.png` | ② 已开始、没有线的项目页：没有 Landing 卡、Landings 行、任务行落地一段 |
| `03-settings.png` | ③ 落地检查与来历（You / Coordinator / Approved on a card + 时间），显式 No check |
| `04-exempt-task.png` | ④ 免检的任务：任务页带理由，检查清单里 Skipped |
| `05-changes.png` | ⑤ 协调者的改动列表，owner 的 Revert（含确认与改回之后） |
| `06-decisions.png` | ⑥ 条文没定的 7 条（D1–D7），每条备选与推荐 |

渲染：`board.html` 的每个 `section[data-png]` 用 playwright-core 与 chromium 截成 2x PNG（字体 `/var/tmp/landing-mock-render/fonts`）。

## 推荐（未裁决前按此画）

D1 开始卡只有那一行、不给选线控件 · D2 无线时项目页什么都不画 · D3 检查下一行画徽标 + 时间 · D4 三段开关 Merge check / Command / No check · D5 任务页 Landing 段一行 + 清单里 Skipped，owner 可 Remove exemption · D6 Settings 里入口行，进去整页列表（含 owner 自己的写入）· D7 Revert 先确认，写明后果；只给仍是当前值的行 Revert。

## owner 的裁决

（待填。本任务确认前由协调者把 owner 对 D1–D7 的裁决记在这里。）
