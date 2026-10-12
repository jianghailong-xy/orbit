# P2.1 第二版：抽屉分隔线与一致状态对照

> **证据瘦身（2026-10-07）**：完整原件见提交 `7732f14f82d4e6b4406d7d164c4b672f63aa0f56`（瘦身前最后一个含完整文件的提交）。取回单个文件用 `git show 7732f14f82d4e6b4406d7d164c4b672f63aa0f56:docs/evidence/base-ui-migration/p2.1/revision-2/<路径> > <文件>`，整个目录用 `git archive 7732f14f82d4e6b4406d7d164c4b672f63aa0f56 docs/evidence/base-ui-migration/p2.1/revision-2 | tar -x -C <空目录>`。
>
> 本目录在瘦身中：5 份 Playwright 报告换成同目录的 `report.summary.json`，都只删附件正文；98 个逐用例 JSON（含打包的 attachments.tar.gz）换成所在目录的 `attachments.summary.json`（文件名、字节数、SHA-256 和顶层标量字段）；删除 31 张与本任务目录里保留副本逐字节相同的重复截图。下文链接若指向这些文件，按上面的命令从该提交取回；读取它们的脚本要在取回的目录里运行。
>
> 目录里的 SHA256SUMS 类清单（`*.sha256`、`artifact-index*.json`、`manifest.json`、各运行 `summary.json` 里的附件哈希等）保留原文件，核验的是提交 `7732f14f8` 里的文件。做法、保留理由和逐文件删除清单见 [evidence-slimming](../../evidence-slimming/README.md)。

任务 `34Za393HPMLVyuXAdfv3j`，项目验收 key `1BvO6hYrlFnU60JqxQPUHt`，原文：**P2：Orbit 自有弹层、选择及反馈组件保持现有键盘、焦点、通知和确认行为。** 本任务仍只承担弹窗、抽屉、确认和共存基础。原实现为 `9429c189f604251685b26c0329b5dd31e7014b05`，本次修复为 `e3f53d40246c005aac7c3e1060f0734d38afbb47`。

此版回应[第一版独立验收 SEND_BACK](send-back.json)，保留[第一版实现/行为说明](../README.md)、全部原始证据和验收者的[复核日志](reviewer-checks/)。返修只修改抽屉局部分隔线变量、外观对照测试及其 fixture；Dialog/Drawer/Confirm 的交互实现未改。没有业务路由、REST/SSE、全局配色、依赖或历史基线变更。

## 修复及新增检查

原 `--border-subtle` 在暗色 elevated 表面上与背景同色，确实使标题底边/footer 顶边消失。现在两处均使用 `--orbit-border-split`，值取自真实安装的 AntD 6.6.5 Drawer 的计算样式：

| 主题 | 标题底边 / footer 顶边 | 宽度 / 线型 | PNG 分隔线中心 RGB |
| --- | --- | --- | --- |
| light | `rgba(17, 42, 80, 0.08)` | `1px solid` | `(236, 238, 241)` |
| dark | `rgba(223, 223, 226, 0.05)` | `1px solid` | `(60, 60, 64)` |

新增检查通过旧组件公开的 `classNames` 定位 header/footer，严格比较新旧 border color/width/style。运行在修复前确实失败，见[修复前报告](diagnostics/separator-before-fix/report.json)及 `checks/reproduce-separator-color.*`：WebKit 暗色桌面与 Chromium 亮色手机都捕获到计算颜色不一致。此前两次采样代码调试分别遇到不可聚焦的 Drawer section、关闭后仍保留的旧 root；相应失败报告保留在 `diagnostics/focus-sampling/` 和 `diagnostics/retained-drawer-root/`，不算有效产品复现。最终用公开 `rootClassName` 与实际打开的 dialog 关联，未查询 `.ant-*`。

第一版“严格相等”只检查了 root/控件几何等属性，**没有证明分隔线一致**。本版补齐该缺口，不沿用这一不完整结论。

默认截图现在将鼠标移到 `(0,0)`，聚焦双方各自的非控件容器，并等待有限动画/过渡结束；逐个断言按钮及输入框的 hover/focus/focus-visible 均为 false。输入框另记录边框和阴影。原本一灰一蓝的手机图是采样状态不同，本次没有更改产品默认焦点逻辑来配合截图。

底部抽屉另保留独立 hover、focus 两组截图及状态断言；双方的状态和样式严格相等：

| 输入状态 | light 边框 | dark 边框 | 检查 |
| --- | --- | --- | --- |
| neutral | `rgb(222, 224, 227)` | `rgb(66, 66, 70)` | 未 hover、未 focus、无 focus-visible |
| hover | `rgb(92, 146, 255)` | `rgb(85, 133, 232)` | hover、未 focus |
| focus | `rgb(51, 112, 255)` | `rgb(46, 98, 220)` | 未 hover、focus、focus-visible；2px 阴影 |

原有关闭、Tab/Esc、默认进入/返回焦点、触摸、新旧嵌套、portal 主题/层级、滚动锁、IME composition、异步 pending/失败/重试/防重/卸载/连续确认用例全部保留。外观用例的状态控制不替代这些真实交互检查。

## 本次运行及截图

固定环境沿用 P0/P1：Debian 13.7、Node26.10.0、Playwright1.63.0、Chromium1243/WebKit2359、固定字体哈希、DPR1、UTC/en-US，桌面1280×900/手机390×844、明暗主题共八组合。环境校验见 [environment.json](overlays-run/environment.json)。无重试，没有更新基线或降低断言。

| 验证 | 本次结果 | 直接记录 |
| --- | --- | --- |
| 完整弹层矩阵 | 96/96，0 skipped/flaky/unexpected | [summary](overlays-run/summary.json)、[原始报告](overlays-run/report.json) |
| 相关基础控件回归 | 24/24，0 skipped/flaky/unexpected | [原始报告](controls-regression/report.json) |
| 组件边界与主题 | 6/6 | [日志](checks/boundary-and-theme.txt) |
| fixture 独立类型检查 | 通过 | [日志](checks/fixture-types.txt) |
| Web 类型检查/生产构建 | 通过；保留原有大 chunk 提示 | [日志](checks/web-build.txt) |
| 证据/基线核对 | 新256份附件、旧224份附件哈希均一致；原252张基线与起点提交逐字节一致 | [audit.json](audit.json) |

最终矩阵新增32张独立 hover/focus 图，共保存160张原始 PNG、96份测量/行为 JSON。collector 为每份附件记录 SHA-256。八组合的分隔线计算值、输入状态可直接查看 [audit.json](audit.json) 的 `appearance`，完整 root/控件数据在各组合的 `--appearance.json` 中。

代表性原始图：

- 暗色桌面底部抽屉：[AntD](overlays-run/webkit-dark-desktop--dialog-and-drawers-match-current-surfaces-geometry-typography-and-actions--AntD-bottom-drawer.png)、[Orbit](overlays-run/webkit-dark-desktop--dialog-and-drawers-match-current-surfaces-geometry-typography-and-actions--Orbit-bottom-drawer.png)。两图像素完全一致；原消失的 y=56/y=329 分隔线均恢复。
- 亮色手机默认：[AntD](overlays-run/chromium-light-phone--dialog-and-drawers-match-current-surfaces-geometry-typography-and-actions--AntD-bottom-drawer.png)、[Orbit](overlays-run/chromium-light-phone--dialog-and-drawers-match-current-surfaces-geometry-typography-and-actions--Orbit-bottom-drawer.png)。双方都是灰色输入边框。
- 亮色手机 hover：[AntD](overlays-run/chromium-light-phone--dialog-and-drawers-match-current-surfaces-geometry-typography-and-actions--AntD-bottom-drawer-input-hover.png)、[Orbit](overlays-run/chromium-light-phone--dialog-and-drawers-match-current-surfaces-geometry-typography-and-actions--Orbit-bottom-drawer-input-hover.png)；focus：[AntD](overlays-run/chromium-light-phone--dialog-and-drawers-match-current-surfaces-geometry-typography-and-actions--AntD-bottom-drawer-input-focus.png)、[Orbit](overlays-run/chromium-light-phone--dialog-and-drawers-match-current-surfaces-geometry-typography-and-actions--Orbit-bottom-drawer-input-focus.png)。

## 残余像素差异

[analyze-pixels.py](analyze-pixels.py) 使用 Pillow12.3.0 读取每张原始 PNG 的全部 RGBA 像素，未缩放、编辑、屏蔽或引入容差。[逐对结果](pixel-comparison.json)保留差异数量、边界、行分布、颜色变化和分隔线行。48对图中18对完全一致，合计767个不同像素；32对抽屉图的64条分隔线整行均为0差异。WebKit 的所有抽屉对照图完全一致。

剩余763个像素落在记录几何的圆角区域：按钮360、输入框291、弹层外缘112。输入框的亚像素坐标按像素方格与 CSS 圆角区域相交归类，没有把这些像素从比较中排除。控件圆角最大通道差为3，弹层圆角最大为4；例如 Chromium 亮色 confirm 仅左上 `(0,8)`、`(0,9)` 两点不同。没有残余整行分隔线、直边或成片蓝色输入边框差异。

另4个像素明确保留为 `outsideRoundedEdgePixels`：Chromium 手机明/暗 focus 图各在 `(64,95)`、`(64,96)` 两点，相当于输入框上方2px焦点阴影覆盖标签下沿的位置。默认图该处双方相同（light RGB131/133/136，dark RGB141/144/149）；聚焦后只有1级通道差，light 为123/132/143与124/132/143，dark 为94/115/160与95/116/160。双方阴影计算值相同，分别为 `rgba(5,122,255,.06)`、`rgba(1,58,182,.33)`，无 blur、spread2px。

这些位置、相等的几何/状态/计算样式及低通道差，与圆角栅格化和半透明阴影合成的取整差异吻合；这是基于证据的解释，不是浏览器底层实现的证明，也不等于所有位图逐像素相同。原图和全部差异保留给独立验收，没有将其加入截图豁免规则。

## 复跑与边界

从仓库根复跑（使用既有依赖准备流程和固定浏览器环境）：

```sh
npm run test:ui-overlays -w @orbit/web
npm run test:ui-controls -w @orbit/web
npm test -w @orbit/web -- src/lib/theme.test.tsx src/components/ui/boundary.test.ts
node node_modules/typescript/bin/tsc -p src/web/ui-migration/overlays.tsconfig.json --noEmit
npm run build -w @orbit/web
node src/web/ui-migration/collect-overlay-evidence.mjs /tmp/new-p21-overlay-evidence
python3 docs/evidence/base-ui-migration/p2.1/revision-2/analyze-pixels.py /tmp/new-p21-overlay-evidence /tmp/new-p21-pixels.json
python3 docs/evidence/base-ui-migration/p2.1/revision-2/audit-evidence.py
```

[checks](checks/) 保存真实 argv、起点、时间、退出码及原始日志；[调用编号](checks/tool-call-refs.json)来自本任务已有运行记录。浏览器检查在提交前、同一份源码上执行，audit 核对了工作区与实现提交的字节；没有声称提交后又重复运行浏览器矩阵。

本次没有重跑 P0 或完整 Vitest/48项 foundation 矩阵，第一版相应记录仍保留。P0 的8项截图失败已在未修改起点 `297d33e97729c66ebdc8f2b63b0e094db1d9e8df` 复现，8对实际图字节相同，独立验收已确认与本任务无关；16项原有预期失败和11项原有跳过也未改变。**P0 不能称为全绿**，本任务未修复或覆盖这些旧问题。

手机是浏览器设备模拟，未确立真机 iOS 软键盘/触摸滚动、原生输入法或真实后端错误链路；本矩阵用固定拦截响应验证异步行为。手机 WebKit 的滚动锁继续用 PageDown，触摸关闭另用 touchscreen.tap。业务页面批量替换、未声明拥有关系的兄弟弹层、任意第三方组合及 P2.2 选择/P2.3 通知均不在本版完成主张内。第二版仍需独立验收；未调用验收决定接口、未直接写 DONE、未部署或发布。
