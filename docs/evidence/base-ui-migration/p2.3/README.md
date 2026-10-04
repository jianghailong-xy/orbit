# P2.3 通知与反馈服务复核

服务于 [P2.3 任务](orbit-task:34Za3974yqnhjQsRBl0R3)。项目验收 key `1BvO6hYrlFnU60JqxQPUHt`，原文：**P2：Orbit 自有弹层、选择及反馈组件保持现有键盘、焦点、通知和确认行为。** 本次仅承担通知及其与已交付弹层/确认的集成，不主张完成 P2.2 菜单/选择任务。

起点 `67e62c0b4028eefe2c619dac80d3fac312cea601` 已含 P2.1 第二版落地成果；实现与可重跑测试提交为 `5814921cee182e467b0cee42542f8f763580b6ef`。开工已读 task_get 完整信息/历史评论、project_get 目标/8项验收/作业指导、P0.1清单与替代契约、P0.2基线、P2.1及revision-2交付。工作区开工干净。

## 已证实的缺口和局部修复

原通知内核已经独立于 AntD。`useToast`、`toastFeed`、`toastStore` 生产文件及 `main.tsx` 与起点逐字节相同，见 [audit.json](audit.json)；不重建通知、不更换计时/去重算法、不退役尚被旧页面使用的 AntApp。

真实 Chromium 桌面、WebKit 手机模拟均复现：先发出错误通知，再打开 Orbit Dialog，通知虽可见但被模态隔离排除于可访问树。原断言失败和截图/trace保留在 [before-fix](diagnostics/before-fix/report.json)。新增 `ui/feedbackPortal.ts` 通过 Orbit 自有弹层 ref 登记最上层挂载点，唯一 ToastViewport 将已有/后到通知放在其 DOM 焦点范围内，关闭时返回父层/body。没有发现/读取 AntD 或 Base UI 内部 class，也没有依赖 DOM 查询寻找弹层。Base UI 仍由 ui 封装；通知仍走原业务 API。

迁移挂载点的外观风险经过实测修正：通知容器原先继承 body 的16px/1.15行高，新 Dialog/Drawer 会改变该继承；现在通知容器明确保留原值。WebKit 手机抽屉固定子节点曾从350px变为358px，使用 body 下不可见固定定位测量节点保持原布局视口宽度，ResizeObserver 跟踪调整，关闭时移除。没有改通知原点、主题变量或抽屉样式；尝试过的抽屉 overflow 改动已撤回。24组最终新旧计算样式与区域PNG均完全相等。

新增文件归属：`feedbackPortal.ts` 属 P2 通知/弹层集成，继续供后续页面迁移复用；`ToastsFixture.tsx` 和 `ui-migration/toasts*` 属 P2.3 私有验证入口；fixture 中 AntApp 对照在 P6 退役。`feedback-production.browser.mjs` 是原生产会话场景的定向通知取证入口。历史 P0 清单、截图、现有断言及预期失败标记没有覆盖。

## 行为与测试证据

固定环境经 P0 environment.mjs 校验：Debian13.7/Linux x64、Node26.10.0、Playwright1.63.0、Chromium1243/WebKit2359、原字体文件哈希、DPR1、en-US/UTC。默认 reducedMotion=reduce，桌面1280×900、手机390×844，明/暗主题八组合；另有正常动画完成状态及599/601px断点检查。固定数据与日期，无重试、无截图阈值放宽。

| 检查 | 结果 | 直接证据 |
| --- | --- | --- |
| 通知完整矩阵 | 88/88，0 skipped/flaky/unexpected | [summary](toasts-run/summary.json)、[report](toasts-run/report.json) |
| P2.1完整弹层回归 | 96/96，0 skipped/flaky/unexpected | [summary](overlays-regression/summary.json)、[report](overlays-regression/report.json) |
| 真实生产路由通知 | 8/8 | [report](production-run/report.json) |
| 起点原始通知+弹层外观 | 24/24 | [report](reference-run/report.json) |
| 起点原始生产代码重放 | 8/8 | [report](production-reference-run/report.json) |
| 通知/主题/公共边界单测 | 30/30 | [日志](checks/unit-regression.txt) |
| 完整 Web 单测 | 294文件、3642用例通过 | [日志](checks/full-web-test.txt) |
| fixture及通知测试独立类型检查 | 通过 | [fixture](checks/final-types.txt)、[tests](checks/notification-test-types.txt) |
| Web 类型检查/生产构建 | 通过；保留已有大chunk提示 | [日志](checks/final-web-build.txt) |

通知矩阵通过真实可见内容和按钮验证：3秒短提示、6秒结果卡片、悬停暂停并离开后重新完整计时；错误/警告常驻，手机6秒折叠及重开；桌面两条临时通知/手机最新一条，常驻通知展开/收起与逐项关闭，混合堆叠无相互重叠；两秒无键内容去重，同事件/实体更新、失败被成功替换，不同事件/实体独立保留；Undo 一次回调，编码后的会话路径跳转，鼠标/模拟触摸激活；诊断选择与复制不会误跳转；assertive错误/警告与polite短通知的live region文本、优先级及未被隐藏状态。

集成用例验证通知 Tab 可达、Enter 操作只处理通知、Esc 保留逐层关闭/归还焦点、嵌套Drawer/Dialog/Confirm、实时主题切换、keepMounted关闭后通知仍可访问及重新打开。异步确认验证pending防重和禁止取消/Esc、失败后通知可关闭且确认保留、成功重试后焦点归还。旧 AntApp.confirm 仍能完成并发出同一服务的通知。原 P2.1矩阵另外完整复验双向旧/新弹层、外部点击、滚动锁、原生表单、IME合成事件和确认生命周期。

计时用例使用 Playwright clock 精确验证2999/3000、5999/6000ms，不作为原生性能测量；其它场景保留真实浏览器调度。复制检查截取 clipboard.writeText 实参，文本选区和按钮激活是真实 DOM 行为，不主张覆盖操作系统剪贴板授权。无生产账号或实际后端写入。

## 截图与逐像素对照

[审核脚本](audit.py) 读取原始PNG全部RGBA像素，未缩放、修图、屏蔽或使用容差。[audit.json](audit.json) 保存每对结果、源码哈希与原252张基线哈希。所有632份通过场景附件的SHA-256均核验成功。

- Dialog/右Drawer/底Drawer × 八组合，共24对通知区域PNG，计算样式和每个像素均相同。比较内容含字体、颜色、渐变背景、边框、阴影、圆角、间距、坐标、尺寸与统一的非hover/非focus状态。
- 生产发送错误通知八组合，与P0.2原PNG中通知及外侧12px阴影范围均为0像素差异，比较框坐标保留于audit。原完整截图均保留，没有裁剪覆盖文件。
- 四张手机生产整页图也与P0.2完全一致。四张桌面整页图仍有633/638/642/648个不同像素，位于会话列表标题、省略号按钮和时间附近（Chromium亮色的边界为x459–571/y193–210），不是通知区域。用起点原始生产代码重放后，**八张整页图与本次全部逐像素一致**，直接证明这些差异在本任务前已存在。

代表截图：

- [亮色桌面混合堆叠](toasts-run/chromium-light-desktop--mixed-pinned-and-passing-notifications-stack-without-overlap-and-retain-all-pinned-errors--mixed-stack.png)、[展开常驻通知](toasts-run/chromium-light-desktop--mixed-pinned-and-passing-notifications-stack-without-overlap-and-retain-all-pinned-errors--expanded-pinned-stack.png)。
- [暗色手机确认失败及通知](toasts-run/webkit-dark-phone--async-confirmation-keeps-pending-locks-accessible-failure-feedback-and-successful-retry--confirm-failure-notification.png)、[嵌套弹层切换主题](toasts-run/webkit-dark-phone--copyable-diagnostics-and-live-announcements-survive-nested-overlays-and-theme-changes--nested-toast-opposite-theme.png)。
- [WebKit暗色手机右抽屉原始通知](reference-run/webkit-dark-phone--reference-Drawer--with-overlay.png)、[修复后的通知](toasts-run/webkit-dark-phone--existing-notifications-remain-accessible-in-Drawer-with-unchanged-appearance--with-overlay.png)：逐像素一致，按钮现在进入模态的可访问和键盘范围。
- [生产发送失败](production-run/chromium-light-desktop--P2.3-production-notification-compatibility--production-notification.png)、[起点原始生产代码](production-reference-run/chromium-light-desktop--P2.3-production-notification-compatibility--production-notification.png)：整页逐像素一致。

## 复跑与诊断

从仓库根运行，按项目既有锁文件隔离依赖流程准备环境：

```sh
bash scripts/worktree-overlay.sh
NO_COLOR=1 npm run test:ui-toasts -w @orbit/web
python3 docs/evidence/base-ui-migration/p2.3/collect.py src/web/.toasts-results /tmp/p23-new-toasts-evidence
NO_COLOR=1 npm run test:ui-overlays -w @orbit/web
NO_COLOR=1 npm run test:ui-migration -w @orbit/web -- feedback-production.browser.mjs
NO_COLOR=1 npm test -w @orbit/web
node node_modules/typescript/bin/tsc -p src/web/ui-migration/toasts.tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p src/web/ui-migration/toasts-tests.tsconfig.json --noEmit
npm run build -w @orbit/web
python3 docs/evidence/base-ui-migration/p2.3/audit.py
```

collector拒绝已有目标目录和意外失败报告。环境JSON沿用原P0记录。脚本audit核对的是本目录已归档的本次证据；重跑结果用新目录保留，再用同一比较方法独立审查，不能直接替换历史证据。

独立起点对照可用 [prepare-reference.py](prepare-reference.py) 在新目录导出固定提交，复用匹配锁文件的依赖、单独构建原shared并隔离Vite缓存，再运行所保存的参考入口：

```sh
python3 docs/evidence/base-ui-migration/p2.3/prepare-reference.py /tmp/p23-new-reference
NO_COLOR=1 node node_modules/@playwright/test/cli.js test --config /tmp/p23-new-reference/src/web/ui-migration/reference.config.mjs
npm --prefix /tmp/p23-new-reference/src/web run build
NO_COLOR=1 node node_modules/@playwright/test/cli.js test --config /tmp/p23-new-reference/src/web/ui-migration/production-reference.config.mjs
```

本轮最初手工准备的 `/tmp/orbit-p23-reference` 仍保留。可重跑准备脚本已在新目录实跑，并逐文件核对原始源码；其首次遗漏tsconfig.base.json的准备失败及修正日志也保留。首次参考Vite启动少了根package.json，补齐原文件后才有效运行；初始隔离依赖准备遇到Prisma只读缓存，用 `/tmp/orbit-p23-cache` 副本完成。沙箱本地监听被拒后以授权的本地浏览器执行恢复；默认4177端口占用后固定使用14377，未复用未知服务器。

`checks/`保存argv、时间、起点、退出码和完整日志；[tool-call-refs.json](checks/tool-call-refs.json)引用本任务运行中已有的调用行。`diagnostics/before-fix`是产品缺口复现；`diagnostics/first-integration`保存挂载初版的继承/宽度差异；`diagnostics/viewport-and-retained`保留后续诊断。其余检查日志保留了无效的宽度/overflow尝试，未降低相等断言。最后的keepMounted测试首次复用被固定Date去重的同一句错误，改用不同的警告事件验证重新打开，保留了既有去重规则；不是修改实现来让重复通知出现。

## 边界与回退

本次有生产集成修复，**不是 codeless**。回退实现提交可撤销通知挂载及其验证入口；证据提交可独立保留。没有依赖、路由、REST/SSE或服务端语义变更，没有部署/发布。

Linux手机context只证明模拟触摸/布局；未确立真机iOS软键盘、原生IME、真实读屏软件发声、真实服务端鉴权/重连或操作系统剪贴板授权。正常动画用例验证完成状态和关闭后回归原点，不主张逐帧轨迹相同。旧页面AntApp确认退役仍归后续阶段。

本次未重跑完整P0矩阵，不能称其全绿；P0原有16项焦点预期失败、11项跳过、P2.1记录的桌面会话截图差异和图布局例外仍按原记录处理。也不声称完成全站AntD退役或P2.2选择组件。完成证据交由任务的独立EVIDENCE_JUDGMENT机制决定，未直接写DONE。
