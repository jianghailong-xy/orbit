# Project Coordinator 契约 v1.3 独立复审（02）

> 审查任务：`02 独立审查 Coordinator 契约与故障模型`（Orbit task `349bQGkoTy7QmNXtyRKaO`）
>
> 被验修订：`691757e7943bed46fe765a8fe73e07312bb96b83`
>
> 前轮证据：[`project-coordinator-contract-review-02.md`](./project-coordinator-contract-review-02.md)、[`project-coordinator-contract-review-02-v1.1.md`](./project-coordinator-contract-review-02-v1.1.md)、[`project-coordinator-contract-review-02-v1.2.md`](./project-coordinator-contract-review-02-v1.2.md)
>
> 审查日期：2026-08-19
>
> 约束：从 Project 的 goal、12 条 acceptanceCriteria、instructions、p01 与 01A/01B/01C 提交重新推导；没有修改权威契约、研发反例或业务代码。本轮只新增本报告与独立反例 spec。

## 1. 结论

**FAIL / BLOCKED**。v1.3 的既有模型与真实 PostgreSQL 套件全绿，但把约束放回“下一次正常租约”“故障解除后复发”“同 tick 多个语义原因”“旧写端改投影”“用户同时撤销自动化”等生命周期后，仍发现 **2 个 P0、5 个 P1**：

| ID | 级别 | 受影响验收 | 结论 |
|---|---|---|---|
| `PC-CX-21` | **P0** | AC3 · AC5 · AC9 | D9 把历史 action token 与不断前进的 runtime 当前 token 比较；下一次正常租约即可让仍在飞的 Session 违反 I11。D9 又只监听 Session 三列，Task 跨 Project 移动也能在不触发约束的情况下破坏归属 |
| `PC-CX-22` | **P1** | AC2 · AC3 · AC5 · AC10 · AC12 | §6.1 冻结快照遗漏所有新增 action epoch、blocker 判定字段与 merge evidence；`snapshotHash` 又排除时间和事件，但派发到期与 MANUAL turn 依赖它们，因此“同 hash ⇒ 同机械决策”不成立 |
| `PC-CX-23` | **P1** | AC3 · AC6 · AC12 | §7.2 的语义触发不是互斥也没有优先级：全任务收敛同时命中 REPLAN/ACCEPTANCE，验证 FAIL 同时命中 VERDICT/BLOCKER_DECISION；不同 reasonCode 生成不同键，可开两个 turn 或得到实现相关结果 |
| `PC-CX-24` | **P1** | AC2 · AC3 · AC8 | `OPEN_COORDINATOR_TURN` 键不含 blocker 生命周期；同因 blocker 被解决后复发会撞旧 turn 键，被 TR3 错判为“无进展”，直接升级给人 |
| `PC-CX-25` | **P0** | AC9 · AC11 | 混合版本正确性依赖服务层维护 `task.dispatchAuthority` 投影；旧写端移动 Task 或结束占位时不执行 D3，D6 只会忠实执行陈旧 LEGACY 值并放行旧 sweep，违反“与二进制版本无关”的承诺 |
| `PC-CX-26` | **P1** | AC3 · AC4 · AC9 | 人工关闭 Coordinator/AUTO→MANUAL 与 reconcile 提交没有共同线性化门；唯一提交条件只看 runtime token，陈旧 AUTO 决策仍可在人工撤权后派发。人工启动另一 Task也可与 Coordinator 一起越过 Project 并发上限 |
| `PC-CX-27` | **P1** | AC5 · AC7 · AC12 | 冻结正文仍同时保留修订前后两套规范：AG1 继续要求 childrenDigest 幂等键而 AG5 说无键；AE8 继续写 `FOR SHARE` 而 AE6/LO3 冻结 `FOR NO KEY UPDATE` |

新增 [`coordinator-v13-adversarial.spec.ts`](../src/apiserver/src/projects/coordinator-v13-adversarial.spec.ts) 将七项反例固化为 9 个断言；其中真实 PostgreSQL 用例证明 `PC-CX-21` 的两个非法已提交状态。测试“通过”表示反例被稳定复现，**不表示权威契约通过**。

02 的完成门槛“无未解决 P0/P1 契约歧义”仍不成立，03 不应解除依赖。

## 2. 结构化失败证据

### PC-CX-21 — D9 只证明插入事务，不能维持 I11（P0）

**契约证据**：

- §8.1：每次成功取得 lease，`project_runtime.fencing_token + 1`。
- §7.7 D9：COORDINATOR Session 在提交时要求 action 的 token 等于 runtime **当前** token。
- I11/§10.3(a)：每条在飞 Session 必须持续可归属，否则属于 P0 活性违约。
- D9 constraint trigger 只定义在 `session INSERT OR UPDATE OF project_action_id, dispatch_origin, task_id`；它读取但不监听 `project_runtime.fencing_token`、`task.project_id`、`project_action.*`。
- AE10 明确允许 Task 跨 Project 移动，却没有定义 live Session 的归属迁移或拒绝规则。

**最小交错 A（正常路径）**：token=42 的 reconcile 同事务提交 `action(APPLIED, token=42)` 与 live Session，D9 通过；60 秒兜底/任一事件触发下一次 reconcile，成功取 lease 后 runtime token=43，Session 仍 live；没有 Session 三列变化，D9 不运行。查询当前已提交状态得到 `action.token=42 != runtime.token=43`，I11 为假。

**最小交错 B（人工移动）**：token=42 的 Session 已合法提交；人工把其 Task 从 P1 移到 P2，AE10 允许并只要求两边 Project 的验收事实门；Session 未更新，D9 不运行；action 仍属于 P1、Task 已属于 P2，I11 为假。

**真实 PostgreSQL 16.14**：两条更新都成功提交，随后查询分别返回 `i11=false`；见 spec 的 `PC-CX-21 on real Postgres`。

**权威预期**：fencing token 证明“动作提交时持有有效 lease”，不能被定义成 action 与 runtime 永久相等。归属不变量需使用稳定的历史关系，或把 token 的时态明确限定在派发提交点。D9 读取的其它可变行必须有封闭 mutator 协议：至少禁止 live Task 跨 Project 移动，或原子迁移/终止 Session；action 归属列需终态不可变或有反向约束触发器。

**责任人与恢复**：数据库协议 / dispatcher / Task move 服务。修订 I11、D9 与 §10.3，增加“合法派发 → 下一次 lease”“live Task move”“APPLIED action 后续改写”的真实数据库测试；在修订前保持 02 blocker。

### PC-CX-22 — `snapshotHash` 不是机械决策的完整输入（P1）

**契约证据**：

- §6.1 冻结的 Task 投影没有 `dispatchAttempt`、`verdictRevision` 或 verdict；runtime 投影没有 `acceptanceAttempt`；blocker 投影没有 `lifecycleGeneration`、`conditionVersion`、`firstSeenAt`、`escalatedAt`、`recovery`；整个快照没有 `mergeEvidence`。
- §7.3/§8.2/§11/§13 又要求这些字段决定 action key、turn digest、升级、wake 与验收。
- S3 明确从 hash 排除 `snapshotAt` 与 `events`，并要求相同 hash 得到相同机械决策。
- 但 `runAt`/退避/升级/预算窗口依赖求值时钟；MANUAL turn 只由 `user.manual_trigger` 事件触发。

**最小反例**：两份快照在 §6.1 可见投影上逐字相同，但 `dispatchAttempt=1/2`，所需 dispatch key 不同；或同一个 `runAt=10:00` 在 09:59/10:01 求值，派发决定不同；或世界行完全相同但后一份含 `user.manual_trigger`，是否开 MANUAL turn 不同。三组都得到相同 S3 hash，却要求不同动作。

**权威预期**：冻结一个完整的 `decisionInput`。所有影响 action、key、blocker、wake、acceptance 的持久字段必须进入快照与 hash；时间相关规则应进入规范化 evaluation epoch/derived due facts；事件触发若影响动作，事件身份必须进入 decision input（即使 payload 仍不作为业务事实）。

**责任人与恢复**：snapshot/audit/replay 单元。由 §7/§8/§10/§11/§13 的读集机械生成 snapshot/hash 覆盖测试，增加“同 hash ⇒ actions/blockers/nextWake 全等”的变异检查。

### PC-CX-23 — 语义触发集合没有唯一裁决（P1）

**契约证据**：§7.2 给出五个 reasonCode，但没有 `runStateOf` 那样的 first-match 顺序，也没有规定多条件成立时合并原因；§6.3 只说“追加一个 `OPEN_COORDINATOR_TURN`”。不同 reasonCode 的 key 不同，TR2 也按 reasonCode 分桶，幂等/限频都不会把它们合并。

**最小反例 A**：全部 Task 收敛、验证全 PASS、无 blocker/live Session/未收敛验收 action。当前 `runStateOf=PLANNING`，无可派发任务，因此 REPLAN 为真；“全部 Task 收敛，准备验收”使 ACCEPTANCE 同时为真。

**最小反例 B**：验证 FAIL 的机械退回已完成并开 `VERIFICATION_FAILED` blocker。VERDICT 为真；同一 blocker 又属于 `BLOCKER_DECISION` 的四个 kind，第二个原因也为真。

**权威预期**：定义一个总序或互斥守卫，使同一 snapshot 恰好得到零或一个语义原因；另一种可接受方案是把并发原因规范化成排序集合并生成**一条**复合 turn/key，但必须给出唯一算法与责任人。

**责任人与恢复**：reconcile decision engine。表驱动枚举五种原因的全部 32 个布尔组合，断言动作数 ≤1 且选中原因唯一；验证 FAIL 与全任务收敛必须是具名回归用例。

### PC-CX-24 — 新 blocker 周期复用旧 turn 身份（P1）

**契约证据**：blocker v1.3 已有单调 `lifecycleGeneration`，但 BLOCKER_DECISION 的 `turnFacts` 仍只有 `(kind, subjectId, conditionVersion)`；GE4/TR3 把同 generation、同 digest 的历史 turn 解释成“上一次没有改变事实”。

**最小反例**：MERGE_CONFLICT episode 1 的 conditionVersion=A，Coordinator turn 解决冲突，blocker clear；稍后同一文件集/内容再次形成冲突，episode 2 的 conditionVersion 仍 A。reasonDigest 与 episode 1 相同，历史 turn 已结束，TR3 直接开 `COORDINATOR_NO_PROGRESS`，不再给 Coordinator 一次处理新故障的机会。

**权威预期**：同一 open episode 内的重复仍需同 turn key；clear→recur 必须获得新 turn 身份。将 blocker row id/lifecycle generation 纳入该 reason 的稳定事实，或给 turn 自己定义可证明的语义 episode；不能用“当前条件相同”推断“中间从未恢复”。

**责任人与恢复**：turn ledger / blocker service。对四个 opensTurn kind 跑 `open → turn progress → clear → same condition recur`，断言第二 episode 合法得到新 turn；episode 内重复仍被 TR1 去重。

### PC-CX-25 — 旧写端可使派发权投影陈旧并绕过 D6（P0）

**契约证据**：D6 的数据库硬门只读 `task.dispatch_authority`；D3 的三个投影写点全是新服务层 primitive，不是数据库触发器。D7-note 与 §12.4 又声称混合版本正确性不依赖“旧实例已退出”，由数据库约束对任何版本成立。

**最小反例 A**：已有 `coordinatorEnabled=true` 的 P；不认识新列的旧 apiserver 把 legacy Task 移入 P，只更新 `task.project_id`，`dispatch_authority` 保持 LEGACY；旧 sweep 插入 LEGACY_SWEEP Session。D6 看到 LEGACY，合法放行；按 P 的真实配置该 Task 应由 Coordinator 派发。

**最小反例 B**：启用 Coordinator 时一个 LEGACY Session 在飞，D8 正确延迟翻转；该 Session 由旧写端结束，旧事务不执行 D3 第 3 个“占位释放后补投影”；Task 永久保留 LEGACY，旧 sweep 可再次派发。

**权威预期**：要么把 `projectId/coordinatorEnabled/session terminal → dispatchAuthority` 的投影维护放进数据库或单一兼容写层，使旧写端不能绕过；要么把阶段 A 全量完成正式提升为正确性前提，并撤回“任意混合版本都由数据库保证”的承诺，同时提供可观测部署 fence 与回滚边界。

**责任人与恢复**：迁移/rollout + Task/Session 写路径。真实测试必须使用“不认识新列”的 SQL，而不只是旧 sweep INSERT；覆盖 move-in、move-out、在飞 Session 结束和回滚窗口。

### PC-CX-26 — 人工撤权/并发配额与 reconcile 提交不线性化（P1）

**契约证据**：策略与并发上限只在 §7.4 的快照前置中读取；reconcile 提交唯一硬条件是 runtime fencing token。用户修改 `coordinatorEnabled/automationPolicy/maxConcurrentTasks` 不推进 token，也没有与派发事务共享的 project revision/CAS。D5 只提供 per-Task claim，不能维护 Project-wide 并发计数。

**最小反例 A**：Coordinator 在 AUTO 快照上决定派发；用户随后提交 `coordinatorEnabled=false` 或 `AUTO→MANUAL`；旧 token 仍有效，Coordinator 最后提交 Session。最终已提交状态是“已撤销自动化 + 撤权后创建的自动 Session”。

**最小反例 B**：快照 `inFlight=0/max=1`；用户手动启动 Task B，Coordinator 同时派 Task A。两个 Task 的 D5 索引键不同，均成功，最终 inFlight=2。

**权威预期**：冻结用户动作是否允许越过并发上限；无论选择哪种语义，Coordinator 的授权必须在派发提交点对当前 policy/enabled/config revision 复核。若上限是 Project-wide 硬限制，需要共同 slot primitive；若人工可覆盖，必须在状态/审计中明确标为人工 override，不能声称上限未超。

**责任人与恢复**：policy evaluator / dispatcher。双事务 barrier 测试覆盖 disable、AUTO→MANUAL、max 降低、人工启动其它 Task；提交结果只能是人工写先赢并拒绝自动派发，或自动派发先线性化后人工写生效，不能出现顺序不明的第三种状态。

### PC-CX-27 — 修订前后的规范句仍同时存在（P1）

**契约证据**：

1. §13.1 AG1 仍写“幂等键的 epoch 取子状态摘要”，而 §7.3/§8.2/AG5 明确 `AGGREGATE_PARENT` 无键、只做 current-state CAS。
2. §13.4 AE8 仍写“持有 AE6 那把 `FOR SHARE`”，而 AE6-a/§8.6 LO3 冻结 `FOR NO KEY UPDATE` 并以禁止 SHARE→UPDATE 升级作为 `PC-CX-19` 的修复。

**最小反例**：单元 15 按 AG1 实现会复活 `PC-CX-17`；事实写服务按 AE8 字面实现会复活真实 `40P01`。两种实现都能引用“冻结”条款，没有唯一裁决。

**权威预期**：规范正文只保留当前规则；历史形状只能出现在明确标记为非规范的修订日志/反例中。静态测试应覆盖所有 normative 片段，而不是只扫描 key 模板。

**责任人与恢复**：契约维护者。删除/改写两条残文，mutation check 对 AG1 与 AE8 分别反向替换并应失败。

## 3. 指定故障矩阵

| 场景 | 唯一预期持久化状态 | 确定性动作 / 幂等 | 责任人与恢复 | 本轮结论 |
|---|---|---|---|---|
| 重复事件 | 同一世界事实下 runState/blocker/通知不变；仅 occurrences/lastSeen 可变 | 同 episode 同 action key，副作用一次 | orchestrator；无需人工 | **PASS**：既有 PC-CX-15/16 模型 |
| 乱序事件 | 重读当前快照，最终状态与顺序无关 | 事件只标脏，动作键按当前事实 | orchestrator；backstop 兜底 | **PASS**：E1 + 既有模型 |
| 事务回滚 | 业务行与 outbox 一起不存在 | 不产生 action/session | 写路径；重新执行业务操作 | **PASS**：N4/X1 |
| 双 worker 竞争 | 只有新 token outcome 提交；既有 live Session 持续可归属 | lease token + action key | 新 holder 接管 | **BLOCKED**：lease 提交互斥通过，但下一 token 正常前进即触发 `PC-CX-21` |
| Coordinator Session 结束 | Agent 不变，generation+1，新 Session 落默认协调 Workspace | `coord-session:<generation+1>` | orchestration；rotate，workspace 不可用则 USER blocker | **PASS**：现有模型，未发现新歧义 |
| Runner 离线 | reaper 后 session.failed，随后退避或结构化 blocker | 当前 dispatch 不复制；新 attempt 单调 | SYSTEM/EVENT；runner 恢复或失败路径 | **PASS**：F10/Q3 |
| Provider 不可用 | `PROVIDER_UNAVAILABLE`，SYSTEM/EVENT，nextCheck 非空 | blocker episode key；无静默 fallback | SYSTEM；恢复事件/轮询，显式 fallback 才可用 | **PASS**：F12/ES5 |
| 无匹配 Runner | `NO_MATCHING_RUNNER` 或 `RUNTIME_REQUIREMENT_UNMET` | 单一 blocker episode | SYSTEM/EVENT 或 USER/HUMAN | **PASS**：F11 映射唯一 |
| 合并冲突 | `MERGE_CONFLICT`；每个新故障周期可开一次 turn | episode 内同 key，复发应新 key | COORDINATOR→必要时 USER | **BLOCKED**：`PC-CX-24` 把复发误判无进展 |
| 测试/验证失败 | 退避期 NOOP；超限 TEST_FAILED；验证 FAIL 退回/建缺陷/阻下游 | dispatchAttempt/verdictRevision | USER 或 COORDINATOR，修复后重跑 | **BLOCKED**：状态表通过，但 FAIL 同时触发两个 reason，见 `PC-CX-23` |
| 预算耗尽 | `BUDGET_EXHAUSTED`，SYSTEM/TIME，nextCheck=窗口边界 | blocker episode；不受投递次数影响 | SYSTEM；窗口滚出自动解除 | **BLOCKED**：状态语义通过，但时钟不进 decision hash，见 `PC-CX-22` |
| 等待用户 | `AWAITING_HUMAN`；升级一次后纯 HUMAN wait 可停钟 | approval/blocker key 唯一 | USER/HUMAN；用户响应事件恢复 | **PASS**：N-null/ES3/ES5 |
| 混合版本部署 | 任何二进制都不能让 logical COORDINATOR Task 走 legacy | DB 硬门 + 不陈旧的 authority projection | rollout/migration；显式 fence | **BLOCKED / P0**：旧写端可制造 stale projection，`PC-CX-25` |
| 人工同时操作 | 与自动派发有清晰先后；撤权后不得新开自动 Session；Project cap 语义唯一 | policy/config revision CAS + task/project claim | 用户最终控制；败者按新事实重算 | **BLOCKED**：`PC-CX-21` task move 与 `PC-CX-26` policy/cap race |

## 4. 12 条 Project acceptanceCriteria 覆盖

| AC | 覆盖结论 | 证据 / blocker |
|---:|---|---|
| 1 | PASS | 稳定 Agent、Session rotation、Workspace 与 Base62 契约未发现新冲突 |
| 2 | BLOCKED | 重复/乱序/回滚主模型通过；S3 输入不完整与 turn episode 复用由 `PC-CX-22/24` 阻断 |
| 3 | BLOCKED | 当前 token 会令 live Session 不可归属；触发重叠、撤权竞态见 `PC-CX-21/23/26` |
| 4 | BLOCKED | 策略/并发只有快照检查，没有人工写与派发提交的共同门，`PC-CX-26` |
| 5 | BLOCKED | snapshotHash 缺决策输入；D9 不能维持其读取的跨表不变量，`PC-CX-21/22/27` |
| 6 | BLOCKED | FAIL 机械后果明确，但语义 turn 原因不唯一，`PC-CX-23` |
| 7 | BLOCKED | CAS 方案本身可收敛，但 AG1/AG5 同时给出有键/无键两种规范，`PC-CX-27` |
| 8 | BLOCKED | blocker 去重/升级主模型通过；clear→recur 的 turn key 仍错误复用，`PC-CX-24` |
| 9 | BLOCKED | 下一 lease 破坏 I11，混合旧写端可越权，`PC-CX-21/25` |
| 10 | BLOCKED | 计划中的展示字段存在，但可重放审计的 hash 不完整，`PC-CX-22` |
| 11 | BLOCKED | 存量默认安全；任意混合版本写入不能维持 authority 投影，`PC-CX-25` |
| 12 | BLOCKED | 验收流程存在，但 acceptanceAttempt/mergeEvidence 不在 frozen snapshot，且 AE8 锁词冲突，`PC-CX-22/27` |

## 5. 可自动化清单

本轮已落地前 9 个，后续修订应把它们从“证明缺陷存在”翻转成“旧交错被拒绝/得到唯一合法结果”：

1. 合法 Coordinator dispatch 后推进 runtime token，live Session 的稳定归属仍成立（模型 + PostgreSQL）。
2. live Task 跨 Project 移动不得在不迁移/结束归属的情况下提交（模型 + PostgreSQL）。
3. 从 action/key/blocker/wake/acceptance 的实际读集生成 frozen snapshot 字段集，双向比对。
4. 相同 decision hash 必须得到逐字相同的 actions/blockers/nextWake；时间与 manual event 变更必须改变输入身份。
5. 五类 turn reason 的全部组合只产生零或一条规范化 turn。
6. 四个 opensTurn blocker 跑 `open → progress → clear → identical recur`，第二 episode 获得新 turn。
7. 旧二进制 SQL 跑 task move 与 session terminal，authority projection 不陈旧或被数据库拒绝。
8. 人工 disable/policy change/max change/manual start 与 Coordinator dispatch 跑双事务 barrier 的两个提交顺序。
9. 静态断言 AG1 不再提 aggregate action key，AE8 不再提 `FOR SHARE`。
10. action APPLIED 后的允许状态转移/不可变列逐项变异，D9 读取的每个外部 mutator 都有反向约束。
11. 取不到 lease 的 worker 不写 runtime/decision；若需要安排 wake，明确是进程内调度还是由 holder/定时扫描负责。
12. 项目级并发若包含人工 Session，使用共同 slot primitive；若人工 override，API/审计/状态查询逐层显式标记。

## 6. 命令、关键输出与环境

被验分支与提交：

```text
$ git rev-parse feat/project
691757e7943bed46fe765a8fe73e07312bb96b83

$ git status --short --branch   # 独立审查工作树开工时
## orbit/02-coordinator-23f84d
```

既有套件（无数据库）：

```text
$ tsc --strict <coordinator-contract, counterexample, linearization.pg>
$ node --test <3 compiled specs>
# tests 68; pass 61; fail 0; skipped 7; duration_ms 1743.621145
```

新增反例（无数据库）：

```text
$ tsc --strict coordinator-v13-adversarial.spec.ts
$ node --test coordinator-v13-adversarial.spec.js
# tests 9; pass 8; fail 0; skipped 1; duration_ms 147.969408
```

真实 PostgreSQL 16.14 全量复跑：首次把新增 spec 与研发 spec 并行运行时，两边都重建 `public.task`，得到 2 个**夹具互撞**失败（`23505 pg_type_typname_nsp_index` / `42703 column t.project_id does not exist`）。这不是契约结果；将新增 spec 隔离到 `pcc_v13_adversarial` schema 后按相同命令重跑：

```text
$ NODE_PATH=/root/orbit/node_modules COORDINATOR_PG_URL=postgres://... \
    node --test <4 compiled specs>
# tests 77; pass 77; fail 0; skipped 0; duration_ms 8734.79264
# PC-CX-21 real PostgreSQL: pass（测试断言两种非法状态均可提交，随后 i11=false）
```

运行环境：Linux `6.12.38+deb13-cloud-amd64` x86_64；Node `v22.22.2`；npm `10.9.7`；TypeScript `5.9.3`；git `2.47.3`；Docker `29.5.2`；PostgreSQL `16.14`（一次性 `postgres:16-alpine` 容器，验证后已删除）；工作树 `/root/.orbit/worktrees/01a017d7-a35b-79b2-871c-f98427ba5b4a`；分支 `orbit/02-coordinator-23f84d`。

验证提交、`feat/project` 合并 SHA/方式与目标工作树保护证据记录在本任务的最终 Orbit 评论；本文与新增 spec 所在提交即本轮验证提交。
