# Project Coordinator 契约 v1.6 独立复审（任务 02，第七轮）

## 1. 结论

**FAIL / BLOCKED：v1.6 仍不能作为“无未解决 P0/P1 歧义”的冻结契约。**

本轮先读取任务 02 的完整信息和六轮历史评论，再读取 Project 的 goal、12 条 acceptance criteria、instructions、p01 与 01F 的完整任务/评论。工作树在任何编辑和测试前从上一轮审查提交 `d63e679eab353d9a272f94dd57d6add757eb4d3e` 安全 fast-forward 到当时最新 `feat/project`：`f3e8de4bf328314440c33146331eeb5e1ebdfd21`（01F / v1.6）。用户给出的 v1.5 基线 `00fa50b245b7fdae61d1a335f18f36e08386737e` 经验证是当前 HEAD 的祖先；没有回退或跳过 01F。

没有修改 `docs/project-coordinator-contract.md`、PAC 或研发测试来掩盖失败。本轮只新增本报告和独立反例测试。01F 对 `PC-CX-32..36` 的修复用例全部通过；反例外扩仍发现 **1 个 P0 + 5 个 P1**：

| ID | 严重度 | 结论 |
|---|---:|---|
| `PC-CX-37` | **P0** | D11 的 SQL 只冻结旧归属列，却遗漏后来加入的 `execution_context`、`execution_context_digest`、`reason_code`；真实 PostgreSQL 可改写已 `APPLIED` 动作并提交出违反 I17-A 的状态，也可移动 TR2 的窗口锚点 |
| `PC-CX-38` | **P1** | I17-A 宣称 Session 快照与动作上下文恒等且 create 后只读，但 PAC 明确把 `model` 延迟到首次 claim，并允许 `retiredPin` 再改一次；正常生命周期即可使该恒成立命题为假 |
| `PC-CX-39` | **P1** | W5 只按 `(at, source)` 排序；同一 source 可产生多条候选，同一时刻的两个 blocker/task 没有第三个 tie-break，`nextWakeReason` 取决于枚举顺序 |
| `PC-CX-40` | **P1** | S5 说 `evaluation.epoch` 是唯一决策时钟，S3 说同 hash 必须给出同一 `nextWakeAt`，W5 却使用未进 hash 的墙钟 `now + 5s`；同一输入可产生两个 wake 值 |
| `PC-CX-41` | **P1** | I19 量化任何未消费事件，但 §10.3/W4 都排除 coordinator-disabled 或 SETTLED Project；I6 又要求旧项目不消费事件，N1 仍可为它们产生事件，因而存在无人负责且 backstop 看不见的已提交状态 |
| `PC-CX-42` | **P1** | EC2 摘要只覆盖九个身份，不覆盖 PAC 会冻结进 Session 的 `effort`、`requiredCapabilities` 等结果字段；决策后这些输入改变但九个身份不变时，提交门接受与冻结决策不同的 Session 结果 |

任务 02 的完成门槛没有满足。Coordinator 应原生退回 p01 或创建后续契约缺陷任务；依赖于权威契约冻结的实现单元不能据此宣称无 P0/P1 歧义。

## 2. 被验基线与独立性

```text
$ git rev-parse HEAD                         # fast-forward 前
d63e679eab353d9a272f94dd57d6add757eb4d3e

$ git rev-parse feat/project                # 当时最新
f3e8de4bf328314440c33146331eeb5e1ebdfd21

$ git merge --ff-only feat/project
Updating d63e679e..f3e8de4b
Fast-forward
5 files changed, 1806 insertions(+), 150 deletions(-)

$ git rev-parse HEAD
f3e8de4bf328314440c33146331eeb5e1ebdfd21

$ git merge-base --is-ancestor 00fa50b245b7fdae61d1a335f18f36e08386737e HEAD
# exit 0

$ git merge-base --is-ancestor f3e8de4bf328314440c33146331eeb5e1ebdfd21 HEAD
# exit 0
```

01F 研发提交：

```text
f3e8de4b docs(project): close the five coordinator contract blockers PC-CX-32..36
 docs/project-coordinator-contract.md              | 281 +-
 coordinator-contract.spec.ts                      | 123 +-
 coordinator-counterexample.spec.ts                | 808 +-
 coordinator-linearization.pg.spec.ts              | 466 +-
 coordinator-v15-adversarial.spec.ts                | 278 +-
```

本轮新增的 `coordinator-v16-adversarial.spec.ts` 是反例见证：断言通过表示缺陷可复现，不表示权威契约通过。它读取但不改写权威文档；PostgreSQL 部分先通过 `coordinator-pg-test-safety.ts` 的 URL 与数据库身份双重闩。

## 3. PostgreSQL 强制隔离证据

### 3.1 本轮唯一资源与写入前核验

- network：`pcc02-v16r-net-349bqgko-20260819c`
- container：`pcc02-v16r-pg-349bqgko-20260819c`
- database：`pcc02_v16r_349bqgko_20260819c`
- role：`pcc02_v16r_349bqgko`
- image：`postgres:16-alpine`
- host endpoint：`127.0.0.1:32773`
- isolated IP：`172.23.0.2`

创建前精确名称核验：container 与 network 的 `inspect` 均 exit 1 / not found。创建结果：

```text
network_id=a083a077452245f9167849652bb81712ef8d463ca7a24c9a06e50d9293c95ce8
container_id=f2cb0cf7030282fa8ff6f23990bde8b96d2734893b28d4b25c240c9416650811
```

任何 DDL/DML 前先通过独立客户端执行只读身份探针：

```text
current_database=pcc02_v16r_349bqgko_20260819c
current_user=pcc02_v16r_349bqgko
server=172.23.0.2/32:5432
system_identifier=7675727645339897890
server_version=16.14
```

每个测试进程连接后、任何 `DROP/CREATE/INSERT/UPDATE` 前再次调用 `verifyCoordinatorPgIdentity`，输出：

```text
# coordinator-pg-isolation database=pcc02_v16r_349bqgko_20260819c
# user=pcc02_v16r_349bqgko server=172.23.0.2/32:5432
# system_identifier=7675727645339897890 version=16.14
```

全程未连接、未 `docker exec`、未传入或访问共享 `orbit-postgres`、`orbit` 数据库、其 IP 或凭据。所有破坏性 SQL 只作用于专用数据库内测试 schema `pcc_*`。

### 3.2 最后身份核验与精确清理

```text
database=pcc02_v16r_349bqgko_20260819c
db_user=pcc02_v16r_349bqgko
server_addr=172.23.0.2/32
server_port=5432
server_version=16.14
system_identifier=7675727645339897890

$ docker stop pcc02-v16r-pg-349bqgko-20260819c
pcc02-v16r-pg-349bqgko-20260819c
$ docker rm pcc02-v16r-pg-349bqgko-20260819c
pcc02-v16r-pg-349bqgko-20260819c
$ docker network rm pcc02-v16r-net-349bqgko-20260819c
pcc02-v16r-net-349bqgko-20260819c

$ docker inspect pcc02-v16r-pg-349bqgko-20260819c
# exit 1: no such object
$ docker network inspect pcc02-v16r-net-349bqgko-20260819c
# exit 1: network not found
```

只删除了上述本轮容器和网络。

## 4. 反例驱动故障矩阵

| 场景 | 唯一权威状态 | 确定动作 / 幂等键 | 责任人与恢复 | 判定 |
|---|---|---|---|---|
| 重复事件 | 重读当前世界，除 `occurrences/lastSeenAt` 外结果相同 | event partial unique key；动作永久键不变 | SYSTEM；无需人工 | PASS：I14、E1、DA2 |
| 乱序事件 | 事件只是 signal，当前世界决定状态 | 同事实同 `decisionInputHash`/动作键 | SYSTEM；backstop 兜底 | **BLOCKED：`PC-CX-40` 使同 hash 的 wake 不同** |
| 事务回滚 | 业务写与 outbox 同时存在或同时不存在 | 回滚不产生事件/动作键 | 原调用者重试 | PASS：N4；PG 回滚套件通过 |
| 双 worker 竞争/接管 | 只有当前 fencing token 的提交可见 | 同快照同 key；旧 token 整事务回滚 | SYSTEM；租约过期接管 | PASS：17 个 PG 线性化用例覆盖 |
| Coordinator Session 结束 | Agent 身份不变，generation 单调前进 | `coord-session:<generation>` / rotate key | SYSTEM 自动轮换；落点问题映射 blocker | PASS：既有 F08/F09 |
| Runner 离线 | 在飞 Session 固定原 runner；后续 typed blocker | dispatchAttempt / blocker lifecycle generation | SYSTEM/EVENT 或 USER/HUMAN | **BLOCKED：`PC-CX-42` 可让能力结果在提交门外漂移** |
| Provider 不可用 | 明确 `PROVIDER_UNAVAILABLE`；不静默改派 | execution digest + blocker generation | SYSTEM/EVENT | PASS（身份变化）；非身份解析结果仍受 `PC-CX-42` 阻断 |
| 无匹配 Runner | `NO_MATCHING_RUNNER`/`RUNTIME_REQUIREMENT_UNMET` 唯一 | REFUSE + blocker generation | SYSTEM/EVENT 或 USER/HUMAN | **BLOCKED：能力集合未受 EC2 保护，`PC-CX-42`** |
| 合并冲突 | `MERGE_CONFLICT` open blocker；无进展后升级 | condition/lifecycle generation | COORDINATOR → USER | PASS：TF4/TR3 |
| 测试/验证失败 | verdictRevision 决定退回/缺陷/阻断 | verdictRevision 永不复用 | COORDINATOR；修复后再验证 | PASS：Q3/V7 |
| 预算耗尽 | TIME blocker 或 over-cap drain；不杀在飞 | blocker lifecycle / wake candidate | SYSTEM/TIME | **BLOCKED：同 source 同时刻多个 blocker reason 不唯一，`PC-CX-39`；wake 时钟受 `PC-CX-40`** |
| 等待用户 | `AWAITING_HUMAN`，blocker 五字段齐全 | lifecycle generation / approval key | USER/HUMAN；升级时钟 | **BLOCKED：多个同刻候选 reason 不唯一，`PC-CX-39`** |
| 混合版本部署 | 数据库约束必须挡住旧 writer | D5/D6/D9/D11/D14 | SYSTEM；结构化拒绝/有界重试 | **FAIL：D11 可被任何版本改写新列，`PC-CX-37`** |
| 人工同时操作 | 两种提交顺序应各有唯一合法结果 | 共享锁 + action epoch | USER/SYSTEM | **FAIL：正常首次 claim/retiredPin 破坏 I17-A（`PC-CX-38`）；未摘要 Session 字段可漂移（`PC-CX-42`）** |

补充验收事实场景：Project `DONE/CANCELLED → SETTLED` 后仍可能在业务事务产生 `session.ended`/`task.updated` 事件；该事件既不被 SETTLED 项目消费，也不进 W4，见 `PC-CX-41`。

## 5. Project 12 条 acceptance criteria 判定

| AC | v1.6 复审 | 证据 / 阻断 |
|---:|---|---|
| 1 | PASS | 稳定 Coordinator Agent、generation、Base62 条款未发现新反例 |
| 2 | **BLOCKED** | `PC-CX-41`：事件集合覆盖 disabled/SETTLED，但消费/兜底责任域不覆盖 |
| 3 | **BLOCKED** | `PC-CX-39/40/41`：wake reason、wake time、事件责任均不封闭 |
| 4 | PASS（契约矩阵） | 自动化策略分档与人工 gate 本轮未发现新反例 |
| 5 | **BLOCKED** | `PC-CX-40/42`：同输入可产生不同 wake；同 EC2 摘要可产生不同 Session 结果 |
| 6 | PASS | verification verdict 的原生退回/缺陷/下游阻断仍唯一 |
| 7 | PASS | parent aggregation 与复发代次未发现新反例 |
| 8 | **BLOCKED** | `PC-CX-39/42`：blocker reason 非全序，能力/effort 漂移未被提交门覆盖 |
| 9 | **BLOCKED** | `PC-CX-37/38`：I17-A 的数据库反向保护缺失，且 PAC 合法生命周期与其冲突 |
| 10 | **BLOCKED** | `PC-CX-39/40`：同一审计输入不能稳定解释唯一 wake pair |
| 11 | **BLOCKED** | `PC-CX-37/41`：混合版本可改写冻结行，disabled/SETTLED 事件无恢复责任人 |
| 12 | PASS（契约层） | acceptanceDigest/DONE/merge evidence 本轮未发现新反例；实现仍归后续单元 |

## 6. 结构化失败证据

### `PC-CX-37` — P0 — D11 漏冻 v1.5 新列

- **契约冲突**：D11-b 宣称已 `APPLIED` 行“仍然可写的只有 `result_session_id` 与 `detail`”；实际函数只比较 `status/type/subject_type/subject_id/project_id/fencing_token/idempotency_key`，没有比较 `execution_context`、`execution_context_digest`、`reason_code`。I17-A 与 EC2 明确依赖 D11 让前两列不可改写；TR2 窗口身份依赖 `reason_code` 所在锚点不可改写。
- **最小反例**：插入 `APPLIED DISPATCH_TASK`，Session provider=`claude`，动作冻结 provider=`claude`；随后普通 `UPDATE` 把动作 context/digest 改成 provider=`codex`，同时 `reason_code='REPLAN'`。
- **真实 PostgreSQL 16.14**：更新提交成功；读取结果为 `{reason_code:'REPLAN', provider:'claude', frozen_provider:'codex'}`，I17-A mismatch count=`1`。独立 PG test 8/8 通过。
- **权威状态/确定动作/身份**：当前契约没有唯一权威状态，也没有拒绝动作；动作永久 key 没变但其语义被原地改写，TR2 的 `(generation,reasonCode)` 窗口也可被移动。
- **责任人与恢复**：契约/迁移研发。把 D11 改成闭集 allowlist（对 `OLD.*` 与 `NEW.*` 除两列外全行比较，或至少补齐三列），真实 PG 逐列 mutation；迁移 G5 必须检查这些新增列，而不是复用 v1.4 的六列清单。

### `PC-CX-38` — P1 — I17-A 与 PAC 冻结时刻冲突

- **契约冲突**：I17-A 把 `model` 列入“Session create 后只读、恒等于动作 context”；PAC §6 明确 `model/effort` 首次 claim 才 materialize，且 `model` 在 `retiredPin` 时允许再改一次。
- **最小序列**：动作 context 冻结 model=`model-v1`；create 的 PENDING Session model=`NULL`；首次 claim materialize 为 `model-v1`；runtime 下架后合法改成 `model-v2`。第一和第三个已提交状态都不能同时满足 I17-A。
- **权威状态/动作/身份**：PAC 有确定动作，但 Coordinator 的恒成立查询给出相反判定；没有定义 I17-A 对 pre-claim/retiredPin 的豁免或动作上下文版本键。
- **责任人与恢复**：Coordinator + PAC 契约研发共同选择唯一语义：I17-A 只比较 create-frozen 字段并把 model/effort 改为点态/解析记录，或同步版本化动作快照且定义 `retiredPin` 的身份和审计；加入 PENDING→claim→retiredPin 三阶段测试。

### `PC-CX-39` — P1 — W5 的排序不是全序

- **契约证据**：W5 第 1 条允许表中 1–7 每个 source 产出零到多条候选；第 2 条只按最小 `at`、再按 `source`。
- **最小反例**：两个 open blocker 都来自 source 1，`at=60s`，reason 分别是 provider b1 与 runner b2；候选数组顺序反转后 timestamp 相同，`nextWakeReason` 不同。多个同 `runAt` Task 同理。
- **权威状态/动作/身份**：`nextWakeAt` 唯一但可展示/审计的 reason 非唯一；wake 没有幂等键，候选行也缺稳定第三键。
- **责任人与恢复**：契约研发。冻结 `(at, source, subjectType, subjectId, candidateKind)` 全序，或定义同刻多原因集合的 canonical order；加入每个 source 内 2+ 候选的 permutation test。

### `PC-CX-40` — P1 — W5 使用未冻结的第二时钟

- **契约冲突**：S3 要求相同 `decisionInputHash` 产生逐字相同的机械结果与 `nextWakeAt`；S5 规定 `evaluation.epoch` 是唯一允许读的决策时钟；W5 却写 `max(chosen.at, now + 5s)`。
- **最小反例**：相同 input（candidateAt=60s, epoch=58s）在墙钟 58s/59s 执行，分别得到 63s/64s。输入 hash 不变。
- **权威状态/动作/身份**：相同 decision idempotency input 有两个合法 runtime 值，重放、接管和双 worker 无法得到确定动作。
- **责任人与恢复**：契约研发。W5 使用 `evaluation.epoch + 5s`，或把用于 floor 的时钟值显式纳入 hash；添加同一序列化 input 延迟执行/重放测试。

### `PC-CX-41` — P1 — I19 的量化域超出消费与 backstop 责任域

- **契约冲突**：I19 对“任何已提交状态上的任何未消费 project_event”要求 §10.3 或 W4 负责；两者都要求 Project `OPEN ∧ coordinatorEnabled` 且排除 SETTLED。I6 又要求 disabled 旧项目“不消费事件、不 reconcile”。N1 对 task/session/merge 的业务写只按有 `projectId` 产生事件，没有 enabled/status 过滤。
- **最小状态 A**：`OPEN, coordinatorEnabled=false, PLANNING` 的 legacy Project 上 Task 更新并提交事件。I6 禁止消费，W4/§10.3 均不选中。
- **最小状态 B**：Project 已 DONE/SETTLED，在飞 Session 随后结束并提交 `session.ended`；SETTLED 不再消费事件，W4 排除它。
- **权威状态/动作/身份**：事件 dedupeKey 唯一，但没有 owner、消费动作或清理路径；I19 在正常状态上为假。
- **责任人与恢复**：事件/Coordinator 契约研发。缩小 I19 的量化域并为 excluded event 定义原子消费/删除，或扩大消费者/backstop 的责任域；disabled 与 SETTLED 两格都要做真实 outbox 测试。

### `PC-CX-42` — P1 — EC2 不是完整 Session 结果摘要

- **契约冲突**：PAC 把 `requiredCapabilities` 在 create 冻结、把 `effort` 在首次 claim 冻结；S10-e 也承认 defaultEffort 会改变派发结果，但 EC2 的九个摘要分量明确排除 effort，且未含 capabilities。EC3 只比较 EC2 digest。
- **最小交错**：决策时九个身份不变，effort=`high`、capabilities=`[linux]`；提交前改为 effort=`low`、capabilities=`[linux,docker]`。重解析九身份仍相同，D14 接受；最终 Session 结果与决策 outcome 不同。
- **权威状态/动作/身份**：动作 key 与 EC2 digest 都相同，却有两个合法 Session resolution；现有 `revokedInput` 八值表也无法表达“身份未变但结果改变”。
- **责任人与恢复**：Coordinator + PAC 契约研发。提交门比较完整 canonical PAC resolution（含冻结进 Session 的所有结果字段），或明确把这些字段在决策后变化映射成 typed refusal；由 PAC 输出 schema 生成 digest coverage mutation。

## 7. 命令与关键输出

聚焦编译和无数据库矩阵：

```text
$ tsc --strict --target ES2022 --module commonjs --moduleResolution node \
  --types node,pg --typeRoots /root/orbit/node_modules/@types \
  --baseUrl /root/orbit/node_modules --rootDir src/apiserver/src \
  --outDir src/apiserver/build coordinator-v16-adversarial.spec.ts
# exit 0

$ tsc --target ES2022 --module NodeNext --moduleResolution NodeNext ... <7 coordinator specs>
# exit 0

$ env -u COORDINATOR_PG_URL -u COORDINATOR_PG_EXPECTED_* \
  node --test <7 compiled coordinator specs>
# tests 152; pass 130; fail 0; skipped 22; duration_ms 716.662641
```

隔离 PostgreSQL 下的 01F 研发套件（均使用同一安全 identity 闩、逐进程顺序执行）：

```text
coordinator-linearization.pg.spec.js: tests 17; pass 17; fail 0; duration_ms 19053.700097
coordinator-contract.spec.js:         tests 34; pass 34; fail 0; duration_ms 491.670252
coordinator-counterexample.spec.js:   tests 72; pass 72; fail 0; duration_ms 617.802256
coordinator-v13-adversarial.spec.js:  tests 9;  pass 9;  fail 0; duration_ms 343.118034
coordinator-v14-adversarial.spec.js:  tests 6;  pass 6;  fail 0; duration_ms 625.948527
coordinator-v15-adversarial.spec.js:  tests 6;  pass 6;  fail 0; duration_ms 345.020779
```

独立 v1.6 反例：

```text
$ COORDINATOR_PG_URL=<本轮隔离库> COORDINATOR_PG_EXPECTED_*=... \
  node --test coordinator-v16-adversarial.spec.js
# identity printed
# tests 8; pass 8; fail 0; skipped 0; duration_ms 370.565755

# PC-CX-37 committed observation asserted by the test:
reason_code=REPLAN
session.provider=claude
action.execution_context.provider=codex
I17-A mismatch count=1
```

准备独立 fixture 时曾出现两次测试夹具错误：参数化 query 合并两条 INSERT 导致 PostgreSQL `42601`，以及手工聚焦编译输出路径导致一次模块解析失败；两者均只改独立测试夹具后重跑，未改研发代码/权威文档，也未计作产品缺陷。最终有效运行如上为 8/8。

## 8. 运行环境、提交与合并

```text
Linux vmi3129740 6.12.38+deb13-cloud-amd64 x86_64
Node v22.22.2
git 2.47.3
Docker Engine 29.5.2
PostgreSQL 16.14 (postgres:16-alpine，一次性隔离容器，已删除)
review worktree: /root/.orbit/worktrees/01a01971-bb7b-7593-91ed-3d6648a3dc9d
review branch: orbit/02-coordinator-32ba2b
```

- 被验提交：`f3e8de4bf328314440c33146331eeb5e1ebdfd21`
- v1.5 祖先核验：`00fa50b245b7fdae61d1a335f18f36e08386737e` 是被验提交祖先（exit 0）
- 验证提交：由任务最终评论记录（提交本报告与独立 spec 后生成）
- 合并状态：由任务最终评论记录；要求验证提交可从 `feat/project` 到达

## 9. 后续自动化清单

1. D11 对已 `APPLIED` 行做 schema-driven 逐列 mutation；除明确 allowlist 外任何列变化都必须以 `ACTION_APPLIED_IMMUTABLE` 拒绝。
2. I17-A 跑 create/PENDING、首次 claim、resume、`retiredPin` 四阶段；冻结时刻不同的列不得被同一个恒成立等式覆盖。
3. W5 对 source 1–7 各生成同刻多候选并全排列，断言完整 `(wakeAt,wakeReason,wakeCandidates)` 字节相同。
4. 序列化同一 decisionInput，分别延迟 0/1/4 秒执行 W5，断言输出不读 `evaluation.epoch` 之外的时钟。
5. disabled、CANCELLED、DONE/SETTLED Project 各在业务事务提交 task/session/merge event，断言每行恰有一个 consumer/backstop/原子丢弃责任人。
6. 从 PAC Session resolution schema 生成 EC2/commit-gate 覆盖；删除任意会改变冻结结果的字段时 mutation 必须红。
