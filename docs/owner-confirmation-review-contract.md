# 确认卡的审查：审查方、先审后呈与审查记录（契约）

**状态**：草案，待 owner 在 app 里确认（任务 `34Z35urx0kEB2qZaLeikc`，项目 `34Z2usxH1u0wBMagUPqlM`「确认卡：审查意见、确认后果与少打扰」）。**修订 3**（任务 `34ugU32krhXotXkNdcR90`，项目 `34ugEgaBTN55G7DKcU8jD`，待 owner 在 app 里确认）把 Automatic 项目从「卡片立刻显示、多一栏审查」改成「先持有、再呈上」，并把执行会话的提问和 `notify` 一起纳入：见 §13–§19。确认后冻结为 v1。服务端（任务 `34Z35uusJWkeA99O23btE`）与三端（任务 `34Z35v1nS4l48MjxDIDXX`）都按本文实现，不另造表、状态、错误码或界面用词。实现中要偏离本文，先改本文、在附录 B 写修订记录，再改代码。

**依据**：效果图 `docs/mocks/owner-confirmation-review-ios.html` 第③④台手机与第二排（整页截图 `owner-confirmation-review-ios.png`，第④台单独一张 `owner-confirmation-review-ios-4.png`），以及项目说明里写好的默认决定：首行用方案 B；超时在项目内沿用 `exceptionEscalationSeconds`、项目外 30 分钟；审查方可以退回，这项新权限由 owner 批准。

**范围**：OWNER_CONFIRMED 任务确认卡上的「审查方先审」，以及 Automatic 项目里执行会话走向 owner 的三条路：确认请求（§0.1、§13）、提问（§14）、`notify`（§15）。工具权限审批不在范围内，照旧直达 owner（§18 U1）。
- 卡片上的「If you confirm」、以及报告改取声明完成那一轮，归任务 `34Z35udELdL3GuuzpZJDQ` / `34Z35ujH0aejOiDNxcONf`。本文只规定审查栏夹在它们之间（§6 H1）。
- 「机器能验的工作由审查方结案」（B 线，任务 `34Z35v5J1Oftbjf8vazKr`）不在本文范围内。本文不给审查方任何结案的权力（§10 G9）。

**引用规范**：引用写「文件 + 符号」，不写行号。`docs/project-integration-line-contract.md` 下称 **ILC**，`docs/session-request-reply-contract.md` 下称 **SRR**。

---

## 0. 总则

### 0.1 一句话

执行会话声明完成并停下时，Orbit 记下确认请求，同时把它交给审查方。之后按审查方是谁分两种：

- **Automatic 项目（审查方是项目协调会话）：先持有，再呈上。** 协调会话持有期间，owner 这边什么都没有：没有卡片、不计 needs-you、不推送、没有飞书卡。协调会话三选一：呈上（`task_confirmation_review`，它的结论和要 owner 决定的点成为卡片的开头）、退回执行会话（`task_confirmation_return`），或者不作为，由 §16 的兜底把卡片交给 owner，并标明 `Not reviewed by the coordinator`。持有判定在读的时候算，不加定时任务。
- **项目外（审查方是派活的会话）：与修订 3 之前相同。** 审查期间卡片照常显示、按钮照常能按，只是不计入 needs-you。

能按确认的仍然只有 owner。

### 0.2 不变的事

- **G1 只有 owner 能确认。** 决定「谁能确认」的三处一个字不改：`task-owner-confirmation.ts#ownerConfirmationPrincipalRefusal`；`task_owner_decision` 的 CHECK（`decided_by_type = 'USER' AND decided_by_id = owner_id`）；0267 在 DONE fence 里那条 lane。审查相关的表不进 fence，`evaluateTaskCompletion` 不读它们。同一个文件里要改的只有两处，见 G2。
- **G2 持有挡的是呈现，不是门。** Automatic 项目里，协调会话持有期间卡片不呈现（§13 A2），这是唯一的变化：确认门照常受理 owner 的决定，任务面板上的 Confirm done 也照常可用（§13 A4），agent 写的任何东西都拦不住 owner 确认。项目外的审查不隐藏卡片。卡片一旦呈现，在审查中（仅项目外）、已审、未经审查、已过期这几种状态下，Confirm done 和 Chat about this 都照常可按：不预选，不禁用，不改顺序。审查对确认门只改三处：
  1. 当前那份审查里有「要你判断」的条目时，认识审查的客户端要带上逐条答案（§7）。答案由 owner 自己填，默认项已经选好，所以随时可以一按就确认；不认识审查的旧客户端照旧受理，不会因为审查被拒。
  2. 被审查方退回的请求，视同已被回答（§8 B3）。
  3. 持有期间在任务面板上确认（`requestId` 为空）视同回答被持有的那份请求（§13 A4）。
  
  agent 写的任何东西都拦不住 owner 确认。
- **G3 读时推导，不加定时任务。** 状态由已提交的行和读的时刻算出，做法照 `pending-evidence-judgments.ts#coordinatorHolds`。不加 `setInterval`、worker、sweep，也不在启动时扫描。本文所有写入都挂在已提交的事实上：`turnComplete`、工具调用、owner 按键，以及审查方会话结束的那条语句（§3.1 的触发器）。时钟只在读里出现一次，即比较 `now >= due_at`。
- **G4 Orbit 的事实照旧直接画。** 验收标准、执行会话的报告、If you confirm，仍由 Orbit 从行里直接取。审查栏是另加的一块，内容是审查方署名的记录原文，不替换、不改写上面任何一项（§10 G4）。
- **G5 不走协调者唤醒账本。** 审查投递不加唤醒事件（ILC G5 的闭集不变），也不经过 `CoordinatorConvergenceService.authorizeWake`：按 ILC G4，外部事实的投递不计费。投递状态记在审查行自己身上（§3.1）。

### 0.3 术语

| 术语 | 定义 |
|---|---|
| 确认请求 | `task_owner_confirmation_request` 的一行：某次执行声明了完成，并在一轮成功结束时停下（0267、0295） |
| 执行会话 | 请求所在的会话 `request.session_id`。卡片画在这里，退回的理由也投到这里 |
| 审查方 | 被请来先审这份请求的会话，在请求那一刻定下（§1） |
| 审查行 | `task_owner_confirmation_review` 的一行，记一份请求的审查方、窗口和投递状态（§3.1） |
| 审查记录 | `task_owner_confirmation_review_record` 的一行，即审查方交回的东西。三种：REVIEW、RETURN、PROBLEMS（§3.2） |
| 窗口 | 审查方先审的时长，`due_at = requested_at + window_seconds` |
| 审查栏 | 卡片上画审查的那一块，即效果图里的 REVIEW 框 |
| 首行 | 审查栏里由 Orbit 从条目推出的那一行（方案 B） |
| 持有 | 审查方是项目协调会话、审查状态是 `UNDER_REVIEW` 的请求（§13 A1）；提问与 `notify` 的同类状态见 §14、§15。持有期间 owner 什么都看不到 |
| 呈上 | 协调会话交回 REVIEW 记录，让持有结束、卡片出现（§13 A3） |
| 兜底 | 持有因为没有协调者、协调者结束或超时而结束，事项直接交给 owner，并标明未经协调者审查（§16） |

### 0.4 与效果图的不同

1. 效果图说明第 3 条写「复用正在做的 expectReply」。本文改为平台投递（§2），理由见 §2.1。
2. 效果图第③台说明写「超时先定 30 分钟」。本文的规则是：项目内用项目的 `exceptionEscalationSeconds`（默认 7200 秒），项目外 30 分钟。另外，审查方读过请求后空闲下来、又没有任何东西会叫醒它时，审查立刻按「未经审查」结束（§4 T5）。
3. 效果图第③台说明写「改完重新声明，新卡片顶掉这一张」。本文让被退回的卡片留下来，成为一条「已被审查方退回」的记录（§8 B6）。
4. 效果图方案 B 没画「要你判断」的选项。本文把选项画在首行下面（§6 H3、§7 Q2）。
5. 第二排「你先确认、审查后到」里的 Problem 行，来自 §9 的 PROBLEMS 记录。

### 0.5 条款编号

各节前缀：S 审查方、D 投递、C 审查记录、T 状态、N needs-you 与超时、H 审查栏与首行、Q 要你判断、B 退回、L 后到的审查、G 与现有规则的关系、I 实现切分；修订 3 新增 A 持有与呈上、R 提问、M notify、F 兜底、W 简报与工具描述、U 不变的情况、O 待 owner 定的问题。实现任务在 spec 和评论里引用条款号。

---

## 1. 审查方（S）

**S1（在请求那一刻定下）**：`runnerApi.turnComplete` 写确认请求的那个事务里，同时把审查方解析一次，写进审查行（§3.1）。之后不管任务换项目、项目换协调会话，还是 Automatic 开关变化，这一行的审查方都不改，只按 §4 改变状态。理由与 SRR §3.1「请求不跟着项目换人」相同。

**S2（解析顺序）**：在同一事务里读请求所属任务的行，依次判断：

1. 任务在项目里（`task.project_id` 非空）时：
   - `project.coordinator_enabled = false`：**没有审查方**，不写审查行。先例是证据投给协调者：`CompletionEvidenceProducer` 只在 Automatic 开着时投递，`coordinatorHolds` 在开关关掉时把卡片还给 owner。开关关着，就由 owner 自己审。
   - 否则审查方是**项目的协调会话**：`reviewer_kind = 'PROJECT_COORDINATOR'`，`reviewer_session_id = project.coordinator_session_id`，这个值可能为空（见 S4）。**任务是谁建的不影响这一条**（修订 3）：Automatic 项目里 owner 在 app 里建的任务，也由协调会话持有。今天的 `resolveReviewer` 先判 `creator_session_id` 为空就返回，这样的任务会绕过协调者，I1 要把这条判断挪到项目分支之后。
2. 任务不在项目里且 `task.creator_session_id` 为空：**没有审查方**，不写审查行。owner 在 app 里建的任务（用户 API `TasksController.create` 从不写这一列）、用不带会话头的 CLI 建的任务、建它的会话后来被删掉的任务（外键 SET NULL）都是这一种：没有可以请来审的会话。

   不按 `creator_type` 判断。runner 门在请求不带 `X-Orbit-Agent-Id` 时也会记成 `USER`，在会话里建的任务可能因此带着会话却记成 `USER`；`creator_session_id` 才是「有没有派活的会话」本身。
3. 任务不在项目里时，审查方是**派活的会话**：`reviewer_kind = 'TASK_CREATOR'`，`reviewer_session_id = task.creator_session_id`。

**S3（审查方不能是执行会话）**：执行会话是为这个任务开的会话（`session.task_id = task.id`）。建任务的会话在任务出现之前就已存在，跑的是别的任务或者不跑任务，所以它不可能是执行会话。协调会话也不跑任务。本文仍把这一点写成规则：解析出的会话如果 `task_id = task.id`，投递以 `REVIEWER_IS_THE_RUN` 被拒（§2 D4）。判定条件与 `task-evidence-decision.ts#decidingSessionDisqualification` 的第一条相同。

**S4（找不到审查方，或审查方已结束）**：审查行照写，状态直接就是「未经审查」（§4）。
- Automatic 项目没有协调会话（`reviewer_session_id` 为空）：D1 直接写 `delivery = 'REFUSED'`、拒绝码 `NO_COORDINATOR`，不做 D2。
- 审查方会话已结束（`sessionHasEnded`，与 `coordinator-delivery.service.ts#bindQueuedDelivery` 用同一个判定）：由 D2 以 `REVIEWER_ENDED` 拒绝。之后审查方的会话行如果被删掉，T1 读不到它，也按「已结束」处理。
- 审查方是 `PROJECT_COORDINATOR` 时，「已结束」改用 `conversationIsOver`，暂停的协调会话不算结束（§16 F3）。

**S5（审查方的名字）**：项目外，卡片和列表上显示审查方会话**当前**的标题，读的时候取；会话行已删除、取不到标题时，客户端写 `Reviewer`。`PROJECT_COORDINATOR` 一律写 `Coordinator`，不取会话标题：协调会话的标题常常就是项目标题，放在署名位置读不出是谁。

**S6（审查方是协调会话时，审查就是持有）**：`PROJECT_COORDINATOR` 的审查行同时是 §13 的持有记录，不另建表。它的 `UNDER_REVIEW` 读作持有，`REVIEWED` 读作已呈上，`RETURNED` 读作退回，`NOT_REVIEWED` 读作兜底。`TASK_CREATOR` 的语义不变。

---

## 2. 投递（D）

**D1（与请求同一刻写下）**：`turnComplete` 调完 `recordOwnerConfirmationRequest` 后，在同一个事务里：
- 按 §1 解析审查方。有审查方就插入审查行：`delivery = 'PENDING'`，`window_seconds` 与 `due_at` 按 §5 N4 计算。`recordOwnerConfirmationRequest` 今天返回 `void`，要改成返回新请求的 id。
- 请求行的 `branch_sha` 在同一次插入里写上，取本轮的 `dto.branchSha`；runner 没报就为空。它是审查所绑提交号的参照（§3）。

请求和审查行同时提交，所以这一轮结束后的第一次读就已经是「审查中」，needs-you 不会先亮一下再灭。

**D2（提交后投递）**：这与「证据投给协调者」（`CompletionEvidenceProducer.deliver` → `CoordinatorDeliveryService.queue`）是同一类投递：在已提交的事实之后，一个事实投一条 `NEXT_TURN` 平台轮次，键由事实派生，不复活已结束的会话，被拒时由 owner 的卡片兜底。不同之处只有两点：不经过 `project_coordinator_wake`，因为项目外没有项目可挂；也不经过 convergence 授权器，因为它不计费（G5）。

事务提交后，`turnComplete` 调 `OwnerConfirmationReviewService.deliver(reviewId)`。投递走 ILC G6 的载体：

```
SessionsService.createTurn(ownerId, reviewerSessionId,
  { clientTurnId: 'owner-confirmation-review:v1:<reviewId>', content: '', intent: 'NEXT_TURN' },
  { participateSendTransaction: bindReviewDelivery })
```

- 正文为空。审查块在这一轮交给 engine 时才写进去（D6），与 `bg-wake:`、`session-reply:` 的做法相同。所以这个前缀要接进现有的平台轮次处理，接法与 `session-reply:` 相同：
  - 登记进 `sessions.service.ts#isPlatformContentTurn` 和 `queuedWakeContent`，排队时显示审查块，而不是一行空消息；
  - 登记进 auto-retry 回溯要重发哪条消息的地方（`auto-retry.service.ts` 里 `isSessionReplyTurn`、`isBackgroundWakeTurn` 旁边）。审查轮次失败时重发的是它自己，不能去重发审查方上一条已经回答过的消息。
- `bindReviewDelivery` 在 `createTurn` 的事务里、拿到审查方的 Session 锁之后执行。它重读审查行，要求仍是 `PENDING`，然后按以下顺序检查，任何一条不成立就抛错，这一轮不写：
  1. 审查方会话未结束（`sessionHasEnded`），否则 `REVIEWER_ENDED`；
  2. 审查方会话不是这个任务的执行会话，否则 `REVIEWER_IS_THE_RUN`；
  3. 请求仍是任务最新的一条，否则 `SUPERSEDED`；
  4. 请求没有被 owner 退回，否则 `SENT_BACK`；
  5. 仅 `PROJECT_COORDINATOR`：项目仍是 Automatic，否则 `AUTOMATIC_OFF`；
  6. 仅 `PROJECT_COORDINATOR`：项目没有进行中的暂停段（`project-fuse.ts#openFuseEpisodeId`），否则 `COORDINATOR_PAUSED`。
  
  全部成立，就把审查行改成 `DELIVERED`，写上 `delivery_turn_client_id` 和 `delivered_at`。
- `PROJECT_COORDINATOR` 且协调会话暂停时（`conversationIsPaused`）：不算拒绝，这一行留在 `PENDING`，等它回来后由 D5 投递（§16 F3）。第 6 条的 `COORDINATOR_PAUSED` 指项目熔断，不是这种暂停。
- 拒绝码怎么写下：钩子抛一个带码的类型化错误（新类 `ReviewDeliveryRefused`，继承 `ConflictException`，带 `refusalCode`），这一轮随 `createTurn` 的事务回滚。`deliver` 接住它，在回滚之后另用一条条件更新写 `delivery = 'REFUSED', delivery_refusal = <码> WHERE delivery = 'PENDING'`。`createTurn` 自己的普通拒绝（Not Found / Conflict / Forbidden / Bad Request）一律记 `SESSION_UNAVAILABLE`，与 `CoordinatorDeliveryService.enqueue` 把它们折成一个码是同一个道理。`enqueue` 并不区分钩子里的各种拒绝，所以分码要靠这个新错误类。
- owner 已经**确认**了这份请求，也照样投递：后到的审查正是 §9 的安全网。
- 审查方本身可能是另一个 OWNER_CONFIRMED 任务的执行会话（它在执行时派了这个活）。排队的审查轮次会让它晚一点停下（`runStoppedWorking`），它自己那张确认卡也随之晚到。它的卡片报告取的是声明那一轮的最后一条消息（「If you confirm」任务的改动，见 §11.3），不会变成审查时的对话。
- 不走 `SessionsService.resume`：不复活已结束的会话，也不 steer 正在跑的一轮。审查方正在跑一轮时，这条排在它后面（ILC X-D3：忙不是拒绝）。

**D3（项目外也收得到）**：投递直接写给审查行上的 `reviewer_session_id`，不经过项目，所以项目之外的派活会话也收得到。两种审查方的差别，只是 D2 里协调会话要多查第 5、6 两条，与 `CompletionEvidenceProducer.authorize` 里拒绝的两种情况一致。

**D4（每个请求只投一次）**：
- 一份请求至多一行审查行（`request_id` 唯一）。
- `delivery` 只从 `PENDING` 变一次，变成 `DELIVERED` 或 `REFUSED`（条件更新）。
- 这一轮的键由审查行 id 派生。`createTurn` 遇到同键、同内容只会重放，不会写第二条。
- D5 的重投不改 `delivery`，只把 `delivery_turn_client_id` 指向新轮次。
- **被拒就是终局。** `REFUSED` 写下拒绝码，状态立刻变成「未经审查」，卡片交给 owner。不释放、不重投，也不改投给后来的协调会话：审查有时限，重投只会让 owner 的卡片等得更久。
- 故障（即上面这些普通拒绝之外的异常）照样抛出。这一行留在 `PENDING`，由 D5 补投。

**D5（补偿点）**：进程可能死在事务提交和 D2 之间（ILC G2）。补偿点是：审查方会话每一次 `turnComplete` 提交之后，对 `reviewer_session_id` 是它、仍为 `PENDING` 的审查行逐个调 `deliver`。如果审查方一直没有轮次结束，这一行就停在 `PENDING`，读作「审查中」，到 `due_at` 时按「未经审查」交给 owner（§4）。最坏情况是 owner 多等一个窗口，卡片不会卡死。同一个补偿点还负责重投（§16 F3）：`PROJECT_COORDINATOR`、`delivery = 'DELIVERED'`、没有记录、投递轮次没被读到就被收掉（T1 的同一判定）、协调会话没有结束的行，用 `owner-confirmation-review:v1:<reviewId>:retry:<uuid>` 重投。重投的 `onTurnWritten` 里做条件更新 `SET delivery_turn_client_id = <新键>, delivered_at = now() WHERE id = … AND delivery = 'DELIVERED' AND delivery_turn_client_id = <旧键>`，没命中就抛错，这一轮回滚，所以并发时只有一条。不加新的调用点。

**D6（审查方看到什么）**：inbox 交出轮次的地方（`runner-api.controller.ts`，`appendSessionRepliesContext` 旁边），遇到 `owner-confirmation-review:v1:` 前缀的轮次时调 `appendOwnerConfirmationReviewContext`，把审查块写进去，并记成控制面注记（`control-plane-note.ts`）。
- 这一步不是 best-effort：这一块就是这一轮的全部内容，失败就回滚领取，轮次留在队列里。
- 审查块在交出时按当时的行渲染，所以能写出请求此刻的状态。
- 给 agent 看的文字用英文，与 MCP 工具描述一致：

```
<orbit-confirmation-review task="<task publicId>" request-id="<uuid>" run-session="<publicId>"
    branch="orbit/…" sha="<40 位提交号，没有就空>" due-at="2026-10-02T15:25:00Z">
A run of the task “<title>” declared its work finished and is waiting for the account owner to
confirm it (OWNER_CONFIRMED). You are its reviewer. Until due-at the owner is not asked; after that,
or as soon as you record a review, the owner's card asks them.
[PROJECT_COORDINATOR only, replacing the last sentence:] The owner sees nothing while you hold this.
Recording a review raises it: your judgment leads the owner's card, followed by what you put in
needsYou. If you do neither by due-at, Orbit asks the owner directly and says you did not review it.

What settles it (the task's acceptance criteria, first 2000 characters): …
What the run reported (the report the owner's card shows, first 2000 characters): …

Check the work on <branch> at <sha>. Then do exactly one of:
- task_confirmation_review: record what you checked, what you could not check and why, what only
  the owner can decide (each with options and the one you recommend), and what is left open, each
  line with the evidence it rests on. Orbit writes the card's first line from these lists; your
  one-sentence judgment is shown last, quoted. [PROJECT_COORDINATOR only: your judgment is the
  card's lead, so write the conclusion the owner should read first.]
- task_confirmation_return: send it back to the run with the reason, when something must change
  before the owner looks. The reason becomes the run's next message; the owner is not asked.
You cannot confirm or send back for the owner. If you end your turn without doing either and nothing
is going to wake you, Orbit treats the request as not reviewed and asks the owner.
</orbit-confirmation-review>
```

- 执行会话当前 `worktree_dirty = true` 时多一行：`The run has uncommitted changes that are not on <branch>; list what you could not see under notChecked.`
- 总有这一行：`If you cannot read <branch> from where you are (another runner or another clone), say so under notChecked rather than guessing.`
- 报告与卡片上显示的是同一份：取 `owner-confirmation-read.ts#ownerConfirmationReport`，或「If you confirm」任务改过之后的取法。
- 请求此刻已不是最新，或者已经有了 RETURN 记录：审查块只说明是哪一种情况，再加一句 `Nothing to review; end your turn.`（这时 §3.5 会拒绝记录）
- owner 已经退回了这份请求：审查块写 `The owner sent this back to the run at <time>, so nobody is waiting on a review. You may still record one (it is shown under their receipt); otherwise end your turn.`
- owner 已经确认时，审查块写：`The owner confirmed this at <time>. A review now is shown under their receipt; if you find a problem, task_confirmation_return tells the owner, who can reopen the task.`（§9）

**D7（审查方会话里的卡片）**：这条轮次的回显入库时，给这条 `user` 事件挂上结构化读数 `confirmationReviewRequest`：`{ requestId, reviewId, taskId, title, runSessionId, branch, sha, dueAt }`。挂的位置、规矩都与 `openItemDelivery` 相同（ILC X-D2b）。
- 三端把它画成一张只读卡片：标题 `Review requested`，下面是可点的任务标题和 `Due <HH:MM>`，另有一个打开执行会话的按钮 `Open task session`（沿用例外待办卡上的同名按钮）。不画成 owner 的气泡。
- `GET /sessions/:id/turns` 的两个投影都带上这份读数，排队时画的也是这张卡。
- 旧客户端照今天的方式显示注记。

**D8（不计费、不占会话间上限）**：审查轮次、退回轮次（§8）、答案轮次（§7）都是平台投递，按 ILC G7 归为「外部」：不计入协调会话的自主花费，不经过 `chargeSteer`，也不计入 SRR §2.4 每个有序会话对 5 分钟 60 条的上限。

### 2.1 为什么不用会话间请求（`expectReply`）

1. **它只能由会话发起。** `session_send` / `project_send` 带 `expectReply` 时，调用方必须是会话，headless 调用会被 403（SRR §3.1）。确认请求是平台在 `turnComplete` 里记下的事实，并没有发起它的会话。如果硬拿执行会话当发送方，问题更大：会话自己发出、还没有结局的请求算它的唤醒源（SRR §4.1 第 4 条），回信 turn 也会投回执行会话、把它叫醒。而确认请求成立的前提，恰恰是这次执行已经停下（`runStoppedWorking`）。
2. **回复只能是文本。** `session_reply({ requestId, message?, option? })` 只能带一段正文或一个选项下标。审查需要的是一句结论、四类条目、每条的证据引用和所审的提交号，首行也要从条目推出来。从一段自由文本里推不出这些，只能再交给一个 LLM 去读，而这正是 ILC §0.1 不允许的转述。
3. **结局和时钟对不上。** 请求的 `EXPIRED` 由 worker 扫 `reply_by` 写下（SRR §5），本文不加定时任务。请求的结局要交回给发送方会话，审查的读者却是卡片和 owner。
4. **配额不该被占用。** 每个有序会话对 5 分钟 60 条、最多 50 个 OPEN 请求，这两个上限是为 agent 之间的来回设计的（SRR §2.4、§3.1）。审查每个请求只投一次，不该和它们抢额度。

所以审查走平台投递（D2），回复走专门的工具（§3.5、§8）。退回给执行会话的那条消息也是平台投递，不是会话间消息：它不带 `sender_session_id`，审查方是谁、它什么模式由 Orbit 按审查行写进块里（§8 B3）。它带的还是审查方的话，所以能不能退回要按 SRR §2.5 判（§8 B8 第 14 条）。

---

## 3. 审查记录（C）

### 3.1 审查行

```sql
CREATE TYPE "owner_confirmation_reviewer_kind" AS ENUM ('PROJECT_COORDINATOR', 'TASK_CREATOR');
CREATE TYPE "owner_confirmation_review_delivery" AS ENUM ('PENDING', 'DELIVERED', 'REFUSED');

CREATE TABLE "task_owner_confirmation_review" (
  "id"                      uuid NOT NULL,
  "request_id"              uuid NOT NULL,
  "task_id"                 uuid NOT NULL,
  "owner_id"                uuid NOT NULL,
  "reviewer_kind"           "owner_confirmation_reviewer_kind" NOT NULL,
  "reviewer_session_id"     uuid,            -- 出处快照，不带外键（与 0267 的 session_id 同一条理由）
  "project_id"              uuid,            -- 请求那一刻任务所在的项目，快照
  "window_seconds"          integer NOT NULL,
  "due_at"                  timestamp(3) NOT NULL,
  "delivery"                "owner_confirmation_review_delivery" NOT NULL DEFAULT 'PENDING',
  "delivery_refusal"        text,
  "delivery_turn_client_id" text,
  "delivered_at"            timestamp(3),
  "abandoned_at"            timestamp(3),    -- §4 T5
  "reviewer_ended_at"       timestamp(3),    -- 下面的触发器
  "created_at"              timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "task_owner_confirmation_review_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_owner_confirmation_review_request_fkey"
    FOREIGN KEY ("request_id", "task_id")
    REFERENCES "task_owner_confirmation_request"("id", "task_id") ON DELETE CASCADE,
  CONSTRAINT "task_owner_confirmation_review_task_fkey"
    FOREIGN KEY ("task_id", "owner_id") REFERENCES "task"("id", "owner_id") ON DELETE CASCADE,
  CONSTRAINT "task_owner_confirmation_review_window" CHECK ("window_seconds" > 0),
  CONSTRAINT "task_owner_confirmation_review_refused_has_code"
    CHECK ("delivery" <> 'REFUSED' OR "delivery_refusal" IS NOT NULL),
  CONSTRAINT "task_owner_confirmation_review_delivered_has_turn"
    CHECK ("delivery" <> 'DELIVERED' OR ("delivery_turn_client_id" IS NOT NULL AND "delivered_at" IS NOT NULL))
);
-- 一份请求至多一行（D4）。
CREATE UNIQUE INDEX "task_owner_confirmation_review_request_key" ON "task_owner_confirmation_review"("request_id");
-- 记录行的复合外键指向这一对。
CREATE UNIQUE INDEX "task_owner_confirmation_review_id_request_key" ON "task_owner_confirmation_review"("id", "request_id");
-- D5 与 T5 按审查方会话找行。
CREATE INDEX "task_owner_confirmation_review_reviewer_idx" ON "task_owner_confirmation_review"("reviewer_session_id", "delivery");
```

拒绝码（`delivery_refusal`）是闭集：`NO_COORDINATOR`、`REVIEWER_ENDED`、`REVIEWER_IS_THE_RUN`、`SUPERSEDED`、`SENT_BACK`、`AUTOMATIC_OFF`、`COORDINATOR_PAUSED`、`SESSION_UNAVAILABLE`。

**审查方结束时写下的那一刻（触发器）**：「审查方已结束」要写成一个只增不减的事实，不能在读的时候看会话的当前状态。否则审查方因失败停下、后来被自动重试或被人叫醒，「未经审查」又会变回「审查中」，从 needs-you 里消失。写法照 0350 收 RECIPIENT_ENDED 的触发器：
- 新增触发器 `task_owner_confirmation_review_reviewer_ended`，挂在 `session` 上，另写一个新函数，不改 0350 的函数。
- `AFTER UPDATE OF` 的列和 `WHEN` 条件，与 0350 的 `session_request_recipient_ended` 逐字相同，包括它对自动重试的处理：已经排上重试的失败不算结束，重试放弃时才算。
- 它在结束会话的那条语句里，给以该会话为审查方、还没有 REVIEW 或 RETURN 记录、`reviewer_ended_at` 为空的审查行写上 `reviewer_ended_at = now()`。
- 审查方的会话行被彻底删除时（不经过 Trash），读的时候找不到它，同样按已结束处理。删掉的行不会再回来，所以这条也只增不减。

触发器不发 realtime 事件；客户端怎么跟上，见 §5 N5。

### 3.2 审查记录

```sql
CREATE TYPE "owner_confirmation_review_record_kind" AS ENUM ('REVIEW', 'RETURN', 'PROBLEMS');

CREATE TABLE "task_owner_confirmation_review_record" (
  "id"             uuid NOT NULL,
  "review_id"      uuid NOT NULL,
  "request_id"     uuid NOT NULL,
  "task_id"        uuid NOT NULL,
  "owner_id"       uuid NOT NULL,
  "kind"           "owner_confirmation_review_record_kind" NOT NULL,
  "reviewed_sha"   char(40),
  "judgment"       text,            -- REVIEW 必填
  "reason"         text,            -- RETURN、PROBLEMS 必填
  "body"           jsonb NOT NULL,  -- REVIEW：四类条目；RETURN、PROBLEMS：{ problems }（§3.4）
  "session_id"     uuid NOT NULL,   -- 交回记录的会话，即审查方。快照
  "turn_id"        uuid NOT NULL,   -- 交回时正在进行的那一轮。快照
  "return_client_turn_id" text,     -- RETURN 专用：退回那一轮的键 confirmation-return:v1:<id>，由记录 id 派生，
                                    -- 写记录时就知道，所以能在 participateSendTransaction 里写（那时轮次行还没插入）
  "recorded_at"    timestamp(3) NOT NULL,  -- 拿到任务行锁之后读的 clock_timestamp()，与 0267 的 decided_at 同理

  CONSTRAINT "task_owner_confirmation_review_record_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_owner_confirmation_review_record_review_fkey"
    FOREIGN KEY ("review_id", "request_id")
    REFERENCES "task_owner_confirmation_review"("id", "request_id") ON DELETE CASCADE,
  CONSTRAINT "task_owner_confirmation_review_record_task_fkey"
    FOREIGN KEY ("task_id", "owner_id") REFERENCES "task"("id", "owner_id") ON DELETE CASCADE,
  CONSTRAINT "task_owner_confirmation_review_record_shape" CHECK (
    ("kind" = 'REVIEW' AND "judgment" IS NOT NULL AND "reason" IS NULL AND "return_client_turn_id" IS NULL)
    OR ("kind" = 'RETURN' AND "reason" IS NOT NULL AND "judgment" IS NULL AND "return_client_turn_id" IS NOT NULL)
    OR ("kind" = 'PROBLEMS' AND "reason" IS NOT NULL AND "judgment" IS NULL AND "return_client_turn_id" IS NULL)
  )
);
-- 每份请求 REVIEW、RETURN、PROBLEMS 各至多一条。
CREATE UNIQUE INDEX "task_owner_confirmation_review_record_kind_key"
  ON "task_owner_confirmation_review_record"("review_id", "kind");
```

记录只插入，不更新，与 `task_owner_decision`「写下就不再改」是同一条规矩。RETURN 和 PROBLEMS 不会同时出现在同一份请求上：RETURN 只能在 owner 还没决定时写（§8 B3），PROBLEMS 只能在 owner 确认之后写（§9 L2）。REVIEW 可以与其中任意一种并存，比如先交 REVIEW、后来又发现问题。

### 3.3 其他表加的列

- `task_owner_confirmation_request.branch_sha char(40)`：见 D1。
- `session.branch_sha char(40)`：runner 报上来的分支顶端提交，报了就写，没报就不动。今天收到 `branchSha` 的有三处：心跳（`dto.sessions[].branchSha`）、`turnComplete`（`dto.branchSha`）和 `diffResult`（按 Commit 之后）。三处都只拿它和 `mergedSourceSha` 比较，并不存下来。
  - `turnComplete` 里这一列并进那条唯一的 session `updateMany` 一起写（那里的 I3 锁序注释：这个事务对 Session 行只写一次）。
  - 心跳只带正在跑一轮的会话（runner-go `session_pool.go#heartbeatSnapshot`）。所以执行停下之后，这一列只在它的下一轮或下一次 Commit 时才会动。有人在 Orbit 看不到的地方往这条分支提交（比如执行停着时手工 `git commit`），要到下一次上报才会被看到。这是已知的边界，不另加探测。
  - T1 判「已过期」要读这一列。
- `task_owner_decision` 加三列：
  - `review_record_id uuid`：这条决定所指的那份 REVIEW 记录，取值规则见 §7 Q4。外键指向记录行，ON DELETE RESTRICT。这与 0267 的 `task_owner_decision_request_fkey` 是同一种情形：删任务时，决定行和记录行都随任务 CASCADE 一起删掉。
  - `review_state text`：决定那一刻的审查状态，由服务端算出。CHECK 取值为 `NONE`、`UNDER_REVIEW`、`REVIEWED`、`NOT_REVIEWED`、`OUTDATED` 之一；在任务面板上确认、没有对应请求的决定，这一列为空。
  - `answers jsonb`：见 §7 Q4。
  
  CHECK `task_owner_decision_by_owner` 与 `task_owner_decision_send_back_shape` 不改。

**迁移**：只写一条，名为 `<号>_owner_confirmation_review`。号在落地时取，用 main 和各分支都没用过的下一个（写本文时 main 上最高是 0356），并登记进 `task-judgment-data-preserved.spec.ts` 的迁移账本。迁移里只有表、列、枚举和 §3.1 那一个触发器：不改 fence，不写任何 DML。已有的请求和决定一行都不动：它们没有审查行，读作「没有审查方」。

### 3.4 共享类型与 DoneRequest 的对齐

新文件 `src/shared/src/owner-confirmation-review.ts`，web 和 OrbitKit 都照它镜像：

```ts
/**
 * One line of a review. criterionKey / whyNotProven / coordinatorChecked / evidenceRefs are
 * AcceptedGap's fields (project-done.ts), with the same names and meanings: a notChecked line that
 * names a criterionKey IS an AcceptedGap, plus a key and a text.
 */
export interface ConfirmationReviewItem {
  /** Given by the server when the record is written: c1… checked, x1… notChecked, n1… needsYou,
   *  o1… leftOpen, p1… problems. Answers name items by it. */
  key: string;
  /** The line as the reviewer wrote it. 1–300 characters. */
  text: string;
  /** The project criterion the line is about, when the task serves one (the key project_get returns). */
  criterionKey?: string;
  /** notChecked only: why it could not be checked. At most 500 characters. */
  whyNotProven?: string;
  /** notChecked only: what was checked instead. At most 500 characters. */
  coordinatorChecked?: string;
  /** Where the evidence is: a commit, a CI run URL, an Orbit id, a command and its result.
   *  At most 10, each at most 500 characters. */
  evidenceRefs?: string[];
}

/** A line only the owner can decide: a question, its options, and the default the card preselects. */
export interface ConfirmationNeedsYouItem extends ConfirmationReviewItem {
  /** Each option has ask_owner's shape (label 1–200, description at most 500). Unlike ask_owner,
   *  which allows none, a needsYou line has 2–4: it is a choice, so it is answerable in one tap. */
  options: Array<{ label: string; description?: string }>;
  /** Index into options. Required: the card preselects it and tags it Recommended. */
  recommendedOption: number;
}

export interface ConfirmationReviewLists {
  checked: ConfirmationReviewItem[];        // at most 20
  notChecked: ConfirmationReviewItem[];     // at most 20
  needsYou: ConfirmationNeedsYouItem[];     // at most 10
  leftOpen: ConfirmationReviewItem[];       // at most 20
}

type WithoutKey<T> = Omit<T, 'key'>;

/** task_confirmation_review's input (§3.5). Items arrive without keys. */
export interface ConfirmationReviewInput {
  taskId: string;
  requestId: string;
  /** 40 lowercase hex; required when the request has a branch_sha, absent when it has none. */
  reviewedSha?: string | null;
  /** The reviewer's call, in a sentence or two. 1–500 characters. */
  judgment: string;
  checked: WithoutKey<ConfirmationReviewItem>[];
  notChecked: WithoutKey<ConfirmationReviewItem>[];
  needsYou: WithoutKey<ConfirmationNeedsYouItem>[];
  leftOpen: WithoutKey<ConfirmationReviewItem>[];
}

/** task_confirmation_return's input (§8). */
export interface ConfirmationReturnInput {
  taskId: string;
  requestId: string;
  reviewedSha?: string | null;
  /** Delivered to the run as its next message. 1–4000 characters. */
  reason: string;
  /** 1–10 lines: what is wrong, each with its evidence. */
  problems: Array<Pick<ConfirmationReviewItem, 'text' | 'criterionKey' | 'evidenceRefs'>>;
}

// ── What the reads serve (§4–§9). Instants are ISO strings on the wire. ──

export type OwnerConfirmationReviewState =
  'UNDER_REVIEW' | 'REVIEWED' | 'NOT_REVIEWED' | 'OUTDATED' | 'RETURNED';
export type OwnerConfirmationNotReviewedReason =
  | 'TIMED_OUT' | 'REVIEWER_ENDED' | 'REVIEWER_STOPPED' | 'NO_COORDINATOR'
  | 'AUTOMATIC_OFF' | 'COORDINATOR_PAUSED' | 'UNREACHABLE';

/** The review of one confirmation request, as the card and its receipts draw it. */
export interface OwnerConfirmationReviewView {
  reviewId: string;
  state: OwnerConfirmationReviewState;
  /** Set exactly when state is NOT_REVIEWED (T2). */
  notReviewedReason: OwnerConfirmationNotReviewedReason | null;
  /** Set exactly when state is OUTDATED (T3); branchSha is the run's tip now, for BRANCH_MOVED. */
  outdated: { cause: 'NEWER_REPORT' | 'BRANCH_MOVED'; branchSha: string | null } | null;
  reviewer: {
    kind: 'PROJECT_COORDINATOR' | 'TASK_CREATOR';
    sessionId: string | null;
    /** The reviewer session's title now (S5); null when it cannot be read. */
    title: string | null;
  };
  /** The request's requestedAt: "Reviewing since". */
  since: string;
  dueAt: string;
  windowSeconds: number;
  /** H2, computed by the server from the record shown: PROBLEMS when there is one, else REVIEW. */
  headline: ConfirmationReviewHeadline | null;
  review: {
    recordId: string;
    recordedAt: string;
    reviewedSha: string | null;
    judgment: string;
  } & ConfirmationReviewLists | null;
  returned: ConfirmationReturnRecordView | null;  // the RETURN record (§8)
  problems: ConfirmationReturnRecordView | null;  // the PROBLEMS record (§9)
}

export interface ConfirmationReturnRecordView {
  recordId: string;
  recordedAt: string;
  reviewedSha: string | null;
  reason: string;
  problems: ConfirmationReviewItem[];
}

export type ConfirmationReviewHeadline =
  | { kind: 'NEEDS_YOU'; text: string; more: number }
  | { kind: 'NOTHING_NEEDS_YOU'; notChecked: number }
  | { kind: 'PROBLEMS_AFTER_CONFIRM'; problems: number };

/** One answer, as the decision row stores it (Q4). */
export interface OwnerConfirmationAnswer {
  key: string;
  option: number | null;
  text: string | null;
  /** OWNER: the owner chose it on the card. NOT_SHOWN: the client did not know about reviews, so
   *  the recommended option was recorded for them (Q3). */
  source: 'OWNER' | 'NOT_SHOWN';
}
```

读面怎么挂这些类型（`owner-confirmation-read.ts` 的 `OwnerConfirmationView`，web 与 OrbitKit 照样镜像）：
- `waiting.review: OwnerConfirmationReviewView | null`：等待中的请求的审查，没有审查行时为 null；
- 每条 `decisions[]` 多四个字段：`review`（它所回答的请求的审查，状态现算）、`reviewStateAtDecision`、`reviewRecordId`、`answers: OwnerConfirmationAnswer[]`；
- 新数组 `reviewerReturns: Array<{ requestId; sessionId; requestedAt; review: OwnerConfirmationReviewView }>`：被审查方退回的请求，最早的在前。这些请求不在 `waiting` 里，也没有决定行，卡片据此把自己画成退回记录（§8 B6）。

**id 的写法**：
- `requestId` 沿用现有规矩，是原始 UUID：它在 `src/shared/src/codec.ts` 的 `NEVER_PUBLIC_ID_FIELDS` 里，`DecideOwnerConfirmationDto.requestId` 用的是 `@IsUUID`。工具的输入、审查块里的 `request-id` 都写原始 UUID。
- `reviewId`、`reviewRecordId` 是新的 public id 字段，登记进 `PUBLIC_ID_FIELDS`；`recordId` 已经登记过。
- `taskId`、`sessionId` 已经登记；`runSessionId`、`reviewerSessionId` 要新登记。

与 `src/shared/src/project-done.ts` 的对照：

| 审查记录 | DoneRequest / AcceptedGap | 说明 |
|---|---|---|
| `judgment` | `DoneRequest.judgment` | 审查方的结论，一两句话 |
| `notChecked[]` | `DoneRequest.gaps: AcceptedGap[]` | 每条可带 `criterionKey`、`whyNotProven`、`coordinatorChecked`、`evidenceRefs`，字段同名同义，只多出 `key` 和 `text`。AcceptedGap 的 `criterionKey` 是必填的，所以只有带了 `criterionKey` 的 notChecked 条目才能原样当作 AcceptedGap，比如 B 线要把审查变成项目收尾时接受的缺口 |
| `checked[]` / `leftOpen[]` / `needsYou[]` | 无对应 | 用同一种条目形状。needsYou 多出 `options` 和 `recommendedOption`：每个选项的形状取自 `ask_owner`，个数 2–4、`recommendedOption` 必填是本文的规则 |
| `requestId` + `reviewedSha` | `DoneRequest.criteriaDigest` | 都用来封住「审的是哪一份」：digest 变了，请求就 409；这里请求被顶替或分支移动了，记录就过期（§4） |

与 `AcceptedGap` 有一处不同：AcceptedGap 保留未知键（`[key: string]: unknown`），因为它是 owner 的卡片发回来的；审查记录是 agent 的输入，DTO 按白名单校验，出现未知键就 400。

### 3.5 工具 `task_confirmation_review`

- 入口：MCP 工具 `task_confirmation_review`；CLI `orbit task confirmation-review --json <文件|->`，整份输入就是一个 JSON；runner 门 `POST /runner/tasks/:taskId/owner-confirmation/review`，挂在 `RunnerTaskOwnerConfirmationController`，与 `claim` 在一起。
- `taskId` 走 `PublicIdPipe`；`requestId` 是原始 UUID，DTO 用 `@IsUUID`（§3.4「id 的写法」）。审查方不是这个任务的执行会话，所以 `taskId` 没有默认值，必须给。
- 门按下表顺序判，前一条不过就不读后一条，什么都不写。拒绝的形状与 `task-owner-confirmation.ts` 相同：`code`、`kind: 'REFUSAL'`、`requiredAction`、`message`。

| # | 要求 | 不满足时 |
|---|---|---|
| 1 | 请求带会话头，即调用方是会话 | 403 `CONFIRMATION_REVIEW_REQUIRES_SESSION` |
| 2 | 请求属于本账户、有审查行，且调用方会话等于 `reviewer_session_id` | 403 `CONFIRMATION_REVIEW_NOT_THE_REVIEWER`。没有审查行时用同一个码，文案说明这个任务没有审查方 |
| 3 | 调用方会话此刻有一轮在进行（`IN_FLIGHT`） | 409 `CONFIRMATION_REVIEW_OUTSIDE_TURN` |
| 4 | 重试：这一会话在这同一轮里已经交过 REVIEW 记录（工具回包丢了之后的重试） | 直接返回已有那份记录，带 `alreadyRecorded: true`；内容不同也不改写，后面几条都不再判 |
| 5 | 请求仍是任务最新的一条 | 409 `CONFIRMATION_REVIEW_SUPERSEDED`，附最新请求的 id |
| 6 | 这份请求还没有 REVIEW 记录，也没有 RETURN 记录 | 409 `CONFIRMATION_REVIEW_ALREADY_RECORDED` |
| 7 | 字段合法：长度和个数符合 §3.4；`whyNotProven` / `coordinatorChecked` 只出现在 notChecked；`options` / `recommendedOption` 只出现在 needsYou；请求有 `branch_sha` 时 `reviewedSha` 必填，且为 40 位小写十六进制；请求没有 `branch_sha` 时 `reviewedSha` 必须不给 | 400 |
| 8 | owner 已经对这份请求做了决定时，`needsYou` 必须为空 | 400 `CONFIRMATION_REVIEW_NEEDS_YOU_AFTER_DECISION`，requiredAction `RETURN_IT_IF_SOMETHING_MUST_CHANGE` |

项目在审查期间关掉了 Automatic，审查方照样可以交记录：开关只管新请求有没有审查方（S2）和退回（§8 B5）。卡片这一侧，持有立即结束、按兜底显示（§16 F2）；协调者之后补交的记录按 §13 A7 处理。

- 全部通过后，在任务行锁（rank 50）下插入 REVIEW 记录，`recorded_at` 取拿锁后的 `clock_timestamp()`。`reviewed_sha` 照收，不要求等于请求或分支当前的提交；不相等就是 §4 的「已过期」。
- 提交后发 `TASK_CHANGED`（该任务）和 `publishSessionUpdated(执行会话)`，让卡片和列表行重读。
- 回执：`{ recordId, requestId, state, alreadyRecorded }`，其中 `state` 是写入后按 §4 算出的状态。

### 3.6 审查方写不到的地方

审查记录不进 DONE fence，也不进 `evaluateTaskCompletion`。它不写 `task`、`task_owner_decision` 和请求行，也决定不了首行用哪一种：§6 H2 只看条目的个数。它不能预选、禁用或改写卡片上的按钮。审查方能做的只有两件事：交回这份记录，或者按 §8 退回。

---

## 4. 状态（T）

**T1（四种状态，外加「已退回」）**：一份请求的审查状态在读的时候算，按下表从上往下，先命中先得：

| 顺序 | 状态 | 条件 |
|---|---|---|
| 0 | （不画审查栏） | 请求没有审查行。包括 §1 S2 中「没有审查方」的情况，以及本文生效之前记下的请求 |
| 1 | `RETURNED` 已被审查方退回 | 有 RETURN 记录 |
| 2 | `OUTDATED` 已过期 | 有 REVIEW 记录，并且满足其一：请求已不是任务最新的一条；记录的 `reviewed_sha` 与执行会话当前的 `session.branch_sha` 都不为空且不相等 |
| 3 | `REVIEWED` 已审 | 有 REVIEW 记录 |
| 4 | `NOT_REVIEWED` 未经审查 | 满足下列任一：`delivery = 'REFUSED'`；`reviewer_ended_at` 不为空，或审查方的会话行已不存在（§3.1 的触发器）；`abandoned_at` 不为空（T5）；已投递的那一轮没被 engine 读到就被收掉了，即按 `(reviewer_session_id, delivery_turn_client_id)` 在 `conversation_turn` 里找不到它（打断、撤回会删掉它），或者它是 `ANSWERED` 而 `delivered_at` 为空（失败时的排空、`transitionEnd`、打断受保护目标时会这样收掉它）；`now >= due_at` |
| 5 | `UNDER_REVIEW` 审查中 | 其余情况，包括 `PENDING` 和 `DELIVERED` |

第 4 行的每一个条件都只增不减：一旦成立，以后的任何写入都不会让它再不成立。所以一份请求一旦变成「未经审查」，就不会退回「审查中」、再从 needs-you 里消失。能把它变走的只有审查方补交的记录（第 1–3 行）。

**以上是 `TASK_CREATOR` 的读法。`PROJECT_COORDINATOR` 的第 4 行按 §16 F2 读**，有三处不同：不读 `reviewer_ended_at`，协调会话是否结束读 `conversationIsOver`，暂停不算结束；Automatic 被关掉立即兜底；投递轮次没被读到时看协调会话是否暂停。第 1–3 行不变，有记录时不进第 4 行。owner 自己把 Automatic 重新打开或恢复协调会话时，持有可能恢复；这是 owner 的动作，不是系统的反复。

**T2（未经审查的原因）**：`notReviewedReason` 按下面的顺序，取第一个成立的：
1. 投递被拒（`REFUSED`），按拒绝码映射：`NO_COORDINATOR`、`REVIEWER_ENDED`、`AUTOMATIC_OFF`、`COORDINATOR_PAUSED` 原样保留；`REVIEWER_IS_THE_RUN`、`SESSION_UNAVAILABLE`、`SUPERSEDED`、`SENT_BACK` 记为 `UNREACHABLE`。其中 `SUPERSEDED` 和 `SENT_BACK` 两种请求已经不在 owner 面前，不会被画出来。`COORDINATOR_PAUSED` 只会来自投递那一刻（D2 第 6 条，指项目熔断）。`AUTOMATIC_OFF` 来自投递那一刻（D2 第 5 条），`PROJECT_COORDINATOR` 还会来自读的时刻（§16 F2）。
2. `REVIEWER_ENDED`：`reviewer_ended_at` 不为空，或审查方的会话行已不存在。
3. `REVIEWER_STOPPED`：`abandoned_at` 不为空，或已投递的那一轮没被读到就被收掉了。
4. `TIMED_OUT`：窗口已到。

**T3（已过期的原因）**：`outdated.cause` 有两种。`NEWER_REPORT`（请求被新的请求顶替）优先于 `BRANCH_MOVED`；`BRANCH_MOVED` 时带上执行会话当前的提交 `branchSha`。拿不到分支或提交号时（不是 git 工作区、runner 太旧、会话行已删），不判 `BRANCH_MOVED`。

**T4（状态只因以下写入而改变）**：
- D2 的投递条件更新，或拒绝后补写的 `REFUSED`；
- T5 写 `abandoned_at`；
- §3.1 的触发器写 `reviewer_ended_at`，或审查方会话行被彻底删除；
- 审查轮次被打断或撤回删掉，或在排空时被收掉；
- §3.5、§8、§9 写记录；
- 下一份请求写入，顶替了这一份；
- `session.branch_sha` 移动（只影响「已审」与「已过期」之间，T3）。

时钟只在读里比较一次 `now >= due_at`。没有任何定时任务负责把「审查中」改成「未经审查」。

**T5（审查方读过、停下，又没有东西会叫醒它）**：判定条件和时刻都与 SRR §4.1 的 NO_REPLY 相同。审查方会话在 `turnComplete` 里停到等待输入时（条件与调用 `closeUnansweredRequests` 的一样：不是失败，且 `nextStatus = AWAITING_INPUT`），找出满足以下全部条件的审查行：
- `reviewer_session_id` 是它；
- `delivery = 'DELIVERED'`；
- 没有 REVIEW 记录，也没有 RETURN 记录；
- `abandoned_at` 为空；
- 投递的那一轮在 `conversation_turn` 里的 `delivered_at` 不为空，即 engine 已经收到过。

如果此时 `session-request.ts#hasPendingWakeSource` 为假，就在同一个事务里给这些行写 `abandoned_at = now()`。理由与 SRR §4.1 相同：模型常常审完就忘了调工具，只靠窗口兜底的话，项目里默认要多等两小时。审查方之后仍可以补交记录，状态随之变成「已审」（T1 中记录排在前面）。

**T6（只有一处定义）**：`owner-confirmation-review.ts#confirmationReviewStates(tx, requests, readAt)`（批量）是审查状态唯一的定义。下面这些地方都调用它，不各自另算：
- 卡片的读；
- needs-you 的计数；
- 会话行上的 Under review；
- 两个工具的门（§3.5 第 8 条、§8 B8）；
- 确认门的答案校验（§7）。

道理与 `coordinatorHolds` 同时供队列和计数使用相同。

---

## 5. needs-you、Under review 与超时（N）

**N1（审查中不计入）**：`owner-confirmation-read.ts#readWaitingOwnerConfirmations` 只返回审查状态不是 `UNDER_REVIEW` 的等待请求。于是一张审查中的卡片：
- 不进 `readOwnerDecisionSignals`；
- 会话行的 `pendingApprovals` 不因它加一，也不设 `waitingKind`；
- 不出顶部提示条（iOS 的 `1 open question below`），web 的 DecisionRail 也不出指向它的那一行；
- 各工作区的 needs-you 计数不算它；
- 任务列表的行也跟着变：`tasks.service.ts#awaitingOwnerConfirmation` 读的也是 `readWaitingOwnerConfirmations`，所以审查中的任务行 `awaitingOwnerConfirmation` 为 false，改由 N3 的 `confirmationUnderReview` 说明。

这沿用 owner decision 10：还在别人手里的事，不来叫你。

`PROJECT_COORDINATOR` 的持有比这更进一步：连卡片也不画（§13 A2）。`TASK_CREATOR` 的卡片在审查中照常画。

**N2（离开审查中之后）**：
- `REVIEWED`、`NOT_REVIEWED`、`OUTDATED` 状态的等待请求照今天的方式计数：`kind = 'OWNER_CONFIRMATION'`，行上写 `Waiting for your confirmation`。
- `RETURNED` 的请求已经不在等待（§8 B3），不计数，什么都不亮。

**N3（Under review）**：会话行（`ControlSessionSummary` 和会话列表的行）新增一个字段：

```ts
/** The OWNER_CONFIRMED request on this run's session that is still with its reviewer: the row says
 *  "Under review" and is not counted. Sent as null when there is none; absent from an older server. */
confirmationUnderReview?: {
  requestId: string;
  taskId: string;
  reviewerKind: 'PROJECT_COORDINATOR' | 'TASK_CREATOR';  // revision 3: S5 draws `Coordinator` from it
  reviewerSessionId: string | null;
  reviewerTitle: string | null;
  since: string;   // the request's requestedAt
  dueAt: string;
} | null;
```

- 只在审查状态为 `UNDER_REVIEW` 时非空。其他状态要么在卡片上，要么按 N2 计数。
- 这个字段总是带上，没有就给 `null`，约定与 `retryAt` 相同：客户端把摘要并进已有的行时，`null` 表示「清掉」，字段缺席才表示「不变」。
- 用词：会话标题栏的副标题写 `Under review · Open · 2m ago`，即把今天写 `Waiting for your confirmation` 的那一段换成 `Under review`。会话列表行写 `Under review · <审查方标题>`，用次要文字颜色加时钟图标，不点橙色，也不进 needs-you 分组。它占的位置和优先级，与今天 `waitingKind = OWNER_CONFIRMATION` 相同。
- 任务列表的行（`TaskItem`）新增布尔字段 `confirmationUnderReview`，审查中为 true，与 `awaitingOwnerConfirmation` 不会同时为 true。行上的说明写 `Under review`，放在今天 `Waiting for your confirmation` 的位置（OrbitKit `TaskListLogic.rowPhrase`，web 的对应处）。

**N4（窗口）**：`window_seconds` 在 D1 写下后就不再变：
- `PROJECT_COORDINATOR`：取请求那一刻的 `project.exception_escalation_seconds`（默认 7200）。之后改项目设置，只影响后来的请求，与 ILC X-E2 相同。
- `TASK_CREATOR`：取常量 `OWNER_CONFIRMATION_REVIEW_WINDOW_SECONDS_OUTSIDE_PROJECTS = 1800`，它不是设置项。

`due_at = request.requested_at + window_seconds`。窗口从请求时起算，而不是从投递时起算：owner 等待的是执行停下之后的时间，投递慢不该让他多等。

**N5（客户端怎么跟上）**：到 `due_at` 时，服务端什么都不写，也什么都不推（G3）。客户端靠三条规则跟上：
- 状态因服务端自己的写入而改变时（D2 被拒、T5、交回记录、退回），服务端在提交后发 `TASK_CHANGED`（该任务）和 `publishSessionUpdated(执行会话)`。
- 审查方会话结束、或审查轮次被打断撤回时，发出的是审查方会话自己的更新（触发器不发事件）。客户端收到某个会话的更新，而这个会话正是某一行 `confirmationUnderReview.reviewerSessionId` 时，重读那一行（以及开着的那张卡）。
- 客户端在前台持有一张审查中的卡片或一行 Under review 时，自己在 `dueAt` 之后 1 秒重读一次那一行和那张卡；回到前台或启动时照常重读。这是客户端的本地计时，不是服务端的定时任务。

**N6（推送）**：确认卡出现时不推送，`PushService.needsYouSessions` 也不数它，修订 3 不改第二点，兜底的卡片也不响。新增的推送只有两条，都由已提交的事实触发、只响一次：§9 L5，以及协调会话呈上时的 §13 A6。持有期间什么都不推。

---

## 6. 审查栏与首行（H）

**H1（位置）**：卡片自上而下依次是：
1. 标题区：Confirm this task is done? / From Orbit / 任务标题 / You decide when this is done；
2. What counts as done；
3. What the agent said；
4. **审查栏**；
5. If you confirm；
6. Confirm done / Chat about this；
7. 提示行。

没有审查行时就没有审查栏，卡片和今天一样。

**协调会话呈上的卡片（修订 3）**：`PROJECT_COORDINATOR` 且 `REVIEWED` 时，顺序改成：
1. 标题区；
2. **开头块**（§13 A3）：协调者的结论、要 owner 决定的点及选项、检查摘要；
3. What counts as done（折叠成一行）；
4. What the agent said（折叠成一行，这是附上的执行会话证据）；
5. If you confirm；
6. Confirm done / Chat about this；
7. 提示行。

项目外的审查、未经审查（兜底）的卡片仍按上面的顺序。

**H2（首行，方案 B）**：首行由服务端从记录的条目算出，作为数据下发（§3.4 的 `ConfirmationReviewHeadline`）。措辞由三端各自的文案表负责，文案逐字一致（§12）。三种取值的算法：
- `NEEDS_YOU`：`text = needsYou[0].text`，`more = needsYou.length − 1`；
- `NOTHING_NEEDS_YOU`：`notChecked = notChecked.length`；
- `PROBLEMS_AFTER_CONFIRM`：`problems` 是 PROBLEMS 记录的条数（§9）。

有 PROBLEMS 记录时取第三种，否则按 REVIEW 记录取前两种之一。

- 有 needsYou 时写 `Needs you: <第一条的问题>`，`more > 0` 时后面接 ` (+<more> more)`，用橙色。
- 没有 needsYou 时写 `<N> not checked · nothing needs you`。N 可以是 0。用正文色加粗。
- 有 PROBLEMS 时（只出现在回执下，见 §9）写 `1 problem found after you confirmed` 或 `<N> problems found after you confirmed`，用橙色。
- 首行只占一行，放不下就截断，完整的文字在下面的条目里。
- 审查方的 `judgment` 不进首行。首行是哪一种，只由 needsYou 与 notChecked 的条数（回执下还有 problems 的条数）决定，审查方没有任何字段能左右它。
- 协调会话呈上的卡片不画这一行，改画开头块（§13 A3）：结论是署名原文，放在写明作者的框里，不是 Orbit 的话（G3）。旧客户端不认识开头块，继续画这一行。

**H3（各状态下的审查栏）**：标题行一律是 `REVIEW · <审查方标题>`，取不到标题时写 `Reviewer`。

- `UNDER_REVIEW`：时钟图标 + `Reviewing since <HH:MM>`（取 `since`）；下一行写 `Orbit will ask you once the review is in. You can still confirm now.`
- `REVIEWED`：标题行后面接 ` · <记录时间 HH:MM>`，右侧显示 `reviewed_sha` 的前 7 位（没有就不显示）。下面依次是：
  1. 首行；
  2. needsYou 的作答块（§7 Q2）：第一条的问题文字就是首行，紧接着画它的选项，其余各条依次画在下面；
  3. `Checked`、`Not checked`、`Left open` 三行：每行把该类条目的文字用 ` · ` 连起来，最多两行；点开后就地展开成逐条列表，带证据引用；没有条目的那一类不画；
  4. 最后一行是审查方的 `judgment`，加引号。
- `NOT_REVIEWED`：横线图标 + `Not reviewed`（`PROJECT_COORDINATOR` 写 `Not reviewed by the coordinator`，§16 F5）。下一行按原因（T2）写一句话，后面再接 ` Only the agent that did the work has checked this.`。各原因的句子（`PROJECT_COORDINATOR` 用 F5 的表）：
  - `TIMED_OUT`：`No answer within <窗口>.`，窗口写成 `30 min`、`2 h`、`1 h 30 min` 这样
  - `REVIEWER_ENDED`：`The reviewer’s session ended before it answered.`
  - `REVIEWER_STOPPED`：`The reviewer stopped without answering.`
  - `COORDINATOR_PAUSED`：`This project’s coordinator is paused.`
  - `AUTOMATIC_OFF`：`Automatic was switched off for this project.`
  - `NO_COORDINATOR`：`This project has no coordinator conversation.`
  - `UNREACHABLE`：`The reviewer could not be reached.`
  
  之后审查方如果补交了记录，审查栏就变成 `REVIEWED`。
- `OUTDATED`：提交号加删除线，下面用橙色写 `Outdated`。再下一行，`BRANCH_MOVED` 时写 `Written for <旧提交前 7 位>. The branch is at <新提交前 7 位> now, so this says nothing about the last commit.`；`NEWER_REPORT` 时写 `Written for an earlier report.`。最后是折叠的 `Show the old review`，点开是那份记录原样（没有作答控件，§7 Q3）。
- `RETURNED`：见 §8 B6。

- 持有中的卡片不存在，所以 `UNDER_REVIEW` 这一项对 `PROJECT_COORDINATOR` 只出现在回执下（§9 L3，owner 在持有期间从面板确认过）。

**H4（按钮不随审查变化）**：任何状态下，按钮都不预选、不禁用、不改顺序、不改文字（G2）。唯一的例外来自 owner 自己的输入：某条 needsYou 选了 `Other`、却还没写字时，Confirm done 禁用。这时按下去必然被 400 拒绝，而「必然失败的动作必须 disabled」。

---

## 7. 要你判断：逐条作答（Q）

**Q1（为什么要这样）**：2026-09-29，一张带 7 个拍板项的任务（`34WtVpiueVMDvAS5SIsh6`）被一次 Confirm 吞掉了：卡上没有地方作答，owner 按了 CONFIRM、没写 note，下游实现任务就按图上的现状做了下去。所以 needsYou 必须能在卡上逐条作答，答案随确认一起记下，并且送到会用它的地方。

**Q2（画法）**：每条 needsYou 画成一块：
- 问题文字；
- 单选的选项行，每行是 label 加 description；
- `recommendedOption` 那一项默认选中，并标 `Recommended`；
- 最后一行 `Other — say it in my own words`，选中后出现输入框；
- 证据引用折叠在问题下面，标题写 `Evidence`。

用词和行为都复用提问卡：web `CoordinatorQuestionCard.tsx` 的 `RECOMMENDED` / `OTHER_OPTION`，OrbitKit `OwnerItemCards.swift` 的 `recommended` / `otherOption`。所有作答块下面加一行提示：`Your answers are sent with Confirm done.`

**Q3（确认门的规则）**：`POST /tasks/:taskId/owner-confirmation` 的请求体多两个可选字段：

```ts
reviewRecordId?: string | null;  // 卡上作为当前审查画出的那份 REVIEW 记录；卡上没有就是 null
answers?: Array<{ key: string; option?: number | null; text?: string | null }>;
```

**认识审查的客户端**（本文之后的 web、iOS、macOS）每次确认都要带上 `reviewRecordId` 这个键，卡上没有当前审查时显式写 `null`。键缺席，就说明客户端早于本文。两种客户端分开处理：

1. **键缺席（旧客户端）**：不因审查拒绝任何确认，G2 的「拦不住」靠的就是这一条。此刻若是「已审、有 needsYou」，服务端替每条 needsYou 记下它的 `recommendedOption`，`source = 'NOT_SHOWN'`，意思是 owner 没看到这些问题。Q5 的投递和评论都会如实写明这一点。其他状态照今天受理，不记答案。
2. **键在场**：在任务行锁下、`ownerDecisionRefusal` 通过之后，按 §4 算出这份请求此刻的审查状态，再按下表判断：

| 此刻的审查状态 | `reviewRecordId` | `answers` | 结果 |
|---|---|---|---|
| 不画审查栏 / 审查中 / 未经审查 | null | 空 | 受理 |
| 不画审查栏 / 审查中 / 未经审查 | 非 null | 任意 | 409 `OWNER_CONFIRMATION_REVIEW_STALE` |
| 已审，没有 needsYou | null，或等于当前记录 | 空 | 受理 |
| 已审，没有 needsYou | 不等于当前记录的非 null 值 | 任意 | 409 `OWNER_CONFIRMATION_REVIEW_STALE` |
| 已审，没有 needsYou | null，或等于当前记录 | 非空 | 409 `OWNER_CONFIRMATION_REVIEW_STALE` |
| 已审，有 needsYou | 等于当前记录 | 每个 needsYou 键恰好一条，且合法 | 受理 |
| 已审，有 needsYou | 等于当前记录 | 缺少某些键 | 409 `OWNER_CONFIRMATION_ANSWERS_REQUIRED`，列出缺的键 |
| 已审，有 needsYou | null | 任意 | 409 `OWNER_CONFIRMATION_ANSWERS_REQUIRED` |
| 已审，有 needsYou | 不等于当前记录的非 null 值 | 任意 | 409 `OWNER_CONFIRMATION_REVIEW_STALE` |
| 已过期 | null，或等于那份旧记录 | 空 | 受理 |
| 已过期 | 其他值，或 `answers` 非空 | — | 409 `OWNER_CONFIRMATION_REVIEW_STALE` |

- 409 都是「卡片过时了」：客户端重读之后，会画出此刻的审查和它的问题。认识审查的客户端总能作答（默认项已经选好），所以这两个 409 不会把 owner 挡住，只会让他看到问题。
- 每条答案在 `option`（取 0 到 `options.length − 1`）和 `text`（1–2000 字符，对应 Other）之中恰好给一个。键是多余的、重复的或不存在的，都 400；400 只表示答案本身写错了。
- 409 的 `requiredAction`：`ANSWERS_REQUIRED` 配 `ANSWER_EACH_REVIEW_QUESTION`；`REVIEW_STALE` 配 `READ_THE_TASK_AGAIN_AND_DECIDE_WHAT_IS_WAITING_NOW`（即现有的 `STALE_ACTION`）。两个码都加进客户端的 `staleCodes`，标题写 `Not recorded: this card is out of date`，随后卡片重读。
- `SEND_BACK` 不带答案，带了就 400。它永远不会因为审查被拒：owner 的理由照常投给执行会话。owner 在卡上选过的项，只留在卡片自己的本地状态里。
- 在任务面板上确认时（`requestId` 为空，没有执行在等）不带答案。

**Q4（记下来）**：决定行仍然只插入，CHECK 不变。三列的写法：
- `review_state`：服务端算出的决定那一刻的状态；没有请求的面板确认为空。CONFIRM 和 SEND_BACK 都写。
- `review_record_id`：认识审查的客户端确认时，是它给的值（已校验属于这份请求，可以是 null）；旧客户端被代记答案时，是那份当前记录的 id，答案的键要靠它对上；SEND_BACK 时，是这份请求当前的 REVIEW 记录 id（没有就是 null）。
- `answers`：`OwnerConfirmationAnswer[]`（§3.4），每条是 `{ key, option, text, source }`；没有答案就不写这一列。

**Q5（送到会用它的地方）**：答案记下来的同时做两件事，回执上再显示一件：
1. **任务评论，写在决定的同一个事务里**（不是提交之后）：主键由决定 id 派生，加 `skipDuplicates`。署名与写法照 `session-request.service.ts#commentOnAskerTask`：署名按 `postRunFailureComment` 的规矩，正文用英文，说明这是 owner 对审查问题的回答，逐条列出「问题 — 答案」；`source = 'NOT_SHOWN'` 的条目注明「the owner's app did not show this question; what is recorded is the option the reviewer recommended」。之后任何读这个任务的 agent（`task_get` 会带上评论）都看得到——2026-09-29 那次缺的正是这一环。评论和决定同生同灭，不需要补偿点。
2. **给审查方的平台轮次，在提交之后**：审查方会话还没结束时投一条，`clientTurnId = 'owner-confirmation-answers:v1:<decisionId>'`，`NEXT_TURN`。正文由记录和决定这两行渲染出来，两者都不可变。内容包括：任务、`The owner confirmed it at <time>`、逐条「问题 → 选中的选项或 owner 的原话」（`NOT_SHOWN` 的条目照实标出）。审查方已结束就不投，也不复活它（ILC G6）。这一轮只是提醒：进程死在提交和投递之间，它就丢了，不补。答案仍在决定行和第 1 条的评论上，审查方读任务时就能看到。
   这一轮的回显和排队行带 `confirmationAnswers`（`ConfirmationAnswersCard`：`decisionId`、`taskId`、`title`、`decidedAt`、逐条 `{ key, question, choice, text, notShown }`），按轮次的键从决定行和审查记录现读，与正文同源。客户端画成 `You confirmed` 卡片，不画成 owner 的气泡：任务标题（链到任务）、`Your answers, sent to this reviewer`、逐条问题与答案（选项只写 label，不写序号；原话加弯引号；`notShown` 的条目注明 `Not shown to you — the recommended answer was recorded.`），给 agent 的原文收在 `What the reviewer was told` 折叠里。效果图见 `docs/mocks/confirmation-answers-turn/`（owner 2026-11-11 认可）。
3. **回执**：显示 `Your answers`，逐条写「问题 — 答案」（§9 L3）。`NOT_SHOWN` 的条目旁边写 `Not shown to you — the recommended answer was recorded.`

---

## 8. 审查方退回（B）：新增的 agent 权限

今天，能让一份确认请求回到执行会话的只有 owner 的 Send back。本节给审查方一个范围窄得多的同类动作。这是一项新权限，下面把边界写全。owner 批准本文，就等于批准这一节。

**B1（工具）**：MCP 工具 `task_confirmation_return`；CLI `orbit task confirmation-return --json <文件|->`；runner 门 `POST /runner/tasks/:taskId/owner-confirmation/return`。输入是 §3.4 的 `ConfirmationReturnInput`：
- `reason` 1–4000 字符，与 owner 退回时的上限 `MAX_OWNER_DECISION_NOTE_CHARS` 相同；
- `problems` 1–10 条，每条的限制同 §3.4；
- `reviewedSha` 的规则与 §3.5 第 7 条相同。

**B2（谁能用）**：只有这份请求审查行上的审查方会话，而且要在它的一轮之内；判定照搬 §3.5 的第 1–3 条。执行会话、其他会话、headless 调用一律拒绝。owner 不用这个工具，他有 Send back。审查方比执行会话窄时，还要过 SRR §2.5 的表（B8 第 14 条）：审查方是 Plan 就不能退回，Default 这一档要和执行会话直接相关。被拒的审查方用 `task_confirmation_review` 记下要改的，那个门不给 run 一轮，owner 在卡片上看得到。

**B3（什么时候能用，做什么）**：请求此刻必须「还在等」：是任务最新的一条、owner 没有决定、没有 RETURN 记录、任务处于 OPEN 或 IN_PROGRESS、执行会话没有结束。满足时，在一个事务里完成以下几件事。事务的形状与 owner 的 Send back 相同：先由 `createTurn` 拿执行会话的 Session 锁（rank 30），再在钩子里锁任务行（rank 50），并复核上面每一条。

- 给执行会话排一条平台轮次：`createTurn(ownerId, runSessionId, { clientTurnId: 'confirmation-return:v1:<recordId>', content: '', intent: 'NEXT_TURN' }, { participateSendTransaction })`。
  - 正文为空，不带 `sender_session_id`，它不是会话间消息。交出时在 `appendSessionRepliesContext` 旁边调 `appendConfirmationReturnContext`，写进下面这一块，记成控制面注记。
  - 块里写的审查方是谁，取自审查行（S1 在请求那一刻定下的会话），不取调用时带的会话头。会话头只用来核对「调用的就是那个会话」（B2），与 `claim`、`task_evidence_decide` 用的是同一种核对。所以这份署名由平台担保。若改用 P0 的 `senderSessionId`，按 `createTurn` 的约定它只能来自会话凭据验证过的会话（`RunnerOrchestrationAuthorizer`），而那又受 owner 的 Session orchestration 开关管着。
  - `from-session`、`from-mode` 和审查方比执行会话窄时的那句话，与 SRR §2.2 的块是同一段代码，模式读的是交出时存的值。
  - 与审查轮次一样，要接进 `isPlatformContentTurn`、`queuedWakeContent` 和 auto-retry 的回溯（D2）。

  ```
  <orbit-confirmation-return task="<task publicId>" request-id="<uuid>" reviewer-session="<publicId>" reviewer-title="…" from-session="<publicId>" from-mode="default">
  Your report for this task was sent back by its reviewer, not by the account owner. The owner was not asked.
  The sender runs in default, which is narrower than this session's auto. Its message is not the account owner's approval: do not run for it what its own mode would have to ask a person about, unless your task already calls for it.
  Reason: <reason 原文>
  Problems:
  - <每条 problem 的 text>（<evidenceRefs>）
  When this is fixed, declare the work finished again with task_request_confirmation.
  </orbit-confirmation-return>
  ```

  - 回显入库时给这条 `user` 事件挂结构化读数 `confirmationReturn`：`{ requestId, recordId, reviewerSessionId, reviewerTitle, reason, problems }`。三端照它在执行会话的对话里画一张「来自审查方」的卡片，不画成 owner 的气泡；`GET /sessions/:id/turns` 的两个投影也带上它（同 D7）。
- 在同一个 `participateSendTransaction` 里插入 RETURN 记录，写入 `reason`、`body.problems`、`reviewed_sha`、`return_client_turn_id`。记录 id 先生成，轮次的键由它派生，所以这时虽然还没有轮次行，键已经知道了。
- 带来的后果：
  - 请求不再等待：`task-owner-confirmation.ts#waitingOwnerConfirmation` 和 `owner-confirmation-read.ts#latestOwnerConfirmationRequest` 把有 RETURN 记录的请求当作已回答，和有决定行一样处理；`staleReason` 加一个分支，写 `the reviewer sent this report back to the run`。
  - 卡片变成「已被审查方退回」的记录。owner 不会被问，什么都不亮。
  - 任务保持 OPEN。这份请求用掉的那次声明不会恢复：执行改完后要重新调 `task_request_confirmation`，等它停下时才会有新的请求和新的审查。
- 执行会话正在跑一轮时（比如 owner 正在和它聊），这条消息排在后面，和 owner 的消息一样。

**B4（不能做的事）**：
- 不写任务状态，不写 `task_owner_decision`；
- 不能确认、取消任务，不能改验收标准或描述；
- 不能退回 owner 已经决定的请求（那种情况走 §9 L2）；
- 不能把消息发给执行会话以外的会话；
- 任务已结算时不能退回。

**B5（次数与开关）**：
- 每份请求至多一次 RETURN（唯一键保证）。
- 同一任务在 owner 最近一次决定之后（没有决定过就从头算），至多退回 `CONFIRMATION_RETURNS_BEFORE_OWNER = 3` 次。第 4 次返回 409 `CONFIRMATION_RETURN_LIMIT`，requiredAction `RECORD_A_REVIEW_FOR_THE_OWNER`：这时应改为交一份 REVIEW，把剩下的问题放进 needsYou 或 notChecked，由 owner 决定。计数方法：该任务的 RETURN 记录中，`recorded_at` 晚于该任务最新一条 `task_owner_decision.decided_at` 的条数。这个上限与 ILC X-C3 的链上限取同一个数，理由也相同：agent 之间来回的环，要在 owner 那里收住。
- 审查方是 `PROJECT_COORDINATOR` 时：
  - 项目不是 Automatic，返回 409 `COORDINATOR_DISABLED`；
  - 项目处在暂停段里，返回 409 `PROJECT_FUSE_PAUSED`。按 ILC F7，暂停期间协调会话自己发起的动作要挂起，而退回挂起之后就过时了，所以直接拒绝，卡片照常交给 owner。

**B6（看得见）**：
- 卡片原地变成一条记录：标题区变暗，按钮去掉（不是禁用：这张卡已经不再是一个问题）。审查栏写 `REVIEW · <审查方> · <HH:MM>`，下面是 `Returned to the agent`，接着是加引号的 `reason`，每条 problem 一行 `Problem | <text>`，最后一行 `The agent got this as its next message. You were not asked.`
- 读面带上 `reviewerReturns[]`（§3.4），卡片据此来画。任务面板的确认历史里也会列出这条记录。
- 执行会话的对话里，那条退回轮次画成 B3 的「来自审查方」卡片：标题 `Sent back by the reviewer`，下面是审查方的名字、加引号的 `reason` 和每条 problem。

**B7（owner 的权力不变）**：退回之后，owner 照样可以在任务面板上直接确认（`requestId` 为空的确认，确认门照今天的规则受理），也可以给执行会话发消息。审查方的退回挡不住 owner 做任何事。

**B8（门的完整顺序）**：`task_confirmation_return` 按下表从上往下判，前一条不过就不读后一条。拒绝时什么都不写。

| # | 判断 | 结果 |
|---|---|---|
| 1–3 | 同 §3.5 第 1–3 条（是会话、是这份请求的审查方、在一轮之内） | 同 §3.5 |
| 4 | 重试：这一会话在这同一轮里已经为这份请求交过 RETURN 或 PROBLEMS 记录 | 直接返回已有那份记录，带 `alreadyRecorded: true`，后面几条都不再判 |
| 5 | 请求不是任务最新的一条 | 409 `CONFIRMATION_REVIEW_SUPERSEDED` |
| 6 | 这份请求已有 RETURN 或 PROBLEMS 记录 | 409 `CONFIRMATION_REVIEW_ALREADY_RECORDED` |
| 7 | 字段不合法（B1） | 400 |
| 8 | owner 已经**确认**了这份请求 | 转到 §9 L2：写 PROBLEMS 记录，不投给执行会话。不再判后面几条 |
| 9 | owner 已经**退回**了这份请求 | 409 `CONFIRMATION_RETURN_ALREADY_SENT_BACK`，文案说明 owner 已经把它退回执行会话了，要补充就用 `session_send` |
| 10 | 任务已经结算（DONE、CANCELLED、FAILED） | 409 `CONFIRMATION_RETURN_TASK_SETTLED` |
| 11 | 执行会话已经结束 | 409 `CONFIRMATION_RETURN_RUN_ENDED`，requiredAction `RECORD_A_REVIEW_FOR_THE_OWNER` |
| 12 | 已到 B5 的次数上限 | 409 `CONFIRMATION_RETURN_LIMIT` |
| 13 | `PROJECT_COORDINATOR`：项目不是 Automatic / 在暂停段里 | 409 `COORDINATOR_DISABLED` / `PROJECT_FUSE_PAUSED` |
| 14 | 审查方不能这样碰执行会话（SRR §2.5）：它比执行会话窄，并且是 Plan 或者不直接相关；或者执行会话跑的是复核任务，而它不是这个项目的协调者或判定会话 | 403 `SESSION_WIDER_THAN_CALLER`，文字说用 `task_confirmation_review` 把要改的写进 needsYou 或 notChecked / 403 `VERIFIER_MESSAGE_REFUSED` |
| — | 以上都没命中 | 按 B3 退回 |

第 5–14 条在写入的事务里、拿到任务行锁之后再复核一遍，不成立就抛错，什么都不写。第 4 条的重试和第 8 条的 PROBLEMS 不给 run 一轮，不问第 14 条。

---

## 9. owner 先确认、审查后到（L）

**L1（后到的 REVIEW）**：owner 对一份请求做了决定之后，审查方仍可以对它交 REVIEW（按 §3.5，第 8 条要求此时 needsYou 为空）。这份记录挂在那条决定的回执下面。

**L2（后到的问题记为 PROBLEMS）**：owner **确认**之后，审查方再调 `task_confirmation_return`，消息不投给执行会话，而是写一条 PROBLEMS 记录（`reason`、`problems`、`reviewed_sha`），提交后按 L5 通知 owner。每份请求至多一条。

**L3（回执）**：回执（`RecordedOwnerDecision`）多三样东西：`review`（这份请求的审查，状态现算）、`answers`、`reviewStateAtDecision`。画法照效果图第二排的「YOU CONFIRMED FIRST」：
- 沿用今天的回执行（`Confirmed done` 或 `Asked for more`，加决定时间）。这份请求的第一条记录如果晚于决定时间，下面加一行 `Before the review came in`。
- 回执下的审查栏按审查此刻的状态画，与 §6 H3 相同，只有这些不同：
  - 有 PROBLEMS 时：首行写 `<N> problem(s) found after you confirmed`（橙色），每条 problem 一行 `Problem | <text>`，下面一个 `Reopen task` 按钮；
  - `REVIEWED` / `OUTDATED`：照 H3 画，不带作答控件；
  - `UNDER_REVIEW`：第二行换成 `It will show here when it comes in.`（决定已经做了，「Orbit will ask you」不再成立）；
  - `NOT_REVIEWED`：照 H3 画；
  - 没有审查行：不画审查栏。
- 有 `answers` 时：写 `Your answers`，逐条「问题 — 答案」，`NOT_SHOWN` 的条目照 Q5 注明。

**L4（Reopen task）**：回执上的 `Reopen task` 只在同时满足两个条件时出现：有 PROBLEMS 记录；任务状态是 DONE、CANCELLED 或 FAILED（`TaskReopen.isOffered`）。按下去弹出的确认对话框、做的写入，都与任务面板上的相同：OrbitKit 用 `TaskReopen.request` / `TaskReopenCopy`，web 用 `TaskDetailPanel.tsx#reopenMutationOptions`。不造新的门。

**L5（推送）**：PROBLEMS 记录提交后，如果任务此刻是 DONE，就调 `PushService.notifyConfirmationProblems(recordId)` 给 owner 的设备推一条：
- 标题是任务标题；
- 正文写 `1 problem found after you confirmed` 或 `<N> problems found after you confirmed`；
- 点开进入执行会话里的那条回执。

每条 PROBLEMS 记录只推一次（每份请求也至多一条）。正文全是 Orbit 的话，不带审查方写的字。不计入角标，因为已结算的任务不算问题。推送是提交之后的尽力而为：进程死在提交和推送之间，这一条就丢了，不补。PROBLEMS 记录和回执还在，任务面板与执行会话里都看得到。

**L6（不计入 needs-you）**：后到的审查和问题都不进 needs-you 计数：任务已经结算，没有在等的问题。owner 靠 L5 的推送和回执得知。

---

## 10. 与现有规则的关系（G）

**G1（OWNER_CONFIRMED 仍只由 owner 本人确认）**：`task-owner-confirmation.ts#ownerConfirmationPrincipalRefusal` 不改。审查方会话无论走 runner 门，还是带着会话头走用户门，都会以 `OWNER_CONFIRMATION_REQUIRES_ACCOUNT_OWNER` 被 403，一行都不写。审查记录、退回、答案都不是决定行，0267 的 fence lane 只读 `task_owner_decision`。

本文对确认门只改三处（§0.2 G2）：
- §7 Q3：owner 自己的答案；
- §8 B3：有 RETURN 记录就当作已回答。这要改同一文件里的 `waitingOwnerConfirmation` 与 `staleReason`，会让卡片上的旧按键变成 STALE，但 owner 在任务面板上照样能确认。
- §13 A4：持有期间的面板确认视同回答被持有的请求。

三处都不能让 agent 确认，也不能让 agent 拦住 owner 确认：旧客户端从不因审查被拒；认识审查的客户端遇到 409，重读后就能作答。

**G2（Automatic 项目里的委托规则）**：`owner-confirmed-automatic-delegation.ts` 不改。Automatic 项目里，agent 只能为写着 OWNER_CONFIRMED 的判据声明这类任务。这些任务现在由协调会话持有，呈上后才到 owner 面前（§13）。

**G3（From Orbit 署名的含义）**：卡片上的 From Orbit 表示：这张卡由 Orbit 从行里组出来，按钮由 Orbit 授权、直接打到确认门，中间不经过任何 agent。agent 写的字只能以一种方式出现在卡上：放在写明作者的框里，原样显示。今天的 `WHAT THE AGENT SAID · <时间>` 是一例，审查栏 `REVIEW · <审查方> · <时间> · <提交>` 是第二例。agent 的字不会出现在这些地方：卡片标题、From Orbit 那一行、首行的计数与措辞、按钮、If you confirm，以及 Orbit 自己的任何句子。首行是 Orbit 推出来的；它引用的 needsYou 问题文字位于同一个署名框里，原样照录，不改写。

owner 确认卡的署名提示改为 `Orbit composed this card and authorised its buttons. Anything an agent wrote is shown in a box that names who wrote it.`：web 新增一个常量，挂在卡片署名的 `title` 上；OrbitKit 同步加一个对应的常量。其他卡片的署名提示不改。

**G4（ILC §0.1「owner 直接看卡片，不经 LLM 转述」）**：审查不是转述。
- 卡片上 Orbit 的事实，即验收标准、执行会话的报告、If you confirm，照旧由 Orbit 直接从行里画出来，审查栏另加在旁边。
- 审查方写不进 Orbit 的任何一行，也没有哪个 LLM 替 owner 概括这张卡。
- 授权的决定仍是 owner 在卡上做的。审查方的话以署名原文出现，是 owner 做决定时的一份参考，地位与 What the agent said 相同。

**G5（owner decision 10）**：持有期间什么都不呈现（§13），项目外审查中不计数，与「还在协调会话手里的待办不计数」（`ownerItemKind`）、`coordinatorHolds` 遵循同一条规矩。

**G6（ILC 的 G3 / G5 / G6 / G7）**：下面五个新前缀加进 ILC §0.3 G6 的表，以及 G7 表里「平台投递」那一行，由实现任务同时修改 ILC：

| `clientTurnId` 前缀 | 发给谁 | 定义在 |
|---|---|---|
| `owner-confirmation-review:v1:<reviewId>` | 审查方会话 | 本文 D2 |
| `confirmation-return:v1:<recordId>` | 执行会话（由 Orbit 转交审查方的话） | 本文 B3 |
| `owner-confirmation-answers:v1:<decisionId>` | 审查方会话 | 本文 Q5 |
| `run-question:v1:<approvalId>` | 协调会话 | 本文 R5 |
| `run-notify:v1:<requestId>` | 协调会话 | 本文 M3 |

五个前缀都加进 `watch-turn-key.ts` 的 `RESERVED_TURN_KEY_PREFIXES`，客户端的入口一律拒收。时钟（ILC G3）、唤醒事件与 blocker 的闭集（ILC G5）都不增加。

**G7（SRR）**：审查不是会话间请求，退回也不是会话间消息。这些平台轮次都不填 `sender_session_id`，所以 SRR §2.1「只有三个入口填它」不变。它们也不调 `session-message.ts#chargeSessionMessage`，不计入 SRR §2.4 的每小时上限。退回每份请求至多一次，另有 B5 的上限。退回把审查方的话交给一个 run 一轮，所以它走 SRR §2.5 的表和复核任务的规则（B8 第 14 条），块上写 `from-session`、`from-mode`（SRR §2.2）。

**G8（CIR 与 coordinatorHolds）**：两者是同一种「读时 hold」：hold 从投递行和时钟读出来，结束时不需要写任何东西去收回。三条路径共用的读法见 §16，与 `coordinatorHolds` 只有一处不同：窗口从事项产生时起算（§16 F4、§19 O1）。

**G9（B 线）**：本文不给审查方结案的权力。哪些任务可以由审查方结案、owner 只管合入 main，由 B 线任务根据量化报告另行决定。本文的记录已经为它留好了可以原样搬用的形状：notChecked 就是 AcceptedGap。

---

## 11. 实现切分与测试清单（I）

### 11.1 服务端（任务 `34Z35uusJWkeA99O23btE`）

| 编号 | 内容 | 条款 |
|---|---|---|
| I-S1 | 迁移：两个表、三个枚举、`reviewer_ended_at` 的触发器、`request.branch_sha`、`session.branch_sha`、`task_owner_decision` 的三列；登记迁移账本 | §3 |
| I-S2 | 存下 runner 报的 `branchSha`：心跳、`turnComplete`（并进那条唯一的 session `updateMany`）、`diffResult` 写 `session.branch_sha`；`recordOwnerConfirmationRequest` 收 `branchSha` 并返回 id | §3.3、D1 |
| I-S3 | 新文件 `tasks/owner-confirmation-review.ts`：`resolveReviewer`（S2–S4）、`confirmationReviewStates`（T1–T3，批量）、`reviewHeadline`（H2）、输入校验（§3.5 第 7 条、B1）、答案校验（Q3） | §1、§4、§6、§7 |
| I-S4 | 新文件 `tasks/owner-confirmation-review.service.ts`：`deliver`（D2，含 `ReviewDeliveryRefused` 与回滚后补写 `REFUSED`）、`deliverPendingFor(sessionId)`（D5）、`review`（§3.5）、`return`（B3、B8、L2）、答案轮次（Q5 第 2 条） | §2、§3、§7、§8、§9 |
| I-S5 | `turnComplete`：D1 在同一个事务里写审查行；提交后调 `deliver`；在审查方那一侧，T5 与 `closeUnansweredRequests` 放在同一处；提交后调 `deliverPendingFor` | D1、D2、D5、T5 |
| I-S6 | 两种空正文的平台轮次（`owner-confirmation-review:`、`confirmation-return:`）：交出时调 `appendOwnerConfirmationReviewContext` / `appendConfirmationReturnContext` 并记控制面注记；回显挂 `confirmationReviewRequest` / `confirmationReturn`；接进 `isPlatformContentTurn`、`queuedWakeContent`、auto-retry 的回溯；`GET /sessions/:id/turns` 的两个投影 | D2、D6、D7、B3 |
| I-S7 | 读面：`OwnerConfirmationView` 按 §3.4 加 `waiting.review`、`decisions[]` 的四个字段、`reviewerReturns[]`；`readWaitingOwnerConfirmations` 按 N1 排除；会话摘要加 `confirmationUnderReview`（列表、realtime upsert）；任务行加 `confirmationUnderReview`（`tasks.service.ts#awaitingOwnerConfirmation` 旁边） | N1–N3、L3、B6 |
| I-S8 | 确认门：DTO 加 `reviewRecordId` 和 `answers`，区分键缺席与 `null`，按 Q3 判、按 Q4 写，Q5 第 1 条的评论写在同一个事务里；`waitingOwnerConfirmation` / `latestOwnerConfirmationRequest` / `staleReason` 认 RETURN | Q3–Q5、B3 |
| I-S9 | runner 门：`RunnerTaskOwnerConfirmationController` 加 `review` 和 `return` 两个路由 | §3.5、B1 |
| I-S10 | `PushService.notifyConfirmationProblems` | L5 |
| I-S11 | runner-go：两个 MCP 工具、两个 CLI 子命令、`agent_instructions.go` 的子命令清单、`cli_mcp_parity_test`；`task_request_confirmation` 的描述补一句：`If the task has a reviewer, Orbit asks it first and the owner's card waits until the review is in.` | §3.5、B1 |
| I-S12 | 普查与清单：`db-write-inventory.ts`（新写入点及锁序）；public-id（`reviewId`、`reviewRecordId`、`runSessionId`、`reviewerSessionId` 登记进 `PUBLIC_ID_FIELDS`，`requestId` 保持原始 UUID）；改 controller 前的 `getOwnPropertyNames` 普查；`RESERVED_TURN_KEY_PREFIXES`；ILC §0.3 的两张表 | §3.4、G6 |

**pg spec 清单**（新文件 `tasks/owner-confirmation-review.pg.spec.ts`，每条注明对应条款）：

1. 解析审查方（修订 3：项目外才是这样，Automatic 项目里按 S2 仍由协调会话持有）：`creator_session_id` 为空的任务（owner 在 app 里建的、不带会话建的）没有审查行；在会话里建、却因缺 `X-Orbit-Agent-Id` 记成 `USER` 的任务照样有审查方；Automatic 项目 → 协调会话；非 Automatic 项目 → 没有审查行；项目外 → 建任务的会话；Automatic 项目没有协调会话 → `NO_COORDINATOR`；审查方已结束 → `REVIEWER_ENDED`；暂停中 → `COORDINATOR_PAUSED`。（S2、S4、D2）
2. 同一事务：`turnComplete` 之后第一次读，就是 `UNDER_REVIEW`，执行会话的 needs-you 为 0，`confirmationUnderReview` 非空，任务行 `awaitingOwnerConfirmation = false`、`confirmationUnderReview = true`。（D1、N1、N3）
3. 只投一次：`deliver` 调两次只得到一条轮次；被拒之后不再重投，拒绝码按 `ReviewDeliveryRefused` 的码写下；D5 能补投 `PENDING` 的行。（D2、D4、D5）
4. 项目外：派活的会话收到 `owner-confirmation-review:v1:` 轮次；排队时队列里显示审查块；交出时内容里带审查块；这一轮失败时 auto-retry 重发的是它自己。（D2、D3、D6）
5. 窗口：`readAt >= due_at` → `NOT_REVIEWED / TIMED_OUT` 并计数；项目内取冻结的 `exceptionEscalationSeconds`，事后改设置不影响；项目外为 1800。（N4、T1）
6. 空闲：审查方收到审查轮次、结束这一轮时没交记录，又没有唤醒源 → 立刻 `REVIEWER_STOPPED`；有一个在跑的后台作业时仍是 `UNDER_REVIEW`。（T5）
7. 不回头：审查方会话失败（没有排上重试）→ 触发器写 `reviewer_ended_at`，状态 `NOT_REVIEWED`；之后它被人叫醒、重新跑起来，状态仍是 `NOT_REVIEWED`。排上重试的失败不写；重试放弃时才写。审查轮次被打断删掉，或在排空时被收成 `ANSWERED` 而 `delivered_at` 为空 → `REVIEWER_STOPPED`。审查期间关掉 Automatic，`TASK_CREATOR` 不适用，`PROJECT_COORDINATOR` 按 F2 立即兜底，审查方仍能交记录。（§3.1、T1、F2）
8. 交回 REVIEW → `REVIEWED` 并计数；首行三种都覆盖；`judgment` 不出现在首行。（§3.5、H2）
9. 已过期：`session.branch_sha` 移动 → `OUTDATED / BRANCH_MOVED`；有了新请求 → 旧记录 `OUTDATED / NEWER_REPORT`。（T1、T3）
10. 工具门：非审查方 403；一轮之外 409；被顶替 409；重复记录 409；同一轮重试即使请求已被顶替也返回已有记录；`reviewedSha` 必填或必须不给；owner 决定后交 needsYou → 400。（§3.5）
11. 审查方不能确认：runner 门和带会话头的用户门都 403 `OWNER_CONFIRMATION_REQUIRES_ACCOUNT_OWNER`，一行不写。（G1）
12. 答案：Q3 表里每一行一个用例；`reviewRecordId` 键缺席的旧客户端在「已审、有 needsYou」时照样受理，答案记为推荐项、`source = 'NOT_SHOWN'`；CONFIRM 带完整答案 → DONE、`answers` 已写、任务评论与决定在同一个事务里（决定回滚时评论也没有）、审查方收到 `owner-confirmation-answers:v1:` 轮次；SEND_BACK 带答案 → 400，SEND_BACK 照写 `review_state`。（Q3–Q5）
13. 退回：执行会话收到 `confirmation-return:v1:` 轮次，`sender_session_id` 为空、交出时带 `<orbit-confirmation-return>` 块、回显带 `confirmationReturn`；RETURN 记录的 `return_client_turn_id` 等于轮次的键；请求不再等待，任务仍是 OPEN；卡片上的旧按键 STALE，面板确认受理；B8 表里每一行一个用例（包括第 4 次 409 `CONFIRMATION_RETURN_LIMIT`）。（B3、B5、B7、B8）
14. 后到：审查中 owner 确认，决定行记 `review_state = 'UNDER_REVIEW'`；之后的 REVIEW 挂在回执下；之后的 return → PROBLEMS 记录加一次推送，不投给执行会话。（L1、L2、L5）
15. 保留前缀：三个前缀在所有允许调用方指定 `clientTurnId` 的入口都被拒。（G6）

**要一并更新的旧钉子**（把旧行为写成断言的 spec，开工前先全仓 grep 一遍，以 grep 结果为准）：
- `tasks/task-owner-confirmation.pg.spec.ts`：现有夹具都是 `CreatorType.USER` 且没有 `creatorSessionId`，按 S2 没有审查方，行为不变，应保持绿色；「协调会话行保持暗」那条断言不动，另加一条「Automatic 项目里审查中的执行会话行也是暗的」。
- 任务列表的 spec 里断言 `awaitingOwnerConfirmation` 的地方（`git grep -n awaitingOwnerConfirmation -- '*.spec.ts'`）：加上 `confirmationUnderReview`。
- `sessions/needs-you-owner-decision.pg.spec.ts`：整行 deepEqual `readOwnerDecisionSignals`。
- 三个假 prisma：`realtime/stream-for-user.spec.ts`、`sessions/session-capabilities-payload.spec.ts`、`sessions/workspace-session-counts.spec.ts`。
- `tasks/task-judgment-data-preserved.spec.ts`：迁移账本。
- 按 enumsortorder 钉住标签全集的 pg spec：用 `git grep -nE 'enumlabel' -- '*.pg.spec.ts'` 找。本文只新增枚举类型，不往已有枚举里加值，预期不红，但要跑一遍确认。

### 11.2 三端（任务 `34Z35v1nS4l48MjxDIDXX`）

| 编号 | 内容 | 条款 |
|---|---|---|
| I-C1 | 照 §3.4 镜像共享类型（web 的类型、OrbitKit 的 Codable）；会话摘要与任务行加 `confirmationUnderReview` | §3.4、N3 |
| I-C2 | 审查栏的五种画法和首行：web `OwnerConfirmationCard.tsx`，原生 `ApprovalCards.swift#OwnerConfirmationCardView`（iOS 与 macOS 共用），文案放在 OrbitKit `OwnerConfirmation.swift` | H1–H4 |
| I-C3 | needsYou 作答块，以及确认时的请求体：总是带 `reviewRecordId` 键（没有就显式 `null`，Swift 要用 `encodeNil`，不能省略），有 needsYou 时带 `answers`；两个新拒绝码加进 `staleCodes` | Q2、Q3 |
| I-C4 | 退回记录：卡片原地变成记录；执行会话里的 `Sent back by the reviewer` 卡片（读 `confirmationReturn`） | B3、B6 |
| I-C5 | 回执：后到的审查、各状态下的审查栏、`Before the review came in`、`Your answers`（含 `NOT_SHOWN` 的注明）、PROBLEMS 与 `Reopen task` | L3、L4 |
| I-C6 | Under review：标题栏副标题、会话列表行、任务列表行；审查中不出提示条、不出 DecisionRail 的指向行；审查方会话一有更新就重读那一行；在 `dueAt` 本地重读 | N1、N3、N5 |
| I-C7 | 审查方会话里的 `Review requested` 卡片 | D7 |
| I-C8 | 署名提示的新文案 | G3 |

**测试**：web vitest；swift test。`OwnerConfirmationCopyParityTests` 扩到 §12 的每一条新文案。`NeedsYouOwnerDecisionTests` 加「审查中不计数」。iOS 截图由 CI probe 拍出，分别对照效果图第③台（审查中）、第④台（已审，方案 B）和第二排（未经审查、已过期、先确认后审查），另外补拍退回记录和 needsYou 作答块。

### 11.3 次序与冲突

1. 本文经 owner 确认后，服务端先开工；三端依赖读面的字段，可以先照 §3.4 的类型写桩。
2. 「If you confirm」那两个任务也在改 `owner-confirmation-read.ts`、`OwnerConfirmationView` 以及两端的卡片。后落地的一方 rebase 之后把字段并进来，不改对方的字段；报告的取法以那边为准（D6）。审查方本身也是执行会话时（D2 末条），它的卡片报告要靠那边的「报告取声明轮」才不会变成审查时的对话。
3. 服务端的 pg spec 和 apiserver 全量单测通过之后，三端再接上真实的读面。

---

## 12. 新造的用词（供 owner 拍板）

三端逐字一致。下表「位置」一栏说明用在哪里；「沿用」表示已有的字，不算新造。

| 文案 | 位置 | 新 / 沿用 |
|---|---|---|
| `Under review` | 执行会话标题栏副标题的第一段；会话列表行写作 `Under review · <审查方>`；任务列表行的说明 | 新 |
| `Review` | 审查栏标题（按标签样式大写显示），后接 ` · <审查方>`、时间、提交号 | 新 |
| `Reviewer` | 取不到审查方标题时的名字 | 新 |
| `Reviewing since <HH:MM>` | 审查中 | 新 |
| `Orbit will ask you once the review is in. You can still confirm now.` | 审查中 | 新（效果图原文） |
| `Needs you: <问题>`、` (+<N> more)` | 首行 | 新 |
| `<N> not checked · nothing needs you` | 首行 | 新（效果图原文） |
| `Checked`、`Not checked`、`Left open`、`Problem` | 审查栏的行标签 | 新 |
| `Not reviewed` | 未经审查 | 新 |
| `No answer within <窗口>.` 等 H3 列出的七句、` Only the agent that did the work has checked this.` | 未经审查的说明 | 新 |
| `Outdated`、`Written for <提交>. The branch is at <提交> now, so this says nothing about the last commit.`、`Written for an earlier report.`、`Show the old review` | 已过期 | 新 |
| `Returned to the agent`、`The agent got this as its next message. You were not asked.` | 确认卡上的退回记录 | 新 |
| `Sent back by the reviewer` | 执行会话里那条退回轮次的卡片 | 新 |
| `Evidence` | needsYou 作答块里证据引用的折叠标题 | 新 |
| `Your answers are sent with Confirm done.` | needsYou 作答块下面 | 新 |
| `Your answers` | 回执 | 新 |
| `Not shown to you — the recommended answer was recorded.` | 回执里 `NOT_SHOWN` 的答案旁 | 新 |
| `Before the review came in` | 回执 | 新（效果图原文） |
| `It will show here when it comes in.` | 回执下仍在审查中的审查栏 | 新 |
| `1 problem found after you confirmed` / `<N> problems found after you confirmed` | 回执首行、推送正文 | 新 |
| `Review requested`、`Due <HH:MM>` | 审查方会话里的卡片 | 新 |
| `You confirmed`、`Your answers, sent to this reviewer`、`What the reviewer was told` | 审查方会话里 owner 答案那一轮的卡片（Q5 第 2 条） | 新 |
| `Orbit composed this card and authorised its buttons. Anything an agent wrote is shown in a box that names who wrote it.` | 确认卡的署名提示 | 新 |
| `Coordinator` | 呈上卡片开头块的署名；`PROJECT_COORDINATOR` 的 `Reviewer` 位置 | 新（修订 3） |
| `Nothing else needs your decision.`、`<N> checked · <N> not checked · <N> left open` | 开头块 | 新（修订 3） |
| `Not reviewed by the coordinator` 及 §16 F5 的七句 | 三条路径的兜底标签 | 新（修订 3） |
| `Coordinator raised this for your decision · <N> to decide`、`Coordinator raised this for your confirmation` | 呈上时的推送正文（A6） | 新（修订 3） |
| `Asking the coordinator · since <HH:MM>` | 持有中的问题在执行会话页的提示 | 新（修订 3） |
| `Answered by the coordinator` | 转录里协调者答过的问题记录 | 新（修订 3） |
| `Recommended`、`Other — say it in my own words` | needsYou 作答块 | 沿用（提问卡） |
| `Open task session` | 审查方会话里的卡片 | 沿用（例外待办卡） |
| `Reopen task` 及其确认对话框 | 回执 | 沿用（`TaskReopenCopy`） |
| `Confirmed done`、`Asked for more`、`Waiting for your confirmation`、`Not recorded: this card is out of date` | 回执、计数后的行、拒绝提示 | 沿用 |

---

## 13. Automatic 项目：先持有、再呈上（A）

修订 3 的主体。今天的问题是：Automatic 项目里，执行会话一声明完成，确认卡就出现在 owner 面前，协调者只是在卡上多一栏。改完之后，执行会话只跟协调者说话，owner 面前只出现协调者带着判断呈上来的事，或者协调者没接住、由兜底直接交来的事。

**A1（什么是持有）**：一份确认请求被持有，当且仅当它的审查行 `reviewer_kind = 'PROJECT_COORDINATOR'`，并且 §4 算出的状态是 `UNDER_REVIEW`。判定只在 `owner-confirmation-review.ts#confirmationReviewStates` 一处（T6），不另存「已持有」字段。

**A2（持有期间 owner 看不到什么）**：下面每一处都读同一个判定，持有期间都不出现：

| 面 | 持有期间 | 依据 |
|---|---|---|
| 确认卡 | 不画。`GET /tasks/:id/owner-confirmation` 的 `waiting` 与 `ifConfirmed` 为 null | `readOwnerConfirmation` |
| 会话行与工作区的 needs-you | 不计。`readWaitingOwnerConfirmations` 已经排除 `UNDER_REVIEW`（N1），不用改 | `owner-decision-signal.ts` |
| 顶部提示条、DecisionRail 指向行 | 不出现 | N1 |
| APNs/FCM 推送、飞书卡 | 没有 | 持有期间没有任何调用点；呈上时见 A6 |

只留下一处被动显示，不算打扰：会话行和任务行仍写 `Under review`（N3），用次要文字色，不进 needs-you 分组。这样 owner 自己打开会话时，看得出这个任务没有卡死。执行会话里的回执（§8 B6 的退回记录、§9 的回执）也照常显示，不亮、不响。

**A3（呈上记录与卡片开头）**：呈上就是协调会话调用现有的 `task_confirmation_review`，写一条 REVIEW 记录（§3.2）。**不加新表，不加新工具**：这条记录已经带着呈上需要的全部内容。

| 协调者写的 | 在记录里 | 在卡片上 |
|---|---|---|
| 结论（必填，1–500 字符） | `judgment` | 开头块第一段，原文加引号，框的抬头写 `Coordinator · <HH:MM> · <提交前 7 位>` |
| 要 owner 决定的点（0–10 条，每条带选项和推荐项） | `needsYou[]` | 紧接结论，按顺序逐条画成作答块（§7 Q2） |
| 查过什么 / 没查什么 / 还留着什么 | `checked[]` / `notChecked[]` / `leftOpen[]` | 开头块最后一行摘要 `<N> checked · <N> not checked · <N> left open`，点开逐条 |
| 审查的提交 | `reviewed_sha` | 框抬头；分支移动后按 T3 读作已过期 |

读面在 `OwnerConfirmationReviewView` 上加一个字段：

```ts
/** Set exactly when reviewer.kind is PROJECT_COORDINATOR and state is REVIEWED: what the raised card leads with. */
lead: {
  conclusion: string;                  // the REVIEW record's judgment, verbatim
  points: ConfirmationNeedsYouItem[];  // its needsYou, in order
  checks: { checked: number; notChecked: number; leftOpen: number };
} | null;
```

没有 needsYou 时，开头块在结论下面写一行 `Nothing else needs your decision.`。结论是协调者的话，放在写明作者的框里，地位与 What the agent said 相同（G3）；Orbit 不据此预选、禁用或改写按钮（H4）。What counts as done 和 What the agent said 仍由 Orbit 从行里直接取，折叠在开头块下面，这就是附上的执行会话证据。

**A4（门）**：持有不改变谁能决定。`ownerConfirmationPrincipalRefusal` 与 `task_owner_decision` 的 CHECK 一个字不动，协调会话调确认门照旧得到 `OWNER_CONFIRMATION_REQUIRES_ACCOUNT_OWNER`。持有期间 `waiting` 为 null，任务面板会照常显示 Confirm done，并以 `requestId = null` 提交；`TaskOwnerConfirmationService.confirm` 在调 `ownerDecisionRefusal` 之前、任务行锁之下，读到最新请求处于持有状态且提交的 `requestId` 为 null 时，把 `answering` 换成这份请求的 id，后面的 `reviewOfDecision` 和写决定都用它（决定行写这份请求的 id，`review_state = 'UNDER_REVIEW'`）。否则 `ownerDecisionRefusal` 会判 STALE，owner 反而被一个看不见的请求挡住，违反 G2。`SEND_BACK` 不做这个替换。协调者之后才交的记录按 §9 处理。

`readOwnerConfirmation` 里读审查的 `reviewsOf` 今天失败时吞掉错误、把 `review` 读成 null。持有依赖这次读，吞掉就等于把持有的卡露出来，所以改成抛出，这次读失败，客户端重读。

**A5（退回）**：照 §8 不变，退回用 `task_confirmation_return`。owner 没被问过，不亮、不响，卡片也没出现过，所以只在执行会话里留一条 B6 的记录。B5 的上限（owner 两次决定之间最多 3 次）用完后，协调者必须呈上，把剩下的问题写进 needsYou 或 notChecked。

**A6（呈上时响一次）**：REVIEW 记录提交后，如果写入之前的状态是 `UNDER_REVIEW`（持有因这条记录结束）、任务没有结算、owner 还没决定，调 `PushService.notifyConfirmationRaised(recordId)`，APNs/FCM 和飞书各发一次，折叠键由记录 id 派生。标题是任务标题，正文只有 Orbit 的话：有要决定的点时写 `Coordinator raised this for your decision · <N> to decide`，没有时写 `Coordinator raised this for your confirmation`。卡片本身按 N2 计入 needs-you。不改角标口径（N6）。这是新增行为，见 §19 O2。

**A7（持有结束后才到的呈上）**：兜底卡片已经出现之后，协调会话仍可以交 REVIEW 记录（T1 第 3 行优先于第 4 行），卡片就地变成呈上的卡片，抬头不再带 `Not reviewed by the coordinator`。此时不再响（A6 要求写入之前的状态是 `UNDER_REVIEW`）。

---

## 14. 执行会话的提问（R）

**R1（什么算提问）**：`approval.tool_name = 'AskUserQuestion'`。各引擎的提问都已经归一成这个名字：Claude 自带的工具，Cursor 的 `cursor/ask_question`（`cursor_permissions.go`），OpenCode 的 `question`（`opencode.go`），Kimi 的问题型权限请求（`kimi_acp.go`）。Codex 和 DSH 目前没有提问工具，以后加的也要归一成这个名字。Orbit 工具里，执行会话能问人的只有 `session_send` / `project_send` 带 `expectReply`，目标本来就是另一个会话，不用改；`ask_owner` 只有协调会话能调。

下面这些**不是**提问，照旧走 §18 U1：`ExitPlanMode`（它批准的是把执行会话放到更宽的权限，属于权限边界）、任何工具权限审批、工作区写入卡、`orbit_task_create` 这类卡片。

**R2（哪些会话被持有）**：提问会话是任务的 run（`session.task_id` 非空），任务在项目里，项目 `coordinator_enabled = true`。解析协调会话用 `project.coordinator_session_id` 当下的值。下面任一情况不持有，直接按 §16 兜底：没有协调会话、协调会话已结束（`sessionHasEnded`）、协调会话暂停（`conversationIsPaused`：`createTurn` 总是写 `retryAt: null`，往排了重试的会话里写一轮会撤掉它的重试）、协调会话就是提问的会话本身、账号关了 Session orchestration（协调会话没有 `session_reply`）、项目在熔断暂停段里。

**R3（复用什么）**：两样现成的东西，加一个新种类，不造新通道：

| 需要 | 复用 | 差别 |
|---|---|---|
| 把问题交给协调会话 | 证据审查的平台轮次（`evidence-review:v1`，`docs/task-completion-criteria.md`）：空正文、`NEXT_TURN`、交出时渲染块 | 键是 `run-question:v1:<approvalId>`，块是 `<orbit-run-question>`（R5） |
| 等回答、记结局 | SRR 的 `session_request` 行与 `session_reply` | 行上多 `kind` 与 `approval_id`（R4），结局写到审批上，不写回信 turn（R6） |
| 把答案交给 run | 现有审批轮询（`awaitApprovalDecision`）与 `updatedInput.answers` | 不变；runner-go 的提问处理不用改 |

问题的载体仍是 `approval` 这一行，因为 run 正卡在一次工具调用里等它。回信 turn 叫不醒一个正在等工具结果的 run，这是不能直接用 `session_send(expectReply)` 的原因。

**R4（数据）**：一条迁移，号在落地时取：

```sql
ALTER TABLE "session_request"
  ADD COLUMN "kind" text NOT NULL DEFAULT 'MESSAGE',  -- MESSAGE | RUN_QUESTION | RUN_NOTIFY
  ADD COLUMN "approval_id" uuid,                      -- RUN_QUESTION only; no FK, like approval.turn_id
  ADD COLUMN "escalated_item_id" uuid,                -- the ask_owner item it was escalated to (R8)
  ADD COLUMN "owner_alerted_at" timestamptz(3);       -- when the fallback rang, once (R10, M6)
CREATE UNIQUE INDEX "session_request_approval_key" ON "session_request"("approval_id") WHERE "approval_id" IS NOT NULL;
-- session_request_state_chk (0350) is replaced to allow two more values, for the new kinds only:
--   OWNER_ANSWERED (the owner answered the approval, R7) and READ (§15 M4).

ALTER TABLE "approval" ADD COLUMN "coordinator_fallback" text;  -- R5: why this question was never held
```

`approval_decided_via_chk` 允许的取值加 `COORDINATOR`。

**R5（写下和投递）**：`createApproval` 里，R1、R2 都成立时，不再先写审批。改为一次 `createTurn(ownerId, coordinatorSessionId, { clientTurnId: 'run-question:v1:<approvalId>', content: '', intent: 'NEXT_TURN' }, { participateSendTransaction })`，`participateSendTransaction` 里插入审批行，`onTurnWritten(tx, turn)` 里插入 `session_request` 行（前者跑的时候轮次行还没有，而 `turn_id` 是 NOT NULL）。`session_request` 的 `kind = 'RUN_QUESTION'`，`from_session_id` 是 run，`to_session_id` 是协调会话，`reply_by = created_at + exceptionEscalationSeconds`，`request_preview` 取第一个问题的前 200 字，`options` 为 NULL（选项在审批的 `input` 里，按问题分开）。审批行 id 先生成，轮次键由它派生。同一个事务，所以读不到「审批有了、持有还没写」的中间状态，needs-you 不会亮一下。这个事务提交时不发 `approval_request` 帧，不调 `notifyApprovalRequest`。

`createTurn` 拒绝（协调会话刚好结束等），或 R2 判定不持有时：回退成今天的写法，只插审批行，并写 `approval.coordinator_fallback`（§16 F5 的 reason）。这条路径没有 `session_request` 行，标签就读这一列；发 `approval_request` 帧，走普通的 `notifyApprovalRequest`，都带标签。列为空的审批是修订 3 之前或不在这条路径上的审批，不带标签。

协调会话收到的块在交出时按行渲染，英文：

```
<orbit-run-question task="<task publicId>" run-session="<publicId>" request-id="<id>" reply-by="…" from-mode="default">
A run of the task “<title>” asked a question meant for a person and is blocked until it is answered.
The account owner has not been asked.

Question 1 (one of): <question text>
  0. <label>: <description>
  1. <label>: <description>
Question 2 (any of): …

Answer with session_reply(requestId="<id>", answers=[{question: 0, option: 1}, …]); use text instead of
option for your own words. If the decision is the owner's, call ask_owner with your recommendation and
forRunQuestion="<id>", then answer here once they have told you. If you do neither by reply-by, or stop
without answering, Orbit asks the owner directly and says you did not review it.
</orbit-run-question>
```

交出时请求已结案，块只说明是哪一种情况，再加一句 `Nothing to answer; end your turn.`（同 D6）。

`from-mode` 与 SRR §2.2 同一段代码（`readBlockSender`），执行会话比协调会话窄时加同一句话。回显入库时挂结构化读数 `runQuestion`，三端在协调会话里画成只读卡片（同 D7）。这一轮是平台投递：不写 `sender_session_id`，不计 SRR §2.4 的上限，接进 `isPlatformContentTurn`、`queuedWakeContent`、auto-retry 回溯和 `RESERVED_TURN_KEY_PREFIXES`（G6）。

**R6（回答）**：`session_reply` 加一个可选参数，其余规则（只有接收方能回答、已结案 409 `REQUEST_CLOSED`）不变：

```
session_reply({ requestId, message?, option?, answers? })
answers: [{ question: number, option?: number, options?: number[], text?: string }]
```

- `answers` 只用于 `RUN_QUESTION`，其他种类给了就 400。
- 每个问题恰好一条。`option`、`options`（多选题用）、`text` 三选一。问题只有一个时，也可以照旧用 `option` 或 `message`。
- 回答走新方法 `answerRunQuestion`，不走 `SessionRequestService.reply`（后者不在一个事务里，还会交回信）。一个事务做两件事：把 `session_request` 从 `OPEN` 改成 `REPLIED`，`reply_text` 存渲染好的文字（`session_request_replied_chk` 要求），`reply_option` 留空（`options` 为 NULL，`session_request_reply_option_chk` 不允许有值），`closed_at` 同时写；把审批从 `PENDING` 改成 `ALLOWED`，并写 `answers`（问题文字 → 选中的 label 或原话，形状不变）、`decided_credential_kind = 'COORDINATOR'`、`decided_by_id` 留空。
- 请求还 `OPEN` 但审批已不是 `PENDING` 时，按 R7、R11 结案，提交这次结案，再答 409 `REQUEST_CLOSED`。
- 不写 `session-reply:` 回信 turn。发 `approval_resolved` 帧，run 的轮询就此拿到答案。
- CLI 是 `orbit session reply <id> --answers-json <文件|->`。`mcp.go` 现在要求 `message` 或 `option` 至少一个，要放行只给 `answers` 的调用。
- `decided_by_id` 留空，所以 `wiki.service.ts` 不会把协调者的回答当成 owner 的原话。

**R7（owner 直接回答）**：持有期间问题不显示，但 `decideApproval` 这个门不关，也不用改。审批被 owner 决定之后，请求由 R11 的那一轮结案成 `OWNER_ANSWERED`，协调者之后的回答得到 `REQUEST_CLOSED`。

**R8（协调者答不了）**：`ask_owner` 加一个可选参数 `forRunQuestion: <requestId>`，协调者带着自己的推荐项把问题提给 owner，走现有的问题卡。`ProjectOpenItemService.askOwner` 在建待办的事务里校验：这个请求是发给调用方的、`kind = 'RUN_QUESTION'`、还是 `OPEN`，否则 409 `RUN_QUESTION_NOT_OPEN`；通过后写 `session_request.escalated_item_id = 待办 id`，`reply_by = now + 30 天`（SRR 的上限），表示事情已经在 owner 面前，不再计时。owner 回答时，`answerOpenItem` 在同一事务里把 `escalated_item_id` 指向它的请求的 `reply_by` 改成 `answered_at + exceptionEscalationSeconds`。协调者收到回答后用 `session_reply` 转给 run。答案要协调者转一手，是因为 run 的问题可能有多条，owner 回答的是协调者重新提炼过的问题，平台对不上。这段时间 run 一直卡着，协调者有未关闭的 `ask_owner`（SRR §4.1 第 5 条），不会判 `NO_REPLY`。

**R9（持有期间的显示）**：问题的持有判定（§16 F2）在这些地方排除持有的审批：`PushService.needsYouSessions`、会话行的 `pendingApprovals`、工作区计数、`listApprovals`、飞书审批卡，以及 `claimApprovalAlert` 的 NOT EXISTS 和飞书的审批串（否则一条持有中的问题会让同一会话后来的工具审批不响，违反 U1）。会话行加一个字段，取值约定与 N3 相同（`null` 表示清掉）：

```ts
/** The questions this run has with its coordinator: the row and the run's page say so, nothing counts them. */
questionWithCoordinator?: { count: number; since: string; dueAt: string } | null;
```

执行会话页在问题的位置画一行只读提示 `Asking the coordinator · since <HH:MM>`，没有按钮，客户端按 N5 的规则在 `dueAt` 后重读。答完之后，转录里的问题记录写 `Answered by the coordinator`：`toApprovalInfo` 加 `answeredBy: 'COORDINATOR' | null`，由 `decided_credential_kind` 算出。

**R10（兜底时响一次）**：问题的结局由现有路径写下：`NO_REPLY`（协调会话的 `turnComplete`）、`RECIPIENT_ENDED`（0350 触发器）、`UNDELIVERED`、`EXPIRED`（现有 `SessionRequestWorker`，5 秒一轮）。读的一侧不等这些写入：到了 `reply_by` 就按兜底显示（§16 F2）。**响铃**放在现有 worker 的那一轮里，加一个查询，不加新的定时器：`kind = 'RUN_QUESTION'`、结局不是 `REPLIED`/`OWNER_ANSWERED`、审批仍是 `PENDING`、`owner_alerted_at` 为空的行，发 `approval_request` 帧，发推送（正文前面加 `Not reviewed by the coordinator · `，飞书卡加同样的标签），写 `owner_alerted_at`。这里**不走** `claimApprovalAlert`：持有期间同一会话的工具审批可能已经响过，这条迟到的问题会被它判成不是新的一段；只响一次由 `owner_alerted_at` 的条件更新保证，多副本也一样。Automatic 被 owner 关掉时持有立刻读作兜底，但没有结局可写，不响：是 owner 自己的动作，他在 app 里。

**R11（run 不等了）**：审批被收成 `ABANDONED` 的路有四条（`abandoned-approvals.ts` 的 `reapApprovalsOfEndedTurns`、`reapApprovalsOfReturnedCalls`、`reapApprovalsOfReturnedCallsIn`、`reapApprovalsOfReplacedSupervisor`），不逐条改。持有判定只认 `PENDING` 的审批，所以读的一侧立刻正确；结案放在现有 worker 的同一轮：`kind = 'RUN_QUESTION'`、`state = 'OPEN'`、审批已不是 `PENDING` 的行，审批是 `decided_by_id` 非空就写 `OWNER_ANSWERED`，否则写 `UNDELIVERED`（`close_reason = 'QUESTION_ABANDONED'`）。worker 的响铃查询要求审批仍是 `PENDING`，所以不响。

**R12（SRR 的其余规则怎么对待新种类）**：

| SRR 规则 | `RUN_QUESTION` / `RUN_NOTIFY` |
|---|---|
| §2.4 每对 5 分钟 60 条、§3.1 50 个 OPEN 上限 | 不计，这不是会话发起的 |
| §2.5 谁能给谁发 | 不问，这是平台投递。块里带 `from-mode`（R5） |
| §4.1 第 4 条（自己发出的请求算唤醒源） | 不算。run 本来就卡在工具调用里；`notify` 不等回答 |
| §4.2 回信 turn | 不写 |
| §4.3 发送方已结束时写任务评论 | 不写 |
| §6 客户端回复关系 | `readOpenRequestPeers` 不读这两种，会话行不显示 owes reply |
| 代码里要加 `kind = 'MESSAGE'` 过滤的地方 | `session-request.worker.ts` 的交回查询（放在查询里，放进 `handOff` 会占满每轮 25 行的额度）；`hasPendingWakeSource` 的 `asked` 与 `onItsWay`；`chargeOpenRequest` 的计数 |

协调会话这一侧的 `NO_REPLY`（§4.1）和 `RECIPIENT_ENDED` 判定照旧，只是结局的去处换成 §16。

**R 的卡片（2026-11-11，owner 认可 `docs/mocks/orbit-turn-cards/`）**：`run-question:v1:` 轮次的回显和排队行带 `runQuestion`（`RunQuestionCard`：问题与选项、`replyBy`、请求与审批状态，以及答过之后的 `answers`（按问题原文）和 `answeredBy`：`SESSION` 是协调会话经 `session_reply` 答的，`OWNER` 是 owner 答的）。客户端画成 `Question from a task run` 卡片：任务标题、问题与选项（只读，卡片上不放作答按钮）、一句状态（`The run is waiting. This session answers it; if it hasn't by <时间>, you're asked.` / `Passed to you at <时间>.` / `Answered by this session.` / `Answered by you.` / `Closed without an answer.`）、`Open task session`，给 agent 的原文收在 `What the coordinator was told` 折叠里。

---

## 15. 执行会话的 notify（M）

**M1（决定：投递给协调者，不拒绝）**：Automatic 项目里，任务的 run 调 `notify`，交给项目的协调会话，不响 owner 的设备。理由：

1. `notify` 的用途是「我需要人来做点什么」或者「他在等的事做完了」。拒绝等于把这句话丢回给模型，指望它换一个工具再说一遍；Session orchestration 关着时，run 连 `project_send` 都没有，这句话就只留在转录里，没有人会看到。
2. 项目目标写的是「执行会话要放到 owner 面前的东西，先给协调者」。投递正好做到这一点：协调者能结合项目状态判断，要不要用 `ask_owner` 带着判断告诉 owner。
3. 成本有界：现有的每会话每分钟一次限制照旧（M3）。
4. 对 run 来说语义清楚：结果说明谁收到了（M5），它不会以为 owner 看到了。

**M2（路径）**：`RunnerNotifyController` 不变，判断放在 `PushService.notifyAgentMessage` 之前的一层，`input.sessionId` 对应的会话是 Automatic 项目的 run 时进入这一节。协调会话可达（有、没结束、没暂停、不是调用者自己、项目不在熔断里）就走投递，否则按 M6 兜底。R2 的 orchestration 条件不适用：`notify` 不需要协调者有 `session_reply`。没有 `sessionId` 的 headless `orbit notify`、非 run 的会话不变。协调会话自己的 `notify` 不变：它就是把事情带给 owner 的那一方。

**M3（投递）**：先走一次 `claimAgentNotify` 的每分钟限制，这条规则不变，投递和 M6 的兜底都不再 claim 第二次。然后 `createTurn(ownerId, coordinatorSessionId, { clientTurnId: 'run-notify:v1:<requestId>', content: '', intent: 'NEXT_TURN' }, { onTurnWritten })`，`onTurnWritten` 里插 `session_request` 行：`kind = 'RUN_NOTIFY'`，`request_preview` 取消息前 200 字（兜底推送就用这一段，与锁屏截断的长度相同），`options` 为 NULL，`reply_by = now + exceptionEscalationSeconds`。账号的 `notifyAgentMessage` 偏好不适用，它管的是 owner 的设备。接线（平台轮次、块、保留前缀、`from-mode`）与 R5 相同。协调会话收到：

```
<orbit-run-notice task="<task publicId>" run-session="<publicId>" from-mode="default">
A run of the task “<title>” used notify. It did not reach the account owner.
Message: <message>
Nothing is waiting for your reply. If the owner should know or decide, use ask_owner with your recommendation.
</orbit-run-notice>
```

**M4（结案）**：这一轮交给 engine 的时候（`conversation_turn.delivered_at` 写下），`session_request` 在同一事务里改成 `READ`，写 `closed_at`。协调者读到了就算接住了，后面是否告诉 owner 由它判断，不再计时。

**M5（结果）**：工具结果加 `recipient`：

```jsonc
{ "delivered": true, "recipient": "coordinator", "recipientSessionId": "…", "placement": "queued" }   // 投递给协调者
{ "delivered": true, "recipient": "owner", "fallback": "NO_COORDINATOR", "devices": 2 }               // 兜底
{ "delivered": false, "reason": "rate limited — try again in 41s" }                                   // 与今天相同
```

**M 的卡片（2026-11-11，同上效果图）**：`run-notify:v1:` 轮次的回显和排队行带 `runNotice`（`RunNoticeCard`：任务、`request_preview` 原话、请求状态；交出时状态由 OPEN 变 READ）。客户端画成灰色 `Notice from a task run` 卡片：任务标题、加引号的原话、`Nothing to reply to. It did not reach you.`，原文收在 `What the coordinator was told` 折叠里。

**M6（兜底）**：§16 列出的情况发生时：
- 调用那一刻就不可达（没有协调会话、已结束、暂停、熔断、`createTurn` 拒绝）：走今天的 `notifyAgentMessage` 的发送部分（M3 已经 claim 过），正文前面加 `Not reviewed by the coordinator · `，结果带 `fallback`。
- 投递之后、engine 读到之前，轮次被收掉（`UNDELIVERED`）或协调会话结束（`RECIPIENT_ENDED`）或到了 `reply_by`（`EXPIRED`）：R10 的现有 worker 那一轮发一次，同样带标签，正文用 `request_preview`，写 `owner_alerted_at`，不受每分钟限制（这条已经被限制过一次）。此时 run 早已收到 `delivered: true, recipient: coordinator`，这次兜底只影响 owner。

---

## 16. 三条路径的兜底（F）

**F1（一处定义）**：新模块 `projects/run-item-hold.ts`，一个纯函数，三条路径都用它，读法照 `coordinatorHolds`：

```ts
export type RunItemHold =
  | { place: 'ANSWERED' }   // raised, sent back, replied or read: not a hold and not a fallback
  | { place: 'HELD'; coordinatorSessionId: string; dueAt: Date }
  | { place: 'FALLBACK'; reason: OwnerConfirmationNotReviewedReason };

/** Pure over the facts already on the rows, so the card, the counts, the push and the tool doors cannot disagree. */
export function runItemHold(facts: RunItemFacts, readAt: Date): RunItemHold;
```

`RunItemFacts`：Automatic 是否开着（按事项产生时的项目）；协调会话（无 / 已结束 / 暂停 / 活着）；投递状态（未写下、已写下未读、已读、被拒及其码）；事项的结局（仅 `session_request`）；到期时刻。不加 `setInterval`、worker、sweep，不写「已兜底」字段。R10 和 M6 只在现有 `SessionRequestWorker` 里多一个查询，确认卡的兜底不需要任何写入。

**F2（判定表，从上往下，先命中先得）**：

| # | 条件 | 确认请求 | 提问 | notify |
|---|---|---|---|---|
| 1 | 协调者答过 | `ANSWERED`：有 REVIEW 或 RETURN 记录，后面几行都不看（T1 第 1–3 行） | `ANSWERED`：`REPLIED` | `ANSWERED`：`READ` |
| 2 | Automatic 被关掉（读的时刻） | 兜底 `AUTOMATIC_OFF` | 同左 | 不判：投递后不再看开关 |
| 3 | 没有协调会话 | 兜底 `NO_COORDINATOR`（D1 写 `REFUSED`） | 不持有，`approval.coordinator_fallback = NO_COORDINATOR` | 调用时兜底 |
| 4 | 协调会话已结束 | 兜底 `REVIEWER_ENDED`（`conversationIsOver`，或会话行已删；不读 `reviewer_ended_at`） | 兜底 `REVIEWER_ENDED`（SRR `RECIPIENT_ENDED`） | 调用时兜底；投递后未读时由结局兜底 |
| 5 | 投递被拒 | 兜底，按 T2 映射 | 不持有，`coordinator_fallback` 写当时的原因，读不出原因时写 `UNREACHABLE` | 调用时兜底 |
| 6 | 协调者读过、停下、没有唤醒源 | 兜底 `REVIEWER_STOPPED`（T5） | 兜底 `REVIEWER_STOPPED`（SRR `NO_REPLY`） | 不适用：读到即结案 |
| 7 | 投递轮次没被读到就被收掉 | 协调会话暂停：这一行不算，往下看第 8 行，回来后重投（D5）；否则兜底 `REVIEWER_STOPPED` | 兜底 `REVIEWER_STOPPED`（SRR `UNDELIVERED`） | 同左 |
| 8 | 到期（`now >= 到期时刻`） | 兜底 `TIMED_OUT` | 同左 | 同左 |
| 9 | 其余 | 持有 | 持有 | 持有 |

`kind` 和项目条件不满足（非 Automatic、不在项目里）时根本不进这张表（§18）。

**F3（协调会话暂停时）**：协调会话因额度、429、登录失效等失败而停下、还没结束（`conversationIsPaused`）时：

- **确认请求**继续持有，不算结束，不写 `REFUSED`（D2），也不因为投递轮次被收掉而兜底（F2 第 7 行）。这是 owner 2026-11-08 对证据和例外待办定的规则（`docs/evidence-waits-for-coordinator-design.md`），唯一的不同是 F4：等待有上限。`PROJECT_COORDINATOR` 因此不读 `reviewer_ended_at`（§3.1 的触发器照 0350，失败且没有重试就会写它），只读 `conversationIsOver`。
- **提问和 notify** 不等：提问时协调会话已暂停就不持有（R2），持有之后协调会话失败且没有重试时 SRR 判 `RECIPIENT_ENDED`，同样兜底。提问是因为 run 正卡着占着 runner 名额，宁可早点问 owner（§19 O5）；notify 是因为 run 不等，owner 应该及时知道。

**F4（时钟）**：到期时刻 = 事项产生时刻 + 项目的 `exceptionEscalationSeconds`，在事项产生时冻结（确认请求沿用 N4 的 `due_at`）。与 `coordinatorHolds` 不同，这里不从协调者取走时起算：项目的不变量是「Nothing waits forever」，从取走时起算的话，协调会话一直不可用就会一直等。见 §19 O1。

**F5（标签）**：所有兜底事项都写 `Not reviewed by the coordinator`，下一行写原因，全部是 Orbit 的话：

| `reason` | 句子 |
|---|---|
| `TIMED_OUT` | `No answer within <窗口>.` |
| `REVIEWER_ENDED` | `The coordinator’s session ended before it answered.` |
| `REVIEWER_STOPPED` | `The coordinator stopped without answering.` |
| `COORDINATOR_PAUSED` | `This project’s coordinator is paused.` |
| `AUTOMATIC_OFF` | `Automatic was switched off for this project.` |
| `NO_COORDINATOR` | `This project has no coordinator conversation.` |
| `UNREACHABLE` | `The coordinator could not be reached.` |

三种事项的画法：确认卡的审查栏（H3，后接 ` Only the agent that did the work has checked this.`）；问题卡（审批卡顶部一行标签 + 原因）；notify（推送正文和飞书卡的前缀，只带标签，不带原因，锁屏放不下）。

**F6（不丢、不重）**：持有判定只读行，事项本身一直在（请求行、审批行、会话转录），所以进程重启不影响。owner 不会被同一件事响两次：`A6` 只在第一条 REVIEW 响，R10/M6 靠 `owner_alerted_at`。协调者答完的事项不再兜底，状态写在同一个事务里。

---

## 17. 简报与工具描述（W）

**W1（`task-execution-prompt.ts`）**：`buildTaskExecutionPrompt` 的 `project` 入参加 `coordinatorEnabled?: boolean`，`TASK_DELIVERY_SELECT` 同步选这一列。`coordinatorEnabled !== true` 时一个字节都不变。为 true 时做两处改动：

1. 紧接交付句之后（「Follow these steps」之前，这个标题是 `wiki-dossier.ts` 的切分点，不能动）加一段，所有 Automatic 项目的 run 都有：

   > This project is Automatic: its coordinator is your channel to the account owner. A question you ask (AskUserQuestion) is answered by the coordinator, and notify reaches the coordinator, not the owner's devices. Tool permission prompts still go to the owner.

2. OWNER_CONFIRMED 的第 3 步，把「Only that declaration puts a confirmation card in front of the account owner…」到「…and declare again once you are done again.」整段换成：

   > Your declaration goes to this project's coordinator first: the account owner sees nothing until the coordinator raises it, and if the coordinator does not answer in time Orbit asks the owner directly. It reaches the coordinator only when the turn in which this run has really stopped ends (an empty queue, no background job in flight, no wake you scheduled yourself). The coordinator may send it back to you; the reason arrives in this session as the next message. This task's completion criterion is OWNER_CONFIRMED: only the account owner confirms it in the Orbit app, and no agent session (the coordinator included) can confirm it for them; if the owner sends it back, the reason arrives the same way. When it does, carry on as it says, and declare again once you are done again.

   后面的「Do not call task_evidence_submit, and do not write status.」不变。

要跟着动的钉子：`task-list-instructions.spec.ts` 的字节比对；`task-start-card.ts` 重建简报用的 select（要同样带 `coordinatorEnabled`）。Automatic 开关在 run 开始之后被翻动时，重建结果和当时发出的不一样，卡片退化成普通气泡，这与部署前派发的简报是同一种已知退化，不处理。

**W2（协调会话的开场）**：`projects/coordinator-opening.ts` 的说明加两句：收到 `<orbit-confirmation-review>` 要么 `task_confirmation_review` 呈上，要么 `task_confirmation_return` 退回；收到 `<orbit-run-question>` 用 `session_reply` 回答，只有 owner 能定的事用 `ask_owner` 带 `forRunQuestion` 和推荐项。

**W3（runner-go 工具描述）**，每条都由 `cli_mcp_parity_test` 和描述测试钉住：

| 工具 | 改动 |
|---|---|
| `notify`（`mcp.go`，以及 `notify_cli.go` 的 help 与 capability） | 句首加：`In a task run of an Automatic project this goes to the project's coordinator, not to the owner's devices.`；结果说明加：`Read recipient in the result to see who got it: coordinator, or owner when Orbit fell back.` |
| `task_request_confirmation` | 末句换成：`In an Automatic project the request goes to the coordinator first and the owner sees nothing until it raises it, or until Orbit falls back to the owner. Outside a project, if the task has a reviewer, Orbit asks it first and the owner's card waits until the review is in.` |
| `task_confirmation_review` | 加：`In an Automatic project this raises the request: your judgment leads the owner's card, then needsYou.` |
| `session_reply` | 加 `answers` 参数及说明（R6） |
| `ask_owner` | 加 `forRunQuestion` 参数及说明（R8） |

`AskUserQuestion` 是引擎自带的工具，描述改不了，靠 W1 的简报说明。

---

## 18. 不变的情况（U）

**U1（工具权限审批）**：`AskUserQuestion` 之外的审批，一行都不改：`notifyApprovalRequest`、`needsYouSessions`、会话行计数、飞书审批卡照旧直达 owner，同一个会话里的问题被持有时也一样。这是安全边界，一个 agent 不能给另一个 agent 授权。`ExitPlanMode` 归这一类。

**U2（Automatic 关着的项目）**：没有审查行（S2），确认卡、提问、`notify` 与今天相同。`runItemHold` 不进入。

**U3（不在项目里的任务）**：确认请求的审查按 §1–§9 不变：卡片照常显示，`TASK_CREATOR` 审查，不隐藏。提问、`notify` 与今天相同。

**U4（协调会话自己和非 run 的会话）**：协调会话的提问、`notify`、`ask_owner` 照旧到 owner，它就是负责带话的一方。`session.task_id` 为空的自由会话不变。

**U5（只有 owner 能做的事）**：确认 OWNER_CONFIRMED 任务、改验收标准、记录项目完成，都没有变（G1）。

---

## 19. 实现切分与待 owner 定的问题

### 19.1 切分

本项目的任务按下表做，每个任务在 spec 和评论里引用条款号。F 先做，I1/I2/I3 依赖 F，C 依赖三者的读面，W 最后。

| 任务 | 内容 | 条款 |
|---|---|---|
| **F** | `projects/run-item-hold.ts` 与表驱动 spec；R4 的迁移（`session_request` 四列、状态 CHECK、`approval.coordinator_fallback`、`approval_decided_via_chk`）；`SessionRequestWorker` 的兜底响铃与结案查询、交回查询的 `kind` 过滤 | F1–F6，R4，R10、R11、R12（worker 部分），M6（worker 部分） |
| **I1** | `resolveReviewer` 改序（S2）；`PROJECT_COORDINATOR` 的 `confirmationReviewStates` 改读 `runItemHold`；暂停时 `deliver` 留在 `PENDING`，D5 重投；`readOwnerConfirmation` 持有时 `waiting = null`；开头块读面 `lead`；确认门 A4；`notifyConfirmationRaised` | S2、S4、S5、S6，D2、D4、D5、D6，T1 末段、T2，N1、N3、N6，H1、H2、H3，G1、G2，A1–A7 |
| **I2** | `createApproval` 的持有分支；`run-question:v1` 轮次及块；`answerRunQuestion`；`ask_owner` 的 `forRunQuestion`；needs-you / 列表 / 计数 / 飞书 / `claimApprovalAlert` 排除持有的问题；`questionWithCoordinator`；runner-go `session_reply`、`ask_owner` 及 CLI | R1–R3，R5–R9，R12（请求侧），W3 第 4、5 行 |
| **I3** | `notify` 路由与 `run-notify:v1` 轮次；`recipient` 结果；runner-go `notify` 描述与 CLI | M1–M6，W3 第 1 行 |
| **C** | web、OrbitKit（iOS/macOS）、Android：开头块、兜底标签、`Under review` 与 `Coordinator` 署名、`Asking the coordinator`、`Answered by the coordinator`、`runQuestion` 只读卡片；对照 `docs/mocks/coordinator-raised-confirmation/` | H1、H3，S5（画法），A3，F5，R5（卡片），R9，§12 新增文案 |
| **W** | 简报、协调会话开场、其余工具描述；修订 ILC §0.3（G6 的五个前缀）与 `docs/completion-input-routing.md` 的相关段落；`docs/task-completion-criteria.md`；全量套件 | W1、W2、W3 第 2、3 行，G6，U1–U5 的回归 |

要一并更新的旧钉子（开工前按 grep 为准）：`owner-confirmation-review.pg.spec.ts` 里「审查期间关 Automatic，审查照常走完」的用例（F2 第 2 行改了它）；`task-owner-confirmation.pg.spec.ts` 夹具的「没有 `creatorSessionId` 就没有审查方」（S2 在 Automatic 项目里改了它）；`task-list-instructions.spec.ts`（W1）。

### 19.2 待 owner 定的问题

下面每条都已经按「推荐」写进了上面的规则。不同意哪一条，在确认卡上用 Send back 写明。

| # | 问题 | 推荐 | 另一种做法 |
|---|---|---|---|
| **O1** | 持有的时钟从什么时候起算？ | 从事项产生时起算，到点兜底（F4）。项目的不变量是「Nothing waits forever」。代价：协调会话长时间忙时，事项可能在它读到之前就交给了你 | 照 11-08 对证据的规则，从协调者取走时起算，协调者不可用时不设上限。代价：协调者一直不可用时，run 的问题会一直卡着 |
| **O2** | 协调者呈上时要响手机吗？ | 响一次（A6）。这是你要看的事，呈上已经过滤过了。兜底的确认卡不响（N6，和今天一样），问题和 notify 的兜底响 | 都不响，卡片只出现在 needs-you 里，和今天的确认卡一样 |
| **O3** | 呈上的卡片画在哪里？ | 画在任务自己的会话里（和今天相同），needs-you 指向那里（A2、§13）。上下文、报告、改动都在这一页，实现最小 | 画在协调会话里，和 owner item 放一起。三端都要新做一个列表读面，回执的位置也要重定 |
| **O4** | 卡片开头是结论加「一个点」，还是「所有点」？ | 结论 + 全部要决定的点，第一条最靠前（A3）。项目目标写的是 one point，任务说明写的是 points；有几条问题就要几条答案，只露一条会重演 2026-09-29 一次确认吞掉 7 个决定的事 | 只露第一条，其余折叠在 `+N more` 里 |
| **O5** | 协调会话因额度等原因暂停时，run 的问题怎么办？ | 问题立即兜底给你（F3），因为 run 卡着占着名额；确认请求继续持有到窗口 | 问题也持有到窗口，和确认请求一致 |
| **O6** | 任务 run 结束时的「Finished / Failed」推送（`notifySessionSettled`）要不要也归协调者？ | 这次不动：它是平台事实，不是 run 主动说的话，也不在项目列的三条路里。要改另开任务 | 在 Automatic 项目里也静音 |
| **O7** | run 派生的子会话（`parent_session_id` 非空、`task_id` 为空）提问怎么办？ | 这次不动，按 U4 仍到 owner。先看实际有多少，再决定 | 沿派生树找到 run，同样持有 |

---

## 附录 A　本文替 owner 做的决定（可以推翻）

下面每一条都已写成具体规则。owner 不同意哪一条，在确认卡上用 Send back 写明，改完再确认。

1. **Automatic 关着的项目没有审查方**（S2），与证据投给协调者只在 Automatic 开着时投递是同一条线。另一种做法是照样由协调会话审。审查期间关掉 Automatic，持有立即结束，卡片按兜底显示（§16 F2）；协调者仍可补交记录，但不能再退回（§3.5 末段、B5）。
2. **不在项目里、又没有派活会话的任务没有审查方**：owner 在 app 里建的任务都属于这一种，不带会话建的任务也是（S2）。判据是 `creator_session_id` 为空，不看 `creator_type`。Automatic 项目里，这样的任务也由协调会话持有（修订 3）。
3. **审查方读过、空闲下来、又没有唤醒源，就提前结束审查**（T5）。项目里的窗口默认两小时，不提前结束的话，忘了调工具的审查会让卡片白等两小时。
4. **「未经审查」只进不退**（T1、§3.1 的触发器）：审查方结束后又被叫醒，卡片也不会回到「审查中」。
5. **投递被拒即终局**，不重投，也不改投给后来的协调会话（D4）。
6. **有 needsYou 时，认识审查的客户端要逐条作答；旧客户端照样受理**，代记推荐项并标明 owner 没看到（Q3）。另一种做法是拒绝旧客户端，但那样一个 agent 的审查就能挡住 owner 确认。
7. **答案写成任务评论（与决定同一个事务），并提醒审查方**（Q5）。
8. **退回由 Orbit 转交，不是会话间消息**（B3）：署名来自审查行，不依赖 Session orchestration 开关。边界：每份请求一次；owner 两次决定之间最多 3 次；Automatic 关着或在暂停期间不能退回（B5）。
9. **owner 确认之后发现的问题会推送**，正文只有 Orbit 的话；只是后到的 REVIEW 不推送（L5）。
10. **窗口在请求那一刻冻结**，并且从请求时起算，不从投递时起算（N4）。
11. **效果图说明里写的 expectReply 改为平台投递**（§2.1）。
12. **呈上不加新表、新工具**：REVIEW 记录已经带着结论和要决定的点（A3）。
13. **owner 在持有期间仍可以从任务面板确认**（A4）。
14. **`notify` 投递给协调者，不拒绝**（M1）。
15. **持有的问题不显示卡片，但 `decideApproval` 的门不关**（R7）。
16. §19.2 O1–O7 的推荐项。

## 附录 B　修订记录

| 版本 | 日期 | 内容 |
|---|---|---|
| 初稿 | 2026-10-02 | 按任务 `34Z35urx0kEB2qZaLeikc` 的 1–11 条写成 |
| 初稿修订 | 2026-10-02 | 送 owner 前，对照代码独立审读一遍后改了这些：<br>- 审查方按 `creator_session_id` 判，不按 `creator_type`；<br>- `requestId` 沿用原始 UUID；<br>- 旧客户端不因审查被拒（`NOT_SHOWN`）；<br>- 「未经审查」只进不退（触发器、排空的判定）；<br>- 审查期间关 Automatic 不打断审查；<br>- 退回改由 Orbit 转交，并按记录 id 派生轮次键；<br>- 空正文平台轮次接进队列显示与 auto-retry；<br>- 任务行的 Under review；<br>- 读面类型写全；<br>- 答案评论与决定同一个事务；<br>- 工具门把重试放在顶替之前；<br>- `branch_sha` 的三处上报与看不到的边界；<br>- 审查方本身是执行会话时的顺序 |
| 修订 2 | 2026-11-04 | 所有者 2026-11-03 决定：确认退回按 SRR §2.5 判。<br>- B2、B8 加第 14 条，排在表里其他每一行之后，第 4 条的重试和第 8 条的 PROBLEMS 不问；<br>- B3 的块加 `from-session`、`from-mode`，审查方更窄时加 SRR §2.2 那句话；<br>- §2.1、G7 相应改；<br>- 被拒的审查方用 `task_confirmation_review`，那个门不变 |
| 修订 3 | 2026-11-10 | 任务 `34ugU32krhXotXkNdcR90`：Automatic 项目从「卡片立刻显示、多一栏审查」改为「先持有、再呈上」。<br>- §0.1、G2、S2（项目分支先于 `creator_session_id`）、S4、S5、S6、D2、D5、D6、T1 末段、T2、N1、N6、H1–H3、G5、G8、§12 相应改；<br>- 新增 §13 持有与呈上（A）、§14 提问（R）、§15 notify（M）、§16 兜底（F）、§17 简报与工具描述（W）、§18 不变的情况（U）、§19 切分与待定问题（O）；<br>- 效果图 `docs/mocks/coordinator-raised-confirmation/`；<br>- 实现按 §19.1 拆给任务 F、I1、I2、I3、C、W |
| 修订 3 审读 | 2026-11-10 | 送 owner 前，对照代码独立审读一遍后改了这些：<br>- R5 的 `session_request` 行改在 `onTurnWritten` 写（`turn_id` NOT NULL），R4 补状态 CHECK 与 `reply_text`；<br>- 回答走 `answerRunQuestion`，不走 `reply`；worker、`hasPendingWakeSource`、`chargeOpenRequest` 按 `kind` 过滤；<br>- 暂停的协调会话不持有问题（`createTurn` 会撤掉重试）；<br>- 兜底响铃绕过 `claimApprovalAlert`，后者排除持有的问题；<br>- F2 把「已答」提到第一行、加 `ANSWERED`，暂停不再越过到期；<br>- `PROJECT_COORDINATOR` 不读 `reviewer_ended_at`；D5 重投用条件更新改指新轮次；<br>- 不持有的问题把原因存在 `approval.coordinator_fallback`；<br>- notify 只 claim 一次；<br>- R8 用 `escalated_item_id` 连到待办，`answerOpenItem` 改 `reply_by`；<br>- R11 不改四个 reaper，由 worker 结案；<br>- A6 与 A7 的条件、W1 的替换范围、G6 的前缀、切分归属 |
| 实现修订 1 | 2026-10-03 | 服务端实现（任务 `34Z35uusJWkeA99O23btE`）落下的细节，规则本身不变：<br>- 迁移号取 `0370_owner_confirmation_review`（写的时候是 0365；落地前 main 先后用了 0365、0366、0369、0367，0368 又被项目「项目收尾重做」的 `0368_open_item_coordinator_handling` 先占了，所以改成 0370）；外键照 0267 带 `ON UPDATE CASCADE`（Prisma 的默认），§3.1 的 DDL 没写这一句；<br>- CLI 的输入写作 `orbit task confirmation-review [task-id] (--input JSON \| --input-file -) [--json]`（`confirmation-return` 同），不是 `--json <文件\|->`：每条 CLI 命令的 `--json` 都是「输出紧凑 JSON」，不能在这两条上改作输入；`[task-id]` 可代替输入里的 `taskId`，两者都给时必须一致，不取 `ORBIT_TASK_ID`；<br>- §3.5 第 7 条与 Q3 的 400 不带新码，只有说明哪个字段错了的 message，与确认门对自身畸形请求体的回答一样；<br>- 本文没指定的 requiredAction 取值：`CALL_FROM_THE_REVIEWER_SESSION`（`CONFIRMATION_REVIEW_REQUIRES_SESSION`）、`LEAVE_IT_TO_ITS_REVIEWER`（`…_NOT_THE_REVIEWER`）、`CALL_FROM_INSIDE_A_TURN`（`…_OUTSIDE_TURN`）、`REVIEW_THE_NEWEST_REQUEST`（`…_SUPERSEDED`，另带 `latestRequestId`）、`END_YOUR_TURN`（`…_ALREADY_RECORDED`）、`USE_SESSION_SEND_TO_ADD_TO_IT`（`CONFIRMATION_RETURN_ALREADY_SENT_BACK`）、`REOPEN_THE_TASK_FIRST`（`CONFIRMATION_RETURN_TASK_SETTLED`）；`COORDINATOR_DISABLED` 与 `PROJECT_FUSE_PAUSED` 用 `RECORD_A_REVIEW_FOR_THE_OWNER`；`OWNER_CONFIRMATION_ANSWERS_REQUIRED` 另带 `missingKeys`；<br>- B8 第 11 条也覆盖 `createTurn` 自己因执行会话已结束或在 Trash 而拒绝的情况，同样答 409 `CONFIRMATION_RETURN_RUN_ENDED`；<br>- D2 的「auto-retry 重发它自己」：失败的审查轮次与退回轮次由 sweep 以 `owner-confirmation-review:v1:<reviewId>:retry:<uuid>`、`confirmation-return:v1:<recordId>:retry:<uuid>` 重发，正文仍为空，交出时照行重新渲染；审查行的 `delivery_turn_client_id` 仍指原轮次（它已被读到，T1 不因此判「未经审查」）；<br>- Q5 第 2 条的提醒轮次正文写成 `<orbit-confirmation-answers task=\"…\">` 块；<br>- 三个前缀同时登记进 `orbit-authored-turn.ts#isOrbitAuthoredTurn`：没有人打过这些字，撤回时不还给输入框；<br>- 共享类型另加 `ConfirmationUnderReview`（N3 的形状）、`ConfirmationReviewRequestCard`（D7）、`ConfirmationReturnCard`（B3），都在 `src/shared/src/owner-confirmation-review.ts` |
