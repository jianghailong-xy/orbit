# Codex earned rate-limit reset 跨层契约（v1）

**状态**：任务「同步最新 main 并定义 Codex reset 跨层契约」的产物，是项目「Orbit：Codex 使用额度 Reset 能力」
其余实现与验证任务的接口来源。任何线上字段、枚举、时限或状态转移的改动，都必须先改
[`contracts/codex-rate-limit-reset.contract.json`](../contracts/codex-rate-limit-reset.contract.json)：
shared 与 runner-go 两侧的契约测试读同一份文件，任何一侧没跟上都会变红。

**基线**：`origin/main` = `677300e128d79b154e45322db9ff9885276b6512`
（2026-09-11 04:22 +02:00，`fix(native): what delivery appended is read from the recorded note on iOS and macOS too, …`）。
本契约的分支从该提交开出；开工时 `git fetch` 确认 0 ahead / 0 behind。

**权威来源**

| 来源 | 位置 |
| --- | --- |
| Codex App Server 协议 | 本机 `codex-cli 0.154.0` 的 `codex app-server generate-json-schema`，逐字节存于 [`docs/evidence/codex-rate-limit-reset-0.154.0/`](./evidence/codex-rate-limit-reset-0.154.0/) |
| 机器可读契约 | `contracts/codex-rate-limit-reset.contract.json` |
| 跨语言 wire fixtures | `contracts/codex-rate-limit-reset.fixtures.json` |
| 可执行定义（TS） | `src/shared/src/dto.ts`（DTO）、`src/shared/src/codexRateLimitReset.ts`（纯函数） |
| Go 镜像 | `src/runner-go/codex_rate_limit_reset.go`、`PlanUsage.RateLimitReset`、`HeartbeatResponse.CodexRateLimitResetRequest` |
| 契约测试 | `src/shared/src/codexRateLimitReset.spec.ts`、`src/runner-go/codex_rate_limit_reset_test.go` |

**本任务不做**：不接 heartbeat 与 plan-usage probe、不建表、不做 UI、不声明 capability、不启动 Codex 进程。
测试全部是纯函数与 fixture，没有调用任何 provider 方法，没有消费任何 credit。

---

## 0. 一页结论

1. **数量只认 `rateLimitResetCredits.availableCount`。** `credits` 明细为 `null`（只知道数量）、`[]`（取过明细但没有）
   或短于 `availableCount`（被截断）时都不推算数量；明细读不懂时整张明细置 `null`，数量不动。
2. **consume 参数恒为 `{ "idempotencyKey": <operation 的 providerIdempotencyKey> }`。** v1 不选具体 credit，
   command 里出现 `creditId` 即为非法 command。
3. **两把幂等键各管一层。** `clientRequestId`（Web 每次确认生成一次）去重 POST；`providerIdempotencyKey`
   （apiserver 建行时生成的 UUID）去重上游 consume，只随 CONSUME command 下发，不出现在任何用户 API 与日志里。
4. **两个检查点分开持久化。** `consumeState` 与 `refreshState` 各自单调前进；consume 一旦 CONFIRMED，
   就只会再发 REFRESH command，永远不会再发 CONSUME。
5. **每次投递都被 claim 围栏。** `(leaseOwner, claimGeneration)`：同一进程重投不换代；别的进程只在 claim
   满 60 秒后接管并加一代；回执不属于当前 claim 就拒绝，除非它只是重述一个已记录的事实。
6. **同一 runner + 账户同时至多一个在途 operation**（PENDING / CONSUMING / REFRESHING）。
7. **快照块单调。** 按 `fetchedAt`（read 开始时间，毫秒）比较，同毫秒同进程再比 `sequence`；旧进程与乱序
   heartbeat 覆盖不了新值。
8. **旧 heartbeat 照常解析。** 没有 `rateLimitReset` 表示“不提供 reset”，不是“0 个 credit”。

---

## 1. 上游协议对照（codex-cli 0.154.0）

### 1.1 `account/rateLimits/read`

- params：`GetAccountRateLimitsParams | null` = `{ supportsLunaReserve?, excludeResetCreditDetails? }`。
  **Orbit 不传 `excludeResetCreditDetails`**：到期信息要靠明细，probe 周期为 5 / 10 分钟，代价可接受。
- response 只有 `rateLimits` 必填；与 reset 有关的顶层字段都可选且可为 null：

| 字段 | 上游类型 | 上游说明（原文） | Orbit 处理 |
| --- | --- | --- | --- |
| `rateLimitResetCredits` | `RateLimitResetCreditsSummary \| null` | — | 键缺失：CLI 太旧（`PROVIDER_UNSUPPORTED`）；`null`：暂不可用（`CREDITS_UNAVAILABLE`） |
| `.availableCount` | int64，必填 | — | **权威数量**；须为非负安全整数，否则按 `CREDITS_UNAVAILABLE` |
| `.credits` | `RateLimitResetCredit[] \| null` | "`null` means only `availableCount` is known, while an empty array means details were fetched and no available credits were returned. The backend may cap this list, so its length can be less than `availableCount`." | 原样保留 null / [] / 截断，**不参与计数** |
| `accountId` | `string \| null` | "Account associated with this usage snapshot, when supplied by the backend." | 账户指纹的唯一输入；为空即 `ACCOUNT_UNIDENTIFIED` |

`RateLimitResetCredit`：必填 `id`、`resetType`（`codexRateLimits` / `unknown`）、`status`
（`available` / `redeeming` / `redeemed` / `unknown`）、`grantedAt`（unix 秒）；可选可空 `expiresAt`、`title`、`description`。

### 1.2 `account/rateLimitResetCredit/consume`

- params：必填 `idempotencyKey`（"Identifies one logical reset attempt. A UUID is recommended; reuse the same value when retrying that attempt."）；
  可选 `creditId`（"When omitted, the backend selects the next available credit."）。
- response：`{ outcome }`，四选一：

| outcome | 上游说明 | 消费了 credit | 之后权威 read | operation |
| --- | --- | --- | --- | --- |
| `reset` | A reset credit was consumed and the eligible rate-limit windows were reset. | 是 | 是 | CONFIRMED + refresh PENDING → REFRESHING |
| `alreadyRedeemed` | The same idempotency key already completed a reset successfully. | 是（本 key 之前那次） | 是 | 同上 |
| `nothingToReset` | No current rate-limit window is eligible for a reset. | 否 | 否 | CONFIRMED + NOT_REQUIRED → NOTHING_TO_RESET |
| `noCredit` | The account has no earned reset credits available. | 否 | 否 | CONFIRMED + NOT_REQUIRED → NO_CREDIT |

这四种以外的任何结果（JSON-RPC error、超时、进程起不来）都不是 outcome：operation 保持 CONSUMING，
用**同一个 key** 重试，直到拿到 outcome 或到期（§7.5）。

### 1.3 `account/read`

`account.type` ∈ `chatgpt` / `apiKey` / `amazonBedrock`，或 `account: null`。只有 `chatgpt` 可能有 earned reset credit，
其余一律 `UNSUPPORTED_AUTH`。email 不读取、不上线。

---

## 2. 快照块 `PlanUsageSnapshot.rateLimitReset`

挂在 Codex 快照上：多 provider 时是 `planUsage.codex.rateLimitReset`，单 provider 扁平快照时是
`planUsage.rateLimitReset`（`provider: "codex"`）。读取一律用 `codexRateLimitResetOf(planUsage)`。

| 字段 | 必填 / 可空 | 规则 |
| --- | --- | --- |
| `protocolVersion` | 必填 | `1` |
| `support` | 必填 | 见下表 |
| `accountFingerprint` | 可选 | 恰在 `SUPPORTED` / `CREDITS_UNAVAILABLE` 时出现，`^cxa1_[0-9a-f]{32}$` |
| `rateLimitResetCredits` | 必填，可 null | 恰在 `SUPPORTED` 时非 null：`{ availableCount, credits }` |
| `fetchedAt` | 必填 | 这次 read **开始**的时间，`YYYY-MM-DDTHH:mm:ss.sssZ` |
| `generation` | 必填 | 做这次 read 的 runner 进程，即它 heartbeat 的 `leaseOwner`（小写 UUID） |
| `sequence` | 必填 | 该进程的 read 计数，从 1 严格递增 |

credit 行：`id` / `resetType` / `status` 为非空字符串，未知值原样透传；`grantedAt`、`expiresAt` 由 unix 秒转为
`YYYY-MM-DDTHH:mm:ssZ`；缺失的可空键写成 `null`；`title` / `description` 不超过 1000 字符。任何一行读不懂 →
`credits: null`，**绝不输出半张表**。明细最多保留 100 行，超出部分截掉（语义上仍是“截断”）。

`support` 判定（Go `codexRateLimitResetFromRead`，按顺序取第一条命中）：

| 顺序 | 条件 | support | 指纹 | `rateLimitResetCredits` |
| --- | --- | --- | --- | --- |
| 1 | `account/read` 的 `account.type` 不是 `chatgpt`（含 `account: null`） | `UNSUPPORTED_AUTH` | 无 | null |
| 2 | read 响应没有 `rateLimitResetCredits` 这个键 | `PROVIDER_UNSUPPORTED` | 无 | null |
| 3 | `accountId` 为空或 null | `ACCOUNT_UNIDENTIFIED` | 无 | null |
| 4 | summary 为 null，或 `availableCount` 不是非负整数 | `CREDITS_UNAVAILABLE` | 有 | null |
| 5 | 其余 | `SUPPORTED` | 有 | summary |

read 本身失败（进程起不来、RPC 报错）不产生新块，旧块按 §8 自然老化。runner 进程环境里有 `OPENAI_API_KEY` /
`OPENAI_BASE_URL` 时现有 probe 根本不读 Codex 用量，整个 Codex 快照缺席，reset 同样不提供。
**不要为此单独造一个只含 reset 块的 Codex 快照**：`planUsageReported()` 会把它当成“有用量数据”，从而改变自动重试的判断。

示例（fixtures `heartbeats.nestedReset`）：

```json
"rateLimitReset": {
  "protocolVersion": 1,
  "support": "SUPPORTED",
  "accountFingerprint": "cxa1_92381c922ad04574cc61964161fd5687",
  "rateLimitResetCredits": {
    "availableCount": 7,
    "credits": [
      { "id": "rlrc_fixture_1", "resetType": "codexRateLimits", "status": "available",
        "grantedAt": "2026-08-29T10:40:00Z", "expiresAt": "2026-09-21T14:13:20Z",
        "title": "Earned reset", "description": "Resets your current Codex usage limits." }
    ]
  },
  "fetchedAt": "2026-09-11T04:21:30.123Z",
  "generation": "6f1c2b7e-4d3a-4b8e-9c21-7a5e0d3f9b12",
  "sequence": 7
}
```

展示层用 `codexResetCreditDetails(block)`：`availableCount`（权威数量）、`details`（`UNKNOWN` / `COMPLETE` / `TRUNCATED`）、
`nextExpiresAt`（已列出的 `available` 行里最早的到期时间；`TRUNCATED` 时未列出的可能更早，界面要注明“部分明细”）。

---

## 3. 账户范围与指纹

- **MVP 范围**：runner 进程自身环境决定的默认 Codex 登录（`effectiveCodexHome(os.Environ())`）。
- **指纹**：`cxa1_` + `HMAC-SHA256(key, "orbit.codex-account-fingerprint.v1\n" + accountId)` 的前 16 字节，小写 hex。
  - `accountId` 取自**同一次** `account/rateLimits/read`，数量与账户出自一次读。
  - `key`：`machineHome()/codex-account-fingerprint.key`，32 个随机字节，权限 0600，首次需要时以 O_EXCL 创建，永不上传。
    读不到或长度不对 → 本次块按 `ACCOUNT_UNIDENTIFIED`，日志里不出现 key 内容。
  - 性质：同一次 runner 安装内稳定；不同 runner 对同一账户得到不同指纹（不可跨机关联）；不可逆；
    token、email、accountId 原文都不上线（`TestCodexResetBlockCarriesNoRawAccountData`，fixtures
    `fingerprint-raw-account-id`、`observed-raw-account-id` 被两侧拒绝）。
  - key 丢失会让在途 operation 看到“账户变了”而停止（§7.4），这是安全方向。
- **ACCOUNT_OVERRIDE**：确认来自工作区或会话上下文（请求带 `workspaceId`）时，apiserver 用
  `codexResetAccountOverride({ provider, env })` 判定：provider 不是内置 `codex`（配置型 provider 或别的 runtime），
  或 env 里 `CODEX_HOME`、`CODEX_API_KEY`、任意 `OPENAI_*` 非空 → 拒绝。runner 自己的页面不带 `workspaceId`，不做这项判断。

---

## 4. 能力、协议版本、lease、draining

| 项 | 定义 |
| --- | --- |
| capability | `codex-rate-limit-reset-v1`，放进 `X-Orbit-Runner-Capabilities`。**只能在 relay（§6.2、§6.3）与 consume+refresh（§6.4）都已存在的那个提交里加入 `runnerCapabilitiesV1`**；本任务只定义常量。 |
| 协议版本 | 快照块、command、回执都带 `protocolVersion: 1`。runner 收到版本不是 1 的 CONSUME command → 回 `CONSUME_NOT_CALLED / PROTOCOL_UNSUPPORTED`；其他非法 command 静默忽略。 |
| 活跃 lease | heartbeat 带合法 `leaseOwner`（小写 UUID）。创建时看最近一次 heartbeat 的 `leaseOwner`；派发时看本次 heartbeat 的。 |
| draining | 带 `draining: true` 的进程不领取、不接管、不被重投任何 reset command；手上的 claim 若还没调用上游，回 `RELEASED / RUNNER_DRAINING`。 |
| 在线 | 沿用 apiserver 现有 `OFFLINE_AFTER_MS = 90s`（`isRunnerOnline`）。 |

runner 对每条 command 先过 `codexResetCommandDisposition(cmd, ownLeaseOwner, receivedAt, now)`：

- `IGNORE`：`leaseOwner` 不是自己、heartbeat 响应已超过 60 秒（`commandFreshnessMs`，按单调时钟）、或 command 非法——
  什么都不做，也不回报；服务端会重投或交给别的进程；
- `REFUSE_PROTOCOL`：见上；
- `ACT`：执行 §6.4。

---

## 5. 双层幂等

| | `clientRequestId` | `providerIdempotencyKey` |
| --- | --- | --- |
| 管什么 | 同一次确认的 POST 重复、超时重试 → 同一个 operation | 同一个 operation 的 consume 在上游只生效一次 |
| 谁生成 | Web：每次“确认”生成一个 `crypto.randomUUID()`，这次确认的所有重试复用 | apiserver：INSERT operation 的同一事务里 `randomUUID()` |
| 唯一性 | `(ownerId, clientRequestId)` 唯一 | 每个 operation 一个，列不可更新 |
| 重复时 | `codexResetCreateReplay`：runner 与指纹都相同 → 200 返回原 operation（`replayed: true`，不重新检查资格、不生成新 key）；否则 409 `REQUEST_ID_REUSED` | 上游返回 `alreadyRedeemed`（或同样的 outcome），Orbit 按同一事实处理（DUPLICATE） |
| 出现在 | 创建请求体、operation view | 仅 CONSUME command 与 runner 发给上游的 consume params |
| 绝不出现在 | — | 用户 API 响应、Web、日志、REFRESH command、回执 |

没有持久化成功的 key（例如 INSERT 因唯一冲突回滚时预先生成的那个）从未发出过，直接丢弃；
**发出过的 key 只有 operation 行上那一个。**

---

## 6. 线上接口

### 6.1 Web ↔ API

| 路由 | 请求 | 成功 | 失败 |
| --- | --- | --- | --- |
| `POST /runners/:id/codex-rate-limit-reset` | `CreateCodexRateLimitResetRequest` | 201 新建 / 200 重放：`CreateCodexRateLimitResetResponse { operation, replayed }` | 400 请求体非法（`createCodexResetRequestViolations`）；404 runner 不存在或不属于当前用户；409 `CodexRateLimitResetRefusal { code, operationId? }` |
| `GET /runners/:id/codex-rate-limit-reset` | — | `CodexRateLimitResetOperations { active, latest }` | 404 |
| `GET /runners/:id/codex-rate-limit-reset/:operationId` | — | `CodexRateLimitResetOperationView` | 404（含不属于该 runner） |

创建流程（一个事务内）：

1. 校验请求体；按 owner 取 runner（否则 404）。
2. 查 `(ownerId, clientRequestId)`：已存在 → `codexResetCreateReplay`；`REPLAY` 返回 200，`REQUEST_ID_REUSED` 返回 409 并带已存在的 `operationId`。
3. `codexResetRefusal(input)` 非 null → 409（`OPERATION_IN_FLIGHT` 时带在途 `operationId`）。输入：`accountOverride`、
   `activeOperation`、`runnerOnline`、`Runner.capabilities`、最近 heartbeat 的 `leaseOwner` / `draining`、
   `codexRateLimitResetOf(Runner.planUsage)`、请求里的指纹。
4. `newCodexResetOperation({ …, providerIdempotencyKey: randomUUID(), now })` 并 INSERT。撞 `(ownerId, clientRequestId)`
   唯一约束 → 回到第 2 步重放；撞在途唯一约束 → 409 `OPERATION_IN_FLIGHT`。

Web 在 `active` 非空时每 2–3 秒 GET 一次；v1 不加实时推送帧。`id`、`runnerId`、`operationId` 一律当作不透明字符串原样回传
（用户 API 上可能是 base62 public id，也可能是 UUID，GET 路由两种都接受）。

| 拒绝码 | 含义 | Web 入口 |
| --- | --- | --- |
| `REQUEST_ID_REUSED` | 同一个 `clientRequestId` 用在了别的 runner 或账户上 | 客户端 bug：换新 id |
| `ACCOUNT_OVERRIDE` | 该上下文不跑在 runner 默认 Codex 账户上 | 隐藏 |
| `OPERATION_IN_FLIGHT` | 已有在途操作 | 附着到 `operationId`，展示 pending |
| `RUNNER_OFFLINE` / `NO_ACTIVE_LEASE` / `RUNNER_DRAINING` | runner 暂不可派发 | 禁用，提示离线或升级中 |
| `CAPABILITY_MISSING` | runner 版本不支持 | 禁用，提示升级 runner |
| `SNAPSHOT_MISSING` / `UNSUPPORTED_AUTH` / `PROVIDER_UNSUPPORTED` / `ACCOUNT_UNIDENTIFIED` | 该账户或版本不支持 | 隐藏 |
| `ACCOUNT_MISMATCH` | 用户确认时看到的账户已不是当前账户 | 刷新后重试 |
| `SNAPSHOT_STALE` | 快照超过 15 分钟，或来自未来超过 5 分钟 | 禁用，展示新鲜度 |
| `CREDITS_UNAVAILABLE` / `NO_CREDIT_AVAILABLE` | 上游暂不可用 / 数量为 0 | 禁用 |

资格检查按 `CODEX_RATE_LIMIT_RESET_ELIGIBILITY_ORDER` 依次进行，Web 禁用入口与 API 拒绝用的是同一个函数、同一个答案。

### 6.2 API → Runner：heartbeat 响应 `codexRateLimitResetRequest`

每个 runner 进程一次最多一条（MVP 只有默认账户）。字段见 `CodexRateLimitResetCommand`：`protocolVersion`、
`operationId`（UUID，永不改写成 public id）、`leaseOwner`、`claimGeneration`、`phase`、`accountFingerprint`、
`providerIdempotencyKey`（**恰在 CONSUME**）、`requestedAt`。

每次 heartbeat，对该 runner 的在途 operation 调用
`decideCodexResetDispatch(op, { runnerId, leaseOwner, draining, capabilities, rateLimitReset: <本次 CAS 之后的存储块>, now })`：
`SETTLE` / `DELIVER` 返回的 `operation` 与原值不同就按 §7.6 写回，`DELIVER` 时把 `command` 放进响应。
`NONE` 的原因：`SETTLED`、`RUNNER_MISMATCH`、`NO_ACTIVE_LEASE`、`CAPABILITY_MISSING`、`RUNNER_DRAINING`、`SNAPSHOT_MISSING`、`CLAIM_HELD`。

旧 runner 会忽略这个字段（Go `encoding/json` 默认忽略未知字段）；它们也不声明 capability，本来就收不到。

### 6.3 Runner → API：`POST /runner/codex-rate-limit-reset-result`

请求 `CodexRateLimitResetResultRequest`，服务端调用 `applyCodexResetResult(op, authenticatedRunnerId, body, now)`：

| kind | phase | 必带 | code | 效果 |
| --- | --- | --- | --- | --- |
| `CONSUME_OUTCOME` | CONSUME | `outcome` | — | consume → CONFIRMED；按 §1.2 决定 refresh |
| `CONSUME_NOT_CALLED` | CONSUME | `code` | `ACCOUNT_MISMATCH` `UNSUPPORTED_AUTH` `PROVIDER_UNSUPPORTED` `PROTOCOL_UNSUPPORTED` | 结算：`claimsWithUnknownCall` 归零则 NOT_ATTEMPTED，否则 UNRESOLVED |
| `CONSUME_RETRYING` | CONSUME | `code` | `PROVIDER_ERROR` `PROVIDER_TIMEOUT` `APP_SERVER_UNAVAILABLE` `READ_FAILED` `ACCOUNT_UNIDENTIFIED` | 只记 `lastErrorCode`，保持 CONSUMING |
| `RELEASED` | 两者皆可 | `code` | `RUNNER_DRAINING` | 交回 claim（owner 置空，代数不变）；CONSUME 阶段 `claimsWithUnknownCall` 减一 |
| `REFRESHED` | REFRESH | `rateLimitReset` | — | 块的指纹必须等于 operation 指纹、`generation` 必须等于回执 `leaseOwner`；refresh → SUCCEEDED；块另走 §8 的 CAS 写入 `Runner.planUsage` |
| `REFRESH_FAILED` | REFRESH | `code` | 可重试：`READ_FAILED` `APP_SERVER_UNAVAILABLE` `ACCOUNT_UNIDENTIFIED`；终结：`ACCOUNT_MISMATCH` | 可重试只记 `lastErrorCode`；终结 → refresh FAILED |

可选字段：`message`（1–500 字符，不得含 token、key、email、accountId）、`observedAccountFingerprint`（runner 前置 read 得到的指纹）。
未知字段（包括 `creditId`）使回执非法。

200 响应 `CodexRateLimitResetResultResponse { disposition: APPLIED | DUPLICATE, status, next }`，
`next` ∈ `REFRESH` / `RETRY_CONSUME` / `RETRY_REFRESH` / `STOP`；来自非当前 claim 的 DUPLICATE 一律 `STOP`。

拒绝体 `CodexRateLimitResetResultRefusal { code }`；runner 收到任何拒绝都停止处理这条 command：

| code | HTTP | 时机 |
| --- | --- | --- |
| `INVALID_RESULT` | 400 | `codexResetResultViolations` 非空 |
| `OPERATION_NOT_FOUND` | 404 | operation 不存在或不属于该 runner |
| `OUTCOME_CONFLICT` | 409 | 与已记录的 outcome 矛盾（如已记 `reset` 又报 `nothingToReset`） |
| `OPERATION_SETTLED` | 409 | operation 已结算，且回执不是在重述已记录的事实 |
| `STALE_CLAIM` | 409 | `(leaseOwner, claimGeneration)` 不是当前 claim |
| `PHASE_MISMATCH` | 409 | 回执 phase 与 operation 当前阶段不符 |
| `ACCOUNT_MISMATCH` | 409 | REFRESHED 的块属于别的账户 |

判定顺序固定：校验 → operation 与 runner 归属 → 重述已记录事实（DUPLICATE，任何 claim 都可以）→ 已结算 → claim 围栏 → 阶段 → 应用。

### 6.4 runner 执行一条 command

CONSUME：

1. 起 bare app-server（沿用 `startBareCodexAppServer` 与 handshake 锁），`initialize`。
2. `account/read` + `account/rateLimits/read`（不带 `excludeResetCreditDetails`），经 `codexRateLimitResetFromRead` 与
   `codexAccountFingerprint` 得到指纹和一个新块（写入 probe 缓存，`sequence` 加一）。
3. `UNSUPPORTED_AUTH` / `PROVIDER_UNSUPPORTED` → `CONSUME_NOT_CALLED`；`ACCOUNT_UNIDENTIFIED` 或读失败 → `CONSUME_RETRYING`；
   指纹不等于 command 指纹 → `CONSUME_NOT_CALLED / ACCOUNT_MISMATCH`，**consume 调用次数为零**。
   `CREDITS_UNAVAILABLE` 与 `availableCount = 0` 不拦截，交给上游给出权威 outcome。
4. `account/rateLimitResetCredit/consume`，params = `codexResetConsumeParams(cmd)`，30 秒超时。
5. 拿到 outcome → 回 `CONSUME_OUTCOME`。**拿到 outcome 之后要重试的是这条回执（字节不变），不是 consume 调用。**
   没拿到 → 回 `CONSUME_RETRYING`，退避后在同一 claim 内用同一 key 再调。
6. 回执响应 `next: REFRESH` → 立刻进入 REFRESH，不必等下一次 heartbeat。

REFRESH：在收到 consume outcome **之后开始**一次新的 `account/rateLimits/read`（不复用第 2 步那次），块的 `generation`
为本进程；指纹不一致 → `REFRESH_FAILED / ACCOUNT_MISMATCH`；成功 → `REFRESHED`，并写入 probe 缓存，让后续 heartbeat
带上它（CAS 会把这次重复判为 `REJECT_DUPLICATE`）。

进程在任何一步崩溃：内存状态直接丢弃。服务端的 claim 60 秒后由新进程接管（代数加一），新进程从第 1 步重新开始；
如果 consume 已经 CONFIRMED，它只会收到 REFRESH command。

---

## 7. 状态机与不变量

### 7.1 consume 检查点

| 从 | 到 | 触发 |
| --- | --- | --- |
| PENDING | CLAIMED | 首次 claim |
| PENDING | NOT_ATTEMPTED | 到期或账户变化，从未 claim |
| CLAIMED | CONFIRMED | `CONSUME_OUTCOME` |
| CLAIMED | NOT_ATTEMPTED | `CONSUME_NOT_CALLED` / 到期 / 账户变化，且 `claimsWithUnknownCall = 0` |
| CLAIMED | UNRESOLVED | 同上，但 `claimsWithUnknownCall > 0` |

### 7.2 refresh 检查点

| 从 | 到 | 触发 |
| --- | --- | --- |
| NONE | PENDING | outcome 为 `reset` / `alreadyRedeemed` |
| NONE | NOT_REQUIRED | outcome 为 `nothingToReset` / `noCredit`，或 consume 结算为 NOT_ATTEMPTED / UNRESOLVED |
| PENDING | SUCCEEDED | `REFRESHED` |
| PENDING | FAILED | 终结的 `REFRESH_FAILED` / refresh 到期 / 账户变化 |

### 7.3 派生 status（`codexResetOperationStatus`；表外组合一律非法）

| consumeState | consumeOutcome | refreshState | status |
| --- | --- | --- | --- |
| PENDING | null | NONE | PENDING |
| CLAIMED | null | NONE | CONSUMING |
| CONFIRMED | reset / alreadyRedeemed | PENDING | REFRESHING |
| CONFIRMED | reset / alreadyRedeemed | SUCCEEDED | SUCCEEDED |
| CONFIRMED | reset / alreadyRedeemed | FAILED | REFRESH_FAILED |
| CONFIRMED | nothingToReset | NOT_REQUIRED | NOTHING_TO_RESET |
| CONFIRMED | noCredit | NOT_REQUIRED | NO_CREDIT |
| NOT_ATTEMPTED | null | NOT_REQUIRED | NOT_ATTEMPTED |
| UNRESOLVED | null | NOT_REQUIRED | UNRESOLVED |

在途 = PENDING、CONSUMING、REFRESHING。`failureCode` 恰在 REFRESH_FAILED / NOT_ATTEMPTED / UNRESOLVED 上非空；
`completedAt` 恰在非在途时非空；`consumeConfirmedAt` 恰在 CONFIRMED 时非空；`lastErrorCode` 记录最近一次可恢复错误。

### 7.4 claim

- `claimGeneration` 从 0 开始，每次 claim 或接管加一，永不减少。
- 同一 `leaseOwner` 的 heartbeat：原样重投，不改代数。
- 别的进程：claim 未满 `claimTakeoverAfterMs = 60s` → `CLAIM_HELD`；满了 → 接管。与 merge / commit relay 不同是有意的：
  git 操作不能在新进程里重跑，reset 可以，因为 key 属于 operation 而不属于进程。
- `claimsWithUnknownCall`：CONSUME 阶段每次 claim 加一；该 claim 报 `CONSUME_NOT_CALLED` 或 `RELEASED` 时减一。
  只有它为 0 才能说“确定没调用过上游”（NOT_ATTEMPTED）。
- 账户变化（本次 heartbeat 存储块的指纹不等于 operation 指纹）：有新鲜 claim → 等它回报；否则 CONSUME 阶段结算为
  NOT_ATTEMPTED / UNRESOLVED（`ACCOUNT_CHANGED`），REFRESH 阶段 refresh → FAILED，consume 保持 CONFIRMED。

### 7.5 期限（`expireCodexResetOperation`，heartbeat 与定时清扫都可调用）

- consume：`createdAt + 10min` 仍未 CONFIRMED → NOT_ATTEMPTED / UNRESOLVED（`CONSUME_EXPIRED`）。
- refresh：`consumeConfirmedAt + 10min` 仍未完成 → FAILED（`REFRESH_EXPIRED`）。
- 有新鲜 claim（未满 60 秒）时暂不到期，给它回报的时间。

### 7.6 不变量与其可执行定义

| # | 不变量 | 定义与守护 |
| --- | --- | --- |
| I1 | 同一 `(runnerId, accountFingerprint)` 至多一个在途 operation | 数据库部分唯一索引（§9.3）+ `codexResetRefusal` 的 `OPERATION_IN_FLIGHT` |
| I2 | `(ownerId, clientRequestId)` 唯一，重放返回同一 operation | 唯一约束 + `codexResetCreateReplay` |
| I3 | `id`、`ownerId`、`runnerId`、`accountFingerprint`、`clientRequestId`、`providerIdempotencyKey`、`createdAt` 不可变 | `codexResetTransitionViolations` + 数据库 BEFORE UPDATE 触发器 |
| I4 | consume params 恰为 `{ idempotencyKey }` | `codexResetConsumeParams`；command 校验拒绝 `creditId` |
| I5 | 两个检查点只按 §7.1 / §7.2 前进；outcome 与 `consumeConfirmedAt` 一旦写入不变 | `CODEX_RATE_LIMIT_RESET_TRANSITIONS` + `codexResetTransitionViolations` |
| I6 | 已结算的 operation 任何字段都不再变化 | `codexResetTransitionViolations` |
| I7 | consume CONFIRMED 之后只下发 REFRESH，且不带 key | `codexResetCommand`、`decideCodexResetDispatch`；随机交错测试 |
| I8 | 回执围栏到当前 `(leaseOwner, claimGeneration)`；重述已记录事实幂等 | `applyCodexResetResult` |
| I9 | 快照块单调 | `orderCodexResetSnapshot`（§8） |
| I10 | 数量只来自 `availableCount`，明细 null 或截断时不推算 | `codexResetCreditDetails`、`codexResetRefusal`、Go `codexRateLimitResetCredits` |
| I11 | 旧 heartbeat（无块、无 capability）照常解析，视为“不提供” | fixtures `heartbeats.legacy`，两侧兼容测试 |
| I12 | 线上与日志没有 token、email、accountId 原文；key 只在 CONSUME command 里 | view 没有 key 字段且严格解码拒绝它；指纹格式校验 |
| I13 | 只向声明 capability、带 lease、未 draining、账户一致的进程派发 | `decideCodexResetDispatch` |
| I14 | 自动化与 CI 不消费真实 credit | 契约测试全为纯函数；下游只用 fake app-server |

---

## 8. 快照单调（CAS）

`orderCodexResetSnapshot(stored, incoming, transportLeaseOwner, now)`，heartbeat 写 `planUsage` 与 `REFRESHED` 回执写入时都要调用：

| 顺序 | 条件 | 结果 |
| --- | --- | --- |
| 1 | incoming 非法，或 `incoming.generation` 不等于携带它的 heartbeat / 回执的 `leaseOwner` | `REJECT_INVALID` |
| 2 | 没有存储块，或存储块非法 | `ACCEPT_FIRST` |
| 3 | 存储块 `fetchedAt` 晚于 `now + 5min` 而 incoming 没有 | `ACCEPT_REPLACES_UNTRUSTED` |
| 4 | incoming 晚于 `now + 5min` 而存储块没有 | `REJECT_UNTRUSTED` |
| 5 | `fetchedAt` 更晚 / 更早 | `ACCEPT_NEWER` / `REJECT_OLDER` |
| 6 | 同一毫秒、不同 generation | `REJECT_OLDER`（先到者保留） |
| 7 | 同一毫秒、同一 generation：sequence 更大 / 相等 / 更小 | `ACCEPT_NEWER` / `REJECT_DUPLICATE` / `REJECT_OLDER` |

写入：heartbeat 的 `planUsage` 其余部分照旧整体覆盖；块被拒时，写回保留已存储的块（在 `SELECT … FOR UPDATE` 的同一事务里合并）。
新鲜度（资格检查用）：`now − 15min ≤ fetchedAt ≤ now + 5min`。时钟跳变只会让 reset 暂时不可用，不会导致重复消费——
防重复靠 key 与在途唯一，不靠快照。

---

## 9. 兼容性、受影响模块与迁移

### 9.1 兼容矩阵

| 组合 | 行为 |
| --- | --- |
| 旧 runner → 新 apiserver | heartbeat 没有块也没有 capability：快照照存，资格为 `CAPABILITY_MISSING` / `SNAPSHOT_MISSING`，不派发 |
| 新 runner → 旧 apiserver | 块作为 JSON 存进 `planUsage`，无人读取；响应里没有 command，runner 什么都不做 |
| 旧 Web | 忽略新字段 |
| macOS / iOS（`PlanUsageSnapshot: Codable`） | `JSONDecoder` 忽略未知键，无需改动；v1 不在原生端提供 reset |
| 回滚 runner | apiserver 看到 capability 消失，停止派发；在途 operation 按 §7.5 到期 |

### 9.2 受影响模块（按下游任务）

| 下游任务 | 模块 | 要做的事 |
| --- | --- | --- |
| 接入 Runner reset credit 权威读取与单调快照 | `src/runner-go/planusage.go`（`fetchCodexPlanUsage`、`parseCodexPlanUsage`、`mergeCodexPlanUsage`、`planUsageProbe`），新增指纹 key 读写；`src/apiserver/src/runner-api/runner-api.controller.ts` 的 heartbeat 写 `planUsage` | 生成块：`codexRateLimitResetFromRead` + `codexAccountFingerprint`，`fetchedAt` 取 read 开始时间，`generation` 为进程 `leaseOwner`，`sequence` 进程内递增；**`mergeCodexPlanUsage` 在 update 没有块时必须沿用 current 的块**（rolling 通知不带 reset credits）；apiserver 在事务里用 `orderCodexResetSnapshot` 合并写入 |
| 实现 reset operation 接入与持久化 | Prisma schema 与迁移；`src/apiserver/src/runners/` 新路由；`src/shared/src/codec.ts` | 建表（§9.3）与 `Runner` 两个新列并在 heartbeat 里写入；§6.1 三个路由；`codexResetRefusal`、`newCodexResetOperation`、`codexResetCreateReplay`、`codexResetOperationView`；把 `clientRequestId`、`providerIdempotencyKey`、`claimLeaseOwner`、`operationId`、`heartbeatLeaseOwner` 加进 `NEVER_PUBLIC_ID_FIELDS`（`public-id-coverage.spec.ts` 会追问每个新的 `@db.Uuid` 列） |
| 实现 heartbeat reset 命令与结果回执 | heartbeat 响应组装；新 runner 路由；`src/runner-go/runloop.go`、`transport.go` | `decideCodexResetDispatch` + `applyCodexResetResult` + `expireCodexResetOperation`，每次写入前 `codexResetTransitionViolations` 必须为空；runner 侧 `codexResetCommandDisposition` 与回执重试 |
| 实现 Runner 幂等 consume 与权威刷新 | `src/runner-go`（新文件，复用 `codexAppServer`） | §6.4；`codexRateLimitResetCapabilityV1` 与 relay 在同一个提交里生效 |
| 实现 Plan usage reset credit 交互与恢复态 | `src/web/src/lib/planUsage.ts`、`RunnerEngines.tsx`、`WorkspaceView.tsx` | 用 `codexRateLimitResetOf` + `codexResetCreditDetails` 展示；`codexResetRefusal` 决定入口；确认时生成一次 `clientRequestId`，重试复用；按 `status` / `lastErrorCode` / `failureCode` 覆盖 §6.1 与 §7.3 的全部状态 |
| 加固、E2E、发布 | 故障注入 harness、`scripts/test-codex-reset-*.sh` | 以本契约的 fixtures 与状态表为预期；spec 末尾的随机交错模型可作为 harness 的参照 |

### 9.3 数据库（给持久化任务的最小定义）

表 `codex_rate_limit_reset_operation`：

| 列 | 类型 | 约束 |
| --- | --- | --- |
| `id` | uuid | 主键，`uuid(7)` |
| `owner_id` | uuid | 外键 user |
| `runner_id` | uuid | 外键 runner，ON DELETE CASCADE |
| `account_fingerprint` | text | CHECK `~ '^cxa1_[0-9a-f]{32}$'` |
| `client_request_id` | uuid | UNIQUE (`owner_id`, `client_request_id`) |
| `provider_idempotency_key` | uuid | NOT NULL，UNIQUE，不可更新 |
| `consume_state` / `consume_outcome` / `refresh_state` | text | CHECK 取值；组合 CHECK 按 §7.3 |
| `failure_code` / `last_error_code` | text | 可空，CHECK 取值 |
| `claim_lease_owner` | uuid | 可空 |
| `claim_generation` / `claims_with_unknown_call` | integer | ≥ 0 |
| `claimed_at` / `created_at` / `updated_at` / `consume_confirmed_at` / `completed_at` | timestamptz | |

在途部分唯一索引：`(runner_id, account_fingerprint) WHERE consume_state IN ('PENDING', 'CLAIMED') OR (consume_state = 'CONFIRMED' AND refresh_state = 'PENDING')`。
BEFORE UPDATE 触发器拒绝不可变列变化、检查点倒退、已结算行的任何修改（与 `codexResetTransitionViolations` 同义）。
回滚迁移：DROP 该表（没有别的表引用它）并删除下述两列。

`Runner` 新列：`heartbeat_lease_owner uuid NULL`、`heartbeat_draining boolean NULL`，每次 heartbeat 覆盖写入。
旧 runner 写入 NULL，资格检查会给出 `NO_ACTIVE_LEASE`（它们也缺 capability）。

---

## 10. 测试

```bash
npm run test -w @orbit/shared        # 含 src/codexRateLimitReset.spec.ts
(cd src/runner-go && go test ./...)   # 含 codex_rate_limit_reset_test.go
```

| 测试 | 覆盖 |
| --- | --- |
| 契约文件 ↔ 代码 | 版本、capability、方法名、时限、格式、枚举、结果种类、转移表、资格顺序；每个 wire 类型逐字段（TS 编译期见证 + Go 反射 struct tag） |
| 上游 schema ↔ 契约 | 四种 outcome、consume 参数、summary 必填与可空、credit 字段集（两侧都读 `docs/evidence`） |
| fixtures | 同一批合法与非法的块、command、回执、响应、view，两侧校验结论一致；上游 read → 块的无损映射（null、[]、截断、坏行、缺键、各种 support）；指纹两侧同值 |
| 兼容 | 旧 heartbeat 请求与响应往返无损；嵌套与扁平块 |
| 状态机 | 资格顺序逐条、派发 / 接管 / 释放 / 账户变化、回执幂等与围栏、期限、单调写入、快照 CAS 表 |
| 随机交错 | 250 个种子 × 150 步：两个进程、丢失 / 重复 / 迟到的回执、draining、账户翻转、期限；断言每次写入合法、key 不变、确认后不再 CONSUME、上游 credit 至多消费 1 个 |

---

## 11. 已知限制与非目标

- `accountId` 为 null 的账户不提供 reset（`ACCOUNT_UNIDENTIFIED`）。本任务只取得了 schema，没有对真实账户做只读采样；
  读取任务应先用一次只读的 `account/rateLimits/read` 确认真实响应带 `accountId`。如果普遍为 null，需要出契约 v2，
  不能自行改用 email。
- UNRESOLVED 是终态：进程失联很久之后迟到的真实 outcome 不再记录，界面应提示以刷新后的额度为准。
- 同一个 ChatGPT 账户登录在两台 runner 上时指纹不同，两边可以各有一个在途 operation（各自需要一次明确确认）。
- v1 不选择具体 credit（不传 `creditId`），不支持工作区级 `CODEX_HOME` 账户，不在原生客户端提供入口，不加实时推送帧。
