# Running-mode states on a real apiserver

The web's Mode capsule, its menu, the transcript's mode-change lines and the Agent tools drawer (board
`docs/mocks/permission-mode-actual`, task 350TVt7QvzeqPJKO7tFuS), shot against this checkout's apiserver on PostgreSQL
instead of the ui-migration fixtures, and the web tests' mode fixtures held to what that server answers. The Wiki's chat
panel (task 354kMqC6hhwBWk2gH93W7) is shot there too: its chats are made through `POST /wiki/spaces/:id/chats`. Loopback
only; nothing runs an engine.

```sh
bash scripts/worktree-overlay.sh                      # once per checkout: node_modules, Prisma client, shared dist
(cd src/apiserver && npm run build)                   # the server under test
export PMA_STACK_DIR=/var/tmp/permission-mode-actual-stack
bash scripts/permission-mode-actual-stack/stack.sh up # postgres (tmpfs, a port docker picks), migrate deploy, the apiserver
node scripts/permission-mode-actual-stack/seed.mjs    # owner, two runners, workspaces, one session per state
node scripts/permission-mode-actual-stack/fixture-diff.mjs        # the fixtures against GET /sessions/:id and the Open list
(cd src/web && npx vite build --outDir "$PMA_STACK_DIR/dist")
node scripts/permission-mode-actual-stack/capture.mjs "$PMA_STACK_DIR/dist" "$PMA_STACK_DIR/shots"
bash scripts/permission-mode-actual-stack/stack.sh down           # stops the apiserver, removes the container
```

## Where each fact comes from

The owner's side is the stack's HTTP API: `POST /auth/bootstrap`, `/runners/enrollment-tokens`, `/runner/register`,
`/workspaces`, `/sessions`, `/sessions/:id/turns`, and `PATCH /sessions/:id/config` with the app's `x-orbit-client`
header (`web/…`, `ios/…` with `x-orbit-device: iphone`, `android/…`).

This server takes a runner daemon's calls only over the runner link (plain HTTP answers `426 UPGRADE_REQUIRED`), so the
runner's side is played as the apiserver's own pg specs play it (`src/apiserver/src/sessions/actual-permission-mode.pg.spec.ts`):
the production classes from `src/apiserver/dist`, on the stack's database. The link only carries these calls.

| Cause | Written by |
|---|---|
| CLAIM | `QueueService.claimSessionForRunner`, which records the mode it hands the runner |
| ENGINE_REPORT | `RunnerApiController.events`: an Agent Tools report carrying the mode Claude Code settled on |
| RUNNER_CORRECTION | the same ingest: a `permission_mode_corrected` system event, carrying `mode` |
| OWNER_PICK (client) | the owner's `PATCH …/config`, then the inbox's `setconfig` and the runner's `turnComplete` acknowledging it |
| ORBIT_CHANGE | `SessionsService.updateConfig(…, { origin: 'ORBIT' })` (as `TasksService.movePausedRunToPinnedModel` calls it), acknowledged |
| RESPAWN | the ingest: `resumed`, then the re-spawned engine's report, in one batch |

`seed.mjs` writes `state.json` (0600, it holds the runners' tokens and the owner's password) in `$PMA_STACK_DIR`;
`fixture-diff.mjs` writes the real answers to `payloads/`, and `capture.mjs` the answers the page itself was given to
`<out>/payloads/`.
