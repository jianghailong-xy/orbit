# 🛰 Orbit

An **AI-agent platform** for running **Claude Code** against your own infrastructure. Orbit
gives you **interactive, multi-turn agent sessions** *and* a **task queue** — but the agents
don't run on the server. Instead, users register their own machines as **runners** (à la
GitHub Actions self-hosted runners), and Claude Code runs *there*, where the ops tooling and
credentials already live (`tea-cli`, HDFS clients, kubectl, …).

```
React UI ──REST/SSE──▶ Control plane (NestJS + Postgres) ◀──outbound poll── Runner @ your machine
  chat · approvals        sessions · tasks · queue · runs                    long-lived `claude`
                          approvals · cost/token rollups                     in a git worktree
```

A **session** is a single long-lived `claude` process on a runner, kept alive across turns:
you chat with it live (SSE), approve tool calls in-flight, and it runs in an **isolated git
worktree** so concurrent sessions never clobber each other's files. A **task** is a queued
unit of work (optionally with dependencies and a task-list) that spawns such a session on a
runner.

- **Control plane** (`src/apiserver`) — NestJS + Prisma + PostgreSQL. Owns users, agents,
  sessions + conversation turns, tasks (the queue) with task-lists and dependency DAGs,
  runs, runners, tool-approvals, attachments, and cost/usage aggregation. Never holds an
  Anthropic key.
- **Runner** (`src/runner-go`) — a small static Go CLI (~6 MB, no runtime needed).
  `orbit register` enrolls a machine via browser approval; `orbit run` long-polls for
  assigned work and drives Claude Code as a **long-lived process per session**
  (`claude -p --input-format stream-json`), fed user turns over an inbox long-poll. Streams
  normalized events + token/cost back to the control plane, runs each session in its own
  **git worktree**, drains gracefully on restart, and self-updates from the control plane
  at startup.
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
  remember-rules) rather than blocking unattended.
- **Cost/usage from the source** — runners report Claude Code's own `total_cost_usd` /
  `usage` per turn; the control plane aggregates these (see caveat below).

## Prerequisites

- Node.js ≥ 20 (uses global `fetch`)
- Docker (for local Postgres) — or any reachable PostgreSQL 16
- On each runner machine: **Claude Code**, authenticated. Either log in interactively
  (run `claude`, then `/login` — uses your Claude subscription), **or** set
  `ANTHROPIC_API_KEY` (usage-based billing) / `CLAUDE_CODE_OAUTH_TOKEN` (subscription,
  non-interactive). The runner drives `claude -p` either way; auth never leaves the runner
  machine. `orbit run` preflights this at startup.

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
any further users with the `add-user` skill. Then log in, open the UI, create an agent, and
follow the in-app guide to register a runner machine.

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

On a machine with Claude Code installed & authenticated (logged in via `/login`, or
`ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` set):

```bash
# 1. install the static `orbit` binary (no Node needed)
curl -fsSL https://orbit.wikova.com/install.sh | bash

# 2. register this machine (opens your browser to approve)
#    this auto-installs + starts a background service (systemd / launchd)
orbit register --labels sg,hdfs --max-concurrent 2

#    ...or run it in the foreground instead of installing a service:
orbit register --foreground --labels sg,hdfs
```

The binaries are built with `npm run build:runner` (Go) and served at `/dl`; the runner
self-updates from there at startup. Create a task in the UI, queue it, and watch the live
stream — or start an interactive session and chat with the agent directly.

## Cost & tokens

Runners report Claude Code's `total_cost_usd` / `usage` per run; Orbit aggregates these for
the dashboard. **These are client-side estimates** — reconcile against the
[Anthropic Usage & Cost API](https://platform.claude.com/docs/en/build-with-claude/usage-cost-api)
for authoritative billing.

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
