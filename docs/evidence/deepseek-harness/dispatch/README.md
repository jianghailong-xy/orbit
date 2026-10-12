# D1 — Harness dispatch through the real control plane (2026-10-06)

Defect D1 (P6 report): the runner advertised `claude,codex,opencode,antigravity`, so the P1b gate refused every
DeepSeek Harness session at create (`409 DeepSeek Harness requires a newer Orbit runner with dsh support`).

## What the gate reads

- **Claim/reclaim** (`RunnerApiController.claim/reclaim`): `dsh` in the request's `X-Orbit-Supported-Providers`
  **and** `provider:dsh` in the runner's persisted heartbeat capabilities (with `capabilitiesReportedAt`). Both.
- **Session create / resume / config** (`sessions.service.ts`): only the persisted `provider:dsh` capability.
- **The heartbeat** derives every `provider:*` capability from the same header (`withProviderDeclarations`); a
  heartbeat without the header withdraws them.

The runner sends one header constant on every request (`Transport.do`), so the fix is that constant:
`src/runner-go/transport.go` `runnerSupportedProviders` now ends in `,dsh`. No server change.

The declaration is protocol support, like `antigravity` before it. Whether dsh is installed or the platform is
supported stays in the dsh health report (`dsh_health.go`): a session claimed on a machine without it fails at
launch with that report's `DSH_NOT_INSTALLED` / `DSH_PLATFORM_UNSUPPORTED` repair, never as Claude.

## Acceptance

`bash scripts/test-dsh-dispatch.sh` (+ `scripts/test-dsh-dispatch.mjs`, mock model in
`scripts/deepseek-harness-dispatch/`): disposable postgres:16-alpine ← `prisma migrate deploy`, production
apiserver `node dist/main.js`, two runners `go build` from the tree (`orbit register` + `orbit run`, own
ORBIT_HOME), dsh 0.2.0-rc.2 `npm ci` from the runner's embedded P0 lock into each version directory (CLI sha256
checked against `dsh-v0.2.0-rc.2/summary.json`), every other engine a recording shim. Runner B sits behind a link
that can rewrite the provider header to the pre-D1 value on every request — byte-for-byte what an older runner sends.

| Scenario | Proves |
|---|---|
| D1-S1 | claim, reclaim and heartbeat carry `dsh`; the runner row persists `provider:dsh` beside the other providers |
| D1-S2 | `POST /sessions` on a `runtime: dsh` provider → claimed by runner A → one turn on the pinned dsh against the mock (assistant event ingested from runner A, turn `ANSWERED`, ACP id persisted = dsh's `init` id); launch record: per-session `DSH_HOME` with `orbit-owner.json` (version, cwd), one resident `dsh --profile acp` child of the runner with the provider key; `end` settles `CANCELLED`/`ended` (the owner-end status of every engine), ACP id kept, dsh exits |
| D1-S3 | legacy header: heartbeat drops `provider:dsh`; a Harness session already waiting for that runner is not handed out on 3 claims/reclaim and carries the upgrade notice; create (configured and built-in `dsh`) → 409 with the P1b message, no row |
| D1-S4 | Claude sessions on current and legacy runners are claimed and launch `claude -p --input-format stream-json …` (the shim), no dsh |
| D1-S5 | the same runner restarted with the current header claims the waiting session and runs its turn |

The script exits non-zero on any build/startup failure and unless its report names exactly these five scenarios,
each PASS (self-tested against missing, renamed, duplicate, skipped and failed reports). `report.json` is the run
on the merged tree (`adf83e133` = this branch + origin/main `5e5ce2fbe`).
