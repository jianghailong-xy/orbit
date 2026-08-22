# 单元 28：可重试 `FAILED` 的原生派发、策略提示与历史恢复

> 本文是**执行记录**，不是规范。规范以 [`project-coordinator-contract.md`](./project-coordinator-contract.md)
> 的 §7.2 · §7.4 · §9.5 · §11.2 · §34 为准（契约 v1.18 / `PC-CX-64` / `PC-CX-65` / `PC-CX-66`）。
>
> 上一单元是 27（[`project-coordinator-turn-27.md`](./project-coordinator-turn-27.md)），它把 §7.2 的
> 决策真正投递了出去。本单元回答它投递出去的那件事**本来该不该由协调器来做**。

## 0. 单元 26 / 27 之后剩下的那个洞

26 的诊断是对的：一次真实失败之后，**没有派发、没有 blocker、没有 turn**，项目每 60 秒醒一次决定不了任何事。
26 / 27 给了它一条 turn。上线之后看到的行为是：

- **每一次普通失败都开一条 turn**。协调器被叫来决定一件 §9.5 Q3 早就写好怎么做的事（"退避到期就再派一次"），
  而它唯一能做的机械动作是把 Task 手动改回 `OPEN` —— 一个人（或一个协调器）替一条本该自动发生的重试按了按钮。
  TU2 想防的 foreman 形状换了个方向发生。
- 真正走不动的那两格里，只有 `failureCount ≥ MAX` 一格有 blocker；**失败无归因**那一格从 v1 起就只活在 §9.2
  的拒绝码里，而 §7.4 第 1 条保证那条拒绝**永远不会被执行到**，于是它一条 `project_blocker` 都没有 ——
  没有责任人、没有 `requiredAction`、没有 `nextCheckAt`。

根因不在 26，在更早：**§9.5 Q3 中间那两行描述的重试阶梯，在真实失败留下的状态（`FAILED`）上永远走不到**，
因为 §7.4 第 1 条只放 `OPEN` 过。26 把这件事写成了 Q3-d 并接受了它；v1.18 的结论是那一格不该由 turn 来填。

## 1. 这一轮做了什么

### 1.1 一处判定，四个门（`PC-CX-64` 的核心）

新增 `src/apiserver/src/projects/project-failed-retry.ts`：

| 导出 | 回答 | 谁读它 |
|---|---|---|
| `failedTaskDisposition(facts)` | 这个 `FAILED` Task 是谁的：`RETRY_DUE` / `RETRY_BACKOFF` / `UNATTRIBUTABLE` / `ATTEMPTS_EXHAUSTED` / `OCCUPIED` / `NOT_FAILED` | §7.8 的 pass、§9.2 的准入、§7.2 TU2 的 turn 谓词 |
| `failedTaskBlockerKind(facts)` | 失败历史落在 §11.2 的哪一行（或不落） | §11.4 的检测器 + 上面那个函数自己 |
| `loopCanRetryFailedTask` / `failedTaskNeedsAttention` | 两个互斥的读法，供调用点直接表达意图 | 同上 |

**为什么必须是一处**：这四个门以前各读各的原始事实。26 与 63 两个缺陷都是"每条规则各自正确、合起来什么都
没发生"，而四份判定的第一次漂移会以同样的方式安静下来。

**重叠那一格是这一轮补上的反例**（复审提出，见 §2.3）：`failureCount ≥ MAX` 与"存在无归因的失败"**可以同时
为真**（五次运行全部没留下错误文本）。§11.3 的 dedupe key 含 `kind`，所以两个各读原始事实的检测器**不会**被
去重合成一条 —— 它们会在同一次失败上开出 `TEST_FAILED` 与 `UNKNOWN_FAILURE` 两条，两个互相矛盾的
`requiredAction`、两套生命周期与升级时钟，解除任何一条都还剩另一条挡着。优先级因此冻结在 `failedTaskBlockerKind`
一处：**`UNKNOWN_FAILURE` 优先**，与 §9.2 `classifyPolicyRow` 从 v1 起对同一个重叠的裁决逐字一致。
`project-blocker-conditions.ts` 里原来的两个检测器（`exhaustedRetryConditions` + 本轮一度新增的
`unattributableFailureConditions`）合并成一个 `spentFailureBudgetConditions`，**每个 Task 至多产出一条**。

### 1.2 派发：`FAILED` 是一个可派发状态（§7.4 A1-b）

- `project-dispatch-pass.ts`：`status !== 'OPEN'` 不再无条件出局；仍在预算内的 `FAILED` 是候选，退避未到期
  落回既有的 `RETRY_BACKOFF_ACTIVE`，两个终态格落新的诊断码 `TASK_FAILED_TERMINAL`。skip 列表同时把 `FAILED`
  纳入"要给出解释"的状态 —— 以前它是唯一一个连一句话都拿不到的状态。
- `project-authorization.service.ts`：`authorizeTaskState` 对 `FAILED` **准入**而不是回 `TASK_NOT_OPEN`
  （后者在 §11.2 的非阻塞列表里，也就是"静默 fallback"本身）。终态格照常走 `DISPATCH_MAX_ATTEMPTS` 行，
  拿到 `MAX_ATTEMPTS_REACHED` / `UNKNOWN_FAILURE`，于是**一定**有一条能被人读到的行。
- `project-task-dispatcher.service.ts`：Session 插入之后、同一个事务里，
  `UPDATE task SET status='IN_PROGRESS' WHERE id=… AND status='FAILED'`。条件写，所以别人写过的状态不会被
  拖回去；目标是 `IN_PROGRESS` 而不是 `OPEN`，理由与既有 sweep 的 `clearFailedForRetry` 逐字相同。
  **旧的 FAILED Session 一个字节不改** —— 它是 §6.1 数 `failureCount` 的依据。提交后按账本里的
  `detail.retriedFromFailed` 发一条 `TASK_CHANGED`（从账本读，不是从内存标志读）。

### 1.3 turn：只在控制环动不了的时候（§7.2 TU2-b）

`project-turn-reason.ts` 的 `failureEpisodes` 改读 `failedTaskDisposition`。TU2 的判据一个字没动
（"控制环自己还能不能动它"），变的是这句话在 `FAILED` 上的**答案**。结果：普通失败 ⇒ 派发、不开 turn；
两个终态格 ⇒ **一条 blocker + 一条 turn**，两者由同一处判定给出，因此不会出现"有 turn 没有行"或"有行没人被叫"。

### 1.4 开场白与 turn 正文按当前策略生成（`PC-CX-65`）

`coordinator-opening.ts` 的 `buildCoordinatorOpening(title, projectId, policy)` 与
`buildCoordinatorTurnMessage({ …, automationPolicy })`：四类动作（自己就做 / 要人批 / 会被拒绝等条件变 /
只能由人做）由 `projectPolicyCell` **逐行询问 §9.2 矩阵**得到，不是另写一份平行散文；矩阵多一行而这里没有
句子，测试就红。三处调用点各自把策略读出来传进去：`projects.service.ts`（人手动开）、
`project-coordinator-session.service.ts`（§7.5 轮换）、`project-coordinator-turn.service.ts`（每一次 turn，
读的是**投递事务里那一行**，不是快照冻结的那一份）。

### 1.5 一次性、幂等的历史恢复扫描（`PC-CX-66`）

`project-failure-recovery.service.ts`，`onModuleInit` 里跑一次，不阻塞启动。

- **它只做一件事**：为"存在已停住的失败 episode、而没有任何一条 `APPLIED` 的 `OPEN_COORDINATOR_TURN` 的
  `turnFacts` 提到它"的项目，把 `project_runtime.next_wake_at` 压到 `now`。决策、原因、键、turn 仍然全部由控制环
  自己产生 —— 第二个写它们的地方就是第二个 materializer。
- **它不是第四条唤醒路径**（§10.2 W1 数的是时钟）：跑一次，写的是 §10.4 自己那一列，然后被 W1 的第一条路径捡起。
- **幂等是结构性的**：UPDATE 自带 `next_wake_at IS NULL OR > now` 谓词，所以第二次扫描**一行都不写**
  （不是"写了同样的值"——`updated_at` 是真实可见的列）；`RETURNING` 让它报告的是数据库做了什么。
- **被租约持有的项目是 DEFERRED，不是 drop**（复审提出，见 §2.3）：持有者会用自己的 fencing token 发布
  `next_wake_at`，这次写会被它盖掉，所以跳过；但"跑过一次"与"全部答完"是两件事，因此**一次性的闩只在
  `deferred` 为空时落下** —— 否则一个持有一秒的租约会让这个进程再也不扫那个项目。

### 1.6 一处判定与 §9.2 的一致性，是被证明的而不是被声称的

`authorizeTaskState` 里**没有**再调一次 `failedTaskDisposition`：§9.2 的那几条子句（live Session ⇒
`TASK_ALREADY_RUNNING`、退避未到 ⇒ `RETRY_BACKOFF_ACTIVE`、两个终态格 ⇒ `DISPATCH_MAX_ATTEMPTS` 行的
`MAX_ATTEMPTS_REACHED` / `UNKNOWN_FAILURE`）**本来就是**这一处判定的出处，把它改成一次转发只会让调用图更绕。
要钉住的是**两边的答案一致**，于是钉在测试里：`project-failed-retry.spec.ts` 对 200 个世界里 `FAILED` 的那 80 个
逐个比对 `failedTaskDisposition` 与 `authorizeProjectAction` 的结论。

这条断言当场抓到一处真的分歧：`failureCount = 0` 且"退避未到期"时，本模块答 `RETRY_BACKOFF`，§9.2 答 `ALLOW`。
生产里这个组合**不存在**（`retryBackoffUntil(0, …)` 是 null，快照因此恒答"退避已到期"），但两份实现对一个
不可能的世界给出两个答案，就是下一次漂移的入口。已按 §9.2 从 v1 起就带着的 `failureCount > 0` 守卫对齐。

## 2. 测试与证据

环境：Node **v22.22.2**（仓库 `engines` 要求 ≥26，本机只有 22）、npm 10.9.7、TypeScript 7.0.2（原生二进制）、
Prisma 7.9.1、PostgreSQL 16（`postgres:16-alpine`，一次性容器，跑完 `docker rm -f -v`）。
worktree 内独立 `npm install`；`/root/orbit/node_modules` 仍是 Prisma 5.22 / TS 5.9 的陈旧树，软链过去只会得到假错。

### 2.0 分支与提交

分支 `orbit/c-failed-task-5b98ad`，从 `main`（`00841cfb`）开出后**先 merge 单元 27 的分支**
`orbit/b-open-coordinator-turn-b86879`（`2c1f531b`）—— 本任务在依赖图上依赖它，而它当时尚未并入 `main`。
合并提交 `2a349ffa`。

- `4dbcc5d7` feat(projects): let the control loop retry the failure it already knows how to
- 本文所在的提交是当前分支 tip。

### 2.1 命令

```bash
# 依赖与代码生成（worktree 内，全程不碰主仓）
npm install --no-audit --no-fund
npm run build -w @orbit/shared
npm run prisma:generate -w @orbit/apiserver

# 单元（不需要数据库；没有 COORDINATOR_PG_URL 时 pg spec 自动 skip）
npm test -w @orbit/apiserver

# 真实 PostgreSQL：一次性容器
docker run -d --name pcc28-pg -e POSTGRES_USER=pcc28_user -e POSTGRES_PASSWORD=pcc28pw \
  -e POSTGRES_DB=pcc28_retry -p 55428:5432 postgres:16-alpine
DATABASE_URL=postgresql://pcc28_user:pcc28pw@127.0.0.1:55428/pcc28_retry \
  ./node_modules/.bin/prisma migrate deploy

COORDINATOR_PG_URL=postgresql://pcc28_user:pcc28pw@127.0.0.1:55428/pcc28_retry \
COORDINATOR_PG_EXPECTED_DATABASE=pcc28_retry COORDINATOR_PG_EXPECTED_USER=pcc28_user \
COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=$(docker exec pcc28-pg \
    psql -U pcc28_user -d pcc28_retry -tAc 'SELECT system_identifier FROM pg_control_system()') \
  node --test --test-concurrency=1 build/projects/project-failed-retry.pg.spec.js

# pg 回归矩阵：每个 spec 一个**全新数据库** + migrate（同库顺序跑会互相污染）
for f in project-failed-retry project-coordinator-turn project-dispatch-pass project-blocker \
         project-decision project-reconcile verify18-control-loop project-e2e-recovery \
         project-dispatch-boundary project-dispatch-boundary-verification \
         project-coordinator-session project-control-surface project-e2e-acceptance \
         project-events; do
  DB=pcc28_r$f
  docker exec pcc28-pg psql -U pcc28_user -d pcc28_retry -c "CREATE DATABASE $DB"
  DATABASE_URL=…/$DB ./node_modules/.bin/prisma migrate deploy
  COORDINATOR_PG_URL=…/$DB … node --test --test-concurrency=1 build/projects/$f.pg.spec.js
done   # 结果见 §2.5

docker rm -f -v pcc28-pg
```

### 2.2 结果

| 项 | 结果 |
|---|---|
| 基线 `npm test -w @orbit/apiserver`（合并单元 27 之后、改动之前） | **2375 tests / 2118 pass / 0 fail / 257 skipped** |
| 改动后 | **2399 / 2140 / 0 fail / 259 skipped**（+24 条单元，+2 skipped 是新 pg 文件的两个顶层用例） |
| `project-failed-retry.pg.spec.ts`（真实 PostgreSQL） | **15 / 15 pass** |
| pg 回归矩阵（14 个文件，逐文件新建数据库） | 全绿，见 §2.5 |

### 2.3 复审提出、本轮补上的五条

审查在提交前指出了五处，全部已修并各自带上测试：

1. **两个 blocker 检测器各读原始事实 ⇒ 同一次失败开两行**（§1.1）。修法是把判定收进 `failedTaskBlockerKind`
   一处并冻结优先级；测试是 `project-failure-turn.spec.ts` 的重叠反例（只出现 `UNKNOWN_FAILURE` 一条，
   把它放回下一次快照后第二次 reconcile 只 touch、不 raise、不 clear、也不长出第二种 kind）+
   `project-failed-retry.pg.spec.ts` 的同名真实场景（连一条 resolved 的 `TEST_FAILED` 都没有）。
2. **"并发"测试其实是串行重放**：先 `await first` 再 `await second`，测的是 §8.3 的 replay-idempotence，
   不是竞态。原用例改名为"a REPLAY of one retry key…"（它证明的东西仍然有价值），另加一条真并发：
   两套服务图（两个 PrismaClient / 两个连接池）+ 第三条连接做屏障 —— 屏障在 `project` 行上持 `FOR UPDATE`，
   而那正是两个 dispatch 事务的**第一条语句**（§7.7 的线性化点），两个 dispatcher 因此都停在锁上，
   `pg_locks.granted = false` 数到 2 之后一起放行。断言：恰好一个 `APPLIED`、账本只有一行、
   Session 恰好 2 条（1 条旧 FAILED + 1 条新 PENDING）、旧 Session 的 `status` / `error` / `finishedAt`
   一个字节没变、`dispatch_attempt` 只前进一格。
   - 第一版把 `decisions.capture/persist` 写在屏障**之后**，而 capture 自己就要读那一行 project ——
     于是测试把自己锁死（`pg_locks` 只有一个 waiter，屏障连接 idle-in-transaction）。修法是把决策的准备
     移到取屏障之前；这条同样记在用例的注释里，因为它是"屏障要挡的是被测代码，不是测试自己"的实例。
   - 屏障的等待轮询用 `pg_locks.granted = false` 而不是 `pg_stat_activity.wait_event_type`，并把上限压到
     1.5s：两个 dispatcher 等待期间都在 Prisma 的交互式事务里，那有 5s 超时，屏障持久一点测的就是超时而不是竞态。
3. **恢复扫描第二次仍执行 UPDATE**（`updated_at` 会动），且**因租约跳过后进程内的一次性闩会永久关门**。
   修法与测试见 §1.5 与下表最后两行。
4. **`authorizeTaskState` 里那次转发是多余的**（见 §1.6）：改成平白的 `status` 门 + 一条跨模块一致性性质，
   顺带抓到 `failureCount = 0` 那个不可能世界上的两个答案。
5. **单元 27 的 pg 套件从 11/11 掉到 2/11**（扩展矩阵发现）。表现是"失败之后 action/turn = 0、协调会话停在
   `AWAITING_INPUT` 没转 `PENDING`"。根因不是投递坏了，是**夹具**：27 的每个场景都用 `failTask(…, 1)` 造世界
   —— 一次可归因的失败。写它的时候 `FAILED` 就等于"控制环动不了"，因为 §7.4 拒绝一切非 `OPEN`；v1.18 之后
   同一份世界变成"控制环会重试它"，于是 §7.2 正确地不开 turn，而 27 的断言在等一条 turn。

   **修法是改夹具，不是改断言**：把六处 `failTask(…, 1)` 换成 `MAX_AUTO_RUN_FAILURES`，27 的断言**一条都没动**
   —— 它测的一直是"当控制环动不了时，一条 message turn 被可靠地投递出去、恰好一次、经得起重放/接管/两侧
   SIGKILL"，而 v1.18 只改了"控制环动不了"这句话在 `FAILED` 上的判定。改完 11/11 恢复。
   同时新增一条**合成回归**（§2.4 的 "the ladder ends where unit 27 begins"）：一个任务沿阶梯一格一格真实失败
   到上限，最后仍然**恰好一条**投递出去的 turn 落在协调会话里 + 一条 `TEST_FAILED`。它存在的理由就是这次回归：
   保证 v1.18 没有把"协调器听得到失败"换成"协调器去重试失败"，而是把两者按顺序接上。

### 2.4 pg 场景逐条

新文件 `project-failed-retry.pg.spec.ts`（15 条，全部从门进：提交一条信号然后 drain，或者走真实
`ProjectTaskDispatcherService`）：

| 场景 | 盯的是 |
|---|---|
| 一次普通失败 ⇒ 派发 | A1-b：动作 `APPLIED`、Task `FAILED → IN_PROGRESS`、新 Session `PENDING` 且 `dispatch_origin = PROJECT_COORDINATOR`、旧 Session 的 `status`/`error`/`finishedAt` 未变、**没有** blocker、**没有** turn |
| 被拒绝的重试 | 没有半个重试存在：Task 仍 `FAILED`，一条 Session 都没多 |
| 同一把键重放 | §8.3：第二次 `ALREADY_APPLIED`，指向同一条 Session |
| 两个 dispatcher 真并发 | 屏障同时放行 ⇒ 恰好一个 `APPLIED`、一行账本、一条新 Session、`dispatch_attempt` 只前进一格 |
| 重试又失败 | 落回 `FAILED`（这正是目标状态取 `IN_PROGRESS` 的原因）、进入第二档退避、期间不派也不开 blocker |
| 预算用尽 | 停派；一条 `TEST_FAILED`（`owner = USER` / `recovery = HUMAN` / 有 `requiredAction` / 有 `nextCheckAt`） |
| 重叠（用尽 **且** 无归因） | 只有 `UNKNOWN_FAILURE` 一条；第二次 reconcile 不长出 `TEST_FAILED`，`lifecycle_generation` 不变 |
| 阶梯末端接上单元 27 | 五次真实失败之后：**恰好一条**投递出去的 `message` turn（`client_turn_id` = 动作键、协调会话可被 claim）+ 一条 `TEST_FAILED`；再 reconcile 一次不会有第二条 turn |
| `MANUAL` | 不是静默跳过：attempt 落库、`REFUSED` + `POLICY_REQUIRES_APPROVAL`、开 `AWAITING_USER_APPROVAL`、Task 不动 |
| 恢复扫描：`next_wake_at IS NULL` + 已升级 blocker | 压到 `now`；第二次扫描 `updated_at` 不变、`rearmed`/`deferred` 都空；全程一条 `project_action` 都不写 |
| 恢复扫描：episode 已被一条 `APPLIED` turn 提到 | 一行都不碰 |
| 恢复扫描：项目正被租约持有 | 报 `deferred`、不写；**释放租约后再调 `recoverOnce` 恢复成功**，此后闩才落下 |

### 2.5 pg 回归矩阵（14 个文件，逐文件一个全新 database + `prisma migrate deploy`）

同一个 database 顺序跑会互相污染（有 7 个 spec 自己往私有 schema `migrate deploy`，而 `pg_trgm` 是 database 级
对象），所以每个文件一个新库，跑完 drop。

| 文件 | 结果 |
|---|---|
| `project-failed-retry.pg.spec.ts`（本单元新增） | 15 / 15 |
| `project-coordinator-turn.pg.spec.ts`（单元 27） | 11 / 11（修夹具前 2 / 11，见 §2.3 第 5 条） |
| `project-dispatch-pass.pg.spec.ts` | 15 / 15 |
| `project-blocker.pg.spec.ts` | 15 / 15 |
| `project-decision.pg.spec.ts` | 1 / 1 |
| `project-reconcile.pg.spec.ts` | 1 / 1 |
| `verify18-control-loop.pg.spec.ts` | 5 / 5 |
| `project-e2e-recovery.pg.spec.ts` | 17 / 17 |
| `project-dispatch-boundary.pg.spec.ts` | 1 / 1 |
| `project-dispatch-boundary-verification.pg.spec.ts` | 17 pass / 1 skip / 0 fail |
| `project-coordinator-session.pg.spec.ts` | 1 / 1 |
| `project-control-surface.pg.spec.ts` | 5 / 5 |
| `project-e2e-acceptance.pg.spec.ts` | 28 / 28 |
| `project-events.pg.spec.ts` | 7 / 7 |

（`# tests 1` 的那几个是"一个顶层用例、内部若干 subtest"的写法，不是只跑了一条。）

## 3. 刻意留下的边界（不是遗漏）

- **没有新增 blocker kind、turn 原因、幂等键模板或 §9.2 的行**。三条缺口都是用已经冻结的对象关掉的。
- **没有第二条重试阶梯**：`AUTO_RUN_RETRY_BACKOFF_MS` / `MAX_AUTO_RUN_FAILURES` 一个数字没动。
- **没有改写任何历史失败 Session**，也没有清零任何失败计数 —— 重试花的是同一份预算。
- **恢复扫描没有定时器、没有事件源、没有新的唤醒路径**；它跑一次、写一列，然后交给 §10.2 W1。
- **`REPLAN` / `ACCEPTANCE` 两个 turn 谓词仍未实现**（26 留下的边界，本轮没有动它）。
- **`TASK_FAILED_TERMINAL` 只是诊断码**：它不进任何键、任何摘要、任何决策，只让"这个 Task 为什么不在候选里"
  有一句可读的答案。
