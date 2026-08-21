# 25E-AC6 — 让验证结论在生产里真的发生

25E 独立验收判定第 6 条 FAIL：验证任务写 FAIL 之后，被验证任务没有被退回、没有缺陷子任务、下游没有被拦住。
本文记录这次修复的判断、改动、命令、关键输出与残留。所有数字都是跑出来或从库里数出来的。

## 缺陷

`ProjectVerificationVerdictService.apply` 是唯一写这三件事的路径，它被 `ProjectsModule` provide/export，
但全树的调用者只有三处，全是测试代码。`verificationVerdictPlan` 每一轮 reconcile 都算出完整的计划，
唯一的消费者是 §11.4 的条件检测器 —— 它抬一条 `VERIFICATION_FAILED` blocker，然后把剩下的丢掉。

所以线上的每一次 FAIL 都是：被验证任务仍是 DONE，没有缺陷子任务，`task_verification_failure` 一行都没有。
而那张表正是 `ProjectAuthorizationService` 在放行依赖任务之前读的表，于是**上游检查失败的下游任务照常派发**，
`GET /projects/:id/verifications` 的 `failures` 与 `blockedTasks` 结构性恒空。

覆盖它的 spec 全绿，因为每一个 spec 自己就是那个调用者。这与 §13.1 聚合（后来补了 `task-aggregation-writer`）
和 §7.8 派发（25D 补了 `project-dispatch-pass.service`）是同一个形状，只有 verdict pass 一直没有执行者。

## 选择哪条路

任务给了两条：(a) 在 reconcile 里 apply，(b) 仿 `task-aggregation-writer` 给一个写路径 applier。**选 (a)**，理由：

1. `apply` 需要 lease + 已持久化的 decision，三件后果的幂等性建立在 action ledger 的永久键
   `pc:v1:<project>:verdict:<verifier>:<revision>` 上。写路径 applier 拿不到这些，只能另写一套幂等，
   那就是第二份实现，也就是两条路径迟早对"已经做过"的判断不一致。
2. 这个键**带 verdictRevision 且不会前进**。派发的键带 `attempt`，被 `STALE_SNAPSHOT` 拒掉还能换新键重试；
   verdict 的键被拒一次就永久烧掉，那次结论的后果就永远丢了。放在 delivery 自己的事务里，
   §7.7 的 staleness gate 比较的是同一份快照，恒等成立 —— 这是唯一不会烧键的位置。
3. 第 11 条验收标准要求既有 Project 不被意外开启自动推进。coordinator 关掉的 Project 没有控制环，
   在里面把一个 DONE 任务退回并建子任务，正是那一条要防的事。**这是有意的边界，spec 里有一条 case 记着它**，
   并且结论不会丢：verdict 留在列上，把 coordinator 打开，下一轮就补上。

## 改动

| 文件 | 做了什么 |
|---|---|
| `project-reconcile.service.ts` | 新增 `ProjectVerdictExecutor` 接口与 `registerVerdictExecutor`（与 §7.5 rotation 同样的注册方式）；`handle` 里把待办的一条 verdict 作为 action 编进本轮 decision，在 rotation 之后、aggregation/blocker 之前 apply；剩余条数把 `next_wake_at` 压到 now |
| `project-verification-verdict.service.ts` | 实现该接口并在 `onModuleInit` 注册；`idempotencyKey` / `actionDetail` / `applyVerdictInTransaction` 三个方法，效果体与原 `apply` 共用一份 |
| `projects.service.ts` | `blockedTasks[].failureId` 改为 Base62（拦截器按字段名工作，够不到它） |
| `project-verdict-executor.spec.ts`（新） | 4 个 focused 用例：注册这件事本身、键带 revision、detail 无裸 UUID |
| `project-verdict-reconcile.pg.spec.ts`（新） | 6 个 pg 用例，全部走 `TasksService` 这道真门，不调用 `apply` |

一轮只 apply 一条：REPEATABLE READ 让事务看得见自己的写，两条里的第二条会被第一条的写效果判成
`STALE_SNAPSHOT`。rotation 与 verdict 同理，所以本轮做过 rotation 就把 verdict 让给下一轮。
剩下的不会丢 —— `next_wake_at` 被压到 now，`enqueueScheduledWakes` 立刻把它变成下一次投递。

已在 ledger 里的结论按永久键过滤掉，否则每一轮都会把历史上每一条结论重新提一遍，
在"一轮一条"下会把一个老检查已结清、新检查还没处理的 Project 饿死。

**没有碰 blocker 那条已经正确的路径**：`applyBlockers` 不走 staleness gate，直接写，位置也没动。

## 测试证据

环境：node v22.22.2、PostgreSQL 16-alpine（一次性容器）、Linux 6.12.38+deb13-cloud-amd64。
worktree 私有 `node_modules`（逐条软链），Prisma client 由**本分支** schema 生成（144 个迁移）。

| 套件 | 结果 |
|---|---|
| `tsc -p tsconfig.test.json` | rc=0 |
| apiserver 单测（228 个文件） | **2104 tests / 2079 pass / 0 fail / 25 skipped** |
| `scripts/project-pg-matrix.sh`（38 个 pg spec，每个一套新库） | **383 tests / 383 pass / 0 fail / 0 skipped / spec-level-red=0** |
| 其中 `project-verdict-reconcile.pg.spec` | 7 tests / 7 pass / 0 fail |
| 其中 `task-verification-verdict.pg.spec`（原有） | 17 / 17 |
| 其中 `project-blocker.pg.spec`（原有） | 15 / 15 |

## 真实 canary

用**本次构建的镜像**（`orbit-apiserver:ac6-c7f5f39f`）起一套一次性 postgres + apiserver，
走真实 HTTP 打完整流程 —— 这一步比 pg spec 多验一件事：`ProjectsModule` 经 Nest DI 启动之后
**确实注册了执行者**，而这正是原来缺的那件事。全程没有任何手工调用。

```
POST /api/auth/bootstrap                          # 建账号
POST /api/projects                                # AC6 live canary = 34Azsl8gARnuBmMFWcRaW
PATCH /api/projects/:id  {coordinatorEnabled:true, automationPolicy:GUARDED_AUTO}
POST /api/tasks x3       subject / downstream(dependsOn subject) / verification(verifies subject)
PATCH /api/tasks/:subject  {status:DONE}
PATCH /api/tasks/:verifier {status:DONE, verdict:FAIL}     # 12:39:17Z, verdictRevision 1
```

6 秒后（12:39:23Z），`GET /projects/:id/verifications` 无需任何手工操作：

```
subjectStatus            OPEN                     # 原来是 DONE —— 原生退回
failures[0].defectTitle  "[DEFECT] subject task"  # 状态 OPEN，parent = subject
failures[0].blocksDownstream   true
failures[0].actionStatus       APPLIED            # raisedByActionId 1vggit5N6sqygudjft3Evb
failures[0].resolvedAt         null
blockedTasks[0]  subject     SUBJECT_DEFECT_OPEN
blockedTasks[1]  downstream  UPSTREAM
```

再写一条独立的 PASS（12:39:48Z），31 秒内：

```
failures[0].resolvedAt        2026-08-21T12:39:48.613Z
failures[0].resolvedByTaskId  34Azu43syUDEmGbhUxT3U     # 后一次检查
blockedTasks                  []
```

四条验收标准逐条对上。canary 栈随后销毁。

## 提交

| SHA | |
|---|---|
| `c7f5f39f` | feat(projects): give the verification verdict a caller in production |
| `8fb90d34` | fix(projects): publicize the failureId the verifications surface now reaches |

基线 `feat/project = 288fe19d`，工作树开工时先 `git merge --ff-only feat/project` 对齐，全程无 `reset` / `stash` / `update-ref`。

收工时重查了目标分支：`feat/project` 已前进到 `a8114436`（同批的 AC1 P3 修复，把 refusal body 也过一遍
Base62 允许表）。两边**没有文件重叠**，且 `288fe19d` 是 `a8114436` 的祖先，所以合并是干净的。
已在一次性 scratch 分支上把两边合起来验过（合完即删，交付分支未被改动）：

| 合并后 | 结果 |
|---|---|
| `tsc -p tsconfig.test.json` | rc=0 |
| apiserver 单测 | **2111 tests / 2086 pass / 0 fail / 25 skipped** |
| `project-verdict-reconcile.pg` / `project-acceptance.pg` / `task-verification-verdict.pg` / `project-blocker.pg` | 7/7、18/18、17/17、15/15，全 0 fail |

值得记一笔的是两边在同一处相邻而不冲突：他们的 `public-id-body.ts` 对非 UUID 字符串是
`try/catch` 后原样放过，且 `failureId` 不在 `PUBLIC_ID_FIELDS` 里，所以本文这条手工 publicize
不会被二次编码。
`/root/.orbit/worktrees/feat-project-deploy` 的用户既有暂存内容全程未动（`README.md` `M` blob
`8da88cf699312bc74ed66da8f93d066ac53dc408`、`docs/project-agent-contract.md` `D`）。

## 残留与未做

- **没有合并到 `feat/project`，也没有部署**：按指示由 Coordinator 在本 Session 自然成功后按顺序合并。
  因此线上那三件后果**尚未生效** —— 它需要这次合并之后重建 apiserver。
- 构建 `orbit-apiserver:ac6-c7f5f39f` 时占用过 `orbit-apiserver:latest` 这个 tag（旧镜像记录此前已被清掉，
  无法原样还原），已用 `288fe19d` 重新构建把 `:latest` 放回合并前的源码状态；生产容器自始至终没有被 recreate。
- coordinator 关闭的 Project 仍然拿不到这三件后果，见上文"选择哪条路"第 3 点。若产品上认为这该改，
  那是另一个决定（等于放宽第 11 条），应该单独立项而不是夹带在这次修复里。
