# 02 独立审查 Coordinator 契约与故障模型（v1.13）

## 1. 结论

**FAIL / BLOCKED。** 被验研发提交 `f74d696dd2728e5c3444dee943572c64e50c545d` 局部关闭了
`PC-CX-58..61`，但独立外扩发现一个新的 **P0 `PC-CX-62`**：D20 的 purge 量化域比现行
I11-A 的 COORDINATOR 占位定义更宽。它把已终态 `REFUSED` / `SUPERSEDED` 的动作，只要
`result_session_id IS NULL`，也当作可物理删除的“未发布占位”；同时完全不读 I11-A 的
`subject_type`、`subject_id`、`session.task_id` 与 Task 所属 Project。

真实 PostgreSQL 上因此出现两类不可逆结果：

1. 同一份 `REFUSED action ← COORDINATOR Session` 存量，公开函数返回 `(1,1)` 并删除 Session，
   裸 `DELETE project` 却得到 `PROJECT_PURGE_UNDECLARED` 并保留 Session；同一权威事实有两个答案。
2. 一条双向链接虽然形式完整，但 Session 的 Task 属于另一个 Project；purge 本 Project 会删除
   外部 Project 的 Session，而外部 Project/Task 仍存在。

这直接违反 01M 的“错误 status / 跨 Project 均 typed fail closed 且数据不丢”，也违反 p02 的
“唯一权威状态、确定性动作、责任人与恢复路径”。任务不得 DONE。

## 2. 独立范围与基线

- Project：`349bHrtPbgwiouD3cfCVP`；已重新读取 goal、12 条 acceptanceCriteria、instructions。
- p02：`349bQGkoTy7QmNXtyRKaO`；第一步已用 `task_get` 读取完整信息与历史评论。
- 研发任务：01M `34A1YopmtxLryvc1pVgKH`；已读取描述、验收、评论与关联提交。
- 前一验证提交：`87630e9caaa64ac47587a325cb636e03ace201da`。
- 被验提交：`f74d696dd2728e5c3444dee943572c64e50c545d`。
- 编辑/测试前：审查树 HEAD 与 `feat/project` 均精确等于被验提交，`git status --short` 为空。
- 研发改动：权威契约及 4 份研发 spec，共 5 文件，`+1633/-139`；十三份旧独立报告与 PAC 未改。
- 本轮未修改权威契约、PAC 或研发测试；只新增本报告与独立 adversarial spec。

## 3. 原阻断复验

| 项 | 独立结果 | 证据 |
|---|---|---|
| PC-CX-58 | 局部关闭 | 四处规范均为 `INITIALLY IMMEDIATE`；真实目录为 `deferrable=t/deferred=f/delete=a/update=a`，普通语句立即拒绝，显式 deferred 后提交点拒绝 |
| PC-CX-59 | 局部关闭 | 空库、v1.10、v1.11 三路径对象 census 一致；跳过 6g2 的反控重现 D18 INSERT 盲区与 D19 缺失 |
| PC-CX-60 | **未整体关闭** | 01M 五个研发形状通过，但其“错误 status”只测了“非 APPLIED 且已有结果链接”；未测“终态且结果为空”，后者被错误纳入 scope |
| PC-CX-61 | 局部关闭 | purge-wins、publish-wins、旁路 contention 均有 typed 结果；v1.12 的 `23503` 反控仍可重现 |

## 4. 结构化失败证据

### PC-CX-62 / P0 — purge 量化域未与 I11-A 闭合，跨 Project 永久删除 Session

**权威冲突**：

- §4.3 I11-A：任何 `dispatch_origin=COORDINATOR` 占位必须指向 `status=APPLIED`、
  `subject_type=TASK`、`subject_id=session.task_id`，且 action/Task Project 相同的动作。
- D20 ⓪：状态分支是
  `APPLIED ∧ result=s` **或** `status <> APPLIED ∧ result IS NULL`；因此把 `REFUSED` 与
  `SUPERSEDED` 也纳入。函数体完全不读取 `subject_type`、`subject_id`、`session.task_id`。
- D20-c 又把相同宽谓词写成现行散文“非 APPLIED ⇒ result_session_id IS NULL”；不是仅有 SQL 漏项。
- D20-i/D20-g 声称所有说不清的存量都 `PROJECT_PURGE_UNDECIDABLE` 并进入 USER/HUMAN，
  但这两类行被 ⓪ 标为 `in_scope=true`，迁移审计计数为 0。

**最小反例 A（错误终态）**：

```text
project p; action a(project=p,type=DISPATCH_TASK,status=REFUSED,result=NULL);
session s(dispatch_origin=COORDINATOR,project_action_id=a)
```

真实 PG 输出：

```json
{"classified":{"in_scope":true,"reason":"in scope"},
 "function":{"purged_actions":"1","purged_sessions":"1"},
 "bare":"PROJECT_PURGE_UNDECLARED ...",
 "kept":"s-bare"}
```

函数路径已永久删除 `s-function`；裸路径保留 `s-bare`。这不是重复投递差异，而是两个公开入口
在同一已提交事实上的不同结果集合，正面违反 D20-f。

**最小反例 B（错误 Task/Project 归属）**：

```text
action a-owner belongs to p-owner and subject=t-owner;
session s-foreign points back to a-owner but task_id=t-foreign, where t-foreign belongs to p-foreign;
action is then published APPLIED with result_session_id=s-foreign.
```

真实 PG 输出：

```json
{"classified":{"in_scope":true,"reason":"in scope"},
 "foreignProject":"kept","foreignSession":"deleted"}
```

`coordinator_purge_project('p-owner')` 删除了 `p-foreign` 的 Session；外部 Project/Task 仍在。

**唯一状态 / 动作 / 幂等 / 恢复**：

- 唯一状态：不存在；函数提交删除，裸入口 typed 拒绝。
- 确定性动作：不存在；D20-i 预期 USER/HUMAN 裁决，但 ⓪ 将异常行误归为可删。
- 幂等：第二次函数调用只会 `(0,0)`；这只证明重复删除无副作用，不能恢复第一次丢失的 Session。
- Owner：Coordinator contract/migration + Session lifecycle owner。
- 恢复：把 ⓪ 的可删集合机械绑定到 I11-A 的完整归属关系；至少只允许 `APPLIED`，并验证
  action subject、Session Task 与两侧 Project。所有不满足项都必须在 D20-g 审计与两个入口上得到
  同一 `PROJECT_PURGE_UNDECIDABLE owner=USER recovery=HUMAN`；保留本轮两个 witness 作为反控。
- 影响：AC1、AC4、AC5、AC9、AC11；Session 生命周期、混合版本、人工 SQL、迁移存量与权限边界。

## 5. 故障矩阵

| 场景 | 权威状态 / 动作 / 键 / owner-recovery | 结果 |
|---|---|---|
| 重复事件 | 原 01–61 幂等矩阵保持；purge 以 Project 不存在收敛 `(0,0)` | PASS（但不能恢复 PC-CX-62 首次数据丢失） |
| 乱序事件 | 原事件 epoch、fence、wake 全序保持 | PASS |
| 事务回滚 | D20 deferred FK 与 v1.12 反控稳定；异常 scope 本轮却提交删除 | **BLOCKED / PC-CX-62** |
| 双 worker | 既有 lease/action 唯一约束与两次 purge 通过 | PASS |
| Session 结束/删除 | 正常 D19/D20 路径通过；错误 status/归属 Session 被跨边界物理删除 | **BLOCKED** |
| Runner 离线 | 结构化 blocker、nextWake、恢复责任不变 | PASS |
| Provider 不可用 | 无静默 fallback，既有矩阵保持 | PASS |
| 无匹配 Runner | typed blocker 与恢复时钟保持 | PASS |
| 合并冲突 | blocker/owner/retry 规则保持 | PASS |
| 测试失败 | 原生退回/缺陷子任务/下游阻断规则保持 | PASS |
| 预算耗尽 | frozen clock、nextWake 与恢复窗口保持 | PASS |
| 等待用户 | USER blocker、无 busy loop 保持 | PASS |
| 混合版本/迁移 | 6g2 对象收敛，但 D20-g 对本轮两类存量错误计数为 0 | **BLOCKED** |
| 人工同时操作 | purge/publish 锁顺序通过；人工/旧数据的错误归属仍被误删 | **BLOCKED** |
| 验收后事实变化 | AE6/AE7 与 acceptance digest 原矩阵保持 | PASS |

## 6. 12 条项目 AC

| AC | 判定 | 说明 |
|---|---|---|
| 1 | BLOCKED | purge 可删除另一 Project Task 的 Session，稳定 Session 归属失真 |
| 2 | PASS | 事件重复、乱序、重启矩阵保持 |
| 3 | PASS | 活性状态与 wake/blocker 规则保持 |
| 4 | BLOCKED | 删除权限边界与 USER/HUMAN 裁决被绕过 |
| 5 | BLOCKED | D20 snapshot/decision 的量化输入不是 I11-A 全集 |
| 6 | PASS | 验证失败原生动作保持 |
| 7 | PASS | 聚合策略保持 |
| 8 | PASS | Runner/Provider/merge/test/budget/user blocker 矩阵保持 |
| 9 | BLOCKED | 混合版本存量不会被 D20-g 发现，恢复路径不可达 |
| 10 | PASS | 全自动矩阵可独立运行，新增 witness 已落盘 |
| 11 | BLOCKED | 迁移审计把异常行误记为 scope 内，不满足安全兼容 |
| 12 | PASS | DONE/验收/合并硬门保持 |

## 7. 命令与关键输出

```text
candidate strict                                      exit 0
candidate no-DB                                       tests 279; pass 214; fail 0; skip 65
candidate isolated PG                                 tests 279; pass 279; fail 0; skip 0

focused v1.13 strict                                  exit 0
focused no-DB                                         tests 3; pass 1; fail 0; skip 2
focused isolated PG                                   tests 3; pass 3; fail 0; skip 0

final full strict                                     exit 0
final full no-DB                                      tests 282; pass 215; fail 0; skip 67; 1425.328896ms
final full isolated PG                                tests 282; pass 282; fail 0; skip 0; 22583.238279ms
git diff --check                                      exit 0
```

全绿的含义：候选原有自证保持通过，新增独立测试稳定证明 `PC-CX-62` 存在；不是候选验收通过。

## 8. PostgreSQL 隔离证据

- container：`pcc02-v113r-pg-349bqgko-20260819d`
- network：`pcc02-v113r-net-349bqgko-20260819d`
- database：`pcc02_v113r_349bqgko_20260819d`
- user：`pcc02_v113r_349bqgko`
- host：`127.0.0.1:32781`
- image：`postgres:16-alpine`；`Mounts=[]`；data 使用 tmpfs，无 volume
- system_identifier：`7675845179110596643`；PostgreSQL `16.14`

每个测试连接的第一条查询均经 `coordinator-pg-test-safety.ts` 核验并打印：

```text
coordinator-pg-isolation database=pcc02_v113r_349bqgko_20260819d
user=pcc02_v113r_349bqgko server=172.23.0.2/32:5432
system_identifier=7675845179110596643 version=16.14
```

测试后只删除上述精确 container/network；post-cleanup exact inspect 均不存在。未列举、连接、exec、
传入或修改共享 PostgreSQL 名称、数据库、IP 或凭据；共享控制面零 DDL/DML。

## 9. 可自动化后续清单

1. ⓪ 对 `REFUSED`、`SUPERSEDED`、停留 `CLAIMED` 的已提交存量均返回 `in_scope=false`。
2. ⓪ 对 subject type/id、Session task、Task project 任一错配均返回精确 reason。
3. 上述每个形状经函数和裸入口得到逐字相同的 `PROJECT_PURGE_UNDECIDABLE`，三张表不动。
4. D20-g 迁移审计对每个形状计数非 0，并产出 USER/HUMAN blocker 输入。
5. 合法 `APPLIED` 双向同 Task/Project 占位仍 `(1,1)`；空 Project/只有合法账本路径保持。
6. 保留本轮“函数删除 / 裸入口保留”及“外部 Project 留存 / 外部 Session 丢失”作为反向 witness。

## 10. 环境与交付原则

Linux `6.12.38+deb13-cloud-amd64` x86_64；Europe/Berlin；Node `v22.22.2`；npm `10.9.7`；
TypeScript `5.9.3`；Git `2.47.3`；Docker `29.5.2`；隔离 PostgreSQL `16.14`。

本报告与 `coordinator-v113-adversarial.spec.ts` 是唯一允许新增的独立证据。验证提交 SHA、
`feat/project` fast-forward 结果与目标 staged 指纹在提交后写入 p02 durable comment。
