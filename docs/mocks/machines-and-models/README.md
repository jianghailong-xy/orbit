# Infrastructure → Machines & models · 设计板

所有者 2026-10-26：「改成 Machines & models，先出设计图」。板子是 [`01-board-light.png`](01-board-light.png)（源 `01-board.html`）。界面文案全部英文；板上的说明是中文。所有者定了 ⑥ 的四项后再改代码。

**已定、已落地（2026-10-26）**：所有者「都按推荐的来，落地」——01 板 ⑥ 的四项、02 板 ⑧ 的三项都选 A。代码在 0adda7173，落地版本的真实页面截图在 [`implemented/`](implemented/)，见文末「已落地」。

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

## 已落地

0adda7173（`feat(clients): Infrastructure becomes Machines & models, reached from Settings`）：

- **Web**：侧栏固定的几行只剩 Projects · Tasks · Wiki（`TasksSidePanel` 的 `TOP`），在这个页面和它下面的页时不亮任何一行；头像菜单里 Settings 上面一行 Machines & models；Settings 页 Session 两段后面一段 Machines & models——Manage 在右，页面那句说明下面是手机那一行的状态（在线机器上掉了登录的引擎、离线的机器、起不了会话的账号池，有就写「N need you」，否则「3 of 4 online」；账号池和页面用同一份列表 `accountPoolList`）；页面 h1 是 Machines & models，上面「‹ Settings」；key、pool、机器页的返回链接是「‹ Machines & models」；句子都写「the Machines & models page」。
- **iPhone / iPad**：设置里那一组不带组标题（`SettingsHome.header(.machines) == nil`），行和页面标题都是 Machines & models（`AppSection.runners.title`）。
- **Mac**：侧栏没有这一行（`AppSection.visible`）；设置表单 Account 下面一行，状态和手机一样，在 ⌘, 设置窗口里点它会关掉设置窗口；页面工具栏左上角「‹ Settings」。和板子 A② 不同的一处：在这个页面时侧栏不亮任何一行（和 web 一样）——SwiftUI 的列表里点已选中的行不会触发选择，Settings 亮着就点不回去。深链接、通知、首次启动落到机器的路线不变。
- **Android**：`Infrastructure.TITLE`、设置里那一组不带组标题、各句子。
- **服务端 / shared**：apiserver 的五个文件和 `managedRunnerDisplay.ts`、`managed-runner-states.fixture.json` 里的句子。
- **文档**：对外文章和官网（中英）都写成「Settings → Machines & models → Add → Register a machine」。

截图（`implemented/`，落地的 `src/web` + `src/shared`，kit 里的 `mm-impl/` 树，场景 `i-*`）：`settings.png`（侧栏 + Settings 页）、`menu.png`（头像菜单）、`head.png`（页面顶部）、`drawer.png` 和 `psettings.png`（手机抽屉、手机 Settings）。

