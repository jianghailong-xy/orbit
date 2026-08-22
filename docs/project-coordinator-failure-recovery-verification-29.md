# 单元 29：Codex 独立验证 Coordinator 失败唤醒、重试与恢复

结论：**PASS**。

本轮由全新 Codex Task Session `3Kc21wGAfsTNityVRdrolw`、独立工作树
`/root/.orbit/worktrees/6d7ea0bf-5b3a-4bfe-a63d-d25445e9878c` 执行，只做审查、故障注入、
测试和证据记录，不改产品实现。补充 C 的 Worker Session `1ghaF75s7h883RkWpYQ2WZ` 在
`2026-08-22T01:38:35.765Z` 自然进入 `SUCCEEDED/COMPLETED` 后，才把待测链 fast-forward
到本验证分支；未调用 `session complete/end/cancel`。

## 1. 待测基线与环境

- D 分支：`orbit/d-codex-coordinator-dbf852`
- main 基线：`00841cfb596adffcad59546490d77e928f166a13`
- 待测 HEAD：`5d4bb6058742f808d2295c52ec4defec871e3a32`
- A：`52ef6d9e`、`207ec999`、`b1391eee`
- B：`9e4d3e30`、`7486c783`、`7dd2e117`、`2c1f531b`
- C：`2a349ffa`、`4dbcc5d7`、`5d4bb605`
- 测试运行时：Node `v26.7.0`、npm `11.19.0`、TypeScript `7.0.2`、Prisma/Client
  `7.9.1`
- Node 镜像：`node@sha256:0353e48e0e8a993db87b720c242f54b207059d1bcc0106534896e8a11054c837`
- PostgreSQL 镜像：
  `postgres@sha256:d845e7f0ac8517b9d9868b6d20379f9688ba3676595e50ca7c0b664964b2a760`
- PostgreSQL：`16.14`；真实 restart 集群 system identifier：`7676666747875049507`
- Host：Debian 13，Linux `6.12.38+deb13-cloud-amd64`，x86_64

依赖和生成物均在 D 工作树内用 Node 26 容器创建：

```bash
docker run --rm -v <D-worktree>:/work -w /work node:26-bookworm \
  npm ci --no-audit --no-fund
docker run --rm -v <D-worktree>:/work -w /work node:26-bookworm \
  npm run build -w @orbit/shared
docker run --rm -v <D-worktree>:/work -w /work node:26-bookworm \
  npm run prisma:generate -w @orbit/apiserver
```

## 2. 验收矩阵

| 要求 | 独立观察结果 |
|---|---|
| 生产同构失败状态 | `project-failure-turn.spec` 明确断言 Task=`FAILED`、旧 Session=`FAILED`、下游=`BLOCKED_FAILED`、Coordinator=`AWAITING_INPUT`；17/17 通过。 |
| 无人工 check status 自动唤醒 | pg 用例只投递 durable `task.updated` 并跑真实 consumer，没有调用 manual trigger/check-status；控制环自动写 `OPEN_COORDINATOR_TURN`。 |
| 恰好一个 Coordinator message turn | 一个失败 episode 得到 1 个 APPLIED action；Coordinator transcript 是 opening prompt + 1 个 `kind=message` 的失败 turn，`client_turn_id=action.idempotency_key`；重复 reconcile 后仍为 1。 |
| 合法 retry | 普通可归因失败在退避到期后原子写新 Session 与 Task `FAILED→IN_PROGRESS`；旧失败 Session 的 id/status/error/finishedAt 不变。 |
| 不合法路径 | 达上限生成唯一 `TEST_FAILED`；不可归因生成唯一 `UNKNOWN_FAILURE`；重叠时 `UNKNOWN_FAILURE` 胜出且不会再补第二种 blocker。两者都有 owner、requiredAction、nextCheckAt。 |
| 重复/乱序 | 同 episode 的重复、乱序、未来版本 signal 收敛到相同 digest/key；事件和 turn 两层均不重复。 |
| 事务回滚/进程死亡 | SIGKILL 在 commit 前使 action、effect、turn、事件消费一起回滚，接管者补一次；commit 后 SIGKILL 保留唯一结果，接管者不重做。 |
| 通知丢失 | 注入 post-commit announce 抛错后，APPLIED action、PENDING message 和可 claim Session 都存在；runner 轮询可恢复。 |
| 服务/数据库重启 | 新 service graph 重放不重复；真实 PostgreSQL stop/start 与 docker restart 后事件、nextWakeAt、Session 和 action 均保留。 |
| 租约接管/fence | 两实例竞争只提交一个 effect；过期租约接管推进 fencing token；旧 holder 不能 claim/action/session。 |
| 退避/上限 | 第 2 次失败落回 `FAILED` 并进入 8 分钟 rung；窗口内无 dispatch/turn/blocker；逐 rung 到上限后只产生一个 turn + 一个 blocker。 |
| Provider/Runner 不可用 | 缺 Provider 与无匹配 Runner 都显式 REFUSED、零 Session、持久结构化 blocker；恢复后 blocker 自动清除并允许重试，不做静默替换。 |
| policy/预算/权限/并发 | MANUAL 只写审批拒绝与 `AWAITING_USER_APPROVAL`；GUARDED_AUTO/AUTO 按矩阵；一次批准只授权一个 key；project/agent concurrency 与 24h budget 均不可竞态越过。 |
| 历史失败扫描 | pre-v1.17 漏失 episode 从 `next_wake_at=NULL` 被一次性 re-arm；已覆盖 episode 零写入；二次扫描 `updated_at` 不变；持租约项目先 deferred、释放后下一次 recoverOnce 补上。 |

## 3. 命令与结果

### 3.1 全量单元/契约与生产构建

```bash
docker run --rm -v <D-worktree>:/work -w /work node:26-bookworm \
  npm test -w @orbit/apiserver
```

结果：`2399 tests / 2140 pass / 0 fail / 259 skip`，测试执行 `26.592s`。skip 是没有
外部数据库变量时的 pg 用例；下节全部在真实隔离 PostgreSQL 中补跑。

```bash
docker run --rm -v <D-worktree>:/work -w /work node:26-bookworm \
  npm run build -w @orbit/apiserver
```

结果：exit 0。

四个失败语义纯测试文件单独运行：`39/39 pass`；恢复变异后再跑核心
`project-failure-turn.spec`：`17/17 pass`。

### 3.2 真实 PostgreSQL 16

每个 destructive spec 使用独立 `pcc*` database、独立 `pcc*` role，并显式钉死：

```text
COORDINATOR_PG_EXPECTED_DATABASE=<当前专用库>
COORDINATOR_PG_EXPECTED_USER=pccd_user
COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=<临时集群 system_identifier>
```

各库先完整 `prisma migrate deploy`，再执行：

```bash
node --test build/projects/project-coordinator-turn.pg.spec.js
node --test build/projects/project-failed-retry.pg.spec.js
node --test build/projects/project-e2e-acceptance.pg.spec.js
node --test build/projects/project-dispatch-boundary-verification.pg.spec.js
node --test --test-name-pattern='real server restart' \
  build/projects/project-dispatch-boundary-verification.pg.spec.js
```

结果：

- Coordinator turn：`11/11 pass`
- FAILED retry + historical recovery：`15/15 pass`
- control-loop e2e（含 Provider/Runner/blocker）：`28/28 pass`
- dispatch boundary：首轮 `17 pass / 0 fail / 1 restart skip`；提供真实 restart 命令后该项
  `1/1 pass`，因此 18 项全部实际执行并通过

专用故障注入先按仓库要求单独编译：

```bash
npx tsc -p tsconfig.project-reconcile-faults.json
npx tsc -p tsconfig.project-event-faults.json
node --test build-project-reconcile-faults/projects/project-reconcile-fault-injection.pg.spec.js
node --test build-project-event-faults/projects/project-events-fault-injection.pg.spec.js
```

结果：reconcile `7/7 pass`，events `5/5 pass`。本轮共执行 **84 个**定向 pg/fault
测试，`0 fail / 0 skip`（restart 跳过项已单独实际执行）。

真实 restart 后的数据库快照：

```text
project=server-restart
task=server-restart-task; dispatch_attempt=2
sessions=1; session_statuses=PENDING
action attempt 1=APPLIED/POLICY_ALLOWED/has_result_session=true
action attempt 2=REFUSED/TASK_ALREADY_RUNNING/has_result_session=false
surviving session=155a3a54-79f5-4e60-aeef-1f4bb62d679d
```

这不是只读 mock：测试进程通过 Docker socket 重启整个 PostgreSQL 容器；数据使用专用持久化临时
目录，restart 前后 system identifier 相同。

## 4. 反向变异检验

把 failure episode 身份从正确的 `(taskId, dispatchAttempt)` 临时改成错误的
`(taskId, failureCount)` 后，核心测试按预期 exit 1：

```text
the two terminal cells overlap ...         FAIL（turnFacts #5 != #1）
§7.6 TR1 / TF6: a new failure episode ...  FAIL（新 episode digest 未变化）
```

使用反向 patch 恢复后，`project-failure-turn.spec` 重新 `17/17 pass`；`git status` 干净。
这证明 episode/key 断言会咬住错误实现，而不是只验证 happy path。

## 5. 真实长工具与失败审计

- 本 D Session 在真实 Codex Runner 上执行了超过 30 秒的 Node 26 全量测试工具调用，并执行真实
  PostgreSQL restart、SIGKILL、租约竞争与丢通知 smoke；不是合成 planner-only 结果。
- 关联的 steer 长工具生产证据也做了只读交叉核验：Task `34BEfL5U6hHQ9Y008GiuL`、Session
  `2Yt6gCEm62TJMhZ5KjlroI`、证据提交
  `0d154df6f2a9a0e92fc7ecbde32a718fa006af41`。其 API Session
  `34BFPKmK5pPYwdlPOwiuT` 和页面 Session `34BFQN291pGDs8o9oRgPV` 都记录同一 Codex
  turn 内 2 个 userMessage、1 个 steer item、`written→acknowledged`、`numTurns=1`。
- 被禁止覆盖的旧失败 Task `34ApwaUcw2xRtSWSPWTZk` 仍为 `FAILED`；旧 Session
  `1GbK8MVDGD11HKyr1VRhMP` 仍为 `FAILED/FAILED`、`sessionState=FAILED`、`numTurns=2`，
  `finishedAt=2026-08-21T22:40:28.497Z`。本轮没有重启、完成、结束或取消它。
- 当前真实 Coordinator Session `34B599F4f8fsBSqVQCXpp` 仍为
  `AWAITING_INPUT/OPEN`；定向 pg 用例在同一状态下验证失败消息可自动入队并将 run 变为可执行。

## 6. 验证过程中纠正的 harness 配置

第一次 pg 调用只给了隔离 URL，仓库安全闸门在 fixture 写入前按预期拒绝缺失的
`COORDINATOR_PG_EXPECTED_*`；补齐 database/user/system identifier 后原样重跑全绿。

第一次真实 restart 尝试把 PostgreSQL 数据放在 tmpfs，并用 `pg_ctl restart` 停主进程；容器随主进程
退出（status 137），不满足“同一持久数据重启”的前提，因此没有计为 PASS。随后改用专用 bind-backed
临时目录、`docker restart` 整个容器，目标用例 `1/1 pass`。这些均是 harness 前置/拓扑问题，没有掩盖
为产品成功。

## 7. 最终判断与遗留

**PASS**：A–C 的失败唤醒、唯一 message turn、合法 retry、结构化 blocker、幂等恢复和所有点名故障
边界均有独立、真实 PostgreSQL 证据；未发现产品 blocker。

本任务不合并 main、不部署生产，也不修改产品实现；合并、发布和部署后的最终生产验收仍属于下游
`[发布]` 任务。D Worker 收尾必须先写 task comment、再把 Task 置 DONE，并通过正常返回让本
task-linked Session 自然进入终态；不得用 session complete/end/cancel 覆盖结果。
