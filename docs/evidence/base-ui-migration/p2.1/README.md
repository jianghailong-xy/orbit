# P2.1 弹窗、抽屉与异步确认

> 此页为第一版交付记录；独立验收指出抽屉分隔线与截图状态对照缺口，已在[第二版返修证据](revision-2/README.md)修复并重新验证。以下历史报告、截图和原有 P0 失败记录保留原样；本次提交请以第二版为准。

服务于 [P2.1](orbit-task:34Za393HPMLVyuXAdfv3j)，起点为 `297d33e97729c66ebdc8f2b63b0e094db1d9e8df`，实现提交为 `9429c189f604251685b26c0329b5dd31e7014b05`。开工已读取任务完整信息、历史评论、项目目标/验收/作业指导及前置 P1.2 交付。项目验收原文（key `1BvO6hYrlFnU60JqxQPUHt`）：**P2：Orbit 自有弹层、选择及反馈组件保持现有键盘、焦点、通知和确认行为。** 本任务只承担其中弹窗、抽屉、确认和共存基础；选择/菜单、通知仍由 P2.2/P2.3 承担。

## 实现与使用边界

`src/web/src/components/ui/` 提供 Dialog、Drawer、ConfirmDialog 和局部 `useConfirm()`。交互封装已锁定的 Base UI 1.8.0 Dialog/AlertDialog，外观复用现有 CSS 变量、主题和 @ant-design/icons。业务不接触 Base UI 原语。只有两个实测抽屉阴影变量加入 foundation.css，其余样式限定在组件自身。公共实现和新增测试均不查询 `.ant-*`。

[组件使用约定](../../../../src/web/src/components/ui/README.md) 说明受控关闭、宽高、right/bottom、footer/headerActions、busy、keepMounted、initialFocus/returnFocus。默认聚焦容器；触摸或会卸载的菜单入口可指定稳定的返回目标。长弹窗滚动整个 viewport，抽屉滚动正文。既有抽屉没有滑动关闭/吸附点，因此用定位的 Base Dialog 实现，不新增手势或全站 API 仿制。

确认默认聚焦 Cancel，遮罩不关闭；pending 阻止取消、Esc、外部轻点和重复提交。同步 throw/异步 reject 保留弹窗并显示可访问错误，允许重试；成功/取消分别返回 true/false。`useConfirm()` 的 holder 保留调用处上下文，同一 hook 的重复调用共享一个 Promise，宿主卸载返回 false，迟到响应不关闭新确认，立即连续确认用独立状态。业务须返回实际请求 Promise；已发出的请求是否取消仍由业务决定。

共存通过 `OverlayScope` 与 `useOverlayChild` 显式声明拥有关系，调用旧组件公开的 getContainer/getPopupContainer/zIndex/keyboard/styles API。每层递增100，根层1000，原 toast2050不变。新弹层自己的 portal 宿主拦截原生 focusout，避免父焦点管理器的下一帧恢复覆盖子层返回目标；旧弹层正文的 Scope 不截断表单 blur。两个方向都使用真实安装的 AntD 6.6.5 组件验证，不以 mock 组件代替。

没有修改业务路由、REST/SSE、主题 Provider 或依赖锁文件。现有页面仍使用原组件；页面批量替换由 P3/P4/P5 完成。本任务不主张 antd 已移除或包体积已下降。

## 固定环境与直接证据

[overlays.html](../../../../src/web/ui-migration/overlays.html) 是独立开发入口，不增加业务路由。真实 AntD/Orbit 控件共享 ThemeProvider、ConfigProvider、reset 和字体，使用固定表单/说明文字；异步用浏览器拦截请求精确控制 pending、409 和成功响应。

运行环境由原 P0 environment.mjs 严格校验：Debian 13.7/Linux x64、Node26.10.0、Playwright1.63.0、Chromium1243/WebKit2359、相同字体文件 SHA-256、DPR1、UTC/en-US。1280×900 与390×844、light/dark形成八组合；无重试。截图为实际浏览器 PNG，没有渲染替身、图像编辑或覆盖历史基线。

外观用例逐项严格比较普通弹窗、右抽屉、底部抽屉、危险确认：宽高/坐标、字体/行高、颜色/背景、圆角、padding、阴影、所有输入和操作按钮的相对几何。不设置差异容忍值。每种保留新旧两个真实截图，并另外保存嵌套、旧弹层混用、pending、失败和长内容图。手机108px顶部、抽屉16.1px正文行高、底部操作区原对齐方式均来自实测。

行为矩阵覆盖：

- Tab/Shift+Tab 圈定当前层、默认/显式进入焦点、逐层返回焦点、Esc/Close/外部鼠标及轻点、内部按下外部释放不误关。
- 新 Drawer→新 Dialog→Confirm；旧 Modal/Drawer→新 Dialog→Confirm；新 Dialog/Drawer→真实旧 Modal、Popconfirm、Select。检查顶层命中、只关闭当前层、旧表单 blur、选项键盘和父层保持打开。
- 文档滚动锁/多层关闭恢复、长正文和 footer 可达、bottom 高度与轻点、keepMounted 草稿、独立关闭开关、打开时切换主题、composition 期间 Esc。
- 同轮重复 confirm/鼠标双击/Enter/Space 防重；pending 禁止关闭；失败重试/取消；请求期间卸载/重新打开；立即连续确认；原生 required/Enter 表单提交、默认动画与焦点。

手机 WebKit 不提供 Playwright mouse.wheel，本项用原生 PageDown 验证文档不能滚动和关闭后位置恢复；其它六组合用 wheel。触摸关闭另用 touchscreen.tap 验证，不把 PageDown 说成真机触摸滚动。

## 验证记录

从仓库根复跑：

```sh
bash scripts/worktree-overlay.sh
npm run test:ui-overlays -w @orbit/web
node node_modules/typescript/bin/tsc -p src/web/ui-migration/overlays.tsconfig.json --noEmit
npm test -w @orbit/web -- src/lib/theme.test.tsx src/components/ui/boundary.test.ts
npm run build -w @orbit/web
npm run test -w @orbit/web
npm run test:ui-controls -w @orbit/web
npm run test:ui-foundation -w @orbit/web
npm run test:ui-migration -w @orbit/web
node src/web/ui-migration/collect-overlay-evidence.mjs /tmp/new-overlay-evidence
```

collector 只接受新目录且拒绝有意外失败的报告；保存环境、完整报告、PNG/JSON 附件及 SHA-256。

- 最终弹层矩阵**96/96通过**，0 skipped/flaky/unexpected，见 [overlays-complete/summary.json](overlays-complete/summary.json) 和 [原始报告](overlays-complete/report.json)。包含128张PNG、96份行为/测量JSON及环境记录。扩展旧/新 Drawer 两种共存组合之前的80项运行也通过，作为阶段记录保留于 [overlays-run](overlays-run/summary.json)。
- 基础控件回归24/24、主题/首屏/历史共存回归48/48通过，见 [controls-regression](controls-regression/summary.json)、[foundation-regression](foundation-regression/summary.json)。
- 完整 Vitest 为293文件、3606用例通过；边界/主题定向6项通过，独立 fixture 类型检查和 Web 构建通过。完整单测后新确认生命周期/共存边界还有修正，最终以弹层浏览器矩阵和独立类型检查验证；不把较早单测称为提交后重新执行。P0 pretest 包含最终公共实现的生产构建。构建仍有原有大chunk提示。
- P0 回归**没有全绿**：69普通通过、16原有焦点预期失败、11原有跳过、8意外截图失败。随后将未修改 HEAD 的 src/web 解包至 `/tmp/orbit-p21-head`，使用相同依赖/共享包/环境重新构建，原样跑全部104项，也得到相同结果。8张失败实际图的字节完全一致，均为桌面会话列表省略号处3像素，与本次弹层实现无关。见 [修改后报告](diagnostics/p0-current/summary.json)、[未修改HEAD报告](diagnostics/p0-head/summary.json)、[前后图片哈希](checks/p0-before-after.json)。这些失败阻止了对应场景后续步骤，不能声称原252张截图全部比较通过。
- 原252张基线全部与 HEAD 字节一致，见 [基线哈希核对](checks/baseline-screenshot-hashes.json)。没有放宽像素断言、更新基线或新增 expected failure。

[checks](checks/) 保存命令参数、时间、起点、退出码和原始输出；[tool-call-refs.json](checks/tool-call-refs.json) 从本任务运行记录提取已存在的调用编号。失败诊断原样保留，不重写原始报告/日志的空白。

P0 两次运行各121份原始样式/诊断附件打包在对应目录的 `attachments.tar.gz`，summary 记录条目和归档哈希；归档逐文件回读验证过字节一致。失败 PNG 和报告仍可直接查看。

## 修复记录与未确立的部分

浏览器验证发现并修复：子层关闭后父层延迟抢焦点、旧正文 blur 被拦截、抽屉样式污染子弹窗、WebKit viewport窄8px、手机弹窗顶部差异、抽屉行高/操作区偏移、立即连续确认复用旧 pending 状态。诊断报告见 [diagnostics](diagnostics/)。后来增加卸载用例产生两个含“Result”的可访问名称，改为完整名称精确定位；Select 检查其真实 aria-expanded，避免把虚拟列表的零尺寸节点当作可见列表。IME检查等待组合结束的两个渲染帧后再按Esc。这些调整不删除或放宽行为断言。

准备依赖时 Prisma 缓存只读，使用 `/tmp/orbit-p21-cache` 的现有缓存副本完成隔离安装；临时 HEAD 副本补齐相同依赖路径后才得到有效复现结果。准备失败与浏览器失败都有命令记录。

本证据不确立真机 iOS 软键盘/触摸滚动、原生输入法、真实后端错误链路、业务页面批量迁移、未声明拥有关系的独立兄弟弹层或所有第三方弹层组合。P0两项分享焦点缺陷及此次确认在HEAD已存在的3像素差异保持原状，未在本任务顺带修改。P2选择/通知验收不能凭此任务完成。没有部署、发布或自审验收；完成状态由任务声明的验收机制求值。

以本任务提交整体回退即可撤销组件、局部样式和验证入口，没有持久化数据或接口变更。
