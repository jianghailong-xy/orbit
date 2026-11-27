# Captured permission-mode payloads

What a real apiserver answered to a signed-in Android client, for the mode control and the transcript's mode-change lines
(board docs/mocks/permission-mode-actual; project 350NMcNDulzkqRAFFUsXZ). Nothing here is written by hand.

How they were made, on this branch's server code:

1. A throwaway `postgres:16-alpine`, migrated with `prisma migrate deploy`, and `src/apiserver/dist/main.js` serving it.
2. The owner from `POST /api/auth/bootstrap`; runners, workspaces and sessions as rows in the real tables, as
   `src/apiserver/src/sessions/actual-permission-mode.pg.spec.ts` seeds them.
3. Every mode fact written through the server's own doors, as that spec drives them: `QueueService.claimSessionForRunner`
   (CLAIM, and the root runner's Bypass substitution), `SessionsService.updateConfig` with the runner inbox and the
   `setconfig` acknowledgement (OWNER_PICK naming the client; ORBIT_CHANGE for Orbit's own change), and
   `RunnerApiController.events` (ENGINE_REPORT from Claude Code's init frame, RESPAWN after `resumed`, RUNNER_CORRECTION from
   `permission_mode_corrected`).
4. The payloads read back over HTTP with the owner's token and `X-Orbit-Client: android/…`: `GET /api/sessions/:id` for each
   session, `GET /api/sessions?view=open`, `GET /api/runners` and `GET /api/workspaces/:id`.

| File | Session |
|---|---|
| `session-running-auto.json` | Asked for Auto, claimed in Auto. |
| `session-correcting.json` | Asked for Auto; Claude's init frame said Default (ENGINE_REPORT). |
| `session-corrected.json` | The same, then the runner's correction back to Auto (RUNNER_CORRECTION). |
| `session-no-auto-model.json` | Asked for Auto; the owner picked Haiku 4.5 on Android, which has no Auto (OWNER_PICK to Default). |
| `session-every-cause.json` | Every cause in turn: claim, Claude's report and the correction, the owner's picks on the web, iOS and Android, a re-spawn and its correction, Orbit's own model move, and the owner's Haiku 4.5 pick last. |
| `session-root-runner.json` | Asked for Bypass on a root runner: the claim handed Auto. |
| `session-pick-on-its-way.json` | Running in Auto; the owner's pick of Plan on the web is stored, its setconfig not yet acknowledged. |
| `sessions-open.json` | The Open list's rows for all of them. |
| `runners.json` | The two runners, with the catalogue that says Haiku 4.5 has no Auto. |
| `workspace.json` | The workspace a new session's composer reads. |

To make them again: `capture/stack.sh` and `capture/capture.js` from the task's evidence (uploaded with it), against a
worktree whose `src/apiserver/dist` is built from the server code to capture.
