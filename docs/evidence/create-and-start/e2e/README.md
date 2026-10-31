# startNow and "Create and start", end to end on an isolated stack

Task `34o9etf0IZ0t5oPbYGDz9`, run 2026-10-29 06:15–06:17Z. Result: **33/33 checks** (`run/checks.json`).

## The stack

Everything was built from commit `d63a15a5b9d19fb3e56e931ad787111a9e85f403` (`src/apiserver` tree `3a284c67…`,
`src/shared` `29bf6cd6…`, `src/web` `fbaf4adc…`, `src/runner-go` `38424f36…`; runner version 0.1.240) and ran on this
host, loopback only, from `kit/`:

- PostgreSQL 16 on tmpfs with every migration (0456 included), the apiserver, and the web console served from the
  built `dist/` beside `/api` (`kit/gateway.mjs`).
- A real runner, registered through `kit/proxy.mjs`, which logs every request this feature consists of (card filed,
  decision polled, create, start) with what the runner sent and what it was answered (`run/runner-wire.jsonl`).
- The agent is `kit/fake-claude`, copied unchanged from the R29-13 kit (`docs/evidence/landing-observation/e2e/kit`):
  no model, account or network. A conversation's `E2E-MCP <id> <tool> <json>` line makes it call that tool through
  the `orbit mcp` server the runner configured, inside the session, so `task_create` and `task_create_batch` run their
  real handlers and raise real cards. A task run's `E2E-DO: commit` makes it commit a work file in its worktree.
- The owner is a Playwright browser on the real web console, signed in with the owner's tokens. It reads each card,
  photographs it, and presses its buttons.
- Isolation as in R29-13: every process under `env -i`; the runner in a private mount namespace with `/root` hidden and
  no engine but the fake one on its PATH; random secrets kept outside the repository. Nothing touched production.

## What happened

| | Filed | The card (web console, `run/shots/`) | Pressed | Result |
| --- | --- | --- | --- | --- |
| A | `task_create` with `startNow: true` | "1 starts running within the minute", no "Create and start" (`A-startNow-card-no-button.png`) | Create it | created and started at once: session **`4HK4QFa6KqNW438AMZnJdg`**, RUNNING right after the yes, AWAITING_INPUT once its run ended |
| B | `task_create` without `startNow` | "1 needs a manual start — nothing will trigger it", with "Create and start" beside "Create it" (`B-create-and-start-card-with-button.png`) | Create and start | created and started at once: session **`4iQ9kFOYQmQ0bwkEEohPeh`**, RUNNING, then AWAITING_INPUT |
| C | the same, without `startNow` (control) | as B (`C-plain-card-with-button.png`) | Create it | created and **still OPEN 70 s later**: no session, no runAt |
| D | `task_create_batch`, item D1 with `startNow` | "1 starts running within the minute" + "1 needs a manual start", no "Create and start" (`D-batch-card.png`) | Create 2 tasks | D1 started by the server's schedule scan 43 s after the create, not by the runner (session `7FbBK7vKoE5JKlsulqP6pp`); D2 OPEN, no session |
| E | `task_create` with `startNow` and `runAt` | none: refused before any card | — | `startNow cannot be combined with runAt: …`; no card filed |

Each started run committed its work file on its own task branch (`run/fake-claude.jsonl`, `task-work`): A `a82843877a`,
B `89445ccd9c`, D1 `af2090a838`.

What the runner sent and was answered (`run/runner-wire.jsonl`):

- Each single-task card was filed with `acceptsStartAfterCreate: true` beside its input (the runner acts on the
  owner's start); the batch card without it.
- A's card was filed with `runAt: "2026-10-29T06:15:32Z"`, its create carried the same runAt, and
  `POST /api/runner/tasks/34oAroGJ1zcyZLVqcP2Fn/execute` (with a `triggerId`, as task_start sends) answered 201
  `{"ok":true,"sessionId":"4HK4QFa6KqNW438AMZnJdg"}` 40 ms after the create.
- B's card was filed with no runAt. The decision the runner polled was `{"status":"ALLOWED","behavior":"allow",
  "startAfterCreate":true}`; its create then carried `runAt: "2026-10-29T06:15:35Z"` and
  `…/34oArr2SPT8wJUaINDknP/execute` answered 201 `{"ok":true,"sessionId":"4iQ9kFOYQmQ0bwkEEohPeh"}`.
- C's decision carried no `startAfterCreate`, its create no runAt, and nothing started it.
- Exactly two immediate starts were made, for A and B. The batch made none.

The database, read only at the end (`run/queries.txt`): `approval.start_after_create` is true on B's card alone; every
single-task card carries `input.acceptsStartAfterCreate = true` (recorded by the server from the runner's declaration)
and the batch card does not; the forecast stored on each card (`input.preview`) is startingNow 1 for A,
needsManualStart 1 for B and C, and startingNow 1 + needsManualStart 1 for the batch. A, B and D1 each have one session,
C and D2 none, and every runAt is null again: the run that started each task cleared it.

## Files

- `run/transcript.md`: every step and check, timestamped. `run/checks.json`: the 33 checks.
- `run/sessions.json`: the sessions the started tasks got (id, status). `run/results.json`: the MCP answers and the
  tasks as the API returned them. `run/approvals.json`: the cards as the owner's API returns them.
- `run/runner-wire.jsonl`, `run/fake-claude.jsonl`, `run/queries.txt`, `run/shots/*.png`.

## Not covered here

- The deferral note when the immediate start is refused: covered by the Go test
  `TestTaskCreateStartNowRefusedStartStillReturnsTheCreatedTask` (`src/runner-go/task_start_now_test.go`), not by this run.
- A card wait handed to a runner-hosted job: this runtime (Claude Code) sets no MCP call deadline, so the wait stayed
  in the call. The job replays the same handler; `TestTaskCreateStartNowReplayedByAJobTakesTheSamePath` drives it.
- A runner that predates the change: covered by the pg spec (`approval-start-after-create.pg.spec.ts`, a card filed
  without the declaration refuses `startAfterCreate`) and the client tests, not by this run.
- The native clients: their own evidence is in `../ios/` and `../android/`.

## Reproduce

Requirements: root (for `unshare` and `mount`), docker, git, node, go, openssl, and a checkout with an `npm ci` of this
lockfile for `NM_SRC` (e.g. this worktree after `scripts/worktree-overlay.sh`).

```bash
K=docs/evidence/create-and-start/e2e/kit
export NM_SRC=$PWD CAS_DIR=/var/tmp/cas-e2e
bash $K/stack.sh build d63a15a5b9d19fb3e56e931ad787111a9e85f403
bash $K/stack.sh db && bash $K/stack.sh start-api && bash $K/stack.sh start-proxy && bash $K/stack.sh start-web
node $K/bootstrap.mjs
node $K/scenario.mjs          # writes ../run/
bash $K/stack.sh clean        # stops everything and removes the database container
```
