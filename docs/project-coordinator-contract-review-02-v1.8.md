# Project Coordinator 契约 v1.8 独立复审（任务 02，第九轮）

## 1. 结论

**FAIL / BLOCKED：v1.8 仍不能作为“无未解决 P0/P1 歧义”的冻结契约。**

本轮先读取任务 02 的完整信息和历史评论，再读取 Project 的 goal、12 条 acceptance criteria、instructions、p01 与 01H 的完整任务/评论。工作树在任何编辑和测试前从上一轮验证提交 `ea25d11d7d64dc92abe8c54f9dbd0a63a97a0e52` 安全 fast-forward 到当时最新 `feat/project`：`0acb16c9b4952eb0c34262439cabf279cdbc6fa2`（01H / v1.8），并核验目标提交是当前 HEAD 的祖先。

没有修改 `docs/project-coordinator-contract.md`、`docs/project-agent-contract.md`、旧独立报告或研发测试来掩盖失败；本轮只新增本报告与独立无数据库反例测试。01H 的修订确实关闭了上一轮 `PC-CX-43..46` 的原始形状，且研发记录的隔离 PostgreSQL 全矩阵为 **195/195**。继续按反例外扩后发现 **3 个 P1**：

| ID | 严重度 | 结论 |
|---|---:|---|
| `PC-CX-47` | **P1** | I17-A2/EC2-b 要求首次 claim 的实际 `model/effort` 等于冻结具体值，或在 deferred 情况记录实际解析；D15/D16 只验证 generation、账本是否存在和数组长度。`model-v1/high` 的冻结动作可提交 `model-evil/low`，只需 `claimResolution={}` |
| `PC-CX-48` | **P1** | I17-A 明称两个 digest 必须等于对 `execution_context` 的重算，且由 D15+D16 对任何二进制构造成立；§26.5 同时承认 forged `execution_result_digest` 可以提交、只由审计查询发现。D11 只冻结错误值，没有数据库对象验证它 |
| `PC-CX-49` | **P1** | I17-A2 要求每条 `retiredPins[]` 含旧值、新值和时刻，claimResolution 也应记录实际 claim 解析；D16 只查非空与数组长度，generation=2、`claimResolution={}`、`retiredPins=[{}]` 可通过全部硬门，却没有责任归属或恢复所需的 provenance |

因此任务 02 的完成门槛仍未满足。Coordinator 应原生退回 p01 或创建后续契约缺陷任务；在 `PC-CX-47..49` 关闭前，不能据 v1.8 宣称 AC5/AC9/AC10/AC11 已闭合。

## 2. 被验基线与独立性

```text
$ git rev-parse HEAD                         # fast-forward 前
ea25d11d7d64dc92abe8c54f9dbd0a63a97a0e52

$ git rev-parse feat/project                # 当时最新
0acb16c9b4952eb0c34262439cabf279cdbc6fa2

$ git merge --ff-only feat/project
Updating ea25d11d..0acb16c9
Fast-forward
6 files changed, 1966 insertions(+), 263 deletions(-)

$ git rev-parse HEAD
0acb16c9b4952eb0c34262439cabf279cdbc6fa2

$ git merge-base --is-ancestor 0acb16c9b4952eb0c34262439cabf279cdbc6fa2 HEAD
# exit 0

$ git status --short
# empty
```

01H 研发提交：

```text
0acb16c9 docs(project): close the four coordinator contract blockers PC-CX-43..46
 docs/project-coordinator-contract.md               | 321 ++++++---
 coordinator-contract.spec.ts                       | 126 ++-
 coordinator-counterexample.spec.ts                 | 295 +++++++
 coordinator-linearization.pg.spec.ts               | 555 ++++++++++++
 coordinator-v13-adversarial.spec.ts                 |   4 +-
 coordinator-v17-adversarial.spec.ts                 | 928 ++++++++++++++++-----
```

本轮新增 `coordinator-v18-adversarial.spec.ts`。它只读取权威契约，并把 D15/D16 的实际谓词建模成纯函数；断言通过表示三个反例仍可构造，不表示契约通过。

## 3. PostgreSQL 安全边界与保留证据

遵照恢复指令，本轮**没有重跑 PostgreSQL，也没有执行任何数据库连接、DDL、DML、`docker exec` 或容器创建/删除**。最终严格编译与无 DB 测试均通过，没有触发“最终校验明确失败才可重跑 PG”的例外。

上一轮独立 v1.7 复审的隔离证据完整保留在 `project-coordinator-contract-review-02-v1.7.md`：专用容器 `pcc02-v17r-pg-349bqgko-20260819e`、网络 `pcc02-v17r-net-349bqgko-20260819e`、数据库 `pcc02_v17r_349bqgko_20260819e`、用户 `pcc02_v17r_349bqgko`；DDL 前身份是 `172.23.0.2/32:5432`、`system_identifier=7675747322955370530`、PostgreSQL 16.14；资源已精确删除。

01H 研发评论另记录其 v1.8 隔离运行使用专用容器 `pcc02-01h-pg-349tuwd2-20260819h`、网络 `pcc02-01h-net-349tuwd2-20260819h`、数据库 `pcc02_01h_349tuwd2_20260819h`、用户 `pcc02_01h_349tuwd2`，身份 `172.23.0.2/32:5432`、`system_identifier=7675752414611144736`、PostgreSQL 16.14；安全闩 `coordinator-pg-test-safety.ts` 启用，195/195 全过后只删除上述资源。

这两组记录都明确未连接或传入共享 `orbit-postgres` / `orbit`。本轮没有复用任何 PostgreSQL URL、IP 或凭据。

## 4. 反例驱动故障矩阵

| 场景 | 唯一权威状态 | 确定动作 / 幂等键 | 责任人与恢复 | v1.8 判定 |
|---|---|---|---|---|
| 重复事件 | 当前 world + event disposition | partial unique event key；永久 action key | SYSTEM；重复消费影响 0 行 | PASS：E1/I14/EV4 |
| 乱序事件 | `evaluation.epoch` 快照 + W5 四元全序 | 同 decision hash 得同动作/唤醒 | SYSTEM；consumer/backstop 重投 | PASS：permutation 矩阵 |
| 事务回滚 | outbox/action/effect/decision 同生共死 | rollback 不占动作键 | 原调用者或接管 worker 重试 | PASS：N4/§8.3/C3 |
| 双 worker 竞争 | fencing token + 唯一 action outcome | 同 snapshot 同 key | SYSTEM；lease 到期接管 | PASS：01H PG 并发矩阵 |
| Session 结束 | status/end reason + 单调 generation | rotate key | SYSTEM；轮换或 typed blocker | PASS |
| Runner 离线 | action context 与 Session 应一致 | dispatchAttempt / blocker generation | SYSTEM/EVENT 或 USER/HUMAN | **BLOCKED：`PC-CX-47/49` 使实际 pin 与恢复账本不可信** |
| Provider 不可用 | typed refusal 或授权 fallback | action key + result digest | SYSTEM/EVENT | **BLOCKED：`PC-CX-47/48` 可让实际 model 与冻结结果/digest 分裂** |
| 无匹配 Runner | `NO_MATCHING_RUNNER` 等 typed refusal | refusal + blocker generation | SYSTEM/EVENT 或 USER/HUMAN | PASS：本轮未发现新反例 |
| 合并冲突 | `MERGE_CONFLICT` blocker | condition/lifecycle generation | COORDINATOR；超时升级 USER | PASS |
| 测试失败 | verdictRevision 唯一决定退回/缺陷 | verdictRevision 永不复用 | COORDINATOR；修复后复验 | PASS |
| 预算耗尽 | TIME blocker / over-cap drain | blocker generation + wake key | SYSTEM/TIME | PASS |
| 等待用户 | `AWAITING_HUMAN` + blocker 五字段 | lifecycle generation / approval key | USER/HUMAN；升级时钟 | PASS |
| 混合版本部署 | 数据库硬门应约束任意写端 | D5/D6/D9/D11/D14/D15/D16 | SYSTEM；结构化拒绝/重试 | **FAIL：`PC-CX-47..49` 均可绕过服务层并留下已提交矛盾** |
| 人工同时操作 | 两种提交顺序都应有唯一合法结果 | shared locks + action epoch | USER/SYSTEM | **BLOCKED：裸写端可写空账本对象和错误 digest，硬门仍放行** |

自动化覆盖已落入 `coordinator-v18-adversarial.spec.ts`：三个静态契约反例 + inventory；上表其余格由 01H 的 195 个既有测试回归覆盖。本轮没有为静态矛盾违反安全指令重建 PostgreSQL fixture。

## 5. Project 12 条 acceptance criteria 判定

| AC | v1.8 复审 | 证据 / 阻断 |
|---:|---|---|
| 1 | PASS | 稳定 Coordinator Agent、generation、Base62 条款未发现新反例 |
| 2 | PASS | 事件/outbox 的重复、乱序、事务原子性未发现新反例 |
| 3 | PASS | v1.8 已关闭原 `PC-CX-45` 的 lineage/唯一 live claim 形状 |
| 4 | PASS（契约矩阵） | 自动化分档与人工 gate 未发现新反例 |
| 5 | **BLOCKED** | `PC-CX-47/48`：冻结结果、实际 pin 和 result digest 可互相矛盾 |
| 6 | PASS | verification verdict 的原生退回/缺陷/阻断动作仍唯一 |
| 7 | PASS | parent 聚合与复发代次未发现新反例 |
| 8 | **BLOCKED** | Provider/Runner 恢复依赖 claim/retiredPin provenance，`PC-CX-47/49` 使其不可信 |
| 9 | **BLOCKED** | D16 只验证存在性与 cardinality，未证明 EC2-b 第 ② 部分或账本语义 |
| 10 | **BLOCKED** | `PC-CX-48/49` 可产生相互矛盾、无法归责的 digest 与 pin ledger |
| 11 | **BLOCKED** | 任意版本/裸写端可提交 `PC-CX-47..49`，与“数据库对任何二进制成立”冲突 |
| 12 | PASS（契约层） | acceptanceDigest/DONE/merge evidence 未发现新反例；实现归后续单元 |

## 6. 结构化失败证据

### `PC-CX-47` — P1 — D16 没有证明 claim-frozen model/effort

- **冲突条款**：I17-A2 generation=1 明确要求 context 是具体值时逐字复制；deferred 时 actual value 写入 `detail.claimResolution`。EC2-b 第 ② 部分也包含具体值或 `DEFERRED_TO_CLAIM` 的解析结论。D16-d 却称 D16 在提交点比较 EC2-b 结果列。
- **实际硬门**：D15 仅验证 `model/effort` 变化时 generation 恰好 +1；D16 对 generation≥1 仅检查 `claimResolution IS NOT NULL` 与 `retiredPins.length = generation - 1`。两者都不比较 `NEW.model/effort` 与 context，也不读取 claimResolution 字段。
- **最小反例**：context=`{model:'model-v1', effort:'high'}`；Session 从 null/null 更新成 `model-evil/low`，generation 0→1；action detail 写 `claimResolution={}`。D15 与 D16 模型均接受，I17-A2/EC2-b 不成立。
- **权威状态/键/责任/恢复**：action key 唯一，但同一 key 的实际执行 pin 可与冻结结果不同；空对象无法判定是正常 claim、fallback 还是人工覆写。责任人为 PAC/Coordinator 契约研发；D16 必须按 concrete/deferred 两支逐字段验证 claimResolution 和 Session pin，拒绝码需有确定重试/升级路径。

### `PC-CX-48` — P1 — result digest 的恒成立主张与 §26.5 自相矛盾

- **冲突条款**：I17-A 明称不存在两个 digest 与 context 重算不等的 APPLIED 占位，并称 D15+D16 在 COMMIT 对任何二进制构造该性质；§26.5 明称 result digest 与 context 对不上仍能提交，只由 I17-A 审计查询发现，而不是被拒绝。
- **实际硬门**：D14 只算授权摘要；D15/D16 不读取 `execution_result_digest`；D11 只把已插入的值冻结。冻结错误值不等于验证正确值。
- **最小反例**：插入正确 execution_context、正确 Session 与任意 forged `execution_result_digest`，按规范发布 APPLIED。所有 hard gate 通过，D11 此后忠实冻结 forged 值；I17-A 的审计查询返回反例。
- **权威状态/键/责任/恢复**：action key 唯一但审计标签不权威，无法用 digest 比较两个执行结果。责任人为 Coordinator 契约/迁移研发；可将 digest 设为数据库派生列，或在发布/提交门用唯一 canonical 函数重算并 typed-reject。若选择仅审计，必须删掉“恒成立/对任何二进制”的硬保证并给审计发现后的 owner、动作和恢复路径。

### `PC-CX-49` — P1 — pin ledger 只验证数量，不验证记录语义

- **冲突条款**：I17-A2 要求每条 retiredPins 记录含被替换值、替换值与时刻；EC6-c 要求 claimResolution 记录 claim 的实际取值。D16-b 却把“有对象 + 条数相等”等同于整个 I17-A2 由构造成立。
- **实际硬门**：两条 D16 函数只做 `claim IS NULL` 与 `jsonb_array_length(ledger)` 检查；没有 schema、字段、类型、old→new 链、时间、model/effort 或 generation 对应检查。
- **最小反例**：generation=2，`claimResolution={}`，`retiredPins=[{}]`。两侧 deferred trigger 都接受；记录无法说明旧值、新值、发生时间或谁负责恢复。
- **权威状态/键/责任/恢复**：generation 与数组长度一致，但没有唯一权威的 pin 历史；幂等重试无法区分合法重复、漏记和伪造。责任人为 PAC/Coordinator 契约研发；为两个 JSON 结构定义闭合 schema/唯一 idempotency identity，并在同一 deferred gate 验证从 Session OLD 到 NEW 的连续链与时间/责任字段。

## 7. 命令与关键输出

严格聚焦编译与独立无数据库回归：

```text
$ tsc --strict --target ES2022 --module commonjs --moduleResolution node \
  --esModuleInterop --skipLibCheck --types node,pg \
  --typeRoots /root/orbit/node_modules/@types --baseUrl /root/orbit/node_modules \
  --rootDir src/apiserver/src --outDir src/apiserver/build <9 coordinator specs>
# exit 0

$ env -u COORDINATOR_PG_URL -u COORDINATOR_PG_EXPECTED_DATABASE \
  -u COORDINATOR_PG_EXPECTED_USER -u COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER \
  -u TEST_DATABASE_URL -u DATABASE_URL NODE_PATH=/root/orbit/node_modules \
  node --test <9 compiled coordinator specs>
# tests 199; pass 163; fail 0; skipped 36

$ git diff --check
# 无输出，exit 0
```

边界核验：

```text
$ git diff --name-status 0acb16c9b4952eb0c34262439cabf279cdbc6fa2
A docs/project-coordinator-contract-review-02-v1.8.md
A src/apiserver/src/projects/coordinator-v18-adversarial.spec.ts

$ git diff --quiet 0acb16c9... -- docs/project-coordinator-contract.md \
  docs/project-agent-contract.md docs/project-coordinator-contract-review-02-v1.7.md
# exit 0
```

## 8. 运行环境、提交与合并

```text
Linux 6.12.38+deb13-cloud-amd64 x86_64
Node v22.22.2
git 2.47.3
Docker Engine 29.5.2
Timezone: Europe/Berlin
```

被验提交：`0acb16c9b4952eb0c34262439cabf279cdbc6fa2`。验证提交 SHA 与 `feat/project`、`/root/.orbit/worktrees/feat-project-deploy` 的 fast-forward 合并状态记录在任务 02 的持久评论中；提交不能在自身内容中记录自己的 SHA。

## 9. 遗留与放行条件

1. 修复并反向关闭 `PC-CX-47..49`，不得删除或弱化本轮独立反例。
2. 从 EC2-b 第 ② 部分生成 model/effort 的 concrete/deferred 提交断言，验证 actual pin 与 claimResolution 的逐字段一致性。
3. 让 `execution_result_digest` 与 context 的重算成为数据库构造属性；若明确降级为审计属性，必须同步改写 I17-A、混合版本保证和恢复协议，不能同时保留相反命题。
4. 为 claimResolution/retiredPins 定义并强制闭合 schema、old/new/time/责任人和稳定幂等身份；数量相等不等于 provenance 成立。

在以上 P1 关闭前，本任务保持 `IN_PROGRESS`，不置 `DONE`。
