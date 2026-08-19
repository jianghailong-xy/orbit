# Project Coordinator 控制环契约 v1.9

> **状态**：已冻结（frozen）。本文件是 `Project Coordinator 持续推进控制环` 的**单一权威契约**。
> 03–23 阶段的每个实现与验证任务都必须与本文件一致；实现与本文件冲突时，先改本文件并说明理由，再改代码。
>
> **v1.1 修订**：关闭 02 独立审查（[`project-coordinator-contract-review-02.md`](./project-coordinator-contract-review-02.md)）提出的 2 个 P0 与 6 个 P1 契约缺口 `PC-CX-01..08`。逐项的最小交错序列、权威状态、动作键、恢复路径与可执行断言在 **§19**；规范条款本身落在 §4.2 · §7.2 · §7.6 · §8.5 · §9.4 · §9.5 · §10.2 · §10.4 · §11 · §12.3 · §13.4。v1.1 **不是措辞修订** —— 它改变了状态判定方式（从转移表改为守卫函数）、冲突提交语义（从整事务回滚改为 `ON CONFLICT`）、两个 blocker kind 的 owner、`AWAITING_HUMAN` 的时钟规则，以及 `DONE` 的服务端硬门。
>
> **v1.2 修订**：关闭 02 对 v1.1 的独立复审（[`project-coordinator-contract-review-02-v1.1.md`](./project-coordinator-contract-review-02-v1.1.md)）提出的 1 个 P0 与 5 个 P1 契约缺口 `PC-CX-09..14`。逐项闭环在 **§20**；规范条款落在 §4.1 · §4.3 · §7.2 · §7.7 · §8.2 · §9.5 · §10.3 · §11.2 · §11.5 · §12.1 · §12.3 · §13.4。v1.2 同样**不是措辞修订** —— 它给派发权切换与 Session 插入装上了**同一把数据库行锁**（v1.1 的触发器只做普通 `SELECT`，因此在 MVCC 下读得到已被改写但尚未提交之前的旧值）、把投递次数从幂等摘要里**移出去**、把 dispatch epoch 从可清零的 `failureCount` 换成**单调不复用**的 `task.dispatchAttempt`、把 `opensTurn` 从"当前 owner"改挂到 **kind**、给 `DONE` 与所有会改变验收事实的写路径装上**同一把项目行锁**，并让 `EXECUTING` 与活性判据**如实容纳**合法的 USER-origin Session。
>
> **v1.3 修订**：关闭 02 对 v1.2 的独立复审（[`project-coordinator-contract-review-02-v1.2.md`](./project-coordinator-contract-review-02-v1.2.md)）提出的 6 个 P1 契约缺口 `PC-CX-15..20`。逐项闭环在 **§21**；规范条款落在 §2.4 · §4.3 · §7.2 · §7.3 · §7.7 · §8.1 · §8.2 · §8.6 · §9.4 · §11.1 · §11.3 · §11.5 · §12.1 · §13.1 · §13.2 · §13.4。v1.3 同样**不是措辞修订** —— 它把"这件事发生了几次"从升级与通知里**彻底移出去**、给 blocker 装上**解除后仍然只进不退的生命周期代次**、把 verdict / 聚合 / 验收三个**可回环事实**的动作身份换成持久化单调代次（聚合直接改成无键的 current-state CAS）、把验收事实写入的封闭集合**从摘要的投影反推**出来（因此含 Task 跨 Project 移动、`verifiesTaskId` 改写与外部 ref 变化）、把 `FOR SHARE → UPDATE` 的锁升级换成**单一确定锁序 + 有界重试**，并让派发归属由**数据库自己**证明（延迟约束触发器 + CHECK），而不是只检查一个 id 非空。
>
> **v1.4 修订**：关闭 02 对 v1.3 的独立复审（[`project-coordinator-contract-review-02-v1.3.md`](./project-coordinator-contract-review-02-v1.3.md)）提出的 2 个 P0 与 5 个 P1 契约缺口 `PC-CX-21..27`。逐项闭环在 **§22**；规范条款落在 §2.4 · §4.3 · §6.1 · §6.2 · §6.3 · §7.2 · §7.4 · §7.7 · §8.1 · §8.5 · §8.6 · §9.2 · §9.4 · §9.6 · §10.3 · §12.1 · §12.3 · §12.4 · §13.1 · §13.4 · §19–§22。v1.4 同样**不是措辞修订** —— 它把 I11 的"当前 token"改成**提交时授权 + 终态不可变的历史关系**并给 D9 读取的每一行装上反向约束（在飞 Task 不得跨 Project 移动、`APPLIED` 动作行不可改写）、把 §6.1 从"快照"升级成**完整的 `decisionInput`**（补齐全部代次字段、把时钟折成冻结的到期事实、把会改变决策的事件按身份纳入）并让 `decisionInputHash` 覆盖它的全部、给五个语义 turn 原因装上**首个为真者胜的全序**并冻结"一次 reconcile 至多一条语义 turn"、把 blocker 的 `lifecycleGeneration` 纳入 `turnFacts`、把 `task.dispatch_authority` 从"服务层维护的投影"改成**数据库自己维护并可验证的派生列**（因此旧写端不可能留下 stale `LEGACY`）、给人工撤权与并发上限装上**与派发提交共享的 project 行锁**，并把修订日志 §19–§22 明确降级为**非规范**、给残留旧规范句建一张可被静态检查的账。
>
> **v1.5 修订**：关闭 02 对 v1.4 的独立复审（[`project-coordinator-contract-review-02-v1.4.md`](./project-coordinator-contract-review-02-v1.4.md)）提出的 2 个 P0 与 2 个 P1 契约缺口 `PC-CX-28..31`。逐项闭环在 **§23**；规范条款落在 §2.4 · §4.3 · §6.1 · §7.2 · §7.4 · §7.6 · §7.7 · §8.6 · §9.6 · §10.4 · §12.1 · §14 · §15 · §18 · §22.8。v1.5 同样**不是措辞修订** —— 它把 `maxConcurrentTasks` 从一条"任何顺序下都成立"的当前状态不变量改成**时态明确的准入上限**（I16-A 准入 / I16-B 提交时），因此人调低 cap 永远不被拒绝、在飞的活也永远不被杀，代价是一个**有界、可见、会自己排空**的 over-cap 状态；它把 §7.4 第 8 条的 PAC 执行上下文**冻结成一份带摘要的读集**，并在提交点用与 AU1 同一把锁之后的 `FOR SHARE` 重解析一遍（EC1–EC5 + §7.7 D14），于是"人在快照之后禁用了 Agent"这类撤权与撤权后的派发第一次互斥；它把 `project_action` 的**最小历史投影**（未收敛的验收动作、本代 turn 的原因/摘要/开始时刻/是否结束）纳入 `decisionInput.world`，使 §4.2 守卫 4 与 §7.6 TR1–TR3 读的每一列都进 `decisionInputHash`（S3 因此第一次对这两条规则也成立）；并把 TR2 的限频从"拒绝一次"改成一条**持久、可恢复、有确定唤醒时刻的 pending 请求**（TR2-a–TR2-e + §10.4 第 7 条 + I18）。
>
> **v1.6 修订**：关闭 02 对 v1.5 的独立复审（[`project-coordinator-contract-review-02-v1.5.md`](./project-coordinator-contract-review-02-v1.5.md)）提出的 1 个 P0 与 4 个 P1 契约缺口 `PC-CX-32..36`。逐项闭环在 **§24**；规范条款落在 §4.3 · §6.1 · §7.4 · §7.6 · §7.7 · §10.2 · §10.4 · §12.1 · §14 · §15 · §18 · §22.8。v1.6 同样**不是措辞修订** —— 它把 D14 的解析函数从一个**在 PostgreSQL 上无法执行**的 `STABLE` 改成 `VOLATILE`（取锁的函数不允许是非 volatile，按字面建出来的对象每次调用都抛 `0A000`），并把"这条规范只能靠 `pg_proc.provolatile` 观测、只能靠调用真实 deferred trigger 验证"写成迁移验证的义务；它把 `decisionInput.world` 的采集面从**本文自己的五处判定**扩到**六处**，补上 §7.4 第 8 条读的那条 PAC 解析链（Agent 默认引擎/fallback/能力基线、`projectMemberId`、`workspace.enabled`、`task.workspaceId`、Provider 的 model 空间），因此"同 hash ⇒ 同机械决策"第一次对派发解析也成立；它把 I17 按时态拆成 **I17-A（快照 = 冻结上下文，恒成立）与 I17-B（提交时，点态）**，删掉那条在"控制环先提交、人随后撤权"这条**每一步都合法**的路径上必然为假的当前态查询；它把 `nextWakeAt` 的三句互不相干的话合成**一个候选表加一个确定的选择**（W5：最小值、并列按序号、`now + 5s` 是硬下限、整张候选表落审计），于是限频窗口最后 5 秒第一次有解；它把 I18 从两种形状改成**三种形状**并新增 I19 与 §10.2 W4 的第 (iv) 支，因此"事件已提交、reconcile 还没跑"这段**正常的**异步间隙不再是一条被违反的不变量，而是一条有确定投递责任的形状。>
>
> **v1.7 修订**：关闭 02 对 v1.6 的独立复审（[`project-coordinator-contract-review-02-v1.6.md`](./project-coordinator-contract-review-02-v1.6.md)）提出的 1 个 P0 与 5 个 P1 契约缺口 `PC-CX-37..42`。逐项闭环在 **§25**；规范条款落在 §2.4 · §4.3 · §5.5 · §6.1 · §7.4 · §7.6 · §7.7 · §8.6 · §10.2 · §10.4 · §12.1 · §14 · §15 · §18 · §22.8。v1.7 同样**不是措辞修订** —— 它把 §7.7 D11 从一张**逐列枚举的 denylist** 改成**闭集 allowlist**（`to_jsonb(NEW/OLD) - writable` 整行比较），于是 v1.5 加进 `project_action` 的三列不再是"可以被任何写端原地改写的冻结事实"，I17-A 与 TR2 的窗口锚点第一次真的被钉住；它把 I17-A 按 **PAC §6 的冻结时刻**拆成 I17-A（create 冻结列，恒成立）与 **I17-A2**（`model`/`effort` 按 `session.execution_pin_generation` 分三个阶段），因此"首次 claim materialize"与"`retiredPin` 改写一次"这两条 PAC 明确允许的合法动作不再让一条恒成立命题为假；它给 §10.4 W5 的候选补上 `(subjectType, subjectId)` 这**第三、四个持久排序键**，于是同一 source 同一时刻的两条候选第一次有唯一的 `nextWakeReason`；它把 W5 与 W3 的下限从 `now()` 换成 `evaluation.epoch`，于是 S3 说的"同 hash ⇒ 同 `nextWakeAt`"第一次成立；它把 I19 的量化域说全并新增 §5.5 —— 出环项目（disabled / `SETTLED`）队列里那条事件有了 owner、有了确定的终态处置、有了幂等与重入语义，而 I6 的"静默"逐字保留；它把 EC2 拆成 **EC2-a（授权摘要）与 EC2-b（结果摘要）**并在提交点各比各的，加上 EC6 与 §7.7 D15，于是"九个身份没变、但 Session 结果会不同"这条路第一次既有一个名字（`EXECUTION_RESULT_CHANGED`）又有一道数据库硬门。
>
> **v1.8 修订**：关闭 02 对 v1.7 的独立复审（[`project-coordinator-contract-review-02-v1.7.md`](./project-coordinator-contract-review-02-v1.7.md)）提出的 3 个 P0 与 1 个 P1 契约缺口 `PC-CX-43..46`。逐项闭环在 **§26**；规范条款落在 §0 RL1 · §4.3 · §7.4 · §7.7 · §12.1 · §15 · §18 · §22.8。v1.8 同样**不是措辞修订** —— 四项里有三项是**同一个错误的三个位置**：一条硬门只在"某一时刻之后"生效，而它之后还剩一次写（D11 放过了 §8.3 那条**把动作发布出去的** `CLAIMED → APPLIED` UPDATE）；一条硬门的**作用域**由它保护的那一行自己的 NEW 值决定（D9 / D14 / D15 因此可以被一条 `SET task_id = NULL, dispatch_origin = 'USER'` 关掉，D5 的唯一 claim 随之被释放而那次执行还在跑）；一份"封闭集合"的手工副本比它引用的那张 PAC 表少了三行（D15 的 create 冻结集漏掉 `permissionMode` / `resolution` / `snapshotFrozenAt`，前两项恰好都在 EC2-b 里，于是一条以 `danger-full-access` 跑着的 Session 可以对着一份冻结成 `read-only` 的决策）。第四项是一条**只被写成查询、没有被写成约束**的双向命题（代次与 `detail.retiredPins[]` 的一一对应）。v1.8 的答案是四处：**D11 按 `OLD.status` 分两个闭集 allowlist 并给 `CLAIMED` 一个封闭的 transition 目标集**、**D9 / D14 / D15 的作用域一律读 OLD ∨ NEW 并由 D15 冻住 lineage 三列**、**D15 的 create 冻结集按 PAC §6 的行数补齐并给 `snapshotFrozenAt` 一个唯一来源（EC6-d）**、以及**新增 D16：两条可延迟约束触发器，在 `COMMIT` 证明 Session 实际结果等于动作冻结结果，并把代次与账本钉成双向原子关系**。
>
> **v1.9 修订**：关闭 02 对 v1.8 的独立复审（[`project-coordinator-contract-review-02-v1.8.md`](./project-coordinator-contract-review-02-v1.8.md)）提出的 3 个 P1 契约缺口 `PC-CX-47..49`。逐项闭环在 **§27**；规范条款落在 §4.3 · §7.4 · §7.7 · §12.1 · §15 · §18 · §22.8。v1.9 同样**不是措辞修订** —— 三项里有一条贯穿的线：**一条硬门只查了它那句话的“有没有”，没查“是不是”**。D16 对首次 claim 只查 `claimResolution IS NOT NULL`，于是一份冻结成 `model-v1/high` 的决策可以配一条实际跑 `model-evil/low` 的 Session，只要账本里放一个空对象（`PC-CX-47`）；两个摘要在 §4.3 I17-A 里被宣称"恒成立、对任何二进制成立"，而 §26.5 同时承认伪造的 `execution_result_digest` 只由审计查询发现、不被拒绝，因为**没有任何数据库对象重算过它们**（`PC-CX-48`）；账本的两条规则只数了条数，`claimResolution = {}` 与 `retiredPins = [{}]` 满足全部硬门却说不出旧值、新值、时刻与责任（`PC-CX-49`）。v1.9 的答案是三处：**EC6-c / EC6-e 给两本账一个闭合的语义形状与一条可折叠的链**、**D16 把那次判定收进一个两侧共用的 ⓪ 号函数，并要求链折叠出来的那一对 pin 逐字等于 Session 正在跑的 `model`/`effort`**、以及**新增 D17：把 `canonical` 从一个记号变成一个数据库函数，两个摘要在 `COMMIT` 各按自己的权威输入重算一次，伪造的摘要得到 `EXECUTION_DIGEST_MISMATCH`**。
> **适用分支**：`feat/project`（`main` 里没有 `Project`）。
> **代码基线**：`c088ee04 docs(project): freeze the Project/Agent domain contract`。
> **前置契约**：[`docs/project-agent-contract.md`](./project-agent-contract.md)（下称 **PAC**）。本文**不重新定义** PAC 已冻结的任何术语、字段、解析链或错误码；凡引用一律写作 `PAC §n`。
> 两份契约的分工是一句话：**PAC 冻结"一件事怎么变成一次运行"，本文冻结"下一件事是哪一件、由谁在什么时候决定"。**
> **本文只描述目标状态与迁移路径**；已有实现的现状写在 §12 兼容矩阵里。

---

## 0. 本文要解决的问题

今天的 Project 是一个**被动的 Session 引用**：`project.coordinatorSessionId` 指向一段对话，而 schema 的注释把它写得很明白 —— "A pointer, never a dependency, exactly as `TaskList.ownerSessionId` is: nothing on the dispatch path reads it"。于是一个 OPEN 的 Project 可以在没有任何人发现的情况下**静默空转**：没有任务在跑，没有阻塞被记录，没有下一次检查被安排，控制面上它和一个正在飞速推进的项目长得一模一样。

本文把它升级成一个**事件驱动、可恢复、可审计的控制环**，并且只用两件事换：一组执行基础设施表，和一小组落在 `project` / `task` 上的业务字段。**不新增任何业务实体**（§2.3）。

**RL1（哪些部分是规范的，v1.4 冻结，v1.5 扩展到 §23，v1.6 扩展到 §24，v1.7 扩展到 §25，v1.8 扩展到 §26，PC-CX-27）**：**§1–§18 是规范正文，§19–§26 是非规范的修订日志。** 修订日志记录每一轮审查提出了什么、当时的规则是什么形状、为什么改 —— 它们对实现**没有约束力**，与正文冲突时一律以正文为准。这条规则的作用是让"删掉被取代的旧规范句"成为一件可以机械检查的事：一句被取代的规范，要么被删，要么只能出现在 §19–§26 或反例测试里。02 的第四轮审查发现正文里同时留着 AG1 与 AG5（聚合有键 / 无键）、AE8 与 AE6-a（`FOR SHARE` / `FOR NO KEY UPDATE`）两对相反的规范，按哪一条实现都能引用"冻结"二字（`PC-CX-27`）。§22.8 因此额外维护一张**残句账**（它是规范的，且随每一轮修订一起长大 —— v1.5 加了六行，v1.6 又加了七行，v1.7 再加了十行，v1.8 再加了三行），契约测试对正文逐条扫描它。

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

以及八列：`task.dispatchAuthority`（§12.3，**v1.4 起是数据库自己维护的派生列**，见 §7.7 D12）、**`task.dispatchAttempt`（§8.2 DA1，v1.2 新增）**、**`task.verdictRevision`（§13.2 V7，v1.3 新增）**、`session.projectActionId`（§8.3）、`session.dispatchOrigin`（§7.7）、**`session.executionPinGeneration`（§4.3 I17-A2 · §7.7 D15，v1.7 新增：`BigInt NOT NULL DEFAULT 0`，PAC §6 的 claim 冻结列改了几次）**、`project_runtime.*`（v1.3 起含 `acceptance_attempt`，§13.4 AE11）、**`project.configRevision`（§9.6 AU2，v1.4 新增）**。

新表自己的列不计入上面这个数（它们随表一起来）：v1.3 给 `project_blocker` 加了 `lifecycle_generation`（§11.3 BE1），给 `project_runtime` 加了 `acceptance_attempt`（§13.4 AE11）；**v1.5 给 `project_action` 加了 `execution_context` 与 `execution_context_digest`（§7.4 EC1/EC2）、给 `project_action` 加了 `reason_code`（§7.6 TR2-a 的窗口锚点要按原因查它）；v1.7 给 `project_action` 加了 `execution_result_digest`（§7.4 EC2-b，结果摘要与授权摘要分列）、给 `project_event` 加了 `disposition`（§5.5 EV2 的三个终态处置）**。**这三个新计数（派发、blocker 周期、验收）与 `task.verdictRevision` 是同一条纪律的四个实例**：永久动作键的代次必须来自一个只进不退的持久化列（§8.2 GE1）。

以及两个**不是表也不是列**的数据库对象，它们承担 §7.6 的派发线性化（**每一个都必须由数据库自己执行，因此对任何版本的二进制都成立**）：

| 对象 | 类型 | 职责 |
|---|---|---|
| `session_task_execution_claim_idx` | partial unique index | 同一 Task 至多一条**占位中**的 Session（§7.7 D5） |
| `session_dispatch_authority_guard` | `BEFORE INSERT` trigger | `dispatchAuthority = 'COORDINATOR'` 的 Task 只接受带派发权的插入（§7.6 D6） |
| `session_dispatch_attribution_check` | `DEFERRABLE INITIALLY DEFERRED` constraint trigger | **提交时**证明 COORDINATOR 占位对应一条本 Task/本 Project/当前 token 的 `APPLIED` `DISPATCH_TASK`（§7.7 D9，v1.3 新增） |
| `session_action_only_for_coordinator_chk` | `CHECK` constraint | 非 COORDINATOR origin 的 Session 不得带动作 id（§7.7 D9，v1.3 新增） |
| `project_blocker_episode_idx` | unique index | 同一 `(project, dedupeKey)` 上的生命周期代次不可复用（§11.3 BE1，v1.3 新增） |
| `task_claimed_project_move_guard` | `DEFERRABLE INITIALLY DEFERRED` constraint trigger | 有占位的 Task 不得改 `project_id`（§7.7 D10，v1.4 新增） |
| `project_action_applied_immutable_guard` | `BEFORE UPDATE` trigger | `APPLIED` 动作行的归属列与 `status` 此后不可改写（§7.7 D11，v1.4 新增） |
| `task_dispatch_authority_projection` | `BEFORE INSERT OR UPDATE` trigger（task）+ `AFTER UPDATE` trigger（project） | `task.dispatch_authority` 恒等于它的派生值，**由数据库维护**（§7.7 D12，v1.4 新增） |
| `session_execution_context_guard` | `DEFERRABLE INITIALLY DEFERRED` constraint trigger | **提交时**证明 COORDINATOR 占位的 PAC 执行上下文（Agent / 团队成员 / Task / Provider / Model / Workspace / Runner / 协调 Workspace）仍然授权它（§7.7 D14，v1.5 新增） |
| `session_execution_snapshot_guard` | `BEFORE INSERT OR UPDATE` trigger | 占位的 create 冻结列**必须等于**动作行上的 `execution_context`，此后不可改写；`model`/`effort` 每改一次 `execution_pin_generation` 必须恰好 +1（§7.7 D15 · §4.3 I17-A2，v1.7 新增） |

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
- **I11（派发归属，v1.2 新增）**：任何占位中的 Session 都可归属到一个入口：`dispatch_origin = 'COORDINATOR'` ⟹ `project_action_id` 非空且该动作 `APPLIED`；`= 'USER'` ⟹ 人的显式动作，`project_action_id` 为 NULL；`= 'LEGACY_SWEEP'` ⟹ 该 Task 的 `dispatch_authority = 'LEGACY'`。三条都由 §7.7 D6 触发器的放行分支保证，因此对任何版本的二进制成立。**"谁派的"是一次列查询，不是一次考古**（`PC-CX-14`）。**v1.3 收紧（PC-CX-20）**：v1.2 的 D6 只检查 `project_action_id IS NOT NULL`，它读不到本条声称保证的任何一列（type / status / subject / project / fencing token），因此这条不变量在真实数据库上**是可以被违反的** —— 插一条 `NOOP`/`CLAIMED` 的动作行就够了。v1.3 由 §7.7 D6 的完整谓词（插入时）与 D9 的可延迟约束触发器（**提交时**）共同保证，`USER`/`LEGACY_SWEEP` 那两句由 CHECK 约束保证。**v1.4 改述（PC-CX-21）**：v1.3 把本条写成"动作的 `fencing_token` 等于 runtime **当前** token"，那是一个**会被下一次正常租约弄假**的等式 —— reconcile 每成功取一次租约就 +1（§8.1），而被它派出去的 Session 仍然在飞。等式表达的是**提交时的授权**，不是一条恒成立的归属关系，把它写成不变量等于要求"这个项目此后不得再 reconcile"。v1.4 把这条不变量拆成**时态明确的两句**，两句都可以对任意已提交状态直接查：

  - **I11-A（归属，恒成立）**：`dispatch_origin = 'COORDINATOR'` 的占位 Session ⟹ `project_action_id` 指向一条 `type = 'DISPATCH_TASK'`、`status = 'APPLIED'`、`subject_type = 'TASK'`、`subject_id = session.task_id`、`project_id = task.project_id` 的动作行，且 `action.fencing_token <= project_runtime.fencing_token`（token 单调，故这一项**只会保持为真**）。`USER` / `LEGACY_SWEEP` 两句逐字不变。这三行读到的每一列都被**反向约束**钉住：Task 的 `project_id` 在占位期间不可改（D10）、`APPLIED` 动作行的归属列不可改写（D11）、`fencing_token` 单调不回退（§8.1）。
  - **I11-B（提交时授权，点态）**：一条 COORDINATOR 占位被提交的**那一刻**，`action.fencing_token = project_runtime.fencing_token`。它由 §7.7 D9 在 `COMMIT` 时执行，**只在那一刻成立**，此后不再被要求 —— 它证明的是"这次派发由当时的租约持有者提交"，不是"这个动作永远是最新的"。

  两句合起来给出的正是审查要的东西：**归属用的是稳定的历史关系，token 的时态被限定在派发提交点**。
- **I12（授权投影，v1.4 重写，PC-CX-25）**：v1.2 把这一条写成"占位来源与**当前**授权相容"，并用 §7.7 D8 的"有占位就不翻转"去维持它。那个维持方式有两个代价，第二个是 P0：一是它需要一个"占位释放时补投影"的第三写入点，二是**三个写入点全在新服务层**，于是一个不认识新列的旧写端把 Task 移进一个已启用 Coordinator 的 Project、或结束一条占位，都会留下 stale `LEGACY`，而 D6 会忠实地按这个陈旧值放行旧 sweep —— §12.4 声称"与二进制版本无关"的那一格因此是假的。v1.4 把它拆成两句，**第一句由数据库自己维护**：

  - **I12-A（投影新鲜，恒成立，由 D12 保证）**：任何已提交状态上，`task.dispatch_authority` 恒等于它的派生式
    `authorityOf(task) = (task.project_id IS NOT NULL ∧ project.coordinator_enabled) ? 'COORDINATOR' : 'LEGACY'`。
    它由 §7.7 D12 的触发器在**每一次**写 `task.project_id` / `task.dispatch_authority` / `project.coordinator_enabled` 时重算，因此**对任何版本的二进制成立**，也因此可以写成一条对生产快照直接跑的漂移查询（D13）。
  - **I12-B（无越权新派发，恒成立，由 D6 保证）**：**没有一条占位是在它的来源已经不被当前授权允许之后插入的** —— `COORDINATOR` 权的 Task 上不存在翻转之后插入的 `LEGACY_SWEEP` 占位，`LEGACY` 权的 Task 上不存在翻转之后插入的 `COORDINATOR` 占位。**两个方向都要写**，因为 v1.4 的翻转不再等占位，所以两个方向都可能留下一条 pre-flip 占位。这一句不需要观测插入时刻：D6 在 `FOR SHARE` 下读授权（§7.7 D6 / D8），因此翻转之后的越权插入在物理上不可能提交。推论是任何一条与当前授权不匹配的占位**必然**是翻转前插入的 —— 它是一个**有界**状态：随该 Session 落终态而消失，且不可能再产生新的。这两条 pre-flip 占位都不会导致重复派发：该 Task 有占位，§7.4 第 4 条与 D5 各挡一次。

  **这是一次行为变更**：v1.2 的"有占位就不翻转"被删除（§7.7 D8）。买到的是"投影永不陈旧、且不依赖任何一个版本的服务层"，让出的是"翻转与占位来源在每个瞬间都相容"这句更强、但只由服务层维持因而其实并不成立的话。
- **I13（动作身份单调，v1.3 新增）**：`project_action` 里每一条键的 `<epoch>` 都来自 §8.2 GE1 表里那个持久化、单调、永不复用的列（`AGGREGATE_PARENT` 无键、`OPEN_COORDINATOR_TURN` 按 GE4 例外）。可测形式：把世界从 A 变到 B 再变回 A，任何一个动作在第二个 A 上算出的键都不得等于它在第一个 A 上算出的键（`PC-CX-16` / `PC-CX-17`）。
- **I14（重复投递等价，v1.3 新增）**：同一份世界事实被投递 N 次（任意 N、任意顺序、跨重启）后，持久化的 `run_state`、每条 blocker 的责任人/`recovery`/`required_action`/代次/`escalated_at`、通知条数与是否升级，都必须与 N = 1 时**逐字节相同**；允许随 N 变化的只有 `occurrences` 与 `last_seen_at`（§11.5 BL7 / ES5）。这是 §5.1 E1 从"事件不携带事实"推出来的那一半在**状态**上的形式（`PC-CX-15`）。
- **I15（一次快照至多一条语义 turn，v1.4 新增，PC-CX-23）**：一次 reconcile 的 outcome 里 `type = 'OPEN_COORDINATOR_TURN'` 的动作**至多一条**，且它的 `reasonCode` 由 §7.2 TU4 的全序唯一决定。可测形式：枚举五个原因谓词的全部 32 个真值组合，每一组都恰好得到零或一个 `reasonCode`，且与遍历顺序无关。
- **I16（授权在提交点复核，v1.4 新增，v1.5 按时态拆成两句，PC-CX-26 / PC-CX-28）**：v1.4 把这一条写成一句，而它的后半"同一 Project 的占位 Session 条数 > `max_concurrent_tasks` 不存在"是一条**当前状态**不变量 —— 它要求这个数在**任何**已提交状态上都成立，包括"控制环合法派完之后，人把 cap 调低"之后的那个状态。两件事同时是真的：那次派发在提交时完全合法（AU1-a 第二行明确允许），那次调低也完全合法（它是用户对自己设的数的修改）。于是这条不变量在一条**没有任何参与者做错事**的路径上为假 —— 与 `PC-CX-21` 的 I11 是**同一个错误的第二个实例**：把一条只在某个时刻成立的性质写成了恒成立。v1.5 按同样的手法拆成两句，两句都可以对任意已提交状态直接查：

  - **I16-A（准入，恒成立）**：**没有一条占位 Session 是在"它被插入的那一刻本 Project 的占位数已经 ≥ 当时的 `max_concurrent_tasks`"之后被插入的。** 等价的可查询形式见 §9.6 CAP0-c：占位行按 `created_at` 升序编号，第 n 条（n 从 1 起）在它自己的插入时刻必须满足 `n <= 当时的 max`。因为 cap 只在 `project` 行上，而两个入口都在 §9.6 CAP1 的同一把行锁之后数同一个 `count(*)`，这个"当时的 max"与"当时的占位数"是**同一个事务读到的一对值**，因此这一句不需要观测任何外部时刻。
  - **I16-B（提交时授权，点态）**：一条策略门控动作被提交的**那一刻**，其提交事务在 `project` 行锁之后重读到的 `coordinator_enabled` / `automation_policy` / `max_concurrent_tasks` / `session_budget_per_day` 仍然允许它，且此刻 `inFlight < max_concurrent_tasks`。它由 §9.6 AU1 / CAP1 在那一刻执行，**只在那一刻被要求**。恒成立的那一半是"不存在 `coordinator_enabled = false` 之后由控制环创建的占位 Session"——`coordinator_enabled` 与 `automation_policy` 是**开关**而不是**计量**，关掉之后不存在"合法地多出来一条"的读法，因此它们那一半照 v1.4 逐字不变。

  两句合起来给出的正是审查要的唯一语义：**cap 是一条准入上限，不是一条当前状态上限**（§9.6 CAP0）。推论是一个**有界且可见**的 over-cap 状态：`inFlight > max` 只能由一次人工调低产生，它不再准入任何新占位，随在飞 Session 结束单调收敛，并且在 `decisionInput`、审计行与控制面上都看得见（CAP4）。**这是一次行为变更**：v1.4 的"任何顺序下已提交的占位数 ≤ max"被删除，买到的是"人调低 cap 永远不被拒绝、在飞的活永远不被杀"，让出的是那句更强、但只要人有权调低 cap 就不可能为真的话。
- **I17（执行上下文在提交点复核，v1.5 新增，v1.6 按时态拆成两句，PC-CX-29 / PC-CX-34）**：v1.5 把这一条写成一句，并给了它一个"等价的可查询形式" —— **不存在**一条 COORDINATOR 占位，其 `agent_id` 指向一个 `enabled = false` 的 Agent（或非团队成员、或不可用的 Provider / Workspace / Runner）。那句话是一条**当前状态**不变量，而 AU1-a 第二行、F35 与 PAC §6 的快照冻结**同时**明确：控制环先合法提交，人随后撤权，撤权照常生效且**在飞 Session 一条不动**。于是在一条**没有任何参与者做错事**的路径上，那个查询必然返回非零行（`PC-CX-34`）。这与 `PC-CX-21` 的 I11、`PC-CX-28` 的 I16 是**同一个错误的第三个实例**：把一条只在某个时刻成立的性质写成了恒成立。v1.6 按同一手法拆成两句：

  - **I17-A（create 冻结列与占位一致，恒成立，可对生产快照直接查，v1.7 按 PAC §6 的冻结时刻收窄，v1.8 按 PAC §6 的行数补全，PC-CX-38 / PC-CX-44）**：**不存在**一条 `dispatch_origin = 'COORDINATOR'` 的占位 Session，其 **create 冻结列**（PAC §6 表里冻结时刻为 "Session create" 的**每一行**：`agent_id` / `provider` / `provider_builtin` / `workspace_id` / `assigned_runner_id` / `required_capabilities` / `permission_mode` / `resolution` / `snapshot_frozen_at` —— v1.7 只写了前六行，漏掉的三行里 `permission_mode` 与 `resolution` 恰好都在 EC2-b 里，于是一条以 `danger-full-access` 跑着的 Session 可以对着一份冻结成 `read-only` 的决策，`PC-CX-44`）与它 `project_action_id` 指向的那条 `status = 'APPLIED'` 的 `DISPATCH_TASK` 行上的 `execution_context` 对应分量不一致；也不存在一条这样的占位，其动作行缺失、非 `APPLIED`、或 `execution_context_digest` / `execution_result_digest` 与 `execution_context` 重算出来的两个摘要不等（§7.4 EC2-a / EC2-b）。**这一句只读不可回退的东西** —— 这几列在 create 之后只读（PAC §6），`APPLIED` 动作行由 §7.7 D11 钉成不可改写 —— 因此它在任何已提交状态上都成立，且**与人此后改了什么无关**。它由 §7.7 D15 在插入时按等式构造、由 §7.7 D16 在 `COMMIT` 对最终状态再证明一次；**两个摘要那一半由 §7.7 D17 在 `COMMIT` 用数据库自己的规范化函数各按自己的权威输入重算一次**（v1.9 补上，`PC-CX-48`：v1.8 这一句里的摘要那半没有任何数据库对象在看，§26.5 同时承认一条伪造的 `execution_result_digest` 可以提交），因此**对任何版本的二进制成立**。
  - **I17-A2（claim 冻结列的阶段与代次，恒成立，v1.7 新增，PC-CX-38）**：`model` 与 `effort` 的冻结时刻**不是** create，而是 **首次 claim**（PAC §6 `model`/`effort` 行 + S1，这是刻意保留的既有实现），且 PAC 保留了一个合法例外：模型被 runtime 彻底下架（`retiredPin`）时改写一次。因此关于这两列的恒成立命题必须**带阶段**，而阶段必须是一个**持久、单调、可查询**的列 —— `session.execution_pin_generation`（`BigInt NOT NULL DEFAULT 0`，§2.4，与 §8.2 GE1 的代次是同一条纪律）：

    | 代次 | 阶段 | 恒成立的话 |
    |---:|---|---|
    | `0` | create 之后、首次 claim 之前 | `model IS NULL ∧ effort IS NULL`（PAC §6 S1：这两列此刻**还没有**被解析），且动作行上没有 `detail.claimResolution`、`detail.retiredPins[]` 为空 |
    | `1` | 首次 claim 已 materialize | 动作行上有一条满足 §7.4 EC6-c **闭合形状**的 `claimResolution`（`detail` 是 D11-b 的两个可写列之一），它的 `model.frozen` / `effort.frozen` 逐字等于 `execution_context` 的对应分量：冻结分量是具体值时 `value` 就是它，冻结分量是 `DEFERRED_TO_CLAIM` 时（PAC §7.2 优先级 3 把 model 留给 claim 时的 runtime 默认）`value` 是这次 claim **实际解析到**的那个值；两个 `value` 逐字等于 `session.model` / `session.effort` |
    | `n ≥ 2` | 发生过 `n − 1` 次 `retiredPin` 改写 | 该 Session 上恰好有 `n − 1` 条满足 EC6-c 闭合形状的 `detail.retiredPins[]` 记录，第 k 条（k 从 0 起）的 `generation = k + 2`、`from` 等于该分量此刻的值；整条链按 §7.4 EC6-e 折叠之后得到的那一对值逐字等于 `session.model` / `session.effort` |

    **两个方向都要查**：代次说了几次，记录就必须有几条；有记录而代次没动，或代次动了而没有记录，都是缺陷。代次只增不减（§7.7 D15），因此这一条一旦为真就永远为真。**v1.8（PC-CX-46）：这句话现在有一个数据库可执行的形式。** v1.7 把它写成了一条只能被查询的话 —— D15 的 SQL 从未读过 `project_action.detail`，而 `detail` 又是 D11-b 放开的可写列，于是真实 PostgreSQL 接受 `execution_pin_generation = 2` 而 `retiredPins` 为 0 条的已提交状态：代次声称发生过一次替换，审计账本声称零次，**没有任何幂等身份能判定哪一侧权威**。§7.7 D16 把两个方向各配一条可延迟约束触发器（Session 侧一条、动作侧一条），因此代次与账本此后是同一次提交里的**双向原子关系**，与写它的是哪个版本的二进制无关。

    **v1.9（`PC-CX-47` / `PC-CX-49`）：这本账现在有语义，不只有条数。** v1.8 的两条 D16 函数只问"有没有 `claimResolution`、`retiredPins` 是不是 `n − 1` 条"，于是 `generation = 1` + `claimResolution = {}` 让一条冻结成 `model-v1/high` 的决策合法地配上一条实际跑 `model-evil/low` 的 Session（`PC-CX-47`），而 `generation = 2` + `retiredPins = [{}]` 通过全部硬门却说不出旧值、新值、时刻与责任（`PC-CX-49`）。**数了条数不等于记了账。** v1.9 把两本账的形状按 §7.4 EC6-c 闭合、按 EC6-e 折叠成一条链，并要求折叠结果逐字等于 Session 此刻的 `model` / `effort`：于是"首次 claim 实际取到了什么"、"账本连不连得上"与"这条 Session 现在到底在跑什么"是**同一次判定**，空对象、缺字段、错链、错代次、超前或落后的时刻都在 `COMMIT` 得到 `EXECUTION_PIN_LEDGER`。
  - **I17-A3（lineage 恒成立，v1.8 新增，PC-CX-45）**：一条 `dispatch_origin = 'COORDINATOR'` 且 `task_id` 非空的 Session，其 `task_id` / `dispatch_origin` / `project_action_id` 三列在 create 之后**再也不变**。这一条不是"又一列只读"，它是上面每一条硬门的**前提**：D5 用 `task_id` 做索引谓词，D6 / D9 / D14 / D15 / D16 用 `task_id` + `dispatch_origin` 定作用域，I11 与 I17-A 用 `project_action_id` 做连接。三列可写 ⇒ 一条 UPDATE 就能把这一行写出所有硬门的量化域，同时释放 D5 的唯一 claim 而那次执行还在跑（`PC-CX-45`）。**等价的可查询形式**：不存在一条 `status = 'APPLIED'` 的 `DISPATCH_TASK` 行，其 `result_session_id` 指向的 Session 不再反向指着它 —— 即 `a.result_session_id = s.id ∧ s.project_action_id ≠ a.id` 恒为空集。它由 §7.7 D15 的 `UPDATE` 分支冻结构造。
  - **I17-d（v1.6 为什么把 `model` 写进了 I17-A，v1.7 记下来，PC-CX-38）**：v1.6 把 I17 按时态拆成 I17-A / I17-B 时，照抄了 PAC §6 的**表头**（"Execution Snapshot 冻结契约"）而没有读它的**冻结时刻那一列** —— `model` / `effort` 两行写的是"首次 claim"，不是"Session create"。于是 I17-A 在**正常生命周期的第一个已提交状态上**就为假：`INSERT` 出来的 PENDING 占位 `model IS NULL`，而动作行上冻结的是 `model-v1`；`retiredPin` 之后又为假第二次（`PC-CX-38`）。**这不是时态错误的第四次，是它的对偶**：`PC-CX-21` / `PC-CX-28` / `PC-CX-34` 都是"把点态写成了恒成立"，这一条是"把**多个**冻结时刻写成了**一个**"。教训因此也不同：**一条跨文档的恒等式，必须逐字段核对被引用那份契约的冻结时刻，而不是核对它的表名。**
  - **I17-B（授权在提交那一刻成立，点态）**：一条 COORDINATOR 占位被提交的**那一刻**，其提交事务在 §8.6 LO1 的锁序上重解析出的 PAC 执行上下文，与动作行上冻结的 `execution_context_digest` **逐字相同**（§7.4 EC1–EC3）。它由 §7.7 D14 的可延迟约束触发器在 `COMMIT` 执行，因此**对任何版本的二进制成立**，**且只在那一刻被要求**；服务层的 EC3 只是让拒绝在应用层就有一个类型化的名字，不是这条的依据。它的审计形式是历史点态的：`project_action` 上的 `execution_context` / `execution_context_digest` 与 `project_decision` 记下了那一刻读到了什么（§9.6 AU2 的同一条纪律）。
  - **I17-c（那条被删掉的当前态查询是什么）**：`enabled = false ∧ 一条指向它的 live Session` 是一个**合法**的已提交状态，不是违约。它的正确读法是 §9.6 CAP4 的 over-cap：一个**有界、可见、会自己排空**的残留 —— 那条 Session 跑完就没有了，而撤权之后**没有任何新的**占位能被提交（I17-B + D14）。因此它既不开 blocker，也不产生任何清理动作；§9.3 第 4 条那一类"杀掉在飞 Session"的破坏性动作**永不代劳**，PAC §6 的快照冻结也逐字要求"软删 Agent 不影响在飞 Session"。**要观测它**：`decisionInput.world.team[].enabled` 与 `sessions[]` 已经同时在输入里，控制面按 AC10 展示"这条运行用的 Agent 已被停用，等它结束"。
- **I18（显式请求不丢失，v1.5 新增，v1.6 补上第三种形状并按 W5 松开边界，PC-CX-31 / PC-CX-35 / PC-CX-36）**：v1.5 写的是"任何已提交状态上"只有两种形状（已消费，或未消费 ∧ `next_attempt_at IS NOT NULL` ∧ `next_wake_at <= next_attempt_at`）。**这句话在正常主路径上短暂但确定地为假**：用户接口在业务事务里插入 `(kind = 'user.manual_trigger', consumed_at = NULL, next_attempt_at = NULL)`（§5.3 N4），消费者是**异步**的（§5.4：1s 轮询 + `NOTIFY`），因此从这次提交到下一次 reconcile 之间，这一行两种形状都不属于（`PC-CX-36`）。v1.6 把它写成**三种形状，封闭**，每一种都能对任意已提交快照直接查：

  - **I18-A（已回答）**：`consumed_at IS NOT NULL` —— 它已被一次 turn 或一条 `COORDINATOR_NO_PROGRESS` blocker**回答**过（§7.6 TR2-c）。
  - **I18-B（待首次消费，v1.6 新增）**：`consumed_at IS NULL ∧ next_attempt_at IS NULL ∧ attempts = 0` —— 它**还在 outbox 队列里**，一次 reconcile 都还没看过它。这条形状的投递保证**不是** `project_runtime.next_wake_at`（§5.4 的消费者根本不读它），而是三条互相独立的路：①§5.4 的消费者（≤1s 轮询 + `NOTIFY`）；②任何一次因为别的原因发生的 reconcile —— `signals` 取的是**当前未消费的全部**（§6.1 S7），不是队列递给它的那一条；③§10.2 W4 的第 **(iv)** 支（v1.6 新增）：一条躺过 `L` 硬上限（5min）还没被消费的事件本身就是 backstop 的命中条件。**三条都断了才会丢**，而第三条会把这件事变成一条 WARN 与一个可查询的谓词，不是沉默。
  - **I18-C（已看过、被限频，等窗口）**：`consumed_at IS NULL ∧ next_attempt_at IS NOT NULL` 且其 Project 的 `project_runtime.next_wake_at IS NOT NULL ∧ next_wake_at <= next_attempt_at + 5s`。末尾这 5 秒是 §10.4 W3 的下限（W5 第 3 条）在被限频请求落在窗口最后 5 秒时的**精确**松弛量，不是一个安全余量：`chosen.at ≤ next_attempt_at` 且 `nextWakeAt = max(chosen.at, evaluation.epoch + 5s)`（v1.7 把这里的时钟换成冻结的那一个，`PC-CX-40`），而这次求值判定它**被限频**就意味着窗口还没过期，即 `epoch < next_attempt_at`，因此 `nextWakeAt < next_attempt_at + 5s` 恒成立。v1.5 写的是 `<= next_attempt_at`，那个上界在窗口最后 5 秒里与 W3 无解（`PC-CX-35`）。

  **没有第四种形状**。特别地：`consumed_at IS NULL ∧ next_attempt_at IS NULL ∧ attempts > 0` 是缺陷（消费者要么消费它、要么按 §5.4 写退避），一条被限频拒绝、又被消费掉的显式请求同样是缺陷 —— 那是一次用户看不见的静默忽略。
- **I18-note（为什么事件生产者不原子写 runtime wake，v1.6 冻结，PC-CX-36）**：审查给了两条路，v1.6 选第二条并把理由写下来：

  | 选项 | 结果 | 为什么不选 / 为什么选 |
  |---|---|---|
  | A：生产者在同一事务里初始化 `next_attempt_at` 并把 `project_runtime.next_wake_at` 前移 | I18 回到两种形状 | **不选。** 它要求**每一次**业务写（每一条 `task.updated` / `session.ended` …）都去写同一个 Project 的 `project_runtime` 行 —— 一个项目内的全部并发写从此在一行上排队，而 §5.3 N3 的批量合并、§5.4 的 partial unique index 都是为了**不**让事件量放大成写放大。它换到的只是"少一种形状"，而那种形状本来就有确定的投递路径 |
  | B：把 I18 的形状说全，并给待消费事件一条**可查询**的投递不变量 | I18-B 明确承认异步间隙，W4 第 (iv) 支把"躺太久"变成一次命中 | **选它。** 与 §5.1 E1 是同一条纪律：事件是信号不是事实，因此"它什么时候被看见"是一条**活性**约束（有 backstop 兜底），不是一条要靠加锁维持的**安全**约束。它不改变任何写路径，只补一条谓词 |
- **I19（待消费事件的责任域，v1.6 新增，v1.7 说全量化域，PC-CX-36 / PC-CX-41）**：v1.6 写的是"任何已提交状态上，一条 `consumed_at IS NULL` 的 `project_event`，要么它的 Project 满足 §10.3 的四条之一，要么它落在 §10.2 W4 的命中集合里"。**这句话在两个正常状态上为假**，因为 §10.3 与 W4 都逐字要求 `status = OPEN ∧ coordinatorEnabled ∧ run_state ≠ SETTLED`，而 §5.3 N1 对 `task.*` / `session.*` / `merge.*` 的产生**只看 `task.projectId` 非空**，没有任何 enabled/status 过滤：一个 `coordinatorEnabled = false` 的 legacy 项目上的 Task 更新会提交一条事件（I6 又禁止它 reconcile），一个已 `SETTLED` 的项目上在飞 Session 结束会提交一条 `session.ended`（W4 排除它）。两格都得到一条**没有人负责、backstop 也看不见**的已提交行（`PC-CX-41`）。v1.7 把量化域说全，**三支封闭**：

  - **I19-a（在环）**：该 Project 满足 §10.3 的四条之一 —— 有人正在推进它，这条事件会在下一次 reconcile 被读到（§6.1 S7 取的是**当前未消费的全部**）。
  - **I19-b（迟到，backstop 看见）**：该 Project 在环但躺得太久，落在 §10.2 W4 的命中集合里（第 (i)/(ii)/(iii)/(iv) 任一支），命中即 WARN。
  - **I19-c（出环，有终态处置，v1.7 新增）**：该 Project **出环**（§5.5 EV3 的谓词：`status ≠ OPEN` ∨ `coordinatorEnabled = false` ∨ `run_state = SETTLED`）。此时它的责任人是 §5.4 的**消费者本身**，确定动作是 §5.5 EV3 的**一次原子丢弃**（`consumed_at` + `disposition = 'DISCARDED_OUT_OF_LOOP'`），**不是**一次 reconcile：不取租约、不产生任何 `project_action` / blocker / 唤醒，因此与 I6 不冲突。

  等价的说法：**一条未消费的事件不可能既没有人管、又不被 backstop 看见、又没有一条终态处置**。这一条与 I5 的分工是：I5 说"该有时钟的时候必须有时钟"，I19 说"队列里躺着的东西必须有人负责去看**或者**有人负责把它收掉"。**没有第四支**：三支的谓词是对 Project 当前行的一次划分（在环 ∧ 不迟到 / 在环 ∧ 迟到 / 出环），因此对任意已提交状态恰好命中一支。
- **I5（不静默空转）**：`project.status = OPEN ∧ coordinatorEnabled ∧ run_state ∉ {AWAITING_HUMAN, SETTLED}` ⟹ `project_runtime.next_wake_at IS NOT NULL`。这是 AC3 的**可查询形式**（§10.3）。**v1.1 收紧**：`AWAITING_HUMAN` 的豁免不再是整个状态，而只是 §10.4 N-null 列出的那一种情形（全部 open blocker 都 `recovery = HUMAN` 且都已升级）；其余的 `AWAITING_HUMAN` 同样必须有 `next_wake_at`，由 §10.2 W4 的第 (ii) 支抓。
- **I6（旧项目静默，v1.7 按 I19-c 分清"不 reconcile"与"队列处置"，PC-CX-41）**：迁移生成的 `project_runtime` 一律 `run_state = PLANNING`、`coordinatorEnabled = false`、`next_wake_at = NULL`，**不 reconcile、不取租约、不产生任何动作 / blocker / 唤醒 / 通知**（§12.1）。v1.1–v1.6 这里逐字写的是"不消费事件、不 reconcile"，而 §5.3 N1 照样会为它的 Task 写产生事件，于是那些行**永远**留在队列里 —— 既不被消费，也不被任何一支 backstop 看见（`PC-CX-41`）。v1.7 把两件事分开：**静默说的是控制环不对它做任何事**，而队列里那一行由 §5.5 EV3 的**丢弃**（不是 reconcile 的消费）收掉。丢弃写 `project_event` 一行，不碰 `project_runtime`、不碰 `project`，因此"这个项目在控制面上完全安静"逐字不变。
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

### 5.5 出环项目的事件处置（v1.7 新增，PC-CX-41）

§5.4 只说了"在环的项目怎么消费"。§5.3 N1 却对**任何**有 `projectId` 的 Task / Session / merge 写产生事件，而一个项目可以合法地**不在环里**：它从来没被启用（I6 的 legacy 项目）、被人关掉了 `coordinatorEnabled`、`status` 已经是 `DONE` / `CANCELLED`、或 `run_state = SETTLED`。这些行既不该被 reconcile（I6、§10.3、W4 三处都排除它们），也不该永远躺在队列里 —— 那正是 `PC-CX-41`。本节给它们一条**终态处置**，五句冻结：

- **EV1（处置由**当前世界**决定，不由事件决定）**：一条事件是丢弃还是消费，在**取到它的那一刻**按 Project 当前行判定，**绝不**按事件的 `kind` / `payload` / `occurredAt` 判定。这与 §5.1 E1 是同一句话：事件是信号不是事实。推论是重入自动正确 —— 一条在项目出环时入队、在它被重新启用（G3）或原子重开（§13.4 AE8）之后才被取到的事件，得到的是**消费**，不是丢弃。
- **EV2（处置集合封闭，三个终态）**：`RECONCILED`（一次 reconcile 提交并消费了它，§5.4）、`DISCARDED_OUT_OF_LOOP`（本节）、`DEAD`（连续失败 10 次，§5.4 + F22）。落在 `project_event.disposition` 这一列上（§2.4，v1.7 新增；历史行的默认值是 `RECONCILED`，因为 v1.7 之前**只有**这一条路能写 `consumed_at`）。**没有第四个** —— 一条 `consumed_at IS NOT NULL` 而 `disposition IS NULL` 的行是缺陷。
- **EV3（出环谓词与确定动作）**：出环 = `project.status <> 'OPEN'` ∨ `NOT project.coordinator_enabled` ∨ `project_runtime.run_state = 'SETTLED'`（与 §10.3 / §10.2 W4 的准入谓词**互补**，因此两者的并集覆盖全部已提交状态，见 I19）。确定动作是**一条语句**：

  ```sql
  UPDATE project_event
     SET consumed_at = now(), disposition = 'DISCARDED_OUT_OF_LOOP'
   WHERE id = :eventId AND consumed_at IS NULL;
  ```

  **它不取租约、不写 `project_runtime`、不产生 `project_action` / `project_blocker` / `project_decision` / 通知**，因此它不是一次 reconcile，I6 的"静默"逐字保持。责任人是 §5.4 的消费者（`SYSTEM`）；它每一轮取批时对**每一个** `project_id` 分组先读一次 Project 当前行，在环的走 reconcile，出环的走本条。
- **EV4（幂等）**：本条的写是一条带 `consumed_at IS NULL` 条件的 `UPDATE`，重放影响 0 行；§5.4 的 partial unique index 保证同一 `(project_id, dedupe_key)` 未消费的行至多一条，因此"丢弃"与"同因新事件"不可能互相覆盖 —— 丢弃之后同一原因再发生会**新插一行**，它照样按 EV1 在被取到的那一刻重新判定。**丢弃不是一次静默忽略**：它落在审计可读的列上，控制面按 AC10 可以按 `disposition` 分组数出"这个项目出环期间收掉了多少条"。
- **EV5（为什么不在生产侧过滤，N1 逐字不变）**：审查给的另一条路是让 §5.3 N1 像 N2 一样只对 `coordinatorEnabled = true` 的项目产生事件。**它关不掉这个缺口**：项目可以在事件提交**之后**才出环（人关掉开关、项目验收成 `DONE`、在飞 Session 在 `SETTLED` 之后才结束），因此无论生产侧怎么过滤，"已提交 + 出环"这个状态都必然存在，I19 仍然需要第三支。它还要付一笔 I18-note 已经拒绝过的账：给**每一次**业务写加一次 `project` 读。因此 N1 一个字不改，闸门放在消费侧。
- **EV6（它与 W4 的分工）**：W4 的四支只扫**在环**的项目，本条只处理**出环**的行，两者的谓词互补且都不需要新表新索引（EV3 的 `UPDATE` 走 §12.1 步骤 6 已有的 `project_event (project_id, dedupe_key) WHERE consumed_at IS NULL` 与 `(next_attempt_at) WHERE consumed_at IS NULL` 两条索引）。**出环的行不进 W4，因此它不产生 WARN** —— 一个 `DONE` 了的项目收掉一条迟到的 `session.ended` 不是 bug，把它做成告警就是 `PC-CX-05` 那条"恒为真的告警"的第二次。

---

## 6. Reconcile：输入与输出

### 6.1 输入 —— Decision Input（冻结结构，v1.4 重写，PC-CX-22）

一次 reconcile 的输入是**一次读事务内**取到的一份内部一致的快照。跨行读必须在同一 `REPEATABLE READ` 事务里完成，否则"任务已 DONE 但 Session 还在飞"这类幻影组合会让状态机在两个状态间抖动。

v1.3 把这一份东西叫"快照"，并让 `snapshotHash` 覆盖它、同时**排除**时钟与事件，然后要求"同 hash ⇒ 同机械决策"（S3）。那三件事不可能同时成立，而且缺口是三类而不是一类：**(1) 漏字段** —— §7.3 / §8.2 / §11 / §13 要求 `dispatchAttempt`、`verdictRevision`、`acceptanceAttempt`、`lifecycleGeneration`、`conditionVersion`、`escalatedAt`、`mergeEvidence` 决定动作键、升级与验收，而快照里一个都没有；**(2) 排除了时钟** —— `runAt` 到期、退避到期、升级到期、预算窗口边界全都要读时钟；**(3) 排除了事件** —— MANUAL turn 只由 `user.manual_trigger` 触发。三组都能造出"hash 相同、要求的动作不同"的反例。审查记为 `PC-CX-22`。

v1.4 的答案是**把输入说全，并把它命名为 `decisionInput`**：三个部分，一个 hash 覆盖全部三部分。

- **`world`** —— 数据库里的持久事实。**它的字段集不是手写的**：由 §7 / §8 / §9 / §10 / §11 / §13 的读集反推（S8），加一个字段就必须有一条读它的规范条款，反过来也一样。
- **`evaluation`** —— 时钟的**唯一入口**。求值时刻被规范化成一个 epoch，所有与时间有关的判断在读快照时**一次性折成布尔/枚举的到期事实**（S5），此后没有任何一条规则再读 `now()`。
- **`signals`** —— 会改变机械决策的事件，**只进身份不进负载**（S7）。今天这个集合只有一个成员，它必须被枚举出来而不是被默认掉。

```jsonc
{
  "v": 1,
  "readAt": "2026-08-19T01:00:00.000Z",          // provenance：不进 hash，落 project_decision（S6）
  "decisionInputHash": "<sha256 of canonical(world ‖ evaluation ‖ signals)>",   // S3

  "world": {
    "project":  { "id", "status", "coordinatorEnabled", "automationPolicy",
                  "maxConcurrentTasks", "sessionBudgetPerDay", "configRevision",
                  "coordinatorSessionId", "coordinatorWorkspaceId", "goal?", "acceptanceCriteria?" },
    "runtime":  { "runState", "fencingToken", "coordinatorGeneration", "nextWakeAt",
                  "lastReconcileAt", "acceptanceAttempt" },
    "team":     [ { "projectMemberId", "agentId", "role", "canCreateTasks", "canDelegate", "enabled", "deletedAt",
                    "defaultProvider", "defaultModel", "defaultEffort", "providerFallbacks",
                    "requiredCapabilities" } ],                    // PAC §3.1 / PAC §3.2；§7.4 EC1（S10，v1.6）
    "workspaces": [ { "workspaceId", "isDefault", "position", "enabled", "runnerId",
                      "runnerStatus", "capabilities", "capabilitiesReportedAt", "deletedAt" } ],  // PAC §3.3 / PAC §3.5；§7.4 EC1（S10，v1.6）
    "tasks":    [ { "id", "status", "parentTaskId", "completionPolicy", "assigneeAgentId",
                    "provider", "model", "workspaceId", "requiredCapabilities", "dispatchAuthority",
                    "dispatchHold", "runAt", "verifiesTaskId", "verdict",
                    "dependsOnTaskIds", "failureCount", "lastFailureAt", "liveSessionIds",
                    "dispatchAttempt", "verdictRevision" } ],
    "sessions": [ { "id", "taskId", "runStatus", "dispatchOrigin", "projectActionId", "pendingApprovals", "startedAt" } ],
    "coordinatorSession": { "id", "runStatus", "endedAt?" } | null,                                  // §7.3 / §7.5 / §10.3 (b)
    "actions": {                                                                                     // §6.1 S9（v1.5，PC-CX-30）
      "unsettledAcceptance": { "actionId", "acceptanceAttempt" } | null,                             // §4.2 守卫 4
      "turns": [ { "reasonCode", "reasonDigest", "idempotencyKey", "openedAt", "turnState" } ]        // §7.6 TR1 / TR2 / TR3
    },
    "providers":[ { "slug", "available", "reason?", "models" } ],                                     // PAC §7.2 / PAC §7.4；§7.4 EC1 第 5 行（S10，v1.6）
    "blockers": [ { "id", "kind", "owner", "recovery", "dedupeKey", "subject",
                    "lifecycleGeneration", "conditionVersion", "escalatedAt", "nextCheckAt" } ],
    "mergeEvidence": [ { "requirementId", "targetBranch", "contentHash", "refGeneration" } ],  // §13.4 AE9
    "budget":   { "sessionsStartedLast24h", "inFlight", "overCapBy" }        // §9.6 CAP4（v1.5）
  },

  "evaluation": {                                 // 时钟的唯一入口（S5）
    "epoch": 1755561600,                          // floor(readAt / 1s)，规范化后的求值时刻
    "dueTasks":      { "<taskId>": { "runAtDue": true, "backoffExpired": false } },
    "dueBlockers":   { "<blockerId>": { "nextCheckDue": true, "escalationDue": false } },
    "turnWindows":   { "<reasonCode>": { "rateLimitExpired": false } },   // §7.6 TR2-a 的窗口边界折成的到期事实（v1.5）
    "budgetWindowRolled": false
  },

  "signals": [ { "kind": "user.manual_trigger", "dedupeKey": "…" } ]   // 身份，不含 payload（S7）；未消费的全部在这里（TR2-c）
}
```

**S1**：`world` **只含本 Project 的行**，且每一行都过 `ownerId` 租户边界（AC5）。跨租户泄漏是 P0。
**S2**：出站（API/CLI/Web 展示这份输入时）所有 id 编 base62。内部落库为 UUID。这与 PAC B3 是同一个坑：**JSON 里的 id 不是列，编解码器不会自动处理**，必须显式转换并有测试断言。
**S3（v1.4 重述）**：`decisionInputHash` 覆盖 **`world` + `evaluation` + `signals` 三部分的全部内容**的规范化序列化，只排除 `readAt`（S6）。**相同 hash 必须给出逐字相同的机械决策** —— 相同的 `actions`（含每个 `idempotencyKey`）、相同的 `blockersOpened`/`blockersCleared`、相同的 `nextWakeAt`。这是 11 单元"可重放审计"的判据，也是 v1.4 第一次让这句话为真：v1.3 的 hash 排除了时钟与事件，而两者都决定动作。
**S4**：`world` **不含** `session.resolution` / Agent 的提示词全文 / 任务描述全文。它是一个决策输入，不是一份导出。要看细节走既有接口。
**S5（时钟只在一处读，v1.4 冻结）**：`evaluation.epoch` 是**唯一**允许读时钟的地方。所有"到了没有"的判断在读输入时按这个 epoch **一次性求值**并冻结成 `evaluation` 里的布尔：`runAtDue`（§7.4 第 1 条）、`backoffExpired`（§9.5 Q3）、`nextCheckDue` 与 `escalationDue`（§11.5 ES4 / §10.4 第 2 条）、`budgetWindowRolled`（§9.4）。**§7–§13 的任何一条规则都不得再读 `now()`**。**v1.7 收紧（PC-CX-40）**：v1.4–v1.6 这里写的是"要写 `now()` 的地方只剩两处，都不参与决策：`nextWakeAt` 的落库值与展示字段"，而 `nextWakeAt` **是**决策的一部分 —— §6.2 把它列进 outcome，S3 逐字要求"相同的 `nextWakeAt`"。于是 §10.4 W5 照这句话读了第二个时钟，同一份声明输入产生了两个合法的 wake（`PC-CX-40`）。v1.7 把它移出豁免：**`nextWakeAt` 由 §10.4 W5 从 `evaluation.epoch` 算出**，W5 第 7 条列出仅有的两处例外，两处都不产生决策行。此后允许读 `now()` 的只剩**展示与投递字段**（`last_seen_at`、`occurrences`、`consumed_at`、事件退避的 `next_attempt_at` 落库值等），它们一条都不进 outcome。判据是一句可测的话：**把同一份 `world` 配上两个不同的 `epoch`，只要折出来的到期事实相同，`actions`（含每个 `idempotencyKey`）、`blockersOpened` / `blockersCleared` 与 `nextWakeReason` 就必须逐字相同；只要有一项到期事实不同，`decisionInputHash` 就必须不同。** `nextWakeAt` 本身**允许**随 `epoch` 平移（它是一个时刻，不是一个判断）；这与 S3 不冲突，因为 `epoch` 在 hash 里 —— 同一个 hash 就意味着同一个 epoch，因而也意味着同一个 `nextWakeAt`。
**S6（`readAt` 是出处不是输入）**：`readAt` 落在 `project_decision` 上供人对时间线，**不进 hash** —— 否则每一次 reconcile 的 hash 都不同，S3 就退化成一句永远为真也永远无用的话。它与 `evaluation.epoch` 的分工是：epoch 是**被决策读到的**时间，`readAt` 是**这次读发生在**什么时候。
**S7（事件按身份进入，负载仍然不读，v1.4 冻结）**：一个事件只有在**它本身会改变机械决策**时才进入 `signals`，并且只进 `(kind, dedupeKey)` 两项。触发集合是**封闭的**，v1 只有一个成员：

| `kind` | 它改变的决策 | 条款 |
|---|---|---|
| `user.manual_trigger` | 是否开一条 `reasonCode = MANUAL` 的 turn | §7.2 |

  其余全部 kind 是**纯脏标记**：它们决定"要不要重新看一眼"，不决定"看完之后做什么"，因此不进 `signals`、不进 hash。**这与 §5.1 E1 不冲突，两者的分界要写死**：E1 禁止的是"从事件负载里读业务状态"（`if (event.payload.status === …)`），S7 承认的是"这条事件的**存在**本身就是一件被请求的事"。前者是把事实的权威源换成了一条可能重复、可能乱序的消息；后者是把一个**用户动作**如实记下来。重复投递同一个 `dedupeKey` 仍然只得到 `signals` 里的**一项**（§5.4 的 partial unique index 已经把它收敛到一行），因此 I14 的"投递 N 次与 N = 1 逐字节相同"照常成立。
**S8（字段集由读集反推，不是手写，v1.4 冻结，v1.5 扩到全部读集，PC-CX-30）**：`world` 的字段集必须**能从规范条款机械导出** —— 每一条会影响 `run_state` / `actions` / `idempotencyKey` / `blockers` / `nextWakeAt` / 验收判定的规则，其读到的每一个持久化列都必须出现在 `world` 里；反过来，`world` 里的每一个字段都必须有至少一条规则读它。这与 §13.4 AE6-c 是同一条纪律：**"完整"必须是一条断言，不能是一个形容词**。

  v1.4 的采集面是**手选的三张表**：§7.3 的动作表、§8.2 GE1 的代次表与 §13.4 AE1 的摘要投影。那三张表里一条都没有 §4.2 的守卫与 §7.6 的 TR1–TR3，而这两处**恰好是读 `project_action` 的全部地方** —— 于是"完整读集"这条断言在它最该抓的地方是**假阴性**：两份数据库状态可以有逐字相同的 `world`/`evaluation`/`signals`，却因为一条没进输入的 `RUN_PROJECT_ACCEPTANCE` 动作而必须得到 `ACCEPTANCE` 与 `PLANNING` 两个不同的 `run_state`（`PC-CX-30`）。**采集面必须是规范里全部会读持久化行的判定，而不是恰好列成表格的那几处。** v1.5 把采集面冻结成**五处，封闭**：

  1. §7.3 动作表的**幂等键模板**（`<taskId>` / `<dispatchAttempt>` / `<generation>` / `<reasonDigest>` / `<lifecycleGeneration>` / `<verdictRevision>` / `<acceptanceAttempt>` …）；
  2. §8.2 GE1 的**代次落库位置**列；
  3. §13.4 AE1 的**四个摘要投影**；
  4. **§4.2 的七条守卫**（`project.status`、blocker 的 `owner`、未收敛的 `RUN_PROJECT_ACCEPTANCE` 动作、LIVE Session、未出 verdict 的验证任务）；
  5. **§7.6 TR1–TR3 与 §7.3 `OPEN_COORDINATOR_TURN` / `ROTATE_COORDINATOR_SESSION` 的前置**（同代 turn 的 `reasonCode` / `reasonDigest` / 开始时刻 / 是否已结束、Coordinator Session 是否还活着）；
  6. **§7.4 第 8 条的 PAC 解析链**（EC1 的八行 ⇒ PAC §5 / PAC §7.1 / PAC §7.2 / PAC §7.3 / PAC §7.4 实际读到的每一列）—— **v1.6 新增，PC-CX-33**，展开在 S10。

  契约测试从这**六**处收集列名，与本节逐条比对，并另行核对 §11.1 的五问都能从 `blockers` 投影里读到；漏一个就红。**再加一条双向断言**：把 `world` 里任意一个字段删掉，必须至少有一条规则因此不可判定 —— 这是"反过来"那一半的可执行形式。
**S9（动作历史进输入的是投影，不是账本，v1.5 冻结，PC-CX-30）**：`world.actions` 是 `project_action` 的**最小投影**，不是它的导出（S4 的同一条纪律）。它恰好三样东西，每一样都由上面第 4、5 条读集反推出来，多一样少一样都要改本条：

| 字段 | 唯一读它的规则 | 为什么不能省 |
|---|---|---|
| `unsettledAcceptance` | §4.2 守卫 4 | 省掉它，同一份声明输入可以合法地是 `ACCEPTANCE` 也可以是 `PLANNING` |
| `turns[].reasonDigest` + `turnState` | §7.6 TR1 / TR3 | 省掉它，"上一次 turn 还在飞"与"上一次 turn 结束了且事实没变"不可区分，前者要 `ALREADY_APPLIED`、后者要 `COORDINATOR_NO_PROGRESS` |
| `turns[].reasonCode` + `openedAt` | §7.6 TR2 / TR2-a | 省掉它，限频窗口没有锚点，`evaluation.turnWindows` 无从折算 |

  三样都取**当前 `coordinator_generation`** 的行（跨代的 turn 不影响任何判定，`generation` 已经在键里），且 `turns` 按 `(reasonCode, openedAt)` 排序后进 hash。`openedAt` 是**一个持久化列的值**，不是时钟：它进 `world`，而"这个窗口到了没有"由 `evaluation.turnWindows` 按 `epoch` 折成布尔（S5 逐字不变）。**`project_action` 的其余列一律不进** —— `status = APPLIED` 的派发动作行不影响任何机械判定（派发的去重由 §8.5 的 `ON CONFLICT` 在提交点做，不由决策时的读做），把整本账搬进输入只会让 hash 每次都不同，S3 退化成永真句。

**S10（PAC 解析链的读集也是 `world` 的一部分，v1.6 冻结，PC-CX-33）**：v1.5 用 S8 把采集面从"三张手选的表"扩到"五处读集"，但那五处全是**本文自己的**判定；**§7.4 第 8 条读的是 PAC 的解析链**，而它读的列一条都没有被反推进来。后果与 `PC-CX-30` 逐字同型，只是换了一片区域：两份数据库状态可以有逐字相同的 `world` / `evaluation` / `signals`（因此 `decisionInputHash` 相同），却因为一个没进输入的列而必须得到**不同的 provider / model / workspace / runner**，甚至**一个 DISPATCH 与一个 REFUSE**（`PC-CX-33`）。两个最小反例：

- **A（WITH 链）**：Task 没有 provider/model pin，两份状态只差 `agent.defaultProvider` = `claude` / `codex`。PAC §7.2 优先级 2 要求两个不同的 provider 与 model，因此 EC2 的 `executionContextDigest` 必然不同 —— 而 v1.5 的 `world.team[]` 里没有这两列。
- **B（WHERE 链）**：两份状态只差 `workspace.enabled`。PAC §7.3 的候选集谓词逐字含 `workspace.enabled = true`，因此一份 DISPATCH、一份 `REFUSE NO_PROJECT_WORKSPACE` —— 而 v1.5 的 `world.workspaces[]` 里没有这一列。

因此 `world` 必须携带解析链**实际读到的**每一列。下表是 EC1 的八行到 `world` 字段的**满射**，它与 EC1 一样是**封闭**的：PAC 的解析链多读一列，本表就多一行，`world` 就多一个字段；反过来，本表的每一个字段都必须能指出读它的那条 PAC 条款。

| EC1 # | PAC 条款 | 它读的列 | 落在 `world` 的哪里 |
|---:|---|---|---|
| 1 | PAC §7.1 优先级 1 · H1 | `agent.enabled` · `agent.deleted_at` | `team[].enabled` · `team[].deletedAt` |
| 2 | PAC §7.1 优先级 1 · PAC §3.2 | `project_member.id` · `project_member.agent_id` · `role` | `team[].projectMemberId` · `team[].agentId` · `team[].role` |
| 3 | PAC §5 第 1 步 · PAC §7.3 优先级 1 | `task.assignee_agent_id` · `task.workspace_id` · `task.required_capabilities` · `task.status` · `task.project_id` | `tasks[].assigneeAgentId` · `tasks[].workspaceId` · `tasks[].requiredCapabilities` · `tasks[].status` · `world` 只含本 Project 的行（S1） |
| 4 | PAC §7.2 优先级 1–3 · PAC §7.4 | `task.provider` · `agent.default_provider` · `agent.provider_fallbacks` · Provider 可用性 | `tasks[].provider` · `team[].defaultProvider` · `team[].providerFallbacks` · `providers[].available` |
| 5 | PAC §7.2 · PAC §7.4 · PAC §6 `model` 行 | `task.model` · `agent.default_model` · `agent.default_effort` · provider 的 model 空间 | `tasks[].model` · `team[].defaultModel` · `team[].defaultEffort` · `providers[].models` |
| 6 | PAC §7.3 候选集 · 优先级 1–3 | `workspace.deleted_at` · **`workspace.enabled`** · `workspace.runner_id` · `project_workspace.is_default` · `position` | `workspaces[].deletedAt` · `workspaces[].enabled` · `workspaces[].runnerId` · `workspaces[].isDefault` · `workspaces[].position` |
| 7 | PAC §7.3 可行集 · C4 · W-note | `runner.capabilities` · `runner.capabilities_reported_at` · 在线状态 · **`agent.required_capabilities`** | `workspaces[].capabilities` · `workspaces[].capabilitiesReportedAt` · `workspaces[].runnerStatus` · `team[].requiredCapabilities` |
| 8 | 本文 §7.5（落点固定） | `project.coordinator_workspace_id` | `project.coordinatorWorkspaceId` |

- **S10-a（`projectMemberId` 为什么必须在里面）**：它是 EC2 摘要的第二个分量。一个不进 `world` 的摘要分量意味着"同一份声明输入、两个合法的 `executionContextDigest`"，S3 因此对 §7.4 第 8 条不成立 —— 与漏 provider 是同一个缺口的第二种写法。
- **S10-b（`providers[].models` 是空间，不是一次解析）**：EC1 第 5 行的撤销样子是"pin 的 model 从 provider 的 model 空间里消失"。判定它需要的是**这个 provider 现在有哪些 model**，不是这次解析选中了哪一个（后者是 EC2 的输出，按 §23.5 不进 `world`）。它按 slug 排序后进 hash。
- **S10-c（可执行形式：删字段必须红）**：S8 的双向断言对本表**逐字段**执行 —— 把 `world` 里任意一个由本表引入的字段删掉，必须能造出一对 `decisionInputHash` 相同、而 PAC 解析链要求不同结果（不同 digest、或一个 DISPATCH 与一个 REFUSE）的状态。**删得掉而没有反例的字段就不该在这里**，这与 S9 "多一样少一样都要改本条"是同一条纪律。
- **S10-e（`defaultEffort` 为什么在表里，而 EC2 的摘要里没有它）**：PAC §7.2 P4 把 `effort` 与 provider/model 同链解析，PAC §6 把它冻结在 Session 上（首次 claim materialize，S1 那一句）。因此它**改变一次派发的结果**（同一份声明输入会得到两条不同的 Session），S3 要求它进 `world`。它**不进** EC2 的九个分量，因此也不进 EC1 的撤销判定 —— 改默认 effort 不是"这件事没法按原样做"，而是"下一次解析会算出另一个默认值"，与 PAC §6 S1 的 `model` 是同一条边界。**S10-c 的删除 mutation 因此按"PAC §7.5 冻结的那份 resolution 是否不同"判，而不是按 `executionContextDigest` 是否不同判** —— 前者是 S3 要的（同 hash ⇒ 同 outcome），后者是 D14 要的（提交时还成不成立），两个判据不是一回事，写清楚以免下一个人把 EC2 的九项当成 `world` 的上界。
- **S10-d（`session.resolution` 仍然不进）**：§23.5 那句"`execution_context` 的可读那一份不进 `decisionInput`"逐字不变。本条补的是它**读的那些行的当前值**，不是它的输出；两者的分界就是 S4。

### 6.2 输出 —— Reconcile Outcome（冻结结构）

```jsonc
{
  "v": 1,
  "reconcileId": "<uuid>",
  "fencingToken": 42,
  "decisionInputHash": "<sha256>",        // §6.1 S3：这次决策是对哪一份输入做的
  "configRevision": 7,                    // §9.6 AU2：决策时读到的授权版本，提交时复核
  "runStateBefore": "PLANNING",
  "runStateAfter":  "EXECUTING",
  "decidedBy": "ORCHESTRATOR",            // 或 "COORDINATOR_AGENT"
  "actions":  [ { "type": "DISPATCH_TASK", "idempotencyKey": "pc:v1:…", "subject": {…} } ],
  "blockersOpened":  [ "<blockerId>" ],
  "blockersCleared": [ "<blockerId>" ],
  "nextWakeAt": "2026-08-19T01:02:00.000Z",
  "nextWakeReason": "in-flight session may end",
  "turnReason": "REPLAN",                 // §7.2 TU4 选中的那一个；无 turn 时为 null
  "suppressedTurnReasons": [ "ACCEPTANCE" ],   // TU4 里同时为真但被全序压下去的（审计用，v1.4）
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
 5. 若需要语义判断（§7.2）→ 按 TU4 的全序选出**恰好一个** reasonCode，追加**至多一条** OPEN_COORDINATOR_TURN，
    其余同时为真的原因记进 suppressedTurnReasons；本次不再追加派发动作（R1）。
 6. 计算 blocker 的开/关（§11）。
 7. 计算 nextWakeAt（§10.4）。
 8. 一个事务，按 §8.6 LO1 的全序取锁：
    8a. 若本次 outcome 含任何被 §9.2 门控的动作或任何验收事实写入 → 先取 project 行锁（§9.6 AU1 / §13.4 AE6-a），
        锁到手后**重读**授权与并发（AU1 / CAP0-a / CAP1），并对每个 DISPATCH_TASK **重解析执行上下文**（§7.4 EC3，v1.5）；
        不再被允许的动作记 REFUSED(AUTHORITY_REVOKED) 或 REFUSED(EXECUTION_CONTEXT_REVOKED) 并跳过其副作用。
    8b. token 校验 + 动作账本 + blocker + 审计行 + 事件消费 + runtime 更新。
 9. 释放租约。
```

**R1**：第 5 步的"本次不再追加派发动作"是刻意的：一次 reconcile 要么按已知的图往前走，要么请协调器重新看图，**不同时做**。同时做会让协调器的判断建立在一份已经被自己这一 tick 改过的图上。

**R3（v1.4 新增，v1.5 扩到执行上下文，PC-CX-26 / PC-CX-29）**：第 8a 步的重读**不是**"再判断一次"，而是把第 4 步的策略门与执行上下文解析在**提交点**重放一遍。第 4 步读的是快照，第 8a 步读的是锁到手之后的一条新语句 —— `READ COMMITTED` 下它必然看得见任何已提交的人工写入。两次判定不一致时**以第 8a 步为准**，并且只影响被门控的那些动作：outcome 的其余部分照常提交（§8.5 C2 的同一形状）。

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

| 序 | `reasonCode` | 触发条件 | `turnFacts`（进入 `reasonDigest` 的输入投影，§7.3） |
|---:|---|---|---|
| 1 | `MANUAL` | 用户显式要求（`signals` 里有 `user.manual_trigger`，§6.1 S7） | **全部未消费** `user.manual_trigger` 信号的 `dedupeKey` 排序摘要（TF5，v1.5） |
| 2 | `VERDICT` | 出现 FAIL / INCONCLUSIVE 的验证 verdict，且 §13.2 的机械退回已完成 | `(verifierTaskId, verdictRevision, verdict)` 排序摘要（TF4） |
| 3 | `BLOCKER_DECISION` | 存在一条 open blocker，其 kind ∈ **`{WHO_UNRESOLVED, MERGE_CONFLICT, VERIFICATION_FAILED, DEPENDENCY_CYCLE}`**（§11.2 中 `opensTurn = ✔` 的全部行），**且该 blocker `escalated_at IS NULL`**（§11.2 BL6，v1.2 新增） | 触发的那些 blocker 的 `(kind, subjectId, lifecycleGeneration, conditionVersion)` 排序摘要（TF2 / TF4） |
| 4 | `ACCEPTANCE` | 全部 Task 收敛，准备进入 `ACCEPTANCE`（§13.4） | `(acceptanceDigest, acceptanceAttempt)`（TF4） |
| 5 | `REPLAN` | `runStateOf` = `PLANNING` 且没有任何可派发任务，且没有 open blocker（"图不够，需要重规划"） | 全部 Task 的 `(id, status, parentTaskId, dependsOnTaskIds, verifiesTaskId)` 排序摘要 |

**TU1（唯一规则）**：**是否开 turn 只由上表决定，不由 blocker 的 `owner` 决定。** `owner` 回答"谁能解决"，`opensTurn` 回答"控制环要不要为它叫醒协调器"，两者是两个问题。为防止它们各自漂移，§11.2 冻结一条可机械核对的双向约束 **BL4**：`opensTurn = ✔` ⟺ `owner = COORDINATOR`。上表第 3 行的四个 kind 因此**恰好**是 §11.2 中 `owner = COORDINATOR` 的全部行 —— 契约测试逐字比对这两处。

**TU4（唯一裁决：首个为真者胜，v1.4 冻结，PC-CX-23）**：v1.1–v1.3 把上表当成五条**各自独立**的触发条件，既没有互斥守卫也没有优先级，而它们**确实会同时为真**：

- 全部 Task 收敛、验证全 PASS、无 blocker、无 live Session、无未收敛的验收动作 ⇒ `runStateOf = PLANNING` 且无可派发任务且无 open blocker ⇒ **`REPLAN` 为真**；同一份事实又满足"全部 Task 收敛，准备进入 `ACCEPTANCE`" ⇒ **`ACCEPTANCE` 也为真**。
- 验证 FAIL 的机械退回完成 ⇒ **`VERDICT` 为真**；同一次退回按 §13.2 必然开一条 `VERIFICATION_FAILED` blocker，它在 `opensTurn = ✔` 的列表里 ⇒ **`BLOCKER_DECISION` 也为真**。

两个 reasonCode 的 `reasonDigest` 不同、TR2 的限频按 reasonCode 分桶、TR1 的幂等键也不同 —— 于是同一份输入可以合法地开出**两条** turn，或者取决于实现遍历顺序开出**其中一条**。审查记为 `PC-CX-23`。

v1.4 用与 §4.2 RS0 **完全相同**的手法解决：不补互斥守卫（手写的互斥在下一个组合上必然漏），而是给上表一个**总序**，**按序求值、首个为真者胜**。上表的"序"列即是该全序：

> `MANUAL ≻ VERDICT ≻ BLOCKER_DECISION ≻ ACCEPTANCE ≻ REPLAN`

**为什么是这个顺序**，每一格都能从已冻结的条款读出来，不是新发明：

- **人优先于机器**（1 最高）：`user.manual_trigger` 是一个人的显式请求；§9.3 与项目 instructions 都把最终控制权留给人，而一个被别的原因顶掉的显式请求就是一次静默忽略。
- **原因优先于后果**（2 ≻ 3）：`VERIFICATION_FAILED` blocker **是** verdict 的产物（§13.2 的 FAIL 第 ④ 条）。选后果就丢掉了 `(verifierTaskId, verdict)` 这组事实，而协调器需要的正是它。
- **阻塞优先于验收**（3 ≻ 4）：§4.2 守卫 3 ≻ 4 已经冻结了"阻塞优先于验收"，turn 的顺序不得与状态的顺序相反。
- **验收优先于重规划**（4 ≻ 5）：§4.2 守卫 4 ≻ 7（`ACCEPTANCE ≻ PLANNING`）的同一句话。"全部 Task 收敛"意味着图已经走完，此时叫协调器"重规划"正是 foreman 事故的形状。
- **`REPLAN` 是兜底而不是一个条件**：与 `PLANNING` 之于状态一样，它的含义就是"其余四条都不成立"。

**TU5（一次 reconcile 至多一条语义 turn，v1.4 冻结）**：§6.3 第 5 步产生的 `OPEN_COORDINATOR_TURN` **至多一条**（I15）。同时为真的其余原因写进 `project_decision.suppressedTurnReasons`（§6.2）—— 它们不是被丢掉了，是被记下来了：如果被压下去的那个原因下一次仍然为真，它自然会在下一次 reconcile 胜出。可测形式：枚举五个谓词的全部 32 个组合，每一组断言 `|actions ∩ {OPEN_COORDINATOR_TURN}| ≤ 1` 且选中的 reasonCode 唯一、与遍历顺序无关。

**TU2（任务失败永不开 turn）**：`TEST_FAILED` 在 v1.1 中 `owner = USER`、`opensTurn = ✘`，且**只在 `failureCount ≥ MAX_AUTO_RUN_FAILURES` 时才被创建**（§9.5 Q3 的表）。退避期内根本没有 blocker，只有一条写明理由的 `NOOP` 审计行和一个指向退避到期时刻的 `nextWakeAt`。于是 v1 的两条规则在 v1.1 里指向同一个动作：**不开 turn**。失败有既有的退避与重试（§9.5），协调器不是重试机制。这是对既有 foreman 事故的直接吸取：一个"停滞就派一个协调者"的规则在停滞无法被协调者解决时会永远重派。

**TU3（同一原因不重复开 turn，PC-CX-07）**：见 §7.6 与 §7.3 的 `OPEN_COORDINATOR_TURN` 前置条件与 §10.4 的限频。要害是**限频与幂等是两个概念**：限频看粗粒度的 `reasonCode`，幂等看细粒度的 `reasonDigest`。

**TF1（`turnFacts` 的排除集，v1.2 冻结，PC-CX-10）**：`turnFacts` 只能由快照里的**当前事实**构成。下列各项**一律不得**出现在 `turnFacts`（因而不得出现在 `reasonDigest` 里）：

1. **投递与观测计数**：blocker 的 `occurrences`、事件的 `occurrences`、`project_event.attempts`、本次消费的事件条数；
2. **墙钟**：`first_seen_at` / `last_seen_at` / `escalated_at` / `snapshotAt` / 任何 `now()`；
3. 任何**自增序号**（除 id 本身）。

判据是一句可测的话：**把同一份世界状态重复投递 N 次、乱序投递、或重启后重投，`turnFacts` 必须逐字节相同。**

**TF1 的分界（v1.4 澄清，PC-CX-24）**：第 3 项"任何自增序号"**只针对随观测前进的计数**。一个**只在世界真的开始了一个新周期时才前进**的持久化代次（`lifecycle_generation` / `verdict_revision` / `acceptance_attempt`）不但允许、而且被 TF4 **要求**进入 `turnFacts`。两者的判据就是 §8.2 GE2 的那一句：**把世界从 A 变到 B 再变回 A** —— 观测计数在没有 B 的情况下也会前进（因此它破坏"事实没变则键没变"），周期代次不会（因此它只在"确实是新的一次"时改变键）。写死这条分界是必要的：v1.2 把 `occurrences` 赶出去时用的理由是"它是一个会自己前进的数"，那句话如果不加限定，就会把**必须**进来的代次也一并挡在外面 —— 而这正是 `PC-CX-24` 发生的方式。

**TF4（周期身份必须进入 `turnFacts`，v1.4 冻结，PC-CX-24）**：`turnFacts` 里每一项若取自一行**有生命周期的**行，就**必须**带上那一行的代次：

| `reasonCode` | 代次项 | 落库位置 |
|---|---|---|
| `BLOCKER_DECISION` | `lifecycle_generation` | `project_blocker`（§11.3 BE1） |
| `VERDICT` | `verdict_revision` | `task`（§13.2 V7） |
| `ACCEPTANCE` | `acceptance_attempt` | `project_runtime`（§13.4 AE11） |

  **最小反例（本条要挡住的东西）**：`MERGE_CONFLICT` episode 1 的 `condition_version = A`，协调器开 turn、解决冲突、blocker clear。一小时后同一文件集再次冲突，episode 2 的 `condition_version` 仍然是 `A` —— 因为 TF2 定义它是"产生这条 blocker 的那些快照事实"的摘要，而那些事实**真的**一模一样。于是 `reasonDigest` 与 episode 1 逐字节相同，而 episode 1 的那一次 turn 早已结束 ⇒ §7.6 TR3 判定"上一次 turn 没有改变它自己被叫醒的那些事实" ⇒ **不开 turn，直接开 `COORDINATOR_NO_PROGRESS` 交给人**。协调器连一次处理这个**新故障**的机会都没有。审查记为 `PC-CX-24`。

  **要害是一句话**：TR3 从"当前条件和上次相同"推出了"中间从未恢复过"，而这个推理只有在**没有中间状态**时才成立。`lifecycle_generation` 就是那个中间状态的证据 —— 它在 blocker 被解除后复发时必然前进（§11.3 BE1），因此 episode 2 得到一个新的 `reasonDigest`、一条新的 turn 键，而**同一个 open episode 内的重复**（代次不变、条件不变）仍然撞同一个键，TR1 的去重与 TR3 的 no-progress 判定逐字不变。

v1.1 把 blocker 的 `occurrences` 放进了 `BLOCKER_DECISION` 的 `turnFacts`，于是同一个合并冲突每被观测一次就换一个 `reasonDigest`：TR1 把它当"事实变了"，TR3 的 no-progress 判定永远命中不了，每 60 秒（TR2 的限频窗）就能合法地再开一个 turn —— 这正是 E1"事件是信号不是事实"要禁止的东西，从后门回来了。审查记为 `PC-CX-10`。

**TF2（`conditionVersion`，v1.2 冻结）**：blocker 进入 `turnFacts` 的那一项是 `project_blocker.condition_version` —— **产生这条 blocker 的那些快照事实**的规范化摘要，而不是它被看见过几次：

- `MERGE_CONFLICT`：`(targetBranch, sorted(冲突路径集合), 冲突侧内容摘要)`；
- `VERIFICATION_FAILED`：`(verifierTaskId, verifiesTaskId, verdict)`；
- `WHO_UNRESOLVED`：`(taskId, 解析链停在哪一步, 缺失的那个输入)`；
- `DEPENDENCY_CYCLE`：`sorted(环上的 taskId 集合)`。

v1.1 这一格里的第三项是 `occurrences`，v1.2 换成 `conditionVersion`；本表的 `turnFacts` 列此后**逐字**受 TF1 的排除集约束，契约测试直接扫这一列。

`condition_version` 在开 blocker 时计算；§11.3 的同因重复命中已存在的 open 行时，`occurrences += 1` 且 **`condition_version` 按当前事实重算并覆盖**。于是"同一个 subject 上条件真的变了"（冲突文件集变了、verdict 变了）与"同一条件被再看见一次"第一次可以被机械区分：前者换 digest 并合法获得新 turn，后者不换。`occurrences` 在 v1.2 里还保留着最后一项职责 —— 升级阈值（§11.5）。**v1.3 把这一项也拿掉了**（§11.5 ES4 / BL7）：一个只由投递次数决定的量，放在幂等键里会换掉动作身份，放在升级条件里就会换掉责任人、`run_state` 与通知，两者是同一个错误的两种写法（`PC-CX-15`）。它此后**只用于展示与诊断**，不进任何幂等键、不进任何判定。

**TF5（`MANUAL` 的 `turnFacts` 是全部 pending 请求，不是触发那一条，v1.5 冻结，PC-CX-31）**：v1.1–v1.4 这一格写的是"触发信号的 `dedupeKey`"（单数）。配上 TR2 的 60 秒限频，它有一个直接后果：窗口里到达的第二个请求有**不同的** `dedupeKey`，因此有**不同的** `reasonDigest`；窗口一过它就是一次**新的** turn，两个人在一分钟内各点一次"现在跑一下"会得到两次相隔 60 秒的协调运行，而它们看到的是同一份图。窗口里到达 N 个请求就排 N 次 —— 一条被限频保护着的路径，反而成了一个可以被人手排出来的队列。

v1.5 把这一格改成**全部未消费 `user.manual_trigger` 信号的 `dedupeKey` 排序摘要**：一次 turn **回答掉当时所有 pending 的请求**，并在同一事务里把它们**一起消费**（TR2-c）。三个后果都是要的：`reasonDigest` 由一组确定的事实算出（TR1 逐字不变）；N 个 pending 请求塌成**一次** turn（不再有排队式的 turn 风暴）；每一个请求都被**回答过**，因此 I18 不需要为"部分回答"再造一个中间态。**这与 TF1 不冲突** —— 摘要里进的是请求的**身份集合**，不是它被投递过几次：同一个 `dedupeKey` 投十次，§5.4 的 partial unique index 已经把它收敛成一行，集合不变，digest 不变（I14 逐字不变）。

**除此之外不开 turn。**

### 7.3 动作表（冻结）

**机械动作**

| type | 作用 | 幂等键（§8.2） | 前置条件 |
|---|---|---|---|
| `DISPATCH_TASK` | 把一个已授权的 Task 变成一次 Session | `pc:v1:<projectId>:dispatch:<taskId>:<dispatchAttempt>` | §7.4 全部满足；代次见 §8.2 DA1 |
| `OPEN_COORDINATOR_TURN` | 唤醒 Coordinator Agent | `pc:v1:<projectId>:turn:<generation>:<reasonDigest>` | 存在活的 Coordinator Session；§7.6 的 TR1–TR3 全部满足 |
| `ROTATE_COORDINATOR_SESSION` | 开一条新的 Coordinator Session | `pc:v1:<projectId>:coord-session:<generation+1>` | 旧 Session 已终结或被删除；落点必须是 `project.coordinatorWorkspaceId`（§7.5） |
| `RAISE_BLOCKER` | 开一条结构化阻塞 | `pc:v1:<projectId>:blocker:<kind>:<subjectId>:<lifecycleGeneration>` | §11.2 的 kind 之一；代次由 §11.3 BE1 分配（v1.3，PC-CX-16） |
| `CLEAR_BLOCKER` | 解除阻塞 | `pc:v1:<projectId>:unblock:<blockerId>` | 条件已消失（§11.4） |
| `AGGREGATE_PARENT` | 按 `completionPolicy` 重算父任务状态 | 无（**current-state CAS**，不入账本，§13.1 AG5，v1.3） | §13.1 |
| `APPLY_VERIFICATION_VERDICT` | 退回被验证任务 / 建缺陷子任务 / 阻断下游 | `pc:v1:<projectId>:verdict:<verifierTaskId>:<verdictRevision>` | §13.2；代次见 V7（v1.3，PC-CX-17） |
| `REQUEST_APPROVAL` | 把一个动作挂起等人批 | `pc:v1:<projectId>:approval:<targetIdempotencyKey>` | 策略判定为"需审批"（§9.2） |
| `RUN_PROJECT_ACCEPTANCE` | 发起项目级验收 | `pc:v1:<projectId>:acceptance:<acceptanceAttempt>` | §13.4；代次见 AE11（v1.3，PC-CX-17） |
| `SCHEDULE_WAKE` | 安排下次检查 | 无（写在 `project_runtime`，不入账本） | 恒执行 |
| `NOOP` | 什么都不做，但**必须**留审计行与 `nextWakeAt` | 无 | —— |

**语义动作**（Coordinator Agent 在 turn 内通过既有接口做，**不入 `project_action`，走既有鉴权**）：建任务/任务树、改任务描述与验收标准、排依赖、指派 Agent、提议标记 Project DONE。

**A2**：`NOOP` **不是**"没事发生"。它是一条"我看过了，结论是不动"的审计行。没有 `NOOP` 就没法把"控制环判断不动"和"控制环根本没跑"区分开 —— 而这两者正是本项目要区分的东西。

### 7.4 `DISPATCH_TASK` 的前置条件（全部满足才可派发）

按顺序判定，**任一失败即不派发**，并按 §11 决定是否开 blocker：

1. `task.status = OPEN` 且 `dispatchHold = false` 且（`runAt IS NULL` 或 `evaluation.dueTasks[id].runAtDue`，§6.1 S5）。
2. `task.dispatchAuthority = 'COORDINATOR'`（§12.3）。
3. 全部前置依赖 DONE；若 `verifiesTaskId` 非空，被验证任务已 DONE 且未被退回（§13.2）。
4. 该 Task 没有在飞 Session（`liveSessionIds` 为空）。
5. 失败退避未生效（`evaluation.dueTasks[id].backoffExpired`；阈值复用既有 `AUTO_RUN_RETRY_BACKOFF_MS` / `MAX_AUTO_RUN_FAILURES`，§9.5）。
6. 并发未超 `project.maxConcurrentTasks`；24h Session 预算未超 `sessionBudgetPerDay`。**这一条在快照上判一次、在提交点再判一次**（§9.6 CAP1）—— 快照上的判定只是为了不白跑，唯一有效的那次在 project 行锁之后。
7. 策略允许（§9.2）；若判定"需审批"，改为 `REQUEST_APPROVAL`。**同样在提交点复核**（§9.6 AU1）：用户可以在第 7 条与提交之间把 Coordinator 关掉。
8. PAC §5 的 `resolveExecutionContext(task)` 成功解析出 (agent, provider/model, workspace/runner)。**失败即 REFUSE**，按 PAC §12 的错误码映射成 blocker（§11.2），**绝不改派、绝不换引擎**。解析结果按 **EC1** 冻结成一份带摘要的读集，并**在提交点按 EC3 重解析一遍**（§9.6 AU1 的同一把锁之后）—— 与第 6、7 条同理，快照上的这一次只是为了不白跑。

**A3**：第 8 步**完全复用** PAC 的解析链，控制环不得有第二套解析。控制环唯一被允许做的是"决定这一件事要不要现在派"，"派成什么样"永远是 PAC §7 的三条链。

**A6（第 8 条和第 6、7 条是同一种东西，v1.5 新增，PC-CX-29）**：v1.4 把第 6、7 条送进了提交点复核（AU1），却**把第 8 条留在快照上**。三条读的都是"人随时可以改的东西"，差别只在改的是哪一行：第 6、7 条读 `project` 的四个策略字段，第 8 条读 Agent、团队成员、Task 的指派/引擎、Provider、Workspace、Runner 和协调 Workspace。**一个已被禁用的 Agent 与一个已被关掉的 `coordinatorEnabled`，对 I7 是同一件事** —— 两者都表示"这件事现在不再被授权"，而 v1.4 的门只挡住了后者：快照里 Agent 还 enabled，人随后提交 `enabled = false`，控制环取到 project 锁、四个策略字段照样允许，于是**一条解析到已禁用 Agent 的 Session 被合法提交**（`PC-CX-29`，P0）。第 8 条因此必须和第 6、7 条走同一条路：冻结读集（EC1）、在同一把锁之后重解析（EC3）、给出确定的拒绝码与恢复（EC4 / EC5），并由数据库在 `COMMIT` 再证明一次（§7.7 D14）。

**EC1（PAC 执行上下文的冻结读集，封闭，v1.5 冻结）**：第 8 条的一次成功解析产生一个 `executionContext`，它**恰好**由下面八个输入决定 —— 这张表就是"什么算执行上下文"的唯一定义，也是 EC3 要重读的全部行：

| # | 输入 | 权威行 | 它被撤销的样子 | `revokedInput` |
|---:|---|---|---|---|
| 1 | 执行 Agent | `agent`（PAC §2） | `enabled = false`、软删（`deleted_at` 非空） | `AGENT` |
| 2 | 该 Agent 在本 Project 的成员资格 | `project_member`（PAC §3.2） | 成员行被删、`role` 改写到不再允许执行 | `MEMBERSHIP` |
| 3 | Task 的指派与可派发性 | `task` | `assignee_agent_id` / `dispatch_hold` / `status` / `project_id` 被改写 | `TASK` |
| 4 | Provider | `provider`（PAC §7.4） | 被撤回、`available = false`、Agent 上的凭据被删 | `PROVIDER` |
| 5 | Model | `task.model` / Agent 默认（PAC §7.4） | pin 的 model 被改写或从 provider 的 model 空间里消失 | `MODEL` |
| 6 | Workspace | `project_workspace` / `workspace`（PAC §3.3） | 软删、`enabled = false`、被移出本 Project、`position` 改写导致解析落到另一个 | `WORKSPACE` |
| 7 | Runner | `runner`（PAC §3.5 / §7.3） | 离线、能力不再满足 `required_capabilities` | `RUNNER` |
| 8 | 协调 Workspace | `project.coordinator_workspace_id` | 被重绑到另一个 workspace，或该 workspace 不可用 | `COORDINATOR_WORKSPACE` |

  第 8 项只对 `ROTATE_COORDINATOR_SESSION` 与 `OPEN_COORDINATOR_TURN` 生效（§7.5 的落点固定），其余七项对 `DISPATCH_TASK` 生效。**这张表是封闭的**：一个会改变 PAC 解析结果的输入不在表里就是缺陷，契约测试从 PAC §5 / §7.3 / §7.4 的解析链反推本表。**这八行读到的每一列同时必须进 `decisionInput.world`**（§6.1 S10，v1.6）：EC1 回答"提交时还成不成立"，S10 回答"决策时它进没进那个 hash"，**两者读的是同一片列**，只有一处写下来就会让另一处静默漂移 —— 那正是 `PC-CX-33`。

**EC2（两个摘要：授权摘要与结果摘要，v1.5 冻结一个，v1.7 拆成两个，PC-CX-29 / PC-CX-42）**：一次解析产出的东西要回答**两个不同的问题**，v1.5 只给了一个摘要，于是第二个问题在提交点没有被问过：

- **EC2-a（`executionContextDigest`，授权摘要，v1.9 给它一个数据库可执行的规范形式，PC-CX-48）**：`executionContextDigest = sha256(canonical(executionContext.authorization))`，其中 `authorization` 是 `execution_context` 上一个**恰好九个键**的对象 —— `resolvedAgentId` / `projectMemberId` / `taskId` / `taskAssigneeAgentId` / `providerSlug` / `model` / `workspaceId` / `runnerId` / `coordinatorWorkspaceId`，值可以是 JSON null（第 8 项只对 §7.5 的两个动作有意义），但**九个键一个都不能少、一个都不能多**。v1.5–v1.8 写的是把这九个值用 `‖` 连起来，那个记法没有说清分隔、转义与空值，**因此它在数据库里根本不可重算** —— 一个摘要如果只有写它的那个二进制算得出来，它就不是一条可被证明的等式，而是一个标签（`PC-CX-48`）。`canonical` 从 v1.9 起是 §7.7 D17 定义的那一个**数据库函数**（键按 C 序、数组保序、标量取 jsonb 的唯一文本形式），EC2-a 与 EC2-b 共用它。它摘的是**解析出来的那一组身份**，不是那八行的全部列。理由与 §8.2 GE3 同型：摘要回答"这件事现在还能不能按原样做"，它不承担身份。它是 §7.7 D14 在 `COMMIT` 时用 SQL 重算的那一个，因此它的分量必须**全部可以在数据库里如实算出来**（D14-c）。
- **EC2-b（`executionResultDigest`，结果摘要，v1.7 新增，PC-CX-42）**：`executionResultDigest = sha256(canonical(executionContext - 'authorization'))`（v1.9 按 EC2-d 划清两半，`canonical` 与 EC2-a 是同一个数据库函数，`PC-CX-48`），其中被摘的那一半是**这次派发会写进 Session 的那一整份结果**，恰好三部分，封闭：① PAC §6 表里冻结时刻为 **Session create** 的每一列（`agentId` / `workspaceId` / `assignedRunnerId` / `provider` / `providerBuiltin` / `requiredCapabilities` / `permissionMode`）；② PAC §6 表里冻结时刻为**首次 claim** 的每一列的**解析结论**（`model` / `effort`，取值是一个具体值或显式的 `DEFERRED_TO_CLAIM`，见 EC6-c）；③ PAC §7.5 的整份 `resolution`（`who` / `with` / `where` 三个 key，含 `source`、`pinned`、`fallbackHops`、`required`、`candidatesConsidered`）。**这张清单由 PAC §6 的表与 PAC §7.5 的结构反推，不是手写的**：PAC 多冻一列，本条就多一个分量，判据与 §6.1 S10-c 逐字同型（删掉任一分量，必须能造出一对 EC2-b 相同而 Session 结果不同的状态）。
- **EC2-c（为什么必须是两个而不是一个，v1.7 冻结，PC-CX-42）**：EC2-a 的九个分量**不包含** `effort` 与 `requiredCapabilities`，而 PAC §6 把这两样冻进 Session（前者首次 claim、后者 create），§6.1 S10-e 也明确承认 `defaultEffort` **会改变一次派发的结果**。于是决策与提交之间只改这两样时：九个身份不变 ⇒ EC2-a 相同 ⇒ EC3 与 D14 都放行 ⇒ **提交出来的 Session 与被冻结的那次决策不是同一次派发**（`PC-CX-42`）。两条路都被考虑过：

  | 选项 | 结果 | 为什么不选 / 为什么选 |
  |---|---|---|
  | A：把 `effort` / `requiredCapabilities` 等塞进 EC2-a 的分量表 | 一个摘要覆盖两个问题 | **不选。** 它会让"改了默认 effort"变成一次 `EXECUTION_CONTEXT_REVOKED` —— 而那**不是**一次撤权（没有任何输入被撤回，EC5 也找不到一个有意义的 `revokedInput` 与责任人），S10-e 已经把这条边界写死了。它还会把 D14 的 SQL 复制品从"八行的授权解析"推成"整条 PAC 解析链加 `resolution` 的规范序列化"，D14-c 那笔账会翻倍 |
  | B：两个摘要，各回答一个问题，在提交点**各比各的** | `EXECUTION_CONTEXT_REVOKED`（撤权，有责任人、有 blocker）与 `EXECUTION_RESULT_CHANGED`（同样授权、但结果会不同，无责任人、重新决定）是两个码 | **选它。** 它与 §6.1 S10-e 已经写下的那条分界**是同一条**："前者是 S3 要的（同 hash ⇒ 同 outcome），后者是 D14 要的（提交时还成不成立）"。v1.7 只是把那句话从一条注释变成两个落库的列 |

- **EC2-d（两个摘要的权威输入都在这一行上，v1.9 新增，PC-CX-48）**：`execution_context` 恰好由**两半**组成，互不相交、合起来就是它自己：`authorization`（EC2-a 的九个分量）与**其余全部键**（EC2-b 的三部分）。因此每一个键都被**恰好一个**摘要覆盖，没有哪个键能同时逃出两个摘要 —— 这一条不需要一张手写的顶层键清单，它由"减去一个键"这个运算本身保证。两半共享的分量必须一致（`authorization.resolvedAgentId = agentId`、`workspaceId = workspaceId`、`runnerId = assignedRunnerId`、`providerSlug = provider`、`model = model`，且 `subject_type = 'TASK'` 时 `authorization.taskId = subject_id`），否则两个摘要各自成立、合起来却在描述**两次不同的派发**。剩下三个分量（`projectMemberId` / `taskAssigneeAgentId` / `coordinatorWorkspaceId`）在结果那一半没有对应列，它们只由 §7.7 D14 的重解析约束 —— 这是刻意的：它们回答"谁授权了这件事"，不回答"这件事做出来是什么"。**为什么这一条必须存在**：v1.8 的两个摘要都只是被冻结的字符串，D11 忠实地把它们钉住，而"钉住一个错的值"与"证明它是对的"是两件事（§26.5 自己承认了这一点）。数据库侧由 §7.7 D17 在 `COMMIT` 各重算一次。

  两份摘要与 `executionContext`（可读的那份）一起落在 `DISPATCH_TASK` 的 `project_action` 行上（§2.4：`execution_context` / `execution_context_digest` / `execution_result_digest`），因此**决策时冻结的那一份与提交时比对的那一份是同一份**，不是一次重新推导；`APPLIED` 之后三列都由 §7.7 D11 钉成不可改写（D11-c）。

**EC3（提交点重解析，冻结）**：§6.3 第 8a 步取到 `project` 行锁之后、插入占位之前，**在同一事务里**按 §8.6 LO1 的锁序重读 EC1 那八行并**重新跑一遍 `resolveExecutionContext(task)`**：

```sql
-- LO1 第一级已在 AU1 取过；以下按"先 project 侧、后 task 侧、再执行侧"的固定顺序，全部 FOR SHARE。
SELECT … FROM project_member WHERE project_id = :p AND agent_id = :a          FOR SHARE;
SELECT … FROM agent          WHERE id = :a                                     FOR SHARE;
SELECT … FROM task           WHERE id = :t                                     FOR SHARE;
SELECT … FROM project_workspace pw JOIN workspace w ON w.id = pw.workspace_id
  WHERE pw.project_id = :p ORDER BY w.id                                       FOR SHARE OF w, pw;
SELECT … FROM runner         WHERE id = ANY(:candidate_runner_ids) ORDER BY id FOR SHARE;
```

  - **为什么是 `FOR SHARE` 而不是一次普通读**：人改这些行走的是 `UPDATE …`，Postgres 对它自动取 `FOR NO KEY UPDATE`，而 `FOR SHARE` 与 `FOR NO KEY UPDATE` **冲突**。普通读在 MVCC 下看不见未提交的写 —— 这个坑本项目已经付过两次钱（§7.7 D8-note 的 `PC-CX-09`、§9.6 AU2 的"revision 不是并发控制"）。`FOR KEY SHARE` **不够**：它不与 `FOR NO KEY UPDATE` 冲突，因此挡不住"把 `enabled` 改成 false"这种非键列更新。
  - **为什么不会死锁**：这五句全部落在 §8.6 LO1 那条链上（`project_member` / `agent` 在 `project_runtime` 与 `task` 之间，`project_workspace` / `workspace` / `runner` 在 `task` 与 `session` 之间），按各表内 id 升序取，且**只取共享锁、绝不升级**（LO3）。人工侧的每一次撤权都只写**一行**，构不成环。
  - **判据（v1.7 比两个摘要，PC-CX-42）**：重解析结果的 **`executionContextDigest` 与 `executionResultDigest` 都必须**与动作行上冻结的那两份**逐字相同**。两处不同各有一个确定的结果，且**先判授权、后判结果**（授权不成立时结果无意义）：

    | 情形 | `refusal_code` | 后果 |
    |---|---|---|
    | `executionContextDigest` 不同（含解析成功但落到了另一台 Runner） | `EXECUTION_CONTEXT_REVOKED` | 该动作 `status = REFUSED`，`detail.revokedInput` 按 EC4，**跳过它的副作用**，后果按 EC5 逐值确定 |
    | 授权摘要相同、`executionResultDigest` 不同 | `EXECUTION_RESULT_CHANGED`（v1.7 新增） | 该动作 `status = REFUSED`，`detail.frozenResultDigest` / `observedResultDigest` / `changedComponents[]` 各记一份；**不开 blocker**（没有任何输入被撤回，也没有任何人需要做任何事），记一条写明 `execution_result_changed` 理由的 `NOOP`，`task.dispatch_attempt` 照常 +1（EC5 末段），下一次 reconcile 读到新事实重新决定 —— 与 EC5 里 `TASK` 那一行是**同一种形状** |

    outcome 其余部分照常提交（§8.5 C6 的同一形状）。**绝不改派** —— 换一台机器重跑是 §9.3 第 3 条禁止的事，用新解析出来的 effort / 能力集合"顺手"派出去同样是它（那会让一次已被冻结的决策在提交点变成另一次决策），重新决定是**下一次 reconcile** 的事。

**EC4（拒绝码，封闭，冻结，v1.7 加一个码，PC-CX-42）**：`refusal_code = 'EXECUTION_CONTEXT_REVOKED'`，`detail.revokedInput` 取 EC1 表最后一列的**八个值之一**，`detail.frozenDigest` / `detail.observedDigest` 各记一份。多个输入同时变化时，`revokedInput` 取 EC1 表里**序号最小**的那一个（与 §4.2 RS0、§7.2 TU4 同一条纪律：同时为真的原因由一个全序裁决，不由遍历顺序裁决）。**它与 `AUTHORITY_REVOKED` 是两个码**：后者说"这个项目现在不许自动做这件事"，前者说"这件事现在没法按原样做"，责任人与恢复路径都不同。**v1.7 起还有第三个码 `EXECUTION_RESULT_CHANGED`**：它说的是"这件事现在**做得成**，但做出来的东西**和被冻结的那次决策不一样**" —— 八个 `revokedInput` 一个都不适用（没有输入被撤回），因此它**不带** `revokedInput`，改带 `changedComponents[]`（EC2-b 三部分里发生变化的那些分量名，按名称字母序，同样是一个全序而不是遍历顺序）。三个码互斥且穷尽了"提交点复核不通过"的全部情形。

**EC5（恢复，逐值确定）**：每个 `revokedInput` 映射到**恰好一个**后果，全部落在 §11.2 已有的 kind 上，**不新增 blocker kind**：

| `revokedInput` | 后果 | 责任人 / 恢复 |
|---|---|---|
| `AGENT` · `MEMBERSHIP` | `WHO_DISABLED` / `WHO_NOT_IN_TEAM` blocker（按 PAC §12 的码原样映射） | USER / HUMAN：启用 Agent、或改任务指派 |
| `TASK` | **不开 blocker**：一条写明 `execution_context_changed` 理由的 `NOOP` 审计行。Task 的那次写入本身产生 `task.updated` 事件（§5.3 N1），下一次 reconcile 读到新事实重新决定 | SYSTEM / EVENT |
| `PROVIDER` | `PROVIDER_UNAVAILABLE` blocker。**绝不静默换 Provider**（§9.3 第 2 条） | SYSTEM / EVENT |
| `MODEL` | `RUNTIME_REQUIREMENT_UNMET` blocker | USER / HUMAN |
| `WORKSPACE` | `NO_PROJECT_WORKSPACE` blocker | USER / HUMAN |
| `RUNNER` | `NO_MATCHING_RUNNER` blocker | SYSTEM / EVENT |
| `COORDINATOR_WORKSPACE` | `COORDINATOR_UNAVAILABLE` blocker（§7.5 已冻结"不换地方"） | USER / HUMAN |

  **被拒之后 `dispatch_attempt` 照常前进**（§8.2 DA2 在本条上的推论）：`REFUSED` 的动作行**照常占用它的键**（那次决策确实发生过，§8.5 C6），因此 `task.dispatch_attempt` 必须在写入 `REFUSED` 行的**同一事务**里 `+1`，否则撤权解除之后的重派会算出同一个键、撞 `ALREADY_APPLIED` 并被永久跳过 —— 那正是 `PC-CX-11` 的形状。判据与 DA1 逐字相同：**一次真正的新派发算出新的 epoch**，恢复永远不会撞历史键。

  **EC5-a（`EXECUTION_RESULT_CHANGED` 落在哪一格，v1.7 新增，PC-CX-42）**：它**不进上表**，因为上表是按"哪一个输入被撤回"分格的，而这一格没有输入被撤回。它的后果逐字等于上表 `TASK` 那一行：**不开 blocker**、一条写明 `execution_result_changed` 与 `changedComponents[]` 的 `NOOP` 审计行、责任人 `SYSTEM / EVENT`、`dispatch_attempt` 照常 +1。恢复是**下一次 reconcile**：改动 `agent.default_effort` / `agent.required_capabilities` / `task.required_capabilities` 的那次写入本身会产生事件（§5.3 N1 / `user.project_edited`），控制环读到新事实、算出**一份新的**执行上下文、用**一个新的键**派出去。**不新增 blocker kind**（§11.2 的封闭集合一个字不改）。

**EC6（占位的冻结列是从哪里来的，v1.7 新增，PC-CX-42 / PC-CX-38）**：提交点比对回答"还一不一样"，它**不**回答"最后写进 Session 的是哪一份"。这两件事必须由同一份数据决定，否则一次通过的比对之后仍然可以插入另一份结果。因此冻结三句：

- **EC6-a（create 冻结列由 `execution_context` 构造，不由第二次解析构造）**：插入占位 Session 时，PAC §6 里冻结时刻为 **Session create** 的每一列（`agentId` / `workspaceId` / `assignedRunnerId` / `provider` / `providerBuiltin` / `requiredCapabilities` / `permissionMode`）与 `resolution` 一律**取自动作行上的 `execution_context`**，不得由插入处再解析一次。EC3 那一次重解析的用途是**判定**（相等就用冻结的那份、不等就 REFUSE），它的输出**不进** Session。这让 §4.3 I17-A 由构造成立，而不是靠两处代码碰巧算出同一个值。
- **EC6-b（数据库也证明一次）**：§7.7 D15 在插入时逐列比较占位的 create 冻结列与动作行 `execution_context` 的对应分量，不等即拒。它**不重算解析链**（那是 D14 的事，也是 D14-c 那笔账），只做一次等式比较，因此对**任何版本的二进制**都成立且几乎不花钱。
- **EC6-c（claim 冻结列怎么记，v1.9 给两本账一个闭合的语义形状，PC-CX-47 / PC-CX-49）**：`model` / `effort` 按 PAC §6 在**首次 claim** 才 materialize，因此它们在 create 时**不写**。EC2-b 的第二部分记的是**解析结论**，而这个结论必须是**三选一里的一个具体答案**，不能是"没写"：

  | 位置 | 形状（**闭合**：键多一个、少一个、类型不对都是缺陷） |
  |---|---|
  | `execution_context.model` / `execution_context.effort` | **必填**。取值要么是一个非空的具体值，要么是字面量 `DEFERRED_TO_CLAIM`（PAC §7.2 优先级 3 把 model 留给 claim 时的 runtime 默认）。v1.7/v1.8 写的是"冻结值为空时…"，而**缺键、JSON null 与"结论就是延后"这三样在数据库里长得一模一样** —— 一条分不清它们的硬门什么都拒不了（`PC-CX-47`） |
  | `detail.claimResolution` | 恰好四个键：`generation`（数值，恒为 `1`）、`at`（ISO-8601 UTC，形如 `2026-08-19T00:00:00.000Z`，不早于 `execution_context.snapshotFrozenAt`）、`model`、`effort` |
  | `claimResolution.model` / `claimResolution.effort` | 各恰好三个键 `frozen` / `value` / `source`。`frozen` **逐字等于** `execution_context` 的对应分量（照抄不了就说明这条记录记的不是这次派发）；两支各只有一种合法组合：`frozen` 是具体值 ⇒ `source = 'FROZEN_CONTEXT'` ∧ `value = frozen`；`frozen = 'DEFERRED_TO_CLAIM'` ⇒ `source = 'RESOLVED_AT_CLAIM'` ∧ `value` 是一个非空、且不等于 `DEFERRED_TO_CLAIM` 的具体值（**这一支就是"原子记录实际解析结果"**：解析发生在哪个二进制里不重要，它的结论必须与那次 claim 写在同一个事务里） |
  | `detail.retiredPins[k]`（k 从 0 起） | 恰好六个键：`generation`（数值，`= k + 2`）、`component`（`'model'` 或 `'effort'` —— PAC §6 里冻结时刻为首次 claim 的恰好那两行）、`from`、`to`（非空且 `to ≠ from`）、`at`（ISO-8601 UTC，不早于上一条的 `at`，第一条不早于 `claimResolution.at`）、`reason`（封闭集合；PAC §6 只保留了一个合法例外"模型被 runtime 彻底下架"，因此它今天**恰好一个成员** `'RUNTIME_RETIRED'`，PAC 多留一个例外这里才多一个成员） |

  首次 claim 把这条 `claimResolution` 写进动作行的 `detail`（`detail` 是 D11-b 的可写列之一）并把 `session.execution_pin_generation` 置 1；此后每一次合法 `retiredPin` 追加一条 `detail.retiredPins[]` 并把代次 +1。**这一整套的恒成立形式是 §4.3 I17-A2，它的语句级 mutator 协议是 §7.7 D15，提交点的判定是 §7.7 D16 的 ⓪ 号函数。**
- **EC6-d（`snapshotFrozenAt` 的唯一来源，v1.8 新增，PC-CX-44）**：PAC §6 那张表的最后一行是 `snapshotFrozenAt`，它一旦非 null，上面每一列都进入只读 —— 因此它是**冻结那一刻**的时间戳，不是**写入那一刻**的。它由 §7.4 第 8 条解析出执行上下文时算出并写进 `execution_context.snapshotFrozenAt`，Session create 时与其余 create 冻结列一样**逐字复制**（EC6-a），此后只读。写成插入处的 `now()` 会让同一份冻结上下文在两次插入里得到两个值，`permissionMode` / `resolution` 那两列的等式因此永远缺一角，而“这一份结果是不是那一次决策冻结的”就再也不是一条可判定的话。**一列既然被声明为冻结，它就必须有一个唯一的来源，否则“冻结”只是一个形容词。**
- **EC6-e（这本账必须折叠回 Session 此刻的那一对 pin，v1.9 新增，PC-CX-47 / PC-CX-49）**：`claimResolution` 的两个 `value` 是链的**起点**；`retiredPins[]` 按**数组顺序**逐条改写其中一个分量，第 k 条的 `from` 必须等于该分量此刻的值、`to` 是它此后的值；折叠完最后一条得到的那一对值**必须逐字等于 `session.model` / `session.effort`**。这一条把三件事收成**同一次判定**：首次 claim 实际取到了什么（EC2-b 第 ② 部分的结论）、账本连不连得上（`from`→`to` 的链与 `generation` 的代次）、以及这条 Session 现在到底在跑什么。**它是双向的**：代次说了几次、账本就必须有几条，而账本折叠出来的结果就是 Session 现在的值 —— 任一侧单独成立都不够，因为 `PC-CX-47` 与 `PC-CX-49` 恰好各是"只查了一侧"的一个实例。**为什么起点是 `claimResolution` 而不是 `execution_context`**：冻结分量可能是 `DEFERRED_TO_CLAIM`，那时链的起点只能由那次 claim 的实际结论给出；而 `claimResolution.model.frozen` 逐字等于冻结分量这一条又把这个起点钉回那次决策，因此两支都不留活口。数据库侧由 §7.7 D16 的 ⓪ 号函数执行，Session 侧与动作侧各调用它一次。

**A5（v1.4 新增，PC-CX-26）**：第 6、7 两条与第 4 条是**同一种东西** —— 都是读快照得出的乐观前置。第 4 条的真正互斥在 §7.7 D5（数据库唯一索引），第 6、7 条的真正互斥在 §9.6 的 project 行锁。**把任何一条快照读当成门就是 `PC-CX-01` 的形状**，只是对象从"另一个进程"换成了"另一个人"。

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

  **v1.5 补齐了它被拒之后会发生什么（PC-CX-31）**。v1.1–v1.4 只写了"至多一次"，没写第二次**去哪了**：`MANUAL` 是 TU4 全序里最高的那一条，它由一个人的显式请求触发，而这个请求要么被 `consumed_at` 吃掉（**永久丢失** —— 用户点了"现在跑一下"，控制面上什么都不会发生，也没有任何一条记录说它被拒过），要么不被消费（此时 §10.4 那张**封闭**的 `nextWakeAt` 列表里没有任何一项指向窗口边界，于是要么下一个 tick 立刻重新命中同一条限频、要么等到下一件不相干的事把项目叫醒）。两种读法都能从 v1.4 的字面实现出来，而它们的差别是"请求丢了"与"忙等"。v1.5 把这条边界冻结成五句：

  - **TR2-a（窗口身份，持久且单调）**：`(generation, reasonCode)` 的限频窗口由它的**锚点**唯一标识 —— 同一 `(generation, reasonCode)` 上**最近一条** `status = APPLIED` 的 `OPEN_COORDINATOR_TURN` 动作行。窗口身份 = 该行的 `idempotency_key`（全局唯一、历史行永不删除、`APPLIED` 之后由 §7.7 D11 钉成不可改写），窗口边界 = 该行的 `created_at + 60s`。两者都是**已落库的事实**，因此跨进程、跨重启、跨接管读到的是同一个窗口；`generation` 只增（§7.5）、动作键只增（§8.2 GE1），因此窗口身份**单调不复用**。它经 §6.1 S9 的 `world.actions.turns` 进入 `decisionInput`，经 `evaluation.turnWindows[reasonCode].rateLimitExpired` 折成一个布尔（S5 逐字不变）。
  - **TR2-b（被限频的确定结果）**：TU4 选中的 `reasonCode` 其窗口未过期时，这一次 reconcile **确定地**做四件事，一件不多一件不少：① **不开 turn**（不产生 `OPEN_COORDINATOR_TURN` 动作，因此不占任何键）；② 触发它的那些 `signals` 对应的 `project_event` 行**保持未消费**（`consumed_at` 仍为 `NULL`）；③ 把这些行的 `next_attempt_at` 置为**窗口边界**（`project_event` 已有的列，§5.4），`attempts` **不变** —— 这不是一次投递失败；④ 记一条 `NOOP` 审计行，`detail = { reasonCode, windowKey, windowEndsAt, pendingSignalCount }`。
  - **TR2-c（消费语义，冻结）**：一条 `user.manual_trigger` 事件的 `consumed_at` **只在它被回答时**写，且**只有两种回答**：① 本次 outcome 提交了一条 `reasonCode = MANUAL` 的 `OPEN_COORDINATOR_TURN`（TF5 让这一条 turn 一次回答掉**当时全部** pending 请求，因此它们在同一事务里一起被消费）；② TR3 为它开了一条 `COORDINATOR_NO_PROGRESS` blocker（请求得到的是一个有责任人、看得见的答复，而不是沉默）。**其余任何情形都不得写 `consumed_at`** —— 包括被 TR2 限频、包括没有活的 Coordinator Session 而先要走 `ROTATE_COORDINATOR_SESSION`。这一条与 §5.4 的"消费 ≠ 处理成功"是同一句话在**语义**事件上的加强：对纯脏标记事件，"看过一眼"就是处理完了；对一个**被请求的动作**，处理完的意思是它被执行或被明确拒绝。
  - **TR2-d（唤醒与幂等，v1.6 按 W5 改述，PC-CX-35）**：窗口边界作为一个候选进 §10.4 的**第 7 条**，最终的 `nextWakeAt` 由 §10.4 W5 裁决：`max(min(全部候选), evaluation.epoch + 5s)`（v1.7，`PC-CX-40`）。因此这一条要求的不是"`nextWakeAt` 必然 `≤ windowEndsAt`"（窗口只剩不到 5 秒时那个要求与 W3 无解，v1.5 这里逐字写的就是那句话），而是 **`nextWakeAt ≤ windowEndsAt + 5s`** —— 窗口边界要么就是被选中的那个时刻，要么被一条更早的候选顶掉（那次更早的唤醒照样会重新判定这条请求），要么被 W3 的下限最多推迟 5 秒。到点重新 reconcile 时 `rateLimitExpired` 为真，TU4 仍选 `MANUAL`（请求还在 `signals` 里），turn 照常开出，键是 `pc:v1:<projectId>:turn:<generation>:<reasonDigest>`，其中 `reasonDigest` 由 TF5 的**全部 pending `dedupeKey` 排序摘要**算出。幂等因此是双层的：同一个 `dedupeKey` 重复投递被 §5.4 的 partial unique index 收敛成一行（集合不变 ⇒ digest 不变 ⇒ 同一个 turn 键）；窗口内到达的 N 个不同请求塌成**同一次** turn 而不是排成 N 次。
  - **TR2-e（用户可见状态，v1.6 按 W5 改述，PC-CX-35）**：一个 pending 的显式请求**必须是看得见的**，四样东西缺一不可：`decisionInput.signals` 里有它、`project_event` 行上 `consumed_at IS NULL ∧ next_attempt_at = windowEndsAt`、`project_decision` 里有那条写明 `windowEndsAt` 的 `NOOP`、以及**窗口边界作为一个候选出现在 `project_decision.detail.wakeCandidates` 里**（§10.4 W5 第 4 条）。`project_runtime.next_wake_at ≤ windowEndsAt + 5s`；**当窗口边界是 W5 选中的那个候选时**，`next_wake_reason = 'manual trigger rate-limited'`。v1.5 这里写的是"`next_wake_at` 指向同一时刻且 `next_wake_reason = …`"（无条件），那句话与 §10.4 "取所有适用项的最小值"在有更早候选时正面冲突 —— 一个 `runAt = 59s` 的任务会把唤醒拉到 59 秒，而 59 秒那次 reconcile 照样重新判定这条 pending 请求，请求既没丢也没被推迟。§10.3 的 (d) 因此成立，AC10 的展示面直接读上面这四样东西加 `wakeCandidates`。**不开 blocker** —— 没有任何人需要做任何事，控制环也没有停，它安排了一次确定的重试；这与 §9.4 `maxConcurrentTasks` 那一行、§9.5 Q3-a 退避期那一行是**同一种形状**，理由也逐字相同（BL1 的另一条合法出口）。
- **TR3（无进展即转 blocker）**：若已存在同一 `(generation, reasonDigest)` 的 `OPEN_COORDINATOR_TURN` 动作，**且它对应的 turn 已经结束**，那么按 TR1 的定义，上一次 turn **没有改变它自己被叫醒的那些事实**。此时：
  1. **不再开 turn**（否则就是 foreman 事故的形状）；
  2. 开一条 `COORDINATOR_NO_PROGRESS` blocker（§11.2，`owner = USER`、`recovery = HUMAN`、`opensTurn = ✘`），`subject` 指向该 `reasonDigest`，`detail` 带上 `reasonCode` 与上一次 turn 的 Session id；
  3. 该 blocker 的自动解除条件就是 **`reasonDigest` 变了**（§11.4 的重算，BL3）—— 事实一变，旧 digest 不再成立，blocker 自动 clear，新 digest 自然获得一次新的 turn。

  **TR3 的成立前提（v1.4 冻结，PC-CX-24）**：本条从"同一个 `reasonDigest`"推出"上一次 turn 没有改变事实"，这个推理**只有在 `reasonDigest` 能区分周期时才成立**。因此 `turnFacts` 必须按 §7.2 TF4 带上产生它的那一行的代次；否则一个**被解决过、后来复发**的 blocker 会撞上历史 digest，被本条误判成"协调器上次没干活"并直接交给人。**TR3 判的是"没进展"，不是"又坏了一次"** —— 两者在数据库里的区别就是那个代次。

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
| 控制环 `DISPATCH_TASK` | `INSERT … ON CONFLICT DO NOTHING RETURNING id`（§8.5） | 返回 0 行 | `project_action.status = SUPERSEDED`、`refusal_code = TASK_ALREADY_RUNNING`；**本次事务照常提交**（事件被消费、blocker/decision/nextWake 落库）；`nextWakeAt = evaluation.epoch + 60s` |
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
  IF NEW.dispatch_origin = 'USER' THEN
    -- v1.3（PC-CX-20）：人的显式动作不占控制环账本，因此它**不得**带动作 id。v1.2 这一支
    -- 直接 RETURN，于是一条 USER-origin 的 Session 可以挂着任意一条 action 行，I11 的
    -- 第二句在数据库里无人验证。这一半另有 CHECK 约束兜底（D9-c）。
    IF NEW.project_action_id IS NOT NULL THEN
      RAISE EXCEPTION 'DISPATCH_ATTRIBUTION_VIOLATION: user-origin session % carries an action id', NEW.id;
    END IF;
    RETURN NEW;                                                              -- D3：人的显式动作
  END IF;
  -- v1.3（PC-CX-20）：v1.2 的谓词只有 `project_action_id IS NOT NULL`，它证明不了 I11 要求的
  -- 任何一件事 —— 真实 Postgres 上插入一条 `type=NOOP, status=CLAIMED` 的 action 再插这条
  -- Session，事务照常提交，得到一个"归属"到 NOOP 的占位。归属必须逐项读出来才算被证明：
  IF NEW.dispatch_origin = 'COORDINATOR' AND NEW.project_action_id IS NOT NULL AND EXISTS (
       SELECT 1
         FROM project_action a
         JOIN task t2 ON t2.id = NEW.task_id
         JOIN project_runtime r ON r.project_id = a.project_id
        WHERE a.id = NEW.project_action_id
          AND a.type = 'DISPATCH_TASK'          -- 不是 NOOP，也不是别的动作
          AND a.status IN ('CLAIMED','APPLIED') -- 插入时它还是 CLAIMED（§8.3 的语句顺序）
          AND a.subject_type = 'TASK'
          AND a.subject_id = NEW.task_id        -- 是**这个** Task 的动作
          AND a.project_id = t2.project_id      -- 而且属于这个 Task 所在的 Project
          AND a.fencing_token = r.fencing_token -- 由**当前**租约持有者提交（§8.1 F1）
     ) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'DISPATCH_AUTHORITY_VIOLATION: task % is COORDINATOR-authority', NEW.task_id;
END;
$$ LANGUAGE plpgsql;
```

**D6-a**：触发器是**唯一**对旧二进制也成立的授权硬门。它同时挡住两个方向：旧 sweep 派 `COORDINATOR` 权的任务（`dispatch_origin` 落默认值 `LEGACY_SWEEP` ⇒ 拒绝），和控制环派 `LEGACY` 权的任务（越界的另一半）。
**D6-b**：触发器抛异常会中止那一个入口的事务 —— 这是**故意的**，而且只对越权入口成立：控制环与人工入口在正常情况下永远不会触发它。旧二进制在回滚窗口里会因此看到派发失败并记错误日志，**这是可见的失败，不是静默的双重派发**，是本条要买的东西。
**D6-c**：新二进制的人工入口必须显式写 `dispatch_origin = 'USER'`。忘了写 = 落 DB 默认 `LEGACY_SWEEP` = 对 `COORDINATOR` 权任务立即失败。**fail closed，且在第一次点击时就暴露**，不会拖到生产。

#### D9 · 派发归属的提交时证明（v1.3 新增，PC-CX-20）

D6 是 `BEFORE INSERT`，它只能看见**那一刻**的事实 —— 与 `PC-CX-09` 同型的老问题在归属上再来一次：插入时动作行是 `CLAIMED`，而 I11 要求的是 `APPLIED`；同一个事务完全可以在插完 Session 之后把动作改成 `REFUSED`/`SUPERSEDED`、或者把 `subject_id` 改掉，然后提交。**"插入时成立"不是"已提交状态上成立"。**

```sql
-- 提交时再看一遍。DEFERRABLE INITIALLY DEFERRED ⇒ 它在 COMMIT 的那一刻执行，因此读到的是
-- 本事务的最终状态，而不是语句中途的状态。
CREATE OR REPLACE FUNCTION session_dispatch_attribution_check() RETURNS trigger AS $$
DECLARE ok boolean;
BEGIN
  -- v1.8（PC-CX-45）：作用域读 OLD **和** NEW。v1.3–v1.7 只读 NEW，于是一条 UPDATE 只要把
  -- NEW 写成 `task_id = NULL, dispatch_origin = 'USER'` 就能让本条对**它自己**不适用 —— 一条
  -- 已经归属出去的 COORDINATOR 占位因此可以一句话解除归属。只有两侧都不是 COORDINATOR 占位才放过。
  IF TG_OP = 'UPDATE' THEN
    IF (OLD.task_id IS NULL OR OLD.dispatch_origin <> 'COORDINATOR')
       AND (NEW.task_id IS NULL OR NEW.dispatch_origin <> 'COORDINATOR') THEN RETURN NULL; END IF;
  ELSIF NEW.task_id IS NULL OR NEW.dispatch_origin <> 'COORDINATOR' THEN
    RETURN NULL;
  END IF;
  SELECT EXISTS (
    SELECT 1
      FROM project_action a
      JOIN task t ON t.id = NEW.task_id
      JOIN project_runtime r ON r.project_id = a.project_id
     WHERE a.id = NEW.project_action_id
       AND a.type = 'DISPATCH_TASK'
       AND a.status = 'APPLIED'                 -- 提交时必须是 APPLIED，不是 CLAIMED/REFUSED/SUPERSEDED
       AND a.subject_type = 'TASK'
       AND a.subject_id = NEW.task_id
       AND a.project_id = t.project_id
       AND a.fencing_token = r.fencing_token
  ) INTO ok;
  IF NOT ok THEN
    RAISE EXCEPTION 'DISPATCH_ATTRIBUTION_VIOLATION: session % is not attributable to an applied dispatch', NEW.id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER session_dispatch_attribution_check
  AFTER INSERT OR UPDATE OF project_action_id, dispatch_origin, task_id ON session
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION session_dispatch_attribution_check();

-- 只有 COORDINATOR-origin 的 Session 才可能带动作 id。这一条不需要读任何别的表，
-- 因此写成 CHECK 而不是触发器：它对 UPDATE 同样成立，且不可被延迟绕过。
ALTER TABLE session
  ADD CONSTRAINT session_action_only_for_coordinator_chk
  CHECK (dispatch_origin = 'COORDINATOR' OR project_action_id IS NULL);
```

**D9-a（它证明的正是 I11）**：三条归属句子（§4.3 I11）此后**逐条**由数据库对象保证 —— `COORDINATOR ⇒ 有一条本 Task、本 Project、当前 fencing token 下的 APPLIED `DISPATCH_TASK`` 由本触发器保证；`USER ⇒ 动作 id 为 NULL` 与 `LEGACY_SWEEP ⇒ 动作 id 为 NULL` 由 CHECK 保证；`LEGACY_SWEEP ⇒ 该 Task 的授权是 LEGACY` 由 D6 + D8 保证（I12）。v1.2 的契约说"由 D6 保证"，而 D6 读的是 `project_action_id IS NOT NULL` —— **它没有读它声称保证的任何一列**。

**D9-b（为什么必须是可延迟的）**：§8.3 冻结的语句顺序是"先插动作行（`CLAIMED`）→ 再插 Session → 再把动作置 `APPLIED`"。一个立即执行的约束会在第 2 步就要求 `APPLIED`，那会逼实现把顺序倒过来 —— 而倒过来正是 X1 禁止的"先做副作用再写键"。**可延迟约束让两条规则同时成立**：语句顺序保持 exactly-once 的形状，归属在提交时被证明。

**D9-c（`fencing_token` 这一项为什么能比）**：§8.1 F1 要求提交事务里有一条 `UPDATE project_runtime … WHERE fencing_token = :token`，它对该行取排他锁，因此在本事务提交前**没有任何别的 reconcile 能推进这个 token**。于是"动作行的 token = `project_runtime` 当前 token"在提交时刻等价于"这个动作是由当前租约持有者提交的"。一次被接管的旧实例即使绕过应用层直接插行，它的 token 已经落后，这条比较为假，提交被拒。

**D9-d（可测形式）**：真实 Postgres 上建**带外键的** `project_action` 表，正例（`DISPATCH_TASK`/`APPLIED`/本 Task/本 Project/当前 token）提交成功并在 `COMMIT` 之后断言 I11-A；六个反例逐个断言提交被拒：错 type（`NOOP`）、错 status（`CLAIMED` 停在那里不改）、错 Task、错 Project、陈旧 fencing token、以及 `USER` origin 带非空动作 id。**断言必须落在 `COMMIT` 之后**，因为这一项要证明的就是"已提交状态上成立"。

**D9-e（token 那一项是提交时授权，不是恒等式，v1.4 冻结，PC-CX-21）**：`a.fencing_token = r.fencing_token` 这一行**只在本触发器执行的那一刻**被要求。它证明的是 I11-B（"这次派发由当时的租约持有者提交"），**不是** I11-A（"这条占位归谁"）。v1.3 把这两件事写成同一条不变量，于是**下一次完全正常的租约**就把它弄假了：任何一次事件/定时唤醒成功取到租约都会让 token +1（§8.1），而被上一次派发出去的 Session 仍然在飞、Session 的三列一列没动、D9 因此根本不会再执行 —— 查询已提交状态得到 `action.token = 42 ≠ runtime.token = 43`，"不变量"为假，而系统里**没有任何东西做错**。审查记为 `PC-CX-21` 的前一半。

  v1.4 的修正只在**不变量的写法**上，触发器一个字不改：恒成立的那一句用**单调关系** `action.fencing_token <= project_runtime.fencing_token`（§4.3 I11-A）。它的意思是"这次派发是在本项目某一次不晚于当前的租约下被授权的"，配上 D9 在提交点强制的等号，两句合起来恰好等于"由**它自己那一次**的租约持有者授权"。**token 只会增，所以 I11-A 一旦为真就永远为真** —— 这才是一条不变量该有的形状。

  这条修正只有在 D9 读到的**其它行**也不会被改的前提下才成立，因此 v1.4 给它们各配一条反向约束：`task.project_id`（D10）、`project_action` 的归属列与 `status`（D11）。**一条硬门读到的每一行，都必须有一个封闭的 mutator 协议** —— 否则它证明的只是"插入那一刻"，而这正是 `PC-CX-09`／`PC-CX-20` 已经交过两次的学费。

#### D10 · 占位期间 Task 不得跨 Project 移动（v1.4 新增，PC-CX-21）

D9 的谓词里有 `a.project_id = t.project_id`。`t.project_id` 是一个**别人可以改**的列 —— §13.4 AE10 明确允许 Task 跨 Project 移动，而 D9 只声明在 `session` 的三列上，移动 Task 时它**不会执行**。于是一条完全合法的移动就能让一条在飞 Session 的归属静默失真：动作属于 P1，Task 已属于 P2。

修法与"归属必须由数据库证明"是同一条：给被读的那一行配一个**封闭的 mutator 协议**。最小且足够的协议是**在占位期间冻结这一列**：

```sql
CREATE OR REPLACE FUNCTION task_claimed_project_move_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.project_id IS NOT DISTINCT FROM OLD.project_id THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM session s
              WHERE s.task_id = NEW.id AND s.deleted_at IS NULL
                AND s.status IN ('PENDING','RUNNING')) THEN
    RAISE EXCEPTION 'TASK_CLAIMED_PROJECT_MOVE: task % has a live claim and cannot change project', NEW.id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER task_claimed_project_move_guard
  AFTER UPDATE OF project_id ON task
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION task_claimed_project_move_guard();
```

**D10-a（为什么是"禁止"而不是"原子迁移"）**：迁移一条在飞 Session 的归属，意味着要在同一事务里把它的动作行也搬到新 Project、并重算新 Project 的 fencing token 关系 —— 那会让 `project_action` 的 `project_id` 变成可写列，而 D11 刚刚把它冻住。**移动一个正在跑的任务本来就不是一个有明确语义的操作**（它在跑的那份代码、那台机器、那条分支都是按旧 Project 解析出来的，PAC §5），因此这里选的是让它成为一次**可见的失败**：调用方等这次运行结束再移，或者先取消它。错误码 `TASK_CLAIMED_PROJECT_MOVE`，与 `PROJECT_FACT_WRITE_CONTENDED` 同型 —— **有类型、可重试，不是 500**。

**D10-b（为什么必须可延迟）**：AE10 的跨 Project 移动是一个**多行事务**（两个 project 锁 + task 行）。一个立即执行的触发器会在语句中途拒绝一次其实在提交时已经合法的移动（例如同一事务先取消了那条 Session 再移动）。可延迟让判据落在**提交时的最终状态**上，与 D9 同一个理由。

**D10-c（它不阻止什么）**：不影响没有占位的 Task 移动（AE10 逐字不变）、不影响 `parentTaskId` 改父、不影响 `verifiesTaskId` 改指 —— 后两者不进 D9 的谓词。

#### D11 · 动作行的状态转移与终态不可改写（v1.4 新增，v1.7 闭集 allowlist，v1.8 把发布语句也纳入，PC-CX-21 / PC-CX-37 / PC-CX-43）

I11-A 读 `project_action` 的 `type` / `status` / `subject_type` / `subject_id` / `project_id` / `fencing_token`；I17-A 与 §7.4 EC3 读它的 `execution_context` / `execution_context_digest` / `execution_result_digest`；§7.6 TR2-a 读它的 `reason_code`。D9 在提交时验过一次，但它同样只声明在 `session` 上：**此后任何一次 `UPDATE project_action` 都不会让它重跑**。一条 `APPLIED` 的派发动作被改成 `SUPERSEDED`、或者 `subject_id` 被改掉，归属就断了；冻结的执行上下文被改掉，I17-A 的零行查询就返回非零；`reason_code` 被改掉，一个 60 秒限频窗口就被移到了别处 —— 而没有任何东西会发现。

```sql
CREATE OR REPLACE FUNCTION project_action_applied_immutable_guard() RETURNS trigger AS $$
DECLARE writable text[] := ARRAY['result_session_id', 'detail'];   -- 终态之后的闭集，见 D11-b / D11-d
        code     text   := 'ACTION_APPLIED_IMMUTABLE';
        changed  text;
BEGIN
  -- v1.8（PC-CX-43）：作用域由 OLD.status 决定，而 `CLAIMED` 不再是"整行放行"。
  -- v1.7（PC-CX-43）的第一句是 `IF OLD.status <> 'APPLIED' THEN RETURN NEW`，于是 §8.3 那条
  -- **真正把动作发布出去**的 `CLAIMED → APPLIED` UPDATE 恰好落在全量放行窗口里：它可以在同一条
  -- 语句里改写身份、归属、冻结上下文、两个摘要与 reason code，而 D9/D14/D15 都已经跑完了。
  IF OLD.status = 'CLAIMED' THEN
    -- 封闭 transition allowlist：`CLAIMED` 只能停在原地或走向三个终态之一（D11-a）。
    IF NEW.status IS NULL OR NEW.status NOT IN ('CLAIMED', 'APPLIED', 'REFUSED', 'SUPERSEDED') THEN
      RAISE EXCEPTION 'ACTION_TRANSITION_ILLEGAL: action % cannot go CLAIMED -> %',
        OLD.id, COALESCE(NEW.status, 'NULL');
    END IF;
    writable := writable || ARRAY['status', 'refusal_code'];    -- 发布语句的闭集，见 D11-f
    code     := 'ACTION_PUBLISH_IMMUTABLE';
  ELSIF OLD.status NOT IN ('APPLIED', 'REFUSED', 'SUPERSEDED') THEN
    RAISE EXCEPTION 'ACTION_TRANSITION_ILLEGAL: action % has an unrecognised status %', OLD.id, OLD.status;
  END IF;
  -- v1.7（PC-CX-37）：比较**整行**，只放过 allowlist 里的列。这不是一张要跟着 schema 手工
  -- 长大的清单 —— `to_jsonb(NEW/OLD)` 覆盖这张表**当时的全部列**，因此后来加的列默认是冻结的。
  IF (to_jsonb(NEW) - writable) IS DISTINCT FROM (to_jsonb(OLD) - writable) THEN
    SELECT string_agg(e.key, ',' ORDER BY e.key) INTO changed
      FROM jsonb_each(to_jsonb(NEW) - writable) e
     WHERE e.value IS DISTINCT FROM ((to_jsonb(OLD) - writable) -> e.key);
    RAISE EXCEPTION '%: action % is %; identity, attribution, frozen execution context, both digests and the reason code are frozen (changed: %)',
      code, OLD.id, OLD.status, changed;
  END IF;
  RETURN NEW;                                                   -- result_session_id / detail 仍可补写
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_action_applied_immutable_guard
  BEFORE UPDATE ON project_action
  FOR EACH ROW EXECUTE FUNCTION project_action_applied_immutable_guard();
```

**D11-a（v1.8 由函数体自己表达，PC-CX-43）**：`APPLIED` 是**终态**。`status` 的合法转移恰好是 `CLAIMED → {APPLIED, REFUSED, SUPERSEDED}` 三条，且三个终态都不再出去 —— 这与 §8.2 GE1"历史行永不删除"是同一条纪律的另一半：**历史不但不能被删，也不能被改**。v1.4–v1.7 只把这句话写在正文里：函数的第一句放过任何 `OLD.status <> 'APPLIED'` 的行，因此 `REFUSED → CLAIMED` 这种"出去"的转移在数据库里同样没人拦。v1.8 起 `status` 本身就在终态那张 allowlist 之外，转移目标又由上面那个封闭集合判定，**三个终态不再出去因此成了一条由构造成立的话**。

**D11-b（可写集是一个闭集，v1.7 改述，PC-CX-37）**：`APPLIED` 之后仍然可写的**恰好**是 `result_session_id` 与 `detail` 两列 —— 前者由 §8.3 的语句顺序在插完 Session 之后回填，后者由 §7.4 EC6-c 的首次 claim 记录与展示补写；两者都不进任何硬门的谓词（I11-A、I17-A、I17-A2、EC3、EC6、TR2-a 一列都不读它们）。**这一句现在由函数体自己表达**：allowlist 写在 `writable` 里，其余一律冻结。

**D11-c（它冻的每一列都是别处一条硬门的谓词，v1.7 新增，PC-CX-37）**：被冻结的不只是 v1.4 那六列。`execution_context` 与 `execution_context_digest` 是 §4.3 I17-A、§7.4 EC3 与 §7.7 D14 比对的那一份 —— 改掉它就可以让一条已提交的占位"对上"一个它从来没被授权过的上下文；`execution_result_digest` 是 §7.4 EC2-b 的结果摘要；`reason_code` 是 §7.6 TR2-a 的**窗口锚点**，改掉它就可以把一个 60 秒限频窗口移到另一个 `reasonCode` 上、或者让它整个消失。**这四样都是 v1.5 / v1.7 加进这张表的列，而 v1.4 的 denylist 不认识它们。**

**D11-f（发布语句自己也在冻结范围里，v1.8 新增，PC-CX-43）**：`CLAIMED` 行上仍然可写的**恰好**是 `status` / `refusal_code` 与终态那两列，一共四列。这四列是 §8.3 冻结的语句顺序在第 4 步真正要写的东西（`status = 'APPLIED' | 'SUPERSEDED'`、`result_session_id = …`，被拒时再加一个 `refusal_code`），**其余每一列都必须与第 1 步插进来的那一行逐字相同**。理由是一条时序：§8.3 先插 `CLAIMED` 动作、再插 Session、最后才把动作置 `APPLIED`；D9 / D14 / D15 都声明在 `session` 上，它们在第 2 步就已经跑完了。因此第 4 步那条 UPDATE 是**所有硬门都已经放行之后**的最后一次写机会 —— v1.7 把它整条放过，等于把 `execution_context` / 两个摘要 / `reason_code` / 归属六列一起交给了它。**最小事务只有三句**：插 `CLAIMED`（`execution_result_digest = 'result-ok'`）→ 插一条与冻结上下文完全匹配、因此 D15 放行的 Session → `UPDATE … SET status='APPLIED', execution_result_digest='forged-after-session-insert'`，提交成功。**这与 `PC-CX-09` / `PC-CX-20` 是同一个教训的第三次**：一条只在某个时刻被检查的性质，必须问"在它之后还剩哪一次写"；差别只在这次剩下的那一次写**就是把行发布出去的那一条**。

**D11-g（可测形式，v1.8 新增，PC-CX-43）**：D11-e 的 schema 驱动逐列 mutation 必须跑**两遍**：一遍在已 `APPLIED` 的 OLD 行上（v1.7 的那一遍），一遍在 §8.3 的**发布 UPDATE 本身**上 —— 即先插 `CLAIMED`、插 Session，再逐列尝试"改这一列 + 置 `APPLIED`"，断言 `status` / `refusal_code` / `result_session_id` / `detail` 之外**每一列**都被 `ACTION_PUBLISH_IMMUTABLE` 拒绝，而干净的发布 UPDATE 照常提交。还要断言 `CLAIMED → 'PENDING'` 之类不在闭集里的目标得到 `ACTION_TRANSITION_ILLEGAL`，以及 `REFUSED → CLAIMED` 被拒。**反向对照**：把 v1.7 的 `IF OLD.status <> 'APPLIED' THEN RETURN NEW` 那一版原样建回来，同一个三句事务提交成功，`execution_result_digest` 观察为 `forged-after-session-insert` —— 与复审报告 §6 `PC-CX-43` 的那一行输出逐字对应。

**D11-d（为什么是 allowlist 而不是 denylist，v1.7 冻结，PC-CX-37）**：v1.4 把"不可改写"写成一张**逐列枚举的 denylist**。v1.5 给同一张表加了三列（§2.4），没有人回头改这个函数；于是一条普通 `UPDATE` 可以把一条已 `APPLIED` 的派发动作的冻结上下文改成另一个 provider，同时把 `reason_code` 改掉 —— 事务照常提交，I17-A 的零行查询返回 1 行，TR2 的窗口锚点被移走（`PC-CX-37`，P0）。这与 `PC-CX-27` / `PC-CX-30` / `PC-CX-33` 是**同一个教训的第四次**：**一个封闭集合必须由构造保证封闭，不能靠下一个人记得回来加一行。** allowlist 把默认值反过来 —— 新列默认冻结，要放开必须**显式**写进 `writable`，而写进去的那一刻就必须回答"它进不进任何谓词"。

**D11-e（可测形式，v1.7 改述，PC-CX-37）**：真实 Postgres 上**由 schema 驱动**逐列 mutation：从 `information_schema.columns` 读出 `project_action` 的全部列，对一条 `APPLIED` 行逐列尝试改写，断言 **allowlist 以外的每一列**都被 `ACTION_APPLIED_IMMUTABLE` 拒绝（**不是**断言"六列被拒"——那个数字本身就是缺陷的形状），断言两列仍可写，再断言 `CLAIMED → APPLIED` 与 `CLAIMED → SUPERSEDED` 照常通过（否则 §8.3 的正常路径会被自己挡住）。**反向对照**：把 v1.4 的 denylist 函数原样建回来，同一次 mutation 让 `execution_context` / `execution_context_digest` / `reason_code` 三列全部提交成功，I17-A 的零行查询返回 1 行 —— 与复审报告 §6 `PC-CX-37` 的那三行输出逐字对应。


#### D12 · `dispatch_authority` 由数据库维护（v1.4 新增，PC-CX-25）

见 §12.3 D3 与下面的 D8。这一条与 D5 / D6 / D9 / D10 / D11 一样，**必须由数据库自己执行**，理由也一样：它要挡住的入口是"另一个版本的旧代码"。

#### D13 · 授权投影的漂移查询（v1.4 新增，PC-CX-25）

I12-A 是可查询的，因此它必须**被查**。下面这条语句对任何已提交状态返回 **0 行**；返回非 0 即为 P0：

```sql
SELECT t.id, t.dispatch_authority AS projected,
       CASE WHEN p.id IS NOT NULL AND p.coordinator_enabled THEN 'COORDINATOR' ELSE 'LEGACY' END AS derived
  FROM task t
  LEFT JOIN project p ON p.id = t.project_id
 WHERE t.dispatch_authority IS DISTINCT FROM
       (CASE WHEN p.id IS NOT NULL AND p.coordinator_enabled THEN 'COORDINATOR' ELSE 'LEGACY' END);
```

**D13-a**：它是 04 / 19 / 22 单元的断言，也是运维可以对生产直接跑的一条 —— 与 §4.3 I10 同型。**"投影是新鲜的"从此是一条查询，不是一条承诺。**
**D13-b**：这条查询 join 了 `project`，而 §12.3 D2 禁止的是**派发路径**去 join `project`。两者不冲突：D2 管的是"刹车不能挂在一张可以被删掉的行上"，而这里是一条**离线校验**，它的作用恰恰是证明刹车（task 行上的那一列）没有跑偏。

#### D14 · 执行上下文的提交时授权门（v1.5 新增，PC-CX-29）

D9 证明"这条占位归哪一次派发动作"，它**不问那次派发现在还成不成立**。§7.4 第 8 条解析出的执行上下文（EC1 的八个输入）在快照与提交之间可以被人整个撤掉：禁用 Agent、把他移出团队、改任务的 assignee/provider/model、撤回 Provider、软删 Workspace、关掉 Runner。v1.4 的提交门（§9.6 AU1）只重读 `project` 的四个策略字段，因此**一条解析到已禁用 Agent 的 Session 可以合法提交**，与 §4.3 I7"控制环发起的动作，其授权判定与人手动发起时完全相同"正面冲突（`PC-CX-29`，P0）。

服务层的 EC3 已经在同一把 project 锁之后用 `FOR SHARE` 重解析了一遍，但**服务层的检查按定义只在写这段检查的那个二进制里存在**（§2.4 的同一句话）。因此这一条与 D5 / D6 / D9 同样落在数据库里：

```sql
-- 提交时再证明一次。DEFERRABLE INITIALLY DEFERRED ⇒ 在 COMMIT 那一刻执行，读到的是本事务的
-- 最终状态；FOR SHARE ⇒ 与人工撤权的 `UPDATE …`（自动取 FOR NO KEY UPDATE）互斥，因此
-- "看不见未提交的写"这个老坑（D8-note / PC-CX-09）在这里不会第三次出现。
CREATE OR REPLACE FUNCTION session_execution_context_guard() RETURNS trigger AS $$
DECLARE frozen text; observed text; revoked text;
BEGIN
  -- v1.8（PC-CX-45）：与 D9 / D15 同一条作用域规则 —— 读 OLD 和 NEW，不让被保护的那一行
  -- 把自己写出保护范围。
  IF TG_OP = 'UPDATE' THEN
    IF (OLD.task_id IS NULL OR OLD.dispatch_origin <> 'COORDINATOR')
       AND (NEW.task_id IS NULL OR NEW.dispatch_origin <> 'COORDINATOR') THEN RETURN NULL; END IF;
  ELSIF NEW.task_id IS NULL OR NEW.dispatch_origin <> 'COORDINATOR' THEN
    RETURN NULL;
  END IF;

  SELECT a.execution_context_digest INTO frozen
    FROM project_action a WHERE a.id = NEW.project_action_id;

  -- EC1 的八行，按 §8.6 LO1 的顺序、全部共享锁。任何一行不再授权 ⇒ revoked 取 EC1 表里
  -- 序号最小的那一个输入（EC4 的全序），digest 因此必然不等，两条判据不会互相打架。
  SELECT ec.digest, ec.revoked_input INTO observed, revoked
    FROM resolve_execution_context_locked(NEW.task_id, NEW.agent_id) ec;

  IF observed IS DISTINCT FROM frozen THEN
    RAISE EXCEPTION 'EXECUTION_CONTEXT_REVOKED: % (frozen=%, observed=%)',
      COALESCE(revoked, 'UNKNOWN'), frozen, COALESCE(observed, 'unresolvable');
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql VOLATILE;   -- 取锁的函数不能是 STABLE/IMMUTABLE，见 D14-f

CREATE CONSTRAINT TRIGGER session_execution_context_guard
  AFTER INSERT OR UPDATE OF project_action_id, dispatch_origin, task_id, agent_id ON session
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION session_execution_context_guard();
```

**D14-a（`resolve_execution_context_locked` 是什么，边界写死）**：它是一个 **`VOLATILE`** 的 plpgsql 函数（这两个字是规范的一部分，理由与它必须被断言的方式写在 D14-f），读 EC1 那八行（全部 `FOR SHARE`，按各表内 id 升序）并**只做一件事** —— 按 PAC §5 / §7.3 / §7.4 的解析链算出 `(resolvedAgentId, projectMemberId, taskId, taskAssigneeAgentId, providerSlug, model, workspaceId, runnerId, coordinatorWorkspaceId)` 与它们的 `executionContextDigest`，外加第一个不再授权的输入。**v1.9（`PC-CX-48`）：那个摘要必须是 `coordinator_execution_digest(jsonb_build_object(<这九个键>))`** —— 与 §7.7 D17 重算 `execution_context_digest` 用的是**同一个函数、同一份键集**（EC2-a），否则 D14 与 D17 会各算各的，而两条硬门对同一列给出两个"正确值"就等于都没有。**它不写任何一行，也不做任何 fallback** —— PAC §7.4 的 provider fallback 是解析链自己的一部分，由 Agent 上的显式配置驱动（§9.3 第 2 条），它照常参与解析、照常改变 digest，因此 fallback 生效与否**必然**表现为一次 REFUSE 而不是一次静默换引擎。**这是本文对 PAC 唯一的"在数据库里再实现一次"**，代价与理由都在 D14-c。

**D14-f（`VOLATILE` 不是默认值，是被断言的规范，v1.6 新增，PC-CX-32）**：v1.5 的 D14-a 写的是"一个 `STABLE` 的 SQL 函数"，同一段又要求它的每一个读都是 `FOR SHARE`。**这两句在 PostgreSQL 上不可能同时成立** —— 一个非 volatile 的函数不允许取行锁，服务器直接拒绝：

```text
ERROR:  SELECT FOR SHARE is not allowed in a non-volatile function
SQLSTATE: 0A000
CONTEXT: SQL statement "SELECT enabled FROM authority WHERE id='a1' FOR SHARE"
```

因此按 v1.5 的字面建出来的 D14 每一次被调用都抛 `0A000`，而它被调用的位置是 deferred trigger 的**提交阶段**：事务整体 abort，动作行、Session、决策、事件消费与 wake 一个都提交不了，而 `0A000` 不在 EC4 那张封闭的拒绝码表里，因此它连一条结构化拒绝都不是（`PC-CX-32`，P0）。

两条路都被考虑过，v1.6 选第一条：

| 选项 | 结果 | 为什么不选 / 为什么选 |
|---|---|---|
| A：函数标 `VOLATILE`，锁与计算留在一起 | 一次调用取锁并算出摘要，语义与 EC3 在服务层做的那一次逐字相同 | **选它。** `STABLE` 在这里买不到任何东西：这个函数由约束触发器**每行调用一次**，plpgsql 函数本来就不会被内联，而 `STABLE` 允许的"同一语句内复用结果"恰恰是**不能要**的 —— 它要的是"在 `COMMIT` 那一刻真的再读一次并把锁拿在手里" |
| B：拆成"取锁"与"纯计算"两个函数（前者 `VOLATILE`，后者 `STABLE`） | 语义等价，但要把八行读出来的值在两个函数之间传一遍 | 不选。它把一个读集拆成两处，D14-c 说的"PAC 解析链改一次这里要跟着改一次"于是变成改两处；而且 `STABLE` 的那一半仍然必须在同一个事务里被前一半的锁保护着调用，谁也没法在类型系统里表达这件事 |

**判据（04 / 13 单元必须逐条断言，不能只 grep 函数体）**：

1. `SELECT provolatile FROM pg_proc WHERE proname = 'resolve_execution_context_locked'` 必须返回 `'v'`。**`pg_proc.provolatile` 是这条规范唯一的可观测形式** —— 一个漏写 `VOLATILE` 的迁移与一个写了的迁移，函数体逐字相同，`pg_get_functiondef` 上 grep `FOR SHARE` 两者都过；差别只在这一列，而它恰好也是 v1.5 的研发 fixture 之所以全绿的原因（没写 volatility ⇒ 默认 `VOLATILE` ⇒ 测的是另一个对象）。
2. `session_execution_context_guard` 的函数同样断言 `provolatile = 'v'`（它也取锁）。
3. **必须调用真实的 deferred trigger**：插入一条 `dispatch_origin = 'COORDINATOR'` 的 Session 并 `COMMIT`，正例提交成功、反例得到 `EXECUTION_CONTEXT_REVOKED: <input>`；只断言"函数能单独跑通"不算 —— 抛 `0A000` 的那个版本在 `CREATE FUNCTION` 时同样成功，它只在**被调用**时才失败。
4. 反向对照必须留着：把同一个函数体重建成 `STABLE`，调用它必须得到 `0A000`，且 `pg_proc.provolatile = 's'` —— 证明这条断言查的是规范说的那件事，不是一个恰好为真的默认值。

**D14-b（它证明的正是 I17-B，v1.6 按时态改述，PC-CX-34）**：任何已提交的 COORDINATOR 占位，**其提交事务里**重解析出的上下文摘要 = 动作行上冻结的摘要。因此"一条在**它自己提交的那一刻**就已经解析到已禁用 Agent 的 Session"在数据库里**不可能存在**，与写它的是哪个版本的二进制无关。**它证明的不是**"任何时刻都不存在一条指向已禁用 Agent 的 live Session" —— 那是一个 v1.5 误加的当前态承诺，人在合法派发之后撤权就会让它为假，而撤权本来就该生效（AU1-a 第二行、F35、PAC §6）。恒成立的那一句是 I17-A（快照列 = 冻结的 `execution_context`），它读的两样东西提交之后都不可改写。三个推论：EC3 在应用层的那次重解析是为了给拒绝一个类型化的名字与一条确定的恢复（EC4 / EC5），不是这条不变量的依据；旧二进制绕过服务层直接插 Session 同样被挡；`APPLIED` 动作行上的 `execution_context_digest` 由 D11 钉成不可改写，因此"改冻结的那一份让它对上"这条路也不存在。

**D14-c（代价与它换到的东西，写下来以便将来重新评估）**：把解析链在数据库里再写一遍是**有成本**的重复 —— PAC 的解析链改一次，这个函数必须跟着改一次，两处不同步会表现为"派发全部被拒"（fail closed，不是 fail open，这是刻意选的方向）。买到的是 §12.4 那一格：**混合版本部署下这条硬门仍然成立**。取舍的依据与 CAP1-b 同一形状：如果将来 PAC 的解析链变得无法在 SQL 里如实表达（例如需要一次网络调用），这一条必须重新评估，届时的退路是把 D14 缩成"八行的授权谓词"而不是"完整解析"，并在契约里显式记下它此后只挡撤权、不挡改派。**04 / 13 单元必须有一条断言：`resolve_execution_context_locked` 与服务层 `resolveExecutionContext` 对同一份 fixture 产出同一个 digest**，否则这条重复实现会静默漂移。

**D14-e（EC3 与 D14 的分工，实测得出，v1.5 冻结）**：一个 `DEFERRABLE INITIALLY DEFERRED` 的约束触发器**在 `COMMIT` 那一刻才取它的锁**，不是在 `INSERT` 那一刻。真实 Postgres 上跑出来的后果很具体：只有 D14 时，控制环插完 Session 到它 `COMMIT` 之间仍有一个窗口，人的撤权可以在这个窗口里提交 —— D14 随后**会**抓住它（`COMMIT` 被拒），但结果是一次**拒绝**，而不是"人排队等控制环"。要让 AU1-a 那张表的第二行（控制环先提交、人工写随后生效）真的可达，取锁必须发生在**插入之前**，那正是 §7.4 EC3 在服务层做的事。因此两者的分工要写死：

- **EC3（服务层，插入前取 `FOR SHARE`）**：让"控制环先、人随后"成为一个**可达且确定**的顺序，并给拒绝一个类型化的名字与一条确定的恢复（EC4 / EC5）。
- **D14（数据库，`COMMIT` 时再证明一次）**：让"**跳过 EC3 的任何写端**（旧二进制、裸 SQL）也不可能提交一个已被撤权的上下文"成立。它是 fail closed 的兜底，不是主路径。

**两者都要有**：只有 EC3 会被下一个版本的服务层绕过（§12.4 那一格就假了），只有 D14 会把一个本该合法的顺序变成一次拒绝。

**D14-d（可测形式）**：真实 Postgres 上建 EC1 的八张表（或它们的最小投影），跑两个提交顺序 × 八个 `revokedInput`：`USER_FIRST`（人先撤权 ⇒ 控制环的插入在 `COMMIT` 被拒、`EXECUTION_CONTEXT_REVOKED: <input>`、占位数不变）、`COORDINATOR_FIRST`（控制环先取锁、插入并提交 ⇒ 人的撤权随后生效，占位合法存在且 I17 在提交那一刻为真）。**反向对照**：把触发器去掉（或把 `FOR SHARE` 换成普通读），`USER_FIRST` 立刻提交出"Agent `enabled = false` + 一条解析到它的新 Session" —— 与 v1.4 复审报告 §6 `PC-CX-29` 的那一行输出逐字对应。

**D14-h（它与 D17 的分工，v1.9 新增，PC-CX-48）**：D14 问的是"**重解析一遍**，那九个身份现在还是不是冻结的那一组"；D17 问的是"这一行上存着的两个摘要，**是不是它们各自权威输入的摘要**"。两个问题都必须有对象，理由与 D15/D16 的分工逐字同型：D14 读的是**别的行**（EC1 的八行，可能正被别人改），D17 读的**只是这一行自己**（`execution_context` 的两半），因此后者不需要锁、不需要解析链、也对任何版本的二进制成立。**只有 D14 时**（v1.5–v1.8 的状态）：写端可以插一份**内容正确、摘要伪造**的动作行 —— `execution_context_digest` 与重解析结果不等会被 D14 挡住，但 `execution_result_digest` 不进任何硬门的谓词，于是它可以是任意字符串，D11 此后忠实地把这个错值钉成不可改写（`PC-CX-48`）。**只有 D17 时**：两个摘要都与这一行自洽，但这一行冻结的那份上下文可能在提交那一刻已经被撤权。两条合起来才是 §12.4 那一格：**摘要是真的，而且它描述的那次授权在提交时还成立。**

**D14-g（它证明的是哪一个摘要，v1.7 划清边界，PC-CX-42）**：D14 比的是 **EC2-a**（授权摘要），因为那九个分量是它能在 SQL 里如实算出来的全部（D14-c）。它**不**比 EC2-b（结果摘要）—— 那需要把 PAC §7.5 的整份 `resolution` 在数据库里规范序列化一遍，D14-c 那笔"解析链改一次这里跟着改一次"的账会翻倍。结果那一半由 **D15 与 D16** 保证，而它们用的是一次**等式比较**而不是一次重解析：占位的 create 冻结列必须等于动作行 `execution_context` 的对应分量（EC6-a/b），D15 在每一条语句上验、D16 在 `COMMIT` 再验一次最终状态（D15-g / D16-d）。三者合起来给出 §12.4 那一格要的东西：**跳过服务层的任何写端既不能提交一个已被撤权的上下文（D14），也不能提交一份与冻结决策不同的结果（D15 / D16）**，而三条硬门里只有一条需要复制解析链。

#### D15 · 占位快照的 mutator 协议（v1.7 新增，v1.8 补全冻结集并冻住 lineage，PC-CX-38 / PC-CX-42 / PC-CX-44 / PC-CX-45）

D14 证明"提交那一刻这次派发还成立"，D11 证明"动作行此后不可改写"。**中间还差一条**：Session 自己那几列是谁写的、写完之后谁还能改。§4.3 I17-A 与 I17-A2 读的正是这几列，而 v1.6 之前**没有任何数据库对象**读过它们 —— 服务层写对了它们才对，这与 `PC-CX-20` / `PC-CX-25` 已经交过两次学费的形状完全相同：**一条硬门读到的每一行，都必须有一个封闭的 mutator 协议**（D9-e）。

```sql
-- 四件事，一个对象：插入时按 EC6-a 证明 create 冻结列真的来自冻结上下文；create 之后冻住它们；
-- 冻住 lineage（task_id / dispatch_origin / project_action_id）因此这条硬门的作用域不能被它保护的
-- 那一行自己关掉；claim 冻结列（model/effort）只允许按 §4.3 I17-A2 的代次一次一次地前进。
CREATE OR REPLACE FUNCTION session_execution_snapshot_guard() RETURNS trigger AS $$
DECLARE ctx jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.task_id IS NULL OR NEW.dispatch_origin <> 'COORDINATOR' THEN RETURN NEW; END IF;
    SELECT a.execution_context INTO ctx
      FROM project_action a WHERE a.id = NEW.project_action_id;
    -- EC6-a：create 冻结列必须**逐字等于**冻结上下文的对应分量。这不是一次重解析（那是 D14），
    -- 只是一次等式比较，因此它对任何版本的二进制成立、也不需要 PAC 的解析链。
    -- v1.8（PC-CX-44）：清单是 PAC §6 表里冻结时刻为 "Session create" 的**每一行**，v1.7 漏了
    -- 最后三行，而 `permissionMode` 与 `resolution` 恰好都在 EC2-b 里（EC2-b 第 ① ③ 部分）。
    IF ctx IS NULL
       OR NEW.agent_id            IS DISTINCT FROM ctx->>'agentId'
       OR NEW.workspace_id        IS DISTINCT FROM ctx->>'workspaceId'
       OR NEW.assigned_runner_id  IS DISTINCT FROM ctx->>'assignedRunnerId'
       OR NEW.provider            IS DISTINCT FROM ctx->>'provider'
       OR NEW.provider_builtin    IS DISTINCT FROM (ctx->>'providerBuiltin')::boolean
       OR to_jsonb(NEW.required_capabilities) IS DISTINCT FROM ctx->'requiredCapabilities'
       OR NEW.permission_mode     IS DISTINCT FROM ctx->>'permissionMode'
       OR NEW.resolution          IS DISTINCT FROM ctx->'resolution'
       OR NEW.snapshot_frozen_at  IS DISTINCT FROM (ctx->>'snapshotFrozenAt')::timestamptz THEN
      RAISE EXCEPTION 'EXECUTION_SNAPSHOT_MISMATCH: session % does not carry the frozen execution context of action %',
        NEW.id, NEW.project_action_id;
    END IF;
    -- EC6-c：claim 冻结列此刻必须还没有值，代次必须从 0 起。
    IF NEW.model IS NOT NULL OR NEW.effort IS NOT NULL OR NEW.execution_pin_generation <> 0 THEN
      RAISE EXCEPTION 'EXECUTION_SNAPSHOT_MISMATCH: session % materializes claim-frozen columns at create', NEW.id;
    END IF;
    RETURN NEW;
  END IF;

  -- v1.8（PC-CX-45）：UPDATE 的作用域读 OLD **和** NEW。v1.7 只读 NEW，于是一条
  -- `SET task_id = NULL, dispatch_origin = 'USER', project_action_id = NULL` 会在第一句就被放过。
  IF (OLD.task_id IS NULL OR OLD.dispatch_origin <> 'COORDINATOR')
     AND (NEW.task_id IS NULL OR NEW.dispatch_origin <> 'COORDINATOR') THEN RETURN NEW; END IF;

  -- UPDATE：lineage 与 create 冻结列一律不可改（PAC §6 "只读" 与 D15-f 的可执行形式）。
  IF NEW.task_id            IS DISTINCT FROM OLD.task_id
     OR NEW.dispatch_origin IS DISTINCT FROM OLD.dispatch_origin
     OR NEW.project_action_id IS DISTINCT FROM OLD.project_action_id
     OR NEW.agent_id        IS DISTINCT FROM OLD.agent_id
     OR NEW.workspace_id    IS DISTINCT FROM OLD.workspace_id
     OR NEW.assigned_runner_id IS DISTINCT FROM OLD.assigned_runner_id
     OR NEW.provider        IS DISTINCT FROM OLD.provider
     OR NEW.provider_builtin IS DISTINCT FROM OLD.provider_builtin
     OR NEW.required_capabilities IS DISTINCT FROM OLD.required_capabilities
     OR NEW.permission_mode IS DISTINCT FROM OLD.permission_mode
     OR NEW.resolution      IS DISTINCT FROM OLD.resolution
     OR NEW.snapshot_frozen_at IS DISTINCT FROM OLD.snapshot_frozen_at THEN
    RAISE EXCEPTION 'EXECUTION_SNAPSHOT_FROZEN: session % cannot rewrite a create-frozen or lineage column', OLD.id;
  END IF;
  -- claim 冻结列：改一次，代次就必须恰好 +1；代次不得回退，也不得空转。
  IF NEW.model IS DISTINCT FROM OLD.model OR NEW.effort IS DISTINCT FROM OLD.effort THEN
    IF NEW.execution_pin_generation <> OLD.execution_pin_generation + 1 THEN
      RAISE EXCEPTION 'EXECUTION_PIN_GENERATION: session % rewrote model/effort without advancing the generation', OLD.id;
    END IF;
  ELSIF NEW.execution_pin_generation IS DISTINCT FROM OLD.execution_pin_generation THEN
    RAISE EXCEPTION 'EXECUTION_PIN_GENERATION: session % advanced the generation without rewriting anything', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER session_execution_snapshot_guard
  BEFORE INSERT OR UPDATE ON session
  FOR EACH ROW EXECUTE FUNCTION session_execution_snapshot_guard();
```

**D15-a（它只管 COORDINATOR 占位，v1.8 改述作用域，PC-CX-45）**：`USER` / `LEGACY_SWEEP` 与没有 `task_id` 的 Session 照常放过 —— 它们没有冻结上下文可比，既有路径**逐字节不变**（与 D6 的同一条纪律）。但"是不是 COORDINATOR 占位"这个判断在 `UPDATE` 上**必须同时读 OLD 与 NEW**：v1.7 的第一句只读 NEW，而它读的那几列正是这条 Session 自己可以在同一句里改掉的那几列。**一条按 NEW 决定作用域的硬门，等于把开关交给了被它管的那一行。**

**D15-b（为什么是 `BEFORE`，不是可延迟约束触发器）**：它比较的两样东西**都在本事务里已经写完**（动作行在 §8.3 的第一步插入，Session 在第二步插入），因此不需要等到 `COMMIT`；而 `BEFORE INSERT` 让错误发生在**那一条语句**上，调用方能把它映射成一个有类型的失败。D14 必须可延迟是因为它要读**别的事务**可能正在改的行（D14-e），D15 不读那些行。

**D15-c（它让 I17-A / I17-A2 由构造成立）**：I17-A 的等式在插入时被强制，两侧此后都不可改写（Session 侧由本条的 `UPDATE` 分支、动作行侧由 D11），因此它在**任何已提交状态**上成立；I17-A2 的三个阶段由 `execution_pin_generation` 表达，而这一列只能按 +1 前进并且**必须**与一次真实改写同时发生，因此"代次说了几次、记录就有几条"两个方向都被钉住。**代次只增不减**，这与 §8.2 GE1 是同一条纪律。

**D15-d（它不阻止什么）**：不影响 `status` / `end_reason` / 心跳列 / `result` 等任何**不在** PAC §6 冻结表里的列（那些列每一次 turn 都在写）；不影响 resume / reclaim（PAC §6 S2 本来就禁止它们重新推导快照列）；不影响 `retiredPin` 本身 —— 它照常改一次 `model`，只是必须同时把代次 +1 并留下记录，**这正是它与一次静默改写的全部区别**。

**D15-f（lineage 为什么必须冻，v1.8 新增，PC-CX-45）**：`task_id` / `dispatch_origin` / `project_action_id` 三列同时是**三处谓词的输入**：D5 partial unique index 的谓词列（`task_id`）、D6 / D9 / D14 / D15 的作用域列（`task_id` + `dispatch_origin`）、以及 I11 与 I17-A 的连接列（`project_action_id`）。v1.7 只冻了第三列。于是**一条 UPDATE 就够**：把一条已合法提交、仍在 `PENDING` 的 COORDINATOR 占位改成 `task_id = NULL, dispatch_origin = 'USER', project_action_id = NULL`，D9 / D14 / D15 按 NEW 全部退出、`session_action_only_for_coordinator_chk` 也成立、D5 的索引因为 `task_id IS NULL` 不再覆盖这一行 —— **claim 被释放，而那次执行还在跑**。随后同一个 Task 的第二条 live Session 合法提交：真实 PostgreSQL 上观察为 `{live_rows: 2, task_claims: 1, orphaned_actions: 1}`，第一条动作仍是 `APPLIED` 且 `result_session_id = s1`，而 s1 已经不再反向指向它。**D5 是一条索引，它只能看见谓词列现在的值**；谁把行写出索引覆盖集、那次执行是不是还活着，它一概不知道。v1.8 的答案与 D10 逐字同型：**给被读的那几列一个封闭的 mutator 协议**，最小且足够的协议是在 COORDINATOR 占位上冻结它们。释放 claim 因此只剩契约本来就定义的那一条路 —— 改 `status`（跑完、失败、取消，或按 §11.2 停在 `AWAITING_INPUT`），而那条路上 Session 与它的动作行始终互相指着。

**D15-g（它与提交点的分工，v1.8 新增，PC-CX-44）**：本条是 `BEFORE`，它证明的是**每一条语句**都不越界。它证明不了"**提交时**这条 Session 的结果仍然等于动作冻结的结果" —— 那要求读本事务的最终状态，而 `BEFORE` 触发器在语句中途执行（D15-b）。两件事都要有，理由与 EC3 / D14 的分工逐字相同：`BEFORE` 让错误落在**那一条语句**上、可以映射成一个有类型的失败，提交点让**任何语句顺序**下的最终状态都被验一次。提交点那一半是 **D16**。

**D15-e（可测形式）**：真实 Postgres 上跑**三阶段**加四个反例：`INSERT` 一条 create 冻结列等于冻结上下文、`model/effort` 为 NULL、代次为 0 的占位（过）；首次 claim 写 `model` 并把代次置 1（过），断言 I17-A2 的第 1 行；一次 `retiredPin` 写新 `model` 并把代次置 2（过），断言第 3 行。反例：create 冻结列与冻结上下文差一个分量（拒，`EXECUTION_SNAPSHOT_MISMATCH`）、create 时就带 `model`（拒）、`UPDATE` 改 `provider`（拒，`EXECUTION_SNAPSHOT_FROZEN`）、改 `model` 而不动代次（拒，`EXECUTION_PIN_GENERATION`）。**反向对照**：把本触发器去掉，同一份 `INSERT` 把一条 provider 与冻结上下文不同的占位提交进去，I17-A 的零行查询立刻返回 1 行 —— 与复审报告 §6 `PC-CX-38` / `PC-CX-42` 描述的两个合法结果逐字对应。

#### D16 · 结果与 pin 账本的提交时证明（v1.8 新增，v1.9 把账本从"数条数"改成"验语义并折叠成链"，PC-CX-44 / PC-CX-46 / PC-CX-47 / PC-CX-49）

D15 是 `BEFORE`，它管每一条语句；D14 是可延迟的，但它按 D14-g 只比 **EC2-a**。**还差两件事，而且都只能在提交点问**：

1. **提交时** Session 的实际结果是否仍然等于动作行冻结的那一份（EC2-b 的第 ① ③ 部分）。D15 在 `INSERT` 那一条语句上证明过一次，可那之后本事务还能再写 —— §8.3 的第 4 步就是一条 `UPDATE project_action`，它现在由 D11-f 冻住，但"Session 与动作行的哪一侧被改"不该由**列举写端**来回答，该由**最终状态**来回答。
2. `session.execution_pin_generation` 与动作行 `detail` 上那本账（`claimResolution` + `retiredPins[]`）是否**双向**一一对应（§4.3 I17-A2）。这两样分别落在两张表上：代次归 D15 管，`detail` 是 D11-b 放开的两列之一。**任何一条只看单侧的规则都证明不了"代次说了几次、记录就有几条"** —— v1.7 的 D15 SQL 从未读过 `detail`，真实 PostgreSQL 因此接受 `generation = 2` 而 `retiredPins` 为 0 的已提交状态。
3. **v1.9（`PC-CX-47` / `PC-CX-49`）：这本账**记的是不是**这次 claim**。v1.8 的两条函数只问"有没有对象、是不是 `n − 1` 条"，于是 `claimResolution = {}` 与 `retiredPins = [{}]` 通过全部硬门：一条冻结成 `model-v1/high` 的决策可以合法地配上一条实际跑 `model-evil/low` 的 Session（`PC-CX-47`），而那本账说不出旧值、新值、时刻与责任（`PC-CX-49`）。**"账上有一行"与"账记对了"是两件事**，这与 `PC-CX-48` 的"钉住一个错的摘要不等于证明它对"是同一句话的两处。因此提交点还要问：账本的每一条是不是 §7.4 EC6-c 的闭合形状、整条链是不是按 EC6-e 折叠得回 `session.model` / `session.effort`。

```sql
-- ⓪ 两侧共用的那一次判定。账本的语义只能有**一份**定义，因此它是一个函数、两条触发器各调用一次 ——
--    两份手写副本会分头长大，那正是 PC-CX-37 / PC-CX-44 连着两轮的形状。它按 §7.4 EC6-c 的闭合形状
--    逐字段验、按 EC6-e 把整条链折叠一遍，返回折叠出来的那一对 pin；形状、链、代次或时刻错了一律以
--    EXECUTION_PIN_LEDGER 拒绝。v1.9（PC-CX-47 / PC-CX-49）。
CREATE OR REPLACE FUNCTION coordinator_pin_ledger_fold(
  subject text, ctx jsonb, claim jsonb, ledger jsonb, generation bigint) RETURNS jsonb AS $$
DECLARE iso constant text := '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$';
        pin jsonb := '{}'::jsonb; part jsonb; entry jsonb; component text;
        moment timestamptz; previous timestamptz; frozen_at timestamptz; k int := 0;
BEGIN
  ledger := COALESCE(ledger, '[]'::jsonb);
  IF generation = 0 THEN
    IF claim IS NOT NULL OR jsonb_array_length(ledger) <> 0 THEN
      RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: % is at generation 0 but a claim is already recorded', subject;
    END IF;
    RETURN NULL;                                   -- 代次 0：没有链，也不该有任何一行账
  END IF;

  -- EC6-c 第 2、3 行：claimResolution 的闭合形状，以及它与冻结上下文的逐字段绑定。
  IF claim IS NULL OR jsonb_typeof(claim) <> 'object'
     OR (SELECT array_agg(t.k ORDER BY t.k COLLATE "C") FROM jsonb_object_keys(claim) AS t(k))
        IS DISTINCT FROM ARRAY['at','effort','generation','model'] THEN
    RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: % records no first claim of EC6-c''s closed shape', subject;
  END IF;
  previous  := CASE WHEN claim->>'at' ~ iso THEN (claim->>'at')::timestamptz END;
  frozen_at := CASE WHEN ctx->>'snapshotFrozenAt' ~ iso THEN (ctx->>'snapshotFrozenAt')::timestamptz END;
  IF claim->'generation' IS DISTINCT FROM to_jsonb(1) OR previous IS NULL
     OR frozen_at IS NULL OR previous < frozen_at THEN
    RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: % records a first claim with no generation 1 or no valid moment', subject;
  END IF;
  FOREACH component IN ARRAY ARRAY['model','effort'] LOOP
    part := claim -> component;
    IF part IS NULL OR jsonb_typeof(part) <> 'object'
       OR (SELECT array_agg(t.k ORDER BY t.k COLLATE "C") FROM jsonb_object_keys(part) AS t(k))
          IS DISTINCT FROM ARRAY['frozen','source','value'] THEN
      RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: % records % without frozen/value/source', subject, component;
    END IF;
    IF part->>'frozen' IS DISTINCT FROM ctx->>component THEN     -- 逐字，因此记的只能是这次派发
      RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: % claims a frozen % of % while the action froze %',
        subject, component, COALESCE(part->>'frozen','NULL'), COALESCE(ctx->>component,'NULL');
    END IF;
    IF part->>'frozen' = 'DEFERRED_TO_CLAIM' THEN                -- 延后那一支：必须原子记下实际解析结果
      IF part->>'source' IS DISTINCT FROM 'RESOLVED_AT_CLAIM'
         OR COALESCE(part->>'value','') = '' OR part->>'value' = 'DEFERRED_TO_CLAIM' THEN
        RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: % defers % to claim but records no resolved value', subject, component;
      END IF;
    ELSIF part->>'source' IS DISTINCT FROM 'FROZEN_CONTEXT'      -- 具体值那一支：只能是冻结的那一个
       OR part->>'value' IS DISTINCT FROM part->>'frozen' THEN
      RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: % records a % other than the concrete value the action froze',
        subject, component;
    END IF;
    pin := pin || jsonb_build_object(component, part->>'value');
  END LOOP;

  -- EC6-c 第 4 行 + EC6-e：条数、代次、连续链与单调时刻，一条一条折叠过去。
  IF jsonb_array_length(ledger) <> generation - 1 THEN
    RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: % is at generation % but records % retired pins',
      subject, generation, jsonb_array_length(ledger);
  END IF;
  FOR entry IN SELECT t.v FROM jsonb_array_elements(ledger) AS t(v) LOOP
    k := k + 1;
    IF jsonb_typeof(entry) <> 'object'
       OR (SELECT array_agg(t.k ORDER BY t.k COLLATE "C") FROM jsonb_object_keys(entry) AS t(k))
          IS DISTINCT FROM ARRAY['at','component','from','generation','reason','to'] THEN
      RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: % retiredPins[%] is not EC6-c''s closed record', subject, k - 1;
    END IF;
    component := entry->>'component';
    moment    := CASE WHEN entry->>'at' ~ iso THEN (entry->>'at')::timestamptz END;
    IF component IS NULL OR component NOT IN ('model','effort')
       OR entry->>'reason' IS DISTINCT FROM 'RUNTIME_RETIRED'
       OR entry->'generation' IS DISTINCT FROM to_jsonb(k + 1)
       OR moment IS NULL OR moment < previous
       OR entry->>'from' IS DISTINCT FROM pin->>component
       OR COALESCE(entry->>'to','') = '' OR entry->>'to' = entry->>'from' THEN
      RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: % retiredPins[%] does not continue the chain (component=%, from=%, current=%)',
        subject, k - 1, COALESCE(component,'NULL'), COALESCE(entry->>'from','NULL'),
        COALESCE(pin->>COALESCE(component,'model'),'NULL');
    END IF;
    previous := moment;
    pin := pin || jsonb_build_object(component, entry->>'to');
  END LOOP;
  RETURN pin;
END;
$$ LANGUAGE plpgsql;

-- ① Session 侧。DEFERRABLE INITIALLY DEFERRED ⇒ 在 COMMIT 那一刻执行，读到的是本事务的最终状态。
CREATE OR REPLACE FUNCTION session_execution_result_check() RETURNS trigger AS $$
DECLARE ctx jsonb; action_status text; ledger jsonb; claim jsonb; pin jsonb;
BEGIN
  IF NEW.task_id IS NULL OR NEW.dispatch_origin <> 'COORDINATOR' THEN RETURN NULL; END IF;
  SELECT a.execution_context, a.status,
         COALESCE(a.detail -> 'retiredPins', '[]'::jsonb), a.detail -> 'claimResolution'
    INTO ctx, action_status, ledger, claim
    FROM project_action a WHERE a.id = NEW.project_action_id;

  -- EC2-b 的第 ① ③ 部分，逐列相等。与 D15 的 INSERT 分支是**同一张清单**（EC6-a），
  -- 差别只在这一次读的是提交时的最终行。
  IF ctx IS NULL OR action_status <> 'APPLIED'
     OR NEW.agent_id            IS DISTINCT FROM ctx->>'agentId'
     OR NEW.workspace_id        IS DISTINCT FROM ctx->>'workspaceId'
     OR NEW.assigned_runner_id  IS DISTINCT FROM ctx->>'assignedRunnerId'
     OR NEW.provider            IS DISTINCT FROM ctx->>'provider'
     OR NEW.provider_builtin    IS DISTINCT FROM (ctx->>'providerBuiltin')::boolean
     OR to_jsonb(NEW.required_capabilities) IS DISTINCT FROM ctx->'requiredCapabilities'
     OR NEW.permission_mode     IS DISTINCT FROM ctx->>'permissionMode'
     OR NEW.resolution          IS DISTINCT FROM ctx->'resolution'
     OR NEW.snapshot_frozen_at  IS DISTINCT FROM (ctx->>'snapshotFrozenAt')::timestamptz THEN
    RAISE EXCEPTION 'EXECUTION_RESULT_MISMATCH: session % is not the frozen result of action %',
      NEW.id, NEW.project_action_id;
  END IF;

  -- EC2-b 的第 ② 部分 + I17-A2 的两个方向，同一个提交点：账本先按 ⓪ 验形状与链，
  -- 折叠出来的那一对 pin 再与这条 Session 此刻真正在跑的 model/effort 逐字比较。
  pin := coordinator_pin_ledger_fold(NEW.id, ctx, claim, ledger, NEW.execution_pin_generation);
  IF NEW.execution_pin_generation = 0 THEN
    IF NEW.model IS NOT NULL OR NEW.effort IS NOT NULL THEN
      RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: session % is at generation 0 but already carries a pin', NEW.id;
    END IF;
  ELSIF NEW.model IS DISTINCT FROM pin->>'model' OR NEW.effort IS DISTINCT FROM pin->>'effort' THEN
    RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: session % runs %/% while action % records %/%',
      NEW.id, COALESCE(NEW.model,'NULL'), COALESCE(NEW.effort,'NULL'), NEW.project_action_id,
      COALESCE(pin->>'model','NULL'), COALESCE(pin->>'effort','NULL');
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- 没有 `UPDATE OF <列表>`：一张手写的列清单正是 `PC-CX-37` 的形状，而这条要证明的恰好是
-- "最终状态对不对"，不是"谁动了哪一列"。见 D16-c。
CREATE CONSTRAINT TRIGGER session_execution_result_check
  AFTER INSERT OR UPDATE ON session
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION session_execution_result_check();

-- ② 动作侧。`detail` 是 D11-b 放开的可写列，因此账本的另一端也必须有一条同样的提交时证明 ——
--    否则"追加了记录而代次没动"这一半没有任何数据库对象在看。它调用的是**同一个** ⓪ 号函数。
CREATE OR REPLACE FUNCTION project_action_pin_ledger_check() RETURNS trigger AS $$
DECLARE generation bigint; pinned_model text; pinned_effort text; pin jsonb;
BEGIN
  IF NEW.type <> 'DISPATCH_TASK' OR NEW.result_session_id IS NULL THEN RETURN NULL; END IF;
  SELECT s.execution_pin_generation, s.model, s.effort INTO generation, pinned_model, pinned_effort
    FROM session s WHERE s.id = NEW.result_session_id AND s.dispatch_origin = 'COORDINATOR';
  IF generation IS NULL THEN RETURN NULL; END IF;      -- 没有 COORDINATOR 占位：本条无话可说
  pin := coordinator_pin_ledger_fold(NEW.id, NEW.execution_context, NEW.detail -> 'claimResolution',
           COALESCE(NEW.detail -> 'retiredPins', '[]'::jsonb), generation);
  IF generation > 0 AND (pinned_model IS DISTINCT FROM pin->>'model'
                         OR pinned_effort IS DISTINCT FROM pin->>'effort') THEN
    RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: action % records %/% while session % runs %/%',
      NEW.id, COALESCE(pin->>'model','NULL'), COALESCE(pin->>'effort','NULL'), NEW.result_session_id,
      COALESCE(pinned_model,'NULL'), COALESCE(pinned_effort,'NULL');
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER project_action_pin_ledger_check
  AFTER INSERT OR UPDATE OF detail, result_session_id ON project_action
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION project_action_pin_ledger_check();
```

**D16-a（两个方向为什么必须是两个对象）**：一次 `retiredPin` 是**两张表上的两条 `UPDATE`**。只装 Session 侧那一条，一次"只追加记录、不动代次"的写入不会让它执行（Session 那一行根本没被改），账本因此可以单方面长大；只装动作侧那一条，一次"只推进代次、不写记录"的写入同样不会让它执行。**两条都必须在，而且都必须可延迟** —— 可延迟让两条 `UPDATE` 的**先后顺序不再重要**：无论先写哪一张表，判据都落在 `COMMIT` 那一刻的最终状态上。这正是 §8.3 的语句顺序与 D9 之间已经用过一次的手法（D9-b）。

**D16-b（它让 I17-A2 由构造成立，v1.9 从条数改成语义，PC-CX-47 / PC-CX-49）**：I17-A2 的三个阶段此后**两个方向都被数据库钉住**：代次 0 ⇒ 两列为 NULL 且账本为空；代次 `n ≥ 1` ⇒ 有一条满足 §7.4 EC6-c 闭合形状的 `claimResolution`、恰好 `n − 1` 条同样闭合的 `retiredPins[]`，且**整条链按 EC6-e 折叠出来的那一对值逐字等于 `session.model` / `session.effort`**。v1.8 这里写的是"有 `claimResolution`、`retiredPins` 恰好 `n − 1` 条"，那句话把"账上有一行"当成了"账记对了" —— `claimResolution = {}` 满足它，而它描述不了任何一次 claim（`PC-CX-49`），也拦不住一条与冻结值完全不同的实际 pin（`PC-CX-47`）。合法路径一条不挡：首次 claim 在同一事务里写一条完整的 `detail.claimResolution` 并把代次置 1，`retiredPin` 在同一事务里追加一条完整的 `retiredPins[]` 并把代次 +1，两者都提交。缺账、多账、错代次、空对象、缺字段、错链、超前或落后的时刻、以及"实际 pin 与账本对不上"都在 `COMMIT` 被 `EXECUTION_PIN_LEDGER` 拒绝。

**D16-f（为什么账本的判定是一个函数而不是两段 SQL，v1.9 新增，PC-CX-47 / PC-CX-49）**：两个方向必须是两个对象（D16-a），但它们判的是**同一句话**。把那句话抄两遍，就得到一张与它保护的东西分头长大的手工副本 —— `PC-CX-37`（D11 的列 denylist）与 `PC-CX-44`（D15 的 create 冻结集）已经连着两轮为这个形状付过钱，而这一次两份副本还分别长在两条触发器里，连"它们是不是同一句话"都没有对象在看。因此 v1.9 把判定收进 ⓪ 号 `coordinator_pin_ledger_fold`：**一个函数、一份定义、两个调用点**，两条触发器只负责各自取到自己那一侧的最终状态并比较折叠结果。**它返回值而不是布尔**：返回那一对折叠出来的 pin，让两条触发器各自与自己手上的那一份实际值比较 —— Session 侧比 `NEW.model` / `NEW.effort`，动作侧比它 `result_session_id` 指向的那条 Session 的同两列。**这就是"双向"在 v1.9 里的确切含义**：不是两条规则各看一半，是同一条规则被两侧各证明一次。

**D16-c（为什么 Session 侧不带 `UPDATE OF` 列清单，代价写下来）**：`session` 的 `status` / 心跳列每一次 turn 都在写，因此这条触发器会在**每一次** COORDINATOR 占位的更新上多做一次按主键的查找与一次等式比较。这笔钱是**故意花的**：一张手写的 `UPDATE OF` 列清单必须在 PAC §6 每加一行时被记得改一次，而那正是 `PC-CX-37` / `PC-CX-44` 连着两轮的形状 —— 一张封闭集合的手工副本与它保护的那张表分头长大。**默认全覆盖、只在函数体第一句按 lineage 早退**，把"漏一列"从一个静默缺陷变成一次不可能。如果将来这条在生产上成为热点，退路是给 `session` 加一个由数据库维护的派生列做早退谓词，而**不是**回到手写列清单。

**D16-d（它与 D14 / D15 的分工，三条合起来才是 §12.4 那一格）**：D14 在提交点比 **EC2-a**（授权，需要重解析）；D16 在提交点比 **EC2-b 的结果列**（等式，不需要解析链）；D15 在每一条语句上让越界**立刻**失败并有类型。**跳过服务层的任何写端因此既不能提交一个已被撤权的上下文，也不能提交一份与冻结决策不同的结果，还不能把代次与账本写岔。**

**D16-e（可测形式）**：真实 Postgres 上，正例整条链必须提交：插 `CLAIMED` 动作 → 插与冻结上下文九个分量全等的 Session → 发布为 `APPLIED` → `COMMIT`；随后首次 claim（写 `detail.claimResolution` + 代次 1）与一次 `retiredPin`（追加 `retiredPins[0]` + 代次 2）各自提交。反例逐个断言 `COMMIT` 被拒：`permission_mode` 与冻结上下文不同（`EXECUTION_RESULT_MISMATCH`）、`resolution` 与冻结上下文不同、`snapshot_frozen_at` 与冻结上下文不同、动作停在 `CLAIMED` 没发布、代次 1 而没有 `claimResolution`（缺账）、代次 2 而 `retiredPins` 为 0（缺账）、代次 1 而 `retiredPins` 已有 1 条（多账）、代次跳到 3 而只有 1 条记录（错代次）、以及只写 `detail` 不动代次（动作侧那一条）。**v1.9 再加八个反例**（`PC-CX-47` / `PC-CX-49`，全部得到 `EXECUTION_PIN_LEDGER`）：`claimResolution = {}`；`claimResolution` 齐全但 Session 的 `model`/`effort` 不是它记的那一对（这就是 `PC-CX-47` 的原形）；`model.frozen` 与 `execution_context.model` 不同（把冻结值改写成 `DEFERRED_TO_CLAIM` 以放行任意值）；冻结值为 `DEFERRED_TO_CLAIM` 而 `value` 缺失或仍是 `DEFERRED_TO_CLAIM`（没有原子记录实际解析结果）；`retiredPins = [{}]`；`retiredPins[0].from` 接不上 `claimResolution` 的 `value`（断链）；`retiredPins[0].generation` 不是 2（代次对不上数组位置）；`retiredPins[0].at` 早于 `claimResolution.at`（时刻倒流）。**正例同样要两条**：冻结值是具体值时首次 claim 只能写那个值；冻结值是 `DEFERRED_TO_CLAIM` 时首次 claim 写下实际解析到的值并提交，两条都在同一事务里连账本一起写。**反向对照**：把两条约束触发器都去掉，同一份写入把 `{session_permission: 'danger-full-access', frozen_permission: 'read-only', resolution_equal: false}` 与 `{execution_pin_generation: 2, retired_count: 0}` 两个状态提交进去 —— 与复审报告 §6 `PC-CX-44` / `PC-CX-46` 的那两行输出逐字对应。

#### D8 · 派发权投影由数据库维护（v1.2 新增，v1.4 重写，PC-CX-09 / PC-CX-25）

D6 的触发器会在 task 行上取 `FOR SHARE`；这一条冻结**另一侧**的义务，两侧合起来才构成一个"数据库可证明的共同线性化点"。

**v1.4 为什么重写这一条**：v1.2 把义务写成"`dispatch_authority` 的三个写入点都必须走同一个服务层 primitive"。那句话有一个它自己无法承认的前提 —— **写入点全在新服务层**。一个不认识这一列的旧 apiserver 把 Task 移进一个已启用 Coordinator 的 Project（它只写 `task.project_id`），或者结束一条占位（v1.2 的第三个写入点），都不会执行那个 primitive；投影因此停在 `LEGACY`，而 D6 会**忠实地按这个陈旧值放行旧 sweep**。§12.4 与 D7-note 同时声称"混合版本的正确性由数据库约束对任何版本成立"，这一格是假的。审查记为 `PC-CX-25`，判 **P0**。

v1.4 的答案是把投影从"一个必须被正确维护的列"改成**一个数据库自己计算的派生列**：

**D8-a（唯一 primitive，v1.4 重写）**：`task.dispatch_authority` **不再由任何服务层写入**。它由两个触发器维护，因此**任何版本的二进制、任何写入路径**（包括直接 SQL）都无法让它陈旧：

```sql
-- ① 写 task 的那一侧：这一列的值永远由派生式决定，谁写都一样。
CREATE OR REPLACE FUNCTION task_dispatch_authority_projection() RETURNS trigger AS $$
DECLARE enabled boolean;
BEGIN
  IF NEW.project_id IS NULL THEN
    NEW.dispatch_authority := 'LEGACY';                     -- §12.2 的约 11 万行，逐字节不变
    RETURN NEW;
  END IF;
  -- `FOR SHARE` 与 ② 的 `UPDATE project`（自动取 FOR NO KEY UPDATE）冲突，因此本行与翻转被强制排序；
  -- 这与 D6 里那两个词是同一个理由，也同样是这一条成立的**前提**而不是谨慎。
  SELECT p.coordinator_enabled INTO enabled FROM project p WHERE p.id = NEW.project_id FOR SHARE;
  NEW.dispatch_authority := CASE WHEN enabled THEN 'COORDINATOR' ELSE 'LEGACY' END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER task_dispatch_authority_projection
  BEFORE INSERT OR UPDATE OF project_id, dispatch_authority ON task
  FOR EACH ROW EXECUTE FUNCTION task_dispatch_authority_projection();

-- ② 写 project 的那一侧：翻转 coordinator_enabled 时重算这个项目的全部 Task。
--    本事务已持有 project 行的 FOR NO KEY UPDATE（UPDATE 自动取），因此这是 LO1 的 project → task 顺序；
--    子查询按 id 升序取锁（D8-c），与批量插入 Session 的方向一致，不会成环。
CREATE OR REPLACE FUNCTION project_dispatch_authority_fanout() RETURNS trigger AS $$
BEGIN
  IF NEW.coordinator_enabled IS NOT DISTINCT FROM OLD.coordinator_enabled THEN RETURN NULL; END IF;
  UPDATE task SET dispatch_authority = dispatch_authority          -- 触发 ①，由它算出新值
   WHERE id IN (SELECT id FROM task WHERE project_id = NEW.id ORDER BY id FOR NO KEY UPDATE);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_dispatch_authority_fanout
  AFTER UPDATE OF coordinator_enabled ON project
  FOR EACH ROW EXECUTE FUNCTION project_dispatch_authority_fanout();
```

**D8-b（有占位的 Task 照常翻转，v1.4 行为变更）**：v1.2 用 `NOT EXISTS (…占位…)` **跳过**有占位的 Task，为的是让 I12 的旧写法（"占位来源与当前授权在每个瞬间都相容"）成立。那个跳过要付两笔账，第二笔是 P0：

1. 它需要一个"占位释放时补投影"的第三写入点，而那个写入点只能在**结束 Session 的那个事务**里 —— 它会在 `session`（LO1 第四级）之后再去写 `task`（第三级），是全序里唯一一处**回头取锁**；
2. 那个写入点同样在服务层，因此旧写端结束占位 ⇒ 投影永久停在 `LEGACY` ⇒ 旧 sweep 可以再派一次（`PC-CX-25` 的最小反例 B）。

v1.4 直接删掉这个跳过，代价是承认一个**有界的**中间状态：翻转发生时如果有一条占位在飞（启用时是 `LEGACY_SWEEP`，停用时是 `COORDINATOR`，**两个方向对称**），它会继续跑到结束。这**不是**一个新的越权：

- 那条 Session 是**翻转之前**合法插入的（D6 在翻转前放行），不是一次新的派发；
- 翻转**之后**的 legacy 插入在物理上不可能 —— D6 的 `FOR SHARE` 与翻转的 `FOR NO KEY UPDATE` 冲突，等锁后 EvalPlanQual 必然读到翻转后的值并拒绝（下面 D8-c/D8-d 的原论证逐字不变）；
- 控制环也不会趁机重复派发：该 Task 有占位，§7.4 第 4 条与 D5 各挡一次。

因此 I12 被拆成 I12-A（投影新鲜，由本条保证）与 I12-B（无越权**新**派发，由 D6 保证），而"永不因为一次投影变更去杀掉别人已经启动的运行"这句话**逐字保留** —— v1.2 是靠不翻转来兑现它，v1.4 是靠不干涉在飞的运行来兑现它，后者不需要任何服务层配合。

**D8-c（锁序）**：批量重算按 `task.id` **升序**取锁；一次插入多条 Session 的事务（batch execute）同样按 `task_id` 升序插入。两个方向用同一个全序，因此不会互相死锁。若仍撞上死锁，Postgres 会中止其中一个 —— 那是 fail closed，按 §8.6 LO4 有界重试。

**D8-d（隔离级别）**：本协议在 `READ COMMITTED` 下成立，靠的是"等锁后重取最新行版本"。若某个入口跑在 `REPEATABLE READ` 下，`FOR SHARE` 撞上并发更新会直接抛 `40001` 序列化失败并中止**那一个入口**的事务 —— 同样 fail closed。两种隔离级别下都不存在"读到旧授权并放行"的第三种结果。

**D8-e（触发器 ① 的锁与 LO1，v1.4 冻结）**：触发器 ① 从一次 `task` 写（LO1 第三级）里去读 `project`（第一级）并取 `FOR SHARE`，这是全序里唯一一处**由数据库代为发起**的逆序访问，必须写明白：

- **新二进制**：写 `task.project_id` 的事务按 §13.4 AE10 / §8.6 LO2 **本来就先取了那两把 project 锁**，因此触发器要的锁已在手，顺序仍是 `project → task`，不产生新的等待。
- **旧二进制**：它不取 project 锁，于是可能与一次并发的 `coordinator_enabled` 翻转成环。结果是 `40P01`，**一方被中止** —— 这正是我们要的：**fail closed，绝不 stale**。它落在 §8.6 LO4 的有界重试里，最终要么成功、要么变成一个有类型的冲突错误。
- 把 `FOR SHARE` 去掉就没有环了，代价是"翻转与新任务写入"这一对回到不可串行化：新任务读到翻转前的值、翻转的 fan-out 又看不见这条未提交的新行，投影就地陈旧 —— 也就是这条 P0 本身。**买到的是"永不陈旧"，付出的是"极少数情况下一次可见的中止"。**

**D8-note**：为什么不给 task 加一个 `authority_generation` 再做 CAS：generation 也要被读出来才能比较，而**普通读在 MVCC 下看不见未提交的写**，正是 `PC-CX-09` 本身。缺的从来不是一个版本号，是一次**冲突的锁**。加列只会让人以为问题解决了。v1.4 再补一句同型的话：缺的也从来不是"再多一个服务层写入点"，是**让这一列根本不由服务层写**。

#### D17 · 两个摘要的提交时重算（v1.9 新增，PC-CX-48）

D14 在提交点**重解析**一遍那八行、得到 EC2-a 的摘要并与冻结的那一份比较；D15 / D16 在插入点与提交点比**结果列本身**。三条合起来仍然差一件事：**这一行上存着的那两个字符串，是不是它们各自权威输入的摘要**。v1.8 的答案是"不比"，理由写在 §26.5：比列不需要在 SQL 里复制规范序列化，比标签需要。那笔账算错了一样东西 —— §4.3 I17-A 同时逐字宣称"也不存在一条这样的占位，其两个摘要与重算不等"，并把这句话的依据记在"D15 + D16，因此对任何版本的二进制成立"上。**一条被宣称恒成立、而没有任何数据库对象在看的命题，与一条没写下来的命题在数据库里是同一个东西**（这与 `PC-CX-37` 那句"一个执行了但主动放行的硬门等于一个不存在的硬门"是同一句话）。02 的第九轮复审据此判 `PC-CX-48`：插入正确的 `execution_context`、正确的 Session 与**任意伪造的** `execution_result_digest`，全部硬门放行，D11 此后忠实地把这个错值钉成不可改写，I17-A 的零行查询立刻返回一行。

v1.9 的答案不是"把 PAC §7.5 的解析链搬进 SQL"（那才是 D14-c 那笔翻倍的账，它照旧不做）。它只需要**一个规范化函数**：摘要的权威输入就在这一行上（EC2-d），重算它既不需要解析链、也不需要锁。

```sql
-- 规范化：一个与 jsonb 内部键序无关的确定序列化。对象按 C 序排键、数组保序、标量取 jsonb 的唯一文本形式。
-- 它是 EC2-a / EC2-b 里那个 `canonical` 的**唯一**定义，D14 的解析器与本条重算用的是同一个。
CREATE OR REPLACE FUNCTION coordinator_canonical_json(value jsonb) RETURNS text AS $$
DECLARE parts text[] := ARRAY[]::text[]; k text; item jsonb;
BEGIN
  IF value IS NULL THEN RETURN 'null'; END IF;
  IF jsonb_typeof(value) = 'object' THEN
    FOR k IN SELECT t.k FROM jsonb_object_keys(value) AS t(k) ORDER BY t.k COLLATE "C" LOOP
      parts := parts || (to_jsonb(k)::text || ':' || coordinator_canonical_json(value -> k));
    END LOOP;
    RETURN '{' || array_to_string(parts, ',') || '}';
  ELSIF jsonb_typeof(value) = 'array' THEN
    FOR item IN SELECT t.v FROM jsonb_array_elements(value) AS t(v) LOOP
      parts := parts || coordinator_canonical_json(item);
    END LOOP;
    RETURN '[' || array_to_string(parts, ',') || ']';
  END IF;
  RETURN value::text;                       -- string / number / boolean / null：jsonb 的标量文本已是唯一形式
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION coordinator_execution_digest(value jsonb) RETURNS text AS $$
  SELECT encode(sha256(convert_to(coordinator_canonical_json(value), 'UTF8')), 'hex');
$$ LANGUAGE sql IMMUTABLE;                  -- sha256(bytea) 是内建函数，不需要 pgcrypto

-- 提交点：两个摘要各等于自己那一半的重算值，两半共享的分量必须一致（EC2-d）。
CREATE OR REPLACE FUNCTION project_action_execution_digest_check() RETURNS trigger AS $$
DECLARE ctx jsonb; auth jsonb;
        components constant text[] := ARRAY['resolvedAgentId','projectMemberId','taskId','taskAssigneeAgentId',
          'providerSlug','model','workspaceId','runnerId','coordinatorWorkspaceId'];
BEGIN
  IF NEW.type <> 'DISPATCH_TASK' OR NEW.execution_context IS NULL THEN RETURN NULL; END IF;
  ctx  := NEW.execution_context;
  auth := ctx -> 'authorization';
  IF auth IS NULL OR jsonb_typeof(auth) <> 'object'
     OR (SELECT array_agg(t.k ORDER BY t.k COLLATE "C") FROM jsonb_object_keys(auth) AS t(k))
        IS DISTINCT FROM ARRAY(SELECT c FROM unnest(components) c ORDER BY c COLLATE "C") THEN
    RAISE EXCEPTION 'EXECUTION_DIGEST_MISMATCH: action % does not carry EC2-a''s nine authorization components', NEW.id;
  END IF;
  -- EC6-c 第 1 行：结果那一半的两个 claim 冻结分量必须是"具体值或 DEFERRED_TO_CLAIM"，不能缺、不能是 null。
  IF ctx->>'model' IS NULL OR ctx->>'effort' IS NULL THEN
    RAISE EXCEPTION 'EXECUTION_DIGEST_MISMATCH: action % freezes no model/effort conclusion', NEW.id;
  END IF;
  IF NEW.execution_context_digest IS DISTINCT FROM coordinator_execution_digest(auth) THEN
    RAISE EXCEPTION 'EXECUTION_DIGEST_MISMATCH: action % stores an execution_context_digest that is not the digest of its authorization half',
      NEW.id;
  END IF;
  IF NEW.execution_result_digest IS DISTINCT FROM coordinator_execution_digest(ctx - 'authorization') THEN
    RAISE EXCEPTION 'EXECUTION_DIGEST_MISMATCH: action % stores an execution_result_digest that is not the digest of its result half',
      NEW.id;
  END IF;
  IF auth->>'resolvedAgentId' IS DISTINCT FROM ctx->>'agentId'
     OR auth->>'workspaceId'  IS DISTINCT FROM ctx->>'workspaceId'
     OR auth->>'runnerId'     IS DISTINCT FROM ctx->>'assignedRunnerId'
     OR auth->>'providerSlug' IS DISTINCT FROM ctx->>'provider'
     OR auth->>'model'        IS DISTINCT FROM ctx->>'model'
     OR (NEW.subject_type = 'TASK' AND auth->>'taskId' IS DISTINCT FROM NEW.subject_id) THEN
    RAISE EXCEPTION 'EXECUTION_DIGEST_MISMATCH: action % authorization and result halves describe two different dispatches',
      NEW.id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER project_action_execution_digest_check
  AFTER INSERT OR UPDATE ON project_action
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION project_action_execution_digest_check();
```

**D17-a（为什么一个对象就够，而 D16 需要两个）**：D16 判的关系跨**两张表**（Session 的代次、动作行的账本），因此哪一侧被单方面写都必须有人看；本条判的两样东西**都在 `project_action` 的同一行上** —— `execution_context` 与两个摘要列。一行上的关系只需要一个对象。**这不是省事，是判据**：一条硬门需要几个对象，由它那句话的量化域跨几张表决定，不由它有几个分量决定。

**D17-b（它为什么不需要锁、也不需要解析链）**：它读的每一样都是 `NEW` 自己的列，因此既不与任何并发写冲突（不存在"看不见未提交的写"这个老坑，D8-note / `PC-CX-09`），也不必复制 PAC 的解析链。**这正是 §26.5 当时算错的那一格**：v1.8 把"数据库重算摘要"与"数据库重跑解析链"当成了同一件事，于是拿 D14-c 那笔翻倍的账否掉了一件其实很便宜的事。重算 EC2-a 的摘要**不是**重解析 EC2-a 的输入 —— 前者只问"这个字符串是不是这九个值的摘要"，后者才问"这九个值现在还成不成立"，后一半照旧归 D14（D14-h）。

**D17-c（代价，写下来以便将来重新评估）**：每一条 `DISPATCH_TASK` 动作行在 `COMMIT` 多做两次 `sha256` 与一次递归序列化，输入是一份几百字节的 jsonb。它是**每次派发一次**的开销，不在任何热路径上（对比 D16-c 那条"每一次 turn 心跳都要多做一次按主键查找"的账，本条便宜一个量级）。**规范化函数本身是 `IMMUTABLE` 的纯函数**，因此它也可以被将来的派生列或函数索引复用；退路仍是 §26.5 写过的那一条 —— 把两个摘要改成由数据库派生的生成列，那时本条退化成一条 `GENERATED ALWAYS AS` 声明，而不是被删掉。

**D17-d（它对既有路径改了什么）**：写端此后必须把 EC2-a 的九个分量作为 `execution_context.authorization` 一起冻进动作行（EC2-d），并按 EC6-c 让 `model` / `effort` 是"具体值或 `DEFERRED_TO_CLAIM`"。这**不是**新增一列（§2.4 的列数一个不变），是把一份本来就在决策里算出来、却只以摘要形式落库的东西如实写下来 —— 与 §9.6 AU2"读到了什么就记下什么"是同一条纪律。非 `DISPATCH_TASK` 的动作行、以及没有 `execution_context` 的行照常放过，既有路径**逐字节不变**。

**D17-e（可测形式）**：真实 Postgres 上先断言这个规范化真的是规范化 —— 同一份 jsonb 用**不同键序**的两条 `INSERT` 得到**同一个** `coordinator_canonical_json`，因此得到同一个摘要；再跑正例（两个摘要都由函数算出来 ⇒ 提交）与四个反例（伪造 `execution_result_digest`、伪造 `execution_context_digest`、`authorization` 少一个键、两半的 `resolvedAgentId` 不一致 ⇒ 全部 `EXECUTION_DIGEST_MISMATCH`）。**反向对照**：把这条约束触发器去掉，同一份写入把 `{execution_result_digest: 'forged-result-digest'}` 提交进去，I17-A 的零行查询立刻返回 1 行 —— 与复审报告 §6 `PC-CX-48` 的那一行输出逐字对应。

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
- **提交**：§6.2 的提交事务里必有
  ```sql
  UPDATE project_runtime SET … WHERE project_id = :p AND fencing_token = :token
  ```
  影响行数为 0 即整个事务回滚。**这是"旧回包被拒绝"的唯一实现方式**（AC9 / 单元 19）。**v1.3 修订**：v1.2 写的是"第一句永远是"，而一次 outcome 常常同时是 §13.4 AE6 的验收事实写入（`APPLY_VERIFICATION_VERDICT` 会改 Task 状态），那条路径要求先取 `project` 行锁 —— 两句"必须第一"不可能同时成立。v1.3 的唯一顺序由 §8.6 LO1 给出：**`project` → `project_runtime` → `task` → `session`**，fencing token 条件落在 `project_runtime` 那一步，且**恒在任何副作用之前**。要害不是它是不是第一句，是它在副作用之前、并且全系统只有一个取锁顺序（`PC-CX-19`）。

**F0（token 证明的是提交时的授权，v1.4 冻结，PC-CX-21）**：`fencing_token` 回答的问题恰好一个 —— **"这次提交是不是由当时的租约持有者做的"**。它**不是**一条可以对历史行永久比对的等式：每一次成功取租约都让它 +1，而上一次派发出去的 Session 通常还在飞。任何一条把"动作的 token 等于 runtime **当前** token"写成不变量的条款都会被**下一次完全正常的租约**弄假（§4.3 I11-B / §7.7 D9-e）。恒成立的写法只有单调关系 `action.fencing_token <= project_runtime.fencing_token`。

**F1**：**任何**写入控制环状态的语句都必须带 `fencing_token` 条件 —— 包括 `project_action` 的插入、blocker 的开关、审计行。少一处就是一个可以被过期持有者写脏的口子。
**F2**：**取不到租约不是错误**，不开 blocker、不记 FAIL，只记一条 `lease_contended` 的 debug 审计并安排下次唤醒。把租约竞争当失败会在滚动升级的几十秒里刷出一屏假告警。
**F3（v1.3 修订，PC-CX-19）**：**租约不得与任何其它锁互等**。既有教训明确：`merge_status` 卡 pending → takeover 409 → reclaim 无声死循环，整机排队。v1.2 把这条写成"reconcile 内部**不获取任何第二把锁**"，那句话在 v1.2 自己的条款下**不可能成立** —— §7.7 D6 的触发器要取 task 行锁、§13.4 AE6/AE7 要取 project 行锁，而它们都在 reconcile 的提交事务里。审查记为 `PC-CX-19` 的一半。

v1.3 保留这条规则要买的东西（**没有环、没有无界等待**），换掉它的实现方式：

1. reconcile **可以**取锁，但只能按 §8.6 LO1 的**唯一全序**取，且**从不升级**已持有的锁（LO3）；
2. 任何"要等一个不在 LO1 里的东西"（另一个项目的 turn、一次外部合并、一个人的答复）一律转成 `nextWakeAt`，这一半逐字不变；
3. 仍然撞上 `40P01` / `40001` 时按 LO4 有界重试，超出上限则记 `LOCK_CONTENDED` 审计并安排下次唤醒 —— **不开 blocker**（没有人需要做任何事），也不把它当未分类异常（C4）。

"不取第二把锁"与"按一个全序取锁"在**防死锁**这件事上等价，而后者是可实现的。

### 8.2 幂等键

**格式（冻结）**：`pc:v1:<projectId>:<actionType>:<scope>[:<epoch>]`

- `projectId` 用 **UUID 原文**（键是内部标识，不是对外 id；用 base62 会让同一动作在编解码变更后换身份）。
- `<epoch>` 是**只在"这件事确实是新的一次"时才前进的计数**，这是幂等键设计的全部要害：
  - `dispatch` 的 epoch = **`task.dispatch_attempt`**（v1.2；见 DA1–DA3）。v1.1 用的是 `task.failureCount`，而 §19.6 的恢复路径又要求人处理之后把失败计数**清零** —— 于是下一次派发重新算出 `…:dispatch:<taskId>:0`，撞上历史上那条早已 `APPLIED` 的动作行，被 §8.5 判为"已做过"并跳过副作用。每次 reconcile 都得到同一结果，**这个 Task 从此永远无法再被派发**。审查记为 `PC-CX-11`。
  - `turn` 的 epoch = `coordinator_generation` + 唤醒原因摘要（同一原因在同一代里只开一次 turn）。turn 的动作行是**可回收**的一类：TR3 在"上一次 turn 已结束且事实未变"时不再开 turn 而改开 blocker，因此摘要复用在这里是**期望行为**，不是 GE1 的例外（见 GE4）。
  - `blocker` 的 epoch = **`project_blocker.lifecycle_generation`**（v1.3；见 §11.3 BE1–BE3）。v1.2 写的是"blocker **没有 epoch**：同因阻塞恒为同一键"，那句话把"同一个 open 周期内的重复"与"这个 subject 一生只会坏一次"混成了一件事：blocker 被解除之后同因**复发**是一个新的故障周期，而它算出的键早已 `APPLIED`，于是 §8.5 C2 跳过副作用，最终**没有 open blocker**，项目带着一个真实存在的故障静默前进。审查记为 `PC-CX-16`。
  - `verdict` 的 epoch = **`task.verdict_revision`**（v1.3；见 §13.2 V7）。v1.2 用的是 verdict 值本身，而 V4 明确允许验证任务**重新运行**：`FAIL → 修复 → 再 FAIL` 的第二次撞上历史键，退回、缺陷子任务与下游阻断三件事一件都不发生（`PC-CX-17`）。
  - `aggregate` **不再有键**（v1.3）：聚合是对当前子状态的**重算**，v1.2 却拿"子状态摘要"当永久动作身份，于是 `DONE → OPEN → DONE` 回到旧摘要时第三次被判为已应用，父任务停在 OPEN。它的正确形状是 §13.1 AG5 的 **current-state CAS**，不进账本（`PC-CX-17`）。
  - `acceptance` 的 epoch = **`project_runtime.acceptance_attempt`**（v1.3；见 §13.4 AE11）。v1.2 只写了 `<attempt>` 三个字，快照、字段清单与本节的 epoch 列表里都没有它的来源，于是每个实现都可以自己发明一个（事件数、历史动作数、内存计数）——**没有定义的键就是没有键**（`PC-CX-17`）。
- **唯一约束**：`project_action.idempotency_key @unique`（全局唯一，不按项目分区 —— 键里已含 projectId）。

**GE1（永久动作键的代次纪律，v1.3 冻结，PC-CX-16 / PC-CX-17）**：`project_action` 的历史行**永不删除**，因此它的键空间**只增不减**。任何进入这个空间的键，其 `<epoch>` 必须来自一个**持久化、单调、任何路径都不得回退或复用**的计数：

| 动作 | 代次来源 | 落库位置 | 谁推进它 |
|---|---|---|---|
| `DISPATCH_TASK` | `task.dispatch_attempt` | `task` 行 | 动作行插入成功的同一事务（DA2） |
| `RAISE_BLOCKER` | `project_blocker.lifecycle_generation` | `project_blocker` 行 | blocker 行插入成功的同一语句（BE1） |
| `APPLY_VERIFICATION_VERDICT` | `task.verdict_revision`（验证任务自己那一行） | `task` 行 | 写入 verdict 的那一次事务（V7） |
| `RUN_PROJECT_ACCEPTANCE` | `project_runtime.acceptance_attempt` | `project_runtime` 行 | 动作行插入成功的同一事务（AE11） |
| `OPEN_COORDINATOR_TURN` | `coordinator_generation` + `reasonDigest` | `project_runtime` 行 + 快照 | 轮换（§7.5）；摘要由事实决定（TR1） |
| `ROTATE_COORDINATOR_SESSION` | `coordinator_generation + 1` | `project_runtime` 行 | 轮换事务 |
| `CLEAR_BLOCKER` | 目标 blocker 的行 id | `project_blocker` 行 | 该行一生只被解除一次 |
| `REQUEST_APPROVAL` | 被审批动作的键 | 随被审批动作 | 继承（因此自动满足本条） |
| `AGGREGATE_PARENT` | **无键**（AG5 的 CAS） | —— | —— |

**GE2（禁止把可回环事实当永久身份）**：一个**能回到旧值**的量 —— verdict、子状态摘要、条件摘要、失败计数、状态枚举 —— **不得**单独充当永久动作键的 `<epoch>`。判据是一句可测的话：**把世界从 A 变到 B 再变回 A，动作键必须与第一次不同**，否则第二次 A 上的动作会被 §8.5 C2 静默跳过。v1.2 的 blocker / verdict / aggregate 三个键各违反这一条一次。

**GE3（摘要仍然有用，但用在别处）**：摘要回答"这次的事实和上次一样吗"，代次回答"这是第几次"。两者都需要，但**不能互相顶替**：`acceptanceDigest` 判证据是否仍成立（AE1），`condition_version` 判 blocker 条件是否变了（TF2），`reasonDigest` 判是否值得再开一次 turn（TR1）—— 它们都不是永久身份。

**GE4（唯一的例外，且它是刻意的）**：`OPEN_COORDINATOR_TURN` 的键含 `reasonDigest`，因此事实回环时它**会**撞历史键 —— 这正是 §7.6 TR3 要的：同一代里同一原因的 turn 已经开过且没解决，第二次不该再开一个 turn，该开 `COORDINATOR_NO_PROGRESS`。**冲突在这里有明确定义的后果**，而 GE2 禁止的是冲突**没有**后果的那种情形。契约测试逐行核对 GE1 的表：除 `AGGREGATE_PARENT`（无键）与 `OPEN_COORDINATOR_TURN`（本条）外，每个键的代次都必须落在一个 schema 里存在的持久化列上。

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
  -- v1.3：若本次 outcome 含 §13.4 AE6 的验收事实写入（`APPLY_VERIFICATION_VERDICT` 会改 Task 状态），
  -- 则第一句是 `SELECT 1 FROM project WHERE id = :p FOR NO KEY UPDATE`（§8.6 LO1 的第一级）；
  -- 下面这条紧随其后。顺序由 LO1 决定，fencing token 条件恒在任何副作用之前。
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
| blocker 代次 | `project_blocker_episode_idx` | 同一 `(project, dedupeKey)` 上这个生命周期代次已存在（§11.3 BE1，v1.3） |

**C1（冻结）**：这三类写入**一律**用 `INSERT … ON CONFLICT … DO NOTHING RETURNING id`，**禁止**用"插入 + 捕获唯一约束异常"实现。理由是 Postgres 的语义而不是风格偏好：`INSERT` 抛出的唯一约束错误会把**整个事务**置为 aborted 状态，此后任何语句都只会得到 `current transaction is aborted`，于是"继续提交其余 outcome"在物理上不可能。C1 是把冲突从**异常**降级成**返回值**，只有这样"同一事务里继续走"才成立。

**C2（冻结）**：`RETURNING` 返回 0 行时的处理是确定的，且**永远不回滚**：

1. 在同一事务里读出既有的那一行（动作 / Session / blocker）。
2. 把它当作**已应用的输入**：本次 outcome 的对应条目记 `status = ALREADY_APPLIED`（动作已存在）或 `SUPERSEDED`（占位被别人拿走），带上既有行的 id 与 `refusal_code`。
3. **跳过对应的副作用**（不再插第二条 Session、不再投第二条消息）。
4. **继续提交 outcome 的全部其余部分** —— `blockersOpened` / `blockersCleared` / `project_decision` / `nextWakeAt` / `project_event.consumed_at` 一个都不能少。

**C6（撤权不是冲突，但走同一个形状，v1.4 新增，v1.5 加一个码，PC-CX-26 / PC-CX-29）**：§9.6 AU1 的复核判定一个动作"此刻已不被允许"时，它**不是**一次唯一约束冲突，但处理方式与 C2 逐字相同：该动作记 `status = REFUSED`、`refusal_code = AUTHORITY_REVOKED`（策略侧）或 `EXECUTION_CONTEXT_REVOKED`（执行上下文侧，`detail.revokedInput` 见 §7.4 EC4），**跳过它的副作用**，outcome 的其余部分（blocker、审计行、`nextWakeAt`、`consumed_at`）一个不少地提交。理由与 C2 一样：把它做成回滚会让本次一同要提交的事件消费丢掉，控制环在这条事件上活锁 —— 那正是 `PC-CX-04`，只是触发它的从"键冲突"换成了"人改了主意"。

**C3（唯一的合法回滚）**：整事务回滚的合法原因**恰好一个** —— §8.1 的 fencing token 条件影响 0 行，即本实例已被接管。此时回滚是对的：接管者持有更大的 token，它会重新 reconcile 同一份事实，而本实例什么都不该留下。

**C4（未分类异常，fail closed 但不活锁）**：C1 覆盖之外的任何异常都会 abort 事务，因此**不可能**在同一事务里补救。处理方式冻结为：

1. 让该事务回滚（事件因此**保持未消费**，`attempts += 1`、`next_attempt_at` 按 §5.4 退避）；
2. 另开一个**小事务**，同样带 fencing token 条件，开一条 `UNKNOWN_FAILURE` blocker（BL2 / F21），并写一条 `reconcile_failed` 审计行；
3. 第 2 步本身失败（例如 token 已失效）则什么都不做 —— 接管者会看到同一份事实。

这条与 §5.4 的"连续失败 10 次进 `DEAD` 且开 `UNKNOWN_FAILURE`"（F22）串在一起：单次失败退避重试，持续失败变成一个有责任人的 blocker，**都不会**变成一条永远消费不掉的事件。

**C5（可测形式）**：`PC-CX-04` 的最小反例必须被逐条断言，而不是只数 Session 条数 —— 预置动作 K，再提交一份**同时**包含 K、一条新事件 E、一次 blocker clear 和一次 `nextWakeAt` 变更的 outcome；提交后 E 必须 `consumed_at IS NOT NULL`、blocker 必须已 resolved、`nextWakeAt` 必须已前移、`project_action` 中 K 仍恰好一行。

### 8.6 锁序与有界重试（v1.3 新增，PC-CX-19）

v1.2 分三处各自加了一把锁（D6 的 task `FOR SHARE`、D8 的 task `FOR NO KEY UPDATE`、AE6/AE7 的 project `FOR SHARE`/`FOR UPDATE`），但**没有一处说它们之间的顺序**，而 §8.1 F3 又同时宣称 reconcile 不取第二把锁。两个后果都在真实 Postgres 上复现过：AE6 的 `FOR SHARE` 之后 AE8 要 `UPDATE` 同一行，两个验收事实写入者因此在**锁升级**上互等，一方拿到 `40P01 deadlock detected`；而契约对这个错误码没有任何处置规定，它会以一个未分类的 500 落到点了"改标题"的用户脸上。审查记为 `PC-CX-19`。

**LO1（唯一全序，冻结）**：本项目的**每一个**事务，取锁顺序恒为

> **`project`（按 id 升序） → `project_runtime`（同一 project） → `task`（按 id 升序） → `session`（按 id 升序）**

一个事务可以只取其中一段（只写 `coordinator_enabled` 的翻转就从第一级开始、由触发器带到第三级），但**不得跳回去**：已经取过 `task` 的事务不得再去取 `project`。**v1.5 把 §7.4 EC3 读的那几张表插进同一条链（PC-CX-29）**：`project_member` 与 `agent` 落在 `project_runtime` 与 `task` **之间**，`project_workspace` / `workspace` 与 `runner` 落在 `task` 与 `session` **之间**，各表内按 id 升序，**全部 `FOR SHARE` 且绝不升级**（LO3）。链只是变长了，方向一个字没改；人工侧的每一次撤权都只写**一行**（`UPDATE agent SET enabled = false` 之类），构不成环。**v1.4 起，含任何被 §9.2 门控的动作的 reconcile 提交事务同样从第一级开始**（§9.6 AU1），因此它与验收事实写入者、与人工策略写入者共用同一把 `project` 行锁，顺序不变。唯一一处由数据库代为发起的逆序访问是 §7.7 D8-e 的投影触发器，那一处的边界与代价在 D8-e 里逐条写明。这条是防死锁的全部依据 —— 环只可能出现在两个事务以相反顺序取同两把锁时，而全序把这种可能性从系统里删掉了。

**LO2（跨 Project）**：一次事务涉及两个 Project（唯一的情形是 §13.4 AE10 的 Task 跨 Project 移动）时，**两个 `project` 行按 id 升序先后取满**，然后才往下走。反向移动（B→A）因此与正向移动（A→B）取同一顺序，两个方向并发不会成环。

**LO3（不升级，冻结）**：**任何事务都不得先取一把弱锁再升级成强锁**。因此 §13.4 AE6 的验收事实写入者一开始就取 `FOR NO KEY UPDATE`（它随时可能要执行 AE8 的 `UPDATE`），而不是 v1.2 的 `FOR SHARE`。代价是同一 Project 的验收事实写入之间**会排队**；买到的是"两个写入者互等升级"这种死锁在构造上不存在。`FOR NO KEY UPDATE` 与外键检查用的 `FOR KEY SHARE` 不冲突，因此**引用这个 project 的其它写入不受影响**，排队只发生在验收事实写入者之间。

**LO4（有界重试，冻结）**：全序之外仍有两类可序列化失败会到达应用层 —— 触发器与索引维护造成的隐式加锁顺序（`40P01`）、`REPEATABLE READ` 下的序列化冲突（`40001`）。处置方式冻结为：

1. **最多重试 3 次**（共 4 次尝试），间隔 `50ms · 2^n` 加 ±25% 抖动，**每次重试都必须重新读快照**（旧快照已经不成立了）；
2. 4 次都失败 ⇒ 对用户入口返回一个**有类型的**冲突错误 `PROJECT_FACT_WRITE_CONTENDED`（可重试），**绝不是**未分类 500；对控制环入口记一条 `LOCK_CONTENDED` 审计行并安排 `nextWakeAt = evaluation.epoch + 5s`（v1.7 起同样只读冻结的那个时钟，§10.4 W5 第 3 条），不开 blocker；
3. 重试计数与最终结果都落 `project_decision.detail`，因为"这个项目锁竞争严重"是一个需要能被观测到的事实，而不是一串偶发错误日志。

**LO5（可测形式）**：真实 Postgres 上跑**两个与三个**并发的验收事实写入者（每个都按 AE6-a 取锁、按 AE8 重开），断言**没有任何一个连接以 `40P01` 结束**、每个入口要么成功要么得到 `PROJECT_FACT_WRITE_CONTENDED`；与 `DONE` 硬门的配对由 §13.4 AE7 那一侧的双事务测试覆盖（两个 mutator × 两个提交顺序，断言 I10）。**反向对照**：把 AE6 换回 v1.2 的 `FOR SHARE`（只改这两个词），同一交错在真实服务器上立刻产出 `40P01`。

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

**P4（矩阵在提交点再走一遍，v1.4 新增，PC-CX-26）**：本矩阵在 §6.3 第 4 步按快照求值一次，在第 8a 步按 project 行锁之后重读的那一行**再求值一次**（§9.6 AU1）。两次不一致时以第二次为准：被撤销的动作记 `REFUSED` / `refusal_code = AUTHORITY_REVOKED`，outcome 其余部分照常提交。**只有第二次是门，第一次只是为了不白跑。**

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

- `maxConcurrentTasks`：本项目同时在飞的 Session 上限（不含 Coordinator Session 本身）。**v1.4 冻结：它是一个对全部入口成立的硬上限**，见 §9.6 CAP1。
- `sessionBudgetPerDay`：滚动 24h 内**由控制环发起**的 Session 数上限。用户手动发起的不计入。

**两个上限的恢复方式不同，因此持久化形式也不同（v1.1 修订，PC-CX-05）**：

| 上限 | 靠什么恢复 | 持久化 | `run_state` |
|---|---|---|---|
| `maxConcurrentTasks` | **事件**：任何一条在飞 Session 结束都会发 `session.ended`（§5.3） | 一条写明理由的 `NOOP` 审计行 + `nextWakeAt = evaluation.epoch + 60s`（§10.4 第 4 条兜底）。**不开 blocker** —— 没有任何人需要做任何事，控制环也没有停 | `EXECUTING` |
| `sessionBudgetPerDay` | **时间**：最早一条计入记录滚出 24h 窗口 | `BUDGET_EXHAUSTED` blocker，`owner = SYSTEM`、`recovery = TIME`、`nextCheckAt` = 该窗口边界 | `BLOCKED` |

v1 把 `BUDGET_EXHAUSTED` 的 owner 写成 `USER`。那是一处**内部矛盾**：§4.1 在 `BLOCKED` 一行里就把"预算耗尽"列为"机器可能自行恢复"的例子，而 `owner = USER` 经 I4a 会把状态判成 `AWAITING_HUMAN`，再经 v1 §10.4 把 `nextWakeAt` 置为 `NULL` —— 于是一个**只需要等 6 小时**的预算窗口变成了一个**永远等不到人**的死等，没有任何定时器会去解除它。审查记为 `PC-CX-05`。v1.1 按 §4.1 自己的话把它改回 `SYSTEM` / `TIME`。

**用户想抬预算怎么办**：走升级（§11.5）。`BUDGET_EXHAUSTED` **持续存在超过 30 分钟**时按 ES3 **一步**升级到 `USER`，届时 `run_state` 才转 `AWAITING_HUMAN`。"这一次窗口满了" 和 "这个项目的预算长期不够" 是两件事，用同一条 blocker 的两个阶段表达，而不是用两个 owner 值猜。

**v1.3 修订（PC-CX-15）**：本段在 v1.2 里还留着两句与 §11.5 直接冲突的旧文 —— `occurrences > 10` 这个**投递次数**阈值，和 `SYSTEM → COORDINATOR → USER` 这条三级阶梯。前者让"同一个 Provider 一直不可用"这件事的责任人取决于事件被投递了几次（投 1 次是 `SYSTEM`/`BLOCKED`/0 条通知，投 11 次变成 `USER`/`AWAITING_HUMAN`/1 条通知），后者与 ES3 冻结的"恰好一步"正面矛盾。两句都已删除：**升级的唯一触发是条件的存活时长**（ES4），**升级的唯一目标是 `USER`**（ES3）。

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
| 同上，但项目里另有 Task 的 Session 在飞 | `EXECUTING`（守卫 5） | `min(退避到期, evaluation.epoch + 60s)` | 同上 |
| `failureCount ≥ MAX` ⇒ `TEST_FAILED`（`USER`/`HUMAN`） | `AWAITING_HUMAN`（守卫 2） | 升级到期时刻 | blocker |

v1.1 的 §19 汇总表把退避期的权威状态直接写成 `EXECUTING`，那是把"某个 Task 的贡献"误当成了"项目的状态"：在只有一个失败任务的最小场景里守卫 5 根本不成立，`runStateOf` 只能返回 `PLANNING`，于是同一个场景在两处得到两个答案（`PC-CX-11` 的后半）。**汇总表不是状态的来源，`runStateOf` 才是**；§20.3 的断言逐行核对这张表。

### 9.6 人工撤权、并发上限与派发的共同门（v1.4 新增，PC-CX-26）

§9.2 的矩阵、§7.4 的第 6/7 条与 §9.4 的两个上限**全部只在快照上被读过一次**，而一次 reconcile 的唯一提交条件是 §8.1 F1 的 fencing token。用户改 `coordinatorEnabled` / `automationPolicy` / `maxConcurrentTasks` / `sessionBudgetPerDay` **不推进 token**，人工"开始执行"也不推进它。于是两件事都能发生，而且都留下一个说不清是谁越权的已提交状态：

- **反例 A（撤权后仍派发）**：控制环在 `AUTO` 快照上决定派发；用户随后提交 `coordinatorEnabled = false` 或 `AUTO → MANUAL`；控制环的 token 仍然有效，Session 照常插入。最终状态是"**自动化已被关掉 + 一条关掉之后由控制环创建的 Session**"。
- **反例 B（并发上限被越过）**：快照 `inFlight = 0`、`max = 1`。用户手动启动 Task B，控制环同时派 Task A。D5 是 **per-Task** 的唯一索引，两个 Task 的键不同，两边都成功 ⇒ `inFlight = 2`。

审查记为 `PC-CX-26`。两个反例是同一个缺口：**没有一个所有入口都必然经过的、project 级的线性化点。** token 是 reconcile 之间的锁，不是 reconcile 与人之间的锁。

**AU1（授权复核门，冻结）**：任何 outcome，只要它含有**至少一个被 §9.2 门控的动作**（即不是 `SCHEDULE_WAKE` / `NOOP` / `RAISE_BLOCKER` / `CLEAR_BLOCKER` / `AGGREGATE_PARENT` 这五个三策略全 ✔ 的行），其提交事务的**第一句**必须是

```sql
SELECT coordinator_enabled, automation_policy, max_concurrent_tasks, session_budget_per_day, config_revision
  FROM project WHERE id = :p FOR NO KEY UPDATE;
```

锁到手之后（这是一条**新语句**，`READ COMMITTED` 取新快照）用**读回来的这一行**重跑 §9.2 与 §7.4 的**第 6、7、8 条**：第 6、7 条按读回来的四个策略字段判，第 8 条按 §7.4 EC3 在**同一事务**里重解析一遍执行上下文（v1.5，PC-CX-29：v1.4 这里写的是"重跑 §9.2 与 §7.4 的第 6、7 条"，只重放两条，于是人在快照之后禁用 Agent、改任务指派、撤回 Provider、软删 Workspace 都能被这道门放过去）。任何一个动作因此不再被允许 ⇒ 该动作记 `status = REFUSED`，`refusal_code` 取 `AUTHORITY_REVOKED`（§9.2 / §7.4 第 6、7 条那一侧）或 `EXECUTION_CONTEXT_REVOKED`（第 8 条那一侧，`detail.revokedInput` 见 §7.4 EC4），**跳过它的副作用**，outcome 其余部分照常提交（§8.5 C2 的同一形状），并把 `configRevision` 的前后值写进 `project_decision.detail`。

**AU1-a（为什么这一把锁就够）**：用户改这四个字段的语句是 `UPDATE project SET … WHERE id = :p`，Postgres 对它**自动取 `FOR NO KEY UPDATE`**。同一把锁 ⇒ 两者互斥 ⇒ 只有两种提交顺序，每一种的结果都是唯一确定的：

| 顺序 | 结果 |
|---|---|
| 人工写先提交 | 控制环等锁 → 读到新值 → 被撤销的动作 `REFUSED(AUTHORITY_REVOKED)` → **不产生 Session** |
| 控制环先提交 | 人工写等锁 → 控制环的 Session 已存在且合法（它是在授权仍有效时提交的）→ 人工写照常生效，此后不再有新的自动派发 |

  **不存在第三种结果**，也不需要任何新的 primitive —— 它就是 §8.6 LO1 第一级的那把锁，控制环本来就在验收事实写入时取它（§13.4 AE6-a）。v1.4 只是把"什么时候必须取"从"写验收事实时"扩到"提交任何被策略门控的动作时"。**v1.5 补两句（PC-CX-28 / PC-CX-29）**：第二行里"人工写照常生效"对 `max` 调低**逐字成立** —— 调低永远不被拒绝，也永远不回头动已经提交的那条占位（CAP0-b），结果是一个有界、可见、会自己排空的 over-cap 状态（CAP4），**不是**一条被违反的不变量；而这张表的两行对**执行上下文**撤权同样成立，只是第一行的拒绝码换成 `EXECUTION_CONTEXT_REVOKED`（§7.4 EC3/EC4）。

**AU2（`project.config_revision`，冻结）**：`BigInt NOT NULL DEFAULT 0`，**上述四个字段的每一次写入都 +1**，单调不复用（与 §8.2 GE1 同一条纪律）。它进 `decisionInput.world.project`（§6.1），因此：

- **S3 成立**：授权变化必然改变 `decisionInputHash`，"同 hash ⇒ 同决策"不会被一个看不见的输入弄假；
- **审计可读**：`project_decision` 同时记下"决策时读到的 revision"与"提交时读到的 revision"，一次撤权竞态因此是**一行可以直接看的记录**，不是一次考古；
- **它不是并发控制**：互斥是 AU1 的那把锁，revision 只是让这件事**可观测**。把 revision 当成 CAS 会重蹈 D8-note 的覆辙 —— 普通读在 MVCC 下看不见未提交的写。

**AU3（哪些字段算"授权"，封闭）**：恰好四个 —— `coordinator_enabled`、`automation_policy`、`max_concurrent_tasks`、`session_budget_per_day`。**它们是 `project` 行上的四个字段，与 §7.4 EC1 的八个执行上下文输入是两个不相交的集合**（v1.5）：AU3 回答"这个项目现在许不许自动做事"，EC1 回答"这件事现在还能不能按原样做"，两者由同一次提交事务在同一把锁之后先后复核，但拒绝码、责任人与恢复路径都不同。改标题、改 goal、改 `acceptanceCriteria`、改 `coordinatorWorkspaceId` **不**进这个集合（前三个走 §13.4 AE6 的验收事实门，最后一个只影响轮换落点）。**一个字段同时进两个集合是允许的**（`acceptanceCriteria` 只在 AE6 里），但一个能改变 §9.2 判定的字段不在 AU3 里就是缺陷，契约测试从 §9.2 与 §7.4 的读集反推本表。

**CAP0（`maxConcurrentTasks` 是准入上限，不是当前状态上限，v1.5 冻结，PC-CX-28）**：v1.4 的 CAP1/CAP3/I16 把它写成一条**当前状态**不变量（"任何顺序下已提交的占位数 ≤ `max_concurrent_tasks`"）。那句话在一条**每一步都合法**的路径上为假：快照 `max = 2, inFlight = 1`，控制环取到 project 行锁、数出 1 < 2、插入第二条占位并提交（AU1-a 第二行明确允许）；用户随后取得同一把锁，把 `max` 改成 1 并"照常生效"。最终已提交状态是 `inFlight = 2, max = 1`。审查记为 `PC-CX-28`（P0）—— 不是因为哪一步错了，而是因为**契约同时冻结了两条不可能同时为真的话**。

v1.5 在审查给的两条路里选**重定义不变量**，而不是"cap 写入者拒绝 `newMax < inFlight`"：

| 选项 | 结果 | 为什么不选 / 为什么选 |
|---|---|---|
| A：cap 写入者拒绝 `newMax < inFlight` | 用户想把并发从 2 降到 1，会被系统以"你现在有 2 个在跑"为由**拒绝** | **不选。** `maxConcurrentTasks` 是用户自己设的数（CAP1-a 已经把这句话写进错误信息里），一个"你不能降低自己的上限"的产品行为会把人逼去杀 Session；而"降低上限时顺手杀掉超出的在飞 Session"是 §9.3 第 4 条那一类**永不代劳**的破坏性动作 |
| B：把 cap 定义成**准入**上限，删掉当前状态不变量 | 调低永远成功；在飞的活不受影响；新的准入立刻按新数执行 | **选它。** 它与 §4.3 I11-A/I11-B、I12-A/I12-B 是**同一条纪律的第三个实例**：一条只在某个时刻成立的性质，就该写成点态的那一句，再配一条恒成立的、只依赖不会回退的东西的那一句 |

- **CAP0-a（准入判据，冻结）**：一个入口**可以**创建一条本 Project 的占位，当且仅当它在 §9.6 CAP1 的那把 project 行锁之后读到的 `count(占位) < max_concurrent_tasks`。**判据只在插入那一刻被要求**，此后 `max` 怎么变都不再回头作用于已经存在的占位。
- **CAP0-b（不追溯，冻结）**：调低 `max_concurrent_tasks` **永远不被拒绝**，**永远不取消、不中断、不软删任何在飞 Session**，也**不开 blocker**。它立即生效于**下一次准入**。
- **CAP0-c（恒成立的那一句怎么查）**：I16-A 的可查询形式 —— 对每个 Project，把占位行按 `created_at` 升序编号，第 n 条在它自己的插入事务里读到的 `(count, max)` 必须满足 `count < max`。这一对值由**同一个事务**在同一把行锁之后读出，因此它是一条可以写进审计（`project_decision.detail.admission = { inFlightBefore, max }`、人工入口的对应记录）并事后逐条核对的事实，而不是一个需要重建历史时刻的推断。

**CAP4（over-cap 是一个有界、可见、会自己排空的状态，v1.5 冻结）**：CAP0-b 的直接推论是 `inFlight > max` 可以存在。它**只能**由一次人工调低产生（准入永远不会造出它），并且：

1. **有界且单调收敛**：over-cap 期间没有任何入口能通过 CAP0-a，因此 `inFlight` 只减不增，随在飞 Session 结束回到 `<= max`。它与 §4.3 I12-B 的 pre-flip 占位是同一种"有界残留"。
2. **可见**：`decisionInput.world.budget.overCapBy = max(0, inFlight - max)`（§6.1），cap 写入者在同一把锁之后把 `{ oldMax, newMax, inFlightAtWrite }` 记进 `project_decision.detail`（人工入口记进它自己的审计），控制面按 AC10 展示"当前 2 / 上限 1，等 1 条运行结束"。
3. **不阻塞、不告警**：`run_state` 仍由 §4.2 的守卫算（有在飞 Session ⇒ `EXECUTING`），`nextWakeAt` 走 §10.4 第 5 条（`evaluation.epoch + 60s`），审计行是一条写明 `over_cap_draining` 理由的 `NOOP`。**不开 blocker** —— 没有任何人需要做任何事，这与 §9.4 `maxConcurrentTasks` 那一行、§9.5 Q3-a、§7.6 TR2-e 是同一种形状。
4. **`sessionBudgetPerDay` 不受本条影响**：它是一个**滚动窗口计数**而不是并发数，调低它同样不追溯已经开过的 Session（那些已经花掉了），超出即 `BUDGET_EXHAUSTED`（CAP2 逐字不变）。

**CAP1（并发上限是所有入口共享的硬门，冻结）**：`maxConcurrentTasks` 对**每一个**会为该 Project 的 Task 创建占位 Session 的入口成立 —— 控制环 `DISPATCH_TASK` **与**人工"开始执行"。两者都必须在 AU1 的那把 project 行锁**之后**执行

```sql
SELECT count(*) FROM session s JOIN task t ON t.id = s.task_id
 WHERE t.project_id = :p AND s.deleted_at IS NULL AND s.status IN ('PENDING','RUNNING');
```

并在 `count >= max_concurrent_tasks` 时拒绝本次插入（CAP0-a 的准入判据）。因为两个入口持有同一把行锁，这个 `count` 与同一句读到的 `max` 是**同一个事务里的一对值**，因此**准入不可能被并发越过**（I16-A）。

**CAP1-a（人工入口被拒时的确定性结果）**：返回有类型的 `PROJECT_CONCURRENCY_LIMIT`，带上该 Project 当前的 `max_concurrent_tasks` 与占着槽位的 Task id 列表。**它不是 500，也不是静默排队。** 这不是控制环在否决用户：上限是**用户自己设的那个数**，错误信息直接指向改它的地方。控制环入口被拒时走 §9.4 的既有形状：一条写明理由的 `NOOP` 审计行 + `nextWakeAt = evaluation.epoch + 60s`，**不开 blocker**。

**CAP1-b（为什么没有把它做成数据库约束）**：一个"每个 project 至多 N 条占位"的约束不能用唯一索引表达，只能用约束触发器 —— 而这里**不需要**它对旧二进制成立：`coordinatorEnabled = true` 的 Project，其全部 Task 的 `dispatch_authority` 必为 `COORDINATOR`（I12-A），而旧 sweep 对 `COORDINATOR` 权的 Task 一律被 D6 拒绝（I12-B）。因此该 Project 上能创建占位的入口**恰好只剩控制环与人工两个**，两个都在新二进制里，一把共享的行锁足够。**这是一次有论证的取舍，不是遗漏** —— 论证依赖 I12-A/I12-B，若将来任何一条被削弱，本条必须重新评估。

**CAP2（`sessionBudgetPerDay` 不变）**：它只约束控制环发起的 Session（§9.4），因此只在 AU1 的复核里判一次，超出即 `BUDGET_EXHAUSTED` blocker（`SYSTEM`/`TIME`）。人工发起的不计入，也不被它拒绝。

**CAP3（可测形式，v1.5 重写，PC-CX-28）**：双事务 barrier，四个 mutator（`coordinatorEnabled = false`、`AUTO → MANUAL`、`max` 调低、人工启动另一个 Task）× 两个提交顺序 `USER_FIRST` / `COORDINATOR_FIRST`，**八格都用同一条不变量断言，一格豁免都不许有**：每一格的结果落在 AU1-a 表的两行之一，且**每一条已提交的占位都满足 I16-A**（它插入时读到的 `count < max`）。v1.4 这一条写的是"任何顺序下已提交的占位 Session 条数 ≤ `max_concurrent_tasks`"，那句话在 `lowerMax` × `COORDINATOR_FIRST` 这一格上必然为假，于是既有模型测试给这一格加了一个 `|| order === 'COORDINATOR_FIRST'` 的豁免 —— **一个只在会红的那一格失效的断言，等于没有断言**，而它同时还宣称自己遍历了八格。真实 Postgres 上跑两条连接、两个提交顺序，并额外断言：over-cap 期间**任何入口**都拿不到准入（CAP0-a），一条在飞 Session 结束后**立刻**又能拿到（CAP4 第 1 条）。

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
         -- (iv) 队列里躺着一条没人看的事件（v1.6 新增，PC-CX-36）：消费者路径坏了
      OR EXISTS (
            SELECT 1 FROM project_event e
             WHERE e.project_id = p.id AND e.consumed_at IS NULL
               AND COALESCE(e.next_attempt_at, e.occurred_at) < now() - interval '5 minutes')
       )
 ORDER BY r.next_wake_at NULLS FIRST
 LIMIT 200;
```

四支的含义各自独立：(i) 定时器路径坏了；(ii) 有还能自己恢复（`recovery ≠ HUMAN`）或还没升级过的 blocker，却没安排下次检查；(iii) 什么都没有 —— **这一支命中就是 AC3 说的静默空转，是 P0**；(iv) **投递路径坏了**（v1.6 新增）：一条事件已经提交了超过 `L` 的硬上限（§10.4 第一行的 5min）还没被消费。反过来，"全部 open blocker 都是 `recovery = HUMAN` 且都已升级过"且队列是空的项目**不会**命中任何一支，因为对它而言时间确实无事可做，而它的状态在 §10.3 (c) 上仍然完全可见。

**W4-b（这条谓词只扫在环的项目，出环的行由 §5.5 收，v1.7 冻结，PC-CX-41）**：`p.status = 'OPEN' AND p.coordinator_enabled AND r.run_state <> 'SETTLED'` 三个合取项是**故意**的，但 v1.6 没有说出它们的补集去哪了 —— 一个 legacy（`coordinator_enabled = false`）或已 `SETTLED` 的项目上照样会有 `task.*` / `session.*` 事件被提交（§5.3 N1 不按 enabled 过滤），而 I6 又禁止对它 reconcile。那些行**既不命中本谓词、也没有人消费**（`PC-CX-41`）。v1.7 的答案不是放宽本谓词 —— 那会把"一个 DONE 了的项目收到一条迟到的 `session.ended`"变成一条 WARN，正是 `PC-CX-05` 那条"恒为真的告警"的第二次 —— 而是给出环的行一条**终态处置**（§5.5 EV3 的原子丢弃）。**两个谓词互补**：W4 扫在环的，EV3 收出环的，并集覆盖全部已提交状态，这就是 §4.3 I19 的三支。

**W4-a（第 (iv) 支为什么在这里，而不是在事件生产者那一侧，v1.6 冻结，PC-CX-36）**：一条刚提交的 `user.manual_trigger` 到它被 reconcile 之间有一段**正常的**异步间隙（§5.4），因此 §4.3 I18 必须承认 I18-B 那种形状。承认之后就要回答"那它凭什么一定会被看到" —— 这一支就是那个回答的可查询形式，而且它挑的谓词与 (i) 同型：**不是"没有 X"，而是"该发生的 X 迟到得太久了"**（`PC-CX-05` 的教训：一个恒为真的告警等于没有告警）。它扫的是 §12.1 步骤 6 已有的 `project_event (next_attempt_at) WHERE consumed_at IS NULL` 索引，不需要新表也不需要新列；`COALESCE(next_attempt_at, occurred_at)` 让"从没被取过"（I18-B）与"取过、安排了重投"（§5.4 的退避、TR2-b 的窗口边界）落在同一个判据上。**它命中即 WARN**（W2 逐字不变）：正常路径下消费者在 1 秒内就把事件取走了，命中一次就意味着消费者或它的进程真的坏了。

### 10.3 可判定的活性条件（这是测试直接查的东西）

对每个 `status = OPEN ∧ coordinatorEnabled ∧ run_state ∉ {AWAITING_HUMAN, SETTLED}` 的 Project，**下列至少一条为真**：

- **(a)** 存在一条本项目 Task 的 LIVE Session，**且它可归属**（I11-A —— **恒成立的那一句**，不是 D9 提交时的那个等号；用当前 token 去比历史动作会让这一条在下一次租约之后必然为假，`PC-CX-21`）—— 要么是某条 `project_action(type = DISPATCH_TASK, status = APPLIED)` 的 `result_session`，要么 `dispatch_origin = 'USER'`。**v1.2 修订**：v1.1 只认前一支，于是"用户手动启动了唯一那个任务"这个完全正常的局面在活性查询上四条全不成立，被判 P0 违约（`PC-CX-14`）。人的显式动作是项目在推进的**证据**，不是漏洞；它不该被要求去伪装成一条控制环动作；
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
| `OPEN_COORDINATOR_TURN` 最小间隔 | **同一 `(generation, reasonCode)` 60s 内至多一次**（§7.6 TR2；v1 写的是"原因摘要"，v1.1 明确为粗粒度的 `reasonCode`）。**窗口边界本身是一个唤醒源**（下方第 7 条），被挡住的请求保持未消费（v1.5，TR2-b/TR2-c） | 防 turn 风暴，且不丢显式请求 |
| 租约 TTL / 续期 | 60s / 20s | §8.1 |

**`nextWakeAt` 的计算规则（v1.1 修订，PC-CX-05）**。v1 的第 6 条按 `run_state` 一刀切成 `NULL`，这与"USER blocker 也必须有 `next_check_at`，用于定时升级"（§11.1）以及"预算窗口自动恢复"（§9.4）**同时**矛盾：状态说不叫醒，另外两条说必须叫醒。v1.1 把决定权从 `run_state` 移到 blocker 的 **`recovery` 轴**（§11.1），因为"谁能解决"和"时间能不能解决"本来就是两个问题：

取所有**适用项的最小值**：

1. 每条 open blocker 且 `recovery ∈ {TIME, EVENT}` 的 `next_check_at` —— 这类 blocker 可以在没有人参与的情况下解除（预算窗口滚出、Provider 恢复、Runner 上线），因此**必须**有定时器去重算它；
2. 每条 open blocker 且 `escalated_at IS NULL` 的**升级到期时刻**（`first_seen_at + §11.5 的阈值`）—— **包括 `recovery = HUMAN` 的**。这就是 §11.1 说的"`owner = USER` 也必须有 `next_check_at`，用于升级"，它是一个升级闹钟，不是一次恢复轮询；
3. **每一个**处于失败退避中的 Task 的退避到期时刻（Q2）—— **v1.7 起是"每一个"而不是"最早一个"**（`PC-CX-39`）：两个同刻到期的 Task 之间，"最早一个"没有定义，而 W5 第 2 条的全序已经能选，再发明一个 tie-break 是多余的；
4. **每一个** `runAt` 在未来的 Task 的 `runAt`（同上，v1.7，`PC-CX-39`）；
5. 有在飞 Session 时：`evaluation.epoch + 60s`（在飞会话结束本身会发事件，这只是兜底）；**v1.7 起是 `epoch` 而不是 `now()`**，理由见 W5 第 3 条（`PC-CX-40`）；
6. 都没有且 `runStateOf` = `PLANNING`：`evaluation.epoch + 60s`（同上）。
7. **每一个被 §7.6 TR2 限频挡住的 `reasonCode`，其限频窗口的边界**（TR2-a 的锚点动作 `created_at + 60s`）—— **v1.5 新增，PC-CX-31**。触发条件是"`signals` 里有一条未消费的、TU4 会选中它的请求，而它的窗口还没过期"；今天这样的 `reasonCode` 只有 `MANUAL` 一个（S7 的封闭表），但这一条按 `reasonCode` 写，因此以后 S7 的表长出第二行时它自动适用。**没有这一条，一个被限频的显式请求要么被消费掉而永久消失、要么留在那里而没有任何一个定时器指向它的重试时刻** —— 前者是静默忽略，后者要么忙等要么无限等。

**N-null（`nextWakeAt` 允许为 `NULL` 的全部情形，封闭）**：

- `run_state = SETTLED`；或
- 上面 1–7 条**全部不适用**（v1.5：v1.1 写的是"上面 1–6 条**全部不适用**"，那时还没有第 7 条），等价于：存在 open blocker，且**每一条**都满足 `recovery = HUMAN` ∧ `escalated_at IS NOT NULL`（已经升级到人、且时间再做不了任何事），且没有退避中的任务、没有未来的 `runAt`、没有在飞 Session，**且这次 reconcile 读到的 `signals` 里没有任何一条未消费的 `user.manual_trigger`**（有它就必然有第 7 条）。

**N-null 的时态（v1.6 冻结，PC-CX-36）**：本条判的是**一次 reconcile 提交时**的 `nextWakeAt`，读的是**那一次**的 `decisionInput`。它**不是**一条"任何已提交状态上都成立"的话 —— 一条刚被用户接口提交、还没有被任何一次 reconcile 看过的 `user.manual_trigger`（§4.3 I18-B）与一个合法为 `NULL` 的 `next_wake_at` 完全可以同时存在，那正是 §5.4 的异步投递本身。这一格由 §10.2 W4 的第 (iv) 支负责，不由 `next_wake_at` 负责：**时钟管"我知道我在等什么"，队列管"还没人看过的东西"，两者是两条路**（§4.3 I19）。把它们写成一条，就会得到一个在正常主路径上为假的不变量。

**其它任何情况下 `nextWakeAt` 为 `NULL` 都是缺陷**，由 §10.2 W4 的第 (ii)/(iii) 支当场抓住。注意这条与 I5 是同一件事的两种写法：I5 说"OPEN 且非等待人工 ⇒ 非空"，N-null 把"等待人工"里**还能靠时间前进的那部分**从豁免里剔了出来。

**N-mask（v1.1 补充）**：被 USER blocker 掩盖（I4b）的非 USER blocker **照常参与**第 1、2 条。状态可以被掩盖，时钟不可以 —— 否则一条审批 blocker 会顺手冻结掉同一项目里所有 Provider/Runner blocker 的自动恢复。

**W3（v1.7 把时钟换成冻结的那一个，PC-CX-40）**：`nextWakeAt` **永远不小于 `evaluation.epoch + 5s`**。没有下限的"立刻再看一眼"就是 busy loop，10 单元的资源断言查的就是这个。v1.1–v1.6 这里写的是 `now + 5s`，而 `now()` 不在 `decisionInputHash` 里 —— 同一份声明输入在两次不同墙钟下执行会得到两个 `nextWakeAt`，S3 因此对本条为假（`PC-CX-40`）。下限的**度量起点**因此是这次决策读到的那个 epoch，可观测后果写在 W5 第 6 条。

**W5（一个候选表、一个确定的选择，v1.6 冻结，v1.7 补全序与冻结时钟，PC-CX-35 / PC-CX-39 / PC-CX-40）**：v1.1–v1.5 把上面这些写成三句互不相干的话 —— "取所有适用项的最小值"、"窗口边界必然 `≤ windowEndsAt`"（TR2-d）、"永远不小于 `now + 5s`"（W3）。**在窗口最后 5 秒里这三句无解**：锚点 `t0 = 0`、窗口边界 `60s`、请求在 `58s` 被限频 ⇒ TR2-b 要 `nextAttemptAt = 60s`，I18 要 `nextWakeAt ≤ 60s`，W3 要 `nextWakeAt ≥ 63s`，不存在合法 timestamp（`PC-CX-35`）。同一段里还有第二处不确定：另一个 Task 的 `runAt = 59s` 时，"取最小值"要 59s，而 TR2-e 又逐字要求 `next_wake_at` 指向 `60s` 且 `next_wake_reason = 'manual trigger rate-limited'`。v1.6 把这三句合成**一个算法**；v1.7 补上它缺的两样东西 —— **一个真正的全序**（`PC-CX-39`）与**一个在 hash 里的时钟**（`PC-CX-40`）。它对任何输入都给出唯一的一对 `(nextWakeAt, nextWakeReason)`：

1. **候选表**：上面 1–7 条各自产出零个或多个候选。**v1.7 起一个候选是一个四元组** `(at, source, subjectType, subjectId)` 外加展示用的 `reason`，`source` 是它在那张表里的**序号**（1–7），`(subjectType, subjectId)` 是**产生它的那一行的持久身份**，逐条冻结如下：

   | source | 产生它的规则 | `subjectType` | `subjectId` | 一个 subject 在本 source 里产出几条 |
   |---:|---|---|---|---|
   | 1 | open blocker 且 `recovery ∈ {TIME, EVENT}` 的 `next_check_at` | `BLOCKER` | `project_blocker.id` | 恰好一条 |
   | 2 | open blocker 且 `escalated_at IS NULL` 的升级到期时刻 | `BLOCKER` | `project_blocker.id` | 恰好一条 |
   | 3 | 处于失败退避中的 Task 的退避到期时刻 | `TASK` | `task.id` | 恰好一条 |
   | 4 | `runAt` 在未来的 Task 的 `runAt` | `TASK` | `task.id` | 恰好一条 |
   | 5 | 有在飞 Session 时的 `epoch + 60s` | `PROJECT` | `project.id` | 至多一条 |
   | 6 | `runStateOf = PLANNING` 时的 `epoch + 60s` | `PROJECT` | `project.id` | 至多一条 |
   | 7 | 被 §7.6 TR2 限频挡住的 `reasonCode` 的窗口边界 | `TURN_WINDOW` | 该 `reasonCode`（S7 的封闭表，今天只有 `MANUAL`） | 每个 `reasonCode` 恰好一条 |

   候选的 `at` **一律**是已落库的事实或按 `evaluation.epoch` 算出来的时刻，**不含第二个时钟**（第 3 条）。第 3、4 条 v1.1–v1.6 写的是"最早一个 Task"，v1.7 改成**每个 Task 一条候选**并让第 2 条去选 —— "最早一个"在两个 Task 同刻到期时本身就没有定义，把选择交给一个已经存在的全序比再发明一个 tie-break 更小。

2. **选择（全序，v1.7 补齐第三、四键，PC-CX-39）**：`chosen` = 候选表在 `(at, source, subjectType, subjectId)` 这个**字典序**下的最小元。`at` 按时刻升序；`source` 按 1–7 升序；`subjectType` 按 `BLOCKER < PROJECT < TASK < TURN_WINDOW` 的**字母序**；`subjectId` 按**按字节**升序（内部落库是 UUID，比较的是它的小写规范文本，且**必须**是字节序而不是数据库 collation —— `ORDER BY subject_id COLLATE "C"`，否则同一份候选表在两台 locale 不同的机器上会给出两个 `nextWakeReason`）。这与 §4.2 RS0、§7.2 TU4、§7.4 EC4 是同一条纪律：**同时为真的原因由一个全序裁决，不由遍历顺序裁决**。

   - **W5-2a（它为什么真的是全序）**：上表最后一列是这一句的依据 —— 一个 `(source, subjectType, subjectId)` 在一次求值里**至多产出一个候选**，因此四元组两两不等，字典序在候选表上是全序，`chosen` 唯一。**v1.6 的 `(at, source)` 不是全序**：source 1 可以同时产出两条 `at = 60s` 的候选（一条 provider blocker、一条 runner blocker），两者的 `nextWakeAt` 相同而 `nextWakeReason` 取决于数组顺序（`PC-CX-39`）。
   - **W5-2b（为什么第三、四键是持久的）**：`subjectId` 是一条已落库的行的主键，不是求值时才产生的下标。**排序键必须是持久的**，否则"同一份输入的重放给出同一个决策"（S3）在重放时读到另一个内存顺序就为假 —— 这与 §8.2 GE1"代次必须来自持久化列"是同一条纪律。

3. **下限（floor 胜过 deadline，且用冻结的时钟，v1.7 改述，PC-CX-40）**：`nextWakeAt = max(chosen.at, evaluation.epoch + 5s)`。**W3 是硬下限，任何一条 deadline 都不能把它压下去** —— 理由是两者的代价不对称：被 floor 推迟的那次唤醒最多晚 5 秒（`chosen.at` 只有在已经不足 5 秒到期时才会被推），而放弃 floor 就是 busy loop，它会在**每一个**窗口末端把 reconcile 变成一个自旋。**下限读的是 `evaluation.epoch`，不是 `now()`** —— S5 早就规定 epoch 是唯一允许读时钟的地方，而 v1.6 的 W5 在这里读了第二个：同一份 `decisionInputHash` 在 58s 与 59s 执行会得到 63s 与 64s 两个 `nextWakeAt`，S3 要求的"相同的 `nextWakeAt`"因此为假（`PC-CX-40`）。`nextWakeReason` **仍然取 `chosen` 的 reason** —— 它回答"这次醒来是为了什么"，不是"它准不准时"。

4. **审计**：整张候选表（每一项的 `at` / `reason` / `source` / `subjectType` / `subjectId`）**按第 2 条的全序排序后**写进 `project_decision.detail.wakeCandidates`，被 floor 抬高时另记 `flooredBy = 'W3'`。这与 §7.2 TU5 的 `suppressedTurnReasons` 是同一种形状：**没胜出的原因不是被丢掉了，是被记下来了**。排序后落库让"同 hash ⇒ 同审计行"也成立，而不只是"同 hash ⇒ 同 `nextWakeAt`"。

5. **到点之后**：因为 `chosen.at ≤ nextWakeAt`，到点重新 reconcile 时那条候选的到期事实（§6.1 S5）**必然**已经为真 —— floor 只会让它更真，不会让它落空。因此"晚 ≤ 5 秒"是这条唯一的可观测后果，`L` 的 p95/p99/硬上限（§10.4 第一行）逐字不受影响。

6. **floor 从 `epoch` 起算的可观测后果（v1.7 冻结，PC-CX-40）**：`epoch` 是**读快照**的时刻，提交发生在它之后，因此 floor 保证的是"距这次决策**读到的**那一刻至少 5 秒"，而不是"距提交至少 5 秒"，两者相差正好这一次 reconcile 自己的墙钟（§10.4 第二行：p95 ≤ 2s，硬上限 5min）。**它不会退化成自旋**，两条独立的理由：一次耗时 `d` 的 reconcile 把下一次的 epoch 至少推后 `d`，因此重复唤醒的频率上界是 `1/d` 而不是无穷；而定时路径本身是 10 秒轮询（§10.2），因此一个已经到期的 `next_wake_at` 最快也要等到下一个 tick。**换到的是 S3 真的成立** —— 一个只在慢 reconcile 上损失几秒确定性下限的代价，换掉一条"同一份输入两个合法答案"的不确定性。

7. **本条之外允许写 `next_wake_at` 的地方（封闭，v1.7 冻结，PC-CX-40）**：W5 是**决策产出的** `nextWakeAt` 的唯一算法，因此 S3 只对它量化。另有两处写这一列而**不产生 outcome、也不产生 `project_decision` 行**，它们不在 S3 的量化域里，必须在这里点名以免下一个人以为 W5 漏了它们：§6.3 第 1 步取不到租约时写**现持有者的租约到期时刻**（一个已落库的事实，不是时钟运算）；§6.3 R2 超时放弃提交时写 `now + 60s`（那一次 reconcile 没有决策、没有输入 hash，唯一的记录是 `reconcile_timeout` 审计行）。**除这两处外，任何一处对 `next_wake_at` 的写都必须是 W5 的输出。**

  **可测形式**：`remaining ∈ {0, 1, 2, 4, 5, 6, 59}s` 逐个跑，断言 `nextWakeAt ≥ epoch + 5s`（W3）、`nextWakeAt ≤ nextAttemptAt + 5s`（I18-C）、`nextAttemptAt` 恒等于窗口边界（TR2-b）三者**同时**成立；把第 7 条与第 1–6 条两两组合，断言 `(nextWakeAt, nextWakeReason)` 与遍历顺序无关、与 `source` 全序一致；**再对每一个 source 内的 2+ 同刻候选跑全排列**（v1.7，`PC-CX-39`），断言 `(nextWakeAt, nextWakeReason, wakeCandidates)` 逐字节相同；**再把同一份序列化 `decisionInput` 在不同墙钟下延迟 0 / 1 / 4 秒执行**（v1.7，`PC-CX-40`），断言 `nextWakeAt` 逐字节相同。

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


外加：`subject_type`/`subject_id`（哪个 Task / Runner / Provider）、`detail`（Json，展示与诊断）、`dedupe_key`、**`lifecycle_generation`（§11.3 BE1，v1.3 新增：这是同一 `dedupe_key` 上的第几个故障周期 —— 解除后复发得到一个更大的值，因此它是 §8.2 GE1 认可的动作身份来源）**、**`condition_version`（§7.2 TF2，v1.2 新增：产生这条 blocker 的那些快照事实的摘要 —— 它是"条件本身"，而 `occurrences` 是"这个条件被看见过几次"，两者必须分列）**、`first_seen_at`/`last_seen_at`/`occurrences`、`severity`、`escalated_at`、`resolved_at`/`resolved_by`。

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

同因重复事件 ⇒ 同一 `dedupe_key` ⇒ 命中已存在的 open 行 ⇒ `occurrences += 1`、`last_seen_at = now()`、`condition_version` 按当前事实重算（§7.2 TF2），**不新建行、不重复通知**（AC8）。

**BE1（生命周期代次，v1.3 冻结，PC-CX-16）**：每条 blocker 行带一个 `lifecycle_generation BigInt NOT NULL`，含义是"这是这个 `dedupe_key` 上的第几个故障周期"。它在**插入的同一条语句里**分配，取值为同一 `(project_id, dedupe_key)` 上历史最大值 + 1：

```sql
INSERT INTO project_blocker (project_id, dedupe_key, lifecycle_generation, kind, owner, recovery, …)
SELECT :p, :k, COALESCE(MAX(b.lifecycle_generation), 0) + 1, …
  FROM project_blocker b
 WHERE b.project_id = :p AND b.dedupe_key = :k
    ON CONFLICT (project_id, dedupe_key) WHERE resolved_at IS NULL DO NOTHING
 RETURNING id, lifecycle_generation;
```

- **解除不删除行**，因此 `MAX` 一定看得见上一个周期 —— 这与 `project_action` 的历史行永不删除是同一条纪律的两面（§8.2 GE1）。
- 返回 0 行 = 这个周期已经 open 着，走 §8.5 C2：读出既有行、用**它的** `lifecycle_generation` 组键、跳过副作用、继续提交。**同一个 open 周期内的重复因此仍然恒为同一个键**，AC8 的去重逐字不变。
- 加一条**覆盖全部行**（不是 partial）的唯一索引，让代次分配在接管窗口里也不可能重复：

```sql
CREATE UNIQUE INDEX project_blocker_episode_idx
    ON project_blocker (project_id, dedupe_key, lifecycle_generation);
```

**BE2（为什么 `MAX + 1` 这次是安全的）**：普通读在 MVCC 下看不见未提交的写（§7.7 D8-note 已经为此付过一次代价），因此两个并发的 raise **可以**算出同一个代次。这里之所以仍然安全，是因为它们随后要撞的是**两个**唯一索引：同一周期内的第二次插入撞 `project_blocker_open_dedupe_idx`（§11.3 的 partial index），跨周期的重复代次撞 `project_blocker_episode_idx`。两种冲突都被 §8.5 C1 的 `ON CONFLICT … DO NOTHING RETURNING` 降级成返回值，由 C2 读出既有行继续。**加上一层更强的保证**：blocker 只由持有租约的那一个 reconcile 写（§8.1 F1），因此并发 raise 只可能出现在接管窗口里，而那个窗口里旧持有者的整事务会因 fencing token 条件影响 0 行而回滚（C3）。索引是兜底，不是主路径。

**BE3（键与行一一对应）**：`RAISE_BLOCKER` 的键 `pc:v1:<p>:blocker:<kind>:<subjectId>:<lifecycleGeneration>` 与 blocker 行**一一对应**，因此"这条 blocker 是哪一次动作开的"是一次索引查找而不是一次推理；`CLEAR_BLOCKER` 的键用行 id（§8.2），一行一生只被解除一次。

### 11.4 自动解除

每次 reconcile 对每条 open blocker 重算其条件：条件消失即 `CLEAR_BLOCKER`，写 `resolved_at` / `resolved_by = 'AUTO'`，并**立即**重算 `run_state` 与 `nextWakeAt`（不等下一个 tick）。

**BL3**：解除必须由**重算条件**驱动，不能由"收到了一个 `provider.restored` 事件"驱动 —— 那会违反 E1，并且在事件丢失时永久卡住。

### 11.5 升级（escalation）

一条 blocker 在 `owner` 层面解决不了时升级到人。

- **ES4（触发条件，v1.3 修订，PC-CX-15）**：触发**只有一个** —— 同一条 blocker 的**存活时长**跨过阈值（默认 30min）。**升级到期时刻 = `first_seen_at + 30min`**，它是 §10.4 第 2 条唯一的 wake 来源。v1.2 还写着"或 `occurrences > 10`"，那是一个**投递次数**阈值：世界事实完全相同、只是同一个信号被重投了 11 次，就会得到不同的 owner、不同的 `run_state` 和一条本不该发的通知 —— 这与 §5.1 E1"事件是信号不是事实，重复投递不产生额外副作用"是正面冲突，而 v1.2 只把 `occurrences` 从 turn 摘要里拿掉了（TF1），没有把它从升级里拿掉。审查记为 `PC-CX-15`。**`occurrences` 此后不参与任何判定。**
- **ES5（重复投递等价性，v1.3 冻结）**：把同一份世界事实投递 N 次（N ∈ 任意正整数、任意顺序、跨重启），下列每一项都必须**与 N = 1 时逐字节相同**：blocker 的 `kind` / `owner` / `recovery` / `required_action` / `dedupe_key` / `lifecycle_generation` / `condition_version` / `first_seen_at` / `escalated_at`、项目的 `run_state`、**通知条数**、以及本次是否升级。允许随 N 变化的**只有** `occurrences` 与 `last_seen_at` 两列，而它们是 BL7 定义的展示字段。`recovery ∈ {TIME, EVENT}` 的 `next_check_at` 会随**时钟**前移（它是一次重算轮询，§11.2 BL5），但**永远不因为次数**变化 —— 这两件事的区别就是 ES5 要测的东西。
- **BL7（`occurrences` 是展示字段，v1.3 冻结）**：`occurrences` 与 `last_seen_at` **只用于展示与诊断**（"这个条件被看见过 47 次，最近一次是 3 分钟前"）。它们**不得**出现在：任何幂等键、任何 `turnFacts`（TF1 早已禁止）、任何升级条件（ES4）、任何 `run_state` 判定、任何通知判定、任何 `nextWakeAt` 计算。可测形式就是 ES5。
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
| 2 | 加列：`project.coordinator_enabled` / `automation_policy` / `max_concurrent_tasks` / `session_budget_per_day` / **`config_revision`（`BigInt NOT NULL DEFAULT 0`，§9.6 AU2，v1.4 新增）**；`task.completion_policy` / `dispatch_authority` / **`task.dispatch_attempt`（`BigInt NOT NULL DEFAULT 0`，§8.2 DA1，v1.2 新增）** / **`task.verdict_revision`（`BigInt NOT NULL DEFAULT 0`，§13.2 V7，v1.3 新增）**；`session.project_action_id` / **`session.dispatch_origin`（DB 默认 `'LEGACY_SWEEP'`，§7.7 D6-a 依赖这个默认值）**；**`project_action.execution_context`（`Jsonb NULL`）/ `execution_context_digest`（`text NULL`）/ `reason_code`（`text NULL`）（§7.4 EC1/EC2 · §7.6 TR2-a，v1.5 新增）**；**`project_action.execution_result_digest`（`text NULL`，§7.4 EC2-b）/ `session.execution_pin_generation`（`BigInt NOT NULL DEFAULT 0`，§4.3 I17-A2）/ `project_event.disposition`（`text NULL`，§5.5 EV2；存量已消费行回填 `'RECONCILED'`，因为 v1.7 之前只有这一条路能写 `consumed_at`）（v1.7 新增）** | 全部**可空或有默认** |
| 3 | 为每个既有 Project 回填一行 `project_runtime`：`run_state = 'PLANNING'`、`fencing_token = 0`、`next_wake_at = NULL`、`coordinator_generation = 0` | `ON CONFLICT (project_id) DO NOTHING` |
| **3b** | **收敛存量重复占位**：对每个 `task_id`，保留 `created_at` 最新的一条 `status IN ('PENDING','RUNNING') AND deleted_at IS NULL` 的 Session，其余置 `status = 'CANCELLED'`、`end_reason = 'duplicate_live_session_reconciled'`；**把受影响行数打进迁移输出**（§7.7 D5-c）。**必须在步骤 6 建唯一索引之前**，否则迁移在生产上直接失败 | 幂等（再跑一次影响 0 行） |
| 4 | 既有 Project 一律 `coordinator_enabled = false`、`automation_policy = 'MANUAL'` | 列默认即如此（见 G1） |
| 5 | 既有 Task 一律 `dispatch_authority = 'LEGACY'`、`completion_policy = 'MANUAL'` | 列默认 |
| 6 | 建索引：`project_event (project_id, dedupe_key) WHERE consumed_at IS NULL`、`project_event (next_attempt_at) WHERE consumed_at IS NULL`、`project_blocker (project_id, dedupe_key) WHERE resolved_at IS NULL`、`project_runtime (next_wake_at) WHERE next_wake_at IS NOT NULL`、`project_action (idempotency_key)`、`project_decision (project_id, created_at DESC)`、**`session_task_execution_claim_idx`（§7.7 D5）**、**`project_blocker_episode_idx`（§11.3 BE1，v1.3 新增：`(project_id, dedupe_key, lifecycle_generation)`，覆盖全部行而非仅 open 行）** | `CREATE … IF NOT EXISTS` |
| **6b** | **建触发器** `session_dispatch_authority_guard`（§7.7 D6）。它必须与步骤 2 的 `session.dispatch_origin` 在**同一次迁移**里落地：只有列没有触发器等于没有硬门，只有触发器没有默认值等于旧二进制插不进任何 Session。**函数体里的 `FOR SHARE` 是 §7.7 D8 的一半，漏掉它整条 `PC-CX-09` 就回来了，而且不会有任何编译期或 `migrate diff` 的信号** | `CREATE OR REPLACE` + `DROP TRIGGER IF EXISTS` |
| **6c** | **建归属约束**（§7.7 D9，v1.3 新增）：可延迟约束触发器 `session_dispatch_attribution_check` + CHECK 约束 `session_action_only_for_coordinator_chk`。两者必须与步骤 2 的 `session.project_action_id` 同一次迁移落地；CHECK 在建之前需先把存量里"非 COORDINATOR origin 却带动作 id"的行收敛为 NULL（迁移前不存在这种行，因为这一列本身是新的，但**必须写成幂等语句**以便回滚后重放） | `DROP … IF EXISTS` + `CREATE`；`ADD CONSTRAINT … NOT VALID` 后 `VALIDATE` |
| **6d** | **建 v1.4 的三个数据库对象**：`task_claimed_project_move_guard`（D10，可延迟约束触发器）、`project_action_applied_immutable_guard`（D11，`BEFORE UPDATE`）、`task_dispatch_authority_projection` + `project_dispatch_authority_fanout`（D12/D8-a，两个投影触发器）。**建投影触发器之前必须先按 D13 的派生式回填一次存量**（`UPDATE task SET dispatch_authority = dispatch_authority` 即可，触发器会算出正确值），否则迁移完成的那一刻投影就已经是陈旧的 —— 阶段 A 的存量全是 `LEGACY`、全部 Project 的 `coordinator_enabled` 全是 false，回填因此是一次 0 变更的空跑，但**必须写进迁移**，否则回滚重放后就不是了 | `DROP … IF EXISTS` + `CREATE`；回填幂等 |
| **6e** | **建 v1.5 的执行上下文门**：`resolve_execution_context_locked(task_id, agent_id)`（§7.7 D14-a，**`VOLATILE`**、只读、按 §8.6 LO1 的顺序 `FOR SHARE`；漏写 `VOLATILE` 会让它每次调用抛 `0A000`，见 D14-f）与可延迟约束触发器 `session_execution_context_guard`（D14）。两者必须与 `project_action.execution_context` / `execution_context_digest` / `reason_code` 三列在**同一次迁移**里落地：只有列没有触发器等于没有硬门，只有触发器没有列会让每一次插入都因读不到冻结摘要而失败。建触发器之前**不需要**回填 —— 阶段 A 没有任何 `dispatch_origin = 'COORDINATOR'` 的存量占位（这一列本身是新的），但**必须写成幂等语句**以便回滚后重放 | `DROP … IF EXISTS` + `CREATE OR REPLACE` |
| **6f** | **建 v1.7 的两个数据库对象**：`session_execution_snapshot_guard`（D15，`BEFORE INSERT OR UPDATE` on `session`）与**重建** `project_action_applied_immutable_guard`（D11 的 v1.7 闭集 allowlist 形式 —— 它必须与步骤 2 的 `execution_result_digest` 在**同一次迁移**里落地，否则新列一落地就是一列**可被任意改写**的冻结摘要）。建 D15 之前**不需要**回填：阶段 A 没有任何 `dispatch_origin = 'COORDINATOR'` 的存量占位；但**必须写成幂等语句**以便回滚后重放。**`project_event.disposition` 的回填（已消费行 → `'RECONCILED'`）必须在建立任何断言之前完成**，否则 §5.5 EV2 的"没有第四个"在迁移完成那一刻就是假的 | `DROP … IF EXISTS` + `CREATE OR REPLACE`；回填幂等 |
| 7 | **不含任何 `DROP COLUMN`** | 同 PAC M4 |

- **G1（关键）**：列默认值与"新建 Project 的默认"是**两个不同的值**，不能靠一个 `@default` 同时表达。`automation_policy` 的**数据库默认是 `MANUAL`**（保护存量），**服务层在创建新 Project 时显式写入 `GUARDED_AUTO`**。反过来做（默认 GUARDED_AUTO + 迁移里 UPDATE 存量）会在迁移与新代码上线之间留一个窗口，窗口里创建的项目全是自动的。同理 `coordinator_enabled` 数据库默认 `false`，新建时显式 `true`。**04 单元必须同时测这两条**：迁移后存量为 MANUAL/false，且新建为 GUARDED_AUTO/true。
- **G2**：迁移**不回填任何 blocker、不产生任何事件、不安排任何唤醒**。迁移完成的那一刻，控制环对存量项目**完全静默**。
- **G3**：用户为一个既有 Project 打开 `coordinatorEnabled` 时，服务层必须**同时**要求一个显式的 `automationPolicy`（不给默认），并在同一事务里产生一条 `user.policy_changed` 事件把它接进环里。"沿用安全默认"= 不动它；"明确选择策略" = 打开时必须选。
- **G4**：迁移必须在**空库**和**生产快照**上各跑一次、`migrate diff` 对新增列为空。验证手法照 PAC M3：一次性 throwaway postgres 跑 `prisma migrate deploy` + `migrate diff`，`grep` 自己新增的列名，而不是看 drift 总数。
- **G5（v1.1 新增，v1.2 扩充）**：步骤 3b / 6 / 6b 三件事**都不是 Prisma schema 能表达的**（partial unique index 的谓词、plpgsql 触发器、数据收敛），因此它们是迁移文件里的裸 SQL。**既有教训：裸 SQL 躲得过编译期检查** —— `prisma migrate diff` 也不会告诉你触发器没了。因此 04 单元的迁移验证必须**显式**查这三样东西存在（`pg_indexes` / `pg_trigger` / 收敛后每个 task 的占位 Session 计数 ≤ 1），而不是只看 `migrate diff` 为空。**v1.2 再加一条**：还要显式断言触发器函数体里含 `FOR SHARE`（`pg_get_functiondef` 上 grep），因为一个少了两个词的触发器与一个正确的触发器在 `pg_trigger` 里长得一模一样，而它们的差别正好是那个 P0。**v1.3 再加三条**：断言 `session_dispatch_attribution_check` 存在**且是 `DEFERRABLE INITIALLY DEFERRED` 的**（`pg_trigger.tgdeferrable AND tginitdeferred`；一个立即执行的同名触发器会让 §8.3 的语句顺序无法提交，症状是所有派发失败）、断言 CHECK 约束存在（`pg_constraint`）、断言 `project_blocker_episode_idx` 覆盖的是全部行而不是 open 行（`pg_indexes.indexdef` 里**没有** `WHERE`）。三样都是裸 SQL 的产物，`migrate diff` 一样看不见。**v1.4 再加四条**：断言 `task_dispatch_authority_projection` 存在**且函数体里含 `FOR SHARE`**（少了这两个词，翻转与并发的任务写入就不再互斥，`PC-CX-25` 的第三种形状立刻回来，而 `pg_trigger` 里看不出差别，同 v1.2 那一条）、断言 `task_claimed_project_move_guard` 存在**且是 `DEFERRABLE INITIALLY DEFERRED` 的**、断言 `project_action_applied_immutable_guard` 存在，以及**直接跑一次 §7.7 D13 的漂移查询并断言返回 0 行**（这一条比前三条都强：它不问对象在不在，它问结果对不对）。**v1.5 再加三条**：断言 `session_execution_context_guard` 存在**且是 `DEFERRABLE INITIALLY DEFERRED` 的**（立即执行的同名触发器会在 §8.3 的语句顺序中途要求一个还没写完的动作行，症状是所有派发失败）、断言 `resolve_execution_context_locked` 存在**且函数体里含 `FOR SHARE`**（少了这两个词，撤权与派发就不再互斥，`PC-CX-29` 立刻回来，而 `pg_proc` 里看不出差别 —— 与 v1.2 / v1.4 那两条是同一种检查），以及**跑一次 I17-A 并断言返回 0 行**（每一条 COORDINATOR 占位的冻结快照列都等于它那条 `APPLIED` 动作行上的 `execution_context` 分量）。**v1.6 把这条的第三项换掉并再加三条（PC-CX-32 / PC-CX-34）**：v1.5 这里写的是"跑一次 I17 的可查询形式并断言返回 0 行（不存在解析到已禁用 Agent … 的 COORDINATOR 占位）"，**那个查询在一条每一步都合法的路径上必然非零**（人在合法派发之后撤权），因此它是一条会把正常状态判成迁移失败的断言，v1.6 换成上面的 I17-A；新加的三条是：断言 `pg_proc.provolatile = 'v'`（`resolve_execution_context_locked` 与 `session_execution_context_guard` 两个函数各一次，§7.7 D14-f —— 漏写 `VOLATILE` 的迁移函数体逐字相同、`FOR SHARE` 也照样 grep 得到，差别只在这一列，而按 `STABLE` 建出来的对象每次调用都抛 `0A000`）、**真的插一条 `dispatch_origin = 'COORDINATOR'` 的 Session 并 `COMMIT`**（正例提交成功、把 EC1 任一行撤销后得到 `EXECUTION_CONTEXT_REVOKED: <input>`；`CREATE FUNCTION` 成功不代表它能被调用，这正是 `PC-CX-32` 逃过 v1.5 全部检查的方式）、以及断言迁移建出来的 `project_event (next_attempt_at) WHERE consumed_at IS NULL` 索引存在（§10.2 W4 第 (iv) 支与 §5.4 的重投都扫它）。**v1.7 再加四条（PC-CX-37 / PC-CX-38 / PC-CX-42）**：① 对 `project_action_applied_immutable_guard` 跑一次**由 schema 驱动**的逐列 mutation —— 从 `information_schema.columns` 读出这张表的全部列，逐列改写一条 `APPLIED` 行，断言 `result_session_id` / `detail` 之外**每一列**都被 `ACTION_APPLIED_IMMUTABLE` 拒绝（**不是**断言某个固定的列数：v1.4 写死"六列"正是 `PC-CX-37` 的形状，一张 denylist 与它保护的表分头长大，而 `pg_get_functiondef` 上看不出差别）；② 断言 `session_execution_snapshot_guard` 存在，并**真的跑一遍 §7.7 D15-e 的三阶段**（create ⇒ `model IS NULL ∧ execution_pin_generation = 0`、首次 claim ⇒ 代次 1、`retiredPin` ⇒ 代次 2）与它的四个反例；③ **跑一次 I17-A 与 I17-A2 并各断言返回 0 行**（v1.5/v1.6 只有 I17-A，而它当时把 PAC 的 claim 冻结列也算了进去，因此在任何一条还没被 claim 的 PENDING 占位上必然非零 —— 那条断言会把正常状态判成迁移失败）；④ 断言 `project_event.disposition` 的存量回填完成（`consumed_at IS NOT NULL AND disposition IS NULL` 返回 0 行，§5.5 EV2）。**v1.8 再加四条（PC-CX-43 / PC-CX-44 / PC-CX-45 / PC-CX-46）**：⑤ 把第 ① 条那次 schema 驱动的逐列 mutation **再跑一遍在发布语句上** —— 插 `CLAIMED` 动作、插 Session，再逐列尝试"改这一列 + 置 `APPLIED`"，断言四列可写之外每一列都被 `ACTION_PUBLISH_IMMUTABLE` 拒绝，并断言干净的 `CLAIMED → APPLIED` / `CLAIMED → SUPERSEDED` 照常提交（只测已 `APPLIED` 的 OLD 行不够：那正是 `PC-CX-43` 逃过 v1.7 全部检查的方式）；⑥ 从 **PAC §6 的表**生成 create 冻结列清单，断言 D15 的 `INSERT` 分支与 D16 的等式**逐行覆盖**它（不是断言一个固定的列数），并真的插一条 `permission_mode` 与冻结上下文不同的 Session，断言得到 `EXECUTION_SNAPSHOT_MISMATCH`；⑦ 对 **D5 partial unique index 的每一个谓词列**做 UPDATE mutation，断言一条已有 live claim 的 COORDINATOR 占位不能被写出索引覆盖集（`EXECUTION_SNAPSHOT_FROZEN`），随后同一 Task 的第二条 live Session 仍然只能拿到唯一冲突；⑧ 断言 `session_execution_result_check` 与 `project_action_pin_ledger_check` 两个约束触发器存在**且都是 `DEFERRABLE INITIALLY DEFERRED` 的**，并真的跑一遍 D16-e 的正例与九个反例。**v1.9 再加四条（`PC-CX-47` / `PC-CX-48` / `PC-CX-49`）**：⑨ 断言 `coordinator_pin_ledger_fold` 存在，并真的跑一遍 D16-e **v1.9 新增的那八个反例与两个正例** —— 特别是"`claimResolution` 齐全但 Session 的 `model`/`effort` 不是它记的那一对"这一个：只断言账本的条数对不上会漏掉它，而它正是 `PC-CX-47` 的原形；⑩ 断言 `coordinator_canonical_json` 与 `coordinator_execution_digest` 存在**且都是 `IMMUTABLE` 的**（`pg_proc.provolatile = 'i'`，与 v1.6 那条 `provolatile` 断言是同一种检查：一个漏写 volatility 的迁移函数体逐字相同，差别只在这一列，而一个 `VOLATILE` 的规范化函数会让将来的派生列/函数索引建不出来）；⑪ 断言 `project_action_execution_digest_check` 存在**且是 `DEFERRABLE INITIALLY DEFERRED` 的**，并真的插一条 `execution_result_digest` 被伪造的 `DISPATCH_TASK` 行，断言 `COMMIT` 得到 `EXECUTION_DIGEST_MISMATCH`（只断言对象存在不够 —— 这一条要证明的恰好是"它在提交点真的会拒"）；⑫ **跑一次 §4.3 I17-A 的摘要那一半并断言返回 0 行**：`execution_context_digest` 与 `execution_result_digest` 各等于 `coordinator_execution_digest` 对自己那一半的重算值 —— 这一条比前三条都强，它不问对象在不在，它问存量数据对不对（与 v1.4 那条"直接跑一次 D13 的漂移查询"是同一种检查）。

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
- **D3（v1.4 重写，PC-CX-25）**：`dispatch_authority` **没有服务层写入点**。它是一个**派生列**，值恒等于
  `authorityOf(task) = (task.project_id IS NOT NULL ∧ project.coordinator_enabled) ? 'COORDINATOR' : 'LEGACY'`，
  由 §7.7 D8-a 的两个触发器在**每一次**下列写入时重算，无论写它的是哪一个版本的二进制、走的是服务层还是裸 SQL：
  1. `task.project_id` 被写（新建、填入、移出、跨 Project 移动）；
  2. `project.coordinator_enabled` 被切换（fan-out 到该项目全部 Task，按 id 升序取锁）；
  3. 任何人试图**直接写** `task.dispatch_authority` —— 触发器一律用派生值覆盖，因此**写不进一个错的值**。

  v1.2 这里写的是"恰好三处服务层写入点，每处都走同一个 primitive"，其中第三处是"占位释放时的补投影"。三处全在新服务层，于是旧写端做前两件事的任何一件都会留下 stale `LEGACY`，而 D6 会按这个陈旧值放行旧 sweep（`PC-CX-25`，P0）；第三处还额外要求在 `session` 之后回头写 `task`，是 §8.6 LO1 全序里唯一一处逆序。v1.4 把维护责任整体交给数据库，三处一起消失：**投影不可能陈旧，因为没有人在维护它** —— 它就是那个派生式本身。新鲜度由 §7.7 D13 的漂移查询随时可验（I12-A）。

  **用户手动"开始执行"仍然不受 `dispatch_authority` 约束** —— 那是人的显式动作，走既有路径（`dispatch_origin = 'USER'`，D6 显式放行），并产生一条 `user.manual_trigger` 事件让控制环知道。
- **D4**：`task.autoRunWhenReady` 对 `COORDINATOR` 权的任务**无效**（它是 legacy sweep 的开关）。UI 必须据此说明，不能让用户以为关掉它就停了。
- **D5 / D6 / D7（v1.1 新增，见 §7.7）**：`dispatch_authority` 这一列本身只是一个**投影**，它回答"该由谁派"，但**不能**阻止别人派 —— 它只在读它的那个二进制里有效。真正阻止越权与重复的是 §7.7 的唯一索引（D5）与触发器（D6），D7 是让这两者在滚动升级期间连告警都不产生的部署顺序。**本节（§12.3）与 §7.7 的分工是：§12.3 说"应该由谁派"，§7.7 说"凭什么别人派不了"。** v1 只有前一半，因此 `PC-CX-02` 成立。

### 12.4 混合版本与客户端

| 组合 | 期望行为 |
|---|---|
| **新旧 apiserver 并存（滚动升级）** | 旧实例不认识 `project_event`，不消费；新实例正常消费。**新实例之间**由 fencing token 串行化（§8.1）；**新旧之间** fencing token 完全无效（旧实例根本不取租约），因此由 §7.7 的 D5 唯一索引（至多一条占位 Session）+ D6 触发器（`COORDINATOR` 权任务拒绝无派发权的插入）保证，两者都在数据库里执行，与二进制版本无关。D7 的两阶段部署使正常升级路径下连触发器都不会命中。**v1 在这一格里把"旧实例不消费事件"当成了"旧实例不会派发"，这两件事不相干** —— 旧实例的三条 legacy sweep 照样在跑（`PC-CX-02`）。**v1.2 又留下了这一格的第二个假前提**：D6 忠实执行 `task.dispatch_authority`，而那一列当时由**新服务层**维护，于是旧写端移动 Task 或结束占位都能留下 stale `LEGACY` 并被旧 sweep 合法放行（`PC-CX-25`，P0）。v1.4 起这一列由 §7.7 D8-a 的触发器维护、由 D13 的漂移查询可验，**这一格才第一次真的"与二进制版本无关"**。19/22 单元必须构造"**旧二进制的裸 SQL** 写 `task.project_id` + 新 Coordinator + 同一个 Task"的场景，而不只是旧 sweep 的 INSERT，也不是两个新实例。**v1.8 把这一格的第三个假前提也补掉了（`PC-CX-43..46`）**：D5 + D6 管的只是"谁派、派几条"，而"派出去的那一条与被冻结的那次决策是不是同一份"另有三条硬门 —— D11（动作行的状态转移与终态，含 §8.3 的发布语句本身）、D15（每一条语句上的 create 冻结集与 lineage）、D16（`COMMIT` 时的结果等式与 pin 账本）。v1.7 之前这三条各留了一个口子，因此任何写端（含旧二进制、裸 SQL）都能提交一份与冻结决策不同的结果、或把一条 live 占位写出 D5 的索引覆盖集。**六条对象合起来，这一格才对"动作与 Session 的冻结"也成立**（D16-d） |
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

- **AG1（v1.4 修订，PC-CX-27）**：聚合是**重算**，不是增量累加。输入是子任务当前状态集合，因此重复事件、乱序、并发完成都收敛到同一结果。**它没有幂等键**：正确形状是下面 AG5 的 current-state CAS。v1.2–v1.3 这一句的尾巴写着"幂等键的 epoch 取子状态摘要"，而 §7.3 / §8.2 / AG5 在 v1.3 已经把它冻结成无键 —— 同一件事在正文里有两套相反的规范，按哪一条实现都能引用"冻结"条款（`PC-CX-27`）。该尾巴已删除。
- **AG2**：聚合**自底向上**逐层进行，一次 reconcile 内可跨多层；成环由既有的 `parentTaskId` 约束与 `task-dag` 检查挡住，检测到环即开 `DEPENDENCY_CYCLE` blocker 并停止聚合。
- **AG3**：子任务从 DONE 被改回 OPEN（重开）时，父任务**必须跟着回退**（`DONE → OPEN`），否则聚合状态会单向锁死。这条要单独测。
- **AG4**：`completionPolicy` 对**没有子任务**的 Task 无效（不能靠"零个子任务全 DONE"把一个叶子任务判完成）。
- **AG5（聚合没有幂等键，v1.3 冻结，PC-CX-17）**：`AGGREGATE_PARENT` 是一次**对当前子状态的重算**，因此它的正确形状是一条**条件写（CAS）**，不是一条带永久键的账本动作：

  ```sql
  UPDATE task
     SET status = :recomputed              -- 由当前子状态 + completionPolicy 算出
   WHERE id = :parentId
     AND status IS DISTINCT FROM :recomputed
     AND status = :observedParentStatus;   -- CAS：快照里读到的那个值
  ```

  影响 0 行有两种含义，都不是错误：父状态已经等于重算值（无事可做），或父状态在读快照之后被别人改了（下一次 reconcile 会用新事实重算）。**它不进 `project_action`**，因此没有键可撞。

  v1.2 给它的键是 `aggregate:<taskId>:<childrenDigest>`，而 AG3 明确允许子任务 `DONE → OPEN → DONE`：第三次的 childrenDigest **回到**第一次的值，撞上历史 `APPLIED` 行，§8.5 C2 跳过副作用，父任务永久停在 `OPEN`。审查记为 `PC-CX-17`。**一个纯重算不需要幂等键**：幂等来自"重算"这个性质本身（AG1），给它加一个由可回环事实构成的永久键，反而把幂等变成了单次（§8.2 GE2）。审计仍在：每次实际改变父状态都落一条 `project_decision`，只是不占动作账本。

### 13.2 验证失败的原生退回（AC6）

既有 `task.verifiesTaskId` 表达"这个任务验证那个任务"。v1 让 verdict 产生**原生**后果，而不是靠提示词约定：

| verdict | 机械后果（`APPLY_VERIFICATION_VERDICT`） |
|---|---|
| `PASS` | 被验证任务保持 DONE；解除相关 `VERIFICATION_FAILED` blocker；下游解锁 |
| `FAIL` | ① 被验证任务 `DONE → OPEN`（原生退回）；② 建一条缺陷子任务（父 = 被验证任务，携带失败证据）；③ **阻断下游**：依赖被验证任务的任务不可派发；④ 开 `VERIFICATION_FAILED` blocker |
| `INCONCLUSIVE` | 不退回、不建缺陷；开 `VERIFICATION_FAILED` blocker（`owner = COORDINATOR`），并触发 `OPEN_COORDINATOR_TURN`（§7.2 的 `VERDICT`） |

- **V1**：verdict 的载体是**验证任务自身的终态 + 一条结构化结果**，不是自由文本。
- **V2**：重复 verdict **不重复退回、不重复建缺陷** —— 幂等键 `pc:v1:<projectId>:verdict:<verifierTaskId>:<verdictRevision>`（v1.3：v1.2 这里写的是 `<verdict>`，见 V7）。
- **V3**：下游阻断在**派发前置条件**里判定（§7.4 第 3 条），不是靠改下游任务的状态。改状态会让"为什么这个任务不能跑"变成一个需要考古的问题。
- **V4**：缺陷子任务修复完成后，被验证任务重新可派发；验证任务需**重新运行**才能给出新的 verdict（旧 verdict 不自动失效为 PASS）。
- **V5（既有教训）**：验证前置检查**不得**用 `numTurns` 判"这个任务从没执行过" —— `numTurns` 只在 turn 结束才落库，而 DONE 常常写在 turn 内，于是恒判"无执行记录"。判据用 Session 的存在与终态，不用回合计数。
- **V6（既有教训）**：验证任务可能在运行中被连同 fixture 一起删除。`APPLY_VERIFICATION_VERDICT` 必须容忍 subject 消失：找不到就记 `SUPERSEDED`，不报错、不卡住。
- **V7（verdict 代次，v1.3 冻结，PC-CX-17）**：V2 的"重复 verdict 不重复退回"与 V4 的"验证任务可以重新运行"在 v1.2 里用**同一个键** `verdict:<verifierTaskId>:<verdict>` 表达，而 verdict 只有三个取值：`FAIL → 人修好 → 再跑 → 又 FAIL` 的第二次撞上历史 `APPLIED` 行，§8.5 C2 跳过全部机械后果 —— 被验证任务**留在 DONE**、没有新的缺陷子任务、下游**没有**被重新阻断。这是本轮六项里后果最重的一项（AC6 直接失效）。

  修法与 `dispatch_attempt` 同型：验证任务自己那一行上加 `task.verdict_revision BigInt NOT NULL DEFAULT 0`，**单调递增、永不复用、任何路径不得清零**。写入一条 verdict 的那个事务（它本身就是 §13.4 AE6 的验收事实写入，因此已经持有 LO1 的锁）在同一事务里 `UPDATE task SET verdict_revision = verdict_revision + 1 WHERE id = :verifier RETURNING verdict_revision`，动作键取这个返回值：

  > `pc:v1:<projectId>:verdict:<verifierTaskId>:<verdictRevision>`

  两个推论与 DA2 逐字相同：同一份快照被重复 reconcile 算出**同一个** revision ⇒ 同一个键 ⇒ 副作用恰好一次（V2 保住）；一次**真正的新 verdict** 算出**新的** revision ⇒ 新键 ⇒ 退回/缺陷/阻断三件事再次发生（V4 兑现）。`verdict` 值本身仍然在键里没有位置 —— 它是一个能回到旧值的事实（§8.2 GE2）。

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
  mergeEvidence    : sorted[(requirementId, targetBranch, contentHash, refGeneration)] // 目标分支内容变就变
}))
```

- `contentHash` 按**内容**取（第 6 条），例如被要求的改动在目标分支上的 blob/tree 摘要或 `git grep` 归一化结果，**不是** `git branch --contains` 的布尔值，也不是 commit SHA —— squash 之后 SHA 必然对不上而内容仍在。
- `taskSet` 里带 `status` 而不只是 id：一个 Task 从 DONE 被改回 OPEN，id 集合没变，摘要必须变。
- `refGeneration`（v1.3 新增，PC-CX-18）：Git 的 ref 是**数据库外部**的事实，本文的任何行锁都锁不住它。`refGeneration` 是 AE9 定义的、由**唯一支持的写入口**推进的单调计数，它让"目标分支在验收之后动过"成为一个**数据库里能看见**的差异。没有它，`contentHash` 相同就无法区分"没动过"与"动过又改回来了"（后者对 squash / force-push 是真实可能的）。

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

**AE6（验收事实写入门，v1.3 重写，PC-CX-18 / PC-CX-19）**：下列写路径构成**封闭的"验收事实写入"集合**。v1.2 的这张表是**手写**的，于是漏掉了三条真实存在的写路径（Task 跨 Project 移动、`verifiesTaskId` 改写、外部 target ref 变化），而"封闭"这个词让下一个人以为不必再找。v1.3 把它**从 AE1 的四个投影反推**出来 —— 每一行都必须说明它改的是哪个投影，而每个投影的写路径必须被穷举：

| 投影 | 写路径（穷举） | 备注 |
|---|---|---|
| `criteriaRevision` | `project.acceptance_criteria` 编辑 | 用户 / MCP / CLI 同一段服务层（AE5） |
| `taskSet` | Task 创建 / 删除 | |
| `taskSet` | Task 状态变化（含验证退回的 `DONE → OPEN`） | |
| `taskSet` | Task `completionPolicy` 变化 | |
| `taskSet` | **`task.project_id` 写入：移入、移出、跨 Project 移动** | **v1.3 新增**；同时改变两个 Project 的投影，锁与重开见 AE10 |
| `verdicts` | 验证 verdict 写入 / 改写 | 代次见 §13.2 V7 |
| `verdicts` | **`task.verifies_task_id` 写入 / 清空 / 改指** | **v1.3 新增**；它决定哪些 verdict 属于这个 Project 的哪个 Task |
| `mergeEvidence` | 合并证据行写入（含 `contentHash` 与 `refGeneration`） | 唯一支持的写入口见 AE9 |

**AE6-a（取锁，v1.3 修订）**：每一条**必须以 `SELECT 1 FROM project WHERE id = :p FOR NO KEY UPDATE` 作为事务里对 project 的第一次访问**（涉及两个 Project 时按 AE10 取两把）。v1.2 这里写的是 `FOR SHARE`，而 AE8 随后要 `UPDATE` 同一行 —— 那是一次**锁升级**：两个并发写入者可以同时持有相容的 `FOR SHARE`，然后各自等对方释放才能升级，真实 Postgres 上一方直接拿到 `40P01 deadlock detected`（`PC-CX-19`）。§8.6 LO3 因此禁止升级：一开始就取那把**随时可能用到**的锁。代价是同一 Project 的验收事实写入之间排队；`FOR NO KEY UPDATE` 不与外键检查的 `FOR KEY SHARE` 冲突，因此其它引用这个 Project 的写入完全不受影响。

**AE6-b（不在表里的写不取锁）**：改标题、改描述、加标签、排依赖**不取这把锁**，因为它们改不了摘要，也就没有与 `DONE` 排序的必要。

**AE6-c（封闭性是可测的，v1.3 冻结）**：本表由 AE1 的投影反推，因此**契约测试可以从 `acceptanceDigest` 的字段集自动生成"应有的 mutator 集合"并与本表逐条比对**：往 digest 里加一个字段而不在这里加对应的写路径 —— 或者反过来，服务层多出一条能改摘要的写路径 —— 测试立刻红。"封闭"从此是一条断言，不是一个形容词。

**AE7（`DONE` 硬门取排他锁，v1.2 冻结）**：把 `project.status` 写成 `DONE` 的事务，**第一句**必须是 `SELECT … FROM project WHERE id = :p FOR UPDATE`，然后才执行 AE2 的三步。`FOR UPDATE` 与 AE6 的 `FOR NO KEY UPDATE` **相冲突**，因此：

- 任何一个已经开始、尚未提交的验收事实写入，都会让 `DONE` **等**到它提交为止 —— 然后 AE2 第 1 步的重算（锁已持有之后的一条**新语句**，READ COMMITTED 取新快照）必然看见它，摘要不匹配 ⇒ 拒绝；
- 任何一个在 `DONE` 之后到达的验收事实写入，都会**等**到 `DONE` 提交，然后走 AE8。

"两个事务都能提交"这个第三种结果因此在物理上不存在。这就是审查要的"共同线性化门"：**它是一把锁，不是一个约定**。

**AE8（终态后的事实写入 ⇒ 原子重开，v1.2 冻结，v1.4 修订锁名 PC-CX-27）**：持有 AE6-a 那把 `FOR NO KEY UPDATE` 的写入者，在锁到手之后**必须重读 `project.status`**；若已是 `DONE`，它必须在**同一个事务**里把 `status` 改回 `OPEN`，并写一条 `user.project_edited` 事件与一行 `reopened_by_fact_change` 审计（记明是哪一项事实变了）。**不允许**提交一个"`DONE` + 与之不匹配的验收事实"的状态（I10）。**锁名这两个词是规范的一部分**：v1.3 在 AE6-a 把它改成 `FOR NO KEY UPDATE`（LO3 禁止升级，`PC-CX-19`），却把本条里的 `FOR SHARE` 留在了原地 —— 照本条字面实现就会复活那个真实的 `40P01`（`PC-CX-27`）。§22 的残句账把这两个词列为必须消失的其中一条。

三条推论，每条都要测：

1. 守卫 1（`DONE ⇒ SETTLED`）**不需要放松**。v1.1 的漏洞不在守卫上 —— 守卫是对的，是那个状态组合本来就不该存在。把不一致的状态**变成不可达**，比让守卫去容忍它更强，也更好测：I10 是一条可以对生产快照直接跑的 SQL。
2. 重开走的是 TS3（`SETTLED → 非终态`），落到哪个状态由守卫重算，**不预设** `PLANNING`（例如仍有 open blocker 就直接落 `BLOCKED`）。
3. `CANCELLED` **不适用**本条：取消是人对"这个项目不做了"的决定，一个 Task 的状态变化不该把它撤销。AE6 的写入者读到 `CANCELLED` 时照常提交自己的写，**不重开**。

**AE9（外部 target ref：唯一权威表示、唯一写入口、post-DONE 协议，v1.3 冻结，PC-CX-18）**：`mergeEvidence` 是四个投影里**唯一一个描述数据库外部世界**的。v1.2 声称 AE6/AE7 的项目行锁给了验收事实"共同线性化点"，这句话对前三个投影成立，对它**不成立**：一次 `git push` 不会取任何 Postgres 行锁，也不会产生任何事务。诚实的写法只有一种 —— 说清楚这里买到的是什么，没买到什么。

- **AE9-a（唯一权威表示）**：`DONE` 断言的**不是**"目标分支现在是这个样子"，而是"**在 `refGeneration = g` 被观测到的那份内容上**，验收逐条通过"。权威表示是数据库里的合并证据行 `(requirementId, targetBranch, contentHash, refGeneration)`，**不是** Git 仓库本身。契约里任何一处都不得写成"锁住 ref"。
- **AE9-b（唯一写入口）**：合并证据只能由**一个**写入口产生 —— 合并证据写入器（它订阅 §5.3 的 `merge.*` 事件，也可被显式重验触发）。它读目标分支、按 §13.4 第 6 条**按内容**算 `contentHash`（不用 `--contains`，squash 之后必假阴性），与该 `(project, targetBranch)` 上的最新一行比较：内容相同则只更新观测时间；**内容不同则 `refGeneration + 1` 并插入新行**。`refGeneration` 单调、不复用（§8.2 GE1 的同一条纪律）。任何绕过它直接写 `contentHash` 的代码路径都让 AE6-c 的封闭性失效。
- **AE9-c（post-DONE 协议）**：合并证据写入器是 AE6 的写入者，因此它取 AE6-a 的锁、走 AE8：项目已 `DONE` 而新证据与旧证据不同 ⇒ **同一事务里重开为 `OPEN`**，写 `user.project_edited` 事件与 `reopened_by_fact_change` 审计（记明是 ref 变了、旧新 `refGeneration` 各是多少）。
- **AE9-d（诚实的边界）**：一次**不经过 Orbit 的** push 在它被观测到之前，数据库里没有任何东西会变。因此本条给出的保证是**有界延迟的检测 + 原子重开**，不是互斥。观测点恰好两个：(i) 任何 `merge.*` 事件（Orbit 自己的合并路径、以及配置了 webhook 的仓库都会到达这里）；(ii) 一次显式重验（用户、CLI、或 23 单元的项目验收）。**两个观测点之间的窗口是真实存在的，本文承认它**，并给出一条任何人都能跑的漂移判据：对每个 `status = DONE` 的项目，重跑 AE9-b 的读法并与最新证据行比较，不同即漂移。把它写成一条定时任务是 20/23 单元的选择，不是本文的强制 —— 但**假装行锁能覆盖它是被禁止的**。

**AE10（跨 Project 移动：两把锁、两次重开，v1.3 冻结，PC-CX-18）**：`task.project_id` 的写入同时改变**两个** Project 的 `taskSet`，因此：

1. 按 §8.6 LO2 **对两个 project 行按 id 升序各取一把 `FOR NO KEY UPDATE`**，然后才写 task 行（LO1：project → task）。反向移动取到的是同一顺序，因此 A→B 与 B→A 并发不会成环。
2. **两个 Project 各自独立走 AE8**：源项目若已 `DONE`（少了一个 Task，摘要变了）重开，目标项目若已 `DONE`（多了一个 Task）也重开。v1.2 的漏洞正是这里 —— §12.3 D3 早就写明存在"Task 填入/移出 `projectId`"的写路径，而 AE6 那张手写表里没有它，于是一个已 `DONE` 的项目可以被另一个事务悄悄改掉它的 taskSet（`PC-CX-18`）。
3. 从"没有 Project 的 Task"（§12.2 的约 11 万行）移入时只有目标 Project 需要锁与重开；移出到"没有 Project"时只有源 Project 需要。
3b. **（v1.4 新增，PC-CX-21）持有占位的 Task 不得移动**：§7.7 D10 的可延迟约束触发器在提交时拒绝，错误码 `TASK_CLAIMED_PROJECT_MOVE`。理由不是验收摘要，是**派发归属**：一条在飞 Session 的动作行属于源 Project，移动之后 I11-A 的 `a.project_id = t.project_id` 立刻为假，而 D9 声明在 `session` 的三列上、根本不会因为这次写而执行。调用方的确定性出路恰好两条：等这次运行结束，或先取消它。
4. **不要把外键的锁当成这把锁**（真实 Postgres 上量过）：`task.project_id` 是外键，写它会让 Postgres 对被引用的 project 行取 `FOR KEY SHARE`，而 `FOR KEY SHARE` 与 AE7 的 `FOR UPDATE` **冲突** —— 于是"移动先、`DONE` 后"这一个方向**碰巧**被排上了序，`DONE` 等锁后重算、发现摘要变了、正确地拒绝。这不是一个门：它只存在于这一个投影（另外三个投影的写不碰 `project` 的任何外键），而且在"`DONE` 先、移动后"那个方向什么也不做 —— 没有任何东西会让移动者去看一眼这个项目是不是已经 `DONE` 了，AE8 因此永远不触发。**一个只在一半方向上成立、且永远不重开的顺序，不能替代 AE10。**

**AE11（`acceptance` 的代次来源，v1.3 冻结，PC-CX-17）**：`project_runtime.acceptance_attempt BigInt NOT NULL DEFAULT 0`，**单调递增、永不复用、任何路径不得清零**。`RUN_PROJECT_ACCEPTANCE` 的键取**快照里读到的**值；`+1` 只发生在**动作行插入成功**的同一个事务里，与 fencing token 条件一起提交 —— 与 §8.2 DA2 逐字同型，因此两个推论也相同：同一份快照重复 reconcile 得到同一个键（副作用恰好一次），一次真正的重新验收得到新键（`FAIL → 改 → 再验收`不会被历史键吞掉）。v1.2 只写了 `<attempt>` 三个字而没有任何字段定义它，那等于把动作身份留给实现去发明（`PC-CX-17`）。

**AE4（不需要失效任务）**：**旧证据不需要被删除或标记失效** —— 它只是不再匹配。任何一项事实变化都会让摘要不同，因此过期证据在构造上不可用。这也意味着"改回去"是合法的：用户把验收标准改坏又改回来，摘要回到原值，原记录重新可用，这是正确的行为而不是漏洞。

**AE5（覆盖面）**：AE2 的硬门对**所有**写入路径成立 —— 用户在 Web 上点、CLI、MCP `project_update`、协调器在 turn 内调用，全部走同一段服务层校验。I1 说 `project.status` 只由人或 §13.4 的验收动作写，AE2 是那个"写"的唯一入口。

---

## 14. 12 条项目验收标准逐条映射

**分类列**：**业务** = 落在 `project`/`task` 的字段或既有业务语义；**基础设施** = 新表/新列/新服务；**复用** = 由 PAC 已冻结的条款承担，本项目不重复实现。

| # | 验收标准（摘要） | 落地条款 | 分类 | 单元 | 证明它的测试 |
|---|---|---|---|---|---|
| **AC1** | Project 绑定稳定 coordinatorAgent 与默认协调 Workspace；Coordinator Session 可轮换可恢复；公开 ID 全 Base62 | §1.2 · §7.5 · §2.2 | **复用**（Coordinator Agent = PAC §3.2 `project_member`；协调 Workspace = 既有 `coordinatorWorkspaceId`）+ **基础设施**（`coordinator_generation`） | 03 · 04 · 19 | 03 `+`轮换后 Agent 不变、generation+1 · 03 `-`第二个 Coordinator（PAC T2 并发写）· 04 `-`轮换到不同 workspace → 409 · `public-id-coverage.spec.ts` |
| **AC2** | 六类来源经事务 outbox 唤醒 reconcile；重复/乱序/重启不重复执行 | §5 全节（含 §5.5 EV1–EV6）· §8.3 | **基础设施**（`project_event`） | 05 · 06 · 07 · 08 | 05 `+`业务写与 outbox 原子提交/回滚 · 06 `-`事务回滚无孤儿事件 · 06 `+`batch 只产一条（N3）· 07 `+`多播只扇给相关项目（N2）· 08 故障注入：重复投递副作用恰好一次、乱序收敛、重启恢复 · 05 `+`出环项目（disabled / `SETTLED`）的事件被丢弃而非 reconcile，`disposition` 三值封闭且不产生任何动作/唤醒/WARN（EV1–EV6，v1.7）|
| **AC3** | 活性：OPEN 且不等人工时按时启动下一步，或持久化完整 blocker，不静默空转 | §10 全节（含 W5 全序与冻结时钟）· I5 · I15 · I18-A/B/C · I19-a/b/c · §5.5 | **基础设施**（`project_runtime.next_wake_at`、`project_blocker`、`project_event.next_attempt_at`） | 09 · 10 · 17 · 22 | 09 `+`SLO 内进入合法状态 · 10 §10.3 四条断言对故障注入全程成立（(a) 用 I11-A 的恒成立形式）· 10 `-`无 busy loop（W3）· 09 `-`只注册一个定时器（W1）· 09 `+`32 个原因组合各至多一条语义 turn（TU4/TU5）· 17 `+`限频窗内的第二个 manual trigger 不被消费、`nextWakeAt ≤ 窗口边界 + 5s`、到点恰好一次 turn（TR2-a–e / I18-C）· 17 `+``remaining ∈ {0,1,2,4,5,6,59}s` 与多 wake 组合下 `(nextWakeAt, nextWakeReason)` 唯一（W5，v1.6）· 10 `+`事件提交到 reconcile 的间隙落在 I18-B，躺过 5min 由 W4 第 (iv) 支命中（I19，v1.6）· 17 `+`同 source 同刻多候选的全排列给出同一对 `(nextWakeAt, nextWakeReason)` 与同一张 `wakeCandidates`（W5 第 2 条，v1.7）· 11 `+`同一份序列化 `decisionInput` 延迟 0/1/4 秒执行得到同一个 `nextWakeAt`（W5 第 3 条 · S5，v1.7）· 10 `+`每一条未消费事件恰好命中 I19 的一支（v1.7）|
| **AC4** | manual/guarded-auto/auto + 权限/并发/预算/重试/退避/审批边界；默认 guarded-auto | §9 全节（含 §9.6 CAP0/CAP4） | **业务**（`automationPolicy`/`coordinatorEnabled`/`maxConcurrentTasks`/`sessionBudgetPerDay`）+ **基础设施**（策略求值、`config_revision`） | 12 · 13 · 14 | 12 表驱动逐格覆盖 §9.2 · 12 `+`新建 Project 为 GUARDED_AUTO 且存量为 MANUAL（G1）· 14 `-`越权/竞态 fail closed · 14 `-`撤权后旧决策记 `AUTHORITY_REVOKED` 且不产生 Session（AU1，PG）· 14 `+`八格（四 mutator × USER_FIRST/COORDINATOR_FIRST）每条占位都满足 I16-A，无豁免（CAP3，PG）· 14 `+`调低 cap 永不被拒、在飞不动、over-cap 有界可见且自排空（CAP0/CAP4，PG）· 13 `-`执行上下文被撤销时记 `EXECUTION_CONTEXT_REVOKED` 且不产生 Session（EC3/D14，PG）· 14 `-`空 fallback 绝不换 Provider |
| **AC5** | 一致快照 + 记录每次判断的输入/决策/动作/幂等键 | §6.1（含 S9 · S10）· §6.2 · §8.2 | **基础设施**（`project_decision`、`decisionInputHash`） | 11 | 11 `+`输入内部一致且带租户边界 · 11 `+`同 hash ⇒ 同机械决策（S3，含时钟折成的到期事实与 manual 信号）· 11 `+`字段集由**六处读集**反推、双向比对（S8，含 §4.2 守卫、§7.6 TR1–TR3 与 §7.4 第 8 条的 PAC 解析链）· 11 `+`只差 Agent 默认引擎 / `workspace.enabled` 的两份状态得到不同 hash，删任一 S10 字段即回到同 hash 两结果（S10，v1.6）· 11 `+`两份只差一条未收敛验收动作的状态得到不同 hash 与不同 `run_state`（S9）· 11 `-`陈旧 token 提交被拒并触发新 reconcile · 11 `+`同 `decisionInputHash` ⇒ 同 `nextWakeAt`，且 `next_wake_at` 的写只来自 W5 或它列出的两处例外（S5 · W5 第 3/7 条，v1.7）· 11 `-``resolution`/输入出站为 base62（S2 / PAC B3） |
| **AC6** | 验证失败可原生退回、建缺陷子任务、阻断下游；不靠提示词 | §13.2 | **业务**（既有 `verifiesTaskId` 的语义扩展，**无新实体**） | 16 · 18 | 16 `+`FAIL 三件事都发生 · 16 `-`重复 verdict 不重复退回（V2）· 16 `-`下游未修复前不可派发（V3）· 18 属性测试固定 seed 可复现 |
| **AC7** | 父 Task/阶段的聚合完成策略，无需人工维护汇总节点 | §13.1 | **业务**（`task.completionPolicy`；阶段= 父 Task，**不新增实体**，§2.3） | 15 · 18 | 15 `+`ALL_CHILDREN_DONE / VERIFICATION_PASSED · 15 `+`多层子树自底向上 · 15 `-`子任务重开时父任务回退（AG3）· 15 `-`空父节点不自动完成（AG4）· 15 `+`并发完成幂等 |
| **AC8** | 六类情形都有结构化 blocker 与去重升级；不得静默 fallback | §11 全节 · §9.3 · §7.2 TF4 | **基础设施**（`project_blocker`）+ **复用**（kind 直接沿用 PAC §12 错误码） | 17 · 18 | 17 `+`每类 blocker 五字段齐全 · 17 `-`同因重复事件不新建行（§11.3 partial unique）· 17 `+`条件消失自动解除并重算（BL3）· 17 `-`未知失败 fail closed（BL2）· 17 `-`升级至多通知一次 · 17 `+`clear 后同因复发获得新 turn 而不是 no-progress（TF4）· 17 `+`两条同刻同 source 的 blocker 候选由 `(subjectType, subjectId)` 唯一裁决（W5 第 2 条，v1.7）|
| **AC9** | 崩溃/Session 结束/Runner 离线/接管/混合版本后能恢复，不丢任务、不重复启动、不越权 | §8.1 · §8.4 · §12.4 · §7.7 D8–D16（含 D14-f · D14-g · D11 的两个闭集 allowlist · D15-f · D16-d）· I7 · I17-A/I17-A2/I17-A3/I17-B | **基础设施**（fencing token、`project_action`、投影触发器） | 19 · 22 | 19 `-`旧 fencing token 提交影响 0 行 · 19 `+`两实例并发只有一个提交 · 19 `+`合法派发之后推进 token，I11-A 仍成立（PG）· 19 `-`在飞 Task 跨 Project 移动被拒（PG）· 19 `-`执行上下文被撤销后的占位在 `COMMIT` 被数据库拒绝，与二进制版本无关（D14，PG）· 19 `-`任何写端改写 `APPLIED` 行的冻结上下文 / `reason_code` 都被拒，逐列 mutation 由 schema 驱动（D11，PG，v1.7）· 19 `+`占位的 create 冻结列由 `execution_context` 构造并被数据库证明，`model`/`effort` 的三阶段代次两个方向都成立（D15 · I17-A/I17-A2，PG，v1.7）· 19 `-`§8.3 的发布 UPDATE 逐列 mutation 全拒、`CLAIMED` 的转移目标是闭集、终态不再出去（D11-f/D11-g，PG，v1.8）· 19 `-`任何写端都不能把一条 live COORDINATOR 占位写出 D5 的索引覆盖集，第二条占位仍然只拿到唯一冲突（D15-f · I17-A3，PG，v1.8）· 19 `+`提交点证明 Session 实际结果 = 动作冻结结果、代次与 `detail` 账本双向一致，缺账/多账/错代次全拒（D16，PG，v1.8）· 19 `+`Coordinator Session 死后轮换继续推进 · 22 端到端故障注入矩阵（§15） |
| **AC10** | Web/API/CLI 展示当前状态、最近决策、下一动作、阻塞、下次唤醒、验收证据；有可独立运行的测试 | §6.2 · §11.1 · §13.4 | **基础设施**（读接口） | 20 · 21 | 20 API/CLI/MCP parity + 鉴权 + 全 Base62 · 20 `-`陈旧/越权写入被拒 · 21 组件测试覆盖 loading/error/empty + 三策略 + 审批 + blocker + 离线 Runner + legacy Project · 21 `-`界面不得暗示 silent fallback |
| **AC11** | 既有 Project 默认兼容、不被意外开启自动推进；迁移后须显式选策略或沿用安全默认 | §12.1 · §12.2 · §12.3 · §7.7 D8-a · D13 | **业务**（策略字段）+ **基础设施**（迁移、投影触发器） | 03 · 04 · 22 | 04 `M`迁移后存量 `coordinator_enabled = false` / `MANUAL`（G1 两条都测）· 04 `M`迁移不产生事件/唤醒（G2）· 04 `M`空库+生产快照 `migrate diff` 为空（G4）· 04 `M`D13 漂移查询返回 0 行（G5）· 06 `+`无 Project 的 Task 派发逐字段不变（§12.2）· 14 `-`legacy sweep 不碰 `COORDINATOR` 权任务（D1）· 04 `M`I17-A 与 I17-A2 各返回 0 行、`disposition` 回填完成、D11 的逐列 mutation 全拒（G5 v1.7）· 04 `M`发布语句的逐列 mutation 全拒、create 冻结集由 PAC §6 生成、D5 谓词列不可被 UPDATE 移出、两条提交点约束触发器存在且可延迟（G5 v1.8）· 22 `-`旧二进制的裸 SQL 移动 Task 后投影仍不陈旧（PG） |
| **AC12** | 全部任务完成后执行项目级验收并核对合并状态，全 PASS 才可标 DONE | §13.4 · §9.2 最后一行 | **业务**（`project.status` 的写入门）+ **基础设施**（验收记录） | 23 | 23 `-`任一 FAIL 时标 DONE 被服务端拒绝（硬门，第 5 条）· 23 `+`全 PASS 后可标 DONE · 23 `+`合并核对按内容而非 `--contains`（第 6 条）· 23 `-`控制环任何策略下都不能自己标 DONE |

**总计**：业务字段 **5 个**（§2.2），新业务实体 **0 个**（§2.3），新基础设施表 **5 张** + 新列 **8 个**（§2.4）。
v1.1 相对 v1 只多了一列（`session.dispatch_origin`）与两个数据库约束对象（一个 partial unique index、一个 trigger，§2.4）。**新业务实体仍然是 0 个** —— 关闭两个 P0 靠的是把互斥挪进数据库，不是靠新概念。
v1.3 相对 v1.2 多一列（`task.verdict_revision`）、两个新表自己的列（`project_blocker.lifecycle_generation`、`project_runtime.acceptance_attempt`）与三个数据库约束对象（一个可延迟约束触发器、一个 CHECK、一个唯一索引，§2.4）。**新业务实体仍然是 0 个** —— 关闭这六项靠的是给已有的账本装上单调代次、给已有的锁排一个全序、让已有的触发器读它声称保证的那几列。
v1.4 相对 v1.3 多一列（`project.config_revision`）与三组数据库对象（一个可延迟约束触发器 D10、一个 `BEFORE UPDATE` 触发器 D11、一组投影触发器 D12/D8-a，§2.4），并**删掉**了一处服务层义务（§12.3 D3 的三个写入点）。**新业务实体仍然是 0 个** —— 关闭这七项靠的是把不变量的时态说清楚、把决策输入说全、给同时为真的原因排一个全序、把一个投影交给数据库自己算，以及让人工与控制环共用一把本来就存在的行锁。
**v1.8 相对 v1.7 一列都没加**：新增的只有一个数据库对象里的两条可延迟约束触发器（`session_execution_result_check` 与 `project_action_pin_ledger_check`，D16），其余三项都是**改写已有对象的判据**：D11 按 `OLD.status` 分两个闭集 allowlist、D9/D14/D15 的作用域读 OLD ∨ NEW、D15 的 create 冻结集按 PAC §6 的行数补齐并把 lineage 三列纳入冻结。**新业务实体仍然是 0 个** —— 关闭这四项靠的是问清楚"这条硬门之后还剩哪一次写、它的作用域由谁决定、它比对的那个封闭集合是不是真的封闭"，以及把一条自称双向的命题在两端各配一个对象。

**v1.7 相对 v1.6 一个业务字段都没加**：新增的是一列 `session.execution_pin_generation`（§4.3 I17-A2 的阶段与代次）、两列已有基础设施表自己的列（`project_action.execution_result_digest`、`project_event.disposition`）与一个数据库对象（`session_execution_snapshot_guard`，D15），外加把 D11 从 denylist 改成 allowlist。**新业务实体仍然是 0 个** —— 关闭这六项靠的是把一个封闭集合改成由构造封闭、把一条跨文档恒等式按被引用契约的冻结时刻拆成阶段与代次、给同时为真的唤醒候选补上持久的第三第四键、把最后一个游离的时钟收进 `evaluation.epoch`、把一条不变量的量化域说全并给出环的事件一条终态处置，以及把"还授不授权"与"结果一不一样"分成两个摘要各比各的。

v1.5 相对 v1.4 **一个业务字段、一张表、一列 `task`/`project`/`session` 上的列都没加**：新增的三列全在 `project_action` 这张已有的基础设施表上（`execution_context` / `execution_context_digest` / `reason_code`，§2.4 的"新表自己的列"），外加一个可延迟约束触发器与它读的只读函数（D14）。**新业务实体仍然是 0 个** —— 关闭这四项靠的是把 cap 的不变量按时态拆开（准入 / 提交时）、把 PAC 执行上下文的读集冻结下来并在提交点重解析、把决策实际读的动作历史投影进输入，以及把一次被限频的显式请求变成一条持久、有确定唤醒时刻的 pending 记录。

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
| **F16b** | 并发上限占满 | **无 blocker**：一条写明理由的 `NOOP` 审计行 + `nextWakeAt = evaluation.epoch + 60s` | 任一在飞 Session 结束即发事件，自然恢复 | §9.4 |
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

| **F28** | 一次合法派发之后，同一 Project 的下一次正常租约推进 token，而那条 Session 仍在飞 | I11-A 仍为真（`action.token <= runtime.token`）；I11-B 不再被要求 | 无需动作 | §4.3 I11 · §7.7 D9-e · §8.1 F0 |
| **F29** | 有占位的 Task 被要求跨 Project 移动 | 移动被拒，`TASK_CLAIMED_PROJECT_MOVE`；Task 与 Session 都不变 | 等运行结束或先取消，再移动 | §7.7 D10 · §13.4 AE10 第 3b 条 |
| **F30** | 旧二进制用裸 SQL 把 Task 移进/移出一个 `coordinatorEnabled = true` 的 Project，或结束一条占位 | `task.dispatch_authority` **仍然等于派生值**（I12-A）；D13 漂移查询返回 0 行 | 无需动作；旧 sweep 随后被 D6 拒绝 | §7.7 D8-a · D12 · D13 |
| **F31** | 用户在控制环决定派发之后、提交之前关掉 Coordinator / 降策略 / 调低 cap，或同时手动启动另一个 Task | 二选一且唯一：人工写先提交 ⇒ 该动作 `REFUSED(AUTHORITY_REVOKED)` 且**无 Session**；控制环先提交 ⇒ 人工写照常生效且此后无新自动派发。**任何顺序下每一条占位都满足 I16-A**（插入时读到 `count < max`，v1.5 修订，PC-CX-28） | 无需人工清理；控制环下一次 reconcile 按新授权重算 | §9.6 AU1 · CAP0 · CAP1 · §8.5 C6 |
| **F32** | 同一份输入同时命中多个语义 turn 原因 | 恰好一条 `OPEN_COORDINATOR_TURN`，`reasonCode` 由 TU4 的全序唯一决定；被压下的原因记在 `suppressedTurnReasons` | 无需动作；被压下的原因下一次仍为真则自然胜出 | §7.2 TU4 · TU5 · I15 |
| **F33** | 一条 `opensTurn` 的 blocker 被解决后，同一条件再次发生 | 新的 `lifecycle_generation` ⇒ 新的 `reasonDigest` ⇒ **一条新的 turn**；不是 `COORDINATOR_NO_PROGRESS` | 协调器照常处理这一次新故障 | §7.2 TF4 · §7.6 TR3 · §11.3 BE1 |

| **F34** | 控制环合法派发之后，用户把 `max_concurrent_tasks` 调低到小于当前在飞数 | 调低**成功**；在飞 Session **一条不动**；`inFlight > max` 是一个有界状态：期间任何入口都拿不到准入，随在飞结束单调收敛。审计与展示都看得见（`overCapBy`、`{oldMax,newMax,inFlightAtWrite}`）；**不开 blocker** | 无需人工动作；一条在飞结束即恢复准入 | §9.6 CAP0 · CAP4 · §4.3 I16-A/I16-B |
| **F35** | 用户在快照之后、提交之前撤销执行上下文（禁用 Agent / 移出团队 / 改任务指派或引擎 / 撤回 Provider / 软删 Workspace / Runner 离线 / 重绑协调 Workspace） | 二选一且唯一：人工写先提交 ⇒ 该动作 `REFUSED(EXECUTION_CONTEXT_REVOKED)`、`detail.revokedInput` 取 EC1 表序号最小的那一个、**无 Session**；控制环先提交 ⇒ 占位合法存在且提交那一刻 I17-B 为真，人工写随后生效、**在飞 Session 一条不动**，此后 I17-A 仍恒成立而"当前是否指向已禁用 Agent"**允许非零**（v1.6，PC-CX-34：那是一个有界、可见、会自己排空的残留，不是违约）。数据库侧由 D14 在 `COMMIT` 再证明一次，**与二进制版本无关** | 按 EC5 逐值确定：开对应 blocker 或记 `NOOP` 等下一次事件；`dispatch_attempt` 已前进，恢复后重派算出新键 | §7.4 EC1–EC5 · §7.7 D14 · §4.3 I17-A/I17-B |
| **F36** | 60 秒限频窗口内到达第二个（第 N 个）`user.manual_trigger` | 请求**不被消费**（`consumed_at IS NULL`）、`next_attempt_at` = 窗口边界、`next_wake_at ≤ 该边界 + 5s`（§10.4 W5 的 floor，v1.6）且窗口边界进 `wakeCandidates`、它胜出时 `next_wake_reason` 写明限频；一条写明 `windowEndsAt` 的 `NOOP`；**不开 blocker**。窗口一过，**一次** turn 回答掉当时全部 pending 请求并把它们一起消费 | 无需人工动作；到点自动开 turn。请求不丢、不排队、不忙等 | §7.6 TR2-a–TR2-e · §7.2 TF5 · §10.4 第 7 条 · W5 · §4.3 I18-C |

| **F37** | 一条 `user.manual_trigger` 已提交，reconcile 还没跑（正常异步间隙），或消费者进程死了 | `consumed_at IS NULL ∧ next_attempt_at IS NULL ∧ attempts = 0`（I18-B），`next_wake_at` 可以合法为 `NULL`；躺过 5min 即被 §10.2 W4 第 (iv) 支命中并记 WARN | 无需人工动作：消费者、任何一次因别的原因发生的 reconcile、backstop 三条路各自独立（I19）；三条都断才丢 | §4.3 I18-B · I19 · §10.2 W4 (iv) · §5.4 |
| **F38** | 限频窗口只剩不到 5 秒，同一时刻还有别的唤醒源（`runAt` / 退避 / blocker `nextCheckAt` / 在飞 Session） | `nextAttemptAt` 恒为窗口边界；`nextWakeAt = max(min(全部候选), evaluation.epoch + 5s)`，并列按 §10.4 第 1–7 条的序号、再按 `(subjectType, subjectId)` 裁决（v1.7）；`nextWakeReason` 取胜出候选，整张候选表落 `project_decision.detail.wakeCandidates` | 无需动作。被 floor 推迟最多 5 秒，到点时该候选的到期事实必然已为真 | §10.4 W3 · W5 · §7.6 TR2-d/TR2-e · §4.3 I18-C |

| **F39** | 任何写端（含旧二进制、裸 SQL）改写一条已 `APPLIED` 动作行的 `execution_context` / `execution_context_digest` / `execution_result_digest` / `reason_code` | 改写被拒，`ACTION_APPLIED_IMMUTABLE`（错误消息含被改的列名）；动作行与它的 Session 都不变；I17-A 与 TR2-a 的窗口锚点都不动 | 无需动作。要补写只剩 `result_session_id` / `detail` 两列，它们不进任何谓词 | §7.7 D11（v1.7 闭集 allowlist） |
| **F40** | 一条 COORDINATOR 占位走完它的正常生命周期：create（PENDING）→ 首次 claim materialize `model`/`effort` → 模型被 runtime 下架，`retiredPin` 改写一次 | 三个阶段各有一个恒成立的判据（I17-A2）：代次 0 ⇒ 两列为 NULL；代次 1 ⇒ 与冻结值相同（冻结值为空时记 `DEFERRED_TO_CLAIM` 并把实际值写进 `detail.claimResolution`）；代次 2 ⇒ 恰好一条 `detail.retiredPins[]`。**create 冻结列全程不变**（I17-A） | 无需动作。`retiredPin` 是 PAC §6 保留的合法改写，它**必须**同时把代次 +1 并留记录，这就是它与一次静默改写的全部区别 | §4.3 I17-A · I17-A2 · §7.7 D15 · PAC §6 |
| **F41** | 一条未消费的事件，其 Project 已经出环（从没启用 / 被关掉 `coordinatorEnabled` / `status ≠ OPEN` / `run_state = SETTLED`） | 事件被**丢弃**而不是被 reconcile 消费：`consumed_at` 非空、`disposition = 'DISCARDED_OUT_OF_LOOP'`；**不取租约、不产生任何动作 / blocker / 唤醒 / 通知 / WARN**，`project_runtime` 一列不动 | 无需人工动作。项目重新在环（G3 启用 / §13.4 AE8 原子重开）之后到达的事件按 EV1 在**被取到的那一刻**重新判定，得到的是消费而不是丢弃 | §5.5 EV1–EV6 · §4.3 I6 · I19-c |
| **F42** | 决策之后、提交之前，`agent.default_effort` / `agent.required_capabilities` / `task.required_capabilities` 被改，而 EC2-a 的九个身份**一个都没变** | 该动作 `REFUSED(EXECUTION_RESULT_CHANGED)`、`detail.changedComponents[]` 按名称字母序、**无 Session**；**不开 blocker**，一条写明 `execution_result_changed` 的 `NOOP`；`dispatch_attempt` 已前进 | 无需人工动作：那次写入本身产生事件，下一次 reconcile 按新事实算出新的执行上下文与**新的键**重派 | §7.4 EC2-b · EC2-c · EC3 · EC4 · EC5-a · §7.7 D15 |
| **F43** | 任何写端在 §8.3 的**发布语句**里（`CLAIMED → APPLIED/REFUSED/SUPERSEDED`）顺手改写身份、归属、`execution_context`、两个摘要或 `reason_code` | 整条 UPDATE 被拒，`ACTION_PUBLISH_IMMUTABLE`（错误消息含被改的列名）；发布语句只剩 `status` / `refusal_code` / `result_session_id` / `detail` 四列可写，干净的发布照常提交；`CLAIMED → 闭集之外`与`终态 → 任何状态`得到 `ACTION_TRANSITION_ILLEGAL` | 无需动作。要补写的东西必须在插 `CLAIMED` 那一步就写对 —— 那一步之后所有硬门都已放行 | §7.7 D11 · D11-f · D11-g |
| **F44** | 一条 COORDINATOR 占位的 `permission_mode` / `resolution` / `snapshot_frozen_at` 与它动作行冻结的那一份不同（插入时写歪，或事务中途改歪） | 插入时被 `EXECUTION_SNAPSHOT_MISMATCH` 拒（D15），事务中途改则被 `EXECUTION_SNAPSHOT_FROZEN` 拒；无论语句顺序如何，`COMMIT` 还会由 D16 以 `EXECUTION_RESULT_MISMATCH` 再拒一次，并同时要求动作行已 `APPLIED` | 无需动作：三列都从 `execution_context` 逐字复制（EC6-a / EC6-d），写不出第二份 | §7.7 D15 · D16 · §7.4 EC2-b · EC6-a · EC6-d · PAC §6 |
| **F45** | 一条已合法提交、仍在 `PENDING`/`RUNNING` 的 COORDINATOR 占位，被一条 UPDATE 改成 `task_id = NULL, dispatch_origin = 'USER', project_action_id = NULL` | 改写被拒，`EXECUTION_SNAPSHOT_FROZEN`（D15 的 lineage 分支，作用域读 OLD 因此改不掉）；D5 的唯一 claim 不被释放，同一 Task 的第二条 live Session 照常在索引上冲突并按 §7.7 D5 表得到确定结果 | 无需动作。释放 claim 只剩改 `status` 一条路（跑完 / 失败 / 取消 / 停在 `AWAITING_INPUT`），那条路上 Session 与动作行始终互指 | §7.7 D15-a · D15-f · D9 · D14 · D5 · §4.3 I17-A3 |
| **F46** | `session.execution_pin_generation` 与动作行 `detail` 上的 `claimResolution` / `retiredPins[]` 对不上：缺账、多账、或代次跳号 | `COMMIT` 被 `EXECUTION_PIN_LEDGER` 拒，两个方向各有一条可延迟约束触发器（Session 侧、动作侧），因此先写哪一张表都一样；合法的首次 claim 与 `retiredPin` 照常提交 | 无需动作：代次 +1 与账本追加必须在同一事务里，这就是它与一次静默改写的全部区别 | §7.7 D16 · D16-a · D16-b · §4.3 I17-A2 |

| **F47** | 一条冻结成 `model-v1` / `high` 的派发，其首次 claim 把 Session 写成 `model-evil` / `low`，并在动作行上记一个空的 `claimResolution`（或一份与冻结分量不符的 `frozen`） | `COMMIT` 被 `EXECUTION_PIN_LEDGER` 拒。冻结分量是具体值时 `claimResolution.<component>.value` 只能是它本身、且必须逐字等于 Session 上那一列；冻结分量是 `DEFERRED_TO_CLAIM` 时必须在**同一事务**里记下实际解析到的值，`source` 也必须是 `RESOLVED_AT_CLAIM` | 无需动作：合法的首次 claim 照常提交，它只需要把"实际取到了什么"与代次写在同一个事务里。真的解析到了别的模型 ⇒ 那不是一次 claim，是一次**新的**决策，按 §7.4 EC3 的 `EXECUTION_RESULT_CHANGED` 走 | §7.4 EC6-c · EC6-e · §7.7 D16 · §4.3 I17-A2 · PAC §6 |
| **F48** | 一条 `DISPATCH_TASK` 动作行带着**内容正确的** `execution_context` 与一个**伪造的** `execution_context_digest` / `execution_result_digest` 被提交（旧二进制、裸 SQL，或发布语句之前就写歪） | `COMMIT` 被 `EXECUTION_DIGEST_MISMATCH` 拒。两个摘要各按 EC2-d 的权威输入用 `coordinator_execution_digest` 重算一次；`authorization` 少键、多键，或两半共享的分量不一致，同样被拒 | 无需动作：两个摘要必须在插 `CLAIMED` 那一步就由同一个函数算出来。**审计侧不再需要事后发现它** —— 这一格从"只由 I17-A 的查询发现"变成"提交不进来" | §7.4 EC2-a · EC2-b · EC2-d · §7.7 D17 · D14-h · §4.3 I17-A |
| **F49** | 动作行的 pin 账本在形状上说不出话：`claimResolution = {}`、`retiredPins = [{}]`、`retiredPins[0].from` 接不上上一条的 `to`、代次与数组位置对不上、或时刻倒流 | `COMMIT` 被 `EXECUTION_PIN_LEDGER` 拒。两本账各有一张**闭合**的键表（EC6-c），整条链按 EC6-e 折叠出来的那一对值必须逐字等于 `session.model` / `session.effort`；判定由两条触发器共用的 `coordinator_pin_ledger_fold` 做，因此两侧不可能各有一套标准 | 无需动作：一次合法的 `retiredPin` 本来就知道自己换掉了什么、换成了什么、什么时候、为什么，把它们写下来就是这条记录 | §7.4 EC6-c · EC6-e · §7.7 D16 · D16-b · D16-f · §4.3 I17-A2 |

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

以下 5 条是 v1.4 为关闭 `PC-CX-21..27` 新增的：

21. **不变量必须写成时态明确的形式**（I11-A / I11-B、§8.1 F0）。"等于当前 token"看起来更严格，实际上是一条**会被系统的正常运转弄假**的话。恒成立的部分用单调关系与被反向约束钉住的历史列表达，点态的部分明确写成"只在提交时被要求"。**一条会自己变假的不变量比没有不变量更坏** —— 它会让下一个人去修一个没有坏的东西。
22. **一条硬门读到的每一行，都必须有封闭的 mutator 协议**（D10 / D11）。D9 读 `task.project_id` 与 `project_action` 的六列，那就必须有东西保证这些列在它证明之后不再变。这是 `PC-CX-09` / `PC-CX-20` 同一教训的第三次：**"那一刻成立"不是"一直成立"**。
23. **决策输入必须包含决策实际读到的全部东西，包括时钟与被请求的事件**（§6.1 S3/S5/S7/S8）。把时钟排除在 hash 之外看起来是为了让 hash 稳定，实际是让"同 hash ⇒ 同决策"变成一句假话。正确做法是把时钟折成**冻结的到期事实**，让它既进 hash 又不让 hash 每秒都变。
24. **同时为真的原因用全序裁决，不用手写互斥**（TU4）。与 §4.2 RS0 是同一个决定：手写的互斥在下一个事实组合上必然漏，而全序天然完备、与遍历顺序无关。
25. **一个必须永远正确的投影，不能由服务层维护**（D8-a / D12）。判据与 D5/D6 当初进数据库时逐字相同：要挡住的入口里有一个是"另一个版本的旧代码"。代价是一个由数据库代为发起的逆序锁访问（D8-e），它 fail closed；买到的是"投影不可能陈旧"，而且不需要任何一次部署做对。

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
| 01C | 修订 `PC-CX-15..20` | §21 全表 | 同上；真实 Postgres 覆盖 authority flip、`DONE` × 验收事实写、并发事实写与派发归属（§21.5 / §21.6） |
| 01D | 修订 `PC-CX-21..27` | §22 全表 | 同上；真实 Postgres 覆盖 I11-A 在 token 前进/Task 移动下的稳定性、旧二进制写端下的投影新鲜度、撤权与 cap 的双事务 barrier（§22.1 / §22.5 / §22.6） |
| 01E | 修订 `PC-CX-28..31` | §23 全表 | 同上；真实 Postgres 覆盖 cap 降低与派发的两个提交顺序、执行上下文撤权的提交时门、限频窗口内的显式请求持久化（§23.1 / §23.2 / §23.4） |
| 01F | 修订 `PC-CX-32..36` | §24 全表 | 同上；真实 Postgres 覆盖 `pg_proc.provolatile` 与真实 deferred trigger 的调用、I17-A/I17-B 的八个撤权 × 两个提交顺序、窗口末端的 wake 代数、事件提交到 reconcile 的间隙（§24.1 / §24.3 / §24.4 / §24.5） |
| 01G | 修订 `PC-CX-37..42` | §25 全表 | 同上；真实 Postgres 覆盖 D11 的 schema 驱动逐列 mutation、D15 的三阶段与四反例、W5 的全序与冻结时钟、出环事件的终态处置（§25.1 / §25.2 / §25.3 / §25.4 / §25.5 / §25.6） |
| 01H | 修订 `PC-CX-43..46` | §26 全表 | 同上；真实 Postgres 覆盖发布语句的逐列 mutation、PAC §6 全量 create 冻结集在插入与提交两点的等式、D5 谓词列的 lineage 冻结与第二条 live Session、pin 账本的双向可延迟证明（§26.1 / §26.2 / §26.3 / §26.4） |
| 01I | 修订 `PC-CX-47..49` | §27 全表 | 同上；真实 Postgres 覆盖首次 claim 的 concrete/deferred 两支与冻结结论的逐字段绑定、两个摘要在提交点的重算与键序无关的规范化、pin 账本的闭合形状与折叠回 Session 的链（§27.1 / §27.2 / §27.3） |
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

> **本节是非规范的（non-normative）修订日志**（§0 RL1，v1.4 冻结）。它记录 v1.1 当时的事实与当时的推理，**不是现行规范**；任何一句与 §1–§18 冲突时一律以 §1–§18 为准。历史形状只允许出现在这里和反例测试里（`PC-CX-27`）。

> **怎么读 §19–§21**：这三节是**修订日志**，记录每一轮当时的答案与当时的最小交错序列，因此它们引用的动作键是**那一轮**的。后续版本改过其中三个键（`blocker`、`verdict`、`acceptance`，均在 v1.3，§21），本文的**当前**键一律以 §7.3 的动作表与 §8.2 GE1 为准。日志不回写，理由与三份审查文档不回写相同：改掉历史会让"当时为什么这么想"变得不可复原。

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

> **本节是非规范的（non-normative）修订日志**（§0 RL1，v1.4 冻结）。它记录 v1.2 当时的事实与当时的推理，**不是现行规范**；任何一句与 §1–§18 冲突时一律以 §1–§18 为准。历史形状只允许出现在这里和反例测试里（`PC-CX-27`）。

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

## 21. `PC-CX-15..20` 修订闭环（v1.3）

> **本节是非规范的（non-normative）修订日志**（§0 RL1，v1.4 冻结）。它记录 v1.3 当时的事实与当时的推理，**不是现行规范**；任何一句与 §1–§18 冲突时一律以 §1–§18 为准。历史形状只允许出现在这里和反例测试里（`PC-CX-27`）。

02 对 v1.2 的独立复审（[`project-coordinator-contract-review-02-v1.2.md`](./project-coordinator-contract-review-02-v1.2.md)）判 **FAIL / BLOCKED**，给出 6 个 P1。本节是**逐项关闭的索引**，格式与 §19 / §20 相同。**三份审查文档都不因本次修订而改动** —— 它们记录的是 v1、v1.1 与 v1.2 的事实，那些事实没有变；变的是契约。

六项里有四项的形状是同一个，而且是 v1.2 自己的修法**只做了一半**留下的：v1.2 学会了"把随时间前进的量赶出摘要"（TF1）和"用只进不退的计数当动作身份"（DA1），但**只在它当时正在看的那两个地方**做了。于是 `occurrences` 从 turn 摘要里被拿走、却还留在升级条件里（`PC-CX-15`）；`dispatch` 拿到了单调 epoch、而 blocker / verdict / aggregate / acceptance 四个键仍然由可回环的事实或一个没有定义的词构成（`PC-CX-16` / `PC-CX-17`）。另外两项则是 v1.2 新装的那些锁本身的账没算清：一张手写的"封闭集合"漏掉三条写路径（`PC-CX-18`），一次 `SHARE → UPDATE` 的锁升级在真实服务器上死锁、而 §8.1 F3 又同时宣称不许取第二把锁（`PC-CX-19`）。最后一项是把 v1.1 的老毛病挪了个位置：一条硬门读的列不是它声称保证的列（`PC-CX-20`）。

v1.3 的答案在四处：**一条代次纪律**（§8.2 GE1–GE4，管住五个永久动作键）、**一条重复投递等价性**（§11.5 ES5 / BL7，把"看见过几次"逐出全部判定）、**一个唯一锁序加有界重试**（§8.6 LO1–LO5，取代"不取第二把锁"）、以及**两个由数据库自己执行的归属约束**（§7.7 D9）。

| ID | 级别 | 规范条款 | 权威状态 | 动作键 | 恢复路径 | 可执行断言 |
|---|---|---|---|---|---|---|
| `PC-CX-15` | P1 | §11.5 ES4 · ES5 · BL7 · §9.4 · §7.2 TF1 · I14 | 同一份事实投递 N 次 ⇒ owner / `run_state` / 通知数 / 是否升级**逐字节相同**；升级只由存活时长触发，目标恒为 `USER` | 不变（`occurrences` 本来就不在键里）；变的是它也不再在**升级**里 | 条件消失 ⇒ BL3 自动解除；条件持续 30min ⇒ 一步升级到 `USER` 并通知一次 | `PC-CX-15 delivery count changes nothing a person or the control loop can see` |
| `PC-CX-16` | P1 | §8.2 GE1 · §11.3 BE1–BE3 · §7.3 | 同一 `dedupe_key` 上每个故障周期有唯一且单调的 `lifecycle_generation`；解除后复发**必然**得到一条新的 open blocker | `pc:v1:<p>:blocker:<kind>:<subjectId>:<lifecycleGeneration>` | open 周期内重复 ⇒ 同键、命中既有行；clear 后复发 ⇒ 新代次新键新行；接管窗口由两个唯一索引兜底 | `PC-CX-16 a blocker that comes back gets a new lifecycle generation` |
| `PC-CX-17` | P1 | §8.2 GE1–GE4 · §13.1 AG5 · §13.2 V7 · §13.4 AE11 · I13 | verdict / 聚合 / 验收三处的"第二次"都必须真的发生：退回+缺陷+阻断再来一遍、父状态等于当前重算、验收可重跑 | `verdict:<verifierTaskId>:<verdictRevision>` · `acceptance:<acceptanceAttempt>` · 聚合**无键**（CAS） | 修复后重新验证 ⇒ 新 revision ⇒ 机械后果重新发生；子树 `A→B→A` ⇒ CAS 每次落当前值 | `PC-CX-17 a fact that returns to an old value still gets a new action identity` |
| `PC-CX-18` | P1 | §13.4 AE1 · AE6 · AE6-c · AE9 · AE10 · I10 | 不存在 `DONE` + 不匹配的验收事实，**包括** Task 跨 Project 移动、`verifiesTaskId` 改写与外部 ref 变化 | `acceptance:<acceptanceAttempt>`；证据行带 `acceptanceDigest` 与 `refGeneration` | 数据库内的三类 ⇒ AE8 同事务重开；Git 侧 ⇒ AE9-d 的两个观测点检测到即重开（**有界延迟，不是互斥**） | `PC-CX-18 the acceptance-fact write set is derived from the digest, not hand-written` |
| `PC-CX-19` | P1 | §8.6 LO1–LO5 · §8.1 F3 · §13.4 AE6-a · AE7 | 全系统唯一锁序 `project → project_runtime → task → session`，**从不升级**；`40P01`/`40001` 有界重试后是有类型的冲突错误 | 不变 | 重试 ≤3 次且每次重读快照；仍失败 ⇒ 用户得到 `PROJECT_FACT_WRITE_CONTENDED`、控制环记 `LOCK_CONTENDED` 并 `nextWakeAt = now + 5s` | `PC-CX-19 one lock order, no upgrades, and a bounded retry` |
| `PC-CX-20` | P1 | §7.7 D6 · D9 · §2.4 · I11 | 已提交状态上，COORDINATOR 占位必对应一条**本 Task、本 Project、当前 fencing token** 下的 `APPLIED` `DISPATCH_TASK`；非 COORDINATOR origin 不得带动作 id | 不变（硬门是约束，不是键） | 违规入口的事务在 `COMMIT` 时被拒并回滚 —— **可见的失败**；控制环侧正常路径不受影响 | `PC-CX-20 attribution is proved on the committed state, not at insert time` |

### 21.1 `PC-CX-15` 投递次数不是事实

**最小交错序列**：

1. Provider `p1` 真实不可用。第一条 `provider.unavailable` 信号到达 ⇒ 开 `PROVIDER_UNAVAILABLE`（`SYSTEM` / `EVENT` / `opensTurn = ✘`），`occurrences = 1` ⇒ `run_state = BLOCKED`，0 条通知。
2. 世界**没有任何变化**：Provider 仍然不可用，`condition_version` 逐字节不变。
3. 同一个信号被重投 10 次（重启后重放、另一路事件源、心跳抖动）。§11.3 每次命中同一 open 行，`occurrences` 走到 11。
4. v1.2 §11.5 的触发条件是"存活 > 30min **或** `occurrences > 10`" ⇒ 第 11 次投递**当场**升级：`owner` 改成 `USER`、写 `escalated_at`、发一条通知 ⇒ `run_state` 变成 `AWAITING_HUMAN`，而且按 ES2 这个项目**可以合法地停掉自己的时钟**。

同一份世界事实，投 1 次和投 11 次得到**不同的责任人、不同的状态、不同的通知数、不同的时钟**。§9.4 还留着一条更旧的残文（`SYSTEM → COORDINATOR → USER` 的三级阶梯），与 ES3 冻结的"恰好一步"直接冲突 —— 同一个升级在两处有两个答案。

**Postgres MVCC 与锁语义**：这一项不靠锁。它靠的是 §11.3 那条 partial unique index 已经把"同一条件的第 N 次观测"收敛到**同一行的一次 `UPDATE`**：`occurrences += 1` 是那条 `UPDATE` 的副产品，行的身份（`dedupe_key`、`lifecycle_generation`、`condition_version`）逐字节不变。也就是说数据库早已把"是不是同一件事"回答清楚了，v1.2 却在应用层又拿那个副产品去做判定。**要害是：一个被去重机制自己产生的计数，不能反过来当作去重之外的事实。**

**权威状态**：I14。同一份事实投递 N 次后，`run_state`、每条 blocker 的 `owner`/`recovery`/`required_action`/`lifecycle_generation`/`condition_version`/`first_seen_at`/`escalated_at`、通知条数与是否升级，都与 N = 1 时相同（ES5）。升级的唯一触发是**存活时长**（ES4），唯一目标是 `USER`（ES3）。`occurrences` 与 `last_seen_at` 降级为展示字段（BL7）。§9.4 的三级阶梯残文已删除。

**动作键**：不变。`occurrences` 从 v1.2 起就不在任何键里（TF1），本项修的是它**在键之外**的最后一处影响力。这也是为什么 v1.2 的模型测试全绿却没抓到它：那些测试比的是 `reasonDigest`，而这一项改的是 blocker 行、`run_state` 和通知。

**恢复路径**：条件消失 ⇒ §11.4 BL3 重算条件、自动解除，与投递了多少次无关；条件真的持续 30 分钟 ⇒ 按 ES4 升级一次、通知一次、`run_state` 转 `AWAITING_HUMAN`，此后 §10.4 N-null 允许停钟。用户想要更早知道 ⇒ 调阈值，那是一个显式的策略参数，不是一个副作用。

**可执行断言**：`PC-CX-15 delivery count changes nothing a person or the control loop can see` —— 对 N ∈ {1, 2, 11, 50} 与随机乱序，逐列比较完整 blocker 行、`run_state`、通知数与是否升级；另断言 §9.4 与 §11.5 里不再有 `occurrences >` 阈值或三级阶梯的字样。**反向对照**：把 `occurrences > 10` 放回触发条件，N = 11 立刻产出 `USER`/`AWAITING_HUMAN`/1 条通知，而 N = 1 是 `SYSTEM`/`BLOCKED`/0 条。

### 21.2 `PC-CX-16` blocker 的生命周期代次

**最小交错序列**：

1. `PROVIDER_UNAVAILABLE(provider-1)` 首次发生 ⇒ 动作键 `blocker:PROVIDER_UNAVAILABLE:provider-1` 插入成功、`APPLIED`，blocker open。
2. Provider 恢复 ⇒ §11.4 重算条件 ⇒ `CLEAR_BLOCKER` ⇒ `resolved_at` 落库。**动作行仍在**（历史永不删除）。
3. 一小时后 Provider 再次不可用。这是一个**新的故障周期**：§11.3 的 partial unique index 只覆盖 open 行，因此数据库层面完全允许再开一条。
4. 但 outcome 算出的键与第 1 步**逐字节相同** ⇒ §8.5 C2 判 `ALREADY_APPLIED` ⇒ **跳过插 blocker** ⇒ 最终**没有 open blocker**：项目带着一个真实存在的 Provider 故障继续往前走，而且看起来一切正常（有动作行、有审计行、没有 blocker、没有报错）。这与 `PC-CX-11` 是同一个形状 —— 一个一生只会发生一次的假设，被用在一件会反复发生的事情上。

**Postgres MVCC 与锁语义**：`project_action.idempotency_key` 的唯一索引忠实地回答"这两次是不是同一个动作"，而它只能按键回答。键里没有周期，索引就无从区分周期。修法因此不在索引上，在键上：给 blocker 行加一个 `lifecycle_generation`，用 `INSERT … SELECT COALESCE(MAX(…), 0) + 1 … ON CONFLICT DO NOTHING RETURNING` 在**一条语句**里分配（BE1）。这条语句的安全性由**两个**唯一索引兜底而不是由读的原子性保证：同周期内的第二次插入撞 `project_blocker_open_dedupe_idx`，跨周期算出重复代次撞新增的 `project_blocker_episode_idx`；两种冲突都被 §8.5 C1 降级成返回值。更强的那一层保证在租约上 —— blocker 只由持有租约的那一个 reconcile 写（F1），并发只可能出现在接管窗口，而旧持有者的整事务会因 fencing token 条件影响 0 行而回滚（C3）。**索引是兜底，不是主路径**，这一点必须写明，否则下一个人会以为 `MAX + 1` 在任意并发下都安全（它不是，参见 D8-note）。

**权威状态**：同一 `dedupe_key` 上，`lifecycle_generation` 单调、不复用；**任何时刻至多一条 open 行**（partial unique index，不变），而**历史行的条数等于故障周期数**。"这个 Provider 今天坏了三次"因此是一次 `COUNT`，不是一次考古。

**动作键**：`pc:v1:<projectId>:blocker:<kind>:<subjectId>:<lifecycleGeneration>`（§7.3）。与行一一对应（BE3）。`CLEAR_BLOCKER` 仍用行 id —— 一行一生只被解除一次，因此它天然满足 GE1。

**恢复路径**：open 周期内的重复命中既有行（AC8 的去重逐字不变，`occurrences += 1`、`condition_version` 重算）；clear 之后复发得到新代次、新键、新行、新的 `first_seen_at`（因此升级时钟从零开始重走，这也是对的：一次新的故障不该继承上一次的等待时间）。**没有任何路径能让代次回退**，因此"人工处理过一次"不再有把某个 subject 永久静默的能力。

**可执行断言**：`PC-CX-16 a blocker that comes back gets a new lifecycle generation` —— 对 §11.2 全部 18 个 kind 跑 `open → 重复投递 ×N → clear → 同因复发`，断言两条历史动作、第二条 open blocker、代次 1→2、责任人唯一、`nextWakeAt` 非空；**反向对照**：把代次从键里去掉（回到 v1.2 的 `blocker:<kind>:<subjectId>`），同一序列立刻产出 `ALREADY_APPLIED` 且复发后 open blocker 数为 0。

### 21.3 `PC-CX-17` 可回环事实不能当永久身份

**最小交错序列**（三条，各自独立，v1.2 在三处都错）：

- **verdict**：verifier `V` 第一次 FAIL ⇒ `verdict:V:FAIL` `APPLIED` ⇒ 被验证任务 `DONE → OPEN`、建缺陷子任务、阻断下游。人修好、任务重跑、`V` 重跑 ⇒ **仍然 FAIL** ⇒ 同一个键撞历史行 ⇒ C2 跳过 ⇒ 被验证任务**留在 DONE**、没有新缺陷、下游**没有**被阻断。AC6 直接失效，而且失效得完全无声。
- **aggregate**：父任务 `P` 的子集合摘要 `A` ⇒ 聚合 ⇒ 键 `aggregate:P:A`。一个子任务被退回（AG3）⇒ 摘要 `B` ⇒ 聚合。子任务再次完成 ⇒ 摘要**回到 `A`** ⇒ 第三次撞第一次的键 ⇒ 父任务停在 `OPEN`。
- **acceptance**：`acceptance:<attempt>` 里的 `attempt` 在 v1.2 全文**没有定义** —— 快照结构里没有、§8.2 的 epoch 列表里没有、§13.4 里也没有。三个实现可以分别用事件数、历史动作数、内存计数生成三种键。

**Postgres MVCC 与锁语义**：与 `PC-CX-16` 同源，但这一项更值得说清楚的是**为什么"加一个唯一约束"不是解法**。数据库能保证的是"同一个键只成功一次"；它不能替你回答"这两次是不是同一件事"。当键由一个能回到旧值的量构成时，数据库给出的"已经做过了"是**正确的**——错的是提问方式。因此 v1.3 的修法分两路：能自然表达成幂等重算的（聚合）**取消键**，改成 §13.1 AG5 的条件写（CAS：`WHERE status = :observedParentStatus`，影响 0 行只意味着"事实已变，下次重算"，永远不需要一个永久身份）；必须留痕的（verdict、acceptance）**换代次**，代次落在一条随写入一起前进的行上（`UPDATE … RETURNING`，取行锁，与 DA2 逐字同型）。

**权威状态**：I13。`FAIL → PASS → FAIL` 的第二个 FAIL 是 `verdict_revision = 2`，三件机械后果全部重新发生；`DONE → OPEN → DONE` 的第二个 DONE 由 CAS 落到当前重算值，父状态恒等于"按当前子状态算出来的那个"；重复的验收事件在同一份快照上算出同一个 `acceptance_attempt`（因此不重复跑验收），而一次真正的重新验收得到新的 attempt。

**动作键**：`pc:v1:<p>:verdict:<verifierTaskId>:<verdictRevision>` · `pc:v1:<p>:acceptance:<acceptanceAttempt>` · 聚合**无键**。三者连同 `dispatch` 与 `blocker` 一起被 §8.2 GE1 的表逐行冻结，GE2 给出禁止清单，GE4 说明唯一的例外（`OPEN_COORDINATOR_TURN` 的 `reasonDigest` 冲突有定义好的后果 TR3，而 GE2 禁止的是**没有后果**的冲突）。

**恢复路径**：verdict —— 修复后重新运行验证任务，新 revision 让退回/缺陷/阻断重新发生（V4 从一句话变成一个机制）；aggregate —— 不需要恢复路径，CAS 在下一次 reconcile 自动收敛；acceptance —— 验收 FAIL 后重跑得到新 attempt，旧证据不必删除（AE4 不变）。

**可执行断言**：`PC-CX-17 a fact that returns to an old value still gets a new action identity` —— 三条序列各跑一遍：`FAIL → 修复 → FAIL` 断言第二次三件后果都发生；children `A → B → A` 断言父状态每次等于当前重算；acceptance 在重复事件、接管、事实回环下断言键来自 `acceptance_attempt` 且单调。**反向对照**：把三个键换回 v1.2 的形状，三条序列分别产出"目标仍 DONE"、"父任务停在 OPEN"、"attempt 无来源"。

### 21.4 `PC-CX-18` 封闭集合必须能被证明是封闭的

**最小交错序列**：

1. Project `P` 已 `DONE`，验收记录的 `acceptanceDigest` 与当时的事实匹配。
2. 另一个事务把 Task `X` **从别的项目移入** `P`（§12.3 D3 明确存在这个写路径）。它只写 task 行，按 v1.2 的 AE6 表**不取任何 project 锁**（那张表里没有这一行）。
3. 提交。`P` 的 `taskSet` 已经变了，摘要不再匹配，但 `project.status` 仍是 `DONE`，§4.2 守卫 1 无条件返回 `SETTLED` —— I10 为假，而且没有任何东西会发现。

`verifiesTaskId` 改写同型（它改的是 `verdicts` 投影）。第三条更根本：目标分支在 AE7 重算摘要之后、`DONE` 提交之前被 `git push` 改掉 —— **没有任何 Postgres 行锁能与它排序**，而 v1.2 却把 `mergeEvidence` 与另外三个投影并列，读起来像是同一把锁都覆盖了。

**Postgres MVCC 与锁语义**：前两条是纯粹的遗漏，修法是让集合**可被机械导出**而不是手写：AE6 的每一行都必须声明它改的是 AE1 的哪个投影，契约测试从 digest 的字段集反推应有的 mutator 集合并逐条比对（AE6-c）。跨 Project 移动同时改两个投影拥有者，因此按 §8.6 LO2 **对两个 project 行按 id 升序各取一把 `FOR NO KEY UPDATE`**，两个 Project 各自独立走 AE8（AE10）—— 升序是为了让 A→B 与 B→A 并发时取到同一顺序，否则这个修复本身就是一个新的死锁源。真实 Postgres 上还量到一件本节必须写下来的事（AE10 第 4 条）：`task.project_id` 是外键，写它会取被引用 project 行的 `FOR KEY SHARE`，它与 AE7 的 `FOR UPDATE` 冲突，因此"移动先"那个方向**碰巧**被排上序并让 `DONE` 正确拒绝。它看起来像门，但它只覆盖四个投影里的一个、且在"`DONE` 先"那个方向不触发任何重开 —— **把它当门就是把一次运气写进契约**。第三条则要求承认边界：`git push` 不进入任何事务，**行锁锁不住它**。AE9 因此把权威表示落在数据库里的证据行上（含单调的 `refGeneration`），把写入口收敛成一个，把 post-DONE 协议定义成"观测到即按 AE8 原子重开"，并明确写下这是**有界延迟的检测**而不是互斥，连同两个观测点与一条任何人都能跑的漂移判据（AE9-d）。

**权威状态**：I10 不变，但它现在**真的**覆盖四个投影的全部 mutator。Git 侧的诚实版本是：`DONE` 断言的是"在 `refGeneration = g` 上验收通过"，而 `g` 是被记录下来的（AE9-a）——**一个可以被检查的断言，而不是一个做不到的承诺**。

**动作键**：`pc:v1:<p>:acceptance:<acceptanceAttempt>`（AE11）。证据行带 `acceptanceDigest` 与 `refGeneration`。

**恢复路径**：数据库内的三类（move / relink / 前三个投影的常规写）⇒ AE8 同事务重开为 `OPEN` 并写 `reopened_by_fact_change`；Git 侧 ⇒ 合并证据写入器在两个观测点之一发现 `contentHash` 变化 ⇒ `refGeneration + 1` ⇒ 它自己就是 AE6 写入者 ⇒ 同样走 AE8。两条路径的终点相同：**项目回到 `OPEN`，由守卫重算落点**。

**可执行断言**：`PC-CX-18 the acceptance-fact write set is derived from the digest, not hand-written` —— 从 `acceptanceDigest` 的字段集生成 mutator 集合，断言 AE6 表逐条覆盖（含 `task.projectId` move、`verifiesTaskId`、`refGeneration`），并对每个 mutator 跑 `FACT_FIRST` / `DONE_FIRST` 两种交错断言 I10；跨 Project 移动额外断言两个 Project 都被重开、且两个方向取同一锁序。真实 Postgres 侧由 `coordinator-linearization.pg.spec.ts` 的 `PC-CX-18 on real Postgres: DONE and every acceptance-fact write share one gate` 用两条真实连接跑两个 mutator（Task 状态变化、跨 Project 移动）× 两个提交顺序，并在已提交状态上断言 I10。**反向对照**：把 AE6 换回 v1.2 那张手写表，模型侧三条新增写路径立刻各产出一个 `DONE` + 不匹配事实的已提交状态；真实服务器上 `task.status` 两个顺序都复现，而跨 Project 移动只在"`DONE` 先"那个方向复现（另一个方向被外键的 `FOR KEY SHARE` 碰巧挡住，AE10 第 4 条）。

### 21.5 `PC-CX-19` 一个锁序，没有升级

**最小交错序列**（两个真实事务，在真实 Postgres 上跑）：

1. `T_a` 与 `T_b` 都是验收事实写入者（一个改 Task 状态、一个写 verdict）。
2. 两者各自执行 AE6 的第一句 `SELECT … FROM project WHERE id = :p FOR SHARE`。`FOR SHARE` 之间**相容**，因此两把锁**同时**授予。
3. 两者各自读到 `project.status = 'DONE'`，于是按 AE8 都要 `UPDATE project SET status = 'OPEN'`。
4. 升级需要排他锁，而对方持着相容的共享锁 —— **互等**。PostgreSQL 16.14 检测到环，一方收到 `40P01 deadlock detected`。

契约对这个错误码此前**没有任何处置规定**：它会以一个未分类的 500 落到那个只是点了"把任务标完成"的用户脸上。另一半是纪律冲突：§8.1 F3 写着"reconcile 内部不获取任何第二把锁"，而 D6 的触发器要取 task 锁、AE6/AE7 要取 project 锁，且提交事务已经先 `UPDATE` 了 `project_runtime` —— **三条锁规则不可能同时满足**。

**Postgres MVCC 与锁语义**：死锁的成因是**锁升级**，不是并发本身。`FOR SHARE` 与 `FOR NO KEY UPDATE` 冲突、`FOR NO KEY UPDATE` 与 `FOR KEY SHARE`（外键检查）不冲突 —— 这三条决定了正确的选择：验收事实写入者**一开始就取 `FOR NO KEY UPDATE`**（LO3），它们之间因此排队而不是互等，而引用这个 project 的其它写入（外键检查）完全不受影响。剩下的隐式加锁顺序（触发器、索引维护）无法穷举，所以还需要 LO4 的有界重试，且**每次重试必须重读快照** —— 重放一份已经不成立的快照只会再撞一次。全序 LO1 `project → project_runtime → task → session` 把"两个事务以相反顺序取同两把锁"这种可能性从系统里删掉；LO2 把跨 Project 的两把 project 锁也纳入同一个序（按 id 升序）。

**权威状态**：任何一次验收事实写入或 `DONE`，最终只有三种结局：**成功**、**被 AE8 原子重开后成功**、**收到有类型的 `PROJECT_FACT_WRITE_CONTENDED`**。`40P01`/`40001` 不再泄漏到用户可见的错误里；控制环侧则记 `LOCK_CONTENDED` 审计并 `nextWakeAt = now + 5s`，**不开 blocker**（没有人需要做任何事）。§8.1 F3 被替换为"按 LO1 的唯一全序取锁 + 不升级 + 有界重试"，并在原处写明这是一次**行为变更**而不是措辞澄清。

**动作键**：不变。这一项完全在锁与错误处理层面，不触碰任何动作身份。

**恢复路径**：重试 ≤ 3 次（`50ms · 2^n` ± 25% 抖动），每次重读快照；仍失败则返回可重试的类型化错误，用户重试或控制环下一次唤醒重来。重试次数与最终结果落 `project_decision.detail`，因为"这个项目锁竞争严重"必须是可观测的事实（LO4 第 3 条）。

**可执行断言**：`PC-CX-19 one lock order, no upgrades, and a bounded retry` —— 模型侧枚举两个/三个并发写入者与 `DONE` 的全部交错，断言不存在锁升级、不存在环、每个入口都以三种合法结局之一结束；真实 Postgres 侧由 `coordinator-linearization.pg.spec.ts` 的 `PC-CX-19 on real Postgres: FOR NO KEY UPDATE removes the deadlock the upgrade caused` 跑真实连接：`FOR SHARE` 版本两个写入者即产出 `40P01`，`FOR NO KEY UPDATE` 版本**两个与三个**写入者都全部提交、无一泄漏错误码（LO5）。**反向对照**：把 AE6 换回 `FOR SHARE`（只改这两个词），同一交错在真实服务器上立刻产出 `40P01` —— 这与 `PC-CX-09` 一样，是一条不靠模型、直接验数据库语义的断言。

### 21.6 `PC-CX-20` 归属由数据库证明

**最小交错序列**：

1. 建 `project_action` 表与外键之后，插入一条 `type = 'NOOP'`、`status = 'CLAIMED'` 的动作行 `a1`（它与任何 Task 都无关）。
2. 插入一条 `dispatch_origin = 'COORDINATOR'`、`project_action_id = a1` 的占位 Session。
3. D6 的谓词只有 `project_action_id IS NOT NULL` ⇒ **放行**。事务提交。
4. 查询已提交状态：这条 COORDINATOR 占位"归属"到一条 `NOOP`/`CLAIMED` 的动作 —— I11 为假，而契约声称 I11 由 D6 保证。

第二条更隐蔽：即便插入时动作行是这个 Task 的 `DISPATCH_TASK`，同一事务**在插完 Session 之后**把它改成 `REFUSED`/`SUPERSEDED`、或改掉 `subject_id`，再提交，`BEFORE INSERT` 的检查同样什么都拦不住 —— 这与 `PC-CX-09` 是同一个教训的第二次出现：**"插入时成立"不是"已提交状态上成立"**。

**Postgres MVCC 与锁语义**：`BEFORE INSERT` 触发器看见的是语句执行那一刻的行；要证明提交时的状态，只有两个工具 —— **可延迟约束触发器**（`DEFERRABLE INITIALLY DEFERRED`，在 `COMMIT` 时执行，因此读到的是本事务的最终状态）和**约束**（`CHECK`，对 `INSERT` 与 `UPDATE` 同时成立且不可延迟绕过）。v1.3 两个都用：D9 的约束触发器逐列验证 type / status / subject / project / fencing token，CHECK 约束保证非 COORDINATOR origin 的 Session 不带动作 id。为什么必须**可延迟**：§8.3 冻结的语句顺序是"先插动作行（`CLAIMED`）→ 再插 Session → 再置 `APPLIED`"，一个立即执行的约束会在第二步就要求 `APPLIED`，那会逼实现把顺序倒过来，而倒过来正是 X1 禁止的"先做副作用再写键"（D9-b）。`fencing_token` 这一项能比，是因为 F1 的 `UPDATE project_runtime … WHERE fencing_token = :token` 已经对该行取了排他锁，本事务提交前没有别的 reconcile 能推进它（D9-c）。

**权威状态**：I11 三句话此后逐条由数据库对象保证，且**对任何版本的二进制成立** —— 这正是 D5/D6 当初被放进数据库的同一个理由。旧二进制既不会写 `dispatch_origin`（落默认 `LEGACY_SWEEP`）也不会写 `project_action_id`，因此它天然满足 CHECK，被 D6 按授权拦截，与 v1.2 逐字节相同。

**动作键**：不变。硬门是约束不是键 —— 与 `PC-CX-02` / `PC-CX-09` 同型：跨入口的性质不可能由只有一个入口会写的键来保证。

**恢复路径**：违规入口的事务在 `COMMIT` 时被拒并整体回滚，错误码 `DISPATCH_ATTRIBUTION_VIOLATION`（**可见的失败**）；控制环的正常路径永远不会触发它，因为它的动作行必然是本 Task 的 `DISPATCH_TASK`、必然在同一事务里被置 `APPLIED`、必然带着当前 token。被拒的那个入口本轮跳过该 Task，下一次 reconcile 用新事实重来。

**可执行断言**：`PC-CX-20 attribution is proved on the committed state, not at insert time` —— 模型侧枚举六个反例；真实 Postgres 侧由 `coordinator-linearization.pg.spec.ts` 的 `PC-CX-20 on real Postgres: the deferred constraint proves I11 on the committed state` 建**带外键的** `project_action` 表，正例提交后断言 I11，六个反例（错 type、错 status、错 Task、错 Project、陈旧 token、`USER` + 非空动作 id）逐个断言提交被拒。**反向对照**：把 D9 换回 v1.2 的 `project_action_id IS NOT NULL`，`NOOP`/`CLAIMED` 的那条 Session 立刻提交成功，`i11Satisfied = false` —— 与复审报告里那一行输出逐字对应。

### 21.7 本次修订**没有**做的事

同 §19.9 / §20.7，边界要写清楚：

- **本次修订仍不含实现**。03–23 单元一行业务代码都还没写；`project_blocker.lifecycle_generation`、`task.verdict_revision`、`project_runtime.acceptance_attempt`、D9 的两个约束对象、AE6 的 `FOR NO KEY UPDATE` 目前都是**契约条款**，不是数据库里的对象。
- **真实 Postgres 断言从一条扩到四条**：authority flip（v1.2 已有）、`DONE` × 验收事实写（Task 状态变化与跨 Project 移动两个 mutator，各跑两个提交顺序）、并发事实写的锁升级死锁与其修复、以及带外键的 D6/D9 归属正反例。复审清单里那两条点名要真实数据库的（第 7、8 条）因此已兑现；剩下的属性测试与状态模型仍以模型级断言兑现，它们本来就不需要数据库。**但要说清楚**：这些测试建的是**测试用的表**，不是 Prisma schema 里的真表 —— 它们证明的是"这些 SQL 语义成立"，不是"迁移已经写好了"，后者归 03 / 04 单元（§12.1 G5 已列出必须显式验证的三样新东西）。
- **三份审查文档一字未改**（任务的硬约束）。它们记录的是 v1、v1.1 与 v1.2 的事实；v1.3 的回应写在本节。
- **两处行为变更，不是措辞澄清**，写在这里以免下一个人以为它们只是没写全：§8.1 F3 从"不取第二把锁"改成"按唯一全序取锁 + 不升级 + 有界重试"；§13.4 AE6 从 `FOR SHARE` 改成 `FOR NO KEY UPDATE`，代价是同一 Project 的验收事实写入之间会排队。
- **`LO4` 的有界重试只有模型级断言**。它是一段应用层策略（重试几次、退避多久、最后返回哪个错误码），不是数据库语义；真实服务器上能验的是"这个锁序不产生 `40P01`"，而那正是 LO5 跑的东西。等 09 单元写出 reconcile 的提交路径，重试才有真实入口可测。
- **没有给 Git 侧发明一把锁**。AE9 明确写下"行锁锁不住 ref"，给出的是有界延迟的检测 + 原子重开，以及两个观测点之间那个**真实存在的窗口**。把它写成互斥会好看很多，也会是假的。

---

## 22. `PC-CX-21..27` 修订闭环（v1.4）

> **本节是非规范的（non-normative）修订日志**（§0 RL1，v1.4 冻结）。它记录 v1.4 当时的事实与当时的推理，**不是现行规范**；任何一句与 §1–§18 冲突时一律以 §1–§18 为准。历史形状只允许出现在这里和反例测试里（`PC-CX-27`）。

02 对 v1.3 的独立复审（[`project-coordinator-contract-review-02-v1.3.md`](./project-coordinator-contract-review-02-v1.3.md)）判 **FAIL / BLOCKED**，给出 2 个 P0、5 个 P1。本节是**逐项关闭的索引**，格式与 §19 / §20 / §21 相同。**四份审查文档都不因本次修订而改动** —— 它们记录的是 v1、v1.1、v1.2 与 v1.3 的事实，那些事实没有变；变的是契约。

七项里有一条贯穿的线：**v1.3 学会了"让数据库证明它自己能证明的事"，但没有把这条纪律推到它的两个边界上。** 一个边界是**时间**：D9 在提交那一刻证明得很好，v1.3 却把那个等式写成了一条永久不变量，于是下一次完全正常的租约就把它弄假（`PC-CX-21`）；`snapshotHash` 同样把时钟排除在外，却让一堆读时钟的规则去用它（`PC-CX-22`）。另一个边界是**写入者的版本**：D5 / D6 / D9 都进了数据库，而它们读的那一列 `dispatch_authority` 仍然由新服务层维护，于是一个旧写端就能把这条链的第一环变成陈旧值（`PC-CX-25`，P0）。剩下三项是同类模式的其它实例：同时为真的原因没有裁决（`PC-CX-23`）、有生命周期的行没有把周期带进身份（`PC-CX-24`）、人和控制环没有共用一把锁（`PC-CX-26`）。最后一项是把前几轮的旧规范句留在了正文里（`PC-CX-27`）。

v1.4 的答案在五处：**一组时态明确的不变量**（I11-A/I11-B、F0、D9-e）、**一组把硬门读到的行钉住的反向约束**（D10 / D11）、**一份完整的 `decisionInput`**（§6.1 S3/S5/S7/S8）、**两个全序**（TU4 的原因全序、§9.6 AU1 的授权门共用 LO1 第一级那把锁），以及**一个由数据库自己算的派生列**（D8-a / D12 / D13）。

| ID | 级别 | 规范条款 | 权威状态 | 动作键 | 恢复路径 | 可执行断言 |
|---|---|---|---|---|---|---|
| `PC-CX-21` | **P0** | §4.3 I11 · §7.7 D9-e · D10 · D11 · §8.1 F0 · §10.3 · §13.4 AE10 | I11-A 恒成立（`action.token <= runtime.token` + 归属列被反向约束钉住）；I11-B 只在提交时被要求 | 不变（归属是约束，不是键） | 下一次租约照常推进，无需动作；在飞 Task 移动被拒 `TASK_CLAIMED_PROJECT_MOVE`，等运行结束或先取消 | `PC-CX-21 attribution survives the next lease and refuses to survive a live task move` |
| `PC-CX-22` | P1 | §6.1 S3 · S5 · S6 · S7 · S8 · §6.2 · §7.4 | `decisionInput = world + evaluation + signals`，`decisionInputHash` 覆盖三者；同 hash ⇒ 逐字相同的 actions/blockers/nextWake | 全部代次字段进 `world`，因此键由输入唯一决定 | 无需恢复；字段集由读集反推，漏字段在契约测试里当场红 | `PC-CX-22 the decision input is complete, and the hash is over all of it` |
| `PC-CX-23` | P1 | §7.2 TU4 · TU5 · §6.2 · §6.3 · §4.3 I15 | 五个原因按 `MANUAL ≻ VERDICT ≻ BLOCKER_DECISION ≻ ACCEPTANCE ≻ REPLAN` 首个为真者胜；一次 reconcile 至多一条语义 turn | `turn:<generation>:<reasonDigest>`，`reasonCode` 唯一因此键唯一 | 被压下的原因写进 `suppressedTurnReasons`，下一次仍为真则自然胜出 | `PC-CX-23 overlapping turn reasons are decided by one total order` |
| `PC-CX-24` | P1 | §7.2 TF1 · TF4 · §7.6 TR3 · §11.3 BE1 | 同一 open episode 内重复 ⇒ 同 turn 键；clear 后复发 ⇒ 新 `lifecycleGeneration` ⇒ 新 turn 键 | `turn:<generation>:<reasonDigest>`，`turnFacts` 含 `lifecycleGeneration` | 复发合法获得一次新 turn，不再被 TR3 误判为 no-progress | `PC-CX-24 a blocker episode that recurs earns a new turn, not a no-progress verdict` |
| `PC-CX-25` | **P0** | §7.7 D8-a · D8-b · D8-e · D12 · D13 · §12.3 D3 · §12.4 · §4.3 I12 | `task.dispatch_authority` 恒等于派生式（I12-A，触发器维护）；无越权**新**派发（I12-B，D6 保证） | 不变（投影是派生列，不是键） | 旧写端的任何写入都被触发器重算；D13 漂移查询对生产可直接跑，返回 0 行 | `PC-CX-25 the authority projection is derived by the database, not maintained by a service` |
| `PC-CX-26` | P1 | §9.6 AU1 · AU2 · AU3 · CAP1 · CAP2 · §9.2 P4 · §8.5 C6 · §6.3 · §4.3 I16 | 撤权与派发提交共用 `project` 行锁，只有两种确定顺序；占位数恒 ≤ `maxConcurrentTasks` | 不变；撤销的动作记 `REFUSED` / `AUTHORITY_REVOKED` | 被撤销的动作不产生副作用，其余 outcome 照常提交；人工入口得到 `PROJECT_CONCURRENCY_LIMIT` | `PC-CX-26 revocation and the project cap share one gate with dispatch` |
| `PC-CX-27` | P1 | §0 RL1 · §13.1 AG1 · §13.4 AE8 · §19–§22 的非规范声明 | 正文只保留现行规则；历史形状只在 §19–§22 与反例里 | 不变 | 残句账（§22.8）逐条被契约测试扫描，新增一条被取代的规范就必须登记一行 | `PC-CX-27 no superseded normative sentence survives in the normative body` |

新增的模型断言在 [`coordinator-counterexample.spec.ts`](../src/apiserver/src/projects/coordinator-counterexample.spec.ts)，新增的真实 PostgreSQL 断言在 [`coordinator-linearization.pg.spec.ts`](../src/apiserver/src/projects/coordinator-linearization.pg.spec.ts)；02 在 v1.3 轮次留下的 [`coordinator-v13-adversarial.spec.ts`](../src/apiserver/src/projects/coordinator-v13-adversarial.spec.ts) 按该报告 §5 的要求**从"证明缺陷存在"翻转成"旧交错被拒绝/得到唯一合法结果"**，并把 v1.3 的形状原样保留为每条断言里的**反向对照**。

### 22.1 `PC-CX-21` 归属用历史关系，token 只证明提交时的授权

**最小交错序列**（两条，各自独立）：

- **A（正常路径就能弄假）**：token = 42 的 reconcile 在一个事务里提交 `action(APPLIED, token = 42)` 与一条 COORDINATOR 占位，D9 在 `COMMIT` 时通过。60 秒兜底或任何一条事件触发下一次 reconcile，它**成功取到租约**，§8.1 让 `fencing_token` 走到 43。那条 Session 仍然在飞，它的三列一列没动，D9 因此**根本不会再执行**。查询已提交状态：`action.token = 42 ≠ runtime.token = 43` ⇒ v1.3 写法的 I11 为假。**系统里没有任何一个参与者做错了任何事**，而契约说这是 P0 活性违约。
- **B（一次合法的人工操作）**：同样的占位已合法提交。人把这个 Task 从 P1 移到 P2 —— §13.4 AE10 明确允许，且 v1.3 只要求两个 Project 的验收事实门。Session 没有被更新，D9 只声明在 `session (project_action_id, dispatch_origin, task_id)` 上，**不会执行**。最终状态：动作属于 P1、Task 属于 P2，`a.project_id = t.project_id` 为假。

**Postgres MVCC 与锁语义**：这一项的要害不是并发，是**声明范围**。一个 `AFTER … OF <columns>` 的约束触发器只在那些列被写时排队执行；它读到的其它表、其它行**不在它的声明里**，因此那些行怎么变它都不知道。v1.3 的 D9 读了四张表（`project_action` / `task` / `project_runtime` / `session`），却只声明在其中一张的三列上 —— 它证明的是"插入这条 Session 的那个事务提交时，这四张表凑起来是对的"，不多也不少。要把它变成一条**恒成立**的不变量，只有两条路：把读到的每一行都纳入声明（要给三张表各配触发器，且 `project_runtime.fencing_token` **每次租约都变**，那等于每次 reconcile 都要重验全项目的在飞 Session），或者**让不变量只依赖不会变的东西**。v1.4 选第二条：token 那一项换成单调关系（`<=` 一旦为真永远为真，因为 §8.1 的 token 只增），其余三项各配一个反向约束把它们钉成"占位期间不可变"——`task.project_id` 由 D10 冻结，`project_action` 的归属列与 `status` 由 D11 冻结。**代价明确**：在飞的 Task 不能跨 Project 移动（一次可见的、有类型的拒绝），`APPLIED` 的动作行不能被改写（本来也不该）。

**权威状态**：§4.3 I11 拆成两句。**I11-A（恒成立）**：COORDINATOR 占位 ⟹ 存在 `DISPATCH_TASK`/`APPLIED`/本 Task/本 Project 的动作行，且 `action.fencing_token <= project_runtime.fencing_token`。**I11-B（点态）**：占位被提交的那一刻 `action.fencing_token = project_runtime.fencing_token`，由 D9 在 `COMMIT` 执行。§10.3 (a) 与 §15 F28 都改用前者。§8.1 新增 F0 把"token 回答什么问题"写死在租约那一节，免得下一个人再把它当恒等式用。

**动作键**：不变。归属是**约束**不是键 —— 与 `PC-CX-02` / `PC-CX-09` / `PC-CX-20` 同型：跨入口、跨时间的性质不可能由一个只有一个入口会写的键来保证。

**恢复路径**：交错 A 不需要恢复 —— 它本来就不是故障，v1.4 只是不再把它当故障。交错 B 变成一次**可见的失败**：`TASK_CLAIMED_PROJECT_MOVE`，调用方等这次运行结束再移，或者先取消它（§13.4 AE10 第 3b 条）。`APPLIED` 动作行的改写同样是可见失败：`ACTION_APPLIED_IMMUTABLE`。

**可执行断言**：`PC-CX-21 attribution survives the next lease and refuses to survive a live task move` —— 模型侧断言 I11-A 在 token 从 42 走到 43、44、…之后仍为真，而 v1.3 的等式写法在第一次推进就假；真实 Postgres 侧由 `coordinator-linearization.pg.spec.ts` 的 `PC-CX-21 on real Postgres: the next lease keeps I11-A and a live task move is refused` 建带外键的四张表 + D9 + D10 + D11，跑：正常派发 → 推进 token → 断言 I11-A 仍真；在飞移动 → 断言提交被拒且状态不变；结束占位 → 再移动 → 断言成功；对 `APPLIED` 行逐列改写 → 断言六列被拒、两列可写。**反向对照**：把 I11 换回"等于当前 token"，同一序列在第一次租约推进后就产出 `i11 = false`；把 D10 去掉，在飞移动立刻提交成功并让归属断开 —— 与复审报告里那两行输出逐字对应。

### 22.2 `PC-CX-22` 决策输入必须说全，时钟折成到期事实

**最小交错序列**（三组，各自独立，v1.3 三处都缺）：

- **漏字段**：两份快照在 §6.1 v1.3 的可见投影上**逐字相同**，但 `task.dispatch_attempt` 分别是 1 与 2。§7.3 要求的键分别是 `…:dispatch:<taskId>:1` 与 `…:dispatch:<taskId>:2` —— 同一个 hash，两个不同的动作身份。`verdict_revision` / `acceptance_attempt` / `lifecycle_generation` / `condition_version` / `escalated_at` / `mergeEvidence` 各能造一组同型反例。
- **排除时钟**：同一份世界行、同一个 `runAt = 10:00`，在 09:59 与 10:01 各求值一次。S3 的 hash 相同（`snapshotAt` 被排除），而 §7.4 第 1 条要求的决定相反。退避到期、升级到期、预算窗口边界三处同型。
- **排除事件**：两份世界行完全相同，其中一份的唤醒里有一条 `user.manual_trigger`。hash 相同，而 §7.2 要求的"是否开一条 MANUAL turn"相反。

**Postgres MVCC 与锁语义**：这一项不靠锁，它是**审计与重放**的性质，但根因与 `PC-CX-15` 同源：一个判定读了一个没被记下来的输入。区别在于 `PC-CX-15` 的解法是**把那个输入赶出判定**（`occurrences` 本来就不该被读），而这三组的输入是**真的需要被读的** —— 代次决定动作身份、时钟决定到期、用户请求决定 MANUAL turn。因此解法只能是相反的方向：**把它们如实记进输入**。唯一要小心的是不能把 `now()` 直接塞进 hash（那样每次 reconcile 的 hash 都不同，S3 退化成一句永远为真也永远无用的话），所以 v1.4 引入 `evaluation`：时钟只在读输入时读一次，并**当场折成布尔的到期事实**；hash 覆盖这些布尔，不覆盖 `readAt`（S5 / S6）。事件同理，只进 `(kind, dedupeKey)` 身份、不进负载，因此 E1 逐字不变，而 §5.4 的 partial unique index 保证重复投递仍然只得到一项，I14 也不变（S7）。

**权威状态**：§6.1 的输入结构从"快照"改成 `decisionInput = world + evaluation + signals`，`decisionInputHash` 覆盖三者。**S3 第一次成为一句真话**：相同 hash ⇒ 逐字相同的 `actions`（含每个 `idempotencyKey`）、`blockersOpened` / `blockersCleared`、`nextWakeAt`。§6.2 的 outcome 带上 `decisionInputHash` 与 `configRevision`，因此一次决策可以被完整重放。

**动作键**：不变，但**第一次由输入唯一确定** —— 五个永久键的代次（§8.2 GE1 的表）现在全部在 `world` 里。

**恢复路径**：本项没有运行期恢复路径可谈，它的"恢复"是**测试**：S8 把字段集变成一条从读集反推的双向断言，因此下一次有人加规则而忘了加字段，契约测试当场红，而不是等 11 单元发现审计重放对不上。

**可执行断言**：`PC-CX-22 the decision input is complete, and the hash is over all of it` —— 三组反例各跑一遍：同 hash 必须蕴含同 actions/blockers/nextWake；把 `dispatchAttempt` / 到期事实 / manual 信号任一改动，hash 必须变；再从 §7.3、§8.2 GE1、§11.2、§13.4 AE1 收集列名，与 §6.1 的字段集**双向**比对（S8）。**反向对照**：把 `evaluation` 与 `signals` 从 hash 里去掉（回到 v1.3 的 S3），三组反例立刻各产出一对"同 hash、不同决策"。

### 22.3 `PC-CX-23` 同时为真的原因由一个全序裁决

**最小交错序列**（两条）：

- **A**：全部 Task 收敛、验证全 PASS、无 blocker、无 live Session、无未收敛的验收动作。`runStateOf = PLANNING`（守卫 1–6 全不成立）且无可派发任务且无 open blocker ⇒ **`REPLAN` 为真**；"全部 Task 收敛，准备进入 `ACCEPTANCE`" ⇒ **`ACCEPTANCE` 也为真**。
- **B**：验证 FAIL，§13.2 的机械退回已完成 ⇒ **`VERDICT` 为真**；同一次退回按 §13.2 第 ④ 条必然开一条 `VERIFICATION_FAILED` blocker，它在 §11.2 `opensTurn = ✔` 的四行里且 `escalated_at IS NULL` ⇒ **`BLOCKER_DECISION` 也为真**。

两组里两个 reasonCode 的 `reasonDigest` 不同（TR1 按 digest 去重）、TR2 的限频按 reasonCode 分桶、§7.3 的键含 `reasonDigest` —— **没有任何一条既有规则会把它们合并**。于是同一份输入可以合法地开出两条 turn，或者开出其中一条而选哪一条取决于实现的遍历顺序。§6.3 第 5 步写的是"追加一个 `OPEN_COORDINATOR_TURN` 动作"，那句话假设了唯一性却没有任何东西保证它。

**Postgres MVCC 与锁语义**：这一项与数据库无关，它是**判定函数的完备性**问题，和 `PC-CX-03` 是同一个形状 —— v1 用一张手写转移表表达 `run_state`，在混合 blocker 上同时要求两个值。那一次的答案是 §4.2 RS0：**换掉判定方式**，用按序求值、首个为真者胜的守卫函数。v1.4 对 turn 原因用**完全相同**的手法，理由也相同：手写的互斥守卫（例如给 `REPLAN` 补一个"且 ACCEPTANCE 不成立"）在下一个事实组合上必然再漏一次，而全序天然完备、与遍历顺序无关、可以对全部 32 个真值组合穷举。

**权威状态**：§7.2 的表加一列"序"，TU4 冻结全序 `MANUAL ≻ VERDICT ≻ BLOCKER_DECISION ≻ ACCEPTANCE ≻ REPLAN`，每一格的理由都从已冻结的条款读出（人优先于机器、原因优先于后果、§4.2 守卫 3 ≻ 4、守卫 4 ≻ 7、兜底就是兜底）。TU5 与 I15 冻结"一次 reconcile 至多一条语义 turn"，被压下的原因写进 §6.2 的 `suppressedTurnReasons`。

**动作键**：`pc:v1:<projectId>:turn:<generation>:<reasonDigest>`，形状不变。变的是 `reasonCode` 唯一，因此 `reasonDigest` 唯一，因此键唯一 —— 一次快照不可能产出两条不同键的 turn 动作。

**恢复路径**：被压下的原因**不会丢**。它没有被消费掉，也没有被记成已处理；如果下一次 reconcile 它仍然为真（而胜过它的那个已经不成立了），它自然胜出并获得自己的 turn。`suppressedTurnReasons` 让这件事在审计里看得见，而不是靠推理。

**可执行断言**：`PC-CX-23 overlapping turn reasons are decided by one total order` —— 表驱动枚举五个谓词的全部 32 个布尔组合，每一组断言选中的 reasonCode 恰好零或一个、等于全序里第一个为真的那个、且与谓词求值顺序无关；交错 A 与 B 各作为具名回归用例。**反向对照**：去掉全序（回到 v1.3 的"五条独立触发条件"），A 与 B 立刻各产出两个 reasonCode、两条不同键的 turn 动作。

### 22.4 `PC-CX-24` 周期身份必须进入 turn 的事实

**最小交错序列**：

1. `MERGE_CONFLICT(subject = 分支/文件集)` 首次发生，`lifecycle_generation = 1`，`condition_version = A`（TF2：`(targetBranch, sorted(冲突路径), 冲突侧内容摘要)`）。`BLOCKER_DECISION` 开一条 turn，键 `turn:<g>:sha256(BLOCKER_DECISION ‖ (MERGE_CONFLICT, subject, A))`。
2. 协调器解决冲突，blocker 按 §11.4 自动解除（`resolved_at` 落库，**行还在**）。那条 turn 结束。
3. 一小时后，**同一个文件集、同样的内容**再次冲突。§11.3 BE1 正确地开出 episode 2（`lifecycle_generation = 2`），而 `condition_version` **仍然是 `A`** —— TF2 定义它是"产生这条 blocker 的那些快照事实"的摘要，而那些事实真的一模一样。
4. `turnFacts = (kind, subjectId, conditionVersion)` ⇒ `reasonDigest` 与第 1 步**逐字节相同** ⇒ §7.6 TR3 看到"同一 `(generation, reasonDigest)` 的 turn 已存在且已结束" ⇒ **不开 turn**，直接开 `COORDINATOR_NO_PROGRESS`（`owner = USER`）。协调器对这个**新故障**一次机会都没有，项目直接停在等人。

**Postgres MVCC 与锁语义**：数据库这一侧其实已经是对的 —— v1.3 的 BE1 让 `lifecycle_generation` 在插入的同一条语句里单调分配，两个唯一索引兜底（§11.3 BE2），`RAISE_BLOCKER` 的键也已经带上了它。缺的是**另一个消费者没有跟上**：`turnFacts` 仍然停在 v1.2 的三元组。这与 `PC-CX-15` 是同一个形状 —— v1.2 把 `occurrences` 从 turn 摘要里拿掉却留在升级里，v1.3 把代次加进 blocker 键却没加进 turn 摘要。**一个修法只做了一半，剩下的那一半会在另一个消费者身上原样复发**，这已经是第三次。因此 v1.4 不只改这一格，而是冻结 TF4：**`turnFacts` 里每一项若取自一行有生命周期的行，就必须带上那一行的代次**，并逐行给出三个消费者（blocker / verdict / acceptance）。

顺带要把 TF1 的分界写死：TF1 第 3 项"任何自增序号"如果照字面读，会把**必须**进来的周期代次也挡在外面 —— 而这正是本项发生的方式。判据用 §8.2 GE2 那一句：**把世界从 A 变到 B 再变回 A**，观测计数在没有 B 时也会前进（因此破坏"事实没变则键没变"），周期代次不会。

**权威状态**：同一 open episode 内的重复仍然得到**同一个** turn 键（TR1 的去重、AC8 的"不重复通知"逐字不变）；`clear → 同因复发` **必然**得到一个新的 `reasonDigest`、一条新的 turn。TR3 因此只在它真正想说的那件事上命中：**同一个 episode 里，协调器已经被叫醒过一次而事实没有变**。§7.6 补一条"TR3 的成立前提"，把这个推理的边界写在它自己旁边。

**动作键**：`pc:v1:<projectId>:turn:<generation>:<reasonDigest>`，其中 `turnFacts` 为 `(kind, subjectId, lifecycleGeneration, conditionVersion)` 排序摘要。`VERDICT` 与 `ACCEPTANCE` 同步补上 `verdictRevision` 与 `acceptanceAttempt`（TF4 的表）—— 它们是同一个缺口的另外两个实例，只是审查这一轮只撞到了 blocker 那一个。

**恢复路径**：复发获得一次新的 turn，协调器照常处理。若这一次 turn 结束后事实仍然没变（同一 episode、同一 conditionVersion），TR3 才正确地开 `COORDINATOR_NO_PROGRESS` 交给人；而那条 blocker 的自动解除条件仍然是 `reasonDigest` 变了（BL3），因此下一次真正的变化会把它自动清掉。

**可执行断言**：`PC-CX-24 a blocker episode that recurs earns a new turn, not a no-progress verdict` —— 对 §11.2 全部 `opensTurn = ✔` 的四个 kind 跑 `open → 重复投递 ×N → turn → clear → 同因复发`，断言：episode 1 内的 N 次重复恒为同一 turn 键；复发后 `lifecycle_generation` 为 2、`reasonDigest` 与 episode 1 不同、动作是 `OPEN_COORDINATOR_TURN` 而**不是** `COORDINATOR_NO_PROGRESS`；同 episode 内的第二次同 digest turn 仍然按 TR3 转 blocker。**反向对照**：把 `lifecycleGeneration` 从 `turnFacts` 里去掉（回到 v1.3 的三元组），同一序列立刻在复发处产出 `COORDINATOR_NO_PROGRESS`。

### 22.5 `PC-CX-25` 派发权投影由数据库自己算

**最小交错序列**（两条，都只需要一个"不认识新列"的旧写端）：

- **A（移入）**：Project `P` 已 `coordinatorEnabled = true`，其全部 Task 的 `dispatch_authority = 'COORDINATOR'`。一个旧 apiserver 把一条 legacy Task 移进 `P` —— 它只会写 `UPDATE task SET project_id = :p WHERE id = :t`，因为它的代码里根本没有 `dispatch_authority` 这个名字。投影停在 `LEGACY`。旧 sweep 随后按 `AND dispatch_authority = 'LEGACY'` 选中它并插入一条 `LEGACY_SWEEP` 占位：**D6 读到 `LEGACY`，合法放行**。按 `P` 的真实配置，这个 Task 本该由控制环派。
- **B（占位释放）**：启用 Coordinator 时有一条 `LEGACY_SWEEP` 占位在飞，v1.2 的 D8-b 正确地跳过了这个 Task。那条 Session 由旧写端结束（`UPDATE session SET status = 'COMPLETED'`），旧事务当然不会执行 v1.2 D3 的第三个写入点。Task **永久**停在 `LEGACY`，旧 sweep 可以一次又一次地派它。

两条都不需要竞态、不需要并发、不需要任何人做错事 —— 只需要滚动升级窗口里还有一个旧进程在跑，而 §12.4 与 D7-note 恰恰把"旧实例不能被观测到已退出"当成了必须承受的前提，并声称正确性由数据库承担。**这一格是假的**，判 P0。

**Postgres MVCC 与锁语义**：D5 / D6 / D9 都在数据库里，理由写得很清楚——"要挡住的两个入口一个是另一个进程的同一份代码，一个是另一个版本的旧代码；服务层的检查按定义对第二个无效"。但这条链的**第一环**（D6 读的那一列）仍然由服务层维护，于是整条链的强度等于最弱的那一环。修法只能是把这一环也放进数据库，而"放进数据库"有两种形状：一个**约束**（拒绝陈旧写入）或一个**投影触发器**（把写入改对）。这里必须是后者：旧写端写的是 `project_id`，它并不知道自己在改派发权，拒绝它等于让 legacy 路径在滚动升级期间大面积失败。因此 D8-a 的触发器 ① 在 `BEFORE INSERT OR UPDATE OF project_id, dispatch_authority ON task` 上**用派生值覆盖 `NEW.dispatch_authority`** —— 谁写、写成什么都一样，这一列**写不进一个错的值**。另一侧触发器 ② 在 `AFTER UPDATE OF coordinator_enabled ON project` 上 fan-out 到该项目全部 Task，按 id 升序取锁（D8-c，与批量插入 Session 同一个全序）。

触发器 ① 里的 `FOR SHARE` 与 D6 里的那两个词是同一个理由，也同样是**前提而不是谨慎**：没有它，"一条并发插入的新 Task 读到翻转前的值"与"翻转的 fan-out 看不见这条未提交的新行"会同时成立，投影就地陈旧 —— 也就是这条 P0 的第三种形状。它的代价被 D8-e 逐条写明：这是全序里唯一一处由数据库代为发起的逆序访问，新二进制因为已经按 AE10 / LO2 先取了 project 锁而不受影响，旧二进制可能与一次并发翻转成环并拿到 `40P01`，**那是 fail closed，落进 §8.6 LO4 的有界重试**。

删掉 D8-b 的 `NOT EXISTS` 是本项的第二半，它同时消掉了反例 B 和 LO1 里唯一一处逆序写入点。代价是承认一个**有界**的中间状态：翻转时在飞的那条 `LEGACY_SWEEP` 占位会跑完。它不是越权 —— 它是翻转**之前**由 D6 合法放行的；翻转**之后**的 legacy 插入在物理上不可能（D6 的 `FOR SHARE` 与翻转的 `FOR NO KEY UPDATE` 冲突，等锁后 EvalPlanQual 必然读到新值并拒绝）。因此 I12 拆成 I12-A（投影新鲜）与 I12-B（无越权**新**派发），而"控制环从不因为一次投影变更去杀掉别人已经启动的运行"这句话逐字保留。

**权威状态**：I12-A —— 任何已提交状态上 `task.dispatch_authority` 恒等于 `authorityOf(task)`，**由触发器保证，因此对任何版本的二进制成立**；I12-B —— `COORDINATOR` 权 Task 上不存在翻转之后插入的 `LEGACY_SWEEP` 占位，由 D6 保证。§12.3 D3 的三个服务层写入点**一起删除**；§12.4 的混合版本格改写。

**动作键**：不变。投影是一个派生列，不是一个动作。

**恢复路径**：不需要恢复 —— 陈旧在构造上不会发生。需要的是**可验证**：§7.7 D13 给出一条漂移查询，对生产快照直接跑，返回非 0 行即 P0；§12.1 G5 把它列为迁移验证必查的第四样（前三样只问对象在不在，这一样问结果对不对）。

**可执行断言**：`PC-CX-25 the authority projection is derived by the database, not maintained by a service` —— 模型侧断言投影的每一个写入路径（含旧写端的裸 SQL）都落在派生式上、且 §12.3 D3 不再有服务层写入点；真实 Postgres 侧由 `coordinator-linearization.pg.spec.ts` 的 `PC-CX-25 on real Postgres: an old writer cannot leave the authority projection stale` 建真表真触发器，用**只写 `project_id`、完全不提 `dispatch_authority` 的 SQL**（这就是旧二进制）跑 move-in / move-out / 翻转 / 结束占位四种写入，每一次都断言 D13 的漂移查询返回 0 行，并断言翻转之后的 `LEGACY_SWEEP` 插入被 D6 拒绝。**反向对照**：去掉投影触发器（回到 v1.2 的"服务层维护"），同一段旧写端 SQL 立刻留下 `dispatch_authority = 'LEGACY'` 而派生值是 `COORDINATOR`，D6 随后放行那条 legacy 占位 —— 与复审报告里的最小反例 A 逐字对应。

### 22.6 `PC-CX-26` 撤权、并发上限与派发共用一把锁

**最小交错序列**（两条）：

- **A（撤权后仍派发）**：快照 `coordinatorEnabled = true`、`policy = AUTO`、`token = 9`。控制环决定派发 Task A。用户在这之后提交 `coordinatorEnabled = false`（或 `AUTO → MANUAL`、或把 `max` 调到 0）。用户的那条 `UPDATE project` **不推进 `fencing_token`** —— token 是 reconcile 之间的锁，不是 reconcile 与人之间的锁。控制环的提交事务里唯一的硬条件 `WHERE fencing_token = 9` **仍然成立**，Session 照常插入。最终已提交状态：**自动化已被关掉 + 一条关掉之后由控制环创建的 Session**。
- **B（cap 被越过）**：快照 `inFlight = 0`、`maxConcurrentTasks = 1`。用户手动启动 Task B，控制环同时派 Task A。§7.7 D5 是 **per-Task** 的 partial unique index，两个 Task 的索引键不同，两条插入互不冲突，两边都成功 ⇒ `inFlight = 2`。§7.4 第 6 条读的是快照，快照里那时确实是 0。

**Postgres MVCC 与锁语义**：这一项的答案不需要任何新 primitive，它需要的只是**认出那把锁本来就在**。用户改这四个字段的语句是 `UPDATE project SET … WHERE id = :p`，Postgres 对它自动取 `FOR NO KEY UPDATE`；而 §8.6 LO1 的第一级、§13.4 AE6-a 的第一句，取的正是同一行同一把锁。v1.3 只是没有要求**派发**也去取它 —— 验收事实写入取，策略门控的派发不取。AU1 把这个要求补上：含任何被 §9.2 门控的动作的提交事务，**第一句**取 `project … FOR NO KEY UPDATE`，锁到手后用**读回来的那一行**重跑 §9.2 与 §7.4 第 6、7 条（这是一条新语句，`READ COMMITTED` 必然看得见已提交的人工写）。两者互斥之后只剩两种提交顺序，每一种的结果都唯一确定（AU1-a 的表），**不存在顺序不明的第三种状态**。

cap 那一半同理：两个入口在同一把锁之后各数一次占位（CAP1 的 `count(*)`），因为持有同一把行锁，这个计数在它们之间是**精确**的，上限不可能被并发越过。这里必须回答"为什么不做成数据库约束"，答案是一段可以被检查的论证而不是省略（CAP1-b）：`coordinatorEnabled = true` 的 Project，其全部 Task 的授权必为 `COORDINATOR`（I12-A），而旧 sweep 对 `COORDINATOR` 权 Task 一律被 D6 拒绝（I12-B），因此该 Project 上能创建占位的入口**恰好只剩控制环与人工两个**，两个都在新二进制里。**这个论证依赖 I12-A/I12-B，若将来任何一条被削弱，本条必须重新评估** —— 写下来是为了让那次重新评估会真的发生。

`config_revision`（AU2）不是并发控制，互斥是那把锁；它的作用有两个：让授权变化必然改变 `decisionInputHash`（S3 因此不会被一个看不见的输入弄假），以及让"决策时的 revision"与"提交时的 revision"成为 `project_decision` 里两个可以直接读的数，一次撤权竞态因此是一行记录而不是一次考古。

**权威状态**：I16 —— 任何已提交的策略门控动作，其提交事务重读到的授权仍然允许它；且不存在"`coordinator_enabled = false` 之后由控制环创建的占位"，不存在"同一 Project 占位数 > `max_concurrent_tasks`"。两句都可以对生产快照直接查。

**动作键**：不变。被撤销的动作**仍然占它的键**（键已经写进 `project_action`），只是 `status = REFUSED`、`refusal_code = AUTHORITY_REVOKED` —— 这是对的：那次决策确实发生过，只是没有被执行，审计里必须留下。

**恢复路径**：§8.5 C6 —— 被撤销的动作跳过副作用，outcome 其余部分（blocker / 审计行 / `nextWakeAt` / `consumed_at`）照常提交。把它做成回滚就会把事件消费一起丢掉，控制环在这条事件上活锁，那正是 `PC-CX-04`。人工入口撞 cap 时得到有类型的 `PROJECT_CONCURRENCY_LIMIT`，带上用户自己设的那个数和占着槽位的 Task —— **不是 500，也不是静默排队**。

**可执行断言**：`PC-CX-26 revocation and the project cap share one gate with dispatch` —— 模型侧对四个 mutator（`coordinatorEnabled = false`、`AUTO → MANUAL`、`max` 调低、人工启动另一个 Task）× 两个提交顺序枚举八格，每格断言结果落在 AU1-a 的两行之一、且占位数 ≤ `max`；真实 Postgres 侧由 `coordinator-linearization.pg.spec.ts` 的 `PC-CX-26 on real Postgres: policy revocation and the project cap are one gate` 用两条真实连接跑 barrier：一条改策略/cap，一条走 AU1 的取锁—重读—插入，两个顺序各跑一遍。**反向对照**：去掉 AU1 的第一句（回到只有 token 条件），交错 A 立刻提交出"`coordinator_enabled = false` + 控制环创建的 Session"，交错 B 立刻产出 `inFlight = 2 > max = 1`。

### 22.7 `PC-CX-27` 正文只留现行规则

**最小交错序列**（这一项没有运行期交错，它的"交错"发生在两个实现者之间）：

1. 实现者甲读 §13.1 AG1："聚合……（幂等键的 epoch 取子状态摘要，§8.2）"，于是给 `AGGREGATE_PARENT` 写了一个带 `childrenDigest` 的永久键。这**复活了 `PC-CX-17`**：`DONE → OPEN → DONE` 的第三次撞历史键，父任务永久停在 `OPEN`。
2. 实现者乙读 §13.1 AG5："`AGGREGATE_PARENT` 是一次对当前子状态的重算……**它不进 `project_action`**"，于是写了 CAS。
3. 两个人都能引用"冻结"二字，而契约**没有唯一裁决**。

同一形状的第二处：§13.4 AE8 写着"持有 AE6 那把 `FOR SHARE` 的写入者"，而 AE6-a 与 §8.6 LO3 在 v1.3 已经把它冻结成 `FOR NO KEY UPDATE`，理由正是 `FOR SHARE → UPDATE` 的锁升级在真实服务器上产出 `40P01`。**照 AE8 字面实现就会复活 `PC-CX-19`。**

**Postgres MVCC 与锁语义**：这一项与数据库无关，但它的成因值得写下来，因为它是本项目**第三次**在同一个地方摔跤：§9.4 的三级升级阶梯与 `occurrences > 10` 在 v1.1→v1.2 里留了两轮（`PC-CX-15`），v1.3 的修法给它加了一条**静态断言**（"§9.4 与 §11.5 里不再有 `occurrences >` 阈值或三级阶梯的字样"）。那条断言是对的，但它只覆盖了**它自己那一处**。一份两千行的契约里，一条规范会出现在动作表、键模板、闭环日志、验收映射、迁移步骤五六个地方，改其中一处而漏掉别处是必然事件，不是疏忽。**所以修法不能是"这次改仔细一点"，只能是一条会随修订一起长大的机制。**

**权威状态**：§0 RL1 冻结"**§1–§18 是规范正文，§19–§22 是非规范的修订日志**"，并在四个修订日志各加一条横幅。于是"一句被取代的规范"有了一个精确的判据：它要么被删，要么只能出现在 §19–§22 或反例测试里。§13.1 AG1 的尾巴与 §13.4 AE8 的 `FOR SHARE` **已删除**。

**动作键**：不变。

**恢复路径**：§22.8 的**残句账**。每一条被取代的规范登记一行：被取代的字样、取而代之的条款、以及它复活时会重新变成哪个 `PC-CX-`。契约测试对 §1–§18 逐条扫描这张表，命中即红。下一轮修订如果又取代了一条规范而没登记，`PC-CX-27` 会以完全相同的方式复发 —— 因此登记这一行本身也是修订流程的一部分（§22.9）。

**可执行断言**：`PC-CX-27 no superseded normative sentence survives in the normative body` —— 从 §22.8 读出全部"被取代的字样"，断言它们在 §1–§18 里一次都不出现（在 §19–§22 里出现多少次都行，那是日志）；另断言 §19–§22 每一节的开头都有非规范横幅、且 `AGGREGATE_PARENT` 在 §7.3 的键列恒为"无"。**反向对照**：把 AG1 的尾巴或 AE8 的 `FOR SHARE` 放回去，这条断言当场红 —— 这正是它与 v1.3 那条只盯 §9.4 的断言的差别。

### 22.8 残句账（v1.4 新增，`PC-CX-27` 的可执行形式）

**本表是规范的**（它被 §0 RL1 引用，且契约测试直接读它），尽管它长在一个非规范的小节里 —— 与 §19–§22 其余部分的分工是：那些记录"当时是什么样"，本表记录"现在**不许**再出现什么"。

每一行的读法：**"被取代的字样"这一列里的文本，在 §1–§18 里只允许出现在一条带出处标记的行上**。出处标记 = 该行同时含有一个版本号（`v1.1` / `v1.2` / `v1.3` / `v1.4`）或一个 `PC-CX-nn`。这条约定同时服务两件事：给读者一个"这句话是历史，不是要求"的即时信号，给静态检查一个可靠的锚。**一条既没有出处标记、又命中本表的行，就是一条活着的旧规范。**

| 被取代的字样 | 现行条款 | 复活会变成 |
|---|---|---|
| `幂等键的 epoch 取子状态摘要` | §13.1 AG5（`AGGREGATE_PARENT` 无键，current-state CAS） | `PC-CX-17` |
| `持有 AE6 那把` | §13.4 AE6-a · §8.6 LO3（`FOR NO KEY UPDATE`，不升级） | `PC-CX-19` |
| `FROM project WHERE id = :p FOR SHARE` | §13.4 AE6-a（`FOR NO KEY UPDATE`） | `PC-CX-19` |
| `occurrences > 10` | §11.5 ES4（唯一触发是存活时长） | `PC-CX-15` |
| `SYSTEM → COORDINATOR → USER` | §11.5 ES3（升级恰好一步，目标恒为 `USER`） | `PC-CX-12` |
| `的写入点恰好` | §12.3 D3 · §7.7 D8-a（派生列，没有服务层写入点） | `PC-CX-25` |
| `保持它当前的派发权` | §7.7 D8-b（照常翻转，承认有界的 pre-flip 占位） | `PC-CX-25` |
| `任何顺序下已提交的占位 Session 条数 ≤ ` | §9.6 CAP0 · CAP3 · §4.3 I16-A/I16-B（准入上限，不是当前状态上限） | `PC-CX-28` |
| `同一 Project 的占位 Session 条数 > ` | §4.3 I16-A（准入，恒成立）· I16-B（提交时，点态） | `PC-CX-28` |
| `重跑 §9.2 与 §7.4 的第 6、7 条` | §9.6 AU1（第 6、7、**8** 条）· §7.4 EC3 | `PC-CX-29` |
| `从 §7.3 的动作表、§8.2 GE1 的代次表与 §13.4 AE1 的摘要投影里收集列名` | §6.1 S8（**五处**读集，含 §4.2 守卫与 §7.6 TR1–TR3）· S9 | `PC-CX-30` |
| `上面 1–6 条` | §10.4 N-null（1–**7** 条）· §10.4 第 7 条 | `PC-CX-31` |
| `触发信号的` | §7.2 TF5（全部未消费 `user.manual_trigger` 的排序摘要） | `PC-CX-31` |
| `它是一个 STABLE 的 SQL 函数` | §7.7 D14-a · D14-f（`VOLATILE`，否则每次调用 `0A000`） | `PC-CX-32` |
| `契约测试从这五处收集列名` | §6.1 S8（**六处**读集，第六处是 §7.4 第 8 条的 PAC 解析链）· S10 | `PC-CX-33` |
| `等价的可查询形式：不存在一条 dispatch_origin = 'COORDINATOR' 的占位` | §4.3 I17-A（快照 = 冻结上下文，恒成立）· I17-B（提交时，点态）· I17-c | `PC-CX-34` |
| `跑一次 I17 的可查询形式并断言返回 0 行` | §12.1 G5（改成跑 I17-A） | `PC-CX-34` |
| `nextWakeAt 必然 ≤ windowEndsAt` | §10.4 W5 第 3 条 · §7.6 TR2-d（`≤ windowEndsAt + 5s`） | `PC-CX-35` |
| `next_wake_at 指向同一时刻且 next_wake_reason = 'manual trigger rate-limited'` | §7.6 TR2-e（仅当窗口边界是 W5 选中的候选）· §10.4 W5 | `PC-CX-35` |
| `没有第三种形状` | §4.3 I18-A · I18-B · I18-C（三种形状）· I19 · §10.2 W4 (iv) | `PC-CX-36` |
| `NEW.fencing_token IS DISTINCT FROM OLD.fencing_token` | §7.7 D11（闭集 allowlist：`to_jsonb(NEW/OLD) - writable` 整行比较） | `PC-CX-37` |
| `断言六列全部被拒、两列仍可写` | §7.7 D11-e（schema 驱动的逐列 mutation）· §12.1 G5 | `PC-CX-37` |
| `PAC §6：agent_id / provider / model / workspace_id / assigned_runner_id` | §4.3 I17-A（只含 create 冻结列）· I17-A2（claim 冻结列按阶段与代次） | `PC-CX-38` |
| `并列时取 source 最小的那一个` | §10.4 W5 第 2 条（`(at, source, subjectType, subjectId)` 全序） | `PC-CX-39` |
| `最早一个处于失败退避中的 Task 的退避到期时刻` | §10.4 第 3 条 · W5 第 1 条（每个 Task 一条候选，由全序选） | `PC-CX-39` |
| `nextWakeAt = max(chosen.at, now + 5s)` | §10.4 W5 第 3 条（`max(chosen.at, evaluation.epoch + 5s)`） | `PC-CX-40` |
| `要写 now() 的地方只剩两处` | §6.1 S5（只剩展示与投递字段）· §10.4 W5 第 7 条（两处例外都不产生决策行） | `PC-CX-40` |
| `不消费事件、不 reconcile` | §4.3 I6（不 reconcile / 不产生动作）· §5.5 EV3（出环的行按终态处置丢弃） | `PC-CX-41` |
| `又不被 backstop 看见。这一条与 I5 的分工` | §4.3 I19-a · I19-b · I19-c（三支封闭，第三支是出环的终态处置） | `PC-CX-41` |
| `必须与动作行上冻结的那一份逐字相同` | §7.4 EC2-a · EC2-b · EC3 的两行判据表（两个摘要各比各的） | `PC-CX-42` |
| `IF OLD.status <> 'APPLIED' THEN RETURN NEW` | §7.7 D11（v1.8：`CLAIMED` 走发布 allowlist，终态走终态 allowlist，没有整行放行的分支） | `PC-CX-43` |
| `IS DISTINCT FROM ctx->'requiredCapabilities' THEN` | §7.7 D15（v1.8：create 冻结集续到 `permission_mode` / `resolution` / `snapshot_frozen_at`，`requiredCapabilities` 不再是最后一行） | `PC-CX-44` |
| `cannot rewrite a create-frozen column'` | §7.7 D15（v1.8：同一条也冻 lineage，消息是 `create-frozen or lineage column`） | `PC-CX-45` |
| `sha256(canonical(resolvedAgentId ‖ projectMemberId` | §7.4 EC2-a（`sha256(canonical(executionContext.authorization))`，九个键的对象 + §7.7 D17 的规范化函数） | `PC-CX-48` |
| `sha256(canonical(executionContext))` | §7.4 EC2-b（`canonical(executionContext - 'authorization')`）· EC2-d（两半互不相交） | `PC-CX-48` |
| `仍然只由 I17-A 的审计查询发现，而不是被拒绝` | §7.7 D17（提交点重算，伪造得到 `EXECUTION_DIGEST_MISMATCH`）· §4.3 I17-A | `PC-CX-48` |
| `Session 上的值与它逐字相同` | §4.3 I17-A2 代次 1 行 · §7.4 EC6-c（冻结分量是具体值或 `DEFERRED_TO_CLAIM` 的两支，各只有一种合法组合） | `PC-CX-47` |
| `代次 1 ⇒ 有 claimResolution、retiredPins 恰好 0 条` | §7.7 D16-b（闭合形状 + 折叠回 Session 此刻的 pin）· §7.4 EC6-e | `PC-CX-49` |
| `每条含被换掉的值、换成的值与时刻` | §7.4 EC6-c（`retiredPins[k]` 恰好六个键）· EC6-e（链与代次） | `PC-CX-49` |

**登记规则（冻结）**：一次修订如果**取代**了一条规范（而不只是补充），必须在本表加一行；如果只是新增，不加。**v1.5 按这条规则加了六行**（`PC-CX-28` 两行、`PC-CX-29` 一行、`PC-CX-30` 一行、`PC-CX-31` 两行）；`PC-CX-29` 的另外那些新增条款（EC1–EC5、D14）**不入表**，因为它们没有取代任何一句话，只是补上了第 8 条一直缺的那道门。判据是一句话：**如果有人照旧句子实现，会不会得到一个已经被审查记过号的缺陷？** 会，就必须登记。**v1.6 按这条规则加了七行**（`PC-CX-32` 一行、`PC-CX-33` 一行、`PC-CX-34` 两行、`PC-CX-35` 两行、`PC-CX-36` 一行）；`PC-CX-36` 新增的 I18-B / I19 / W4 第 (iv) 支**不入表**，因为它们补的是一段一直没被写下来的形状，没有取代任何一句话。 **v1.7 按这条规则加了十行**（`PC-CX-37` 两行、`PC-CX-38` 一行、`PC-CX-39` 两行、`PC-CX-40` 两行、`PC-CX-41` 两行、`PC-CX-42` 一行）；v1.7 新增的 D15、EC2-b、EC5-a、EC6、§5.5 EV1–EV6、I17-A2、W5 第 6/7 条与 W4-b **不入表**，因为它们补的是一直缺的一道门或一段一直没被写下来的形状，没有取代任何一句话。**v1.8 按这条规则加了三行**（`PC-CX-43` 一行、`PC-CX-44` 一行、`PC-CX-45` 一行）；**v1.9 按这条规则加了六行**（`PC-CX-47` 两行、`PC-CX-48` 三行、`PC-CX-49` 两行 —— 其中 EC2-a 与 EC2-b 的两句旧公式各占一行，`§26.5` 那句"只由审计查询发现"占一行，因为照它实现就会得到 `PC-CX-48` 本身）；v1.9 新增的 EC2-d、EC6-e、D14-h、D16-f 与 D17 **不入表**，因为它们补的是一直缺的一道门，没有取代任何一句话。**v1.7 的十行每一行登记的都是一句在 §1–§18 里真的写过、而现在已经不在的话**，不是复审报告里的概括 —— 一条永远匹配不上的行永远不会失败，那正是 v1.6 在自己的账上发现并修掉的毛病。

**为什么 `PC-CX-21` 没有自己的一行**：它修的不是一句被写错的规范，而是**一条不变量被写成了错误的时态** —— §4.3 的 I11 没有哪一句需要被禁止再出现，它被**拆成**了 I11-A 与 I11-B。照 v1.3 的 §4.1 / §10.3 字面实现不会产生那个缺陷（那两处只是引用 I11），产生缺陷的是把 D9 的等号当成恒成立。因此按登记规则它不入表，改由契约测试的**结构断言**盯住：§4.3 必须同时定义 I11-A（含 `<=`）与 I11-B（含"提交时"）、§7.7 必须有 D9-e、§10.3 (a) 必须引用 I11-A 而不是裸的 I11。**账要记得诚实：一条不适用的规则不该被硬塞进表里凑数。**

### 22.9 本次修订**没有**做的事

同 §19.9 / §20.7 / §21.7，边界要写清楚：

- **本次修订仍不含实现**。03–23 单元一行业务代码都还没写；`project.config_revision`、D10 / D11 / D12 的四个触发器、AU1 的取锁与重读、`evaluation` 的到期事实目前都是**契约条款**，不是数据库里的对象或代码里的函数。真实 PostgreSQL 测试建的是**测试用的表**，它们证明的是"这些 SQL 语义成立"，不是"迁移已经写好了"，后者归 03 / 04 单元（§12.1 G5 已列出必须显式验证的十一样东西）。
- **四份审查文档一字未改**（任务的硬约束）。它们记录的是 v1、v1.1、v1.2 与 v1.3 的事实；v1.4 的回应写在本节。
- **02 在 v1.3 轮留下的 `coordinator-v13-adversarial.spec.ts` 被翻转，不是被删**。那份 spec 的每一条断言原本证明"缺陷存在"，修好之后它们必然与新契约冲突；该报告 §5 的后续清单明确要求"把它们从证明缺陷存在翻转成旧交错被拒绝/得到唯一合法结果"。翻转后每条断言**同时保留 v1.3 的形状作为反向对照**，因此"这个缺陷当初真的存在"与"它现在真的被挡住了"在同一个测试里各有一句。
- **三处行为变更，不是措辞澄清**，写在这里以免下一个人以为它们只是没写全：§4.3 I11 从"等于当前 token"改成"`<=` + 提交时等号"（并因此需要 D10 / D11 两条反向约束）；§7.7 D8-b 从"有占位就不翻转"改成"照常翻转，承认一个有界的 pre-flip 占位"（并因此删掉 §12.3 D3 的三个服务层写入点）；§9.6 AU1 让**每一个策略门控动作**的提交事务都取 project 行锁（代价是同一 Project 的派发与人工策略写之间会排队）。
- **cap 没有做成数据库约束**。CAP1-b 给出了论证与它依赖的两条前提；这是一次有论证的取舍，不是遗漏，而且论证写成了"若前提被削弱必须重新评估"的形式。
- **没有给"不经过 Orbit 的 `git push`"发明一把锁**。§13.4 AE9-d 那条边界逐字不变：有界延迟的检测 + 原子重开，不是互斥。
- **`evaluation` 的到期事实只有模型级断言**。它是一段读输入时的求值策略，不是数据库语义；等 09 / 11 单元写出快照读与决策记录，才有真实入口可测。

---

## 23. `PC-CX-28..31` 修订闭环（v1.5）

> **本节是非规范的（non-normative）修订日志**（§0 RL1，v1.4 冻结、v1.5 扩到本节）。它记录 v1.5 当时的事实与当时的推理，**不是现行规范**；任何一句与 §1–§18 冲突时一律以 §1–§18 为准。历史形状只允许出现在这里和反例测试里（`PC-CX-27`）。

02 对 v1.4 的独立复审（[`project-coordinator-contract-review-02-v1.4.md`](./project-coordinator-contract-review-02-v1.4.md)）判 **FAIL / BLOCKED**，给出 2 个 P0、2 个 P1。本节是**逐项关闭的索引**，格式与 §19 / §20 / §21 / §22 相同。**五份审查文档都不因本次修订而改动** —— 它们记录的是 v1、v1.1、v1.2、v1.3 与 v1.4 的事实，那些事实没有变；变的是契约。

四项里有两条贯穿的线，而且两条都是**上一轮学到的教训没被推到底**。

第一条是**时态**。v1.4 用 `PC-CX-21` 学会了"一条只在某个时刻成立的性质要写成点态的那一句"，并按这条纪律拆了 I11、拆了 I12。但**同一轮里新写的 I16 又是一条当前状态不变量** —— "任何顺序下占位数 ≤ cap"要求这个数在每一个已提交状态上都成立，而用户有权在派发之后调低 cap。教训学会了，却没有回头看这一轮自己新增的那条（`PC-CX-28`，P0）。

第二条是**门的覆盖面**。v1.4 用 `PC-CX-26` 认出"人和控制环必须共用一把锁"，于是给 §7.4 的第 6、7 条装上了提交点复核。但**第 8 条（PAC 的执行上下文解析）留在了快照上**，而它读的东西（Agent、团队、Provider、Workspace、Runner）恰恰是人最常改的那些。一个已被禁用的 Agent 与一个已被关掉的 `coordinatorEnabled`，对 I7 是同一件事，v1.4 的门却只挡住后者（`PC-CX-29`，P0）。

另外两项是同一形状的其它实例：`decisionInput` 在 v1.4 被宣布"完整"，但完整性的**采集面**是手选的三张表，恰好一张都不覆盖 §4.2 的守卫与 §7.6 的 TR1–TR3 —— 也就是**唯一**读 `project_action` 的两处（`PC-CX-30`）；TR2 冻结了"至多一次"，却没冻结"被拒的那一次去哪了"，于是一个人的显式请求可以合法地消失，或者合法地忙等（`PC-CX-31`）。

v1.5 的答案在四处：**一对时态明确的 cap 不变量**（I16-A 准入 / I16-B 提交时，配 CAP0 / CAP4 的有界可见 over-cap 状态）、**一份冻结的执行上下文读集与它的提交时门**（EC1–EC5 + D14 + I17）、**一份由五处读集反推出来的决策输入**（S8 / S9）、以及**一条持久、可恢复、有确定唤醒时刻的限频 pending 请求**（TR2-a–TR2-e + §10.4 第 7 条 + TF5 + I18）。

| ID | 级别 | 规范条款 | 权威状态 | 动作键 | 恢复路径 | 可执行断言 |
|---|---|---|---|---|---|---|
| `PC-CX-28` | **P0** | §4.3 I16-A · I16-B · §9.6 CAP0 · CAP1 · CAP3 · CAP4 · §6.1 `budget.overCapBy` · §15 F31 · F34 | cap 是**准入**上限：每条占位在**它插入的那一刻**读到 `count < max`（I16-A）；提交那一刻授权仍允许（I16-B）。`inFlight > max` 是一个有界、可见、自排空的状态，不是违约 | 不变（准入是锁 + 计数，不是键） | 调低永不被拒、在飞一条不动；over-cap 期间无人能准入，一条在飞结束即恢复；`overCapBy` 与 `{oldMax,newMax,inFlightAtWrite}` 落审计 | `PC-CX-28 the cap is an admission limit, and both commit orders satisfy one invariant` |
| `PC-CX-29` | **P0** | §7.4 A6 · EC1–EC5 · §7.7 D14 · §9.6 AU1 · AU3 · §8.5 C6 · §8.6 LO1 · §4.3 I17 · §12.1 6e · G5 | 已提交的 COORDINATOR 占位，其提交事务重解析出的执行上下文摘要 = 动作行上冻结的那一份（I17），由 D14 在 `COMMIT` 证明，与二进制版本无关 | 不变；被撤销的动作记 `REFUSED` / `EXECUTION_CONTEXT_REVOKED`，`dispatch_attempt` 照常前进 | 八个 `revokedInput` 各映射到恰好一个后果（EC5），全部落在 §11.2 已有的 kind 上；`TASK` 那一格只记 `NOOP` 等下一次事件 | `PC-CX-29 the frozen execution context is re-resolved at the commit point` |
| `PC-CX-30` | P1 | §6.1 S8 · S9 · `world.actions` · `world.coordinatorSession` · `evaluation.turnWindows` · §4.2 · §7.6 | `decisionInput` 含决策实际读的最小 `project_action` / turn 投影；同一份声明输入不可能要求两个 `run_state` 或两个 TR 结果 | 不变；键仍由 `world` 里的代次唯一决定 | 无需恢复；采集面是五处读集而不是三张手选的表，漏字段在契约测试里当场红 | `PC-CX-30 the declared decision input carries the action history its own rules read` |
| `PC-CX-31` | P1 | §7.6 TR2-a–TR2-e · §7.2 TF5 · §10.4 第 7 条 · N-null · §4.3 I18 · §15 F36 | 被限频的显式请求**保持未消费**，`next_attempt_at` = 窗口边界，`next_wake_at ≤` 该边界；窗口身份 = 锚点动作的 `idempotency_key`，单调不复用 | 窗口过后开出的 turn 键仍是 `turn:<generation>:<reasonDigest>`，`reasonDigest` 由**全部 pending `dedupeKey`** 的排序摘要算出（TF5） | 到点自动开**一次** turn 回答掉全部 pending 请求并一起消费；不丢、不排队、不忙等；四处可见（`signals` / 事件行 / `NOOP` / `next_wake_reason`） | `PC-CX-31 a rate-limited manual trigger is durable, deterministic and visible` |

新增的模型断言在 [`coordinator-counterexample.spec.ts`](../src/apiserver/src/projects/coordinator-counterexample.spec.ts)，新增的真实 PostgreSQL 断言在 [`coordinator-linearization.pg.spec.ts`](../src/apiserver/src/projects/coordinator-linearization.pg.spec.ts)；02 在 v1.4 轮次留下的 [`coordinator-v14-adversarial.spec.ts`](../src/apiserver/src/projects/coordinator-v14-adversarial.spec.ts) 按 §22.9 对 v1.3 那份 spec 的同一条纪律**从"证明缺陷存在"翻转成"旧交错被拒绝/得到唯一合法结果"**，并把 v1.4 的失败形状原样保留为每条断言里的**反向对照**。

### 23.1 `PC-CX-28` cap 是准入上限，不是当前状态上限

**最小交错序列**（一条，而且它每一步都合法）：初始 `max = 2`、`inFlight = 1`。控制环取 `project … FOR NO KEY UPDATE`，按 CAP1 数出 `count = 1 < 2`，插入第二条占位并提交 —— AU1-a 的第二行**明确**允许（"控制环先提交 ⇒ 人工写等锁 ⇒ 控制环的 Session 已存在且合法"）。用户随后拿到同一把锁，把 `max` 改成 1，写入成功。已提交状态：`inFlight = 2, max = 1`。v1.4 的 I16 后半与 CAP3 都说这不可能。**没有任何一个参与者做错事**，冲突的是契约自己的两句话。

**为什么不能靠"cap 写入者拒绝 `newMax < inFlight`"修**：审查给了两条路，v1.5 选第二条，理由写在 §9.6 CAP0 的那张两行表里。要点是"拒绝调低"会把一个**用户对自己设的数的修改**变成一次系统否决，而唯一能让当前状态立刻满足新 cap 的动作是**杀掉在飞的 Session** —— §9.3 第 4 条那一类永不代劳的破坏性动作。真正错的是不变量的时态，不是用户的操作。

**Postgres MVCC 与锁语义**：这一项**不需要**任何新 primitive，甚至不需要新的锁 —— 两个入口本来就在同一把 `project` 行锁之后数同一个 `count(*)`（CAP1）。要害是那把锁能保证的到底是什么：它保证 `(count, max)` 是**同一个事务在同一时刻读到的一对值**，因此"准入时没有越界"可以被精确判定；它**不能**保证"此后 max 不会变小"，因为让 max 变小的那次写入本身就是一次合法的、拿着同一把锁的提交。**一把行锁能线性化写入的顺序，不能让一个后来的写入去否定一个更早的、当时合法的事实。**

**权威状态**：§4.3 I16-A（准入，恒成立）+ I16-B（提交时，点态），§9.6 CAP0-a/b/c 给出判据、不追溯语义与可查询形式，CAP4 给出 over-cap 的四条性质（有界单调收敛、可见、不阻塞不告警、不影响 `sessionBudgetPerDay`）。§15 F31 改述、F34 新增。

**动作键**：不变。准入是"锁 + 计数"，不是一个动作身份 —— 与 `PC-CX-26` 同型。

**恢复路径**：不需要人工动作。over-cap 期间**任何入口**都拿不到准入（CAP0-a），一条在飞 Session 结束就自动回到 `inFlight <= max`。控制环侧记一条 `over_cap_draining` 的 `NOOP` + `nextWakeAt = now + 60s`（§10.4 第 5 条），人工侧撞 cap 仍是 `PROJECT_CONCURRENCY_LIMIT`（CAP1-a 逐字不变）。

**可执行断言**：`PC-CX-28 the cap is an admission limit, and both commit orders satisfy one invariant` —— 模型侧对四个 mutator × 两个提交顺序（`USER_FIRST` / `COORDINATOR_FIRST`）枚举八格，**每一格用同一条 I16-A 断言，没有任何一格有豁免**（v1.4 的模型测试给 `COORDINATOR_FIRST` 加了 `|| order === 'COORDINATOR_FIRST'`，那正是复审点名的"宣称遍历八格却给会红的那格开后门"）；真实 Postgres 侧由 `coordinator-linearization.pg.spec.ts` 的 `PC-CX-28 on real Postgres: lowering the cap never breaks the admission invariant` 跑两个提交顺序 + over-cap 排空。**反向对照**：把断言换回 v1.4 的"任何顺序下占位数 ≤ max"，`lowerMax × COORDINATOR_FIRST` 那一格立刻红 —— 与复审报告 §6 `PC-CX-28` 的那一行输出逐字对应。

### 23.2 `PC-CX-29` 执行上下文也要在提交点复核

**最小交错序列**：快照里 assignee Agent `enabled = true`，控制环按 §7.4 第 8 条解析出 `(agent a1, provider, model, workspace, runner)` 并决定派发。用户提交 `UPDATE agent SET enabled = false WHERE id = 'a1'`。控制环随后取到 `project` 行锁，AU1 重读四个策略字段 —— 它们**全都没变**，因此全都允许 —— 按**旧解析**插入一条 `agent_id = 'a1'` 的 Session 并提交。已提交状态：**Agent 已禁用 + 一条解析到它的新 Session**。同型的还有七种：把成员移出团队、改 `task.assignee_agent_id` / `provider` / `model`、撤回 Provider、软删 Workspace、关掉 Runner、重绑 `coordinator_workspace_id`。

**为什么 v1.4 的门挡不住**：AU1 的正文逐字写着"重跑 §9.2 与 §7.4 的第 6、7 条"。第 8 条不在里面，而 D5 / D6 / D9 / D12 证明的是**占位互斥、派发权、归属、投影新鲜**四件事，没有一件读 Agent 的 `enabled`。§4.3 I7 说"控制环发起的动作，其授权判定与该动作由用户手动发起时完全相同" —— 一个人手动在一个已禁用的 Agent 上开 Session 会被 PAC §12 直接拒绝，控制环却能提交，这是 I7 的直接反例。

**Postgres MVCC 与锁语义**：这一项的答案与 `PC-CX-26` 同型但**不能照抄**：那一把锁在 `project` 行上，而执行上下文的八个输入分散在 `agent` / `project_member` / `task` / `provider` / `workspace` / `project_workspace` / `runner` 六张表上，全部**不在** `project` 行的锁下。三条候选路各自的结局都要写清楚，因为它们都被认真考虑过：

1. **给每行加一个 revision 列，提交时比对** —— 不行。普通读在 MVCC 下看不见未提交的写，比对通过与人工写提交之间仍有窗口；这正是 §9.6 AU2 已经写死的那句"把 revision 当成 CAS 会重蹈 D8-note 的覆辙"。而且它要往 PAC 拥有的表上加列，越过了本文的边界（§2.4）。
2. **`FOR KEY SHARE`** —— 不够。它不与 `FOR NO KEY UPDATE` 冲突，而人改 `enabled` / `available` / `deleted_at` 这些**非键列**走的正是 `FOR NO KEY UPDATE`。
3. **`FOR SHARE`** —— 够。`SHARE` 与 `NO KEY UPDATE` **冲突**，因此重解析期间任何一次撤权都必须排队；锁按 §8.6 LO1 的同一条链取（`project_member` / `agent` 在 `project_runtime` 与 `task` 之间，`project_workspace` / `workspace` / `runner` 在 `task` 与 `session` 之间），只取共享锁、绝不升级（LO3），人工侧每次只写一行，构不成环。

  选 3，并且**同时**把它写进数据库（D14 的可延迟约束触发器 + `resolve_execution_context_locked`）—— 理由与 D5 / D6 / D9 逐字相同：服务层的检查只在写这段检查的那个二进制里存在，而 §12.4 那一格声称"与二进制版本无关"。D14-c 把这次重复实现的代价、它的失败方向（fail closed）与"将来什么条件下必须重新评估"一并写下来。

  **真实服务器上跑出来的一件事改了条款**：可延迟约束触发器**在 `COMMIT` 那一刻才取锁**，因此只有 D14 时，"控制环先提交、人工写随后生效"这个 AU1-a 明确允许的顺序**不可达** —— 人的撤权可以落在插入与 `COMMIT` 之间，D14 会抓住它，但结果是一次拒绝而不是排队。所以 EC3（服务层，插入**前**取 `FOR SHARE`）与 D14（数据库，`COMMIT` 时再证明一次）**两者都要有**，分工写在 D14-e：前者让合法顺序可达并给拒绝一个名字，后者让跳过它的任何写端也不可能提交。这条不是推理出来的，是 `PC-CX-29 on real Postgres` 第一版断言在真实服务器上红了才发现的。

**权威状态**：§4.3 I17。冻结读集是 §7.4 EC1 的八行表（每行带一个 `revokedInput` 值），摘要是 EC2，提交点重解析是 EC3，拒绝码是 EC4（`EXECUTION_CONTEXT_REVOKED` + 八值封闭枚举 + 序号最小者胜的全序），恢复是 EC5（逐值映射到 §11.2 **已有**的 kind，不新增 kind）。

**动作键**：不变。被撤销的动作照常占它的键并记 `REFUSED`（§8.5 C6），**且 `task.dispatch_attempt` 在同一事务里 `+1`** —— 否则撤权解除后的重派会撞历史键被永久跳过，那是 `PC-CX-11` 的形状（EC5 末段把这条推论写死）。

**恢复路径**：EC5 的表逐值确定。`AGENT` / `MEMBERSHIP` 开 `WHO_DISABLED` / `WHO_NOT_IN_TEAM`，`PROVIDER` 开 `PROVIDER_UNAVAILABLE`（**绝不静默换 Provider**），`MODEL` 开 `RUNTIME_REQUIREMENT_UNMET`，`WORKSPACE` 开 `NO_PROJECT_WORKSPACE`，`RUNNER` 开 `NO_MATCHING_RUNNER`，`COORDINATOR_WORKSPACE` 开 `COORDINATOR_UNAVAILABLE`；只有 `TASK` 那一格**不开 blocker** —— 任务被改本身会发 `task.updated`，下一次 reconcile 读到新事实重新决定。

**可执行断言**：`PC-CX-29 the frozen execution context is re-resolved at the commit point` —— 模型侧对八个 `revokedInput` × 两个提交顺序枚举十六格，断言 `USER_FIRST` 全部 `REFUSED(EXECUTION_CONTEXT_REVOKED)` 且不产生 Session、`COORDINATOR_FIRST` 全部合法且 I17 在提交那一刻为真，并断言 EC4 的最小序号裁决与 EC5 的逐值映射是全函数；真实 Postgres 侧由 `coordinator-linearization.pg.spec.ts` 的 `PC-CX-29 on real Postgres: the deferred guard refuses a revoked execution context` 建 EC1 八行的最小投影 + D14，跑两个提交顺序并观测阻塞。**反向对照**：去掉 D14（或把 `FOR SHARE` 换成普通读），`USER_FIRST` 立刻提交出"`enabled = false` + 一条解析到它的 Session" —— 与复审报告 §6 `PC-CX-29` 的那一行输出逐字对应。

### 23.3 `PC-CX-30` 声明的输入要含决策真正读的那一段历史

**最小交错序列**（两组最小反例，各自独立；这一项的"交错"不在时间上，而在两份**同时存在**的数据库状态之间）：

- **`run_state` 分叉**：两份数据库状态的 §6.1 v1.4 可见投影（`world` / `evaluation` / `signals`）**逐字相同**，其中一份多一条未收敛的 `RUN_PROJECT_ACCEPTANCE` 动作行。§4.2 守卫 4 要求前者 `PLANNING`、后者 `ACCEPTANCE`。同一个 `decisionInputHash`，两个必需的 `run_state` —— S3（同 hash ⇒ 逐字相同的机械决策）为假。
- **TR 分叉**：同样两份逐字相同的声明输入，隐藏的既有 turn 一份还在飞、一份已结束。§7.6 要求前者记 `ALREADY_APPLIED` 继续提交，后者开 `COORDINATOR_NO_PROGRESS`。

**Postgres MVCC 与锁语义**：这一项与数据库无关 —— 它不需要任何锁，两份状态都是**已提交**的、各自内部一致的快照，问题在于契约声明的输入投影**不足以区分它们**。写下这一行是因为格式要求逐项回答同样的六个问题，而"这一项不涉及并发"本身就是一个要被明确说出来的答案：拿锁去修一个完备性缺陷，只会得到一个更慢的、同样不完备的实现。

**为什么 v1.4 的 S8 测不出来**：S8 那句话是对的（"字段集必须能从规范条款机械导出"），但它给出的**采集面**是三张手选的表 —— v1.4 的原话是"契约测试从 §7.3 的动作表、§8.2 GE1 的代次表与 §13.4 AE1 的摘要投影里收集列名"。这三张表里一条都没有 §4.2 的守卫与 §7.6 的 TR1–TR3，而它们**恰好是规范里唯一读 `project_action` 的两处**。于是 S8 的契约测试在它最该抓的地方是**假阴性**：它遍历得很认真，只是遍历的不是那片区域。这与 `PC-CX-27` 是同一个教训的第二次 —— **"完整"必须由一个会随修订长大的机制保证，不能由一次仔细的手选保证**。

**权威状态**：§6.1 S8 把采集面冻结成**五处、封闭**（前三处不变，加上 §4.2 的七条守卫与 §7.6 TR1–TR3 / §7.3 两个 turn 动作的前置），并加一条**反向断言**（删掉 `world` 的任意一个字段，必须至少有一条规则因此不可判定）。S9 冻结 `world.actions` 是三样东西的**最小投影**（`unsettledAcceptance`、`turns[].reasonDigest + turnState`、`turns[].reasonCode + openedAt`），逐样给出唯一读它的规则与"省掉它会怎样"；同时冻结**其余列一律不进** —— 把整本账搬进输入会让 hash 每次都不同，S3 退化成永真句。`world.coordinatorSession` 与 `evaluation.turnWindows` 一并补齐（前者是 §7.3 两个 turn 动作的前置，后者是 TR2 窗口按 S5 折出来的到期事实）。

**动作键**：不变。补的是**输入**，键仍由 `world` 里的代次唯一决定（`PC-CX-22` 已经把代次补齐）。

**恢复路径**：无需恢复。它是一条静态完备性规则 —— 漏字段在契约测试里当场红，而不是在生产上表现为"同一份输入两个决策"。

**可执行断言**：`PC-CX-30 the declared decision input carries the action history its own rules read` —— 模型侧构造上面两组反例，断言 v1.4 的投影给出同一个 hash 而必需动作不同、v1.5 的投影给出不同 hash 且各自唯一；静态侧断言 §6.1 的 `world` 含 `actions` / `coordinatorSession`、`evaluation` 含 `turnWindows`，且 S8 的采集面是五处而不是三处。**反向对照**：把 `actions` 从投影里删掉，两组反例立刻回到"同 hash、两个必需结果"。

### 23.4 `PC-CX-31` 被限频的显式请求必须是持久、确定、可见的

**最小交错序列**：`MANUAL` turn 在 `t0` 开出。`t0 + 10s`，用户再点一次"现在跑一下"，产生一条 `dedupeKey` 不同的 `user.manual_trigger`。TU4 仍选 `MANUAL`（它是全序最高的一条），TR2 拒绝在 60 秒内开第二次 turn。**然后呢** —— v1.4 没写。两种实现都能从字面读出来，而它们的差别不是风格：

| 读法 | 后果 |
|---|---|
| 消费掉这条事件（reconcile 提交时照常写 `consumed_at`） | 请求**永久消失**。用户点了，控制面上什么都不会发生，连一条"它被限频了"的记录都没有 |
| 不消费 | §10.4 的 `nextWakeAt` 列表是**封闭**的，里面没有任何一项指向 `lastTurn + 60s`。于是要么下一个 tick 立刻重新命中同一条限频（忙等，与 W3 的意图正面冲突），要么等到某件不相干的事把项目叫醒（不确定的延迟） |

**Postgres MVCC 与锁语义**：这一项与并发无关，它缺的是**持久身份与确定时刻**。要害在于窗口的锚点必须是一个**已落库、不可改写、单调**的东西，否则"这个窗口是哪一个"在重启、接管、多副本之间会得到不同答案。现成的就有一个：同一 `(generation, reasonCode)` 上最近一条 `APPLIED` 的 `OPEN_COORDINATOR_TURN` 动作行 —— 它的 `idempotency_key` 全局唯一、历史行永不删除（§8.2 GE1）、`APPLIED` 之后由 §7.7 D11 钉成不可改写，`created_at` 因此也不可改写。**窗口身份 = 那一行的键，窗口边界 = 那一行的 `created_at + 60s`**，两者都不需要任何新表、新列或内存状态。

**权威状态**：§7.6 TR2-a–TR2-e 五句：窗口身份（持久、单调）、被限频的四件确定后果（不开 turn / 不消费 / `next_attempt_at` = 边界 / `NOOP` 带 `windowEndsAt`）、消费语义（`consumed_at` **只在被回答时**写，只有两种回答）、唤醒与幂等（§10.4 第 7 条 + 双层幂等）、用户可见状态（四处）。§7.2 TF5 把 `MANUAL` 的 `turnFacts` 从"触发那一条"改成"全部未消费请求的排序摘要"，因此 N 个 pending 请求塌成**一次** turn 而不是排成 N 次。§4.3 I18 把"不丢"写成一条可以对生产快照直接查的两分支断言。§10.4 N-null 从"1–6 条"改成"1–7 条"。

**动作键**：被限频的那一次**不产生任何键**（没有 turn 就没有 `OPEN_COORDINATOR_TURN` 动作行，`NOOP` 本来就无键）。窗口过后开出的 turn 键仍是 `pc:v1:<projectId>:turn:<generation>:<reasonDigest>`，`reasonDigest` 由 TF5 的全部 pending `dedupeKey` 排序摘要算出。幂等是双层的：同一 `dedupeKey` 重复投递被 §5.4 的 partial unique index 收敛成一行（集合不变 ⇒ digest 不变 ⇒ 同一个键，I14 逐字不变）；窗口内的 N 个不同请求塌成同一次 turn。

**恢复路径**：不需要人工动作，也**不开 blocker** —— 没有任何人需要做任何事，控制环也没有停：它安排了一次确定的重试。这与 §9.4 `maxConcurrentTasks` 那一行、§9.5 Q3-a 的退避期、§9.6 CAP4 的 over-cap 是**同一种形状**（BL1 的另一条合法出口）。崩溃、接管、重启都不影响它：pending 状态是 `project_event` 的一行，窗口锚点是 `project_action` 的一行，两者都在数据库里。

**可执行断言**：`PC-CX-31 a rate-limited manual trigger is durable, deterministic and visible` —— 模型侧跑"`t0` 开 turn → `t0+10s` 第二个请求 → 断言不消费、`next_attempt_at = t0+60s`、`nextWakeAt <= t0+60s` → 时钟走到 `t0+60s` → 断言恰好一次 turn、两个 `dedupeKey` 一起被消费、turn 键唯一"，并断言 v1.4 的两种读法各自复现"请求丢失"与"忙等"；真实 Postgres 侧由 `coordinator-linearization.pg.spec.ts` 的 `PC-CX-31 on real Postgres: a rate-limited manual trigger survives, and fires once` 用真实的 partial unique index + 事件行跑重复投递、崩溃后重读与窗口到期。**反向对照**：把第 7 条从 `nextWakeAt` 列表里去掉，`nextWakeAt` 立刻回到 `NULL` 或一个与窗口无关的时刻；把 `consumed_at` 照旧写上，第二个请求在窗口过后**不再存在** —— 与复审报告 §6 `PC-CX-31` 的两种读法逐字对应。

### 23.5 本次修订**没有**做的事

同 §19.9 / §20.7 / §21.7 / §22.9，边界要写清楚：

- **本次修订仍不含实现**。03–23 单元一行业务代码都还没写；`project_action.execution_context` / `execution_context_digest` / `reason_code` 三列、`resolve_execution_context_locked`、D14 的约束触发器、`evaluation.turnWindows` 的折算、`project_event.next_attempt_at` 在限频路径上的用法目前都是**契约条款**，不是数据库里的对象或代码里的函数。真实 PostgreSQL 测试建的是**测试用的表**，它们证明的是"这些 SQL 语义成立"，不是"迁移已经写好了"，后者归 03 / 04 单元（§12.1 G5 已列出必须显式验证的十四样东西）。
- **五份审查文档一字未改**（任务的硬约束）。它们记录的是 v1、v1.1、v1.2、v1.3 与 v1.4 的事实；v1.5 的回应写在本节。
- **02 在 v1.4 轮留下的 `coordinator-v14-adversarial.spec.ts` 被翻转，不是被删**。理由与 §22.9 对 v1.3 那份 spec 的说明逐字相同：一条"缺陷存在"的断言在缺陷被修好的那一刻必然变红。翻转后每条断言**同时保留 v1.4 的形状作为反向对照**。
- **两处行为变更，不是措辞澄清**：§4.3 I16 从"任何顺序下占位数 ≤ cap"改成"准入时 `count < max`"（因此 over-cap 是一个被承认的、有界的状态，而不是一次违约）；§7.2 `MANUAL` 的 `turnFacts` 从单个 `dedupeKey` 改成全部 pending 请求的集合（因此窗口内的 N 个请求塌成一次 turn，而不是排成 N 次）。两处都登记进了 §22.8 的残句账。
- **cap 仍然没有做成数据库约束**，理由逐字沿用 CAP1-b；v1.5 只是把它要保证的那句话改成了一句**在准入点可判定**的话，因此 CAP1-b 的论证不但不受影响，反而更容易成立 —— 准入判定本来就发生在两个入口都持有的那把行锁之后。
- **没有给 PAC 的解析链发明第二套语义**。D14 在数据库里重写的是**同一条链**，`resolve_execution_context_locked` 与服务层 `resolveExecutionContext` 必须对同一份 fixture 产出同一个 digest（04 / 13 单元的断言），两者漂移的方向是 fail closed。**这是本文对 PAC 唯一的一次重复实现**，代价与将来的退路写在 D14-c。
- **`execution_context` 的可读那一份不进 `decisionInput`**。它落在 `project_action` 行上供审计与拒绝时对照，不进 `world`（S4：输入是决策输入，不是导出）；进输入的是它读的那些**行的当前值**，那些行 §6.1 早已携带（`team[]` / `tasks[]` / `providers[]` / `workspaces[]` / `project.coordinatorWorkspaceId`）。
- **限频窗口仍然是 60 秒、仍然按 `reasonCode` 分桶**。v1.5 只冻结了"被拒之后会发生什么"，没有改限频本身；`S7` 的触发集合也仍然只有 `user.manual_trigger` 一个成员，第 7 条按 `reasonCode` 写是为了在那张表长出第二行时自动适用。

---

## 24. `PC-CX-32..36` 修订闭环（v1.6）

> **本节是非规范的（non-normative）修订日志**（§0 RL1，v1.4 冻结、v1.6 扩到本节）。它记录 v1.6 当时的事实与当时的推理，**不是现行规范**；任何一句与 §1–§18 冲突时一律以 §1–§18 为准。历史形状只允许出现在这里和反例测试里（`PC-CX-27`）。

02 对 v1.5 的独立复审（[`project-coordinator-contract-review-02-v1.5.md`](./project-coordinator-contract-review-02-v1.5.md)）判 **FAIL / BLOCKED**，给出 1 个 P0 与 4 个 P1。本节是**逐项关闭的索引**，格式与 §19 / §20 / §21 / §22 / §23 相同。**六份审查文档都不因本次修订而改动** —— 它们记录的是 v1、v1.1、v1.2、v1.3、v1.4 与 v1.5 的事实，那些事实没有变；变的是契约。

五项里有三条贯穿的线，而且三条都是**上一轮学到的教训没被推到底**。

第一条是**时态**，第三次。v1.4 用 `PC-CX-21` 拆了 I11，v1.5 用 `PC-CX-28` 拆了 I16，而**同一轮里新写的 I17 又是一条当前状态不变量** —— "不存在一条指向已禁用 Agent 的 live Session"要求这句话在每一个已提交状态上成立，而人有权在一次合法派发之后撤权，PAC §6 又逐字要求撤权不动在飞 Session。教训学会了两次，仍然没有回头看这一轮自己新增的那条（`PC-CX-34`）。

第二条是**封闭列表的采集面**。v1.5 用 `PC-CX-30` 把 `decisionInput` 的采集面从"三张手选的表"扩到"五处读集"，但那五处**全是本文自己的判定**；§7.4 第 8 条读的是 PAC 的解析链，它一列都没被反推进来（`PC-CX-33`）。同一形状的第三次：`PC-CX-27` 是正文里的残句、`PC-CX-30` 是本文自己的读集、`PC-CX-33` 是**跨文档**的读集。

第三条是**"写下来的 SQL 没有被真的跑过"**。D14 的规范对象在 PostgreSQL 16 上**每一次调用都失败**（`STABLE` 函数不允许取行锁），而研发的 PG fixture 因为没写 volatility 而默认 `VOLATILE`，于是它跑的是另一个对象、全绿是假阴性（`PC-CX-32`，P0）。这与 `PC-CX-29` 那条"可延迟触发器在 `COMMIT` 才取锁"的发现是同一种来源：**只有真的建出来、真的调用，才知道规范说的那个对象存不存在。**

另外两项是同一形状的其它实例：TR2-d/W3/I18 三句话在窗口最后 5 秒里无解，而"取所有 wake 的最小值"与 TR2-e 的"精确指向窗口边界"在有更早候选时互相矛盾（`PC-CX-35`）；I18 声称覆盖"任何已提交状态"，却漏掉了**事件已提交、reconcile 还没跑**这段正常的异步间隙（`PC-CX-36`）。

v1.6 的答案在五处：**一个能在 PostgreSQL 上真的执行、且只能靠 `pg_proc.provolatile` 观测的 D14**（D14-a / D14-f）、**一份从 PAC 解析链反推出来的输入投影**（S8 六处 + S10 的满射表）、**一对时态明确的执行上下文不变量**（I17-A 恒成立 / I17-B 点态，配 I17-c 承认那个有界残留）、**一个候选表加一个确定选择的 wake 代数**（W5，floor 胜过 deadline）、以及**三种形状的 I18 加一条待消费事件的投递不变量**（I18-A/B/C + I19 + W4 第 (iv) 支）。

| ID | 级别 | 规范条款 | 权威状态 | 动作键 | 恢复路径 | 可执行断言 |
|---|---|---|---|---|---|---|
| `PC-CX-32` | **P0** | §7.7 D14-a · D14-f · §12.1 6e · G5 · §14 AC9 · §18 | `resolve_execution_context_locked` 与 `session_execution_context_guard` 都是 `VOLATILE`，因此 D14 在 PostgreSQL 16 上真的可以被 `COMMIT` 调用；`pg_proc.provolatile = 'v'` 是这条规范唯一的可观测形式 | 不变（volatility 不进任何键） | 无需恢复：漏写 `VOLATILE` 的迁移在 04 单元当场红（provolatile + 真实 trigger 调用两条断言），而不是在生产上表现为"所有派发失败" | `PC-CX-32 the locking resolver is VOLATILE, and the volatility is the assertion` |
| `PC-CX-33` | P1 | §6.1 S8 · S10 · `world.team[]` · `workspaces[]` · `tasks[]` · `providers[]` · §7.4 EC1 · §14 AC5 | `decisionInput.world` 携带 PAC 解析链**实际读到的每一列**（Agent 默认 provider/model/effort、`providerFallbacks`、`requiredCapabilities`、`projectMemberId`、`workspace.enabled`、`task.workspaceId`、provider 的 model 空间）；同一 hash 不可能要求两个执行上下文 | 不变；键仍由 `world` 里的代次唯一决定 | 无需恢复：漏字段由 S10-c 的删除 mutation 在契约测试里当场红 | `PC-CX-33 the declared decision input carries the PAC resolver read set` |
| `PC-CX-34` | P1 | §4.3 I17-A · I17-B · I17-c · §7.7 D14-b · §12.1 G5 · §15 F35 · §22.8 | I17-A：占位的冻结快照列 = 动作行上的 `execution_context`（两者提交后都不可改写，恒成立）；I17-B：提交那一刻重解析 = 冻结摘要（点态，D14 证明）。"当前是否指向已禁用 Agent"**不是**不变量 | 不变；被撤销的动作仍记 `REFUSED` / `EXECUTION_CONTEXT_REVOKED` | 撤权后**不做任何事**：在飞的跑完就没了（有界、可见、自排空），新的派发一条也提交不了 | `PC-CX-34 I17 is stated with a tense, and the current-state query is not one of them` |
| `PC-CX-35` | P1 | §10.4 W3 · W5 · §7.6 TR2-d · TR2-e · §4.3 I18-C · §15 F38 | `nextWakeAt = max(min(候选), now + 5s)`，并列按 §10.4 1–7 的序号裁决，`nextWakeReason` 取胜出候选，整张候选表落 `project_decision.detail.wakeCandidates` | 不变（wake 不是动作键） | 无需恢复：被 floor 推迟最多 5 秒，到点时该候选的到期事实必然已为真 | `PC-CX-35 the wake is one candidate table and one deterministic choice` |
| `PC-CX-36` | P1 | §4.3 I18-A · I18-B · I18-C · I18-note · I19 · §10.2 W4 (iv) · W4-a · §10.4 N-null · §15 F37 | 一条未消费的 `user.manual_trigger` 恰好三种形状；一条未消费事件要么其 Project 满足 §10.3 之一，要么落在 W4 的命中集合里（I19） | 不变（事件的身份仍是 `dedupeKey`，§5.4） | 三条独立的投递路（消费者 / 任何一次 reconcile 读未消费集合 / W4 第 (iv) 支的 WARN），三条都断才丢 | `PC-CX-36 a committed event that reconcile has not seen yet has a shape and an owner` |

新增的模型断言在 [`coordinator-counterexample.spec.ts`](../src/apiserver/src/projects/coordinator-counterexample.spec.ts)，新增的真实 PostgreSQL 断言在 [`coordinator-linearization.pg.spec.ts`](../src/apiserver/src/projects/coordinator-linearization.pg.spec.ts)；02 在 v1.5 轮次留下的 [`coordinator-v15-adversarial.spec.ts`](../src/apiserver/src/projects/coordinator-v15-adversarial.spec.ts) 按 §23.5 对 v1.4 那份 spec 的同一条纪律**从"证明缺陷存在"翻转成"旧形状被拒绝/得到唯一合法结果"**，并把 v1.5 的失败形状原样保留为每条断言里的**反向对照**。

### 24.1 `PC-CX-32` 取锁的函数不能承诺自己不写

**最小交错序列**（这一项不需要两个事务，一条语句就够）：按 D14-a 的字面建出 `resolve_execution_context_locked` —— `STABLE`，函数体里每一句都是 `SELECT … FOR SHARE`。`CREATE FUNCTION` **成功**。任何一次调用（包括 D14 的约束触发器在 `COMMIT` 阶段的那一次）返回 `ERROR: SELECT FOR SHARE is not allowed in a non-volatile function`，`SQLSTATE 0A000`。因为它发生在 `COMMIT`，整个事务 abort：动作行、Session、决策、事件消费与 wake 一个都提交不了，事件保持未消费并被反复重投，而 `0A000` 不在 EC4 那张封闭的拒绝码表里 —— 它连一条结构化拒绝都不是。

**Postgres MVCC 与锁语义**：PostgreSQL 的 volatility 分类是一份**承诺**：`IMMUTABLE`/`STABLE` 的函数承诺自己不改变数据库状态，规划器据此允许在一个语句内复用它的结果。**取行锁是一次写**（它写 tuple 的 `xmax` 与 multixact），因此服务器直接拒绝在非 volatile 的函数里执行 `FOR SHARE`/`FOR UPDATE`。这不是一个可以靠权限或配置绕开的限制，也没有"只锁一行就不算写"的例外。

**为什么研发的绿色套件没抓到**：v1.5 的 `EC_SCHEMA_V15` 建 `resolve_execution_context_locked` 时**没写 volatility**，PostgreSQL 默认它为 `VOLATILE`。于是那份 fixture 测的是"一个 volatile 的锁函数能不能挡住撤权"（能），而规范说的是另一个对象。**函数体逐字相同**，`pg_get_functiondef` 上 grep `FOR SHARE` 两者都过，`pg_trigger` 里也看不出差别 —— 唯一的差别是 `pg_proc.provolatile` 的那一个字符。这与 `PC-CX-25` / v1.2 那两条"两个词的差别看不见"是同一种教训的第三次，只是这次差别在**元数据**而不在函数体里。

**权威状态**：§7.7 D14-a（`VOLATILE` 的 plpgsql 函数）+ D14-f（为什么不是 `STABLE`、拆分方案 B 为什么不选、以及四条判据：两个函数各断言 `provolatile = 'v'`、必须调用真实 deferred trigger、必须保留 `STABLE` ⇒ `0A000` 的反向对照）。§12.1 步骤 6e 与 G5 跟着改：G5 的 v1.6 三条把"函数存不存在"升级成"函数能不能被调用"。

**动作键**：不变。volatility 是一个数据库对象属性，不进任何幂等键、不进任何摘要。

**恢复路径**：不需要人工动作 —— 这是一条**在迁移验证里被抓住**的缺陷，而不是一条运行时故障。如果它真的进了生产，症状是"所有 COORDINATOR 派发在 `COMMIT` 失败、事件反复重投"，恢复是重建函数（`CREATE OR REPLACE … VOLATILE`），未消费的事件随后被正常消费（§5.1 E1：事件不携带事实，重放安全）。

**可执行断言**：`PC-CX-32 the locking resolver is VOLATILE, and the volatility is the assertion` —— 模型侧断言契约正文与迁移步骤都写了 `VOLATILE`、G5 要求 `provolatile`、且残句账登记了 `STABLE` 那句；真实 Postgres 侧由 `coordinator-linearization.pg.spec.ts` 的 `PC-CX-32 on real Postgres: the D14 objects are VOLATILE, and the deferred trigger really runs` 建**真实形状**的 D14（两个函数 + 可延迟约束触发器），断言两个 `pg_proc.provolatile = 'v'`、断言 `pg_trigger.tgdeferrable AND tginitdeferred`，然后**真的插入并 `COMMIT`** 一条 COORDINATOR 占位（正例过、撤权后得到 `EXECUTION_CONTEXT_REVOKED`）。**反向对照**：把同一个函数体重建成 `STABLE`，`pg_proc.provolatile` 变成 `'s'`，同一次调用得到 `0A000` 与复审报告 §6 逐字相同的那条消息。

### 24.2 `PC-CX-33` 声明的输入要含它派发时真正读的那条链

**最小交错序列**（与 `PC-CX-30` 同型：不在时间上，而在两份**同时存在**的数据库状态之间）：

- **A（WITH 链）**：两份状态的 `world` / `evaluation` / `signals` 逐字相同，Task 没有 provider/model pin，隐藏的 `agent.default_provider` 一份是 `claude`、一份是 `codex`。PAC §7.2 优先级 2 要求两个不同的 provider 与 model，EC2 因此要求两个不同的 `executionContextDigest`，而 `decisionInputHash` 相同 —— S3 为假。
- **B（WHERE 链）**：两份状态只差 `workspace.enabled`。PAC §7.3 的候选集谓词逐字含 `workspace.enabled = true`，因此一份 DISPATCH、一份 `REFUSE NO_PROJECT_WORKSPACE`。
- **C（摘要分量）**：EC2 的第二个分量是 `projectMemberId`，而 `world.team[]` 里没有这一列。

**Postgres MVCC 与锁语义**：与数据库无关 —— 两份状态都是已提交的、各自内部一致的快照，缺的是**声明的投影不足以区分它们**。这一行与 §23.3 逐字同型，写下来是因为格式要求逐项回答同样的六个问题，而"这一项不涉及并发"本身就是一个要被明确说出来的答案。

**为什么 v1.5 的 S8 测不出来**：S8 的采集面是五处，**五处全是本文自己的判定条款**（§7.3 的键模板、§8.2 的代次、§13.4 的摘要投影、§4.2 的守卫、§7.6 的 TR1–TR3）。§7.4 第 8 条只写了"复用 PAC 的解析链"，而 PAC 的读集从来没有被反推进 `world` —— 于是"完整读集"这条断言在**跨文档**的那一片区域是假阴性。`PC-CX-27`（正文残句）、`PC-CX-30`（本文读集）、`PC-CX-33`（跨文档读集）是同一个教训的三次：**"完整"必须由一个会随修订长大的机制保证。**

**权威状态**：§6.1 S8 把采集面从五处扩到**六处**（第六处是 §7.4 第 8 条的 PAC 解析链），S10 给出 EC1 八行 ⇒ `world` 字段的**满射表**与四条细则（`projectMemberId` 为什么必须在、`providers[].models` 是空间不是一次解析、删字段必须红、`session.resolution` 仍然不进）。`world.team[]` 增加 `projectMemberId` / `defaultProvider` / `defaultModel` / `defaultEffort` / `providerFallbacks` / `requiredCapabilities`，`workspaces[]` 增加 `enabled`，`tasks[]` 增加 `workspaceId`，`providers[]` 增加 `models`。§7.4 EC1 加一句把两处绑在一起。

**动作键**：不变。补的是**输入**；键仍由 `world` 里的代次唯一决定。

**恢复路径**：无需恢复。它是一条静态完备性规则 —— 漏字段在契约测试里当场红，而不是在生产上表现为"同一份输入两个执行上下文"。

**可执行断言**：`PC-CX-33 the declared decision input carries the PAC resolver read set` —— 模型侧构造上面三组反例，断言 v1.5 的投影给出同一个 hash 而必需的执行上下文不同、v1.6 的投影给出不同 hash 且各自唯一，并对 S10 表里**每一个**字段做删除 mutation（删掉它，必须能造出一对同 hash、不同必需结果的状态）；静态侧断言 §6.1 的 `world` 含这些字段、S8 写的是六处、S10 的表覆盖 EC1 全部八行。**反向对照**：把 S10 引入的字段整组删掉，A/B/C 三组反例立刻回到"同 hash、两个必需结果"。

### 24.3 `PC-CX-34` I17 也要有时态

**最小交错序列**：Agent `enabled = true`。控制环按 §7.4 EC3 取共享锁、重解析、插入并提交一条 live Session（AU1-a 第二行、F35 第二支**明确允许**）。人随后取得同一批行的锁，提交 `UPDATE agent SET enabled = false`（CAP0-b 同型：这是用户对自己配置的修改，永远不被拒绝），PAC §6 又逐字要求它**不影响在飞 Session**。已提交状态：`enabled = false`、一条指向它的 live Session、I17 的"等价可查询形式"返回 1 行。真实 PostgreSQL 上跑出来的三列是 `false | 1 | 1`（enabled | live 数 | 当前态违规数）。**没有任何一个参与者做错事**，冲突的是契约自己的两句话。

**Postgres MVCC 与锁语义**：这一项**不需要**新 primitive。EC3 的 `FOR SHARE` 与撤权的 `FOR NO KEY UPDATE` 已经把两次写**排了序**，而一把锁能保证的只是顺序：**它不能让一个后来的合法写入去否定一个更早的、当时合法的事实**（`PC-CX-28` 的那句话逐字适用）。唯一能让当前态立刻满足那个查询的动作是**杀掉在飞 Session** —— §9.3 第 4 条那一类永不代劳的破坏性动作，PAC §6 也逐字禁止。

**为什么选"删掉当前态那一句"而不是"让它恒真"**：审查给了两条路。要让当前态恒真，就得为 EC1 的八个 mutator 各定义一次"与 live Session 的线性化"：撤权时要么被拒（违反 CAP0-b 同型的产品结论与 PAC §6）、要么连带终止在飞 Session（§9.3 第 4 条禁止）、要么给快照豁免（那就等于承认它是点态的）。三条路里前两条是行为倒退，第三条就是本项修订本身。

**权威状态**：§4.3 I17-A（恒成立：占位的冻结快照列 = 动作行上的 `execution_context`，两者提交后都不可改写 —— PAC §6 与 §7.7 D11）、I17-B（点态：提交那一刻重解析 = 冻结摘要，由 D14 在 `COMMIT` 证明，对任何二进制成立）、I17-c（那条被删掉的当前态查询是什么：一个合法的、有界可见自排空的残留，不开 blocker、不清理、可从 `world.team[].enabled` 与 `sessions[]` 观测）。§7.7 D14-b 按时态改述，§12.1 G5 的第三项从"跑 I17 的可查询形式"换成"跑 I17-A"，§15 F35 补上第二支的后半句，§22.8 登记两行。

**动作键**：不变。

**恢复路径**：**不做任何事**。在飞的那条跑完，残留自然消失；撤权之后**没有任何新的**占位能被提交（I17-B + D14 + EC3 三道门）。需要人做事的那一支是 EC5 的表（撤权发生在提交之前 ⇒ 对应 blocker），与本项无关。

**可执行断言**：`PC-CX-34 I17 is stated with a tense, and the current-state query is not one of them` —— 模型侧对 EC1 的八个撤权 × 两个提交顺序枚举十六格，断言 **I17-A 十六格全为真**、I17-B 在 `COORDINATOR_FIRST` 的提交瞬间为真、而 v1.5 的当前态查询在 `COORDINATOR_FIRST` 八格里**合法地**非零；真实 Postgres 侧由 `coordinator-linearization.pg.spec.ts` 的 `PC-CX-34 on real Postgres: I17-A holds on the committed state while the v1.5 current-state query legitimately does not` 用真实的 D14 与真实的快照列跑同样的十六格。**反向对照**：把 I17-A 换回 v1.5 的当前态形式，`COORDINATOR_FIRST` 的八格立刻红 —— 与复审报告 §6 `PC-CX-34` 的 `false|1|1` 逐字对应。

### 24.4 `PC-CX-35` 一个候选表、一个确定的选择

**最小交错序列**：锚点 `t0 = 0`，窗口边界 `60s`，第二个 `user.manual_trigger` 在 `58s` 被限频。TR2-b 要 `nextAttemptAt = 60s`；TR2-d/I18 要 `nextWakeAt ≤ 60s`；W3 要 `nextWakeAt ≥ 63s`。**闭区间 [63s, 60s] 是空的** —— 不存在合法 timestamp，任何实现都必须违反其中一条。第二个反例不需要边界：另一个 Task 的 `runAt = 59s` 时，§10.4 "取所有适用项的最小值"要 59s，TR2-e 又逐字要求 `next_wake_at` 指向 60s 且 `next_wake_reason = 'manual trigger rate-limited'`。

**Postgres MVCC 与锁语义**：与并发无关，这一项是**时间代数**。写下这一行的意义与 §23.3 相同：拿锁去修一个算术上无解的约束集，只会得到一个更慢的、同样无解的实现。

**为什么 floor 胜过 deadline**：两者的代价不对称。让 deadline 胜出（允许 `nextWakeAt < now + 5s`）意味着**每一个**窗口末端都变成一次自旋 —— W3 存在的全部理由就是它，而 `PC-CX-31` 的"读法 B"已经量化过后果（一个窗口里 12 次 reconcile）。让 floor 胜出的全部代价是**最多晚 5 秒**：`chosen.at` 只有在已经不足 5 秒到期时才会被推，而到点时那条候选的到期事实（§6.1 S5 的布尔）**必然**已经为真，因此不会落空，`L` 的 p95/p99/硬上限逐字不受影响。

**权威状态**：§10.4 W5 的五条（候选表带 `source` 序号、最小值 + 并列按序号、`max(chosen, now+5s)` 且 reason 取 `chosen`、整张候选表落 `project_decision.detail.wakeCandidates` 并记 `flooredBy`、到点必然已到期）。§7.6 TR2-d 从"必然 `≤ windowEndsAt`"改成 `≤ windowEndsAt + 5s`；TR2-e 的 reason 要求加上"当它是胜出候选时"这个前提，并把可见性挪到 `wakeCandidates` 上；§4.3 I18-C 的上界同步改成 `next_attempt_at + 5s`；§15 F38 新增。

**动作键**：不变 —— `nextWakeAt` 不是一个动作，它是 outcome 的一个字段（§6.2）。

**恢复路径**：不需要人工动作，也不开 blocker（TR2-e 那句"不开 blocker"逐字不变）。

**可执行断言**：`PC-CX-35 the wake is one candidate table and one deterministic choice` —— 模型侧对 `remaining ∈ {0,1,2,4,5,6,59}s` 逐个断言 W3 / I18-C / TR2-b 三者同时成立，并把第 7 条与第 1–6 条两两组合（含同一时刻并列）断言 `(nextWakeAt, nextWakeReason)` 与遍历顺序无关；真实 Postgres 侧由 `coordinator-linearization.pg.spec.ts` 的 `PC-CX-35 on real Postgres: the window boundary and the floor are one deterministic timestamp` 用真实的 `project_event` / `project_action` 行与 `now()` 算出同一对值。**反向对照**：把 W5 第 3 条换回 v1.5 的"`nextWakeAt ≤ windowEndsAt`"，`remaining ≤ 5s` 的每一格立刻无解；把并列裁决去掉，`runAt = 59s` 那一格得到两个都"合法"的答案。

### 24.5 `PC-CX-36` 已提交但还没被看过的事件也有形状

**最小交错序列**：用户接口在业务事务里插入 `project_event(kind = 'user.manual_trigger', consumed_at = NULL, next_attempt_at = NULL, attempts = 0)` 并提交（§5.3 N4 要求它与业务写同一事务）。消费者是异步的（§5.4：1s 轮询 + `NOTIFY`），`project_runtime.next_wake_at` 此刻可以合法为 `NULL`（例如全部 open blocker 都是 `recovery = HUMAN` 且已升级，N-null 允许）。这个状态**两种 I18 形状都不属于**：`consumed_at` 是 `NULL`，`next_attempt_at` 也是 `NULL`。它是主路径上每一条显式请求的**第一个**状态。

**Postgres MVCC 与锁语义**：这一项的选择恰恰是**不加锁**。选项 A（生产者在同一事务里前移 `project_runtime.next_wake_at`）会让一个项目里的每一次业务写都去写同一行 —— §5.3 N3 的批量合并与 §5.4 的 partial unique index 都是为了不让事件量放大成写放大，而它换到的只是"少一种形状"。选项 B 承认这段间隙，并给它一条**可查询**的投递责任。分界与 §5.1 E1 逐字同源：事件是信号不是事实，因此"它什么时候被看见"是一条**活性**约束（有 backstop 兜底），不是一条要靠锁维持的**安全**约束。

**为什么 v1.5 的 I18 会写成那样**：因为它是从 `PC-CX-31` 的**第二次**状态出发写的 —— 那条修订关心的是"被限频之后去哪了"，而被限频的前提是这条事件**已经被一次 reconcile 看过**。第一次状态（还没被看过）因此从没进过视野。这与 `PC-CX-05` 的教训同型：一条不变量必须对**正常主路径的每一步**成立，而不只是对它被写出来时脑子里的那一步。

**权威状态**：§4.3 I18-A / I18-B / I18-C 三种形状（封闭，且明确写出"第四种是缺陷"：`consumed_at IS NULL ∧ next_attempt_at IS NULL ∧ attempts > 0`）、I18-note 的两选项表、I19（待消费事件的投递不变量：要么其 Project 满足 §10.3 之一，要么落在 W4 的命中集合里）。§10.2 W4 新增第 (iv) 支（`COALESCE(next_attempt_at, occurred_at) < now() - 5min`）与 W4-a（为什么谓词是"迟到太久"而不是"不存在"）。§10.4 N-null 补一段时态：它判的是**一次 reconcile 提交时**的 `nextWakeAt`，不是任何已提交状态。§15 F37 新增。

**动作键**：不变。事件的身份仍是 `dedupeKey`（§5.4 的 partial unique index），本项不新增任何键。

**恢复路径**：三条互相独立的投递路 —— ①§5.4 的消费者；②任何一次因别的原因发生的 reconcile（`signals` 取的是**当前未消费的全部**，不是队列递过来的那一条）；③W4 第 (iv) 支的 backstop（命中记 WARN，W2 逐字不变）。三条都断才会丢，而第三条会把"丢"变成一条可查询的谓词与一次告警。

**可执行断言**：`PC-CX-36 a committed event that reconcile has not seen yet has a shape and an owner` —— 模型侧断言刚提交的事件落在 I18-B、被限频后落在 I18-C、被回答后落在 I18-A，且第四种形状被判缺陷；再断言"消费者死掉 + `next_wake_at IS NULL` + 全部 blocker 已升级"这一格**必然**被 W4 第 (iv) 支命中；真实 Postgres 侧由 `coordinator-linearization.pg.spec.ts` 的 `PC-CX-36 on real Postgres: the backstop sees an event no consumer took` 用真实的 W4 谓词与真实的 `project_event` 行跑三种形状 × 命中/不命中。**反向对照**：去掉第 (iv) 支，同一格四支全不命中 —— 事件躺在队列里，没有任何一个定时器指向它，与复审报告 §6 `PC-CX-36` 的那一行逐字对应。

### 24.6 本次修订**没有**做的事

同 §19.9 / §20.7 / §21.7 / §22.9 / §23.5，边界要写清楚：

- **本次修订仍不含实现**。03–23 单元一行业务代码都还没写；`resolve_execution_context_locked` 的 volatility、S10 补进 `world` 的那些字段、W5 的候选表与 `wakeCandidates`、W4 的第 (iv) 支目前都是**契约条款**，不是数据库里的对象或代码里的函数。真实 PostgreSQL 测试建的是**测试用的表**，它们证明的是"这些 SQL 语义成立"，不是"迁移已经写好了"，后者归 03 / 04 单元（§12.1 G5 已列出必须显式验证的十七样东西）。
- **六份审查文档一字未改**（任务的硬约束）。它们记录的是 v1 到 v1.5 的事实；v1.6 的回应写在本节。
- **02 在 v1.5 轮留下的 `coordinator-v15-adversarial.spec.ts` 被翻转，不是被删**。理由与 §22.9 / §23.5 逐字相同：一条"缺陷存在"的断言在缺陷被修好的那一刻必然变红。翻转后每条断言**同时保留 v1.5 的形状作为反向对照**。
- **五处行为变更，不是措辞澄清**：D14 的解析函数 volatility（`STABLE` ⇒ `VOLATILE`，前者根本跑不起来）；`world` 增加九个字段（S10）；I17 从一条当前态不变量变成 I17-A + I17-B（因此"live Session 指向已禁用 Agent"从违约变成一个被承认的有界残留）；`nextWakeAt` 的上界从 `windowEndsAt` 放宽到 `windowEndsAt + 5s`（W3 成为硬下限）；I18 从两种形状变成三种。五处都登记进了 §22.8 的残句账（第三处两行、第四处两行，其余各一行）。
- **限频窗口仍然是 60 秒、仍然按 `reasonCode` 分桶**，`S7` 的触发集合仍然只有 `user.manual_trigger` 一个成员。v1.6 只冻结了"多个 wake 同时适用时选哪一个"，没有改限频本身。
- **没有给事件生产者加锁**，理由写在 I18-note 的两行表里；如果将来 `L` 的 p99 因为消费者路径变得不可靠而失守，退路是把 W4 第 (iv) 支的阈值调小，而不是回到选项 A。
- **`decisionInput` 仍然不含 `session.resolution`**（S10-d），也仍然不含 `project_action` 的其余列（S9 逐字不变）。


---

## 25. `PC-CX-37..42` 修订闭环（v1.7）

> **本节是非规范的（non-normative）修订日志**（§0 RL1，v1.4 冻结、v1.7 扩到本节）。它记录 v1.7 当时的事实与当时的推理，**不是现行规范**；任何一句与 §1–§18 冲突时一律以 §1–§18 为准。历史形状只允许出现在这里和反例测试里（`PC-CX-27`）。

02 对 v1.6 的独立复审（[`project-coordinator-contract-review-02-v1.6.md`](./project-coordinator-contract-review-02-v1.6.md)）判 **FAIL / BLOCKED**，给出 1 个 P0 与 5 个 P1。本节是**逐项关闭的索引**，格式与 §19 / §20 / §21 / §22 / §23 / §24 相同。**七份审查文档都不因本次修订而改动** —— 它们记录的是 v1 到 v1.6 的事实，那些事实没有变；变的是契约。

六项里有两条贯穿的线，而且两条都是**已经学过的教训，在这一轮换了个位置又犯了一次**。

第一条是**封闭集合的采集面**，第四次。`PC-CX-27` 是正文里的残句、`PC-CX-30` 是本文自己的读集、`PC-CX-33` 是跨文档的读集，而 `PC-CX-37` 是**一张 SQL denylist 与它保护的那张表**：v1.4 逐列枚举了六列，v1.5 给同一张表加了三列，没有人回头改那个函数。三次修订都写下了"封闭集合必须能被证明是封闭的"，而这一次的封闭集合是**由构造**就能封闭的（比整行、放过两列），只是没有人把它写成那个形状。

第二条是**跨文档的引用没有逐字段核对**，第二次。`PC-CX-33` 是"PAC 的解析链读了哪些列"没被反推进来；`PC-CX-38` 是"PAC §6 的冻结时刻"没被逐行读 —— I17-A 照抄了那张表的**表头**，却把 `model` / `effort` 两行写着的"首次 claim"当成了"Session create"。于是这条恒成立命题在**正常生命周期的第一个已提交状态上**就为假。这两次的教训是同一句话：**引用另一份契约时，要引用它的行，不是它的标题。**

另外四项各有各的形状：一条排序规则只排到第二个键就停了（`PC-CX-39`）；最后一个游离的时钟藏在一条"它不参与决策"的豁免里，而它参与（`PC-CX-40`）；一条不变量的量化域比它的责任域大（`PC-CX-41`）；一个摘要被同时用来回答两个问题，因此在其中一个问题上必然是错的（`PC-CX-42`）。

v1.7 的答案在六处：**一个由构造封闭的 D11**（allowlist + schema 驱动的 mutation）、**一对按 PAC 冻结时刻分开的不变量**（I17-A 只管 create 冻结列，I17-A2 用 `execution_pin_generation` 管三个阶段，配 D15 的 mutator 协议）、**一个真正的全序**（W5 的 `(at, source, subjectType, subjectId)`）、**一个在 hash 里的时钟**（W5 / W3 / S5 一律读 `evaluation.epoch`）、**一条三支封闭的 I19 加一节出环事件的终态处置**（§5.5 EV1–EV6）、以及**两个各回答一个问题的摘要**（EC2-a 授权 / EC2-b 结果，EC3 各比各的，EC6 让写进 Session 的那份就是被冻结的那份）。

| ID | 级别 | 规范条款 | 权威状态 | 动作键 | 恢复路径 | 可执行断言 |
|---|---|---|---|---|---|---|
| `PC-CX-37` | **P0** | §7.7 D11 · D11-b · D11-c · D11-d · D11-e · §12.1 步骤 6f · G5 · §14 AC9 · §15 F39 · §22.8 | `APPLIED` 动作行上**除 `result_session_id` / `detail` 外的每一列**都不可改写，由 `to_jsonb(NEW/OLD) - writable` 整行比较保证，因此**将来加的列默认冻结**；I17-A 的两份摘要与 TR2-a 的窗口锚点第一次真的被钉住 | 不变（可写集不进任何键或摘要） | 无需恢复：改写在数据库层就被 `ACTION_APPLIED_IMMUTABLE` 拒绝，错误消息带被改的列名；要补写只剩两列 | `PC-CX-37 the applied action row is frozen by an allowlist, not by a list someone must remember to grow` |
| `PC-CX-38` | P1 | §4.3 I17-A · I17-A2 · I17-d · §7.7 D15 · §7.4 EC6-c · §2.4 · §12.1 步骤 2 · 6f · G5 · §15 F40 · §22.8 | I17-A 只比较 PAC §6 的 **create 冻结列**；`model` / `effort` 由 I17-A2 按 `session.execution_pin_generation` 的三个阶段各给一句恒成立的话，两个方向都可查 | 不变（代次落在 Session 上，不进动作键） | 无需恢复：首次 claim 与 `retiredPin` 都是 PAC §6 允许的合法动作，它们只是必须把代次 +1 并留下记录 | `PC-CX-38 the frozen snapshot is compared per PAC freeze point, with a phase and a generation` |
| `PC-CX-39` | P1 | §10.4 W5 第 1 条候选身份表 · 第 2 条 · W5-2a · W5-2b · §15 F38 · §22.8 | 候选是 `(at, source, subjectType, subjectId)`，字典序全序（`subjectId` 按字节序，不按数据库 collation）；一个 `(source, subject)` 一次求值至多产出一条候选，因此 `chosen` 唯一 | 不变（wake 不是动作键） | 无需恢复：`nextWakeReason` 与 `wakeCandidates` 此后与枚举顺序无关 | `PC-CX-39 two candidates from one source are decided by a persistent total order` |
| `PC-CX-40` | P1 | §10.4 W5 第 3 · 6 · 7 条 · W3 · §10.4 第 5/6 条 · §6.1 S5 · §7.6 TR2-d · §4.3 I18-C · §8.6 LO4 · §7.7 D5 表 · §22.8 | `nextWakeAt = max(min(候选), evaluation.epoch + 5s)`，候选里没有第二个时钟；仅有的两处不由 W5 产出的 `next_wake_at` 写入（取不到租约、R2 超时）都不产生决策行，因此不在 S3 的量化域里 | 不变 | 无需恢复：floor 从 `epoch` 起算最多让一次唤醒早到这次 reconcile 的墙钟那么多，且不会退化成自旋（W5 第 6 条） | `PC-CX-40 one declared input yields one wake, because the floor reads the frozen clock` |
| `PC-CX-41` | P1 | §4.3 I19-a · I19-b · I19-c · I6 · §5.5 EV1–EV6 · §10.2 W4-b · §15 F41 · §2.4 · §12.1 步骤 2 · G5 · §22.8 | 一条未消费事件恰好落在三支之一：在环、在环且迟到（backstop）、**出环**（§5.5 EV3 的原子丢弃，owner = §5.4 的消费者，`disposition = 'DISCARDED_OUT_OF_LOOP'`）。丢弃不 reconcile、不产生任何动作/blocker/唤醒，因此 I6 的"静默"逐字保留 | 不变（事件身份仍是 `dedupeKey`） | 幂等：带 `consumed_at IS NULL` 条件的一条 `UPDATE`，重放影响 0 行；重入按 EV1 在**被取到的那一刻**重判，因此重新启用或原子重开之后到达的事件得到的是消费 | `PC-CX-41 every unconsumed event lands in exactly one of three owned branches` |
| `PC-CX-42` | P1 | §7.4 EC2-a · EC2-b · EC2-c · EC3 · EC4 · EC5-a · EC6 · §7.7 D14-g · D15 · §6.1 S10-e · §2.4 · §15 F42 · §22.8 | 两个摘要各回答一个问题：EC2-a（九个身份，D14 在 `COMMIT` 用 SQL 重算）与 EC2-b（PAC §6 冻结进 Session 的每一列 + PAC §7.5 的整份 `resolution`）。提交点两个都比；写进 Session 的 create 冻结列**取自**冻结上下文（EC6-a），并由 D15 在插入时按等式证明 | 不变；`EXECUTION_RESULT_CHANGED` 的动作照常占用它的键，`dispatch_attempt` 照常 +1 | 结果漂移**不开 blocker**：一条写明 `changedComponents[]` 的 `NOOP`，那次写入本身发事件，下一次 reconcile 用新的键重派 | `PC-CX-42 the authorization digest and the result digest are two questions, compared separately` |

新增的模型断言在 [`coordinator-counterexample.spec.ts`](../src/apiserver/src/projects/coordinator-counterexample.spec.ts)，新增的真实 PostgreSQL 断言在 [`coordinator-linearization.pg.spec.ts`](../src/apiserver/src/projects/coordinator-linearization.pg.spec.ts)；02 在 v1.6 轮次留下的 [`coordinator-v16-adversarial.spec.ts`](../src/apiserver/src/projects/coordinator-v16-adversarial.spec.ts) 按 §24.6 对 v1.5 那份 spec 的同一条纪律**从"证明缺陷存在"翻转成"旧形状被拒绝/得到唯一合法结果"**，并把 v1.6 的失败形状原样保留为每条断言里的**反向对照**。

### 25.1 `PC-CX-37` 一张 denylist 不可能跟着表一起长大

**最小交错序列**（一条语句就够，不需要两个事务）：插一条 `APPLIED` 的 `DISPATCH_TASK`，`execution_context` 里 provider = `claude`，`reason_code = 'MANUAL'`，并插一条指向它、`provider = 'claude'` 的 COORDINATOR 占位。随后一条普通 `UPDATE` 把动作行的 `execution_context` / `execution_context_digest` 改成 provider = `codex`，同时把 `reason_code` 改成 `'REPLAN'`。**事务提交成功**：I17-A 的零行查询返回 1 行（Session 的 `provider = claude`，冻结上下文里是 `codex`），而 TR2-a 的窗口锚点被移到了另一个 `reasonCode` 上 —— 一个本该已经用掉的 60 秒限频窗口凭空消失。

**Postgres MVCC 与锁语义**：与并发无关。`BEFORE UPDATE` 触发器**每一次** `UPDATE` 都会执行，v1.4 的函数也确实执行了 —— 它只是**没有比较**那三列。这一行写下来是因为格式要求逐项回答同样的六个问题，而"这一项不涉及并发"本身就是一个要被明确说出来的答案：**一个执行了但看错了列的硬门，和一个不存在的硬门，在数据库里是同一个东西。**

**为什么 v1.5/v1.6 的绿色套件没抓到**：D11-c 当时逐字写的是"断言六列全部被拒、两列仍可写"，而研发 fixture 就照这句话建了一张八列的表。**测试与函数是同一张手写清单的两份副本**，因此它们只会一起对、一起错 —— 加列的那次修订两边都没动，套件照样全绿。这与 `PC-CX-32` 那条"fixture 建的是另一个对象"是同一种假阴性的第二种写法：那次差别在元数据，这次差别在**测试自己也不知道表长大了**。

**权威状态**：§7.7 D11 的函数体改成 `to_jsonb(NEW) - writable IS DISTINCT FROM to_jsonb(OLD) - writable`，`writable = {result_session_id, detail}`（D11-b 的闭集）；D11-c 逐条列出被冻的那几列各是谁的谓词；D11-d 写下为什么是 allowlist；D11-e 把可测形式从"断言六列"改成**从 `information_schema.columns` 驱动的逐列 mutation**。§12.1 步骤 6f 与 G5 的第一条跟着改。

**动作键**：不变。可写的两列（`result_session_id` / `detail`）不进任何幂等键，也不进 EC2-a / EC2-b 的任何分量。

**恢复路径**：不需要人工动作 —— 这是一条**在写入时就被拒绝**的缺陷，不是一条要事后修复的状态。如果一条被篡改的行真的进了生产（v1.7 之前的二进制），恢复是按 `project_decision` 里当时的审计行重建 `execution_context` / `reason_code`，而 `project_decision` 记的正是"那一刻读到了什么"（I17-B 的审计形式）。

**可执行断言**：`PC-CX-37 the applied action row is frozen by an allowlist, not by a list someone must remember to grow` —— 模型侧断言 D11 的函数体不再枚举列名、断言 D11-b 的可写集恰好两项、断言 D11-e 与 G5 要求的是 schema 驱动的 mutation；真实 Postgres 侧由 `coordinator-linearization.pg.spec.ts` 的 `PC-CX-37 on real Postgres: the applied action row is frozen column by column, whatever the schema is` 建真实形状的表与触发器，**从 `information_schema` 读出列名**逐列改写，断言除两列外全部被拒。**反向对照**：把 v1.4 的 denylist 函数原样建回来，同一次 mutation 让 `execution_context` / `execution_context_digest` / `reason_code` 三列全部提交成功，I17-A 的零行查询返回 1 行 —— 与复审报告 §6 `PC-CX-37` 的 `reason_code=REPLAN / session.provider=claude / action.execution_context.provider=codex / mismatch count=1` 逐字对应。

### 25.2 `PC-CX-38` 引用另一份契约要引用它的行，不是它的标题

**最小交错序列**（三个阶段，每一步都合法，不需要两个事务）：动作行冻结 `model = 'model-v1'`。① 控制环插入占位 Session，PAC §6 规定 `model` 在 **create 时不写**，于是这一刻 `model IS NULL` —— I17-A 的等式为假。② runner 首次 claim，`queue.service.ts` 的 compare-and-set 把它 materialize 成 `model-v1` —— 等式为真。③ 该模型被 runtime 彻底下架，PAC §6 保留的 `retiredPin` 例外合法地把它改成 `model-v2` —— 等式再次为假。**第一和第三个已提交状态都不满足 I17-A，而三步里没有任何一步是错的。**

**Postgres MVCC 与锁语义**：与并发无关，这一项是**两份契约的冻结时刻不一致**。写下这一行的意义与 §24.2 相同：拿锁去修一个定义上就不成立的等式，只会得到一个更慢的、同样不成立的实现。真正需要数据库的是**另一件事** —— 让"改了几次"这件事本身不可伪造，那是 D15 的 `execution_pin_generation` 协议。

**为什么 v1.6 会写成那样**：v1.6 在拆 I17 的时态时，从 PAC §6 抄的是那张表的**标题**（"Execution Snapshot 冻结契约"）与它的列名，没有读**冻结时刻那一列** —— 十一行里有九行写着 "Session create"，两行写着 "首次 claim"，而 PAC §6 S1 还专门解释了为什么是首次 claim（"改成 create 会让创建时 runner 还没上报 runtime 默认模型的 Session 拿到错的模型"）。**一份契约的表格里，最容易被跳过的恰恰是那一列"什么时候"。**

**权威状态**：§4.3 I17-A 收窄成只比较 PAC §6 的 create 冻结列（并补上 v1.6 漏掉的 `provider_builtin` 与 `required_capabilities`）；新增 I17-A2，用 `session.execution_pin_generation`（§2.4）把 `model` / `effort` 分成三个阶段，每个阶段一句恒成立的话，**两个方向都要查**；新增 I17-d 记下这次错误的形状。§7.7 D15 给这一列一个**封闭的 mutator 协议**（create 时必须是 0 且两列为 NULL、每改一次必须恰好 +1、不改不许动、create 冻结列一律不可改）。§7.4 EC6-c 说清楚 claim 时的实际取值记在哪里。§12.1 步骤 2 / 6f / G5 与 §15 F40 跟着改。

**动作键**：不变。`execution_pin_generation` 落在 Session 上，它回答"这条快照被合法改过几次"，不参与任何动作身份 —— 与 §8.2 GE1 那三个进键的代次是**同一条纪律的不同用途**，写在这里以免下一个人把它塞进 dispatch 键。

**恢复路径**：**不做任何事**。三个阶段都是 PAC 允许的正常生命周期，没有任何一步需要恢复；D15 唯一会拒绝的是"改了而不记账"和"记账而没改"，两者都是缺陷而不是故障。

**可执行断言**：`PC-CX-38 the frozen snapshot is compared per PAC freeze point, with a phase and a generation` —— 模型侧按 PAC §6 表的两列（列名 × 冻结时刻）逐行反推 I17-A 的比较集合，断言它**恰好**是 create 那一组、断言 I17-A2 覆盖 claim 那一组的三个阶段，并跑一遍 PENDING → claim → `retiredPin` 三阶段（含两个反例：改了不记账、记账不改）；真实 Postgres 侧由 `coordinator-linearization.pg.spec.ts` 的 `PC-CX-38 on real Postgres: the placeholder snapshot has three phases and one monotone generation` 用真实的 D15 触发器跑同样的三阶段与四个反例。**反向对照**：把 I17-A 换回 v1.6 的形式（把 `model` 加进去），PENDING 那一格与 `retiredPin` 那一格立刻红 —— 与复审报告 §6 `PC-CX-38` 的三步序列逐字对应。

### 25.3 `PC-CX-39` 排到第二个键就停下的排序不是全序

**最小交错序列**（不在时间上，而在同一份候选表的两个枚举顺序之间）：两条 open blocker 都来自 §10.4 的第 1 条（`recovery ∈ {TIME, EVENT}`），`next_check_at` 都是 `60s`，一条是 `PROVIDER_UNAVAILABLE`、一条是 `NO_MATCHING_RUNNER`。v1.6 的 W5 按 `(at, source)` 排序，两条完全相等，于是 `chosen` 取决于数组顺序：正序得到 provider 那条、逆序得到 runner 那条。`nextWakeAt` 相同，`nextWakeReason` 与落审计的 `wakeCandidates` 顺序**都不同**。多个同 `runAt` 的 Task（第 4 条）同理。

**Postgres MVCC 与锁语义**：与并发无关。值得写下来的是它的**数据库形式**：如果 `chosen` 用一条 `ORDER BY … LIMIT 1` 实现，那么在没有第三、四个键时 PostgreSQL 给出的是一个**任意但合法**的行，而且它会随计划（seq scan / index scan）、随行的物理位置、随一次 `VACUUM` 变化 —— 这正是"与遍历顺序无关"这句话必须由**排序键**而不是由实现纪律来保证的理由。第四个键还必须指定**按字节比较**：`text` 的默认排序受数据库 collation 影响，两台 locale 不同的机器会给出两个 `nextWakeReason`，而 UUID 的规范文本在 `COLLATE "C"` 下才有唯一的顺序。

**为什么 v1.6 的可测形式没抓到**：它写的是"把第 7 条与第 1–6 条**两两组合**，断言 `(nextWakeAt, nextWakeReason)` 与遍历顺序无关" —— **组合的是不同的 source**，而不同 source 的并列已经被第二个键裁决了。同一个 source 内的两条候选从来没有被构造过。这与 `PC-CX-30` / `PC-CX-33` 的形状相同，只是换到了测试矩阵上：**一个只在跨类之间取样的矩阵，看不见类内的歧义。**

**权威状态**：§10.4 W5 第 1 条给出**候选身份表**（七个 source 各自的 `subjectType` / `subjectId` 与"一个 subject 产出几条"），第 2 条把排序键扩到 `(at, source, subjectType, subjectId)` 并写明字节序，W5-2a 用身份表证明它真的是全序，W5-2b 说明为什么第三、四键必须是持久列。第 3、4 条的 `nextWakeAt` / `wakeCandidates` 因此都唯一。§15 F38 跟着改。

**动作键**：不变 —— `nextWakeAt` 不是一个动作，它是 outcome 的一个字段（§6.2）。

**恢复路径**：不需要人工动作，也不开 blocker。被压下去的候选照常落 `wakeCandidates`（W5 第 4 条），因此"没胜出的原因不是被丢掉了"逐字不变。

**可执行断言**：`PC-CX-39 two candidates from one source are decided by a persistent total order` —— 模型侧对**每一个** source 构造 2+ 条同刻候选并跑全排列，断言 `(nextWakeAt, nextWakeReason, wakeCandidates)` 逐字节相同，再断言按 collation 排序与按字节排序在一对精心挑选的 id 上给出不同答案（因此"字节序"这三个字是规范的一部分，不是一句多余的话）；真实 Postgres 侧由 `coordinator-linearization.pg.spec.ts` 的 `PC-CX-39 on real Postgres: the candidate order is total, and it does not depend on the collation` 用真实的 `ORDER BY` 与真实的行跑同样的断言。**反向对照**：把排序键砍回 `(at, source)`，同一份候选表的两个枚举顺序立刻给出两个 `nextWakeReason` —— 与复审报告 §6 `PC-CX-39` 的那一行逐字对应。

### 25.4 `PC-CX-40` 最后一个游离的时钟藏在一句"它不参与决策"里

**最小交错序列**（同一份声明输入，两次不同的墙钟）：`decisionInput` 的 `world.candidateAt = 60s`、`evaluation.epoch = 58`、`signals = []`，`decisionInputHash` 因此固定。这一次 reconcile 在墙钟 `58s` 执行得到 `nextWakeAt = max(60, 58 + 5) = 63s`；同一份输入在 `59s` 执行（重放、接管、或只是慢了一秒）得到 `64s`。§6.1 S3 逐字要求"相同 hash 必须给出逐字相同的机械决策 —— 相同的 `actions`、相同的 `blockersOpened`/`blockersCleared`、**相同的 `nextWakeAt`**"，因此这条要求在它自己的算法上为假。

**Postgres MVCC 与锁语义**：与并发无关，这一项是**输入的完备性**。它与 `PC-CX-22`（v1.4 把时钟折成到期事实）是同一条线的最后一段：v1.4 把**判断**用的时钟收进了 `evaluation.epoch`，却给"落库的那个时刻"留了一句豁免，而 `nextWakeAt` 既是落库的时刻**也是**决策的输出。

**为什么 v1.4–v1.6 会写成那样**：S5 的豁免句是"要写 `now()` 的地方只剩两处，**都不参与决策**：`nextWakeAt` 的落库值与展示字段"。这句话把 `nextWakeAt` 和 `last_seen_at` 归成了一类，而 §6.2 的 outcome 结构里 `nextWakeAt` 明明白白是一个字段、S3 明明白白点了它的名。**一条豁免只要写得足够顺口，就没有人回去核对它豁免的东西是不是真的在豁免范围里。**

**权威状态**：§6.1 S5 把 `nextWakeAt` 移出豁免并重述判据（同一 `world` 配两个 epoch，只要到期事实相同，`actions` / `blockers` / `nextWakeReason` 逐字相同；`nextWakeAt` 允许随 epoch 平移，而 hash 相同就意味着 epoch 相同）。§10.4 W3 与 W5 第 3 条的下限改成 `evaluation.epoch + 5s`；§10.4 第 5、6 条、§7.7 D5 的冲突表、§8.6 LO4、§7.6 TR2-d、§4.3 I18-C 里的 `now + 60s` / `now + 5s` 一并改成 `epoch` 起算；W5 第 6 条写下 floor 改用 epoch 之后的可观测后果与它为什么不会自旋；W5 第 7 条把**仅有的两处**不由 W5 产出的 `next_wake_at` 写入点名（取不到租约写现持有者的租约到期时刻、R2 超时写 `now + 60s`），两处都不产生决策行，因此不在 S3 的量化域里。

**动作键**：不变。

**恢复路径**：不需要人工动作。可观测后果是"floor 的起点从提交时刻变成读快照时刻"，相差一次 reconcile 的墙钟（p95 ≤ 2s，硬上限 5min），而两条独立的理由保证它不会退化成自旋（W5 第 6 条）。

**可执行断言**：`PC-CX-40 one declared input yields one wake, because the floor reads the frozen clock` —— 模型侧把同一份序列化 `decisionInput` 在 0 / 1 / 4 秒的模拟墙钟下分别求值，断言 `nextWakeAt` 逐字节相同；再扫描 §1–§18，断言除 W5 第 7 条点名的两处外没有任何一条规则从 `now()` 算 `next_wake_at`；真实 Postgres 侧由 `coordinator-linearization.pg.spec.ts` 的 `PC-CX-40 on real Postgres: the same declared input yields the same wake at two wall clocks` 用真实的 `project_event` / `project_action` 行与两次不同的 `now()` 算出同一对值。**反向对照**：把 floor 换回 `now() + 5s`，同一份输入在两次执行下立刻给出 63s 与 64s —— 与复审报告 §6 `PC-CX-40` 的那两个值逐字对应。

### 25.5 `PC-CX-41` 一条不变量的量化域不能比它的责任域大

**最小交错序列**（两个最小状态，各自都是正常主路径）：**A** —— 一个 `status = OPEN`、`coordinatorEnabled = false`、`run_state = PLANNING` 的 legacy Project（迁移生成的每一行都是这个形状，I6），它的一个 Task 被更新，§5.3 N1 在同一事务里提交一条 `task.updated`。I6 禁止对它 reconcile，§10.3 的四条与 §10.2 W4 的四支都要求 `coordinator_enabled`，因此**没有人负责这一行**。**B** —— 一个已经 `DONE` / `SETTLED` 的 Project，它的最后一条在飞 Session 随后结束并提交 `session.ended`；`SETTLED` 不再消费事件，W4 同样排除它。两格都得到一条**永远躺在队列里**的已提交行，而 I19 逐字宣称"任何已提交状态上"它必有归属。

**Postgres MVCC 与锁语义**：这一项的选择同样是**不加锁**（与 `PC-CX-36` 的 I18-note 同源）。审查暗示的另一条路是在 §5.3 N1 上加 `coordinatorEnabled` 过滤，让这些事件根本不产生。**它关不掉缺口**：项目可以在事件提交**之后**才出环（人关掉开关、验收成 `DONE`、在飞 Session 在 `SETTLED` 之后才结束），因此"已提交 + 出环"这个状态无论如何都存在；它还要给每一次业务写加一次 `project` 读，正是 I18-note 已经拒绝过的写放大。因此 N1 一个字不改，处置放在消费侧，而消费侧读 Project 当前行本来就是它每一轮都要做的事。

**为什么 v1.6 会写成那样**：I19 是从 `PC-CX-36` 的那一格出发写的 —— 那一格关心的是"一条**在环项目**上的显式请求会不会被看见"，于是它自然地用了 §10.3 与 W4 这两个**已经存在的、都带 `coordinator_enabled` 前提**的谓词，并把量化域写成了"任何已提交状态上的任何未消费事件"。**量化域是一句话写出来的，责任域是两个谓词继承来的，没有人把两者对齐过。** 这与 `PC-CX-05`（一个恒为真的告警）的教训是同一句话的另一面：一条不变量必须对正常主路径的**每一个**状态成立，而不只是对写它的人当时想着的那一类项目。

**权威状态**：§4.3 I19 拆成三支（I19-a 在环、I19-b 迟到由 backstop 看见、I19-c 出环有终态处置），并写明三支的谓词是对 Project 当前行的一次划分，因此恰好命中一支；§4.3 I6 把"不消费事件"与"不 reconcile"分开，静默的含义收窄成"控制环不对它做任何事"；新增 §5.5（EV1 处置按当前世界判、EV2 三个终态封闭、EV3 出环谓词与那条 `UPDATE`、EV4 幂等与重入、EV5 为什么不在生产侧过滤、EV6 与 W4 的分工）；§10.2 新增 W4-b 说明为什么出环的行**不**进 backstop（否则就是 `PC-CX-05` 那条恒为真的告警的第二次）；§2.4 与 §12.1 步骤 2 加 `project_event.disposition` 与它的存量回填；§15 新增 F41。

**动作键**：不变。事件的身份仍是 `dedupeKey`（§5.4 的 partial unique index），丢弃不产生任何 `project_action`，因此不占任何键。

**恢复路径**：无需人工动作，且**天然可重入** —— 处置在取到事件的那一刻按 Project 当前行判定（EV1），因此一条在出环期间入队、在重新启用（G3）或原子重开（§13.4 AE8）之后才被取到的事件得到的是**消费**而不是丢弃；反过来，丢弃之后同一原因再发生会新插一行（partial unique index 只约束未消费的行），它照样重新判定。

**可执行断言**：`PC-CX-41 every unconsumed event lands in exactly one of three owned branches` —— 模型侧枚举 Project 的 `status × coordinatorEnabled × runState` 全部组合 × 事件的三种年龄，断言每一格**恰好**命中 I19 的一支、断言出环那一支不产生任何动作/blocker/唤醒/WARN、断言重入那一格得到消费而不是丢弃；真实 Postgres 侧由 `coordinator-linearization.pg.spec.ts` 的 `PC-CX-41 on real Postgres: an out-of-loop event is discarded exactly once, and re-entry consumes instead` 用真实的 W4 谓词、真实的 EV3 `UPDATE` 与真实的 partial unique index 跑同样的格子。**反向对照**：去掉 EV3，A 与 B 两格的事件既不被任何一支 W4 命中、也没有 `consumed_at` —— 与复审报告 §4 补充场景和 §6 `PC-CX-41` 的两个最小状态逐字对应。

### 25.6 `PC-CX-42` 一个摘要不能同时回答两个问题

**最小交错序列**（两个已提交状态，九个身份逐字相同）：决策时解析出 Agent/成员/Task/指派/provider/model/workspace/runner/协调 workspace 九个身份，`effort = high`、`requiredCapabilities = [linux]`。提交之前，有人把 `agent.default_effort` 改成 `low`、把 `agent.required_capabilities` 改成 `[linux, docker]`。EC3 在 project 行锁之后重解析：**九个身份一个都没变**，`executionContextDigest` 逐字相同，D14 在 `COMMIT` 同样通过。于是一条 Session 被合法提交，而它的 `effort` 与 `requiredCapabilities` **与被冻结的那次决策不同** —— PAC §6 把这两样冻进 Session，§6.1 S10-e 也明确承认改默认 effort **会改变一次派发的结果**。`revokedInput` 的八个值一个都不适用，因此这次漂移连一个名字都没有。

**Postgres MVCC 与锁语义**：EC3 的 `FOR SHARE` 与人工写的 `FOR NO KEY UPDATE` 已经把两次写排了序，锁在这里**没有任何问题** —— 问题是排好序之后**比错了东西**。这与 `PC-CX-28` / `PC-CX-34` 那句"一把锁能保证的只是顺序"是同一句话的第三种用法：顺序对了，判据仍然可以是错的。

**为什么 v1.5/v1.6 没抓到**：EC2 的九个分量是**为 D14 挑的** —— D14-c 明确说了它是"本文对 PAC 唯一的在数据库里再实现一次"，因此分量必须能在 SQL 里如实算出来。这个约束是对的，但它被**同时**当成了"什么算一次相同的派发"的定义。S10-e 甚至已经把这条边界写下来了（"前者是 S3 要的，后者是 D14 要的，两个判据不是一回事"），却只写成了一句给读者的提醒，没有变成两个落库的列。**一句写对了的注释，如果没有对应的机制，下一轮仍然会被读成一句可以忽略的话。**

**权威状态**：§7.4 EC2 拆成 EC2-a（授权摘要，九个身份，逐字沿用）与 EC2-b（结果摘要，PAC §6 冻进 Session 的每一列 + claim 冻结列的解析结论 + PAC §7.5 的整份 `resolution`），EC2-c 用一张两选项表写下为什么必须是两个；EC3 的判据改成两行表（授权不等 ⇒ `EXECUTION_CONTEXT_REVOKED`；授权相等而结果不等 ⇒ `EXECUTION_RESULT_CHANGED`），EC4 加第三个码并说明它为什么不带 `revokedInput`，EC5-a 说明它落在哪一格（等于 `TASK` 那一行：不开 blocker、`NOOP`、`dispatch_attempt` +1）；新增 EC6（写进 Session 的 create 冻结列**取自**冻结上下文，不是第二次解析的输出；数据库侧由 D15 按等式证明；claim 冻结列按 EC6-c 记录）。§7.7 新增 D14-g 划清 D14 与 D15 的分工，新增 D15 本体。§2.4 加 `project_action.execution_result_digest`，§12.1 步骤 2 / 6f / G5 与 §15 F42 跟着改。

**动作键**：不变。`EXECUTION_RESULT_CHANGED` 的动作行**照常占用它的键**（那次决策确实发生过，§8.5 C6），因此 `task.dispatch_attempt` 必须在同一事务里 `+1` —— 与 EC5 末段对撤权的要求逐字相同，理由也一样（`PC-CX-11` 的形状）。

**恢复路径**：**不开 blocker**。没有任何输入被撤回，也没有任何人需要做任何事：改 `default_effort` / `required_capabilities` 的那次写入本身产生事件，下一次 reconcile 读到新事实、算出一份新的执行上下文、用一个新的键派出去。这与 EC5 表里 `TASK` 那一行、§9.4 `maxConcurrentTasks` 那一行、§9.5 Q3-a 退避期那一行是**同一种形状**（BL1 的合法出口）。

**可执行断言**：`PC-CX-42 the authorization digest and the result digest are two questions, compared separately` —— 模型侧从 PAC §6 的冻结表与 PAC §7.5 的结构反推 EC2-b 的分量集合，对**每一个**分量做删除 mutation（删掉它，必须能造出一对 EC2-b 相同而 Session 结果不同的状态），并跑 `PC-CX-42` 的最小交错断言两个摘要一个相等一个不等、拒绝码是 `EXECUTION_RESULT_CHANGED`、没有 blocker 被开、`dispatch_attempt` 前进；真实 Postgres 侧由 `coordinator-linearization.pg.spec.ts` 的 `PC-CX-42 on real Postgres: the snapshot guard admits only the frozen result` 用真实的 D15 触发器断言一条 create 冻结列与冻结上下文不同的占位**插不进去**。**反向对照**：把 EC3 换回只比一个摘要、把 D15 去掉，同一次交错立刻提交出一条 `effort` / `requiredCapabilities` 与决策不同的 Session，而两个摘要里唯一被比的那个仍然相等 —— 与复审报告 §6 `PC-CX-42` 的那一段逐字对应。

### 25.7 本次修订**没有**做的事

同 §19.9 / §20.7 / §21.7 / §22.9 / §23.5 / §24.6，边界要写清楚：

- **本次修订仍不含实现**。03–23 单元一行业务代码都还没写；D11 的 allowlist、D15 的 mutator 协议、`session.execution_pin_generation`、`project_action.execution_result_digest`、`project_event.disposition`、W5 的第三第四排序键与 §5.5 的丢弃语句目前都是**契约条款**，不是数据库里的对象或代码里的函数。真实 PostgreSQL 测试建的是**测试用的表**，它们证明的是"这些 SQL 语义成立"，不是"迁移已经写好了"，后者归 03 / 04 单元（§12.1 G5 已列出必须显式验证的二十一样东西）。
- **七份审查文档一字未改**（任务的硬约束）。它们记录的是 v1 到 v1.6 的事实；v1.7 的回应写在本节。
- **PAC 一个字没改**。`PC-CX-38` 与 `PC-CX-42` 都是"本文引用 PAC 时读错了/读漏了"，不是 PAC 写错了：PAC §6 的两个冻结时刻（create / 首次 claim）与 S1 的理由都是既有实现的忠实记录，`retiredPin` 也是既有例外。v1.7 的做法是**让本文的不变量去适配 PAC 的行**，而不是反过来要求 PAC 改冻结时刻 —— 后者会让"创建时 runner 还没上报 runtime 默认模型的 Session 拿到错的模型"这个 PAC §6 S1 明确避免的老 bug 回来。
- **02 在 v1.6 轮留下的 `coordinator-v16-adversarial.spec.ts` 被翻转，不是被删**。理由与 §22.9 / §23.5 / §24.6 逐字相同：一条"缺陷存在"的断言在缺陷被修好的那一刻必然变红。翻转后每条断言**同时保留 v1.6 的形状作为反向对照**。
- **六处行为变更，不是措辞澄清**：D11 从 denylist 变成 allowlist（因此**将来加的列默认冻结**，加列的人必须显式决定它是否可写）；I17-A 的比较集合收窄并新增 I17-A2 与一列 `execution_pin_generation`（因此"一条 PENDING 占位的 `model` 为 NULL"从违约变成阶段 0 的**正常状态**）；W5 的排序键从二元变成四元（因此 `wakeCandidates` 的落库顺序也被钉住）；floor 与几处 `now + 60s` 的起点从墙钟变成 `evaluation.epoch`（因此 S3 第一次对 `nextWakeAt` 成立，代价是 floor 的度量起点提前了一次 reconcile 的墙钟）；出环项目的事件从"永远未消费"变成"被丢弃并留下 `disposition`"（因此 `project_event` 多了一列，且消费者每轮要多读一次 Project 当前行）；提交门从比一个摘要变成比两个（因此多了一个拒绝码与一列 `execution_result_digest`）。六处都登记进了 §22.8 的残句账（第一处两行、第三处两行、第四处两行、第五处两行，其余各一行，共十行）。
- **没有给事件生产者加锁，也没有给 N1 加过滤**（§5.5 EV5），理由与 I18-note 的两行表同源。
- **没有把 EC2-b 也交给数据库算**（D14-g）。D14 仍然只比授权摘要，结果那一半由 D15 的**等式比较**保证 —— 买到的是同样的混合版本保证，付出的是"占位的 create 冻结列必须逐字来自冻结上下文"这条更强的构造约束（EC6-a）。如果将来有人要让 D14 也算结果摘要，D14-c 那笔账会翻倍，必须重新评估。
- **`decisionInput` 没有因为本轮多出任何字段**。`execution_pin_generation` / `disposition` / `execution_result_digest` 三列都不被任何一条**决策规则**读（它们分别是不变量、队列处置与提交门的谓词），因此按 §6.1 S8 的双向断言，它们**不该**进 `world` —— 加进去会让 S8 的"每个字段都必须有至少一条规则读它"那一半为假。

---

## 26. `PC-CX-43..46` 修订闭环（v1.8）

> **本节是非规范的（non-normative）修订日志**（§0 RL1，v1.4 冻结、v1.8 扩到本节）。它记录 v1.8 当时的事实与当时的推理，**不是现行规范**；任何一句与 §1–§18 冲突时一律以 §1–§18 为准。历史形状只允许出现在这里和反例测试里（`PC-CX-27`）。

02 对 v1.7 的独立复审（[`project-coordinator-contract-review-02-v1.7.md`](./project-coordinator-contract-review-02-v1.7.md)）判 **FAIL / BLOCKED**，给出 3 个 P0 与 1 个 P1。本节是**逐项关闭的索引**，格式与 §19–§25 相同。**八份审查文档都不因本次修订而改动** —— 它们记录的是 v1 到 v1.7 的事实，那些事实没有变；变的是契约。

四项里有一条贯穿的线，而且它是**本文已经交过三次学费的那条**：`PC-CX-09` / `PC-CX-20` 教的是"插入时成立不是已提交状态上成立"，`PC-CX-21` / `PC-CX-28` / `PC-CX-34` 教的是"点态不是恒成立"。这一轮的三个 P0 是同一句话的第三种写法：**一条硬门必须回答"在我之后还剩哪一次写、我的作用域由谁决定"**。

- `PC-CX-43`：D11 之后还剩一次写，而且**那一次写就是把动作发布出去的那一条**。§8.3 的语句顺序是"插 `CLAIMED` → 插 Session → 置 `APPLIED`"，D9 / D14 / D15 全部声明在 `session` 上、第 2 步就跑完了，而 D11 的第一句是 `IF OLD.status <> 'APPLIED' THEN RETURN NEW` —— 第 3 步因此是**所有硬门都已放行之后**的一次整行自由写。
- `PC-CX-45`：作用域由**被保护的那一行自己的 NEW 值**决定。D9 / D14 / D15 都以 `NEW.task_id IS NULL OR NEW.dispatch_origin <> 'COORDINATOR'` 提前返回，而这两列本身没有任何 mutator 协议。一条 UPDATE 同时把它们写空，三条硬门一起退出，D5 的 partial unique index 也因为谓词列变了而不再覆盖这一行。
- `PC-CX-44`：一份"封闭集合"的手工副本，比它引用的那张表少了三行。这是 `PC-CX-27` / `PC-CX-30` / `PC-CX-33` / `PC-CX-37` 之后的**第五次**，而且这一次的两侧（PAC §6 的表、D15 的 SQL）之间连一条机械检查都没有 —— 少的那三行里有两行进 EC2-b，因此少的不是"审计字段"，是**权限**。

第四项 `PC-CX-46` 的形状不同：它不是"漏了一次写"，是**一条双向命题只被写成查询、没有被写成约束**。I17-A2 逐字要求"两个方向都要查"，而 D15 的 SQL 从未读过 `project_action.detail`，`detail` 又恰好是 D11-b 放开的可写列。**一条自己说要双向查的规则，如果只有一侧有对象在看，它就只是一句话。**

v1.8 的答案在四处：**一个按 `OLD.status` 分档、并给 `CLAIMED` 一个封闭 transition 目标集的 D11**（发布语句只剩四列可写）、**一条对 D9 / D14 / D15 一致的 OLD ∨ NEW 作用域规则加 D15 冻住的 lineage 三列**（D5 的 claim 因此只能靠改 `status` 释放）、**一张按 PAC §6 行数补齐的 create 冻结集加 `snapshotFrozenAt` 的唯一来源**（EC6-d）、以及**新增的 D16**：两条可延迟约束触发器，一条在 `COMMIT` 证明 Session 实际结果等于动作冻结结果，一条把代次与账本钉成双向原子关系。

| ID | 级别 | 规范条款 | 权威状态 | 动作键 | 恢复路径 | 可执行断言 |
|---|---|---|---|---|---|---|
| `PC-CX-43` | **P0** | §7.7 D11 · D11-a · D11-f · D11-g · §12.1 G5 · §15 F43 · §22.8 | 动作行的可写集由 `OLD.status` 分两档：`CLAIMED` 只剩 `status` / `refusal_code` / `result_session_id` / `detail` 四列（且 `status` 的目标必须落在 `{CLAIMED, APPLIED, REFUSED, SUPERSEDED}` 这个闭集里），三个终态只剩 `result_session_id` / `detail`。**§8.3 的发布语句因此也在冻结范围里**，两个摘要与 `reason_code` 第一次真的不可能在发布那一刻被改 | 不变（可写集不进任何键或摘要） | 无需恢复：改写在数据库层被 `ACTION_PUBLISH_IMMUTABLE` / `ACTION_TRANSITION_ILLEGAL` 拒绝，错误消息带被改的列名；要写对必须在插 `CLAIMED` 那一步就写对 | `PC-CX-43 the publishing transition is inside the freeze, not outside it` |
| `PC-CX-44` | **P0** | §4.3 I17-A · §7.4 EC2-b · EC6-a · EC6-d · §7.7 D15 · D15-g · D16 · D16-d · §12.1 G5 · §15 F44 · §22.8 | create 冻结集是 PAC §6 表里冻结时刻为 "Session create" 的**每一行**，含 `permission_mode` / `resolution` / `snapshot_frozen_at`；`snapshotFrozenAt` 的唯一来源是 `execution_context`（EC6-d）。**插入点（D15）与提交点（D16）用同一张清单各证明一次**，因此"Session 实际结果 = 动作冻结结果"在任何语句顺序下都成立 | 不变；一份结果只对应一个动作键 | 无需恢复：三列一律从冻结上下文逐字复制，写不出第二份；写歪得到 `EXECUTION_SNAPSHOT_MISMATCH`（语句）或 `EXECUTION_RESULT_MISMATCH`（提交） | `PC-CX-44 the create-frozen set is the whole PAC table, proved at insert and at commit` |
| `PC-CX-45` | **P0** | §4.3 I17-A3 · §7.7 D5 · D9 · D14 · D15-a · D15-f · §12.1 G5 · §15 F45 · §22.8 | 所有 Session 硬门的作用域在 `UPDATE` 上读 **OLD ∨ NEW**：只有两侧都不是 COORDINATOR 占位才提前返回。COORDINATOR 占位的 `task_id` / `dispatch_origin` / `project_action_id` 是 create 冻结列（I17-A3），因此 D5 的唯一 claim **只能靠改 `status` 释放**，不可能被写出索引覆盖集 | 不变；两个动作键此后不可能对应两条同时 live 的物理执行 | 无需恢复：自我豁免的那条 UPDATE 被 `EXECUTION_SNAPSHOT_FROZEN` 拒绝，第二条 live Session 照常在 D5 索引上得到 §7.7 D5 表里那三个确定结果之一 | `PC-CX-45 a session cannot write itself out of the gates that hold its claim` |
| `PC-CX-46` | P1 | §4.3 I17-A2 · §7.7 D15 · D16 · D16-a · D16-b · §7.4 EC6-c · §15 F46 · §22.8 | `session.execution_pin_generation` 与动作行 `detail` 上的 `claimResolution` / `retiredPins[]` 是一条**双向原子关系**，由两条可延迟约束触发器（Session 侧、动作侧）在 `COMMIT` 各证明一个方向：代次 0 ⇒ 账本为空；代次 `n ≥ 1` ⇒ 有 `claimResolution` 且恰好 `n − 1` 条 `retiredPins[]` | 不变（代次与账本都不进动作键） | 无需恢复：合法的首次 claim 与 `retiredPin` 照常提交，它们只需与账本写在同一事务里；缺账、多账、错代次都得到 `EXECUTION_PIN_LEDGER` | `PC-CX-46 the pin generation and the action ledger are one atomic two-way relation` |

新增的模型断言在 [`coordinator-counterexample.spec.ts`](../src/apiserver/src/projects/coordinator-counterexample.spec.ts)，新增的真实 PostgreSQL 断言在 [`coordinator-linearization.pg.spec.ts`](../src/apiserver/src/projects/coordinator-linearization.pg.spec.ts)；02 在 v1.7 轮次留下的 [`coordinator-v17-adversarial.spec.ts`](../src/apiserver/src/projects/coordinator-v17-adversarial.spec.ts) 按 §25 对 v1.6 那份 spec 的同一条纪律**从"证明缺陷存在"翻转成"旧形状被拒绝/得到唯一合法结果"**，并把 v1.7 的失败形状原样保留为每条断言里的**反向对照**。

### 26.1 `PC-CX-43` 发布动作的那条 UPDATE 在冻结之外

**最小交错序列**（一个事务，三条语句）：插一条 `status = 'CLAIMED'` 的 `DISPATCH_TASK`，`execution_result_digest = 'result-ok'`；插一条与它的 `execution_context` 完全匹配、因此 D15 放行的 COORDINATOR 占位；再 `UPDATE project_action SET status = 'APPLIED', result_session_id = 's1', execution_result_digest = 'forged-after-session-insert'`。**事务提交成功**：观察为 `{status: 'APPLIED', execution_result_digest: 'forged-after-session-insert'}`，D9 的可延迟归属检查同时通过（它读的六列一列没动）。I17-A 于是有了一条已提交的反例，而**没有任何一条硬门执行失败** —— 它们都执行了，只是都在这条 UPDATE 之前。

**Postgres MVCC 与锁语义**：与并发无关，一个事务、一条语句就够。`BEFORE UPDATE` 触发器每一次 `UPDATE` 都执行，v1.7 的函数也确实执行了 —— 它的第一句主动放行。这一行写下来是因为格式要求逐项回答同样的六个问题，而"这一项不涉及并发"本身就是答案的一部分：**一个执行了但主动放行的硬门，和一个不存在的硬门，在数据库里是同一个东西**（与 `PC-CX-37` 那句"看错了列"是同一句话的两种写法）。

**为什么 v1.7 的绿色套件没抓到**：D11-e 逐字写的是"对**一条 `APPLIED` 行**逐列尝试改写"，研发 fixture 就照这句话建了一条 `APPLIED` 行。**测试与函数是同一句话的两份副本**：函数说"OLD 是 APPLIED 才管"，测试就只造 OLD 是 APPLIED 的行，于是那个被放行的窗口在两边都不存在。这与 `PC-CX-37` 的假阴性同型，差别在这一次漏掉的不是一列，是**一个状态**。

**权威状态**：§7.7 D11 的函数体按 `OLD.status` 分两档 —— `CLAIMED` 用 `writable || ARRAY['status','refusal_code']` 并先判 transition 目标落在闭集里，终态用 `writable`，没有整行放行的分支；不认识的 `OLD.status` 得到 `ACTION_TRANSITION_ILLEGAL`。D11-a 改述成"由构造成立"，新增 D11-f（发布语句的闭集与那条三句事务）与 D11-g（逐列 mutation 要跑两遍，以及 v1.7 的反向对照）。§12.1 G5 第 ⑤ 条、§15 F43 跟着改。

**动作键**：不变。发布语句的四个可写列一列都不进 `idempotency_key`、两个摘要或任何硬门的谓词。

**恢复路径**：无需恢复。越界的发布语句在数据库层就被拒，错误消息带被改的列名；`CLAIMED` 那一步写错的东西必须在那一步修好，因为那之后所有硬门都已经放行 —— 这正是本条要买的东西。

**可执行断言**：`PC-CX-43 the publishing transition is inside the freeze, not outside it`（模型）+ `PC-CX-43 on real Postgres: the publishing UPDATE is frozen column by column`（真实 PostgreSQL，含 v1.7 反向对照）。

### 26.2 `PC-CX-44` 一张手写的冻结集比 PAC 的表少三行

**最小交错序列**（一个事务）：动作行的 `execution_context` 写 `permissionMode = 'read-only'` 与一份合法 `resolution`；Session 的其余六列与冻结上下文完全相同，但写 `permission_mode = 'danger-full-access'` 与一份伪造的 `resolution`；动作照常置 `APPLIED`；`COMMIT`。**提交成功**：观察为 `{session_permission: 'danger-full-access', frozen_permission: 'read-only', resolution_equal: false}`。同一个动作键、同一份 `execution_result_digest` 对应两份权限结果，而 §8 / §11 的恢复判据读的是**动作那一份**。

**Postgres MVCC 与锁语义**：同样与并发无关。D15 的 `INSERT` 分支执行了，它比较的六列全部相等 —— 少的那三列它根本没读。可延迟与否也不改变结论：v1.7 在提交点**没有任何对象**比较结果那一半（D14-g 明确 D14 不比 EC2-b）。

**为什么 v1.7 的绿色套件没抓到**：D15-e 与研发 fixture 建的 `session` 表**只有六个快照列**。PAC §6 的表是另一份文档里的一张 Markdown 表，两边之间没有任何机械关系 —— 与 `PC-CX-33` / `PC-CX-38`"引用另一份契约要引用它的行、不是它的标题"是同一句话，这一次是"要引用它的**行数**"。

**权威状态**：§4.3 I17-A 的 create 冻结列补齐到 PAC §6 的九行；§7.4 新增 EC6-d 给 `snapshotFrozenAt` 一个唯一来源（冻结那一刻，随 `execution_context` 逐字复制，不是插入处的 `now()`）；§7.7 D15 的 `INSERT` 与 `UPDATE` 两支都补上这三列，新增 D15-g 划清"每条语句"与"提交点"的分工；**新增 D16**，用一条可延迟约束触发器在 `COMMIT` 用同一张清单再证明一次，并同时要求动作行已 `APPLIED`。§12.1 G5 第 ⑥ 条、§15 F44 跟着改。

**动作键**：不变。一份结果仍然只对应一个动作键 —— 本条要修的正是"同一个键对应两份结果"。

**恢复路径**：无需恢复。三列一律从 `execution_context` 逐字复制（EC6-a / EC6-d），因此写不出第二份；写歪在语句上得到 `EXECUTION_SNAPSHOT_MISMATCH`、在提交点得到 `EXECUTION_RESULT_MISMATCH`，两者都是有类型的拒绝，不是 500。

**可执行断言**：`PC-CX-44 the create-frozen set is the whole PAC table, proved at insert and at commit`（模型，清单由 PAC §6 的表反推）+ `PC-CX-44 on real Postgres: the whole PAC create-frozen set is proved at insert and at commit`（真实 PostgreSQL，含 v1.7 反向对照）。

### 26.3 `PC-CX-45` 一条 UPDATE 让三条硬门一起退出并释放唯一 claim

**最小交错序列**（三个事务）：① 合法提交 Task `t1` 的 live COORDINATOR 占位 `s1`（动作 `a1` 为 `APPLIED`、`result_session_id = 's1'`）；② 一条单独的 `UPDATE session SET task_id = NULL, dispatch_origin = 'USER', project_action_id = NULL, provider = 'codex', permission_mode = 'danger-full-access' WHERE id = 's1'` —— D9 / D14 / D15 按 NEW 全部提前返回，`session_action_only_for_coordinator_chk` 因为 `project_action_id` 也为 NULL 而成立，提交成功；③ 同一个 Task 合法提交第二条 live Session `s2`。**最终状态**：`{live_rows: 2, task_claims: 1, orphaned_actions: 1}`，`a1` 仍是 `APPLIED` 且 `result_session_id = 's1'`，而 `s1` 已经不再反向指向 `a1`。

**Postgres MVCC 与锁语义**：这一项**确实**涉及索引语义，但不涉及竞争。`session_task_execution_claim_idx` 是一条 partial unique index，第 ② 步把 `task_id` 写成 NULL 之后这一行不再落在索引谓词里，**索引条目被删除** —— 因此第 ③ 步的插入不会阻塞、也不会冲突，它拿到的是一把空的锁。索引能看见的只有谓词列**现在的值**；"这一行为什么离开覆盖集""它代表的那次执行是不是还活着"都不在它的可见范围内。

**为什么 v1.7 的绿色套件没抓到**：D5 的研发测试逐字覆盖了"两个事务并发插入同一个 `task_id`"，**没有一条覆盖"已经在索引里的那一行被 UPDATE 出去"**。D9 / D14 / D15 的测试则一律用 `INSERT` 触发，而 `INSERT` 上 OLD 不存在，NEW-only 的作用域谓词在那里是**对的** —— 缺陷只在 `UPDATE` 上可见，而三条硬门的 mutation 测试都只改它们各自声明的那几列，没有一条去改**决定作用域的那两列**。

**权威状态**：§7.7 D9 / D14 / D15 的作用域在 `UPDATE` 上一律读 **OLD ∨ NEW**（只有两侧都不是 COORDINATOR 占位才返回）；D15 的 `UPDATE` 分支把 `task_id` / `dispatch_origin` / `project_action_id` 三列纳入冻结集，新增 D15-a 改述与 D15-f 说明这三列各是哪三处谓词的输入；§4.3 新增 I17-A3 与它的零行查询形式。§12.1 G5 第 ⑦ 条、§15 F45 跟着改。

**动作键**：不变。本条修的是"两个各自唯一的动作键对应两条同时 live 的物理执行"，键本身从来没有重复。

**恢复路径**：无需恢复。自我豁免的那条 UPDATE 被 `EXECUTION_SNAPSHOT_FROZEN` 拒绝；释放 claim 只剩改 `status` 一条路（跑完 / 失败 / 取消 / 按 §11.2 停在 `AWAITING_INPUT`），第二条 live Session 照常在 D5 索引上得到 §7.7 D5 那张表里三个确定结果之一。

**可执行断言**：`PC-CX-45 a session cannot write itself out of the gates that hold its claim`（模型）+ `PC-CX-45 on real Postgres: the D5 predicate columns cannot be rewritten out of the index`（真实 PostgreSQL，含 v1.7 反向对照）。

### 26.4 `PC-CX-46` 一条双向命题只有一侧有对象在看

**最小交错序列**（正常生命周期，无并发）：create 得到 `execution_pin_generation = 0`；首次 claim 写 `model = 'model-v1'` 并置代次 1；一次 `retiredPin` 写 `model = 'model-v2'` 并置代次 2；**全程不写动作行的 `detail`**。**两次 UPDATE 都提交**：观察为 `{execution_pin_generation: '2', retired_count: '0'}` —— 代次声称发生过一次替换，审计账本声称零次，而 I17-A2 逐字要求这两个数字一一对应。

**Postgres MVCC 与锁语义**：两条 `UPDATE` 落在**两张表**上，因此单靠任何一张表上的 `BEFORE` 触发器都判不了 —— 它看不见另一张表在本事务里的最终状态，也不能要求两条语句的先后顺序。这正是本条必须用**可延迟**约束触发器的理由，与 D9-b 逐字同型：可延迟让判据落在 `COMMIT` 那一刻的最终状态上，于是"先写 Session 还是先写 detail"不再影响结论。并发的 `retiredPin` 与 claim 由代次那条 `+1` 规则（D15）串起来：两个事务都想把代次从 1 推到 2 时，后提交的那个读到的 OLD 已经是 2，`NEW <> OLD + 1` 直接被拒。

**为什么 v1.7 的绿色套件没抓到**：D15-e 的第三阶段**先手写了一条 `UPDATE project_action SET detail = '{"retiredPins":[…]}'`，再改 Session**。测试因此演了一遍正确行为，但被测对象从头到尾没有读过 `detail` —— **测试证明的是"按正确顺序做事会得到正确结果"，不是"做错会被拒绝"**。这是本轮四项里唯一一个"绿色套件演示了合法路径而没有反例"的形状，也是 D16-e 把九个反例逐条写下来的原因。

**权威状态**：§7.7 **新增 D16**，两条可延迟约束触发器分管两个方向 —— Session 侧（`session_execution_result_check`）在代次变化时要求动作行的账本长度恰好是 `generation − 1` 且首次 claim 有 `claimResolution`，动作侧（`project_action_pin_ledger_check`）在 `detail` 被改时要求它与 Session 的当前代次一致；D16-a 说明为什么必须是两个对象、D16-b 说明它让 I17-A2 由构造成立、D16-c 写下不带 `UPDATE OF` 列清单的代价与理由。§4.3 I17-A2 加上"这句话现在有一个数据库可执行的形式"。§12.1 G5 第 ⑧ 条、§15 F46 跟着改。

**动作键**：不变。代次落在 Session 上、账本落在 `detail` 上，两者都不进 `idempotency_key`，也不进两个摘要（`detail` 是 D11-b 的可写列，正因为它不进任何谓词）。

**恢复路径**：无需恢复。首次 claim 与 `retiredPin` 都是 PAC §6 允许的合法动作，它们只需要与账本写在同一个事务里；缺账、多账、错代次在 `COMMIT` 得到 `EXECUTION_PIN_LEDGER`，是有类型、可重试的拒绝。

**可执行断言**：`PC-CX-46 the pin generation and the action ledger are one atomic two-way relation`（模型）+ `PC-CX-46 on real Postgres: the pin ledger is proved in both directions at commit`（真实 PostgreSQL，含 v1.7 反向对照）。

### 26.5 本次修订**没有**做的事

- **没有把 EC2-b 的摘要计算交给数据库**（D14-g 逐字保留）。D16 比的是**结果列本身**，不是 `execution_result_digest` 这个标签 —— 比列不需要在 SQL 里复制一遍规范序列化，比标签需要。代价是：一条 `execution_result_digest` 与它自己的 `execution_context` 对不上的动作行，仍然只由 I17-A 的审计查询发现，而不是被拒绝。**这是有意的取舍**：那个标签不进任何硬门的谓词，而**进谓词的每一列现在都在插入点与提交点各被证明了一次**；要让数据库也算这个摘要，就得把 PAC §7.5 的 `resolution` 规范序列化搬进 SQL，D14-c 那笔账会翻倍。将来若审计侧真的需要，退路是把两个摘要改成由数据库派生的列，而不是再加一条比较。**（v1.9 已取代，见 §27.2 / §7.7 D17。）这一条算错了一样东西**：重算一个摘要**不是**重跑一遍解析链 —— 摘要的权威输入就在同一行上，规范化只需要一个 `IMMUTABLE` 的 jsonb 序列化函数，D14-c 那笔账并不会翻倍。而"这个标签不进任何硬门的谓词"恰恰是问题本身：§4.3 I17-A 同时宣称它恒成立且对任何二进制成立，一条被这样宣称、却没有任何对象在看的命题就是 `PC-CX-48`。
- **没有禁止 COORDINATOR 占位离开 D5 的占位集合**。`AWAITING_INPUT` / `INTERRUPTED` 本来就在占位集合之外（§7.7 D5 的注释逐字不变），那是既有 resume 路径的形状。v1.8 只禁止**在不改 `status` 的前提下**把行写出索引覆盖集。
- **没有给 `session` 的 `status` 加转移表**。`PC-CX-45` 的修法是冻结 lineage，不是给 Session 状态机再加一层 —— 后者会与 PAC §6 / §11 已经冻结的既有生命周期正面冲突，而本条要的性质（claim 不能被静默释放）冻结 lineage 就已经够了。
- **`detail` 仍然是 D11-b 的可写列**。D16 约束的是它的**内容与代次一致**，不是它不可写；`claimResolution` 与展示用的补写照常（EC6-c）。**（v1.9 收紧，见 §27.1 / §27.3："内容与代次一致"当时只兑现到"条数一致"，`claimResolution = {}` 与 `retiredPins = [{}]` 满足它。）**
- **02 在 v1.7 轮留下的 `coordinator-v17-adversarial.spec.ts` 被翻转，不是被删**。理由与 §22.9 / §23.5 / §24.6 / §25.7 逐字相同：一条"缺陷存在"的断言在缺陷被修好的那一刻必然变红。翻转后每条断言**同时保留 v1.7 的形状作为反向对照**。


---

## 27. `PC-CX-47..49` 修订闭环（v1.9）

> **本节是非规范的（non-normative）修订日志**（§0 RL1，v1.4 冻结、v1.8 扩到 §26、v1.9 扩到本节）。它记录 v1.9 当时的事实与当时的推理，**不是现行规范**；任何一句与 §1–§18 冲突时一律以 §1–§18 为准。历史形状只允许出现在这里和反例测试里（`PC-CX-27`）。

02 对 v1.8 的独立复审（[`project-coordinator-contract-review-02-v1.8.md`](./project-coordinator-contract-review-02-v1.8.md)）判 **FAIL / BLOCKED**，给出 3 个 P1。本节是**逐项关闭的索引**，格式与 §19–§26 相同。**九份审查文档都不因本次修订而改动** —— 它们记录的是 v1 到 v1.8 的事实，那些事实没有变；变的是契约。

三项有一条贯穿的线，而且它是本文**第一次**被这样问到：前八轮问的都是"这条硬门什么时候执行、作用域由谁决定、它比的那张清单全不全"，这一轮问的是 —— **它比完之后，它到底证明了什么**。

- `PC-CX-47`：D16 对首次 claim 只问"有没有 `claimResolution`"。一个空对象满足它，于是一条冻结成 `model-v1` / `high` 的决策可以合法地配上一条实际跑 `model-evil` / `low` 的 Session。**I17-A2 那一行说的是"逐字相同"，而 D16 查的是"非 NULL"。**
- `PC-CX-48`：I17-A 逐字宣称两个摘要与重算相等、且这条性质由 D15 + D16 对任何二进制成立；§26.5 在同一份文档里承认伪造的 `execution_result_digest` 可以提交、只由审计查询发现。**一条被宣称恒成立、而没有任何数据库对象在看的命题，与一条没写下来的命题在数据库里是同一个东西。**
- `PC-CX-49`：账本的两条规则只数了条数。`generation = 2` + `claimResolution = {}` + `retiredPins = [{}]` 通过全部硬门，而那本账说不出被换掉的是什么、换成了什么、什么时候、为什么。**数了条数不等于记了账。**

三句话是同一句话的三种写法：**一条只验证"有"的硬门，证明不了"对"。** v1.9 的答案在三处：**EC6-c / EC6-e 给两本账一个闭合的语义形状与一条能折叠回 Session 此刻那对 pin 的链**、**D16 把这次判定收进一个两侧共用的 ⓪ 号函数 `coordinator_pin_ledger_fold`**、以及**新增 D17：`canonical` 从一个记号变成一个 `IMMUTABLE` 的数据库函数，两个摘要在 `COMMIT` 各按 EC2-d 的权威输入重算一次**。

| ID | 级别 | 规范条款 | 权威状态 | 动作键 | 恢复路径 | 可执行断言 |
|---|---|---|---|---|---|---|
| `PC-CX-47` | P1 | §4.3 I17-A2 · §7.4 EC2-b · EC6-c · EC6-e · §7.7 D16 · D16-b · D16-e · D16-f · §12.1 G5 · §15 F47 · §22.8 | 首次 claim 的那一对实际 pin 由**动作行冻结的结论**唯一决定：冻结分量是具体值 ⇒ `session.model` / `session.effort` 与它逐字相同；冻结分量是 `DEFERRED_TO_CLAIM` ⇒ 实际解析到的值必须与那次 claim 写在**同一事务**里（`claimResolution.<component>.value`，`source = 'RESOLVED_AT_CLAIM'`），并逐字等于 Session 上那一列 | 不变（claim 与账本都不进动作键；它们记的是这个键的那一次执行取到了什么） | 无需恢复：合法的首次 claim 照常提交，它只需把"实际取到了什么"与代次写在同一个事务里。真的解析到了另一个模型 ⇒ 那不是一次 claim，是一次新的决策，按 §7.4 EC3 的 `EXECUTION_RESULT_CHANGED` 走 | `PC-CX-47 the first claim can only pin what the action froze, or what it atomically recorded` |
| `PC-CX-48` | P1 | §4.3 I17-A · §7.4 EC2-a · EC2-b · EC2-d · §7.7 D14-a · D14-h · D17 · D17-a · D17-b · §12.1 G5 · §15 F48 · §22.8 | 两个摘要各等于 `coordinator_execution_digest` 对**自己那一半**权威输入的重算值（EC2-d：`authorization` 与 `execution_context - 'authorization'` 互不相交、合起来就是它自己），且两半共享的分量一致 | 不变（摘要不进任何键；它是被比较的那个值，不是身份） | 无需恢复：两个摘要必须在插 `CLAIMED` 那一步由同一个函数算出来；伪造在 `COMMIT` 得到 `EXECUTION_DIGEST_MISMATCH`，是一条有类型的拒绝 | `PC-CX-48 both digests are recomputed at commit, not merely frozen` |
| `PC-CX-49` | P1 | §4.3 I17-A2 · §7.4 EC6-c · EC6-e · §7.7 D16 · D16-b · D16-e · D16-f · §12.1 G5 · §15 F49 · §22.8 | `claimResolution` 与每一条 `retiredPins[]` 各有一张**闭合**的键表（四键 / 三键 / 六键），含旧值、新值、时刻、来源或原因与代次；整条链按 EC6-e 折叠出来的那一对值逐字等于 `session.model` / `session.effort` | 不变（代次与账本都不进动作键） | 无需恢复：一次合法的 `retiredPin` 本来就知道自己换掉了什么、换成了什么、什么时候、为什么，把它们写下来就是这条记录；空对象、缺字段、多账、错链、错代次、时刻倒流都得到 `EXECUTION_PIN_LEDGER` | `PC-CX-49 the pin ledger has a closed shape and a chain that folds back to the session` |

新增的模型断言在 [`coordinator-counterexample.spec.ts`](../src/apiserver/src/projects/coordinator-counterexample.spec.ts)，新增的真实 PostgreSQL 断言在 [`coordinator-linearization.pg.spec.ts`](../src/apiserver/src/projects/coordinator-linearization.pg.spec.ts)；02 在 v1.8 轮次留下的 [`coordinator-v18-adversarial.spec.ts`](../src/apiserver/src/projects/coordinator-v18-adversarial.spec.ts) 按 §26 对 v1.7 那份 spec 的同一条纪律**从"证明缺陷存在"翻转成"旧形状被拒绝/得到唯一合法结果"**，并把 v1.8 的失败形状原样保留为每条断言里的**反向对照**。

### 27.1 `PC-CX-47` 一条只查"非 NULL"的硬门，证明不了"逐字相同"

**最小交错序列**（一个事务，一条语句，外加一条账本写入）：动作行冻结 `execution_context.model = 'model-v1'`、`effort = 'high'` 并已 `APPLIED`，Session 是它逐字匹配的占位（`model IS NULL`、`effort IS NULL`、代次 0）。随后 `UPDATE session SET model = 'model-evil', effort = 'low', execution_pin_generation = 1` 与 `UPDATE project_action SET detail = detail || '{"claimResolution": {}}'`。**v1.8 下事务提交成功**：D15 只看到"改了 model/effort ⇒ 代次恰好 +1"，D16 只看到"代次 ≥ 1 ⇒ `claimResolution IS NOT NULL` ∧ `retiredPins` 恰好 0 条"，两条都成立。已提交状态因此是 `{frozen: model-v1/high, actual: model-evil/low, claimResolution: {}}` —— 而 I17-A2 代次 1 那一行逐字要求 "Session 上的值与它逐字相同"。

**Postgres MVCC 与锁语义**：与并发无关，一个事务就够。两条硬门都执行了、都返回了成功 —— 它们查的谓词为真，只是那个谓词不是那句话。**这是 §26 那句"一个执行了但主动放行的硬门等于一个不存在的硬门"的第二种写法**：这一次它没有放行，它只是量错了。

**权威状态**：§4.3 I17-A2 的代次 1 行（v1.9 重写：两支各只有一种合法组合）、§7.4 EC6-c（`execution_context.model` / `effort` 必填，取值是具体值或 `DEFERRED_TO_CLAIM`；`claimResolution.<component>` 恰好 `{frozen, value, source}` 三键，`frozen` 逐字等于冻结分量）、EC6-e（两个 `value` 是链的起点，折叠结果逐字等于 Session 那两列）。数据库侧是 §7.7 D16 的 ⓪ 号函数，Session 侧与动作侧各调用一次。**为什么起点不能是冻结上下文本身**：`DEFERRED_TO_CLAIM` 那一支的实际值只有那次 claim 知道；而 `frozen` 必须逐字回指冻结分量这一条，又把这个起点钉回那次决策，因此两支都不留活口。

**动作键**：不变。`claimResolution` 与 `retiredPins[]` 都不进任何幂等键 —— 它们记的是"这个键的那一次执行实际取到了什么"，不是"这是哪一次执行"（§8.2 GE3 的同一条纪律：摘要与账本不承担身份）。

**恢复路径**：无需恢复。合法的首次 claim 照常提交：把实际取到的那一对值写进 `detail.claimResolution` 并把代次置 1，两条 `UPDATE` 在同一事务里，先写哪一张表都可以（D16-a 的可延迟）。**如果那次 claim 真的解析到了另一个模型**，那不是一次 claim 而是一次新的决策：按 §7.4 EC3 得到 `EXECUTION_RESULT_CHANGED`、不开 blocker、`dispatch_attempt` +1、下一次 reconcile 用新的键重派（EC5-a）。

**可执行断言**：`PC-CX-47 the first claim can only pin what the action froze, or what it atomically recorded`（模型），`PC-CX-47 on real Postgres: the first claim is bound to the frozen conclusion field by field`（真实 PostgreSQL：concrete 与 deferred 两支的正例各提交一次，`model-evil` 的那次提交被 `EXECUTION_PIN_LEDGER` 拒；反向对照用 v1.8 的 D16 把同一份写入提交进去）。

### 27.2 `PC-CX-48` 一个被宣称恒成立、却没有对象在看的等式

**最小交错序列**（一个事务，三条语句）：插一条 `status = 'CLAIMED'` 的 `DISPATCH_TASK`，`execution_context` 内容完全正确，`execution_result_digest = 'forged-result-digest'`；插一条与它逐字匹配的 COORDINATOR 占位；`UPDATE ... SET status = 'APPLIED', result_session_id = 's1'`。**v1.8 下事务提交成功**：D14 比的是 EC2-a（授权摘要，D14-g），D15 / D16 比的是**结果列本身**，没有任何一条读过 `execution_result_digest`；D11 此后忠实地把这个伪造值钉成不可改写。I17-A 的零行查询返回 1 行，而 §26.5 逐字承认这是"有意的取舍"。

**Postgres MVCC 与锁语义**：与并发无关。这一项的答案里有一半是**成本核算**：v1.8 拒绝重算摘要的理由是"要把 PAC §7.5 的 `resolution` 规范序列化搬进 SQL，D14-c 那笔账会翻倍"。那笔账算错了对象 —— 重算一个摘要不需要**重解析**它的输入，因为输入就在同一行上（EC2-d）。它需要的只是一个确定的序列化：`coordinator_canonical_json` 是 `IMMUTABLE` 的、不取任何锁、不读任何别的行，因此它对任何版本的二进制成立，代价是每次派发两次 `sha256`（D17-c）。v1.5–v1.8 的公式 `sha256(canonical(resolvedAgentId ‖ projectMemberId ‖ taskId ‖ …))` 与 `sha256(canonical(executionContext))` 都不是可执行的定义：前者没说分隔与转义，后者没说键序 —— **一个只有写它的那个二进制算得出来的摘要，不是一条等式，是一个标签。**

**权威状态**：§7.4 EC2-a（`sha256(canonical(executionContext.authorization))`，九个键的封闭对象）、EC2-b（`canonical(executionContext - 'authorization')`）、EC2-d（两半互不相交、合起来就是 `execution_context` 自己；共享分量必须一致）、§7.7 D17（提交点重算）、D14-h（D14 与 D17 各证明什么）。§4.3 I17-A 的摘要那一半第一次有对象在看。

**动作键**：不变。摘要是被比较的那个值，不是身份 —— 它不进 `idempotency_key`、不进任何代次（§8.2 GE3）。

**恢复路径**：无需恢复。两个摘要必须在插 `CLAIMED` 那一步就由 `coordinator_execution_digest` 算出来；写歪在 `COMMIT` 得到 `EXECUTION_DIGEST_MISMATCH`，错误消息指明是哪一半对不上。**它是 fail closed 的**：与 D14-c 选定的方向逐字相同，序列化改一次而写端没跟上，表现为"派发全部被拒"，不是"摘要静默漂移"。

**可执行断言**：`PC-CX-48 both digests are recomputed at commit, not merely frozen`（模型），`PC-CX-48 on real Postgres: a forged digest cannot be committed, and canonicalisation ignores key order`（真实 PostgreSQL：键序不同的同一份上下文得到同一个摘要；伪造两个摘要各得一次 `EXECUTION_DIGEST_MISMATCH`；反向对照是把这条约束触发器去掉，同一份写入立刻提交进去）。

### 27.3 `PC-CX-49` 数了条数不等于记了账

**最小交错序列**（两个事务）：正常派发之后，第一个事务写 `claimResolution = {}` 并把代次置 1；第二个事务把代次置 2 并追加 `retiredPins = [{}]`。**v1.8 下两个事务都提交成功**：两条 D16 函数查的是"`claimResolution IS NOT NULL`"与"`jsonb_array_length(ledger) = generation - 1`"，两者都为真。已提交状态是 `{execution_pin_generation: 2, claimResolution: {}, retiredPins: [{}]}` —— 而 I17-A2 逐字要求每条记录"每条含被换掉的值、换成的值与时刻"，D16-b 当时把"代次 1 ⇒ 有 claimResolution、retiredPins 恰好 0 条"当成了整条 I17-A2 由构造成立。

**Postgres MVCC 与锁语义**：与并发无关，但**两个方向仍然必须是两个对象**（D16-a 逐字不变）：一次 `retiredPin` 是两张表上的两条 `UPDATE`，只装一侧的那一半可以被单方面写。v1.9 改的不是对象个数，是那次判定的内容 —— 并且把它收进**一个**函数，两条触发器各调用一次（D16-f）。**两份手写副本会分头长大**，那正是 `PC-CX-37` / `PC-CX-44` 连着两轮的形状，这一次它还会让两侧对同一句话有两套标准。

**权威状态**：§7.4 EC6-c 的四张闭合键表（`execution_context` 的两个 claim 冻结分量 / `claimResolution` 四键 / `claimResolution.<component>` 三键 / `retiredPins[k]` 六键）与 EC6-e（链、代次、单调时刻、折叠回 Session 此刻那一对 pin）；§4.3 I17-A2 的三行按同一套形状重写；数据库侧是 §7.7 D16 的 ⓪ 号 `coordinator_pin_ledger_fold`。**`reason` 是一个恰好一个成员的封闭集合**，因为 PAC §6 只保留了一个合法例外；PAC 多留一个，这里才多一个成员 —— 与 EC2-b 那句"这张清单由 PAC 的表反推，不是手写的"是同一条纪律。

**动作键**：不变。代次与账本都不进动作键；`session.execution_pin_generation` 照旧只增不减（§8.2 GE1），账本条数由它唯一决定。

**恢复路径**：无需恢复。一次合法的 `retiredPin` 本来就知道自己换掉了什么、换成了什么、什么时候、为什么 —— 把这四样连同 `component` 与 `generation` 写下来就是这条记录，与代次 +1 在同一事务里提交。空对象、缺字段、多账、缺账、错链、错代次、时刻倒流都在 `COMMIT` 得到 `EXECUTION_PIN_LEDGER`，是有类型、可重试的拒绝。

**可执行断言**：`PC-CX-49 the pin ledger has a closed shape and a chain that folds back to the session`（模型），`PC-CX-49 on real Postgres: an empty ledger record is refused and a legal retiredPin still commits`（真实 PostgreSQL：合法的首次 claim 与 `retiredPin` 各提交一次，八个反例逐个被拒；反向对照用 v1.8 的两条 cardinality 函数把 `{}` / `[{}]` 提交进去）。

### 27.4 本次修订**没有**做的事

- **没有把 PAC 的解析链搬进数据库**。D14-c / D14-g 逐字保留：D14 仍然是本文对 PAC 唯一的"在数据库里再实现一次"，D17 只重算摘要、不重解析输入（D17-b）。**这一条与 §26.5 的区别要写清楚**：v1.8 拒绝的是"把 `resolution` 的规范序列化搬进 SQL"，而 v1.9 做的恰好是这件事的**一个便宜得多的版本** —— 一个通用的 jsonb 规范化函数，它不认识 `resolution` 的任何一个字段，因此 PAC 改了它一个字也不用动。
- **没有给 `execution_context` 定义一张顶层键的封闭清单**。EC2-d 用"减去一个键"表达两半的划分，因此多一个键只会改变结果摘要，而不会让一张手写清单与它保护的东西分头长大（`PC-CX-37` / `PC-CX-44` 的形状）。**只有 `authorization` 的九个键是封闭枚举的**，因为那正是 EC2-a 的分量表，D14 的解析器本来就必须产出它。
- **没有加新列**。§2.4 的八列一个不变：`authorization` 是 `execution_context` 里的一个键，`claimResolution` / `retiredPins[]` 是 `detail` 里的两个键，三者都落在 v1.5 / v1.7 已经加过的那两列上。
- **没有给 `retiredPin` 加新的合法理由**。`reason` 今天恰好一个成员（`RUNTIME_RETIRED`），这是 PAC §6 那一行的如实转写；本文**不**代 PAC 扩它。
- **没有改任何一份独立审查报告**。九份文档逐字不变（§26 的同一条纪律）。
- **02 在 v1.8 轮留下的 `coordinator-v18-adversarial.spec.ts` 被翻转，不是被删**。理由与 §22.9 / §23.5 / §24.6 / §25.7 / §26.5 逐字相同：一条"缺陷存在"的断言在缺陷被修好的那一刻必然变红。翻转后每条断言**同时保留 v1.8 的形状作为反向对照**。
