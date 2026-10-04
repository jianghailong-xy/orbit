# P2.3 第2版：动画与悬停生命周期返工

服务于 [P2.3 通知与反馈服务](orbit-task:34Za3974yqnhjQsRBl0R3)。验收 key `1BvO6hYrlFnU60JqxQPUHt`，原文：**P2：Orbit 自有弹层、选择及反馈组件保持现有键盘、焦点、通知和确认行为。** 本次只承担通知及其与已交付弹层/确认的集成。

第1版 `0e3b3a61cadc73bda93f06985dbd866e4d1fba79` 被独立验收退回。本页替代第1版对通知兼容性的结论，历史记录原样保留。任务起点仍为 `67e62c0b4028eefe2c619dac80d3fac312cea601`；第1版的可访问性修复保留。返工实现提交：ef1d367341a1ac080b74c323c0bf104bfc140cb6。

## 复现、修复及范围

重新读取 task_get 的完整信息及 SEND_BACK 评论、project_get 的目标/验收/指导。沿用已读的 P0.1 清单与替代契约、P0.2 实测基线及 P2.1 第2版规则。验收方原脚本保存在 [coordinator-input](coordinator-input/)，原三种弹层入场、受控时钟和原生时钟五个测试的代码保留于 `toasts-lifecycle.browser.mjs` 开头，扩展到八种浏览器/主题/尺寸组合。

本任务会话在第1版代码上重新运行了原脚本：[原始失败报告](before-repair/report.json)。三种入场 × Chromium/WebKit 的六项均失败，WebKit 的受控时钟悬停恢复失败，原生时钟本轮两个浏览器均失败。协调者原始参考报告也保存在 coordinator-input；原实现的对应检查通过。失败不是基线容差或新数据造成的。

局部修改仅在通知呈现和它自己的样式/验证入口：

- 同一 React portal 使用稳定宿主，在 Orbit 自有 ref 指定的模态范围之间移动，保留通知 DOM 和业务队列。宿主使用原生 `popover="manual"` 顶层绘制，避开祖先缩放、平移、透明度和裁切，仍属于当前模态的 DOM/Tab 范围。空宿主和无动作短通知穿透点击。没有修改任何 Dialog/Drawer 动画或确认生命周期。
- DOM 重挂仍会重播 CSS 动画，因此保留通知首次入场的时间，以负 animation-delay 延续已有进度；完成的通知不再次闪现，新通知仍播放原 180ms 入场动画。逐帧检查同时检查卡片位置、尺寸、透明度和 DOM 身份，不能只靠固定 viewport 的坐标通过。保留通知自己的变换合成层，修正顶层绘制导致 Chromium 圆角边缘的抗锯齿差异；正常和减少动画模式均核对原图。
- WebKit 在重挂时会遗漏 mouseleave。只在真实鼠标移动进入/离开原先可悬停的通知时调用原 hold/release；悬停期间切层继续暂停，离开后重新完整计时，未悬停通知保留原截止时间。离开窗口和卸载时清理监听及暂停状态。
- 持久 body 固定定位测量节点保留 WebKit 的滚动条预留宽度；每次切层重建测量节点也会改变手机嵌套宽度，这已用原实现三项对照证实并修复。ResizeObserver 跟踪真实尺寸变化，卸载时清理。两处原本不需 ResizeObserver 的 jsdom 宿主补了平台桩，所有业务断言保留。

`useToast`、`toastFeed`、`toastStore`、main.tsx、Overlay.css、ConfirmDialog.tsx 与任务起点逐字节相同；Overlay.tsx 和反馈挂载登记与第1版逐字节相同。没有依赖、路由、REST/SSE、旧 AntApp 或公共 API 变更，没有重建通知服务。本次不是 codeless。

原生 [Popover API](https://developer.mozilla.org/en-US/docs/Web/API/Popover_API) 仅用于绘制层；固定 Chromium/WebKit 的实际交互和像素是本次兼容性证据。没有导入 Base UI 内部接口，也没有读取 AntD 内部元素。通知内部的节点/动画查询只针对 Orbit 自己创建的节点。

## 验证结果

固定环境仍为 P0 记录的 Debian13.7、Node26.10.0、Playwright1.63.0、Chromium1243/WebKit2359、原字体哈希、DPR1、en-US/UTC；桌面1280×900、手机390×844，light/dark。所有浏览器入口先校验该环境，不重试，不放宽像素阈值。

| 检查 | 结果 | 原始证据 |
| --- | --- | --- |
| 扩展通知矩阵 | 208/208，0 skipped/flaky/unexpected | [report](toasts-run/report.json)、[summary](toasts-run/summary.json)、[命令](checks/committed-notifications-clean-rerun.txt) |
| P2.1 完整弹层回归 | 96/96，0 skipped/flaky/unexpected | [report](overlays-regression/report.json) |
| 原生产路由通知 | 8/8，0 skipped/flaky/unexpected | [report](production-run/report.json) |
| 原实现同时间截图参考 | 32/32，0 skipped/flaky/unexpected | [report](reference-motion-run/report.json) |
| 通知/主题/边界及受影响宿主单测 | 33/33 | [日志](checks/platform-stubs-unit.txt) |
| 最终完整 Web 单测 | 294 文件、3642 用例通过 | [日志](checks/committed-full-web.txt) |
| 修改的 fixture/测试独立类型检查 | 通过 | [fixture](checks/final-fixture-types.txt)、[全部修改的测试](checks/all-modified-test-types.txt) |
| Web 强制类型检查/生产构建 | 通过，保留原大 chunk 提示 | [force typecheck](checks/web-force-typecheck.txt)、[build 与生产浏览器检查](checks/committed-production.txt) |

最终运行的源码固定为实现提交 `ef1d367341a1ac080b74c323c0bf104bfc140cb6`；其后只归档证据。原88项通知场景全部保留。新增120项覆盖原验收复现、正常动画的每帧开关/双层嵌套、鼠标静止跨四次挂载点切换后仍暂停、离开后5999ms可见/6000ms消失、未悬停时总计5999/6000ms截止时间不变、原生时钟实际消失、原通知新入场动画，以及 Dialog/Drawer/底部抽屉/Confirm 的开关截图。

计时用例的 Playwright clock 只用于精确期限，不作为性能证据；原生时钟检查另外保留。真实鼠标/键盘/模拟触摸验证撤销、会话跳转、复制、常驻和堆叠；live region 的内容、优先级与可访问状态仍按原测试检查。

新增截图测试曾错误地假设命令式 Confirm 与受控 Dialog 有相同开关动画。原代码的 holder 直接以 open 状态挂载、关闭即卸载；[原实现开关检查](original-confirmation-open-close/report.json) 在 Chromium/WebKit 确认无对应过渡。测试现在明确断言这项既有行为，并继续截图打开和关闭两种状态；三种有动画弹层仍必须证明动画存在。生产 Confirm 保持不变，所有场景和通知断言保留。第一次诊断还误统计了页面其它按钮的动画，后续按确认框自身统计；记录均保留。

## 截图与过程对照

[audit.py](audit.py) 对原始 PNG 的全部 RGBA 像素逐一比较，没有修改图片、缩放、遮蔽或容差。最终 [audit.json](audit.json) 同时校验源文件、附件 SHA-256 和 P0 原252张基线。

- 原252张P0基线逐字节未动。
- 24对弹层内静态通知：全部计算样式相同，PNG零像素差异。
- 32组原实现参考场景产生160对PNG（入场前通知、开关中点通知与整页）：零像素差异。
- 生产8组合：通知连同12px阴影扩展区域与P0零差异，整页与任务起点零差异。P0桌面会话列表既有633/638/648/642像素差异保留，手机整页与P0零差异。

三种弹层的24组动态图检查共记录2381帧，位置/尺寸/自身透明度或DOM身份改变均为0帧。8组原生计时观测均消失（本轮轮询观测6299–6315ms；不作为精确计时或性能界限）。检查保留真实 requestAnimationFrame 调度，逐帧样本检查位置/尺寸/透明度、通知 DOM 身份，并确认每一次进入/退出的 popup 动画仍在运行。截图另外将真实 popup 与 backdrop 动画暂停在各自持续时间的一半，取得固定时刻后继续播放；没有关闭、删去或重写原动画。通知截图前等待按钮悬停颜色过渡结束，消除与弹层中点无关的时间差；相同流程用于原实现。确认框按其原有无过渡行为截图。

参考树用任务起点原始生产代码，仅复制相同私有 fixture 和测试。原通知在模态中被排除于可访问树，这是第1版修复的缺口；参考截图入口因此用 Orbit 自有 `.toast-viewport` DOM 定位器取得已绘制的通知。当前代码的所有可访问性/Tab 断言仍使用可访问 region，未作替换。

- [明色桌面：抽屉入场中点](toasts-run/chromium-light-desktop--notification-pixels-stay-intact-through-Drawer-opening-and-closing--opening-page.png)
- [暗色手机：底部抽屉退场中点](toasts-run/webkit-dark-phone--notification-pixels-stay-intact-through-Bottom-drawer-opening-and-closing--closing-page.png)
- [混合常驻/短通知/生命周期卡片](toasts-run/chromium-light-desktop--mixed-pinned-and-passing-notifications-stack-without-overlap-and-retain-all-pinned-errors--mixed-stack.png)
- [明色手机：确认框与通知](toasts-run/chromium-light-phone--notification-pixels-stay-intact-through-Confirmation-opening-and-closing--opening-page.png)

[代表性图片人工审阅记录](visual-review.json)补充检查通知与弹层、混合堆叠及真实生产页面。

## 复跑与归档

```sh
bash scripts/worktree-overlay.sh
NO_COLOR=1 npm run test:ui-toasts -w @orbit/web
NO_COLOR=1 npm run test:ui-overlays -w @orbit/web
NO_COLOR=1 npm test -w @orbit/web
node node_modules/typescript/bin/tsc -p src/web/ui-migration/toasts-tests.tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p src/web/ui-migration/toasts.tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -b src/web --force
npm run build -w @orbit/web
NO_COLOR=1 npm run test:ui-migration -w @orbit/web -- feedback-production.browser.mjs
python3 docs/evidence/base-ui-migration/p2.3/revision-2/prepare-reference.py /tmp/p23-r2-new-reference
NO_COLOR=1 node node_modules/@playwright/test/cli.js test --config /tmp/p23-r2-new-reference/src/web/ui-migration/reference-lifecycle.config.mjs --grep 'pixels stay intact'
python3 docs/evidence/base-ui-migration/p2.3/revision-2/audit.py
```

基准准备脚本已实跑，导出固定提交并单独构建 shared/隔离 Vite 缓存。[源文件核验](reference-source-check.json) 确认参考树589个原始源码文件逐字节匹配任务起点，私有 fixture 与当前树相同，参考测试仅替换通知定位器。采集新结果时使用第1版的 collect.py 写入新目录，不覆盖本页证据或 P0 图。audit 默认检查本目录已归档证据。

`checks/`保存每次命令的 argv、工作目录、起点、结束时间、退出码和原始输出；不以最后一次通过隐藏前面的失败。before-repair 是本任务重放的两类退回问题；top-layer/card-motion/animation-time 等 diagnostic 目录保留渐进修复中发现的附加表现。confirmation-assumption/interrupted-assumption 保留新测试误设动画的失败；后一轮因同一假设被主动停止，不能计为通过。像素复核另外发现正常/减少动画模式的 Chromium 圆角差异，以及 WebKit 按钮 hover 淡出时刻不同；[诊断](pixel-audit-diagnostic.json)、[修正后184对截图零差异](static-raster-pixels.json) 均保留。两个参考准备/审查顺序错误和本地服务受沙箱限制的失败也在 checks 中，不计为产品回归。最终提交上的一轮通知检查在首个 Complete session 点击前超时，trace 的6条模块加载错误均为 `ERR_NETWORK_CHANGED`；[诊断](network-load-diagnostic.json)和[该轮207通过/1失败的完整命令日志](checks/committed-notification-matrix.txt)保留。该轮report/trace因采集脚本拒收失败后启动复跑而未留存，[归档缺口说明](network-interrupted-matrix/README.md)明确记录，随后在同一提交原样重跑。提交前一轮完整单测发现新增 `.toast` 顶层规则违反现有去重规范，随后把同一声明合并进原规则并重新验证，没有修改该检查。最终完整通知、完整单测和生产构建/浏览器命令均在已提交的修复上执行（命令元数据的 startedFrom），没有在运行中修改源码。最终有效结果仅采用上表所列报告。

[tested-sources.json](tested-sources.json) 记录已验证文件的 SHA-256；[工具调用引用](checks/tool-call-refs.json) 指向当前任务会话中实际保存的 CommandExecution 行，用于结构化证据信封。返工提交与证据提交可独立审查。

## 边界与回退

一轮最终提交检查的环境故障已保存完整命令输出及从trace提取的错误；该轮原始report.json/trace.zip未能保留，见上文归档缺口。最终通过报告及其它修复前失败记录另行完整归档。

Linux 手机模拟不证明真机 iOS 软键盘/原生 IME、真实读屏软件发声、后端鉴权/重连或系统剪贴板授权；本次固定 Chromium/WebKit 支持 Popover API，未扩展到更旧的浏览器。可访问树/live region 证据不等于实际读屏听测。

完整 P0 矩阵未重跑，不宣称其全绿。原有焦点预期失败、范围明确的跳过及图布局例外仍按 P0/P2.1 记录。P0 桌面会话列表差异与通知分开；本次生产整页仍对照任务起点，具体像素数量见 audit。未覆盖 P2.2 新菜单/选择组合、后续 AntApp 退役或全站 AntD 移除，没有部署/发布。

回退本次实现提交会恢复第1版已被退回的动画/悬停问题；完整撤回 P2.3 时再回退第1版实现 `5814921ce`，保留证据提交。完成证据交独立 EVIDENCE_JUDGMENT 求值，不直接写 DONE。
