# Project Coordinator 契约 v1.9 独立复审（任务 02，第十轮）

## 1. 结论

**FAIL / BLOCKED：v1.9 仍不能作为“无未解决 P0/P1 歧义”的冻结契约。**

本轮先读取任务 02 的完整信息与历史评论，再读取 Project 的 goal、12 条 acceptance criteria、instructions、p01 与 01I 的完整任务/评论。任何编辑或测试前，工作树从上一轮独立验证提交 `ec71dcde3fc90319154f766bb061097d81c25fac` 安全 fast-forward 到当时最新 `feat/project`：`4f1efb3cbb61494e7ef1f8807cc76d670fe87f1e`（01I / v1.9）；随后核验 HEAD 精确等于该 SHA、工作树为空且该提交是 HEAD 的祖先。

没有修改 `docs/project-coordinator-contract.md`、`docs/project-agent-contract.md`、旧独立报告或研发测试来掩盖失败。本轮只新增本报告与独立 v1.9 对抗测试。01I 确实关闭了 `PC-CX-47..49` 的原始反例；继续翻转它新增的 D16/D17 后，真实 PostgreSQL 又确认 **3 个 P1**：

| ID | 严重度 | 结论 |
|---|---:|---|
| `PC-CX-50` | **P1** | D11 允许任意后续写把 `APPLIED` 动作的 `result_session_id` 清空；D16 动作侧随即按 `NEW.result_session_id IS NULL` 早退。再把另一个 D11 可写列 `detail` 改成空账本也能提交，留下 Session→action 仍存在、action→Session 已消失且 pin 账本已坏的 I17-A2 反例 |
| `PC-CX-51` | **P1** | `DEFERRABLE` row trigger 延迟的是执行时刻，不会把每个事件捕获的 `NEW` 换成该行最终版本。一次合法 heartbeat 或 display detail 补写后再在同事务完成 first claim，最终状态可通过 fold，但较早事件在 COMMIT 用中间 `NEW` 比最终另一侧，确定性 abort；D16-a 的“语句顺序无关、判最终状态”不成立 |
| `PC-CX-52` | **P1** | EC6-c 要求 model/effort 是非空具体值或 sentinel，EC2-b 又称结果半恰好三部分且封闭；D17 只拒绝 `->>` 为 SQL NULL，不拒绝空字符串，也没有封闭结果半的键/类型检查。空 model/effort 可被 claim 并提交；缺 `requiredCapabilities/permissionMode/resolution/snapshotFrozenAt` 的结果半也可带正确 digest 提交 |

因此任务 02 的完成门槛仍未满足。Coordinator 应原生退回 p01 或创建后续契约缺陷任务；在 `PC-CX-50..52` 关闭前，不能据 v1.9 宣称 AC5/AC8/AC9/AC10/AC11 已闭合。

## 2. 被验基线与独立性

```text
$ git status --short                         # fast-forward 前
# empty

$ git rev-parse HEAD
ec71dcde3fc90319154f766bb061097d81c25fac

$ git rev-parse feat/project
4f1efb3cbb61494e7ef1f8807cc76d670fe87f1e

$ git merge-base --is-ancestor ec71dcde3fc90319154f766bb061097d81c25fac 4f1efb3cbb61494e7ef1f8807cc76d670fe87f1e
# exit 0

$ git merge --ff-only 4f1efb3cbb61494e7ef1f8807cc76d670fe87f1e
Updating ec71dcde..4f1efb3c
Fast-forward
5 files changed, 1635 insertions(+), 111 deletions(-)

$ git rev-parse HEAD
4f1efb3cbb61494e7ef1f8807cc76d670fe87f1e

$ git merge-base --is-ancestor 4f1efb3cbb61494e7ef1f8807cc76d670fe87f1e HEAD
# exit 0

$ git status --short
# empty
```

01I 研发提交只改了权威契约和四份研发测试：

```text
4f1efb3c docs(project): close coordinator blockers PC-CX-47..49
 docs/project-coordinator-contract.md              | ...
 coordinator-contract.spec.ts                      | ...
 coordinator-counterexample.spec.ts                | ...
 coordinator-linearization.pg.spec.ts              | ...
 coordinator-v18-adversarial.spec.ts                | ...
```

本轮新增 `coordinator-v19-adversarial.spec.ts`。它的真实服务器路径不是抄一份近似 D11/D15/D16/D17，而是从被验权威文档各节的第一个 SQL fence 直接抽取并安装；因此反例针对的是被验契约本身。断言通过表示反例被复现，不表示契约通过。

## 3. PostgreSQL 安全边界与隔离证据

本轮只创建以下唯一、一次性对象，无持久卷：

```text
container: pcc02-v19r-pg-349bqgko-20260819k
network:   pcc02-v19r-net-349bqgko-20260819k
database:  pcc02_v19r_349bqgko_20260819k
user:      pcc02_v19r_349bqgko
image:     postgres:16-alpine
host:      127.0.0.1:32776
```

创建前按精确名字检查，容器与网络都返回 not found。容器 ready 后、任何测试 DDL 前先做只读身份查询：

```text
current_database=pcc02_v19r_349bqgko_20260819k
current_user=pcc02_v19r_349bqgko
system_identifier=7675776076113653794
server_version=16.14
```

测试连接的 `coordinator-pg-test-safety.ts` 又在第一条 fixture DDL 前核验并打印：

```text
coordinator-pg-isolation database=pcc02_v19r_349bqgko_20260819k
user=pcc02_v19r_349bqgko server=172.23.0.2/32:5432
system_identifier=7675776076113653794 version=16.14
```

首次隔离运行是 6/7：`PC-CX-52` 的缺键 fixture 错把缺失 `requiredCapabilities` 投影为空数组，D15 正确返回 `EXECUTION_SNAPSHOT_MISMATCH`。只修正独立 fixture 为缺键→SQL NULL 后，同一已核验容器复跑 **7/7**；未改研发代码或契约。结束后精确删除上述容器和网络，再按精确名字检查，两者均为 not found。

整个过程从未把共享 `orbit-postgres`、`orbit` 数据库、共享 IP 或凭据传给命令、环境变量或测试；没有列举、连接、`docker exec` 或修改共享数据库。

## 4. 反例驱动故障矩阵

| 场景 | 唯一权威状态 | 确定动作 / 幂等键 | 责任人与恢复 | v1.9 判定 |
|---|---|---|---|---|
| 重复事件 | 当前 world + event disposition | partial unique event key；重复消费影响 0 行 | SYSTEM；consumer/backstop 重投 | PASS：E1/I14/EV4 回归 |
| 乱序事件 | `evaluation.epoch` + W5 四元全序 | 同 snapshot/hash 得同动作与唤醒 | SYSTEM；重算而非依赖到达序 | PASS：permutation 回归 |
| 事务回滚 | outbox/action/effect/decision 同生共死 | rollback 不占动作键 | 原 worker/接管 worker 重试 | **BLOCKED：`PC-CX-51` 把合法最终状态稳定误拒，原样重试仍失败** |
| 双 worker 竞争 | fencing token + 唯一 action outcome | 同 snapshot 同永久 key | SYSTEM；lease 到期接管 | PASS：既有并发矩阵未发现新反例 |
| Session 结束 | Session lineage + generation | rotate/end key | SYSTEM；轮换或 typed blocker | **BLOCKED：`PC-CX-50` 允许动作端单向断链，结束/恢复时两侧事实不同** |
| Runner 离线 | frozen context + claim/retired pin ledger | dispatchAttempt / pin generation | SYSTEM/EVENT 或 USER/HUMAN | **BLOCKED：`PC-CX-50/52` 使实际 pin 与恢复账本/冻结结论不可信** |
| Provider 不可用 | typed refusal 或显式 fallback | action key + result digest | SYSTEM/EVENT | **BLOCKED：空 pin 或不完整结果半仍可成为“正确摘要”** |
| 无匹配 Runner | `NO_MATCHING_RUNNER` typed refusal | refusal + blocker generation | SYSTEM/EVENT 或 USER/HUMAN | PASS：本轮未发现新反例 |
| 合并冲突 | `MERGE_CONFLICT` blocker | condition/lifecycle generation | COORDINATOR；超时升级 USER | PASS |
| 测试失败 | verdictRevision 决定退回/缺陷 | verdictRevision 永不复用 | COORDINATOR；修复后独立复验 | PASS |
| 预算耗尽 | TIME blocker / over-cap drain | blocker generation + wake key | SYSTEM/TIME | PASS |
| 等待用户 | `AWAITING_HUMAN` + blocker 五字段 | lifecycle generation / approval key | USER/HUMAN；升级时钟 | PASS |
| 混合版本部署 | 数据库硬门约束任何写端 | D5/D6/D9/D11/D14/D15/D16/D17 | SYSTEM；typed reject/重试 | **FAIL：三个反例全部绕过服务层；其中 50/52 留下已提交矛盾** |
| 人工同时操作 | 两种提交序都应唯一 | shared locks + action epoch | USER/SYSTEM | **BLOCKED：裸 SQL 可断链/提交空结果；合法多语句 final state 又会被历史 NEW 误拒** |

自动化矩阵落在 `coordinator-v19-adversarial.spec.ts`：

1. 三个无 DB 静态断言直接核对权威 SQL 的早退谓词、row-event `NEW`、结果结构检查；
2. `PC-CX-50` 真实 PG 断言 detach 与账本破坏分别提交，并查询双向链接与 generation；
3. `PC-CX-51` 真实 PG 分别注入“heartbeat→claim”和“display detail→claim”，断言最终 fold 合法而两次事务均被历史事件拒绝并完整回滚；
4. `PC-CX-52` 真实 PG 分别提交空字符串 pin 与缺四个 EC2-b/PAC 字段的正确 digest；
5. inventory 断言安全闩在第一条破坏性 SQL 之前调用。

## 5. Project 12 条 acceptance criteria 判定

| AC | v1.9 复审 | 证据 / 阻断 |
|---:|---|---|
| 1 | PASS | 稳定 Coordinator Agent、generation、Base62 未发现新反例 |
| 2 | PASS | 事件/outbox 的重复、乱序、原子性未发现新反例 |
| 3 | PASS | 权威派发与唯一 live claim 未发现新的重复执行反例 |
| 4 | PASS（契约矩阵） | 自动化分档与人工 gate 未发现新反例 |
| 5 | **BLOCKED** | `PC-CX-50/52`：动作/Session 结果可断链，空或缺字段结果仍被视为冻结执行 |
| 6 | PASS | verification verdict 的原生退回/缺陷/阻断动作仍唯一 |
| 7 | PASS | parent 聚合与复发代次未发现新反例 |
| 8 | **BLOCKED** | Provider/Runner 恢复依赖可信 pin 与完整冻结结果；50/52 破坏两者 |
| 9 | **BLOCKED** | D16 不是最终态验证，且动作侧可被清空链接主动关闭 |
| 10 | **BLOCKED** | 已提交双向账本可矛盾；缺失结果字段仍有“正确”digest，无法可靠归责 |
| 11 | **BLOCKED** | 任意版本/裸写端可提交 `PC-CX-50/52`；`PC-CX-51` 还给合法写端确定性假失败 |
| 12 | PASS（契约层） | acceptanceDigest/DONE/merge evidence 未发现新反例；实现归后续单元 |

## 6. 结构化失败证据

### `PC-CX-50` — P1 — D11 可写列能关闭读取它们的 D16 硬门

- **冲突条款**：D11-b 说 `result_session_id/detail` “都不进任何硬门的谓词”；D16 动作函数第一条早退正读取 `NEW.result_session_id`，fold 又读取 `NEW.detail`。I17-A/I17-A2 要求动作与 Session 结果、pin 账本双向一致。
- **实际硬门**：`IF NEW.type <> 'DISPATCH_TASK' OR NEW.result_session_id IS NULL THEN RETURN NULL`。D11 允许 APPLIED 后把该列清空，之后任意 detail 更新都在 fold 前早退。Session 侧只在 Session 行更新时触发，因此不会发现单独 action 更新。
- **最小事务与关键观察**：合法 dispatch + first claim 后，事务 A 清空 `result_session_id` 并提交；事务 B 把 detail 改为 `{"claimResolution":{}}` 并提交。查询得到 `{"action_result":null,"session_action":"act1","generation":"1","claim":"{}"}`。
- **权威状态 / 键 / 责任 / 恢复**：永久 action key 仍唯一，但两张表对同一结果给出相反事实；key 不能裁决哪侧权威。责任人为 Coordinator 契约/迁移研发。应把 `result_session_id` 限制为一次性 `NULL→正确 Session` 发布后冻结，或让动作门从 `session.project_action_id` 反查并拒绝 detach/repoint；迁移前需审计并修复现存非对称链接，拒绝必须 typed。

### `PC-CX-51` — P1 — deferred row trigger 验证历史 NEW，不是最终行

- **冲突条款**：D16-a 称可延迟让两条 UPDATE 先后顺序不重要，判据都落在 COMMIT 的最终状态；D16-c 还明确选择让每次 Session status/heartbeat 更新触发检查，D11-b 允许 detail 的 claim 与展示补写。
- **实际 PostgreSQL 语义**：每条 `FOR EACH ROW` 事件保留该语句产生的 `NEW`。Session 函数用 `NEW.execution_pin_generation/model/effort`，动作函数用 `NEW.detail/execution_context/result_session_id`；两者都只重读另一张表，没有按 `NEW.id` 重读自己的最终行。
- **两个最小反例**：① Session `status=PENDING→RUNNING`，再写完整 claimResolution，再将 Session 置 generation 1；较早 Session 事件用 generation 0 对最终 claim，抛 `EXECUTION_PIN_LEDGER`。② 先补 `detail.display`，再补完整 claimResolution，再将 Session 置 generation 1；较早 action 事件用无 claim 的 detail 对最终 generation，抛同码。独立调用 fold 证明拟提交最终状态是 `{model:'model-v1',effort:'high'}`；两事务均完整回滚。
- **权威状态 / 键 / 责任 / 恢复**：没有脏提交，但合法动作没有可完成路径；同 key 原样重试确定性再次失败，不能靠幂等恢复。责任人为 Coordinator DB 契约研发。约束函数应在 COMMIT 按 id 重读**本行最终版本**（重复事件可幂等重复验证），或明确且机械强制“每行每事务只允许一次相关写”；后者会与 heartbeat/display 的既有可写承诺冲突。

### `PC-CX-52` — P1 — “有键”仍未被证明为“非空且完整的冻结结果”

- **冲突条款**：EC6-c 要求 model/effort 为非空具体值或 `DEFERRED_TO_CLAIM`；EC2-b 要求结果半是由 PAC 表反推的恰好三部分、封闭；EC6-d 要求 snapshotFrozenAt 是唯一冻结来源。
- **实际硬门**：D17 仅做 `ctx->>'model' IS NULL OR ctx->>'effort' IS NULL`，空字符串不是 NULL。D16 concrete 分支只要求 `value=frozen` 与 source，二者同时为空即可。D17 对 authorization 做九键闭集，对 result half 没有必需键/类型闭集；digest 只忠实散列实际存在的残缺对象。D15/D16 的 `IS DISTINCT FROM` 又把“上下文缺键 + Session SQL NULL”视为相等。
- **最小反例与关键观察**：空字符串 context 的 honest digests、Session gen0、随后 `{frozen:'',value:'',source:'FROZEN_CONTEXT'}` claim 与 Session `model='' effort=''` 均提交。另一动作删除 `requiredCapabilities/permissionMode/resolution/snapshotFrozenAt`，按残缺对象正确算 digest，匹配的 SQL NULL Session 也提交；查询得到四个键全部缺失、capabilities/permission 均为 NULL。
- **权威状态 / 键 / 责任 / 恢复**：action key 与两个 digest 都唯一/正确，但它们唯一标识的是一份契约禁止的残缺结果，不能驱动确定恢复。责任人为 Coordinator 契约/迁移研发。D17 应从 PAC §6/§7.5 机械生成结果半闭合 schema，验证必需键、JSON 类型、非空 concrete/sentinel 和 resolution 子结构；存量行需审计后迁移或 typed refuse，不能用 SQL NULL 代替缺失冻结结论。

## 7. 命令与关键输出

基线 v1.9 的严格聚焦编译与独立无 DB 回归（新增文件前）：

```text
$ tsc --strict ... <9 coordinator specs>
# exit 0

$ env -u COORDINATOR_PG_URL ... node --test <9 compiled coordinator specs>
# tests 211; pass 172; fail 0; skipped 39
```

新增测试的独立无 DB 与隔离 PG：

```text
$ tsc --strict ... coordinator-pg-test-safety.ts coordinator-v19-adversarial.spec.ts
# exit 0

$ env -u COORDINATOR_PG_URL ... node --test coordinator-v19-adversarial.spec.js
# tests 7; pass 4; fail 0; skipped 3

$ COORDINATOR_PG_URL=<本轮专用 URL> \
  COORDINATOR_PG_EXPECTED_DATABASE=pcc02_v19r_349bqgko_20260819k \
  COORDINATOR_PG_EXPECTED_USER=pcc02_v19r_349bqgko \
  COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=7675776076113653794 \
  node --test coordinator-v19-adversarial.spec.js
# tests 7; pass 7; fail 0; skipped 0
```

最终全量聚焦编译与无 DB 回归：

```text
$ tsc --strict ... <10 coordinator specs>
# exit 0

$ env -u COORDINATOR_PG_URL -u COORDINATOR_PG_EXPECTED_DATABASE \
  -u COORDINATOR_PG_EXPECTED_USER -u COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER \
  -u TEST_DATABASE_URL -u DATABASE_URL node --test <10 compiled coordinator specs>
# tests 218; pass 176; fail 0; skipped 42

$ git diff --check
# 无输出，exit 0

$ git status --short
?? docs/project-coordinator-contract-review-02-v1.9.md
?? src/apiserver/src/projects/coordinator-v19-adversarial.spec.ts

$ git diff --quiet 4f1efb3c... -- docs/project-coordinator-contract.md \
  docs/project-agent-contract.md docs/project-coordinator-contract-review-02-v1.8.md
# exit 0
```

## 8. 运行环境、提交与合并

```text
Linux 6.12.38+deb13-cloud-amd64 x86_64
Node v22.22.2
git 2.47.3
Docker Engine 29.5.2
Timezone: Europe/Berlin
PostgreSQL fixture: 16.14 (postgres:16-alpine)
```

被验提交：`4f1efb3cbb61494e7ef1f8807cc76d670fe87f1e`。验证提交 SHA 与 `feat/project`、`/root/.orbit/worktrees/feat-project-deploy` 的 fast-forward 合并状态记录在任务 02 的持久评论中；提交不能在自身内容中记录自己的 SHA。

## 9. 遗留与放行条件

1. 修复并反向关闭 `PC-CX-50..52`，不得删除或弱化本轮独立反例。
2. 将 action↔Session 结果链接写成数据库双向不变量；APPLIED 后不能靠清空 gate selector 关闭保护。
3. 让 deferred trigger 重读触发行的最终版本，并新增同一事务内 heartbeat/display 补写 + claim/retire 的多事件回归。
4. 从 PAC 表机械生成 EC2-b 结果半闭合 schema，至少强制必需键、类型、非空 claim 结论和 snapshotFrozenAt。
5. 对存量 APPLIED dispatch 运行三类审计：非对称 result link、空 pin、缺 PAC result key；给每类 typed owner 与恢复动作。

在以上 P1 关闭前，本任务保持 `IN_PROGRESS`，不置 `DONE`。
