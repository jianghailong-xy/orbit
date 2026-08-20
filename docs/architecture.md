# Architecture overview

Orbit separates coordination from execution. The server stores intent and history; registered runners execute
agent processes on machines that already have access to the relevant repositories, credentials, and networks.

```text
Web / macOS / iOS
        │
        │ REST + server-sent events
        ▼
Gateway ──▶ Control plane ──▶ PostgreSQL
                 ▲
                 │ outbound claim, inbox, heartbeat, event upload
                 │
              Runners ──▶ Claude Code / Codex / Kimi / OpenCode
                             optional git worktree per session
```

## Components

| Component | Location | Responsibility |
| --- | --- | --- |
| Control plane | `src/apiserver` | Authentication, users, workspaces, sessions, task queue, approvals, runners, attachments, and usage |
| Runner and CLI | `src/runner-go` | Machine enrollment, work claiming, runtime adapters, worktrees, recovery, and automation commands |
| Web client | `src/web` | Task and session UI, approvals, search, settings, runner enrollment, and live transcripts |
| Shared contracts | `src/shared` | DTOs, enums, normalized events, provider presets, and control-plane envelopes |
| Native core | `src/macos/OrbitKit` | Shared Swift protocol, models, realtime transport, and transcript logic |
| Native clients | `src/macos/OrbitApp`, `src/ios` | macOS and iPhone/iPad user interfaces, notifications, and local runner control |
| Gateway | `gateway` | One origin for the web app and `/api`, including SSE proxying |
| Database | PostgreSQL 16 | Durable application state, the task queue, and event history |

## Execution model

A **session** is a resumable, multi-turn conversation with one agent runtime on one runner. User turns are
stored before delivery. The runner long-polls for turns, sends them to the runtime, and uploads normalized
events. Clients receive transcript events over a per-session SSE stream.

A **task** is a durable unit of queued work. Tasks can belong to a task list and depend on other tasks. An
eligible runner claims work atomically, starts a session, and reports the result. The task graph—not any one
runtime context window—is the durable project plan.

When worktree isolation is enabled for an agent whose directory is a git repository, every session uses a
separate git worktree. Concurrent sessions can then work on the same repository without writing into the same
checkout. Isolation is off by default for newly created agents. Without it, sessions use the configured
directory directly and concurrent edits can collide. Worktree isolation prevents accidental file collisions;
it is not a security sandbox.

## Realtime and recovery

Orbit uses two server-sent event paths:

- A user-level control stream publishes lifecycle, status, approval, and attention changes.
- A per-session transcript stream replays ordered run events from a sequence number.

Runners use outbound HTTP polling rather than inbound connections. Heartbeats let the control plane detect a
lost runner. Graceful drain stops new claims while active work completes, and supported runtimes can resume a
conversation after a process or machine restart.

## Trust boundaries

- **Runner machine:** Agent processes inherit the operating-system account's access. Orbit does not isolate
  sibling processes owned by that account. Use dedicated accounts or machines when stronger isolation is
  required.
- **Engine credentials:** Runtime logins stay on the runner. The control plane does not need those login
  credentials.
- **Model-provider keys:** Optional bring-your-own provider keys are stored by the control plane, encrypted
  with AES-256-GCM under `PROVIDER_SECRET_KEY`, and injected only when a matching runtime starts.
- **Network:** Runners initiate connections to the server, so no inbound runner port is required. A public
  deployment still needs HTTPS and normal perimeter controls.
- **Approvals:** Permission modes and allowlists decide which actions run immediately and which require a
  human decision. They reduce accidental execution; they are not a substitute for runner-host isolation.
- **Orchestration:** Session-scoped proofs are short-lived and re-authorized against the live session,
  workspace, and runner assignment. Service tokens grant explicit scopes and can be revoked independently.

Read [SECURITY.md](../SECURITY.md) before exposing Orbit or a runner to untrusted users.

## Storage and backups

PostgreSQL is the system of record. The Compose deployment archives WAL continuously and takes periodic base
backups into `./data/pg-archive`. Because this directory is on the same host by default, operators must copy it
off-host. See the [backup and restore runbook](postgres-backup-restore.md).

Attachments and runner-generated artifacts should be treated as deployment data and included in the
operator's retention and recovery plan where applicable.

## Further design detail

The [documentation index](README.md#architecture) links the focused design notes for sessions, realtime
events, retry behavior, search, native clients, and identifiers.
