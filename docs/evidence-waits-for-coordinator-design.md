# 协调者不可用时只排队，计时从取走起算（设计稿）

> 状态：owner 2026-11-08 定稿：方案 a、折叠卡去掉、不设上限、异常待办同样处理。本文取代 2026-10-09 的灰色折叠卡方案及其实现出入说明。
> 效果图：`docs/mocks/coordinator-account-wait/board.html`、`board.png`（保留附件原件）。异常待办契约见 `project-integration-line-contract.md` §4.4、§4.6。

## 0. 一页结论

协调者暂时不可用不算结束。证据与异常待办都只是它会话里一条排队的 Orbit 消息：不给 owner 出卡、不进 Needs you、不计入 owner 的 pending 或计数，项目页不画未取走的异常待办卡，没有倒计时，等待不设上限。协调者真正取走当前投递消息（`conversation_turn.delivered_at`）之后，才给满一个窗口；窗口到期后照原有规则转 owner。

「Waiting for the coordinator」折叠卡及其 **Decide it myself** 在 web、macOS/iOS、Android 全部去掉。`waitingOnCoordinator` 字段保留，恒为 `[]`，兼容已发布的原生客户端。

协调者已结束、进回收站、项目关掉 Automatic 时，仍立即转 owner。独立性、有效判据、熔断等原有资格规则不变。

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
