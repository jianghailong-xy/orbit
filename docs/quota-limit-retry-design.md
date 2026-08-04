# 配额撞限的重试设计（Rate-limit retry）

撞上 provider 配额上限时，Orbit 目前把它当作一次成功的回复。本文档设计两件事：**认出它**、
**到点自己接上**。

> **实施记录（2026-08-03）**：v1 已实现，与本文最初的设计有六处偏离，都在 §8 列明并说明理由。
> 读本文时以 §8 为准。

---

---

## 1. 现状：一次真实事故

案发现场就是写这份文档的 session（`019fc863-14eb-7413-a7e6-6835cd1fdc1b`）。DB 原始记录：

| seq | type | payload |
|---|---|---|
| 1 | user | 用户提问（16:09:25） |
| 2–3 | system | init / status |
| 4 | assistant | `You've hit your session limit · resets 6:20pm (Europe/Berlin)` （16:09:33） |
| 5 | turn_end | `{"subtype":"success","numTurns":1,"costUsd":0}` |
| 6 | user | `continue`（**16:22:15**，用户手动发的） |

`conversation_turn` 里那一轮的状态是 **ANSWERED**。也就是说：

1. **归类错了。** 这条文本既不以 `API Error` 开头，也不是 `Failed to authenticate`，于是
   `resultFrom` 和 `session.go:1425` 的两条 rescue 都不认它 —— turn 记成成功，session 正常
   park，没有任何地方留下"这轮其实什么都没干"的痕迹（`numTurns:1 / costUsd:0` 是唯一线索）。
   这和 [claude-login-expired-guide] 修过的那个类别错误是同一个。
2. **没有补救入口。** transcript 里只有一行裸文本，没有按钮。
   `AuthErrorCard` 已经有 "Retry — re-send my last message"，但只对 auth 错误开放。
3. **恢复时间没人管。** `6:20pm` 只存在于那一行字里。用户得自己盯钟、自己回来、自己想
   起来发什么 —— 上面这次是 **13 分钟的人肉等待**，还得靠 "continue" 这种含糊的续写指令。
4. **能力不对等。** 任务侧早就有配额门控（`tasks.service.ts` 的 `quotaBlockedRunners()` +
   `planUsageBlockedUntil()`：配额没恢复就不派活，且这类失败不计入任务的失败预算）。
   交互式 session 一点都没有。

---

## 2. 目标 / 非目标

**目标**
- 撞限当场被认出来，卡片说清楚：撞的是哪个窗口、什么时候恢复、恢复后会自动发什么。
- 到点服务端自动续上，**不依赖浏览器开着**（撞限最常发生在长任务里，人早就走开了）。
- 自动续上要么成功，要么明确地停在手动 —— 不制造重试风暴。

**非目标（v1 明确不做）**
- 换 provider 重试（"Claude 满了就跑 Codex"）。跨 runtime resume 会丢上下文
  （见 [resume-rebuild-transcript-from-run-event]：反向只能 inject_items 摘要），
  是独立课题，不塞进这里。
- 预测性削峰（快撞限了提前提醒 / 自动降级模型）。
- 多副本调度。沿用 reaper 的单副本前提。

---

## 3. 设计

### 3.1 识别：`isUsageLimitText`

DB 里实际出现过的全部变体（`select distinct` 捞的，不是猜的）：

```
You've hit your session limit · resets 6:20pm (Europe/Berlin)
You've hit your session limit · resets 10:10am (Europe/Berlin)
You've hit your weekly limit · resets 1pm (Europe/Berlin)
You've hit your weekly limit · resets Aug 3, 1pm (Europe/Berlin)      ← 跨天才带日期
You've hit your usage limit. Visit https://…/usage … try again at Aug 9th, 2026 1:26 PM.   ← Codex
```

判定沿用现有风格：小写 `contains` 一组 marker，只收录**实际见过**的措辞。

```ts
// @orbit/shared events.ts —— 扩充已有的 USAGE_LIMIT_ERROR_MARKERS
export const USAGE_LIMIT_ERROR_MARKERS = [
  'hit your usage limit',    // Codex app-server（已有）
  'hit your session limit',  // Claude Code，5 小时窗口
  'hit your weekly limit',   // Claude Code，7 天窗口
];
```

`isUsageLimitErrorText()` 已经存在且正好是这个语义，直接复用；Go 侧新增对称的
`isUsageLimitError`（`claude.go`，紧挨 `isAPIError` / `isAuthError`）。

**三个判定必须互斥且remedy不同**，这是它们分开的全部理由：

| 判定 | 谁能修 | 补救 |
|---|---|---|
| `isAPIError` | 模型/服务 | 直接重试可能就好了 |
| `isAuthError` | 人 | 去登录 / 换 key，**重试无用** |
| `isUsageLimitError` | 时间 | **等到点，然后自动重试** |

### 3.2 恢复时间：双源，优先机器可读

文案里的 `6:20pm (Europe/Berlin)` 能看，但当调度依据太脆（无日期、本地化、随 CLI 版本变）。

**源 A（权威）— runner 的用量探针。**
`planusage.go` 已经在轮询 `https://api.anthropic.com/api/oauth/usage`（active 2 分钟一次），
产出带 ISO `resetsAt` 的 `fiveHour` / `sevenDay` 窗口，随 heartbeat 上报到 `runner.plan_usage`。
`planUsageBlockedUntil(usage, provider, now)` 已经能把它折算成"何时解封"。**直接复用。**

> ⚠️ **实施第 0 步（待验证假设）**：线上快照 `{"fiveHour":{"utilization":0}}` 在未撞限时
> 不带 `resetsAt`。**必须先实测撞限当时 `utilization` 是否为 100 且带 `resetsAt`。**
> 若不带，源 A 失效，源 B 就从兜底升为主路径 —— 这一步的结论决定后面的实现权重，先验证再动手。

撞限那一刻探针的快照可能落后最多 2 分钟，所以加一个 **kick**：runner 认出 limit 文本时
立即触发一次 probe 刷新（`planUsageProbe` 现在没有外部触发通道，加一个 buffered chan，
runloop 里 select 一下，约 20 行），并把刷新后的窗口跟着 turn 结果一起上报。

**源 B（兜底）— 解析文案。**
`resets [<Mon D>, ]<h>[:mm]<am|pm> (<IANA TZ>)`。括号里就是 IANA 时区名，`Intl.DateTimeFormat`
可以反推偏移。缺日期时取"下一个该时刻"。

**两源都拿不到 → 只给手动 Retry，不承诺自动。** 与 `planUsageBlockedUntil` 的既有原则一致：
没有站得住脚的恢复时刻，就不要假装有。

窗口名（session limit / weekly limit）只用于**卡片文案**，不参与调度 —— 调度只认时间。

### 3.3 状态：把这一轮记成 FAILED

runner `session.go:1425` 那处 rescue 加上第三个判定：

```go
if turnStatus == stSucceeded &&
   (isAPIError(...) || isAuthError(...) || isUsageLimitError(r.Result) || isUsageLimitError(lastAssistantText)) {
    turnStatus = stFailed
}
```

apiserver reaper 同样补一条兜底（`reaper.service.ts:192` 已有 `isApiErrorText || isAuthErrorText`
的分支，加上 `isUsageLimitErrorText`）—— **runner 只在启动时/每 10 分钟自更新，老 runner 会跨版本
存活**，这条兜底是 [claude-login-expired-guide] 已经踩过的坑。

**session 状态不新增。** 撞限的 session 照旧 park 在 `AWAITING_INPUT`（用户随时能插话，
语义本来就对），"等配额"是挂在它上面的一个待办，不是一种新生命体：

```prisma
model Session {
  quotaRetryAt        DateTime?   // 到点自动重试的时刻；null = 不自动（未知恢复时间 / 用户关掉了 / 已用尽）
  quotaRetryAttempts  Int      @default(0)
  @@index([quotaRetryAt])
}
```

只要两个字段：用户关掉自动重试 = 把 `quotaRetryAt` 清成 null，不需要第三个 opt-out 布尔。

任务侧同时受益：`autoRunHoldOff()` 已经把 usage-limit 失败排除在任务失败预算之外，
但它靠的是 `session.error` 的文本匹配 —— turn 现在记 FAILED 了，`session.error` 会带上这段
文本，那条 `NOT contains` 过滤自然生效（今天它其实**匹配不到**，因为这类 session 压根没被记成
FAILED）。

### 3.4 重试语义：重发什么

不是所有撞限都发生在同一位置，重发内容必须跟着变：

| 撞限位置 | 判据 | 重发内容 |
|---|---|---|
| **回合开头**（本次事故） | limit 文本是这一 turn 的**第一条** assistant 事件，且无 tool_use | **原样重发上一条用户消息** —— 它根本没被处理（`numTurns:1, costUsd:0`） |
| **回合中途**（长任务跨过 5h 边界） | 这一 turn 已产生过 tool_use / 非空 assistant 文本 | 发 `Continue where you left off.` —— resume 带 `runtimeSessionID`，历史还在，重发原消息会让它从头再做一遍 |

取"上一条用户消息"直接复用 `authRetryText(events, openingPrompt, numTurns)`
（`src/web/src/lib/authRetry.ts`，含首轮撞限时回退到 opening prompt 的处理）。
服务端自动重试需要同一份逻辑，**下沉到 `@orbit/shared`**，web 与 apiserver 共用一份，
避免手动/自动两条路重发出不同的东西。

### 3.5 UI：Rate-limit 卡片

结构照抄 `AuthErrorCard`（`Transcript.tsx`）：新增 `quotaLimit` 节点 + `QuotaLimitCard`，
经 `QuotaLimitCtx` 从 `AgentView` 拿 session 上下文。文案英文（对齐 [ui-english-standardization]）。

**视觉稿**：`docs/mocks/quota-limit-retry.html` —— 全部状态、亮暗两套，引的是 web 真实的
`index.css` 与色板 token，卡片 CSS 就是将来要落进 `index.css` 的那段。渲染：

```sh
chromium --headless --no-sandbox --force-device-scale-factor=2 --window-size=860,1600 \
  --screenshot=light.png docs/mocks/quota-limit-retry.html      # 加 ?dark 出暗色
```

**卡片的强度跟着"还需不需要你动手"走**，这是这张图确立的原则：

| 状态 | 谁的球 | 视觉 |
|---|---|---|
| A 已武装 / B 重试中 / E 中途撞限 | 我们的 —— 已经接手 | 中性（`--bg-raised` + 灰时钟） |
| C 恢复时间未知 / D 重试放弃 | 用户的 | warning 橙（与 sign-in 卡片同款） |

配额撞限**不是错误，是暂停**。自动重试开着的时候它甚至是"已经安排好了"，长期橙着刺眼且
在说谎；只有当球回到用户脚下，卡片才升级成警告色。

其余细节（引用要重发的内容、`Retry now anyway` 的降级样式、`Resumed automatically at …`
那条分隔线）见 mock 中的注释。

- **恢复时间**：绝对时刻（观看者本地时区）+ 相对倒计时。倒计时每分钟走，归零后卡片自己
  变成 "Retrying…"。
- **自动重试开关**：默认 **on**，但**仅在 3.2 拿到了可信恢复时刻时才出现**。关掉 =
  `quotaRetryAt := null`，卡片降级为只剩 `Retry now`。
- **引用要重发的内容**：沿用 auth 卡片那条理由 —— "my last message" 是读者无法核对的承诺，
  所以把它夹引号显示出来（clamp 两行）。中途撞限时这里显示 "Will continue where it left off"。
- **`Retry now`**：恢复时刻还没到时，样式降为次要 + 文案 `Retry now anyway`，
  下面小字 "The quota hasn't reset yet — this will likely fail again."。**不禁用** ——
  用户可能刚换了 provider/加了 credits，我们不比他更清楚。
- **分享页 / 静态导出**：无 ctx → 只显示诊断，不给按钮（和 auth 卡片同款降级）。

移动端（iOS/macOS）在 v1.1 对齐，形态一致。

### 3.6 自动重试的执行：服务端

**挂在 reaper 的 sweep 里**（`reaper.service.ts`，已有 15s 定时器和单副本前提），不新起定时器。

每轮：

```
取 sessions where quotaRetryAt <= now
                  and status = AWAITING_INPUT
                  and deletedAt is null and completedAt is null and cancelRequestedAt is null
按 (runnerId, provider) 分组，每组本轮只放行最早的一个        ← 防重试风暴
对放行的每个 session：
  1. 复查 planUsageBlockedUntil(runner.planUsage, provider, now)
     若仍被封 → quotaRetryAt := 那个新时刻，本轮跳过（快照滞后是常态，不是错误）
  2. attempts >= 5 → quotaRetryAt := null，留给人（卡片变成纯手动）
  3. resume(ownerId, sessionId, { content: 按 3.4 算出的文本 })
     成功 → quotaRetryAt := null, attempts := 0
     失败 → attempts++，quotaRetryAt := now + backoff[attempts]（2/5/10/20/30 分钟）
```

**幂等**：`quotaRetryAt` 的清空与 resume 在同一步完成，且服务端单点执行 —— 多设备打开
同一 session 不会重复触发（这也是自动重试必须放服务端、不能放前端定时器的原因之一，
另一个是浏览器关掉就没了）。

**取消条件**（任一发生即 `quotaRetryAt := null`）：
- 用户在等待期间自己发了消息 —— 他已经接管了，别再替他发。
- session 被 Complete / Delete / Cancel / 结束。
- 用户在卡片上关掉开关。

**抖动**：写入 `quotaRetryAt` 时加 0–60s 随机偏移。配额是账号级的，同一账号下几十个 session
会在同一秒解封，齐步冲进去只会集体再撞一次。

### 3.7 通知

复用 `push.service.ts`（已有 `notifyApprovalRequest` 先例）：自动重试**成功接上**时推一条
"Resumed after quota reset"。撞限当时不推（用户多半正在看）。SSE 侧走已有的 session 事件通道，
卡片状态实时变。v1 可选，v1.1 必做 —— 自动重试的价值恰恰在人不在场时。

---

## 4. 边界与失败模式

| 情况 | 处理 |
|---|---|
| 恢复时刻拿不到 | 不承诺自动；卡片只给 `Retry now` |
| 到点了快照仍显示未恢复 | 顺延到快照给的新时刻，不消耗 attempts |
| 连续 5 次重试都失败 | 停手动，卡片提示 "Auto-retry gave up after 5 tries" |
| 等待期间用户自己发消息 | 取消自动重试（他接管了） |
| 同一账号几十个 session 同时到点 | 每组每轮放行一个 + 0–60s 抖动 |
| 老 runner（未升级）撞限 | reaper 兜底识别；kick 刷新拿不到就走源 B |
| 撞限时有排队消息 | 照常排队（`conversation_turn` 语义不变），重试成功后自然被消费 |
| weekly limit（要等好几天） | 机制相同。卡片显示日期而非时刻；attempts 上限不变 |

---

## 5. 分期

**v1（一个分支做完）**
1. **先验证 3.2 的源 A 假设** ← 阻塞项，决定后面的实现权重
2. `@orbit/shared`：扩 markers、下沉 `lastUserMessageText`、加恢复时刻解析（源 B）+ 单测
3. runner：`isUsageLimitError`、turn 记 FAILED、probe kick
4. apiserver：两个 Prisma 字段 + migration、reaper 识别兜底、reaper 自动重试 sweep + 单测
5. web：`QuotaLimitCard` + ctx 接线 + 开关 API

**v1.1**：iOS / macOS 卡片对齐、push 通知、账号级默认开关（`UserPreferences`，
参照 [effort-default-synced-preference]）

**部署**：改了 runner-go + apiserver + web，**不是 web-only**，需全量 `/upgrade`（从 `/root/orbit` 跑）
+ bump runner 版本让各 runner 自更新。见 [web-only-deploy-protect-apiserver]、[image-delivery-missing-version-bump]。

---

## 6. 验收标准

1. 造一次撞限（或用 fixture 回放 seq 1–5），transcript 出现 `QuotaLimitCard`，
   显示正确的窗口名与本地时区恢复时刻。
2. 那一轮 `conversation_turn.status = FAILED`（今天是 ANSWERED）。
3. **关掉浏览器**，恢复时刻过后，服务端自动重发原始消息，session 继续跑。
4. 等待期间用户手动发消息 → 自动重试不再触发（DB 里 `quotaRetryAt` 为 null）。
5. 同一账号 3 个 session 同时到点 → 不在同一秒发起，全部最终成功。
6. 恢复时刻不可知时，卡片无开关、只有 `Retry now`。

---

## 7. 需要拍板

1. **自动重试默认开还是默认关？** 建议**默认开**（本文按此写）—— 这正是需求原话，且仅在
   恢复时刻可信时才生效，风险面很窄。**已按默认开实现。**
2. **attempts 上限 5 / 退避 2-5-10-20-30 分钟** 是拍的，可调。weekly limit 场景下 5 次约覆盖
   1 小时的快照滞后，够用。**已按此实现。**
3. **v1 要不要带 push 通知？** 建议带 —— 自动重试的全部价值在于人不在场，不通知就只能靠回来刷。
   **未做**，见 §8.5。

---

## 8. 实施与设计的偏离（2026-08-03）

写代码时发现六处，前两处是本文最初写错了：

### 8.1 turn **不**记 FAILED（§3.3 作废）

原设计要 runner 把撞限的 turn 标 FAILED。**这会踩坑**：turn 记 FAILED 会触发
`reclaimStalledTask` → task 打成 FAILED → auto-run backoff 接手重跑，与 `quotaRetryAt` 形成
**两套重试机制并行**（[auto-run-reconciler-retry-storm] 就是这类事故）。

改为：session 照旧停在 `AWAITING_INPUT`（语义本来就对 —— 它在等人说话，而那个人是我们），
只挂 `quotaRetryAt`。§1 说的"归类错了"其实质危害是"没人管"，现在有人管了。

副作用是好的：**runner-go 完全不用改**，因此不需要等 runner 自更新，也没有跨版本兼容问题。

### 8.2 检测点在 apiserver 摄入，不在 runner

原设计在 runner 的 `session.go` 认，apiserver reaper 兜底。实现改为**只在
`runner-api.controller.ts` 的事件摄入处认**（`lastAssistant` 已经算好了）。老 runner 自动
覆盖，不需要兜底路径，少一处需要保持同步的判定。

### 8.3 不做 probe kick（§3.2 简化）

原设计要 runner 撞限时立即刷新配额快照。实测发现 `planUsage.go` 的 `planUsageRefreshDue()`
**已经**会在 reset 时刻过后 15 秒强制刷新，而 active 状态下本来就 2 分钟一轮 —— 而我们要等
到 reset 才用它。文案解析（源 B）负责撞限当场的显示，快照（源 A）在 sweeper 真正开火前复查。
kick 是纯多余的。

### 8.4 mid-turn 撞限不区分（§3.4 的第二行未实现）

`messageToResend()` 永远重发最后一条用户消息。区分"回合中途撞限 → 发 continue"需要在摄入时
判断这一 turn 是否已产生实质事件，是额外状态；且实测 DB 里的 5 条撞限记录**全部**是回合开头
（`numTurns:1, costUsd:0`）—— 5 小时窗口内撞限只会发生在请求发出时。留给 v1.1。

### 8.5 未做：push 通知、re-arm API、"自动恢复"分隔线

- **push 通知**：§7 里我自己建议要带，没做。这是 v1 最值得补的一块。
- **re-arm API**：设计图里画过 "Arm auto-retry again" 按钮。实现时发现它需要一个**没人有的
  信息** —— 重新武装要一个新的 reset 时刻，而此时配额快照要么给得出（那说明还封着，本来就会
  自己顺延）要么给不出（那就是可以直接重试）。按钮删了，D 状态只留 `Retry now`。
- **"Resumed automatically at …" 分隔线**：需要在事件流里插标记（污染 `run_event` 或再加字
  段）。替代方案已实现且够用：**任何新的用户消息都会让上方的配额卡片转为静态历史**
  （`quotaOutageOver()`），所以"卡片 → 紧接着一条重发的消息"这个因果在 transcript 里是看得见
  的。顺带修掉一个真 bug：重试成功后 `quotaRetryAt` 被清空，卡片会翻成橙色警告说"无法重试"。

### 8.6 自成一个 sweeper，不挂在 reaper 上（§3.6 的落点变了）

原设计说"挂在 reaper 的 sweep 里，不新起定时器"。实现是独立的
`src/apiserver/src/sessions/quota-retry.service.ts`（自己的 30s `setInterval`，`unref()`）。

理由是职责，不是工程洁癖：**reaper 的工作是把卡住的东西结束掉**，它的每条分支最后都通向
"finalize 它"；配额重试要做的恰好相反——把一个只是在等的会话**重新启动**。塞进 reaper 意味着
这条路径会继承一个"兜底就是终结它"的默认行为，那正是最不该发生的事（撞限不是错误，是暂停）。

其余按 §3.6 原样：只取 `AWAITING_INPUT` 且未删除/未完成/未请求取消的会话；每 (runner, provider)
每轮只放行一个；重试前用条件写（conditional update）抢占那一行，所以并发的用户消息或第二次
sweep 会输掉竞争而不是发出第二条 turn；退避仍是 2/5/10/20/30 分钟、上限 5 次。单副本前提与
reaper 相同。另加一条实现细节：每轮最多取 50 条（`MAX_PER_SWEEP`），积压跨轮消化。
