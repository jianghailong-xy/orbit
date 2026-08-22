# PostgreSQL 锁序 barrier 夹具 · 二方 40P01 基线

复现 **2026-08-21 05:53:11** 生产 `40P01 deadlock_detected` 的确定性设施。本文件描述夹具本身；
它不实施任何生产修复，后续的修复与验收任务原样复用同一套调度。

| | |
|---|---|
| 调度器（与断言无关） | `src/apiserver/src/deadlock/pg-barrier.ts` |
| Orbit 行与二方剧本 | `src/apiserver/src/deadlock/orbit-lock-fixture.ts` |
| 基线命令（证明当前行为） | `src/apiserver/src/deadlock/two-party-40p01.baseline.ts` |
| harness 自检（与修复无关） | `src/apiserver/src/deadlock/pg-barrier.pg.spec.ts` |
| 一次性 PostgreSQL 16 provisioner | `scripts/deadlock-barrier.sh` |

```
scripts/deadlock-barrier.sh            # 20 轮二方基线，退出码即结论
scripts/deadlock-barrier.sh spec       # harness 自检
scripts/deadlock-barrier.sh spec --keep
```

## 1. 安全护栏：默认拒绝共享 Orbit 业务库

夹具会故意把两个 backend 停在一个锁环里并让 PostgreSQL 中止其中之一，只有在没有别人使用的服务器上
才安全。护栏沿用仓库已有的
`src/apiserver/src/projects/coordinator-pg-test-safety.ts`，不新造第二套：

* 数据库名与角色名必须匹配 `^pcc[0-9a-z]*[_-]`；
* `hostname/database/user` 命中 `orbit-postgres` 或独立词 `orbit` 一律拒绝；
* `COORDINATOR_PG_EXPECTED_DATABASE` / `_USER` / `_SYSTEM_IDENTIFIER` 三项必须显式给出，且连接后再用
  `pg_control_system()` 复核服务器身份——**一份被复制过来的生产 URL 在第一条写语句之前就失败**。

实测（两次都在任何写入之前中止）：

```
COORDINATOR_PG_URL=postgresql://orbit:pw@orbit-postgres:5432/orbit
  → BASELINE FAILED: destructive coordinator specs require a dedicated pcc_* database
COORDINATOR_PG_URL=<合法 pcc URL>，但不给 COORDINATOR_PG_EXPECTED_*
  → BASELINE FAILED: COORDINATOR_PG_EXPECTED_DATABASE is required for destructive PG specs
```

`scripts/deadlock-barrier.sh` 起的是自己的 `postgres:16-alpine`（默认 `pcc-40p01-barrier-pg16`，
`127.0.0.1:55491`，库/角色 `pcc40p01_*`），退出时 `docker rm -fv`——`-v` 是必须的，PGDATA 所在的匿名卷
有几百 MB，忘了就是一次静默的磁盘泄漏。整个运行包在 `timeout` 里，**被 kill 的运行是红的，绝不算通过**。

## 2. 生产锁边与复现出的锁图

两个事务，两条边，环由 PostgreSQL 自己报出。每条语句都是生产已有的 SQL：

| 步骤 | 事务 | 语句 | 生产出处 | 取得的锁 |
|---|---|---|---|---|
| A1 | task-create | `SELECT "user" … FOR UPDATE` | `TasksService.lockDependencyGraph` (`tasks.service.ts`) | `user` 行 FOR UPDATE |
| A2 | task-create | `UPDATE "session" SET last_turn_at …` | runner events 事务的 telemetry-only Session 写 (`runner-api.controller.ts`) | telemetry Session 行 FOR NO KEY UPDATE |
| A3 | task-create | `INSERT "task"` | `TasksService.create → tx.task.create` | 新 task 行；触发 `project_task_event_source` → `project_event` |
| A4 | task-create | `INSERT "task_dependency"` | `TasksService.create → tx.taskDependency.createMany` | 依赖边；触发 `task_dependency_dispatch_touch`（`UPDATE task SET updated_at`）与 `project_task_dependency_event_source` |
| **A5** | task-create | `INSERT "task"`（`creator_session_id` = 争用 Session） | 同上 | **请求争用 Session 行 FOR KEY SHARE（`task_creator_session_id_fkey`）→ 阻塞** |
| B1 | runner-events | `SELECT "session" … FOR UPDATE` | `RunnerApiController.lockSessionLeaseOwner` | 争用 Session 行 FOR UPDATE |
| B2 | runner-events | `INSERT "run_event"` | events 事务的持久事件写 | run_event 行 |
| **B3** | runner-events | `UPDATE "session" SET last_turn_at …`（同 A2 那一条 telemetry Session） | 同 A2 | **请求 telemetry Session 行 → 阻塞在 A2 上** |

环：**A 持有 telemetry Session 行、等争用 Session 的 FOR KEY SHARE；B 持有争用 Session 的 FOR UPDATE、
等 A 手里的 telemetry Session 行。**

关键的行级锁相容性：`FOR KEY SHARE` **只**与 `FOR UPDATE` 冲突。这就是为什么等在那里的是外键检查而不是
任何应用层显式锁——`INSERT task` 从不写 `FOR …`，是 `task_creator_session_id_fkey` 的 RI 检查替它取了
`FOR KEY SHARE`。

## 3. 证据（一轮真实运行，原样摘录）

`pg_blocking_pids` 观测到的两条等待边（barrier 只在服务器报出这个状态后才推进）：

```
B3 telemetry-session-update : runner-events(117) blocked by [116]  wait_event=Lock/transactionid
A5 insert-task-creator-session: task-create(116)  blocked by [117]  wait_event=Lock/transactionid
```

受害者拿到的错误，`DETAIL` 是 PostgreSQL 自己对整个环的描述，`CONTEXT` 直接点名外键那条
`FOR KEY SHARE`：

```
SQLSTATE 40P01  deadlock detected
DETAIL:  Process 116 waits for ShareLock on transaction 1904; blocked by process 117.
         Process 117 waits for ShareLock on transaction 1903; blocked by process 116.
CONTEXT: while locking tuple (0,1) in relation "session"
         SQL statement "SELECT 1 FROM ONLY "public"."session" x
                        WHERE "id" OPERATOR(pg_catalog.=) $1 FOR KEY SHARE OF x"
```

A5 阻塞瞬间的 `pg_locks`（已滤掉索引噪声；`WAITING` = `granted = false`）：

```
116 relation RowShareLock     granted  "user"           ← A1 的 FOR UPDATE
116 relation RowExclusiveLock granted  session          ← A2 telemetry 写
116 relation RowExclusiveLock granted  task             ← A3
116 relation RowExclusiveLock granted  task_dependency  ← A4
116 relation RowExclusiveLock granted  project_event    ← A3/A4 的 outbox 触发器已经写过了
116 transactionid ExclusiveLock granted 1903
116 tuple    AccessShareLock  granted  session tuple 1
116 transactionid ShareLock   WAITING  1904             ← 等 runner-events 的事务
117 relation RowShareLock     granted  session          ← B1 的 FOR UPDATE
117 relation RowExclusiveLock granted  run_event / session
117 transactionid ExclusiveLock granted 1904
117 tuple    ExclusiveLock    granted  session tuple 2
117 transactionid ShareLock   WAITING  1903             ← 等 task-create 的事务
```

`project_event` 上那把 `RowExclusiveLock` 是回滚检查有意义的原因：受害事务**确实**已经写了 task 行、
依赖边和 outbox 信号，40P01 之后它们必须一个不剩。

## 4. 受害者与幸存者

**受害者恒为 task-create**，与生产一致。这不是抢跑抢出来的：PostgreSQL 中止的是**跑出死锁检查并发现环的
那个 backend**，所以夹具直接用 `SET LOCAL deadlock_timeout` 指定谁去检测——`task-create` 给 `2s`，
`runner-events` 给 `30min`。在一轮的寿命内 `runner-events` 的检测器永远不会触发，因此它不可能被选中；
受害者是**配置出来的，不是赛出来的**。`SET LOCAL` 让这个设置随事务消亡，不会漏进下一轮。

基线每轮断言：

1. A5 以 `40P01` 失败，`CONTEXT` 命中 `FOR KEY SHARE` 且落在 `"session"` 上；
2. `DETAIL` 描述的正是本轮这两个 pid 的双向环；
3. 两条等待边的 `pg_blocking_pids` 恰好是对方，`wait_event_type = Lock`；
   受害者唯一的未授予锁是 `transactionid/ShareLock`；幸存者持有 `session` 的 `RowShareLock`；
   受害者持有 `"user"/RowShareLock` 与 `task`、`task_dependency`、`project_event` 的 `RowExclusiveLock`；
4. **回滚整体性**：`task`、`task_dependency`、`project_event`(`source_id`)、`project_action`(`subject_id`)
   四张表里与两个夭折 task 相关的行数全为 0，且 `task_dependency_dispatch_touch` 没有在无关的前置 task 上
   留下 `updated_at` 抖动；
5. **幸存者结果明确**：`runner-events` COMMIT，`run_event` 落库 1 条，telemetry Session 的
   `last_turn_at` 是幸存者写的那个值（不是受害者的）——两个写入者用可区分的时间戳，所以"谁赢了"没有歧义。

实测：`20/20` 轮全部命中，无一轮退化、无 skip、无 timeout。

## 5. 调度与断言的解耦（后续任务怎么复用）

`pg-barrier.ts` 只做机制：每方一个 backend、按 `plan` 顺序推进、把结果与观测到的锁图记进
`ScenarioOutcome`。**它不判断任何 SQLSTATE 是对是错。**

* **修复后的回归**：原样调用 `twoPartyDeadlockScenario(ids)`，把断言从"A5 得到 40P01"改成"每一方都
  COMMIT"。剧本一个字不用改——改了就不是同一个时序了。
* **三方基线**：`ScenarioSpec` 的 `parties` 与 `plan` 都是数据，加第三方只是多一个 party 和多几条
  `block` / `settle`。
* **为什么基线不是 `*.spec.ts`**：它断言的是缺陷本身，修复必须让它失败。默认测试套件里长期驻扎一个
  "修好就变红"的用例，是没人能读的套件。因此基线是一条独立命令，默认套件里只有与修复无关的 harness
  自检（`pg-barrier.pg.spec.ts`，5/5 通过，无 skip）。

## 6. 没有概率性 sleep

唯一的同步原语是 `awaitBlocked`：轮询 `pg_blocking_pids(pid)`，直到服务器报出**恰好**期望的阻塞者集合。

* 它是条件 barrier，不是 sleep：条件成立的那一刻就推进；
* 没有在期限内收敛 ⇒ **抛错**，绝不静默通过（`barrier deadline exceeded …`）；
* 被声明为会阻塞的语句如果已经跑完，立即报 `finished without ever blocking`，而不是把期限耗光——
  这样修复之后跑基线是秒退，而不是 20 轮各等 30 秒；
* `block` 步骤必须写明 `blockedBy`，空集合会被直接拒绝（否则"没有人阻塞我"会被平凡满足）。

上面三条都由 `pg-barrier.pg.spec.ts` 反向验证。
