# iOS 设置照 web 分组 · 设计板

所有者 2026-11-16：「iOS 菜单的布局参考 web」，再要「先出效果图」。范围已定：只按 web 重新分组（不新增 iOS 没有的页），web 没有的行拿掉、只留 Sign out。板子是 [`01-board-light.png`](01-board-light.png)（源 `01-board.html`），四段各一张 `01-board-part-N-light.png`。界面文案英文，板上说明中文。

- 手机是画的，不是截图：行、组、顺序取自分支上改过的 `SettingsHome.swift` / `SettingsSheet.swift`，画法和颜色沿用 `../ios-settings-order` 的 `sx-*`。web 导航照 `SettingsLayout.tsx` / `settingsIndex.ts` 画。账户、机器、密钥、模型档位都是示例数据。

## 重画

```
THEMES=light CHROME=<chrome-headless-shell> FONTCONFIG_FILE=<fonts.conf> node docs/mocks/ios-settings-web-groups/render.mjs 01-board
```

## 已定（2026-11-16）

所有者「1A 2A 3A」，三项都按建议：Machines、Providers 拆成两行两页；这两行上面不加组标题；Android 跟着改（另开任务）。
