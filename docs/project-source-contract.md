# Project SOURCE 解析契约 v1

**状态**：冻结（v1）。本契约是阶段 1 的地基，`34D2Afu5EbYy5pjIhTeyA`（数据模型）、`34D2Ag07wpjnJiLee0I74`（dispatch/claim 协议）、`34D2Ag6etI5BbQiXFAMTb`（解析器）、`34D2Ag9O0KnLGxLXifk39`（runner worktree）、`34D2AgBv8ROr1rfvdtZEK`（CAS 与恢复）、`34D2AgHxulKr87lKaZgYW`（依赖 closure）、`34D2AgK6sXw5VEbTu70EP`（integration 合并）、`34D2AgMRztyeLUaaV9CWM`（API/CLI/UI）按本文实现，不得各自另行发明词汇、状态或错误码。

**与既有契约的关系**：
- `docs/project-agent-contract.md`（下称 **PAC**）定义 WHO / WITH WHAT / WHERE 三条解析链。本契约定义**第四条正交链 SOURCE —— 从哪份代码开始**，并复用 PAC §6 的"执行快照冻结"范式与 §12 的"错误码闭合"范式。
- `docs/project-coordinator-status-contract.md` 定义 coordinator 状态读接口；本契约只向它贡献一个 blocker kind（§10.3）。

**编号约定（唯一）**：本文所有规范性条款使用**单一序列** `SR1 … SR46`，按阅读顺序分配，全文不重复编号。§11 是索引而非重述 —— 两处编号就是两处会漂移的真相，PAC v1 的二义正是这么来的。

---

## 0. 本契约存在的理由

今天一条 session 的代码起点由 `setupWorktree`（`src/runner-go/worktree.go:542`）决定，规则是一行：

```go
base, err := git(baseDir, "rev-parse", "HEAD")   // workDir 的当前 HEAD
```

`baseDir` 来自 `workspace.workDir` —— 也就是 **WHERE**。于是"把任务交给哪台机器"隐式地决定了"从哪份代码开始"。更糟的是这条路径上每一个失败分支都**降级而不是拒绝**：不是 git 仓库 → `shared-nogit`，没有 HEAD → `shared`，`worktree add` 失败 → `shared`。三个降级都会让 agent 直接在**共享 checkout** 里写文件。

对普通会话这是对的（用户就是想在那个目录里干活）。对 Project 代码任务这是错的：

- 同一个 Project 的两个任务派到两台机器，起点是两台机器各自 checkout 的当前状态，无人能解释；
- 依赖任务 B 无法保证看得见前置 A 已验收的产物；
- verification 任务检查的是"现在的 HEAD"，不是它要判定的那个候选提交；
- 重试丢掉上一代挣到的 known-good 点；
- 降级到共享 checkout 会让并发的两个 session 互相覆盖。

**SR1**：Project 代码任务的 SOURCE 必须是一次**显式解析的结论**，而不是任何目录的当前状态。`workspace.workDir` 的 HEAD、`workspace.defaultMergeTarget`、worktree 的 `git symbolic-ref HEAD`，**三者都不是 SOURCE 的输入**。

**SR2**：`workspace.defaultMergeTarget` 的语义在 v1 内**不变、不扩展、不复用**。它是"状态栏 Merge 下拉框上次选的分支"，由 `mergeToMain` 在每次显式合并时回写到 workspace 上（`src/apiserver/src/sessions/sessions.service.ts:3727`；`src/runner-go/worktree.go:605` 的注释已经写明：拿它当基线会让一次一次性合并悄悄给该 workspace 之后所有 session 换基线）。把它读进 SOURCE 解析器，等于把一个**会被写回的展示偏好**升级成代码基线。

---

## 1. 分层原则

**SR3（四链正交）**：一次运行由四条**顺序执行、互不传参**的链决定：

| 链 | 问题 | 契约 | 结论落在 |
|---|---|---|---|
| WHO | 谁做 | PAC §7.1 | `session.agentId` |
| WITH WHAT | 用什么做 | PAC §7.2 | `session.provider` / `model` |
| WHERE | 在哪里做 | PAC §7.3 | `session.workspaceId` / `assignedRunnerId` |
| **SOURCE** | **从哪份代码开始** | **本契约** | **`session.source*`（§3.2）** |

任何实现里出现"因为跑在 workspace X 上，所以基线是 Y"都是对 SR3 的违反。反向同样禁止：SOURCE 不得参与 WHERE 的候选集计算（Project 的 workspace 候选集由 PAC §7.3 决定；SOURCE 只在候选被选定之后，对该候选**提出要求**（仓库身份与隔离能力），要求不满足就拒绝，见 §5 G1 与 G6）。

**SR4（意图与事实分离）**：SOURCE 有且只有两半，任何实现不得把它们合并成一列：

- **SourceSelector（意图）**：从哪个仓库的哪条线开始。用 ref / 显式 revision / 依赖 closure 表达，在 **Session create** 冻结。
- **SourcePin（事实）**：这次运行实际从哪个 commit 开始。40 位十六进制 SHA，在 **首次 claim** 冻结。

Branch 表达意图，commit SHA 表达运行事实，**两者必须同时留痕**。只有 selector 的运行无法复现；只有 pin 的运行无法解释为什么是这个 commit。

**SR5（非代码 Project 不被强迫使用 Git）**：一个 Project 可以没有 `ProjectCodebase`。没有绑定代码库的 Project，其任务的 SOURCE 状态恒为 `UNBOUND`（§6），走 Legacy 路径（§9），**不产生任何 Git 要求、不产生任何拒绝**。"这个 Project 需要代码"是一个**被显式记录的事实**，不是从任务文字里猜出来的。

---

## 2. 词汇表

每个术语在此有且仅有一个权威定义。实现、schema 注释、API 字段、UI 文案一律使用此处拼写。

| 术语 | 定义 | 不是什么 |
|---|---|---|
| **ProjectCodebase** | Project 到**一条代码线**的显式绑定：仓库身份 + `upstreamRef` + `integrationRef` + `refAuthority` + `configRevision`。一个 Project 可有 0 或 1 条（v1 MVP），数据模型不阻断多条。 | 不是 Workspace，不是 workDir，不是 `defaultMergeTarget`，不是"某台机器上的那个目录" |
| **repository identity（仓库身份）** | 一对值 `(canonicalRepoUrl, rootCommitSha)`。前者是规范化后的远端 URL（§7.1），后者是该仓库**第一个根提交**的 SHA。两者共同回答"两台机器上的两个 checkout 是不是同一个仓库"。 | 不是文件系统路径。路径在两台机器上必然不同，而身份必须跨机器可比 |
| **upstreamRef** | 这条代码线**从哪里来**：普通 Project 代码任务的默认基线 ref（如 `refs/heads/main`）。 | 不是合并目标 |
| **integrationRef** | 这条代码线**往哪里去**：Project 任务完成后默认合入的 ref。默认等于 `upstreamRef`，可以不同（如 upstream=`main`、integration=`refs/heads/release/next`）。 | 不是 `workspace.defaultMergeTarget`（SR2） |
| **refAuthority（ref 权威）** | 一个 ref 到 SHA 的**解析在哪里做才算数**：`REMOTE`（对 `canonicalRepoUrl` 上的远端解析）或 `RUNNER_LOCAL`（对某台指定 runner 本地 checkout 解析）。 | 不是"哪台机器跑"。权威决定**两台机器会不会解析出同一个答案** |
| **configRevision** | `ProjectCodebase` 的**配置版本号**，BigInt，单调，任一字段变更即 +1。 | 不是 git revision |
| **pinnedRevision** | Task 上的**显式 git 基线**，字符串：40 位十六进制 SHA，或一个 ref 名。 | 不是 `configRevision` |
| **SourceSelector** | SOURCE 的意图半边（SR4）。由 `sourceKind` + 仓库身份 + ref/revision + `configRevision` + `requiredContains` 构成。 | 不含 SHA（`PINNED_REVISION`/`VERIFICATION_SUBJECT`/`TASK_KNOWN_GOOD` 三种 SHA 值 selector 除外，见 §4） |
| **SourcePin** | SOURCE 的事实半边（SR4）：`sourceBaseSha` + 谁在何时用哪个权威解析出来的。 | 不是 `session.baseSha`（见 SR13） |
| **candidate commit（候选提交）** | 一个 verification 任务**正在判定的那个** commit：其 subject task 的最新 `ACCEPTED` `TaskCheckpoint` 的 `commitSha`。 | 不是 subject 分支的当前 tip |
| **accepted checkpoint** | `task_checkpoint` 中 `kind = 'ACCEPTED'` 的行。只有它能成为下游代码基线（SR24）。 | `WIP_RED` 不是 |
| **landed（已落地）** | 某个 commit 已被 `integrationRef` 的当前 tip **包含**（`git merge-base --is-ancestor <sha> <tip>` 退出码为 0）。 | 不是"有一条 receipt 说合过" —— receipt 是证据，包含关系才是事实（SR25） |
| **代码任务 / 非代码任务** | 代码任务 = 其 Project 绑定了 `ProjectCodebase` **且** 该任务未被标记 `codeless`。非代码任务不解析 SOURCE。 | 不由任务标题/描述推断 |
| **Legacy session** | `sourceState = 'UNBOUND'` 的 session（§9）。 | 不由"有没有 projectId"判定 |

**SR6（"revision" 单独出现即为契约违规）**：本契约、schema 注释、API 字段与 UI 文案中，`revision` 一词**不得单独使用**，必须写作 `configRevision` 或 `pinnedRevision`。两者一个是计数器、一个是 git 对象引用，同名会让"改了 revision"这句话有两个互相矛盾的意思。

---

## 3. 实体与字段契约

### 3.1 `ProjectCodebase`（新表 `project_codebase`）

| 列 | 类型 | 约束与语义 |
|---|---|---|
| `id` | uuid(7) | |
| `projectId` | uuid | FK → `project`，`onDelete: Cascade` |
| `ownerId` | uuid | 租户域，所有读按它过滤 |
| `slot` | text | v1 恒为 `'primary'`。留列是为了让"一个 Task 一个主 codebase 的 MVP"不阻断多仓库扩展 |
| `canonicalRepoUrl` | text | 规范化远端 URL（§7.1）。**NOT NULL** |
| `rootCommitSha` | char(40)? | 根提交指纹。NULL = 尚未观测到（§7.2 允许首次解析时补写一次） |
| `upstreamRef` | text | 全名 ref（`refs/heads/…`）。**NOT NULL** |
| `integrationRef` | text | 全名 ref。**NOT NULL**，默认写入时等于 `upstreamRef` |
| `refAuthority` | text | `REMOTE` \| `RUNNER_LOCAL`，CHECK 约束封闭 |
| `remoteName` | text | `refAuthority = REMOTE` 时使用的远端名，默认 `origin` |
| `authorityRunnerId` | uuid? | `refAuthority = RUNNER_LOCAL` 时**必填**的那台机器（SR31） |
| `configRevision` | bigint | 默认 0，单调。上面任一列变更即 +1 |
| `createdAt` / `updatedAt` | timestamptz | |

**SR7**：`@@unique([projectId, slot])`。一个 Project 的一个 slot 只有一份绑定。
**SR8**：`configRevision` 由数据库触发器维护，**不接受来自请求体的值**。一个可以由写入方自选的版本号，无法回答"这条 session 冻结的是不是当时那份配置"。
**SR9**：`upstreamRef` / `integrationRef` 必须是全名 ref（`refs/` 前缀）。短名（`main`）在 `refs/heads/main` 与 `refs/tags/main` 同时存在时是二义的，而基线不能是二义的。写入时拒绝短名，错误码 `CODEBASE_AUTHORITY_INVALID`。
**SR10**：本表**不得**新增 `workDir`、`workspaceId`、`defaultMergeTarget` 或任何指向单台机器文件系统的列（`authorityRunnerId` 是唯一例外，且它命名的是**权威**而不是执行位置）。理由与 PAC §3.1 A1 完全相同：一个"为了方便"加进来的列，就是耦合回来的路。契约自检 spec 断言这些列名的缺席。

### 3.2 Session SOURCE 快照（既有表 `session` 新增列）

| 列 | 类型 | 冻结时刻 | 语义 |
|---|---|---|---|
| `sourceState` | text | 见 §6 | `UNBOUND` \| `SELECTED` \| `PINNED` \| `REFUSED`，CHECK 封闭。默认 `UNBOUND` |
| `sourceKind` | text? | create | §4 的五种 selector 之一 |
| `sourceCodebaseId` | uuid? | create | 解析当时那条 `ProjectCodebase`。无 FK：删掉绑定不得改写已冻结的快照 |
| `sourceRepoUrl` | text? | create | 反规范化的仓库身份，**冻结**。改 codebase 的 URL 不影响在飞 session |
| `sourceRootCommitSha` | char(40)? | create | 同上 |
| `sourceRef` | text? | create | ref 值 selector 的全名 ref；SHA 值 selector 为 NULL |
| `sourceRevisionSha` | char(40)? | create | SHA 值 selector 的 SHA；ref 值 selector 为 NULL |
| `sourceConfigRevision` | bigint? | create | 解析当时的 `ProjectCodebase.configRevision` |
| `sourceRefAuthority` | text? | create | 解析当时的权威，**冻结** |
| `sourceRequiredContains` | char(40)[] | create | 依赖 closure：基线**必须包含**的 SHA 集合（§5 G5）。默认 `{}` |
| `sourceBaseSha` | char(40)? | **首次 claim** | **SourcePin**。NULL 直到冻结成功 |
| `sourceResolvedAt` | timestamptz? | 首次 claim | |
| `sourceResolvedByRunnerId` | uuid? | 首次 claim | 哪台机器解析的（溯源，从不作为决策输入） |
| `sourceRefusalCode` | text? | 拒绝时 | §10 的错误码 |
| `sourceRefusalDetail` | jsonb? | 拒绝时 | 结构化细节 + `fixAction` |

**SR11（selector 与 pin 恰好一个封条，各自唯一）**：快照被分成两个**不相交**的集合，各有一个封条，因此"这一列现在还能不能写"永远只有一个答案：

| 集合 | 成员 | 封条 | 封后唯一合法改写 |
|---|---|---|---|
| **create-frozen** | `sourceKind`、`sourceCodebaseId`、`sourceRepoUrl`、`sourceRootCommitSha`、`sourceRef`、`sourceRevisionSha`、`sourceConfigRevision`、`sourceRefAuthority`、`sourceRequiredContains` | `sourceState != 'UNBOUND'` | 无 |
| **claim-frozen** | `sourceBaseSha`、`sourceResolvedAt`、`sourceResolvedByRunnerId` | `sourceBaseSha IS NOT NULL` | 无 |

两个集合没有交集，并集就是上表减去 `sourceState` / `sourceRefusalCode` / `sourceRefusalDetail` 三列（那三列是状态机自身，由 §6 的转移表管辖）。

**SR12（claim-frozen 集合无 `retiredPin` 类例外）**：PAC §6 S4 给 `model` 留了"模型被下架时改写一次"的例外，因为一个不存在的模型无法运行。SOURCE **没有对应的例外**：一个不可达的 SHA 不是"换一个"的理由，是**拒绝的理由**（SR33）。换基线会让运行结果与它声称验证的东西无关。

**SR13（`sourceBaseSha` 与既有 `session.baseSha` 是两列，不是一列）**：
- `session.baseSha` 是**既有的、可被治愈的**列：`resolveBaseSha`（`worktree.go:454`）会在 reclaim 时把它向分支真实 fork 点收紧，好让 diff 不把别人的提交算成本 session 的删除。它服务于 **diff 展示**。
- `sourceBaseSha` 是**不可变的事实**：这次运行从哪个 commit 起步。它服务于**可复现性与依赖正确性**。

一个会被治愈的列不能承载一个不可变的事实。二者的关系由一条不变量约束（SR14），而不是由合并成一列来"简化"。

**SR14**：对 `sourceState = 'PINNED'` 的 session，runner 创建 worktree 成功的**那一刻**，必须有 `session.baseSha == session.sourceBaseSha`。此后 `baseSha` 的治愈**只允许沿该 session 自己分支的历史前移**，永远不得改指到另一条线。跨越 `sourceBaseSha` 的治愈是一个必须失败的操作，不是一次修正。

### 3.3 `Task` 新增列

| 列 | 类型 | 语义 |
|---|---|---|
| `pinnedRevision` | text? | 显式基线（§4 P2）。40 位十六进制 SHA 或全名 ref |
| `codeless` | boolean | 默认 `false`。`true` = 即使 Project 绑了 codebase，这个任务也不解析 SOURCE（SR5 的逃生口：一个绑了代码库的 Project 里的调研/文档任务） |

**SR15**：`pinnedRevision` 写入时校验：40 位十六进制（小写规范化）→ SHA 值 selector；否则必须是全名 ref → ref 值 selector。两者都不是则拒绝 `CODEBASE_AUTHORITY_INVALID`。**缩写 SHA 一律拒绝** —— 缩写按构造就是二义的，而基线的全部意义是事后可核对。
**SR16**：往 `verifiesTaskId` 非空的任务上写 `pinnedRevision`，拒绝 `SOURCE_PIN_IMMUTABLE`。理由见 §4 D1：一个 verification 的全部意义是"检查那个候选"，允许改基线就是允许它对着别的代码宣布结论。

---

## 4. SOURCE 解析优先级（真值表）

解析器是一个**纯函数**，签名固定：

```
resolveSource(input: SourceResolutionInput) -> SourceSelector | Refusal
```

**SR17（输入集封闭）**：`SourceResolutionInput` 的类型**只含**下列字段。它不含 `workspace`、`workDir`、`defaultMergeTarget`、`runnerId`、`assignedRunnerId`，因此"WHERE 泄漏进 SOURCE"在**类型层面**不可表达，而不是靠 review 拦截：

```
{ task: { id, projectId, verifiesTaskId, pinnedRevision, codeless,
          attemptGeneration, inheritedKnownGoodSha, dependsOnTaskIds },
  codebase: ProjectCodebase | null,
  subjectCandidate: { taskId, commitSha } | null,
  prerequisiteCheckpoints: Array<{ taskId, commitSha, kind }> }
```

**SR18（解析结论自带理由）**：返回值必须携带 `reason`：命中了哪一条优先级、依据的输入是什么。一个说不出为什么的基线，用户无法在 UI 上得到"这次运行为什么从这里开始"的回答（Project AC7）。

### 4.1 优先级表

自上而下，第一条谓词为真者胜。

| 序 | 谓词 | `sourceKind` | 基线取值 | selector 类型 |
|---|---|---|---|---|
| **P0** | `codebase == null` ∧ 任务需要代码 | — | — | **拒绝** `PROJECT_CODEBASE_UNBOUND` |
| **P0'** | `codebase == null` ∧ `task.codeless` 或非 Project 任务 | — | — | `UNBOUND`（Legacy，§9） |
| **P1** | `verifiesTaskId != null` | `VERIFICATION_SUBJECT` | subject 的 candidate commit | SHA 值 |
| **P2** | `pinnedRevision != null` | `PINNED_REVISION` | 该 SHA，或该 ref 在权威处的解析结果 | SHA 值或 ref 值 |
| **P3** | `attemptGeneration > 0` ∧ `inheritedKnownGoodSha != null` | `TASK_KNOWN_GOOD` | 该 SHA | SHA 值 |
| **P4** | 存在 ≥1 个**代码**前置任务 | `DEPENDENCY_CLOSURE` | `integrationRef` 的 tip，且 `requiredContains` = 所有前置的 accepted checkpoint SHA | ref 值 + 包含约束 |
| **P5** | 以上皆否 | `PROJECT_UPSTREAM` | `upstreamRef` 的 tip | ref 值 |

**SR19（拒绝不回退）**：命中某一序后，若该序的输入不可用（P1 的 subject 没有 candidate、P3 的 SHA 不可达、P4 的前置没有 accepted checkpoint），**结果是拒绝，不是落到下一序**。回退会让一次本该停下来的运行拿到一个"看起来能跑"的基线 —— 这正是 §0 那三个降级分支的形状。

### 4.2 两两消歧（为什么是这个序）

优先级表的相邻两序的谓词**并非天然互斥**，因此每一对都必须有一条明写的理由。契约自检对**每一对各跑一次谓词交集**，而不是只比对 `sourceKind` 的集合 —— 只比集合会让所有交集都漏过去（PAC §12 E3 踩过这个坑）。

| 对 | 能否同时为真 | 定序 | 理由 |
|---|---|---|---|
| **D1** P1 ∩ P2 | 存量数据可能（SR16 之前写入的行） | **P1 胜** | verification 的结论是"关于那个候选"的。允许 pin 改基线，等于允许它对着别的代码宣布 PASS。SR16 让新写入不再制造这个交集，P1 优先则让存量行也有确定答案 |
| **D2** P1 ∩ P3 | 能（verification 任务自己被重试） | **P1 胜** | 重试一次 verification 必须**重新检查同一个候选**。若 P3 胜，重跑一次 verification 会悄悄换到更新的提交上 —— 上一轮 FAIL 的代码就此逃过复检 |
| **D3** P2 ∩ P3 | 能（被 pin 的任务被重试） | **P2 胜** | pin 是人对机器记忆的显式覆盖；`inheritedKnownGoodSha` 是机器的记忆。人写下的东西胜过推导出来的东西 |
| **D4** P3 ∩ P4 | 能（有前置的任务被重试） | **P3 胜** | 重试是**同一件工作的延续**；把它改基到已经前移的 integration tip，会丢掉上一代挣到的 known-good 点、重做已经解决的工作。依赖安全**不因此被跳过**：`requiredContains` 仍然由 §5 G5 施加于 P3 选出的基线上，前置没落地就拒绝（SR22） |
| **D5** P4 ∩ P5 | 不能（P4 要求前置集非空，P5 要求为空） | 结构互斥 | 无需定序 |
| **D6** P0 ∩ 其余 | 不能（P0 要求 `codebase == null`，P1–P5 全部读 codebase） | 结构互斥 | 无需定序 |

**SR20**：D1–D4 的四条交集，每条都必须有一个**同时满足两个谓词**的构造性测试用例，断言解析结果等于定序方的结论。

---

## 5. 准入闸（Admission Gate）

优先级表决定**选哪个** selector；准入闸决定**它能不能用**。两者分离是本契约的核心结构：闸门只有"通过"和"拒绝"两个出口，**没有"换一个"**。

**SR21（闸门全序、逐级、每级恰好一个错误码）**：闸门按下表顺序执行，前一级通过才进入下一级。因此任一输入至多命中一个错误码，"同一输入两个码"在结构上不可能。

| 级 | 检查 | 通过条件 | 拒绝码 |
|---|---|---|---|
| **G0** | 绑定 | Project 有 `ProjectCodebase`（或任务 `codeless`） | `PROJECT_CODEBASE_UNBOUND` |
| **G1** | 仓库身份 | 执行位置的 checkout 的 `(canonicalRepoUrl, rootCommitSha)` 等于快照冻结的那一对（§7.1） | `BASE_REPO_MISMATCH` |
| **G2** | 权威可达 | 能够向 `refAuthority` 提问（`REMOTE`：`git ls-remote` / `fetch` 成功；`RUNNER_LOCAL`：本机是 `authorityRunnerId`） | `SOURCE_AUTHORITY_UNREACHABLE` |
| **G3** | selector 解析 | ref 值 selector：该 ref 在权威处存在 | `BASE_REF_NOT_FOUND` |
| **G4** | 对象可得 | 解析出的 SHA（或 SHA 值 selector 的 SHA）在本机是一个**存在的 commit 对象**（必要时先从权威 fetch） | `BASE_SHA_UNAVAILABLE` |
| **G5** | 依赖包含 | `sourceRequiredContains` 的每一个 SHA 都被基线包含（`merge-base --is-ancestor`） | `DEPENDENCY_BASE_NOT_LANDED` |
| **G6** | 隔离可得 | 能在该基线上创建独立 worktree | `WORKTREE_REQUIRED` |

**SR22**：G5 对**每一个** selector 生效，包括 P1/P2/P3 这三种 SHA 值 selector。D4 的定序不豁免依赖检查，它只是决定了**在哪个基线上**做这个检查。

**SR23（G1 早于 G4 的理由，非任意）**：仓库不匹配时，那个 commit 对象**必然**也不在本机。若先报 `BASE_SHA_UNAVAILABLE`，用户会去找一个"丢失的提交"，而真正要改的是绑定。先报身份不匹配，把人指向唯一能修好它的动作。

**SR24（G6 最后的理由，非任意）**：G0–G5 是 **Project 级**问题（改绑定、改 ref、把前置合进去），换一个 workspace 修不好；G6 是 **Workspace 级**问题（那台机器的那个目录不能隔离），换一个 workspace 就能绕开。先报项目级的因，用户才不会在换过机器之后又撞上同一个 ref 错误。

**SR25（只有 accepted checkpoint 能进 `requiredContains`）**：`sourceRequiredContains` 的每一个成员必须来自一条 `kind = 'ACCEPTED'` 的 `task_checkpoint`。`WIP_RED` 的 commit **不得**进入下游基线，理由与 `session_merge_receipt` 上那条"LANDED receipt 不得指向 WIP_RED checkpoint"的触发器完全相同。

**SR26（landed 是包含关系，不是 receipt）**：G5 判定的是 `merge-base --is-ancestor`，**不是**"存在一条 `result = 'MERGED'` 的 receipt"。receipt 是**证据**（谁在何时报告合过），包含关系是**事实**。目标分支被重写、合并被回滚、receipt 属于另一条 integration 线，三种情况下 receipt 都在而事实不在。已有记忆写明这一点：`ok:true` 不等于已合并。

**SR27（非代码前置不制造 Git 要求）**：前置任务中 `codeless = true` 的，或所在 Project 无 codebase 的，**不进入** `requiredContains`，也不使本任务成为 P4。一个"写文档"的前置不该让下游任务要求一个不存在的 checkpoint。

---

## 6. 冻结契约与状态机

### 6.1 状态与转移

```
                    ┌──────────┐
   create(非代码)   │ UNBOUND  │  Legacy 路径，永不解析（§9）
   ────────────────►└──────────┘

   create(代码任务)  ┌──────────┐  首次 claim: 闸门通过 + CAS 赢  ┌─────────┐
   ────────────────►│ SELECTED │ ──────────────────────────────►│ PINNED  │
                    └──────────┘                                 └─────────┘
                          │                                        │    ▲
                          │ 首次 claim: 闸门拒绝                    │    │ resume / reclaim /
                          ▼                                        │    │ runner takeover
                    ┌──────────┐                                   └────┘  (读，从不重推导)
                    │ REFUSED  │  终态。恢复 = 新开一条 session
                    └──────────┘
```

| # | from | 事件 | to | 谁写 | 备注 |
|---|---|---|---|---|---|
| T1 | — | Session create，非代码任务 | `UNBOUND` | apiserver | 与 session 行同一条 INSERT |
| T2 | — | Session create，代码任务 | `SELECTED` | apiserver | selector 九列与 session 行**同一条 INSERT**（SR28） |
| T3 | `SELECTED` | 首次 claim，闸门 G0–G6 全过 | `PINNED` | apiserver（CAS） | §6.3 |
| T4 | `SELECTED` | 首次 claim，闸门拒绝 | `REFUSED` | apiserver | 写 `sourceRefusalCode` + 落 blocker（§10.3） |
| T5 | `SELECTED` | CAS 失败（并发 claim 已冻结） | `PINNED` | — | 读到赢家的 pin，幂等继续（SR30） |
| T6 | `PINNED` | resume / reclaim / takeover / 心跳 / merge 回报 | `PINNED` | — | **只读**（SR29） |
| T7 | `PINNED` | 后续 claim 拿不到 `sourceBaseSha` | `PINNED` | — | **不改状态**，本次运行失败 `BASE_SHA_UNAVAILABLE`（SR33） |
| T8 | `REFUSED` | 任何事件 | `REFUSED` | — | 终态。无 T→SELECTED 的边（SR34） |

**SR28（selector 与 session 同一条 INSERT）**：selector 九列不得由 create 之后的第二条 UPDATE 写入。存在一个"session 已可被 claim 但 selector 还没写"的窗口，就存在一次会读到空 selector 并按 Legacy 起跑的 claim。

**SR29（恢复路径一律不得重新推导）**：resume / reclaim / takeover / 心跳 / merge 回报路径**一律不得**读取 `project_codebase.*`、`task.*`、`task_checkpoint.*` 来重算上表任何一列。必须有一条测试：pin 之后把 `ProjectCodebase.upstreamRef` 改掉、把 `configRevision` 推高、把 `integrationRef` 的 tip 前移，再 resume 同一条 session，`sourceBaseSha` 与九列 selector 全部不变。

**SR30（CAS 输家读赢家，从不覆盖）**：并发 claim / 重复 dispatch / runner takeover 最终**至多产生一个** `sourceBaseSha`。输家必须读取已提交的快照并**沿用**它；若读到的 pin 与自己解析出的 SHA 不同，输家**沿用已提交的那个**并记录一条告警，而不是覆盖 —— 已经有一个 worktree 建在赢家的 SHA 上。

**SR31（`RUNNER_LOCAL` 权威必须绑机器）**：`refAuthority = RUNNER_LOCAL` 且 `authorityRunnerId` 为空，写入时拒绝 `CODEBASE_AUTHORITY_INVALID`。一个"以某台不确定的机器的本地状态为准"的权威，两台 runner 会解析出两个答案，正是本项目要消灭的东西。

### 6.2 冻结时刻表

| 冻结物 | 时刻 | 冻结后 |
|---|---|---|
| SourceSelector（九列） | Session **create** | 只读。改 codebase 配置、改 task 的 `pinnedRevision`、前置任务再落地一个 checkpoint，**都不改写在飞 session** |
| SourcePin（`sourceBaseSha` 等三列） | **首次 claim** | 只读，无例外（SR12） |
| worktree | 首次 claim，pin **之后** | 建在 `sourceBaseSha` 上（SR14） |

**SR32（create 冻结 selector、claim 冻结 SHA，两个时刻不可合并）**：
- selector **不能**推迟到 claim：claim 时读配置，等于让"session 排队期间管理员改了 integrationRef"悄悄改写这次运行的意图。
- SHA **不能**提前到 create：create 时 apiserver **没有** checkout，无法把 ref 解析成 SHA；而且同一条 ref 在 create 与 claim 之间的推进**应当**被这次运行看到 —— 一条排队 10 分钟的任务应该从它**起跑时**的 `main` 开始，不是从**入队时**的。

这一条同时回答了兄弟任务 `34D2Ag07wpjnJiLee0I74` 的验收条款"配置在 create 后变化不改写 selector，同一 ref 在 claim 前推进可解析到启动时 commit" —— 两句话不矛盾，因为它们说的是两个不同的冻结物。

### 6.3 首次 claim 的三步握手

apiserver 没有 checkout，runner 有。因此 ref→SHA 的解析必须在 runner 上做，而冻结必须在 apiserver 上做：

```
1. claim   apiserver → runner   ClaimedSession.source = {selector 九列}
2. resolve runner（本地）        G1→G5 全序执行；得到 sha，或得到一个拒绝码
3. pin     runner → apiserver    POST /runner/sessions/:id/source/pin
                                 { baseSha } | { refusal: { code, detail } }
           apiserver 执行 CAS：
             UPDATE session SET source_base_sha=$sha, source_state='PINNED',
                                source_resolved_at=now(), source_resolved_by_runner_id=$runner
             WHERE id=$id AND source_state='SELECTED' AND source_base_sha IS NULL
           返回 { state:'PINNED', baseSha } —— 无论自己赢还是读到赢家的（SR30）
4. worktree  runner              仅在收到 PINNED 之后，在返回的 baseSha 上建 worktree（G6）
5. engine    runner              仅在 worktree 建成之后启动
```

**SR33（engine 启动的前置条件是合取式）**：对 `sourceState != 'UNBOUND'` 的 session，engine 进程被启动的**充要条件**是：`sourceState = 'PINNED'` **且** 本机 worktree 已建立在 `sourceBaseSha` 上。任何一半不成立，**不启动 engine、不写共享目录、不 `git init`、不落到 `shared` / `shared-nogit`**。这是 §0 那三个降级分支在新式路径上的**全部**答案。

**SR34（REFUSED 是终态，恢复靠新 session）**：一条 `REFUSED` 的 session 永不重新解析。用户修好绑定 / ref / 前置之后，重跑任务会创建一条**新的** session，在**当时**的 `configRevision` 上冻结一份**新的** selector。这既保住了"selector 在 create 冻结"，又给了明确的恢复路径。

**SR35（协议兼容拒绝）**：不认识 `ClaimedSession.source` 的旧 runner 会忽略它并按 Legacy 起跑 —— 这正是必须防住的。因此：对 `sourceState = 'SELECTED'` 的 session，claim 时若该 runner 的能力集不含 `source-pin/v1`，apiserver **拒绝把这条 session 派给它**，错误码 `SOURCE_PROTOCOL_UNSUPPORTED`，session 停留在 `SELECTED`（不是 `REFUSED` —— 换一台新 runner 就能跑，这不是配置错误）。

### 6.4 恢复语义（真值表）

| 场景 | `sourceState` | 结果 |
|---|---|---|
| 步骤 2 之前 runner 崩溃 | `SELECTED` | 重新 claim，重新解析。**允许**解析出与上次不同的 SHA（还没冻结，ref 前移是合法的） |
| 步骤 3 CAS 成功后、步骤 4 之前崩溃 | `PINNED` | 重新 claim 读到 pin，在**同一个** SHA 上建 worktree |
| 步骤 4 成功后、engine 起来之前崩溃 | `PINNED` | worktree 已在，`setupWorktree` 走既有的 re-attach 分支；`baseSha` 由 `sourceBaseSha` 校验（SR14） |
| runner 进程重启（reclaim） | `PINNED` | 同上。不重推导 |
| runner takeover（换了一台机器） | `PINNED` | 新机器必须**取得同一个 SHA**（§7.3）。取不到 → 本次运行失败 `BASE_SHA_UNAVAILABLE`，**不换基线** |
| session ended 后 resume | `PINNED` | 同一 pin。resume 不是新运行 |
| pin 之后 `upstreamRef` 前移 | `PINNED` | 无影响。必须有测试断言 |
| pin 之后 codebase 配置被改 / `configRevision` 推高 | `PINNED` | 无影响（SR29） |
| pin 之后前置任务又落地一个 checkpoint | `PINNED` | 无影响。`requiredContains` 在 create 冻结；新前置产物属于**下一条** session |
| `REFUSED` 之后用户修好配置 | `REFUSED` | 终态。重跑 → 新 session（SR34） |

---

## 7. 仓库 authority、freshness 与跨 runner 可达性

### 7.1 规范化与身份

**SR36（URL 规范化是一个纯函数，且只用于比较）**：`canonicalRepoUrl` 由一个纯函数产生：去首尾空白、去尾部 `/`、去尾部 `.git`、scheme/host 小写、丢弃 `user@` 认证前缀、scp 式 `git@host:owner/repo` 与 `ssh://git@host/owner/repo` 归一到同一形态。规范化结果**只用于身份比较，从不用于 clone** —— clone 用的是用户写下的原值。runner 侧已有 `cloneDirName`（`src/runner-go/clone.go:103`）做了同类拆解，两处必须共用同一份规则并有对拍测试。

**SR37（身份是一对值，URL 单独不够）**：只比 URL，一次远端迁移（GitHub → 自建）就会让所有 session 的身份全错；只比 `rootCommitSha`，两个 fork 无法区分。因此 G1 判定为：`canonicalRepoUrl` 相等 **或** `rootCommitSha` 相等且非空。两者皆不成立才是 `BASE_REPO_MISMATCH`。`rootCommitSha` 为 NULL 时首次成功解析可补写一次（这是**观测到的事实**，不是猜测），此后不可变。

### 7.2 freshness

**SR38（先取再解析，同一序列）**：ref→SHA 的解析必须是"**先从权威取，紧接着解析**"的一次序列（`REMOTE`：`git fetch <remote> <ref>` 后 `rev-parse FETCH_HEAD`；`RUNNER_LOCAL`：本机 `rev-parse <ref>`）。**不得**读一个来历不明的本地缓存 ref。两步之间 ref 又动了是可接受的 —— 那时冻结的仍是一个**真实存在过**的 tip；读缓存不可接受 —— 那可能是一个从未在权威上存在过的组合。

**SR39（freshness 不是时间窗）**：本契约**不定义**"多久之前 fetch 过算新鲜"。一个时间窗会让"窗内"变成一个可以跳过 fetch 的借口，而 fetch 才是唯一能证明新鲜的动作。新鲜 = 这次解析自己 fetch 过。

### 7.3 跨 runner 可达性

**SR40（`REMOTE` 权威是跨 runner 一致性的唯一保证）**：两台 runner 对同一条 selector 解析出同一个 SHA，当且仅当 `refAuthority = REMOTE`：它们向同一个远端提问。`RUNNER_LOCAL` 只保证**一台**机器上的一致性，因此 SR31 强制它绑定 `authorityRunnerId`，而绑了机器的 codebase 的任务只能派给那台机器（这一条约束由 WHERE 链在候选集阶段实施，属于 PAC §7.3 的要求项，不是 SOURCE 自己选机器 —— SR3）。

**SR41（takeover 取的是对象，不是 ref）**：接手一条已 `PINNED` 的 session 的机器，要取得的是 `sourceBaseSha` 这个**对象**，与任何 ref 现在指向哪里无关。可以为此 `git fetch <remote> <sha>`，或 fetch 该 ref 后校验对象已在。取不到就失败（SR12 / T7），**不得**换成"那条 ref 现在的 tip"。

**SR42（可达性判据是对象存在，不是 ref 存在）**：G4 判定 `git cat-file -e <sha>^{commit}`。一个已被 force-push 覆盖、但仍被本地 reflog/worktree 引用的 commit 依然是可用的基线 —— 它是一个**真实存在的、这次运行确实起步于此**的对象。ref 移动不影响已启动的 session，这是本条的直接推论。

---

## 8. 与 checkpoint、依赖、合并的接口

**SR43（复用既有证据，不另造）**：本契约**不新增**任何证据表。
- 依赖产物 = `task_checkpoint`（`kind='ACCEPTED'`）。
- 合并结果 = `session_merge_receipt`。
- 重试继承 = `task_attempt.inheritedKnownGoodSha` / `task.knownGoodSha`。
- 候选提交 = subject 的最新 accepted `task_checkpoint.commitSha`（按 `seq` 取最大，**不按 `createdAt`** —— 两个写入方可以在 `createdAt` 上打平，schema 注释已经写明这一点）。

**SR44（默认合并目标是 `integrationRef`，优先级明写）**：Project 代码任务的默认合并目标序为：`session.mergeTarget`（用户在这条 session 上显式选过）→ `ProjectCodebase.integrationRef` → `workspace.defaultMergeTarget` → runner 自动探测。第三项保留**只为 Legacy session**（`sourceState = 'UNBOUND'`）：对 `PINNED` 的 session，序列在第二项必然命中，`defaultMergeTarget` 结构上不可达。一次显式的"合到别处"**只写 `session.mergeTarget`**，绝不回写 `ProjectCodebase`（否则一次一次性合并就给整个 Project 换了 integration 线 —— SR2 的同一个病）。

---

## 9. Legacy 分流

**SR45（分流判据是一列，不是一次推断）**：`sourceState = 'UNBOUND'` ⇔ Legacy 路径。
- 该列在 **create 时决定一次**，此后不再重算；
- 迁移把**所有既有行**置为 `UNBOUND`（列默认值即 `UNBOUND`，历史行不需要 backfill —— 常量默认值只写 `attmissingval`，不重写表）；
- 因此任何历史 session、任何非 Project session、任何 `codeless` 任务、任何未绑定 codebase 的 Project 的任务，行为**逐字节不变**：`setupWorktree` 走原路径，从 workDir HEAD 分叉，失败时照旧降级到 `shared` / `shared-nogit`；
- 新式行为**只在**这一列非 `UNBOUND` 时生效。

一个"根据 task 有没有 projectId 来判断"的分流会在 Project 功能上线的那一刻改变一批既有 session 的行为；一个存下来的列不会。

**SR46（Legacy golden 测试）**：升级前后，Legacy 路径必须有逐字节一致的 golden 测试：同一份仓库状态、同一条 session，`branch` / `baseSha` / `isolationStatus` / 提交信息四项完全相同。三条降级分支（非 git 仓库、空仓库无 HEAD、`worktree add` 失败）**各要一条**，因为它们正是新式路径要禁止的行为，最容易在实现 SR33 时被顺手"修好"。

---

## 10. 错误码（冻结）

### 10.1 表

所有 SOURCE 拒绝都必须落在下表内，且携带可读 `message` 与结构化 `detail`。**没有"静默降级"这个选项**（SR33）。

| code | 路径 | HTTP | 何时 | `detail` 必须携带 | `fixAction` |
|---|---|---|---|---|---|
| `PROJECT_CODEBASE_UNBOUND` | 解析 | 409 | G0：任务需要代码，其 Project 没有 `ProjectCodebase` | `projectId`, `taskId` | `BIND_CODEBASE` |
| `BASE_REPO_MISMATCH` | 解析 | 409 | G1：执行位置的 checkout 与冻结的仓库身份不符 | 期望与实际的 `canonicalRepoUrl` / `rootCommitSha` | `FIX_WORKSPACE_REPO` |
| `SOURCE_AUTHORITY_UNREACHABLE` | 解析 | 503 | G2：向权威提问失败（网络/凭据/远端不存在） | `refAuthority`, `remoteName`, git 原始 stderr | `RETRY_OR_FIX_CREDENTIALS` |
| `BASE_REF_NOT_FOUND` | 解析 | 409 | G3：ref 值 selector 的 ref 在权威处不存在 | `ref`, `refAuthority`, 权威处已有的近似 ref | `FIX_REF` |
| `BASE_SHA_UNAVAILABLE` | 解析 | 409 | G4：SHA 在本机不是一个存在的 commit 对象，且从权威取不到 | `sha`, `sourceKind`, 取过哪些来源 | `RESTORE_COMMIT` |
| `DEPENDENCY_BASE_NOT_LANDED` | 解析 | 409 | G5：`requiredContains` 中有 SHA 未被基线包含 | 每个缺失的 `{ taskId, sha }` + 基线 SHA | `LAND_PREREQUISITE` |
| `WORKTREE_REQUIRED` | 解析 | 409 | G6：无法在基线上建立独立 worktree（非 git 仓库 / `enableWorktree` 关 / `worktree add` 失败） | `workspaceId`, 三个子因中的哪一个, git 原始 stderr | `ENABLE_ISOLATION` |
| `SOURCE_PROTOCOL_UNSUPPORTED` | 派发 | 409 | SR35：候选 runner 不支持 `source-pin/v1` | `runnerId`, 缺失的能力名 | `UPGRADE_RUNNER` |
| `SOURCE_PIN_IMMUTABLE` | 写入 | 409 | 改已冻结的 selector 或 pin（SR11）；往 verification 任务写 `pinnedRevision`（SR16） | 目标列名, 当前 `sourceState` | `START_NEW_RUN` |
| `CODEBASE_AUTHORITY_INVALID` | 写入 | 400 | 短名 ref（SR9）、缩写 SHA（SR15）、`RUNNER_LOCAL` 无 `authorityRunnerId`（SR31） | 字段名 + 收到的值 | `FIX_CODEBASE_CONFIG` |

**SR47（闭合性，双向）**：正文中每一处写作 `拒绝 <CODE>` 的错误码都必须是本表的一行；本表每一行也都必须在正文中至少被一处规则引用。**两个方向**都由契约自检断言 —— 只在表里存在的码和只在正文里存在的码，都是"两个实现都能引用同一份契约"的来源。

**SR48（同一输入只有一个码）**：解析路径七个码的谓词由 §5 的**全序闸门**消歧（SR21），结构上不可能同时命中两个。写入路径两个码的谓词互斥（`SOURCE_PIN_IMMUTABLE` 要求目标已冻结，`CODEBASE_AUTHORITY_INVALID` 要求值本身非法）。派发路径一个码独立。契约自检对**闸门全序**跑一次断言（每一级的拒绝条件蕴含前面各级已通过），而不是只比对码的集合。

**SR49（`fixAction` 是封闭集合且必须可执行）**：`fixAction` 的取值封闭于上表第六列。每一个值必须对应用户在 UI/CLI 上**做得到**的一个动作。这满足兄弟任务 `34D2AgMRztyeLUaaV9CWM` 的"所有失败码有明确修复动作"。

### 10.2 为什么 `BASE_REF_NOT_FOUND` 与 `SOURCE_AUTHORITY_UNREACHABLE` 是两个码

前者是"问到了，那条 ref 不在"，是**配置错误**，重试一万次都是同样结果，`fixAction` 是改 ref。后者是"没问到"，是**可用性问题**，重试可能就好了。合成一个码会让重试策略和用户提示两处都失去依据 —— 这正是 PAC §12 E2 禁止的同义码的反面：两个码的谓词互斥且结论不同，因此必须分开。

### 10.3 落到 `project_blocker`

**SR50（一个 kind，精确码在 payload）**：解析路径的七个码与派发路径的一个码，全部落成 `project_blocker.kind = 'SOURCE_UNRESOLVED'`，精确 `code` 与 `fixAction` 放在该 blocker 的结构化 detail 中。

理由：`project_blocker.kind` 是一套**路由词汇** —— 它回答"谁来修、UI 给哪个按钮"。这八个码路由到**同一个结论**："必须有人改配置或先把前置合进去，重试不会有帮助"。把不改变路由决策的粒度放进封闭集合，只会让 `project_blocker_kind_chk` 每加一个错误码就要改一次；放进 payload 则粒度不丢（UI 仍按 `code` 显示不同的修复按钮，靠 `fixAction`）。

**SR51（恰好一条已声明的落地位置）**：`SOURCE_UNRESOLVED` 的落地位置**有且只有一条**：数据模型任务 `34D2Afu5EbYy5pjIhTeyA` 的迁移 `0175_project_codebase_session_source` 中，一条 `ALTER TABLE "project_blocker" DROP/ADD CONSTRAINT "project_blocker_kind_chk"` 步骤，把它加进 `0142_project_blocker_verdict_apply_exhausted` 留下的封闭集合，此后共 26 个 kind。契约自检断言：本契约声称的 blocker kind 集合恰好等于当前封闭集合里的新增项，且这条声明在全文只出现一次 —— 第二处落地声明就是第二个会漂移的真相。

v1 冻结时这一条读作"尚未落地"，自检那时断言的是它的**缺席**。0175 落地后该断言翻面：现在断言的是它**在**封闭集合里，且集合大小与这里写下的数字相等。翻的是断言的方向，不是它守的东西 —— 两个版本守的都是同一句话：契约与迁移对这个 kind 的说法必须一致。

一个写不进去的拒绝码，等于一次静默跳过的派发 —— 真实数据库对它的回答是 `violates check constraint "project_blocker_kind_chk"`，而那正是 SR33 禁止的东西。

**SR52（部署顺序）**：该迁移必须**先于**任何会写 `SOURCE_UNRESOLVED` 的代码上线。理由与 0141/0142 相同：kind 是只有新代码会写的值，旧副本不会因约束接受它而受损；旧副本**读到**它会落到 `UNKNOWN_FAILURE`，那是 fail-closed 且仍会把项目摆到人面前。

---

## 11. 不变量索引（可逐条断言）

本节**不重述**任何条款，只给出每条的机械断言方式与断言位置。测试位置按既有惯例：apiserver `*.spec.ts`（`node --test`）、web `*.test.tsx`、runner `*_test.go`。

| # | 断言方式 | 位置 |
|---|---|---|
| SR1 / SR2 / SR17 | 解析器输入类型不含 `workspace` / `workDir` / `defaultMergeTarget` / `runnerId` 字段名（类型级 + 源码级断言） | `project-source-contract.spec.ts` |
| SR3 | 对同一 task 用两个不同 workspace 各解析一次，selector 九列全等 | `source-selector.spec.ts` |
| SR4 / SR11 | 冻结集合划分：两集合交集为空，并集等于声明的列集 | `project-source-contract.spec.ts` |
| SR5 / SR27 | 无 codebase 的 Project、`codeless` 任务、`codeless` 前置：解析返回 `UNBOUND`，无拒绝 | `source-selector.spec.ts` |
| SR6 | 全仓 grep：schema / DTO / 契约文档中不存在裸 `revision` 标识符（白名单：`configRevision`、`pinnedRevision`、`scopeRevision`、`verdictRevision`、`scopeRevisions`、`TaskDependencyRevision`、`TaskListRevision`） | `project-source-contract.spec.ts` |
| SR7 / SR8 / SR9 / SR10 | PostgreSQL：唯一约束、`configRevision` 触发器单调、短名 ref 被拒、禁列名缺席 | `project-codebase-schema.pg.spec.ts` |
| SR12 / SR29 / 恢复表 | pin 后改配置 / 推 `configRevision` / 前移 tip / resume / reclaim / takeover，`sourceBaseSha` 与九列不变 | `source-freeze.pg.spec.ts` |
| SR13 / SR14 | worktree 建成时 `baseSha == sourceBaseSha`；治愈跨越 `sourceBaseSha` 时失败 | `worktree_source_test.go` |
| SR15 / SR16 | 缩写 SHA 被拒；verification 任务写 `pinnedRevision` 被拒 | `task-pinned-revision.spec.ts` |
| SR18 | 每条解析结论带 `reason`，且 `reason.rank` ∈ {P1…P5} | `source-selector.spec.ts` |
| SR19 | P1/P3/P4 输入缺失时返回拒绝而非下一序（三条负向用例） | `source-selector.spec.ts` |
| SR20 | D1–D4 各一条**双谓词同真**的构造用例 | `source-selector.spec.ts` |
| SR21 / SR48 | 闸门全序：每一级的拒绝构造必须使前面各级通过；七个码两两不同时命中 | `source-gate.spec.ts` |
| SR22 | P1/P2/P3 三种 SHA 值 selector 各跑一次 G5，前置未落地时拒绝 | `source-gate.spec.ts` |
| SR23 / SR24 | 同时制造 (身份不符 + SHA 缺失) 与 (ref 错 + 无法隔离)，断言报出的是前者 | `source-gate.spec.ts` |
| SR25 | `WIP_RED` checkpoint 不进入 `requiredContains` | `dependency-closure.spec.ts` |
| SR26 | 造一条 `MERGED` receipt 但目标不含该 commit（目标被重写），G5 仍拒绝 | `dependency-closure.pg.spec.ts` |
| SR28 | 无"session 已 PENDING 而 selector 为空"的中间状态（同事务断言 + 并发 claim 断言） | `source-freeze.pg.spec.ts` |
| SR30 | 并发 claim / 重复 dispatch / takeover 三路，最终恰好一个 `sourceBaseSha`；输家沿用赢家 | `source-cas.pg.spec.ts` |
| SR31 / SR40 | `RUNNER_LOCAL` 无 `authorityRunnerId` 被拒；两台 runner 对 `REMOTE` selector 解析同一 SHA | `project-codebase-schema.pg.spec.ts` / `source_crossrunner_test.go` |
| SR32 | create→claim 之间 ref 前移：解析到**起跑时**的 commit；同区间改配置：selector 不变 | `source-freeze.pg.spec.ts` |
| SR33 | 六个拒绝码各一条：engine 未启动、共享目录零写入、无 `git init`、`isolationStatus` 不为 `shared*` | `worktree_source_test.go` |
| SR34 | `REFUSED` 后任何事件不改状态；重跑生成新 session 且 `sourceConfigRevision` 为新值 | `source-freeze.pg.spec.ts` |
| SR35 | 无 `source-pin/v1` 能力的 runner 不被派 `SELECTED` session，session 停留 `SELECTED` | `dispatch-source-capability.spec.ts` |
| SR36 / SR37 | 规范化纯函数对拍（TS ↔ Go）；URL 迁移与 fork 两个身份场景 | `repo-identity.spec.ts` / `clone_test.go` |
| SR38 / SR39 | 解析序列中 fetch 必然发生（命令序断言）；无时间窗跳过分支 | `source_resolve_test.go` |
| SR41 / SR42 | takeover 取对象不取 ref；force-push 覆盖后 pin 仍可用；ref 移动不影响已启动 session | `source_crossrunner_test.go` |
| SR43 | 候选提交按 `seq` 最大取，不按 `createdAt`（造 `createdAt` 打平的两行） | `dependency-closure.pg.spec.ts` |
| SR44 | `PINNED` session 的合并目标序在第二项命中；`defaultMergeTarget` 结构不可达；显式改目标不回写 codebase | `merge-target-source.spec.ts` |
| SR45 / SR46 | 迁移后既有行全为 `UNBOUND`；三条降级分支 golden 逐字节一致 | `source-legacy.pg.spec.ts` / `worktree_test.go` |
| SR47 / SR49 | 码表 ↔ 正文双向闭合；`fixAction` 取值封闭 | `project-source-contract.spec.ts` |
| SR50 / SR51 / SR52 | 本契约声称的 blocker kind 集合 = 迁移新增集合；写入真库成功 | `project-source-contract.spec.ts` / `source-blocker.pg.spec.ts` |

**SR53（契约自检必须先于实现存在）**：`project-source-contract.spec.ts` 是**纯契约测试**（不连数据库、不起 Nest），断言本文的自洽性：编号唯一且连续、错误码双向闭合、冻结集合不相交、闸门全序、禁列名缺席、`fixAction` 封闭、§13 的每一行都引用得到一条 §12 用例。它在任何实现任务开工前就应当能跑绿 —— 一份没有自检的契约，与一份没有人读的契约在效果上相同。

---

## 12. 各实现任务必须覆盖的用例

**验收基线**：每个实现任务合并前至少要有这些用例的自动化测试。编号唯一、分类合法（`+` 正向 · `-` 拒绝 · `M` 迁移 · `C` 兼容）。

### 12.1 `S1` — 数据模型与迁移（`34D2Afu5EbYy5pjIhTeyA`）

| # | 类 | 用例 |
|---|---|---|
| S1.01 | M | 迁移可在现有数据上执行；既有 session 行全部 `sourceState = 'UNBOUND'`（SR45） |
| S1.02 | M | 常量默认值不触发全表重写（`attmissingval` 断言） |
| S1.03 | + | `project_codebase` 唯一约束 `(projectId, slot)`（SR7） |
| S1.04 | + | `configRevision` 由触发器单调递增，请求体给值被忽略（SR8） |
| S1.05 | - | 短名 ref 写入被拒（SR9） |
| S1.06 | - | `RUNNER_LOCAL` 无 `authorityRunnerId` 被拒（SR31） |
| S1.07 | - | 禁列名（`workDir`/`workspaceId`/`defaultMergeTarget`）在 `project_codebase` 上缺席（SR10） |
| S1.08 | - | create-frozen 九列在 `sourceState != 'UNBOUND'` 后不可写（SR11） |
| S1.09 | - | `sourceBaseSha` 非空后不可写（SR11 / SR12） |
| S1.10 | M | `project_blocker_kind_chk` 新增 `SOURCE_UNRESOLVED` 且可写入（SR51） |
| S1.11 | + | 非代码 Project 不被要求绑定 codebase（SR5） |

### 12.2 `S2` — dispatch/claim 协议（`34D2Ag07wpjnJiLee0I74`）

| # | 类 | 用例 |
|---|---|---|
| S2.01 | + | selector 九列与 session 行同一条 INSERT（SR28） |
| S2.02 | + | 重复 dispatch / 重复 claim / takeover 只产生一个 SOURCE 快照（SR30） |
| S2.03 | + | create 后改配置不改写 selector（SR32） |
| S2.04 | + | 同一 ref 在 create→claim 间前移，解析到起跑时 commit（SR32） |
| S2.05 | + | pin 后 resume/reclaim 复用同一 SHA（SR29） |
| S2.06 | - | 不支持 `source-pin/v1` 的 runner 得到 `SOURCE_PROTOCOL_UNSUPPORTED`，session 停留 `SELECTED`（SR35） |
| S2.07 | + | 三步握手顺序：pin 返回 `PINNED` 之前 runner 不建 worktree（SR33） |

### 12.3 `S3` — 解析器（`34D2Ag6etI5BbQiXFAMTb`）

| # | 类 | 用例 |
|---|---|---|
| S3.01 | + | 五种 `sourceKind` 各一条正向用例 |
| S3.02 | + | D1–D4 四条双谓词同真的定序用例（SR20） |
| S3.03 | - | P1 无 candidate / P3 SHA 不可达 / P4 前置无 accepted checkpoint：拒绝而非回退（SR19） |
| S3.04 | + | 换 workspace 不改 selector（SR3） |
| S3.05 | + | 每条结论带 `reason` 与命中序（SR18） |
| S3.06 | - | 输入类型不含 WHERE 字段（SR17） |
| S3.07 | -/+ | 十个错误码各一条正向 + 一条反向用例（SR47） |
| S3.08 | + | 闸门全序：每级拒绝构造使前级通过（SR21 / SR23 / SR24） |

### 12.4 `S4` — runner worktree 与失败关闭（`34D2Ag9O0KnLGxLXifk39`）

| # | 类 | 用例 |
|---|---|---|
| S4.01 | + | workspace 当前在别的分支 / HEAD 落后 / HEAD 超前 / 有 dirty 文件 / `defaultMergeTarget` 改过：仍从 `sourceBaseSha` 建（SR1） |
| S4.02 | - | 六个解析拒绝各一条：engine 未启动、共享目录零写入（SR33） |
| S4.03 | - | `worktree add` 失败 → `WORKTREE_REQUIRED`，**不**降级到 shared（SR33） |
| S4.04 | - | 非 git 仓库的新式任务 → `WORKTREE_REQUIRED`，**不** `git init`（SR33） |
| S4.05 | + | worktree 建成时 `baseSha == sourceBaseSha`（SR14） |
| S4.06 | C | Legacy 三条降级分支 golden 逐字节一致（SR46） |
| S4.07 | + | 规范化函数 Go ↔ TS 对拍（SR36） |

### 12.5 `S5` — CAS、恢复与 ref 移动（`34D2AgBv8ROr1rfvdtZEK`）

| # | 类 | 用例 |
|---|---|---|
| S5.01 | + | §6.4 恢复表十行各一条故障注入用例 |
| S5.02 | + | 同一 session 最终至多一个 `sourceBaseSha`（SR30） |
| S5.03 | + | CAS 输家读已提交快照，不覆盖（SR30） |
| S5.04 | - | SHA 暂时不可达：按权威取回**同一对象**；取不到则失败，不换基线（SR12 / SR41） |
| S5.05 | + | ref 被 force-push 覆盖后，已 `PINNED` 的 session 仍可用（SR42） |
| S5.06 | + | `REFUSED` 终态；重跑生成新 session 与新 `sourceConfigRevision`（SR34） |

### 12.6 `S6` — 依赖 closure（`34D2AgHxulKr87lKaZgYW`）

| # | 类 | 用例 |
|---|---|---|
| S6.01 | + | A→B：B 的基线包含 A 的 accepted 产物 |
| S6.02 | - | A 的 checkpoint 是 `WIP_RED` → 不进 closure，B 拒绝（SR25） |
| S6.03 | - | 多前置未全部落入 integration → `DEPENDENCY_BASE_NOT_LANDED`（SR22） |
| S6.04 | - | 有 `MERGED` receipt 但目标不含该 commit → 仍拒绝（SR26） |
| S6.05 | + | 非代码前置不制造 Git 要求（SR27） |
| S6.06 | + | verification 始终检查其冻结的 candidate（SR20 D2） |
| S6.07 | + | candidate 按 `seq` 最大取，`createdAt` 打平不影响（SR43） |

### 12.7 `S7` — integration 合并（`34D2AgK6sXw5VEbTu70EP`）

| # | 类 | 用例 |
|---|---|---|
| S7.01 | + | `PINNED` session 默认合并目标 = `integrationRef`（SR44） |
| S7.02 | + | 显式改目标只写 `session.mergeTarget`，不回写 codebase（SR44 / SR2） |
| S7.03 | C | Legacy session 仍走 `defaultMergeTarget`（SR44 / SR45） |

### 12.8 `S8` — API / CLI / UI（`34D2AgMRztyeLUaaV9CWM`）

| # | 类 | 用例 |
|---|---|---|
| S8.01 | + | 从 API/CLI/Web/原生任一处可回答"这次运行从哪个 repo/ref/SHA 起步"，字段与 public id 一致 |
| S8.02 | + | selector 与 pin **同时**展示，并说明二者差异来源（SR4） |
| S8.03 | + | 改 `ProjectCodebase` 不改写在飞 session 的展示值（SR29） |
| S8.04 | + | 十个错误码各展示其 `fixAction` 对应的可执行动作（SR49） |

---

## 13. Project 验收标准 → 契约条款 → 用例

| Project AC | 契约条款 | 用例 |
|---|---|---|
| 1. 可显式绑定代码库及 upstream/integration ref、authority、配置 revision；非代码 Project 不被强迫用 Git | §3.1、SR5–SR10、SR31 | S1.03–S1.07, S1.11 |
| 2. Session 持久化 SOURCE 类型/代码库/ref/配置 revision/resolved SHA/解析时间；首次 claim 前冻结，resume/reclaim 不重推导 | §3.2、SR11–SR14、SR28–SR32 | S1.08, S1.09, S2.01, S2.03–S2.05, S5.01 |
| 3. Runner 只从冻结 SHA 建 worktree；不满足则类型化拒绝，绝不降级 | §5、SR21、SR33、§10 | S4.01–S4.05, S3.07, S3.08 |
| 4. 五类基线优先级；只有 accepted checkpoint 能成为下游基线 | §4、SR19–SR27 | S3.01–S3.03, S6.01–S6.07 |
| 5. 默认合入 integration ref，并处理并发推进 | SR44、SR26 | S7.01–S7.03, S6.04 |
| 6. Legacy 兼容，且 `defaultMergeTarget` 不被复用为 SOURCE | SR2、SR45、SR46、SR44 | S4.06, S7.03, S1.01, S1.02, S3.06 |
| 7. API/CLI/UI 能解释来源；覆盖单机、跨 runner、ref 移动、依赖、恢复、失败关闭、兼容的自动化验证 | SR18、SR40–SR42、§12 全表 | S8.01–S8.04, S5.05, S2.06, S4.07 |

---

## 14. 已冻结的取舍

1. **一个 Task 一个主 codebase**。`slot` 列留着，`@@unique([projectId, slot])` 让第二条绑定在数据模型上已经可表达，但 v1 的解析器只读 `'primary'`。多仓库任务的 SOURCE 是一个**集合**，闸门 G5 的包含判定要跨仓库做，那是另一份契约。
2. **解析在 runner 上做，不在 apiserver 上做**。apiserver 没有 checkout，加一个服务端裸镜像会引入一个必须自己维护新鲜度、凭据和磁盘的新组件。代价是多一次往返（§6.3），换来的是 apiserver 不碰 git。
3. **一个 blocker kind，精确码在 payload**（SR50）。代价是 SQL 层看不到细分；换来的是错误码表可以增长而不必每次改 CHECK 约束。
4. **`sourceBaseSha` 与 `session.baseSha` 是两列**（SR13）。代价是两列语义相近容易被"顺手合并"；换来的是一个不可变事实不被一个会自愈的展示值污染。SR14 是这条取舍的守卫。
5. **不定义 freshness 时间窗**（SR39）。代价是每次解析都要 fetch；换来的是"新鲜"这个词只有一个含义。
6. **`REFUSED` 是终态**（SR34）。代价是用户修好配置后要重跑一次；换来的是"selector 在 create 冻结"没有例外条款。

---

## 15. 开放问题（不阻塞阶段 1）

1. **多仓库任务**：一个 Task 需要两个仓库同时在特定版本时，`requiredContains` 与 worktree 布局如何表达。取舍 1 的直接后续。
2. **服务端裸镜像**：若日后引入，`refAuthority` 需要第三个取值 `SERVER_MIRROR`，且 §6.3 的三步握手会塌缩成两步。本契约的分层允许这次替换，因为解析结论的**形状**不变。
3. **`integrationRef` 上的并发推进**：目标 tip 围栏与重新验证规则由 `34D2AgK6sXw5VEbTu70EP` 定义，本契约只固定"默认目标是 `integrationRef`"和"landed 是包含关系"两点（SR44 / SR26）。
4. **`rootCommitSha` 与浅克隆**：浅克隆没有根提交。runner 侧 `cloneRepo` 目前是全克隆（`clone.go:79` 的注释写明了理由），因此 v1 不受影响；若日后支持浅克隆，SR37 的身份判据需要一个替代指纹。

---

## 16. 修订记录（非规范）

- **v1**（2026-08-25）：首版。冻结 SR1–SR53、十个错误码、五级优先级、六级准入闸、四状态机。
