# 🛰 Orbit

An **AI-agent platform** for running **Claude Code, Codex, and OpenCode** against your own infrastructure. Orbit
gives you **interactive, multi-turn agent sessions** *and* a **task queue** — but the agents
don't run on the server. Instead, users register their own machines as **runners** (à la
GitHub Actions self-hosted runners), and the selected coding runtime runs *there*, where the ops tooling and
credentials already live (`tea-cli`, HDFS clients, kubectl, …).

```
React UI ──REST/SSE──▶ Control plane (NestJS + Postgres) ◀──outbound poll── Runner @ your machine
  chat · approvals        sessions · tasks · queue · runs                    local coding runtime
                          approvals · cost/token rollups                     in a git worktree
```

A **session** is a supervised runtime conversation on a runner, kept resumable across turns:
you chat with it live (SSE), approve supported tool calls in-flight, and it runs in an **isolated git
worktree** so concurrent sessions never clobber each other's files. A **task** is a queued
unit of work (optionally with dependencies and a task-list) that spawns such a session on a
runner.

- **Control plane** (`src/apiserver`) — NestJS + Prisma + PostgreSQL. Owns users, agents,
  sessions + conversation turns, tasks (the queue) with task-lists and dependency DAGs,
  runs, runners, tool-approvals, attachments, and cost/usage aggregation. Never holds an
  Anthropic key.
- **Runner** (`src/runner-go`) — a small static Go CLI (~6 MB, no runtime needed).
  `orbit register` enrolls a machine via browser approval; `orbit run` long-polls for
  assigned work and drives the agent's selected local runtime (Claude Code, Codex, or OpenCode),
  feeding user turns over an inbox long-poll while preserving the runtime conversation. Streams
  normalized events + token/cost back to the control plane, runs each session in its own
  **git worktree**, drains gracefully on restart, and checks for control-plane updates at
  startup and periodically while running; a live update stops new claims and drains sessions
  before replacing the process.
- **Web** (`src/web`) — Vite + React + Ant Design. Grouped task lists, agent CRUD, a live
  **chat console** (SSE) with in-flight **tool-approval** cards, image/file attachments,
  runner enrollment, a Skills browser, a cost dashboard, dark mode, and a mobile-responsive
  layout.
- **Shared** (`src/shared`) — enums, normalized run-event types, and runner-API DTOs.
- **Gateway** (`gateway/`) — an nginx reverse proxy serving the web UI and `/api` from one
  origin; the full stack runs under Docker Compose.

The connection is **outbound-only** (runner → server): NAT-friendly, and the server never
needs to reach into a user's machine.

## Architecture decisions

Highlights:

- **Why runners, not server-side execution** — the example tasks are *ops* against the
  user's own infrastructure; the agent's tools must run with the user's credentials, on the
  user's network. Runners put Claude Code exactly there.
- **Interactive sessions (Route B)** — a conversation is one long-lived `claude` process fed
  by `--input-format stream-json` on stdin. User turns are durably queued
  (`ConversationTurn`) and delivered over a per-run **inbox long-poll**; the assistant/tool
  transcript streams back over the existing event → SSE path. No WebSocket (the gateway
  strips `Upgrade`). A killed runner reattaches via the server-generated session UUID and
  `claude --resume`. See [`docs/interactive-claude-runner-design.md`](docs/interactive-claude-runner-design.md).
- **Worktree isolation** — each session runs in its own `git worktree`, so concurrent agents
  on one repo don't trample each other's edits; the tree is reclaimed when the session ends.
- **Queue** — the `Task` table *is* the queue. Runners claim work atomically with
  `SELECT … FOR UPDATE SKIP LOCKED`; a long-poll waits on an enqueue signal. A heartbeat
  **reaper** force-fails the sessions of a runner that goes silent.
- **Permissions** — all six Claude Code permission modes are exposed
  (`default` / `acceptEdits` / `plan` / `auto` / `dontAsk` / `bypassPermissions`), paired
  with a scoped `allowedTools` allowlist (e.g. `Bash(tea-cli *)`). Tool calls that need a
  human decision surface as **live approval cards** in the UI (allow / deny, with optional
  remember-rules) rather than blocking unattended. OpenCode maps the same modes to guarded
  non-interactive rules; its provider login remains a manual `opencode auth login` step.
- **Cost/usage from the source** — runners report Claude Code's own `total_cost_usd` /
  `usage` per turn; the control plane aggregates these (see caveat below).

## Prerequisites

- Node.js ≥ 20 (uses global `fetch`)
- Docker (for local Postgres) — or any reachable PostgreSQL 16
- On each runner machine: the runtime selected by its agents — **Claude Code**, **Codex**, or
  **OpenCode** — installed and authenticated. Use Claude's `/login` (or
  `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`), `codex login`, or
  `opencode auth login`, respectively. Credentials stay on the runner machine; `orbit doctor`
  reports missing engines/auth and the registration flow can install missing engines with consent.

## Quickstart (development)

```bash
# 1. install
npm install

# 2. database
cp .env.example .env                 # set JWT_SECRET; adjust the rest if needed
npm run db:up                        # docker compose: postgres on :5432
npm run prisma:generate
npm run prisma:migrate -w @orbit/apiserver   # or `prisma migrate deploy` in prod

# 3. control plane  (http://localhost:3000)
npm run dev:apiserver

# 4. web UI         (http://localhost:5173, proxies /api → :3000)
npm run dev:web
```

There's no self-service signup. On a fresh deployment, the web UI sends the first visitor to
a one-time `/setup` screen that creates the first account (which becomes ADMIN); provision
any further users from the admin **Users** page. Then log in, open the UI, create an agent,
and follow the in-app guide to register a runner machine.

### Deploy the full stack (Docker Compose)

For a real deployment, build and run everything (Postgres + apiserver + web + an nginx
gateway) behind one origin:

```bash
export JWT_SECRET="$(openssl rand -base64 32)"    # required
docker compose up -d --build                       # gateway listens on :2086
```

The apiserver applies pending Prisma migrations on boot, and the web UI + `/api` are served
from the same origin (`http://localhost:2086`). To upgrade a running deployment later,
rebuild and recreate only the services that changed — the `upgrade` skill automates this.

### Run a runner (on the machine that should execute tasks)

On a machine with the runtime(s) your agents will use installed and authenticated (see
Prerequisites). Replace `orbit.example.com` with your deployment's origin (baked in at build time
via `PUBLIC_ORIGIN`; the UI's **Add a runner** page prints these commands pre-filled for you):

```bash
# install the static `orbit` binary (no Node needed) and register this machine —
# the script hands off to `orbit register`, which opens your browser to approve and
# auto-installs + starts a background service (systemd / launchd)
curl -fsSL https://orbit.example.com/install.sh | bash

# register options go after `-s --`:
curl -fsSL https://orbit.example.com/install.sh | bash -s -- --labels sg,hdfs --max-concurrent 2

# ...or run it in the foreground instead of installing a service:
curl -fsSL https://orbit.example.com/install.sh | bash -s -- --foreground --labels sg,hdfs

# ...or install the binary only (also the default with no terminal, e.g. in CI):
curl -fsSL https://orbit.example.com/install.sh | ORBIT_NO_REGISTER=1 bash
```

The binaries are built with `npm run build:runner` (Go) and served at `/dl`; the runner
self-updates from there at startup and periodically thereafter. Create a task in the UI,
queue it, and watch the live stream — or start an interactive session and chat with the
agent directly.

The registered binary also exposes the agent-safe Task/TaskList surface for shell
automation and, for orchestration-enabled agents, the MCP-equivalent Session surface.
Results are pretty-printed by default; pass `--json` for compact JSON:

```bash
orbit capabilities --json
orbit task list --status OPEN --json
orbit task create --title "Check deployment" --description "Verify health and logs" --json
orbit task update <task-id> --status DONE --json
orbit task delete <task-id> --json
orbit task-list create --title "Release" --json
orbit session create --prompt "Review the change" --agent-name reviewer --json
orbit session get <session-id> --json
orbit session send <session-id> --message "Please add a regression test" --json
orbit session complete <session-id> --json
```

Each Claude/Codex/OpenCode session receives a short discovery instruction pointing at the
resolved absolute binary path and `capabilities --json`. Claude receives approval-free
rules for Task/TaskList and, only when enabled for that agent, Session action prefixes;
Codex and OpenCode receive the same context without replacing provider/project defaults.
Native Orbit MCP tools remain the preferred path when available.

Inside an Orbit task session, task commands may omit the task id and use
`ORBIT_TASK_ID`. Session commands always require an explicit target id. Spawning a session,
the lifecycle verbs (`interrupt`, `merge`, `end`, `complete`) and the owner-wide `search`
additionally require a live caller
session whose current agent has `enableOrchestration`; the runner receives a signed,
session-bound credential and every request is re-authorized by the control plane.
Credential support is negotiated explicitly, so an older runner safely disables orchestration
instead of exposing tools whose calls can only fail. The proof lives in a private per-session
file, is read afresh for every operation, and is reissued and retried once when the control plane
reports it missing or invalid. Proofs expire after 15 minutes and use an independent signing
domain: by default the key is derived from `JWT_SECRET`, or deployments may set
`RUNNER_ORCHESTRATION_JWT_SECRET` for independent rotation. The proof is never included in
`orbit capabilities` output. Every call also rechecks the live session assignment and Agent
setting, so ending, cancelling, deleting, reassigning, or disabling orchestration revokes access
immediately rather than waiting for the 15-minute expiry. Missing, expired, or key-rotation-invalid
proofs trigger one refresh and one retry; authorization-state denials do not. The runner machine's
OS account remains the local trust boundary; sibling processes running as that account are not
isolated from each other. Agent management remains MCP-only. Existing runners migrate their
credential storage to private permissions on the next runner restart; the CLI refuses to use a
legacy world-readable config until that migration has happened.
Task CLI mutations are attributed to the runner owner, so agents should prefer native
Orbit MCP tools when agent/session attribution matters.

A process with **no** `ORBIT_SESSION_ID` at all — a launchd/cron bridge that belongs to no
session and outlives every session, so it can hold no session-bound proof — is treated as
headless and gets `session get`, `session list` and `session send` on the runner credential
alone, scoped by the control plane to the sessions that runner hosts. That is what the runner
already has for those sessions, and nothing more: sessions on other machines stay invisible, and
spawning, the lifecycle verbs and the owner-wide search stay session-gated. `orbit session get`
reports `status`, `numTurns` and `lastTurnAt`, which is how a poller decides whether a
long-lived session finished the turn it was given. `orbit capabilities --json` shrinks to match
whatever the calling context actually allows, so it can be read as the source of truth:

```bash
# in a launchd job, with no ORBIT_* session variables in the environment
orbit capabilities --json                                    # lists the headless subset
orbit session list --status AWAITING_INPUT --json            # only this runner's sessions
orbit session get <session-id> --json                        # status · numTurns · lastTurnAt
echo "$event" | orbit session send <session-id> --message-file - --json
```

## Cost & tokens

Runners report runtime cost/token usage when the engine exposes it; Orbit aggregates these for
the dashboard. **These are client-side reports** — reconcile them against the underlying model
provider's billing records for authoritative charges.

## Project layout

```
src/
  shared/     enums · normalized run events · runner-API DTOs
  apiserver/  NestJS control plane + Prisma schema/migrations
  runner-go/  `orbit` CLI (Go): register · run loop · interactive session · worktree
  web/        Vite + React + Ant Design UI
gateway/      nginx reverse proxy (web + /api on one origin)
docs/         design notes (interactive sessions, Phase-0 CLI probes)
```

## Useful scripts (root)

| Script | What |
|---|---|
| `npm run build` | Build all JS packages (shared → apiserver → web) |
| `npm run build:runner` | Build the static `orbit` Go binaries (→ `dist-bin/`, served at `/dl`) |
| `npm run db:up` / `db:down` | Start/stop local Postgres |
| `npm run prisma:migrate` | Create/apply a dev migration |
| `npm run dev:apiserver` | Run the control plane (watch) |
| `npm run dev:web` | Run the web UI (watch) |

## Status

Shipped: distributed runners, **interactive multi-turn sessions** with live tool-approvals,
task CRUD + queue + execution, **task-lists and dependency DAGs**, per-session **git-worktree
isolation**, graceful runner drain + a heartbeat reaper, image/file attachments, a Skills
browser, cost/token rollups, and a dark / mobile-responsive UI.

Not yet: cron / recurring schedules and external task sources (e.g. Feishu/Lark) — designed
for, but not built.

## License

MIT
