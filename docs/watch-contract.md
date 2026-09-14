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
5. **one-shot 是默认。** continuous 必须带 debounce 与唤醒预算，按窗口合并成一个 Match（§5、§12.4）。
6. **TTL 必填且有上限；到期也要交付。** 等在 Watch 上的会话不会被静默遗忘（§5）。
7. **唤醒复用 ConversationTurn 的唯一键。** `clientTurnId = watch:<watchId>:<generation>`，
   重复交付塌缩成同一个 turn，而不是第二次唤醒；键下若是载荷不同的别的 turn，那不是唤醒，交付记死信（§6）。
8. **权限在求值和交付时都复核，不只在创建时。** 求值时复核失败，Watch 进 `REVOKED` 而不是悄悄停掉，等在它上面的
   会话只收到一个说明 `REVOKED` 的 turn，不含任何目标状态；Match 之后才撤销的，交付记 `PERMISSION_REVOKED`
   死信，不投递任何载荷（§3、§7）。
9. **停不下来的 Watch 必须可见。** 目标全没了是 `UNRESOLVABLE`，不是沉默（§3）。
10. **成本有上限，超限也要可见。** live Watch 数量、每个观察者每小时的唤醒次数、每个账号每天的唤醒次数都有上限，
    唤醒环在创建时拒绝。超限不会被悄悄丢弃：创建时返回拒绝码，交付时记成死信，并配有指标和告警
    （§5、§7、[`watch-operations.md`](./watch-operations.md)）。
11. **进展只来自结构化报告。** phase/current/total 由报告者声明，message 与任何文本都不是进展；停滞由集中调度判定，
    不靠每个 Watch 的 sleep（§12）。

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

**说出来，也包括告诉等在它上面的会话。** `RESUME_SESSION` 的 Watch 没有成立就结束时，要给观察者交付恰好一个说明终态的
turn。三种终态各用一个 key 入队（§6）：

- `EXPIRED`（§5）：`watch:<watchId>:expired`
- `REVOKED`：`watch:<watchId>:revoked`
- `UNRESOLVABLE`：`watch:<watchId>:unresolvable`

Watch 只会进入一个终态，所以这样的 turn 最多一个。`REVOKED` 的载荷只有 `watchId` 与 `state`，不带任何目标、目标状态或快照（§7）。
`UNRESOLVABLE` 的目标已经全部 `GONE`，载荷也只有这两项。

**`CANCELLED` 不交付**：取消是 owner 或观察者自己的动作，不会有谁不知情地一直等下去。`NOTIFY_USER` 的 Watch
没有在等的会话，以上终态都不交付。

**WatchTarget**：`OBSERVED → SATISFIED`（leaf 成立）、`→ GONE`（目标行被删）。continuous 允许
`SATISFIED → OBSERVED`（条件又不成立了）。

**WatchDelivery**：`PENDING → IN_FLIGHT →`（`DELIVERED` | 回到 `PENDING` 重试 | `DEAD_LETTER`）。
`IN_FLIGHT` 由 `(leaseOwner, leaseGeneration)` 围栏；租约过期由别的 worker 接管。
`maxDeliveryAttempts = 8` 之后进 `DEAD_LETTER`，**死信必须在界面上可见**。
每个死信的 `last_error` 都以一个死信码开头（`deliveryGuards.deadLetterCodes`），说明为什么没有送到、能不能重投：
权限复核失败、观察者已结束、唤醒风暴、每日预算耗尽、重试用尽等各有其码。continuous Watch 的唤醒间隔不足时，交付回到
`PENDING` 等窗口结束，不计失败次数（§5）。死信的列出与重投见 [`watch-operations.md`](./watch-operations.md) 第 5 节。

`RESUME_SESSION` 的 `DELIVERED` 只说明唤醒 turn 已经入队，Match 的唤醒（`watch:<watchId>:<generation>`）和上面三种
终态的唤醒（`watch:<watchId>:expired` / `:revoked` / `:unresolvable`）都是如此。runner 取走它之前，下面三种情况会把这个
turn 从队列里收掉，交付随之 `DELIVERED → DEAD_LETTER`，不再报已送达，也不重投：

| 情况 | 唤醒 turn | `last_error` 开头 |
| --- | --- | --- |
| 观察者的 run 结束：当前 turn 失败、runner 掉线被 reaper 终结、runner finalize、被请求结束 | 随队列一起排空，置 `ANSWERED` | `OBSERVER_SESSION_ENDED:` |
| 观察者被打断（`SessionsService.interrupt`），会话本身还活着 | 与排在被停下的 turn 后面的全部后续消息一起删除 | `OBSERVER_TURN_INTERRUPTED:` |
| owner 撤回这条排队的唤醒（`SessionsService.cancelQueuedTurn`） | 只删这一个 turn，同一观察者的其他唤醒照旧 | `WAKE_WITHDRAWN:` |

不重投的理由：唤醒不复活已结束的会话，被排空的 turn 也无法用同一个 `clientTurnId` 再投一次；打断的语义是
stop，唤醒若留在队列里或被重投，刚被叫停的观察者马上又会被唤醒；撤回是 owner 亲手收回这条唤醒。打断和撤回删掉
turn 行后键虽然空了出来，但死信不会再被任何 worker 领取，不会有第二个唤醒。所以交付的终态只有 `DEAD_LETTER`；
`DELIVERED` 只对 `NOTIFY_USER` 和已被 runner 取走的唤醒是最终的——runner 取走的唤醒不会被打断删掉，也撤回不了。

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
交付预算，否则一个高频变化的目标就是一场唤醒风暴。完整语义见 §12.4。交付层已经为它设了下限：同一个 continuous Watch 的两次唤醒至少相隔
`continuousDebounceSeconds`，更早到期的交付回到 `PENDING` 等窗口结束，`last_error` 以 `CONTINUOUS_RATE_LIMITED` 开头，
不计失败次数。

**配额与唤醒预算**（`limits`）：一个账号最多持有 `maxLiveWatchesPerOwner` 个 live（ACTIVE 或 PAUSED）Watch，一个目标
最多被 `maxLiveWatchesPerTarget` 个 live Watch 盯着，超出的创建返回 `WATCH_QUOTA_EXCEEDED`，什么都不写；创建时条件已经成立的
Watch 当场结束，不占 live 名额。一个观察者会话一小时内最多被唤醒 `maxWakesPerObserverPerHour` 次，一个账号的 Watch
24 小时内最多唤醒 `maxWakesPerOwnerPerDay` 次，超出的那次唤醒分别记 `WAKE_STORM_SUPPRESSED` / `WAKE_BUDGET_EXHAUSTED`
死信，窗口过去后可以重投。

**创建即求值**：创建时条件已经成立，就立刻产生一个 `generation = 1` 的 Match，而不是等下一次变化。
否则「等这些 Task 全部结束」在它们已经结束时会永远等下去。

**TTL**：`expiresAt` 必填，范围 `[60s, 30d]`，默认 24h，超出 → `TTL_OUT_OF_RANGE`。
**到期同样要交付**：一个 `RESUME_SESSION` 的 Watch 到期而没有成立，也要给观察者一个带
`EXPIRED` 的 turn。否则等在它上面的会话就永远等下去了——这正是这个项目要消灭的东西。
这个 turn 以 `watch:<watchId>:expired` 入队，交付规则与 Match 的唤醒相同：runner 取走它之前观察者的 run
若已结束，排空时交付同样 `DELIVERED → DEAD_LETTER`（`OBSERVER_SESSION_ENDED`，§3），不会停在已送达。

---

## 6. 触发动作与交付

每个 Watch 恰好一个动作。

**`NOTIFY_USER`**：一条用户可见通知，走既有的 needs-you 角标口径，不另造一套计数。

**`RESUME_SESSION`**：通过**正常队列入口**给观察者会话入队**恰好一个** `ConversationTurn`：

- `clientTurnId = watch:<watchId>:<generation>`。`conversation_turn` 上有
  `UNIQUE (session_id, client_turn_id)`，所以重投的 Match 会塌缩到已经入队的那个 turn 上，
  而不是第二次唤醒。这与 `TASK_RUN_TRIGGER` 给 `sched:` / `dep:` / `first-run:` / `batch:`
  用的是同一个机制，**不要新造一套幂等**。
- Watch 没有成立就结束时（§3），终态 turn 的 key 是 `watch:<watchId>:expired` / `:revoked` / `:unresolvable`。
  这些后缀都不是数字，不会与任何 generation 的键冲突；重投同样塌缩到已经入队的那个 turn 上。
- **键下只有唤醒本身才算送达。** `clientTurnId` 由调用方自选，别人发的 turn 也可能先占住唤醒的键。`createTurn`
  只把载荷逐字相同的 turn 当作重投塌缩；键下是载荷不同的 turn 时，它不是唤醒，唤醒也无法再以这个键入队，交付立即记
  `DEAD_LETTER`，`last_error` 以 `WAKE_KEY_TAKEN:` 开头，不重试。观察者已进 Trash、已移入 Completed 或 run 已结束时，
  照旧记对应的 `OBSERVER_SESSION_*` 死信。
- **只有 worker 会写出的键才被当作唤醒。** 排空、打断、撤回（§3）只认两种键：`watch:<watchId>:<generation>`，其中
  generation 是规范十进制（无前导零，不超过 `integer` 上限）；以及各自只对应本类终态交付的 `:expired`（EXPIRY）、
  `:revoked`（REVOKED）、`:unresolvable`（UNRESOLVABLE）。`watch:<watchId>:01`、`:anything`、别的终态的词都是普通消息，
  把它们从队列里收掉不改变任何交付。
- `sendIntent = NEXT_TURN`。唤醒是新工作，不是插进正在跑的那个 turn。用 `CURRENT_WORK` 会在
  没有在飞的 message turn 时被 `CURRENT_WORK_UNAVAILABLE` 拒绝——而「观察者正停着」恰恰是最常见的情况。
- **运行中的观察者不需要特例**：`statusAfterTurnEnqueued` 让 `RUNNING` 保持 `RUNNING`、
  让 `AWAITING_INPUT`/`INTERRUPTED` 变 `PENDING`，turn 排在正在跑的那个后面。Watch 因为从不
  绕过队列，所以**结构上不可能并发恢复一个运行中的会话**。
- 载荷是结构化的：`watchId`、`generation`、`reason`、`changedTargets`、`latestSnapshot`。
  **不许把轮询日志或 shell 文本塞回上下文。**
- **入队不等于送达，被收掉的唤醒不重投**：runner 取走唤醒 turn 之前，观察者的 run 结束、观察者被打断、owner
  撤回这条唤醒，都会把它从队列里收掉；交付在收掉 turn 的同一个事务里改记 `DEAD_LETTER`，`last_error` 分别以
  `OBSERVER_SESSION_ENDED:`、`OBSERVER_TURN_INTERRUPTED:`、`WAKE_WITHDRAWN:` 开头（§3）。打断的语义是 stop，
  唤醒不是例外：它不留在队列里等下次调度，也不会被再投一次。

---

## 7. 权限

创建时观察者必须能读到**每一个**目标，否则 `PERMISSION_DENIED`。

**关键规则：权限在交付时再复核一次。** 创建与成立之间可能隔很久，期间访问可能被撤销；
复核失败 → `REVOKED`，**不投递任何载荷**。只在创建时检查等于允许用一个旧 Watch 去读现在读不到的状态。
等在它上面的 `RESUME_SESSION` 观察者仍会收到一个 turn，告诉它 Watch 以 `REVOKED` 结束。这个 turn 只有 `watchId` 与
`state` 两项，不含任何目标、目标状态或快照（§3）。

**自唤醒保护**：`RESUME_SESSION` 的 Watch 把自己的观察者会话列为目标 → `SELF_WATCH_LOOP`。
一个能唤醒自己的会话是一个没有上界的唤醒环。

**唤醒环**：观察者已经能经由 live `RESUME_SESSION` Watch 链唤醒的会话，不能再被它等 → `WAKE_LOOP`。S1 等着 S2，S2
就不能再等 S1；三个会话围成一圈同理。创建时条件已经成立的也拒绝：反复重建一个已经成立的等待，正是两个会话一次一个
即时唤醒地互相乒乓的方式。同一账号的创建在 owner 级 advisory 锁下判定，两个会话同时互等只会成功一个。超过 32 跳的环
不在创建时查，由唤醒风暴上限兜底。

**交付时复核**：每次交付尝试在构造载荷之前复核：Watch 仍存在的每个目标、以及要唤醒的观察者会话，都必须仍属于 Watch 的
owner。不满足就记 `PERMISSION_REVOKED` 死信，不投递任何载荷，也不允许重投。Watch 保持原状态，因为 Match 不可变，终态也没有
出边。已删除的目标不算撤销，它的状态不会因此落到别人手里。`REVOKED` / `UNRESOLVABLE` 的终态 turn 不含目标，只复核观察者。

**脱敏**：唤醒载荷从存储的快照按白名单重建，只保留契约列出的键：目标的 kind、id、epoch、state、changed，谓词声明过的 leaf
（布尔值），observed 里的 status、endReason、runState、lifecycleState（单个词）与 pendingApproval（布尔值）。其他键一律丢弃，
形状不对的值写成 `[redacted]`；不在谓词词汇里的 reason 也一样。推送只带脱敏后的 reason。`last_error` 落库前替换掉 URL 凭据、
Bearer token、API key 与 `key=value` 形式的密钥。

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

全部 47 条以机器可读形式存于 `contracts/watch.contract.json` 的 `vectors`，
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
| 19 | `permission-revoked-before-delivery-delivers-nothing` | 交付时复核权限：记死信，不投递载荷 |
| 20 | `ttl-expiry-wakes-a-waiting-observer` | 到期也要叫醒等的人 |
| 21 | `resume-into-running-session-queues-one-turn` | 不并发恢复运行中的会话 |
| 22 | `self-watch-resume-loop-refused` | 自唤醒环 |
| 23 | `task-reopened-after-match-does-not-unmatch` | Match 不可变 |
| 24 | `continuous-burst-coalesces-into-one-delivery` | debounce |
| 25 | `dynamic-set-refused-in-v1` | **动态集合不进首版** |
| 26 | `revoked-wakes-a-waiting-observer-with-no-target-state` | 撤销也要叫醒等的人，但**不带任何目标状态** |
| 27 | `unresolvable-wakes-a-waiting-observer` | 判不了也要告诉等的人 |
| 28 | `cancelled-watch-wakes-nobody` | 取消是自己的动作，不交付 |
| 29 | `live-watch-quota-refused` | live Watch 配额 |
| 30 | `wake-cycle-refused` | 两个会话互相唤醒 |
| 31 | `wake-storm-dead-letters-past-the-hourly-limit` | 唤醒风暴止于死信 |
| 32 | `daily-wake-budget-dead-letters` | 每日唤醒预算 |
| 33 | `continuous-wakes-spaced-by-debounce` | continuous 唤醒间隔 |
| 34 | `unrun-wake-is-not-redriven` | 没跑的唤醒不重投 |
| 35 | `progress-threshold-counts-the-reported-numbers` | 阈值只读报告的数字 |
| 36 | `progress-message-is-not-progress` | **任何文字都不是进展** |
| 37 | `no-progress-after-the-window` | 位置超过窗口未变 = 停滞 |
| 38 | `no-progress-within-the-window` | 窗口未到不成立，调度到截止时间 |
| 39 | `terminal-task-is-not-stalled` | 有结论的 Task 不算停滞 |
| 40 | `repeated-report-is-not-progress` | **活性不是进展** |
| 41 | `reopened-task-starts-an-empty-epoch` | 重开 = 新 epoch、空进度、旧 revision 失效 |
| 42 | `continuous-wake-budget-settles-matched` | 唤醒预算用完即 `MATCHED` |
| 43 | `quorum-over-the-sealed-set` | quorum 在封存集合上计数 |
| 44 | `quorum-larger-than-the-set-refused` | 放不下的 quorum 创建时拒绝 |
| 45 | `quorum-unreachable-after-deletion-is-unresolvable` | quorum 永远够不着要说出来 |
| 46 | `version-1-refuses-version-2-terms` | 谓词按它声明的版本解析 |
| 47 | `continuous-policy-out-of-range-refused` | debounce/预算越界拒绝 |

---

## 11. 已知限制与非目标

- **不做动态集合**（§4），不做外部 connector。结构化进度、停滞条件、continuous 与 quorum 已在
  predicateVersion 2 落地（§12）；quorum 只在创建时封存的集合上成立，动态成员资格仍未封存。
- **进度没有 agent 工具与界面呈现**：服务端的报告门与读门已在（§12.1），MCP/CLI 的 `task_progress_report`
  与 Web/macOS 展示是后续任务。
- **v1 每个 Watch 只有一个动作。** 「既通知又唤醒」要等有人明确定义两个交付各自的成功与死信语义。
- **`UNRESOLVABLE` / `REVOKED` 是终态**：不自动复活。目标回来了或权限恢复了要新建一个 Watch，
  因为那是一次新的观察关系，不是旧关系的续期。
- 本契约**没有**证明任何实现是对的：`watchContract.spec.ts` 校验的是契约自洽与覆盖，
  求值器、迁移、索引与端到端行为都还不存在，由 P1 起的任务对着这些向量建立。

## 12. 结构化进度、停滞条件、quorum 与 continuous（predicateVersion 2）

v2 在 v1 之上加四样东西，全部仍然只从数据库行判定。`predicateVersion` 1 与 2 都被服务：谓词以请求时声明的版本存储，
并按那个版本的文法判定，所以 v1 的 Watch 永远不会遇到它没要求过的项；v1 请求里出现 v2 的项 → `UNKNOWN_PREDICATE_KIND`。

### 12.1 结构化进度与 lifecycle epoch

`task_progress`（迁移 0271）每个 Task 一行：`phase` / `current` / `total` / `message` / `revision` / `lastProgressAt`，
以及它所属的 `lifecycleEpoch` 与 `epochStartedAt`。写入方只有两个：报告门 `POST /api/tasks/:id/progress`
（`TaskProgressService.report`，读门是同路径的 `GET`），和重开触发器。

- **报告是补丁**：出现的字段替换原值，`null` 清空，缺省保持。结果必须仍是一个位置（`phase` 或 `current`），
  `total` 只能和它界定的 `current` 同在且 `current <= total`。带 `expectedRevision` 时是 compare-and-set，不符 →
  409 `PROGRESS_REVISION_CONFLICT`；终态 Task 没有进展 → 409 `TASK_NOT_OPEN`。
- **revision**：每次被接受的变化加一（epoch 前进也算）；什么都没改变的报告不写任何东西。
- **`lastProgressAt` 只随位置移动**：只改 `message`、原样重复上一次报告都**不是**进展。否则一个不停说「还在做」的
  reporter 永远不会被看成停滞——活性不是进展。
- **lifecycle epoch**：Task 从 `DONE` / `CANCELLED` / `FAILED` 回到 `OPEN` / `IN_PROGRESS` 时，触发器
  `task_progress_epoch_advance` 把 epoch 加一、清空上一 epoch 的全部进度、推进 revision（旧 revision 的报告因此失败）。
  用触发器而不是应用代码，因为它是**每一个**重开写入都会经过的唯一地方。Epoch 0 从 Task 创建开始。
- **禁止推断**：transcript、turn、评论、shell 输出里写着「90%」不会改变进度；求值器读 `task_progress` 时不选
  `message`，没有任何 leaf 读它。

`WatchTarget.targetEpoch` 是目标最近一次被观察到的 epoch；Match 快照里每个目标的 `epoch` 是那次求值看到的 epoch，
重开之后已经写下的 Match 不变（向量 23、35）。

### 12.2 两个进度 leaf

| leaf | `params` | 成立条件 |
| --- | --- | --- |
| `TASK_PROGRESS_AT_LEAST` | `{ current }` 或 `{ percent }`，恰好一个 | 当前 epoch 报告的 `current >= params.current`；或有 `total` 且 `current × 100 >= percent × total` |
| `TASK_NO_PROGRESS_FOR` | `{ seconds }`，`[60, 30d]` | Task 为 `OPEN`/`IN_PROGRESS`，且 `now >= (lastProgressAt ?? epochStartedAt) + seconds` |

写法：`{ kind: 'ANY', over: 'ALL_TARGETS', leaf: 'TASK_NO_PROGRESS_FOR', params: { seconds: 900 } }`。参数缺失、多余或
越界 → `PREDICATE_PARAMETER_INVALID`。快照的 `leaves` 以 leaf 标签为键（`TASK_NO_PROGRESS_FOR(900s)`），`observed`
只有在谓词读进度时才带 `progress`。

**停滞由集中调度判定，不靠每个 Watch 的 sleep。** 停滞开始成立的那一刻没有任何事件会宣布（它是「没有报告」），所以
求值落地时若看到一个未来的停滞截止时间，就把 `next_evaluate_at` 设为最早的那个；到点时服务所有 Watch 的同一个 claim
循环把它取走。没有计时器、进程或会话属于某一个 Watch。终态 Task 不算停滞：它有结论了，失败与否是 `TASK_FAILED` 的问题。

### 12.3 quorum：`AT_LEAST`

`{ kind: 'AT_LEAST', count, over: 'ALL_TARGETS', leaf, params? }` 在**创建时封存的目标集合**上计数：
`1 <= count <= 目标数`，否则 `PREDICATE_PARAMETER_INVALID`（编辑谓词时同样按封存集合检查）。集合永不增长；`GONE` 的目标
离开集合、永不计入，剩下的目标少于 `count` 时条件再也不可能成立，Watch 进 `UNRESOLVABLE`——判不了要说出来。

### 12.4 continuous：generation / debounce / coalesce / 唤醒预算

`mode = CONTINUOUS` 带 `debounceSeconds`（`[10, 3600]`，默认 10）与 `wakeBudget`（`[1, 100]`，默认 10）；越界，
或给 ONE_SHOT 传这两个字段 → `CONTINUOUS_POLICY_INVALID`。数据库 CHECK 持有同样的范围。

- **crossing**：求值时条件成立、而上一次落地时不成立（`watch.holding`）。按行电平采样：两次求值之间被撤销的变化看不到。
- **debounce 与合并**：一次 crossing 打开一个 `debounceSeconds` 的合并窗口；窗口关闭前看到的 crossing 计入窗口，
  窗口关闭时的那次求值只记**一个** Match（`generation` 加一）和它唯一的交付；`reason` 与快照的 `window` 写明合并了几次。
- **唤醒预算**：`wakeBudget` 是这个 Watch 一生最多能记的 Match 数。用掉最后一次的那个 Match 把 Watch 置为 `MATCHED`，
  数据库拒绝超过预算的 `generation`；那次唤醒的 turn 会说明这是最后一次。
- **不形成唤醒风暴**：无论目标变化多快，每个窗口至多一个 Match、一个交付、一次唤醒，总数至多 `wakeBudget`。
- **结束**：窗口未关闭时到期、撤销或不可判定，直接结束，不补记那个窗口的 Match；到期快照用 `openWindow` 写明它。
- **编辑与创建**：改谓词会重置 `holding` 并丢弃未关闭的窗口；continuous Watch 不在创建时 Match，创建即到期，
  第一次求值看到的成立就是第一次 crossing。

## 13. 测试

```bash
npm run test -w @orbit/shared     # 含 src/watchContract.spec.ts
bash scripts/run-pg-spec.sh src/apiserver/src/watches/watch-security.pg.spec.ts   # 安全、限流、重试/DLQ 与指标
bash scripts/run-pg-spec.sh src/apiserver/src/watches/watch-advanced.pg.spec.ts   # §12，隔离 PostgreSQL
```

---

## 13. Agent / MCP / CLI 表面

**状态**：任务「P2：提供 Agent/MCP/CLI Watch 工具并迁移 wait」的产物。机器可读部分在契约的 `agentSurface`；
`src/shared/src/watchContract.spec.ts`、`src/apiserver/src/runner-api/runner-watches.controller.spec.ts` 与
`src/runner-go/watch_tools_test.go` 读同一份文件，任何一端与它不一致都会变红。

**为什么有这一层**：Agent 等 Orbit 自己的工作（Task 到某个状态、Session 的 turn 结束）时，会写它熟悉的那个循环——
`sleep` 加 `task_get`。那个循环整段占着 turn 和 runner slot，还随 engine 回收一起消失。这一层让它改成：请服务端盯着，
结束本轮，条件成立时经正常队列被唤醒（§6）。

### 13.1 工具

| MCP 工具 | CLI | 门槛 |
| --- | --- | --- |
| `watch_create` / `watch_get` / `watch_list` / `watch_update` / `watch_cancel` | `orbit watch create\|get\|list\|update\|cancel` | 会话内即可，与 task 工具相同 |
| `task_await` | `orbit task await` | 会话内即可 |
| `session_await` | `orbit session await` | orchestration，与 `session_get` 相同 |

- observer 永远是调用它的会话（`ORBIT_SESSION_ID`）。会话外没有可唤醒的对象：CLI 直接拒绝，`orbit capabilities`
  在会话外不列出这些命令（`SessionOnly`）。
- `task_await` / `session_await` 是预设谓词的封装，一次调用只给 id。`task_await {taskIds: [7 个]}` 的默认 `until`
  就是 §2.3 那句「全部终态或任一失败」。预设表见 `agentSurface.awaitPresets`。
- 创建后立即返回，结果让 Agent 结束本轮。条件在创建时已成立（§5）也一样返回，唤醒 turn 在本轮结束后到达。
- 旧 apiserver 没有 runner 门（`/api/runner/watches` 回 404 `Cannot …`）时，工具明说「服务端没有 watch 门，升级服务端；
  不要退回 sleep/Bash 轮询」，不静默降级。

### 13.2 runner 门

`/api/runner/watches`（`RunnerWatchesController`，runner 凭据 + `X-Orbit-Session-Id`）：

- observer 是 `X-Orbit-Session-Id` 指向、由本 runner 承载的会话；body 里没有能指定别的 observer 的字段。
- 读和改只作用于该会话观察的 watch（`WatchesService.get/list` 的 `observerSessionId` 作用域）。
- `action` 缺省 `RESUME_SESSION`，可显式 `NOTIFY_USER`。
- 目标里有 SESSION 时，另要该会话的 orchestration 凭据；只有 TASK 时不要。`WatchesService` 逐目标的权限检查照旧。
- 没有 headless 路径。

### 13.3 session_create(wait) 迁移

1. 建完子会话后、**等待开始前**建 watch：`ALL SESSION_TURN_SETTLED` 盯子会话，`RESUME_SESSION`，
   `idempotencyKey = session-create-wait:<sessionId>`。调用在等待中被杀或断线，watch 仍在服务端，子会话 settle 时唤醒调用方。
2. 在原有的有界预算内轮询子会话（顶层约 10 分钟，每深一层减半）。
3. 预算内 settle：输出迁移前**逐字节相同**的会话 JSON，再 `POST /api/runner/watches/:id/release`，让答案只到达一次：
   - watch 仍 ACTIVE/PAUSED → 取消，`CANCELLED` 不交付（§3）；
   - 已 MATCHED、唤醒已入队且未被取走 → 走 owner 撤回（`cancelQueuedTurn`），delivery 变 `DEAD_LETTER`（`WAKE_WITHDRAWN:`，§3）；
   - 唤醒还没入队 → `WAKE_NOT_QUEUED`，客户端隔 1 秒重问（交付 worker 每 5 秒一轮），最多 15 次；
   - 撤不回（`ALREADY_WOKEN`、重问用尽、release 出错）→ 输出带 `watch`，说明稍后可能还有一个内容相同的 turn，按已处理对待。
4. 预算用尽（`TIMEOUT`）或轮询时服务端不再应答（`TRANSPORT_ERROR`）：返回最后看到的会话，旁边是 `watch: {id, handedBack, note}`。
   **不报错、不丢等待意图**；MCP 文本明确让 Agent 结束本轮。
5. 兼容：没有调用会话（headless CLI、service token）时没有可唤醒的会话，服务端没有 runner 门时 watch 建不起来，两者都走迁移前的轮询，
   行为不变。

### 13.4 Agent 指令

`orbitCLIInstructions` 多一段：等 Orbit 的工作不要用 sleep、Bash 循环、后台作业或 `schedule_wakeup` 轮询，调
`task_await` / `session_await`（其他条件用 `watch_create`），然后结束本轮。`task_get`、`session_get`、`session_create`、
`schedule_wakeup`、`bg_run` 的描述与 bg-guard 的拒绝文案都指向这两个工具。Claude 的 `--allowedTools` 预批准
`orbit watch *` 与 `orbit task await`，orchestration 会话再加 `orbit session await`。

「CLI 断开后 Watch 仍存在」和「Agent 不再生成 Bash monitor」的黑盒语义由独立的 Claude 产品 QA Gate 验证。本节的机械下限是上面三份测试，
加上 `src/runner-go/session_wait_test.go` 与 `src/runner-go/watch_cli_test.go`。
