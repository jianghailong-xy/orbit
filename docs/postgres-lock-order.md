# Task / Session / dependency 的 canonical 锁序

`docs/postgres-deadlock-barrier.md` 记录的是**病**：2026-08-21 的两次 `40P01`，以及把它们变成确定性
夹具的那套 barrier。本文件是**答**：一套写下来、可执行、由真实 `pg_locks` 而不是由 SQL 长相推导出来的
全局锁序，以及每一个 Task/Session/dependency 写入来源在其中的位置。

| | |
|---|---|
| 锁序本身（可执行的那一份） | `src/apiserver/src/common/lock-order.ts` |
| 静态清单 + 不变量的静态守卫 | `src/apiserver/src/common/lock-order.spec.ts` |
| 修复后的 barrier 回归（正反两个到达顺序） | `src/apiserver/src/deadlock/lock-order.pg.spec.ts` |
| 回归用的修复后剧本 | `src/apiserver/src/deadlock/lock-order-fixture.ts` |
| 两条生产基线（**保持原样**，仍是修复前证据） | `src/apiserver/src/deadlock/orbit-lock-fixture.ts` |
| 秩 70 的来历与它替换掉的东西（0132） | `docs/task-dependency-revision.md` |

```
scripts/deadlock-barrier.sh lock-order   # 只跑本文件的回归
scripts/deadlock-barrier.sh all          # harness 自检 + 两条基线 + 本回归 + 0132 边界 + 0130 事件域回归
```

## 0. 为什么锁序必须写成"关系级"而且必须算上隐式锁

两次生产死锁里，**每一次至少有一把锁不出现在任何一条 SQL 文本里**：

* `INSERT "task"`（带 `creator_session_id`）会由 `task_creator_session_id_fkey` 的**内部约束触发器**
  替它取走那条 Session 行的 `FOR KEY SHARE`；
* 一条事务里**第二次**写同一行 `session`，会让 PostgreSQL 重跑该行的**全部**外键
  （`ri_triggers.c` 的 `RI_FKey_fk_upd_check_required`：旧行 `xmin` 等于当前事务时，即使外键列一个字节都
  没变也照查），于是 `user` / `workspace` / `runner` / `task` 四张表各被取走一把 `FOR KEY SHARE`。

所以任何只看"应用代码写了哪些 `FOR UPDATE`"的锁序都是假的。下面每一条都由实测得来，
`lock-order.pg.spec.ts` 把关键的两条钉成了断言：

```
BEGIN; SELECT … FROM "session" … FOR UPDATE;
UPDATE "session" SET last_turn_at = …                 → 持有 session                     （仅此一张表）
UPDATE "session" SET last_assistant_text = …          → 持有 session "user" runner task workspace
```

第一条同时否掉了一个很容易想当然的假设：**`SELECT … FOR UPDATE` 不会武装外键重查**——它不改 `xmin`，
只写 `xmax` 与 lock-only 标志位。所以"先 `FOR UPDATE` 再写一次"是干净的；脏的是"写第二次"。

## 1. Canonical partial order

秩由小到大。一个事务按**非递减**的秩取锁；同一关系需要多行时，**按 id 排序、一条语句、一次取到本事务
将会需要的最强模式**（`orderedIds`）。

| 秩 | 关系 | 这些路径取的模式 | 为什么在这个位置 |
|---|---|---|---|
| 10 | `user` | `FOR UPDATE`（owner graph mutex）· `FOR KEY SHARE`（task/session 的 owner 外键） | 每个多行 Task 写入的第一把锁。见 I1。 |
| 20 | `task_list` | `FOR UPDATE`（列表策略写）· `FOR KEY SHARE`（`task.list_id` 外键） | 暂停一个列表要先写列表行、再写列表里的每个 Task，所以列表在 Task 之前。 |
| 30 | `session` | `FOR UPDATE`（runner lease fence / inbox / lifecycle）· `FOR KEY SHARE`（`task.creator_session_id` 外键） | 见 I2、I3。也是 runner events 事务的**全部**锁集合。 |
| 40 | `project` | `FOR NO KEY UPDATE`（容量 fence、verdict 门、acceptance reopen、reconcile）· `FOR KEY SHARE`（外键、outbox） | 在 `session` 之下：`session_project_capacity_serialize` 是 Session 写入的 BEFORE 触发器，那时 Session 行已经在手。在 `task` 之上：Project 授权适配器本来就是这个顺序（project `FOR NO KEY UPDATE` → task `FOR SHARE`）。 |
| 50 | `task` | `FOR UPDATE`（删除）· `FOR NO KEY UPDATE`（更新）· `FOR SHARE`（session 派发守卫、授权适配器）· `FOR KEY SHARE`（边、`session.task_id` 外键） | 多行一律 `ORDER BY id`。 |
| 60 | `task_dependency` / `task_comment` / `task_completion_evidence` / `task_completion_evidence_idempotency` / `conversation_turn` / `run_event` / `tool_call` / `attachment` / `project_event` / `project_action` / `project_acceptance_criterion_definition` | 只插入/更新/删除 | 子行：到这一步它们的外键父行都已经在手，不会引入新的等待边。完成证据先锁 `task`(50)，再追加 evidence 与幂等键子行；来源 Session/Attempt 是不取锁、无外键的审计快照。Acceptance definition 的整组替换先锁 `project`(40)，再移动/删除/写入这些子行。 |
| 70 | `task_dependency_revision` | `FOR NO KEY UPDATE`（0132：边写之后推进）· `FOR SHARE`（dispatch 决策在它之下读边集） | 最后一把。在边（60）**之下**，因为写入方是"先改边再推进"，而决策也按同一方向取（前置 50 → 边 60 → revision 70），两边不可能反序。它让**空边集**可锁，这正是 0122 去 touch dependent Task 的全部理由。见 `docs/task-dependency-revision.md`。 |

### 三条让它可执行的不变量

**I1 — owner graph mutex 先行。** 写超过一行 `task`、或者写 `task_dependency` 的事务，第一件事是
`lockOwnerTaskGraph(tx, ownerId)`。这一条比其余全部加起来都有用：**两个都持有它的事务，无论后面碰到
哪些行都不可能互相死锁**，于是整张锁图只剩下"Task 写入方 vs Session 写入方"和"Task 写入方 vs Project
协调方"两类需要推理。

**I2 — Session 行在第一条 Task 写之前锁掉。** 一次 `task` 写会重查
`task_creator_session_id_fkey` 并取该 Task 的 creator Session 的 `FOR KEY SHARE`。把这些锁**提前、
排序、一条语句**取到，就是二方 05:53:11 那个环消失的原因——那个环的形状正是"一个事务在自己的 Task 写
之间穿插着取 Session 锁"。

**边写曾经也算在内**（`task_dependency_dispatch_touch` 让一次边写去重写它的 dependent Task），
**0132 之后不再是**：边写改为推进 `task_dependency_revision`（秩 70），一个 `task` 行都不写，因此纯边
路径只剩秩 10。

`FOR KEY SHARE` 恰好就是外键本来会取的模式，所以这条预锁**没有加强也没有削弱**任何东西，它只改变
**什么时候**取：它挡不住读者、挡不住另一个 Task 事务（同模式相容），只与一样东西冲突——runner 持有该
Session 时的那把 `FOR UPDATE`。

**I4 — dispatch 必须先拿到秩 10 的 owner 行，才能去要秩 70。**（0132 加）边写入方从第一条语句就持有
`lockOwnerTaskGraph`（10，`FOR UPDATE`），到最后一条语句才推进 `task_dependency_revision`（70）；
dispatch 天生是反的——它在决策期间就要 revision，而 owner 行要等到几条语句之后 Session INSERT 的
`session_owner_id_fkey` 才**隐式**取到。所以 `ProjectTaskDispatcherService.dispatchInTransaction` 在
**第一条**语句里就 `FOR KEY SHARE OF u`：同一行、同一模式、只是提前，和 I2 对 Task 写做的事一模一样。
实测：`dependency-revision.pg.spec.ts` 把这一句删掉重跑同一对事务，拿到 `40P01`。

**I3 — 一个事务对同一行 `session` 只写一次。** 理由见 §0。修复前 `POST /runner/sessions/:id/events`
一个批次最多写八次同一行（telemetry 一次、runtime id 一次、预览反规范化一次、每个后台 shell / 子 Agent
id 各一次），于是第二次之后的每一次都在**持有该 Session `FOR UPDATE` 的同时**去取 `user` 的
`FOR KEY SHARE`——正是 Task 事务取这两把锁的相反方向，也就是三方 05:47:43 环的第三条边。

## 2. 每个 Task 写入来源

完整清单在 `src/apiserver/src/common/lock-order.spec.ts` 的 `TASK_WRITE_SOURCES`，并且是**双向校验**的：
扫描器会在两个 service 里找出每一条 `task` / `task_dependency` 写语句，清单里没有的就红；清单里每个
`holds` 字符串也必须还能在它声称的方法里找到。**新增一个 Task 写入而不写明锁计划，测试会挂。**

| 来源 | 10 owner | 20 list | 30 session | 40 project | 备注 |
|---|---|---|---|---|---|
| `TasksService.create` | 仅当有依赖/父/verifies | ✔ | ✔ | — | 单纯改名式的 create 不该排在别人的 DAG 重写后面 |
| `TasksService.createMany` | ✔ 无条件 | ✔ | ✔ | — | 批量按 item 顺序写多行 `task`，别人无法共享这个顺序 |
| `TasksService.update` | 仅当重构 | 仅当改 `listId` | 仅当会**两次**写该行（0132 起只剩 supersession；依赖替换不再算） | 仅当写 acceptance-fact 列 | 四个秩里唯一可能全都要的 |
| `TasksService.fileVerification` | — | — | — | — | 裸 INSERT，见下方"为什么 INSERT 不需要 40" |
| `TasksService.dispatchStalledListForemen` | — | — | — | — | 同上 |
| `TasksService.applyDag` | ✔ | — | — | — | 0132 起只写边，一个 `task` 行都不写 ⇒ 没有第二次写、没有外键重查 |
| `TasksService.addDependency` / `removeDependency` | ✔ | — | — | — | 同上；两侧推进同一个 revision 行（秩 70） |
| `TasksService.deleteAndStopRuns` | ✔ | — | ✔（附着的 run） | ✔（这些 task 的 project） | 锁序**唯一声明的例外**，见 §5 |
| `TasksService.consumeRunAt` | — | — | — | — | 单行单语句；`run_at` 不在任何触发器的列表里 |
| `TasksService.clearFailedForRetry` | — | — | — | **残留** | 单语句写 `status` ⇒ 触发器随后取 project，见 §6 |
| `TasksService.batchAssign` | ✔ | — | — | — | 多行 `task` 写 ⇒ I1；`assignee_id` 不进任何触发器 |
| `TaskListsService.writePolicy` | ✔ | ✔ | — | — | 先写列表行再写列表里每个 Task |
| `TaskListsService.remove` | ✔ | — | — | — | 两次多行 `task` 写（disarm + `listId` SET NULL 级联），现在同一个事务 |

**为什么 INSERT 不需要秩 40。** `project_acceptance_task_fact` 在 `task` INSERT 之后取 project 的
`FOR NO KEY UPDATE`，也就是 50 → 40 的倒序。但一次 INSERT 在那一刻持有的唯一 `task` 行是**别人看不见
的新行**，谁也不可能在等它——所以它可以是环里的"等待方"，永远不可能是"持有方"，构不成环。
`update` / `delete` 就不同了：它们持有的是**已提交的**行，所以必须把 project 提到 task 之前。

## 3. Runner / Session 侧

| 事务 | 锁序列 | 说明 |
|---|---|---|
| `POST /runner/sessions/:id/events` | `session`(30, `FOR UPDATE`) → run_event/tool_call(60) → **一次** `session` 写 | I3。修复后这个事务的锁集合就是 `{session 行, 自己的子行}`，`user`/`workspace`/`runner`/`task` 一把都没有。 |
| `POST /runner/sessions/:id/turn-complete` | `session`(30) → conversation_turn(60) → **一次** `session` 写 → `project`(40，状态变化时由容量 fence 取) | merge 状态清理已折进 park 那一次写；只有 park 一行都没匹配上（UPDATE 匹配 0 行不改任何元组，也就不动 `xmin`）或提前 ack 返回时，才单独发一条 —— 两条路径上都仍然只有一次真正的写。 |
| `POST /runner/sessions/:id/inbox`（dequeue） | `session`(30) → conversation_turn(60) | 不写 `session` 行 |
| `QueueService.trySessionClaim` | advisory → `session`(30) → `project`(40，容量 fence) | 顺序合规 |
| `SessionsService` 生命周期（cancel/end/complete/delete） | `session`(30) → `project`(40，容量 fence) | 每条分支都只写一次 `session` 行（分支互斥） |
| `ProjectTaskDispatcherService.dispatchInTransaction`（0132 起） | `project`(40，由 `applyDecisionAction` 取) → **`user`(10, `FOR KEY SHARE`) + `task`(50, `FOR SHARE`) 同一条语句** → 前置 `task`(50) / 边(60) → `task_dependency_revision`(70) → Session INSERT / `task` 状态写 | I4。`user` 那一半是 Session INSERT 本来就会取的锁，提前到第一条语句；它顺带也让本 owner 的边写入方与一次派发完全串行。表里唯一的 40→10 倒序由 `applyDecisionAction` 先取 project 造成，与 0132 无关，属于 §6 那条未解的 `project ↔ task` 序 |

## 4. 逐项审查：trigger / constraint trigger / fencing

| 机制 | 取什么锁 | 裁决 | 理由 |
|---|---|---|---|
| `task_creator_session_id_fkey`（内部约束触发器） | 目标 `session` 行 `FOR KEY SHARE` | **保留**（本来也删不掉） | 它是 I2 的全部动机：把这把锁提前、排序、一次取到。 |
| `session_owner_id_fkey` 等 Session 外键 | `user`/`workspace`/`runner`/`task` 行 `FOR KEY SHARE` | **保留，靠 I3 让它不再重复触发** | 首次写一行不重查；只有第二次写才重查。答案是"写一次"，不是"去掉外键"。 |
| ~~`task_dependency_dispatch_touch`~~ | — | **已删除（0132）** | 它一直是 dispatch 快照的版本边界，但起作用的是它那条 `UPDATE` 取的**行锁**而不是 `updated_at` 的值——仓库里没有一处读过那个值。0132 把这把锁挪到 `task_dependency_revision`（秩 70）上：同样的互斥、同样能锁住空边集，但不写 `task` 行，于是既不重查 `task_creator_session_id_fkey`、也不重跑 `task` 上的每个行级触发器。见 `docs/task-dependency-revision.md`。 |
| `task_dependency_revision_insert/update/delete`（语句级 + transition table） | 相关 dependent 的 `task_dependency_revision` 行 `FOR NO KEY UPDATE`，**按 Task UUID 排序、每个 Task 一次** | **新增（0132）** | 秩 70，在边（60）之下。排序由显式 `ORDER BY … FOR NO KEY UPDATE` 保证（`LockRows` 在 `Sort` 之上），所以两个重叠批量不可能反序取同一对行。 |
| `session_dispatch_dependency_check`（0132，DEFERRABLE INITIALLY DEFERRED，AFTER INSERT ON session） | 不取行锁，只在 COMMIT 重读 | **新增（0132）** | 提交边界那一半，也是滚动升级期间**旧副本**绕不过去的网：旧副本不知道要取 revision，它的错误 dispatch 会在 COMMIT 拿到 `DISPATCH_DEPENDENCY_CHANGED` 并整笔回滚。只对 `dispatch_origin = 'PROJECT_COORDINATOR'` 生效。 |
| `session_project_capacity_serialize`（0122）→ `session_admission_lock_order`（main 的 0130 换掉了它） | 该 Session 的 Task 所属 `project` 行 `FOR NO KEY UPDATE`，**0130 起是 NOWAIT**：拿不到就抛 `SESSION_PROJECT_BUSY`(55P03)，什么都不写、让调用方重试 | **保留，不再收窄** | 它是 Project/Agent 准入线性化的那把锁：准入按 Session 行计数，进出"活跃认领集合"的变化必须和授权适配器取的 project 行锁排成序。它已经是**秩 30 → 秩 40**，即**顺序内**的一步，不是倒序；而且 0122 的 `UPDATE OF` + 函数开头的提前返回已经把 telemetry 写完全挡在外面（`lock-order.pg.spec.ts` 的 `a telemetry-only Session write takes no Project lock` 实测锁集合只有 `session`）。正反两个到达顺序都有回归（`capacityFenceScenario`）。 |
| `project_session_event_source` / `_update`（0117/0130） | `task`/`project` 的 `AccessShareLock` + `project_event` 插入 | **已在 0130 收窄，保持** | 见 `docs/session-event-trigger-scope.md`。telemetry 写既不查 `task` 也不查 `project`。 |
| `project_task_event_source` / `project_task_dependency_event_source`（outbox） | `project` 行 `FOR KEY SHARE`（`project_event` 的外键） | **保留** | `FOR KEY SHARE` 只与 `FOR UPDATE` 冲突，而 project 上唯一的 `FOR UPDATE` 持有者（`ProjectAcceptanceService.lockProject('FOR UPDATE')`、`ProjectsService`）在持有期间不会去等任何 `task`/`session` 行——所以这条 50 → 40 的倒序没有对手，见 `LOCK_ORDER_EXCEPTIONS`。 |
| `session_dispatch_authority_guard`（0122，BEFORE INSERT ON session） | 被派发 `task` 行 `FOR SHARE` | **保留** | 它是派发权限的插入时门。Session INSERT 因此是 50 → 30 的形状；但一次 Session INSERT 持有的 Session 行同样是别人看不见的新行，与 §2 的 INSERT 论证同构。 |
| `project_acceptance_task_fact` / `_update`（0127） | 该 Task 的 `project` 行 `FOR NO KEY UPDATE` | **保留；它是 §6 那条倒序的来源** | 见 §6。 |
| `project_acceptance_criteria_fact`（0172） | 已持有 `project`(40) 后写当前 criterion definition 子行、acceptance audit/run 子行(60)；definition normalize 只改正在写入的同一行 | **结构化改造后保留** | 旧客户端的文本写在同一事务内同步成定义行；新客户端先写定义行再写兼容投影。两条路径都保持 40 → 60，不新增反向等待边。 |
| `task_judgment_delivery_file` / `_stop`（0182） | 已持有 `task`(50) 后插入 request，并由 trigger 写 inbox/push 子行(60)；request 终结只更新它自己的 push 子行 | **新增** | 收件项/outbox 与 request 同事务，且 recipient 由 request 的 `owner_id` 快照约束，不另建 `user` FK，因而不会在 50 之后倒取 owner(10)。worker 的 APNs 调用在事务外，靠 delivery 行 lease/CAS fencing。 |
| N8 legacy import / request backfill（0184） | import 先取 owner `FOR KEY SHARE`(10)，再锁单个 task(50)；backfill 的 batch owner FK 先取得同等锁，再按 UUID 以 `FOR UPDATE SKIP LOCKED` 锁有界 task 集(50)；两者最后写 evidence/request/inbox/delivery/audit 子行(60) | **新增** | import 的 reviewer FK 不会在 task 之后倒取 owner；backfill 在锁任何 task 前先创建审计 batch。schema migration 不扫描 task，批次默认把设备 ledger 终结为 `IN_APP_ONLY`，只有显式 allowlist 产生 due push。 |
| `project_dispatch_authority_fanout`（0122，AFTER UPDATE OF `coordinator_enabled` ON project） | 该 project 下**全部** `task` 行 | **保留** | 40 → 50，顺序内。只在协调开关翻转时发生。 |
| `Task.updated_at` 作为版本边界 | — | **已取消（0132）** | 现在没有任何 fencing 依赖 `task.updated_at`；它退回成一个普通的实现时钟。 |
| `Session.inbox_lease_owner` / `inbox_lease_generation` fencing | 与 `SELECT … FOR UPDATE` 同一条语句 | **保留，未触碰** | 本次没有任何改动会改变 lease fencing 的语义：`lockSessionLeaseOwner` 一字未动，`runner-write-lease-owner.spec.ts` 与 `inbox-lease-generation.spec.ts` 全绿。 |

## 5. 声明的例外（两条，各自附论证）

两条都写在 `LOCK_ORDER_EXCEPTIONS` 里，因为**没写下来的例外等于没有锁序**。

1. **`TasksService.deleteAndStopRuns`：`task`(50) 先于级联出来的 `session` 写(30)。**
   Task 行必须在扫描"还在跑的 run"之前锁住，否则一次派发会挤在扫描和 DELETE 之间、被这段本来就是为了
   防止它的代码搞成孤儿（Session INSERT 会取该 Task 的 `FOR SHARE`，与 `FOR UPDATE` 冲突）。
   缓解：**先在秩 30 排序锁掉当前附着的 run，秩 40 锁掉它们的 project**，于是常规情况完全在序内；只有
   "在这条语句和 Task 锁之间刚好提交了一次派发"这一个窄窗口是倒序的，而这个事务持有 owner mutex，
   所以它的对手永远不可能是另一个 Task 写入。

2. **`project_event` outbox 插入：`project`(40) 在 `task`/`session` 写(50/30)之后。**
   模式是 `FOR KEY SHARE`，只与 `FOR UPDATE` 冲突；project 上的 `FOR UPDATE` 持有者不会回过头去等
   `task`/`session`，所以这条倒序没有可以配对的另一半。

## 6. 未解决：`project ↔ task` 的双向序（本次审计的发现）

这是本任务查出来、但**不能从 Task 一侧单独解决**的一条真实倒序，写在这里而不是掩盖过去：

* **`task → project`**：`project_acceptance_reopen()`（0127）在 `task` 的 INSERT / DELETE / `status`、
  `completion_policy`、`project_id`、`verdict`、`verifies_task_id` 的 UPDATE 之后，从 **AFTER 触发器**里
  取该 project 行的 `FOR NO KEY UPDATE`。**无条件取**——DONE 判断在取锁之后。
* **`project → task`**：`ProjectAuthorizationService`（派发授权适配器）先取 project 的
  `FOR NO KEY UPDATE`，再取 `task` 的 `FOR SHARE`。

实测（两连接，`lock_timeout = 1500ms`，A 持有 project `FOR NO KEY UPDATE`）：

```
task status UPDATE while project FNKU held     -> 55P03   ← 会等
task updated_at-only UPDATE                    -> committed
task title UPDATE                              -> committed
task INSERT into the project                   -> 55P03   ← 会等
task DELETE from the project                   -> 55P03   ← 会等
```

**本次做到的**：把秩 40 提到秩 50 之前，并在**已经是显式事务**的两个 Task 写入来源里预锁 project
（`TasksService.update` 的 acceptance-fact 写、`deleteAndStopRuns`），于是这两条路径被移出这条倒序。
INSERT 类来源（`create`/`createMany`/`fileVerification`/foreman）由 §2 的论证覆盖。

**未做到的**：仓库里还有若干**单语句**的 Task 状态写，它们持有 Task 行的同时由触发器去取 project：
`TasksService.clearFailedForRetry`、`applyTaskAggregations`（`src/projects/task-aggregation-writer.ts`）、
`reclaimStalledTask`（`src/tasks/reclaim-stalled-task.ts`，而且它跑在 runner finalize 事务里，那个事务
必须先持有 Session，所以它连"把 project 提前"都做不到），以及 Project 协调器自身的 Task 写入。

**为什么不顺手包一层事务**：把十几个单语句写入里的四个包进事务，买到的是"看起来覆盖了"，不是那条性质
——这条环只要还有一个未处理的写入方就依然成立。真正的解法只有两个，都在 Project 协调子系统那边，
不在本任务范围内（它有自己的 §8.6 LO 规则）：

* **(a)** 让授权适配器先取 `task` 的 `FOR SHARE`、再取 project 的 `FOR NO KEY UPDATE`；或者
* **(b)** 让 `project_acceptance_reopen()` 先做一次**不加锁**的 `status <> 'DONE'` 预检、只在可能真要
  reopen 时才取行锁（绝大多数 project 不是 DONE，那把锁根本没必要）。

(b) 更便宜也更局部，但它动的是 AE6-a 的不变量，必须由拥有那份契约的任务来判。建议交给
`横向审计全部数据库写路径并接入公共重试`。

## 7. 验证

### 7.1 修复后的 barrier 回归（正反两个到达顺序）

`scripts/deadlock-barrier.sh lock-order`，12/12，全部在 30s 预算内、无一 `40P01`：

```
✔ a second write of one Session row is what takes the parent locks
✔ one Task create against a runner events batch (task-first / runner-first)
✔ createMany against a runner events batch (task-first / runner-first)
✔ a dependency mutation against two runner transactions (task-first / runner-first)
  —— 0132 之后这两条的断言变了：不再是"链而不是环"，而是**根本不相交**（依赖事务的 `pg_locks` 里
  没有 `session`，有 `task_dependency_revision`），只剩"两个写同一 Session 行"那一条等待边。
✔ the Project admission fence still serializes admission (task-first / runner-first)
  —— 后一个方向在 main 的 0130 之后不再是"等待"而是"拒绝"（`SESSION_PROJECT_BUSY`/55P03，什么都没写），
  所以它由一条直接的两连接用例证明，不再是 barrier 剧本；前一个方向（适配器后到）仍然是等待。
✔ a telemetry-only Session write takes no Project lock
✔ the owner graph mutex serializes two reverse edge writes
```

每条剧本都写明了它替换的是基线的哪一步（`lock-order-fixture.ts`），并断言：

* **每一方都 COMMIT**，且没有任何语句拿到 `40P01`；
* **等待边的条数和方向**：二方场景恰好 1 条（不是环），三方场景恰好 2 条（**链**，不是环——基线的三条
  边少了一条，因为 telemetry 事务不再去要 owner 行）；
* 业务结果确实落库：单个 create 的边在、批量两行都在、dependency 的状态写和边都在。

### 7.2 两条生产基线仍然是修复前的证据

`orbit-lock-fixture.ts` **一字未改**。它跑的是修复**前**的字面 SQL，所以它继续复现两个环——这是刻意的：
基线是那两份生产报告的证据，不是回归。回归是 7.1，它跑的是修复**后**每条路径实际发出的语句。

### 7.3 单元与静态守卫

* `src/apiserver` 全量单测：**2442 / 2170 pass / 0 fail / 272 skipped**（修改前的同一棵树：
  2433 / 2162 / 0 / 271；新增 `lock-order.spec.ts` 的 7 个用例和 2 个 Task 用例，多出的 1 个 skip
  是无 `COORDINATOR_PG_URL` 时跳过的 `lock-order.pg.spec.ts`）。
* `lock-order.spec.ts` 7/7：清单双向闭合、每条 `holds` 仍在源码里、runner 两个 Session 写入者的语句数、
  秩严格递增、`workspace`/`runner` 的相容性论证仍然描述真代码、四个触发器的声明仍是锁序假设的样子。

### 7.4 探针（本文件里引用的实测）

```
# §0：FK 重查只在"本事务已写过这一行"时发生
BEGIN; SELECT … FOR UPDATE; UPDATE session …              → session
       ; UPDATE session …（第二次）                        → session "user" runner task workspace

# §4：0132 之前，dispatch touch 一次只写一行
INSERT task_dependency(dependent, prerequisite)           → dependent.updated_at 变，prerequisite 不变
# §4：0132 之后，它一行都不写（读 xmin，不读 updated_at——见 dependency-revision.pg.spec.ts）
INSERT task_dependency(dependent, prerequisite)           → dependent.xmin 不变，revision +1

# §6：project ↔ task
（见 §6 的五行输出）
```

## 8. 上线与回滚

> **0132 之后**：`用 dependency revision 取代无关 Task updated_at touch` 在本文件之上加了一个
> migration（`0132_task_dependency_revision`）。它的上线、回滚与混版说明在
> `docs/task-dependency-revision.md` §5，不在本节——本节说的仍然是锁序那次纯应用层改动。

**没有 migration。** 本次改动全在应用层：预锁语句、写语句的合并、以及两处事务边界。数据库 schema、
触发器、外键一个都没动。

* **滚动升级安全（双向）**：新旧 apiserver 副本可以同时在线。锁序是每个事务**自己**的属性——一个旧副本
  按旧顺序取锁，最坏情况是它自己那一对事务仍可能撞上修复前的环，和升级前完全一样；它不会让新副本变坏，
  因为新副本取的锁是旧副本本来也会取的那些（`FOR KEY SHARE` 预锁 = 外键本来就要取的模式），只是更早。
* **回滚**：直接部署上一版应用即可，没有需要撤销的数据变更，也没有需要跑的数据检查。
* **需要观察的量**：`session`/`user` 行上的锁等待时长。预期方向是——40P01 消失、`user` 行上的短等待略增
  （create/批量创建现在无条件持有 owner mutex），events 摄入的写放大显著下降（一批最多 8 次 Session 行写
  变成 1 次）。若要现场确认：

```sql
-- 谁在等谁（生产上排查用；夹具里 barrier 自己会读）
SELECT a.pid, a.wait_event_type, a.wait_event, pg_blocking_pids(a.pid) AS blocked_by,
       left(a.query, 120) AS query
  FROM pg_stat_activity a
 WHERE cardinality(pg_blocking_pids(a.pid)) > 0;
```
