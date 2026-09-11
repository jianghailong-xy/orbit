# Watch 领域与产品语义契约（ADR，v1）

**状态**：任务「P0：冻结 Watch 领域与产品语义契约」的产物，是项目「Orbit 原生 Watch：跨 Session / Task 持久监控」
其余实现、客户端与验收任务的接口来源。任何领域对象、谓词、状态、时限或拒绝码的改动，都必须先改
[`contracts/watch.contract.json`](../contracts/watch.contract.json)：`src/shared/src/watchContract.spec.ts`
读同一份文件，本文与它不一致时会变红。

**基线**：`origin/main` = `88239c791f704faad01bf8c8a6144f85539c973a`（2026-09-11 15:15 +02:00）。
开工时确认 0 ahead / 0 behind。

**权威来源**

| 来源 | 位置 |
| --- | --- |
| 机器可读契约与全部边界向量 | `contracts/watch.contract.json` |
| 契约测试 | `src/shared/src/watchContract.spec.ts` |
| Session 运行态与生命周期 | `src/shared/src/enums.ts`（`deriveSessionRunState` / `deriveSessionLifecycleState`）、[`session-lifecycle-design.md`](./session-lifecycle-design.md) |
| 「turn settled」的既有定义 | `src/apiserver/src/common/session-scheduling.ts` `UNSETTLED_SESSION_STATUSES` |
| Task 完成语义 | [`task-completion-criteria.md`](./task-completion-criteria.md) |
| 依赖闸 | `src/apiserver/src/tasks/task-dependencies.ts`、[`task-dependency-revision.md`](./task-dependency-revision.md) |
| 唤醒载体 | `model ConversationTurn`（`src/apiserver/prisma/schema.prisma`）、`RunnerApiController.dequeueTurn` |
| 事件面 | `src/shared/src/realtime.ts`、`0133_session_event_source_update_scope`、[`realtime-control-plane-stream.md`](./realtime-control-plane-stream.md) |

**本任务不做**：不建表、不写迁移、不加 API、不做 UI、不实现 evaluator。本文只冻结语义；
`watchContract.spec.ts` 只校验契约自身的一致性与覆盖，**不求值任何谓词**——求值是 P1 的事，它要对着这些向量写。

**开工前先确认**：仓库里此前**不存在** Watch 领域概念。`schema.prisma` 66 个模型里唯一的
`watch` 命中是 2866 行的散文（"A foreman is not a resident process watching the list"），
`src/shared` 里的命中全是注释与测试夹具字符串。**watchdog 是另一回事**（executable runtime 的
存活通道），不要复用它的名字或表。

---

## 0. 一页结论

1. **数据库是事实源，实时事件只是加速器。** 谓词只读各 leaf 声明的列；丢掉全部提示只改变延迟，
   不改变结论（§8）。
2. **Match 是事实，Delivery 是效果。** 条件成立记一行不可变 Match；通知或唤醒是可重试的交付，
   两者分开持久化（§1）。
3. **`AWAITING_INPUT` 是「turn settled」，不是 Task 完成，也不是终态。** 三个概念各有 leaf，
   互不蕴含（§2.2）。
4. **目标集合在创建时快照。** 动态集合（Task List / Project 的实时成员）v1 不做，只能作为
   快照来源展开一次（§4）。
5. **one-shot 是默认。** continuous 必须带 debounce 与预算（§5）。
6. **TTL 必填且有上限；到期也要交付。** 等在 Watch 上的会话不会被静默遗忘（§5）。
7. **唤醒复用 ConversationTurn 的唯一键。** `clientTurnId = watch:<watchId>:<generation>`，
   重复交付塌缩成同一个 turn，而不是第二次唤醒（§6）。
8. **权限在交付时复核，不只在创建时。** 撤销后不投递载荷，状态进 `REVOKED` 而不是悄悄停掉（§7）。
9. **停不下来的 Watch 必须可见。** 目标全没了是 `UNRESOLVABLE`，不是沉默（§3）。

---

## 1. 领域模型

五个对象，边界就是它们各自回答的问题。

| 对象 | 回答 | 可变性 |
| --- | --- | --- |
| `ResourceRef` | 盯的是哪个东西 | 值对象 |
| `Watch` | 谁在盯、盯什么条件、成立了做什么、盯到什么时候 | 可暂停/取消/编辑 |
| `WatchTarget` | 快照里的一个目标，以及它当前被观察到的状态 | 随求值前进 |
| `WatchMatch` | 条件在某一刻成立过 | **不可变** |
| `WatchDelivery` | 那次成立所触发的动作，做成了没有 | 可重试 |

**`ResourceRef`** = `{ kind, id }`，`kind ∈ SESSION | TASK | TASK_LIST | PROJECT`。
其中**可作为观察目标的只有 `SESSION` 与 `TASK`**；`TASK_LIST` / `PROJECT` 只能作为快照来源
（§4）。

**`Watch`** 持有：`ownerId`、`observer`（`{ kind: USER | SESSION, id }`）、`predicate`
（§2）、`mode`（§5）、`action`（§6）、`expiresAt`、`state`（§3）、`generation`、
`nextEvaluateAt`、`idempotencyKey`。

**`WatchTarget`** 每个快照目标一行，持有 `resourceRef`、`state`（`OBSERVED | SATISFIED | GONE`）、
`targetEpoch`（快照时观察到的目标世代）、`lastEvaluatedAt`。

**`WatchMatch`** 持有 `generation`、`matchedAt`、`reason`、`perTargetSnapshot`、`predicateVersion`，
唯一约束 `(watchId, generation)`。**它是关于世界的一句陈述，不是一次通知**——所以重复交付、
重启、重连都不会让它变成两个事实。

**`WatchDelivery`** 持有 `matchId`、`action`、`state`（§3）、`attempts`、
`(leaseOwner, leaseGeneration)`、`lastError`。

---

## 2. 谓词：版本化 typed predicate

### 2.1 文法

```
Predicate :=
  | { kind: 'ALL' | 'ANY', over: 'ALL_TARGETS', leaf: <leaf> }
  | { kind: 'ALL_OF' | 'ANY_OF', operands: Predicate[] }
```

`predicateVersion: 1`。**封闭集合：没有 shell、没有 SQL、没有日志正则、没有自由表达式。**
嵌套深度 ≤ 2，每个复合 ≤ 4 个操作数，每个 Watch ≤ 200 个目标。谓词只允许读它的 leaf 在
`sourceColumns` 里声明的列——这既是安全边界，也是 P1 建索引的依据。

不认识的 `kind` → `UNKNOWN_PREDICATE_KIND`；版本对不上 → `PREDICATE_VERSION_UNSUPPORTED`。
两者都在创建时拒绝，不留到求值。

### 2.2 leaf 与三组刻意的非等价

| leaf | 目标 | 定义 | 权威 |
| --- | --- | --- | --- |
| `SESSION_TURN_SETTLED` | SESSION | `session.status ∉ (PENDING, RUNNING)` | `UNSETTLED_SESSION_STATUSES` |
| `SESSION_RUN_TERMINAL` | SESSION | `deriveSessionRunState ∈ (SUCCEEDED, FAILED, ENDED)` | `enums.ts` |
| `SESSION_LIFECYCLE_TERMINAL` | SESSION | `deriveSessionLifecycleState ∈ (COMPLETED, TRASH)` | `enums.ts` |
| `SESSION_NEEDS_ATTENTION` | SESSION | 该会话存在 `PENDING` 的 Approval 行 | `push.service.ts` `needsYouSessions` |
| `TASK_TERMINAL` | TASK | `task.status ∈ (DONE, CANCELLED, FAILED)` | `TaskStatus` |
| `TASK_FAILED` | TASK | `task.status = FAILED` | `TaskStatus` |
| `TASK_DONE` | TASK | `task.status = DONE` | `task-completion-criteria.md` |

**这三组不等价是本契约存在的主要理由，必须逐条落到测试上：**

- **settled ≠ terminal。** `AWAITING_INPUT` 与裸 `INTERRUPTED` 都已经离开 `PENDING/RUNNING`，
  所以 turn 已 settled；但会话仍然活着、仍可调度，**不是终态**。
  `session_create(wait)` 用的就是 settled 这条线（`session-scheduling.ts` 的注释把它写成
  "result ready"），Watch 沿用同一条，免得两处对「完成了吗」给出不同答案。
- **run terminal ≠ lifecycle terminal。** `Succeeded · Open` 是正常状态：运行结果与列表归属正交。
- **以上全部 ≠ Task 完成。** `DONE` 是「声明的完成判据被满足」的投影，不是任何人直接写的字段，
  更不是「会话跑完了」。会话 `SUCCEEDED` 而 Task 仍 `OPEN` 是完全合法的一刻。

反过来，`SESSION_NEEDS_ATTENTION` 与 settled 也彼此独立：一个卡在审批上的会话正在问人问题，
它的 turn 还没 settled。

### 2.3 all / any

`ALL` / `ANY` 都作用在**整个快照集合**上（v1 只有 `ALL_TARGETS` 一种选择器）。

`ALL` 作用在空集上是**恒真**，会让 Watch 当场触发——所以空目标集在创建时就被
`EMPTY_TARGET_SET` 拒掉，而不是让它静静地立刻成立。leaf 的 `targetKind` 与目标 kind 不符
（例如拿 `TASK_TERMINAL` 去看一个 SESSION）→ `TARGET_KIND_MISMATCH`。

Agent 最常要的那句话——「等这 7 个 Task 全部终态，或任一失败就叫我」——是：

```json
{ "kind": "ANY_OF", "operands": [
  { "kind": "ALL", "over": "ALL_TARGETS", "leaf": "TASK_TERMINAL" },
  { "kind": "ANY", "over": "ALL_TARGETS", "leaf": "TASK_FAILED" } ] }
```

---

## 3. 状态机

**Watch**（初始 `ACTIVE`）

| 从 | 到 | 触发 |
| --- | --- | --- |
| `ACTIVE` | `PAUSED` | 观察者暂停 |
| `PAUSED` | `ACTIVE` | 观察者恢复 |
| `ACTIVE` | `MATCHED` | 条件成立且 `mode = ONE_SHOT`；Match 在同一事务里写入 |
| `ACTIVE` / `PAUSED` | `EXPIRED` | `now >= expiresAt`；**暂停不延长 TTL** |
| `ACTIVE` / `PAUSED` | `CANCELLED` | 观察者或 owner 取消 |
| `ACTIVE` | `REVOKED` | 求值或交付时权限复核失败 |
| `ACTIVE` | `UNRESOLVABLE` | 目标全部 `GONE`，条件永远无法判定 |

终态：`MATCHED / EXPIRED / CANCELLED / REVOKED / UNRESOLVABLE`。continuous 的 Watch 触发后留在
`ACTIVE` 并把 `generation` 加一。

`REVOKED` 与 `UNRESOLVABLE` 单列，是因为**「盯不下去了」必须说出来**。悄悄停掉是这个项目要设计掉的
失败模式，不是可接受的省事做法。

**WatchTarget**：`OBSERVED → SATISFIED`（leaf 成立）、`→ GONE`（目标行被删）。continuous 允许
`SATISFIED → OBSERVED`（条件又不成立了）。

**WatchDelivery**：`PENDING → IN_FLIGHT →`（`DELIVERED` | 回到 `PENDING` 重试 | `DEAD_LETTER`）。
`IN_FLIGHT` 由 `(leaseOwner, leaseGeneration)` 围栏；租约过期由别的 worker 接管。
`maxDeliveryAttempts = 8` 之后进 `DEAD_LETTER`，**死信必须在界面上可见**。

---

## 4. 目标集合：创建时快照

目标集合在创建时确定并冻结，每个目标一行 `WatchTarget`。`TASK_LIST` / `PROJECT` 可以作为
**快照来源**展开一次并记录来源，展开之后 Watch 与那个列表再无关系。把它们当作实时成员资格使用 →
`DYNAMIC_SET_UNSUPPORTED`。

**为什么 v1 不做动态集合**：成员资格语义还没被封存。「Task List 在 Match 之后新增了一个 Task」
既可以说成条件不再成立，也可以说成那次成立依然是事实；在有人明确定义它之前，任何实现都是在替
产品做一个它没做过的决定。快照没有这个歧义。

**目标消失**：目标行被删 → 该 target 记为 `GONE` 并**移出集合**，不当作已满足。`ALL` 因此仍可
完成。集合被删空 → Watch 进 `UNRESOLVABLE`。

**目标世代**：`WatchTarget.targetEpoch` 记录快照时观察到的世代。Task 被重开后世代前进，
但**已经写下的 Match 不会被改写**——它是关于它所观察到的那个世代的事实。

---

## 5. one-shot / continuous / TTL

`mode = ONE_SHOT`（默认）：首次成立写一个 Match，Watch 进 `MATCHED` 终态。
`(watchId, generation)` 唯一约束让「第二次成立」不可能产生第二个 Match，而不是不太可能。

`mode = CONTINUOUS`：每次成立把 `generation` 加一。必须带 debounce（默认 10 秒窗口合并）与
交付预算，否则一个高频变化的目标就是一场唤醒风暴。

**创建即求值**：创建时条件已经成立，就立刻产生一个 `generation = 1` 的 Match，而不是等下一次变化。
否则「等这些 Task 全部结束」在它们已经结束时会永远等下去。

**TTL**：`expiresAt` 必填，范围 `[60s, 30d]`，默认 24h，超出 → `TTL_OUT_OF_RANGE`。
**到期同样要交付**：一个 `RESUME_SESSION` 的 Watch 到期而没有成立，也要给观察者一个带
`EXPIRED` 的 turn。否则等在它上面的会话就永远等下去了——这正是这个项目要消灭的东西。

---

## 6. 触发动作与交付

每个 Watch 恰好一个动作。

**`NOTIFY_USER`**：一条用户可见通知，走既有的 needs-you 角标口径，不另造一套计数。

**`RESUME_SESSION`**：通过**正常队列入口**给观察者会话入队**恰好一个** `ConversationTurn`：

- `clientTurnId = watch:<watchId>:<generation>`。`conversation_turn` 上有
  `UNIQUE (session_id, client_turn_id)`，所以重投的 Match 会塌缩到已经入队的那个 turn 上，
  而不是第二次唤醒。这与 `TASK_RUN_TRIGGER` 给 `sched:` / `dep:` / `first-run:` / `batch:`
  用的是同一个机制，**不要新造一套幂等**。
- `sendIntent = NEXT_TURN`。唤醒是新工作，不是插进正在跑的那个 turn。用 `CURRENT_WORK` 会在
  没有在飞的 message turn 时被 `CURRENT_WORK_UNAVAILABLE` 拒绝——而「观察者正停着」恰恰是最常见的情况。
- **运行中的观察者不需要特例**：`statusAfterTurnEnqueued` 让 `RUNNING` 保持 `RUNNING`、
  让 `AWAITING_INPUT`/`INTERRUPTED` 变 `PENDING`，turn 排在正在跑的那个后面。Watch 因为从不
  绕过队列，所以**结构上不可能并发恢复一个运行中的会话**。
- 载荷是结构化的：`watchId`、`generation`、`reason`、`changedTargets`、`latestSnapshot`。
  **不许把轮询日志或 shell 文本塞回上下文。**

---

## 7. 权限

创建时观察者必须能读到**每一个**目标，否则 `PERMISSION_DENIED`。

**关键规则：权限在交付时再复核一次。** 创建与成立之间可能隔很久，期间访问可能被撤销；
复核失败 → `REVOKED`，**不投递任何载荷**。只在创建时检查等于允许用一个旧 Watch 去读现在读不到的状态。

**自唤醒保护**：`RESUME_SESSION` 的 Watch 把自己的观察者会话列为目标 → `SELF_WATCH_LOOP`。
一个能唤醒自己的会话是一个没有上界的唤醒环。

---

## 8. 事实源：数据库；实时事件不是事实源

**求值只读各 leaf `sourceColumns` 声明的数据库列，在求值事务内读。** 存活性由
`nextEvaluateAt` 加上带租约的周期对账保证。**丢掉全部实时提示只改变延迟，不改变任何结论。**

仓库里有**两套**事件系统，名字有重叠，不要混：

| | 控制面实时流 | `project_event` 外发箱 |
| --- | --- | --- |
| 载体 | 进程内 RxJS hub + SSE | 触发器写的持久行 |
| 持久化 | **从不持久化** | 是 |
| 投递 | at-most-once，无 ack 无重试 | 行在，可消费 |
| 顺序 | **不保证**（`streamForUser` 用 `mergeMap` 套异步映射） | — |
| 重放 | **没有游标，没有 Last-Event-ID** | — |
| 重启 | 在途的全丢，hub 就是进程内存 | 存活 |

控制面已知的丢弃路径都是明写的：`pg_notify` 失败只 warn 不重试；载荷超过
`MAX_NOTIFY_BYTES` 会降级成 seq 信号，而合成的控制面事件带 `seq: 0` 且**从不落库**，于是那条
回退路径没有行可读；会话摘要中途解析不出来就丢。外发箱那边，重复信号会
`ON CONFLICT … occurrences + 1` **塌缩成一行带计数**，消费者不能假设一次出现一行。

**还有一个覆盖缺口，直接打在本契约的 leaf 上。** `0133_session_event_source_update_scope`
的 Session 触发器只在这三列上触发：

```sql
AFTER UPDATE OF "status", "deleted_at", "merge_status" ON "session"
```

`completed_at` **不在其中**——把一个会话移入 Completed 不产生任何持久事件；Approval 更是另一张表。
也就是说 `SESSION_LIFECYCLE_TERMINAL` 与 `SESSION_NEEDS_ATTENTION` 这两个 leaf **根本没有持久事件覆盖**：
对它们来说周期对账不是兜底，而是承重结构。契约测试把这三列钉死，哪天触发器加列，
这句话就必须被重新审视，而不是悄悄变成假的。

**因此：Match 绝不能从事件载荷的内容推导出来。** 事件只用来把一次求值提前安排。

---

## 9. 边界：Watch 与它的三个邻居

### 9.1 与 TaskDependency

**不同的问题。** TaskDependency 回答「这个 Task 现在可以开跑吗」，是派发时的准入控制；
Watch 回答「这件事成立时告诉我」，是任意主体的观察关系。

差别不止在措辞上，语义是反的：依赖闸里，**`CANCELLED` 和 `FAILED` 的前置都不满足边**，
它们算 `BLOCKED_FAILED`——需要人介入，不是「结束了所以放行」；只有 `DONE`（沿
`SUPERSEDED` 链走到链尾）才满足。而 Watch 的 `TASK_TERMINAL` **刻意包含** `DONE / CANCELLED / FAILED`，
因为「盯着的这批活儿有结论了」本来就该把失败和取消算进去。

`dependencyState` 是 `NONE | READY | BLOCKED | BLOCKED_FAILED`，`canRun` 只认 `NONE` 与 `READY`。
**Watch 不得成为第五个 dependencyState，也不得成为派发闸的输入。**
依赖闸在应用层、候选 SQL 和数据库约束触发器三处各有一份（提交边界那道由
`session_dispatch_dependency_check` 把守）——再加一条旁路正是这套设计在防的事。

### 9.2 与 Background Process

**不同的东西。** Background process 是 runner 上一个真实的操作系统进程：注册表在
**runner 进程内存里，没有数据库表**（持久记录是 `run_event` 里的 `background_task` 行），
按设计**能熬过 engine 被回收**，但**熬不过 runner 重启或会话结束**。

Watch 是控制面的一行，没有进程，**熬得过客户端关闭、协调会话不运行、runner 与 apiserver 重启**。

产品上这条线必须看得见：今天界面把它说成
`Background process running` / `N background processes running`
（`src/web/src/components/WorkspaceView.tsx`、
`src/macos/OrbitKit/Sources/OrbitKit/App/SessionLine.swift`）。
**Watch 不得复用这套文案、托盘或图标**，要有自己的 Following/Watching 呈现。
真正的长时 shell 与 dev server 继续属于 Background Processes。

### 9.3 与 Needs You

**不同的方向。** Needs You 是**系统在问用户**（有 `PENDING` 审批要人回答），口径是
`needsYouSessions(ownerId)`，驱动角标。Watch 是**用户或 Agent 在问系统**。

`SESSION_NEEDS_ATTENTION` 这个 leaf 让一个 Watch 可以**观察**「那边需要人了」，
但它**不改变** Needs You 的口径，也不往角标里加数。一个待交付的 Watch 不是一次待办审批。

---

## 10. 边界测试向量

全部 25 条以机器可读形式存于 `contracts/watch.contract.json` 的 `vectors`，
`watchContract.spec.ts` 保证每条都有 `given` / `expect` / `why`、id 唯一、
引用的拒绝码与状态都是本契约声明过的，且**每个 leaf 至少被一条向量覆盖**。

| # | id | 钉住的是 |
| --- | --- | --- |
| 1 | `awaiting-input-is-settled-not-terminal` | settled ≠ terminal |
| 2 | `awaiting-input-is-not-task-done` | **`AWAITING_INPUT` ≠ Task 完成** |
| 3 | `interrupted-bare-is-settled-not-terminal` | 裸 INTERRUPTED 仍然活着 |
| 4 | `interrupted-with-end-reason-is-terminal` | 有 endReason 就是会话结束了 |
| 5 | `succeeded-run-is-not-lifecycle-terminal` | `Succeeded · Open` 是正常态 |
| 6 | `succeeded-session-does-not-imply-task-done` | DONE 是判据的投影 |
| 7 | `cancelled-task-is-terminal-not-failed` | terminal 与 failed 是两个问题 |
| 8 | `all-terminal-or-any-failed` | 七个 Task 全终态或任一失败 |
| 9 | `all-over-empty-set-refused` | 空集恒真在创建时被拒 |
| 10 | `kind-mismatch-refused` | leaf 与目标 kind 必须相符 |
| 11 | `needs-attention-is-independent-of-settled` | 两个轴互不蕴含 |
| 12 | `completed-session-emits-no-outbox-row` | **Completed 没有持久事件，靠对账** |
| 13 | `already-true-at-create-matches-immediately` | 创建即求值 |
| 14 | `one-shot-second-crossing-produces-no-second-match` | 唯一键保证只有一次 |
| 15 | `duplicate-and-out-of-order-hints-produce-one-match` | 重复与乱序提示被吸收 |
| 16 | `dropped-hint-still-matches-via-reconciliation` | **实时事件不是事实源** |
| 17 | `target-deleted-is-excluded-and-recorded` | GONE 不算已满足 |
| 18 | `all-targets-gone-is-unresolvable-not-silent` | 判不了要说出来 |
| 19 | `permission-revoked-before-delivery-yields-revoked` | 交付时复核权限 |
| 20 | `ttl-expiry-wakes-a-waiting-observer` | 到期也要叫醒等的人 |
| 21 | `resume-into-running-session-queues-one-turn` | 不并发恢复运行中的会话 |
| 22 | `self-watch-resume-loop-refused` | 自唤醒环 |
| 23 | `task-reopened-after-match-does-not-unmatch` | Match 不可变 |
| 24 | `continuous-burst-coalesces-into-one-delivery` | debounce |
| 25 | `dynamic-set-refused-in-v1` | **动态集合不进首版** |

---

## 11. 已知限制与非目标

- **v1 不做动态集合**（§4）、不做结构化 progress 与 no-progress timer、不做外部 connector。
  这些是 P3 的事，它们要先把成员资格与进展语义封存下来。
- **v1 每个 Watch 只有一个动作。** 「既通知又唤醒」要等有人明确定义两个交付各自的成功与死信语义。
- **`UNRESOLVABLE` / `REVOKED` 是终态**：不自动复活。目标回来了或权限恢复了要新建一个 Watch，
  因为那是一次新的观察关系，不是旧关系的续期。
- 本契约**没有**证明任何实现是对的：`watchContract.spec.ts` 校验的是契约自洽与覆盖，
  求值器、迁移、索引与端到端行为都还不存在，由 P1 起的任务对着这些向量建立。

## 12. 测试

```bash
npm run test -w @orbit/shared     # 含 src/watchContract.spec.ts
```
