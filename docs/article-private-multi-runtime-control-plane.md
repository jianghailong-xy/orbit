# A control plane for private, multi-runtime agent work

Small infrastructure teams often have the opposite of a tooling problem: the useful tools are
already inside the network. The repository, internal CLI, VPN, cluster credentials, and approved
coding-agent runtimes live on machines that a hosted service cannot safely reach.

Orbit's category is **Self-hosted mission control for coding agents**.

Run coding agents on your own machines. Keep the plan, history, and controls in one self-hosted place.

This article explains the operating model for teams that want parallel work and several runtimes
without moving execution out of their network. It complements the [README](../README.md), the
[architecture overview](architecture.md), and the [90-second demo storyboard](90-second-demo.md).

## Separate coordination from execution

Orbit keeps the control plane and the agent process in different places:

```text
   web / macOS / iPhone / iPad
              │ REST + SSE
              ▼
      self-hosted control plane ─── PostgreSQL
              ▲                       │
              │ outbound poll          │ tasks, history, approvals
              │                        │
   private-network runner(s) ──────────┘
              │
              ├── Claude Code
              ├── Codex
              ├── Kimi Code
              └── OpenCode
              │
        repository / VPN / internal CLI / optional worktree
```

Runners initiate outbound connections to the server; the control plane does not require an inbound
port on a runner. The runner claims work, starts the selected local runtime, uploads normalized
events, and reports heartbeats and outcomes. Engine logins stay on the runner. This is a network
topology and an operations choice, not a security sandbox.

## Scenario: one backlog, two machines, one reviewer

Imagine a team with a Linux VM that can reach a staging cluster and a macOS laptop used for UI work.
The backlog contains:

1. diagnose a failed ingestion job using the internal CLI;
2. update the dashboard's API client and tests.

Create one workspace per checkout, bind each to the runner with the required access, and dispatch
the tasks independently. If the repositories are shared, enable per-session worktree isolation so
each session gets a separate Git worktree. The reviewer then sees two diffs and decides which one to
merge.

The sequence matters:

```text
task graph → runner claim → local runtime → transcript/approval → diff review → human merge
```

Parallelism is useful because the reviewer can inspect both outcomes in one control plane. It is
not an instruction to merge blindly, and worktrees only prevent accidental file collisions. The
agent processes still run as the runner's operating-system account.

## Keep a risky command in the loop

Permission modes and allowlists determine which actions can run immediately. When a command falls
outside that policy, Orbit can show an approval card with the exact command and Allow/Deny controls.
The transcript records the decision and the resulting outcome.

Use the card as an explicit handoff:

- confirm the repository, environment, and target before allowing the command;
- deny or interrupt when the agent's explanation does not match the requested scope;
- record the reason in the task comment when the decision changes the plan;
- treat “don't ask me again” as an operator policy choice, not as proof that future commands are
  harmless.

Approvals reduce accidental execution. They do not isolate a runner from sibling processes, turn a
worktree into a sandbox, or replace host hardening and least-privilege accounts.

## Choose a runtime without changing the project record

A workspace can use Claude Code, Codex, Kimi Code, or OpenCode, plus configured compatible
providers. The project-level task graph, comments, approvals, and searchable history remain the
coordination layer while a session uses one selected runtime on one runner.

That separation makes an explicit fallback possible:

1. leave the original task and failed session visible;
2. add a comment describing what the first runtime tried and where it stopped;
3. route the next session to a runner with the required runtime or network access;
4. compare the new transcript and diff against the original task, rather than starting an
   untraceable replacement chat.

Feature parity, resume behavior, and usage reporting vary by engine and provider. The provider's
bill is authoritative for cost; Orbit's usage view is an operational aid.

## Operate the trust boundary deliberately

Before attaching private infrastructure, make these choices explicit:

| Decision | Operator action |
| --- | --- |
| Server exposure | Put HTTPS and perimeter access controls in front of the Compose gateway before network exposure. |
| Runner identity | Use a dedicated, least-privilege OS account or host for the repositories and internal tools it may reach. |
| Credentials | Keep runtime logins on the runner; protect runner tokens and never commit them. |
| Data recovery | Back up PostgreSQL and WAL off-host, and test a restore. Include relevant artifacts and attachments in the retention plan. |
| Parallel edits | Turn on worktrees only when the repository is Git-backed and the collision trade-off is understood. |
| Human review | Define who can approve commands and merge diffs; keep the decision in the task history. |

The [self-hosting guide](self-hosting.md) has the setup commands, TLS requirements, backup notes,
and runner registration flow. The [security policy](../SECURITY.md) and [human-only authority
notes](human-only-authority.md) describe what the product does—and does not—prove about an actor.

## A small, reproducible first run

The [demo repo fixture](../examples/demo-repo/) has no credentials or network calls. Use it to
validate the control-plane path before connecting a private checkout:

```bash
git clone https://github.com/jianghailong-xy/orbit.git
cd orbit
cp .env.example .env
# Set unique JWT_SECRET and PROVIDER_SECRET_KEY values in .env.
docker compose up -d --build
```

Open the gateway, add the runner from **Runners → Add a runner**, and point a workspace at a copy of
`examples/demo-repo/`. Run `npm test`, inspect the transcript, then repeat with a second task and
worktree isolation if the repository is suitable.

## Boundaries worth saying out loud

Orbit is not a managed SaaS, a no-setup autonomous coding service, or a security sandbox. It is a
pre-1.0 open-source project. Operators own deployment, TLS, host hardening, backups, monitoring,
least-privilege credentials, and the final merge decision. Start with the [README](../README.md),
pin a tagged release, and review the limits before using it on sensitive systems.

For a 90-second visual version, follow [Access to private infrastructure](90-second-demo.md#scene-3--access-to-private-infrastructure-056118)
and [Parallel agents without checkout collisions](90-second-demo.md#scene-2--parallel-agents-without-checkout-collisions-032056).
