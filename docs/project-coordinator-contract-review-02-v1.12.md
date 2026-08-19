# 02 独立审查 Project Coordinator 契约与故障模型（v1.12）

结论：**FAIL / BLOCKED**。01L 对 `PC-CX-56..57` 的局部修订有可执行正反控制，但跨条款外扩后发现
1 个 P0 与 3 个 P1：现行规范对 lineage FK 的初始模式给出相反答案；一次性迁移表跳过全部 v1.11 数据库对象；
Project purge 会删除 D20-c 明确排除的 USER Session，并与裸删除产生不同结果；purge 的占位快照与并发发布之间有
TOCTOU，导致它承诺的合法操作在 `COMMIT` 得原生 `23503`。p02 不满足“无未解决 P0/P1”门槛。

本轮没有修改权威契约、PAC、研发测试或旧审查报告来换绿。新增内容只有本报告与独立 adversarial spec。

## 1. 权威上下文与被验提交

- Project：`349bHrtPbgwiouD3cfCVP`；重新读取 goal、12 条 acceptanceCriteria 与 instructions。
- 复审任务：`349bQGkoTy7QmNXtyRKaO`；本轮第一步用 `task_get` 读取完整信息与全部历史评论。
- 关联研发任务：01L `34A05y8Ec2NYUch1xoW8l`，状态 `DONE`；读取完整描述、验收条件、评论、会话与提交证据。
- 被验 01L/v1.12 提交：`ffe58ee1864caa3c2b0baa431106a37e05c7b722`。
- 前置 v1.11 验证提交：`1812ef2d56c0bb038f2f73eb7844f264d5fb123d`。
- 编辑/测试前门禁：审查树 `HEAD=1812ef2d…`、`feat/project=ffe58ee1…`、`git status --short` 为空；
  `git merge --ff-only ffe58ee1864caa3c2b0baa431106a37e05c7b722` 成功，随后 HEAD 精确等于候选且仍干净。

## 2. v1.12 局部关闭复验

| 原缺陷 | 独立结果 | 关键正反控制 |
|---|---|---|
| `PC-CX-56` | **局部关闭** | 声明式 linked-Project purge 正例提交、无 orphan；v1.11 立即 RESTRICT 与摘外键反向控制重现；裸删、伪造 fence、并发 purge 控制通过 |
| `PC-CX-57` | **局部关闭** | malformed ledger 不再绕过 link/claim freeze；终态、两种修复、首次 claim 正例通过；v1.11 early-return witness 重现 |

“局部关闭”不等于整个权威契约可放行：新增 D20 本身的量化域、并发线性化和迁移路径产生下列新阻断。

## 3. 新结构化失败证据

### PC-CX-58 / P1 — 同一现行外键同时是 INITIALLY IMMEDIATE 与 INITIALLY DEFERRED

**契约证据**：§2.4、D20 ① SQL、§12.1 步骤 6h 都规定
`session_project_action_fk ... DEFERRABLE INITIALLY IMMEDIATE`；同属规范正文的 D19-c 却规定
`NO ACTION DEFERRABLE INITIALLY DEFERRED`。两句不是历史日志，均在 §1–§18 的现行规范域。

**唯一权威状态**：没有。前者让普通事务默认保持 v1.11 的语句级检查；后者让每个事务默认把检查推迟到提交点。
错误发生时刻、调用方拿到的动作结果及混合版本行为因此有两个合法答案。

**确定动作 / 幂等键**：purge 不进动作键；同一写序列是否在语句处停止取决于迁移实现选择了哪一句。

**责任人与恢复**：Owner=Coordinator 契约/迁移负责人。把 §2.4、D19-c、D20 SQL、步骤 6h 统一成一个初始模式，
增加静态唯一性与 `pg_constraint.condeferrable/condeferred/confdeltype` 实测；历史措辞只能留在 §30 非规范日志。

**影响**：AC5/AC9/AC11；事务回滚、混合版本、人工裸 SQL。

### PC-CX-59 / P1 — “一次迁移”从 v1.10 直接跳到 v1.12，未安装 v1.11 硬门

**契约证据**：§12.1 声明 `0111_project_coordinator` 是一次迁移。表中 6g 明确安装 v1.10 的
`project_action_result_ledger_mutator BEFORE UPDATE`；下一行 6h 只安装 v1.12 的 lineage FK、purge fence/function/index。
整张迁移表没有 `project_action_result_session_fk`、`session_result_link_delete_guard`，也没有把 D18 重建成现行的
`BEFORE INSERT OR UPDATE`。G5 ⑱/⑲ 要“验证对象”，但没有任何步骤先创建对象。

**最小部署**：按步骤 1→7 从空库或 v1.10 形状执行。结果是 D20 存在，但 D19 结构/typed delete gate 不存在，
D18 仍只监听 UPDATE；畸形 ledger INSERT 与 Session hard delete 重新得到 v1.10 的错误答案。01L 评论也把“缺 v1.11 那一行”
列为未做遗留，证明不是另一个隐含步骤。

**唯一权威状态**：规范函数体描述 v1.12；权威迁移表实际描述“v1.10 + D20”。同一版本有两套数据库对象集合。

**确定动作 / 幂等键**：迁移 id 固定，但落地结果缺三项硬门；重跑 6h 不会补齐，不能靠幂等重试恢复。

**责任人与恢复**：Owner=Coordinator migration owner。新增显式 v1.11 行，按审计→D18 重建→D19 FK/trigger→D20
的依赖顺序落地；空库、v1.10 升级和 v1.11 升级三条路径都必须实际执行，并核验对象事件面/外键动作。

**影响**：AC9/AC10/AC11；混合版本、迁移、Session 删除与旧 ledger 恢复。

### PC-CX-60 / P0 — purge 的 OR 收集永久删除契约明确排除的 USER Session

**契约证据**：D20-c 声明 purge 第三类对象是“这本账认下的 COORDINATOR 占位”，并明确“不包括任何 USER-origin Session”。
但函数 ③-3 的实际谓词只有
`a.id = s.project_action_id OR a.result_session_id = s.id`，没有 `dispatch_origin='COORDINATOR'`、Task、action status/type
或双向一致性条件。fence 只查第一半 `a.id = s.project_action_id`。

**真实 PostgreSQL 最小反例**：

1. 插入两个 Project，各有一条 `REFUSED DISPATCH_TASK`；两条 action 的 `result_session_id` 分别指向一个
   `dispatch_origin='USER'` 且 `project_action_id IS NULL` 的 Session。D18、D19、D20 全部按现行 SQL 安装；写入合法提交。
2. 对第一组调用 `coordinator_purge_project()`，返回 `(purged_actions=1,purged_sessions=1)`，USER Session 被物理删除。
3. 对第二组执行裸 `DELETE project`，fence 看到 reverse lineage 为 0，删除提交但 USER Session 保留。
4. 同一事实分别得到“删 USER Session”与“留 USER Session”两个结果，直接反驳 D20-c 与 D20-f 的“结果集合相同”。

**唯一权威状态**：没有；调用入口决定不属于 Project purge 量化域的 USER 数据是否永久消失。

**确定动作 / 幂等键**：purge 无动作键；第一次错误调用已物理删行，原样重试只返回 `(0,0)`，无法恢复数据。

**责任人与恢复**：Owner=Coordinator purge/migration + Session lifecycle owner。收集谓词必须机械等于 D20-c，至少硬验
COORDINATOR、正确 action type/status、双向链接与 Project/Task 归属；不满足者应在 purge 前 typed fail closed 并进入人工裁决，
不能当成删除授权。补 USER、跨 Project、单向链接和存量畸形正反 PG。

**影响**：AC1/AC4/AC5/AC9/AC11；Project 权威边界、权限、审计、人工删除和不可恢复数据损失。

### PC-CX-61 / P1 — doomed-session 快照没有与并发发布线性化

**契约证据**：D20 ③-1 只锁 Project 行；③-3 读取 doomed Session，但不锁 action 行；③-4 才级联删除 action。
D20-e 声称发布者会在 purge 的 action delete lock 上排队，忽略了“快照完成、delete lock 尚未取得”的窗口。

**真实 PostgreSQL 最小交错**（逐句执行 D20 ③-1..③-6）：

1. Project 有 `a-old↔s-old` 与尚未发布的 `a-late`；purger `FOR UPDATE project`、设 fence、defer FK、读取 doomed，得到仅 `['s-old']`。
2. publisher 不触碰 Project 行；插入 `s-late→a-late`、把 action 发布成 `APPLIED→s-late`，事务提交。
3. purger 删除 Project/两条 action，只删除旧快照中的 `s-old`；`COMMIT` 得
   `23503 constraint=session_project_action_fk`，整个 purge 回滚，最终 `{project:1, action:2, session:2}`。
4. 正向控制：没有夹在快照后的发布时，同一函数返回 `(2,2)` 并提交。

**唯一权威状态**：结构安全由 FK 保住，但合法 purge 在 D20 明称支持的并发下得到原生数据库错误；没有 typed owner/recovery，
也没有确定赢家规则。

**确定动作 / 幂等键**：purge 无动作键；回滚后原样重试可能成功，也可能再次撞窗口，结果取决于调度而非持久代次。

**责任人与恢复**：Owner=Coordinator concurrency/DB protocol owner。必须让发布与 ③-3 共享线性化点：例如 purge 在快照前锁定
Project 的全部 action 且派发提交必经相同 Project fence，或让发布无条件共享 Project 锁；明确两个提交顺序的 typed 结果，
保留 deferred FK 作结构兜底而非正常控制流。

**影响**：AC2/AC3/AC5/AC9；事务回滚、双 worker、人工同时操作与活性。

## 4. 反例驱动故障矩阵

| 场景 | 权威状态 / 确定动作 / 幂等与恢复 | v1.12 结论 |
|---|---|---|
| 重复事件 | conditionVersion/episode 合并，动作键唯一 | PASS（既有矩阵） |
| 乱序事件 | reconcile 重读当前事实，不信事件 payload | PASS |
| 事务回滚 | outbox 与事实同事务；D20 FK 可整事务回滚 | **BLOCKED**：正常并发以原生 23503 回滚且无 owner/recovery（PC-CX-61） |
| 双 worker 竞争 | lease fencing + action unique key | **BLOCKED**：purge/publish 未共享线性化点（PC-CX-61） |
| Session 结束 | 运行终态、Task、Session 生命周期分开 | **BLOCKED**：purge 可越界物理删 USER Session（PC-CX-60） |
| Runner 离线 | reaper → typed blocker → 恢复事件 | PASS |
| Provider 不可用 | `PROVIDER_UNAVAILABLE`；不得静默 fallback | PASS |
| 无匹配 Runner | `NO_MATCHING_RUNNER` + capability blocker | PASS |
| 合并冲突 | typed blocker，重采目标分支 | PASS |
| 测试失败 | 原生 verdict 退回/缺陷/下游阻断 | PASS |
| 预算耗尽 | budget blocker + 确定 next wake | PASS |
| 等待用户 | `AWAITING_HUMAN`，有升级时钟 | PASS |
| 混合版本部署 | DB gates 覆盖旧写端 | **BLOCKED**：一次迁移缺 D18-v1.11/D19（PC-CX-59），FK 初始模式冲突（PC-CX-58） |
| 人工同时操作 | policy/claim/delete 与 Coordinator 线性化 | **BLOCKED**：入口决定 USER 数据是否删除，发布竞态令 purge 回滚（PC-CX-60/61） |
| Project 物理删除（外扩） | 应有唯一 Project 级单事务 purge | **BLOCKED**：量化域、默认模式、迁移和并发均非唯一 |

## 5. 12 条 Project AC 判定

| AC | 判定 | 证据/阻断 |
|---:|---|---|
| 1 | BLOCKED | Project purge 可越界删除 USER Session（PC-CX-60） |
| 2 | BLOCKED | purge/publish 缺共同线性化点，原样重试结果依赖调度（PC-CX-61） |
| 3 | BLOCKED | 合法 purge 只得到原生 23503，无 blocker/owner/next check（PC-CX-61） |
| 4 | BLOCKED | D20 SQL 未执行“不得删除 USER-origin Session”的权限边界（PC-CX-60） |
| 5 | BLOCKED | 同一 FK 初始模式和同一 purge 输入各有两个权威答案（PC-CX-58/60） |
| 6 | PASS | 验证 FAIL/INCONCLUSIVE 的退回、缺陷和下游阻断未被 01L 改坏 |
| 7 | PASS | 父 Task 聚合与代次规则未被 01L 改坏 |
| 8 | PASS | 六类指定 blocker 与去重机制保持唯一 |
| 9 | BLOCKED | 并发 purge 不可恢复；混合部署缺硬门（PC-CX-59/61） |
| 10 | BLOCKED | 新独立 spec 证明研发矩阵未覆盖量化域、迁移连续性和快照竞态 |
| 11 | BLOCKED | 一次迁移跳过 v1.11，且外键初始模式冲突（PC-CX-58/59） |
| 12 | PASS | 项目级验收与合并硬门本身未被 01L 改坏 |

## 6. 自动化清单

落地于 `src/apiserver/src/projects/coordinator-v112-adversarial.spec.ts`：

1. 静态比较 §2.4、D19-c、D20 SQL 的 FK 初始模式，稳定证明两份现行答案。
2. 机械读取 §12.1 迁移表，证明 6g 是 v1.10 UPDATE-only D18、6h 只建 D20，D19 两对象无创建步骤。
3. PG：REFUSED action 单向指向 USER Session；函数 purge 删除 USER 行，裸删保留 USER 行。
4. PG：逐句暂停在 D20 doomed 快照后，提交一次完整发布；purge COMMIT 得 23503 且整事务回滚。
5. PG 正向控制：没有快照后发布时，同一函数删除两条 action/Session 并提交。

关闭测试必须把以上失败断言翻转，并增加：USER/cross-Project/单向/错误 status/type 不得进入 doomed；空库、v1.10、v1.11
三条迁移路径对象集合一致；purge 与发布两个提交顺序各有确定赢家和 typed recovery。

## 7. 命令与关键输出

```text
git merge --ff-only ffe58ee1864caa3c2b0baa431106a37e05c7b722
# Updating 1812ef2d..ffe58ee1; Fast-forward; 4 files +1102/-110
git rev-parse HEAD
# ffe58ee1864caa3c2b0baa431106a37e05c7b722

/root/orbit/node_modules/.bin/tsc --strict ... coordinator-*.spec.ts
# exit 0
env -u COORDINATOR_PG_URL ... node --test coordinator-*.spec.js
# tests 263; pass 206; fail 0; skipped 57; duration_ms 1378.464724

COORDINATOR_PG_URL=<本轮专用> ... node --test coordinator-*.spec.js
# tests 263; pass 263; fail 0; skipped 0; duration_ms 22330.017447

tsc --strict ... coordinator-v112-adversarial.spec.ts
# exit 0
env -u COORDINATOR_PG_URL ... node --test coordinator-v112-adversarial.spec.js
# tests 4; pass 2; fail 0; skipped 2
COORDINATOR_PG_URL=<本轮专用> ... node --test coordinator-v112-adversarial.spec.js
# tests 4; pass 4; fail 0; skipped 0; duration_ms 596.548166
# PC-CX-60 witness={"function":"USER session deleted","bare":"USER session kept"}
# PC-CX-61 witness={"doomed":["s-old"],"late":"s-late","commit":"23503","rolledBack":{"p":1,"a":2,"s":2}}

# 加入独立 spec 后的最终全量复跑
/root/orbit/node_modules/.bin/tsc --strict ... coordinator-*.spec.ts
# exit 0
env -u COORDINATOR_PG_URL ... node --test coordinator-*.spec.js
# tests 267; pass 208; fail 0; skipped 59; duration_ms 1367.74482
COORDINATOR_PG_URL=<本轮专用> ... node --test coordinator-*.spec.js
# tests 267; pass 267; fail 0; skipped 0; duration_ms 20808.548092
```

全绿的含义：研发的局部关闭断言保持绿；新增独立测试也稳定证明 `PC-CX-58..61` 当前存在。

## 8. PostgreSQL 隔离与清理证据

本轮只创建下列对象，无 volume：

```text
container  pcc02-v112r-pg-349bqgko-20260819c
network    pcc02-v112r-net-349bqgko-20260819c
database   pcc02_v112r_349bqgko_20260819c
user       pcc02_v112r_349bqgko
host       127.0.0.1:32780
image      postgres:16-alpine
storage    --tmpfs /var/lib/postgresql/data; docker inspect mounts=[]
```

创建前精确 container/network inspect 均 `rc=1`。第一条 fixture DDL 前先只读预检，再由
`coordinator-pg-test-safety.ts` 在每个连接第一条查询二次核验并打印：

```text
database=pcc02_v112r_349bqgko_20260819c
user=pcc02_v112r_349bqgko
server=172.23.0.2/32:5432
system_identifier=7675827153951584291
version=16.14
```

测试结束后只删除上述精确容器与网络，并以 exact inspect 复核不存在。全程不列举、不连接、不 exec、不传入任何共享
PostgreSQL 的名称、数据库、IP 或凭据；共享控制面零 DDL/DML。

## 9. 运行环境、范围与放行条件

- Linux `6.12.38+deb13-cloud-amd64` x86_64；Europe/Berlin。
- Node `v22.22.2`；npm `10.9.7`；TypeScript `5.9.3`；Git `2.47.3`；Docker `29.5.2`；PostgreSQL `16.14`。
- 工作树：`/root/.orbit/worktrees/01a01971-bb7b-7593-91ed-3d6648a3dc9d`，分支 `orbit/02-coordinator-32ba2b`。
- 被验 SHA：`ffe58ee1864caa3c2b0baa431106a37e05c7b722`。
- 验证 SHA 与 fast-forward 合并状态由最终 task comment 记录。

放行 p02 的必要条件：权威契约逐项关闭 `PC-CX-58..61`；迁移表连续覆盖 v1.11/v1.12 对象；D20 的 SQL 量化域
与 D20-c 完全相同；purge/publish 在两个提交顺序下都有确定结果；新增反例翻转且保留当前 witness 为反向控制；strict、
无 DB、全隔离 PG、scope 与 `git diff --check` 全绿。完成前 p02 必须保持 `IN_PROGRESS`。
