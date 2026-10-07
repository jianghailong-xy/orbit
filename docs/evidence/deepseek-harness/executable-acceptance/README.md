# D3 — EXECUTABLE acceptance on DeepSeek Harness (2026-10-06)

Defect D3 (P6 rev 2): on a Harness session the task's acceptance command, delivered as a `shell` turn after the
execution turn, was refused by the dsh loop ("DeepSeek Harness sessions do not run shell turns"); the task stayed
OPEN with `EXECUTABLE_ACCEPTANCE_UNAVAILABLE`.

## How acceptance is delivered (every engine)

- **apiserver** (`runner-api.controller.ts` `turnComplete`): when a task run's `message` turn succeeds on an
  EXECUTABLE task, it queues one `shell` turn whose content is the declared command and whose `clientTurnId` is
  `system:task-acceptance:v1:<turn>:<expected exit>` (`tasks/executable-acceptance-round.ts`). The inbox delivers
  it with `taskAcceptance: true` (+ `acceptanceTimeoutSeconds`). Its completion is compared — `shellExitCode`
  against the expectation — and writes `task.status` DONE/FAILED and nothing else (owner direction of 2026-09-03,
  pinned by `executable-exit-code-judgment.spec.ts`); a FAILED result also writes
  `acceptance command exited X; expected Y` to the session error. An incomparable result (a FAILED turn without a
  code) writes the `EXECUTABLE_ACCEPTANCE_UNAVAILABLE` comment instead — which is what D3 produced.
- **runner**: Claude (`session.go`), Codex (`codex.go`, `codex_appserver.go`), Kimi (`kimi_acp.go`), OpenCode
  and Antigravity all handle `shell` themselves with `runSynchronousShellTurn` (`shell.go`): `bash -lc` in the
  worktree, the agent env, the acceptance budget, a `shell-<turnId>` Bash tool_use/tool_result pair in the
  transcript, `shellExitCode` + `shellOutput` on turn-complete. The engine is never asked to run it.
  `dsh_acp.go` was the only loop that refused the turn.

## Fix

- `src/runner-go/dsh_acp.go`: a `shell` turn with `taskAcceptance` joins the loop's local queue (behind any
  message ahead of it) and is run by `runSynchronousShellTurn` in `p.execDir` — the same function, output and
  completion shape as every other engine. dsh is idle and never told. A `shell` turn **without** the flag (a
  person's `!` shell) is still refused exactly as before (P5).
- `src/apiserver/src/sessions/watch-turn-key.ts`: `system:task-acceptance:v1:` joins the reserved
  `clientTurnId` prefixes refused (400) at every client door. Before this a caller could name that key on its
  own `shell` turn, have it delivered as `taskAcceptance`, and — with the runner change — run a shell on a
  Harness session (and have its exit code judged against the task, on any engine). Only the server queues it now.

The `!` shell and the acceptance command share `runShellTurn`, but they are not one path: the acceptance turn
is server-authored, always synchronous, budgeted per task and judged. Opening the person's `!` shell on
Harness would bypass P5's design and dsh's own approval semantics (P4), so it stays closed.

No raw-output task comment: the comparison writes only `task.status` for every engine (above). The raw output and
exit code are in the session transcript and, on FAILED, the session error; D3-S4 holds Harness to Claude's record
(0 task comments on both). `postExecutableAcceptanceComment` in `tasks/reclaim-stalled-task.ts` has no caller on
main either, while the task-run brief (`tasks.service.ts`) still says the command, output and code are written to
the task comments — a mismatch outside this fix.

## Acceptance

`bash scripts/test-dsh-executable-acceptance.sh` (+ `.mjs`; fixtures `scripts/deepseek-harness-dispatch/`
`mock-model.mjs`, `fake-claude.mjs`): disposable postgres:16-alpine ← `prisma migrate deploy`, apiserver
`node dist/main.js`, one runner `go build` from the tree, dsh 0.2.0-rc.2 `npm ci` from the runner's embedded P0
lock (CLI sha256 checked), a local mock Messages endpoint with a synthetic key, `claude` = stream-json fake.

| Scenario | Proves |
|---|---|
| D3-S1 | Harness task (provider `runtime: dsh`) runs its brief on dsh (ACP id, model asked once), then the acceptance turn: kind `shell`, reserved key, content = declared command, `ANSWERED`; transcript `shell-<turnId>` Bash pair with the raw output; `$PPID` of the shell = the `orbit run` pid (exe = the runner binary), cwd = the workspace; no further model request, no refusal, no unavailable comment; task **DONE** |
| D3-S2 | same with a failing assertion: exit 1 ≠ 0 → task **FAILED**, session error `acceptance command exited 1; expected 0`, AssertionError in the transcript output |
| D3-S3 | a person's `!` shell on a Harness session → turn answered with "DeepSeek Harness sessions do not run shell turns", no runner shell, file untouched; a `shell` turn keyed `system:task-acceptance:v1:…` → 400 reserved, no row |
| D3-S4 | Claude tasks: DONE and FAILED, same transcript pair, same session error, same session status and the same task comment count as Harness |

Exit non-zero on any build/startup failure and unless the report names exactly these four scenarios, each PASS
(self-tested against missing, renamed, duplicate, skipped and failed reports). Negative control: the same script
against the tree without the `dsh_acp.go` change fails D3-S1/S2 with `EXECUTABLE_ACCEPTANCE_UNAVAILABLE`.
`report.json` is the run on the merged tree (`eadc27f59` = this branch + origin/main `3bee82785`).
