# A11 isolated Orbit stack

A private Orbit server for the A11 (Android Tasks & Projects) real-account device journeys. Everything runs
on this host, on loopback, at the fixed server SHA `d621e29aaa0178ecf6656c56656b79936539915d`:

- **Postgres**: `postgres:16-alpine` in container `a11-stack-pg`, published on `127.0.0.1:5711`. Its data
  sits on tmpfs, so a stopped container takes the data with it.
- **apiserver**: `src/apiserver` and `src/shared` taken from that SHA with `git archive`, checked against
  their tree ids, built with `tsc`, and served on `127.0.0.1:3711/api`. `loopback-only.cjs` is preloaded with
  `node --require`: it pins the listener to 127.0.0.1 and sets the keep-alive described below.
- **runner**: the SHA's `src/runner-go`, built to `<stack>/bin/orbit` and registered only with this apiserver.
  It runs under `unshare -m` with an empty tmpfs mounted over `/root`, so it cannot see the host's engines,
  logins or `~/.orbit`. Its environment is scrubbed (`env -i`). It has its own `ORBIT_HOME`, `HOME` and
  `TMPDIR` under the stack directory, and self-update and engine updates are turned off. The only engine on its
  `PATH` is `fake-claude`, installed as `runner-path/claude`. That engine speaks Claude Code's stream-json
  protocol without a model, an account or the network. A task run whose prompt contains `A11-FAIL` fails on
  purpose. In any session, the first message carrying `A07C-QUOTA` is answered with Claude Code's weekly-limit
  sentence, and the first carrying `A07C-FAIL` fails its turn; the same message sent again is answered. Any other
  task run appends a line to `A11_STACK_NOTES.md` in its worktree.
- **seed**: `seed.mjs` and then `seed-blocker.mjs` create everything through the real HTTP API, with no
  direct database writes. They create two accounts, the runner, a workspace with a local bare origin, and
  tasks in every state. They also create three projects: a started manual project with a failed task, a
  coordinator question, a merge conflict and a promotion; a project that is not started; and an automatic
  project with a server-raised blocker. Every id is written to `<stack>/seed.json`. The test accounts
  (`owner@a11.test` and `member@a11.test`) get random passwords at seed time, kept only in
  `<stack>/accounts.json` (mode 0600).

## Files

| file | role |
| --- | --- |
| `setup.sh` | builds and runs the stack (commands below) |
| `lib.mjs` | the HTTP client the helpers share (loopback only), plus login from `accounts.json` |
| `seed.mjs`, `seed-blocker.mjs` | the seed (called by `setup.sh seed` and `setup.sh reset`) |
| `seed-start.mjs` | A11b: two projects nobody has started, for the start card — one whose coordinator files a start request through the runner's door (`projects.startAsked`), one nobody coordinates (`projects.startOwn`) |
| `seed-close.mjs` | A11c: two projects whose coordinator asks "Is this project done?" through the runner's door (`projects.closeAsked/closeDecline`), two move requests between projects waiting for the owner (`projects.crossFrom/crossTo`), and a started manual project with one task ready to run by hand (`projects.runQueue`) |
| `seed-stuck.mjs` | A11c, run by `stuck` only: a landing whose runner stopped reporting (`projects.landingStuck`) |
| `verify.mjs` | capability checks through the API: auth, SSE, tasks, projects, open items, member isolation, runner |
| `snapshot.mjs` | writes the live state into `seed.json` → `finalState` (read-only toward the stack) |
| `api.mjs` | `node <stack>/api.mjs METHOD PATH [json] [--as owner\|member]` for ad-hoc reads and writes |
| `loopback-only.cjs` | the apiserver preload (loopback bind and keep-alive) |
| `fake-claude` | the runner's fake engine |

Run `setup.sh` from the checkout. On each command it copies itself, the helpers and the fake engine into the
stack directory. The runner cannot see `/root`, where checkouts live, and `seed.mjs` calls `<stack>/setup.sh`.

## Commands

`bash src/android/scripts/a11-stack/setup.sh <command>`

| command | what it does |
| --- | --- |
| `build` | archives the SHA's server trees into `<stack>/src` and checks the tree ids and the lockfile. Hard-links `node_modules` from a worktree installed from the same lockfile, keeping a private `@prisma/client`. Generates Prisma, builds shared and the apiserver, then builds the runner (about 15 s with warm caches) |
| `db` | (re)creates the Postgres container on tmpfs and applies the migrations |
| `start` | starts the apiserver, and the runner too once the seed has registered it |
| `stop` | stops the runner and the apiserver. Postgres and its data stay |
| `seed` | runs `seed.mjs`, `seed-blocker.mjs`, `seed-start.mjs` and `seed-close.mjs`, which need a freshly migrated database |
| `status` | shows the source SHA, container, pids, `/api/health` and the listening ports |
| `reset` | stops everything, wipes the runner state and sandbox repo, then runs `db`, `start` and `seed`: a freshly seeded stack in about 4 min |
| `clean` | stops everything and removes the container and everything the script made under the stack directory (the directory itself goes once empty) |
| `verify` | `node verify.mjs`: one line per check and exit 1 on any failure (24 checks, a few seconds). It adds a "Resolve check (verify.mjs)" task to the main project, fails it and resolves its exception itself |
| `snapshot` | `node snapshot.mjs`: writes `seed.json` → `finalState` |
| `stuck` | `node seed-stuck.mjs` (about 15 min): a project on its own branch with a 90 s merge check; its task runs DONE, and while its landing is in the check the runner is sent SIGSTOP. It waits until the integration view calls that job timed out and retryable (the 10 min claim lease plus the check's timeout). **The runner stays stopped** |
| `unstick` | SIGCONT to the runner: it reports again, and a landing retried meanwhile runs |

`register <token>` is internal: `seed.mjs` uses it.

Overrides, the same for every command and helper (export them before running any of them):

| variable | default |
| --- | --- |
| `A11_STACK_DIR` | `/var/tmp/a11-stack` (not under `/root`, and on the same filesystem as the worktree that provides `node_modules`) |
| `A11_STACK_API_PORT` | `3711` |
| `A11_STACK_PG_PORT` | `5711` |
| `A11_STACK_PG_CONTAINER` | `a11-stack-pg` |
| `NM_SRC` | a worktree with `node_modules` installed (`npm ci`) from the SHA's `package-lock.json`. If unset, the first one in `git worktree list` that passes `scripts/worktree-dependencies.mjs` is used |
| `A11_STACK_REV`, `A11_STACK_API_TREE`, `A11_STACK_SHARED_TREE`, `A11_STACK_LOCK_SHA256` | another server version, all four together; `build` still checks the archived trees and lockfile against them. A11b ran main `f37505ec1626e972159494c86cb8da13499fb1b4` (`adc2cdcc5b3f0ee982d06b48b922c80544799a83`, `30b9e894c9a7d8aa78b0c820602740baade9c9e8`, lockfile `f0554c0375b5b06f71c47088d1b504a383639934b286f73f1b7f19272460c501`) on ports 3712/5712 |

Requirements: root (for `unshare` and `mount`), docker, git, node, go and openssl.

## Device journeys

```bash
A=src/android/scripts/a11-stack/setup.sh
bash $A build
bash $A reset          # fresh database plus seed
bash $A verify         # optional, but the journeys were built on a stack that had run it
bash $A snapshot       # finalState, which the args script needs
python3 src/android/scripts/tasks-projects-stack-args.py <args file> [stack dir]
A11_STACK_ARGS=<args file> bash src/android/scripts/tasks-projects-stack-device-test.sh 36 <app apk> <test apk> <new evidence dir> emulator-5554
```

- `tasks-projects-stack-args.py` reads the ids from `seed.json` (`api`, `sourceSha`, `accounts`, `workspace`,
  `taskLists`, `tasks`, `projects.main/notStarted/automatic`) and reads
  `finalState.projects.main.openItems` and `finalState.projects.automatic.blockersOpen`. It also reads the
  passwords from `accounts.json`. Ids change on every `reset`, so rerun `snapshot` and the args script after
  each one.
- Take the snapshot once the main project's promotion is ready. The journeys need a `TASK_FAILED` and a
  `PROMOTION_APPROVAL` item in `finalState.projects.main.openItems`, and an open blocker on the automatic
  project. If one is missing, wait a minute and run `snapshot` again.
- The args file holds the test passwords (mode 0600). Keep it outside the repository and delete it after the
  run.
- On a port other than 3711, also set `A11_STACK_SERVER=http://127.0.0.1:<port>` for the device-test script,
  which uses it for its health check and `adb reverse`.
- A11b's start card journeys, `s14` (the coordinator's request, answered on its card) and `s15` (the owner's own
  Start…, which opens the first coordinator), read `projects.startAsked/startOwn` from the args file and use them up:
  run them with `A11_TEST=io.orbitd.android.taskprojects.RealStackDeviceTest#s14_…,…#s15_…` on a fresh `reset`. They were
  written against main's server; `s07` still assumes the older server's start door (Automatic is now on by default, and
  a start that cannot open a coordinator is refused).
- A11c's journeys `s16`–`s19` (the done request answered in its conversation and with Not yet… on the project page, the
  crossings answered, the run queue's Run) read `projects.closeAsked/closeDecline/crossFrom/crossTo/runQueue` and use
  them up; `s20` (the landing's Retry) needs `stuck` first, then `snapshot` and the args script again. Run `unstick`
  after it.

## Keep-alive (65 s)

Production sits behind nginx, which uses `keepalive_timeout 65s`. Node's own default of 5 s would close
pooled connections that the app (OkHttp, `retryOnConnectionFailure=false`) still reuses. That would be a stack
artefact, not a product path. So `loopback-only.cjs` sets `keepAliveTimeout` to 65 s and `headersTimeout` to
66 s on the apiserver's HTTP server.

## Never production

- Everything listens on 127.0.0.1 only. The stack has its own database in its own container and its own
  runner, registered with `http://127.0.0.1:<port>` and nothing else.
- No production URL, account or credential appears anywhere. Every process starts under `env -i`, and the
  runner cannot see `/root`.
- The JWT secret, the provider key and the database password are random per stack, kept in
  `<stack>/secrets.env` (mode 0600). The test accounts exist only in this stack's database.
- The scripts touch nothing outside the stack directory and their own container. The exceptions: `build`
  reads git objects, hard-links an existing worktree's `node_modules` (read-only) and uses the Go build cache.
