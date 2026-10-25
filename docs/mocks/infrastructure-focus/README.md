# Infrastructure 重排（Web）· 设计板

所有者 2026-10-25 的要求：「重新设计这个页面，视觉重心应该是 1. 关注用户自己的机器 2. 用户自己配置的 provider」。板子是 [`01-board-light.png`](01-board-light.png)（源 `01-board.html`）。界面文案全部英文；板上的说明是中文。所有者确认后再改界面。

## 怎么做的

- **每一帧都是真实页面截图**：HEAD 的 `src/web` + `src/shared` 跑在 vite 上，接仓库自带的 `src/web/ui-migration` 假 API，再由 `capture/data.mjs` 的示例数据答页面的请求（4 台机器、5 个厂商 6 把 key、1 个 Codex pool、4 个登出的 engine，按所有者 10-25 的截图搭，名字是样例）。「现在」是 HEAD 的页面；「改后」是同一份代码打上 [`prototype.patch`](prototype.patch)（`patch/apply.py` 生成）——只为出图，不是实现。
- **重新截图**：把 `capture/` 的脚本放到 `/var/tmp/infra-focus-mock/`（脚本里的路径按它写），`today/` 是 `git archive HEAD src/web src/shared tsconfig.base.json package.json` 加一份 lock 匹配的 `node_modules`，`proposal/` 是 `today/` 的副本经 `python3 -I patch/apply.py proposal`；然后 `unshare -n run-ns.sh <tree> scenes.mjs [scene …]`。截图和标注位置写进 `shots/`（`shots/marks.js`）。
- **重画板子**：`THEMES=light FONTCONFIG_FILE=<fonts.conf> node docs/mocks/infrastructure-focus/render.mjs 01-board`（fonts.conf 把 -apple-system / PingFang SC 指到 Inter / Noto Sans SC）。
