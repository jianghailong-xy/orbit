# Infrastructure 重排（Web）· 设计板

所有者 2026-10-25 的要求：「重新设计这个页面，视觉重心应该是 1. 关注用户自己的机器 2. 用户自己配置的 provider」。板子是 [`01-board-light.png`](01-board-light.png)（源 `01-board.html`）。界面文案全部英文；板上的说明是中文。所有者确认后再改界面。

## 怎么做的

- **每一帧都是真实页面截图**：HEAD 的 `src/web` + `src/shared` 跑在 vite 上，接仓库自带的 `src/web/ui-migration` 假 API，再由 `capture/data.mjs` 的示例数据答页面的请求（4 台机器、5 个厂商 6 把 key、1 个 Codex pool、4 个登出的 engine，按所有者 10-25 的截图搭，名字是样例）。「现在」是 HEAD 的页面；「改后」是同一份代码打上 [`prototype.patch`](prototype.patch)（`patch/apply.py` 生成）——只为出图，不是实现。
- **重新截图**：把 `capture/` 的脚本放到 `/var/tmp/infra-focus-mock/`（脚本里的路径按它写），`today/` 是 `git archive HEAD src/web src/shared tsconfig.base.json package.json` 加一份 lock 匹配的 `node_modules`，`proposal/` 是 `today/` 的副本经 `python3 -I patch/apply.py proposal`；然后 `unshare -n run-ns.sh <tree> scenes.mjs [scene …]`。截图和标注位置写进 `shots/`（`shots/marks.js`）。
- **重画板子**：`THEMES=light FONTCONFIG_FILE=<fonts.conf> node docs/mocks/infrastructure-focus/render.mjs 01-board`（fonts.conf 把 -apple-system / PingFang SC 指到 Inter / Noto Sans SC）。

## 已落地（2026-10-25）

所有者答「按推荐的来，落地」：五项都按建议——页顶提醒条去掉（A），引擎概览改成页尾「By engine」列表（A），API keys 改成每个厂商一张卡（A），「Connect another provider」收成一行胶囊（A），这次只改 web（A）。实现后的真实页面截图在 `implemented/`（同一套示例数据，`capture/scene-list.mjs` 的 `impl-*` 场景）：

| 图 | 内容 |
| --- | --- |
| [impl-page-light](implemented/impl-page-light.png) · [impl-page-dark](implemented/impl-page-dark.png) | 整页，明暗两版 |
| [impl-signin-light](implemented/impl-signin-light.png) | 按下 wikova 卡上 Kimi Code 的 Sign in：卡片展开，打开那一行自己的登录面板 |
| [impl-phone-light](implemented/impl-phone-light.png) | 手机 390 |
| [impl-edges-light](implemented/impl-edges-light.png) | 板上没画的三种机器状态（见下） |

板上没画、实现时补上的：

- **一部分账号登出的 engine**：比如 Claude Code 两个账号里 Work 登出了，chip 写「Claude Code 1 of 2 signed in」，橙色，不带 Sign in（登出的那个账号在展开后自己那一行有 Sign in）。今天收起的卡片会因为这种情况写「2 of 3 signed in」，chips 不能把它藏掉。
- **什么都没装、也没登录的机器**：没有 chip 可画，卡头右侧照旧写「0 of 3 signed in」。
- **离线的机器**：chips 照它最后一次报告的画、变淡，登出的 chip 不带 Sign in（机器离线时什么都按不了，和它展开后的行一致）。
- **读 key 的时候**：API keys 下面是一张转圈的卡（原来表格有加载态）。
- 每把 key 的 Edit / Delete 的无障碍名带上 key 的名字（「Delete Lab gateway」），屏幕阅读器里一页的按钮能分清。
- 「By engine」按板上写的不再写模型；DeepSeek Harness 和 Cursor CLI 的默认模型来自机器上的目录，所以页面上不再出现（会话的模型菜单里照旧有）。
