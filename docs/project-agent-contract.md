# Project · Agent · Workspace 领域契约 v1.3

> **状态**：已冻结（frozen）。本文件是 `Project 多 Agent 协作与 Agent 级 Provider 调度` 的**单一权威契约**。
> 02–06 阶段的每个实现任务都必须与本文件一致；实现与本文件冲突时，先改本文件并说明理由，再改代码。
>
> **适用分支**：`feat/project`（`main` 里没有 `Project`）。
> **代码基线**：`b810be89 docs(project): close the seven contradictions the contract review found`，
> 迁移基线 `0127_project_acceptance_run`（`main` 已被 `feat/project` 包含）。
> **本文只描述目标状态与迁移路径，不描述已有实现**；已有实现的现状写在 §11 兼容矩阵里。
> **自检**：`src/apiserver/src/projects/project-agent-contract.spec.ts` 把本文件按它自己声明的性质检一遍
> （错误码闭合、快照两段式不重叠、§13→§14 映射完整、§7.5 的 id 都被 §10 覆盖、§11.2 的迁移语句顺序在真实外键
> 形状上可执行、两组拒绝谓词的交集各只有一个码、PAC 派发拒绝码与 PCC blocker kind 的**双向**闭合）。
> 改本文件必须让它继续绿；最后两类断言同时读 `docs/project-coordinator-contract.md`，因此**动一份契约就必须同时动另一份**。

## 0. v1.1 修订说明（相对 v1）

v1 被独立审查（01V，被审 `a4adabf9`）判为 FAIL，七项阻断矛盾。v1.1 逐项给出**唯一**结论：

| # | v1 的矛盾 | v1.1 的唯一结论 | 落在 |
|---|---|---|---|
| 1 | 以 `b5fe1b2e` 为基线、要求"迁移 0111 创建 `project_member`"，而该表已由 0111 创建且 `agent_id` 指向 `workspace` | 基线更新到当前 `feat/project`；`project_member` 是**既有表**，v1 只做**保序重指向**（同一行、同一 id、同一 role），迁移落在一个新编号里（`0128`，见 §11.2） | §3.2 · §11.2 |
| 2 | Project 目标要求"Provider 归 Agent、Task 只指派 Agent"，而 §7.2 保留 Task pin 且 pin 赢 | **V1 Task 不得携带 `provider`/`model`**，由数据库 CHECK 约束保证；pin 只活在 LEGACY Task 上 | §3.4 · §7.2 · §11.1 |
| 3 | `snapshotFrozenAt` 说"上表全部列只读"，同表又说 `model`/`effort` 首次 claim 才冻结 | 冻结是**两段式**：`snapshotFrozenAt` 只封 create-frozen 九列，`model`/`effort` 由首次 claim 单独封 | §6 |
| 4 | Coordinator 权限来源写作"会话上下文 + Team 中 COORDINATOR"，而 O2 又不强制两者绑定 | **权限只归 Coordinator Session**（`session.id = project.coordinatorSessionId`）；Coordinator Agent 只做归属与展示，永不参与鉴权 | §8.1 |
| 5 | `NO_PROJECT_WORKSPACE` 同时表示"候选集为空"和"pin 不在候选集" | 拆成两个码：`NO_PROJECT_WORKSPACE`（候选集为空）与 `WORKSPACE_PIN_NOT_A_CANDIDATE`（pin 越界） | §7.3 · §12 |
| 6 | 要求"每跳落 `run_event`"，而 `run_event.session_id` 是必填 FK，失败路径根本没有 Session | 审计载体按**有没有 Session** 二选一：成功走 `resolution` + `run_event`，失败走 `project_blocker`（控制环再加 `project_action.refusal_code`），**永不写没有 Session 的 `run_event`** | §7.4 |
| 7 | B3 只要求断言 `resolution.who.agentId`；L2 让既有 Project Task 立刻进 V1 并必然 `WHO_UNRESOLVED` | §7.5 里三个 id 全部要求 base62 并由结构化用例覆盖；分流判据从 `projectId IS NULL` 改为 `task.executionContract`，既有 Project Task 一律 stamp 成 LEGACY | §10 B3 · §11.1 |

§14 的 8 条项目验收标准映射同步重写：每条至少一条正向用例 + 一条拒绝/迁移/回归用例，且每条用例在 §13 里有编号。

### 0.1 v1.2 修订说明（相对 v1.1）

v1.1 被独立复验（01V，被审 `b810be89`）判为 FAIL，四组阻断。v1.2 逐项给出**唯一**结论：

| # | v1.1 的阻断 | v1.2 的唯一结论 | 落在 |
|---|---|---|---|
| 1 | §11.2 步骤 4 先 `UPDATE project_member.agent_id` 再 DROP 旧外键，而 0111 那条外键是**即时校验**的，第一条 UPDATE 在任何一条真实数据上都被拒 | 同一事务内**先 DROP 旧 FK、再 UPDATE、最后 ADD 新 FK**；顺序、回滚与前后断言逐条写死，02B.7 / 06B.3 在真实 0111 外键形状上跑 | §3.2 T4 · §11.2 M7 |
| 2 | `WHO_NOT_IN_TEAM ∩ WHO_DISABLED` 与 `WORKSPACE_PIN_NOT_A_CANDIDATE ∩ NO_PROJECT_WORKSPACE` 两组谓词可同时为真而无优先级 | 两组各定一个**唯一优先级**：WHO 先判成员资格（`WHO_NOT_IN_TEAM` 胜），WHERE 把"候选集为空"提到优先级 1（`NO_PROJECT_WORKSPACE` 胜），互斥因此成为结构性后果 | §7.1 H4 · §7.3 C8 · §12 E3 |
| 3 | 新错误码与 PCC / 数据库的 blocker 集合不闭合；PCC 的决策投影仍读 `task.provider` / `task.model`，也没有 `executionContract` | §12 给每一行标注**派发 / 写入**路径：派发路径的码**必须**同时是 PCC §11.2 的 kind、数据库 CHECK 的取值与实现里的成员，两个方向都自检；PCC 同步加 `executionContract`，把 task pin 收进 LEGACY 分支 | §7.4 AU-F2 · §12 E4 |
| 4 | AC1 只证明"不是 UUID 形状"、AC3 没有 Coordinator 建树、AC6 没引用任何 API 用例、AC8 没有旧客户端写请求兼容 | 四条各补一条指名用例：`04A.20` 三个 id 的 base62 等值 round-trip、`03C.15` Coordinator 建 parent+child 任务树、AC6 引用 03A/03B/03C/04A、`06B.8` 旧客户端创建 Project Task | §11.1 L5 · §11.4 · §13 · §14 |

### 0.2 v1.3 修订说明（相对 v1.2）

v1.2 被独立复核（01V，被审 `47cfc22a`）判为 FAIL，三项阻断。三项是同一个形状：**契约里已经写对的那句话，
没有被推到它自己声称能证明它的那个可执行位置**。v1.3 逐项给出**唯一**结论：

| # | v1.2 的阻断 | v1.3 的唯一结论 | 落在 |
|---|---|---|---|
| 1 | 同一个旧端请求（带 `projectId`、没有 `assigneeAgentId`）按 §3.4 字段表 / K3 / L3 / `02C.2` 得 `V1`，按 L5 / §11.4 / `06B.8` 得 `LEGACY`，两个答案都能引用契约 | `execution_contract` 的写入规则**只有一处**：§11.1 L5 的三行请求形状表。其余五处改为引用它；正文里再出现"带 `projectId` 就写 `V1`"即为缺陷，由 `00.17` 扫描，并对两种录制的旧端载荷各断言一个唯一结果 | §2 · §3.4 K3 · §11.1 L3 · L5 · §13 `02C.2` |
| 2 | §7.1 H4 已经把成员资格排在可用性之前，而**可执行的** WHO 模型仍先判 `enabled`/`deletedAt`，`member=null` 且 disabled 的输入返回 `WHO_DISABLED`；`00.13` 只读表格顺序，没有调用那个 resolver | 可执行模型按 H4 的顺序判，`member=null ∩ disabled` 与 `member=null ∩ deleted` 两个交集**直接跑 resolver**，各断言唯一 `WHO_NOT_IN_TEAM`；`00.18` 断言这两条反例确实存在于反例测试里 | §7.1 H4 · §13.0 `00.18` |
| 3 | PCC 文档已带 `executionContract`、EC1-b 也已分支，而可执行的 `Db33` / fixture / resolver / `world` 投影 / `S10_FIELDS` 一个都没有它：那份模型对一份漏字段的投影自洽地全绿 | 分流判据进入可执行模型：V1 分支只读 Agent 的 provider/model/fallback，LEGACY 分支才读 Task pin；`S10_FIELDS` 增加 `tasks[].executionContract` 并配一对**只差这一列**的 mutation，删掉该字段必须红 | §16 O7 · §13.0 `00.19` |

v1.3 **不改变**任何生产行为，也不提前实现 PCC §12.1 步骤 6j —— 那条仍然由 04C 承担，`00.14` 的 landed/pending
双向断言与"唯一一条落地步骤"逐字不变。

---

## 1. 分层原则

本项目只有两层，任何设计争议都先回到这条分层来判：

| 层 | 实体 | 含义 | 判据 |
|---|---|---|---|
| **业务层（core）** | `Project`、`Task` | 人关心的东西：要达成什么、要做哪些事 | 删掉执行层，业务层仍然自洽可读 |
| **执行基础设施（infrastructure）** | `Agent`、`Workspace`、`Runner`、`Session` | 怎么把 Task 变成一次真实运行 | 只能被业务层引用，不得反过来定义业务语义 |

由此得到三条**不可违反的分层规则**：

- **R1**：`Project` / `Task` 的语义不得依赖任何执行层实体的存在。一个没有 Agent、没有 Workspace、从未运行过的 Task 仍然是一个完整的 Task。
- **R2**：执行层实体不得携带业务判断。Agent 不决定"这件事该不该做"，Workspace 不决定"这件事是什么"。
- **R3**：**谁做（WHO）、用什么做（WITH WHAT）、在哪里做（WHERE）是三条独立解析链**（§7）。任何一条链的输入不得成为另一条链的隐式输入。这是本项目存在的根本原因：今天 `Task.assigneeId` 指向 `workspace`，而 `workspace.runnerId` 直接决定机器，于是"选谁做"隐式决定了"在哪台机器上跑"，普通开发 Task 因此被调度到 Mac Runner。

---

## 2. 词汇表（每个术语在此有且仅有一个权威定义）

本文与后续代码、注释、UI 文案一律使用下表词形。**表中每个术语只在这里定义一次**，其余章节只引用不重述。

| 术语 | 权威定义 | 落库位置 |
|---|---|---|
| **Project** | 一组为同一目标服务的工作。业务层实体，持有 goal / acceptanceCriteria / instructions / team / 候选 Workspace 集合。 | 表 `project` |
| **Task** | 一件要做的事。业务层实体，持有 assignee **Agent**、可选 WHERE pin、可选 runtime requirement。**V1 Task 不持有 Provider/Model**（§3.4 K1）。 | 表 `task` |
| **Execution Contract** | 一个 Task 按哪一版规则解析执行上下文：`LEGACY`（v1 之前的行为，逐字节不变）或 `V1`（本契约的三条解析链）。**这是唯一的分流判据**，不是 `projectId` 是否为空，也不是创建时间。**它被写成 `V1` 的唯一规则在 §11.1 L5**（请求既带 `projectId` 又显式带 `assigneeAgentId`）。 | `task.execution_contract` |
| **Legacy Project Task** | `execution_contract = 'LEGACY'` 且 `project_id IS NOT NULL` 的 Task：v1 迁移之前就已经归属某个 Project 的历史任务，**以及迁移之后由旧客户端创建、请求里没有 `assigneeAgentId` 的那些**（§11.1 L5）。**它按 LEGACY 规则运行，直到有人显式给它指派 Agent**（§11.1 L4）。 | `task` 的一行 |
| **Agent** | **"谁做"**：一个可复用的执行身份（角色、系统提示词、默认 Provider/Model/effort、能力与权限、runtime requirement 基线）。**Agent 不持有任何位置信息**（无 runnerId、无 workDir）。 | 表 `agent`（v1 新增） |
| **Legacy agent alias** | 历史遗留的**线上别名**：今天 MCP `agent_list/agent_create/agent_update`、CLI `orbit agent`、iOS/macOS/web 的 "Agent" 指的都是 `workspace` 行，**不是** 上一行的 Agent。v1 保留该别名并标记 deprecated（§9.2）。 | 表 `workspace` |
| **Workspace** | **"在哪里做"**：一台机器上的一个项目目录。持有 runnerId、workDir、worktree 隔离开关、env、默认 merge target。**Workspace 不持有身份信息**（v1 后不再被解析链读取 systemPrompt/model）。 | 表 `workspace` |
| **Project Team** | 一个 Project 允许使用的 Agent 集合及其项目内角色与权限。 | 表 `project_member`（**既有表**，0111 建立） |
| **Project Member** | Project Team 中的一条成员记录 = (project, agent, role, 权限位)。 | 表 `project_member` 的一行 |
| **Coordinator Agent** | Project Team 中 `role = COORDINATOR` 的成员。每个 Project **至多一个**。它是**归属与展示**用的身份：决定一次协调判断记在谁名下（`project_decision.coordinator_agent_id`），**不授予任何权限**（§8.1 PR2）。 | `project_member.role` |
| **Coordinator Session** | Project 的协调对话本身（`project.coordinatorSessionId`）。**它是 Coordinator 权限的唯一来源**（§8.1 PR1）。与 Coordinator Agent 是两回事：前者是一段被 owner 绑定过的对话，后者是一个身份标签。 | `project.coordinatorSessionId` |
| **Project Workspace** | Project 注册的候选 Workspace 之一。WHERE 链只在这个集合内选，绝不扩散到 owner 名下的其他 Workspace。 | 表 `project_workspace`（v1 新增） |
| **Default Workspace** | Project Workspace 中 `isDefault = true` 的那一条。每个 Project **至多一个**，由数据库 partial unique index 保证。 | `project_workspace.is_default` |
| **Runtime Requirement** | 一次运行对**机器**的硬性要求，表示为能力标签集合（如 `macos`、`xcode`、`gpu`）。声明在 Task 和/或 Agent 上，两者取并集。**它只筛机器，永不筛 Agent、永不筛 Provider。** | `task.required_capabilities` + `agent.required_capabilities` |
| **Runtime Capability** | 一台 Runner **自己上报**的、它真实具备的能力标签集合。由心跳独占写入（heartbeat-owned），用户不可编辑。 | `runner.capabilities`（v1 新增） |
| **Runner Label** | 已存在的**用户自定义**机器标签（`runner.labels`）。与 Runtime Capability 是两个东西：label 是人写的备注，capability 是机器自报的事实。**调度只读 capability，永不读 label。** | `runner.labels`（既有，语义不变） |
| **Engine capability**（勿混淆） | 已存在于 claim queue 的第三种"capability"：指 runner **二进制版本**是否支持某条协议路径（见 `queue-provider-capability.spec.ts`）。与本项目无关，v1 不改动；本文其余部分出现的 capability 一律是上面两行的含义，不是这一层。 | 代码内部，无列 |
| **Provider** | 跑这次对话的引擎身份：内置 slug（`claude`/`codex`/`kimi`/`opencode`）或 owner 配置的 `ModelProvider.slug`。 | `session.provider` |
| **Model** | Provider 空间内的模型 id。 | `session.model` |
| **Session** | 一次真实运行的对话。执行层实体，**持有解析结果的不可变快照**（§6）。 | 表 `session` |
| **Execution Snapshot** | Session 上一组"写一次、此后只读"的列，记录三条解析链的结果与依据。Resume / reclaim / 心跳 **永不**从 Agent/Project/Workspace 重新推导这些值。冻结分**两段**：create-frozen 与 claim-frozen（§6）。 | §6 表格 |
| **Explicit Fallback** | Agent 上显式配置的、有序的备选 Provider/Model 列表。**唯一被允许的降级路径**；为空即表示"不可用就失败"。 | `agent.provider_fallbacks` |
| **Public ID** | 面向外部（URL、API、CLI、MCP、原生端）的 base62 短 id，由 `src/shared/src/codec.ts` 编解码。内部一律 UUID。 | 见 §10 |

---

## 3. 实体与字段契约

字段表只列 **v1 新增或语义变更** 的字段；未列出的既有字段语义不变。
类型按 Prisma 写法；`@db.Uuid` 列必须同时在 §10 完成 Public ID 归类。

> **本节只补充落库细节与约束，不重新定义术语。** 任何术语的含义一律以 §2 为准；本节若与 §2 读起来不一致，以 §2 为准并把本节改掉。

### 3.1 `Agent`（新表 `agent`）

"谁做"。**不含任何位置信息**是这张表的核心约束。

| 字段 | 类型 | 语义与约束 |
|---|---|---|
| `id` | `String @id @default(uuid(7)) @db.Uuid` | 主键 |
| `ownerId` | `String @db.Uuid` | 租户边界，所有列表/鉴权按此过滤 |
| `name` | `String` | 显示名，`@@unique([ownerId, name])`（软删的行不参与，见下） |
| `description` | `String?` | 角色说明，给人看 |
| `role` | `String?` | 角色标签（`coordinator` / `product` / `ux` / `dev` / `qa` …）。**只是标注**：项目内的权威角色在 `project_member.role`，此列不参与任何鉴权判断 |
| `systemPrompt` | `String?` | 身份提示词 |
| `appendSystemPrompt` | `String?` | 追加提示词 |
| `defaultProvider` | `String?` | 默认 Provider。null = 继承 owner 级默认（`claude`） |
| `defaultModel` | `String?` | 默认 Model。null = 用 Provider 自己的默认 |
| `defaultEffort` | `String?` | 默认 reasoning effort |
| `providerFallbacks` | `Json @default("[]")` | **Explicit Fallback**：有序数组 `[{provider, model?}]`。空数组 = 不降级（§7.4） |
| `disallowedTools` | `Json @default("[]")` | 该身份禁止的工具 |
| `requiredCapabilities` | `String[] @default([])` | 该身份的 **Runtime Requirement 基线**（如 iOS 构建 Agent 恒为 `["macos"]`） |
| `canCreateTasks` | `Boolean @default(false)` | 是否可以在项目内建任务（§8） |
| `canDelegate` | `Boolean @default(false)` | 是否可以把任务指派给**别的** Agent（§8） |
| `enabled` | `Boolean @default(true)` | 关掉即不可被指派、不可被调度 |
| `deletedAt` | `DateTime?` | 软删，与 `workspace.deletedAt` 同语义：行保留，列表过滤，在飞 Session 不受影响 |
| `legacyWorkspaceId` | `String? @unique @db.Uuid` | **迁移专用**：这一行是从哪个 `workspace` 镜像出来的。只在 0128 回填时写入，之后只读，用于 §11 的双写兼容层。新建 Agent 恒为 null |

**约束**
- **A1**：`agent` 表**不得**出现 `runnerId` / `targetRunnerId` / `targetLabels` / `workDir` / `enableWorktree` / `env` 中的任何一个。审查项，02A 必须有一条断言 schema 里不存在这些列。
- **A2**：`@@unique([ownerId, name])` 需为 partial（`WHERE deleted_at IS NULL`），否则软删过的名字永久占位。
- **A3**：`role` 不参与鉴权（见上表）。任何读 `agent.role` 做权限判断的代码都是缺陷。
- **A4**：镜像行（`legacyWorkspaceId` 非空）与手建行在**所有**读路径上一视同仁。`legacyWorkspaceId` 只被两处读：`workspace ↔ agent` 的兼容层查找，和 §11.2 迁移自己的幂等键。任何解析链读它都是缺陷。

### 3.2 `ProjectMember`（**既有表** `project_member`，v1 重指向 + 加列）—— Project Team

`project_member` 由迁移 `0111_project_coordinator_identity` 建立，今天已经在生产库里带着数据运行：
`agent_id` 的外键指向 **`workspace(id)`**，因为"Agent"在今天的线上就是一条 workspace 行（§2 Legacy agent alias）。
v1 **不新建这张表**，而是把 `agent_id` **保序重指向**到新的 `agent` 表（§11.2 步骤 4）。

| 字段 | 状态 | 语义与约束 |
|---|---|---|
| `id` | 既有 | 主键。**重指向不换 id**：同一条成员关系在迁移前后是同一行 |
| `projectId` | 既有 | `onDelete: Cascade` |
| `agentId` | **既有列，v1 换外键目标** | 迁移前 → `workspace(id)`；迁移后 → `agent(id)`，值按 `agent.legacy_workspace_id = 旧值` 映射。`onDelete: Restrict` 两边都保持 |
| `role` | 既有 | 枚举 `ProjectRole`（`COORDINATOR` / `MEMBER`），已由 0111 建立 |
| `addedAt` | 既有 | 重指向不改写 |
| `canCreateTasks` | **v1 新增** | 项目内**收窄**覆盖：null = 用 `agent.canCreateTasks`；非 null 时**只能收窄不能放宽**（§8.3） |
| `canDelegate` | **v1 新增** | 同上 |
| `position` | **v1 新增** | 展示顺序 |

**约束**
- **T1**：`@@unique([projectId, agentId])` —— **已存在**（`project_member_project_id_agent_id_key`）。重指向是一次 1:1 映射，因此唯一性在迁移前后等价；02B 的迁移用例必须直接断言这一点。
- **T2**：`@@unique([projectId]) WHERE role = 'COORDINATOR'` —— **已存在**（`project_member_coordinator_idx`）。v1 不重建、不改名。
- **T3**：`@@index([agentId])` —— **已存在**（`project_member_agent_id_idx`）。
- **T4（保序重指向）**：迁移必须满足四条可断言的性质：① 行数不变；② 每一行的 `id` / `project_id` / `role` / `added_at` 逐字节不变；③ 新 `agent_id` 与旧 `agent_id` 之间存在双射（`agent.legacy_workspace_id`）；④ 每个 Project 的 COORDINATOR 归属对象不变（旧 workspace 的镜像 Agent 就是新的 COORDINATOR）。**三条语句的顺序由 §11.2 M7 固定**：旧外键必须在 `agent_id` 被更新之前摘掉，否则第一条 UPDATE 在真实数据上就被它拒绝。
- **T5（镜像集必须闭合）**：`project_member.agent_id` 可能指向一条**已软删**的 workspace（软删不受 Restrict 约束）。因此镜像集 = `{workspace | deleted_at IS NULL}` ∪ `{workspace | 被任一 project_member 引用}`，软删来源的镜像行带 `agent.deleted_at = workspace.deleted_at`，不进任何选择器。少这一条并集，重指向的外键会在生产库上直接失败。

### 3.3 `ProjectWorkspace`（新表 `project_workspace`）—— 候选执行位置

| 字段 | 类型 | 语义与约束 |
|---|---|---|
| `id` | `String @id @default(uuid(7)) @db.Uuid` | |
| `projectId` | `String @db.Uuid` | `onDelete: Cascade` |
| `workspaceId` | `String @db.Uuid` | `onDelete: Restrict`（同 T-agentId 的理由） |
| `isDefault` | `Boolean @default(false)` | **Default Workspace** 标记 |
| `position` | `Int?` | 候选排序，WHERE 链的确定性 tie-break（§7.3） |

**约束**
- **W1**：`@@unique([projectId, workspaceId])`。
- **W2**：`@@unique([projectId]) WHERE is_default`（partial unique index）—— 每个 Project 至多一个 Default Workspace。
- **W3**：**Default Workspace 不是 `project` 表上的一列**。同一事实只能有一处落库，denormalize 一份必然漂移。
- **W4**：`project.coordinatorWorkspaceId` 与 Default Workspace 是**两个不同的事实**，不得合并：前者是"协调对话跑在哪"（重绑时要 409 的强约束，见既有 schema 注释），后者是"这个项目的活默认在哪跑"（可随时改的设置）。协调者跑在 Linux、iOS 构建跑在 Mac 是本项目要支持的正常形态。

### 3.4 `Task`（既有表 `task`，新增列）

| 字段 | 类型 | 语义与约束 |
|---|---|---|
| `assigneeAgentId` | `String? @db.Uuid` | **WHO 链的唯一输入**。`onDelete: Restrict`。取值必须是本 Task 所属 Project 的 Team 成员（§8.4） |
| `executionContract` | `TaskExecutionContract @default(LEGACY)` | 枚举 `LEGACY` / `V1`（SQL 类型 `task_execution_contract`）。**解析链的唯一分流判据**（§11.1）。**列默认 `LEGACY`**，因此加列这一步就把所有既有行放进 legacy 路径；服务层**当且仅当**创建请求既带 `projectId`、**又显式携带 `assigneeAgentId`** 时才写 `V1`，唯一规则在 §11.1 L5（同 0111 给 `coordinator_enabled` 的做法：默认值是老行保留的值，新行的值由服务显式写）|
| `workspaceId` | `String? @db.Uuid` | WHERE 链的**显式 pin**（罕用逃生口）。`onDelete: SetNull`。null = 走 §7.3 解析 |
| `requiredCapabilities` | `String[] @default([])` | 本 Task 的 **Runtime Requirement** |
| `provider` / `model` | `String?`（既有） | **冻结为 legacy**。只有 `execution_contract = 'LEGACY'` 的行才允许非空，也只有那条路径读它。V1 行上恒为 NULL，由数据库 CHECK 保证（K1） |
| `assigneeId` | `String? @db.Uuid`（既有） | **冻结为 legacy**。语义不变（指向 `workspace`），v1 后**不再是** WHO 链输入，降级为 LEGACY 路径的 WHERE 输入（§11.1）。不删列 —— 删列会让 iOS/macOS 静默漏改 |

**约束**
- **K1（AC2 的落地条款）**：**V1 Task 不得携带 Provider/Model pin。**
  ```sql
  ALTER TABLE "task" ADD CONSTRAINT "task_v1_has_no_provider_pin"
    CHECK ("execution_contract" = 'LEGACY' OR ("provider" IS NULL AND "model" IS NULL));
  ```
  这是一条**数据库约束**而不是服务层检查，理由与 T2 相同：四个写路径 + MCP + CLI + 未来的任何 raw SQL 都绕不过它。写入被拒时服务层翻译成 `TASK_PROVIDER_PIN_REFUSED`（§12）。
- **K2**：`assigneeAgentId` 与 `projectId` 的一致性由服务层在**写路径**校验（create / update / batch-create / batch-assign 四处），并由 03C 的测试逐处覆盖。不做数据库级跨表 check —— Postgres 表达不了，且 Project 变更时会把校验变成 migration。
- **K3**：Task 可以没有 `projectId`（今天 11 万行都没有）。**无 Project 的 Task 恒为 LEGACY** —— 列默认值就是它。**`projectId` 只是写 `V1` 的必要条件，不是充分条件**：充分条件由 §11.1 L5 唯一给出（创建请求里还必须显式带 `assigneeAgentId`），本条只说没有 Project 的那一半。把一条没有 Project 的 Task 置成 `V1` 被拒（`TASK_CONTRACT_NEEDS_PROJECT`，§12）：V1 路径的每一条规则都要求一个 Project。
- **K4（晋升是单向的）**：`LEGACY → V1` 由 §11.1 L4 的显式动作触发；**`V1 → LEGACY` 永远不允许**。降级回去等于把一条已经解耦的任务重新交给"位置决定引擎"，而这正是本项目要消灭的东西。

### 3.5 `Runner`（既有表 `runner`，新增列）

| 字段 | 类型 | 语义与约束 |
|---|---|---|
| `capabilities` | `String[] @default([])` | **Runtime Capability**（定义见 §2）。由心跳独占写入：只有 `POST /runner-api/heartbeat` 能写，任何用户接口都不得写它 |
| `capabilitiesReportedAt` | `DateTime?` | 上报时刻。**null = 从未上报**，必须与"上报了空集"严格区分（§7.3 C4） |

**约束**
- **C1**：`labels`（既有）不变，且**调度路径永不读它**。这是 v1 的回归项：今天 `workspace.targetLabels` / `targetRunnerId` 也无人读，v1 不复活它们（§11.3）。
- **C2**：能力标签是**小写、无空格**的稳定 slug。v1 冻结的最小集合：`macos`、`linux`、`windows`、`xcode`、`gpu`、`docker`。runner 上报未知 slug 不报错，只是不会被任何 requirement 命中。
- **C3**：能力由 runner 自探（`orbit doctor` 同一探针），不接受手工覆盖。手工覆盖会让"要求 macos"变成一句可以撒谎的话。

### 3.6 `Session`（既有表 `session`，新增列）—— Execution Snapshot

| 字段 | 类型 | 语义与约束 |
|---|---|---|
| `agentId` | `String? @db.Uuid` | 快照：这次运行的 WHO。`onDelete: SetNull`（删 Agent 不得毁掉历史运行记录） |
| `requiredCapabilities` | `String[] @default([])` | 快照：这次运行**当时**要求了什么能力 |
| `resolution` | `Json?` | 快照：三条链各自命中了哪条规则、fallback 走了几跳（§7.5 定义结构） |
| `snapshotFrozenAt` | `DateTime?` | **create-frozen 集合**的封存时刻。非 null 后，§6 中冻结时刻为 Session create 的那九列一律只读（§6 S4） |
| `workspaceId` / `assignedRunnerId` / `provider` / `providerBuiltin` / `model` / `effort` / `permissionMode`（既有） | | **已经是快照的一部分**，v1 不新增列、不改语义，只把"何时冻结"写进 §6 |

---

## 4. 关系图

```
              ┌──────────────────────── 业务层 ────────────────────────┐
              │                                                        │
              │   Project ──1:N── Task ──1:N── (Task 子树 parentTaskId) │
              │      │                │                                 │
              └──────┼────────────────┼─────────────────────────────────┘
                     │                │
        ┌────────────┴────────┐       │ assigneeAgentId (WHO)
        │                     │       │ workspaceId     (WHERE pin)
   project_member       project_workspace                │
   (Project Team)       (候选执行位置)                     │
        │                     │                          │
        │ agentId             │ workspaceId              │
        ▼                     ▼                          ▼
     ┌───────┐           ┌──────────┐              ┌──────────┐
     │ Agent │           │Workspace │──runnerId──▶ │  Runner  │
     │ 谁做  │           │ 在哪里做  │              │  机器     │
     │+用什么│           └──────────┘              │capabilities
     └───────┘                                     └──────────┘
        │                                                ▲
        └───────────────┐          ┌────────────────────-┘
                        ▼          ▼
                    ┌─────────────────────┐
                    │      Session        │  ← Execution Snapshot
                    │ agentId · workspaceId│    (写一次，此后只读)
                    │ assignedRunnerId     │
                    │ provider · model     │
                    │ requiredCapabilities │
                    │ resolution           │
                    └─────────────────────┘
              └────────────── 执行基础设施 ──────────────┘
```

**唯一从执行层指回业务层的边**是 `session.taskId`（既有，SetNull）。除此之外执行层不得反向引用业务层。

---

## 5. 一次派发的时序

这是 04A 要实现的唯一入口 `resolveExecutionContext(task)` 的外部行为定义。

```
1. 取 Task（含 projectId / executionContract / assigneeAgentId / workspaceId / requiredCapabilities）
2. 若 task.executionContract = 'LEGACY'  → 走 §11.1 legacy 路径，本节其余步骤全部跳过
3. WHO   链 → agent                    （§7.1）失败即 REFUSE，不继续
4. WITH  链 → provider + model + effort（§7.2）失败即按 §7.4 决定降级或 REFUSE
5. WHERE 链 → workspace + runner       （§7.3）失败即 REFUSE，不继续
6. 组装 Execution Snapshot，创建或 resume Session（§6）
7. 同一事务内写入 session.resolution 与 snapshotFrozenAt —— 快照必须和 Session 行一起落库，
   否则会存在一条"已创建但还没有解析依据"的 Session，读到它的客户端无法解释它在跑什么
```

**每一步失败都是拒绝，不是降级。** 唯一的例外是第 4 步，且只在 Agent 配了 Explicit Fallback 时（§7.4）。

**REFUSE 发生在第 6 步之前，因此此刻没有 Session。** 审计必须落在不需要 Session 的行上，规则见 §7.4 AU-F —— 这条约束适用于**派发路径上**的每一个 §12 错误码，不只是 `PROVIDER_UNAVAILABLE`。（写入路径的拒绝码 —— §12 里 `路径 = 写入` 的那几行 —— 直接返回给写入方，不落 blocker：它们拒绝的是一次编辑，不是一次运行。哪些码属于哪条路径由 §12 的那一列**唯一**决定，本节不复制清单。）

**resume 与 create 的区别**：resume 一条已存在的 Session **完全跳过 3–7 步**，直接沿用该 Session 已冻结的快照。这是 §6 冻结语义的落地方式，也是"运行中途改 Agent 配置不会换引擎"的保证。

---

## 6. Execution Snapshot 冻结契约

一次运行的执行上下文是**当时**解析出来的事实，不是一个随配置漂移的视图。因此：

| 列 | 冻结时刻 | 冻结后行为 |
|---|---|---|
| `agentId` | Session **create** | 只读。改 Agent 配置、把 Agent 移出 Team、软删 Agent，都不影响在飞 Session |
| `workspaceId` | Session **create** | 只读 |
| `assignedRunnerId` | Session **create** | 只读。runner 掉线只会让 Session 失败/重试，不会改派机器 |
| `provider` / `providerBuiltin` | Session **create** | 只读。**Session 的 provider 终生固定**（运行时线程属于开它的 CLI），这是既有约束，v1 不改 |
| `requiredCapabilities` | Session **create** | 只读 |
| `resolution` | Session **create** | 只读 |
| `permissionMode` | Session **create** | 只读。create 时 materialize 账号默认，冻结的是这次运行的**权限意图**；只有已知 runner 根本无法启动的组合可在 create 时安全收窄（例如 root runner 上 `Bypass` → `Don't Ask`）。依赖实际 model 的 `Auto` → `Default` 由 Queue 在 claim 物化 model 后派生，不回写本列 |
| `model` | **首次 claim**（既有行为，保留） | 首次 claim 后只读。既有例外保留：模型被 runtime 彻底下架（`retiredPin`）时改写一次 |
| `effort` | **首次 claim** | 同 `model` |
| `snapshotFrozenAt` | Session **create** | 一旦非 null，**上表中冻结时刻为 Session create 的那九列**进入只读。它**不**封 `model` / `effort` —— 那两列的封条是首次 claim，见 S4 |

**S1**：`model` / `effort` 的冻结点是**首次 claim**而不是 create，这是刻意保留既有实现（`queue.service.ts` 的 compare-and-set materialize）。改成 create 会让"创建时 runner 还没上报 runtime 默认模型"的 Session 拿到错的模型。

**S2**：resume / reclaim / 心跳 / merge 回报路径**一律不得**读取 `agent.*` / `project.*` / `project_workspace.*` 来重新推导上表任何一列。04A 必须有一条测试：改完 Agent 的 provider 之后 resume 同一条 Session，Session 的 provider 不变。

**S3**：Session 快照**不是**审计日志。它记录这次运行冻结的执行选择与解析结论，不记录"谁在什么时候改了配置"。`permissionMode` 记录意图；对特定 model / runner 派生出的有效模式是运行时事实，不得反向改写这份 create 快照。配置变更的历史不在 v1 范围。

**S4（唯一冻结时点规则，v1.1）**：上表把快照分成**两个不相交的集合**，每个集合有且只有一个封条：

| 集合 | 成员 | 封条 | 封后唯一合法改写 |
|---|---|---|---|
| **create-frozen** | `agentId`、`workspaceId`、`assignedRunnerId`、`provider`、`providerBuiltin`、`requiredCapabilities`、`resolution`、`permissionMode`、`snapshotFrozenAt` 自身 | `snapshotFrozenAt IS NOT NULL` | 无 |
| **claim-frozen** | `model`、`effort` | 首次 claim 的 compare-and-set 成功（既有实现） | `retiredPin`（模型下架）改写一次 |

两个集合**没有交集，并集就是上表**，因此"这一列现在还能不能写"永远只有一个答案。
`snapshotFrozenAt` 只对 create-frozen 集合生效这一点是本条的全部内容：v1 把它写成"上表全部列只读"，
与 `model`/`effort` 首次 claim 才落值直接冲突 —— 一条 create 时 `model` 为 null 的 Session，
要么违反"全部只读"，要么违反 S1，两个实现都能引用 v1 的契约。v1.1 消除这个二义。

**S5（resolution 与实际值可以不同，且这是对的）**：`resolution.with.model` 记录**解析当时决定了什么**
（Agent 没配 model 时它就是 `null`）；`session.model` 记录**实际跑的是什么**（首次 claim 后被 materialize）。
两者不同不是漂移，是两个不同的问题的答案。**首次 claim 绝不回写 `resolution`** —— 回写会让快照变成一个
可变视图，正是 §6 存在的理由的反面。05D 展示 Session 详情时必须同时展示两者并说明差异来源。

---

## 7. 三条解析链

三条链**顺序执行、互不传参**。任何实现里出现"因为 Agent 是 X 所以机器选 Y"都是对 R3 的违反。
本节全部规则**只适用于 `executionContract = 'V1'` 的 Task**；LEGACY 走 §11.1。

### 7.1 WHO —— 谁做

| 优先级 | 输入 | 结果 |
|---|---|---|
| 1 | `task.assigneeAgentId` 非空 | 该 Agent。**必须**同时满足：属于 `task.projectId` 的 Team、`agent.enabled = true`、`agent.deletedAt IS NULL` |
| 2 | `task.assigneeAgentId` 为空 | **REFUSE** `WHO_UNRESOLVED` |

**没有第 3 优先级，没有兜底。** 尤其不得回落到 Coordinator Agent：Coordinator 拿到一件没人认领的活并默默做掉，正是"意外调度"的另一种形态。

- **H1**：Agent 被移出 Team / 被 disable / 被软删之后，指着它的 Task **拒绝派发**（`WHO_NOT_IN_TEAM` / `WHO_DISABLED`），而不是改派。
- **H2**：WHO 链**只读 Agent，不读 Workspace、不读 Runner**。
- **H3**：`WHO_UNRESOLVED` 只可能出现在 V1 Task 上。一条历史 Task 不会因为迁移就撞上它 —— 迁移把它 stamp 成 LEGACY（§11.1 L3），而 LEGACY 根本不进本节。
- **H4（两条拒绝的唯一优先级，v1.2）**：优先级 1 的校验按**固定顺序**判，第一个不满足的决定错误码，后面的不再判：
  ① 属于 `task.projectId` 的 Team —— 否则 REFUSE `WHO_NOT_IN_TEAM`（403）；
  ② `agent.enabled = true` 且 `agent.deletedAt IS NULL` —— 否则 REFUSE `WHO_DISABLED`（409）。
  **两条谓词可以同时为真**（一个 Agent 完全可以既被移出 Team 又被 disable），v1.1 因此对同一个输入有两个合法答案、
  两个不同的 HTTP 状态，而 `00.1` / `00.9` 只检查"码存在、谓词非空"，看不见这件事。
  v1.2 的唯一结论是 **`WHO_NOT_IN_TEAM` 胜**：成员资格是**授权边界**，可用性只是这个边界内部的状态。
  倒过来判会给一个根本不属于本 Project 的 Agent 配上 `WHO_DISABLED` 的 required action（"把它启用"），
  而那个动作做完之后仍然派不出去 —— 一条把人引向无效动作的错误信息比没有错误信息更贵。

### 7.2 WITH WHAT —— 用什么做

**Provider 与 Model 归 Agent。V1 Task 上没有 pin 这个概念**（§3.4 K1 的 CHECK 约束保证它连写都写不进去）。

| 优先级 | 输入 | 结果 |
|---|---|---|
| 1 | `agent.defaultProvider`（+ `agent.defaultModel`） | Agent 默认。`resolution.with.source = "agent-default"` |
| 2 | `agent.defaultProvider` 为空 | owner 级默认（今天是 `claude`），`model` 留 null 交给首次 claim materialize（§6 `model` 行）。`source = "owner-default"` |

- **P1（v1.1 改写）**：**任务级 pin 在 V1 路径上不存在。** v1 曾规定"task pin 赢"，与项目目标"Provider 与 Model 归属于 Agent 配置，Task 只指派 Agent"和 AC2"Provider 不再由普通 Task 直接配置"直接矛盾 —— 保留 pin 就等于 Provider 仍然由 Task 决定。v1.1 的唯一结论：`task.provider` / `task.model` 是 LEGACY 列，写到 V1 Task 上被 `TASK_PROVIDER_PIN_REFUSED` 拒绝（§12），**由数据库 CHECK 兜底**。要换引擎就换 Agent，或者改这个 Agent 的默认 —— 两者都是"谁做"或"这个身份用什么"的决定，都留在正确的层上。
- **P2**：**WITH 链绝不读 Workspace。** 既有的 `workspace.model` 旧桥（`resolveProviderExec` 的 `workspaceModel` 参数）在 V1 路径上**必须不被传入**；它只保留给 §11.1 legacy 路径。
- **P3**：Provider 是自定义 slug 时，仍走既有校验（`ModelProvider` 存在、enabled、属于本 owner 或全局）。校验失败 = 不可用，进 §7.4。
- **P4**：`effort` 与 provider/model 同链解析：`agent.defaultEffort` → null（用模型默认）。V1 Task 上同样没有 effort pin。
- **P5**：v1 路径**不再使用** `agentProviderSeed()`（"这个 workspace 上一次交互会话跑的是什么"）。那正是"位置决定引擎"的耦合本身：同一个目录上次有人用 Codex 试了一把，下一个 Task 就默默改跑 Codex。它只保留给 §11.1 legacy 路径。优先级 2 的 owner 级默认是一个**固定值**，不是一次推导。
- **P6（`with.source` 的封闭取值）**：V1 路径只允许 `agent-default` / `owner-default` / `agent-fallback`（§7.4 降级成功时）。`task-pin` 是 **LEGACY 路径专用**的取值，V1 的 `resolution` 里出现它即为缺陷。

### 7.3 WHERE —— 在哪里做

输入只有两个：Task 的显式 pin，和 Project 注册的候选集合。**Agent 不是输入。**

```
候选集 = project_workspace WHERE project_id = task.project_id
         AND workspace.deleted_at IS NULL
         AND workspace.enabled = true
         AND workspace.runner_id IS NOT NULL
需求集 = task.requiredCapabilities ∪ agent.requiredCapabilities        ← 唯一一处跨链取值，见 W-note
可行集 = { c ∈ 候选集 | 需求集 ⊆ runner(c).capabilities }
```

> **W-note**：`agent.requiredCapabilities` 参与 WHERE 链，是对 R3 的**唯一且受限的例外**，必须这样读：进入 WHERE 链的不是"Agent 是谁"，而是"这件事声明了什么机器需求"，Agent 只是这个需求的第二个书写位置。实现上必须先把两个集合合并成一个 `requiredCapabilities` 值再进入 WHERE 链，**WHERE 链的函数签名里不得出现 agent 参数**——这是 04A 可测的结构性约束。

| 优先级 | 条件 | 结果 |
|---|---|---|
| 1 | 候选集为空 | **REFUSE** `NO_PROJECT_WORKSPACE`。**这一条排在 pin 之前**，它是 C8 的全部内容 |
| 2 | `task.workspaceId` 非空 | 该 Workspace。**两道校验都要过**：(a) 它必须在候选集内 —— 不在则 REFUSE `WORKSPACE_PIN_NOT_A_CANDIDATE`，pin 不是绕过候选集这道安全边界的口子；(b) 它必须满足需求集 —— 不满足则 REFUSE `RUNTIME_REQUIREMENT_UNMET`。两种情况都**绝不改派**。`resolution.where.source = "task-pin"` |
| 3 | Default Workspace ∈ 可行集 | Default Workspace，`source = "project-default"` |
| 4 | 可行集非空 | 按 `project_workspace.position ASC, id ASC` 取第一个（确定性 tie-break），`source = "project-candidate"` |
| 5 | 可行集为空（此时候选集必非空，否则优先级 1 已经拦下） | **REFUSE** `RUNTIME_REQUIREMENT_UNMET`，错误信息必须列出：需求集、每个候选机器缺哪几个能力 |

- **C4**：`runner.capabilitiesReportedAt IS NULL`（旧 runner，从未上报）的机器，**需求集非空时视为不满足**，需求集为空时正常参与。"不知道"不能读作"具备"—— 这与既有 `runsAsRoot` 的 NULL 语义方向相反，是刻意的：那里 NULL 不该**移除**一个今天能用的模式，这里 NULL 不该**授予**一个未经证实的能力。
- **C5**：WHERE 链**永不**读 `workspace.targetRunnerId` / `workspace.targetLabels` / `runner.labels`。
- **C6**：可行集有多个时**不做负载均衡**。v1 要的是可预测，不是最优。
- **C7（v1.1 错误码闭合）**：优先级 1(a) 与优先级 5 是**两个不同的事实**，因此是两个码：pin 越界说明"这个 Project 有候选集，但你 pin 的不在里面"，候选集为空说明"这个 Project 还没注册任何执行位置"。v1 把两者压成同一个 `NO_PROJECT_WORKSPACE`，而 §12 对它的谓词只覆盖后者 —— 两个实现可以给出不同结果且都能引用契约。**WHERE 链只允许返回这三个码**：`WORKSPACE_PIN_NOT_A_CANDIDATE`、`RUNTIME_REQUIREMENT_UNMET`、`NO_PROJECT_WORKSPACE`，且 §12 的谓词与本表逐行一致（由契约自检测试断言）。
- **C8（交集的唯一优先级，v1.2）**：v1.1 把 pin 放在优先级 1、把"候选集为空"放在优先级 5，于是**候选集为空且 pin 非空**
  这一个输入同时命中两条规则：优先级 1(a) 要 `WORKSPACE_PIN_NOT_A_CANDIDATE`，优先级 5、C7 与 §12 要 `NO_PROJECT_WORKSPACE`，
  两个实现都能引用契约。v1.2 把"候选集为空"提到**优先级 1**，由此得到两条：
  - **候选集为空 ⇒ 恒为 `NO_PROJECT_WORKSPACE`，无论有没有 pin。** 这条错误说的是真话——"这个 Project 还没注册任何执行位置"；
    此刻告诉用户"你 pin 的那个不在候选集里"虽然也为真，却把人引向"改 pin"，而改成任何值都仍然派不出去。
  - **`WORKSPACE_PIN_NOT_A_CANDIDATE` 的谓词因此逐字含"候选集非空"**，§12 E2 声明的互斥性从一句声明变成优先级表的
    结构性后果：它不再依赖实现记得先判哪一条。`04C.12` 是这条的反例（空候选集 + 非空 pin）。

### 7.4 Explicit Fallback

**默认行为：Provider 不可用 = 任务运行失败。** 不静默换引擎，一次都不行。

只有 `agent.providerFallbacks` 非空时才降级，且：

1. 按数组顺序逐个尝试，第一个通过 P3 校验的胜出，`resolution.with.source = "agent-fallback"`。
2. 降级**成功**时，每一跳写进 `session.resolution.with.fallbackHops`，并落一条 `run_event`（type `provider_fallback`），用户能在 transcript 里看到"原定 X，X 不可用，按 Agent 配置降级到 Y"。
3. `providerFallbacks` 为空数组 → 不尝试任何备选，直接 REFUSE `PROVIDER_UNAVAILABLE`。
4. 全部备选都不可用 → REFUSE `PROVIDER_UNAVAILABLE`，错误必须携带**按序尝试过的完整列表**。
5. **WHO 链和 WHERE 链没有 fallback，一个都没有。** 换人做和换机器做都是业务决定，不是系统可以代劳的降级。
6. V1 Task 没有 provider pin（P1），因此不存在"pin 与 fallback 谁优先"的问题 —— 链条起点恒为 Agent 默认。

**AU-F（审计载体，v1.1）**：`run_event.session_id` 是**必填外键**，而 §5 的 REFUSE 发生在 Session 创建之前。
因此审计载体按"这次解析有没有产生 Session"分成互斥的两段，**永不同时**：

| 情形 | 有 Session？ | 审计落在哪 | 必须携带 |
|---|:---:|---|---|
| 解析成功（含降级成功） | 有 | `session.resolution.with.fallbackHops`（快照）+ 每跳一条 `run_event` | 每跳的 from / to / reason |
| 解析失败（fallback 耗尽、为空，或派发路径上的任何其它 §12 拒绝） | **无** | 一条 `project_blocker`：`kind` = §12 的错误码、`subject_type = 'TASK'`、`subject_id` = taskId、`detail` 携带证据 | 按序尝试过的 provider 列表、拒绝码、拒绝时刻 |
| 解析失败且由控制环发起 | 无 | 上一行的 blocker，**再加**既有的 `project_action.refusal_code` + `project_action.detail`（`result_session_id IS NULL`） | 同上 + 决策世系 |

- **AU-F1**：**没有 Session 就一条 `run_event` 都不写。** 这不是"尽力而为"，是一条可测的禁令：04A 必须有一条断言，
  provider 全不可用的解析结束后 `run_event` 的行数增量为 0。
- **AU-F2（每一列的唯一来源，v1.2 修正）**：`project_blocker` 的其余必填列按**三处**取值，每一列只有一处，
  本文件一处都不复制 —— 复制就是同一个 kind 在两处有两套默认值：

  | 列 | 唯一来源 |
  |---|---|
  | `owner` · `recovery` · `next_check_at` 的默认值 | PCC §11.2（`docs/project-coordinator-contract.md`）kind 表里**同一个 kind 那一行** |
  | `severity` · `required_action` | PCC §11.1 定义它们各自回答什么问题；逐 kind 的取值落在实现的 per-kind 策略表（`project-blocker.ts`），该表由 PCC §11.2 的行**逐条覆盖**，多一行少一行都红 |
  | `dedupe_key` · `lifecycle_generation` · `condition_version` | PCC §11.3（去重键与代次分配）与 PCC §7.2 TF2（`condition_version`） |

  v1.1 写的是"全部按 PCC §11.2 同一行取值"，而那张表只有五列 —— `severity` 与 `required_action` 根本不在里面。
  一个声称有唯一来源、实际上没有的列，就是下一个实现自己编一个默认值的地方。
  **本条的前提是那一行存在**：一个 §12 里有、PCC §11.2 里没有的码，AU-F2 无从取值，AU-F 也就落不下去（§12 E4）。
  行存在之后还有一步：那一行必须已经落进数据库 CHECK 与实现的策略表，否则写入时得到 `23514`。
  这一步不由本契约执行 —— 它由 PCC §12.1 指名的那条迁移步骤执行，本契约只要求那条步骤**存在且唯一**。
- **AU-F3**：人发起（API/CLI/MCP 直接启动任务）与控制环发起，**blocker 的写法完全相同**。差别只有"控制环额外有一条
  `project_action`"。让人发起的拒绝不落库，等于把最常见的那条失败路径变成只存在于一次 HTTP 响应里的东西。
- **AU-F4**：blocker 是**去重**的（既有 `dedupe_key` + partial unique）。同一个 Task 因同一个原因连续被拒不会产生第二行，
  只更新既有行的时钟 —— 这是既有 blocker 语义，PAC 不另立规则。
- **AU-F5（required action 不得指向一个不存在的动作，v1.2）**：`PROVIDER_UNAVAILABLE` 的 required action 在 v1.1
  之前写的是"等它回来，或者把任务 pin 到一个可用的 provider"。**V1 Task 上没有 pin** —— §3.4 K1 的 CHECK 让它连写
  都写不进去，照做只会得到一个 `TASK_PROVIDER_PIN_REFUSED`。唯一正确的指引是"改这个 Agent 的默认 Provider，
  或者给它配一条显式 fallback"：两者都留在"这个身份用什么"这一层上（§7.2 P1）。
  这不是文案问题 —— 一条把人引向 400 的恢复指引，与"静默跳过"在结果上是同一件事。

### 7.5 `session.resolution` 结构（冻结）

```jsonc
{
  "v": 1,
  "who":   { "agentId": "<uuid>", "source": "task-assignee" },
  "with":  { "provider": "codex", "model": "gpt-5.6-sol", "effort": null,
             "source": "agent-default" | "owner-default" | "agent-fallback",
             "pinned":  { "provider": "kimi", "model": null },      // 仅在发生降级时出现：链条起点
             "fallbackHops": [ { "from": "kimi", "to": "codex", "reason": "PROVIDER_UNAVAILABLE" } ] },
  "where": { "workspaceId": "<uuid>", "runnerId": "<uuid>",
             "source": "task-pin" | "project-default" | "project-candidate",
             "required": ["macos","xcode"],
             "candidatesConsidered": 3 }
}
```

- `v` 必须写，且读方必须容忍未知版本（跳过展示，不报错）。
- 三个 key **恒存在**，即使某条链走的是默认值 —— 一个缺失的 key 和一个 "用了默认" 是两件不同的事。
- **本结构里恰好有三个 id**：`who.agentId`、`where.workspaceId`、`where.runnerId`。内部落库为 UUID，出站按 §10 B3 **三个全部**编成 base62。
- LEGACY 路径若产出 `resolution`，`with.source` 可以是 `task-pin`（§7.2 P6）；V1 路径出现它即为缺陷。

---

## 8. 授权矩阵

### 8.1 主体（Principal）

| 主体 | 身份来源（唯一判据） | 说明 |
|---|---|---|
| **Owner** | 用户 JWT | 项目所有者。终极控制权 |
| **Coordinator Session** | `session.id = project.coordinatorSessionId` | 该 Project 的协调对话。**这是 Coordinator 权限的全部来源** |
| **Member Session** | `session.agentId` 非空且 ∈ 该 Project 的 Team（`project_member`） | 执行中的成员 Agent |
| **Runner** | runner token | 只做心跳与运行回报 |
| **Service Token** | 服务令牌 | 既有能力，v1 不扩展 |

- **PR1（Coordinator principal 唯一化，v1.1）**：一个请求**当且仅当**它来自 `project.coordinatorSessionId` 所指的那条 Session 时，
  携带该 Project 的 Coordinator 权限。判据只有这一条等式，**不读 `session.agentId`，不读 `project_member`**。
  `coordinatorSessionId` 为 NULL 时，该 Project **没有** Coordinator 主体，所有 ⚠a/⚠c 的操作一律 403。
- **PR2（Coordinator Agent 不授权）**：`project_member.role = COORDINATOR` 是**归属与展示**：一次协调判断记在谁名下
  （`project_decision.coordinator_agent_id`）、UI 上团队里谁挂着协调者的牌子。它**永不**参与鉴权判断。
- **PR3（为什么这样切）**：v1 把 Coordinator 身份写成"会话上下文 + Team 中 COORDINATOR"，同时在 O2 里说不强制
  Coordinator Session 与 Coordinator Agent 绑定 —— 于是"`coordinatorSessionId = S` 而 `S` 的 Agent 是 `B` 或为空"
  这个**今天生产库里普遍存在**的状态没有唯一答案。v1.1 选择"权限归 Session"而不是"权限归 Agent + 强制绑定"，
  理由有三：① 绑定要求 `session.agent_id` 非空，而所有既有协调会话都为空，强制绑定 = 迁移当天所有 Coordinator 失权（违反 AC8）；
  ② `coordinatorSessionId` 的写入路径是服务端从鉴权上下文推导、且带 409 重绑保护的（既有 schema 注释），它本来就是一次被 owner
  认可的绑定；③ 权限归 Session 与 R3 一致：授权是"这段对话被授权了"，不是"这个身份天生有权"。
- **PR4（Member principal 的迁移安全）**：`session.agentId` 是 v1 新列，既有会话全为 NULL，因此**迁移前的任何会话都不是
  Member 主体**，所有 ⚠b/⚠d 操作对它们 403。这不是回归 —— 迁移之前"Member Session"这个主体根本不存在，没有任何既有
  行为依赖它。

### 8.2 矩阵

`✔` 允许 · `✘` 拒绝（403）· `⚠` 受限，见脚注

| 操作 | Owner | Coordinator | Member | Runner |
|---|:---:|:---:|:---:|:---:|
| 改 Project goal / acceptanceCriteria / instructions | ✔ | ✘ | ✘ | ✘ |
| 删 Project | ✔ | ✘ | ✘ | ✘ |
| 增 / 删 Project Member | ✔ | ✘ | ✘ | ✘ |
| 设 / 换 Coordinator Agent | ✔ | ✘ | ✘ | ✘ |
| 注册 / 移除 Project Workspace、设 Default Workspace | ✔ | ✘ | ✘ | ✘ |
| 创建 Agent、改 Agent 配置（含 provider / fallback / 权限位） | ✔ | ✘ | ✘ | ✘ |
| 在 Project 内建任务 / 建任务树 | ✔ | ⚠a | ⚠b | ✘ |
| 指派 Task 给某 Agent | ✔ | ⚠c | ⚠d | ✘ |
| 改 Task 的 requiredCapabilities | ✔ | ⚠c | ✘ | ✘ |
| pin `task.workspaceId` | ✔ | ⚠c | ✘ | ✘ |
| 把 LEGACY Task 晋升为 V1（§11.1 L4） | ✔ | ⚠c | ✘ | ✘ |
| 改 Task 的 provider / model pin（**只对 LEGACY Task 存在**，§3.4 K1） | ✔ | ✘ | ✘ | ✘ |
| 派发 / 运行 Task | ✔ | ⚠c | ⚠d | ✘ |
| 上报 `runner.capabilities` | ✘ | ✘ | ✘ | ✔ |
| 读 Project / Team / Task / Session 快照 | ✔ | ✔ | ✔ | ⚠e |

- **⚠a** Coordinator 必须 `canCreateTasks` 为真（§8.3 的有效值），且只能在**自己所属的那个 Project** 内建。这里的
  "Coordinator 的权限位"取 §8.1 PR2 所指的 Coordinator Agent 那一行的有效值 —— 权限**判定主体**是 Session（PR1），
  **权限位来源**是该 Project 的 Coordinator Agent；两者是"谁在说话"和"这个角色被允许做什么"，不是同一个问题。
  Project 没有 Coordinator Agent 时，权限位取 `agent.*` 的缺省 `false`，即 Coordinator Session 建不了任务。
- **⚠b** Member 必须 `canCreateTasks` 为真，且**只能在自己正在执行的那个 Task 下建子任务**（`parentTaskId` = 当前 Session 的 `taskId`）。不得建顶层任务，不得跨 Project。
- **⚠c** 仅限本 Project；被指派的 Agent 必须是本 Project 的 Team 成员。
- **⚠d** Member 默认只能指派给**自己**（即当前 Session 的 `agentId`）；`canDelegate` 为真时可指派给同 Team 的其他 Agent。
- **⚠e** Runner 只能读它自己被分派的 Session，既有约束不变。

### 8.3 权限位的有效值（收窄语义）

```
effective(bit) = agent.<bit> AND (project_member.<bit> ?? true)
```

**项目级只能收窄不能放宽。** 一个 `canDelegate = false` 的 Agent 加进任何 Project 都不会获得转派权。写入时若 `project_member.<bit> = true` 而 `agent.<bit> = false`，接口**拒绝**（`PERMISSION_WIDENING_REFUSED`）而不是静默取 AND —— 静默会让人以为自己开了权限。

### 8.4 指派校验（03C 的核心）

Task 的 `assigneeAgentId` 写入时必须全部通过，任一失败即 400/403：

1. Task 有 `projectId`（无 Project 的 Task 不能用 `assigneeAgentId`）。
2. 目标 Agent ∈ 该 Project 的 Team。
3. `agent.enabled` 且未软删。
4. 写入者按 §8.2 有权指派。
5. 写入后的行满足 §3.4 K1（provider / model 均为 NULL）；否则 `TASK_PROVIDER_PIN_REFUSED`。同一个请求里
   把 pin 清空并指派 Agent 是**允许**的 —— 校验的是**写入后的状态**，不是写入前的。

**四个写路径都要校验**：`POST /tasks`、`PATCH /tasks/:id`、`POST /tasks/batch-create`、`POST /tasks/batch-assign`。少一处就是一个静默绕过口。

---

## 9. 线上命名（wire naming）

### 9.1 冻结的映射

| 面 | v1 含义 | 状态 |
|---|---|---|
| REST `/workspaces` | **Workspace** | 稳定，语义不变 |
| REST `/agents` | **Agent**（新表） | v1 新增 |
| REST `/projects/:id/team` | **Project Member** | v1 新增 |
| REST `/projects/:id/workspaces` | **Project Workspace** | v1 新增 |
| MCP `agent_list` / `agent_create` / `agent_update` | **Workspace**（Legacy agent alias） | **冻结 + deprecated**，行为一字不改 |
| CLI `orbit agent …` | **Workspace**（Legacy agent alias） | **冻结 + deprecated** |
| CLI `orbit workspace …` | Workspace | v1 新增，`orbit agent` 的推荐拼法 |
| MCP `team_list` / `team_add` / `team_remove`、CLI `orbit project team …` | Project Member + Agent | v1 新增 |
| `project.coordinatorAgentId`（既有响应字段） | 迁移前是 workspace id，迁移后是 **agent id** | **语义随 §11.2 步骤 4 一起改变**，见 §11.4 |

### 9.2 为什么不改 `agent_*` 的指向

改指向会让所有已有 agent 的记忆、脚本和 iOS/macOS 客户端在**不报错**的情况下开始操作另一张表。既有教训明确：删列 / 改 wire 语义而原生端没跟，只会静默漏改。因此 v1 的规则是：

- **旧拼法保持旧含义**，只加 deprecation 提示与 `kind: "workspace"` 判别字段。
- **新实体用新名字**，不复用任何旧拼法。
- 摘掉 deprecated 别名不在 v1 范围，需等原生端跟进后另开任务。

---

## 10. Base62 Public ID 契约

所有对外 id 一律 base62（`src/shared/src/codec.ts`），内部一律 UUID。**这是本项目最容易静默出错的一处**：只编码不解码的字段不会产生任何类型错误，它会一路走到 `where` 子句或 `::uuid` 转换，要么 500，要么永远比较不相等。

`agentId` 与 `coordinatorAgentId` **已经在** `PUBLIC_ID_FIELDS` 里（0111 的协调者 API 加的，当时它们名指 workspace 行；
v1 重指向后名字不变、含义变成 `agent` 行，编解码规则不受影响）。v1 还必须加入的字段（**编解码两个方向共用这一张表**）：

```
assigneeAgentId      legacyWorkspaceId     projectMemberId
projectWorkspaceId   defaultWorkspaceId    agentIds
workspaceIds
```

- **B1**：`src/apiserver/src/common/public-id-coverage.spec.ts` 会遍历 `schema.prisma`，**任何新增的 `@db.Uuid` 列若不属于 `PUBLIC_ID_FIELDS` 或 `NEVER_PUBLIC_ID_FIELDS`，`npm test -w @orbit/apiserver` 就红**（该 spec 由 `node --test` 跑，不在 `npm run build` 里）。02A–02E 每新增一列都必须同时更新 `codec.ts` 那张表 —— 这是本契约里唯一被既有测试自动强制的条款，其余条款靠 §13 的用例与本文件的自检 spec。
- **B2**：`agent.legacyWorkspaceId` 属于 `PUBLIC_ID_FIELDS`（它是一个可被交还的地址）。
- **B3（v1.1 扩展到全部三个 id）**：`session.resolution` 里的 id 是 **JSON 里的值，不是列**，编解码器不会自动处理。
  §7.5 的结构里**恰好有三个** id，出站时**三个全部**必须是 base62：

  | JSON 路径 | 内部 | 出站 |
  |---|---|---|
  | `resolution.who.agentId` | `agent.id` UUID | base62 |
  | `resolution.where.workspaceId` | `workspace.id` UUID | base62 |
  | `resolution.where.runnerId` | `runner.id` UUID | base62 |

  04A/05D 必须显式在出站序列化时转换，并有一条**结构化**测试：不是逐个断言三个字段，而是遍历 `resolution` 的整棵 JSON 树，
  断言**任何**看起来像 UUID 的字符串都不存在（`/^[0-9a-f]{8}-[0-9a-f]{4}-/i` 命中即失败）。逐字段断言正是 v1 只写了
  `who.agentId` 而漏掉另外两个的原因；遍历式断言让 §7.5 以后再加 id 时不会静默漏掉。这与 `focusTaskId` / `sourceTaskId` 当年的坑同型。
- **B4**：接受两种拼法入站（`IsPublicId` / `PublicIdPipe`），出站只发 base62。
- **B5**：哨兵词（如 `listId=none`）必须在**解码处**声明，不能指望调用方；`none` 恰好是合法 base62，会被解成一个不存在的 UUID 从而静默返回空集。新增的 `agentId=` / `workspaceId=` 过滤参数若要支持"未指派"哨兵，必须走同一处声明并有 route 层测试。

---

## 11. 兼容矩阵

### 11.1 旧数据：分流判据与三类历史 Task

现状：`task` 表约 11 万行，绝大多数 `project_id` 为 NULL、`assignee_id` 指向 `workspace`；**也有一部分 `project_id` 非空**
（`feat/project` 上的 Project 功能已经在用）。v1.1 用 `task.execution_contract` 一列把它们分开，而不是用 `project_id IS NULL`：

| 类别 | 判据（迁移后） | 走哪条路径 |
|---|---|---|
| 历史的无 Project Task | `execution_contract = 'LEGACY'` 且 `project_id IS NULL` | legacy |
| **Legacy Project Task** | `execution_contract = 'LEGACY'` 且 `project_id IS NOT NULL` | legacy |
| 迁移后新建、且**创建请求显式带 `assigneeAgentId`** 的 Project Task（L5） | `execution_contract = 'V1'` | §7 三条链 |

**规则 L1**：`execution_contract = 'LEGACY'` 的 Task 走 **legacy 路径**，行为与 v1 之前**逐字节相同**：

| | legacy 路径 | v1 路径 |
|---|---|---|
| 触发条件 | `task.executionContract = 'LEGACY'` | `task.executionContract = 'V1'` |
| WHO | 无（不存在 Agent 概念） | §7.1 |
| WITH | `task.provider/model` → `agentProviderSeed(workspace)` → `workspace.model` 旧桥 | §7.2（**不读** `workspace.model`，也**没有** task pin） |
| WHERE | `task.assigneeId` → `workspace.runnerId` | §7.3 |
| Runtime Requirement | 不检查 | §7.3 |

- **L2（v1.1 替换 v1 的 L2）**：v1 规定"一个 Task 一旦被填上 `projectId` 就立刻切到 v1 路径"，同时 M1 规定不回填
  `assignee_agent_id` —— 于是**每一条既有 Project Task 在迁移后的第一次派发都会 `WHO_UNRESOLVED`**，
  直接违反 AC8。v1.1 的唯一结论：**切换由 `execution_contract` 决定，而不是由 `project_id` 是否为空决定**，
  迁移把所有既有行 stamp 成 LEGACY（L3），因此**迁移不改变任何一条既有 Task 的可运行性**。
- **L3（迁移 stamp = 列默认值）**：`execution_contract` 的列默认是 `'LEGACY'`，所以**加列这一个动作**就把迁移时刻
  已存在的每一行 stamp 成 LEGACY —— 不需要 `UPDATE`，也就不存在“更新一半失败”的中间态。这是 0111 给
  `coordinator_enabled` 用的同一手法：默认值是**老行要保留的值**，新行的值由服务显式写。
  迁移之后新建的 Task 里，只有**既带 `projectId`、创建请求里又显式带 `assigneeAgentId`** 的那些被服务写成 `V1`
  （唯一规则 §11.1 L5；`projectId` 只是必要条件，§3.4 K3）；
  在迁移落地与新代码上线之间的窗口里，老代码建的行照样是 LEGACY，行为不变。
- **L4（晋升：唯一的 LEGACY → V1 通道）**：给一条 Legacy Project Task 写入 `assigneeAgentId` 时，服务层在**同一个事务**里
  把 `execution_contract` 置为 `'V1'`。晋升必须同时满足 §8.4 的五条（含 K1：写入后 provider/model 为 NULL），
  否则整个请求 400/403 且**什么都不改**。带 pin 的历史任务因此得到一个明确的动作而不是一次静默的行为漂移：
  同一个 PATCH 里清掉 pin 并指派 Agent 即可。
- **L5（新建 Project Task 的分流由请求形状决定，v1.2 重写）**：服务层在创建**属于某个 Project** 的 Task 时，
  **当且仅当**请求里显式携带了 `assigneeAgentId` 才写 `execution_contract = 'V1'`；没带的那些落列默认 `LEGACY`。
  一条规则同时回答两件事：新客户端建的任务立刻进三条链（05B/05C 的创建表单把 `assigneeAgent` 做成必填项，`05C.2`），
  而**旧客户端**建出来的 Project Task 落成 Legacy Project Task —— 派发逐字段与 v1 之前相同，
  并在新 UI 上按 §11.4 标注"未迁移"、给一个 L4 晋升入口。
  v1.1 写的是"新建的 Project Task 一律 V1，因此创建时必须给 `assigneeAgentId`"，与 §11.4"旧端照常读写 Task"
  直接冲突：旧端根本不知道有这个字段，于是要么被 400 拒（旧端崩），要么建出一条第一次派发必然 `WHO_UNRESOLVED`
  的任务。**用"请求里有没有这个字段"分流**是唯一不需要旧端改一行代码的答案，也与 K3、L3 是同一条纪律：
  **默认值是老行为，新行为由一次显式写入触发。** `06B.8` 用录制的旧端载荷跑这条。
  **本条是 `execution_contract` 写入规则的唯一规范来源**，三种请求形状各有且只有一个结论：

  | 创建请求的形状 | 落到 `execution_contract` | 条款 |
  |---|---|---|
  | 没有 `projectId` | `LEGACY` | §3.4 K3（列默认值） |
  | 有 `projectId`，**显式**带 `assigneeAgentId` | `V1` | 本条 |
  | 有 `projectId`，**省略** `assigneeAgentId` | `LEGACY` | 本条 · §11.4 · `06B.8` |

  §3.4 的字段表、K3、L3、`02C.2`、§11.4 与 `06B.8` 都只是本表的引用；**正文里任何一句"带 `projectId` 就写 `V1`"
  都是缺陷** —— v1.2 恰好留了四句，于是同一个旧端请求按不同段落得到 `V1` 与 `LEGACY` 两个答案（`00.17` 扫描它，
  并对两种录制的旧端载荷各断言一个唯一结果）。
- **L6**：`task.assigneeId`（workspace）**不删列、不改语义**。在 V1 路径下它不参与解析，但仍被写入与展示，供旧客户端与历史查询使用。

### 11.2 迁移 `0128_project_agent_identity`（02A–02E 合并为一次迁移）

编号按合并时刻的下一个可用值；本文冻结时 `feat/project` 的最新迁移是 `0127_project_acceptance_run`，故为 **0128**。**PCC §12.1 步骤 6j 的 blocker CHECK 迁移（§12 E4）也还没落地**，两者谁先合并谁拿 0128，另一个顺延 —— 本契约一律按**名字**引用自己这一支，编号被占用时只改名字不改规则。
本契约其余部分一律按**名字**引用它，编号被占用时只改名字不改规则。

| 步骤 | 内容 | 幂等性 |
|---|---|---|
| 1 | 建表 `agent` / `project_workspace`；建枚举 `TaskExecutionContract`。**`project_member` 与枚举 `project_role` 已由 0111 建立，本迁移不重建** | prisma migrate 单次 |
| 2 | 加列：`task.assignee_agent_id` / `task.workspace_id` / `task.required_capabilities` / `task.execution_contract`；`project_member.can_create_tasks` / `can_delegate` / `position`；`runner.capabilities` / `capabilities_reported_at`；`session.agent_id` / `required_capabilities` / `resolution` / `snapshot_frozen_at` | 全部**可空或有默认**，无 NOT NULL 无默认列 |
| 3 | **回填 Agent 镜像**：为镜像集（§3.2 T5：未软删的 workspace ∪ 被 `project_member` 引用的 workspace）的每一行插入一条 `agent`，`legacy_workspace_id = workspace.id`，`name` = workspace.name（重名时追加 ` (2)`…），`system_prompt` / `append_system_prompt` / `default_model` / `default_effort` / `disallowed_tools` 从 workspace 同名列复制，`default_provider = NULL`（保持派生行为），`required_capabilities = '{}'`，权限位全 `false`，`deleted_at` 随源 workspace | 以 `legacy_workspace_id` 唯一键作 `ON CONFLICT DO NOTHING` |
| 4 | **保序重指向 `project_member.agent_id`**（§3.2 T4）：同一事务内**按这个顺序**三条语句 —— ① `ALTER TABLE project_member DROP CONSTRAINT IF EXISTS project_member_agent_id_fkey`（先摘掉指向 `workspace` 的旧外键）；② `UPDATE project_member m SET agent_id = a.id FROM agent a WHERE a.legacy_workspace_id = m.agent_id`；③ `ALTER TABLE project_member ADD CONSTRAINT project_member_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES agent(id) ON DELETE RESTRICT`。**顺序不可交换，理由是 M7。** 不 DROP TABLE、不 DELETE、不换 `id`；`project_member_project_id_agent_id_key`、`project_member_coordinator_idx`、`project_member_agent_id_idx` 三个索引原地存活 | ① 已经是 `IF EXISTS`；② 重跑时匹配不到行（`agent_id` 已是 agent id）→ 0 行更新；③ 固定约束名，重跑前同名 `DROP CONSTRAINT IF EXISTS` 已由 ① 完成 |
| 5 | **回填 Project Workspace**：`project.coordinator_workspace_id` 非空的 Project 插入一条 `project_workspace(is_default = true)` | `ON CONFLICT (project_id, workspace_id) DO NOTHING` |
| 6 | **既有行的 stamp 由列默认值完成**（L3）：步骤 2 加列时默认 `'LEGACY'`，11 万行**一行都不用 UPDATE**。本步骤只做一条断言式校验：`SELECT count(*) FROM task WHERE execution_contract <> 'LEGACY'` 必须为 0 | 无写入，天然幂等 |
| 7 | **不回填** `task.assignee_agent_id` | 见 M1 |
| 8 | 加 CHECK 约束 `task_v1_has_no_provider_pin`（§3.4 K1）。**必须在步骤 2 之后**：列默认 `'LEGACY'` 已经让每一条带 pin 的历史行满足约束，因此 `ADD CONSTRAINT` 不需要 `NOT VALID`，一次全表校验就能过 | `ADD CONSTRAINT` 固定名 |
| 9 | 建索引：A2 / W1 / W2 与 `agent(@@index([ownerId]))`。W2 是 partial unique index，schema.prisma 表达不了，需在 migration SQL 里手写（既有先例：0108 的 partial index、0111 的 `WHERE role = 'COORDINATOR'`、0110 的 `WHERE run_at IS NOT NULL`） | `CREATE UNIQUE INDEX IF NOT EXISTS` |

- **M1（关键）**：**绝不回填 `task.assignee_agent_id`**。回填等于替 11 万行历史任务替用户做了"谁做"的决定。
  留空是安全的，因为步骤 6 已经把它们全部 stamp 成 LEGACY —— 它们根本不进 WHO 链（§11.1 L2）。
- **M2**：Agent 镜像**不是**只覆盖未软删的 workspace，而是 §3.2 T5 的并集。软删来源的镜像行带 `deleted_at`，不出现在任何选择器里，
  但它必须存在，否则步骤 4 的外键会在任何一条指向软删 workspace 的 `project_member` 上直接失败。
- **M3**：迁移必须能在**空库**和**生产快照**上各跑一次并 diff 为空。验证手法：一次性 throwaway postgres 容器跑 `prisma migrate deploy` + `prisma migrate diff`，并 `grep` 自己新增的列名，而不是看 drift 总数。
- **M4**：迁移**不包含** `DROP COLUMN`、**不包含** `DROP TABLE`。`workspace.model` / `system_prompt` / `target_runner_id` / `target_labels` 全部保留；
  步骤 4 的 `DROP CONSTRAINT` 是换外键目标，不是删数据，两者不可混为一谈（06B 的 grep 用例按 `DROP COLUMN` / `DROP TABLE` 两个词判，不按 `DROP` 判）。
- **M5（重指向的可断言性）**：步骤 4 前后必须各取一次 `SELECT id, project_id, role, added_at FROM project_member ORDER BY id` 的快照并 diff，
  差异只允许出现在 `agent_id` 上；行数、每个 Project 的 COORDINATOR 是否存在，都必须逐行相等。
- **M7（步骤 4 的顺序是可执行性本身，不是风格，v1.2）**：0111 建的 `project_member_agent_id_fkey` 指向 `workspace(id)`，
  且它**非延迟、即时校验**（0111 没写 `DEFERRABLE`）。因此把 `agent_id` 改成一个 `agent.id` 的那条 UPDATE
  会在**语句执行的那一刻**被这条旧外键拒绝：

  ```
  ERROR:  insert or update on table "project_member" violates foreign key constraint "project_member_agent_id_fkey"
  DETAIL:  Key (agent_id)=(…) is not present in table "workspace".
  ```

  v1.1 写的顺序是"先 UPDATE、再 DROP"，它在**空表**上跑得过（没有行要校验），在**任何一条真实 0111 数据**上必然失败 ——
  这正是"迁移在空库上绿、在生产快照上红"的经典形状，也是 M3 要求两种库各跑一次的原因。
  三条语句唯一可执行的顺序是 **DROP → UPDATE → ADD**：

  - **中间态是安全的**：① 与 ③ 之间 `agent_id` 短暂没有外键保护，但三条在**同一个事务**里，别的会话看不到这个中间态；
    ③ 的 `ADD CONSTRAINT` 对全表做一次校验，任何一个没有镜像的旧值都会让**整个迁移**失败回滚 —— 这正是我们要的失败方式
    （T5 的镜像集少一条并集，红在这里，而不是在生产上留下半张表）。
  - **回滚**：三条在一个事务里，任何一条失败即整体回滚，`project_member` 逐字节回到迁移前，**包括那条旧外键**（① 的 DROP
    同样被回滚）。因此**不需要、也不允许**写一个"反向迁移"脚本：一个要人手动执行的补偿动作等于没有回滚。
  - **前后断言**（`02B.7` / `06B.3` 必须在**真实 0111 外键形状**上跑，不是在一张新建的裸表上）：① 之前取快照
    `A = SELECT id, project_id, agent_id, role, added_at FROM project_member ORDER BY id`，③ 之后取同样的快照 `B`，断言
    `count(A) = count(B)`、`A[i].(id, project_id, role, added_at) = B[i].(…)` 逐行相等、
    `B[i].agent_id = (SELECT id FROM agent WHERE legacy_workspace_id = A[i].agent_id)` 逐行成立（双射），
    并从 `pg_constraint` 读出 `confrelid` 已指向 `agent` 而不是 `workspace`。
  - **最小反例**：一行 `project_member(P, W)` 加一条 `agent(A, legacy_workspace_id = W)`，按 v1.1 的顺序执行第一条 UPDATE
    立刻得到上面那个 `23503`；按 v1.2 的顺序执行三条语句全部成功。这条反例可以在一个只建了 `workspace` / `project` /
    `project_member` / `agent` 四张表的 throwaway postgres 上复现，不需要整库。
- **M6（历史审计列不重写）**：`project_decision.coordinator_agent_id`、`project_acceptance_run.coordinator_agent_id` 等**无外键的历史审计列**
  保持原值（它们记录的是"当时是谁"，指向 workspace id）。重写历史等于篡改审计。读方按行的 `created_at` 与迁移时刻比较来解释它，
  或者干脆只把它当不透明 id 展示。

### 11.3 已存在但无人读取的字段（v1 不复活）

`workspace.targetRunnerId` 与 `workspace.targetLabels` 今天有写路径（`workspaces.service.ts`）却**没有任何读路径**参与调度。v1 **不**把它们接进 WHERE 链：位置选择只走 §7.3。02E 需在文档/注释里标注它们为 dead config，但**不删除**（同 §11.1 L6 的理由：删列会让原生端静默漏改）。

### 11.4 客户端 × 服务端兼容

| 组合 | 期望行为 |
|---|---|
| **旧 web / iOS / macOS × 新服务端** | 所有既有接口形状不变。新字段以**可选字段**追加。旧端看不到 Agent/Team，但能照常读写 Project、Task、Session。绝不允许出现"旧端拿不到必填字段而崩溃"的响应 |
| **新 web × 旧数据** | Project 无 Team 时，团队区展示空态 + "添加成员"，不报错；Legacy Project Task 展示 legacy 的 workspace assignee 并标注"未迁移"，附一个"指派 Agent 以启用新调度"的动作（即 L4 晋升） |
| **`coordinatorAgentId` 的语义迁移** | 该字段的**值域**在步骤 4 之后从 workspace id 变成 agent id。旧端把它当 workspace id 去 `GET /workspaces/:id` 会 404。因此 v1 必须在同一批次里让 `/projects/:id` 同时返回 `coordinatorAgent: { id, name, kind: "agent" }` 的展开对象，旧端读名字不读 id；05B 与原生端的最低要求是**不因为 404 而白屏** |
| **新服务端 × 旧 runner（未上报 capabilities）** | 按 §7.3 C4：需求集为空照常派发，需求集非空则拒绝并提示"该机器的 orbit 版本过旧，无法确认能力" |
| **新 runner × 旧服务端** | 心跳里多出的 `capabilities` 字段被忽略，不报错 |
| **MCP / CLI 旧拼法** | 按 §9.2 保持旧含义 |
| **旧客户端创建 Project Task** | 载荷里没有 `assigneeAgentId`（`POST /tasks`、`POST /tasks/batch-create`）：接口**照常 201**，行落 `execution_contract = 'LEGACY'`（§11.1 L5），派发走 legacy 路径、结果与 v1 之前逐字段相同。**绝不 400**，也绝不建出一条第一次派发必然 `WHO_UNRESOLVED` 的 V1 行。新 UI 上它是一条 Legacy Project Task（上一行），带 L4 晋升入口。`06B.8` 用录制的旧端载荷跑这条 |
| **MCP / CLI 的 `provider` / `model` 参数** | 对 LEGACY Task 行为不变；对 V1 Task 返回 `TASK_PROVIDER_PIN_REFUSED` 并在错误文案里指出"Provider 现在配置在 Agent 上"。**不静默忽略** —— 静默忽略会让脚本以为自己换了引擎 |
| **原生端（iOS/macOS）** | v1 **不要求** iOS/macOS 跟进 Agent/Team UI。它们必须做到的只有两件事：**不因为新字段而崩溃或误显示**，以及 `coordinatorAgentId` 取不到对应 workspace 时不白屏。Swift 端对新增可选字段的解码必须验证过（既有教训：wire 变更而 Swift 未跟进会静默漏改） |

### 11.5 版本投递

runner 侧的任何改动（02E 的 capability 上报、05A 的 CLI）**必须同时 bump 版本号并重建 web 镜像**，否则旧 runner 会静默丢掉新功能。这是既有部署纪律，不是本项目新增。

---

## 12. 错误码（冻结）

所有拒绝都必须落在下表内，且携带可读的 `message`。**没有"静默跳过"这个选项**：派发被拒必须让用户看得到，
且必须按 §7.4 AU-F 落一条 `project_blocker`（派发路径）或返回给写入方（写入路径）。

| code | HTTP | 路径 | 何时 | 必须携带的信息 |
|---|---|---|---|---|
| `WHO_UNRESOLVED` | 409 | 派发 | V1 Task 没有 `assigneeAgentId` | taskId |
| `WHO_NOT_IN_TEAM` | 403 | 派发 | 指派 / 派发时 Agent 不在 Team。**与下一行同时为真时本行胜**（§7.1 H4） | agentId, projectId |
| `WHO_DISABLED` | 409 | 派发 | Agent 在 Team 内、但被 disable 或软删 | agentId |
| `PROVIDER_UNAVAILABLE` | 409 | 派发 | Provider 校验失败且 fallback 链为空或耗尽 | 按序尝试过的 provider 列表 |
| `RUNTIME_REQUIREMENT_UNMET` | 409 | 派发 | 候选集非空但可行集为空，或 pin 的 Workspace 在候选集内却不满足需求 | 需求集 + 每个候选缺哪些能力 |
| `NO_PROJECT_WORKSPACE` | 409 | 派发 | Project **一个候选 Workspace 都没有**（候选集为空）。**此时有没有 pin 都是本行**（§7.3 C8） | projectId |
| `WORKSPACE_PIN_NOT_A_CANDIDATE` | 409 | 派发 | 候选集**非空**，而 `task.workspaceId` pin 的 Workspace **不在**其中 | taskId, workspaceId, projectId |
| `TASK_PROVIDER_PIN_REFUSED` | 400 | 写入 | 往 V1 Task 上写 `provider` / `model`，或晋升时写入后的行仍带 pin | taskId, 字段名 |
| `TASK_CONTRACT_NEEDS_PROJECT` | 400 | 写入 | 把无 Project 的 Task 置为 `execution_contract = 'V1'`，或给它写 `assigneeAgentId` | taskId |
| `PERMISSION_WIDENING_REFUSED` | 400 | 写入 | `project_member` 想放宽 Agent 的权限位 | 字段名 |
| `TEAM_COORDINATOR_EXISTS` | 409 | 写入 | 已有 Coordinator 时再设一个 | 现任 agentId |
| `AGENT_IN_USE` | 409 | 写入 | 删 Agent 但仍有 `project_member` 引用 | 引用它的 projectId 列表 |
| `WORKSPACE_IN_USE` | 409 | 写入 | 移除 Project Workspace 但有 Task pin 着它 | taskId 列表 |

- **E1（闭合性）**：§5 / §7 / §8 / §11 中每一处写作 `REFUSE <CODE>` 或 "`CODE`" 的错误码，都必须是本表的一行；
  本表的每一行也都必须在正文里至少被一处规则引用。两个方向都由契约自检 spec 断言 —— 一个只在错误码表里存在的码，
  和一个只在正文里存在的码，都是 v1 那种"两个实现都能引用契约"的来源。
- **E2**：新增码不得与既有码同义。`WORKSPACE_PIN_NOT_A_CANDIDATE` 与 `NO_PROJECT_WORKSPACE` 的谓词互斥
  （前者要求候选集非空，后者要求候选集为空），因此不存在同一输入落到两个码的情况。
  这条互斥**不靠实现自觉**：§7.3 把"候选集为空"放在优先级 1，两条谓词因此在结构上不可能同时为真（C8）。
- **E3（同一输入只有一个码，v1.2）**：本表的谓词两两互斥**或**由一条明写的优先级消歧。今天恰好有两组谓词
  可以同时为真，两组各有一条唯一结论：WHO 的 `WHO_NOT_IN_TEAM` ∩ `WHO_DISABLED` 由 §7.1 H4 定序（前者胜）；
  WHERE 的 `WORKSPACE_PIN_NOT_A_CANDIDATE` ∩ `NO_PROJECT_WORKSPACE` 由 §7.3 优先级 1 消掉（后者胜）。
  契约自检对这两组**各跑一次谓词交集**，不是只比对码的集合 —— v1.1 的 `00.10` 只比集合，两组交集因此全都漏了过去。
- **E4（派发路径的码必须落得下去，v1.2）**：`路径 = 派发` 的每一行都会按 §7.4 AU-F 落成一条 `project_blocker`，
  因此它**必须**是 PCC §11.2（`docs/project-coordinator-contract.md`）kind 封闭集合的一行。
  反过来，PCC §11.2 里标注 `来源 = PAC §12` 的每一个 kind 都必须是本表的一行。**两个方向都由契约自检断言**
  —— v1.1 只有 PCC ⊆ PAC 那一半，于是 v1.1 新增的 `WORKSPACE_PIN_NOT_A_CANDIDATE` 在 PCC 里根本不存在，两边测试却全绿。
  闭合链的另外两截（数据库约束 `project_blocker_kind_chk` 的取值、实现里那份 kind 封闭集合常量的成员）**不由本契约
  直接写入**：PCC §11.2 的每一行要么已经落在这两处，要么被 PCC §12.1 的迁移步骤**指名**为待落地，且**有且只有一条**
  这样的步骤。契约自检对这三件事各断言一次：① 本表的派发码 ⊆ PCC §11.2；② PCC §11.2 声称来自本表的 kind ⊆ 本表；
  ③ PCC §11.2 里尚未落地的 kind 恰好等于 PCC §12.1 那条步骤指名的集合。
  **一个写不进去的拒绝码，等于一次静默跳过的派发**（真实数据库对它的回答是 `violates check constraint
  "project_blocker_kind_chk"`）—— 正是本节开头那句话禁止的东西；本条要保证的是它**有且只有一个已声明的落地位置**，
  而不是让它在契约层假装已经落地。

---

## 13. 各模块必须覆盖的用例

下表是**验收基线**：每个实现任务在合并前，至少要有这些用例的自动化测试。
每条用例有一个**唯一编号**和一个**分类**：`+` 正向 · `-` 拒绝 · `M` 迁移。§14 按编号引用它们，
契约自检 spec 断言编号唯一、分类合法、且 §14 的每一行都引用得到（§13.0 的 `00.6` / `00.7`）。
测试位置按既有惯例：apiserver 用 `*.spec.ts`（`node --test`），web 用 `*.test.tsx`，runner 用 `*_test.go`。

### 13.0 契约自检（`project-agent-contract.spec.ts`，**本次已实现**）
- `00.1` `-` §5 / §7 / §8 / §11 里引用的每一个错误码都是 §12 的一行（E1 正向闭合；漏一个即红）
- `00.2` `-` §12 的每一行都在正文里至少被引用一次（E1 反向闭合；只存在于表里的死码即红）
- `00.3` `-` §6 的 create-frozen 与 claim-frozen 两个集合不相交，并集等于 §6 表格的全部列（S4）
- `00.4` `-` §7.2 的优先级表不出现 `task.provider` / `task.model`（P1：V1 路径没有 pin）
- `00.5` `-` §7.5 结构里的每一个 id 键都被 §10 B3 的表列出（漏一个即红，这是 v1 只写 `who.agentId` 那个缺陷的护栏）
- `00.6` `-` §13 的用例编号唯一，分类只能是 `+` / `-` / `M`
- `00.7` `-` §14 的 8 行各自至少引用一条 `+` 和一条 `-` 或 `M` 用例，且引用到的编号都在 §13 中存在
- `00.8` `-` 每个 `§n` 内部引用都能解析到本文件的一个小节
- `00.9` `-` §12 的每一行都带 HTTP 状态、谓词和必须携带的信息，且 code 唯一
- `00.10` `-` §7.3 用到的错误码恰好是 C7 声明的三个，且 §12 对 `NO_PROJECT_WORKSPACE` 的谓词限定在「候选集为空」（v1 把 pin 越界也压在这个码上，这条会红）
- `00.11` `-` §0 的七行索引与它指向的小节一致（一个漂移的修订摘要就是一条被悄悄重开的结论）
- `00.12` `-` §11.2 步骤 4 的三条语句里，DROP 旧外键出现在 `UPDATE project_member` **之前**，且 M7 写明了回滚与前后断言（v1.1 的顺序会让这条红）
- `00.13` `-` 两组拒绝谓词的交集各只有一个码：§7.1 H4 给 WHO 定序，§7.3 的优先级表把"候选集为空"排在 pin 之前（按表逐行求值，不是比对码的集合）
- `00.14` `-` §12 里 `路径 = 派发` 的每一个码都是 PCC §11.2 的一行；反过来 PCC 标注来自 PAC §12 的 kind 都在 §12 里；且 PCC §11.2 里尚未落地的 kind 恰好由 PCC §12.1 的**唯一一条**迁移步骤指名（E4 的三条断言）
- `00.15` `-` PCC 的决策输入投影带 `executionContract`，且 PCC §7.4 EC1 的 V1 读集里没有 `task.provider` / `task.model`（O7 的可执行形式）
- `00.16` `-` §0.1 的四行索引与它指向的小节一致（同 `00.11`，对 v1.2 那一轮）
- `00.17` `-` `execution_contract` 的写入规则全文只有一个答案：§11.1 L5 的三行请求形状表存在且封闭，正文里没有任何一句"带 `projectId`（而不问 `assigneeAgentId`）就写 `V1`"，并把**两种录制的旧端载荷**（`POST /tasks` 与 `POST /tasks/batch-create`，都带 `projectId`、都没有 `assigneeAgentId`）各跑一遍，唯一结果必须是 `LEGACY`（v1.2 的四句残留会让这条红）
- `00.18` `-` §7.1 H4 的顺序被**执行**过：`coordinator-counterexample.spec.ts` 里有一条直接调用 WHO 解析模型、对 `member=null ∩ disabled` 与 `member=null ∩ deleted` 各断言唯一 `WHO_NOT_IN_TEAM` 的测试（`00.13` 只读表格顺序，看不见模型的实际分支）
- `00.19` `-` `00.15` 的可执行那一半：反例模型的 `Db33` / fixture / resolver / `world` 投影 / `S10_FIELDS` 都带 `executionContract`，且 V1 分支不读 `task.provider` / `task.model`（只有文档带、模型不带时这条红）

### 13.1 02A `agent` 数据模型与迁移
- `02A.1` `+` 建 Agent：只带 name 也能建；provider/model/fallback/权限位/requiredCapabilities 各字段可读回
- `02A.2` `+` 软删后同名可再建（A2 partial unique）
- `02A.3` `-` 同 owner 同名重复建 → 冲突
- `02A.4` `-` schema 中不存在 `runnerId`/`targetRunnerId`/`targetLabels`/`workDir`/`enableWorktree`/`env`（A1，断言 schema 本身）
- `02A.5` `-` 跨 owner 读写 Agent → 403
- `02A.6` `M` 0128 回填：镜像集是"未软删 ∪ 被 `project_member` 引用"（T5），每个源 workspace 恰好一条镜像 Agent，字段逐列相等
- `02A.7` `M` 回填重名 workspace → Agent 名字去重且不抛错
- `02A.8` `M` `public-id-coverage.spec.ts` 通过（B1）
- `02A.9` `M` 软删来源的镜像 Agent 带 `deleted_at`，不出现在任何可指派列表里（M2）

### 13.2 02B `project_member` 重指向 与 `project_workspace`
- `02B.1` `+` 加成员、设 Coordinator、设 Default Workspace 各自可读回
- `02B.2` `-` 同 Project 同 Agent 加两次 → 冲突（T1）
- `02B.3` `-` 设第二个 Coordinator → `TEAM_COORDINATOR_EXISTS`（T2，**必须由既有数据库索引挡住**，测试要并发写两条）
- `02B.4` `-` 设第二个 Default Workspace → 冲突（W2，同样并发写）
- `02B.5` `-` 删仍被成员引用的 Agent → `AGENT_IN_USE`（Restrict）
- `02B.6` `-` `project_member.canDelegate = true` 而 `agent.canDelegate = false` → `PERMISSION_WIDENING_REFUSED`（§8.3）
- `02B.7` `M` 保序重指向（T4）：行数不变、`id`/`project_id`/`role`/`added_at` 逐行不变、新旧 `agent_id` 成双射、每个 Project 的 COORDINATOR 归属对象不变
- `02B.8` `M` 一条指向**已软删** workspace 的成员行在重指向后外键仍成立（T5 的反例；把镜像集缩回"未软删"这条测试必须变红）
- `02B.9` `M` 有 `coordinator_workspace_id` 的 Project 各得到一条 `is_default` 记录
- `02B.10` `M` 无 coordinator 的 Project 迁移后候选集为空，且不报错
- `02B.11` `M` 迁移 SQL 里没有 `CREATE TABLE "project_member"`，也没有 `DROP TABLE`（它是既有表，只换外键目标）

### 13.3 02C `task` 新列
- `02C.1` `+` `assigneeAgentId` / `workspaceId` / `requiredCapabilities` 可写可读
- `02C.2` `+` 迁移之后新建的 Task 按**创建请求的形状**分流，L5 那张表的三行各一条断言：带 `projectId` **且显式带** `assigneeAgentId` → `V1`；带 `projectId` **省略** `assigneeAgentId` → `LEGACY`；不带 `projectId` → `LEGACY`（K3；后两行都是列默认值，服务层一个字都不写）
- `02C.3` `-` 给 V1 Task 写 `provider` / `model` → `TASK_PROVIDER_PIN_REFUSED`，且**绕过服务层直接 SQL 写入被 CHECK 约束挡住**（K1）
- `02C.4` `-` 给无 `projectId` 的 Task 写 `assigneeAgentId` 或置 V1 → `TASK_CONTRACT_NEEDS_PROJECT`（K3、§8.4 第 1 条）
- `02C.5` `-` 写非 Team 成员的 Agent → `WHO_NOT_IN_TEAM`
- `02C.6` `-` 删被 Task 指着的 Agent → `AGENT_IN_USE`（Restrict）
- `02C.7` `-` 把 V1 Task 改回 `LEGACY` → 拒绝（K4）
- `02C.8` `M` 迁移后**每一条**既有 Task 的 `execution_contract = 'LEGACY'`，包括 `project_id` 非空的那些（L3，直接 count 断言；迁移 SQL 里没有任何一条 `UPDATE task`）
- `02C.9` `M` 迁移后历史 Task 的 `assignee_agent_id` 全部为 NULL（M1，count 断言）
- `02C.10` `M` `assignee_id` 值一行未变

### 13.4 02D `session` 快照列
- `02D.1` `+` create 时 `agentId` / `requiredCapabilities` / `resolution` / `snapshotFrozenAt` 全部落库
- `02D.2` `-` `snapshotFrozenAt` 非空后再写 create-frozen 九列中的任意一列 → 被拒（S4）
- `02D.3` `+` `snapshotFrozenAt` 已非空时，首次 claim 仍然写得进 `model` / `effort`（S4 的另一半；v1 的"上表全部列只读"会让这条红）
- `02D.4` `-` 首次 claim 之后再改写 `model` → 被拒，`retiredPin` 例外仍可改写一次（S1）
- `02D.5` `+` 首次 claim materialize `model` 之后 `resolution.with.model` **未被回写**（S5）
- `02D.6` `M` 历史 Session 这些列为 NULL/空，且既有 session 列表 / 详情接口响应形状不变

### 13.5 02E `runner.capabilities`
- `02E.1` `+` 心跳写入 capabilities 并更新 `capabilitiesReportedAt`
- `02E.2` `-` 用户接口（`PATCH /runners/:id`）写 capabilities → 403 / 字段被忽略（C3）
- `02E.3` `-` `runner.labels` 写入不影响 capabilities（两列独立）
- `02E.4` `M` 既有 runner 行 `capabilities = '{}'`、`capabilitiesReportedAt IS NULL`，且**不等于**"上报了空集"（C4 的判据在这一条上）

### 13.6 03A Agent 配置 API
- `03A.1` `+` CRUD 全通；provider / model / systemPrompt / 能力 / 权限位读回一致
- `03A.2` `+` fallback 数组顺序保序读回
- `03A.3` `-` 非 owner 访问 → 403
- `03A.4` `-` fallback 里放不存在的 provider slug → 400（写入时校验，别留到派发时才炸）
- `03A.5` `-` disable 的 Agent 不出现在可指派列表

### 13.7 03B Project Team / Coordinator / Default Workspace API
- `03B.1` `+` 加成员 / 换 Coordinator / 换 Default Workspace 各自成功且幂等重放安全
- `03B.2` `-` Coordinator Session 调"加成员" → 403（§8.2）
- `03B.3` `-` 把不属于本 owner 的 Agent / Workspace 加进 Team → 403
- `03B.4` `-` 移除仍被 Task pin 的 Project Workspace → `WORKSPACE_IN_USE`
- `03B.5` `M` 老 Project（迁移生成的 Team）可以正常增删成员

### 13.8 03C Task 指派、子任务权限 与 Coordinator principal
- `03C.1` `+` Owner 指派 Team 内 Agent 成功
- `03C.2` `+` Coordinator Session 指派成功
- `03C.3` `-` `POST /tasks` 拒绝非 Team Agent（§8.4）
- `03C.4` `-` `PATCH /tasks/:id` 拒绝非 Team Agent
- `03C.5` `-` `POST /tasks/batch-create` 拒绝非 Team Agent
- `03C.6` `-` `POST /tasks/batch-assign` 拒绝非 Team Agent
- `03C.7` `-` Member 建顶层任务 → 403（⚠b）
- `03C.8` `-` Member 跨 Project 建任务 → 403
- `03C.9` `-` Member（`canDelegate = false`）指派给别的 Agent → 403
- `03C.10` `-` 一条 `session.agentId` 恰好是 Coordinator Agent、但 `session.id ≠ project.coordinatorSessionId` 的会话 → **不是** Coordinator，403（PR1 的反例）
- `03C.11` `+` 一条 `session.id = project.coordinatorSessionId` 但 `session.agentId` 为 NULL 或指向别的 Agent 的会话 → **仍然是** Coordinator（PR1 的正例，同时是既有协调会话的迁移安全证明）
- `03C.12` `-` `project.coordinatorSessionId IS NULL` 时任何 Coordinator 专属操作 → 403（PR1）
- `03C.13` `+` Member（`canCreateTasks`）在自己执行的 Task 下建子任务成功
- `03C.14` `-` Member 改 `task.provider` → 403（无论目标 Task 是 V1 还是 LEGACY）
- `03C.15` `+` Coordinator Session（其 Project 的 Coordinator Agent `canCreateTasks` 为真）在**本 Project 内**建一棵 parent + child 任务树：两条 Task 都落在本 Project、`parentTaskId` 正确、两条都指派给 Team 内的 Agent 且各自通过 §8.4 的五条；这是 AC3"Coordinator 可创建任务树"的正向用例（`03C.2` 只证明了指派）

### 13.9 04A 执行上下文解析与快照
- `04A.1` `+` 三条链各自命中不同优先级的组合，`session.resolution` 三个 key 恒存在
- `04A.2` `+` Agent 默认 provider 决定引擎，`resolution.with.source = "agent-default"`
- `04A.3` `+` Agent 未配 provider → owner 级默认，`source = "owner-default"`
- `04A.4` `-` 无 `assigneeAgentId` 的 V1 Task → `WHO_UNRESOLVED`
- `04A.5` `-` Agent 被移出 Team 后派发 → `WHO_NOT_IN_TEAM`（**不改派**）
- `04A.6` `-` WITH 链不读 `workspace.model`（P2：构造一个有 `workspace.model` 的场景，断言它没被用上）
- `04A.7` `-` WITH 链不调用 `agentProviderSeed()`（P5：workspace 上一次会话跑 Codex，Agent 默认 Claude，V1 路径解析出 Claude）
- `04A.8` `-` V1 路径产出的 `resolution.with.source` 恒不为 `task-pin`（P6）
- `04A.9` `-` WHERE 链函数签名不含 agent 参数（W-note 的结构性断言）
- `04A.10` `+` **S2 回归**：Session 建好后改 Agent 的 provider，resume 同一 Session → provider 不变
- `04A.11` `+` **AC8 回归**：一个普通开发 Task（无 requiredCapabilities）指派给任意 Agent，Project 的 Default Workspace 在 Linux runner 上 → 解析出的 runner 恒为该 Linux runner，**与 Agent 是谁无关**（参数化跑遍多个 Agent）
- `04A.12` `-` `resolution` 出站后遍历整棵 JSON 树，**没有任何** UUID 形状的字符串（B3 的遍历式断言）
- `04A.13` `+` 降级成功：`fallbackHops` 落进 `resolution`，且每跳恰好一条 `run_event`
- `04A.14` `-` `providerFallbacks` 为空且 provider 不可用 → `PROVIDER_UNAVAILABLE`，且这次解析产生的 `run_event` 增量为 **0**（AU-F1）
- `04A.15` `-` fallback 全部耗尽 → `PROVIDER_UNAVAILABLE`，错误体携带**按序**尝试过的完整列表
- `04A.16` `+` fallback 按数组顺序命中第一个可用项（第 2 项可用时第 3 项不被尝试）
- `04A.17` `-` 任何一种解析失败都落一条 `project_blocker`（`kind` = §12 的码，`detail` 带证据），人发起与控制环发起写法相同（AU-F3）
- `04A.18` `-` 同一 Task 同因连续被拒不产生第二条 blocker，只更新时钟（AU-F4）
- `04A.19` `-` **WHO 交集**：一个既被移出 Team、又被 disable（或软删）的 Agent 被指派的 V1 Task 派发 → 恰好一个码 `WHO_NOT_IN_TEAM` + 403（H4；返回 `WHO_DISABLED` 或 409 必须让这条红）
- `04A.20` `+` **id 等值 round-trip**：出站 `resolution` 的 `who.agentId` / `where.workspaceId` / `where.runnerId` 三个值各自用 `src/shared/src/codec.ts` 解码回 UUID，逐个断言**等于**该次解析实际落库的 `agent.id` / `workspace.id` / `runner.id`（B3；`04A.12` 只证明"不是 UUID 形状"，一个任意非 UUID 字符串也能让它绿）

### 13.10 04B Runner capability 上报
- `04B.1` `+` runner 探测到 macOS/Xcode/GPU 时上报对应 slug
- `04B.2` `+` 上报为**自探**，配置文件无法覆盖（C3）
- `04B.3` `-` 上报未知 slug 不报错也不匹配任何 requirement（C2）
- `04B.4` `M` 旧版本 runner 不发该字段时服务端不报错

### 13.11 04C Capability 匹配与 Runner 调度
- `04C.1` `+` 需求 `["macos"]` + 两个候选（Linux/Mac）→ 选中 Mac
- `04C.2` `+` 需求为空 + Default Workspace 可行 → 选中 Default，`resolution.where.source = "project-default"`
- `04C.3` `+` Default 不可行、另一候选可行 → 选中候选，`source = "project-candidate"`
- `04C.4` `+` 多个可行候选 → 按 `position ASC, id ASC` 确定性选择（同一输入跑两次结果相同）
- `04C.5` `-` 无候选满足 → `RUNTIME_REQUIREMENT_UNMET`，错误里逐机器列出缺失能力
- `04C.6` `-` `task.workspaceId` pin 的机器在候选集内但不满足需求 → `RUNTIME_REQUIREMENT_UNMET`，**不改派**
- `04C.7` `-` `task.workspaceId` pin 到**不在候选集**的 Workspace → `WORKSPACE_PIN_NOT_A_CANDIDATE`（C7；返回 `NO_PROJECT_WORKSPACE` 必须让这条红）
- `04C.8` `-` Project 无候选 Workspace → `NO_PROJECT_WORKSPACE`
- `04C.9` `-` `04C.7` 与 `04C.8` 的输入互斥：候选集非空时不可能得到 `NO_PROJECT_WORKSPACE`，候选集为空时不可能得到 `WORKSPACE_PIN_NOT_A_CANDIDATE`（E2）
- `04C.10` `-` `capabilitiesReportedAt IS NULL` 且需求非空 → 不满足（C4）
- `04C.11` `-` `runner.labels` 命中但 capabilities 未命中 → 仍然不满足（C5）
- `04C.12` `-` **WHERE 交集**：候选集为空 **且** `task.workspaceId` 非空 → 恰好一个码 `NO_PROJECT_WORKSPACE`（C8；返回 `WORKSPACE_PIN_NOT_A_CANDIDATE` 必须让这条红）

### 13.12 05A CLI
- `05A.1` `+` `orbit agent list` 行为与 v1 前完全一致（Legacy alias 冻结，§9.2）
- `05A.2` `+` 新增 `orbit workspace …` / `orbit project team …` 可用
- `05A.3` `-` CLI↔MCP parity 测试通过（新增 MCP 参数必须同步 CLI，否则 parity 红）
- `05A.4` `-` 新命令族已登记 `leafHelpFamilies`（否则 leaf help 不可达）

### 13.13 05B Web：Team 与 Agent 配置
- `05B.1` `+` 展示/增删成员、设 Coordinator、设 Default Workspace
- `05B.2` `+` 空 Team 展示空态而非报错（§11.4）
- `05B.3` `-` 非 Team Agent 不出现在指派选择器

### 13.14 05C Web：Task 指派与任务树
- `05C.1` `+` 任务树每行展示 Assignee Agent 名 + 其 Provider（Provider 取自 Agent，不再有任务级覆盖）
- `05C.2` `+` 在 Project 内新建 Task 时 `assigneeAgent` 是必填项（L5）
- `05C.3` `-` Legacy Project Task 展示 legacy assignee、标注"未迁移"，并提供 L4 晋升入口

### 13.15 05D Web：Session 执行快照与调度来源
- `05D.1` `+` Session 详情展示 who / with / where 三段及各自 source
- `05D.2` `+` 发生 fallback 时展示"原定 X → 实际 Y（按 Agent 配置）"
- `05D.3` `+` `resolution.with.model` 与 `session.model` 不同时两者都展示并说明来源差异（S5）
- `05D.4` `-` `resolution.v` 为未知版本时降级展示，不白屏
- `05D.5` `-` `resolution` 里的三个 id 出站均为 base62（B3）

### 13.16 06A 兼容层
- `06A.1` `+` 无 Project 的 LEGACY Task 走 legacy 路径，派发结果与 v1 前逐字段相同（黄金用例对比）
- `06A.2` `+` **Legacy Project Task**（`project_id` 非空、`assignee_agent_id` 为 NULL）派发结果与 v1 前逐字段相同 —— L2 的核心回归，v1 的规则会让这条直接 `WHO_UNRESOLVED`
- `06A.3` `+` MCP `agent_create` 仍然创建 Workspace（§9.2）
- `06A.4` `+` LEGACY Task 上的 `provider` pin 仍被读取并生效（§11.1 L1）
- `06A.5` `-` L4 晋升时行上仍带 pin → `TASK_PROVIDER_PIN_REFUSED`，且整个请求什么都不改（事务性）
- `06A.6` `+` L4 晋升：同一个 PATCH 里清 pin + 指派 Agent → `execution_contract` 变 `V1`，下一次派发走三条链
- `06A.7` `-` 晋升后再写回 `LEGACY` → 拒绝（K4）

### 13.17 06B 兼容回归矩阵
- `06B.1` `M` 迁移在空库跑通、在生产快照跑通，`migrate diff` 对新增列为空（M3）
- `06B.2` `M` 迁移不含任何 `DROP COLUMN` 或 `DROP TABLE`（M4，按这两个词 grep，不按 `DROP` grep）
- `06B.3` `M` 重指向前后 `project_member` 的行快照 diff 只在 `agent_id` 上有差异（M5）
- `06B.4` `+` 旧客户端载荷（录制的真实响应）对新服务端仍可解码（§11.4）
- `06B.5` `+` **AC8 端到端**：构造"Mac runner + Linux runner + 一个普通开发 Task"，跑 N 次派发，断言从未落到 Mac runner
- `06B.6` `+` Swift 端解码新增可选字段不崩，且 `coordinatorAgentId` 取不到 workspace 时不白屏（§11.4）
- `06B.7` `M` `project_decision.coordinator_agent_id` 等历史审计列迁移后逐行未变（M6）
- `06B.8` `+` **旧客户端写兼容**：用录制的旧端 `POST /tasks`（带 `projectId`、**没有** `assigneeAgentId`）与 `POST /tasks/batch-create` 各打一发 → 201、行落 `execution_contract = 'LEGACY'`、`assignee_agent_id IS NULL`，随后派发逐字段等于 v1 之前的黄金结果（§11.1 L5、§11.4；v1.1 的"新建 Project Task 一律 V1"会让这条 400 或 `WHO_UNRESOLVED`）

---

## 14. 项目验收标准 → 自动化测试映射

项目的 8 条验收标准，每条都必须能被 §13 里**指名编号**的自动化测试证明，且每条至少有一条正向用例
和一条拒绝 / 迁移 / 回归用例 —— 只有正向用例的声明证明不了"不会发生什么"，而本项目的一半价值在后者。

| # | 项目验收标准 | 落地条款 | 证明它的用例（§13 编号） |
|---|---|---|---|
| 1 | Project 可配 Coordinator + 多成员 Agent，公开 ID 均 Base62 | §3.2, §10 | `+` `02B.1` · `+` `03B.1` · `+` `04A.20` · `-` `02B.3` · `-` `04A.12` · `M` `02A.8` |
| 2 | Agent 可配 Provider/Model/提示词/能力/权限；Provider 不再由普通 Task 直接配置 | §3.1, §3.4 K1, §7.2 P1 | `+` `02A.1` · `+` `03A.1` · `+` `06A.4` · `-` `02C.3` · `-` `04A.6` · `-` `04A.8` · `-` `03C.14` · `-` `00.15` · `-` `00.19` |
| 3 | Task 只从 Project Team 选 assigneeAgent；Coordinator 建树，执行 Agent 在权限内建子任务 | §8.1, §8.2, §8.4 | `+` `03C.1` · `+` `03C.2` · `+` `03C.11` · `+` `03C.13` · `+` `03C.15` · `-` `03C.3` · `-` `03C.4` · `-` `03C.5` · `-` `03C.6` · `-` `03C.7` · `-` `03C.10` · `-` `03C.12` · `-` `04A.19` · `-` `00.18` |
| 4 | Task Session 默认用 Project 当前 Workspace + Agent 的 Provider/Model；Session 存不可变快照 | §6, §7.2, §7.3 | `+` `04A.1` · `+` `04A.2` · `+` `04A.10` · `+` `04C.2` · `+` `02D.3` · `-` `02D.2` · `-` `02D.4` |
| 5 | macOS/Xcode/GPU 经独立 runtime capability 选 Runner，不再由 Agent 身份隐式决定 | §7.3, §3.5 | `+` `04C.1` · `+` `04C.4` · `+` `04B.1` · `-` `04A.9` · `-` `04C.5` · `-` `04C.10` · `-` `04C.11` |
| 6 | Web/API/CLI 对 Team、Agent 配置、指派与调度结果有完整可独立运行的测试，并覆盖迁移 | §13 全表 | `+` `03A.1` · `+` `03B.1` · `+` `03C.1` · `+` `04A.1` · `+` `05A.2` · `+` `05B.1` · `+` `05C.1` · `+` `05D.1` · `-` `03A.3` · `-` `03B.2` · `-` `03C.3` · `-` `04C.5` · `-` `00.7` · `-` `05A.3` · `M` `06B.1` |
| 7 | UI 能管理团队，并在任务树里清晰展示 Assignee Agent 及其 Provider | §11.4, §13.13–13.15 | `+` `05B.1` · `+` `05B.2` · `+` `05C.1` · `+` `05D.2` · `-` `05B.3` · `-` `05C.3` · `-` `05D.5` |
| 8 | 既有行为兼容，且**可验证**普通开发 Task 不会再被错调度到 Mac Runner | §11, §7.3 | `+` `06A.1` · `+` `06A.2` · `+` `06A.6` · `+` `06B.8` · `+` `04A.11` · `+` `06B.5` · `-` `06A.5` · `-` `00.12` · `-` `00.17` · `M` `02C.8` · `M` `02B.7` · `M` `06B.1` · `M` `06B.3` |

> 第 8 条是本项目的**根因验收**，因此在单元层（`04A.11`，参数化跑遍 Agent）与端到端层（`06B.5`，跑 N 次派发）各有一条独立测试；
> 只有其中之一都不算通过。v1.1 又补了 `06A.2` —— 既有 Project Task 在迁移后必须**仍然照旧跑得动**，
> 这是 v1 的 L2 直接违反、而 v1 的 06A 黄金用例（只测无 Project 的 Task）捕获不到的那个反例。
>
> 第 2 条的证明分三半：`02C.3` 证明**写不进去**（数据库 CHECK），`04A.8` 证明**读不出来**（V1 的 resolution 里
> 永远不会出现 `task-pin`），`00.15` 证明**下游控制环也不读它**（PCC 的决策投影里 task pin 只属于 LEGACY 分支）。
> v1 的映射只拒绝 Member 修改 pin，而 Owner/Coordinator 仍可直接配置，证明的恰好是这条验收标准的反面；
> v1.1 补上了前两半，第三半直到 v1.2 才闭合 —— 在此之前 PCC 仍然规范性地读 `tasks[].provider`。
>
> 第 1 条的 `04A.20` 与 `04A.12` 也是两半：后者证明"出站没有 UUID 形状的字符串"，前者证明"出站的那三个值
> 解回来正是那三行的 id"。只有后者时，一个把三个 id 全替换成常量 `"x"` 的序列化器也能全绿。
>
> 第 6 条在 v1.2 之前只引用了 CLI / Web / 迁移用例与一条自检，因此"API 完整且可独立运行"没有任何一条 API 用例
> 支撑；现在 Agent 配置（03A）、Team（03B）、指派（03C）与调度解析（04A）各有一条正向与一条拒绝。
>
> 第 8 条在 v1.2 又补了两条：`06B.8`（旧客户端建 Project Task 的写请求兼容）与 `02B.7`（重指向在真实 0111
> 外键形状上跑得过）。前者是 §11.4 那一行的反例，后者是 M7 那条顺序的反例 —— 一条迁移在空库上绿、
> 在生产快照上红，等于 AC8 从未被证明过。
>
> v1.3 又各补一条**可执行**的自检：第 8 条的 `00.17`（`06B.8` 要到 06 单元才跑得起来，而它证明的那条规则
> 在契约里当场就可以有唯一答案）、第 3 条的 `00.18`（H4 的顺序被真的执行一次）、第 2 条的 `00.19`
> （`00.15` 证明文档不读 task pin，`00.19` 证明那份可执行模型也不读）。三条都是同一条纪律：
> **一句写对了的规范，只有在它声称能证明它的那个位置被执行过，才算被证明。**

---

## 15. 已冻结的取舍

记录**为什么这样定**，避免后续任务重新开会。

1. **新建 `agent` 表，而不是把 `workspace` 改名。** `workspace` 有 110k 关联行、被 iOS/macOS/MCP/CLI 四个面引用；改名是一次不可逆的全栈重构。新表 + 1:1 镜像回填让每一步都能独立回滚。
2. **`project_member` 保序重指向，而不是重建。** 它已经带着生产数据在跑（0111），且它的 COORDINATOR partial unique index 是既有的强约束。重建表意味着一次 DROP + 一次 INSERT，中间任何失败都会丢掉项目的协调者身份；`UPDATE` + 换外键目标是同一件事的可回滚版本。
3. **`project_workspace` 用关联表，不用 `project.default_workspace_id` 一列。** 一个 Project 跨机器（协调者在 Linux、iOS 构建在 Mac）是本项目要支持的正常形态，单列表达不了候选集；同一事实两处落库必然漂移（W3）。
4. **Default Workspace 与 `coordinator_workspace_id` 保持分离**（W4）：一个是可随时改的设置，一个是重绑要 409 的强约束。
5. **不回填 `task.assignee_agent_id`**（M1），并且**用 `execution_contract` 而不是 `project_id` 分流**（L2）：这两条必须一起读。只有前者，既有 Project Task 会在迁移后第一次派发就失败；只有后者，历史任务会被替用户做了"谁做"的决定。合在一起才既不替用户决定、又不弄坏任何在跑的东西。
6. **用一列 stamp（且用它的默认值）而不是"按 `created_at` 早于迁移时刻"判 LEGACY。** 时间戳判据是一条藏在代码里的隐式规则，任何一次数据回填、导入或时钟问题都会让它悄悄改变一批任务的行为；一列枚举是可以 `SELECT` 出来、可以 count 断言、可以在 UI 上显示的事实。
7. **V1 Task 不带 Provider pin，且由数据库 CHECK 保证**（K1）：服务层校验挡不住 raw SQL、挡不住下一个写路径、也挡不住未来的批量导入。AC2 是一条关于"不可能发生什么"的验收标准，只有约束能证明它。
8. **Coordinator 权限归 Session、身份归 Agent**（PR1/PR2）：绑定两者需要 `session.agent_id`，而所有既有协调会话都没有它，强制绑定等于迁移当天所有 Coordinator 失权。
9. **WHO 与 WHERE 没有 fallback**（§7.4 第 5 条）：换人做、换机器做都是业务决定。系统代劳一次，就等于把"意外调度"重新发明一遍。
10. **失败的解析不写 `run_event`，写 `project_blocker`**（AU-F）：`run_event.session_id` 是必填外键，而失败恰恰意味着没有 Session。硬要写就只剩两条路 —— 造一条假 Session，或者让审计只存在于一次 HTTP 响应里；两条都比"换一张本来就为这件事存在的表"更糟。
11. **`runner.capabilities` 由心跳自探，不可手工覆盖**（C3）：可手写的能力声明是一句可以撒谎的话，而 AC5 的整个价值在于它不能撒谎。
12. **未上报能力 = 不具备**（C4），与既有 `runsAsRoot` 的 NULL 语义方向相反且是刻意的：那里"不知道"不该**移除**一个今天能用的模式，这里"不知道"不该**授予**一个未经证实的能力。
13. **一次迁移（0128）而不是五次**：五个模块的 schema 改动互相引用（重指向 `project_member` 需要 `agent` 已经回填完），拆成五次迁移会产生四个不可用的中间态。02A–02E 分工不变，但落成同一个 migration 目录。
14. **不复活 `targetRunnerId` / `targetLabels`**（§11.3）：它们是有写无读的死配置，接进 WHERE 链等于新增一条与 §7.3 平行的隐式路径。

## 16. 遗留的开放问题（不阻塞 02 阶段）

明确记录、明确不解决，避免被当成疏漏：

- **O1**：`agent` 的 `disallowedTools` 与 `workspace_permission_rule`（工作区级"始终允许"）如何叠加，v1 未定义。v1 行为：两者独立生效，取更严的一侧。真正的合并规则等 03A 有实际用例再定。
- **O2**：~~Coordinator Agent 与 Coordinator Session 是否必须绑定~~ —— **v1.1 已关闭**，结论在 §8.1 PR1/PR2：权限只归 Coordinator Session，Coordinator Agent 只做归属。这一条保留编号是为了让引用它的历史文档仍然指得到地方。
- **O3**：摘掉 `orbit agent` / MCP `agent_*` 的 deprecated 别名需要原生端先跟进，**不在 v1 范围**（§9.2）。
- **O4**：多个可行 Workspace 时的负载均衡（C6）v1 不做。
- **O5**：iOS/macOS 的 Team / Agent 配置 UI 不在 v1 范围；v1 对原生端的唯一要求是 §11.4 的两条最低线。
- **O7**：~~PCC 的决策输入投影读 `tasks[].provider`、没有 `tasks[].executionContract`~~ —— **v1.2 已关闭**。
  PCC §6.1（`docs/project-coordinator-contract.md`）的 `world.tasks[]` 现在带 `executionContract`（它是 PAC §5 第 2 步
  的分流判据），PCC §7.4 EC1 的 V1 读集里不再有 `task.provider` / `task.model` —— 那两列只属于 LEGACY 分支的旧桥
  （§11.1 L1），EC1-b 把这条边界写死。两份契约的闭合由 `00.15` 与 §12 E4 的双向自检看着，因此它不可能再无声漂回去。
  这一条保留编号是为了让引用它的历史文档仍然指得到地方。
- **O6**：Legacy Project Task 的**批量**晋升（一次把一个 Project 下所有历史任务指派给同一个 Agent）v1 不做。L4 是单条的显式动作；批量入口等 05C 有实际用例再定。

## 17. 修订记录（非规范）

本节不定义任何规则，只记录本文件为什么变成现在的样子。规则一律以 §1–§16 为准。

| 版本 | 日期 | 触发 | 变更 |
|---|---|---|---|
| v1 | 2026-08-19 | 任务 01（`349a520RyB4Nviq80LGQq`） | 冻结初版，代码基线 `b5fe1b2e` |
| v1.1 | 2026-08-21 | 01V 独立审查 FAIL（评论 `34AqK7dEuWvR1Fwj7JawE`，被审 `a4adabf9`） | 见 §0 的七项结论；§13 全部用例编号化；§14 8 条映射重写；新增契约自检 spec |
| v1.2 | 2026-08-21 | 01V 对 v1.1 的独立复验 FAIL（评论 `34ArzVefRCxRrqdDh1cEi`，被审 `b810be89`） | 见 §0.1 的四项结论：§11.2 步骤 4 的语句顺序（M7）、两组拒绝谓词的唯一优先级（H4 / C8 / E3）、PAC↔PCC 与数据库 CHECK 的双向闭合（E4，含 PCC 同步）、AC1/3/6/8 的四条指名用例（`04A.20` / `03C.15` / AC6 的 API 引用 / `06B.8`）。同批新增自检 `00.12`–`00.16` |
| v1.3 | 2026-08-21 | 01V 对 v1.2 的第三轮独立复核 FAIL（评论 `34AtY6AGHMBfp1FH7v9eQ` + 补充 `34AtZerHln1UBUWZDnw4h`，被审 `47cfc22a`） | 见 §0.2 的三项结论：`execution_contract` 写入规则统一到 §11.1 L5 的三行请求形状表（§2 / §3.4 / K3 / L3 / `02C.2` 改为引用）、WHO 交集在可执行模型上按 H4 定序并直接跑两个反例、`executionContract` 进入反例模型的 `Db33` / fixture / resolver / `world` 投影 / `S10_FIELDS`。同批新增自检 `00.17`–`00.19`；不改生产代码，不提前实现 PCC §12.1 步骤 6j |
