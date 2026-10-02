# 确认卡的审查：审查方、先审后呈与审查记录（契约）

**状态**：草案，待 owner 在 app 里确认（任务 `34Z35urx0kEB2qZaLeikc`，项目 `34Z2usxH1u0wBMagUPqlM`「确认卡：审查意见、确认后果与少打扰」）。确认后冻结为 v1。服务端（任务 `34Z35uusJWkeA99O23btE`）与三端（任务 `34Z35v1nS4l48MjxDIDXX`）都按本文实现，不另造表、状态、错误码或界面用词。实现中要偏离本文，先改本文、在附录 B 写修订记录，再改代码。

**依据**：效果图 `docs/mocks/owner-confirmation-review-ios.html` 第③④台手机与第二排（整页截图 `owner-confirmation-review-ios.png`，第④台单独一张 `owner-confirmation-review-ios-4.png`），以及项目说明里写好的默认决定：首行用方案 B；超时在项目内沿用 `exceptionEscalationSeconds`、项目外 30 分钟；审查方可以退回，这项新权限由 owner 批准。

**范围**：只管 OWNER_CONFIRMED 任务确认卡上新加的「审查方先审」这一步。
- 卡片上的「If you confirm」、以及报告改取声明完成那一轮，归任务 `34Z35udELdL3GuuzpZJDQ` / `34Z35ujH0aejOiDNxcONf`。本文只规定审查栏夹在它们之间（§6 H1）。
- 「机器能验的工作由审查方结案」（B 线，任务 `34Z35v5J1Oftbjf8vazKr`）不在本文范围内。本文不给审查方任何结案的权力（§10 G9）。

**引用规范**：引用写「文件 + 符号」，不写行号。`docs/project-integration-line-contract.md` 下称 **ILC**，`docs/session-request-reply-contract.md` 下称 **SRR**。

---

## 0. 总则

### 0.1 一句话

执行会话声明完成并停下时，Orbit 记下确认请求，同时把它交给审查方。审查期间卡片照常显示、按钮照常能按，只是不计入 needs-you。审查方交回一份署名的结构化记录，或者把请求退回执行会话。卡片的首行由 Orbit 从记录的条目推出。能按确认的仍然只有 owner。

### 0.2 不变的事

- **G1 只有 owner 能确认。** 以下三处一个字不改：`task-owner-confirmation.ts` 的门；`task_owner_decision` 的 CHECK（`decided_by_type = 'USER' AND decided_by_id = owner_id`）；0267 在 DONE fence 里那条 lane。审查相关的表不进 fence，`evaluateTaskCompletion` 不读它们。
- **G2 审查不锁门。** 审查中、未经审查、已过期这几种状态下，Confirm done 和 Chat about this 都照常可按：不预选，不禁用，不改顺序。审查对确认门只加一条要求：当前那份审查里有「要你判断」的条目时，确认要带上逐条答案（§7）。答案由 owner 自己填。
- **G3 读时推导，不加定时任务。** 状态由已提交的行和读的时刻算出，做法照 `pending-evidence-judgments.ts#coordinatorHolds`。不加 `setInterval`、worker、sweep，也不在启动时扫描。本文所有写入都挂在已提交的事实上：`turnComplete`、工具调用、owner 按键。时钟只在读里出现一次，即比较 `now >= due_at`。
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

### 0.4 与效果图的不同

1. 效果图说明第 3 条写「复用正在做的 expectReply」。本文改为平台投递（§2），理由见 §2.1。
2. 效果图第③台说明写「超时先定 30 分钟」。本文的规则是：项目内用项目的 `exceptionEscalationSeconds`（默认 7200 秒），项目外 30 分钟。另外，审查方读过请求后空闲下来、又没有任何东西会叫醒它时，审查立刻按「未经审查」结束（§4 T5）。
3. 效果图第③台说明写「改完重新声明，新卡片顶掉这一张」。本文让被退回的卡片留下来，成为一条「已被审查方退回」的记录（§8 B6）。
4. 效果图方案 B 没画「要你判断」的选项。本文把选项画在首行下面（§6 H3、§7 Q2）。
5. 第二排「你先确认、审查后到」里的 Problem 行，来自 §9 的 PROBLEMS 记录。

### 0.5 条款编号

各节前缀：S 审查方、D 投递、C 审查记录、T 状态、N needs-you 与超时、H 审查栏与首行、Q 要你判断、B 退回、L 后到的审查、G 与现有规则的关系、I 实现切分。实现任务在 spec 和评论里引用条款号。

---

## 1. 审查方（S）

**S1（在请求那一刻定下）**：`runnerApi.turnComplete` 写确认请求的那个事务里，同时把审查方解析一次，写进审查行（§3.1）。之后不管任务换项目、项目换协调会话，还是 Automatic 开关变化，这一行的审查方都不改，只按 §4 改变状态。理由与 SRR §3.1「请求不跟着项目换人」相同。

**S2（解析顺序）**：在同一事务里读请求所属任务的行，依次判断：

1. `task.creator_type = 'USER'`，即 owner 在 app 里（经用户 API）建的任务：**没有审查方**，不写审查行。项目内外都一样。
2. 任务在项目里（`task.project_id` 非空）时：
   - `project.coordinator_enabled = false`：**没有审查方**，不写审查行。Automatic 开关管的是「平台自动交给协调会话的一切」（2026-09-22 定的边界，见 `owner-decision-signal.ts#readOwnerItemSignals` 的注释）。开关关着，就由 owner 自己审。
   - 否则审查方是**项目的协调会话**：`reviewer_kind = 'PROJECT_COORDINATOR'`，`reviewer_session_id = project.coordinator_session_id`，这个值可能为空（见 S4）。
3. 任务不在项目里时：
   - `task.creator_session_id` 非空：审查方是**派活的会话**，`reviewer_kind = 'TASK_CREATOR'`，`reviewer_session_id = task.creator_session_id`。
   - `task.creator_session_id` 为空：**没有审查方**，不写审查行。这种任务不是在会话里建的，比如在终端里用不带会话的 CLI 建的（runner 门会把它记成 `AGENT`，owner 在自己终端里建的也一样），或者建它的会话之后被删掉了（外键 SET NULL）。没有可以请来审的会话，与 owner 自己建的任务同样处理。

**S3（审查方不能是执行会话）**：执行会话是为这个任务开的会话（`session.task_id = task.id`）。建任务的会话在任务出现之前就已存在，跑的是别的任务或者不跑任务，所以它不可能是执行会话。协调会话也不跑任务。本文仍把这一点写成规则：解析出的会话如果 `task_id = task.id`，投递以 `REVIEWER_IS_THE_RUN` 被拒（§2 D4）。判定条件与 `task-evidence-decision.ts#decidingSessionDisqualification` 的第一条相同。

**S4（找不到审查方，或审查方已结束）**：审查行照写，状态直接就是「未经审查」（§4）。
- Automatic 项目没有协调会话（`reviewer_session_id` 为空）：D1 直接写 `delivery = 'REFUSED'`、拒绝码 `NO_COORDINATOR`，不做 D2。
- 审查方会话已结束（`sessionHasEnded`，与 `coordinator-delivery.service.ts#bindQueuedDelivery` 用同一个判定）：由 D2 以 `REVIEWER_ENDED` 拒绝。之后审查方的会话行如果被删掉，T1 读不到它，也按「已结束」处理。

**S5（审查方的名字）**：卡片和列表上显示审查方会话**当前**的标题，读的时候取。会话行已删除、取不到标题时，客户端写 `Reviewer`。

---

## 2. 投递（D）

**D1（与请求同一刻写下）**：`turnComplete` 调完 `recordOwnerConfirmationRequest` 后，在同一个事务里：
- 按 §1 解析审查方。有审查方就插入审查行：`delivery = 'PENDING'`，`window_seconds` 与 `due_at` 按 §5 N4 计算。
- 给请求行写上 `branch_sha`，取本轮的 `dto.branchSha`；runner 没报就为空。它是审查所绑提交号的参照（§3）。

请求和审查行同时提交，所以这一轮结束后的第一次读就已经是「审查中」，needs-you 不会先亮一下再灭。

**D2（提交后投递）**：这与「证据投给协调者」（`CompletionEvidenceProducer.deliver` → `CoordinatorDeliveryService.queue`）是同一类投递：在已提交的事实之后，一个事实投一条 `NEXT_TURN` 平台轮次，键由事实派生，不复活已结束的会话，被拒时由 owner 的卡片兜底。不同之处只有两点：不经过 `project_coordinator_wake`，因为项目外没有项目可挂；也不经过 convergence 授权器，因为它不计费（G5）。

事务提交后，`turnComplete` 调 `OwnerConfirmationReviewService.deliver(reviewId)`。投递走 ILC G6 的载体：

```
SessionsService.createTurn(ownerId, reviewerSessionId,
  { clientTurnId: 'owner-confirmation-review:v1:<reviewId>', content: '', intent: 'NEXT_TURN' },
  { participateSendTransaction: bindReviewDelivery })
```

- 正文为空。审查块在这一轮交给 engine 时才写进去（D6），与 `bg-wake:`、`session-reply:` 的做法相同。
- `bindReviewDelivery` 在 `createTurn` 的事务里、拿到审查方的 Session 锁之后执行。它重读审查行，要求仍是 `PENDING`，然后按以下顺序检查，任何一条不成立就抛错，这一轮不写：
  1. 审查方会话未结束（`sessionHasEnded`），否则 `REVIEWER_ENDED`；
  2. 审查方会话不是这个任务的执行会话，否则 `REVIEWER_IS_THE_RUN`；
  3. 请求仍是任务最新的一条，否则 `SUPERSEDED`；
  4. 请求没有被 owner 退回，否则 `SENT_BACK`；
  5. 仅 `PROJECT_COORDINATOR`：项目仍是 Automatic，否则 `AUTOMATIC_OFF`；
  6. 仅 `PROJECT_COORDINATOR`：项目没有进行中的暂停段（`project-fuse.ts#openFuseEpisodeId`），否则 `COORDINATOR_PAUSED`。
  
  全部成立，就把审查行改成 `DELIVERED`，写上 `delivery_turn_client_id` 和 `delivered_at`。拒绝码的记法与 `CoordinatorDeliveryService.enqueue` 翻译拒绝的方式相同：钩子自己抛的拒绝，记上面对应的码；`createTurn` 自己的普通拒绝（Not Found / Conflict / Forbidden / Bad Request），记 `SESSION_UNAVAILABLE`。
- owner 已经**确认**了这份请求，也照样投递：后到的审查正是 §9 的安全网。
- 不走 `SessionsService.resume`：不复活已结束的会话，也不 steer 正在跑的一轮。审查方正在跑一轮时，这条排在它后面（ILC X-D3：忙不是拒绝）。

**D3（项目外也收得到）**：投递直接写给审查行上的 `reviewer_session_id`，不经过项目，所以项目之外的派活会话也收得到。两种审查方的差别，只是 D2 里协调会话要多查第 5、6 两条，与 `CompletionEvidenceProducer.authorize` 里拒绝的两种情况一致。

**D4（每个请求只投一次）**：
- 一份请求至多一行审查行（`request_id` 唯一）。
- `delivery` 只从 `PENDING` 变一次，变成 `DELIVERED` 或 `REFUSED`（条件更新）。
- 这一轮的键由审查行 id 派生。`createTurn` 遇到同键、同内容只会重放，不会写第二条。
- **被拒就是终局。** `REFUSED` 写下拒绝码，状态立刻变成「未经审查」，卡片交给 owner。不释放、不重投，也不改投给后来的协调会话：审查有时限，重投只会让 owner 的卡片等得更久。
- 故障（即上面这些普通拒绝之外的异常）照样抛出。这一行留在 `PENDING`，由 D5 补投。

**D5（补偿点）**：进程可能死在事务提交和 D2 之间（ILC G2）。补偿点是：审查方会话每一次 `turnComplete` 提交之后，对 `reviewer_session_id` 是它、仍为 `PENDING` 的审查行逐个调 `deliver`。如果审查方一直没有轮次结束，这一行就停在 `PENDING`，读作「审查中」，到 `due_at` 时按「未经审查」交给 owner（§4）。最坏情况是 owner 多等一个窗口，卡片不会卡死。

**D6（审查方看到什么）**：inbox 交出轮次的地方（`runner-api.controller.ts`，`appendSessionRepliesContext` 旁边），遇到 `owner-confirmation-review:v1:` 前缀的轮次时调 `appendOwnerConfirmationReviewContext`，把审查块写进去，并记成控制面注记（`control-plane-note.ts`）。
- 这一步不是 best-effort：这一块就是这一轮的全部内容，失败就回滚领取，轮次留在队列里。
- 审查块在交出时按当时的行渲染，所以能写出请求此刻的状态。
- 给 agent 看的文字用英文，与 MCP 工具描述一致：

```
<orbit-confirmation-review task="<task publicId>" request-id="<publicId>" run-session="<publicId>"
    branch="orbit/…" sha="<40 位提交号，没有就空>" due-at="2026-10-02T15:25:00Z">
A run of the task “<title>” declared its work finished and is waiting for the account owner to
confirm it (OWNER_CONFIRMED). You are its reviewer. Until due-at the owner is not asked; after that,
or as soon as you record a review, the owner's card asks them.

What settles it (the task's acceptance criteria, first 2000 characters): …
What the run reported (the report the owner's card shows, first 2000 characters): …

Check the work on <branch> at <sha>. Then do exactly one of:
- task_confirmation_review: record what you checked, what you could not check and why, what only
  the owner can decide (each with options and the one you recommend), and what is left open, each
  line with the evidence it rests on. Orbit writes the card's first line from these lists; your
  one-sentence judgment is shown last, quoted.
- task_confirmation_return: send it back to the run with the reason, when something must change
  before the owner looks. The reason becomes the run's next message; the owner is not asked.
You cannot confirm or send back for the owner. If you end your turn without doing either and nothing
is going to wake you, Orbit treats the request as not reviewed and asks the owner.
</orbit-confirmation-review>
```

- 执行会话当前 `worktree_dirty = true` 时多一行：`The run has uncommitted changes that are not on <branch>; list what you could not see under notChecked.`
- 报告与卡片上显示的是同一份：取 `owner-confirmation-read.ts#ownerConfirmationReport`，或「If you confirm」任务改过之后的取法。
- 请求此刻已不是最新、已被 owner 退回、或已经有了 RETURN 记录时，审查块只说明是哪一种情况，再加一句 `Nothing to review; end your turn.`
- owner 已经确认时，审查块写：`The owner confirmed this at <time>. A review now is shown under their receipt; if you find a problem, task_confirmation_return tells the owner, who can reopen the task.`（§9）

**D7（审查方会话里的卡片）**：这条轮次的回显入库时，给这条 `user` 事件挂上结构化读数 `confirmationReviewRequest`：`{ requestId, reviewId, taskId, title, runSessionId, branch, sha, dueAt }`。挂的位置、规矩都与 `openItemDelivery` 相同（ILC X-D2b）。
- 三端把它画成一张只读卡片：标题 `Review requested`，下面是可点的任务标题和 `Due <HH:MM>`，另有一个打开执行会话的入口。不画成 owner 的气泡。
- `GET /sessions/:id/turns` 的两个投影都带上这份读数，排队时画的也是这张卡。
- 旧客户端照今天的方式显示注记。

**D8（不计费、不占会话间上限）**：审查轮次、退回轮次（§8）、答案轮次（§7）都是平台投递，按 ILC G7 归为「外部」：不计入协调会话的自主花费，不经过 `chargeSteer`，也不计入 SRR §2.4 的每小时 20 条。

### 2.1 为什么不用会话间请求（`expectReply`）

1. **它只能由会话发起。** `session_send` / `project_send` 带 `expectReply` 时，调用方必须是会话，headless 调用会被 403（SRR §3.1）。确认请求是平台在 `turnComplete` 里记下的事实，并没有发起它的会话。如果硬拿执行会话当发送方，问题更大：会话自己发出、还没有结局的请求算它的唤醒源（SRR §4.1 第 4 条），回信 turn 也会投回执行会话、把它叫醒。而确认请求成立的前提，恰恰是这次执行已经停下（`runStoppedWorking`）。
2. **回复只能是文本。** `session_reply({ requestId, message?, option? })` 只能带一段正文或一个选项下标。审查需要的是一句结论、四类条目、每条的证据引用和所审的提交号，首行也要从条目推出来。从一段自由文本里推不出这些，只能再交给一个 LLM 去读，而这正是 ILC §0.1 不允许的转述。
3. **结局和时钟对不上。** 请求的 `EXPIRED` 由 worker 扫 `reply_by` 写下（SRR §5），本文不加定时任务。请求的结局要交回给发送方会话，审查的读者却是卡片和 owner。
4. **配额不该被占用。** 每小时 20 条、最多 50 个 OPEN 请求，这两个上限是为 agent 之间的来回设计的（SRR §2.4、§3.1）。审查每个请求只投一次，不该和它们抢额度。

所以审查走平台投递（D2），回复走专门的工具（§3.5、§8）。两者唯一共用的是 P0 的署名：退回给执行会话的那条消息带 `sender_session_id`（§8 B3）。

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
  "return_turn_id" uuid,            -- RETURN 专用：理由投进执行会话的那一轮
  "recorded_at"    timestamp(3) NOT NULL,  -- 拿到任务行锁之后读的 clock_timestamp()，与 0267 的 decided_at 同理

  CONSTRAINT "task_owner_confirmation_review_record_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_owner_confirmation_review_record_review_fkey"
    FOREIGN KEY ("review_id", "request_id")
    REFERENCES "task_owner_confirmation_review"("id", "request_id") ON DELETE CASCADE,
  CONSTRAINT "task_owner_confirmation_review_record_task_fkey"
    FOREIGN KEY ("task_id", "owner_id") REFERENCES "task"("id", "owner_id") ON DELETE CASCADE,
  CONSTRAINT "task_owner_confirmation_review_record_shape" CHECK (
    ("kind" = 'REVIEW' AND "judgment" IS NOT NULL AND "reason" IS NULL AND "return_turn_id" IS NULL)
    OR ("kind" = 'RETURN' AND "reason" IS NOT NULL AND "judgment" IS NULL AND "return_turn_id" IS NOT NULL)
    OR ("kind" = 'PROBLEMS' AND "reason" IS NOT NULL AND "judgment" IS NULL AND "return_turn_id" IS NULL)
  )
);
-- 每份请求 REVIEW、RETURN、PROBLEMS 各至多一条。
CREATE UNIQUE INDEX "task_owner_confirmation_review_record_kind_key"
  ON "task_owner_confirmation_review_record"("review_id", "kind");
```

记录只插入，不更新，与 `task_owner_decision`「写下就不再改」是同一条规矩。RETURN 和 PROBLEMS 不会同时出现在同一份请求上：RETURN 只能在 owner 还没决定时写（§8 B3），PROBLEMS 只能在 owner 确认之后写（§9 L2）。REVIEW 可以与其中任意一种并存，比如先交 REVIEW、后来又发现问题。

### 3.3 其他表加的列

- `task_owner_confirmation_request.branch_sha char(40)`：见 D1。
- `session.branch_sha char(40)`：runner 在心跳（`dto.sessions[].branchSha`）和 `turnComplete`（`dto.branchSha`）里报的分支顶端提交，报了就写，没报就不动。今天这两处收到 `branchSha` 只拿来和 `mergedSourceSha` 比较，并不存下来。T1 判「已过期」要读它。
- `task_owner_decision` 加三列：
  - `review_record_id uuid`：owner 确认时卡上作为当前审查画出的那份记录。外键指向记录行，ON DELETE RESTRICT。这与 0267 的 `task_owner_decision_request_fkey` 是同一种情形：删任务时，决定行和记录行都随任务 CASCADE 一起删掉。
  - `review_state text`：决定那一刻的审查状态。CHECK 取值为 `NONE`、`UNDER_REVIEW`、`REVIEWED`、`NOT_REVIEWED`、`OUTDATED` 之一；在任务面板上确认、没有对应请求的决定，这一列为空。
  - `answers jsonb`：见 §7 Q4。
  
  CHECK `task_owner_decision_by_owner` 与 `task_owner_decision_send_back_shape` 不改。

**迁移**：只写一条，名为 `<号>_owner_confirmation_review`。号在落地时取，用 main 和各分支都没用过的下一个（写本文时 main 上最高是 0356），并登记进 `task-judgment-data-preserved.spec.ts` 的迁移账本。不加触发器，不改 fence，不写任何 DML。已有的请求和决定一行都不动：它们没有审查行，读作「没有审查方」。

### 3.4 共享类型与 DoneRequest 的对齐

新文件 `src/shared/src/owner-confirmation-review.ts`，web 和 OrbitKit 都照它镜像：

```ts
/**
 * One line of a review. criterionKey / whyNotProven / coordinatorChecked / evidenceRefs are
 * AcceptedGap's fields (project-done.ts), with the same names and meanings: a notChecked line IS an
 * AcceptedGap, plus a key and a text.
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
  /** ask_owner's option shape: 2–4 options, label 1–200, description at most 500. */
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
```

与 `src/shared/src/project-done.ts` 的对照：

| 审查记录 | DoneRequest / AcceptedGap | 说明 |
|---|---|---|
| `judgment` | `DoneRequest.judgment` | 审查方的结论，一两句话 |
| `notChecked[]` | `DoneRequest.gaps: AcceptedGap[]` | 每条可带 `criterionKey`、`whyNotProven`、`coordinatorChecked`、`evidenceRefs`，字段同名同义，只多出 `key` 和 `text`。B 线若要把审查变成项目收尾时接受的缺口，可以原样搬过去 |
| `checked[]` / `leftOpen[]` / `needsYou[]` | 无对应 | 用同一种条目形状。needsYou 多出 `options` 和 `recommendedOption`，形状取自 `ask_owner` |
| `requestId` + `reviewedSha` | `DoneRequest.criteriaDigest` | 都用来封住「审的是哪一份」：digest 变了，请求就 409；这里请求被顶替或分支移动了，记录就过期（§4） |

与 `AcceptedGap` 有一处不同：AcceptedGap 保留未知键（`[key: string]: unknown`），因为它是 owner 的卡片发回来的；审查记录是 agent 的输入，DTO 按白名单校验，出现未知键就 400。

### 3.5 工具 `task_confirmation_review`

- 入口：MCP 工具 `task_confirmation_review`；CLI `orbit task confirmation-review --json <文件|->`，整份输入就是一个 JSON；runner 门 `POST /runner/tasks/:taskId/owner-confirmation/review`，挂在 `RunnerTaskOwnerConfirmationController`，与 `claim` 在一起。
- `taskId` 走 `PublicIdPipe`，`requestId` 按 public id 解码。审查方不是这个任务的执行会话，所以 `taskId` 没有默认值，必须给。
- 门按下表顺序判，前一条不过就不读后一条，什么都不写。拒绝的形状与 `task-owner-confirmation.ts` 相同：`code`、`kind: 'REFUSAL'`、`requiredAction`、`message`。

| # | 要求 | 不满足时 |
|---|---|---|
| 1 | 请求带会话头，即调用方是会话 | 403 `CONFIRMATION_REVIEW_REQUIRES_SESSION` |
| 2 | 请求属于本账户、有审查行，且调用方会话等于 `reviewer_session_id` | 403 `CONFIRMATION_REVIEW_NOT_THE_REVIEWER`。没有审查行时用同一个码，文案说明这个任务没有审查方 |
| 3 | 调用方会话此刻有一轮在进行（`IN_FLIGHT`） | 409 `CONFIRMATION_REVIEW_OUTSIDE_TURN` |
| 4 | 请求仍是任务最新的一条 | 409 `CONFIRMATION_REVIEW_SUPERSEDED`，附最新请求的 id |
| 5 | 这份请求还没有 REVIEW 记录，也没有 RETURN 记录 | 409 `CONFIRMATION_REVIEW_ALREADY_RECORDED`。例外：同一会话、同一轮再次调用（工具回包丢了之后的重试），返回已有那份记录并带 `alreadyRecorded: true`，内容不同也不改写 |
| 6 | 字段合法：长度和个数符合 §3.4；`whyNotProven` / `coordinatorChecked` 只出现在 notChecked；`options` / `recommendedOption` 只出现在 needsYou；请求有 `branch_sha` 时 `reviewedSha` 必填，且为 40 位小写十六进制；请求没有 `branch_sha` 时 `reviewedSha` 必须不给 | 400 |
| 7 | owner 已经对这份请求做了决定时，`needsYou` 必须为空 | 400 `CONFIRMATION_REVIEW_NEEDS_YOU_AFTER_DECISION`，requiredAction `RETURN_IT_IF_SOMETHING_MUST_CHANGE` |

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
| 4 | `NOT_REVIEWED` 未经审查 | 满足下列任一：`delivery = 'REFUSED'`；审查方会话已结束（`sessionHasEnded`）；`abandoned_at` 不为空（T5）；已投递的那一轮被丢掉了，即按 `(reviewer_session_id, delivery_turn_client_id)` 在 `conversation_turn` 里找不到它（被打断或撤回时删掉了）；审查方为 `PROJECT_COORDINATOR` 且那个项目已不是 Automatic；`now >= due_at` |
| 5 | `UNDER_REVIEW` 审查中 | 其余情况，包括 `PENDING` 和 `DELIVERED` |

**T2（未经审查的原因）**：`notReviewedReason` 按下面的顺序，取第一个成立的：
1. 投递被拒（`REFUSED`），按拒绝码映射：`NO_COORDINATOR`、`REVIEWER_ENDED`、`AUTOMATIC_OFF`、`COORDINATOR_PAUSED` 原样保留；`REVIEWER_IS_THE_RUN`、`SESSION_UNAVAILABLE`、`SUPERSEDED`、`SENT_BACK` 记为 `UNREACHABLE`。其中 `SUPERSEDED` 和 `SENT_BACK` 两种请求已经不在 owner 面前，不会被画出来。
2. `REVIEWER_ENDED`：审查方会话已结束，或者它的会话行已被删除。
3. `REVIEWER_STOPPED`：审查方读过后空闲下来（abandoned），或已投递的那一轮被丢掉了。
4. `AUTOMATIC_OFF`：项目已不是 Automatic。
5. `TIMED_OUT`：窗口已到。

**T3（已过期的原因）**：`outdated.cause` 有两种。`NEWER_REPORT`（请求被新的请求顶替）优先于 `BRANCH_MOVED`；`BRANCH_MOVED` 时带上执行会话当前的提交 `branchSha`。拿不到分支或提交号时（不是 git 工作区、runner 太旧、会话行已删），不判 `BRANCH_MOVED`。

**T4（状态只因以下写入而改变）**：
- D2 的投递条件更新；
- T5 写 `abandoned_at`；
- §3.5、§8、§9 写记录；
- 下一份请求写入，顶替了这一份；
- 审查方会话结束（它自己结束时的那次写入）；
- owner 改了项目的 Automatic 开关。

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
- 两个工具的门（§3.5 第 7 条、§8）；
- 确认门的答案校验（§7）。

道理与 `coordinatorHolds` 同时供队列和计数使用相同。

---

## 5. needs-you、Under review 与超时（N）

**N1（审查中不计入）**：`owner-confirmation-read.ts#readWaitingOwnerConfirmations` 只返回审查状态不是 `UNDER_REVIEW` 的等待请求。于是一张审查中的卡片：
- 不进 `readOwnerDecisionSignals`；
- 会话行的 `pendingApprovals` 不因它加一，也不设 `waitingKind`；
- 不出顶部提示条（iOS 的 `1 open question below`），web 的 DecisionRail 也不出指向它的那一行；
- 各工作区的 needs-you 计数不算它。

这沿用 owner decision 10：还在别人手里的事，不来叫你。

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
  reviewerSessionId: string | null;
  reviewerTitle: string | null;
  since: string;   // the request's requestedAt
  dueAt: string;
} | null;
```

- 只在审查状态为 `UNDER_REVIEW` 时非空。其他状态要么在卡片上，要么按 N2 计数。
- 这个字段总是带上，没有就给 `null`，约定与 `retryAt` 相同：客户端把摘要并进已有的行时，`null` 表示「清掉」，字段缺席才表示「不变」。
- 用词：会话标题栏的副标题写 `Under review · Open · 2m ago`，即把今天写 `Waiting for your confirmation` 的那一段换成 `Under review`。会话列表行写 `Under review · <审查方标题>`，用次要文字颜色加时钟图标，不点橙色，也不进 needs-you 分组。它占的位置和优先级，与今天 `waitingKind = OWNER_CONFIRMATION` 相同。

**N4（窗口）**：`window_seconds` 在 D1 写下后就不再变：
- `PROJECT_COORDINATOR`：取请求那一刻的 `project.exception_escalation_seconds`（默认 7200）。之后改项目设置，只影响后来的请求，与 ILC X-E2 相同。
- `TASK_CREATOR`：取常量 `OWNER_CONFIRMATION_REVIEW_WINDOW_SECONDS_OUTSIDE_PROJECTS = 1800`，它不是设置项。

`due_at = request.requested_at + window_seconds`。窗口从请求时起算，而不是从投递时起算：owner 等待的是执行停下之后的时间，投递慢不该让他多等。

**N5（到点时服务端不做任何事）**：到 `due_at` 时，服务端什么都不写，也什么都不推（G3）。
- 客户端在前台持有一张审查中的卡片或一行 Under review 时，自己在 `dueAt` 之后 1 秒重读一次那一行和那张卡；回到前台或启动时照常重读。这是客户端的本地计时，不是服务端的定时任务。
- 状态因写入而改变时（D2 被拒、T5、交回记录、退回），服务端在提交后发 `TASK_CHANGED`（该任务）和 `publishSessionUpdated(执行会话)`。

**N6（推送规则不变）**：今天确认卡不推送，`PushService.needsYouSessions` 也不数它，本文不改这两点。唯一新增的推送是 §9 L5。

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

**H2（首行，方案 B）**：首行由服务端从记录的条目算出，作为数据下发。措辞由三端各自的文案表负责，文案逐字一致（§12）：

```ts
type ConfirmationReviewHeadline =
  | { kind: 'NEEDS_YOU'; text: string; more: number }      // text = needsYou[0].text，more = needsYou.length − 1
  | { kind: 'NOTHING_NEEDS_YOU'; notChecked: number }      // notChecked.length
  | { kind: 'PROBLEMS_AFTER_CONFIRM'; problems: number };  // §9：PROBLEMS 记录的条数
```

- 有 needsYou 时写 `Needs you: <第一条的问题>`，`more > 0` 时后面接 ` (+<more> more)`，用橙色。
- 没有 needsYou 时写 `<N> not checked · nothing needs you`。N 可以是 0。用正文色加粗。
- 有 PROBLEMS 时（只出现在回执下，见 §9）写 `1 problem found after you confirmed` 或 `<N> problems found after you confirmed`，用橙色。
- 首行只占一行，放不下就截断，完整的文字在下面的条目里。
- 审查方的 `judgment` 不进首行。首行是哪一种，只由 needsYou 与 notChecked 的条数（回执下还有 problems 的条数）决定，审查方没有任何字段能左右它。

**H3（各状态下的审查栏）**：标题行一律是 `REVIEW · <审查方标题>`，取不到标题时写 `Reviewer`。

- `UNDER_REVIEW`：时钟图标 + `Reviewing since <HH:MM>`（取 `since`）；下一行写 `Orbit will ask you once the review is in. You can still confirm now.`
- `REVIEWED`：标题行后面接 ` · <记录时间 HH:MM>`，右侧显示 `reviewed_sha` 的前 7 位（没有就不显示）。下面依次是：
  1. 首行；
  2. needsYou 的作答块（§7 Q2）：第一条的问题文字就是首行，紧接着画它的选项，其余各条依次画在下面；
  3. `Checked`、`Not checked`、`Left open` 三行：每行把该类条目的文字用 ` · ` 连起来，最多两行；点开后就地展开成逐条列表，带证据引用；没有条目的那一类不画；
  4. 最后一行是审查方的 `judgment`，加引号。
- `NOT_REVIEWED`：横线图标 + `Not reviewed`。下一行按原因（T2）写一句话，后面再接 ` Only the agent that did the work has checked this.`。各原因的句子：
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
reviewRecordId?: string | null;  // 卡上作为当前审查画出的那份 REVIEW 记录
answers?: Array<{ key: string; option?: number | null; text?: string | null }>;
```

在任务行锁下，`ownerDecisionRefusal` 通过之后，按 §4 算出这份请求此刻的审查状态，再按下表判断：

| 此刻的审查状态 | `reviewRecordId` | `answers` | 结果 |
|---|---|---|---|
| 不画审查栏 / 审查中 / 未经审查 | 空 | 空 | 受理 |
| 不画审查栏 / 审查中 / 未经审查 | 非空 | 任意 | 409 `OWNER_CONFIRMATION_REVIEW_STALE` |
| 已审，没有 needsYou | 空，或等于当前记录 | 空 | 受理 |
| 已审，没有 needsYou | 非空，且不等于当前记录 | 任意 | 409 `OWNER_CONFIRMATION_REVIEW_STALE` |
| 已审，有 needsYou | 等于当前记录 | 每个 needsYou 键恰好一条，且合法 | 受理 |
| 已审，有 needsYou | 等于当前记录 | 缺少某些键 | 409 `OWNER_CONFIRMATION_ANSWERS_REQUIRED`，列出缺的键 |
| 已审，有 needsYou | 空 | 任意 | 409 `OWNER_CONFIRMATION_ANSWERS_REQUIRED` |
| 已审，有 needsYou | 非空，且不等于当前记录 | 任意 | 409 `OWNER_CONFIRMATION_REVIEW_STALE` |
| 已过期 | 空，或等于那份旧记录 | 空 | 受理 |
| 已过期 | 其他 | 任意 | 409 `OWNER_CONFIRMATION_REVIEW_STALE` |

- 每条答案在 `option`（取 0 到 `options.length − 1`）和 `text`（1–2000 字符，对应 Other）之中恰好给一个。有多余的键、重复的键、不存在的键，都 400。表中 `answers` 一栏写「空」的行，请求如果带了非空的 `answers`，同样 400。
- 409 的 `requiredAction`：`ANSWERS_REQUIRED` 配 `ANSWER_EACH_REVIEW_QUESTION`；`REVIEW_STALE` 配 `READ_THE_TASK_AGAIN_AND_DECIDE_WHAT_IS_WAITING_NOW`（即现有的 `STALE_ACTION`）。两个码都加进客户端的 `staleCodes`，标题写 `Not recorded: this card is out of date`，随后卡片重读。
- `SEND_BACK` 不带答案，带了就 400。owner 在卡上选过的项只留在卡片自己的本地状态里。
- 在任务面板上确认时（`requestId` 为空，没有执行在等）不带答案。
- 旧客户端不会发这两个字段。遇到「已审、有 needsYou」的请求会被 409 拒绝，提示 owner 在新版 app 里作答。这是有意为之：不让一次不看问题的确认把拍板项吞掉。

**Q4（记下来）**：确认的决定行写三样：`review_record_id`（客户端给的值，已校验属于这份请求）、`review_state`（决定那一刻的状态）、`answers`（`[{ key, option, text }]`；没有答案就不写这一列）。决定行仍然只插入，CHECK 不变。

**Q5（送到会用它的地方）**：在决定的事务提交之后（不在那个事务里）做三件事：
1. 审查方会话还没结束时，给它投一条平台轮次：`clientTurnId = 'owner-confirmation-answers:v1:<decisionId>'`，`NEXT_TURN`。正文由记录和决定这两行渲染出来，两者都不可变。内容包括：任务、`The owner confirmed it at <time>`、逐条「问题 → 选中的选项或 owner 的原话」。审查方已结束就不投，也不复活它（ILC G6）。
2. 在任务上写一条评论，主键由决定 id 派生，加 `skipDuplicates`。评论的署名与写法照 `session-request.service.ts#commentOnAskerTask`：署名按 `postRunFailureComment` 的规矩，正文用中文，说明这是 owner 对审查问题的回答，并逐条列出。这样之后任何读这个任务的 agent（`task_get` 会带上评论）都看得到。2026-09-29 那次缺的正是这一环。
3. 回执上显示 `Your answers`，逐条写「问题 — 答案」（§9 L3）。

---

## 8. 审查方退回（B）：新增的 agent 权限

今天，能让一份确认请求回到执行会话的只有 owner 的 Send back。本节给审查方一个范围窄得多的同类动作。这是一项新权限，下面把边界写全。owner 批准本文，就等于批准这一节。

**B1（工具）**：MCP 工具 `task_confirmation_return`；CLI `orbit task confirmation-return --json <文件|->`；runner 门 `POST /runner/tasks/:taskId/owner-confirmation/return`。输入是 §3.4 的 `ConfirmationReturnInput`：
- `reason` 1–4000 字符，与 owner 退回时的上限 `MAX_OWNER_DECISION_NOTE_CHARS` 相同；
- `problems` 1–10 条，每条的限制同 §3.4；
- `reviewedSha` 的规则与 §3.5 第 6 条相同。

**B2（谁能用）**：只有这份请求审查行上的审查方会话，而且要在它的一轮之内；判定照搬 §3.5 的第 1–3 条。执行会话、其他会话、headless 调用一律拒绝。owner 不用这个工具，他有 Send back。

**B3（什么时候能用，做什么）**：请求此刻必须「还在等」：是任务最新的一条、owner 没有决定、没有 RETURN 记录、任务处于 OPEN 或 IN_PROGRESS、执行会话没有结束。满足时，在一个事务里完成以下几件事。事务的形状与 owner 的 Send back 相同：先由 `createTurn` 拿执行会话的 Session 锁（rank 30），再在钩子里锁任务行（rank 50），并复核上面每一条。

- 给执行会话写下一条消息：`clientTurnId = 'confirmation-return:v1:<recordId>'`，`NEXT_TURN`，`senderSessionId = 审查方会话`。带上 P0 的署名后，engine 会看到 `<orbit-session-message>` 块，客户端也会画成「来自 <审查方>」的卡片，而不是 owner 的气泡。消息正文依次是：`reason` 原文；每条 problem 一行，带证据引用；最后一行是 Orbit 的固定句 `When this is fixed, declare the work finished again with task_request_confirmation.`
- 插入 RETURN 记录，写入 `reason`、`body.problems`、`reviewed_sha`、`return_turn_id`。
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
- 读面带上 `reviewerReturns[]`（§11 I-S7），卡片据此来画。任务面板的确认历史里也会列出这条记录。
- 执行会话的对话里，那条消息画成来自审查方的会话消息卡片。

**B7（owner 的权力不变）**：退回之后，owner 照样可以在任务面板上直接确认（`requestId` 为空的确认，确认门照今天的规则受理），也可以给执行会话发消息。审查方的退回挡不住 owner 做任何事。

**B8（门的完整顺序）**：`task_confirmation_return` 按下表从上往下判，前一条不过就不读后一条。拒绝时什么都不写。

| # | 判断 | 结果 |
|---|---|---|
| 1–3 | 同 §3.5 第 1–3 条（是会话、是这份请求的审查方、在一轮之内） | 同 §3.5 |
| 4 | 请求不是任务最新的一条 | 409 `CONFIRMATION_REVIEW_SUPERSEDED` |
| 5 | 这份请求已有 RETURN 或 PROBLEMS 记录 | 409 `CONFIRMATION_REVIEW_ALREADY_RECORDED`（同一会话同一轮的重试返回已有记录，规矩同 §3.5 第 5 条） |
| 6 | 字段不合法（B1） | 400 |
| 7 | owner 已经**确认**了这份请求 | 转到 §9 L2：写 PROBLEMS 记录，不投给执行会话。不再判后面几条 |
| 8 | owner 已经**退回**了这份请求 | 409 `CONFIRMATION_RETURN_ALREADY_SENT_BACK`，文案说明 owner 已经把它退回执行会话了，要补充就用 `session_send` |
| 9 | 任务已经结算（DONE、CANCELLED、FAILED） | 409 `CONFIRMATION_RETURN_TASK_SETTLED` |
| 10 | 执行会话已经结束 | 409 `CONFIRMATION_RETURN_RUN_ENDED`，requiredAction `RECORD_A_REVIEW_FOR_THE_OWNER` |
| 11 | 已到 B5 的次数上限 | 409 `CONFIRMATION_RETURN_LIMIT` |
| 12 | `PROJECT_COORDINATOR`：项目不是 Automatic / 在暂停段里 | 409 `COORDINATOR_DISABLED` / `PROJECT_FUSE_PAUSED` |
| — | 以上都没命中 | 按 B3 退回 |

第 4–12 条在 B3 的事务里、拿到任务行锁之后再复核一遍，钩子里不成立就抛错，消息不写。

---

## 9. owner 先确认、审查后到（L）

**L1（后到的 REVIEW）**：owner 对一份请求做了决定之后，审查方仍可以对它交 REVIEW（按 §3.5，第 7 条要求此时 needsYou 为空）。这份记录挂在那条决定的回执下面。

**L2（后到的问题记为 PROBLEMS）**：owner **确认**之后，审查方再调 `task_confirmation_return`，消息不投给执行会话，而是写一条 PROBLEMS 记录（`reason`、`problems`、`reviewed_sha`），提交后按 L5 通知 owner。每份请求至多一条。

**L3（回执）**：回执（`RecordedOwnerDecision`）多三样东西：`review`（这份请求的审查，状态现算）、`answers`、`reviewStateAtDecision`。画法照效果图第二排的「YOU CONFIRMED FIRST」：
- 沿用今天的回执行（`Confirmed done` 与决定时间）。这份请求的第一条记录如果晚于决定时间，下面加一行 `Before the review came in`。
- 有 PROBLEMS 时：审查栏首行写 `<N> problem(s) found after you confirmed`（橙色），每条 problem 一行 `Problem | <text>`，下面一个 `Reopen task` 按钮。
- 只有 REVIEW 时：按 §6 H3 的「已审」来画，但不带作答控件。
- 有 `answers` 时：写 `Your answers`，逐条「问题 — 答案」。

**L4（Reopen task）**：回执上的 `Reopen task` 只在同时满足两个条件时出现：有 PROBLEMS 记录；任务状态是 DONE、CANCELLED 或 FAILED（`TaskReopen.isOffered`）。按下去弹出的确认对话框、做的写入，都与任务面板上的相同：OrbitKit 用 `TaskReopen.request` / `TaskReopenCopy`，web 用 `TaskDetailPanel.tsx#reopenMutationOptions`。不造新的门。

**L5（推送）**：PROBLEMS 记录提交后，如果任务此刻是 DONE，就调 `PushService.notifyConfirmationProblems(recordId)` 给 owner 的设备推一条：
- 标题是任务标题；
- 正文写 `1 problem found after you confirmed` 或 `<N> problems found after you confirmed`；
- 点开进入执行会话里的那条回执。

每条 PROBLEMS 记录只推一次（每份请求也至多一条）。正文全是 Orbit 的话，不带审查方写的字。不计入角标，因为已结算的任务不算问题。

**L6（不计入 needs-you）**：后到的审查和问题都不进 needs-you 计数：任务已经结算，没有在等的问题。owner 靠 L5 的推送和回执得知。

---

## 10. 与现有规则的关系（G）

**G1（OWNER_CONFIRMED 仍只由 owner 本人确认）**：`task-owner-confirmation.ts#ownerConfirmationPrincipalRefusal` 不改。审查方会话无论走 runner 门，还是带着会话头走用户门，都会以 `OWNER_CONFIRMATION_REQUIRES_ACCOUNT_OWNER` 被 403，一行都不写。审查记录、退回、答案都不是决定行，0267 的 fence lane 只读 `task_owner_decision`。本文给确认门加的只有两处：§7 Q3（owner 自己的答案），以及 §8 B3 的「有 RETURN 记录就当作已回答」（这会让卡片上的旧按键变成 STALE，但 owner 在任务面板上照样能确认）。两处都不能让 agent 确认，也不能让 agent 拦住 owner 确认。

**G2（Automatic 项目里的委托规则）**：`owner-confirmed-automatic-delegation.ts` 不改。Automatic 项目里，agent 只能为写着 OWNER_CONFIRMED 的判据声明这类任务。这些任务现在先由协调会话审，再交给 owner。

**G3（From Orbit 署名的含义）**：卡片上的 From Orbit 表示：这张卡由 Orbit 从行里组出来，按钮由 Orbit 授权、直接打到确认门，中间不经过任何 agent。agent 写的字只能以一种方式出现在卡上：放在写明作者的框里，原样显示。今天的 `WHAT THE AGENT SAID · <时间>` 是一例，审查栏 `REVIEW · <审查方> · <时间> · <提交>` 是第二例。agent 的字不会出现在这些地方：卡片标题、From Orbit 那一行、首行的计数与措辞、按钮、If you confirm，以及 Orbit 自己的任何句子。首行是 Orbit 推出来的；它引用的 needsYou 问题文字位于同一个署名框里，原样照录，不改写。

owner 确认卡的署名提示改为 `Orbit composed this card and authorised its buttons. Anything an agent wrote is shown in a box that names who wrote it.`：web 新增一个常量，挂在卡片署名的 `title` 上；OrbitKit 同步加一个对应的常量。其他卡片的署名提示不改。

**G4（ILC §0.1「owner 直接看卡片，不经 LLM 转述」）**：审查不是转述。
- 卡片上 Orbit 的事实，即验收标准、执行会话的报告、If you confirm，照旧由 Orbit 直接从行里画出来，审查栏另加在旁边。
- 审查方写不进 Orbit 的任何一行，也没有哪个 LLM 替 owner 概括这张卡。
- 授权的决定仍是 owner 在卡上做的。审查方的话以署名原文出现，是 owner 做决定时的一份参考，地位与 What the agent said 相同。

**G5（owner decision 10）**：审查中不计数，与「还在协调会话手里的待办不计数」（`ownerItemKind`）、`coordinatorHolds` 遵循同一条规矩。

**G6（ILC 的 G3 / G5 / G6 / G7）**：三个新前缀加进 ILC §0.3 G6 的表，以及 G7 表里「平台投递」那一行，由实现任务同时修改 ILC：

| `clientTurnId` 前缀 | 发给谁 | 定义在 |
|---|---|---|
| `owner-confirmation-review:v1:<reviewId>` | 审查方会话 | 本文 D2 |
| `confirmation-return:v1:<recordId>` | 执行会话（带审查方署名） | 本文 B3 |
| `owner-confirmation-answers:v1:<decisionId>` | 审查方会话 | 本文 Q5 |

三个前缀都加进 `watch-turn-key.ts` 的 `RESERVED_TURN_KEY_PREFIXES`，客户端的入口一律拒收。时钟（ILC G3）、唤醒事件与 blocker 的闭集（ILC G5）都不增加。

**G7（SRR）**：审查不是会话间请求。退回这条消息带 P0 的 `sender_session_id`，所以 SRR §2.1「只有三个入口填 `sender_session_id`」要改成四个，第四个是本文 B3。但退回不是请求，也不调 `session-message.ts#chargeSessionMessage`，因此不计入 SRR §2.4 的每小时上限。它每份请求至多一次，并另有 B5 的上限。

**G8（CIR 与 coordinatorHolds）**：两者是同一种「读时 hold」：hold 从投递行和时钟读出来，结束时不需要写任何东西去收回。

**G9（B 线）**：本文不给审查方结案的权力。哪些任务可以由审查方结案、owner 只管合入 main，由 B 线任务根据量化报告另行决定。本文的记录已经为它留好了可以原样搬用的形状：notChecked 就是 AcceptedGap。

---

## 11. 实现切分与测试清单（I）

### 11.1 服务端（任务 `34Z35uusJWkeA99O23btE`）

| 编号 | 内容 | 条款 |
|---|---|---|
| I-S1 | 迁移：两个表、三个枚举、`request.branch_sha`、`session.branch_sha`、`task_owner_decision` 的三列；登记迁移账本 | §3 |
| I-S2 | 存下 runner 报的 `branchSha`：心跳和 `turnComplete` 写 `session.branch_sha`，D1 写 `request.branch_sha` | §3.3、D1 |
| I-S3 | 新文件 `tasks/owner-confirmation-review.ts`：`resolveReviewer`（S2–S4）、`confirmationReviewStates`（T1–T3，批量）、`reviewHeadline`（H2）、输入校验（§3.5 第 6 条、B1）、答案校验（Q3） | §1、§4、§6、§7 |
| I-S4 | 新文件 `tasks/owner-confirmation-review.service.ts`：`deliver`（D2）、`deliverPendingFor(sessionId)`（D5）、`review`（§3.5）、`return`（B3、B8、L2）、答案的投递与评论（Q5） | §2、§3、§7、§8、§9 |
| I-S5 | `turnComplete`：D1 在同一个事务里写审查行；提交后调 `deliver`；在审查方那一侧，T5 与 `closeUnansweredRequests` 放在同一处；提交后调 `deliverPendingFor` | D1、D2、D5、T5 |
| I-S6 | 交出轮次时：`appendOwnerConfirmationReviewContext` 和控制面注记；回显挂 `confirmationReviewRequest`；`GET /sessions/:id/turns` 的两个投影 | D6、D7 |
| I-S7 | 读面：`OwnerConfirmationView` 加 `waiting.review`、`decisions[].review / answers / reviewStateAtDecision / reviewRecordId`、`reviewerReturns[]`；`readWaitingOwnerConfirmations` 按 N1 排除；会话摘要加 `confirmationUnderReview`（列表、realtime upsert） | N1–N3、L3、B6 |
| I-S8 | 确认门：DTO 加 `reviewRecordId` 和 `answers`，按 Q3 判、按 Q4 写；`waitingOwnerConfirmation` / `latestOwnerConfirmationRequest` / `staleReason` 认 RETURN | Q3、Q4、B3 |
| I-S9 | runner 门：`RunnerTaskOwnerConfirmationController` 加 `review` 和 `return` 两个路由 | §3.5、B1 |
| I-S10 | `PushService.notifyConfirmationProblems` | L5 |
| I-S11 | runner-go：两个 MCP 工具、两个 CLI 子命令、`agent_instructions.go` 的子命令清单、`cli_mcp_parity_test`；`task_request_confirmation` 的描述补一句：`If the task has a reviewer, Orbit asks it first and the owner's card waits until the review is in.` | §3.5、B1 |
| I-S12 | 普查与清单：`db-write-inventory.ts`（新写入点及锁序）、public-id 覆盖（`reviewId`、`recordId`、`requestId`，以及 shared codec 的 `PUBLIC_ID_FIELDS`）、改 controller 前的 `getOwnPropertyNames` 普查、`RESERVED_TURN_KEY_PREFIXES`、ILC §0.3 的两张表 | G6 |

**pg spec 清单**（新文件 `tasks/owner-confirmation-review.pg.spec.ts`，每条注明对应条款）：

1. 解析审查方：owner 建的任务在项目内外都没有审查行；Automatic 项目 → 协调会话；非 Automatic 项目 → 没有审查行；项目外在会话里建的任务 → 建任务的会话；项目外不带会话建的任务 → 没有审查行；Automatic 项目没有协调会话 → `NO_COORDINATOR`；审查方已结束 → `REVIEWER_ENDED`；暂停中 → `COORDINATOR_PAUSED`。（S2、S4、D2）
2. 同一事务：`turnComplete` 之后第一次读，就是 `UNDER_REVIEW`，执行会话的 needs-you 为 0，`confirmationUnderReview` 非空。（D1、N1、N3）
3. 只投一次：`deliver` 调两次只得到一条轮次；被拒之后不再重投；D5 能补投 `PENDING` 的行。（D4、D5）
4. 项目外：派活的会话收到 `owner-confirmation-review:v1:` 轮次，交出时内容里带审查块。（D3、D6）
5. 窗口：`readAt >= due_at` → `NOT_REVIEWED / TIMED_OUT` 并计数；项目内取冻结的 `exceptionEscalationSeconds`，事后改设置不影响；项目外为 1800。（N4、T1）
6. 空闲：审查方收到审查轮次、结束这一轮时没交记录，又没有唤醒源 → 立刻 `REVIEWER_STOPPED`；有一个在跑的后台作业时仍是 `UNDER_REVIEW`。（T5）
7. 交回 REVIEW → `REVIEWED` 并计数；首行三种都覆盖；`judgment` 不出现在首行。（§3.5、H2）
8. 已过期：`session.branch_sha` 移动 → `OUTDATED / BRANCH_MOVED`；有了新请求 → 旧记录 `OUTDATED / NEWER_REPORT`。（T1、T3）
9. 工具门：非审查方 403；一轮之外 409；被顶替 409；重复记录 409；同一轮重试返回已有记录；`reviewedSha` 必填或必须不给；owner 决定后交 needsYou → 400。（§3.5）
10. 审查方不能确认：runner 门和带会话头的用户门都 403 `OWNER_CONFIRMATION_REQUIRES_ACCOUNT_OWNER`，一行不写。（G1）
11. 答案：Q3 表里每一行一个用例；CONFIRM 带完整答案 → DONE、`answers` 已写、审查方收到 `owner-confirmation-answers:v1:` 轮次、任务上有评论且重复处理不重复写；SEND_BACK 带答案 → 400。（Q3–Q5）
12. 退回：执行会话收到的消息 `sender_session_id = 审查方`；请求不再等待，任务仍是 OPEN；卡片上的旧按键 STALE，面板确认受理；第 4 次 409 `CONFIRMATION_RETURN_LIMIT`；Automatic 关闭或暂停中 409；owner 已退回 409；执行会话已结束 409。（B3、B5、B7、B8）
13. 后到：审查中 owner 确认，决定行记 `review_state = 'UNDER_REVIEW'`；之后的 REVIEW 挂在回执下；之后的 return → PROBLEMS 记录加一次推送，不投给执行会话。（L1、L2、L5）
14. 保留前缀：三个前缀在所有允许调用方指定 `clientTurnId` 的入口都被拒。（G6）

**要一并更新的旧钉子**（把旧行为写成断言的 spec，开工前先全仓 grep 一遍，以 grep 结果为准）：
- `tasks/task-owner-confirmation.pg.spec.ts`：现有夹具都是 `CreatorType.USER`，按 S2 没有审查方，行为不变，应保持绿色；「协调会话行保持暗」那条断言不动，另加一条「Automatic 项目里审查中的执行会话行也是暗的」。
- `sessions/needs-you-owner-decision.pg.spec.ts`：整行 deepEqual `readOwnerDecisionSignals`。
- 三个假 prisma：`realtime/stream-for-user.spec.ts`、`sessions/session-capabilities-payload.spec.ts`、`sessions/workspace-session-counts.spec.ts`。
- `tasks/task-judgment-data-preserved.spec.ts`：迁移账本。
- 按 enumsortorder 钉住标签全集的 pg spec：用 `git grep -nE 'enumlabel' -- '*.pg.spec.ts'` 找。本文只新增枚举类型，不往已有枚举里加值，预期不红，但要跑一遍确认。

### 11.2 三端（任务 `34Z35v1nS4l48MjxDIDXX`）

| 编号 | 内容 | 条款 |
|---|---|---|
| I-C1 | 照 §3.4 镜像共享类型（web 的类型、OrbitKit 的 Codable）；会话摘要加 `confirmationUnderReview` | §3.4、N3 |
| I-C2 | 审查栏的五种画法和首行：web `OwnerConfirmationCard.tsx`，原生 `ApprovalCards.swift#OwnerConfirmationCardView`（iOS 与 macOS 共用），文案放在 OrbitKit `OwnerConfirmation.swift` | H1–H4 |
| I-C3 | needsYou 作答块，以及确认时的请求体（`reviewRecordId` + `answers`）；两个新拒绝码加进 `staleCodes` | Q2、Q3 |
| I-C4 | 退回记录：卡片原地变成记录 | B6 |
| I-C5 | 回执：后到的审查、`Before the review came in`、`Your answers`、PROBLEMS 与 `Reopen task` | L3、L4 |
| I-C6 | Under review：标题栏副标题、列表行；审查中不出提示条、不出 DecisionRail 的指向行；在 `dueAt` 本地重读 | N1、N3、N5 |
| I-C7 | 审查方会话里的 `Review requested` 卡片 | D7 |
| I-C8 | 署名提示的新文案 | G3 |

**测试**：web vitest；swift test。`OwnerConfirmationCopyParityTests` 扩到 §12 的每一条新文案。`NeedsYouOwnerDecisionTests` 加「审查中不计数」。iOS 截图由 CI probe 拍出，分别对照效果图第③台（审查中）、第④台（已审，方案 B）和第二排（未经审查、已过期、先确认后审查），另外补拍退回记录和 needsYou 作答块。

### 11.3 次序与冲突

1. 本文经 owner 确认后，服务端先开工；三端依赖读面的字段，可以先照 §3.4 的类型写桩。
2. 「If you confirm」那两个任务也在改 `owner-confirmation-read.ts`、`OwnerConfirmationView` 以及两端的卡片。后落地的一方 rebase 之后把字段并进来，不改对方的字段；报告的取法以那边为准（D6）。
3. 服务端的 pg spec 和 apiserver 全量单测通过之后，三端再接上真实的读面。

---

## 12. 新造的用词（供 owner 拍板）

三端逐字一致。下表「位置」一栏说明用在哪里；「沿用」表示已有的字，不算新造。

| 文案 | 位置 | 新 / 沿用 |
|---|---|---|
| `Under review` | 执行会话标题栏副标题的第一段；列表行写作 `Under review · <审查方>` | 新 |
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
| `Returned to the agent`、`The agent got this as its next message. You were not asked.` | 已被审查方退回 | 新 |
| `Evidence` | needsYou 作答块里证据引用的折叠标题 | 新 |
| `Your answers are sent with Confirm done.` | needsYou 作答块下面 | 新 |
| `Your answers` | 回执 | 新 |
| `Before the review came in` | 回执 | 新（效果图原文） |
| `1 problem found after you confirmed` / `<N> problems found after you confirmed` | 回执首行、推送正文 | 新 |
| `Review requested`、`Due <HH:MM>` | 审查方会话里的卡片 | 新 |
| `Orbit composed this card and authorised its buttons. Anything an agent wrote is shown in a box that names who wrote it.` | 确认卡的署名提示 | 新 |
| `Recommended`、`Other — say it in my own words` | needsYou 作答块 | 沿用（提问卡） |
| `Reopen task` 及其确认对话框 | 回执 | 沿用（`TaskReopenCopy`） |
| `Confirmed done`、`Waiting for your confirmation`、`Not recorded: this card is out of date` | 回执、计数后的行、拒绝提示 | 沿用 |

---

## 附录 A　本文替 owner 做的决定（可以推翻）

下面每一条都已写成具体规则。owner 不同意哪一条，在确认卡上用 Send back 写明，改完再确认。

1. **Automatic 关着的项目没有审查方**（S2）。另一种做法是照样由协调会话审，但那样就违背了 2026-09-22 定的开关边界。
2. **owner 自己建的任务没有审查方，项目内外都一样；项目外不是在会话里建的任务也没有审查方**（S2）。
3. **审查方读过、空闲下来、又没有唤醒源，就提前结束审查**（T5）。项目里的窗口默认两小时，不提前结束的话，忘了调工具的审查会让卡片白等两小时。
4. **投递被拒即终局**，不重投，也不改投给后来的协调会话（D4）。
5. **有 needsYou 时必须逐条作答**，旧客户端会被 409 拒绝（Q3）。
6. **答案送到审查方，并写成任务评论**（Q5）。
7. **退回的边界**：每份请求一次；owner 两次决定之间最多 3 次；Automatic 关着或在暂停期间不能退回（B5）。
8. **owner 确认之后发现的问题会推送**，正文只有 Orbit 的话；只是后到的 REVIEW 不推送（L5）。
9. **窗口在请求那一刻冻结**，并且从请求时起算，不从投递时起算（N4）。
10. **效果图说明里写的 expectReply 改为平台投递**（§2.1）。

## 附录 B　修订记录

| 版本 | 日期 | 内容 |
|---|---|---|
| 初稿 | 2026-10-02 | 按任务 `34Z35urx0kEB2qZaLeikc` 的 1–11 条写成 |
