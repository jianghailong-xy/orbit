# 10 Project reconcile 活性、接管与崩溃恢复独立验证

验证日期：2026-08-20（Europe/Berlin）
任务：`349bQGxC2x7KNUyTj0ul7`
被验提交：`e0a40354f84e77af21ee70f89cf26cbbecd7d3bd`
隔离分支：`orbit/10r-reconcile-fault-34aicygs`
隔离 worktree：`/root/.orbit/worktrees/pcc10-34aicygs-20260820`

## 结论

任务 09 的 reconcile 运行底座未发现 P0/P1 缺陷。最终确定性故障注入连续三轮
21/21 通过，既有真实 PostgreSQL reconcile 集成测试 1/1 通过，相关事件/reconcile
单元回归 5/5 通过，apiserver 产品构建、Prisma schema 校验及隔离空库 134/134
migrations 均通过。

验证结果证明：

- 两个服务实例同时竞争同一 Project 时恰有一个租约持有者；租约到期后另一实例接管，
  `fencing_token` 单调前进；
- 原持有者的陈旧 token 不能进入动作 effect，更不能提交；
- action 事务提交前被真实 `SIGKILL` 时，动作键和部分数据库副作用一起回滚；接管者可
  用同一 key 重试并只提交一次；
- action 事务提交后被真实 `SIGKILL` 时，动作键和副作用一起保留；接管者重放同一 key
  得到 `ALREADY_APPLIED`，effect 不会再次执行；
- 真实 PostgreSQL stop/start 后，pending event 和持久化 `nextWakeAt` 均由 fresh service
  恢复，等待验证的 Project 回到 `AWAITING_VERIFICATION`；
- 重复/乱序 dirty signal 只保留最新 envelope，reconcile 重读当前事实后分别收敛到
  `PLANNING`、`EXECUTING`、`AWAITING_VERIFICATION`，且都有 60s 恢复时钟；
- 一个 Project 的注入错误只为该 Project 持久化 retry，不阻塞其后的健康 Project；
- 丢失的 wake 被 backstop 恢复一次，随后 25 次提前 tick 不增加 event/action，单一
  10s unref timer 没有第二时钟或 busy loop。

本任务验证的是任务 09 已实现的租约、动作账本、事件处置与恢复时钟底座。完整决策快照、
结构化 blocker 和语义动作选择按项目计划由后续单元实现，不在本次被验提交中；本验证没有
把这些未来能力冒充为已经完成。

## 隔离环境与护栏

- PostgreSQL 容器：`pcc10-reconcile-pg-34aicygs`。
- 镜像：`postgres:16-alpine`；PostgreSQL `16.14`。
- 绑定：`127.0.0.1:55450 -> 5432`；容器探针地址 `172.17.0.2/32:5432`。
- database：`pcc10_reconcile_verify`。
- role：`pcc10_admin`。
- `system_identifier`：`7676011891999678499`。
- Node：`v22.22.2`；Prisma / `@prisma/client`：`5.22.0`。
- 每个 destructive spec 在 fixture mutation 前校验 database、role、system identifier；
  child claimant 也在写入前独立校验三项身份。
- 协调部署 worktree `/root/.orbit/worktrees/feat-project-deploy` 在验证前保持
  `HEAD=e0a40354...`，staged 为 `M README.md` / `D docs/project-agent-contract.md`，
  staged binary diff SHA-256 为
  `966c46d48ff68e27f9a479eca869e92a8f203d6c2a4466eaa8d48a2d9fcf8105`，
  未暂存 diff 为空。

## 故障注入矩阵

| 场景 | 注入与断言 | 最终结果 |
| --- | --- | --- |
| 双实例租约竞态 | 两个独立连接并发 `acquireLease` | PASS；恰一胜者，另一实例在到期后以 token 2 接管 |
| 陈旧 fence | token 1 在 token 2 接管后调用 `applyAction` | PASS；`ProjectLeaseLostError`，effect 调用 0 次 |
| exactly-once 重放 | token 3 重放已提交 action key | PASS；`ALREADY_APPLIED`，ledger/effect 均仅 1 行 |
| 提交前崩溃 | child 在 ledger + effect 已写但 COMMIT 前停住，父进程 `SIGKILL` | PASS；两行均回滚，接管后同 key 成功提交一次 |
| 提交后崩溃 | child 在 COMMIT 后停住，父进程 `SIGKILL` | PASS；两行均保留，接管重放不再执行 effect |
| 数据库 stop/start | pending event 与 due `nextWakeAt` 落库后 `docker stop` / `docker start` | PASS；server identity 不变，fresh service 消费两种 wake 且不重复 |
| 重复/乱序 | newest signal 后写入同 key 的旧 signal | PASS；`occurrences=2` 且 envelope 保持 newest，状态由当前事实决定 |
| 活性 SLO | PLANNING / EXECUTING / AWAITING_VERIFICATION 三种 OPEN Project | PASS；均在本轮 reconcile 后获得 60s 有界恢复时钟 |
| 错误隔离 | 最早 Project 的 handler 注入异常 | PASS；仅该 Project `attempts=1,pending=true`，其余三项全部消费 |
| wake 丢失 | OPEN Project 的 `next_wake_at` 强制清空 | PASS；backstop 命中并恢复一次 |
| busy-loop | backstop 恢复后连续 25 次提前 tick | PASS；event 仍 1、action 仍 0、backstop hit 仍 1 |
| 资源时钟 | 拦截模块初始化的 interval | PASS；仅一个 10s unref timer，销毁时清理一次 |

最终三轮每轮都会真实执行两次 child `SIGKILL` 与一次 PostgreSQL stop/start；合计执行
6 次进程崩溃边界注入、3 次数据库 stop/start、3 次并发租约竞态和 75 次提前 tick。

## 执行命令与关键输出

隔离编译：

```bash
cd src/apiserver
../../node_modules/.bin/tsc -p tsconfig.project-reconcile-faults.json
```

结果：PASS。

故障注入（同一命令连续三轮）：

```bash
COORDINATOR_PG_URL='postgresql://pcc10_admin:<task-password>@127.0.0.1:55450/pcc10_reconcile_verify' \
COORDINATOR_PG_EXPECTED_DATABASE='pcc10_reconcile_verify' \
COORDINATOR_PG_EXPECTED_USER='pcc10_admin' \
COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER='7676011891999678499' \
COORDINATOR_PG_CONTAINER='pcc10-reconcile-pg-34aicygs' \
NODE_PATH=/root/orbit/node_modules \
node --test build-project-reconcile-faults/projects/project-reconcile-fault-injection.pg.spec.js
```

每轮：`tests 7, pass 7, fail 0, skipped 0`；三轮总计 21/21 PASS。
测试中的 `Project-local reconcile fault` 与 `backstop found 1 stalled project` WARN 是明确注入并
被断言的错误隔离、漏 wake 观测点，不是非预期告警。

既有真实 PostgreSQL reconcile 回归：

```bash
node --test build-project-reconcile-faults/projects/project-reconcile.pg.spec.js
```

结果：`tests 1, pass 1, fail 0, skipped 0`。

相关 unit 回归：

```bash
node --test \
  build-project-reconcile-faults/projects/project-events.service.spec.js \
  build-project-reconcile-faults/projects/project-reconcile.service.spec.js
```

结果：`tests 5, pass 5, fail 0, skipped 0`。

产品与迁移验证：

```bash
npm run build -w @orbit/apiserver
prisma validate --schema prisma/schema.prisma
prisma migrate deploy --schema prisma/schema.prisma
```

结果：产品构建 PASS；schema valid；隔离空库 134/134 migrations 全部应用成功，包含
`0119_project_reconcile_runtime`。

## 测试校准与变更范围

首轮夹具校准时，两个不属于 stop/start 场景的 OPEN fixture 被 backstop 正确命中，且两处
带参数的多语句 `pg` query 被驱动拒绝；这两项均为新测试夹具问题。测试随后禁用了无关
fixture 并把 prepared query 拆成单语句。修正后重新编译并连续完成上述三轮 21/21。

隔离分支只新增：

- `src/apiserver/src/projects/project-reconcile-fault-injection.pg.spec.ts`；
- `src/apiserver/tsconfig.project-reconcile-faults.json`；
- 本报告。

未修改产品实现、Prisma schema、迁移或既有契约。本任务范围无遗留 P0/P1。
任务专属 PostgreSQL 容器已在取证结束后停止并删除；其数据不属于 Orbit 共享数据库。
