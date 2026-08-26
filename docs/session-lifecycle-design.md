# Session 运行结果与 Completed 生命周期模型

## 1. 问题

旧模型把运行结果、列表位置和 Archive 术语混在一起:

- `SUCCEEDED` 容易被理解成“已经进入 Completed”;
- 产品展示 Completed,协议和代码却仍以 `ARCHIVED / archivedAt / canArchive` 为主;
- runner 的旧 `POST /runner/sessions/:id/complete` 又表示“上报进程已经结束”,与用户点击
  Complete 的含义不同。

新模型把运行结果与 Session 生命周期拆成两个正交维度,并让 Completed 成为代码、API
和产品的主语义。Archive 只在滚动升级兼容层中出现。

## 2. 三个独立维度

### 2.1 `runState`

`runState` 只描述运行态或运行结果:

| 值 | 含义 | 终态 |
|---|---|---|
| `QUEUED` | 等待 runner slot | 否 |
| `RUNNING` | 正在执行 | 否 |
| `AWAITING_INPUT` | 进程存活,等待人类输入 | 否 |
| `INTERRUPTED` | 当前 turn 被中断,Session 仍存活、仍可调度 | 否 |
| `SUCCEEDED` | 运行成功 | 是 |
| `FAILED` | 运行失败 | 是 |
| `ENDED` | **唯一的中性终态**:运行停下来了,但没有成功/失败判定 | 是 |

**中性终态只有一个。** 早期的 `CANCELLED / DORMANT / ENDED` 三件套其实是
`(RunStatus, endReason)` 的排列,而没有任何行为区分它们 —— 能否继续由
`deriveSessionCapabilities` 决定,它从不读 `endReason`。于是三个图标、三种文案在描述一个
服务端并不存在的差别。**"是哪个动作结束了这次运行"不是运行结果**:用户归档的 Session 已经
由 `lifecycleState=COMPLETED` 标识,其余属于叙述,不属于状态词表。所以现在:用户结束、用户
停止、Complete、删除、task 驱动结束、以及历史遗留/未知 `endReason`,全部落到 `ENDED`
(三端统一显示 "Ended",中性灰)。

裸 `INTERRUPTED`(没有 `endReason`)表示"用户停了一个 turn",Session 本身仍然活着;一旦记录
了任何 `endReason`,就表示 Session 本身被结束,落 `ENDED`。判定见
`deriveSessionRunState`(`src/shared/src/enums.ts`),Swift 侧对称实现在
`SessionRunState.resolve`(`OrbitKit/Models/Enums.swift`)。

`endReason` 仍然保留,并且是"为什么结束"的真相源(`task_done` / `task_cancelled` / `ended` /
`completed` / `deleted` / `cancelled`),只是不再参与派生运行状态;`idle` / `orphaned` 是
PARKED 时代的遗留值,已无写入方,仅保证旧数据可解码(`LEGACY_END_REASONS`)。

Complete、Move to Open 或 Move to Trash 都不得重写已经形成的运行结果。尤其不能把
`SUCCEEDED` 改名为 `COMPLETED`:前者是运行结果,后者是用户选择的列表位置。

### 2.2 `lifecycleState`

`lifecycleState` 是列表归属的唯一真值:

| 值 | 列表 | Canonical 存储来源 |
|---|---|---|
| `OPEN` | Open | `completedAt == null && deletedAt == null` |
| `COMPLETED` | Completed | `completedAt != null && deletedAt == null` |
| `TRASH` | Trash | `deletedAt != null` |

`deletedAt` 优先级高于 `completedAt`,因此一条曾经 Completed 的记录移入 Trash 后仍只
属于 Trash。`filingState=ARCHIVED` 是旧客户端兼容别名,不能再作为新代码的内部模型。

### 2.3 Task state

Task 的 `OPEN / IN_PROGRESS / DONE / CANCELLED / FAILED` 既不是 Session 的
`lifecycleState`,也不应在客户端覆盖 Session 的运行结果。两者只在 reaper 收口处有明确
映射:

- Task `DONE` → `endReason=task_done` → Session `runState=SUCCEEDED`,并自动进入 Completed;
- Task `CANCELLED` → `endReason=task_cancelled` → Session `runState=ENDED`(中性终态,
  `endReason` 保留取消原因)。

## 3. 产品规则

1. 普通 Session 运行成功不会自动 Complete,`Succeeded · Open` 是正常状态;任务执行 Session
   在对应 Task 进入 `DONE` 后自动进入 Completed。
2. `Complete` 将 `lifecycleState` 改为 `COMPLETED`;若运行仍活跃,服务端同时结束当前运行。
3. `Complete` 不弹二次确认,活跃、排队和终态 Session 使用同一个直接动作。
4. Completed 中发送新消息会恢复原 Session,并自动移回 Open;客户端必须事先说明。
5. Trash 中禁止直接发送或恢复运行,必须先 `Move to Open`。
6. `Move to Open` 只清除 `completedAt / deletedAt`,不伪造新的运行结果。
7. Header 同时显示两个维度,例如 `Succeeded · Open · 3m ago`。

## 4. Canonical API 与 capability

Session payload 的主字段是:

```ts
interface SessionSummary {
  runState: SessionRunState;
  lifecycleState: 'OPEN' | 'COMPLETED' | 'TRASH';
  completedAt: string | null;
  deletedAt: string | null;
  capabilities: SessionCapabilities;
}

interface SessionCapabilities {
  canSend: boolean;
  canResume: boolean;
  resumeBlockedReason:
    | 'TRASHED' | 'ENDING' | 'NOT_TERMINAL' | 'NOT_STARTED'
    | 'MISSING_CONTEXT' | 'NO_RUNNER' | 'RUNNER_OFFLINE' | null;
  canComplete: boolean;
  canRestore: boolean;
}
```

`runState` 不能单独回答“现在能否继续”。例如 Complete 请求已经提交但 runner 尚未回执
时,底层运行状态仍可能是 `RUNNING`,但新 turn 已经应被拒绝。`canResume` 与
`POST /resume` 必须复用同一个服务端判定函数:终态、非 Trash、没有正在结束、已建立可
恢复上下文、有 assigned runner,且 runner 心跳在在线窗口内。

Canonical 客户端接口:

- `GET /sessions?view=open|completed|trash`;
- `POST /sessions/:id/complete`;
- `POST /sessions/:id/restore`(Move to Open);
- `DELETE /sessions/:id`(Move to Trash)。

Runner 有三个刻意不同的接口:

- `POST /runner/sessions/:id/complete-session`:编排器执行用户语义的 Complete,把目标
  Session 移入 Completed;
- `DELETE /runner/sessions/:id`:编排器执行 Move to Trash,保留数据以便用户恢复;永久
  purge 不向 agent 开放;
- `POST /runner/sessions/:id/finalize`:runner 数据面上报当前进程的终态和统计数据。
  旧 `/complete` 仅作为 runner 滚动升级兼容路由,不表示生命周期迁移。

明确使用 `complete-session` 后缀是为了避免 Nest 控制器路由冲突,也避免 SDK/日志把
“finalize run”和“move Session to Completed”混为一谈。runner-go 内部相应使用
`completeSession` 表达用户动作,使用 `finalizeRun` 表达进程终结。

## 5. 原子性与竞态

Complete/Move to Trash 对活跃 Session 同时包含“记录结束意图”和“改变列表位置”。这些
写入必须在同一个 Session row lock 事务内完成;只有 commit 后才可通知 runner 或发布
realtime 事件。

- Move to Trash 先获锁后,Complete 必须因已在 Trash 而拒绝;
- Complete 先获锁后,Move to Trash 可继续将 Completed 移入 Trash;
- realtime 中的 `lifecycleState` 必须来自事务提交后的真实状态,不能根据本次请求猜测;
- Restore 和永久删除也必须使用同一个行锁规则,避免删除后的 Session 被并发恢复。

## 6. Expand/contract 迁移

数据库不能在滚动部署中直接把 `archived_at` 原地重命名为 `completed_at`,否则旧服务实例
会立刻失效。迁移分三阶段:

1. **Expand:**新增 nullable `completed_at`;服务端对 Complete/Restore/Trash 双写
   `completed_at` 与 `archived_at`,读取时优先 `completed_at`、回退 `archived_at`。
2. **Backfill:**令历史行 `completed_at = archived_at`,验证新旧字段没有漂移;所有新 payload
   同时返回 canonical 字段和兼容别名。
3. **Contract:**在所有已发布客户端和服务实例都不再依赖旧协议后,单独版本删除
   `archived_at` 与兼容分支。

滚动升级期间仅保留下列单向兼容映射:

| Canonical | Compatibility alias |
|---|---|
| `lifecycleState=OPEN|COMPLETED|TRASH` | `filingState=OPEN|ARCHIVED|TRASH` |
| `completedAt` | `archivedAt` |
| `capabilities.canComplete` | `capabilities.canArchive` |
| `view=open|completed|trash` | `view=active|archived|deleted` |
| `POST /sessions/:id/complete` | `POST /sessions/:id/archive` |
| `POST /runner/sessions/:id/complete-session` | `POST /runner/sessions/:id/archive` |
| `POST /runner/sessions/:id/finalize` | `POST /runner/sessions/:id/complete` |

兼容字段只能由 canonical 状态派生,业务逻辑不得反向以 `ARCHIVED` 为内部主语义。
`status / runStatus / sessionState` 同样暂时保留给旧客户端,但新客户端不得用
`sessionState=COMPLETED` 推断列表归属。

迁移 `0077_task_done_sessions_completed` 会把历史上仍在 Open 的
`task_done + SUCCEEDED` Session 补入 Completed。迁移只依据 Session 自身已经落盘的运行
结果和结束原因,不根据 Task 当前状态推断,因此 Task 后续状态变化不会改写这次执行的归属。
