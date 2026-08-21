# 24 dead-letter 结构化 blocker 与轮换幂等键契约修复

验证日期：2026-08-21（Europe/Berlin）
任务：`34AenbopoVVez0rtKuI4N`
基线提交：`1a3586637e74391014d315c903e876ac335e906a`（`feat/project`）
任务分支：`orbit/24-deadletter-blocker-34Aenb`
任务 worktree：`/root/.orbit/worktrees/pcc24-34Aenb-20260821`

## 结论

23 单元最终验收的两条遗留 blocker 已关闭：

- **BLK-23-01（标准 8，P1）**：`ProjectReconcileService.deadLetter` 现在在把事件标成 `DEAD`
  的**同一个事务**里开一条 `UNKNOWN_FAILURE` blocker；该 blocker 通过生产授权链把这个项目的
  自动派发停住，并且**不会**被下一次正常 reconcile 静默解除。
- **BLK-23-02 / F-22-04（P3，文档）**：契约 §7.3 的 `ROTATE_COORDINATOR_SESSION` 幂等键由
  `coord-session` 改成实现一直在写的 `rotate`。**没有改任何已落库的键**，并补了一条把契约与
  构造函数逐字对上的回归，让这条偏差不能再悄悄长回来。

`scripts/project-e2e.sh` 一条命令跑完（`EXIT=0`）：28 + 18 个端到端场景全绿，§10.3 活性审计零行。

## 修的是什么

### 1. dead letter 之后没有 fail-closed 状态（BLK-23-01）

契约在两个地方承诺了同一件事 —— §5.4「超过 10 次进 `DEAD` 并**同时开一条 `UNKNOWN_FAILURE`
blocker**（fail closed，§11.3）」，§15 F22「事件置 `DEAD` **且**开 `UNKNOWN_FAILURE` blocker /
恢复：人处理」，`ProjectEventHandler.deadLetter` 的接口注释也照抄了一遍。实现只写了
`run_state = PLANNING` + 5 分钟后的唤醒 + 一条写明 dead letter 的 `next_wake_reason`。

后果不是「少了一行展示」。一条 `DEAD` 事件是**永久丢弃**的：它想改的世界没有被改，而且没有任何
后续快照能把它重新推导出来。旧行为下，被丢弃之后**下一次派发照常发生** —— 控制环带着一份自己
知道不完整的世界继续自动开 Session，而人不知道。

修复后 `deadLetter` 做三件事，全部在调用方的那个事务里：

1. 按 §11.3 **raise-or-touch** 一条 `UNKNOWN_FAILURE` / `PROJECT` blocker（下节展开）；
2. 按 §4.2 守卫 2 把 `run_state` 写成 `AWAITING_HUMAN`（旧代码写 `PLANNING`，在有 open USER
   blocker 的同一次提交里那是 TS4 定义的 `ILLEGAL_TRANSITION`）；
3. 保留原来的恢复时钟（`now + 5min` 与写明 dead letter 的 reason）。

第 3 条是**故意不换成 §10.4 的答案**的：这条路径没有捕获快照，没有东西可以拿去跑 §10.4；而
5 分钟严格早于 30 分钟的升级闹钟，因此代价是多一次重算、不漏任何唤醒，而它排的那一次 pass 才是
写下契约唤醒的地方。

写失败就整事务失败 —— 这是 `project-events.service.ts` 早就写着但没人兑现的那句：**没有 blocker
就没有 `DEAD`**。新增的 `AC2: a dead letter that cannot record its blocker discards nothing`
把两个方向都断言了。

### 2. 一条 blocker 怎么活下来：§11.4 不能替项目把它解除

`planProjectBlockers` 的自动解除是一次集合差：**本次没有观察到的 open 行一律 `CLEAR_BLOCKER`**。
所以只在 `deadLetter` 里插一行是不够的 —— 紧接着的第一次正常 pass 会把它清掉，自动派发恢复，
而丢掉的信号仍然是丢掉的。那正是任务要求里「不静默恢复」的那一格。

所以这次同时补上了它的**条件**（§11.4 BL3：解除必须由重算条件驱动）：

- `world.deadLetters`（§6.1 的新投影，pre-0126 风格的**可选字段**，空集时整个键省略，因此
  从没丢过信号的项目 `decisionInputHash` 逐字节不变）——
  「这个项目里**还没有人认领**的 `DEAD` 事件」；
- 认领 = 有人把这条 blocker 解决掉，且**不是** `resolved_by = 'AUTO'`：
  ```sql
  WITH ack AS (SELECT max(resolved_at) FROM project_blocker
                WHERE project_id = :p AND dedupe_key = 'UNKNOWN_FAILURE:PROJECT:' || :p
                  AND resolved_at IS NOT NULL AND resolved_by <> 'AUTO')
  SELECT … FROM project_event WHERE disposition = 'DEAD' AND (ack IS NULL OR consumed_at > ack)
  ```
  排除 `AUTO` 是必须的：否则控制环自己的自动解除就成了「控制环替人认领了自己的失败」。
- `detectProjectBlockerConditions` 多一个 detector，把这批事件变成**和 `deadLetter` 逐字相同的
  那一个** `ObservedBlockerCondition`（两边都调 `projectDeadLetterCondition`，共用 dedupe key
  `UNKNOWN_FAILURE:PROJECT:<projectId>`）。

于是这条 blocker 的生命周期落回既有机械，不需要任何新规则：

| 事件 | 结果 | 依据 |
| --- | --- | --- |
| 同一批再死一次 / 并发 / 乱序 / 重启后 | 同一 dedupe key ⇒ touch，`occurrences` / `last_seen_at` 动，其余不动 | §11.3、ES5 |
| 又死了别的事件 | 同一 episode，`condition_version` 按新的**丢失集合**重算 | §7.2 TF2 |
| 活了 30 分钟 | 升级恰好一次，`owner` 已是 USER 只写 `escalated_at` + 一条通知 | §11.5 ES3/ES4 |
| 升级之后 | 不再贡献 `nextWakeAt`，项目可以合法停钟；`AWAITING_HUMAN` 不入 §10.3 审计范围 | §10.4 N-null、ES2 |
| 人解决了它 | 快照不再携带这批事件 ⇒ 下一次 pass 不再 raise；派发恢复 | §11.4 |
| 之后又有新的 dead letter | `lifecycle_generation + 1`，新 episode | §11.3 BE1 |

`condition_version` 摘的是**丢失事件 id 的集合**（排序后），不是投递次数、不是 `attempts` ——
BL7 与 ES5 要的正是这个区别，两条纯函数断言各压一头。

### 3. 异常文本放哪里

`detail` 是 §11.3 每次 touch 都会**整体覆写**的展示列，所以异常文本放在那里会「看得见一会儿又
看不见」。它落到 `RAISE_BLOCKER` 的 `project_action.detail.lastError` —— 每个 episode 一条、
永不重写的账本行（§8.2 GE1），同时 `next_wake_reason` 里也照旧有一份。blocker 自己的 `detail`
只放**两边都能重算出来的**东西：一句结构化 reason 和丢失事件的身份清单。

这条 `RAISE_BLOCKER` 的 `decision_id` 是 **NULL** —— 这次没有决策可引用，而迁移 0120 把这一列
留成 nullable 正是为此。`ProjectsService.blockers` 的 `raisedByActionId` 因此照常答得出「是哪
一次动作开了它」（§11.3 BE3）。

### 4. F-22-04：契约把轮换键写成了没人写过的拼写

`docs/project-coordinator-contract.md:685` 写 `pc:v1:<projectId>:coord-session:<generation+1>`，
`rotateCoordinatorSessionIdempotencyKey` 造的是 `pc:v1:<projectId>:rotate:<generation+1>`，
代码里 `coord-session` 零处。改的是**文档**：键是永久且唯一的，改实现会让历史动作改名并违反
§8.2 GE1。

同时补了 `the contract names this rotation key the way the ledger spells it` —— 它从 §7.3 表里
读出模板、代入 generation、和构造函数的输出逐字比对。改哪一边都会红。

## 变更范围

产品代码（4 个文件）：

| 文件 | 改动 |
| --- | --- |
| `project-blocker.ts` | `projectDeadLetterCondition` / `ProjectDeadLetterFact`：dead letter 的那一个条件，两个写入方共用 |
| `project-blocker-conditions.ts` | detector：`world.deadLetters` ⇒ 上面那个条件（§11.4 重算） |
| `project-decision.service.ts` | `world.deadLetters` 投影 + 捕获查询（未认领的 `DEAD`） |
| `project-reconcile.service.ts` | `deadLetter` raise-or-touch + `AWAITING_HUMAN`；raise 抽成 `raiseBlocker`（`decisionId` 可空、可带一段永久 action detail），`applyBlockers` 转调它 |

文档（1 处）：`docs/project-coordinator-contract.md` §7.3 的 `coord-session` → `rotate`。

测试：

- `project-blocker.spec.ts`：+4（PROJECT 作用域与五字段、乱序/次数无关的摘要、第二次是 touch
  不是新 episode、只有认领能解除）；
- `project-coordinator-session.spec.ts`：+2（detector 接线；契约↔构造函数的键模板）；
- `project-e2e-recovery.pg.spec.ts`：AC2 dead-letter 场景重写 + 2 个新场景（去重/并发/重启/升级、
  写不下 blocker 就不丢事件）。

未修改：Prisma schema、任何迁移、`docs/project-agent-contract.md`（用户 staged 的删除）、
其余产品实现。

## 断言是可证伪的（反向对照）

两次反向对照都在同一个库上跑，只改一处再跑同一个 spec：

| 改动 | 结果 |
| --- | --- |
| 把 detector 从 `detectProjectBlockerConditions` 的列表里去掉（只留 `deadLetter` 的插入） | recovery 套件 **15 pass / 3 fail**：`a batch that never succeeds…` 在「healthy pass 不替项目解除它」处红，`repeated, concurrent…` 在升级处红 |
| 把 `deadLetter` 的 blocker 写入去掉、`run_state` 写回 `PLANNING`（即 F-22-02 的行为） | recovery 套件 **14 pass / 4 fail**：三个 dead-letter 场景全红 |
| 恢复 | **18 pass / 0 fail** |

## 执行命令与关键输出

隔离环境：两个一次性容器，都是 `postgres:16-alpine` / PostgreSQL `16.14`。
`pcc24-34Aenb-pg16`（`127.0.0.1:55471`，database `pcc24_e2e`，role `pcc24_admin`）由
`scripts/project-e2e.sh` 自己建自己删；`pcc24b-ident-pg16`（`127.0.0.1:55472`，role
`pcc24b_admin`）持有一个迁移过的模板库 `pcc24b_ident`，其余每个 PG spec 从它克隆一个自己的库、
跑完即删。每个 spec 在第一次写入前先过 `coordinator-pg-test-safety` 的 `pcc*` 命名 + database +
role + `system_identifier` 三重校验。Node `v22.22.2`，Prisma / `@prisma/client` `5.22.0`，
Go `go1.24.4`。
任务 worktree 的 `node_modules` 由 `pcc23-349bQHCJ-20260820` 复制而来（`@prisma/client` 与
`.prisma` 是**实体拷贝**，schema 与本分支逐字相同），`@orbit/shared` 已重指到本工作树；
`/root/orbit` 全程 clean。

```
PCC_E2E_CONTAINER=pcc24-34Aenb-pg16 PCC_E2E_PORT=55471 PCC_E2E_DB=pcc24_e2e \
PCC_E2E_USER=pcc24_admin PCC_E2E_PASSWORD=pcc24_e2e_pw bash scripts/project-e2e.sh
```

```
==> provisioning pcc24-34Aenb-pg16 (postgres:16-alpine) on 127.0.0.1:55471
==> server identity: database=pcc24_e2e role=pcc24_admin system_identifier=7676260944925110312
==> prisma migrate deploy (empty database)
==> 141 migrations applied
==> building the test tree
==> acceptance suite (AC1, 4, 5, 6, 7, 8, 10, 11)
# tests 28
# pass 28
# fail 0
==> recovery and fault-injection suite (AC2, 3, 9)
# tests 18
# pass 18
# fail 0
==> §10.3 liveness audit over the world the suites left behind
==> liveness audit clean
==> OK
==> removing pcc24-34Aenb-pg16
EXIT=0
```

### 回归

本次改动之后全部重跑。**每个 PG spec 各自一个从已迁移模板克隆出来的数据库**（`CREATE DATABASE
… TEMPLATE`），这是单元 22「身份族各自独立库」那句话的一般化：把它们塞进同一个库跑，会得到互相
污染出来的假红（实测 `coordinator-identity-service` 8 fail、`coordinator-service-linearization`
挂住，换成独立库后各自 8/8 与 9/9）。

| 命令 | 结果 |
| --- | --- |
| `tsc -p tsconfig.test.json` | exit 0，0 error |
| `node --test "build/**/*.spec.js"`（不设 `COORDINATOR_PG_URL`） | tests 2149 / pass 1933 / fail 0 / skipped 216（基线 2143 / 1927，本次 +6 条） |
| `scripts/project-e2e.sh`（acceptance + recovery + 活性审计） | 28 / 28、18 / 18、审计零行、`EXIT=0` |
| `project-blocker.pg.spec` | 15 / 15 |
| `project-decision.pg.spec` | 1 / 1 |
| `project-reconcile.pg.spec`（单元 09） | 1 / 1 |
| `project-reconcile-fault-injection.pg.spec`（单元 10） | 7 / 7 |
| `project-events.pg.spec` / `project-events-fault-injection.pg.spec`（单元 08） | 7 / 7、5 / 5 |
| `project-authorization` / `project-dispatch-boundary` / `project-dispatch-boundary-verification` | 1 / 1、1 / 1、16 / 16（1 skipped） |
| `project-control-surface` / `verify18-control-loop` / `task-verification-verdict` / `task-aggregation` | 5 / 5、5 / 5、17 / 17、25 / 25 |
| `project-coordinator-driver` / `project-coordinator-session` / `project-event-sources` / `project-availability-event-sources` | 6 / 6、1 / 1、4 / 4、1 / 1 |
| coordinator 身份族 7 个 pg spec | 3 / 12 / 8 / 16 / 8 / 11 / 8，全绿 |
| `coordinator-linearization` / `coordinator-service-linearization` | 44 / 44、9 / 9 |
| `go test -run Project ./...`（runner CLI/MCP） | 87 PASS / 1 FAIL（见下，基线红） |
| `vitest run`（web 全量） | 54 文件 / 797 通过 |

单元 10 的两条 `SIGKILL` 场景第一次跑是红的，原因是它们 spawn 的子进程 require 的是
`build-project-reconcile-faults/`（`tsconfig.project-reconcile-faults.json` 的产物），而单元 22
取证结束时把它清掉了。`tsc -p tsconfig.project-reconcile-faults.json` 之后 7 / 7 —— 是缺编译
产物，不是回归。

### 基线红（与本次改动无关）

- `go test -run Project ./...`：`TestKimiFindProjectRootFallsBackToCWD` 失败（87 PASS / 1 FAIL）。
  它断言在非 git 目录下回退到 cwd，而本机 `/tmp` 之上存在可被 `kimiFindProjectRoot` 认作根的东西。
  在 `/root/orbit`（main）上跑 `go test -run TestKimiFindProjectRootFallsBackToCWD ./...` 逐字
  复现同一条失败，与单元 22 记录的是同一条环境依赖的既有红。

## 遗留

- **没有「解除 blocker」的接口**。`recovery = HUMAN` 在这套机械里的含义一直是「世界不会自己变，
  要人去动世界」，而这一条的「动世界」就是**把这行标成已解决**（`resolved_by <> 'AUTO'`）——
  今天只有直接写库能做到，控制面是只读的。这不阻塞本次修复（没有这条 blocker 时，被丢弃的事件
  一样没人认领，只是连看都看不见），但它是这条路径唯一一个「人要动手却没有按钮」的地方，建议
  作为控制面的后续项：一个把 `resolved_at` / `resolved_by = 'USER'` 写下去的接口，其余机械
  （不再 raise、再死一次就 `lifecycle_generation + 1`）已经在位并有断言压着。
- 取证结束后两个一次性容器（`pcc24-34Aenb-pg16` / `pcc24b-ident-pg16`）与它们的全部临时数据库
  已删除，`build-project-reconcile-faults/` 编译产物已清理，任务 worktree 除上列文件外 clean。
