# Project Coordinator 控制环契约 v1.2

> **状态**：已冻结（frozen）。本文件是 `Project Coordinator 持续推进控制环` 的**单一权威契约**。
> 03–23 阶段的每个实现与验证任务都必须与本文件一致；实现与本文件冲突时，先改本文件并说明理由，再改代码。
>
> **v1.1 修订**：关闭 02 独立审查（[`project-coordinator-contract-review-02.md`](./project-coordinator-contract-review-02.md)）提出的 2 个 P0 与 6 个 P1 契约缺口 `PC-CX-01..08`。逐项的最小交错序列、权威状态、动作键、恢复路径与可执行断言在 **§19**；规范条款本身落在 §4.2 · §7.2 · §7.6 · §8.5 · §9.4 · §9.5 · §10.2 · §10.4 · §11 · §12.3 · §13.4。v1.1 **不是措辞修订** —— 它改变了状态判定方式（从转移表改为守卫函数）、冲突提交语义（从整事务回滚改为 `ON CONFLICT`）、两个 blocker kind 的 owner、`AWAITING_HUMAN` 的时钟规则，以及 `DONE` 的服务端硬门。
>
> **v1.2 修订**：关闭 02 对 v1.1 的独立复审（[`project-coordinator-contract-review-02-v1.1.md`](./project-coordinator-contract-review-02-v1.1.md)）提出的 1 个 P0 与 5 个 P1 契约缺口 `PC-CX-09..14`。逐项闭环在 **§20**；规范条款落在 §4.1 · §4.3 · §7.2 · §7.7 · §8.2 · §9.5 · §10.3 · §11.2 · §11.5 · §12.1 · §12.3 · §13.4。v1.2 同样**不是措辞修订** —— 它给派发权切换与 Session 插入装上了**同一把数据库行锁**（v1.1 的触发器只做普通 `SELECT`，因此在 MVCC 下读得到已被改写但尚未提交之前的旧值）、把投递次数从幂等摘要里**移出去**、把 dispatch epoch 从可清零的 `failureCount` 换成**单调不复用**的 `task.dispatchAttempt`、把 `opensTurn` 从"当前 owner"改挂到 **kind**、给 `DONE` 与所有会改变验收事实的写路径装上**同一把项目行锁**，并让 `EXECUTING` 与活性判据**如实容纳**合法的 USER-origin Session。
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

以及五列：`task.dispatchAuthority`（§12.3）、**`task.dispatchAttempt`（§8.2 DA1，v1.2 新增）**、`session.projectActionId`（§8.3）、`session.dispatchOrigin`（§7.7）、`project_runtime.*`。

以及两个**不是表也不是列**的数据库对象，它们承担 §7.6 的派发线性化（**每一个都必须由数据库自己执行，因此对任何版本的二进制都成立**）：

| 对象 | 类型 | 职责 |
|---|---|---|
| `session_task_execution_claim_idx` | partial unique index | 同一 Task 至多一条**占位中**的 Session（§7.7 D5） |
| `session_dispatch_authority_guard` | `BEFORE INSERT` trigger | `dispatchAuthority = 'COORDINATOR'` 的 Task 只接受带派发权的插入（§7.6 D6） |

**为什么这两个必须在数据库里而不是在服务层**：它们要挡住的两个入口分别是"另一个进程的同一份代码"（PC-CX-01）和"另一个版本的旧代码"（PC-CX-02）。服务层的检查按定义只在写这段检查的那个二进制里存在，因此对第二个入口无效。

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
| `EXECUTING` | 至少一个本项目的 Session 在飞，或本 tick 刚派出去 | 至少一条本项目 Task 的占位 Session（§7.7 D5），且**每一条都可归属**（I11）：`dispatch_origin = COORDINATOR` ⇒ 有 APPLIED 的 `DISPATCH_TASK` 动作，`dispatch_origin = USER` ⇒ 人的显式动作。**v1.2 修订**：v1 只认前一种，于是一个用户手动启动的任务会让守卫 5 返回 `EXECUTING` 而不变量为假（`PC-CX-14`） |
| `AWAITING_VERIFICATION` | 实现任务已全部收敛，验证任务未出 verdict | 至少一条 `verifiesTaskId` 非空的 Task 未 DONE |
| `BLOCKED` | 有明确的、**机器可能自行恢复**的阻塞（Provider 挂了、无匹配 Runner、合并冲突、预算耗尽） | ≥1 条 open blocker，且**没有** `owner = USER` 的 open blocker，且每条都有 `nextCheckAt` |
| `AWAITING_HUMAN` | 需要人：审批、决策、凭据、manual 策略下的每一步 | ≥1 条 open blocker 且 `owner = USER`。**允许 `nextWakeAt` 为 null，但只在 §10.4 N-null 的条件下** —— v1 写的"唯一允许 null 的非终态"是无条件的，v1.1 收紧为有条件（PC-CX-05） |
| `ACCEPTANCE` | 正在执行项目级验收（AC12） | 存在一条 `project_action(type=RUN_PROJECT_ACCEPTANCE)` 未收敛 |
| `SETTLED` | 终态。与 `project.status ∈ {DONE, CANCELLED}` 一一对应 | `nextWakeAt IS NULL`，租约释放，不再消费事件 |

**为什么是 7 个而不是项目目标里列的 6 个**：目标句列举了"执行、待验证、明确阻塞、等待人工、项目验收或终态"。`PLANNING` 是第 7 个，且是**必须命名**的那一个 —— 它正是"静默空转"发生的地方：没有任务在跑、也没有任何东西阻塞。如果把它折进 `EXECUTING`，那么"三个 Session 在飞"和"什么都没有、协调器 30 秒后才想起来"在控制面上就是同一个词，AC3 的活性约束**无法被陈述，更无法被测**。

### 4.2 `run_state` 是快照的纯函数（v1.1 修订，PC-CX-03）

v1 把合法状态写成一张**转移表**。这在混合 blocker 上会自相矛盾：Provider 掉线开一条 `owner = SYSTEM` 的 blocker，同时一个高风险动作开一条 `owner = USER` 的 blocker，`EXECUTING → BLOCKED` 与 `EXECUTING → AWAITING_HUMAN` 的触发条件**同时成立**，单值 `run_state` 无法同时等于两个值，最终值取决于实现遍历 blocker 的顺序。审查用 `PC-CX-01..08` 的 `PC-CX-03` 记下了这一条。

v1.1 的修订是**换掉状态的定义方式**，而不是给转移表补一条优先级备注：

> **RS0（冻结）**：`run_state` 不是"上一个状态 + 一条转移"，而是**当前快照的纯函数** `runStateOf(snapshot)`。它由下表的守卫**按序求值、首个为真者胜**（first match wins）。因此对同一份快照，任何实现、任何 blocker 遍历顺序、任何重放都得到**同一个** `run_state`。

| 序 | 守卫（只读 §6.1 的快照） | `run_state` |
|---:|---|---|
| 1 | `project.status ∈ {DONE, CANCELLED}` | `SETTLED` |
| 2 | 存在 open blocker 且 `owner = USER` | `AWAITING_HUMAN` |
| 3 | 存在 open blocker（其 `owner ∈ {SYSTEM, COORDINATOR}`） | `BLOCKED` |
| 4 | 存在未收敛的 `RUN_PROJECT_ACCEPTANCE` 动作 | `ACCEPTANCE` |
| 5 | 存在本项目 Task 的 LIVE Session（含本次 reconcile 刚派出的） | `EXECUTING` |
| 6 | 存在未出 verdict 的验证任务 | `AWAITING_VERIFICATION` |
| 7 | 恒真（兜底） | `PLANNING` |

优先级链一句话：`SETTLED ≻ AWAITING_HUMAN ≻ BLOCKED ≻ ACCEPTANCE ≻ EXECUTING ≻ AWAITING_VERIFICATION ≻ PLANNING`。

**为什么是这个顺序**，每一格都能从 v1 已冻结的条款读出来，不是新发明：

- **人优先于机器**（2 ≻ 3）：`AWAITING_HUMAN` 是唯一会让控制环停下自己的时钟的状态（§10.4），把它排在后面等于让一条 SYSTEM blocker 掩盖掉"有人被等着"。用户看不见的等待就是静默空转。
- **阻塞优先于在飞**（3 ≻ 5）：v1 §4.2 已经写死"`EXECUTING → BLOCKED` 有 Session 在飞时也成立 —— 被挡住的是下一步，不是当前这一步"。守卫顺序把这句话变成机械规则。
- **阻塞优先于验收**（3 ≻ 4）：v1 已有 `ACCEPTANCE → BLOCKED`。
- **在飞优先于待验证**（5 ≻ 6）：v1 已有"在飞归零，未收敛的只剩验证任务"才进 `AWAITING_VERIFICATION`。
- **`PLANNING` 是兜底而不是一个条件**：它的定义就是"其它六条都不成立"（§4.1）。

**转移的合法性（冻结，取代 v1 的转移表）**：

- **TS1**：**六个非终态之间的任意有序对都是合法转移**（30 个）。因为 `run_state` 是快照的纯函数，而六条守卫依赖的事实可以各自独立变化 —— 任何"这个转移不该发生"的枚举都只会在下一次事实组合变化时被证伪。v1 的转移表就是这样漏掉了 `AWAITING_HUMAN → BLOCKED`（USER blocker 被答复、SYSTEM blocker 还在）、`AWAITING_HUMAN → EXECUTING`、`BLOCKED → EXECUTING`、`AWAITING_VERIFICATION → BLOCKED` 等至少 15 个真实可达的组合。
- **TS2**：`非终态 → SETTLED` 当且仅当守卫 1 成立，即 `project.status` 被置为 `CANCELLED`（用户）或 `DONE`（须过 §13.4 的硬门）。
- **TS3**：`SETTLED → 非终态` 当且仅当 `project.status` 被改回 `OPEN`；落到哪个状态同样由守卫决定（例如重开时旧 blocker 仍 open ⇒ 直接落 `BLOCKED`，**不经过** `PLANNING`）。
- **TS4（`ILLEGAL_TRANSITION` 的新定义）**：v1 把它定义为"未列在转移表里的组合"，而转移表已被证明不完整。v1.1 定义为**两条**，都可直接查：
  1. 提交时持久化的 `run_state ≠ runStateOf(提交事务内重读的快照)`；
  2. 违反 TS2 / TS3（在 `project.status` 未终结时写入 `SETTLED`，或在其仍终结时写出非终态）。
  命中任一即拒绝提交并记 `ILLEGAL_TRANSITION` 审计行。

**RS1**：`runStateOf` **不读时钟、不读事件、不读上一个状态**。它唯一的输入是 §6.1 的快照。这是 S3（同 hash ⇒ 同决策）能成立的前提，也是 §19 的排列属性测试能写出来的前提。

### 4.3 全局不变量

02 的审查与 09/10 的测试都以这一节为准。

- **I1（分层，v1.2 收紧）**：`project.status` 的写入者恰好三种：**人**、§13.4 的验收动作、以及 §13.4 AE8 的**终态后事实写入所触发的原子重开**（`DONE → OPEN`）。第三种在 v1.1 里不存在，于是 `DONE` 之后任何 Task 变化都无法把项目拉回非终态（`PC-CX-13`）。`run_state` 仍然只由 reconcile 写。任何一处代码同时写这两列即为缺陷。
- **I2（唯一性）**：每个 Project 至多一个 Coordinator Agent（PAC T2）、至多一条**未结束**的 Coordinator Session（`project.coordinatorSessionId @unique`）、至多一个有效租约持有者（§8.1）。
- **I3（因果）**：`run_state` 的每一次变化都恰好来自一条已提交的 `project_decision`。没有审计行的状态变化是缺陷。
- **I4a（等待人工）**：`run_state = AWAITING_HUMAN` ⟺ 非 `SETTLED` ∧ 存在 `owner = USER` 的 open blocker。两个方向都要测。
- **I4b（阻塞，v1.1 收紧）**：`run_state = BLOCKED` ⟺ 非 `SETTLED` ∧ 存在 `owner ≠ USER` 的 open blocker ∧ **不**存在 `owner = USER` 的 open blocker。v1 的 I4 少了最后这个合取项，于是在混合 owner 的 blocker 集合上同时要求两个状态（PC-CX-03）。被 USER blocker 掩盖的非 USER blocker **仍然是 open 的**：它照常参与自动解除（§11.4）、照常参与 `nextWakeAt`（§10.4），只是不决定 `run_state`。
- **I8（纯函数，v1.1 新增）**：任何时刻持久化的 `run_state` 恒等于 `runStateOf` 对当次提交事务内快照的求值（§4.2 RS0）。等价的可测形式：把同一份 blocker 集合以任意排列输入，得到的 `run_state` 必须相同。
- **I9（派发互斥，v1.1 新增）**：同一 Task 在任何时刻至多有一条**占位中**的 Session（§7.7 D5 的定义）。这条不由任何一段服务代码保证，而由数据库唯一索引保证；因此它对人工入口、控制环入口、legacy sweep 入口与**任何版本的二进制**同时成立。
- **I10（DONE 与事实一致，v1.2 新增）**：任何已提交状态上，`project.status = DONE` ⟹ 存在一条 `decidedBy = COORDINATOR_AGENT`、逐条全 PASS、且 `acceptance_digest` 等于**对当前行重算**的 `acceptanceDigest` 的验收记录（§13.4 AE1）。这条由 §13.4 AE6/AE7 的项目行锁（写入侧）与 AE8 的原子重开（终态后侧）共同保证，可以对生产快照直接跑（`PC-CX-13`）。
- **I11（派发归属，v1.2 新增）**：任何占位中的 Session 都可归属到一个入口：`dispatch_origin = 'COORDINATOR'` ⟹ `project_action_id` 非空且该动作 `APPLIED`；`= 'USER'` ⟹ 人的显式动作，`project_action_id` 为 NULL；`= 'LEGACY_SWEEP'` ⟹ 该 Task 的 `dispatch_authority = 'LEGACY'`。三条都由 §7.7 D6 触发器的放行分支保证，因此对任何版本的二进制成立。**"谁派的"是一次列查询，不是一次考古**（`PC-CX-14`）。
- **I12（授权投影一致，v1.2 新增）**：任何**已提交状态**上，占位 Session 的 `dispatch_origin` 必须被该 Task **当前**的 `dispatch_authority` 按 D6 的谓词允许 —— 即 `COORDINATOR` 权的 Task 上不存在 `LEGACY_SWEEP` 占位，`LEGACY` 权的 Task 上不存在 `COORDINATOR` 占位。v1.1 的 D6 只让这条在 `INSERT` 那一刻成立，派发权随后被翻转就会破坏它（`PC-CX-09`）；v1.2 由 §7.7 D8 让它在每一个已提交状态上恒成立。
- **I5（不静默空转）**：`project.status = OPEN ∧ coordinatorEnabled ∧ run_state ∉ {AWAITING_HUMAN, SETTLED}` ⟹ `project_runtime.next_wake_at IS NOT NULL`。这是 AC3 的**可查询形式**（§10.3）。**v1.1 收紧**：`AWAITING_HUMAN` 的豁免不再是整个状态，而只是 §10.4 N-null 列出的那一种情形（全部 open blocker 都 `recovery = HUMAN` 且都已升级）；其余的 `AWAITING_HUMAN` 同样必须有 `next_wake_at`，由 §10.2 W4 的第 (ii) 支抓。
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
 3. 判定 run_state（§4.2 的守卫函数 `runStateOf`；输入只有快照）。
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

**需要语义判断的触发条件（封闭集合，v1.1 修订）**。v1 把它写成五条散文条件，其中第 3 条"一条 blocker 的 `owner = COORDINATOR`"与同一节紧接着的"一个任务失败不会自动开 turn"在 `TEST_FAILED`（v1 的默认 owner 恰好是 `COORDINATOR`）上正面冲突：第一次测试失败时两条规则给出相反的动作，不存在唯一确定的结果。审查记为 `PC-CX-06`。

v1.1 把触发条件改成一张**表**，每条有一个 `reasonCode`，并且第 3 条改为**读一个封闭的 kind 列表**而不是读 `owner`：

| `reasonCode` | 触发条件 | `turnFacts`（进入 `reasonDigest` 的快照投影，§7.3） |
|---|---|---|
| `REPLAN` | `runStateOf` = `PLANNING` 且没有任何可派发任务，且没有 open blocker（"图不够，需要重规划"） | 全部 Task 的 `(id, status, parentTaskId, dependsOnTaskIds, verifiesTaskId)` 排序摘要 |
| `VERDICT` | 出现 FAIL / INCONCLUSIVE 的验证 verdict，且 §13.2 的机械退回已完成 | `(verifierTaskId, verdict)` 排序摘要 |
| `BLOCKER_DECISION` | 存在一条 open blocker，其 kind ∈ **`{WHO_UNRESOLVED, MERGE_CONFLICT, VERIFICATION_FAILED, DEPENDENCY_CYCLE}`**（§11.2 中 `opensTurn = ✔` 的全部行），**且该 blocker `escalated_at IS NULL`**（§11.2 BL6，v1.2 新增） | 触发的那些 blocker 的 `(kind, subjectId, conditionVersion)` 排序摘要（TF2） |
| `ACCEPTANCE` | 全部 Task 收敛，准备进入 `ACCEPTANCE`（§13.4） | §13.4 的 `acceptanceDigest` |
| `MANUAL` | 用户显式要求（`user.manual_trigger`） | 触发事件的 `dedupeKey` |

**TU1（唯一规则）**：**是否开 turn 只由上表决定，不由 blocker 的 `owner` 决定。** `owner` 回答"谁能解决"，`opensTurn` 回答"控制环要不要为它叫醒协调器"，两者是两个问题。为防止它们各自漂移，§11.2 冻结一条可机械核对的双向约束 **BL4**：`opensTurn = ✔` ⟺ `owner = COORDINATOR`。上表第 3 行的四个 kind 因此**恰好**是 §11.2 中 `owner = COORDINATOR` 的全部行 —— 契约测试逐字比对这两处。

**TU2（任务失败永不开 turn）**：`TEST_FAILED` 在 v1.1 中 `owner = USER`、`opensTurn = ✘`，且**只在 `failureCount ≥ MAX_AUTO_RUN_FAILURES` 时才被创建**（§9.5 Q3 的表）。退避期内根本没有 blocker，只有一条写明理由的 `NOOP` 审计行和一个指向退避到期时刻的 `nextWakeAt`。于是 v1 的两条规则在 v1.1 里指向同一个动作：**不开 turn**。失败有既有的退避与重试（§9.5），协调器不是重试机制。这是对既有 foreman 事故的直接吸取：一个"停滞就派一个协调者"的规则在停滞无法被协调者解决时会永远重派。

**TU3（同一原因不重复开 turn，PC-CX-07）**：见 §7.6 与 §7.3 的 `OPEN_COORDINATOR_TURN` 前置条件与 §10.4 的限频。要害是**限频与幂等是两个概念**：限频看粗粒度的 `reasonCode`，幂等看细粒度的 `reasonDigest`。

**TF1（`turnFacts` 的排除集，v1.2 冻结，PC-CX-10）**：`turnFacts` 只能由快照里的**当前事实**构成。下列各项**一律不得**出现在 `turnFacts`（因而不得出现在 `reasonDigest` 里）：

1. **投递与观测计数**：blocker 的 `occurrences`、事件的 `occurrences`、`project_event.attempts`、本次消费的事件条数；
2. **墙钟**：`first_seen_at` / `last_seen_at` / `escalated_at` / `snapshotAt` / 任何 `now()`；
3. 任何**自增序号**（除 id 本身）。

判据是一句可测的话：**把同一份世界状态重复投递 N 次、乱序投递、或重启后重投，`turnFacts` 必须逐字节相同。** v1.1 把 blocker 的 `occurrences` 放进了 `BLOCKER_DECISION` 的 `turnFacts`，于是同一个合并冲突每被观测一次就换一个 `reasonDigest`：TR1 把它当"事实变了"，TR3 的 no-progress 判定永远命中不了，每 60 秒（TR2 的限频窗）就能合法地再开一个 turn —— 这正是 E1"事件是信号不是事实"要禁止的东西，从后门回来了。审查记为 `PC-CX-10`。

**TF2（`conditionVersion`，v1.2 冻结）**：blocker 进入 `turnFacts` 的那一项是 `project_blocker.condition_version` —— **产生这条 blocker 的那些快照事实**的规范化摘要，而不是它被看见过几次：

- `MERGE_CONFLICT`：`(targetBranch, sorted(冲突路径集合), 冲突侧内容摘要)`；
- `VERIFICATION_FAILED`：`(verifierTaskId, verifiesTaskId, verdict)`；
- `WHO_UNRESOLVED`：`(taskId, 解析链停在哪一步, 缺失的那个输入)`；
- `DEPENDENCY_CYCLE`：`sorted(环上的 taskId 集合)`。

v1.1 这一格里的第三项是 `occurrences`，v1.2 换成 `conditionVersion`；本表的 `turnFacts` 列此后**逐字**受 TF1 的排除集约束，契约测试直接扫这一列。

`condition_version` 在开 blocker 时计算；§11.3 的同因重复命中已存在的 open 行时，`occurrences += 1` 且 **`condition_version` 按当前事实重算并覆盖**。于是"同一个 subject 上条件真的变了"（冲突文件集变了、verdict 变了）与"同一条件被再看见一次"第一次可以被机械区分：前者换 digest 并合法获得新 turn，后者不换。`occurrences` 保留它唯一的职责 —— 升级阈值（§11.5），**不进任何幂等键**。

**除此之外不开 turn。**

### 7.3 动作表（冻结）

**机械动作**

| type | 作用 | 幂等键（§8.2） | 前置条件 |
|---|---|---|---|
| `DISPATCH_TASK` | 把一个已授权的 Task 变成一次 Session | `pc:v1:<projectId>:dispatch:<taskId>:<attempt>` | §7.4 全部满足 |
| `OPEN_COORDINATOR_TURN` | 唤醒 Coordinator Agent | `pc:v1:<projectId>:turn:<generation>:<reasonDigest>` | 存在活的 Coordinator Session；§7.6 的 TR1–TR3 全部满足 |
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

**A4（v1.1 新增）**：第 4 条（"没有在飞 Session"）是**乐观前置**，不是互斥。它读的是快照，而快照读与 session 插入之间存在人工入口和其它进程的写窗口。真正的互斥是 §7.7 的数据库 primitive；第 4 条只负责在绝大多数情况下避免白跑一次冲突。**任何把第 4 条当成互斥的实现都是 `PC-CX-01`。**

### 7.5 Coordinator Session 轮换（AC1 / AC9）

- **身份稳定**：轮换只换 Session，**Coordinator Agent（`project_member.role = COORDINATOR`）不变**。`coordinator_generation` +1。
- **落点固定**：新 Session 必须开在 `project.coordinatorWorkspaceId`。既有 schema 已冻结"第二次请求指定不同 workspace 是 409，不是静默迁移"，控制环**不得**绕过它 —— 轮换不是迁移。若该 workspace 已被软删/离线，**不换地方**，改为开一条 `COORDINATOR_UNAVAILABLE` blocker（`owner = USER`，所需动作="重新绑定协调 Workspace"）。
- **触发条件**：旧 Session 终结（`session.ended` / `session.failed`）、被用户删除（`coordinatorSessionId` 被 SetNull）、或连续 N 次 turn 失败。
- **历史可追溯**：`project_decision.coordinator_session_id` 保留每次决策**当时**的 Session id，因此轮换后仍能按代数回放历史。`project.coordinatorSessionId` 只是"现在是哪一条"。
- **`@unique` 的处理**：`coordinatorSessionId` 是唯一索引，轮换必须在**同一事务**里清旧、写新，否则并发轮换会撞唯一约束并把项目卡在无协调器状态。

### 7.6 `OPEN_COORDINATOR_TURN` 的三条前置（v1.1 新增，PC-CX-07）

v1 用一个永久唯一的 `turn:<generation>:<reasonDigest>` 同时表达"幂等"和"60 秒内至多一次"。这两件事不相容：`generation` 只在 Session 轮换时前进，于是"同一代、同一原因"在这条 Session 的整个生命周期里**只能开一次 turn**。审查给的最小反例是合并冲突：第一次 turn 没解决，冲突还在，快照仍然要求同一个语义判断，而键永久冲突 —— 控制环从此对这条冲突彻底沉默。

v1.1 把它拆成三条互不重叠的前置：

- **TR1（幂等，细粒度）**：`reasonDigest = sha256(reasonCode ‖ canonical(turnFacts))`，`turnFacts` 由 §7.2 的表逐 `reasonCode` 冻结，并且**必须满足 §7.2 TF1 的排除集**（v1.2）。**事实变了，键就变了**；事实没变，键就没变。这让"重复事件"与"世界真的变了"第一次可以被机械区分 —— 前提是 `turnFacts` 里没有一个会随投递次数前进的计数器，否则这条区分就被自己废掉了（`PC-CX-10`）。
- **TR2（限频，粗粒度）**：同一 `(generation, reasonCode)` 在 **60 秒**内至多一次 —— 注意是 `reasonCode` 而不是 `reasonDigest`。若限频也按 digest 算，一个每 5 秒变一次事实的项目就能每 5 秒开一次 turn，限频形同虚设。这条对应 §10.4 的"最小间隔"行。
- **TR3（无进展即转 blocker）**：若已存在同一 `(generation, reasonDigest)` 的 `OPEN_COORDINATOR_TURN` 动作，**且它对应的 turn 已经结束**，那么按 TR1 的定义，上一次 turn **没有改变它自己被叫醒的那些事实**。此时：
  1. **不再开 turn**（否则就是 foreman 事故的形状）；
  2. 开一条 `COORDINATOR_NO_PROGRESS` blocker（§11.2，`owner = USER`、`recovery = HUMAN`、`opensTurn = ✘`），`subject` 指向该 `reasonDigest`，`detail` 带上 `reasonCode` 与上一次 turn 的 Session id；
  3. 该 blocker 的自动解除条件就是 **`reasonDigest` 变了**（§11.4 的重算，BL3）—— 事实一变，旧 digest 不再成立，blocker 自动 clear，新 digest 自然获得一次新的 turn。

  若同一 digest 的上一次 turn **还在飞**，则命中 TR1 的幂等键冲突，按 §8.5 记 `ALREADY_APPLIED` 并继续提交本次 outcome，**不开** `COORDINATOR_NO_PROGRESS`（还没结束，谈不上没进展）。

**TR-note**：`attempt` 计数在 v1.1 中**没有**出现在 turn 的键里，这是刻意的。审查允许"可前进的 attempt/window epoch"或"首次 turn 未改变事实即转 blocker"两种解法之一；后者更强 —— 它不需要一个会永远前进的计数器，且把"协调器解决不了这件事"变成一个**看得见的、有责任人的状态**，而不是一串越来越稀疏的重试。

### 7.7 派发的线性化点（v1.1 新增，PC-CX-01 / PC-CX-02）

v1 有三个可以为同一个 Task 创建 Session 的入口：**人工"开始执行"**、**控制环 `DISPATCH_TASK`**、**legacy 三条 sweep**。v1 只用 `project_action.idempotency_key` 去重了其中**一个**入口（控制环自己），而人工入口从不写这个键；`§12.3 D3` 又明确人工入口不受 `dispatch_authority` 约束。于是两个入口各自读到"没有在飞 Session"、各自插入一条 Session，同一个 Task 有两条 live Session。既有代码正是这个形状：`TasksService.runWorkspaceOnTask` 是一次 `findFirst` 再 `create` 的 check-then-act。

**冻结的结论：动作账本只能去重"同一个动作"，它在结构上无法做跨入口互斥。跨入口互斥必须落在所有入口共同经过的那一层 —— 数据库。**

#### D5 · Task Execution Claim（唯一索引）

```sql
-- 一个 Task 至多一条"占位中"的 Session。占位集合 = {PENDING, RUNNING}，与既有
-- SINGLE_RUN_DEDUP 逐字相同：这两个状态是"已经有一次运行占着这个 Task"的全部含义，
-- 而 AWAITING_INPUT / INTERRUPTED 是空闲的，既有路径对它们走 resume（不插行，
-- 因此不产生索引冲突），控制环对它们走 AWAITING_USER_INPUT blocker（§11.2）。
CREATE UNIQUE INDEX session_task_execution_claim_idx
    ON session (task_id)
 WHERE task_id IS NOT NULL
   AND deleted_at IS NULL
   AND status IN ('PENDING', 'RUNNING');
```

**这条索引就是全文唯一的 task 级派发线性化点。** 两个并发事务插入同一个 `task_id` 时，后到者在索引上阻塞，直到先到者提交或回滚；提交则后到者拿到唯一冲突。**线性化点因此是索引插入本身**，不是任何一段应用代码。

**每个入口在冲突时的确定性结果（冻结）**：

| 入口 | 插入方式 | 冲突时 | 对外结果 |
|---|---|---|---|
| 控制环 `DISPATCH_TASK` | `INSERT … ON CONFLICT DO NOTHING RETURNING id`（§8.5） | 返回 0 行 | `project_action.status = SUPERSEDED`、`refusal_code = TASK_ALREADY_RUNNING`；**本次事务照常提交**（事件被消费、blocker/decision/nextWake 落库）；`nextWakeAt = now + 60s` |
| 人工"开始执行" | 同上 | 返回 0 行 | 返回**既有的那条 Session**（与既有"重复点击 no-op"一致），**不是** 409、更不是 500 |
| legacy sweep | 同上 | 返回 0 行 | 跳过该 Task，本轮不记失败（sweep 的下一轮会重新求值） |

**D5-a**：三个入口**都**必须用 `ON CONFLICT DO NOTHING RETURNING`，不允许任何一个靠捕获唯一约束异常来实现 —— 异常会中止整个事务，把 `PC-CX-01` 修成 `PC-CX-04`（见 §8.5）。
**D5-b**：`ON CONFLICT` 对 partial unique index 的推断必须**逐字重复索引谓词**（`ON CONFLICT (task_id) WHERE task_id IS NOT NULL AND deleted_at IS NULL AND status IN ('PENDING','RUNNING') DO NOTHING`），否则 Postgres 推断不到索引而报错。Prisma 表达不了这个形状，因此这三处是 `$executeRaw`。**既有教训**：裸 SQL 躲得过编译期检查，构建通过 ≠ 改对了，所以这三处必须有跑在真实数据库上的测试，不能只有类型检查。
**D5-c**：迁移建索引前必须先**收敛存量重复**：对每个 Task 保留 `created_at` 最新的一条占位中 Session，其余置 `CANCELLED` 且 `end_reason = 'duplicate_live_session_reconciled'`，并把受影响的 id 数量打进迁移输出（§12.1 步骤 3b）。**不先收敛就建索引 = 迁移在生产上直接失败。**

#### D6 · Dispatch Authority Guard（触发器）

D5 保证"至多一条"，但不保证"**由谁**创建的那一条"。滚动升级窗口里的旧 apiserver 既不认识 `dispatch_authority`（它的 sweep SQL 没有那个条件），也不参与 `project_runtime` 的租约，因此 fencing token 对它完全无效 —— 它可以合法地抢到 D5 的那唯一一条，把一个本该由控制环派的任务按 legacy 规则派出去。这就是 `PC-CX-02`：**不是重复派发，是越权派发**，而且 D5 无法区分。

```sql
-- session.dispatch_origin: 'USER' | 'COORDINATOR' | 'LEGACY_SWEEP'，DB 默认 'LEGACY_SWEEP'。
-- 旧二进制不认识这一列，插入时落默认值 —— 因此它一定被下面的触发器挡住。
CREATE OR REPLACE FUNCTION session_dispatch_authority_guard() RETURNS trigger AS $$
DECLARE authority text;
BEGIN
  IF NEW.task_id IS NULL THEN RETURN NEW; END IF;
  -- v1.2（PC-CX-09）：`FOR SHARE` 不是谨慎，是这条硬门成立的**前提**。普通 SELECT 在 MVCC 下
  -- 读的是"本语句快照可见的最新已提交版本"，因此一个尚未提交的 `UPDATE task SET
  -- dispatch_authority='COORDINATOR'` 对它完全不可见 —— 触发器读到旧的 'LEGACY' 并放行，两个
  -- 事务随后都提交，得到 "COORDINATOR 权 + LEGACY_SWEEP 占位" 的状态，而 D5 察觉不到（只有一条）。
  -- `FOR SHARE` 与普通 UPDATE 自动取得的 `FOR NO KEY UPDATE` **相冲突**（Postgres 行级锁冲突表），
  -- 于是两个事务在 task 行上被强制排序；READ COMMITTED 下等到锁时会按 EvalPlanQual 重取该行的
  -- **最新**版本，因此本 SELECT 一定读到翻转后的值。见 §7.7 D8。
  SELECT t.dispatch_authority INTO authority FROM task t WHERE t.id = NEW.task_id FOR SHARE;
  IF authority IS DISTINCT FROM 'COORDINATOR' THEN
    -- LEGACY 权的任务：只拒绝"冒充控制环"的插入，其余照旧，legacy 路径逐字节不变。
    IF NEW.dispatch_origin = 'COORDINATOR' THEN
      RAISE EXCEPTION 'DISPATCH_AUTHORITY_VIOLATION: coordinator dispatch on a LEGACY task %', NEW.task_id;
    END IF;
    RETURN NEW;
  END IF;
  -- COORDINATOR 权的任务：只有两种插入合法。
  IF NEW.dispatch_origin = 'USER' THEN RETURN NEW; END IF;                    -- D3：人的显式动作
  IF NEW.dispatch_origin = 'COORDINATOR' AND NEW.project_action_id IS NOT NULL THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'DISPATCH_AUTHORITY_VIOLATION: task % is COORDINATOR-authority', NEW.task_id;
END;
$$ LANGUAGE plpgsql;
```

**D6-a**：触发器是**唯一**对旧二进制也成立的授权硬门。它同时挡住两个方向：旧 sweep 派 `COORDINATOR` 权的任务（`dispatch_origin` 落默认值 `LEGACY_SWEEP` ⇒ 拒绝），和控制环派 `LEGACY` 权的任务（越界的另一半）。
**D6-b**：触发器抛异常会中止那一个入口的事务 —— 这是**故意的**，而且只对越权入口成立：控制环与人工入口在正常情况下永远不会触发它。旧二进制在回滚窗口里会因此看到派发失败并记错误日志，**这是可见的失败，不是静默的双重派发**，是本条要买的东西。
**D6-c**：新二进制的人工入口必须显式写 `dispatch_origin = 'USER'`。忘了写 = 落 DB 默认 `LEGACY_SWEEP` = 对 `COORDINATOR` 权任务立即失败。**fail closed，且在第一次点击时就暴露**，不会拖到生产。

#### D8 · 派发权切换协议（v1.2 新增，PC-CX-09）

D6 的触发器现在会在 task 行上取 `FOR SHARE`；这一条冻结**另一侧**的义务，两侧合起来才构成一个"数据库可证明的共同线性化点"。

**D8-a（唯一 primitive）**：`dispatch_authority` 的**每一个**写入点（§12.3 D3 的三处）都必须先在同一事务里对目标 task 行取 `FOR NO KEY UPDATE`，**再**读该 Task 的占位情况，**最后**才写。顺序不可交换：先读后锁会读到一份可能在等锁期间被别人改掉的事实。任何一个不走这个 primitive 的写入点都让 I12 失效。

```sql
BEGIN;
  -- 1) 先锁，按 id 升序（D8-c）。普通 UPDATE 自动取的就是这把锁，因此**任何版本的二进制**
  --    在改这一列时都会与 D6 的 FOR SHARE 互斥 —— 这一半的正确性不依赖代码，依赖 Postgres。
  SELECT id FROM task
   WHERE project_id = :p AND id = ANY(:ids)
   ORDER BY id
     FOR NO KEY UPDATE;

  -- 2) 锁已持有，这是一条**新语句**，READ COMMITTED 会取新快照 —— 因此它看得见每一个
  --    "在我们等锁期间提交"的占位插入。反过来，此刻不可能有新的占位插入正在进行：
  --    它的 BEFORE INSERT 触发器会卡在 FOR SHARE 上，直到本事务结束。
  UPDATE task SET dispatch_authority = :next
   WHERE id = ANY(:ids)
     AND NOT EXISTS (SELECT 1 FROM session s
                      WHERE s.task_id = task.id AND s.deleted_at IS NULL
                        AND s.status IN ('PENDING','RUNNING'));
COMMIT;
```

**D8-b（持有占位的 Task 不翻转，两个方向都不）**：上面的 `NOT EXISTS` 是本条的全部内容。一个正在被占位的 Task **保持它当前的派发权**，直到占位释放；释放它的那个事务（Session 落终态）在**同一事务**里补做这次投影（§12.3 D3 的第三个写入点）。于是不存在任何一个已提交状态含有"授权与占位来源不匹配"的组合（I12），也不需要去取消一条已经在跑的 Session —— **控制环从不因为一次投影变更去杀掉别人已经启动的运行**。为什么补投影没有窗口：释放占位与翻转授权在同一个事务里，因此任何 legacy sweep 的插入要么排在它前面（Task 仍是 `LEGACY`，但占位还在，被 D5 挡住），要么排在它后面（Task 已是 `COORDINATOR`，被 D6 挡住）。

**D8-c（锁序）**：批量翻转按 `task.id` **升序**取锁；一次插入多条 Session 的事务（batch execute）同样按 `task_id` 升序插入。两个方向用同一个全序，因此不会互相死锁。若仍撞上死锁，Postgres 会中止其中一个 —— 那是 fail closed，不是正确性问题。

**D8-d（隔离级别）**：本协议在 `READ COMMITTED` 下成立，靠的是"等锁后重取最新行版本"。若某个入口跑在 `REPEATABLE READ` 下，`FOR SHARE` 撞上并发更新会直接抛 `40001` 序列化失败并中止**那一个入口**的事务 —— 同样 fail closed。两种隔离级别下都不存在"读到旧授权并放行"的第三种结果。

**D8-note**：为什么不给 task 加一个 `authority_generation` 再做 CAS：generation 也要被读出来才能比较，而**普通读在 MVCC 下看不见未提交的写**，正是 `PC-CX-09` 本身。缺的从来不是一个版本号，是一次**冲突的锁**。加列只会让人以为问题解决了。

#### D7 · Rollout 顺序（运维层，不承担正确性）

1. **阶段 A**：上线**只认识派发权、不能启用 Coordinator** 的兼容版本 —— 迁移已加列/索引/触发器，三条 legacy sweep 已追加 `AND dispatch_authority = 'LEGACY'`（D1），但服务层仍拒绝把任何 Project 的 `coordinatorEnabled` 置为 true。此时**不存在**任何 `COORDINATOR` 权的 Task，触发器恒不命中。
2. **阶段 B**：阶段 A 全量完成后，放开 `coordinatorEnabled`（G3 要求同时显式选策略）。
3. **回滚**：允许回到阶段 A 的二进制；此时可能已存在 `COORDINATOR` 权的 Task，由 D6 的触发器兜底。

**D7-note（必须写明白）**："所有旧实例都已退出" **不是一个数据库可以观测的事实**，因此它不能被当作正确性前提，只能是运维顺序建议。v1 的 §12.4 恰恰把它当成了前提。v1.1 的正确性完全由 D5 + D6 承担，D7 只负责让阶段 A 期间**连错误日志都不会出现**。这也是本项目**不**引入 apiserver 实例注册表的理由：一张只能"大概"回答问题的表，会诱使下一个人把它当成硬门。

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
  - `dispatch` 的 epoch = **`task.dispatch_attempt`**（v1.2；见 DA1–DA3）。v1.1 用的是 `task.failureCount`，而 §19.6 的恢复路径又要求人处理之后把失败计数**清零** —— 于是下一次派发重新算出 `…:dispatch:<taskId>:0`，撞上历史上那条早已 `APPLIED` 的动作行，被 §8.5 判为"已做过"并跳过副作用。每次 reconcile 都得到同一结果，**这个 Task 从此永远无法再被派发**。审查记为 `PC-CX-11`。
  - `turn` 的 epoch = `coordinator_generation` + 唤醒原因摘要（同一原因在同一代里只开一次 turn）。
  - `aggregate` 的 epoch = 子任务状态集合的摘要（子树没变就不重算）。
  - `blocker` **没有 epoch**：同因阻塞恒为同一键，这正是 AC8 的去重（§11.4）。
- **唯一约束**：`project_action.idempotency_key @unique`（全局唯一，不按项目分区 —— 键里已含 projectId）。

**DA1（`dispatch_attempt` 的语义，v1.2 冻结）**：`task.dispatch_attempt BigInt NOT NULL DEFAULT 0`，**单调递增、永不复用、任何路径都不得清零或回退** —— 包括 §19.6 那条"人处理后清零失败计数"的恢复路径。它不是"失败了几次"，是"这个 Task 被发起过几次派发动作"。历史行永不删除，因此**动作身份必须来自一个和历史一样只进不退的计数**；一个会被人为清零的计数不能同时充当动作身份。

**DA2（epoch 从快照读、在提交事务里前进）**：本次 reconcile 的键用**快照里读到的** `dispatch_attempt`；`+1` 只发生在**动作行插入成功**（§8.3 的 `ON CONFLICT … RETURNING` 返回非 0 行）的**同一个事务**里，与 fencing token 条件一起提交。两个推论都是要害：

- 同一份快照被重复 reconcile（重投的事件、接管者重看同一份事实）算出**同一个** epoch ⇒ 同一个键 ⇒ §8.5 的 `ALREADY_APPLIED` ⇒ 副作用恰好一次。**重复事件不前进 epoch。**
- 一次真正的新派发（退避到期后的重试、人处理后的再次派发）算出**新的** epoch ⇒ 新键 ⇒ 新 Session。**恢复永远不会撞上历史键。**

**DA3（两个计数各管各的）**：`failureCount` 只用于**策略** —— §9.2 矩阵的三条 `DISPATCH_TASK` 分档、§9.5 的退避与阈值；它**不再进入任何幂等键**。`dispatch_attempt` 只用于**动作身份**；它不参与任何策略判断。v1.1 让一个字段同时回答"该不该再试"和"这是第几次动作"，而这两个问题对"人工修复后清零"给出相反的答案，`PC-CX-11` 就是这个重叠的直接后果。

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

```sql
BEGIN;
  UPDATE project_runtime ... WHERE fencing_token = :token;              -- F1；影响 0 行是唯一的合法回滚理由
  INSERT INTO project_action (idempotency_key, ...) VALUES (...)
    ON CONFLICT (idempotency_key) DO NOTHING RETURNING id;              -- 0 行 = 已做过，见 §8.5
  -- 返回 0 行时：读出既有动作行，把它当作"已应用的输入"，跳过副作用，继续本事务。
  INSERT INTO session (..., project_action_id, dispatch_origin) VALUES (...)
    ON CONFLICT (task_id) WHERE ... DO NOTHING RETURNING id;            -- §7.7 D5 的 claim
  UPDATE project_action SET status = 'APPLIED' | 'SUPERSEDED', result_session_id = ... ;
  INSERT INTO project_decision ...;
  UPDATE project_event SET consumed_at = now() WHERE id = ANY(:ids);    -- 无论上面走了哪一支都要执行
COMMIT;
```

**得到的是真正的 exactly-once，而不是 at-least-once + 去重**：崩溃只可能发生在提交前（什么都没发生）或提交后（全都发生了）。`session.project_action_id` 加 `@unique`，让"这个动作有没有产生 Session"是一次索引查找而不是一次推理。

**X1**：**不允许出现"先做副作用再写键"的顺序**。那是 at-least-once，会在崩溃窗口里派出第二条 Session。
**X2（v1.1 修订）**：唯一键冲突 = **这个动作已经做过** = 本次 reconcile 对**该动作**视为成功（不是错误），**并且必须在同一事务里继续提交 outcome 的其余部分**。v1 在同一节里写了"冲突即已做过 → **整事务回滚**，视为成功"，那句话是错的：整事务回滚会把本次一同要提交的 `consumed_at`、blocker 变化、`nextWakeAt` 和审计行全部丢掉，事件因此永远消费不掉，控制环在这条事件上活锁。审查记为 `PC-CX-04`。冲突的正确处理在 **§8.5**。这条必须有测试：同一 `(snapshot, token)` 连跑两次，Session 只有一条**且第二次的事件被消费**。
**X3**：`OPEN_COORDINATOR_TURN` 的副作用是"往 Coordinator Session 投一条消息"，同样是数据库写（既有的消息入队），因此同一手法适用。

### 8.4 崩溃与接管恢复

| 崩溃点 | 恢复后发生什么 |
|---|---|
| 取租约后、读快照前 | 租约 60s 后过期 → 被接管 → 事件仍未消费 → 重新 reconcile |
| 快照读完、提交前 | 同上。**没有任何副作用发生过** |
| 提交事务中途 | Postgres 回滚。同上 |
| 提交后、释放租约前 | 租约自然过期。事件已消费、动作已 APPLIED，重投也会被幂等键挡住 |
| 进程被接管，旧进程又活了 | 旧进程的 `fencing_token` 已过期，它的任何提交影响 0 行并回滚（F1） |
| 提交事务撞到 §8.5 的三类唯一约束之一 | **不回滚**：该动作记 `ALREADY_APPLIED` / `SUPERSEDED`，outcome 其余部分照常提交，事件被消费 |
| Coordinator Session 在 turn 中途死 | `session.failed` 事件 → reconcile → §7.5 轮换 → 新 turn（同一 Agent，generation+1） |
| Runner 离线且带着在飞 Session | 既有 reaper 在无心跳 90s 后强杀 → `session.failed` 事件 → 正常失败路径（退避、blocker） |

**Y1**：恢复**不需要任何"重放日志"**。控制环的恢复方式是"重新看一眼当前状态"，因为 E1 让事件不携带事实。`project_decision` 是审计，不是恢复的输入 —— 这一点必须写死，否则会有人把审计行当状态源，于是审计变成不可裁剪的关键路径。

### 8.5 冲突提交协议（v1.1 新增，PC-CX-04）

一次 reconcile 的提交事务里有**三类**可能撞唯一约束的写入。它们的共同点是：**撞上意味着"这件事已经被做了"，而不是"这次 reconcile 失败了"**。

| 冲突类 | 约束 | 含义 |
|---|---|---|
| 动作键 | `project_action.idempotency_key` | 同一动作已被本次或更早的 reconcile 提交过（§8.2） |
| 派发占位 | `session_task_execution_claim_idx` | 该 Task 已经有一次运行占着（§7.7 D5） |
| blocker 去重 | `project_blocker_open_dedupe_idx` | 同因 blocker 已 open（§11.3） |

**C1（冻结）**：这三类写入**一律**用 `INSERT … ON CONFLICT … DO NOTHING RETURNING id`，**禁止**用"插入 + 捕获唯一约束异常"实现。理由是 Postgres 的语义而不是风格偏好：`INSERT` 抛出的唯一约束错误会把**整个事务**置为 aborted 状态，此后任何语句都只会得到 `current transaction is aborted`，于是"继续提交其余 outcome"在物理上不可能。C1 是把冲突从**异常**降级成**返回值**，只有这样"同一事务里继续走"才成立。

**C2（冻结）**：`RETURNING` 返回 0 行时的处理是确定的，且**永远不回滚**：

1. 在同一事务里读出既有的那一行（动作 / Session / blocker）。
2. 把它当作**已应用的输入**：本次 outcome 的对应条目记 `status = ALREADY_APPLIED`（动作已存在）或 `SUPERSEDED`（占位被别人拿走），带上既有行的 id 与 `refusal_code`。
3. **跳过对应的副作用**（不再插第二条 Session、不再投第二条消息）。
4. **继续提交 outcome 的全部其余部分** —— `blockersOpened` / `blockersCleared` / `project_decision` / `nextWakeAt` / `project_event.consumed_at` 一个都不能少。

**C3（唯一的合法回滚）**：整事务回滚的合法原因**恰好一个** —— §8.1 的 fencing token 条件影响 0 行，即本实例已被接管。此时回滚是对的：接管者持有更大的 token，它会重新 reconcile 同一份事实，而本实例什么都不该留下。

**C4（未分类异常，fail closed 但不活锁）**：C1 覆盖之外的任何异常都会 abort 事务，因此**不可能**在同一事务里补救。处理方式冻结为：

1. 让该事务回滚（事件因此**保持未消费**，`attempts += 1`、`next_attempt_at` 按 §5.4 退避）；
2. 另开一个**小事务**，同样带 fencing token 条件，开一条 `UNKNOWN_FAILURE` blocker（BL2 / F21），并写一条 `reconcile_failed` 审计行；
3. 第 2 步本身失败（例如 token 已失效）则什么都不做 —— 接管者会看到同一份事实。

这条与 §5.4 的"连续失败 10 次进 `DEAD` 且开 `UNKNOWN_FAILURE`"（F22）串在一起：单次失败退避重试，持续失败变成一个有责任人的 blocker，**都不会**变成一条永远消费不掉的事件。

**C5（可测形式）**：`PC-CX-04` 的最小反例必须被逐条断言，而不是只数 Session 条数 —— 预置动作 K，再提交一份**同时**包含 K、一条新事件 E、一次 blocker clear 和一次 `nextWakeAt` 变更的 outcome；提交后 E 必须 `consumed_at IS NOT NULL`、blocker 必须已 resolved、`nextWakeAt` 必须已前移、`project_action` 中 K 仍恰好一行。

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

**两个上限的恢复方式不同，因此持久化形式也不同（v1.1 修订，PC-CX-05）**：

| 上限 | 靠什么恢复 | 持久化 | `run_state` |
|---|---|---|---|
| `maxConcurrentTasks` | **事件**：任何一条在飞 Session 结束都会发 `session.ended`（§5.3） | 一条写明理由的 `NOOP` 审计行 + `nextWakeAt = now + 60s`（§10.4 第 4 条兜底）。**不开 blocker** —— 没有任何人需要做任何事，控制环也没有停 | `EXECUTING` |
| `sessionBudgetPerDay` | **时间**：最早一条计入记录滚出 24h 窗口 | `BUDGET_EXHAUSTED` blocker，`owner = SYSTEM`、`recovery = TIME`、`nextCheckAt` = 该窗口边界 | `BLOCKED` |

v1 把 `BUDGET_EXHAUSTED` 的 owner 写成 `USER`。那是一处**内部矛盾**：§4.1 在 `BLOCKED` 一行里就把"预算耗尽"列为"机器可能自行恢复"的例子，而 `owner = USER` 经 I4a 会把状态判成 `AWAITING_HUMAN`，再经 v1 §10.4 把 `nextWakeAt` 置为 `NULL` —— 于是一个**只需要等 6 小时**的预算窗口变成了一个**永远等不到人**的死等，没有任何定时器会去解除它。审查记为 `PC-CX-05`。v1.1 按 §4.1 自己的话把它改回 `SYSTEM` / `TIME`。

**用户想抬预算怎么办**：走升级（§11.5）。`BUDGET_EXHAUSTED` 反复出现（存活 > 30min 或 `occurrences > 10`）时按 `SYSTEM → COORDINATOR → USER` 升级，届时 `run_state` 才转 `AWAITING_HUMAN`。"这一次窗口满了" 和 "这个项目的预算长期不够" 是两件事，用同一条 blocker 的两个阶段表达，而不是用两个 owner 值猜。

超预算**不是**静默不派：无论走哪一行，都必然留下审计行或 blocker（BL1）。

**O-budget**：token / 费用预算不在 v1。runner 已上报 token 用量（context 指标），但没有可信的成本口径，一个算不准的预算比没有预算更危险。见 §17。

### 9.5 重试与退避

**控制环不新增第二套重试阶梯。** 直接复用既有的 `AUTO_RUN_RETRY_BACKOFF_MS` / `MAX_AUTO_RUN_FAILURES` / `QUOTA_BLIND_RETRY_BACKOFF_MS`。

**理由是一次真实事故**：这个部署里已经出现过"两个 60s 定时器重刷同一批失败任务"和"停滞就派一个协调者、于是每个停滞窗口派一个"两次失控派发。第二套退避会以完全相同的方式复现它。

**Q1**：`failureCount ≥ MAX_AUTO_RUN_FAILURES` 时，控制环**停止自动派发**并开一条 `owner = USER` 的 blocker，而不是继续以更长的间隔重试。
**Q2**：控制环的 `nextWakeAt` **不得**短于目标任务的退避剩余时间 —— 否则退避形同虚设，只是把 busy loop 从派发挪到了 reconcile。

**Q3（失败策略表，v1.1 新增，PC-CX-06）**：v1 只有 Q1 一句话，于是"退避期内的失败"处于无人认领的状态：§11.2 说 `TEST_FAILED` 的默认 owner 是 `COORDINATOR`，§7.2 说 `owner = COORDINATOR` 的 blocker 必须开 turn，同一节又说任务失败不得自动开 turn。第一次失败时三条规则给出两个相反的动作。v1.1 把它冻结成一张**逐行唯一**的表 —— 这是"一个任务失败之后会发生什么"的**唯一**规则来源：

| 情形 | blocker | `owner` | `recovery` | `opensTurn` | 该 Task 的 `run_state` 贡献 | 派发决定 |
|---|---|---|---|---|---|---|
| `failureCount = 0` | 无 | —— | —— | —— | 无（按其余守卫） | 可派发（§7.4） |
| `0 < failureCount < MAX`，**退避未到期** | **无** | —— | —— | —— | 无 | 不派；一条写明 `retry_backoff` 理由的 `NOOP` 审计行 + `nextWakeAt` = 退避到期时刻（Q2） |
| `0 < failureCount < MAX`，**退避已到期** | 无 | —— | —— | —— | 无 | 派发，键 `…:dispatch:<taskId>:<dispatchAttempt>`（§8.2 DA1–DA3，v1.2：epoch 是单调的派发次数，不是可清零的失败数） |
| `failureCount ≥ MAX` | `TEST_FAILED` | `USER` | `HUMAN` | ✘ | `AWAITING_HUMAN` | **停止自动派发**（Q1） |
| 失败归因不明（无法判定是测试、环境还是解析） | `UNKNOWN_FAILURE` | `USER` | `HUMAN` | ✘ | `AWAITING_HUMAN` | 停止本项目的自动派发（BL2 / F21） |

**Q3-a**：`TEST_FAILED` blocker **只在最后一行被创建**。退避期内**不开 blocker** —— 因为没有任何人需要做任何事，而且控制环并没有停：它安排了一次确定的重试。用一条 `NOOP` 审计行 + `nextWakeAt` 表达它，正是 BL1 给出的另一条合法出口。
**Q3-b**：`TEST_FAILED` 的 `owner` 因此恒为 `USER`，**不再是** `COORDINATOR`，`opensTurn` 恒为 ✘。§7.2 的两条规则由此指向同一个动作，`PC-CX-06` 的歧义消失。
**Q3-c**：这张表必须**表驱动实现并逐行测试**（同 P3）。首次失败、退避期内、退避到期、阈值失败、归因不明五行各一格，不允许写成一串 if。

**Q4（退避期的唯一权威状态，v1.2 新增，PC-CX-11）**：Q3 的"`run_state` 贡献"列写的是**这一个 Task 的贡献**（"无"），它**不是**项目的状态。项目的状态永远只有一个来源 —— §4.2 的 `runStateOf`。因此"一个任务正在退避"这件事本身**不决定**任何状态，最小场景的答案必须由守卫算出来：

| 场景（项目里只有这一个 Task） | `runStateOf` | `nextWakeAt` | 审计 |
|---|---|---|---|
| 该 Task 退避中，无 live Session，无 open blocker | **`PLANNING`**（守卫 7 兜底） | 退避到期时刻（§10.4 第 3 条） | 一条写明 `retry_backoff` 理由的 `NOOP` |
| 同上，但项目里另有 Task 的 Session 在飞 | `EXECUTING`（守卫 5） | `min(退避到期, now + 60s)` | 同上 |
| `failureCount ≥ MAX` ⇒ `TEST_FAILED`（`USER`/`HUMAN`） | `AWAITING_HUMAN`（守卫 2） | 升级到期时刻 | blocker |

v1.1 的 §19 汇总表把退避期的权威状态直接写成 `EXECUTING`，那是把"某个 Task 的贡献"误当成了"项目的状态"：在只有一个失败任务的最小场景里守卫 5 根本不成立，`runStateOf` 只能返回 `PLANNING`，于是同一个场景在两处得到两个答案（`PC-CX-11` 的后半）。**汇总表不是状态的来源，`runStateOf` 才是**；§20.3 的断言逐行核对这张表。

---

## 10. 活性 SLO

### 10.1 目标陈述（AC3）

> **一个 `status = OPEN`、`coordinatorEnabled = true`、且不在等待人工的 Project，在任何一次相关状态变化之后的 `L` 时间内，必须处于一个"可证明它没有空转"的状态。**

### 10.2 唤醒路径（**恰好三条**）

| 路径 | 延迟目标 | 说明 |
|---|---|---|
| **事件**（outbox 消费者 + `NOTIFY`） | p95 ≤ 5s，p99 ≤ 30s | 主路径 |
| **定时**（`next_wake_at <= now()` 的扫描） | 轮询 10s | 已知等待的恢复（退避、blocker 的 `nextCheckAt`、在飞会话可能结束） |
| **Backstop**（谓词见下方 W4） | 每 60s，一批上限 200 | **兜底，用来发现漏事件的 bug**，命中即记 WARN 审计 |

**W1（唯一定时器）**：这三条**共用同一个定时器**，顺序执行。**多加一个 `setInterval` 就是一次生产事故** —— 既有教训：`TasksService` 被两个 module 提供，reconciler 一分钟跑两次，症状是重复派发，查了一次线上事故才定位。09 单元必须有一条断言：整个 orchestration service 只注册一个定时器，且服务只被一个 module 提供。

**W2**：backstop 命中不是正常路径。它每命中一次都说明有一条事件该发没发，必须记 WARN 并计数 —— 这个计数是 08 单元故障注入的观测点。

**W4（backstop 谓词，v1.1 冻结，PC-CX-05）**：v1 的谓词是 `next_wake_at IS NULL OR next_wake_at < now() - 5min`，而 v1 又规定 `AWAITING_HUMAN` 的 `next_wake_at` **恒为** `NULL`。两条合起来的结果是：**每一个正常等待审批的项目，都会每 60 秒被当成一次"漏事件 bug"命中并记一条 WARN**。这直接毁掉 W2 的全部意义 —— 一个恒为真的告警等于没有告警。审查记为 `PC-CX-05` 的一半。

v1.1 把谓词写死成"**该有 wake 却没有**"，而不是"没有 wake"：

```sql
SELECT p.id
  FROM project p
  JOIN project_runtime r ON r.project_id = p.id
 WHERE p.status = 'OPEN' AND p.coordinator_enabled
   AND r.run_state <> 'SETTLED'
   AND (
         -- (i) 定时路径卡住了：到点很久还没被处理
         (r.next_wake_at IS NOT NULL AND r.next_wake_at < now() - interval '5 minutes')
         -- (ii) 停了自己的时钟，却不满足唯一被允许停钟的条件（§10.4 N-null）
      OR (r.next_wake_at IS NULL AND EXISTS (
            SELECT 1 FROM project_blocker b
             WHERE b.project_id = p.id AND b.resolved_at IS NULL
               AND (b.recovery <> 'HUMAN' OR b.escalated_at IS NULL)))
         -- (iii) 停了自己的时钟，而且一条 open blocker 都没有 —— 这就是静默空转本身
      OR (r.next_wake_at IS NULL AND NOT EXISTS (
            SELECT 1 FROM project_blocker b
             WHERE b.project_id = p.id AND b.resolved_at IS NULL))
       )
 ORDER BY r.next_wake_at NULLS FIRST
 LIMIT 200;
```

三支的含义各自独立：(i) 定时器路径坏了；(ii) 有还能自己恢复（`recovery ≠ HUMAN`）或还没升级过的 blocker，却没安排下次检查；(iii) 什么都没有 —— **这一支命中就是 AC3 说的静默空转，是 P0**。反过来，"全部 open blocker 都是 `recovery = HUMAN` 且都已升级过"的项目**不会**命中任何一支，因为对它而言时间确实无事可做，而它的状态在 §10.3 (c) 上仍然完全可见。

### 10.3 可判定的活性条件（这是测试直接查的东西）

对每个 `status = OPEN ∧ coordinatorEnabled ∧ run_state ∉ {AWAITING_HUMAN, SETTLED}` 的 Project，**下列至少一条为真**：

- **(a)** 存在一条本项目 Task 的 LIVE Session，**且它可归属**（I11）—— 要么是某条 `project_action(type = DISPATCH_TASK, status = APPLIED)` 的 `result_session`，要么 `dispatch_origin = 'USER'`。**v1.2 修订**：v1.1 只认前一支，于是"用户手动启动了唯一那个任务"这个完全正常的局面在活性查询上四条全不成立，被判 P0 违约（`PC-CX-14`）。人的显式动作是项目在推进的**证据**，不是漏洞；它不该被要求去伪装成一条控制环动作；
- **(b)** 存在一次在飞的 Coordinator Turn；
- **(c)** 存在 ≥1 条 open blocker，且**五个字段齐全**（§11.1）：`kind`、`owner`、`recovery`、`required_action`、`next_check_at`；
- **(d)** `project_runtime.next_wake_at` 非空且在未来，且 `next_wake_reason` 非空。

**四条全不成立 = 活性违约 = P0。** 10 与 22 单元把这条写成一个可以对生产快照直接跑的 SQL 断言。

### 10.4 时限（冻结）

| 量 | 目标 | 判据 |
|---|---|---|
| `L`（事件提交 → 上述四条之一成立） | **p95 ≤ 30s，p99 ≤ 120s，硬上限 5min** | 硬上限由 backstop 保证 |
| 一次机械 reconcile 墙钟 | p95 ≤ 2s，硬上限 5min（§6.3 R2） | —— |
| 一次 Coordinator Turn | 软上限 10min；超时记 `turn_timeout` 并按失败处理 | —— |
| `OPEN_COORDINATOR_TURN` 最小间隔 | **同一 `(generation, reasonCode)` 60s 内至多一次**（§7.6 TR2；v1 写的是"原因摘要"，v1.1 明确为粗粒度的 `reasonCode`） | 防 turn 风暴 |
| 租约 TTL / 续期 | 60s / 20s | §8.1 |

**`nextWakeAt` 的计算规则（v1.1 修订，PC-CX-05）**。v1 的第 6 条按 `run_state` 一刀切成 `NULL`，这与"USER blocker 也必须有 `next_check_at`，用于定时升级"（§11.1）以及"预算窗口自动恢复"（§9.4）**同时**矛盾：状态说不叫醒，另外两条说必须叫醒。v1.1 把决定权从 `run_state` 移到 blocker 的 **`recovery` 轴**（§11.1），因为"谁能解决"和"时间能不能解决"本来就是两个问题：

取所有**适用项的最小值**：

1. 每条 open blocker 且 `recovery ∈ {TIME, EVENT}` 的 `next_check_at` —— 这类 blocker 可以在没有人参与的情况下解除（预算窗口滚出、Provider 恢复、Runner 上线），因此**必须**有定时器去重算它；
2. 每条 open blocker 且 `escalated_at IS NULL` 的**升级到期时刻**（`first_seen_at + §11.5 的阈值`）—— **包括 `recovery = HUMAN` 的**。这就是 §11.1 说的"`owner = USER` 也必须有 `next_check_at`，用于升级"，它是一个升级闹钟，不是一次恢复轮询；
3. 最早一个处于失败退避中的 Task 的退避到期时刻（Q2）；
4. 最早一个 `runAt` 在未来的 Task 的 `runAt`；
5. 有在飞 Session 时：`now + 60s`（在飞会话结束本身会发事件，这只是兜底）；
6. 都没有且 `runStateOf` = `PLANNING`：`now + 60s`。

**N-null（`nextWakeAt` 允许为 `NULL` 的全部情形，封闭）**：

- `run_state = SETTLED`；或
- 上面 1–6 条**全部不适用**，等价于：存在 open blocker，且**每一条**都满足 `recovery = HUMAN` ∧ `escalated_at IS NOT NULL`（已经升级到人、且时间再做不了任何事），且没有退避中的任务、没有未来的 `runAt`、没有在飞 Session。

**其它任何情况下 `nextWakeAt` 为 `NULL` 都是缺陷**，由 §10.2 W4 的第 (ii)/(iii) 支当场抓住。注意这条与 I5 是同一件事的两种写法：I5 说"OPEN 且非等待人工 ⇒ 非空"，N-null 把"等待人工"里**还能靠时间前进的那部分**从豁免里剔了出来。

**N-mask（v1.1 补充）**：被 USER blocker 掩盖（I4b）的非 USER blocker **照常参与**第 1、2 条。状态可以被掩盖，时钟不可以 —— 否则一条审批 blocker 会顺手冻结掉同一项目里所有 Provider/Runner blocker 的自动恢复。

**W3**：`nextWakeAt` **永远不小于 `now + 5s`**。没有下限的"立刻再看一眼"就是 busy loop，10 单元的资源断言查的就是这个。

---

## 11. 结构化 Blocker

### 11.1 一条 blocker 必须回答五个问题（v1.1：第五个是新增的）

| 字段 | 回答 |
|---|---|
| `kind` | 出了什么事（封闭集合，§11.2） |
| `owner` | **谁能解决**：`USER` / `COORDINATOR` / `SYSTEM` |
| `recovery` | **什么东西能解除它**：`TIME`（时间到就没了）/ `EVENT`（世界变了就没了）/ `HUMAN`（只有人能解）。**v1.1 新增** |
| `required_action` | **要做什么**（一句可执行的人话，不是错误信息的复述） |
| `next_check_at` | **下次什么时候再看**（`owner = USER` 也必须有，用于升级，§11.5） |

**BL0（为什么 `owner` 不够，v1.1）**：v1 只有 `owner`，于是它被同时用来回答三个不同的问题 —— 谁负责、状态是什么（I4）、要不要定时叫醒（§10.4）。`BUDGET_EXHAUSTED` 就是被这么撞坏的：它的责任人像是用户（只有用户能抬预算），但解除它的是**时间**，而 v1 从 `owner = USER` 一路推出 `AWAITING_HUMAN` 和 `nextWakeAt = NULL`，把一个 6 小时后自动消失的等待变成了永久死等（`PC-CX-05`）。`recovery` 把"时钟"这一问从"责任人"里拆出来：

| | `run_state`（§4.2 守卫 2/3） | `nextWakeAt`（§10.4） | backstop（§10.2 W4） |
|---|---|---|---|
| 决定它的字段 | `owner` | `recovery` | `recovery` + `escalated_at` |


外加：`subject_type`/`subject_id`（哪个 Task / Runner / Provider）、`detail`（Json，展示与诊断）、`dedupe_key`、**`condition_version`（§7.2 TF2，v1.2 新增：产生这条 blocker 的那些快照事实的摘要 —— 它是"条件本身"，而 `occurrences` 是"这个条件被看见过几次"，两者必须分列）**、`first_seen_at`/`last_seen_at`/`occurrences`、`severity`、`escalated_at`、`resolved_at`/`resolved_by`。

**BL1**：**没有"静默跳过"这个选项**（继承 PAC §12 的同一句话）。控制环每一次"这一步没往前走"都必须落在一条 blocker 上，或者落在一条 `NOOP` 审计行上并说明理由。

### 11.2 kind 封闭集合 与 PAC §12 的映射

前六个 kind **就是** PAC §12 的错误码，同名同义 —— 派发被 PAC 的解析链拒绝时，拒绝码原样成为 blocker 的 kind。**不新造同义词**，否则两份契约会在同一件事上有两个名字。

| kind | 来源 | 默认 owner | `recovery` | `opensTurn` | 默认 `next_check_at` |
|---|---|---|---|:---:|---|
| `WHO_UNRESOLVED` | PAC §12 | `COORDINATOR` | `EVENT` | ✔ | +5min |
| `WHO_NOT_IN_TEAM` | PAC §12 | `USER` | `HUMAN` | ✘ | 升级到期（+1h） |
| `WHO_DISABLED` | PAC §12 | `USER` | `HUMAN` | ✘ | 升级到期（+1h） |
| `PROVIDER_UNAVAILABLE` | PAC §12 | `SYSTEM` | `EVENT` | ✘ | +5min |
| `RUNTIME_REQUIREMENT_UNMET` | PAC §12 | `USER` | `HUMAN` | ✘ | 升级到期（+15min） |
| `NO_PROJECT_WORKSPACE` | PAC §12 | `USER` | `HUMAN` | ✘ | 升级到期（+1h） |
| `NO_MATCHING_RUNNER` | 候选机器全部离线（能力满足但机器不在） | `SYSTEM` | `EVENT` | ✘ | +2min |
| `MERGE_CONFLICT` | `merge.conflict` | `COORDINATOR` | `EVENT` | ✔ | +10min |
| `TEST_FAILED` | 任务失败且 `failureCount ≥ MAX_AUTO_RUN_FAILURES`（§9.5 Q3；**退避期内不开**） | `USER` | `HUMAN` | ✘ | 升级到期（+1h） |
| `VERIFICATION_FAILED` | 验证任务给出 FAIL / INCONCLUSIVE | `COORDINATOR` | `EVENT` | ✔ | +5min |
| `BUDGET_EXHAUSTED` | §9.4 | `SYSTEM` | `TIME` | ✘ | 预算窗口边界 |
| `AWAITING_USER_APPROVAL` | `REQUEST_APPROVAL` | `USER` | `HUMAN` | ✘ | 升级到期（+24h） |
| `AWAITING_USER_INPUT` | 在飞 Session 停在 `AWAITING_INPUT` 且有待审批卡 | `USER` | `HUMAN` | ✘ | 升级到期（+24h） |
| `POLICY_MANUAL_HOLD` | `MANUAL` 策略下有可执行的下一步 | `USER` | `HUMAN` | ✘ | 升级到期（+24h） |
| `DEPENDENCY_CYCLE` | 依赖图不可达/成环 | `COORDINATOR` | `EVENT` | ✔ | +5min |
| `COORDINATOR_UNAVAILABLE` | 协调 Workspace 软删/离线，或轮换失败 | `USER` | `HUMAN` | ✘ | 升级到期（+15min） |
| `COORDINATOR_NO_PROGRESS` | §7.6 TR3：同一 `reasonDigest` 的上一次 turn 结束后事实未变 | `USER` | `HUMAN` | ✘ | 升级到期（+1h） |
| `UNKNOWN_FAILURE` | **兜底**：任何未归类的失败 | `USER` | `HUMAN` | ✘ | 升级到期（+30min） |

**BL4（v1.2 修订，可机械核对）**：`opensTurn` 是 **`kind` 的函数**，与那一行 blocker **当前**的 `owner` 无关。本表的 `默认 owner` 列同样是 kind 的常量，两列逐行满足

> `opensTurn = ✔` **当且仅当** `默认 owner = COORDINATOR`。

契约测试把本表的 `opensTurn = ✔` 行与 §7.2 `BLOCKER_DECISION` 行里的 kind 列表**逐字比对**。v1 之所以在 `TEST_FAILED` 上撞车（`PC-CX-06`），正是因为它把"要不要叫醒协调器"寄生在 `owner` 上，却又在别处按别的规则给 `owner` 赋值。

**v1.1 把 iff 挂在"当前 owner"上仍然不成立**：§11.5 的升级会**改写行上的 `owner`** 而 kind 不变，于是 `PROVIDER_UNAVAILABLE` 升级到 `COORDINATOR` 后是"owner = COORDINATOR 但 opensTurn = ✘"，`MERGE_CONFLICT` 升级到 `USER` 后是"owner = USER 但 opensTurn = ✔ —— 一边等着人，一边继续叫醒协调器"。两个方向都破坏双向等价（`PC-CX-12`）。v1.2 把三件事拆成三个轴，**每个轴只回答一个问题**（写成列表而不是表格：本节只允许有一张表，就是上面那张 kind 表，契约测试按行读它）：

1. **`kind` → `opensTurn`**（本表的常量列）：控制环要不要为它叫醒协调器。**升级不改 kind，因此不改这一列。**
2. **行上的 `owner`**（`project_blocker.owner`）：现在归谁 ⇒ `run_state`（§4.2 守卫 2/3）。**升级时变**（ES3）。
3. **行上的 `recovery`**（`project_blocker.recovery`）：什么能解除它 ⇒ 时钟（§10.4）。**升级不改**（ES1）。

**BL6（升级即交棒，v1.2 新增）**：§7.2 `BLOCKER_DECISION` 的触发条件除了 kind 在列表里，还要求 **`escalated_at IS NULL`**。含义很直白：升级到 `USER` 是"协调器这条路已经走过且没走通，现在归人"，此后再为同一条 blocker 叫醒协调器就是 foreman 事故的形状。于是"等着人"与"继续叫醒协调器"不可能同时为真 —— 不是靠优先级猜，是靠触发条件里多一个合取项。反过来，**升级不改 `opensTurn`**：kind 仍在列表里，这一行的 `opensTurn` 仍是 ✔，BL4 的逐字比对照常成立。

**BL5（`recovery` 与 `next_check_at` 的关系，冻结）**：

- `recovery = TIME`：`next_check_at` 是**恢复时刻**（窗口边界）。到点必然重算，重算必然解除（除非窗口又满了）。
- `recovery = EVENT`：`next_check_at` 是**重算轮询**。它只是兜底 —— 正常路径是事件唤醒后 §11.4 重算条件（BL3）。
- `recovery = HUMAN`：`next_check_at` 是**升级到期时刻**，**不是**恢复轮询。升级发生一次之后（`escalated_at` 非空），这条 blocker 不再贡献任何 `nextWakeAt`（§10.4 第 2 条只取 `escalated_at IS NULL` 的），项目因此可以合法地把自己的时钟停掉（N-null）而不被 backstop 判为 bug。

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

一条 blocker 在 `owner` 层面解决不了时升级到人。

- 触发：`occurrences` 或存活时长跨过阈值（默认：同一 blocker 存活 > 30min 或 `occurrences > 10`）。**升级到期时刻 = `first_seen_at + 30min`**，它是 §10.4 第 2 条唯一的 wake 来源。
- 升级即改 `owner` 并写 `escalated_at`；**每条 blocker 至多升级一次，且至多通知一次**（`escalated_at` 非空即不再通知）。这是"去重升级"的字面含义。
- **ES3（升级恰好一步，v1.2 修订，PC-CX-12）**：升级的目标**恒为 `USER`**，与它的默认 owner 是 `SYSTEM` 还是 `COORDINATOR` 无关。v1.1 写的是三级阶梯 `SYSTEM → COORDINATOR → USER`，但中间那一级在机械上**什么都不改变** —— §4.2 的守卫 3 把 `SYSTEM` 与 `COORDINATOR` 归为同一支（都是 `BLOCKED`），§10.4 的时钟只看 `recovery`，而 v1.2 的 `opensTurn` 只看 kind。一个不改变任何可观测事实的状态转移不该出现在冻结契约里：它唯一的作用是给下一个人一个"owner 变了、行为应该也变"的错觉，`PC-CX-12` 正是这样长出来的。对 `默认 owner = USER` 的 kind，30 分钟那一刻**不改 owner**（它已经在终点），只写 `escalated_at` 并通知一次 —— 这保住了 §10.4 第 2 条的闹钟语义与 N-null 的唯一合法停钟条件。
- 升级到 `USER` ⟹ `run_state` 转 `AWAITING_HUMAN`（I4a）。
- **ES1（v1.1）**：升级**只改 `owner`，不改 `recovery`**。一条 `BUDGET_EXHAUSTED` 升级到 `USER` 之后仍然是 `recovery = TIME`，因此仍然带着指向窗口边界的 `next_check_at`，仍然会自动解除 —— 升级表达的是"这件事反复发生，该有人看看了"，不是"从此只有人能解决它"。把这两件事混在一起正是 `PC-CX-05` 的成因。
- **ES2（v1.1）**：`escalated_at` 非空的 `recovery = HUMAN` blocker 是**唯一**允许项目停掉自己时钟的东西（§10.4 N-null）。因此"升级"在 v1.1 里有一个精确的机械含义：**把一个还在滴答的等待，变成一个已经通知过人、不再滴答的等待**。

---

## 12. 兼容矩阵

### 12.1 既有 Project（AC11）

迁移 `0111_project_coordinator`（一次迁移，理由同 PAC §15 第 8 条）：

| 步骤 | 内容 | 幂等性 |
|---|---|---|
| 1 | 建枚举 `ProjectRunState` / `ProjectAutomationPolicy` / `TaskCompletionPolicy` / `DispatchAuthority` / **`DispatchOrigin`** / **`BlockerRecovery`**；建表 `project_runtime` / `project_event` / `project_action` / `project_blocker` / `project_decision` | prisma migrate 单次 |
| 2 | 加列：`project.coordinator_enabled` / `automation_policy` / `max_concurrent_tasks` / `session_budget_per_day`；`task.completion_policy` / `dispatch_authority` / **`task.dispatch_attempt`（`BigInt NOT NULL DEFAULT 0`，§8.2 DA1，v1.2 新增）**；`session.project_action_id` / **`session.dispatch_origin`（DB 默认 `'LEGACY_SWEEP'`，§7.7 D6-a 依赖这个默认值）** | 全部**可空或有默认** |
| 3 | 为每个既有 Project 回填一行 `project_runtime`：`run_state = 'PLANNING'`、`fencing_token = 0`、`next_wake_at = NULL`、`coordinator_generation = 0` | `ON CONFLICT (project_id) DO NOTHING` |
| **3b** | **收敛存量重复占位**：对每个 `task_id`，保留 `created_at` 最新的一条 `status IN ('PENDING','RUNNING') AND deleted_at IS NULL` 的 Session，其余置 `status = 'CANCELLED'`、`end_reason = 'duplicate_live_session_reconciled'`；**把受影响行数打进迁移输出**（§7.7 D5-c）。**必须在步骤 6 建唯一索引之前**，否则迁移在生产上直接失败 | 幂等（再跑一次影响 0 行） |
| 4 | 既有 Project 一律 `coordinator_enabled = false`、`automation_policy = 'MANUAL'` | 列默认即如此（见 G1） |
| 5 | 既有 Task 一律 `dispatch_authority = 'LEGACY'`、`completion_policy = 'MANUAL'` | 列默认 |
| 6 | 建索引：`project_event (project_id, dedupe_key) WHERE consumed_at IS NULL`、`project_event (next_attempt_at) WHERE consumed_at IS NULL`、`project_blocker (project_id, dedupe_key) WHERE resolved_at IS NULL`、`project_runtime (next_wake_at) WHERE next_wake_at IS NOT NULL`、`project_action (idempotency_key)`、`project_decision (project_id, created_at DESC)`、**`session_task_execution_claim_idx`（§7.7 D5）** | `CREATE … IF NOT EXISTS` |
| **6b** | **建触发器** `session_dispatch_authority_guard`（§7.7 D6）。它必须与步骤 2 的 `session.dispatch_origin` 在**同一次迁移**里落地：只有列没有触发器等于没有硬门，只有触发器没有默认值等于旧二进制插不进任何 Session。**函数体里的 `FOR SHARE` 是 §7.7 D8 的一半，漏掉它整条 `PC-CX-09` 就回来了，而且不会有任何编译期或 `migrate diff` 的信号** | `CREATE OR REPLACE` + `DROP TRIGGER IF EXISTS` |
| 7 | **不含任何 `DROP COLUMN`** | 同 PAC M4 |

- **G1（关键）**：列默认值与"新建 Project 的默认"是**两个不同的值**，不能靠一个 `@default` 同时表达。`automation_policy` 的**数据库默认是 `MANUAL`**（保护存量），**服务层在创建新 Project 时显式写入 `GUARDED_AUTO`**。反过来做（默认 GUARDED_AUTO + 迁移里 UPDATE 存量）会在迁移与新代码上线之间留一个窗口，窗口里创建的项目全是自动的。同理 `coordinator_enabled` 数据库默认 `false`，新建时显式 `true`。**04 单元必须同时测这两条**：迁移后存量为 MANUAL/false，且新建为 GUARDED_AUTO/true。
- **G2**：迁移**不回填任何 blocker、不产生任何事件、不安排任何唤醒**。迁移完成的那一刻，控制环对存量项目**完全静默**。
- **G3**：用户为一个既有 Project 打开 `coordinatorEnabled` 时，服务层必须**同时**要求一个显式的 `automationPolicy`（不给默认），并在同一事务里产生一条 `user.policy_changed` 事件把它接进环里。"沿用安全默认"= 不动它；"明确选择策略" = 打开时必须选。
- **G4**：迁移必须在**空库**和**生产快照**上各跑一次、`migrate diff` 对新增列为空。验证手法照 PAC M3：一次性 throwaway postgres 跑 `prisma migrate deploy` + `migrate diff`，`grep` 自己新增的列名，而不是看 drift 总数。
- **G5（v1.1 新增，v1.2 扩充）**：步骤 3b / 6 / 6b 三件事**都不是 Prisma schema 能表达的**（partial unique index 的谓词、plpgsql 触发器、数据收敛），因此它们是迁移文件里的裸 SQL。**既有教训：裸 SQL 躲得过编译期检查** —— `prisma migrate diff` 也不会告诉你触发器没了。因此 04 单元的迁移验证必须**显式**查这三样东西存在（`pg_indexes` / `pg_trigger` / 收敛后每个 task 的占位 Session 计数 ≤ 1），而不是只看 `migrate diff` 为空。**v1.2 再加一条**：还要显式断言触发器函数体里含 `FOR SHARE`（`pg_get_functiondef` 上 grep），因为一个少了两个词的触发器与一个正确的触发器在 `pg_trigger` 里长得一模一样，而它们的差别正好是那个 P0。

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
- **D3（v1.2 修订）**：`dispatch_authority` 的写入点恰好**三处**，且**每一处都必须走 §7.7 D8-a 的 `FOR NO KEY UPDATE` → 读占位 → 写 的同一个 primitive**：
  1. Task 被填上 / 移出一个 `coordinatorEnabled = true` 的 `projectId`；
  2. Project 的 `coordinatorEnabled` 被切换（同一事务批量更新其 Task）；
  3. **（v1.2 新增）占位释放时的补投影**：一条占位 Session 落终态的那个事务，在**同一事务**里把该 Task 的 `dispatch_authority` 补齐到它应有的值。这一处存在的唯一理由是 D8-b —— 持有占位的 Task 在 1/2 里被跳过，总得有人在占位消失时把它补上，而"占位消失"这个事实只有那个事务知道。

  三处用同一个 primitive 不是整洁癖：D8-a 的正确性论证里"此刻不可能有新的占位插入正在进行"依赖**所有**授权写入者都持有那把与 D6 的 `FOR SHARE` 冲突的锁。漏掉任何一处，I12 在那一条路径上就不成立。**用户手动"开始执行"仍然不受 `dispatch_authority` 约束** —— 那是人的显式动作，走既有路径（`dispatch_origin = 'USER'`，D6 显式放行），并产生一条 `user.manual_trigger` 事件让控制环知道。
- **D4**：`task.autoRunWhenReady` 对 `COORDINATOR` 权的任务**无效**（它是 legacy sweep 的开关）。UI 必须据此说明，不能让用户以为关掉它就停了。
- **D5 / D6 / D7（v1.1 新增，见 §7.7）**：`dispatch_authority` 这一列本身只是一个**投影**，它回答"该由谁派"，但**不能**阻止别人派 —— 它只在读它的那个二进制里有效。真正阻止越权与重复的是 §7.7 的唯一索引（D5）与触发器（D6），D7 是让这两者在滚动升级期间连告警都不产生的部署顺序。**本节（§12.3）与 §7.7 的分工是：§12.3 说"应该由谁派"，§7.7 说"凭什么别人派不了"。** v1 只有前一半，因此 `PC-CX-02` 成立。

### 12.4 混合版本与客户端

| 组合 | 期望行为 |
|---|---|
| **新旧 apiserver 并存（滚动升级）** | 旧实例不认识 `project_event`，不消费；新实例正常消费。**新实例之间**由 fencing token 串行化（§8.1）；**新旧之间** fencing token 完全无效（旧实例根本不取租约），因此由 §7.7 的 D5 唯一索引（至多一条占位 Session）+ D6 触发器（`COORDINATOR` 权任务拒绝无派发权的插入）保证，两者都在数据库里执行，与二进制版本无关。D7 的两阶段部署使正常升级路径下连触发器都不会命中。**v1 在这一格里把"旧实例不消费事件"当成了"旧实例不会派发"，这两件事不相干** —— 旧实例的三条 legacy sweep 照样在跑（`PC-CX-02`）。19/22 单元必须构造"旧 sweep 查询 + 新 Coordinator + 同一个 Task"的场景，而不是两个新实例 |
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
| `INCONCLUSIVE` | 不退回、不建缺陷；开 `VERIFICATION_FAILED` blocker（`owner = COORDINATOR`），并触发 `OPEN_COORDINATOR_TURN`（§7.2 的 `VERDICT`） |

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
3. 产物是一条结构化验收记录（落在 `project_decision.detail` 里，`decidedBy = COORDINATOR_AGENT`）：逐条 `PASS/FAIL` + 证据（命令、关键输出、SHA、环境），**外加下面 AE1 的 `acceptanceDigest`**。
4. **全 PASS 才允许把 `project.status` 置 DONE**；任一 FAIL ⇒ 回 `PLANNING`/`BLOCKED`，产生新工作或新 blocker，**项目保持 OPEN**。
5. 标 DONE 这个写入本身**永远不是机械动作**（§9.2 最后一行）：它由用户，或由协调器在 turn 内以 Coordinator Agent 身份显式调用，且服务层在写入时**再次校验**（AE2）。**服务端校验是硬门，不是 UI 提示。**
6. **合并状态核对必须按内容验，不能只看 `--contains`**：既有教训 —— squash 合并后 `git branch --contains <sha>` 必然假阴性，要用 `git grep` 或 diff 比对内容。

#### 验收证据的新鲜度（v1.1 新增，PC-CX-08）

v1 的第 5 条只要求"**存在**一条全 PASS 的验收记录"。存在性没有时间轴：一条在快照 H1 上通过的记录，在用户改了验收标准、某个 Task 被退回重开、验证任务给出新的 FAIL、或目标分支内容变化之后**仍然存在**，于是它可以放行一个与它毫无关系的 `DONE`。审查记为 `PC-CX-08`。

**AE1（验收摘要，冻结）**：每条验收记录必须带一个 `acceptanceDigest`，它是**验收所依据的全部事实**的规范化摘要：

```
acceptanceDigest = sha256(canonical({
  v: 1,
  projectId,
  criteriaRevision : sha256(project.acceptance_criteria ?? ''),         // 用户改一个字就变
  taskSet          : sorted[(taskId, status, completionPolicy)],        // 重开/新建/删除任务就变
  verdicts         : sorted[(verifierTaskId, verifiesTaskId, verdict)], // 验证结论变就变
  mergeEvidence    : sorted[(requirementId, targetBranch, contentHash)] // 目标分支内容变就变
}))
```

- `contentHash` 按**内容**取（第 6 条），例如被要求的改动在目标分支上的 blob/tree 摘要或 `git grep` 归一化结果，**不是** `git branch --contains` 的布尔值，也不是 commit SHA —— squash 之后 SHA 必然对不上而内容仍在。
- `taskSet` 里带 `status` 而不只是 id：一个 Task 从 DONE 被改回 OPEN，id 集合没变，摘要必须变。

**AE2（DONE 的硬门，冻结）**：把 `project.status` 写成 `DONE` 的那个事务里，服务层必须**在同一个事务内**：

1. 用当前行**重新计算** `acceptanceDigest`（读 `project.acceptance_criteria`、全部 Task、全部 verdict、合并证据）；
2. 查找一条 `decidedBy = COORDINATOR_AGENT`、逐条全 PASS、且 `acceptance_digest = 刚算出来的那个值`的验收记录；
3. 找不到就**拒绝**，错误码 `ACCEPTANCE_EVIDENCE_STALE`（找到了全 PASS 记录但摘要不匹配）或 `ACCEPTANCE_MISSING`（压根没有）。

"存在一条全 PASS 记录" 因此被替换成 "**存在一条对当前这份事实成立的全 PASS 记录**"。

**AE3（并发，v1.2 修订）**：v1.1 说"同一个 `REPEATABLE READ` 事务，或对**读到的** Task 行加锁"，并声称并发重开"排在后面"时会被 `task.status_changed` 事件拉回 `PLANNING`。**两句都不成立**：

- `REPEATABLE READ` 只保证本事务的读一致，它**不阻止**另一个事务在另一些行上提交。`T_done` 写的是 `project` 行，`T_task` 写的是 `task` 行，两者**没有写冲突**，Postgres 的快照隔离因此不会中止任何一个 —— 提交后得到 `project.status = DONE + task.status = OPEN`。
- 锁住"**读到的**"Task 行也不够：`DONE` 提交之后**新建**一个 Task、或写一条新的 verdict，都不需要碰任何一条被锁过的行。
- 而"事件会把它拉回 `PLANNING`"依赖守卫会重算 —— 但 §4.2 守卫 1 对 `project.status = DONE` **无条件**返回 `SETTLED`，reconcile 永远走不到守卫 7。

审查记为 `PC-CX-13`。v1.2 用**一把共享的项目行锁**替掉这三句话，见 AE6/AE7/AE8。

**AE6（验收事实写入门，v1.2 冻结）**：下列写路径构成**封闭的"验收事实写入"集合** —— 恰好是能改变 AE1 那四个投影的那些写：

| 写路径 | 改变 `acceptanceDigest` 的哪一项 |
|---|---|
| Task 创建 / 删除 | `taskSet` |
| Task 状态变化（含验证退回的 `DONE → OPEN`） | `taskSet` |
| Task `completionPolicy` 变化 | `taskSet` |
| 验证 verdict 写入 / 改写 | `verdicts` |
| `project.acceptanceCriteria` 编辑 | `criteriaRevision` |
| 合并证据（目标分支内容摘要）写入 | `mergeEvidence` |

每一条**必须以 `SELECT 1 FROM project WHERE id = :p FOR SHARE` 作为事务的第一句**。`FOR SHARE` 之间互不冲突，因此这些写路径彼此**不排队**，日常写入没有额外代价；它唯一冲突的对象是 AE7 的 `FOR UPDATE`。不在这张表里的写（改标题、改描述、加标签）**不取这把锁**，因为它们改不了摘要，也就没有与 `DONE` 排序的必要。

**AE7（`DONE` 硬门取排他锁，v1.2 冻结）**：把 `project.status` 写成 `DONE` 的事务，**第一句**必须是 `SELECT … FROM project WHERE id = :p FOR UPDATE`，然后才执行 AE2 的三步。`FOR UPDATE` 与 AE6 的 `FOR SHARE` **相冲突**，因此：

- 任何一个已经开始、尚未提交的验收事实写入，都会让 `DONE` **等**到它提交为止 —— 然后 AE2 第 1 步的重算（锁已持有之后的一条**新语句**，READ COMMITTED 取新快照）必然看见它，摘要不匹配 ⇒ 拒绝；
- 任何一个在 `DONE` 之后到达的验收事实写入，都会**等**到 `DONE` 提交，然后走 AE8。

"两个事务都能提交"这个第三种结果因此在物理上不存在。这就是审查要的"共同线性化门"：**它是一把锁，不是一个约定**。

**AE8（终态后的事实写入 ⇒ 原子重开，v1.2 冻结）**：持有 AE6 那把 `FOR SHARE` 的写入者，在锁到手之后**必须重读 `project.status`**；若已是 `DONE`，它必须在**同一个事务**里把 `status` 改回 `OPEN`，并写一条 `user.project_edited` 事件与一行 `reopened_by_fact_change` 审计（记明是哪一项事实变了）。**不允许**提交一个"`DONE` + 与之不匹配的验收事实"的状态（I10）。

三条推论，每条都要测：

1. 守卫 1（`DONE ⇒ SETTLED`）**不需要放松**。v1.1 的漏洞不在守卫上 —— 守卫是对的，是那个状态组合本来就不该存在。把不一致的状态**变成不可达**，比让守卫去容忍它更强，也更好测：I10 是一条可以对生产快照直接跑的 SQL。
2. 重开走的是 TS3（`SETTLED → 非终态`），落到哪个状态由守卫重算，**不预设** `PLANNING`（例如仍有 open blocker 就直接落 `BLOCKED`）。
3. `CANCELLED` **不适用**本条：取消是人对"这个项目不做了"的决定，一个 Task 的状态变化不该把它撤销。AE6 的写入者读到 `CANCELLED` 时照常提交自己的写，**不重开**。

**AE4（不需要失效任务）**：**旧证据不需要被删除或标记失效** —— 它只是不再匹配。任何一项事实变化都会让摘要不同，因此过期证据在构造上不可用。这也意味着"改回去"是合法的：用户把验收标准改坏又改回来，摘要回到原值，原记录重新可用，这是正确的行为而不是漏洞。

**AE5（覆盖面）**：AE2 的硬门对**所有**写入路径成立 —— 用户在 Web 上点、CLI、MCP `project_update`、协调器在 turn 内调用，全部走同一段服务层校验。I1 说 `project.status` 只由人或 §13.4 的验收动作写，AE2 是那个"写"的唯一入口。

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

**总计**：业务字段 **5 个**（§2.2），新业务实体 **0 个**（§2.3），新基础设施表 **5 张** + 新列 **5 个**（§2.4）。
v1.1 相对 v1 只多了一列（`session.dispatch_origin`）与两个数据库约束对象（一个 partial unique index、一个 trigger，§2.4）。**新业务实体仍然是 0 个** —— 关闭两个 P0 靠的是把互斥挪进数据库，不是靠新概念。

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
| **F13** | 合并冲突 | `MERGE_CONFLICT` blocker（owner=COORDINATOR） | 开 turn 让协调器决定；同一 `reasonDigest` 的第二次请求转 `COORDINATOR_NO_PROGRESS` | §7.2 `BLOCKER_DECISION` · §7.6 TR3 |
| **F14** | 测试失败 / 任务运行失败 | 任务 FAILED + 失败计数 + 退避 | 复用既有退避阶梯；超上限转 `owner=USER` | §9.5 Q1 |
| **F15** | 验证 FAIL / INCONCLUSIVE | 被验证任务退回 OPEN + 缺陷子任务 + 下游阻断（FAIL）；仅 blocker（INCONCLUSIVE） | 修复后重跑验证 | §13.2 |
| **F16a** | 24h 会话预算耗尽 | `BUDGET_EXHAUSTED` blocker（`SYSTEM`/`TIME`），`next_check_at` = 窗口边界；`run_state = BLOCKED` | 窗口滚动后定时唤醒并自动解除 | §9.4 |
| **F16b** | 并发上限占满 | **无 blocker**：一条写明理由的 `NOOP` 审计行 + `nextWakeAt = now + 60s` | 任一在飞 Session 结束即发事件，自然恢复 | §9.4 |
| **F17** | 依赖成环 / 图不可达 | `DEPENDENCY_CYCLE` blocker，聚合停止 | 开 turn 重规划 | §13.1 AG2 |
| **F18** | Task 在飞时被删除 | 动作记 `SUPERSEDED`，不报错 | 下一次 reconcile 按新图继续 | §13.2 V6 |
| **F19** | Project 被删除 / 置 CANCELLED | 五张表 Cascade 清理；`run_state = SETTLED`；停止消费事件 | 无 | §2.4 |
| **F20** | 滚动升级：新旧 apiserver 并存 | 旧实例不消费 `project_event`；新实例之间由 token 串行化 | 无重复派发、无丢失 | §12.4 |
| **F21** | 未知/未分类失败 | `UNKNOWN_FAILURE` blocker，停止本项目自动派发 | 人处理 | §11.2 BL2 |
| **F22** | 事件消费连续失败 10 次 | 事件置 `DEAD` **且**开 `UNKNOWN_FAILURE` blocker | 人处理 | §5.4 |
| **F23** | 人工"开始执行"与控制环 `DISPATCH_TASK` 同时提交 | 该 Task 恰好一条占位 Session；败者留 `SUPERSEDED` 动作行（控制环）或返回既有 Session（人工） | 无需人工清理；控制环下一次 reconcile 按新事实继续 | §7.7 D5 |
| **F24** | 回滚窗口：旧二进制的 sweep 选中 `COORDINATOR` 权的 Task | 无 Session 被创建；旧实例侧一条 `DISPATCH_AUTHORITY_VIOLATION` 错误日志 | 无（新实例照常派发）；D7 的部署顺序使正常升级不出现这一格 | §7.7 D6 |
| **F25** | 同时存在 USER 与非 USER blocker | `run_state = AWAITING_HUMAN`（唯一值，与 blocker 输入顺序无关）；非 USER blocker 仍 open 且仍参与 `nextWakeAt` | USER blocker 被答复后按守卫重算，通常落 `BLOCKED` | §4.2 RS0 · I4a/I4b · N-mask |
| **F26** | 动作幂等键冲突，且同一 tick 还有未消费事件与 blocker/nextWake 变化 | 动作恰好一行且记 `ALREADY_APPLIED`；事件 `consumed_at` 非空；blocker 与 `nextWakeAt` 已提交 | 无需动作 | §8.5 C1/C2 |
| **F27** | 验收全 PASS 之后事实变化（标准 / 任务 / verdict / 合并内容） | `project.status` 仍为 `OPEN`；`DONE` 写入被拒，错误码 `ACCEPTANCE_EVIDENCE_STALE` | 重新验收，产生新摘要的记录 | §13.4 AE1/AE2 |

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

以下 6 条是 v1.1 为关闭 `PC-CX-01..08` 新增的：

15. **跨入口互斥落在数据库，不落在服务层**（§7.7 D5/D6）。要挡住的两个入口一个是"另一个进程的同一份代码"，一个是"另一个版本的旧代码"；服务层的检查按定义对第二个无效。代价是两处裸 SQL 与一个触发器，换来的是一条与二进制版本无关的不变量（I9）。
16. **"所有旧实例已退出"不作为正确性前提**（§7.7 D7-note）。它不是数据库能观测的事实。因此也**不**引入 apiserver 实例注册表 —— 一张只能"大概"回答问题的表会诱使下一个人把它当硬门。
17. **`run_state` 是快照的纯函数，转移表被守卫函数取代**（§4.2 RS0）。手写的转移表在混合事实上必然不完整（v1 的表漏了至少 15 个真实可达的组合），而守卫函数天然完备且顺序无关。
18. **`recovery` 从 `owner` 里拆出来**（§11.1 BL0）。"谁能解决"和"时间能不能解决"是两个问题，用一列回答两个问题会把"6 小时后自动恢复"写成"永远等人"。
19. **唯一约束冲突用 `ON CONFLICT` 返回值表达，不用异常表达**（§8.5 C1）。Postgres 的唯一约束错误会 abort 整个事务，用异常表达冲突在物理上就无法"继续提交其余部分"。
20. **验收证据靠摘要绑定新鲜度，不靠失效任务**（§13.4 AE4）。不需要任何定时器或触发器去"作废"旧记录；事实一变摘要就不匹配，旧记录在构造上不可用。

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
| 02 | 独立审查契约与故障模型 | §4 · §8 · §15 | `docs/project-coordinator-contract-review-02.md` |
| 01A | 修订 `PC-CX-01..08` | §19 全表 | `src/apiserver/src/projects/coordinator-counterexample.spec.ts`（反例模型）+ 01 的文档自检扩展 |
| 01B | 修订 `PC-CX-09..14` | §20 全表 | 同上 + `src/apiserver/src/projects/coordinator-linearization.pg.spec.ts`（真实 Postgres 双事务，见 §20.1） |
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

---

## 19. `PC-CX-01..08` 修订闭环

02 的独立审查（[`project-coordinator-contract-review-02.md`](./project-coordinator-contract-review-02.md)）判 **FAIL / BLOCKED**，给出 2 个 P0 与 6 个 P1。本节是**逐项关闭的索引**：每一项给出最小交错序列、修订后的权威状态、动作键、恢复路径和可执行断言。**审查文档不因本次修订而改动** —— 它记录的是 v1 的事实，那些事实没有变；变的是契约。

| ID | 级别 | 规范条款 | 权威状态 | 动作键 | 恢复路径 | 可执行断言 |
|---|---|---|---|---|---|---|
| `PC-CX-01` | P0 | §7.7 D5 · I9 · §8.5 C1/C2 | 该 Task 恰好一条占位 Session；`run_state = EXECUTING` | `pc:v1:<p>:dispatch:<taskId>:<dispatchAttempt>`（v1.2 换 epoch，§8.2 DA1），败者记 `SUPERSEDED` / `TASK_ALREADY_RUNNING` | 无需人工；败方本次事务照常提交，下一次 reconcile 按新事实继续 | `PC-CX-01 concurrent manual start and coordinator dispatch leave exactly one live session` |
| `PC-CX-02` | P0 | §7.7 D6 · D7 · §12.3 D5–D7 · §12.4 | 无 Session 被旧入口创建；`dispatch_origin` 恒可审计 | 旧入口没有键，由触发器拒绝；新入口沿用 dispatch 键 | 旧实例记 `DISPATCH_AUTHORITY_VIOLATION` 错误后退出本轮；新实例照常派发 | `PC-CX-02 a legacy sweep cannot dispatch a COORDINATOR-authority task` |
| `PC-CX-03` | P1 | §4.2 RS0 · I4a · I4b · §10.4 N-mask | `AWAITING_HUMAN`（唯一值，与遍历顺序无关） | 各 blocker 保留各自的 `pc:v1:<p>:blocker:<kind>:<subjectId>` | USER blocker 被答复 ⇒ 守卫重算，通常落 `BLOCKED`（v1 转移表里没有这一条） | `PC-CX-03 run state is one value for every permutation of a mixed blocker set` |
| `PC-CX-04` | P1 | §8.5 C1–C5 · §8.3 X2 | 动作恰好一行且记 `ALREADY_APPLIED`；事件已消费 | 冲突的那个键本身；`RETURNING` 0 行是返回值不是异常 | 无需动作。唯一的合法回滚是 fencing token 失配（C3） | `PC-CX-04 an idempotency conflict still consumes the event and commits the rest` |
| `PC-CX-05` | P1 | §11.1 BL0 · BL5 · §9.4 · §10.4 N-null · §10.2 W4 | 预算等待 = `BLOCKED`（`SYSTEM`/`TIME`）；纯人工等待 = `AWAITING_HUMAN` | `pc:v1:<p>:blocker:BUDGET_EXHAUSTED:<projectId>`；`SCHEDULE_WAKE` 不入账本 | 预算靠 `next_check_at` = 窗口边界自动解除；人工等待靠用户事件，升级后停钟且不触发 backstop WARN | `PC-CX-05 budget waits keep a clock and human waits stop hitting the backstop` |
| `PC-CX-06` | P1 | §9.5 Q3 · Q4 · §7.2 TU1/TU2 · §11.2 BL4 | 退避期内**无 blocker**，状态由 `runStateOf` 算（最小场景 `PLANNING`，另有在飞则 `EXECUTING`，§9.5 Q4）；达上限 `AWAITING_HUMAN` | 重试沿用 `…:dispatch:<taskId>:<dispatchAttempt>`（v1.2：epoch 是单调派发次数）；不产生 turn 键 | 退避到期自动重试；达上限须人处理后清零 `failureCount`（**不动** `dispatch_attempt`，§8.2 DA1） | `PC-CX-06 every task failure state maps to exactly one action` |
| `PC-CX-07` | P1 | §7.6 TR1–TR3 · §10.4 最小间隔 | 事实未变 ⇒ `AWAITING_HUMAN`（`COORDINATOR_NO_PROGRESS`）；事实变了 ⇒ 允许新 turn | `pc:v1:<p>:turn:<generation>:<reasonDigest>`，digest 绑定 `turnFacts` | 事实一变 digest 就变，旧 blocker 自动解除并自然获得新 turn | `PC-CX-07 rate limiting and idempotency are separate, and a no-progress turn becomes a blocker` |
| `PC-CX-08` | P1 | §13.4 AE1–AE5 | 摘要不匹配 ⇒ `project.status` 保持 `OPEN` | `pc:v1:<p>:acceptance:<attempt>`；证据行带 `acceptanceDigest` | 重新验收产生新摘要的记录；旧记录不需删除，它只是不再匹配 | `PC-CX-08 stale acceptance evidence cannot pass the DONE gate` |

### 19.1 `PC-CX-01` 共同的 task 级派发线性化点

**最小交错序列**（两个真实事务，barrier 在第 3 步）：

1. `T_C`（控制环）取租约得 `fencingToken = 42`，读快照：Task `X` 为 `OPEN`、`liveSessionIds = []`。
2. `T_U`（人工"开始执行"）读同一个 Task：同样看到没有在飞 Session。
3. **barrier** —— 两者都已完成检查，都还没写。
4. `T_U` `INSERT session(task_id = X, status = 'PENDING', dispatch_origin = 'USER')` 并提交。
5. `T_C` `INSERT project_action(idempotency_key = pc:v1:<p>:dispatch:X:0)` —— 全局唯一，**不冲突**（人工入口从不写这个键）；随后 `INSERT session(task_id = X, …)`。

v1 在第 5 步成功，于是 Task `X` 有两条 live Session。**v1.1 在第 5 步的 session 插入上撞 `session_task_execution_claim_idx`**，`ON CONFLICT DO NOTHING RETURNING` 返回 0 行。

**权威状态**：Task `X` 恰好一条占位 Session（`T_U` 的那条）；`project_action` 有一行 `dispatch:X:0`，`status = SUPERSEDED`、`refusal_code = TASK_ALREADY_RUNNING`、`result_session_id = NULL`；`run_state = EXECUTING`（守卫 5）；本次事件已消费。

**动作键**：`pc:v1:<projectId>:dispatch:<taskId>:<dispatchAttempt>`（v1.1 写的是 `<failureCount>`，v1.2 按 §8.2 DA1 换成单调的派发次数；跨入口互斥的论证不受影响）。**它不变，也不需要变** —— 键的职责是"同一个动作不做两次"，跨入口互斥是索引的职责。把人工入口也塞进同一个键空间是错的：人工启动不是控制环的动作，它不该占用控制环的账本，也不该被控制环的 fencing token 约束。

**恢复路径**：无需人工。`T_C` 照常提交（C2），`nextWakeAt = now + 60s`；`T_U` 创建的 Session 结束时发 `session.ended`，控制环重新求值。反向交错（`T_C` 先提交）对称：人工入口拿到 0 行，返回既有 Session，与既有"重复点击 no-op"行为一致。

**可执行断言**：`PC-CX-01 concurrent manual start and coordinator dispatch leave exactly one live session` —— 枚举两个事务的**全部交错**，每一种都断言占位 Session 恰好 1 条、败者结果确定。同一测试包含一个**反向对照**：去掉 D5 的索引后同一交错产生 2 条 Session，证明这条断言真的能抓住 v1。

### 19.2 `PC-CX-02` 混合版本的派发权与 fencing

**最小交错序列**：

1. 迁移已加列，Project `P` 被打开 `coordinatorEnabled`，其 Task `X` 被投影为 `dispatch_authority = 'COORDINATOR'`。
2. 滚动窗口（或回滚）中仍在运行的**旧** apiserver：它的 `reconcileReadyTasks` SQL 里**没有** `AND dispatch_authority = 'LEGACY'` 这个条件，因此照常选中 `X`。
3. 旧实例**不取** `project_runtime` 租约，因此 fencing token 对它完全无效。
4. 旧实例插入一条 Session（`dispatch_origin` 落 DB 默认 `'LEGACY_SWEEP'`，`project_action_id` 为 NULL）。

v1 在第 4 步成功。**v1.1 在第 4 步被 `session_dispatch_authority_guard` 触发器拒绝**。

**权威状态**：`X` 上没有由旧入口创建的 Session。若新实例同时派发，则恰好一条、且 `dispatch_origin = 'COORDINATOR'`、`project_action_id` 非空 —— **"由谁派的"因此是一次列查询，不是一次考古**。

**动作键**：旧入口**没有**动作键，这正是问题所在，也是为什么这一项不能靠键解决。硬门是触发器；新入口沿用 dispatch 键不变。

**恢复路径**：旧实例的那个事务回滚并记一条 `DISPATCH_AUTHORITY_VIOLATION`，本轮跳过该 Task；下一轮同样被拒。控制环侧不受任何影响。D7 的两阶段部署保证正常升级路径下 `COORDINATOR` 权的 Task 尚不存在，因此连这条错误日志都不会出现；回滚时它出现，**这是可见的失败，不是静默的双重派发**。

**可执行断言**：`PC-CX-02 a legacy sweep cannot dispatch a COORDINATOR-authority task` —— 同时驱动"旧 sweep 查询（不过滤派发权）"与"新 Coordinator"，断言唯一那条 Session 的 `dispatch_origin = COORDINATOR`；反向对照：去掉触发器后旧 sweep 可以赢。

### 19.3 `PC-CX-03` USER 与非 USER blocker 的状态优先级

**最小交错序列**：

1. Provider 掉线 ⇒ `PROVIDER_UNAVAILABLE`（`owner = SYSTEM`）open。
2. 同一 tick，一个高风险动作转 `REQUEST_APPROVAL` ⇒ `AWAITING_USER_APPROVAL`（`owner = USER`）open。
3. reconcile 求值 I4：`BLOCKED` 的右侧为真，`AWAITING_HUMAN` 的右侧也为真。

v1 无解 —— 单值 `run_state` 不能同时等于两个值，最终值取决于实现遍历 blocker 的顺序。**v1.1 的 `runStateOf` 按守卫顺序求值，守卫 2（USER）先于守卫 3。**

**权威状态**：`AWAITING_HUMAN`，且**对 blocker 集合的任意排列都相同**（I8）。`PROVIDER_UNAVAILABLE` **仍然 open**：它照常按 §11.4 重算解除，照常按 §10.4 第 1 条贡献 `nextWakeAt`（N-mask）。

**动作键**：两条 blocker 各自的 `pc:v1:<p>:blocker:<kind>:<subjectId>`。状态优先级**不改变 blocker 的身份** —— 被掩盖的不是那一行，只是它对 `run_state` 的贡献。

**恢复路径**：用户批准 ⇒ `AWAITING_USER_APPROVAL` resolved ⇒ 守卫 2 不再成立 ⇒ 守卫 3 成立 ⇒ `AWAITING_HUMAN → BLOCKED`。**这条转移在 v1 的转移表里不存在**，是 TS1 把转移合法性改成守卫推论之后才被覆盖的。

**可执行断言**：`PC-CX-03 run state is one value for every permutation of a mixed blocker set` —— 对 `{USER, SYSTEM}`、`{USER, COORDINATOR}`、`{USER, SYSTEM, COORDINATOR}` 三个 multiset 的**全部排列**求值，结果唯一且等于守卫表的预测；并断言 I4a/I4b 双向成立。

### 19.4 `PC-CX-04` 动作唯一冲突下的事件消费与提交

**最小交错序列**：

1. 上一次 reconcile 已提交动作 `K = pc:v1:<p>:turn:<g>:<d>`。
2. 新事件 `E` 到达（重投，或另一个来源的同因事件）。
3. 本次 reconcile 得出**相同**的机械结果：追加动作 `K`；同时它还要清掉一条条件已消失的 blocker、把 `nextWakeAt` 前移、消费 `E`。
4. `INSERT project_action(K)` 撞唯一约束。

v1 说"整事务回滚且视为成功"：于是 `E` 的 `consumed_at` 仍为 NULL、blocker 没清、`nextWakeAt` 没动。消费者再取到 `E`，再得出同样的结果，再回滚 —— **在这条事件上活锁**。若为了绕开而在事务外把 `E` 标成已消费，又违反 §6.2 的原子提交。

**v1.1**：第 4 步用 `ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`，返回 0 行，**不抛异常**（C1）。读出既有行，本条记 `ALREADY_APPLIED`，跳过副作用，**继续提交其余全部 outcome**（C2）。

**权威状态**：`project_action` 中 `K` 恰好一行（status 不被覆盖）；`E.consumed_at` 非空；blocker 已 `resolved_at`；`project_runtime.next_wake_at` 已前移；`project_decision` 多一行审计。

**动作键**：`K` 本身。要害是**冲突是返回值不是异常** —— Postgres 的唯一约束错误会把整个事务置为 aborted，此后连 `UPDATE project_event` 都执行不了，"继续提交"在物理上不可能。

**恢复路径**：无需动作。唯一的合法回滚是 fencing token 失配（C3），那意味着已被接管，接管者会重看同一份事实。未分类异常走 C4：事务回滚、事件保持未消费并退避、另开小事务开 `UNKNOWN_FAILURE`。

**可执行断言**：`PC-CX-04 an idempotency conflict still consumes the event and commits the rest` —— 断言四件事同时成立（动作一行、事件已消费、blocker 已清、wake 已前移），**而不是只数 Session 条数**；反向对照：按 v1 的"整事务回滚"语义，事件仍未消费。

### 19.5 `PC-CX-05` 等待人工、预算窗口、升级与 backstop 的统一时钟

**最小交错序列**（两个方向各一条，v1 在两个方向上都错）：

- **A（预算）**：`sessionBudgetPerDay` 用尽 ⇒ v1 开 `BUDGET_EXHAUSTED(owner = USER)` ⇒ I4 判 `AWAITING_HUMAN` ⇒ §10.4 第 6 条把 `nextWakeAt` 置 `NULL`。窗口边界 `T` 到来，**期间无任何事件**。没有任何定时器会醒来，blocker 永不解除，项目静默停摆。
- **B（等待审批）**：一个正常等待用户审批的项目，`nextWakeAt = NULL`。v1 的 backstop 谓词是 `next_wake_at IS NULL OR …`，因此它**每 60 秒命中一次**并按 W2 记一条 WARN"该发的事件没发"。一个恒为真的告警等于没有告警。

**v1.1**：把决定时钟的权力从 `owner` 移到 `recovery`（BL0）。`BUDGET_EXHAUSTED` 改为 `owner = SYSTEM` / `recovery = TIME` —— 这不是重新分类，而是**回到 §4.1 自己的话**（`BLOCKED` 一行明写"预算耗尽"是机器可自行恢复的例子）。

**权威状态**：

| 情形 | `run_state` | `nextWakeAt` | backstop |
|---|---|---|---|
| 预算窗口未到 `T` | `BLOCKED` | `= T`（窗口边界） | 不命中 |
| 预算窗口过了 `T` | 定时唤醒 ⇒ blocker 自动解除 ⇒ 按其余守卫 | 重算 | 不命中 |
| 等待审批，未升级 | `AWAITING_HUMAN` | `= first_seen_at + 30min`（升级闹钟） | 不命中 |
| 等待审批，已升级 | `AWAITING_HUMAN` | `NULL`（N-null 的唯一合法情形） | **不命中**（W4 第 (ii) 支排除了它） |
| 任何其它 `NULL` wake | —— | `NULL` | **命中并记 WARN**（这才是 W2 想抓的漏事件 bug） |

**动作键**：`pc:v1:<p>:blocker:BUDGET_EXHAUSTED:<projectId>`（blocker 无 epoch，同因恒为同键，§8.2）。`SCHEDULE_WAKE` 按 §7.3 不入账本。

**恢复路径**：预算靠时间（`next_check_at` = 窗口边界，到点重算即解除）；纯人工等待靠用户事件；"这个项目预算长期不够"靠升级（ES1：升级只改 `owner`，**不改** `recovery`，因此升级后它仍会自动解除）。

**可执行断言**：`PC-CX-05 budget waits keep a clock and human waits stop hitting the backstop` —— 逐格断言上表五行，包括"已升级的纯人工等待不命中 backstop"与"其它任何 NULL wake 都命中"。

### 19.6 `PC-CX-06` `TEST_FAILED` 是否开 turn 的唯一规则

**最小交错序列**：

1. Task `X` 第一次运行失败，`failureCount = 1 < MAX_AUTO_RUN_FAILURES`。
2. 按 v1 §11.2，开 `TEST_FAILED`，默认 `owner = COORDINATOR`。
3. 按 v1 §7.2 条件 3，"一条 blocker 的 `owner = COORDINATOR`" ⇒ **必须**追加 `OPEN_COORDINATOR_TURN`。
4. 按 v1 §7.2 末段，"一个任务失败不会自动开 turn" ⇒ **不得**追加。

第 3 步与第 4 步对同一份快照给出相反的动作，不存在唯一确定结果。

**v1.1**：两处同时改。§9.5 Q3 规定退避期内**根本不开 blocker**（只有 `NOOP` 审计行 + 指向退避到期的 `nextWakeAt`），`TEST_FAILED` 只在 `failureCount ≥ MAX` 时创建且 `owner = USER`；§7.2 把触发条件 3 从"读 `owner`"改成"读一个封闭的 kind 列表"，并由 BL4（`opensTurn = ✔` ⟺ `owner = COORDINATOR`）保证两处不漂移。

**权威状态**（§9.5 Q3 逐行唯一）：

| `failureCount` | blocker | `run_state` 贡献 | 是否开 turn |
|---|---|---|---|
| `0` | 无 | 无 | 否 |
| `0 < n < MAX`，退避未到期 | **无** | 无（项目照常 `EXECUTING`/`PLANNING`） | 否 |
| `0 < n < MAX`，退避已到期 | 无 | 无 | 否（**派发**） |
| `n ≥ MAX` | `TEST_FAILED`（`USER`/`HUMAN`） | `AWAITING_HUMAN` | 否 |
| 归因不明 | `UNKNOWN_FAILURE`（`USER`/`HUMAN`） | `AWAITING_HUMAN` | 否 |

**动作键**：重试沿用 `pc:v1:<p>:dispatch:<taskId>:<dispatchAttempt>` —— **重试是新的一次，重复事件不是**（§8.2 DA2）。失败路径**不产生任何 turn 键**。

**恢复路径**：退避到期自动重试；达上限后停止自动派发，等人处理（Q1）。人处理后清零的是 `failureCount`（策略计数），`dispatch_attempt` **不动**，因此下一次派发算出的是一个从未出现过的 epoch。

> **v1.1 在这里写错了一句**，v1.2 予以更正并保留原文以便追溯：v1.1 说"人处理后失败计数清零，dispatch 键的 epoch 因此回到 0 —— 这不会与旧键冲突，因为旧键的动作已经 `APPLIED`"。后半句恰好把结论说反了：**旧键已经 `APPLIED` 正是它会冲突的原因** —— `project_action.idempotency_key` 全局唯一且历史行永不删除，§8.5 C2 把冲突判为"已做过"并跳过副作用，于是清零之后这个 Task 每一次 reconcile 都算出同一个已存在的键，**永远无法再被派发**。审查记为 `PC-CX-11`，修订在 §8.2 DA1–DA3 与 §20.3。

**可执行断言**：`PC-CX-06 every task failure state maps to exactly one action` —— 表驱动逐行断言 `(blocker, owner, recovery, opensTurn, run_state, 派发决定)` 六元组唯一；另断言 §11.2 中 `owner = COORDINATOR` 的 kind 集合与 §7.2 `BLOCKER_DECISION` 行的 kind 列表**逐字相等**（BL4）。

### 19.7 `PC-CX-07` 同 generation 同原因的合法重试

**最小交错序列**：

1. `merge.conflict` ⇒ `MERGE_CONFLICT` blocker（`owner = COORDINATOR`）⇒ 开 turn，键 `K = pc:v1:<p>:turn:<g>:<d>`。
2. turn 结束，协调器没能解决冲突（或只记录了"稍后再看"）。
3. 60 秒后 reconcile：快照仍然要求同一个语义判断，`generation` 未变（只在 Session 轮换时 +1），`reasonDigest` 未变。
4. v1：`K` 永久唯一 ⇒ 永远无法再开 turn。控制环对这条冲突从此彻底沉默，而 §10.4 明明允许"60 秒后再来一次"。

**v1.1**：TR1/TR2/TR3 把一个键拆成三件事。

**权威状态**：

- 上一次 turn **还在飞** ⇒ 键冲突 ⇒ 记 `ALREADY_APPLIED`（§8.5），不开第二次 turn，**不开** blocker。
- 上一次 turn **已结束且 digest 未变** ⇒ 证明它没有改变自己被叫醒的那些事实 ⇒ 开 `COORDINATOR_NO_PROGRESS`（`USER`/`HUMAN`）⇒ `run_state = AWAITING_HUMAN`。
- **事实变了** ⇒ `turnFacts` 变 ⇒ `reasonDigest` 变 ⇒ 新键，允许新 turn；旧的 `COORDINATOR_NO_PROGRESS` 按 §11.4 自动解除。
- 同一 `(generation, reasonCode)` 60 秒内至多一次（TR2），与上面三条独立。

**动作键**：`pc:v1:<projectId>:turn:<generation>:<reasonDigest>`，其中 `reasonDigest = sha256(reasonCode ‖ canonical(turnFacts))`，`turnFacts` 由 §7.2 的表逐 `reasonCode` 冻结。**限频看 `reasonCode`（粗），幂等看 `reasonDigest`（细）** —— 这就是"限频与永久幂等是两个概念"的落地形式。

**恢复路径**：事实一变 digest 就变，blocker 自动解除并自然获得一次新 turn，**不需要任何"attempt 计数器"**。若事实一直不变，那么"协调器解决不了这件事"就是一个有责任人、看得见、会升级的状态，而不是一串越来越稀疏的重试 —— 这是对 foreman 事故的同一条吸取（§7.2）。

**可执行断言**：`PC-CX-07 rate limiting and idempotency are separate, and a no-progress turn becomes a blocker` —— 断言 `t=0` 允许、`t=59s` 被 TR2 拒、`t=61s` 且事实未变被 TR3 拒并开 `COORDINATOR_NO_PROGRESS`、`t=61s` 且事实已变允许且旧 blocker 自动解除。

### 19.8 `PC-CX-08` `DONE` 验收证据绑定当前事实

**最小交错序列**：

1. 快照 `H1`：全部 Task 收敛、验证全 PASS ⇒ 协调器在 turn 内产出一条逐条全 PASS 的验收记录。
2. 用户随后改了 `project.acceptanceCriteria`（或某个 Task 被退回重开 / 某个验证任务给出新的 FAIL / 目标分支被 force-push 改掉内容）⇒ 事实变为 `H2`。
3. 有人（用户、CLI、MCP、协调器）请求把 `project.status` 置 `DONE`。
4. v1 的服务端硬门只问"**存在**一条全 PASS 的验收记录吗" ⇒ `H1` 的记录仍然存在 ⇒ 放行。

**v1.1**：AE2 把"存在"换成"**存在一条对当前这份事实成立的**"。

**权威状态**：`project.status` 保持 `OPEN`；写入被拒，错误码 `ACCEPTANCE_EVIDENCE_STALE`（有全 PASS 记录但摘要不匹配）或 `ACCEPTANCE_MISSING`（压根没有）。`run_state` 由守卫重算 —— 通常是 `PLANNING`（有新工作）或 `AWAITING_VERIFICATION`（验证任务需重跑）。

**动作键**：`pc:v1:<projectId>:acceptance:<attempt>`（§7.3 不变）。新增的是**证据行上的** `acceptanceDigest`，它不是幂等键 —— 幂等键回答"这次验收跑过没有"，摘要回答"这次验收还算数吗"。

**恢复路径**：重新跑一次验收，产生一条带新摘要的记录。**旧记录不必删除也不必标记失效**（AE4）：事实一变摘要就不匹配，它在构造上不可用；用户把标准改坏又改回来时摘要回到原值，原记录重新可用 —— 这是正确行为，不是漏洞。

**可执行断言**：`PC-CX-08 stale acceptance evidence cannot pass the DONE gate` —— 参数化覆盖四类事实变化（`acceptanceCriteria`、Task 集合/状态、verdict、合并内容），每一类都断言 `DONE` 被拒且 `project.status` 仍为 `OPEN`；未变化时断言放行；"改回去"时断言重新放行。

### 19.9 本次修订**没有**做的事

诚实记录边界，避免把"契约已定义"读成"实现已验证"：

- **本次修订不含实现**。03–23 单元一行代码都还没写；`session_task_execution_claim_idx` 与 `session_dispatch_authority_guard` 目前是**契约条款**，不是数据库里的对象。
- **反例测试是模型级的**，跑在一个刻意做小的内存模型上（唯一索引、动作账本、blocker 集合、守卫函数、摘要），**不是**跑在 Postgres 上的两事务测试。02 的审查清单里 `dispatch-linearization.spec.ts` / `mixed-version-dispatch.spec.ts` 那两条要求"两个真实事务 + barrier"和"真实滚动升级"，**仍然未完成**，归 09 / 13 / 19 / 22 单元。本次修订让那两条**可写**（此前契约没有指定要测哪个 primitive），但没有替它们交付。
- **02 的审查文档一字未改**（任务的硬约束）。它记录的是 v1 的事实；v1.1 的回应写在这里。

---

## 20. `PC-CX-09..14` 修订闭环（v1.2）

02 对 v1.1 的独立复审（[`project-coordinator-contract-review-02-v1.1.md`](./project-coordinator-contract-review-02-v1.1.md)）判 **FAIL / BLOCKED**，给出 1 个 P0 与 5 个 P1。本节是**逐项关闭的索引**，格式与 §19 相同。**两份审查文档都不因本次修订而改动** —— 它们记录的是 v1 与 v1.1 的事实，那些事实没有变；变的是契约。

六项里有五项的形状是同一个：**v1.1 把一个"当时成立"的检查当成了"始终成立"的不变量**。触发器在 `INSERT` 那一刻读到的授权、验收记录被写下那一刻成立的事实、blocker 被创建那一刻的 owner、失败计数在那一刻的值 —— 每一个都会在之后被别的事务改掉，而 v1.1 没有任何机制把"那一刻"和"现在"绑在一起。v1.2 的答案在三处：**两把互相冲突的行锁**（§7.7 D8、§13.4 AE6/AE7）、**一个只进不退的 epoch**（§8.2 DA1），以及**把随时间前进的量从幂等摘要里赶出去**（§7.2 TF1）。

| ID | 级别 | 规范条款 | 权威状态 | 动作键 | 恢复路径 | 可执行断言 |
|---|---|---|---|---|---|---|
| `PC-CX-09` | **P0** | §7.7 D6 · D8 · §12.3 D3 · I12 | 占位 Session 的 `dispatch_origin` 恒被该 Task **当前**的 `dispatch_authority` 允许；不存在 `COORDINATOR` 权 + `LEGACY_SWEEP` 占位 | 旧入口没有键（硬门是触发器）；新入口沿用 `pc:v1:<p>:dispatch:<taskId>:<dispatchAttempt>` | 翻转先提交 ⇒ 旧插入被触发器拒并回滚该入口；插入先提交 ⇒ 翻转跳过该 Task，占位释放时由 D3 第 3 处补投影 | `PC-CX-09 an authority flip and a session insert cannot both win` |
| `PC-CX-10` | P1 | §7.2 TF1 · TF2 · §7.6 TR1 · §11.3 | 同一条件重复 N 次 ⇒ 同一 `reasonDigest` ⇒ 同一 turn 键 ⇒ 第二次落 TR3 的 `COORDINATOR_NO_PROGRESS` | `pc:v1:<p>:turn:<generation>:<reasonDigest>`，`turnFacts` 里是 `conditionVersion` 而不是 `occurrences` | 条件真的变了 ⇒ `condition_version` 重算 ⇒ 新 digest ⇒ 新 turn，旧 blocker 按 BL3 自动解除 | `PC-CX-10 repeated delivery of one condition never changes the turn key` |
| `PC-CX-11` | P1 | §8.2 DA1–DA3 · §9.5 Q4 | 退避期无 blocker，状态由 `runStateOf` 唯一算出（最小场景 `PLANNING`）；达上限 `AWAITING_HUMAN` | `pc:v1:<p>:dispatch:<taskId>:<dispatchAttempt>`，epoch 单调不复用 | 人处理后清零 `failureCount`（策略），`dispatch_attempt` 不动 ⇒ 下次派发必得新键新 Session | `PC-CX-11 a human reset never reuses a dispatch key` |
| `PC-CX-12` | P1 | §11.2 BL4 · BL6 · §11.5 ES1 · ES3 · §7.2 | `opensTurn` 由 kind 定，升级只改 `owner`；升级到 `USER` 后 `AWAITING_HUMAN` 且不再开 turn | 各 blocker 保留 `pc:v1:<p>:blocker:<kind>:<subjectId>`（无 epoch） | 条件消失照常自动解除（`recovery` 不随升级改变，ES1）；通知至多一次 | `PC-CX-12 escalation changes the owner and nothing else` |
| `PC-CX-13` | P1 | §13.4 AE3 · AE6 · AE7 · AE8 · I1 · I10 | 不存在 `DONE` + 不匹配的验收事实；`DONE` 后的事实写入原子重开为 `OPEN` | `pc:v1:<p>:acceptance:<attempt>`；证据行带 `acceptanceDigest` | 摘要不匹配 ⇒ `ACCEPTANCE_EVIDENCE_STALE` 且项目保持 `OPEN`；终态后写入 ⇒ 同事务重开并由守卫重算 | `PC-CX-13 DONE and every acceptance-fact write share one gate` |
| `PC-CX-14` | P1 | §4.1 · §10.3 (a) · I11 · §7.7 D6 | 只有 USER-origin 占位时 `run_state = EXECUTING` 且不变量为真、活性判据 (a) 成立 | 人工入口**没有**动作键，这是刻意的（§19.1）；它由 `dispatch_origin = 'USER'` 归属 | 人工 Session 结束 ⇒ `session.ended` ⇒ 守卫重算；与控制环竞争时由 D5 定胜负 | `PC-CX-14 a user-started session satisfies EXECUTING and liveness` |

### 20.1 `PC-CX-09` 派发权切换与 Session 插入的共同线性化点

**最小交错序列**（两个真实事务，barrier 在第 3 步）：

1. Task `X` 当前 `dispatch_authority = 'LEGACY'`，Project `P` 正要打开 `coordinatorEnabled`。
2. `T_flip` 执行 `UPDATE task SET dispatch_authority = 'COORDINATOR' WHERE id = X`，**尚未提交**。
3. **barrier** —— 翻转已写未提交。
4. 旧 apiserver 的 `T_old` 插入 `X` 的 Session（`dispatch_origin` 落 DB 默认 `'LEGACY_SWEEP'`）。
5. 两者都提交。

v1.1 在第 4 步**放行**：`BEFORE INSERT` 触发器里的普通 `SELECT t.dispatch_authority` 在 MVCC 下看不见 `T_flip` 未提交的写，读到 `'LEGACY'`，于是走"LEGACY 权的任务照旧"那一支。最终状态是 `dispatch_authority = 'COORDINATOR'` + 一条 `LEGACY_SWEEP` 占位 —— D5 没有冲突（只有一条），D6 没有拒绝（它读的是旧值）。**v1.2 在第 4 步阻塞**：触发器的 `SELECT … FOR SHARE` 与 `T_flip` 的 `FOR NO KEY UPDATE` 冲突。

**Postgres MVCC 与锁语义**（这一项的全部要害，逐条都可在真实 Postgres 上验）：

1. 普通 `SELECT` 用**快照**，未提交的写对它不可见 —— 因此它读到的永远是"某个过去时刻的授权"，而不是"提交时的授权"。这不是实现瑕疵，是快照隔离的定义；**任何**不取锁的读都有这个性质，换成读 generation 列、版本号或 CAS 前的一次读都一样（D8-note）。
2. 普通 `UPDATE` 一个非键列自动取得 **`FOR NO KEY UPDATE`** 行锁。这一点对**任何版本的二进制**成立，无需它知道任何契约 —— 这是 v1.2 敢把正确性押在这里的原因。
3. Postgres 的行级锁冲突表里，**`FOR SHARE` 与 `FOR NO KEY UPDATE` 冲突**，而外键检查用的 `FOR KEY SHARE` **不冲突**。所以 session→task 的外键本身挡不住任何东西，必须显式写 `FOR SHARE`。
4. `READ COMMITTED` 下，被锁阻塞的 `SELECT … FOR SHARE` 在锁释放后走 **EvalPlanQual**：重取该行的**最新**版本并重新检查 `WHERE`。`WHERE t.id = NEW.task_id` 不受翻转影响，因此触发器一定读到**翻转后**的 `'COORDINATOR'` 并拒绝。`REPEATABLE READ` 下同一情形抛 `40001`，也是拒绝（D8-d）。
5. 反向顺序：`T_old` 先插入并持有 `FOR SHARE`，则 `T_flip` 的 `UPDATE` **阻塞**；`T_old` 提交后 `T_flip` 继续，它的第 2 条语句取新快照，`NOT EXISTS` 看见那条占位，于是**跳过**这个 Task（D8-b）。

**权威状态**：I12 —— 任何已提交状态上，占位 Session 的 `dispatch_origin` 都被该 Task **当前**的 `dispatch_authority` 按 D6 的谓词允许。两个提交顺序各自的结果：翻转先，则 `X` 是 `COORDINATOR` 权且**没有**旧入口创建的 Session；插入先，则 `X` **仍是** `LEGACY` 权且带着那条合法的 `LEGACY_SWEEP` 占位，直到占位释放时被 D3 第 3 处补投影。**两者都不是"COORDINATOR 权 + LEGACY 占位"。**

**动作键**：旧入口**没有**动作键 —— 这正是这一项不能靠键解决的原因，和 `PC-CX-02` 同型。硬门是触发器加行锁；新入口沿用 `pc:v1:<p>:dispatch:<taskId>:<dispatchAttempt>` 不变。

**恢复路径**：被拒的旧入口事务回滚并记 `DISPATCH_AUTHORITY_VIOLATION`，本轮跳过该 Task（**可见的失败，不是静默的越权**）；被跳过的 Task 不需要任何人工干预，它在占位释放的那个事务里被补上。控制环侧不受影响。

**可执行断言**：`PC-CX-09 an authority flip and a session insert cannot both win` —— 枚举两个事务的两种提交顺序，每一种都断言 I12 成立、且结果落在上面两个合法组合之一；**反向对照**：把触发器的 `FOR SHARE` 去掉（只改这两个词），同一交错立刻产出 `COORDINATOR` 权 + `LEGACY_SWEEP` 占位。另有一份**跑在真实 Postgres 上的双事务 barrier 测试** `coordinator-linearization.pg.spec.ts`：它建真表真触发器，用两条真实连接在第 3 步对齐，对 `FOR SHARE` 与普通 `SELECT` 两个版本各跑两个提交顺序 —— 这是本项目第一条不靠模型、直接验 MVCC 语义的断言，也是 02 复审清单里那条"真实 Postgres barrier"的兑现。

### 20.2 `PC-CX-10` 投递次数不进语义摘要

**最小交错序列**：

1. `merge.conflict` ⇒ `MERGE_CONFLICT` blocker，`occurrences = 1` ⇒ 开 turn，键 `turn:<g>:d1`。
2. turn 结束，冲突**未解决**：文件集、目标分支、内容全都没变。
3. 同一冲突的重复信号到达（重投、或另一路事件源）。§11.3 命中同一 `dedupe_key`，`occurrences` 变成 2。
4. v1.1 的 `turnFacts = (kind, subjectId, occurrences)` ⇒ digest 从 d1 变成 d2 ⇒ TR1 认为"事实变了" ⇒ TR3 的 no-progress 判定命中不了 ⇒ 只要跨过 TR2 的 60 秒窗就再开一个 turn。每 60 秒重复一次信号即可**永久**制造新 turn。

这与 E1 是正面冲突：E1 冻结"事件是信号不是事实，重复投递不产生额外副作用"，而 `occurrences` 是**投递次数的函数**，把它放进摘要等于让投递次数变成事实。

**Postgres MVCC 与锁语义**：这一项不靠锁，靠的是 `project_action.idempotency_key` 的**唯一索引**在"同一个键"上给出的确定答案 —— §8.5 C1 的 `ON CONFLICT … DO NOTHING RETURNING` 把重复变成一个**返回值**。但唯一索引只能回答"这两次是不是同一个动作"，**它回答不了"这两次是不是同一件事"**：那取决于键里放了什么。把一个随投递次数前进的计数放进键，等于对数据库说每次投递都是新动作，于是索引忠实地放行 —— 这不是数据库的问题，是键的问题。另一半在 §11.3 的 `project_blocker_open_dedupe_idx`：同因重复命中已 open 的那一行并**原地更新** `occurrences` 与 `condition_version`，因此"条件"与"次数"在同一行上分列，重算 `condition_version` 不需要新行、也不需要额外的锁。

**权威状态**：`turnFacts` 服从 TF1 的排除集，blocker 那一项是 TF2 的 `condition_version`。于是同一条件重复 N 次、乱序 N 次、重启后重投 N 次，`reasonDigest` **逐字节相同**：第一次开 turn；turn 结束后事实仍未变则命中 TR3，开 `COORDINATOR_NO_PROGRESS`（`USER`/`HUMAN`）⇒ `run_state = AWAITING_HUMAN`。**"协调器解决不了这件事"因此是一个有责任人的状态，而不是一串每 60 秒一次的 turn。**

**动作键**：`pc:v1:<p>:turn:<generation>:<reasonDigest>`，`reasonDigest = sha256(reasonCode ‖ canonical(turnFacts))`。键**不变**，变的是它绑定的东西。`occurrences` 仍然存在、仍然递增、仍然驱动 §11.5 的升级阈值 —— 它只是不再进摘要。

**恢复路径**：冲突文件集变了 / verdict 变了 / 依赖环变了 ⇒ `condition_version` 按 §11.3 重算并覆盖 ⇒ digest 变 ⇒ 旧 `COORDINATOR_NO_PROGRESS` 按 BL3 自动解除，新 digest 自然获得一次新 turn。不需要任何计数器。

**可执行断言**：`PC-CX-10 repeated delivery of one condition never changes the turn key` —— 对 N ∈ {1,2,5,50} 次重复与随机乱序断言 digest、turn 动作数、最终 blocker 集合三者恒等；**反向对照**：把 `occurrences` 放回 `turnFacts`，同一序列立刻产出 N 个不同的 digest 和第二个 turn。另一条断言扫 §7.2 的 `turnFacts` 列，确认 TF1 的排除集里没有一个词出现在任何一行。

### 20.3 `PC-CX-11` 单调不复用的 dispatch epoch

**最小交错序列**：

1. Task `X` 首次派发，`failureCount = 0` ⇒ 键 `pc:v1:<p>:dispatch:X:0` ⇒ `APPLIED`。
2. 连续失败到 `MAX_AUTO_RUN_FAILURES` ⇒ 开 `TEST_FAILED`，停止自动派发。
3. 人处理问题，按 §19.6 把 `failureCount` 清零。
4. 控制环再次派发，重新算出**同一个** `pc:v1:<p>:dispatch:X:0`。
5. §8.5 C2：唯一键冲突 = "这个动作已经做过" ⇒ 记 `ALREADY_APPLIED` ⇒ **跳过副作用**（不插 Session）。
6. 每次 reconcile 都得到同一结果 —— `X` **永久无法再运行**，而且它看起来完全正常：有动作行、有审计行、没有 blocker、没有报错。

**Postgres MVCC 与锁语义**：`project_action.idempotency_key` 全局唯一且历史行**永不删除**，因此键空间是**只增不减**的；一个会被人为拨回去的 epoch 迟早会走进这个只增空间已经占掉的位置，而 §8.5 C2 对此的处理（"已做过，跳过副作用"）在那一刻是**对的** —— 错的是让它相信这是同一次动作。DA2 的 `+1` 落在提交事务里、与 fencing token 条件同生共死：`UPDATE task SET dispatch_attempt = dispatch_attempt + 1 … RETURNING` 取的是行锁，两个并发 reconcile 里只有拿到锁并且键插入成功的那个会让它前进，另一个撞唯一键后跳过副作用**也不前进**。所以 epoch 既不会漏、也不会重。

**权威状态**：`dispatch_attempt` 单调、永不复用、任何路径不清零（DA1）。上面第 4 步算出的是 `…:dispatch:X:<n>`（`n ≥ 1`），从未出现过，因此插入成功、Session 产生、`dispatch_attempt` 在同一事务里前进到 `n+1`。**幂等仍然成立**：同一份快照被重复 reconcile 读到同一个 `dispatch_attempt`，算出同一个键（DA2）。

**退避期状态的唯一答案**（复审指出的第二半）：v1.1 的 §19 汇总表把它写成 `EXECUTING`，而 §9.5 Q3 说失败任务对状态无贡献、§4.2 的守卫在"单 Task 已失败、无 live Session、无 blocker"的最小场景里只能返回 `PLANNING` —— 同一场景两个答案。v1.2 加 §9.5 Q4 冻结：**汇总表不是状态的来源**，`runStateOf` 才是；最小场景是 `PLANNING`，`nextWakeAt` = 退避到期时刻，审计是一条 `retry_backoff` 的 `NOOP`；项目里另有在飞 Session 时才是 `EXECUTING`（守卫 5），而那与这个失败任务无关。§19 汇总表的那一格已按 Q4 更正。

**动作键**：`pc:v1:<projectId>:dispatch:<taskId>:<dispatchAttempt>`。两个计数从此各管一件事：`failureCount` 回答"该不该再试"（策略），`dispatch_attempt` 回答"这是第几次动作"（身份）。DA3。

**恢复路径**：人处理后清零 `failureCount`，`dispatch_attempt` 不动 ⇒ 策略重新允许派发，而身份继续往前走。反过来也成立：**没有任何人工操作能让一个键被复用**，因此"人工修复"这条路径不再有把任务永久钉死的能力。

**可执行断言**：`PC-CX-11 a human reset never reuses a dispatch key` —— 预置 `dispatch_attempt = 0` 的历史 `APPLIED` 动作，跑"失败到阈值 → 人工清零 `failureCount` → 再派发"，断言产生**新键**与**新 Session**；**反向对照**：把 epoch 换回 `failureCount`，同一序列产出键冲突、`ALREADY_APPLIED` 且 Session 数停在 1。另一条 `PC-CX-11 the backoff window has exactly one authoritative run state` 逐行断言 Q4 的三行，并核对 §19 汇总表不再与 `runStateOf` 冲突。

### 20.4 `PC-CX-12` blocker 三个轴各回答一个问题

**最小交错序列**（两个方向各一条，v1.1 在两个方向上都错）：

- `PROVIDER_UNAVAILABLE`：默认 `SYSTEM` / `opensTurn = ✘`。按 v1.1 §11.5 升级到 `COORDINATOR` 后，行上的 `owner = COORDINATOR` 而 kind 不在 §7.2 的列表里 ⇒ `opensTurn` 仍是 ✘ ⇒ BL4 的"当且仅当"为假。
- `MERGE_CONFLICT`：默认 `COORDINATOR` / `opensTurn = ✔`。升级到 `USER` 后 kind 仍在列表里 ⇒ 项目一边 `AWAITING_HUMAN`（守卫 2）一边继续开 Coordinator turn。

**Postgres MVCC 与锁语义**：blocker 的身份是 §11.3 的 `project_blocker_open_dedupe_idx`（`(project_id, dedupe_key) WHERE resolved_at IS NULL`）。升级是对**同一行**的 `UPDATE`（改 `owner`、写 `escalated_at`），因此它取该行的行锁、不产生新行、也不改 `dedupe_key` —— "至多升级一次、至多通知一次"是这条 `UPDATE … WHERE escalated_at IS NULL` 的**影响行数**，不是应用层的一次判断，两个并发的升级里只有一个会影响到 1 行。这也说明为什么 `opensTurn` 不能挂在这一行上：这一行是**会被 UPDATE 的**，而 kind 不会。

**权威状态**：三个轴分开（BL4 的新表）：`opensTurn` 挂 **kind**（常量，升级不改）；`run_state` 挂**行上的 `owner`**（升级改）；时钟挂**行上的 `recovery`**（升级不改，ES1）。再加两条：**BL6** 把"`escalated_at IS NULL`"加进 §7.2 `BLOCKER_DECISION` 的触发条件，于是升级之后不再为它开 turn；**ES3** 把升级冻结为**恰好一步、目标恒为 `USER`**，因为中间那一级 `COORDINATOR` 在机械上不改变任何可观测事实（守卫 3 把 `SYSTEM` 与 `COORDINATOR` 归为同一支）。

逐 kind 的结果因此是一张可以枚举完的表：18 个 kind × {未升级, 已升级} = 36 个格子，每格的 `(opensTurn, run_state 贡献, nextWake 来源, 通知次数)` 都唯一确定，且 `opensTurn` 那一列在两行之间**逐字相同**。

**动作键**：blocker **没有 epoch**（§8.2），同因恒为同键 `pc:v1:<p>:blocker:<kind>:<subjectId>`。升级不换键 —— 升级是同一条 blocker 的第二个阶段，不是一条新的 blocker。这也是"至多通知一次"能被机械保证的原因。

**恢复路径**：升级不改 `recovery`（ES1），因此一条 `BUDGET_EXHAUSTED` 升到 `USER` 之后**仍然**在窗口边界自动解除；一条升到 `USER` 的 `MERGE_CONFLICT` **仍然** `recovery = EVENT`，冲突被解决时照常自动 clear，只是在解决之前不再叫醒协调器。

**可执行断言**：`PC-CX-12 escalation changes the owner and nothing else` —— 对 §11.2 的**全部 18 个 kind** 逐个走"创建 → 升级"，每一步断言 `opensTurn` 只由 kind 决定、`recovery` 不变、`run_state` 由守卫算出、通知恰好一次、以及 BL4 在"默认 owner"这一列上双向成立；**反向对照**：把 `opensTurn` 改回读行上的 `owner`，两个已知反例立刻出现（一个 `owner = COORDINATOR` 却 ✘，一个 `AWAITING_HUMAN` 却开 turn）。

### 20.5 `PC-CX-13` `DONE` 与验收事实写入的共同门

**最小交错序列**：

1. `T_done` 在 `REPEATABLE READ` 快照 `H1` 上重算摘要，找到匹配的全 PASS 记录。
2. `T_task` 把一个 DONE 的 Task 改回 `OPEN`。它写 `task` 行，`T_done` 写 `project` 行，**两者没有写冲突**。
3. 两个事务都提交 ⇒ `project.status = DONE` + `task.status = OPEN`。
4. `task.status_changed` 事件触发 reconcile，但 §4.2 守卫 1 对 `DONE` 无条件返回 `SETTLED` ⇒ 项目**不会**被拉回 `PLANNING`。v1.1 AE3 声称会，那句话不成立。

**Postgres MVCC 与锁语义**：快照隔离只在**写-写冲突**上中止事务；两个事务写不同的行时，`REPEATABLE READ` 不提供任何互斥。锁住"读到的 Task 行"也不够 —— `DONE` 之后**新建**一个 Task 或写一条新 verdict 都不碰任何被锁过的行。因此唯一可行的共同线性化点是**一把两边都取的锁**，而它必须落在两边**都必然存在**的那一行上：`project` 行。方向选 `FOR SHARE` / `FOR UPDATE` 而不是双方都 `FOR UPDATE`，是因为验收事实写入彼此之间**不需要**排队（`FOR SHARE` 互不冲突），只需要与 `DONE` 排队。

**权威状态**：I10 —— `project.status = DONE` ⟹ 存在一条全 PASS 且摘要等于**对当前行重算**的验收记录。三种交错各自的结果：

| 交错 | 结果 |
|---|---|
| 事实写入先提交 | `DONE` 等锁 ⇒ 重算摘要 ⇒ 不匹配 ⇒ `ACCEPTANCE_EVIDENCE_STALE`，`project.status` 保持 `OPEN` |
| `DONE` 先提交 | 事实写入等锁 ⇒ 读到 `DONE` ⇒ **同事务**把 `status` 改回 `OPEN` + `user.project_edited` 事件 + `reopened_by_fact_change` 审计（AE8） |
| 并发到达 | 两把锁冲突，数据库定序，退化为上面两种之一。**不存在第三种结果** |

守卫 1 **不放松**：v1.2 的做法是让"`DONE` + 不匹配事实"这个组合**不可达**，而不是让守卫去容忍它。

**动作键**：`pc:v1:<projectId>:acceptance:<attempt>`（不变）。摘要 `acceptanceDigest` 不是幂等键 —— 幂等键回答"这次验收跑过没有"，摘要回答"这次验收还算数吗"（§19.8）。

**恢复路径**：拒绝 `DONE` 之后重跑一次验收即可，旧记录不必删除也不必标记失效（AE4）。被 AE8 重开的项目由守卫重算落点（有 open blocker 就直接 `BLOCKED`，不预设 `PLANNING`）。`CANCELLED` 不适用重开。

**可执行断言**：`PC-CX-13 DONE and every acceptance-fact write share one gate` —— 枚举两个事务的全部交错 × AE6 表里的六条写路径，断言从不产生 `DONE` + 不匹配事实，且每种交错落在上表两行之一；**反向对照**：去掉那把锁（回到 v1.1 的"REPEATABLE READ 或锁读到的 Task 行"），"task 先/DONE 先/并发"三种顺序里立刻出现 `DONE + OPEN task`，且守卫仍返回 `SETTLED`。

### 20.6 `PC-CX-14` 合法的 USER-origin Session

**最小交错序列**：一个 Coordinator Project 里没有任何其它活动，用户手动"开始执行"了唯一那个任务。这条 Session 完全合法（§7.7 D6 显式放行 `dispatch_origin = 'USER'` 且 `project_action_id IS NULL`，§12.3 D3 明说人工入口不受派发权约束）。于是 §4.2 守卫 5 成立 ⇒ `run_state = EXECUTING`；但 §4.1 对 `EXECUTING` 的不变量要求"至少一条 `DISPATCH_TASK` action 对应的 Session 处于 LIVE"，而控制环动作数为 **0** ⇒ 不变量为假；§10.3 (a) 同样只认 APPLIED 动作的 `result_session` ⇒ 四条全不成立 ⇒ 一个**正在推进**的项目被活性查询判为 P0 违约。

**Postgres MVCC 与锁语义**：这一项**没有**竞态可修 —— 那条 Session 完全合法，D5 的 `session_task_execution_claim_idx` 与 D6 的触发器都已经放行了它，`session.dispatch_origin` 这一列也已经把"谁起的"记在了行上。缺的只是**读法**：§4.1 与 §10.3 的谓词去查 `project_action` 而不查 `session.dispatch_origin`，于是一条数据库里明明白白标着 `USER` 的行在契约的两处查询里"不存在"。修订因此是两条谓词的改写，不是一个新的数据库对象；可测形式就是那两条谓词本身（`EXISTS` 里多一支 `OR s.dispatch_origin = 'USER'`）。

**权威状态**：`EXECUTING` 的不变量与 §10.3 (a) 都改成"**可归属的**占位 Session"（I11）：`COORDINATOR` origin 必有 APPLIED 动作，`USER` origin 就是人的显式动作。三个状态序列各自唯一：

| 序列 | `run_state` | 活性判据 |
|---|---|---|
| 只有人工 Session | `EXECUTING` | (a) 成立（`dispatch_origin = 'USER'` 那一支） |
| 人工与控制环竞争 | `EXECUTING` | 胜者由 D5 定；败者记 `SUPERSEDED`/`TASK_ALREADY_RUNNING`（§19.1），(a) 由胜者那条满足 |
| 人工 Session 结束 | 由守卫重算（无其它事实时 `PLANNING`） | (d)：`nextWakeAt = now + 60s`（§10.4 第 6 条） |

**动作键**：人工入口**没有**动作键，而且**不该有**（§19.1 已冻结这一点：人工启动不是控制环的动作，不该占用控制环的账本，也不该被 fencing token 约束）。归属靠 `session.dispatch_origin` 这一列，它是 I11 的载体 —— 这正是 v1.1 加这一列时买到但没有用上的东西。

**恢复路径**：人工 Session 结束发 `session.ended` ⇒ 守卫重算；期间控制环不会为同一 Task 再派（§7.4 第 4 条读快照 + D5 兜底）。**不需要**让人工入口去写一条假的控制环动作 —— 那会让"这个 Session 是谁起的"重新变成一次考古，也会让人工动作被 fencing token 误伤。

**可执行断言**：`PC-CX-14 a user-started session satisfies EXECUTING and liveness` —— 三个序列各断言 `(run_state, 不变量, 活性判据 (a)–(d))`；**反向对照**：把不变量与 (a) 改回"只认 APPLIED 动作"，第一个序列立刻同时得到 `EXECUTING` 与"活性违约"。

### 20.7 本次修订**没有**做的事

同 §19.9，边界要写清楚，避免把"契约已定义"读成"实现已验证"：

- **本次修订仍不含实现**。03–23 单元一行业务代码都还没写；`task.dispatch_attempt`、`project_blocker.condition_version`、触发器里的 `FOR SHARE`、AE6/AE7 的项目行锁目前都是**契约条款**，不是数据库里的对象。
- **兑现了一条、只兑现一条真实 Postgres 断言**：`coordinator-linearization.pg.spec.ts` 在真实 Postgres 上验 `PC-CX-09` 的两个提交顺序与 `FOR SHARE` / 普通 `SELECT` 的差别（复审清单第 1 条）。复审清单第 6 条（`DONE` × Task 写的真实双事务全交错）本轮仍是模型级 —— 它需要真表、真服务层写路径，归 13 / 19 / 22 单元。其余四条（属性测试、动作账本、状态模型、blocker 属性测试）本轮以模型级断言兑现，它们本来就不需要数据库。
- **两份审查文档一字未改**（任务的硬约束）。它们记录的是 v1 与 v1.1 的事实；v1.2 的回应写在本节。
- **没有为 `PC-CX-12` 保留三级升级阶梯**。ES3 把它改成一步，这是一处**行为变更**而不是措辞澄清，写在这里以免下一个人以为它只是没写全。

---
