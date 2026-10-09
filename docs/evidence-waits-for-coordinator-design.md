# 协调者停着时，证据卡排队等它（设计稿）

> 状态：草案，待 owner 审（2026-10-09）。
> 起因：10-09 20:02 的截图。Android 项目的协调者在 claude 上撞了周额度，一张「Does this evidence settle the task?」落到你面前。你的话：「这个卡片在 coordinator 不可用的时候，可以加入队列等 coordinator 去处理」。
> 效果图：`docs/mocks/evidence-waits-for-coordinator/`（`1-today.png` … `5-landing.png`）。代码基线：main `c8a431304`，下文行号都指这一版。

## 0. 一页结论

- **现状**：Automatic 项目里，任务交了证据，平台把它投给协调者判。协调者在线时，2 小时之内你那边看不到这张卡。但协调者**停着**的时候（额度用完、429、登录过期、runner 掉线，也就是 run 是 FAILED、会话没人结束），投递会把「停着」当成「结束了」，直接拒收，这一版当场变成你的卡。协调者回来以后，也没有任何机制再把它投过去。
- **建议**：停着不算结束。协调者停着时，证据**排队等它**：不算 Needs you（会话头不写 Waiting for approval，会话列表和工作区的计数也不算它），顶上的条不写「open question」。它一回来（自动重试、额度重置后的重试、你换模型续跑），平台就在它这一轮结束时把排队的证据按提交先后投给它，从投递那刻起重新给它 2 小时。
- **你这边**：对话里原来那张大卡，换成一张收起的灰卡「Waiting for the coordinator」，写明协调者为什么停、预计几点回来。想自己判就点 **Decide it myself**，弹出的还是今天那张卡，照样能 Confirm done 或 Chat about this。
- **不变**：以下情况照旧是你的卡——项目没开 Automatic；协调者被你结束或删掉；协调者自己参与过这项工作；超支熔断暂停；协调者在线但 2 小时没判。
- **要你拍板两件事**（§4）：协调者停着时这张卡在你那边是什么样（推荐：自动排队，收成一张灰卡）；停着期间要不要设等待上限（推荐不设）。

## 1. 现状

### 1.1 截图那一次（10-09，北京时间）

| 时间 | 发生了什么 |
|---|---|
| 18:08:44 | 平台把另一个任务（A05c）的证据投给协调者。这一轮 2 秒后失败：`You've hit your weekly limit · resets Oct 12, 7pm (Asia/Shanghai)` |
| 18:08 起 | 协调者的 run 是 FAILED，会话还开着，没人结束它。额度要到 10-12 19:00 才重置 |
| 19:59:30 | A08c 交了第 1 版证据。投递时协调者是 FAILED，被当成「已结束」拒收，这一版从这一刻起就是你的卡（见下方说明） |
| 20:02 | 截图：协调者已经换到 DeepSeek 跑起来了，卡还在你面前。顶上是「1 open question below」，会话头是「Waiting for approval」 |
| 20:03:42 | 你按了 Confirm done（记录上是 `decidedByType: USER`） |

19:59:30 那一行是按代码和转录推出来的：协调者的 claude 转录停在 18:08:46 那条额度提示，之后在哪个账号上都没有再跑过一轮；FAILED 的会话 `createTurn` 会直接拒（`sessions.service.ts:5262`）。投递记录（`project_coordinator_wake`）在生产库里，这台机器上查不到。

近 7 天（10-02 起），Automatic 项目一共交了 385 版证据：协调者判了 333 版，你判了 31 版，还有 21 版没判。

### 1.2 为什么会这样

1. **投递把停着当成结束。** 证据由 `CompletionEvidenceProducer.deliver` 交给 `CoordinatorDeliveryService.queue`，写成协调者会话里排队的一条消息。写之前，`bindQueuedDelivery`（`coordinator-delivery.service.ts:492`）用 `sessionHasEnded` 判断会话是否结束；而 `sessionHasEnded` 把 run FAILED 也算作结束（`project-open-item.ts:644`）。所以协调者停着，投递就被拒收，钥匙放回。
2. **拒收的那一版直接归你。** 没有投递记录的版本，`readPendingEvidenceJudgments` 会直接放进协调者会话的 `pending`（`pending-evidence-judgments.ts:553`）。你看到的那张卡、Needs you 的计数、会话头的 Waiting for approval，都来自这里。
3. **投出去以后才停的，也一样，而且更糟。** 持有判断 `coordinatorHolds`（同文件 `:265`）同样用 `sessionHasEnded`：协调者一停，持有当场作废，卡立刻到你面前。截图那天 18:08:44 投出去的 A05c 证据，正是在那一轮里撞的限；好在你 18:08:35 已经先判了。更糟的是：一轮失败时，排在它后面的消息会被直接标成 ANSWERED（`runner-api.controller.ts:5485`，`deliveredAt` 为空），协调者其实没读到；可它要是在 2 小时内被救回来，持有又会按投递时间恢复，卡从你面前消失。结果是谁也没在判，直到 2 小时到点。
4. **回来也不补投。** 证据只在两个时刻投递：提交时（`task-completion-evidence.service.ts:420`），和任务换项目时（`tasks.service.ts:6456`）。协调者回来以后，没有任何东西会再投一次，卡就一直留在你那儿，直到有人判。
5. **异常待办早就不这样了。** 待办分得清「停着」和「结束」（`conversationIsDown` / `conversationIsOver`，`project-open-item.ts:653–681`）：协调者停着时，待办仍然归它，等它一轮跑完再补投（`deliverOwedTo`，`runner-api.controller.ts:5612`，集成线契约 §4.4 X-D4 3）。证据没有走这条路。
6. **同样的「停着当结束」还有两处**，这次不改，列在 §5 第 6 步：任务确认复核（`owner-confirmation-review.service.ts`：投递时协调者停着就记 `REVIEWER_ENDED`，直接算没复核，卡归你，且不可逆）；项目看起来做完了（`project-looks-finished.ts`：投递被拒，就连「Record as done…」都不会出现，直到这个事实被重新推出来）。

推送方面：今天证据卡落到你面前时本来就不推送，Needs you 的推送角标也不算它（`push.service.ts:685`）。你是在会话头的 Waiting for approval、会话列表和工作区的计数里看到它的。

## 2. 建议

### 2.1 规则

| 协调者此刻 | 今天 | 建议 |
|---|---|---|
| 在线：在跑、等输入，或刚收到消息还排着 | 投给它；投递起 2 小时内归它，过了归你 | 不变 |
| **停着**：周额度或 5 小时额度、429 或过载、登录过期、runner 掉线（run FAILED，会话没结束） | 当场归你 | **排队等它**；不归你，不计时 |
| **投出去以后，那一轮没跑完就停了** | 当场归你 | **回到队列**，同上 |
| **停着之后回来**：自动重试、额度重置后的重试、你换模型续跑、你给它发消息 | 不补投，卡留在你那儿 | 它这一轮跑完时，队列按提交先后投给它，**从投递起重新算 2 小时** |
| **换了一个新的协调者会话** | 不补投 | 队列投给新的那个 |
| 被你结束，或移进废纸篓 | 归你 | 不变 |
| 项目关了 Automatic | 归你 | 不变 |
| 协调者参与过这项工作（不独立） | 归你 | 不变 |
| 超支熔断暂停 | 归你 | 不变：熔断是你的刹车，你本来就在看它 |

「停着」怎么判定，直接用待办已经在用的 `conversationIsDown`：run 是 FAILED，没有 endReason，会话还开着。不加新状态。截图那次就是这种。另有一种少见的：撞限后停在 AWAITING_INPUT、排着 `retryAt` 等重置（`docs/quota-limit-retry-design.md` §8.1 的形状）。今天往它那儿投递会被接收，但写进去的那一轮会把排着的重试解除掉（`sessions.service.ts:5449`），再撞一次限。这种也算停着，同样排队。

### 2.2 你看到什么（以 iPhone 为例，Mac、Web、Android 结构相同）

排队中的卡：

- 不算 Needs you：会话头不写 Waiting for approval，会话列表和工作区的计数不算它，顶上的条不写「open question」。
- 在对话里原来那张卡的位置，画一张收起的灰卡。下面引号里是产品文案，用英文：
  - 标题 **Waiting for the coordinator**，右边是提交时间。
  - 任务标题，最多两行。
  - 一行橙字：`Coordinator paused · weekly limit · resets Oct 12, 7:00 PM`。原因和时间取自协调者会话自己：原因按它的错误文本分类，和对话里那条「Weekly limit reached」用的是同一个判断；时间取它的 `retryAt`。不知道几点回来就不写时间。
  - 一行灰字：`It goes to the coordinator when it’s back. You can still decide now.`
  - 底行 **Decide it myself ›**：弹出今天那张卡（判据、缺口、检查都一样，按钮也还是 Confirm done 和 Chat about this）。顶上多一句：`The coordinator gets this when it’s back. Decide here only if you don’t want to wait.`

这两样都是现成的：收起态加弹出页，是协调者提问卡的 View details；状态行加「You can still …」那句，是任务确认复核期间的 Under review（`OwnerConfirmations.reviewWillAsk`：卡在、可以按，但不算你的）。

协调者回来、证据投出去以后：

- 灰卡收成一行胶囊：`Sent to the coordinator · 8:05 PM`。
- 它判完以后，照今天的回执显示：`An agent recorded a decision`，下面是 `Confirm done · rev 1 · 8:07 PM`。

### 2.3 协调者看到什么

投递消息和今天一样，只多一行（英文）：

`This revision was submitted at 2026-10-09T11:59:30Z while you were paused (weekly limit). It waited for you; nobody has decided it yet.`

### 2.4 计时

- 停着期间不计时（§4 待定 2 选 A 时）。
- 2 小时（`exceptionEscalationSeconds`，默认 7200，项目设置里可以改）只在协调者在线时走：从投递那刻起算。投递的那一轮如果因为停机没跑完，回来补投时重新起算。
- 协调者在线但 2 小时没判：照旧归你。这次不改。

## 3. 实现要点

这一节写给做这件事的任务，不需要你拍板。

服务端全部从现有的行推出来，不加表，不加迁移：

1. **「欠协调者的版本」** 的条件：Automatic 项目、最新一版、还没判、判据有效、协调者独立，并且**协调者会话没结束**（`!conversationIsOver`）；同时满足下面任意一条：协调者停着；还没有一条投递；投递的那一轮没答完就失败了。欠着的版本不进你的 `pending`，也不计入 `countPendingEvidenceJudgments`（Needs you 的来源）。
2. **`coordinatorHolds` 改用 `conversationIsOver`**。投递记录上的 2 小时只在协调者在线时算；停着时一律算它持有。
3. **补投**：在 turn-complete 钩子里（`runner-api.controller.ts:5612`，和 `openItems.deliverOwedTo`、`confirmationReviews.deliverPendingFor` 放在一起）加一步「把这个项目欠协调者的证据投出去」；换协调者的地方（`projects.service.ts:4460`，`openItems.deliverOwed` 旁边）也调一次。投递沿用 `CompletionEvidenceProducer`：拒收时钥匙已经放回，同一个事实可以再领一次。投出去以后那一轮又失败的，补投时用一个派生的 turn key（事实加上失败的那一轮），避免和第一次投递撞键。
4. **读接口**：`readPendingEvidenceJudgments` 多返回一组 `waitingOnCoordinator`，每行的形状同 `pending`。停机原因和预计恢复时间不用另加字段：客户端已经拿着这个会话的错误文本和 `retryAt`，对话里那条「Weekly limit reached」就是用它们画的（Web `Transcript.tsx` 的 `quotaWindow`，macOS `AutoRetryLogic.swift`）。
5. **停着时不写 turn**：包括 AWAITING_INPUT、排着 `retryAt` 的那种，免得解除它的重试、白跑一轮。
6. **「没读到」怎么认**：投递那一轮被失败清掉时，状态是 ANSWERED，但 `deliveredAt` 为空。按「没读到」处理，回来补投。

客户端（iOS/macOS、Web、Android）：加一个新的卡片状态和一个胶囊。文案三端共用一份，沿用现有的 copy parity 测试。

验收，每条一个测试：

- 协调者 FAILED 时交证据：你的 `pending` 里没有它，Needs you 不加一，它出现在 `waitingOnCoordinator` 里。
- 协调者恢复并跑完一轮：会话里多一条投递消息，这一版 2 小时内不进你的 `pending`；从恢复到补投之间也不进。
- 投出去以后协调者 FAILED：仍然不进你的 `pending`；恢复后补投一次。
- 协调者被结束：进你的 `pending`（不变）。换了新协调者：投给新的那个。
- 停着期间你点 Decide it myself 判了：恢复后不再投给协调者。

## 4. 待定 · 要你拍板

### 待定 1：协调者停着时，这张卡在你那边是什么样

你那句「可以加入队列」，可以是平台自己排，也可以是卡上加个按钮、由你来排。平台自己排的话，排着的卡还有两种画法。效果图 `4-decide.png` 把三种并排画了，并标了在手机上占多高。

- **A（推荐）自动排队，收成一张灰卡**（约 230 pt）：协调者停着，卡就不来找你，不算 Needs you。对话里只有一张灰卡，点 Decide it myself 才展开成今天那张卡。
- **B 自动排队，整张照画**（约 780 pt）：同样不算 Needs you，但判据、缺口、按钮都直接画出来，上面加一条「等协调者」的状态，和任务确认复核期间的 Under review 一样。
- **C 不自动，卡照旧找你**（约 850 pt）：Needs you 照旧，卡上多一个 **Leave it to the coordinator** 按钮，你按了才排队。

推荐 A。停机时你要知道的是「有东西在等它」，不需要再读一遍整张卡；B 和 C 都比截图里对话区能看到的高度（约 408 pt）还高，看上去和今天差不多。C 每次停机都要你一张一张地按，和 10-08 你定的规矩相反：协调者拿着的事由它自己办完，有问题再来问你（契约修订 13）。

### 待定 2：停着期间等多久

- **A（推荐）一直等**：停着期间不计时，等它回来。你看得到排着的卡和停机原因，觉得等不了，可以换模型（截图那次就是这么做的），也可以自己判。
- **B 设上限**：停了 N 小时还没回来（比如沿用 2 小时的 `exceptionEscalationSeconds`，或者 24 小时），卡照旧归你。异常待办今天就是这样（契约 §4.6 X-E1：停着也照样计时）。

停机能有多长：账号轮换只要 33 秒（10-09 有一个任务会话自己换了账号接着跑）；5 小时额度是几个小时；周额度要好几天（截图那次要等到 10-12 19:00）。如果选 B 并用 2 小时，截图那次的卡会在 21:59 交给你；用 24 小时，是 10-10 19:59。按 A，那一晚你 20:02 之前就把协调者换到了 DeepSeek，它 20:05 跑完一轮就会拿到这张卡。

## 5. 落地（按代价排）

1. **服务端：停着不算结束、恢复后补投、读接口多一组**（服务端）。只做这一步的话：协调者停着时卡不再来找你，回来后自动投给它；但客户端还不认识新的那一组，停机期间对话里看不到排着的卡，只看得到额度提示。
2. **iOS / macOS：排队卡和胶囊**（iOS/Mac）。
3. **Web：同上**（Web）。
4. **Android：同上**（Android）。
5. **可选：异常待办也改成停着不计时**。今天待办在协调者停着时照样走 2 小时的表，到点变成「Escalated to you」。要和证据保持一致，就改契约 §4.6 X-E1（修订 14）（服务端加契约）。
6. **可选：另外两处「停着当结束」**（§1.2 第 6 条）：任务确认复核和「项目看起来做完了」，按同一条规则改（服务端）。

建议先做 1 和 2（一个服务端任务、一个 iOS 任务），3 和 4 跟上；5 和 6 等你说要再做。

## 6. 不做什么

- 不改协调者在线时的 2 小时规则。
- 不加设置项，不加表。
- 不改超支熔断暂停时的行为。
- 任务页和项目页不加排队状态：对话里那张卡就是唯一显示的地方。
