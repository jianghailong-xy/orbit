# Orbit agent-contract eval

Generated 2026-11-25T03:33:50Z from `8534197f30d88cac4d569b496bcd8739f00de6b4` (orbit dev). Contract 1.15.0, primer 1.8.1, catalogue 1.12.0 (`6bec2474e6c0`), guide 1.1.0. Suite `618102002bfd`, 30 scenarios.

**Gate: INCOMPLETE.** 20 runs: 20 passed, 0 failed, 0 harness errors.

- not run: E1-record-task on codex@0.172.0/engine-default/live
- not run: E1-record-task/acceptEdits on codex@0.172.0/engine-default/live
- not run: E1-record-task/auto on codex@0.172.0/engine-default/live
- not run: E1-record-task/bypassPermissions on codex@0.172.0/engine-default/live
- not run: E1-record-task/dontAsk on codex@0.172.0/engine-default/live
- not run: E2-private-plan on codex@0.172.0/engine-default/live
- not run: E3-create-no-start on codex@0.172.0/engine-default/live
- not run: E3-create-no-start/owner-starts on codex@0.172.0/engine-default/live
- not run: E4-batch-plan on codex@0.172.0/engine-default/live
- not run: E5-read-only-project/plan on codex@0.172.0/engine-default/live
- not run: E6-immediate-delegation on codex@0.172.0/engine-default/live
- not run: E7-no-orchestration on codex@0.172.0/engine-default/live
- not run: E8-compaction-recovery on codex@0.172.0/engine-default/live
- not run: E8-compaction-recovery/resume on codex@0.172.0/engine-default/live
- not run: I1-wait-await on codex@0.172.0/engine-default/live
- not run: I2-notify-when-done on codex@0.172.0/engine-default/live
- not run: I3-delegate-subagent on codex@0.172.0/engine-default/live
- not run: I3-delegate-subagent/background on codex@0.172.0/engine-default/live
- not run: I4-reply-file-link on codex@0.172.0/engine-default/live
- not run: I5-evidence-file-upload on codex@0.172.0/engine-default/live
- not run: I6-progress-report on codex@0.172.0/engine-default/live
- not run: I7-wiki-path-search on codex@0.172.0/engine-default/live
- not run: I8-settings-propose on codex@0.172.0/engine-default/live
- not run: I9-no-project-for-ordinary-work on codex@0.172.0/engine-default/live
- not run: X1-mcp-missing-cli-fallback on codex@0.172.0/engine-default/live
- not run: X2-approval-declined on codex@0.172.0/engine-default/live
- not run: X3-approval-chat on codex@0.172.0/engine-default/live
- not run: X4-lost-answer-retry on codex@0.172.0/engine-default/live
- not run: X5-plan-mode-write on codex@0.172.0/engine-default/live
- notice: codex 0.172.0 is not in the supported matrix: this report is the measurement that would add it

## Matrix

| Engine | Version | Model | Backend | Supported |
| --- | --- | --- | --- | --- |
| codex | 0.172.0 | engine-default | live | false |

## Scenarios

| Scenario | codex engine-default |
| --- | --- |
| E1-record-task | — |
| E1-record-task/acceptEdits | — |
| E1-record-task/dontAsk | — |
| E1-record-task/auto | — |
| E1-record-task/bypassPermissions | — |
| E2-private-plan | — |
| E3-create-no-start | — |
| E3-create-no-start/owner-starts | — |
| E4-batch-plan | — |
| E5-read-only-project | PASS 20/20 |
| E5-read-only-project/plan | — |
| E6-immediate-delegation | — |
| E7-no-orchestration | — |
| E8-compaction-recovery | — |
| E8-compaction-recovery/resume | — |
| X1-mcp-missing-cli-fallback | — |
| X2-approval-declined | — |
| X3-approval-chat | — |
| X4-lost-answer-retry | — |
| X5-plan-mode-write | — |
| I1-wait-await | — |
| I2-notify-when-done | — |
| I3-delegate-subagent | — |
| I3-delegate-subagent/background | — |
| I4-reply-file-link | — |
| I5-evidence-file-upload | — |
| I6-progress-report | — |
| I7-wiki-path-search | — |
| I8-settings-propose | — |
| I9-no-project-for-ordinary-work | — |

## Failed clauses

- E5-read-only-project on codex engine-default (run 2): `E5.advisory.done_not_open` (advisory, claims_mismatch) — the done task is listed as open
- E5-read-only-project on codex engine-default (run 3): `E5.advisory.done_not_open` (advisory, claims_mismatch) — the done task is listed as open
- E5-read-only-project on codex engine-default (run 6): `E5.advisory.done_not_open` (advisory, claims_mismatch) — the done task is listed as open
- E5-read-only-project on codex engine-default (run 9): `E5.advisory.done_not_open` (advisory, claims_mismatch) — the done task is listed as open
- E5-read-only-project on codex engine-default (run 17): `E5.advisory.done_not_open` (advisory, claims_mismatch) — the done task is listed as open
- E5-read-only-project on codex engine-default (run 19): `E5.advisory.done_not_open` (advisory, claims_mismatch) — the done task is listed as open
- E5-read-only-project on codex engine-default (run 20): `E5.advisory.done_not_open` (advisory, claims_mismatch) — the done task is listed as open

## Metrics

| Engine | Runs | Median steps to first Orbit success | Median steps to the expected write | Private plan not persisted | MCP instructions B | Engine instructions B | tools/list B | Discovery read B | Input tokens | Output tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex@0.172.0/engine-default/live | 20 | 1.00 | — | — | 2498 | 5220 | 323907 | 0 | 1138427 | 4022 |

Failure types on codex@0.172.0/engine-default/live: claims_mismatch ×7. Receipt error codes: UNREADABLE_ANSWER ×4.
