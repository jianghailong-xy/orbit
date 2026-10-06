# P2.2 第4版：验证异步解锁的时限和实际滚动

对应 [P2.2](orbit-task:34Za394q2ZEgr7TKprjkF)、返工评论 `34a3GPknMykOXpXBtg6Ua` 和 r3 SEND_BACK 决定 `6UJ5y55Qlsm5WDeOGbLp2h`。项目验收 key `1BvO6hYrlFnU60JqxQPUHt`，原文：**P2：Orbit 自有弹层、选择及反馈组件保持现有键盘、焦点、通知和确认行为。** 本版仅补该任务的最终关闭、及时解除滚动锁及实际可滚动证据。

结论：未改运行时的诊断捕获到了原断言位置仍锁定、随后及时解锁和真实滚动的完整过程，支持即时读值抢在异步清理前的判断；没有证据要求修改组件。固定测试提交 `2bd040fe3bc642cdb53460539146e25eb4e8aad2` 的八环境32项原入口、40项减少动效重复均通过，retries=0、无跳过。本说明和原件作为后续独立归档提交，不改变被测 Web 树。

相对 r3 最终提交 `489941cf0942f71edad00ecbc14d5a53aeb5da0b`，仅修改 `src/web/ui-migration/choices-lifecycle.browser.mjs` 的最后一条即时解锁检查并加入测试观测 helper。原父层仍锁定、逐层不可见/获焦、动效和几何断言保留，增加滚动后焦点仍归还断言。[完整补丁](test-only-change.patch) 可核对每行。609份 `src/web/src` 文件、依赖/锁文件、构建/类型/Vite/Playwright配置不变；12,586份已有证据逐个 Git mode/blob 相同。见 [源码与历史审计](source-and-history-audit.json) 和 [可重跑脚本](audit-r4.py)。

固定依赖 `ScrollLocker.release` 使用 `timeoutUnlock.start(0, this.unlock)`；本机文件 SHA-256 与协调者审查记录相同。此前执行者亮色桌面31/32、协调者暗色桌面31/32都保留为失败，执行者后续5/5没有覆盖它们。协调者 [原决定](coordinator-input/decision.json)、[独立失败](coordinator-input/coordinator-scroll-independent-failure.json)、[旧 trace 比较](coordinator-input/coordinator-scroll-trace-review.json) 和 [完整 ZIP](coordinator-input/p22-r3-coordinator-review.zip) 原样归档；ZIP SHA-256 为 `fc73b225948d6f5a18a635b8d7f77703fd41adf31c78b61674c608fb038dfbdf`。独立旧 trace 在失败后很快结束，本版不声称补出了那一次缺失的后续帧。

在任何正式测试修改前，先用相同用例和未改的 r3 运行时诊断。第二轮中 Chromium 亮色手机、减少动效场景在最终 Esc 后 **56ms** 的原检查位置仍得到 BODY `overflow-y: hidden`，**58.6ms** 时样式变动观测到 `auto`，仅相隔 **2.6ms**；随后可信 `PageDown` 输入在 **27.7ms** 内使页面从0滚至43px。[首次读值及解除记录](diagnosis-native-input/chromium-light-phone--reduce-Dialog-Popover-Select-exits-restore-one-layer-at-a-time--scroll-unlock.json)、[实际滚动记录](diagnosis-native-input/chromium-light-phone--reduce-Dialog-Popover-Select-exits-restore-one-layer-at-a-time--page-scroll.json) 给出同一用例的直接证据。不是仅用原用例重复变绿推断恢复。

观测方法使用浏览器 `performance.now()` 和 HTML/BODY 属性变化：在最后一次 Esc 前安装观察器，从 Esc 捕获阶段开始计时；仍在原来的“Dialog不可见、触发器获焦”后读取首次状态并保存。要求在 **100ms** 内观察到锁解除，再读取最终状态确认无锁；到界限仍锁定则失败。这个上界覆盖零延迟清理及已测调度时间，且从关闭按键开始计算，没有额外等待200ms退出动画或沿用15秒通用 expect 超时。之后通过浏览器可信输入，要求在 **250ms** 内收到页面实际位移并保持触发器焦点。两处时限都在证据中记录，没有 sleep、假时钟、通用超时调整或重试。

桌面使用 wheel，手机浏览器项目使用 PageDown。Playwright 明确不支持 mobile WebKit 的 wheel，因此初版诊断的4个 WebKit手机用例在发送输入时失败；16个用例都已先记录及时解锁。修正输入方式后16/16通过，正式测试沿用这份已验证的 helper。PageDown 是可信浏览器输入，未使用 `scrollTo`、赋值 `scrollTop` 或合成滚动事件；它证明页面能实际滚动，不声称验证了真机手指拖动。

| 本版各轮，均保留原件 | 结果 | 解锁 / 实际位移时间 | 报告 |
| --- | --- | --- | --- |
| 未改运行时，初版 wheel 诊断 | 12通过/4失败；4项为 mobile WebKit 不支持 wheel | 全16项解锁20–57.8ms；12项位移23.2–32.2ms | [原报告](diagnosis-first/report.json) |
| 未改运行时，匹配浏览器输入 | 16/16；含上述首次仍锁定样本 | 解锁26–59.6ms；位移5–32.1ms | [原报告](diagnosis-native-input/report.json) |
| 固定提交，原32项入口 | 32/32；16项嵌套关闭有新增解锁/滚动观测 | 解锁21–60.1ms；位移6–32ms | [原报告](final-entry/report.json) |
| 固定提交，reduce关闭每环境5次 | 40/40 | 解锁19–67.3ms；位移4–31.5ms | [原报告](final-reduced-repeat/report.json) |
| 观测方法负对照初版 | 8通过/8失败；受控空白页漏DOCTYPE，retained用例的 `scrollingElement` 为null | late用例均识别超过100ms；残留锁的滚动验证尚未执行 | [原报告](negative-control-first/report.json) |
| 负对照标准文档 | 16/16 | 8项识别150ms迟解锁；8项识别残留锁并确认可信输入无位移 | [原报告](negative-control-standard/report.json) |

两个负对照只操纵独立测试文档，不修改 fixture、组件或依赖。标准文档版仅补DOCTYPE并明确断言CSS1Compat，旧版脚本和失败 trace仍保留。迟解锁虽然最终恢复也会被100ms观测拒绝；永久锁即使收到可信输入也不会产生位移。这验证新检查不能把迟解锁或残留锁记为通过。各轮源码快照在本目录 `scroll-*.mjs` 中，初版诊断输入另有 [预先记录的哈希](diagnostic-inputs.json)。全部448个运行附件的摘要核验及逐条首次状态、耗时和位移见 [观测汇总](observations.json)。最终两个产品用例轮次共56个解锁样本，首次读取时均已解除；不能把诊断那一个仍锁定样本计入最终提交轮次。

所有轮次使用固定 Linux、字体、Playwright 1.63.0、Chromium1243/WebKit2359，八环境是双浏览器×明暗×桌面/手机，环境 JSON 与 r3 完全相同。没有更新任何历史截图或容差。[发现列表](../checks/r4-list-choices.txt) 仍为520项、4文件；[发现审计](discovery-audit.json) 确认每个 project/file/title 与 r3 一致，helper没有新增测试收集入口。520是发现数，不是本轮全矩阵实跑数。

按本次 SEND_BACK 明确许可，复用 r3 完整 `build && test` 的295文件/3661测试、四套类型检查、通知24/24及生产入口8/8。协调者独立同项检查也已通过，且本版审计确认相关源码/配置字节不变。本版没有重跑无关全矩阵。继续复用 [r2](../revision-2/README.md) 的外观、手机附件密度、动效及搜索/清除/禁用/分组/输入法与触摸行为证据，并保留 **r2独立完整520项中519通过/1动效采集超时，之后原失败用例5/5** 的边界，不改写为全绿。r3集成详情与原始31/32仍见 [r3](../revision-3/README.md)。

命令 argv、源码哈希、退出码、完整输出在 `../checks/r4-*.json/.txt`，本任务会话真实命令行引用在 [tool-call-refs](tool-call-refs.json)。[artifact-index](artifact-index.json) 索引本版原件及命令记录；归档后核对Git对象和哈希，避免忽略规则漏掉日志。最终提交由任务评论及第4版结构化证据记录。

边界：这些是固定环境的有限样本，不是所有调度负载的时延保证。历史两次失败没有被覆盖；本轮诊断工具的两类初始失败也没有计为通过。不宣称全站P7、原生iOS/软键盘/真实IME、真实手指滑动、读屏听测、系统剪贴板授权或真实后端通过。仍由独立 EVIDENCE_JUDGMENT 决定验收，本会话不写DONE、不修改项目验收标准、不部署或发布。
