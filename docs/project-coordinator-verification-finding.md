# 结构化验证 finding 与自动任务分流

实现单元 `[K5]`。本文件描述 `docs/project-coordinator-convergence-contract.md`（下称「收敛契约」）§6
落地成什么，以及 §3 的六类失败各自如何变成**恰好一个**产物。

代码对照：
- `src/apiserver/src/projects/verification-finding.ts` —— 纯函数：形状校验、去重键、分流。
- `src/apiserver/src/projects/verification-finding.service.ts` —— 唯一写入口，一个事务。
- `src/apiserver/src/tasks/verification-liveness.ts` —— `[H0V2]` 残留：哪些 epoch gate 不会自愈。
- `src/apiserver/prisma/migrations/0141_task_verification_finding/` —— 数据库这一半。

## 0. 为什么需要它

收敛契约 §1 的 OW1/OW2 禁止两件事：验证者改被验证任务的 scope，Worker 自批新增验收项。**在 K5 之前，
这两条禁令没有替代路径**——一个验证 Session 发现问题时，能做的动作只有「改 subject」和「继续 steer
Worker」，两条都被禁，于是它要么绕过禁令，要么什么都不做。§0 事故里「验证 X」变成「AutoRetry + 部署 +
锁序」，中间没有任何一行审计说问题换了，正是这个形状。

finding 是那条合法路径：它是一条**关于** subject 的断言，本身不改动 subject 的任何一列；§3 的表把这条
断言变成恰好一件工作。

## 1. 形状（§6）

验证 Session 能写出的全部字段，一个不多一个不少：

| 字段 | 约束 | 拒绝码 |
| --- | --- | --- |
| `severity` | `P0`/`P1`/`P2`/`P3` | `UNKNOWN_SEVERITY` |
| `violatedInvariant` | 非空 | `EMPTY_VIOLATED_INVARIANT` |
| `minimalRepro` | 非空，可重放 | `EMPTY_MINIMAL_REPRO` |
| `failureFingerprint` | §5 的 sha256（64 位小写 hex） | `MALFORMED_FINGERPRINT` |
| `scopeClassification` | §3 六类之一 | `UNKNOWN_CLASSIFICATION` |
| `evidence` | 非空 JSON 对象，**id 一律 Base62** | `EMPTY_EVIDENCE` / `EVIDENCE_NOT_PUBLIC_ID` |
| `verdict` | `FAIL` / `INCONCLUSIVE` | `UNKNOWN_VERDICT` |

`PASS` **不在** verdict 里，不是遗漏：通过的检查没有可报的东西，§3 也没有一行把它变成工作。

另有两个**寻址**字段（不属于 §6 的形状，见 FD4）：`scopeRevision` 与 `reporter`。

**谁能定（§3 最后一列）**，`FINDING_REPORTERS`：

| 分类 | USER | COORDINATOR | WORKER | VERIFIER |
| --- | --- | --- | --- | --- |
| `TRANSIENT` | ✔ | ✔ | ✘ | ✘ |
| `IN_SCOPE_DEFECT` | ✔ | ✔ | ✘ | ✔ |
| `PREREQUISITE` | ✔ | ✔ | ✘ | ✔ |
| `SCOPE_EXPANSION` | ✔ | ✔ | ✔ | ✔ |
| `ENVIRONMENT` | ✔ | ✔ | ✘ | ✘ |
| `HUMAN_REQUIRED` | ✔ | ✔ | ✔ | ✔ |

关键的是 `TRANSIENT` 与 `ENVIRONMENT` 两行：这两类由**系统证据**判定，任何 Agent 都不得自诊。
「刚才是抖动」和「环境坏了」是两句零成本、且**都不消耗 attempt 预算**（CL1）的自我判词——能写它们的
Agent 可以永远重试而永不熔断。这正是 §0 事故换个说法。

`HUMAN_REQUIRED` 对所有人开放：「我需要人」是唯一一句让claimant**付出**代价（工作停下）而不是换来
好处的断言。

## 2. 身份（FD1）与恰好一次

去重键四项，一项不多：

```
pc:v1:{projectId}:finding:{subjectTaskId}:{scopeRevision}:{failureFingerprint}
```

**刻意不在里面**：reporter、验证 Task、Session、attemptGeneration、时钟。其中任何一项进了键，同一个缺陷
被第二个检查报出来、或重启后被同一个检查重报，就会拿到不同的键、建出第二个子 Task——那正是本单元被验收
的性质。

第二把键 `effectIdempotencyKey = sha256(dedupKey)`，同时写进新建 Task 的 `idempotency_key`。它挡的是第一把
键看不见的情形：事务在**建完 Task、写 finding 之前**回滚，去重行根本不存在，重放必须落到同一个 Task 上。

两把唯一索引都在数据库里（`task_verification_finding_dedup_key`、`..._effect_key`），因此绕过服务的写入者
同样挡得住。

**指纹只有一个（FP1）**：`failureFingerprint` 由报告方给出，写进 finding 行；`[K2]` 的判定行必须记录
**同一个值**，因此 `ConvergenceObservation.authoritativeFingerprint` 把它原样带过去，而不是让 ledger 再
从 `FailureFacts` 哈希一遍。两处不一致的代价不是审计难看，而是 §8 的重复行**永远不成立**：
`chargeFinding` 拿 finding 的指纹去比 `lastFingerprint`，后者读的是 ledger 那一列，两个值构造上就不可能
相等，`sameFingerprintRepeats` 于是恒为 0。该字段缺省时 ledger 仍按原样自行哈希（`[K2]` 的既有调用方一个
字不用改），传入时必须是 64 位小写 hex，否则 `record` 在读任何东西之前就拒绝——一个谁都比不上的身份，
落库之后没有补救。

## 3. 分流（FD2）

一条 finding 恰好产生 §3 表里那一个结果。判定顺序即判断本身：

1. **CL2**：`transientRetries` 用尽的 `TRANSIENT` 被**改写**为 `IN_SCOPE_DEFECT`（`overrideReason =
   TRANSIENT_BUDGET_EXHAUSTED`），从此改花 attempt 预算。
2. §3 的表给出该类的唯一结果。
3. **CL3**：`SCOPE_EXPANSION` 恒为 `FREEZE_AND_REQUEST_REPLAN`，与剩余预算无关。
4. **FD3'（本单元新增）**：上一轮已经产生过返修，而本条 finding 的 severity **没有严格下降** ⇒
   `FREEZE_AND_REQUEST_REPLAN`（`REPAIR_WITHOUT_SEVERITY_DROP`）。这就是「一次 verificationRound 后的
   返修仍失败则默认 NEEDS_REPLAN」，也是 FD3 那句「返修不下降就是不收敛」的直接落地。
   衡量的是 severity 而不是重复次数：同一个指纹再来一次会被 FD1 挡在门外，能走到这里的是**另一个**失败，
   而分辨「在收敛」与「在打转」的正是它是否变轻。
5. **FD3 / §8 熔断**：把本条 finding 记账后跑 `detectNonConvergence`，跳闸即 `FREEZE_AND_REQUEST_REPLAN`，
   `overrideReason` 记 `VERIFICATION_ROUNDS_EXHAUSTED` 或 `CIRCUIT_TRIPPED`。

3~5 都落在 `FREEZE_AND_REQUEST_REPLAN`，只有 `overrideReason` 不同——这不是冗余：理由会写进重规划任务，
而「这件事变大了」把人送去的地方，和「同一个返修不再起作用」完全不同。

`ENVIRONMENT` 与 `HUMAN_REQUIRED` **永远**不被熔断改写（CL1）：它们不花任何预算，用别人的预算冻结它们，
等于把一行人能处理的 blocker 换成一句「预算用尽」。

### 产物

| 结果 | 产物 | 位置 / 边 | owner |
| --- | --- | --- | --- |
| `RETRY_WITHIN_BUDGET` | 无 | —— | `COORDINATOR` |
| `CREATE_DEFECT_SUBTASK` | 缺陷 Task | subject 的**子任务** | `COORDINATOR` |
| `CREATE_PREREQUISITE_TASK` | 前置 Task | subject 的**兄弟**，且 subject `dependsOn` 它 | `COORDINATOR` |
| `FREEZE_AND_REQUEST_REPLAN` | 重规划 Task | subject 的**兄弟**，**无依赖边**，无 assignee | `USER` |
| `RAISE_SYSTEM_BLOCKER` | `ENVIRONMENT_BROKEN` 行 | §11 条件，TASK 主体 | `SYSTEM` |
| `RAISE_USER_BLOCKER` | `HUMAN_DECISION_REQUIRED` 行 | §11 条件，TASK 主体 | `USER` |

三条边各自是该分类含义的图形表达：

- 缺陷是**子任务**，因为工作在 subject 范围**内**；subject 若是 `ALL_CHILDREN_DONE` /
  `VERIFICATION_PASSED`，缺陷未关它就无法再次完成，这是「先修再过」的机械半边。
- 前置是**兄弟 + 依赖边**：§3 说它是「本任务范围外、但本任务需要」的工作——所以不是子任务，也不是仅仅
  相邻。
- 重规划**没有边**，缺席即是本意：OW3 禁止 Coordinator 铸新 scopeRevision，所以这一行是一个**请求**，
  给冻住的 subject 连上依赖等于替人回答了正在问的那个问题。

**两类 blocker 不在 finding 的事务里插行**，只把将要开的 kind 原子记在 finding 上。§11.4 每趟从世界重算
条件，因此从 finding **推导**出来的 blocker 自带退出：task 收敛或 scopeRevision 前进后它自然消失。直接
插入的行会比它断言的事实活得更久——那正是 `[H1]` 回头去过滤的 obsolete blocker 形状。

## 4. FD4：过期结论

finding 携带被验证任务的 `scopeRevision`，与当前不一致直接拒 `STALE_SCOPE_REVISION`，且**先于**任何字段
校验——对一个没人再问的问题给出的答案，不该被告知去修它的其它字段。

数据库两道：复合外键 `(task_id, scope_revision, scope_hash)` 证明这个版本**存在过**；
`task_verification_finding_fence` 触发器证明它**就是此刻这一版**。

## 5. 审计：finding → Task / decision

每一条 finding 与 `[K2]` 的一条判决同事务落库，并记 `decision_id`。因此对任意一件被自动建出来的工作，
都能回答：

- 它因为**哪条 finding** 存在（`effect_task_id` 反查）；
- 那条 finding 被**如何分流**（`outcome` / `effective_classification` / `override_reason`）；
- 分流时**账本是什么状态**（`decision_id` → `task_convergence_decision.counters` / `input_hash`）；
- **谁**该做下一步、做什么、什么时候再看（`owner` / `required_action` / `next_check_at`）。

`next_check_at` 在 `owner = USER` 时必须为空（数据库 CHECK）：等人决定的等待没有时钟。

finding 表只增不改（`task_verification_finding_immutable_guard`）。

## 6. `[H0V2]` 残留：DONE 却没有结论的检查

独立复验在 13200 个快照里找到 20 格：`VERIFICATION_PASSED` 的 roll-up，子任务已收敛，最新存活检查
`status = DONE` 且 `verdict IS NULL`。四面封死且**无人被告知**——无聚合写、无 AG7 缺口、无 §13.2 条件行，
只剩每 60 秒一条 WARN。这是**活性**缺陷不是安全缺陷（下游一律 BLOCKED），所以任何「有没有放错东西过去」
的测试都看不见它。

三处修复，同一条规则（`verificationLiveness`）：

1. **`gapReason`**：新增 `VERIFICATION_CANNOT_CONCLUDE`——当**每一个**未通过的检查都已 DONE 且无 verdict
   时开缺口。只要还有一个活检查，它仍是普通等待。对应新 blocker kind `VERIFICATION_CANNOT_CONCLUDE`
   （`USER` / `HUMAN`）。**不自动补检查**：旧的 DONE 检查仍计入 epoch，自动补只会每趟多一个检查，且每个
   都可能同样收场。
2. **`computeDependencyState`**：`verificationGateStalled` 为真时给 `BLOCKED_FAILED` 而非 `BLOCKED`。
   哪些 gate 「不会自愈」由事实决定而非仅由 gate 值决定：`RUN_NOT_SETTLED` 在还有活 run 时是普通等待，
   在 run 被人 complete 掉之后不是。
3. **原子性**：迁移 0141 的 `task_verification_verdict_atomic` 触发器 + `TasksService.updateTask` 的拒绝，
   使一个检查**无法到达** `DONE` 而不带 verdict。两种合法写法都保留（一条 UPDATE 同时写，或先 verdict 后
   status）；**已经**是这个形状的历史行仍可改名、改父、取消——把存量坏数据变成没人能清理的行，比要堵的
   楔子更糟。

| gate | 会自愈？ | 判定 |
| --- | --- | --- |
| `VERIFICATION_IN_FLIGHT` | 是 | 等 run 结束 |
| `VERDICT_NOT_APPLIED` | 是 | 等下一趟 pass |
| `SUBJECT_NOT_DONE` | 是 | 等工作重新完成 |
| `RUN_NOT_SETTLED` + 有活 run | 是 | 等 run 结束 |
| `RUN_NOT_SETTLED` + 无活 run | **否** | `NO_RUN`，USER |
| `VERDICT_ABSENT` | **否** | `CONCLUDED_NOTHING`，USER |
| `VERDICT_UNREVISIONED` | **否** | `UNREVISIONED_VERDICT`，USER |
| `VERIFICATION_FAILED` / `_INCONCLUSIVE` / `NO_LIVE_VERIFICATION` | **否** | 既有升级，措辞统一 |

聚合侧另加一条对称保护：**聚合不得完成一个没有结论的检查**。§13.2 V1 给检查两个载体（终态 + 结构化结果），
聚合只能提供前者；写 DONE 会铸出 0141 拒绝的形状，而且是由唯一一个背后没有人的写入者铸出来的。反向
（AG3 重开）仍允许——那个方向不宣称任何结论。

## 7. 与相邻单元的边界

- **不另造** verifier filing、episode 或依赖满足逻辑：blocker 走 §11.4 的条件重算，判决走 `[K2]` 的账本，
  计数走 `[K4]` 的 `advanceCounters`，epoch 门仍是 `[H0G]` 的那一个。
- `[H0]` 的 FAIL-verdict 缺陷子任务路径（`project-verification-verdict.service`）未被改动：它按 verdict
  归档，K5 按**分类**归档，两者的键不同（verdict revision vs finding 指纹），互不重复建。
- 一个 finding 从不算作进展（RL0），也从不让任何计数回退（RL3）。

## 8. 混合版本

`world.protocol.findings` 只在 0141 已应用的数据库上被打上；未打上时读作「这份快照早于 finding 驱动的
blocker」而**不是**「当时没有 finding」。捕获快照时用 `to_regclass` 探测——一个比自己的数据库领先一个迁移
的二进制必须给出它那个世界支持的答案，而不是让整趟 reconcile 挂在 42P01 上。
