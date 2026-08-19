# Project Coordinator 契约 v1.2 独立复审（02）

> 审查任务：`02 独立审查 Coordinator 契约与故障模型`（Orbit task `349bQGkoTy7QmNXtyRKaO`）
>
> 被验修订：`8e31fcb3c4f2224f693f13ef864234f0783445a3`
>
> 前轮证据：[`project-coordinator-contract-review-02.md`](./project-coordinator-contract-review-02.md)、[`project-coordinator-contract-review-02-v1.1.md`](./project-coordinator-contract-review-02-v1.1.md)
>
> 审查日期：2026-08-19
>
> 约束：未修改 `project-coordinator-contract.md`、研发反例模型或 PostgreSQL spec；本文件只记录从 v1.2 重新推导的反例与后续自动化清单。

## 1. 结论

**FAIL / BLOCKED**。v1.2 的原有 49 项套件（含 3 项真实 PostgreSQL 用例）在补充本工作树的依赖解析路径后全部通过，`PC-CX-09..14` 指定的正反向对照也都能复现；但这些测试仍把不可逆的单轮模型当成了完整生命周期。把相同规则放回重复投递、条件解除后复发、Task 跨 Project 移动、多个事实写入者、外部 Git 状态和伪造 action 归属后，发现 **6 个 P1**：

| ID | 级别 | 受影响验收 | 结论 |
|---|---|---|---|
| `PC-CX-15` | **P1** | AC2 · AC3 · AC8 | 重复信号仍会递增 `occurrences` 并触发升级/通知，令同一事实得到不同 owner 与 run state；预算升级目标又在两处互相冲突 |
| `PC-CX-16` | **P1** | AC2 · AC3 · AC8 | `RAISE_BLOCKER` 永久动作键没有 blocker 生命周期；条件解除后同因复发会撞历史键，无法重新持久化 blocker |
| `PC-CX-17` | **P1** | AC2 · AC3 · AC6 · AC7 · AC12 | verdict 与 aggregate 的键来自可回到旧值的事实；第二轮同 verdict/同 childrenDigest 被误判为已应用；acceptance 的 `<attempt>` 没有权威来源 |
| `PC-CX-18` | **P1** | AC5 · AC9 · AC12 | AE6 自称封闭却遗漏 Task 跨 Project 移动、`verifiesTaskId` 改写和外部 target ref 变化，I10 仍可被破坏 |
| `PC-CX-19` | **P1** | AC3 · AC5 · AC9 · AC12 | 两个 DONE 后事实写入者先各取 `FOR SHARE` 再升级 UPDATE，会真实触发 `40P01`；同时 F3 的“不得取第二把锁”与 D6/AE6/AE7 不可同时实现 |
| `PC-CX-20` | **P1** | AC5 · AC9 · AC10 | D6 只检查 `project_action_id IS NOT NULL`，并未证明它是本 Task 的 APPLIED `DISPATCH_TASK`；真实 PostgreSQL 可提交违反 I11 的 Session |

因此 02 的完成条件“无未解决 P0/P1 契约歧义”仍不成立。以下证据可直接供 Coordinator 原生退回或创建下一修订子任务。

## 2. 新增结构化失败证据

### PC-CX-15 — 重复投递仍能改变升级、通知与状态（P1）

**契约证据**：

- §5.1 E1 规定事件是信号，重复投递不得产生额外副作用。
- §7.2 TF1 只把 `occurrences` 从 turn digest 排除；§11.3 仍在每次同因命中时 `occurrences += 1`。
- §11.5 把 `occurrences > 10` 作为升级条件；升级会写 owner、`escalated_at` 并通知一次。
- §11.5 ES3 冻结“一步到 USER”，但 §9.4 仍写 `SYSTEM → COORDINATOR → USER`。

**最小反例**：Provider 的真实状态一直为 unavailable。一次信号得到 `occurrences=1 / owner=SYSTEM / BLOCKED / 0 notification`；同一个信号重复 11 次得到 `occurrences=11 / owner=USER / AWAITING_HUMAN / 1 notification`。世界事实完全相同，仅投递次数不同，权威状态、责任人和副作用却都不同。

**权威预期**：投递次数不得作为升级事实。升级可绑定条件存活时间，或绑定去重后的独立语义观测代次；同一事件的重投必须在 owner、run state、通知数和 next wake 上完全等价。升级目标也只能保留一条规则。

**责任人与恢复**：blocker policy / orchestration service；去掉原始投递次数阈值或定义不会被重投推进的 observation generation，并删除 §9.4 的三级阶梯残文。属性测试必须比较完整 blocker 行与通知，而不只比较 `reasonDigest`。

### PC-CX-16 — blocker 解除后复发被永久动作键吞掉（P1）

**契约证据**：

- §7.3 / §8.2 把 `RAISE_BLOCKER` 键冻结为 `blocker:<kind>:<subjectId>`，明确“没有 epoch”。
- `project_action.idempotency_key` 全局唯一且历史行不删除。
- §11.3 的 blocker 唯一约束只覆盖 open 行；解除后同因可以合法新开一条 blocker 行。
- §8.5 C2 对历史动作键冲突的处理是跳过对应副作用。

**最小反例**：`PROVIDER_UNAVAILABLE(provider-1)` 首次发生，动作 K APPLIED、blocker open；Provider 恢复，blocker clear；一小时后 Provider 再次不可用。业务条件是一个新的故障周期，但新 outcome 仍计算 K，冲突被判 `ALREADY_APPLIED` 并跳过插 blocker，最终没有 open blocker。

**权威预期**：open 周期内的重复命中同键；条件解除后再次从 false→true 必须获得新的单调 lifecycle generation。动作键可绑定 blocker row id/condition episode，不能把“同一 subject”误当成“一生只发生一次”。

**责任人与恢复**：action ledger / blocker service；增加不可复用的 blocker episode，真实数据库测试跑 `open → clear → reopen`，断言两条历史动作、第二条 open blocker、唯一责任人和 next wake。

### PC-CX-17 — 可逆事实复用永久 action key（P1）

**契约证据**：

- verdict 键是 `verdict:<verifierTaskId>:<verdict>`；同一个 verifier Task 明确允许修复后重新运行（V4）。
- aggregate 键是 `aggregate:<taskId>:<childrenDigest>`；AG3 明确子任务可 `DONE → OPEN → DONE`。
- acceptance 键写作 `acceptance:<attempt>`，但快照、数据字段、§8.2 epoch 列表和 §13.4 都没有定义 `attempt` 的持久化来源或推进事务。

**最小反例**：

1. verifier V 第一次 FAIL，`verdict:V:FAIL` APPLIED，目标 Task 被退回。
2. 修复后目标与 V 重新完成；再次验证仍 FAIL。
3. 同一个键撞历史动作，C2 跳过机械后果，目标仍 DONE、下游没有重新阻断。

父聚合同型：childrenDigest 按 `DONE → OPEN → DONE` 回到旧值，第三次 aggregate 撞第一次的键，父 Task 停在 OPEN。`<attempt>` 未定义则更早：不同实现可按事件数、历史 action 数或内存计数生成不同 acceptance 键。

**权威预期**：动作身份必须包含单调、持久化且与本次语义运行原子推进的 generation。verdict 使用 verifier run/verdict generation；aggregate 要么是无副作用的 current-state CAS 重算，要么使用聚合 generation；acceptance 明确定义持久字段或直接绑定稳定事实摘要，并处理事实回环。

**责任人与恢复**：Task semantics / action ledger；加入 `FAIL → PASS/修复 → FAIL`、`DONE → OPEN → DONE` 和重复 acceptance 事件/重启的生命周期测试。

### PC-CX-18 — AE6 的“封闭集合”并不封闭（P1）

**契约证据**：

- AE1 的 `taskSet` 取项目当前 Task 集合，`verdicts` 包含 `verifiesTaskId`，`mergeEvidence` 声称反映目标分支内容。
- AE6 仅列 Task create/delete、status、completionPolicy、verdict、criteria 和“merge evidence 写入”。
- §12.3 D3 明确存在 Task 填入/移出 `projectId` 的写路径，但 AE6 没有列它；AE6 也没有列 `verifiesTaskId` 改写。
- Git target ref/content 是数据库外部事实；普通 push、人工 merge 或工作树更新不会自然取得 Project 行锁。

**最小反例**：Project P 已 DONE。另一个事务把 Task X 从别处移入 P，按 D3 只走 task authority primitive；P 的 taskSet 已变但没有 AE6 Project 锁/AE8 重开，I10 为假，守卫仍 SETTLED。改写 verifier 的 `verifiesTaskId` 同理。即使数据库路径齐全，target branch 在 AE7 重算 contentHash 后、DONE 提交前改变，也没有与 `FOR UPDATE` 共享线性化点。

**权威预期**：列举所有 digest mutator，而不是只列部分字段写。跨 Project 移动必须按 project id 全序锁旧/新 Project，并分别重开；验证关系变化走同门。Git 侧必须定义唯一权威的 ref generation/content snapshot、支持的写入口和 post-DONE 更新协议；不能宣称 PostgreSQL 行锁能锁住外部 ref。

**责任人与恢复**：Project/Task/merge service；真实双事务测试至少覆盖 move-in、move-out、verifier relink、target ref CAS 与人工 merge。

### PC-CX-19 — AE6 锁升级可死锁，且锁纪律自相矛盾（P1）

**契约证据**：

- AE6 要求每个验收事实写事务第一句对 Project 取 `FOR SHARE`。
- AE8 要求读到 DONE 后在同一事务 UPDATE 同一 Project 为 OPEN。
- 两个并发写入者可以同时持有兼容的 SHARE 锁，随后都等待对方释放以升级 UPDATE，形成标准锁升级死锁。
- §8.1 F3 同时宣称 reconcile “不获取任何第二把锁”；v1.2 的 D6 触发器必须取 Task `FOR SHARE`，而 outcome 事务已经先 UPDATE/锁住 `project_runtime`。AE6/AE7 还引入 Project 锁。两套规则无法同时满足。

**真实 PostgreSQL 结果**：两个连接各自 `BEGIN → SELECT project FOR SHARE → UPDATE project SET status='OPEN'`，PostgreSQL 16.14 返回一方 `40P01 deadlock detected`，另一方才可继续。契约没有为这类用户事实写失败定义重试、责任人或恢复路径。

**权威预期**：使用不需要升级的共同 primitive（例如一开始就取得可更新锁，或原子 CAS/generation），冻结跨 Project/runtime/task/session 的完整锁序；为 `40P01/40001` 定义有界自动重试与对外错误。若 F3 不再成立，应明确替换而不是同时保留。

**责任人与恢复**：数据库协议 / Project service；真实数据库测试覆盖两个及以上 DONE 后事实写入者、反向锁序和 bounded retry，断言用户操作不以未分类 500 结束。

### PC-CX-20 — D6 不能证明 I11 的 action 归属（P1）

**契约证据**：

- I11 要求 COORDINATOR-origin Session 对应一条 APPLIED `DISPATCH_TASK` action。
- D6 的实际谓词只有 `dispatch_origin='COORDINATOR' AND project_action_id IS NOT NULL`；没有检查 action type、status、subject/task/project 或 fencing token。
- USER 分支直接 RETURN，也没有强制 `project_action_id IS NULL`。
- PostgreSQL spec 的简化 schema甚至没有 `project_action` 表，只能测试“非空字符串”，无法证明 I11。

**真实 PostgreSQL 结果**：建立 FK 后插入一条 `type=NOOP, status=CLAIMED` 的 action，再按 D6 插入 COORDINATOR Session，事务成功提交；查询得到该 Session 指向 NOOP/CLAIMED，I11 为 false。

**权威预期**：已提交状态上的 action type/status/subject/project/session 关联必须由数据库约束、可延迟 constraint trigger，或一个明示的受信原子 primitive 保证；USER origin 至少约束 action id 为 NULL。契约不能说“由 D6 保证”而 D6 不读取被保证的列。

**责任人与恢复**：Session/action schema；真实 PostgreSQL 正反例必须包含 action 表和外键，并在 COMMIT 后断言 I11，而不只断言非空。

## 3. 指定场景复验矩阵

| 场景 | 唯一状态 / 动作 / 键 | 责任人与恢复 | v1.2 verdict |
|---|---|---|---|
| 重复事件 | 同一事实本应保持相同 blocker/owner/state/notification | SYSTEM 去重，无需人工 | **FAIL `PC-CX-15`** |
| 乱序事件 | reconcile 重读事实；顺序本身不应进入动作身份 | SYSTEM 收敛 | 基础 PASS；重复批次触发升级时受 `PC-CX-15` 影响 |
| 事务回滚 | outbox 与业务写同事务；回滚无事件/动作 | SYSTEM 重投或无需恢复 | PASS（新锁的死锁恢复受 `PC-CX-19` 影响） |
| 双 worker 竞争 | fencing 决定唯一提交者 | 旧 token 回滚、新 token 接管 | PASS；F3 与新增锁不可同时实现，**FAIL `PC-CX-19`** |
| Session 结束 | 结束事件重算；authority 补投影同事务 | SYSTEM 自动恢复 | PASS（D8 指定交错） |
| Runner 离线 | `NO_MATCHING_RUNNER`/失败路径 | Runner 恢复事件 + 定时兜底 | 首次 PASS；重复/复发 **FAIL `PC-CX-15/16`** |
| Provider 不可用 | `PROVIDER_UNAVAILABLE`、禁止静默 fallback | Provider 恢复或显式 fallback | 首次 PASS；重复/复发 **FAIL `PC-CX-15/16`** |
| 无匹配 Runner | SYSTEM/EVENT 或能力不满足 USER/HUMAN | 条件恢复/用户配置 | 首次 PASS；重复/复发 **FAIL `PC-CX-15/16`** |
| 合并冲突 | conditionVersion 决定 turn；复发应新 blocker | Coordinator→USER/事件恢复 | digest PASS；复发和外部 ref **FAIL `PC-CX-16/18`** |
| 测试失败 | 退避/阈值明确；同 verifier 新一轮 verdict 必须再应用 | 用户修复后重新验证 | **FAIL `PC-CX-17`** |
| 预算耗尽 | SYSTEM/TIME，窗口边界恢复 | 定时器 + 必要时通知用户 | **FAIL `PC-CX-15/16`**；升级目标文字冲突 |
| 等待用户 | USER/HUMAN，升级后可停钟 | 用户事件恢复 | 初始 PASS；approval/blocker 生命周期需按 `PC-CX-16/17` 补代次 |
| 混合版本部署 | D5/D6/D8 对旧 sweep 的指定交错通过 | DB 硬门，旧入口可见失败 | authority PASS；action 归属 **FAIL `PC-CX-20`** |
| 人工同时操作 | 人工/Coordinator Session 由 D5 唯一 | 败者结果明确 | 派发 PASS；并发验收事实写 **FAIL `PC-CX-19`** |
| 验收后事实变化 | 所有 digest mutator 都应同门并重开 | Project/Task/merge service | **FAIL `PC-CX-18/19`** |
| 聚合状态回环 | 每次 current-state 重算都应落正确父状态 | Task aggregation service | **FAIL `PC-CX-17`** |

## 4. 项目验收标准复核

| AC | 结果 | 未关闭证据 |
|---|---|---|
| AC1 | 条款覆盖 | 无新增 P0/P1 |
| AC2 | **BLOCKED** | `PC-CX-15`、`PC-CX-16`、`PC-CX-17` |
| AC3 | **BLOCKED** | `PC-CX-15`、`PC-CX-16`、`PC-CX-17`、`PC-CX-19` |
| AC4 | **BLOCKED** | `PC-CX-15`（升级策略不唯一） |
| AC5 | **BLOCKED** | `PC-CX-18`、`PC-CX-19`、`PC-CX-20` |
| AC6 | **BLOCKED** | `PC-CX-17` |
| AC7 | **BLOCKED** | `PC-CX-17` |
| AC8 | **BLOCKED** | `PC-CX-15`、`PC-CX-16` |
| AC9 | **BLOCKED** | `PC-CX-18`、`PC-CX-19`、`PC-CX-20` |
| AC10 | **BLOCKED** | `PC-CX-20` 的真实 DB spec 不含 action 表；隔离工作树还需显式 `NODE_PATH` 才能加载 `pg` |
| AC11 | 条款覆盖 | authority rollout 指定交错通过 |
| AC12 | **BLOCKED** | `PC-CX-17`、`PC-CX-18`、`PC-CX-19` |

## 5. 后续自动化清单

- [ ] 重复/乱序同一信号 N∈{1,2,11,50}，比较完整 blocker 行、owner、state、通知、wake，而不只比较 digest（`PC-CX-15`）。
- [ ] 18 个 blocker kind 全部跑 `open → repeated delivery → clear → same-cause reopen`，断言新的 episode/action 且通知策略唯一（`PC-CX-15/16`）。
- [ ] verifier 跑 `FAIL → 修复/PASS → 再 FAIL`，断言第二次原生退回、缺陷与下游阻断均生效（`PC-CX-17`）。
- [ ] 父 Task 跑 children digest `A → B → A`，断言父状态每次等于当前重算（`PC-CX-17`）。
- [ ] acceptance 的 attempt identity 做重复事件、接管、事实变化与事实回环测试，证明键由持久化单调事实产生（`PC-CX-17`）。
- [ ] AE6 coverage test 从 acceptanceDigest schema 自动生成 mutator 集合，覆盖 projectId move、verifiesTaskId、跨 Project 锁序和外部 target ref generation（`PC-CX-18`）。
- [ ] 真实 PostgreSQL：两个/三个 DONE 后 fact writer 同时开始，禁止 40P01 泄漏并验证有界重试（`PC-CX-19`）。
- [ ] 真实 PostgreSQL：D6 正反例带完整 action 表，拒绝 wrong type/status/task/project/fence 与 USER+nonnull action（`PC-CX-20`）。
- [ ] 静态契约检查：所有被标记“封闭/唯一”的规则不得存在旧版相反句；至少检查升级路径和 F3 锁纪律。

## 6. 执行证据

```text
$ git rev-parse feat/project
8e31fcb3c4f2224f693f13ef864234f0783445a3

$ /root/orbit/node_modules/.bin/tsc --target ES2022 --module commonjs \
    --moduleResolution node --esModuleInterop --skipLibCheck --strict \
    --types node --typeRoots /root/orbit/node_modules/@types \
    --rootDir src/apiserver/src --outDir src/apiserver/build \
    src/apiserver/src/projects/coordinator-contract.spec.ts \
    src/apiserver/src/projects/coordinator-counterexample.spec.ts \
    src/apiserver/src/projects/coordinator-linearization.pg.spec.ts
# exit 0

$ node --test <three compiled specs>                 # no DB URL
# tests 49 · pass 46 · fail 0 · skipped 3 · duration_ms 218.667738

$ node --test --test-name-pattern 'mutation check' <counterexample spec>
# tests 1 · pass 1 · fail 0 · duration_ms 153.807558

$ COORDINATOR_PG_URL=... node --test <three compiled specs>
# tests 49 · pass 46 · fail 3
# all three DB tests: MODULE_NOT_FOUND: pg

$ NODE_PATH=/root/orbit/node_modules COORDINATOR_PG_URL=... node --test <three compiled specs>
# tests 49 · pass 49 · fail 0 · skipped 0 · duration_ms 2100.302643

$ node -e '<duplicate + lifecycle counterexample model>'
# same provider facts: 1 delivery => SYSTEM/BLOCKED/0 notification
# same provider facts: 11 deliveries => USER/AWAITING_HUMAN/1 notification
# blocker reopen => ALREADY_APPLIED, openAfterReappear=false
# same verifier FAIL again => ALREADY_APPLIED, targetStatus=DONE
# children A→B→A => third ALREADY_APPLIED, parentStatus=OPEN
# contract contains both three-step and one-step escalation text

$ node -e '<acceptance closed-set counterexample model>'
# AE6 names none of task.projectId move / verifiesTaskId change / external target ref mutation
# all three leave status=DONE with evidenceDigest != currentDigest
# acceptance:<attempt> appears, but no acceptance_attempt/acceptanceAttempt field is defined

$ NODE_PATH=/root/orbit/node_modules node -e '<real PostgreSQL AE6 lock-upgrade race>'
# writer 1: aborted, code=40P01, message='deadlock detected'
# writer 2: updated

$ NODE_PATH=/root/orbit/node_modules node -e '<real PostgreSQL D6/I11 counterexample>'
# sessionCommitted=true
# linkedAction={type:'NOOP', status:'CLAIMED'}
# i11Satisfied=false
```

运行环境：Linux 6.12.38+deb13-cloud-amd64 x86_64 GNU/Linux；Node v22.22.2；TypeScript 5.9.3；git 2.47.3；PostgreSQL 16.14（一次性 `postgres:16-alpine` 容器，测试后已删除）；工作树 `/root/.orbit/worktrees/01a017d7-a35b-79b2-871c-f98427ba5b4a`；分支 `orbit/02-coordinator-23f84d`。

本复审文档所在验证提交及向 `feat/project` 的合并状态记录在 Orbit 任务评论中。
