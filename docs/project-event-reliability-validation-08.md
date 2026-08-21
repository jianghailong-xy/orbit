# 08 Project 事件可靠性故障注入验证

验证日期：2026-08-20（Europe/Berlin）
任务：`349bQGuAg1QNnpg0VDw94`
被验提交：`d5fc76b500201beeb8e9d200051ddb053cf88b4a`
隔离分支：`orbit/08r-events-reliability-34ahidm`
隔离 worktree：`/root/.orbit/worktrees/pcc08-34ahidm-20260820`

## 结论

本任务范围内未发现 P0/P1 Project 事件可靠性缺陷。确定性故障注入连续运行三轮，
共 15/15 通过；目标范围回归 16/16 通过；apiserver 产品构建通过。结果证明：

- 权威业务写入回滚时不会遗留 outbox 事件，提交时二者原子落库；
- 重复、乱序和未知未来版本的事件只作为 dirty signal，consumer 重读当前状态后收敛；
- 重复投递不会重复执行同一 revision 的副作用；
- 两个并发 claimant 由 Project 行锁串行化，只有一个提交副作用；
- claimant 在事务中写入部分副作用后被 `SIGKILL`，PostgreSQL 回滚该事务，新的进程可消费仍为 pending 的事件；
- 真实重启 PostgreSQL 后，pending 事件和业务状态保留，新的 consumer 正常恢复；
- `0116` 创建的 pending v99 envelope 经 `0117`、`0118` 滚动迁移后原样保留；迁移后 v1 writer 与 v99 writer 均能收敛且副作用去重；
- Task、Session、Approval、Merge、Project/User、Runner、Workspace、Provider 事件源覆盖通过，禁用或无关 Project 不会被错误唤醒。

## 隔离与护栏

- PostgreSQL 容器：`pcc08-events-pg-34ahidm`，仅绑定 `127.0.0.1:55448`。
- database：`pcc08_events_verify`。
- user：`pcc08_admin`。
- `system_identifier`：`7675996159840596003`。
- PostgreSQL：`16.14`，运行时探针报告 `172.17.0.2/32:5432`。
- 每个 destructive spec 在 fixture mutation 前执行 database/user/system_identifier 三重校验。
- 目标部署树 `/root/.orbit/worktrees/feat-project-deploy` 在验证前保持 `HEAD=d5fc76b5...`，
  staged 状态为 `M README.md`、`D docs/project-agent-contract.md`，
  `git diff --cached | sha256sum` 为
  `966c46d48ff68e27f9a479eca869e92a8f203d6c2a4466eaa8d48a2d9fcf8105`，未暂存 diff 为空。

## 验证矩阵与结果

| 场景 | 注入/断言 | 结果 |
| --- | --- | --- |
| 事务回滚 | 同一事务写业务行和事件后强制抛错 | PASS；业务行 0、事件 0 |
| 重复/乱序/未来版本 | 按 v3、v1、v2 顺序写同一 dedupe，再写 v99 未知 kind | PASS；occurrences=3，保留最新 envelope，最终读当前业务状态 |
| 幂等副作用 | 已消费事件再次投递，混合 v1/v99 writer | PASS；同一 revision action 仅 1 行 |
| 错误 Project 隔离 | B 的 payload 故意携带 A 的 hint | PASS；A/B projection 分别读取各自权威状态 |
| 并发 claimant | 两个连接同时 `drainOnce`，首个 claimant 持锁暂停 | PASS；另一个立即 IDLE，handler 仅调用 1 次 |
| 进程崩溃 | claimant 持锁并写未提交副作用后 `SIGKILL` | PASS；部分副作用 0，pending 事件 1，新进程消费成功 |
| 服务重启 | 事件提交后真实 `docker restart` PostgreSQL | PASS；新连接 identity 不变，fresh consumer 恢复并只写 1 次副作用 |
| 滚动迁移/混合版本 | `0116` 下写 pending v99，随后应用 `0117`/`0118`，再写 v1 | PASS；pending envelope 不变，两条事件均 RECONCILED，副作用 1 |
| retry/dead-letter | handler 写部分效果后失败；第 10 次失败 | PASS；savepoint 回滚，重试时间持久；DEAD 与 durable dead letter 同事务 |
| Task/Session/Merge/User 源 | 覆盖 create/update/move/delete/approval/merge/manual | PASS |
| Runner/Workspace/Provider 源 | online/offline、capability、quota、workspace、configured provider | PASS；只唤醒相关且 enabled 的 Project |

执行统计：

- `tsc -p tsconfig.project-event-faults.json`：PASS。
- 新增故障注入 spec：连续三轮，每轮 5/5 PASS，总计 15/15。
- Project 事件相关既有 unit/PG 回归：16/16 PASS。
- `npm run build -w @orbit/apiserver`：PASS。

## 可重复执行

先创建一次性 PostgreSQL，并查询本次实例的 `system_identifier`（每次新建实例都会不同，
必须把查询结果显式传给测试护栏）：

```bash
docker run -d --name pcc08-events-pg-34ahidm \
  -e POSTGRES_PASSWORD='<task-password>' \
  -e POSTGRES_USER='pcc08_admin' \
  -e POSTGRES_DB='pcc08_events_verify' \
  -p 127.0.0.1:55448:5432 postgres:16-alpine
docker exec pcc08-events-pg-34ahidm \
  psql -U pcc08_admin -d pcc08_events_verify -X -Atc \
  "SELECT current_database(), current_user, (SELECT system_identifier::text FROM pg_control_system())"
```

先构建隔离测试集：

```bash
cd src/apiserver
../../node_modules/.bin/tsc -p tsconfig.project-event-faults.json
```

设置以下护栏环境变量后运行故障注入；重复三次的每一轮都会执行一次 claimant
`SIGKILL` 和一次任务专属 PostgreSQL 容器重启：

```bash
COORDINATOR_PG_URL='postgresql://pcc08_admin:<task-password>@127.0.0.1:55448/pcc08_events_verify' \
COORDINATOR_PG_EXPECTED_DATABASE='pcc08_events_verify' \
COORDINATOR_PG_EXPECTED_USER='pcc08_admin' \
COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER='7675996159840596003' \
COORDINATOR_PG_CONTAINER='pcc08-events-pg-34ahidm' \
node --test build-project-event-faults/projects/project-events-fault-injection.pg.spec.js
```

相关回归使用相同 database/user/system_identifier 护栏，运行：

```bash
node --test \
  build-project-event-faults/projects/project-events.service.spec.js \
  build-project-event-faults/projects/project-events.pg.spec.js \
  build-project-event-faults/projects/project-event-sources.pg.spec.js \
  build-project-event-faults/projects/project-availability-event-sources.pg.spec.js
```

## 保留的既有基线失败

直接运行全量 `tsc -p src/apiserver/tsconfig.test.json` 会在进入测试前失败：29 个既有
`runner-api/*.spec.ts` fixture 仍以 6 个参数构造 `RunnerApiController`，而控制器自
`7c3d25913`（早于本轮 Project 事件提交）起要求 7 个参数。该问题不涉及本任务被验的
Project event 产品实现，apiserver 产品构建及本任务独立测试配置均通过；本验证没有
修改这些旁路测试，也没有掩盖此失败。

## 变更与遗留

本隔离分支只新增：

- `src/apiserver/src/projects/project-events-fault-injection.pg.spec.ts`：5 个确定性故障注入场景；
- `src/apiserver/tsconfig.project-event-faults.json`：隔离本任务测试，避免旁路 fixture 编译失败；
- 本报告。

本任务范围无遗留 P0/P1。未修改产品实现、Prisma schema 或迁移。任务专属 PostgreSQL
容器已在取证结束后停止并删除；其数据不属于 Orbit 共享数据库。
