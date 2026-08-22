# Project Coordinator 有界 Session attempt 与自然轮换 v1.0

实现单元 `[K3]`，迁移 `0133_task_session_attempt`。

规范来源是 `docs/project-coordinator-convergence-contract.md`（下称「收敛契约」，v1.1）的 §1、§8 与
TH2/TH3/TH5。收敛契约回答「**还能做多少次**」；`[K2]` 回答「那些计数存在哪里」；本文件回答剩下的那一件：

> **一次尝试是什么，它什么时候必须停，以及停下来之后谁有权做什么。**

## 0. 为什么

`[K1]` 把上限写成了确定表，`[K2]` 把计数写进了表。但事故里那几百轮**从来没有跨过任何一条 attempt 线**，
因为它根本不是几百次 attempt——它是**一条 Session 被 steer 了几百次**。

一条永远不结束的 Session 是所有预算的公共盲区：

- 它不增加 `attemptsOnRevision`，所以硬上限用不完；
- 它不产生新的失败指纹行，所以 `sameFingerprintRepeats` 不动；
- 它一直在忙，所以每一个活性检查都是绿的；
- 而它的上下文会被压缩，压缩掉的正是「我们已经试过这个了」的证据——于是它在同一条 Session 里把同一个
  错重新发明一遍。

所以 `[K3]` 的第一句话不是预算，是**身份**：

- **AT1**：一次 **attempt** 恰好是 **一个 Task 的一个 scopeRevision 下的一条 Session**。三者是同一件
  事的三个名字（收敛契约 §1 的 `attemptGeneration` 行）。
- **AT2**：向一条已经存在的 Session 发消息（steer）**不是**一次新 attempt，不分配新的
  `attemptGeneration`，不重置任何计数（TH3），并且它自己是有上限的。
- **AT3**：一次新 attempt 必须是**一条新 Session**，且必须带一个**新的 hypothesis**。同一个假设在同一个
  scopeRevision 上不会被试第二次——除非上一次是被 `TRANSIENT` 打断的（§3 CL2 已经把「一直偶发」限到
  `maxTransientRetries` 次）。

RL4 仍然成立：本单元不新增业务实体。`task_attempt` 是 Task 与 Session 之间的一张从属表，业务层看到的
仍然只有 Project 和 Task。

## 1. 六个维度，一个报告

`AttemptBudget` 的六个维度（收敛契约 §8 的第二张表），与它们各自的度量来源：

| 维度 | 预算字段 | 花费从哪读 | 越线时 |
| --- | --- | --- | --- |
| `CONTEXT` | `maxContextPercent` | `session.context_tokens / session.context_window` | `WIND_DOWN` |
| `WALL_CLOCK` | `maxWallClockMs` | `now - coalesce(session.started_at, attempt.created_at)` | `WIND_DOWN` |
| `TURNS` | `maxTurns` | `session.num_turns` | `WIND_DOWN` |
| `TOOL_CALLS` | `maxToolCalls` | `count(tool_call)` | `WIND_DOWN` |
| `COST` | `maxCostMicros` | `round(session.cost_usd * 1e6)` | `WIND_DOWN` |
| `COORDINATOR_STEERS` | `maxCoordinatorSteers` | `attempt.coordinator_steers` | 拒绝下一次 steer |

- **BD1**：判定顺序是**固定的**，就是上表自上而下，理由与 TH1 相同——同时越过两条线时报告的维度必须是
  确定的一个，否则回放会得到两种答案。
- **BD2**：顺序不是随手排的。`CONTEXT` 在最前，因为它是唯一一个**越线后就没法照 TH2 收口**的维度：上下文
  用尽的 attempt 已经写不出可信的 checkpoint 了。默认 80% 留下的那 20% 不是余量，是收口本身要花的预算。
  其后是 `WALL_CLOCK`（占着 Runner 槽位的那一维），再是三个纯花费维度。`COORDINATOR_STEERS` 在最后，
  因为它约束的是**协调者**而不是 Worker：它越线不该让一个正在收尾的 Worker 停下来。
- **BD3**：每一维读作四态之一，`UNMEASURED` 是其中之一且不可省。`context_window` 没被 Runner 上报时
  这一维**既不算越线也不算无限**——把没量到的东西当 0 会让 attempt 一开工就被判越线，当无限则是悄悄
  把熔断关掉。其余五维照常有界，所以 `UNMEASURED` 不会让 attempt 变成无界。

| 读数 | 含义 |
| --- | --- |
| `WITHIN` | 有上限，未越线，`remaining` 是一个非负数 |
| `EXHAUSTED` | 有上限，已越线（`spent >= limit`），`remaining` 为 0 |
| `UNBOUNDED` | 上限是 `null`，且带着 §1 OW4 的 USER 签名 |
| `UNMEASURED` | 这一维这次量不到（只有 `CONTEXT` 会出现） |

- **BD4**：`remaining` 是**读得出来的**，不是算出来才知道的（项目 AC10 与本任务 AC1）。
  `GET /projects/:id/tasks/:taskId/attempts` 返回当前 attempt 的六维读数与历史 attempt。
- **BD5**：预算在 attempt **开工时冻结**并存进 `task_attempt.budget`，之后一律按这份冻结值判定。
  中途改 Project 的策略预算既不能把一个正在跑的 attempt 判死，也不能把一个已经判死的救活——那是把结果
  改写成另一个结果，正是 TH2 禁止的那件事。改预算的合法效果在 §4。

## 2. 自然收口

- **NC1**：越线**不是失败**（TH2）。越线只做一件事：把 attempt 从 `OPEN` 推到 `WINDING_DOWN`，并记下
  是哪一维越的线（`exhausted_dimension`）。它不改 Session 的 `run_status`，不发 cancel，不发 end。
- **NC2**：收口由 **Worker** 做，写下一个真实结局：

  | `outcome` | 何时 |
  | --- | --- |
  | `SUCCEEDED` | 做完了，且有一个 `ACCEPTED` checkpoint |
  | `FAILED` | 试过了，没成 |
  | `INTERRUPTED` | 被打断（含 Runner 崩溃、超时被收割） |
  | `BLOCKED` | 被 §3 的 `ENVIRONMENT` / `HUMAN_REQUIRED` 挡住 |

  `CANCELLED` **不在这张表里**，而且不是靠约定不在——`task_attempt_outcome_chk` 让它根本存不进去。
  「不得用 cancel/complete 覆写成 CANCELLED」于是不是一句提醒，是一个写不出来的语句。
- **NC3**：收口时的 checkpoint 要求，逐条可测：
  - `SUCCEEDED` 必须带 `ACCEPTED` checkpoint（`ATTEMPT_CHECKPOINT_REQUIRED`）。一次拿不出东西的成功
    不是成功。
  - 被要求收口的 attempt（`wind_down_requested_at` 非空）必须带一个 checkpoint（两种皆可），或者写下
    `no_checkpoint_reason` 说明为什么没有。**崩溃就是没有**——`[K3]` 要的是这件事被写下来，不是被
    编出来。
  - 其余情况可以没有。
- **NC4**：`outcome` 一旦写下就不可改（`ATTEMPT_OUTCOME_IMMUTABLE`）。一个已经收口的 attempt 是一条
  历史，不是一个可以再谈的结论。
- **NC5**：checkpoint 在本单元里只是 `(sha, kind, evidence_digest)` 三个字段。`ACCEPTED`/`WIP_RED`
  的完整表与 §7 的合并门是 `[K6]`；本单元记的是指针，`ACCEPTED` 的那个同时写回 `task.known_good_sha`。

## 3. 谁不能做什么

收敛契约 §1 的权限表说的是「谁能改任务要什么」。本单元补上另一半：**谁能决定一次尝试的结局**。

| 动作 | USER | Worker（这条 Session 自己） | 另一条 Agent Session（含 Coordinator） |
| --- | --- | --- | --- |
| `end` / `complete` / `cancel` 这条 Session | `ALLOWED` | `ALLOWED` | `ATTEMPT_OUTCOME_IS_THE_WORKERS` |
| 向这条 Session steer | `ALLOWED` | `ALLOWED` | 预算内 `ALLOWED`，之后 `ATTEMPT_STEER_BUDGET_EXHAUSTED` |
| 向 `WINDING_DOWN` 的 attempt steer | `ALLOWED` | `ALLOWED` | `ATTEMPT_WINDING_DOWN` |
| 开一次新 attempt | `ALLOWED` | 不适用 | `ALLOWED`，但要新 hypothesis |

- **AU1**：用户那一列全是 `ALLOWED`，这是刻意的（项目 instructions：登录用户保留最终控制权）。本单元约束
  的是**自主循环**，不是人。
- **AU2**：`ATTEMPT_OUTCOME_IS_THE_WORKERS` 拦的正是事故里最贵的那个动作：协调者看到一条不顺眼的运行，
  就 `session complete` 把它收掉。那不是收口，那是**用一个没有结局的结局盖住真实结局**——被盖掉的
  Session 落成 `CANCELLED`，于是「这次到底失败在哪」这个问题从此没有答案，下一轮只好从头再试一遍。
- **AU3**：steer 的上限存在，是因为「继续」这个动作不产生 attempt、不产生指纹、不产生进展，却能无限地
  产生活动。`maxCoordinatorSteers` 用完之后唯一合法的下一步是 §4 的新 generation。
- **AU4**：`[K1]` 的 `resolveAttemptBudget` 只接受正整数覆盖值，所以 `maxCoordinatorSteers` 的下界是 1，
  「一次都不许 steer」不能用 0 表达。这是本单元接受的一处棱角：真要禁掉，用 `WINDING_DOWN` 与
  `CLOSED` 两条既有拒绝，而不是去改一个已经冻结的解析函数的语义。

## 4. 新 attempt 的门禁

`openAttempt` 就是把 §1..§3 合起来的那一个方法。它按顺序做：

1. `ConvergenceLedgerService.record(ATTEMPT_STARTED)`——**generation 是它分配的**，不是本单元自己加一。
   这样账本与 `task.attempt_generation` 不会各说各话（`[K2]` §4 的顺序，以及 `recover()` 的一致性检查）。
2. 用它给出的 generation 插入 `task_attempt` 行，冻结预算（BD5），带上继承来的证据（§5）。

门禁，每一条都由数据库再拦一次：

| 拒绝码 | 拦什么 |
| --- | --- |
| `ATTEMPT_ALREADY_OPEN` | 一个 Task 同时有两个未收口的 attempt |
| `ATTEMPT_GENERATION_IN_USE` | 同一 (task, revision, generation) 被开第二次（本任务 AC4） |
| `ATTEMPT_HYPOTHESIS_UNCHANGED` | 新 attempt 的 hypothesis 与上一次相同，且上一次不是 `TRANSIENT` 收口 |
| `ATTEMPT_SESSION_IN_USE` | 一条 Session 被登记成第二个 attempt（AT1/AT3 的机械形式） |

- **GN1**：`attemptKey` 由调用方给，且必须是**这次派发自己的持久身份**（例如派发动作的幂等键），不是
  `randomUUID()`。这条与 `[K2]` §3 是同一条规则，理由也一样：崩溃后重放要能读回自己那一行而不是再开
  一次。同 key 的第二次调用返回已提交的那一行，什么都不写。
- **GN2**：`ATTEMPT_HYPOTHESIS_UNCHANGED` 的 `TRANSIENT` 豁免不是漏洞：§3 CL1/CL2 已经让连续
  `TRANSIENT` 在 `maxTransientRetries` 次后被强制重新归类为 `IN_SCOPE_DEFECT`，于是这条豁免自己是有界的。
- **GN3**：**人工延长预算不撤销已经发生的收口**（TH5）。改大 Project 的 `attempt_budget` 之后，那个
  `WINDING_DOWN` 的 attempt 仍然是 `WINDING_DOWN`（BD5：它按冻结值判定），延长的合法效果是收敛契约 §2
  SM4 的 `BUDGET_EXTENDED` 边——它把任务放回 `CONVERGING`，于是**下一个** generation 拿到新预算。
  一个已经越线的 attempt 被「加了预算」就当没越过，是把结果改写成另一个结果。

## 5. fresh generation 继承什么

`buildAttemptSeed` 的返回值是一个**封闭记录**，字段就这六个，多一个都没有：

| 字段 | 为什么在里面 |
| --- | --- |
| `taskId` | 是同一件工作 |
| `scopeRevision` / `scopeHash` | 是同一个问题（§5 FP3：换了 scope 就是新问题） |
| `attemptGeneration` | 是第几次 |
| `hypothesis` | 这次打算换个什么打法——AT3 要求它是新的 |
| `inheritedKnownGoodSha` | 已知良好点。不用从零开始，也不用重新发现它 |
| `previousOutcome` | 上一次的真实结局与越线维度。「已经试过什么」是有界的一句话 |

- **SD1**：**上一条 Session 的 transcript 不在里面**，`runtime_session_id` 也不在里面。fresh generation
  是一条新 Session，不是旧 Session 的 `--resume`；`task_attempt.session_id` 上的 UNIQUE 是这句话的机械
  形式（本任务 AC3：继承 Task/scope/known-good，但不继承无界上下文）。
- **SD2**：种子是封闭记录而不是一段拼好的 prompt，是为了「它有没有变成无界」这个问题可以被**测试**而
  不是被目测：字段集合本身有断言，加一个 `previousTranscript` 会让测试变红。
- **SD3**：继承证据**不**继承预算花费。新 attempt 的六维从零开始——这正是 §8 那两个绝对计数
  （`attemptsOnRevision`、`verificationRounds`）永不清零的原因：**单次**尝试的预算重来，**整个
  revision** 的预算不重来，两个上限同时生效，先到者先停（TH6）。

## 6. 崩溃之后

| 情形 | 事实是什么 | 谁来收 |
| --- | --- | --- |
| Runner 崩溃 | attempt 还是 `OPEN`，Session 落到 `FAILED`/`INTERRUPTED` | `reconcileAbandoned` 按真实 Session 状态收口成 `INTERRUPTED`，`no_checkpoint_reason` 写明「Runner 崩溃，没有 checkpoint」 |
| Coordinator 在 `openAttempt` 提交前崩溃 | 事务整体回滚，什么都没发生 | 重放用同一个 `attemptKey` 再开一次 |
| Coordinator 在提交后崩溃 | 行已经在了 | 重放用同一个 `attemptKey` 读回它（GN1），不会开出第二个 generation |
| 超时 | `WALL_CLOCK` 越线 | NC1 请求收口；Worker 照 NC3 收口 |

- **CR1**：`reconcileAbandoned` 只对**已经终态**的 Session 动手，且只写 `INTERRUPTED`。它不猜结局：一个
  还在跑的 attempt 不会被它收掉，一个崩掉的 attempt 也不会被它写成 `FAILED`——那是在替 Worker 下结论。
- **CR2**：它写下的 `no_checkpoint_reason` 是 NC3 的「没有就说没有」。把崩溃收成一个假的 checkpoint，
  下一个 generation 就会从一个不存在的已知良好点继续。

## 7. `[K4]..[K9]` 还欠的

- 控制环**没有接**：没有任何 reconciler 周期性调用 `evaluate()`。谁在什么节奏上量六维是 `[K4]`/`[K7]`。
- `progressVector` 由调用方传入。从证据推导它是 `[K4]`。
- checkpoint 只有指针（NC5）。`ACCEPTED`/`WIP_RED` 表与 §7 合并门是 `[K6]`。
- `evaluate()` 越线时只写 attempt 行；把它变成一条 `project_blocker` 与一次 `CIRCUIT_TRIPPED` 判断是
  `[K7]`。
- Web/CLI 只有 `GET .../attempts` 这一个读面，界面是 `[K8]`。
