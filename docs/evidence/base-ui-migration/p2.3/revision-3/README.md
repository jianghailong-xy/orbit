# P2.3 第3版：静止指针下的新通知

> **证据瘦身（2026-10-07）**：完整原件见提交 `7732f14f82d4e6b4406d7d164c4b672f63aa0f56`（瘦身前最后一个含完整文件的提交）。取回单个文件用 `git show 7732f14f82d4e6b4406d7d164c4b672f63aa0f56:docs/evidence/base-ui-migration/p2.3/revision-3/<路径> > <文件>`，整个目录用 `git archive 7732f14f82d4e6b4406d7d164c4b672f63aa0f56 docs/evidence/base-ui-migration/p2.3/revision-3 | tar -x -C <空目录>`。
>
> 本目录在瘦身中：11 份 Playwright 报告换成同目录的 `report.summary.json`，都只删附件正文；删除 1 个 trace 压缩包；436 个逐用例 JSON（含打包的 attachments.tar.gz）换成所在目录的 `attachments.summary.json`（文件名、字节数、SHA-256 和顶层标量字段）；删除 100 张与本任务目录里保留副本逐字节相同的重复截图。下文链接若指向这些文件，按上面的命令从该提交取回；读取它们的脚本要在取回的目录里运行。
>
> 目录里的 SHA256SUMS 类清单（`*.sha256`、`artifact-index*.json`、`manifest.json`、各运行 `summary.json` 里的附件哈希等）保留原文件，核验的是提交 `7732f14f8` 里的文件。做法、保留理由和逐文件删除清单见 [evidence-slimming](../../evidence-slimming/README.md)。

服务于 [P2.3 通知与反馈服务](orbit-task:34Za3974yqnhjQsRBl0R3)。验收 key `1BvO6hYrlFnU60JqxQPUHt`，原文：**P2：Orbit 自有弹层、选择及反馈组件保持现有键盘、焦点、通知和确认行为。** 本次承担通知及其与已交付弹层/确认的集成。

第2版 `192ee6cf0fa45727096b0bf23d5a4f2ce3e5c96e` 被独立验收退回：新通知出现在静止指针下时，浏览器产生 mouseover，没有 mousemove，六秒停留计时没有暂停。本页替代第2版的完成结论，历史附件不覆盖。任务起点仍为 `67e62c0b4028eefe2c619dac80d3fac312cea601`；第1版可访问性及第2版动画/弹层悬停修复保留。

本次实现提交：`1b17eaf7d25674d220298c0141d5366324eb7ab8`。不是 codeless；生产改动仅为 ToastViewport 的鼠标进入处理，另补验证及使用说明。

## 复现与修复

重新读取 task_get 完整信息/历史评论、project_get 目标/验收/指导、根 AGENTS.md，并沿用 P0.1 清单与替代契约、P0.2 实测基线和 P2.1 交付。验收方脚本及结论原样保存在 [coordinator-input](coordinator-input/)。

使用同一脚本分别运行第2版和修复后版本，两个浏览器都与任务起点比较。所有用例均先把鼠标放在通知未来出现的位置，再用键盘发出通知，不合成鼠标事件。原生等待6500ms后，第2版通知消失，任务起点与修复后的通知均保留；事件记录均有真实 mouseover、没有 mousemove。[对照表](stationary-comparison.json)、[修复前](before-repair/coordinator-stationary-arrival.json)、[修复后](after-repair/coordinator-stationary-arrival.json)保留原始值。原脚本的 `revision2` 标签指向 live 端口，修复后仍保留该标签以保证脚本字节不变。

修复复用既有悬停判断，同时监听 mouseover 和 mousemove。前者覆盖新通知到达及布局变化造成的真实进入/离开；后者继续处理 WebKit 切层时遗漏的 mouseleave。进入时再次调用幂等的 holdToasts，恢复清空队列后被计时内核重置的暂停状态；离开仍只释放一次。卸载移除两个监听并释放暂停。

`useToast`、toastFeed、toastStore、main.tsx、Overlay.css、ConfirmDialog 与任务起点逐字节相同；Overlay/feedbackPortal 与第1版相同，index.css 与第2版相同。没有改计时、去重、主题、堆叠规则、通知动作、弹层动画、路由、REST/SSE 或旧 AntApp；通知仍独立于 AntD 内部 DOM。[源码及附件核验](audit.json)与[tested-sources](tested-sources.json)记录实际哈希。

## 行为与截图证据

固定环境继续由 P0 environment.mjs 校验：Debian13.7、Node26.10.0、Playwright1.63.0、Chromium1243/WebKit2359、原字体哈希、DPR1、en-US/UTC；1280×900和390×844、明暗主题。默认减少动画，动画测试显式启用正常动画；不修改截图、容差、基线或原断言。

原208项通知检查保留，追加3项×8组合：

- 原生时钟下，静止指针进入后6500ms仍可见；真实移开鼠标后自动消失。原始事件与实际观测时间单独保存。
- 静止进入后经历四次弹层挂载点切换，累计推进40800ms仍暂停；清空并原地替换通知后推进10000ms仍保留。移开后5999ms可见、6000ms消失。
- 常驻错误卡片加入/移除，使结果卡片在静止指针下进入/离开。保持阶段超过原截止时间，离开后5999/6000ms精确恢复。检查真实边界事件及零 mousemove。

原生检查证明实际行为；Playwright clock 用于精确期限，不作为性能测量。任务起点另运行相同的原生进入/移开和布局变化两项×8组合，测试文件逐字节相同。模态可访问性是第1版修复的原缺口，因此原实现对照不运行新的模态测试；当前完整矩阵保留全部模态断言。[参考树核验](reference-source-check.json)确认589个原始源码文件和相同私有 fixture。

| 检查 | 结果 | 直接证据 |
| --- | --- | --- |
| 完整通知矩阵 | 232/232，0 skipped/flaky/unexpected | [report](toasts-run/report.json)、[summary](toasts-run/summary.json)、[命令](checks/committed-notifications.txt) |
| P2.1完整弹层回归 | 96/96，0 skipped/flaky/unexpected | [report](overlays-regression/report.json)、[命令](checks/committed-overlays.txt) |
| 生产构建及原生产路由通知 | 8/8，构建通过 | [report](production-run/report.json)、[命令](checks/committed-production.txt) |
| 原实现新增悬停对照 | 原样复跑16/16，首轮15/16 | [report](original-hover-run/report.json)、[命令](checks/original-hover-repeat.txt) |
| 通知/主题/边界及宿主单测 | 33/33 | [命令](checks/notification-unit.txt) |
| 全量Web单测 | 294文件、3642用例通过 | [命令](checks/committed-full-web.txt) |
| 强制类型检查及独立fixture/测试类型检查 | 通过 | [Web](checks/force-typecheck.txt)、[fixture](checks/fixture-types.txt)、[tests](checks/modified-test-types.txt) |

完整通知矩阵仍验证短提示3秒/结果6秒、错误警告常驻、折叠与关闭、可选择复制诊断、事件/实体去重、撤销一次调用、会话路径跳转、混合堆叠、assertive/polite播报内容及可访问树、主题变化、确认pending/失败/重试、旧AntApp共存、Tab/Esc/焦点归还。全部生产源码在上述实现提交固定后验证，运行期间未修改。

像素核验全部通过：任务起点的24组静态通知、第2版保存的160张原实现动画中点/开关截图、新增8张静止悬停整页截图，共192对PNG零像素差异。8组生产通知与P0通知及12px阴影区域零差异，整页与任务起点零差异。P0原252张基线保持字节不变。比较使用原始PNG全部RGBA像素，无容差；读取区域不改写原图。P0桌面会话列表既有633/638/642/648像素差异仍单列，四张手机整页与P0零差异。

原24组逐帧动画检查共2412帧，卡片位置、尺寸、自身透明度及DOM身份变化为0帧。原8组切层后原生计时均消失；新增8组静止到达均保持6503–6510ms，移开后的轮询消失观测为6303–6331ms。原生轮询值不作为精确期限，5999/6000ms由独立受控时钟用例验证。[代表图片人工审阅](visual-review.json)补充记录卡片内容、堆叠、窄屏和抽屉中点表现。

代表性截图：

- [明色桌面：静止指针下的新通知](toasts-run/chromium-light-desktop--native-stationary-arrival-pauses-beyond-six-seconds-and-moving-away-resumes-dismissal--stationary-arrival.png)
- [暗色手机：静止指针下的新通知](toasts-run/webkit-dark-phone--native-stationary-arrival-pauses-beyond-six-seconds-and-moving-away-resumes-dismissal--stationary-arrival.png)
- [混合常驻、短提示与生命周期卡片](toasts-run/chromium-light-desktop--mixed-pinned-and-passing-notifications-stack-without-overlap-and-retain-all-pinned-errors--mixed-stack.png)
- [抽屉开启动画中点](toasts-run/chromium-light-desktop--notification-pixels-stay-intact-through-Drawer-opening-and-closing--opening-page.png)

## 过程记录与复跑

原实现第一次16项对照中，Chromium暗色手机的布局离开检查未收到预期 mouseover，15项通过。该轮[report、error-context和trace原件](original-hover-first-raw/)已在后续运行前复制；没有修改实现、测试或断言来消除失败。相同命令原样复跑16/16通过；根因尚未确立，不把首轮描述为通过，也不在缺少直接证据时归因于机器负载。

每轮浏览器结果先复制到独立的 `*-raw` 目录，再用原 pass-only collect.py 采集通过报告；失败报告与trace同样完整保留。本次不重复第2版先启动复跑而丢失单轮report/trace的问题。第2版的历史归档缺口说明仍原样保留。本次原生复现JSON、命令日志和每轮附件都有独立路径，audit记录哈希。

```sh
NO_COLOR=1 npm run test:ui-toasts -w @orbit/web
NO_COLOR=1 npm run test:ui-overlays -w @orbit/web
NO_COLOR=1 npm test -w @orbit/web
node node_modules/typescript/bin/tsc -p src/web/ui-migration/toasts.tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p src/web/ui-migration/toasts-tests.tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -b src/web --force
NO_COLOR=1 npm run test:ui-migration -w @orbit/web -- feedback-production.browser.mjs
python3 docs/evidence/base-ui-migration/p2.3/revision-3/prepare-reference.py /tmp/p23-r3-fresh-reference
NO_COLOR=1 node node_modules/@playwright/test/cli.js test --config /tmp/p23-r3-fresh-reference/src/web/ui-migration/reference-hover.config.mjs --grep 'native stationary arrival|layout moving'
python3 docs/evidence/base-ui-migration/p2.3/revision-3/audit.py
```

复跑采集到新目录，不覆盖上述已归档证据。`record-check.py`保存argv、工作目录、起止提交、时间、退出码和原始输出；日志内保留既有NO_COLOR/FORCE_COLOR和大chunk提示。[工具调用引用](checks/tool-call-refs.json)用于结构化证据信封，不用日志文本替代服务端已存命令。

## 边界

Linux手机模拟不证明真机iOS软键盘/原生IME、真实读屏软件发声、系统剪贴板授权或后端鉴权/重连；可访问树及live region内容证据不等于读屏听测。仅验证固定Chromium/WebKit，未扩展旧版浏览器支持。完整P0矩阵未重跑；P0/P2.1既有预期失败与范围明确的跳过未改动。本次不承担P2.2菜单/选择、后续AntApp退役、全站AntD移除或部署发布。

回退 `1b17eaf7d` 会恢复第2版的静止进入问题；历史提交及证据保持可审查。完成证据交独立 EVIDENCE_JUDGMENT 求值，不直接写DONE。
