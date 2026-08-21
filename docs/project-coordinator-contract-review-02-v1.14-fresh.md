# 02R 新鲜独立复审：Coordinator 契约 v1.14

结论：**PASS**。被验提交 `d1a63ddc7bcb0b07ffe63ade2699650c732d503a` 关闭了
`PC-CX-62`；既有 `PC-CX-01..61` 全矩阵保持通过。本轮没有发现新的 P0/P1 契约歧义。

本报告与 `coordinator-v114-fresh-review.spec.ts` 是独立复审证据；没有修改
`docs/project-coordinator-contract.md`、PAC、研发测试或 v1–v1.13 的十四份独立报告。
报告所在验证提交及其 fast-forward 合并状态记录在 Orbit 任务 02 与 02R 的评论中，避免在提交正文里
自引用尚未产生的 SHA。

## 1. 权威上下文与被验范围

- Project：`349bHrtPbgwiouD3cfCVP`；已完整读取 goal、12 条 acceptanceCriteria、instructions。
- 原 02：`349bQGkoTy7QmNXtyRKaO`；已逐条读取 29 条历史评论，包括 v1–v1.13 的提交、命令、PG 身份和结构化 blocker 证据。
- 01N：`34A3Fn4baQpge1iligiet`；已读取完整描述、验收条件与两条评论。
- 被验修订：`55aadc52767f3cd035bea863746e6424369363cc..d1a63ddc7bcb0b07ffe63ade2699650c732d503a`，恰好修改权威契约与五份研发/翻转 spec，共 6 文件、`+669/-86`。
- `git diff --name-only 55aadc52 d1a63ddc -- 'docs/project-coordinator-contract-review-02*.md' docs/project-agent-contract.md` 无输出：旧报告与 PAC 未改。
- 复审树：`/root/.orbit/worktrees/pcc02r-34a4mpaz-20260819`；分支 `orbit/02r-coordinator-fresh-34a4mpaz`，从当时最新 `feat/project=d1a63ddc…` 新建。

## 2. `PC-CX-62` 独立判定

D20 ⓪ 的唯一可执行谓词逐列要求：

1. Session `dispatch_origin = 'COORDINATOR'`；
2. action `type = 'DISPATCH_TASK'` 且 `status = 'APPLIED'`；
3. `session.project_action_id = action.id` 与 `action.result_session_id = session.id` 双向一致；
4. action `subject_type = 'TASK'`；
5. `session.task_id` 非空且 `action.subject_id = session.task_id`；
6. 存在该 Task，且 `task.project_id = action.project_id`；
7. 没有另一 Project 的账本也以 result link 指向该 Session。

旧分支 `status <> 'APPLIED' AND result_session_id IS NULL` 不再位于 ⓪ 的可执行 SQL 中。
裸 `DELETE` fence 与公开 `coordinator_purge_project()` 都只调用同一个 ⓪，并在删除前按相同
`ORDER BY action_id, session_id` 选择第一条 `in_scope=false`，返回同一
`PROJECT_PURGE_UNDECIDABLE (owner=USER, recovery=HUMAN)`。迁移步骤 6h 的存量审计与 G5 第 ㉖ 条也读取同一谓词。

既有反例重跑证明：`REFUSED` / `CLAIMED`、错误 `subject_type`、错误 `subject_id`、Session 无 Task、
Task 属于另一 Project，均在函数和裸删入口 typed fail closed、数据不丢；完整 APPLIED/TASK/双向归属正例仍 `(1,1)`，空 Project 裸删仍提交；v1.13 的两条 witness 作为反向控制仍可重现旧缺陷。

## 3. 本轮扩展反例：合法 sibling + 缺失 Task

新增测试不复用研发模型结论，而是再次从权威文档抽取 D18/D19/D20 SQL，在真实 PostgreSQL 构造：

- 同一 `p-mixed` 下有一条完整合法的 `a-good ↔ s-good ↔ t-good`；
- 同时有一条 APPLIED、TASK subject 与 Session task id 彼此相等，但 Task 行不存在的
  `a-missing-task ↔ s-missing-task ↔ t-missing`。

关键输出：

```text
classified = [
  {action_id:a-good,         in_scope:true,  reason:"in scope"},
  {action_id:a-missing-task, in_scope:false, reason:"the task this session runs belongs to another project"}
]
function answer == bare DELETE answer ==
  PROJECT_PURGE_UNDECIDABLE ... a-missing-task ... s-missing-task ...
  owner=USER, recovery=HUMAN ... nothing was deleted
after refusal = {projects:1,tasks:1,actions:2,sessions:2}
migration-audit count = 1
insert missing Task into p-mixed; retry => {purged_actions:2,purged_sessions:2}
after retry = {projects:0,tasks:0,actions:0,sessions:0}
empty Project bare DELETE = committed
```

这补上了既有“每个畸形形状单独一个 Project”之外的组合性质：一条坏 pair 必须让整个 purge 在任何删除前停止，
不能先删合法 sibling；人工恢复归属后，原样重试仍是可执行且幂等的。

## 4. 全量 Coordinator 契约矩阵

| 场景 | 结论 | 主要机械证据 |
|---|---|---|
| 重复/乱序事件 | PASS | `PC-CX-04/10/14..17`：事件消费与动作冲突分离，代次单调，重复投递状态等价 |
| 事务回滚 | PASS | stale fence 全事务回滚；合法中间态由 deferred gate 在最终行判定；purge 无局部删除 |
| 双 worker 竞争 | PASS | lease fencing、task partial unique claim、action unique key、purge Project/ledger 锁 |
| Coordinator Session 结束/轮换 | PASS | 稳定 Project→Agent/Workspace 绑定；Session 可轮换；历史 decision id 不设 FK |
| Runner 离线 | PASS | 结构化 blocker、nextCheck/wake、无静默 fallback |
| Provider 不可用 | PASS | PAC 执行上下文 commit-time 重解析；fallback 必须显式，错误有 owner/recovery |
| 无匹配 Runner | PASS | 同上；能力/Workspace/Runner 全读集进入 decision input 与摘要 |
| 合并冲突 | PASS | `MERGE_CONFLICT` blocker、去重升级与人工恢复；验收按内容而非 `--contains` |
| 测试/验证失败 | PASS | verdict revision、原生退回、缺陷子任务与下游阻断 |
| 预算耗尽 | PASS | `BUDGET_EXHAUSTED`、确定 nextWake、窗口恢复与无进展边界 |
| 等待用户 | PASS | USER blocker 优先级、`AWAITING_HUMAN`、无 backstop 空转 |
| 混合版本部署 | PASS | DB 维护 authority/attribution/frozen context；一次迁移三起点对象集合一致 |
| 人工同时操作 | PASS | Project/PAC/Task 共享提交门；manual 与 coordinator claim 只有一个赢家 |
| Project purge / Session 生命周期 | PASS | D19/D20 双向 FK、typed delete fence、两个发布/清除提交顺序；PC-CX-62 闭合 |
| 验收后事实变化 | PASS | acceptanceDigest、AE6/AE7 共同锁、AE8 原子重开、外部 refGeneration 检测 |

全量测试逐项覆盖 `PC-CX-01..62`、15 类故障和 12 条 Project AC；本轮没有新增 blocker。

## 5. 12 条 Project AC 判定

| AC | 契约层结论 | 证据摘要 |
|---|---|---|
| 1 | PASS | 稳定 Agent/Workspace 绑定、Base62、Session 轮换/恢复、D20 不跨 Project 删除 |
| 2 | PASS | outbox、租约、事件/动作幂等、重复乱序与重启收敛 |
| 3 | PASS | runState 守卫、nextWake 候选全序、结构化 blocker，禁止静默空转 |
| 4 | PASS | manual/guarded-auto/auto、预算/并发/审批/权限 commit gate |
| 5 | PASS | 完整 decisionInputHash、decision/action/event 审计与确定性动作键 |
| 6 | PASS | FAIL verdict 原生退回、缺陷子任务、下游阻断 |
| 7 | PASS | ALL_CHILDREN_DONE / VERIFICATION_PASSED 与 current-state CAS |
| 8 | PASS | Runner/Provider/merge/test/budget/user blocker 五字段、去重与恢复 |
| 9 | PASS | crash/lease takeover/mixed-version DB fences；无重复派发或越权 |
| 10 | PASS | Web/API/CLI 所需状态字段与单元/集成/PG/故障注入矩阵均已契约化 |
| 11 | PASS | 安全默认、显式启用；迁移从 empty/v1.10/v1.11 收敛同一对象集 |
| 12 | PASS | 当前事实绑定的 acceptanceDigest、合并内容证据、DONE 硬门与事实变更重开 |

## 6. 命令与结果

```text
# 候选原样 strict
tsc --strict ... src/apiserver/src/projects/coordinator-*.spec.ts
# exit 0

# 候选原样 no-DB
env -u COORDINATOR_PG_URL ... node --test coordinator-*.spec.js
# tests 286; pass 218; fail 0; skipped 68

# 新增 focused no-DB
node --test coordinator-v114-fresh-review.spec.js
# tests 2; pass 1; fail 0; skipped 1

# 新增 focused isolated PG
COORDINATOR_PG_URL=<本轮专库> ... node --test coordinator-v114-fresh-review.spec.js
# tests 2; pass 2; fail 0; skipped 0

# 最终全 strict
tsc --strict ... src/apiserver/src/projects/coordinator-*.spec.ts
# exit 0

# 最终全 no-DB
env -u COORDINATOR_PG_URL ... node --test coordinator-*.spec.js
# tests 288; pass 219; fail 0; skipped 69; duration_ms 1325.638304

# 最终唯一隔离 PG 全矩阵
COORDINATOR_PG_URL=<本轮专库> ... node --test coordinator-*.spec.js
# tests 288; pass 288; fail 0; skipped 0; duration_ms 24420.955951
```

## 7. PostgreSQL 隔离与清理

本轮只创建一个 PostgreSQL server instance：

```text
container  pcc02r-v114-pg-34a4mpaz-20260819
network    pcc02r-v114-net-34a4mpaz-20260819
database   pcc02_r_v114_34a4mpaz_20260819
user       pcc02_r_v114_34a4mpaz
host       127.0.0.1:32782
server     172.23.0.2/32:5432
system_identifier 7675861090896035875
image      postgres:16-alpine
version    16.14
mounts     []（data 为 tmpfs，无 volume）
```

创建前对精确 container/network 名 inspect 均 `rc=1`。最初 bootstrap database/role 名 `pcc02r_*`
被 `coordinator-pg-test-safety.ts` 的 `^pcc(?:[0-9]+)?[_-]` 门在任何 fixture DDL 前拒绝；没有放宽安全闩，
也没有创建第二个实例，而是在同一个已核验 server 内创建上面的合规专库/用户，再从宿主连接做只读身份核验。
每个 PG 测试进程的第一条查询再次核验并打印相同 database/user/server/system identifier/version。

测试结束后先做末次只读身份核验，再只删除上述精确 container 与 network；post-cleanup exact inspect
两者均 `rc=1/not found`。全程没有列举、连接、exec、迁移、传入或修改共享 `orbit-postgres` / `orbit`
数据库、IP 或凭据；共享控制面零 DDL/DML。

## 8. 环境与放行条件

Linux `6.12.38+deb13-cloud-amd64` x86_64，Europe/Berlin；Node `v22.22.2`；npm `10.9.7`；
TypeScript `5.9.3`；Git `2.47.3`；Docker `29.5.2`；隔离 PostgreSQL `16.14`。

放行：**PASS**。`PC-CX-62` 已关闭，`PC-CX-01..61` 无回归，无新增 P0/P1。后续实现阶段仍须把当前
契约里的迁移对象与 G5 矩阵落为真实业务实现；这不是本契约复审门的遗留 blocker。
