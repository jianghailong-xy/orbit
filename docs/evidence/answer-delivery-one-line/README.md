# 转给协调者的答复消息画成一行 · 证据

任务 [转给协调者的答复消息画成一行，不再画成 owner 的气泡](orbit-task:34dQVoIQtWgVP0Ol03o3x)；设计图 `docs/mocks/coordinator-question-answered/` 的「落地」第 4 条与 `5-landing.png` 右侧；合同 `docs/project-integration-line-contract.md` §5.2 R10 与附录 B 修订 22。

owner 答完协调者的提问（或用 Not yet… 退回项目收尾请求）后，服务端投给协调会话的那条 `From Orbit · owner answer: you asked "…"` 消息，现在由客户端从轮次旁的 `ownerAnswer` 卡画成一行灰胶囊 `Sent to the coordinator · HH:mm`，点开才是给 agent 的原文；消息文本一字不改。代码在提交 `7aa1e5de0`。

> 2026-10-16 rebase 到 main `727735109`（当时已前进 318 个提交，冲突 6 个文件全部解在 feature 提交里）：代码提交变成 `3b9847181`，合同条目重编为修订 22（main 上 17 已另有其文）。本文中凡写 `7aa1e5de0` 的验证记录（pg spec、OrbitKit、Android 本机门、CI）都是 rebase 之前在那个提交上做的；rebase 后的树另行复跑，结果记在同一目录的 `rebase-checks.txt`。

## 服务端

- 卡：`@orbit/shared` 的 `OwnerAnswerCard`（`itemId`、`kind`、`sessionId`、`deliveredAt`）。`project-open-item.ts` 的 `ownerAnswerCardOfTurn` 从轮次键读出条目和会话（两段都必须是 uuid，否则不读库——这一命名空间没有在门上保留，事件入库路径上不能因为一个调用方自己起的键抛错），`readOwnerAnswerCard` 读**这个会话**那条 ANSWER 投递行与它的条目，时间取投递行的 `created_at`。`turn-cards.ts` 只在键里的会话就是轮次所在会话时读它；排队的两种视图与 runner 回显入库（`withOwnerAnswer`，runner 送来的同名字段一律丢弃）读同一个函数。
- 新 pg spec `src/apiserver/src/projects/owner-answer-turn-card.pg.spec.ts`，`scripts/run-pg-spec.sh` 跑，5/5（含父用例）：
  1. 协调者提问的答复：排队视图、active 视图、交给 runner 之后的 accepted 行、回显入库四处的卡逐字段相同，且等于投递行算出来的卡；交给 runner 的文本仍以原消息开头（后面是协调会话的常驻角色块）。
  2. 项目收尾请求被 Not yet… 退回：同上，`kind = DONE_REQUEST`。
  3. 普通 owner 消息没有卡；用这个命名空间自己起的键（没有投递行）、键里写的是别的会话、键不是 uuid，三者都没有卡；runner 送来的假卡被丢弃，入库不报错。
  4. 卡上时间取该会话那条 ANSWER 投递：第一任协调者的投递行改到两小时前，轮换后补投给新会话（R11）；新会话卡上的时间是它自己的投递行时刻，晚于答复时刻、比第一任的晚一个多小时；第一任会话的回显仍是它自己的时间。
- 受影响的既有 pg spec（与新 spec 同一次运行，提交后的代码）：`turn-cards-parity.pg.spec.ts` 11/11（新增 `ownerAnswer` 一例，`CARD_FIELDS` 按 `TurnCards` 编译期钉住）、`blocking-request-replies.pg.spec.ts` 10/10、`project-done-not-yet.pg.spec.ts` 8/8、`task-run-resume-card.pg.spec.ts` 4/4。
- apiserver 单测 5156/5156（含新的 `owner-answer-turn-card.spec.ts`：键的往返、各种不是答复的键、`withOwnerAnswer`）。

## Web（协调会话）

本分支自己的 vite 开发服务器跑 `src/web`，`/api` 用仓库的 ui-migration 夹具再叠一个协调会话（`web-rig/`，Playwright，headless Chromium，en-GB、Asia/Shanghai，1440×1120@2x，时钟固定在夹具的 2026-09-28 20:00）。`web-rig/capture.log` 是脚本自己读出的页面事实：每张图都没有页面错误、没有未处理的请求。

| 图 | 对照设计图第 4 步 | 看什么 |
|---|---|---|
| `web-line-light.png`、`web-line-dark.png` | `5-landing.png` 右侧 | 答完的 Answered 卡下面一行居中的灰胶囊 `→ Sent to the coordinator · 19:29 ›`，接着是协调者的回复；对话里唯一的蓝气泡是 owner 自己打的那句话，没有重播问题、没有 ISO 时间 |
| `web-opened-light.png` | 「点这一行，打开协调者收到的原文」 | 点胶囊：箭头转下，下面是 `What the coordinator was told` 和给 agent 的原文（问题全文、答复、ISO 时间），原样 |
| `web-queued-light.png` | — | 答复还排在协调者正在跑的那一轮后面：同一行，虚线描边，下面是队列自己的 `Queued for next turn · Cancel` |

## iOS（iPhone 模拟器）

真实的 iPhone 应用：GitHub `macos-26` 运行器上，用 XcodeGen 把 `src/ios/Sources` 的 `CompactShell` 和共用的 `src/macos/OrbitApp` 源码编成一个一次性应用（入口换成 `probe-harness/ios/OalProbe.swift`），`-orbit.instance` 指向夹具 API `probe-harness/stub.py`，XCUITest（`probe-harness/UITests/LineShotTests.swift`）驱动并截图。夹具里那条轮次的文字就是 `ownerAnswerMessage` / `doneRequestDeclineMessage` 写出的原文，卡就是 `readOwnerAnswerCard` 记下的四个字段。probe 分支 `probe/answer-delivery-one-line`（提交 `32e5d1fd9` = `7aa1e5de0` + 夹具与工作流，不合并），结果推到 `probe/answer-delivery-one-line-results`；运行 [38045204559](https://github.com/jianghailong-xy/orbit/actions/runs/38045204559)，5 个 UI 测试全部通过，同一次运行里 macOS 上 OrbitKit `swift test` 通过、OrbitApp `swift build` 通过、iOS 应用的 Simulator 构建通过（`probe-results.txt`）。应用以 en_GB、Asia/Shanghai 启动；每个测试都在找不到那一行、或对话里出现给 agent 的原文时判失败，不只是记一笔。

| 图 | 对照设计图第 4 步 | 看什么 |
|---|---|---|
| `ios-01-answered-then-line.png`、`ios-01b-the-line.png` | `5-landing.png` 右侧 | Answered 卡（08:29）下面一行居中灰胶囊 `→ Sent to the coordinator · 08:29 ›`，接着是协调者的回复；对话里唯一的蓝气泡是 owner 自己打的那句话。`ios-01b` 是那一行的特写 |
| `ios-02-told-sheet.png` | 「点这一行，打开协调者收到的原文」 | 点那一行弹出的 sheet：标题 `What the coordinator was told`，先是那一行的字，下面是给 agent 的原文（问题全文、所选项、ISO 时间），原样，可选中；关掉后对话里仍没有这段字 |
| `ios-03-not-yet-line.png`、`ios-03b-not-yet-sheet.png` | 同上（`deliverDoneRequestDecline`） | owner 用 Not yet… 退回项目收尾请求：同一句 `Sent to the coordinator · 08:41`，点开是 `From Orbit · owner says not yet …` 原文 |
| `ios-04-queued-line.png` | — | 答复还排在协调者正在跑的那一轮后面：同一行，虚线描边，下面是 `Queued` 与 `Cancel` |
| `ios-05-line-en-us.png`（附加） | — | 同一个会话、设备区域换成 en_US：那一行写 `8:29 AM`。这一行沿用「Sent to the coordinator」现成的回执时钟（跟设备区域走），而 Answered 卡用的是固定 24 小时制（`OwnerConfirmations.receiptTime`），所以在 12 小时制的设备上两处写法不同；24 小时制的设备上两处都是 `08:29` |

## Android

- 新增：`OwnerAnswerLineTest`（core：卡的投影、不是卡的各种 payload、`Sent to the coordinator · 08:29` / 跨天带日期）、`OwnerAnswerLineViewTest`（Robolectric：读者里画成那一行、点开是原文对话框、排队中同一行带 Cancel、没有 You）、`OwnerAnswerCopyParityTest`（字与 OrbitKit `OwnerAnswer.swift`、web `OwnerAnswerLine.tsx` 逐字对照，那一行就是 web 的 `sentToCoordinatorLine`）、`QueuedTailTest` 与 `StickySummaryTest` 各加一例（排队行带卡、这一行不当 sticky 锚点）。
- 本机全量门（`verify.sh` 的 `test lintDebug assembleDebug`，提交 `7aa1e5de0`）：core 205、app debug 1221、app release 1221，0 失败；lint 报告与 debug APK 产出。第一次跑时 `ProjectMergeShellTest.aBlockedCandidateNobodyHoldsHasNoResolvingPress`（项目页合入卡，与本任务无关）在负载 17 时等 60 秒超时，同一提交单独重跑 11/11 通过，再跑全量门通过。
- GitHub 的 Android CI 在 probe 提交 `32e5d1fd9`（Android 部分与 `7aa1e5de0` 相同）上也通过：运行 [38045204608](https://github.com/jianghailong-xy/orbit/actions/runs/38045204608)，Android (test + lint + debug APK)。

## 测试一览

- OrbitKit：docker `swift:6.1` 里全量 `swift test` 3679 个，0 失败（5 个 PerfBaseline 照旧跳过）。新增 `OwnerAnswerTests`（解析、回显、快照、那一行、sticky）、`OwnerAnswerCopyParityTests`（字段名与 shared 声明、读法与 web 读法、那一行与 web 的 `sentToCoordinatorLine` 模板逐字）；普查类的 `QueuedTurnCardsTests`、`AcceptedTurnPlaceholderTests`、`UserTurnRowWiringTests` 各补上新卡。
- Web：全量 vitest 396 个文件、5163 个用例全绿（最终的提交）；新增 `OwnerAnswerLine.test.tsx`，普查类的 `QueuedUserTurn.test.tsx`、`WorkspaceView.taskStartWaiting.test.tsx` 补上新卡（排队、accepted 占位、回显三处画同一行）。

## 与设计图的出入

- 时间沿用各端「Sent to the coordinator」那一行现成的写法，没有另起：web 是 `decisionReceiptTime`、iOS / macOS 是 `EvidenceDecisions.receiptTime`，都跟设备的区域设置走（24 小时制的区域里是 `08:29`，en_US 是 `8:29 AM`，见 `ios-05`）；Android 是 `OwnerReview.receiptTime` 的固定 24 小时制。截图用 24 小时制的英文区域，与设计图的 `08:29` 同形。Answered 卡的时间一直是固定 24 小时制，所以 12 小时制设备上卡与这一行的写法不一样；要统一，是改「Sent to the coordinator」这句在 web / iOS 上的时钟（证据卡转交那一行也会跟着变），不在本任务。
- 点开的方式各端各用自己的现成做法：web 是原生 `<details>` 就地展开（静态导出里也能点开），iOS / macOS 是控制台托管的 sheet（同合入回执那一行，列表行被回收也不会把它关掉），Android 是对话框。
- 这一行不当 sticky 条的锚点（与 wake 那几行一样，是协调者工作中的一行，不是新一轮的开头）。
- 同一轮次上若还捎带了这个会话自己发出的请求的结果（`sessionReplies`），画成这一行加回复卡，不画气泡。
