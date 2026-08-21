<p align="center">
  <img src="brand/orbit-lockup.svg" alt="Orbit" width="208">
</p>

<p align="center"><strong>Agent Mission Control</strong></p>

<p align="center">
  Run coding agents on your own machines. Keep the plan, history, and controls in one self-hosted place.
</p>

<p align="center">
  <a href="https://github.com/jianghailong-xy/orbit/releases"><img alt="GitHub release" src="https://img.shields.io/github/v/release/jianghailong-xy/orbit?include_prereleases&sort=semver"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-3370ff"></a>
  <a href="https://github.com/jianghailong-xy/orbit/actions/workflows/client.yml"><img alt="Native client CI" src="https://github.com/jianghailong-xy/orbit/actions/workflows/client.yml/badge.svg"></a>
</p>

<p align="center">
  <a href="docs/product-intro.md">Product tour</a> ·
  <a href="docs/self-hosting.md">Self-hosting</a> ·
  <a href="docs/README.md">Documentation</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

Orbit is a self-hosted control plane for **Claude Code, Codex, Kimi, and OpenCode**. It combines live,
multi-turn agent sessions with a durable task queue and dependency graph. The agents execute on machines
you register as runners, close to the repositories, credentials, internal tools, and networks they need.

The control plane never needs inbound access to a runner. Runners poll outward for work and stream the
transcript, approvals, status, and usage back to Orbit. For repositories that need concurrent edits, you can
enable a separate git worktree for every session on an agent.

## Why Orbit

| Need | What Orbit provides |
| --- | --- |
| Work that outlives a chat | Durable projects, tasks, task lists, dependencies, comments, and resumable sessions |
| Parallel agents without checkout collisions | Optional per-session git worktree isolation |
| Access to private infrastructure | Self-hosted runners that use the tools and credentials already on your machines |
| Human control over risky actions | Live allow/deny approval cards and scoped permission modes |
| More than one agent runtime | Claude Code, Codex, Kimi, and OpenCode, plus bring-your-own model providers |
| Control away from a terminal | Responsive web UI, a native macOS app, and an iPhone/iPad client |

Orbit is especially useful for teams running coding agents against internal infrastructure, and for projects
where the plan must survive context limits, agent restarts, and machine reboots. Read [A day with
Orbit](docs/product-intro.md) for the longer product story.

## How it works

```text
Web / macOS / iOS ──REST + SSE──▶ Control plane + Postgres ◀──outbound poll── Runner
   chat · tasks · approvals         queue · history · usage                    local agent runtime
                                                                               optional worktree
```

- **Control plane** — NestJS, Prisma, and PostgreSQL own users, workspaces, sessions, projects, tasks,
  approvals, runners, attachments, and usage.
- **Runner** — a small static Go CLI registers a machine, claims work, drives the selected agent runtime,
  and manages optional worktree isolation and recovery.
- **Clients** — Vite/React on the web and shared SwiftUI clients for macOS and iOS.
- **Gateway** — nginx serves the web app and `/api` from one origin in the Docker Compose deployment.

See the [architecture overview](docs/architecture.md) for trust boundaries, protocols, and component details,
and [the project/agent domain contract](docs/project-agent-contract.md) for project coordination.

## Quick start

### Self-host with Docker Compose

Requirements: Docker with Compose and a machine that can build the images.

```bash
git clone https://github.com/jianghailong-xy/orbit.git
cd orbit
cp .env.example .env

# Set JWT_SECRET and PROVIDER_SECRET_KEY in .env. Generate each independently with:
openssl rand -base64 32

docker compose up -d --build
```

Open <http://localhost:2086>. The first visitor creates the initial administrator account. Create a
workspace, then use **Add a runner** in the UI to connect a machine with at least one supported agent runtime
installed and authenticated.

The Compose gateway is HTTP-only. Before exposing Orbit to a network, follow the [self-hosting and production
hardening guide](docs/self-hosting.md), including TLS and off-host backups.

### Develop locally

Requirements: Node.js 20+, Docker or PostgreSQL 16, and Go 1.23+ when working on the runner.

```bash
npm install
cp .env.example .env
npm run db:up
npm run prisma:generate
npm run prisma:migrate -w @orbit/apiserver
npm run dev:apiserver
```

In another terminal:

```bash
npm run dev:web
```

The API runs on <http://localhost:3000> and Vite on <http://localhost:5173>. See the [development
guide](docs/development.md) for tests, repository layout, and native-client setup.

## Project status

Orbit is under active development and should currently be treated as **pre-1.0**. Core functionality is in
place: distributed runners, interactive sessions, project coordination, task graphs, approvals, worktree
isolation, multi-runtime support, web and native clients, runner recovery, backups, and usage reporting.

Before relying on Orbit for critical production work, review the [security policy](SECURITY.md), deployment
hardening guidance, backup runbook, and release notes. Recurring schedules and inbound task sources are not
yet built.

## Community

- Read the [documentation index](docs/README.md) or [support guide](SUPPORT.md).
- Report bugs and request features with [GitHub Issues](https://github.com/jianghailong-xy/orbit/issues).
- Read [CONTRIBUTING.md](CONTRIBUTING.md) before sending a pull request.
- Project decisions and maintainer responsibilities are described in [GOVERNANCE.md](GOVERNANCE.md).
- Security issues must follow [SECURITY.md](SECURITY.md), not a public issue.

## License

Orbit is available under the [MIT License](LICENSE).
