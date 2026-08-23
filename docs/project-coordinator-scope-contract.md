# Coordinator 写入作用域与跨项目归属契约 v1.0

> **状态**：已冻结（frozen）。本文是 L 单元（L1–L7）的单一权威契约。
> 实现与本文冲突时，先改本文并说明理由，再改代码。
>
> **落点**：`src/apiserver/src/projects/project-scope-contract.ts`（词汇表与四张冻结表）与
> `project-scope-decision.ts`（§4 的判定函数）。两个模块都是纯函数：不读时钟、不碰数据库、
> 不 import 服务层，因此规则可以在**任何东西执行它之前**就被当作规则来测。
> 执行（服务端强制）是 L3 的事，本单元不接线、不加表、不加列。
>
> **上位契约**：`project-agent-contract.md`（PAC）与 `project-coordinator-contract.md`（PCC）。
> 本文只补它们没有回答的一个问题，不改写它们已经回答的任何一个。

---

## 0. 本文要解决的问题

一次 Coordinator Session 把一批 Task 建进了**不是它协调的那个 Project**。没有任何东西拒绝它。

`TasksService.assertOwnedProject` 只问一个问题——**这个 owner 拥有那个 Project 吗**。
owner 拥有他自己的每一个 Project，所以"协调 A 的会话往 B 里写"与"用户自己往 B 里写"
在服务端是同一件事，两者都合法，事后也分不出来。

PAC §8.2 ⚠a 其实已经写了这条规则：Coordinator "只能在**自己所属的那个 Project** 内建"。
它是一句散文：**没有码可拒、没有状态可落、没有人被指名去修**。散文不是门禁。

本文把那句散文变成：**10 条不变量（§3）· 15 条有序判定规则（§4）· 9 个错误码（§5）·
一张 7 状态 × 10 事件的转移表（§6）· 一张责任边界表（§7）· 一张兼容矩阵（§8）·
一张到项目 12 条验收标准的映射（§9）**。每一张都在代码里有对应的冻结常量，
每一条都被 `project-scope-contract.spec.ts` / `project-scope-decision.spec.ts` 逐格钉住。

## 1. 边界：本文管什么，不管什么

| 已有条款 | 它回答的问题 | 本文的关系 |
|---|---|---|
| PAC §8.2 ⚠a | Coordinator 只能在自己的 Project 内建任务 | 本文是它的**可执行形式**：码、转移、责任人 |
| PAC §12 | 派发/写入路径的错误码表 | 本文新增 4 个码、复用 5 个码；E2（不得同义）由 §5 逐条说明 |
| PCC §13.4 AE10 | 跨 Project 移动怎么**加锁**、为什么要**两次重开** | 本文决定**谁可以提出**这次移动；AE10 决定它**怎么落地**。互不覆盖 |
| PCC §13.4 AE8 | 终态项目里的事实变化 ⇒ 原子重开 | 本文只拦**新写入**；已归属 Task 的状态变化照旧走 AE8，一个字不改 |
| PCC §7.7 D10 / F29 | 持有派发占位的 Task 不得跨 Project 移动（`TASK_CLAIMED_PROJECT_MOVE`） | 那是**提交时**关于任务运行态的机械拒绝；本文是**准入时**关于写入者权限的拒绝。被本文拒的写入根本走不到 D10 |
| PCC §11 | 结构化 blocker 的封闭 kind 集合 | 本文**不新增 kind**，只声明每个码落到哪一个既有 kind（§5） |
| PCC §9.3 | 永不代劳 | 跨项目移交的批准人是**用户**，不是目标 Project 的 Coordinator（§7） |

**不在本文范围内**：控制环自身的维护性写入（聚合写入器、reaper、验收记录器）。
它们不产生新的归属主张，因此不构成本文意义上的"写入面"。

## 2. 词汇表

每个术语在此有且仅有一个定义。

| 术语 | 定义 | 存在于哪里 |
|---|---|---|
| **coordinatorProjectId** | 一个 Coordinator Session **当下**协调的那个 Project。服务端从会话行派生，**永远不接受客户端上报** | `project.coordinator_session_id` 的反向查找（既有列） |
| **coordinatorGeneration** | 该 Project 的协调代次。单调、永不复用、只由一次轮换推进 | `project_runtime.coordinator_generation`（既有列） |
| **scopeToken** | 上面两者的**线上形式**：`psc:v1:<projectId>:<generation>` | 派生值，`projectScopeToken()` |
| **权威归属** | 这份工作**算在哪个目标名下**。唯一权威列是 `task.project_id` | 既有列 |
| **发现来源** | 这份工作**是在哪里被注意到的**：`discoveredFromProjectId` · `triggerEvent` · `sourceTaskId` · `sourceSessionId` | 证据，L2 负责持久化 |
| **crossing（跨越）** | 一次写入的两端不同：`from = 当前归属 ?? 写入者作用域`，`to = 目标归属` | §4 的派生量 |
| **declared handoff（声明的移交）** | 写入者用 `HANDOFF_TASK` **明说**自己在跨越 | `SCOPE_OPERATIONS` |
| **写入面** | 会改变"这份工作算在哪个目标名下"的三种写入：`CREATE_TASK` · `UPDATE_TASK` · `HANDOFF_TASK` | 封闭集合 |

**关于 scopeToken 的三句话**（SC3）：它是**派生值不是凭证**——不含密钥，客户端也能算出来，
所以它**不授予**任何权限；服务端**永远重新派生**并只做比较；它存在的理由是
（i）一个不透明字段不会"只到一半"（一个与代次不匹配的 projectId 在结构上不可表示），
（ii）每一次写入因此带着**它是在哪一次协调作用域下被写下的**，这才让事后审计是一次比较而不是一次考古。

## 3. 不变量

| 编号 | 不变量 | 违反它会发生什么 |
|---|---|---|
| **SC1** | 一个 Coordinator Session 的写入作用域**恰好是一个 Project**，由服务端从会话行派生 | 就是 §0 的事故 |
| **SC2** | 作用域内的写入不需要任何额外授权；作用域外的写入**没有例外通道** | 有例外通道的边界不是边界 |
| **SC3** | scopeToken 是派生的、可重算的、**不被信任的**；它标识作用域，不授予作用域 | 客户端自称即授权 |
| **SC4** | 同一 scopeToken 下的**同一份写入重放一次仍是同一份**（幂等） | 崩溃恢复后重复建任务 |
| **SC5** | 改变归属的写入必须**被声明**（`HANDOFF_TASK`）；未声明的跨越一律拒绝 | 移交与越权在数据上不可区分 |
| **SC6** | `task.project_id` 是**唯一**权威归属列；调度、验收、活性、并发只读它 | 两个来源说两句话，验收数不清 |
| **SC7** | 发现来源是**证据**：创建时写、此后只读（改写、追补、**清空**一律拒绝），**任何门禁不得读它做授权判定** | "我发现了它" 悄悄变成 "我可以写这里" |
| **SC8** | 每一次拒绝都带**码 + 责任人 + requiredAction**；不得静默跳过 | 项目静默空转（AC3 明令禁止） |
| **SC9** | 接管**不回滚**任何已提交的写入，也**不清除**任何已登记的问题；它只终止**尚未写入**的那次尝试 | 每次轮换都悄悄丢掉上一代提出的问题 |
| **SC10** | 老客户端拿不到更大的权限：作用域一律服务端派生，**缺 token 不是授权** | 降级客户端成为绕过通道 |

### 3.1 SC7 的"只读"包含"不可清空"

证据能被**擦掉**，和证据能被**改写**是同一个问题：§0 的事故是有人让一行看起来与正常写入无从区分，
把来源清空同样做到了这一点。所以 SC7 拒绝三种改动——追补（NULL → 值）、改写（值 → 另一个值）、
**清空（值 → NULL）**。

三个 id 列有且只有一条合法的置空路径：它们指向的行被删除，外键的 `ON DELETE SET NULL` 以一次
UPDATE 的形式到达。这条路径**不靠约定、不靠标志位、不靠提示词**来与手工清空区分，而是把规则写成
它本来的意思——**只有当这一列所指的行已经不存在时，它才可以变空**。数据库对每一个写入者给出同样的
答案：外键动作运行时被指向的行已经消失，而人手动清空时它还在。任何没听说过这条规则的二进制、
迁移脚本或修复 SQL，得到的都是同一个判定。

`trigger_event` 没有外键，没有任何东西可被删除从而使它变空，因此它**没有合法的 NULL**：一经写入，
包括清空在内的任何改动一律拒绝。

一次被声明的移交（`HANDOFF_TASK`）改变 `task.project_id`，这四列纹丝不动——工作在哪里被发现，
不因它换了归属而改变。

## 4. 写入作用域判定（有序，先匹配先赢）

**顺序不是排版**。这条路径上经常同时有好几个谓词为真——一个失效的 Coordinator 往另一个项目的
已验收目标里写东西，同时满足四条。顺序规定了**该告诉它哪一件事**，它的走法是：
你是谁（R1）→ 你现在还握着作用域吗（R2 · R3 · R5）→ 这次写入指名了目标吗（R4）→
它留在作用域内吗（R6 · R7）→ 那个目标还开着吗（R8）→ 用户对这次跨越怎么说（R9–R13）。

**R8 刻意排在审批之上**：审批**永远不得**成为进入已验收项目的通道，
否则一个已 DONE 的项目会无声地长出新工作，而它的验收记录变成关于一个不复存在的世界的主张。

| 序号 | 谓词 | decision | code | requiredAction |
|---|---|---|---|---|
| `R1_USER_AUTHORITY` | `principal = USER` | ALLOW | — | — |
| `R2_TOKEN_INCONSISTENT` | 带了 token，且它与自己的 `(projectId, generation)` 对不上 | REFUSE | `PROJECT_SCOPE_MISMATCH` | `RE_DERIVE_SCOPE` |
| `R3_SCOPE_MOVED` | 带了作用域，且与服务端派生的不一致（**含派生为空**） | REFUSE | `COORDINATOR_GENERATION_MOVED` | `YIELD_TO_CURRENT_SCOPE` |
| `R4_NO_TARGET_PROJECT` | 这次写入不指名任何 Project | REFUSE | `UNMAPPED_PROJECT_WORK` | `NAME_OWNING_PROJECT` |
| `R5_NO_SCOPE` | 服务端派生不出作用域，且它也没自称过 | REFUSE | `PROJECT_SCOPE_MISMATCH` | `YIELD_TO_CURRENT_SCOPE` |
| `R6_OUT_OF_SCOPE` | 不是跨越，但落点不是自己的作用域 | REFUSE | `PROJECT_SCOPE_MISMATCH` | `FILE_IN_OWN_PROJECT_OR_REQUEST_HANDOFF` |
| `R7_UNDECLARED_CROSSING` | 是跨越，但没有声明为 `HANDOFF_TASK` | REFUSE | `PROJECT_SCOPE_MISMATCH` | `FILE_IN_OWN_PROJECT_OR_REQUEST_HANDOFF` |
| `R8_SETTLED_PROJECT` | 两端中任一端不是 `OPEN`（**读不到状态按非 OPEN 算**） | REFUSE | `PROJECT_REOPEN_REQUIRED` | `REOPEN_PROJECT_FIRST` |
| `R9_APPROVAL_TARGET_MISMATCH` | 有一份 `APPROVED`，但它说的是**另一次**移交 | REFUSE | `APPROVAL_TARGET_MISMATCH` | `FILE_IN_OWN_PROJECT_OR_REQUEST_HANDOFF` |
| `R10_NO_APPROVAL` | 跨越，且没有指名这次移交的审批 | REQUIRE_APPROVAL | `CROSS_PROJECT_APPROVAL_REQUIRED` | `AWAIT_HANDOFF_APPROVAL` |
| `R11_APPROVAL_PENDING` | 指名这次移交的审批还在等回答 | REQUIRE_APPROVAL | `APPROVAL_PENDING` | `AWAIT_HANDOFF_APPROVAL` |
| `R12_APPROVAL_DENIED` | 用户说了不 | REFUSE | `APPROVAL_DENIED` | `FILE_IN_OWN_PROJECT_OR_REQUEST_HANDOFF` |
| `R13_APPROVAL_EXPIRED` | 审批过期 | REFUSE | `APPROVAL_EXPIRED` | `AWAIT_HANDOFF_APPROVAL` |
| `R14_HANDOFF_APPROVED` | 声明了、对得上、答了是、两端都开着 | ALLOW | — | — |
| `R15_IN_SCOPE` | 其余：作用域内、目标开着 | ALLOW | — | — |

**R-a（总函数）**：`R15` 没有谓词，因此每个输入**恰好**落在一条规则上。
**R-b（`from` 的定义是刻意的）**：`from = 当前归属 ?? 写入者作用域`。
正因为如此，"在别的项目里建新任务" 与 "把已有任务移去别的项目" 是**同一种跨越、同一条规则**，
而不是两条各自演化的规则。
**R-c（声明才是区别）**：R7 与 R10 的输入可以完全一样，唯一的差别是写入者**说没说自己在跨越**。
这就是 `HANDOFF_TASK` 是一个**操作**而不是一个推断的原因——推断出来的声明可以被"碰巧"满足。
**R-d（fail closed）**：`world.projectStatus` 里读不到的项目按**非 OPEN** 处理，
与 `blockerKindForRefusal` 兜底到 `UNKNOWN_FAILURE` 是同一条原则：把"我没读到"当成"没问题"的门不是门。

## 5. 错误码（冻结）

| code | 决策 | 责任人 | blocker kind | 来源 |
|---|---|---|---|---|
| `PROJECT_SCOPE_MISMATCH` | REFUSE | COORDINATOR | — | 新增 |
| `UNMAPPED_PROJECT_WORK` | REFUSE | USER | `AWAITING_USER_INPUT` | 新增 |
| `CROSS_PROJECT_APPROVAL_REQUIRED` | REQUIRE_APPROVAL | USER | `AWAITING_USER_APPROVAL` | 新增 |
| `PROJECT_REOPEN_REQUIRED` | REFUSE | USER | `AWAITING_USER_APPROVAL` | 新增 |
| `COORDINATOR_GENERATION_MOVED` | REFUSE | SYSTEM | — | 复用 `project-coordinator-turn.service.ts` |
| `APPROVAL_PENDING` | REQUIRE_APPROVAL | USER | `AWAITING_USER_APPROVAL` | 复用 `project-authorization.service.ts` |
| `APPROVAL_DENIED` | REFUSE | COORDINATOR | — | 复用 `project-authorization.service.ts` |
| `APPROVAL_EXPIRED` | REFUSE | USER | — | 复用 `project-authorization.service.ts` |
| `APPROVAL_TARGET_MISMATCH` | REFUSE | COORDINATOR | — | 复用 `project-authorization.service.ts` |

**EC1（只新增 4 个码）**：PAC §12 E2 禁止与既有码同义。接管的答案是既有的
`COORDINATOR_GENERATION_MOVED`——协调轮换执行器早就在代次移动时用它拒绝，并且早就把它当作
**可重试**而不是 blocker；一次写入来自被轮换掉的作用域，说的是同一个计数器的同一件事，
因此用同一个名字。审批的四个状态是既有 `ProjectAuthorizationReasonCode` 的成员，
在 `project-blocker.ts` 里也已经分好类，本文不发明第五种说"这不是一个是"的方式。

**EC2（谓词两两互斥或由 §4 的顺序消歧）**：R6 与 R7 的谓词互斥（`crossing` 的两侧）；
R9 与 R10 由"这份 `APPROVED` 说的是不是这次移交"分开；其余全部由 §4 的先匹配先赢定序。
**同一个输入只有一个码**，这是 `project-scope-decision.spec.ts` 直接测的东西。

**EC3（`requiredAction` 挂在规则上，不挂在码上）**：一个码回答不止一条规则。
因 token 没验上被拒的写入应当**重算作用域再试**，因指向别人的项目被拒的应当
**回自己项目落地或去申请**——下一步取决于**是哪条规则拒的**，不取决于拒绝叫什么名字。
把它挂在码上，就必然有一类写入被给出一条它执行不了的建议。

**EC4（不新增 blocker kind）**：本文用到的每一个 kind 都是 `PROJECT_BLOCKER_KINDS` 的既有成员。
理由不是节制：封闭集合之外的 kind 会被数据库的 `project_blocker_kind_chk` 拒绝，
也就是说**那条拒绝本身会写不进去**——一个写不进去的拒绝码等于一次静默跳过。

**EC5（`PROJECT_SCOPE_MISMATCH` 刻意不落 blocker）**：它是 Coordinator 自己就能修的那一类
（回自己项目落地，或声明跨越去申请），落一条 blocker 等于去问一个没有东西可决定的人。
一个反复越界的 Coordinator 是一个**没有进展**的 Coordinator，那已经是 K 单元熔断器的事；
在这里再给它一个形状不同的告警，等于把同一个状况数两遍。

**EC6（L3 的义务）**：L3 把这 4 个新码加进 `ProjectAuthorizationReasonCode` 时，
**必须**同时按本表把它们分类进 `PROJECT_BLOCKER_REFUSAL_KINDS` 或
`PROJECT_BLOCKER_NON_BLOCKING_REFUSALS`。这不是提醒——`project-blocker.spec.ts` 的
"BL2: every refusal code the resolution chain can emit is classified exactly once"
会在漏掉时直接变红；漏掉的运行时后果是这些拒绝一律兜底成 `UNKNOWN_FAILURE`，
把项目的自动派发停掉。

## 6. 一份被发现的工作：状态与转移

### 6.1 状态

| 状态 | 含义 |
|---|---|
| `DISCOVERED` | 注意到了这份工作，还没有任何东西被写下 |
| `FILED` | Task 存在，且归属某个 Project（正常终点） |
| `UNMAPPED` | 说不清归谁，已登记为一个待人回答的问题 |
| `HANDOFF_REQUESTED` | 声明了跨越，等审批 |
| `HANDOFF_APPROVED` | 批准了，尚未落地（批准与落地是两次事务） |
| `REOPEN_REQUIRED` | 落点已验收完成，得先重开 |
| `ABANDONED` | 这次**尝试**结束了 |

**S1**：`ABANDONED` 是一次**尝试**的终点，不是这份工作的终点——继任的 Coordinator 重新注意到它时，
从 `DISCOVERED` 重新开始。反过来写，会让一次接管看上去像是"这活不值得做"的决定。

### 6.2 转移表

每个格子只有一个结果；`—` 表示该事件在此状态下被拒绝且**状态不动**——这是一个明确的回答，不是一个洞。

| 状态＼事件 | FILE_IN_SCOPE | TARGET_UNCLEAR | DECLARE_HANDOFF | APPROVE | REFUSE_HANDOFF | APPLY | TARGET_SETTLED | TARGET_REOPENED | USER_ASSIGNS_PROJECT | SCOPE_LOST |
|---|---|---|---|---|---|---|---|---|---|---|
| `DISCOVERED` | `FILED` | `UNMAPPED` | `HANDOFF_REQUESTED` | — | — | — | `REOPEN_REQUIRED` | — | `FILED` | `ABANDONED` |
| `FILED` | `FILED` | — | `HANDOFF_REQUESTED` | — | — | `FILED` | `FILED` | `FILED` | `FILED` | `FILED` |
| `UNMAPPED` | — | `UNMAPPED` | `HANDOFF_REQUESTED` | — | — | — | — | — | `FILED` | `UNMAPPED` |
| `HANDOFF_REQUESTED` | — | — | `HANDOFF_REQUESTED` | `HANDOFF_APPROVED` | `ABANDONED` | — | `REOPEN_REQUIRED` | — | `FILED` | `HANDOFF_REQUESTED` |
| `HANDOFF_APPROVED` | — | — | `HANDOFF_APPROVED` | `HANDOFF_APPROVED` | `ABANDONED` | `FILED` | `REOPEN_REQUIRED` | — | `FILED` | `HANDOFF_APPROVED` |
| `REOPEN_REQUIRED` | — | — | `REOPEN_REQUIRED` | — | `ABANDONED` | — | `REOPEN_REQUIRED` | `DISCOVERED` | `FILED` | `REOPEN_REQUIRED` |
| `ABANDONED` | — | — | — | — | — | — | — | — | `FILED` | `ABANDONED` |

**S2（用户永远有出口）**：`USER_ASSIGNS_PROJECT` 从**任何**状态到 `FILED`，`ABANDONED` 也不例外。
用户是本文所有拒绝都不适用的那一个主体（R1），这条在状态机上是同一句话。

**S3（接管不动已写下的东西）**：`SCOPE_LOST` 是除 `DISCOVERED` 以外**每个**状态的不动点。
接管唯一能终止的，是那次**还没写下任何东西**的尝试。

**S4（批准不是落地）**：`HANDOFF_REQUESTED` 上的 `APPLY` 是 `—`。少了这条，
"批准了"和"移完了"会变成同一个事件，那个"已批准、等自己那次事务"的状态就没有地方待。

**S5（重开之后回判定入口，不回请求）**：`REOPEN_REQUIRED` 上的 `TARGET_REOPENED` 落到 `DISCOVERED`。
一次重开开启新的验收代次，先前那次判定读到的世界已经不在了，§4 必须对着新的世界重答一遍。

**S6（重试不能绕过 `UNMAPPED`）**：`UNMAPPED` 上的 `FILE_IN_SCOPE` 是 `—`。
把同一次写入再发一遍并不会让归属变清楚；没有这一格，Coordinator 可以在这条拒绝上空转到别的东西变化为止，
而那正是 AC3 明令禁止的静默空转。

## 7. 责任边界

| 情形 | 谁负责 | 他要做什么 | 谁**不能**代劳 |
|---|---|---|---|
| 写错了项目（R2 · R5 · R6 · R7） | Coordinator | 重算作用域重试，或回自己项目落地，或声明跨越去申请 | 没有人替它改归属 |
| 目标说不清（R4） | 用户 | 指认归属（或明确说它不属于任何项目） | **Coordinator 不得自选一个**——这正是事故的形状 |
| 跨项目移交（R10 · R11） | 用户 | 批准或拒绝这一次**指名了两端与 Task** 的移交 | **目标 Project 的 Coordinator 不能替用户签收**（PCC §9.3 永不代劳）；一个 Agent 不能替另一个目标接下工作 |
| 落点已验收完成（R8） | 用户 | 显式重开（开启新的验收代次），或换一个落点 | 审批不能替代重开；Coordinator 不得自行重开 |
| 作用域被接管（R3） | 系统 | 什么都不用做：继任作用域会重新判定 | 被接管的会话**不得**重试——它已经不是那个作用域了 |
| 老客户端跨项目写入（§8） | Coordinator | 同上；它拿不到更大的权限 | 降级不构成授权 |

**RB1（"谁的错"与"谁去修"不是一个问题）**：`UNMAPPED_PROJECT_WORK` 的责任人是**用户**，
而 Coordinator 在这里的行为是**正确的**——它注意到了说不清归属的工作，并且**没有**替它选一个。
它做错的唯一可能是自己挑一个项目填进去。

**RB2（跨项目移交的批准人只有用户）**：目标 Project 的 Coordinator 不是批准人。
一个 Agent 替另一个目标签收工作，是把"我认为这属于你"变成"这属于你"，
而这正是 §0 那次事故在多一个 Agent 之后的样子。

## 8. 兼容矩阵与两阶段落地

| 写入者 | 带 scopeToken | 同项目写入 | 跨项目写入 | 依据 |
|---|---|---|---|---|
| 新版 Coordinator | 是 | 允许（R15） | 声明 + 审批（R10 → R14） | §4 |
| 老版 Coordinator / 老 runner | 否 | **允许**（R15，作用域服务端派生） | 拒绝（R7；它表达不了声明） | SC10 |
| 老版 Web / CLI 代用户写入 | 否 | 允许（R1） | 允许（R1） | 用户不受本文约束 |
| 被轮换掉的会话（任意版本） | 是 | 拒绝（R3） | 拒绝（R3） | SC9 |
| 未绑定作用域的 Agent 会话 | 否 | 拒绝（R5） | 拒绝（R5） | SC1 |

**CM1（缺 token 不是授权）**：老客户端与新客户端被**同样地**限定作用域，因为作用域从来不是客户端说了算的；
它唯一失去的能力是**声明一次跨越**。这既保住了 AC11 的兼容承诺，又没有留下降级即绕过的通道。

**CM2（两阶段落地，L3 执行）**：L3 引入强制时按 observe → enforce 两阶段，与 G 单元 0132 cutover 同形：
观察期内被本文拒绝的写入**照常写入**，但按 §5 落一条决策审计（该落 blocker 的照落），
使"这条规则一旦打开会拒掉什么"在打开之前就是**可数的**；
切换到 enforce 之后才真的拒绝。任何一个阶段都不得改变 R1（用户）那一行。

**CM3（不新增业务实体）**：本文一张新表都不要、一个新业务实体都不要。
作用域是从既有列**派生**的，来源证据是既有 Task 上的列（L2 落地），
状态机的状态由既有事实推出，不落成第七种实体。这与 PCC §2.3 是同一条硬约束。

## 9. 映射到项目的 12 条验收标准

**这一节是本文与一份提示词的区别所在**。一份没有任何验收标准指向它的冻结文档，
是一份项目可以在从未读过它的情况下被判 DONE 的文档。
下表把每一条款挂到项目**已经声明**的验收标准上：回答 AC4 或 AC9 的那次验收运行，
因此**也必须**回答这些规则。12 条标准的正文不在这里复制——
`project-coordinator-contract.md` §14 是它们的权威表，本文的 spec 逐个序号对着那张表校验，
而不是对着一份会漂移的副本。

| 条款 | 验收标准 | 为什么是这一条 |
|---|---|---|
| `SC1` | AC4 · AC9 | 作用域首先是一条权限边界；越权是 AC9 点名禁止的三件事之一 |
| `SC2` | AC4 · AC9 | 例外通道会让 AC4 的"明确权限边界"变成一句话 |
| `SC3` | AC5 · AC9 | 每次判断记录它是在哪一次作用域下做的（AC5 的输入/幂等键） |
| `SC4` | AC2 · AC9 | 重复投递与重启后不得重复执行动作，正是 AC2 的原话 |
| `SC5` | AC4 · AC12 | 未声明的跨越会让验收数到别的目标名下的工作 |
| `SC6` | AC5 · AC12 | 只有一个权威归属列，验收的 taskSet 投影才有唯一解 |
| `SC7` | AC5 · AC12 | 证据不得进入授权判定，也不得进入验收计数 |
| `SC8` | AC3 · AC8 | 结构化拒绝 + 责任人 + 下一步 = AC8；不静默空转 = AC3 |
| `SC9` | AC9 · AC11 | 崩溃/接管后不丢任务、不重复启动、不越权 |
| `SC10` | AC11 · AC12 | 迁移后老 Project 不被意外扩权；DONE 的重开门属于 AC12 |

## 10. 本单元不做什么

| 留给谁 | 什么 |
|---|---|
| **L2** | 把发现来源四列与验收版本持久化；本文只冻结列名与"证据不授权"的语义 |
| **L3** | 服务端强制 + 幂等写入 + 把 4 个新码接进既有分类（§5 EC6）+ observe/enforce 两阶段 |
| **L4** | 显式跨 Project 移交与原子计划预检（§6 的 `HANDOFF_*` 三态落地） |
| **L5** | DONE Project 的显式重开与新 acceptance epoch（R8 的出口） |
| **L6** | 运行前归属门禁与既有错误任务的审计修复 |
| **L7** | Web/API/CLI 展示归属边界、移交与重开影响 |

本单元交付的是**四张冻结表 + 一个纯判定函数 + 两个 spec**，没有接线、没有 schema、没有调用点。
业务层仍然只有 Project 与 Task 两个概念。
