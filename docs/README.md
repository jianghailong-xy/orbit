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
| Understand project direction | [Project maturity and brand roadmap](project-maturity.md) |

## Product and operations

- [Product introduction](product-intro.md) — the problem Orbit solves, a day-in-the-life walkthrough, and
  current boundaries.
- [Self-hosting](self-hosting.md) — Docker Compose, secrets, runners, TLS, upgrades, and production checks.
- [Runner CLI and automation](runner-cli.md) — task/session commands, service tokens, and authorization
  boundaries.
- [Postgres backup and restore](postgres-backup-restore.md) — base backups, WAL archiving, point-in-time
  recovery, and restore verification.
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
- [Brand assets](../brand/README.md) — approved marks, colors, naming, and usage.
- [Project maturity and brand roadmap](project-maturity.md) — current gaps and a phased path to independent
  open-source operation.

## Documentation conventions

- Public user and contributor documentation is written in English so it can serve the widest contributor base.
- Commands should be copyable and should state their prerequisites and side effects.
- Security-sensitive examples use placeholders and must never contain working credentials.
- Feature changes update the nearest user-facing guide in the same pull request.
- New design proposals belong under `docs/`; temporary mocks belong under `docs/mocks/` or `docs/ux/`.
