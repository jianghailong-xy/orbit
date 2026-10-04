# Orbit documentation

This is the entry point for Orbit's user, operator, contributor, and maintainer documentation. The root
[README](../README.md) is intentionally short; use this page to find the detailed guide for a task.

## Start here

| If you want to… | Read |
| --- | --- |
| Understand the product and its use cases | [Product introduction](product-intro.md) |
| Watch or record the 90-second product walkthrough | [90-second demo storyboard](90-second-demo.md) |
| Read the long-running-work article | [When a coding task outlives a context window](article-durable-agent-work.md) |
| Read the private multi-runtime article | [A control plane for private, multi-runtime agent work](article-private-multi-runtime-control-plane.md) |
| Reuse the approved public positioning and launch copy | [GitHub launch messaging brief](messaging-brief.md) |
| Prepare a launch announcement | [First-launch copy pack](launch-copy.md) |
| Tag launch links per channel and write the 30-day review | [First-launch tracking and 30-day review](launch-tracking.md) |
| Collect a design-partner story | [Design partner case-study template](design-partner-case-study-template.md) |
| Follow project direction | [Public roadmap](../ROADMAP.md) |
| Run Orbit on your own server | [Self-hosting](self-hosting.md) |
| Complete the first task on a fresh host | [Clean-machine first-run checklist](first-run.md) |
| Find deployment settings and defaults | [Configuration reference](configuration.md) |
| Diagnose runner enrollment, heartbeat, or runtime failures | [Runner troubleshooting](runner-troubleshooting.md) |
| Publish or upgrade a release | [Release process](release-process.md) |
| Verify a fresh install and runner heartbeat | [Clean-host smoke record](evidence/clean-install-2026-09-29.md) |
| Understand the system and trust boundaries | [Architecture overview](architecture.md) |
| Build or change Orbit | [Development guide](development.md) and [contribution guide](../CONTRIBUTING.md) |
| Automate tasks and sessions | [Runner CLI and automation](runner-cli.md) |
| Restore or validate a backup | [Postgres backup and restore](postgres-backup-restore.md) |
| Diagnose database conflicts, or deploy and roll back the code that handles them | [PostgreSQL conflict runbook](postgres-conflict-runbook.md) |
| Understand project direction | [Project maturity and brand roadmap](project-maturity.md) |

## Product and operations

- [Product introduction](product-intro.md) — the problem Orbit solves, a day-in-the-life walkthrough, and
  current boundaries.
- [90-second demo storyboard](90-second-demo.md) — timed shots, narration, evidence rules, and the canonical
  opening/close for a GitHub product demo.
- [When a coding task outlives a context window](article-durable-agent-work.md) — a technical scenario for
  durable task graphs, resumable sessions, handoffs, and human review.
- [A control plane for private, multi-runtime agent work](article-private-multi-runtime-control-plane.md) — a
  deployment scenario for private runners, approvals, worktrees, and several runtimes.
- [First-launch copy pack](launch-copy.md) — release, Discussion, social, reply, and design-partner copy with
  evidence and boundary checklists.
- [Design partner case-study template](design-partner-case-study-template.md) — consent, evidence, quote, and
  publication fields for a fact-checked partner story.
- [Self-hosting](self-hosting.md) — Docker Compose, secrets, runners, TLS, upgrades, and production checks.
- [Clean-machine first-run checklist](first-run.md) — prerequisites, bootstrap, enrollment, one completed task,
  and a reusable evidence table.
- [Configuration reference](configuration.md) — server, backup, and runner settings with defaults and change procedures.
- [Runner troubleshooting](runner-troubleshooting.md) — enrollment, heartbeat/connectivity, runtime authentication,
  and safe support evidence.
- [Runner CLI and automation](runner-cli.md) — task/session commands, service tokens, and authorization
  boundaries.
- [Postgres backup and restore](postgres-backup-restore.md) — base backups, WAL archiving, point-in-time
  recovery, and restore verification.
- [PostgreSQL conflict runbook](postgres-conflict-runbook.md) — the transaction-conflict counters and where to
  read them, how to tell an injected fault from absorbed contention, a lock-order defect, a database resource
  fault and an unretried path, alert thresholds, PostgreSQL log correlation, and the deploy, mixed-schema,
  rollback and data-check procedures for the migrations behind them.
- [macOS app](../src/macos/OrbitApp/README.md) and [iOS app](../src/ios/README.md) — native build and release
  details.

## Architecture

- [Architecture overview](architecture.md) — components, data flow, execution model, and trust boundaries.
- [Managed runner deployment and data contract](managed-runner-design.md) — default disabled Kubernetes runners,
  per-user Ceph RBD storage, lifecycle, fencing, client status, and isolated test prerequisites.
- [Interactive runner sessions](interactive-claude-runner-design.md) — the original long-lived session design.
- [Session lifecycle](session-lifecycle-design.md) — run state, lifecycle state, and task state.
- [Realtime control-plane stream](realtime-control-plane-stream.md) — user-level SSE events and replay.
- [Watch contract](watch-contract.md) — the frozen domain and product semantics for persistent cross-Session
  and cross-Task watching: the versioned typed predicate, the Watch/Match/Delivery state machines, why
  `AWAITING_INPUT` is not task completion, and why realtime events are not the fact source.
- [Session search](session-search-design.md) — server-side multilingual search.
- [Rate-limit retry](quota-limit-retry-design.md) — usage-limit detection and automatic retry.
- [Cross-platform badge sync](cross-platform-badge-sync.md) — attention state across clients.
- [Public ID migration](public-id-migration-design.md) — external ID rules and migration.
- [macOS client design](macos-client-design.md) and [OrbitKit](../src/macos/OrbitKit/README.md) — native-client
  architecture.
- [Phase 0 findings](phase0-findings.md) — empirical Claude CLI streaming-input results.
- [Codex `turn/steer` contract](codex-turn-steer-contract.md) — the frozen wire format, failure taxonomy,
  capability gating, and mixed-version rollout rules for steering a running Codex turn, with the
  [engine evidence](evidence/codex-turn-steer-0.149.0/transcript.md) behind them.
- [The database write audit](db-write-audit.md) — every write in the API server with its lock order,
  identity, replayability, effects and retry decision, the trigger set derived from the migrations,
  and the static tests that fail when any of it stops being true.
- [PostgreSQL lock-order barrier fixture](postgres-deadlock-barrier.md) — the isolated multi-connection
  harness that reproduces the two 2026-08-21 `40P01` deadlocks deterministically, their lock graphs and
  `pg_locks`/`pg_blocking_pids` evidence, and how the fix regression reuses the same schedule.
- [Session Project-event trigger scope](session-event-trigger-scope.md) — why migration 0133 declares the
  Session event source over `status`/`deleted_at`/`merge_status` only, what that removes from a
  telemetry write's lock set, and how to upgrade, roll back and tell a missing signal from an absent one.
- [Task dependency revision](task-dependency-revision.md) — why migration 0132 replaces the dispatch
  boundary's `task.updated_at` touch with a per-Task revision row, what that takes out of an edge write's
  lock set, and how the deferred commit-boundary check keeps a mixed-version rollout safe.
- [Task completion criteria](task-completion-criteria.md) — the three peer completion facts and the exact
  cwd, environment, timeout, and PostgreSQL contract for executable acceptance.
- [HUMAN_ONLY authority and credential trust](human-only-authority.md) — why the project-level
  owner-review actions are judgment-role boundaries with action-specific traceability rather than
  proof of human presence, including the same-host threat model and stronger alternatives.

Design notes capture the reasoning and implementation state at the time they were written. They are historical
context, not a promise that every proposed behavior exists. When a design note conflicts with current code or a
current operator guide, the code and operator guide are authoritative. Notes that include an "implementation
differences" section should be read with that section in mind; contributors should append such a section rather
than silently rewriting the historical decision.

## Project and community

- [Community guide](../COMMUNITY.md) — channel choice, labels, good first issues, maintainer response targets,
  and the boundary between current guides and design history.
- [Public roadmap](../ROADMAP.md) — now / next / later direction without date promises.
- [Contributing](../CONTRIBUTING.md) — workflow, tests, and pull-request expectations.
- [Governance](../GOVERNANCE.md) — decision making and the path to maintainership.
- [Security](../SECURITY.md) — supported versions and vulnerability reporting.
- [Dependency security baseline](dependency-security.md) — alert reachability, remediation evidence, and update policy.
- [Support](../SUPPORT.md) — where to ask questions and report problems.
- [Code of Conduct](../CODE_OF_CONDUCT.md) — expected community behavior.
- [Project maturity and brand roadmap](project-maturity.md) — current gaps and a phased path to independent
  open-source operation.

## Documentation conventions

- Public user and contributor documentation is written in English so it can serve the widest contributor base.
- Commands should be copyable and should state their prerequisites and side effects.
- Security-sensitive examples use placeholders and must never contain working credentials.
- Feature changes update the nearest user-facing guide in the same pull request.
- New design proposals belong under `docs/`; temporary mocks belong under `docs/mocks/` or `docs/ux/`.
