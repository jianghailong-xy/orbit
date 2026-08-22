# 26 失败唤醒：冻结 `TASK_FAILURE` 契约与纯决策规划

实施日期：2026-08-22（Europe/Berlin）
任务：`34BEY2u6sVesf9SodYWNr`（[补充 A] 冻结 Coordinator 失败唤醒契约与纯决策规划）
基线提交：`9b814afd fix(projects): recover dispatch after coordinator assignment`（`origin/main`）
本单元提交：`52ef6d9e feat(projects): make a settled task failure wake the coordinator`
分支：`orbit/a-coordinator-f675a4`（从最新 `main` 开出）
worktree：`/root/.orbit/worktrees/44cfbf55-425f-4628-9c24-1ff03b53f40d`
契约：[`project-coordinator-contract.md`](./project-coordinator-contract.md) v1.16 → **v1.17**，缺口编号 `PC-CX-63`，闭环在 §33

> 本单元**只冻结契约与纯决策**。把这条决策真正投递出去（`OPEN_COORDINATOR_TURN` 的原子投递、
> 事件消费、TR2 窗口落库、TR3 的 blocker 落库、§10.4 第 7 条的唤醒候选）是后继单元的事，
> 对应任务 `34BEY2y0aJQMtTneSG6Lo`「[补充 B] 实现 OPEN_COORDINATOR_TURN 原子投递与可靠唤醒」。

---

## 1. 缺陷

一次普通的任务失败之后，控制环**没有任何一条规则会说话**。

| 步骤 | 事实 | 依据 |
|---|---|---|
| 1 | Session 跑挂，runner 回报 `FAILED` ⇒ Task 落到 **`FAILED`** | `runner-api.controller.ts` 与 `reaper.service.ts` 都调 `reclaimStalledTask(..., TaskStatus.FAILED)` |
| 2 | 下游 Task 进 **`BLOCKED_FAILED`** | `tasks/task-dependencies.ts`：任一前置 `FAILED` ⇒ 终态阻塞 |
| 3 | 不再派发 | §7.4 第 1 条：`task.status !== 'OPEN'` ⇒ `TASK_NOT_OPEN`（`project-dispatch-pass.ts:254`） |
| 4 | 不开 blocker | §9.5 Q3 最后一行要求 `failureCount ≥ MAX_AUTO_RUN_FAILURES`（5），实际是 1 |
| 5 | 不开 turn | §7.2 TU2（v1.1–v1.16）：「任务失败永不开 turn」 |
| 6 | `runStateOf` ⇒ **`PLANNING`**（守卫 7 兜底），`nextWakeAt = epoch + 60s` | §4.2 · §10.4 |

结果：`actions = []`，每 60 秒一条 `NOOP`，Coordinator Session 停在 `AWAITING_INPUT`（**live**，
因此 §7.5 判 `HEALTHY`，也不轮换），**直到有人手动发一条消息**才参与。

**没有一条不变量被违反**——这既是它躲过 2358 条单测与 32 个 pg spec 的原因，也是它必须由契约
而不是由补丁关闭的原因。

**既有夹具为什么看不见它**：本目录此前每一处「失败」夹具都写成 `status: 'OPEN'` + `failureCount: n`。
那个组合在生产里不存在，而它恰好落在 §9.5 Q3 中间两行——一读就是「控制环正在退避，安静是对的」。
夹具替系统回答了那个它本该被问到的问题。

---

## 2. 冻结的答案（契约 v1.17）

| 条款 | 内容 |
|---|---|
| §7.2 表 | 新增第 3 行 `TASK_FAILURE`：存在 `status = FAILED` 且无 live Session 的 Task |
| §7.2 TU2（重写） | 两态表，判据是**控制环自己还能不能动它**：还能（`OPEN`，退避中／已到期）⇒ **不得**开 turn；不能了（`FAILED` 且无 live Session）⇒ **必须**开 |
| §7.2 TU4 | 全序扩到六条：`MANUAL ≻ VERDICT ≻ TASK_FAILURE ≻ BLOCKER_DECISION ≻ ACCEPTANCE ≻ REPLAN` |
| §7.2 TU5 | 可测形式从 32 个组合扩到 **64** 个 |
| §7.2 TF6（新增） | 一次失败 episode 的身份 = `(taskId, dispatchAttempt)`；`failureCount` 与 `failureAttributable` 明确排除 |
| §7.2 TF4 | 补一行：`TASK_FAILURE → dispatch_attempt → task`（§8.2 DA1） |
| §7.2 TU6（新增） | 策略边界：不新增 §9.2 行，走已有的 `OPEN_COORDINATOR_TURN` 行（`MANUAL` ⚠ / `GUARDED_AUTO` ✔ / `AUTO` ✔） |
| §7.2 TU7（新增） | turn 要有落点：§7.5 的协调运行必须 `HEALTHY`，否则先轮换；原因是事实不是事件，下一次照常胜出 |
| §7.2 TU8（新增） | 求值次序冻结为 **TR1 ≻ TR3 ≻ TR2 ≻ 开 turn** |
| §6.2 | outcome 补 `turn`（`reasonCode` / `reasonDigest` / `turnFacts` / `verdict` / `idempotencyKey` / `windowEndsAt` / `lastTurnSessionId`） |
| §9.5 Q3-d（新增） | 写明中间两行在 `FAILED` 的 Task 上不可达，填这一格的是 §7.2 而不是第二套退避阶梯 |
| §11.2 BL9（新增） | `TASK_FAILURE` 是 turn 的 `reasonCode`，不是 blocker 的 kind；`TEST_FAILED` 一列未改，BL4 照常成立 |
| §22.8 | 残句账新增一行：`失败有既有的退避与重试` ⇒ 复活即 `PC-CX-63` |
| §18 | 单元索引新增 **26** |

### 为什么这不是把协调器变成重试机制

TU2 真正要保护的是「一个『停滞就派一个协调者』的规则在停滞无法被协调者解决时会永远重派」。
这条性质由三条**已冻结**的机制保证，v1.17 没有为它新增任何东西：

- **TR1**：键含 TF6 的 `dispatchAttempt`，不含投递次数 ⇒ 一个失败 episode **只换来一次** turn；
- **TR2**：同一 `reasonCode` 60 秒内至多一次；
- **TR3**：第二眼看到同一个世界 ⇒ 不再开 turn，改开 `COORDINATOR_NO_PROGRESS`（`owner = USER`）。

协调器在一个失败上**恰好有一次**机会；用不掉，它就归人。

---

## 3. 实现（纯决策）

新增 `src/apiserver/src/projects/project-turn-reason.ts`（纯函数，无 Nest / Prisma / 时钟）：

| 导出 | 条款 |
|---|---|
| `TURN_REASON_ORDER` | §7.2 TU4 的全序 |
| `chooseTurnReason(facts)` | TU4 / TU5：首个为真者胜，其余进 `suppressed` |
| `turnReasonDigest(code, facts)` | §7.6 TR1 |
| `openCoordinatorTurnIdempotencyKey(projectId, generation, digest)` | §8.2 |
| `turnReasonFactsOf(input, ctx)` | §7.2 的事实投影（含 TF6） |
| `planCoordinatorTurn(input, ctx)` | §7.2 + §7.6 的完整答复，含 TU8 的次序与五种 `verdict` |

`project-decision.service.ts` 侧：`planProjectDecision` 在 blocker 与轮换之后求值一次，
outcome 补 `turnReason` / `suppressedTurnReasons` / `turn`，`plannedActions` 在
`verdict === 'OPEN'` 时追加**至多一条** `OPEN_COORDINATOR_TURN`。

**边界（刻意留下的）**：

- `ACCEPTANCE` 与 `REPLAN` 两个谓词**未求值** —— 它们的输入（§13.4 的验收摘要与 attempt、
  §7.8 的可派发集合）由别的 pass 计算，不在 `planProjectDecision` 手上。全序对它们照常成立：
  **一个没有被求值的原因不可能获胜**，因此本单元没有让任何项目开始收到 `REPLAN` turn。
- 预迁移快照（`world.blockers` 或 `runtime.coordinatorSessionId` 缺失）**一律不求值**，
  与 `world.blockers` 既有的重放纪律逐字相同。
- `RATE_LIMITED` / `NO_PROGRESS` / `IN_FLIGHT` / `NO_LIVE_RUN` 四支只是**判定**；它们各自的
  副作用（`NOOP` 审计行、`next_attempt_at`、`COORDINATOR_NO_PROGRESS` blocker、唤醒候选）
  属于后继单元。

---

## 4. 回归夹具（生产同构）

`src/apiserver/src/projects/project-failure-turn.spec.ts` 用四个事实一起建夹具：
**`Task = FAILED`**、**`Session = FAILED`**、下游 **`BLOCKED_FAILED`**、
**Coordinator Session = `AWAITING_INPUT`**，`failureCount = 1`（远低于阈值，是**普通**情形而非极端情形）。

| 断言 | 结果 |
|---|---|
| 这份快照产生**恰好一条** `OPEN_COORDINATOR_TURN`，`turnReason = TASK_FAILURE` | ✔ |
| **反向对照**：同一份世界把 Task 写回 `OPEN`（旧夹具的形状）⇒ 一条 turn 都不开 | ✔ |
| 重复投递、乱序投递（任务数组反序）⇒ 同 digest 同键 | ✔ |
| `dispatch_attempt` 前进一格 ⇒ **新** digest、**新**键 | ✔ |
| TR3（同键 + 协调运行空闲）⇒ `NO_PROGRESS`，不开 turn | ✔ |
| TR1（同键 + 协调运行在跑）⇒ `IN_FLIGHT`，不开 turn | ✔ |
| TR2（窗口未过）⇒ `RATE_LIMITED`，不占键；窗口过了 ⇒ `OPEN` | ✔ |
| TU7（协调运行 `FAILED`）⇒ `NO_LIVE_RUN`，本次先 `ROTATE_COORDINATOR_SESSION` | ✔ |
| TU6：三档策略下判定都在；§9.2 的三格是 `REQUIRE_APPROVAL` / `ALLOW` / `ALLOW` | ✔ |
| 同一快照重放，`turn` 与 `actions` 逐字节相同 | ✔ |

`src/apiserver/src/projects/project-turn-reason.spec.ts` 覆盖纯序：六个谓词的**全部 64 个组合**
各断言「至多一条 turn、赢家是全序里第一个为真的、答案与遍历顺序无关」，外加 TR1 摘要的三条
性质与 §8.2 键的构成。

### 变异检验（确认断言真的在咬）

| 变异 | 结果 |
|---|---|
| TF6 的 `dispatchAttempt` 换成 `failureCount` | `not ok 5 - §7.6 TR1 / TF6: a new failure episode is a new key`（1 fail） |
| 去掉 TR1/TR3 的历史动作查找 | `not ok 6`（TR3）+ `not ok 7`（in-flight），2 fail |
| TU4 全序里 `VERDICT` 与 `TASK_FAILURE` 对调 | 3 fail（全序、cause-before-consequence、suppressed 复活） |

三次变异后均已还原（`cp` 备份还原，未用 `git checkout`）。

---

## 5. 执行记录

### 环境

| 项 | 值 |
|---|---|
| 主机 | Linux 6.12.38+deb13-cloud-amd64 |
| Node | v22.22.2（仓库 `engines` 要求 ≥26，本机只有 22；`npm install --engine-strict=false`） |
| npm | 10.9.7 |
| TypeScript | 7.0.2（原生二进制） |
| Prisma Client / CLI | 7.9.1 |
| PostgreSQL（pg spec） | `postgres:16-alpine`，一次性容器 `pcc26-pg`，tmpfs 数据卷，跑完 `docker rm -f -v` |

依赖：worktree 内独立 `npm install`（`/root/orbit/node_modules` 是 Prisma 5.22 / TS 5.9 的陈旧树，
对 `main` 当前的 Prisma 7 + TS 7 不可用，软链过去会得到一批假错）。

### 命令与关键输出

**基线**（改动前，同一 worktree、同一依赖树）：

```
$ npm test -w @orbit/apiserver   # = tsc -p tsconfig.test.json && node --test build/*/*.spec.js
# tests 2340
# pass 2094
# fail 0
# skipped 246          # pg spec 未设 COORDINATOR_PG_URL，自动跳过
```

**改动后**：

```
$ npm test -w @orbit/apiserver
# tests 2358
# pass 2112
# fail 0
# skipped 246
```

**本单元两个 spec 单独跑**：

```
$ node --test build/projects/project-turn-reason.spec.js build/projects/project-failure-turn.spec.js
# tests 18
# pass 18
# fail 0
```

**契约自检与反例模型**（改的是它们读的那些表，因此单独确认）：

```
$ node --test build/projects/coordinator-contract.spec.js
# tests 58 / # pass 58 / # fail 0

$ node --test build/projects/coordinator-counterexample.spec.js
# tests 116 / # pass 116 / # fail 0
```

**真实 PostgreSQL**（一次性库，每个文件之前 `DROP SCHEMA public CASCADE` + `prisma migrate deploy`）：

```
$ bash pgrun.sh project-decision.pg project-reconcile.pg project-dispatch-pass.pg \
      project-coordinator-driver.pg verify18-control-loop.pg project-control-surface.pg \
      project-events.pg project-e2e-recovery.pg project-e2e-acceptance.pg project-blocker.pg
project-decision.pg          1/1
project-reconcile.pg         1/1
project-dispatch-pass.pg    15/15
project-coordinator-driver.pg 6/6
verify18-control-loop.pg     5/5
project-control-surface.pg   5/5
project-events.pg            7/7
project-e2e-recovery.pg     17/17
project-e2e-acceptance.pg   28/28
project-blocker.pg          15/15
```

**踩到的两个 harness 坑**（都不是产品缺陷，记在这里免得下次重踩）：

1. `project-dispatch-pass.pg.spec.ts` 走 `project-e2e-harness.ts`，需要**完整迁移过的库**
   （`relation "project_acceptance_audit" does not exist`）。手搭子集不够，必须
   `prisma migrate deploy`。
2. 多个 pg spec 共用一个库顺序跑会互相污染，每个文件之前必须重建 schema 再 migrate。

### 未做

- 未改写任何历史失败 Session，未用任何形式的「完成」覆盖真实运行结果。
- 未改 Prisma schema、未加迁移（本单元没有新增列）。
- 未跑全部 32 个 pg spec，只跑了与决策 / 控制环相关的 10 个；其余与本改动无交集
  （身份迁移、purge、linearization 等）。
