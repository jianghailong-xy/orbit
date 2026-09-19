# 发消息到「已被接手的旧 run」：路由契约

**状态**：服务端已落地（`SessionsService.resume` + `sessions.controller.ts` + `task-run-receipt.ts`），
本文件是 web 与 macOS 两单接线时的唯一权威。行为由
`src/apiserver/src/sessions/resume-routes-to-current-run.pg.spec.ts`（8 例，真 PostgreSQL）
与 `entry-point-contract.spec.ts` 钉住。

**没有新端点。** 客户端仍然打 `POST /api/sessions/:id/resume`，多了一个可选请求字段和两个新答案。

---

## 0. 这条路以前为什么是错的

`session_task_execution_claim_idx`（0122/0130）让「一个任务同时只有一轮在跑」成为数据库的性质。
一轮失败后平台重派（`rearmEndedAutoRuns`），用户手里那个会话就**不再是任务当前的那一轮**。
他往里发消息 → revive 撞 claim → 409 `TASK_ALREADY_RUNNING`，**消息一个字都没投出去**。

缺的不是文案，是**路由**：平台知道谁持 claim，却只把这件事写成一句英文，没有把消息交过去。

---

## 1. 请求

```jsonc
POST /api/sessions/{sessionId}/resume
{
  "clientTurnId": "<uuid>",          // 幂等键，重试必须原样重发
  "content": "继续干活",
  "provider": "deepseek",            // 可选：用户在 composer 里显式选的 provider
  "stopSessionId": "6vVUlXGyj…"      // 可选：确认「停掉这一轮」，值是下面 confirm.value 原样回传
}
```

- `provider` **省略** = 用户没有明确选 provider。省略和「选了当前这轮正在用的那个」是同一档处理。
- `stopSessionId` 是 **public id**（Base62），服务端自己解码。它不是布尔开关：它点名**被停的那一轮**，
  所以确认与用户当时看到的那一轮绑定；如果 claim 在提问和回答之间换了手，服务端会重新提问而不是
  拿旧确认去停一个用户没看过的 run。

只有**浏览器/客户端这道门**会路由。runner 的 `session send`（`resumeIfEnded`）、auto-retry 补发、
任务派发、coordinator 投递一律保持原来的 409 —— 它们的消息属于它被写下的那段对话，
不该被塞进任务碰巧在跑的那一轮。

---

## 2. 回答有哪几种

### 2.1 投递到当前那一轮（用户没选 provider，或选的就是它）

HTTP 200：

```jsonc
{
  "turnId": "…", "seq": 12, "kind": "message", "placement": "queued",
  "revived": false,
  "routedToSessionId": "6vVUlXGyjjJEQtxymaTkCM"   // ← 新增
}
```

`routedToSessionId` **存在**就说明消息没落在你发的那个会话里，而是落在任务当前那一轮。
客户端要做的两件事：

1. 把用户带过去（`/sessions/{routedToSessionId}`）；
2. 别在原会话里乐观插入这条气泡——它不在那儿。

字段**缺席**表示落在原地（普通 resume），行为与今天一致。

### 2.2 需要确认（用户选了与当前那轮不同的 provider）

HTTP 409：

```jsonc
{
  "statusCode": 409, "error": "Conflict",
  "code": "TASK_RUN_PROVIDER_SWITCH_CONFIRMATION_REQUIRED",
  "confirmationRequired": true,
  "confirm": { "field": "stopSessionId", "value": "6vVUlXGyjjJEQtxymaTkCM" },
  "runningProvider": "claude",
  "requestedProvider": "deepseek",
  "taskId": "5Tkrnx1kbOyLZdlRiVN4Og",
  "conflictingSessionId": "6vVUlXGyjjJEQtxymaTkCM",
  "conflictingSessionStatus": "RUNNING",
  "owner": "USER",
  "requiredAction": "confirm stopping session … and continuing on deepseek",
  "message": "…",
  "retryable": false
}
```

**「需要确认」是字段，不是那句英文。** 客户端读 `confirmationRequired`，把
`runningProvider` / `requestedProvider` 填进自己的中文确认文案，用户点「停止并继续」就
把 `confirm.field` 当键、`confirm.value` 当值加进请求体重发（`clientTurnId` 不变）。

`retryable: false`：原样重发只会再问一遍同一个问题；推进它的是用户的回答。

### 2.3 那一轮正在收尾（同 `TASK_ALREADY_RUNNING`，多一个字段）

HTTP 409，`code: "TASK_ALREADY_RUNNING"`，新增 `conflictingSessionEnding: true`，`retryable: true`。

出现时机有两种，客户端处理一样：
- 用户确认了停止，但那一轮有引擎进程要收尾（`cancel_requested_at` 已写，`status` 还是 RUNNING）；
- 别人停了它。

`conflictingSessionEnding` 之前**只影响那句英文**，客户端读不出来——光看 `conflictingSessionStatus`
是 `RUNNING`，看不出它已经在收。现在是字段。

客户端应当：显示「正在停止…马上继续」，带同一个 `clientTurnId` 隔一两秒重发，直到 200。
消息在客户端手里，没丢。

### 2.4 带附件的消息不路由（仍是 2.3 那个 409）

`attachment` 行按 **sessionId** 锚定（`assertLinkableAttachments`），没法把 A 会话里的图
挂到 B 会话的 turn 上。所以带 `attachmentIds` 的消息**不路由**，照旧答
`TASK_ALREADY_RUNNING`（带 `conflictingSessionId`）。

理由：另外两条路都更差 —— 要么把话投过去、把截图丢掉（用户说的「看这张图」就没了图），
要么撞一句关于附件 id 的 400。结构化拒绝至少点名了该打开哪一轮。

客户端：带附件时按 2.3 的卡片处理（「打开正在跑的那一轮」），用户在那边重发。

### 2.5 跨 runtime（不可确认）

HTTP 400，`a claude session cannot switch to a provider that runs on codex`。

claude ↔ deepseek（配置的 provider 借 claude runtime）是同 runtime，允许；
借 codex/kimi runtime 的 provider 是跨 runtime，**在停任何东西之前**就被拒绝。
客户端不要给这种选择提供确认按钮——确认了也一样是 400。
判定看的是 provider 行的 `runtime` 字段，不是「是不是配置的 provider」。

---

## 3. 三条铁律（客户端也要守）

1. **一个 run 的 provider 在生命周期内固定。** 客户端不要显示/暗示「把正在跑的这轮切到别的 provider」。
   换 provider = 停掉这轮 + 新起一轮。
2. **没有用户明确动作就绝不停掉在跑的那轮。** 不要预先带上 `stopSessionId`，
   不要把确认做成「记住我的选择」。每一次停都要一次确认。
3. **「当前那一轮是谁」问服务端。** `session_get` 带 `taskId`，`task_get` 带该任务全部会话与状态；
   不要用本地缓存的旧状态猜（判据 4 那单尤其要注意：本地还显示 FAILED、服务端已经有新一轮了）。

---

## 4. 服务端锚点

| 事实 | 在哪 |
| --- | --- |
| 路由与几种回答（含附件边界） | `sessions.service.ts#routeOntoTheHeldClaim` |
| 只有人的那道门路由 | `sessions.controller.ts#resume` 的 `routeToCurrentRun: true`；`entry-point-contract.spec.ts` |
| 确认拒绝的形状 | `tasks/task-run-receipt.ts#taskRunProviderSwitchConfirmation` |
| `conflictingSessionEnding` | `tasks/task-run-receipt.ts#taskAlreadyRunning` |
| 响应类型 | `sessions.service.ts` 的 `SessionResumeAnswer` |
| 行为判据 | `sessions/resume-routes-to-current-run.pg.spec.ts` |
