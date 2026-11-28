# A refused Auto correction, and a claim's substitution, as a real apiserver answers them

Payloads the web, OrbitKit and Android tests of the running-mode states read (board `docs/mocks/permission-mode-actual`,
A1 and B1; project 350NMcNDulzkqRAFFUsXZ, task 354kzrnSltZOM5gAfavxq). Nothing here is written by hand.

How they were made, on this branch's server and runner code (scripts kept with the task's evidence: `stack.sh`,
`capture.mjs`, `claim.mjs`, `run_all.sh`, the fake CLI's shim and script):

1. A throwaway `postgres:16-alpine`, migrated with `prisma migrate deploy`; `src/apiserver/dist/main.js` serving it with
   the runner link on; `src/link-gateway` in front of it on loopback.
2. A real runner: `src/runner-go`, registered with an enrollment token and running `orbit run` over the link. Its only
   `claude` is the runner tests' fake CLI (`src/runner-go/fake_claude_test.go`, built with `go test -c`), scripted to settle
   on Default in its init frame and to answer `set_permission_mode auto` with Claude Code's own refusal,
   "Cannot set permission mode to auto: auto mode unavailable for this model" (measured on 2.1.332 for Haiku 4.5;
   `claude_mode_correction.go`). The real CLI on this account runs Haiku 4.5 in Auto, so it gave nothing to refuse.
3. The owner's side over HTTP: `POST /auth/bootstrap`, `POST /workspaces`, `POST /sessions` (Haiku 4.5, Auto).
4. Read back with the owner's token and each app's `X-Orbit-Client`: `GET /api/sessions/:id` and
   `GET /api/sessions/:id/events/page?tail=1&limit=500`, `GET /api/runners`, `GET /api/workspaces/:id`.

| File | What |
|---|---|
| `session-refused.{web,ios,android}.json` | Asked for Auto; Claude's init frame said Default (ENGINE_REPORT); the runner's correction was refused. Read as the turn ended. |
| `session-refused.events.json` | Its events: the `permission_mode_correction_failed` system event with `mode`, `requested`, `reason`. |
| `session-root-claim.{web,ios,android}.json` | Bypass asked for on a runner that runs as root: the claim handed Auto and recorded `requestedMode: bypassPermissions`, `reason: ROOT_RUNNER`. Claimed through `QueueService.claimSessionForRunner` on the same database (the runner's side played as `scripts/permission-mode-actual-stack/lib.mjs` plays it): a root runner refuses Bypass at admission, so no daemon can be handed it. |
| `session-root-claim.events.json` | Its events. |
| `runners.json`, `workspace.json` | The runners and the refused session's workspace. |
