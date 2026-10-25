# 协调者停着时，证据卡排队等它 · iOS / macOS（T3）证据

任务 [T3 iOS / macOS：排队卡、弹出页、胶囊](orbit-task:34cypwBO5kaUgiNSZIGQP)，项目 [协调者停着时，证据卡排队等它](orbit-project:34cygPTQe5LPUT7tdUAzG)。设计图 `docs/mocks/evidence-waits-for-coordinator/`（`phone-queued.png`、`phone-sheet.png`、`phone-back.png`）；线上契约与文案见项目作业指导，文案常量以 T2 的 `src/web/src/components/EvidenceDecisionCard.tsx` 为准。

## 截图怎么来的

真实的 iPhone 应用：GitHub `macos-26` 运行器上，用 XcodeGen 把 `src/ios/Sources` 的 `CompactShell` 和共用的 `src/macos/OrbitApp` 源码编成一个一次性应用（入口换成 `probe-harness/ios/EwcProbe.swift`），用 `-orbit.instance` 指向夹具 API `probe-harness/stub.py`，XCUITest（`probe-harness/UITests/QueueShotTests.swift`）驱动并截图。probe 分支 `probe/evidence-waits-t3-apple` 不合并，结果推到 `probe/evidence-waits-t3-apple-results`。

夹具：一个协调会话 C1（项目「Tablet 客户端：与 iOS 体验对齐」），协调者 1 小时 51 分钟前在 claude 上撞了周额度——run FAILED，错误文本是运行时原话，重试排在三天后 19:00（上海时间）；任务 B07c 刚交的第 1 版证据在 `waitingOnCoordinator` 里。`pendingApprovals` 为 0。时间都是真实时钟（上海时区），状态栏在每个用例开始前设成同一时刻。

每种状态都由应用自己的读和按键走到：折叠卡来自 pending 读；弹出页来自点 Decide it myself；「已投」是测试把夹具切到「协调者回来、已投给它」之后，应用自己的两次读——每 4 秒一次的会话列表、控制台每 20 秒一次的 pending 重读——把折叠卡原地变成胶囊。

| 图 | 对照设计图 | 看什么 |
|---|---|---|
| `queued-light.png`、`queued-dark.png` | `phone-queued.png` | 原来证据卡的位置画一张灰色折叠卡：沙漏、`Waiting for the coordinator`，右边提交时间；任务标题（最多两行）；橙色停机行 `Coordinator paused · weekly limit · resets <回执时钟>`（窗口取 `AutoRetryLogic.quotaWindowKind`，与上面那张 Weekly limit reached 同一判断；时间取会话的 `retryAt`）；灰字 `It goes to the coordinator when it’s back. You can still decide now.`；分隔线下 `Decide it myself ›`。会话头是 `Retrying · Open · 1h ago`，顶上没有「open question」条 |
| `sheet-light.png`、`sheet-dark.png` | `phone-sheet.png` | 点 Decide it myself 弹出的页：标题 `Waiting for the coordinator`，`From Orbit`，橙框里先是停机行，下面 `It gets this when it’s back. Decide here only if you don’t want to wait.`；然后是今天那张卡：`Does this evidence settle the task?`、任务、WHAT IT HAS TO SATISFY、缺口（9 条，显示 3 条并计数）、检查、说明；底部固定 Confirm done 与 Chat about this，下面是送回说明 |
| `sent-light.png`、`sent-dark.png` | `phone-back.png` | 协调者回来、这一版投出去以后，折叠卡原地收成胶囊 `→ Sent to the coordinator · <回执时钟>`，在投递消息（带 T1 那句 This revision was submitted at … while you were unavailable）上面；额度卡退成只有诊断的旧卡；会话头 `Waiting for your reply · Open · just now` |
| `back-light.png`、`back-dark.png`（附加） | — | 切换之后、pending 重读之前的一刻：会话已经回来，折叠卡的停机行变成灰色 `Coordinator is back · it gets this when its current turn ends` |
| `decided-light.png`（附加） | — | 从弹出页按 Confirm done：请求体是 `decidingSessionId: C1`、`evidenceRevision: "1"`、`decision: CONFIRM`（夹具日志逐字段核对），弹出页收成回执后关闭，对话里留下 `Decision recorded` / `Confirm done · rev 1 · <时刻>`，折叠卡消失 |

与设计图的出入（都按项目文案与 Web 的做法）：

- 胶囊不可点，所以没画设计图上的 `›`（Web 同样如此）。
- 弹出页顶部只有 `From Orbit`，没有设计图的 `submitted 7:59 PM`：项目文案里没有这句；提交时间在折叠卡标题行的右边。
- 时间用 iOS 回执的格式（`EvidenceDecisions.receiptTime`：当天只写时刻，否则短日期加时刻，如 `10/13/26, 7:00 PM`），设计图写的是 `Oct 12, 7:00 PM`。作业指导：时间格式沿用各端回执的时间格式。
- 折叠卡由首屏之后的那次读送来；对话列表只跟随自己的行、不跟随送来的卡（今天的证据卡也是这样），所以卡的最后一行起初可能在输入框下面。截图前用户式地往上拖一下，让整张卡露出来。按项目规则排队卡不计数，所以顶上也没有条指向它。
- `decided-light.png` 里回执画在额度卡上面：回执按自己的时刻放在「最后一个带时刻的行」之后，而额度卡这一行没有时刻（`ReceiptAnchor` 的现有规则），这次没改。

## 实现要点

- OrbitKit `EvidenceDecision.swift`：pending 读解码 `waitingOnCoordinator`、`sentToCoordinator`（缺失或读不懂都当空）和每行的 `submittedAt`；一版证据一张卡，standing 依次看 pending、sent、waiting（Web 的 `evidenceSlot`），新增 `.waiting`（可判、不算 open）和 `.sent`（不可判、不算 open）；只排过队、后来从读里消失的版本放手（`letsGo`），问过或打开过的留下解释；停机行 `coordinatorPause` / `pauseLine`，胶囊 `sentLine`；新文案常量与 Web 逐字一致。
- `AutoRetryLogic.quotaWindowKind`：从 `quotaWindow` 拆出来，额度卡和停机行共用一个判断。
- OrbitApp `ApprovalCards.swift`：证据卡就是这一版的位置——已投画胶囊，排队画折叠卡（`QueuedEvidenceCard`），在弹出页里画成可滚动的今天那张卡并在顶上加停机提示；Chat about this 在弹出页里先关页再交给输入框。
- `ConsoleModel.swift`：两组按今天证据卡的锚点规则送进对话（同一个 `.evidenceDecision`，到达时锚定）；`coordinatorPause` 取自会话自己的行；回复上下文用 `holdsReply`（排队中打开的版本仍可送回）；`openBelowRows` 用 `isOpen`，排队和已投都不计；协调者停着或有排队、已投的版本时，每 20 秒重读一次 pending（会话行在这些时刻不变，没有别的东西会触发重读；Web 也是 20 秒）。会话头只读服务端的 `pendingApprovals`，排队卡本来就不在里面。
- macOS 用同一套视图；弹出页是同一个 `ApprovalReviewSheet`（Mac 上最小 520×560）。

## 测试与构建

都在本分支的最终代码上（产品代码 `ab00b9ce7`，加测试修正 `b3b5e4017`），作业号可在任务证据里核对：

- OrbitKit 全量 `swift test`，swift:6.1 docker，整个工作树拷进去（parity 测试读 `src/web`、`src/shared`）：`bgj_494de21a0e7c`，3603 个用例，0 失败，5 个跳过（都是 PerfBaselineTests，不设性能基线环境时本来就跳过，macOS 上同样）。新增 15 个用例：文案对照 3（读 Web 常量和 `lib/quotaWindow.ts`）、解码与停机行等 8（含读共享夹具 `interaction-cards.fixture.json`）、接线 3、不计数 1（`NeedsYouLogicTests.testAVersionWaitingForTheCoordinatorIsNotCounted`）；`ComposerHandoffWiringTests` 里钉 `isOpen` 的那条随实现改成 `holdsReply`。
- 反证：`bgj_e5d8122ce932`，八处临时改坏（排队算 open、文案撇号走样、非额度失败也写窗口、不解码 sentToCoordinator、只排过队的版本留旧卡、停着不重读、排队中打开的回复被清掉、控制台不定时重读），每处都让预期的用例变红，改回后全绿。
- probe CI（GitHub Actions，`probe/evidence-waits-t3-apple`，细节在 `probe-results.txt`）：
  - 第二轮 [run 37994710793](https://github.com/jianghailong-xy/orbit/actions/runs/37994710793)（`b1876bb` = `b3b5e4017` + `probe-harness/`，本目录的图都出自这一轮）：全绿。macOS 15 上 OrbitKit `swift test` 3603 个 0 失败、OrbitApp `swift build` 成功；iOS 应用 `xcodebuild` 模拟器构建成功；iPhone（macOS 26 模拟器）三个 UI 用例全过——亮、暗各走一遍「排队 → 弹出页 → 回来并投出」，第三个从弹出页 Confirm done 并逐字段核对请求体。夹具日志里能看到协调者停着时控制台每 20 秒重读一次 pending，切换后下一次重读就把折叠卡变成胶囊。
  - 第一轮 [run 37991957751](https://github.com/jianghailong-xy/orbit/actions/runs/37991957751)（`5878946`，产品代码 `ab00b9ce7`）：iOS 构建、OrbitApp `swift build`、三个 UI 用例都过；OrbitKit `swift test` 红在上面那条 `ComposerHandoffWiringTests`，已在 `b3b5e4017` 修正。第二轮只改了截图的取景（把折叠卡拖到输入框上方、已投态跟到最新一行、每个用例前重设状态栏时钟），产品代码没动。

probe 分支和 `-results` 分支不合并；`probe-harness/` 是第二轮所用夹具的原样拷贝（`client.probe.yml` 是 probe 分支上替换的 `client.yml`），可以照它重跑。
