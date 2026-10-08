# P2.2 第6版：吸收 upstream，解除 MAIN_SYNC 冲突

> **证据瘦身（2026-10-07）**：完整原件见提交 `7732f14f82d4e6b4406d7d164c4b672f63aa0f56`（瘦身前最后一个含完整文件的提交）。取回单个文件用 `git show 7732f14f82d4e6b4406d7d164c4b672f63aa0f56:docs/evidence/base-ui-migration/p2.2/revision-6/<路径> > <文件>`，整个目录用 `git archive 7732f14f82d4e6b4406d7d164c4b672f63aa0f56 docs/evidence/base-ui-migration/p2.2/revision-6 | tar -x -C <空目录>`。
>
> 本目录在瘦身中：4 份 Playwright 报告换成同目录的 `report.summary.json`，都只删附件正文；删除被取代修订的 368 个原始运行文件（截图、逐用例 JSON、运行压缩包）。下文链接若指向这些文件，按上面的命令从该提交取回；读取它们的脚本要在取回的目录里运行。
>
> 第 6 版（判定 SEND_BACK）已被后续修订取代，被采用的是[第 8 版](../revision-8/README.md)。本版运行的截图、逐用例 JSON 已删除。
>
> 目录里的 SHA256SUMS 类清单（`*.sha256`、`artifact-index*.json`、`manifest.json`、各运行 `summary.json` 里的附件哈希等）保留原文件，核验的是提交 `7732f14f8` 里的文件。做法、保留理由和逐文件删除清单见 [evidence-slimming](../../evidence-slimming/README.md)。

本版服务于 [P2.2 菜单、浮层与选择控件](orbit-task:34Za394q2ZEgr7TKprjkF)，按任务评论 `34a53QxXhvLwZosgGvcaD` 及后续会话交接完成集成。项目验收 key `1BvO6hYrlFnU60JqxQPUHt`，原文：**P2：Orbit 自有弹层、选择及反馈组件保持现有键盘、焦点、通知和确认行为。**

第5版功能证据已由独立会话 CONFIRM（决定 `2NaUXLkFqDaKclaHoNTyMk`）。本轮完整保留该交付，合入[通知晋升冲突修复](orbit-task:34a3I43L28Ca0NpMy6Fe8)的现成实现及最终证据，再吸收执行期间推进的 main。没有重新实现菜单或通知，没有修改已有断言、超时、重试、基线或历史证据。任务由新的 Automatic 会话承接，没有恢复旧会话或创建并行执行。[交接来源](handoff.json)保留证据、决定、评论和会话标识；通知业务修复也已由其原任务独立CONFIRM（决定 `6JwsO3z6CPm66tiYVZUrWd`），完整272项浏览器及48组双侧静态对照保留原归属。

## 来源、祖先与差异

| 角色 | 固定提交 |
| --- | --- |
| 当前任务起点 / 项目 tip | `18e75cfe14d0a0858c9a46e514535439c9cdf9d8` |
| 首先快进接回的 P2.2 已验收交付 | `d71afc686760eb4a37c84822bf1ea478dbe8fcf1` |
| 通知最终归档 head | `59c439e47515f15f581a76318df0ecad6b23e53e` |
| 通知已验证运行时 | `d6d32fe69a8e331b199f08022979d95d0fc1eb94` |
| 首次双亲合并 | `f5fc726d43ebf80fe60c04b6508e8de73643cbbd` |
| 初次读取的远端 main | `d22b276cccbac66b672e25944be0317d6df420eb` |
| 执行期间首次推进的 main | `1970483d2da30c17372c681958a44d1b3da77694` |
| 首次上游增量组合 / 专项浏览器检查来源 | `baec95275814fdeb6a6530fefeb533338a426787` |
| 提交前再次推进、最终采用的 main | `235787f548d1f49c410f69fdea8c9d27091369b6` |
| 最终被测组合提交 | `f096a2bc73db87ffcc242a5493f567a414c9ae71` |

最终被测树为 `7ecc7bc990c57af294b44ce7f8d37eb573a9be92`，Web 树为 `056f9b4ba71b70f8efb54da9f52b87d1925b74db`。之后本轮只新增证据文件；最终归档提交由结构化证据及任务评论记录。没有推送或改写 main/项目 ref，实际落地由平台处理。

[首次合并审计](integration-audit.json)验证双亲恰为 P2.2 和通知最终交付，实际树等于 Git 的无冲突 merge-tree 预览；所有变动 blob 均来自另一父版本，没有手工解决项。P2.2 的52份公共组件/选择器输入与通知的13份相关文件分别原样保留。相对两个父版本的逐文件差异与完整源码补丁在 `from-acceptedP22.*`、`from-notificationDelivery.*`；两侧历史证据分别13,490和10,513份均保持 Git mode/blob。通知归档相对其运行时只新增2,701份原始证据。

执行时 main 新增项目会话导航，改变了 Web/shared，故没有将首次全量检查冒充最终检查。再次原样合入，双亲为 `f5fc726d4` 与 `1970483d2`。[上游增量审计](upstream-audit.json)确认74条变更路径完全对应该 main 增量，除自动合并的 index.css 外每个 blob 都与 main 相同。CSS 只追加90行上游会话导航规则，通知 CSS 原样保留；实际合并树仍与无冲突预览相同，没有独立改造服务端、runner 或原生客户端。`upstream-delta.*` 保存增量。

103份组件、fixture、配置及依赖输入、16,191份既有迁移证据在第二次合并中未变。随后[提交前再次复核](remote-refs-before-commit.txt)检出 main 已到 `235787f54`，祖先命令如实失败；因此又原样吸收该提交的9个审批卡片/滚动相关文件。此轮实际树仍等于无冲突预览，每个增量 blob 均来自 main，没有再次解决通知冲突。[最终审计](delivery-audit.json)记录三次合并后的祖先、变化文件和未变输入；差异见 `delivery-main-delta.patch`。

choices/toasts 两组 scripts、reviews/choices/toasts 输出规则及 P0 排除配置完整保留。依赖按当前 lockfile 私有安装，本树 shared/Prisma/Vite 缓存隔离，未修改 manifest/lockfile。最后一次上游增量未改 shared、依赖、fixture、UI公共组件、ToastViewport 或 index.css。32/88专项浏览器及四套类型的输入可原样复用；真实生产页面和标准 build/test 在最终提交重新运行。[最后的远端复核](remote-refs-delivery.txt)确认 `235787f54` / `18e75cfe1` 都是最终被测提交的祖先。

## 最终组合验证

标准检查及最后一轮生产入口在 `f096a2bc7` 执行；专项 fixture 检查来源为 `baec95275`，其全部输入树与最终组合相同。[最终审计](delivery-audit.json)核对来源、未变输入和附件；[前一组合审计](artifact-audit.json)仍保存当时的独立记录。原始 argv、提交、时间、退出码和 stdout 在 `../checks/r6-*.json/.txt`，可解析工具引用见 [tool-call-refs.json](tool-call-refs.json)。

| 检查 | 结果 | 原件 |
| --- | --- | --- |
| 最终标准 Web build && test | 构建通过，300文件 / 3776测试通过；保留既有大 chunk 提示 | [命令](../checks/r6-delivery-build-test.json)、[日志](../checks/r6-delivery-build-test.txt) |
| choices / overlays / toasts fixture、通知单测类型 | 四套通过 | [记录](../checks/r6-fixture-types.json) |
| 选择器嵌套入口，八环境 | 32/32 | [原报告](choices-entry/report.json)、[索引](choices-entry/summary.json) |
| 通知与弹层组合，八环境 | 88/88：40项晋升回归 + 24项 Dialog/Drawer/底部抽屉 + 24项诊断/异步确认/旧 AntApp | [原报告](notification-combinations/report.json)、[索引](notification-combinations/summary.json) |
| 最终生产构建通知入口，八环境 | 8/8 | [原报告](delivery-production-notifications/report.json)、[索引](delivery-production-notifications/summary.json) |
| 专项发现身份 | choices 520、toasts 272、P0 112；P0 不混入专项 fixture | [发现审计](discovery-audit.json) |

前三轮浏览器执行为32/32、88/88、8/8，最终重跑生产入口也为8/8。四轮均为单次、单 worker、retries=0、零 skipped/flaky/unexpected；沿用固定 Chromium1243/WebKit2359、Playwright1.63.0、Linux/字体、DPR1、UTC/en-US、明暗/桌面/手机八环境。368份浏览器附件逐个核对SHA-256；每轮 environment.json 与P0原件一致。原始 PNG/JSON 不编辑，不改截图基线。

选择器检查保留父层锁、逐层 Esc/焦点、Tab、外部点击/触摸、合成 composition、清除及主题断言。16个最终关闭样本都以可信 wheel 或手机 PageDown 实际滚动：[时序汇总](scroll-observations.json)。普通动效关闭232–291ms，实际关闭时已无锁；减少动效关闭后0–15.5ms观察到无锁。一次首次读值仍锁定，随后按原窗口解除；没有用等待抹掉首次状态。16次输入均在8–31.8ms观察到页面位移，100ms局部清理/250ms滚动窗口及所有原断言不变。

通知检查验证入退场进度在模态切换时保持、退场立即禁用焦点和动作且250ms才移除、相同 slot 身份不重播入场、通知可访问性、复制诊断、异步失败/重试和旧 AntApp 共存。对照截图和实际计算样式断言沿用通知任务实现。人工查看本轮暗色桌面/亮色手机三层选择器整页原图与通知卡片原图，未见新裁切、主题或卡片排版异常；这不是新的全量像素比较声明。

首次组合 `f5fc726d4` 通过 build 与295文件/3668测试，见 [早一轮记录](../checks/r6-final-build-test.json)；`baec95275` 通过 build 与300文件/3768测试，见 [第二轮记录](../checks/r6-upstream-build-test.json)。两轮因 main 推进而由最终检查替代，保留原日志，不混合计数。此前 `baec95275` 的 [8项生产入口](production-notifications/report.json)也原样保存。

## 复用与证据边界

Menu、Popover、Tooltip、Select/Combobox/MultiSelect 的功能及手机附件菜单42.4px行高、17px字、26px圆角，继续以已验收 [r2](../revision-2/README.md) 与 [r5](../revision-5/README.md) 为组件保真证据；其实现和输入逐字节保留。本轮只补组合检查，没有重新运行完整520项选择器矩阵、80次关闭重复、24项生命周期对照或完整272通知矩阵。520/272/112是本轮发现计数，实际浏览器执行为32+88及两轮不同组合上的8项生产入口。通知完整272原件来自其[独立任务归档](../../p2-promotion-toast/README.md)。

历史失败全部保留：r2独立519/520及原用例随后5/5；r3执行者/协调者各31/32；r4协调者31/32及旧失败缺失实际滚动；早期诊断错误和原始 trace 不改写。r5独立32/32、80/80、24/24仍按其原始固定输入解释。P0既有8项像素失败、16项预期焦点失败及11项范围明确跳过不因本轮8项生产通知通过而消失。

手机项目是 Linux 浏览器设备模拟；可信 PageDown 不等于真机手指拖动。真机 iOS/软键盘、原生 IME、读屏听测、系统剪贴板授权、真实后端鉴权/重连及全站 P7不由本轮确立。本交付不替代通知任务的独立业务判定，也不声称平台已实际落地。新一版仍提交 EVIDENCE_JUDGMENT，由独立会话判断；未直接写 DONE、部署或发布。

复核来源与附件可执行 `python3 docs/evidence/base-ui-migration/p2.2/revision-6/audit-integration.py`、`audit-upstream.py`、`audit-delivery.py`（后两者同目录）。`audit-artifacts.py`是此前 `baec95275` 上的原审计源码，保留其原始适用范围。实际测试命令在各检查 JSON；复跑请使用新的输出目录和记录名称，保留本次及历史原件。
