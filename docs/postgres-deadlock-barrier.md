# PostgreSQL 锁序 barrier 夹具 · 二方与三方 40P01 基线

复现两起生产 `40P01 deadlock_detected` 的确定性设施：**2026-08-21 05:53:11** 的二方死锁（§2–§4）与
**2026-08-21 05:47:43** 的三方死锁（§7–§9）。本文件描述夹具本身；它不实施任何生产修复，后续的修复与
验收任务原样复用同一套调度。

| | |
|---|---|
| 调度器（与断言无关） | `src/apiserver/src/deadlock/pg-barrier.ts` |
| Orbit 行与两个剧本 | `src/apiserver/src/deadlock/orbit-lock-fixture.ts` |
| 二方基线命令（证明当前行为） | `src/apiserver/src/deadlock/two-party-40p01.baseline.ts` |
| 三方基线命令（证明当前行为） | `src/apiserver/src/deadlock/three-party-40p01.baseline.ts` |
| harness 自检（与修复无关） | `src/apiserver/src/deadlock/pg-barrier.pg.spec.ts` |
| 一次性 PostgreSQL 16 provisioner | `scripts/deadlock-barrier.sh` |

```
scripts/deadlock-barrier.sh              # 20 轮二方基线，退出码即结论
scripts/deadlock-barrier.sh three-party  # 20 轮三方基线
scripts/deadlock-barrier.sh spec         # harness 自检
scripts/deadlock-barrier.sh retry        # 公共事务重试模块的真实 40001 用例
scripts/deadlock-barrier.sh all          # 一台服务器上跑 spec + retry + 两条基线，任一红即非零退出
scripts/deadlock-barrier.sh spec --keep
```

## 1. 安全护栏：默认拒绝共享 Orbit 业务库

夹具会故意把两个或三个 backend 停在一个锁环里并让 PostgreSQL 中止其中之一，只有在没有别人使用的服务器上
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

同一台机器上有别人也在跑时，用 `P40_PG_CONTAINER` / `P40_PG_PORT` 换掉默认名字和端口再跑——脚本开头
第一件事就是 `docker rm -fv "$CONTAINER"`，撞名会把别人的服务器删掉。

## 2. 生产锁边与复现出的锁图（二方）

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

## 3. 证据（二方，一轮真实运行，原样摘录）

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

## 4. 受害者与幸存者（二方）

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

实测：`100/100` 轮全部命中，无一轮退化、无 skip、无 timeout。

## 5. 调度与断言的解耦（后续任务怎么复用）

`pg-barrier.ts` 只做机制：每方一个 backend、按 `plan` 顺序推进、把结果与观测到的锁图记进
`ScenarioOutcome`。**它不判断任何 SQLSTATE 是对是错。**

* **修复后的回归**：原样调用 `twoPartyDeadlockScenario(ids)` / `threePartyDeadlockScenario(ids)`，把断言
  从"某一方得到 40P01"改成"每一方都 COMMIT"。剧本一个字不用改——改了就不是同一个时序了。
* **三方基线**：`ScenarioSpec` 的 `parties` 与 `plan` 都是数据，所以第三方只是多一个 party 和多几条
  `block` / `settle`；`pg-barrier.ts` 一行没改，`threePartyDeadlockScenario` 与二方共用同一个
  `seedLockFixture`（三方在其上多插一行已提交的 task，见 `seedThreePartyFixture`）。
* **公共事务重试**：`src/apiserver/src/common/transaction-retry.pg.spec.ts` 复用 `Observer`
  —— 同一个"读服务器状态才推进"的原语 —— 把一个真实 REPEATABLE READ 事务停在
  `wait_event_type = Lock` 且被竞争者阻塞的那一刻，再让竞争者提交，从而拿到真正的 40001 并验证
  整个 closure 被重跑。它不需要 `runScenario`：这一侧的受害者由重试循环自己驱动，不是一份固定
  剧本（`scripts/deadlock-barrier.sh retry`）。
* **为什么基线不是 `*.spec.ts`**：它断言的是缺陷本身，修复必须让它失败。默认测试套件里长期驻扎一个
  "修好就变红"的用例，是没人能读的套件。因此基线是独立命令，默认套件里只有与修复无关的 harness
  自检（`pg-barrier.pg.spec.ts`，11/11 通过，无 skip）。

## 6. 没有概率性 sleep

唯一的同步原语是 `awaitBlocked`：轮询一次 `pg_stat_activity` 快照，直到服务器同时报出
「`wait_event_type = Lock`」与「`pg_blocking_pids(pid)` **恰好**是期望的阻塞者集合」。

* 它是条件 barrier，不是 sleep：条件成立的那一刻就推进；
* **两个条件必须同属一次快照**：backend 先进锁管理器的等待队列、之后才发布自己的 wait event，所以
  存在一个窗口——`pg_blocking_pids` 已经点名阻塞者，而 `wait_event_type` 还是 `NULL`。在那里推进
  会把一条 `waitEvent = null` 的等待边当成证据记下来，几十轮才翻车一次，而且报出来的是"边不对"
  而不是"锁序不对"。二方基线确实这样红过一次（前两次整套运行各 25 轮全绿，第三次在第 13 轮
  `waitEventType` 读回 `null`），现在由 barrier 自己排除；
* 没有在期限内收敛 ⇒ **抛错**，绝不静默通过（`barrier deadline exceeded …`）；
* 被声明为会阻塞的语句如果已经跑完，立即报 `finished without ever blocking`，而不是把期限耗光——
  这样修复之后跑基线是秒退，而不是 20 轮各等 30 秒；
* `block` 步骤必须写明 `blockedBy`，空集合会被直接拒绝（否则"没有人阻塞我"会被平凡满足）。

后三条都由 `pg-barrier.pg.spec.ts` 反向验证。

## 7. 生产锁边与复现出的锁图（三方，2026-08-21 05:47:43）

三个事务，三条边。每条语句同样都是生产已有的 SQL：

| 步骤 | 事务 | 语句 | 生产出处 | 取得 / 请求的锁 |
|---|---|---|---|---|
| D1 | dependency | `SELECT "user" … FOR UPDATE` | `TasksService.lockDependencyGraph` | owner `user` 行 FOR UPDATE |
| D2 | dependency | `UPDATE "task" SET status …` | `TasksService.update → tx.task.update`（同一次 PATCH 的标量那一半） | 依赖任务行 FOR NO KEY UPDATE；触发 `project_task_event_source` → `project_event` |
| **D3** | dependency | `INSERT "task_dependency"` | `tx.taskDependency.createMany` | 先触发 `project_task_dependency_event_source`（再写一条 `project_event`），再触发 `task_dependency_dispatch_touch` 的 `UPDATE "task"`；**该 UPDATE 重跑 `task_creator_session_id_fkey` → 请求争用 Session 行 FOR KEY SHARE → 阻塞** |
| I1 | runner-inbox | `SELECT "session" … FOR UPDATE` | `RunnerApiController.lockSessionLeaseOwner` | 争用 Session 行 FOR UPDATE |
| I2 | runner-inbox | `INSERT "run_event"` | events 事务的持久事件写 | run_event 行 |
| **I3** | runner-inbox | `UPDATE "session" SET last_turn_at …`（telemetry Session） | 同一个 events 事务的 telemetry-only 写 | **请求 telemetry Session 行 → 阻塞在 P1 上** |
| P1 | telemetry | `UPDATE "session" SET last_turn_at …` | runner events 事务的 telemetry-only 写 | telemetry Session 行 FOR NO KEY UPDATE |
| **P2** | telemetry | `UPDATE "session" SET last_assistant_text …` | 同一事务紧接着的预览反规范化（`runner-api.controller.ts` 的 `tx.session.update`） | **同一行的第二次写 ⇒ 重跑 `session_owner_id_fkey` → 请求 owner `user` 行 FOR KEY SHARE → 阻塞** |

环：**dependency → runner-inbox → telemetry → dependency**。

### 三条边各自的来源，逐条分清

* **I3 → P1 是最普通的一条**：两个写入者抢同一条 Session 行，`FOR NO KEY UPDATE` 自己和自己冲突。
  没有触发器、没有外键参与。
* **D3 → I1 和 P2 → D1 都是外键的隐式行锁，而且都只在"这一行本事务已经写过一次"时才存在。**
  这是全篇最容易看漏的一点：PostgreSQL 在**外键列没有变化**时通常跳过 RI 检查，但
  `ri_triggers.c` 的 `RI_FKey_fk_upd_check_required()` 有一条例外——*"If the original row was
  inserted by our own transaction, we must fire the trigger whether or not the keys are equal."*
  被更新的旧行版本 `xmin` 若等于当前事务，检查照跑。
  - D2 先把依赖任务更新过一次，所以 D3 里 `task_dependency_dispatch_touch` 的 `UPDATE "task"`
    落在一个 `xmin = 本事务` 的行上，`task_creator_session_id_fkey` 被重跑，替这条语句取了
    争用 Session 的 `FOR KEY SHARE`——**`INSERT "task_dependency"` 本身一个 Session 字都没提。**
  - P1 先写过 telemetry Session，所以 P2 这条预览写把 Session 的**每一个**外键都重跑一遍，
    `session_owner_id_fkey` 取 owner `user` 行的 `FOR KEY SHARE`，正好撞上 D1 的 `FOR UPDATE`
    （`FOR KEY SHARE` 只与 `FOR UPDATE` 冲突）。
  - 去掉那次"先写一遍"，两条边就都不存在。这不是推理，是 `pg-barrier.pg.spec.ts` 里两组
    **对照实验**：同一剧本删掉 D2 / P1，声明会阻塞的语句直接跑完，harness 报
    `finished without ever blocking` 而不是耗光期限。
* **触发器 vs 约束触发器**：`task_dependency_dispatch_touch`、`project_*_event_source` 都是普通用户
  触发器（`pg_trigger.tgisinternal = false`）；取行锁的那两次 RI 检查是外键自带的**内部约束触发器**
  （`tgisinternal = true`，`tgconstraint` 指回外键）。基线开跑前逐条核对这三件事，任何一条被改名或
  删掉，基线就不再是关于那份生产报告的证据了。
* **project_event 写入来源**：本轮出现的每一条 outbox 行都能点名归属——`task.status_changed` 来自 D2 的
  `project_task_event_source`，`task.dependency_changed` 来自 D3 的
  `project_task_dependency_event_source`，而 telemetry 那两条 Session 写虽然照常跑了
  `project_session_event_source`，却**一条信号都没入队**（status / merge_status 都没变）。所以"这一轮
  除种子外的 project_event 全部属于受害者"是可以精确断言的，回滚检查才不会被幸存者的写入污染。
  同一个触发器在 status 真的变化时确实会入队 `session.awaiting_input`——spec 里正反两面都测了。

## 8. 证据（三方，一轮真实运行，原样摘录）

`pg_blocking_pids` 观测到的三条等待边（barrier 只在服务器报出这个状态后才推进）：

```
P2 session-preview-update    : telemetry(225)    blocked by [223]  wait_event=Lock/transactionid
I3 telemetry-session-update  : runner-inbox(224) blocked by [225]  wait_event=Lock/transactionid
D3 insert-task-dependency    : dependency(223)   blocked by [224]  wait_event=Lock/transactionid
```

受害者拿到的错误。`DETAIL` 是 PostgreSQL 自己对**三方**环的描述；`CONTEXT` 把整条来源链一次说完——
外层是插入依赖边、中层是 `task_dependency_dispatch_touch` 的 `UPDATE "task"`、最内层是外键那条
`FOR KEY SHARE`：

```
SQLSTATE 40P01  deadlock detected
DETAIL:  Process 223 waits for ShareLock on transaction 2031; blocked by process 224.
         Process 224 waits for ShareLock on transaction 2032; blocked by process 225.
         Process 225 waits for ShareLock on transaction 2030; blocked by process 223.
CONTEXT: while locking tuple (4,10) in relation "session"
         SQL statement "SELECT 1 FROM ONLY "public"."session" x
                        WHERE "id" OPERATOR(pg_catalog.=) $1 FOR KEY SHARE OF x"
         SQL statement "UPDATE "task" SET "updated_at" = CURRENT_TIMESTAMP
                          WHERE "id" IN ( … )"
         PL/pgSQL function task_dependency_dispatch_touch() line 3 at SQL statement
```

三行 `DETAIL` 首尾相接（223→224→225→223），与上面三条 `pg_blocking_pids` 边**同一个环**，这是二方基线
拿不到的一条证据：环长确实是 3，不是两个二方环叠在一起。

D3 阻塞瞬间的 `pg_locks`（已滤掉索引噪声；`WAITING` = `granted = false`）：

```
223 dependency   relation      RowExclusiveLock granted  task             ← D2 的 UPDATE
223 dependency   relation      RowExclusiveLock granted  task_dependency  ← D3 已插入的边
223 dependency   relation      RowExclusiveLock granted  project_event    ← D2/D3 的 outbox 触发器已写过
223 dependency   relation      RowShareLock     granted  "user"           ← D1 的 FOR UPDATE
223 dependency   relation      RowShareLock     granted  session          ← 外键那条 FOR KEY SHARE
223 dependency   relation      RowShareLock     granted  task / project   ← task_dependency 与 project_event 的外键
223 dependency   transactionid ExclusiveLock    granted  2030
223 dependency   tuple         AccessShareLock  granted  session tuple 10 ← 排在争用 Session 行上
223 dependency   transactionid ShareLock        WAITING  2031             ← 等 runner-inbox
224 runner-inbox relation      RowShareLock     granted  session          ← I1 的 FOR UPDATE
224 runner-inbox relation      RowExclusiveLock granted  run_event / session
224 runner-inbox transactionid ExclusiveLock    granted  2031
224 runner-inbox tuple         ExclusiveLock    granted  session tuple 14
224 runner-inbox transactionid ShareLock        WAITING  2032             ← 等 telemetry
225 telemetry    relation      RowExclusiveLock granted  session          ← P1 的 telemetry 写
225 telemetry    relation      RowShareLock     granted  "user"           ← 外键那条 FOR KEY SHARE
225 telemetry    tuple         AccessShareLock  granted  "user" tuple 35  ← 排在 owner 行上
225 telemetry    transactionid ExclusiveLock    granted  2032
225 telemetry    transactionid ShareLock        WAITING  2030             ← 等 dependency
```

两把 `tuple` 锁点名了等待的**表**：`dependency` 排在 `session` 行上、`telemetry` 排在 `"user"` 行上——
而这两条语句（`INSERT "task_dependency"` 和 `UPDATE "session" SET last_assistant_text`）里，一个字都没提
`session` 的行锁或 `"user"`。加上两个 `RowShareLock`（表级的 `FOR KEY SHARE` 投影），"锁是外键取的、不是
应用 SQL 取的"这句话就闭合了。

`project_event` 上那把 `RowExclusiveLock` 是回滚检查有意义的原因：受害事务**确实**已经写了任务状态、
依赖边和 outbox 信号，40P01 之后它们必须一个不剩。

## 9. 受害者与幸存者（三方）

**受害者恒为 dependency 写入**，与生产一致，机制与二方相同：只有 `dependency` 的
`SET LOCAL deadlock_timeout` 短到能在一轮内触发（`2s`），另外两方是 `30min`，所以跑死锁检查、发现环、
被中止的只可能是它。受害者是**配置出来的，不是赛出来的**。

基线每轮断言：

1. **来源**：开跑前核对 `task_creator_session_id_fkey`（→`session`）、`session_owner_id_fkey`（→`"user"`）
   两条外键仍由**内部约束触发器**支撑，`task_dependency_dispatch_touch` 仍是**普通用户触发器**且仍挂在
   `task_dependency` 的 AFTER INSERT/UPDATE/DELETE 上；
2. D3 以 `40P01` 失败，`CONTEXT` 同时命中 `task_dependency_dispatch_touch`、`UPDATE "task"`、
   `FOR KEY SHARE` 与 `"session"`——整条来源链，不是其中一段；
3. `DETAIL` 解析出的边集恰好是 `{dependency→runner-inbox, runner-inbox→telemetry, telemetry→dependency}`
   （按 pid 翻译回 party 名再比较，多一条少一条都红）；
4. 三条等待边的 `pg_blocking_pids` 恰好是环里的上家，`wait_event_type = Lock`；三方各自**唯一**的未授予锁
   都是 `transactionid/ShareLock`；`dependency` 的 tuple 锁落在 `session` 上、`telemetry` 的落在 `"user"` 上；
5. **回滚整体性**：依赖边 0 行；依赖任务的 `status` 仍是 `OPEN`、`updated_at = created_at`
   （`task_dependency_dispatch_touch` 的抖动没留下）、`dispatch_attempt` 仍是 `0`；
   `project_event` 里属于本轮受害者的三种 kind（`task.status_changed` / `task.dependency_changed` /
   `task.updated`）全为 0（种子提交的 `task.created` 必须还在——所以这里按 kind 数而不是按 source 数）；
   `project_action`（dispatch）0 行；无关的前置 task 也没有被 touch；
6. **两个幸存者结果都明确**：都 COMMIT；`run_event` 落库 1 条；telemetry Session 的 `last_turn_at` 是
   `runner-inbox` 写的那个值（它最后提交），`last_assistant_text` 是 `telemetry` 写的那个值——两位幸存者
   各留一处只有自己能写的痕迹，所以"谁赢了"没有歧义；`project_session_event_source` 对这两次 telemetry-only
   写**一条信号都没入队**。

实测：`100/100` 轮全部命中，无一轮退化、无 skip、无 timeout；同一次运行里二方基线同样 `100/100`，
harness 自检 `11/11`（`scripts/deadlock-barrier.sh all`，退出码 0，容器退出即 `docker rm -fv` 清掉）。
另外把 `P40_TIMEOUT` 压到 `1s` 跑同一条命令，得到 `!! spec TIMED OUT after 1s (rc=124) — a hang,
not a pass` 且整条命令以 `124` 退出——超时路径是红的，`all` 也确实会把失败传出去。

### 反向对照（不是靠耗光期限来"通过"）

`pg-barrier.pg.spec.ts` 用两组对照钉死了这两条外键边的真正成因，两组都在 5s 预算内**秒退**：

```
harness/dispatch-touch-control   删掉 D2       → the statement finished without ever blocking
harness/session-fk-recheck-control 删掉 P1     → the statement finished without ever blocking
```

也就是说：一旦修复改变了"同一事务先写过这一行"这件事，或改变了锁序，基线不会慢慢等到超时，而是立刻变红。
