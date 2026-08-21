# Codex `turn/steer` 接入契约(冻结版 v1)

**状态**:冻结。本文件是 [1/7] 的产物,是 [2/7](Runner 实现)、[3/7](控制面能力门控)、
以及后续竞态/故障注入任务的**唯一权威**。改这里的任何一条,必须同时改依赖它的任务。

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
  给 [4/7] 的故障注入留一条待办:如果能证明回显与 `turn/completed` 有严格顺序,这条可以升级成"可证未送达 → 安全重排"。
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
一旦 ANSWERED 就永远不会再投递,消息就没了。给 [2/7] / [3/7] 的接口约定:

- wire:`TurnCompleteRequest.Subtype = "steer_requeue"`(新常量,与现有 `"steer"` 并列),`Status: SUCCEEDED`。
- apiserver 语义:把该行从 `kind='steer', status='IN_FLIGHT'` 改回 `kind='message', status='PENDING'`,
  **保持同一 seq、同一 clientTurnId**(与 turn-complete 里既有的"PENDING steer 降级成 message"完全一致,
  只是触发者从"turn 结束了"变成"runner 说它送不进去")。
- 幂等:同一 turnId 重复报 `steer_requeue` 必须只生效一次(行已经是 `kind='message'` 时是 no-op)。
- 旧 apiserver 收到未知 subtype 会当成普通 steer ack(标 ANSWERED)→ 消息丢失。所以
  **`steer_requeue` 必须受 §5 的能力门控保护**:runner 只在控制面明确支持时才走这条路。

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

把 `?acceptsSteer=1` 这个 bool 升级成**按 runtime 列举**:

```
GET /runner/sessions/:id/inbox?leaseGeneration=…&acceptsSteer=1&steerRuntimes=claude,codex
```

- `acceptsSteer=1` 的含义**不变**(向后兼容):"我认识 `steer` 这个 kind"。
- `steerRuntimes` 新增:"这些 runtime 我能真正送达"。**缺省(旧 runner 不发)时按 `claude` 处理** ——
  这正好等于今天所有在跑的 runner 的真实能力。
- apiserver `dequeueTurn` 的那个 bool 从"poller 认识 steer"变成"**poller 能 steer 这个 session 的 runtime**":
  每次 inbox 请求解析一次该 session 的 runtime(`execRuntime`,与 `runtimeTakesSteer` 同一套),
  再看它在不在 `steerRuntimes` 里。SQL 里 `AND ${acceptsSteer}::boolean` 那一行不用动,只是喂给它的值变准。

**反方向的信号**(控制面 → runner)解决 §4.7 的 `steer_requeue` 门控:在 `RunInboxResponse` 上加
`steerRequeue?: boolean`,**随这条 steer 本身投递**(投递即答复,不用另开一次往返,也不用 runner 记全局状态)。

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

**契约:控制面对 codex 开闸,必须由 §5.3 的 `steerRuntimes` 把关,不得只看 runtime。**
即 `createTurn` 里 `kind='steer'` 之外,`dequeueTurn` 必须确认 poller 自称能 steer codex。
旧 runner 不发 `steerRuntimes` → 视为只支持 claude → codex 的 steer 行**留在 PENDING**
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

## 8. 留给后续任务的待办

| # | 待办 | 归属 |
| --- | --- | --- |
| 1 | `E-DROPPED` 能否升级为"可证未送达 → 安全重排":需要证明 userMessage 回显与 `turn/completed` 的顺序是严格的 | [4/7] 故障注入 |
| 2 | Codex 处于 `waitingOnApproval` / `waitingOnUserInput`(`ThreadActiveFlag`)时 `turn/steer` 的行为 —— 本次没测(Orbit 用 `approvalPolicy: never`,很难构造) | [4/7] |
| 3 | 带 `localImage` 附件的 steer 端到端(schema 支持,本次只测了纯文本) | [2/7] 实现 + [6/7] smoke |
| 4 | `turn/steer` 与 `reload`(会话中途换 provider/model)同时到达的排序 | [4/7] |
| 5 | `steer_requeue` 的 apiserver 幂等性与并发(同一行同时被 requeue 和被 turn-complete 降级) | [3/7] |
