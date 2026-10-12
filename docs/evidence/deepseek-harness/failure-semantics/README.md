# D2 / F1 — DeepSeek Harness failure semantics

Acceptance: `bash scripts/test-dsh-failure-semantics.sh` (named Go, apiserver PostgreSQL + unit, Web, OrbitKit in `swift:6.1`;
a missing, unmatched, skipped or unstartable scenario exits non-zero).

## D2 — a real DeepSeek 401 is an invalid key

Measured shape (P0 recordings, P6 real endpoint): dsh 0.2.0-rc.2 answers `session/prompt` with
`{"code":-32603,"message":"Internal error: turn failed: Authentication Fails, Your api key: ****0000 is invalid (request_id: …)"}` —
no `data`, upstream status and `authentication_error` dropped.

Runner (`dsh_health.go` `dshRequestValidation`), in order:
1. a runner code already on the text (`DSH_REQUEST_FAILED` lead, `DSH_CREDENTIAL_MISSING`, `DSH_CREDENTIAL_INVALID`);
2. missing-key wording;
3. an upstream HTTP status in the ACP error data (`status` / `statusCode` / `status_code` / `httpStatus`, top level or under `error`):
   401 → `DSH_CREDENTIAL_INVALID`, anything else → `DSH_REQUEST_FAILED`, whatever the wording says;
4. wording: the existing phrases plus `authentication fails` and `api key(?:: *\S+)? is invalid` (the masked-key form).

A failed turn's error (completion and transcript `error` event) leads with `DSH_CREDENTIAL_INVALID: ` / `DSH_CREDENTIAL_MISSING: `, and with
`DSH_REQUEST_FAILED: ` when a status decided, so Web `dshRepair` and OrbitKit `DshRuntime.repair` read the runner's verdict; both also carry
the same phrases and pattern for older runners. Rate limits (429 / "Rate Limit Reached"), 5xx, 402 balance, dropped connections and transport
EOF stay `unknown / DSH_REQUEST_FAILED` and show no key repair. Diagnostics stay the fixed codes; error text keeps the launch-key redaction.

## F1 — unknown usage is not $0

- Runner: every dsh turn completion carries `UsageUnknown`, and `TurnCompleteRequest` then omits `costUsd` (servers of every age read an
  absent cost as nothing added). Other engines still send `costUsd`, a measured 0 included. `RunFinalizeRequest.costUsd` is never measured
  and is now omitted for all engines (no server reads it).
- Server: a session is "usage unreported" when its runtime is dsh (native or a configured `runtime: dsh` provider, the identity
  queue.service's gate uses), `cost_usd = 0` and it has no usage rows.
  - Model-routing report: `usageUnknownCompletedTaskCount` per group; `tokensPerCompletedTask` / `costUsdPerCompletedTask` are `null` when
    any completed task in the group ran with unknown usage.
  - Attempt budget: `costMicros` is `null` → the COST dimension reads `UNMEASURED`, not `WITHIN` at $0.
  - Claude, Codex, the Claude-borrowing `deepseek` preset and a dsh session that did record usage read exactly as before.
