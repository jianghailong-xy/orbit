# 协调者不可用时只排队，计时从取走起算（设计稿）

> 状态：owner 2026-11-08 定稿：方案 a、折叠卡去掉、不设上限、异常待办同样处理。本文取代 2026-10-09 的灰色折叠卡方案及其实现出入说明。
> 效果图：`docs/mocks/coordinator-account-wait/board.html`、`board.png`（保留附件原件）。异常待办契约见 `project-integration-line-contract.md` §4.4、§4.6。

## 0. 一页结论

协调者暂时不可用不算结束。证据与异常待办都只是它会话里一条排队的 Orbit 消息：不给 owner 出卡、不进 Needs you、不计入 owner 的 pending 或计数，项目页不画未取走的异常待办卡，没有倒计时，等待不设上限。协调者真正取走当前投递消息（`conversation_turn.delivered_at`）之后，才给满一个窗口；窗口到期后照原有规则转 owner。

「Waiting for the coordinator」折叠卡及其 **Decide it myself** 在 web、macOS/iOS、Android 全部去掉。`waitingOnCoordinator` 字段保留，恒为 `[]`，兼容已发布的原生客户端。

协调者已结束、进回收站、项目关掉 Automatic 时，仍立即转 owner。独立性、有效判据、熔断等原有资格规则不变。

## 0.1 每条结论的来历

以下按 §0 的两条结论与 §6.1–§6.5 的五处适用处说明缘由；代码复核发现的缺口不冒充线上事故。第二批的复核基线为 main `2f8501b30`，来源是项目 `34tldQSV0yrkdQ5yx6PpR` 的 goal；任务编号用于追溯修复安排，不表示进度。

### 0.1.1 暂时不可用只排队，取走才开始算（对应 §0 第一条）

**情况**：2026-10-08，项目 `34a0e97BOc6shsNLJbIuM` 的合并检查失败后，协调者 8 分钟内建了修复任务，27 分钟后修复落上项目分支，随后合进 main；待办却没人关，修复会话结束两小时后误升级给 owner。这促成契约修订 13 的「接手之后不升级」与修复落地后再投。修订 35（2026-11-08）进一步规定未取走只排队；首批项目 `34tXc0HJLemYD2rCOcgwZ` 于 2026-11-08 合入 main，覆盖项目证据、异常待办和非项目派发证据。2026-11-09，项目 `34tXOnJ5qdBGin2sGyMHx` 又暴露边界：协调者取走 macOS 1 的 CHECK_FAILED 待办、尚未回答，在同一 turn 等 owner 确认卡超过 7200 秒后，待办被升级，随后 `integration_retry` 被拒 `INTEGRATION_RETRY_OWNER_ITEM`。**问题**：写入队列不等于取走，取走后尚未回答也不等于无人接手，旧时钟把这两种等待误当成应交给 owner 的停滞。**修复**：首批沿用 `conversationIsOver` / `conversationIsDown` 区分结束与运行失败、`conversationIsPaused` 识别重试与等账号，以当前投递 turn 的 `delivered_at` 起算窗口；S6（`34uVtTp8DnDNwU6Py35bx`）把异常待办的接手判定从回答改为当前协调者取走当前分配的 ITEM turn，要求 `delivered_at ≥ waiting_since`，接手后 `escalatesAt` 为 NULL。未读排空不算取走，re-ask 前的旧投递不算新接手；真正结束、回收站、替换与关闭 Automatic，以及 live-fix、handling-job 的既有判断继续沿用。此处说明异常待办接手的进一步约束，§0 保留一页结论。

### 0.1.2 去掉等待折叠卡（对应 §0 第二条）

**情况**：2026-11-08 的定稿取代了 2026-10-09 的灰色折叠卡方案；原方案仍把等待协调者的证据摆到 owner 面前，并提供 Decide it myself。**问题**：消息明明仍归协调者，折叠卡却把暂时不可用变成了 owner 需要关注和接管的事。**修复**：首批项目 `34tXc0HJLemYD2rCOcgwZ` 的三端改动去掉该折叠卡及其接管入口，读侧继续使用证据归属与裁决资格判断，排队行不进 owner 的 pending、Needs you 或计数；保留 `waitingOnCoordinator = []` 兼容已发布客户端。异常待办的完整展示边界由 S7（`34ufb4U7SRgIKf4XLwqXk`）按现有 `assignee = COORDINATOR` / OWNER 归属拆分：只有成为 owner 的待办才出卡，无须增加文案或另一套等待状态。

### 0.1.3 待记完成也要等取走（对应 §6.1）

**情况**：第二批复核 `project-looks-finished.ts` 时，发现 LOOKS_FINISHED 用 `sessionHasEnded` 判断协调者是否结束，并用 wake 与 ask 的 `updatedAt` 起算两小时。**问题**：FAILED 未结束会立刻把项目交给 owner，排队未读也会消耗处理窗口。**修复**：S1（`34tlqbAjiGkS2hiZyra8O`）复用 `conversationIsOver` 区分真正结束，沿用重试、等账号与忙于其它 turn 的排队判断；截止时间只读当前 LOOKS_FINISHED turn 的 `delivered_at + exceptionEscalationSeconds`，未取走无截止时间。未读排空沿用换键补投，Automatic 关闭、结束和回收站的原有转交规则不变。

### 0.1.4 预审不能在队列里被拒绝或耗尽窗口（对应 §6.2）

**情况**：第二批复核 `owner-confirmation-review.service.ts` 的 `deliver` / `bindReviewDelivery` 与审阅窗口计算，发现 FAILED 被记为 REVIEWER_ENDED，`createTurn` 的 4xx 被记为 SESSION_UNAVAILABLE，`dueAt` 从 `requestedAt` 起算；owner 的确认卡因此可能显示 Not reviewed。**问题**：暂时发不出去被记成永久拒绝，审阅者未读消息就可能超时。**修复**：S2（`34tlqbHejAomarUaeOUgD`）复用 `conversationIsOver` / `conversationIsDown` 和 `conversationIsPaused`，把暂时不可用留作待补投，窗口改读当前投递 turn 的 `delivered_at`；按现有补投入口与换键去重恢复投递。真正结束、回收站、fuse 与关闭 Automatic 的资格判断照旧；项目 goal 特别核实的 fuse `COORDINATOR_PAUSED` 是项目暂停，不属于误判，不随此次修改。

### 0.1.5 退回与回答必须留得住（对应 §6.3）

**情况**：第二批复核发现三处缺口：`returnToRun` 拒绝把任务退给 FAILED 未结束的 run；`deliverSendBack` 只记日志便丢掉说明；`deliverAnswers` 静默丢弃给 FAILED 审阅者的 owner 回答。**问题**：暂时不可用让反馈永久丢失，run 重试回来也不知道为何被退回，任务无法继续。**修复**：S3（`34tlqbJVWysv3hi3WwfAd`）在三条路径复用 `conversationIsOver` / `conversationIsDown`、`conversationIsPaused`，接受反馈并保留待投递事实，沿用轮次结束与 `reconcileTick` 的补投入口；未读排空用被替换 turn 派生的新 key，并发也只写一条 turn，真正结束维持原行为。项目 goal 核实过的 `session_send` 请求与回复本来就会等重试，不另改它。

### 0.1.6 重新交回不能谎报没有协调会话（对应 §6.4）

**情况**：第二批复核 `project-open-item.service.ts`，发现 owner 按 Ask the coordinator again 时，协调者仅仅 FAILED 未结束也会收到 `OPEN_ITEM_NO_COORDINATOR`。**问题**：会话仍在却被当成不存在，owner 无法把待办交回正在等待恢复的协调者。**修复**：S4（`34tlqbU8QBP2ao4l0Ywnk`）复用 `conversationIsOver` / `conversationIsDown` 与暂停判断，允许 FAILED 未结束和 retryAt 时交回，沿用现有 COORDINATOR 分配、ITEM 排队与未取走无截止时间的规则；真正结束、回收站或无协调会话仍拒绝。re-ask 移动 `waiting_since`，接手按 S6 的新投递取走判定，旧投递不能抵算。

### 0.1.7 三类事实不能等一个偶然的新事件（对应 §6.5）

**情况**：第二批复核 `task-run-stopped.producer.ts`、`dependent-ready.producer.ts`、`project-tasks-settled.producer.ts` 时，发现协调者 FAILED 会使投递被拒为 `DELIVERY_COORDINATOR_SESSION_UNAVAILABLE`，原说明只承诺「下次再推导」，没有证明恢复这一刻一定能再收到。**问题**：如果补发依赖另一个任务事件，协调者恢复后仍可能一直不知道既有事实。**修复**：S5（`34tlqbWBIAyhMAIPQU81D`）逐类核对再推导入口，覆盖恢复后没有其它事件也能送达；沿用 turn 完成与仅由 ControlPlaneLeader 执行的 `reconcileTick` 补发入口，以及现有结束、暂停和事实有效性判断。未读排空换键、并发投递去重；全局扫描先只读预检，真正结束、Automatic 关闭或事实失效的行不反复开写事务或刷日志，不另设催 agent 的计时器。

## 1. 什么算暂时不可用

| 情形 | 处理 |
|---|---|
| run FAILED，但会话未结束（没有结束事实、仍在 Open） | 排队等它回来，不作为已结束 |
| 排了自动重试（`session.retryAt`） | 排队，不因写消息取消既定重试 |
| PENDING 在队列里等账号（`queue.service.ts#pausedPendingSessions` 写 `Account paused until …`） | 消息在队列里，不计时 |
| 正在跑别的长 turn | 排到下一轮，取走才计时 |
| 已结束、进回收站、项目关掉 Automatic | 立即转 owner，不等待窗口 |

会话自己的 Queued、Account paused until … 等状态与原因沿用现有展示，不新增界面文案。排队消息与其它排队消息一样显示 `Queued for next turn`；owner 在别处看不到它。

## 2. 证据持有与计时

- 最新、未判且符合协调者裁决资格的证据，在排队和等待补投期间都不进 owner 的 pending、Needs you 或计数。
- **HELD 的窗口从当前投递 turn 的 `conversation_turn.delivered_at` 起算**，不是 wake 的 DELIVERED 状态、`updated_at`、消息创建时刻或恢复时刻。写进队列不等于协调者已取走；`delivered_at` 为空就没有截止时间、不计时、不设等待上限。
- 真正取走后，给满项目的 `exceptionEscalationSeconds`（默认 7200 秒）；之后照原有规则转 owner。已经取走的消息不因其它聊天或单纯恢复而重新获得窗口。
- 失败排空可能留下 ANSWERED、但 `delivered_at` 为空的 turn；打断、撤回也可能删除未读 turn。这些都不算取走。恢复后补投一次，用由被替换 turn 派生的新 key，避免旧键重放；补投仍未取走就仍不计时。
- 补投沿用现有的轮次结束、协调者绑定或轮换、对账兜底入口，按证据提交先后处理；不新增计时器来催 agent。owner 已裁决的版本不再补投。
- `waitingOnCoordinator` 保留为空数组；不能再用它返回排队行或画折叠卡。`sentToCoordinator` 不作为计时依据，展示投递的时间不能替代 turn 的 `delivered_at`。

## 3. 异常待办

异常待办与证据一致：协调者取走**当前分配的 ITEM 投递 turn** 之前，`escalatesAt` 为 NULL，sweep 不转 owner，项目页列表不返回它，相关计数与列表读同一规则。不在项目页画卡，也没有等待倒计时或上限。

取走之后列表才返回，从该 turn 的 `delivered_at` 给满一个窗口。其余规则不变：taken up（已接手）不升级；修复在途不升级；取走后的推进仍按契约延长；协调者已结束、进回收站、项目关掉 Automatic 仍立即转 owner。完整定义见契约 §4.6 X-E1。

## 4. 不在项目里的派发任务

派发会话按同一规则处理。FAILED 但未结束是暂时不可用，不能记作 `REVIEWER_ENDED` 而把证据转给 owner；排了重试、等账号、忙于别的长 turn 也只排队。未取走不计时、不出 owner 卡、不进 Needs you、等待不设上限。

它回来后补发一次；失败排空占住的 turn 使用新 key 重发，避免重复消息。30 分钟窗口从补发消息真正被取走的 `conversation_turn.delivered_at` 起算，排入队列不启动窗口。派发会话真的结束或进回收站时仍立即转 owner。这里同样没有折叠卡或 Decide it myself。

## 5. 验收场景

1. FAILED 未结束、retryAt、PENDING 等账号、忙于长 turn：提交证据或开出异常待办，未取走期间即使超过项目窗口也不进 owner pending、计数或 Needs you；项目页不返回异常待办，`waitingOnCoordinator` 为 `[]`。
2. 恢复并补投：未取走仍无截止时间；真正取走后才从 `delivered_at` 给满项目窗口（非项目派发任务为 30 分钟），无裁决或其它豁免时到点转 owner。
3. 未读 turn 失败排空、被打断或撤回：不误认作已取走，恢复后恰好补发一次。
4. 异常待办 taken up、修复在途保持原有豁免；已结束、进回收站、关掉 Automatic 立即转 owner。
5. 三端不再画 Waiting for the coordinator 折叠卡及 Decide it myself；不新增界面文案。

本任务只修订文档与保存效果图，不改代码、设置项或数据结构。

## 6. 同一规则的其余适用处

本节是第二批代码任务的行为规约，不表示这些路径已经改完。以下五条行为逐字沿用本项目验收标准，第六条声明文案范围；各处都沿用 §1 的「暂时不可用」定义，以及契约 §4.6 修订 35 的「取走才计时」规则。排队不出 owner 卡、不计时、不设上限；真正结束与暂时不可用必须分开判断，原有资格与熔断规则不变。

### 6.1 「Record as done…」

「Record as done…」：协调者 FAILED 未结束、排了 retryAt、在队列里等账号或在跑别的 turn 时，项目不进 owner 的待记完成列表；从 LOOKS_FINISHED 投递 turn 的 delivered_at 起算 exceptionEscalationSeconds，到点才转给 owner；协调者已结束、进回收站、项目关掉 Automatic 时仍立刻转给 owner。

对应 `src/apiserver/src/projects/project-looks-finished.ts` 的 LOOKS_FINISHED due 计算：`escalatesAt` 从当前 LOOKS_FINISHED 投递 turn 的 `conversation_turn.delivered_at` 起算。尚无有效投递或该值为空时没有截止时间；不能用 wake 的 `updatedAt`、写入队列或会话恢复的时刻起算。

### 6.2 OWNER_CONFIRMED 预审

OWNER_CONFIRMED 预审：审阅会话 FAILED 未结束、排了 retryAt 或在队列里等账号时，审阅不会被永久拒绝（不记 REVIEWER_ENDED / SESSION_UNAVAILABLE），它回来后投递恰好一次；审阅窗口（dueAt）从投递 turn 被取走起算，取走前不会 TIMED_OUT；审阅会话真的结束、进回收站、fuse、关掉 Automatic 的现有行为不变。

对应 `src/apiserver/src/tasks/owner-confirmation-review.service.ts` 的 `deliver` / `bindReviewDelivery` 与 `owner-confirmation-review.ts`。忙于别的长 turn 也只排队；`dueAt` 从当前投递 turn 的 `conversation_turn.delivered_at` 给满审阅窗口，不从 `requestedAt` 起算。取走前没有截止时间，即使排队超过整个窗口仍不会 TIMED_OUT。暂时不可用造成的投递拒绝保留为待补投，不永久拒绝审阅。

### 6.3 退回与 SEND_BACK 说明不丢

退回与说明不丢：审阅者把 OWNER_CONFIRMED 任务退回给 FAILED 未结束的 run 时被接受，并在 run 回来后送达；证据 SEND_BACK 的说明发给 FAILED 未结束的 run 时，在 run 回来后补发恰好一次；owner 对已审确认的回答发给 FAILED 未结束的审阅者时，在它回来后补发恰好一次。run 或审阅者真的结束时，保持现有行为。

三条路径分别是 `src/apiserver/src/tasks/owner-confirmation-review.service.ts` 的 `returnToRun`、`src/apiserver/src/tasks/evidence-review.service.ts` 的 `deliverSendBack`、`owner-confirmation-review.service.ts` 的 `deliverAnswers`。run / 审阅者排了 retryAt、等账号或忙于别的长 turn 时也接受并排队，不丢说明、不因暂时不可用转给 owner；对方回来后每条消息补发恰好一次，并发触发也只能写一条 turn。

### 6.4 「Ask the coordinator again」

「Ask the coordinator again」：协调者 FAILED 未结束或排了 retryAt 时，owner 的按压被接受，待办交回协调者并排进它的队列，按异常待办现有规则「取走才计时」；协调者真的结束、进回收站或项目没有协调会话时，仍以 OPEN_ITEM_NO_COORDINATOR 拒绝。

对应 `src/apiserver/src/projects/project-open-item.service.ts`：接受后负责人为 COORDINATOR，当前分配的 ITEM 投递 turn 取走前没有截止时间；取走后依 §3 与契约 §4.6 计时。上述真正无法交回的情形仍返回 `409 OPEN_ITEM_NO_COORDINATOR`，不能把 FAILED 未结束当成没有协调会话。

### 6.5 协调者三类事实

协调者事实不卡住：「task run stopped」「dependent ready」「project tasks settled」三类事实在协调者 FAILED 时被拒后，协调者回来时一定会再送达（核实现有的再推导路径，或补上回来时的补发），不需要等别的事件。

对应 `task-run-stopped.producer.ts`、`dependent-ready.producer.ts`、`project-tasks-settled.producer.ts`。协调者暂时不可用时事实排队；三类逐一核实现有再推导是否覆盖回来这一刻，未覆盖就补上恢复后的补发入口，不能只留下「下次再推导」。验收时每类都要覆盖：FAILED 时产生事实，恢复后由 turn 结束或 reconcile tick 恰好送达一次，期间没有任何别的事件；代码任务的证据逐类说明靠现有路径还是新增补发。

上述补发沿用现有入口；ANSWERED 但 `delivered_at` 为空的失败排空 turn 不算取走。补发使用由被替换 turn 推导的新 key，避免旧键重放，并保证并发也只写一条；不新增催 agent 的计时器。

### 6.6 无新增界面文案

本项目没有新增界面文案。

本节只规定消息排队、补发与取走后的计时，不增加任何客户端文案；原有会话队列状态展示沿用 §1。
