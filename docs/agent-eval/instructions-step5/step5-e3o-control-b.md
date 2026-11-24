# Orbit agent-contract eval

Generated 2026-11-24T16:05:56Z from `3d0a8ea34c` (orbit dev). Contract 1.13.0, primer 1.7.0, catalogue 1.11.0 (`b063b34e353d`), guide 1.1.0. Suite `618102002bfd`, 30 scenarios.

**Gate: FAIL.** 10 runs: 6 passed, 4 failed, 0 harness errors.

- E3-create-no-start/owner-starts | codex/engine-default/live passed 6 of 10 graded runs, under 2/3
- not run: E1-record-task on codex@0.172.0/engine-default/live
- not run: E1-record-task/acceptEdits on codex@0.172.0/engine-default/live
- not run: E1-record-task/auto on codex@0.172.0/engine-default/live
- not run: E1-record-task/bypassPermissions on codex@0.172.0/engine-default/live
- not run: E1-record-task/dontAsk on codex@0.172.0/engine-default/live
- not run: E2-private-plan on codex@0.172.0/engine-default/live
- not run: E3-create-no-start on codex@0.172.0/engine-default/live
- not run: E4-batch-plan on codex@0.172.0/engine-default/live
- not run: E5-read-only-project on codex@0.172.0/engine-default/live
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
| E3-create-no-start/owner-starts | FAIL 6/10 |
| E4-batch-plan | — |
| E5-read-only-project | — |
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

- E3-create-no-start/owner-starts on codex engine-default (run 1): `E3o.pass.started_by_owner` (gate, start_missing) — 0 starts were recorded, want the owner's one
- E3-create-no-start/owner-starts on codex engine-default (run 3): `E3o.pass.started_by_owner` (gate, start_missing) — 0 starts were recorded, want the owner's one
- E3-create-no-start/owner-starts on codex engine-default (run 6): `E3o.pass.started_by_owner` (gate, start_missing) — 0 starts were recorded, want the owner's one
- E3-create-no-start/owner-starts on codex engine-default (run 9): `E3o.pass.started_by_owner` (gate, start_missing) — 0 starts were recorded, want the owner's one

## Metrics

| Engine | Runs | Median steps to first Orbit success | Median steps to the expected write | Private plan not persisted | MCP instructions B | Engine instructions B | tools/list B | Discovery read B | Input tokens | Output tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex@0.172.0/engine-default/live | 10 | 1.00 | 1.00 | — | 2669 | 6852 | 318256 | 0 | 402141 | 815 |

Failure types on codex@0.172.0/engine-default/live: start_missing ×4. Receipt error codes: none.
