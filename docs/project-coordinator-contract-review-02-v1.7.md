# Project Coordinator 契约 v1.7 独立复审（任务 02，第八轮）

## 1. 结论

**FAIL / BLOCKED：v1.7 仍不能作为“无未解决 P0/P1 歧义”的冻结契约。**

本轮先读取任务 02 的完整信息与七轮历史评论，再读取 Project 的 goal、12 条 acceptance criteria、instructions、p01 与 01G 的完整任务/评论。工作树在任何编辑和测试前从上一轮审查提交 `021affc659cf01d5a9d7c8fb01fff3250f26b752` 安全 fast-forward 到当时最新 `feat/project`：`574a2c9778babc6dee201f4f454da73df1ac683c`（01G / v1.7），并核验目标提交是当前 HEAD 的祖先。

没有修改 `docs/project-coordinator-contract.md`、PAC 或研发测试来掩盖失败；本轮只新增本报告和独立反例测试。01G 的七组研发回归在真实隔离 PostgreSQL 上 **172/172 全过**，01G 对 `PC-CX-37..42` 的声明覆盖也全部通过；反例外扩仍发现 **3 个 P0 + 1 个 P1**：

| ID | 严重度 | 结论 |
|---|---:|---|
| `PC-CX-43` | **P0** | D11 只在 `OLD.status = APPLIED` 时冻结整行；§8.3 发布动作的那条 `CLAIMED → APPLIED` UPDATE 可同时改写任意冻结列。D15 已在 Session INSERT 时运行，D14 明确不比较结果摘要，真实 PostgreSQL 可提交伪造的 `execution_result_digest` |
| `PC-CX-44` | **P0** | D15 的 INSERT/UPDATE 两支都遗漏 PAC create-frozen 的 `permissionMode`、`resolution`、`snapshotFrozenAt`；前两项又明确属于 EC2-b。真实 PostgreSQL 可让 Session 以 `danger-full-access` 和伪造 resolution 提交，而动作快照仍是 `read-only` |
| `PC-CX-45` | **P0** | D9/D14/D15 都按 **NEW** 的 `task_id/origin` 决定是否适用；一条 UPDATE 可同时把 COORDINATOR Session 改成 `task_id=NULL, origin=USER, action_id=NULL`，释放 D5 唯一 claim。真实 PostgreSQL 随后接受同一 Task 的第二条 live Session，并留下已 APPLIED 动作与 Session 反向断链 |
| `PC-CX-46` | **P1** | I17-A2 要求 generation 与 `detail.retiredPins[]` 双向一一对应，D15 却不读 action/detail；真实 PostgreSQL 接受 generation=2、`retiredPins`=0 的已提交状态 |

因此任务 02 的完成门槛仍未满足。Coordinator 应原生退回 p01 或创建后续契约缺陷任务；依赖“数据库对任何版本写端都封闭”的实现单元不能据 v1.7 宣称已满足 AC9/AC11。

## 2. 被验基线与独立性

```text
$ git rev-parse HEAD                         # fast-forward 前
021affc659cf01d5a9d7c8fb01fff3250f26b752

$ git rev-parse feat/project                # 当时最新
574a2c9778babc6dee201f4f454da73df1ac683c

$ git merge --ff-only feat/project
Updating 021affc6..574a2c97
Fast-forward
6 files changed, 1866 insertions(+), 164 deletions(-)

$ git rev-parse HEAD
574a2c9778babc6dee201f4f454da73df1ac683c

$ git merge-base --is-ancestor 574a2c9778babc6dee201f4f454da73df1ac683c HEAD
# exit 0

$ git status --short
# empty
```

01G 研发提交：

```text
574a2c97 docs(project): close the six coordinator contract blockers PC-CX-37..42
 docs/project-coordinator-contract.md               | 437 ++++++++++++++--
 coordinator-contract.spec.ts                       | 152 +++++-
 coordinator-counterexample.spec.ts                 | 515 +++++++++++++++++-
 coordinator-linearization.pg.spec.ts               | 575 +++++++++++++++++++++
 coordinator-v15-adversarial.spec.ts                 |   9 +-
 coordinator-v16-adversarial.spec.ts                 | 342 ++++++++----
```

本轮新增 `coordinator-v17-adversarial.spec.ts`。它读取但不改写权威文档；断言通过表示反例可复现，不表示契约通过。真实数据库 fixture 建立 D11、D15、D9 与 D5 partial unique index 的规范形状，并在任何 DDL/DML 前调用既有 `coordinator-pg-test-safety.ts` 的 URL 闩与数据库身份闩。

## 3. PostgreSQL 强制隔离证据

### 3.1 本轮唯一资源与写入前核验

- network：`pcc02-v17r-net-349bqgko-20260819e`
- container：`pcc02-v17r-pg-349bqgko-20260819e`
- database：`pcc02_v17r_349bqgko_20260819e`
- role：`pcc02_v17r_349bqgko`
- image：`postgres:16-alpine`
- host endpoint：`127.0.0.1:32775`
- isolated IP：`172.23.0.2`

创建前只对上述精确名称执行 `docker inspect` / `docker network inspect`，二者均 exit 1 / not found。创建结果：

```text
network_id=5e683491f1e2a6746d16905069d333a73a1c5716d8a7490671d777812f71a4bb
container_id=6b30ad4ef9da86728a4c88e7b3e7719bfd98829449760e934a46bf3ff5787d32
```

任何 DDL/DML 前，独立客户端先执行只读身份探针：

```text
current_database=pcc02_v17r_349bqgko_20260819e
current_user=pcc02_v17r_349bqgko
server=172.23.0.2/32:5432
system_identifier=7675747322955370530
server_version=16.14
```

每个 destructive test 连接后、fixture mutation 前再次调用 `verifyCoordinatorPgIdentity`，输出：

```text
# coordinator-pg-isolation database=pcc02_v17r_349bqgko_20260819e
# user=pcc02_v17r_349bqgko server=172.23.0.2/32:5432
# system_identifier=7675747322955370530 version=16.14
```

全程未连接、未 `docker exec`、未传入或读取共享 PostgreSQL 容器、数据库、IP 或凭据。所有破坏性 SQL 只作用于上述专用数据库的 `pcc_v17_rereview` 及研发测试自己的 `pcc_*` schema。

### 3.2 最后身份核验与精确清理

```text
database=pcc02_v17r_349bqgko_20260819e
db_user=pcc02_v17r_349bqgko
server_addr=172.23.0.2/32
server_port=5432
server_version=16.14
system_identifier=7675747322955370530

$ docker stop pcc02-v17r-pg-349bqgko-20260819e
pcc02-v17r-pg-349bqgko-20260819e
$ docker rm pcc02-v17r-pg-349bqgko-20260819e
pcc02-v17r-pg-349bqgko-20260819e
$ docker network rm pcc02-v17r-net-349bqgko-20260819e
pcc02-v17r-net-349bqgko-20260819e

$ docker inspect pcc02-v17r-pg-349bqgko-20260819e
# exit 1: no such object
$ docker network inspect pcc02-v17r-net-349bqgko-20260819e
# exit 1: network not found
```

只删除了上述本轮容器和网络。

## 4. 反例驱动故障矩阵

| 场景 | 唯一权威状态 | 确定动作 / 幂等键 | 责任人与恢复 | 判定 |
|---|---|---|---|---|
| 重复事件 | 事件只标脏，当前世界决定结果；未消费同因至多一行 | event partial unique key；动作永久键不变 | SYSTEM；重复消费影响 0 行 | PASS：E1、I14、EV4 与研发测试 |
| 乱序事件 | `evaluation.epoch` 快照 + W5 四元全序 | 同 `decisionInputHash` 得同动作/唤醒 | SYSTEM；consumer/backstop 重投 | PASS：W5、I18/I19 与 permutation 测试 |
| 事务回滚 | outbox、动作、副作用、decision 同生共死 | rollback 不占动作键 | 原调用者或接管 worker 重试 | PASS：N4、§8.3、C3 |
| 双 worker 竞争/接管 | 当前 fencing token 的 outcome 唯一 | 同 snapshot 同 key；旧 token 整事务回滚 | SYSTEM；lease 到期接管 | PASS（研发 PG 并发矩阵）；**但发布动作后冻结仍被 `PC-CX-43` 阻断** |
| Coordinator Session 结束 | status/end reason 触发重算，generation 单调 | `coord-session:<generation>` / rotate key | SYSTEM；自动轮换或 typed blocker | PASS：既有 F08/F09；本轮未发现新反例 |
| Runner 离线 | 在飞 Session 固定 runner，后续是 typed failure | dispatchAttempt / blocker lifecycle | SYSTEM/EVENT 或 USER/HUMAN | **BLOCKED：`PC-CX-44` 允许 resolution/权限与动作结果不同，恢复依据不再唯一** |
| Provider 不可用 | `PROVIDER_UNAVAILABLE` 或已授权 fallback | action key + result digest + blocker generation | SYSTEM/EVENT | **BLOCKED：D15 未比较整份 resolution，`PC-CX-44`** |
| 无匹配 Runner | `NO_MATCHING_RUNNER` / `RUNTIME_REQUIREMENT_UNMET` | REFUSE + blocker lifecycle generation | SYSTEM/EVENT 或 USER/HUMAN | PASS（能力列）；审计 resolution 仍受 `PC-CX-44` 阻断 |
| 合并冲突 | `MERGE_CONFLICT` blocker | condition/lifecycle generation | COORDINATOR，超时升级 USER | PASS：TF4/TR3；本轮未发现新反例 |
| 测试/验证失败 | verdictRevision 唯一决定退回/缺陷/阻断 | verdictRevision 永不复用 | COORDINATOR；修复后重新验证 | PASS：Q3/V7 |
| 预算耗尽 | TIME blocker 或 over-cap drain，不杀在飞 | blocker lifecycle / W5 wake | SYSTEM/TIME | PASS：唯一状态、时钟、责任与恢复均已定义 |
| 等待用户 | `AWAITING_HUMAN`，完整 blocker 五字段 | lifecycle generation / approval key | USER/HUMAN；升级时钟 | PASS：N-null/W5 |
| 混合版本部署 | 数据库约束应对任意写端维持动作与 Session 冻结 | D5/D6/D9/D11/D14/D15 | SYSTEM；结构化拒绝/重试 | **FAIL：`PC-CX-43..45` 都可绕过服务层并提交** |
| 人工同时操作 | 两种提交顺序都应有唯一合法结果 | shared locks + action epoch | USER/SYSTEM | **FAIL：一条人工/裸 UPDATE 可自我豁免并释放 claim，`PC-CX-45`** |

自动化覆盖已落入 `coordinator-v17-adversarial.spec.ts`：四个静态契约反例 + 四个真实 PostgreSQL 提交反例 + inventory；上表其余格由 01G 的 172 个既有测试回归。

## 5. Project 12 条 acceptance criteria 判定

| AC | v1.7 复审 | 证据 / 阻断 |
|---:|---|---|
| 1 | PASS | 稳定 Coordinator Agent、generation、Base62 条款未发现新反例 |
| 2 | PASS | outbox 原子性、重复/乱序、出环 disposition 的新覆盖通过 |
| 3 | **BLOCKED** | `PC-CX-45` 可释放 live Task claim 并隐藏第一条执行，权威运行状态与实际执行不再一一对应 |
| 4 | PASS（契约矩阵） | 自动化策略分档与人工 gate 本轮未发现新反例 |
| 5 | **BLOCKED** | `PC-CX-43/44`：动作所记 result digest 与 Session 实际权限/resolution 可不同 |
| 6 | PASS | verification verdict 的原生退回/创建缺陷/阻断下游仍唯一 |
| 7 | PASS | parent 聚合与复发代次未发现新反例 |
| 8 | **BLOCKED** | Provider/Runner 故障展示读取的 resolution 可与冻结动作不同（`PC-CX-44`） |
| 9 | **BLOCKED** | `PC-CX-43..46`：发布线性化、唯一 claim、快照 mutator 与 pin ledger 均未闭合 |
| 10 | **BLOCKED** | `PC-CX-43..46` 使审计动作、Session、digest、generation/ledger 彼此可矛盾 |
| 11 | **BLOCKED** | 任意版本/裸写端可通过数据库提交 `PC-CX-43..45` 三种违约状态 |
| 12 | PASS（契约层） | acceptanceDigest/DONE/merge evidence 本轮未发现新反例；实现仍归后续单元 |

## 6. 结构化失败证据

### `PC-CX-43` — P0 — 发布动作的状态转换不受 D11 冻结

- **契约冲突**：D11 的第一条语句是 `IF OLD.status <> 'APPLIED' THEN RETURN NEW`；§8.3 的规范顺序却明确先插 `CLAIMED` action、再插 Session、最后 UPDATE action 为 `APPLIED`。因此真正“发布”动作的 UPDATE 恰好处于 D11 全量放行的窗口。I17-A 仍宣称 APPLIED 行的两个摘要与 context 重算值相等，D14-g 又明确 D14 不比较 EC2-b，D15 已在 Session INSERT 时结束。
- **最小事务**：INSERT `CLAIMED` action（result digest=`result-ok`）→ INSERT 匹配 Session（D15 通过）→ `UPDATE action SET status='APPLIED', execution_result_digest='forged-after-session-insert'` → COMMIT。
- **真实 PostgreSQL 16.14**：事务提交；观察为 `{status:'APPLIED', execution_result_digest:'forged-after-session-insert'}`。D9 的 deferred attribution 同时通过。
- **权威状态/动作/键**：动作 idempotency key 唯一，但同一个 key 的冻结结果可在发布语句内被改写；没有拒绝动作或恢复路径。
- **责任人与恢复**：契约/迁移研发。D11 应冻结“发布后的 NEW 行”或为 `CLAIMED→终态` 定义封闭 transition allowlist；必须在 Session INSERT 后逐列 mutation 那条发布 UPDATE，而不是只 mutation 一个已 APPLIED 的 OLD 行。提交点还需重算/比较两个 digest。

### `PC-CX-44` — P0 — D15 没有覆盖 PAC 的完整 create-frozen 集合

- **契约冲突**：PAC §6 把 `resolution`、`permissionMode`、`snapshotFrozenAt` 都定为 Session create 冻结且只读；EC2-b 明确把 `permissionMode` 与整份 `resolution` 纳入结果摘要。D15 的 INSERT/UPDATE 分支均没有读取这三列，I17-A 的列举也遗漏它们。
- **最小事务**：action context 写 `permissionMode=read-only` 与合法 resolution；Session 其余六列完全匹配，但写 `permission_mode=danger-full-access` 与伪造 resolution；action 正常变为 APPLIED；COMMIT。
- **真实 PostgreSQL 16.14**：提交成功；观察为 `{session_permission:'danger-full-access', frozen_permission:'read-only', resolution_equal:false}`。
- **权威状态/动作/键**：同一个 action key/result digest 对应两份权限结果；没有 typed refusal。权限提升使该项按 P0 处理。
- **责任人与恢复**：Coordinator + PAC 契约研发。create-frozen 集合必须从 PAC 表生成或逐列闭合，D15 INSERT 要与 action context 比较，UPDATE 要冻结；I17-A 查询和 G5 mutation 同步覆盖。`snapshot_frozen_at` 还需定义唯一值/来源。

### `PC-CX-45` — P0 — Session 可用 NEW 值让所有硬门自我豁免并释放 D5 claim

- **契约冲突**：D9、D14、D15 都以 `NEW.task_id IS NULL OR NEW.dispatch_origin <> 'COORDINATOR'` 为提前返回谓词；D6 只在 INSERT 保护来源；D5 partial unique index 只覆盖 `task_id IS NOT NULL`。没有对象冻结 Session 的 `task_id`/`dispatch_origin` 或验证 OLD→NEW 的合法状态转换。
- **最小序列**：合法提交 Task t1 的 live COORDINATOR Session s1；单条 UPDATE 同时写 `task_id=NULL, dispatch_origin=USER, project_action_id=NULL` 并改 provider/permission；D9/D14/D15 都按 NEW 退出，CHECK 也成立；D5 claim 释放；随后合法提交 t1 的第二条 live Session s2。
- **真实 PostgreSQL 16.14**：最终 `{live_rows:2, task_claims:1, orphaned_actions:1}`；a1 仍为 APPLIED 且 `result_session_id=s1`，但 s1 已不再反向指向 a1。
- **权威状态/动作/键**：两个 action key 均唯一，却对应两条同时 live 的物理执行；数据库已丢失第一条的 Task 归属，无法确定取消/恢复责任人。
- **责任人与恢复**：Session/Coordinator 契约研发。对已有 COORDINATOR Task Session，scope 判定必须读 OLD 与 NEW，冻结 `task_id`/`dispatch_origin`/lineage（或定义一条受锁、可审计、先结束旧执行的转换）；D5 mutation 测试必须覆盖把索引谓词列移出集合。

### `PC-CX-46` — P1 — pin generation 与 action ledger 没有原子关系

- **契约冲突**：I17-A2 要求 generation `n≥2` 时恰有 `n−1` 条 `detail.retiredPins[]`，并强调两个方向都查；D15-c 宣称协议已把“代次与记录”钉住，但 D15 SQL 从未读取 `project_action.detail`，D11 又允许任何时刻改 detail。
- **最小序列**：正常 create generation=0；首次 claim 写 model-v1/generation=1；retiredPin 写 model-v2/generation=2；不写 action detail。
- **真实 PostgreSQL 16.14**：两次 UPDATE 都提交；观察为 `{execution_pin_generation:'2', retired_count:'0'}`。
- **权威状态/动作/键**：generation 声称发生一次替换，审计 ledger 声称零次；没有幂等身份能判定哪一侧权威。
- **责任人与恢复**：Session/PAC 契约研发。把 Session generation 与 action detail 的追加放在同一封闭数据库 mutator 中，验证旧值/新值/时间与数组长度；禁止独立 detail rewrite，加入两个方向与并发 mutation 测试。

## 7. 命令与关键输出

无数据库基线（七组研发测试）：

```text
$ tsc --strict --target ES2017 --module commonjs --moduleResolution node \
  --types node,pg --typeRoots /root/orbit/node_modules/@types \
  --baseUrl /root/orbit/node_modules --rootDir src/apiserver/src \
  --outDir src/apiserver/build <7 coordinator specs>
# exit 0

$ env -u TEST_DATABASE_URL -u DATABASE_URL NODE_PATH=/root/orbit/node_modules \
  node --test <7 compiled coordinator specs>
# tests 172; pass 144; fail 0; skipped 28; duration_ms 864.768865
```

01G 在本轮隔离 PostgreSQL 上的完整回归：

```text
$ COORDINATOR_PG_URL=<本轮隔离库> COORDINATOR_PG_EXPECTED_*=... \
  NODE_PATH=/root/orbit/node_modules node --test --test-concurrency=1 <7 specs>
# tests 172; pass 172; fail 0; skipped 0; duration_ms 19117.643553
```

独立 v1.7 反例：

```text
$ tsc --strict --target ES2022 --module commonjs ... coordinator-v17-adversarial.spec.ts
# exit 0

$ env -u COORDINATOR_PG_URL -u COORDINATOR_PG_EXPECTED_* \
  NODE_PATH=/root/orbit/node_modules node --test coordinator-v17-adversarial.spec.js
# tests 9; pass 5; fail 0; skipped 4; duration_ms 199.937406

$ env -u COORDINATOR_PG_URL -u COORDINATOR_PG_EXPECTED_* \
  NODE_PATH=/root/orbit/node_modules node --test <8 specs, including v1.7 review>
# tests 181; pass 149; fail 0; skipped 32; duration_ms 884.541453

$ COORDINATOR_PG_URL=<本轮隔离库> COORDINATOR_PG_EXPECTED_*=... \
  NODE_PATH=/root/orbit/node_modules node --test coordinator-v17-adversarial.spec.js
# identity printed
# tests 9; pass 9; fail 0; skipped 0; duration_ms 1291.229279

# asserted committed observations
PC-CX-43: status=APPLIED, execution_result_digest=forged-after-session-insert
PC-CX-44: session_permission=danger-full-access, frozen_permission=read-only, resolution_equal=false
PC-CX-45: live_rows=2, task_claims=1, orphaned_actions=1
PC-CX-46: execution_pin_generation=2, retired_count=0
```

编写静态 PAC 表匹配时曾有一次 TypeScript parse error（模板字符串内的反引号转义），只修改独立测试夹具后重编译；未修改研发代码或权威契约，不计作产品失败。最终有效运行如上。

## 8. 运行环境、提交与合并

```text
Linux vmi3129740 6.12.38+deb13-cloud-amd64 x86_64
Node v22.22.2
git 2.47.3
Docker Engine 29.5.2
PostgreSQL 16.14 (postgres:16-alpine)
Timezone: Europe/Berlin
```

被验提交：`574a2c9778babc6dee201f4f454da73df1ac683c`。验证提交 SHA 与 `feat/project` 合并状态记录在任务 02 的持久评论中（提交不能在自身内容中记录自己的 SHA）。

## 9. 遗留与放行条件

1. 修复并反向关闭 `PC-CX-43..46`，不得删除或弱化独立反例；修复后将本文件翻转为 closed assertions。
2. D11 的测试必须覆盖 **CLAIMED→APPLIED 发布 UPDATE** 的逐列 mutation；仅测试 OLD 已 APPLIED 不足。
3. 从 PAC §6/§7.5 生成 create-frozen/claim-frozen coverage，至少覆盖 permission、resolution、snapshot timestamp 与两个摘要。
4. 对 D5 partial unique index 的所有谓词列做 UPDATE mutation，验证已有 live Session 不能移出索引覆盖集合后继续执行。
5. generation 与 action detail ledger 必须同事务、同数据库门、双向可查询；并发 retiredPin/claim 也要故障注入。

在以上 P0/P1 关闭前，本任务保持 `IN_PROGRESS`，不置 `DONE`。
