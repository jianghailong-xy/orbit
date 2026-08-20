# 单元 03 落地说明：Coordinator 身份、默认协调 Workspace 与策略配置

> 权威契约：[`project-coordinator-contract.md`](./project-coordinator-contract.md) §2.2 · §7.5 · §12.1，
> 以及 [`project-agent-contract.md`](./project-agent-contract.md)（PAC）§3.2 · §8.2 · §10。
> **契约不因本文改动**：本文只记录 03 这一单元**落了什么、没落什么、以及与契约文字的三处差异和理由**，
> 供 04（独立验证）与后续单元按图索骥。冲突时一律以契约为准。

## 1. 落地清单

| 项 | 落在哪 | 契约条款 |
|---|---|---|
| `project.coordinator_enabled` / `automation_policy` / `max_concurrent_tasks` / `session_budget_per_day` / `config_revision` | 迁移 `0111_project_coordinator_identity` + `schema.prisma` | §2.2 · §9.4 · §9.6 AU2 |
| 枚举 `ProjectAutomationPolicy`（MANUAL / GUARDED_AUTO / AUTO） | 同上 + `src/shared/src/enums.ts` | §9.1 |
| Coordinator Agent = `project_member.role = COORDINATOR`，partial unique index `project_member_coordinator_idx` | 同上 | §2.2 · PAC §3.2 T1/T2/T3 |
| 默认协调 Workspace = 既有 `project.coordinator_workspace_id`（**不新增列、不与 PAC §3.3 的 Default Workspace 合并**） | 既有 schema，未改 | §1.2 · PAC W4 |
| Coordinator Session 轮换代数 `project_runtime.coordinator_generation`，替换与计数同一事务 | 迁移 + `ProjectsService.coordinator`（03A 起计数由 0112 的触发器承担，条件不变，见 repair §5） | §7.5 |
| 新建 Project 显式写 `true` / `GUARDED_AUTO`；列默认为 `false` / `MANUAL` | `ProjectsService.create` | §12.1 G1 |
| 打开 `coordinatorEnabled` 必须同一请求显式给 `automationPolicy` | `ProjectsService.update`（锁后复核） | §12.1 G3 |
| 四个授权字段的每次写入 `config_revision + 1`；散文字段不动它 | 同上 | §9.6 AU2/AU3 |
| 授权字段与 `coordinatorAgentId` 一律**不经 runner 门**（403） | `RunnerProjectsController.refuseGovernance` | PAC §8.2 |
| `coordinatorAgentId` / `agentId` 进 `PUBLIC_ID_FIELDS`，出站 base62、入站两种拼法 | `src/shared/src/codec.ts` + DTO `@IsPublicId` | PAC §10 · §10 B1/B4 |

**迁移只做加法**：无 `DROP COLUMN`、无 `UPDATE "project"`、不回填任何 blocker/事件/唤醒（§12.1 G2）。
存量 Project 迁移后逐行为 `false` / `MANUAL` / `3` / `NULL` / `0`，并各得一条 `coordinator_generation = 0`
的 `project_runtime`。

> **03A 补充**：本单元**没有**回填 Coordinator 身份（PAC §11.2 步骤 4/5），04 的 P1-01 记录了后果；
> 回填与混合版本闭环由迁移 `0112_project_coordinator_companions` 落地，见
> [`project-coordinator-repair-03a.md`](./project-coordinator-repair-03a.md)。

## 2. 与契约文字的三处差异

1. **迁移被拆开。** §12.1 把 v1 的全部对象写成一次 `0111_project_coordinator`。03 只落其中的身份/策略子集，
   文件名 `0111_project_coordinator_identity`；`project_event` / `project_action` / `project_blocker` /
   `project_decision`、`task.*`、`session.*` 以及 §7.7 的全部触发器与函数由 05/09/11/13 各自的迁移追加。
   理由：本单元的任务边界明确要求"不提前实现后续 outbox/reconcile"，而一次性建出无人写、无人读的表与触发器，
   既无法测试，也会把后续单元的设计冻死在一个没有被它们验证过的形状上。**代价**：§12.1 的"一次迁移"在 v1 完成前不成立，
   04 应按"本单元子集是否正向兼容"验收，而不是按"0111 是否包含全部对象"。

2. **`project_member.agent_id` 指向 `workspace`。** PAC §3.2 的目标状态是 `agent` 表，而该表属于 PAC 02A，
   本仓库尚未实现；今天线上的 "Agent" 就是 `workspace` 行（MCP `agent_list`、`orbit agent`、`task.assignee_id`
   三个面都是它，PAC §2 的 *Legacy agent alias*）。PAC §11.2 步骤 5 的回填本身就是"把 Default Workspace 对应的
   镜像 Agent 加为 COORDINATOR"，因此本表现在记的正是那条回填的**原像**：`agent` 表落地时，这一列按
   `agent.legacy_workspace_id` 一对一改指即可。**不做的事**：不在 `project` 上加 `coordinator_agent_id`（§2.2 明确禁止，
   PAC W3 同理）。

3. **`project_runtime` 只有 `coordinator_generation`。** §2.4 说这张表还承载 run state、租约、`next_wake_at`；
   那些列由 09（租约与 reconcile）与 11（审计）在同一行上追加。本单元建表是因为 §7.5 的轮换代数就落在这里，
   而 §12.1 步骤 3 要求每个既有 Project 都有这一行。

## 3. 本单元明确**没有**做的事

- 不实现 §5 事件 / outbox、§6 reconcile、§8 租约与幂等账本、§9.2 动作×策略矩阵的执行（12）、§11 blocker（17）、
  §12.3 `dispatch_authority` 投影与 §7.7 的数据库门（13）。**因此 `coordinator_enabled` 目前没有任何读者**：
  打开它不会让任何任务开始自动运行，legacy 三条 sweep 的行为一字未改。
- 不实现 §7.5 的**轮换触发条件**（连续失败、Session 结束的探测）与 `COORDINATOR_UNAVAILABLE` blocker——那是 19 与 17。
  本单元提供的是"替换发生时，代数与指针在同一事务里前进，且落点不变"这一持久化保证。
- 不动既有用户路径的语义：`POST /projects/:id/coordinator` 在协调会话被删除后仍允许显式换 workspace
  （既有冻结行为，有专门测试）；契约 §7.5 约束的是**控制环**的轮换不得迁移落点。
  > **已被 03A 撤回**（04 的 P1-02）：该 endpoint 执行的就是 Session replacement，§7.5 对它没有例外。
  > 现行为见 [`project-coordinator-repair-03a.md`](./project-coordinator-repair-03a.md) §2。
- `project_decision.coordinator_session_id`（§7.5 的历史回放依据）属于 11。本单元的"历史可追溯"只到：
  轮换不删除、不结束被替换的 Session，代数单调可读。

## 4. 复核入口

```
# 单元与 DTO（无需数据库）
npm test -w @orbit/apiserver                      # 或 node --test build/projects/*.spec.js
# 迁移与服务的真实 PostgreSQL 断言（一次性库，禁止指向共享 orbit-postgres）
COORDINATOR_PG_URL=postgres://pcc03_admin:***@127.0.0.1:55437/pcc03_mig \
COORDINATOR_PG_EXPECTED_DATABASE=pcc03_mig COORDINATOR_PG_EXPECTED_USER=pcc03_admin \
COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=<pg_control_system()> \
  node --test build/projects/coordinator-identity-migration.pg.spec.js \
              build/projects/coordinator-identity-service.pg.spec.js
```

`coordinator-pg-test-safety.ts` 会在任何写入前拒绝非 `pcc*` 的库/角色与 Orbit 共享库。
