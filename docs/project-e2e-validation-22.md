# 22 端到端迁移、恢复与故障注入验收

验证日期：2026-08-20（Europe/Berlin）
任务：`349bQHBEWJqmRhVpZipSq`
基线提交：`1a183910f9c125ad56fb9f21e0391c9fe172427c`（`feat/project`）
任务分支：`orbit/22-459bbf`
任务 worktree：`/root/.orbit/worktrees/01a020c6-9e3a-73a0-af98-9ba8fc728006`

## 结论

端到端套件已建立并可独立重复运行：一条命令从零起一个一次性 PostgreSQL、跑完整迁移、跑两个
E2E 套件、再对结果跑 §10.3 活性 SQL 断言，最后销毁数据库。44 个端到端场景全部通过，覆盖项目
验收 1–11 的每一条，每条至少有一个"该条不成立就会红"的断言。

验收过程中发现并修复了 **2 个真实产品缺陷**（均由套件先复现、修复后由套件回归守住），
记录了 **2 条不修复的偏差**（一条实现弱于接口文档承诺、一条契约与实现命名不一致），详见
[发现](#发现)。

三条硬性要求逐条核对：

- **每种故障都收敛到五种状态之一**：故障注入套件的每个场景在结束时都会对整库跑一次
  `scripts/project-liveness-audit.sql`，任何"OPEN + 已启用 + 非等待人工 + 非终态"却四条活性
  子句全不成立的 Project 都会让该场景直接失败。16 个场景全部通过，即注入的故障没有一次留下
  静默空转的项目。该断言本身是可证伪的：`AC3: the audit FAILS for a project that stopped its
  own clock` 手工制造违约，断言审计必须变红。
- **无静默 fallback / 重复启动 / 越权**：provider 缺席只会拒绝并开 blocker（不换 provider）；
  同一幂等键重放得到 `ALREADY_APPLIED` 且只有一条 session；旧二进制的裸 SQL 派发被 D6 触发器
  拒绝、`dispatch_origin = 'USER'` 的第二条活 session 被 D5 唯一索引拒绝。
- **迁移前后兼容**：空库 141 条迁移全绿；老 Project 行落在"关闭 + MANUAL + LEGACY 派发权"，
  其事件被 `DISCARDED_OUT_OF_LOOP` 丢弃且不产生任何 action/decision/blocker/session/唤醒；
  打开控制环必须显式给 `automationPolicy`，否则 400 且不写任何东西。

## 交付物

| 文件 | 内容 |
| --- | --- |
| `scripts/project-e2e.sh` | 一条命令：起容器 → `prisma migrate deploy` → 编译 → 两个套件 → 活性审计 → 销毁 |
| `scripts/project-liveness-audit.sql` | 契约 §10.3 的四子句活性断言，只读，可直接对生产快照跑 |
| `src/apiserver/src/projects/project-e2e-harness.ts` | 生产服务图装配 + 夹具 + 只走"门"的驱动器 |
| `src/apiserver/src/projects/project-e2e-acceptance.pg.spec.ts` | 验收 1 / 4 / 5 / 6 / 7 / 8 / 10 / 11，28 个场景 |
| `src/apiserver/src/projects/project-e2e-recovery.pg.spec.ts` | 验收 2 / 3 / 9，16 个场景，含真实 SIGKILL 与真实数据库重启 |
| `docs/project-e2e-validation-22.md` | 本报告 |

产品修复（2 处）与被迫跟进的既有夹具（2 处）见[变更范围](#变更范围)。

### 为什么不是"调内部 helper 冒充端到端"

套件里没有一个场景自己做判断。每个场景只做三件事：**从门进去**、**让环自己跑**、**读一条
别人也能读到的事实**。

- 用户动作走 `ProjectsService`（`create` / `createInSession` / `update` / `coordinator` /
  `triggerCoordinator` / `coordinatorStatus` / `blockers` / `verifications` / `taskPage`）——
  即 `ProjectsController` 每条路由背后的那一层；
- 事件投递走 `ProjectEventsService.drainOnce()`，即 outbox 消费者本身，reconcile 在投递事务里
  作为已注册 handler 被调用；
- 时钟走 `ProjectReconcileService.tick()`；
- 动作由三个生产 service 执行（`ProjectTaskDispatcherService` / `ProjectCoordinatorSessionService`
  / `ProjectVerificationVerdictService`），每次都先按 §8.3 落一条 decision 再认领幂等键；
- Base62 断言跑在 `PublicIdInterceptor` 之后 —— 服务层按设计返回 UUID，拼写发生在拦截器，
  断在拦截器之前等于断在边界的错误一侧。

数据库是 `prisma migrate deploy` 建的真库（141 条迁移），不是手搭子集：本单元要验的正是触发器、
偏索引和裸 SQL 的列名，手搭子集只会和它自己一致。

## 隔离环境与护栏

- PostgreSQL 容器：`pcc22-e2e-pg16`，镜像 `postgres:16-alpine`，PostgreSQL `16.14`。
- 绑定：`127.0.0.1:55470 -> 5432`；database `pcc22_e2e`；role `pcc22_admin`。
- Node `v22.22.2`；Prisma / `@prisma/client` `5.22.0`；Go `go1.24.4`。
- 每个 spec 在第一次写入前先过 `coordinator-pg-test-safety`：`pcc*` 命名 + database + role +
  `system_identifier` 三重校验；复制来的生产 URL 会在任何写入之前失败。
- 任务 worktree 用软链 `node_modules`（基底 `/root/.orbit/worktrees/pcc14-34amsq-20260820`），
  `@prisma/client` 与 `.prisma` 为**实体拷贝**后按本分支 schema 重新 generate，因此没有碰主仓
  共享 client；`/root/orbit` 工作树全程 clean。
- 协调部署 worktree `/root/.orbit/worktrees/feat-project-deploy` 的用户暂存状态全程未动：
  `M README.md` / `D docs/project-agent-contract.md`，staged binary diff SHA-256 恒为
  `966c46d48ff68e27f9a479eca869e92a8f203d6c2a4466eaa8d48a2d9fcf8105`，无 unstaged diff。

## 验收证据映射（1–11）

每一行的"场景"是断言的名字，可在对应 spec 里逐字搜到。

| 验收 | 场景 | 证据 |
| --- | --- | --- |
| **1** 稳定 coordinator + 可轮换 Session + Base62 | `AC1: a project recorded in a session is bound to it in one insert` | 一条 INSERT 同时落 `coordinator_session_id`、`coordinator_workspace_id`、`project_member(COORDINATOR)`、`project_runtime`；新项目 `coordinatorEnabled=true` / `GUARDED_AUTO`；第二个项目认领同一 session → 409 |
| | `AC1: asking for the coordinator twice returns the same conversation` | 第二次 `created:false`，全库仍只有 1 条协调 session |
| | `AC1: the loop replaces a dead coordination run and keeps WHO and WHERE` | session 结束 → 环自己 ROTATE；`coordinator_generation` 0→1；agent 与 landing 不变；ledger 键 `…:rotate:1`；该动作可由 `replay` 追溯到提出它的 decision |
| | `AC1: every id the control surface serves is Base62` | 5 个读接口过 `PublicIdInterceptor` 后无一处裸 UUID；`project_decision.outcome` 与 blocker `detail` 在**落库时**就已是 Base62 |
| **2** 事务 outbox / 重复 / 乱序 / 崩溃 / 重启 | `AC2: a duplicate signal is one row and one pass` | 同 dedupe key 投 3 次 → 1 行、`occurrences=3`、只跑 1 次 pass |
| | `AC2: an out-of-order signal does not resurrect an older world` | 后到的旧信封不覆盖 newest；消费时任务已被删除，decision 快照里 `tasks: []`（读世界不读 payload） |
| | `AC2: a delivery that throws retries with backoff and consumes nothing` | `RETRY_SCHEDULED`，`consumed_at` 仍空，`next_attempt_at` 在未来，退避未到不重投 |
| | `AC2: a batch that never succeeds dead-letters into a named blocker` | 第 10 次后 `disposition=DEAD`，runtime 落 PLANNING + 未来唤醒 + 写明 dead letter 的原因（另见 F-22-02） |
| | `AC2: SIGKILL before the commit rolls the whole pass back` | 子进程在投递事务里被真 `SIGKILL`：decision/action/`consumed_at`/租约全部回滚，接管者补跑且只跑一次 |
| | `AC2: SIGKILL after the commit does not replay it` | 提交后被杀：`consumed_at` 与 decision 保留，接管者 `IDLE`，不重放 |
| | `AC9: a real database restart resumes the pending work` | `docker stop/start` 后全新 service：`next_wake_at` 逐毫秒不变，队列里的信号照常投递 |
| **3** 活性 SLO | `scripts/project-liveness-audit.sql` + 16 个场景的收尾断言 | 每个故障注入场景结束都跑一次整库审计，必须 0 行 |
| | `AC3: every legal shape passes the §10.3 audit` | (a) 用户手动起的活 session、(c) 五字段齐全的 blocker、(d) 只有时钟的 PLANNING —— 三种都判"没空转" |
| | `AC3: the audit FAILS for a project that stopped its own clock` | 手工清空 `next_wake_at` → 审计恰好报 1 行、四子句全 false；一轮 backstop 后恢复，耗时有上界断言 |
| | `AC3: a project waiting on an escalated person is not reported as stalled` | §10.4 N-null 的唯一合法停钟形状不被 backstop 误报；blocker 一解除就立刻被报（可证伪，见 F-22-03） |
| | `AC3: a state change converges inside the bound` | 用户触发 → runtime 发布，实测 < 5s（§10.2 事件路径 p95 目标） |
| | `AC8: an exhausted retry budget is a blocker, and the backoff before it is not` | 退避期内**不开** blocker（§9.5 Q3-a），但有确定的 §10.4 clause 3 唤醒 |
| **4** 三种策略 + 权限/并发/预算/重试/退避/审批 | `AC4: MANUAL never dispatches on its own — it asks` | MANUAL 拒绝 `POLICY_REQUIRES_APPROVAL` 且不建 session；审批指向别的键 → `APPROVAL_TARGET_MISMATCH`；绑定本键的审批 → `APPROVAL_GRANTED` 并派发 |
| | `AC4: guarded-auto runs routine work and stops at the risky row` | 常规行 ALLOW；`DISPATCH_MAX_ATTEMPTS` 行在任何策略下都要人批（`MAX_ATTEMPTS_REACHED`） |
| | `AC4: AUTO dispatches, and the concurrency cap denies the second` | 上限=1：第一条 APPLIED 并在提交后通知 runner，第二条 `PROJECT_CONCURRENCY_LIMIT` DENY |
| | `AC4: the daily session budget denies rather than silently skipping` | 预算=1：第二条 `SESSION_BUDGET_EXHAUSTED`，并落 `BUDGET_EXHAUSTED` blocker |
| **5** 一致快照 + 决策审计 + 幂等键 | `AC5: the decision audit replays byte-for-byte from its own input` | 每条 decision 的 `replay` 四项全 true（hash / outcome / actions 可追溯 / matches） |
| | `AC5: an applied action is exactly-once under its key` | 同键第二次 `ALREADY_APPLIED`、指向同一 ledger 行，session 与 action 各恰 1 条 |
| **6** 验证失败的退回 / 缺陷子任务 / 下游阻断 | `AC6: a FAIL reverts the subject, files a defect and blocks downstream` | 被验任务从 DONE 退回、缺陷子任务落库、`task_verification_failure` 落库；下游任务**状态不动**但派发被拒（机械阻断，非提示词） |
| | `AC6: a later PASS clears the condition and the work may move again` | 重跑通过 → 条件按 §11.4 重算清除，failure 行标 resolved 而非删除 |
| **7** 父 Task 聚合策略 | `AC7: ALL_CHILDREN_DONE closes the parent with nobody maintaining it` | 子全 DONE → 父自动 DONE；子重开 → 父重开；不占用任何 action ledger 键（AG5） |
| | `AC7: VERIFICATION_PASSED holds the parent until the check concludes` | 子全 DONE 仍不关；验证 PASS 才关 |
| **8** 结构化 blocker + 去重升级 + 不静默 fallback | `AC8: an unavailable provider is a blocker, and a fallback is only ever explicit` | 拒绝而不换 provider；blocker 五字段齐全；世界恢复后按重算自清 |
| | `AC8: no matching runner is a blocker that clears when one comes back` | runner 离线 → `NO_MATCHING_RUNNER`；上线后派发成功并自清 |
| | `AC8: a merge conflict names the branch and the paths` | `MERGE_CONFLICT` 带目标分支与冲突路径集 |
| | `AC8: waiting on a person has an owner, an action and an escalation` | `owner=USER` / `recovery=HUMAN` / `requiredAction` / `nextCheckAt` 齐全；run_state=AWAITING_HUMAN；升级只发生一次 |
| | `AC8: the same cause does not open a second episode` | 同因三次尝试 → 仍 1 个 episode、`lifecycle_generation=1`、occurrences 累加 |
| | `AC9: a runner going offline is a blocker, and its heartbeat clears it` | reaper 落实"心跳变陈旧"这条时间边，0118 触发器把信号扇出到相关 Project |
| **9** 崩溃 / Session 结束 / Runner 离线 / 接管 / 混合版本 | `AC9: two instances contend and exactly one holds the project` | 并发取租约恰一胜者；过期后接管且 `fencing_token` 单调；被逐出者的动作在 effect 之前被拒 |
| | `AC9: a coordination run that ended is replaced without losing the graph` | 协调 session FAILED → 轮换；任务数不变、已派发任务不会被再启动一次 |
| | `AC9: a binary that does not know the loop exists cannot double-dispatch` | 无派发权的裸 SQL 插入 → `DISPATCH_AUTHORITY_VIOLATION`；`origin=USER` 的第二条活 session → 唯一索引拒绝 |
| | 以及上面 AC2 的两个 SIGKILL 场景与数据库重启场景 | 进程接管与混合版本恢复 |
| **10** API/CLI/Web 展示与控制面 | `AC10: coordinator status answers empty, legacy, running and blocked` | 空态给 `NO_OPEN_BLOCKER` / `NO_DECISION_YET` / `NO_WAKE_SCHEDULED` 这类**具名空原因**而不是空白；legacy 读作"未启用"；受阻项目给出 blocker、最近决策、下次唤醒 |
| | `AC10: a trigger composed against a stale revision is refused, and writes nothing` | `STALE_CONFIG_REVISION` 且事件数不变；同 `triggerId` 双击合并为一条信号；关闭后 `COORDINATOR_DISABLED` |
| | `AC10: the blocker face keeps the resolved episode` | `?history=1` 仍能答"一小时前是什么在挡"，`resolvedBy=AUTO` |
| | CLI：`go test -run Project ./...`（85 通过） | `project_cli.go` / `mcp_project_test.go` / task-project 作用域 |
| | Web：`vitest run`（54 文件 / 797 通过，含 `coordinatorStatus.test.ts` 41 条） | 控制面派生逻辑 |
| **11** 存量兼容与安全默认 | `AC11: a project written by the old binary lands outside the loop` | 列默认：`coordinator_enabled=false`、`MANUAL`、`config_revision=0`；task 落 `LEGACY` / `MANUAL`；runtime 行由迁移/触发器补齐且 `next_wake_at` 为空（G2） |
| | `AC11: signals from a legacy project are discarded, never acted on` | 事件照产（N1），但全部 `DISCARDED_OUT_OF_LOOP`；0 action / 0 decision / 0 blocker / 0 session；backstop 不扫它（W4-b） |
| | `AC11: turning the loop on requires naming a level, and says so to the loop` | 不给策略 → 400 且不写；给了 → `config_revision` +1、同事务产 `user.policy_changed`、派发权投影扇出到全部 task（G3 / D3） |
| | `AC11: a decision captured before blockers existed replays to what it decided` | 抹掉 `world.blockers` 的 pre-0125 快照 replay 后**不长出** blocker 审计，且仍有时钟 |
| **12** 项目级验收与合并门禁 | 不在本单元 | 由 23 单元执行 |

## 故障注入矩阵

| 场景 | 注入 | 结果 |
| --- | --- | --- |
| 重复投递 | 同 dedupe key ×3 | PASS：1 行 / occurrences=3 / 1 次 pass |
| 乱序投递 | newest 之后写同键的 older | PASS：保留 newest；决策读当前世界 |
| 投递失败 | handler 抛异常 | PASS：`RETRY_SCHEDULED` + 退避，未消费 |
| 永久失败 | handler 恒抛，重试到上限 | PASS：第 10 次 `DEAD`，留恢复时钟与可读原因 |
| 提交前崩溃 | 投递事务内真实 `SIGKILL` | PASS：整轮回滚，接管补跑一次 |
| 提交后崩溃 | `afterCommit` 内真实 `SIGKILL` | PASS：已提交内容保留，不重放 |
| 数据库重启 | `docker stop` + `docker start` | PASS：唤醒时刻与待投事件都恢复 |
| 双实例竞争 | 两个 service 同时取租约 | PASS：恰一持有者 |
| 陈旧 fence | 被逐出者提交动作 | PASS：effect 之前被拒 |
| Provider 不可用 | 任务 pin 一个不存在的 provider | PASS：拒绝 + blocker，不静默换 |
| 无匹配 Runner | runner OFFLINE | PASS：`NO_MATCHING_RUNNER` blocker |
| Runner 心跳陈旧 | 回拨 `last_heartbeat_at` + reaper | PASS：置 OFFLINE 并扇出事件 |
| 合并冲突 | session `merge_status='conflict'` | PASS：blocker 带分支与路径 |
| 测试失败 / 重试耗尽 | 5 条 FAILED session | PASS：退避期内无 blocker，耗尽后 `TEST_FAILED` |
| 预算耗尽 | `sessionBudgetPerDay=1` | PASS：`SESSION_BUDGET_EXHAUSTED` + blocker |
| 等待用户 | 指派 agent 被禁用 | PASS：`WHO_DISABLED`，owner=USER，升级恰一次 |
| 协调 Session 崩溃 | 协调 session 置 FAILED | PASS：轮换且不丢任务、不重复启动 |
| 混合版本写入 | 旧 sweep 形状的裸 SQL 插 session | PASS：D6 拒绝；`origin=USER` 的第二条被 D5 拒绝 |
| 停钟违约 | 手工清空 `next_wake_at` | PASS：审计变红 → backstop 修复 → 审计变绿 |
| 合法停钟 | 全部 open blocker 为 HUMAN 且已升级 | PASS：不误报（F-22-03 修复后） |

## 发现

### F-22-01（已修复，P1）：决策审计把自己合法执行的动作报成"无法追溯"

`ProjectDecisionService.replay` 判断"这条 action 是不是该 decision 提出的"时，把
**计划里的键**（Base62 拼写，§8.2 规定审计一律 Base62）与 **ledger 行的键**（内部 UUID 拼写，
§8.2 规定 ledger 用内部 id）直接 `===` 比较；而真正的执行门
`applyDecisionActionInTransaction` 在同一判断上是先用 `publicIdempotencyKey` 归一化再比的。

两处对"同一把钥匙的两种拼写"取了不同口径，于是**每一条真正执行过的动作都会被 replay 判为
不可追溯**。今天由编排器自己计划的动作只有 `ROTATE_COORDINATOR_SESSION`（`plannedActions`
从 Base62 快照里生成键，执行器用 `lease.projectId` 认领），因此**任何轮换过协调 session 的
项目，`replay().matches` 恒为 false** —— 读起来像"控制环干了它没决定的事"，正是不能长期为真的
那种告警。

复现（修复前）：

```
ledger : pc:v1:9eafd29b-09dd-4de7-aa73-cfcb78a32df7:rotate:1
planned: pc:v1:4pR8bkPq1NPCsRWtJUp1U7:rotate:1
replay : {"matches":false,"hash":true,"outcome":true,"traceable":false}
```

既有测试没抓到，是因为单元 11 的 pg spec 在计划与 ledger 两侧用了**同一个 UUID 拼写的键**，
从未走过生产真正会写的那种键形。

修复：`replay` 的比较改为与执行门同一口径（两侧都过 `publicIdempotencyKey`）。
回归：`AC1: the loop replaces a dead coordination run and keeps WHO and WHERE` 与
`AC5: the decision audit replays byte-for-byte from its own input`。把这行改回去，这两条立刻变红
（实测 28 → 25 pass / 3 fail），即断言确实压在修复上。

### F-22-02（未修复，P2，本单元范围外）：dead-letter 不开 blocker

`ProjectEventHandler.deadLetter` 的接口注释写的是"必须原子地持久化 blocker 单元提供的
fail-closed `UNKNOWN_FAILURE` 状态"，而 `ProjectReconcileService.deadLetter` 实际只写
`run_state=PLANNING` + 5 分钟后的唤醒 + 一条写明 dead letter 的 `next_wake_reason`，**不开
blocker**。原因是事件单元（05）早于 blocker 单元（17）落地，这条路径没跟上。

影响是 P2 而不是 P0：项目**没有**静默空转（时钟与原因都在，§10.3 clause (d) 成立，活性审计通过），
只是这类失败没有出现在"所有停下来的原因都在同一张脸上"的那张脸上。修它要按 §11.3 的去重/升级
语义往 blocker 表里写，属于 17 单元的机械，不是本单元能顺手做对的一行。

已在 `AC2: a batch that never succeeds dead-letters into a named blocker` 里**如实断言当前行为**
（包括显式断言"今天这条路径不开 blocker"），并在断言旁标注 F-22-02；行为改变时该断言会红，
提醒改断言而不是悄悄漂移。

### F-22-03（已修复，P1）：等待人工的项目被 backstop 每分钟误报一次

`enqueueBackstopWakes` 的谓词把"停了钟"一律当成漏事件：

```sql
OR (r."next_wake_at" IS NULL AND (lease_holder IS NULL OR lease_expires_at < stale))
```

契约 §10.2 W4 在 `PC-CX-05` 之后把这一支拆成了两支：(ii) 停了钟**却**还有 `recovery <> HUMAN`
或尚未升级的 blocker；(iii) 停了钟**且**一条 open blocker 都没有。差别正是 §10.4 N-null 允许的
唯一停钟形状 —— 全部 open blocker 都是 HUMAN 且都已升级。

实测（修复前）：`WHO_DISABLED` 升级后 `run_state=AWAITING_HUMAN`、`next_wake_at=NULL`，
一次 `tick` 就命中 backstop 并打出
`WARN Project reconcile backstop found 1 stalled project(s)`，此后每 60s 一次，直到人来处理。
这就是 `PC-CX-05` 记下的"恒为真的告警等于没有告警"，只是换了个位置复发。

修复：按契约把那一支拆成 (ii)/(iii) 两支（保留原有的租约保护作为合取项，避免误报正在跑的一轮）。
回归：`AC3: a project waiting on an escalated person is not reported as stalled` —— 先断言两次
`tick` 都不命中，再把 blocker 解除、断言 backstop **必须**立刻命中，所以这条回归本身是可证伪的。

副作用与跟进：谓词现在读 `project_blocker`，而单元 09/10 的两个 pg spec 是手搭 schema 子集、
建于 blocker 表存在之前。已在这两个夹具里补上该表（4 个被谓词读到的列），两个 spec 恢复全绿
（10 的 7/7、09 的 1/1）。这是本次产品改动自己造成的孤儿，按"只收拾自己弄出来的东西"补齐。

### F-22-04（未修复，P3，文档）：轮换动作的幂等键拼写与契约不一致

契约 §7.3 动作表写的是 `pc:v1:<projectId>:coord-session:<generation+1>`，实现写的是
`pc:v1:<projectId>:rotate:<generation+1>`。键是永久且唯一的，两种拼写都满足 §8.2 的语义，
只影响照契约读代码的人。套件按**实际值**断言（`/:rotate:1$/`）并在此记录，不为了对齐文档去改
一个已经落库的永久键。

## 执行命令与关键输出

一条命令跑完全部（自带起容器 / 迁移 / 编译 / 两套件 / 活性审计 / 销毁）：

```bash
scripts/project-e2e.sh
```

本次完整跑通的输出（`EXIT=0`）：

```
==> provisioning pcc22-e2e-pg16 (postgres:16-alpine) on 127.0.0.1:55470
==> server identity: database=pcc22_e2e role=pcc22_admin system_identifier=7676228021312827433
==> prisma migrate deploy (empty database)
==> 141 migrations applied
==> building the test tree
==> acceptance suite (AC1, 4, 5, 6, 7, 8, 10, 11)
# tests 28
# pass 28
# fail 0
# skipped 0
# duration_ms 56379.687196
==> recovery and fault-injection suite (AC2, 3, 9)
# tests 16
# pass 16
# fail 0
# skipped 0
# duration_ms 39338.170205
==> §10.3 liveness audit over the world the suites left behind
==> liveness audit clean
==> OK
==> removing pcc22-e2e-pg16
```


分步复现（与脚本等价）：

```bash
docker run -d --name pcc22-e2e-pg16 \
  -e POSTGRES_USER=pcc22_admin -e POSTGRES_PASSWORD=pcc22_e2e_pw -e POSTGRES_DB=pcc22_e2e \
  -p 127.0.0.1:55470:5432 postgres:16-alpine
cd src/apiserver
DATABASE_URL='postgresql://pcc22_admin:<pw>@127.0.0.1:55470/pcc22_e2e' \
  ../../node_modules/.bin/prisma migrate deploy --schema prisma/schema.prisma
../../node_modules/.bin/tsc -p tsconfig.test.json
COORDINATOR_PG_URL='postgresql://pcc22_admin:<pw>@127.0.0.1:55470/pcc22_e2e' \
COORDINATOR_PG_EXPECTED_DATABASE=pcc22_e2e \
COORDINATOR_PG_EXPECTED_USER=pcc22_admin \
COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=<system_identifier> \
COORDINATOR_PG_CONTAINER=pcc22-e2e-pg16 \
  node --test --test-concurrency=1 build/projects/project-e2e-acceptance.pg.spec.js
# 同样的环境变量
  node --test --test-concurrency=1 build/projects/project-e2e-recovery.pg.spec.js
psql "$URL" -f ../../scripts/project-liveness-audit.sql   # 健康时零行
```

### 回归（本次改动之后全部重跑）

| 命令 | 结果 |
| --- | --- |
| `tsc -p tsconfig.test.json` | exit 0，0 error |
| `node --test "build/**/*.spec.js"`（不设 `COORDINATOR_PG_URL`） | tests 2143 / pass 1927 / fail 0 / skipped 216 |
| `project-e2e-acceptance.pg.spec` | tests 28 / pass 28 / fail 0 |
| `project-e2e-recovery.pg.spec` | tests 16 / pass 16 / fail 0 |
| `project-reconcile-fault-injection.pg.spec`（单元 10） | 7 / 7 |
| `project-reconcile.pg.spec`（单元 09） | 1 / 1 |
| `project-decision.pg.spec` | 1 / 1 |
| `project-events.pg.spec` + `project-events-fault-injection.pg.spec` | 11 / 11 |
| `verify18-control-loop` + `project-control-surface` + `task-verification-verdict` + `project-blocker`（同一迁移库） | 42 / 42 |
| `project-authorization` + `project-dispatch-boundary` + `project-dispatch-boundary-verification` | 18 / 18 |
| `task-aggregation` + `project-event-sources` + `project-availability-event-sources` | 30 / 30 |
| coordinator 身份族 9 个 pg spec（各自独立库） | 68 / 68 |
| `coordinator-04r-adversarial` / `coordinator-04r3-adversarial` / `coordinator-linearization` | 59 / 59 |
| `go test -run Project ./...`（runner CLI/MCP） | 85 PASS |
| `vitest run`（web 全量） | 54 文件 / 797 通过 |

### 基线红（与本次改动无关，改动前后一致）

- `go test ./...`：`TestKimiFindProjectRootFallsBackToCWD` 失败。它断言在非 git 目录下回退到
  cwd，而本机 `/tmp` 之上存在可被 `kimiFindProjectRoot` 认作根的东西，于是返回 `/tmp`。在
  `/root/orbit`（main）上逐字复现同一失败，属环境依赖的既有红。
- 备忘录里记的"feat/project 自带 29 个 TS2554 + `reorderRunners` 单测失败"在本基线
  （`1a183910`）上**已经不成立**：`tsc -p tsconfig.test.json` exit 0，全量单测 0 fail。

## 变更范围

产品代码（2 处，均由本次验收发现的缺陷驱动）：

- `src/apiserver/src/projects/project-decision.service.ts`：`replay` 的动作追溯改用
  `publicIdempotencyKey` 归一化（F-22-01）；
- `src/apiserver/src/projects/project-reconcile.service.ts`：backstop 谓词按 §10.2 W4 拆成
  (ii)/(iii) 两支（F-22-03）。

既有测试夹具（2 处，被上面第二项直接波及）：

- `src/apiserver/src/projects/project-reconcile.pg.spec.ts`
- `src/apiserver/src/projects/project-reconcile-fault-injection.pg.spec.ts`
  各补一个 `project_blocker` 子集表（谓词读到的 4 列）。

新增：`scripts/project-e2e.sh`、`scripts/project-liveness-audit.sql`、
`src/apiserver/src/projects/project-e2e-harness.ts`、`project-e2e-acceptance.pg.spec.ts`、
`project-e2e-recovery.pg.spec.ts`、本报告。

未修改：Prisma schema、任何迁移、契约文档、其余产品实现。

## 遗留

- **F-22-02**（dead-letter 不开 blocker）未修，属 17 单元机械，P2，不阻塞本单元验收；已有如实
  断言与本报告记录。
- **F-22-04**（`coord-session` vs `rotate` 键拼写）未修，P3，纯文档层面。
- 取证结束后一次性 PostgreSQL 容器 `pcc22-e2e-pg16` 及其全部临时数据库已删除，编译产物
  `build-project-reconcile-faults/` 已清理，`src/web/node_modules` 临时软链已移除；任务
  worktree 除上列文件外 clean。
