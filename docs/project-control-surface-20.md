# 20 Project Coordinator 控制/观测面（API · CLI · MCP）

契约条款：AC10（§6.2 · §11.1 · §13.4）。
分支基线：`feat/project@ac2032df`。

## 这个单元解决的问题

控制环的状态此前分散在七张表里（`project`、`project_runtime`、`project_member`、
`project_decision`、`project_action`、`project_blocker`、`project_event`，外加任务跑
出来的 Session），**没有任何一个入口能一次读到**。于是"这个项目为什么不动了"只能靠
手工 join 回答，而最常见的结论——"它坏了"——通常是错的：它在并发上限上、预算花完了、
是 `MANUAL`、在等人，或者下一次唤醒本来就排在十分钟后。

本单元补上一个读面和一条写控制，并让 API / CLI / MCP 三处同语义、同鉴权、同 Base62。

## 读面

`GET /projects/:id/coordinator/status`（用户 JWT）
`GET /runner/projects/:id/coordinator/status`（runner token，同一 service、同一 owner 作用域）

十一个小节，**任何项目都返回同一组 key**：

| 小节 | 回答的问题 |
|---|---|
| `project` | 工作本身的 lifecycle（OPEN/DONE/CANCELLED）与任务分布 |
| `coordination` | 哪个 Agent 协调、在哪个 Workspace、协调 Session 与 generation、身份是 DERIVED 还是 EXPLICIT |
| `policy` | 开关 `coordinatorEnabled`、推进策略、`configRevision`、并发上限、日预算 |
| `consumption` | 在飞任务 / 剩余并发、24h 内协调动作数 / 剩余预算（与准入门**同一套计数**） |
| `runtime` | `runState`、是否持租约及到期时刻、`fencingToken`、`acceptanceAttempt` |
| `nextWake` | 下次唤醒时刻与原因，**外加落选候选**（W5 clause 4 的原表）与 `flooredBy` |
| `decisions` | 最近 5 次判断：`decisionInputHash`、前后 `runState`、以及各自产出的动作与幂等键 |
| `pendingActions` | 已 claim 未发布的动作——此刻正在飞的是什么 |
| `blockers` | 当前阻塞（kind / owner / recovery / requiredAction / nextCheckAt）与历史 episode |
| `events` | 未消费的 outbox 信号（含 `attempts` / `nextAttemptAt` 退避）与最近事件 |
| `acceptance` | 验收标准、上一次 `RUN_PROJECT_ACCEPTANCE`、verdict 计数、**逐分支合并证据** |

两条硬规则：

1. **缺失是值，不是省略。** 每个可空事实旁边有一个封闭集合的
   `…AbsentReason`（`NO_COORDINATOR_AGENT` / `COORDINATOR_NEVER_OPENED` /
   `COORDINATOR_SESSION_TRASHED` / `NOT_LEASED` / `UNLIMITED` / `NO_WAKE_SCHEDULED` /
   `NO_DECISION_YET` / `DECISION_PREDATES_WAKE_AUDIT` / …）。少一个 key 在客户端看来
   和"这个服务端根本不懂这个字段"无法区分——"没有阻塞"和"这个版本报不出阻塞"就会
   变成同一段 JSON。
2. **不拿第二个时钟重算。** `nextWake.candidates` 读的是**做决策那一趟自己记下来的**
   候选表（存在 `project_decision.outcome.detail`），不是读的时候重跑 W5。重跑会打印
   出任何一次决策都没见过的候选。

Base62：id 字段由 `PublicIdInterceptor` 按 `PUBLIC_ID_FIELDS` 改写；**藏在字符串里的
id**（action 的 `idempotencyKey`、event 的 `dedupeKey`）拦截器看不进去，由 service 自己
publicize。`leaseHolder` **完全不出现在响应里**——它是 CAS fence 不是地址
（`NEVER_PUBLIC_ID_FIELDS`），只报"是否持有、持到什么时候"。

> 实现注记：读面一度把可空字段包成 `{ value, absentReason }`。这会让 `agentId` 变成
> `agentId.value`，而 id 分类是**按字段名**做的，于是拦截器不再认识它，裸 UUID 直接
> 出墙。现在一律是两个平行键（`agentId` + `agentIdAbsentReason`）。

## 写控制

### 1. 手动触发

`POST /projects/:id/coordinator/trigger`（**只在用户门**）

只做一件事：提交一条持久的 `user.manual_trigger` 信号然后返回。它不开 Session、不开
turn、不授予任何权限——随后那一趟 reconcile 仍然过同样的策略/授权/并发/预算门。绕过
这些就成了第二条派发路径，正是 §12.3 禁止的东西。

三种 typed 拒绝，全部发生在任何写之前：

| code | 何时 | 为什么不能默默接受 |
|---|---|---|
| `STALE_CONFIG_REVISION` | 调用者报的 `expectedConfigRevision` 已过期 | 他按下按钮时看到的策略不是将要运行的策略 |
| `PROJECT_SETTLED` | 项目 DONE/CANCELLED | §4.2 guard 1 判 SETTLED、§5.5 丢弃其事件，接受就是"永远不会发生的请求" |
| `COORDINATOR_DISABLED` | 开关关着 | 同上，且消息里带打开的办法 |

`triggerId` 是这次请求的身份：信号的 dedupe key 由它构造，outbox 在行未消费时按 key
合并，所以双击是一次运行。不传则服务端分配一个并回传（Base62）——没给自己命名的请求
不可能意味着"和上次那个是同一个"。

**故意不放在 runner 门上**：能以 USER 身份入队信号的 Agent 就是在驱动自己的协调器，
而 `MANUAL` 的含义正是"只有人能驱动"。`refuseGovernance` 对授权字段划的是同一条线。

### 2. Compare-and-swap（`expectedConfigRevision`）

加在 `PATCH /projects/:id`、`PATCH /runner/projects/:id` 和上面的 trigger 上。可选：
**不传就是旧行为**（last-write-wins），既有客户端一字未改。传了就是一句断言——"我是
对着 revision N 写的"——在**与写同一个事务、同一把行锁之后**比对，不符就 409 并回滚，
连 team 行都不会动。

它存在是因为授权四件套会被多处同时编辑（Web、用户 API、协调器自己的 session），而
last-write-wins 不是合并，是一个人无声地撤销另一个人的撤权。

`configRevision` 一律是**十进制字符串**：它是 bigint，过了 2^53 用 JSON number 就区分
不出两个相邻 revision，而它的全部工作就是区分。

## CLI / MCP parity

| API | CLI | MCP |
|---|---|---|
| `GET …/coordinator/status` | `orbit project status PROJECT_ID [--json]` | `project_status` |
| `PATCH …`（带 CAS） | `orbit project update … --expected-config-revision N` | `project_update.expectedConfigRevision` |
| `POST …/coordinator/trigger` | —（用户门专有，见上） | —（同） |

`cli_mcp_parity_test.go` 强制"每个 MCP 工具都有 CLI 命令、每个 MCP 参数都在该命令的
参数表里"；`project` 已在 `leafHelpFamilies`，`orbit project status --help` 可达。

## 测试

| 文件 | 覆盖 |
|---|---|
| `src/apiserver/src/projects/project-coordinator-status.spec.ts` | 12 条：小节齐全、每个缺失都有封闭集合理由、"从未打开"≠"打开过又被删"、活项目各字段、候选表来自决策记录、无决策 vs 旧决策、**服务后全 Base62 无裸 UUID**、字符串里的 id 由 service publicize、lease 只报到期不报持有者、bigint 计数器是字符串、跨租户 404、owner 在查询里 |
| `src/apiserver/src/projects/project-coordinator-control.spec.ts` | 15 条：陈旧写被拒且零写入、比对发生在行锁之后、匹配则通过且 revision +1、不传 fence 保持旧行为、纯 prose 编辑也受 fence、触发只入队一条信号、triggerId Base62 与自动分配、同 id 去重、MANUAL 项目可触发、settled/disabled/stale 三种拒绝均零入队、跨租户 404、runner 门逐字段拒绝授权字段、runner 门允许 fence |
| `src/apiserver/src/projects/project-control-surface.pg.spec.ts` | 5 条真实 PostgreSQL（需 `COORDINATOR_PG_URL` + 独立库，见文件头）：raw SQL 与真实 schema 逐列一致、跨租户 404、走存储函数入队且同 id 只一行、**陈旧写真的回滚**、关掉/终态时零入队 |
| `src/runner-go/project_cli_test.go` | `orbit project status` 打到 coordinator/status 路由并原样输出、缺 id 拒绝、`--expected-config-revision` 以字符串上送、只带 fence 被拒、非十进制被拒、不传则不带该字段 |
| `src/runner-go/mcp_project_test.go` | `project_status` 路由与必填、`project_update` 只在传了时转发 fence、纯 fence 更新被拒 |

真实 PG 用一次性容器 `pcc20-status-pg16`（库/角色 `pcc20_status`），跑前由
`coordinator-pg-test-safety.ts` 三重校验（database / role / `system_identifier`），
生产 `orbit-postgres` 由构造被拒。
