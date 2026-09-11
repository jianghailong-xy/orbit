# Codex earned rate-limit reset：排障、人工恢复与安全边界

**适用范围**：[跨层契约](./codex-rate-limit-reset-contract.md) 描述的 reset operation（apiserver 接入与 relay、
runner relay 与 consume、Plan usage 快照）。本文件是任务「加固 reset 重投、恢复、竞态与可观测性」的产物：
值班排障、人工恢复的边界、日志与指标的读法、故障注入 harness，以及安全边界审查的结论与残余风险。

**先读这一页再动手**：operation 行上的任何字段都不要手工改。0255 的触发器会拒绝倒退与改写，
而绕过触发器去"修"一行，正是把"最多一次消费"变成"至少一次"的路径（§6）。

---

## 0. 一页结论

1. **按 operationId 串日志。** apiserver 与 runner 每一步都写一行 `codex-reset {json}`，两侧用同一个 `operationId`
   （UUID）。阶段只有五个：`admission`、`delivery`、`consume`、`refresh`、`receipt`（§1）。
2. **最多一次逻辑消费靠五件事，缺一不可。**
   - 一把 provider key：建行时生成，列不可变，所有 claim、所有进程、所有重试都用它（契约 §5）。
   - 同一 runner + 账户至多一个在途 operation（部分唯一索引）。
   - claim 是租约：持有者的每次 heartbeat 续租，到检查点期限为止；另一个进程只能接管连续 60 秒没续租的 claim（§2.1）。
   - runner 只在 claim 仍在被投递时发起 consume 调用：最近一次投递的 heartbeat 发出不超过 20 秒（§2.2）。
   - consume 一旦 CONFIRMED，就只下发不带 key 的 REFRESH（契约 §7.6 I7）。
3. **"No credit was used" 只在确实没有任何调用可能落地时出现。** 一个 claim 只要发出过一次 consume 调用，
   就不会再报 `CONSUME_NOT_CALLED`，所以 operation 只能结算为 UNRESOLVED，不会是 NOT_ATTEMPTED（§2.3）。
4. **可能已扣费但没有确认刷新时，接入等一次新读。** 同一 runner + 账户最近一次 UNRESOLVED 或 REFRESH_FAILED
   结算之后，快照的 `fetchedAt` 必须晚于结算时间，否则新的确认被拒为 `SNAPSHOT_STALE`（§2.4）。
   用户不会基于扣费前的数量再次确认。
5. **卡住的 operation 不需要人管。** 期限（createdAt 或 consumeConfirmedAt 起 10 分钟）过后，最多再过 60 秒，
   任何一次该 runner 的 heartbeat 都会把它结算掉。
6. **指标 `orbit_codex_reset_anomalies_total` 非零才需要人。** 它表示 runner 报告了一次扣费，而 operation 没有记录这次扣费（§4.7）。

---

## 1. 日志与指标

### 1.1 行格式

| 侧 | 形状 | 写入位置 |
| --- | --- | --- |
| apiserver | Nest Logger，消息体为 `codex-reset {json}`，context 为 `CodexRateLimitResetRelay` 或 `CodexRateLimitResetService` | `src/apiserver/src/runners/codex-reset-log.ts` |
| runner | `[orbit-runner <ISO 时间>] codex-reset {json}`（stdout） | `src/runner-go/codex_rate_limit_reset_log.go` |

一行 JSON 只可能出现下面这些字段，每个字段的取值都经过校验：

| 字段 | 取值 | 两侧 |
| --- | --- | --- |
| `stage` | `admission` `delivery` `consume` `refresh` `receipt` | 两侧（runner 没有 admission） |
| `event` | 小写单词，见 §1.2 | 两侧 |
| `operationId` | 小写 UUID | 两侧 |
| `runnerId` | 小写 UUID | apiserver |
| `process` | 进程 leaseOwner 的前 8 位十六进制 | 两侧 |
| `phase` / `kind` / `outcome` / `code` / `status` / `from` / `next` / `disposition` / `order` | 契约枚举原值 | 两侧（`from`、`order` 仅 apiserver） |
| `claimGeneration` `attempt` `ageMs` `delayMs` | 非负整数 | 两侧（后三个仅 runner） |
| `account` | `match` `mismatch` `unidentified` `unsupported` | runner |
| `reason` | 小写单词 | 两侧 |
| `error` | apiserver：错误 code 或类名；runner：`refused` `invalid_receipt` `stopped` `timeout` `http_<status>` `transport` | 两侧 |
| `replayed` | 布尔 | apiserver |

**脱敏规则**（两侧同一套）：
- 值不符合所在字段的约束，写成 `"[redacted]"`。
- 值里含有调用方点名的秘密（当前 operation 的 provider key），也写成 `"[redacted]"`。
- apiserver 侧不是字段的键直接丢弃。runner 侧的行是结构体，没有其他键。

没有任何字段承载 provider 返回的文本、错误消息、请求体、账户指纹、accountId、email、token 或环境变量，
所以这些内容在调用点就传不进来。

### 1.2 阶段与事件

| stage | event | 谁写 | 含义 |
| --- | --- | --- | --- |
| admission | `created` / `replayed` | apiserver | 一次确认建了 operation，或重放出已有的 operation（`replayed:true`） |
| admission | `refused`（`code`） / `invalid` / `not_found` | apiserver | 拒绝码见契约 §6.1；`invalid` 表示请求体非法；`not_found` 表示 runner 不属于调用者 |
| delivery | `claimed` / `taken_over` | apiserver | heartbeat 首次领取 claim，或接管一个 60 秒未续租的 claim；带 `claimGeneration`、`process` |
| delivery | `settled`（`code`=failureCode，`from`→`status`） | apiserver | heartbeat 因期限或账户变化结算 |
| delivery | `started`（`reason`=`step`/`release`/`refuse`） | runner | relay 为一次投递启动步骤、RELEASED 或协议拒绝 |
| delivery | `ignored`（`reason`=`another_process`/`stale_response`/`invalid_command`/`no_executor`） / `not_restarted`（`consume_already_started`） | runner | 不执行这次投递 |
| consume | `calling`（`attempt`） | runner | 就要发出 consume 调用。在调用之前写，所以进程在等回答时被杀，也会留下这一行：这个 claim 可能已扣费 |
| consume | `called` / `not_called`（`account`、`kind`、`code`/`outcome`） | runner | 一次 consume 尝试的结果：读了哪个账户、调用与否、得到什么 |
| consume | `awaiting_delivery`（`ageMs`） | runner | 最近一次投递已超过调用新鲜度，等下一次投递，本次不调用、不上报 |
| consume | `stopped`（`reason`=`not_called_after_a_call`/`claim_not_delivered`/`process_stopping`） | runner | 步骤不上报就结束（§2.2、§2.3） |
| consume / refresh | `applied` / `restated` / `refused`（`kind`，`from`→`status`） | apiserver | 一个结果写了行、重述了已记录事实，或被拒 |
| consume | `anomaly`（`reason`，`code`=拒绝码） | apiserver | 被拒的结果报告了 operation 没有记录的扣费，或与已记录 outcome 矛盾（§4.7） |
| refresh | `read`（`account`、`kind`/`code`） | runner | 一次权威刷新读 |
| refresh | `snapshot_stored` / `snapshot_kept` | apiserver | REFRESHED 携带的块是否写进 `Runner.planUsage` |
| receipt | `answered`（`disposition`、`status`、`next`） / `refused`（`code`） | apiserver | 结果得到的回答 |
| receipt | `received` / `resending`（`error`、`delayMs`） / `refused`（`code`） / `undelivered`（`error`） | runner | 回执送达、退避重发、被拒、放弃 |

续租（持有者每次 heartbeat 一次）只计数不写日志，否则一次操作每 30 秒就会多一行。

### 1.3 指标

`GET /api/metrics`（与数据库冲突指标同一路由、同一 bearer token），Prometheus 文本格式：

| 指标 | 标签 | 何时加一 |
| --- | --- | --- |
| `orbit_codex_reset_admissions_total` | `result`（created/replayed/refused/invalid），`code` | 每次确认 |
| `orbit_codex_reset_dispatch_total` | `decision`（claimed/taken_over/renewed/settled/none），`phase`，`reason`（NONE 原因或 failureCode） | 每次 heartbeat 对每个在途 operation |
| `orbit_codex_reset_results_total` | `kind`，`answer`（APPLIED/DUPLICATE/REFUSED），`code`（结果码、拒绝码或 outcome） | 每个结果 |
| `orbit_codex_reset_settlements_total` | `status`，`failure_code` | 每次进入终态（heartbeat 结算或结果写入） |
| `orbit_codex_reset_snapshot_writes_total` | `source`（heartbeat/refreshed），`order`（快照比较结果、`cas_exhausted`、`no_codex_snapshot`） | 每个提交给 `Runner.planUsage` 的块 |
| `orbit_codex_reset_anomalies_total` | `anomaly`（consumed_outcome_after_settlement/consumed_outcome_from_stale_claim/outcome_conflict） | 见 §4.7 |

所有标签值都来自闭集。不在闭集里的值记作 `other`；一个指标超过 256 个标签组合后，新组合并入 `overflow`。
任何 operation、runner 或 owner 的 id 都不会成为标签。

建议告警：
- `anomalies_total` 任意增长：人工核对，见 §4.7。
- `settlements_total{status="UNRESOLVED"}` 的速率明显升高：上游或 runner 大面积失联。
- `results_total{answer="REFUSED",code="STALE_CLAIM"}` 持续出现：有多个活进程在同一 runner 上。
- `snapshot_writes_total{order="cas_exhausted"}` 持续出现：planUsage 写入竞争异常。

### 1.4 用 operationId 还原一次操作

```bash
# apiserver（容器日志）
docker logs orbit-apiserver 2>&1 | grep 'codex-reset' | grep '"operationId":"<id>"'
# runner（该机器上的 runner 日志）
journalctl -u orbit-runner --since '-1h' | grep 'codex-reset' | grep '"operationId":"<id>"'
```

一次正常操作的两侧事件顺序如下。这是示意，时间与 id 省略；实际行以 harness 报告中 F1 的 `controlPlaneLog` 与 `runnerLog` 为准。

```text
apiserver  admission/created          status=PENDING
apiserver  delivery/claimed           claimGeneration=1 process=6f1c2b7e
runner     delivery/started           reason=step
runner     consume/calling            attempt=1
runner     consume/called             account=match kind=CONSUME_OUTCOME outcome=reset
apiserver  consume/applied            from=CONSUMING status=REFRESHING
apiserver  receipt/answered           disposition=APPLIED next=REFRESH
runner     receipt/received           disposition=APPLIED status=REFRESHING next=REFRESH
runner     refresh/read               account=match kind=REFRESHED
apiserver  refresh/applied            from=REFRESHING status=SUCCEEDED
apiserver  receipt/answered           disposition=APPLIED next=STOP
apiserver  refresh/snapshot_stored
runner     receipt/received           status=SUCCEEDED next=STOP
```

---

## 2. 加固后的恢复策略（契约 §6.4、§6.5、§7.4 已同步）

### 2.1 claim 是续租的租约

`decideCodexResetDispatch` 的规则：

- **持有者续租。** heartbeat 来自 claim 持有者，且本次存储块的账户与 operation 一致：写 `claimedAt = updatedAt = now`
  （续租），并原样重投 command。只续到检查点期限：consume 为 `createdAt + 10min`，refresh 为 `consumeConfirmedAt + 10min`。
  期限之后，持有者得到 `NONE / DEADLINE_PASSED`，不续租也不投递。
- **draining 的持有者不续租。** 读到别的账户的持有者也不续租。
- **接管。** 别的进程只在 claim 连续 `claimTakeoverAfterMs`（60 秒）未续租后接管，代数加一，key 不变。
- **期限结算。** claim 新鲜时暂不结算；不新鲜后按契约 §7.5 结算。续租止于期限，所以期限后至多 60 秒必然结算。

为什么需要续租：没有续租时，claim 从首次领取起 60 秒就可被接管，与持有者是否活着无关。一个活着、正在退避重试的进程，
会和接管者同时用同一个 key 调用 consume。provider 对同一 key 只完成一次 reset，所以不会扣两次费。但如果某次调用答
nothingToReset / noCredit（key 未花掉），另一个进程随后的调用可能真的扣费，operation 却记着"没扣费"。
续租之后，只要持有者的 heartbeat 还在，就没有第二个进程能拿到这个 claim。

### 2.2 runner 只在 claim 仍被投递时调用（调用新鲜度）

- relay 为每个 claim 记下最近一次投递它的 heartbeat 的**发出时刻**。这个时刻不晚于服务端为这次投递续租的时刻。
- consume 每次尝试先读账户；账户一致后，若 `now − 最近投递 ≥ callFreshness`（20 秒），这次尝试**不调用、不上报**，
  写 `consume/awaiting_delivery`，然后等下一次投递。
  - 等到了投递：重新开始尝试（重新起 app-server、重新读账户）。
  - claim 被接管、operation 已结算或过了期限、或本进程在 draining：服务端不再投递，步骤等不到，写
    `consume/stopped reason=claim_not_delivered`。进程停止时写 `process_stopping`。
- 20 秒的来历：接管要求 60 秒未续租。一个在 20 秒内开始的调用，加上自身 30 秒超时，在接管可能发生之前至少还有 10 秒余量
  （`TestCodexResetCallFreshnessEndsCallsInsideTheTakeoverWindow` 从契约文件读 60 秒验证这一点）。
- heartbeat 每 30 秒一次，所以健康的重试最多多等一次 heartbeat。

### 2.3 调用之后不再报 CONSUME_NOT_CALLED

`CONSUME_NOT_CALLED` 的含义是"这个 claim 没有任何调用到达过 provider"，服务端据此把 `claimsWithUnknownCall` 减一，
归零则结算为 NOT_ATTEMPTED，界面显示"No credit was used"。

- **加固前的缺陷**：第 1 次尝试的调用超时（可能已扣费）；随后账户切换、登出或 CLI 降级；第 2 次尝试读到后不调用，
  却报 `CONSUME_NOT_CALLED` → NOT_ATTEMPTED → 告诉用户没扣费。
- **加固后**：步骤记住本 claim 是否发出过调用。发出过的，之后任何"不能调用"都不上报，写
  `consume/stopped reason=not_called_after_a_call`。
- **结算方式**：operation 留在 CONSUMING，`claimsWithUnknownCall` 仍 ≥ 1。账户变化时由 heartbeat 结算为
  UNRESOLVED/ACCOUNT_CHANGED；否则到期限结算为 UNRESOLVED/CONSUME_EXPIRED。
- **验证**：harness F16；Go 测试 `TestCodexResetConsumeNeverReportsNotCalledOnceACallWentOut`。

### 2.4 可能扣费但未确认刷新之后，接入要求新读

- `codexResetRefusal` 新增可选输入 `readRequiredAfter`。服务端取同一 runner + 账户最近一次 UNRESOLVED 或
  REFRESH_FAILED 的 `completedAt`（`CodexRateLimitResetRepository.unrefreshedSpendSettledAt`）。
- 存储块的 `fetchedAt` 不晚于它时，拒为 `SNAPSHOT_STALE`。Web 的现有文案是
  "Usage is out of date. Waiting for the runner to refresh it."。
- runner 的 usage probe 每 5 分钟（活跃）或 10 分钟（空闲）读一次，读到后自动放行。
- **验证**：harness F14、F23；shared spec `refuses a block read no later than an unrefreshed spend settled`。

---

## 3. 每个终态对用户意味着什么

| status | failureCode | credit | 用户能否再次确认 |
| --- | --- | --- | --- |
| SUCCEEDED | — | 已用 1 个（alreadyRedeemed 为同一 key 之前那次） | 可以；快照已是刷新后的数量 |
| REFRESH_FAILED | REFRESH_EXPIRED / ACCOUNT_MISMATCH / ACCOUNT_CHANGED | **已用** 1 个，但数量未刷新 | 需等一次结算之后的新读（§2.4） |
| NOTHING_TO_RESET | — | 未用 | 可以（provider 说当前没有可重置窗口） |
| NO_CREDIT | — | 未用 | 数量为 0 时入口本来就禁用 |
| NOT_ATTEMPTED | ACCOUNT_MISMATCH / ACCOUNT_CHANGED / UNSUPPORTED_AUTH / PROVIDER_UNSUPPORTED / PROTOCOL_UNSUPPORTED / CONSUME_EXPIRED | **确定未用**：没有任何 claim 可能调用过 provider | 可以 |
| UNRESOLVED | ACCOUNT_CHANGED / CONSUME_EXPIRED / ACCOUNT_MISMATCH 等 | **可能已用** | 需等一次结算之后的新读（§2.4），以刷新后的数量为准 |

**不会误导用户再次消费的依据**：
- "No credit was used" 类文案只对应 NOTHING_TO_RESET、NO_CREDIT、NOT_ATTEMPTED。前两者是 provider 对这个 key 的回答；
  NOT_ATTEMPTED 在 §2.3 之后只在没有任何调用可能落地时出现。
- 可能已扣费的两个终态 UNRESOLVED 和 REFRESH_FAILED 上，服务端强制等新读（§2.4），数量来自结算之后的权威读。
- 同一次确认的任何重试（双击、超时重发、刷新页面）复用 `clientRequestId`，只会重放同一个 operation（契约 §5）。

UI 分支（`orbit/plan-usage-reset-credit-42176c`）的文案：
- UNRESOLVED："A credit may have been used — check the count once usage refreshes."
- REFRESH_FAILED："used 1 credit … numbers may be out of date"。
- 它的 `codexResetRefusal` 调用尚未传 `readRequiredAfter`，入口可能显示为可点，但 API 会以 409 `SNAPSHOT_STALE`
  拒绝，界面按拒绝码显示"Usage is out of date"。见 §8 R3。

---

## 4. 排障手册

所有查询只读，并且**不选** `provider_idempotency_key`：

```sql
SELECT id, runner_id, consume_state, consume_outcome, refresh_state, failure_code, last_error_code,
       claim_lease_owner, claim_generation, claimed_at, claims_with_unknown_call,
       created_at, updated_at, consume_confirmed_at, completed_at
  FROM codex_rate_limit_reset_operation
 WHERE id = '<operationId>';
```

### 4.1 一直 PENDING（从未 claim）
1. 看 `dispatch_total{decision="none"}` 的 `reason`：
   - `NO_ACTIVE_LEASE`：heartbeat 没带 leaseOwner（旧 runner）。
   - `CAPABILITY_MISSING`：runner 版本不支持。
   - `RUNNER_DRAINING`：正在升级。
   - `SNAPSHOT_MISSING`：没有带账户的块。
2. `runner.heartbeat_lease_owner`、`heartbeat_draining`、`capabilities`、`last_heartbeat_at` 能直接看到原因。
3. 不需要处理：期限到后结算为 NOT_ATTEMPTED/CONSUME_EXPIRED（从未 claim，确定未扣费）。

### 4.2 一直 CONSUMING
1. runner 侧按 operationId 找最近的 `consume/*` 行：
   - 反复 `called … code=PROVIDER_TIMEOUT/PROVIDER_ERROR/APP_SERVER_UNAVAILABLE`：上游或 app-server 故障，同 key 退避重试中。
   - `awaiting_delivery` 后跟 `stopped reason=claim_not_delivered`：本进程已不是持有者、正在 draining，或 operation 已过期。
   - `stopped reason=not_called_after_a_call`：调用后账户变化或登出（§2.3），等 heartbeat 或期限结算为 UNRESOLVED。
2. apiserver 侧看 `delivery/claimed|taken_over` 的 `process`，确认当前持有者是哪个进程。
3. 不要手工结算：期限后至多 60 秒自动结算。

### 4.3 REFRESHING 不结束
consume 已 CONFIRMED，credit 已用（reset/alreadyRedeemed）。
- runner `refresh/read` 反复 `READ_FAILED` / `APP_SERVER_UNAVAILABLE` / `ACCOUNT_UNIDENTIFIED`：刷新期限后结算为 REFRESH_FAILED。
- **绝不会**再下发 CONSUME：这由契约 §7.6 I7 和 harness F11 保证。

### 4.4 UNRESOLVED
含义是"可能已用"。处理：等 runner 下一次 usage 读取，看存储块的 `availableCount`。
在读取之前，接入对该 runner + 账户返回 `SNAPSHOT_STALE`，这是预期行为。
如果用户坚持，以 provider 刷新后的数量为准回复，不做任何行级操作。

### 4.5 REFRESH_FAILED
credit 已用，只是没刷新数量。处理同 4.4。

### 4.6 SNAPSHOT_STALE 拒绝持续超过 15 分钟
1. 看存储块 `fetchedAt` 是否在前进。不前进：runner 读不到账户（probe 日志 `codex plan-usage unavailable:`），先修 runner 的 Codex 登录。
2. 前进了但仍被拒：检查 runner 与 apiserver 的时钟偏差（§8 R4）。runner 时钟慢于服务器时，新读的 `fetchedAt` 会显得早于结算时间。

### 4.7 anomalies_total 增长
apiserver 会写 `consume/anomaly` 行（warn），带 `reason`、`from`、`code`：
- `consumed_outcome_after_settlement`：一个 claim 报告 reset/alreadyRedeemed，而 operation 已结算为 UNRESOLVED 或 NOT_ATTEMPTED。
  这次扣费确实发生了，但 operation 不会再记录它（终态不可改）。
  处理：告知用户该次确认实际已用 1 个 credit，以刷新后的数量为准；**不要**改行。
- `consumed_outcome_from_stale_claim`：被接管的旧 claim 迟到报告扣费。
  若当前 claim 随后记录了同一 key 的 alreadyRedeemed，属正常收敛，无需处理；否则按上一条处理。
- `outcome_conflict`：结果与已记录 outcome 矛盾，例如已记 nothingToReset、迟到的调用却答 reset，意味着同一 key 被第二次调用并扣费。
  处理同第一条，并按 `process` 找出第二个活进程（§4.8）。

### 4.8 同一 runner 上有两个活进程
- **现象**：`results_total{code="STALE_CLAIM"}`；或 `delivery/claimed` 的 `process` 来回变化。
- **常见原因**：服务之外手工起了前台 runner，并共用同一个 ORBIT_HOME 和 token。
- **影响**：续租让持有者保有 claim，第二个进程拿不到（harness F18）。
- **处理**：停掉多余的进程。

---

## 5. 故障注入 harness

```bash
bash scripts/test-codex-reset-fault-injection.sh
```

- **组成**：runner-go 加固测试、23 个跨层场景（`src/apiserver/src/runner-api/codex-reset-fault-injection.pg.spec.ts`）、
  apiserver 遥测 spec、shared 契约 spec（含 250 个种子的随机交错）。
- **跨层场景的真实部件**：
  - apiserver 的 heartbeat 与结果路由、PostgreSQL、准入服务、CAS、触发器、日志与指标。
  - Go runner 进程（`TestCodexResetFaultProcess`，按命令驱动，SIGKILL 模拟崩溃）。
  - 可编程 fake app-server，credit 与每次请求（带时间戳）都记在文件里。
  - 两者之间的故障代理：丢请求、丢回答、重复、扣住、503。

| 场景 | 注入的故障 | 期望终态 | consume 调用 / 扣费 |
| --- | --- | --- | --- |
| F1 | 无 | SUCCEEDED | 1 / 1 |
| F2 | 带 CONSUME 的 heartbeat 回答丢失（claim 已写） | SUCCEEDED | 1 / 1 |
| F3 | 步骤运行期间重投 3 次 | SUCCEEDED | 1 / 1 |
| F4 | CONSUME_OUTCOME 请求丢失，再两次 503 | SUCCEEDED | 1 / 1 |
| F5 | CONSUME_OUTCOME 已应用后回执丢失 | SUCCEEDED | 1 / 1 |
| F6 | 成功后重放全部已发结果，外加迟到、冲突与 RELEASED 的结果；正序、倒序与部分重复 | SUCCEEDED（行不变） | 1 / 1 |
| F7 | app-server 对 consume 不回答（超时） | SUCCEEDED | 2 / 1 |
| F8 | provider 扣费后 app-server 退出 | SUCCEEDED（alreadyRedeemed） | 2 / 1 |
| F9 | 调用 consume 前 SIGKILL，后继接管 | SUCCEEDED（第 2 代） | 1 / 1 |
| F10 | provider 扣费后、回报前 SIGKILL | SUCCEEDED（alreadyRedeemed，第 2 代） | 2 / 1 |
| F11 | CONFIRMED 后 SIGKILL，后继只收到不带 key 的 REFRESH | SUCCEEDED（第 2 代） | 1 / 1 |
| F12 | CONSUME_OUTCOME、REFRESHED 在途时各重启一次 apiserver | SUCCEEDED | 1 / 1 |
| F13 | 刷新读失败两次 | SUCCEEDED | 1 / 1 |
| F14 | 刷新持续失败超过期限；随后准入 | REFRESH_FAILED/REFRESH_EXPIRED；新读前拒为 SNAPSHOT_STALE | 1 / 1 |
| F15 | claim 前账户切换 | NOT_ATTEMPTED/ACCOUNT_CHANGED | 0 / 0 |
| F16 | 可能已扣费的调用之后账户切换 | UNRESOLVED/ACCOUNT_CHANGED（不是 NOT_ATTEMPTED） | 1 / 1 |
| F17 | CONFIRMED 后账户切换 | REFRESH_FAILED/ACCOUNT_MISMATCH | 1 / 1 |
| F18 | 无 leaseOwner / 无能力；第二个活进程在续租的 claim 上反复 heartbeat | SUCCEEDED（仍是第 1 代） | 2 / 1 |
| F19 | 收到后才 draining，未开始的 claim 交回 | SUCCEEDED（后继立即领取） | 1 / 1 |
| F20 | 调用后 draining，不再投递 | SUCCEEDED（后继第 2 代，旧进程不再调用） | 2 / 1 |
| F21 | 旧进程带更旧快照的 heartbeat 迟到 | SUCCEEDED；存储块不倒退 | 1 / 1 |
| F22 | 持有者被分区、被接管，恢复后被拒 | SUCCEEDED（第 2 代） | 2 / 1 |
| F23 | consume 始终拿不到 outcome，过期；随后准入 | UNRESOLVED/CONSUME_EXPIRED；新读前拒为 SNAPSHOT_STALE | 0 / 0 |

每个场景结束时统一断言以下七条（`Scene.finish`）：
1. 终态符合预期，并且再一轮读取、heartbeat 以及停止所有进程后，行完全不变。
2. 每 25 毫秒采样一次行，全部只向前：状态序、claim 代数、outcome、确认时间都不倒退，key 与 request id 不变。
3. provider 账本：每次调用都只带这个 key，调用次数符合预期，扣费 ≤ 1，确认之后没有任何调用。
4. key 只出现在 CONSUME command 里，从不出现在结果、回执或 REFRESH 中。
5. 每一次存储块的替换都被快照顺序接受，旧读从未覆盖新读。
6. 两侧都有按 operationId 的日志：apiserver 有 admission、delivery、receipt，每个结果都有回执行；
   runner 的 `consume/called` 数等于 provider 听到的调用数。
7. 两侧所有日志以及进程的全部回答中，不含 provider key、runner token、accountId、email、账户指纹、指纹 key、
   环境变量哨兵值。fake 的错误回答里特意带上 accountId 和 email，用来验证 provider 文本不入日志。

脚本打印每个场景的一行报告：终态、调用数、确认后调用数、扣费、代数、泄漏数、状态轨迹、两侧日志事件序列。

---

## 6. 人工恢复：能做什么，不能做什么

**不能做**（每一条都会破坏"最多一次"，或者触发器本来就拒绝）：
- 改 `provider_idempotency_key`、`client_request_id`、`account_fingerprint`、`runner_id`。
- 把 `consume_state` 从 CONFIRMED / NOT_ATTEMPTED / UNRESOLVED 改回 PENDING 或 CLAIMED，好让它"再试一次"。
  这会让同一个 operation 再次下发 CONSUME。
- 修改已结算的行，例如把 UNRESOLVED 改成 SUCCEEDED 或 NOT_ATTEMPTED。
- 为已有 operation 手工拼一个 CONSUME command 发给 runner，或用别的 key 调用 provider。
- 用 `session_replication_role = replica` 绕过触发器写行。harness 只用它回拨时间戳来模拟时间流逝，生产上没有理由这样做。

**可以做**：
- 等待。所有在途 operation 都会在期限后至多 60 秒内结算。
- 让 runner 读一次账户：重启 runner，或者等 probe 周期。这会解除 §2.4 的准入等待，并给出权威数量。
- 停掉多余的 runner 进程（§4.8）。
- 删除 runner。operation 随 runner 级联删除；删除不会调用 provider。
- 对用户的答复一律以刷新后的数量为准，并按 §3 说明各终态的含义。

---

## 7. 安全边界审查结论

| 边界 | 威胁 | 控制 | 证据 | 结论 |
| --- | --- | --- | --- | --- |
| provider key 暴露面 | key 泄漏后，任何持有者都能"代表"这次确认调用 consume | key 只进 CONSUME command（heartbeat 响应，runner token 鉴权）；不进用户 API、Web、结果、回执、REFRESH、日志；日志行点名秘密强制脱敏 | shared spec（view 无 key）；relay pg (2)(5)(7)；harness 每场景第 4、7 条；Go `TestCodexResetLogLinesCarryTheOperationAndNothingSecret` | 通过 |
| 日志与指标泄漏 | 日志带出 token、accountId、email、provider 错误文本、环境变量 | 字段白名单加值校验；runner 错误只记分类；usage probe 不再记录 app-server 错误文本（本任务修复） | apiserver `codex-reset-telemetry.spec.ts`；Go `TestPlanUsageProbeLogsNoProviderErrorText`；harness 第 7 条 | 通过 |
| 指标基数 | 以 id 为标签撑爆监控 | 闭集标签，256 组合上限，溢出折叠 | `codex-reset-telemetry.spec.ts` | 通过 |
| 跨 runner / 跨 owner | 用自己的 runner token 操作别人的 operation | 结果按认证 runnerId 围栏，他人 operation 一律 OPERATION_NOT_FOUND，且日志不输出其任何状态 | relay pg (9) | 通过；残余见 R5 |
| runner token 持有者 | 伪造本 runner operation 的结果（如谎报 reset） | 信任边界：runner token 等于该机器的全部执行权；结果须属于当前 claim，且只能单调前进 | 契约 §6.3；relay pg (8) | 接受（设计边界） |
| 重复消费：同 operation | 重试、重投、重启、旧进程造成二次扣费 | 单 key 加 provider 幂等；在途唯一；claim 续租加调用新鲜度；CONFIRMED 后只下发 REFRESH；终态不可变（应用层与触发器双层） | harness F1–F23；shared 随机交错；Go consume、relay、hardening 测试 | 通过；残余见 R1、R2 |
| 误导用户再次确认 | 可能已扣费时显示"未扣费"，或基于旧数量再次确认 | §2.3 修复 NOT_ATTEMPTED 的误判；§2.4 准入等新读；`clientRequestId` 重放 | harness F14、F16、F23；Go `TestCodexResetConsumeNeverReportsNotCalledOnceACallWentOut`；shared 准入用例 | 通过；UI 侧见 R3 |
| 旧快照覆盖 | 旧进程或乱序 heartbeat 把数量改回扣费前 | 快照顺序比较加 CAS，REFRESHED 块同样经过比较 | harness F21；plan-usage pg spec；shared CAS 表 | 通过 |
| 账户范围 | 切换账户后花掉另一个账户的 credit | 每次调用前在同一 app-server 上读账户，指纹不符不调用；续租要求存储块账户一致 | harness F15、F16、F17；Go consume 测试 | 通过 |
| 自动化误扣真实 credit | CI 或测试消费真实 credit | 所有测试走 fake app-server；脚本在 PATH 最前放 guard `codex`，命中即红 | 四个脚本的 guard-hits 检查 | 通过 |

---

## 8. 残余风险（未消除，已暴露或已限界）

- **R1 暂停在检查与调用之间**
  - 情形：进程通过调用新鲜度检查之后、请求真正到达 provider 之前，被暂停超过约 40 秒（GC、SIGSTOP、宿主冻结），
    期间 claim 被接管、后继已记录 outcome。旧进程恢复后仍会用**同一个 key** 调用一次。
  - 影响：若后继记录的是 reset/alreadyRedeemed，provider 答 alreadyRedeemed，不扣费。若是 nothingToReset/noCredit，
    这次调用可能扣费，operation 却记"未扣费"。
  - 暴露方式：旧进程的结果会被拒并计入 `consumed_outcome_from_stale_claim` 或 `outcome_conflict`（§4.7）。
  - 限界：需要暂停超过接管窗口，并且窗口资格恰在期间改变。
- **R2 app-server 放弃后请求仍在上游处理**
  - 情形：runner 超时放弃调用后，Codex 后端仍可能在稍后处理该请求。
  - 影响：同 R1，同一 key 至多扣一次。
  - 暴露方式：迟到结果被拒时计入 anomaly；若没有迟到结果，以刷新数量为准。
- **R3 UI 分支未传 `readRequiredAfter`**
  - 情形：UNRESOLVED 或 REFRESH_FAILED 之后，入口可能显示为可点。
  - 影响：API 拒为 409 `SNAPSHOT_STALE`，不会建 operation。
  - 后续：需由 UI 或 E2E 任务确认界面对这一拒绝的呈现。
- **R4 时钟偏差**
  - 情形：准入守卫比较 runner 时钟的 `fetchedAt` 与服务器时钟的 `completedAt`。
  - 影响：runner 时钟快于服务器时，结算前开始的读可能被当作结算后的读（提前放行，窗口等于偏差量）；
    慢于服务器时，放行推迟（安全方向）。
  - 限界：生产环境应有 NTP，偏差通常在秒级以内。
- **R5 结果路由对他人 operation 加行锁**
  - 情形：一个 runner 用自己的 token 提交带他人 operationId 的结果时，服务端在判定不属于它之前，会对该行执行一次
    `SELECT … FOR UPDATE`，然后回答 404。
  - 影响：只是短暂占用锁，不写入、不泄露。
- **R6 真实后端的并发同 key 语义未实测**
  - 情形：所有结论建立在 codex-cli 0.154.0 schema 的描述上（"reuse the same value when retrying that attempt"），
    自动化从不接触真实账户（契约 §11）。
  - 后续：发布前可由账号所有者在测试账户上做一次人工只读观察，但本任务不这样做。
