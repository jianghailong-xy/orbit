# P1.1 Base UI 与 Orbit 主题基础

> **证据瘦身（2026-10-07）**：完整原件见提交 `7732f14f82d4e6b4406d7d164c4b672f63aa0f56`（瘦身前最后一个含完整文件的提交）。取回单个文件用 `git show 7732f14f82d4e6b4406d7d164c4b672f63aa0f56:docs/evidence/base-ui-migration/p1.1/<路径> > <文件>`，整个目录用 `git archive 7732f14f82d4e6b4406d7d164c4b672f63aa0f56 docs/evidence/base-ui-migration/p1.1 | tar -x -C <空目录>`。
>
> 本目录在瘦身中：3 份 Playwright 报告换成同目录的 `report.summary.json`，另有 1 份其他文件名的报告换成 `<原名>.summary.json`，都只删附件正文；209 个逐用例 JSON（含打包的 attachments.tar.gz）换成所在目录的 `attachments.summary.json`（文件名、字节数、SHA-256 和顶层标量字段）；删除 68 张与本任务目录里保留副本逐字节相同的重复截图。下文链接若指向这些文件，按上面的命令从该提交取回；读取它们的脚本要在取回的目录里运行。
>
> 目录里的 SHA256SUMS 类清单（`*.sha256`、`artifact-index*.json`、`manifest.json`、各运行 `summary.json` 里的附件哈希等）保留原文件，核验的是提交 `7732f14f8` 里的文件。做法、保留理由和逐文件删除清单见 [evidence-slimming](../evidence-slimming/README.md)。

服务于 [P1.1 接入 Base UI 与 Orbit 主题基础](orbit-task:34Za38yCyTgCjo2t8Bmi4)，起点为 `6bbf3ecc3`（项目分支已有 P0 交付）。开工读取了完整任务、历史评论（空）、项目目标/作业指导/验收以及 P0.1/P0.2 交付。项目 P1 原文：**P1：Orbit 公共基础组件使用现有设计变量与主题机制，呈现与当前控件基准一致。** 本任务负责依赖与主题基础；完整基础控件及状态矩阵由 P1.2 继续交付。

## 依赖与生产改动

2026-10-04（Asia/Shanghai）核实 [Base UI 官方 1.8.0 发布记录](https://base-ui.com/react/overview/releases/v1-8-0) 与 npm registry 的 latest：`@base-ui/react@1.8.0`，正式版本，发布于 2026-09-04。其 React/ReactDOM peer 支持 17/18/19，适用于当前 React 19.3.0；日期库 peer 是 optional，本次没有引入日期控件。registry 原始版本/完整性信息见 [base-ui-version.json](base-ui-version.json)。Web manifest 精确锁定 `1.8.0`，根 lockfile 保留 tarball 与完整性 hash。

锁文件只添加 Base UI 所需的 7 个新包记录与 Web 依赖项；历史包版本/记录没有变动或删除，见 [lockfile-delta.json](lockfile-delta.json)。第一次 npm install 对 lockfile 做了与本任务无关的排序/平台包清理，保留安装得到的新依赖记录并恢复其余历史条目后，使用 `npm ci --ignore-scripts --no-audit --no-fund` 干净安装验证成功。没有升级或删除 antd 6.6.5、独立图标或其他既有依赖。

生产入口只增加 `components/ui/foundation.css`：46 行纯变量，加载在原 reset 和 index.css 之后。`index.css`、`theme.ts`、`lib/theme.tsx`、`index.html` 字节未改；既有账号同步、缓存、系统监听、首屏脚本和 AntD Provider 继续工作。没有新增业务路由、第二个主题 Provider、全局 reset、layer 或应用根 stacking context。Base UI 的私有演示不进入生产构建，尚不声称减小了业务 JS 包体积。

[公共组件约定](../../../../src/web/src/components/ui/README.md) 定义直接导入边界、原生语义/ref、CSS 作用域及迁移责任；`boundary.test.ts` 对真实源码检查导入/重导出/动态导入/类型引用，阻止业务直接依赖 Base UI、生产引用私有 fixture、公共 ui 再耦合 antd。暂不导出临时 Button/Dialog，避免抢先确定 P1.2/P2 的公共 API。

## 实测变量来源

复用已有 surface/text/border/status 变量；控件专用变量以 P0.2 浏览器计算值补足，保留 darkAlgorithm 的实际输出。下表来自 `../p0.2/baseline-run/chromium-{light,dark}-desktop--task--computed-styles-and-timings.json`；主色 hover 来自对应 `--profile--computed-styles-and-timings.json` 的 `profile-validation` / Change password。

| 角色 | light | dark |
| --- | --- | --- |
| 主控件背景 | `#3370ff` | `#2e62dc` |
| 主控件 hover | `#5c92ff` | `#5585e8` |
| 主控件文字 | `#fff` | `#fff` |
| disabled 文字 | 黑 25% | 白 25% |
| disabled 背景 / text button hover | 黑 4% | 白 8% |
| disabled 边框 | `#d9d9d9` | `#5b5b6c` |
| focus outline | `3px solid #adceff`，offset 1px | `3px solid #1d305b`，offset 1px |
| elevated 表面 | `#fff` | `#343437` |

基础高度 32px、圆角 6px、文字 14px/22px、padding-inline 15px、gap 8px；小号 24px/4px/7px；popup 8px、dialog 实际表面 10px。三层 popup 阴影保留原偏移、扩散和透明度。手机任务头部 40px、小号 Save schedule 仍 24px、设置卡片 8px、开关 44×22px、分享链接 12.5px 等宽字体等例外仍由原页面规则承载，不用新变量全局覆盖。

## 验证与复现

环境与 P0 完全相同：Linux x64 / Debian 13.7、Node 26.10.0、npm 11.19.1、Playwright 1.63.0、Chromium 1243 / WebKit 2359、同字体文件 hash、DPR 1、UTC/en-US，视口 1280×900 与 390×844。每次浏览器入口执行 P0 的环境比较，未覆盖字体/浏览器基线。没有可用 Node 22，本次不声称在 Node 22 下验证。

从仓库根运行：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build -w @orbit/shared
npm run build -w @orbit/web
npm run test -w @orbit/web
node node_modules/typescript/bin/tsc -p src/web/ui-migration/foundation.tsconfig.json --noEmit
npm run test:ui-foundation -w @orbit/web
npm run test:ui-migration -w @orbit/web
```

依赖安装、构建和完整单测通过：**291 个测试文件、3553 个用例**。当前起点有 289 个测试文件，比 P0 报告的历史起点多 2 个；本次只新增 2 文件/6 用例。主题与边界的 6 个定向用例单独通过。默认 Web tsconfig 排除测试，新增 `foundation.tsconfig.json` 单独检查新增测试及 fixture 入口；其 typecheck 也通过。构建仍有原来的大 chunk 提示。

源码、配置和手写说明的 `git diff --check` 通过。原始命令输出及 Playwright 错误上下文保留工具产生的行尾空白/末尾空行，因此包含全部原始证据的 whitespace 检查会报告这些格式；未改写原始输出来消除报告。

生产页面入口 `test:ui-migration` 完整通过：**77 普通通过、16 已知焦点预期失败、11 原有范围跳过、0 意外失败**。252 张 P0 历史 PNG 的 hash 全部不变，比较仍为零像素容差且禁止更新。完整报告、计算样式、原生性能样本、截图 hash 和环境见 [p0-regression/summary.json](p0-regression/summary.json)，原始命令输出见 [checks/p0-browser-regression.txt](checks/p0-browser-regression.txt)。性能样本只归档，本次不作收益结论。

Foundation 最终完整矩阵 **48 项全部通过，0 跳过、0 重试、0 意外失败**，耗时约 1.4 分钟。保留 48 张真实浏览器 PNG、48 份 JSON 附件与原始报告，见 [foundation-run/summary.json](foundation-run/summary.json) 和 [原始命令输出](checks/foundation-browser.txt)。全部命令及退出码索引见 [checks/commands.json](checks/commands.json)。

Foundation 独立入口使用 Vite 开发服务器，不进入业务路由；P0 入口继续使用正式生产构建。新 fixture 的测试文件由独立配置发现，原 P0 测试集合仍是 104 项，未删除旧断言或更改基线。

Foundation 验证的直接内容：

- 新旧真实按钮的尺寸、字体、字色、背景、边框、圆角、padding、gap、阴影完全相等；覆盖默认、小号、disabled、hover、focus-visible，另读取不可变 P0 证据核对主色/尺寸。
- 原 `index.html` 首屏在应用代码执行前，缓存 system/light/dark 均显示正确 data-theme、theme-color、boot 颜色；加载应用后没有反向主题写入。账号与缓存相反时先显示缓存，再接收合成账号偏好；用户切换产生实际 PATCH 并更新本地缓存，显式模式忽略 OS，system 跟随 OS。
- 独立 body portal 和 AntD Modal 内的 Base dialog 均继承主题；实际命中测试证明嵌套表面在上方；Tab 访问两个按钮且留在弹窗内，Escape 保留外层并归还内层触发焦点，关闭外层后恢复外层触发焦点。
- 独立与嵌套弹窗的左右边界留在视口内，宽度不超过 520px 或可用视口；手机保留两侧 16px，避免固定宽度被隐式网格列撑开。

## 调试记录与边界

初次沙箱运行无法启动本地服务器，获得执行权限后恢复；记录保存在 checks。首轮样例修正了按钮 block padding 的误设（当前 AntD6 实测为 0）与焦点断言时序：Base UI 的 Tab 环绕先经过隐藏哨兵，下一帧完成归位，现在等待真实焦点到位并额外要求访问两个按钮。WebKit 打开内层前等待 AntD 外层入场完成。这些调整未放宽焦点预期、降低截图阈值或改变产品样式。

第一次原回归入口因通配符发现新开发 fixture，共152项，发现后取消并将两个入口分开；最终正式入口仍运行原104项。第一次 Foundation 全矩阵在 Chromium24项通过后遇到 WebKit 首屏截图超时：悬挂模块请求使文档/字体就绪一直待定。保留 [诊断报告](diagnostics/held-module-report.json) 与原命令输出；最终使用测试加载器先完成文档加载，再放行未经修改的真实 main 模块。没有跳过 WebKit、禁用字体等待或延长超时。

首次全绿矩阵后，人工读取手机嵌套截图发现新 fixture 的弹窗右侧裁切，旧断言只检查中心命中、主题和焦点，未验证边界。保留 [修正前全部附件](diagnostics/clipped-popup-run/summary.json)；将私有样例的隐式网格列改为 `minmax(0, 1fr)`，新增独立/嵌套弹窗的视口边界和实际宽度断言，再跑完整48项。最终 foundation-run 才是修正后的交付，未把较早的全绿报告当作视觉无误的证明。

本次只证明明示的 P1.1 基础范围。完整控件 API/交互/状态由 P1.2 交付；统一弹层层级、滚动锁、全部新旧嵌套组合、触摸和真实 iOS Safari 由 P2/P5 后续验证。账号接口是固定合成数据，未使用真实账号或证明跨设备后端同步。P0 的两项分享焦点缺陷、项目图裁切/重叠仍存在且未修复。无部署、发布或业务改版。

独立提交可按 P1.1 提交整体回退：入口、依赖、锁文件与新增变量/fixture 一起回退，随后按还原后的锁文件安装；本次没有改变其他页面或持久化数据。
