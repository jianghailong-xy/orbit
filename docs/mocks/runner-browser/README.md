# Orbit Cloud 浏览器 · 设计板

Orbit Cloud runner（托管 runner）里的 agent 用真的 Chrome 干活；你在自己的浏览器里实时看到画面（WebVNC），不对劲时接管。只有 Orbit Cloud 能开，默认部署关闭（`ORBIT_MANAGED_RUNNER_BROWSER_ENABLED`，依赖 `ORBIT_MANAGED_RUNNERS_ENABLED`）。

提案（2026-11-17）。已定：P2 = B，整台 runner 共用一个浏览器，登录态保存在 runner 卷上、agent 直接用；可以在 Settings 里自己打开登录。P1、P3–P5 待定。设计文档：[`docs/runner-browser-design.md`](../../runner-browser-design.md)。

| 图 | 内容 |
| --- | --- |
| [`01-board.png`](01-board.png) | 整板 |
| [`01-board-1.png`](01-board-1.png) | ① 今天 ② 新链路（不开入站端口）③ 开关 |
| [`01-board-2.png`](01-board-2.png) | ④ 会话页的 Browser 标签 ⑤ 抽屉只看 ⑥ 接管 ⑦ 交还 ⑧ Settings 里自己打开 ⑨ 在里面登录 |
| [`01-board-3.png`](01-board-3.png) | 待定 P1–P5、资源与安全、落地顺序 |

## 怎么做的

- 手绘 HTML（`01-board.html`），网页为准；样式取自 [`../condition-triggers/01-board.html`](../condition-triggers/01-board.html)，新增的类带 `rb-` 前缀。
- 渲染：[`render.mjs`](render.mjs)，`node render.mjs "$PWD/01-board.html" "$PWD"`。字体靠 `FONTCONFIG_FILE`（Inter、Noto Sans SC、JetBrains Mono）。
- 界面文案英文，注释中文；网页内容是演示数据。
