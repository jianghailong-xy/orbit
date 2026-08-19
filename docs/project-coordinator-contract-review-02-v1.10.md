# Project Coordinator 契约 v1.10 独立复审（任务 02，第十一次）

## 1. 结论

**FAIL / BLOCKED：v1.10 关闭了 `PC-CX-50..52` 的原始反例，但仍不能作为“无未解决 P0/P1 歧义”的冻结契约。**

本轮先读取任务 02 的完整信息与历史评论，再读取 Project 的 goal、12 条 acceptance criteria、instructions、p01 与 01J 的完整任务/评论。任何编辑或测试前，工作树从上一轮验证提交 `3a7baac17b245ecbbebb768c98c2551631d4bff6` 安全 fast-forward 到当时最新 `feat/project` / 01J v1.10 被验提交 `618e7a7826d07026f75d81516d62d2c80368dfa5`；随后核验 HEAD 精确相等、工作树为空、候选是 HEAD 的祖先。

没有修改 `docs/project-coordinator-contract.md`、`docs/project-agent-contract.md`、旧独立报告或研发测试来掩盖失败。本轮只新增本报告与独立 v1.10 对抗测试。真实 PostgreSQL 安装的 D11/D16/D17/D18 均从被验权威文档的 SQL fence 直接抽取。结果确认 01J 的三个原始反例已关闭，但跨 PAC 与生命周期继续翻转后发现 **1 个 P0、2 个 P1**：

| ID | 严重度 | 结论 |
|---|---:|---|
| `PC-CX-53` | **P0** | PAC §7.5 要求 `session.resolution.v` 必写；EC2-b 又说冻结“整份 resolution”。v1.10 的形状函数却只接受恰好 `who/with/where` 三键：合规 PAC 结果必被 `EXECUTION_RESULT_SHAPE` 拒，删掉必需的 `v` 才通过，正常 Coordinator 派发没有合法交集 |
| `PC-CX-54` | **P1** | I17-A3 永久要求 APPLIED action 指向存在的 Session；产品与契约允许 Session 删除/最终 purge，但 D16 只监听 INSERT/UPDATE，且契约没有冻结 `result_session_id → session` 的 FK / on-delete 行为。soft delete 后 hard delete 可提交并留下 APPLIED orphan |
| `PC-CX-55` | **P1** | D18 只监听 UPDATE；未发布 CLAIMED action 可在 INSERT 时带 `retiredPins={}` 并提交。此后 D18 在验类型前就执行 `jsonb_array_elements/jsonb_array_length`，正常 REFUSED 转移与修复 detail 都抛原生 SQLSTATE `22023`，永久 action/key 卡死且没有 typed owner/recovery |

因此 p02 的完成门槛仍未满足。Coordinator 应原生退回 p01 或创建后续缺陷任务；`PC-CX-53..55` 关闭前不得把 p02 置为 DONE。

## 2. 被验基线与独立性

```text
$ git status --short                         # fast-forward 前
# empty

$ git rev-parse HEAD
3a7baac17b245ecbbebb768c98c2551631d4bff6

$ git rev-parse feat/project
618e7a7826d07026f75d81516d62d2c80368dfa5

$ git merge-base --is-ancestor HEAD 618e7a7826d07026f75d81516d62d2c80368dfa5
# exit 0

$ git merge --ff-only 618e7a7826d07026f75d81516d62d2c80368dfa5
Updating 3a7baac1..618e7a78
Fast-forward
6 files changed, 1720 insertions(+), 193 deletions(-)

$ git rev-parse HEAD
618e7a7826d07026f75d81516d62d2c80368dfa5

$ git merge-base --is-ancestor 618e7a7826d07026f75d81516d62d2c80368dfa5 HEAD
# exit 0

$ git status --short
# empty
```

01J 只改权威契约和五份研发/既有独立测试；上一轮 v1.9 报告未改。本轮的验证提交只新增：

- `docs/project-coordinator-contract-review-02-v1.10.md`
- `src/apiserver/src/projects/coordinator-v110-adversarial.spec.ts`

测试文件的 PG fixture 不复制一份近似 D11/D16/D17/D18；它从权威文档实时抽取并安装四段 SQL。断言通过表示反例被复现，不表示契约通过。

## 3. PostgreSQL 安全边界与隔离证据

本轮只创建以下唯一、一次性对象，无 volume：

```text
container: pcc02-v110r-pg-349bqgko-20260819m
network:   pcc02-v110r-net-349bqgko-20260819m
database:  pcc02_v110r_349bqgko_20260819m
user:      pcc02_v110r_349bqgko
image:     postgres:16-alpine
host:      127.0.0.1:32777
```

创建前按精确名字执行 container/network inspect，二者均为 not found。容器 ready 后、任何测试 DDL 前先做只读身份查询：

```text
current_database=pcc02_v110r_349bqgko_20260819m
current_user=pcc02_v110r_349bqgko
system_identifier=7675796122992578594
server_version=16.14
```

测试连接的 `coordinator-pg-test-safety.ts` 又在第一条 fixture DDL 前核验并打印：

```text
coordinator-pg-isolation database=pcc02_v110r_349bqgko_20260819m
user=pcc02_v110r_349bqgko server=172.23.0.2/32:5432
system_identifier=7675796122992578594 version=16.14
```

测试完成后精确删除上述容器和网络，再按精确名字 inspect，二者均为 not found。全过程没有列举、连接、`docker exec` 或传入任何共享控制面 PostgreSQL 的名字、数据库、IP 或凭据；没有在共享数据库执行任何 DDL/DML。

## 4. 反例驱动故障矩阵

| 场景 | 唯一权威状态 | 确定动作 / 幂等键 | 责任人与恢复 | v1.10 判定 |
|---|---|---|---|---|
| 重复事件 | event disposition + 当前 world | partial unique event key；重复消费影响 0 行 | SYSTEM；consumer/backstop 重投 | PASS：既有 E1/I14/EV4 回归未发现新反例 |
| 乱序事件 | `evaluation.epoch` + W5 持久全序 | 同 snapshot/hash 得同动作与唤醒 | SYSTEM；按冻结输入重算 | PASS |
| 事务回滚 | action/effect/decision 同生共死 | rollback 不占永久键 | 原 worker/接管 worker 重试 | **BLOCKED：PC-CX-55 的 key 已在先前 INSERT 占住，任何终态/修复 UPDATE 都稳定 22023** |
| 双 worker 竞争 | fencing token + 唯一 action outcome | 同 snapshot 同永久 key | SYSTEM；lease 到期接管 | PASS：原竞争矩阵未发现新反例 |
| Session 结束/删除 | Session lineage + action result link | rotate/end/purge 各需冻结语义 | SYSTEM/USER | **FAIL：PC-CX-54 允许 hard delete 后留下 APPLIED orphan，无权威侧与恢复规则** |
| Runner 离线 | frozen PAC resolution + blocker | dispatch attempt / pin generation | SYSTEM/EVENT 或 USER/HUMAN | **BLOCKED：PC-CX-53 使任何含 PAC `v` 的正常结果都无法发布** |
| Provider 不可用 | typed refusal 或显式 fallback | action key + result digest | SYSTEM/EVENT | **BLOCKED：fallback resolution 必须带 PAC `v`，但 DB exact-key gate 拒绝** |
| 无匹配 Runner | `NO_MATCHING_RUNNER` typed refusal | refusal + blocker generation | SYSTEM/EVENT 或 USER/HUMAN | PASS（refusal）；恢复后实际派发仍受 PC-CX-53 阻断 |
| 合并冲突 | `MERGE_CONFLICT` blocker | condition/lifecycle generation | COORDINATOR；超时升级 USER | PASS |
| 测试失败 | verdictRevision 决定退回/缺陷 | verdictRevision 永不复用 | COORDINATOR；修复后独立复验 | PASS |
| 预算耗尽 | TIME blocker / over-cap drain | blocker generation + wake key | SYSTEM/TIME | PASS |
| 等待用户 | `AWAITING_HUMAN` + blocker 五字段 | lifecycle generation / approval key | USER/HUMAN；升级时钟 | PASS |
| 混合版本部署 | 数据库硬门约束任意写端 | D5/D6/D9/D11/D14–D18 | SYSTEM；typed reject/重试 | **FAIL：旧/错误写端能先提交 malformed CLAIMED action，升级后永久卡死且只有原生 22023** |
| 人工同时操作 | 人工删除与控制环结果应有一个线性化结论 | Session/action 生命周期 key | USER/SYSTEM | **FAIL：soft delete 合法，随后 purge 不触发 D16；action 历史与 Session 事实分叉** |

自动化矩阵落在 `coordinator-v110-adversarial.spec.ts`：三条无 DB 跨契约/事件面断言、三条真实 PG 反例，以及一条 safety/inventory 断言。

## 5. Project 12 条 acceptance criteria 判定

| AC | v1.10 复审 | 证据 / 阻断 |
|---:|---|---|
| 1 | PASS | Coordinator Agent / generation / workspace 绑定未发现新反例 |
| 2 | PASS | 事件重复、乱序、原子性既有矩阵保持 |
| 3 | **BLOCKED** | `PC-CX-53`：合法 PAC execution result 不能通过 DB gate，Coordinator 无正常派发路径 |
| 4 | PASS（契约矩阵） | 自动化分档与人工 gate 未发现新反例 |
| 5 | **BLOCKED** | `PC-CX-53/54`：执行结果无合法 shape；Session purge 又破坏 action↔Session 唯一事实 |
| 6 | PASS | verification verdict 的退回/缺陷/阻断动作未发现新反例 |
| 7 | PASS | parent 聚合与复发代次未发现新反例 |
| 8 | **BLOCKED** | Runner/Provider fallback 的 PAC resolution 被 exact-key gate 拒绝 |
| 9 | **BLOCKED** | `PC-CX-54/55`：删除事件不受提交门保护，畸形账本没有 typed/retryable 恢复 |
| 10 | **BLOCKED** | APPLIED action 可指向不存在的 Session；CLAIMED key 可卡在不可修复的畸形账本 |
| 11 | **BLOCKED** | 混合版本的旧写端可制造 PC-CX-55；PC-CX-53 对所有合规版本都是无条件拒绝 |
| 12 | PASS（契约层） | DONE/merge evidence 未发现新反例；实现归后续单元 |

## 6. 结构化失败证据

### `PC-CX-53` — P0 — “整份 PAC resolution”与 exact-key gate 无合法交集

- **冲突条款**：PAC §7.5 的结构含顶层 `{v, who, with, where}`，并逐字规定“`v` 必须写”；Coordinator EC2-b 规定结果摘要覆盖“PAC §7.5 的整份 `resolution`”。EC2-b2/D17 却用 `ARRAY['where','who','with']` 做 exact-key 比较。
- **最小反例**：同一份完整 execution context，只把 `resolution` 写成 PAC 规定的 `{v:1,who:{…},with:{…},where:{…}}`，`coordinator_execution_result_shape` 抛 `EXECUTION_RESULT_SHAPE: ... resolution is not PAC 7.5's who/with/where`；删除 `v` 后通过。
- **权威状态 / 键 / 责任 / 恢复**：这不是坏输入被拒，而是正常路径不存在。action key 尚未发布也无法恢复；原样重试永远同错。Owner=Coordinator/PAC 契约研发。应从 PAC §7.5 机械生成 resolution shape，至少纳入必需 `v`，并用含真实 PAC resolution 的正例跑完整 dispatch；不得以修改 PAC 或继续使用 versionless fixture 掩盖失败。

### `PC-CX-54` — P1 — Session purge 绕过双向结果链接的永久不变量

- **冲突条款**：I17-A3 规定不存在 APPLIED dispatch 指向缺失 Session；§7.5 又明确把用户删除 Coordinator Session 作为合法轮换触发。D16 Session 侧只声明 `AFTER INSERT OR UPDATE ON session`，D9-f 还明确 `NOT FOUND` 直接返回；§2.4 没有冻结 action→Session FK 或 on-delete 行为。
- **最小生命周期**：合法 dispatch 建立 action↔Session 双向链接；soft delete (`deleted_at`) 提交并通过 D16；随后 hard delete Session 提交。最终查询是 `{status:'APPLIED', result_session_id:'session-delete', session_exists:false}`。
- **权威状态 / 键 / 责任 / 恢复**：永久 action key 仍在，但它指向不存在的事实；action 历史、Session purge 与 rotation 无法裁决谁权威。Owner=Coordinator 契约/迁移 + Session 生命周期。必须冻结一种方案：禁止 purge 被历史 action/decision 引用的 Session、保留 tombstone，或定义不会违反 GE1/I17 的 FK/on-delete 与历史投影；DELETE 必须有数据库对象与 typed owner/recovery。

### `PC-CX-55` — P1 — 畸形初始账本能提交并把永久 action/key 锁死

- **冲突条款**：D18 声称 `retiredPins` 只追加且越界得到 `EXECUTION_PIN_LEDGER`；D11 又允许 CLAIMED→REFUSED。实际 D18 只监听 UPDATE，D16 对非 APPLIED 且 link NULL 的动作早退；D18 的函数体先展开 `new_ledger`、按 `jsonb_array_length(old_ledger)` 截前缀，之后才检查 `jsonb_typeof(new_ledger)='array'`。
- **最小反例**：INSERT `CLAIMED` action，`detail={"retiredPins":{}}`，提交成功。正常 `SET status='REFUSED', refusal_code='PROVIDER_UNAVAILABLE'` 抛原生 SQLSTATE `22023`；尝试 `SET detail='{}'` 修复仍因 OLD 是 object 抛同码。查询保持 `{status:'CLAIMED', detail:'{"retiredPins": {}}'}`。
- **权威状态 / 键 / 责任 / 恢复**：永久 key 已被占，原 worker/接管 worker/人工修复都走同一 BEFORE UPDATE 并稳定失败；删除 action 会违反 GE1。没有 typed owner 或合法恢复路径。Owner=Coordinator DB 契约研发。INSERT 必须验证账本顶层类型；D18 必须先 type-check 再调用 array 函数，并让修复/终态路径得到契约错误码与确定恢复；迁移前需审计非数组 ledger。

## 7. 命令与关键输出

候选原样 strict 聚焦编译与无 DB 回归：

```text
$ /root/orbit/node_modules/.bin/tsc --strict ... <10 coordinator specs>
# exit 0

$ env -u COORDINATOR_PG_URL ... node --test <10 compiled coordinator specs>
# tests 231; pass 186; fail 0; skipped 45
```

新增独立测试：

```text
$ /root/orbit/node_modules/.bin/tsc --strict ... coordinator-v110-adversarial.spec.ts
# exit 0

$ env -u COORDINATOR_PG_URL ... node --test coordinator-v110-adversarial.spec.js
# tests 7; pass 4; fail 0; skipped 3

$ COORDINATOR_PG_URL=<本轮专用 URL> \
  COORDINATOR_PG_EXPECTED_DATABASE=pcc02_v110r_349bqgko_20260819m \
  COORDINATOR_PG_EXPECTED_USER=pcc02_v110r_349bqgko \
  COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=7675796122992578594 \
  node --test coordinator-v110-adversarial.spec.js
# tests 7; pass 7; fail 0; skipped 0
```

最终全量聚焦编译、无 DB 回归、diff 范围与格式检查记录在提交前的最终校验和任务 02 持久评论中。

## 8. 运行环境、提交与合并

```text
Linux 6.12.38+deb13-cloud-amd64 x86_64
Node v22.22.2
git 2.47.3
Docker Engine 29.5.2
Timezone: Europe/Berlin
PostgreSQL fixture: 16.14 (postgres:16-alpine)
```

被验提交：`618e7a7826d07026f75d81516d62d2c80368dfa5`。验证提交 SHA 与 `feat/project`、`/root/.orbit/worktrees/feat-project-deploy` 的 fast-forward 合并状态记录在任务 02 的持久评论中；提交不能在自身内容中记录自己的 SHA。

## 9. 遗留与放行条件

1. 关闭 `PC-CX-53`：PAC 合法 resolution（含必需 `v`）必须走完整 dispatch 正例并提交。
2. 关闭 `PC-CX-54`：冻结 Session soft-delete/purge 与 action/decision 历史的 FK/tombstone/DELETE 语义，并给 typed owner/recovery。
3. 关闭 `PC-CX-55`：INSERT 与 UPDATE 都先验证 ledger 类型，正常终态和修复路径不得被原生 JSON 异常锁死。
4. 修订后反向翻转本轮独立反例，不得删除、弱化或把 PAC fixture 改成 versionless 来换绿。

以上 P0/P1 关闭前，本任务保持 `IN_PROGRESS`，不置 `DONE`。
