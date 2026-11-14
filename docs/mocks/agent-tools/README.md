# Agent Tools · 设计板（P1-03）

任务 P1-03：在 Web / macOS 的会话和工作区设置里加一个只读的 **Agent tools** 入口，显示本会话 Orbit MCP 的实际连接状态和不可用原因、contract / catalogue 版本、可用的工具族、权限模式对 Orbit 调用的含义、编排开关实际放开的范围、agent 读到的指令的来源和顺序；下半部分是由 operation catalogue 生成的用法说明和四个示例。

| 板 | 内容 |
| --- | --- |
| [`01-board.png`](01-board.png) | ① 会话 More actions 入口（带状态点）② 会话抽屉·已连接（Claude Code）③ 会话抽屉·未连接 + 编排关（Codex）④ 工作区设置的新行 + 工作区模式抽屉（含四个示例）⑤ macOS sheet；右侧是数据来源、不做什么、待拍板的 D1–D3 |

## 怎么做的

- 手绘 HTML（[`01-board.html`](01-board.html)），颜色和尺寸取自 `src/web/src/index.css` 的 `:root` 与 `src/web/src/components/settings/Settings.css`。
- 工具数是本机 `orbit mcp` 的 `tools/list` 实测（编排开 102 个、关 80 个，不算 Claude 的 `permission_prompt` 桥）；引擎版本是本机装的 Claude Code 2.1.325 和 Codex 0.167.2；版本号写的是本任务要升到的目标值。
- 渲染：`chromium --headless=new --dump-dom` 读 `SIZE WxH`，再用 `--window-size=W,H --force-device-scale-factor=2 --screenshot` 拍；Inter 字体从本机 `@fontsource/inter` 读（不在仓库里）。
