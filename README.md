# 🛰 Orbit

An **AI-agent task scheduling platform**. Orbit schedules tasks that are executed by
autonomous **Claude Code** agents — but the agents don't run on the server. Instead, users
register their own machines as **runners** (à la GitHub Actions self-hosted runners), and
Claude Code runs *there*, where the ops tooling and credentials already live (`tea-cli`,
HDFS clients, kubectl, …).

```
React UI ──REST/SSE──▶ Control plane (NestJS + Postgres) ◀──outbound poll── Runner @ your machine
                          tasks · agents · queue · runs                      drives Claude Code
                          cost/token rollups                                 (Agent SDK or `claude -p`)
```

- **Control plane** (`src/apiserver`) — NestJS + Prisma + PostgreSQL. Owns users, agents,
  tasks (the queue), runs, runners, and cost/usage aggregation. Never holds an Anthropic key.
- **Runner** (`src/runner-go`) — a small static Go CLI (~6 MB, no runtime needed).
  `orbit register` enrolls a machine via browser approval; `orbit run` long-polls for
  assigned tasks and drives Claude Code via `claude -p --output-format stream-json`.
  Streams normalized events + token/cost back to the control plane, and self-updates
  from the control plane at startup.
- **Web** (`src/web`) — Vite + React + Ant Design. List / Kanban-ish grouped tasks,
  agent CRUD, runner enrollment, live run stream (SSE), and a cost dashboard.
- **Shared** (`src/shared`) — enums, normalized run-event types, and runner-API DTOs.

The connection is **outbound-only** (runner → server): NAT-friendly, and the server never
needs to reach into a user's machine.

## Architecture decisions

Highlights:

- **Why runners, not server-side execution** — the example tasks are *ops* against the
  user's own infrastructure; the agent's tools must run with the user's credentials, on the
  user's network. Runners put Claude Code exactly there.
- **Why the Agent SDK** — native streaming, native `total_cost_usd` / `usage`, built-in
  session resume. The `claude -p` subprocess path is kept as a drop-in fallback
  (`ORBIT_CLAUDE_MODE=cli`).
- **Queue** — the `Task` table *is* the queue. Runners claim work atomically with
  `SELECT … FOR UPDATE SKIP LOCKED`; a long-poll waits on an enqueue signal.
- **Permissions** — agents default to Claude Code's `dontAsk` permission mode with a
  minimal, scoped `allowedTools` allowlist (e.g. `Bash(tea-cli *)`). `bypassPermissions`
  is intentionally avoided.

## Prerequisites

- Node.js ≥ 20 (uses global `fetch`)
- Docker (for local Postgres) — or any reachable PostgreSQL 16
- On each runner machine: **Claude Code**, authenticated. Either log in interactively
  (run `claude`, then `/login` — uses your Claude subscription; the runner drives it via
  `claude -p`), **or** set `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` to use the Agent
  SDK path. Auth never leaves the runner machine. `orbit run` preflights this at startup.

## Quickstart

```bash
# 1. install
npm install

# 2. database
cp .env.example .env                 # adjust if needed
npm run db:up                        # docker compose: postgres on :5432
npm run prisma:generate
npm run prisma:migrate -w @orbit/apiserver   # or `prisma migrate deploy` in prod

# 3. control plane  (http://localhost:3000)
npm run dev:apiserver

# 4. web UI         (http://localhost:5173, proxies /api → :3000)
npm run dev:web
```

Open the UI, create an account, then under **Agents → Add** follow the guide to register a
machine.

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
stream in the task detail page.

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
  runner/     `orbit` CLI: register + run loop + Claude Code adapter
  web/        Vite + React + Ant Design UI
```

## Useful scripts (root)

| Script | What |
|---|---|
| `npm run build` | Build all packages |
| `npm run db:up` / `db:down` | Start/stop local Postgres |
| `npm run prisma:migrate` | Create/apply a dev migration |
| `npm run dev:apiserver` | Run the control plane (watch) |
| `npm run dev:web` | Run the web UI (watch) |

## Status

v1 MVP: task CRUD + immediate execution + simple queue + distributed runners + live run
streaming + cost rollups. Not yet: cron/recurring schedules, task-dependency DAGs, and
external task sources (e.g. Feishu/Lark) — these are designed-for but out of scope for v1.

## License

MIT
