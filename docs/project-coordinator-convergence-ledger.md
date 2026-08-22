# Project Coordinator 收敛账本（持久化）v1.0

实现单元 `[K2]`，迁移 `0132_task_convergence_ledger`。

本文件**不**修改 `docs/project-coordinator-convergence-contract.md`（下称「收敛契约」，由 `[K1]` 冻结为
v1.0）。收敛契约回答「**还能做多少次**」；本文件只回答一件事：**那些计数存在哪里，谁改得动它。**

## 0. 为什么

`[K1]` 证明了熔断是可判定的——`detectNonConvergence` 是提交过事实的纯函数。但在 `[K2]` 之前，**没有任何
东西提交那些事实**：每个计数器都活在算它的那个进程里。这正是 §0 事故的后半段——

> 重启把计数清零，于是预算永远用不完。

活在内存里的预算不是预算。本单元把账本变成表。

不新增业务实体（收敛契约 RL4）：业务层仍然只有 Project 和 Task。revision、attempt、decision 都是
Task 的内部字段与两张从属表。

## 1. 三个持久对象

| 对象 | 表 / 列 | 回答什么 |
| --- | --- | --- |
| scope revision | `task_scope_revision` | 这个任务**要做什么**的第几版，以及**谁签的字** |
| 判断账本 | `task_convergence_decision` | 每一次协调判断的输入快照/哈希、attempt、指纹、进展向量、决定、动作、幂等键、known-good、requiredAction/owner/nextCheckAt |
| 当前指针 | `task` 上 6 列 + `project` 上 3 列 | 现在在第几版、第几次尝试、什么状态、花了多少预算、策略预算是多少 |

`project` 的三列（`convergence_thresholds`、`attempt_budget`、`unbounded_authorized_by`）都是**覆盖值**，
NULL 表示用 `convergence-contract.ts` 里冻结的 `GUARDED_AUTO` 默认值。所以这次迁移落地当天不改变任何
既有 Project 的行为。

## 2. 「被管理」是什么意思

**一个 Task 被收敛控制环管理，当且仅当它有 `task_scope_revision` 行。**

这一条是全部的兼容性故事（项目 AC11）：迁移落地时这张表是空的，所以

- 没有任何既有 Task 被冻结、被授权门禁、被 staleness fence 挡住；
- 一个既有的 IN_PROGRESS 任务，它的 acceptance criteria 照样可以直接改，和昨天一模一样。

`ConvergenceLedgerService.ensureBaseline` 在**控制环第一次判断这个任务时**写下 revision 1，管理从那一刻
开始——也正是「冻结」第一次有意义的那一刻。

revision 1 是**未签名的**（`authorized_by_actor` 为 NULL），这是诚实而不是省事：revision 1 是任务原本的
scope 陈述，没有人把它「修订」成这样。只有 revision ≥ 2 需要署名，那才是收敛契约 §1 权限表适用的地方。

## 3. 幂等键：为什么不能用读到的快照算

这是本单元最容易做错、也最要命的一处。

判断账本的幂等键是：

```
pc:v1:{taskId}:conv:{scopeRevision}:{observationKey}
```

`observationKey` 是**这个事实自己的持久身份**——`session:<id>:delivered`、`verdict:<taskId>:<revision>`、
`finding:<fingerprint>`——由调用方提供，**不是**从读到的世界推出来的。

原因：第一次投递提交之后，世界就变了（计数器动了）。用快照哈希当键的话，**重复投递会算出不同的键**，
同一个事实被写两遍，计数被灌水——正是事故里预算永远用不完的微缩版。

`input_hash` 仍然存在，但它的职责是**回放证明**（这次判断是哪个世界的函数），不是去重。

**推论（`[K3]..[K9]` 必读）**：调用 `record()` 必须给出一个跨进程稳定的 `observationKey`。随手用
`randomUUID()` 或时间戳，等于把去重关掉。

## 4. 事务里的顺序，是有讲究的

`ConvergenceLedgerService.record` 内部顺序不可调换：

1. `SELECT ... FROM task ... FOR UPDATE` —— 锁住任务行，使第 2 步是判定而不是猜测，并让 `seq` 可以按
   `MAX + 1` 分配而不会有第二个写者算出同一个。
2. **先查幂等键**。重复投递读到已提交的行就返回，**什么都不写**——包括 attempt generation，否则一次
   `ATTEMPT_STARTED` 会先把它加一，再去发现冲突。
3. 按已提交状态做计划。
4. **先改 `task` 列，再插账本行**。因为数据库的 staleness fence 是拿账本行去对任务当前的 revision 与
   generation，而 `ATTEMPT_STARTED` 写的正是它刚分配出来的那个 generation。

`reviseScope` 是反过来的：**先插 revision 行，再改 task**。冻结门禁要读 revision 行来核对任务被改成的内容
正是被签下的内容，所以行必须先在。

只锁 `task`，不锁 `project`（策略是读出来的，不是写进去的）——因此本单元**不新增 project↔task 的锁边**。

## 5. 数据库拦下的事（不是服务拦的）

服务不是执行者。破坏不变量的那个写者，按定义就是没走服务的那个。

| 拒绝码 | 在哪 | 拦什么 |
| --- | --- | --- |
| `SCOPE_FROZEN` | `task_scope_freeze_guard` | 已在跑的任务被直接改 scope/acceptance |
| `SCOPE_REVISION_NOT_RECORDED` | 同上 | 把 `scope_revision` 指到一个不存在的版本 |
| `SCOPE_REVISION_CONTENT_MISMATCH` | 同上 | 签下的版本和任务实际被改成的内容不符 |
| `SCOPE_CHANGE_REQUIRES_USER` | `task_scope_revision_authority_guard` | `GUARDED_AUTO` 下 Coordinator/Worker/Verifier 建新 revision |
| `SCOPE_REVISION_IMMUTABLE` | `task_scope_revision_immutable_guard` | 就地改写历史版本 |
| `STALE_SCOPE_REVISION` | `task_convergence_decision_fence` | 旧 revision 上的结论往新 revision 上写（§6 FD4） |
| `STALE_ATTEMPT_GENERATION` | 同上 | 已被取代的 attempt 继续写 |
| `CONVERGENCE_COUNTER_REGRESSED` | `task_convergence_counters_monotonic` | 计数下降（RL3 / TH4） |
| `SCOPE_REVISION_MONOTONIC` / `ATTEMPT_GENERATION_MONOTONIC` | 同上 | 版本或 attempt 回退 |
| `CONVERGENCE_DECISION_IMMUTABLE` | `task_convergence_decision_immutable_guard` | 改写历史判断 |
| `project_unbounded_authorized_by_chk` | CHECK | 存一个不是 USER 签的「无限」授权（OW4） |
| `task_convergence_decision_idempotency_key` | UNIQUE | 同一事实写第二行 |
| `task_convergence_decision_action_key_idx` | 部分 UNIQUE | 同一逻辑动作被执行第二次 |

计数下降只有**两张许可证**，都来自 §4 PV4：新的 scope revision（新问题给新预算），以及严格进展（把那四个
「自上次进展以来」的计数**清零**——只能是 0，不能是随便一个更小的数，否则写者可以每轮往下挪一格）。

## 6. `[K3]..[K9]` 还欠的

本单元只做持久化，**没有接线**：

- 没有任何东西调用 `record()`。控制环接线是 `[K4]`。
- §7 的 checkpoint 表与合并门没有建。账本只记 `known_good_sha` 这个指针；`ACCEPTED`/`WIP_RED` 两种
  checkpoint 与 CP3 的五个拒绝码属于后续单元。
- `tasks.update` 的 scope 编辑路径**尚未**改道到 `reviseScope`。今天没有任何任务是被管理的，所以不影响
  任何人；`[K4]` 把控制环接上之后，这条路必须改，否则被管理任务的 scope 编辑会撞上 `SCOPE_FROZEN` 而不是
  变成一次新 revision。
- `requiredAction` / `owner` / `nextCheckAt` 记在账本行上；把它变成一条真的 `project_blocker` 是 `[K4]` 的事。
