# Project Coordinator 有界收敛契约 v1.1

冻结单元 `[K1]`。本文件是 `[K1]..[K9]` 的规范来源，由
`src/apiserver/src/projects/convergence-contract.spec.ts` 逐表核对代码，任何一处不一致都会变红。

它扩展 `docs/project-coordinator-contract.md`（下称「主契约」）而不取代它：主契约回答「这一刻该做什么」，
本契约回答「**还能做多少次**」。两者相交的地方以本契约为准的只有一处——主契约 §9.4 的重试与预算是按
Project 计的，本契约把同一件事按 **Task 的一次 scope revision** 再算一遍，两个上限同时生效，先到者先停。

## 0. 为什么需要它

事故形状（`[E]` 系列，2026-08）：一个任务在**同一个失败指纹**上被自动重试了数百轮，每一轮都产生了动作
（新 Session、新提交、新的 steer），因此每一个既有的活性检查都是绿的——控制环从来没有「静默空转」，
它一直在忙。忙不是进展。中途 scope 从「修一个 bug」扩张到「AutoRetry + 部署 + 锁序」，没有任何一次扩张
被记为一次决定；重启把计数清零，于是预算永远用不完。

本契约把自主推进从「持续产生动作」改成「**有界地逼近验收，否则明确重规划**」：

- **RL0**：进展的定义是「向验收严格改善」，不是「Agent 在活动」。产生动作、开新 Session、写新提交、
  烧掉 token，都不刷新 `lastProgressAt`。
- **RL1**：每一个可以循环的形状都有一个**有限**上限，且上限是纯函数可判定的。
- **RL2**：上限用尽的结果是一个**明确的下一步**（新任务 / blocker / 等人），不是继续 retry，也不是
  静默放弃。
- **RL3**：跨重启、跨接管、重复投递的事件都不得让计数回退。计数是提交过的事实，不是进程内存。
- **RL4**：本契约不新增业务实体。业务层仍然只有 Project 和 Task；revision、attempt、decision、
  finding、checkpoint 都是内部字段与账本。

## 1. 概念与所有权

| 概念 | 归属 | 含义 | 谁可以推进它 |
| --- | --- | --- | --- |
| `scopeRevision` | Task | 这个任务「要做什么」的第几版。冻结 title/description/acceptanceCriteria 的摘要 | 用户；或被用户策略授权的 Coordinator |
| `attemptGeneration` | Task | 在当前 scopeRevision 下的第几次尝试。一次 attempt 恰好对应一条 Session | Coordinator |
| `progressState` | Task | 见 §2 的状态表 | Coordinator（纯函数推导） |
| `progressVector` | Task | 见 §4。向验收的距离，可比较 | 由证据推导，无人手写 |
| `failureFingerprint` | Attempt | 见 §5。归一化后的失败身份 | 由失败事实推导 |
| `checkpoint` | Task | 见 §7。ACCEPTED 或 WIP_RED 的提交证据 | Worker 提交，Coordinator 采纳 |
| `finding` | Verification | 见 §6。验证者唯一的输出形状 | 验证 Session |

所有权规则，逐条可测：

- **OW1**：验证者（`verifiesTaskId` 非空的 Task 的 Session）**不得**修改被验证任务的 scope。它只能
  提交 finding。
- **OW2**：Worker（执行 Session）**不得**自批新增验收项。它可以请求扩张，请求本身是一条 finding，
  分类为 `SCOPE_EXPANSION`。
- **OW3**：Coordinator 在 `GUARDED_AUTO` 下**不得**创建新的 scopeRevision。它只能冻结当前 attempt
  并升级为需要人工的重规划。
- **OW4**：只有用户可以把任何上限设为无限。无限值必须带上授权者，否则视为默认值。

这四条不是约定，是一张 (actor × 动作) 的确定表（`SCOPE_AUTHORITY` / `authorizeScopeAction`）。
`ALLOWED` 以外的每一格都是一个拒绝码，没有第三种答案：

| 动作 | USER | COORDINATOR | WORKER | VERIFIER |
| --- | --- | --- | --- | --- |
| `REVISE_SCOPE` | `ALLOWED` | `REPLAN_REQUIRES_AUTHORIZATION` | `SCOPE_CHANGE_REQUIRES_USER` | `SCOPE_CHANGE_REQUIRES_USER` |
| `ADD_ACCEPTANCE_CRITERION` | `ALLOWED` | `ACCEPTANCE_CHANGE_REQUIRES_USER` | `ACCEPTANCE_CHANGE_REQUIRES_USER` | `ACCEPTANCE_CHANGE_REQUIRES_USER` |
| `REQUEST_SCOPE_EXPANSION` | `ALLOWED` | `ALLOWED` | `ALLOWED` | `ALLOWED` |
| `REPORT_FINDING` | `ALLOWED` | `ALLOWED` | `ALLOWED` | `ALLOWED` |
| `AUTHORIZE_UNBOUNDED` | `ALLOWED` | `UNBOUNDED_REQUIRES_USER` | `UNBOUNDED_REQUIRES_USER` | `UNBOUNDED_REQUIRES_USER` |

- **OW5**：上表是 `GUARDED_AUTO`（默认）与 `MANUAL` 下的答案。`AUTO` 只打开一格——
  `COORDINATOR` × `REVISE_SCOPE`——因为那正是用户预先签下的那一件事。`ADD_ACCEPTANCE_CRITERION`
  与 `AUTHORIZE_UNBOUNDED` 在任何策略下都不对 Agent 开放：前者让循环自己改考卷，后者让它自己拆熔断，
  这两条一旦开放，「有界」就不再是可验算的性质。
- **OW6**：每一方都可以说「这件事比这个任务大」——那是 `REQUEST_SCOPE_EXPANSION`，按 §3 恰好产生
  一个结果（冻结并请求重规划）。谁都不能自己执行自己的这个请求。报告问题与悄悄改写成功标准之间的
  区别，就是这一条。

## 2. Task 进展状态机

状态（`TaskProgressState`）：

| 状态 | 含义 | 是否可自动派发 | 是否终态 |
| --- | --- | --- | --- |
| `CONVERGING` | 有预算、且上一次有严格进展或还没试过 | 是 | 否 |
| `RETRYING_TRANSIENT` | 上一次失败被归类为 TRANSIENT，重试预算未尽 | 是 | 否 |
| `VERIFYING` | 已交付，等待验证结论 | 否 | 否 |
| `NEEDS_REPLAN` | 熔断已跳闸：本 scopeRevision 上不再自动尝试 | 否 | 否 |
| `BLOCKED` | 由 SYSTEM/COORDINATOR 可解的结构化 blocker 挡住 | 否 | 否 |
| `AWAITING_HUMAN` | 需要人做决定 | 否 | 否 |
| `SETTLED` | 任务已 DONE/CANCELLED/被取代 | 否 | 是 |

事件（`ConvergenceEvent`）与迁移表。**同一 (状态, 事件) 只有一个结果**；表里没有的组合是
`NO_TRANSITION`（保持原状态，且必须被记为一次「无进展的决定」）。

| 起始状态 | 事件 | 目标状态 |
| --- | --- | --- |
| `CONVERGING` | `ATTEMPT_STARTED` | `CONVERGING` |
| `CONVERGING` | `ATTEMPT_DELIVERED` | `VERIFYING` |
| `CONVERGING` | `ATTEMPT_FAILED_TRANSIENT` | `RETRYING_TRANSIENT` |
| `CONVERGING` | `ATTEMPT_FAILED_IN_SCOPE` | `CONVERGING` |
| `CONVERGING` | `PREREQUISITE_FOUND` | `BLOCKED` |
| `CONVERGING` | `ENVIRONMENT_FAILURE` | `BLOCKED` |
| `CONVERGING` | `HUMAN_REQUIRED` | `AWAITING_HUMAN` |
| `CONVERGING` | `SCOPE_EXPANSION_REQUESTED` | `NEEDS_REPLAN` |
| `CONVERGING` | `CIRCUIT_TRIPPED` | `NEEDS_REPLAN` |
| `CONVERGING` | `TASK_TERMINAL` | `SETTLED` |
| `RETRYING_TRANSIENT` | `ATTEMPT_STARTED` | `CONVERGING` |
| `RETRYING_TRANSIENT` | `ATTEMPT_FAILED_TRANSIENT` | `RETRYING_TRANSIENT` |
| `RETRYING_TRANSIENT` | `ATTEMPT_FAILED_IN_SCOPE` | `CONVERGING` |
| `RETRYING_TRANSIENT` | `ENVIRONMENT_FAILURE` | `BLOCKED` |
| `RETRYING_TRANSIENT` | `HUMAN_REQUIRED` | `AWAITING_HUMAN` |
| `RETRYING_TRANSIENT` | `CIRCUIT_TRIPPED` | `NEEDS_REPLAN` |
| `RETRYING_TRANSIENT` | `TASK_TERMINAL` | `SETTLED` |
| `VERIFYING` | `VERIFICATION_PASSED` | `SETTLED` |
| `VERIFYING` | `VERIFICATION_FAILED_IN_SCOPE` | `CONVERGING` |
| `VERIFYING` | `SCOPE_EXPANSION_REQUESTED` | `NEEDS_REPLAN` |
| `VERIFYING` | `PREREQUISITE_FOUND` | `BLOCKED` |
| `VERIFYING` | `ENVIRONMENT_FAILURE` | `BLOCKED` |
| `VERIFYING` | `HUMAN_REQUIRED` | `AWAITING_HUMAN` |
| `VERIFYING` | `CIRCUIT_TRIPPED` | `NEEDS_REPLAN` |
| `VERIFYING` | `TASK_TERMINAL` | `SETTLED` |
| `NEEDS_REPLAN` | `REPLAN_AUTHORIZED` | `CONVERGING` |
| `NEEDS_REPLAN` | `BUDGET_EXTENDED` | `CONVERGING` |
| `NEEDS_REPLAN` | `HUMAN_REQUIRED` | `AWAITING_HUMAN` |
| `NEEDS_REPLAN` | `TASK_TERMINAL` | `SETTLED` |
| `BLOCKED` | `BLOCKER_CLEARED` | `CONVERGING` |
| `BLOCKED` | `HUMAN_REQUIRED` | `AWAITING_HUMAN` |
| `BLOCKED` | `CIRCUIT_TRIPPED` | `NEEDS_REPLAN` |
| `BLOCKED` | `TASK_TERMINAL` | `SETTLED` |
| `AWAITING_HUMAN` | `REPLAN_AUTHORIZED` | `CONVERGING` |
| `AWAITING_HUMAN` | `BUDGET_EXTENDED` | `CONVERGING` |
| `AWAITING_HUMAN` | `BLOCKER_CLEARED` | `CONVERGING` |
| `AWAITING_HUMAN` | `TASK_TERMINAL` | `SETTLED` |

不变量：

- **SM1**：`SETTLED` 没有任何出边。终态就是终态；重开一个任务是新任务或新 scopeRevision。
- **SM2**：`ATTEMPT_STARTED` 只从 `CONVERGING` / `RETRYING_TRANSIENT` 出发。任何其它状态下的派发是
  越权，由 §8 的门禁拒绝。
- **SM3**：`CIRCUIT_TRIPPED` 从每一个非终态都可达，且只落到 `NEEDS_REPLAN`。熔断永远不是终态——它
  是「等一个决定」。
- **SM4**：从 `NEEDS_REPLAN` 出来的唯一三条边都需要一次**显式授权**（重规划、加预算、判定为人工）。
  没有任何一条边由时间、重启或重复事件驱动。

## 3. 失败分类

一次失败恰好属于一类（`ConvergenceClassification`），每一类恰好有一个合法结果：

| 分类 | 含义 | 唯一合法结果 | 计入 | 谁能定 |
| --- | --- | --- | --- | --- |
| `TRANSIENT` | 与被做的事无关的偶发失败（网络、限流、Runner 掉线） | `RETRY_WITHIN_BUDGET` | `transientRetries` | 系统证据 |
| `IN_SCOPE_DEFECT` | 就是这个任务该修的缺陷 | `CREATE_DEFECT_SUBTASK` | `attemptsWithoutProgress` | 验证者 |
| `PREREQUISITE` | 缺一件本任务范围外的前置工作 | `CREATE_PREREQUISITE_TASK` | `attemptsWithoutProgress` | 验证者 |
| `SCOPE_EXPANSION` | 要做的事比这个任务大 | `FREEZE_AND_REQUEST_REPLAN` | `scopeExpansionRequests` | 验证者 / Worker |
| `ENVIRONMENT` | 环境/配置坏了，改代码不解决 | `RAISE_SYSTEM_BLOCKER` | 不计入 | 系统证据 |
| `HUMAN_REQUIRED` | 需要人的判断或权限 | `RAISE_USER_BLOCKER` | 不计入 | 任何一方 |

- **CL1**：`ENVIRONMENT` 与 `HUMAN_REQUIRED` 不消耗 attempt 预算——因为再试一次也不会改变结果，
  让它们消耗预算等于用错误的理由熔断。它们改为消耗 blocker 的升级时钟（主契约 §11.5）。
- **CL2**：`TRANSIENT` 的重试预算是**独立的**，而且比 attempt 预算小。一个被反复归类为 TRANSIENT
  的失败在 `maxTransientRetries` 次后强制**重新归类**为 `IN_SCOPE_DEFECT`，因为「一直偶发」就是
  必然。这是 §0 事故里最贵的一条。
- **CL3**：`SCOPE_EXPANSION` 永远不产生「继续做」的动作，无论预算还剩多少。

## 4. 进展向量

`ProgressVector` 的**全部**字段：

| 字段 | 类型 | 方向 |
| --- | --- | --- |
| `scopeHash` | string | 相等才可比 |
| `acceptanceClosed` | int | 越大越好 |
| `acceptanceTotal` | int | 参照 |
| `openP0` | int | 越小越好 |
| `openP1` | int | 越小越好 |
| `regressions` | int | 越小越好 |
| `openBlockers` | int | 越小越好 |
| `knownGoodSha` | string 或 null | null → 非 null 是进展；非 null → 另一个非 null 不是 |

- **PV1**：这张表是穷举的。Session 数、turn 数、token 数、工具调用次数、墙钟时间、提交数、
  改动行数——一个都不在里面，也一个都不得被加进来。Agent 活跃不是进展（RL0）。
- **PV2**：`strictlyImproves(a, b)` 为真，当且仅当 `a.scopeHash === b.scopeHash`、**没有任何一个
  维度变差**、且**至少一个维度变好**。
- **PV3**：`scopeHash` 不同 → 不可比 → 不是进展。换了目标不算逼近目标。
- **PV4**：只有 `strictlyImproves` 为真时才刷新 `lastProgressAt` 并把 §8 的四个「自上次进展以来」
  计数清零：`attemptsWithoutProgress`、`sameFingerprintRepeats`、`decisionsWithoutProgress`、
  `transientRetries`。绝对计数（`attemptsOnRevision`、`verificationRounds`、
  `scopeExpansionRequests`）永不清零。
- **PV5**：进展本身是**有限**的。表里每个数值维度都单调走向一个边界（`acceptanceClosed` 至多到
  `acceptanceTotal`，其余三个至少到 0），`knownGoodSha` 只在第一次出现时算一次。因此一个
  scopeRevision 上严格进展的次数至多是
  `acceptanceTotal + openP0₀ + openP1₀ + regressions₀ + openBlockers₀ + 1`。
  换 checkpoint 不算进展，就是为了堵住这里唯一一个可以无限刷的维度——事故里「又推了一个提交」
  正是这个形状。

## 5. 失败指纹

`failureFingerprint(facts)` = sha256(canonicalJson) over exactly：

| 字段 | 说明 |
| --- | --- |
| `stage` | `DISPATCH` / `RUN` / `VERIFY` / `MERGE` / `ACCEPTANCE` |
| `violatedInvariant` | 稳定的不变量代号，缺失时为空串 |
| `subjectKind` | `TASK` / `SESSION` / `PROJECT` / `BRANCH` |
| `scopeHash` | 当前 scope revision 的摘要 |
| `normalizedMessage` | 见下 |

归一化（`normalizeFailureText`）按顺序做，且只做这些：

| 步 | 规则 | 替换为 |
| --- | --- | --- |
| 1 | ISO 8601 时间戳 | `<ts>` |
| 2 | UUID | `<id>` |
| 3 | 40/64 位十六进制 | `<sha>` |
| 4 | 绝对路径 | `<path>/` + basename |
| 5 | `:行:列` 位置 | `:<pos>` |
| 6 | 十进制/十六进制数字 | `<n>` |
| 7 | 连续空白 | 单个空格 |
| 8 | 首尾空白、大小写 | trim + lowercase |

- **FP1**：只有数字、id、时间戳、路径前缀不同的两条错误必须得到同一个指纹。
- **FP2**：`violatedInvariant` 不同的两次失败必须得到不同的指纹，即使文本归一化后相同。
- **FP3**：指纹是 scope 内的身份——`scopeHash` 变了指纹就变了，因为「同一个错」在新目标下是新问题。

## 6. 验证 finding

验证 Session 唯一允许写出的形状：

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `severity` | 是 | `P0` / `P1` / `P2` / `P3` |
| `violatedInvariant` | 是 | 非空 |
| `minimalRepro` | 是 | 非空；一条能重放的命令或步骤 |
| `failureFingerprint` | 是 | §5 |
| `scopeClassification` | 是 | §3 的六类之一 |
| `evidence` | 是 | Base62 拼写的 JSON |
| `verdict` | 是 | `FAIL` / `INCONCLUSIVE` |

- **FD1**：finding 的去重键是
  `pc:v1:{projectId}:finding:{subjectTaskId}:{scopeRevision}:{failureFingerprint}`。
  同一个键重复提交不再建第二个 Task。
- **FD2**：一次 finding 恰好产生 §3 表里那一个结果，不多不少。
- **FD3**：`verificationRounds` 在被验证任务上按 scopeRevision 累计。超过
  `maxVerificationRounds` 后，即使分类是 `IN_SCOPE_DEFECT`，结果也改为
  `FREEZE_AND_REQUEST_REPLAN`——返修不下降就是不收敛。
- **FD4**：验证者提交的 finding 里带上被验证任务的 `scopeRevision`；与当前不一致的 finding 是
  过期结论，拒绝（`STALE_SCOPE_REVISION`），不得据以建任务。

## 7. Checkpoint 与合并门

| 种类 | 含义 | 可否成为后续任务的基线 | 可否进入依赖分支/main |
| --- | --- | --- | --- |
| `ACCEPTED` | 有测试证据、已被采纳的已知良好点 | 是 | 是 |
| `WIP_RED` | 已知红的实验，仅为不丢工作而保存 | 否 | 否 |

- **CP1**：`ACCEPTED` checkpoint 不可变。改一个字段等于新建一个 checkpoint。
- **CP2**：`WIP_RED` 必须以可跨 Runner 重建的 artifact 记录（commit + tree + base + artifactRef），
  不得只依赖某台机器上的 stash。
- **CP3**：合并门在下列任一情况下给出**有类型的拒绝**，不做 fallback：

| 拒绝码 | 条件 |
| --- | --- |
| `NO_CHECKPOINT` | 没有可采纳的 checkpoint |
| `CHECKPOINT_NOT_ACCEPTED` | 指向的 checkpoint 是 `WIP_RED` |
| `SCOPE_REVISION_MISMATCH` | checkpoint 的 scopeRevision 不是任务当前的 |
| `BRANCH_TIP_MISMATCH` | 分支 tip 不是 checkpoint 的 commit |
| `TEST_EVIDENCE_MISMATCH` | 证据摘要与 checkpoint 记录的不一致 |

- **CP4**：合并回执按 checkpoint 幂等；重复投递的同一回执只生效一次。

## 8. 默认熔断策略

`GUARDED_AUTO` 的默认阈值。每一个都是**有限**的；`null` 表示无限，只有带一个 `actor` 为 `USER` 的
`unboundedAuthorizedBy` 签名时才被接受（OW4 与 §1 的 `AUTHORIZE_UNBOUNDED` 一行）。Agent 自己写下的
授权不是一个较弱的授权，而根本不是授权。

| 阈值 | 默认值 | 计数对象 | 触发后的 reason |
| --- | --- | --- | --- |
| `maxAttemptsWithoutProgress` | 5 | 自上次严格进展以来的 attempt | `ATTEMPT_BUDGET_EXHAUSTED` |
| `maxAttemptsPerScopeRevision` | 24 | Task × scopeRevision，永不清零 | `HARD_ATTEMPT_CAP_REACHED` |
| `maxSameFingerprintRepeats` | 2 | 连续相同指纹 | `SAME_FAILURE_REPEATED` |
| `maxDecisionsWithoutProgress` | 6 | 连续无严格进展的决定 | `NO_PROGRESS` |
| `maxVerificationRounds` | 2 | Task × scopeRevision，永不清零 | `VERIFICATION_ROUNDS_EXHAUSTED` |
| `maxTransientRetries` | 3 | 连续 TRANSIENT | `TRANSIENT_RETRY_BUDGET_EXHAUSTED` |
| `maxScopeExpansionRequests` | 0 | scope 扩张请求，永不清零 | `SCOPE_EXPANSION_REQUIRED` |

单次 attempt 的资源预算（`AttemptBudget`），达限即**自然结束**当前 attempt：

| 维度 | 默认值 |
| --- | --- |
| `maxTurns` | 60 |
| `maxWallClockMs` | 3600000 |
| `maxToolCalls` | 1200 |
| `maxCostMicros` | 20000000 |
| `maxContextPercent` | 80 |
| `maxCoordinatorSteers` | 3 |

后两个维度由 `[K3]` 补入（v1.1），它们本来就写在 TH2 与 TH3 的散文里，只是没有进这张表——而一个不在
表里的上限，按 RL1 的说法根本不是上限。`maxContextPercent` 是**百分比而不是 token 数**：token 数是模型的
属性、不是任务的属性，写死一个绝对值对小窗口模型过严、对大窗口模型等于没写。默认 80 留出的 20% 不是余量，
是 TH2 要求的那次收口本身要花的**上下文预算**——一个把上下文用尽的 attempt 已经写不出可信的 checkpoint 了。
`contextWindow` 未被 Runner 上报时这一维读作 `UNMEASURED`：既不算越线，也不算无限，其余五维照常有界。

`[K3]` 的实现细则（attempt 与 Session 的对应、六维余量、自然收口、fresh generation 的门禁）在
`docs/project-coordinator-attempt-budget.md`，本表是它的规范来源。

- **TH1**：熔断原因的判定顺序是固定的，与计数器的读取顺序无关：
  `SCOPE_EXPANSION_REQUIRED` → `SAME_FAILURE_REPEATED` → `VERIFICATION_ROUNDS_EXHAUSTED` →
  `TRANSIENT_RETRY_BUDGET_EXHAUSTED` → `ATTEMPT_BUDGET_EXHAUSTED` → `HARD_ATTEMPT_CAP_REACHED` →
  `NO_PROGRESS`。同时越过两条线时，报告的原因必须是确定的一个，否则回放会得到两种答案。
- **TH2**：达到资源预算**不是**失败。当前 attempt 以真实结局收口（`SUCCEEDED` / `FAILED` /
  `INTERRUPTED` / `BLOCKED`）并写下 checkpoint；不得用 cancel/complete 覆写成 `CANCELLED`。
- **TH3**：预算用尽后 Coordinator 只能以**新的 hypothesis** 开一条新 Session（新的
  attemptGeneration）。向同一条 Session 继续 steer 不是一次新 attempt，也不重置任何计数。
- **TH4**：计数只从提交过的账本读。重启、接管、重复投递的事件都不得使任何计数下降（RL3）。
- **TH6（有界性定理）**：一个 scopeRevision 上的 attempt 总数不超过
  `(P + 1) × (maxAttemptsWithoutProgress + 1)`，其中 `P` 是 PV5 给出的进展次数上界；且无论如何
  不超过 `maxAttemptsPerScopeRevision`。两个上界都是有限的，且都只由提交过的事实决定，
  所以「有限步内进入合法下一状态」是可以逐条验算的，而不是一句承诺。
- **TH5**：`Run Now` 不绕过熔断。它产生的是一次显式授权的 decision（`REPLAN_AUTHORIZED` 或
  `BUDGET_EXTENDED`），并被记为人做的决定。

## 9. 派发门禁

在主契约 §7.4 的前置条件之后，再加两条，任一不满足即拒绝派发：

| 拒绝码 | 条件 |
| --- | --- |
| `TASK_NEEDS_REPLAN` | `progressState` 是 `NEEDS_REPLAN` |
| `TASK_CONVERGENCE_BUDGET_EXHAUSTED` | §8 的任一阈值已越线，但状态尚未落盘 |

- **GT1**：这两条是**终态**答案：不排队、不退避、不安排唤醒。清除它们的唯一途径是 §2 SM4 的三条
  显式授权边。
- **GT2**：门禁在纯函数里判定，输入完全来自快照，因此可以被回放逐字节复现。
