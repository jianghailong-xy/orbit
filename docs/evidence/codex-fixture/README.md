# TestRealCodexOnAChatGPTLogin × codex-cli 0.161.0：被录制的 429 限流为何变成 6 次请求

任务 34bslSTyH5vYiowbyNqny（基线修复，修 34bsfoNgSGRaA6bNeklVi）的证据。全部实测都在 HPC（runner
workstation-gpu，hostname `workstation`）上完成，`codex --version` = `codex-cli 0.161.0`，日期 2026-10-08（+0800）。

## 结论

1. **触发点**：runner 自带的 engine updater（`src/runner-go/engineupdate.go`，每 30 分钟跟 npm latest）于
   `2026-10-07T16:23:56Z` 把本机 codex 升到 0.161.0（`~/.orbit/engine-updates.json`：`"latest": "0.161.0"`；
   npm 上 0.161.0 发布于 `2026-10-07T16:04:02Z`）。`~/.codex/models_cache.json` 的 00:24（+0800）更新与升级在同一分钟；
   而本测试根本不读 `~/.codex`——它用 `isolatedCodexProbeEnv` 给每个 codex 一个临时 `CODEX_HOME`。
2. **行为变化来自上游一个有意的改动，不是回归**：openai/codex#49441「Honor server retry advice across Responses
   retries and fallback」（commit `6ba4bf9e647c`，2026-09-30，首个包含它的 tag 是 `rust-v0.161.0`）。PR 原文：
   *Allow `ServerOverloaded` and `RetryLimit` errors to retry when server advice is present, within the configured
   retry budgets … Keep quota, usage-limit, and policy failures terminal even when they include retry advice.*
   0.161.0 的 release notes 也写明：*Responses retries and WebSocket-to-HTTP fallback honor server retry guidance,
   reducing premature failures during overload. (#49441)*。上游还为它加了测试，断言的正是我们看到的行为（见下表）。
3. **错误类型没有变**：0.158 和 0.161 对这个 429 的最终分类都是
   `responseTooManyFailedAttempts{httpStatusCode:429}`，文案都是 `exceeded retry limit, last status: 429 Too Many Requests`
   （已入库的 0.158 fixture 里 `rateLimit.codex` 就是这个）。从来不是 `rateLimitExceeded`，见第 2 节。
   变的只有：**带 `Retry-After` 时**，它从“终止”变成“按服务器建议等够时间后重发，直到 stream 重试预算用完”。
4. **N = 6 的来历**：1 次首发 + `stream_max_retries` 次重试；`DEFAULT_STREAM_MAX_RETRIES = 5`，Orbit 里没有任何地方设置
   `stream_max_retries`/`request_max_retries`（`grep` 全仓库只有 `docs/codex-shared-pool-design.md:220` 一处文字）。
   HTTP 层对 429 不重试（`retry_429: false`），所以每一轮只有 1 个请求。实测 6 个 POST 间隔 2.008–2.010 s，正是
   recorder 的 `retry-after: 2`。
5. **对照**：同一个 429 **不带** `Retry-After` 时，0.161.0 仍然 1 次请求、88 ms 内直接失败（`willRetry:false`），
   与源码一致：`RetryLimit` 只有在有服务器建议时才可重试。

## 1. 源码证据（openai/codex，按 tag 固定）

| 位置 | 内容 |
| --- | --- |
| [`protocol/src/error.rs` L389–L436 @0.161.0](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/protocol/src/error.rs#L389-L436) | `retry_delay()`：返回 `None` 即终止。L416–L418：`ServerOverloaded \| RetryLimit(_) => self.server_retry_delay()`——有 `Retry-After` 才可重试 |
| [`protocol/src/error.rs` L384–L412 @0.158.0](https://github.com/openai/codex/blob/rust-v0.158.0/codex-rs/protocol/src/error.rs#L384-L412) | 0.158：`RetryLimit(_)`（L401）与 `ServerOverloaded` 都在 `=> None` 臂里，一律终止。0.159.3（L401）、0.160.1（L406）相同 |
| [`protocol/src/error.rs` L481 @0.161.0](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/protocol/src/error.rs#L481) | `RetryLimit(_) => CodexErrorInfo::ResponseTooManyFailedAttempts { http_status_code }`；L672 文案 `exceeded retry limit, last status: …` |
| [`codex-api/src/api_bridge.rs` L181–L240 @0.161.0](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/codex-api/src/api_bridge.rs#L181-L240) | HTTP 429 的分类：body `error.type == "usage_limit_reached"` → `UsageLimitReached`；`usage_not_included` / `insufficient_quota` 等 → 配额类；flex 不可用 → `FlexUnavailable`；**其余一切 429（含 `rate_limit_exceeded`）→ `RetryLimit{status:429}`**。L22–L48 把 `Retry-After` 挂到错误上 |
| [`http-client/src/transport.rs` L183, L224](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/http-client/src/transport.rs#L183) + [`retry_after.rs` L20–L39](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/http-client/src/retry_after.rs#L20-L39) | HTTP 错误的重试建议只取 `Retry-After` 头（秒数或 HTTP 日期），截止时刻按收到响应的那一刻算 |
| [`core/src/session/turn.rs` L1653, L1710 @0.161.0](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/core/src/session/turn.rs#L1653) | 采样循环：`max_retries = provider.stream_max_retries()`；`UsageLimitReached` 在 L1710 直接 `return Err`，根本不进重试 |
| [`core/src/responses_retry.rs` L88–L166 @0.161.0](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/core/src/responses_retry.rs#L88-L166) | L88 `retry_delay()` 为 `None` 即返回错误；L141 `retries < max_retries` 时：L155 发 `Reconnecting... {n}/{max}`（app-server 的 `error` 通知，`willRetry:true`），L165 `sleep_until(Retry-After 截止时刻)` 后重发 |
| [`model-provider-info/src/lib.rs` L64–L65, L451 @0.161.0](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/model-provider-info/src/lib.rs#L64-L65) | `DEFAULT_STREAM_MAX_RETRIES = 5`，`DEFAULT_REQUEST_MAX_RETRIES = 4`；HTTP 层 `retry_429: false` |
| [`codex-api/src/api_bridge_tests.rs` L79–L125 @0.161.0](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/codex-api/src/api_bridge_tests.rs#L79-L125) | #49441 新增的上游测试：`(429, "rate_limit_exceeded", true)`、`(429, "usage_limit_reached", false)`，并断言前者仍是 `ResponseTooManyFailedAttempts{429}` + 上述文案 |
| [`core/tests/suite/retry_after.rs` L346 @0.161.0](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/core/tests/suite/retry_after.rs#L346) | #49441 新增的 `responses_http_429_uses_retry_after`：带 `Retry-After: 1` 的 429 `rate_limit_exceeded` 在 sampling 循环里等 ≥1 s 后重发 |

## 2. usageLimitExceeded、responseTooManyFailedAttempts、rateLimitExceeded 的区别

- `usageLimitExceeded`：429 且 body `error.type == "usage_limit_reached"`（订阅额度用完，带 `resets_at`）。终止；0.161 也明确保持终止，
  即使带 `Retry-After`。`usage_not_included`、`insufficient_quota` 等配额类同样映射到 `usageLimitExceeded`，同样终止。
- `responseTooManyFailedAttempts{httpStatusCode}`：除上述之外的 HTTP 429（以及 HTTP 层重试用尽）都是 `RetryLimit`。名字虽是“超过重试次数”，
  0.161 起只要带 `Retry-After` 就会在 sampling 循环里重试，用完 `stream_max_retries` 后才以它告终；不带则立即告终。
  中途每次重试的通知是 `responseStreamDisconnected{httpStatusCode:429}` + `Reconnecting... n/5`、`willRetry:true`。
- `rateLimitExceeded`：只用于**响应流内**（SSE `response.failed`）报告的限流（`CodexErrorDetails::RateLimitExceeded`），历来可重试。
  HTTP 状态码层面的 429 不会映射到它，所以这个场景从来不是 `rateLimitExceeded`。

## 3. 本机实测

- `before-fix-codex-0.161.0.txt`：修改前，在本 worktree（项目线 tip `a7f0878f4`）上复现：`Requests:6 … WillRetry:true`，`:569` 失败。
- `rate-limit-timeline-codex-0.161.0.txt`：用 `instrument.py` 临时插桩（不入库）跑一次，记录 recorder 每次应答的时刻与 app-server 通知：
  6 个 `POST /backend-api/codex/responses` → 429，间隔 `2.009s 2.01s 2.01s 2.008s 2.008s`；5 条 `willRetry:true` 的
  `Reconnecting... 1/5…5/5`；最后一条 `willRetry:false` 的 `responseTooManyFailedAttempts{429}`，`turn/completed` 为 failed，
  `durationMs 10116`。对照场景 `rateLimitNoAdvice`（同一 429 去掉 `retry-after`）：1 个请求，`willRetry:false`，`durationMs 88`。
  各场景 verdict 也在同一文件末尾。复现：在 `src/runner-go` 下 `python3 -I <本目录>/instrument.py codex_chatgpt_backend_recording_test.go`
  后跑 `go test -count=1 -run '^TestRealCodexOnAChatGPTLogin$' -v .`，再 `git checkout` 该文件。
- `after-fix-codex-0.161.0.txt`：修改后同一测试通过（另外连跑 3 次均通过，11.2–11.7 s）。

## 4. 选了 (a)：按 0.161.0 的真实行为改期望，不重录 fixture

改动只在 `src/runner-go/codex_chatgpt_backend_recording_test.go`：

- 限流场景改为断言：请求数 `== 1 + codexStreamMaxRetries`（5，codex 的默认 `stream_max_retries`）、`WillRetry == true`、
  `TurnStatus == "failed"`、`CodexErrorInfo == {responseTooManyFailedAttempts:{httpStatusCode:429}}`（以前没断言分类），
  并且**每次重发距上一个 429 不少于它 `retry-after` 要求的 2 s**——这条把“按服务器建议等待”与“本地退避乱重试”区分开，
  也保住了“最终失败、有上限”的语义（6 次后必定 failed，不是无限重试）。recorder 为此记下每次应答的时刻（未导出字段，fixture JSON 不变）。
- 文件头注释改写限流那一条，并注明入库 fixture 是 0.158 录的、0.161 起不再是“一次不重试”。

不选 (b)（重录 fixture）的理由：

- Go 测试的断言是写死的，不读 fixture；而录制只在全部断言通过之后才写文件——(b) 必须先做 (a)，单靠重录修不了红。
- fixture 被 `src/apiserver/src/providers/pool-login-gateway.pg.spec.ts` 读取：L408 断言 `SESSION.codex === CLI.codex`（必须和
  `codex-gateway-recording.json` 同一个 codex 版本），L876 断言 `rateLimit.codex` 为 `[1 次, willRetry false]` 并据此写着
  “The codex CLI does not ask again on its own: the wait is the gateway's”。在 0.161 上重录会让这两条立刻变红，修它们要改两个未声明的文件，
  而且 L876 背后是网关的设计前提（见第 6 节），不是测试层面能决定的。
- 入库 fixture 自报 `"codex": "codex-cli 0.158.0"`，作为 0.158 的录音仍然真实。

## 5. 同文件其它场景：都不受这次漂移影响，断言不变

| 场景 | 0.161.0 实测 | 为什么仍然正确 |
| --- | --- | --- |
| turn | completed，1 个请求，`Authorization: Bearer <login>` + `ChatGPT-Account-ID` | 没有错误路径，#49441 不涉及 |
| refresh（401 `token_expired`） | completed，3 个 POST（与 0.158 fixture 相同），恰好 1 次 refresh，body 仍是 `{client_id, grant_type, refresh_token}`，最后一次用新 token 重发 | 401 由 model client 的 `UnauthorizedRecovery`（`core/src/client.rs` `handle_unauthorized`）在重试决策之前处理，#49441 没碰这条路径 |
| usageLimit（429 `usage_limit_reached`） | failed，1 个请求，`usageLimitExceeded`，`willRetry:false` | `UsageLimitReached` 在 `turn.rs` L1710 直接返回，且 `retry_delay()` 为 `None`；#49441 明确保持终止。只有给人看的文案与 0.158 不同（设置页 URL 由 `chatgpt.com/codex/settings/usage` 变为 `chatgpt.com/settings/usage`，重置时间按录制机时区渲染），本测试不断言文案 |

本文件没有单独的“token 失效”场景：401 `token_expired` 就是 refresh 场景；“refresh 被拒 / 已签出”等是网关侧的
`pool-login-gateway.pg.spec.ts` (5)，不跑 codex。

## 6. 对产品的影响（本任务未改产品代码）

网关的设计前提“codex 自己不重试 429”在 codex ≥ 0.161 上**只对不带 `Retry-After` 的 429 成立**：

- `src/apiserver/src/providers/pool-gateway.service.ts` L48–L54、L71–L74、L253–L256 写着 “Codex does not retry a 429 itself
  (measured on 0.160 …)”；`docs/codex-shared-pool-design.md:220` 同义；`pool-login-gateway.pg.spec.ts` 头注释 (6) 与 L876 同义。
- 网关自己的等待（最多 4 次发送、单次 ≤20 s、总计 ≤40 s）用完后，会把上游的 429 **原样**（含 `retry-after`）交还 codex，并给凭据打
  `throttled_until`——这个标记只影响新的 claim，请求路径不看它。codex 0.161 收到后会按 `retry-after` 等待、用同一个 session token 再发最多 5 次，
  每次又经网关在**同一个被限流的凭据**上走一轮等待：最坏多出约 20 次上游请求（5 × 4），换号被推迟几分钟。
- 可选方向（需要产品决定）：网关交还 429 时去掉 `Retry-After`，让 codex ≥ 0.161 像设计假设的那样立即失败（第 3 节对照场景证明有效）；
  或者接受 codex 的重试并相应调整网关的等待与标记。之后在当前 codex 上一并重录两个 fixture、更新 spec。

## 7. 验证（HPC，codex-cli 0.161.0）

验收命令原文：`cd src/runner-go && go test -count=1 -run '^TestRealCodexOnAChatGPTLogin$' . && go test -count=1 ./...`

| 树 | 结果 | 文件 |
| --- | --- | --- |
| 本任务 worktree：项目线 tip `a7f0878f4` + 修复 `2e28df1d5` | `ok orbit 12.094s`、`ok orbit 238.605s`，**退出码 0** | `acceptance-worktree-a7f0878f4.txt` |
| origin/main `788bfa472` + 修复（cherry-pick） | 单测 `ok 14.869s`；全量唯一失败 `TestDshLifecycleCrashRestartRecovery/runner-killed-mid-tool`（`turn t2 never settled`），退出码 1 | `main-788bfa472-suite-run1.txt` |
| origin/main `4354230b0`（2026-10-07T20:24Z 时最新）+ 修复（cherry-pick） | `ok orbit 12.109s`、`ok orbit 244.344s`，**退出码 0** | `main-4354230b0-suite.txt` |

`788bfa472` 那次的失败与本改动无关：它是 DSH lifecycle 测试 harness 在 CPU 负载下的已知竞态（假控制面缺 lease-generation 栅栏等），
分析与仅改测试的修复见 `0f11c975e` 的 `docs/evidence/deepseek-harness/lifecycle-flake/README.md`（在 `project/34b7qmu7w992fd5pVBHYW`
上，尚未进 main）；它不跑 codex，也不碰本文件。另外：修复后的单测在本 worktree 连跑 3 次均通过（11.2–11.7 s）；`gofmt -l`、`go vet ./...` 干净。
