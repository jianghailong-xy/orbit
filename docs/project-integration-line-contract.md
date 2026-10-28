# 项目集成线、例外待办与保险丝契约 v1

**状态**：草案，待 owner 裁决（任务 `34OEE93Dr7CqInQGexkHe`，项目 `34ODoUKJGEsfbgcJDGS4q`）。裁决通过后冻结为 v1。本项目的实现任务按本文实现，不另造表、状态、错误码或事件名；实现需要偏离本文时，先改本文并写修订记录（附录 B），再改代码。

**与既有契约的关系**

- `docs/project-source-contract.md`（下称 **PSC**）：复用 `ProjectCodebase`、`integrationRef`、SR2（`defaultMergeTarget` 不是基线）、SR44（合并不回写代码库）与 P4 / G5（依赖 closure）的语义。§1.5 收窄 P5，并给出不改 source-pin/v1 握手的最小实现。
- `docs/completion-input-routing.md`（下称 **CIR**）：「There is no scheduler, timeout, startup sweep or elapsed-time interpretation in this path」一句改为「对 agent 仍然没有时钟；对人允许超时升级（`docs/project-integration-line-contract.md` §4.6）」。
- `src/apiserver/src/projects/coordinator-wake.ts` §0：时钟「may not CREATE, DECIDE or RESOLVE a wake. It may re-observe, lease and re-deliver an already committed immutable fact」。本文的时钟用途都在这句话之内，唯一新增的是 §4.6 对人的升级。
- `src/apiserver/src/projects/mechanical-disposition.ts` §2（2026-09-06 owner 划的线）：收窄为「进 main 必须经 owner 确认；进项目分支由平台自动完成」（§3.5 M12）；2026-09-23 再划一处例外：项目分支 + Automatic + 检查干净，由平台自行合入 main 并留收据（§3.3 M7、M-T11）。
- `docs/project-done-gate.md`：DONE 投影的输入与重算边沿不变；`landing = 'LANDED'` 的含义收窄为「在 upstream（main）上」（§1.4、§3.5）。
- `docs/project-coordinator-status-contract.md`：`coordination` 增加两个字段（§7.2 V9）。

**引用规范**：沿用 PSC §11 末段，引用写「文件 + 符号」，不写行号。本文不被任何 spec 自检；实现任务在自己的 spec 与评论里引用本文条款号（如 `J7`）。

---

## 0. 总则

### 0.1 分工（硬约束 1）

| 类别 | 例子 | 谁做 | 位置 |
|---|---|---|---|
| 结果确定的步骤 | 集成进集成线、在组合树上跑检查、写回执、派发下游、吸收 main、合入 main 前重检、DONE 投影、升级计时 | 平台：apiserver 记账，runner 执行 git 与检查 | §1–§3、§4.6 |
| 需要判断的例外 | 冲突怎么解、检查为什么红、失败任务重试还是拆分 | 协调会话（例外待办的负责人） | §4 |
| 需要授权的决定 | 合入 main、协调会话的提问、保险丝恢复、blocker 解除、判据提案 | owner 本人，直接看卡片，不经 LLM 转述 | §3、§5、§6 |

**G1**：不存在「平台通知协调会话去执行一个结果确定的步骤」的设计；这类步骤由平台执行（apiserver 记账，runner 跑 git 与检查）。平台的每一次集成尝试都属于一个**落地会话**（§2.9；修订 12 对实现的要求，分期落地）：它是这件事的地址、记录与实时状态，由平台驱动，不启动 engine、不接收轮次、不做决定。一件待办的负责人是会话，当且仅当处理它需要判断；落地会话永远不是负责人。

### 0.2 触发点

**G2（只认已提交事实）**：每个状态转移都写明触发它的已提交事实：哪张表的哪一行在哪个事务里写入或改变。平台动作只有两种形状：与该事实**同一事务**写下（outbox），或在该事务提交之后的边沿上**从已提交行重新推导**（`CompletionInputRouter` 各 door 的形状）。只在提交后边沿执行的动作，必须另有一个事实驱动的补偿点（本文逐处写明），因为进程可能死在提交与边沿之间。

**G3（时钟只有三种用途）**：

1. **对人的超时升级**（§4.6）：本文唯一新增的「时间 → 状态」转移。只写 owner 可见的状态、只发 owner 推送，不产生 agent 唤醒、会话轮次或会话。
2. **已提交事实的认领、续租与重投**：runner 心跳领取已入队的集成作业（§2.2）；v2 领取运行期间每 30 秒内回报并续租（J-T4，修订 12 对实现的要求；今天只在阶段边界回报）；租约过期后可被同一 runner 的另一进程重新认领，持有它、仍在心跳的那个进程则在心跳应答里再收到这条领取（J-T3a，修订 27：同一代，不写行）。它们是 `coordinator-wake.ts` §0 允许的「lease and re-deliver an already committed fact」，产生机器工作与记录这些事实的作业事件，不产生 agent 轮次、engine 或唤醒。落地主体在入队时打开（与作业同一事务），会话行在领取提交后插入（§2.9 LS1）；落地会话只由落地事实结案（LS3）。心跳只补做这些边沿欠下的写，从不因时间到了而打开、改变或结束会话。
3. **显示**：读模型计算「已等多久」「多久后升级」；「静默」「租约已过」只在读时推导，不写行。租约过期给 owner 开待办的唯一例外属于第 1 条（§4.6 X-E5），不改变作业或落地会话。

本文涉及的路径上不新增其他 `setInterval`、定时 sweep 或「超过 N 分钟就……」。已存在的 `TasksService` 60 秒 sweep（`reconcileReadyTasks`）照旧，本文只改它读的依赖谓词（§2.5 J9），不给它加职责。**不给 agent 加任何定时唤醒。**

**G4（投递不计费）**：外部事实（任务状态变化、合并回执、证据修订、owner 答复、例外待办）的记账与投递，不经过任何按次数计费的授权器（§6.6）。

**G5（不加唤醒事件、不加 blocker kind）**：新机制放在新表里。`COORDINATOR_WAKE_EVENTS` 与 `project_blocker_kind_chk` 两个闭集不增加成员：前者每加一个事件要改 8–10 处，而且正是本项目要替换的旧通道；后者被 `project-source-contract.spec.ts`（SR50/SR51）按设计拒绝任何新增。前者有两处例外：`DEPENDENT_READY`（附录 B 修订 3）与 `PROJECT_SETTLED_UNMERGED`（附录 B 修订 4）。

### 0.3 平台发给会话的消息（G6、G7）

**G6（唯一载体）**：平台写进任何会话的消息都走 `SessionsService.createTurn(ownerId, sessionId, { clientTurnId, content, intent: 'NEXT_TURN' }, { participateSendTransaction })`：

- `clientTurnId` 是事实的全函数，前缀属于下表的闭集；`content` 只由不可变的行派生（重放时逐字节比较，见 `createTurn` 的幂等分支）。
- 外部账本（投递行、回复行）的 ACK 在 `participateSendTransaction` 里与轮次同一事务写下；会话已结束（`completed_at` 非空、`INTERRUPTED` 且有 `end_reason`、终态、在 Trash、已请求取消）时在钩子里抛错，轮次不写。
- 不走 `SessionsService.resume`：不复活已结束的会话，也不 steer 正在跑的轮次。
- 排队的平台轮次会被四处排空点丢掉（`turnComplete` 的 failSession 排空、`/finalize`、`ReaperService.forceFinalize`、`SessionsService.transitionEnd`），打断与撤回会整行删除。平台轮次在这些点先被「退回」（§4.4 X-D5），与 `watch-wake-drain.ts` 的 `deadLetterQueuedWatchWakes` 同一形状。
- 修订 12 不改变 `open-item:v1` 的投递文本：投递内容的生成器（`project-open-item.ts` 的 `integrationItemFacts` / `failureClassLines`）不读本修订新增的 payload 字段，重放仍逐字节一致；落地链接只加在待办 payload 的 `landingSessionId` 与服务端决定的 `OPEN_LANDING` 卡片动作中（§4.8）。晋升待办从来没有 `OPEN_TASK_SESSION`（`open-item-doors.ts` 对它只投影 `ASK_COORDINATOR_AGAIN`、`RETRY`、`REVIEW`）；暂时保留的是转录卡上的「Open the failed session ↗」链接（web `OpenItemDeliveryCard.tsx`，OrbitKit `OpenItemDelivery.swift`）与行上的 `sessionId`，客户端都能画 `OPEN_LANDING` 之后再去掉。

| `clientTurnId` 前缀 | 发给谁 | 定义在 |
|---|---|---|
| `open-item:v1:<itemId>:<assignedAtMs>` | 当前协调会话 | §4.4 |
| `owner-answer:v1:<itemId>:<sessionId>` | 当前协调会话 | §5.2 |
| `criteria-decision:v1:<intentId>` | 提案会话 | §5.1 |
| `owner-confirmation-review:v1:<reviewId>` | 确认请求的审查方会话 | `docs/owner-confirmation-review-contract.md` D2 |
| `confirmation-return:v1:<recordId>` | 执行会话（由 Orbit 转交审查方的话） | 同上 B3 |
| `owner-confirmation-answers:v1:<decisionId>` | 确认请求的审查方会话 | 同上 Q5 |
| `evidence-review:v1:<evidenceId>` | 项目外任务的派活会话（它按证据结案） | `docs/task-completion-criteria.md`「Outside a project, the dispatching session settles the evidence」 |

**G7（轮次来源）**：`conversation_turn` 没有来源列。保险丝（§6.1，以保险丝计数任务的定义为准）用「这一轮有没有 `conversation_turn`」来区分：Orbit 投递的轮次都有一行，runner 把该轮的事件记在它名下；engine 自己起的轮次没有，它的 `run_event.type = 'turn_end'` 不挂 `turn_id`。

| 来源 | 判据 | 类别 |
|---|---|---|
| owner 消息、另一会话的 `session_send`、auto-retry 重发 | 有 `conversation_turn`，`clientTurnId` 随机或由客户端给出 | 外部 |
| 平台投递 | 有 `conversation_turn`，`clientTurnId` 为上表前缀（含确认审查的三个与项目外证据的一个）、`coordinator-wake-delivery:v1:` 派生 uuid、`task-comment-mention:`、`system:task-acceptance:v1:` 或 `initial-<sessionId>` | 外部 |
| Watch 投递（匹配与到期）、会话定时唤醒 | 有 `conversation_turn`，`watch:<id>:…` 或定时唤醒的前缀 | 外部（已知边界：agent 自己约定的定时唤醒不计入自发，见附录 A-Q11） |
| engine 自己起的轮次（后台任务通知、ScheduleWakeup、Monitor） | 没有 `conversation_turn`；`run_event.type = 'turn_end'` 且 `turn_id IS NULL` | 自发 |

### 0.4 词汇表

| 术语 | 定义 | 不是什么 |
|---|---|---|
| **集成线** | 代码项目的任务完成后由平台自动落地的 ref：`project_codebase.integration_ref`。两种：`MAIN`（等于 `upstream_ref`）与 `PROJECT_BRANCH`（`refs/heads/project/<name>`） | 不是 `workspace.defaultMergeTarget`（PSC SR2） |
| **upstream / main** | `project_codebase.upstream_ref`。本文说「main」都指它。新绑定默认取这个账号在同一仓库上次选的，没有才 `refs/heads/main`（L6） | 不是 runner 或平台自动探测的分支（L6） |
| **代码任务** | 满足 `isCodeTask`（§1.1）的任务，只由已提交行判定 | 不由标题或描述推断 |
| **集成作业** | `project_integration_job` 的一行：落地会话里的一次尝试（修订 12，§2.9）；`session_id` 是源工作会话，`landing_id` 指所属落地 | 本身不是会话，不启动 engine |
| **落地会话** | `kind='LANDING'`（线上 `sessionKind`）的会话：一个落地主体的地址、记录与实时状态（修订 12，§2.9） | 不能发消息、不接收轮次、不做判断 |
| **落地** | 任务有一条 `result ∈ {MERGED, ALREADY_MERGED}`、目标分支属于某条线的回执，证明这份工作（交付身份，§10.3 O1）在那条线上；回执来自平台合入、Merge 按钮、`merge_receipt` 或观测作业（修订 29，§10.3 O2）。分两级：在集成线上、在 main 上（§1.4） | 不是 DONE（DONE 只说验收通过） |
| **晋升（合入 main）** | 把项目分支（或 `MAIN` 线项目的任务分支）放进 upstream：`project_promotion` 的一行。**每次都要 owner 确认** | 不是集成进项目分支 |
| **例外待办** | `project_open_item` 的一行：有种类、负责人、终态、等待起点、升级时间 | 不是 `project_blocker`（§6.7） |
| **负责人** | `COORDINATOR`（项目当前协调会话）或 `OWNER`（账户所有者本人） | |
| **agent 自主花费** | §6.1 定义的三项计数 | 不含外部事实的投递与记账 |
| **暂停** | `project_fuse_episode` 的一行：自主花费越过上限后，平台挂起协调会话自己发起的动作 | 不是 `COORDINATOR_NO_PROGRESS` |

### 0.5 迁移号

兄弟分支已占用 `0262_background_job_wake`、`0263_watch_revoked_unresolvable_delivery`、`0264_session_scheduled_wakeup`（2026-09-13 扫描全部 worktree 与本地分支）。依赖本契约的任务按依赖顺序预留 `0270`–`0275`；已在运行、不依赖本契约的任务（blocker 解除、提案回复）需要迁移时在 `0265`–`0269` 之间自选唯一号；保险丝计数不需要迁移（§6.1）。编号允许有洞，只要求唯一（`task-judgment-data-preserved.spec.ts` 对 0246 之后的号去重）。

| 号 | 名称 | 负责任务 | 节 |
|---|---|---|---|
| 0270 | `project_integration_line` | 项目 integrationRef | §1.1 |
| 0278 | `project_open_item` | 例外待办 | §4.1 |
| 落地时取下一个空号 | `project_integration_job` | 平台自动集成 | §2.1 |
| 落地时取下一个空号 | `project_promotion` | main 同步与合入 main 状态机 | §3.2 |
| 落地时取下一个空号 | `project_fuse_episode` | 保险丝暂停卡 | §6.3 |
| 落地时取下一个空号 | 预留 | 冲突接入普查 / ask_owner（需要时） | |
| 0265–0269 | `project_blocker_resolution`、`project_criteria_decision_reply` | blocker 解除、提案回复 | §6.7、§5.1 |

**预留号已经作废**：本契约写下后，`0271`–`0277` 被兄弟任务逐个占走，都已在 main 上（watch P3、`drop_project_action`、`drop_workspace_clone_provisioning`、`session_import_source`、`claude_history_import`、`task_list_pause_epoch`、`drop_run_event_duplicate_index`）。例外待办因此落在 `0278`。剩下几张表不再预留具体号：各任务在**落地当时**扫一遍 main 与各分支，取下一个没人用的号，并把它登记进 `task-judgment-data-preserved.spec.ts` 的迁移账本（不登记那条 spec 恒红）。

跨表外键由后建的一方补：`project_integration_job` 的迁移给 `project_open_item.integration_job_id` 加外键，`project_promotion` 的迁移给 `project_open_item.promotion_id` 与 `project_integration_job.promotion_id` 加外键，`project_fuse_episode` 的迁移给 `project_open_item.fuse_episode_id` 加外键。

### 0.6 条款编号

每节一个前缀：G 总则、L 集成线、J 集成作业、M 合入 main、X 例外待办、R 回复、F 保险丝、B blocker、V 读模型、C 兼容；修订 29 加 O 落地观测（§10）。

### 0.7 各节要素索引

| 节 | 数据结构 | 状态转移 | 触发它的已提交事实 | 读模型 | 测试 |
|---|---|---|---|---|---|
| 1 集成线 | §1.1 | §1.3 | §1.2 L3、L5；§1.3 | §1.6 | §1.7 |
| 2 集成作业 | §2.1 | §2.2 | §2.3 | §2.7 | §2.8 |
| 3 main 同步与合入 main | §3.2 | §3.3 | §3.4 | §3.6 | §3.7 |
| 4 例外待办 | §4.1 | §4.2（终态）、§4.4 X-D5、§4.5、§4.6 | §4.2、§4.3、§4.4 X-D4 | §4.8 | §4.9 |
| 5 阻塞请求的回复 | §5.1、§5.2 | §5.3 | §5.1 R1、§5.2 R9–R11、§5.3 | §5.1 R6、§7.5 | §5.4 |
| 6 保险丝与 blocker | §6.1 F1（计量的已提交行）、§6.2、§6.7 B1 | §6.3、§6.7 B3–B4 | §6.1 F5、§6.3 | §6.7 B2、§7.2 V7 | §6.8 |
| 7 读模型 | §7.1–§7.6 各字段表 | §7.0 V0 | §7.0 V0 | 本节 | §7.7 |
| 8 迁移与兼容 | §8.1 | §8.7 | §8.7 | — | §8.8 |
| 9 任务对照 | §9.1、§9.4 | §9.4 | §9.4 | — | §9.1「测试」列、§9.2 |
| 10 落地观测与交付方式（修订 29） | §10.4 | §10.6 O-J1–O-J4 | §10.6 O-T1–O-T5 | §10.9 | §10.9 |

---

## 1. 集成线

### 1.1 数据结构

**`project_codebase`**（0231 已建，零行，没有生产写入方）复用全部列。迁移 0270 新增：

| 列 | 类型 | 约束与语义 |
|---|---|---|
| `integration_ref_source` | text NOT NULL DEFAULT `'DEFAULT_RULE'` | CHECK ∈ {`EXPLICIT`, `DEFAULT_RULE`}：谁定的集成线 |
| `integration_started_at` | timestamptz NULL | 本项目第一条集成作业入队的同一事务写入（L3）；非空即锁定（L4） |
| `merge_check_command` | text NULL | 项目级合并检查命令，在组合树上执行（J-S5、M-S3）；NULL 表示没有 |
| `merge_check_timeout_seconds` | int NULL | CHECK > 0；NULL = 3600，与任务验收命令的默认预算相同 |

迁移 0422 再加一列和一个索引（L6）：

| 列 / 索引 | 类型 | 约束与语义 |
|---|---|---|
| `upstream_ref_chosen_at` | timestamptz(3) NULL | 账号所有者写 `upstreamRef` 的时刻（L6）。NULL：这个项目自己没选过——还是默认值，或是新绑定从记忆里带过来的值 |
| `project_codebase_upstream_choice_idx` | `(owner_id, canonical_repo_url, upstream_ref_chosen_at DESC) WHERE upstream_ref_chosen_at IS NOT NULL` | 新绑定读「这个账号在同一仓库上次选的」用的范围；schema.prisma 里写成普通索引（部分谓词写不出来，同 `authority_runner_id` 那条） |

0270 的锁定触发器与 0231 的 `project_codebase_config_guard` 都不点这一列：锁定后照样能记一次选择，记它也不算配置变化，不动 `config_revision`。

修订 29 再加两列（§10.4，迁移落地时取下一个空号）：`delivery_mode`（交付方式，CHECK ∈ {`PLATFORM`, `AGENT_PUSH`}，默认 `PLATFORM`；`AGENT_PUSH` 只在 `MAIN` 线上）与 `delivery_mode_chosen_at`（owner 写 `deliveryMode` 的时刻，NULL = 从没选过）。只有 owner 能写（§10.5 O-L1）；两列都不进 0270 的锁定触发器，开始集成之后照样能换，只影响之后写下的 DONE。

迁移 0270 新增触发器 `project_codebase_integration_lock`（BEFORE UPDATE）：`OLD.integration_started_at IS NOT NULL` 时，拒绝改动 `integration_ref`、`upstream_ref`、`canonical_repo_url`、`ref_authority`、`remote_name`、`authority_runner_id`，也拒绝把 `integration_started_at` 改回 NULL；错误信息以 `INTEGRATION_LINE_LOCKED` 开头。沿用 0231 的约束：ref 必须是 `refs/` 全名（SR9）；不得新增 `work_dir` / `workspace_id` / `default_merge_target` / `enable_worktree`（SR10，`project-codebase-schema.pg.spec.ts` 断言它们缺席）。

派生值（不存列）：

- `IntegrationLine` = `integration_ref = upstream_ref` ? `MAIN` : `PROJECT_BRANCH`。
- 分支短名 = 全名去掉 `refs/heads/`，与 `session_merge_receipt.target_branch` 的写法一致（runner 回报短名）。

**`isCodeTask(task)`**：`task.project_id` 非空 ∧ `task.codeless = false` ∧ 该任务最近一条工作会话（`starts_task_work = true`、`deleted_at IS NULL`、按 `created_at` 取最新）的 `isolation_status = 'worktree'` 且 `branch` 非空，且（修订 29，§10.5 O-L7）这条会话所在 workspace 的 `repo_url` 经 PSC SR36 规范化后等于项目代码库的 `canonical_repo_url`。不等的不是本线的代码任务：J9 豁免，不冻结交付身份，不观测。

**`lineStarted(project)`**：该项目 `slot = 'primary'` 的代码库行存在且 `integration_started_at` 非空。

### 1.2 规则

**L1（显式优先）**：owner 在集成设置里选过（`integration_ref_source = EXPLICIT`）就用那条，平台不改写。

**L2（默认规则，纯函数）** `defaultIntegrationLine(codeTasks, edges): IntegrationLine`：

- 输入：项目内 `codeless = false`、`status <> 'CANCELLED'` 的任务集合 T，以及 `task_dependency` 中两端都在 T 内的边集合 E。
- E 非空 → `PROJECT_BRANCH`；否则 → `MAIN`。
- 不读标题、描述或别的列。「紧急修复」是 owner 的显式选择（L1），不是推断。

**L3（何时求值、如何记录）**：默认规则**只求值一次**，在插入本项目第一条集成作业的事务里（§2.3 J-T1a）：

1. `INSERT INTO project_codebase … ON CONFLICT (project_id, slot) DO NOTHING`，再 `SELECT … FOR UPDATE` 取回这一行。串行化靠代码库行锁，不锁 `project` 行。锁序：`task` → `project_codebase` → `project_integration_job` → `project_open_item`，写进 `src/apiserver/src/common/lock-order.ts`。
2. 新插入的行取值：
   - `canonical_repo_url`：该任务工作会话所在 workspace 的 `repo_url`，经 PSC SR36 的规范化函数处理。为 NULL 时不插入代码库行、不入队作业，改为生成 `INTEGRATION_ERROR` 待办（`error_code = INTEGRATION_REPOSITORY_UNKNOWN`，§4.2）。
   - `upstream_ref`：这个账号在同一仓库上次选的（L6 的记忆），没有才 `'refs/heads/main'`；`upstream_ref_chosen_at` 为 NULL。
   - `integration_ref`：`MAIN` → 等于 `upstream_ref`；`PROJECT_BRANCH` → `refs/heads/project/<projectPublicId>`（附录 A-Q1）。
   - `ref_authority = 'REMOTE'`，`remote_name = 'origin'`（附录 A-Q2）。
   - `integration_ref_source = 'DEFAULT_RULE'`。
3. `UPDATE … SET integration_started_at = now() WHERE integration_started_at IS NULL`。已有 `EXPLICIT` 行时只做这一步。
4. 线从这一刻开始：同一事务为本项目**其他**已 DONE、`isCodeTask` 为真、在**新线上且在该线的 `upstream_ref` 上**都没有落地证据的任务补入队 `LAND_TASK`（§2.3 J-T1d），否则它们的下游会永远等在 J9 上。上游那一半是 `PROJECT_BRANCH` 的定义使然：J-S2 MAIN_SYNC 会把上游并进目标分支，所以上游已有的内容按定义就在项目分支上，再为它排一次落地只会撞成冲突（本平台自己的合入是 rebase，J-S3 的祖先判定看不见它）。

**L4（锁定）**：`integration_started_at` 非空之后，`integration_ref` 与 `upstream_ref` 不可改。服务层拒绝 409 `INTEGRATION_LINE_LOCKED`，数据库触发器兜底。`merge_check_command`、`merge_check_timeout_seconds`、`project.exception_escalation_seconds` 不锁。要换线，先合入 main 或放弃当前项目分支（owner 决定 5）；v1 不提供解锁入口（附录 A-Q3）。

**L5（显式设置的写入门）**：`GET / PATCH /projects/:id/integration`。PATCH 只接受 owner 凭据；带 acting session 的请求（任何 agent 会话，包括协调会话）一律拒绝 403 `INTEGRATION_SETTINGS_OWNER_ONLY`。

**L5-b（合并检查的确认卡，2026-10-07）**：`PATCH /projects/:id`（以及 runner 门 `PATCH /runner/projects/:id`）上的 `integration` 按字段拆分。线字段（`line` / `projectBranchName` / `upstreamRef`）与 L5 一样，带 acting session 即 403，卡也不能改变这一点；`mergeCheckCommand` / `mergeCheckTimeoutSeconds` 则可以由会话写入，前提是服务端找到一张**本会话、对本项目、且 input 里的提议与本次逐字相同**的 ALLOWED 卡（`decided_by_id` 非空——由工作区常设规则自动放行的卡不算，那不是人点的），并把该卡记入本次写入的 provenance（`activity`，type `project.merge_check.changed`）。找不到卡 / 被拒 / 内容不符 → 仍是那条 403，且守卫在事务之前，什么都不写。写入门仍是 `PATCH /projects/:id/integration`：它不带会话，不涉及卡。见 `projects/project-integration-approval.ts`。

```ts
interface UpdateProjectIntegrationDto {
  line?: 'MAIN' | 'PROJECT_BRANCH';
  projectBranchName?: string;        // 全名 refs/heads/…；缺省 refs/heads/project/<projectPublicId>
  upstreamRef?: string;              // 全名；锁定后拒绝
  mergeCheckCommand?: string | null;
  mergeCheckTimeoutSeconds?: number | null;
  exceptionEscalationSeconds?: number;   // 写 project 列（§4.1）
}
```

没有代码库行时创建：`canonical_repo_url` 取项目协调工作区的 `repo_url`，缺失则 409 `INTEGRATION_REPOSITORY_UNKNOWN`；`upstream_ref` 与 `integration_ref` 先取 L6 的记忆，没有才 `refs/heads/main`，再按本次设置改写。写 `project.exception_escalation_seconds` 的方法里不得出现 `status:` 键（`project-status-write-sites.spec.ts` 按「同一方法内有 `.project.update` 且有 `status:`」认写入方）。

`workspace.repo_url` 可手动填写，也由 runner 的目录探测自动补空：读取工作目录的 `origin`，去掉 URL 中的凭据后随下一次心跳上报；服务端仅在 workspace 的 runner、原始 `workDir` 仍匹配且 `repo_url` 为 NULL 或空字符串时回填。新建和既有工作区都走这条路径；旧 runner 未上报、目录不存在或没有 origin 时不写，不覆盖已有地址，也不改变已建立的项目代码库绑定。检测是异步的，尚无地址时应提示等待 runner 检测或在工作区设置填写 Repository URL。

**L6（upstream 记住上次的选择，不探测）**：upstream 默认取这个账号在同一仓库上次选的；没有才 `refs/heads/main`；平台仍不去仓库里探测。apiserver 没有仓库可问，记住的是 owner 说过的，不是平台猜的。owner 可在锁定前改（L4）。

- **记录**：账号所有者每次写 `upstreamRef`，同一条 UPDATE 里把 `upstream_ref_chosen_at` 写成 `now()`。这些门都经过 `configureProjectIntegration`：开始门 `POST /projects/:id/start`（经 `startProjectLine`，仅在线未锁定时）、`PATCH /projects/:id/integration`、`PATCH /projects/:id` 与 `POST /projects` 的 `integration`、CLI `orbit project update --upstream-ref`（终端里，不带会话）。写的值与原值相同也记：这是 owner 又说了一次。带 acting session 的请求照旧 403（L5、L5-b），什么都不记。
- **记忆的读法**：同 `owner_id`、同 `canonical_repo_url`、`upstream_ref_chosen_at` 非空的行里最新那行（同一毫秒按 `id`）的 `upstream_ref`（`rememberedUpstreamRef`，走 `project_codebase_upstream_choice_idx`）。仓库按 PSC SR36 规范化后比较，同一仓库的不同写法算同一个；别的账号、别的仓库的选择互不影响。
- **新绑定**：`bind()` 新建的行，`upstream_ref` 与 `integration_ref` 都先取记忆，没有才 `refs/heads/main`；新行的 `upstream_ref_chosen_at` 为 NULL（它带的是记忆，不是这个项目自己的选择）。三个入口都走它：开始门、`PATCH …/integration`（及项目更新的 `integration`）的首次绑定、没经过开始卡片的项目的第一次集成（L3）。已有的绑定不随记忆改变。
- **开始门**：`POST /projects/:id/start` 收可选 `upstreamRef`（全名，与 `UpdateProjectIntegrationDto` 同一条 `refs/heads/` 校验，`CODEBASE_AUTHORITY_INVALID`）。线未锁定时连同线一起写入并记时间；已锁定时照旧只写合并检查，不写 upstream、不记时间，`differsFromRequest` 记 `line`。没有仓库的项目带它 → 409 `INTEGRATION_REPOSITORY_UNKNOWN`，与项目分支、合并检查同一条。`started_with.settings.upstreamRef`：开始门或它回答的开始请求带了 `upstreamRef` 时，记开始之后项目所在的 upstream（全名）；都没带时不记。
- **开始请求**：`project_request_start`（`POST /runner/projects/:id/start-requests`）收可选 `upstreamRef`，原样存进 `START_REQUEST` 的 `settings`。它只是建议，不写代码库行、不记时间。没有仓库时带它 → `START_REPOSITORY_UNKNOWN`。协调者在 `project_get` 的 `integration.lastMainBranch` 有值时不填；没有时在仓库里读 `git symbolic-ref --short refs/remotes/origin/HEAD` 填。
- **开始卡片的初始值**，取第一个有的：这个项目自己已选的（`upstreamChosenAt` 非空时的 `upstreamRef`）→ 同仓库上次选的（`lastMainBranch`）→ 协调者建议的（开始请求的 `settings.upstreamRef`）→ `main`。
- runner 在作业里发现 upstream 不存在时，作业以 `ERROR / BASE_REF_NOT_FOUND` 结束并生成待办（§2.6），**不回退到 master**：产品与仓库无关（owner 决定 3），猜分支名就是在为仓库约定做特判。

**L7（平台合并不回写）**：集成作业（§2）与晋升（§3）不读、不写 `workspace.default_merge_target`。它的写入方保持现状：`SessionsService.mergeToMain` 在用户显式选目标时回写，另有 workspace 创建与更新、runner agent 路由、`clone-result`。

### 1.3 状态转移

| # | from | 已提交事实 | to | 写入方 |
|---|---|---|---|---|
| L-T1 | 无行 | owner 的集成设置写入提交 | `DECIDED / EXPLICIT` | `ProjectIntegrationLineService.configure` |
| L-T2 | `DECIDED / EXPLICIT`（未锁） | 同上 | `DECIDED / EXPLICIT` | 同上 |
| L-T3 | 无行 | 本项目第一条 `project_integration_job` 的 INSERT（同一事务） | `STARTED / DEFAULT_RULE` | `ProjectIntegrationLineService.startOnFirstIntegration(tx, …)` |
| L-T4 | `DECIDED / EXPLICIT` | 同上 | `STARTED / EXPLICIT` | 同上 |
| L-T5 | `STARTED / *` | 改线请求 | 不变，409 `INTEGRATION_LINE_LOCKED` | 服务层 + `project_codebase_integration_lock` |

### 1.4 「已落地」判定（替换 `DEFAULT_BRANCH_NAMES`）

`src/apiserver/src/projects/project-criterion-landing.ts` 删除常量 `DEFAULT_BRANCH_NAMES`，改为按项目的代码库行给出分支：

```ts
export interface LandingBranches { upstream: readonly string[]; integration: readonly string[] }

/** 只服务于没有代码库行的项目（C1）。全树唯一允许出现 main/master 字面量的地方。 */
export const LEGACY_LANDING_BRANCHES: LandingBranches = {
  upstream: ['main', 'master'], integration: ['main', 'master'],
};

export function landingBranchesFor(
  codebase: { upstreamRef: string; integrationRef: string } | null,
): LandingBranches;   // 有行：各取短名，一项一个；无行：LEGACY_LANDING_BRANCHES

export type TaskLanding = 'ON_UPSTREAM' | 'ON_INTEGRATION_LINE' | 'NOT_KNOWN';
export function taskLanding(receipts: ReadonlyArray<LandingReceiptFacts>, branches: LandingBranches): TaskLanding;

export type CriterionLanding = 'LANDED' | 'ON_INTEGRATION_LINE' | 'UNKNOWN';
export function receiptIsLandingEvidence(receipt: LandingReceiptFacts, branches: LandingBranches): boolean;
```

- 任务级：有一条 `result ∈ {MERGED, ALREADY_MERGED}` 且 `target_branch ∈ upstream` 的回执 → `ON_UPSTREAM`；否则有同样结果且 `target_branch ∈ integration` 的回执 → `ON_INTEGRATION_LINE`；其余 → `NOT_KNOWN`。仍然没有 `NOT_LANDED`，沿用该文件「三值」一节的理由。修订 29 不改这条判定，仍只读回执；回执说的是「这份工作在这条线上」，可以来自观测：观测作业看到交付身份的提交在线上时写的回执带 `detail.observed = true`（§10.3 O2、§10.6 O-R1），与平台合入、Merge 按钮、`merge_receipt` 写的回执同样计入。
- 判据级：服务任务非空且所有**有提交可落**的服务任务全部 `ON_UPSTREAM` → `LANDED`；服务任务非空、所有有提交可落的服务任务都是 `ON_UPSTREAM` 或 `ON_INTEGRATION_LINE`、且至少一个不是 `ON_UPSTREAM` → `ON_INTEGRATION_LINE`；其余 → `UNKNOWN`。`MAIN` 线项目不会出现 `ON_INTEGRATION_LINE`。
- 「有提交可落」= `task.codeless = false`（§1.1 `isCodeTask` 的前半）。一条声明自己不需要代码的任务（SR5 的逃生口：调研、文档、以证据为交付的验收任务）不解析 SOURCE，因此没有自己的分支、没有自己的提交，也不可能有任何回执把它的工作放到 `main` 上——它不参与这条合取，既不挡 `LANDED` 也不提供 `LANDED`。这与 §2.5 J9 对依赖的豁免是同一条规则（SR27：文档类前置不该让下游等一个永远不会存在的检查点），也让 `ProjectIntegrationBuckets.doneNotIntegrated`（「DONE work with nothing to land」）与 `NOT_APPLICABLE` 的口径在判据这一层成立。**注意这不是给验收类任务开绕过落地判定的口子**：跑过分支的任务就是有自己的提交（无论它的回执或标题怎么说），仍然按原样顶住 `LANDED`；只读声明，不读会话史（`isCodeTask` 的后半读的是**最新**一条会话，而回执挂在**任务**上，用它会漏掉「上一次落地、这一次没分叉」的任务）。
- 只有 codeless 的服务任务、但确实有服务任务时，判据读 `LANDED`（零个提交全部在 upstream 上，即 J9 的「没有可等的」）；**没有人**服务时仍读 `UNKNOWN`。
- 声明 codeless 的门（0346）：`task_create`、`task_create_batch` 的每一项、`task_update`（MCP、CLI、runner API 同一个 DTO）。建任务时声明不需要理由；给已有任务声明必须带 `codelessReason`（存进 `task.codeless_reason`，撤回声明时清掉），且已经有自己提交的任务一律拒绝（`TASK_CODELESS_HAS_COMMITS`：有让目标移动过的 `MERGED` 回执，或有工作会话报告过改动）。
- 线的 `NOTHING_TO_LAND` 也可以让任务退出合取，但**只凭 runner 的实测**（0346）：作业行的 `source_on_upstream = true`（空分支的 tip 是 upstream 的祖先），且该作业在任务结束工作之后、对它最后所在的分支作答（`jobSawTheFinishedBranch`），且写下了回执（只有任务在任何地方都没有会话报告过工作时才写，J8）。不按状态放行：会话死掉、成果在别的分支上的任务同样会被判 `NOTHING_TO_LAND`；没测（旧行、旧 runner）或测出不在 upstream 上的，一律仍挡 `LANDED`。此前这一豁免只在 `target_sha_before = upstream_sha` 且没做 main 同步时成立，项目分支一旦领先 main 就永远不成立（2026-10-01，项目 `34WzvgkHWbY1VwXmSPUZi` 的上线任务）。
- 另一种 `NOTHING_TO_LAND` 是**全部已应用**（0410）：分支带着自己的提交，rebase 时 base 已经全部有了（`source_fully_applied = true`，J-S4），什么都没推。这时 base 里有的是这些提交的改动，不是这些提交本身，所以 tip 通常不在 upstream 上（`source_on_upstream` 照常实测）。只有当 base 就是 upstream 时（没做 main 同步、`target_sha_before = upstream_sha`；2026-10-09 项目 `34PBlWiEZytRLTcPufJht` 的线从 main tip 重建）它才同样让任务退出合取（`jobSawWorkOnUpstream`），并且仍要求另外两条（`jobSawTheFinishedBranch`、写下了回执）。线领先 main 或做了 main 同步时，它写的回执指向线，任务读 `ON_INTEGRATION_LINE`。没测或测出空分支（`false`）的，照旧。
- 零提交的验收任务挡死判据落地判定，是 2026-09-22 在项目 `34ODoUKJGEsfbgcJDGS4q` 实测到的洞：48 条任务全部 DONE、13/14 条判据 `LANDED`，第 12 条被判据名下那条零提交的验收任务钉在 `ON_INTEGRATION_LINE`，项目到不了 DONE。修复只改读数（`project-criterion-landing.ts` 的 `criterionLanding`/`taskHasNothingToLand`），不改判据措辞。
- `readCriterionLanding` 多读一次代码库行，`ProjectsService.get` 的语句数随之 17 → 18（`project-get-query-count.pg.spec.ts`）。

**L8（两个问题两个读数）**：「前置已落地」（§2.5 J9）用任务级 `ON_UPSTREAM ∨ ON_INTEGRATION_LINE`；项目 DONE（§3.5）用判据级 `LANDED`。`LANDED` 收窄为「在 main 上」，所以 `project-done-derived.ts` 不改一行就满足「项目 DONE 以合入 main 为准」。

**L9（旧读者跟着改）**：`wake-disposition.service.ts` 的 `state()` 与 `deliveriesUnder`（冲突回执判断）改用项目自己的 `LandingBranches`。`criterion-unlanded.producer.ts` 与 `project-tasks-settled.producer.ts` 读判据级值，行为见 C3。`project_get` 的 `acceptanceCriteriaItems[].landing` 多一个值 `ON_INTEGRATION_LINE`；客户端文案见 §7.4。

### 1.5 worktree 基线（PSC 的最小版本）

**L10**：代码任务的工作会话从集成线的当前 tip 分叉；前置没落地到集成线就拒绝开工，不回退到 workDir HEAD。沿用现有的 `decideSessionSource`（`session-source.ts`）→ `resolveSource`（`source-selector.ts`）→ runner `ensureSourcePinned` → `POST /runner/sessions/:id/source/pin` 链路，只改三处：

| 处 | 现状 | 改为 |
|---|---|---|
| `resolveSource` P5（`PROJECT_UPSTREAM`） | 基线 ref 取 `upstream_ref` | 本项目在集成线上已有落地回执 → 取 `integration_ref`；否则取 `upstream_ref`（项目分支还没被创建，内容等价） |
| `resolveSource` P4（`DEPENDENCY_CLOSURE`） | 输入写死为空；`assertCheckpointInputsAvailable` 对有前置的任务答 503 | `requiredContains` = 每个代码前置在集成线上的落地提交：`MERGED` 回执取 `target_sha_after`，`ALREADY_MERGED` 取 `source_sha`。本线晋升进 upstream 的回执（源分支是集成分支）也取 `source_sha`：它就是该任务在集成线上的落地提交；而它的 `target_sha_after` 是 upstream 上的合并提交，集成线要等下一次 MAIN_SYNC 才包含它。有前置的任务不再 503（`verifiesTaskId` 的 503 不变） |
| runner `setupWorktree`（`worktree.go`） | 忽略 `job.Source.BaseSha`，从 workDir HEAD 分叉 | `sourceState = PINNED` 时从 `Source.BaseSha` 分叉；`worktree add` 之前对每个 `requiredContains` 执行 `git merge-base --is-ancestor <sha> <base>`，不包含 → 拒绝 `DEPENDENCY_BASE_NOT_LANDED`；`worktree add` 失败 → `WORKTREE_REQUIRED`。两者都不落到 `shared`（PSC SR33） |

`UNBOUND` 会话（项目无代码库行、`codeless`、非项目任务）走原路径，逐字节不变（PSC SR45 / SR46）。项目第一批任务开工时通常还没有代码库行，走的也是原路径。

### 1.6 读模型

`GET /projects/:id/integration` → `ProjectIntegrationView`（类型放 `src/shared/src/project-progress.ts`，§7.0）：

| 字段 | 类型 | 来源 | 缺席原因 |
|---|---|---|---|
| `line` | `'MAIN' \| 'PROJECT_BRANCH'` | 代码库行 | `NOT_DECIDED` |
| `ref` / `upstreamRef` | string | 两个 ref 的短名 | `NOT_DECIDED` |
| `upstreamChosenAt` | Date | `upstream_ref_chosen_at`（L6） | null：这个项目自己没选过（默认值，或新绑定带过来的记忆），或没有代码库行 |
| `lastMainBranch` | `{ branch, repository, chosenAt }` | L6 的记忆：这个账号在本项目仓库上次选的主分支；`branch`、`repository` 都是短名 | null：这个账号在该仓库没选过，或项目没有仓库 |
| `repository` | string | 项目仓库的短名：规范化 URL 的最后两段（如 `acme/payments-api`）；有代码库行取它的，没有时取协调工作区 `repo_url` 规范化后的 | null：两者都没有，此时没有主分支可选（客户端不显示 Main branch 一行） |
| `branches` | `{ names, workspaceName, reportedAt }` | 主分支下拉的候选：协调工作区里最新创建的、上报过 `session.merge_targets` 的会话的那份（runner 报的本地分支），去掉 `orbit/*`，也去掉本账号项目的集成分支——同一 owner 的 `project_codebase` 行里，集成线是项目分支（`integration_ref` 与 `upstream_ref` 不同）的那些 `integration_ref` 的短名。落地会把项目分支留在协调工作区的检出里，而它不会是任何项目的主分支。线是 MAIN 的项目，`integration_ref` 就是主分支本身，照常列出；名字只是以 `project/` 开头的用户分支、别的账号的项目分支也照常列出。在服务端去掉：runner 报的 `merge_targets` 不变，会话的 Merge 菜单也读它。`workspaceName` 是协调工作区名，`reportedAt` 是那个会话行最后一次写入的时间（runner 每次心跳和收尾都重报）。按创建时间取，读 `(workspace_id, created_at DESC)` 索引、遇到第一条有上报的就停：这条读口 30 秒轮询一次，协调工作区可以有上千个会话，报的是同一个仓库；本账号的项目分支在同一条语句里经 `project_codebase_owner_idx` 读一次，不逐个名字查 | null：没有会话上报过分支，去掉之后一个不剩，或没有协调工作区 |
| `source` | `'EXPLICIT' \| 'DEFAULT_RULE'` | `integration_ref_source` | `NOT_DECIDED` |
| `locked` / `startedAt` | bool / Date | `integration_started_at` | — |
| `mergeCheckCommand` / `mergeCheckTimeoutSeconds` | string / number | 代码库行 | `NOT_CONFIGURED` |
| `escalationSeconds` | number | `project.exception_escalation_seconds` | — |
| `commitsAheadOfUpstream` | number | 最近一条终态 `LAND_TASK` 的 `ahead_of_upstream` | `NO_LANDING_YET` |
| `lastUpstreamSyncAt` | Date | 最近一条 `main_sync_sha` 非空的 `LANDED` 作业的 `finished_at` | `NEVER_SYNCED` |
| `integratingCount` / `queuedCount` | number | 本项目 `RUNNING` / `QUEUED` 作业数 | — |
| `inFlightJobs` | `ProjectIntegrationJob[]` | 两个计数数到的每个作业，顺序同 `inFlight`（先运行中，再按领取或入队时刻、`id`），首条就是 `inFlight` 描述的那个；带任务、代数、runner 名、谁要求的重跑，以及读时判定的超时（`timedOut` / `limitSeconds`，见 J-T9）。**要求**（修订 12，新字段一律可选）：每一项还带 §7.2 给 `inFlight` 加的那些可选字段——`landingSessionId`、`promotionId`、`round`、`check{name,index,count,budgetSeconds,startedAt}`、`outputMovedAt`、`progressProtocol`、`typicalMs`；本修订原先提的 `landings[]` 由它取代，落地行动态行与项目的 Landings 窗口（§2.9 LS6，修订 28）都读它；`timedOut` / `limitSeconds` 按 §7.2 V6 的唯一定义算，不另立规则 | 旧服务端不带 |
| `mergeCheckOnTip` | `'PASSING' \| 'FAILING' \| 'UNKNOWN'` | 最近一条终态 `LAND_TASK`：`LANDED` / `ALREADY_LANDED` → PASSING；`CHECK_FAILED` → FAILING；其余（含 `NOTHING_TO_LAND`——没有可检的树）→ UNKNOWN | — |

项目列表行带 `integration: { line, ref } | null`（§7.1）。项目文档（`project_get`）的 `integration` 是上表的设置一半，另带 `upstreamChosenAt` 与 `lastMainBranch`：协调者靠 `lastMainBranch` 判断开始请求要不要建议主分支（L6）。它们多花项目文档一条语句（`readMainBranchMemory`，按项目一条），`repository` 与 `branches` 只在本接口。

### 1.7 测试

`src/apiserver/src/projects/project-integration-ref.pg.spec.ts`（判据 4）：

1. `explicit integration settings read back`
2. `with no explicit choice, dependent code tasks record a project branch at the first integration`
3. `with no explicit choice, a single code task records main at the first integration`
4. `switching the line after integration started is refused INTEGRATION_LINE_LOCKED`（服务层与触发器各断言一次）
5. `a receipt into the project branch makes its serving task landed`（改动前在 main 上跑红：`DEFAULT_BRANCH_NAMES` 读成 UNKNOWN）
6. `platform-initiated merges leave workspace.defaultMergeTarget unchanged`

`src/apiserver/src/projects/project-main-branch.pg.spec.ts`（L6）：开始门写入并记时间；同账号同仓库的下一个项目按上次选的绑定（PATCH 与不带主分支的开始门），更新的选择覆盖旧的；别的仓库、别的账号互不影响；没经过开始卡片的项目第一次集成也取记忆；线开始后另一个主分支 409、什么都不记；agent 会话 403，终端 CLI 记录；`GET /projects/:id/integration` 的四个新字段与项目文档的 `lastMainBranch`；开始请求保存 `upstreamRef`。

另：`project-criterion-landing.ts` 的纯函数补 `ON_INTEGRATION_LINE` 与 Legacy 两例（放同目录的 `project-criterion-landing.spec.ts`）。runner：`TestWorktreeForksFromIntegrationRefTip`（判据 5，`src/runner-go/worktree_test.go`；真实 git 仓库，main 与项目分支 tip 不同，断言基线 = 项目分支 tip 而非 workDir HEAD），外加 `TestWorktreeRefusesUnlandedRequiredContains`。

---

## 2. 集成作业

### 2.1 数据结构

**`project_integration_job`**（迁移 0272）：

| 列 | 类型 | 约束与语义 |
|---|---|---|
| `id` | uuid(7) PK | |
| `project_id` / `owner_id` | uuid | FK `project` CASCADE；租户域 |
| `codebase_id` | uuid NOT NULL | FK `project_codebase` |
| `kind` | text | CHECK ∈ {`LAND_TASK`, `CHECK_PROMOTION`, `LAND_PROMOTION`}；修订 29 加 `OBSERVE_LANDING`（只读的落地观测，§10.6）：它不带 `task_id`、`session_id`、`promotion_id`、`landing_id`，`target_ref` 与 `source_ref` 都写 `integration_ref`，`generation` 与幂等键按项目取（§10.4） |
| `generation` | int NOT NULL | `LAND_TASK`：同一任务的第几条（在任务行锁下取 max+1）；另两种：同一晋升的第几条 |
| `task_id` | uuid NULL | `LAND_TASK` 必填（`project_integration_job_land_task_chk`）；晋升作业（`CHECK_PROMOTION` / `LAND_PROMOTION`）不带（0293），晋升的任务记在 `project_promotion` 行上。现状（0423 起，2026-10-14）是**不带外键的历史引用**（同 0344:7-10），修订 12 对实现的要求的这一半已落实，删任务不再改写作业行、作业行仍指名那个任务；0423 之前是 FK `task` ON DELETE SET NULL（0281），理由见下方 `session_id` 一行 |
| `session_id` | uuid NULL | 源分支所在的工作会话（线上别名 `sourceSessionId`）。现状（0424 起，2026-10-14）是**不带外键的历史引用**，修订 12 对实现的要求连同 `task_id`（0423）已全部落实：删会话、回收 Trash 不再改写作业行，作业行仍指名那个会话；读它的地方按 id 查回会话，查不到就当作外键原来写的 NULL（回执的 `session_merge_receipt.session_id` 是外键，所以只写给还在的会话）。0424 之前是 FK `session` ON DELETE SET NULL（0281）。理由：外键的置空是一次 UPDATE，终态行被 J4 守卫拒绝；`LAND_TASK` 行的 `task_id` 置空还违反 `land_task_chk`（0281:117-119），任何一代 `LAND_TASK` 都会挡住删任务——删会话、回收 Trash、删任务因此整批回滚，「让守卫放行」的办法不可行（`docs/landing-session-design.md` §9 第 2 条、§0.1 第 18 条） |
| `landing_id` | uuid NULL | 修订 12 新增（要求）；所属 `project_landing` 的历史引用，不加外键，只在 INSERT 时写。`session_id` 仍是源工作会话，不改路由、base_sha、领取守卫与回执的含义 |
| `promotion_id` | uuid NULL | FK `project_promotion`（0273 补外键） |
| `serial_key` | text NOT NULL | 串行键，见 J1 |
| `target_ref` / `upstream_ref` / `source_ref` | text NOT NULL | 全名；`upstream_ref` 入队时从代码库行冻结 |
| `state` | text | CHECK ∈ {`QUEUED`, `RUNNING`, `LANDED`, `ALREADY_LANDED`, `NOTHING_TO_LAND`, `READY`, `CONFLICT`, `CHECK_FAILED`, `ERROR`, `CANCELLED`, `SUPERSEDED`}；修订 29 加 `OBSERVED`（`OBSERVE_LANDING` 看完回报的终态，§10.6 O-J3） |
| `phase` | text NULL | CHECK ∈ {`FETCH`, `MAIN_SYNC`, `REBASE`, `MERGE`, `CHECK`, `VERIFY`, `PUSH`}：进行到或停在哪一步；修订 29 加 `OBSERVE`（§10.6 O-S2） |
| `runner_id` | uuid NULL | 入队时 = 源会话的 `assigned_runner_id`；认领时写实际认领者 |
| `claim_lease_owner` / `claim_generation` / `claimed_at` / `heartbeat_at` | text / bigint DEFAULT 0 / timestamptz / timestamptz | 租约，形状照抄 `CodexRateLimitResetOperation` |
| `cancel_requested_at` | timestamptz NULL | 现状：取消门只写这一列，QUEUED 行从此不被领取却一直算在途，runner 只在作业开头读一次（`integrate.go` 的 `runIntegrationJob`）。修订 12 对实现的要求：QUEUED 取消直接落终态 CANCELLED；RUNNING 只记录请求，runner 在周期回报与 PUSH 前同步回报的应答里读取；结果以事实为准（J-T8、J-T12） |
| `progress_protocol` | text NULL | 修订 12 新增（要求）。每次领取（J-T2 / J-T3）写入本次领取所用协议；`integration-progress/v2` 才要求周期回报与 PUSH 前同步回报。不是 v2（含 NULL：本列之前领取的行）都是 **legacy 领取**：只在阶段边界回报，取消沿用「取消中，以事实为准」 |
| `push_reported_generation` | bigint NULL | 修订 12 新增（要求，第 1 期）。**推送界线**的作业行事实：PUSH 阶段的进度回报在租约围栏内被接受时，同一条 UPDATE 写入当时的 `claim_generation`，之后不清空；接管（J-T3）一次 legacy 领取时，若它为空，领取语句写入被接管的那一代（legacy 的推送结果服务端无从排除）。读法见 J-T4「推送界线」 |
| `round` / `step` / `step_started_at` / `output_moved_at` | int / text / timestamptz / timestamptz NULL | 修订 12 新增（要求）：当前领取内的轮次、可选的子步骤（`step` ∈ {`WAITING_LOCAL_LOCK`, `PREPARE`}，与 `phase` 并列，不扩 `phase` 的 CHECK）及其起点、输出最后移动；步骤与接管的历史第 3 期起保存在事件表（§2.9 LS2） |
| `upstream_moved_commits` | jsonb NULL | 修订 12 新增（要求，第 1 期）：`LAND_PROMOTION` 因 upstream 移动而结束（J-T13、M-T12）时，结果带来的 `upstreamMovedCommits`（形状见 J-T4 接口块）。不放进 `error_detail`：`error_detail` 会被原样抄进待办 payload（`integration-job-relay.ts:982`）和投递文本 |
| `source_sha` / `target_sha_before` / `upstream_sha` | char(40) NULL | 本次作业冻结的三个 tip |
| `main_sync_sha` | char(40) NULL | 吸收 upstream 的 merge 提交（M1） |
| `tested_sha` / `tested_tree_sha` | char(40) NULL | 在其上跑检查的提交与它的树 |
| `landed_sha` / `landed_tree_sha` | char(40) NULL | 推送后目标 tip 与它的树 |
| `ahead_of_upstream` | int NULL | `git rev-list --count <upstream>..<landed>` |
| `source_on_upstream` | boolean NULL | 迁移 0346。仅 `NOTHING_TO_LAND` 时由 runner 实测：S 是否 U 的祖先（`git merge-base --is-ancestor S U`）。NULL = 没测（旧行、旧 runner、其他答案） |
| `source_fully_applied` | boolean NULL | 迁移 0410。仅 `NOTHING_TO_LAND` 时由 runner 实测：TRUE = 分支带着自己的提交，rebase 发现 base 已全部有了，重放结果就是 base（J-S4）；FALSE = 分支没有自己的提交（J-S3 的空分支，或 J-S4 重放的范围为空）。NULL = 没测 |
| `observations` | jsonb NULL | 修订 29，只给 `OBSERVE_LANDING` 用：每个被观测的任务一项（`taskId`、`deliveredSha`、`onUpstream`、`onIntegrationLine` 等，形状见 §10.4）；观测到的两个 tip 写进 `upstream_sha` 与 `target_sha_before` |
| `checks` | jsonb NOT NULL DEFAULT `'[]'` | `[{ name: 'TASK_ACCEPTANCE' \| 'MERGE_CHECK', command, expectedExitCode, exitCode: number \| null, timedOut, durationMs, outputTail }]`，`outputTail` ≤ 16 KB |
| `conflicts` | text[] NOT NULL DEFAULT `'{}'` | |
| `error_code` / `error_detail` | text / jsonb NULL | 闭集见 J12 |
| `receipt_ids` | uuid[] NOT NULL DEFAULT `'{}'` | 本作业写下的回执 |
| `confirmed_automatically` | boolean NOT NULL DEFAULT false | 迁移 0301。只有 `LAND_PROMOTION` 可为真（CHECK）：这次落地由项目的 Automatic 授权确认，不是 owner 按的（§3.3 M-T11）；runner 收到的命令带 `automatic: true`，只落到 `upstream_sha_checked` 上（M-T12） |
| `idempotency_key` | text NOT NULL UNIQUE | `ij:v1:<kind>:<taskId 或 promotionId>:<generation>`；J-T1e 补排的那一条例外，是 `ij:v1:LAND_TASK:<taskId>:behind:<sessionId>@<finished_at>`（按**工作的代**去重，`landingBehindTheWorkKey`） |
| `created_at` / `started_at` / `finished_at` / `updated_at` | timestamptz | |

**J-T4 的当前检查**（修订 23）：v2 领取的进度回报带当前检查 `{ name, index, count, budgetSeconds, startedAt }`。现有 `checks` 列是**已完成的检查结果**数组（`{ name, command, expectedExitCode, exitCode, timedOut, durationMs, outputTail }`），形状不同，不能直接复用。它存放在哪一列（新增列，或放进作业行的 JSON 列）由实现任务 t1srv（`34a1400z5T8WzXuLEQfWM`）定；本条只要求续租时按字段写入、§7.2 V6 的读模型能逐字段读出（名字、序号、总数、预算、起点）。这是对实现的要求。

约束与触发器：

- **J1（串行）**：`serial_key = canonical_repo_url || '#' || target_ref`；`CHECK_PROMOTION` 不写 ref，用 `canonical_repo_url || '#check:' || project_id`，不占 main 的串行位。部分唯一索引 `(serial_key) WHERE state = 'RUNNING'`。两个项目合进同一仓库的同一分支，同样串行。修订 29：`OBSERVE_LANDING` 用 `canonical_repo_url || '#observe:' || project_id`，不占任何分支的串行位；另加部分唯一索引 `(serial_key) WHERE kind = 'OBSERVE_LANDING' AND state = 'QUEUED'`，一个项目至多一条排队的观测（§10.4）。
- **J2（落地的树 = 测过的树）**：CHECK `state <> 'LANDED' OR (landed_sha IS NOT NULL AND tested_tree_sha IS NOT NULL AND landed_tree_sha = tested_tree_sha)`。
- **J3（一个任务同时只有一条在途的落地）**：部分唯一索引 `(task_id) WHERE kind = 'LAND_TASK' AND state IN ('QUEUED','RUNNING')`。
- **J4（终态不可变）**：触发器 `project_integration_job_terminal_guard` 拒绝修改终态行（`db-write-inventory` 的触发器清单要同步，§8.3）。

### 2.2 状态转移

| # | from | 已提交事实 | to | 附带写入（同一事务） |
|---|---|---|---|---|
| J-T1 | — | 入队事实（§2.3） | `QUEUED` | L3（第一条）；同任务更早的 `QUEUED` 行 → `SUPERSEDED` |
| J-T2 | `QUEUED` | 心跳领取 CAS（`integration-job-relay.ts#claimOne`，一条自动提交语句；它锁哪些行见 §2.9 LS2）：该 runner 声明 `integration-job/v1` 且未 draining；`cancel_requested_at IS NULL`；`LAND_TASK` 还要求该任务没有 `finished_at IS NULL` 的工作会话（见 J-T1e）；同 `serial_key` 无 `RUNNING`；按 `(created_at, id)` 取最早 | `RUNNING` | `claim_generation + 1`、`claim_lease_owner`、`claimed_at`、`heartbeat_at`、`phase = FETCH`；首次 `started_at` 保留；要求：同一条语句写本次的 `progress_protocol` |
| J-T3 | `RUNNING` | 领取时发现 `heartbeat_at < now() - 10 min`，由同一 runner 的另一进程（`claim_lease_owner` 不同）接管。持有它的进程本身仍在心跳时，这里不接管、不换代，按 §2.3 的 J-T3a 把同一条领取再交给它（修订 27）。现状：`cancel_requested_at IS NULL` 在 `claimOne` 的顶层 WHERE，已请求取消的作业不能被接管；要求：把这条过滤挪进 QUEUED 分支，**已请求取消的作业也能被接管** | `RUNNING`（换认领进程） | `claim_generation + 1`、新的租约；旧认领者的回报被 409 `STALE_CLAIM` 拒绝；新进程收到的 command 带 `cancelRequested` 时立即回报 CANCELLED（`runIntegrationJob` 开头今天就这样做）。要求：写本次的 `progress_protocol`；被接管的是 legacy 领取时按 §2.1 补写 `push_reported_generation`；第 3 期起记 Taken over 事件 |
| J-T4 | `RUNNING` | 有围栏的进度回报。现状：只在阶段边界回报、尽力而为，应答 `{ accepted: true }` 被 runner 丢弃（`integrate.go#runIntegrationJobAndReport`）。要求：v2 领取在 prepare、本机锁等待、铺环境与检查期间每 30 秒内回报一次，PUSH 前同步回报一次（晋升重检见 M-T7） | `RUNNING` | 续租 `heartbeat_at`、写 `phase`；要求：写步骤、检查与输出事实，PUSH 回报写 `push_reported_generation`，第 3 期起内容变化才追加事件；应答带 `cancelRequested`（接口见下方「J-T4（进度与取消协议）」） |
| J-T5 | `RUNNING` | 结果回报：`LANDED` / `ALREADY_LANDED` / `NOTHING_TO_LAND`（0300） | 同名终态 | 回执（J8，`NOTHING_TO_LAND` 仅在该任务没有任何会话报告过工作时；全部已应用的那种见 J8）；解决该任务的集成类待办（X 表，仅落地与写下回执的全部已应用）；提交后边沿见 J9–J11。抢跑的 `ALREADY_LANDED` 与全部已应用的 `NOTHING_TO_LAND`（判定的领取早于该任务工作结束）不落终态，退回 `QUEUED`（见 J-T1e） |
| J-T6 | `RUNNING` | 结果回报：`READY`。`CHECK_PROMOTION`：检查通过。`LAND_PROMOTION`：只有 Automatic 确认的作业（`confirmed_automatically`）会答 READY——upstream 已不在 `upstream_sha_checked`，或第一次推送被抢（J-T13）；领取时授权已不成立的，平台不下发、直接记 READY（M-T12） | `READY` | `CHECK_PROMOTION`：晋升 → `READY`（M-T2）或自动确认（M-T11）；`LAND_PROMOTION`：晋升交回 `READY` 并开 `PROMOTION_APPROVAL`（M-T12）；要求：结果带 `upstreamMovedCommits` 时写进作业行（§2.1） |
| J-T7 | `RUNNING` | 结果回报：`CONFLICT` / `CHECK_FAILED` / `ERROR` | 同名终态 | 例外待办（§4.2）；晋升 → `BLOCKED`（若有） |
| J-T8 | `QUEUED` / `RUNNING` | 叫停事实，与它同一事务。**`LAND_TASK`**：`task_reopen` 门（与写 `task_reopen_intent` 同一事务，0381）、任务被写成 CANCELLED 或 FAILED、owner 的 LAND_TASK 叫停门（§4.7）；普通的 DONE → IN_PROGRESS 编辑是继续工作，不叫停。**晋升作业**：候选被取代（M-T6）、被卡片之外的合入回执退役（M-T13）或拒绝、owner 的 Cancel（M-T10） | QUEUED → `CANCELLED`；RUNNING 保持 `RUNNING` | 要求：QUEUED 直接写终态，不计 inFlight、queuedCount 或判据 IN_FLIGHT；RUNNING 一般只写 `cancel_requested_at`，由 J-T12 收口，不直接写 CANCELLED（已超时的例外见下）；已过推送界线（J-T4）的 RUNNING 不再接受叫停，结果以事实为准。**叫停一个按 §7.2 V6 已超时的 RUNNING 作业时**，不只写 `cancel_requested_at`：按 J-T9 的比较并交换当场把它结束为 `ERROR`（`claim_generation + 1`，迟到的结果被拒），错误码按 J12（`CHECK_PROMOTION` 一律 `RUNNER_LOST`，另两种按推送界线；与 M-T13 的做法相同）——只写取消请求的行永不再被领取，runner 已死时它会永久占住串行槽。仍在回报期内（未超时）的 RUNNING 才只写 `cancel_requested_at`，由 J-T12 收口。**叫停 RUNNING 的 `LAND_TASK` 之后任务又写成 DONE**：旧一代还占着 J3 的在飞索引，那次 DONE 排不进新一代（`queueLandingForWork` 答 `ALREADY_QUEUED`），此时**不要消费** `task_reopen_intent`（现状会删掉它）。今天所有领取都是 legacy，runner 只在作业开头读一次 `cancelRequested`（`integrate.go#runIntegrationJob`），被叫停的 RUNNING 作业几乎总是照常跑完，回报 `LANDED`、`ALREADY_LANDED`、`NOTHING_TO_LAND`、`CHECK_FAILED`、`CONFLICT`、`ERROR`；其余落在 J-T1e 的「判得太早」两条路径上——`ALREADY_LANDED` / 全部已应用的 `NOTHING_TO_LAND`（以及候选检查一侧）在作业带取消请求时不退回 `QUEUED`，而是在同一结果事务里写成 `CANCELLED`（否则留下的 `QUEUED` 行永不被领取）。因此补排不只看 `CANCELLED`：**被叫停的 `LAND_TASK` 以任何终态结束**时——写下终态的几扇门都算：runner 的结果（含 J-T1e 的两条「判得太早」路径与 J-T12 的 `CANCELLED`）、J-T9 超时结束的 `ERROR`、J-T10 放弃写的 `ERROR`——在**写下该终态的同一事务里**，只要 `task_reopen_intent` 仍在、任务此刻是 DONE 且没有更新的一代，就补排下一代 `LAND_TASK`（与 J-T1b 的 `queueLandingRetry` 同一条路），并在同一事务消费这个标记；`task_reopen_intent` 保留到补排为止。任务没有再次 DONE 时不补排。被叫停的一代不按 J-T1e 补排落后的工作，也**不开任何失败待办**（不论任务是否再次 DONE）——这是 J-T7、J-T10 与 §4 X 表 `INTEGRATION_ERROR` 的例外，**被叫停的这一代**（作业带 `cancel_requested_at`）被放弃时写的 `ERROR` 同样不开待办：叫停与放弃都表示这一代不要了，再开一条失败待办只会让人处理一个已被放弃的作业。这条例外只看 `cancel_requested_at`，不看结束它的是哪扇门：**没被叫停的作业被放弃**（J-T10、§4.7）不在此例，照 J-T10 与 §4 X 表开 `INTEGRATION_ERROR`：这一代没人说不要，要不要重跑得有人决定——写 `RUNNER_LOST` 时它没有推送，写 `PUSH_OUTCOME_UNKNOWN` 时推没推没人知道（只有同一 serial_key 上后来的作业可能经 J12 补写回执），之后不会有 runner 的结果再为它开待办；这条待办按 §4.2 归协调会话或 owner，J-T1b 的重试门按它的归属放行（owner 的门要有归 owner 的这条待办）。`integration-job-relay.ts` 的结果事务只在 `!cancelRequested` 时开失败待办，放弃门走的也是这个事务。J-T10 的「只结束、不重排」指不重试被放弃的那一代，不挡这次补排——补排的是那次再次 DONE 被推迟的入队，不是对被放弃一代的重试。J-T9 结束时自己按 J-T1b 入队下一代，此时「没有更新的一代」已不成立，这里不会重复补排。现状：只有晋升的 `applyCancel` 写 `cancel_requested_at`（QUEUED 也只写这一列），supersede 把 QUEUED / RUNNING 的检查作业直接写成 CANCELLED（`supersedeLiveCandidates`），LAND_TASK 没有叫停。实现若加 CHECK「QUEUED 行不带 `cancel_requested_at`」（`state <> 'QUEUED' OR cancel_requested_at IS NULL`），先把已有的这类行回填为 CANCELLED，之后 §2.7a 的 `CANCELLING` 不再出现 |
| J-T9 | `RUNNING`（超时） | 对**超时**的 `LAND_TASK` 按 J-T1b 重试（owner 或协调会话）；对**超时**的 `CHECK_PROMOTION` 按 §4.7 H1 的候选重检门重试（owner 或协调会话；候选 `CHECKING` 或 `BLOCKED`，先结束再重排，见该节）——**不适用于 `LAND_PROMOTION`**：它答的是已在确认中的合入，超时由接管（J-T3）或放弃门（J-T10）收口。超时在读时判定、不存储，判定只有 §7.2 V6 一处定义，本行不复述（§1.6 的 `inFlightJobs.timedOut`、X-E5 与放弃门都引它）。**现状**：今天的实现只有 legacy 这一支——上次回报距今超过时限（git 步骤为领取租约 10 min，检查中为本作业各检查预算之和再加 10 min；runner 只在步骤开始时回报），已领取、尚未回报，且同一 runner 上同仓库同目标 ref 有更早领取的 `RUNNING` 作业时，视为在本机锁上排队，不算超时 | `ERROR`（`error_detail` 记停在的步骤、上次回报、时限、runner、是否已过推送） | 对状态与判定所依据的 `heartbeat_at` 做比较并交换，期间有回报、接管或结果则拒绝；`claim_generation + 1`；同一事务按 J-T1b（`LAND_TASK`）或 §4.7 H1（`CHECK_PROMOTION`）入队下一代，不开待办。旧认领迟到的结果因作业已终态不被采纳。**现状**：`error_code` 一律 `RUNNER_LOST`。**要求**：写哪一句按 J12 的那条规则判（该规则按作业种类分支：`CHECK_PROMOTION` 从不推送，一律 `RUNNER_LOST`；`LAND_TASK` / `LAND_PROMOTION` 才看推送界线——只有当前领取是 v2、且 `push_reported_generation IS NULL` 时才写 `RUNNER_LOST`，其余一律 `PUSH_OUTCOME_UNKNOWN`），与放弃（J-T10）同一条。被接管的上一代领取可能已经推送（它留在这一列上的是那一代的领取，不是 NULL），legacy 领取的 PUSH 回报只是尽力而为、`phase` 停在 CHECK 也证明不了没推送，两者都落在后者。下一代照常入队，接续靠既有的 `ALREADY_LANDED` 判定（J-T5 / J-T6），不靠这句错误码 |
| J-T10 | `RUNNING` | owner（用户门）或项目当前协调会话（`integration_abandon`）执行 Abandon；服务端在同一事务里复核当前领取 `LEASE_EXPIRED`（§7.2 V6 的定义，含 legacy 领取的放宽界线） | `ERROR` | 要求：与 apply-result 共用结果事务，写 `RUNNER_LOST` 或 `PUSH_OUTCOME_UNKNOWN`（J12 的判定：`CHECK_PROMOTION` 一律 `RUNNER_LOST`；`LAND_TASK` / `LAND_PROMOTION` 按推送界线，这两个作业的 legacy 领取一律后者）、`claim_generation + 1`、待办（照 §4 X 表开 `INTEGRATION_ERROR`；被叫停的那一代——作业带 `cancel_requested_at`——不开，见 J-T8）与晋升结果，并结束该作业的 X-E5 提醒（`JOB_MOVED_ON`）；迟到回报 409 `STALE_CLAIM`。**只结束、不重排**（与 J-T9 的重试门相对；被叫停的 `LAND_TASK` 例外，见 J-T8）：不按 J-T1b 入队下一代，作业就此终态；`LAND_TASK`、`CHECK_PROMOTION`、`LAND_PROMOTION` 三种作业都适用。修订 16 之后，超时的 `CHECK_PROMOTION` 已有候选重检门（§4.7 H1），所以放弃门今天的存在理由收窄为三类：超时的 `LAND_PROMOTION`（它答的是已在确认中的合入，没有重检门）；「只结束、不重排」；runner 永久离线（托管 runner 崩溃、被围栏、owner 停用之后，只有同一 runner 能接管，接管不会发生） |
| J-T11 | `RUNNING` | runner 排空时交还已领取、没有推送的作业：release 门 CAS 复核 state、runner、leaseOwner、claimGeneration（及 owner）。两种来源：停机开始后到达的心跳应答里领到、不再启动的作业；停机的操作预算（`shutdownOperationsTimeout`，与轮次排空同为 100 秒）到时仍在跑、于推送之前被停下的作业——铺环境或检查连同整个进程树被结束，临时 worktree 被删除，然后交还。已过检查、进入 PUSH 的作业不中断，照常推送、核对、回报 | `QUEUED` | `claim_generation + 1` 使旧领取失效、清掉认领租约与步骤并释放 J1，保留首次 `started_at`；应答 `{ released: true }`，并唤醒该 runner。取消请求已存在时改走 J-T12：同一结果事务写 `CANCELLED`，应答 `{ released: false, state: 'CANCELLED' }`，不交还一条不可领取的 QUEUED。已登记 db-write-inventory。X-E5 提醒尚未实现，没有可结束的；第 3 期起写交接事件。已实现（2026-10-17，`integration-job-relay.ts#releaseIntegrationJob`、runner-go `handBackIntegrationJob`） |
| J-T12 | `RUNNING` | 要求：runner 从进度应答读到 `cancelRequested`、接管后读到 cancel，或已停止执行并回报取消 | `CANCELLED` | 同一结果事务收口取消中的晋升（M-T10）；runner 收到 409 或终态应答也杀掉检查进程组、释放 integrationLock；已实际 LANDED 的结果必须走 J-T5 / M-T8 |
| J-T13 | `RUNNING`（`LAND_PROMOTION`） | 要求：第一次推送被拒 `TARGET_MOVED`。现状：已实现（e94080db6，`integrate.go` 的 `promotionRefetchRounds = 0`）：不在作业内重取，Automatic 的作业答 READY，owner 确认的答 `ERROR / TARGET_MOVED` | `READY`（Automatic）或 `ERROR / TARGET_MOVED`（owner 确认，这一次领取就此结束） | 均结束这一次领取、不在作业内重跑检查，并写下这次 `upstreamMovedCommits`（§2.1）。**Automatic**：候选按 M-T12 回到 `CHECKING` 重检，第 `AUTOMATIC_MERGE_ATTEMPTS`（3）次仍发现 main 已动、或授权已撤回时才回 `READY` 出卡（owner 2026-10-15，d321b88ee）。**owner 确认**（owner 2026-10-19 决定，选 B）：候选留在 `CONFIRMED`，同一事务入队下一代 `LAND_PROMOTION`（同一确认、`generation + 1`），在新 main 上按 M5 重检并落地；新领取的 `claim_generation` 使推送界线从新代起算，Cancel 重新可用。同一候选连续第 3 代 `LAND_PROMOTION` 都以 `TARGET_MOVED` 结束（中间有任何别的结果即重新计数）才转 `BLOCKED`，开 INTEGRATION_ERROR 待办，payload 带 `upstreamMovedCommits` |

**`OBSERVE_LANDING`（修订 29）**：它的状态转移是 §10.6 的 O-J1–O-J4：观测入队（§2.3）→ `QUEUED`；J-T2 同一扇门领取 → `RUNNING`；结果回报 `OBSERVED` → `OBSERVED`，同一事务按任务写回执或开待办（O-R1–O-R4）；结果回报 `ERROR` 或 J-T9 超时 → `ERROR`（超时写 `RUNNER_LOST`，它从不推送），不开集成待办，本项目仍有待观测的任务时同一事务再入队一条（O-J4）。它的结果不走上表的 J-T5–J-T7；领取、租约、J4 与 J-T4 的租约围栏照本节；它不开落地会话（附录 A-Q23），X-E5 不开给它。

**J5（不自动重试）**：`CONFLICT`、`CHECK_FAILED`、`ERROR` 之后平台不再入队，重试只由 J-T1b、J-T1c 两个事实触发（判据 6）。`OBSERVE_LANDING` 的 `ERROR` 是例外，按 §10.6 O-J4 再入队（见上段）。同一次作业内「推送时目标被别人推进」的重取例外只适用于 `LAND_TASK`：回到 FETCH，最多再做 2 轮（附录 A-Q5），不另起作业。`LAND_PROMOTION` 第一次 TARGET_MOVED 即结束这一次领取（J-T13；e94080db6 起已实现，`promotionRefetchRounds = 0`）：Automatic 的按 M-T12 回 `CHECKING` 重检，owner 确认的在同一确认下重排下一代 `LAND_PROMOTION`（owner 2026-10-19）；连续第 3 次才交回 `BLOCKED`。J-T1c 尚未实现时，冲突返工走 `task_reopen` → 再次 DONE → J-T1a，任务段不结案（§2.9）。J-T1e 的补排入队的是另一条分支上的首次落地，不是失败作业的重试。

**J-T4（进度与取消协议；整段是修订 12 对实现的要求，第 1 期）**：

- **周期回报**：v2 领取（runner 声明 `integration-progress/v2`，领取时记进 `progress_protocol`）在 prepare、等待本机 integrationLock、铺环境与检查期间每 30 秒内回报一次。服务端在租约围栏内（`state = RUNNING` 且 `claim_generation`、`claim_lease_owner` 都匹配）续租 `heartbeat_at`，写 `phase` / `step` / `round` / 当前检查，`output_moved_at = 收到时刻 − outputIdleMs`，只在步骤变化时写 `step_started_at`；第 3 期起只在内容变化时追加事件，单纯心跳不追加。续租不得让平铺会话列表的版本每 30 秒失效：`readOpenListVersion` 今天按作业行的版本取指纹（`open-list-version.ts` 的 `integration_job` 一项），实现要把续租写入排除在指纹之外，或只取列表真正显示的列。
- **应答与停止信号**：每次应答带 `cancelRequested`；v2 runner 读到 true 就杀掉检查的进程组，≤30 秒内停止并回报 CANCELLED（J-T12）。409 `STALE_CLAIM`（领取已失效：被接管、放弃或交还）、409 `ALREADY_FINAL`（作业已终态）与 404 是**停止信号**：杀掉检查的进程组、释放 integrationLock、不推送，也不再回报结果。
- **PUSH 前同步回报**：v2 领取的 command 带 `reportBeforePush: true`。runner 在 J-S6 / M-S4 推送之前回报 `phase = PUSH` 并等应答：200 且 `cancelRequested = false` 才推送；`cancelRequested = true` 不推送、回报 CANCELLED；停止信号不推送；在租约窗口内重试仍得不到应答（网络错误、5xx、超时）也不推送，作业以 `ERROR / PUSH_REPORT_UNREACHABLE` 结束（J12；目标分支没有变动，结果按 J-S8 缓存重发）。
- **推送界线**：定义为「服务端在本次领取（`claim_generation`）下记下过同步 PUSH 回报」，即 `push_reported_generation = claim_generation`，不看当前的 `phase` 列。第 1 期就从作业行读出；第 3 期事件表上线后，PUSH 回报同时追加一条事件。只能看 `phase` 的地方——legacy 领取——`PUSH` 与 `VERIFY` 都算已过界：runner 推送成功后报 VERIFY（`integrate.go:453`、`:753`），而今天 `applyCancel` 只排除 PUSH（`project-promotion.service.ts:610`），VERIFY 期间的取消会把已推送的合入记成 CANCELLED，这是要修的缺陷。界线一过，取消门不再接受（M-T10），结果以事实为准（M-T8）。
- **legacy 领取**（`progress_protocol` 不是 v2，含 NULL）：只在阶段边界回报，PUSH 回报尽力而为、应答被丢弃（`integrate.go:1149`），所以「服务端没记下 PUSH」不能证明没有推送。三条规则：(1) `LEASE_EXPIRED` 用 §7.2 V6 给 legacy 领取的放宽界线（检查期间不按 10 分钟判）；(2) X-E5 按同一条界线开待办；(3) 放弃一个 legacy 领取的 `LAND_TASK` / `LAND_PROMOTION` 一律写 `PUSH_OUTCOME_UNKNOWN`，不写 `RUNNER_LOST`，也不说「nothing was pushed」（`CHECK_PROMOTION` 从不推送，仍按 J12 一律 `RUNNER_LOST`）。取消保持「取消中，以事实为准」（M-T10）。
- **部署**：先部署 apiserver，再发 runner 和客户端。新线上字段一律可选；旧 runner 忽略应答里不认识的字段，照旧按 legacy 工作。

```ts
// runner → 控制面：POST /runner/integration-jobs/:jobId/progress（新字段都可选）
interface IntegrationJobProgressRequest {
  claimGeneration: string; leaseOwner: string;
  phase: IntegrationJobPhase;               // 0281 的闭集（phase_chk）：FETCH | MAIN_SYNC | REBASE | MERGE | CHECK | VERIFY | PUSH
  step?: 'WAITING_LOCAL_LOCK' | 'PREPARE';  // 本机锁等待（phase = FETCH）、铺环境（phase = CHECK）；不扩 phase
  round?: number;                           // 本次领取内的轮次，从 1 起；LAND_TASK 至多 3（J5），LAND_PROMOTION（J-T13）与 CHECK_PROMOTION 只有 1（显示见 §7.2 V6）
  check?: { name: 'TASK_ACCEPTANCE' | 'MERGE_CHECK'; index: number; count: number;
            budgetSeconds: number; startedAt: string };
  outputIdleMs?: number;                    // 当前步骤的输出多久没动（第 1 期起量，换掉 CombinedOutput 才量得出）
  outputBytes?: number;                     // 当前步骤累计输出字节
  upstreamMoved?: { from: string; to: string; commits?: number };   // 既有（M-T7）
  // 下面四项只在 phase = PUSH 的回报里带：runner 只在 v2 领取的 PUSH 前同步回报里填（J-S6 / M-S4，
  // integrate.go#reportPush）；服务端只在 phase = PUSH 时读（别的阶段带了也不记），值须是 40 位小写十六进制的
  // 完整 sha，否则 400 INVALID_RESULT。这次回报本身划下推送界线（同一条 UPDATE 写 push_reported_generation，见上）；
  // 这四项是界线那一刻要推送的东西，同一条 UPDATE 写进作业行同名列，供 J12 修复：之后这次推送结果成了
  // PUSH_OUTCOME_UNKNOWN，同一 serial_key 上的下一条作业据它们查证并补写回执。
  // 现状（已知缺口，待修）：写法是 COALESCE（已有的值不覆盖），领取（J-T2 / J-T3）也不清空它们，所以列里留的是
  // 这条作业第一次被接受的 PUSH 回报，J12 能查证的只是那一次要推送的提交。LAND_TASK 第 2、3 轮（J5）或接管后的领取
  // 推送、结果又成了未知的，修复会漏掉（下一条作业查的是第一次的 tested_sha，查不到就不补写）；补写只写已查到在目标上的
  // 那个提交，所以不会写出假回执。
  testedSha?: string;        // 要推送的提交（作业行的 tested_sha）。tested_sha 非空的未知结果才交给下一条作业查
                             // （command 的 unknownPushes），查到它已是目标的祖先，它就是补写回执的落地提交
  testedTreeSha?: string;    // 它的树：补写回执 detail 的 testedTreeSha / landedTreeSha
  sourceSha?: string;        // 它重放或合入的源提交：LAND_TASK 补写回执的 source_sha（为空就不补写）
  targetShaBefore?: string;  // 推送前预期的目标 tip（LAND_PROMOTION 为 upstream tip）：补写回执的 target_sha_before 与
                             // rebase_base_sha（PUSH 回报不带 main_sync_sha，未知结果的作业行上它为空，LAND_TASK 的
                             // main_sync_sha ?? target_sha_before 因此取这一项）
}
// 控制面 → runner：200 下面这个；409 STALE_CLAIM / 409 ALREADY_FINAL / 404 是停止信号
interface IntegrationJobProgressResponse {
  accepted: true;
  cancelRequested: boolean;                 // 新：作业的 cancel_requested_at 非空
}

// IntegrationJobCommand（§2.3）新增，只发给 v2 领取：
//   reportBeforePush?: true;               // 推送前必须同步回报 phase = PUSH，见上

// 结果 POST /runner/integration-jobs/:jobId/result 新增（只在 LAND_PROMOTION 因 upstream 移动而结束时，
// J-T13 / M-T12）；不放进 errorDetail：
//   upstreamMovedCommits?: UpstreamMovedCommits;
interface UpstreamMovedCommits {
  total: number;                            // 推进 upstream 的提交总数（runner 实数）
  commits: Array<{                          // 至多 20 条，first-parent 顺序，最新在前
    sha: string;
    subject: string;                        // 截到 200 字符
    outsideQueue: boolean;                  // 服务端判：同一 serial_key 上没有 LANDED 的 LAND_PROMOTION 以它为 landed_sha
    landedBy?: { jobId: string; promotionId: string }   // 本账号的那次合入
             | { reason: 'ANOTHER_ACCOUNT' };            // 跨账号只给原因，不给 id 或标题
  }>;
}
```

数字型的 `upstreamMovedBy`（§3.6 `recheck.upstreamMovedBy`、shared `project-progress.ts` 的 `ProjectPromotionView`、`project_promotion.upstream_moved_by`，0294）仍是 M-T7 的「main 移动了几个提交」；推送被抢时的提交列表另叫 `upstreamMovedCommits`，两者不混用。

**新路由**（修订 12 对实现的要求；**不碰 `contracts/runner-write-protocol.json`**——它是写协议契约、不列路由，摘要校验会拒绝已部署的 runner（47de98f3a 加 release 门时也没改它）。runner 门登记进 `auth/tenant-isolation-runner-cases.ts` 的 `RUNNER_ISOLATION_CASES`，请求体或 query 里的 id 进 `RUNNER_ISOLATION_FIELD_CASES`，由 `tenant-isolation-census.spec.ts` 的普查守住（fb89ad992 起）；每条新路由自己带跨租户用例，没有「runner 门不在名册里」的例外。带 `:param` 的用户门进 `auth/tenant-isolation-cases.ts`（请求体或 query 里带的 id 另进 `TENANT_ISOLATION_FIELD_CASES`），owner 门标 `@PatForbidden('OWNER_INTERACTIVE')` 并登记 `auth/pat-owner-channel-routes.ts`；别人项目的读口回 404，与 da1b9b0b4 之后的 promotions 读口一致）：

| 路由 | 门 | 期 | 作用 |
|---|---|---|---|
| `POST /runner/integration-jobs/:jobId/release` `{ claimGeneration, leaseOwner }` | runner 门，领取围栏 | 1 | J-T11（已实现）；200 `{ released: true, state: 'QUEUED' }`，或取消请求已存在时 `{ released: false, state: 'CANCELLED' }`（J-T12）；409 `STALE_CLAIM` / `ALREADY_FINAL`；404 别的账号的作业或旧控制面 |
| `POST /runner/integration-jobs/:jobId/output` `{ claimGeneration, leaseOwner, check: { name, index }, seq, text }` | runner 门，领取围栏 | 3 | 检查输出分块，写 `project_integration_job_log`（§2.9 LS2） |
| `GET /runner/projects/:id/integration` | runner 门（项目内会话）；MCP / CLI `project_integration_get` | 1 | 作业、轮次、检查与日志分页（按 `jobId`、`claim`、`round`、`check`、`cursor`），只读（LS6） |
| `POST /runner/projects/:id/integration/jobs/:jobId/abandon` `{ reason }` | runner 门，`X-Orbit-Session-Id` 须为项目当前协调会话；MCP `integration_abandon { projectId, jobId, reason }` | 4 | J-T10；`reason` 必填、≤2000 字符 |
| `POST /projects/:id/integration/jobs/:jobId/abandon` | owner 用户门，拒绝带 acting session | 4 | J-T10；X-E5 待办、落地会话页头与合入卡上的 Abandon 都按这扇门 |
| `POST /projects/:id/tasks/:taskId/integration/stop` | owner 用户门，拒绝带 acting session | 4 | LAND_TASK 的叫停门（J-T8）；晋升照旧用 M-F3 的 Cancel |
| `GET /sessions/:id/landing/log` | 用户门（读），别人的会话回 404 | 3 | 落地会话页的检查输出分页 |

放弃门的拒绝：作业不是 RUNNING → 409 `INTEGRATION_ABANDON_NOT_RUNNING`；租约未过期 → 409 `INTEGRATION_ABANDON_LEASE_LIVE`；runner 门的调用者不是项目当前协调会话 → 403 `INTEGRATION_ABANDON_COORDINATOR_ONLY`。叫停门：已过推送界线 → 409 `INTEGRATION_STOP_PUSHED`；没有在途的 LAND_TASK → 409 `INTEGRATION_STOP_NOT_APPLICABLE`。

### 2.3 触发点

**J-T1a（DONE）**：写 `task.status = DONE` 的三个事务里，调用 `ProjectIntegrationJobService.enqueueForDoneTask(tx, taskId)`：

| DONE 写入点 | 所在方法 |
|---|---|
| EXECUTABLE 验收命令退出码一致 | `RunnerApiController.turnComplete` |
| 证据裁决 CONFIRM | `TaskCompletionEvidenceService.decide` |
| VERIFICATION PASS 放行被验证任务 | `TasksService` 中核验通过后放行 subject 的路径 |

`enqueueForDoneTask` 在 `isCodeTask` 为假时什么也不做；为真时按 §10.5 O-L4 冻结交付身份（修订 29），并按线入队：`MAIN` 线（或尚未决定、按 L2 算出 `MAIN`）的项目改为插入晋升（§3.4 M-F2），但交付方式为 `AGENT_PUSH` 的项目不插入，改为入队观测（修订 29，§10.5 O-L2、§10.6 O-T1）；`PROJECT_BRANCH` 线插入 `LAND_TASK`。父任务聚合（`applyTaskAggregations`）写的 DONE 不入队：父任务没有自己的工作分支。新增普查 `src/apiserver/src/projects/integration-enqueue-done-sites.spec.ts`：扫描 apiserver 里所有把 task 写成 DONE 的方法，要求每一处在同一方法内调用 `enqueueForDoneTask`，聚合写入方列入白名单；修订 29 起它还要求每个 DONE 写入点同时冻结交付身份（§10.9）。

**J-T1b（显式重试）**：协调会话调用 MCP `integration_retry { projectId, taskId, reason }`（runner 门 `POST /runner/projects/:id/tasks/:taskId/integration/retry`，带 `X-Orbit-Session-Id`）。规则在 `project-integration-retry.ts#decideIntegrationRetry`，读的事实都在任务行 `FOR NO KEY UPDATE`（与 DONE 事务同一把锁）下读：

- `reason` 必填，去空白后非空且 ≤2000 字符，否则 400 `INTEGRATION_RETRY_REASON_REQUIRED`。
- 只认该项目**当前**的协调会话，否则 403 `INTEGRATION_RETRY_COORDINATOR_ONLY`（任务自己的会话、别的项目的协调会话、不带头的调用都在此列）；任务不在该项目下 403 `INTEGRATION_RETRY_NOT_THIS_PROJECT`。
- 任务须为 DONE，且最新一代 `LAND_TASK` 以 `CHECK_FAILED` 或 `ERROR` 结束，或仍 `RUNNING` 但已超时（J-T9：先把它记为 `ERROR`——写 `RUNNER_LOST` 还是 `PUSH_OUTCOME_UNKNOWN` 按 J12 的那条规则判，失败分类都按 `ERROR`），否则 409 `INTEGRATION_RETRY_NOT_APPLICABLE`。`CONFLICT` 也在此列：原样重跑会再冲突一次，冲突只由改过的分支解开（`task_reopen` 返工，或 successor）；`phase = MAIN_SYNC` 的冲突在项目线和 upstream 之间，改的是源分支对 upstream 的吸收，见 §3.1 M3，拒绝文案照此说。最新一代仍 `QUEUED`，或仍 `RUNNING` 且未超时，409 `INTEGRATION_RETRY_IN_FLIGHT`。
- 失败分类（`landingFailureClass`，只读作业的结构化结果、不读输出）：`CONFLICT`、`CHECK_FAILED`、`CHECK_TIMED_OUT`（某条检查 `timedOut`，即跑到它的预算被 runner 终止）、`ERROR`；可重跑的是后三类。
- 该任务有 OPEN 的集成类待办归 owner（`ESCALATED`、非 Automatic 的 `NO_COORDINATOR` 等）→ 409 `INTEGRATION_RETRY_OWNER_ITEM`；该任务有未解决、等 owner 的 blocker → 409 `INTEGRATION_RETRY_OWNER_BLOCKER`。
- 权限：有归协调会话的 OPEN 集成类待办即可——包括 owner 用「Ask the coordinator again」交回的那条，开关不论；没有 OPEN 待办（例如已被 `open_item_resolve` 手工关掉）时由 Automatic（`coordinator_enabled`）回答，关着 → 403 `INTEGRATION_RETRY_NOT_AUTOMATIC`。

通过后同一事务：经 `queueLandingRetry` 入队**一个**下一代 `LAND_TASK`——分支取此刻一次 DONE 会交给线的那条（`landingWorkSession`），不是失败那一代的 `source_ref`，因为落地失败后任务可能又跑过、成果已在新分支上——新行写 `retry_of_job_id`、`retry_failure_class`、`retry_reason`、`retry_requested_by_session_id`（迁移 0344，四列同有同无）；该任务归协调会话的 OPEN 集成类待办**不关闭**，记上新一代的 `handling_job_id` 与 `handling_session_id`、`handling_reason`、`handling_started_at`（迁移 0368），读作处理中（§4.7 H1）——它们的 `integration_job_id` 仍指失败那一代，新一代的 `retry_of_job_id` 也指它，两边由此关联。新一代落地则照 J-T5 写回执，先把这些待办写成 `RESOLVED` / `HANDLED`（`resolved_by = COORDINATOR`、发起会话、理由、`resolved_by_job_id`，H2）、再解决其余待办，并照 M-F1 继续项目分支的合并检查；再失败照 J-T7 开新的分类待办（payload 带 `failureClass`、`generation`、`retry`），并把这些待办写成 `SUPERSEDED` / `RETRIED`、`superseded_by_item_id` 指向新待办（H3），负责人照 §4.3 的规则——Automatic 下仍是协调会话，不因重跑升级给 owner；处理期间已被时钟交给 owner 的，新待办仍归 owner（H4）。BLOCKED 候选带 `promotionId` 的重检同理（§4.7 H1）。平台自己仍不重跑（J5）。owner 的用户门是 `POST /projects/:id/tasks/:taskId/integration/retry`（同一规则，requester 记 USER；须有归 owner 的待办，超时的落地除外——还没有任何待办），以及项目落地行作业列表上的 Retry：`POST /projects/:id/integration/jobs/:jobId/retry`，无请求体，只收 `inFlightJobs` 里 `retryable` 的作业（超时的 `LAND_TASK`），理由由服务端按作业事实写成，经同一扇门、限定为该作业，应答为重读的 `ProjectIntegrationView`。超时的晋升作业照样显示超时；`CHECK_PROMOTION` 的超时从带 `promotionId` 的候选重检门重试（§4.7 H1，J-T9），`LAND_PROMOTION` 的超时不从那扇门重试——它答的是已在确认中的合入，由放弃门（J-T10）收口。

**J-T1c（任务分支来了新提交）**：该任务工作会话的 `turnComplete` 提交时，若 `dto.branchSha` 与该任务最近一条失败作业的 `source_sha` 不同、任务仍是 DONE、且有 OPEN 的集成类待办，同一事务入队下一个 generation（效果图 5：「push to the task branch — Orbit re-integrates and re-checks on its own」）。

**J-T1d（线开始时补入队）**：见 L3 第 4 步。

**J-T1e（不许抢跑；判成了「没有独有提交」而成果在另一条分支上）**：`LAND_TASK` 的 `ALREADY_LANDED` 只在**该任务的工作已经停止移动**时才写成终态，因为 runner 在**结束会话**时才提交 worktree（SR13），而作业由结束它的那次 DONE 入队——线可能在提交存在之前就被交给一条空分支，那时它唯一能给的答案就是 `ALREADY_LANDED`，而那是终态、按设计不再重投。两条守卫（`project-integration-job.ts` 的 `landingWorkHasSettled` / `landingJudgedTooEarly`，SQL 见 `integration-job-relay.ts#claimOne`）：

- **领取（J-T2）**：该任务任一工作会话 `finished_at IS NULL` 时不领取，留在 `QUEUED`；会话结束后第一个心跳领取（那时 fetch 到的分支才带着收尾提交）。
- **判定（J-T5）**：回报的 `claimed_at` 早于某工作会话的 `finished_at`（或该会话尚未结束）时不落终态，该行退回 `QUEUED` 清空认领，由下一次领取重判。

**补排**：终态 `ALREADY_LANDED` 的 `source_ref` 若**不是**该任务工作结束所在的分支（该任务最后结束的工作会话的 `worktree_branch`，缺省回落 `branch`；`workBranchEndedOn`），成果就没有任何路线——同一事务入队下一个 generation，`source_ref` 指向那条分支（`queueLandingBehindTheWork`，`landingLeftWorkBehind` 为判据）。2026-09-23 的事故：任务 `01a0ce5e…` 的 DONE 冻结了**已经失败的那轮 retry** 的分支 `orbit/autorun-false-830a9b`（tip 就是项目分支 tip，什么都没带），而 151 轮那条会话的 `789a8fffc` 在 `orbit/autorun-false-91f94d` 上；线答 ALREADY_LANDED 时那条会话还有 2 分 42 秒没跑完，成果最后靠两次人工 cherry-pick 才落地。用例见 `src/apiserver/src/tasks/task-landing-races-final-commit.pg.spec.ts`。
- **守门：一代工作最多补一次**：补排那一条的幂等键不是它自己的 generation（每次 DONE 都会推进它），而是**工作的代**——该任务、工作结束所在的那条会话、那次 `finished_at`：`ij:v1:LAND_TASK:<taskId>:behind:<sessionId>@<finished_at>`（`landingBehindTheWorkKey`）。同一份工作被再次触发（例如任务在工作没动的情况下再次写成 DONE，J-T1a 又冻结同一条起始分支、线又答同一个 `ALREADY_LANDED`）时，J3 的在飞索引已经看不见上一次补排，但 UNIQUE 键会拒掉第二条：不产生第二个作业，也就不会有第二条待办/唤醒。工作动了——会话重开后再次结束（`finished_at` 变了），或更晚的会话结束（会话 id 变了）——就是新的一代，允许再补一次。runner 只在结束会话时提交（SR13），所以没有不经过一次新 `finished_at` 就落到工作分支上的提交。与之配套：对**不是**工作结束所在分支的 `ALREADY_LANDED`（即触发补排的那种回答）不算该任务落地，J-T5 不拿它去关该任务的集成类待办——补排那一条若失败（`CONFLICT` 等），它的待办就是「成果还没进线」的唯一记录，同一代再次触发时守门不再补，若再把卡关掉，成果就静默滞留了。用例见同一 spec 的 (7)(8)(9)。

**J-T1e 的候选一侧（§3.4 M-F2）**：同一场竞态在晋升候选上重演——`CHECK_PROMOTION` 是唯一解析并冻结 source tip 的东西（`TASK_BRANCH` 候选的 `source_sha` 由它回写，0293），候选由结束任务的那次 DONE 入队，于是检查可能在收尾提交存在之前就把 tip 冻成「owner 被问的那个 commit」，owner 合下的是旧 commit，后面那个再没人问。同一个问题因此也问候选：候选 `session_id` 所属任务的工作会话仍有 `finished_at IS NULL`（或回报的 `claimed_at` 早于某条工作会话的 `finished_at`）时该检查退回 `QUEUED`（`landingJudgedTooEarly`），由**上面同一条**领取守卫按 `session_id` 找到那个任务压住——不冻结、不开卡；工作已停止移动、而检查看的分支不是该任务工作结束所在的分支时（`checkSawTheFinishedBranch`，即 `workBranchEndedOn` 那条分支 ≠ 候选的 `source_ref`），候选**不冻结**：它被取代（`SUPERSEDED`，那条 job 自己仍是它当时答案的记录），同一事务按那条分支补一个候选（`refileCandidateBehindTheWork`），即 DONE 在工作停止移动之后写才会产生的那个候选。`CHECK_PROMOTION` 的作业行不带 `task_id`（0293）；`project_promotion.task_id` 总有值（`TASK_BRANCH` 候选带自己的任务，`PROJECT_BRANCH` 候选带最后落地的那个任务），落地主体不读它（§2.9），所以「点名」落在候选/卡上而不是任务行：退回事小、补排的那个候选 `source_ref` 指着成果所在的分支，卡最终问的就是它。`PROJECT_BRANCH` 候选不受影响：它的 `source_sha` 由平台在检查之前写死（取自 LANDED 作业的 `landed_sha`），检查按具名提交合并，没有解析竞态。用例见 `src/apiserver/src/projects/promotion-candidate-freeze.pg.spec.ts`。

**观测的入队（修订 29，§10.6 O-T1–O-T5）**：`OBSERVE_LANDING` 只由已提交事实入队，一律 `INSERT … ON CONFLICT DO NOTHING`，后来的触发并进已排队的那一条（J1 的排队索引）；观测哪些任务在领取时才算（O-J2）。五个触发点：O-T1 `AGENT_PUSH` 项目的代码任务冻结交付身份（与冻结同一事务，§10.5 O-L4）；O-T2 本项目任一工作会话的 `turnComplete` 提交、且本项目有待观测的任务（提交后边沿）；O-T3 本项目任一回执提交（`deliverProjectFactsAfterCommit` 末尾）；O-T4 owner 把交付方式改成 `AGENT_PUSH`（§10.5 O-L1 的同一事务）；O-T5 显式的观测门 `integration_observe`（§4.7）。补偿点见 §10.6；不加时钟（G3）。

**J-T2 的投递**：`HeartbeatResponse` 新增 `integrationJobs: IntegrationJobCommand[]`，由 `integration-job-relay.ts` 的 `dispatchIntegrationJobs`（照抄 `codex-reset-relay.ts` 的 `dispatchCodexResetCommand`）填入，每拍每个 runner 至多 2 条、串行键互不相同。结果与进度路由：

- `POST /runner/integration-jobs/:jobId/progress` `{ claimGeneration, leaseOwner, phase, upstreamMoved?: { from, to, commits? } }`；修订 12 加的可选字段与应答见 §2.2「J-T4（进度与取消协议）」
- `POST /runner/integration-jobs/:jobId/result` `{ claimGeneration, leaseOwner, state, phase, sourceSha, targetShaBefore, upstreamSha, mainSyncSha, testedSha, testedTreeSha, landedSha, landedTreeSha, aheadOfUpstream, sourceOnUpstream?, sourceFullyApplied?, checks, conflicts, errorCode, errorDetail, includedLandedShas?, upstreamMovedCommits? }`（最后一项是修订 12 的要求，见 J-T4）；修订 29 的 `OBSERVE_LANDING` 回报 `state: 'OBSERVED'` 并带 `observations`（§10.6 O-S3）

这两条路由与修订 12 的新路由都不写进 `contracts/runner-write-protocol.json`（写协议契约、不列路由；改它会让摘要校验拒绝已部署的 runner）；runner 门登记进 `RUNNER_ISOLATION_CASES`（§8.3）。修订 12 的新路由见 J-T4 段末的表。

```ts
interface IntegrationJobCommand {
  jobId: string; kind: 'LAND_TASK' | 'CHECK_PROMOTION' | 'LAND_PROMOTION'
                    | 'OBSERVE_LANDING';                    // 修订 29：命令另带领取时算出的待观测任务（§10.6 O-J2）
  claimGeneration: string; leaseOwner: string;
  workDir: string; remoteName: string; refAuthority: 'REMOTE' | 'RUNNER_LOCAL';
  targetRef: string; upstreamRef: string; sourceRef: string;
  sessionBaseSha?: string;                                  // LAND_TASK：源会话的 baseSha，rebase 的锚点
  promotion?: { sourceKind: 'PROJECT_BRANCH' | 'TASK_BRANCH'; sourceSha?: string;
                upstreamShaChecked?: string; mergeTreeSha?: string; candidateLandedShas: string[] };
  // 实现按扁平形状发（sourceSha / promotionSourceKind / upstreamShaChecked / mergeTreeSha 各自
  // 一个顶层字段），语义与上面这组相同：sourceSha 只在平台已经看过仓库时有值，否则由 runner 解析
  // 源 ref 并在结果里回报它解析到的提交。
  checks: Array<{ name: 'TASK_ACCEPTANCE' | 'MERGE_CHECK'; command: string;
                  expectedExitCode: number; timeoutSeconds: number }>;
  cancelRequested: boolean;                                 // 领取那一刻的取消请求（runner 在作业开头读）
  reportBeforePush?: true;                                  // 修订 12（要求）：只发给 v2 领取，推送前同步回报 PUSH（J-T4）
}
```

**J-T3a（把领取重投给仍持有它、仍在心跳的同一进程；修订 27，已实现）**：领取提交之后，它的 command 只随那一拍的应答走一次。应答没送到 runner，或领取提交后本拍又出错（`dispatchIntegrationJobs` 在领取之后还要读 J12 的 `unknownPushes`，那一步抛错时控制器回一个不带本拍作业的应答），作业就留在 `RUNNING`，持有它的是一个活着、照常心跳、却没在跑它的进程；J-T3 只接管别的进程的领取，所以在本条之前，只有这个进程重启才能放开串行槽。

- **事实**：心跳来自领取者本身——本拍的 `leaseOwner` 等于作业的 `claim_lease_owner`，同一 runner（`runner_id`），源会话的 workspace 仍在这台 runner 上；进程未 draining、声明了 `integration-job/v1`。作业仍 `RUNNING`，§7.2 V6 判当前领取 `LEASE_EXPIRED`（上次回报距今超过租约 10 分钟，且不在本机锁上排队），并且领取是 v2，或领取之后从未回报过（`heartbeat_at <= claimed_at`）。这两种领取在 V6 下的时限都是租约：v2 领取一向如此，从未回报的 legacy 领取还停在领取写下的 FETCH。
- **动作**：`dispatchIntegrationJobs` 在领取任何新作业之前，把这条领取原样放进本拍的 `integrationJobs`：同一 `jobId`、`claimGeneration`、`leaseOwner`。command 由领取语句 RETURNING 的同一组列读出（`integration-job-relay.ts` 的 `HELD_CLAIM_COLUMNS`），并走领取之后的同一组步骤（`handOut`）：LS1 的会话行补偿点；没有 workDir 时按 `INTEGRATION_REPOSITORY_UNKNOWN` 结束；M-T11 授权复读，授权已撤回的按 M-T12 交回 owner；J12 的 `unknownPushes` 重新列出；`cancelRequested` 读当下的行。作业行不写，时间线不记事件；不占每拍至多 2 条的新领取，串行键计入本拍已取。读或交出失败只记日志，只少这一拍的这一条，本拍照常领取。
- **为什么同一代**：runner 只按 job id 去重（`runloop.go` 的 `integratingNow`，正是为心跳的至少一次投递准备的）：本进程没在跑的作业以原领取开始跑，在跑的被跳过。像 J-T3 那样换代（`claim_generation + 1`）的话，一个真在跑的作业会跳过新 command，它下一次回报却被 409 `STALE_CLAIM` 拒绝：v2 因此停下，作业空等一个租约；legacy 不读应答，照跑、照推送，结果被拒。J-T3 换代是为了挡住**已经不在了**的旧进程的回报，这里的进程还在心跳。
- **为什么不写行**：不续租，`heartbeat_at` 仍是最后一次回报，V6、X-E5 与放弃门（J-T10）读到的沉默不变。runner 若始终不接（比如 job id 卡在去重表里），X-E5 照常在 15 分钟后把它交给 owner。重投每拍重复，直到这条领取的回报续上租约为止。
- **为什么 legacy 领取只限从未回报**：legacy runner 不读进度应答，推送前也不同步回报。一次重投若与它某个长而静默的步骤结束赛跑（结果已写下、作业已离开去重表，应答才被读到），就会启动第二遍，而这第二遍在推送前谁也拦不住。从未回报的 legacy 领取还没走到第一步：它拿到本机锁后先报 FETCH，在那之前能结束它的只有开头的取消，以及工作目录不是 git 检出，两者都不推送。v2 领取的每次回报都有应答，作业写下后它 PUSH 前的同步回报会被拒，所以它的第二遍在推送之前就停。回报过、又沉默超过租约的 legacy 领取不重投，仍由 X-E5、放弃门或下一个进程的接管（J-T3）收口。
- **缘由**：2026-10-19 事故。runner workstation-gpu 的进程（lease owner `1a69cfb2-…`，0.1.232，未声明 v2）在 10-18 16:03:15Z 领取了一个项目合进 main 的 LAND_PROMOTION（`88cfd7e8`），此后一次也没回报（`heartbeat_at = claimed_at`）。进程一直活着，还在同一检出上跑完了别的 `refs/heads/main` 作业，那些作业要拿同一把 `integrationLock`，可见进程里没有在跑它。main 的串行槽被占 31 小时，后面 4 条提升排队，直到 10-19 23:35Z 重启 runner、新进程以 claim 2 接管。
- **测试**：`src/apiserver/src/projects/integration-job-lost-claim.pg.spec.ts`。

### 2.4 runner 上的执行（`LAND_TASK`）

新文件 `src/runner-go/integrate.go`。临时 worktree 建在 `_integrate-<jobId>`，结束即删，进入作业时也先删一次（被杀掉的进程会留下一个）。现状：目录在 `filepath.Dir(workDir)/_integrate-<jobId>`（`integrate.go:146`），即 workspace 工作目录的父目录（常常就是 `~`），与本句原来写的 `<worktreesDir>` 不符，GC 也扫不到它。修订 12 对实现的要求：把它挪进 worktreesDir（或让 GC 扫描它实际所在的位置）；worktree GC 今天把非 UUID 目录当作可删（`worktree.go` 的排除前缀里没有 `_integrate-`），所以 GC 必须排除**在跑作业**的 `_integrate-` 目录，只回收没有作业在用的那些。进程内按 `(repoRoot, targetRef)` 加锁；复用 `mergeLock` 只包住 J-S6 的推送与本地 ref 前移。检查命令用 `bash -lc` 在临时 worktree 里执行，环境是 runner 自己的环境（不带 agent 会话的环境），超时取 `task.acceptance_timeout_seconds ?? 3600` 与 `merge_check_timeout_seconds ?? 3600`。

| 步 | 命令与判定 | 失败出口 |
|---|---|---|
| **J-S1 FETCH** | `git fetch <remote> <target_ref> <upstream_ref>`；T0 = 远端目标 tip（`PROJECT_BRANCH` 线目标不存在时 T0 = U）；U = 远端 upstream tip；S = `git rev-parse refs/heads/<源分支>` → `source_sha` | fetch 失败 → `ERROR / FETCH_FAILED`；源分支不存在 → `ERROR / SOURCE_BRANCH_MISSING`；upstream 不存在 → `ERROR / BASE_REF_NOT_FOUND` |
| **J-S2 MAIN_SYNC**（仅 `PROJECT_BRANCH`） | U 是 T0 的祖先时什么都不合，base = T0。U 不是 T0 的祖先时，按源分支手里有什么分三支：**①** S 同时包含 U 与 T0、且 S ≠ U——源分支自己已经做过这次吸收（§3.1 M3）——不再合，base = T0，J-S4 走 MERGE 模式；**②** S 包含 T0，也包含某个 upstream 提交 U′（U′ 是 U 的祖先、且不在 T0 里，S 的 tip 也不恰好是 U′），但不含 U：在**源分支**上 `git merge --no-ff -m "Merge <upstream> into <source>" U`，合干净时这次合并就是 base（写 `main_sync_sha`，这一次吸收是作业自己做的），J-S4 走 MERGE 模式，进项目分支的树 = S + `U′..U` 的改动、旧 T0 仍是祖先；**③** 其余（S 不含 T0，或从没吸收过 upstream——`merge-base(S, U)` 落在 T0 里，或 S 的 tip 就是 U′）：照旧在 T0 上 `git merge --no-ff -m "Merge <upstream> into <target>" U` → M = `main_sync_sha`，base = M。S = U 不算吸收：它没有自己的东西，走 ③，由 J-S3 答 | 冲突 → `CONFLICT`（`phase = MAIN_SYNC`，冲突路径来自 `git diff --name-only --diff-filter=U`）：① 不合并，没有这一出口；② 的冲突说明 `U′..U` 真的改到了解法所在处；③ 的冲突照旧。② 还有一个 `ERROR` 出口：`git checkout --detach S` 失败 → `ERROR / SOURCE_BRANCH_MISSING`（源分支在 fetch 与这里之间消失）。**J-S3 的「已包含」仍对目标判**（`containedIn`：T0，或在 ③ 真的合出了 MAIN_SYNC 合并提交时的那个结果），不对 base 判：② 把吸收合进了源分支，那时 base 已经包含 S，照 base 判会错答 `ALREADY_LANDED`。② 的判定用到的 U′ 就是 `merge-base(S, U)` |
| **J-S3 已包含** | S 是**目标**（`containedIn`，见 J-S2 末）的祖先：S **等于会话记录的 base**（分支停在 fork 点，自己没有提交）→ `NOTHING_TO_LAND`（0300），并实测 S 是否 U 的祖先，报为 `sourceOnUpstream`（0346），`sourceFullyApplied = false`（0410）；否则 → `ALREADY_LANDED`。两者都不推送，丢弃 M（② 合出的 base 也一样丢） | |
| **J-S4 REBASE / MERGE** | fork = `git merge-base S base`；`git rev-list --merges fork..S` 非空，或 J-S2 判定源分支已吸收 upstream → **MERGE 模式** `git merge --no-ff S`（保住合并提交里的冲突解法；后一种 T0 是 S 的祖先，合出来的树就是 S 的树）；否则 `git rebase --onto base anchor S`：anchor 默认取 fork，仅 `sessionBaseSha` 非空、是 S 的祖先且不是 fork 的祖先时取 `sessionBaseSha`（会话 base 早于或等于 fork 时用 fork，避免重放 base 已有的提交）。结果 C = `tested_sha`。REBASE 的 C 就是 base 时什么都不推：要重放的提交全被当作「补丁已在上游」跳过，或本来就没有要重放的。这时答 `NOTHING_TO_LAND`（`phase = REBASE`），不 PUSH、不 VERIFY，实测 `sourceOnUpstream`，并报 `sourceFullyApplied` = 重放前 `anchor..S` 非空（0410；2026-10-09 一批这样的落地被记成 LANDED 并写了回执）。MERGE 模式不适用：合出的结果等于 base，只发生在 J-S2 把 upstream 吸收进源分支那条路上，那时推 base 就是落地 | 冲突 → `CONFLICT`（`phase = REBASE` 或 `MERGE`） |
| **J-S5 CHECK** | 组合树自带 `scripts/worktree-overlay.sh` 时先运行它（见下方「检查前的铺环境」），再在 C 上依次跑任务验收命令（有 `acceptance_command` 时）与合并检查命令（有配置时），逐条比对退出码 | 铺环境失败或超时 → `ERROR / CHECK_TREE_UNPREPARED`；任一退出码不一致 → `CHECK_FAILED`（什么都不推送） |
| **J-S6a 落地前核对** | `tested_tree_sha = git rev-parse C^{tree}`；要求 `HEAD = C` 且 `git status --porcelain --untracked-files=no` 为空（检查不得改动或提交已跟踪文件） | → `ERROR / CHECK_MUTATED_TREE` |
| **J-S6 PUSH** | REMOTE：`git push <remote> C:<target_ref>`（不带 force，只能 fast-forward）；RUNNER_LOCAL：`git update-ref <target_ref> C T0`。随后在 workDir 前移本地目标 ref（同 `rebaseFastForward`：目标在根 checkout 上时 `merge --ff-only`，否则 `branch -f`） | 非 fast-forward 被拒 → 回 J-S1，至多 2 轮 → `ERROR / TARGET_MOVED`；其他 → `ERROR / PUSH_REJECTED` |
| **J-S7 VERIFY** | `git fetch <remote> <target_ref>`；要求远端 tip = C 且 `C^{tree} = tested_tree_sha`；`landed_sha = C`，`landed_tree_sha` = 其树；`ahead_of_upstream = git rev-list --count U..C` | 不一致 → `ERROR / LANDED_TREE_MISMATCH`（不写回执） |
| **J-S8 REPORT** | 回报 `LANDED` 与全部字段 | 回报失败按 `mergeOutcomes` 的做法缓存结果重发，不重跑 git |

现状：runner 只在作业开头读一次 `cancelRequested`（`runIntegrationJob`），之后只在阶段边界尽力而为地回报、丢弃应答。修订 12 对实现的要求：v2 领取在 prepare 与检查期间按 J-T4 周期回报，从应答里读取取消；等待进程内锁是具名步骤（`step = WAITING_LOCAL_LOCK`，文案 `Waiting for another job on this runner`），铺环境是 `step = PREPARE`；v2 在 J-S6（以及 M-S4）推送前同步回报 PUSH，应答带 cancel 就杀掉检查、不推送。推送已经发生时，取消请求不能覆盖实际结果：已请求取消但 LANDED 的晋升如实记为 MERGED 并写回执，不能丢弃结果或记为 CANCELLED（M-T8）。任务验收命令原本在会话的活 worktree 里跑，包括未提交的改动；J-S5 在已提交的组合树上重跑，这两者的差异正是本步要抓的。

修订 12 对实现的要求：排空时，已领取、没有推送的作业通过有围栏的 release 门交回（J-T11），不再滞留 RUNNING、占着 J1——已实现（2026-10-17）：runner 停机时心跳持续到心跳派发的操作结束，操作预算到时停下仍在跑的作业并交还，全部在 170 秒的停机包络之内（`runloop.go`、`shutdown_drain.go`）；J-S8 与晋升的结果上报失败均缓存重发，直到确认接收或取得终态 / 失效围栏应答，不因重试 5 次而丢弃，也不重跑 git（`integration_result_spool.go`）。

**检查前的铺环境（J-S5、M-S3）**：组合树出自 git 对象，因此**没有 `node_modules`**。仓库自带 `scripts/worktree-overlay.sh` 时，检查之前先在树里运行它（会话 worktree 铺的就是同一个脚本、同一个路径，只有一份配方法），这样 `cd src/web && npx vitest run …` 这类「直接要 JS 依赖」的验收命令与 `bash scripts/run-pg-spec.sh …` 这类自带铺设的命令在组合树上同样能跑。它只写 gitignored 路径（`node_modules/`、`dist/`）：既不进 `C^{tree}`，也不出现在 J-S6a 的 `git status --porcelain --untracked-files=no` 里，所以「落地的树 = 测过的树」不受影响——被判定的始终是提交，铺环境只是让检查跑得起来。没有这个脚本的仓库跳过本步；脚本失败或超时 → `ERROR / CHECK_TREE_UNPREPARED`：检查从未在它能跑的树里跑过，那不是对工作的判决。

### 2.5 回执与派发下游

**J8（回执）**：`receiveResult` 在同一事务里，通过新方法 `MergeReceiptService.fromIntegrationJob(tx, job)` 为 `LANDED` / `ALREADY_LANDED` 写回执；`NOTHING_TO_LAND`（0300）写回执的形状相同（`result = ALREADY_MERGED`、`target_sha_after = NULL`），但**只在该任务没有任何 work 会话报告过工作时**才写：那种情况下「本任务没有东西可落」正是 J9 释放下游所依据的事实；反过来，任务的工作在**另一条分支**上时这一行不写回执——回执照写就等于宣称这份工作在那个目标上，而这正是 2026-09-23 假回执骗过晋升卡的那句假话——同时往任务上写一条评论（`task_comment`，同一个事务）留下可见信号。

**全部已应用的 `NOTHING_TO_LAND`**（`sourceFullyApplied = true`，0410）说的是另一件事：这条分支带着任务自己的工作，目标上已经全部有了。它像 `ALREADY_LANDED` 一样受 J-T1e 的两条约束：判得太早的不落终态，退回 `QUEUED`；工作结束在别的分支上的，给那条分支补排下一代，不写回执。回执形状同上，只在**除这条分支以外**没有会话报告过工作时写。写下回执时，同样解决该任务的集成类待办。给任务的评论说明它的提交已在目标上，不用空分支那句话。

`NOTHING_TO_LAND` 与 `ALREADY_LANDED` 的另一个入口是**旧 runner**：早于 0300 的二进制没有这个状态可报，它对同一种分支（tip 等于该会话的 `base_sha`）报的仍是 `ALREADY_LANDED`。控制面在自己的行里就有这个事实的两半（`source_sha` 与 `session.base_sha`），因此收到的 `ALREADY_LANDED` 若满足该等式，落库时同样写成 `NOTHING_TO_LAND`——旧二进制不能替控制面写下那句正面结论。

| 列 | 取值 |
|---|---|
| `session_id` / `task_id` / `project_id` | 作业的 `session_id` / `task_id` / `project_id` |
| `result` | `MERGED` / `ALREADY_MERGED` |
| `source_branch` / `source_sha` | 源分支短名 / `source_sha` |
| `target_branch` | `target_ref` 的短名 |
| `target_sha_before` / `target_sha_after` | T0 / `landed_sha`（`ALREADY_LANDED` 时为 NULL） |
| `rebase_base_sha` | base（M 或 T0） |
| `recorded_by` | `RUNNER` |
| `detail` | `{ integrationJobId, testedTreeSha, landedTreeSha, mainSyncSha }` |
| `idempotency_key` | 默认派生（`mr:v1` 会话 + 源 SHA + 目标分支 + 结果） |

回执表没有树 SHA 列，树的相等由 J2 在作业行上保证。任务不在收敛管理下（`task_checkpoint` 零行），`session_merge_receipt_checkpoint_accepted_trg` 不拦。

**观测回执**（修订 29，§10.6 O-R1）：`OBSERVE_LANDING` 看到交付身份的提交在线上时，结果事务为该任务写一条回执：`result = ALREADY_MERGED`、`recorded_by = RUNNER`，源取交付身份（`delivered_branch` / `delivered_sha`），`target_branch` 为看到它的那条线的短名（在 upstream 上就是 upstream），`target_sha_after = NULL`，`detail = { integrationJobId, observed: true }`；其余列见 O-R1。它与上表的回执一样经 `MergeReceiptService` 写，所以 M-T13 的退役、J-T5 的落地边与 J10 的派发都照常。空分支（`delivered_sha = delivered_base_sha`）照上面 `NOTHING_TO_LAND` 的规则（§10.5 O-L7）。

**J9（依赖谓词）**：`dependenciesSatisfiedSql` 与 `computeDependencyState` / `dependencyFactsFor` 的「前置已满足」改为：

> 链尾任务 `status = DONE` 且核验闸门打开（与今天相同），**并且**以下三者之一成立：前置所在项目 `lineStarted` 为假；前置不是代码任务（`isCodeTask` 为假）；前置在其项目集成线上的任务级落地 ∈ {`ON_INTEGRATION_LINE`, `ON_UPSTREAM`}。

`AUTO_RUN_READY_SQL` 与 `manualRunnableTaskSql` 经 `dependenciesSatisfiedSql` 自动继承。谓词只读 `project_codebase` 与回执，不读作业表，所以依赖任务（§9 的 T7）不依赖集成作业任务。

**等待必须有生产者**（修订 29，§10.3 O5）：谓词不变。前置已 DONE、还没落地、挡着下游时，此刻要么有在途的作业会给出答案，要么有一条 OPEN 待办在某人面前（§10.7 的 `LANDING_UNOBSERVED`；任务落地类集成待办在这时不能空关，O-X1）。拒绝文案说出它在等什么（英文原句见 §10.9）：有 OPEN 的 `LANDING_UNOBSERVED` 时点名它，有在途作业时保留原句，两者都没有时（按 O5 不该出现）写原句并记一行 `warn`。

**J10（派发边沿）**：`MergeReceiptService.deliverProjectFactsAfterCommit` 末尾新增 `TasksService.dispatchDependentsOf(taskId)`：回执提交是下游开工的事实，`autoRunWhenReady = true` 的下游在这里经 `execute` 的 `dep:<taskId>:<epoch>` 门开工。`dispatchDependentsAfterCompletion` 在 DONE 边沿照旧调用，前置有落地要求时谓词不满足，自然跳过。`TasksService` 的 60 秒 sweep 读同一谓词，属于 G3 第 2 条的重投，不新增职责。

**J11（其他提交后边沿）**：同一回执边沿上还有 §3.4 M-F1（晋升候选）、§6.7 B3（blocker 自动解除）。三者都从已提交行重新推导；进程死在边沿之前时，补偿点是下一条回执或下一次任务写入（与既有 door 相同），以及 §7 读模型把「已落地但下游未开工」显示为 Ready。

### 2.6 失败

**J12（`error_code` 闭集）**：`FETCH_FAILED`、`SOURCE_BRANCH_MISSING`、`BASE_REF_NOT_FOUND`、`TARGET_MOVED`、`PUSH_REJECTED`、`CHECK_TREE_UNPREPARED`、`CHECK_MUTATED_TREE`、`LANDED_TREE_MISMATCH`、`PROMOTION_TREE_NONDETERMINISTIC`（§3）、`RUNNER_DRAINING`、`INTEGRATION_REPOSITORY_UNKNOWN`（入队前拒绝）；修订 12 加三个（要求）：`RUNNER_LOST`、`PUSH_OUTCOME_UNKNOWN` 与 `PUSH_REPORT_UNREACHABLE`（v2 领取的 PUSH 前同步回报得不到应答，没有推送，J-T4）；修订 29 加一个：`WORK_COMMIT_MISSING`（`TASK_BRANCH` 源按提交指名，领取的 runner 本机没有这个提交，§10.5 O-L5），此后 `SOURCE_BRANCH_MISSING` 只剩 `LAND_TASK` 与 `PROJECT_BRANCH` 源会答。**写哪一句按作业种类分支**（放弃 J-T10、J-T9 的超时重试与 M-T13 的退役共用；本文其余各处只引用）：`CHECK_PROMOTION` 从不推送（`promoteOnce` 在 M-S4 之前就答 `READY`，`integrate.go:716-720`），一律写 `RUNNER_LOST`（`nothing was pushed`），不看领取协议；`LAND_TASK` / `LAND_PROMOTION` 才看推送界线——当前领取是 v2、且 `push_reported_generation IS NULL`（本作业没有哪次领取记下过、或可能做过推送）时写 `RUNNER_LOST`，文案 `nothing was pushed`；其余一律写 `PUSH_OUTCOME_UNKNOWN`，文案 `may have been pushed`——这两个作业的 legacy 领取一律后者，因为它的 PUSH 回报是尽力而为，服务端没记下 PUSH 证明不了没推送；被接管的上一代领取同理（这一列留着它那一代的领取）。判定实现为一个按作业种类分支的函数，放在 `endTimedOutLanding` 里（`project-integration-job.ts:776`）；J-T9 的重试门与 M-T13 的退役都从那里取同一个答案。新码不需要迁移：`error_code` 没有 CHECK（0281:85），闭集是 `INTEGRATION_ERROR_CODES`（`project-integration-job.ts:72-88`）加本条文字，实现同步改前者；结果路由不按这个闭集校验（`integration-job-relay.ts:1017` 原样收下）。

Abandon（修订 12 对实现的要求）按 J12 的那条规则写结果：v2 领取且 `push_reported_generation IS NULL` 才写 `ERROR / RUNNER_LOST`（文案 `nothing was pushed`），其余一律写 `ERROR / PUSH_OUTCOME_UNKNOWN`（文案 `may have been pushed`），晋升改为 BLOCKED，不能声称未推送；候选只有在作业证明没有推送时才写 CANCELLED（M-T10）：QUEUED 时被取消；被叫停的领取没有推送就结束——它自己报的 CANCELLED（J-T12），或没有推送的失败（`CHECK_FAILED`、`CONFLICT`、推送之前或推送被拒的 `ERROR`）；或结束为 `RUNNER_LOST`。**现状：修订 25 记下的这处偏差已修正**（修订 26，`ef3f9c705`）：`applyPromotionJobResult`（`project-promotion.service.ts`）带取消请求的那一支按本条判。被叫停的 `LAND_PROMOTION` 以不能证明没有推送的结果结束时，经 `blockPromotion` 写 `BLOCKED`，与 `applyCancel` 对已超时作业当场结束的那一支相同。这种结果有两种：平台写的 `PUSH_OUTCOME_UNKNOWN`（J-T10 放弃一个已被叫停（`cancel_requested_at`）的领取）；legacy 领取在推送界线之前被叫停（legacy 的界线只看 `PUSH` / `VERIFY`，runner 只在开头读一次取消），照样推送之后在 `VERIFY` 报的 `ERROR`（`LANDED_TREE_MISMATCH`）。其余结果（它自己报的 CANCELLED、没有推送的失败、`RUNNER_LOST`）仍写 `CANCELLED`。两种结局都不开失败待办（J-T8）。同一 serial_key 上下一条作业检查 `tested_sha` 是否已经是目标的祖先；是则在该作业的结果事务里补写回执并关联那次未知结果，旧 ERROR 行仍不可变（J4）。补写的回执 id 记进这次修复它的作业的 `receipt_ids`。被追回的是 `LAND_PROMOTION` 时（`integration-job-relay.ts#planUnknownPushRepairs` → `project-promotion.service.ts#recoverPromotionPushReceipts`），补写的是 M9 的回执：候选 `included_task_ids` 里每个任务的产出会话各一条（同 M9 的写法，会话已不在的不写），`result = MERGED`、`target_branch` 为 upstream 短名、`target_sha_after` 为那次的 `tested_sha`，`detail` 带那次作业的 `integrationJobId` 与 `recoveredUnknownPush: true`。**候选保持它此刻的状态（`BLOCKED` 或 `CANCELLED`），不改成 `MERGED`**：这条修复路径只写回执，不改写候选行。按本条，`PUSH_OUTCOME_UNKNOWN` 留给候选的是 `BLOCKED`（放弃与 M-T10 都这样写）。`BLOCKED` 是活状态，修复之前可能已被别的门移动：§4.7 H1 的候选重检（`requeuePromotionCheck` → `CHECKING`）、owner 的 Not now（现状：`applyDecline` 也收 `BLOCKED`，写 `DECLINED`；M-T5 只列了 `READY`）、被取代（M-T6 的 `supersedeLiveCandidates`，`TASK_BRANCH` 候选还有 M-T13 的 `retireCandidatesLandedByReceipt`，都写 `SUPERSEDED`）。没有哪扇门把 `BLOCKED` 直接写成 `CANCELLED`：候选是 `CANCELLED`，是因为重检之后它重新经确认排了下一代 `LAND_PROMOTION`，而 owner 的 Cancel 把那一代叫回了（M-T10；`applyCancel` 只收 `CONFIRMED` / `RECHECKING`，当场只在作业还 QUEUED 或以 `RUNNER_LOST` 结束时写 `CANCELLED`，仍在回报的那一代由它自己报的 CANCELLED 结算，J-T12）。修订 26 之前还有一条路径把这种候选写成 `CANCELLED`，即上文现状注里的那一支，现已修正。候选里的任务经这些 M9 回执读作已落地（§1.4 任务级 `ON_UPSTREAM`，判据随之可读 `LANDED`）；候选本身不归这条修复路径处置。放弃与正常 apply-result 共用结果事务，不靠读时的 LEASE_EXPIRED 自动结束作业。J-T9 的超时重试用同一条判定（J12），本段不复述。

`CONFLICT` → `INTEGRATION_CONFLICT`，`CHECK_FAILED` → `INTEGRATION_CHECK_FAILED`，`ERROR` → `INTEGRATION_ERROR`，负责人默认协调会话（§4.2）。待办行与作业终态同一事务写下；目标分支没有变动（J-S6 之前的失败）或已核对不一致（J-S7），两种情况都写进待办的 payload。

### 2.7 读模型

任务行的集成状态（§7.3）从「该任务最新 generation 的作业 + 它的 OPEN 待办 + 任务级落地」派生：

```ts
type TaskIntegrationState =
  | 'NOT_APPLICABLE'        // 不是代码任务，或项目没开始集成
  | 'QUEUED' | 'RUNNING'
  | 'CONFLICT' | 'CHECK_FAILED' | 'ERROR'
  | 'AWAITING_OWNER'        // MAIN 线：检查通过，等晋升确认
  | 'ON_INTEGRATION_LINE' | 'ON_UPSTREAM';
interface TaskIntegrationView {
  state: TaskIntegrationState; since: Date | null;
  handler: 'COORDINATOR' | 'OWNER' | null; openItemId: string | null;
  jobId: string | null; checksRunningForMs: number | null;
  landTask?: LandTaskIntegrationView | null;
}
```

### 2.7a 当前 LAND_TASK（任务页与项目集成视图）

任务 DONE 不等于已落地。`TaskIntegrationView.landTask` 是该任务**最新 generation** 的
`LAND_TASK`（按 generation、created_at、id 取最新，只取本项目线上的作业），由作业行自己的字段给出；
它与上面按「回执 → OPEN 待办 → 作业」派生的 `state` 并列，**不参与**那条优先级：较新的
generation 排队或失败，不会把已有回执改回未落地。三处读同一个函数
（`project-task-integration.ts` 的 `readTaskIntegrationViews`）：`GET /tasks/:id` 的
`integration`、`GET /projects/:id/tasks` 每行的 `integration`、`GET /projects/:id/integration`
的 `landTasks[].integration`。

```ts
interface LandTaskIntegrationView {
  jobId: string;
  state: IntegrationJobState;              // QUEUED / RUNNING / LANDED / CHECK_FAILED / CONFLICT / …
  phase: IntegrationJobPhase | null;       // runner 当前步骤，或停下的那一步
  generation: string;                      // 十进制字符串
  queuedAt: Date;                          // 入队（created_at）
  startedAt: Date | null;                  // 首次认领（started_at）
  heartbeatAt: Date | null;                // 认领进程最近一次心跳 / 进度 / 结果
  finishedAt: Date | null;                 // 终态写入
  targetRef: string;                       // 入队时冻结的完整目标 ref
  waitMs: number;                          // 排队时长，见下
  blockingReason: { code; summary; jobId?; openItemId? } | null;
}
```

`waitMs`：QUEUED 时为 `now - queuedAt`，一直累计；否则为 `(claimedAt ?? finishedAt) - queuedAt`，
即到最近一次认领为止。太早认领、被送回 QUEUED 的作业（§2.6 judged too early）清掉认领但保留
`started_at`，所以排队时长从入队算起，不从那次中断的启动算起。

`blockingReason` 只在 QUEUED 与三种失败终态出现，由服务端给出 `code` 与一句可直接显示的
`summary`；客户端只读它，不从任务 DONE、也不从异常卡是否存在去推断原因。QUEUED 的原因按
`claimOne`（J-T2）的领取条件、依此顺序取第一条不满足的——**与领取逐条一致**：T15 曾让读者的
`WAITING_MAIN_SYNC` 豁免新一代正在接手的旧冲突卡（领取照扣），T17 撤掉了那条豁免，读者照实报
`WAITING_MAIN_SYNC` 并点名正在重落地的那一代（M2 末段）：

| code | 条件 | summary 要点 |
|---|---|---|
| `CANCELLING` | `cancel_requested_at` 非空，领取跳过它。只对 legacy 与历史行有效：修订 12 之前的取消门（以及部署过渡期里旧版 apiserver）把 QUEUED 的取消只记成这一列；按 J-T8，QUEUED 被取消直接落 CANCELLED，回填之后不再出现 | 不会启动 |
| `WAITING_TASK_WORK` | 任务仍有未结束的工作会话（J-T1a） | 等待落地：工作会话还在跑，分支还会动 |
| `WAITING_MAIN_SYNC` | 同 serial_key 上另一任务的 MAIN_SYNC 冲突待办仍 OPEN（M2；M3 豁免冲突任务自己的后续 generation）。不看 `handling_job_id`：被新一代接手的旧卡同样扣住，读者与领取报同一件事（T17） | 等待项目线同步：点名那次落地；若这一格正被新一代接手，再点名那一代（「— a new landing (generation N) is resolving it」）。附 `jobId`、`openItemId` |
| `WAITING_RUNNER` | 工作会话所在 workspace 没有 runner；runner OFFLINE 或静默超过 90 s（与会话队列同一阈值）；DRAINING；心跳无租约或未声明 `integration-job/v1` | 等待 runner：点名 runner 与具体原因 |
| `WAITING_SERIAL_SLOT` | 同 serial_key 已有 RUNNING 作业（J1） | 等待落地：点名正在跑的那次落地或晋升；附 `jobId` |
| `WAITING_DISPATCH` | 以上都不成立 | 等待落地：下一次心跳认领 |

阻塞作业属于其他账号时（serial_key 只是仓库 + ref），只给出原因，不给出它的 id 与标题。
失败终态：`CONFLICT`（区分 MAIN_SYNC 与 REBASE / MERGE，附冲突文件数）、`CHECK_FAILED`（第一条
未通过的检查及其退出码或超时）、`ERROR`（阶段与 error_code）。

**项目集成视图的当前 LAND_TASK**（`ProjectIntegrationView.landTasks`）：取每个任务的最新
generation，列出 (1) QUEUED / RUNNING 的，不论回执；(2) 停在 CONFLICT / CHECK_FAILED / ERROR、
任务仍为 DONE、且之后没有回执落地其工作的；(3) 最近一次 LANDED / ALREADY_LANDED 的那一个。顺序：
RUNNING、按入队顺序的 QUEUED、按结束时间倒序的失败、最后一次落地。数量受队列与失败数约束，
不随项目历史增长。

页面：任务页在状态徽标旁另起一枚落地徽标（如 `Done` · `Waiting to land`），并在 Landing 段落写
`Task DONE`、落地状态、generation、原因与目标 ref、排队时长和四个时间；落地 RUNNING 时每 4 s、
QUEUED 时每 15 s 重读。修订 12 对实现的要求（新字段一律可选）：项目集成行下列出的当前落地带
`landingSessionId` 时链接到所属落地会话，没有时照旧链接到任务；任务页的每一代也带 `landingSessionId`。
两处均为只读。在途尝试的 owner 门（叫停、放弃）只出现在三处，三处是同一组用户门（§4.7）：落地
会话页头；修订 10 的合入卡（晋升沿用 M-F3 的 Cancel，租约过期后加 Abandon）；X-E5 待办（Abandon）。
协调会话里只留修订 10 的那一行，不画门。PROMOTION_APPROVAL 与 owner-only 的门不变，这个读模型也
不写任务状态。落地会话页沿用上面的轮询节奏，不加 `landing.updated`（项目分组上线时也没有加事件，
§2.9 LS6）。`blockingReason`（LAND_TASK 的今天已在 `project-task-integration.ts` 实现，含跨账号只给
原因）推广到 CHECK_PROMOTION、LAND_PROMOTION 与本机锁等待（要求），跨账号仍只给原因、不暴露
阻塞作业的 id 或标题。

### 2.8 测试

`scripts/acceptance/project-integration-line.sh`（判据 6；真实 apiserver + runner + 本地 git 仓库，检查命令用可控脚本）。本任务创建该脚本，结构为每个用例一个 `case_<name>` 函数，文件末尾的 `CASES=(…)` 登记，后续任务追加（§9.2）：

1. `case_clean_lands_and_dispatches`：干净 → `LANDED`、回执 `MERGED`、`autoRun` 下游开工
2. `case_conflict_opens_item_target_untouched`：冲突 → `INTEGRATION_CONFLICT` 待办、目标分支 tip 不变
3. `case_check_failed_opens_item_nothing_lands`：检查失败 → `INTEGRATION_CHECK_FAILED` 待办、未落地
4. `case_two_done_serialize_tree_equals_tested`：两条任务同时 DONE → 串行落地，两条作业都满足 `landed_tree_sha = tested_tree_sha`

另建议：`src/apiserver/src/projects/integration-job-relay.pg.spec.ts`（J-T2 / J-T3 租约与 `STALE_CLAIM`）、`integration-enqueue-done-sites.spec.ts`（J-T1a 普查）、`src/runner-go/integrate_test.go`（J-S2 / J-S4 MERGE 模式 / J-S6a；M3 的两侧：已吸收 upstream 的源分支按 MERGE 落地、树等于源分支，缺任一 tip 的照旧报 MAIN_SYNC 冲突）。

### 2.9 落地会话（修订 12）

一个落地会话是一个落地主体的地址、记录与实时状态；作业仍是「一行 = 一次尝试」，平台执行 git 与检查，判断仍归协调会话或 owner。以下 LS1–LS8 对应设计文档 `docs/landing-session-design.md`（§0.1 优先于 §0，§0 优先于正文）§2.9 的 L1–L8，编号加 LS 以区别 §1 的集成线规则。

**读法**：本节整节是修订 12 对实现的要求——db69d833b 上还没有落地主体、落地会话行、事件表与日志表，也没有 `session.kind`。分四期落地（设计文档 §0 第 15 条与 §0.1「任务调整」）：第 1 期缺陷修复、以事实为准的撤销、续租、推送界线与 blockingReason；第 2 期主体、判别列与会话行（插入先不启用，守卫与普查装好后再启用，§0.1 第 26 条）；第 3 期事件、日志与 outputIdle 活性；第 4 期各端页面、入口与 Abandon。写「现状」的句子描述 db69d833b 上的代码。

**主体按线区分**：只以 `task_id` 或 `promotion_id` 标识主体，永远不从 `project_promotion.task_id` 判断归属——它总有值：`TASK_BRANCH` 候选带自己的任务，`PROJECT_BRANCH` 候选带最后落地的那个任务（`ProjectPromotionService.considerCandidate`）。

| 线与工作 | 落地主体与分节 | 结案事实 |
|---|---|---|
| PROJECT_BRANCH：LAND_TASK | TASK 任务段：一个任务从 DONE 到落上集成线；DONE、`integration_retry`、owner 重跑门（0380）、线开始补排、J-T1e 补排的各代都是同段的尝试 | 见下「任务段结案」 |
| PROJECT_BRANCH：合入 main | PROMOTION **一轮合入**：以上次 MERGED / DECLINED / CANCELLED 之后首候选的 `promotion_id` 标识；该候选和随后被取代、重新提交的候选及 CHECK_PROMOTION / LAND_PROMOTION 各代都归同一轮，标题 `Merge project/<id> → main · #<episode>` | 下一次 MERGED、DECLINED 或 CANCELLED；SUPERSEDED 只是一节，不结案 |
| MAIN：TASK_BRANCH 候选 | TASK 任务段：`task_id` 标识，同任务的所有候选（包括被取代、重新提交的）和其检查、合入作业都在同段，标题 `Land · <task> → main` | 见下「任务段结案」；候选被取代、拒绝或取消不单独结束任务段（被回执退役的那一种例外，见下第 5 条） |

**任务段结案**（LS3 在主体行锁下复核；段内还有更新的在途尝试时，等它终态再判）：

1. 任务的成果落上这条线：LANDED（MAIN 线为候选 MERGED）、没有留下工作的 ALREADY_LANDED、NOTHING_TO_LAND → `settled_as` 取同名值，会话 `SUCCEEDED`。
2. 任务被取消（CANCELLED）或删除 → `settled_as` 为 `CANCELLED` / `DELETED`，会话 `CANCELLED`。
3. MOVE_TASK（0386、0389）把任务移出本项目 → 它在原项目的未结段结案为 `CANCELLED`（`settled_as` 与会话都是），移入的项目按那边的入队另开段。
4. 段的待办由修复任务解决：协调会话建修复任务（`task.fixes_open_item_id`，0379），不重开原任务，修复任务的工作落在它**自己的**任务段里；之后段内最后一条 OPEN 的集成类待办以 `RESOLVED / HANDLED` 关掉（`open_item_resolve`；修订 13 起修复落地时平台把这条待办再送到协调会话，§4.4 X-D4 第 5 条），段内既没有落地、也没有在途尝试 → `settled_as = HANDLED`，会话 `CANCELLED`（这一段没有把原任务的工作放上线；时间线写明由哪个修复任务、谁处理）。
5. 卡片之外已经合入：M-T13（`retireCandidatesLandedByReceipt`，`8297b18a3`）把候选写成 `SUPERSEDED` 时，回执写下就是结案事实——`settled_as` 按回执结果取 `LANDED`（`MERGED`）或 `ALREADY_LANDED`（`ALREADY_MERGED`），会话 `SUCCEEDED`。这次退役与回执同一事务，不另找落地作业；它与被取代 / 拒绝 / 取消不同：那三种只是一节，工作没有落到 main。

不结案的事实：任务重开（J-T8 叫停在途尝试，再次 DONE 的那一代仍在同一个任务段）、任务被写成 FAILED、失败、重试（含 owner 重跑门）、接管、叫停一次尝试（段显示 `Stopped by you · not landed`）。段结案之后同一任务再有一代入队（再次 DONE、`integration_retry`、owner 重跑门），开新 episode，标题带 `(#2)`。

**数据与两处选型**：新增 `project_landing`，保存 project / owner / codebase、subject（TASK / PROMOTION）、`task_id` / `promotion_id`、episode、预生成的 `session_id`、`opened_at`、`settled_at`、`settled_as`（闭集 `LANDED`、`ALREADY_LANDED`、`NOTHING_TO_LAND`、`MERGED`、`HANDLED`、`DECLINED`、`CANCELLED`、`DELETED`）。未结主体按项目与线唯一：每任务一个未结任务段，PROJECT_BRANCH 每条线一个未结合入轮；后续候选通过作业的 `landing_id` 归入已有轮，不按候选另开会话。主体行是 rank 60 子行，与入队同事务；`project_landing` 的 `session_id`、`task_id`、`promotion_id` 与 `job.landing_id` 都是无外键的历史引用（理由同 §2.1 的 `task_id` / `session_id`）。`job.landing_id` 只在 INSERT 时写，既不改源工作会话的 `job.session_id`，也不更新终态作业（J4）。迁移编号以实施时 main 最新号为准（2026-10-07 为 0392），写之前扫一遍各分支与 worktree。

- **记录载体选 `project_integration_job_event`**，不把历史追加到 RUNNING 作业行。理由：只追加的事件保留步骤起点、每次领取 / 接管、每个 round 与推送被拒事实，不会因覆盖当前进度而丢失历史；也不用更新终态作业——J4 守卫拒绝改终态行，追加到作业行的历史在作业结束那一刻就再也写不进去。当前步骤仍在作业行，供读模型直接读（§2.1 的新列）；事件不写 `run_event`，不产生 agent 转录。
- **会话判别选 `session.kind`**：闭集 `CONVERSATION | LANDING`，常量默认 CONVERSATION，既有会话沿原路径。理由：它直接表达驱动者，所有引擎入口与按 status 扫描会话的路径可以统一守卫；`source` 继续表达来源，不兼任驱动者（merge-repair 的 `source` 先例说的是会话从哪来，不是谁驱动它）。CHECK 先以 `NOT VALID` 加上，再单独 `VALIDATE CONSTRAINT`：直接加 CHECK 会在最热的 session 表上全表扫描并持有 ACCESS EXCLUSIVE 锁；分两步时加约束只改目录，VALIDATE 只持 SHARE UPDATE EXCLUSIVE，不挡读写。**线上字段名不叫 `kind`**：web 的列表条目写 `{ ...session, kind: 'session' }`（`WorkspaceView.tsx:3130`、`:3135`；`projectMerge.ts:234` 的 `ProjectTimelineItem`），同名字段会被覆盖。REST、MCP 与实时摘要一律叫 `sessionKind`；Prisma 字段名同样避开 `kind`（例如 `sessionKind @map("kind")`），免得被原样展开进响应。新增的线上字段一律可选。

**LS1（打开与补偿）**：落地主体在入队时打开：入队事务创建或复用未结主体，预生成稳定的会话 uuid。会话行在领取提交后插入：最晚在领取语句提交后、command 交出前由 `ensure` 完成，所以 QUEUED 时已被取代的候选不会生成会话行。`ensure` 在自己的事务里执行，不走 `SessionsService.create`，不进入领取语句。事实驱动的补偿点为心跳派发、领取后、进度回报与结果提交后；只对已领取主体补插，不能凭时钟或仅有 QUEUED 的候选开会话。行尚未插入时，GET /sessions/:id 与 `session_get` 通过 `project_landing` 的预生成 id 渲染 landing 视图，链接仍可到达。

会话行的取值：

| 列 | 值 | 为什么 |
|---|---|---|
| `kind` | `'LANDING'` | 判别列（线上 `sessionKind`） |
| `status` | 只取 `AWAITING_INPUT` / `SUCCEEDED` / `CANCELLED`（见下表） | 没有 runner 的 RUNNING 行会被 reaper 判为掉线、强制终结并挂自动重试；FAILED 会触发 macOS 通知与自动重试 |
| `starts_task_work` | `false`，显式写 | 列默认值是 true，会让它进入领取守卫与 `isCodeTask` 的读 |
| `assigned_runner_id`、`task_id`、`context_task_id`、`parent_session_id`、`root_session_id`、`last_turn_at` | NULL | 没有 runner 就到不了任何 runner 的队列；`root_session_id` 非空会让它在成员关系里获得 CHILD 归属，并计入派生树的配额；`last_turn_at` 为空就不会成为 wiki 的 session_settled 事实 |
| `title` / `title_managed_by_project` | 服务端生成（`Land · <task>`、`Merge project/<id> → main · #<n>`）/ `true` | 标题由服务端管理：自动起标题等路径只改 `title_managed_by_project = false` 的行 |
| `engine` | `NULL` | 落地会话没有引擎。`session.engine` 的 CHECK（0414）只收六个已知引擎、0426 又加 `cursor`，`'orbit'` 不在其中；这一列可空（0414:24-26），所以必须写 NULL，不要为了「看起来完整」写占位值 |
| `creator_id` | 项目 owner（`project.owner_id`） | NOT NULL、无默认（`Session.creatorId`）；`SessionsService.create` 的每条路径都显式写它（`creatorId: ownerId`），`ensure` 不走 create，也必须写 |
| `dispatch_origin` / `run_source` | `USER` / `MANUAL` | 与 `SessionsService.create` 的默认值相同，没有读者对它们特殊处理。不写 `PROJECT_COORDINATOR`：wiki、会话移动与判断会话的读者把它当协调会话或判断会话，LS8 也不让落地计入协调会话的派发与花费；也不写 `LEGACY_SWEEP` / `TASK_LIST_AUTO`，那是任务派发的来源。没有 `task_id`，0195 / 0212 的派发授权触发器对它直接放行 |
| `provider` / `provider_builtin` | `'orbit'` / `true` | 平台保留值，不能落回默认 engine。`orbit` 今天不是保留 slug（`providers/provider-slug.ts:7-10` 的 RESERVED 只有内置 engine 与 kimi 墓碑）：实现既要把它加进 RESERVED，又要照 0426 为 `cursor` 做的那样用迁移保留它——把 `model_provider` / `provider_pool` / `provider_slug_alias` 三处已有的 `orbit` 挪到第一个空闲的 `orbit-N`，连同 `session.provider`、`task.provider`、`task_route_decision` 与绑定计划里的引用一起改写，再插入内置守卫行与触发器，让旧副本也占用不到这个 slug。只改 `provider-slug.ts` 不够：存量行与旧副本仍能写下它 |
| `prompt` | 一行固定描述 | 永不投递 |
| `workspace_id` | TASK 主体取源工作会话的 workspace；PROMOTION 主体取 `project.coordinator_workspace_id` | 晋升的「源会话」只是最后落地的那个任务的会话，与这一轮合入无关 |

prompt **永不投递**：没有 initial 轮、不做准入与 sign-in 预检、不建会话 worktree、不领取 runner。status 只表示容器生命周期：

| 容器生命周期 | session.status |
|---|---|
| 尚未结案 | AWAITING_INPUT：只表示容器未结案，绝不表示等待 owner 输入或 engine 轮次 |
| 落地成功结案 | SUCCEEDED，并写 completed_at |
| 取消、删除、移走、待办被处理而未落地，或一轮合入被拒绝 / 取消而结案 | CANCELLED，并写 completed_at |

绝不写 RUNNING / FAILED；实时阶段、错误与负责人都从 landing 视图读取。**LANDING 会话不发 `session.created` / `session.updated`**：插入、结案与 landing 视图的变化都不走会话的实时通道，旧客户端因此既收不到这些行，也不会为它们弹本地的「Session failed」通知；列表与页面按 §2.7a 的节奏轮询读它们。

**LS2（记录与锁序）**：`project_integration_job_event` 是 rank 60 的只追加账本，按 `(job_id, key)` 幂等。入队、回报、结果、取消、放弃与 release 的事件和相应作业门同事务提交；领取 / 接管的事件在领取语句提交后的独立事务里，由已提交的领取事实补写。新写入须登记 db-write-inventory，锁序以 `lock-order.ts` 为准。

- **现状**：领取语句 `claimOne`（`integration-job-relay.ts:311-387`）的候选 CTE 先 `JOIN session`（:315）、`JOIN workspace`（:316），再 `FOR UPDATE SKIP LOCKED`（:385），没有 `OF c`，所以它对作业（rank 60）、源会话（rank 30）及其 workspace（rank 15）三张表的行都取行锁；但 SKIP LOCKED 从不等待（任何一行被别人持有，这个候选就被跳过），语句又是单条自动提交，所以它不形成等待边。结果门写回执时经外键对源会话取 FOR KEY SHARE，本修订不改。
- **修订 12 对实现的要求**：作业门不等待 session 锁——本修订加进作业门的写（续租、事件、主体、release、abandon）只碰 rank 60 的作业族表，不读锁、不写 session 行；落地会话行的插入（`ensure`）在领取提交后另起事务，结案在落地事实提交后另起事务（LS3），都不进作业门。领取语句是否收窄为 `FOR UPDATE OF c`（只锁作业行，不再因源会话被别人持有而跳过候选）交给撤销与接管的任务（t1srv-a），配竞态 spec 决定。

时间线由已提交事实推导，记录阶段和步骤起点、检查、`claim N · round R of 3`（`LAND_TASK`；`LAND_PROMOTION` 与 `CHECK_PROMOTION` 只写 `claim N · round R`；`of` 后的 3 是 `LAND_TASK` 一次领取最多的轮数，见 §7.2 V6）、Taken over、交还、推送被拒与 `upstreamMovedCommits`、交给谁处理以及判断结果。推送被拒时列出推进目标的提交（J-T4 的 `UpstreamMovedCommits`），并按同一 serial_key 上 LANDED 的 LAND_PROMOTION 判断哪些来自队列外；跨账号只给原因，不给作业 id 或标题。检查输出分块写入 `project_integration_job_log`，带领取围栏、每条检查设上限、保留头尾并脱敏后持久化；不进入 `run_event` 热表，单纯心跳不写时间线事件。

**LS3（结案）**：落地 / 取消事实提交后的边沿在自己的事务里结案，锁序 `session(30) → project_landing(60)`；在主体行锁下复核结案事实仍成立且没有更新的在途尝试，写 settled_at / settled_as 与容器终态。补偿点同 LS1，由已提交事实补做；没有 deadline 或 sweeper 收尾。结案事实见上面的表与「任务段结案」。

**LS4（决定只读不抄）**：owner 确认、重跑的发起者与理由、处理中与已处理，从 `retry_*`（0344）、`handling_*`（0368）、待办行和晋升行读取（V0），不复制成另一份决定事实。重跑与处理的发起者按 0380 读「会话或 user，二者互斥」：`retry_requested_by_session_id` 与 `retry_requested_by_user_id`、`handling_session_id` 与 `handling_user_id` 各恰有一个，时间线据此署名协调会话或 owner。落地会话显示署名和处理入口，从不拥有待办。INTEGRATION_* 仍按 §4.2 的默认负责人与 X-D6（没人可投时直接归 owner）归协调会话或 owner，升级仍走 §4.6；落地过程不回写协调会话的转录，G6 的 open-item:v1 文本不变。

**LS5（隔离）**：落地会话任何字段都不进入 `IntegrationJobCommand`；git 与检查在 runner 自己的环境和临时组合树里执行，不继承 agent 会话环境。

**LS6（拒绝 engine 路径、列表范围与门）**：SessionsService 与 runner 会话控制器入口统一调用结构性 `assertEngineSession(session)`；LANDING 的 createTurn / send / reply / resume / interrupt / end / rename / fork / share 等会改动会话的引擎入口一律 409 `SESSION_IS_PLATFORM_DRIVEN`，响应指向协调会话。不能 Trash。用路由普查 spec 覆盖全部会改动 session 的路由；队列、reaper、回收与所有按 status 扫描会话的路径均过滤 kind，由 kind 普查 spec 守住，不领取也不改动 LANDING。

列表范围（项目分组已在 main 上：`sessions/session-project-membership.ts`，`GET /sessions?projectId=&view=`，web 的 `?project=` 页与 iOS 的项目 sessions 页）：

- 平铺的 `GET /sessions`（不带 `projectId` 的各 view）、`GET /sessions/compact`、`GET /sessions/search`、`GET /sessions/counts`，以及 MCP `session_list`、`session_search`，**默认排除 LANDING**。
- `GET /sessions?projectId=` 只在带 `includeLanding=1` 时，以 `LANDING` 角色返回该项目的落地会话。项目 sessions 页采用它（修订 28，owner 2026-10-27）：页上只有一行 Landings，整行打开**这个项目的 Landings 窗口**；窗口列出该项目的全部落地会话——没结的（在途的与等决定的）在最下面，结了的按天分组、按结案时刻排，全部保留、不折叠；每一轮合入 main 的「Merged into main」行也在窗口里（§3.6）。读的仍是这一条（`view=open` 与 `view=completed`，不带 `limit` 即全量），展开一次落地读 `GET /sessions/:id` 的 landing 视图，不加接口。一个落地会话 id 打开它所属项目的 Landings 窗口并定位到那一条（滚到、展开、高亮）。
- 成员关系 SQL 的两处——`directProjectMembershipSql` 与 `projectMembershipCandidatesSql`——都加 LANDING 分支（`s.kind = 'LANDING'` 且 `project_landing.session_id = s.id`，项目取主体的 `project_id`），否则 `projectId` 读口收不到它们，详情与推送也算不出归属。
- 项目条目与项目 sessions 页的会话数、running 数、状态点都不计 LANDING；平铺会话列表里落地会话为零行。
- **种子读与材料读同样排除 LANDING**（修订 23）：`workspaces/workspace-provider.ts` 的 `lastProviderByWorkspace` 三处种子读（:98、:108、:116）、`managed-runners/managed-runner-supply.ts`:174-178、`wiki/wiki-plan-job.ts` 的 materials 计数与会话查询（:578-595；1c1c78d72 上为 :1008-1027）。它们都按 `task_id IS NULL AND parent_session_id IS NULL` 找 workspace 里「最近的一条普通会话」，LANDING 行恰好满足这两个条件；一旦它成为该 workspace 最新的会话，那里的新会话、任务运行与 @ 提及就会读到 `provider = 'orbit'`，报 `provider not available: "orbit"`。每一处在列上线后加 `kind = 'CONVERSATION'`（等价于排除 LANDING）的过滤。
- 不加 `landing.updated`：项目分组上线时也没有加实时事件；落地会话页按 §2.7a 的节奏轮询。
- 本修订取代 `session-list-projects-design.md` §3.1「本期不加列、不做迁移」一条；同文 §3.4「不加新事件」仍然成立，并写明落地会话不发会话事件。
- GET /sessions/:id 与 `session_get` 直接读取，返回 `sessionKind` 与 landing 视图（主体、尝试、阶段、轮次、检查、活性、阻塞、待办、各代与事件尾）。别人的会话回 404；别人项目的落地读口同样回 404，与 da1b9b0b4 之后的 promotions 读口一致。

门：在途尝试的 owner 门（LAND_TASK 的叫停、晋升的 Cancel、Abandon）只出现在落地会话页头、修订 10 的合入卡与 X-E5 待办三处，是同一组用户门（§2.7a、§4.7）；协调会话里只留修订 10 的那一行。agent 的 `integration_abandon` 新获在途放弃权，门槛严格为「**项目当前协调会话 且 LEASE_EXPIRED**」（§7.2 V6），不套 J-T1b 的待办归属、Automatic 或 owner blocker 规则。owner 走用户门；owner-only 门继续拒绝带 acting session 的请求，新的 owner 门标 `@PatForbidden('OWNER_INTERACTIVE')` 并登记 `auth/pat-owner-channel-routes.ts`，带 `:param` 的新用户路由进 `auth/tenant-isolation-cases.ts`。放弃的两种 PUSH 结果与围栏见 J-T10 / J12；重跑仍走有理由的显式门，落地会话从不自行重跑。

入口（与 §7.2 V6 同一套，owner 2026-10-19 决定，v4 方案 A；修订 28 起，凡打开落地会话的按压与「Open landing ›」，都打开它所属项目的 Landings 窗口并定位到这一次）：

| 面 | 按压 | 「Open landing ›」 |
|---|---|---|
| 项目 sessions 页的 Landings 行（修订 28） | 整行 → 这个项目的 Landings 窗口（停在最底） | — |
| Work overview 的 Landing 卡、项目 sessions 页的 Landing 卡 | 整张 → 作业清单 | 一个作业时卡底一个；多个作业时每个作业行一个（合入作业行不放） |
| 合入卡的头（CHECKING / CONFIRMED / RECHECKING） | 整行 → Landings 窗口，定位到这一轮合入（不再叫 Watch） | —（这一行的按压就是入口）；BLOCKED 不加，旧服务端没有 id 时照 main 打开作业清单 |
| 作业清单的每一行 | 有任务时 → 任务 | 每行一个（合入作业行只有它这一个按压） |
| Landings 窗口里的「Merged into main」行（修订 28 起不在项目 sessions 页的时间线上） | 整行在原地展开这一轮（回执、检查、推送），再按收起 | —（已在窗口里） |
| 协调会话里那一行合入回执（修订 10） | 整行 → 回执 | 回执底部一个，进窗口并定位到这一轮 |
| 会话列表的项目行 | 协调会话或项目 | — |
| web 任务页的 Landing 段（iOS / Android 同） | 只读 | 当前这一代一个 |

源工作会话的派生标签、协调会话的待办与合入卡、项目集成行与 Landings 窗口、agent 读口也都能通过 `landingSessionId` 链接到这个地址；新客户端打开这个地址，就是进 Landings 窗口并定位到这一次，agent 照旧用 `session_get` 读这一次；`project_integration_get` 只读作业与日志。

修订 28 起，新客户端不再单独打开落地会话页：本文说的「落地会话页」，在新客户端上就是 Landings 窗口里定位到的这一次——它的卡是原来页头的状态卡（没结时在窗口最下面），展开是原来的各代时间线与检查输出；原来页头的门挂在这张卡上（长按的菜单与卡上的门，效果图 `docs/mocks/landings-one-window/` 的 03 g），窗口右上角的菜单只有 Open Coordinator 与 Open Project。旧客户端照旧打开单个落地会话页。

**LS7（无时钟）**：不存在由时钟打开、改变或结束落地会话的路径。活性只读推导；§4.6 X-E5 的租约过期提醒只给 owner 开待办，不结束作业或会话、不唤醒 agent。

**LS8（不计保险丝）**：平台执行的落地、记录、输出与补偿不产生 engine 轮次，不计协调会话的自主花费保险丝。

**判断点本期不接 engine**（owner 2026-10-04）：CONFLICT、CHECK_FAILED、ERROR 的判断仍在协调会话或 owner，修复走修复任务、`task_reopen` 或显式重跑；以后要接，另开修订。

已应用的 0281 迁移不改；第 2 期的落地会话迁移（编号以实施时 main 最新号为准）的头注必须取代旧说法：`0281` 的 “It is not a session: nothing here starts an engine.” 后半句仍成立；前半句收窄为「作业本身不是会话，是一个落地会话里的一次尝试」。`schema.prisma` 的模型注释在本修订里只写成对实现的要求，那次迁移落地时再改成现状。本修订只改契约、设计文档与注释，不创建迁移、不改行为；`project-agent-contract.md` 无需改，因为不写 run_event。

---

## 3. main 同步与合入 main

### 3.1 main 同步

**M1**：只针对 `PROJECT_BRANCH` 线，发生在 `LAND_TASK` 的 J-S2。upstream tip 不是项目分支 tip 的祖先时，先生成吸收 upstream 的 merge 提交，再把任务 rebase 到它上面，二者一起检查、一起落地；源分支自己已经吸收过时不再生成（M3）。项目分支上因此出现 merge 提交，旧 tip 仍是祖先。**不 rebase 项目分支，不 force push**（硬约束 3）。

**M2**：吸收时冲突 → 作业 `CONFLICT`（`phase = MAIN_SYNC`）+ `INTEGRATION_CONFLICT` 待办。只要这条待办 OPEN，同一 `serial_key` 上其他任务的 `LAND_TASK` 不被领取，否则每条作业都会撞上同一个冲突、各开一张卡。冲突任务自己的后续落地不扣（`integration-job-relay.ts#claimOne`）：M3 的解法放在它的源分支上，扣住它就是让它等那条它要关掉的待办，只有手关才放得出来。领取读不到 git，只认「同一任务」；源分支是否带着吸收由 runner 在 J-S2 判：两个 tip 都在 → J-S4 MERGE 落地，落地关掉待办（J-T5），排着的落地接着走；缺一个 → 照旧冲突，另开一条待办，其他任务继续等。**「处理中」不豁免（T15 的读者豁免在 T17 撤掉，2026-10-12）**：这条待办被新一代接手（H1，`handling_job_id` 指向的作业 QUEUED/RUNNING）期间，**扣留照旧、读者的读数也照实报**：`claimOne` 的豁免从头到尾只有「同一任务」这一条，而有这条豁免时读者却把它报成 `WAITING_RUNNER` / `WAITING_SERIAL_SLOT` / `WAITING_DISPATCH`（「下一次心跳认领」），读起来像马上会被领走。T17 把 `project-task-integration.ts#readTaskIntegrationViews` 的 `sync_block` 与 `claimOne` 的 M2 条件改成同一段谓词（去掉那条 `NOT EXISTS handling`），等待原因回到 `WAITING_MAIN_SYNC`，并**点名正在重落地的那一代**（`handlingGeneration`，`summary` 末句「— a new landing (generation N) is resolving it」）。放开领取而不是撤豁免是被否掉的那条路：别的任务先落地会移动项目分支 tip，正在重落地的那条带解法的源分支随即缺了新 tip，按 J-S2 ③ 又要再合一次。`reopen-landing-handling.pg.spec.ts` 现在同时断言两边：另一任务的落地读作 `WAITING_MAIN_SYNC`（并点名那一代），且同一拍里 `dispatch` 确实不把它交给 runner。

**M3**：吸收冲突先在项目线上解，再落地。解法放进冲突任务的源分支：任务的会话把项目分支 tip 和 upstream tip 合进源分支、解掉冲突，提交这个合并提交，任务原来的工作留着、不重做。协调者的做法：先 `task_comment` 写明这一轮只做这一件，再 `task_reopen`；任务再次 DONE 照 J-T1a 排下一代，M2 不扣它。J-S2 看到源分支同时包含本次 J-S1 取到的 upstream tip 与项目分支 tip（且不就是 upstream tip），就不再在项目分支 tip 上合 upstream，J-S4 用 MERGE 模式落地这条解决提交，结果树等于源分支。rebase 会丢掉合并提交里的解法，这正是现有 `session_merge` 的已知缺陷。**落地前任一 tip 又前进了**，两种 tip 两种走法（T16）：**项目分支 tip 前进**时源分支缺的是 T0，J-S2 照旧在 T0 上合 upstream、照旧冲突，要再合一次；**upstream 前进**而源分支吸过的是较早的 U′ 时，J-S2 把当前的 U 直接合进这条带解法的源分支（§2.4 J-S2 分支 ②）——合得干净就按 MERGE 落地，不必再合一次；`U′..U` 真改到解法那一处才报 `CONFLICT`。缘由（2026-10-04/05 两次实测）：解法是在 t1 时刻对当时的 U′ 解的，之后还要跑 30–60 分钟的验收才排到落地，这期间 main 一动，旧规则就退回「把 U 合进 T0」——T0 里没有解法，同一处再冲突一次（T7 连着两次停在 MAIN_SYNC，晋升在同一文件上的 MERGE 冲突最后靠手工吸收解开），这扇门在 main 持续前进时不算解决型门。分支 ①（完整吸收）不写 `main_sync_sha`：作业自己没做吸收，`rebase_base_sha` 是 T0，项目页和晋升卡的「synced with main」只按作业做过的吸收计时，这一次不移动它；分支 ② 的作业自己做了吸收，写 `main_sync_sha`，「synced with main」随之移动。`integration_retry` 仍拒收 `CONFLICT`（J-T1b）：同一个源分支原样重跑，在 J-S2 会再冲突一次。重试门的拒绝文案（`project-integration-retry.ts#notRetryable`）按 T16 写：让源分支拿到项目分支 tip 与 upstream tip 的合并提交、别的什么都不做（`task_comment` 写明这一轮只做它，再 `task_reopen`），下一次落地就跳过 main 同步、走 J-S4 的 MERGE。**待办消息里那一段（`project-open-item.ts#mainSyncNextStep`）在 T17 跟上了 T16**：第 2 步现在分两种 tip 说——项目分支 tip 前进时源分支缺的是它，落地照旧停在 `MAIN_SYNC`、要把那个 tip 再合进来一次；只有 upstream 前进时落地会把新的 upstream 合进这条带解法的源分支，合得干净就按 MERGE 落地、什么都不用做，只有 `U′..U` 真改到解法那一处才会再冲突。那段话也按同一批改动去掉了 `integration_retry` 的名字（冲突格的门里没有它，§4.7）。

**M4**：upstream 前进本身不触发同步。没有哪个事实能说「现在该同步」而不引入时钟；同步发生在下一次集成或下一次晋升检查时。

### 3.2 数据结构

**`project_promotion`**（迁移 0273）：

| 列 | 类型 | 约束与语义 |
|---|---|---|
| `id` | uuid(7) PK | |
| `project_id` / `owner_id` / `codebase_id` | uuid | |
| `source_kind` | text | CHECK ∈ {`PROJECT_BRANCH`, `TASK_BRANCH`}；后者只用于 `MAIN` 线项目 |
| `task_id` / `session_id` | uuid NULL | `TASK_BRANCH` 必填；实际上两种源都有值：`PROJECT_BRANCH` 候选写最后落地的那个任务及其会话（`considerCandidate`），只为让队列找到一个可借的工作目录，所以落地主体不读 `task_id`（§2.9）。现状（0424 起，2026-10-14）是**不带外键的历史引用**，修订 12 对实现的要求已落实：删任务、删会话不再改写晋升行，晋升行仍指名那个任务和会话；合入 main 写回执时按 id 查回，查不到的会话不写回执、查不到的任务写成 NULL。0424 之前是 FK `task` / `session` ON DELETE SET NULL（0286:90-93），理由：置空是一次 UPDATE，终态行被 `project_promotion_terminal_guard`（0286）拒绝，删任务、删会话因此整批回滚，「让守卫放行」的办法不可行（同 §2.1） |
| `source_ref` / `source_sha` | text / char(40) NULL | 候选的源：项目分支 tip，或任务的交付提交。`TASK_BRANCH` 候选在插入时就写 `source_sha = delivered_sha`（修订 29，§10.5 O-L5；`delivered_sha` 是任务 DONE 时冻结的交付身份，§10.4）。此前它先以 NULL 写下、由 `CHECK_PROMOTION` 解析任务分支后回写（迁移 0293），这一半已作废。凡检查产出的状态都带值 |
| `upstream_ref` | text | 冻结自代码库行 |
| `upstream_sha_checked` / `merge_tree_sha` | char(40) NULL | 最近一次通过的检查所基于的 upstream tip 与组合树 |
| `included_task_ids` | uuid[] NOT NULL DEFAULT `'{}'` | 这次合入带进 main 的任务 |
| `commits_ahead` / `files_changed` | int NULL | 卡片显示 |
| `checks` / `conflicts` | jsonb / text[] | 最近一次检查 |
| `blocked_reason` | text NULL | 迁移 0409。CHECK ∈ {`ALREADY_LANDED`, `CHECK_FAILED`, `CONFLICT`, `ERROR`}：把候选写成 `BLOCKED` 的那次作业答的是什么，和 `BLOCKED` 同一条语句写下；重新检查（§4.7 H1）时清空。`ALREADY_LANDED` 与 `ERROR` 的 `checks`、`conflicts` 都是空的，客户端靠这一列，而不是从两者推断「检查没过」（2026-10-09）。0409 之前的行为 NULL，照旧推断 |
| `state` | text | CHECK ∈ {`CHECKING`, `READY`, `CONFIRMED`, `RECHECKING`, `MERGED`, `BLOCKED`, `DECLINED`, `CANCELLED`, `SUPERSEDED`} |
| `check_job_id` / `land_job_id` | uuid NULL | 当前作业 |
| `confirmed_by_user_id` / `confirmed_at` / `decided_at` | uuid / timestamptz | 重新检查（§4.7 H1，含 J-T9 的超时重排）随候选回到 `CHECKING` 的那条 UPDATE 一起清空 `confirmed_by_user_id` / `confirmed_at`、`confirmed_automatically` 复位 false：重检查的是一个新的合入问题（重查所对的 upstream 可能已前进），旧的确认回答的是旧检查，留着它还会在 Automatic 对新结果写 `confirmed_automatically = true` 时撞 `project_promotion_automatic_chk`（2026-10-09 生产事故：owner 的确认留在 BLOCKED 候选上，重查通过后自动确认撞约束、结果 500、作业永留 RUNNING 占住检查串行槽）。清空后由 Automatic 或 owner 对新的检查结果重新决定；不开 Automatic 的项目行为不变——检查通过后照常出 owner 的卡，owner 此前按过不算数、要按新的 |
| `confirmed_automatically` | boolean NOT NULL DEFAULT false | 迁移 0301。没人按：项目的 Automatic 授权确认了这次合入（M-T11），此时 `confirmed_by_user_id` 为 NULL。CHECK：`CONFIRMED` / `RECHECKING` / `MERGED` 行要么写明确认人、要么此列为真；此列为真时 `source_kind = 'PROJECT_BRANCH'` 且不写确认人（`MAIN` 线永远不能被记成自动确认） |
| `merged_sha` / `merged_at` | char(40) / timestamptz NULL | |
| `open_item_id` | uuid NULL | **只指这张候选自己的审批卡**（`PROMOTION_APPROVAL`）。owner 的确认与「Not now」由 `resolveApprovalItem` 在它上面记 `USER` / `APPROVED`、`DECLINED`（M-T4、M-T5）。候选的集成失败待办（`INTEGRATION_*`）**不**挂这一列：它们由 `project_open_item.promotion_id` 指回来，`closePromotionItems` 按那个外键关（§3.3）。两者互不覆盖，谁先动手都留下对方那半句完整的话 |
| `receipt_ids` | uuid[] NOT NULL DEFAULT `'{}'` | |
| `created_at` / `updated_at` | timestamptz | |

部分唯一索引 `(project_id, source_ref) WHERE state IN ('CHECKING','READY','CONFIRMED','RECHECKING','BLOCKED')`：同一个源同时只有一个活的候选。终态行不可变（触发器 `project_promotion_terminal_guard`）。

### 3.3 状态转移（效果图 4 的四种状态）

| # | from | 已提交事实 | to | 附带写入 |
|---|---|---|---|---|
| M-T1 | — | 候选事实（§3.4） | `CHECKING` | 同一事务入队 `CHECK_PROMOTION` |
| M-T2 | `CHECKING` | 检查作业 `READY`，且 M-T11 不成立 | `READY`（状态 A） | `PROMOTION_APPROVAL` 待办（负责人 OWNER）；提交后推送 `approve-merge-to-main` |
| M-T3 | `CHECKING` | 检查作业 `CONFLICT` / `CHECK_FAILED` / `ERROR`。`TASK_BRANCH` 候选的检查答 `ALREADY_LANDED` 不走本行（修订 29，§10.5 O-L6）：它本身是一次观测，结果事务写回执，M-T13 随之退役候选（`SUPERSEDED`），再按 §10.6 O-R3 开 owner 待办，不写 BLOCKED | `BLOCKED`（状态 D） | 协调会话待办（§4.2），`promotion_id` 指向本行 |
| M-T4 | `READY` | owner 确认写入（CAS `state = READY`，且 `source_sha` 与请求体一致） | `CONFIRMED` | 入队 `LAND_PROMOTION`；审批待办 `RESOLVED / APPROVED` |
| M-T5 | `READY` | owner「Not now」写入 | `DECLINED` | 审批待办 `RESOLVED / DECLINED`（附录 A-Q6） |
| M-T6 | `CHECKING` / `READY` / `BLOCKED` | 同一源出现新候选（M-F1） | `SUPERSEDED` | 旧待办 `SUPERSEDED`；旧检查作业按 J-T8：QUEUED 直接 CANCELLED；RUNNING 已按 §7.2 V6 超时的，当场按 J-T9 的比较并交换结束为 `ERROR`（`CHECK_PROMOTION` 一律 `RUNNER_LOST`，J12），仍在回报期内的才只写 `cancel_requested_at`（要求；现状是 `supersedeLiveCandidates` 把两者都直接写成 CANCELLED）；新行 CHECKING，落地会话仍为同一段 / 轮（§2.9） |
| M-T7 | `CONFIRMED` | 落地作业进度回报 `upstreamMoved` | `RECHECKING`（状态 B） | 作业继续，在新 tip 上重做合并与检查 |
| M-T8 | `CONFIRMED` / `RECHECKING`（含取消中） | 落地作业 `LANDED`，即使已请求取消也以推送事实为准 | `MERGED`（状态 C） | 回执（M9），不能因 cancel 请求丢弃 LANDED。要求；现状：已修正——`applyCancel` 对仍在回报的领取只写 `cancel_requested_at`，候选保持活状态，之后到的 LANDED 照本行写 MERGED（`applyPromotionJobResult` 带取消请求的那一支不收 LANDED / ALREADY_LANDED） |
| M-T9 | `CONFIRMED` / `RECHECKING` | 落地作业 `CONFLICT` / `CHECK_FAILED` / `ERROR`（`CONFIRMED` 时也会：upstream 未动而重做的树不同，`PROMOTION_TREE_NONDETERMINISTIC`；owner 确认的作业连续第三次推送被抢，J-T13——前两次在同一确认下重排新一代，不落到这一行） | `BLOCKED`（状态 D） | 协调会话待办；解决之后内容已经变了，重新走 A，要 owner 再点一次。代码今天就对两种起点都这样做（`blockPromotion`），本修订补上条文 |
| M-T10 | `CONFIRMED` / `RECHECKING` | owner「Cancel」写入（M-F3 的同一扇门），作业尚未过推送界线（J-T4：v2 领取看 `push_reported_generation = claim_generation`；legacy 领取看 `phase` ∈ {`PUSH`, `VERIFY`}） | QUEUED 作业直接 `CANCELLED`，晋升 `CANCELLED`；RUNNING 未超时的晋升保持原状态，读作「取消中」，已超时的当场结束为 `ERROR`，晋升随 J12 的结局走：`RUNNER_LOST` 写 `CANCELLED`，`PUSH_OUTCOME_UNKNOWN` 写 `BLOCKED` | 要求：同事务执行 J-T8；RUNNING 按 §7.2 V6 已超时的，当场按 J-T9 的比较并交换结束为 `ERROR`（`LAND_PROMOTION` 按 J12 的推送界线写 `RUNNER_LOST` 或 `PUSH_OUTCOME_UNKNOWN`，`claim_generation + 1`），同一事务按错误码写晋升的结局：`RUNNER_LOST` 写 `CANCELLED`（证明没有推送，取消已经生效，不再等 runner 的结果）；`PUSH_OUTCOME_UNKNOWN` 写 `BLOCKED`（可能已推送，与 J-T10 放弃段同一结局，不能声称已取消）；仍在回报期内的只写作业 `cancel_requested_at`，结果证明没有推送（CANCELLED，或没有推送的失败，见 §2.6）才把晋升写成 CANCELLED（J-T12；结果不能证明没有推送时——被放弃、结束为 `PUSH_OUTCOME_UNKNOWN`，或 legacy 领取推送之后报的 `VERIFY` 错误——写 `BLOCKED`。修订 25 记下的这处现状偏差已在修订 26 修正，见 §2.6 J12 段的现状注），实际 LANDED 走 M-T8，以事实为准；legacy 领取同样以事实为准。已过界线照旧 409 `PROMOTION_NOT_READY`。§3.6 的 `cancelRequested` / `pushBoundaryPassed` 由服务端给出，合入卡据此画「取消中」。现状：这处缺陷已修正——`applyCancel` 按 `pushBoundaryPassed` 判界线（v2 看 `push_reported_generation`，legacy 的 `PUSH` 与 `VERIFY` 都算已过），对仍在回报的领取只写 `cancel_requested_at`，不当场写 CANCELLED |
| M-T11 | `CHECKING` | 检查作业 `READY`，且同一事务读到：`source_kind = PROJECT_BRANCH` 且绑定仍是该项目分支（upstream 仍是它的 upstream）；`project.coordinator_enabled = true`；干净——无冲突、每条检查 `exit_code = expected` 且未超时、回报带 `upstreamSha` 与 `testedTreeSha`、本项目**合入 main 这条路上**（`promotion_id` 不为空：候选的检查或落地开的）没有仍欠着的 `INTEGRATION_*` 待办（`openItemOwed`，T2 起；一个对象已经过去的 OPEN 待办不算——这正是它挡不住自动合入的原因；任务落项目分支时开的不算，owner 决定 2026-10-15：那个任务的产出不在分支上，也就不在任何候选里；X-E5 的 `LANDING_LEASE_EXPIRED` 也不在此列）；做检查的 runner 声明了 `promotion-automatic-land/v1` | `CONFIRMED`（`confirmed_automatically = true`，不写确认人） | 同一事务入队 `LAND_PROMOTION`（`confirmed_automatically = true`）；**不开** `PROMOTION_APPROVAL` 待办 |
| M-T12 | `CONFIRMED`（自动确认） | 落地作业 `READY`：runner 发现 upstream 已不在 `upstream_sha_checked`，什么都没合、没检查、没推；或第一次推送被抢即交回 READY（J-T13：不再重取、结果带 `upstreamMovedCommits`，e94080db6 起已实现。J-T13 的 owner 确认一半不经过本行：结果事务直接重排下一代 `LAND_PROMOTION`）；或领取时平台对同一行重读 M-T11（检查留下的事实 + 项目此刻的 `coordinator_enabled`、绑定、仍欠着的集成类待办——`openItemOwed`），授权已不成立——作业不下发给 runner，直接记 `READY`；授权读不出来也不下发。结果应用时对同一行再读一次 M-T11（`automaticLandingCameBack`，检查留下的事实 + 项目此刻的事实） | 授权已不成立 → `READY`（状态 A）；授权仍在、只是 main 动了 → `CHECKING`（owner 决定 2026-10-15）；同一候选第 `AUTOMATIC_MERGE_ATTEMPTS`（3）次自动落地仍发现 main 已动 → `READY` | 去 `READY`：`confirmed_automatically` 复位为 false、`confirmed_at` / `land_job_id` 清空；开 `PROMOTION_APPROVAL` 待办（负责人 OWNER，payload 的 `upstreamShaChecked` 取本行、不取作业看到的新 tip）。去 `CHECKING`：同样复位与清空，同一事务入队下一代 `CHECK_PROMOTION`（同一个冻结的 `source_sha`），`check_job_id` 指向它，不开任何待办；新检查的结果照 M-T2 / M-T3 / M-T11 判。两种去向作业行都保留 `confirmed_automatically = true`，次数就按这些 `READY` 的自动落地作业数 |
| M-T13 | `CHECKING` / `READY` / `BLOCKED`（仅 `TASK_BRANCH`） | 一条回执写下：同一任务、同一源分支落到本候选的 upstream 上（`MERGED` / `ALREADY_MERGED`），且回执晚于候选——合入在卡片之外发生了（协调会话手动快进 main 后记回执，或会话自己的 Merge 按钮）| `SUPERSEDED` | 与回执同一事务（`retireCandidatesLandedByReceipt`，由 `MergeReceiptService.record` 与 `fromRunnerMergeResult` 调用；重放已记下的回执同样执行，只作用于早于回执的候选）：检查作业按 J-T8，QUEUED 直接 CANCELLED；RUNNING 的先按 §7.2 V6 的读时判定看过——已沉默超过时限的不再只写 `cancel_requested_at`（取消请求的作业 `claimOne` 永不重发，runner 已死时这行会永远占住 `#check:<project>` 串行槽、堵死项目此后的全部检查），而是当场按 J-T9 的比较并交换结束为 `ERROR · RUNNER_LOST`（`claim_generation + 1`，迟到的结果被拒）；仍在回报期内的才只写 `cancel_requested_at`，由 J-T12 收口。审批待办与 `INTEGRATION_*` 待办 `RESOLVED / PROMOTION_MOVED_ON`（§4.2）。之后到的检查结果按非活候选丢弃，不开待办。不动：同一任务的其他分支、落到别处或没落地的回执、`PROJECT_BRANCH` 候选、已确认的候选（M-T8 自己会答 `ALREADY_LANDED`）。2026-10-09 项目 `34b78EQPNkVF8kM3ki7Ch`：分支从未推送、协调会话手动合入并记了回执，检查报 `SOURCE_BRANCH_MISSING`，候选停在 BLOCKED，项目 DONE 之后 sessions 页仍显示「Can’t merge into main yet」；生产上全部 5 条 BLOCKED 的 `TASK_BRANCH` 候选都是这个形状，迁移 0411 一次性退役 |

**候选离开活跃状态：一条边，一个函数（T1，2026-10-03 落地）**。上面每一处让候选离开 `CHECKING` / `READY` / `CONFIRMED` / `RECHECKING` / `BLOCKED` 的转移，都在**同一个事务**里调用 `closePromotionItems(tx, projectId, promotionId, state)`（`project-promotion.service.ts`）：

| 转移 | 走的门 | 写得怎样 |
|---|---|---|
| M-T6 被同源的新候选取代（含 M-F2 的 refile 补排） | `supersedeLiveCandidates` | `SUPERSEDED / PROMOTION_MOVED_ON`，`resolved_by = PLATFORM` |
| M-T13 被卡片之外的回执退役 | `retireCandidatesLandedByReceipt` | `RESOLVED / PROMOTION_MOVED_ON`，`PLATFORM` |
| M-T5 owner「Not now」 | `applyDecline` | `RESOLVED / PROMOTION_MOVED_ON`（先关审批卡，owner 的 `DECLINED` 留在它上面） |
| M-T10 owner「Cancel」 | `applyCancel` | `RESOLVED / PROMOTION_MOVED_ON`，`PLATFORM`。同样**不碰审批卡**（确认过的候选那张卡已经关掉了） |
| M-T8 合入落到实处（落地作业报 `LANDED` / `ALREADY_LANDED`） | `applyPromotionJobResult` 写 `MERGED` 的那一条 UPDATE 旁边 | `RESOLVED / PROMOTION_MOVED_ON`，`PLATFORM`。**不碰审批卡**：那张卡在 owner 确认那一刻已经由 `resolveApprovalItem` 写成 `APPROVED` |

M-T9（落地失败 → `BLOCKED`）不在这里：它开的是**新**待办，旧的那条是候选失败的同一次尝试留下的，由上面的某一个出口带走。

两点是这条边的要义。其一，**它按 `project_open_item.promotion_id` 关，不按 `project_promotion.open_item_id`**：后者只指审批卡（§3.2），而这里要关的是这条候选的一切集成失败待办——它们等的正是这张候选被扶正。其二，**候选已死时不再开失败待办**：一个跑在候选离开活跃状态之后的检查结果按非活候选丢弃（`applyPromotionJobResult` 的早退），写作业行的那个事务也据此不再 `recordIntegrationFailure`（`runner-api/integration-job-relay.ts` 的 `applyIntegrationJobResult`，判在 :966-971）。待办挂着不关的代价是实打实的：它会按时钟升级给 owner、计入角标，并让 M-T11 拒绝这个项目此后的每一次自动合入——2026-10-02，项目 `34Y7My8sqhKLWtmCQYv1l` 的一条 INTEGRATION_CHECK_FAILED 在候选换了两代、分支已合进 main 之后仍开着，Automatic 因此实际被关掉。

**M5（确认后 main 前进 → 自动重检，不再问）**：owner 确认的是「这批任务、这些检查」。首次 fetch 发现 upstream 前进而重检仍然通过，直接落地（状态 B）；重检失败交给协调会话。但**推送被抢第一次即结束这一次领取、不在作业内再重检**（owner 2026-10-19 决定）：owner 确认的候选留在 `CONFIRMED`，同一事务入队下一代 `LAND_PROMOTION`，在新的 main 上按本节重检并落地；连续第 3 代都以 `TARGET_MOVED` 结束才转 `BLOCKED`，开带 `upstreamMovedCommits` 的 INTEGRATION_ERROR 待办（J-T13）。Automatic 的自动确认（M-T11）只授权测过的树与当时 main tip：main 一动，这次落地什么都不合，候选回到 CHECKING、在新的 main 上重查，由 M-T11 再判；连续 `AUTOMATIC_MERGE_ATTEMPTS`（3）次落地都发现 main 已动才交回 READY 出卡（M-T12，owner 决定 2026-10-15）。session merge 到 main 不与 LAND_PROMOTION 串行，本修订不改变该路径。

**M6（落地方式）**：`PROJECT_BRANCH` 源用 `git merge --no-ff <source_sha>` 合到 upstream tip，任务提交保持为 main 的祖先；`TASK_BRANCH` 源 rebase 后 fast-forward（附录 A-Q7）。两者都要求落地的树等于最后一次通过检查的树。

**M7（谁对合入 main 说是）**：owner——按卡片。唯一例外是两件事**同时**成立（owner 决定，2026-09-23：「有自己的项目集成分支 + automatic 就可以合并；如果是 main 或非 automatic，就需要人来点」）：这条线是项目自己的分支（`PROJECT_BRANCH`，已过线检查的暂存区，提供「这次落地是干净的」），且项目的 Automatic（`coordinator_enabled`）开着（owner 已经给过的授权，提供「这个项目可以自己动」）。此时由平台自行确认并合入，留收据（M-T11、§3.6 的 `merged.automatic` / `merged.revert`）。任一不成立——`MAIN` 线项目、Automatic 关、检查红、有冲突、项目合入 main 这条路上有仍欠着的集成类待办——都照旧出卡，一个字不改；main 在检查后前进则先在新的 main 上重查（M-T12）。owner 决定 2026-10-15 的依据：此前 14 天，Automatic 开着的项目分支项目出的 154 张卡里，100 张是 main 在检查后动了被交回，46 张是别的任务落项目分支时的异常挡住的。不为凑自动放宽「干净」：前三条在 M-T11 的判据里，main 前进由 runner 在推送前执行（M-T12），声明不了这一点的 runner 不会被交给自动落地（领取也会跳过它）。「落地那一刻」的授权读两次：检查回来 `READY` 时决定出卡还是自动确认，作业被领取、即将下发给 runner 时再读一次——owner 在这之间关掉 Automatic（或线改成了 main、合入 main 这条路上新开了集成类待办），这次落地就交回 owner 出卡，不凭一个已经收回的授权推送。

**M7 的第二种常设授权（修订 29，§10.5 O-L2）**：上一段说的是交付方式为 `PLATFORM` 的项目，原文不改。交付方式为 `AGENT_PUSH` 的项目（只在 `MAIN` 线上，§1.1），owner 已经常设授权 agent 自己把工作推到 upstream，与 Automatic 的授权同类：代码任务 DONE 时不建晋升候选（不走 M-F2）、不出确认卡；进 main 由观测记下（§10.3 O2、§10.6 O-R1），也不开 `LANDED_WITHOUT_CONFIRMATION`（§10.7）。

语义代价写明：`coordinator_enabled` 原本只管「平台可以自动把例外待办交给协调会话」，现在同一个开关也是「允许平台自主合入 main」的授权——为了让协调会话处理例外而打开 Automatic 的 `PROJECT_BRANCH` 项目，会顺带开始自动合入 main。owner 选择复用这个开关而不是加第二个；Automatic 的说明文案（§7.2 V8）必须说出这一点，`schema.prisma` 里该列的注释同样写明。

**M8（合入 main 不等于项目完成）**：卡片显示判据满足数（效果图 4「3 of 6 met on this branch — merging does not close the project」），由客户端从 `project_get` 的判据项计算；DONE 仍由 §3.5 的投影决定。

**M9（回执）**：`MERGED` 的事务里，为 `included_task_ids` 中每个任务的产出会话各写一条回执：`result = MERGED`、`target_branch` = upstream 短名、`source_sha` = 该任务在集成线上的落地提交（`TASK_BRANCH` 为作业的 `tested_sha`）、`target_sha_before` = 推送前 upstream tip、`target_sha_after = merged_sha`、`recorded_by = RUNNER`、`detail = { source: 'integration-job', integrationJobId, testedTreeSha?, landedTreeSha?, confirmedAutomatically? }`（不带 `promotionId`：候选经作业行找到，`merge-receipt.service.ts#fromIntegrationJob`）。这些任务随即变成 `ON_UPSTREAM`，判据读作 `LANDED`。J12 修复（§2.6）补写的 M9 回执是例外：它们在后来那条作业的结果事务里写，`detail` 另带 `recoveredUnknownPush: true`，不经过 `MERGED`，也不改写候选行——被追回的候选保持它此刻的状态，`BLOCKED` 或 `CANCELLED`（`CANCELLED` 从哪些门来、以及现状下的那条偏差路径，见 §2.6 J12）——任务照样经这些回执读作 `ON_UPSTREAM`。

### 3.4 触发点与 runner 步骤

**M-F1（`PROJECT_BRANCH` 候选）**：一条 `LAND_TASK` 作业进入终态的事务提交后，`ProjectPromotionService.considerCandidate(projectId)` 从已提交行判断：

- 同一 `serial_key` 上已没有 `QUEUED` / `RUNNING` 的 `LAND_TASK`（「队列排空」是最后一条作业的提交事实）；
- 最近一条 `LANDED` 作业的 `landed_sha`（记为 P）没有被 `MERGED`、`DECLINED` 或活的候选覆盖；
- 本项目没有 `CONFIRMED` / `RECHECKING` 的晋升（有的话，等它终态后再判断，见 M-F4）。

条件都成立时插入候选（`source_sha = P`，`included_task_ids` 取 P 之前落地、尚未 `ON_UPSTREAM` 的任务），并取代同一源上活的旧候选。

**M-F2（`MAIN` 线候选）**：交付方式为 `PLATFORM` 的 `MAIN` 线项目（修订 29，§10.5 O-L2；`AGENT_PUSH` 项目不建候选），代码任务 DONE 时，J-T1a 不入队 `LAND_TASK`，改为在冻结交付身份的那个事务里（通常就是 DONE 的事务，§10.5 O-L4）插入 `project_promotion(source_kind = TASK_BRANCH, state = CHECKING)` 与 `CHECK_PROMOTION`。候选插入时就写 `source_sha = delivered_sha`，按提交指名（§10.5 O-L5）；检查答 `ALREADY_LANDED` 时见 M-T3。

**M-F3（owner 写入）**：`POST /projects/:id/promotions/:promotionId/{confirm | decline | cancel}`，只接受 owner 凭据；带 acting session 拒绝 403 `PROMOTION_OWNER_ONLY`；状态不符拒绝 409 `PROMOTION_NOT_READY`。

**M-F4**：`LAND_PROMOTION` 终态提交后再调一次 `considerCandidate`，接住确认期间落进项目分支的新任务。

**runner 步骤**：

| 步 | `CHECK_PROMOTION` | `LAND_PROMOTION` |
|---|---|---|
| M-S1 | fetch upstream 与源；U = upstream tip。`TASK_BRANCH` 源不 fetch 任务分支（修订 29，§10.5 O-L5）：直接在本机对象库里取候选的 `source_sha`，本机没有 → `ERROR / WORK_COMMIT_MISSING`（J12）；所以这种源的检查与落地由源会话所在的 runner 领取，与 `LAND_TASK` 同一条领取条件 | 同左；U′ = 当前 upstream tip |
| M-S2 | `PROJECT_BRANCH`：在 U 上 `git merge --no-ff -m "Merge <source> into <upstream>" <source_sha>`；`TASK_BRANCH`：在 U 上 rebase 源 | U′ = `upstream_sha_checked` → 重做同一合并；否则回报进度 `upstreamMoved` 并在 U′ 上重做。命令带 `automatic: true`（M-T11）时，U′ ≠ `upstream_sha_checked`（或命令没给它）→ 不合并、不检查、不回报 `upstreamMoved`，直接回报 `READY`（M-T12）；已在 upstream 上的源仍先回报 `ALREADY_LANDED` |
| M-S3 | 跑检查（组合树自带 `scripts/worktree-overlay.sh` 时先运行它，同 J-S5）：`PROJECT_BRANCH` 跑合并检查；`TASK_BRANCH` 跑任务验收命令与合并检查 | U′ 未变：要求重做的合并树 = `merge_tree_sha`，不等 → `ERROR / PROMOTION_TREE_NONDETERMINISTIC`；U′ 变了：重跑检查 |
| M-S4 | 回报 `READY { upstreamShaChecked, mergeTreeSha, commitsAhead, filesChanged, includedLandedShas }`，`includedLandedShas` 为逐个 `merge-base --is-ancestor` 核实过的候选 | 落地前核对（同 J-S6a）→ v2 领取同步回报 PUSH 并读 `cancelRequested`（要求，J-T4）→ 推送 upstream（不 force）→ 前移本地 upstream → 远端核对（同 J-S7）→ 回报 LANDED；第一次 TARGET_MOVED 按 J-T13 结束并交回，不重跑检查（要求） |

### 3.5 项目 DONE 投影与文档改动

**M10**：`project-done-derived.ts` 的输入与重算边沿都不改；§1.4 把 `LANDED` 收窄为 `ON_UPSTREAM`，所以 DONE 在合入前是 OPEN、合入后翻为 DONE。M9 的回执经 `MergeReceiptService.deliverProjectFactsAfterCommit` 触发重算，与今天的回执边沿是同一个入口。

> 实现记（2026-09-18）：§3 的 `PROJECT_BRANCH` 线已落地（迁移 0286 `project_promotion`、`projects/project-promotion.ts` 与 `.service.ts`、`POST /projects/:id/promotions/:promotionId/{confirm|decline|cancel}`、runner 的 `promoteOnce`）。
>
> 实现记（2026-09-20）：**M-F2 与 `TASK_BRANCH` 的 runner 步骤已落地**。`enqueueForDoneTask` 的 `MAIN` 分支在同一事务里写候选与 `CHECK_PROMOTION`（`queueTaskBranchCandidate`，线开始时的补入队也按线分岔）；`promoteOnce` 按 `promotionSourceKind` 走 rebase 后 fast-forward（M6、A-Q7）；`checksFor` 按源种类决定是否跑任务验收命令（M-S3）；`writeUpstreamReceipts` 按源种类取 `tested_sha`（M9）。顺带的另一处口子也收掉：`claimOne` 在吸收冲突的待办还 OPEN 时不再领取同一 `serial_key` 上的 `LAND_TASK`（M2 后半句）。晋升作业的例外待办按 item id 投递（`IntegrationResultAftermath.openItemIds`、`ProjectOpenItemService.deliverForItems`）由同期的例外待办工单在 main 上落地，本行不再重复。

**M11**：`docs/project-done-gate.md` 第一节补一句：「`landing = 'LANDED'` 指服务任务都在项目的 upstream 上；在项目分支上的读作 `ON_INTEGRATION_LINE`」。

**M12**：`mechanical-disposition.ts` §2 的最后两句改为：「the account owner drew the line on 2026-09-06 and narrowed it on 2026-09-13: landing on a project branch is the platform's, performed by an integration job; landing on the upstream always goes through the owner's confirmation card. `MERGE_AND_RELEASE_NEXT` remains a decision, never a merge performed from here.」（2026-09-23 修订 3：分号后一句改为 landing on the upstream goes through the owner's confirmation card, except a clean project branch of a project whose Automatic setting is on, which the platform lands itself and leaves a receipt for（M-T11）。）

### 3.6 读模型

`GET /projects/:id/promotions/current` → `ProjectPromotionView`（`ProjectPromotionCard` 的输入）：

```ts
interface ProjectPromotionView {
  promotionId: string;
  state: 'CHECKING' | 'READY' | 'CONFIRMED' | 'RECHECKING' | 'MERGED' | 'BLOCKED';
  sourceKind: 'PROJECT_BRANCH' | 'TASK_BRANCH'; sourceRef: string; upstreamRef: string;
  commitsAhead: number | null; filesChanged: number | null;
  tasks: Array<{ taskId: string; title: string }>;
  checks: Array<{ name: string; command: string; passed: boolean; durationMs: number }>;
  upstream: { syncedAt: Date | null; conflicts: boolean };
  landsTreeSha: string | null; landsAs: 'MERGE_COMMIT' | 'FAST_FORWARD';
  askedAt: Date | null;                                                          // A
  recheck: { upstreamMovedBy: number; startedAt: Date; typicalMs: number } | null;   // B
  merged: { sha: string; byUserId: string; at: Date; openTasksRemaining: number } | null;  // C
  blocked: { why: 'CONFLICT' | 'CHECK_FAILED' | 'ERROR'; files: string[];
             handler: 'COORDINATOR' | 'OWNER'; since: Date; escalatesAt: Date | null } | null;  // D
  openHumanBlockers: Array<{ blockerId: string; kind: string; taskId: string }>;  // B5
  // 修订 12 新增（要求；可选，旧服务端不给）：
  cancelRequested?: boolean;      // 本候选在途的落地作业已请求取消、尚无终态：卡上画「取消中」（M-T10）
  pushBoundaryPassed?: boolean;   // 该作业的当前领取已过推送界线（J-T4）：Cancel 不再可按
  landingSessionId?: string | null;   // 这一轮合入的落地会话（§2.9），合入检查行的整行按压打开它
  // owner 决定 2026-10-15 新增（可选，旧服务端不给）：
  onPass?: 'MERGE' | 'ASK' | null;    // 仅 CHECKING：检查通过后由 Automatic 自动合入（M-T11），还是出卡问 owner（M-T2）
}
```

`onPass` 由 `promotionOnPass` 在读的那一刻算：M-T11 里关于项目的那几条——线、Automatic、未暂停、合入 main 这条路上没有仍欠着的集成类待办——与 M-T11 读同一份事实（`readAutomaticProjectFacts`）；其余几条就是「通过」本身的意思，runner 是否声明 `promotion-automatic-land/v1` 不在其中（报告检查的是哪台 runner，要等它报了才知道）。合入卡「检查中」那一行下面据此写 `Merges on its own when it passes.` / `Asks you when it passes.`（web `promotionOnPassLine`，OrbitKit / Android `PromotionCards.onPassLine`，三端同一句）。

修订 10 的合入卡（web `ProjectMergeStrip`，iOS `ProjectMergeCardView`）据 `cancelRequested` 与 `pushBoundaryPassed` 画「取消中」和 Cancel 的可按与否，不再自己看 `execution.phase`（今天 `ProjectMergeStrip.tsx:173` 只在 `phase === 'PUSH'` 时禁用 Cancel）；旧服务端不给这两个字段时照旧。数字型的 `recheck.upstreamMovedBy`（0294）不变，推送被抢的提交列表是另一个字段 `upstreamMovedCommits`（J-T4）。

`GET /projects/:id/promotions/merged` → `ProjectPromotionView[]`，最近的合入在前（上限 20 条）：这次合入留下的**记录**，画在**它发生的那一刻**：这个项目的 Landings 窗口里一行「Merged into main」（修订 28；按 `merged.at` 排进当天那一组），与这一轮的落地会话按 `landingSessionId` 合成一条，整行在原地展开——回执在上，这一轮自己的记录（检查、推送）在下；落地会话上线之前的合入没有 `landingSessionId`，只展开回执。协调会话里一行（`ProjectPromotionReceipt` 的单行形态，`WorkspaceView` 用 `decisionReceiptAnchor` 按 `merged.at` 落位），点开是同一份回执（修订 10），回执底部的「Open landing ›」进窗口并定位到这一轮。项目 sessions 页的时间线不再画合入行（修订 28 取代修订 10 的这一半）。上限 20 条不变：更早的合入轮有落地会话的，仍按落地会话列在窗口里，展开只有它自己的记录；没有落地会话的更早合入读不到，与修订 10 的时间线相同。

自己的读接口而不是 `current` 的加宽：`current` 是**现在在问**的那个候选，下一个候选一出现它就换人——从它画出来的回执，每次分支再被提议都会说成另一次合入；而在它换人之前，同一张卡就一直待在会话底部，压在之后每一条消息下面（owner 2026-09-21 的报告）。`MERGED` 行是终态且不可变（`project_promotion_terminal_guard`），自带 `merged_sha` / `merged_at`，所以它读回来永远是它当时那次合入。项目页没有转录可以落位，仍按 `current` 画 C 状态那一张。

### 3.7 测试

`scripts/acceptance/project-integration-line.sh` 追加判据 7 的用例：

1. `case_main_sync_merges_upstream_keeps_old_tip`：main 前进后，集成前出现吸收 main 的 merge 提交，旧 tip 仍是祖先
2. `case_unconfirmed_does_not_merge`：未确认时不合入
3. `case_confirm_after_main_moved_rechecks_then_lands`：确认后 main 已前进，先重检再落地
4. `case_lands_no_ff_task_commits_are_ancestors`：main 出现 no-ff 合并提交，任务提交是 main 的祖先
5. `case_project_done_flips_on_merge`：项目 DONE 在合入前后翻转

`src/web/src/components/ProjectPromotionCard.test.tsx`：`renders READY with tasks, checks and the merge button`、`renders RECHECKING with the merge button disabled and a cancel`、`renders MERGED as a receipt`、`renders BLOCKED with the merge button disabled and the handler`。

`src/web/src/components/WorkspaceView.promotionPlacement.test.tsx`：合入的记录画在它发生的那一刻而不是卡片区、`current` 前进后它仍说自己那次合入、没有合入过的项目一张都不画、卡片区不再为已合入的晋升留一张卡；被检查拦下的晋升同样画在它被拦下的那一刻（`decided_at`）、过后消息进来它不动、它仍读待办行说谁在处理、分支重新被呈上时它退场换成卡片区的问句、时间戳读不出来时留在卡片区而不是消失。

`src/apiserver/src/projects/project-promotion-read.spec.ts`：`merged` 只读 `MERGED` 行且最近在前、一次合入带回它自己的提交与任务、二十条历史只各问一次表、没有合入过就不读任务表。

---

## 4. 例外待办

### 4.1 数据结构

**`project_open_item`**（迁移 0278）：

| 列 | 类型 | 约束与语义 |
|---|---|---|
| `id` | uuid(7) PK | |
| `project_id` / `owner_id` | uuid | FK `project` CASCADE |
| `kind` | text | CHECK ∈ {`INTEGRATION_CONFLICT`, `INTEGRATION_CHECK_FAILED`, `INTEGRATION_ERROR`, `TASK_FAILED`, `PROMOTION_APPROVAL`, `COORDINATOR_QUESTION`, `FUSE_PAUSED`, `START_REQUEST`, `DONE_REQUEST`, `DELIVERY_REVIEW`}；修订 12 加 `LANDING_LEASE_EXPIRED`（X-E5，要求：迁移扩 `project_open_item_kind_chk`，同步 `OPEN_ITEM_KINDS`、shared 的 `OpenItemKind` 与 `open-item-doors.ts` 的 `OPEN_ITEM_DOOR_TODO_TYPES`） |
| `state` | text | CHECK ∈ {`OPEN`, `RESOLVED`, `SUPERSEDED`} |
| `assignee` | text | CHECK ∈ {`COORDINATOR`, `OWNER`} |
| `assignee_reason` | text | CHECK ∈ {`DEFAULT`, `NO_COORDINATOR`, `COORDINATOR_ENDED`, `CHAIN_LIMIT`, `ESCALATED`, `HANDED_OVER`} |
| `task_id` / `session_id` | uuid NULL | 相关任务、相关尝试（会话） |
| `integration_job_id` / `promotion_id` / `fuse_episode_id` | uuid NULL | 外键由后建的那三张表各自的迁移补 |
| `asked_by_session_id` | uuid NULL | `COORDINATOR_QUESTION` 的提问会话 |
| `dedupe_key` | text NOT NULL | 部分唯一索引 `(project_id, dedupe_key) WHERE state = 'OPEN'` |
| `title` | text NOT NULL | 创建时由不可变的行生成，英文 |
| `payload` | jsonb NOT NULL | 按种类（X 表） |
| `waiting_since` | timestamptz NOT NULL | 等待起点：创建时刻；「Ask the coordinator again」时重置 |
| `assigned_at` | timestamptz NOT NULL | 负责人最近一次变化的时刻 |
| `escalate_at` / `escalated_at` | timestamptz NULL | 升级时间：负责人为 COORDINATOR 时 = `waiting_since + project.exception_escalation_seconds`，创建或重置时冻结 |
| `remind_at` / `reminded_at` | timestamptz NULL | OWNER 待办的一次性提醒（附录 A-Q9） |
| `resolution` | text NULL | 闭集：`LANDED`、`RETRIED`、`TASK_DONE`、`TASK_CLOSED`、`SUCCESSOR_FILED`、`PROMOTION_MOVED_ON`、`HANDLED`、`APPROVED`、`DECLINED`、`ANSWERED`、`WITHDRAWN`、`RESUMED`；修订 12 加 `JOB_MOVED_ON`（X-E5，要求：同一迁移扩 `project_open_item_resolution_chk` 与 `OPEN_ITEM_RESOLUTIONS`） |
| `resolved_at` / `resolved_by` | timestamptz / text NULL | `resolved_by` CHECK ∈ {`USER`, `COORDINATOR`, `PLATFORM`} |
| `resolved_by_user_id` / `resolved_by_session_id` / `resolution_note` | uuid / uuid / text NULL | |
| `handling_job_id` / `handling_session_id` / `handling_reason` / `handling_started_at` | uuid / uuid / text / timestamptz NULL | 迁移 0368：协调会话 `integration_retry` 重跑这条失败时排的作业、发起的会话、理由、时刻；四列同空同非空，理由 1–2000 字，只许集成类 kind。作业 QUEUED/RUNNING 期间待办仍 OPEN、读作「处理中」（§4.7 H1） |
| `resolved_by_job_id` | uuid NULL | 迁移 0368：终态由哪个集成作业的结果写下——重跑落地/检查通过（HANDLED）或再失败（SUPERSEDED/RETRIED）；只在终态行上非空 |
| `answer` | jsonb NULL | `{ option?: number, text?: string, answeredByUserId }` |
| `superseded_by_item_id` | uuid NULL | |
| `created_at` / `updated_at` | timestamptz | |

CHECK：`(state = 'OPEN') = (resolved_at IS NULL)`；`kind ∈ {PROMOTION_APPROVAL, COORDINATOR_QUESTION, FUSE_PAUSED} ⇒ assignee = 'OWNER'`；`assignee = 'OWNER' ⇒ escalated_at IS NOT NULL OR escalate_at IS NULL`。终态行不可变（触发器 `project_open_item_terminal_guard`）。

**`project_open_item_delivery`**（同一迁移）：

| 列 | 类型 | 语义 |
|---|---|---|
| `id` | uuid(7) PK | |
| `item_id` / `project_id` | uuid | FK CASCADE |
| `session_id` | uuid | 投递目标会话 |
| `purpose` | text | CHECK ∈ {`ITEM`, `ANSWER`} |
| `client_turn_id` | text NOT NULL | G6 前缀 |
| `turn_id` | uuid NULL | 创建的 `conversation_turn` |
| `returned_at` / `return_code` | timestamptz / text NULL | 被排空点退回（X-D5） |
| `created_at` | timestamptz | |

唯一 `(item_id, session_id, purpose)`。「已送达」不单独存列，由 `conversation_turn.delivered_at` 非空派生（`dequeueTurn` 交给 engine 时写）。

**`project` 新增** `exception_escalation_seconds int NOT NULL DEFAULT 7200 CHECK (exception_escalation_seconds BETWEEN 300 AND 604800)`（owner 决定 6，项目可调，写入门 L5）。

命名避开普查：种类常量叫 `OPEN_ITEM_KINDS`，不用 `*_BLOCKER_KIND` / `*_SIGNAL_KIND` 形状，不写 `blockerKind:` 字面量（`blocker-signal-exit-inventory.spec.ts`）；列名不用 `source_session_id` / `trigger_event`（SC7）。

### 4.2 种类、来源与终态

| kind | 默认负责人 | 产生它的已提交事实 | `dedupe_key` | payload | 终态事实 → resolution |
|---|---|---|---|---|---|
| `INTEGRATION_CONFLICT` | COORDINATOR | 集成作业 `CONFLICT`（J-T7） | `IC:<jobId>` | `{ jobKind, phase, targetRef, targetSha, files[], nothingLanded: true, landingSessionId?, round? }` | **`integration_retry` 不收冲突**（J-T1b，T17 起这一格连那扇门都没有，§4.7）：没有任何重跑会回答它。它进「处理中」是**退回返工**那条（H1 的第四个触发点，T15）：`task_reopen` 后新一代 DONE，旧卡记上 `handling_*` → 仍 OPEN；那一代落地 → `RESOLVED / HANDLED`（H2，记发起会话与理由）；再冲突 → `SUPERSEDED / RETRIED`，`superseded_by_item_id` 指向新待办（H3）。任务落地 → `LANDED`（`PLATFORM`）；任务取消 → `TASK_CLOSED`（`resolveByFact` 的第二条，`PLATFORM`）；被 successor 取代 → `SUCCESSOR_FILED`（同一条，与门表 `taskRepair` 给 `task_create` 声明的结局一致——集成类待办被接替时也说「被接替了」，与任务自己那条、交付评审那条同一张表）；候选离开活跃状态的每条路 → `PROMOTION_MOVED_ON`（被取代时连 state 一起写成 `SUPERSEDED`，§3.3 的表）；`open_item_resolve` → `HANDLED`；对账兜底 → 同名结局 + `resolution_note` 以 `backstop:` 开头（本节末） |
| `INTEGRATION_CHECK_FAILED` | COORDINATOR | 集成作业 `CHECK_FAILED` | `ICF:<jobId>` | `{ jobKind, check: { name, command, exitCode, expectedExitCode, durationMs, outputTail }, branchUnchanged: true, landingSessionId?, round? }` | **可重跑**（J-T1b，T17 起这一格真有一扇重跑门，§4.7）：协调会话或 owner 的 `integration_retry` 重排/重检 → 仍 OPEN、处理中（H1）；那次作业落地或检查通过 → `RESOLVED / HANDLED`，记发起会话（或发起 owner）与理由（H2）；再失败 → `SUPERSEDED / RETRIED`，`superseded_by_item_id` 指向新待办（H3）。任务落地 → `LANDED`（`PLATFORM`）；任务取消 → `TASK_CLOSED`（`resolveByFact` 的第二条，`PLATFORM`）；被 successor 取代 → `SUCCESSOR_FILED`（同一条，与门表 `taskRepair` 给 `task_create` 声明的结局一致——集成类待办被接替时也说「被接替了」，与任务自己那条、交付评审那条同一张表）；候选离开活跃状态的每条路 → `PROMOTION_MOVED_ON`（被取代时连 state 一起写成 `SUPERSEDED`，§3.3 的表）；`open_item_resolve` → `HANDLED`；对账兜底 → 同名结局 + `resolution_note` 以 `backstop:` 开头（本节末） |
| `INTEGRATION_ERROR` | COORDINATOR | 集成作业 `ERROR`（含 Abandon 写的 `RUNNER_LOST` / `PUSH_OUTCOME_UNKNOWN`，J-T10）；或入队前拒绝 `INTEGRATION_REPOSITORY_UNKNOWN`。被叫停的那一代（作业带 `cancel_requested_at`）的 `ERROR` 不开，不论是 runner 报的还是放弃写的（J-T8）；没被叫停的作业被放弃照开 | `IE:<jobId>` 或 `IE:task:<taskId>` | `{ errorCode, errorDetail, landingSessionId?, round?, upstreamMovedCommits? }`（最后一项只在 `TARGET_MOVED`，J-T13） | **可重跑**（J-T1b，T17 起这一格真有一扇重跑门，§4.7）：协调会话或 owner 的 `integration_retry` 重排/重检 → 仍 OPEN、处理中（H1）；那次作业落地或检查通过 → `RESOLVED / HANDLED`，记发起会话（或发起 owner）与理由（H2）；再失败 → `SUPERSEDED / RETRIED`，`superseded_by_item_id` 指向新待办（H3）。任务落地 → `LANDED`（`PLATFORM`）；任务取消 → `TASK_CLOSED`（`resolveByFact` 的第二条，`PLATFORM`）；被 successor 取代 → `SUCCESSOR_FILED`（同一条，与门表 `taskRepair` 给 `task_create` 声明的结局一致——集成类待办被接替时也说「被接替了」，与任务自己那条、交付评审那条同一张表）；候选离开活跃状态的每条路 → `PROMOTION_MOVED_ON`（被取代时连 state 一起写成 `SUPERSEDED`，§3.3 的表）；`open_item_resolve` → `HANDLED`；对账兜底 → 同名结局 + `resolution_note` 以 `backstop:` 开头（本节末） |
| `LANDING_LEASE_EXPIRED`（修订 12，要求） | OWNER（`assignee_reason = ESCALATED`，开出即写 `escalated_at`，`escalate_at` 为 NULL，不投递协调会话） | X-E5：RUNNING 作业的当前领取 `LEASE_EXPIRED`（§7.2 V6，含 legacy 的界线）已超过 15 分钟 | `LE:<jobId>:<claimGeneration>` | `{ jobId, jobKind, claimGeneration, runnerId, runner?, lastReportAt, heartbeatAt, leaseExpiredAt, generation, phase, step?, round?, checkIndex?, checkCount?, progressProtocol?, pushReported, landingSessionId? }`（`open-item-escalation.service.ts` 写的全部字段，每个键都在，`?` 表示值可能为 null，`progressProtocol` 在 legacy 领取上为 null；`checkIndex` / `checkCount` 是当前检查的序号与条数）。卡上的 Step 事实行写 `<步骤> · claim N · round R of 3`（`LAND_TASK`）或 `<步骤> · claim N · round R`（另两种）：`of` 后的数按 `jobKind` 取（§7.2 V6），不取 `checkCount` | 同一领取再回报、新领取（接管）回报、release、作业进入任何终态（含 Abandon）→ `RESOLVED / JOB_MOVED_ON`；owner 的 `open_item_resolve` → `HANDLED` |
| `TASK_FAILED` | COORDINATOR；链上第 3 次 → OWNER（`CHAIN_LIMIT`） | 任务失败的全部来源（§4.3） | `TF:<taskId>:<sessionId>`；没有会话时 `TF:<taskId>:write:<n>` | `{ how, exitCode?, expectedExitCode?, error?, chain: { rootTaskId, failuresInChain, limit } }` | 任务 DONE → `TASK_DONE`；FAILED → IN_PROGRESS（`clearFailedForRetry`）→ `RETRIED`；被 successor 链接 → `SUCCESSOR_FILED`；取消 → `TASK_CLOSED`；`open_item_resolve` → `HANDLED`；对账兜底 → 同样按这四个事实写（本节末） |
| `PROMOTION_APPROVAL` | OWNER | 晋升 `READY`（M-T2） | `PA:<promotionId>` | `ProjectPromotionView` 的快照 | 确认 → `APPROVED`；Not now → `DECLINED`；新候选 → `SUPERSEDED`；卡片之外的合入回执（M-T13）→ `RESOLVED / PROMOTION_MOVED_ON` |
| `COORDINATOR_QUESTION` | OWNER | `ask_owner` 提交（§5.2） | `CQ:<clientQuestionId>` | `{ question, options: [{ label, description? }], recommendedOption?, blocksTaskIds[], ifUnanswered }` | owner 答复 → `ANSWERED`；提问会话撤回 → `WITHDRAWN` |
| `FUSE_PAUSED` | OWNER | 暂停段插入（§6.3） | `FP:<episodeId>` | `{ dimension, observed, limit, spendToday, heldCount }` | 恢复 → `RESUMED` |
| `DELIVERY_REVIEW` | COORDINATOR（Automatic 且有活着的协调会话；否则 OWNER） | `CRITERION_UNLANDED` 读到声明外改动、git 拒绝合并，或任务写了保留被质疑的完成判据的理由（`CRITERION_EXEMPTION_ARGUED`；2026-10-14 之前是 owner 的 blocker）。判据下的任务每次重新全部 DONE（比如兄弟任务刚转 DONE）都会再派生这条事实，但一份交付只问一次（2026-10-15 起；owner 的 `ACCEPTANCE_STANDARD_MOVED` blocker 同理）。「这份交付」指任务上次被打回之后交出的东西：它的工作已落地的不再读；git 拒绝合并只认这份交付的 CONFLICT 回执——打回之前被拒的那次合并拒的是被打回的那份，重新交付在自己被 git 拒绝之前不读成 git 拒绝（2026-10-16 起，`wake-disposition.service.ts#deliveriesUnder`）；同一读数在这份交付里答过的（答在这里，或答在旧路由的 blocker 上）不再问；还开着的不重提、照旧挡住合并，但不挡排在后面的任务——先问没被问过的。被打回、重新交付后重新检查（`wake-disposition.service.ts#blockerFor`）。为此被打回过的任务把它的生命周期纪元并进这条事实的版本：哪怕判据下其他任务的状态都没变（比如判据只有它一个任务），重新交付也会再派生一次事实、再读一遍读数、再告诉协调会话；从没被打回过的判据，版本与以前逐字节相同（2026-10-16 起，`coordinator-wake.ts#deliveryVersion`） | `DR:<reason>:<taskId>` | `{ reason, paths[], declaredPaths[], criterionKey, argument? }`（`argument` 只在豁免理由的读数上有：那段理由的原文） | 重开 → `RETRIED`；取消 → `TASK_CLOSED`；取代 → `SUCCESSOR_FILED`；成果落地 → `LANDED`（git 拒绝与豁免理由两种读数；只认这份交付的落地：打回之前的回执关不掉重新交付后问的问题，owner blocker 的落地自动解除同理，2026-10-16 起，`wake-disposition.service.ts#resolveLandedBlockers`）；`open_item_resolve` → `HANDLED`；对账兜底 → 同样按这三个事实写（本节末） |
| `LANDING_UNOBSERVED`（修订 29） | COORDINATOR（Automatic 且有活着的协调会话；否则 OWNER，与 `DELIVERY_REVIEW` 同一规则） | 已 DONE 的代码任务：`AGENT_PUSH` 下观测没看到它的工作在线上（§10.6 O-R4）、空分支而有会话报告过工作（§10.5 O-L7 的 `WORK_ELSEWHERE`），或交付身份不明（§10.6 O-T1） | `LU:<taskId>:<deliveredSha>`；身份不明时 `LU:<taskId>:identity` | 原因、交付身份与观测到的两个 tip（§10.7） | 该任务写下落地回执（观测、`merge_receipt`、平台合入）→ `RESOLVED / LANDED`；取消、被接替、`task_reopen`、声明 codeless 的结局见 §10.7。**没有 `HANDLED`**：`open_item_resolve` 拒绝它（`OPEN_ITEM_HAS_ITS_OWN_DOOR`），门见 §4.7 |
| `LANDED_WITHOUT_CONFIRMATION`（修订 29） | OWNER（`assignee_reason = DEFAULT`；不升级、不提醒、不投递协调会话） | `PLATFORM` 的 `MAIN` 线上，一条落在 upstream 的回执既不是 M9 的、也不是 owner 本人按 Merge 写的：工作没走 owner 确认就进了 main（§10.6 O-R3） | `UL:<taskId>:<receiptId>` | 那张回执的事实（§10.7） | owner 按 Accept → `RESOLVED / ACCEPTED`（`resolved_by = USER`）；任务取消或被接替 → 照 `resolveByFact` 写。**没有 `HANDLED`**：它的门是 Accept，`open_item_resolve` 拒绝它（`OPEN_ITEM_HAS_ITS_OWN_DOOR`）；它从不投递协调会话，「让协调会话再看一次」也拒绝它（`OPEN_ITEM_NOT_RETURNABLE`） |

修订 29 的两种 kind 都不是 `INTEGRATION_*`，不挡 M-T11；`openItemOwed` 为它们各加一支（§10.7）。同一迁移扩 `project_open_item_kind_chk` 与 `project_open_item_resolution_chk`，resolution 加 `ACCEPTED`、`CODELESS`（§10.4）。谁先处理：`LANDING_UNOBSERVED` 先归协调会话，它处理不了用 `open_item_hand_over` 交给 owner；`LANDED_WITHOUT_CONFIRMATION` 是授权问题，直接归 owner（§10.7）。

三种集成类**失败**待办的 payload 另带 `failureClass`（`CONFLICT` / `CHECK_FAILED` / `CHECK_TIMED_OUT` / `ERROR`）与 `generation`；由 `integration_retry` 要求的那一代失败时再带 `retry: { retryOfJobId, failureClass, reason, requestedBySessionId }`（J-T1b）。修订 12（要求，新字段一律可选）再带：`landingSessionId`（这次尝试所属落地会话，入队时就定了）、`round`（失败发生在本次领取的第几轮）与 `upstreamMovedCommits`（只在 `LAND_PROMOTION` 的 `TARGET_MOVED`，形状见 J-T4）。三者都是平台测到的事实；`upstreamMovedCommits` 是自己的字段、不放进 `errorDetail`，因为 `errorDetail` 会被原样抄进 payload（`integration-job-relay.ts:982`）和投递文本（`project-open-item.ts#integrationItemFacts`）。投递文本的生成器不读这三个字段，G6 的逐字节重放不受影响。X-E5 的租约提醒是另一种 kind（`LANDING_LEASE_EXPIRED`）：它说的作业仍 RUNNING，不编造 `failureClass`，不在 `INTEGRATION_ITEM_KINDS` 里，也不适用失败待办的重跑与处理中规则（J-T1b、H1–H5）。

标题（英文，取自效果图）：`Merge conflict: <task>`、`Checks failed on the combined tree: <task>`、`Integration error: <task>`、`Task failed: <task>`、`Approve merge to main`、`Coordinator asks: <question>`、`The coordinator paused itself`；修订 12 加 `No word from the runner: <task>`（晋升作业写 `Merge check` / `Merge to main` 代替任务名）；修订 29 加 `Not on <branch> yet: <task>` 与 `Reached <branch> without your confirmation: <task>`（`<branch>` 为短名，§10.7）。

**关闭边与对账兜底（T1–T2 / T9 / T15，2026-10-03 起落地）**。一条待办由**移动了它所说的那件事的那个写入**关闭。多数边写在与事实**同一条事务**里（落地回执、候选离开活跃状态）；任务侧那几条走 `resolveByFact`，它由调用方在**自己的提交之后**调（`tasks.service.ts` 与 `runner-api.controller.ts` 的六个调用点），且整个包在 `guarded` 里——出错只写一行 `warn` 日志、不抛，所以它可能整条没写成，而调用方的提交照常生效。这正是需要兜底的原因（§4.6 的 `reconcile`）。`resolution_note` 分得开两种来源：兜底写的以 `backstop:` 开头并点名事实（`promotion <id>@<state>` / `task <id>@<status>`），边写的不带这段。

| 待办说的对象 | 关它的边 | 结局 |
|---|---|---|
| 任务的集成落地（三种集成类） | J-T5 的任务落地回执，**同一事务**（`resolveHandledItems` 先走 H2，再 `resolveIntegrationItemsOnLanding`）；修订 29 的观测回执同样走这条边，并同样关掉 `LANDING_UNOBSERVED`（§10.6 O-R1） | `RESOLVED / LANDED`，`PLATFORM` |
| 同上 | 任务被取消 / 被 successor 取代：`resolveByFact` 的第二条（**提交后**的边沿）。它判 `status = 'CANCELLED'` 或 `superseded_by_task_id IS NOT NULL`：被取代写 `SUCCESSOR_FILED`，取消写 `TASK_CLOSED`——与门表 `taskRepair` 给 `task_create` 声明的结局一致（§4.2 的 kind 行） | `RESOLVED / SUCCESSOR_FILED`（取消时 `TASK_CLOSED`），`PLATFORM` |
| 晋升候选（三种集成类） | 候选离开活跃状态的每一个出口（§3.3 的表，`closePromotionItems` / `retireCandidatesLandedByReceipt`），**同一事务** | `PROMOTION_MOVED_ON`；被取代时 state 为 `SUPERSEDED`，其余 `RESOLVED`，`PLATFORM` |
| 审批卡本身 | owner 按确认 / Not now（`resolveApprovalItem`，**同一事务**）| `APPROVED` / `DECLINED`，`USER`。M-T6 / M-T13 也关它：被取代时 state `SUPERSEDED`，被回执退役时 `RESOLVED`，都是 `PROMOTION_MOVED_ON` / `PLATFORM` |
| 任务的失败 | 任务 DONE / 取消 / 被取代 / 重跑：`resolveByFact` 的第一条（**提交后**的边沿）。`clearFailedForRetry` 本身只把任务改回 `IN_PROGRESS`，`RETRIED` 由 `resolveByFact` 写 | `TASK_DONE` / `TASK_CLOSED` / `SUCCESSOR_FILED` / `RETRIED`，`PLATFORM` |
| 交付评审 | 任务离开 DONE 交付，或被取代：`resolveByFact` 的第三条（**提交后**的边沿） | `RETRIED` / `TASK_CLOSED` / `SUCCESSOR_FILED`，`PLATFORM` |
| 任何一条，人工收口 | `open_item_resolve`（负责人本人，带理由） | `RESOLVED / HANDLED`。**有自己那扇门的不在此列**：`PROMOTION_APPROVAL`（确认 / Not now / Cancel）与 `FUSE_PAUSED`（Resume）被这个入口拒绝（`OPEN_ITEM_HAS_ITS_OWN_DOOR`），修订 29 的 `LANDING_UNOBSERVED` 与 `LANDED_WITHOUT_CONFIRMATION`（它的门是 Accept）同样（§10.7）；提问由提问会话撤回时记 `WITHDRAWN`，不是 `HANDLED`。任务落地类集成待办在条件仍在时也不能这样关（修订 29，§10.7 O-X1，见 §4.7「标记已处理」） |

**兜底**（`ProjectOpenItemEscalationService.reconcile`，与升级同一拍、排在它之前）：`WHERE state = 'OPEN' AND NOT openItemOwed(alias)` 的所有行，一次 `UPDATE … RETURNING` 就地关掉。它按 kind 写出漏掉的那条边会写的结局，读的还是同一行 `task` / `project_promotion`：`promotion_id` 非空 → `PROMOTION_MOVED_ON`（state 写 `SUPERSEDED` 当且仅当候选当时就是 `SUPERSEDED`，否则 `RESOLVED`）；`TASK_FAILED` → `resolveByFact` 第一条的 CASE（DONE `TASK_DONE`、被取代 `SUCCESSOR_FILED`、取消 `TASK_CLOSED`、正在重试 `RETRIED`）；任务的集成类 → 第二条（被取代 `SUCCESSOR_FILED`、取消 `TASK_CLOSED`）；交付评审 → 第三条（离开 DONE `RETRIED`、被取代 `SUCCESSOR_FILED`、取消 `TASK_CLOSED`）。一律 `resolved_by = PLATFORM`，`resolution_note` 以 `backstop:` 开头并点名 `promotion <id>@<state>` / `task <id>@<status>` 与它此刻的事实（「候选不再活着」「不是 READY，卡片问不出什么」「被 task <id> 接替」「离开 DONE 交付」「离开失败」「正在被再次尝试」「被取消」）——兜底事后才知道这条边漏了，所以它写事实当时的样子，而不是替那条边说话。它同时给被关掉 item 的 owner 记一次角标重算。

覆盖到哪些、覆盖不到哪些，都从谓词来（`project-open-item.ts#openItemOwed`）：兜底关得掉的是**那个谓词判死不欠**的行——候选已不在活跃状态的 `PROMOTION_APPROVAL`（READY 之外）与集成类、任务被取消或被接替的集成类、任务已 DONE / 已取消 / 被接替 / 正在重试的 `TASK_FAILED`、任务不再处于 DONE 交付的 `DELIVERY_REVIEW`。**它碰不到的**：`COORDINATOR_QUESTION`、`FUSE_PAUSED`、`START_REQUEST`、`DONE_REQUEST` 一律落进谓词的 `ELSE true`（这些由人、或由它们自己那条事实回答，谓词没有行可读）；还有「任务已落地、但落的不是这条线」的集成类——工作落在别的分支这件事没有任何一行说得清——它们照样欠着，兜底只记一条 `backstop left … open` 的日志（进程内每个 item 一次）。

任务侧三族（失败、集成、交付评审）的结局与漏掉的那条边同源：两边读同样的行、按同样的顺序判，`open-item-owed.pg.spec.ts` 的第 (6) 例把同一形状的两条 item 一条交给兜底、一条交给 `resolveByFact`，断言两者写出的 resolution 相同。**唯一还对不上的**是晋升类里的 M-T13：由回执退役的候选，边（`retireCandidatesLandedByReceipt`）给 item 写 `RESOLVED`，而候选行此刻是 `SUPERSEDED`，兜底照候选自己的 state 写 `SUPERSEDED`——`state` 这一列兜底取的是候选的状态，`resolution`（`PROMOTION_MOVED_ON`）两边一致。

它是 CAS（只选 OPEN 且不欠的，同一条语句把它们移出这个集合），两副本同时跑各关一次、下一拍什么也找不到。各读者（`GET /projects/:id/open-items`、owner items / needs-you、推送与角标、项目列表注意力、升级 sweep、M-T11 的 `automaticLandingRefusal`）不等这一次写：它们读的是同一个谓词，所以一条漏掉的边当场就不在任何人的清单里，兜底只是把 `state` 补上。

### 4.3 FAILED 的全部来源

共用 `ProjectOpenItemService.recordTaskFailure(tx, { taskId, sessionId, how, detail })`，与失败写入同一事务：

| # | 来源 | 挂接点 | `how` |
|---|---|---|---|
| A | EXECUTABLE 验收退出码不一致 | `RunnerApiController.turnComplete` 写 FAILED 的 CAS 处 | `ACCEPTANCE_EXIT_MISMATCH` |
| B | 普通任务轮次以 FAILED 结束 | `reclaimStalledTask(tx, taskId, FAILED)`（`turnComplete` 的 failTask） | `RUN_FAILED` |
| C | runner `/finalize`（含已废弃的 `/complete`） | `reclaimStalledTask(…, FAILED)` | `RUNNER_FINALIZED_FAILED` |
| D1 | reaper API / 登录错误兜底 | `ReaperService.forceFinalize` → `reclaimStalledTask(…, FAILED)` | `REAPED_API_ERROR` |
| D2 | reaper：runner 失联、运行时未初始化，把任务重置为 OPEN | `forceFinalize` 的这两个分支，显式调用 | `ATTEMPT_LOST_RUNNER_OFFLINE`、`ATTEMPT_LOST_RUNTIME_NOT_INITIALIZED` |
| E | agent 或 owner 经 `task_update` 写 FAILED | `TasksService.update`，`dto.status === FAILED` 的写入之后 | `REPORTED_FAILED` |

- B、C、D1 在 `reclaimStalledTask` 内部统一调用（加一个 `cause` 参数），避免三处漏一处。
- 不产生待办的结束：有人请求了取消（`gracefulEndStatus` 的取消分支、reaper 的 cancel-not-honored）；任务没有 `project_id`。
- auto-retry 已武装（`retry_at` 非空）的失败同样产生待办；重试把任务带回 IN_PROGRESS 时，按 `RETRIED` 解决。
- 新增普查 `src/apiserver/src/projects/task-failed-open-item-sites.spec.ts`：apiserver 里每一处把 task 写成 FAILED 的方法，要么在同一方法内调用 `recordTaskFailure`，要么经过 `reclaimStalledTask`。
- `ATTEMPT_ENDED_UNSETTLED` 的 wake 行照常记录，但不再开判断会话（C4）；失败的处理只有这一个通道。
- `attempt-ended-unsettled.producer.ts` 保持未注册的现状，不复活。

### 4.4 投递保证

**X-D1（投给谁）**：负责人为 COORDINATOR 的待办，投给**投递时刻**的 `project.coordinator_session_id`。

**X-D2（怎么投）**：`ProjectOpenItemService.deliver(itemId, sessionId)` 调 G6 载体。钩子里同一事务：确认待办仍 OPEN 且负责人仍是 COORDINATOR；确认会话未结束（G6 的判定），否则抛错不写轮次；插入 `project_open_item_delivery(purpose = ITEM)`，唯一键冲突则什么也不做。`clientTurnId = open-item:v1:<itemId>:<assignedAtMs>`；`content` 由 `title`、`payload` 与可用的工具（`integration_retry`、`open_item_resolve`、`open_item_hand_over`）生成。

**X-D2b（文本之外还记一份读数）**：轮次的 `content` 是写给 agent 的一段话，读完就只剩这句话了。回声落库时
（`runner-api/runner-api.controller.ts#events`，与 `controlPlaneNote` 同一处、同一条规矩：只有控制面能写）
另外记一份结构化读数 `openItemDelivery`（`OpenItemDeliveryCard`，组成在
`projects/project-open-item.ts#readOpenItemDeliveryCard`）：种类、标题、冲突文件、检查与失败链、可选动作，
以及平台已经知道的那条落地事实（该任务有没有合并回执、成果在不在上游，走
`project-criterion-landing` 的三值折叠）。这份是给客户端画卡用的，**不是**给 agent 的输入；没有这份载荷的投递
按原来的文本块渲染，不会被猜成卡。三个客户端都读它：web 的画在 `OpenItemDeliveryCard.tsx`，iOS/macOS 的画在
`OrbitKit/Transcript/OpenItemDelivery.swift`（解码＋文案）与 `OrbitApp/Views/OpenItemDeliveryCardView.swift`（视图），
两端文案由 `OpenItemDeliveryCopyParityTests` 逐句对住。轮次还没被领走时这份读数也要能画：`GET /sessions/:id/turns`
的两个投影都带上它（`view=active` 与默认的那个，`sessions.service.ts#listQueuedTurns`）——排队尾部画的是同一张卡
（卡片脚下多一行队列自己的状态），所以领走时形状不变；默认投影是原生客户端读的那一个，只给 `active` 就等于让手机
在排队期间读散文、浏览器读卡片。

**X-D3（忙不是拒绝）**：`NEXT_TURN` 轮次排在正在跑的轮次与未读消息之后，`turnComplete` 提交、`dequeueTurn` 交出下一条时送到 engine。这就是「在其轮次结束的提交事实上投递」，不需要另外的重试。现有 `CoordinatorDeliveryService` 对 `PENDING` 会话的拒绝走的是 `resume` 的复活分支；G6 不走 `resume`，没有这条拒绝。

**X-D4（在哪些事实上尝试投递）**：

1. 待办插入（或负责人改回 COORDINATOR）的事务提交后；
2. 协调会话绑定或轮换的提交后（`ProjectsService.coordinator` 的指针 CAS）：给新会话投递全部 OPEN 的协调会话待办；
3. 协调会话每一次 `turnComplete` 提交后：补投本项目 OPEN、且没有投给本会话未退回投递行的协调会话待办。这是进程死在 1 与提交后边沿之间时的补偿点；
4. 被退回的投递（X-D5）在 3 上自然补投。
5. 修复任务落地（修订 13）：任务的 `LAND_TASK` 写下回执的同一事务里（`LANDED` / `ALREADY_LANDED`，或任务没有自己工作的 `NOTHING_TO_LAND`；J-T1e 交给下一代的那种 `ALREADY_LANDED` 不算），它 `fixes_open_item_id` 指向的待办若仍 OPEN、归协调会话、不是晋升的（`promotion_id IS NULL`——晋升待办随新候选由平台关闭），就把 `assigned_at` 改为此刻（`waiting_since`、`escalate_at` 不动，与 X-D5 换键同一做法），提交后按第 1 条投递。新键下的文本在原文前加一段「修复已落地」：哪个修复任务（只写 id，标题会改，G6）、落在哪条分支的哪个提交、结果是什么，以及下一步——原任务的提交已在目标分支上就 `open_item_resolve` 写明理由关掉，不在就 `integration_retry` 重排原任务的落地，要 owner 拍板就 `ask_owner`。平台不因修复落地关闭待办：服务端没有 git，判断不了原任务的工作是否随修复一起上了线（§2.9 任务段结案第 4 条仍由协调会话的 `open_item_resolve` 收口）。这一段只由修复任务的 id 与它已终了的落地作业行派生，同一键重放逐字节一致（G6）。

**X-D5（排空点退回）**：在 G6 列出的四个排空点，以及打断与撤回的删除点，排空之前调用 `ProjectOpenItemService.returnQueuedTurns(tx, sessionId, { code, ending })`：本会话尚未 `delivered_at` 的平台轮次对应的投递行写 `returned_at` / `return_code`。`ending = true`（会话正在结束）时，同一事务把这些待办改为 OWNER / `COORDINATOR_ENDED`，提交后推送 `escalated-to-you`；`ending = false`（打断、撤回）时待办保持 OPEN，等 X-D4 第 3 条补投。例外是运行失败带来的排空（失败的轮次、runner 以 FAILED finalize、reaper）：会话 FAILED、没有 `end_reason`、仍在 Open（`conversationIsDown`），是挂了而不是结束了，待办仍归 COORDINATOR，同一事务只把 `assigned_at` 改为此刻——被排空的轮次原地保留、占着旧键，不换键下一次投递就成了一次重放——`waiting_since` 与 `escalate_at` 不动，等会话被重试后由 X-D4 第 3 条补投，窗口内没回来就由 X-E1 升级。

**X-D6（没人可投）**：创建时项目没有协调会话，或会话已结束 → 负责人直接为 OWNER（`NO_COORDINATOR` / `COORDINATOR_ENDED`），推送 `escalated-to-you`。会话只是挂了（`conversationIsDown`：运行失败——API 错误、登录过期、runner 掉线——且没人结束它）不算已结束：负责人仍为 COORDINATOR。`createTurn` 不往 FAILED 会话上写轮次，所以待办先不投，等会话被重试、下一轮结束时由 X-D4 第 3 条补投；窗口内没回来由 X-E1 升级。投递时（X-D4 第 1 条）同理：`createTurn` 以会话不可发拒绝时重读会话，只有真正结束（`conversationIsOver`）才交给 owner。

**X-D7**：OWNER 待办不投给会话，owner 在卡片与推送里看到。其中 `COORDINATOR_QUESTION` 的答复投给协调会话（§5.2）。

### 4.5 重试链上限

**X-C1（链）**：从任务沿 `superseded_by_task_id` 反向找到根（没有前驱指向它的任务），链 = 根及其全部后继（递归 CTE，至多 256 跳，与 `task_dependency_tail_id` 一致）。

**X-C2（计数）**：`failuresInChain` = 链内任务上 `kind = TASK_FAILED` 的待办数（不论状态），只数链内最后一次 DONE 之后创建的。取消不产生待办，所以不计。

**X-C3**：插入 `TASK_FAILED` 时 `failuresInChain`（含本条）≥ `TASK_FAILURE_CHAIN_LIMIT = 3` → 负责人 OWNER、`assignee_reason = CHAIN_LIMIT`、`escalate_at = NULL`，推送 `escalated-to-you`。payload 的 `chain` 字段让卡片写出「attempt 2 of 3 in this chain」。

### 4.6 超时升级（唯一新增的时钟）

**X-E1**：新文件 `src/apiserver/src/projects/open-item-escalation.service.ts`，`ProjectOpenItemEscalationService` 注册在 ProjectsModule，`onModuleInit` 起 `setInterval(60_000)`。它不放进 `tasks.service.ts`（那里只许一个 interval）、不放进 PushModule（`judgment-delivery-removal.spec.ts` 钉死 providers）、不新增 compose 服务或 `start:*` 脚本。

**一拍里有几步，按这个顺序**（每一步都只写这一拍该写的、别的一概不写）：

1. **`reconcile()`——对账兜底，排在最前**（T2，2026-10-03 落地）：把 `state = 'OPEN'` 且 `NOT openItemOwed(item)` 的每一行关掉，按 kind 写出漏掉的那条边会写的结局（任务侧三族照 `resolveByFact` 三条 CASE、候选写 `PROMOTION_MOVED_ON`——§4.2「关闭边与对账兜底」有对照表与唯一还不同的那一处），`resolution_note` 以 `backstop:` 开头并点名事实，被关掉 item 的 owner 各记一次角标重算；剩下的集成待办只有「工作落在别的分支上」那一类，**只记日志、不关**。它排在最前，这样随后交给人的只是还有人欠着的。它的失败不连累第 2 步（`sweep` 自己问同一个谓词）。
2. **`sweep()`——升级**：把「已到期且仍欠着」的协调会话待办交给 owner：

    ```sql
    UPDATE project_open_item item
       SET assignee = 'OWNER', assignee_reason = 'ESCALATED', assigned_at = now(),
           escalated_at = now(), updated_at = now()
     WHERE item.state = 'OPEN' AND item.assignee = 'COORDINATOR' AND item.escalate_at <= now()
       AND escalatesAt(item) <= now()
       AND openItemOwed(item)
    RETURNING id, project_id;
    ```

3. **提交后推送**：对 `sweep` 的 RETURNING 行调用 `PushService.notifyOwnerItem`。`@Optional()`：没有 PushModule 的构建照样升级——归属是事实，横幅只是它的一个读者。

**对账在同一个 tick 里，仍然只有这一个时钟**：它不新增 `setInterval`、不落新服务，也不产生任何 agent 会跑的东西（不写 `conversation_turn`、`session`、`project_coordinator_wake`、投递行）。多副本下 `reconcile` 与 `sweep` 本身都是 CAS：只选 `state = 'OPEN'` 且符合条件的行，同一条语句把它们移出这个集合，两个 apiserver 同时跑各关 / 各升级一次，下一拍什么也找不到，推送也就只发一次。

**`remind_at` 的一次提醒今天没有实现**：附录 A-Q9 的默认做法（OWNER 待办到期提醒一次）需要第三条语句 `UPDATE … SET reminded_at = now() WHERE state = 'OPEN' AND assignee = 'OWNER' AND remind_at <= now() AND reminded_at IS NULL`，而线上这一拍只有上面两步——`remind_at` 在提问时写下（`askOwner`），`reminded_at` 至今没有写入方。要做就加在这同一拍里，不加新时钟。

「到期」看的是**这件事的进展**，不是待办的年龄（`escalatesAt`，定义在 `open-item-escalation.service.ts`；§4.8 的 `escalateAt` 与项目列表的 `nextEscalationAt` 读同一个表达式，卡片倒数的就是时钟会动手的那一刻）。它是 SQL 里的一个 `CASE`，先看两种**没有截止时间**的情形：

- **有活的修复在手上**：这条待办挂了修复任务（`task.fixes_open_item_id`，0379）而它 IN_PROGRESS，或它的工作会话活着（未结束、未归档、未请求取消），或 H1 的重跑作业 QUEUED/RUNNING。这一档待办仍 OPEN，但不会在操作进行到一半时被交出去。
- **被接手了**（修订 13，见下）。

其余按 `GREATEST(escalate_at, 最后推进 + (escalate_at − waiting_since))` 计。「最后推进」取这条待办**自己的事实**里最新的一个：它那次投递轮次的 `answered_at`（`purpose = ITEM`、`kind = 'message'`）、挂在它上面的修复任务的 `updated_at`（新建或 `task_update` 挂上都算）、那些修复任务的工作会话的 `COALESCE(last_turn_at, created_at)` 与结束时刻取大的一个、H1 重跑的开始（`handling_started_at`）与结束（作业的 `finished_at`）。与这条待办无关的聊天轮次不算：那是对话在动，不是这件事在动。于是接手之后还在推进的会话一直持有它；卡住、停下或结束的会话在停下满一个窗口后交出；从没送到的待办照旧在 `escalate_at` 交出。**时钟只读这些行，一行也不写**；升级之后的归属不变——待办归 owner，协调会话的「标记已处理」照旧被拒（`OPEN_ITEM_NOT_COORDINATOR_ITEM`），X-E3 的终态事实照常解决它。

**接手之后不升级（修订 13，owner 2026-10-08 决定）**：协调会话接手了的待办没有升级时刻（`escalatesAt` 为 NULL），不论它处理了多久。「接手」= 项目此刻的协调会话回答过这条待办的投递轮次：该会话上 `client_turn_id` 以 `open-item:v1:<itemId>:` 开头、`kind = 'message'`、`answered_at` 不早于 `waiting_since` 的轮次存在（「Ask the coordinator again」重置 `waiting_since`，所以要在按下之后回答才算，按下之前的答复不算），并且这条会话此刻仍能接着处理：项目 `coordinator_enabled`，会话没进 Trash、没被 Completed、没被请求结束，status 为 `PENDING`、`RUNNING`、`AWAITING_INPUT`，或没有 `end_reason` 的 `INTERRUPTED`（挂了的 `FAILED` 不算）。处理中要 owner 拍板的事，由协调会话用 `ask_owner` 问，待办仍留在它那里；必须由 owner 亲手处理的事，它用 `open_item_hand_over` 带说明交出（§4.7）。平台不替它判断「处理得太久」。时钟只兜两种情况：没人接手（投递一直没被回答——会话卡在前一轮、从没送到），和接手的会话不在了（挂了、结束、被换掉，或项目关了 Automatic）；这两种按上面那条式子和那份进展清单计。缘由：项目 `34a0e97BOc6shsNLJbIuM` 的合并检查红了（待办 `34c46hi0h8KK9096z0ZyR`），协调会话 8 分钟内查明原因、建了修复任务，待办开出 27 分钟后修复就落了地、随后由 Automatic 合进 main；待办却没人关，修复会话结束两小时后被时钟交给了 owner——一张「Escalated to you」的卡，说的是一件已经办完的事。owner：「应该是 coordinator 修复的过程中有问题来问我，而不是发这个卡片。」

**X-E2**：`escalate_at` 在创建或「Ask the coordinator again」时冻结；改项目的升级时长只影响之后创建的待办（附录 A-Q8）。

**X-E3**：升级后的待办保留原有投递；协调会话之后的动作（重试、successor、落地）照样按 X 表的终态事实解决它。

**X-E4**：CIR 的「此路径无时钟」一句按本文开头改写，并补一段（修订 12 改写这段文案；CIR 在 X-E5 实现的同一个提交里改，在那之前 CIR 照旧描述现状）：「The one clock added by the integration-line contract writes only what the account owner reads. It escalates an unhandled open item to the owner, closes items nobody owes any more, and opens one owner item when an integration job's lease has been expired for fifteen minutes, so that the owner can abandon it. It sends the owner a notification and nothing else: it creates no wake, no turn and no session, and it never ends, releases or abandons a job.」

**X-E5（租约过期提醒，owner 2026-10-04 决定；整条是修订 12 对实现的要求）**：

- **事实**：RUNNING 作业的当前领取 `LEASE_EXPIRED`（**§7.2 V6 的唯一定义**——与 §1.6 的 `inFlightJobs.timedOut`、J-T9、J-T10 的放弃门同一处：v2 领取为超过 10 分钟没有回报；legacy 领取用 main 读时判定 `timedOut` 的放宽界线，本机锁上排队不算超时）已超过 15 分钟，即 `lease_expired_at + 15 min < now()`。legacy 领取按同一条界线开待办，不按 10 分钟。**三种作业（`LAND_TASK`、`CHECK_PROMOTION`、`LAND_PROMOTION`）都开**（owner 2026-10-19 决定保留）。持有它、仍在心跳的进程这期间每一拍都会收到这条领取的重投（v2 领取，或从未回报的 legacy 领取；§2.3 J-T3a，修订 27）；重投不续租，这 15 分钟照旧从最后一次回报算起；重投起效、作业恢复回报时，待办按下面「同一领取下一次被接受的回报」结案。
- **语句**：同一个 60 秒时钟、同一拍里的第三条语句。今天这一拍先 `reconcile`（关掉没人再欠的待办）、再 `sweep`（按 `escalatesAt` 升级），X-E5 排在两者之后：一条 `INSERT INTO project_open_item … SELECT … FROM project_integration_job … ON CONFLICT (project_id, dedupe_key) WHERE state = 'OPEN' DO NOTHING RETURNING …`。它本身就是 CAS，多副本同时执行不会重复开、不会重复推送。提交后对 RETURNING 的行调用 `PushService.notifyOwnerItem`。
- **取值**（§4.1、§4.2）：`kind = LANDING_LEASE_EXPIRED`（新值，迁移扩 `project_open_item_kind_chk`）。`assignee = OWNER`，`assignee_reason = ESCALATED`（已有值：是时钟把它交到 owner 面前，所以照升级计入 V1 的 `ESCALATED`、V12 的推送与 V13 的 Needs-you），`escalated_at` 为开出时刻，`escalate_at` 与 `remind_at` 为 NULL：不升级，也不再提醒第二次。`dedupe_key = LE:<jobId>:<claimGeneration>`：与 `IE:<jobId>`、`IE:task:<taskId>` 前缀不同，不会相撞；同一领取至多一条，新领取再过期按新 claim 另开。`task_id`、`promotion_id`、`integration_job_id`、`session_id` 取作业行；payload 见 §4.2。不投递协调会话（X-D7）。
- **标题**（修订 23）：`Now yours — no report from the runner for <N>m`，`<N>` 为距该领取最后一次回报的分钟数（租约过期界线加上已过的 15 分钟）。推送与卡片写同一句：`owner-item-alert.ts#escalationTitle` 对 `LANDING_LEASE_EXPIRED` 的一支，与 web `ProjectProgressStatus.tsx#escalationHeading`、OrbitKit、Android 的同一函数；不走 ESCALATED 的 `no one acted on this for …`——X-E5 开出即升级，那个公式只会写成 `1s`。
- **结案**：`RESOLVED / JOB_MOVED_ON`（新值，同一迁移扩 `project_open_item_resolution_chk`），在它说的事实不再成立的那个事务里写：同一领取下一次被接受的回报（J-T4）、新领取（J-T3 接管）的第一次回报、release（J-T11）、作业的任何终态（结果、J-T12 的取消、J-T10 的放弃、J-T9 重检门的超时结束、M-T13 的退役结束）。`resolved_by` 照写动手的一方：owner 按的放弃为 `USER`，协调会话的 `integration_abandon` 为 `COORDINATOR`，其余为 `PLATFORM`。owner 也可以用 `open_item_resolve` 手工关掉（`HANDLED`）。`openItemOwed` 为这个 kind 加一支（作业仍 RUNNING、`claim_generation` 仍是去重键里那一代），`reconcile` 据此兜住漏掉的边沿，写同一个 `JOB_MOVED_ON`。
- **不挡 M-T11**：M-T11 数的是仍欠着（`openItemOwed`）、`promotion_id` 非空的集成类待办（d321b88ee），这条不在其中——它说的是一次领取的租约，不是线上的失败。它所指的作业仍 RUNNING 时，J1、M-F1 与 M-F4 本身已经挡住同一条线上的新候选与新合入；作业被接管后以结果收尾时，结果事务先把它结掉，再做 M-T11 的判断。
- **门**（§4.8）：服务端给的动作是 `ABANDON`（owner 用户门，J-T10）与 `OPEN_LANDING`，另带 `chat`。Abandon 的文案按 J12 的判定写 `nothing was pushed` 或 `may have been pushed`（`CHECK_PROMOTION` 一律 `nothing was pushed`；`LAND_TASK` / `LAND_PROMOTION` 的 legacy 领取一律 `may have been pushed`）。
- **它不写**作业 state、会话、轮次、wake 或投递行，不自动放弃，也不释放 J1。这与升级同属 G3 第 1 条（只写 owner 可见的状态、只推 owner），不能拿来为 agent 增加时钟。

### 4.7 协调会话与 owner 的动作

| 动作 | 入口 | 权限 | 效果 |
|---|---|---|---|
| 重试集成 | MCP `integration_retry { projectId, taskId \| promotionId, reason }`；runner 门 `POST /runner/projects/:id/tasks/:taskId/integration/retry` 与 `POST /runner/projects/:id/promotions/:promotionId/integration/retry`；owner 的用户门 `POST /projects/:id/tasks/:taskId/integration/retry`、`POST /projects/:id/promotions/:promotionId/integration/retry`，以及超时作业的 `POST /projects/:id/integration/jobs/:jobId/retry`（J-T9）——这一扇只收 `LAND_TASK` 的超时作业；`CHECK_PROMOTION` 的超时走带 `promotionId` 的候选重检门（J-T9、H1），`LAND_PROMOTION` 的超时由下一行的放弃门补上。**没有 `promotion_recheck` 这个工具**：协调者对一条失败检查的重检就是 `integration_retry` 带 `promotionId` 那一支（描述、`cli_mcp_parity_test.go` 的登记与 runner 门都用这个名字；T5 只补了 owner 的两条用户路由）。`taskId` 那一支重排任务的下一代 `LAND_TASK`，`promotionId` 那一支重排候选的下一代 `CHECK_PROMOTION`，两者在决定上是同一套问题（哪一代失败、失败是否归协调会话、它是否有权决定），实现也是同一个 `integration_retry`（`project-integration-retry.ts#decideIntegrationRetry` / `#decidePromotionRetry`） | 当前协调会话；待办归 owner（升级、非 Automatic）或有 owner blocker 时拒绝，见 J-T1b；候选在 BLOCKED 且失败可重跑（非冲突），或 CHECKING 且最新检查 RUNNING 已超时（J-T9，owner 无归自己的待办也可按——还没有任何待办）时 | J-T1b；候选是重排它的下一代 `CHECK_PROMOTION`、回到 CHECKING（H1）；超时重排在同一事务先把失控作业结束为 `ERROR · RUNNER_LOST`（J-T9），候选的清空确认随这次重排写回 |
| 把失败的任务再跑起来（`TASK_FAILED` 格的门） | 协调会话：MCP `task_start { taskId }`（门表登记的是同一格的 coordinator 支）；owner 的用户门 `POST /tasks/:id/execute`——就是「Run now」按的那条路由，门表的 `taskFailureDoors` 按负责人登记这两种。**不是 `integration_retry`**：落地交付的是已完任务的工作，非 DONE 的任务被那扇门一律 409（J-T1b，设计如此），所以失败任务的卡上那颗 `Retry` 走的是这里这一扇 | 该格待办的持有人（协调会话或 owner）；owner 的门就是 Run now 本身的门 | 任务从 FAILED 清成 IN_PROGRESS（`clearFailedForRetry`）并开出新的一次运行（一个新的工作会话；旧会话是 FAILED，不会被 resume），这条失败待办随即由 §4.2 的事实关闭（`resolveByFact`：一条新会话在跑 → `RETRIED`）；门表对两种负责人登记的门见 `taskFailureDoors`（owner 是 ROUTE `/tasks/:id/execute`，协调会话是 MCP `task_start`），两端客户端按行的 kind 分流 |
| 两类冲突的解法（T14；重试门拒绝 `CONFLICT` 时点名的就是这两条） | **① 任务落地的 MAIN_SYNC 冲突**（§3.1 M3）：MCP `task_comment`（写明这一轮只做吸收）+ MCP `task_reopen`；**② 晋升的 MERGE 冲突**（`CHECK_PROMOTION` / `LAND_PROMOTION` × `CONFLICT`）：MCP `task_create` 一条**同步任务**——从项目分支 tip 出发、把 upstream 合进它自己、解掉冲突；它落地后按 M-F1 自己产生下一个候选 | ① 待办归协调会话；② 待办归协调会话或 owner 时都是这两条 | ① 任务再次 DONE 照 J-T1a 排下一代，J-S2 看到源分支带着两个 tip 就走 MERGE 落地（§2.4 分支 ①），落地关掉待办（J-T5）；② 只到「源分支变了」为止，重检由平台的 M-F1 再排（协调会话不合并、不重检）。两条都不在原作业上重跑：同一份提交照原样重放会再冲突一次（J-T1b 的拒绝文案即此）。门表（`open-item-doors.ts`）为这两格登记的就是这些门：`(INTEGRATION_CONFLICT, MAIN_SYNC, CONFLICT, COORDINATOR)` 给 `task_comment` + `task_reopen`，晋升列的冲突格给 `task_create` |
| 把修复挂到待办上（T7） | MCP `task_create { … fixesOpenItemId }`、`task_update { fixesOpenItemId }`（新列 `task.fixes_open_item_id`，迁移 0379，FK SET NULL + 索引；不能用 `source_task_id` 那些出处列，SC7 禁止用它们做判断） | 只许待办**当前的持有方**：OWNER 待办只能由 owner 挂（协调会话带着自己的 header 去挂 → 403 `FIXES_OPEN_ITEM_WRITER_REFUSED`），COORDINATOR 待办只能由**该项目的协调会话**挂（别的会话、或没有会话 → 同一个码）；项目要对得上（不 → 400 `FIXES_OPEN_ITEM_PROJECT_MISMATCH`），只许集成类与 `TASK_FAILED`（不 → 400 `FIXES_OPEN_ITEM_KIND_REFUSED`），待办必须是开着的（不 → 409 `FIXES_OPEN_ITEM_NOT_OPEN`） | 待办**不因此关闭**：挂着是进展，结局由修复任务的结果或另一扇门决定。挂上即算这条待办的进展（X-E1 的「最后推进」取它的 `updated_at`），修复任务 IN_PROGRESS 或工作会话活着期间这条待办没有截止时间、不升级；修复任务落地时按 X-D4 第 5 条把待办换键再投给协调会话。读模型在行上给出 `handledBy`（§4.8），卡上第一行也据此改口（"A repair task is already handling this item …"） |
| 放弃在途作业（修订 12，要求） | MCP `integration_abandon { projectId, jobId, reason }` → runner 门 `POST /runner/projects/:id/integration/jobs/:jobId/abandon`（带 `X-Orbit-Session-Id`）；owner 用户门 `POST /projects/:id/integration/jobs/:jobId/abandon`，X-E5 待办、落地会话页头与合入卡上的 Abandon 都按这一扇 | **共同门槛 LEASE_EXPIRED**（§7.2 V6，含 legacy 的界线），调用者为 owner 或项目当前协调会话；不套重试门的待办归属、Automatic、owner blocker 条件。owner 门标 `@PatForbidden('OWNER_INTERACTIVE')` 并登记 `auth/pat-owner-channel-routes.ts`，拒绝带 acting session 的请求；带 `:param`，进 `auth/tenant-isolation-cases.ts`，别人的项目回 404 | J-T10，共用 apply-result 事务；**只结束、不重排**（被叫停的 `LAND_TASK` 例外，见 J-T8），`LAND_TASK`、`CHECK_PROMOTION`、`LAND_PROMOTION` 三种作业都适用（超时的晋升作业只能走这一扇）；按 J12 写 `RUNNER_LOST`（`CHECK_PROMOTION` 一律；`LAND_TASK` / `LAND_PROMOTION` 只在 v2 领取且从未记下 PUSH 时）或 `PUSH_OUTCOME_UNKNOWN`（其余；`LAND_TASK` / `LAND_PROMOTION` 的 legacy 领取一律如此）；开 `INTEGRATION_ERROR` 待办（§4.2；被叫停的那一代——作业带 `cancel_requested_at`——不开，见 J-T8）；claim 围栏失效；同一事务结掉该作业的 X-E5 提醒（`JOB_MOVED_ON`）；`cli_mcp_parity_test.go` 登记 |
| 叫停在途落地（修订 12，要求） | LAND_TASK：owner 用户门 `POST /projects/:id/tasks/:taskId/integration/stop`；晋升：照旧 M-F3 的 Cancel（门本身不变，效果按 M-T10 改为「取消中，以事实为准」） | owner；门的标注与登记同上一行；已过推送界线（J-T4）拒绝 | J-T8：QUEUED 直接 CANCELLED；RUNNING 已按 §7.2 V6 超时的当场按 J-T9 结束为 `ERROR`（错误码按 J12；晋升的 Cancel 随之按 M-T10 写结局：`RUNNER_LOST` 写 `CANCELLED`，`PUSH_OUTCOME_UNKNOWN` 写 `BLOCKED`），其余 RUNNING 写 `cancel_requested_at`，由 J-T12 收口；被叫停的 `LAND_TASK` 以任何终态结束时按 J-T8 补排；任务段不结案（§2.9）。协调会话没有叫停门：它要叫停就走 `task_reopen`（J-T8 的另一个触发） |
| 再观测一次（修订 29） | MCP `integration_observe { projectId, reason }`；runner 门 `POST /runner/projects/:id/integration/observe`（带 `X-Orbit-Session-Id`）；owner 用户门 `POST /projects/:id/integration/observe` | 项目当前的协调会话，或 owner；`reason` 必填，空白 → 400 `INTEGRATION_OBSERVE_REASON_REQUIRED` | §10.6 O-T5：入队一条 `OBSERVE_LANDING`，或并进已排队的那一条；有 OPEN 的 `LANDING_UNOBSERVED` 时照 H1 记处理中（§10.8） |
| 接受（修订 29） | owner 用户门 `POST /projects/:id/open-items/:itemId/accept` | owner；带 acting session → 403 `OPEN_ITEM_OWNER_ONLY`（标注与登记同「放弃在途作业」的 owner 门） | `LANDED_WITHOUT_CONFIRMATION` → `RESOLVED / ACCEPTED`（一次 CAS：OPEN 且 `openItemOwed`；输家 → 409 `OPEN_ITEM_NOT_OPEN`）；别的 kind → 409 `OPEN_ITEM_HAS_ITS_OWN_DOOR`。门表把它投影成 action `ACCEPT`。要回退，owner 经「Chat about this」请协调会话另建任务；回退是普通工作，不是门（§10.8） |
| 标记已处理 | MCP `open_item_resolve { itemId, note }`；`POST /projects/:id/open-items/:itemId/resolve`（owner 走用户门，协调会话走 runner 门带 `X-Orbit-Session-Id`） | 负责人本人：COORDINATOR 待办只由**当前**协调会话关，owner 不限；问题由提问会话撤回（R12） | `RESOLVED / HANDLED`（问题为 `WITHDRAWN`），`note` 必填、≤2000 字符；`PROMOTION_APPROVAL`、`FUSE_PAUSED` 与修订 29 的 `LANDING_UNOBSERVED`、`LANDED_WITHOUT_CONFIRMATION` 各有自己的门，此入口拒绝（`OPEN_ITEM_HAS_ITS_OWN_DOOR`）。**任务落地类集成待办不能空关**（修订 29，§10.7 O-X1）：`task_id` 非空的 `INTEGRATION_*`，或 `promotion_id` 指向 `TASK_BRANCH` 候选的 `INTEGRATION_*`，在该任务仍是 `NOT_KNOWN`、且是某个未结束任务的前置时，拒绝 409 `OPEN_ITEM_CONDITION_STANDS`，消息只点名这一格真有的门；条件不在了（已落地，或下游都已结束、取消）照常可关 |
| 交给 owner | MCP `open_item_hand_over { itemId, note }`；runner 门 `POST /runner/projects/:id/open-items/:itemId/hand-over`（web 今天没有这一扇按钮——协调会话从 MCP 调它，卡上的 `Hand to owner` 是效果图里的画法，不是已上线的门） | **当前**协调会话（别的会话 403 `OPEN_ITEM_COORDINATOR_ONLY`）；待办必须 OPEN、且**这一格的门的允许清单里有它**（问题、暂停、交付评审不在其中，→ 409 `OPEN_ITEM_NOT_COORDINATOR_ITEM`；修订 29 的 `LANDING_UNOBSERVED` 在其中，§10.8）。审批卡在允许清单里（`open-item-doors.ts:489` 那一格也带这扇门），但它生来就归 owner，所以实际被拒的是同一条 `OPEN_ITEM_NOT_COORDINATOR_ITEM` 的另一半：`assignee` 必须是 `COORDINATOR` | `note` 必填（空 → 400 `OPEN_ITEM_HAND_OVER_NOTE_REQUIRED`，> 2000 字符 → `OPEN_ITEM_HAND_OVER_NOTE_TOO_LONG`）；一次 CAS（比对读到的 `assigned_at` 与 `openItemOwed`）写 OWNER / `HANDED_OVER`、`escalate_at = NULL`（**不动 `escalated_at`**，所以卡脚注是 `Owner: you · waiting <age>`，没有「came to the owner at」那半句）、`assigned_at` 改为此刻、`handover_note` / `handed_over_at` / `handed_over_by_session_id`，输家 → 409 `OPEN_ITEM_HAND_OVER_RACE`；提交后推送 `escalated-to-you`（标题 `Now yours — the coordinator handed it over`）。写下的 `note` 留在行上（`handoverNote`，§4.8），卡上第一行与 `requiredAction` 都改口引用它。修订 13：协调会话处理中要 owner 拍板的，用 `ask_owner` 问（待办仍归它，答复作为一轮送回）；这扇门留给必须由 owner 亲手处理的事（他的设备、账号或密钥），投递文本与协调会话的开场说明照此写 |
| 让协调会话再看一次 | web「Ask the coordinator again」：`POST …/open-items/:itemId/return-to-coordinator` | owner | COORDINATOR / `DEFAULT`，重置 `waiting_since` 与 `escalate_at`，走 X-D4 第 1 条；**要求存在活着的协调会话，不要求 `coordinator_enabled`**——开关约束的是自动交付（附录 B 修订 2）。从不投递协调会话的两种拒绝 409 `OPEN_ITEM_NOT_RETURNABLE`：X-E5 的 `LANDING_LEASE_EXPIRED` 与修订 29 的 `LANDED_WITHOUT_CONFIRMATION` |
| 列表 | MCP `open_item_list { projectId }`；`GET /projects/:id/open-items?state=` | 项目内会话或 owner | 读 |
| 就此对话 | web「Chat about this」：异常卡（任务的、晋升的，处理中 / 已结束的同样有）与 BLOCKED 晋升卡；不在协调会话里时经 `/sessions/:id?intent=chat-about&item=…`（或 `&promotion=…`）打开它 | owner；可否由读模型的 `chat` 决定（§4.8） | 一条普通轮次进项目的协调会话，卡上的事实（项目、待办、失败原因、处理状态、各 id）排在 owner 打的字前面，按发送那一刻的读模型写（按下后条目已离开读模型、或候选已不再 BLOCKED 的，按按下时的样子发出并注明已变）；**不是门**：不重跑、不合并、不交回、不关闭，卡上原有的门与权限不变 |

**`LANDING_UNOBSERVED` 的门（修订 29，§10.8）**：除了上表的「再观测一次」与「交给 owner」，还有两扇已有的门：`merge_receipt`（`result = ALREADY_MERGED`，`sourceSha` 指明线上真正带着这份工作的提交，写下即走 §10.6 O-R1 的落地边）与 `task_reopen`（打回去推，待办写 `RETRIED`，再次 DONE 时重新冻结身份、重新观测）。门能力表为两种新 kind 各加格子，`KNOWN_GAPS` 仍为空元组。

**门能力表是这一切的唯一来源（T4、T8，2026-10-04 落地）**。`src/apiserver/src/projects/open-item-doors.ts` 把「待办类型 × 来源作业 × 失败类 × 负责人」列成一张表，每一格给出一组**门**；表里没有未解决的格子（`KNOWN_GAPS` 是空元组，新加的洞会让普查当场变红）。三个读它的人：`openItemActionsFromDoors`（`actions` 投影）、`openItemDoorMessageNames` 与 `openItemMessage`（写给协调会话的那段话）、`primaryAction`（§4.8 卡上的领头门）。每条指派路径只交给手里有门的人：`open-item-doors.spec.ts` 逐格断言至少一扇「解决型」门（`resolving = true`；`open_item_resolve` 的 `HANDLED` 与 `WITHDRAWN` 按设计不算解决型），并断言每一扇 `implemented` 的门都有一条真实路由；「每条指派路径只交给有门的人」在那张 spec 里是**静态**检查（门表与路由/工具名对照）；T17 起它还有一条**逐格渲染消息**的检查：把每一格的协调者消息渲染出来，断言里面出现的 MCP 工具名都属于这一格的门（细节见下面那一段）。同一份 spec 还逐格守着**投影的出处**：**每一格投影出的每个 action 都由该格负责人持有的、名字在册的门背出**（ROUTE 对控制器元数据、MCP 对 `mcp.go`；`CONTROLLER_FILES` 因此含 `tasks/tasks.controller.ts`，owner 的 run-again 门 `/tasks/:id/execute` 就在那里），而且 **`TASK_FAILED` 格的 `RETRY` 对 owner 是 ROUTE `/tasks/:id/execute`、对协调会话是 MCP `task_start`**——这两个地址正是两端客户端分流时按的行 kind 要去的门（web `RetryPress` / OrbitKit `retryIntegration`）。

**发给协调会话的话只点名这一格真能用的门（T17，2026-10-12 落地）**：

- 名字来自这一格的 `openItemDoorMessageNames`，**没有字面兜底**：这一格没有的门给的是 `null`，而写消息的那几个函数（`landingNextStep`、`mainSyncNextStep`、`promotionNextStep`、`landedFixPreface`、`openItemBody` 的 `handling()`、`deliveryReviewMessage`）只在名字非空时才写那句，名字为空就整句不写。所以一格里出现的每个 MCP 工具名都是这一格真有的门（`open-item-doors.spec.ts` 逐格断言：任何 CONFLICT 格既没有 `integration_retry` 门、也不投影 `RETRY`；每一格的协调者消息里出现的工具名都属于这一格的门）。
- **冲突格不给会被拒的重跑门**：`decideIntegrationRetry` / `decidePromotionRetry` 对 `CONFLICT` 一律 409 `INTEGRATION_RETRY_NOT_APPLICABLE`，所以晋升冲突格里根本没有 `integration_retry` 这扇门（此前它带 `action: 'RETRY'` 却标 `resolving: false`，卡上照画一个按下去必被拒的 “Re-run the check”）；任务落地的冲突格里 `task_reopen` / `task_create` 照旧是门——消息的解法就点名它们——但都不带 `action: 'RETRY'`（那个 action 的按法是集成重跑）。冲突的下一步是去任务分支上修：卡由 `Open task session` 领头（`primaryAction`），`Retry` 不再出现。
- **建议随格变**：MAIN_SYNC 冲突那段（`mainSyncNextStep`）写「原样重跑会再冲突」（不再点 `integration_retry` 的名），并给出真正解决它的两条（`task_comment` + `task_reopen`）；晋升的 CONFLICT 格点 `task_create` 的同步任务。可重跑的那几格才把重跑说成下一步，也只有那几格的收尾句才提「requeue its landing with integration_retry … being handled」（`handling()` 只在有重跑门时写）。
- 名字与消息都不许造：这条规则由 `open-item-doors.spec.ts` 新增的两条普查钉住（冲突格的门与 `actions` 投影、每格消息里的工具名），而不是靠人工读文案。
- 该 spec 仍覆盖晋升 `CHECK_FAILED` 那一格：`promotion-failure-coordinator-path.pg.spec.ts` 断言那条消息里出现 `integration_retry`、不出现 `promotion_recheck`（这个工具不存在）。

**协调会话处理中的生命周期（H1–H5，迁移 0368，2026-10-03）**。同一套规则管任务落地卡与晋升卡（项目分支合入 main 的卡，没有 taskId）。缘由：晋升的 `MERGE_CHECK` 红了时，那条待办没有 taskId，协调会话无门可走（消息原文「今天也没有一条属于协调会话的重试门」），只能等时钟把它升级成 owner 待办；任务落地卡的重排又在发起那一刻就被写成 `SUPERSEDED / RETRIED`，「处理中」和「处理完」在记录里分不开，成功也没有统一、可审计的 HANDLED。TASK_FAILED 不在此列，仍按 §4.2 的事实关闭。

- **H1 处理中**：四种事实各在**自己的事务**里，把这条失败留下的、仍在 OPEN 的集成类待办记上 `handling_*`（`markOpenItemsHandling`，全仓四个调用点），**不**关闭——作业 QUEUED/RUNNING 期间读模型给出 `handling`，卡片显示 Handling，绝不显示 HANDLED。`handling_job_id` 指新一代作业，`handling_reason` 写这一轮为什么不同，「发起人」两列恰有一个（迁移 0380）：`handling_session_id`（会话按的）或 `handling_user_id`（owner 按的）。四种事实：
  1. **`integration_retry` 重排**（任务的下一代 `LAND_TASK`，作业带 0344 的四列 retry 信息）——写的是决定里列出的、归发起方那几件（`decideIntegrationRetry` 的 `handle`）；
  2. **`integration_retry` 重检**（BLOCKED 候选的下一代 `CHECK_PROMOTION`）——同上。重检只到「候选回到可合并」为止：通过后合并照旧由 owner 的卡或 Automatic 的 M-T11 规则确认，这扇门从不合并。重检同时把候选上一次的确认清掉（`confirmed_by_user_id` / `confirmed_at` 清空、`confirmed_automatically` 复位 false，与回到 CHECKING 同一条 UPDATE）：重检查的是新的合入问题，旧确认回答的是旧检查，留着还会在 Automatic 对新结果自动确认时撞 `project_promotion_automatic_chk`（2026-10-09 生产事故）。不开 Automatic 的项目行为不变：检查通过照常出 owner 的卡，owner 此前按过不覆盖新的问题。**超时的检查**（J-T9）：候选 CHECKING 且最新 `CHECK_PROMOTION` RUNNING 已超时（§7.2 V6 的读时判定，本机锁上排队不算）也允许进这扇门——先把失控作业按 `ERROR · RUNNER_LOST` 结束（对 state 与判定所依据的 `heartbeat_at` 比较并交换，`claim_generation + 1`，迟到的结果被拒），再照常重排下一代；没超时的 RUNNING 检查照旧 409 `INTEGRATION_RETRY_IN_FLIGHT`，`LAND_PROMOTION` 的超时不走这扇门（它答的是已确认的合入，归 J-T3 接管或 J-T10 放弃门）。
  3. **跳过一次合并检查的落地**（`integration_skip_merge_check`，§2.4 J-S5 的例外）：owner 在确认卡上批准、或协调会话带着一张 ALLOWED 卡跳过一次检查，平台替这一代排下一代 `LAND_TASK` 时，同一事务照 H1 记（`project-open-item.service.ts:2048`）——被跳过的那次失败留下的、仍归发起方的那些待办。所以 H1 的触发点是四个：重排、重检、跳过检查、退回返工后的新一代。
  4. **退回返工后的新一代落地**（T15，2026-10-04 落地）：任务被 `task_reopen` 退回、再次 DONE 时，J-T1a 排下一代 `LAND_TASK`（`enqueueForDoneTask`）的同一事务里，把这条任务**更早几代**留下的 OPEN 集成类待办记上处理中，`handling_reason` 是 `A new landing generation after the task was reopened for rework`。**发起人是这次 DONE 的来源——也就是任务自己的那条工作会话**：`enqueueForDoneTask` 由 `runner-api.controller.ts#turnComplete` 带着 `{ sessionId }` 调用（写进 `handling_session_id`），不是协调会话、也不是 owner；`reopen-landing-handling.pg.spec.ts:426` 断言 `handlingSessionId = reopened.sessionId`。「这一轮是退回返工」由 `task_reopen` 门与写 `task_reopen_intent` 同一事务留下的标记（迁移 0381）说明，标记在这个 DONE 上被消费掉——只按状态读 `DONE → IN_PROGRESS → DONE` 是认不出来的。这条扩展替掉的正是过去的形状：旧待办一直 OPEN、内容早已过时（冲突早解开、新一代都过了 MAIN_SYNC），却仍被重新投递给协调会话、仍按时钟升级、仍按 M2 扣着同一条线上别人的落地，最后只能手工 `open_item_resolve` 关掉（T7 的 11:31Z REBASE 冲突待办与 12:47Z MAIN_SYNC 冲突待办即此）。它扣着别人的落地这件事**没有被豁免**（T17 起读者也照实报，§3.1 M2）。

  owner 的用户门同一套规则（`requester = OWNER` 走 `decideIntegrationRetry` 的 OWNER 支），但**「不必有归它的待办」只在挑选超时的作业时成立**：`mine.length === 0 && !timedOut` → 403 `INTEGRATION_RETRY_OWNER_ONLY`（超时的落地 / 检查还没有任何待办可归，所以那个免）；owner 待办上的 owner blocker 照旧先挡（409 `INTEGRATION_RETRY_OWNER_BLOCKER`）。写下的发起人是 `handling_user_id`，H2 关它时 `resolved_by = USER`。
- **H2 成功 → HANDLED**：那次作业 `LANDED` / `ALREADY_LANDED`（任务）或 `READY`（候选），在写作业终态的事务里（`resolveHandledItems`）把 `handling_job_id` 指向它、且**仍归协调会话**（或 `handling_user_id` 非空、即 owner 自己按的）的待办写成 `RESOLVED / HANDLED`：`resolved_by` 按发起人写 `COORDINATOR` 或 `USER`、`resolved_by_session_id` / `resolved_by_user_id` 照抄发起方、`resolution_note` = 理由、`resolved_by_job_id` = 该作业；`task_id` / `promotion_id` 照旧在行上，所以晋升卡也有完整审计。候选的这一步排在 M-T11 计数之前，免得刚被这次检查回答的待办挡住自动合入。带理由的终结动作（`open_item_resolve`）照旧写 HANDLED，`resolved_by_job_id` 为空。
- **H3 再失败 → SUPERSEDED / RETRIED**：那次作业以 `CONFLICT` / `CHECK_FAILED` / `ERROR` 终了时，先开新待办（payload 带 retry 与 generation），再把它处理着的待办写成 `SUPERSEDED / RETRIED`，`superseded_by_item_id` 指向新待办；真实的失败永远有一条 OPEN 待办在某人面前。
- **H4 升级优先**：处理中照常走 §4.6 的时钟（修订 13 起，协调会话接手了的待办没有升级时刻，这一条只剩接手的会话不在了的情形）。期间被交给 owner 的待办不会被 H2 以协调会话名义关闭——任务落地照旧按 J-T5 写 `LANDED / PLATFORM`，候选检查通过时它仍 OPEN、M-T11 计入它、合并等 owner 的卡；再失败时新待办继承 owner 的归属（`assignee_reason`、`waiting_since`、`escalated_at`），不回到协调会话。升级后协调会话的 `open_item_resolve` 与 `integration_retry` 照旧被拒（`OPEN_ITEM_NOT_COORDINATOR_ITEM`、`INTEGRATION_RETRY_OWNER_ITEM`）。
- **H5 读模型**：`GET /projects/:id/open-items` 每行带 `handling`（仅在途时非空），另返回 `settled`：最近 24 小时内由协调会话结束的协调类待办（至多 20 条，带 `outcome`：state、resolution、会话、理由、作业、`supersededByItemId`）。web 在协调会话里把它们画成原位的已结束卡（Handled / Superseded），项目页 Open items 不列。

MCP 工具加在 `src/runner-go/mcp.go`（描述 + case）、`transport.go`（HTTP 方法）、`runner-projects.controller.ts`（路由），并在 `cli_mcp_parity_test.go` 登记 CLI 能力或豁免。错误码：`OPEN_ITEM_NOT_OPEN`（409）、`OPEN_ITEM_NOT_COORDINATOR_ITEM`（409）、`OPEN_ITEM_COORDINATOR_ONLY`（403）、`OPEN_ITEM_HAS_ITS_OWN_DOOR`（409）、`OPEN_ITEM_OWNER_ONLY`（403）、`INTEGRATION_RETRY_NOT_APPLICABLE`（409）；修订 29 加 `OPEN_ITEM_CONDITION_STANDS`（409，O-X1）与 `INTEGRATION_OBSERVE_REASON_REQUIRED`（400，§10.8）。

### 4.8 读模型

```ts
interface OpenItemRow {
  itemId: string; kind: OpenItemKind; title: string; detailLine: string;
  assignee: 'COORDINATOR' | 'OWNER'; assigneeReason: OpenItemAssigneeReason;
  waitingSince: Date; escalateAt: Date | null; escalatedAt: Date | null;
  taskId: string | null;                // 这条待办说的任务
  /** 挂在这条待办上的修复任务（`task.fixes_open_item_id`，0379），带各自的状态，**最旧在前**。 */
  handledBy?: Array<{ taskId: string; title: string; state: string }>;
  sessionId: string | null;             // 引发它的那次尝试
  promotionId: string | null; fuseEpisodeId: string | null;
  delivery: { state: 'NOT_REQUIRED' | 'PENDING' | 'QUEUED' | 'DELIVERED' | 'RETURNED';
              sessionId: string | null; at: Date | null };
  actions: OpenItemAction[];            // 见下：门表的投影
  /** 服务端给出的一句「下一步该谁做什么」。三端只渲染，不翻译、不自己拼。 */
  requiredAction?: string;
  /** 这一行第一扇可执行的门（`primaryAction`），卡上由它领头。 */
  primaryAction?: OpenItemAction;
  question: CoordinatorQuestion | null; startRequest?: ... ; doneRequest?: ... ;
  facts: OpenItemFacts | null;          // payload 按卡片画成的行；读不出来的形状为 null
  /** 处理中（H1）：只在重跑在途时非空，带发起方、理由、作业与它的状态。 */
  handling?: { sessionId: string | null; userId: string | null; reason: string; startedAt: Date;
               jobId: string; jobKind: 'LAND_TASK' | 'CHECK_PROMOTION'; generation: number;
               state: 'QUEUED' | 'RUNNING' } | null;
  /** 怎么结束的——只在 `settled` 的行上，开着的行为 null。字段名与读口一致（shared 的 `OpenItemOutcome`）。 */
  outcome?: { state: 'RESOLVED' | 'SUPERSEDED'; resolution: 'HANDLED' | 'RETRIED';
              resolvedBy: 'COORDINATOR' | 'USER';
              resolvedBySessionId: string | null; resolvedByUserId: string | null;
              resolvedAt: Date; note: string | null; jobId: string | null;
              supersededByItemId: string | null } | null;
  /** 协调会话交出来时写的那句话（`open_item_hand_over`）。 */
  handoverNote?: string | null;
  chat: { sessionId: string | null;
          stage: 'HANDLING' | 'WITH_COORDINATOR' | 'WITH_OWNER' | 'HANDLED' | 'SUPERSEDED';
          refusal: 'NO_COORDINATOR' | 'COORDINATOR_UNAVAILABLE' | 'SUPERSEDED' | null };
}
type OpenItemAction = 'REVIEW' | 'OPEN_COORDINATOR' | 'OPEN_TASK_SESSION' | 'RETRY'
                    | 'CANCEL_TASK' | 'ASK_COORDINATOR_AGAIN' | 'RESUME' | 'ANSWER';
```

**`requiredAction`（T9，2026-10-05 落地）**：服务端一处推导（`project-open-item.ts#openItemRequiredAction`），维度全按门表读——所以它说不出这一格没有的门。它先看状态：已结束的写 "This item is already settled — no action is required."。再看待办上的修复任务，判据是 `hasLiveFix`：**任何一条修复任务的状态不是 `DONE` 也不是 `CANCELLED`（含 `OPEN`、`IN_PROGRESS`、`FAILED`，以及状态读不出来的）就算「活着」**，那时写 "A repair task is already handling this item — let it finish or open the task to see what it needs."；只有当**全部**修复任务都已 `DONE` / `CANCELLED` 时才写 "A repair task is linked to this item — inspect its result, then use the available door if the item still needs a decision."。是协调会话交出来的就引用它写下的 `handoverNote`（`The coordinator handed this item over with this note: "…" — follow it, …`）。其余按类型与格给句，例如 OWNER × 晋升检查失败 × 非冲突那句 `Nothing on the project branch reaches <main> until this check passes — re-run it or ask the coordinator to fix it.`，`<main>` 取项目自己的主分支名。

`open-item-required-action.spec.ts` 钉的是两件事：**逐字节**只有那一格（OWNER × `CHECK_PROMOTION` × 非冲突的整句）；其余每一格断言的是「是一句非空的、以 `.!?` 结尾的话」加「`primaryAction` 出自这一格持有者的一扇门」；状态 / 活的修复 / 交出三种事实改口各有一条用例。三端渲染同一串字（web 的卡第一行、OrbitKit 的同一行）。（推送正文不抄它：横幅的正文是待办自己的标题，`<item title> · <project>`，§7.6 V12。）

`primaryAction`：由「这一行第一扇有门的投影动作」得出（`primaryActionPreference` 给顺序，门表给可否），卡上它领头，其余门各带一行后果（web 的 `ACTION_CONSEQUENCES`，OrbitKit 的同一张表，两处由 parity 测试对住）。**它绝不新造动作**：一个这一行没有门的名字不会被画出来。

**`need`（T9 的短句）**：会话行与横幅写 `Escalated to you · <need>`，`need` 由服务端从**已经读过的原始 kind** 算出（`ownerItemNeed`：`Merge conflict` / `Checks failed` / `Integration error` / `Task failed` / `Approve merge to main` / `Question from coordinator` / `Paused` / `Ready to start` / `Ready to close` / `Delivery review`），不为此多查一次表；它在 `owner-decision-signal.ts` 里挂在 `SessionOwnerItem.need` 上（§7.6 V13），web 的行与 OrbitKit 的行各按同一串字取最旧的那件。

`chat`（修订 9，`openItemChat`）：`sessionId` 是项目此刻的协调会话；`stage` 依次取 outcome（`RETRIED` → SUPERSEDED、`HANDLED` → HANDLED）、在途的 `handling`、`assignee`；`refusal` 只在三种情况下非空——已被新待办取代、项目没有协调会话、协调会话此刻收不了消息（与会话的 `canSend` 同一判据，`SessionsService.receiveBlockedReasonFor`；已结束但可恢复的会话**可以**收，与只管平台轮次的 `sessionHasEnded` 不同）。`settled` 的行同样带 `chat`。

`GET /projects/:id/open-items` 返回 `{ needsYou: OpenItemRow[]; withCoordinator: OpenItemRow[] }`，两组各按 `waitingSince` 升序（效果图 2「oldest first」）。

**已结束的提问**（修订 14）：同一个读口另返回可选的 `closedQuestions`，收 `COORDINATOR_QUESTION` 里 `RESOLVED / ANSWERED` 与 `RESOLVED / WITHDRAWN` 的行，按 `resolvedAt` 降序（同刻按 id 降序），最多 50 条——按条数封顶，不按天：记录画在它结束的那一刻，安静一周不该把最后几问从对话里拿走。还开着的提问照旧只在 `needsYou`，这一组也不进 `needsYou` 与任何 needs-you 计数（没有人欠它什么）。旧客户端不认这个字段，忽略即可。

```ts
interface ClosedQuestion {
  itemId: string;
  question: CoordinatorQuestion;            // payload 原样，与 OpenItemRow.question 同形
  askedAt: Date;                            // 待办的 created_at
  resolution: 'ANSWERED' | 'WITHDRAWN';
  resolvedBy: 'USER' | 'COORDINATOR';       // 答复总是 USER；撤回是提问会话（R12）或 owner 自己的关闭门
  resolvedAt: Date;                         // 卡片画在这一刻
  answer: { option: number | null; text: string | null } | null;   // 撤回为 null
  delivery: { sessionId: string; at: Date } | null;  // 第一条 ANSWER 投递的会话与 created_at；没有就是 null
  withdrawReason: string | null;            // 撤回时的 resolution_note；答复为 null
}
```

数据全在已有的列上（`payload`、`answer`、`resolved_at`、`resolution`、`resolution_note`、`project_open_item_delivery` 里 purpose = ANSWER 的行），不需要迁移。`delivery` 取最早的那条 ANSWER 投递：答复时没有协调会话就是 null，R11 在下一次绑定投出之后才有值；轮换后补投的后几条不改它。id 字段沿用 `itemId`、`sessionId`（`PUBLIC_ID_FIELDS` 里已有）。客户端把每条画成对话里的一张卡，位置按 `resolvedAt`（与判据裁决、证据、合并的回执同一条规则：web `decisionReceiptAnchor`，OrbitKit `ReceiptAnchor.place`），落在同一处的几张按结束先后排，同时拿掉这一问原来的提问卡；项目页不画这一组，那里只列还要 owner 回答的问题。测试：`src/apiserver/src/projects/open-item-closed-questions.pg.spec.ts`。

**修订 12 的两个动作（要求）**：`OPEN_LANDING`（打开这次尝试所属的落地会话）出现在三种 `INTEGRATION_*` 行（两种负责人）与 `LANDING_LEASE_EXPIRED` 行上，作业有 `landingSessionId` 时才给；`ABANDON`（J-T10）只出现在 `LANDING_LEASE_EXPIRED` 行上。两者与修订 9 的 `chat` 并存，`chat` 照旧在每一行（X-E5 的行同样带，`stage` 为 `WITH_OWNER`）；`chat` 仍不是门。两者追加在 `actions` 投影的末尾，**不进 `primaryActionPreference`**：既有各格的 `primaryAction` 与 `requiredAction` 与今天逐字节相同（4f7584649，`open-item-required-action.spec.ts` 钉住）。新格子的 `primaryAction` 由「第一个有门的投影动作」得出，即 `ABANDON`；它的 `requiredAction` 是 `The runner stopped reporting; abandon this landing, or wait for the runner to come back.`。

**门矩阵登记**（`open-item-doors.ts` 与 `open-item-doors.spec.ts`；要求）：

- X-E5 的待办落在 `(LANDING_LEASE_EXPIRED, DIRECT, ERROR, OWNER)` 这一格，只登记 OWNER 一行（同 `START_REQUEST` / `DONE_REQUEST`：生来就是 owner 的）。`sourceJobForOpenItem` 对这个 kind 返回 `DIRECT`，不按 payload 的 `jobKind` 落进集成失败的格子；failureClass 取哨兵 `ERROR`。kind 名不带 `INTEGRATION_` 前缀，所以 spec 里按 `startsWith('INTEGRATION_')` 认的「可修复的集成失败」规则（必须有 `task_create` 修复门、晋升格必须有 `integration_retry`）不套到它身上。这一格的门：`ABANDON`、`OPEN_LANDING`、`open_item_resolve`（`HANDLED`，与其他格一样不算 resolving）。
- `ABANDON` 作为门：`capability = CANCEL`（结束一次尝试，与取消任务同类），`holder = OWNER`，`kind = ROUTE`，`route = /projects/:id/integration/jobs/:jobId/abandon`，`outcomes = ['JOB_MOVED_ON']`，`resolving = true`（`RESOLVING_OUTCOMES` 加 `JOB_MOVED_ON`）。协调会话的 `integration_abandon` 不挂在任何格子上：它的门槛是 LEASE_EXPIRED，不是哪条待办（§2.9 LS6），只在 `mcp.go` 与 runner 门登记。
- `OPEN_LANDING` 作为 LOOKUP 门，与 `OPEN_TASK_SESSION`、`OPEN_COORDINATOR` 同一形状：`id = 'open-landing'`、`capability = LOOKUP`、`outcomes = []`、`resolving = false`，`holder` 取格子的负责人；协调会话一侧 `kind = MCP`、`mcp = session_get`（读 landing 视图，LS6）、`route = /runner/sessions/:id`，owner 一侧 `kind = ROUTE`、`route = /sessions/:id`。登记在每个 `INTEGRATION_*` 格子（两种负责人）与 X-E5 的格子里；landing 视图上线之前以 `implemented = false` 登记，免得「每个 implemented 门的路由都存在」那条普查先红。

### 4.9 测试

`src/apiserver/src/projects/project-exception-todos.pg.spec.ts`（判据 8；本任务创建）：

1. `a merge conflict opens one item owned by the coordinator`（经 `recordIntegrationFailure`，不依赖作业表）
2. `a failed combined-tree check opens one item owned by the coordinator`
3. `a FAILED written by runner finalize opens one item`（改动前跑红：finalize 不产生任何事实）
4. `a FAILED written by the reaper opens one item`（改动前跑红）
5. `an EXECUTABLE exit mismatch and a task_update FAILED each open one item`
6. `an item survives unread messages and is delivered after the running turn ends`
7. `an item whose coordinator has ended is reassigned to the owner`（含挂了之后被 owner 归档的协调会话：它被人关掉了）
8. `items opened while the coordinator is down stay the coordinator's, and reach it once a retry brings it back`（合并冲突与任务失败各一条；改动前跑红：两条都直接给了 owner）
9. `a queued item turn drained by the coordinator's failed turn is returned, stays the coordinator's, and is queued afresh once it is back`（改动前跑红：退回后给了 owner）
10. `the third failure in one successor chain goes straight to the owner`

`src/apiserver/src/projects/exception-escalation.pg.spec.ts`（判据 9）：

1. `an item unhandled for the default two hours escalates to the owner`
2. `a project-specific escalation time is honoured`
3. `escalation writes no conversation_turn, session or wake row`
4. `an item inside its window does not escalate`（阴性对照）
5. `a coordinator that took the item keeps it however long the work takes, and the reader shows no deadline`（修订 13；改动前跑红：接手后一个窗口没有推进就交给了 owner）
6. `an item never handed to a coordinator stuck in an earlier turn escalates as before, and is then the owner's to close`（阴性对照）
7. `a coordinator conversation that has ended carries nothing, however recently it moved`（阴性对照）
8. `an item whose coordinator went down after taking it escalates a window later, and only its owner is told`（判据 9 的性质，走服务自己的 interval；修订 13 之前这一条是「接手后沉默满一个窗口」）
9. `asked again, the item is the coordinator's to take up afresh: only an answer to the new delivery holds it`（修订 13）

`src/apiserver/src/projects/open-item-coordinator-handling.pg.spec.ts` 另加（修订 13，X-D4 第 5 条）：`a fix task landing puts the item it fixes back in front of the coordinator, saying what landed, and leaves the item open for the coordinator to close`（改动前跑红：修复落地后协调会话什么也没收到）。

外加 `src/apiserver/src/projects/task-failed-open-item-sites.spec.ts`（X 表来源普查）。

**本项目的门、真相与处理中（T4–T9、T14–T16 落地时各自的 spec；都在 `src/apiserver/src/projects/`）**：

| spec | 钉住什么 |
|---|---|
| `open-item-doors.spec.ts` | 门表：每一格至少一扇解决型门、`KNOWN_GAPS` 为空；每个 `OpenItemKind` 都被普查到；冲突格点名的门是改分支的那两扇（`task_comment` + `task_reopen` / `task_create`），owner 那一侧的落地重跑有门；`implemented` 的 MCP 门在 `src/runner-go/mcp.go` 里真有、路由门在控制器的元数据里真有；可修复的每一格对当前负责人都有 `task_create` 的挂修复门；**每条指派路径只把门交给手里有它的人**；**任何 CONFLICT 格（任务与晋升、两种负责人）都没有 `integration_retry` 门、也不投影 `RETRY`**（T17）；**每一格的协调者消息里出现的 MCP 工具名都属于这一格的门**（逐格渲染 `openItemMessage`，含挂了修复的那一段；冲突格的消息不含 `integration_retry`）（T17） |
| `open-item-owed.pg.spec.ts` | 「仍然欠着」谓词与对账兜底：兜底把不欠的都关掉一次（升级给 owner 的那条也关）、`sweep` 不升级也不推送不欠的、各读者都不计不欠的、`project-looks-finished` 只看还欠着的，**「不欠的不挡自动合入」是它的第 (4) 例**；第 (6) 例把任务侧三族的每一个事实各摆一对同形状的 item，一条交给兜底、一条交给 `resolveByFact`，断言两边写出同一个 resolution；这个 spec 还拿 `scripts/project-liveness-audit.sql` 的第二条查询对着兜底关掉的行跑，把两边钉在同一段文本上 |
| `promotion-items-moved-on.pg.spec.ts` | 候选离开活跃状态的每条路都带走它的集成待办（被新落地取代、refile 补排、owner「Not now」、取消后迟到的检查结果不开待办、BLOCKED → 修好 → 被取代 → MERGED 之后一条不剩） |
| `promotion-integration-items-close.pg.spec.ts` | 同一条边的三种形状：新候选取代旧的、owner 的 Not now、以及合入落地，各自关掉它下面那条待办 |
| `promotion-landed-by-receipt.pg.spec.ts` | M-T13：卡片之外的回执退役同分支的候选，审批卡与集成失败待办都 `PROMOTION_MOVED_ON`；被取代的候选不再占住 `#check:<project>` 串行槽 |
| `integration-retry.pg.spec.ts` | J-T1b 的两个入口（协调会话 / owner）：理由必填、一次只排一代、失败类与理由记在新一代上、成功 → HANDLED、再失败 → RETRIED 且新待办归协调会话、`CHECK_TIMED_OUT` 与 `ERROR` 可重跑而 `CONFLICT` 不可（MAIN_SYNC 的拒绝文案指向项目线）、手工关掉待办的 Automatic 项目仍可重跑、非 Automatic / 已升级 / 有 owner blocker 各自拒绝、只有本项目的协调会话、超时重排（先结束失控作业）；**owner 发起人写成 `USER` 的那条也在它里面**（owner 门按下去记的是 `retry_requested_by_user_id`） |
| `reopen-landing-handling.pg.spec.ts` | T15：`task_reopen` → 再 DONE 把旧卡交给新一代（处理中）；新一代 LANDED → HANDLED；再冲突 → RETRIED + 新卡；**处理中的 MAIN_SYNC 卡仍扣着别的任务，且读者与领取报同一件事**（T17：那一行读作 `WAITING_MAIN_SYNC` 并点名正在重落地的 generation，同一拍 `dispatch` 只把冲突任务自己的新一代交出去、别的任务什么也领不到），新一代又停下时照旧报；处理中的卡不重新投递、不升级 |
| `open-item-coordinator-handling.pg.spec.ts` | H1–H5 的完整生命周期（任务落地与晋升各两条结果路径、协调会话手工关、重跑在途就是进展、升级后 owner 的卡拒绝协调会话直到「Ask the coordinator again」、非 Automatic 的那几格），以及修订 13 的修复任务落地再投递 |
| `open-item-fix-link.pg.spec.ts` | `fixes_open_item_id`：写入校验、`handledBy` 读出来、有活的修复时没有升级时刻、修复结束后一个安静窗口才升级、被回答过的投递持有它而泛泛的聊天轮次不算 |
| `open-item-hand-over.pg.spec.ts` | `open_item_hand_over`：已结束 / 归 owner / 别的会话 / 空说明 / 超长说明各自拒绝、CAS 输家有单独的错、成功写 OWNER / `HANDED_OVER`、提交后推送、`note` 在读模型里 |
| `open-item-required-action.spec.ts` | `requiredAction` 与 `primaryAction`：门表每一格都有一句、owner 的晋升检查失败那句逐字节、状态 / 活的修复 / 交出事实会改口而不再查一次、`need` 取原始 kind（含升级过的集成类）、lead 的动作**一定**出自这一行持有者的一扇门（说反了的那条在 (5)：`primaryAction` 不会逃出这一行的门）|
| `promotion-failure-coordinator-path.pg.spec.ts` | 晋升失败时发给协调会话的话只点名真能用的门，且 `integration_retry(promotionId)` 真能按下去（消息里没有 `promotion_recheck`）；那一格的消息里出现的每个门名都在这条待办的行上真有（T17） |
| `project-promotion-auto-authority.pg.spec.ts` / `promotion-candidate-freeze.pg.spec.ts` | 自动确认的授权本身（哪些候选不出卡、授权收回后不下发）与候选冻结 / refile 的竞态；**M-T11 只数仍欠着的待办那一条不在它们里**，在 `open-item-owed.pg.spec.ts` 的第 (4) 例 |

---

## 5. 阻塞请求的回复

### 5.1 判据提案裁决的回复

**数据**：`project_criteria_decision_reply`（迁移号见 §0.5，由提案回复任务自选）：

| 列 | 类型 | 语义 |
|---|---|---|
| `intent_id` | uuid PK | FK `project_criteria_decision(intent_id)` CASCADE：一条裁决至多一条回复 |
| `project_id` / `owner_id` | uuid | |
| `channel` | text | CHECK ∈ {`SESSION`, `TASK_COMMENT`, `NONE`} |
| `state` | text | CHECK ∈ {`PENDING`, `SENT`} |
| `session_id` / `client_turn_id` / `turn_id` | uuid / text / uuid NULL | `channel = SESSION` |
| `task_id` / `comment_id` | uuid NULL | `channel = TASK_COMMENT` |
| `created_at` / `sent_at` | timestamptz | |

**R1（outbox）**：`ProjectsService.decideCriteriaChange` 插入 `project_criteria_decision` 的同一事务里插入回复行：`intent.principal_type = 'AGENT'` → `state = PENDING`；owner 自己提的（`OWNER`）→ `channel = NONE, state = SENT`（没有人在等）。

**R2（发送）**：提交后 `CriteriaDecisionReplyService.send(intentId)`：

1. 会话 = `intent.principal_id`。存在、不在 Trash、未结束（G6）→ 用 G6 载体发 `criteria-decision:v1:<intentId>`，钩子里 CAS 回复行 `PENDING → SENT, channel = SESSION`。
2. 否则会话有 `task_id` → 在该任务上写评论（正文带标记 `criteria-decision:v1:<intentId>`），同一事务 CAS `channel = TASK_COMMENT`。
3. 都没有 → `channel = NONE, state = SENT`。

**R3（内容，只取不可变的行）**：`From Orbit · criteria decision: your proposal <intentPublicId> was approved/rejected by the owner at <decided_at>. <Criteria n, m are now revision r — read them back with project_get and continue. / The criteria are unchanged.> <note>`。

**R4（幂等）**：同一 `clientTurnId` 重放时 `createTurn` 返回原轮次，不发第二条；回复行主键挡住第二条评论（判据 10「重复处理不重发」）。

**R5（补偿，无时钟）**：`PENDING` 超过一次提交后边沿仍未发出，决定卡的回执行显示「reply not sent · Send again」，owner 按下即重跑 R2（owner 的写入是事实）。

**R6（读模型）**：`readPendingCriteriaDecisionsForOwner` 的已决项多返回 `reply: { channel, state, sessionTitle, sentAt }`，web 回执行（效果图 6）：`✓ Approved by you at 05:42 · sent to the proposing session (<title>) at 05:42`，或 `· written on its task (the session had ended)`。

### 5.2 ask_owner：协调会话向 owner 提问

**R7（工具）**：MCP `ask_owner`（`mcp.go` 描述 + case；`transport.go` 的 `askOwner`；路由 `POST /runner/projects/:id/owner-questions`，放在 `runner-projects.controller.ts`）：

```ts
interface AskOwnerDto {
  question: string;                                      // ≤ 2000 字符
  options?: Array<{ label: string; description?: string }>;  // 0 或 2–4 项；0 项表示自由回答
  recommendedOption?: number;
  blocksTaskIds?: string[];
  ifUnanswered?: string;                                 // 「不回答会怎样」，卡片原样显示
  clientQuestionId?: string;                             // 缺省由工具调用 id 派生
}
// → { itemId, state: 'OPEN' }，立即返回，不阻塞轮次；答复以轮次的形式到达
```

**R8（权限）**：acting session 必须等于 `project.coordinator_session_id`，否则 403 `ASK_OWNER_COORDINATOR_ONLY`。

**R9（提问的事实）**：同一事务插入 `COORDINATOR_QUESTION` 待办（OWNER，`asked_by_session_id`），`remind_at = now() + exception_escalation_seconds`；提交后推送 `coordinator-question`。

**R10（答复）**：`POST /projects/:id/open-items/:itemId/answer { option?: number, text?: string }`，只接受 owner 凭据（带 acting session → 403 `OPEN_ITEM_OWNER_ONLY`）。同一事务：待办 `RESOLVED / ANSWERED`，写 `answer`。提交后投递 `ANSWER` 给**当前**协调会话：`clientTurnId = owner-answer:v1:<itemId>:<sessionId>`，内容 `From Orbit · owner answer: you asked "<question>". The owner answered: <label 或 text> (<answered_at>).`

答复之后，对话里的卡成为这次答复的记录（修订 14）：读口的 `closedQuestions`（§4.8）带着当时的问题和选项、owner 选了哪项、写了什么、几点答的、转给了哪个协调会话，客户端据此在 `resolvedAt` 那一刻画一张 Answered 卡，并拿掉原来的提问卡；重启 app、换设备、在 Web 上答的都一样。卡上：问题开头两行（Markdown 转纯文本）、所选项（选 Other 或问题没有选项时是 owner 的原话，加引号）、有补充时另起一行补充、答案还没转给任何协调会话时多一行「Waiting for this project’s next coordinator」；详情原样回放问题全文和每个选项，选中项打勾，底栏写「Answered by you · HH:mm」与「Delivered to the current coordinator」或「Waiting for this project’s next coordinator」。按下 Send answer 到读口刷新之间，客户端用本机交出去的那份（问题快照、所选项、应答）顶着，不留空卡。文案以 `docs/mocks/coordinator-question-answered/` 为准，web 与 OrbitKit 是同一份字。

投递的这条消息画成一行（修订 17）：`owner-answer:v1:` 轮次旁记一张 `ownerAnswer` 卡（`@orbit/shared` 的 `OwnerAnswerCard`：`itemId`、`kind`、`sessionId`、`deliveredAt`；owner 用 Not yet… 退回收尾请求的投递走同一命名空间，`kind` 是 `DONE_REQUEST`），排队读口的两种视图与 runner 回显入库读同一个函数（`readTurnCards`），排队时与回显后是同一张卡。`deliveredAt` 取**这个会话**那条 ANSWER 投递行的 `created_at`：R11 轮换后补投给新协调会话时，是新会话被投递的时刻，不是答复时刻。卡由投递行支撑：键在这一命名空间、却没有对应投递行的轮次（调用方自己起的键、投递事务没有提交），或键里的会话不是轮次所在的会话，都没有卡，照旧画成消息。客户端（web、OrbitKit、Android）把这条轮次画成一行灰胶囊 `Sent to the coordinator · HH:mm`（证据卡转交给协调会话那一行的同一句话、同一套时间写法），点开是给 agent 的原文；它是协调会话工作里的一行，不是新一轮的开头，sticky 条不指向它。消息文本一字不改：轮换出的新协调会话靠它知道问了什么。

**R11（轮换不丢）**：协调会话绑定或轮换提交后（X-D4 第 2 条），给新会话投递满足以下任一条件的已答复提问：`blocksTaskIds` 里还有未 DONE / CANCELLED 的任务；或提问会话就是被替换掉的那一代协调会话。投递行唯一键 `(item, session, ANSWER)` 保证每一代只收一次。答复时没有协调会话 → 答复等到下一次绑定再投。

**R12（撤回）**：提问会话调用 `open_item_resolve` 处理自己的提问 → `WITHDRAWN`，`resolution_note` 是撤回理由。卡片不再消失（修订 14）：它成为一张 Withdrawn 记录，同样画在 `resolvedAt` 那一刻——标题 Withdrawn、灰色图标、问题开头两行、「The coordinator withdrew it」加理由；详情照样回放问题和选项，没有勾，底栏写「Withdrawn by the coordinator · HH:mm」加理由。owner 用自己的关闭门（`POST /projects/:id/open-items/:itemId/resolve`）关掉的提问同样是 `WITHDRAWN`，记录里 `resolvedBy = USER`，卡上写「You withdrew it」「Withdrawn by you · HH:mm」。

### 5.3 状态转移

**提案回复**（`project_criteria_decision_reply`）：

| # | from | 已提交事实 | to | 附带写入 |
|---|---|---|---|---|
| R-T1 | — | `project_criteria_decision` INSERT，提案人是 agent 会话 | `PENDING` | 同一事务 |
| R-T2 | — | 同上，提案人是 owner | `SENT / NONE` | 同一事务 |
| R-T3 | `PENDING` | 提交后边沿或 owner「Send again」：提案会话仍在，`createTurn` 的钩子提交 | `SENT / SESSION` | 轮次 `criteria-decision:v1:<intentId>` |
| R-T4 | `PENDING` | 同上：提案会话已结束，任务评论写入提交 | `SENT / TASK_COMMENT` | 评论 |
| R-T5 | `PENDING` | 同上：会话已结束且没有任务 | `SENT / NONE` | — |

**提问与答复**（`project_open_item` 的 `COORDINATOR_QUESTION` 与 `project_open_item_delivery` 的 `ANSWER`）：

| # | from | 已提交事实 | to | 附带写入 |
|---|---|---|---|---|
| R-T6 | — | `ask_owner` 路由的事务提交 | 提问 `OPEN`（OWNER） | 提交后推送 `coordinator-question` |
| R-T7 | `OPEN` | owner 答复写入 | `RESOLVED / ANSWERED` | 提交后投递 `ANSWER` 给当前协调会话 |
| R-T8 | `OPEN` | 提问会话 `open_item_resolve` | `RESOLVED / WITHDRAWN` | — |
| R-T9 | `RESOLVED / ANSWERED` | 协调会话绑定或轮换提交，且满足 R11 | 不变 | 给新会话再投一条 `ANSWER`（每代一条） |
| R-T10 | `OPEN` | 升级时长到了（X-E1 第二条语句） | 不变 | `reminded_at`，推送一次提醒 |

### 5.4 测试

`src/apiserver/src/projects/blocking-request-replies.pg.spec.ts`（判据 10）。提案回复任务创建文件与第一组，ask_owner 任务追加第二组：

- `describe('criteria decision replies')`：
  1. `APPROVE sends the proposing session one message keyed by the intent id`
  2. `REJECT sends the proposing session one message keyed by the intent id`
  3. `processing the same decision again sends nothing more`
  4. `a proposing session that has ended gets a comment on its task instead`
- `describe('ask_owner')`：
  1. `only the current coordinator may ask`
  2. `the owner's answer reaches the current coordinator`
  3. `after a rotation the new coordinator receives the answer too`

每条改动前跑红。

---

## 6. 保险丝与 blocker

### 6.1 agent 自主花费（以保险丝计数任务的定义为准）

本节摘录保险丝计数任务（`34OEE9DwfWYjo3aRFuBgo`）2026-09-13 写在任务评论里的定义。两者不一致时，以那条评论和它落地的代码为准，并回头改本节。

**F1（计量）**：`CoordinatorConvergenceService.assessSpend(projectId, asOf?)`，定义在 `coordinator-convergence.ts` §3。它只读，返回 `{ spend, limits, paused, reason, observed, limit }`，不写任何行，也不挂起任何动作。计量范围是项目**当前常驻协调会话**（`project.coordinator_session_id`）和项目任务留下的已提交行；窗口是读取时刻往前滚动 24 小时（`COORDINATOR_SPEND_WINDOW_MS`）。

| 项 | 计数的已提交行 | 说明 |
|---|---|---|
| `selfStartedTurns` 自发轮次 | 该会话上 `run_event.type = 'turn_end'` 且 `turn_id IS NULL` 的行，按 `ingested_at` | 见 G7：Orbit 投递的轮次都有 `conversation_turn`，engine 自己起的没有 |
| `sessionsOpened` 开出的会话 | 该会话的 `tool_call`：`name ~ '^(mcp__)?orbit__(task_start\|session_create)$'`、`is_error = false`、`finished_at` 非空，按 `started_at` | 数调用、不数 session 行，因为 `execute` 收到 `x-orbit-session-id` 后没有落库。已知漏口：在 Bash 里调 `orbit task start` 不计 |
| `successorRetries` 同一 successor 链的重试 | 项目任务按 `superseded_by_task_id` 连成链，数链上 `creator_type = 'AGENT'` 的后继 | 链首不算重试，人建的后继不算；只看最新一环 `superseded_at` 落在窗口内的链，取最大值 |

**F2（判定与上限）**：任一项**大于**上限即 `paused = true`，等于上限不暂停；多项同时超限时，按「自发轮次 → 开出的会话 → 重试」的顺序报第一个。默认上限 `DEFAULT_COORDINATOR_SPEND_LIMITS` = 40 / 40 / 2（`convergence-contract.ts`）。项目在 `project.convergence_thresholds` 里以 `maxSelfStartedTurnsPerDay`、`maxSessionsOpenedPerDay`、`maxRetriesPerSuccessorChain` 覆盖；`null` 表示无上限，须有 USER 签名（同 OW4）。取值依据见该评论（60 个协调会话各自最忙的 24 小时）。重试上限 2 与 X-C3「同一链第 3 次失败交给 owner」是同一条规则的两面：第 3 次重试是第一个没有规则许可的。效果图里的「6 of 30」「the limit is 30」只是示意，实际显示取 `limits`。

**F3（不算花费）**：外部事实的投递与记账，包括任务状态变化、合并回执、证据修订、owner 答复，以及本文的待办投递、答复投递、提案回复。每条事实仍写一行 `project_convergence_decision` 作审计，不扣计数，`outcome` 恒为 `PROCEED`。事实永不因熔断被拒，`PROJECT_NOT_CONVERGING` 删除。

**F4（已知边界）**：只数当前常驻协调会话，轮换后新会话从零计；agent 约定的 Orbit 定时唤醒与 Watch 投递都有 `conversation_turn`，不计入自发（附录 A-Q11）。

**F5（何时求值）**：`assessSpend` 不在时钟上跑。暂停卡任务（§6.3）在三类已提交事实上调用它：
1. 事件入库事务提交了该协调会话一条 `turn_id IS NULL` 的 `turn_end`；
2. 事件入库提交了该会话一条满足 F1 条件的 `tool_call`；
3. 任务写入提交了一条 `superseded_by_task_id`。

`paused` 为真、且项目没有进行中的暂停段时，写入暂停段（F-T1）。

### 6.2 暂停的数据结构

**`project_fuse_episode`**（迁移 0274）：

| 列 | 类型 | 语义 |
|---|---|---|
| `id` | uuid(7) PK | |
| `project_id` / `owner_id` | uuid | |
| `generation` | int | 本项目第几次暂停，max+1 |
| `dimension` | text | `assessSpend` 返回的 `reason`（三项之一），闭集随计数任务的实现 |
| `observed` / `limit_value` | int | `assessSpend` 返回的 `observed` / `limit` |
| `window_start` | timestamptz | `asOf - COORDINATOR_SPEND_WINDOW_MS` |
| `spend` | jsonb | `{ selfStartedTurns, sessionsOpened, successorRetries }` 快照 |
| `crossing_fact` | jsonb | 触发这次求值的已提交行：`{ table: 'run_event' \| 'tool_call' \| 'task', id }`（F5） |
| `paused_at` / `resumed_at` | timestamptz / NULL | |
| `resumed_by_user_id` / `raised_limits` | uuid / jsonb NULL | |
| `open_item_id` | uuid | `FUSE_PAUSED` 待办 |

部分唯一 `(project_id) WHERE resumed_at IS NULL`：同时至多一段。恢复后行不可变；再次暂停插入新行、生成新待办，不沿用旧行（判据 2）。

**`project_fuse_held_action`**（同一迁移）：`id`、`episode_id`、`project_id`、`seq`、`kind`（CHECK ∈ {`SESSION_CREATE`, `TASK_START`, `SESSION_SEND`, `TASK_SUCCESSOR`, `SELF_WAKE`}）、`acting_session_id`、`request`（原请求体原样）、`idempotency_key`、`state`（CHECK ∈ {`HELD`, `REPLAYED`, `DROPPED`}）、`replayed_at`、`replay_result`。

### 6.3 状态转移

| # | from | 已提交事实 | to | 附带写入 |
|---|---|---|---|---|
| F-T1 | 未暂停 | F5 的三类事实之一提交后，`assessSpend` 返回 `paused = true` | 暂停 | 暂停段 + `FUSE_PAUSED` 待办（OWNER）；提交后推送 `fuse-paused`；打断协调会话正在跑的自发轮次（附录 A-Q11） |
| F-T2 | 暂停 | 协调会话发起的可挂起动作到达 | 暂停 | `project_fuse_held_action(HELD)`，接口返回 202 `{ held: true, code: 'PROJECT_FUSE_PAUSED', heldActionId }` |
| F-T3 | 暂停 | wake 事实的处置为「开判断会话」（`OPEN_JUDGMENT`） | 暂停 | wake 行 `REFUSED / PROJECT_FUSE_PAUSED`，释放键 |
| F-T4 | 暂停 | owner 恢复写入（`POST /projects/:id/fuse/:episodeId/resume { raiseLimits? }`，只接受 owner 凭据） | 未暂停 | 暂停段 `resumed_at` / `resumed_by_user_id` / `raised_limits`；待办 `RESOLVED / RESUMED`；上限写入项目覆盖 |
| F-T5 | 未暂停 | 恢复提交后的边沿 | 未暂停 | 按 `seq` 重放 HELD 动作（F9）；重新路由本段内被拒的事实（F10） |

### 6.4 暂停期间

**F6（外部事实照常）**：`CompletionInputRouter` 各 door、待办投递、回执边沿、owner 答复、提案回复都不看暂停；任务照常跑、照常落地（owner 决定 8）。

**F7（能挂起的）**：acting session 为协调会话的 `session_create`、`task_start`、`session_send`（发给其他会话）、带 `supersedesTaskId` 的 `task_create`；平台替协调会话投递的到期 / 定时唤醒（种类 `SELF_WAKE`，记下原账本行 id，不建轮次）。

**F8（挂不住的）**：engine 内部自己起的轮次，平台无法事先拦截。暂停时打断正在跑的那一轮，之后的只计数；暂停卡如实写「the engine can still start turns on its own; they are counted, not held」。

### 6.5 恢复

**F9（补发）**：按 `seq` 经原来的入口重放，带原 acting session 与原幂等键。入口因为别的原因拒绝时（例如任务已被取消），标 `DROPPED` 并记录原因，显示在已恢复的卡片上（附录 A-Q18）。

**F10（重判）**：对本项目 `status = REFUSED`、`refusal_code = PROJECT_FUSE_PAUSED`、`created_at` 在 `[paused_at, resumed_at]` 内的 wake 行，按其 subject 调对应 door（`routeTaskExceptions` / `routeReadyCriteria` / `routeUnlandedCriteria` / `routeSettledProjects`）从已提交行重新推导。拒绝时键已释放，同一事实键可以重新认领。暂停不写任何按事实键记下的裁决，所以不会重演旧熔断「STOP 期间判过的事实在同一 scope 内永远被拒」的毛病。

**F11（再次暂停）**：恢复不清零计数，窗口按 `assessSpend` 滚动。恢复时没有调高上限、而下一条 F5 事实仍然越限，就再走 F-T1，产生新的暂停段与新卡片；卡片上的「Raise today's limit…」为此而设（附录 A-Q10）。

### 6.6 `COORDINATOR_NO_PROGRESS` 与进展向量的去留

- **F12**：计数任务把熔断从三个生产者授权器（`TaskExceptionInputProducer.authorize`、`CriterionReadyProducer.authorize`、`CriterionUnlandedProducer.authorize`）里摘除，事实不再因熔断被拒（F3）。暂停卡任务只加一条拒绝：进行中的暂停段期间，处置为 `OPEN_JUDGMENT` 的事实以 `PROJECT_FUSE_PAUSED` 拒绝并释放键（F-T3），其余一律放行。`coordinatorEnabled` 的开关检查保留（`coordinator-disabled-negatives.spec.ts` 照旧成立）。
- **F13**：`project_convergence_decision` 保留：每条事实仍写一行审计（进展向量对与 `progressed`），`outcome` 恒为 `PROCEED`，不扣计数；`PROJECT_NOT_CONVERGING` 删除。`planWakeConvergence` 等纯函数随审计行保留。
- **F14**：不再抬起 `COORDINATOR_NO_PROGRESS`。上线时仍未解除的这类行，在该项目下一条事实写审计行时，以 `resolved_by = AUTO`、`detail.cause = 'BREAKER_RETIRED'` 解除（附录 A-Q13）。
- **F15**：`ProgressVector`、`strictlyImproves`、`advanceCounters`、`convergenceDispatchRefusal` 仍被任务级收敛使用，不删。

### 6.7 blocker：可见、带理由解除、条件消失自动解除

**B1（数据，迁移号由 blocker 任务自选）**：`project_blocker` 新增 `resolved_by_user_id uuid NULL`、`resolution_reason text NULL`。CHECK：`resolved_by = 'USER' ⇒ resolved_by_user_id 与 resolution_reason 都非空`；`resolved_by = 'AUTO' ⇒ resolution_reason` 非空（取原因码）。既有触发器 `project_blocker_resolution_final` 继续拒绝改写已解除的行。**不新增 kind**（G5）。

**B2（读）**：`GET /projects/:id/blockers?state=open|resolved` → `{ open: BlockerRow[]; resolvedCount; latestResolved: BlockerRow | null }`。`BlockerRow = { blockerId, kind, reason, label, description, subject: { type, id, title }, paths[], firstSeenAt, resolvedAt, resolvedBy, resolutionReason }`。`label` 由 `detail.reason` 映射，文案取自效果图 6：`OUTSIDE_DECLARED_SCOPE` → `Needs your approval · Changed files it didn't declare`；`ACCEPTANCE_STANDARD_MOVED` → `Standard moved · Its acceptance criterion changed after it started`；`CRITERION_EXEMPTION_ARGUED` → `Needs your decision · It argues a criterion does not apply`。

**B3（带理由解除）**：`POST /projects/:id/blockers/:blockerId/resolve { reason }`。只接受 owner 凭据：非 owner 或带 acting session → 403 `BLOCKER_RESOLVE_OWNER_ONLY`；`reason` 空白 → 400 `BLOCKER_RESOLUTION_REASON_REQUIRED`；已解除 → 409 `BLOCKER_ALREADY_RESOLVED`。写 `resolved_at`、`resolved_by = USER`、`resolved_by_user_id`、`resolution_reason`。

**B4（条件消失自动解除）**：`detail.reason ∈ {OUTSIDE_DECLARED_SCOPE, CRITERION_EXEMPTION_ARGUED, ACCEPTANCE_STANDARD_MOVED}`、`subject_type = TASK` 的 OPEN 行，在其任务的回执提交边沿（`MergeReceiptService.deliverProjectFactsAfterCommit`）上，若该任务这份交付（上次被打回之后）的任务级落地 ∈ {`ON_INTEGRATION_LINE`, `ON_UPSTREAM`}，以 `resolved_by = AUTO`、`resolution_reason = 'WORK_LANDED'`、`detail.receiptId` 解除。落地前不解除。blocker 任务先于 integrationRef 任务落地时，用 `LEGACY_LANDING_BRANCHES` 判定，§1.4 落地后自动改为按项目分支判定（§9.3）。

**B5（blocker 与自动集成）**：进项目分支的自动集成不查这三类 blocker（它们只在旧的 `CRITERION_UNLANDED` 路径上抬起，C3 之后不再为已开始集成的项目抬起）。晋升卡列出带入任务的 OPEN 人工 blocker，owner 在确认合入 main 时一并决定（附录 A-Q14）。

### 6.8 测试

- `src/apiserver/src/projects/coordinator-spend-fuse.pg.spec.ts`（判据 1）：(a) `twenty external facts in a row are all delivered or recorded and never pause the project`（改动前跑红：第 7 条被拒 `PROJECT_NOT_CONVERGING`）；(b) `agent-initiated spend over the limit pauses the project`。
- `src/apiserver/src/projects/coordinator-fuse-recovery.pg.spec.ts`（判据 2）：`the pause card is readable with reason, spend and the resume entry`；`an external fact is delivered during the pause`；`resuming replays the held action and delivers the fact refused during the pause`；`crossing the limit again after resuming creates a second card`。
- `src/apiserver/src/projects/project-blocker-resolution.pg.spec.ts`（判据 3）：`a non-owner is refused`；`the owner resolves with a reason`；`a resolved blocker cannot be rewritten`；`the three kinds stay open before the work lands and resolve automatically after`。
- `src/web/src/components/ProjectBlockers.test.tsx`：`renders kind, description and files`、`submits a resolution with a reason`。

---

## 7. 读模型

### 7.0 传输

- 类型集中在新文件 `src/shared/src/project-progress.ts`。web 今天在 `ProjectsPage.tsx` 里各自重声明项目类型，本项目的新字段不再重声明；Swift 在 OrbitKit 里镜像同名类型。
- 新读接口：`GET /projects/:id/integration`（§1.6）、`GET /projects/:id/open-items`（§4.8）、`GET /projects/:id/promotions/current`（§3.6）、`GET /projects/:id/promotions/merged`（§3.6）、`GET /projects/:id/blockers`（§6.7）。都不放进 `ProjectsService.get`，避免抬高 `project-get-query-count.pg.spec.ts` 的语句数（§1.4 的一条除外）。
- 实时：新增控制事件 `project.progress.changed { id: projectId }`（`ControlEventType`、`RunEventType`、`controlTypeFor` 各加一项），在作业、待办、晋升、暂停段的事务提交后发布；`useControlPlane` 让 `['project', id, …]` 与 `['projects']` 失效。今天没有任何事件刷新项目页，轮询兜底：列表 60 秒、进度 15 秒、会话卡片区 20 秒。

**V0（读模型没有自己的状态）**：本节每个字段都是已提交行的纯函数，不写任何行，也不缓存结论。显示状态的转移就是底层行的转移，刷新由下表的已提交事实触发：

| 显示 | 状态转移取自 | 发布 `project.progress.changed` 的已提交事实 |
|---|---|---|
| 列表 chip、Open items 两组 | §4.2 负责人与终态、§6.3 暂停 | 待办插入、负责人变化、终态；暂停段插入与恢复 |
| 集成线一行、任务行集成三段、Work overview 三格 | §2.2 作业状态、§1.4 任务级落地 | 作业入队、领取、进度回报、终态；回执插入 |
| 确认卡 A / B / C / D | §3.3 晋升状态 | 晋升各状态写入 |
| 协调会话卡「Wake-ups」「Self-started today」 | §4.4 投递行、§6.1 花费行 | 投递行插入与退回；花费行插入 |
| 判据落地说明 | §1.4 判据级落地 | 回执插入（既有的 DONE 重算边沿同一处） |
| 推送与 Needs-you | §7.6 V12 | 同第一行（推送只在提交后发出） |

### 7.1 项目列表：attention 原因（效果图 1）

**V1（服务端）**：`readProjectListAttention` 在 blocker 汇总之外增加：

```ts
interface ProjectListAttention {
  // 既有：userBlockers, coordinatorBlockers, systemBlockers, maxSeverity, attentionSinceAt, nextCheckAt
  ownerItems: Array<{ kind: 'PROMOTION_APPROVAL' | 'COORDINATOR_QUESTION' | 'ESCALATED' | 'FUSE_PAUSED';
                      count: number; oldestWaitingSince: Date }>;
  coordinatorItems: { count: number; leadKind: OpenItemKind; oldestWaitingSince: Date;
                      nextEscalationAt: Date } | null;
}
// 列表行另有 integration: { line: 'MAIN' | 'PROJECT_BRANCH'; ref: string } | null
// 以及 coordinatorActivity: { working: boolean; lastTurnAt: Date | null } | null（未绑定协调会话为 null）
```

`coordinatorActivity.working` 与会话列表的转圈同一判定：RUNNING，或 AWAITING_INPUT 且引擎自起回合 / 子代理在跑，并且没有 PENDING 的审批卡。web 侧栏的 Projects 分组用它点亮行首蓝点，并按「任务写入与协调会话回合取较新」排序（iPhone 抽屉从实时会话列表得到同一事实）。

`ESCALATED` = 负责人为 OWNER、且 `assignee_reason ∈ {ESCALATED, COORDINATOR_ENDED, CHAIN_LIMIT, HANDED_OVER, NO_COORDINATOR}` 的例外类待办。

**V2（web 原因）**：`AttentionReason` 增加五个值；`ATTENTION_REASON_RANK` 是 `Record`，漏写会编译失败：

| reason | 分区 | 排序 | chip（class） | 文案 |
|---|---|---|---|---|
| `approve-merge-to-main` | Needs attention | 与另外三个 owner 原因同一档，按最早等待排序 | `project-row-chip-warning` | `Needs you · Approve merge to main · <age>` |
| `coordinator-question` | 同上 | 同上 | 同上 | `Needs you · <n> question(s) from coordinator · <age>` |
| `escalated-to-you` | 同上 | 同上 | 同上 | `Needs you · <n> escalated to you · <age>` |
| `fuse-paused` | 同上 | 同上 | 同上 | `Paused · coordinator stopped itself · <age>` |
| `coordinator-handling` | **不进** Needs attention，按原有活动规则分区 | — | `project-row-chip-brand`（蓝） | `Coordinator · resolving a merge conflict · <age>` / `Coordinator · checks failed · <age>` / `Coordinator · handling a failed task · <age>` |

四个 owner 原因排在既有的 `needs-user`（用户 blocker）之前。六个分区不变（`projectAttention.test.ts` 钉死）。集成线 chip：`⎇ <ref>`（`PROJECT_BRANCH`）或 `main`；`integration` 为 null 不显示。

### 7.2 项目详情（效果图 2）

**V3（集成线一行）**：`⎇ <ref> · <n> commits ahead of main · synced with main <age> · Running jobs <i> · Queued <q> · Last landing check ✓ passing | ✕ failing | not checked`，右侧 `Integration settings`。`MAIN` 线显示 `main · Running jobs <i> · Queued <q> · Last landing check …`。数据取 `ProjectIntegrationView`。

**V4（集成设置卡，效果图 6 ③）**：`Tasks land on`（`A project branch` · `project/<name>` / `Directly into main`，锁定后禁用并写明原因）、`Merge check`、`Escalate after`；写入 `PATCH /projects/:id/integration`。

**V5（Open items 卡，效果图 2 ②）**：标题 `Open items`，副标题 `<a> need you · <b> with the coordinator · oldest first`；两组 `Needs you`（琥珀点）与 `With the coordinator`（蓝点）。每行：标题、`detailLine`、负责人（`You` / `Coordinator`）、`waiting <age>` 或 `<age> · goes to you in <remaining>`、主按钮（`Review` / `Answer` / `Open` / `Open coordinator` / `View log`）。暂停卡置顶（效果图 6 ①）。组件 `ProjectProgressStatus.tsx` 导出 `ProjectOpenItems`。

**V6（Work overview，效果图 2 ④）**：`readProjectPanorama` 的桶增加 `integrating`、`onIntegrationLine`、`onUpstream`、`doneNotIntegrated`、`waitingForLanding`，满足 `done = integrating + onIntegrationLine + onUpstream + doneNotIntegrated`、`waitingForLanding ⊆ blocked`。格子：

| 格 | 数 | 脚注 |
|---|---|---|
| Running | `running` | task work in progress |
| Ready | `ready` | can start now；全为手动任务时 can start manually；项目暂停时 project is paused |
| Waiting | `blocked` | `<waitingForLanding> waiting for a prerequisite to land`（`waitingForLanding > 0`，只说明其中这一部分）/ `waiting on dependencies` |
| Pending landing | `integrating`（DONE 代码任务，集成已开始但尚无落地回执；包括排队、运行、失败、待处理） | no landing receipt yet |
| ⎇ On project branch | `onIntegrationLine`（`MAIN` 线不显示） | not on main yet |
| ✓ On main | `onUpstream` | landed on main |

`doneNotIntegrated`（非代码任务、未开始集成项目的 DONE）、`failed`、`cancelled`、`awaitingVerification` 非零时才显示为附加格（附录 A-Q19）。

修订 12 对实现的要求（从本段到下面「活性读时推导」一段为止；展示位的列举是现状）：名字位永不为空，按 kind 显示 `Land · <task>`、`Merge check`、`Merge to main`，卡头在多个作业时显示 `Landing <n> jobs`；合入轮自己的标题在合入卡上。运行中的步骤按 runner 事实显示，排队者显示 queued；`inFlight` 与列表/侧栏的 platform working 只计真实 QUEUED / RUNNING，不把失败、待批准或已撤销 QUEUED 算作运行。任务已 DONE 但仍有待落地工作、只在项目分支上，或存在在途作业时，不显示 Ready to wrap up。`inFlight` 的 jobId / landingSessionId / taskId / promotionId、runner、claim、round、check（name/index/count/budgetSeconds/startedAt）、outputMovedAt、progressProtocol、typicalMs、liveness 与 blockingReason 都是可选新字段。这些可选字段同样加在 main 的 `inFlightJobs` 的每一项上（§1.6，要求）；**本修订原先提的 `landings[]` 由 `inFlightJobs` 取代**，本条说的展示位与项目的 Landings 窗口（§2.9 LS6，修订 28）都读它，不再各读一份。

读 `inFlight` 的落地展示位今天有六处，本条的计时、活性与可点规则对六处一样适用（owner 2026-10-19 决定，v4 方案 A）：
1. 项目页的 Work overview（Landing 卡；web `ProjectPanoramaHeader.tsx`、OrbitKit `ProjectsView.swift`、Android `ProjectsScreen.kt`）；
2. 项目 sessions 页的 Landing 卡（web `WorkspaceView.tsx` 的 `SessionProjectLanding`、Swift `SessionProjectPage.swift`、Kotlin `SessionProjectPage.kt`）；
3. 修订 10 合入卡的头（checking 与 merging 两种形态；web `ProjectMergeStrip.tsx`、Swift `SessionProjectPage.swift`、Kotlin `ProjectMergeViews.kt`）；
4. 作业清单的每一行（web `LandingJobsSheet.tsx`、Swift `ProjectLandingJobsSheet.swift`、Kotlin `ProjectsScreen.kt`）；
5. 会话列表项目行的第二行（web `sessionProjects.ts`、Swift `SessionProjectCopy.swift`、Kotlin `SessionProjects.kt`；心跳超过 10 分钟时变灰，是同一种「健康的长检查被画成停滞」）；
6. web 任务页的 Landing 段（`LandTaskStatus.tsx`；iOS 与 Android 的任务页 Landing 段是本期新增）。

按压与「Open landing ›」，main 现有的按压一律不变：
- 第 1、2 处整张卡打开作业清单，清单的行打开任务。
- 「Open landing ›」另写：第 1、2 处的卡上，一个作业时卡底一个；多个作业时每个作业行一个，合入作业那一行不放（它的入口在第 3 处）。第 4 处的每一行一个（合入作业行只有它这一个按压）。
- 第 3 处的整行按压打开**这一轮合入**的落地会话，即 Landings 窗口并定位到这一轮（修订 28；不再叫 Watch，也不再另放一个链接）；作业不少于 2 个时，清单由「All jobs ›」进。BLOCKED 形态不加这个入口（这一轮在等决定，入口在 Landings 窗口：它在窗口最下面）；旧服务端没有 id 时照 main 打开作业清单。
- 「Merged into main」行在 Landings 窗口里（修订 28，不再在项目 sessions 页的时间线上），整行在原地展开这一轮（回执、检查、推送）；协调会话里那一行仍打开回执，这一轮有落地会话时回执底部加「Open landing ›」，进窗口并定位到这一轮。
- 第 5 处保持 main 的按压（协调会话，或项目）。第 6 处只读，当前这一代一个「Open landing ›」。
- 修订 28 起，本节每个「Open landing ›」都打开所属项目的 Landings 窗口并定位到这一次；项目 sessions 页另有一行 Landings，整行打开窗口、停在最底（§2.9 LS6）。

旧服务端没有 `landingSessionId` 时：没有派的按压就是只读（main 的规则，22124bb0a），卡与头不画入口、也不解释；只有第 4 处（链接本该在的地方）在标题下写一句 `No landing page on this server yet.`。新字段一律可选，旧服务端不给时六处都照今天的样子画。

第 1–4 处共用 `landingLine` / `landingHead`（web `ProjectPanoramaHeader.tsx`，OrbitKit `ProjectPage.landingLine` / `ProjectLandingHead`，Android `ProjectPage.landingLine` / `landingHead`）；第 5、6 处各自读心跳（web `sessionProjectLandingLine`、OrbitKit `SessionProjectCopy.landingLine`、`LandTaskStatus` 自己的规则），只共用词表与阈值，所以改规则时六处都要改。三端文案在同一个提交里改，并由 `ProjectPageSectionsCopyParityTests`（Swift↔web）与 `ProjectCopyParityTest`（Kotlin⊆Swift）核对。

**主计时为当前步骤**（从 step_started_at 计），对比该步骤的预算与通常时长；排队为 Queued for（从入队计）。通常时长只对 MERGE_CHECK 取同项目同检查最近通过时长的中位数，或按命令哈希分别计算；TASK_ACCEPTANCE 命令因任务而异，不显示通常时长。累计时长退为次要，从首次领取起算，**轮次按领取计**，例如 `claim 2 · round 1 of 3`。`round N of M` 的 **M 是这种作业一次领取最多能跑的轮数，不是检查条数**（owner 2026-10-20 决定）：`LAND_TASK` 最多 3 轮（J5、附录 A-Q5：推送时目标被别人推进，就回到 FETCH，最多再做 2 轮；`integrate.go` 的 `integrationRefetchRounds = 2`），写 `round N of 3`；`LAND_PROMOTION`（J-T13，第一次推送被抢即结束这一次领取，`promotionRefetchRounds = 0`）与 `CHECK_PROMOTION`（从不推送，也就不会因推送被抢回到 FETCH）只有 1 轮，只写 `round N`，不写 of。M 按作业种类取，不读当前检查的 `count`。现状：三端都在 `of` 后写当前检查的条数（web `landingSession.ts`、`ProjectPanoramaHeader.tsx`、`ProjectProgressStatus.tsx`，OrbitKit 与 Android 同形），按本条改由三端的落地会话收尾任务做；接管保留 `Taken over 09:31 · first started 09:02`，不静默重置首次起点。

活性读时推导：v2 的 LIVE 为 heartbeat ≤90 s 且输出在 10 分钟内动过；QUIET 为心跳新但超过 10 分钟无输出，显示 `No output for … · within its … budget`；SILENT 为心跳 90 s 至 10 分钟，显示 `No word from runner …`；LEASE_EXPIRED 为超过 10 分钟，只表示租约事实，PUSH 结果文案按 J12；LEGACY 未声明 integration-progress/v2，显示 `Reports only between steps`，检查期间不推断静默。**超时（租约过期）的唯一定义——`LEASE_EXPIRED`**（2026-10-08 与 main 对齐后，全文只有这一处定义，§1.6 的 `inFlightJobs.timedOut` / `limitSeconds`、J-T9、J-T10 的放弃门、X-E5 与 X-E4 的文案都引它，都不另立规则）：v2 领取（周期回报）超过 10 分钟没有回报即为过期（`heartbeat_at < now() − 10 min`）；legacy 领取只在阶段边界回报，用 main 读时判定 `timedOut` 的那条放宽界线——git 步骤（fetch / main 同步 / rebase / merge）按领取租约 10 分钟，检查中（`phase = CHECK`）按本作业各检查的 `timeoutSeconds` 之和再加 10 分钟，其余阶段仍是 10 分钟。两种领取都有一条：已领取、尚未回报（`heartbeat_at = claimed_at`）且同一 runner 上同仓库同目标 ref 有更早领取的 `RUNNING` 作业时，视为在本机锁上排队，不算超时。过期的领取若仍由正在心跳的同一进程持有，且是 v2 领取或领取后从未回报，心跳先把它原样重投给那个进程（§2.3 J-T3a，修订 27）；重投不写行，本定义与引它的各处读到的仍是同一个 `heartbeat_at`。legacy 领取的 `LAND_TASK` / `LAND_PROMOTION` 放弃一律写 `PUSH_OUTCOME_UNKNOWN`（J12；`CHECK_PROMOTION` 从不推送，一律 `RUNNER_LOST`），所以这条界线判早了也不会写出一句假的「nothing was pushed」。本地计时只在 LIVE / QUIET 且读数不超过 90 s 时走；刷新失败、读数过期或其他活性状态时冻结并说明原因，停止运行动画。`Output Ns ago` 与 `Updated` 是两个服务端事实，不能用本地时钟伪造进展；长检查按 J-T4 续租，不能仅因累计超过 10 分钟显示 Update unavailable。三端文案在同一个提交里改，并由 `ProjectPageSectionsCopyParityTests`（Swift↔web）与 `ProjectCopyParityTest`（Kotlin⊆Swift）核对。

`ready > 0 && running = 0` 不再触发 Dispatch needs attention，也不据此指向 runner/provider。Run queue 的 `manualReady` 在分页前统计 READY 候选中的 OPEN、`autoRunWhenReady=false` 且 `runAt IS NULL` 的任务，并给出一条真实任务的 id/title；项目已启动、未暂停且仍 OPEN 时，概览显示中性的 Ready to start 和 Open task。旧服务端缺少此字段或队列读取失败时不推测。真实派发拒绝仍由既有任务/项目异常入口呈现。

`Last landing check` 是最近完成 LAND_TASK 的实际检查结果，不证明当前分支 tip 的检查状态；没有检查记录就是 not checked。领先提交数标注 `at last measurement`，失败尝试不清除已有实测。正在处理旧异常的新作业，只有 `handlingJobId` 确实指向该作业时才以其 QUEUED / RUNNING 显示；异常在终态前仍保持 OPEN。

**V7（协调会话卡，效果图 2 ③）**：新增两行，组件 `ProjectProgressStatus.tsx` 导出 `CoordinatorProgressRows`，由 `ProjectCoordinatorCard` 渲染：

- `Wake-ups`：`delivered · last <age>` / `queued · <age>` / `returned · <age>`（琥珀）/ `none yet`。来源：发往当前协调会话的最近一条平台投递（`project_open_item_delivery` 与 `project_coordinator_wake.status = DELIVERED` 取较新者），送达看 `conversation_turn.delivered_at`。
- `Self-started today`：`<selfStartedTurns> of <limit>` + 进度条，取 `assessSpend` 的 `spend.selfStartedTurns` 与 `limits`；暂停时显示 `paused`。

**V8（Automatic 说明文案）**：`PROJECT_BRANCH`：`Tasks land on <ref> by themselves and start once their prerequisites land. It also merges <ref> into main by itself when the checks pass cleanly, and leaves you a receipt with the commit to revert.`（修订 3：原句 `Merging into main always asks you.` 对 `PROJECT_BRANCH` 已不成立，留着它就是在没告知的情况下扩大授权范围）；`MAIN`：`Tasks are checked on main by themselves and start once their prerequisites land. Merging into main always asks you.`（不变）；未决定：现有文案后加 `If its work lands on a branch of its own, it also merges that branch into main by itself when the checks pass cleanly.`

**V9（状态接口）**：`GET /projects/:id/coordinator/status` 的 `coordination` 增加 `wakeups: { state: 'DELIVERED' | 'QUEUED' | 'RETURNED' | 'NONE'; at: Date | null }` 与 `fuse: { selfStartedToday: number; limit: number; paused: boolean; episodeId: string | null }`，并写进 `docs/project-coordinator-status-contract.md` 的字段表。

### 7.3 任务行的集成三段（效果图 3 ①②③）

**V10**：`ProjectTask`（`taskPage`）增加 `integration: TaskIntegrationView`（§2.7）与 `landingWaitCount: number`。分组（`projectTaskGroups`）：

| 分组 | 成员 | 行内 tag |
|---|---|---|
| `Pending landing` | `QUEUED` / `RUNNING` / `CONFLICT` / `CHECK_FAILED` / `ERROR` / `AWAITING_OWNER` | `Queued for integration`；`Integrating · checking`；`Conflict · coordinator`；`Checks failed · coordinator`；`Integration error · coordinator`（负责人为 owner 时写 `· you`）；`Awaiting your approval` |
| `Waiting · for a prerequisite to land` | 依赖未满足且 `landingWaitCount > 0` | `Waits for <n> task(s) to land` |
| `Landed` | `ON_INTEGRATION_LINE` / `ON_UPSTREAM` | `On <ref>`（绿）；`On main`（实心绿，整行淡出） |

**观测文案（修订 29，§10.9）**：交付方式为 `AGENT_PUSH` 的项目，任务 DONE 之后、观测看到之前，任务行第二段读 `Waiting to be seen on <branch>`，带 `delivered_sha` 的短号；观测写下回执之后读 `On <branch>`（§10.6 O-R1）。

其余分组（Running、Ready、Blocked、Done / Cancelled）不变；不适用集成的 DONE 仍在 `Done / Cancelled`。

### 7.4 判据的落地说明（效果图 3 ④）

**V11**：`ProjectAcceptanceCard.tsx` 的 `LANDING` 映射：`LANDED` → `on main`（原 `landed on the default branch`）；`ON_INTEGRATION_LINE` → `on <ref> · not on main yet`（`not on main yet` 用 warn 色）；`UNKNOWN` → `no merge receipt either way`（不变）。仍只在 satisfied 时显示。

### 7.5 卡片（效果图 4、5、6）

会话页卡片区（`WorkspaceView` 的 `<Transcript>` 之后）按既有模式挂 `Session*Card({ projectId })`，React key 带前缀，查询 `['project', id, …]`，每 20 秒轮询，只在项目协调会话里渲染。项目页 Open items 的 `Review` / `Answer` 展开同一组件。

**合入 main 的卡在项目 sessions 页**（修订 10）：`ProjectPromotionCard` 的家是项目 sessions 页进度条下面那张卡（iOS `ProjectMergeCardView`，web `ProjectMergeStrip`）：检查中（`CHECK_PROMOTION` 在途，进度条里那行合入状态挪进来）、A、B、D 四个时刻都在这张卡上，按钮就是卡的三扇门，Details 打开完整的卡；C 不在卡上，是这个项目 Landings 窗口里的一行（§3.6，修订 28；此前是项目 sessions 页时间线上的一行）。协调会话里每个时刻只留**一行**（iOS `PromotionEventLine` / `PromotionReceiptLine`，web `asLine`），说卡的状态（`PromotionCards.eventLine` / `promotionEventLine`），点开就是完整的卡或回执；等你时那一行是橙色，needs-you 计数照旧。macOS 没有项目 sessions 页，靠这一行和项目页 Open items 的 `Review` 进同一个审阅。D 的按钮位置写谁在处理、处理了多久（`Coordinator is resolving it · 4m`，转给 owner 后 `It is yours · waiting 2h`），读的是指向这个候选的那条待办；待办读回来了、却没有一条指向它时，没有人在处理，按钮不画，不再默认写协调会话（2026-10-09：协调会话已把异常项以「工作已在 main 上」关掉，卡片仍写着「Coordinator is resolving it」并转圈）。

**卡片区只放"现在为真"的东西**（2026-09-21，2026-09-24 扩到被拦下的候选；修订 10 起这些都只画成一行）：已经发生的合入是**记录**，画在它发生的那一刻（§3.6 的 `merged` + `ProjectPromotionReceipt`）；被检查拦下的候选（`decided_at`）同样是既成事实，那张卡自己画在那一刻（web `promotionRecordMoment`、原生 `DeliveryAnchor.promotion`）。卡片区那一张传 `drawRecords={false}` 不再画这两者——留在卡片区的记录会压在之后每条消息下面直到项目结束，而下一个候选出现时，同一张卡会改口说另一次合入。另外四条回执（criteria / evidence / owner / settlement）已经按同一条规则落位。

| 组件 | 负责任务 | 状态与文案（英文，取自效果图） |
|---|---|---|
| `ProjectPromotionCard` | 确认卡 | A `Merge <ref> into main?`：Branch / Tasks / Checks / main / Criteria / Lands 六行，按钮 `Merge to main`、`Not now`、`View changes · <n> files`，脚注 `asked <age> ago`；B `Merging <ref> into main…`：Status `main moved <n> commit(s) since the check — re-checking the combined tree (<elapsed> of ~<typical>)`，You `nothing to do — it lands on its own if the re-check passes, and comes back here if it doesn't`，按钮 `Merging…`（禁用）、`Cancel`；C `✓ Merged into main`：Commit / Now on main / Next；D `<ref> can't merge into main yet`：Why / Who / Then，按钮 `Merge to main`（禁用）、`Open coordinator` |
| `OpenItemCard` | Open items 卡 | 冲突 `Merge conflict — needs a fix on the task branch`（Task / Into / Files / After a fix；`Open task session`、`Hand to owner`）；检查失败 `Checks failed on the combined tree`（Task / Check / 日志尾 / Branch；`Open task session`、`View full log`）；任务失败 `Task failed`（Task / How / Retries；`Retry`、`Open session`、`Cancel task`）；每张底部 `Owner: <coordinator 或 you> · waiting <age> · goes to the owner at <escalation>` |
| `EscalatedItemCard` | Open items 卡 | `Now yours — no one acted on this for <duration>`（What / Coordinator / Waiting on it；`Ask the coordinator again`、`Open task session`、`Cancel task`）；`COORDINATOR_ENDED`、`CHAIN_LIMIT`、`HANDED_OVER` 各有对应标题 |
| `CoordinatorQuestionCard` | ask_owner | `The coordinator has a question`（provenance `FROM COORDINATOR`）：问题正文、选项单选与 `Recommended`、`Blocks: … · If you don't answer: …`，按钮 `Send answer`，脚注 `asked <age> ago`；答复后 `✓ Answered · <answer>`，脚注 `by you <age> · delivered to the current coordinator (<nth> of this project)` |
| `FusePauseCard` | 暂停卡 | `The coordinator paused itself`：Why / Spent today / Still running / On hold；按钮 `Resume`、`Raise today's limit…`、`See the <n> turns` |
| `ProjectBlockers` | blocker | 效果图 6 ②：每行 tag + 标题 + 说明 + 路径 + `since <age>` + `Resolve…`；底部 `▸ <n> resolved · latest: <reason>`；弹窗 `Resolve this blocker` / `Why is it no longer blocking?` / `Recorded with your name and this reason` |
| 决定卡回执行 | 提案回复 | R6 |

**三端同一张卡：先说做什么，再给门（T9–T11，2026-10-05 起落地）**。会话行、置顶条、卡片三处都先说**要你做什么**，说同一串字（效果图 `docs/mocks/project-progress/09-owner-item-as-decision.png`）：

| 处 | 说什么 |
|---|---|
| 会话行 | `Escalated to you · <need>`（`need` 由服务端给，§4.8；工单类待办是 `Checks failed`、`Merge conflict`…）。`waitingKind = OWNER_ITEM` 的行写的正是这串字，行上不带按钮。点这一行只打开那个会话本身；项目分组行打开的是项目 sessions 页（web `enterProjectSessions`，iOS `AgentsView` 的同一行为）。把读者带到**卡**上的是会话里的置顶条：归你的异常那一行按下去调 `revealOwnerItemCard`（web `DecisionRail.tsx:912`），带 `item=` 打开会话时的定位也用它（`WorkspaceView.tsx:5603`）；`revealOpenItemCard` 是另外两处（`ProjectPromotionCard.tsx:874` 的 Review、`WorkspaceView.tsx:5711` 的 Chat 落位） |
| 置顶条（web 的 `DecisionRail`） | 每一行指向一张卡，归你的异常也在其中：`Escalated to you · <need>` + 等了多久。条自身的 `aria-label` 是 `Open questions`（`STRIP_LABEL`）；那一行按钮的 `aria-label` 前缀，有归你的异常时是 `N waiting:`，没有时是 `<n> needs your decision:`（`needsDecisionCount`）——后面接的就是这句。press 只滚动不回答 |
| 置顶条（iOS/macOS 的 needs-you bar） | 全是问题时 `N open questions below`，否则 `N waiting below`——卡片还可以在读者上方，这一版按读者位置说 above / below（`NeedsYouLogic.belowText`） |
| 卡片 | **第一行是 `requiredAction`**（服务端那句「下一步做谁做什么」，§4.8）；随后门由 `primaryAction` 领头，每一扇门下一行说它的后果（web `ACTION_CONSEQUENCES` / OrbitKit 的同一张表）；**`Retry` 一行的字面量随行 kind 取**（web `actionConsequence` / OrbitKit `actionConsequence`，三端逐字一致）：集成行是 `A new integration attempt is queued with your reason.`，候选行是 `The current candidate is checked again with your reason.`，**任务失败行是 `The task runs again and this item closes with it.`**——任务失败行的 `Retry` 按下去就是把任务再跑起来（owner 走用户门 `POST /tasks/:id/execute`，协调会话走 MCP `task_start`；§4.7），不是集成重跑，所以说集成重跑的那句字面量在这一行不出现；底部 `Owner: you · waiting <age> · came to the owner at <escalation>`（协调会话一侧是 `goes to the owner in <剩余>`）。`Review` 只在目标候选真的在时出现（`open_item_id` / 读回来的候选），不再指一张已被取代的卡 |

### 7.6 iOS 横幅、推送与 macOS 计数（效果图 1 下半）

**V12（四类推送）**：`PushService.notifyOwnerItem(item)`，只在四类 owner 待办产生或负责人变为 OWNER 时调用，全部在事务提交后：

| kind | 触发 | 标题 | 正文 |
|---|---|---|---|
| `approve-merge-to-main` | M-T2 | `Merge <ref> into main?` | `<n> tasks passed checks on the combined tree · <project>` |
| `coordinator-question` | R9 | `The coordinator has a question` | `<question> · <project>` |
| `escalated-to-you` | X-E1、X-C3、X-D5、X-D6、交给 owner | `Now yours — no one acted on this for <duration>`（`assignee_reason = ESCALATED`）；`COORDINATOR_ENDED` → `Now yours — the coordinator conversation ended`；`CHAIN_LIMIT` → `Now yours — the 3rd failure in this chain`；`HANDED_OVER` → `Now yours — the coordinator handed it over`；`NO_COORDINATOR` → `Now yours — this project has no coordinator`（推送标题，`owner-item-alert.ts#escalationTitle`）。**卡上那句多一段**：`escalationHeading`（`ProjectProgressStatus.tsx:161`）写 `Now yours — this project has no coordinator (waiting <age>)` | `<item title> · <project>` |
| `fuse-paused` | F-T1 | `The coordinator paused itself` | `<why> · <project>` |

载荷：`category: 'ORBIT_OWNER_ITEM'`、`kind`、`sessionID`（项目协调会话，客户端据此打开会话里的同一张卡）、`projectID`、`openItemID`、`thread-id: projectID`、`apns-collapse-id: owner-item-<itemId>`。`approve-merge-to-main` 的点按在 iOS 打开项目 sessions 页（卡在那里，`AppIntent.openProjectMerge`），应用内横幅同样；其余三类照旧打开协调会话（修订 10）。协调会话自己能处理的例外（负责人仍是 COORDINATOR）不推送（owner 决定 7）。

**V13（Needs-you）**：`owner-decision-signal.ts` 的计数加上负责人为 OWNER 的 OPEN 待办（按项目协调会话归集），于是会话列表的 `pendingApprovals` 与 macOS 菜单栏 `need you` 计数都包含四类（判据 13）。会话摘要增加 `ownerItems: Array<{ kind, title, since, need?, mainBranch? }>`（T9：`need` 是从已经读过的原始 kind 算出的短句，不为此多查一次；`mainBranch` 取项目的主分支名），OrbitKit `NeedsYouLogic.banner` 按最早等待取一条，横幅文案 `Approve merge to main · <project>` / `Question from coordinator · <project>` / `Escalated to you · <project>` / `Paused · <project>`。**带 `need` 的三处与不带它的一处**：会话**行**（`NeedsYouLogic.oldestItemWord`）、会话**页头**（`SessionHeader` 的同一串字）与 web 的置顶条写 `Escalated to you · <need>`；**横幅不带**——`NeedsYouLogic.ownerItemText` 写 `Escalated to you · <project>`（`kindWord + " · " + 项目名`），因为横幅是跨会话的一行，它回答「哪个会话」而不是「哪件事」。`need` 只有升级类带，另外三类的话已经把该做什么说完；`need` 缺省或空白时行里也不留一个光秃秃的分隔符。`PushService.needsYouSessions`（APNs 角标）同样计入四类，且不计已经不欠的（`openItemOwed`：升级的路上候选被合入、任务被取消，徽标不留它）。

### 7.7 测试

- `src/web/src/lib/projectAttention.test.ts`（判据 11）：五个新原因各一条标签文案与分区归属；`coordinator-handling never lands in Needs attention`。
- `src/web/src/components/ProjectProgressStatus.test.tsx`（判据 12）：`renders open items in two groups with owner, waiting time and escalation`；`renders the pause card first`；`renders wake-up delivery and self-started usage on the coordinator card`。
- `src/web/src/pages/ProjectsPage.test.tsx` 新增（判据 12）：`shows the integration line row`；`splits done into integrating, on project branch and on main`；`groups tasks by integration stage with waiting reasons`；`describes criterion landing as project branch or main`。
- `src/apiserver/src/push/push.service.spec.ts`（判据 13）：`the four owner item kinds push`；`an item still with the coordinator does not push`。
- OrbitKit：`NeedsYouLogicTests.swift` 增加 `testOwnerItemsCountTowardNeedsYou`、`testCoordinatorItemsDoNotCount`。

---

## 8. 迁移与兼容

### 8.1 迁移

| 迁移 | 内容 | 行写入 | 触发器 |
|---|---|---|---|
| 0270 `project_integration_line` | `project_codebase` 四列 | 无 | `project_codebase_integration_lock` |
| 0271 `project_open_item` | 两张表；`project.exception_escalation_seconds` | 无 | `project_open_item_terminal_guard` |
| 0272 `project_integration_job` | 一张表；`project_open_item.integration_job_id` 外键 | 无 | `project_integration_job_terminal_guard` |
| 0273 `project_promotion` | 一张表；两处外键 | 无 | `project_promotion_terminal_guard` |
| 0274 `project_fuse_episode` | 两张表；一处外键 | 无 | 恢复后不可变 |
| 0265–0269（自选） | `project_blocker` 两列与 CHECK；`project_criteria_decision_reply` | 无 | 无 |
| 0422 `project_codebase_upstream_ref_chosen_at` | `project_codebase.upstream_ref_chosen_at` 与部分索引 `project_codebase_upstream_choice_idx`（L6） | 无 | 无 |

全部迁移只加表、加可空列或常量默认列（常量默认值不重写表），不做 DML，不改 `task` / `session` / `run_event` / `conversation_turn` 上的触发器，不用 `project_acceptance_` 前缀，表名与约束名不含 `judgment`。

### 8.2 保留作审计的账本

- `project_coordinator_wake`：全部行保留。`COORDINATOR_WAKE_EVENTS` 与 CHECK 不变；本文不新增、不退役事件（G5）。
- `project_convergence_decision`：保留；每条事实仍写一行审计，`outcome` 恒为 `PROCEED`（F13）。
- `project_blocker` 的 `COORDINATOR_NO_PROGRESS` 行：保留，按 F14 解除。
- `session.merge_*` 与现有 `session_merge` 路径：保留，服务于未开始集成的项目与手工合并。
- `project_merge_evidence`、`attempt-ended-unsettled.producer.ts`：不动。

### 8.3 会受影响的普查与闭集 spec

| 触发它的改动 | spec | 要做的事 |
|---|---|---|
| 每条新迁移 | `src/apiserver/src/tasks/task-judgment-data-preserved.spec.ts`（逐个钉死 0228 之后的迁移目录；0246 之后号不重复） | 追加目录名，并按文件体例逐条论证不碰 `PRESERVED_RELATIONS` |
| 新触发器 | `src/apiserver/src/common/db-write-inventory.spec.ts`「the installed triggers are the ones the inventory describes」；`db-write-inventory-judgment-removal.spec.ts`（生成器逐字节） | `node scripts/sync-db-trigger-inventory.mjs --write` |
| 核心表触发器数（本文不触发） | `verification-subject-guard-removal.spec.ts` / `.pg.spec.ts`、`task-judgment-removal.pg.spec.ts`（task 24 个）、`completion-ack-removal.pg.spec.ts` | 不在 task / session / run_event / conversation_turn 上加触发器 |
| 新 DB 写入 | `db-write-inventory.spec.ts`「every database write in the tree is in the inventory」及形状检查（重试事务内不得推送或发实时事件）；`db-conflict-metrics.spec.ts`（重试标签为字面量） | 每个写入方法登记 `TRANSACTION_UNITS` / `TRANSACTION_PARTICIPANTS` / `STATEMENT_UNITS`；推送与实时事件放在提交后 |
| 新 `@db.Uuid` 字段、新控制器 | `src/apiserver/src/common/public-id-coverage.spec.ts` | 在 `src/shared/src/codec.ts` 的 `PUBLIC_ID_FIELDS` / `NEVER_PUBLIC_ID_FIELDS` 归类（`claimLeaseOwner` 类属后者），`cd src/shared && npm run build`；新控制器加进 `CONTROLLERS` |
| 名字 | `project-provenance-epoch.spec.ts`（SC7：`sourceSessionId`、`triggerEvent`、`trigger_event` 等七个名字） | 新代码不用这些名字（本文用 `asked_by_session_id`、`acting_session_id`） |
| 写 `project` 行 | `project-status-write-sites.spec.ts`、`project-status-frozen-list.spec.ts` | 写项目设置与覆盖值的方法里不出现 `status:` 键 |
| 锁序 | `src/apiserver/src/common/lock-order.spec.ts`（`events` 1 条、`turnComplete` 4 条 session 写） | 不在这两处加 session 写；新表的锁级写进 `lock-order.ts` |
| 项目详情读 | `project-get-query-count.pg.spec.ts`（17 条） | §1.4 的一条代码库读 → 18；其余新数据走新接口。L6 的记忆读又加一条（24 → 25，2026-10-10） |
| 满足度模块引用者 | `project-criterion-satisfaction.pg.spec.ts`（只许 8 个文件提到它） | 新文件不 import 它；晋升卡的「n of m met」在客户端计算 |
| `COORDINATOR_WAKE_EVENTS` 闭集 | `coordinator-wake.spec.ts`（钉 0250 / 0243 为最新）、`coordinator-disabled-negatives.spec.ts`（`WIRED` 生产者清单与关闭开关对照）、`completion-input.spec.ts`、`project-criterion-declaration-staleness.pg.spec.ts` | 不加事件则不动；新增对既有事实构造函数的调用点要进 `WIRED` 并补关闭对照 |
| wake 处置 | `wake-disposition.spec.ts`（STRANDED 对所有事件开判断） | C4 改动 `ATTEMPT_ENDED_UNSETTLED` 的处置，按新规则重述该 spec |
| blocker kind 闭集 | `project-source-contract.spec.ts`（SR50 / SR51）、`blocker-signal-exit-inventory.spec.ts` | 不加 kind；待办种类不用 `*_BLOCKER_KIND` / `*_SIGNAL_*` 命名。若扫描器把 `project_open_item_kind_chk` 算进去，逐项登记 `resolveWhen`（≥ 60 字符） |
| 回执写入方 | `contracts/outcome-reconciler-v2-source-audit.json` 的 `MERGE_RECEIPT`（`test/outcome-reconciler-v2.contract.test.mjs` 核对符号存在） | 既有符号不改名；新增 `fromIntegrationJob` 条目 |
| runner 路由（**不改** `contracts/runner-write-protocol.json`） | `src/apiserver/src/auth/tenant-isolation-runner-cases.ts` 的 `RUNNER_ISOLATION_CASES` / `RUNNER_ISOLATION_FIELD_CASES`，由 `tenant-isolation-census.spec.ts` 与 `tenant-isolation-runner.pg.spec.ts` 守住（fb89ad992 起） | 新 runner 路由登记进 `RUNNER_ISOLATION_CASES`，请求体或 query 里的 id 进 `RUNNER_ISOLATION_FIELD_CASES`，每条自己带跨租户用例。**不要动 `contracts/runner-write-protocol.json`**：它是写协议契约、不列路由，摘要校验会拒绝已部署的 runner；47de98f3a 加 release 门时也没改它。`protocol_contract_test.go` / `runner-write-protocol.spec.ts` 只在写协议本身变化时才动 |
| MCP 工具 | `src/runner-go/cli_mcp_parity_test.go`、`mcp_test.go` | `integration_retry`、`open_item_*`、`ask_owner` 登记 CLI 能力或豁免 |
| 推送与 Needs-you | `push/judgment-delivery-removal.spec.ts`（PushModule providers 恰为 `[PushService]`，无时钟）、`push.service.spec.ts`（类别字面量、`needsYouSessions` 过滤条件）、`badge-diff.spec.ts`、`sessions/workspace-session-counts.spec.ts`、`sessions/needs-you-owner-decision.pg.spec.ts`；Swift `Phase3LogicTests.swift`、`NeedsYouLogicTests.swift`、`NeedsYouOwnerDecisionTests.swift` | 只在 `PushService` 里加方法；更新类别与计数断言 |
| attention | `projectAttention.test.ts`（六个分区）、`project-list-attention.spec.ts`（汇总形状）、源审计 `PROJECT_ATTENTION` 符号 | 分区不变；形状断言追加新字段 |
| 项目页 web 测试 | `ProjectsPage.test.tsx`、`ProjectAcceptanceCard.test.tsx`（落地文案）、`ProjectPanoramaHeader.test.tsx`、`WorkOverviewReadiness.acceptance.test.tsx`、`ProjectCoordinatorCard.test.tsx`（Automatic 文案） | 随文案与桶的改动更新 |
| 时钟禁令 | `coordinator-wake.spec.ts`、`coordinator-judgment-opening.spec.ts`、`completion-input.spec.ts`、`attempt-budget-meter.spec.ts`、`project-acceptance-judgment-removal.spec.ts`、`outcome-reconciler/` 下钉 0224 那次自动派发义务移除的普查（`tasks.service.ts` 至多一个 `setInterval`；它自己逐行扫全仓找禁词，所以这里不逐字写它的文件名）、`test/compose-topology.test.mjs`、`judgment-removal-net-subtraction.spec.ts` | 升级时钟放新文件 `open-item-escalation.service.ts`（X-E1）；**对账兜底（T2）也在这一个 tick 里**，不新增 `setInterval`、不加脚本、不加 compose 服务——`open-item-escalation.service.ts` 的一拍是 `reconcile() → sweep() → 推送` |
| 门能力表（T4、T17） | `open-item-doors.spec.ts`：每一格至少一扇解决型门、`KNOWN_GAPS` 为空、每个 `OpenItemKind` 都在普查里、冲突格点名改分支的门、owner 的落地重跑有门、`implemented` 的 MCP 门在 `src/runner-go/mcp.go` 真有、路由门在控制器元数据里真有、可修复格对当前负责人都有挂修复门、**每条指派路径只交给手里有门的人**、**每格投影出的 action 都由该格负责人可按、名字在册的门背出**、**`TASK_FAILED` 格的 `RETRY` 对 owner 是 `/tasks/:id/execute`（`CONTROLLER_FILES` 因此含 `tasks/tasks.controller.ts`）、对协调会话是 `task_start`**；T17 另加**冲突格没有会被拒的重跑门、也不投影 `RETRY`** 与**每格消息只点名本格的门**两条 | 新格 / 新 kind / 改门的名字时，这张表与它的普查先改；`openItemActionsFromDoors`、`openItemDoorMessageNames`、`primaryAction` 都从表里取，不另写一份；**写消息时先看名字在不在这一格**（`openItemDoorMessageNames` 没有兜底，缺了就不写那句） |
| 对账与「仍然欠着」 | `open-item-owed.pg.spec.ts`：兜底一次关掉不欠的（含已升级给 owner 的）、`sweep` 不升级不推送不欠的、各读者都不计不欠的、不欠的不挡 M-T11、`project-looks-finished` 只看还欠着的；第 (6) 例逐事实对 `resolveByFact` 与兜底的结局（同一形状的 item，两边同 resolution）；它同时把 `scripts/project-liveness-audit.sql` 的第二条只读查询与 `openItemOwed` 钉在同一段文本上（谓词与 SQL 两处一起改；这个谓词不落在任何迁移里，所以没有第三处） | 新读者一律问 `openItemOwed`，不要只看 `state = 'OPEN'`；给一条待办写结局时照它那一族的边写 |
| 处理中的发起人 | `open-item-coordinator-handling.pg.spec.ts` / `reopen-landing-handling.pg.spec.ts` / `integration-skip-merge-check.pg.spec.ts`（T7、T15、T5 的跳过检查）：`handling_session_id` 与 `handling_user_id` 恰有一个（0380）、H2 按它署名 `COORDINATOR` / `USER`、H3 的新待办继承 owner 的归属 | H1 今天有四个触发点（重排、重检、跳过检查、退回返工后的新一代）；再加触发点时写 `handling_*` 走同一个 `markOpenItemsHandling`，别另造一套，并把这四处数一遍 |
| 名字黑名单 | `project-acceptance-judgment-removal.spec.ts`（`REMOVED_NAMES`）、`project-done-gate.pg.spec.ts`、`project_acceptance_` 前缀的七个普查、`task-judgment-removal.pg.spec.ts`（关系名含 `judgment`） | 避开 |

### 8.4 Legacy 分流

| # | 条件 | 行为 |
|---|---|---|
| C1 | 项目没有代码库行 | 落地判定用 `LEGACY_LANDING_BRANCHES`；`CriterionLanding` 只会是 `LANDED` / `UNKNOWN`，与今天一致 |
| C2 | `lineStarted` 为假 | J9 退化为今天的「只认 DONE」 |
| C3 | `lineStarted` 为真 | 合并由平台负责，失败走待办。`CriterionUnlandedProducer.factsFor` 照常为该项目派生 `CRITERION_UNLANDED`：代码从来没有按 `lineStarted` 过滤，这条事实也仍然经过交付读数——`DELIVERY_REVIEW` 与 owner blocker 都由它触发（待办种类表的 `DELIVERY_REVIEW` 一行）。此行 2026-10-16 按代码更正，此前写的是「不再派生」 |
| C4 | 任何项目 | `ATTEMPT_ENDED_UNSETTLED` 照常记录（`CONSUMED`），不再开判断会话；由 `TASK_FAILED` 待办承担（附录 A-Q12） |
| C5 | 任何项目 | 熔断器摘除（F12–F14） |
| C6 | 会话 `sourceState = UNBOUND` | worktree 逐字节走原路径（L10） |
| C7 | 未开始集成的项目 | 手工 `session_merge` 与 runner `mergeToMain` 不变；已开始集成的项目仍可手工合并（回执照样算落地证据），但协调会话按 G1 不再承担合并 |

### 8.5 部署顺序

1. apiserver 启动时应用 0265–0274（先于任何写新表的代码生效）。
2. runner 发版，带能力 `integration-job/v1` 与 L10 的 `setupWorktree` 改动。在这之前入队的作业停在 `QUEUED`，项目页显示 `Queued`，不丢。
3. web、macOS / iOS 客户端。未知的 `landing` 值与未知推送 `kind` 回落到既有文案。

### 8.6 线上验证用的只读查询（判据 14）

线上验证任务在 orbit-postgres 上执行、把语句与结果贴进证据：

```sql
-- 集成回执与合入 main 的回执
SELECT r.created_at, r.task_id, r.result, r.target_branch, r.detail->>'integrationJobId' AS job,
       r.detail->>'promotionId' AS promotion
  FROM session_merge_receipt r
 WHERE r.project_id = $1 AND r.recorded_by = 'RUNNER'
   AND (r.detail ? 'integrationJobId' OR r.detail ? 'promotionId')
 ORDER BY r.created_at;

-- 协调会话中由 owner 发起、驱动合并或开工的消息（人工核对内容）
SELECT t.seq, t.created_at, left(t.content, 200)
  FROM conversation_turn t JOIN project p ON p.coordinator_session_id = t.session_id
 WHERE p.id = $1 AND t.kind = 'message'
   AND t.client_turn_id !~ '^(open-item|owner-answer|criteria-decision):v1:'
 ORDER BY t.seq;

-- 不应出现熔断拒收
SELECT count(*) FROM project_coordinator_wake
 WHERE project_id = $1 AND refusal_code = 'PROJECT_NOT_CONVERGING' AND created_at >= $2;
```

**僵尸待办（T2；部署前后各跑一次，结果贴评论）**：`scripts/project-liveness-audit.sql` 里有第二条只读查询（`psql "$DATABASE_URL" -f scripts/project-liveness-audit.sql`，与 §10.3 的活性查询同一个文件），按项目 × kind 数「开着但没人再欠」的待办。下面这段是它的形状，`openItemOwed` 那一整段 CASE 省略成一行注释——要跑就正本跑文件：

```sql
SELECT item."project_id" AS project_id, proj."title", item."kind",
       count(*)::int AS open_not_owed,
       (count(*) FILTER (WHERE item."assignee" = 'OWNER'))::int AS with_owner,
       min(item."created_at") AS oldest_opened_at
  FROM "project_open_item" item
  JOIN "project" proj ON proj."id" = item."project_id"
 WHERE item."state" = 'OPEN' AND NOT ( openItemOwed(item) )     -- 谓词逐字见该文件
 GROUP BY item."project_id", proj."title", item."kind"
 ORDER BY item."project_id", item."kind";
```

一段跑着兜底的部署**除了漏掉的那条边到下拍之间**什么也不返回；跑在兜底之前的版本会把它的每一条僵尸都列出来。验收这一段时正是这么读的：**部署后开着且不欠的待办为 0**，`「项目收尾重做」`（`34Y7My8sqhKLWtmCQYv1l`）那条 2026-10-02 的 INTEGRATION_CHECK_FAILED 已关闭、它的 Automatic 恢复。

**对账自己留下的痕迹**：兜底关掉的行 `resolution_note` 以 `backstop:` 开头，点名它说的事实与它此刻的样子（`promotion <id>@<state>` / `task <id>@<status>`，接一句「被 task <id> 接替」「离开 DONE 交付」「离开失败」「正在被再次尝试」「被取消」…），`resolution` 则是漏掉的那条边会写的结局（§4.2 末）。这是分辨「哪条边漏了」的查询入口——线上的兜底每关一条同时打一行 `warn` 日志：

```sql
SELECT resolution_note, count(*)
  FROM project_open_item
 WHERE resolved_by = 'PLATFORM' AND resolution_note LIKE 'backstop:%'
 GROUP BY resolution_note ORDER BY 2 DESC;
```

同一个 tick 还会对「任务已落地、但落的不是这条线」的集成待办打一行 `backstop left … open` 的日志（只报不关，§4.2）。

### 8.7 状态转移与触发点（上线过程）

| # | from | 已提交事实 | to | 说明 |
|---|---|---|---|---|
| C-T1 | 项目在 Legacy 分流上（无代码库行，或 `integration_started_at` 为空） | 本项目第一条集成作业的 INSERT（L3） | 已开始集成 | C1–C3 对该项目不再适用；L3 第 4 步补入队已 DONE 的代码任务 |
| C-T2 | 集成作业 `QUEUED`，没有声明能力的 runner | 声明 `integration-job/v1` 的 runner 心跳 | `RUNNING` | 部署顺序第 2 步之前入队的作业不丢（§8.5） |
| C-T3 | `COORDINATOR_NO_PROGRESS` 行 OPEN | 该项目下一条事实写审计行（F14） | 已解除（AUTO / `BREAKER_RETIRED`） | 附录 A-Q13 |
| C-T4 | 会话 `UNBOUND` | 项目有代码库行之后创建的代码任务会话（`decideSessionSource`） | `SELECTED` → `PINNED` | 已在跑的会话不改（PSC SR29） |
| C-T5 | 旧 wake 事件与收敛账本行 | 无 | 不变 | 只读审计，不迁移、不删除（§8.2） |

### 8.8 测试

- 每个带迁移或新写入的任务，落地前保持这些普查为绿：`task-judgment-data-preserved.spec.ts`、`db-write-inventory.spec.ts`、`db-write-inventory-judgment-removal.spec.ts`、`public-id-coverage.spec.ts`、`project-provenance-epoch.spec.ts`。按项目作业指导，改了 prisma 读写路径的，落地前在合并后的树上跑 CI 的 JavaScript job 命令（apiserver 单元 spec 全量），不能只跑自己的 pg spec。
- 兼容用例（建议名，各任务放进自己的 spec）：
  - `project-integration-ref.pg.spec.ts`：`a project with no codebase row still reads landing from main or master`（C1）
  - `dependency-landed-on-integration-ref.pg.spec.ts`：`a project that never started integration releases dependents on DONE`（C2）
  - `project-exception-todos.pg.spec.ts`：`ATTEMPT_ENDED_UNSETTLED is recorded and opens no judgment session`（C4）
  - `src/runner-go/worktree_test.go`：`TestLegacyWorktreeForksFromWorkDirHead`（C6，与 PSC SR46 的 golden 同组）
- 迁移在装载库上重放：`src/apiserver/src/projects/project-integration-line-migration.pg.spec.ts`（T4 创建，后续迁移任务追加）：把 0270–0274 应用到含既有项目、会话、回执的库上，断言既有行不变、新列取默认值、`project_codebase` 仍为零行。

---

## 9. 任务对照

### 9.1 表

任务 id 后四位用于简写；「接口」列写本任务**交付**、别人依赖的接口及其定义所在节。

| # | 任务 | 负责节 | 交付的接口（定义节） | 依赖的接口 | 测试 |
|---|---|---|---|---|---|
| T1 | 保险丝改为只按 agent 自主花费计数 `…BuFgo` | §6.1、§6.6 F12–F13 | `CoordinatorConvergenceService.assessSpend`、`DEFAULT_COORDINATOR_SPEND_LIMITS`、`COORDINATOR_SPEND_WINDOW_MS`；熔断从生产者授权器摘除、审计行恒 `PROCEED`、删除 `PROJECT_NOT_CONVERGING`（§6.1 F1–F3、§6.6） | G7 | `coordinator-spend-fuse.pg.spec.ts` |
| T2 | blocker 可见、带理由解除、条件消失后自动解除 `…B347f` | §6.7、§7.5 `ProjectBlockers` | B1 两列、`GET / POST …/blockers`、`ProjectBlockerResolutionService.autoResolveLanded`（§6.7） | §1.4（先用 Legacy，见 §9.3） | `project-blocker-resolution.pg.spec.ts`、`ProjectBlockers.test.tsx`；首个动 UI 的任务，复制效果图到 `docs/mocks/project-progress/` |
| T3 | 判据提案裁决后，平台直接回复提案会话 `…d0Fy` | §5.1 | `project_criteria_decision_reply`、`CriteriaDecisionReplyService`（R1–R6）；G6 载体的第一个实现 | — | `blocking-request-replies.pg.spec.ts`（创建） |
| T4 | 项目 integrationRef `…QZSm` | §1（L10 的 runner 半边除外） | 0270、`ProjectIntegrationLineService.configure / startOnFirstIntegration`、`defaultIntegrationLine`、`LandingBranches / taskLanding / CriterionLanding`、`isCodeTask / lineStarted`、`GET / PATCH /projects/:id/integration`（§1.1–§1.6） | — | `project-integration-ref.pg.spec.ts` |
| T5 | runner 从项目集成线的 tip 创建 worktree `…m1GG` | §1.5 runner 行 | `setupWorktree` 从 pin 分叉、`requiredContains` 包含检查（L10） | PSC 现有 pin 握手 | `TestWorktreeForksFromIntegrationRefTip` |
| T6 | 例外待办：模型、FAILED 全路径来源、必达投递与重试链上限 `…DTAn` | §4（§4.6 时钟除外）、G6 排空退回 | 0271、`ProjectOpenItemService.recordTaskFailure / recordIntegrationFailure / recordOwnerItem / resolveByFact / deliver / returnQueuedTurns`、MCP `open_item_*`、`GET /projects/:id/open-items`（§4） | G6 | `project-exception-todos.pg.spec.ts`（创建）、`task-failed-open-item-sites.spec.ts` |
| T7 | 依赖等前置落地到集成线，落地回执写入后派发下游 `…1UVz` | §2.5 J9–J10、§1.5 apiserver 两行 | 新依赖谓词、回执边沿派发、`resolveSource` 的 P4 / P5 输入 | T4 的 `lineStarted`、`taskLanding`、`isCodeTask` | `dependency-landed-on-integration-ref.pg.spec.ts` |
| T8 | 平台自动集成进项目集成线 `…Eq8B` | §2（J9–J10 除外） | 0272、J-T1a 入队与普查、心跳中继、progress / result 路由、`src/runner-go/integrate.go`、`MergeReceiptService.fromIntegrationJob`、`GET /projects/:id/integration` 的作业字段 | T4 的 L3、T5 的 worktree、T6 的 `recordIntegrationFailure` | `project-integration-line.sh`（创建，4 例） |
| T9 | 集成冲突与合并后检查失败接入例外待办普查 `…6osyo` | §2.6、§4.2 集成三行、J-T1b / J-T1c | 作业终态到待办的接线、`integration_retry`、分支新提交自动重集成、M2 的领取阻塞 | T6、T8 | `project-exception-todos.pg.spec.ts` 追加真实作业用例；`project-integration-line.sh` |
| T10 | main 同步进项目分支，以及合入 main 的状态机 `…8Zvpw` | §3（卡片 UI 除外） | 0273、J-S2、`CHECK_PROMOTION / LAND_PROMOTION`、`ProjectPromotionService`、owner 路由、`GET …/promotions/current`、M11 / M12 文档改动 | T8 | `project-integration-line.sh` 追加 5 例 |
| T11 | 合入 main 确认卡（web 与协调会话卡片区，四种状态）`…arL1` | §7.5 `ProjectPromotionCard` | 组件与会话卡片区挂载 | T10 的 §3.6 | `ProjectPromotionCard.test.tsx` |
| T12 | 例外待办超时升级给 owner `…Pv5v` | §4.6 | `ProjectOpenItemEscalationService`、`exception_escalation_seconds` 的写入门、CIR 改句（X-E4） | T6 | `exception-escalation.pg.spec.ts` |
| T13 | 保险丝暂停变成 owner 待办卡片，恢复后补发与重判 `…SpLlV` | §6.2–§6.5 | 0274、挂起与补发、恢复路由、F10 重判 | T1 的 `assessSpend`、T6 的 `recordOwnerItem` | `coordinator-fuse-recovery.pg.spec.ts` |
| T14 | 协调会话向 owner 提问 `…JsbV` | §5.2 | MCP `ask_owner`、答复路由、`ANSWER` 投递与轮换投递 | T6、T3 的 spec 文件与 G6 载体 | `blocking-request-replies.pg.spec.ts` 追加 |
| T15 | 项目列表页：标签按原因显示，并标出集成线 `…S9P` | §7.1 | `ProjectListAttention` 扩展、web 原因与 chip | T4、T10、T12、T13、T14 的数据 | `projectAttention.test.ts` |
| T16 | 项目详情页：集成线一行、集成设置、Work overview 三格、任务与判据的集成状态 `…V80` | §7.2 V3 / V4 / V6 / V8、§7.3、§7.4 | panorama 扩桶、`ProjectTask.integration`、落地文案、集成设置卡 | T4、T8 | `ProjectsPage.test.tsx` |
| T17 | 项目页 Open items 与例外、升级、暂停卡片；协调会话卡新增唤醒送达与保险丝用量 `…1mBbq` | §7.2 V5 / V7 / V9、§7.5 `OpenItemCard` / `EscalatedItemCard` / `FusePauseCard` | `ProjectProgressStatus.tsx`、状态接口的 `wakeups` / `fuse` | T6、T12、T13 | `ProjectProgressStatus.test.tsx` |
| T18 | iOS 横幅与推送、macOS 计数覆盖四类 owner 待办 `…nnOA` | §7.6 | `PushService.notifyOwnerItem`、Needs-you 计数与 OrbitKit 派生 | T6、T10、T12、T13、T14 | `push.service.spec.ts`、OrbitKit 测试、模拟器截图 |
| T19 | UI 验收：实现截图与效果图 1–6 逐张对照 `…1Owq` | §7 全部 | — | 全部 UI 任务 | 截图对照（owner 裁决） |
| T20 | 线上验证 `…ECPM` | 全文 | — | 全部 | §8.6 的查询（owner 签核） |

### 9.2 共用的测试文件

| 文件 | 创建 | 追加 | 约定 |
|---|---|---|---|
| `scripts/acceptance/project-integration-line.sh` | T8 | T9、T10 | 每例一个 `case_<name>` 函数，登记在末尾 `CASES=(…)`；公共夹具放 `scripts/acceptance/lib/integration-line-fixture.sh`；不改别人的 case |
| `src/apiserver/src/projects/blocking-request-replies.pg.spec.ts` | T3 | T14 | 各自一个顶层 `describe`；夹具函数放文件头，追加不改签名 |
| `src/apiserver/src/projects/project-exception-todos.pg.spec.ts` | T6 | T9 | T6 的冲突与检查失败用例经 `recordIntegrationFailure`；T9 另加经真实作业结果的用例 |
| `src/web/src/pages/ProjectsPage.test.tsx` | 既有 | T16 | 新增 `describe('ProjectDetailPage — integration')` |

### 9.3 共享源文件与先后次序

- **`project-criterion-landing.ts`**：只有 T4 改。T2 在 T4 落地前调用既有的 `receiptIsLandingEvidence`，外面包一层 `isTaskLandedForBlocker(receipts, branches = LEGACY_LANDING_BRANCHES)`；T4 落地后把默认值换成项目自己的分支。
- **`schema.prisma`**：各任务把自己的模型加成独立一段，放在 `ProjectCodebase` 之后，不跑 `prisma format`（它会重排全文）。
- **迁移账本、`db-write-inventory.ts`、`codec.ts`、`lock-order.ts`**：只追加；rebase 冲突一律取并集，迁移按号排序。
- **`contracts/runner-write-protocol.json` 与两处 SHA**：T8、T9、T6、T14 都会加路由。rebase 之后重新计算 SHA，不要手合 SHA。
- **`mcp.go` / `transport.go`**：T6、T9、T14 各加一段 case，追加在同类工具之后。
- **Open items 的 `Review`**：T17 可能先于 T11 落地。在 `ProjectPromotionCard` 出现之前，`Review` 先链接到协调会话里的卡片区；T11 落地后改为就地展开。
- **合并**：按项目作业指导，由协调会话负责。任务会话不自己 merge；收工前 rebase 到当时的 main，在完成评论里写明分支名与 commit sha。

### 9.4 数据结构、推进次序与测试

**数据结构**：任务之间的依赖就是 Orbit 的 `task_dependency` 边，§9.1「依赖的接口」列是它们的语义。本项目自己的机制上线前，推进仍按项目作业指导的「合并与交付」：下游一律 `autoRunWhenReady = false`，由协调会话在前置合入 main 后手工开工。

**推进次序（状态转移与触发它的事实）**：

| 层 | 任务 | 可以开工的已提交事实 |
|---|---|---|
| 0 | 契约（本任务）、T1、T2、T3 | 无前置 |
| 1 | T4、T5、T6 | 本契约经 owner 裁决（证据 CONFIRM 派生 DONE），协调会话把本分支合入 main 并记回执 |
| 2 | T7（T4 后）、T8（T4、T5、T6 后）、T12（T6 后）、T13（T1、T6 后）、T14（T3、T6 后） | 每个前置 DONE，且有合入 main 的回执 |
| 3 | T9（T6、T8 后）、T10（T8 后）、T16（T4、T8 后）、T17（T12、T13 后） | 同上 |
| 4 | T11（T10 后）、T15（T4、T10、T12、T13、T14 后）、T18（T10、T12、T13、T14 后） | 同上 |
| 5 | T19（T2、T11、T14、T15、T16、T17 后） | 同上 |
| 6 | T20（T1、T2、T7、T9、T11、T18、T19 后） | 同上 |

**测试**：每个任务的验收即 §9.1 的「测试」列；跨任务共用文件的衔接见 §9.2。本节不另设测试。

---

## 10. 落地观测与交付方式（修订 29）

**状态**：已裁决。owner 2026-10-28 裁决：按本节实现，附录 A 的 Q21–Q25 一律按默认做法；实现项目 `34noHniU4wmCRkZJkR6df`。正文里被 §10.10 点名的条款已按本节改写，改写处标「修订 29」并指回本节；本节保留为正式一节，条款号（O1–O5、O-L*、O-T*、O-J*、O-S*、O-R*、O-X1）不变，实现任务按这些号引用。实现落地之前，这些条款是对实现的要求。设计图：`docs/mocks/landing-observation/`（01 现状、02 进 main 的五条路、03 PR #146、04 建议的设计）。

### 10.1 缘由

2026-10-28，生产上一个外部账号的 `MAIN` 线项目（upstream `refs/heads/feature/v1.1.1`）卡了一整天。它的项目说明要求 agent 只在 `feature/v1.1.1` 上工作、阶段完成即提交推送，于是每个任务的 agent 都在自己的 worktree 里提交，再 `git push HEAD:feature/v1.1.1`。平台照 M-F2 给每个 DONE 的任务建 `TASK_BRANCH` 候选，`CHECK_PROMOTION` 照 M-S1 去 origin 拉 `orbit/task-*`。这条分支只在那台 runner 上，从来没人推过，检查答 `ERROR / SOURCE_BRANCH_MISSING`，候选照 M-T3 写成 BLOCKED。生产库只读快照（UTC 12:33）：

- 8 条候选全部 BLOCKED：7 条 `SOURCE_BRANCH_MISSING`；1 条在补推分支后重查答 `ALREADY_LANDED`，也照样写成 BLOCKED（`blocked_reason = ALREADY_LANDED`）。
- 整个项目只有 1 张回执，是一个任务的 agent 自己调 `merge_receipt` 记的。它的两个下游因此能开工，其余任务都没有回执。
- 协调会话把 6 条 `INTEGRATION_ERROR` 按 `HANDLED` 关掉（§4.7「标记已处理」），门禁照样关着；`project_blocker` 0 行。
- 依赖两个已 DONE 任务的下一个任务从 08:59 起被 J9 拒绝（`A prerequisite is finished but its work has not landed …`），而那两个任务的提交早就在 `feature/v1.1.1` 上了。

这不是第一次。2026-10-09 项目 `34b78EQPNkVF8kM3ki7Ch` 是同一个形状：分支从未推送，检查答 `SOURCE_BRANCH_MISSING`，候选停在 BLOCKED。当时加了 M-T13（回执退役候选），又用迁移 0411 一次性退役了生产上的 5 条。外部贡献的 PR #146（`jianghailong-xy/orbit`）是同一个洞上的第三个补丁：检查发现会话报的 tip 已在 upstream 上时，跳过取源分支，写回执，把候选记成 `SUPERSEDED`。owner 2026-10-28 判定这条跳过不合理，要求从根上重想。

### 10.2 根因

1. **「已落地」= 有回执**（§1.4、J9）。回执只在平台自己合入、Merge 按钮、或 agent 主动调 `merge_receipt` 时写。工作经别的路进了线（agent 直推、协调会话手动快进），平台从不自己去看。
2. **工作的身份是分支名，而这条分支没人负责发布。** §3.2 写「`TASK_BRANCH` 的 tip 只有仓库知道」，候选的 `source_sha` 留空、等检查去远端解析。可 runner 只往目标分支推，从不推任务分支，提示词里也没有让 agent 推。会话行上早就有 runner 报的 `branch_sha`（0370）与 `base_sha`，却没被当作身份。
3. **事实与授权绑在一起。** 检查看到工作已在 main 上，可「已落地」只能经 owner 确认的合入这条路记下，没走确认的就只能记 BLOCKED。
4. **交付方式没有声明。** owner 要 agent 直推（写在项目说明里），平台的 `MAIN` 线照旧给每个 DONE 任务建等 owner 确认的候选。两套规矩互相矛盾，平台察觉不到。
5. **等待没有生产者。** J9 的拒绝文案说落地记下后会自己开工，可检查报错之后，没有谁会去记它。集成待办可以按 `HANDLED` 关掉而条件仍在，界面上看不出项目卡在哪。

### 10.3 原则

- **O1（身份是提交）**：任务交出的工作，由 DONE 时冻结的一对提交 `(delivered_base_sha, delivered_sha)` 指名。之后的检查、合入、观测、回执都按这对提交说话，不再按分支名解析，也不要求任何分支在 origin 上。
- **O2（落地是观测出来的事实）**：「这份工作在不在某条线上」是 git 里的事实，`git merge-base --is-ancestor <delivered_sha> <线 tip>` 就能回答。平台用一个只读的观测作业去看它，看到了就写回执。回执仍是 J9、L10、§1.4 的输入，但它的含义从「某条流水线合并了它」改为「某次观测或合并证明了这个提交在这条线上」。
- **O3（事实与授权分开）**：进了线就是进了线，J9 照常放行，判据照常读落地。没走 owner 确认就进了 main（M7）是另一件事，单独开一条 owner 待办，不让它挡住事实。
- **O4（交付方式由 owner 声明）**：平台合入（agent 不碰目标分支）还是 agent 直推（agent 自己推到 upstream），是项目的设置，不从项目说明里推断。
- **O5（等待必须有生产者）**：一个已 DONE、还没落地、挡着下游的代码任务，此刻要么有在途的作业会给出答案，要么有一条 OPEN 待办在某人面前；这样的待办不能在条件仍在时按 `HANDLED` 关掉。负责人先是协调会话，它处理不了再交给 owner；§4.6 的升级、修订 13 的「接手之后不升级」与 §4.7 的交接都照旧。

### 10.4 数据结构

**`project_codebase` 增两列**（迁移落地时取下一个空号）：

| 列 | 类型 | 约束与语义 |
|---|---|---|
| `delivery_mode` | text NOT NULL DEFAULT `'PLATFORM'` | CHECK ∈ {`PLATFORM`, `AGENT_PUSH`}。另一条 CHECK：`delivery_mode = 'PLATFORM' OR integration_ref = upstream_ref`，即 `AGENT_PUSH` 只在 `MAIN` 线上 |
| `delivery_mode_chosen_at` | timestamptz(3) NULL | owner 写 `deliveryMode` 的时刻；NULL = 从没选过 |

两列都不进 0270 的锁定触发器：换交付方式不动任何 ref。

**`task` 增五列（交付身份，O1）**：

| 列 | 类型 | 语义 |
|---|---|---|
| `delivered_sha` | char(40) NULL | DONE 时冻结的工作提交 |
| `delivered_base_sha` | char(40) NULL | 它的分叉点 |
| `delivered_branch` | text NULL | 工作结束所在的分支短名，回执的 `source_branch`；M-T13 据此认出同一任务、同一源分支的候选 |
| `delivered_session_id` | uuid NULL | 取值的那条会话；不带外键的历史引用（同 0424） |
| `delivered_at` | timestamptz(3) NULL | 冻结时刻。NULL = 没冻结：非代码任务、还没 DONE、工作仍在移动，或身份不明（O-L4） |

**`project_integration_job`**：

- `kind` 加 `OBSERVE_LANDING`；`state` 加 `OBSERVED`；`phase` 加 `OBSERVE`。
- 新列 `observations jsonb NULL`，只给 `OBSERVE_LANDING` 用：每个被观测的任务一项 `{ taskId, deliveredSha, baseSha, onUpstream, onIntegrationLine, empty, fullyApplied }`。`onIntegrationLine` 在 `MAIN` 线上为 null；`fullyApplied` 是 `git cherry` 的结果，只在领取的 runner 本机有这些提交时才测，否则为 null。观测到的两个 tip 写进已有的 `upstream_sha` 与 `target_sha_before`。
- `OBSERVE_LANDING` 不带 `task_id`、`session_id`、`promotion_id`、`landing_id`；`target_ref`、`source_ref` 都写 `integration_ref`。
- 串行键（J1）：`canonical_repo_url || '#observe:' || project_id`，不占任何分支的串行位。新部分唯一索引 `(serial_key) WHERE kind = 'OBSERVE_LANDING' AND state = 'QUEUED'`：一个项目至多一条排队的观测。入队一律 `INSERT … ON CONFLICT DO NOTHING`，后来的触发并进已排队的那一条，因为要观测哪些任务在领取时才算（§10.6）。
- `idempotency_key = ij:v1:OBSERVE_LANDING:<projectId>:<generation>`，`generation` 在代码库行锁下取本项目观测作业的 max+1。

**`project_open_item`**：kind 加两个（§10.7），resolution 加 `ACCEPTED`、`CODELESS`，同一迁移扩 `project_open_item_kind_chk` 与 `project_open_item_resolution_chk`；同一迁移还把 `LANDED_WITHOUT_CONFIRMATION` 加进 `project_open_item_owner_only_chk`（它生来归 owner，不投递协调会话，§10.7），把 `LANDING_UNOBSERVED` 加进 `project_open_item_handling_kind_chk`（`integration_observe` 照 H1 在这条待办上记处理中，§10.8）。

G5 照旧：不加 `project_blocker` kind，不加唤醒事件。设计图 04 画的「project_blocker」在本契约里落成例外待办（§10.7），因为 blocker kind 是闭集（PSC SR50/SR51）。

### 10.5 规则

**O-L1（交付方式的写入门）**：与 L5 同一扇门，即 `PATCH /projects/:id/integration` 的 `deliveryMode`，以及开始门 `POST /projects/:id/start` 的可选 `deliveryMode`。只收 owner 凭据，带 acting session 照 L5 拒绝 403 `INTEGRATION_SETTINGS_OWNER_ONLY`。`PROJECT_BRANCH` 线上写 `AGENT_PUSH` → 409 `DELIVERY_MODE_NEEDS_MAIN_LINE`。线还没定（没人选过、也没开始集成）时同样 409，除非同一请求选 `MAIN`：默认规则在第一次集成时才定线（L3），可能定成项目分支，而 §10.4 的 CHECK 会让那个事务连同写 DONE 一起失败；已是 `AGENT_PUSH` 的项目改到项目分支，须在同一请求里把交付方式改回 `PLATFORM`，否则也是这条 409。开始门照旧整单拒绝带 acting session 的请求（403，开始门自己的码），什么都不写；没有仓库的项目在开始门带 `AGENT_PUSH` → 409 `INTEGRATION_REPOSITORY_UNKNOWN`，带 `PLATFORM` 不写任何东西。L4 的锁定不管它：开始集成之后照样能换，只影响之后写下的 DONE。改成 `AGENT_PUSH` 的同一事务入队一次观测（O-T4）。

**O-L2（M7 的第二种常设授权）**：`AGENT_PUSH` 是 owner 对「agent 自己把工作推到 upstream」的常设授权，与 M7 里 Automatic 的授权同类。这种项目的代码任务 DONE 时不建晋升候选（不走 M-F2），不出确认卡；进 main 由观测记下（O2），也不开 §10.7 的 `LANDED_WITHOUT_CONFIRMATION`。`PLATFORM` 照旧，M7 原文一个字不改。

**O-L3（把交付方式告诉 agent）**：任务启动提示按项目的交付方式加一句（产品文案，英文）：

- `AGENT_PUSH`：`This project delivers by pushing to <branch>. Push your commits to <remote>/<branch> before you finish — Orbit checks that they are there.`
- `PLATFORM`，且项目已开始集成：`Do not push to <branch>. Orbit lands your branch after your work is accepted.`

`<branch>` 是集成线分支的短名（`AGENT_PUSH` 只在 `MAIN` 线上，就是 upstream），`<remote>` 是代码库行的 `remote_name`。工头与验证任务的运行、声明 codeless 的任务不加这句：它们不交付提交。项目说明与它冲突时以设置为准。协调会话写项目说明前读 `project_get.integration.deliveryMode`。

**O-L4（冻结交付身份）**：J-T1a 写 DONE 的事务里，`isCodeTask` 为真时冻结：

1. 收敛管理下的任务（有 `task_checkpoint`）：取 DONE 所依据的那个 checkpoint 的 `commit_sha`、`base_sha`、`branch`，也就是 `checkpointLandingGate` 认可的那一个。
2. 其余任务：取工作结束所在的那条会话（`workBranchEndedOn`）报的 `branch_sha` 与 `base_sha`；分支取 `worktree_branch`，缺省回落 `branch`。
3. 不冻结的情形有两种。一是工作仍在移动（`landingWorkHasSettled` 为假，J-T1e）：等会话结束、写下 `finished_at` 的那个事务里再补冻结，并补做之后的入队。二是身份不明：`branch_sha` 缺失，或 `worktree_branch` 与 `branch` 不同而那条分支的 tip 没报上来。身份不明时按 O-T1 开待办。

`task_reopen` 把五列清空，再次 DONE 时重新冻结。L10 不变：下游的 `requiredContains` 仍从回执里取。

**O-L5（候选按提交指名）**：`PLATFORM` 模式的 `MAIN` 线照旧走 M-F2，但候选在插入时就写 `source_sha = delivered_sha`，不再留空等检查解析（0293 的这一半作废）。`TASK_BRANCH` 源的 `CHECK_PROMOTION` 与 `LAND_PROMOTION` 由源会话所在的 runner 领取，与 `LAND_TASK` 同一条领取条件。M-S1 不再 fetch 任务分支，直接在本机对象库里取这个提交；本机没有 → `ERROR / WORK_COMMIT_MISSING`（J12 加一个码）。此后 `SOURCE_BRANCH_MISSING` 只剩 `LAND_TASK` 与 `PROJECT_BRANCH` 源会答。

**O-L6（检查看到工作已在 main 上）**：`TASK_BRANCH` 候选的检查答 `ALREADY_LANDED`（M-S2：`delivered_sha` 已是 U 的祖先），它本身就是一次观测。结果事务按 O-R1 写回执，M-T13 随之退役候选（`SUPERSEDED`，待办写 `PROMOTION_MOVED_ON`），再按 O-R3 开 owner 待办。不再走 M-T3 写 BLOCKED。

**O-L7（空分支与别的仓库）**：

- `delivered_sha = delivered_base_sha` 表示任务没有自己的提交，照 J8 的 `NOTHING_TO_LAND` 规则：该任务没有任何会话报告过工作时写回执，否则开 `LANDING_UNOBSERVED`（原因 `WORK_ELSEWHERE`）。
- `isCodeTask` 的后半加一个条件：工作会话所在 workspace 的 `repo_url`，经 SR36 规范化后等于项目代码库的 `canonical_repo_url`。不等的不是本线的代码任务：J9 豁免，不冻结，不观测。

### 10.6 观测作业 `OBSERVE_LANDING`

观测不是一次集成尝试：不合并、不推送、不跑检查，所以 G1 对落地会话的要求不适用，观测不开落地会话（附录 A-Q23）。领取、租约、J4 的终态不可变与 J-T4 的租约围栏都照 §2.2。X-E5 不开给观测作业；它超时由 J-T9 结束为 `ERROR / RUNNER_LOST`（同 `CHECK_PROMOTION`，从不推送）。

| # | from | 已提交事实 | to | 附带写入 |
|---|---|---|---|---|
| O-J1 | — | O-T1–O-T5 之一 | `QUEUED` | — |
| O-J2 | `QUEUED` | runner 心跳领取（J-T2 同一扇门） | `RUNNING` | 领取语句从已提交行算出「待观测的任务」，写进命令 |
| O-J3 | `RUNNING` | 结果回报 `OBSERVED` | `OBSERVED` | 同一事务，按任务执行 O-R1–O-R4 |
| O-J4 | `RUNNING` | 结果回报 `ERROR`（`FETCH_FAILED`、`BASE_REF_NOT_FOUND`），或 J-T9 超时 | `ERROR` | 不开集成待办。本项目仍有待观测的任务时，同一事务再入队一条；连续第 3 次失败开 `INTEGRATION_ERROR`（`IE:observe:<projectId>`，归协调会话），下一次 `OBSERVED` 把它写成 `RESOLVED / JOB_MOVED_ON` |

**触发（O-T*）**：每一条都是已提交事实，入队一律 `ON CONFLICT DO NOTHING`。

- **O-T1**：`AGENT_PUSH` 项目的代码任务冻结了交付身份（O-L4 的同一事务）。身份不明时不入队，直接开 `LANDING_UNOBSERVED`（原因 `IDENTITY_UNKNOWN`）。
- **O-T2**：本项目任一工作会话的 `turnComplete` 提交，且本项目有待观测的任务（提交后边沿；agent 可能刚推送过）。
- **O-T3**：本项目任一回执提交（`deliverProjectFactsAfterCommit` 末尾；线可能动了）。
- **O-T4**：owner 把交付方式改成 `AGENT_PUSH`（O-L1 的同一事务）。
- **O-T5**：显式的观测门 `integration_observe`（§10.8）。

补偿点（G2）：下一次 O-T2 或 O-T3、显式的观测门，以及部署时的一次性入队（§10.9）。不加时钟（G3）。

**待观测的任务**（领取时算，`landingPendingObservationSql`）：项目内、`status = DONE`、`isCodeTask`、`delivered_at` 非空、§1.4 任务级落地为 `NOT_KNOWN`。`PLATFORM` 模式也观测，只为认出线外的落地（O-L6、O-R3）；「没看到」在这种模式下不开待办，交给它自己的流水线。

**领取**：`REMOTE` 权威下，任一能访问该仓库的 runner 都可以领，因为观测只读、用不到任务分支。源会话所在的 runner 在线时优先交给它，因为只有它能测 `fullyApplied`。`RUNNER_LOCAL` 权威只交给权威 runner。

**runner 步骤**：

| 步 | 做什么 | 失败 |
|---|---|---|
| O-S1 FETCH | `git fetch <remote> <integration_ref> <upstream_ref>`；U = upstream tip，T = 集成线 tip（`MAIN` 线上 T = U） | fetch 失败 → `ERROR / FETCH_FAILED`；upstream 不存在 → `ERROR / BASE_REF_NOT_FOUND` |
| O-S2 OBSERVE | 逐个任务：`empty = (delivered_sha = base_sha)`；`onUpstream = is-ancestor(delivered_sha, U)`；`PROJECT_BRANCH` 线上另测 `onIntegrationLine = is-ancestor(delivered_sha, T)`。提交不在本机、也不是 U 或 T 的祖先时读作 false：不在线上的提交本来就可能只在别的机器上。本机有 `base..delivered` 这段提交时测 `fullyApplied`（`git cherry U delivered base` 每行都以 `-` 开头） | 不推送、不建 worktree、不跑检查 |
| O-S3 REPORT | `POST /runner/integration-jobs/:jobId/result { state: 'OBSERVED', upstreamSha: U, targetShaBefore: T, observations }` | — |

**结果（O-R*）**：都在结果事务里，按任务执行。

- **O-R1（看到了）**：`onUpstream` 为真时写回执，取值如下表；`onUpstream` 为假而 `onIntegrationLine` 为真时写同样的回执，`target_branch` 换成集成线短名。

  | 列 | 取值 |
  |---|---|
  | `result` | `ALREADY_MERGED` |
  | `target_branch` | upstream 短名 |
  | `source_branch` / `source_sha` | `delivered_branch` / `delivered_sha` |
  | `target_sha_before` / `target_sha_after` | U / NULL |
  | `recorded_by` | `RUNNER` |
  | `detail` | `{ integrationJobId, observed: true }` |

  回执经 `MergeReceiptService` 写，于是：M-T13 退役同一任务、同一源分支上活着的候选；§4.2 的集成类待办按 J-T5 的落地边写成 `RESOLVED / LANDED`，`LANDING_UNOBSERVED` 同样写成 `RESOLVED / LANDED`；提交后由 J10 派发下游。收敛管理下的任务照旧过 `checkpointLandingGate`，O-L4 第 1 条取的就是它认可的那个提交。
- **O-R2（空分支）**：按 O-L7 处理。
- **O-R3（没走确认就进了 main）**：同时满足三条时开 `LANDED_WITHOUT_CONFIRMATION`（§10.7）：项目是 `PLATFORM` 模式的 `MAIN` 线；回执落在 upstream；它不是 M9 的回执（不是确认过的晋升合入的），也不是 owner 本人按 Merge 写的。agent 的 `merge_receipt`、协调会话手动快进后记的回执同样适用，与 M-T13 的退役同一事务开这条。owner 本人按 Merge 的识别：Merge 门的请求带 owner 凭据时，回执 `detail` 记 `requestedBy: 'USER'`；没有这个字段的旧回执不开。
- **O-R4（没看到）**：`AGENT_PUSH` 且工作已停止移动时，开 `LANDING_UNOBSERVED`。原因写 `NOT_ON_LINE`；`fullyApplied` 为真时写 `APPLIED_AS_OTHER_COMMITS`，即改动已经以别的提交进了线。同一 `delivered_sha` 已有 OPEN 的就不另开（dedupe 键带 sha）。`PLATFORM` 模式什么都不写。

**并发**：两条观测不会同时 RUNNING，J1 的部分唯一索引同样管 `#observe:` 键。同一任务被看到两次时，回执按默认幂等键（`mr:v1` 会话 + 源 SHA + 目标分支 + 结果）去重，第二次是 no-op。迟到的结果按 J-T4 的租约围栏拒绝。

### 10.7 两种新待办

| kind | 默认负责人 | 产生它的已提交事实 | `dedupe_key` | payload | 终态事实 → resolution |
|---|---|---|---|---|---|
| `LANDING_UNOBSERVED` | COORDINATOR（Automatic 且有活着的协调会话；否则 OWNER，与 `DELIVERY_REVIEW` 同一规则） | O-R4；O-L7 的 `WORK_ELSEWHERE`；O-T1 的身份不明 | `LU:<taskId>:<deliveredSha>`，身份不明时 `LU:<taskId>:identity` | `{ reason: NOT_ON_LINE \| APPLIED_AS_OTHER_COMMITS \| WORK_ELSEWHERE \| IDENTITY_UNKNOWN, deliveredSha, baseSha, branch, upstreamRef, integrationRef, observedUpstreamSha, observedLineSha, observedAt, jobId }` | 该任务写下落地回执（观测、`merge_receipt`、平台合入）→ `RESOLVED / LANDED`；任务取消 → `TASK_CLOSED`；被 successor 接替 → `SUCCESSOR_FILED`；`task_reopen` → `RETRIED`；声明 codeless（带理由；有提交的照旧被 `TASK_CODELESS_HAS_COMMITS` 拒绝）→ `CODELESS`。**没有 `HANDLED`**：`open_item_resolve` 拒绝它（`OPEN_ITEM_HAS_ITS_OWN_DOOR`） |
| `LANDED_WITHOUT_CONFIRMATION` | OWNER（`assignee_reason = DEFAULT`；不升级、不提醒、不投递协调会话） | O-R3 | `UL:<taskId>:<receiptId>` | `{ receiptId, recordedBy, targetBranch, sourceSha, observed }` | owner 按 Accept → `RESOLVED / ACCEPTED`（`resolved_by = USER`）；任务取消或被接替 → 照 `resolveByFact` 写。**没有 `HANDLED`**：`open_item_resolve` 拒绝它（`OPEN_ITEM_HAS_ITS_OWN_DOOR`），它也不能被送回协调会话（`OPEN_ITEM_NOT_RETURNABLE`） |

标题（英文）：`Not on <branch> yet: <task>`、`Reached <branch> without your confirmation: <task>`；`<branch>` 为短名。两种都不是 `INTEGRATION_*`，所以都不挡 M-T11；`openItemOwed` 为这两种各加一支（前者：任务仍是 DONE、未取消、未被接替、仍是 `NOT_KNOWN`；后者：恒欠，直到 owner 按 Accept）。

**谁先处理（O5）**：`LANDING_UNOBSERVED` 先归协调会话，它手里的门见 §10.8。协调会话接手之后，照修订 13 不按时钟升级；处理不了，用 `open_item_hand_over` 交给 owner（这一格的允许清单里有它）。没有活着的协调会话或 Automatic 关着时，开出即归 owner。`LANDED_WITHOUT_CONFIRMATION` 是授权问题（§0.1 第三行），直接归 owner，不经协调会话转述。

**O-X1（任务落地类集成待办不能空关）**：§4.7「标记已处理」对任务落地类集成待办加一个前置。任务落地类指 `task_id` 非空的 `INTEGRATION_*`，或 `promotion_id` 指向 `TASK_BRANCH` 候选的 `INTEGRATION_*`。该任务仍是 `NOT_KNOWN`、且是某个未结束任务的前置时，拒绝 409 `OPEN_ITEM_CONDITION_STANDS`，消息点名这一格真有的门（`integration_retry`、`integration_observe`、`merge_receipt`、`task_reopen`、`open_item_hand_over`；§4.7 T17 的规则照旧：没有的门不点名）。条件不在了（已落地，或下游都已结束、取消）照常可关。

### 10.8 门

| 动作 | 入口 | 权限 | 效果 |
|---|---|---|---|
| 再观测一次 | MCP `integration_observe { projectId, reason }`；runner 门 `POST /runner/projects/:id/integration/observe`（带 `X-Orbit-Session-Id`）；owner 用户门 `POST /projects/:id/integration/observe` | 项目当前的协调会话，或 owner。`reason` 必填，空白 → 400 `INTEGRATION_OBSERVE_REASON_REQUIRED` | O-T5：入队，或并进已排队的那一条；有 OPEN 的 `LANDING_UNOBSERVED` 时照 H1 记处理中（`handling_job_id`、`handling_reason`、发起人） |
| 指明带着改动的提交 | 已有的 MCP `merge_receipt`：`result = ALREADY_MERGED`，`sessionId` 为该任务的工作会话，`sourceSha` 为线上真正带着这份工作的提交 | 已有门的权限（本租户） | 已有的 ALREADY_MERGED 前置照旧在调用方的仓库里核对祖先关系；写下即走 O-R1 的落地边，关掉 `LANDING_UNOBSERVED` |
| 打回去推 | 已有的 `task_reopen`，带说明 | 已有 | `LANDING_UNOBSERVED` 写 `RETRIED`；任务再次 DONE 时重新冻结身份、重新观测 |
| 交给 owner | 已有的 `open_item_hand_over` | 当前协调会话 | 归 owner；`LANDING_UNOBSERVED` 进这一格的允许清单 |
| 接受 | owner 用户门 `POST /projects/:id/open-items/:itemId/accept` | owner；带 acting session → 403 `OPEN_ITEM_OWNER_ONLY` | `LANDED_WITHOUT_CONFIRMATION` → `RESOLVED / ACCEPTED`；别的 kind → 409 `OPEN_ITEM_HAS_ITS_OWN_DOOR`，已不 OPEN → 409 `OPEN_ITEM_NOT_OPEN`。门表投影成 action `ACCEPT`。要回退，owner 经「Chat about this」请协调会话另建任务；回退是普通工作，不是门 |

`open-item-doors.ts` 的门能力表为两种 kind 各加格子，`KNOWN_GAPS` 仍为空元组。新 MCP 工具按 §4.7 末段登记：`mcp.go`、`transport.go`、`runner-projects.controller.ts`、`cli_mcp_parity_test.go`。

### 10.9 读模型、迁移与测试

**读模型**：

- `project_get.integration` 与 `GET /projects/:id/integration` 加 `deliveryMode`、`deliveryModeChosenAt`（没有代码库行时读 `PLATFORM` 与 null）。开始卡片在 `MAIN` 线上列出两种交付方式让 owner 选（附录 A-Q21）。
- 任务行的集成三段（§7.3）：`AGENT_PUSH` 任务 DONE 后，第二段读 `Waiting to be seen on <branch>`，带 `delivered_sha` 的短号；看到之后读 `On <branch>`。
- J9 的拒绝文案改为说出它在等什么：有 OPEN 的 `LANDING_UNOBSERVED` 时写 `A prerequisite is finished but its work is not on <branch> yet — see “Not on <branch> yet” in open items`；有在途作业时保留原句；两者都没有时（按 O5 不该出现）写原句，并记一行 `warn`。

**迁移**：只加列和约束，不改历史行，不伪造回执。

- 列、CHECK 与 §10.4 的那一个部分唯一索引放在同一迁移里；已有行的 `delivery_mode` 全部写 `PLATFORM`。`error_code` 没有 CHECK（J12），所以 `WORK_COMMIT_MISSING` 只进 `INTEGRATION_ERROR_CODES`，不进迁移。
- 部署后的一次性入队，由启动时一个幂等的任务执行，每个项目至多一条 `OBSERVE_LANDING`：对每个 `lineStarted`、且有「DONE、代码任务、`NOT_KNOWN`」任务的项目，先按 O-L4 从现有行冻结身份（只冻结工作已停止移动、身份明确的），再入队观测。看到的写回执，M-T13 退役它们 BLOCKED 的候选，J10 放行下游。这一轮在 `PLATFORM` 项目上看到的「没走确认就进了 main」按项目合成一条 `LANDED_WITHOUT_CONFIRMATION`（`UL:backfill:<projectId>`，payload 列出任务与回执），不逐任务开。没看到的：`AGENT_PUSH` 项目开 `LANDING_UNOBSERVED`；`PLATFORM` 项目留给它自己的流水线，候选可经 `integration_retry` 按 O-L5 重检。
- 2026-10-28 那个项目：推上去的就是 worktree tip 的任务会在这一轮被看到，下游自己开工；不是的，如果 owner 把项目改成 `AGENT_PUSH`，会落成 `LANDING_UNOBSERVED`，交给它的协调会话。

**测试**：新增 pg spec 与 runner 测试，每条先红后绿。

1. `landing-observation.pg.spec.ts` 复现 10-28：`AGENT_PUSH` 项目，任务直推 upstream，任务分支从未发布 → 观测回执 → 下游被 J9 放行、由 J10 派发。同一结果重放、两条观测先后到达，都只留一张回执。
2. 同一 spec：推的是 rebase 或 cherry-pick 后的另一个提交 → `LANDING_UNOBSERVED`（`APPLIED_AS_OTHER_COMMITS`）→ `merge_receipt` 指明线上的提交 → `RESOLVED / LANDED`，下游放行；其间 `open_item_resolve` 被拒（`OPEN_ITEM_HAS_ITS_OWN_DOOR`）。
3. 空分支（任务被挂进项目、改动在别的仓库）：没有会话报告过工作 → 写回执；报告过 → `WORK_ELSEWHERE`。工作会话的仓库不是项目代码库 → 不是本线的代码任务。
4. `PLATFORM` 模式的 `MAIN` 线：检查答 `ALREADY_LANDED` → 回执、候选 `SUPERSEDED`、`LANDED_WITHOUT_CONFIRMATION`，不再 BLOCKED；M9 回执与 owner 本人按的 Merge 不开这条。
5. O-X1：下游等待时，任务落地类 `INTEGRATION_ERROR` 的 `open_item_resolve` → 409 `OPEN_ITEM_CONDITION_STANDS`；落地后照常可关。
6. O-L5：`TASK_BRANCH` 候选插入时即带 `source_sha`；检查不 fetch 任务分支；本机没有该提交 → `WORK_COMMIT_MISSING`。
7. runner `integrate_observe_test.go`（真实 git）：祖先、空分支、提交只在别的机器上、`git cherry` 全部已应用。
8. 普查：`integration-enqueue-done-sites.spec.ts` 要求每个 DONE 写入点同时冻结交付身份；`open-item-doors.spec.ts` 覆盖两种新 kind 的每一格。

### 10.10 按本节改写的正文条款

| 条款 | 改成 |
|---|---|
| §0.4「落地」 | 有一条证明这份工作（交付身份）在某条线上的回执；回执来自平台合入、Merge 按钮、`merge_receipt` 或观测作业 |
| §0.6、§0.7 | 前缀 O 与 §10 的那一行改为正式条款 |
| §1.1 | `delivery_mode`；`isCodeTask` 的仓库条件（O-L7） |
| §1.4 | 任务级判定不变，仍读回执；补一句：回执可以来自观测（`detail.observed`） |
| §2.1、§2.2、§2.3 | `OBSERVE_LANDING`、`OBSERVED`、`OBSERVE`、`observations`、`#observe:` 串行键、O-T1–O-T5 |
| §2.5 J8、J9 | 观测回执的形状（O-R1）；J9 的拒绝文案（§10.9） |
| §2.6 J12 | 加 `WORK_COMMIT_MISSING` |
| §3.2 | `TASK_BRANCH` 的 `source_sha` 不再由检查回写（0293 作废的那一半） |
| §3.3 M-T3、M7 | `TASK_BRANCH` 的 `ALREADY_LANDED` 不再写 BLOCKED（O-L6）；M7 加 `AGENT_PUSH` 这第二种常设授权（O-L2） |
| §3.4 M-F2、M-S1 | M-F2 只在 `PLATFORM` 模式；`TASK_BRANCH` 源按提交指名，不 fetch 任务分支（O-L5） |
| §4.2、§4.7 | 两种新 kind；O-X1；`integration_observe` 与 Accept 两扇门 |
| §7.3 | 任务行第二段的观测文案 |
| 附录 A | Q21–Q25 的裁决 |

### 10.11 不采纳

- **PR #146 的做法**：在 `CHECK_PROMOTION` 里开一条要七八个条件同时成立才走的跳过路径，而且只在 DONE 时看一次。推上去的是另一个提交、检查跑在推送之前、代码由后面的任务推上去，这几种照样永远 BLOCKED。没走确认就进了 main 被悄悄记成 `SUPERSEDED`，不告诉 owner；HANDLED 照样能空关。它结果事务里的并发保护（按 state 与 claim 做比较并交换写作业与候选，输了就整体回滚重读）与本修订无关，可以单独评审合入。
- **让 DONE 等落地**：DONE 说的是验收通过（§0.4：落地不是 DONE）。把两件事并成一件，会让证据裁决依赖推送的时机。本修订改为 O-L3 把交付方式告诉 agent、O-R4 在没看到时开待办。
- **把任务提交推到 origin 上的平台 ref（如 `refs/orbit/work/<task>`）**：要往用户的远端写任意命名空间的 ref，有的远端拒收，还会在别人的服务器上留东西。源会话所在的 runner 本来就有这个提交（`LAND_TASK` 一直这样用），按提交指名就够了（O-L5）。设计图 04 的初版画的是推 ref，入库版已按本修订改掉。
- **按时钟反复观测**：违反 G3。观测只由已提交事实触发（O-T1–O-T5）。
- **从项目说明里推断交付方式**：违反 §0.4「代码任务」那一行的原则：只由已提交行判定，不由标题或描述推断。

## 附录 A　待 owner 裁决的问题

每条：默认做法 / 一句话推翻方式。未裁决前按默认做法实现。

| # | 问题 | 默认做法 | 可推翻为 |
|---|---|---|---|
| Q1 | 项目分支叫什么 | `project/<projectPublicId>`，锁定前可在设置里改名 | 按项目标题生成 ASCII slug（`project/bg-jobs`），标题无法生成时回退 publicId |
| Q2 | workspace 没有远端时怎么办 | 拒绝集成，生成 `INTEGRATION_ERROR / INTEGRATION_REPOSITORY_UNKNOWN` 待办 | 允许 `RUNNER_LOCAL` 权威，绑定到该 workspace 的 runner |
| Q3 | 开始集成后能否换线 | v1 不能；要换，先合入 main 或放弃当前项目分支（owner 手工处理） | v1 就提供「放弃项目分支并解锁」的 owner 操作 |
| Q4 | upstream 是否自动探测 | 不探测。默认取这个账号在同一仓库上次选的，没有才 `refs/heads/main`；某个仓库第一次用时由协调者在开始请求里建议（它在仓库里读 origin/HEAD），owner 在开始卡片上定；找不到就报错（L6，owner 2026-10-09） | 第一条作业时由 runner 读远端 HEAD 并记录 |
| Q5 | 推送时目标被别人推进 | LAND_TASK 同一作业内最多再做 2 轮 fetch → rebase → 检查，之后 ERROR / TARGET_MOVED。LAND_PROMOTION 第一次推送被抢即结束这一次领取，不在作业内重取：Automatic 的按 M-T12 回 `CHECKING` 重检，owner 确认的在同一确认下重排下一代 `LAND_PROMOTION`（J-T13；owner 2026-10-04 定第一次即结束，2026-10-19 定重排与第 3 次才 BLOCKED，与 M-T12 一致） | LAND_TASK 也 0 轮，立刻生成待办 |
| Q6 | 确认卡的「Not now」 | 该候选记为 `DECLINED`，项目分支再落地新任务时出新卡 | 暂缓 N 小时后重新提醒（对人的时钟，允许） |
| Q7 | `MAIN` 线任务合入 main 的方式 | rebase 后 fast-forward | 与项目分支一样用 `merge --no-ff` |
| Q8 | 改升级时长是否影响已开的待办 | 只影响之后创建的 | 所有 OPEN 待办按新时长重算 |
| Q9 | owner 待办（提问、审批、暂停）要不要提醒 | 升级时长到了推送一次提醒，只一次 | 不提醒 |
| Q10 | 保险丝窗口与恢复 | 按计数任务：读取时刻往前滚动 24 小时；恢复不清零，未调高上限时下一条越限事实会再次暂停（新卡片） | 恢复时从恢复时刻重新起算窗口（`assessSpend` 增加 `since` 参数） |
| Q11 | engine 自发轮次与 agent 约定的定时唤醒 | engine 自发轮次：暂停时打断正在跑的那一轮，之后只计数，卡片如实说明。agent 约定的 Orbit 定时唤醒与 Watch 投递不计入自发（计数任务的已知边界），暂停期间作为 `SELF_WAKE` 挂起 | runner 侧拦截没有收件轮次的 engine 轮次；或把定时唤醒也计为自发 |
| Q12 | 任务失败是否还开判断会话 | 不开，只走 `TASK_FAILED` 待办（C4） | 保留 STRANDED 判据开判断会话，与待办并存 |
| Q13 | 已挂着的 `COORDINATOR_NO_PROGRESS` 行 | 该项目下一条事实写审计行时自动解除（`BREAKER_RETIRED`） | 留给 owner 在 blocker 卡上带理由解除 |
| Q14 | 人工 blocker 挡不挡自动集成 | 不挡进项目分支；晋升卡列出这些 blocker，由 owner 在合入 main 时决定 | 任务有 OPEN 人工 blocker 时 `LAND_TASK` 不领取 |
| Q15 | reaper 把任务重置为 OPEN（runner 失联）算不算失败 | 算，`how = ATTEMPT_LOST_*` | 只认写成 FAILED 的 |
| Q16 | 例外待办的重试链怎么数（X-C2；与保险丝的 `successorRetries` 是两个计数） | successor 链内全部 `TASK_FAILED`（含同一任务的多次会话），自链内最后一次 DONE 起算 | 只数 agent 建的后继，与保险丝口径一致 |
| Q17 | 没有验收命令的任务（证据裁决类）集成时跑什么 | 只跑项目合并检查；没配合并检查就只核对树，不跑命令 | `PROJECT_BRANCH` 线要求必须配置合并检查 |
| Q18 | 补发时入口因别的原因拒绝 | 标 `DROPPED`，在已恢复的卡片上列出原因 | 重新挂起，等下一次恢复 |
| Q19 | Work overview 里 Failed / Cancelled / Awaiting verification 格子 | 非零时作为附加格显示 | 始终显示，与效果图的六格并列 |
| Q20 | 轮换后给新协调会话补投哪些答复 | 挡住的任务仍未结束的，或上一代协调会话问的 | 最近 24 小时内的全部答复 |
| Q21 | 新建 `MAIN` 线项目的交付方式（修订 29，§10.5 O-L1） | `PLATFORM`（保持现状）；开始卡片在 `MAIN` 线上把两种都列出来，由 owner 选。owner 2026-10-28 裁决：按默认做法 | 默认 `AGENT_PUSH` |
| Q22 | 平台合入模式下「没走确认就进了 main」开几条（§10.6 O-R3） | 每个任务一条（`UL:<taskId>:<receiptId>`）；部署时的一次性观测按项目合成一条。owner 2026-10-28 裁决：按默认做法 | 始终按项目合成一条 |
| Q23 | 观测要不要进 Landings 窗口（§10.6） | 不进：观测不是集成尝试，回执照常在任务页与协调会话里显示。owner 2026-10-28 裁决：按默认做法 | 给 `AGENT_PUSH` 的任务开任务段，结案写 `OBSERVED` |
| Q24 | 协调会话建的任务默认归它的项目（10-28 那个外部项目里，修 Orbit 的任务就是这样被挂进去的） | 不改；改动在别的仓库的任务由 O-L7 的仓库条件与空分支规则处理。owner 2026-10-28 裁决：按默认做法 | 协调会话建任务时必须显式传 `projectId` |
| Q25 | O-X1 拒绝空关的范围（§10.7） | 只在该任务挡着未结束的下游时拒绝。owner 2026-10-28 裁决：按默认做法 | 任务没落地就一律拒绝 |

## 附录 B　修订记录

- **v1 草案**（2026-09-13）：首版。九节：集成线、集成作业、main 同步与合入 main、例外待办、阻塞请求的回复、保险丝与 blocker、读模型、迁移与兼容、任务对照；附录 A 列 20 个待定问题与默认做法。
- **v1 修订 1**（2026-09-21）：§2.4 增「检查前的铺环境」（J-S5 与 M-S3 跑检查前，先在组合树里运行仓库自带的 `scripts/worktree-overlay.sh`），J12 增 `CHECK_TREE_UNPREPARED`。缘由：2026-09-21 集成线第一次在真实运行中跑起来时，一条验收命令为 `cd src/web && npx vitest run …` 的任务被判 `CHECK_FAILED`——组合树是纯 git 树，没有 `node_modules`，命令死在 `Cannot find package '@vitejs/plugin-react'`，与实现无关。选「组合树应当被铺好」而不是「验收命令必须自包含」：后者要判的是命令的形状，而形状不是错——同一条命令在会话 worktree（已铺 overlay）里是通过的，判据 6 要的是同一条命令在同一种树上得到同一个判决；把约束改写成「作者必须自带铺设」还会让今天所有以前端命令声明的任务追溯性地作废，而作者写的命令在别处是正确的。铺环境写在平台一侧只有一处，且不动「落地的树 = 测过的树」的判定（`node_modules`/`dist` 均 gitignored，不进 `C^{tree}`，也不出现在 J-S6a 的 `git status --porcelain --untracked-files=no` 里）。
- **v1 修订 2**（2026-09-22）：明确一条边界——`coordinator_enabled` 只约束**自动**交付（生产者唤醒、平台自动把待办投递给协调会话），不约束 **owner 自己按下的那一次**。§4.7 的「让协调会话再看一次」与 §4.4 第 1 条的 `askable` 都改按**会话**判（存在活着的协调会话即可），计数那条读也去掉 `coordinatorEnabled: true`。缘由：2026-09-22 owner 报一个「标准集确认过、却从未启动」的项目（`coordinator_enabled=false`、`config_revision=0`）——它的 3 条异常卡画在协调会话里，而会话列表行、标题栏、needs-you 条三处全暗，因为计数比「卡片画在哪」多写了一句开关判据：**同一个事实两条判据**，指向的正是当初把开关写进判据的理由（「点了打不开东西的 badge 比暗的更糟」）的反面。同族的第二处：卡片上的「Ask the coordinator again」被同一条开关判据藏起来，而真按下去也会在 `deliver` 那一行被弹回 owner（`handToOwner(NO_COORDINATOR)`），转一圈回到原处。选择把开关收窄成「别自行动手」而不是「人也叫不动」：自动那一半一字未动（四个 wake producer 与 `coordinator-disabled-negatives.spec.ts` 照旧成立），只有 owner 自己那一次按压走 `deliver(itemId, 'OWNER')`。F12 的「开关检查保留」说的是生产者那一族，未受影响。
- **v1 修订 3**（2026-09-23）：G5 对 `COORDINATOR_WAKE_EVENTS` 开一处例外，增 `DEPENDENT_READY`（迁移 0299）。一条前置落地（§2.5 J9 的谓词，在 J10 的两条边沿上：回执提交，以及没有要落地的代码时的 DONE）放出一条 `autoRunWhenReady = false`、当前可开工的下游时，平台把「它可以开工了」送到协调会话并点名那条下游；开不开工是会话的判断（§0.1），平台不开。缘由：2026-09-23 项目 `34Tcl0kralZrY8opuLJU4` 的最后一条任务前置已落地、协调会话醒着，却没有任何事实因为它可开工而到达，项目停了两个多小时，直到有人去看——目标里点名的不送达事件之一（依赖就绪但 autoRun=false）。不放新表，因为它不是例外待办：没有异常要处理、没有终态要记，要的只是送到一次。载体是 G6（`CoordinatorDeliveryService.queue`：`createTurn` + `NEXT_TURN`，`participateSendTransaction` 里重读会话未结束并把唤醒行绑成 DELIVERED），不走 `resume`（X-D3）；幂等键复用唤醒账本的（事件，下游任务，`task_dispatch_epoch`），同一代只投一次。会话忙时排在未读消息之后；会话已结束或项目没有协调会话时拒绝并交还键，不复活会话，下游留在 owner 的 Ready-to-run 列表上（默认做法；要推给 owner 就改成 OWNER 待办）。此前 0298 已为 `TASK_DISPATCH_REFUSED` 在这个闭集里加过一次。
- **v1 修订 4**（2026-09-23）：M7 放开一处——项目分支 + Automatic + 检查干净 → 平台自行合入 main（新增 M-T11、M-T12，迁移 0301 的 `confirmed_automatically` 两列，runner 能力 `promotion-automatic-land/v1`，§3.6 `merged.automatic` / `merged.revert`，V8 文案）。缘由：owner 2026-09-23 的决定「有自己的项目集成分支 + automatic 就可以合并；如果是 main 或非 automatic，就需要人来点」；线上实测两个项目（一个 30 小时 15 张、一个 6 小时 6 张）的 21 张晋升卡里 20 张在几分钟内被按下，按已经不是决策而是形式。边界：项目分支是已过线检查的暂存区（干净），Automatic 是 owner 已给过的授权（可以自己动），两者都在才不越权；「干净」一字不放宽——检查红、有冲突、main 在检查后前进、有 OPEN 集成类待办，任一即出卡，main 前进由 runner 在推送前判（只落到 `upstream_sha_checked`，动了就原样交回），声明不了这一点的旧 runner 不参与自动落地；授权在领取时重读一次，检查之后被收回（Automatic 关、线改、新开集成类待办）的落地不下发、交回 owner。代价：`coordinator_enabled` 从此同时是「自动交付例外」与「自动合入 main」的授权，为前者打开的项目会顺带得到后者；不另加开关（owner 明确选择复用 Automatic），改为在该列注释与 Automatic 文案里写明。部署顺序：apiserver 先上即安全——没声明 `promotion-automatic-land/v1` 的 runner 一律出卡，与今天一致；runner 升版（root `package.json` 版本号 bump、自更新）之后，自动合入才对该 runner 上的项目生效。
- **v1 修订 5**（2026-09-23）：G5 对 `COORDINATOR_WAKE_EVENTS` 再开一处例外，增 `PROJECT_SETTLED_UNMERGED`（迁移 0303）。结算后的项目，若它的集成线上仍有成果没有任何回执说到 upstream，平台把「这些提交停在集成线上、没进 main」送到协调会话并点名提交（`detail.commits`）；合并由谁做是会话/owner 的判断（M7），平台不合、不排候选、也不改任何守卫。缘由：2026-09-23 项目 `34ODoUKJGEsfbgcJDGS4q` 已 DONE，而 `d6b55d2d853f8b2410977674e3ec54c39f52a34e` 停在 `project/34ODoUKJGEsfbgcJDGS4q` 上、比 main 多一个提交：承载它的落地作业在会话写下这个提交之前九分钟就已终态 `ALREADY_LANDED`（§2.2 J-T5 的那条答案是「分支上已经没有 line 没见过的提交」，而会话后来又提交了一次），于是没有任何一次「队列变短了」来为这个 tip 排候选（M-F1/M-F4），而结算之后连会重新读这条线的写入也停了——它最终由人手工重放进 main。不放新表，因为它不是例外待办：没有失败要处理、没有终态要记，要的只是送到一次。载体是 G6（`CoordinatorDeliveryService.deliver` → `sessions.resume`，`createTurn`），不走 `WakeDispositionService`（那条规则读的是一条验收标准的覆盖度，而结算要求每条标准都已 LANDED，没有标准可读）；幂等键是（事件，项目，`(taskId, tipSha)` 对的摘要），同一批残留只投一次、残留移动一次就再投一次。读的是 `project-criterion-landing.ts` 自己的两个折叠（`taskLanding` 与 `taskHasNothingToLand`）而不是第二份「线上的、不在 main 上的」判断；只在**已结算**的项目上读，所以线上有活而项目还开着的常态不会产生任何东西。此前 0298 为 `TASK_DISPATCH_REFUSED`、0299 为 `DEPENDENT_READY` 已各加过一次。
- **v1 修订 6**（2026-10-01）：J-T1b 落地为协调会话的 `integration_retry`（理由必填），§4.7 的 owner 门暂不实现。缘由：2026-10-01 项目 `34Y7My8sqhKLWtmCQYv1l` 的三条 DONE 任务（③ `34Y7Utvsd47A14DjMzIzD`、Automatic 路由修复、合并检查基线修复）各只有第 1 代 `LAND_TASK`，都以 `CHECK_FAILED` 结束（合并检查在 main 上本来就红；基线那条是 TASK_ACCEPTANCE 里 `go test` 撞上 10 分钟默认超时），项目分支从未建立；其中两条的待办已被协调会话手工 `HANDLED`，没有在途作业，也没有 owner blocker。`task_start` 只会再跑一遍任务、开新分支，从不重新排落地；契约里写的 J-T1b 一直没有实现，于是没有任何一扇门能让这些成果重新上线，下游全被依赖链挡住。取舍：（1）理由必填、记在新一代作业上（迁移 0344 的四列），因为「平台从不自己重跑」只有在每次重跑都有人说明为什么这次会不同时才成立；（2）权限按待办归属判，没有 OPEN 待办时才看 Automatic——这样协调会话手工关掉的待办（③ 的状态）在 Automatic 下仍可重跑，而 owner 的待办（升级、非 Automatic）只有 owner 交回后才归协调会话，与修订 2 对那次按压的读法一致；（3）冲突不在可重跑之列：同样的提交原样重放只会再冲突；（4）分支取「此刻一次 DONE 会交给线」的那条而不是失败那一代的 `source_ref`：基线任务第 1 代落地的分支 `orbit/transcript-runner-go-5-e1acaf` 已与新的 main 冲突，它的成果在后来那次运行的分支上；（5）再失败的那一代照常开分类待办给协调会话，不加链上限——普通的落地去留不是 owner 的问题（§0 的 COORDINATOR_BOUNDED）。
- **v1 修订 7**（2026-10-03）：§4.4 X-D5、X-D6 区分协调会话「挂了」与「结束了」。运行失败（会话 FAILED、没有 `end_reason`、仍在 Open——API 错误、登录过期、runner 掉线，`conversationIsDown`）不算结束：新开的例外待办照常归 COORDINATOR；投递时 `createTurn` 拒绝 FAILED 会话，就先不投；失败轮次的排空退回的待办也不再转给 owner，只换 `assigned_at`，好让下一次投递是一条新轮次。会话被重试后，下一轮结束时由 X-D4 第 3 条补投；窗口内没回来，由 X-E1 升级。被人结束、归档、删除的会话照旧交给 owner。缘由：2026-10-02 项目 `34VR0RwUSIcaoO7ZZqv52` 的协调会话从 07:53 起每一轮都被账号限流（429）当场拒掉，runner 把这种轮次判为失败，会话停在 FAILED；09:46 一次 `LAND_TASK` 冲突开出的待办因此一出生就是 OWNER / `COORDINATOR_ENDED`，没有投给任何会话，owner 在 15:50 先重试协调会话、再按「Ask the coordinator again」才把它交回去。代价：协调会话真起不来时，owner 要等窗口走完（默认 2 小时）才收到卡，而不是立刻。`sessionHasEnded` 的其他读者（唤醒投递、§0.3 G6 的钩子、looks-finished）不变。
- **v1 修订 8**（2026-10-03）：§4.7 增 H1–H5（迁移 0368），改写修订 6 落地 J-T1b 时「重排当场把待办写成 `SUPERSEDED` / `RETRIED`」那一步。协调会话用 `integration_retry` 重排任务落地，或带 `promotionId` 重检 BLOCKED 候选（新入口：runner 门 `POST /runner/projects/:id/promotions/:promotionId/integration/retry`）时，它处理着的集成类待办不在发起那一刻关闭，而是仍 OPEN、记上 `handling_*`、读作「处理中」；由那次作业的终态收口——落地或检查通过 → `RESOLVED / HANDLED`（`resolved_by = COORDINATOR`、发起会话、理由、`resolved_by_job_id`），再失败 → `SUPERSEDED / RETRIED`，`superseded_by_item_id` 指向新开的待办。§4.1 的列表加五列，§4.2 表里三种集成类 kind 的终态一列、§4.7「重试集成」一行随之改写。缘由：2026-10-01 与 10-02，项目 `34Y7My8sqhKLWtmCQYv1l` 的晋升 `MERGE_CHECK` 两次红了，那条待办没有 taskId，协调会话无门可走，只能等时钟把它升级成 owner 待办；任务落地卡又在重排发起时就被写成已取代，「处理中」与「处理完」在记录里分不开，成功也没有统一、可审计的 HANDLED（任务 `34ZJpy6byYg8kiVbUmazX`）。取舍：（1）重检只到「候选回到可合并」为止，合并照旧由 owner 的卡或 M-T11 确认，这扇门从不合并；（2）处理中照常走 §4.6 的时钟，被升级给 owner 的待办不以协调会话的名义关闭，再失败的新待办继承 owner 的归属（H4）；（3）冲突仍不可重跑；（4）TASK_FAILED 不在此列，仍按 §4.2 的事实关闭。
- **v1 修订 9**（2026-10-03）：§4.7 增「就此对话」，§4.8 每行加 `chat`。缘由：项目 `34Y7My8sqhKLWtmCQYv1l` 的晋升卡停在「It is yours · waiting」——一个禁用按钮，旁边什么都没有：升级给 owner 的待办 `delivery.sessionId` 为空，卡上连 Open coordinator 都画不出来；异常卡也没有一处能就这条待办跟协调会话说话（原生端早有，web 没有）。做法：web 的异常卡与 BLOCKED 晋升卡加「Chat about this」，在协调会话里装填 composer，在别处打开协调会话并在到达时装填；可否、为何不可由服务端给（`chat.refusal`），卡上照写原因而不是只留一个灰按钮。取舍：（1）它不是 `actions` 的一员——那是写的门，各有归属；对话不写任何东西，所以每个阶段都给，只在无处可送或会说错对象（已取代）时拒绝；（2）重跑、合并、交回、关闭的权限一字不动，H4 下协调会话对升级待办的 `integration_retry` 照旧被拒；（3）晋升卡在没有待办时用项目文档的 `coordinatorSessionId`（任务 `34ZNP0XRLAnAreGEOvKuw`）。
- **v1 修订 10**（2026-10-06）：合入 main 的卡从协调会话挪到项目 sessions 页（§3.6、§7.5、§7.6）。项目 sessions 页进度条下面一张合入卡，检查中、等你确认、合入中、暂时合不了都在这张卡上变，按钮就是 M-F3 的三扇门；合完卡片收起，记录作为一行排进页面的时间线（按 `merged.at`），点开是回执，回执的 Now on main 按名字列出任务（读 `tasks`，原生端开始解码）。协调会话里不再画卡，每个时刻只留一行（等你时橙色，点开是同一张卡）；应用内横幅和 `approve-merge-to-main` 推送在 iOS 打开项目 sessions 页。数据与门一字未动：仍读 `promotions/current`、`promotions/merged`，确认、拒绝、取消还是那三扇门，needs-you 计数仍按协调会话归集。缘由：owner 2026-10-06 看着一张夹在对话中间的「✓ Merged into main」回执问，合入的请求和回执是不是放在项目 sessions 页更好——从会话列表点项目落在这一页，这里却看不到合入；要合入得进协调会话、找到卡、打开详情，回执又像一条消息夹在聊天里。owner 看了效果图（`docs/mocks/project-merge-sessions-page/`）后确认按建议做：卡上直接按 Merge to main（推送前都能 Cancel，不加确认框）、协调会话留一行而不是什么都不留、合完的记录进时间线而不是单开一区。取舍：（1）macOS 没有项目 sessions 页，靠协调会话那一行和项目页 Open items 的 Review 进同一个审阅 sheet；（2）项目 sessions 页上协调会话那一行仍会因合入请求显示待你处理——计数归在协调会话是服务端的事实，客户端不改写它；（3）项目页（Project）的卡与 Open items 照旧。
- **v1 修订 11**（2026-10-07）：§2.4 J-S5 开一处例外：**一次落地可以不带合并检查跑**，由 owner 在确认卡上批准（MCP `integration_skip_merge_check { projectId, taskId, reason }`；runner 门 `POST /runner/projects/:id/tasks/:taskId/integration/skip-merge-check`，owner 的用户门 `POST /projects/:id/tasks/:taskId/integration/skip-merge-check`；迁移 0393 在 `project_integration_job` 上加 `skip_merge_check`、`skip_reason`、`skip_approved_by_user_id`、`skip_approval_id` 四列；规则在 `project-integration-skip-check.ts#decideIntegrationSkipCheck`，读的事实与 J-T1b 同一把任务行锁）。被跳过的是**这一次**：作业入队时 `checksFor` 不为它构造 `MERGE_CHECK`，J-S5 的 CHECK 步骤对它不发生，任务自己的验收命令照跑；项目的 `merge_check_command` 一字不改，下一代照常跑检查，M-S3 的晋升检查与此门无关。记录里写的是「跳过了、谁批的、为什么」而不是绿：那一代的四个列就是这条记录，之后由它开的待办 payload 带同一个 `skippedCheck`。门只对「检查跑了但结果不认」的落地（`CHECK_FAILED`，含 runner 在预算处杀掉的 `CHECK_TIMED_OUT`）开放，其余拒绝：`CONFLICT` 是分支的、`ERROR` 是机器的（各按 J-T1b 的既有文案指向 `integration_retry`），在途的一代拒绝；J-T1b 的三条判据（待办归 owner、非 Automatic、非本项目的协调会话）逐条照搬，协调会话这一侧还必须带着一张 **ALLOWED** 的确认卡——卡按 (会话, 工具名, projectId, taskId) 在服务端核对，卡说的不是这块落地就拒绝，owner 自己那扇门不带卡（它就是被问的那个人），由行上的 `skip_approved_by_user_id` 记名。缘由：2026-10-07 项目 `34bZ3i4AvgJaaoaw5E9tH` 的 t1（`34bcjxtMVpkkvYUO5FsmZ` 之前的那个）落地红在合并检查上，而红的原因是本机 bash 3.2 没有 `mapfile`、也没有 GNU `timeout`——同一条命令在这台机器上必红，`integration_retry` 只会再红一次，`task_reopen` 会去怪没问题的活，而检查命令只有 owner 能改。取舍：（1）不做成 setting，也不做成「检查通过」——检查是没跑，不是通过，空 `checks` 与「项目本来就没配检查」靠这四列分开；（2）卡不走 `integration_retry` 的名字：卡按 `toolName` 渲染，同一把卡答两个问题会让「这次跳过」与「重跑一次」在记录里分不开；（3）owner 在终端自己跑时没有任何会话，「不弹卡、直写」与他按下的就是那个决定这一点一致，服务端仍记他名。
- **v1 修订 12**（2026-10-04 owner 决定，2026-10-07 定稿，2026-10-08 合入 main 时顺延为修订 12；设计见 `docs/landing-session-design.md`，§0.1 优先于 §0）：owner 决定每次集成尝试属于平台驱动的落地会话。改写 G1、G3 第 2/3 条与词汇表（落地主体在入队时打开，会话行在领取提交后插入），新增 §2.9（LS1–LS8：打开、记录与锁序、结案、决定只读不抄、隔离、拒绝 engine 路径与列表范围、无时钟、不计保险丝）；按线区分主体，PROJECT_BRANCH 合入 main 按一轮合入，MAIN 按任务段，任务重开、候选被取代不切段，并写明修复任务（0379）解决段的待办、MOVE_TASK（0389）移走任务时段怎样结案。两处选型：记录载体选只追加的 `project_integration_job_event`（作业行被 J4 守卫冻结，追加不进终态行，覆盖式的当前进度会丢历史）；判别列选 `session.kind`（直接表达驱动者，便于统一守卫；CHECK 以 `NOT VALID` 加上后单独 `VALIDATE`，免得在最热的 session 表上全表扫描并持 ACCESS EXCLUSIVE 锁），线上字段名改叫 `sessionKind`，因为 web 列表条目写 `{ ...session, kind: 'session' }`。会话行写明 `root_session_id` 为 NULL、`title_managed_by_project = true`、`dispatch_origin = USER`、`run_source = MANUAL`、`provider = 'orbit'` 且 `provider_builtin = true`（`orbit` 由实现加进 RESERVED），LANDING 会话不发 `session.created` / `session.updated`。J-T 表：J-T2/J-T3/J-T4/J-T6/J-T8 改写，本修订新增的四条排在 main 的 J-T9 之后顺延——J-T10 放弃、J-T11 排空交还、J-T12 进度驱动的取消、J-T13 合入 main 第一次推送被抢即交回（LAND_TASK 的重取轮次不变）；已请求取消的作业可被接管；J-T8 的「重开」指 `task_reopen` 门（与写 `task_reopen_intent` 同一事务），任务被写成 CANCELLED 或 FAILED 同样叫停，普通的 DONE → IN_PROGRESS 编辑不算。**推送界线**定义为「服务端在本次领取下记下过同步 PUSH 回报」，第 1 期起读作业行的 `push_reported_generation`，不看 `phase`；只能看 `phase` 的 legacy 领取以 PUSH 与 VERIFY 为已过界（今天 `applyCancel` 只排除 PUSH，VERIFY 期间的取消会把已推送的合入记成 CANCELLED）。legacy 领取（`progress_protocol` 不是 v2）检查期间按放宽的界线判 LEASE_EXPIRED，X-E5 用同一条界线，放弃一律写 `PUSH_OUTCOME_UNKNOWN`，不写 RUNNER_LOST、不说「nothing was pushed」。J12 增 `RUNNER_LOST`、`PUSH_OUTCOME_UNKNOWN`、`PUSH_REPORT_UNREACHABLE`，不需要迁移（`error_code` 没有 CHECK，闭集是 `INTEGRATION_ERROR_CODES`）。J-T4 写出进度路由的 body 与应答（round、check、step、outputIdleMs、outputBytes、cancelRequested 与停止信号）、command 的 `reportBeforePush`，以及新路由（release、abandon 的 runner 门与 owner 用户门、output、`GET /runner/projects/:id/integration`、LAND_TASK 叫停门、落地日志读口）。推送被抢的提交列表改名 `upstreamMovedCommits`（与数字型的 `recheck.upstreamMovedBy`、`project_promotion.upstream_moved_by` 区分），不放进 `errorDetail`；三种集成失败待办的 payload 另带 `landingSessionId`、`round` 与它。§4.6 增 X-E5：租约过期超过 15 分钟，同一时钟在 `reconcile`、`sweep` 之后开一条 `LANDING_LEASE_EXPIRED` 待办（OWNER / `ESCALATED`，去重 `LE:<jobId>:<claimGeneration>`，结案 `JOB_MOVED_ON`；kind 与 resolution 两个新值要迁移扩 CHECK），不挡 M-T11，并改写 X-E4 给 CIR 的文案。§4.8 的 actions 加 `OPEN_LANDING`（LOOKUP 门）与 `ABANDON`（`CANCEL` 能力、OWNER 持有），与修订 9 的 `chat` 并存，不进 `primaryActionPreference`，既有格子的 `primaryAction` 与 `requiredAction` 逐字节不变；X-E5 待办落在门矩阵的 `(LANDING_LEASE_EXPIRED, DIRECT, ERROR, OWNER)`。M-T9 补上 CONFIRMED → BLOCKED，M-T10 改为「取消中，以事实为准」：**本修订改的是 Cancel 这扇门的效果，门本身没变**（修订 10 合入卡上的 Cancel 仍是 M-F3 那扇），§3.6 由服务端给出 `cancelRequested` 与 `pushBoundaryPassed`，合入卡据此画「取消中」。在途尝试的 owner 门只在落地会话页头、合入卡与 X-E5 待办三处出现，协调会话里只留修订 10 的那一行。§2.7a 链接所属落地会话，`CANCELLING` 只对 legacy 与历史行有效；V6 主计时改为当前步骤，轮次按领取计并保留接管标记，列出读 `inFlight` 的四处落地展示位。会话列表：项目分组已上线，平铺的列表、compact、search、counts 与 `session_list`、`session_search` 默认排除 LANDING，`GET /sessions?projectId=` 只在 `includeLanding=1` 时以 LANDING 角色返回，成员关系 SQL 两处都加 LANDING 分支，会话数、running 数与状态点不计 LANDING，**不加 `landing.updated`**（取代设计里随项目分组上线的打算）。§2.1 / §3.2 的 `task_id`、`session_id` 由 FK SET NULL 改为不带外键的历史引用（对实现的要求：LAND_TASK 的 `task_id` 置空违反 `land_task_chk`，终态行的置空被守卫拒绝，「让守卫放行」不可行）。同步 `lock-order.ts`（领取语句今天对作业、源会话、workspace 三张表取 SKIP LOCKED 行锁、从不等待；作业门不等待 session 锁与 ensure 另起事务是对实现的要求，是否收窄为 `OF c` 交给 t1srv-a）、`session-list-projects-design.md`（LANDING 角色、§3.1、§3.2、§3.4、§4.2 补上 19555f614 的在途落地行）与 `schema.prisma` 的模型注释；后续落地会话迁移（编号以实施时 main 最新号为准，2026-10-07 为 0392）的头注取代 0281 的旧说法，已应用的迁移不改。**与 main 的对齐（2026-10-08，本次合入）**：main 的 J-T9（超时的 `LAND_TASK` 按 J-T1b 重试）原文保留，本修订只加两条。其一，超时（租约过期）全文只留一个定义——§7.2 V6 的 `LEASE_EXPIRED`：v2 领取超过 10 分钟没有回报即为过期，legacy 领取用 main 读时判定 `timedOut` 的那条规则作放宽的界线（git 步骤按领取租约 10 min，检查中按本作业各检查预算之和再加 10 min），本机锁上的等待不算超时；`§1.6` 的 `inFlightJobs.timedOut`、V6、X-E5 与放弃门都引这一个定义。其二，J-T9 今天一律写 `ERROR · RUNNER_LOST`（现状），本修订对实现的要求是：写哪一句按 J12 的那条唯一规则判，与放弃（J-T10）同一条——只有当前领取是 v2、且 `push_reported_generation IS NULL` 时才写 `RUNNER_LOST`，其余（被接管的上一代、legacy 领取）一律 `PUSH_OUTCOME_UNKNOWN`；下一代照常入队，接续靠既有的 `ALREADY_LANDED` 判定。两扇门并存，各自的权限与适用作业写明：重试（main，J-T9）结束当前作业并按 J-T1b 入队下一代，只适用于 `LAND_TASK`，入口是 owner 门 `POST /projects/:id/integration/jobs/:jobId/retry` 与 `integration_retry`；放弃（本修订，J-T10）只结束、不重排，`LAND_TASK`、`CHECK_PROMOTION`、`LAND_PROMOTION` 三种作业都适用，入口是 owner 的用户门与当前协调会话的 `integration_abandon`——main 写「超时的晋升作业只显示、暂不重试」留下的那处空缺由它补上。main 的 `inFlightJobs` 由此成为落地行动态行与项目 sessions 页 Landings 组共用的读口：本修订原先提的 `landings[]`（最多 3 条）由它取代，本修订给 `inFlight` 加的可选字段（jobId、landingSessionId、taskId、promotionId、runner、round、check、outputMovedAt、progressProtocol、typicalMs）同样加在 `inFlightJobs` 的每一项上。**判断点本期不接 engine**：判断仍归协调会话或 owner。凡写「要求」的条文是对实现的要求，写「现状」的描述 db69d833b 上的代码。本修订只改文档与注释，先于任何落地会话代码合入 main。缘由：**34Y7，2026-10-04**，一次 owner 确认过的 LAND_PROMOTION 持续约一小时、多次 TARGET_MOVED，页面却只有名字为空的累计检查计时，没有每轮记录或检查输出地址；会话承载可寻址的工作不等于启动 engine。10-04 的初稿（8e69d8013）用了 main 上已被「Chat about this」占用的编号，在附录 B 与 main 冲突，且有十条退回意见；2026-10-07 在 main 上重做，编号顺延为 11；2026-10-08 合入 main 时这一号已被上一行「一次落地可以不带合并检查跑」占用，本修订再顺延为 12，它新增的四条 J-T 也随之顺延为 J-T10–J-T13。不在本修订：J-S2 / M3 与 ef527a22e 的出入，§4.1、§4.7、J-T1b 对 0378–0381 的补记，门矩阵本身的条文——建议另开一条修订（不写编号，编号以合入时附录 B 的下一个空号为准）。
- **v1 修订 13**（2026-10-08 owner 决定）：协调会话接手了的例外待办不再按时钟交给 owner。§4.6 增「接手之后不升级」：项目此刻活着的协调会话回答过这条待办的投递（`answered_at` 不早于 `waiting_since`）之后，`escalatesAt` 为 NULL；时钟只兜没人接手、和接手的会话不在了（挂了、结束、被换掉、项目关了 Automatic）这两种情况。§4.4 X-D4 增第 5 条：挂在待办上的修复任务落地（写下回执的同一事务），平台把那条待办换键（`assigned_at` 改为此刻）再投给协调会话，文本前加「修复已落地」一段，由协调会话核对后 `open_item_resolve` 或 `integration_retry`；平台不替它判断原任务的工作是否随修复上了线。§4.7「交给 owner」与 H4、§2.9 任务段结案第 4 条、§4.9 的测试清单随之改写；投递文本与协调会话的开场说明改为「要 owner 拍板用 `ask_owner` 问，待办留在你这里；必须由 owner 亲手处理的事才 `open_item_hand_over`」，不再说「停着不处理超过窗口就交给 owner」。缘由：项目 `34a0e97BOc6shsNLJbIuM` 的合并检查红了（待办 `34c46hi0h8KK9096z0ZyR`，2026-10-08 00:23Z），协调会话 00:31Z 查明是 main 自己的 codex 0.161 漂移、建了挂在待办上的修复任务，修复 00:50Z 落上项目分支、01:09Z 由 Automatic 合进 main；待办却没有任何事实能关（它记的是同步任务自己那次落地，工作是跟着修复任务上的线），协调会话也没被告知修复已落地，修复会话结束两小时后（02:41Z）时钟把它交给了 owner。owner 看着那张卡说：「应该是 coordinator 修复的过程中有问题来问我，而不是发这个卡片。」取舍：（1）「接手」以回答过投递为准，而不是「做了具体的事」——协调会话的处理方式不止建修复任务和重跑（等上游修好、手工合入、问 owner），平台看不全，只能信它，卡住了它自己问；（2）时钟不删：投递一直没被回答（会话卡在前一轮）或会话挂了、结束了，它就没法问，这时仍由时钟把待办交到 owner 面前；（3）修复落地只再投、不自动关：自动关要知道原任务的提交在不在目标分支上，服务端没有 git，猜错就会悄悄丢掉一份没上线的交付。这推翻了 44038f167（2026-10-04）「只有与这条待办相关的推进才顺延窗口」对接手后情形的处理；没人接手时的计法不变。修订 12 末尾建议另开的那一号（J-S2 / M3 与 ef527a22e 的出入、0378–0381 的补记、门矩阵条文）仍未写，顺延到下一号。
- **v1 修订 14**（2026-10-09 owner 批准方案 A；设计图 `docs/mocks/coordinator-question-answered/`）：答完或撤回的协调者提问在对话里留下记录。§4.8 的读口多返回可选的 `closedQuestions`：`COORDINATOR_QUESTION` 里已回答与已撤回的，按 `resolvedAt` 新的在前，最多 50 条，每条带当时的问题（与 `question` 同形）、`answer`（选项索引或 null、文字或 null）、`resolvedAt`、第一条 ANSWER 投递的会话与时间（没有就是 null）、撤回理由与 `resolvedBy`；还开着的提问照旧只在 `needsYou`。§5.2 的 R10 改为「答复后卡片成为记录」，R12 改为「撤回后卡片不再消失，而是成为 Withdrawn 记录」。客户端（OrbitKit、web 协调会话）把记录画在 `resolvedAt` 那一刻，与判据裁决、证据、合并的回执同一条放置规则，并拿掉原来的提问卡；记录不计入 open questions 与 needs-you 计数；项目页不变。缘由：owner 2026-10-09 的截图里，对话中两张答过的卡只剩「Answered」和一行选项名，当时问了什么、有哪些选项、推荐的是哪个都看不到了——读口只返回开着的提问（`needsYou`），`settled` 组特意不收提问，iOS/macOS 的 Answered 状态只在本机内存里（重启或换设备就没了），web 答完一刷新卡片当场消失；而问题原文、选项、答复、撤回理由和投递记录一直都在服务端的行上。取舍：（1）按条数封顶不按天，理由见 §4.8；（2）不加迁移、不加索引，一个项目的提问是几十条的量级，`(project_id, state, waiting_since)` 已能把扫描限在本项目；（3）卡上只写问题开头和回答（方案 A），选项在详情里原样回放，不在卡上列（方案 B 未采纳）；（4）把协调会话收到的那条 `From Orbit · owner answer` 消息画成一行（设计图第 4 步）与提示词里「推荐项不要写进选项名」（第 5 步）不在本修订。
- **v1 修订 15**（2026-10-09，修复任务；起因是项目 `34PBlWiEZytRLTcPufJht`）：两处改动，都是把已经发生的事实记下来，而不是留给读者去猜。其一，§2.4 J-S4：REBASE 的结果就是 base 时，不推送、不 VERIFY，答 `NOTHING_TO_LAND`。此前推送是空操作，VERIFY 照样通过，于是报 LANDED 并写回执。当天这条线从 main tip 重建，一批任务的提交在 rebase 时全被当作「补丁已在上游」跳过，每一条都这样记了账。新增作业列 `source_fully_applied`（0410）与线上字段 `sourceFullyApplied`，区分两种空结果：分支带着提交、目标已全部有了（TRUE），和分支没有提交（FALSE；J-S3 的空分支同样报 FALSE）。J8 与 J-T1e 像对 `ALREADY_LANDED` 一样对待全部已应用的答案：判得太早的退回 `QUEUED`；工作结束在别的分支上的，补排那条分支、不写回执；除这条分支外没有会话报告过工作时写回执，并解决该任务的集成类待办。§1.4 只在 base 就是 upstream 时让它退出合取（`jobSawWorkOnUpstream`）；线领先 main 时任务读 `ON_INTEGRATION_LINE`。旧的读法一条都没有放宽。其二，§3.2：`project_promotion` 增 `blocked_reason`（0409），由写 `BLOCKED` 的同一条语句记下作业的答案，重新检查时清空。web 的合入卡把 `ALREADY_LANDED` 读作 nothing to merge，把 `ERROR` 读作 the merge stopped on an error — no check failed，不再从空的 `checks` / `conflicts` 推成「检查没过」；0409 之前的行照旧推断。OrbitKit 的同一张卡（`PromotionCards.blockedLine` / `blockedReason`）这次没有改，仍按旧推断。
- **v1 修订 16**（2026-10-10，修复任务 `34d07GXpcVg7MEt8duMFZ`；起因是 2026-10-09 生产事故，项目 `34bmzOkov3xN2yLPrnsCk` 合进 main 的候选 `EgpMcrpirt5G2yVGJimfS` 卡死）：三条改动，把「晋升作业超时无处可去」和「旧确认撞约束」两个洞补上。其一（a），§2.2 J-T9 与 §4.7 H1：候选重检门（`integration_retry` 带 `promotionId`）对**已超时**的 `CHECK_PROMOTION` 开放——候选 CHECKING（不只是 BLOCKED）且最新检查 RUNNING、按 §7.2 V6 已沉默超过时限时，同一事务先按 J-T9 的比较并交换把它结束为 `ERROR · RUNNER_LOST`（`claim_generation + 1`，迟到的结果被拒），再重排下一代 `CHECK_PROMOTION`；没超时的照旧 409 `INTEGRATION_RETRY_IN_FLIGHT`；`LAND_PROMOTION` 的超时不走这扇门（它答的是已确认的合入，归 J-T3 接管或 J-T10 放弃门）；owner 的用户门同一套规则，超时重排不要求归 owner 的待办。其二（b），§4.7 H1 与 §3.2 列注释：重检随候选回到 CHECKING 的那条 UPDATE 清掉上一次的确认（`confirmed_by_user_id` / `confirmed_at` 清空、`confirmed_automatically` 复位 false）。缘由：owner 13:00 按过的确认留在后来 BLOCKED 的候选上，重查通过后 Automatic 写 `confirmed_automatically = true` 撞 `project_promotion_automatic_chk`（0301），结果 500、runner 放弃、作业永留 RUNNING 占住 `#check:<project>`。重检查的是新的合入问题，旧确认回答的是旧检查；选了「在重排处清」而不是「在自动确认处让路」，因为留着旧确认对不开 Automatic 的项目同样是假话——行上写着某人某时刻确认过，而那个检查结果早已作废。不开 Automatic 的项目行为不变：检查通过照常出 owner 的卡，owner 此前按过不覆盖新的问题。其三（c），§3.3 M-T13：回执退役候选时，RUNNING 且已沉默超过时限的检查作业不再只写 `cancel_requested_at`——那会让一行作业永远占住检查串行槽（`claimOne` 不重发带取消请求的行，而死去的 runner 也永远答不出来），而是当场按 J-T9 的比较并交换结束为 `ERROR · RUNNER_LOST`；仍在回报期内的才只写 `cancel_requested_at`，由 J-T12 收口。M-T6 的 supersede 路径不动：它把检查作业直接写成 CANCELLED，作业当场终态、不占位。测试：`integration-retry.pg.spec.ts` 复现生产这一例（修复前 P2039、修复后结果被接受、候选按所选语义走到 MERGED），并覆盖超时重排（协调会话与 owner 两个入口、CHECKING 准入、未超时拒绝、迟到结果被拒）；`promotion-landed-by-receipt.pg.spec.ts` 的 (10) 覆盖被取代候选不再占位、同 serial key 的下一个检查照常可领。
- **v1 修订 17**（2026-10-10；owner 2026-10-09 批准项目 `34cjQN5ynG6eIH5A0neeu`「项目主分支」的五项，设计图 `docs/mocks/project-main-branch/`）：L6 从「upstream 不探测、默认 `refs/heads/main`」改为「upstream 默认取这个账号在同一仓库上次选的；没有才 `refs/heads/main`；平台仍不去仓库里探测」。迁移 0422 给 `project_codebase` 加 `upstream_ref_chosen_at` 与部分索引 `project_codebase_upstream_choice_idx`（§1.1、§8.1）；owner 每次写 `upstreamRef` 都记时间，`bind()` 新建的绑定先取记忆（§1.2 L3 第 2 步、L6）；开始门与协调者的开始请求都收可选 `upstreamRef`（共享类型 `ProjectStartSettings.upstreamRef`），开始门写进 `started_with`，开始请求只存建议；`GET /projects/:id/integration` 加 `repository`、`branches`、`lastMainBranch`、`upstreamChosenAt`，项目文档的 `integration` 加后两个（§1.6，项目详情读 24 → 25 条语句）。缘由：主分支不叫 main 的仓库（master、develop、trunk）每个项目都要手工改 upstream，否则任务启动就报 `BASE_REF_NOT_FOUND`。L4、L5、L5-b 不变：锁定后另一个主分支照旧 409，agent 会话写线字段照旧 403。测试：`project-main-branch.pg.spec.ts`。
- **v1 修订 18**（2026-10-12，文档任务 `34YjjEmBe0h7snFsPOG23`）：把「升级给你的异常：只交真实、有门、是决定的事」（`34YhlsSkybFDaTXbOfcxM`）已经落地的两批代码写回契约——**只改文档与新的效果图，不改行为**。其一是**为真**（判据 1）：§4.2 补「关闭边与对账兜底」一节（每条边一处写入、由移动了对象的事务提交，`openItemOwed` 是兜底、也是各读者唯一的判据、升级 tick 的 `reconcile` 再把它落成一次写，`resolution_note` 以 `backstop:` 开头；不关「工作落在别的分支」的集成待办，只记日志）；§3.2 的 `project_promotion.open_item_id` 收窄为**只指审批卡**，候选的集成失败待办由 `project_open_item.promotion_id` 找，§3.3 补「候选离开活跃状态：一条边，一个函数」的表（被取代 / refile / 被回执退役 / 拒绝 / 取消 / 合入五条出口，全部 `PROMOTION_MOVED_ON`，且候选已死时不再开失败待办）；§4.6 X-E1 重写为「一拍三步：`reconcile` → `sweep` → 推送」，`sweep` 的语句加上 `openItemOwed`，并写明 `remind_at` 的一次提醒**今天没有实现**（A-Q9 的默认做法还缺第三条语句，加也加在这一拍里）。其二是**有门**（判据 2）：§2.4 J-S2 按 T16 写全三个分支——源分支只吸过较早的 U′ 而 upstream 又前进时，把当前 U 合进**带解法的源分支**（分支 ②，写 `main_sync_sha`），而不是合进项目分支 tip；§3.1 M3 的分支 ①/② 与「两种 tip 两种走法」随之改写；§4.7 补「门能力表是这一切的唯一来源」（`open-item-doors.ts`，`KNOWN_GAPS` 为空，消息只点名这一格真能用的门、且**没有 `promotion_recheck` 这个工具**——协调者的重检就是带 `promotionId` 的 `integration_retry`）、两类冲突的解法（`task_comment` + `task_reopen` / `task_create` 一条同步任务）、`fixes_open_item_id` 的挂修复门、`open_item_hand_over` 的说明与两列发起人；H1 补第三个触发点（T15：`task_reopen` 后再 DONE 的下一代落地也把更早几代的待办记为处理中，发起人取这次 DONE 的来源）与 owner 按门那一半（`handling_user_id`），H2 按发起人署名 `COORDINATOR` / `USER`，M2 的读数豁免处理中的 MAIN_SYNC 卡（§2.7a）。其三是**是决定**（判据 3）：§4.8 的 `OpenItemRow` 按代码补 `requiredAction` / `primaryAction` / `need` / `handledBy` / `handling` / `outcome` / `handoverNote` / `facts`，并写明 `requiredAction` 的推导与「逐字节稳定」；§7.5 增「三端同一张卡」一表（会话行 `Escalated to you · <need>`、web 置顶条与原生 `N waiting below`、卡片第一行是 `requiredAction`、门由 `primaryAction` 领头且每扇带一行后果、`Review` 只在目标卡存在时出现）；§7.6 V12 补五种升级标题、V13 补 `ownerItems.need` 与「不计不欠的」。§4.9 与 §8.3 补上 T4–T9、T14–T16 各自的 spec 与普查（门表、`openItemOwed` + `scripts/project-liveness-audit.sql` 的同一段文本、处理中的发起人）；§8.6 增僵尸待办与兜底痕迹两段只读查询；`docs/completion-input-routing.md` 的时钟段按 X-E4 改写（对账与升级同属那一个 tick，仍不新增时钟、不唤醒 agent）。新增效果图 `docs/mocks/project-progress/09-owner-item-as-decision.html` / `.png`（web 与 iOS 的会话行、置顶条、卡片；英文是上线文案，中文是说明；文案取自 T10 的真实组件截图与 T11 的真机截图，代码为准）。无迁移、无行为改动；契约条文与代码不一致处以代码为准（本修订逐节对照 T4–T9、T14–T16 落地的提交与它们的任务评论）。
- **v1 修订 19**（2026-10-13，任务 `34eiKa8thtkR31jTget95`，项目 `34YhlsSkybFDaTXbOfcxM`）：让「为真」在任务失败类待办上成立，并让兜底写出它那条边会写的结局。三处行为改动，都是这个任务（T18；与它同期开工的 T17 改的是门表与协调者消息，不动这里）。其一，`openItemOwed` 新增 `TASK_FAILED` 一支：只在它的任务仍停在失败时才欠着——没 DONE、没取消、没被 successor 接替、也没有另一次尝试在飞，正是 `resolveByFact` 第一条那四个事实的反面；于是任务过去了而边漏了的那种待办不再升级、不再计入角标，`scripts/project-liveness-audit.sql` 的第二条查询逐字跟上（谓词与 SQL 两处一起改，不落在任何迁移里）。其二，`reconcile` 按 kind 写出漏掉的那条边会写的结局（任务侧三族照 `resolveByFact` 的三条 CASE，候选仍是 `PROMOTION_MOVED_ON`），`resolution_note` 仍以 `backstop:` 开头但点名事实此刻的样子——被退回返工的交付评审不再被说成「被取消」（旧文本一律 `TASK_CLOSED` 配 `was cancelled`）。其三，被 successor 接替的任务的集成类待办改记 `SUCCESSOR_FILED`（原来取消与接替两种都记 `TASK_CLOSED`），与门表 `taskRepair` 给 `task_create` 声明的结局一致；闭集 `OPEN_ITEM_RESOLUTIONS`、DB 的 CHECK、web 与 OrbitKit 的显示都不必改（两端只区分 `RETRIED`）。§4.2 的 kind 行与「关闭边与对账兜底」表及其兜底段落、§4.6 X-E1 第 1 步、§4.9 与 §8.3 的 spec 行、§8.6 与 `docs/completion-input-routing.md` 的时钟段按此改写；`open-item-owed.pg.spec.ts` 新增第 (6) 例，把每个事实摆一对同形状的 item，一条交给兜底、一条交给 `resolveByFact`，断言两边写出同一个 resolution。
- **v1 修订 20**（2026-10-13，任务 `34eiJF2CBQFZf1u3vQG2q`；同一项目 `34YhlsSkybFDaTXbOfcxM`，修的是 T12 逐节对照代码时查出来的四处代码偏差）：四处改动，每一处都让「门」这一侧只说真能用的东西。其一，**冲突格不再画会被拒的重跑门**：`decideIntegrationRetry` / `decidePromotionRetry` 对 `CONFLICT` 一律 409 `INTEGRATION_RETRY_NOT_APPLICABLE`，此前晋升冲突格仍放着一扇带 `action: 'RETRY'` 的门（`resolving: false` 却照投影 `RETRY`，卡上画一个按下去必被拒的 “Re-run the check”），任务落地冲突格里 `task_reopen` / `task_create` 也带着 `RETRY`——那个 action 的按法是集成重跑，对冲突同样被拒。现在冲突格里根本没有 `integration_retry` 这扇门、其余几扇都不带 `RETRY`；冲突卡由 `Open task session` 领头（`primaryAction`）。其二，**发给协调会话的话只点名这一格的门**：`openItemDoorMessageNames` 去掉全部字面兜底（这一格没有的门给 `null`），`landingNextStep` / `mainSyncNextStep` / `promotionNextStep` / `landedFixPreface` / `openItemBody` 的 `handling()` / `deliveryReviewMessage` 只在名字非空时写那句；连带三处措辞：任务落地不再点名 `task_start`（这一格没有它）、冲突与 MAIN_SYNC 两段不再把 `integration_retry` 写出来（只说「原样重跑会再冲突」）、交付评审里那句「不要拿去问 owner」不再点 `ask_owner` 的名（`DELIVERY_REVIEW` 格里没有这扇门；它同时补上了消息里本来就在用的 `task_comment`）。其三，**`mainSyncNextStep` 跟上 T16**：第 2 步按两种 tip 分开写（项目分支 tip 前进要再合一次；只有 upstream 前进时新的 U 会被合进带解法的源分支、合得干净就按 MERGE 落地）。其四，**MAIN_SYNC 的读数与领取一致**：T15 只给了读者一条豁免（`handling_job_id` 的作业 QUEUED/RUNNING 时不再报 `WAITING_MAIN_SYNC`），`claimOne` 没有——别的任务的落地照样领不到，读者却说「下一次心跳认领」。撤掉那条豁免（`claimOne` 的扣留保留：放开会让别的任务先落地、移动项目分支 tip，正在重落地的那条带解法的源分支随即缺了新 tip），读者报 `WAITING_MAIN_SYNC` 并点名正在重落地的那一代（`handlingGeneration`）。测试：`open-item-doors.spec.ts` 新增两条普查（任何 CONFLICT 格没有 `integration_retry` 门、也不投影 `RETRY`；每一格的协调者消息里出现的 MCP 工具名都属于这一格的门），`reopen-landing-handling.pg.spec.ts` 改成断言读者与 `claimOne` 一致（读作 `WAITING_MAIN_SYNC`、同一拍 `dispatch` 什么也不交给另一任务），`project-integration-retry.spec.ts` / `integration-retry.pg.spec.ts` / `automatic-coordinator-routing.spec.ts` / `.pg.spec.ts` 的文案钉子按新文案更新，web 的冲突卡夹具（`ProjectProgressStatus.test.tsx`、`OpenItemDeliveryCard.test.tsx`、`WorkspaceView.openItemDelivery.test.tsx` 等）去掉 `RETRY` 并按新门表断言。无迁移。
- **v1 修订 21**（2026-10-13，任务 `34euDf7QezkcTbAyiEXKd`；同一项目 `34YhlsSkybFDaTXbOfcxM`，修的是 T17 普查查出来的 `TASK_FAILED` 一格）：这张卡上的 `Retry` 此前按下去必被拒——两个客户端只按 `promotionId` 分流，任务类一律打集成重跑路由，服务器对非 DONE 的任务一律 409 `INTEGRATION_RETRY_NOT_APPLICABLE`（J-T1b，设计如此，不放宽），而门表给 OWNER 登记的门又是协调会话的 MCP `task_start`。改动三处：`taskFailureDoors` 里 owner 的门改成 owner 自己的 ROUTE `POST /tasks/:id/execute`（就是「Run now」那扇，对 FAILED 走 `clearFailedForRetry`，任务清成 IN_PROGRESS 并开出新的一次运行；协调会话仍是 MCP `task_start`），web `RetryPress` 与 OrbitKit `retryIntegration` 按行的 kind 分流（`TASK_FAILED` 行 → 把任务再跑起来；集成类任务行照旧集成重跑，晋升行照旧候选重检），卡上 Retry 下面那行后果文字按 kind 取（任务失败行说的是任务再跑一次，不再是「A new integration attempt is queued…」）。普查：`open-item-doors.spec.ts` 的 `CONTROLLER_FILES` 加上 `tasks/tasks.controller.ts`，并逐格断言投影出的每个 action 都由该格负责人持有的、名字在册的门背出（OWNER 对控制器元数据、COORDINATOR 对 `mcp.go`），`TASK_FAILED` 格的 `RETRY` 尤其钉住上面这两个地址。无迁移。
- **v1 修订 22**（2026-10-16 落地，工作 2026-10-10 完成，任务 `34dQVoIQtWgVP0Ol03o3x`；设计图 `docs/mocks/coordinator-question-answered/` 的「落地」第 4 条与 `5-landing.png` 右侧）：§5.2 R10 投递给协调会话的那条 `From Orbit · owner answer` 消息，由客户端从轮次旁的 `ownerAnswer` 卡画成一行，文本不变。卡（`OwnerAnswerCard`：`itemId`、`kind`、`sessionId`、`deliveredAt`）走 `openItemDelivery` 那套机制：`readTurnCards` 读（排队的两种视图与回显同一个函数）、`withOwnerAnswer` 在 runner 回显入库时记、runner 送来的同名字段一律丢弃，不加迁移。时间取该会话那条 ANSWER 投递行的 `created_at`（R11 轮换补投时是新会话被投递的时刻）；没有投递行、或键里的会话不是轮次所在的会话，就没有卡，客户端照旧画成消息。owner 的 Not yet… 退回收尾请求（`deliverDoneRequestDecline`，同一命名空间）一并覆盖。三端画同一句 `Sent to the coordinator · HH:mm`（沿用证据卡转交那一行的字与时间写法），点开是原文；它不当 sticky 锚点。`ownerAnswerMessage` 与 `doneRequestDeclineMessage` 的文本一字不改，修订 14 的 Answered 卡不变。缘由：owner 2026-10-10 的截图——这条给 agent 读的消息被画成 owner 自己的蓝气泡，问题重播一遍，末尾带 ISO 时间。不在本修订：第 5 步（`ask_owner` 提示词里推荐项不写进选项名）；`owner-answer:v1:` 不在 `watch-turn-key.ts` 的保留前缀里，调用方抢先用了这个键，真正的投递会在 `createTurn` 上冲突、这一代收不到答复（本修订之前就有的缺口，另立任务；卡的读法不受它影响：没有投递行就没有卡）。
- **v1 修订 23**（2026-10-19，文档任务 `34iV73jHumyU7ljc1pB2Q`；缘由：owner 2026-10-19 批准修订后的计划与 v4 效果图 `docs/mocks/landing-session/v4/`（分支 `orbit/landing-session-664b23` 的 `18c3bdd7f`），并要求这一轮先于任何落地会话代码合入 main）：把 main 走到修订 22 之后的代码现状与 owner 2026-10-19 的三项决定写回条文；只改文档与设计文档，无迁移、无行为改动。其一，**Open landing 的位置（v4 方案 A）**：§7.2 V6 的展示位由「四处」改为今天真实的六处（Work overview 的 Landing 卡、项目 sessions 页的 Landing 卡、合入卡的头、作业清单行、会话列表项目行、web 任务页 `LandTaskStatus`），main 现有的按压一律不变（两张 Landing 卡整张打开作业清单、清单行打开任务），另写明「Open landing ›」的位置（一个作业时卡底一个；多个作业时每个作业行一个，合入作业行不放；清单每一行一个），合入检查行的整行按压打开这一轮合入的落地会话（不再叫 Watch），作业不少于 2 个时由「All jobs ›」进清单，「Merged into main」仍打开回执并在底部加「Open landing ›」；删去「最多 3 条」「整行链接」「旧服务端不可点并说明原因」「LandingRow / ProjectLandingRow」这些已不在 main 上的画法，旧服务端不给 id 时按 main 的规则是没有派的按压就是只读、只有作业清单标题下写一句；三端文案的核对改为 `ProjectPageSectionsCopyParityTests`（Swift↔web）与 `ProjectCopyParityTest`（Kotlin⊆Swift）。§3.6 的 `landingSessionId` 注释与 §2.9 LS6 的入口表同步。其二，**owner 确认的合入第一次推送被抢（J-T13，选 B）**：§2.2 J-T13、J5，§3.3 M-T9 / M-T12，§3.1 M5 与附录 A Q5 对齐——第一次 `TARGET_MOVED` 只结束这一次领取，候选留在 `CONFIRMED`，同一事务入队下一代 `LAND_PROMOTION`，在新 main 上按 M5 重检并落地；新领取重置推送界线、Cancel 重新可用；同一候选连续第 3 代都以 `TARGET_MOVED` 结束才 `BLOCKED` 并开带 `upstreamMovedCommits` 的待办；Automatic 一侧照 owner 2026-10-15 的 `d321b88ee`，回 `CHECKING` 重检，第 3 次或授权撤回才 `READY` 出卡。附录 A Q5 与 M-T12 的矛盾随之消除。其三，**X-E5 保留，三种作业都开**（§4.6）：租约过期超过 15 分钟给 owner 开待办；「不挡 M-T11」一句改为 M-T11 数的是仍欠着（`openItemOwed`）、`promotion_id` 非空的集成类待办（`d321b88ee`）；结案边补上 M-T13 的退役与重检门的超时结束；卡片标题写 `Now yours — no report from the runner for <N>m`，不走 ESCALATED 的「no one acted on this for …」。**勘误**：E1 §2.6 J12 按作业种类分支（`CHECK_PROMOTION` 从不推送，一律 `RUNNER_LOST`；推送界线只适用于 `LAND_TASK` / `LAND_PROMOTION`），判定写成一个函数放在 `endTimedOutLanding`（`project-integration-job.ts:776`），引用改为 `project-integration-job.ts:72-88`，并注明结果路由不按闭集校验（`integration-job-relay.ts:1017`）；E3 §2.9 LS1 会话行补 `engine = NULL`（0414 / 0426 的 CHECK 只收已知引擎）与 `creator_id`（NOT NULL，写项目 owner），`provider = 'orbit'` 要照 0426 为 `cursor` 做的那样用迁移保留 slug（把存量三表与引用移到 `orbit-N`、再插内置守卫行与触发器），只加进 `provider-slug.ts` 的 RESERVED 不够；E4 §2.9 LS6 补上必须排除 LANDING 的种子读与材料读（`workspaces/workspace-provider.ts`:98/:108/:116、`managed-runners/managed-runner-supply.ts`:174-178、`wiki/wiki-plan-job.ts`:578-595；1c1c78d72 上为 :1008-1027），否则落地行一成为 workspace 最新会话，那里的新会话、任务运行与 @ 提及会报 `provider not available: "orbit"`；E5 §2.9 任务段结案补 M-T13（`retireCandidatesLandedByReceipt`，`8297b18a3`）：回执写下即结案，`settled_as` 按回执取 `LANDED` / `ALREADY_LANDED`，会话 `SUCCEEDED`；E7 §2.4 / J-T4 的 runner 行号改为 `integrate.go:146` / `:1149` / `:453` / `:753`；E8 §2.1 写明 J-T4 的当前检查 `{name,index,count,budgetSeconds,startedAt}` 存放在哪由实现任务 t1srv（`34a1400z5T8WzXuLEQfWM`）定，本文只要求写入与读出。**10-08 遗留**：§2.2 J-T4 的新路由段、§2.3 的结果与进度路由段与 §8.3 不再要求把 runner 门写进 `contracts/runner-write-protocol.json`（它是写协议契约、不列路由，摘要校验会拒绝已部署的 runner；47de98f3a 加 release 门时也没改），新 runner 路由登记进 `auth/tenant-isolation-runner-cases.ts` 的 `RUNNER_ISOLATION_CASES`（fb89ad992 起），删去「runner 门不在名册里」；附录 B 修订 12 的「建议另开修订 13」不再写编号。**对实现的新要求**：§2.2 J-T8、§3.3 M-T10 / M-T6 叫停一个按 V6 已超时的 RUNNING 作业时，不只写 `cancel_requested_at`，而是按 J-T9 的比较并交换当场结束为 `ERROR`（错误码按 J12，与 M-T13 的做法相同）——只写取消请求的行永不再被领取，runner 已死时会永久占住串行槽；J-T8 叫停 RUNNING 的 `LAND_TASK` 之后任务又 DONE 时，在旧一代以 CANCELLED 终了的结果事务里补排下一代（`task_reopen_intent` 保留到补排为止）；J-T10 的放弃门理由收窄为超时的 `LAND_PROMOTION`、「只结束、不重排」与 runner 永久离线三种（修订 16 之后超时的 `CHECK_PROMOTION` 已有重检门）。**设计文档** `docs/landing-session-design.md`：文首加「与契约冲突处以契约为准」；§0 第 16 条与 §0.1 第 10 条按上面的 J-T13 决定改写；§0.1 第 13 条（排空交还，47de98f3a）、第 21 条（自更新闸门，47de98f3a）与 §9 第 7、8 条（结果重发 937eef7c3、排空交还 47de98f3a）标为已由 main 实现；§3「Work overview 行」、合入卡与任务页入口按 V6 改写。与代码不一致处以合并时的 `origin/main` 为准。
- **v1 修订 24**（2026-10-19，文档任务 `34iXQVu13qxPNO96W1dU7`；缘由：协调会话 2026-10-19 复核 t1srv-a（`34bVVGb6S37cw25OkI7lN`）的实现时，发现修订 23 写进 J-T8 的一条太窄、另有一条与 J12 不一致，且 J-T8 的补排与 J-T10、§4 X 表的「只结束、不重排」/失败待办相冲突；只改条文，无代码与行为改动）：三处勘误。其一，§2.2 J-T8「叫停 RUNNING 的 `LAND_TASK` 之后任务又写成 DONE」：修订 23 只在旧一代以 `CANCELLED` 终了的结果事务里补排下一代。今天所有领取都是 legacy，runner 只在作业开头读一次 `cancelRequested`，被叫停的 RUNNING 作业几乎总是照常跑完，回报 `LANDED`、`ALREADY_LANDED`、`NOTHING_TO_LAND`、`CHECK_FAILED`、`CONFLICT`、`ERROR`，其余落在 J-T1e 的「判得太早」两条路径上、只在作业带取消请求时才被写成 `CANCELLED`——按修订 23 的写法，这些终态都不补排，任务再次 DONE 的那一代就此丢失。改为：被叫停的 `LAND_TASK` 以**任何终态**结束时（包括「判得太早」被写成 `CANCELLED` 的那两条路径），只要 `task_reopen_intent` 仍在、任务此刻是 DONE 且没有更新的一代，就在同一个结果事务里补排下一代 `LAND_TASK` 并消费这个标记；任务没有再次 DONE 时不补排；被叫停的一代不按 J-T1e 补排落后的工作，也不开失败待办。其二，§3.3 M-T10（及 §4.7「叫停在途落地」一行）：修订 23 写「已超时的当场结束为 `ERROR`……同一事务把晋升写成 `CANCELLED`」，与 J12 按作业种类分支的规则不一致——只有 `RUNNER_LOST` 才证明没有推送；写 `PUSH_OUTCOME_UNKNOWN` 时合入可能已经推送，把晋升记成 `CANCELLED` 等于声称取消了一件可能已经发生的事。改为：超时结束为 `RUNNER_LOST` 时晋升写 `CANCELLED`；结束为 `PUSH_OUTCOME_UNKNOWN` 时晋升写 `BLOCKED`（与 J-T10 放弃段同一结局）。其三，§2.2 J-T8 的补排与 §2.2 J-T10、§4.7「放弃在途作业」一行的冲突（上一版证据退回时补上）：J-T10 与 §4.7 原写「只结束、不重排」，并明说 `LAND_TASK`、`CHECK_PROMOTION`、`LAND_PROMOTION` 三种作业都适用；§4 X 表的 `INTEGRATION_ERROR` 也把放弃写的 `ERROR` 列为开待办的来源。被叫停的 `LAND_TASK` 若走这条结局——任务 reopen 时它正在跑，写了 `cancel_requested_at` 与 `task_reopen_intent`，任务又 DONE 时答 `ALREADY_QUEUED`、标记保留，随后 runner 死掉、租约过期，owner 或协调会话按了 Abandon——照字面，这次 DONE 的成果永不排队、也没有待办提醒。改为：J-T8 的补排点名写下终态的各扇门（runner 的结果，含 J-T1e 的两条路径与 J-T12；J-T9 的超时结束；J-T10 的放弃），在写下该终态的同一事务里补排；被叫停的一代不开任何失败待办，作为 J-T7、J-T10 与 §4 X 表 `INTEGRATION_ERROR` 的例外（放弃写的 `ERROR` 同样不开）；J-T10 的「只结束、不重排」收窄为不重试被放弃的那一代，不挡这次补排——补排的是那次再次 DONE 被推迟的入队，不是对被放弃一代的重试；J-T9 自己按 J-T1b 入队下一代时，「没有更新的一代」这一条件保证不重复补排。
- **v1 修订 25**（2026-10-20，文档任务 `34jBwFauwwQeTcOyXpV0q`；缘由：落地会话项目 `34a0e97BOc6shsNLJbIuM` 完成后，它的协调会话复核时发现下面四处；第四处里 M 的含义是 owner 2026-10-20 的决定；只改条文，无代码与行为改动）：四处勘误。其一，§2.2 J-T8「放弃写的 `ERROR` 同样不开待办」限定为只适用于**被叫停的那一代**（作业带 `cancel_requested_at`）：没被叫停的作业被放弃时（J-T10、§4.7）照 J-T10 与 §4 X 表开 `INTEGRATION_ERROR`；J-T10 行、§4.7「放弃在途作业」一行与 X 表 `INTEGRATION_ERROR` 行写明同一条规则。代码已经这样实现：`integration-job-relay.ts` 的结果事务（放弃门共用它）只在 `!cancelRequested` 时开失败待办。其二，J-T4 的 `IntegrationJobProgressRequest` 补上只在 PUSH 回报里带的 `testedSha`、`testedTreeSha`、`sourceSha`、`targetShaBefore`（都可选，值是完整 sha；shared `dto.ts` 与 runner-go `types.go` 同名同形）：runner 只在 v2 领取的 PUSH 前同步回报里填，服务端只在 `phase = PUSH` 时读；这次回报划下推送界线，四项写进作业行同名列，供 J12 修复时查证推送并补写回执（今天的写法与它的缺口见下面的「现状与待修」）。其三，J12 修复（§2.6）补写回执的那条路径：被追回的 `LAND_PROMOTION` 的候选保持它此刻的状态（`BLOCKED` 或 `CANCELLED`），不改成 `MERGED`——修复只写回执、不改写候选行；按规则 `PUSH_OUTCOME_UNKNOWN` 留下的是 `BLOCKED`，`CANCELLED` 只来自重检后重新确认、下一代又被 owner 的 Cancel 叫回的候选（M-T10）；候选里的任务经补写的 M9 回执（`detail.recoveredUnknownPush`）读作已落地（`project-promotion.service.ts#recoverPromotionPushReceipts`）；M9 加一句指向它，并改正它的 `detail`（`fromIntegrationJob` 写的是 `source`、`integrationJobId` 与几项树和确认事实，没有 `promotionId`）。其四，§7.2 V6 写明 `round N of M` 的 **M 是该种作业一次领取最多能跑的轮数，不是检查条数**：`LAND_TASK` 最多 3 轮（J5、附录 A-Q5），写 `round N of 3`；`LAND_PROMOTION`（J-T13）与 `CHECK_PROMOTION` 只有 1 轮，只写 `round N`，不写 of。§2.9 的时间线、§4.2 X-E5 那一行（payload 列全代码写的字段与可空性，并写明 `checkCount` 不是 M）与 J-T4 接口块里 `round` 的注释改成同一说法；J-T13、J5 与 M-T12 里「`LAND_PROMOTION` 也走 2 轮重取」的现状句已经过时（e94080db6 起 `promotionRefetchRounds = 0`），一并改成已实现。三端今天在 `of` 后写的是当前检查的条数，改由三端的落地会话收尾任务（`34jBwFmcEPK012TsNL0Lc`）做。现状与待修（规则不变，只记下代码今天与条文不一致的地方）：(a) 待在代码里修：`applyPromotionJobResult` 带取消请求的那一支把被叫停的领取的每一种非 `LANDED` 结果都结算成候选 `CANCELLED`，其中不能证明没有推送的——J-T10 放弃写的 `PUSH_OUTCOME_UNKNOWN`、legacy 领取推送之后报的 `VERIFY` 错误——按 §2.6 与 M-T10 应为 `BLOCKED`（§2.6 J12 段的现状注，M-T10 指向它）；§2.6 同时写明没有推送就结束的那些结果写 `CANCELLED`，M-T10 的「结果为 CANCELLED 才」随之写成「结果证明没有推送才」；(b) 四个 PUSH 事实列用 COALESCE 写、领取不清空，J12 只能查证作业第一次被接受的 PUSH 回报：`LAND_TASK` 第 2、3 轮或接管后的推送结果未知时，修复会漏掉，但不会写出假回执（J-T4 接口块里的现状注）。(c) 待定：Not now 的 `applyDecline` 也收 `BLOCKED`，M-T5 只列 `READY`，补进 M-T5 还是收窄代码未定（§2.6 J12 段注明这是现状）。另外，M-T8 与 M-T10 里修订 11 留下的两句现状（`applyCancel` 当场写 CANCELLED、界线只排除 `PUSH`）已不符合代码，改记为已修正。
- **v1 修订 26**（2026-10-21，任务 `34jBwFldsZVGXcU3hPS6A`；只改现状注，规则不变）：修订 25「现状与待修」的 (a) 已在代码里修正（`ef3f9c705`）。`applyPromotionJobResult` 带取消请求的那一支里，被叫停的 `LAND_PROMOTION` 以不能证明没有推送的结果结束时，候选写 `BLOCKED`（`blockPromotion`）。这种结果是 J-T10 放弃写的 `PUSH_OUTCOME_UNKNOWN`，和 legacy 领取推送之后在 `VERIFY` 报的 `ERROR`。能证明没有推送的结果仍写 `CANCELLED`，被叫停的一代照 J-T8 不开失败待办。`integration-job-cancel.pg.spec.ts` (16)–(19) 与 `integration-abandon.pg.spec.ts` (11)–(12) 钉住两种结局。§2.6 J12 段的现状注与 M-T10 指向它的那句改记为已修正。
- **v1 修订 27**（2026-10-25，任务 `34iSqQcZj6PLO4nk77pMf`；缘由：2026-10-19 生产事故，见 §2.3 J-T3a 的「缘由」）：新增 §2.3 J-T3a。过期的领取若仍由正在心跳的同一进程持有，且是 v2 领取或领取后从未回报，心跳在领取新作业之前把它原样重投给那个进程：同一 `claimGeneration` 与 `leaseOwner`，command 与领取时同列、同步骤（`integration-job-relay.ts` 的 `silentClaimsOf`、`handOut`、`HELD_CLAIM_COLUMNS`）；不写作业行，不记事件，不占每拍 2 条的新领取。J-T3 那一行、G3 第 2 条、§7.2 V6 与 X-E5 各加一句指向它；`claimOne`、`dispatchIntegrationJobs`、控制器与 shared `HeartbeatResponse.integrationJobs` 的注释照改。控制器原来写的是「失败只少这一拍的作业，下一拍会从队列里重新领取」，这对本拍已经提交的领取从来不成立。三处选型：(a) 不换代，因为 runner 只按 job id 去重，换代会让真在跑的作业跳过新 command、下一次回报被 `STALE_CLAIM` 拒绝；(b) 不续租，让 V6、X-E5 与放弃门照旧看到沉默，runner 一直不接时 owner 照常收到 X-E5 待办；(c) legacy 领取只重投从未回报的那种，因为 legacy runner 不读应答、推送前不问，与长步骤结束赛跑的一次重投可能推送第二遍；回报过的 legacy 领取仍由 X-E5、放弃门或下一个进程的接管收口。只改服务端，不需要迁移：runner 本来就按 job id 去重（0.1.232 已是如此），收到自己已持有、没在跑的那条 command 就开始跑，所以不必发 runner。另一种做法是让 runner 在心跳里声明在跑哪些 job id、服务端据此判定：更快，也不靠租约，但要发 runner（须 owner 批准），老 runner 又不会声明，服务端仍要有本条这条路径，所以没选。正常的领取（J-T2、J-T3）语句与行为不变，只把 RETURNING 的列表挪进与重投共用的 `HELD_CLAIM_COLUMNS`。生产现场已在 10-19 由重启解开（任务评论 `34itQ2WHMwQCSWQpF5XKM`），本修订不动生产库。测试：`integration-job-lost-claim.pg.spec.ts` 复现 10-19 的情形（修复前红、修复后绿），并钉住按时回报、租约之内、本机锁上排队、回报过的 legacy 领取这几种都不重投，以及重投带着叫停请求、工作目录已不在时按 unworkable 结束。
- **v1 修订 28**（2026-10-27 owner 决定，文档任务 `34nGbUrpAHgkEhiSzeg2D`；效果图 `docs/mocks/landings-one-window/`，分支 `orbit/landing-e0346e` 的 `3c6c34f47`）：**一个项目的落地合到一个 Landings 窗口里看，Merged into main 也合进来**。缘由：owner 2026-10-27「这个 landing 有好多个，是否可以合并到一个会话窗口里」，随后补「和 Merged into main 也合并到一个会话里」；看过效果图后定了图上的两条待定：方案 A（只合窗口），结了的落地在窗口里全部保留。改动：§2.9 LS6 的列表范围——项目 sessions 页只有一行 Landings，整行打开这个项目的 Landings 窗口；窗口列出该项目的全部落地会话，没结的在最下面，结了的按天分组、全部保留、不折叠；一个落地会话 id 打开它所属项目的窗口并定位到那一条（滚到、展开、高亮）。LS6 的入口表加「项目 sessions 页的 Landings 行」（整行进窗口、停在最底），合入卡的头与各处「Open landing ›」改为进窗口并定位到这一次，「Merged into main」行挪进窗口、整行在原地展开这一轮（回执、检查、推送），协调会话里那一行回执照旧、回执底部的「Open landing ›」进窗口；表下一句的 Landings 组改为 Landings 窗口，并新加一段：新客户端上的「落地会话页」就是窗口里定位到的这一次，原来页头的门挂在这一次的卡上。§3.6 `promotions/merged` 的记录从项目 sessions 页的时间线挪进窗口，与这一轮的落地会话按 `landingSessionId` 合成一条，没有 id 的合入（落地会话上线之前）只展开回执；协调会话里那一行不动。§1.6 `inFlightJobs` 一行与 §7.2 V6 里读它的 Landings 组改为 Landings 窗口；V6 第 3 处的按压、BLOCKED 时的入口与「Merged into main」行同步；§7.5 的 C 改为窗口里的一行。**取代**：owner 2026-10-19 批准 v4 时定下的 24 小时窗口与 Earlier 折叠——Landings 组只列等决定的与 24 小时内结案的，更早的折成 `Earlier · N landed · N nothing to land`，也不收已合入的合入轮（v4 待定第 3、4 条，`docs/session-list-projects-design.md` §3.2）；修订 10（2026-10-06）把合完的记录作为一行排进项目 sessions 页时间线的那一半（合入卡、协调会话里那一行与回执不变）；修订 23 写的「Merged into main」行整行打开回执，在窗口里改为原地展开。**服务端不变**：一次落地仍是一条记录（一个任务段一个，一轮合入一个），§2.9 的数据、`landingSessionId`、`GET /sessions/:id` 与 `session_get`、agent 读口、`GET /sessions?projectId=&includeLanding=1` 与 `promotions/merged`（上限 20 条）都不动，不加接口、不加迁移；只改客户端的展示与入口，旧客户端照旧。没选方案 B（一个项目只有一个落地会话）：看到的一样，却要加迁移、改 §2.9 LS1–LS3 与 LS6、改服务端与 agent 工具。设计文档 `docs/landing-session-design.md` §3、§8 与 `docs/session-list-projects-design.md` 同步。三端实现另是一个任务（`34nGbUykKeP4geymwZYB8`）；效果图只画了 iPhone，web 与 Android 用同一个结构。
- **v1 修订 29**（2026-10-28 owner 裁决，文档任务 `34npBHVMjX6sYl1lZVfZb`；设计图 `docs/mocks/landing-observation/`）：新增 §10「落地观测与交付方式」。缘由：2026-10-28 生产上一个 `MAIN` 线、agent 直推 `feature/v1.1.1` 的外部项目，8 条候选全部 BLOCKED（7 条 `SOURCE_BRANCH_MISSING`，1 条 `ALREADY_LANDED` 也记成 BLOCKED），全项目只有 1 张回执，下游被 J9 挡了一整天，而代码早已在线上。同一形状 10-09 出现过一次（M-T13、迁移 0411），PR #146 是第三个补丁，owner 判定它的跳过不合理。五条根因（§10.2）对应五条原则（§10.3 O1–O5）：交付身份是 DONE 时冻结的提交；落地是只读观测作业 `OBSERVE_LANDING` 看出来的事实，看到就写回执；事实与授权分开，没走确认就进了 main 另开 owner 待办 `LANDED_WITHOUT_CONFIRMATION`；交付方式由 owner 在集成设置里声明（`PLATFORM` / `AGENT_PUSH`，后者是 M7 的第二种常设授权）；等待必须有生产者：`LANDING_UNOBSERVED` 先归协调会话、不能按 `HANDLED` 关，任务落地类集成待办在条件仍在时也不能空关（O-X1）。不加时钟（G3），不加 blocker kind 与唤醒事件（G5）。不采纳 PR #146 的跳过路径（§10.11）。本修订只改文档。**裁决**：owner 2026-10-28 裁决按 §10 实现，附录 A 的 Q21–Q25 一律按默认做法；实现项目 `34noHniU4wmCRkZJkR6df`。随后按 §10.10 改写正文（§0.4「落地」、§0.6、§0.7、§1.1、§1.4、§2.1–§2.3、§2.5 J8 与 J9、§2.6 J12、§3.2、§3.3 M-T3 与 M7、§3.4 M-F2 与 M-S1、§4.2、§4.7、§7.3），改写处标「修订 29」并指回 §10；§10 保留为正式一节，条款号不变。实现时补（R29-4，任务 `34npBHcNpMt7linqWxsO1`）：`LANDED_WITHOUT_CONFIRMATION` 同样被 `open_item_resolve` 拒绝（`OPEN_ITEM_HAS_ITS_OWN_DOOR`，§4.2 那一行的结局本来就没有 `HANDLED`），也被「让协调会话再看一次」拒绝（`OPEN_ITEM_NOT_RETURNABLE`，它从不投递协调会话）；Accept 门对 acting session 答 403 `OPEN_ITEM_OWNER_ONLY`、对别的 kind 答 409 `OPEN_ITEM_HAS_ITS_OWN_DOOR`，门表把它投影成 action `ACCEPT`（§4.7、§10.8）。
