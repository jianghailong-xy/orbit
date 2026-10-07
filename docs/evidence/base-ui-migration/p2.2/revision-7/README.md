# P2.2 第7版：旧 AntApp 确认入口的入场同步

> **证据瘦身（2026-10-07）**：完整原件见提交 `7732f14f82d4e6b4406d7d164c4b672f63aa0f56`（瘦身前最后一个含完整文件的提交）。取回单个文件用 `git show 7732f14f82d4e6b4406d7d164c4b672f63aa0f56:docs/evidence/base-ui-migration/p2.2/revision-7/<路径> > <文件>`，整个目录用 `git archive 7732f14f82d4e6b4406d7d164c4b672f63aa0f56 docs/evidence/base-ui-migration/p2.2/revision-7 | tar -x -C <空目录>`。
>
> 本目录在瘦身中：4 份 Playwright 报告换成同目录的 `report.summary.json`，另有 2 份其他文件名的报告换成 `<原名>.summary.json`，都只删附件正文；删除 54 个 trace 压缩包；删除被取代修订的 101 个原始运行文件（截图、逐用例 JSON、运行压缩包）。下文链接若指向这些文件，按上面的命令从该提交取回；读取它们的脚本要在取回的目录里运行。
>
> 第 7 版当时判定 CONFIRM，后被第 8 版取代，被采用的是[第 8 版](../revision-8/README.md)。本版运行的截图、逐用例 JSON 已删除。
>
> 目录里的 SHA256SUMS 类清单（`*.sha256`、`artifact-index*.json`、`manifest.json`、各运行 `summary.json` 里的附件哈希等）保留原文件，核验的是提交 `7732f14f8` 里的文件。做法、保留理由和逐文件删除清单见 [evidence-slimming](../../evidence-slimming/README.md)。

本版回应限定 SEND_BACK `4CJSgUtIuOOUAfKzYoEoN3`，承接第6版 `ea9191d8165f827c83584087a59f4dfd0cfc2bcd`。验收条目 key `1BvO6hYrlFnU60JqxQPUHt`，原文：**P2：Orbit 自有弹层、选择及反馈组件保持现有键盘、焦点、通知和确认行为。**

自主源码改动仅为 `src/web/ui-migration/toasts.browser.mjs` 旧 AntApp 用例中的两条 CSS 状态断言及两行解释。等待 dialog 的计算透明度为1、transform为none，再执行原来的 `getByRole('button', { name: 'OK', exact: true }).click()`。沿用全局15秒断言预算、90秒用例预算、单worker及retries=0。原可见、真实指针点击、关闭、成功通知、页面错误及截图断言逐字节保留；未增加sleep、强制/脚本点击、skip、retry或动画禁用。原截图仍在关闭及成功通知断言之后，不参与入口同步。

公共组件、通知实现、fixture、样式、依赖及配置没有自主修改。使用角色定位和浏览器计算样式，不读取AntD类名或内部状态。固定实现提交 `daae2304a485c77fecf179bb4e6b65552ecd29c9`；最终被测合并提交 `9ccb09e8661bccaee1779b9eaeb2c7584b47805a`。

## 失败归类与直接观察

协调者首轮通知组合仍记为 **87/88**，不是通过。原未修改用例在第6版树、已验收通知树各5/5复测通过，也不撤销首次失败。[原件收据](coordinator-input/receipt.json)核对29份原始文件的SHA-256和字节数，含失败trace/report/error-context、8张原始入场JPEG、两侧诊断报告和截图；完整独立复核ZIP的原路径及SHA也保留。未复制其整棵源码或重新制造历史目录。

[时序审计](entry-audit.json)从失败trace提取实际输入点与action日志，并关联新增的原生采样：

1. 旧可见断言在 `120299.56ms` 结束；Playwright随后判定OK“visible, enabled and stable”，实际click动作位于 `120327.933–120337.755ms`。原 `120335.058ms` JPEG尚无确认框，`120393.604ms` JPEG仍在展开。旧可见性和局部矩形稳定不等于已绘制完成。
2. 失败输入记录中OK的box为 `(672.7531,364.8000,10.4469,6.4000)`，点击点 `(677.97,368)`。[原用例只读探针](original-entry-probe/summary.json)的5个WebKit暗色桌面样本，以及最终5个相同环境样本，都在真实入场开始时记录到完全相同box：`opacity=0`、`matrix(0.2,0,0,0.2,0,0)`、pending/running动画。此时 `elementFromPoint` 已可以命中OK，故“命中成功”单独也不足以证明可见入口已就绪。
3. 最终40份逐帧采样均记录到：入场早期OK中心点随变换推进失去OK命中。例如WebKit暗色桌面一个样本在动画开始21ms后，该原点已在OK之外，而当前按钮中心仍命中OK。这建立了过早计算的坐标与移动目标之间的实际风险，没有通过合成点击来制造失败。
4. 最终40次 `pointerdown`、`pointerup`、`click` 均为 `isTrusted=true`，事件target属于OK，命中检测也属于OK；click发生时透明度1、transform none且无剩余dialog动画。每个样本随后记录成功通知，原用例也分别断言dialog消失及通知可见。

据此将缺口归类为确认入口与入场动画之间的同步不足。修正直接排除已经观察到的透明/缩放阶段，不改变通知或确认处理逻辑。旧失败trace未记录页面捕获阶段的DOM事件目标，**无法追溯那一次究竟在哪个节点丢失/截获事件**；具体WebKit事件丢失路径仍是推断，不把后续通过次数冒充原失败的事件证明，也未声称修复浏览器内部缺陷。

只读探针通过原生performance/rAF/Web Animations、elementFromPoint及捕获事件记录时序，不改时钟、CSS、动画、交互处理或点击方式。最终诊断文件动态导入实际已提交用例，避免复制后偏离实际入口。最初5次诊断的 `confirmed` 观察器只选了显式role，漏掉隐式section landmark，因此该字段为false；原用例的可见成功断言全部通过，原探针源码及原输出保留。最终40份改用实际aria-label，并额外断言观察到通知。另有一次读取报告的辅助命令误取不存在的repeatEachIndex，退出1；工具引用原样保留，未冒充浏览器失败或通过。

## 定向验证

| 检查 | 固定输入及结果 | 原件 |
| --- | --- | --- |
| 原用例诊断，WebKit暗色桌面 | 第6版源码，5/5；仅用于观察，不覆盖原87/88 | [报告与10份附件](original-entry-probe/summary.json) |
| 同一入口八环境首轮 | `daae2304a`，8/8，无观察器；合并后的全部fixture输入相同 | [报告与16份附件](entry-eight/summary.json) |
| 最终组合有限重复 | `9ccb09e86`，八环境各5次，40/40；原用例+只读观察器 | [报告与120份附件](entry-finite/summary.json) |
| 最终标准Web build/test | `9ccb09e86`，build成功，300文件/3776单测通过 | [命令/源码哈希](../checks/r7-delivery-build-test.json)、[完整日志](../checks/r7-delivery-build-test.txt) |

所有浏览器检查均零skip/flaky/unexpected，每个case只有一次result；`repeat-each=5`为执行前固定的独立样本数，不是失败重试。每次都保存完整trace和截图。Chromium/WebKit、明暗、桌面/手机模拟环境与P0固定OS/字体/浏览器/DPR/locale一致。查看了最终WebKit暗色桌面、亮色手机原始PNG：确认框已关闭，成功通知位置和文字清晰。本版不声称新的全矩阵像素比较。

四套类型、32项选择器、原通知组合中其余80项及第6版8项生产入口复用已经独立通过的对应证据，输入和归属见[第6版说明](../revision-6/README.md)、[本版来源审计](source-audit.json)及[独立复核结果](coordinator-input/independent-summary.json)。本版实际仅重测这一入口，不把复用结果拼成一次新88/88执行。第5版功能CONFIRM `2NaUXLkFqDaKclaHoNTyMk`、通知任务独立CONFIRM `6JwsO3z6CPm66tiYVZUrWd`及原272/272、48组静态对照仍保留原归属。

## MAIN_SYNC 祖先与新增上游

提交前main由第6版采用的 `235787f548d1f49c410f69fdea8c9d27091369b6` 推进到 `53da29cc1e799e1b5a82e98167305d9b41cc54cc`。按原MAIN_SYNC要求原样吸收，最终合并双亲为 `daae2304a` 和 `53da29cc1`，预览/实际树均为 `a641c8db8279ccaff02e281cf312ff41d1554cc9`，无冲突和手工处理。

这笔增量有6个文件，完整补丁在 [upstream-delta.patch](upstream-delta.patch)：CodexResetCredit的一条既有零额度隐藏规则及配套测试、原有脚本断言、三份Swift文件。逐个blob均与main一致，没有独立改写这些业务。因Web源码/单测实际变动，在最终组合重跑标准build/test；相关入口fixture及依赖未变，浏览器复验仍限于本次确认入口。第6版生产通知8项证明其当时组合，不声称涵盖新增额度规则的业务验收。

[来源审计](source-audit.json)证明以下全部为最终分支祖先：已验收P2.2 `d71afc686760eb4a37c84822bf1ea478dbe8fcf1`、通知最终 `59c439e47515f15f581a76318df0ecad6b23e53e`、项目tip `18e75cfe14d0a0858c9a46e514535439c9cdf9d8`、main `53da29cc1e799e1b5a82e98167305d9b41cc54cc`。此前16,634份迁移证据的Git mode/blob完整保留，包括第6版及更早失败。未推送、改写main/project ref或自行落地。

首个归档提交 `38e9e38ee` 的Git对象检查发现两份原始stderr日志被仓库 `*.log` 规则漏收；[首次检查记录](archive-verification-attempt-1.json)保留该缺口，后续显式补入原件，不改其字节、测试输入或执行结果。原日志与error-context中的尾空格也按原字节保留。

执行/审计命令与退出码在 [tool-call-refs.json](tool-call-refs.json)，原命令日志在 `../checks/r7-*`。`audit-source.py`验证来源、祖先、六文件增量及历史保全；`audit-entry.py`验证原始附件SHA和实际入口观测。`artifact-index.json`覆盖本版归档及命令日志；复跑必须用新的输出目录和命令名称，不覆盖这些原件。

本版仍不确立真机iOS、原生IME/软键盘、读屏或全站P7，也不声称平台已合并。按EVIDENCE_JUDGMENT提交第7版，由独立判断产生完成状态。
