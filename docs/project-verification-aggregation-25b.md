# 25B — Verification 关系、Verdict 与阶段聚合的原生化

> 单元 25B。基线 `feat/project` = `a4adabf9144d2d6177aba1f52bdfc4d4cbd390c0`（25A 原生验收 + P0 base62 修复）。
> 契约条款：§13.1（AC7 父任务聚合）、§13.2（AC6 验证 verdict 的原生后果）、§13.4/§13.5（AE 验收事实）。

---

## 1. 这一轮修的是什么

25A 之前，§13.1 与 §13.2 的**判断**已经写完并且是对的：`planTaskAggregation` 与
`planVerificationVerdicts` 是两个纯函数，`ProjectReconcileService` / `ProjectDecisionService`
把它们接进了控制环，`task.completion_policy`、`task.verdict`、`task.verdict_revision`
三列自 0123/0124 起就在库里。缺的是**两件让它们够不着的事**：

**（a）没有任何一扇门能建立 `verifiesTaskId`。**
这一列只有一个写入点 —— `TasksService.fileVerification`，一条由 `list.verifyOnDone`
或"完成但零执行记录"触发的**自动**路径。API / CLI / MCP 的 create 与 update 里都没有这个字段。
后果是连锁的：一个项目计划**无法**为某个阶段主动立一条验证；`completionPolicy: VERIFICATION_PASSED`
数的是"指向本任务的验证任务"，而没有任何调用方能往这个集合里加一条，于是这个策略永远不会完成任何东西；
`task_update` 的 `verdict` 参数（早已存在）对任何调用方能创建的任务都会被
`Only a verification task can carry a verdict` 拒掉 —— 它是一封死信。

**（b）聚合只在 reconcile 里跑，而 reconcile 只对 `coordinator_enabled = true` 的 Project 跑。**
`ProjectReconcileService.deliver` 第一件事就是读 `coordinator_enabled`，为假直接返回（AC11
要的正是"存量 Project 不被静默自动推进"）。而 `completionPolicy` 是 **Task 上的一列**：
它由普通任务门写入，在完全没有 Project 的任务上也合法，本部署里**每一个** Project 的
`coordinator_enabled` 都是 false。于是"把阶段父任务设成 ALL_CHILDREN_DONE"这句话在实际系统里
等于"什么也不会发生"，AC7 承诺的"无需人工维护纯汇总节点状态"仍然要靠人写状态。

---

## 2. 改了哪些东西

### 2.1 关系的门（§13.2）

| 位置 | 变化 |
| --- | --- |
| `CreateTaskDto.verifiesTaskId` | 新增，`@IsPublicId()`（base62 与裸 uuid 都收，其他一律 400 且指名字段） |
| `UpdateTaskDto.verifiesTaskId` | 新增，三态：省略保持 / `null` 摘除 / id 改指 |
| `CreateTaskBatchItemDto.verifiesRef` | 新增，指向**更靠前**的批内 item；与 `verifiesTaskId` 互斥 |
| `TasksService.assertVerificationEligible` | 四条拒绝：不能验证自己、subject 不能本身是验证、subject 必须同属主、必须**同 project** |
| `TasksService.assertHierarchyConsistent` | 改 project 时，若本任务验证着别的任务、或被别的任务验证，一律拒绝（关系的另一侧） |
| `orbit task create/update` | `--verifies-task-id` / `--clear-verifies`，并登记进 CLI↔MCP parity 表 |
| `Transport.updateTask` | 带上 `X-Orbit-Session-Id`（见 §2.2） |
| MCP `task_create` / `task_update` / `task_create_batch` | `verifiesTaskId`（update 可为 null）与批内 `verifiesRef` |
| `TASK_LIST_SELECT` / `PROJECT_TASK_TREE_SELECT` | 补 `verifiesTaskId` / `completionPolicy` / `verdict` —— 计划是从这两个投影读的 |

"同 project"是这四条里最安静的一条：聚合是在**一个 project 的任务集合**上做计划的，
跨 project 立的验证**没有人数得到它**，`VERIFICATION_PASSED` 会把它当成"零条检查"。
同一条规则也补进了自动路径 —— `fileVerification` 过去建的验证任务 `project_id` 恒为 NULL，
于是它检查过的每一条 project 任务，其验证都**不出现在** `GET /projects/:id/verifications` 里
（那个查询就是按这一列过滤的）。

### 2.2 独立 Session 约束（§13.2 V1 的执行面）

结论由**写入门**拒绝，而不是由简报里的一句中文承担：

> A verification cannot be concluded from the session that ran the task it verifies —
> the check has to be an independent run.

判据只有一条关系：作出结论的那次运行，它自己的 `session.task_id` 就是被验证的那个任务。
人在无 session 下作结论、协调器用自己的 session 作结论、验证任务自己的运行作结论，都不受影响。

这条规则要能触发，两端都得改：`PATCH /runner/tasks/:id` 现在读 `x-orbit-session-id`（此前只有
create 路径读它），而 runner 侧的 `Transport.updateTask` 此前**根本不发**这个头 —— MCP
`task_update` 与 `orbit task update` 都从 create 路径同样的 `ORBIT_SESSION_ID` 取值并带上它。
不带头的调用（终端不在 session 里、Web 用户门）没有"作出结论的那次运行"可言，规则对它们不适用。

### 2.3 聚合在写入路径上跑（§13.1 AG1/AG5）

新增 `src/apiserver/src/projects/task-aggregation-writer.ts`：

- `collectAggregationScope` —— 从种子任务出发，沿 **parent / child / verifies / verified-by**
  四条关系做闭包，上限 500 个任务（超过则本次不做，交给下一次写入重算）。
- `applyTaskAggregations` —— AG5 那条 CAS，逐条 `status = :from` 条件写，影响 0 行是正常结果。

`TasksService` 在**能改变它输入的写入之后**调用它：`update`（status / completionPolicy /
verdict / parentTaskId / verifiesTaskId 任一被写）、`create`（带 parent 或 verifies）、
`createMany`、`remove` 与 `batchDelete`（链接在 `deleteAndStopRuns` 那条已加锁的 SELECT 里读出，
删除之后就问不到了）。

两点是刻意不做的：

- **不派发。** 父任务变 DONE 不释放下游、不启动任何运行 —— 那是 §7.4 的决定，属于被授权花钱的那个环。
- **不进动作账本。** AG5 冻结的形状就是无幂等键的重算；reconcile 与这里算的是同一个计划，
  重复应用是无操作，这正是 AG1 的性质。

### 2.4 父任务不能靠手写状态绕过策略

`status: DONE` 写在一个 `completionPolicy != MANUAL` 且**有子任务**的任务上，直接 400：

> This task completes by VERIFICATION_PASSED, not by a status write — its N subtask(s) and its
> verifications decide when it is DONE.

AG4 的条件逐字照搬（策略对无子任务的任务无效），所以只在策略真的在回答问题时才拒绝。
`MANUAL` —— 0123 之前每一个任务的值 —— 完全不受影响：子任务决定不了它，状态写入决定一切。

---

## 3. 证据

### 3.1 运行环境

| 项 | 值 |
| --- | --- |
| 工作树 | `/root/.orbit/worktrees/01a02297-d2f9-7723-891e-3eb869f71954`，分支 `orbit/25b-verification-verdict-d0f108` |
| 基线 | `a4adabf9144d2d6177aba1f52bdfc4d4cbd390c0`（`git rebase main` no-op → `git rebase feat/project` 快进 → `git merge --ff-only feat/project` = Already up to date） |
| Node | v22.22.2 |
| Prisma | 5.22.0，`@prisma/client` / `.prisma` 为**本工作树实体副本**，按本分支 schema 重新 generate（`/root/orbit` 的共享 client 未被写入，已逐目录核对） |
| `@orbit/shared` | 指向本工作树 `src/shared` 并在跑测试前重新 `tsc` |
| PostgreSQL | `postgres:16-alpine` 一次性容器 `pcc25b-doors-pg16`（127.0.0.1:55480），跑完即删 |
| 一次性数据库 | `pcc25b_tmpl` 模板 + 每个 pg spec 一个 `pcc25b_sN` 克隆，用完即 DROP |
| 共享 `orbit-postgres` | **未触碰** |

### 3.2 新增测试

- `src/apiserver/src/tasks/task-verification-link.spec.ts`（10 条，纯单元）：base62 入参解码、
  三态语义、两个投影都带上三列、批内 `verifiesRef` 的向后引用/互斥/检查之检查/跨 project 四条拒绝。
- `src/apiserver/src/tasks/task-verification-doors.pg.spec.ts`（13 条，真库）：全部走
  `TasksService`，Project 的 `coordinator_enabled` **保持 false**，衡量的正是"没有控制环的调用方
  实际得到什么"。含**真实阶段 fixture**：一次 `task_create_batch` 立下阶段 + 两个子任务 + 一条验证，
  手写 DONE 被拒，子任务全 DONE 后阶段仍 OPEN（还欠检查），INCONCLUSIVE 不算通过，PASS 之后
  阶段**自动**变 DONE 且发出了 TASK_CHANGED；撤销 PASS / 改 FAIL / 重开子任务 / 子任务转 FAILED
  四种情况各自把阶段退回 OPEN。
- `src/runner-go/task_cli_test.go`：`--verifies-task-id` 逐字节到达服务端、`--clear-verifies`
  必须是显式 JSON null、空值与互斥的拒绝，以及 `task update` 在 session 内必须带
  `X-Orbit-Session-Id`、在 session 外必须**不带**这个头。
- MCP 侧用 stdio 实机驱动核对（`initialize` + `tools/list`）：`task_create.verifiesTaskId` 为
  `string`、`task_update.verifiesTaskId` 为 `["string","null"]`、`task_create_batch` 的 item
  同时有 `verifiesTaskId` 与 `verifiesRef`。

### 3.3 反向对照（证明测试确实在量新行为）

把**构建产物**里的 `recomputeAggregates` 改成直接 `return []`（不改源码），重跑同一个 pg spec：

```
# tests 12 / # pass 6 / # fail 6
```

恢复后 13/13 全绿。

### 3.4 回归

| 命令 | 结果 |
| --- | --- |
| `tsc -p src/apiserver/tsconfig.test.json` | exit 0 |
| `node --test "build/**/*.spec.js"`（不设 `COORDINATOR_PG_URL`）**基线 a4adabf9** | tests 2216 / **pass 1988 / fail 0** / skipped 228 |
| 同上，**本分支** | tests 2227 / **pass 1998 / fail 0** / skipped 229 |
| `go build ./...` · `go test ./...` | 通过（`ok orbit`） |
| `src/web` `vitest run` | **57 文件 / 829 通过 / 0 失败** |
| `bash scripts/project-pg-matrix.sh` | 31 spec / **tests 326 / pass 326 / fail 0 / skipped 0**，脚本 exit 0（见 §3.5） |

### 3.5 PG 矩阵：`scripts/project-pg-matrix.sh`

新增。`scripts/project-e2e.sh` 给它那两个 suite 一个全新库；这个脚本给**每一个** pg spec 一个，
因为第一次不这么跑的时候发现：31 个 spec 共用一个库，`coordinator-identity-migration.pg.spec`
的 DDL 之后，排在它后面的每一个 spec 都在一个被那条 spec 改过的 schema 上被测量。

```
PCC_PG_LOG_DIR=/tmp/pcc25b-logs bash scripts/project-pg-matrix.sh
```

一次跑完 31 个 spec：起一次性容器 → 建模板库并 `prisma migrate deploy` → `tsc` 两棵测试树
→ 每个 spec 一个克隆库 → 跑完删库 → 删容器，最后清掉自己产生的
`build-project-reconcile-faults/`（`.gitignore` 也一并补上了这两棵 fault 树的目录名，
它们过去会在工作树里留下几百个未跟踪的 `.js`/`.map`）。

**失败的定义是 `node` 的退出码**：断言失败、崩溃、超时、以及"因为有句柄没关而永远不退出"，
一律计为失败并让脚本以非零码结束。`timeout` 只是保险，任何情况下都不算通过。

这一轮它逼出了四件事，都不是产品缺陷，但都会让矩阵**假绿或假红**：

| # | 现象 | 真因 | 处置 |
| --- | --- | --- | --- |
| 1 | `coordinator-service-linearization` 挂住不退（全部连接 idle/ClientRead，无 active query、无锁等待） | `open()` 先建三条连接（`pg.Client` + 两个 `PrismaClient`），再 `wipe()`、建 fixture，最后才把带 `teardown` 的对象**返回**；中间任何一次抛出，三条连接就都没人关 | 加 `release()` 并在这段窗口包 try/catch；`teardown` 改成"wipe 尽力而为、release 一定执行" |
| 2 | `project-control-surface` 1/3/5 号失败 | **25A 遗留**：`coordinatorStatus` 新增了 `ProjectAcceptanceService.summary()`，而该 spec 手搭的 prisma 没有 `projectAcceptanceRun` 这张脸；5 号裸 `UPDATE project SET status='DONE'` 撞上 25A 的 `project_acceptance_done_gate` | fixture 加一个**真** `PrismaClient` 专供 acceptance service；5 号改成走 `openRun` → `finalizeRun`(全 PASS) → 一条语句同时写 `status` 与 `accepted_run_id`（BD1）。**门一点没动** |
| 3 | `project-reconcile-fault-injection` 3/4 号失败 | 它 spawn 的子进程 require `./build-project-reconcile-faults/…`，那是**它自己那份 tsconfig** 的产物；从 `build/` 跑，子进程在注入的 SIGKILL 之前就 MODULE_NOT_FOUND 了 | 前置构建步骤进脚本，并从那棵树里跑它 |
| 4 | `steer-dequeue` 11 条全灭 | 它是**自带 schema** 的（文件头写着"any empty Postgres … not the application schema"），拿到迁移过的克隆库后 `DROP TABLE "session"` 撞上依赖对象 | 它拿一个**空**库；不是把它变回 skip |

另外补了 `COORDINATOR_PG_RESTART_COMMAND=docker restart <container>`：一次性容器本来就能重启，
不给这个变量，`project-dispatch-boundary-verification` 的"a real server restart does not
duplicate or lose an applied dispatch" 会静静地 `# SKIP` —— 而那恰好是最需要真服务器的一条。

**第 1 条的复现与验证**（在克隆库上 `ALTER TABLE task RENAME TO ...` 制造 `open()` 抛出）：

| 版本 | 结果 |
| --- | --- |
| 修复前（只改构建产物做对照） | 60s 被 `timeout` 杀掉，`rc=124`，**没有任何 `# tests` 行** |
| 修复后 | 3.5s 退出，`rc=1`，`# tests 9 / # pass 0 / # fail 9` —— 诚实的失败 |

第 2、3、4 条中的 2 号在**基线 `a4adabf9` 上逐字复跑，同样 3 红**，因此确认是 25A 的遗留而非本轮引入。

---

## 4. 已知的边界与遗留

- **不改契约正文。** §13.1 AG1/AG5 说的是"聚合是一次重算，形状是 CAS，没有幂等键"，
  没有说它只能发生在 reconcile 里；写入路径上应用同一条 CAS 与之一致。真正跟着变的是
  §13.1 在**关掉协调器的项目上是否生效**，这一条写在这里而不是去改一份冻结的规范。
- **聚合不派发。** 依赖某个阶段父任务的下游任务不会因为该父任务被策略完成而自动开跑；
  这是刻意的（见 §2.3），需要的话由控制环或人来启动。
- **§13.2 的完整机械后果（退回 subject、建缺陷子任务、阻断下游）仍然只在 reconcile 里执行**，
  因为它们是带永久幂等键的账本动作，需要租约与 decision id。本轮打通的是**关系**、
  **策略驱动的退回/完成**与**项目验收采集**；把账本动作也搬到写入路径上是另一个单元的事。
- **线上 dogfood 需要一次部署**：本分支合入 `feat/project` 后，线上 apiserver 需重建才能用上
  新的门。部署由用户执行（`docker compose` 在 auto 模式下被拦）。
