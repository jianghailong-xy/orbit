# A12 isolated Orbit stack

A private Orbit server for the A12 (Android Wiki & Watch) real-account device journeys, adapted from A11's
`src/android/scripts/a11-stack` (commit `49c028579`). Everything runs on this host, on loopback, at the fixed server
SHA `3eb8e8594aea152b96fa82dd0b444ca3cc4f301d` (the project tip A12 merged on 2026-10-08; `src/apiserver` tree
`fbe271e6…`, `src/shared` tree `bb96d8a6…`, `src/runner-go` tree `5fa551c0…` — the same trees as A12's HEAD). The first
live runs, on 2026-10-07, used `0f98546a5` (A12's first merge base; trees `c0aa1a79…`, `de5d9067…`, `4c77b08e…`):

- **Postgres**: `postgres:16-alpine` in container `a12-stack-pg`, published on `127.0.0.1:5712`. Its data sits on
  tmpfs, so a stopped container takes the data with it.
- **apiserver**: `src/apiserver` and `src/shared` taken from that SHA with `git archive`, checked against their tree
  ids, built with `tsc`, and served on `127.0.0.1:3712/api`. `loopback-only.cjs` is preloaded with `node --require`:
  it pins the listener to 127.0.0.1 and sets the keep-alive described below.
- **runner**: the SHA's `src/runner-go`, built to `<stack>/bin/orbit` and registered only with this apiserver. It runs
  under `unshare -m` with an empty tmpfs over `/root`, with a scrubbed environment (`env -i`), its own `ORBIT_HOME`,
  `HOME` and `TMPDIR`, and no self-update or engine update. The only engine on its `PATH` is `fake-claude`
  (`runner-path/claude`), which speaks Claude Code's stream-json protocol without a model, an account or the network.
- **seed**: `seed.mjs` creates everything through the real HTTP API, with no direct database writes, and reads the
  server back after every write (each read-back is in `seed.json` → `checks`; the first that does not hold stops it).
  The test accounts (`owner@a12.test`, the bootstrap ADMIN, and `other@a12.test`, a MEMBER) get random hex passwords
  at seed time, kept only in `<stack>/accounts.json` (mode 0600).

## What the seed makes

| object | how |
| --- | --- |
| the owner and the other account | `POST /api/auth/bootstrap`, `POST /api/admin/users {password}` |
| the stack runner, online | `POST /api/runners/enrollment-tokens` + `orbit register --token` |
| workspace `a12-sandbox` on that runner, and one session in it that the runner claims and answers | `POST /api/workspaces`, `POST /api/sessions` |
| space `a12-live`, switched to Manual and bound to the workspace | `POST /api/wiki/spaces`, `PATCH` `reviewMode`, `POST …/workspaces` |
| five entries the owner wrote (a principle, a concept found by the search `readback`, a decision, two pitfalls) | `POST /api/wiki/spaces/:id/changesets` (owner door, applies at once) |
| two pending proposals: a fresh add, and an amend of one pitfall at revision 1 | `POST /api/runner/wiki/changesets` with the runner's token and `X-Orbit-Session-Id` of the session it hosts (the agent door) |
| the amend made stale: the owner amends that pitfall to revision 2 | owner door; accepting the amend is then recorded `conflict` |
| a run: an agent's add that Tiered applied at once (space Tiered for that one call, then Manual again) | agent door; Recently changed folds it into a row with Revert run… |
| a task, and a NOTIFY_USER watch on it (TaskFollowSheet's body: `predicateVersion` 1, `ALL`/`TASK_TERMINAL`, TASK target, 86400 s, idempotency key) | `POST /api/tasks`, `POST /api/watches` |
| the other account's own space `other-notes` with one entry | the other account's owner door |

It also records, as read-backs, that the other account gets 404 for the owner's space, entry, changeset, watch and
task, and that each account lists only its own space. Every id goes to `<stack>/seed.json`.

## Files

| file | role |
| --- | --- |
| `setup.sh` | builds and runs the stack (commands below) |
| `lib.mjs` | the HTTP client the helpers share (loopback only), login from `accounts.json`, id comparison |
| `seed.mjs` | the seed (called by `setup.sh seed` and `setup.sh reset`) |
| `readback.mjs` | the seeded objects as the owner and the other account read them now, as JSON (read-only) |
| `live-args.mjs` | the instrumentation arguments of `WikiWatchLiveTest`, from `seed.json` and `accounts.json` |
| `live.sh` | the locked device run (below) |
| `cycle.sh` | one resumable cycle into one evidence directory: a fresh seed, then `live.sh` |
| `api.mjs` | `node <stack>/api.mjs METHOD PATH [json] [--as owner\|other]` for ad-hoc reads and writes |
| `loopback-only.cjs` | the apiserver preload (loopback bind and keep-alive) |
| `fake-claude` | the runner's fake engine |

Run `setup.sh` from the checkout. On each command it copies itself, the helpers and the fake engine into the stack
directory: the runner cannot see `/root`, where checkouts live, and `seed.mjs` calls `<stack>/setup.sh`.

## Commands

`bash src/android/scripts/a12-stack/setup.sh <command>`

| command | what it does |
| --- | --- |
| `build` | archives the SHA's server trees into `<stack>/src` and checks the tree ids and the lockfile; hard-links `node_modules` from a worktree installed from the same lockfile, keeping a private `@prisma/client`; generates Prisma, builds shared and the apiserver, then builds the runner |
| `db` | (re)creates the Postgres container on tmpfs and applies the migrations |
| `start` | starts the apiserver, and the runner once the seed has registered it |
| `stop` | stops the runner and the apiserver; Postgres and its data stay |
| `seed` | runs `seed.mjs`, which needs a freshly migrated database |
| `reset` | stops everything, wipes the runner state, then runs `db`, `start` and `seed`: a freshly seeded stack in about a minute |
| `status` | the source SHA, container, pids, `/api/health` and the listening ports |
| `readback [label]` | `node readback.mjs`: the server's view of the seeded objects as JSON |
| `clean` | stops everything and removes the container and everything the script made under the stack directory |

`register <token>` is internal: `seed.mjs` uses it. Overrides, the same for every command and helper: `A12_STACK_DIR`
(`/var/tmp/a12-stack`; not under `/root`, and on the same filesystem as the worktree that provides `node_modules`),
`A12_STACK_API_PORT` (`3712`), `A12_STACK_PG_PORT` (`5712`), `A12_STACK_PG_CONTAINER` (`a12-stack-pg`), `NM_SRC` (a
worktree with `node_modules` installed by `npm ci` from the SHA's `package-lock.json`; the first passing one in
`git worktree list` is used when unset). Requirements: root (for `unshare` and `mount`), docker, git, node, go, openssl.

## Device journeys

```bash
A=src/android/scripts/a12-stack
bash $A/setup.sh build
# APKs: :app:assembleDebug :app:assembleDebugAndroidTest
bash $A/cycle.sh src/android/app/build/outputs/apk/debug/app-debug.apk \
  src/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk <new evidence dir> [emulator-5554]
bash $A/setup.sh clean        # when done
```

`cycle.sh` seeds the stack afresh (`setup.sh reset`) once per evidence directory and records that seed there, then
runs `live.sh`. The journeys that decide or stop something are one-shot, so every cycle needs its own seed. Run the
same command again after an interruption (a session recycle kills background jobs): it starts the apiserver and the
runner again if they are gone, checks that the stack still holds that directory's seed, and `live.sh` skips the
journeys that already have a result. A journey cut off midway runs again, and one that decides or stops something
then fails its precondition (a new evidence directory, and so a new seed, runs it again). `live.sh` alone runs
against whatever the stack holds.

`live.sh` waits for host memory pressure to fall (PSI `full avg10` < 10), starts the adb server, then holds
`/var/lib/orbit/android/ui.lock` for the whole device run with no adb call inheriting the lock's fd. It refuses any
serial that is not an emulator (`ro.kernel.qemu`), adds `adb reverse tcp:3712`, installs both APKs inside the hold and
records the installed APK's sha256, clears the app, sets font 1.0 and day mode, and runs each `WikiWatchLiveTest`
journey as its own `am instrument` (in order). After each journey `readback.mjs` writes the server's view to
`server/NN-<journey>.json`, and the journey's captures (`a12-live/`: identity, screenshots, semantics trees,
`<journey>-server.json` with what the test read from the server, `<journey>-checks.txt`, and the stack trace of a
failure) and the logcat of its test process are pulled at once. At the end it removes the reverse and restores the
device settings. It fails if a journey failed, the process crashed, or either test password appears anywhere in the
evidence.

| journey | account | link | acts, then reads back |
| --- | --- | --- | --- |
| `j1OwnerOpensTheSpaceSearchesAndOpensAnEntry` | owner | `orbit://wiki/<space>` | the home shows the space by its name; search `readback` finds the entry; its page opens |
| `j2OwnerAcceptsTheFreshProposal` | owner | `orbit://wiki/<space>` | Activity → Review → the fresh card → Accept: the op `accepted`, the entry active and confirmed, the toast Accepted |
| `j3OwnerAcceptsTheStaleProposalAndIsRefused` | owner | `orbit://wiki/<space>` | Activity → Review → the stale card → Accept: the op `conflict`, the entry's revision and summary unchanged; the app must show *Nothing was applied: the entry changed after this was proposed.* and not Accepted |
| `j4OwnerEditsAnEntry` | owner | `orbit-wiki:<entry>` | Edit title and summary → Save: revision + 1 with both |
| `j5OwnerChangesTheReviewMode` | owner | `orbit://wiki/<space>` | gear → Tiered, then Manual: each read back, the other settings untouched |
| `j6OwnerPausesResumesAndStopsTheWatch` | owner | `orbit://watch/<watch>` | Pause → PAUSED, Resume → ACTIVE, Stop (nothing sent before the confirmation) → CANCELLED |
| `j7aOtherAccountOpensTheOwnersEntry` | other | `orbit-wiki:<owner's entry>` | *That entry is no longer in this space.*, none of the owner's titles; the server 404 |
| `j7bOtherAccountOpensTheOwnersSpace` | other | `orbit://wiki/<owner's space>` | *That space is not available.* (tag `wiki-space-unavailable`), none of the owner's titles; the server 404 |
| `j7cOtherAccountOpensTheOwnersWatch` | other | `orbit://watch/<owner's watch>` | Watch not found, none of the owner's titles; the server 404 |
| `j8OwnerRevertsARun` | owner | `orbit://wiki/<space>` | Activity's Recently changed → the run → Revert run… (nothing sent before the confirmation): nothing left to revert, the run's entry no longer active |
| `j9aOwnerHomeIsTheSpacesContentAsTheServerHoldsIt` | owner | `orbit://wiki/<space>` | (A12c, read-only; `live.sh` runs it and `j9b` right after `j1`, while both proposals wait) the home's line and documents band are what the server's `docs` and `articles` reads make them, its principles the server's `?kind=principle` read; this stack's space (no plan, no topic article, maintenance off) shows the new space's card, whose Set up maintenance opens Wiki settings |
| `j9bOwnerActivityIsWhatTheServerSays` | owner | `orbit://wiki/<space>` | (A12c, read-only) the bar's Activity and the drawer say the spaces' pendingOps + planWaiting "N waiting on you"; Activity's first banner is the server's proposals, its status line the health read's count, Recent decisions the `?kind=decision&limit=4` read, Recently changed the timeline's newest rows with a run's items folded into one |

`j3` and `j7b` check what the review-1 fix (`9095a638f`) added: `WikiCopy.conflictRefused` and the
`wiki-space-unavailable` page. Before it (`1052be908`) both fail: the app says Accepted while the server records
`conflict`, and the owner's space link opens the other account's own space.

## What the stack cannot make

- **A maintenance run** (origin `maintenance`): made only by a task of the space's hidden «Wiki maintenance» list, run
  by a session whose engine reads the dossier and proposes through `orbit wiki`, with maintenance on and a workspace
  and provider set. The stack runner's engine calls no model, so such a run would write nothing. The run `j8` reverts
  is the review mode's (Tiered) over an agent's proposal, which Recently changed folds and Revert run… takes back
  the same way.
- **A plan draft**: a plan job run as a task of the same list, whose acceptance (`orbit wiki plan check`) passes only
  when the run reported a draft the gate let through — again a model's work. The space's first draft job is `held`
  (`no_maintenance_workspace`; recorded in `seed.json` → `gaps`). Neither is written into the database by hand.

## Keep-alive (75 s)

Production clients reach the apiserver through the nginx gateway, which leaves `keepalive_timeout` at nginx's 75 s.
Node's own 5 s would close pooled connections that the app (OkHttp, `retryOnConnectionFailure=false`) still reuses,
a stack artefact rather than a product path, so `loopback-only.cjs` sets `keepAliveTimeout` to 75 s and
`headersTimeout` to 76 s on the apiserver's HTTP server before it listens.

## Never production

- Everything listens on 127.0.0.1 only. The stack has its own database in its own container and its own runner,
  registered with `http://127.0.0.1:3712` and nothing else; the device reaches it through `adb reverse` alone.
- No production URL, account or credential appears anywhere. Every process starts under `env -i`, and the runner
  cannot see `/root`.
- The JWT secret, the provider key and the database password are random per stack, kept in `<stack>/secrets.env`
  (mode 0600). The test accounts exist only in this stack's database, and their passwords reach the device only as
  instrumentation arguments.
- The scripts touch nothing outside the stack directory and their own container. The exceptions: `build` reads git
  objects, hard-links an existing worktree's `node_modules` (read-only) and uses the Go build cache.
