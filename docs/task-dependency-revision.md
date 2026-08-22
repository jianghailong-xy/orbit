# dependency revision：把 dispatch 版本边界从 `task.updated_at` 挪走

`docs/postgres-lock-order.md` §4 把 `task_dependency_dispatch_touch` 记成"**保留**，已标注替换路径"。
本文件是那条替换路径的交付：migration **0131**。

| | |
|---|---|
| migration | `src/apiserver/prisma/migrations/0131_task_dependency_revision/migration.sql` |
| 锁序里的位置（秩 70） | `src/apiserver/src/common/lock-order.ts` |
| dispatch 侧：秩 70 取锁 | `src/apiserver/src/projects/project-authorization.service.ts` |
| dispatch 侧：秩 10 预锁（I4） | `src/apiserver/src/projects/project-task-dispatcher.service.ts` |
| 真实 PG 回归（两种提交顺序、批量、回滚） | `src/apiserver/src/deadlock/dependency-revision.pg.spec.ts` |
| 回归夹具 + **可执行的回滚 SQL**（`ROLLBACK_0131`） | `src/apiserver/src/deadlock/dependency-revision-fixture.ts` |
| 基线要用的历史 touch 触发器 | `src/apiserver/src/deadlock/pre-0131-dispatch-touch.ts` |

```
scripts/deadlock-barrier.sh dependency-revision   # 只跑本文件的回归
scripts/deadlock-barrier.sh all                   # 两条基线 + 锁序回归 + 本回归 + 0130 事件域回归
```

## 1. 被替换的是什么

0122 的注释说 touch 给决策"一行可锁、可比版本的东西"。**可比版本从来没被读过**——仓库里没有任何一处
把 `task.updated_at` 当 dispatch 版本比较。真正起作用的一直是那把**行锁**：

* 边写 → `UPDATE "task" SET "updated_at"` → 该 Task 行 `FOR NO KEY UPDATE`；
* dispatch 决策 → `SELECT … FROM "task" … FOR SHARE`（`project-task-dispatcher.service.ts`）。

`FOR SHARE` 与 `FOR NO KEY UPDATE` 冲突，于是两者互斥：要么边先落、决策看到新边，要么决策先跑、边排在
Session 之后。**空边集**也因此可锁——边集为空时没有边行可以 `FOR SHARE`，但那个 Task 行永远在。

代价有三项，而且都与"依赖变了"这件事无关：

1. 写 `task` 行会把该行 `xmin` 改成当前事务，于是**同一事务里再写它就会重跑它的全部外键**
   （`ri_triggers.c` 的 `RI_FKey_fk_upd_check_required`），其中 `task_creator_session_id_fkey` 会去取
   该 Task 的 creator Session 的 `FOR KEY SHARE`——而 `FOR KEY SHARE` 只与一样东西冲突：runner 持有该
   Session 时的 `FOR UPDATE`。这就是 2026-08-21 05:47:43 三方环的第三条边，也是
   `addDependency`/`removeDependency`/`applyDag` 必须预锁 creator Session 的唯一原因。
2. `task` 上每个 FOR EACH ROW 触发器都会为这次"什么都没变"的写重跑一遍（`project_task_event_source`
   会做一次 `to_jsonb(NEW) - […] IS DISTINCT FROM …` 比较，结论是不发事件——白跑）。
3. `updated_at` 是用户可见的时钟，加一条依赖会把任务顶到"最近更新"的最前面。

## 2. 换成什么

```sql
CREATE TABLE "task_dependency_revision" (
  "task_id" UUID PRIMARY KEY REFERENCES "task"("id") ON DELETE CASCADE,
  "revision" BIGINT NOT NULL DEFAULT 0
);
```

**每个 Task 都有一行**，这一点是空边集可锁的全部理由：

* migration 里 `INSERT … SELECT "id" FROM "task"` 一次回填；
* `task_dependency_revision_seed`（`AFTER INSERT ON "task"`，**语句级** + transition table）给之后每个
  Task 建行——包括**旧版 apiserver 建的** Task，它不知道这张表的存在。

**边变化推进 revision**，由三个语句级触发器（INSERT/UPDATE/DELETE 各一个，因为 PostgreSQL 只允许
单事件触发器带 transition table）调用同一个 `task_dependency_revision_advance(ids uuid[])`：

```sql
PERFORM 1 FROM "task_dependency_revision" r
 WHERE r."task_id" = ANY(ids) ORDER BY r."task_id" FOR NO KEY UPDATE;   -- 排序、一条语句
UPDATE "task_dependency_revision" r SET "revision" = r."revision" + 1
 WHERE r."task_id" = ANY(ids);                                          -- 每个 Task 恰好一次
```

* **按 Task UUID 排序**：`WHERE task_id = ANY(...)` 自己不保证加锁顺序，`LockRows` 节点在 `Sort` 之上，
  所以显式 `ORDER BY` 就是加锁顺序。两个重叠的批量边变更因此不可能反序取同一对行。
* **每个 Task 只推进一次**：主键行唯一，一条语句改十条边也只 +1。
* **级联也算**：删掉一个**前置** Task 会级联删掉指向它的边，那些 dependent 的前置集合确实变了，
  语句级 DELETE 触发器把它们一起推进。

## 3. dispatch 侧：读/锁 + 提交边界复查

`ProjectAuthorizationService.authorizeInTransaction`（已有的 fencing transaction）在锁完前置 Task
之后加一条：

```sql
SELECT r."revision" FROM "task_dependency_revision" r
 WHERE r."task_id" = $1::uuid FOR SHARE
```

`FOR SHARE` 是能挡住推进（`FOR NO KEY UPDATE`）的**最弱**模式（`FOR KEY SHARE` 挡不住）。它一直持有到
本事务提交，所以后面读到的 `incomplete` 计数在被用到之前不可能变——**"提交边界复查"由持锁到提交这件事
本身保证**，不需要再读一次。

**为什么它必须排在秩 50 之后（秩 70）。** 写入方是"先改边（60）再推进 revision（70）"，决策也按同一
方向取（前置 50 → 边 60 → revision 70），所以两边不可能反序取同一对行。

**为什么 dispatch 必须先拿秩 10 的 owner 行（I4）。** 这条是写这个 migration 时用真实 PG 撞出来的，
不是推出来的。边写入方从第一条语句起就持有 `lockOwnerTaskGraph`（`user` 行 `FOR UPDATE`），
最后一条语句才推进 revision；dispatch 天生相反——它在决策期间要 revision，而 `user` 行要等到几条语句
之后 Session INSERT 的 `session_owner_id_fkey` 才**隐式**取到。于是：

```
dispatch  持有 revision(70)  →  等 user(10)      （Session INSERT 的外键）
writer    持有 user(10)      →  等 revision(70)  （边写之后的推进）
                              = 40P01
```

修法是把 dispatch 那把本来就会取的锁提前，和 I2 对 Task 写做的事一模一样——
`dispatchInTransaction` 的**第一条**语句改成 `FOR KEY SHARE OF u FOR SHARE OF t`。同一行、同一模式、
只是提前，因此既没加强也没削弱任何东西。回归里有一条专门把这一句去掉重跑同一对事务并断言拿到
`40P01`（`a dispatch that skips the owner pre-lock deadlocks against an edge write`），所以这条不变量
不会在某次重构里被悄悄拿掉。

它还有一个副作用值得写下来：`FOR KEY SHARE` 与 `FOR UPDATE` 冲突，所以**一次派发和本 owner 的任何边
写入现在完全串行**。这意味着今天所有边写入方（它们全都拿 owner mutex）与派发之间，秩 10 就已经是一道
围栏了；revision 的价值在于它**不依赖**这个巧合——它是本地的、显式的，且不要求写入方恰好拿了 owner
mutex、也不要求派发恰好会插一行外键指向 `user` 的 Session。回归因此故意用**不拿 owner mutex** 的裸边
写入来验证秩 70 那条等待边，否则测到的只是秩 10。

Session INSERT 在 revision 之后发生，但它触发的 `session_project_capacity_serialize`（project，秩 40）
与 `session_dispatch_authority_guard`（task，秩 50）要的都是本事务**已经持有**的行，不新增等待边。

### 提交边界那一半：`session_dispatch_dependency_check`

```sql
CREATE CONSTRAINT TRIGGER "session_dispatch_dependency_check"
  AFTER INSERT ON "session" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW …
```

COMMIT 时重读该 Session（**不信 `NEW`**——延迟约束触发器在 COMMIT 才跑，拿到的却是事件当时的行），
若它是 `dispatch_origin = 'PROJECT_COORDINATOR'` 且其 Task 还有未完成前置，就 `RAISE EXCEPTION
DISPATCH_DEPENDENCY_CHANGED`，整个 dispatch（action、Session、状态写）一起回滚，交给 reconciler 重试。

它不是装饰，它是**滚动升级期间的那张网**：新副本靠 revision 行锁互斥，旧副本不知道要取它——这条检查是
两个版本都绕不过去的。谓词与授权适配器计数的那条完全同形（同 owner、只有 `DONE` 算满足），并且只对
Coordinator 派发生效：用户手动"开始执行"一个前置未完成的任务是合法的，`dependenciesReady` 是准入事实
不是数据规则。

## 4. 连带去掉的东西

| 位置 | 之前 | 现在 |
|---|---|---|
| `TasksService.addDependency` / `removeDependency` | 秩 10 + 秩 30 预锁 creator Session | **只有秩 10**。边写不再写 `task` 行，就没有第二次写去重跑外键 |
| `TasksService.applyDag` | 秩 10 + 整批 Task 的 creator Session | **只有秩 10** |
| `TasksService.update` 的 `rewritesTaskRow` | `dependsOnTaskIds !== undefined \|\| !!supersession` | **`!!supersession`**。依赖替换不再让 `task` 行被写第二次 |
| `ProjectTaskDispatcherService.dispatchInTransaction` 第一条语句 | `FOR SHARE OF t` | **`FOR KEY SHARE OF u FOR SHARE OF t`**（I4，见上） |

这不是顺手清理：`FOR KEY SHARE` 与 runner 持有 Session 的 `FOR UPDATE` 冲突，所以旧的预锁会让一次改依赖
去等一个**无关的正在跑的 run**。这正是任务说的"扩大 Task/creator_session FK 锁域"。

## 5. 上线、回滚、混版

**滚动升级（新 schema + 新旧副本混跑）**

* 新副本：取 revision 行，互斥成立。
* 旧副本：不取，但它的 dispatch 在 COMMIT 撞上 `session_dispatch_dependency_check`——要么本来就对，
  要么整笔回滚由 reconciler 重试。**不会静默错误 dispatch**，这一条有专门用例覆盖
  （`an old replica that skips the revision is refused at COMMIT`）。
* 旧副本建的 Task 照样有 revision 行（seed 触发器在数据库里）。

**新代码 + 旧 schema（先发代码后跑 migration）**：新代码会查一张不存在的表 → dispatch 直接报错、
不 dispatch。所以顺序必须是**先 migration 后代码**，与本仓库既有的部署顺序（apiserver 启动时跑
migration）一致。

**回滚**：`ROLLBACK_0131`（`dependency-revision-fixture.ts`，回归里真的执行过一遍）。它**先装回 touch
再删 revision**——回程上边界必须每一刻都存在，否则回滚窗口里的 dispatch 会一条边界都没有。
没有需要撤销的数据：`task_dependency_revision` 全表丢弃，`task.updated_at` 只多了一些历史抖动。

**要看的量**：`task` 行上的锁等待应下降（改依赖不再写它）；`session` 行上来自 Task 侧的
`FOR KEY SHARE` 等待应基本消失；`DISPATCH_DEPENDENCY_CHANGED` 应为 0——升级期间偶发是预期的（那正是旧
副本被挡下），稳定期非零说明有一条 dispatch 路径没走 fencing transaction。

```sql
-- 升级期间盯这一条
SELECT count(*) FROM "project_action"
 WHERE "type" = 'DISPATCH_TASK' AND "status" = 'CLAIMED'
   AND "created_at" < now() - interval '10 minutes';   -- 被回滚后卡住不动的认领
```

## 6. 验证

`scripts/deadlock-barrier.sh dependency-revision`，9 个用例：

* schema 事实：touch 不在了、三个推进触发器都是语句级带 transition table、提交边界检查是 DEFERRED、
  **没有一个 Task 缺 revision 行**、夹具声称在重放的两个源文件仍含它们那一半；
* 边写**不写** dependent Task——直接读 `xmin`，不是论证；`updated_at` 不动；级联删前置照样推进；
* 一条语句改一个 Task 的两条边只 +1；一个持有者拿住低位 Task 时，反序列出的批量必须**还没拿到**高位
  Task（探针连接能在 2s 内拿到它）——排序失效时这一条会红；
* **两种提交顺序**：dispatch 先 → 边写在 revision 行上排队（并断言它排的 tuple 锁**只**在
  `task_dependency_revision` 上）、Session 落库、边随后落；依赖先 → 决策排队、放行后读到
  `incomplete = 1`、不 dispatch。两个等待都由 `pg_blocking_pids` 实测，不是 sleep；
* **I4**：把 dispatch 第一条语句的 owner 预锁去掉，同一对事务拿到 `40P01`；
* 旧副本（不取 revision）在 COMMIT 被 `DISPATCH_DEPENDENCY_CHANGED` 挡下，Session 与 action 全回滚；
  两条对照：前置全 DONE 的 Coordinator 派发能提交，用户手动 Session 不受影响；
* 回滚跑通（touch 回来了、边写又开始写 Task 行），随后把 0131 重新应用到一个**已经有 Task 和边**的库上，
  回填不漏一行——这同时就是数据迁移用例。

两条生产基线仍是修复前证据，因此
`three-party-40p01.baseline.ts` 与 `pg-barrier.pg.spec.ts` 那一个 harness 自检会先把历史 touch 装回去
（`pre-0131-dispatch-touch.ts`，定义直接从 0122 里读，不是重打一遍），跑完在 `finally` 里删掉。
被重放的语句一个字没改。
