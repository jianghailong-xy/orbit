# Orbit documentation

This is the entry point for Orbit's user, operator, contributor, and maintainer documentation. The root
[README](../README.md) is intentionally short; use this page to find the detailed guide for a task.

## Start here

| If you want to… | Read |
| --- | --- |
| Understand the product and its use cases | [Product introduction](product-intro.md) |
| Run Orbit on your own server | [Self-hosting](self-hosting.md) |
| Understand the system and trust boundaries | [Architecture overview](architecture.md) |
| Build or change Orbit | [Development guide](development.md) and [contribution guide](../CONTRIBUTING.md) |
| Automate tasks and sessions | [Runner CLI and automation](runner-cli.md) |
| Restore or validate a backup | [Postgres backup and restore](postgres-backup-restore.md) |
| Diagnose database conflicts, or deploy and roll back the code that handles them | [PostgreSQL conflict runbook](postgres-conflict-runbook.md) |
| Understand project direction | [Project maturity and brand roadmap](project-maturity.md) |

## Product and operations

- [Product introduction](product-intro.md) — the problem Orbit solves, a day-in-the-life walkthrough, and
  current boundaries.
- [Self-hosting](self-hosting.md) — Docker Compose, secrets, runners, TLS, upgrades, and production checks.
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
- [Interactive runner sessions](interactive-claude-runner-design.md) — the original long-lived session design.
- [Session lifecycle](session-lifecycle-design.md) — run state, lifecycle state, and task state.
- [Realtime control-plane stream](realtime-control-plane-stream.md) — user-level SSE events and replay.
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

Design notes capture the reasoning and implementation state at the time they were written. When a design note
conflicts with current code or a current operator guide, the code and operator guide are authoritative. Notes
that include an "implementation differences" section should be read with that section in mind.

## Project and community

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
