# Infrastructure → Machines & models · 设计板

所有者 2026-10-26：「改成 Machines & models，先出设计图」。板子是 [`01-board-light.png`](01-board-light.png)（源 `01-board.html`）。界面文案全部英文；板上的说明是中文。所有者定了 ⑥ 的四项后再改代码。

## 怎么做的

- **Web 帧是真实页面截图**：main a3d923687 的 `src/web` + `src/shared` 跑在 vite 上，接 `src/web/ui-migration` 的假 API 和 infrastructure-focus 板的示例数据（`../infrastructure-focus/capture/data.mjs`）。「改后」是同一份代码跑过 [`capture/rename-web.py`](capture/rename-web.py)：只改侧栏标签、页头和返回链接，为出图用。
- **iOS / macOS / Android 帧是画的**，结构取自 `SettingsHome.swift`、`AppSection.swift` 和 `SettingsScreen.kt`；iPhone 用 `../antigravity-accounts/kit.css` 和 `../provider-engine-decoupling/board.js` 的构件。
- **重新截图**：kit 在 `/var/tmp/infra-focus-mock/`（`mm-today/`、`mm-new/` 两棵树，`mm/` 下是 `capture/` 这几个脚本），`unshare -n mm/run-ns-mm.sh <tree> scenes-mm.mjs [scene …]`。
- **重画板子**：`THEMES=light FONTCONFIG_FILE=<fonts.conf> node docs/mocks/machines-and-models/render.mjs 01-board`。
