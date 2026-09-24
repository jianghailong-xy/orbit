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

**G1**：不存在「平台通知协调会话去执行一个结果确定的步骤」的设计。一件待办的负责人是会话，当且仅当处理它需要判断。

### 0.2 触发点

**G2（只认已提交事实）**：每个状态转移都写明触发它的已提交事实：哪张表的哪一行在哪个事务里写入或改变。平台动作只有两种形状：与该事实**同一事务**写下（outbox），或在该事务提交之后的边沿上**从已提交行重新推导**（`CompletionInputRouter` 各 door 的形状）。只在提交后边沿执行的动作，必须另有一个事实驱动的补偿点（本文逐处写明），因为进程可能死在提交与边沿之间。

**G3（时钟只有三种用途）**：

1. **对人的超时升级**（§4.6）：本文唯一新增的「时间 → 状态」转移。只写 owner 可见的状态、只发 owner 推送，不产生 agent 唤醒、会话轮次或会话。
2. **已提交事实的认领与重投**：runner 心跳（`runloop.go` 30 秒一拍）领取已入队的集成作业（§2.2），作业租约过期后可被重新认领。它们是 `coordinator-wake.ts` §0 允许的「lease and re-deliver an already committed fact」，产生机器工作，不产生 agent 轮次。
3. **显示**：读模型计算「已等多久」「多久后升级」，不写任何行。

本文涉及的路径上不新增其他 `setInterval`、定时 sweep 或「超过 N 分钟就……」。已存在的 `TasksService` 60 秒 sweep（`reconcileReadyTasks`）照旧，本文只改它读的依赖谓词（§2.5 J9），不给它加职责。**不给 agent 加任何定时唤醒。**

**G4（投递不计费）**：外部事实（任务状态变化、合并回执、证据修订、owner 答复、例外待办）的记账与投递，不经过任何按次数计费的授权器（§6.6）。

**G5（不加唤醒事件、不加 blocker kind）**：新机制放在新表里。`COORDINATOR_WAKE_EVENTS` 与 `project_blocker_kind_chk` 两个闭集不增加成员：前者每加一个事件要改 8–10 处，而且正是本项目要替换的旧通道；后者被 `project-source-contract.spec.ts`（SR50/SR51）按设计拒绝任何新增。前者有两处例外：`DEPENDENT_READY`（附录 B 修订 3）与 `PROJECT_SETTLED_UNMERGED`（附录 B 修订 4）。

### 0.3 平台发给会话的消息（G6、G7）

**G6（唯一载体）**：平台写进任何会话的消息都走 `SessionsService.createTurn(ownerId, sessionId, { clientTurnId, content, intent: 'NEXT_TURN' }, { participateSendTransaction })`：

- `clientTurnId` 是事实的全函数，前缀属于下表的闭集；`content` 只由不可变的行派生（重放时逐字节比较，见 `createTurn` 的幂等分支）。
- 外部账本（投递行、回复行）的 ACK 在 `participateSendTransaction` 里与轮次同一事务写下；会话已结束（`completed_at` 非空、`INTERRUPTED` 且有 `end_reason`、终态、在 Trash、已请求取消）时在钩子里抛错，轮次不写。
- 不走 `SessionsService.resume`：不复活已结束的会话，也不 steer 正在跑的轮次。
- 排队的平台轮次会被四处排空点丢掉（`turnComplete` 的 failSession 排空、`/finalize`、`ReaperService.forceFinalize`、`SessionsService.transitionEnd`），打断与撤回会整行删除。平台轮次在这些点先被「退回」（§4.4 X-D5），与 `watch-wake-drain.ts` 的 `deadLetterQueuedWatchWakes` 同一形状。

| `clientTurnId` 前缀 | 发给谁 | 定义在 |
|---|---|---|
| `open-item:v1:<itemId>:<assignedAtMs>` | 当前协调会话 | §4.4 |
| `owner-answer:v1:<itemId>:<sessionId>` | 当前协调会话 | §5.2 |
| `criteria-decision:v1:<intentId>` | 提案会话 | §5.1 |

**G7（轮次来源）**：`conversation_turn` 没有来源列。保险丝（§6.1，以保险丝计数任务的定义为准）用「这一轮有没有 `conversation_turn`」来区分：Orbit 投递的轮次都有一行，runner 把该轮的事件记在它名下；engine 自己起的轮次没有，它的 `run_event.type = 'turn_end'` 不挂 `turn_id`。

| 来源 | 判据 | 类别 |
|---|---|---|
| owner 消息、另一会话的 `session_send`、auto-retry 重发 | 有 `conversation_turn`，`clientTurnId` 随机或由客户端给出 | 外部 |
| 平台投递 | 有 `conversation_turn`，`clientTurnId` 为上表前缀、`coordinator-wake-delivery:v1:` 派生 uuid、`task-comment-mention:`、`system:task-acceptance:v1:` 或 `initial-<sessionId>` | 外部 |
| Watch 投递（匹配与到期）、会话定时唤醒 | 有 `conversation_turn`，`watch:<id>:…` 或定时唤醒的前缀 | 外部（已知边界：agent 自己约定的定时唤醒不计入自发，见附录 A-Q11） |
| engine 自己起的轮次（后台任务通知、ScheduleWakeup、Monitor） | 没有 `conversation_turn`；`run_event.type = 'turn_end'` 且 `turn_id IS NULL` | 自发 |

### 0.4 词汇表

| 术语 | 定义 | 不是什么 |
|---|---|---|
| **集成线** | 代码项目的任务完成后由平台自动落地的 ref：`project_codebase.integration_ref`。两种：`MAIN`（等于 `upstream_ref`）与 `PROJECT_BRANCH`（`refs/heads/project/<name>`） | 不是 `workspace.defaultMergeTarget`（PSC SR2） |
| **upstream / main** | `project_codebase.upstream_ref`。本文说「main」都指它 | 不是 runner 自动探测的分支（L6） |
| **代码任务** | 满足 `isCodeTask`（§1.1）的任务，只由已提交行判定 | 不由标题或描述推断 |
| **集成作业** | `project_integration_job` 的一行：平台在 runner 上执行的一次「把某个源放进某个目标」 | 不是会话，不启动 engine |
| **落地** | 任务有一条 `result ∈ {MERGED, ALREADY_MERGED}`、目标分支属于某条线的回执。分两级：在集成线上、在 main 上（§1.4） | 不是 DONE（DONE 只说验收通过） |
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

每节一个前缀：G 总则、L 集成线、J 集成作业、M 合入 main、X 例外待办、R 回复、F 保险丝、B blocker、V 读模型、C 兼容。

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

迁移 0270 新增触发器 `project_codebase_integration_lock`（BEFORE UPDATE）：`OLD.integration_started_at IS NOT NULL` 时，拒绝改动 `integration_ref`、`upstream_ref`、`canonical_repo_url`、`ref_authority`、`remote_name`、`authority_runner_id`，也拒绝把 `integration_started_at` 改回 NULL；错误信息以 `INTEGRATION_LINE_LOCKED` 开头。沿用 0231 的约束：ref 必须是 `refs/` 全名（SR9）；不得新增 `work_dir` / `workspace_id` / `default_merge_target` / `enable_worktree`（SR10，`project-codebase-schema.pg.spec.ts` 断言它们缺席）。

派生值（不存列）：

- `IntegrationLine` = `integration_ref = upstream_ref` ? `MAIN` : `PROJECT_BRANCH`。
- 分支短名 = 全名去掉 `refs/heads/`，与 `session_merge_receipt.target_branch` 的写法一致（runner 回报短名）。

**`isCodeTask(task)`**：`task.project_id` 非空 ∧ `task.codeless = false` ∧ 该任务最近一条工作会话（`starts_task_work = true`、`deleted_at IS NULL`、按 `created_at` 取最新）的 `isolation_status = 'worktree'` 且 `branch` 非空。

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
   - `upstream_ref = 'refs/heads/main'`（L6）。
   - `integration_ref`：`MAIN` → 等于 `upstream_ref`；`PROJECT_BRANCH` → `refs/heads/project/<projectPublicId>`（附录 A-Q1）。
   - `ref_authority = 'REMOTE'`，`remote_name = 'origin'`（附录 A-Q2）。
   - `integration_ref_source = 'DEFAULT_RULE'`。
3. `UPDATE … SET integration_started_at = now() WHERE integration_started_at IS NULL`。已有 `EXPLICIT` 行时只做这一步。
4. 线从这一刻开始：同一事务为本项目**其他**已 DONE、`isCodeTask` 为真、在**新线上且在该线的 `upstream_ref` 上**都没有落地证据的任务补入队 `LAND_TASK`（§2.3 J-T1d），否则它们的下游会永远等在 J9 上。上游那一半是 `PROJECT_BRANCH` 的定义使然：J-S2 MAIN_SYNC 会把上游并进目标分支，所以上游已有的内容按定义就在项目分支上，再为它排一次落地只会撞成冲突（本平台自己的合入是 rebase，J-S3 的祖先判定看不见它）。

**L4（锁定）**：`integration_started_at` 非空之后，`integration_ref` 与 `upstream_ref` 不可改。服务层拒绝 409 `INTEGRATION_LINE_LOCKED`，数据库触发器兜底。`merge_check_command`、`merge_check_timeout_seconds`、`project.exception_escalation_seconds` 不锁。要换线，先合入 main 或放弃当前项目分支（owner 决定 5）；v1 不提供解锁入口（附录 A-Q3）。

**L5（显式设置的写入门）**：`GET / PATCH /projects/:id/integration`。PATCH 只接受 owner 凭据；带 acting session 的请求（任何 agent 会话，包括协调会话）拒绝 403 `INTEGRATION_SETTINGS_OWNER_ONLY`。

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

没有代码库行时创建：`canonical_repo_url` 取项目协调工作区的 `repo_url`，缺失则 409 `INTEGRATION_REPOSITORY_UNKNOWN`。写 `project.exception_escalation_seconds` 的方法里不得出现 `status:` 键（`project-status-write-sites.spec.ts` 按「同一方法内有 `.project.update` 且有 `status:`」认写入方）。

**L6（upstream 不探测）**：apiserver 没有仓库可问。`upstream_ref` 默认 `refs/heads/main`，owner 可在锁定前改。runner 在作业里发现它不存在时，作业以 `ERROR / BASE_REF_NOT_FOUND` 结束并生成待办（§2.6），**不回退到 master**：产品与仓库无关（owner 决定 3），猜分支名就是在为仓库约定做特判。

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

- 任务级：有一条 `result ∈ {MERGED, ALREADY_MERGED}` 且 `target_branch ∈ upstream` 的回执 → `ON_UPSTREAM`；否则有同样结果且 `target_branch ∈ integration` 的回执 → `ON_INTEGRATION_LINE`；其余 → `NOT_KNOWN`。仍然没有 `NOT_LANDED`，沿用该文件「三值」一节的理由。
- 判据级：服务任务非空且所有**有提交可落**的服务任务全部 `ON_UPSTREAM` → `LANDED`；服务任务非空、所有有提交可落的服务任务都是 `ON_UPSTREAM` 或 `ON_INTEGRATION_LINE`、且至少一个不是 `ON_UPSTREAM` → `ON_INTEGRATION_LINE`；其余 → `UNKNOWN`。`MAIN` 线项目不会出现 `ON_INTEGRATION_LINE`。
- 「有提交可落」= `task.codeless = false`（§1.1 `isCodeTask` 的前半）。一条声明自己不需要代码的任务（SR5 的逃生口：调研、文档、以证据为交付的验收任务）不解析 SOURCE，因此没有自己的分支、没有自己的提交，也不可能有任何回执把它的工作放到 `main` 上——它不参与这条合取，既不挡 `LANDED` 也不提供 `LANDED`。这与 §2.5 J9 对依赖的豁免是同一条规则（SR27：文档类前置不该让下游等一个永远不会存在的检查点），也让 `ProjectIntegrationBuckets.doneNotIntegrated`（「DONE work with nothing to land」）与 `NOT_APPLICABLE` 的口径在判据这一层成立。**注意这不是给验收类任务开绕过落地判定的口子**：跑过分支的任务就是有自己的提交（无论它的回执或标题怎么说），仍然按原样顶住 `LANDED`；只读声明，不读会话史（`isCodeTask` 的后半读的是**最新**一条会话，而回执挂在**任务**上，用它会漏掉「上一次落地、这一次没分叉」的任务）。
- 只有 codeless 的服务任务、但确实有服务任务时，判据读 `LANDED`（零个提交全部在 upstream 上，即 J9 的「没有可等的」）；**没有人**服务时仍读 `UNKNOWN`。
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
| `source` | `'EXPLICIT' \| 'DEFAULT_RULE'` | `integration_ref_source` | `NOT_DECIDED` |
| `locked` / `startedAt` | bool / Date | `integration_started_at` | — |
| `mergeCheckCommand` / `mergeCheckTimeoutSeconds` | string / number | 代码库行 | `NOT_CONFIGURED` |
| `escalationSeconds` | number | `project.exception_escalation_seconds` | — |
| `commitsAheadOfUpstream` | number | 最近一条终态 `LAND_TASK` 的 `ahead_of_upstream` | `NO_LANDING_YET` |
| `lastUpstreamSyncAt` | Date | 最近一条 `main_sync_sha` 非空的 `LANDED` 作业的 `finished_at` | `NEVER_SYNCED` |
| `integratingCount` / `queuedCount` | number | 本项目 `RUNNING` / `QUEUED` 作业数 | — |
| `mergeCheckOnTip` | `'PASSING' \| 'FAILING' \| 'UNKNOWN'` | 最近一条终态 `LAND_TASK`：`LANDED` / `ALREADY_LANDED` → PASSING；`CHECK_FAILED` → FAILING；其余（含 `NOTHING_TO_LAND`——没有可检的树）→ UNKNOWN | — |

项目列表行带 `integration: { line, ref } | null`（§7.1）。

### 1.7 测试

`src/apiserver/src/projects/project-integration-ref.pg.spec.ts`（判据 4）：

1. `explicit integration settings read back`
2. `with no explicit choice, dependent code tasks record a project branch at the first integration`
3. `with no explicit choice, a single code task records main at the first integration`
4. `switching the line after integration started is refused INTEGRATION_LINE_LOCKED`（服务层与触发器各断言一次）
5. `a receipt into the project branch makes its serving task landed`（改动前在 main 上跑红：`DEFAULT_BRANCH_NAMES` 读成 UNKNOWN）
6. `platform-initiated merges leave workspace.defaultMergeTarget unchanged`

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
| `kind` | text | CHECK ∈ {`LAND_TASK`, `CHECK_PROMOTION`, `LAND_PROMOTION`} |
| `generation` | int NOT NULL | `LAND_TASK`：同一任务的第几条（在任务行锁下取 max+1）；另两种：同一晋升的第几条 |
| `task_id` | uuid NULL | FK `task` SET NULL；`LAND_TASK` 与 `TASK_BRANCH` 晋升必填 |
| `session_id` | uuid NULL | FK `session` SET NULL；源分支所在的工作会话 |
| `promotion_id` | uuid NULL | FK `project_promotion`（0273 补外键） |
| `serial_key` | text NOT NULL | 串行键，见 J1 |
| `target_ref` / `upstream_ref` / `source_ref` | text NOT NULL | 全名；`upstream_ref` 入队时从代码库行冻结 |
| `state` | text | CHECK ∈ {`QUEUED`, `RUNNING`, `LANDED`, `ALREADY_LANDED`, `NOTHING_TO_LAND`, `READY`, `CONFLICT`, `CHECK_FAILED`, `ERROR`, `CANCELLED`, `SUPERSEDED`} |
| `phase` | text NULL | CHECK ∈ {`FETCH`, `MAIN_SYNC`, `REBASE`, `MERGE`, `CHECK`, `VERIFY`, `PUSH`}：进行到或停在哪一步 |
| `runner_id` | uuid NULL | 入队时 = 源会话的 `assigned_runner_id`；认领时写实际认领者 |
| `claim_lease_owner` / `claim_generation` / `claimed_at` / `heartbeat_at` | text / bigint DEFAULT 0 / timestamptz / timestamptz | 租约，形状照抄 `CodexRateLimitResetOperation` |
| `cancel_requested_at` | timestamptz NULL | runner 在阶段边界检查，`PUSH` 之后不再理会 |
| `source_sha` / `target_sha_before` / `upstream_sha` | char(40) NULL | 本次作业冻结的三个 tip |
| `main_sync_sha` | char(40) NULL | 吸收 upstream 的 merge 提交（M1） |
| `tested_sha` / `tested_tree_sha` | char(40) NULL | 在其上跑检查的提交与它的树 |
| `landed_sha` / `landed_tree_sha` | char(40) NULL | 推送后目标 tip 与它的树 |
| `ahead_of_upstream` | int NULL | `git rev-list --count <upstream>..<landed>` |
| `checks` | jsonb NOT NULL DEFAULT `'[]'` | `[{ name: 'TASK_ACCEPTANCE' \| 'MERGE_CHECK', command, expectedExitCode, exitCode: number \| null, timedOut, durationMs, outputTail }]`，`outputTail` ≤ 16 KB |
| `conflicts` | text[] NOT NULL DEFAULT `'{}'` | |
| `error_code` / `error_detail` | text / jsonb NULL | 闭集见 J12 |
| `receipt_ids` | uuid[] NOT NULL DEFAULT `'{}'` | 本作业写下的回执 |
| `confirmed_automatically` | boolean NOT NULL DEFAULT false | 迁移 0301。只有 `LAND_PROMOTION` 可为真（CHECK）：这次落地由项目的 Automatic 授权确认，不是 owner 按的（§3.3 M-T11）；runner 收到的命令带 `automatic: true`，只落到 `upstream_sha_checked` 上（M-T12） |
| `idempotency_key` | text NOT NULL UNIQUE | `ij:v1:<kind>:<taskId 或 promotionId>:<generation>` |
| `created_at` / `started_at` / `finished_at` / `updated_at` | timestamptz | |

约束与触发器：

- **J1（串行）**：`serial_key = canonical_repo_url || '#' || target_ref`；`CHECK_PROMOTION` 不写 ref，用 `canonical_repo_url || '#check:' || project_id`，不占 main 的串行位。部分唯一索引 `(serial_key) WHERE state = 'RUNNING'`。两个项目合进同一仓库的同一分支，同样串行。
- **J2（落地的树 = 测过的树）**：CHECK `state <> 'LANDED' OR (landed_sha IS NOT NULL AND tested_tree_sha IS NOT NULL AND landed_tree_sha = tested_tree_sha)`。
- **J3（一个任务同时只有一条在途的落地）**：部分唯一索引 `(task_id) WHERE kind = 'LAND_TASK' AND state IN ('QUEUED','RUNNING')`。
- **J4（终态不可变）**：触发器 `project_integration_job_terminal_guard` 拒绝修改终态行（`db-write-inventory` 的触发器清单要同步，§8.3）。

### 2.2 状态转移

| # | from | 已提交事实 | to | 附带写入（同一事务） |
|---|---|---|---|---|
| J-T1 | — | 入队事实（§2.3） | `QUEUED` | L3（第一条）；同任务更早的 `QUEUED` 行 → `SUPERSEDED` |
| J-T2 | `QUEUED` | 心跳领取 CAS：该 runner 声明 `integration-job/v1` 且未 draining；`LAND_TASK` 还要求该任务没有 `finished_at IS NULL` 的工作会话（见 J-T1e）；同 `serial_key` 无 `RUNNING`；按 `(created_at, id)` 取最早 | `RUNNING` | `claim_generation + 1`、`claim_lease_owner`、`claimed_at`、`heartbeat_at` |
| J-T3 | `RUNNING` | 领取时发现 `heartbeat_at < now() - 10 min`（runner 失联） | `RUNNING`（换认领者） | `claim_generation + 1`。旧认领者的结果回报被 409 `STALE_CLAIM` 拒绝 |
| J-T4 | `RUNNING` | 进度回报（`phase`、`heartbeat_at`；晋升重检见 M-T7） | `RUNNING` | |
| J-T5 | `RUNNING` | 结果回报：`LANDED` / `ALREADY_LANDED` / `NOTHING_TO_LAND`（0300） | 同名终态 | 回执（J8，`NOTHING_TO_LAND` 仅在该任务没有任何会话报告过工作时）；解决该任务的集成类待办（X 表，仅落地）；提交后边沿见 J9–J11。抢跑的 `ALREADY_LANDED`（判定的领取早于该任务工作结束）不落终态，退回 `QUEUED`（见 J-T1e） |
| J-T6 | `RUNNING` | 结果回报：`READY`（仅 `CHECK_PROMOTION`） | `READY` | 晋升 → `READY`（M-T2） |
| J-T7 | `RUNNING` | 结果回报：`CONFLICT` / `CHECK_FAILED` / `ERROR` | 同名终态 | 例外待办（§4.2）；晋升 → `BLOCKED`（若有） |
| J-T8 | `QUEUED` / `RUNNING` | 任务被重开或取消、晋升被取代或拒绝、owner 取消（写 `cancel_requested_at`） | `CANCELLED` | `RUNNING` 行由 runner 在下一个阶段边界回报 `CANCELLED` |

**J5（不自动重试）**：`CONFLICT`、`CHECK_FAILED`、`ERROR` 之后平台不再入队，重试只由 J-T1b、J-T1c 两个事实触发（判据 6）。唯一例外是 runner 在同一次作业内处理「推送时目标被别人推进」：回到 FETCH，最多再做 2 轮（附录 A-Q5），不另起作业。（J-T1e 的补排不在此列：它入队的是**另一条分支上的首次落地**，不是对任何失败作业的重试，被抢跑判掉的那个作业本身仍是终态。）

### 2.3 触发点

**J-T1a（DONE）**：写 `task.status = DONE` 的三个事务里，调用 `ProjectIntegrationJobService.enqueueForDoneTask(tx, taskId)`：

| DONE 写入点 | 所在方法 |
|---|---|
| EXECUTABLE 验收命令退出码一致 | `RunnerApiController.turnComplete` |
| 证据裁决 CONFIRM | `TaskCompletionEvidenceService.decide` |
| VERIFICATION PASS 放行被验证任务 | `TasksService` 中核验通过后放行 subject 的路径 |

`enqueueForDoneTask` 在 `isCodeTask` 为假时什么也不做；为真时：`MAIN` 线（或尚未决定、按 L2 算出 `MAIN`）的项目改为插入晋升（§3.4 M-F2）；`PROJECT_BRANCH` 线插入 `LAND_TASK`。父任务聚合（`applyTaskAggregations`）写的 DONE 不入队：父任务没有自己的工作分支。新增普查 `src/apiserver/src/projects/integration-enqueue-done-sites.spec.ts`：扫描 apiserver 里所有把 task 写成 DONE 的方法，要求每一处在同一方法内调用 `enqueueForDoneTask`，聚合写入方列入白名单。

**J-T1b（显式重试）**：协调会话调用 MCP `integration_retry { taskId }`，或 owner 在卡片上按 Retry（`POST /projects/:id/tasks/:taskId/integration/retry`）。请求提交后入队下一个 generation，并取代该任务 OPEN 的集成类待办（`SUPERSEDED`，resolution `RETRIED`）。协调会话之外的 agent 会话调用时拒绝 403 `INTEGRATION_RETRY_COORDINATOR_ONLY`。

**J-T1c（任务分支来了新提交）**：该任务工作会话的 `turnComplete` 提交时，若 `dto.branchSha` 与该任务最近一条失败作业的 `source_sha` 不同、任务仍是 DONE、且有 OPEN 的集成类待办，同一事务入队下一个 generation（效果图 5：「push to the task branch — Orbit re-integrates and re-checks on its own」）。

**J-T1d（线开始时补入队）**：见 L3 第 4 步。

**J-T1e（不许抢跑；判成了「没有独有提交」而成果在另一条分支上）**：`LAND_TASK` 的 `ALREADY_LANDED` 只在**该任务的工作已经停止移动**时才写成终态，因为 runner 在**结束会话**时才提交 worktree（SR13），而作业由结束它的那次 DONE 入队——线可能在提交存在之前就被交给一条空分支，那时它唯一能给的答案就是 `ALREADY_LANDED`，而那是终态、按设计不再重投。两条守卫（`project-integration-job.ts` 的 `landingWorkHasSettled` / `landingJudgedTooEarly`，SQL 见 `integration-job-relay.ts#claimOne`）：

- **领取（J-T2）**：该任务任一工作会话 `finished_at IS NULL` 时不领取，留在 `QUEUED`；会话结束后第一个心跳领取（那时 fetch 到的分支才带着收尾提交）。
- **判定（J-T5）**：回报的 `claimed_at` 早于某工作会话的 `finished_at`（或该会话尚未结束）时不落终态，该行退回 `QUEUED` 清空认领，由下一次领取重判。

**补排**：终态 `ALREADY_LANDED` 的 `source_ref` 若**不是**该任务工作结束所在的分支（该任务最后结束的工作会话的 `worktree_branch`，缺省回落 `branch`；`workBranchEndedOn`），成果就没有任何路线——同一事务入队下一个 generation，`source_ref` 指向那条分支（`queueLandingBehindTheWork`，`landingLeftWorkBehind` 为判据）。2026-09-23 的事故：任务 `01a0ce5e…` 的 DONE 冻结了**已经失败的那轮 retry** 的分支 `orbit/autorun-false-830a9b`（tip 就是项目分支 tip，什么都没带），而 151 轮那条会话的 `789a8fffc` 在 `orbit/autorun-false-91f94d` 上；线答 ALREADY_LANDED 时那条会话还有 2 分 42 秒没跑完，成果最后靠两次人工 cherry-pick 才落地。用例见 `src/apiserver/src/tasks/task-landing-races-final-commit.pg.spec.ts`。

**J-T2 的投递**：`HeartbeatResponse` 新增 `integrationJobs: IntegrationJobCommand[]`，由 `integration-job-relay.ts` 的 `dispatchIntegrationJobs`（照抄 `codex-reset-relay.ts` 的 `dispatchCodexResetCommand`）填入，每拍每个 runner 至多 2 条、串行键互不相同。结果与进度路由：

- `POST /runner/integration-jobs/:jobId/progress` `{ claimGeneration, leaseOwner, phase, upstreamMoved?: { from, to } }`
- `POST /runner/integration-jobs/:jobId/result` `{ claimGeneration, leaseOwner, state, phase, sourceSha, targetShaBefore, upstreamSha, mainSyncSha, testedSha, testedTreeSha, landedSha, landedTreeSha, aheadOfUpstream, checks, conflicts, errorCode, errorDetail, includedLandedShas? }`

两条路由写进 `contracts/runner-write-protocol.json`，同步两处 SHA 钉子（§8.3）。

```ts
interface IntegrationJobCommand {
  jobId: string; kind: 'LAND_TASK' | 'CHECK_PROMOTION' | 'LAND_PROMOTION';
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
  cancelRequested: boolean;
}
```

### 2.4 runner 上的执行（`LAND_TASK`）

新文件 `src/runner-go/integrate.go`。临时 worktree 建在 `<worktreesDir>/_integrate-<jobId>`，结束即删；进程内按 `(repoRoot, targetRef)` 加锁；复用 `mergeLock` 只包住 J-S6 的推送与本地 ref 前移。检查命令用 `bash -lc` 在临时 worktree 里执行，环境是 runner 自己的环境（不带 agent 会话的环境），超时取 `task.acceptance_timeout_seconds ?? 3600` 与 `merge_check_timeout_seconds ?? 3600`。

| 步 | 命令与判定 | 失败出口 |
|---|---|---|
| **J-S1 FETCH** | `git fetch <remote> <target_ref> <upstream_ref>`；T0 = 远端目标 tip（`PROJECT_BRANCH` 线目标不存在时 T0 = U）；U = 远端 upstream tip；S = `git rev-parse refs/heads/<源分支>` → `source_sha` | fetch 失败 → `ERROR / FETCH_FAILED`；源分支不存在 → `ERROR / SOURCE_BRANCH_MISSING`；upstream 不存在 → `ERROR / BASE_REF_NOT_FOUND` |
| **J-S2 MAIN_SYNC**（仅 `PROJECT_BRANCH`） | U 不是 T0 的祖先时，在 T0 上 `git merge --no-ff -m "Merge <upstream> into <target>" U` → M = `main_sync_sha`，base = M；否则 base = T0 | 冲突 → `CONFLICT`（`phase = MAIN_SYNC`，冲突路径来自 `git diff --name-only --diff-filter=U`） |
| **J-S3 已包含** | S 是 base 的祖先：S **等于会话记录的 base**（分支停在 fork 点，自己没有提交）→ `NOTHING_TO_LAND`（0300）；否则 → `ALREADY_LANDED`。两者都不推送，丢弃 M | |
| **J-S4 REBASE / MERGE** | fork = `git merge-base S base`；`git rev-list --merges fork..S` 非空 → **MERGE 模式** `git merge --no-ff S`（保住合并提交里的冲突解法）；否则 `git rebase --onto base <fork 或 sessionBaseSha> S`。结果 C = `tested_sha` | 冲突 → `CONFLICT`（`phase = REBASE` 或 `MERGE`） |
| **J-S5 CHECK** | 组合树自带 `scripts/worktree-overlay.sh` 时先运行它（见下方「检查前的铺环境」），再在 C 上依次跑任务验收命令（有 `acceptance_command` 时）与合并检查命令（有配置时），逐条比对退出码 | 铺环境失败或超时 → `ERROR / CHECK_TREE_UNPREPARED`；任一退出码不一致 → `CHECK_FAILED`（什么都不推送） |
| **J-S6a 落地前核对** | `tested_tree_sha = git rev-parse C^{tree}`；要求 `HEAD = C` 且 `git status --porcelain --untracked-files=no` 为空（检查不得改动或提交已跟踪文件） | → `ERROR / CHECK_MUTATED_TREE` |
| **J-S6 PUSH** | REMOTE：`git push <remote> C:<target_ref>`（不带 force，只能 fast-forward）；RUNNER_LOCAL：`git update-ref <target_ref> C T0`。随后在 workDir 前移本地目标 ref（同 `rebaseFastForward`：目标在根 checkout 上时 `merge --ff-only`，否则 `branch -f`） | 非 fast-forward 被拒 → 回 J-S1，至多 2 轮 → `ERROR / TARGET_MOVED`；其他 → `ERROR / PUSH_REJECTED` |
| **J-S7 VERIFY** | `git fetch <remote> <target_ref>`；要求远端 tip = C 且 `C^{tree} = tested_tree_sha`；`landed_sha = C`，`landed_tree_sha` = 其树；`ahead_of_upstream = git rev-list --count U..C` | 不一致 → `ERROR / LANDED_TREE_MISMATCH`（不写回执） |
| **J-S8 REPORT** | 回报 `LANDED` 与全部字段 | 回报失败按 `mergeOutcomes` 的做法缓存结果重发，不重跑 git |

每步开始前检查 `cancelRequested`，`PUSH` 之后不再检查。任务验收命令原本在会话的活 worktree 里跑，包括未提交的改动；J-S5 在已提交的组合树上重跑，这两者的差异正是本步要抓的。

**检查前的铺环境（J-S5、M-S3）**：组合树出自 git 对象，因此**没有 `node_modules`**。仓库自带 `scripts/worktree-overlay.sh` 时，检查之前先在树里运行它（会话 worktree 铺的就是同一个脚本、同一个路径，只有一份配方法），这样 `cd src/web && npx vitest run …` 这类「直接要 JS 依赖」的验收命令与 `bash scripts/run-pg-spec.sh …` 这类自带铺设的命令在组合树上同样能跑。它只写 gitignored 路径（`node_modules/`、`dist/`）：既不进 `C^{tree}`，也不出现在 J-S6a 的 `git status --porcelain --untracked-files=no` 里，所以「落地的树 = 测过的树」不受影响——被判定的始终是提交，铺环境只是让检查跑得起来。没有这个脚本的仓库跳过本步；脚本失败或超时 → `ERROR / CHECK_TREE_UNPREPARED`：检查从未在它能跑的树里跑过，那不是对工作的判决。

### 2.5 回执与派发下游

**J8（回执）**：`receiveResult` 在同一事务里，通过新方法 `MergeReceiptService.fromIntegrationJob(tx, job)` 为 `LANDED` / `ALREADY_LANDED` 写回执；`NOTHING_TO_LAND`（0300）写回执的形状相同（`result = ALREADY_MERGED`、`target_sha_after = NULL`），但**只在该任务没有任何 work 会话报告过工作时**才写：那种情况下「本任务没有东西可落」正是 J9 释放下游所依据的事实；反过来，任务的工作在**另一条分支**上时这一行不写回执——回执照写就等于宣称这份工作在那个目标上，而这正是 2026-09-23 假回执骗过晋升卡的那句假话——同时往任务上写一条评论（`task_comment`，同一个事务）留下可见信号。

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

**J9（依赖谓词）**：`dependenciesSatisfiedSql` 与 `computeDependencyState` / `dependencyFactsFor` 的「前置已满足」改为：

> 链尾任务 `status = DONE` 且核验闸门打开（与今天相同），**并且**以下三者之一成立：前置所在项目 `lineStarted` 为假；前置不是代码任务（`isCodeTask` 为假）；前置在其项目集成线上的任务级落地 ∈ {`ON_INTEGRATION_LINE`, `ON_UPSTREAM`}。

`AUTO_RUN_READY_SQL` 与 `manualRunnableTaskSql` 经 `dependenciesSatisfiedSql` 自动继承。谓词只读 `project_codebase` 与回执，不读作业表，所以依赖任务（§9 的 T7）不依赖集成作业任务。

**J10（派发边沿）**：`MergeReceiptService.deliverProjectFactsAfterCommit` 末尾新增 `TasksService.dispatchDependentsOf(taskId)`：回执提交是下游开工的事实，`autoRunWhenReady = true` 的下游在这里经 `execute` 的 `dep:<taskId>:<epoch>` 门开工。`dispatchDependentsAfterCompletion` 在 DONE 边沿照旧调用，前置有落地要求时谓词不满足，自然跳过。`TasksService` 的 60 秒 sweep 读同一谓词，属于 G3 第 2 条的重投，不新增职责。

**J11（其他提交后边沿）**：同一回执边沿上还有 §3.4 M-F1（晋升候选）、§6.7 B3（blocker 自动解除）。三者都从已提交行重新推导；进程死在边沿之前时，补偿点是下一条回执或下一次任务写入（与既有 door 相同），以及 §7 读模型把「已落地但下游未开工」显示为 Ready。

### 2.6 失败

**J12（`error_code` 闭集）**：`FETCH_FAILED`、`SOURCE_BRANCH_MISSING`、`BASE_REF_NOT_FOUND`、`TARGET_MOVED`、`PUSH_REJECTED`、`CHECK_TREE_UNPREPARED`、`CHECK_MUTATED_TREE`、`LANDED_TREE_MISMATCH`、`PROMOTION_TREE_NONDETERMINISTIC`（§3）、`RUNNER_DRAINING`、`INTEGRATION_REPOSITORY_UNKNOWN`（入队前拒绝）。

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
}
```

### 2.8 测试

`scripts/acceptance/project-integration-line.sh`（判据 6；真实 apiserver + runner + 本地 git 仓库，检查命令用可控脚本）。本任务创建该脚本，结构为每个用例一个 `case_<name>` 函数，文件末尾的 `CASES=(…)` 登记，后续任务追加（§9.2）：

1. `case_clean_lands_and_dispatches`：干净 → `LANDED`、回执 `MERGED`、`autoRun` 下游开工
2. `case_conflict_opens_item_target_untouched`：冲突 → `INTEGRATION_CONFLICT` 待办、目标分支 tip 不变
3. `case_check_failed_opens_item_nothing_lands`：检查失败 → `INTEGRATION_CHECK_FAILED` 待办、未落地
4. `case_two_done_serialize_tree_equals_tested`：两条任务同时 DONE → 串行落地，两条作业都满足 `landed_tree_sha = tested_tree_sha`

另建议：`src/apiserver/src/projects/integration-job-relay.pg.spec.ts`（J-T2 / J-T3 租约与 `STALE_CLAIM`）、`integration-enqueue-done-sites.spec.ts`（J-T1a 普查）、`src/runner-go/integrate_test.go`（J-S2 / J-S4 MERGE 模式 / J-S6a）。

---

## 3. main 同步与合入 main

### 3.1 main 同步

**M1**：只针对 `PROJECT_BRANCH` 线，发生在 `LAND_TASK` 的 J-S2。upstream tip 不是项目分支 tip 的祖先时，先生成吸收 upstream 的 merge 提交，再把任务 rebase 到它上面，二者一起检查、一起落地。项目分支上因此出现 merge 提交，旧 tip 仍是祖先。**不 rebase 项目分支，不 force push**（硬约束 3）。

**M2**：吸收时冲突 → 作业 `CONFLICT`（`phase = MAIN_SYNC`）+ `INTEGRATION_CONFLICT` 待办。只要这条待办 OPEN，同一 `serial_key` 上后续 `LAND_TASK` 不被领取，否则每条作业都会撞上同一个冲突、各开一张卡。

**M3**：协调会话解决吸收冲突的方式：在一个会话 worktree 里从项目分支 tip 出发，merge upstream 并解决冲突，再调用 `integration_retry`。平台用 J-S4 的 MERGE 模式落地这条解决提交。rebase 会丢掉合并提交里的解法，这正是现有 `session_merge` 的已知缺陷。

**M4**：upstream 前进本身不触发同步。没有哪个事实能说「现在该同步」而不引入时钟；同步发生在下一次集成或下一次晋升检查时。

### 3.2 数据结构

**`project_promotion`**（迁移 0273）：

| 列 | 类型 | 约束与语义 |
|---|---|---|
| `id` | uuid(7) PK | |
| `project_id` / `owner_id` / `codebase_id` | uuid | |
| `source_kind` | text | CHECK ∈ {`PROJECT_BRANCH`, `TASK_BRANCH`}；后者只用于 `MAIN` 线项目 |
| `task_id` / `session_id` | uuid NULL | `TASK_BRANCH` 必填 |
| `source_ref` / `source_sha` | text / char(40) NULL | 候选的源：项目分支 tip，或任务分支 tip。`TASK_BRANCH` 的 tip 只有仓库知道（会话记的是分支名和分叉点），所以候选先以 NULL 写下，由 `CHECK_PROMOTION` 解析后回写（迁移 0293）；凡检查产出的状态都带值 |
| `upstream_ref` | text | 冻结自代码库行 |
| `upstream_sha_checked` / `merge_tree_sha` | char(40) NULL | 最近一次通过的检查所基于的 upstream tip 与组合树 |
| `included_task_ids` | uuid[] NOT NULL DEFAULT `'{}'` | 这次合入带进 main 的任务 |
| `commits_ahead` / `files_changed` | int NULL | 卡片显示 |
| `checks` / `conflicts` | jsonb / text[] | 最近一次检查 |
| `state` | text | CHECK ∈ {`CHECKING`, `READY`, `CONFIRMED`, `RECHECKING`, `MERGED`, `BLOCKED`, `DECLINED`, `CANCELLED`, `SUPERSEDED`} |
| `check_job_id` / `land_job_id` | uuid NULL | 当前作业 |
| `confirmed_by_user_id` / `confirmed_at` / `decided_at` | uuid / timestamptz | |
| `confirmed_automatically` | boolean NOT NULL DEFAULT false | 迁移 0301。没人按：项目的 Automatic 授权确认了这次合入（M-T11），此时 `confirmed_by_user_id` 为 NULL。CHECK：`CONFIRMED` / `RECHECKING` / `MERGED` 行要么写明确认人、要么此列为真；此列为真时 `source_kind = 'PROJECT_BRANCH'` 且不写确认人（`MAIN` 线永远不能被记成自动确认） |
| `merged_sha` / `merged_at` | char(40) / timestamptz NULL | |
| `open_item_id` | uuid NULL | 当前卡片对应的待办（`PROMOTION_APPROVAL` 或阻塞它的协调会话待办） |
| `receipt_ids` | uuid[] NOT NULL DEFAULT `'{}'` | |
| `created_at` / `updated_at` | timestamptz | |

部分唯一索引 `(project_id, source_ref) WHERE state IN ('CHECKING','READY','CONFIRMED','RECHECKING','BLOCKED')`：同一个源同时只有一个活的候选。终态行不可变（触发器 `project_promotion_terminal_guard`）。

### 3.3 状态转移（效果图 4 的四种状态）

| # | from | 已提交事实 | to | 附带写入 |
|---|---|---|---|---|
| M-T1 | — | 候选事实（§3.4） | `CHECKING` | 同一事务入队 `CHECK_PROMOTION` |
| M-T2 | `CHECKING` | 检查作业 `READY`，且 M-T11 不成立 | `READY`（状态 A） | `PROMOTION_APPROVAL` 待办（负责人 OWNER）；提交后推送 `approve-merge-to-main` |
| M-T3 | `CHECKING` | 检查作业 `CONFLICT` / `CHECK_FAILED` / `ERROR` | `BLOCKED`（状态 D） | 协调会话待办（§4.2），`promotion_id` 指向本行 |
| M-T4 | `READY` | owner 确认写入（CAS `state = READY`，且 `source_sha` 与请求体一致） | `CONFIRMED` | 入队 `LAND_PROMOTION`；审批待办 `RESOLVED / APPROVED` |
| M-T5 | `READY` | owner「Not now」写入 | `DECLINED` | 审批待办 `RESOLVED / DECLINED`（附录 A-Q6） |
| M-T6 | `CHECKING` / `READY` / `BLOCKED` | 同一源出现新候选（M-F1） | `SUPERSEDED` | 旧待办 `SUPERSEDED`；旧检查作业 `CANCELLED`；新行 `CHECKING` |
| M-T7 | `CONFIRMED` | 落地作业进度回报 `upstreamMoved` | `RECHECKING`（状态 B） | 作业继续，在新 tip 上重做合并与检查 |
| M-T8 | `CONFIRMED` / `RECHECKING` | 落地作业 `LANDED` | `MERGED`（状态 C） | 回执（M9） |
| M-T9 | `RECHECKING` | 落地作业 `CONFLICT` / `CHECK_FAILED` / `ERROR` | `BLOCKED`（状态 D） | 协调会话待办；解决之后内容已经变了，重新走 A，要 owner 再点一次 |
| M-T10 | `CONFIRMED` / `RECHECKING` | owner「Cancel」写入，作业尚未进入 `PUSH` | `CANCELLED` | 作业 `cancel_requested_at` |
| M-T11 | `CHECKING` | 检查作业 `READY`，且同一事务读到：`source_kind = PROJECT_BRANCH` 且绑定仍是该项目分支（upstream 仍是它的 upstream）；`project.coordinator_enabled = true`；干净——无冲突、每条检查 `exit_code = expected` 且未超时、回报带 `upstreamSha` 与 `testedTreeSha`、本项目无 OPEN 的 `INTEGRATION_*` 待办；做检查的 runner 声明了 `promotion-automatic-land/v1` | `CONFIRMED`（`confirmed_automatically = true`，不写确认人） | 同一事务入队 `LAND_PROMOTION`（`confirmed_automatically = true`）；**不开** `PROMOTION_APPROVAL` 待办 |
| M-T12 | `CONFIRMED`（自动确认） | 落地作业 `READY`：runner 发现 upstream 已不在 `upstream_sha_checked`，什么都没合、没检查、没推（推送时才输掉的竞态走 J5 的重取回合，在重取时照此交回）；或领取时平台对同一行重读 M-T11（检查留下的事实 + 项目此刻的 `coordinator_enabled`、绑定、OPEN 集成类待办），授权已不成立——作业不下发给 runner，直接记 `READY`；授权读不出来也不下发 | `READY`（状态 A） | `confirmed_automatically` 复位为 false、`confirmed_at` / `land_job_id` 清空；开 `PROMOTION_APPROVAL` 待办（负责人 OWNER，payload 的 `upstreamShaChecked` 取本行、不取作业看到的新 tip）；作业行保留 `confirmed_automatically = true` |

**M5（确认后 main 前进 → 自动重检，不再问）**：owner 确认的是「这批任务、这些检查」。upstream 前进而检查仍然通过，结论不变，直接落地（状态 B）；重检失败就交给协调会话。**只适用于 owner 按下的确认**：Automatic 的自动确认（M-T11）授权的是「这棵测过的树、落到检查时的那个 main tip」，main 一动就不再干净，交回 owner（M-T12），不重检、不合并。

**M6（落地方式）**：`PROJECT_BRANCH` 源用 `git merge --no-ff <source_sha>` 合到 upstream tip，任务提交保持为 main 的祖先；`TASK_BRANCH` 源 rebase 后 fast-forward（附录 A-Q7）。两者都要求落地的树等于最后一次通过检查的树。

**M7（谁对合入 main 说是）**：owner——按卡片。唯一例外是两件事**同时**成立（owner 决定，2026-09-23：「有自己的项目集成分支 + automatic 就可以合并；如果是 main 或非 automatic，就需要人来点」）：这条线是项目自己的分支（`PROJECT_BRANCH`，已过线检查的暂存区，提供「这次落地是干净的」），且项目的 Automatic（`coordinator_enabled`）开着（owner 已经给过的授权，提供「这个项目可以自己动」）。此时由平台自行确认并合入，留收据（M-T11、§3.6 的 `merged.automatic` / `merged.revert`）。任一不成立——`MAIN` 线项目、Automatic 关、检查红、有冲突、main 在检查后前进、项目上有 OPEN 的集成类待办——都照旧出卡，一个字不改。不为凑自动放宽「干净」：前三条在 M-T11 的判据里，main 前进由 runner 在推送前执行（M-T12），声明不了这一点的 runner 不会被交给自动落地（领取也会跳过它）。「落地那一刻」的授权读两次：检查回来 `READY` 时决定出卡还是自动确认，作业被领取、即将下发给 runner 时再读一次——owner 在这之间关掉 Automatic（或线改成了 main、项目上新开了集成类待办），这次落地就交回 owner 出卡，不凭一个已经收回的授权推送。

语义代价写明：`coordinator_enabled` 原本只管「平台可以自动把例外待办交给协调会话」，现在同一个开关也是「允许平台自主合入 main」的授权——为了让协调会话处理例外而打开 Automatic 的 `PROJECT_BRANCH` 项目，会顺带开始自动合入 main。owner 选择复用这个开关而不是加第二个；Automatic 的说明文案（§7.2 V8）必须说出这一点，`schema.prisma` 里该列的注释同样写明。

**M8（合入 main 不等于项目完成）**：卡片显示判据满足数（效果图 4「3 of 6 met on this branch — merging does not close the project」），由客户端从 `project_get` 的判据项计算；DONE 仍由 §3.5 的投影决定。

**M9（回执）**：`MERGED` 的事务里，为 `included_task_ids` 中每个任务的产出会话各写一条回执：`result = MERGED`、`target_branch` = upstream 短名、`source_sha` = 该任务在集成线上的落地提交（`TASK_BRANCH` 为作业的 `tested_sha`）、`target_sha_before` = 推送前 upstream tip、`target_sha_after = merged_sha`、`recorded_by = RUNNER`、`detail = { promotionId, integrationJobId }`。这些任务随即变成 `ON_UPSTREAM`，判据读作 `LANDED`。

### 3.4 触发点与 runner 步骤

**M-F1（`PROJECT_BRANCH` 候选）**：一条 `LAND_TASK` 作业进入终态的事务提交后，`ProjectPromotionService.considerCandidate(projectId)` 从已提交行判断：

- 同一 `serial_key` 上已没有 `QUEUED` / `RUNNING` 的 `LAND_TASK`（「队列排空」是最后一条作业的提交事实）；
- 最近一条 `LANDED` 作业的 `landed_sha`（记为 P）没有被 `MERGED`、`DECLINED` 或活的候选覆盖；
- 本项目没有 `CONFIRMED` / `RECHECKING` 的晋升（有的话，等它终态后再判断，见 M-F4）。

条件都成立时插入候选（`source_sha = P`，`included_task_ids` 取 P 之前落地、尚未 `ON_UPSTREAM` 的任务），并取代同一源上活的旧候选。

**M-F2（`MAIN` 线候选）**：`MAIN` 线项目的代码任务 DONE 时，J-T1a 不入队 `LAND_TASK`，改为同一事务插入 `project_promotion(source_kind = TASK_BRANCH, state = CHECKING)` 与 `CHECK_PROMOTION`。

**M-F3（owner 写入）**：`POST /projects/:id/promotions/:promotionId/{confirm | decline | cancel}`，只接受 owner 凭据；带 acting session 拒绝 403 `PROMOTION_OWNER_ONLY`；状态不符拒绝 409 `PROMOTION_NOT_READY`。

**M-F4**：`LAND_PROMOTION` 终态提交后再调一次 `considerCandidate`，接住确认期间落进项目分支的新任务。

**runner 步骤**：

| 步 | `CHECK_PROMOTION` | `LAND_PROMOTION` |
|---|---|---|
| M-S1 | fetch upstream 与源；U = upstream tip | 同左；U′ = 当前 upstream tip |
| M-S2 | `PROJECT_BRANCH`：在 U 上 `git merge --no-ff -m "Merge <source> into <upstream>" <source_sha>`；`TASK_BRANCH`：在 U 上 rebase 源 | U′ = `upstream_sha_checked` → 重做同一合并；否则回报进度 `upstreamMoved` 并在 U′ 上重做。命令带 `automatic: true`（M-T11）时，U′ ≠ `upstream_sha_checked`（或命令没给它）→ 不合并、不检查、不回报 `upstreamMoved`，直接回报 `READY`（M-T12）；已在 upstream 上的源仍先回报 `ALREADY_LANDED` |
| M-S3 | 跑检查（组合树自带 `scripts/worktree-overlay.sh` 时先运行它，同 J-S5）：`PROJECT_BRANCH` 跑合并检查；`TASK_BRANCH` 跑任务验收命令与合并检查 | U′ 未变：要求重做的合并树 = `merge_tree_sha`，不等 → `ERROR / PROMOTION_TREE_NONDETERMINISTIC`；U′ 变了：重跑检查 |
| M-S4 | 回报 `READY { upstreamShaChecked, mergeTreeSha, commitsAhead, filesChanged, includedLandedShas }`，`includedLandedShas` 为逐个 `merge-base --is-ancestor` 核实过的候选 | 落地前核对（同 J-S6a）→ 推送 upstream（不 force）→ 前移本地 upstream → 远端核对（同 J-S7）→ 回报 `LANDED` |

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
}
```

`GET /projects/:id/promotions/merged` → `ProjectPromotionView[]`，最近的合入在前（上限 20 条）：这次合入留下的**记录**，会话把它画在**它发生的那一刻**（`ProjectPromotionReceipt`，`WorkspaceView` 用 `decisionReceiptAnchor` 按 `merged.at` 落位）。

自己的读接口而不是 `current` 的加宽：`current` 是**现在在问**的那个候选，下一个候选一出现它就换人——从它画出来的回执，每次分支再被提议都会说成另一次合入；而在它换人之前，同一张卡就一直待在会话底部，压在之后每一条消息下面（owner 2026-09-21 的报告）。`MERGED` 行是终态且不可变（`project_promotion_terminal_guard`），自带 `merged_sha` / `merged_at`，所以它读回来永远是它当时那次合入。项目页没有转录可以落位，仍按 `current` 画 C 状态那一张。

### 3.7 测试

`scripts/acceptance/project-integration-line.sh` 追加判据 7 的用例：

1. `case_main_sync_merges_upstream_keeps_old_tip`：main 前进后，集成前出现吸收 main 的 merge 提交，旧 tip 仍是祖先
2. `case_unconfirmed_does_not_merge`：未确认时不合入
3. `case_confirm_after_main_moved_rechecks_then_lands`：确认后 main 已前进，先重检再落地
4. `case_lands_no_ff_task_commits_are_ancestors`：main 出现 no-ff 合并提交，任务提交是 main 的祖先
5. `case_project_done_flips_on_merge`：项目 DONE 在合入前后翻转

`src/web/src/components/ProjectPromotionCard.test.tsx`：`renders READY with tasks, checks and the merge button`、`renders RECHECKING with the merge button disabled and a cancel`、`renders MERGED as a receipt`、`renders BLOCKED with the merge button disabled and the handler`。

`src/web/src/components/WorkspaceView.promotionAtMerge.test.tsx`：合入的记录画在它发生的那一刻而不是卡片区、`current` 前进后它仍说自己那次合入、没有合入过的项目一张都不画、卡片区不再为已合入的晋升留一张卡。

`src/apiserver/src/projects/project-promotion-read.spec.ts`：`merged` 只读 `MERGED` 行且最近在前、一次合入带回它自己的提交与任务、二十条历史只各问一次表、没有合入过就不读任务表。

---

## 4. 例外待办

### 4.1 数据结构

**`project_open_item`**（迁移 0278）：

| 列 | 类型 | 约束与语义 |
|---|---|---|
| `id` | uuid(7) PK | |
| `project_id` / `owner_id` | uuid | FK `project` CASCADE |
| `kind` | text | CHECK ∈ {`INTEGRATION_CONFLICT`, `INTEGRATION_CHECK_FAILED`, `INTEGRATION_ERROR`, `TASK_FAILED`, `PROMOTION_APPROVAL`, `COORDINATOR_QUESTION`, `FUSE_PAUSED`} |
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
| `resolution` | text NULL | 闭集：`LANDED`、`RETRIED`、`TASK_DONE`、`TASK_CLOSED`、`SUCCESSOR_FILED`、`PROMOTION_MOVED_ON`、`HANDLED`、`APPROVED`、`DECLINED`、`ANSWERED`、`WITHDRAWN`、`RESUMED` |
| `resolved_at` / `resolved_by` | timestamptz / text NULL | `resolved_by` CHECK ∈ {`USER`, `COORDINATOR`, `PLATFORM`} |
| `resolved_by_user_id` / `resolved_by_session_id` / `resolution_note` | uuid / uuid / text NULL | |
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
| `INTEGRATION_CONFLICT` | COORDINATOR | 集成作业 `CONFLICT`（J-T7） | `IC:<jobId>` | `{ jobKind, phase, targetRef, targetSha, files[], nothingLanded: true }` | 同任务新 generation 入队 → `SUPERSEDED / RETRIED`；任务落地 → `LANDED`；任务取消或被 successor 取代 → `TASK_CLOSED`；晋升被取代或合入 → `PROMOTION_MOVED_ON`；`open_item_resolve` → `HANDLED` |
| `INTEGRATION_CHECK_FAILED` | COORDINATOR | 集成作业 `CHECK_FAILED` | `ICF:<jobId>` | `{ jobKind, check: { name, command, exitCode, expectedExitCode, durationMs, outputTail }, branchUnchanged: true }` | 同上 |
| `INTEGRATION_ERROR` | COORDINATOR | 集成作业 `ERROR`；或入队前拒绝 `INTEGRATION_REPOSITORY_UNKNOWN` | `IE:<jobId>` 或 `IE:task:<taskId>` | `{ errorCode, errorDetail }` | 同上 |
| `TASK_FAILED` | COORDINATOR；链上第 3 次 → OWNER（`CHAIN_LIMIT`） | 任务失败的全部来源（§4.3） | `TF:<taskId>:<sessionId>`；没有会话时 `TF:<taskId>:write:<n>` | `{ how, exitCode?, expectedExitCode?, error?, chain: { rootTaskId, failuresInChain, limit } }` | 任务 DONE → `TASK_DONE`；FAILED → IN_PROGRESS（`clearFailedForRetry`）→ `RETRIED`；被 successor 链接 → `SUCCESSOR_FILED`；取消 → `TASK_CLOSED`；`open_item_resolve` → `HANDLED` |
| `PROMOTION_APPROVAL` | OWNER | 晋升 `READY`（M-T2） | `PA:<promotionId>` | `ProjectPromotionView` 的快照 | 确认 → `APPROVED`；Not now → `DECLINED`；新候选 → `SUPERSEDED` |
| `COORDINATOR_QUESTION` | OWNER | `ask_owner` 提交（§5.2） | `CQ:<clientQuestionId>` | `{ question, options: [{ label, description? }], recommendedOption?, blocksTaskIds[], ifUnanswered }` | owner 答复 → `ANSWERED`；提问会话撤回 → `WITHDRAWN` |
| `FUSE_PAUSED` | OWNER | 暂停段插入（§6.3） | `FP:<episodeId>` | `{ dimension, observed, limit, spendToday, heldCount }` | 恢复 → `RESUMED` |

标题（英文，取自效果图）：`Merge conflict: <task>`、`Checks failed on the combined tree: <task>`、`Integration error: <task>`、`Task failed: <task>`、`Approve merge to main`、`Coordinator asks: <question>`、`The coordinator paused itself`。

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

**X-D5（排空点退回）**：在 G6 列出的四个排空点，以及打断与撤回的删除点，排空之前调用 `ProjectOpenItemService.returnQueuedTurns(tx, sessionId, { code, ending })`：本会话尚未 `delivered_at` 的平台轮次对应的投递行写 `returned_at` / `return_code`。`ending = true`（会话正在结束）时，同一事务把这些待办改为 OWNER / `COORDINATOR_ENDED`，提交后推送 `escalated-to-you`；`ending = false`（打断、撤回）时待办保持 OPEN，等 X-D4 第 3 条补投。

**X-D6（没人可投）**：创建时项目没有协调会话，或会话已结束 → 负责人直接为 OWNER（`NO_COORDINATOR` / `COORDINATOR_ENDED`），推送 `escalated-to-you`。

**X-D7**：OWNER 待办不投给会话，owner 在卡片与推送里看到。其中 `COORDINATOR_QUESTION` 的答复投给协调会话（§5.2）。

### 4.5 重试链上限

**X-C1（链）**：从任务沿 `superseded_by_task_id` 反向找到根（没有前驱指向它的任务），链 = 根及其全部后继（递归 CTE，至多 256 跳，与 `task_dependency_tail_id` 一致）。

**X-C2（计数）**：`failuresInChain` = 链内任务上 `kind = TASK_FAILED` 的待办数（不论状态），只数链内最后一次 DONE 之后创建的。取消不产生待办，所以不计。

**X-C3**：插入 `TASK_FAILED` 时 `failuresInChain`（含本条）≥ `TASK_FAILURE_CHAIN_LIMIT = 3` → 负责人 OWNER、`assignee_reason = CHAIN_LIMIT`、`escalate_at = NULL`，推送 `escalated-to-you`。payload 的 `chain` 字段让卡片写出「attempt 2 of 3 in this chain」。

### 4.6 超时升级（唯一新增的时钟）

**X-E1**：新文件 `src/apiserver/src/projects/open-item-escalation.service.ts`，`ProjectOpenItemEscalationService` 注册在 ProjectsModule，`onModuleInit` 起 `setInterval(60_000)`。它不放进 `tasks.service.ts`（那里只许一个 interval）、不放进 PushModule（`judgment-delivery-removal.spec.ts` 钉死 providers）、不新增 compose 服务或 `start:*` 脚本。每一拍只做两条语句：

```sql
UPDATE project_open_item item
   SET assignee = 'OWNER', assignee_reason = 'ESCALATED', assigned_at = now(),
       escalated_at = now(), updated_at = now()
 WHERE item.state = 'OPEN' AND item.assignee = 'COORDINATOR' AND item.escalate_at <= now()
   AND escalatesAt(item) <= now()
RETURNING id, project_id;

UPDATE project_open_item SET reminded_at = now(), updated_at = now()
 WHERE state = 'OPEN' AND assignee = 'OWNER' AND remind_at <= now() AND reminded_at IS NULL
RETURNING id, project_id;
```

提交后对 RETURNING 的行调用 `PushService.notifyOwnerItem`。**它不写 `conversation_turn`、`session`、`project_coordinator_wake` 或投递行**：升级只通知 owner。多副本下两条语句本身是 CAS，重复执行不重复推送。

「到期」看的是协调会话的沉默，不是待办的年龄（`escalatesAt`，定义在 `open-item-escalation.service.ts`；§4.8 的 `escalateAt` 与项目列表的 `nextEscalationAt` 读同一个表达式，卡片倒数的就是时钟会动手的那一刻）：`escalatesAt = GREATEST(escalate_at, 最后推进 + (escalate_at − waiting_since))`。「最后推进」只在以下都成立时存在：项目 `coordinator_enabled`，`coordinator_session_id` 指向的会话未结束（`sessionHasEnded` 的 SQL 版）、也没有被请求结束（`cancel_requested_at IS NULL`），该会话持有这条待办未被退回（`returned_at IS NULL`）的 ITEM 投递行；取值为该会话 `kind = 'message'`、交给过 engine（`delivered_at` 非空）的轮次中、`COALESCE(answered_at, delivered_at)` 不早于那条投递行 `created_at` 的最大者。于是收到之后还在跑轮次的会话一直持有它；卡住、停下或结束的会话在停下满一个窗口后交出；从没送到的待办照旧在 `escalate_at` 交出。时钟只读轮次、不写轮次；升级之后的归属不变——待办归 owner，协调会话的「标记已处理」照旧被拒（`OPEN_ITEM_NOT_COORDINATOR_ITEM`），X-E3 的终态事实照常解决它。

**X-E2**：`escalate_at` 在创建或「Ask the coordinator again」时冻结；改项目的升级时长只影响之后创建的待办（附录 A-Q8）。

**X-E3**：升级后的待办保留原有投递；协调会话之后的动作（重试、successor、落地）照样按 X 表的终态事实解决它。

**X-E4**：CIR 的「此路径无时钟」一句按本文开头改写，并补一段：「The one clock added by the integration-line contract escalates an unhandled open item to the account owner. It writes the item's assignee and sends the owner a notification; it creates no wake, no turn and no session.」

### 4.7 协调会话与 owner 的动作

| 动作 | 入口 | 权限 | 效果 |
|---|---|---|---|
| 重试集成 | MCP `integration_retry { taskId }`；`POST /projects/:id/tasks/:taskId/integration/retry` | 当前协调会话或 owner | J-T1b |
| 标记已处理 | MCP `open_item_resolve { itemId, note }`；`POST /projects/:id/open-items/:itemId/resolve`（owner 走用户门，协调会话走 runner 门带 `X-Orbit-Session-Id`） | 负责人本人：COORDINATOR 待办只由**当前**协调会话关，owner 不限；问题由提问会话撤回（R12） | `RESOLVED / HANDLED`（问题为 `WITHDRAWN`），`note` 必填、≤2000 字符；`PROMOTION_APPROVAL` 与 `FUSE_PAUSED` 各有自己的门，此入口拒绝（`OPEN_ITEM_HAS_ITS_OWN_DOOR`） |
| 交给 owner | MCP `open_item_hand_over { itemId, note }`；web「Hand to owner」 | 协调会话或 owner | OWNER / `HANDED_OVER`，推送 |
| 让协调会话再看一次 | web「Ask the coordinator again」：`POST …/open-items/:itemId/return-to-coordinator` | owner | COORDINATOR / `DEFAULT`，重置 `waiting_since` 与 `escalate_at`，走 X-D4 第 1 条；**要求存在活着的协调会话，不要求 `coordinator_enabled`**——开关约束的是自动交付（附录 B 修订 2） |
| 列表 | MCP `open_item_list { projectId }`；`GET /projects/:id/open-items?state=` | 项目内会话或 owner | 读 |

MCP 工具加在 `src/runner-go/mcp.go`（描述 + case）、`transport.go`（HTTP 方法）、`runner-projects.controller.ts`（路由），并在 `cli_mcp_parity_test.go` 登记 CLI 能力或豁免。错误码：`OPEN_ITEM_NOT_OPEN`（409）、`OPEN_ITEM_NOT_COORDINATOR_ITEM`（409）、`OPEN_ITEM_COORDINATOR_ONLY`（403）、`OPEN_ITEM_HAS_ITS_OWN_DOOR`（409）、`OPEN_ITEM_OWNER_ONLY`（403）、`INTEGRATION_RETRY_NOT_APPLICABLE`（409）。

### 4.8 读模型

```ts
interface OpenItemRow {
  itemId: string; kind: OpenItemKind; title: string; detailLine: string;
  assignee: 'COORDINATOR' | 'OWNER'; assigneeReason: OpenItemAssigneeReason;
  waitingSince: Date; escalateAt: Date | null; escalatedAt: Date | null;
  taskId: string | null; promotionId: string | null; fuseEpisodeId: string | null;
  delivery: { state: 'NOT_REQUIRED' | 'PENDING' | 'QUEUED' | 'DELIVERED' | 'RETURNED';
              sessionId: string | null; at: Date | null };
  actions: Array<'REVIEW' | 'ANSWER' | 'OPEN' | 'OPEN_COORDINATOR' | 'OPEN_TASK_SESSION'
               | 'VIEW_LOG' | 'RETRY' | 'CANCEL_TASK' | 'HAND_TO_OWNER' | 'ASK_COORDINATOR_AGAIN' | 'RESUME'>;
}
```

`GET /projects/:id/open-items` 返回 `{ needsYou: OpenItemRow[]; withCoordinator: OpenItemRow[] }`，两组各按 `waitingSince` 升序（效果图 2「oldest first」）。

### 4.9 测试

`src/apiserver/src/projects/project-exception-todos.pg.spec.ts`（判据 8；本任务创建）：

1. `a merge conflict opens one item owned by the coordinator`（经 `recordIntegrationFailure`，不依赖作业表）
2. `a failed combined-tree check opens one item owned by the coordinator`
3. `a FAILED written by runner finalize opens one item`（改动前跑红：finalize 不产生任何事实）
4. `a FAILED written by the reaper opens one item`（改动前跑红）
5. `an EXECUTABLE exit mismatch and a task_update FAILED each open one item`
6. `an item survives unread messages and is delivered after the running turn ends`
7. `an item whose coordinator has ended is reassigned to the owner`
8. `a queued item turn drained by a failed turn is returned, not lost`
9. `the third failure in one successor chain goes straight to the owner`

`src/apiserver/src/projects/exception-escalation.pg.spec.ts`（判据 9）：

1. `an item unhandled for the default two hours escalates to the owner`
2. `a project-specific escalation time is honoured`
3. `escalation writes no conversation_turn, session or wake row`
4. `an item inside its window does not escalate`（阴性对照）
5. `a coordinator that took the item and is still taking turns keeps it past its window`（改动前跑红：时钟只看待办的年龄）
6. `an item never handed to a coordinator stuck in an earlier turn escalates as before, and is then the owner's to close`（阴性对照）
7. `a coordinator conversation that has ended carries nothing, however recently it moved`（阴性对照）
8. `an item whose coordinator went quiet for a full window after taking it escalates, and only its owner is told`（判据 9 的性质，走服务自己的 interval）

外加 `src/apiserver/src/projects/task-failed-open-item-sites.spec.ts`（X 表来源普查）。

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

**R11（轮换不丢）**：协调会话绑定或轮换提交后（X-D4 第 2 条），给新会话投递满足以下任一条件的已答复提问：`blocksTaskIds` 里还有未 DONE / CANCELLED 的任务；或提问会话就是被替换掉的那一代协调会话。投递行唯一键 `(item, session, ANSWER)` 保证每一代只收一次。答复时没有协调会话 → 答复等到下一次绑定再投。

**R12（撤回）**：提问会话调用 `open_item_resolve` 处理自己的提问 → `WITHDRAWN`，卡片消失。

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

**B4（条件消失自动解除）**：`detail.reason ∈ {OUTSIDE_DECLARED_SCOPE, CRITERION_EXEMPTION_ARGUED, ACCEPTANCE_STANDARD_MOVED}`、`subject_type = TASK` 的 OPEN 行，在其任务的回执提交边沿（`MergeReceiptService.deliverProjectFactsAfterCommit`）上，若该任务的任务级落地 ∈ {`ON_INTEGRATION_LINE`, `ON_UPSTREAM`}，以 `resolved_by = AUTO`、`resolution_reason = 'WORK_LANDED'`、`detail.receiptId` 解除。落地前不解除。blocker 任务先于 integrationRef 任务落地时，用 `LEGACY_LANDING_BRANCHES` 判定，§1.4 落地后自动改为按项目分支判定（§9.3）。

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
```

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

**V3（集成线一行）**：`⎇ <ref> · <n> commits ahead of main · synced with main <age> · Integrating <i> · Queued <q> · Merge check ✓ passing | ✕ failing on the branch tip`，右侧 `Integration settings`。`MAIN` 线显示 `main · Integrating <i> · Queued <q> · Merge check …`。数据取 `ProjectIntegrationView`。

**V4（集成设置卡，效果图 6 ③）**：`Tasks land on`（`A project branch` · `project/<name>` / `Directly into main`，锁定后禁用并写明原因）、`Merge check`、`Escalate after`；写入 `PATCH /projects/:id/integration`。

**V5（Open items 卡，效果图 2 ②）**：标题 `Open items`，副标题 `<a> need you · <b> with the coordinator · oldest first`；两组 `Needs you`（琥珀点）与 `With the coordinator`（蓝点）。每行：标题、`detailLine`、负责人（`You` / `Coordinator`）、`waiting <age>` 或 `<age> · goes to you in <remaining>`、主按钮（`Review` / `Answer` / `Open` / `Open coordinator` / `View log`）。暂停卡置顶（效果图 6 ①）。组件 `ProjectProgressStatus.tsx` 导出 `ProjectOpenItems`。

**V6（Work overview，效果图 2 ④）**：`readProjectPanorama` 的桶增加 `integrating`、`onIntegrationLine`、`onUpstream`、`doneNotIntegrated`、`waitingForLanding`，满足 `done = integrating + onIntegrationLine + onUpstream + doneNotIntegrated`、`waitingForLanding ⊆ blocked`。格子：

| 格 | 数 | 脚注 |
|---|---|---|
| Running | `running` | active sessions |
| Ready | `ready` | can start now |
| Waiting | `blocked` | `for a prerequisite to land`（`waitingForLanding > 0`）/ `waiting on dependencies` |
| ⟳ Integrating | `integrating`（DONE 代码任务，最新作业 QUEUED / RUNNING 或有 OPEN 集成类待办；MAIN 线含等待晋升确认） | checks running on the combined tree |
| ⎇ On project branch | `onIntegrationLine`（`MAIN` 线不显示） | not on main yet |
| ✓ On main | `onUpstream` | landed on main |

`doneNotIntegrated`（非代码任务、未开始集成项目的 DONE）、`failed`、`cancelled`、`awaitingVerification` 非零时才显示为附加格（附录 A-Q19）。

**V7（协调会话卡，效果图 2 ③）**：新增两行，组件 `ProjectProgressStatus.tsx` 导出 `CoordinatorProgressRows`，由 `ProjectCoordinatorCard` 渲染：

- `Wake-ups`：`delivered · last <age>` / `queued · <age>` / `returned · <age>`（琥珀）/ `none yet`。来源：发往当前协调会话的最近一条平台投递（`project_open_item_delivery` 与 `project_coordinator_wake.status = DELIVERED` 取较新者），送达看 `conversation_turn.delivered_at`。
- `Self-started today`：`<selfStartedTurns> of <limit>` + 进度条，取 `assessSpend` 的 `spend.selfStartedTurns` 与 `limits`；暂停时显示 `paused`。

**V8（Automatic 说明文案）**：`PROJECT_BRANCH`：`Tasks land on <ref> by themselves and start once their prerequisites land. It also merges <ref> into main by itself when the checks pass cleanly, and leaves you a receipt with the commit to revert.`（修订 3：原句 `Merging into main always asks you.` 对 `PROJECT_BRANCH` 已不成立，留着它就是在没告知的情况下扩大授权范围）；`MAIN`：`Tasks are checked on main by themselves and start once their prerequisites land. Merging into main always asks you.`（不变）；未决定：现有文案后加 `If its work lands on a branch of its own, it also merges that branch into main by itself when the checks pass cleanly.`

**V9（状态接口）**：`GET /projects/:id/coordinator/status` 的 `coordination` 增加 `wakeups: { state: 'DELIVERED' | 'QUEUED' | 'RETURNED' | 'NONE'; at: Date | null }` 与 `fuse: { selfStartedToday: number; limit: number; paused: boolean; episodeId: string | null }`，并写进 `docs/project-coordinator-status-contract.md` 的字段表。

### 7.3 任务行的集成三段（效果图 3 ①②③）

**V10**：`ProjectTask`（`taskPage`）增加 `integration: TaskIntegrationView`（§2.7）与 `landingWaitCount: number`。分组（`projectTaskGroups`）：

| 分组 | 成员 | 行内 tag |
|---|---|---|
| `Integrating · checks run on the combined tree` | `QUEUED` / `RUNNING` / `CONFLICT` / `CHECK_FAILED` / `ERROR` / `AWAITING_OWNER` | `Queued for integration`；`Integrating · checks <age>`；`Conflict · coordinator`；`Checks failed · coordinator`；`Integration error · coordinator`（负责人为 owner 时写 `· you`）；`Awaiting your approval` |
| `Waiting · for a prerequisite to land` | 依赖未满足且 `landingWaitCount > 0` | `Waits for <n> task(s) to land` |
| `Landed` | `ON_INTEGRATION_LINE` / `ON_UPSTREAM` | `On <ref>`（绿）；`On main`（实心绿，整行淡出） |

其余分组（Running、Ready、Blocked、Done / Cancelled）不变；不适用集成的 DONE 仍在 `Done / Cancelled`。

### 7.4 判据的落地说明（效果图 3 ④）

**V11**：`ProjectAcceptanceCard.tsx` 的 `LANDING` 映射：`LANDED` → `on main`（原 `landed on the default branch`）；`ON_INTEGRATION_LINE` → `on <ref> · not on main yet`（`not on main yet` 用 warn 色）；`UNKNOWN` → `no merge receipt either way`（不变）。仍只在 satisfied 时显示。

### 7.5 卡片（效果图 4、5、6）

会话页卡片区（`WorkspaceView` 的 `<Transcript>` 之后）按既有模式挂 `Session*Card({ projectId })`，React key 带前缀，查询 `['project', id, …]`，每 20 秒轮询，只在项目协调会话里渲染。项目页 Open items 的 `Review` / `Answer` 展开同一组件。

**卡片区只放"现在为真"的东西**（2026-09-21）：已经发生的合入是**记录**，画在它发生的那一刻（§3.6 的 `merged` + `ProjectPromotionReceipt`），卡片区那一张传 `drawMergedRecord={false}` 不再画它——留在卡片区的记录会压在之后每条消息下面直到项目结束，而下一个候选出现时，同一张卡会改口说另一次合入。另外四条回执（criteria / evidence / owner / settlement）已经按同一条规则落位。

| 组件 | 负责任务 | 状态与文案（英文，取自效果图） |
|---|---|---|
| `ProjectPromotionCard` | 确认卡 | A `Merge <ref> into main?`：Branch / Tasks / Checks / main / Criteria / Lands 六行，按钮 `Merge to main`、`Not now`、`View changes · <n> files`，脚注 `asked <age> ago`；B `Merging <ref> into main…`：Status `main moved <n> commit(s) since the check — re-checking the combined tree (<elapsed> of ~<typical>)`，You `nothing to do — it lands on its own if the re-check passes, and comes back here if it doesn't`，按钮 `Merging…`（禁用）、`Cancel`；C `✓ Merged into main`：Commit / Now on main / Next；D `<ref> can't merge into main yet`：Why / Who / Then，按钮 `Merge to main`（禁用）、`Open coordinator` |
| `OpenItemCard` | Open items 卡 | 冲突 `Merge conflict — needs a fix on the task branch`（Task / Into / Files / After a fix；`Open task session`、`Hand to owner`）；检查失败 `Checks failed on the combined tree`（Task / Check / 日志尾 / Branch；`Open task session`、`View full log`）；任务失败 `Task failed`（Task / How / Retries；`Retry`、`Open session`、`Cancel task`）；每张底部 `Owner: <coordinator 或 you> · waiting <age> · goes to the owner at <escalation>` |
| `EscalatedItemCard` | Open items 卡 | `Now yours — no one acted on this for <duration>`（What / Coordinator / Waiting on it；`Ask the coordinator again`、`Open task session`、`Cancel task`）；`COORDINATOR_ENDED`、`CHAIN_LIMIT`、`HANDED_OVER` 各有对应标题 |
| `CoordinatorQuestionCard` | ask_owner | `The coordinator has a question`（provenance `FROM COORDINATOR`）：问题正文、选项单选与 `Recommended`、`Blocks: … · If you don't answer: …`，按钮 `Send answer`，脚注 `asked <age> ago`；答复后 `✓ Answered · <answer>`，脚注 `by you <age> · delivered to the current coordinator (<nth> of this project)` |
| `FusePauseCard` | 暂停卡 | `The coordinator paused itself`：Why / Spent today / Still running / On hold；按钮 `Resume`、`Raise today's limit…`、`See the <n> turns` |
| `ProjectBlockers` | blocker | 效果图 6 ②：每行 tag + 标题 + 说明 + 路径 + `since <age>` + `Resolve…`；底部 `▸ <n> resolved · latest: <reason>`；弹窗 `Resolve this blocker` / `Why is it no longer blocking?` / `Recorded with your name and this reason` |
| 决定卡回执行 | 提案回复 | R6 |

### 7.6 iOS 横幅、推送与 macOS 计数（效果图 1 下半）

**V12（四类推送）**：`PushService.notifyOwnerItem(item)`，只在四类 owner 待办产生或负责人变为 OWNER 时调用，全部在事务提交后：

| kind | 触发 | 标题 | 正文 |
|---|---|---|---|
| `approve-merge-to-main` | M-T2 | `Merge <ref> into main?` | `<n> tasks passed checks on the combined tree · <project>` |
| `coordinator-question` | R9 | `The coordinator has a question` | `<question> · <project>` |
| `escalated-to-you` | X-E1、X-C3、X-D5、X-D6、交给 owner | `Now yours — no one acted on this for <duration>`（按 `assignee_reason` 变化） | `<item title> · <project>` |
| `fuse-paused` | F-T1 | `The coordinator paused itself` | `<why> · <project>` |

载荷：`category: 'ORBIT_OWNER_ITEM'`、`kind`、`sessionID`（项目协调会话，客户端据此打开会话里的同一张卡）、`projectID`、`openItemID`、`thread-id: projectID`、`apns-collapse-id: owner-item-<itemId>`。协调会话自己能处理的例外（负责人仍是 COORDINATOR）不推送（owner 决定 7）。

**V13（Needs-you）**：`owner-decision-signal.ts` 的计数加上负责人为 OWNER 的 OPEN 待办（按项目协调会话归集），于是会话列表的 `pendingApprovals` 与 macOS 菜单栏 `need you` 计数都包含四类（判据 13）。会话摘要增加 `ownerItems: Array<{ kind, title, since }>`，OrbitKit `NeedsYouLogic.banner` 按最早等待取一条，横幅文案 `Approve merge to main · <project>` / `Question from coordinator · <project>` / `Escalated to you · <project>` / `Paused · <project>`。`PushService.needsYouSessions`（APNs 角标）同样计入四类。

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
| 项目详情读 | `project-get-query-count.pg.spec.ts`（17 条） | §1.4 的一条代码库读 → 18；其余新数据走新接口 |
| 满足度模块引用者 | `project-criterion-satisfaction.pg.spec.ts`（只许 8 个文件提到它） | 新文件不 import 它；晋升卡的「n of m met」在客户端计算 |
| `COORDINATOR_WAKE_EVENTS` 闭集 | `coordinator-wake.spec.ts`（钉 0250 / 0243 为最新）、`coordinator-disabled-negatives.spec.ts`（`WIRED` 生产者清单与关闭开关对照）、`completion-input.spec.ts`、`project-criterion-declaration-staleness.pg.spec.ts` | 不加事件则不动；新增对既有事实构造函数的调用点要进 `WIRED` 并补关闭对照 |
| wake 处置 | `wake-disposition.spec.ts`（STRANDED 对所有事件开判断） | C4 改动 `ATTEMPT_ENDED_UNSETTLED` 的处置，按新规则重述该 spec |
| blocker kind 闭集 | `project-source-contract.spec.ts`（SR50 / SR51）、`blocker-signal-exit-inventory.spec.ts` | 不加 kind；待办种类不用 `*_BLOCKER_KIND` / `*_SIGNAL_*` 命名。若扫描器把 `project_open_item_kind_chk` 算进去，逐项登记 `resolveWhen`（≥ 60 字符） |
| 回执写入方 | `contracts/outcome-reconciler-v2-source-audit.json` 的 `MERGE_RECEIPT`（`test/outcome-reconciler-v2.contract.test.mjs` 核对符号存在） | 既有符号不改名；新增 `fromIntegrationJob` 条目 |
| runner 协议 | `contracts/runner-write-protocol.json` 的 SHA 钉在 `src/runner-go/protocol_contract.go` 与 `src/apiserver/src/runner-api/runner-write-protocol.ts`（`protocol_contract_test.go`、`runner-write-protocol.spec.ts`） | 加路由后同步两处 SHA |
| MCP 工具 | `src/runner-go/cli_mcp_parity_test.go`、`mcp_test.go` | `integration_retry`、`open_item_*`、`ask_owner` 登记 CLI 能力或豁免 |
| 推送与 Needs-you | `push/judgment-delivery-removal.spec.ts`（PushModule providers 恰为 `[PushService]`，无时钟）、`push.service.spec.ts`（类别字面量、`needsYouSessions` 过滤条件）、`badge-diff.spec.ts`、`sessions/workspace-session-counts.spec.ts`、`sessions/needs-you-owner-decision.pg.spec.ts`；Swift `Phase3LogicTests.swift`、`NeedsYouLogicTests.swift`、`NeedsYouOwnerDecisionTests.swift` | 只在 `PushService` 里加方法；更新类别与计数断言 |
| attention | `projectAttention.test.ts`（六个分区）、`project-list-attention.spec.ts`（汇总形状）、源审计 `PROJECT_ATTENTION` 符号 | 分区不变；形状断言追加新字段 |
| 项目页 web 测试 | `ProjectsPage.test.tsx`、`ProjectAcceptanceCard.test.tsx`（落地文案）、`ProjectPanoramaHeader.test.tsx`、`WorkOverviewReadiness.acceptance.test.tsx`、`ProjectCoordinatorCard.test.tsx`（Automatic 文案） | 随文案与桶的改动更新 |
| 时钟禁令 | `coordinator-wake.spec.ts`、`coordinator-judgment-opening.spec.ts`、`completion-input.spec.ts`、`attempt-budget-meter.spec.ts`、`project-acceptance-judgment-removal.spec.ts`、`outcome-reconciler/` 下钉 0224 那次自动派发义务移除的普查（`tasks.service.ts` 至多一个 `setInterval`；它自己逐行扫全仓找禁词，所以这里不逐字写它的文件名）、`test/compose-topology.test.mjs`、`judgment-removal-net-subtraction.spec.ts` | 升级时钟放新文件 `open-item-escalation.service.ts`（X-E1） |
| 名字黑名单 | `project-acceptance-judgment-removal.spec.ts`（`REMOVED_NAMES`）、`project-done-gate.pg.spec.ts`、`project_acceptance_` 前缀的七个普查、`task-judgment-removal.pg.spec.ts`（关系名含 `judgment`） | 避开 |

### 8.4 Legacy 分流

| # | 条件 | 行为 |
|---|---|---|
| C1 | 项目没有代码库行 | 落地判定用 `LEGACY_LANDING_BRANCHES`；`CriterionLanding` 只会是 `LANDED` / `UNKNOWN`，与今天一致 |
| C2 | `lineStarted` 为假 | J9 退化为今天的「只认 DONE」 |
| C3 | `lineStarted` 为真 | `CriterionUnlandedProducer.factsFor` 不再为该项目派生 `CRITERION_UNLANDED`：合并由平台负责，失败走待办 |
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

## 附录 A　待 owner 裁决的问题

每条：默认做法 / 一句话推翻方式。未裁决前按默认做法实现。

| # | 问题 | 默认做法 | 可推翻为 |
|---|---|---|---|
| Q1 | 项目分支叫什么 | `project/<projectPublicId>`，锁定前可在设置里改名 | 按项目标题生成 ASCII slug（`project/bg-jobs`），标题无法生成时回退 publicId |
| Q2 | workspace 没有远端时怎么办 | 拒绝集成，生成 `INTEGRATION_ERROR / INTEGRATION_REPOSITORY_UNKNOWN` 待办 | 允许 `RUNNER_LOCAL` 权威，绑定到该 workspace 的 runner |
| Q3 | 开始集成后能否换线 | v1 不能；要换，先合入 main 或放弃当前项目分支（owner 手工处理） | v1 就提供「放弃项目分支并解锁」的 owner 操作 |
| Q4 | upstream 是否自动探测 | 不探测，默认 `refs/heads/main`，找不到就报错 | 第一条作业时由 runner 读远端 HEAD 并记录 |
| Q5 | 推送时目标被别人推进 | 同一作业内最多再做 2 轮 fetch → rebase → 检查，之后 `ERROR / TARGET_MOVED` | 0 轮，立刻生成待办 |
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

## 附录 B　修订记录

- **v1 草案**（2026-09-13）：首版。九节：集成线、集成作业、main 同步与合入 main、例外待办、阻塞请求的回复、保险丝与 blocker、读模型、迁移与兼容、任务对照；附录 A 列 20 个待定问题与默认做法。
- **v1 修订 1**（2026-09-21）：§2.4 增「检查前的铺环境」（J-S5 与 M-S3 跑检查前，先在组合树里运行仓库自带的 `scripts/worktree-overlay.sh`），J12 增 `CHECK_TREE_UNPREPARED`。缘由：2026-09-21 集成线第一次在真实运行中跑起来时，一条验收命令为 `cd src/web && npx vitest run …` 的任务被判 `CHECK_FAILED`——组合树是纯 git 树，没有 `node_modules`，命令死在 `Cannot find package '@vitejs/plugin-react'`，与实现无关。选「组合树应当被铺好」而不是「验收命令必须自包含」：后者要判的是命令的形状，而形状不是错——同一条命令在会话 worktree（已铺 overlay）里是通过的，判据 6 要的是同一条命令在同一种树上得到同一个判决；把约束改写成「作者必须自带铺设」还会让今天所有以前端命令声明的任务追溯性地作废，而作者写的命令在别处是正确的。铺环境写在平台一侧只有一处，且不动「落地的树 = 测过的树」的判定（`node_modules`/`dist` 均 gitignored，不进 `C^{tree}`，也不出现在 J-S6a 的 `git status --porcelain --untracked-files=no` 里）。
- **v1 修订 2**（2026-09-22）：明确一条边界——`coordinator_enabled` 只约束**自动**交付（生产者唤醒、平台自动把待办投递给协调会话），不约束 **owner 自己按下的那一次**。§4.7 的「让协调会话再看一次」与 §4.4 第 1 条的 `askable` 都改按**会话**判（存在活着的协调会话即可），计数那条读也去掉 `coordinatorEnabled: true`。缘由：2026-09-22 owner 报一个「标准集确认过、却从未启动」的项目（`coordinator_enabled=false`、`config_revision=0`）——它的 3 条异常卡画在协调会话里，而会话列表行、标题栏、needs-you 条三处全暗，因为计数比「卡片画在哪」多写了一句开关判据：**同一个事实两条判据**，指向的正是当初把开关写进判据的理由（「点了打不开东西的 badge 比暗的更糟」）的反面。同族的第二处：卡片上的「Ask the coordinator again」被同一条开关判据藏起来，而真按下去也会在 `deliver` 那一行被弹回 owner（`handToOwner(NO_COORDINATOR)`），转一圈回到原处。选择把开关收窄成「别自行动手」而不是「人也叫不动」：自动那一半一字未动（四个 wake producer 与 `coordinator-disabled-negatives.spec.ts` 照旧成立），只有 owner 自己那一次按压走 `deliver(itemId, 'OWNER')`。F12 的「开关检查保留」说的是生产者那一族，未受影响。
- **v1 修订 3**（2026-09-23）：G5 对 `COORDINATOR_WAKE_EVENTS` 开一处例外，增 `DEPENDENT_READY`（迁移 0299）。一条前置落地（§2.5 J9 的谓词，在 J10 的两条边沿上：回执提交，以及没有要落地的代码时的 DONE）放出一条 `autoRunWhenReady = false`、当前可开工的下游时，平台把「它可以开工了」送到协调会话并点名那条下游；开不开工是会话的判断（§0.1），平台不开。缘由：2026-09-23 项目 `34Tcl0kralZrY8opuLJU4` 的最后一条任务前置已落地、协调会话醒着，却没有任何事实因为它可开工而到达，项目停了两个多小时，直到有人去看——目标里点名的不送达事件之一（依赖就绪但 autoRun=false）。不放新表，因为它不是例外待办：没有异常要处理、没有终态要记，要的只是送到一次。载体是 G6（`CoordinatorDeliveryService.queue`：`createTurn` + `NEXT_TURN`，`participateSendTransaction` 里重读会话未结束并把唤醒行绑成 DELIVERED），不走 `resume`（X-D3）；幂等键复用唤醒账本的（事件，下游任务，`task_dispatch_epoch`），同一代只投一次。会话忙时排在未读消息之后；会话已结束或项目没有协调会话时拒绝并交还键，不复活会话，下游留在 owner 的 Ready-to-run 列表上（默认做法；要推给 owner 就改成 OWNER 待办）。此前 0298 已为 `TASK_DISPATCH_REFUSED` 在这个闭集里加过一次。
- **v1 修订 4**（2026-09-23）：M7 放开一处——项目分支 + Automatic + 检查干净 → 平台自行合入 main（新增 M-T11、M-T12，迁移 0301 的 `confirmed_automatically` 两列，runner 能力 `promotion-automatic-land/v1`，§3.6 `merged.automatic` / `merged.revert`，V8 文案）。缘由：owner 2026-09-23 的决定「有自己的项目集成分支 + automatic 就可以合并；如果是 main 或非 automatic，就需要人来点」；线上实测两个项目（一个 30 小时 15 张、一个 6 小时 6 张）的 21 张晋升卡里 20 张在几分钟内被按下，按已经不是决策而是形式。边界：项目分支是已过线检查的暂存区（干净），Automatic 是 owner 已给过的授权（可以自己动），两者都在才不越权；「干净」一字不放宽——检查红、有冲突、main 在检查后前进、有 OPEN 集成类待办，任一即出卡，main 前进由 runner 在推送前判（只落到 `upstream_sha_checked`，动了就原样交回），声明不了这一点的旧 runner 不参与自动落地；授权在领取时重读一次，检查之后被收回（Automatic 关、线改、新开集成类待办）的落地不下发、交回 owner。代价：`coordinator_enabled` 从此同时是「自动交付例外」与「自动合入 main」的授权，为前者打开的项目会顺带得到后者；不另加开关（owner 明确选择复用 Automatic），改为在该列注释与 Automatic 文案里写明。部署顺序：apiserver 先上即安全——没声明 `promotion-automatic-land/v1` 的 runner 一律出卡，与今天一致；runner 升版（root `package.json` 版本号 bump、自更新）之后，自动合入才对该 runner 上的项目生效。
- **v1 修订 5**（2026-09-23）：G5 对 `COORDINATOR_WAKE_EVENTS` 再开一处例外，增 `PROJECT_SETTLED_UNMERGED`（迁移 0303）。结算后的项目，若它的集成线上仍有成果没有任何回执说到 upstream，平台把「这些提交停在集成线上、没进 main」送到协调会话并点名提交（`detail.commits`）；合并由谁做是会话/owner 的判断（M7），平台不合、不排候选、也不改任何守卫。缘由：2026-09-23 项目 `34ODoUKJGEsfbgcJDGS4q` 已 DONE，而 `d6b55d2d853f8b2410977674e3ec54c39f52a34e` 停在 `project/34ODoUKJGEsfbgcJDGS4q` 上、比 main 多一个提交：承载它的落地作业在会话写下这个提交之前九分钟就已终态 `ALREADY_LANDED`（§2.2 J-T5 的那条答案是「分支上已经没有 line 没见过的提交」，而会话后来又提交了一次），于是没有任何一次「队列变短了」来为这个 tip 排候选（M-F1/M-F4），而结算之后连会重新读这条线的写入也停了——它最终由人手工重放进 main。不放新表，因为它不是例外待办：没有失败要处理、没有终态要记，要的只是送到一次。载体是 G6（`CoordinatorDeliveryService.deliver` → `sessions.resume`，`createTurn`），不走 `WakeDispositionService`（那条规则读的是一条验收标准的覆盖度，而结算要求每条标准都已 LANDED，没有标准可读）；幂等键是（事件，项目，`(taskId, tipSha)` 对的摘要），同一批残留只投一次、残留移动一次就再投一次。读的是 `project-criterion-landing.ts` 自己的两个折叠（`taskLanding` 与 `taskHasNothingToLand`）而不是第二份「线上的、不在 main 上的」判断；只在**已结算**的项目上读，所以线上有活而项目还开着的常态不会产生任何东西。此前 0298 为 `TASK_DISPATCH_REFUSED`、0299 为 `DEPENDENT_READY` 已各加过一次。
