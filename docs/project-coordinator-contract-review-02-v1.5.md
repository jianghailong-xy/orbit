# Project Coordinator 契约 v1.5 独立复审（任务 02，第六轮）

## 1. 结论

**FAIL / BLOCKED：v1.5 仍不能作为“无未解决 P0/P1 歧义”的冻结契约。**

本轮先读取任务 02 的完整信息与五轮历史评论，再读取 Project 的 goal、12 条 acceptance criteria、instructions、p01 与 01E 的完整任务/评论；从 `feat/project` 的研发提交 `00fa50b245b7fdae61d1a335f18f36e08386737e` 独立开始。没有修改 `docs/project-coordinator-contract.md`、研发反例或研发测试来消除失败。

01E 对 `PC-CX-28..31` 的正向用例在其声明的模型范围内通过；反例外扩发现 **1 个 P0 + 4 个 P1**：

| ID | 严重度 | 结论 |
|---|---:|---|
| `PC-CX-32` | **P0** | D14-a 同时要求 `resolve_execution_context_locked` 为 `STABLE` 且执行 `SELECT … FOR SHARE`；PostgreSQL 16.14 直接以 `0A000` 拒绝。研发 PG fixture 没写 `STABLE`，实际跑的是默认 `VOLATILE`，因此全绿是假阴性 |
| `PC-CX-33` | **P1** | `decisionInput.world` 仍漏 PAC 解析实际读取的 Agent 默认 Provider/Model/effort/fallback/requiredCapabilities、`projectMemberId`、`workspace.enabled` 等；同一 hash 可以要求不同 provider/model/runner/digest 或 DISPATCH/REFUSE |
| `PC-CX-34` | **P1** | I17 一面声明“任何已提交占位”当前不得指向 disabled Agent，一面又允许 coordinator-first 后人工撤权生效且在飞 Session 不动；真实 PG 得到 `enabled=false, live=1, i17_current_violations=1` |
| `PC-CX-35` | **P1** | 限频窗结束前不足 5 秒时，TR2/I18 要求 `nextWakeAt ≤ windowEndsAt`，W3 又要求 `nextWakeAt ≥ now+5s`，不存在合法值；TR2-e 的精确 wake reason 也与 §10.4“所有 wake 取最小值”冲突 |
| `PC-CX-36` | **P1** | I18 声称覆盖“任何已提交状态”，但 `user.manual_trigger` 事件提交到异步 reconcile 之间必然存在 `consumed=NULL,nextAttempt=NULL`；事件生产者没有原子写 runtime wake 的义务，故不变量在正常主路径上短暂但确定地为假 |

任务 02 的完成门槛没有满足；03 必须继续由原生依赖阻止，Coordinator 应创建后续契约缺陷任务或原生退回 p01。

## 2. 被验基线、研发差异与独立性

```text
$ git rev-parse feat/project
00fa50b245b7fdae61d1a335f18f36e08386737e

$ git log --oneline -3 feat/project
00fa50b2 docs(project): close the four coordinator contract blockers PC-CX-28..31
a0d503d7 test(project): record coordinator contract v1.4 re-review
8164f10c docs(project): close the seven coordinator contract blockers PC-CX-21..27

$ git show --stat 00fa50b2
docs/project-coordinator-contract.md              | 365 +-
coordinator-contract.spec.ts                      | 133 +-
coordinator-counterexample.spec.ts                | 752 +-
coordinator-linearization.pg.spec.ts              | 473 +
coordinator-v14-adversarial.spec.ts                | 214 +-
5 files changed, 1844 insertions(+), 93 deletions(-)
```

本轮新增的唯一测试文件是 `coordinator-v15-adversarial.spec.ts`，它保留缺陷形状并在独立数据库中验证 PostgreSQL 行为。权威契约、01E 的研发测试、前五轮审查报告均未改。

## 3. PostgreSQL 强制隔离证据

### 3.1 唯一对象与创建前核验

- network：`pcc02-v15r-net-349bqgko-20260819b`
- container：`pcc02-v15r-pg-349bqgko-20260819b`
- database：`pcc02_v15r_349bqgko_20260819b`
- role：`pcc02_v15r_349bqgko`

```text
$ docker inspect pcc02-v15r-pg-349bqgko-20260819b
error: no such object: pcc02-v15r-pg-349bqgko-20260819b

$ docker network inspect pcc02-v15r-net-349bqgko-20260819b
Error response from daemon: network ... not found

$ docker network create pcc02-v15r-net-349bqgko-20260819b
877cae68b64bb6833d80d85829c192d59cf2ed3f24b9f8ced43ea322c196ecd5

$ docker run -d --name pcc02-v15r-pg-349bqgko-20260819b ... postgres:16-alpine
6119548d4f7d3646ef3c1317cea9fdadd2e287046135daf2d51eb3d9bbfc91c5
```

### 3.2 任何 fixture 写入前的身份核验

```text
container_id=6119548d4f7d3646ef3c1317cea9fdadd2e287046135daf2d51eb3d9bbfc91c5
name=/pcc02-v15r-pg-349bqgko-20260819b image=postgres:16-alpine
network_mode=pcc02-v15r-net-349bqgko-20260819b ip=172.23.0.2
host=127.0.0.1:32771
network_id=877cae68b64bb6833d80d85829c192d59cf2ed3f24b9f8ced43ea322c196ecd5

current_database=pcc02_v15r_349bqgko_20260819b
current_user=pcc02_v15r_349bqgko
system_identifier=7675712573233696802
server_version=16.14
```

测试进程每次首次连接、任何 `DROP/CREATE/INSERT/UPDATE` 之前又经过 `coordinator-pg-test-safety.ts`，关键输出：

```text
# coordinator-pg-isolation database=pcc02_v15r_349bqgko_20260819b
# user=pcc02_v15r_349bqgko server=172.23.0.2/32:5432
# system_identifier=7675712573233696802 version=16.14
```

全程未连接、未 `docker exec`、未传入、未读取共享 `orbit-postgres`、`orbit` 数据库、其 IP、凭据或元数据。所有 DDL/DML 只发生在上述专用数据库的 `pcc_*` schema。清理时只删除上述本轮容器和网络，删除后精确名称检查必须为 not found。

### 3.3 测试后身份复核与清理

```text
$ docker exec pcc02-v15r-pg-349bqgko-20260819b psql ... '<identity query>'
pcc02_v15r_349bqgko_20260819b|pcc02_v15r_349bqgko|||7675712573233696802|16.14

$ docker rm -f pcc02-v15r-pg-349bqgko-20260819b
pcc02-v15r-pg-349bqgko-20260819b

$ docker network rm pcc02-v15r-net-349bqgko-20260819b
pcc02-v15r-net-349bqgko-20260819b

$ docker inspect pcc02-v15r-pg-349bqgko-20260819b
error: no such object: pcc02-v15r-pg-349bqgko-20260819b

$ docker network inspect pcc02-v15r-net-349bqgko-20260819b
Error response from daemon: network ... not found
```

## 4. 指定故障矩阵

| 场景 | 预期权威状态 | 确定动作 / 幂等身份 | 责任人与恢复 | 本轮判定 |
|---|---|---|---|---|
| 重复事件 | 世界事实不变，仅次数/时间可变 | 同一 dedupe/action key，副作用一次 | 无；无需恢复 | PASS：I14/F01 |
| 乱序事件 | 重读当前世界，最终状态与顺序无关 | E1，同事实同键 | 无；backstop 兜底 | PASS：F02 |
| 事务回滚 | 业务行与 outbox 同时不存在 | 不产生动作键 | 原调用者重试 | PASS：N4/F04 |
| 双 worker / 接管 | 只有新 fencing token 可提交 | 同输入同键；旧 token 整事务回滚 | SYSTEM；租约到期接管 | PASS：既有模型/PG |
| Coordinator Session 结束 | Agent 不变，generation 单调 +1 | `coord-session:<generation>` | SYSTEM 自动轮换；落点坏则 USER | PASS：§7.5/F08/F09 |
| Runner 离线 | 当前 Session 失败/退避，后续有 blocker | dispatchAttempt/condition generation | SYSTEM/EVENT | **FAIL：`PC-CX-33` 漏 Agent capability 与 workspace enabled 输入** |
| Provider 不可用 | `PROVIDER_UNAVAILABLE`，只许显式 fallback | fallback 后新 execution digest | SYSTEM/EVENT | **FAIL：`PC-CX-33` 漏 Agent 默认/fallback 配置** |
| 无匹配 Runner | `NO_MATCHING_RUNNER` / `RUNTIME_REQUIREMENT_UNMET` | typed REFUSE / blocker generation | SYSTEM/EVENT 或 USER/HUMAN | **FAIL：`PC-CX-33` 同 hash 可分叉** |
| 合并冲突 | `MERGE_CONFLICT`，无进展后转 USER | lifecycle/condition 代次 | COORDINATOR→USER | PASS：TF4/TR3 |
| 测试/验证失败 | 退避、原生退回、缺陷或下游阻断 | dispatchAttempt/verdictRevision | SYSTEM/TIME 或 COORDINATOR | PASS：Q3/V7 |
| 预算耗尽 | TIME blocker 或 cap drain NOOP | blocker lifecycle / wake | SYSTEM/TIME | PASS：CAP0/CAP4/F34 |
| 等待用户 | AWAITING_HUMAN，五字段齐全 | blocker lifecycle / approval key | USER/HUMAN | **FAIL：manual request 的 I18/W3 时间代数见 `PC-CX-35/36`** |
| 混合版本部署 | 数据库门 fail closed 且产生结构化恢复 | D5/D6/D9/D14 | SYSTEM；有界重试 | **FAIL：`PC-CX-32` 使规范 D14 每次调用都 0A000** |
| 人工同时操作 | 两提交顺序均唯一；后写是否影响在飞需唯一规范 | project/EC lock + action epoch | USER/SYSTEM | **FAIL：I17 当前态与点态冲突，`PC-CX-34`** |

补充反例：限频窗口最后 2 秒、manual trigger 刚提交尚未 reconcile、Agent 默认 Provider 两种值但声明输入相同，均已落入独立 spec。

## 5. 项目 12 条 acceptance criteria 映射

| AC | v1.5 复审 | 证据 / 阻断 |
|---:|---|---|
| 1 | PASS | 稳定 Agent、Session generation、Base62 条款未发现新歧义 |
| 2 | **BLOCKED** | 一般 outbox/重复/乱序通过；`PC-CX-36` 使 manual 事件正常提交态违反 I18 |
| 3 | **BLOCKED** | `PC-CX-32` 可使所有受 D14 的派发失败；`PC-CX-35/36` 无一致 wake |
| 4 | **BLOCKED** | 限频边界无法同时满足 W3 与 I18；没有确定的策略动作 |
| 5 | **BLOCKED** | `PC-CX-33`：声明输入/hash 不含实际 PAC resolver 读集 |
| 6 | PASS | verification verdict 的原生退回/缺陷/阻断仍唯一 |
| 7 | PASS | 聚合 current-state CAS 与复发代次未发现新反例 |
| 8 | **BLOCKED** | Provider/Runner/Workspace 解析可在同 hash 下产生不同 blocker/动作 |
| 9 | **BLOCKED** | `PC-CX-32` 破坏恢复/混合版本；`PC-CX-34` 撤权后权威状态不唯一 |
| 10 | **BLOCKED** | S3 可回放性、I17 查询、TR2 wake 展示互相冲突 |
| 11 | **BLOCKED** | 迁移要求创建的 D14 按规范无法运行；滚动部署不具备声明的恢复结果 |
| 12 | PASS（契约层） | acceptanceDigest/DONE/merge evidence 本轮未发现新反例；实现仍归后续任务 |

## 6. 结构化失败证据

### `PC-CX-32` — P0 — D14 的 PostgreSQL 对象不可执行

- **契约证据**：D14-a 明确要求 resolver 为 `STABLE`，同段又要求它的每个读为 `FOR SHARE`。
- **真实输出**：PostgreSQL 16.14 执行该组合返回 `ERROR: SELECT FOR SHARE is not allowed in a non-volatile function`，SQLSTATE `0A000`。
- **为何研发套件没抓到**：`EC_SCHEMA_V15` 的 `resolve_execution_context_locked` 没有写 `STABLE`，PostgreSQL 默认它为 `VOLATILE`；它测试的是另一种对象。
- **持久化后果**：D14 在 deferred trigger 的提交阶段调用 resolver，事务整体 abort；action/session/decision/event consumption/wake 均不能按 outcome 提交。旧事件会反复重试，且错误不属于契约已有 structured refusal。
- **责任人/恢复**：契约研发。明确选择 `VOLATILE` 锁函数，或拆分锁 acquisition 与稳定计算；迁移测试必须断言 `pg_proc.provolatile` 并调用真实 trigger，而不只 grep `FOR SHARE`。

### `PC-CX-33` — P1 — PAC 解析读集仍未进入 decisionInput

- **最小反例 A**：声明 `world` 完全相同，Task 没有 provider/model pin；隐藏的 `agent.defaultProvider/defaultModel` 分别为 Claude/Codex。PAC §7.2 要求两个不同 provider/model 与 execution digest，但 `decisionInputHash` 相同。
- **最小反例 B**：声明输入相同，仅 `workspace.enabled` 为 true/false；PAC §7.3 分别要求 DISPATCH/REFUSE，`world.workspaces[]` 没有该字段。
- **静态缺口**：`world.team[]` 无 defaultProvider/defaultModel/defaultEffort/providerFallbacks/Agent requiredCapabilities/projectMemberId；`world.workspaces[]` 无 enabled；`providers[]` 无 model 可用空间。S8 的“五处采集”测试仍只检查手选字段存在，没有从 PAC 解析函数签名/读集反推。
- **责任人/恢复**：契约研发 + PAC 集成。冻结完整 resolver input projection（或把已解析 context 作为输入的一部分），让 hash 双向覆盖 PAC 实际读集；对每个字段做删除 mutation。

### `PC-CX-34` — P1 — I17 把点态与当前态写成等价

- **最小交错**：Agent enabled；控制环 EC3 取共享锁并提交 live Session；人工随后排队，提交 `enabled=false`。
- **契约两种答案**：AU1-a/F35 说第二步合法且在飞 Session 不动；I17/G5 的“等价可查询形式”说任何已提交状态不得有 live Session 指向 disabled Agent。
- **真实 PG**：用可延迟、VOLATILE、`FOR SHARE` 的提交门先合法插 Session，再禁用 Agent，得到 `false|1|1`（enabled | live count | I17 current violations）。01E 自己的 PG 测试已得到前两列，但没执行第三列查询。
- **责任人/恢复**：契约研发。若授权只在 Session 提交点判，删除 I17 的当前态等价式并把审计写成历史点态；若当前态必须恒真，则每个 EC1 mutator 都要与 live Session 定义线性化拒绝/终止/快照豁免。

### `PC-CX-35` — P1 — TR2 的时间约束在窗口末端无解

- **最小值**：anchor `t0=0`，window end `60s`，请求在 `58s` 被限频。
- **冲突**：TR2-b 令 `nextAttemptAt=60s`；TR2-d/I18 要 `nextWakeAt≤60s`；W3 要 `nextWakeAt≥63s`。不存在合法 timestamp。
- **第二反例**：若另一个 Task 的 `runAt=59s`，§10.4 要取 59s，但 TR2-e 又要求 runtime wake 精确指向 60s 且 reason 为 manual rate-limit。
- **责任人/恢复**：契约研发。定义 deadline 与 poll floor 的优先级：例如把 nextAttempt 一并推到 `max(boundary,now+5s)`，或为有限余量冻结 W3 例外；`nextWakeReason` 应支持确定优先级/多原因，不能覆盖其它更早 wake。

### `PC-CX-36` — P1 — I18 忽略事件提交到 reconcile 的正常间隙

- **最小状态**：用户接口提交 `project_event(kind=user.manual_trigger, consumed_at=NULL, next_attempt_at=NULL)`；消费者尚未 reconcile；runtime 仍可为 `next_wake_at=NULL`。
- **冲突**：I18 声称“任何已提交状态”只有 consumed 或 pending+wake 两种；上述状态是正常异步主路径，却不属于任一支。TR2 只处理“已被限频”的请求，第一条请求甚至不适用其窗口规则。
- **责任人/恢复**：契约研发/事件基础设施。要么 event producer 在同一事务初始化 `next_attempt_at` 并把 runtime wake 前移，要么把 I18 的时态改成“reconcile 成功提交后”，并单独为待消费事件定义可靠投递不变量。

## 7. 命令与关键输出

聚焦编译：

```text
$ /root/orbit/node_modules/.bin/tsc --strict --target ES2022 --module commonjs \
    --moduleResolution node --esModuleInterop --skipLibCheck \
    --types node --typeRoots /root/orbit/node_modules/@types \
    --baseUrl /root/orbit/node_modules --rootDir src/apiserver/src \
    --outDir src/apiserver/build <6 coordinator specs>
# exit 0
```

无数据库全矩阵：

```text
$ env -u COORDINATOR_PG_URL -u COORDINATOR_PG_EXPECTED_* node --test <6 compiled specs>
# tests 128; pass 110; fail 0; skipped 18; duration_ms 411.440117
```

研发隔离 PG 套件（安全闩逐进程打印相同 identity）：

```text
$ node --test coordinator-linearization.pg.spec.js
# tests 13; pass 13; fail 0; duration_ms 12598.266474

$ node --test coordinator-v13-adversarial.spec.js
# tests 9; pass 9; fail 0; duration_ms 445.395457

$ node --test coordinator-v14-adversarial.spec.js
# tests 6; pass 6; fail 0; duration_ms 1077.902958
```

独立 v1.5 反例：

```text
$ node --test coordinator-v15-adversarial.spec.js       # 无 DB
# tests 7; pass 5; fail 0; skipped 2; duration_ms 117.327098

$ COORDINATOR_PG_URL=<isolated> COORDINATOR_PG_EXPECTED_*=... \
    node --test coordinator-v15-adversarial.spec.js
# identity printed; tests 7; pass 7; fail 0; skipped 0; duration_ms 822.766617

$ psql ... -c 'CREATE FUNCTION ... STABLE ... FOR SHARE; SELECT ...'
ERROR: SELECT FOR SHARE is not allowed in a non-volatile function
CONTEXT: SQL statement "SELECT enabled FROM authority WHERE id='a1' FOR SHARE"

$ psql ... -c '<I17 current-state query>'
false|1|1
```

这些“反例测试通过”表示缺陷被稳定复现，不表示契约通过。

## 8. 运行环境、提交与合并

```text
Linux 6.12.38+deb13-cloud-amd64 x86_64 GNU/Linux
Node v22.22.2; npm 10.9.7; TypeScript 5.9.3
git 2.47.3; Docker 29.5.2
PostgreSQL 16.14 (postgres:16-alpine disposable container; removed)
review worktree: /root/.orbit/worktrees/01a01971-bb7b-7593-91ed-3d6648a3dc9d
review branch: orbit/02-coordinator-32ba2b
```

- 被验提交：`00fa50b245b7fdae61d1a335f18f36e08386737e`
- 验证提交：见任务最终评论（提交本报告与独立 spec 后生成）
- 合并状态：见任务最终评论；要求验证提交可从 `feat/project` 到达
- 目标工作树既有 staged 改动：`M README.md` / `D docs/project-agent-contract.md`；合并前 README staged blob 为 `8da88cf699312bc74ed66da8f93d066ac53dc408`，工作区 sha256 为 `ee2a1ccfb444220fa85b1438b6c830ce1f5428286407c0b85b974ef2c11206bc`，合并后必须逐项相同

## 9. 后续自动化清单

1. 迁移中创建**真实** D14 对象，断言 `pg_proc.provolatile` 与锁 SQL 可同时运行；从 trigger 提交路径验证 structured refusal。
2. 从 PAC WHO/WITH/WHERE resolver 的实际读集生成 `decisionInput` 字段清单，删除任意字段的 mutation 必须红。
3. EC1 八个 mutator 各跑 coordinator-first 后的当前态查询，明确“历史点态”或“当前恒真”只能选一个。
4. TR2 参数化 `remaining ∈ {0,1,2,4,5,6,59}s`，断言 W3/I18/nextAttempt/nextWake 同时可满足。
5. TR2 与其它 wake（blocker、runAt、backoff、live Session）两两组合，冻结时间和 reason 的确定优先级。
6. manual trigger 生产事务提交后、consumer 前、consumer 崩溃后、窗口限频后、turn 回答后五个状态逐一断言。
7. 保持身份安全闩：缺 expected database/user/system identifier 时必须在任何 fixture DDL/DML 前失败。
