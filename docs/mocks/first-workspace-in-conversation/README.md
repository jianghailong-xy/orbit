# 没有 workspace 的机器：在对话里建第一个 workspace · 设计板

所有者 2026-10-31 让我评估 runner **orbit@austin**：它当天刚注册，在线，装了 Claude Code 和 Codex，两个都没登录，一个 workspace 都没有。要回答两件事：没有 workspace 时这台机器能不能用；从产品角度，怎么引导用户通过对话框创建 workspace。

评估结论：

- 四个客户端都没有入口能在这台机器上开会话。
- 只有 web 能建 workspace，入口是机器页往下滚到 Add workspace 的表单。
- iPhone、Mac 和 Android 只说 “on the web”。
- 什么都跑不了的机器，在任何地方都不算 needs you。

我推荐的做法：新会话页就是入口，设置卡只问文件夹和登录两件事，用户发出第一条消息时把 workspace 一起建出来。所有者回复「按推荐先出一版效果图」。

界面文案全部英文；板上的说明是中文。剩下四项（见 04）定了之后再改代码。

| 板 | 内容 |
| --- | --- |
| [`01-web-flow.png`](01-web-flow.png) | 今天的路（落地页、创建表单、没人走得到的机器草稿页）和方案的主流程（落地 → 消息先等着 → 就绪 → 已开始） |
| [`02-web-entries.png`](02-web-entries.png) | 入口（批准页、Add a runner）、提醒（机器页、Settings、侧边栏），以及设置卡的边界状态（注册目录是 `~`、路径不存在、不是 git 仓库、机器离线） |
| [`03-iphone.png`](03-iphone.png) | iPhone 今天和方案对比（抽屉、机器页、草稿、已开始）；Mac 和 Android 的规则写在板上 |
| [`04-rules.png`](04-rules.png) | 已定的项、13 条规则、各层改动清单、分期（P0 / P1 / P1b / P2）、待你定 |

**按推荐已定的项：**

- 在对话里建，不做弹窗。
- 注册目录只当建议。
- 「最近工作过的目录」先不扫。
- `agent_create` 以后要先出确认卡。

**待定的四项**（推荐都是 A）：

1. P0 是否先单独上。
2. 新文件夹放在 `~/orbit-repos/<name>`。
3. 隔离默认关。
4. 原生端在 web 之后上。

## 怎么做的

- **Web 帧是真实页面截图。**
  - 用 HEAD 516f26d70 的 `src/web` 和 `src/shared` 跑 vite，接 `src/web/ui-migration` 的 fixtures，再加 [`capture/data.mjs`](capture/data.mjs) 的示例数据。示例数据里的 orbit@austin 就是 2026-10-31 `runner_list` 报告的状态。
  - 「方案」帧用的是同一份代码打上 [`capture/prototype.patch`](capture/prototype.patch) 之后的树。补丁只为出图，改了 10 个文件：新增 `MachineSetupCard.tsx`；改了 `WorkspaceView`、`TasksSidePanel`、`App`、`EnrollPage`、`RunnerRegisterGuide`、`RunnerDetailPage`、`runnerAttention`、`SettingsPage` 和 `index.css`。
  - 补丁需要的服务端字段 `registerDir`、`homeDir` 和接口 `/runners/:id/probe-dir` 目前只在示例数据里有，服务端还没写。
- **两处是 DOM 注入的**：p-progress 里等着的消息气泡，p-started 里「Created workspace …」那一行。其余都是补丁画出来的。
- **iPhone 板是手画的。** 结构取自 `CompactShell.swift`、`SkillsRunnersView.swift`、`RunnerPageCopy.swift` 和 `AgentsView.swift`；字号、颜色和间距沿用 `../ios-drawer-status-column.html` 和 `../composer-card-ios.html` 的实测值。
- **重新截图**：kit 在 `/var/tmp/first-ws-mock/`，里面有 `today/` 和 `new/` 两棵树，`node_modules` 是用 `cp -al` 从一个锁文件一致的 worktree 拷来的。命令：

  ```bash
  unshare -n ./run-ns.sh /var/tmp/first-ws-mock/today capture.mjs [scene …]
  unshare -n ./run-ns.sh /var/tmp/first-ws-mock/new capture.mjs [scene …]
  ```

  场景名是 `t-*`、`p-*`、`e-*`。元素位置写进 `marks.json`。
- **重画板子**：先跑 `python3 -I gen.py <out>`，生成 01、02 和 `frames/`；再对每张板跑 `node render.mjs <board.html>`，渲染成 2x PNG。03 和 04 是手写的 HTML，共用 `board.css`。
