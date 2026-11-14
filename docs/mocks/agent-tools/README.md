# Agent Tools · 设计板（P1-03）

任务 P1-03：在 Web / macOS 的会话和工作区设置里加一个只读的 **Agent tools** 入口，显示本会话 Orbit MCP 的实际连接状态和不可用原因、contract / catalogue 版本、可用的工具族、权限模式对 Orbit 调用的含义、编排开关实际放开的范围、agent 读到的指令的来源和顺序；下半部分是由 operation catalogue 生成的用法说明和四个示例。owner 2026-11-14 批复：Build as drawn（D1–D3 按推荐）。

| 板 / 截图 | 内容 |
| --- | --- |
| [`01-board.png`](01-board.png) | 设计稿：① 会话 More actions 入口（带状态点）② 会话抽屉·已连接（Claude Code）③ 会话抽屉·未连接 + 编排关（Codex）④ 工作区设置的新行 + 工作区模式抽屉（含四个示例）⑤ macOS sheet；右侧是数据来源、不做什么、待拍板的 D1–D3 |
| [`02-web-session-connected.png`](02-web-session-connected.png) | 实现：真组件 `AgentToolsDrawer`，会话模式，Claude Code 已连接、编排开、Default 模式 |
| [`03-web-session-not-connected.png`](03-web-session-not-connected.png) | 实现：会话模式，Codex 未连接（引擎原话）、Wiki 与编排关、Plan 模式 |
| [`04-web-workspace.png`](04-web-workspace.png) | 实现：工作区模式，Claude Code 一栏，四个示例展开 |

## 和设计稿不一样的地方（实测后改的）

- **Claude Code 的指令顺序**：设计稿把 MCP 服务器说明和 CLAUDE.md 画在用户消息之前。2026-11-14 用本地录制桩抓了 Claude Code 2.1.325 自己发出的请求：`--append-system-prompt`（工作区的、再 Orbit 的）拼在系统提示末尾；CLAUDE.md 是第一条用户消息顶部的提醒；MCP 服务器说明和 skill 列表在用户消息**之后**的一条 system 消息里。实现按实测顺序画（`docs/orbit-agent-contract.md` §2.7）。
- **Codex 的顺序**：同法抓 Codex 0.167.2：基础指令（developer）→ skill 列表 → AGENTS.md（user）→ 工作区运行时指令 → Orbit 运行时指令（都是 developer）→ 用户消息；MCP 说明随工具列表。实现按此。
- **工具族**：按 catalogue 的对象分 12 族，编排门控的 22 个工具单独一族（数字与设计稿手数的略有出入，以 catalogue 为准）。
- **“How agents use Orbit” 旁的小字**：设计稿写 “Guide 1.1.0”，与状态卡里 agent 用的路由指南版本重复，改成 “generated from the operation catalogue”。

## 怎么做的

- 设计稿：手绘 HTML（[`01-board.html`](01-board.html)），颜色和尺寸取自 `src/web/src/index.css` 的 `:root` 与 `src/web/src/components/settings/Settings.css`；`chromium --headless=new --dump-dom` 读 `SIZE WxH`，再 `--force-device-scale-factor=2 --screenshot` 拍。
- 实现截图：`src/web/tmp/`（git 忽略）下的探针挂真组件 `AgentToolsDrawer`，报告夹具按 runner 的 `agent_tools` 事件形状写，vite 起服务、playwright-core 驱动系统 Chromium 以 2x 拍抽屉本身。
- 工具数是本机 `orbit mcp` 的 `tools/list` 实测（编排开 102 个、关 80 个，不算 Claude 的 `permission_prompt` 桥）；引擎版本是本机装的 Claude Code 2.1.325 和 Codex 0.167.2；其余是演示数据。
