# Project Coordinator 契约 v1.1 独立复审（02）

> 审查任务：`02 独立审查 Coordinator 契约与故障模型`（Orbit task `349bQGkoTy7QmNXtyRKaO`）
>
> 被验修订：`be67fa9d1cbb7d737c333aa34ae2d656001be018`
>
> 前轮证据：[`project-coordinator-contract-review-02.md`](./project-coordinator-contract-review-02.md)
>
> 审查日期：2026-08-19
>
> 约束：不修改 `project-coordinator-contract.md` 或研发测试来消除失败；本文件只记录独立反例和后续自动化清单。

## 1. 结论

**FAIL / BLOCKED**。v1.1 对前轮 `PC-CX-01..08` 的指定反例给出了实质性修订，新增的 29 个纯文档/内存模型测试也全部通过；但把修订规则重新放回并发事务、重复事件、升级和终态写入后，仍发现 **1 个 P0、5 个 P1**：

| ID | 级别 | 受影响验收 | 结论 |
|---|---|---|---|
| `PC-CX-09` | **P0** | AC2 · AC5 · AC9 · AC11 | 派发权切换与旧 Session 插入没有共同锁；触发器可读到旧 `LEGACY` 后放行越权派发 |
| `PC-CX-10` | **P1** | AC2 · AC3 · AC8 | `reasonDigest` 包含 blocker `occurrences`，重复信号会改变动作键并绕过 no-progress 去重 |
| `PC-CX-11` | **P1** | AC3 · AC4 | dispatch epoch 使用可清零的 `failureCount`；人工修复后重用旧键，任务永久无法再派发 |
| `PC-CX-12` | **P1** | AC4 · AC8 | blocker 升级会修改 owner，却不修改 kind/opensTurn，与 BL4 的双向等价冲突 |
| `PC-CX-13` | **P1** | AC5 · AC12 | AE3 没有与所有相关写入线性化；DONE 后的 Task 变化也不会被事件拉回非终态 |
| `PC-CX-14` | **P1** | AC3 · AC9 | 人工 Session 会令守卫返回 EXECUTING，但没有 DISPATCH action，违反该状态的不变量与观测判据 |

因此 02 的验收条件“无未解决 P0/P1 契约歧义”仍不成立。审查证据可用于 Coordinator 再次原生退回或创建缺陷子任务；03 不应在这些规则未冻结前启动。

## 2. 新增结构化失败证据

### PC-CX-09 — 派发权切换与触发器读取不线性化（P0）

**契约证据**：

- §7.7 D6 的触发器只执行普通 `SELECT t.dispatch_authority`，没有行锁、generation 或 CAS。
- §12.3 D3 允许在 Project 启用/关闭或 Task 移入/移出 Project 时批量修改 `task.dispatch_authority`。
- D5 的唯一索引只保证“至多一条 Session”，不保证 authority 切换事务与 Session 插入的先后关系。

**最小交错**：

1. Task X 当前为 `LEGACY`。
2. `T_enable` 执行 `UPDATE task SET dispatch_authority='COORDINATOR' WHERE id=X`，尚未提交。
3. 旧实例 `T_old` 插入 X 的 Session；`BEFORE INSERT` 里的普通 SELECT 按 MVCC 看到最近已提交值 `LEGACY`，因此放行 `dispatch_origin='LEGACY_SWEEP'`。
4. `T_old` 与 `T_enable` 都提交。
5. 最终 X 为 `COORDINATOR`，却已有一条旧 sweep 创建的 Session。D5 没有冲突，因为只有这一条；D6 没有拒绝，因为它读到旧 authority。

**权威预期**：authority 切换和任何 task Session claim 必须有一个共同的数据库线性化点；切换排在前面则旧插入被拒，旧插入排在前面则启用事务必须看见/处理该 Session，不能得到“COORDINATOR authority + LEGACY origin live Session”。

**责任人与恢复**：SYSTEM/数据库协议；不能靠重试清理已经启动的越权 Session。修订应让触发器取得与 authority 更新冲突的行锁，或引入同一行 generation/CAS，并要求 D3 的所有更新入口使用同一 primitive。真实 Postgres 测试必须在 update 与 trigger SELECT 之间放 barrier，覆盖两个提交顺序。

### PC-CX-10 — 重复事件通过 `occurrences` 改变 turn 幂等键（P1）

**契约证据**：

- §5.1 E1 冻结“事件是信号不是事实”，重复投递不应产生额外副作用。
- §11.3 规定同因重复事件会令 blocker `occurrences += 1`。
- §7.2 `BLOCKER_DECISION.turnFacts` 却包含 `(kind, subjectId, occurrences)`；§7.6 TR1 再把它放进 `reasonDigest`。

**最小反例**：

1. `MERGE_CONFLICT` occurrences=1，打开 turn，键为 `turn:g:d1`；turn 结束但冲突未解决。
2. 同一 merge conflict 的重复信号到达，唯一业务条件未变，但 occurrences 变成 2，digest 从 d1 变成 d2。
3. 60 秒后 TR2 不再限频；TR1 把 d2 当成“事实变化”，允许第二个 turn，而不是按 TR3 打开 `COORDINATOR_NO_PROGRESS`。
4. 每隔 60 秒重复一次信号即可持续制造新 turn。

**权威预期**：投递/观测次数只能用于去重统计和升级，不能进入语义事实摘要。turnFacts 应绑定 blocker 条件本身的规范化指纹；同一条件的重复、乱序和重投必须保持同一个 digest。

**责任人与恢复**：orchestration service；移除 occurrences 或把“条件版本”与“出现次数”分列。新增属性测试：随机重复事件次数不改变 reasonDigest、turn action 数或最终 blocker 状态。

### PC-CX-11 — `failureCount` 清零复用旧 dispatch key（P1）

**契约证据**：

- §8.2 把 dispatch epoch 冻结为 `task.failureCount`。
- §19.6 的恢复路径明确要求人处理后把失败计数清零。
- `project_action.idempotency_key` 全局唯一且历史行不删除；§8.5 将键冲突视为已应用并跳过副作用。

**最小反例**：

1. X 首次派发使用 `pc:v1:p:dispatch:X:0` 并 APPLIED。
2. 连续失败达到 MAX，开 `TEST_FAILED`。
3. 用户修复并按 §19.6 清零 `failureCount=0`。
4. 控制环再次派发时重新计算同一个 `...:X:0`；动作冲突被当作 ALREADY_APPLIED，Session 插入被跳过。
5. 每次 reconcile 都得到同一结果，X 永久无法再运行。

**附带状态矛盾**：§19 汇总表把退避期权威状态写成 `EXECUTING`；§9.5 Q3 说失败任务对状态无贡献；§4.2 守卫在“单 Task 已失败、无 live Session、无 blocker、只有未来 nextWake”的最小场景中只能返回 `PLANNING`。指定的测试失败场景因此仍没有单一文字答案。

**权威预期**：幂等 epoch 必须单调且永不复用，例如独立的 `dispatch_generation/attempt`；`failureCount` 只负责策略，不能同时充当动作身份。失败表应按 `runStateOf` 给出最小场景的确切状态。

**责任人与恢复**：orchestration service/数据模型；迁移和测试须预置历史 attempt=0，执行失败清零后断言产生新键和新 Session。

### PC-CX-12 — owner 升级破坏 BL4 双向等价（P1）

**契约证据**：

- §7.2 TU1 按 blocker kind 的封闭列表决定是否开 turn。
- §11.2 BL4 声明 `opensTurn = ✔` 当且仅当 `owner = COORDINATOR`。
- §11.5 又规定同一 blocker 的 owner 按 `SYSTEM → COORDINATOR → USER` 改写，ES1 只保证 recovery 不变；kind/opensTurn 不变。

**两个反例**：

- `PROVIDER_UNAVAILABLE` 初始 SYSTEM/opensTurn=✘，升级到 COORDINATOR 后仍不在 kind 列表：owner=COORDINATOR 但 opensTurn=✘。
- `MERGE_CONFLICT` 初始 COORDINATOR/opensTurn=✔，升级到 USER 后 kind 仍在列表：owner=USER 但 opensTurn=✔，项目一边等待人一边继续开 Coordinator turn。

**权威预期**：责任归属、通知升级目标和 turn eligibility 必须是不同轴。可冻结 `defaultOwner/resolutionOwner/escalationOwner`，或明确 opensTurn 只由 kind 决定并删除对“当前 owner”的 iff；不得同时保留现有三条规则。

**责任人与恢复**：blocker policy；属性测试应对 18 个 kind 逐级升级，并在每一步核对 run state、turn action、nextWake 和通知次数。

### PC-CX-13 — DONE 硬门没有覆盖并发 Task 写与终态后变化（P1）

**契约证据**：

- AE3 允许仅用 `REPEATABLE READ`，或在 DONE 事务里锁住读到的 Task 行。
- Task/verdict/criteria 写路径没有被要求获取同一个 Project/generation 锁，也没有规定 Project DONE 后禁止这些写入或原子重开。
- §4.2 守卫 1 把 `project.status=DONE` 永远判为 SETTLED；因此 AE3 所说“后提交的 task.status_changed 会把项目重新拉回 PLANNING”不成立。

**最小交错**：

1. `T_done` 在 REPEATABLE READ 快照 H1 上算出匹配 digest。
2. `T_task` 把一个 DONE Task 改回 OPEN；它写另一行，与 `T_done` 的 Project 写不构成冲突。
3. 两事务均提交，得到 `project.status=DONE + task.status=OPEN`。
4. task 事件触发 reconcile，但守卫 1 仍返回 SETTLED，不会回到 PLANNING。

即便 `T_done` 对现有 Task 行加锁，DONE 提交后新建/重开 Task 仍可发生，除非所有相关写路径共同锁定 Project 或检查终态。

**权威预期**：所有进入 acceptanceDigest 的数据库事实共享一个单调 `acceptance_generation` 或 Project 行锁；相关写入必须先递增/锁定它。DONE 用 CAS 校验 generation，并冻结 DONE 后写入是拒绝还是“同事务重开 Project”。外部 merge evidence 也需定义内容快照的原子边界。

**责任人与恢复**：Project/Task 服务层共同负责；用两个真实事务覆盖“任务先、DONE 先、并发提交、新建 Task、verdict 改变”全部顺序。

### PC-CX-14 — 人工 Session 与 EXECUTING 不变量冲突（P1）

**契约证据**：

- §7.7 D6 明确允许 `dispatch_origin=USER` 且 `project_action_id=NULL` 的人工 Session。
- §4.2 守卫 5 看到任意 Task LIVE Session 就返回 EXECUTING。
- §4.1 对 EXECUTING 的不变量却要求至少一条 `DISPATCH_TASK` action 对应 LIVE Session；人工入口不写控制环 action。
- §10.3 (a) 同样只识别 APPLIED DISPATCH action 的 result Session。

**最小反例**：用户在无其它活动的 Coordinator Project 中手动启动 X。唯一 live Session 合法且 origin=USER，runStateOf 返回 EXECUTING，但 action 数为 0，因此状态表不变量为假。

**权威预期**：EXECUTING 与活性判据必须同时容纳“action-linked Coordinator Session”与“显式 USER Session”，或要求人工入口写一种独立审计/claim 行；不能要求人工动作冒充 Coordinator action。

**责任人与恢复**：run-state/observability contract；加入人工单独启动、人工与 Coordinator 竞争、人工 Session 结束三个状态序列测试。

## 3. 指定场景复验矩阵

| 场景 | v1.1 结果 | 唯一状态/动作/键/责任与恢复 | 复审 verdict |
|---|---|---|---|
| 重复事件 | 基础 action 冲突协议已修，但 blocker occurrences 会改 turn digest | 同因本应保持同 turn key，由 SYSTEM 去重 | **FAIL `PC-CX-10`** |
| 乱序事件 | reconcile 仍重读快照，不读 payload | 状态由 `runStateOf` 唯一计算 | PASS |
| 事务回滚 | outbox 与业务事务同生共死 | 无 event/action；SYSTEM 无需恢复 | PASS（实现阶段仍需真实 DB 注入） |
| 双 worker | fencing token 的提交门保持明确 | 新 token 唯一提交；旧 worker 回滚 | PASS（模型级） |
| Session 结束 | rotation generation 和落点规则明确 | `coord-session:<g+1>`；SYSTEM/USER 分支明确 | PASS |
| Runner 离线 | EVENT recovery + reaper 路径明确 | blocker/退避后按事件恢复 | PASS；升级后受 `PC-CX-12` 影响 |
| Provider 不可用 | 初始 SYSTEM/EVENT 明确 | blocker key 去重，恢复后 clear | 初始 PASS；升级 **FAIL `PC-CX-12`** |
| 无匹配 Runner | SYSTEM/EVENT 与能力不满足 USER/HUMAN 已分开 | 条件恢复/用户配置 | 初始 PASS；升级 **FAIL `PC-CX-12`** |
| 合并冲突 | no-progress blocker 已定义 | digest 未变应阻塞、事实变化再开 turn | 重复信号 **FAIL `PC-CX-10`**；升级 **FAIL `PC-CX-12`** |
| 测试失败 | turn 冲突已消除 | 退避、阈值 blocker、人工处理 | **FAIL `PC-CX-11`**（键复用与状态摘要冲突） |
| 预算耗尽 | SYSTEM/TIME 与窗口 wake 已修 | 到窗口边界自动解除 | 初始 PASS；owner 升级 **FAIL `PC-CX-12`** |
| 等待用户 | HUMAN recovery 与 N-null 已修 | 用户事件恢复 | PASS；由 COORDINATOR 升 USER 的 kind 受 `PC-CX-12` 影响 |
| 混合版本 | 已加 D5/D6 | 旧入口应由 DB 硬拒绝 | **FAIL `PC-CX-09`**（authority flip 竞态） |
| 人工同时操作 | D5 能保证插入时最多一条 | 败者结果基本明确 | **FAIL `PC-CX-09` / `PC-CX-14`** |
| 验收后事实变化 | digest 新鲜度已定义 | 旧记录不匹配 | 串行 PASS；并发/终态后变化 **FAIL `PC-CX-13`** |

## 4. 项目验收标准复核

| AC | 结果 | 未关闭证据 |
|---|---|---|
| AC1 | 条款覆盖 | 无新增 P0/P1 |
| AC2 | **BLOCKED** | `PC-CX-09`、`PC-CX-10` |
| AC3 | **BLOCKED** | `PC-CX-10`、`PC-CX-11`、`PC-CX-14` |
| AC4 | **BLOCKED** | `PC-CX-11`、`PC-CX-12` |
| AC5 | **BLOCKED** | `PC-CX-09`、`PC-CX-13` |
| AC6 | 条款覆盖 | 无新增 P0/P1 |
| AC7 | 条款覆盖 | 无新增 P0/P1 |
| AC8 | **BLOCKED** | `PC-CX-10`、`PC-CX-12` |
| AC9 | **BLOCKED** | `PC-CX-09`、`PC-CX-14` |
| AC10 | 条款覆盖 | 后续实现验证仍未执行 |
| AC11 | **BLOCKED** | `PC-CX-09` |
| AC12 | **BLOCKED** | `PC-CX-13` |

## 5. 后续自动化断言

- [ ] 真实 Postgres：authority UPDATE 与旧二进制 Session INSERT 双事务 barrier，两个提交顺序均满足派发权（`PC-CX-09`）。
- [ ] 属性测试：同一 blocker 条件重复/乱序 N 次，`reasonDigest`、turn 数和最终状态不变（`PC-CX-10`）。
- [ ] 动作账本：预置 dispatch attempt 0，失败到阈值、人工清零后必须生成新键与新 Session（`PC-CX-11`）。
- [ ] 状态模型：单任务 FAILED、无 live/blocker、退避中时按 RS0 得到唯一状态，并与 §19 汇总一致（`PC-CX-11`）。
- [ ] blocker 属性测试：每个 kind 走 SYSTEM→COORDINATOR→USER，逐步核对 `opensTurn`、run state、wake 和通知（`PC-CX-12`）。
- [ ] 真实 Postgres：DONE 与 Task reopen/create/verdict change 双事务全交错，禁止 `DONE + 未收敛事实`（`PC-CX-13`）。
- [ ] 状态/活性：只有 USER-origin live Session 时，EXECUTING 不变量与 §10.3 查询均成立（`PC-CX-14`）。

## 6. 执行证据

```text
$ git rev-parse feat/project
be67fa9d1cbb7d737c333aa34ae2d656001be018

$ /root/orbit/node_modules/.bin/tsc --target ES2022 --module commonjs \
    --moduleResolution node --esModuleInterop --skipLibCheck --strict \
    --types node --typeRoots /root/orbit/node_modules/@types \
    --rootDir src/apiserver/src --outDir src/apiserver/build \
    src/apiserver/src/projects/coordinator-contract.spec.ts \
    src/apiserver/src/projects/coordinator-counterexample.spec.ts
# exit 0

$ node --test src/apiserver/build/projects/coordinator-contract.spec.js \
              src/apiserver/build/projects/coordinator-counterexample.spec.js
# tests 29
# pass 29
# fail 0
# duration_ms 235.657888

$ node -e '<second-round counterexample model>'
authorityFlipRace: triggerRead=LEGACY, finalAuthority=COORDINATOR, legacySessionCommitted=true
duplicateSignalDigest: occurrences1=e821d3e94271, occurrences2=163810345a75, sameBusinessCondition=true
failureReset: first=pc:v1:p:dispatch:X:0, afterHumanReset=pc:v1:p:dispatch:X:0, collides=true
escalationBL4: ownerAfterEscalation=COORDINATOR, opensTurnByKind=false, iffViolated=true
doneRace: projectStatus=DONE, taskStatus=OPEN, runState=SETTLED
manualExecution: runState=EXECUTING, coordinatorDispatchActions=0, invariantSatisfied=false
backoffSingleTask: runState=PLANNING, section19Summary=EXECUTING
```

运行环境：Linux 6.12.38+deb13-cloud-amd64 x86_64；Node v22.22.2；TypeScript 5.9.3；git 2.47.3；工作树 `/root/.orbit/worktrees/01a017d7-a35b-79b2-871c-f98427ba5b4a`；分支 `orbit/02-coordinator-23f84d`。

本复审文档所在验证提交及向 `feat/project` 的合并状态记录在 Orbit 任务评论中。
