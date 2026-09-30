# GitHub launch messaging brief

**Status:** canonical copy for the first public GitHub launch
**Reviewed:** 2026-09-29
**Scope:** README, the short product demo, and GitHub release copy

This is the source of truth for the public promise. Feature documentation may add detail, but it must not
broaden the audience, turn a boundary into a guarantee, or replace the scenario names below. Keep the
category line, core promise, scenario names, and pre-1.0 statement verbatim wherever they appear.

## Positioning

| Element | Canonical wording |
| --- | --- |
| Product | **Orbit — Agent Mission Control** |
| Category | **Self-hosted mission control for coding agents** |
| Core promise | **Run coding agents on your own machines. Keep the plan, history, and controls in one self-hosted place.** |

### Target user

Orbit is for small engineering and infrastructure teams that already run coding agents against private code
or internal systems and need work to span sessions, machines, and context windows without losing visibility or
human control. Individual power users coordinating several agent sessions across machines are a good secondary
audience.

Do not position Orbit as a managed SaaS, a no-setup autonomous coding service, or a security sandbox. A user
must be prepared to operate a server, register runners, install and authenticate an agent runtime, and make
their own deployment and access-control decisions.

### Proof pillars

1. **Durable work:** projects, task lists, dependencies, comments, resumable sessions, and searchable history
   keep the plan alive after a chat, context window, or machine ends.
2. **Local execution:** outbound-polling runners execute beside the repositories, CLIs, credentials, VPNs, and
   internal networks that the user chooses to expose.
3. **Supervised parallelism:** optional worktrees, permission modes, live approvals, status, and usage let a
   person run several agents while retaining a visible intervention point.

## Three launch scenarios

Use these names and order in the README, the 90-second demo, and release announcements.

### 1. Work that outlives a chat

Turn a multi-day migration, refactor, or test rescue into a durable task graph. Dependencies, comments, and
session history survive context limits, restarts, and a closed browser, so the next session can continue without
reconstructing the plan.

**Show:** task list → dependency → resumable session → result and comment history.

### 2. Parallel agents without checkout collisions

Split a backlog across runners and enable a separate git worktree per session. Agents can work concurrently;
the person reviews diffs and chooses what to merge.

**Show:** two tasks dispatched → isolated worktrees → diff review → human merge decision.

### 3. Access to private infrastructure

Run a runner on a machine that already has the required repository, internal CLI, VPN, or cluster access.
Runners poll outward, and an agent's risky command appears as an approval card before it proceeds.

**Show:** runner inside the private network → command approval → transcript and outcome; never imply that the
runner account is a sandbox.

## Claims and boundaries

### We can say

- Orbit is self-hosted and MIT-licensed, with a web UI plus native macOS and iPhone/iPad clients.
- The control plane coordinates Claude Code, Codex, Kimi, and OpenCode, plus configured compatible providers.
- Runners make outbound connections; the control plane does not require inbound access to a runner.
- Worktrees reduce checkout collisions, approvals expose risky actions, and the task graph is the durable plan.

### We must not promise

- **Autonomy:** Orbit coordinates and supervises agents; it does not guarantee that an agent finishes correctly
  without review, approval, or a human merge decision.
- **Isolation:** a worktree is file-collision isolation, not a security boundary. Agent processes inherit the
  runner OS account's access, and sibling processes owned by that account are not isolated.
- **Managed reliability:** this is not a hosted service, HA guarantee, zero-data-loss promise, SLA, compliance
  certification, or enterprise support contract. Operators own TLS, host hardening, backups, monitoring, and
  least-privilege credentials.
- **Feature parity or exact recovery:** runtime support, resume behavior, model features, and usage/cost data
  vary by engine and provider; the provider's bill is authoritative.
- **Missing roadmap items:** recurring schedules and inbound task sources (ticket/chat ingestion) are designed
  for, but not built.

## Public launch gates

These are promotion gates, not feature ideas. A release announcement should link evidence for every blocking
gate against the exact commit or tag being announced.

| Gate | Required evidence | 2026-09-29 audit finding |
| --- | --- | --- |
| Copy truth | README, demo script, and release opening use the category line, core promise, and the three scenario names above; limitations remain visible. | Brief now defines the copy; downstream materials must adopt it. |
| CI | Required checks are green on the candidate: JavaScript build/tests, PostgreSQL specs with no silent skips, Go runner, Swift core, and container image build/boot. Run the macOS/iOS client compile workflow for client-bearing candidates. | Workflow definitions exist; record a green run for each candidate rather than treating the badge as evidence. |
| Clean-machine install | From a clean Linux host, install the tagged server with Docker Compose, create the first admin, register a clean runner with an authenticated runtime, and complete one first task. Record OS, Docker/runtime versions, tag/SHA, elapsed time, and sanitized logs. | README commands exist, but no reproducible clean-host record is present in this checkout. **Blocking.** |
| Security and operations | Link `SECURITY.md` and the self-hosting hardening guide; verify unique secrets, HTTPS before network exposure, least-privilege runners, off-host backup, restore check, and private vulnerability reporting. | Guidance exists; launch copy must keep these warnings adjacent to installation. |
| Version and release truth | One tagged commit and version identify the server, web, runner, and native artifacts; publish human-written notes, upgrade impact, known limits, and verification information. Never describe `main` as a supported release. | At this audit, root `package.json` and release history say `0.1.198`, while the newest tag is `v0.1.2-beta.138`. Choose one public version scheme and make all artifacts agree. **Blocking until reconciled.** |

## Verbatim handoff copy

### README opening

> **Self-hosted mission control for coding agents.**
>
> Run coding agents on your own machines. Keep the plan, history, and controls in one self-hosted place.

Follow immediately with the three scenario headings in the order above. Link the install path, security policy,
and this brief; do not lead with a complete feature inventory.

### 90-second demo opening and close

Opening: “Orbit is self-hosted mission control for coding agents. Run coding agents on your own machines. Keep
the plan, history, and controls in one self-hosted place.” Show the three scenarios in order, using only the
evidence listed under each one.

Close: “Orbit is pre-1.0. It coordinates and supervises agent work; it is not a hosted service or a security
sandbox. Pin a tagged release, follow the hardening guide, and review the limits before using it.”

### Release opening

> Orbit is self-hosted mission control for coding agents. Run coding agents on your own machines. Keep the plan,
> history, and controls in one self-hosted place.

Then name which of the three scenarios the release demonstrates, link the clean-install evidence, and state
upgrade impact and known limitations. Use the following version statement verbatim:

> Orbit is a pre-1.0 open-source project under active development. Pin deployments to a tagged release and
> review upgrade notes before changing versions. The latest published release receives best-effort security
> fixes; `main` is a development branch and older releases are not supported.
