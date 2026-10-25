# Infrastructure → Machines & models · 设计板

所有者 2026-10-26：「改成 Machines & models，先出设计图」。板子是 [`01-board-light.png`](01-board-light.png)（源 `01-board.html`）。界面文案全部英文；板上的说明是中文。所有者定了 ⑥ 的四项后再改代码。

## 怎么做的

- **Web 帧是真实页面截图**：main a3d923687 的 `src/web` + `src/shared` 跑在 vite 上，接 `src/web/ui-migration` 的假 API 和 infrastructure-focus 板的示例数据（`../infrastructure-focus/capture/data.mjs`）。「改后」是同一份代码跑过 [`capture/rename-web.py`](capture/rename-web.py)：只改侧栏标签、页头和返回链接，为出图用。
- **iOS / macOS / Android 帧是画的**，结构取自 `SettingsHome.swift`、`AppSection.swift` 和 `SettingsScreen.kt`；iPhone 用 `../antigravity-accounts/kit.css` 和 `../provider-engine-decoupling/board.js` 的构件。
- **重新截图**：kit 在 `/var/tmp/infra-focus-mock/`（`mm-today/`、`mm-new/` 两棵树，`mm/` 下是 `capture/` 这几个脚本），`unshare -n mm/run-ns-mm.sh <tree> scenes-mm.mjs [scene …]`。
- **重画板子**：`THEMES=light FONTCONFIG_FILE=<fonts.conf> node docs/mocks/machines-and-models/render.mjs 01-board`。

## 02 · 从 Settings 进

所有者 2026-10-26 问「是否把这些配置移入 settings 里会更好」，看过建议后说「先出效果图」。板子是 [`02-board-light.png`](02-board-light.png)（源 `02-board.html`）：web 和 Mac 的侧栏去掉这一行，从 Settings 里新加的一段进入，web 头像菜单里再放一行直达，页面顶上加「‹ Settings」；iPhone、iPad、Android 本来就从设置进，不变。⑧ 的三项和 01 板 ⑥ 一起定。

- **Web 帧是真实页面截图**：「B」是 01 的改名树（`mm-new`），「A」是同一棵树再跑 [`capture/settings-web.py`](capture/settings-web.py)（kit 里的 `mm-set/`）。场景在 `capture/scene-list-mm.mjs` 的 `s-*`：`unshare -n mm/run-ns-mm.sh /var/tmp/infra-focus-mock/mm-set scenes-mm.mjs 's-*'`（`mm-new` 同理）。
- **Mac 帧是画的**，结构取自 `AppSection.swift`、`SettingsAdminView.swift`（Mac 的设置表单）和 `SkillsRunnersView.swift`（`RunnersListView`）。
- **重画**：`THEMES=light FONTCONFIG_FILE=<fonts.conf> node docs/mocks/machines-and-models/render.mjs 02-board`。
