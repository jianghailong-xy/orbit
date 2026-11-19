# Orbit Cloud 浏览器 · 设计板

Orbit Cloud runner（托管 runner）里的 agent 用真的 Chrome 干活；你在自己的浏览器里实时看到画面（WebVNC），不对劲时接管。只有 Orbit Cloud 能开，默认部署关闭（`ORBIT_MANAGED_RUNNER_BROWSER_ENABLED`，依赖 `ORBIT_MANAGED_RUNNERS_ENABLED`）。

提案（2026-11-17）。已定：P2 = B，整台 runner 共用一个浏览器，登录态保存在 runner 卷上、agent 直接用；可以在 Settings 里自己打开登录。P1 A、P3 B（接管不停 agent，两边一起操作）、P4 A、P5 A，同日都定了。设计文档：[`docs/runner-browser-design.md`](../../runner-browser-design.md)。

| 图 | 内容 |
| --- | --- |
| [`01-board.png`](01-board.png) | 整板 |
| [`01-board-1.png`](01-board-1.png) | ① 今天 ② 新链路（不开入站端口）③ 开关 |
| [`01-board-2.png`](01-board-2.png) | ④ 会话页的 Browser 标签 ⑤ 抽屉只看 ⑥ 接管 ⑦ 交还 ⑧ Settings 里自己打开 ⑨ 在里面登录 |
| [`01-board-3.png`](01-board-3.png) | 已定 P1–P5、资源与安全、落地顺序 |
| [`02-control-view.png`](02-control-view.png) | 2026-11-19 上线后：接管时地方太小 → 方案 C，浏览器在自己的标签页里（整板） |
| [`02-control-view-1.png`](02-control-view-1.png) | ① 今天：窄抽屉里的 1280×800 画面 |
| [`02-control-view-2.png`](02-control-view-2.png) | ② 提案：自己的标签页、接管中；Fit / 100%、能粘贴，没有 `--no-sandbox` 提示条 |
| [`02-control-view-3.png`](02-control-view-3.png) | ③ 抽屉加 Open in new tab；标签页只看时 |
| [`02-control-view-4.png`](02-control-view-4.png) | A / B / C 比较（建议 C）、不变的、落地 |
| [`03-agent-tools.png`](03-agent-tools.png) | 给 agent 的工具：请你登录、状态、打开、清除（整板） |
| [`03-agent-tools-1.png`](03-agent-tools-1.png) | ① 请你登录：agent → 卡 → 标签页 → agent 继续 |
| [`03-agent-tools-2.png`](03-agent-tools-2.png) | ② 工具面（orbit mcp 与 CLI）、不做的 |
| [`03-agent-tools-3.png`](03-agent-tools-3.png) | 已定 Q1–Q4 = A（owner 2026-11-19）、落地 |

## 怎么做的

- 手绘 HTML（`01-board.html`），网页为准；样式取自 [`../condition-triggers/01-board.html`](../condition-triggers/01-board.html)，新增的类带 `rb-` 前缀。
- 渲染：[`render.mjs`](render.mjs)，`node render.mjs "$PWD/01-board.html" "$PWD"`；02 板同法，截 `#part-1`…`#part-4`，字体 `/var/tmp/rpr-mock/fonts.conf`。字体靠 `FONTCONFIG_FILE`（Inter、Noto Sans SC、JetBrains Mono）。
- 界面文案英文，注释中文；网页内容是演示数据。
