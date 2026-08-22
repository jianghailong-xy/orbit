# `turn/steer` 实测记录 — codex-cli 0.149.0

跑的是 [`probe.mjs`](./probe.mjs)(下面的编号与脚本里的 case 编号对应)。
时间戳是脚本启动后的毫秒数,左边第一列。

| 项 | 值 |
| --- | --- |
| 引擎 | `codex-cli 0.149.0`(`/root/.local/bin/codex`) |
| `initialize.result.userAgent` | `orbit-probe/0.149.0 (Debian 13.0.0; x86_64) unknown (orbit-probe; 0.1.0)` |
| 平台 | Linux 6.12.38 x86_64 / Debian 13 |
| 登录态 | ChatGPT(`codex login status`) |
| 日期 | 2026-08-21 |
| 参数 | `app-server --stdio -c sqlite_home="<tmp>"`,`approvalPolicy: never`,`sandboxPolicy: dangerFullAccess` —— 与 `codexAppServerCommandArgs` / `codexTurnParams` 一致 |

---

## 1. 拒绝路径(不花 token,`probe.mjs` 默认就跑这一段)

```
R1 no active turn      : ERROR {"code":-32600,"message":"no active turn to steer"}
R2 missing field       : ERROR {"code":-32600,"message":"Invalid request: missing field `expectedTurnId`"}
R3 bad thread id       : ERROR {"code":-32600,"message":"invalid thread id: invalid character: expected an optional prefix of `urn:uuid:` followed by [0-9a-fA-F-], found `t` at 1"}
R4 unknown method      : ERROR {"code":-32600,"message":"Invalid request: unknown variant `turn/steerX`, expected one of `initialize`, …, `turn/start`, `turn/steer`, `turn/interrupt`, …"}
R5 unknown params field: ERROR {"code":-32600,"message":"no active turn to steer"}
```

四件事:

1. **所有失败都是 `-32600`**,包括方法根本不存在(R4 不是 `-32601`)。按 code 分类拿不到任何信息,只能按 message 前缀分类。
2. R4 的 message 里会**列出该版本支持的全部方法名** —— 这就是"旧 Codex 没有 `turn/steer`"的运行期判据:`unknown variant \`turn/steer\``。
3. R5:params 里多塞未知字段**不报错**,直接进到 "no active turn" 检查。app-server 对 params 不是 `deny_unknown_fields`。
4. R2 证明 `expectedTurnId` 在 wire 上确实是必填(和 schema 的 `required` 一致)。

## 2. 能力探测:`experimentalApi` 与旧版本

| 组合 | `turn/steer` 结果 |
| --- | --- |
| 0.149.0,`capabilities.experimentalApi: true` | `-32600 no active turn to steer`(方法存在) |
| 0.149.0,**不带** `capabilities` | `-32600 no active turn to steer`(方法存在) |
| 0.145.0(`/usr/lib/node_modules/@openai/codex`),`experimentalApi: true` | `-32600 no active turn to steer`(方法存在) |

→ `turn/steer` **不在 experimental 闸门后面**,0.145.0 就已经有了。本机能拿到的两个版本都支持,
所以**引入版本无法从本机确定**,契约因此不押具体 floor,只押运行期判据(见契约文档 §5)。

## 3. Case A:steer 进入正在跑的 turn

turn 是 `sleep 40` 的长 tool call,steer 在 tool 跑到一半时发出。

```
 64593 turn/start: OK {"turn":{"id":"01a02539-dabf-7752-9856-7b701e1871af","status":"inProgress",…}}
 64612 NOTE thread/status/changed {"status":{"type":"active","activeFlags":[]}}
 64612 NOTE turn/started        {"turn":{"id":"01a02539-dabf-…","startedAt":1787330943,…}}
 68885 NOTE item/started   userMessage id=01a02539-ebe0-… clientId="orbit-turn-A"
 68891 NOTE item/completed userMessage id=01a02539-ebe0-… clientId="orbit-turn-A"
 70555 NOTE item/started   agentMessage msg_0751189…
 70598 A1 wrong expectedTurnId: ERROR {"code":-32600,"message":"expected active turn id `01a02539-0000-…` but found `01a02539-dabf-7752-9856-7b701e1871af`"}
 71051 NOTE item/completed agentMessage "I'm running the command now and will wait for it to finish."
 71119 A2 correct              : OK {"turnId":"01a02539-dabf-7752-9856-7b701e1871af"}
 72519 NOTE item/started   commandExecution exec-c5486e17-…
 72622 A3 duplicate clientUserMessageId : OK {"turnId":"01a02539-dabf-7752-9856-7b701e1871af"}
 74125 A4 with a `model` override        : OK {"turnId":"01a02539-dabf-7752-9856-7b701e1871af"}
102551 NOTE item/started   userMessage id=01a0253a-6f66-… clientId="orbit-steer-1"   ← A2 的回显
102551 NOTE item/completed userMessage id=01a0253a-6f66-… clientId="orbit-steer-1"
102581 NOTE item/started   userMessage id=01a0253a-6f84-… clientId="orbit-steer-1"   ← A3 的回显(同一个 clientId,不同 item id)
102582 NOTE item/completed userMessage id=01a0253a-6f84-… clientId="orbit-steer-1"
102598 NOTE item/started   userMessage id=01a0253a-6f95-… clientId="orbit-steer-2"   ← A4 的回显
102598 NOTE item/completed userMessage id=01a0253a-6f95-… clientId="orbit-steer-2"
112378 NOTE item/completed commandExecution exec-c5486e17-…
117201 NOTE item/started   agentMessage msg_0751189…
117411 NOTE item/completed agentMessage "ALPHA\nBRAVO"
117560 NOTE thread/status/changed {"status":{"type":"idle"}}
117561 NOTE turn/completed status=completed turn.id=01a02539-dabf-7752-9856-7b701e1871af
119134 A5 steer after the turn ended: ERROR {"code":-32600,"message":"no active turn to steer"}

thread/read includeTurns=true → turn count: 1
  turn 01a02539-dabf-… completed
    userMessage(orbit-turn-A) | agentMessage:"I'm running the command…"
  | userMessage(orbit-steer-1) | userMessage(orbit-steer-1) | userMessage(orbit-steer-2)
  | agentMessage:"ALPHA\nBRAVO"
```

读出来的事实:

- **A2 成功**:`result.turnId` 等于 `expectedTurnId`,**没有第二条 `turn/started`**,`thread/read` 里也只有 **1 个 turn**。回复只有一条(`ALPHA\nBRAVO`),steer 的内容被折进了同一条最终回复 —— 项目验收 2 要的就是这个。
- **A1 的错误消息带上了双方的 id**:`expected active turn id \`X\` but found \`Y\``。
- **A3 是本次调研最关键的一条**:重发**完全相同的 `clientUserMessageId`**,Codex **接受了,并且在会话里插了第二条 userMessage**(两条 item id 不同、`clientId` 都是 `orbit-steer-1`)。
  → **Codex 不按 `clientUserMessageId` 去重。** at-most-once 必须由 Orbit 自己保证。
- **A4**:文档说 `turn/steer` 不接受 turn 级 override,但 0.149.0 **不报错**,静默忽略 `model`。不能靠它拒绝来兜底,只能不发。
- **接受 ≠ 模型看见**:A2 在 `71119` 返回 OK,回显 `item/*` 到 `102551` 才出现 —— **相差 31.4 秒**。Codex 把 steer 缓冲住,等当前 tool call 跑完、构造下一次模型请求时才注入。
- `clientUserMessageId` 的回显位置是 `item/started|completed` 的 `item.clientId`(item 类型 `userMessage`),`thread/read` 的 turn items 里也在。这是**唯一**的关联键。

## 4. Case B:turn 被 interrupt 时,缓冲中的 steer 被静默丢弃

```
 55151 turn/start -> 01a02541-e678-7003-883f-a54c42cb8a43
 55158 immediate steer (+6ms): OK {"turnId":"01a02541-e678-7003-883f-a54c42cb8a43"}
 58105 item/completed userMessage clientId="A"          ← 只有开场白回显了
 59883 item/completed agentMessage "I'm starting the 25-second wait now."
 63262 turn/interrupt (+88ms): OK
 63265 turn/completed status=interrupted
 63281 steer right after interrupt (+18ms): ERROR {"code":-32600,"message":"no active turn to steer"}
 69289 steer 6s after interrupt          : ERROR {"code":-32600,"message":"no active turn to steer"}

thread/read → turn 01a02541-e678-… interrupted  items: userMessage(A) | agentMessage
```

- `turn/start` 返回之后 **6ms** 就 steer 也是成功的 —— 不存在"turn 还没真正开始"的窗口。
- **`clientUserMessageId: "B-steer"` 的回显从未出现,`thread/read` 里也没有这条 userMessage。**
  steer 被 Codex 收下(返回 OK)、缓冲住、然后随着被 interrupt 的 turn 一起丢掉了,**没有任何通知**。
  → **`turn/steer` 返回 OK 不等于消息进了会话。** 这是本次找到的唯一一个"接受了但丢了"的路径。
- `turn/interrupt` 返回后 18ms 再 steer 已经是 `no active turn to steer`,不存在中间态。

## 5. Case C:steer 撞上 turn 自然结束

短 turn(只回一个 OK),从 `turn/start` 返回起等 N 毫秒再 steer:

```
C delay=0ms    steer=ACCEPTED  echoed=true   turnStatus=completed   (echoes: ["A0","S0"])
C delay=1200ms steer=ACCEPTED  echoed=true   turnStatus=completed   (echoes: ["A1200","S1200"])
C delay=2500ms steer=ACCEPTED  echoed=true   turnStatus=completed   (echoes: ["A2500","S2500"])
C delay=4000ms steer=REJECTED "no active turn to steer" echoed=false turnStatus=completed (echoes: ["A4000"])
```

**没有中间态**:要么被接受并且一定回显进了会话(Codex 会把 turn 拖住等它折进去),
要么被 `no active turn to steer` 干净拒掉、完全没进会话。
自然结束这条路径上,不存在 Case B 那种"接受了但丢了"。

## 6. 复现

```bash
codex --version                                            # 记下版本
codex app-server generate-json-schema --out /tmp/cxschema  # v2/TurnSteerParams.json 等
node docs/evidence/codex-turn-steer-0.149.0/probe.mjs          # 只跑拒绝路径,不花 token
node docs/evidence/codex-turn-steer-0.149.0/probe.mjs --live   # 跑 A/B/C,要登录、花 token、约 5 分钟
```

Go 侧的常驻回归见 `src/runner-go/codex_steer_protocol_test.go`(PATH 上没有 `codex` 时自动 skip)。
