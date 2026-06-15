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

- **Control plane** (`packages/server`) — NestJS + Prisma + PostgreSQL. Owns users, agents,
  tasks (the queue), runs, runners, and cost/usage aggregation. Never holds an Anthropic key.
- **Runner** (`packages/runner`) — a small Node CLI. `orbit register` enrolls a machine;
  `orbit run` long-polls for assigned tasks and drives Claude Code via the
  [`@anthropic-ai/claude-agent-sdk`](https://code.claude.com/docs/en/agent-sdk/overview)
  `query()` (falling back to `claude -p --output-format stream-json`). Streams normalized
  events + token/cost back to the control plane.
- **Web** (`packages/web`) — Vite + React + Ant Design. List / Kanban-ish grouped tasks,
  agent CRUD, runner enrollment, live run stream (SSE), and a cost dashboard.
- **Shared** (`packages/shared`) — enums, normalized run-event types, and runner-API DTOs.

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
npm run prisma:migrate -w @orbit/server   # or `prisma migrate deploy` in prod

# 3. control plane  (http://localhost:3000)
npm run dev:server

# 4. web UI         (http://localhost:5173, proxies /api → :3000)
npm run dev:web
```

Open the UI, create an account, define an **Agent** (model + allowed tools), then go to
**Runners → Register a machine** to get a one-time enrollment token.

### Run a runner (on the machine that should execute tasks)

```bash
# from a checkout of this repo, on a machine with Claude Code installed & authenticated
# (logged in via `/login`, or ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN set):
npm run build -w @orbit/shared && npm run build -w @orbit/runner

node packages/runner/dist/index.js register \
  --server http://<control-plane-host>:3000 \
  --token  <enrollment-token-from-the-UI> \
  --name   my-runner --labels sg,hdfs --max-concurrent 2

node packages/runner/dist/index.js run
```

Create a task in the UI, queue it, and watch the live stream in the task detail page.

## Cost & tokens

Runners report Claude Code's `total_cost_usd` / `usage` per run; Orbit aggregates these for
the dashboard. **These are client-side estimates** — reconcile against the
[Anthropic Usage & Cost API](https://platform.claude.com/docs/en/build-with-claude/usage-cost-api)
for authoritative billing.

## Project layout

```
packages/
  shared/   enums · normalized run events · runner-API DTOs
  server/   NestJS control plane + Prisma schema/migrations
  runner/   `orbit` CLI: register + run loop + Claude Code adapter
  web/      Vite + React + Ant Design UI
```

## Useful scripts (root)

| Script | What |
|---|---|
| `npm run build` | Build all packages |
| `npm run db:up` / `db:down` | Start/stop local Postgres |
| `npm run prisma:migrate` | Create/apply a dev migration |
| `npm run dev:server` | Run the control plane (watch) |
| `npm run dev:web` | Run the web UI (watch) |

## Status

v1 MVP: task CRUD + immediate execution + simple queue + distributed runners + live run
streaming + cost rollups. Not yet: cron/recurring schedules, task-dependency DAGs, and
external task sources (e.g. Feishu/Lark) — these are designed-for but out of scope for v1.

## License

MIT
