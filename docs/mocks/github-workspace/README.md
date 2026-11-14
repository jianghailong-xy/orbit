# 从 GitHub 仓库建 workspace · 设计板

所有者 2026-11-11 要求：支持连接用户的 GitHub，并从 GitHub 上的仓库建 workspace。方案按推荐定下（GitHub App；agent 不能直接拿 token push；托管和自托管 runner 都支持；v1 就支持私有仓库），然后先出这一版设计图。设计文档：[`docs/github-workspace-design.md`](../../github-workspace-design.md)。

界面文案全部英文；板上的说明是中文。

| 板 | 内容 |
| --- | --- |
| [`01-web-setup-card.png`](01-web-setup-card.png) | 今天的 Folder 步骤和它的问题；方案 P1–P4（未连接 → 搜索仓库 → 选中 → 就绪）；P5 会话第一行（cloning / done / 三种失败）；没画成帧的边界状态 |
| [`02-web-settings.png`](02-web-settings.png) | 用户：Settings → Integrations 加一行 GitHub，Manage 页（账号、App 装在哪、哪些 workspace 来自 GitHub）；管理员：Integrations 加 GitHub App 卡片和在 GitHub 上注册 App 的步骤 |
| [`03-rules.png`](03-rules.png) | 已定的项、10 条规则、各层改动清单、分期（P0 / P1 / P1r / P2 / P3）、待你定 |

**界面细节四项**：2026-11-11 所有者定为都按推荐（A），01 和 02 画的就是 A。

1. From GitHub 放在「A new folder」和「Another folder」之间。
2. 分支默认用默认分支，点 *Other branch* 才展开。
3. clone 进度显示进度条加百分比。
4. Settings 里列出 "Workspaces from GitHub"，并写明每个用哪种凭据。

## 怎么做的

- **帧是手写的 DOM，但用的是 app 自己的样式表**：每张板直接 `<link>` 引入 `src/web/src/index.css`、`components/ui/*.css` 和 `MachineSetupCard.css`，类名照抄组件（`msc-*`、`orbit-radio`、`orbit-card`、`admin-signin-*`）。所以颜色、间距和字号就是今天 Web 的样子。
- 新的控件（仓库选择器、clone 进度行）用 `board.css` 末尾的 `ghp-*` 和 `conv-*` 样式画，取值沿用 app 的 token（`--bg-raised`、`--border`、`--brand` 等）。
- 图标来自 `@ant-design/icons-svg`（app 用的同一套），由 `icons.js` 把 `<i data-ic>` 换成 SVG。
- 01 的「今天」帧照 HEAD `10d2f6649` 的 `MachineSetupCard.tsx` 和 `machineSetupCopy.ts` 手写，文案一字不改。
- **重画**：`node capture/render.mjs <绝对路径/板.html>` 输出 2x PNG。需要 Playwright 1.63（脚本里写的是 `/mnt/data/tmp/lt-mock/node_modules`，换成任何一份都行），以及 Inter、Noto Sans SC、JetBrains Mono 三个字体文件（放在脚本里 `fonts` 指向的目录）。
