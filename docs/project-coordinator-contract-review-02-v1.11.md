# 02 独立审查 Project Coordinator 契约与故障模型（v1.11）

结论：**FAIL / BLOCKED**。01K 对 `PC-CX-53..55` 的三个局部修订均能通过正反控制；跨条款外扩后新发现
两个 P1：`PC-CX-56` 的双向 `RESTRICT` 与 Project 级联删除组成不可达的 purge 路径，`PC-CX-57` 的
malformed-ledger 兼容分支提前返回并绕过 `claimResolution` 的只写一次约束。p02 不满足“无未解决 P0/P1”门槛。

本轮没有修改权威契约、PAC、研发测试或旧审查报告来换绿。新增内容只有本报告与独立 adversarial spec。

## 1. 权威上下文与被验提交

- Project：`349bHrtPbgwiouD3cfCVP`，已重新读取 goal、12 条 acceptanceCriteria 与 instructions。
- 复审任务：`349bQGkoTy7QmNXtyRKaO`，已先用 `task_get` 读取完整信息与历史评论。
- 关联研发任务：01K `349yT6ymr6v5dsGbMLCAS`，状态 `DONE`；已读取其完整描述、验收条件、评论和提交证据。
- 被验 01K/v1.11 提交：`88837831c71bcdd1f1ef9a1f1d9b39b1a472f127`。
- 前置 v1.10 证据提交：`d9b6a7cf781167f3a2db2a28c73931eed0979112`。
- 基线门禁：编辑/测试前 `git status --short` 为空；`HEAD=d9b6a7cf…`，
  `feat/project=88837831…`，ancestor check exit 0；随后
  `git merge --ff-only 88837831c71bcdd1f1ef9a1f1d9b39b1a472f127` 成功，
  `HEAD` 精确等于被验 SHA 且工作树仍干净。

Project 的权威目标仍是：Project 是目标与工作图边界，Coordinator 是事件驱动、可恢复、可证明幂等的持续推进控制环；
Provider 不可静默 fallback；Task、Session、Runner、Provider、合并与人工操作都必须有唯一状态、确定动作、责任人与恢复路径。

## 2. v1.11 局部关闭复验

| 原缺陷 | 独立结果 | 关键正反控制 |
|---|---|---|
| `PC-CX-53` | **局部关闭** | 含 `{v,who,with,where}` 的真实 PAC resolution 完整派发提交；缺 `v`、多键、错型、非正整数拒绝；未知正整数版本允许 |
| `PC-CX-54` | **局部关闭** | 软删与软删后心跳提交；已发布 Session 的顺序 purge 得 typed `SESSION_RESULT_LINK_REFERENCED`；只留 FK 时为 `23503`；并发发布/删除仍为 typed `P0001` |
| `PC-CX-55` | **局部关闭** | 畸形 `retiredPins` INSERT 在语句级得到 `EXECUTION_PIN_LEDGER`；旧畸形行的普通终态和显式修复可提交；没有原生 `22023` |

`PC-CX-54` 的并发删除原假设在第一次 focused PG 中被真实结果推翻：发布事务持锁、删除等待、发布提交之后，
删除仍由 D19 trigger 返回 `P0001 / SESSION_RESULT_LINK_REFERENCED`，owner/recovery 均在。它作为正向并发控制保留，
不列为缺陷。

## 3. 新结构化失败证据

### PC-CX-56 / P1 — 双向 RESTRICT 使 D19-c 的 Project purge 恢复路径不可达

**契约证据**：

1. §2.4 规定五张控制环表（含 `project_action`）全部 `onDelete: Cascade` 挂在 Project 下；
2. 同节新表规定 `project_action.result_session_id → session.id` 为 `RESTRICT`；
3. 同节又规定 `session.projectActionId → project_action.id` 为 `RESTRICT`；
4. D15/D18 冻结两侧链接，不能先清空任一侧；GE1 禁止逐条删除动作历史；
5. D19-c 却把唯一物理清除路径写成“删除 Project，让 action 随 Project 级联消失，之后 Session 可删”。

**最小交错 / 真实 PostgreSQL**：

1. 插 Project `p-linked`；插 `APPLIED` action `a1`；插 Session `s1`，两侧互指；
2. `DELETE session s1` 被 action→Session `RESTRICT`/D19 guard 拒绝（这是预期）；
3. `DELETE project p-linked` 触发级联删除 `a1`，但 Session→action `RESTRICT` 拒绝，
   得 `SQLSTATE 23503 constraint=session_project_action_fk`，Project 与三行全部仍在；
4. 反向控制：摘掉 Session→action FK 后 Project 删除成功，但 `s1.project_action_id='a1'` 且 action 不存在，
   留下 D15/I17-A3 明令禁止的孤儿 lineage；
5. 空 Project 删除成功，证明失败来自链接拓扑而非 fixture。

**唯一权威状态**：没有。保持双向 `RESTRICT` ⇒ Project 无法 purge；摘掉任一侧 ⇒ 允许孤儿或违反 GE1。

**确定性动作 / 幂等键**：动作永久键不参与删除排序，无法选择哪侧权威；D19-c 宣称的 Project 级动作没有可执行事务。

**责任人与恢复**：Owner=Coordinator 契约/数据库迁移负责人。必须冻结一条真的可提交的 Project 级 purge 协议，
并在同一真实 schema 上测试。可选方向包括：显式 Project-purge fence + 同事务内可延迟关系；或保留 tombstone、取消物理删除承诺。
不能继续同时要求两个立即 `RESTRICT`、不可清链接、action 级联删除和“Project 删除可恢复”。

**影响**：AC1/AC5/AC9/AC11；人工删除、Session 生命周期、混合版本及恢复路径矩阵。

### PC-CX-57 / P1 — malformed-ledger 兼容分支关闭了 D18 的其它硬门

**契约证据**：D18 ⓪ 在 `retiredPins` 非数组且 UPDATE 的新旧 ledger 相同时立即 `RETURN NEW`；
这个返回发生在 ① `result_session_id` 冻结、② `claimResolution` 只写一次、③ ledger 前缀检查之前。
D18-g 的意图只是在旧畸形值未被本语句触碰时允许终态/展示写入，但实现把整个 mutator 都退出了。

**最小交错 / 真实 PostgreSQL**：

1. 模拟迁移前存量，插一条终态 `REFUSED` action：
   `detail={"retiredPins":{},"claimResolution":{"old":1}}`；随后恢复 D18 trigger；
2. 只把 `claimResolution` 改成 `{"new":2}`，`retiredPins` 保持 `{}`；
3. D18 在 ⓪ 分支提前返回，UPDATE **提交**，查询得到 `{new:2}`；永久 action/key 的首次 claim 审计被改写；
4. 正向控制：相同 action 仅把 `retiredPins` 换成合法 `[]`，同一 claim 改写得到 typed
   `EXECUTION_PIN_LEDGER: ... rewrites a claimResolution`；
5. 兼容正例：另一条旧畸形 `CLAIMED` action 只做 `CLAIMED→REFUSED`，仍正常提交。

**唯一权威状态**：同一 `claimResolution` 是否不可改，意外取决于一个无关 sibling key 的顶层类型；合法数组时不可改，
旧畸形对象时可任意改，没有唯一规则。

**确定性动作 / 幂等键**：永久 action/idempotency key 不变，而其审计内容被原位改写；重放无法知道首次 claim 的原值。

**责任人与恢复**：Owner=Coordinator DB mutator/迁移负责人。兼容分支只能跳过 retiredPins 的数组展开/前缀判定，
不能返回整个函数；①/② 必须无条件执行。迁移 ④-a 仍应先收敛全部未发布畸形行，④-b 仍应隔离已发布行。

**影响**：AC2/AC5/AC9/AC11；混合版本、迁移恢复、人工补写与重复事件审计。

## 4. 反例驱动故障矩阵

| 场景 | 权威状态 / 确定动作 / 幂等与恢复 | v1.11 结论 |
|---|---|---|
| 重复事件 | 同 conditionVersion/episode 合并；事件消费与动作键各自落库 | PASS（全矩阵） |
| 乱序事件 | reconcile 读当前事实，不以事件 payload 作为权威世界 | PASS |
| 事务回滚 | outbox 与事实同事务；失败无事件/动作部分提交 | PASS |
| 双 worker 竞争 | lease fencing + action unique key + task claim index | PASS |
| Session 结束 | 运行终态与 Task 分开；Coordinator Session 可轮换 | PASS；物理 Project purge 被 `PC-CX-56` 阻断 |
| Runner 离线 | reaper → typed failure/blocker → 恢复事件 | PASS |
| Provider 不可用 | `PROVIDER_UNAVAILABLE`；仅显式 fallback | PASS |
| 无匹配 Runner | `NO_MATCHING_RUNNER`/能力 blocker；恢复后自动解除 | PASS |
| 合并冲突 | typed blocker，目标分支事实重新采集 | PASS |
| 测试失败 | 原生 verdict 退回/缺陷子任务/阻断下游 | PASS |
| 预算耗尽 | 结构化 budget blocker + next wake | PASS |
| 等待用户 | `AWAITING_HUMAN`，无无界 backstop 打扰 | PASS |
| 混合版本部署 | DB gates 覆盖旧写端 | **BLOCKED**：旧 malformed ledger 兼容窗可改写 claim（`PC-CX-57`） |
| 人工同时操作 | policy/claim/delete 与 Coordinator 线性化 | PASS；并发发布/删除正向控制仍 typed |
| Project 物理删除（外扩） | 应有唯一 Project 级 purge 事务 | **BLOCKED**：双向 RESTRICT 环（`PC-CX-56`） |

## 5. 12 条 Project AC 判定

| AC | 判定 | 证据/阻断 |
|---:|---|---|
| 1 | BLOCKED | Coordinator/Session 稳定身份已定义；Project purge 生命周期被 `PC-CX-56` 阻断 |
| 2 | BLOCKED | 重复/乱序主体通过；`PC-CX-57` 允许同永久 key 的审计原位变化 |
| 3 | PASS | 活性、blocker、next wake 矩阵仍唯一 |
| 4 | PASS | 策略、预算、审批与并发边界未被 01K 改坏 |
| 5 | BLOCKED | `claimResolution` 不再是可信的只写一次输入记录（`PC-CX-57`） |
| 6 | PASS | 验证失败的退回/缺陷/下游阻断仍原生 |
| 7 | PASS | 聚合完成策略与代次仍确定 |
| 8 | PASS | 六类 blocker、owner、recovery、去重均有测试 |
| 9 | BLOCKED | Project/Session 恢复路径无合法 purge；legacy ledger 兼容窗旁路 |
| 10 | PASS | 现有读模型与 256 项独立/故障注入测试可执行 |
| 11 | BLOCKED | 迁移要求既保留旧畸形行恢复，又在该窗口放宽了无关审计字段 |
| 12 | PASS | 项目验收、合并内容与 DONE 硬门未被 01K 改坏 |

## 6. 自动化清单

落地于 `src/apiserver/src/projects/coordinator-v111-adversarial.spec.ts`：

1. 静态/模型：从 §2.4 机械读取 Project→action cascade 与双向 RESTRICT，枚举 Session-first/action-first/Project-first。
2. PG：链接 Project 删除得到 `23503 session_project_action_fk`；空 Project 删除正例。
3. PG 反向控制：摘掉 reverse FK 后 Project 删除成功但留下 Session→missing action。
4. PG 并发正向控制：未提交 action 发布与 Session DELETE 竞争，仍得到 typed D19 error。
5. 静态/模型：确认 malformed ledger 的 early return 位于 link/claim guards 之前。
6. PG：旧畸形终态 action 的 `claimResolution` 改写提交；合法 ledger 的同一改写拒绝。
7. PG 正例：旧畸形 `CLAIMED→REFUSED` 保持可达。

后续关闭测试还必须增加：在接近实际 Prisma FK 拓扑的 schema 上执行真正 Project purge，且同一矩阵必须同时证明
无 orphan、无 GE1 逐条删除、无永久不可删 Project；D18 修订后应 mutation 掉 malformed compatibility 分支，证明终态仍可达而 ①/② 始终有效。

## 7. 命令与关键输出

```text
git status --short
# empty
git rev-parse HEAD refs/heads/feat/project
# d9b6a7cf... / 88837831...
git merge-base --is-ancestor HEAD refs/heads/feat/project
# exit 0
git merge --ff-only 88837831c71bcdd1f1ef9a1f1d9b39b1a472f127
# Updating d9b6a7cf..88837831; Fast-forward; 6 files +1383/-122
git rev-parse HEAD
# 88837831c71bcdd1f1ef9a1f1d9b39b1a472f127

/root/orbit/node_modules/.bin/tsc --strict ... coordinator-*.spec.ts
# exit 0
env -u COORDINATOR_PG_URL ... node --test coordinator-*.spec.js
# tests 251; pass 200; fail 0; skipped 51

# 首次把 build 放在 /tmp 后，strict 编译成功，但测试按 __dirname 推导成 /docs，得到 ENOENT。
# 这是审查命令的输出布局错误，不是候选失败；改回仓库既有 src/apiserver/build 后即得到上面的 251/251(含 skip)。

tsc --strict ... coordinator-v111-adversarial.spec.ts
# exit 0
env -u COORDINATOR_PG_URL ... node --test coordinator-v111-adversarial.spec.js
# tests 5; pass 2; fail 0; skipped 3

COORDINATOR_PG_URL=<本轮专用> ... node --test coordinator-v111-adversarial.spec.js
# tests 5; pass 5; fail 0; skipped 0

COORDINATOR_PG_URL=<本轮专用> ... node --test coordinator-*.spec.js
# tests 256; pass 256; fail 0; skipped 0; duration_ms 19341.666493
```

全绿的含义：研发的关闭断言全部保持绿；新增 adversarial tests 也稳定证明 `PC-CX-56..57` 当前存在。

## 8. PostgreSQL 隔离与清理证据

本轮只创建下列对象，无 volume：

```text
container  pcc02-v111r-pg-349bqgko-20260819b
network    pcc02-v111r-net-349bqgko-20260819b
database   pcc02_v111r_349bqgko_20260819b
user       pcc02_v111r_349bqgko
host       127.0.0.1:32779
image      postgres:16-alpine
storage    --tmpfs /var/lib/postgresql/data; docker inspect mounts=[]
```

创建前精确 container/network inspect 均 `rc=1`（不存在）。第一条 fixture DDL 前先只读预检，再由
`coordinator-pg-test-safety.ts` 在每个连接第一条查询二次核验并打印：

```text
database=pcc02_v111r_349bqgko_20260819b
user=pcc02_v111r_349bqgko
server=172.23.0.2/32:5432
system_identifier=7675812723337269281
version=16.14
```

测试后只删除上述精确容器与网络；两者 post-cleanup exact inspect 均 `rc=1`。全程没有列举、连接、exec、
传入或修改任何共享 PostgreSQL 的名称、数据库、IP 或凭据；共享控制面零 DDL/DML。

## 9. 运行环境、文件范围与放行条件

- Linux `6.12.38+deb13-cloud-amd64` x86_64；Europe/Berlin。
- Node `v22.22.2`；npm `10.9.7`；TypeScript `5.9.3`；Git `2.47.3`；Docker `29.5.2`；PostgreSQL `16.14`。
- 工作树：`/root/.orbit/worktrees/01a01971-bb7b-7593-91ed-3d6648a3dc9d`，分支 `orbit/02-coordinator-32ba2b`。
- 被验 SHA：`88837831c71bcdd1f1ef9a1f1d9b39b1a472f127`。
- 验证 SHA 与 fast-forward 合并状态由本轮最终 task comment 记录（提交前无法把自身 SHA 写进自身内容）。

放行 p02 的必要条件：权威契约逐项关闭 `PC-CX-56..57`；Project purge 在完整 FK/trigger 拓扑上有一条真实正例；
malformed-ledger 兼容路径只跳过 ledger 自身检查而不跳过 link/claim 冻结；本文件的反例翻转并保留当前失败形状为反向控制；
strict、无 DB、全隔离 PG 与 `git diff --check` 全绿。完成之前 p02 必须保持 `IN_PROGRESS`。
