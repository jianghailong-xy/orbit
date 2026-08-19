# Project Coordinator 控制环契约 v1

> **状态**：已冻结（frozen）。本文件是 `Project Coordinator 持续推进控制环` 的**单一权威契约**。
> 03–23 阶段的每个实现与验证任务都必须与本文件一致；实现与本文件冲突时，先改本文件并说明理由，再改代码。
>
> **适用分支**：`feat/project`（`main` 里没有 `Project`）。
> **代码基线**：`c088ee04 docs(project): freeze the Project/Agent domain contract`。
> **前置契约**：[`docs/project-agent-contract.md`](./project-agent-contract.md)（下称 **PAC**）。本文**不重新定义** PAC 已冻结的任何术语、字段、解析链或错误码；凡引用一律写作 `PAC §n`。
> 两份契约的分工是一句话：**PAC 冻结"一件事怎么变成一次运行"，本文冻结"下一件事是哪一件、由谁在什么时候决定"。**
> **本文只描述目标状态与迁移路径**；已有实现的现状写在 §12 兼容矩阵里。

---

## 0. 本文要解决的问题

今天的 Project 是一个**被动的 Session 引用**：`project.coordinatorSessionId` 指向一段对话，而 schema 的注释把它写得很明白 —— "A pointer, never a dependency, exactly as `TaskList.ownerSessionId` is: nothing on the dispatch path reads it"。于是一个 OPEN 的 Project 可以在没有任何人发现的情况下**静默空转**：没有任务在跑，没有阻塞被记录，没有下一次检查被安排，控制面上它和一个正在飞速推进的项目长得一模一样。

本文把它升级成一个**事件驱动、可恢复、可审计的控制环**，并且只用两件事换：一组执行基础设施表，和一小组落在 `project` / `task` 上的业务字段。**不新增任何业务实体**（§2.3）。

---

## 1. 分层与边界

### 1.1 继承自 PAC 的分层

PAC §1 的两层分法与 R1/R2/R3 三条规则**原样生效**，本文的所有新增物一律落在**执行基础设施**层，只有 §2.2 列出的少数字段落在业务层。

### 1.2 六个组件的边界（冻结）

控制环由六个组件组成。**每个组件只允许知道下表"输入"列里的东西**；越界读取是审查项，02 必须逐条检查。

| 组件 | 是什么 | 输入 | 输出 | **绝不做** |
|---|---|---|---|---|
| **Coordinator Agent** | PAC §2 定义的 `project_member.role = COORDINATOR`。一个**稳定身份**，跨 Session 轮换不变 | Project 快照（§6.1）、项目 goal/acceptanceCriteria/instructions | 语义判断：建/改任务、排依赖、指派、提议项目验收 | 不持有租约、不写 `project_runtime`、不写审计行、不自己决定"能不能跑"（那是策略，§9） |
| **Coordinator Session** | 一次**可轮换、可恢复**的协调运行记录（既有 `project.coordinatorSessionId`） | 由 orchestration service 唤醒 | 一次 turn 的产物 | 不是身份。它结束、失败、被删除都**不得**让项目停止推进（§7.4） |
| **默认协调 Workspace** | 既有 `project.coordinatorWorkspaceId`：**协调对话跑在哪** | 用户设置 | 轮换新 Coordinator Session 的落点 | **不是** PAC §3.3 的 Default Workspace（`project_workspace.is_default`，"这个项目的活默认在哪跑"）。PAC W4 冻结了这两者不得合并，本文原样继承 |
| **Project orchestration service** | 确定性的、无 LLM 的控制环本体 | `project_event`、`project_runtime`、Project 快照 | 租约、reconcile、机械动作（§7.3）、blocker、审计行、`nextWakeAt` | **不做语义判断**。它永远不会自己发明一个任务、改一句验收标准，或者判断"这个失败该不该重试到底" |
| **Task dispatcher** | 把一个**已授权**的 Task 变成一次 Session | `(taskId, actionId, fencingToken)` | 一条 Session（走 PAC §5 的 `resolveExecutionContext`） | 不判断该不该派（授权在 §9）、不做 Provider 降级（PAC §7.4）、不改派机器 |
| **Runner scheduler** | PAC §7.3 的 WHERE 链 | 需求集 + 候选 Workspace 集 | 一台 Runner | 只做能力匹配。**不读 Agent、不读 Project 策略、不做负载均衡**（PAC C6） |

**B1**：这六个组件之间只有一条数据流方向：`事件 → orchestration service → (dispatcher | coordinator turn)`。dispatcher 和 coordinator turn **绝不互相调用**，也绝不回头写 `project_runtime` —— 它们的结果通过**新事件**回到环里（§5）。

**B2**：**Coordinator Agent 与 orchestration service 的分工是不可协商的**。项目 instructions 已经写死："Project orchestration service 负责可靠唤醒、租约、幂等与恢复；Coordinator Agent 负责语义判断"。把语义判断塞进 orchestrator（例如"失败三次就自动改用别的 Provider"）等于把一个不可审计的产品决策焊进调度器；把租约塞进 Agent（例如让 LLM 决定要不要接管）等于把正确性押在提示词上。

**B3**：**不得把"所有任务 autoRun"当作 Coordinator 的替代方案**（项目 instructions 原文）。`task.autoRunWhenReady` 是 legacy 派发路径的开关，v1 后它与 Coordinator 的关系由 §12.3 的**单一派发权**规则唯一确定。

---

## 2. 业务字段 vs 执行基础设施

这是本项目最容易越界的一处，因此在最前面冻结判据。

### 2.1 判据

> **一个字段属于业务层，当且仅当：它记录的是一个人做出的决定，而且删掉整个执行基础设施之后它仍然有意义。**

"这个项目最多同时跑 3 个任务" 是人的决定 —— 业务。
"这个项目的 reconcile 租约 47 秒后过期" 是控制环的内部状态 —— 基础设施。

### 2.2 业务层新增（**只有这些**）

全部落在既有的 `project` / `task` 两张表上，**不新建业务表**。

| 字段 | 表 | 类型 | 为什么是业务字段 |
|---|---|---|---|
| `coordinatorEnabled` | `project` | `Boolean @default(false)` | "我要不要让它自己动" —— 用户的最终控制权（项目 instructions） |
| `automationPolicy` | `project` | `ProjectAutomationPolicy @default(GUARDED_AUTO)` | manual / guarded-auto / auto（§9）。人的授权级别 |
| `maxConcurrentTasks` | `project` | `Int @default(3)` | 并发预算，人的决定 |
| `sessionBudgetPerDay` | `project` | `Int?` | 滚动 24h 内 Coordinator 可发起的 Session 上限。null = 不限（§9.4） |
| `completionPolicy` | `task` | `TaskCompletionPolicy @default(MANUAL)` | 父任务/阶段怎么算完成（AC7）。"子任务全 DONE 就算这一阶段完成" 是人的定义，不是调度细节 |

`coordinatorEnabled` 与 `automationPolicy` 是**两个字段而不是一个四值枚举**：关掉自动推进和"自动到什么程度"是两个会被分别修改的决定，合成一列会让"临时停一下"覆盖掉用户之前选的级别。

**Coordinator Agent 不新增列**：它就是 PAC §3.2 的 `project_member.role = COORDINATOR`，由 PAC T2 的 partial unique index 保证每个 Project 至多一个。**任何在 `project` 上新加 `coordinator_agent_id` 的实现都是对 PAC W3（同一事实只能有一处落库）的违反。**

### 2.3 禁止新增业务实体（硬约束）

**业务层实体恒为 `Project` 与 `Task` 两个，v1 结束时仍然是两个。**

- 阶段（phase）由**父 Task + `completionPolicy`** 表达，不建 `Phase` 表。
- 计划（plan）由 **Task 树**表达，不建 `Plan` 表。
- 里程碑、验收批次、迭代同上。
- 判据（可审查）：一张新表如果带有 `title` / `goal` / `acceptance_criteria`，或者会被 `task.*_id` 当作"这件事属于谁"来引用，它就是一个业务实体，**拒绝**。

### 2.4 执行基础设施新增（**只有这些**）

五张新表，全部 `onDelete: Cascade` 挂在 `project` 下 —— 它们是控制环的内脏，项目没了就没有意义。

| 表 | 职责 | 一句话判据 |
|---|---|---|
| `project_runtime` | 1:1。运行状态机、租约、`nextWakeAt`、generation | 删掉它，项目仍是一个完整的项目（PAC R1） |
| `project_event` | 事务 outbox：谁把这个项目弄脏了 | 同上 |
| `project_action` | 幂等动作账本：exactly-once-effect 的唯一依据 | 同上 |
| `project_blocker` | 结构化阻塞 | 同上 |
| `project_decision` | 决策审计 | 同上 |

以及三列：`task.dispatchAuthority`（§12.3）、`session.projectActionId`（§8.3）、`project_runtime.*`。

**为什么 `runState` 落在 `project_runtime` 而不是 `project` 上**：一是分层 —— `project.status`（OPEN/DONE/CANCELLED）是业务生命周期，`runState` 是控制环状态，混在一张表上会让下一个人很自然地写出 `WHERE status = 'EXECUTING'`；二是写放大 —— `runState`/`nextWakeAt`/`leaseHeartbeatAt` 是秒级更新的热列，而 `project` 行被列表、任务页、SSE 全量读，把心跳写进它等于让每次心跳都使一份被广泛缓存的行失效。

---

## 3. 词汇表

本文新增术语，每个只在此定义一次。PAC §2 的术语一律沿用，不重述。

| 术语 | 权威定义 | 落库位置 |
|---|---|---|
| **控制环（control loop）** | `事件 → reconcile → 动作 → 新事件` 的闭环。本文的全部内容 | —— |
| **Run State** | Project 的**运行**状态（§4），与业务 `project.status` 正交 | `project_runtime.run_state` |
| **Reconcile** | 一次"读一致快照 → 得出应有状态 → 提交动作"的完整执行。**幂等**：同一快照重复 reconcile 不产生额外副作用 | `project_decision` 一行 |
| **Wake（唤醒）** | 让某个 Project 进入 reconcile 队列的动作。来源只有三种：事件、`nextWakeAt` 到期、backstop 兜底扫描 | `project_runtime.wake_requested_at` |
| **Reconcile Lease** | 同一 Project 同一时刻只有一个持有者可以提交 reconcile 结果的租约 | `project_runtime.lease_*` |
| **Fencing Token** | 每次成功获取租约 +1 的单调整数。**所有写入都带它**，旧持有者的提交因此必然失败 | `project_runtime.fencing_token` |
| **Action（动作）** | 控制环对外界的一次副作用。**封闭集合**（§7.3），每个都有幂等键 | `project_action` 一行 |
| **Idempotency Key** | 一个动作的身份。同一个键提交两次，副作用只发生一次（§8） | `project_action.idempotency_key` |
| **Blocker** | 一条**结构化**的"为什么没往前走"：kind + 责任人 + 所需动作 + 下次检查时间 | `project_blocker` 一行 |
| **Decision（决策）** | 一次 reconcile 的完整记录：输入快照、策略、判断、动作、幂等键 | `project_decision` 一行 |
| **Coordinator Turn** | 由控制环发起的、在 Coordinator Session 里的一次 Agent 运行 | 一条 run turn |
| **Coordinator Generation** | Coordinator Session 的轮换代数。轮换 +1，**Coordinator Agent 不变** | `project_runtime.coordinator_generation` |
| **Liveness SLO** | §10 定义的活性约束：OPEN 且不等待人工的 Project 必须在规定时间内处于四种可证明状态之一 | 由 §10.3 的查询判定 |
| **Dispatch Authority** | 一个 Task 由谁派发：legacy 三条 sweep，还是 Coordinator。**投影在 task 行上**（§12.3） | `task.dispatch_authority` |

---

## 4. Project 运行状态机

### 4.1 状态（冻结，7 个）

`project_runtime.run_state`，枚举 `ProjectRunState`：

| 状态 | 含义 | 不变量 |
|---|---|---|
| `PLANNING` | 工作图里**没有**可派发的下一步，也没有阻塞。控制环欠一次语义判断 | 必有 `nextWakeAt` 或在飞 coordinator turn |
| `EXECUTING` | 至少一个本项目的 Session 在飞，或本 tick 刚派出去 | 至少一条 `project_action(type=DISPATCH_TASK)` 对应的 Session 处于 LIVE |
| `AWAITING_VERIFICATION` | 实现任务已全部收敛，验证任务未出 verdict | 至少一条 `verifiesTaskId` 非空的 Task 未 DONE |
| `BLOCKED` | 有明确的、**机器可能自行恢复**的阻塞（Provider 挂了、无匹配 Runner、合并冲突、预算耗尽） | ≥1 条 open blocker，且 `owner ∈ {SYSTEM, COORDINATOR}`，且每条都有 `nextCheckAt` |
| `AWAITING_HUMAN` | 需要人：审批、决策、凭据、manual 策略下的每一步 | ≥1 条 open blocker 且 `owner = USER`；**唯一允许 `nextWakeAt` 为 null 的非终态** |
| `ACCEPTANCE` | 正在执行项目级验收（AC12） | 存在一条 `project_action(type=RUN_PROJECT_ACCEPTANCE)` 未收敛 |
| `SETTLED` | 终态。与 `project.status ∈ {DONE, CANCELLED}` 一一对应 | `nextWakeAt IS NULL`，租约释放，不再消费事件 |

**为什么是 7 个而不是项目目标里列的 6 个**：目标句列举了"执行、待验证、明确阻塞、等待人工、项目验收或终态"。`PLANNING` 是第 7 个，且是**必须命名**的那一个 —— 它正是"静默空转"发生的地方：没有任务在跑、也没有任何东西阻塞。如果把它折进 `EXECUTING`，那么"三个 Session 在飞"和"什么都没有、协调器 30 秒后才想起来"在控制面上就是同一个词，AC3 的活性约束**无法被陈述，更无法被测**。

### 4.2 合法转移

```
                        ┌───────────────────────────────────────────┐
                        │                                           │
   (project created)    ▼                                           │
        │          ┌──────────┐   有可派发任务    ┌───────────┐      │
        └─────────▶│ PLANNING │──────────────────▶│ EXECUTING │      │
                   └──────────┘                   └───────────┘      │
                     ▲   │  ▲                       │   │   │        │
       图空/需重规划   │   │  └───────────────────────┘   │   │        │
                     │   │        全部收敛,无验证任务     │   │        │
                     │   │                              │   │        │
                     │   │ 阻塞              验证任务在飞 │   │ 需要人  │
                     │   ▼                              ▼   ▼        │
                     │ ┌─────────┐   条件消失   ┌──────────────────┐  │
                     └─│ BLOCKED │◀────────────▶│AWAITING_VERIFIC.│──┘
                       └─────────┘              └──────────────────┘
                          │  ▲                        │
                    需要人 │  │ 人已答复                │ 全部 PASS
                          ▼  │                        ▼
                     ┌─────────────────┐        ┌────────────┐   PASS   ┌─────────┐
                     │ AWAITING_HUMAN  │───────▶│ ACCEPTANCE │─────────▶│ SETTLED │
                     └─────────────────┘        └────────────┘          └─────────┘
                                                      │ FAIL                 ▲
                                                      └──────────────────────┘
                                                        回 PLANNING / BLOCKED   │
                            (用户 CANCEL / 用户 DONE 且验收 PASS) ────────────────┘
```

转移表（**这是唯一的合法转移集合，未列出的组合一律拒绝并记 `ILLEGAL_TRANSITION` 审计行**）：

| From | To | 触发条件 |
|---|---|---|
| `PLANNING` | `EXECUTING` | 至少一个 Task 通过 §7.2 的可派发判定，且策略授权（§9） |
| `PLANNING` | `BLOCKED` | 没有可派发任务，且原因落在 §11.2 的 blocker kind 内 |
| `PLANNING` | `AWAITING_HUMAN` | 需要审批/输入；或 `automationPolicy = MANUAL` 且存在一个待批准提议 |
| `PLANNING` | `AWAITING_VERIFICATION` | 无可派发实现任务，但有未出 verdict 的验证任务 |
| `PLANNING` | `ACCEPTANCE` | 全部 Task 收敛（DONE/CANCELLED）且验证全 PASS |
| `EXECUTING` | `PLANNING` | 在飞 Session 归零，且仍有未收敛 Task |
| `EXECUTING` | `BLOCKED` | 下一步被阻塞。**有 Session 在飞时也成立** —— 被挡住的是下一步，不是当前这一步 |
| `EXECUTING` | `AWAITING_HUMAN` | 同上，且阻塞的 `owner = USER` |
| `EXECUTING` | `AWAITING_VERIFICATION` | 在飞归零，未收敛的只剩验证任务 |
| `BLOCKED` | `PLANNING` | 全部 open blocker 的条件消失（自动解除，§11.4） |
| `BLOCKED` | `AWAITING_HUMAN` | blocker 升级：`owner` 变为 `USER`（§11.5） |
| `AWAITING_HUMAN` | `PLANNING` | 人做出了答复（审批、改策略、补凭据、手动触发） |
| `AWAITING_VERIFICATION` | `PLANNING` | 出现 FAIL/INCONCLUSIVE verdict，产生了新工作（§13.2） |
| `AWAITING_VERIFICATION` | `ACCEPTANCE` | 全部验证 PASS 且无未收敛 Task |
| `ACCEPTANCE` | `SETTLED` | 项目级验收全 PASS **且** `project.status` 被置为 DONE（§13.4） |
| `ACCEPTANCE` | `PLANNING` | 验收 FAIL 且产生了新工作 |
| `ACCEPTANCE` | `BLOCKED` | 验收 FAIL 且产生了新阻塞 |
| 任意非终态 | `SETTLED` | 用户把 `project.status` 置为 `CANCELLED` 或 `DONE`（后者须满足 §13.4 的门） |
| `SETTLED` | `PLANNING` | 用户把 `project.status` 改回 `OPEN`（重开项目） |

### 4.3 全局不变量

02 的审查与 09/10 的测试都以这一节为准。

- **I1（分层）**：`project.status` 只由**人**或 §13.4 的验收动作写；`run_state` 只由 reconcile 写。任何一处代码同时写这两列即为缺陷。
- **I2（唯一性）**：每个 Project 至多一个 Coordinator Agent（PAC T2）、至多一条**未结束**的 Coordinator Session（`project.coordinatorSessionId @unique`）、至多一个有效租约持有者（§8.1）。
- **I3（因果）**：`run_state` 的每一次变化都恰好来自一条已提交的 `project_decision`。没有审计行的状态变化是缺陷。
- **I4（阻塞一致）**：`run_state = BLOCKED` ⟺ 存在 open blocker 且其 `owner ≠ USER`；`run_state = AWAITING_HUMAN` ⟺ 存在 `owner = USER` 的 open blocker。两个方向都要测。
- **I5（不静默空转）**：`project.status = OPEN ∧ coordinatorEnabled ∧ run_state ∉ {AWAITING_HUMAN, SETTLED}` ⟹ `project_runtime.next_wake_at IS NOT NULL`。这是 AC3 的**可查询形式**（§10.3）。
- **I6（旧项目静默）**：迁移生成的 `project_runtime` 一律 `run_state = PLANNING`、`coordinatorEnabled = false`、`next_wake_at = NULL`，**不消费事件、不 reconcile**（§12.1）。
- **I7（无越权）**：控制环发起的任何动作，其授权判定与同一动作由用户手动发起时**完全相同**（PAC §8.2 + §9.3）。Coordinator 不是一个更高的权限等级。

---

## 5. 事件

### 5.1 最重要的一条决定：**事件是信号，不是事实**

**E1（冻结）**：`project_event` 只承担一件事 —— **把某个 Project 标记为"需要重新看一眼"**。reconcile **永远不从事件负载里读取业务状态**，而是重新读一份一致快照（§6）。

这一条决定掉了本项目一半的难题：

- **重复投递无害**：同一事件投递十次 = 十次"看一眼"，快照相同则决策相同，幂等键让副作用只发生一次。
- **乱序无害**：事件之间没有偏序要求，因为没有一个事件的负载会被信任。
- **丢一条事件只损失及时性，不损失正确性**：backstop 扫描（§10.2）会兜住。

代价是每次 reconcile 多一次快照读。这是**刻意用一次索引读换掉整个乱序/重复语义**，而不是性能疏忽。

**E2**：负载 `payload` 只用于三件事：审计展示、blocker 的 `detail`、以及 §5.4 的合并去重。**任何 `if (event.payload.status === ...)` 形式的分支都是对 E1 的违反**，02 的审查项。

### 5.2 事件信封（冻结）

```jsonc
{
  "v": 1,
  "id": "<uuid>",                       // 出站编 base62
  "projectId": "<uuid>",
  "kind": "task.status_changed",        // §5.3 的封闭集合
  "occurredAt": "2026-08-19T01:00:00.000Z",
  "source": { "type": "TASK", "id": "<uuid>" },   // TASK|SESSION|RUNNER|PROVIDER|MERGE|USER|TIMER
  "dedupeKey": "task.status_changed:<taskId>",    // §5.4
  "payload": { }                        // 仅审计/展示，见 E2
}
```

- **`v` 必须写，读方必须容忍未知版本**：未知 `v` 或未知 `kind` 的事件**照常标脏并消费掉**，不报错、不阻塞队列（§12.4 混合版本）。这一点与 PAC §7.5 对 `resolution.v` 的要求同型。
- 出站（API/CLI/Web）一律 base62；`eventId` / `projectId` / `sourceId` 全部进 `PUBLIC_ID_FIELDS`（PAC §10 / B1）。

### 5.3 事件分类（封闭集合）

**按来源分七类**，每一类的产生点必须与其业务写入**同一事务**（AC2）。

| 类 | kind | 产生点 | 单元 |
|---|---|---|---|
| **task** | `task.created` · `task.updated` · `task.status_changed` · `task.reparented` · `task.dependency_changed` · `task.deleted` | `TasksService` 的每个权威写路径（含 batch-create / batch-assign / batch-execute） | 06 |
| **session** | `session.started` · `session.ended` · `session.failed` · `session.awaiting_input` · `session.approval_pending` | Session 生命周期写入点、runner 回报 | 06 |
| **merge** | `merge.succeeded` · `merge.conflict` | worktree merge 回报 | 06 |
| **user** | `user.policy_changed` · `user.approval_resolved` · `user.project_edited` · `user.manual_trigger` | 用户接口 | 06 |
| **runner** | `runner.online` · `runner.offline` · `runner.capabilities_changed` | 心跳与 reaper | 07 |
| **provider** | `provider.unavailable` · `provider.restored` · `provider.quota_exhausted` | Provider 校验/配额路径 | 07 |
| **timer** | `timer.wake_due` · `timer.lease_expired` · `timer.backstop` | orchestration service 自身 | 09 |

**扇出规则（冻结）**：

- **N1**：`task.*` / `session.*` / `merge.*` 事件的 `projectId` 由**被写的那一行**决定；`task.projectId IS NULL` 时**不产生事件**（legacy 路径完全不受影响，PAC §11.1）。
- **N2**：`runner.*` / `provider.*` 是**多播**：扇出到"当前把该 Runner/Provider 用作候选或 pin 的项目"。扇出必须是**有界查询**（按 `project_workspace` → `workspace.runner_id` 反查），并且**只扇给 `coordinatorEnabled = true` 的项目** —— 一台机器掉线不得唤醒一万个不相干的项目。
- **N3**：批量操作（batch-create N 条任务）**只产生一条** `task.created` 事件，`dedupeKey` 取 batchId。契约允许的事件集合是"每个受影响 Project 每类每事务至多一条"，不是"每行一条"。
- **N4**：事务回滚时事件必须一起回滚（同一事务写入 outbox 表，这是选 outbox 而不是消息队列的全部理由）。**不允许孤儿事件**，06 的契约测试逐路径覆盖。

### 5.4 去重与投递

- `project_event` 唯一约束：`@@unique([projectId, dedupeKey, consumedAt])` 表达不了"只在未消费时唯一"，因此用 **partial unique index**：`CREATE UNIQUE INDEX ... ON project_event (project_id, dedupe_key) WHERE consumed_at IS NULL`（既有先例：PAC §11.2 步骤 7 的 partial index）。同一原因在未被消费前**只留一行**，`occurrences` 计数 +1、`lastAt` 前移。心跳抖动因此被自然合并（AC7 的 07 单元要求）。
- 投递：**同一进程内的轮询消费者**，`FOR UPDATE SKIP LOCKED` 取一批（按 `project_id` 分组，一个项目一次只取一组），间隔 1s + 抖动；同时监听 Postgres `NOTIFY project_event` 做低延迟唤醒。**NOTIFY 是加速器，不是投递保证** —— 丢通知只影响延迟。
- 失败重试：`attempts` + `next_attempt_at`（指数退避，上限 5 min），超过 10 次进 `DEAD` 并**同时开一条 `UNKNOWN_FAILURE` blocker**（fail closed，§11.3）。
- **消费 ≠ 处理成功**：`consumed_at` 在 reconcile **提交成功**时写，与决策同一事务。崩溃在中间 ⇒ 事件仍未消费 ⇒ 重投 ⇒ 幂等键兜住（§8）。

---

## 6. Reconcile：输入与输出

### 6.1 输入 —— Project 快照（冻结结构）

一次 reconcile 的输入是**一次读事务内**取到的一份内部一致的快照。跨行读必须在同一 `REPEATABLE READ` 事务里完成，否则"任务已 DONE 但 Session 还在飞"这类幻影组合会让状态机在两个状态间抖动。

```jsonc
{
  "v": 1,
  "snapshotAt": "2026-08-19T01:00:00.000Z",
  "snapshotHash": "<sha256 of the canonical serialization>",   // §7.5 审计与重放用
  "project":  { "id", "status", "coordinatorEnabled", "automationPolicy",
                "maxConcurrentTasks", "sessionBudgetPerDay",
                "coordinatorSessionId", "coordinatorWorkspaceId", "goal?", "acceptanceCriteria?" },
  "runtime":  { "runState", "fencingToken", "coordinatorGeneration", "nextWakeAt", "lastReconcileAt" },
  "team":     [ { "agentId", "role", "canCreateTasks", "canDelegate", "enabled" } ],   // PAC §3.2
  "workspaces": [ { "workspaceId", "isDefault", "position", "runnerId",
                    "runnerStatus", "capabilities", "capabilitiesReportedAt" } ],       // PAC §3.3 / PAC §3.5
  "tasks":    [ { "id", "status", "parentTaskId", "completionPolicy", "assigneeAgentId",
                  "provider", "model", "requiredCapabilities", "dispatchAuthority",
                  "dispatchHold", "runAt", "verifiesTaskId",
                  "dependsOnTaskIds", "failureCount", "lastFailureAt", "liveSessionIds" } ],
  "sessions": [ { "id", "taskId", "runStatus", "pendingApprovals", "startedAt" } ],     // 仅本项目的在飞会话
  "providers":[ { "slug", "available", "reason?" } ],
  "blockers": [ { "id", "kind", "owner", "dedupeKey", "nextCheckAt", "subject" } ],
  "budget":   { "sessionsStartedLast24h", "inFlight" },
  "events":   [ { "id", "kind", "sourceType", "dedupeKey" } ]   // 本次唤醒消费的事件，仅用于审计
}
```

**S1**：快照**只含本 Project 的行**，且每一行都过 `ownerId` 租户边界（AC5）。跨租户泄漏是 P0。
**S2**：出站（API/CLI/Web 展示这份快照时）所有 id 编 base62。快照内部落库为 UUID。这与 PAC B3 是同一个坑：**JSON 里的 id 不是列，编解码器不会自动处理**，必须显式转换并有测试断言。
**S3**：`snapshotHash` 覆盖上表除 `snapshotAt` / `events` 外的全部内容的规范化序列化。**相同 hash 必须给出相同的机械决策**（§7.4），这是 11 单元"可重放审计"的判据。
**S4**：快照**不含** `session.resolution` / Agent 的提示词全文 / 任务描述全文。它是一个决策输入，不是一份导出。要看细节走既有接口。

### 6.2 输出 —— Reconcile Outcome（冻结结构）

```jsonc
{
  "v": 1,
  "reconcileId": "<uuid>",
  "fencingToken": 42,
  "runStateBefore": "PLANNING",
  "runStateAfter":  "EXECUTING",
  "decidedBy": "ORCHESTRATOR",            // 或 "COORDINATOR_AGENT"
  "actions":  [ { "type": "DISPATCH_TASK", "idempotencyKey": "pc:v1:…", "subject": {…} } ],
  "blockersOpened":  [ "<blockerId>" ],
  "blockersCleared": [ "<blockerId>" ],
  "nextWakeAt": "2026-08-19T01:02:00.000Z",
  "nextWakeReason": "in-flight session may end",
  "consumedEventIds": [ "<eventId>" ]
}
```

**提交是一次事务**：`project_runtime` 的状态与 token 校验、`project_action` 的幂等键插入、`project_blocker` 的开/关、`project_decision` 的审计行、`project_event.consumed_at`，**全部在同一个事务里**。事务提交后才执行不能入事务的副作用 —— 而 v1 里**没有这种副作用**：派发一个任务就是插一条 `session` 行（§8.3），它本来就在数据库里。

### 6.3 一次 reconcile 的时序

```
 1. 取租约（§8.1）。取不到 → 记 nextWakeAt = 现持有者租约到期时刻，返回。绝不自旋。
 2. 读一致快照（§6.1）。
 3. 判定 run_state（§4.2 的转移表；输入只有快照）。
 4. 计算机械动作集合（§7.3 的机械子集）。策略门（§9）在这里，不在动作执行处。
 5. 若需要语义判断（§7.2 的触发条件）→ 追加一个 OPEN_COORDINATOR_TURN 动作，本次不再追加派发动作。
 6. 计算 blocker 的开/关（§11）。
 7. 计算 nextWakeAt（§10.4）。
 8. 一个事务：token 校验 + 动作账本 + blocker + 审计行 + 事件消费 + runtime 更新。
 9. 释放租约。
```

**R1**：第 5 步的"本次不再追加派发动作"是刻意的：一次 reconcile 要么按已知的图往前走，要么请协调器重新看图，**不同时做**。同时做会让协调器的判断建立在一份已经被自己这一 tick 改过的图上。

**R2**：整个 reconcile 有硬上限 **5 分钟**（含租约续期）；超时即放弃提交、释放租约、`nextWakeAt = now + 60s`，并记一条 `reconcile_timeout` 审计行。**超时不得静默重试**。

---

## 7. 合法动作

### 7.1 动作集合是封闭的

**A1（冻结）**：控制环只能产生下表中的动作。任何"临时加一个动作类型"的实现改动都必须先改本文。

### 7.2 机械 / 语义 分界

| | 谁执行 | 什么时候 |
|---|---|---|
| **机械动作** | orchestration service，纯确定性，无 LLM | 每次 reconcile |
| **语义动作** | Coordinator Agent，在 Coordinator Turn 内，通过既有 MCP/API 且受既有鉴权约束 | 只在 `OPEN_COORDINATOR_TURN` 之后 |

**需要语义判断的触发条件（封闭集合）**，满足任一即追加 `OPEN_COORDINATOR_TURN`：

1. `run_state = PLANNING` 且没有任何可派发任务，且没有 open blocker（"图不够，需要重规划"）。
2. 出现 FAIL / INCONCLUSIVE 的验证 verdict，且 §13.2 的机械退回已完成（协调器决定接下来做什么）。
3. 一条 blocker 的 `owner = COORDINATOR`（例如"合并冲突需要有人判断怎么解"）。
4. 全部 Task 收敛，准备进入 `ACCEPTANCE`（协调器执行项目级验收，§13.4）。
5. 用户显式要求（`user.manual_trigger`）。

**除此之外不开 turn。** 尤其：**一个任务失败不会自动开 turn** —— 失败有既有的退避与重试（§9.5），协调器不是重试机制。这是对既有 foreman 事故的直接吸取：一个"停滞就派一个协调者"的规则在停滞无法被协调者解决时会永远重派。

### 7.3 动作表（冻结）

**机械动作**

| type | 作用 | 幂等键（§8.2） | 前置条件 |
|---|---|---|---|
| `DISPATCH_TASK` | 把一个已授权的 Task 变成一次 Session | `pc:v1:<projectId>:dispatch:<taskId>:<attempt>` | §7.4 全部满足 |
| `OPEN_COORDINATOR_TURN` | 唤醒 Coordinator Agent | `pc:v1:<projectId>:turn:<generation>:<reasonDigest>` | 存在活的 Coordinator Session；未超最小间隔（§10.4） |
| `ROTATE_COORDINATOR_SESSION` | 开一条新的 Coordinator Session | `pc:v1:<projectId>:coord-session:<generation+1>` | 旧 Session 已终结或被删除；落点必须是 `project.coordinatorWorkspaceId`（§7.5） |
| `RAISE_BLOCKER` | 开一条结构化阻塞 | `pc:v1:<projectId>:blocker:<kind>:<subjectId>` | §11.2 的 kind 之一 |
| `CLEAR_BLOCKER` | 解除阻塞 | `pc:v1:<projectId>:unblock:<blockerId>` | 条件已消失（§11.4） |
| `AGGREGATE_PARENT` | 按 `completionPolicy` 重算父任务状态 | `pc:v1:<projectId>:aggregate:<taskId>:<childrenDigest>` | §13.1 |
| `APPLY_VERIFICATION_VERDICT` | 退回被验证任务 / 建缺陷子任务 / 阻断下游 | `pc:v1:<projectId>:verdict:<verifierTaskId>:<verdict>` | §13.2 |
| `REQUEST_APPROVAL` | 把一个动作挂起等人批 | `pc:v1:<projectId>:approval:<targetIdempotencyKey>` | 策略判定为"需审批"（§9.2） |
| `RUN_PROJECT_ACCEPTANCE` | 发起项目级验收 | `pc:v1:<projectId>:acceptance:<attempt>` | §13.4 |
| `SCHEDULE_WAKE` | 安排下次检查 | 无（写在 `project_runtime`，不入账本） | 恒执行 |
| `NOOP` | 什么都不做，但**必须**留审计行与 `nextWakeAt` | 无 | —— |

**语义动作**（Coordinator Agent 在 turn 内通过既有接口做，**不入 `project_action`，走既有鉴权**）：建任务/任务树、改任务描述与验收标准、排依赖、指派 Agent、提议标记 Project DONE。

**A2**：`NOOP` **不是**"没事发生"。它是一条"我看过了，结论是不动"的审计行。没有 `NOOP` 就没法把"控制环判断不动"和"控制环根本没跑"区分开 —— 而这两者正是本项目要区分的东西。

### 7.4 `DISPATCH_TASK` 的前置条件（全部满足才可派发）

按顺序判定，**任一失败即不派发**，并按 §11 决定是否开 blocker：

1. `task.status = OPEN` 且 `dispatchHold = false` 且（`runAt IS NULL` 或已到期）。
2. `task.dispatchAuthority = 'COORDINATOR'`（§12.3）。
3. 全部前置依赖 DONE；若 `verifiesTaskId` 非空，被验证任务已 DONE 且未被退回（§13.2）。
4. 该 Task 没有在飞 Session（`liveSessionIds` 为空）。
5. 失败退避未生效（复用既有 `AUTO_RUN_RETRY_BACKOFF_MS` / `MAX_AUTO_RUN_FAILURES`，§9.5）。
6. 并发未超 `project.maxConcurrentTasks`；24h Session 预算未超 `sessionBudgetPerDay`。
7. 策略允许（§9.2）；若判定"需审批"，改为 `REQUEST_APPROVAL`。
8. PAC §5 的 `resolveExecutionContext(task)` 成功解析出 (agent, provider/model, workspace/runner)。**失败即 REFUSE**，按 PAC §12 的错误码映射成 blocker（§11.2），**绝不改派、绝不换引擎**。

**A3**：第 8 步**完全复用** PAC 的解析链，控制环不得有第二套解析。控制环唯一被允许做的是"决定这一件事要不要现在派"，"派成什么样"永远是 PAC §7 的三条链。

### 7.5 Coordinator Session 轮换（AC1 / AC9）

- **身份稳定**：轮换只换 Session，**Coordinator Agent（`project_member.role = COORDINATOR`）不变**。`coordinator_generation` +1。
- **落点固定**：新 Session 必须开在 `project.coordinatorWorkspaceId`。既有 schema 已冻结"第二次请求指定不同 workspace 是 409，不是静默迁移"，控制环**不得**绕过它 —— 轮换不是迁移。若该 workspace 已被软删/离线，**不换地方**，改为开一条 `COORDINATOR_UNAVAILABLE` blocker（`owner = USER`，所需动作="重新绑定协调 Workspace"）。
- **触发条件**：旧 Session 终结（`session.ended` / `session.failed`）、被用户删除（`coordinatorSessionId` 被 SetNull）、或连续 N 次 turn 失败。
- **历史可追溯**：`project_decision.coordinator_session_id` 保留每次决策**当时**的 Session id，因此轮换后仍能按代数回放历史。`project.coordinatorSessionId` 只是"现在是哪一条"。
- **`@unique` 的处理**：`coordinatorSessionId` 是唯一索引，轮换必须在**同一事务**里清旧、写新，否则并发轮换会撞唯一约束并把项目卡在无协调器状态。

---

## 8. 幂等、租约与恢复

### 8.1 Reconcile Lease

落在 `project_runtime` 上（不单独建表：租约是运行时状态的一部分，拆开只会多一次 join 和一个可以不同步的事实）。

| 列 | 语义 |
|---|---|
| `lease_holder` | 持有者实例 id（进程启动时生成的 uuid），null = 空闲 |
| `lease_expires_at` | 到期时刻。**过期即可被抢**，无需持有者配合 |
| `lease_heartbeat_at` | 最近一次续期 |
| `fencing_token` | `BigInt`。**每次成功获取租约 +1**，单调不回退 |

- **获取**：一条条件 UPDATE
  ```sql
  UPDATE project_runtime
     SET lease_holder = :me, lease_expires_at = now() + interval '60 seconds',
         lease_heartbeat_at = now(), fencing_token = fencing_token + 1
   WHERE project_id = :p AND (lease_holder IS NULL OR lease_expires_at < now())
  RETURNING fencing_token;
  ```
  返回 0 行 = 没抢到。**没抢到就返回**，记 `nextWakeAt = 现租约到期时刻 + 抖动`，**绝不自旋、绝不递归重试**。
- **续期**：TTL 60s，每 20s 续一次，续期同样带 `WHERE fencing_token = :token`。续期失败 = 已被接管 = 立刻放弃本次 reconcile，不提交。
- **提交**：§6.2 的提交事务第一句永远是
  ```sql
  UPDATE project_runtime SET … WHERE project_id = :p AND fencing_token = :token
  ```
  影响行数为 0 即整个事务回滚。**这是"旧回包被拒绝"的唯一实现方式**（AC9 / 单元 19）。

**F1**：**任何**写入控制环状态的语句都必须带 `fencing_token` 条件 —— 包括 `project_action` 的插入、blocker 的开关、审计行。少一处就是一个可以被过期持有者写脏的口子。
**F2**：**取不到租约不是错误**，不开 blocker、不记 FAIL，只记一条 `lease_contended` 的 debug 审计并安排下次唤醒。把租约竞争当失败会在滚动升级的几十秒里刷出一屏假告警。
**F3**：**租约不得与任何其它锁互等**。既有教训明确：`merge_status` 卡 pending → takeover 409 → reclaim 无声死循环，整机排队。因此：reconcile 内部**不获取任何第二把锁**，需要等待的一律转成 `nextWakeAt`。

### 8.2 幂等键

**格式（冻结）**：`pc:v1:<projectId>:<actionType>:<scope>[:<epoch>]`

- `projectId` 用 **UUID 原文**（键是内部标识，不是对外 id；用 base62 会让同一动作在编解码变更后换身份）。
- `<epoch>` 是**只在"这件事确实是新的一次"时才前进的计数**，这是幂等键设计的全部要害：
  - `dispatch` 的 epoch = `task.failureCount`（重试是新的一次；重复事件不是）。
  - `turn` 的 epoch = `coordinator_generation` + 唤醒原因摘要（同一原因在同一代里只开一次 turn）。
  - `aggregate` 的 epoch = 子任务状态集合的摘要（子树没变就不重算）。
  - `blocker` **没有 epoch**：同因阻塞恒为同一键，这正是 AC8 的去重（§11.4）。
- **唯一约束**：`project_action.idempotency_key @unique`（全局唯一，不按项目分区 —— 键里已含 projectId）。

### 8.3 exactly-once-effect

`project_action` 一行 = 一个动作的完整生命周期：

| 列 | 语义 |
|---|---|
| `idempotency_key` | `@unique` |
| `type` / `subject_type` / `subject_id` | 动作与对象 |
| `status` | `CLAIMED` → `APPLIED` / `REFUSED` / `SUPERSEDED` |
| `fencing_token` | 提交时的 token |
| `decision_id` | 产生它的那次 reconcile |
| `result_session_id` | `DISPATCH_TASK` / `OPEN_COORDINATOR_TURN` 的产物 |
| `refusal_code` | 被拒时的 PAC §12 错误码 |

**关键实现约束 —— 副作用与幂等键同事务**：

`DISPATCH_TASK` 的副作用是"插入一条 `session` 行"，它本来就是一次数据库写。因此

```
BEGIN;
  UPDATE project_runtime ... WHERE fencing_token = :token;      -- F1
  INSERT INTO project_action (idempotency_key, ...) VALUES (...);-- 冲突即已做过 → 整事务回滚，视为成功
  INSERT INTO session (..., project_action_id) VALUES (...);
  UPDATE project_action SET status='APPLIED', result_session_id=... ;
  INSERT INTO project_decision ...;
  UPDATE project_event SET consumed_at = now() WHERE id = ANY(:ids);
COMMIT;
```

**得到的是真正的 exactly-once，而不是 at-least-once + 去重**：崩溃只可能发生在提交前（什么都没发生）或提交后（全都发生了）。`session.project_action_id` 加 `@unique`，让"这个动作有没有产生 Session"是一次索引查找而不是一次推理。

**X1**：**不允许出现"先做副作用再写键"的顺序**。那是 at-least-once，会在崩溃窗口里派出第二条 Session。
**X2**：唯一键冲突 = **这个动作已经做过** = 本次 reconcile 对该动作视为成功（不是错误）。这条必须有测试：同一 `(snapshot, token)` 连跑两次，Session 只有一条。
**X3**：`OPEN_COORDINATOR_TURN` 的副作用是"往 Coordinator Session 投一条消息"，同样是数据库写（既有的消息入队），因此同一手法适用。

### 8.4 崩溃与接管恢复

| 崩溃点 | 恢复后发生什么 |
|---|---|
| 取租约后、读快照前 | 租约 60s 后过期 → 被接管 → 事件仍未消费 → 重新 reconcile |
| 快照读完、提交前 | 同上。**没有任何副作用发生过** |
| 提交事务中途 | Postgres 回滚。同上 |
| 提交后、释放租约前 | 租约自然过期。事件已消费、动作已 APPLIED，重投也会被幂等键挡住 |
| 进程被接管，旧进程又活了 | 旧进程的 `fencing_token` 已过期，它的任何提交影响 0 行并回滚（F1） |
| Coordinator Session 在 turn 中途死 | `session.failed` 事件 → reconcile → §7.5 轮换 → 新 turn（同一 Agent，generation+1） |
| Runner 离线且带着在飞 Session | 既有 reaper 在无心跳 90s 后强杀 → `session.failed` 事件 → 正常失败路径（退避、blocker） |

**Y1**：恢复**不需要任何"重放日志"**。控制环的恢复方式是"重新看一眼当前状态"，因为 E1 让事件不携带事实。`project_decision` 是审计，不是恢复的输入 —— 这一点必须写死，否则会有人把审计行当状态源，于是审计变成不可裁剪的关键路径。

---

## 9. 策略与授权

### 9.1 三种策略

| 策略 | 含义 | 谁用 |
|---|---|---|
| `MANUAL` | 控制环**照常** reconcile、照常算出"下一步应该是什么"、照常持久化，但**不执行任何机械动作**（除 `RAISE_BLOCKER` / `SCHEDULE_WAKE` / `NOOP`），一律转成 `REQUEST_APPROVAL` 并进 `AWAITING_HUMAN` | 迁移过来的既有 Project（§12.1）；用户显式选择 |
| `GUARDED_AUTO` | **新建 Project 的默认**。可自动执行"低风险"动作；"高风险"动作需审批 | 默认 |
| `AUTO` | `GUARDED_AUTO` 加上大部分高风险动作；但 §9.3 的"永不代劳"清单仍然生效 | 用户显式选择 |

**P1**：`MANUAL` **不是"关掉控制环"**。它仍然产生状态、blocker 和 `nextWakeAt`，因此"我关了自动化"和"它坏了"在控制面上仍然可区分。关掉控制环是 `coordinatorEnabled = false`，那是另一个字段（§2.2）。

### 9.2 动作 × 策略 矩阵（冻结）

`✔` 自动执行 · `⚠` 需审批（转 `REQUEST_APPROVAL`，进 `AWAITING_HUMAN`）· `✘` 拒绝

| 动作 | MANUAL | GUARDED_AUTO | AUTO |
|---|:---:|:---:|:---:|
| `SCHEDULE_WAKE` / `NOOP` / `RAISE_BLOCKER` / `CLEAR_BLOCKER` | ✔ | ✔ | ✔ |
| `AGGREGATE_PARENT` | ✔ | ✔ | ✔ |
| `DISPATCH_TASK`（普通任务，未超预算，失败次数 0） | ⚠ | ✔ | ✔ |
| `DISPATCH_TASK`（重试，failureCount ≥ 1） | ⚠ | ✔ | ✔ |
| `DISPATCH_TASK`（failureCount ≥ `MAX_AUTO_RUN_FAILURES`） | ⚠ | ⚠ | ⚠ |
| `DISPATCH_TASK`（会超 `maxConcurrentTasks` / `sessionBudgetPerDay`） | ✘ | ✘ | ✘ |
| `DISPATCH_TASK`（任务 pin 的 Provider 当前不可用，Agent 配了 fallback） | ⚠ | ⚠ | ✔ |
| `OPEN_COORDINATOR_TURN` | ⚠ | ✔ | ✔ |
| `ROTATE_COORDINATOR_SESSION` | ⚠ | ✔ | ✔ |
| `APPLY_VERIFICATION_VERDICT`（退回被验证任务、建缺陷子任务、阻断下游） | ⚠ | ✔ | ✔ |
| `RUN_PROJECT_ACCEPTANCE` | ⚠ | ⚠ | ✔ |
| 把 `project.status` 置为 `DONE` | ✘ | ✘ | ✘ |

**最后一行是硬门**：**任何策略下控制环都不能自己把 Project 标 DONE**。它只能在验收全 PASS 之后产生一个"可以标 DONE"的提议（§13.4）。这是 AC12 的字面要求，也是项目 instructions 里"登录用户保留最终控制权"的落点。

**P2**：`⚠` 的实现是一条 `owner = USER` 的 blocker + 一条 `REQUEST_APPROVAL` 动作，**不是**一个静默的跳过。用户必须能在 Web/API/CLI 上看到"控制环想做 X，等你点头"。
**P3**：矩阵是**表驱动**的，单元 12 必须以数据表形式实现并逐格测试（`policy × action × 条件`），不允许写成一串 if。

### 9.3 永不代劳（任何策略、任何情况）

1. 把 `project.status` 标 `DONE`（须验收 PASS + 用户/协调器显式动作，§13.4）。
2. **静默切换 Provider**。降级只在 Agent 显式配了 `providerFallbacks` 时发生，且必须落 `run_event` 与 `resolution.with.fallbackHops`（PAC §7.4）。控制环不新增任何降级路径。
3. **换人做 / 换机器做**（PAC §7.4 第 5 条）。
4. 删除任务、删除项目、改验收标准。
5. 越过 PAC §8.2 的授权矩阵。控制环发起的动作，其鉴权主体是 **Coordinator Agent**，判定与该 Agent 手动操作时完全一致（I7）。

### 9.4 预算

v1 的预算只有两个整数，都在 `project` 上：

- `maxConcurrentTasks`：本项目同时在飞的 Session 上限（不含 Coordinator Session 本身）。
- `sessionBudgetPerDay`：滚动 24h 内**由控制环发起**的 Session 数上限。用户手动发起的不计入。

超预算 = `BUDGET_EXHAUSTED` blocker（`owner = USER`，`nextCheckAt` = 最早一条计入记录的 24h 边界），**不是**静默不派。

**O-budget**：token / 费用预算不在 v1。runner 已上报 token 用量（context 指标），但没有可信的成本口径，一个算不准的预算比没有预算更危险。见 §17。

### 9.5 重试与退避

**控制环不新增第二套重试阶梯。** 直接复用既有的 `AUTO_RUN_RETRY_BACKOFF_MS` / `MAX_AUTO_RUN_FAILURES` / `QUOTA_BLIND_RETRY_BACKOFF_MS`。

**理由是一次真实事故**：这个部署里已经出现过"两个 60s 定时器重刷同一批失败任务"和"停滞就派一个协调者、于是每个停滞窗口派一个"两次失控派发。第二套退避会以完全相同的方式复现它。

**Q1**：`failureCount ≥ MAX_AUTO_RUN_FAILURES` 时，控制环**停止自动派发**并开一条 `owner = USER` 的 blocker，而不是继续以更长的间隔重试。
**Q2**：控制环的 `nextWakeAt` **不得**短于目标任务的退避剩余时间 —— 否则退避形同虚设，只是把 busy loop 从派发挪到了 reconcile。

---

## 10. 活性 SLO

### 10.1 目标陈述（AC3）

> **一个 `status = OPEN`、`coordinatorEnabled = true`、且不在等待人工的 Project，在任何一次相关状态变化之后的 `L` 时间内，必须处于一个"可证明它没有空转"的状态。**

### 10.2 唤醒路径（**恰好三条**）

| 路径 | 延迟目标 | 说明 |
|---|---|---|
| **事件**（outbox 消费者 + `NOTIFY`） | p95 ≤ 5s，p99 ≤ 30s | 主路径 |
| **定时**（`next_wake_at <= now()` 的扫描） | 轮询 10s | 已知等待的恢复（退避、blocker 的 `nextCheckAt`、在飞会话可能结束） |
| **Backstop**（全表扫 `coordinatorEnabled ∧ status=OPEN ∧ (next_wake_at IS NULL OR next_wake_at < now() - 5min)`） | 每 60s，一批上限 200 | **兜底，用来发现漏事件的 bug**，命中即记 WARN 审计 |

**W1（唯一定时器）**：这三条**共用同一个定时器**，顺序执行。**多加一个 `setInterval` 就是一次生产事故** —— 既有教训：`TasksService` 被两个 module 提供，reconciler 一分钟跑两次，症状是重复派发，查了一次线上事故才定位。09 单元必须有一条断言：整个 orchestration service 只注册一个定时器，且服务只被一个 module 提供。

**W2**：backstop 命中不是正常路径。它每命中一次都说明有一条事件该发没发，必须记 WARN 并计数 —— 这个计数是 08 单元故障注入的观测点。

### 10.3 可判定的活性条件（这是测试直接查的东西）

对每个 `status = OPEN ∧ coordinatorEnabled ∧ run_state ∉ {AWAITING_HUMAN, SETTLED}` 的 Project，**下列至少一条为真**：

- **(a)** 存在一条 `project_action(type = DISPATCH_TASK, status = APPLIED)`，其 `result_session` 处于 LIVE；
- **(b)** 存在一次在飞的 Coordinator Turn；
- **(c)** 存在 ≥1 条 open blocker，且**四个字段齐全**：`kind`、`owner`、`required_action`、`next_check_at`；
- **(d)** `project_runtime.next_wake_at` 非空且在未来，且 `next_wake_reason` 非空。

**四条全不成立 = 活性违约 = P0。** 10 与 22 单元把这条写成一个可以对生产快照直接跑的 SQL 断言。

### 10.4 时限（冻结）

| 量 | 目标 | 判据 |
|---|---|---|
| `L`（事件提交 → 上述四条之一成立） | **p95 ≤ 30s，p99 ≤ 120s，硬上限 5min** | 硬上限由 backstop 保证 |
| 一次机械 reconcile 墙钟 | p95 ≤ 2s，硬上限 5min（§6.3 R2） | —— |
| 一次 Coordinator Turn | 软上限 10min；超时记 `turn_timeout` 并按失败处理 | —— |
| `OPEN_COORDINATOR_TURN` 最小间隔 | **同一 generation、同一原因摘要 60s 内至多一次** | 防 turn 风暴 |
| 租约 TTL / 续期 | 60s / 20s | §8.1 |

**`nextWakeAt` 的计算规则**（取所有适用项的**最小值**）：

1. 最早一条 open blocker 的 `next_check_at`；
2. 最早一个处于失败退避中的 Task 的退避到期时刻（Q2）；
3. 最早一个 `runAt` 在未来的 Task 的 `runAt`；
4. 有在飞 Session 时：`now + 60s`（在飞会话结束本身会发事件，这只是兜底）；
5. 都没有且 `run_state = PLANNING`：`now + 60s`；
6. `AWAITING_HUMAN`：`NULL`（等人，不定时叫醒自己）；`SETTLED`：`NULL`。

**W3**：`nextWakeAt` **永远不小于 `now + 5s`**。没有下限的"立刻再看一眼"就是 busy loop，10 单元的资源断言查的就是这个。

---

## 11. 结构化 Blocker

### 11.1 一条 blocker 必须回答四个问题

| 字段 | 回答 |
|---|---|
| `kind` | 出了什么事（封闭集合，§11.2） |
| `owner` | **谁能解决**：`USER` / `COORDINATOR` / `SYSTEM` |
| `required_action` | **要做什么**（一句可执行的人话，不是错误信息的复述） |
| `next_check_at` | **下次什么时候再看**（`owner = USER` 也必须有，用于升级，§11.5） |

外加：`subject_type`/`subject_id`（哪个 Task / Runner / Provider）、`detail`（Json，展示与诊断）、`dedupe_key`、`first_seen_at`/`last_seen_at`/`occurrences`、`severity`、`escalated_at`、`resolved_at`/`resolved_by`。

**BL1**：**没有"静默跳过"这个选项**（继承 PAC §12 的同一句话）。控制环每一次"这一步没往前走"都必须落在一条 blocker 上，或者落在一条 `NOOP` 审计行上并说明理由。

### 11.2 kind 封闭集合 与 PAC §12 的映射

前六个 kind **就是** PAC §12 的错误码，同名同义 —— 派发被 PAC 的解析链拒绝时，拒绝码原样成为 blocker 的 kind。**不新造同义词**，否则两份契约会在同一件事上有两个名字。

| kind | 来源 | 默认 owner | 默认 `next_check_at` |
|---|---|---|---|
| `WHO_UNRESOLVED` | PAC §12 | `COORDINATOR` | +5min |
| `WHO_NOT_IN_TEAM` | PAC §12 | `USER` | +1h |
| `WHO_DISABLED` | PAC §12 | `USER` | +1h |
| `PROVIDER_UNAVAILABLE` | PAC §12 | `SYSTEM` | +5min |
| `RUNTIME_REQUIREMENT_UNMET` | PAC §12 | `USER` | +15min |
| `NO_PROJECT_WORKSPACE` | PAC §12 | `USER` | +1h |
| `NO_MATCHING_RUNNER` | 候选机器全部离线（能力满足但机器不在） | `SYSTEM` | +2min |
| `MERGE_CONFLICT` | `merge.conflict` | `COORDINATOR` | +10min |
| `TEST_FAILED` | 任务运行失败且失败归因为测试 | `COORDINATOR` | 按退避（Q2） |
| `VERIFICATION_FAILED` | 验证任务给出 FAIL | `COORDINATOR` | +5min |
| `BUDGET_EXHAUSTED` | §9.4 | `USER` | 预算窗口边界 |
| `AWAITING_USER_APPROVAL` | `REQUEST_APPROVAL` | `USER` | +24h（仅用于升级） |
| `AWAITING_USER_INPUT` | 在飞 Session 停在 `AWAITING_INPUT` 且有待审批卡 | `USER` | +24h |
| `POLICY_MANUAL_HOLD` | `MANUAL` 策略下有可执行的下一步 | `USER` | +24h |
| `DEPENDENCY_CYCLE` | 依赖图不可达/成环 | `COORDINATOR` | +5min |
| `COORDINATOR_UNAVAILABLE` | 协调 Workspace 软删/离线，或轮换失败 | `USER` | +15min |
| `UNKNOWN_FAILURE` | **兜底**：任何未归类的失败 | `USER` | +30min |

**BL2（fail closed）**：`UNKNOWN_FAILURE` 的存在方式是"识别不出来就开它"，而不是"识别不出来就当没事"。任何 `catch` 到未分类异常的 reconcile 必须开它并停止本项目的自动派发，直到有人处理。

### 11.3 去重

`dedupe_key` 默认 = `<kind>:<subjectType>:<subjectId>`，落 partial unique index：

```sql
CREATE UNIQUE INDEX project_blocker_open_dedupe_idx
    ON project_blocker (project_id, dedupe_key) WHERE resolved_at IS NULL;
```

同因重复事件 ⇒ 同一 `dedupe_key` ⇒ 命中已存在的 open 行 ⇒ `occurrences += 1`、`last_seen_at = now()`，**不新建行、不重复通知**（AC8）。

### 11.4 自动解除

每次 reconcile 对每条 open blocker 重算其条件：条件消失即 `CLEAR_BLOCKER`，写 `resolved_at` / `resolved_by = 'AUTO'`，并**立即**重算 `run_state` 与 `nextWakeAt`（不等下一个 tick）。

**BL3**：解除必须由**重算条件**驱动，不能由"收到了一个 `provider.restored` 事件"驱动 —— 那会违反 E1，并且在事件丢失时永久卡住。

### 11.5 升级（escalation）

一条 blocker 在 `owner` 层面解决不了时升级：`SYSTEM → COORDINATOR → USER`。

- 触发：`occurrences` 或存活时长跨过阈值（默认：同一 blocker 存活 > 30min 或 `occurrences > 10`）。
- 升级即改 `owner` 并写 `escalated_at`；**每条 blocker 至多升级到 `USER`，且至多通知一次**（`escalated_at` 非空即不再通知）。这是"去重升级"的字面含义。
- 升级到 `USER` ⟹ `run_state` 转 `AWAITING_HUMAN`（I4）。

---

## 12. 兼容矩阵

### 12.1 既有 Project（AC11）

迁移 `0111_project_coordinator`（一次迁移，理由同 PAC §15 第 8 条）：

| 步骤 | 内容 | 幂等性 |
|---|---|---|
| 1 | 建枚举 `ProjectRunState` / `ProjectAutomationPolicy` / `TaskCompletionPolicy` / `DispatchAuthority`；建表 `project_runtime` / `project_event` / `project_action` / `project_blocker` / `project_decision` | prisma migrate 单次 |
| 2 | 加列：`project.coordinator_enabled` / `automation_policy` / `max_concurrent_tasks` / `session_budget_per_day`；`task.completion_policy` / `dispatch_authority`；`session.project_action_id` | 全部**可空或有默认** |
| 3 | 为每个既有 Project 回填一行 `project_runtime`：`run_state = 'PLANNING'`、`fencing_token = 0`、`next_wake_at = NULL`、`coordinator_generation = 0` | `ON CONFLICT (project_id) DO NOTHING` |
| 4 | 既有 Project 一律 `coordinator_enabled = false`、`automation_policy = 'MANUAL'` | 列默认即如此（见 G1） |
| 5 | 既有 Task 一律 `dispatch_authority = 'LEGACY'`、`completion_policy = 'MANUAL'` | 列默认 |
| 6 | 建索引：`project_event (project_id, dedupe_key) WHERE consumed_at IS NULL`、`project_event (next_attempt_at) WHERE consumed_at IS NULL`、`project_blocker (project_id, dedupe_key) WHERE resolved_at IS NULL`、`project_runtime (next_wake_at) WHERE next_wake_at IS NOT NULL`、`project_action (idempotency_key)`、`project_decision (project_id, created_at DESC)` | `CREATE … IF NOT EXISTS` |
| 7 | **不含任何 `DROP COLUMN`** | 同 PAC M4 |

- **G1（关键）**：列默认值与"新建 Project 的默认"是**两个不同的值**，不能靠一个 `@default` 同时表达。`automation_policy` 的**数据库默认是 `MANUAL`**（保护存量），**服务层在创建新 Project 时显式写入 `GUARDED_AUTO`**。反过来做（默认 GUARDED_AUTO + 迁移里 UPDATE 存量）会在迁移与新代码上线之间留一个窗口，窗口里创建的项目全是自动的。同理 `coordinator_enabled` 数据库默认 `false`，新建时显式 `true`。**04 单元必须同时测这两条**：迁移后存量为 MANUAL/false，且新建为 GUARDED_AUTO/true。
- **G2**：迁移**不回填任何 blocker、不产生任何事件、不安排任何唤醒**。迁移完成的那一刻，控制环对存量项目**完全静默**。
- **G3**：用户为一个既有 Project 打开 `coordinatorEnabled` 时，服务层必须**同时**要求一个显式的 `automationPolicy`（不给默认），并在同一事务里产生一条 `user.policy_changed` 事件把它接进环里。"沿用安全默认"= 不动它；"明确选择策略" = 打开时必须选。
- **G4**：迁移必须在**空库**和**生产快照**上各跑一次、`migrate diff` 对新增列为空。验证手法照 PAC M3：一次性 throwaway postgres 跑 `prisma migrate deploy` + `migrate diff`，`grep` 自己新增的列名，而不是看 drift 总数。

### 12.2 没有 Project 的 Task（约 11 万行）

**完全不受影响**，逐字节沿用 PAC §11.1 的 legacy 路径：不产生事件（N1）、不参与 reconcile、`dispatch_authority = 'LEGACY'`。

### 12.3 单一派发权（**本节是防重复派发的全部依据**）

一个 Task 的派发权由 `task.dispatch_authority` 唯一决定：

| 值 | 谁派 |
|---|---|
| `LEGACY` | 既有三条 sweep（`reconcileReadyTasks` / `dispatchDueScheduledTasks` / `dispatchStalledListForemen`）与用户手动 |
| `COORDINATOR` | 只有控制环（用户手动仍可，见 D3） |

- **D1**：既有三条 sweep 的候选查询一律追加 `AND dispatch_authority = 'LEGACY'`。
- **D2（关键）**：**派发权必须投影在 task 行上，绝不能靠 join `project` 判断**。既有教训：sweep 去 join `task_list` 判 paused，结果那一行可以被删掉 —— 刹车跟着一起没了，55517 条孤儿任务继续跑。`project` 行同样可以被删/改，因此判据必须在 task 自己身上。
- **D3**：`dispatch_authority` 的写入点恰好两处：Task 被填上 / 移出一个 `coordinatorEnabled = true` 的 `projectId`；Project 的 `coordinatorEnabled` 被切换（同一事务批量更新其 Task）。**用户手动"开始执行"不受它约束** —— 那是人的显式动作，走既有路径，并产生一条 `user.manual_trigger` 事件让控制环知道。
- **D4**：`task.autoRunWhenReady` 对 `COORDINATOR` 权的任务**无效**（它是 legacy sweep 的开关）。UI 必须据此说明，不能让用户以为关掉它就停了。

### 12.4 混合版本与客户端

| 组合 | 期望行为 |
|---|---|
| **新旧 apiserver 并存（滚动升级）** | 旧实例不认识 `project_event`，不消费；新实例正常消费。两个新实例互相之间由 fencing token 保证只有一个能提交（§8.1）。**滚动窗口内不得出现重复派发**，19/22 单元必须构造两实例并发场景 |
| **新 apiserver × 旧 runner** | 控制环不改 runner 契约。runner 侧无改动 ⇒ 无需 bump 版本；**若后续单元真的改了 runner，必须 bump 版本并重建 web 镜像**（PAC §11.5，既有部署纪律） |
| **旧 web / iOS / macOS × 新 apiserver** | 所有既有接口形状不变，新字段以**可选字段**追加。旧端看不到 Coordinator 状态，但 Project/Task/Session 的读写完全照常。Swift 端对新增可选字段的解码必须实测过 —— 既有教训：wire 变更而原生端没跟，只会静默漏改 |
| **新 web × 旧数据** | 无 `project_runtime` 行（理论上不该出现，迁移已回填）时展示"未启用"空态，不报错 |
| **未知 `kind` / 未知 `v` 的事件** | 照常标脏、照常消费，不报错（§5.2） |

### 12.5 与既有机制的关系（不复活、不并行）

- **List foreman**（`foremanWorkspaceId` / `foremanStallMinutes`）：作用域是 Task List，与 Project 正交。**v1 不合并、不迁移、不复活**。同一个 Task 若既在 List 又在 Project，派发权由 §12.3 唯一裁决，foreman 不再对它派发（D1）。
- **`ListEventsService` 的 piggyback 上报**：保持原样。控制环**不新增**第二条"能叫醒 Agent 的路"给它。
- **`auto-retry.service`（529/断流自动重试）**：保持原样，是 Session 层的机制。控制环看到的是它的最终结果。

---

## 13. Task 语义扩展

### 13.1 父任务聚合完成策略（AC7）

`task.completionPolicy`，枚举 `TaskCompletionPolicy`：

| 值 | 父任务在什么时候自动变 DONE |
|---|---|
| `MANUAL`（默认，兼容既有行为） | 永不自动。人或 Agent 显式改 |
| `ALL_CHILDREN_DONE` | 全部直接子任务 ∈ {DONE, CANCELLED} 且至少一个 DONE |
| `VERIFICATION_PASSED` | 满足 `ALL_CHILDREN_DONE`，**且**指向本任务的验证任务（`verifiesTaskId = this`）全部 DONE 且 verdict = PASS |

- **AG1**：聚合是**重算**，不是增量累加。输入是子任务当前状态集合，因此重复事件、乱序、并发完成都收敛到同一结果（幂等键的 epoch 取子状态摘要，§8.2）。
- **AG2**：聚合**自底向上**逐层进行，一次 reconcile 内可跨多层；成环由既有的 `parentTaskId` 约束与 `task-dag` 检查挡住，检测到环即开 `DEPENDENCY_CYCLE` blocker 并停止聚合。
- **AG3**：子任务从 DONE 被改回 OPEN（重开）时，父任务**必须跟着回退**（`DONE → OPEN`），否则聚合状态会单向锁死。这条要单独测。
- **AG4**：`completionPolicy` 对**没有子任务**的 Task 无效（不能靠"零个子任务全 DONE"把一个叶子任务判完成）。

### 13.2 验证失败的原生退回（AC6）

既有 `task.verifiesTaskId` 表达"这个任务验证那个任务"。v1 让 verdict 产生**原生**后果，而不是靠提示词约定：

| verdict | 机械后果（`APPLY_VERIFICATION_VERDICT`） |
|---|---|
| `PASS` | 被验证任务保持 DONE；解除相关 `VERIFICATION_FAILED` blocker；下游解锁 |
| `FAIL` | ① 被验证任务 `DONE → OPEN`（原生退回）；② 建一条缺陷子任务（父 = 被验证任务，携带失败证据）；③ **阻断下游**：依赖被验证任务的任务不可派发；④ 开 `VERIFICATION_FAILED` blocker |
| `INCONCLUSIVE` | 不退回、不建缺陷；开 `VERIFICATION_FAILED` blocker（`owner = COORDINATOR`），并触发 `OPEN_COORDINATOR_TURN`（§7.2 触发条件 2） |

- **V1**：verdict 的载体是**验证任务自身的终态 + 一条结构化结果**，不是自由文本。
- **V2**：重复 verdict **不重复退回、不重复建缺陷** —— 幂等键 `pc:v1:<p>:verdict:<verifierTaskId>:<verdict>`。
- **V3**：下游阻断在**派发前置条件**里判定（§7.4 第 3 条），不是靠改下游任务的状态。改状态会让"为什么这个任务不能跑"变成一个需要考古的问题。
- **V4**：缺陷子任务修复完成后，被验证任务重新可派发；验证任务需**重新运行**才能给出新的 verdict（旧 verdict 不自动失效为 PASS）。
- **V5（既有教训）**：验证前置检查**不得**用 `numTurns` 判"这个任务从没执行过" —— `numTurns` 只在 turn 结束才落库，而 DONE 常常写在 turn 内，于是恒判"无执行记录"。判据用 Session 的存在与终态，不用回合计数。
- **V6（既有教训）**：验证任务可能在运行中被连同 fixture 一起删除。`APPLY_VERIFICATION_VERDICT` 必须容忍 subject 消失：找不到就记 `SUPERSEDED`，不报错、不卡住。

### 13.3 依赖与就绪

沿用既有 `TaskDependency`。控制环对"就绪"的判定就是 §7.4 的八条前置，**不新增一套依赖语义**。

### 13.4 项目级验收与 DONE（AC12）

1. 全部 Task 收敛且验证全 PASS ⇒ `run_state = ACCEPTANCE`，产生 `RUN_PROJECT_ACCEPTANCE`。
2. 验收由 **Coordinator Agent 在一次 turn 内执行**：逐条核对 `project.acceptanceCriteria`，并**核对合并状态**（每条要求的提交都能从目标分支到达）。
3. 产物是一条结构化验收记录（落在 `project_decision.detail` 里，`decidedBy = COORDINATOR_AGENT`）：逐条 `PASS/FAIL` + 证据（命令、关键输出、SHA、环境）。
4. **全 PASS 才允许把 `project.status` 置 DONE**；任一 FAIL ⇒ 回 `PLANNING`/`BLOCKED`，产生新工作或新 blocker，**项目保持 OPEN**。
5. 标 DONE 这个写入本身**永远不是机械动作**（§9.2 最后一行）：它由用户，或由协调器在 turn 内以 Coordinator Agent 身份显式调用，且服务层在写入时**再次校验**存在一条全 PASS 的验收记录。**服务端校验是硬门，不是 UI 提示。**
6. **合并状态核对必须按内容验，不能只看 `--contains`**：既有教训 —— squash 合并后 `git branch --contains <sha>` 必然假阴性，要用 `git grep` 或 diff 比对内容。

---

## 14. 12 条项目验收标准逐条映射

**分类列**：**业务** = 落在 `project`/`task` 的字段或既有业务语义；**基础设施** = 新表/新列/新服务；**复用** = 由 PAC 已冻结的条款承担，本项目不重复实现。

| # | 验收标准（摘要） | 落地条款 | 分类 | 单元 | 证明它的测试 |
|---|---|---|---|---|---|
| **AC1** | Project 绑定稳定 coordinatorAgent 与默认协调 Workspace；Coordinator Session 可轮换可恢复；公开 ID 全 Base62 | §1.2 · §7.5 · §2.2 | **复用**（Coordinator Agent = PAC §3.2 `project_member`；协调 Workspace = 既有 `coordinatorWorkspaceId`）+ **基础设施**（`coordinator_generation`） | 03 · 04 · 19 | 03 `+`轮换后 Agent 不变、generation+1 · 03 `-`第二个 Coordinator（PAC T2 并发写）· 04 `-`轮换到不同 workspace → 409 · `public-id-coverage.spec.ts` |
| **AC2** | 六类来源经事务 outbox 唤醒 reconcile；重复/乱序/重启不重复执行 | §5 全节 · §8.3 | **基础设施**（`project_event`） | 05 · 06 · 07 · 08 | 05 `+`业务写与 outbox 原子提交/回滚 · 06 `-`事务回滚无孤儿事件 · 06 `+`batch 只产一条（N3）· 07 `+`多播只扇给相关项目（N2）· 08 故障注入：重复投递副作用恰好一次、乱序收敛、重启恢复 |
| **AC3** | 活性：OPEN 且不等人工时按时启动下一步，或持久化完整 blocker，不静默空转 | §10 全节 · I5 | **基础设施**（`project_runtime.next_wake_at`、`project_blocker`） | 09 · 10 · 22 | 09 `+`SLO 内进入合法状态 · 10 §10.3 四条断言对故障注入全程成立 · 10 `-`无 busy loop（W3）· 09 `-`只注册一个定时器（W1） |
| **AC4** | manual/guarded-auto/auto + 权限/并发/预算/重试/退避/审批边界；默认 guarded-auto | §9 全节 | **业务**（`automationPolicy`/`coordinatorEnabled`/`maxConcurrentTasks`/`sessionBudgetPerDay`）+ **基础设施**（策略求值） | 12 · 14 | 12 表驱动逐格覆盖 §9.2 · 12 `+`新建 Project 为 GUARDED_AUTO 且存量为 MANUAL（G1）· 14 `-`越权/竞态 fail closed · 14 `-`空 fallback 绝不换 Provider |
| **AC5** | 一致快照 + 记录每次判断的输入/决策/动作/幂等键 | §6.1 · §6.2 · §8.2 | **基础设施**（`project_decision`、`snapshotHash`） | 11 | 11 `+`快照内部一致且带租户边界 · 11 `+`同 hash ⇒ 同机械决策（S3）· 11 `-`陈旧 token 提交被拒并触发新 reconcile · 11 `-``resolution`/快照出站为 base62（S2 / PAC B3） |
| **AC6** | 验证失败可原生退回、建缺陷子任务、阻断下游；不靠提示词 | §13.2 | **业务**（既有 `verifiesTaskId` 的语义扩展，**无新实体**） | 16 · 18 | 16 `+`FAIL 三件事都发生 · 16 `-`重复 verdict 不重复退回（V2）· 16 `-`下游未修复前不可派发（V3）· 18 属性测试固定 seed 可复现 |
| **AC7** | 父 Task/阶段的聚合完成策略，无需人工维护汇总节点 | §13.1 | **业务**（`task.completionPolicy`；阶段= 父 Task，**不新增实体**，§2.3） | 15 · 18 | 15 `+`ALL_CHILDREN_DONE / VERIFICATION_PASSED · 15 `+`多层子树自底向上 · 15 `-`子任务重开时父任务回退（AG3）· 15 `-`空父节点不自动完成（AG4）· 15 `+`并发完成幂等 |
| **AC8** | 六类情形都有结构化 blocker 与去重升级；不得静默 fallback | §11 全节 · §9.3 | **基础设施**（`project_blocker`）+ **复用**（kind 直接沿用 PAC §12 错误码） | 17 · 18 | 17 `+`每类 blocker 四字段齐全 · 17 `-`同因重复事件不新建行（§11.3 partial unique）· 17 `+`条件消失自动解除并重算（BL3）· 17 `-`未知失败 fail closed（BL2）· 17 `-`升级至多通知一次 |
| **AC9** | 崩溃/Session 结束/Runner 离线/接管/混合版本后能恢复，不丢任务、不重复启动、不越权 | §8.1 · §8.4 · §12.4 · I7 | **基础设施**（fencing token、`project_action`） | 19 · 22 | 19 `-`旧 fencing token 提交影响 0 行 · 19 `+`两实例并发只有一个提交 · 19 `+`Coordinator Session 死后轮换继续推进 · 22 端到端故障注入矩阵（§15） |
| **AC10** | Web/API/CLI 展示当前状态、最近决策、下一动作、阻塞、下次唤醒、验收证据；有可独立运行的测试 | §6.2 · §11.1 · §13.4 | **基础设施**（读接口） | 20 · 21 | 20 API/CLI/MCP parity + 鉴权 + 全 Base62 · 20 `-`陈旧/越权写入被拒 · 21 组件测试覆盖 loading/error/empty + 三策略 + 审批 + blocker + 离线 Runner + legacy Project · 21 `-`界面不得暗示 silent fallback |
| **AC11** | 既有 Project 默认兼容、不被意外开启自动推进；迁移后须显式选策略或沿用安全默认 | §12.1 · §12.2 · §12.3 | **业务**（策略字段）+ **基础设施**（迁移、`dispatch_authority`） | 03 · 04 · 22 | 04 `M`迁移后存量 `coordinator_enabled = false` / `MANUAL`（G1 两条都测）· 04 `M`迁移不产生事件/唤醒（G2）· 04 `M`空库+生产快照 `migrate diff` 为空（G4）· 06 `+`无 Project 的 Task 派发逐字段不变（§12.2）· 14 `-`legacy sweep 不碰 `COORDINATOR` 权任务（D1） |
| **AC12** | 全部任务完成后执行项目级验收并核对合并状态，全 PASS 才可标 DONE | §13.4 · §9.2 最后一行 | **业务**（`project.status` 的写入门）+ **基础设施**（验收记录） | 23 | 23 `-`任一 FAIL 时标 DONE 被服务端拒绝（硬门，第 5 条）· 23 `+`全 PASS 后可标 DONE · 23 `+`合并核对按内容而非 `--contains`（第 6 条）· 23 `-`控制环任何策略下都不能自己标 DONE |

**总计**：业务字段 **5 个**（§2.2），新业务实体 **0 个**（§2.3），新基础设施表 **5 张** + 新列 **3 个**（§2.4）。

---

## 15. 故障模型

02 单元的独立审查以本节为清单；08 / 10 / 14 / 18 / 22 的故障注入以本节为用例来源。
**每一行都必须给出"预期持久化状态"与"恢复动作"** —— 一个说不出预期状态的故障场景是没法测的。

| # | 故障 | 预期持久化状态 | 恢复动作 | 由谁保证 |
|---|---|---|---|---|
| **F01** | 事件重复投递 | 动作账本里该幂等键恰好一行；副作用恰好一次 | 无需动作 | §8.3 X2 |
| **F02** | 事件乱序到达 | 与顺序到达完全相同的最终状态 | 无需动作 | §5.1 E1（事件不携带事实） |
| **F03** | 事件已提交但消费者崩溃 | `consumed_at` 仍为 NULL | 重启后重投；backstop 兜底 | §5.4 |
| **F04** | 业务事务回滚 | **无事件行** | 无 | §5.3 N4（同事务 outbox） |
| **F05** | apiserver 在 reconcile 中途重启 | 无任何副作用；事件未消费；租约 60s 后过期 | 接管者重新 reconcile | §8.4 |
| **F06** | 两个实例同时持有过期/新租约（split brain） | 只有新 token 的提交成功 | 旧持有者提交影响 0 行并回滚 | §8.1 F1 |
| **F07** | 旧回包/陈旧动作在接管后到达 | 被 token 条件拒绝，记 `SUPERSEDED` | 触发一次新 reconcile | §8.1 · §6.2 |
| **F08** | Coordinator Session 中途死亡 | `run_state` 不变；`session.failed` 事件在 | `ROTATE_COORDINATOR_SESSION`，generation+1，Agent 不变 | §7.5 |
| **F09** | 协调 Workspace 离线/被软删 | `COORDINATOR_UNAVAILABLE` blocker（owner=USER） | 用户重新绑定；**不换地方开** | §7.5 |
| **F10** | Runner 离线并带走在飞 Session | 既有 reaper 90s 强杀 → `session.failed` | 正常失败路径（退避 + blocker） | §12.5 · §9.5 |
| **F11** | 无匹配 Runner / 能力不满足 | `NO_MATCHING_RUNNER` 或 `RUNTIME_REQUIREMENT_UNMET` blocker，含逐机器缺失能力 | 条件恢复后自动解除；**绝不改派** | §11.2 · PAC §7.3 |
| **F12** | Provider 不可用 / 配额耗尽 | `PROVIDER_UNAVAILABLE` blocker | 仅在 Agent 显式配了 fallback 时降级并留痕；否则等恢复 | §9.3 第 2 条 · PAC §7.4 |
| **F13** | 合并冲突 | `MERGE_CONFLICT` blocker（owner=COORDINATOR） | 开 turn 让协调器决定 | §7.2 触发 3 |
| **F14** | 测试失败 / 任务运行失败 | 任务 FAILED + 失败计数 + 退避 | 复用既有退避阶梯；超上限转 `owner=USER` | §9.5 Q1 |
| **F15** | 验证 FAIL / INCONCLUSIVE | 被验证任务退回 OPEN + 缺陷子任务 + 下游阻断（FAIL）；仅 blocker（INCONCLUSIVE） | 修复后重跑验证 | §13.2 |
| **F16** | 预算 / 并发耗尽 | `BUDGET_EXHAUSTED` blocker，`next_check_at` = 窗口边界 | 窗口滚动后自动解除 | §9.4 |
| **F17** | 依赖成环 / 图不可达 | `DEPENDENCY_CYCLE` blocker，聚合停止 | 开 turn 重规划 | §13.1 AG2 |
| **F18** | Task 在飞时被删除 | 动作记 `SUPERSEDED`，不报错 | 下一次 reconcile 按新图继续 | §13.2 V6 |
| **F19** | Project 被删除 / 置 CANCELLED | 五张表 Cascade 清理；`run_state = SETTLED`；停止消费事件 | 无 | §2.4 |
| **F20** | 滚动升级：新旧 apiserver 并存 | 旧实例不消费 `project_event`；新实例之间由 token 串行化 | 无重复派发、无丢失 | §12.4 |
| **F21** | 未知/未分类失败 | `UNKNOWN_FAILURE` blocker，停止本项目自动派发 | 人处理 | §11.2 BL2 |
| **F22** | 事件消费连续失败 10 次 | 事件置 `DEAD` **且**开 `UNKNOWN_FAILURE` blocker | 人处理 | §5.4 |

**F-note**：F21/F22 是**唯一**两条"停下来等人"的兜底。它们存在的意义是让"控制环遇到了它不认识的东西"成为一个**看得见的状态**，而不是一次静默的 catch。

---

## 16. 已冻结的取舍

记录**为什么这样定**，避免后续任务重新开会。

1. **事件是信号不是事实**（E1）。用一次快照读换掉整个乱序/重复/丢失语义。替代方案（事件携带状态 + 版本向量）要求每个生产者都正确维护顺序，而生产者有六类、分布在整个代码库里。
2. **`runState` 与 `project.status` 分成两列两张表**（§2.4）。合并会让"这个项目在做什么"和"这个项目要不要继续做"互相覆盖，而这两件事分别由控制环和人写。
3. **`PLANNING` 是一个显式状态**（§4.1）。不给"什么都没在跑、也没被挡住"命名，AC3 就无法陈述。
4. **租约与 fencing token 落在 `project_runtime` 而不是单独的锁表**。租约是运行时状态的一部分；拆表只多一次 join 和一个可以不同步的事实。
5. **幂等键的副作用与键在同一事务**（§8.3 X1）。这让 exactly-once 成为数据库性质而不是重试策略的性质 —— 因为 v1 的所有副作用碰巧都是数据库写。
6. **不新增第二套重试/退避阶梯**（§9.5）。这个部署已经被"第二个定时器"和"停滞就派协调者"各伤过一次。
7. **只有一个定时器**（W1）。同上，且必须有断言。
8. **派发权投影在 task 行上**（D2）。任何需要 join 才能判断的刹车，都会在被 join 的那一行被删除时消失。
9. **`MANUAL` 不等于关掉控制环**（P1）。用户需要能区分"我按住了"和"它坏了"。
10. **`automation_policy` 的数据库默认与新建默认不同**（G1）。一个 `@default` 表达不了"保护存量 + 新建自动"，用一个默认值加一次迁移 UPDATE 会留下一个自动化的窗口。
11. **控制环任何策略下都不能自己标 Project DONE**（§9.2 最后一行）。这是用户最终控制权的最后一道，也是 AC12 的字面要求。
12. **Coordinator Agent 复用 PAC 的 `project_member`，不在 `project` 上新加一列**（§2.2）。同一事实两处落库必然漂移（PAC W3）。
13. **不复活、不合并 List foreman**（§12.5）。两条并行的"能叫醒 Agent 的路"正是两次失控派发的形状。
14. **五张基础设施表全部 Cascade 挂 project**（§2.4）。它们是控制环的内脏，没有独立生命周期，因此也就不可能被误当成业务实体。

---

## 17. 遗留的开放问题（不阻塞 03 阶段）

明确记录、明确不解决，避免被当成疏漏。

- **O1**：**token / 费用预算**不在 v1（§9.4）。runner 已上报 token 用量，但没有可信的成本口径；一个算不准的预算比没有预算更危险。v1 只有会话数与并发两个整数。
- **O2**：**多副本水平扩展**。fencing token 已经让多实例安全，但 outbox 消费者的分片策略（今天是单进程轮询 + `SKIP LOCKED`）在多副本下的公平性未定义。当前部署是单副本，滚动升级窗口由 §8.1 覆盖。
- **O3**：**跨 Project 的全局并发/预算**未定义。v1 的预算是 per-project。
- **O4**：**Coordinator Agent 与 Coordinator Session 的绑定**沿用 PAC O2：不强制协调对话必须由 Coordinator Agent 发起。
- **O5**：**iOS / macOS 的 Coordinator UI 不在 v1 范围**。原生端唯一要求是不因新增可选字段而崩溃或误显示（§12.4），与 PAC O5 同。
- **O6**：**决策审计的保留期与裁剪**未定义。`project_decision` 会随项目寿命线性增长；v1 不裁剪，也不允许任何代码把它当状态源（Y1），因此将来加裁剪不会破坏正确性。
- **O7**：**`INCONCLUSIVE` verdict 的自动重跑次数**未定义；v1 一律交给协调器判断（§13.2）。
- **O8**：**blocker 的通知投递**（APNs / Web toast）沿用既有通道，本文只定义 blocker 的产生、去重与升级，不定义送达。

---

## 18. 单元索引

| 单元 | 标题 | 本文的哪些条款 | 测试位置 |
|---|---|---|---|
| 01 | 冻结控制环领域与状态机契约 | 本文全部 | `src/apiserver/src/projects/coordinator-contract.spec.ts`（文档自检） |
| 02 | 独立审查契约与故障模型 | §4 · §8 · §15 | 审查产物 |
| 03 | Coordinator 身份、默认 Workspace、策略持久化 | §2.2 · §7.5 · §12.1 | `*.spec.ts`（`node --test`） |
| 04 | 独立验证身份、策略迁移与 Base62 | §12.1 G1–G4 · §6.1 S2 | 同上 |
| 05 | 事件信封、事务 outbox、投递 | §5.2 · §5.4 | 同上 |
| 06 | Task/Session/合并/用户事件源 | §5.3 N1 · N3 · N4 | 同上 |
| 07 | Runner/Provider 可用性事件源 | §5.3 N2 | 同上 |
| 08 | 故障注入验证事件可靠性 | F01–F04 · F20 | 同上 |
| 09 | reconcile 租约、幂等账本、恢复循环 | §6.3 · §8 · §10.2 W1 | 同上 |
| 10 | 独立验证活性、接管与崩溃恢复 | §10.3 · F05–F07 | 同上 |
| 11 | 一致快照、决策协议、审计日志 | §6.1 · §6.2 · §8.2 | 同上 |
| 12 | manual/guarded-auto/auto 策略 | §9 全节 | 同上 |
| 13 | dispatcher 与 scheduler 的授权边界 | §7.4 · §12.3 | 同上 |
| 14 | 独立验证策略、预算、权限与派发边界 | §9.2 · §9.3 · D1 | 同上 |
| 15 | 父 Task 聚合完成策略 | §13.1 | 同上 |
| 16 | 验证失败原生退回 | §13.2 | 同上 |
| 17 | 结构化 blocker、去重升级、下次唤醒 | §11 · §10.4 | 同上 |
| 18 | 独立验证聚合、退回与 blocker 语义 | §13 · F15 · F17 | 同上 |
| 19 | Session 轮换、恢复接管、混合版本 | §7.5 · §8.4 · §12.4 | 同上 |
| 20 | API / CLI 控制与观测面 | §6.2 · §11.1 | 同上 + CLI↔MCP parity |
| 21 | Web 状态与控制界面 | §4.1 · §9.2 · §11.1 | `*.test.tsx` |
| 22 | 端到端迁移、恢复与故障注入 | §15 全表 | 端到端套件 |
| 23 | 项目级验收与合并审计 | §13.4 · §14 | 验收产物 |
