# 会话间消息：发送者署名与「请求 → 回复」

**状态**：设计已定（2026-10-01，owner 的三项决定见 §9），实现进度见对应的 Orbit 任务。分两期：**P0 署名**、**P1 请求与回复**，P1 依赖 P0。
两期实现以本文为准；实现中要偏离本文，先改本文。

---

## 0. 为什么要做

今天会话之间只能单向说话：

1. **消息没有发送者。** `session_send`（`src/apiserver/src/runner-api/runner-sessions.controller.ts#sendMessage`）
   与 `project_send`（`src/apiserver/src/projects/projects.service.ts#sendToCoordinator`）写进对方会话的 turn
   都只有 `{ clientTurnId, content }`，而 `conversation_turn.content` 的定义是 "user message text"。接收方模型把另一个
   agent 的话当成 owner 说的；coordinator 分不出是哪个 worker 在说话；客户端没有数据可区分，只能画成 owner 的气泡。
2. **回执不是回复。** `session_send` 只回 `placement`（steer / accepted / queued）。
3. **回复只能靠拉，而且拉不准。** `session_await` 的唤醒载荷按白名单脱敏，不含正文（`docs/watch-contract.md` §7），
   只能再 `session_get` 读 `lastAssistantText`。那是对方的最后一句，不一定在回答你；消息落成 `steer` 时，
   答复和正在跑的那一轮混在一起。
4. **反向没有地址。** 接收方不知道是谁发的；两边互相 `session_await` 会被 `WAKE_LOOP` 拒绝。

平台在「回复」上已经付过一次学费：2026-09-13 一个会话等了 7 小时，而答案早就给出了
（`src/apiserver/src/projects/criteria-decision-reply.ts` §0）。那次定下的规则是：回复送回提问的会话、只送一次、
不为送回复去复活会话。本文把它推广到所有会话间消息。

---

## 1. 术语

- **会话间消息**：调用方是一个会话（请求带 `X-Orbit-Session-Id`），目标是另一个会话。入口有三个：
  `session_send`（`POST /runner/sessions/:id/turns`）、`project_send`
  （`POST /runner/projects/:id/coordinator/messages`，目标在投递时解析），以及 `session_interrupt` 附带的消息
  （`POST /runner/sessions/:id/interrupt` 带 `message`）。人从客户端发的、headless 凭据发的、
  平台自己投递的（watch 唤醒、open item、criteria 回复……）都**不是**会话间消息，本文不改它们。
- **请求**：带 `expectReply: true` 的会话间消息。
- **结局**：请求的终态，五种之一（§4）。
- **回信 turn**：平台为把结局交给发送方，在发送方会话里排的 turn。

---

## 2. P0：每条会话间消息都带发送者

### 2.1 记录

`conversation_turn` 新增可空列 `sender_session_id`。§1 的三个入口写 turn 时填调用方会话，其他入口一律留空。
空值就是今天的语义：人或平台写的。

例外只有一个：自动重试（`src/apiserver/src/sessions/auto-retry.service.ts`）重发上一条消息时，新 turn 沿用原 turn 的
`sender_session_id`。重发的还是那个会话的话，丢了署名，对方就会把它当成 owner 说的。这是平台的重发，不计入 §2.4 的上限。
重发的如果是一条请求（§3），请求随之挪到新 turn（`session_request` 改指向新 turn），对方看到的块和卡片带上请求号。

失败卡片上的手动 Retry 也一样：要重发的如果是会话间消息，客户端改为请服务端重发，带上原发送者和原请求，不经过 owner
自己的发送入口，也不计入 §2.4 的上限。经 owner 的发送入口重发，就会以 owner 的名义、不带署名地再说一遍。

### 2.2 引擎看到什么

投递时在正文**之后**追加一个块，与 `<background-jobs>`、`<orbit_wiki_context>` 走同一段代码
（`src/apiserver/src/runner-api/runner-api.controller.ts` 收件箱投递处，`appendBackgroundJobsContext` /
`appendWikiContext`）：

```
<orbit-session-message from-session="<publicId>" from-title="…" from-agent="…" task="<publicId>">
这条消息来自另一个 Orbit 会话，不是账号 owner 本人。
</orbit-session-message>
```

发送方没有任务时省略 `task`。请求在块里多几行，见 §3.3。

块必须放在正文之后：`controlPlaneNoteOf` 靠「回显以作者原文开头」切出平台追加的部分
（`src/apiserver/src/runner-api/control-plane-note.ts`）。放在前面会让切分失效，块就会被记成发送者的原话。

### 2.3 客户端看到什么

事件入库时，在给 `user` 事件挂 `taskStart` / `openItemDelivery` 卡片的同一处（`runner-api.controller.ts`，
`withTaskStart` 那一段），按 `sender_session_id` 读出 `sessionMessage` 卡片，挂到回显旁边：

```jsonc
"sessionMessage": {
  "fromSessionId": "…",       // public id
  "fromTitle": "…",
  "fromAgentName": "…",
  "fromTaskId": "…",          // 发送方没有任务时缺席
  "requestId": "…"            // P1；不是请求时缺席
}
```

web、macOS、iOS 把带这张卡片的 `user` 事件画成「来自 [会话 X]」卡片，会话标题可点，不再画成 owner 的气泡。
旧客户端读不到卡片，显示和今天一样。

还在排队、没投递的会话间消息也一样：队列接口带上同一张卡片，三端的队列把它画成卡片；owner 撤回这条排队消息时，
不把对方的原文放回自己的输入框。

### 2.4 频率上限（随 P0 上线）

P0 让接收方第一次知道是谁在跟它说话，两个会话也就第一次能来回对话。所以上限跟 P0 一起上，不等 P1：

- 每个**有序会话对**（A→B）在滚动的 1 小时内最多 **20** 条会话间消息，普通消息、打断附带的消息和请求合计。
- 计数不随删除回退：排队消息被打断清掉或被 owner 撤回后，仍算在那一小时里（用只增不减的记录，或者软删除）。否则先往对方
  队列里排几条消息、再用带消息的打断把队列清空，计数就归零了。
- 超出返回 409 `SESSION_MESSAGE_RATE_LIMITED`，`retryable: false`。文案指向正确的做法：要等 B 干完活，
  用 `session_await`，不要一遍遍问它。
- 20 是常量，不是设置。依据：一个 agent 回合通常要几分钟，正常协作一小时到不了 20 条；而「问一句状态、
  答一句还在做」式的空转，一两分钟就能来回一次。

先例：watch 对每个观察者每小时最多唤醒 60 次（`WATCH_LIMITS.maxWakesPerObserverPerHour`），理由是
"a session woken this often is usually in a loop"。现有的 `maxCoordinatorSteers`（默认 3）只管跑 task attempt 的
会话，`SessionAttemptService#chargeSteer` 遇到没有 attempt 的会话直接放行，所以自由会话之间至今没有任何上限。

---

## 3. P1：请求

### 3.1 发送

`session_send` 与 `project_send` 增加三个可选参数，MCP 工具、runner 门、CLI（`orbit session send` /
`orbit project send`）同步：

| 参数 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `expectReply` | boolean | `false` | 要求回复。`false` 时行为与今天一致（P0 的署名除外） |
| `replyOptions` | `[{ label, description? }]`，2–4 个 | 无 | 选择题，接收方选一个即可。形状照搬 `ask_owner` 的 `options` |
| `replyWithinSeconds` | integer，60–2,592,000 | 86,400（24 小时） | 截止时间。范围和默认值与 watch 的 TTL 一致（`WATCH_LIMITS`） |

后两个只能和 `expectReply: true` 一起出现，否则 400。

回执在今天的字段之外多两个：`requestId`、`replyBy`。调用**立即返回**，不等回复。

新增的拒绝：

- 调用方不是会话（headless）：403，"expectReply requires a calling session: a reply needs a conversation to come
  back to"。与 `resumeIfEnded` 对 headless 的处理一致。
- 发给自己：400 `SELF_REQUEST`。
- 调用方 `OPEN` 的请求已有 **50** 个（与 `SPAWN_TREE_OUTSTANDING` 一致）：409 `TOO_MANY_OPEN_REQUESTS`。
  这是背压，不是请求写错了，文案参照 `session_create` 的 "already has N unfinished sessions"。

其余拒绝（目标已结束且没带 `resumeIfEnded`、attempt 预算、§2.4 的频率上限）不变。

`project_send` 的目标仍在投递时解析，请求记下的是**投递时那个 coordinator 会话**。之后 coordinator 轮换，
就是那个会话结束了，请求的结局是 `RECIPIENT_ENDED`；发送方再问一次，就会落到新的 coordinator。
请求不跟着项目换人。

### 3.2 回复

新工具 `session_reply`，runner 门 `POST /runner/session-requests/:requestId/reply`，CLI `orbit session reply`：

```
session_reply({ requestId, message?, option? })
```

- 只有该请求的接收方会话能回复，其他调用方一律 403。
- 请求带 `replyOptions` 时，`option`（下标）和 `message` 至少给一个；不带时 `message` 必填。
- 请求已有结局：409 `REQUEST_CLOSED`，带上已有的结局。接收方仍可以用普通的 `session_send` 补一句，
  P0 之后它是署了名的。
- 回复就是终点：`session_reply` 没有 `expectReply`。要追问就发新请求，计入 §2.4 的上限。
- 与 `session_send` 一样，只在账号开启 session orchestration 时提供。

### 3.3 接收方看到什么

§2.2 的块多出几行：

```
<orbit-session-message from-session="…" from-title="…" from-agent="…" request-id="…" reply-by="2026-10-02T09:30:00Z">
这条消息来自另一个 Orbit 会话，不是账号 owner 本人。
对方在等你回复：处理完后调用 session_reply(requestId="…") 回答；做不到也用它说明原因。
如果你空闲下来时还没回复，平台会以 NO_REPLY 结案，并把你最后一段输出转给对方。
</orbit-session-message>
```

带选项时，块里按下标列出各选项。

---

## 4. 结局：发送方恰好收到一次

每个请求最终恰好落在下面一种结局上。结局由请求行上的一次条件更新（`WHERE state = 'OPEN'`）写入，
先到先得，写入后不再改变：

| 结局 | 什么时候 | 回信里带什么 |
|---|---|---|
| `REPLIED` | 接收方调用了 `session_reply` | 回复正文、选中的选项 |
| `NO_REPLY` | 引擎已经收到请求；接收方的 turn 落定（不再是 PENDING / RUNNING）而 run 没结束；身上没有挂起的唤醒源（§4.1）；仍未回复 | 接收方当时的 `lastAssistantText`，标明不是正式回复 |
| `RECIPIENT_ENDED` | 接收方的 run 结束（SUCCEEDED / FAILED / CANCELLED），或会话进了 Completed / Trash | 同上，加结束原因 |
| `EXPIRED` | 到了 `replyBy` 仍未结 | 接收方当时的状态和 `lastAssistantText` |
| `UNDELIVERED` | 承载请求的 turn 在引擎收到之前被收掉，例如打断清空了队列、owner 撤回了排队的消息 | 收掉的原因。接收方从没看到这条请求 |

run 结束时顺带清掉了队列，`UNDELIVERED` 和 `RECIPIENT_ENDED` 同时成立，记 `RECIPIENT_ENDED`。

### 4.1 「还会被唤醒」的判定

`NO_REPLY` 是整个设计里最关键的一行。模型常常做完事就忘了调回复工具；如果只靠截止时间兜底，
就是 7 小时事故的翻版。而「空闲下来、也没有任何会再叫醒它的东西」，是平台能确定判断「不会再有人回答」的时刻。

挂起的唤醒源，任一存在，请求就保持 `OPEN`：

1. 以它为观察者、动作是 `RESUME_SESSION`、仍为 ACTIVE 的 watch；
2. 仍在运行的后台任务（`session.running_bg_jobs`）。常驻的 service 类任务不算：它不会因为结束而唤醒会话，
   算进来只会让请求一直挂着；
3. `PENDING` 状态的 `session_scheduled_wakeup`；
4. 它自己发出、结局还没交到它手里的请求：仍为 `OPEN` 的，以及已有结局、但回信还在路上的。例外：如果那个接收方也有一个
   发给它、仍为 `OPEN` 的请求，就不算。两个会话互相等对方回复时，谁也不会去唤醒谁，算进来会让两边一起卡到截止时间。
   更长的环（A→B→C→A）交给截止时间；
5. 它作为 coordinator 用 `ask_owner` 提出、仍未关闭的问题（`project_open_item`）；
6. 已排上的自动重试（`session.retry_at` 非空）：失败之后，重试会让它再跑一轮。

判定写在一个函数里，清单之外的情况由截止时间兜底。

判定时机：接收方每次 turn 落定时，在同一事务里，对所有「引擎已收到」的 `OPEN` 请求判一次。
唤醒源后来消失、却没有带来新的一轮（例如定时唤醒被取消），这种情况不另外追踪，交给截止时间。

### 4.2 回信怎么送

- 作为发送方会话的新 turn 送达，`sendIntent = NEXT_TURN`，`clientTurnId` 前缀 `session-reply:`。turn 正文为空，
  结局挂在旁边，投递时再渲染成块，做法同 `bg-wake:`（`src/apiserver/src/runner-api/background-job-wake.ts`）：
  回信不算任何人说的话，客户端画成回信卡片。
- 每个结局渲染成一个块，带上原请求的前 200 字，发送方的上下文被压缩之后也能对上号：

  ```
  <orbit-session-reply request-id="…" from-session="…" from-title="…" outcome="REPLIED">
  你问的是：……
  回复：……
  </orbit-session-reply>
  ```

- **合并**：回信 turn 还在排队（runner 还没领走）时，新到的结局并进同一个 turn。5 个 worker 几乎同时回复，
  发送方只被唤醒一次，而不是 5 次。
- `session-reply:` 列为保留前缀，所有允许调用方指定 `clientTurnId` 的入口都拒收。
  `watch-turn-key.ts#assertClientTurnIdNotReserved` 今天只挡 `watch:`，要一并扩展。
- 回信不经过 watch，所以不受 `WAKE_LOOP` 约束：A 在等 B 回复时，B 照样可以向 A 发请求追问，双方都不会卡死。
- 回信是平台投递，不计入 §2.4 的上限，也不计入 `chargeSteer`。

### 4.3 发送方已经不在了

- 发送方的 run 已结束、正在取消，或会话进了 Trash：**不复活它**。为了告诉它一件事去复活一段已经结束的对话，
  不叫回复（`criteria-decision-reply.ts` §1）。结局留在请求行上；发送方跑过任务的，再在该任务上写一条评论，
  评论主键由 `requestId` 派生，重复处理不会重复写。「已结束」不包括失败后已经排上自动重试的情况：那种会话会被重试唤醒，
  回信照常排给它，也不写任务评论。
- 发送方被打断时，排队中的回信 turn 随队列一起被收掉：停就是停，不因为来了回信而继续跑。结局仍在请求行上，
  并在发送方**下一次被投递 turn 时**作为附加块补上，不会丢。

---

## 5. 数据

新表 `session_request`（示意，列名由实现定）：

| 列 | 说明 |
|---|---|
| `id` | 即 `requestId` |
| `owner_id` | |
| `from_session_id` / `to_session_id` | 发送方 / 接收方 |
| `turn_id` | 接收方会话里承载请求的 turn |
| `options` | jsonb，可空 |
| `reply_by` | 截止时间 |
| `state` | `OPEN` / `REPLIED` / `NO_REPLY` / `RECIPIENT_ENDED` / `EXPIRED` / `UNDELIVERED` |
| `reply_text` / `reply_option` | `REPLIED` 时填 |
| `excerpt` | 其余结局时接收方的 `lastAssistantText` |
| `closed_at` | |
| `reply_client_turn_id` | 把结局交给发送方的回信 turn；为空表示还没交出去（发送方不在，或被打断后等下一轮） |

再加 P0 的 `conversation_turn.sender_session_id`。到期由一个 worker 扫 `state = 'OPEN' AND reply_by < now()`，
参照 `src/apiserver/src/runner-api/scheduled-wakeup.worker.ts`。

---

## 6. 客户端

- 接收方：「来自 [会话 X] · 要求回复 · 截止 18:00」卡片，显示请求当前状态，状态变化实时刷新。
- 发送方：回信卡片，可以点回原请求。
- 会话列表上能看出谁在等谁的回复。
- owner **不能**在客户端替接收方回答（§9 第 3 条）。卡片只读。

---

## 7. 不做的事

- **阻塞式等待回复。** 它会占着发送方的 turn 和 runner 槽位。`ask_owner` 和 watch 都是「发出去、结束这一轮、
  被唤醒」。以后真有需要，可以参照 `session_create` 的 `wait`，加一个有上限、有服务端记录兜底的可选等待。
- **任意 JSON 参数，或用 JSON Schema 约束回复。** 接收方是模型，读普通文字没有问题；真正需要结构的是选择题，
  `replyOptions` 已经覆盖。
- **发送方撤回请求。**
- **请求跟着项目换 coordinator**（§3.1）。
- **`session_interrupt` 的 follow-up 要求回复。**

---

## 8. 验收判据

P0：

1. 经 `session_send` / `project_send` 写入的 turn，`sender_session_id` 是调用方会话；人、headless、平台写入的 turn 为空。
2. 引擎收到的文本是原文加 `<orbit-session-message>` 块，存下的 `controlPlaneNote` 恰好是这个块。
3. `user` 事件带 `sessionMessage` 卡片，web / macOS / iOS 画成卡片；不带卡片的事件渲染不变。
4. 同一有序会话对 1 小时内的第 21 条会话间消息被 409 `SESSION_MESSAGE_RATE_LIMITED` 拒绝；人、headless 发的消息不计数。

P1：

5. 五种结局各有一条真 PostgreSQL 用例。每个请求恰好一个结局，发送方恰好收到一次回信；并发的 `session_reply`
   与 `NO_REPLY` 判定只有一方生效。
6. 接收方有 ACTIVE 的 watch、运行中的后台任务、PENDING 的定时唤醒、自己的 OPEN 请求或未关闭的 `ask_owner` 问题时，
   不判 `NO_REPLY`；这些都没有时判。
7. 两个结局在发送方领走回信 turn 之前到达，只产生一个回信 turn。
8. 发送方已结束时不被复活；跑过任务的写一条评论，重复处理不重复写。
9. 发送方被打断时丢掉的回信，在它下一次被投递 turn 时补上。
10. 所有允许指定 `clientTurnId` 的客户端入口拒收 `session-reply:` 前缀。

P0 补充（2026-10-02）：

11. 自动重试重发一条会话间消息时，新 turn 的 `sender_session_id` 与原 turn 相同，引擎收到的文本带
    `<orbit-session-message>` 块。
12. 排队中的会话间消息在 web / macOS / iOS 的队列里画成卡片；撤回时不把对方的原文放回 owner 的输入框。
13. `session_interrupt` 附带的消息写入 `sender_session_id`，并计入 §2.4 的上限。

三处待定（2026-10-02，owner 决定）：

14. 自动重试重发的是一条请求时，请求挪到新 turn：对方收到的块带 `request-id` 和 `reply-by`，卡片带 `requestId`。
    会话因失败停下、但已排上自动重试时，不判 `NO_REPLY`。
15. 失败卡片上的手动 Retry 重发会话间消息时，新 turn 保留原发送者（是请求的话也保留原请求），引擎收到的文本带
    `<orbit-session-message>` 块，不计入 §2.4 的上限。web / macOS / iOS 都如此。
16. §2.4 的计数不随删除回退：排队消息被打断清掉或被撤回后，仍计入那一小时；第 21 条仍被拒绝。
17. 发送方因临时失败而停下、并已排上自动重试时，不算已结束（§4.3）。这包括额度用尽后停在等待输入的情况。这时不写任务评论，
    回信在重试的那一轮补上。重试最终被放弃时，再按 §4.3 写任务评论。

---

## 9. 已定的决策（owner，2026-10-01）

1. 接收方没有明确回复时，自动以 `NO_REPLY` 结案（§4.1）。
2. 默认截止时间 24 小时，与 watch 默认 TTL 一致。
3. owner 不在客户端替接收方回答。

相对同日评审稿的两处调整：

- 防环从「同一 thread 的轮数上限」改为「有序会话对每小时的消息数上限」（§2.4），并提前到 P0 上线。
  要判断一次发送属于哪个 thread，就得知道它是在哪一轮里发出的，而 steer 和回信合并让这件事没有确定的答案；
  按会话对计数是确定的，也顺带覆盖了 P0 打开的普通消息回路。
- 触到上限时只拒绝调用方，不另外通知 owner：拒绝文案已经指向正确的做法，卡片和会话列表上也看得见。

2026-10-02 补充：P0 验收时发现还有三处会把另一个会话的话当成 owner 说的：自动重试的重发、排队中的消息、打断附带的消息。
§1、§2.1、§2.3、§2.4 已补上对应规则，验收见 §8 第 11–13 条。其中打断附带的消息是本文原先漏列的入口。

2026-10-02 再补（P1 审查）：§4.1 第 4 条原先会让两个互相提问、又都忘了回的会话一起卡到截止时间，与 §4.2「双方都不会卡死」
矛盾，已加上互相等待的例外，并把「已有结局、回信还在路上」也算作唤醒源。§4.1 第 2 条改以 `session.running_bg_jobs` 为准。
§4.3 补充：失败但已排上自动重试的会话不算已结束。

2026-10-02 三补（owner 决定署名补漏时发现的三处待定）：自动重试重发请求时请求跟着挪到新 turn，已排上的自动重试算作
唤醒源（§4.1 第 6 条）；失败卡片上的手动 Retry 遇到会话间消息时，由服务端带署名重发（§2.1）；计数不随删除回退（§2.4）。
验收见 §8 第 14–16 条。

2026-10-02 四补（P1 修复审查）：发送方因临时失败停下、已排上自动重试时，回信要留到重试那一轮补上。实现里有两处不符：
一是回信 turn 被额度用尽打断、会话停在等待输入时，重试判定"没有要重发的"就放弃了；二是失败但已排上重试的发送方被当成
已结束，写了任务评论。验收见 §8 第 17 条，并入三处待定任务。
