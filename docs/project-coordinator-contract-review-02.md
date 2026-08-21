# Project Coordinator 契约与故障模型独立审查（02）

> 审查任务：`02 独立审查 Coordinator 契约与故障模型`（Orbit task `349bQGkoTy7QmNXtyRKaO`）
>
> 被验契约：[`project-coordinator-contract.md`](./project-coordinator-contract.md)
>
> 被验提交：`ef8ea1f54390262fb813c4ca80943707a850539c`
>
> 审查日期：2026-08-19
>
> 审查原则：从 `feat/project` 的提交和代码独立取证；不采用研发会话的主观结论；不修改被验契约或研发代码来消除失败。

## 1. 结论

**FAIL / BLOCKED**。文档的结构自检通过，但反例驱动审查发现 **2 个 P0、6 个 P1** 契约缺口。它们会造成重复 Session、旧版本越过派发权、同一快照无法原子提交、运行状态不唯一、定时恢复路径互相矛盾或过期验收证据放行 `DONE`。因此，在这些问题通过权威契约修订并新增对应反例测试前，03 及后续实现不应把 p01 当作可直接实现的无歧义协议。

通过项不抵消 blocker：七状态、六组件边界、事件作为信号、outbox 原子性、fencing 基本方向、PAC 错误码复用、Base62、父任务聚合、验证退回、旧项目默认关闭等设计均有明确条款；失败集中在并发线性化、冲突提交和状态优先级。

## 2. 严重缺陷清单

| ID | 级别 | 受影响验收 | 结论 |
|---|---|---|---|
| `PC-CX-01` | **P0** | AC2 · AC5 · AC9 | 人工启动与 Coordinator 派发没有共同的 task 级线性化点，可同时创建两条 live Session |
| `PC-CX-02` | **P0** | AC9 · AC11 | 滚动升级时旧 sweep 不认识 `dispatch_authority`，可与新 Coordinator 双重派发 |
| `PC-CX-03` | **P1** | AC3 · AC8 | 同时存在 USER 与非 USER blocker 时，I4 同时要求两个 run state，没有优先级 |
| `PC-CX-04` | **P1** | AC2 · AC3 | 幂等键冲突按“整事务回滚且视为成功”处理，无法同时消费事件和提交其他确定性变化 |
| `PC-CX-05` | **P1** | AC3 · AC4 · AC8 | `AWAITING_HUMAN` 的 null wake、blocker 的定时升级、预算自动恢复与 backstop 查询互相矛盾 |
| `PC-CX-06` | **P1** | AC3 · AC4 · AC8 | `TEST_FAILED(owner=COORDINATOR)` 必须开 turn，但同一节又禁止任务失败自动开 turn |
| `PC-CX-07` | **P1** | AC3 · AC9 | Coordinator turn 的永久幂等键与“60 秒内至多一次”不相容，同代同因无法再次运行 |
| `PC-CX-08` | **P1** | AC12 | `DONE` 硬门只要求“存在全 PASS 记录”，未把记录绑定到当前快照/标准/合并状态 |

### PC-CX-01 — 人工与 Coordinator 并发可重复派发（P0）

**契约证据**：

- §6.1 只要求在 `REPEATABLE READ` 事务中读取快照；§7.4 第 4 条以快照中的 `liveSessionIds` 为空作为前置。
- §8.3 只用 `project_action.idempotency_key` 去重 Coordinator 自己的动作；人工启动不写同一个动作键。
- §12.3 D3 明确人工“开始执行”不受 `dispatch_authority` 限制，却没有规定人工路径与 Coordinator 路径共用的 task 行锁、CAS、advisory lock 或 live-session 唯一约束。
- 当前基线 `Task.sessions` 是一对多，schema 没有“每个 Task 至多一条 PENDING/RUNNING Session”的唯一约束；`TasksService.runWorkspaceOnTask` 是 `findFirst` 后 `create`（`tasks.service.ts:4437-4479`），属于可竞争的 check-then-act。

**最小反例**：

1. Worker C 读到 Task OPEN、无 live Session，生成 `dispatch:<task>:0`。
2. 用户 U 同时点击“开始执行”；人工路径也读到无 live Session。
3. U 插入 Session `S-user`；C 的 runtime fencing token 仍有效，因为人工路径不写 `project_runtime`。
4. C 插入动作 K 和 Session `S-coordinator`；K 全局唯一也不与人工动作冲突。
5. 持久化结果为同一 Task 两条 live Session，违反 AC2/AC9 的“不重复启动”。

**所需修订**：冻结一个由所有派发入口共同使用的原子 primitive；在同一事务中锁定/CAS Task，并以数据库约束或等价 claim 保证同一 Task 的 live 执行互斥。动作账本只能去重“同一动作”，不能替代跨入口互斥。反例测试必须用两个真实事务和 barrier，不得只串行调用两次。

### PC-CX-02 — 混合版本绕过单一派发权（P0）

**契约证据**：

- §12.3 D1 只要求“既有三条 sweep 的候选查询追加 `dispatch_authority = LEGACY`”；该条件只存在于新二进制。
- §12.4 却承诺新旧 apiserver 并存时无重复派发，并只用 fencing token 解释新实例之间的互斥。
- 旧实例既不读取 `dispatch_authority`，也不参与 `project_runtime` lease；因此 fencing token 对旧 sweep 无效。

**最小反例**：

1. 迁移已加列，新实例把 Project 打开并把 Task 投影为 `COORDINATOR`。
2. 滚动窗口中的旧实例仍按旧 SQL 选择该 Task；新实例的 Coordinator 也选择它。
3. 两者从不同去重域创建 Session；若按 PC-CX-01 的当前 check-then-act 交错，可同时成功。

**所需修订**：明确 rollout fence。可选方案包括：在所有旧实例退出前禁止 `coordinatorEnabled=true`；先部署一个仅识别派发权但不启用 Coordinator 的兼容版本，再迁移/启用；或提供旧二进制也会命中的数据库级硬门。必须新增“旧二进制 + 新二进制 + 同一 Task”的真实滚动升级测试。

### PC-CX-03 — 混合 owner blocker 没有唯一 run state（P1）

**契约证据**：

- §4.3 I4 定义 `BLOCKED` 当且仅当存在 open 非 USER blocker，同时定义 `AWAITING_HUMAN` 当且仅当存在 open USER blocker。
- Project 可以同时有多条 blocker；§11.3 的去重范围是 `(project, dedupe_key)`，没有排斥不同 kind/owner 共存。
- §4.2 也同时允许 `EXECUTING → BLOCKED` 和 `EXECUTING → AWAITING_HUMAN`，没有优先级或聚合规则。

**最小反例**：Provider 离线产生 `PROVIDER_UNAVAILABLE(owner=SYSTEM)`，同时一个高风险动作产生 `AWAITING_USER_APPROVAL(owner=USER)`。两个 I4 右侧同时为真，单值 `run_state` 无法同时等于两个状态；不同迭代顺序会得到不同最终值。

**所需修订**：冻结总序或显式聚合函数，例如 `USER blocker > non-USER blocker > executing/other`，并将 I4 改成不会在混合集合上矛盾的谓词。加入 blocker 输入顺序随机化的属性测试，所有排列必须得到同一状态。

### PC-CX-04 — 幂等冲突回滚会留下未消费事件（P1）

**契约证据**：

- §5.4 要求 `consumed_at` 与成功 reconcile 同事务提交；§6.2 要求动作、blocker、decision、event、runtime 全部同一事务。
- §8.3 示例中的 `INSERT project_action` 唯一键冲突会使“整事务回滚”，X2 又要求把冲突视为成功。

**最小反例**：同一 generation/reason 的 `OPEN_COORDINATOR_TURN` 动作 K 已存在；新事件 E 触发相同机械结果。插 K 冲突后整事务回滚，则 E 仍未消费、decision/nextWake/blocker 变化也未提交。消费者会反复取得 E；若在事务外把它直接当成功，则又违反 §6.2 的原子提交。

**所需修订**：冻结冲突语义，例如 `INSERT ... ON CONFLICT DO NOTHING RETURNING` 后读取既有动作，把它作为已应用输入继续同一事务；或先解析已有动作再提交剩余 outcome。必须覆盖“已有动作 + 新事件 + 同 tick 还有 blocker/nextWake 变化”的测试，不能只断言 Session 数量。

### PC-CX-05 — 等待人工、预算和 backstop 的时钟不一致（P1）

**契约证据**：

- §4.1/§10.4 规定 `AWAITING_HUMAN` 的 `nextWakeAt = NULL`，表示不定时叫醒。
- §11.1 又要求 USER blocker 也必须有 `nextCheckAt`，用于 §11.5 的定时升级。
- §9.4 把会随 24h 窗口自动恢复的 `BUDGET_EXHAUSTED` 设为 `owner=USER`；I4 因此把状态设为 `AWAITING_HUMAN`，但没有定时 wake 去自动解除。
- §10.2 的 backstop SQL 没有排除 `AWAITING_HUMAN`；所有 null wake 的等待人工项目都会每 60 秒命中并记 WARN，与“唯一允许 null”及 W2“命中说明漏事件 bug”冲突。

**最小反例**：预算在 T 到期，期间无人写入任何事件。若 backstop 排除等待人工，T 后没有唤醒，blocker 永不自动解除；若不排除，则等待审批的正常项目每分钟被当成漏事件故障唤醒。

**所需修订**：区分“可由时间自动恢复”和“只能由用户事件恢复”。预算/退避类应有非 USER owner 或允许有明确 timer wake；纯人工等待可以 null wake，但升级若仍要求定时器，也必须定义单独且不产生 backstop WARN 的路径。冻结 backstop 对各 run state 的精确谓词。

### PC-CX-06 — 测试失败是否开 Coordinator Turn 自相矛盾（P1）

**契约证据**：

- §11.2 把 `TEST_FAILED` 默认 owner 定为 `COORDINATOR`。
- §7.2 条件 3 规定任何 `owner=COORDINATOR` blocker 都触发 `OPEN_COORDINATOR_TURN`。
- 同一 §7.2 随后明确“一个任务失败不会自动开 turn”，应走既有退避与重试；§9.5 Q1 只在达到上限后转 USER。

**最小反例**：第一次测试失败，`failureCount=1 < MAX`。按 blocker owner 规则必须开 turn；按失败重试规则不得开 turn。不存在唯一确定动作。

**所需修订**：明确 `TEST_FAILED` 何时创建、重试期内 owner/state 是什么、达到上限后如何转换；或给语义 turn 触发条件增加排除。表驱动测试必须逐一覆盖首次失败、退避期、阈值失败和归因不明。

### PC-CX-07 — Turn 幂等键永久抑制合法重试（P1）

**契约证据**：

- §7.3/§8.2 的 key 是 `turn:<generation>:<reasonDigest>`，同 generation 同原因永久唯一。
- §10.4 只要求同 generation 同原因“60 秒内至多一次”，语义上允许 60 秒后再次运行。
- generation 只在 Session 轮换时增加，不在 turn 完成时增加。

**最小反例**：PLANNING/图空触发 turn K；turn 成功结束但没有改变图（或只记录需要稍后重看）。60 秒后快照仍需相同原因的语义判断，K 永久冲突，Session 又未轮换，因而无法再开 turn。

**所需修订**：冻结可前进的 attempt/window epoch，或规定首次 turn 未改变事实时必须转成具体 blocker 且直到 blocker 条件变化前不再开 turn。限频与永久幂等必须是两个不同概念，并分别测试。

### PC-CX-08 — 过期验收记录可放行 DONE（P1）

**契约证据**：

- §13.4 只要求服务端在写 DONE 时“存在一条全 PASS 的验收记录”。记录位于自由结构的 `project_decision.detail`。
- 没有要求验收记录绑定当前 `snapshotHash`、acceptanceCriteria 修订、Task/verification 集合、目标分支内容或合并证据摘要，也没有失效规则。

**最小反例**：快照 H1 全 PASS；随后用户修改 acceptance criteria、重开 Task 或目标分支变化形成 H2。旧 H1 记录仍存在，服务端按“exists PASS”可放行 H2 的 DONE。

**所需修订**：定义结构化 acceptance evidence schema 和 freshness key；DONE CAS 必须验证记录对应当前可验收快照/标准版本/目标分支内容。新增“PASS 后任一相关事实变化，旧证据不可复用”的参数化测试。

## 3. 反例验证矩阵

“权威状态”列写的是契约意图；若当前文档无法唯一给出，明确标为 blocker。动作键中的 `<p>/<t>` 等代表内部 UUID。

| 场景 | 反例/注入点 | 预期权威持久化状态 | 确定性动作与幂等键 | 责任人与恢复路径 | 审查 |
|---|---|---|---|---|---|
| 重复事件 | 同一 dedupe 原因在已消费后再次到达；或提交后重投 | 旧 action 仍一行，新事件被消费，decision/nextWake 正常前进 | 复用原 key；冲突必须在同一 outcome 内作为 APPLIED 处理 | SYSTEM；无需人工 | **FAIL `PC-CX-04`** |
| 乱序事件 | 先送 `session.ended` 再送较早 `session.started` | 只按最新一致快照计算，与顺序到达相同 | 当前快照决定 action key，不读 payload | SYSTEM；backstop 只补及时性 | PASS（E1 足够明确） |
| 业务事务回滚 | 在 Task 写与 outbox 写之后强制 rollback | Task/event 均不存在 | 无 action key | SYSTEM；无需恢复 | PASS（N4） |
| 双 worker 竞争 | A lease 过期，B 获取新 token，A 晚提交 | 只有 B 的 decision/action/runtime 变化提交 | 同 action key；提交先 CAS fencing token | SYSTEM；A 返回，按新事件重看 | PASS，但实现测试须含真实双事务 |
| Coordinator Session 结束 | turn 中途 session.failed | Agent 不变，generation+1，新 Session 落默认协调 Workspace | `coord-session:<g+1>`，随后合法 turn key | SYSTEM；workspace 不可用时 USER 重绑 | PASS（§7.5） |
| Runner 离线 | live task Session 所在 Runner 心跳超时 | reaper 后 Session FAILED；对应 blocker/退避可查 | blocker key `blocker:<kind>:<runner/task>`；重派 attempt 随 failureCount | SYSTEM；online/capability 恢复后重算清除 | PASS（需后续归因表驱动测试） |
| Provider 不可用 | pin provider down；分别有/无显式 fallback、三策略 | 无 fallback 为 `PROVIDER_UNAVAILABLE`；有 fallback 依策略 approval/dispatch 并留 resolution | blocker key 或 dispatch key；不得另造 fallback action | SYSTEM/USER（审批）；恢复或显式 fallback | 条件分支可实现，后续测试必须逐格覆盖 |
| 无匹配 Runner | 候选离线 vs 能力缺失分别注入 | `NO_MATCHING_RUNNER` 或 `RUNTIME_REQUIREMENT_UNMET`，detail 列出差异 | `blocker:<kind>:<subject>` | SYSTEM 或 USER；条件恢复后自动 clear | PASS（分类边界需测试） |
| 合并冲突 | 同一 merge conflict 多次上报，首次 turn 未解决 | 单一 `MERGE_CONFLICT(owner=COORDINATOR)` blocker | blocker key 去重；turn key 需可在合法间隔后重试 | COORDINATOR；解决后重算 clear | **FAIL `PC-CX-07`** |
| 测试失败 | 首次失败、退避中、达到 MAX 分别注入 | 必须唯一决定是 EXECUTING/BLOCKED/AWAITING_HUMAN | retry dispatch key 随 failureCount；是否开 turn 当前冲突 | COORDINATOR/USER 未唯一 | **FAIL `PC-CX-06`** |
| 预算耗尽 | 24h 最老记录在 T 到期，无其他事件 | T 前 blocker；T 后自动 clear 并继续 | blocker key 去重；SCHEDULE_WAKE 到 T | 文档写 USER，但恢复是 SYSTEM timer | **FAIL `PC-CX-05`** |
| 等待用户 | approval/input pending，用户长期不回应后再回应 | `AWAITING_HUMAN` + USER blocker；回应后 PLANNING | `approval:<targetKey>`；用户事件唤醒 | USER；回复/审批恢复 | 基本路径 PASS；定时升级与 backstop **FAIL `PC-CX-05`** |
| 混合版本部署 | 旧 sweep 与新 Coordinator 同时看到同一 ready Task | 最多一条 live Session；旧实例不得越权 | 新 dispatch key 不能约束旧入口 | SYSTEM rollout；须先建立兼容 fence | **FAIL `PC-CX-02`** |
| 人工同时操作 | 人工 start 与 reconcile 在 barrier 后同时 commit | 人工或 Coordinator 恰好一个成功，另一个返回已有 run/SUPERSEDED | 所有入口共享 task execution claim；Coordinator key 仍留审计 | USER/SYSTEM；无需人工清理重复 run | **FAIL `PC-CX-01`** |
| 混合 blocker | 同时插 USER approval 与 SYSTEM provider blocker，交换输入顺序 | 任意排列得到同一单值 run state | blocker key 各自去重；状态由总序聚合 | owner 各自保留；按优先级恢复 | **FAIL `PC-CX-03`** |
| 验收后事实变化 | PASS 后修改标准/任务/目标分支，再请求 DONE | 旧 PASS 失效，Project 保持 OPEN | acceptance key 绑定新鲜快照/版本 | COORDINATOR/USER；重新验收 | **FAIL `PC-CX-08`** |

## 4. 项目级 12 条验收覆盖

| AC | 审查结果 | 证据/缺口 |
|---|---|---|
| AC1 | 条款覆盖 | 稳定 Agent、Session generation、协调 Workspace 与 Base62 均已映射；后续须实测轮换事务 |
| AC2 | **BLOCKED** | `PC-CX-01`、`PC-CX-04` |
| AC3 | **BLOCKED** | `PC-CX-03`、`PC-CX-05`、`PC-CX-07` |
| AC4 | **BLOCKED** | `PC-CX-05`、`PC-CX-06` |
| AC5 | **BLOCKED** | `PC-CX-01`：一致读不等于对并发业务写的线性化提交 |
| AC6 | 条款覆盖 | PASS/FAIL/INCONCLUSIVE 的机械结果、原生退回和下游阻断已定义 |
| AC7 | 条款覆盖 | 聚合重算、重开回退、空父节点和多层规则已定义 |
| AC8 | **BLOCKED** | `PC-CX-03`、`PC-CX-05`、`PC-CX-06` |
| AC9 | **BLOCKED** | `PC-CX-01`、`PC-CX-02`、`PC-CX-07` |
| AC10 | 条款覆盖 | 观测面字段与测试单元已映射；尚非实现验收 |
| AC11 | **BLOCKED** | `PC-CX-02`：数据默认安全，但滚动窗口没有启用 fence |
| AC12 | **BLOCKED** | `PC-CX-08`：验收证据没有 freshness 约束 |

## 5. 后续自动化测试清单

以下清单是后续单元的最低反例集；修订契约时应把每条分配到明确 spec，而不是只保留在文档中。

- [ ] `dispatch-linearization.spec.ts`：两个数据库事务以 barrier 同时执行 manual start / Coordinator dispatch，100 次随机提交顺序均只有一条 live Session（`PC-CX-01`）。
- [ ] `mixed-version-dispatch.spec.ts`：运行旧 sweep 查询与新 Coordinator，证明 rollout fence 使旧路径在启用前退出（`PC-CX-02`）。
- [ ] `run-state-precedence.property.spec.ts`：对同一 blocker multiset 的全部排列求值，结果唯一；覆盖 USER+SYSTEM、USER+COORDINATOR、三 owner 共存（`PC-CX-03`）。
- [ ] `action-conflict-commit.spec.ts`：预置 action K，再提交包含 K、新 event、blocker clear 与 nextWake 更新的 outcome；event 必须 consumed，其他变化必须提交（`PC-CX-04`）。
- [ ] `wake-policy.spec.ts`：budget boundary 自动唤醒；纯人工等待不命中 backstop WARN；升级只通知一次（`PC-CX-05`）。
- [ ] `failure-policy-table.spec.ts`：首次 TEST_FAILED、退避、阈值、未知归因分别得到唯一 action/state/owner（`PC-CX-06`）。
- [ ] `coordinator-turn-retry.spec.ts`：同 generation 同 reason 在 59s 被抑制，在合法时间或事实版本变化后可再次运行（`PC-CX-07`）。
- [ ] `acceptance-freshness.spec.ts`：PASS 后逐一改变 acceptance criteria、Task verdict、merge content、target branch；旧证据均不能放行 DONE（`PC-CX-08`）。
- [ ] `duplicate-and-out-of-order-events.property.spec.ts`：固定 seed 生成事件排列/重复，最终状态、动作集合和 blocker 集合相同。
- [ ] `outbox-rollback.integration.spec.ts`：每个权威 Task/Session/Merge/User 写路径在 commit 前注入异常，业务行与 outbox 同生共死。
- [ ] `lease-takeover.integration.spec.ts`：旧 token 在 runtime、action、blocker、decision、event 任一写入前均使整 outcome 回滚。
- [ ] `session-rotation.integration.spec.ts`：Session ended/deleted/failed、Workspace offline/soft-delete、并发 rotate 全覆盖，Agent 不变且 generation 恰好 +1。
- [ ] `provider-runner-matrix.spec.ts`：provider pin/fallback/policy 与 runner offline/capability mismatch 的笛卡尔积，拒绝码、owner、requiredAction、nextCheckAt 唯一。

## 6. 独立执行证据

### 命令与关键输出

```text
$ git rev-parse HEAD
ef8ea1f54390262fb813c4ca80943707a850539c

$ git rev-parse feat/project
ef8ea1f54390262fb813c4ca80943707a850539c

$ git diff --check ef8ea1f5^ ef8ea1f5
# exit 0, no output

$ /root/orbit/node_modules/.bin/tsc --target ES2022 --module commonjs \
    --moduleResolution node --esModuleInterop --skipLibCheck --types node \
    --typeRoots /root/orbit/node_modules/@types --rootDir src/apiserver/src \
    --outDir src/apiserver/build \
    src/apiserver/src/projects/coordinator-contract.spec.ts
$ node --test src/apiserver/build/projects/coordinator-contract.spec.js
# tests 8
# pass 8
# fail 0
# duration_ms 194.837569
```

说明：工作树没有自己的 `node_modules`，因此没有执行会改写共享 Prisma client 的 `prisma generate`。只借用 `/root/orbit/node_modules` 中的 TypeScript 5.9.3 和 Node 类型，把单个纯文档自检 spec 编译到本工作树忽略的 `src/apiserver/build`。

### 运行环境

```text
Linux vmi3129740 6.12.38+deb13-cloud-amd64 x86_64
Node v22.22.2
npm 10.9.7
TypeScript 5.9.3
git 2.47.3
Docker 29.5.2
worktree /root/.orbit/worktrees/01a017d7-a35b-79b2-871c-f98427ba5b4a
branch orbit/02-coordinator-23f84d
```

验证提交 SHA 与向 `feat/project` 的合并结果记录在 Orbit 任务评论中；本文件不自引用一个会因记录自身 SHA 而变化的 commit。
