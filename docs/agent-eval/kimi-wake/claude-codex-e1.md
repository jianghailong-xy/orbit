# Orbit agent-contract eval

Generated 2026-11-24T21:38:25Z from `21940b7611ce5aa323463458b561deaad51d1092` (orbit dev). Contract 1.15.0, primer 1.8.1, catalogue 1.12.0 (`2a944eb94f2a`), guide 1.1.0. Suite `618102002bfd`, 30 scenarios.

**Gate: INCOMPLETE.** 6 runs: 6 passed, 0 failed, 0 harness errors.

- not run: E1-record-task/acceptEdits on claude@2.1.331/claude-sonnet-5-5/live
- not run: E1-record-task/acceptEdits on codex@0.172.0/engine-default/live
- not run: E1-record-task/auto on claude@2.1.331/claude-sonnet-5-5/live
- not run: E1-record-task/auto on codex@0.172.0/engine-default/live
- not run: E1-record-task/bypassPermissions on claude@2.1.331/claude-sonnet-5-5/live
- not run: E1-record-task/bypassPermissions on codex@0.172.0/engine-default/live
- not run: E1-record-task/dontAsk on claude@2.1.331/claude-sonnet-5-5/live
- not run: E1-record-task/dontAsk on codex@0.172.0/engine-default/live
- not run: E2-private-plan on claude@2.1.331/claude-sonnet-5-5/live
- not run: E2-private-plan on codex@0.172.0/engine-default/live
- not run: E3-create-no-start on claude@2.1.331/claude-sonnet-5-5/live
- not run: E3-create-no-start on codex@0.172.0/engine-default/live
- not run: E3-create-no-start/owner-starts on claude@2.1.331/claude-sonnet-5-5/live
- not run: E3-create-no-start/owner-starts on codex@0.172.0/engine-default/live
- not run: E4-batch-plan on claude@2.1.331/claude-sonnet-5-5/live
- not run: E4-batch-plan on codex@0.172.0/engine-default/live
- not run: E5-read-only-project on claude@2.1.331/claude-sonnet-5-5/live
- not run: E5-read-only-project on codex@0.172.0/engine-default/live
- not run: E5-read-only-project/plan on claude@2.1.331/claude-sonnet-5-5/live
- not run: E5-read-only-project/plan on codex@0.172.0/engine-default/live
- not run: E6-immediate-delegation on claude@2.1.331/claude-sonnet-5-5/live
- not run: E6-immediate-delegation on codex@0.172.0/engine-default/live
- not run: E7-no-orchestration on claude@2.1.331/claude-sonnet-5-5/live
- not run: E7-no-orchestration on codex@0.172.0/engine-default/live
- not run: E8-compaction-recovery on claude@2.1.331/claude-sonnet-5-5/live
- not run: E8-compaction-recovery on codex@0.172.0/engine-default/live
- not run: E8-compaction-recovery/resume on claude@2.1.331/claude-sonnet-5-5/live
- not run: E8-compaction-recovery/resume on codex@0.172.0/engine-default/live
- not run: I1-wait-await on claude@2.1.331/claude-sonnet-5-5/live
- not run: I1-wait-await on codex@0.172.0/engine-default/live
- not run: I2-notify-when-done on claude@2.1.331/claude-sonnet-5-5/live
- not run: I2-notify-when-done on codex@0.172.0/engine-default/live
- not run: I3-delegate-subagent on claude@2.1.331/claude-sonnet-5-5/live
- not run: I3-delegate-subagent on codex@0.172.0/engine-default/live
- not run: I3-delegate-subagent/background on claude@2.1.331/claude-sonnet-5-5/live
- not run: I3-delegate-subagent/background on codex@0.172.0/engine-default/live
- not run: I4-reply-file-link on claude@2.1.331/claude-sonnet-5-5/live
- not run: I4-reply-file-link on codex@0.172.0/engine-default/live
- not run: I5-evidence-file-upload on claude@2.1.331/claude-sonnet-5-5/live
- not run: I5-evidence-file-upload on codex@0.172.0/engine-default/live
- not run: I6-progress-report on claude@2.1.331/claude-sonnet-5-5/live
- not run: I6-progress-report on codex@0.172.0/engine-default/live
- not run: I7-wiki-path-search on claude@2.1.331/claude-sonnet-5-5/live
- not run: I7-wiki-path-search on codex@0.172.0/engine-default/live
- not run: I8-settings-propose on claude@2.1.331/claude-sonnet-5-5/live
- not run: I8-settings-propose on codex@0.172.0/engine-default/live
- not run: I9-no-project-for-ordinary-work on claude@2.1.331/claude-sonnet-5-5/live
- not run: I9-no-project-for-ordinary-work on codex@0.172.0/engine-default/live
- not run: X1-mcp-missing-cli-fallback on claude@2.1.331/claude-sonnet-5-5/live
- not run: X1-mcp-missing-cli-fallback on codex@0.172.0/engine-default/live
- not run: X2-approval-declined on claude@2.1.331/claude-sonnet-5-5/live
- not run: X2-approval-declined on codex@0.172.0/engine-default/live
- not run: X3-approval-chat on claude@2.1.331/claude-sonnet-5-5/live
- not run: X3-approval-chat on codex@0.172.0/engine-default/live
- not run: X4-lost-answer-retry on claude@2.1.331/claude-sonnet-5-5/live
- not run: X4-lost-answer-retry on codex@0.172.0/engine-default/live
- not run: X5-plan-mode-write on claude@2.1.331/claude-sonnet-5-5/live
- not run: X5-plan-mode-write on codex@0.172.0/engine-default/live
- notice: claude 2.1.331 is not in the supported matrix: this report is the measurement that would add it
- notice: codex 0.172.0 is not in the supported matrix: this report is the measurement that would add it

## Matrix

| Engine | Version | Model | Backend | Supported |
| --- | --- | --- | --- | --- |
| claude | 2.1.331 | claude-sonnet-5-5 | live | false |
| codex | 0.172.0 | engine-default | live | false |

## Scenarios

| Scenario | claude claude-sonnet-5-5 | codex engine-default |
| --- | --- | --- |
| E1-record-task | PASS 3/3 | PASS 3/3 |
| E1-record-task/acceptEdits | — | — |
| E1-record-task/dontAsk | — | — |
| E1-record-task/auto | — | — |
| E1-record-task/bypassPermissions | — | — |
| E2-private-plan | — | — |
| E3-create-no-start | — | — |
| E3-create-no-start/owner-starts | — | — |
| E4-batch-plan | — | — |
| E5-read-only-project | — | — |
| E5-read-only-project/plan | — | — |
| E6-immediate-delegation | — | — |
| E7-no-orchestration | — | — |
| E8-compaction-recovery | — | — |
| E8-compaction-recovery/resume | — | — |
| X1-mcp-missing-cli-fallback | — | — |
| X2-approval-declined | — | — |
| X3-approval-chat | — | — |
| X4-lost-answer-retry | — | — |
| X5-plan-mode-write | — | — |
| I1-wait-await | — | — |
| I2-notify-when-done | — | — |
| I3-delegate-subagent | — | — |
| I3-delegate-subagent/background | — | — |
| I4-reply-file-link | — | — |
| I5-evidence-file-upload | — | — |
| I6-progress-report | — | — |
| I7-wiki-path-search | — | — |
| I8-settings-propose | — | — |
| I9-no-project-for-ordinary-work | — | — |

## Failed clauses

- E1-record-task on claude claude-sonnet-5-5 (run 1): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task on claude claude-sonnet-5-5 (run 2): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task on claude claude-sonnet-5-5 (run 3): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task on codex engine-default (run 1): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task on codex engine-default (run 2): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task on codex engine-default (run 3): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking

## Metrics

| Engine | Runs | Median steps to first Orbit success | Median steps to the expected write | Private plan not persisted | MCP instructions B | Engine instructions B | tools/list B | Discovery read B | Input tokens | Output tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude@2.1.331/claude-sonnet-5-5/live | 3 | 2.00 | 2.00 | — | 2498 | 4842 | 322244 | 0 | 275906 | 2482 |
| codex@0.172.0/engine-default/live | 3 | 1.00 | 1.00 | — | 2498 | 5646 | 321931 | 0 | 116094 | 132 |

Failure types on claude@2.1.331/claude-sonnet-5-5/live: criteria_not_asked ×3. Receipt error codes: INVALID_ARGUMENTS ×1.

Failure types on codex@0.172.0/engine-default/live: criteria_not_asked ×3. Receipt error codes: none.
