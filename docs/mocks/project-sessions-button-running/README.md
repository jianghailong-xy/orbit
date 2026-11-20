# iOS 项目会话按钮（⊞ N）显示“有东西在跑” · 设计板

所有者 2026-11-17：协调者会话标题栏上打开项目会话弹窗的按钮，看不出会话和落地正在运行。板子是 [`01-board-light.png`](01-board-light.png)（源 `01-board.html`），两段各一张 `01-board-part-N-light.png`。界面文案英文，板上说明中文。

## 重画

```
THEMES=light CHROME=<chrome-headless-shell> FONTCONFIG_FILE=<fonts.conf> node docs/mocks/project-sessions-button-running/render.mjs 01-board
```

## 已定（2026-11-17）

所有者「C，抽屉里任何活动的都算；面板打开时就停」：

1. **画法 C**：有活动时 ⊞ 换成会话行的转圈（`SpinnerGlyph`，强调色），数字不变。板上推荐的 A 不用。
2. **弹窗里任何“活动”都算**，比板上第 2 段的“亮”更宽：会话转圈或呼吸（停着但有后台作业）、落地作业在跑或排队、合入在检查或在合。等你决定、合入被挡住仍不算——它们不是活动。
3. **弹窗打开时会话页停读**，关上时重读一次再接着读。
