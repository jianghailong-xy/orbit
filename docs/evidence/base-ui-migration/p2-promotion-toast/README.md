# P2 晋升：通知生命周期与弹层兼容整合

> **证据瘦身（2026-10-07）**：完整原件见提交 `7732f14f82d4e6b4406d7d164c4b672f63aa0f56`（瘦身前最后一个含完整文件的提交）。取回单个文件用 `git show 7732f14f82d4e6b4406d7d164c4b672f63aa0f56:docs/evidence/base-ui-migration/p2-promotion-toast/<路径> > <文件>`，整个目录用 `git archive 7732f14f82d4e6b4406d7d164c4b672f63aa0f56 docs/evidence/base-ui-migration/p2-promotion-toast | tar -x -C <空目录>`。
>
> 本目录在瘦身中：33 份 Playwright 报告换成同目录的 `report.summary.json`，都只删附件正文；删除 18 个 trace 压缩包；1210 个逐用例 JSON（含打包的 attachments.tar.gz）换成所在目录的 `attachments.summary.json`（文件名、字节数、SHA-256 和顶层标量字段）；删除 991 张与本任务目录里保留副本逐字节相同的重复截图。下文链接若指向这些文件，按上面的命令从该提交取回；读取它们的脚本要在取回的目录里运行。
>
> 目录里的 SHA256SUMS 类清单（`*.sha256`、`artifact-index*.json`、`manifest.json`、各运行 `summary.json` 里的附件哈希等）保留原文件，核验的是提交 `7732f14f8` 里的文件。做法、保留理由和逐文件删除清单见 [evidence-slimming](../evidence-slimming/README.md)。

服务于 [晋升冲突修复任务](orbit-task:34a3I43L28Ca0NpMy6Fe8)。验收条目原文：**P2：Orbit 自有弹层、选择及反馈组件保持现有键盘、焦点、通知和确认行为。** key 为 `1BvO6hYrlFnU60JqxQPUHt`。本交付只解决通知晋升冲突及组合行为，不主张整个 P2/P7 完成。

通知实现固定在双亲组合提交 `7dc04c28535cfc4fce8fe786ed7c084f5619549b`，树 `8208a713faa5cbcd2c8032913d5ec1a38a39e737`。测试断言数值表示修正提交为 `2a4159ab8c7c5411bfdb5152f6b0ade7b0d2edc0`。交付前 main 两次推进，故在任务分支原样合入，最终完整验证固定在 **`d6d32fe69a8e331b199f08022979d95d0fc1eb94`**，树 **`d305ba27745d341c017b8f006254014a3f5ba77f`**。Web 生产源码树仍为 `41327e5194cde0c23c6e2f59065000e2f964532e`，与前述通知实现提交相同。之后只归档本目录证据；Web 源码及测试哈希见 [tested-sources.json](tested-sources.json)。最终交付 SHA/树同时由本任务的提交工具调用及完成证据信封记录。

## 双侧来源与冲突处置

开工读取 task_get（当时无评论）、project_get 的 P2 标准，以及 P2.3 全部评论、第1/2次 SEND_BACK、第3版已确认结论和原始复现。交付前再次读取任务评论及项目条目，P2 标准与 key 未变。远端 `ls-remote` 采用的 refs 在 [refs.json](refs.json)：

- 项目 `18e75cfe14d0a0858c9a46e514535439c9cdf9d8`，含 P2.3 第3版落地。
- 开工 main `58c42783b5439d25a6674463170916f131da28de`，含经 PR #115 合入的 `d625d98099e5d577d8d772a0d72b57503bcc77ae` 通知呈现规则；途中推进到 `8ad1916becafefa96619730bd81ec28d03231afe`；最终采用12:32Z复核的 main **`d22b276cccbac66b672e25944be0317d6df420eb`**。
- 共同基线 `618fc69f26b206fa7b83076adce08f6c4edfab83`。

仅在任务分支 `orbit/p2-ca99e8` 执行合并，实际冲突只有两条路径。没有手工修改 main/项目分支、integration_retry、部署或发布。双方完整差异统计与通知补丁在 [diffs/](diffs/)，`delivery-from-*` 对应最终验证组合。主线自动合并带入的 macOS、WorkspaceView、sessionFolders 代码/测试与 main 相同；途中 main 又带入27个服务端、runner、shared文件及2个Swift文件，路径、原因与无差异验证见 [delivery-main-preservation.json](delivery-main-preservation.json) 及任务评论 `34a4NnpTKCGSBfGr0JtVA`、`34a4fSYv8K8qq8rfIbZ6C`。这些范围没有新增本任务改造。Overlay.tsx、feedbackPortal.ts、依赖和已有 choices/toasts/reviews 配置入口未修改。项目 tip 尚未含 P2.2 会话成果，不将它当作已落地代码引入；本交付保留后续平台正常合并的共同祖先。

最终归档时收到P2.2第5版独立CONFIRM交接，随后重新核实：其任务DONE，交付`d71afc686760eb4a37c84822bf1ea478dbe8fcf1`，但第3代落地job `7jnGs3TRFXE6EvTE1UmToQ` 已于12:44:18Z停在MAIN_SYNC的两文件冲突（待办`34a4vmyncNXIaoRhKZvoZ`），并未改变实际项目tip `18e75cfe1`。见 [交接记录](p22-handoff.json)。本任务未修改`.gitignore`、根`package.json`、公共Playwright配置及choices/reviews入口，未重复实现P2.2组件或复制其尚未落地证据。后续由平台组合其公共组件、三份合并配置和第5版历史证据；本轮不把对方独立32/80/24通过作为本任务组合通过，也不为该无差异通知无条件重跑已通过检查。

| 冲突或组合点 | 最终处置 |
| --- | --- |
| ToastViewport import、列表渲染 | 合并两侧 hooks；保留项目稳定 host/manual popover/feedbackPortal，列表采用 main 的 key/id、shown/visible、ToastPresence。单个通知在 transient/pinned 间保持同一 slot，不重复呈现。 |
| index.css 的 `.toast` 入场规则 | 入场留在 main 的 `.toast-slot`；保留项目 `.toast` 的合成层、宿主样式及字体。main 250ms 退场、减少动态效果的淡出和 pointer-events 禁用逐条保留。未使用整文件 ours/theirs。 |
| 动画阶段与重挂 | 原 `toastEnterStart` 改为当前阶段的 `toastAnimationStart`，在 leaving 变化时清除上一阶段的时间和负 delay。重挂继续当前入场/退场进度，退出计时仍是 main 的250ms，不按弹层切换重置。 |
| 悬停退出 | 保留 mouseover（静止指针到达）/mousemove（WebKit 漏边界事件）及幂等 hold；记录当前 dwell 元素。离场/替换后立即 release，排除 leaving slot，避免已失效通知继续暂停全局队列。未改 toastStore 的3000/6000ms及去重规则。 |
| 退场焦点 | 保留 inert/aria-hidden；WebKit 可能暂存旧 activeElement，因此进入退场时 blur 仍在该 slot 内的焦点。动作立即不可由真实点击或键盘继续触发。 |
| 主操作与跳转 | 保留 main 的 attention 主 action 存在时不额外显示 Open session；Copy error、无主 action 的跳转及结果卡片独立 Undo 保持原语义。 |

## 测试断言适配的来源

项目原断言在3000/6000ms要求整个 viewport 已卸载；这与 main 已入库的250ms视觉退场不再同时成立。新增 `toasts-checks.mjs` 在**原期限**检查没有活动 slot、全部离场 slot 已 inert/aria-hidden，再检查249ms仍存在、250ms移除。没有放宽原停留时长、跳过用例或增加 retries。

原布局悬停检查需等常驻卡片的250ms退出才发生重排，因此把关闭后的布局观察点从50ms改为300ms；实际 mouseover 的时间仍是释放计时起点，5999/6000ms断言原样保留。入场帧检查改读 main 的动画宿主 `.toast-slot`，继续要求真实中间帧及最终透明度/变换。全部旧场景仍运行。

main 的新增单测原样保留，另加入没有 mouse boundary event 时关闭悬停结果后，下一条短通知仍按3000ms离场的单测。旧实现该测试失败，局部修复后通过。[修复前单测](checks/mechanical-hover-unit.txt)、[修复后单测](checks/hover-release-unit.txt)保留完整输出。

## 固定提交验证与原始索引

| 检查 | 已验证结果 | 原始记录 |
| --- | --- | --- |
| **最终 `d6d32fe69` Web build + 全量 test** | **295文件、3668用例通过；生产构建通过**，保留原大chunk提示 | [命令及时间/提交](checks/delivery-build-and-test.json)、[完整输出](checks/delivery-build-and-test.txt) |
| **最终 `d6d32fe69` 通知类型检查** | fixture与单测独立类型检查均通过 | [记录](checks/delivery-types.json) |
| **最终 `d6d32fe69` 完整通知矩阵** | **原232 + 新增40 = 272/272**，0 skipped/flaky/unexpected；648个附件 | [原始报告](delivery-notifications-raw/report.json)、[提取索引](latest-toasts-run/summary.json)、[场景来源核对](delivery-matrix-classification.json)、[检查](checks/delivery-notifications.json) |
| **最终附件与来源审计** | 双侧各24组静态像素/样式一致；7812个历史文件原样保留，含252张P0原图 | [完整审计](latest-audit.json)、[检查](checks/delivery-artifact-audit.json) |
| `f232f057c` Web build + 全量 test | 295文件、3668用例通过；生产构建通过，保留原大chunk提示 | [命令及时间/提交](checks/latest-build-and-test.json)、[完整输出](checks/latest-build-and-test.txt) |
| `f232f057c` 通知fixture/相关单测独立类型检查 | 通过 | [记录](checks/latest-types.json) |
| `f232f057c` 完整通知矩阵 | 272/272，0 skipped/flaky/unexpected | [原始报告](latest-notifications-raw/report.json)、[检查](checks/latest-notifications.json) |
| 前一组合 `2a4159ab8` 完整通知矩阵 | 272/272，0 skipped/flaky/unexpected；原232与新增40全部执行 | [summary](toasts-run/summary.json)、[原始报告](final-notifications-raw/report.json)、[检查](checks/final-notifications.json) |
| Chromium桌面 + WebKit手机定向通知检查 | 68/68，0 skipped/flaky/unexpected | [summary](two-browser-smoke/summary.json)、[原始报告](two-browser-smoke-raw/report.json) |
| main及项目原始通知外观对照 | 各24静态 + 8堆叠通过 | [main静态](main-reference/summary.json)、[项目静态](project-reference/summary.json)、[main堆叠](main-stack-reference/summary.json)、[项目堆叠](project-stack-reference/summary.json) |

最终完整矩阵与像素审查结果另见 [validation.json](validation.json) 和 [latest-audit.json](latest-audit.json)；[audit.json](audit.json) 保留前一组合审查原件。固定环境沿用 P0 校验：Node26.10.0、Playwright1.63.0、Chromium1243/WebKit2359、Debian13.7、原字体哈希、DPR1、en-US/UTC，1280×900/390×844和明暗主题。普通测试减少动画，动效用例显式启用正常动画。原生 requestAnimationFrame/计时数据与 Playwright clock 精确期限证据分别保存。

新增5类×8组合：正常/减少动画的退场中嵌套切层；清空后焦点/动作立即失效与249/250ms；主action及同key的 progress→attention→result→attention；未满180ms时入场进度跨模态延续。原232项涵盖静止到达、跨模态保持暂停、移开后6000ms、开关/嵌套弹层、暗色/窄屏、常驻/折叠、撤销/跳转/去重/堆叠、异步确认和旧AntApp共存。

[原生时钟索引](native-clock-index.json)列出全部48份原生记录与48份受控时钟附件：8组静止指针到达后实际等待6504–6510ms仍存在；移开后包含250ms退场及断言轮询，在6305–6357ms观察到DOM移除，跨模态后的原生移除观测为6299–6310ms。受控时钟独立确认5999ms仍活动、6000ms开始离场，以及249/250ms保留/移除，不将轮询观测误称为精确期限。16组原生退场首帧透明度0.996513–1，均保持同一卡片、立即inert/aria-hidden、经历两个模态owner且透明度不回升；首次观察到移除在253.4–269.9ms的帧上。8组入场在模态内仍有中间帧、透明度不倒退。

`*-raw/` 保存每轮原始报告与失败 trace/error-context，采集器不覆盖旧目录。`checks/` 保存 argv、开始/结束提交、时间、退出码和原始stdout；[tool-call-refs.json](checks/tool-call-refs.json)引用本任务会话实际 CommandExecution 行。参考命令的 cwd 是任务树，但真实测试源位于 `/tmp/...-reference`，以各 [main](main-reference-source.json)/[project](project-reference-source.json)/[mechanical](mechanical-reference-source.json) 清单中的源码哈希为准。main参考来自58c，最终静态参考来自2a；审计断言58c→d22及2a→d6的整个Web目录与锁文件均无差异，因此保留这些原始对照，同时在最终d6组合重新执行完整规定矩阵。

归档的浏览器error-context、命令输出、补丁和复现源码含原生尾空格/末尾空行，因此全证据`git diff --check`会报告格式提示；[记录](raw-format-preservation.json)列出原件路径。保留原始字节，不以格式化改写诊断或源码哈希；生产源码及正式测试的差异检查通过。

## 截图与计算样式处置

[审查脚本](audit.py)读取全部RGBA像素，不修改、覆盖、缩放、遮蔽原图，不设置截图容差。双方固定提交各24组静态通知分别与最终组合比较，字体、颜色、渐变、边框、阴影、圆角、尺寸及坐标按原样JSON核对。原P0的252张图及全部P2.3历史证据同时按项目tip逐字节验证。

最终与P2.3第3版的296对历史PNG中，281对整图零差异；15对保留真实差异：[逐项分类](historical-difference-classification.json)。其中8对为下述main已有桌面堆叠顺序变化；7对只涉及通知之外的fixture按钮/确认提交状态，不声称这些整页零差异。此前2a轮还出现过诊断文字选区绘制差异，原图和[人工审阅](visual-review.json)保留，未覆盖为最终图。

堆叠不能笼统宣称与项目旧图一致：main 的统一 `shown.map` 将 “+N more / Show less” 放在全部 slot 之后，桌面临时通知因此上移28.375px；[main原始几何](main-stack-reference/)、[项目原始几何](project-stack-reference/)和最终记录清楚显示来源，保留 main 的有效实现。所有通知仍按8px间隔无重叠，手机仅保留最新临时通知及常驻通知的规则不变。

另外做了同鼠标(0,0)、无焦点、有限动画完成状态的三侧对照：[原始main](settled-main-stack/)、[原始项目](settled-project-stack/)、[最终组合](settled-final-stack/)。main与最终的全部通知及按钮几何/字体/颜色/背景/边框/阴影等计算值相同，唯一声明差异是必须保留的P2.3 `.toast { will-change: transform; }`。为了验证像素来源而非猜测噪声，另建 [隔离诊断参考树](compositing-reference-source.json)：只在main CSS加这条已验收声明，保持main的body portal和其他源码原样。其12对通知加外侧12px阴影区域均零像素差异，11对整页零差异；Chromium明色手机整页仍有93个不同像素，全部位于通知之外的fixture按钮区(y320–392)，不把该整页声称为零差异。诊断树不冒充原始main，所有原始PNG与 [逐项结果](compositing-comparison.json)保留。

审阅过手机嵌套模态中的通知、桌面展开常驻/短提示/结果混合堆叠：卡片、诊断块、按钮与通知间距清楚，手机通知留在视口顶部；暗色手机的opposite-theme截图是在用例中主动切到明色后的有效状态。最终像素明细、历史图差异与附件哈希集中在latest-audit.json。原生入场/退场每帧数据含当前owner、透明度、动画名、delay、进度和DOM身份；它们与截图一起证明合并的实际效果。

## 修复前对照与诊断边界

[机械合并的两份冲突文件](mechanical-merge/) 是保留双侧规则但尚未补组合修复的版本。用修正可见触发器后的有效回归源码在独立参考树执行：Chromium与WebKit均因错误沿用入场 delay 而失败（首帧透明度约0.109/0.227）；报告/trace在 [mechanical-reference-raw](mechanical-reference-raw/report.json)，代码在 [verified-regression.browser.mjs](mechanical-merge/verified-regression.browser.mjs)。数值断言修正后，又将最终测试源码逐字节复制到机械合并参考树复验（[源码](mechanical-merge/verified-regression-2a.browser.mjs)、[原件](mechanical-final-test-raw/report.json)）；仍由两侧共同的起始透明度断言检出缺陷。最终源上的同一用例证明退场从正确进度开始，并在切层后继续而非重播。执行中任务树生成了提交，所以该参考命令的开始/结束 HEAD 不同；参考树内的源码始终未变，清单明确区分。

首轮固定提交完整矩阵为271/272，原232项全部通过。新增手机退场进度断言比较 `0.33315599996317147` 与 `0.33315599996317086` 时失败，两者仅差约6e-16；对应计算透明度相同。最终直接严格断言绘制使用的计算透明度不回升，不设置误差容限，原始 effect progress 仍留在每帧记录中。全部原生期限和249/250ms断言未动。首轮报告与失败 trace 保存在 [committed-notifications-raw](committed-notifications-raw/report.json)，仅用于审查的提取目录 [first-matrix-diagnostic](first-matrix-diagnostic/summary.json) 仍明确记录1项失败；最终报告单独保存。第一次归档审查因 pass-only 采集器拒收该轮失败、最终 toasts-run 尚不存在而未完成，检查日志如实保留。

前期新增测试曾用宽泛 DOM 查询误触 keepMounted 的隐藏 Nested dialog，导致 popover 进入 display:none 祖先。`exit-style-diagnostic`/`exit-host-diagnostic` 原始祖先链、源码和 trace 保留；这些失败不作为产品回归结论。定位改为用户可见按钮后，针对该假象尝试的动画强制重建代码已撤回。`visible-owner-combination` 另外真实观察到 WebKit 已 inert 的按钮仍保有焦点，保留9通过/1失败报告；最终增加局部 blur 后同一断言通过。

初次 overlay 用本树锁文件隔离安装749包，但 Prisma 的共享缓存只读。随后复制缓存到 `/tmp/p2-promotion-toast-cache`，以 XDG_CACHE_HOME 指向独立副本后 overlay 完成；没有安装到共享 node_modules 或构建主仓 shared。网络 refs 查询和本地浏览器监听使用相应授权，未改依赖和全局环境。

## 复现

```sh
XDG_CACHE_HOME=/tmp/p2-promotion-toast-cache bash scripts/worktree-overlay.sh
npm run build -w @orbit/web && npm run test -w @orbit/web
node node_modules/typescript/bin/tsc -p src/web/ui-migration/toasts.tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p src/web/ui-migration/toasts-tests.tsconfig.json --noEmit
NO_COLOR=1 npm run test:ui-toasts -w @orbit/web
python3 docs/evidence/base-ui-migration/p2-promotion-toast/prepare-reference.py 58c42783b5439d25a6674463170916f131da28de /tmp/new-main-reference
node node_modules/@playwright/test/cli.js test --config /tmp/new-main-reference/src/web/ui-migration/toasts-reference.config.mjs
# For the supplementary settled stack comparison, use its saved test unchanged:
cp docs/evidence/base-ui-migration/p2-promotion-toast/settled-stack.browser.mjs /tmp/new-main-reference/src/web/ui-migration/toasts-reference.browser.mjs
node node_modules/@playwright/test/cli.js test --config /tmp/new-main-reference/src/web/ui-migration/toasts-reference.config.mjs --grep 'mixed pinned'
python3 docs/evidence/base-ui-migration/p2-promotion-toast/audit.py
```

参考脚本仅补相同私有fixture所需的迁移组件；两侧 ToastViewport、index.css、toast、toastStore、toastFeed 五个生产文件均与指定提交逐字节匹配，重叠锁定依赖版本核验相同。main 参考只验证可见像素/样式，不声称它已具备项目侧模态可访问性；最终完整矩阵继续用真实可访问region与Tab/Enter断言。重新采集必须用新目录，不覆盖这里或 P0/P2.3 的记录。

## 未建立的结论

Linux手机模拟不等于真机iOS/IME、软键盘、实际读屏听测、系统剪贴板授权、真实后端鉴权/重连。本轮未重跑无关迁移批次或完整P0/P2.1矩阵；其历史预期失败、范围明确跳过及图布局例外保持原记录。没有证明P2.2或全项目P7完成，也没有声称平台已落地或已晋升main；平台应使用本次新交付创建新候选。
