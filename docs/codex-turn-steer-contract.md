# Codex `turn/steer` 接入契约(冻结版 v1)

**状态**:冻结。本文件是 [1/7] 的产物,是 [2/7](Runner 实现)、[3/7](控制面能力门控)、
以及后续竞态/故障注入任务的**唯一权威**。改这里的任何一条,必须同时改依赖它的任务。

**v1.1([4/7],2026-08-21)**:§4.7 的 `steer_requeue` 已落地(wire + apiserver + runner),
§4.4 的 `E-DROPPED` 归档保持"不确定"档,新增 §4.8「Runner 死掉留下的 steer」,§8 待办表已结案。
本次只**补**竞态与恢复,§1–§3 的线上格式和 §5–§6 的门控一个字未动。

**v1.2([5/7],2026-08-21)**:新增 §4.9「客户端展示与操作」—— 复审 §4.6 那句"三端行为不需要改",
结论是**代码不需要改、用例需要补**(Codex 的气泡可以生在任意 delivery 状态上,Claude 不会),
并记录"IN_FLIGHT 的 steer 不进排队列表"这一**已知且接受**的空窗及其理由。§1–§3、§5–§6 未动。

**范围**:只描述"Orbit 把一条用户消息塞进 Codex 正在跑的 turn"这件事的线上格式、事件相关性、
失败语义和混合版本行为。**不含**业务实现。

**权威来源**:
- OpenAI 官方 Codex App Server 文档(`turn/steer` 一节)。
- 本机 `codex-cli 0.149.0` 的 `codex app-server generate-json-schema` 产物。
- 对真实 `codex app-server` 的实测 —— 见 [`docs/evidence/codex-turn-steer-0.149.0/`](./evidence/codex-turn-steer-0.149.0/)。
  下文标 **【实测】** 的结论都能在 [`transcript.md`](./evidence/codex-turn-steer-0.149.0/transcript.md) 里找到原始输出。

---

## 0. 一句话结论

Codex 的 `turn/steer` 在语义上**不是** Claude 的 stdin steer,差在三点,整份契约都是围着这三点建的:

1. **Codex 不去重。** 同一个 `clientUserMessageId` 发两次,会在会话里插两条 userMessage。【实测】
   → at-most-once 只能由 Orbit 保证;**任何自动重试都是双发**。
2. **返回 OK ≠ 消息进了会话。** Codex 把 steer 缓冲到下一个模型请求边界才注入,实测滞后 **31 秒**;
   如果 turn 在此之前被 interrupt,这条消息**连同缓冲一起被静默丢弃,没有任何通知**。【实测】
   → `written`(已被 Codex 收下)和 `acknowledged`(模型看见了)必须是两个状态,后者只认回显。
3. **所有失败都是同一个错误码 `-32600`**,连"方法不存在"都是。【实测】
   → 失败分类只能按 message 前缀做,且**未知消息一律按"未送达且不可自动重试"处理**。

---

## 1. 请求

方法名 **`turn/steer`**,JSON-RPC request(有 id,要等 response)。

```jsonc
{ "id": 42, "method": "turn/steer", "params": {
  "threadId":            "<Codex thread id>",   // 必填。就是 ClaimedSession.RuntimeSessionID
  "expectedTurnId":      "<Codex turn id>",     // 必填。必须等于当前 active turn 的 id
  "input":               [ { "type": "text", "text": "…" } ],  // 必填
  "clientUserMessageId": "<Orbit conversation_turn.id>"        // 可选,但 Orbit 必填
} }
```

字段冻结(schema 见 [`TurnSteerParams.schema.json`](./evidence/codex-turn-steer-0.149.0/TurnSteerParams.schema.json)):

| 字段 | 必填 | Orbit 填什么 |
| --- | --- | --- |
| `threadId` | 是 | `job.RuntimeSessionID`(`thread/start`/`thread/resume` 拿到的那个),与 `turn/start` 同源 |
| `expectedTurnId` | 是 | **Codex 的 turn id**,即 `turn/start` response 的 `result.turn.id` —— 不是 Orbit 的 turnId。runner 已经把它存在 `codexAppActiveTurn.codexTurnID` 里 |
| `input` | 是 | 与 `turn/start` 同构的 `UserInput[]`;文本用 `{type:"text",text}`,图片附件用 `{type:"localImage",path}` |
| `clientUserMessageId` | 否 | **Orbit 必填**:填这条 steer 自己的 `conversation_turn.id`。这是唯一的关联键(见 §3) |

**`turn/steer` 不接受 turn 级 override**(`model` / `cwd` / `sandboxPolicy` / `outputSchema` / `effort` /
`approvalPolicy` / `additionalContext`):schema 里根本没有这些字段。

> ⚠️ 【实测】0.149.0 对 params 的未知字段**不报错**,带 `model` 发过去会被静默忽略并返回 OK。
> 所以"发错了会被拒"是**不成立**的假设 —— Orbit 必须自己保证不发,不能指望 Codex 兜底。
> 具体后果:**steer 无法携带 model/effort/permission 变更**。会话中途改 provider/model/effort
> 走的是既有 `reload` turn 路径,与 steer 互斥,[2/7] 不要试图合并。

**`turn/steer` 也不携带 agent context 注入。** `codexInstructionsAdditionalContext` /
`codexInstructionsInjectItems` 这两条路只挂在 `turn/start` 上;steer 加入的是一个已经带好 context 的 turn,
不需要也无处再注入。`prepareInstructionContext` **不要**在 steer 路径上调用(它会推进 `contextGeneration`)。

## 2. 响应

```jsonc
{ "id": 42, "result": { "turnId": "<Codex turn id>" } }
```

`turnId` 是**被 steer 进去的那个 turn**,正常情况下等于请求里的 `expectedTurnId`。【实测】

**契约**:runner 必须校验 `result.turnId === expectedTurnId`。不相等按"未送达"处理(§4 的 `E-MISMATCH` 行),
虽然实测没见过这种情况 —— 这是一条便宜的、防协议漂移的断言。

**`turn/steer` 不产生新的 `turn/started`,不产生独立的 assistant reply,`thread/read` 里 turn 数不变。**【实测】
这正是项目验收第 2 条要的行为。

### 2.1 发送前提(runner 侧)

`expectedTurnId` 是必填的,而 runner 拿到 Codex turn id 有个窗口:

`turn/start` 在独立 goroutine 里发出,`codexAppActiveTurn.codexTurnID` 要等它的 response 回来
(`recordCodexTurnID`)或 `turn/started` 通知到达(`onTurnStarted`)才被填上。在这之间,
`active != nil` 且 `startSent == true`,但 `codexTurnID == ""` —— 这正是 `requestCodexAppInterrupt`
已经在处理的那个"start 之前"窗口。

契约:

1. **等,但有界。** steer 发出前必须在 `activeMu` 下拿到非空 `codexTurnID`;拿不到就等,上限用 §4.5 的
   同一个 10 秒预算。
2. **等不到 → 按可证未送达处理**(§4.3a 重排)。一个字节都没发出去,这是最干净的一类失败。
3. **`active == nil`**(turn 已经结束)→ 同样按可证未送达重排,**不要**发一个必然被拒的请求。
4. **不要阻塞 inbox 轮询循环。** 那个循环还要接 `interrupt` / `end`,阻塞 10 秒会让"停止"按钮失灵。
   steer 走异步派发,和 `sendInterrupt` 一样挂在 `asyncWg` 上。
5. **但同一 session 的 steer 之间必须串行。** inbox 一次只交出一条(`LIMIT 1`),顺序是 `seq` 序;
   若并发派发,两条 steer 可能倒序抵达 Codex,而 Codex 就按抵达顺序往会话里插。用单槽 worker 或
   一把 send 锁保住顺序。

## 3. 事件相关性:三个 id,谁对谁

| id | 谁生成 | 生存期 | 用途 |
| --- | --- | --- | --- |
| Orbit `conversation_turn.id` | apiserver | 永久 | 一切对外的收据地址(`user_delivery.turnId`、`/turn-complete` 的 `turnId`) |
| Codex `threadId` | Codex | 会话级 | `job.RuntimeSessionID` |
| Codex `turnId` | Codex(UUIDv7) | 单 turn | `expectedTurnId`;runner 侧就是 `codexAppActiveTurn.codexTurnID` |

**关联键只有一个:`clientUserMessageId`。**

Codex 把它原样回显在 userMessage item 的 **`item.clientId`** 上(schema 见
[`UserMessageThreadItem.schema.json`](./evidence/codex-turn-steer-0.149.0/UserMessageThreadItem.schema.json)):

```jsonc
{ "method": "item/started",   "params": { "item": {
    "type": "userMessage", "id": "01a0253a-6f66-…", "clientId": "<我们发的 clientUserMessageId>",
    "content": [ { "type": "text", "text": "…" } ] } } }
{ "method": "item/completed", "params": { "item": { … 同上 … } } }
```

契约:

- **steer 的 `clientUserMessageId` 必须填 Orbit 那条 steer 自己的 `conversation_turn.id`**,与 `turn/start`
  已经在做的一致(`codexTurnParams` 里 `"clientUserMessageId": orbitTurnID`)。
- **按 `clientId` 精确匹配,不要用 FIFO。** Claude 侧 `deliveryLedger.acknowledgeNext` 用 FIFO 是因为
  `--replay-user-messages` 的回显不带 id;Codex 带,别把那个将就的做法搬过来。
- **`item.clientId` 不唯一。** 【实测】同一个 `clientUserMessageId` 发两次会得到两条 `clientId` 相同、
  `item.id` 不同的 item。匹配时**只认第一条**,后续同 `clientId` 的回显忽略(它意味着发生了双发,应该打日志告警)。
- `item/started` 与 `item/completed` 对 userMessage 几乎同时到达(实测同毫秒)。**以 `item/started` 为准**,
  `item/completed` 只做幂等确认。

## 4. 失败语义

### 4.1 唯一的错误码

【实测】`turn/steer` 的**所有**失败都是 `{"code": -32600, "message": …}`,**包括方法不存在**
(不是 `-32601`)。**分类必须按 message 前缀,`code` 不携带任何信息。**

### 4.2 冻结的分类表

`E-*` 是本契约给的稳定标识,[2/7] 的分类函数和它的表驱动测试都用这套名字。

| 标识 | message(前缀匹配 / 包含) | 进会话了吗 | Orbit 动作 |
| --- | --- | --- | --- |
| `E-NO-ACTIVE` | `no active turn to steer` | **否**(可证) | 降级重排:这条 turn 变回普通 `message` |
| `E-MISMATCH` | `expected active turn id \`…\` but found \`…\`` | **否**(可证) | 同上 |
| `E-UNSUPPORTED` | `unknown variant \`turn/steer\`` | **否**(可证) | 同上 **+ 关掉本进程的 codex steer 能力**(§5) |
| `E-BAD-REQUEST` | `Invalid request: missing field …` / `invalid thread id: …` | **否**(可证) | 这是 Orbit 自己的 bug:`delivery=failed, retryable=false`,打日志告警,**不重排**(重排会无限循环) |
| `E-UNKNOWN` | 其它任何 `-32600`,或任何非预期的错误形状 | **不确定** | 默认拒绝:`delivery=failed, retryable=true`,**不重排、不重试** |
| `E-TIMEOUT` | 请求写出去了但没等到 response(超时 / app-server 死了 / runner 被杀) | **不确定** | 同 `E-UNKNOWN` |
| `E-DROPPED` | 返回过 OK,但 `turn/completed` 到达时回显始终没出现 | **否**(实测,见下) | `delivery=failed, retryable=true`,**不自动重排**(见 §4.4) |
| `E-DUPLICATE` | 同一条 `conversation_turn` 被 inbox 交出**两次** | **否**(第二份一个字节都没发) | **什么都不做**:第一份交付拥有这一行,它会自己结算。第二份既不报事件也不结算,否则同一行会被答两次([4/7] 新增) |
| `E-ABANDONED` | 这条 steer 被某个 runner 进程 lease 走之后,那个进程死了 | **不确定** | `delivery=failed, retryable=true`,由接管的进程报(§4.8,[4/7] 新增) |

### 4.3 三条区分线

**(a) 可证未送达 → 可以安全重排。**
`E-NO-ACTIVE` / `E-MISMATCH` / `E-UNSUPPORTED` 都是 Codex 在**读 input 之前**就拒了,
JSON-RPC 有明确的 error response,消息一个字节都没进会话。重排不会重复执行任何东西。
这与 runner 已有的 `errNeverWritten` 是同一类。

`E-BAD-REQUEST` 同样是可证未送达,但**不重排** —— 它是 Orbit 自己构造错了请求,重排会原样再撞一次,
变成一个安静的死循环。这一类要的是显式失败加告警,好让人去修 bug。

**(b) 不确定 → 绝不自动重试、绝不自动重排。**
因为 **Codex 不去重**(§0.1),自动重试就是双发,而双发在会话里是两条真实的用户消息,
模型会当成两次要求。这与 runner 已有的 `errDeliveryUnconfirmed` 是同一类,处理方式也一样:
settle 成失败、`retryable: true`、把重发的决定交给人。

**(c) `turn 恰好结束` 这条竞态,Codex 侧是干净的。**【实测】
拿一个短 turn 反复用不同延迟去 steer:要么被接受**并且一定回显进会话**(Codex 会把 turn 拖住等它折进去),
要么被 `no active turn to steer` 干净拒掉、完全没进会话。**自然结束路径上不存在"接受了但丢了"**。
所以项目验收第 3 条的"turn 恰好结束"落在 `E-NO-ACTIVE`,是可证未送达,安全重排。

### 4.4 `E-DROPPED`:唯一一条"接受了却丢了"的路径

【实测】`turn/steer` 返回 OK 之后、Codex 把它注入模型之前,如果 turn 被 **interrupt**,
这条 steer 连同缓冲一起被丢弃:**回显永远不来,`thread/read` 里没有这条 userMessage,也没有任何通知。**

契约:

- runner 必须为每条已 `written` 但未 `acknowledged` 的 steer 记账,并在收到该 turn 的 `turn/completed` 时结算。
  `turn/completed` 之后仍未回显的 → `E-DROPPED`。
- **`E-DROPPED` 归到"不确定"一档,不自动重排。** 虽然实测证明它没进会话,但"回显晚于 `turn/completed` 到达"
  这个重排序还没有被证伪 —— 观察到的顺序都是回显在前。为了不冒双发的险,这里选**显式失败**而不是自动重排。

  > **[4/7] 结论:维持不重排。** 两种顺序都做了故障注入
  > (`TestAnAcceptedSteerThatWasNeverEchoedIsReportedNotRefiled` /
  > `TestAnEchoBeforeTheTurnEndsSettlesTheSteerAsDelivered`):回显先到 → `acknowledged` 并只结算一次;
  > `turn/completed` 先到 → `E-DROPPED`,**之后再来的回显不会把已结算的失败改回去**,也不会二次结算。
  > 升级成"可证未送达"仍然要一个 Codex 侧的顺序保证 —— 本次没有拿到,而**猜错的代价是会话里多一条真实用户消息**,
  > 所以这条不是"还没做",是**已裁定不做**。要翻案,需要的证据是 app-server 保证 `item/*` 先于 `turn/completed` 落地。
- 实践上这条路径很窄:Orbit 的 interrupt 走的是独立的 `interrupt` turn,而 `interrupt-and-send` 的后续消息
  **本来就是以普通 message 而非 steer 归档的**(见 `RunInterruptRequest` 的注释),所以最常见的触发者是
  "用户按下停止,而此前刚好发过一条 steer"。

### 4.5 请求超时

【实测】`turn/steer` 的 response 很快:tool call 跑到一半时发出,+6ms ~ +520ms 返回。
它**不等**消息被注入模型,所以延迟与 tool 时长无关。

契约:超时设 **10 秒**(远大于实测上界,又远小于 `INBOX_LEASE_MS`,不会拖住 inbox 循环)。
超时按 `E-TIMEOUT` 处理。**超时后不得重发。**

### 4.6 收据状态机(与 Claude 共用词表)

沿用 `claude_delivery.go` 已有的 `deliveryState`,不新增状态:

| 状态 | Codex 侧的含义 | 客户端显示(`steerDelivery.ts`,不变) |
| --- | --- | --- |
| `pending` | inbox 交出了这条 steer,还没发 | Sending… |
| `enqueued` | 已写进 app-server stdin,response 未回 | Sending… |
| `written` | `turn/steer` 返回 OK 且 `turnId` 校验通过 —— **Codex 收下了,模型还没看见** | Delivering… |
| `acknowledged` | 收到 `item.clientId` 匹配的 userMessage 回显 —— **消息在会话里了** | Sent into this turn |
| `failed` | §4.2 里任何一行 | Not delivered |

`written → acknowledged` 实测可以隔 31 秒。**这段时间显示 "Delivering…" 是正确的,不是卡住。**

Web / iOS / macOS 三端**行为**不需要改:`steerDelivery.ts` 与 `SteerDelivery.swift` 是双胞胎,
都只看 `delivery` 字段,词表没变。唯一要动的是**注释**:两边现在都写着 `claude` / `--replay-user-messages`,
codex 接进来之后这话就只说了一半了 —— 该由 [2/7] 顺手改准,不要留着误导下一个人。

### 4.7 turn 结算

steer 的 `/turn-complete` 沿用 `settleSteerTurn`:`Subtype: "steer"`,失败时 `Status: FAILED` + `Result`。
apiserver 侧 `runner-api.controller.ts` 的 steer 分支已经保证了"只 ack 自己这一行,不动 numTurns、
不动 session 状态、不把 session 打成 FAILED"。**这条不变,codex 直接复用。**

需要**新增**的是"可证未送达 → 重排"的回执(§4.3a)。现有 `settleSteerTurn` 只能把行标成 `ANSWERED`,
一旦 ANSWERED 就永远不会再投递,消息就没了。接口约定(**[4/7] 已实现**:
`requeueSteerTurn`(runner)、`turnComplete` 的 `steer_requeue` 分支(apiserver)、
`TURN_COMPLETE_STEER_REQUEUE`(`@orbit/shared`)):

- wire:`TurnCompleteRequest.Subtype = "steer_requeue"`(新常量,与现有 `"steer"` 并列),`Status: SUCCEEDED`。
- apiserver 语义:把该行从 `kind='steer', status='IN_FLIGHT'` 改回 `kind='message', status='PENDING'`,
  **保持同一 seq、同一 clientTurnId**(与 turn-complete 里既有的"PENDING steer 降级成 message"完全一致,
  只是触发者从"turn 结束了"变成"runner 说它送不进去")。
- 幂等:同一 turnId 重复报 `steer_requeue` 必须只生效一次(行已经是 `kind='message'` 时是 no-op)。
- 旧 apiserver 收到未知 subtype 会当成普通 steer ack(标 ANSWERED)→ 消息丢失。所以
  **`steer_requeue` 必须受 §5 的能力门控保护**:runner 只在控制面明确支持时才走这条路。

**[4/7] 补充三条,都是实现里踩出来的:**

1. **重排路径不发任何事件。** 不发 `user`,也不发 `user_delivery`。因为这一行会以 `kind='message'`
   被重新投递,而普通 message 路径**一定会**发它自己的 `user` 事件 —— 重排时留下的气泡不会被复用,
   而是变成**同一条消息在 transcript 里出现两次**,其中一条永远停在 "Sending…"。这条消息在重排后
   由控制面的排队视图负责显示(`listQueuedTurns`),它本来就是排队消息了。
2. **因此 `user` 事件必须推迟到"第一个已知结果"才发**,而不是发请求之前。谁先知道结果谁发
   (响应 goroutine 或读通知的 goroutine,§3 的回显可能先到),之后所有转移都只是修正
   (`codexSteerDispatcher.announce`)。代价是 leased 到出结果之间(实测 6ms~520ms,上限 10s)
   transcript 里暂时没有这条消息 —— 发送方自己有乐观气泡,这段时间的语义与 `enqueued` 相同
   ("Sending…"),换来的是**任何一条消息永远只有一个气泡**。
3. **幂等的判据是 `kind` 本身**:`WHERE id=? AND kind='steer' AND status='IN_FLIGHT'`。
   重复上报第二次匹配不到行 → no-op;与"turn 结束把 PENDING steer 降级成 message"那条路径
   在 `status` 上天然互斥(那条只碰 PENDING),所以两者并发也不会互相踩。
   重排成功后如果 session 已经被那个 turn 停到 `AWAITING_INPUT`,要把它改回 `PENDING` 并 `notifyInbox`
   —— 否则就是一条挂在没人叫醒的会话后面的 PENDING message(经典 lost-wakeup)。

### 4.8 Runner 死掉留下的 steer(**[4/7] 新增**)

v1 没有覆盖这一格,而它是一个**真的死角**:steer 只投递一次、且**故意不可 re-lease**(§4.2 表下面那段),
于是一个 runner 进程在 lease 走 steer 之后被 SIGKILL / 机器挂掉,这一行就再也没有人会回来:

| 谁可能来收 | 为什么收不了 |
| --- | --- |
| inbox 的 dequeue 谓词 | 只交出 `kind='steer' AND status='PENDING'` |
| `release-leases` / `activate-leases` 的过期 lease 重投 | `WHERE kind IN ('message','shell')`,故意不含 steer |
| turn 结束时"PENDING steer 降级成 message" | 只碰 PENDING |

结果:行永远卡在 `IN_FLIGHT`,不在排队列表里(那里只列 PENDING),`user_delivery` 停在最后一次上报的状态。
**这就是"静默丢失"本身。**

契约:

- **控制面负责发现,runner 负责回答。** `POST /runner/sessions/:id/activate-leases` 的响应新增
  `abandonedSteers: AbandonedSteer[]`(`{turnId, content, announced}`),列出这个 session 上
  `kind='steer' AND status='IN_FLIGHT' AND lease_generation != <本次的 generation>` 的行。
  接管的 runner 进程在**启动引擎之前**逐条报 `user_delivery{failed, retryable:true}` 并
  `settleSteerTurn(..., errSteerAbandoned)`(`reportAbandonedSteer`)。
- **为什么不能由 apiserver 直接写事件**:`run_event.seq` 由 runner 从 `job.MaxSeq+1` 本地分配,
  claim 之后服务端插入的事件会和 runner 的计数器撞 seq,而 `createMany(skipDuplicates)` 会**静默丢掉一条**。
  所以"一条 steer 的结局只在 session 事件流上可见"这件事,决定了只能由**活着的 runner** 来说。
- **只报不改**:activate 会因传输错误重试,如果在这里就把行标成 ANSWERED,那么**响应丢失的那次重试**
  会查不到行 → 这条消息永远没人答。所以 activate 只读;是 runner 的 `turn-complete` 把它结算掉,
  从而自然退出这个集合。同理**快路径(generation 已安装)也必须返回它** —— 那正是"已提交但响应丢了"的重试落点。
- **`announced`**:该 turn 是否已经有 `user` 事件(apiserver 查 `run_event`)。接管进程**不可能知道**
  ——前一个 generation 的记录跟它一起死了——而多发一个 `user` 会把同一条消息显示两次。
- **归"不确定"档,retryable:true。** 消息有没有被 Codex 读到,两边都不知道;重投是双发,所以不重投、不重排。

### 4.9 客户端展示与操作(**[5/7] 结案**)

§4.6 说"三端行为不需要改",这条经审查成立 —— **但只对稳态成立**。Codex 与 Claude 在**事件顺序**上不一样,
这才是客户端真正需要被钉住的地方:

| | Claude | Codex |
| --- | --- | --- |
| `user` 事件何时发 | **接受消息时**(§`session.go` `deliveries.accept` 之后),必然从 `enqueued` 起步 | **第一个已知结果时**(§4.7 补充 2),气泡**直接生在** `written` / `acknowledged` / `failed` 上 |
| 谁可能先说话 | 只有写入 goroutine | 响应 goroutine 或读通知 goroutine,谁先知道谁开(`announce` 单飞) |
| `enqueued` 会出现在 transcript 吗 | 会 | **不会**。Codex 的 "Sending…" 只出现在**排队列表**里(leased 之前),不出现在气泡上 |

所以"四个状态"在两端的**入口**不同,而**词表相同**。客户端不需要新代码,但需要各自的用例把
"气泡可以生在任意状态上"钉住 —— 这正是本任务补的:web `Transcript.test.tsx`(`a codex steer, whose
bubble opens at whatever happened first`)、Swift `SteerDeliveryTests`(`// MARK: - the same steer,
delivered by codex`)。反向验证:把"读 `user` 事件自带的 delivery"这一行去掉,**只有新用例红**(web 3 条),
既有的 Claude 顺序用例全绿 —— 这个死角原本没有人看着。

**kind 的权威性(四扇门)**:`kind` 由服务端在 Session 行锁下决定,四扇门都原样透传、都不自造:

- **Web**:`sendTurn` 的 `res.kind` 覆盖本地 `idle` 猜测(`WorkspaceView`),排队列表按 `r.kind` 重算;
- **iOS/macOS**:`ConsoleModel` 用 `SteerDelivery.isSteerKind(accepted.kind)`,`reconcileQueuedTurns` 每次
  按服务端 `kind` **重写** `bubble.steer`(不是"只置真不置假"——见下条 `steer_requeue`);
- **API**:`POST /turns` 返回 `kind`;`GET /sessions/:id/turns` 每行带 `kind`;
- **CLI / MCP**:`orbit session send` 与 `session_send` 都是 raw JSON 透传,旧服务端不带 `kind` 时也**不补默认值**。

**Cancel 的唯一规则**:`kind='steer'` 不给 Cancel,`message`/`shell` 照旧给。三层都已闭合 ——
服务端 `cancelQueuedTurn` 只删 `message`/`shell`,steer 命中专门的 409("being written into the running
turn");web 由 `QueuedTurnMeta` 渲染,steer 分支不渲染 Cancel;macOS/iOS 的 `MessageBubbles.meta` 里
Cancel 嵌在 `else if bubble.pending` 分支内,而 `bubble.steer` 分支排在它**前面**,结构上不可达。
(OrbitApp 不在 Linux 可测范围内,所以 Swift 侧钉的是视图分支所读的 `bubble.steer`/`queued` 状态本身。)

**`steer_requeue` 的客户端结局**:重排不发任何事件,**排队列表就是公告** —— 同一 `turnId` 以
`kind='message'` 重新出现,Cancel 必须跟着回来。两端都验了;Swift 侧把
`bubble.steer = isSteerKind(kind)` 改成 `||=`(即"只置真不置假")会直接红。

**已知且接受的空窗(不修)**:一条 codex steer 从被 lease(行转 `IN_FLIGHT`,离开 `listQueuedTurns`)
到第一次 `announce` 之间(实测 6ms~520ms,上限 10s 即 RPC 超时),对**刷新/第三方视角**不可见;
发送方自己有乐观气泡。**不把 `IN_FLIGHT` 的 steer 列进 `listQueuedTurns` 的理由**:

1. 那个列表的语义是"还没有人读过、可以撤回的行",把已投递的行混进去会让 Cancel 的判据从 `kind` 变成
   `kind + status`,而 `status` 客户端根本看不到;
2. 要正确实现必须再查 `run_event` 排除"已经有 `user` 事件"的行 —— 每个 focused 客户端都会打这个接口;
3. 真正无界的那一格是 §4.8(runner 死掉),而那一格**列出来更糟**:会变成一条永远停在 "Sending…"、
   永远不能取消、也永远不会有结果的行;不列出来则用户看到消息没发出去、重发一次即可,这是安全的一侧。

若后续要改,做法仍是 [4/7] 交接里写的那条:列 `kind='steer' AND status='IN_FLIGHT' 且尚无 user 事件` 的行
(两端 reducer 已经会按 `user` 事件去重,见 Swift `deliveredTurnIDs` 与 web 的 `user` 分支)。

## 5. 能力信号:provider-specific + 版本感知

### 5.1 现状审计

| 位置 | 现在是什么 | 问题 |
| --- | --- | --- |
| `src/shared/src/providerTransport.ts` `supportsMidTurnSteer()` | `PROVIDER_TRANSPORTS[runtime] === 'stream-json'` —— 只有 claude 为 true | 把"能否 mid-turn 送达"绑死在 **transport** 上。Codex 是 `json-rpc`,但 `turn/steer` 恰恰证明 json-rpc 也能 mid-turn 送达。**判据的维度错了**,要改成 per-runtime 的显式能力 |
| `sessions.service.ts` `runtimeTakesSteer()` | 解析 BYOK → `execRuntime` → `supportsMidTurnSteer` | 分辨率正确(判的是 runtime 不是 slug),**保留**。只需要它下面的谓词变准 |
| `sessions.service.ts` `createTurn()` | `engineTurnInFlight && runtimeTakesSteer ? 'steer' : 'message'` | 决策点正确(Session 行锁下、服务端决定、所有入口一致),**保留** |
| `transport.go` `inbox()` | URL 硬编码 `?acceptsSteer=1` | **只有一个 bool,没有 provider 维度。** 这是混合版本的主要风险源,见 §6 |
| `runner-api.controller.ts` `dequeueTurn()` | `AND ${acceptsSteer}::boolean` 才把 `kind='steer'` 交出去 | 闸门在,但闸门后面那个 bool 的含义要升级 |
| `codex_appserver.go` `case "steer":` | 无条件 `refuseUnsupportedSteer(...)` | [2/7] 要换掉的就是这里 |
| `codexAppActiveTurn` | 已经有 `orbitTurnID` / `codexTurnID` / `startSent` / `finishing` / `interruptRequested`,由 `activeMu` 保护 | **就是 steer 需要的那份状态,直接复用。** `codexTurnID` 由 `recordCodexTurnID`(`turn/start` 的 response)和 `turn/started` 通知两条路填,见 §2.1 |
| `RegisterRequest` / `HeartbeatRequest` | 只报 runner 自己的 `Version`,**不报引擎版本** | 所以 **apiserver 在 `createTurn` 时无法知道对面 codex 的版本** —— 这直接决定了 §6 的形状 |

### 5.2 Codex 版本感知

**不押具体版本 floor。**【实测】0.145.0 和 0.149.0 都有 `turn/steer`,本机拿不到更旧的版本,
引入版本无法确定;猜一个 floor 只会在两个方向上都出错。

改用**运行期判据**,两条,都在 runner 侧:

1. **握手侧(先验)**:`initialize` 的 `result.userAgent` 里带版本(`orbit/0.149.0 (…)`)。
   `codexInstructionModeForUserAgent` 已经在解析同一个字符串,**沿用它的解析方式**
   (取第一段 `/` 后的 `major.minor`,`major > 0 || (major == 0 && minor >= N)`)。
   本契约把 N 定为 **145**(本机可实测的最低支持版本),并明确:**这只是一个乐观下界,不是正确性依赖**。
2. **运行期判据(后验,权威)**:第一次 `turn/steer` 返回 `E-UNSUPPORTED`(`unknown variant \`turn/steer\``)
   时,**把该 app-server 进程的 steer 能力置为不支持**,该进程后续所有 steer 一律走 §4.3a 的重排路径,
   不再尝试。这条判据不依赖任何版本号,是最终兜底。

`turn/steer` **不需要** `capabilities.experimentalApi`【实测】,但 Orbit 本来就带着它,不用改。

### 5.3 Runner → 控制面的能力信号

把 `?acceptsSteer=1` 这个 bool 补上 **runtime 维度**。落地形态(**[3/7] 已实现,取代本节 v1 里
`?steerRuntimes=claude,codex` 的写法**)是每个请求**本来就带着**的那个能力头:

```
X-Orbit-Runner-Capabilities: session-orchestration-credential-v1,session-terminal-handoff-v1,
                             session-worktree-ops-v1[,session-codex-steer-v1]
```

- `acceptsSteer=1` 的含义**不变**(向后兼容):"我认识 `steer` 这个 kind"。
- `session-codex-steer-v1` 新增:"codex 的 `turn/steer` 我**真能送达**"。runner 不手写这个列表,
  而是从 `providerRuntimes[*].steersMidTurn` 算出来(`declaredSteerCapabilities()`),
  所以**声明不可能跑到实现前面**;[2/7] 把 codex 那一格翻成 `true` 的同一次改动才会开始声明它。
- **claude 不需要任何声明**:它的中途送达与 `steer` 这个 kind 同时发布,现网每个 runner 都做得到,
  给它加门等于当天把一个正在用的功能从全网撤掉。
- 旧 runner 不发这个 token → 只有 claude 能 steer,**正好等于今天所有在跑的 runner 的真实能力**。

为什么用能力头而不是新开一个 query 参数:

- 这个头**每个请求都带**(`transport.go doHeaders`),inbox 长轮询也带 → `dequeueTurn` 拿得到;
- heartbeat 已经把它**持久化**进 `Runner.capabilities`(既有逻辑,零改动)→ `createTurn` 也拿得到。
  而 `createTurn` 发生在"用户按下发送"那一刻,根本不在 inbox 请求里,一个 inbox query 参数到不了它;
- 于是**同一个词**门控两处,不用维护两套语义,也不用加 DB 列。

**两处门控,缺一不可**(§6.1 的兜底是第二处,但第一处才让混合版本连一次失败都不会发生):

| 位置 | 读哪份 | 拦住什么 |
| --- | --- | --- |
| `sessions.service.createTurn` → `runtimeTakesSteer` | 该 session `assignedRunnerId` 的 `Runner.capabilities`(heartbeat 快照) | 一开始就不把这行记成 `kind='steer'` —— 不支持就是普通 `message`,与今天逐字相同 |
| `runner-api.controller.dequeueTurn` | **本次 inbox 请求自己带的头** | 快照过期(机器降级/回滚)时兜底:steer 行留 PENDING,turn 结束时被既有逻辑降级成 message |

两处都走 `supportsMidTurnSteer(runtime, declared)`(`@orbit/shared`),runtime 一律先用 `execRuntime`
解析(BYOK slug 判它借的 runtime,不判 slug);dequeue 侧 SQL 里 `AND ${…}::boolean` 那一行不用动,
只是喂给它的值变准。

**反方向的信号**(控制面 → runner)解决 §4.7 的 `steer_requeue` 门控:在 `RunInboxResponse` 上加
`steerRequeue?: boolean`,**随这条 steer 本身投递**(投递即答复,不用另开一次往返,也不用 runner 记全局状态)。
**[4/7] 已实现**:`dequeueTurn` 在交出 `kind='steer'` 时置 `true`。

- 收到 `steerRequeue: true` → 送不进去时走 §4.3a 的重排。
- 字段缺失(旧控制面,JSON 里没有 → Go 里是零值 `false`)→ runner 退回**显式失败**(`delivery=failed, retryable=true`)。
  宁可让人看见一次失败,也不能把行标成 ANSWERED 之后丢掉 —— 旧 apiserver 的 steer 分支根本不看 `subtype`,
  发过去的 `steer_requeue` 会被当成普通 ack。

> 为什么不做成"apiserver 问 runner 的 codex 版本":**问不到**。§5.1 最后一行:runner 只上报自己的版本,
> 而且 codex 版本是 per-session 的进程属性,heartbeat 时还没 spawn。所以 codex 版本这一层**只能**在
> runner 侧、在 delivery 时刻裁决,这就是 §4.3a 的重排路径存在的理由。

### 5.4 其它 provider 保持不动

| runtime | transport | mid-turn 送达 | 本项目后的行为 |
| --- | --- | --- | --- |
| `claude` | stream-json | ✅ 已有 | 完全不变 |
| `codex` | json-rpc | ✅ `turn/steer` | 本项目新增 |
| `kimi` | json-rpc | ❌ ACP 无对应方法 | 保持 `message` 排队。**不要**因为 codex 是 json-rpc 就把 kimi 一起放开 |
| `opencode` | one-shot | ❌ 一 turn 一进程 | 保持 `message` 排队 |

这正是"判据要从 transport 换成 per-runtime 能力"的原因:codex 和 kimi 同为 `json-rpc`,能力却相反。

`!cmd` shell turn 的排队语义不变(shell 跑在 runner 上,不在引擎里,没有可折入的 turn)。

## 6. 混合版本 rollout 契约

三个轴,逐个说清。

### 6.1 新 apiserver + 旧 runner —— **这是本项目最大的回归风险**

现状:今天在跑的每个 runner 都**无条件**发 `?acceptsSteer=1`(`transport.go` 里是 URL 常量),
而它们的 codex 循环**无条件 `refuseUnsupportedSteer`**。

所以如果只放开控制面(让 `runtimeTakesSteer('codex')` 返回 true)而不管 runner:
**每一条 codex 中途消息都会被 lease 走、然后硬失败**成
"this engine cannot be given a message while a turn is running" —— 从"安静排队"退化成"每次都报错"。
这不是丢消息(失败是可见的、可重发的),但是明确的 UX 回归,且违反项目"混合版本下宁可安全排队"的要求。

**契约:控制面对 codex 开闸,必须由 §5.3 的能力声明把关,不得只看 runtime。**
即 `createTurn` 只在该 session 的 runner 声明过 `session-codex-steer-v1` 时才记 `kind='steer'`,
而 `dequeueTurn` 还要再确认**正在轮询的这个进程**自称能 steer codex。
旧 runner 不发这个 token → 视为只支持 claude → codex 的 steer 行**根本不会被记下**;
真被记下又赶上降级(快照过期)的那一条则**留在 PENDING**
→ 该 turn 结束时被既有逻辑降级成普通 `message` → **消息晚一轮执行,不丢、不报错。**
这也正是 inbox 路由注释里已经写下的那条保证("This is what makes the control plane safe to deploy ahead of the runners")。

> 备选方案(**不采用**):让 `createTurn` 干脆不给 codex 记 `steer`,等 runner 全升完再翻开关。
> 不采用的理由:那需要一次全局的、无法按 session 判断的人工切换,而 `steerRuntimes` 是自动收敛的。

### 6.2 旧 apiserver + 新 runner —— 安全,无需动作

旧 apiserver 的 `supportsMidTurnSteer('codex')` 是 false,**永远不会给 codex 记 `steer` 行**,
所以新 runner 的 codex steer 分支根本不会被触发,行为与今天完全一致(消息排队)。

**契约**:新 runner **不得**假设自己一定会收到 codex steer,也不得因为控制面不发 steer 而改变任何行为。
`steer_requeue` 也必须先确认控制面支持(§5.3)再用。

### 6.3 旧 Codex(没有 `turn/steer` 的版本)+ 新 runner + 新 apiserver

apiserver 不知道 codex 版本(§5.1 最后一行),所以 steer 行会被记下来并投递。runner 收到后:

1. 先看 §5.2 的握手判据。低于下界 → 直接走重排,不发请求。
2. 发了请求、收到 `E-UNSUPPORTED` → 走重排,并把本进程能力置为不支持。

两条路的终点都是"这条消息变回普通 `message`,在当前 turn 结束后作为下一轮执行" —— **不丢、不报错、晚一轮**,
与 6.1 的兜底是同一个终点。

### 6.4 部署顺序

1. **先发 runner**(带 `steerRuntimes=claude,codex` 和 codex steer 实现)。此时控制面还没开闸,
   runner 的新代码是死代码,零风险。
2. **再发 apiserver**(`supportsMidTurnSteer` 对 codex 放开 + `dequeueTurn` 按 `steerRuntimes` 门控)。
   已升级的 runner 立刻拿到 steer;没升的继续排队。
3. 反过来做也不会丢消息(6.1 的兜底顶得住),但会让未升级的 runner 上的 codex 会话多排一轮,所以按上面的顺序发。

**版本 bump 提醒**:runner 二进制是烤进 web 镜像发的。漏 bump 版本 = 旧 runner 静默不带新能力,
表现就是"codex 还是排队"。发版时必须确认 runner 版本号推进了。

## 7. 不做的事

- **不用 `turn/interrupt` + 重发来冒充 steer。** 那会产生新的 turn、新的 reply,并丢掉已经跑完的 tool 结果。
  项目 instructions 明确禁止。
- **不用 Codex 自己的队列**(`thread/queue/add` / `thread/queue/list` / `thread/queue/changed`)。
  Orbit 的 `conversation_turn` 是排队的唯一真相;引入第二个队列会造出两份互相不可见的顺序。
- **不动 permission 流程。** `mcp__orbit__permission_prompt` 保持原样,`can_use_tool` 实验不进本项目。
- **不改 Claude 路径。** `deliveryState` 词表、`steerDelivery.ts` 的四句文案、`interrupt-and-send`
  记普通 message 的语义,一个字都不动。

## 8. 待办结案表

| # | 待办 | 归属 | 结论([4/7],2026-08-21) |
| --- | --- | --- | --- |
| 1 | `E-DROPPED` 能否升级为"可证未送达 → 安全重排" | [4/7] | **裁定不升级**,见 §4.4 的方框。两种顺序都做了故障注入,行为已固定;翻案需要 app-server 侧的顺序保证 |
| 2 | Codex 处于 `waitingOnApproval` / `waitingOnUserInput` 时 `turn/steer` 的行为 | [4/7] | **不需要单独测**:§4.2 的表是**封闭**的 —— 任何认不出来的 message 一律 `E-UNKNOWN`(显式失败、retryable、**绝不重排**),所以未知状态的答复不可能造成双发。`TestAnUnrecognisedRefusalIsReportedRatherThanGuessedAt` 拿这几种 message 直接钉住了这条 |
| 3 | 带 `localImage` 附件的 steer 端到端 | [2/7] 实现 + [6/7] smoke | 未动:[2/7] 已实现(`codexSteerParams` 带 `localImage`),端到端 smoke 仍属 [6/7] |
| 4 | `turn/steer` 与 `reload`(会话中途换 provider/model)同时到达的排序 | [4/7] | **不需要新机制**。换 provider 的 reload 让 app-server 重启(`return stCancelled, false, true`),`workerCtx` 一取消,steer worker 的 drain 就把**还在排队**的全部按 `E-UNSENT` 重排(`TestMessagesStillQueuedWhenTheEngineEndsAreAllRefiled`);**已经发出请求**的那条按 `E-TIMEOUT` 显式失败(不确定,不重排)。不换 provider 的 reload(model/effort)不重启进程,steer 照常 —— 而 steer 本来就带不了 override(§1),所以两者没有需要协调的顺序 |
| 5 | `steer_requeue` 的 apiserver 幂等性与并发 | [3/7] → 实际由 [4/7] 做 | 见 §4.7 的补充 3:幂等判据是 `kind='steer' AND status='IN_FLIGHT'`,与"turn 结束降级 PENDING steer"在 `status` 上互斥。`steer-requeue.spec.ts` + `steer-dequeue.pg.spec.ts` 覆盖 |

### 8.1 [4/7] 新增的验证入口

| 测什么 | 在哪 |
| --- | --- |
| 重排 / 不确定 / 重复 / 被遗弃 四类结局,以及分类表本身 | `src/runner-go/codex_steer_recovery_test.go` |
| `steer_requeue` 的 turn-complete 语义与幂等 | `src/apiserver/src/runner-api/steer-requeue.spec.ts` |
| activate 的 `abandonedSteers` 交接(含重试路径) | `src/apiserver/src/runner-api/abandoned-steer.spec.ts` |
| 重排后的行**真的**会被 inbox 谓词交出来(真 Postgres) | `src/apiserver/src/runner-api/steer-dequeue.pg.spec.ts` 最后两条 |
| 同一 `clientTurnId` 重发只记一行 | `src/apiserver/src/sessions/steer-kind.spec.ts` 最后两条 |
