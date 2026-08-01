# Session lifecycle 与归档模型

## 1. 问题

旧模型用一个 `sessionState` 同时表达两件事:

- 这次运行发生了什么;
- 用户把会话放在哪个列表。

因此 `SUCCEEDED` 会被误解为“已进入 Completed”,Archive 也会被误解为
“运行成功”。新模型将它们拆成两个正交维度,Task 状态则继续独立。

## 2. 三个独立维度

### 2.1 `runState`

只描述运行态/结果:

| 值 | 含义 |
|---|---|
| `QUEUED` | 等待 runner slot |
| `RUNNING` | 正在执行 |
| `AWAITING_INPUT` | 进程存活,等待人类输入 |
| `INTERRUPTED` | 当前 turn 被中断,会话仍存活 |
| `SUCCEEDED` | 运行成功 |
| `FAILED` | 运行失败 |
| `CANCELLED` | 运行被取消 |
| `DORMANT` | 优雅结束,仍可能恢复 |
| `ENDED` | 其他非活跃终态 |

Archive、Restore 或 Move to Trash 都不应重写已经形成的运行结果。

### 2.2 `filingState`

只决定会话的列表位置:

| 值 | 列表 | 存储来源 |
|---|---|---|
| `OPEN` | Open | `archivedAt == null && deletedAt == null` |
| `ARCHIVED` | Archived | `archivedAt != null && deletedAt == null` |
| `TRASH` | Trash | `deletedAt != null` |

`deletedAt` 优先级高于 `archivedAt`,因此一条曾经 Archived 的记录移入 Trash 后
仍只属于 Trash。

### 2.3 Task state

Task 的 `OPEN / IN_PROGRESS / DONE / CANCELLED / FAILED` 不是 Session 的列表位置,
也不应在客户端覆盖 Session 的运行结果。两者仅在 reaper 收口处有明确映射:

- Task `DONE` → `endReason=task_done` → Session `SUCCEEDED`;
- Task `CANCELLED` → `endReason=task_cancelled` → Session `CANCELLED`。

## 3. 产品规则

1. 运行成功不会自动归档。`Succeeded · Open` 是正常状态。
2. 终态 Session 的 `Archive` 只改变 `filingState`。
3. 活跃或排队中 Session 的动作显示为 `End & Archive…`,确认后结束运行并归档。
4. Archived 中发送新消息会恢复原 Session,并自动移回 Open;客户端必须事先说明。
5. Trash 中禁止直接发送/恢复运行,必须先 `Restore to Open`。
6. `Move to Open` 只清除归档/删除时间,不伪造新的运行结果。
7. Header 同时显示两个维度,例如 `Succeeded · Open · 3m ago`。

## 4. 服务端 capability

`runState` 不能单独回答“现在能否继续”。例如 Archive 请求已提交但 runner
尚未回执时,底层 status 仍可能是 `RUNNING`,但新 turn 已应被拒绝。因此 Session
payload 可带服务端统一派生的:

```ts
interface SessionCapabilities {
  canSend: boolean;      // 当前能否向这一条 Session 发送/排队/恢复
  canResume: boolean;    // 终态 Session 能否原地恢复上下文
  resumeBlockedReason:
    | 'TRASHED' | 'ENDING' | 'NOT_TERMINAL' | 'NOT_STARTED'
    | 'MISSING_CONTEXT' | 'NO_RUNNER' | 'RUNNER_OFFLINE' | null;
  canArchive: boolean;
  canRestore: boolean;
}
```

`canResume` 与 `POST /resume` 必须使用同一个判定函数:终态、非 Trash、没有正在
结束、已建立可恢复上下文、有 assigned runner,且 runner 心跳在在线窗口内。
新客户端优先消费 capability;字段缺失时才使用旧的本地推断。

## 5. 原子性与竞态

Archive/Delete 对活跃 Session 同时包含“记录结束意图”和“改变列表位置”。
这些写入必须在同一个 Session row lock 事务内完成;只有 commit 后才可通知 runner
或发 realtime 事件。

- Delete 先获锁后,Archive 必须因已在 Trash 而拒绝;
- Archive 先获锁后,Delete 可继续将 Archived 移入 Trash;
- realtime 中的 `filingState` 从事务后真实状态产生,不能只根据请求动作猜测。

## 6. 线上兼容

存储层继续使用 `status / endReason / archivedAt / deletedAt`;`runState` 和
`filingState` 在 API 边界统一派生,不需要新数据列。`status`、`runStatus`、
`sessionState` 在滚动升级期间保留,但新 UI 不得再用 `sessionState=COMPLETED`
推断归档位置。查询参数中的 `active / archived / deleted` 也作为兼容协议保留,
客户端展示名称则为 Open / Archived / Trash。

历史上已经写错的 `task_done + SUCCEEDED` 记录不自动批量回填。Task 可能在
Session 真实成功后又被取消,仅根据当前 Task 状态回写会误伤历史;需要结合时间线
单独审计或定点修复。
