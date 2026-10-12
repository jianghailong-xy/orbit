# P2.2 第5版：按实际关闭生命周期观察滚动就绪

> **证据瘦身（2026-10-07）**：完整原件见提交 `7732f14f82d4e6b4406d7d164c4b672f63aa0f56`（瘦身前最后一个含完整文件的提交）。取回单个文件用 `git show 7732f14f82d4e6b4406d7d164c4b672f63aa0f56:docs/evidence/base-ui-migration/p2.2/revision-5/<路径> > <文件>`，整个目录用 `git archive 7732f14f82d4e6b4406d7d164c4b672f63aa0f56 docs/evidence/base-ui-migration/p2.2/revision-5 | tar -x -C <空目录>`。
>
> 本目录在瘦身中：3 份 Playwright 报告换成同目录的 `report.summary.json`，都只删附件正文；删除 1 个 trace 压缩包；删除被取代修订的 455 个原始运行文件（截图、逐用例 JSON、运行压缩包）。下文链接若指向这些文件，按上面的命令从该提交取回；读取它们的脚本要在取回的目录里运行。
>
> 第 5 版当时判定 CONFIRM，后被第 6–8 版取代，被采用的是[第 8 版](../revision-8/README.md)。本版运行的截图、逐用例 JSON 和协调者复核压缩包 p22-r4-coordinator-review.zip 已删除。
>
> 目录里的 SHA256SUMS 类清单（`*.sha256`、`artifact-index*.json`、`manifest.json`、各运行 `summary.json` 里的附件哈希等）保留原文件，核验的是提交 `7732f14f8` 里的文件。做法、保留理由和逐文件删除清单见 [evidence-slimming](../../evidence-slimming/README.md)。

对应 [P2.2](orbit-task:34Za394q2ZEgr7TKprjkF)、评论 `34a4E3HIdLCDeVF0jdQSr` 和 [第4版 SEND_BACK 决定](coordinator-input/decision.json) `1Sn2OmupIiRIKAOgnVsYea`。项目验收 key `1BvO6hYrlFnU60JqxQPUHt`，原文：**P2：Orbit 自有弹层、选择及反馈组件保持现有键盘、焦点、通知和确认行为。** 本轮仅处理滚动解锁检查的同步边界。

固定实现/测试提交为 `8d78a684b607094e416c18d48c8881492efa0e05`，父提交为 r4 最终交付 `801d41ac9b9ec33671a00190e6f3c77cee22ab94`。仅修改两份 `src/web/ui-migration/` 测试文件，并新增本目录受控对照及证据；组件、fixture、依赖、配置不变。固定提交上原八环境入口32/32、普通/减少动效各40次重复共80/80、生命周期正负对照24/24通过。没有重试、跳过或通用超时调整。后续归档提交只补原件，最终提交及Web树由任务评论和结构化证据记录。

协调者第4版原入口仍为 **31/32**：普通动效解锁发生在 Esc 后105.7ms，首次/最终检查在335.4ms且均无锁，因新增的总时长100ms断言失败，该次没有执行真实滚动。[失败记录](coordinator-input/coordinator-entry-failure.json)、[trace关键事件](coordinator-input/entry-close-trace-events.json)、[原trace](coordinator-input/entry-failure-trace.zip) 保持原样。335.4ms是旧测试检查点，不是旧样本的精确卸载时间，本版不倒填缺失观测。完整 [独立ZIP](coordinator-input/p22-r4-coordinator-review.zip) SHA-256 为 `1e91b059eee392300fbc23948a55c1fa7a493b02785a4117152ccb549c5f4e7e`，其中还包含协调者40/40减少动效及16/16负对照原件。

100ms总时长不是项目产品SLA。已核对本树 Overlay.css 的普通 Dialog 退出过渡为200ms；Base UI 在真实CSS过渡结束后将 popup 的 mounted 置false，节点卸载或带原生hidden属性；滚动锁则由 open=false 的清理排入零延迟任务，两者不保证与测试的首次读值同步。[依据及源码哈希](lifecycle-rationale.json) 保留相关实现和行号。依据这个生命周期，本版保持100ms数值不变，改为**从观察到 popup 实际卸载/hidden 起，仅给异步清理100ms局部窗口**。窗口既不从Esc起，也不从可能较晚的Playwright轮询返回时刻起；不会因一次较慢的关闭动效而消耗掉清理预算。它是测试同步上界，不被写成新的产品标准。

观测在最终Esc前安装：记录Esc、退出状态开始、计算过渡时长、实际卸载/隐藏、首次无锁、原位置首次读值和最终读值。`unlockedAfterMs`继续保留从Esc起的总时长，`closedAfterMs`给出关闭生命周期完成时刻，`readyAfterCloseMs`给出关闭后首次同时满足“已关闭且无锁”的观测间隔。普通动效可能在退出期间就解除锁，因此最后一个间隔为0；物理页面位移另由真实输入确认，不把这个0解释为滚动性能测量。超时或缺失关闭信号仍失败，不改变已有Dialog不可见/焦点等待预算。

原父层仍锁定、逐层焦点归还、几何/退出动效、最终无残留锁、真实输入和滚动后焦点断言全部保留。[补丁](test-only-change.patch) 可逐行核对。真实滚动附件改在解锁断言之前采集，即使解锁上界断言失败也保留该个案的滚动结果。桌面继续wheel，手机浏览器项目继续可信PageDown；仍要求250ms内产生页面位移，没有 `scrollTo`、赋值 `scrollTop`、假时钟或通过sleep等候解锁。

| 固定提交上的实际运行 | 结果 | 从Esc至实际关闭 | 关闭后无锁观测间隔 | 真实输入至位移 |
| --- | --- | --- | --- | --- |
| 原32项入口，其中普通关闭8项 | 32/32整体通过 | 普通238–270.6ms | 普通0ms | 普通6–30ms |
| 原32项入口中的减少动效关闭8项 | 同一轮中的8/8 | 37–55.4ms | 0–11.1ms | 9–34.3ms |
| 普通动效八环境各5次 | 40/40 | 210–265.6ms | 0ms | 3–45ms |
| 减少动效八环境各5次 | 40/40 | 19–53ms | 0–15.4ms | 4–41ms |

[入口原报告](final-entry/report.json) 与 [重复原报告](final-lifecycle-repeat/report.json) 独立保存，共96个产品关闭观测、96个真实滚动记录；入口还有16项原有Dialog组合场景。重复轮次包含本次退回的Chromium亮色桌面普通动效5次，不以减少动效代替普通动效验证。减少动效出现3次原位置首次仍锁定；例如 [暗色桌面第5次](final-lifecycle-repeat/chromium-dark-desktop--reduce-Dialog-Popover-Select-exits-restore-one-layer-at-a-time--repeat-4--scroll-unlock.json)：47.6ms卸载、57.5ms首次仍锁定、63ms无锁，局部清理15.4ms；[可信wheel](final-lifecycle-repeat/chromium-dark-desktop--reduce-Dialog-Popover-Select-exits-restore-one-layer-at-a-time--repeat-4--page-scroll.json) 使页面0→240px。首次锁定值和恢复耗时没有被等待隐藏。

[24项受控对照](lifecycle-controls/report.json) 使用独立标准HTML文档，未改Orbit运行时。8项正对照人为安排150ms渲染调度，再走真实200ms CSS退出；解锁总时长150.7–152ms，节点关闭343.4–367.3ms，关闭时无锁且真实输入可滚动，新检查接受这一合法生命周期。8项负对照在节点移除后再等150ms才解除锁，100ms局部窗口按时拒绝，即使随后恢复也不记为通过；另8项保留锁，可信输入没有页面位移，仍被拒绝。[对照源码](scroll-controls.browser.mjs) 和 [汇总观测](observations.json) 可直接复核。这里的定时器是制造对照条件，不是产品测试中的等待或阈值放宽。

三轮使用同一固定提交、单worker、retries=0、无skip，环境JSON与r4相同（Linux/字体、Playwright1.63.0、Chromium1243/WebKit2359，双浏览器×明暗×桌面/手机）。各轮456份附件哈希核验通过。[发现列表](../checks/r5-list-choices.txt) 仍520项、4文件，[身份审计](discovery-audit.json) 确认project/file/title全部保留；这是发现验证，不是本轮完整520实跑声明。

[源码与历史审计](source-and-history-audit.json) 确认609份运行时文件、构建/类型/依赖/浏览器配置未变，13,094份既有证据逐个Git mode/blob相同。按本次决定许可，复用r3完整build/test（295文件3661测试）、四套类型检查、通知24/24及生产入口8/8和此前视觉证据，不重跑无关全矩阵。r2独立519/520及之后原用例5/5、r3执行者/协调者各31/32、r4执行者32/32与协调者31/32分别保留，不将旧失败改写为通过；r4诊断脚本早期失败也完整保留在原版目录。

命令argv、源码哈希、退出码和完整输出见 `../checks/r5-*.json/.txt`；[tool-call-refs](tool-call-refs.json) 记录本任务会话命令引用，[artifact-index](artifact-index.json) 索引本版原件及命令记录。归档从Git对象再验哈希，确保全部被跟踪。审计可运行 [audit-r5.py](audit-r5.py)。

边界：本轮只建立固定环境中这些关闭组合的证据，不建立所有机器/调度负载的产品时延保证；真机手指滑动、iOS软键盘、原生IME、读屏听测、系统剪贴板授权、真实后端及全站P7未由本轮建立。历史失败的那一次滚动缺失仍如实保留。通知晋升冲突仍由另一任务处理，本轮不改它的实现或集成分支；不改验收标准、不部署发布、不自行写DONE，等待独立判断和平台落地。
