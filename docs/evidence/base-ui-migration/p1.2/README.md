# P1.2 基础控件与状态样例

> **证据瘦身（2026-10-07）**：完整原件见提交 `7732f14f82d4e6b4406d7d164c4b672f63aa0f56`（瘦身前最后一个含完整文件的提交）。取回单个文件用 `git show 7732f14f82d4e6b4406d7d164c4b672f63aa0f56:docs/evidence/base-ui-migration/p1.2/<路径> > <文件>`，整个目录用 `git archive 7732f14f82d4e6b4406d7d164c4b672f63aa0f56 docs/evidence/base-ui-migration/p1.2 | tar -x -C <空目录>`。
>
> 本目录在瘦身中：6 份 Playwright 报告换成同目录的 `report.summary.json`，都只删附件正文；185 个逐用例 JSON（含打包的 attachments.tar.gz）换成所在目录的 `attachments.summary.json`（文件名、字节数、SHA-256 和顶层标量字段）；删除 25 张与本任务目录里保留副本逐字节相同的重复截图。下文链接若指向这些文件，按上面的命令从该提交取回；读取它们的脚本要在取回的目录里运行。
>
> 目录里的 SHA256SUMS 类清单（`*.sha256`、`artifact-index*.json`、`manifest.json`、各运行 `summary.json` 里的附件哈希等）保留原文件，核验的是提交 `7732f14f8` 里的文件。做法、保留理由和逐文件删除清单见 [evidence-slimming](../evidence-slimming/README.md)。

服务于 [P1.2 实现 Orbit 基础控件与状态样例](orbit-task:34Za391ERoVi0sWSzRhvD)。起点 `5bea0a3f6` 已包含 P0、P1.1 与依赖准备修复。开工读取完整任务、历史评论（空）、项目目标/作业指导/验收、前置任务历史及 P0/P1.1 交付。项目验收原文：**P1：Orbit 公共基础组件使用现有设计变量与主题机制，呈现与当前控件基准一致。** 本任务完成基础控件子范围。

## 交付与范围

`src/web/src/components/ui/` 增加 Button、Input、Textarea、Checkbox、Radio/RadioGroup、Switch、Badge、Spinner；Button 文件另提供保持原生链接语义的 LinkButton。Button/选择控件封装已锁定的 Base UI 1.8.0；文本字段、标签与加载图形采用原生 HTML，图标沿用 @ant-design/icons。组件只导入自己的局部 CSS，复用已有 surface/text/border/主题机制；foundation.css 只补足实测交互色和标签色变量，没有新增全局 reset 或业务选择器。

[使用约定](../../../../src/web/src/components/ui/README.md) 记录原生 type/ref、尺寸与变体、标签命名、状态/表单值边界。Checkbox/Radio/Switch 的既有调用是受控的，公共 API 要求 checked/value；父表单负责重置其受控值，不提供未使用的 uncontrolled defaults。Input 保留前后缀、装饰区点击聚焦、原生 value/onChange/readOnly/disabled/invalid；Textarea 保留原生 rows、选区和尺寸拖拽，自动增高留给 P3.1。Badge 是清单中 Tag 的替代，并非计数徽标。

本次没有迁移业务调用、路由、接口或主题 Provider，没有安装或修改依赖锁文件。原有生产页面继续使用原实现；完整业务替换由后续任务承担，因此不作 antd 运行时已移除或包体积已下降的主张。

## 可复现状态对照

新入口 [controls.html](../../../../src/web/ui-migration/controls.html) 仅供开发验证，无业务路由或生产入口。固定样例并排渲染真实 Orbit 控件和安装版本的 AntD，二者共享现有主题/字体/reset，单页只渲染一种主题，避免主题缓存互相覆盖。

环境由原 P0 environment.mjs 强制校验：Linux x64 / Debian 13.7、Playwright 1.63.0、Chromium 1243、WebKit 2359、相同字体文件 SHA-256、DPR 1、UTC/en-US；视口 1280×900 与 390×844，light/dark 共八个组合。本次 Node 26.10.0。固定测试不依赖真实账号或接口。

48 个状态样例包括：

- Button 三种尺寸、default/primary/text/link、危险按钮、图标与纯图标、各类禁用和加载。
- Input 三种尺寸、前后缀、禁用/错误；Textarea 默认、禁用/错误和固定行数。
- Checkbox 未选/选中/mixed/禁用；Radio 普通及两种尺寸的按钮组；Switch 两种尺寸、关闭、禁用、加载。
- Badge 六种现有状态色与图标；Spinner 两种实际尺寸。

每个组合保留真实 PNG、计算样式与内容几何：尺寸、字体/行高、字色/背景、padding、边框/圆角、阴影、文本基线相对位置、图标布局、勾选/圆点图形与滑块位置。整数/颜色/字体等严格相等，浮点几何只容纳浏览器一格布局子像素（1/64px）；不使用截图差异阈值隐藏变化。旋转图标比较固定图标框和 SVG 布局尺寸，避免把两个时间点的旋转外接矩形当成布局变化。Spinner 另比较四点尺寸、旋转/脉冲时长、延迟、循环与方向；保留原 AntSpin 在 reduced-motion 下仍运动的现状。主按钮颜色/32px高度/6px圆角同时对照不可变 P0 数据。

实测保留的局部差异：大号按钮行高 25.1429px；手机普通 Input/Textarea 字号16px、行高25.1429px，带前后缀输入仍14px/22px，大号输入16px/24px；小号手机普通输入高度随原字号规则变化；Tag 默认是透明边框的填充标签。没有用统一理想尺寸覆盖这些现状。

## 验证结果与证据

从仓库根复跑：

```sh
bash scripts/worktree-overlay.sh
npm run test:ui-controls -w @orbit/web
node node_modules/typescript/bin/tsc -p src/web/ui-migration/controls.tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p src/web/ui-migration/foundation.tsconfig.json --noEmit
npm test -w @orbit/web -- src/lib/theme.test.tsx src/components/ui/boundary.test.ts
npm run build -w @orbit/web
npm run test -w @orbit/web
npm run test:ui-foundation -w @orbit/web
npm run test:ui-migration -w @orbit/web
```

- 控件最终矩阵：**24 项全部通过**，0 skipped/flaky/unexpected；每组合197项样式/几何/动画记录，差异0。保存16张真实PNG和24份JSON附件，见 [controls-run/summary.json](controls-run/summary.json)、[原始报告](controls-run/report.json) 与 [命令输出](checks/controls-browser.txt)。
- 可见行为：Enter/Space 激活、Tab跳过禁用按钮、loading保留焦点并阻止鼠标及键盘重复提交；标签和Space切换Checkbox、mixed可访问状态；Radio箭头跳过禁用项并移动焦点；Switch键盘和loading禁用；真实FormData包含选择值并排除禁用字段；原生文本字段reset；外部htmlFor标签与显式可访问名称；Input前缀点击聚焦并输入；LinkButton以Enter执行原生锚点导航。
- 原主题与嵌套弹层回归：**48项全部通过**。覆盖system/light/dark、真实首屏脚本、账号fixture同步、主题连续性、body/nested portal、Tab/Esc/焦点归还。见 [foundation-run/summary.json](foundation-run/summary.json)。
- 原生产页面矩阵：**77普通通过、16已知焦点预期失败、11原有范围跳过、0意外失败**。原252张PNG仍为零像素比较，SHA-256全部未变，见 [p0-regression/summary.json](p0-regression/summary.json) 和 [hash核对](checks/baseline-screenshot-hashes.json)。命令的93 passed包含16个expected failure，不能简称为全部功能通过。
- 完整Vitest：**292文件、3563用例通过**；与当前起点的原套件一致。本任务把新增真实交互验证放在浏览器入口，没有增加实现镜像单测。主题/公共导入边界6项定向检查通过，新增fixture与既有主题测试单独类型检查通过，Web构建通过。完整单测后仅新控件/样例发生复核修正，最终对这些变更运行了完整控件矩阵、定向边界、单独类型检查和构建；不把较早单测称为最终提交上重新执行过。

[checks](checks/) 保存每条命令、退出码、时长和原始输出。构建仍提示原有大chunk。原始日志与报告没有为了通过whitespace检查改写；源码和手写说明的 `git diff --check` 通过。

## 诊断与证据边界

首次依赖准备已按锁文件隔离安装；Prisma缓存只读导致准备失败，改用 `/tmp/orbit-p12-cache` 并复制既有缓存后恢复，没有写主工作区/共享依赖。最初本地监听受沙箱限制，获准执行浏览器检查后运行正常。

浏览器/审查实际修复了：Radio按钮组文字低6/10px、Switch禁用滑块阴影缺失、Checkbox/Radio空标签遮蔽外部名称、显式aria-label被子文字拼接、禁用text/link按钮边框/背景优先级、danger按钮禁用hover、Input条件装饰为空时仍产生外壳。初次图标旋转外接矩形检查改为固定图标框/布局尺寸，保留所有可见几何约束。较早24项通过的结果没有测出Spinner的reduced-motion差异，后续人工复核恢复原行为并加入动画断言后重新运行24项；较早报告仅为 [诊断记录](diagnostics/pre-spinner-motion/report.json)。Radio/滑块修正前报告和代表图在 [diagnostics](diagnostics/)，没有更改P0历史基线、删断言或用重试掩盖失败。

本次证据不确立自动增高/会话IME、统一弹层实现、真机iOS软键盘/触摸、真实后端或跨设备同步；这些仍按P2/P3/P5任务范围交付。P0两项分享焦点缺陷、项目图裁切/重叠保持原样。没有部署、发布或独立审核自身证据。公共基础控件的本任务范围没有已知未完成项。

以本任务独立提交整体回退即可撤销控件/局部样式/验证入口；没有持久化数据或接口变更。
