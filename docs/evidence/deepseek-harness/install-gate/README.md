# F-P7-1 — a runner that declares dsh before the pinned CLI is installed (2026-10-06)

Finding F-P7-1 (P7 drill, S3): a runner upgraded to a dsh-declaring build sends `provider:dsh` in
`X-Orbit-Supported-Providers` and its heartbeat at once (`runnerSupportedProviders`, D1), whether or not
`${ORBIT_HOME}/engines/dsh/0.2.0-rc.2` exists. The P1b gates read only that declaration, so a Harness session created
through the API, the CLI or a task's dispatch was claimed by that runner and failed at launch:
`DSH_NOT_INSTALLED: … automatic engine installation is not authorized`. The web runner row already said "Not installed".

Direction confirmed by the project coordinator: **(b)** — the runner keeps declaring dsh (protocol support, D1); the
server reads the runner's last engine report before creating, resuming or handing out a dsh session.

## What the gate reads

`dshRuntimeUnavailable(runner.engines)` (`src/apiserver/src/runner-api/runner-provider-support.ts`), the engine report
the runner's last heartbeat stored (`enginehealth.go` → `sanitizeRunnerEngines`). Ready only when the dsh entry is
`installed`, has no `installationError`, and `dsh.versionCompatible` is true. Otherwise one of three notices, each led
by the runner's own code so the clients' existing repairs read it (web `dshRepair`, OrbitKit `DshRuntime.repair`):

| Engine report | Notice |
|---|---|
| no report, no dsh entry, unreadable, `installed: false` | `DSH_NOT_INSTALLED: DeepSeek Harness is not installed on this runner, or the runner has not reported it yet; install it from Providers, then try again` |
| `installationError` `DSH_PLATFORM_UNSUPPORTED` / `DSH_NODE_UNSUPPORTED` | `DSH_PLATFORM_UNSUPPORTED: DeepSeek Harness 0.2.0-rc.2 runs on Linux x64 runners with Node 26 only; use a runner that can run it` |
| installed, but another version, a failed version probe, or no version verdict | `DSH_VERSION_INCOMPATIBLE: this runner has a DeepSeek Harness version Orbit does not support; reinstall it from Providers, then try again` |

No runner change: the report already carried `installed`, `installationError` and `dsh.versionCompatible`.

## Where it applies

- **Create** (`SessionsService.create`) and **resume of an ended session** (`SessionsService.resume`): `409` with the
  notice, nothing written. Order: the P1b upgrade notice first (runner does not declare dsh), then the permission-mode
  refusal (400, P4), then the install notice. A task start that creates the session gets the same 409.
- **Claim** (`RunnerApiController.claim` → `QueueService`): the declaration is left as sent; the install refusal is
  handed to the queue (`dshUnavailable`), which withholds every dsh row of that runner (built-in `dsh` and configured
  rows with `runtime: dsh`) in the claim SQL — `orbit.runner_supports_dsh` is `0` for that claim — and marks the
  PENDING ones with the notice (`pausedPendingSessions`, the same pass that marks paused accounts). A follow-up on a
  persisted session is queued as usual and waits there; a claim clears the notice like the upgrade notice.
- **Not gated:** reclaim and lease takeover after a runner restart (they hand back sessions that runner already runs);
  config changes; every other engine on the same runner.

After the install (Providers → Install, `POST /runners/:id/install {engine: dsh}`) the runner re-probes and the next
heartbeat (≤30 s) reports `installed: true`: create and resume pass at once, and waiting sessions are handed over by
the next claim long poll (≤25 s), on their persisted ACP id and `DSH_HOME`.

## Tests

| Where | What |
|---|---|
| `src/apiserver/src/sessions/dsh-install-preflight.spec.ts` | create refused for 9 report shapes × built-in/configured; a persisted session's resume refused with nothing written, then revived after the report flips; create passes when ready; P1b upgrade notice still first; other engines unaffected |
| `src/apiserver/src/queue/dsh-install-gate.spec.ts` | the report → notice mapping (incl. missing/garbled reports); claim keeps the declaration and hands the queue the reason; the queue marks/holds dsh rows only; claim SQL capability and GUC `0`, and the notices are cleared on claim |
| `src/apiserver/src/queue/dsh-install-gate.pg.spec.ts` (`scripts/run-pg-spec.sh`) | real PostgreSQL through the real heartbeat, claim, create, follow-up and resume: IG-PG1…IG-PG7, including the Claude row on the same runner still claimed and P1b's upgrade notice for a non-declaring runner |
| `scripts/test-dsh-install-gate.sh` | end to end, below |

The fixture runner of `src/apiserver/src/sessions/dsh-session-routing.spec.ts` (P1a's "dsh admission" create case)
modelled a capable runner by its declaration alone; it now also reports the pinned CLI installed. No assertion changed.

### End to end: `bash scripts/test-dsh-install-gate.sh`

postgres:16-alpine ← `prisma migrate deploy`, production apiserver `node dist/main.js`, one runner `go build` from the
tree (`orbit register --no-auto-install-engines` + `orbit run`, own ORBIT_HOME), the pinned dsh 0.2.0-rc.2 from the
runner's embedded P0 lock (CLI sha256 checked against `dsh-v0.2.0-rc.2/summary.json`), the D1 mock model
(`scripts/deepseek-harness-dispatch/mock-model.mjs`), every other engine a recording shim.

- phase 0 — installed: two Harness sessions run one turn each; one is ended.
- phase 1 — the runner stops, its version directory is moved out, the same binary starts again: an upgraded runner
  with nothing installed.
- phase 2 — `POST /runners/:id/install {engine: dsh}`: the runner's own install relay runs `npm ci` from its embedded
  lock into a staging directory and publishes it (its npm cache seeded from the run's own install).

| Scenario | Proves |
|---|---|
| IG-S1 | the restarted runner still declares `provider:dsh` (and every other provider) and reports dsh `installed: false`, `DSH_NOT_INSTALLED`; reclaim left the persisted session idle, nothing started |
| IG-S2 | `POST /sessions` with the configured Harness key and with built-in `dsh` → 409, the not-installed notice; no row |
| IG-S3 | a follow-up on the persisted session → PENDING with the notice; a Claude session sent to the same runner meanwhile is claimed and launched; a further full claim cycle later the Harness session is still PENDING, 1 turn, same ACP id, `run_claimed_at` unchanged, its turn PENDING, the model never heard it, no dsh process |
| IG-S4 | `POST /sessions/:id/resume` on the ended session → 409 with the same notice; still CANCELLED/`ended`, one turn |
| IG-S5 | after the install: the runner published a new install (the removed one is still aside), reported it ready, and the waiting follow-up was claimed after that report (`run_claimed_at` ≥ the report's heartbeat) and answered on the same ACP id, by a resident dsh in the session's persisted `DSH_HOME`, a child of the runner |
| IG-S6 | the ended session resumes on its ACP id and answers; a new Harness session is created and answers |

The script exits non-zero on any build/startup failure and unless its report names exactly these six scenarios, each
PASS (self-tested against missing, renamed, duplicate, skipped and failed reports). `report.json` is the run on the
merged tree recorded below.

### Red check

The same tree with `dshRuntimeUnavailable` forced to return `null` (gate off): 4 of the 10 new unit cases and 5 of
the 7 PostgreSQL scenarios (IG-PG2…IG-PG6) fail; the rest are regression guards that pass either way (a ready runner
is handed dsh rows, the queue given a reason holds the rows, the P1b upgrade notice, other engines). With the gate on,
all pass.

## Results

Base: origin/main `6cdca5a03` (latest at the time, D3 included) with this change on top, uncommitted in the session
worktree. Every run below is on that tree; between them only `scripts/test-dsh-install-gate.mjs` changed (the
IG-S5 fix noted below) and this folder was added.

Project merge check (`mergeCheckCommand`), one step at a time, every exit code recorded:

| Step | Exit | |
|---|---|---|
| `npm run build` | 0 | shared, apiserver, web |
| `npm test -w @orbit/shared` | 0 | 390 passed |
| `npm test -w @orbit/apiserver` | 0 | 4435 passed, 0 failed, 0 skipped |
| `npm test -w @orbit/web` | 0 | 3971 passed (318 files) |
| `cd src/runner-go && go test ./...` | 0 | `ok orbit` |

The first merge-check run on the same base had apiserver exit 1: three existing specs (`runner-api-orchestration-credential`,
`runner-provider-gate`, `dsh-session-routing`) modelled a capable runner by its declaration alone. Two were answered in
the code (the claim's call to the queue keeps its shape unless there is a reason to hand over; the notice is written by
the queue, not by the claim), one by the fixture change above. Web and Go were 0 in both runs.

Acceptance scripts on the same tree:

| Command | Exit | |
|---|---|---|
| `bash scripts/test-dsh-provider-gate.sh` (P1b) | 0 | 27 named PostgreSQL and application tests, none missing or skipped |
| `bash scripts/test-dsh-dispatch.sh` (D1) | 0 | D1-S1…S5 PASS |
| `bash scripts/test-dsh-executable-acceptance.sh` (D3) | 0 | D3-S1…S4 PASS |
| `bash scripts/run-pg-spec.sh src/apiserver/src/queue/dsh-install-gate.pg.spec.ts src/apiserver/src/queue/dsh-provider-gate.pg.spec.ts` | 0 | 8/8 and 8/8 |
| `bash scripts/test-dsh-install-gate.sh` | 0 | IG-S1…S6 PASS — `report.json` |

The batch run of the install-gate script before that failed IG-S5 on the script's own comparison: `run_claimed_at`
(`TIMESTAMP(3)`) and `capabilities_reported_at` (`TIMESTAMPTZ`) were parsed by node-postgres in two zones on this UTC+8
host. The instants themselves had the claim 12.6 s after the report. The script now compares epoch milliseconds read
in SQL; the rerun above is green.

Facts of the recorded run (`report.json`): dsh 0.2.0-rc.2, CLI sha256 `1a03dee1…f307f` (= P0); install through Orbit
32 s from request to the heartbeat reporting `installed: true` (05:09:04.481Z); the waiting follow-up claimed at
05:09:17.119Z and answered on ACP session `e6f111d0…` — the id phase 0 recorded; the ended session revived on its own
id; a new session answered.

## Limits

- The gate is as fresh as the runner's last engine report, and a claim long poll reads it when it starts. If a
  published install disappears later, sessions can still be claimed and fail with the runner's `DSH_NOT_INSTALLED`
  until the next probe (≤5 min) reports it and one long poll after that. A runner that never had the install has no
  such window. That is why the end-to-end script waits one long poll after the not-installed report before queuing
  Harness work: phase 0's install is the one it removed.
- `DSH_VERSION_INCOMPATIBLE` has no repair card in the clients; they show the sentence. The web and macOS runner state
  (`dshRunnerState` / `DshRuntime.state`) still read a runner with no dsh report as `ready`, while the server refuses
  it as not installed — a state a runner is in only until its first engine probe lands.
