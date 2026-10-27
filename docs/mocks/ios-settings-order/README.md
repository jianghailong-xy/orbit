# iOS 设置重排 · 设计板

所有者 2026-10-27：「iOS 的 settings 页面重新设计，先给效果图，我认为现在的顺序不符合预期」（附 TestFlight 截图）。板子是 [`01-board-light.png`](01-board-light.png)（源 `01-board.html`），四段也各出了一张，方便在手机上看：`01-board-part-1-light.png` … `part-4`。界面文案全部英文，板上的说明是中文。所有者定了 ③ 的三项后再改代码。

## 怎么做的

- **iPhone 帧是画的，不是截图**：组、行、顺序取自 `SettingsHome.swift`，行的样子（图标、开关、选择器、值、说明）和 Sessions 页的段脚取自 `SettingsSheet.swift`（`NotificationSettingsPage` 那两个开关的样子）。颜色从所有者 10-27 的截图上取：组标题 #BBBBC0、值 #8A8A8D、行内说明 #7F7F7F、段脚 #85858A、开关 #65C466。手机 393×852，壳子是 `../antigravity-accounts/kit.css` 加 `../provider-engine-decoupling/board.js` 的 `sheetPhone`；行、开关、图标是板子自己的 `sx-*`（`index.css` 里有 `.st-*`，所以没用那个前缀）。
- **每台手机画整张列表**，红虚线在 852 pt（一屏的底），线下加了一层灰。板上的 pt 都是页面布局后量出来的（脚本里的 `M`），从屏幕顶算。
- **和真机对过**：[`calib.mjs`](calib.mjs) 把「今天」那台按 Pro Max 的 440 宽、20 pt 边距重排再量。Suggested replies 一行画出来 152 pt、Session recaps 172 pt，截图上同两行是 150、171 pt；那台手机上 Machines & models 落在 917–969 pt，屏幕底是 956。
- **示例数据**：Alex / alex@example.com。仓库是公开的，不放所有者的真实账户。

## 重画

```
THEMES=light FONTCONFIG_FILE=<fonts.conf> node docs/mocks/ios-settings-order/render.mjs 01-board
FONTCONFIG_FILE=<fonts.conf> node docs/mocks/ios-settings-order/calib.mjs
```

`fonts.conf` 把 `-apple-system` 指到 Inter、`PingFang SC` 指到 Noto Sans SC（Kimi 那几块板用的那份）。Chromium 默认用 Playwright 的 chromium-1243。
