# Project · Agent · Workspace 领域契约 v1

> **状态**：已冻结（frozen）。本文件是 `Project 多 Agent 协作与 Agent 级 Provider 调度` 的**单一权威契约**。
> 02–06 阶段的每个实现任务都必须与本文件一致；实现与本文件冲突时，先改本文件并说明理由，再改代码。
>
> **适用分支**：`feat/project`（`main` 里没有 `Project`）。
> **代码基线**：`b5fe1b2e feat(projects): bind the creating session as the project's coordinator`。
> **本文只描述目标状态与迁移路径，不描述已有实现**；已有实现的现状写在 §11 兼容矩阵里。

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
| **Task** | 一件要做的事。业务层实体，持有 assignee **Agent**、可选 provider/model pin、可选 runtime requirement。 | 表 `task` |
| **Agent** | **"谁做"**：一个可复用的执行身份（角色、系统提示词、默认 Provider/Model/effort、能力与权限、runtime requirement 基线）。**Agent 不持有任何位置信息**（无 runnerId、无 workDir）。 | 表 `agent`（v1 新增） |
| **Legacy agent alias** | 历史遗留的**线上别名**：今天 MCP `agent_list/agent_create/agent_update`、CLI `orbit agent`、iOS/macOS/web 的 "Agent" 指的都是 `workspace` 行，**不是** 上一行的 Agent。v1 保留该别名并标记 deprecated（§9.2）。 | 表 `workspace` |
| **Workspace** | **"在哪里做"**：一台机器上的一个项目目录。持有 runnerId、workDir、worktree 隔离开关、env、默认 merge target。**Workspace 不持有身份信息**（v1 后不再被解析链读取 systemPrompt/model）。 | 表 `workspace` |
| **Project Team** | 一个 Project 允许使用的 Agent 集合及其项目内角色与权限。 | 表 `project_member`（v1 新增） |
| **Project Member** | Project Team 中的一条成员记录 = (project, agent, role, 权限位)。 | 表 `project_member` 的一行 |
| **Coordinator Agent** | Project Team 中 `role = COORDINATOR` 的成员。每个 Project **至多一个**。有权在授权范围内建树、指派、调度（§8）。 | `project_member.role` |
| **Coordinator Session** | Project 的协调对话本身（已存在，`project.coordinatorSessionId`）。**与 Coordinator Agent 是两回事**：前者是一段对话，后者是一个身份。 | `project.coordinatorSessionId` |
| **Project Workspace** | Project 注册的候选 Workspace 之一。WHERE 链只在这个集合内选，绝不扩散到 owner 名下的其他 Workspace。 | 表 `project_workspace`（v1 新增） |
| **Default Workspace** | Project Workspace 中 `isDefault = true` 的那一条。每个 Project **至多一个**，由数据库 partial unique index 保证。 | `project_workspace.is_default` |
| **Runtime Requirement** | 一次运行对**机器**的硬性要求，表示为能力标签集合（如 `macos`、`xcode`、`gpu`）。声明在 Task 和/或 Agent 上，两者取并集。**它只筛机器，永不筛 Agent、永不筛 Provider。** | `task.required_capabilities` + `agent.required_capabilities` |
| **Runtime Capability** | 一台 Runner **自己上报**的、它真实具备的能力标签集合。由心跳独占写入（heartbeat-owned），用户不可编辑。 | `runner.capabilities`（v1 新增） |
| **Runner Label** | 已存在的**用户自定义**机器标签（`runner.labels`）。与 Runtime Capability 是两个东西：label 是人写的备注，capability 是机器自报的事实。**调度只读 capability，永不读 label。** | `runner.labels`（既有，语义不变） |
| **Engine capability**（勿混淆） | 已存在于 claim queue 的第三种"capability"：指 runner **二进制版本**是否支持某条协议路径（见 `queue-provider-capability.spec.ts`）。与本项目无关，v1 不改动；本文其余部分出现的 capability 一律是上面两行的含义，不是这一层。 | 代码内部，无列 |
| **Provider** | 跑这次对话的引擎身份：内置 slug（`claude`/`codex`/`kimi`/`opencode`）或 owner 配置的 `ModelProvider.slug`。 | `session.provider` |
| **Model** | Provider 空间内的模型 id。 | `session.model` |
| **Session** | 一次真实运行的对话。执行层实体，**持有解析结果的不可变快照**（§6）。 | 表 `session` |
| **Execution Snapshot** | Session 上一组"写一次、此后只读"的列，记录三条解析链的结果与依据。Resume / reclaim / 心跳 **永不**从 Agent/Project/Workspace 重新推导这些值。 | §6 表格 |
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
| `legacyWorkspaceId` | `String? @unique @db.Uuid` | **迁移专用**：这一行是从哪个 `workspace` 镜像出来的。只在 0111 回填时写入，之后只读，用于 §11 的双写兼容层。新建 Agent 恒为 null |

**约束**
- **A1**：`agent` 表**不得**出现 `runnerId` / `targetRunnerId` / `targetLabels` / `workDir` / `enableWorktree` / `env` 中的任何一个。审查项，02A 必须有一条断言 schema 里不存在这些列。
- **A2**：`@@unique([ownerId, name])` 需为 partial（`WHERE deleted_at IS NULL`），否则软删过的名字永久占位。
- **A3**：`role` 不参与鉴权（见上表）。任何读 `agent.role` 做权限判断的代码都是缺陷。

### 3.2 `ProjectMember`（新表 `project_member`）—— Project Team

| 字段 | 类型 | 语义与约束 |
|---|---|---|
| `id` | `String @id @default(uuid(7)) @db.Uuid` | |
| `projectId` | `String @db.Uuid` | `onDelete: Cascade`（团队是项目的一部分，项目没了成员记录无意义） |
| `agentId` | `String @db.Uuid` | `onDelete: Restrict`。**不是 Cascade 也不是 SetNull**：删 Agent 不得静默解散团队，也不得留下指向空的成员行。有成员引用时删 Agent 直接拒绝，与"非空 Project 拒删"同一手法 |
| `role` | `ProjectRole` | 枚举 `COORDINATOR` / `MEMBER` |
| `canCreateTasks` | `Boolean?` | 项目内**收窄**覆盖：null = 用 `agent.canCreateTasks`；非 null 时**只能收窄不能放宽**（§8.3） |
| `canDelegate` | `Boolean?` | 同上 |
| `position` | `Int?` | 展示顺序 |
| `addedAt` | `DateTime @default(now())` | |

**约束**
- **T1**：`@@unique([projectId, agentId])` —— 一个 Agent 在一个 Project 里至多一条成员记录。
- **T2**：`@@unique([projectId])  WHERE role = 'COORDINATOR'`（partial unique index）—— 每个 Project 至多一个 Coordinator Agent，由数据库保证而非服务层。
- **T3**：`@@index([agentId])` —— 让 "这个 Agent 在哪些项目里" 与 Restrict 删除检查都是一次索引查找。

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
| `workspaceId` | `String? @db.Uuid` | WHERE 链的**显式 pin**（罕用逃生口）。`onDelete: SetNull`。null = 走 §7.3 解析 |
| `requiredCapabilities` | `String[] @default([])` | 本 Task 的 **Runtime Requirement** |
| `assigneeId` | `String? @db.Uuid`（既有） | **冻结为 legacy**。语义不变（指向 `workspace`），v1 后**不再是** WHO 链输入，降级为 WHERE 链的历史兜底（§11.1）。不删列 —— 删列会让 iOS/macOS 静默漏改 |

**约束**
- **K1**：`provider` / `model`（既有列）语义不变，仍是 WITH WHAT 链的最高优先级 pin。
- **K2**：`assigneeAgentId` 与 `projectId` 的一致性由服务层在**写路径**校验（create / update / batch-create / batch-assign 四处），并由 03C 的测试逐处覆盖。不做数据库级跨表 check —— Postgres 表达不了，且 Project 变更时会把校验变成 migration。
- **K3**：Task 可以没有 `projectId`（今天 11 万行都没有）。**无 Project 的 Task 不得进入新解析链**，按 §11.1 走 legacy 路径。

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
| `snapshotFrozenAt` | `DateTime?` | 快照封存时刻。非 null 后，§6 表格中的所有列一律只读 |
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
1. 取 Task（含 projectId / assigneeAgentId / workspaceId / provider / model / requiredCapabilities）
2. 若 task.projectId 为 null           → 走 §11.1 legacy 路径，本节其余步骤全部跳过
3. WHO   链 → agent                    （§7.1）失败即 REFUSE，不继续
4. WITH  链 → provider + model + effort（§7.2）失败即按 §7.4 决定降级或 REFUSE
5. WHERE 链 → workspace + runner       （§7.3）失败即 REFUSE，不继续
6. 组装 Execution Snapshot，创建或 resume Session（§6）
7. 同一事务内写入 session.resolution 与 snapshotFrozenAt —— 快照必须和 Session 行一起落库，
   否则会存在一条“已创建但还没有解析依据”的 Session，读到它的客户端无法解释它在跑什么
```

**每一步失败都是拒绝，不是降级。** 唯一的例外是第 4 步，且只在 Agent 配了 Explicit Fallback 时（§7.4）。

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
| `permissionMode` | Session **create** | 只读（既有行为：create 时 materialize 账号默认） |
| `model` | **首次 claim**（既有行为，保留） | 首次 claim 后只读。既有例外保留：模型被 runtime 彻底下架（`retiredPin`）时改写一次 |
| `effort` | **首次 claim** | 同 `model` |
| `snapshotFrozenAt` | Session **create** | 一旦非 null，上表全部列进入只读 |

**S1**：`model` / `effort` 的冻结点是**首次 claim**而不是 create，这是刻意保留既有实现（`queue.service.ts` 的 compare-and-set materialize）。改成 create 会让"创建时 runner 还没上报 runtime 默认模型"的 Session 拿到错的模型。
**S2**：resume / reclaim / 心跳 / merge 回报路径**一律不得**读取 `agent.*` / `project.*` / `project_workspace.*` 来重新推导上表任何一列。04A 必须有一条测试：改完 Agent 的 provider 之后 resume 同一条 Session，Session 的 provider 不变。
**S3**：Session 快照**不是**审计日志。它记录"跑成了什么"，不记录"谁在什么时候改了配置"。后者不在 v1 范围。

---

## 7. 三条解析链

三条链**顺序执行、互不传参**。任何实现里出现"因为 Agent 是 X 所以机器选 Y"都是对 R3 的违反。

### 7.1 WHO —— 谁做

| 优先级 | 输入 | 结果 |
|---|---|---|
| 1 | `task.assigneeAgentId` 非空 | 该 Agent。**必须**同时满足：属于 `task.projectId` 的 Team、`agent.enabled = true`、`agent.deletedAt IS NULL` |
| 2 | `task.assigneeAgentId` 为空，且 Task 有 Project | **REFUSE** `WHO_UNRESOLVED` |

**没有第 3 优先级，没有兜底。** 尤其不得回落到 Coordinator Agent：Coordinator 拿到一件没人认领的活并默默做掉，正是"意外调度"的另一种形态。

- **H1**：Agent 被移出 Team / 被 disable / 被软删之后，指着它的 Task **拒绝派发**（`WHO_NOT_IN_TEAM` / `WHO_DISABLED`），而不是改派。
- **H2**：WHO 链**只读 Agent，不读 Workspace、不读 Runner**。

### 7.2 WITH WHAT —— 用什么做

| 优先级 | 输入 | 结果 |
|---|---|---|
| 1 | `task.provider`（+ `task.model`） | 任务级 pin。**pin 了就必须用**，不可用即进 §7.4 |
| 2 | `agent.defaultProvider`（+ `agent.defaultModel`） | Agent 默认 |
| 3 | 两者皆空 | owner 级默认（今天是 `claude`），`model` 留 null 交给首次 claim materialize（§6 `model` 行） |

- **P1**：`task.provider` 与 `agent.defaultProvider` 冲突时 **task 赢**，且必须写进 `session.resolution.with.source = "task-pin"`，让 UI 能说明白"为什么这条跑在别的引擎上"。
- **P2**：**WITH 链绝不读 Workspace。** 既有的 `workspace.model` 旧桥（`resolveProviderExec` 的 `workspaceModel` 参数）在有 Agent 的路径上**必须不被传入**；它只保留给 §11.1 legacy 路径。
- **P3**：Provider 是自定义 slug 时，仍走既有校验（`ModelProvider` 存在、enabled、属于本 owner 或全局）。校验失败 = 不可用，进 §7.4。
- **P4**：`effort` 与 provider/model 同链解析：`task` 无此列 → `agent.defaultEffort` → null（用模型默认）。
- **P5**：v1 路径**不再使用** `agentProviderSeed()`（“这个 workspace 上一次交互会话跑的是什么”）。那正是“位置决定引擎”的耦合本身：同一个目录上次有人用 Codex 试了一把，下一个 Task 就默默改跑 Codex。它只保留给 §11.1 legacy 路径。优先级 3 的 owner 级默认是一个**固定值**，不是一次推导。

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
| 1 | `task.workspaceId` 非空 | 该 Workspace。**两道校验都要过**：(a) 它必须在候选集内 —— 不在则 REFUSE `NO_PROJECT_WORKSPACE`，pin 不是绕过候选集这道安全边界的口子；(b) 它必须满足需求集 —— 不满足则 REFUSE `RUNTIME_REQUIREMENT_UNMET`。两种情况都**绝不改派** |
| 2 | Default Workspace ∈ 可行集 | Default Workspace |
| 3 | 可行集非空 | 按 `project_workspace.position ASC, id ASC` 取第一个（确定性 tie-break） |
| 4 | 可行集为空、候选集非空 | **REFUSE** `RUNTIME_REQUIREMENT_UNMET`，错误信息必须列出：需求集、每个候选机器缺哪几个能力 |
| 5 | 候选集为空 | **REFUSE** `NO_PROJECT_WORKSPACE` |

- **C4**：`runner.capabilitiesReportedAt IS NULL`（旧 runner，从未上报）的机器，**需求集非空时视为不满足**，需求集为空时正常参与。"不知道"不能读作"具备"—— 这与既有 `runsAsRoot` 的 NULL 语义方向相反，是刻意的：那里 NULL 不该**移除**一个今天能用的模式，这里 NULL 不该**授予**一个未经证实的能力。
- **C5**：WHERE 链**永不**读 `workspace.targetRunnerId` / `workspace.targetLabels` / `runner.labels`。
- **C6**：可行集有多个时**不做负载均衡**。v1 要的是可预测，不是最优。

### 7.4 Explicit Fallback

**默认行为：Provider 不可用 = 任务运行失败。** 不静默换引擎，一次都不行。

只有 `agent.providerFallbacks` 非空时才降级，且：

1. 按数组顺序逐个尝试，第一个通过校验的胜出。
2. 每跳都写进 `session.resolution.with.fallbackHops`，并落一条 `run_event`，用户能在 transcript 里看到"原定 X，X 不可用，按 Agent 配置降级到 Y"。
3. 全部备选都不可用 → REFUSE `PROVIDER_UNAVAILABLE`。
4. `task.provider` 是 pin 时**同样**允许走 Agent 的 fallback 链 —— pin 表达的是"优先用这个"，Agent 的 fallback 表达的是"这个不行时我授权用那些"，两者不矛盾。但 `session.resolution` 必须同时记下被 pin 的值和实际值。
5. **WHO 链和 WHERE 链没有 fallback，一个都没有。** 换人做和换机器做都是业务决定，不是系统可以代劳的降级。

### 7.5 `session.resolution` 结构（冻结）

```jsonc
{
  "v": 1,
  "who":   { "agentId": "<uuid>", "source": "task-assignee" },
  "with":  { "provider": "codex", "model": "gpt-5.6-sol", "effort": null,
             "source": "task-pin" | "agent-default" | "owner-default",
             "pinned":  { "provider": "kimi", "model": null },      // 仅在发生降级时出现
             "fallbackHops": [ { "from": "kimi", "to": "codex", "reason": "PROVIDER_UNAVAILABLE" } ] },
  "where": { "workspaceId": "<uuid>", "runnerId": "<uuid>",
             "source": "task-pin" | "project-default" | "project-candidate",
             "required": ["macos","xcode"],
             "candidatesConsidered": 3 }
}
```

- `v` 必须写，且读方必须容忍未知版本（跳过展示，不报错）。
- 三个 key **恒存在**，即使某条链走的是默认值 —— 一个缺失的 key 和一个 "用了默认" 是两件不同的事。
- 内部落库为 UUID，出站按 §10 编成 base62。

---

## 8. 授权矩阵

### 8.1 主体（Principal）

| 主体 | 身份来源 | 说明 |
|---|---|---|
| **Owner** | 用户 JWT | 项目所有者。终极控制权 |
| **Coordinator Session** | 会话上下文 + `project_member.role = COORDINATOR` | 该 Project 的协调对话 |
| **Member Session** | 会话上下文 + 该 Session 的 `agentId` ∈ Project Team | 执行中的成员 Agent |
| **Runner** | runner token | 只做心跳与运行回报 |
| **Service Token** | 服务令牌 | 既有能力，v1 不扩展 |

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
| 改 Task 的 provider / model pin | ✔ | ⚠c | ✘ | ✘ |
| 改 Task 的 requiredCapabilities | ✔ | ⚠c | ✘ | ✘ |
| pin `task.workspaceId` | ✔ | ⚠c | ✘ | ✘ |
| 派发 / 运行 Task | ✔ | ⚠c | ⚠d | ✘ |
| 上报 `runner.capabilities` | ✘ | ✘ | ✘ | ✔ |
| 读 Project / Team / Task / Session 快照 | ✔ | ✔ | ✔ | ⚠e |

- **⚠a** Coordinator 必须 `canCreateTasks` 为真（§8.3 的有效值），且只能在**自己所属的那个 Project** 内建。
- **⚠b** Member 必须 `canCreateTasks` 为真，且**只能在自己正在执行的那个 Task 下建子任务**（`parentTaskId` = 当前 Session 的 `taskId`）。不得建顶层任务，不得跨 Project。
- **⚠c** 仅限本 Project；被指派的 Agent 必须是本 Project 的 Team 成员。
- **⚠d** Member 默认只能指派给**自己**；`canDelegate` 为真时可指派给同 Team 的其他 Agent。
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

### 9.2 为什么不改 `agent_*` 的指向

改指向会让所有已有 agent 的记忆、脚本和 iOS/macOS 客户端在**不报错**的情况下开始操作另一张表。既有教训明确：删列 / 改 wire 语义而原生端没跟，只会静默漏改。因此 v1 的规则是：

- **旧拼法保持旧含义**，只加 deprecation 提示与 `kind: "workspace"` 判别字段。
- **新实体用新名字**，不复用任何旧拼法。
- 摘掉 deprecated 别名不在 v1 范围，需等原生端跟进后另开任务。

---

## 10. Base62 Public ID 契约

所有对外 id 一律 base62（`src/shared/src/codec.ts`），内部一律 UUID。**这是本项目最容易静默出错的一处**：只编码不解码的字段不会产生任何类型错误，它会一路走到 `where` 子句或 `::uuid` 转换，要么 500，要么永远比较不相等。

v1 必须加入 `PUBLIC_ID_FIELDS` 的字段（**编解码两个方向共用这一张表**）：

```
agentId              assigneeAgentId       coordinatorAgentId
projectMemberId      projectWorkspaceId    defaultWorkspaceId
agentIds             workspaceIds
```

- **B1**：`src/apiserver/src/common/public-id-coverage.spec.ts` 会遍历 `schema.prisma`，**任何新增的 `@db.Uuid` 列若不属于 `PUBLIC_ID_FIELDS` 或 `NEVER_PUBLIC_ID_FIELDS`，`npm test -w @orbit/apiserver` 就红**（该 spec 由 `node --test` 跑，不在 `npm run build` 里）。02A–02E 每新增一列都必须同时更新 `codec.ts` 那张表 —— 这是本契约里唯一被既有测试自动强制的条款，其余条款靠 §13 的用例。
- **B2**：`agent.legacyWorkspaceId` 属于 `PUBLIC_ID_FIELDS`（它是一个可被交还的地址）。
- **B3**：`session.resolution` 里的 id 是 **JSON 里的值，不是列**，编解码器不会自动处理。04A/05D 必须显式在出站序列化时转换，并有一条测试断言 `resolution.who.agentId` 是 base62 而非 UUID。这与 `focusTaskId` / `sourceTaskId` 当年的坑同型。
- **B4**：接受两种拼法入站（`IsPublicId` / `PublicIdPipe`），出站只发 base62。
- **B5**：哨兵词（如 `listId=none`）必须在**解码处**声明，不能指望调用方；`none` 恰好是合法 base62，会被解成一个不存在的 UUID 从而静默返回空集。新增的 `agentId=` / `workspaceId=` 过滤参数若要支持"未指派"哨兵，必须走同一处声明并有 route 层测试。

---

## 11. 兼容矩阵

### 11.1 旧数据：没有 Project、没有 Agent 的 Task

现状：`task` 表约 11 万行，`project_id` 全为 NULL，`assignee_id` 指向 `workspace`。

**规则 L1**：`task.projectId IS NULL` 的 Task 走 **legacy 路径**，行为与 v1 之前**逐字节相同**：

| | legacy 路径 | v1 路径 |
|---|---|---|
| 触发条件 | `task.projectId IS NULL` | `task.projectId IS NOT NULL` |
| WHO | 无（不存在 Agent 概念） | §7.1 |
| WITH | `task.provider/model` → `agentProviderSeed(workspace)` → `workspace.model` 旧桥 | §7.2（**不读** `workspace.model`） |
| WHERE | `task.assigneeId` → `workspace.runnerId` | §7.3 |
| Runtime Requirement | 不检查 | §7.3 |

**L2**：一个 Task 一旦被填上 `projectId`，就**立刻**切到 v1 路径。因此 05B/05C 的 UI 在把 Task 归入 Project 时，必须同时要求 `assigneeAgentId`，否则下一次派发会以 `WHO_UNRESOLVED` 拒绝。这是**刻意的显式失败**，不是回归。

**L3**：`task.assigneeId`（workspace）**不删列、不改语义**。在 v1 路径下它不参与解析，但仍被写入与展示，供旧客户端与历史查询使用。

### 11.2 迁移 0111（02A–02E 合并为一次迁移）

| 步骤 | 内容 | 幂等性 |
|---|---|---|
| 1 | 建表 `agent` / `project_member` / `project_workspace`；建枚举 `ProjectRole` | `CREATE TABLE IF NOT EXISTS` 由 prisma migrate 保证单次 |
| 2 | 加列：`task.assignee_agent_id` / `task.workspace_id` / `task.required_capabilities`；`agent.*`；`runner.capabilities` / `capabilities_reported_at`；`session.agent_id` / `required_capabilities` / `resolution` / `snapshot_frozen_at` | 全部**可空或有默认**，无 NOT NULL 无默认列 |
| 3 | **回填 Agent 镜像**：为每个 `workspace.deleted_at IS NULL` 的行插入一条 `agent`，`legacy_workspace_id = workspace.id`，`name` = workspace.name（重名时追加 ` (2)`…），`system_prompt` / `append_system_prompt` / `default_model` / `default_effort` / `disallowed_tools` 从 workspace 同名列复制，`default_provider = NULL`（保持派生行为），`required_capabilities = '{}'`，权限位全 `false` | 以 `legacy_workspace_id` 唯一键作 `ON CONFLICT DO NOTHING` |
| 4 | **回填 Project Workspace**：`project.coordinator_workspace_id` 非空的 Project 插入一条 `project_workspace(is_default = true)` | `ON CONFLICT (project_id, workspace_id) DO NOTHING` |
| 5 | **回填 Project Team**：为步骤 4 中每个 Project，把其 Default Workspace 对应的镜像 Agent 加为 `COORDINATOR` | 同上 |
| 6 | **不回填** `task.assignee_agent_id` | 见 M1 |
| 7 | 建索引：T1 / T2 / T3 / W1 / W2 与 `@@index([ownerId])`。T2、W2 是 partial unique index，schema.prisma 表达不了，需在 migration SQL 里手写（既有先例：0108 的 partial index、0110 的 `WHERE run_at IS NOT NULL`） | `CREATE UNIQUE INDEX IF NOT EXISTS` |

- **M1（关键）**：**绝不回填 `task.assignee_agent_id`**。回填等于替 11 万行历史任务替用户做了"谁做"的决定，而这些任务里绝大多数根本不属于任何 Project（走 §11.1 legacy 路径，不需要 Agent）。留空 + 显式失败是正确行为。
- **M2**：回填只覆盖**未软删**的 workspace。软删的行不镜像 Agent —— 它们不该重新出现在任何选择器里。
- **M3**：迁移必须能在**空库**和**生产快照**上各跑一次并 diff 为空。验证手法：一次性 throwaway postgres 容器跑 `prisma migrate deploy` + `prisma migrate diff`，并 `grep` 自己新增的列名，而不是看 drift 总数。
- **M4**：迁移**不包含** `DROP COLUMN`。`workspace.model` / `system_prompt` / `target_runner_id` / `target_labels` 全部保留。

### 11.3 已存在但无人读取的字段（v1 不复活）

`workspace.targetRunnerId` 与 `workspace.targetLabels` 今天有写路径（`workspaces.service.ts`）却**没有任何读路径**参与调度。v1 **不**把它们接进 WHERE 链：位置选择只走 §7.3。02E 需在文档/注释里标注它们为 dead config，但**不删除**（同 §11.1 L3 的理由：删列会让原生端静默漏改）。

### 11.4 客户端 × 服务端兼容

| 组合 | 期望行为 |
|---|---|
| **旧 web / iOS / macOS × 新服务端** | 所有既有接口形状不变。新字段以**可选字段**追加。旧端看不到 Agent/Team，但能照常读写 Project、Task、Session。绝不允许出现"旧端拿不到必填字段而崩溃"的响应 |
| **新 web × 旧数据** | Project 无 Team 时，团队区展示空态 + "添加成员"，不报错；Task 无 `assigneeAgentId` 时展示 legacy 的 workspace assignee 并标注"未迁移" |
| **新服务端 × 旧 runner（未上报 capabilities）** | 按 §7.3 C4：需求集为空照常派发，需求集非空则拒绝并提示"该机器的 orbit 版本过旧，无法确认能力" |
| **新 runner × 旧服务端** | 心跳里多出的 `capabilities` 字段被忽略，不报错 |
| **MCP / CLI 旧拼法** | 按 §9.2 保持旧含义 |
| **原生端（iOS/macOS）** | v1 **不要求** iOS/macOS 跟进 Agent/Team UI。它们必须做到的只有一件事：**不因为新字段而崩溃或误显示**。Swift 端对新增可选字段的解码必须验证过（既有教训：wire 变更而 Swift 未跟进会静默漏改） |

### 11.5 版本投递

runner 侧的任何改动（02E 的 capability 上报、05A 的 CLI）**必须同时 bump 版本号并重建 web 镜像**，否则旧 runner 会静默丢掉新功能。这是既有部署纪律，不是本项目新增。

---

## 12. 错误码（冻结）

所有拒绝都必须落在下表内，且携带可读的 `message`。**没有"静默跳过"这个选项**：派发被拒必须让用户看得到。

| code | HTTP | 何时 | 必须携带的信息 |
|---|---|---|---|
| `WHO_UNRESOLVED` | 409 | Task 属于 Project 但没有 `assigneeAgentId` | taskId |
| `WHO_NOT_IN_TEAM` | 403 | 指派 / 派发时 Agent 不在 Team | agentId, projectId |
| `WHO_DISABLED` | 409 | Agent 被 disable 或软删 | agentId |
| `PROVIDER_UNAVAILABLE` | 409 | Provider 校验失败且 fallback 链耗尽 | 尝试过的 provider 列表 |
| `RUNTIME_REQUIREMENT_UNMET` | 409 | 可行集为空，或 pin 的 Workspace 不满足需求 | 需求集 + 每个候选缺哪些能力 |
| `NO_PROJECT_WORKSPACE` | 409 | Project 一个候选 Workspace 都没有 | projectId |
| `PERMISSION_WIDENING_REFUSED` | 400 | `project_member` 想放宽 Agent 的权限位 | 字段名 |
| `TEAM_COORDINATOR_EXISTS` | 409 | 已有 Coordinator 时再设一个 | 现任 agentId |
| `AGENT_IN_USE` | 409 | 删 Agent 但仍有 `project_member` 引用 | 引用它的 projectId 列表 |
| `WORKSPACE_IN_USE` | 409 | 移除 Project Workspace 但有 Task pin 着它 | taskId 列表 |

---

## 13. 各模块必须覆盖的用例

下表是**验收基线**：每个实现任务在合并前，至少要有这些用例的自动化测试。
`+` 正向 · `-` 拒绝 · `M` 迁移。测试位置按既有惯例：apiserver 用 `*.spec.ts`（`node --test`），web 用 `*.test.tsx`，runner 用 `*_test.go`。

### 02A `agent` 数据模型与迁移
- `+` 建 Agent：只带 name 也能建；provider/model/fallback/权限位/requiredCapabilities 各字段可读回
- `+` 软删后同名可再建（A2 partial unique）
- `-` 同 owner 同名重复建 → 冲突
- `-` schema 中不存在 `runnerId`/`targetRunnerId`/`targetLabels`/`workDir`/`enableWorktree`/`env`（A1，断言 schema 本身）
- `-` 跨 owner 读写 Agent → 403
- `M` 0111 回填：每个未软删 workspace 恰好一条镜像 Agent，字段逐列相等；软删的没有镜像（M2）
- `M` 回填重名 workspace → Agent 名字去重且不抛错
- `M` `public-id-coverage.spec.ts` 通过（B1）

### 02B `project_member` / `project_workspace` 数据模型
- `+` 加成员、设 Coordinator、设 Default Workspace 各自可读回
- `-` 同 Project 同 Agent 加两次 → 冲突（T1）
- `-` 设第二个 Coordinator → `TEAM_COORDINATOR_EXISTS`（T2，**必须由数据库索引挡住**，测试要并发写两条）
- `-` 设第二个 Default Workspace → 冲突（W2，同样并发写）
- `-` 删仍被成员引用的 Agent → `AGENT_IN_USE`（Restrict）
- `-` `project_member.canDelegate = true` 而 `agent.canDelegate = false` → `PERMISSION_WIDENING_REFUSED`（§8.3）
- `M` 有 `coordinator_workspace_id` 的 Project 各得到一条 `is_default` 记录与一个 COORDINATOR 成员
- `M` 无 coordinator 的 Project 迁移后 Team 与候选集皆为空，且不报错

### 02C `task` 新列
- `+` `assigneeAgentId` / `workspaceId` / `requiredCapabilities` 可写可读
- `-` 给无 `projectId` 的 Task 写 `assigneeAgentId` → 400（§8.4 第 1 条）
- `-` 写非 Team 成员的 Agent → `WHO_NOT_IN_TEAM`
- `-` 删被 Task 指着的 Agent → `AGENT_IN_USE`（Restrict）
- `M` 迁移后 11 万行历史 Task 的 `assignee_agent_id` **全部为 NULL**（M1，直接 count 断言）
- `M` `assignee_id` 值一行未变

### 02D `session` 快照列
- `+` create 时 `agentId` / `requiredCapabilities` / `resolution` / `snapshotFrozenAt` 全部落库
- `-` 快照封存后再写这些列 → 被服务层拒绝
- `M` 历史 Session 这些列为 NULL/空，且既有 session 列表 / 详情接口响应形状不变

### 02E `runner.capabilities`
- `+` 心跳写入 capabilities 并更新 `capabilitiesReportedAt`
- `-` 用户接口（`PATCH /runners/:id`）写 capabilities → 403 / 字段被忽略（C3）
- `-` `runner.labels` 写入不影响 capabilities（两列独立）
- `M` 既有 runner 行 `capabilities = '{}'`、`capabilitiesReportedAt IS NULL`，且**不等于**"上报了空集"（C4 的判据在这一条上）

### 03A Agent 配置 API
- `+` CRUD 全通；fallback 数组顺序保序读回
- `-` 非 owner 访问 → 403
- `-` fallback 里放不存在的 provider slug → 400（写入时校验，别留到派发时才炸）
- `-` disable 的 Agent 不出现在可指派列表

### 03B Project Team / Coordinator / Default Workspace API
- `+` 加成员 / 换 Coordinator / 换 Default Workspace 各自成功且幂等重放安全
- `-` Coordinator Session 调"加成员" → 403（§8.2）
- `-` 把不属于本 owner 的 Agent / Workspace 加进 Team → 403
- `-` 移除仍被 Task pin 的 Project Workspace → `WORKSPACE_IN_USE`
- `M` 老 Project（迁移生成的 Team）可以正常增删成员

### 03C Task 指派与子任务权限
- `+` Owner / Coordinator 指派 Team 内 Agent 成功
- `+` Member（`canCreateTasks`）在自己执行的 Task 下建子任务成功
- `-` **四个写路径**（create / update / batch-create / batch-assign）各自拒绝非 Team Agent（§8.4，四条独立用例，不许只测一条）
- `-` Member 建顶层任务 → 403（⚠b）
- `-` Member 跨 Project 建任务 → 403
- `-` Member（`canDelegate = false`）指派给别的 Agent → 403
- `-` Member 改 `task.provider` → 403

### 04A 执行上下文解析与快照
- `+` 三条链各自命中 1/2/3 优先级的组合，`session.resolution` 三个 key 恒存在
- `+` `task.provider` pin 覆盖 `agent.defaultProvider`，`resolution.with.source = "task-pin"`
- `-` 无 `assigneeAgentId` → `WHO_UNRESOLVED`
- `-` Agent 被移出 Team 后派发 → `WHO_NOT_IN_TEAM`（**不改派**）
- `-` WITH 链不读 `workspace.model`（P2：构造一个有 `workspace.model` 的场景，断言它没被用上）
- `-` WITH 链不调用 `agentProviderSeed()`（P5：workspace 上一次会话跑 Codex，Agent 默认 Claude，v1 路径解析出 Claude）
- `-` WHERE 链函数签名不含 agent 参数（W-note 的结构性断言）
- `+` **S2 回归**：Session 建好后改 Agent 的 provider，resume 同一 Session → provider 不变
- `+` **AC8 回归**：一个普通开发 Task（无 requiredCapabilities）指派给任意 Agent，Project 的 Default Workspace 在 Linux runner 上 → 解析出的 runner 恒为该 Linux runner，**与 Agent 是谁无关**（参数化跑遍多个 Agent）

### 04B Runner capability 上报
- `+` runner 探测到 macOS/Xcode/GPU 时上报对应 slug
- `+` 上报为**自探**，配置文件无法覆盖（C3）
- `-` 上报未知 slug 不报错也不匹配任何 requirement（C2）
- `M` 旧版本 runner 不发该字段时服务端不报错

### 04C Capability 匹配与 Runner 调度
- `+` 需求 `["macos"]` + 两个候选（Linux/Mac）→ 选中 Mac
- `+` 需求为空 + Default Workspace 可行 → 选中 Default
- `+` Default 不可行、另一候选可行 → 选中候选，`resolution.where.source = "project-candidate"`
- `+` 多个可行候选 → 按 `position ASC, id ASC` 确定性选择（同一输入跑两次结果相同）
- `-` 无候选满足 → `RUNTIME_REQUIREMENT_UNMET`，错误里逐机器列出缺失能力
- `-` `task.workspaceId` pin 的机器不满足需求 → `RUNTIME_REQUIREMENT_UNMET`，**不改派**
- `-` `task.workspaceId` pin 到**不在候选集**的 Workspace → `NO_PROJECT_WORKSPACE`（pin 不得绕过候选集边界，§7.3 优先级 1(a)）
- `-` `capabilitiesReportedAt IS NULL` 且需求非空 → 不满足（C4）
- `-` `runner.labels` 命中但 capabilities 未命中 → 仍然不满足（C5）
- `-` Project 无候选 Workspace → `NO_PROJECT_WORKSPACE`

### 05A CLI
- `+` `orbit agent list` 行为与 v1 前完全一致（Legacy alias 冻结，§9.2）
- `+` 新增 `orbit workspace …` / `orbit project team …` 可用
- `-` CLI↔MCP parity 测试通过（新增 MCP 参数必须同步 CLI，否则 parity 红）
- `-` 新命令族已登记 `leafHelpFamilies`（否则 leaf help 不可达）

### 05B Web：Team 与 Agent 配置
- `+` 展示/增删成员、设 Coordinator、设 Default Workspace
- `+` 空 Team 展示空态而非报错（§11.4）
- `-` 非 Team Agent 不出现在指派选择器

### 05C Web：Task 指派与任务树
- `+` 任务树每行展示 Assignee Agent 名 + 其 Provider
- `+` `task.provider` pin 时展示"任务级覆盖"而非 Agent 默认
- `-` 历史 Task（无 agent）展示 legacy assignee 并标注未迁移

### 05D Web：Session 执行快照与调度来源
- `+` Session 详情展示 who / with / where 三段及各自 source
- `+` 发生 fallback 时展示"原定 X → 实际 Y（按 Agent 配置）"
- `-` `resolution.v` 为未知版本时降级展示，不白屏
- `-` `resolution` 里的 id 出站为 base62（B3）

### 06A 兼容层
- `+` 无 Project 的 Task 走 legacy 路径，派发结果与 v1 前逐字段相同（黄金用例对比）
- `+` MCP `agent_create` 仍然创建 Workspace（§9.2）
- `-` Task 被填 `projectId` 但无 `assigneeAgentId` → `WHO_UNRESOLVED`（L2 的显式失败，作为**期望行为**断言）

### 06B 兼容回归矩阵
- `M` 迁移在空库跑通、在生产快照跑通，`migrate diff` 对新增列为空（M3）
- `M` 迁移不含任何 `DROP COLUMN`（M4，直接 grep migration SQL）
- `+` 旧客户端载荷（录制的真实响应）对新服务端仍可解码（§11.4）
- `+` Swift 端解码新增可选字段不崩（原生端最低要求）
- `+` **AC8 端到端**：构造"Mac runner + Linux runner + 一个普通开发 Task"，跑 N 次派发，断言从未落到 Mac runner

---

## 14. 项目验收标准 → 自动化测试映射

项目的 8 条验收标准，每条都必须能被指名的自动化测试证明。

| # | 项目验收标准 | 落地条款 | 证明它的测试 |
|---|---|---|---|
| 1 | Project 可配 Coordinator + 多成员 Agent，公开 ID 均 Base62 | §3.2, §10 | 02B `+`加成员/设 Coordinator · 02B `-`第二个 Coordinator · `public-id-coverage.spec.ts` · 03B API 全套 |
| 2 | Agent 可配 Provider/Model/提示词/能力/权限；Provider 不再由普通 Task 直接配置 | §3.1, §7.2 | 02A `+`字段读回 · 03A CRUD · 04A `-`WITH 链不读 workspace.model · 03C `-`Member 改 task.provider 403 |
| 3 | Task 只从 Project Team 选 assigneeAgent；Coordinator 建树，执行 Agent 在权限内建子任务 | §8.2, §8.4 | 03C 全部 7 条（四个写路径各一条） |
| 4 | Task Session 默认用 Project 当前 Workspace + Agent 的 Provider/Model；Session 存不可变快照 | §6, §7.2, §7.3 | 04A `+`三链组合 · 04C `+`需求为空选 Default · 04A `+`S2 回归 · 02D 快照列 |
| 5 | macOS/Xcode/GPU 经独立 runtime capability 选 Runner，不再由 Agent 身份隐式决定 | §7.3, §3.5 | 04C 全部 9 条 · 04A `-`WHERE 签名不含 agent · 04B 上报 |
| 6 | Web/API/CLI 对 Team、Agent 配置、指派与调度结果有完整可独立运行的测试，并覆盖迁移 | §13 全表 | 本表所列全部；每条都能 `node --test` / `vitest` / `go test` 单独跑 |
| 7 | UI 能管理团队，并在任务树里清晰展示 Assignee Agent 及其 Provider | §11.4 | 05B 全部 · 05C 全部 |
| 8 | 既有行为兼容，且**可验证**普通开发 Task 不会再被错调度到 Mac Runner | §11, §7.3 | 06A 黄金用例 · 06B `M`迁移 diff · **04A `+`AC8 回归** · **06B `+`AC8 端到端** |

> 第 8 条是本项目的**根因验收**，因此在单元层（04A，参数化跑遍 Agent）与端到端层（06B，跑 N 次派发）各有一条独立测试。只有其中之一都不算通过。

---

## 15. 已冻结的取舍

记录**为什么这样定**，避免后续任务重新开会。

1. **新建 `agent` 表，而不是把 `workspace` 改名。** `workspace` 有 110k 关联行、被 iOS/macOS/MCP/CLI 四个面引用；改名是一次不可逆的全栈重构。新表 + 1:1 镜像回填让每一步都能独立回滚。
2. **`project_workspace` 用关联表，不用 `project.default_workspace_id` 一列。** 一个 Project 跨机器（协调者在 Linux、iOS 构建在 Mac）是本项目要支持的正常形态，单列表达不了候选集；同一事实两处落库必然漂移（W3）。
3. **Default Workspace 与 `coordinator_workspace_id` 保持分离**（W4）：一个是可随时改的设置，一个是重绑要 409 的强约束。
4. **不回填 `task.assignee_agent_id`**（M1）：替 11 万行历史任务决定"谁做"，比让它们显式失败更危险，而它们中绝大多数根本不该进新链。
5. **WHO 与 WHERE 没有 fallback**（§7.4 第 5 条）：换人做、换机器做都是业务决定。系统代劳一次，就等于把"意外调度"重新发明一遍。
6. **`runner.capabilities` 由心跳自探，不可手工覆盖**（C3）：可手写的能力声明是一句可以撒谎的话，而 AC5 的整个价值在于它不能撒谎。
7. **未上报能力 = 不具备**（C4），与既有 `runsAsRoot` 的 NULL 语义方向相反且是刻意的：那里"不知道"不该**移除**一个今天能用的模式，这里"不知道"不该**授予**一个未经证实的能力。
8. **一次迁移（0111）而不是五次**：五个模块的 schema 改动互相引用（回填 Team 需要 Agent 与 Project Workspace 同时存在），拆成五次迁移会产生四个不可用的中间态。02A–02E 分工不变，但落成同一个 migration 目录。
9. **不复活 `targetRunnerId` / `targetLabels`**（§11.3）：它们是有写无读的死配置，接进 WHERE 链等于新增一条与 §7.3 平行的隐式路径。

## 16. 遗留的开放问题（不阻塞 02 阶段）

明确记录、明确不解决，避免被当成疏漏：

- **O1**：`agent` 的 `disallowedTools` 与 `workspace_permission_rule`（工作区级"始终允许"）如何叠加，v1 未定义。v1 行为：两者独立生效，取更严的一侧。真正的合并规则等 03A 有实际用例再定。
- **O2**：Coordinator Agent 与 Coordinator Session 的绑定（同一个 Project 的协调对话是否必须由 Coordinator Agent 发起）v1 不强制。既有 `coordinatorSessionId` 的写入路径不变。
- **O3**：摘掉 `orbit agent` / MCP `agent_*` 的 deprecated 别名需要原生端先跟进，**不在 v1 范围**（§9.2）。
- **O4**：多个可行 Workspace 时的负载均衡（C6）v1 不做。
- **O5**：iOS/macOS 的 Team / Agent 配置 UI 不在 v1 范围；v1 对原生端的唯一要求是不崩（§11.4）。
