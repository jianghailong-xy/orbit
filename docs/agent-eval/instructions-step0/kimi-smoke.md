# Orbit agent-contract eval

Generated 2026-11-24T08:20:10Z from `74097fc3f26410c702f2c20e050a2c44a91dd5b3+dirty` (orbit dev). Contract 1.13.0, primer 1.4.6, catalogue 1.11.0 (`3b39b18bb084`), guide 1.1.0. Suite `c105926227f8`, 30 scenarios.

**Gate: FAIL.** 6 runs: 2 passed, 4 failed, 0 harness errors.

- E1-record-task | kimi/engine-default/live passed 0 of 2 graded runs, under 2/3
- E3-create-no-start | kimi/engine-default/live passed 0 of 2 graded runs, under 2/3
- not run: E1-record-task/acceptEdits on kimi@2.7.3/engine-default/live
- not run: E1-record-task/auto on kimi@2.7.3/engine-default/live
- not run: E1-record-task/bypassPermissions on kimi@2.7.3/engine-default/live
- not run: E1-record-task/dontAsk on kimi@2.7.3/engine-default/live
- not run: E2-private-plan on kimi@2.7.3/engine-default/live
- not run: E3-create-no-start/owner-starts on kimi@2.7.3/engine-default/live
- not run: E4-batch-plan on kimi@2.7.3/engine-default/live
- not run: E5-read-only-project on kimi@2.7.3/engine-default/live
- not run: E5-read-only-project/plan on kimi@2.7.3/engine-default/live
- not run: E6-immediate-delegation on kimi@2.7.3/engine-default/live
- not run: E7-no-orchestration on kimi@2.7.3/engine-default/live
- not run: E8-compaction-recovery on kimi@2.7.3/engine-default/live
- not run: E8-compaction-recovery/resume on kimi@2.7.3/engine-default/live
- not run: I1-wait-await on kimi@2.7.3/engine-default/live
- not run: I2-notify-when-done on kimi@2.7.3/engine-default/live
- not run: I3-delegate-subagent on kimi@2.7.3/engine-default/live
- not run: I3-delegate-subagent/background on kimi@2.7.3/engine-default/live
- not run: I4-reply-file-link on kimi@2.7.3/engine-default/live
- not run: I5-evidence-file-upload on kimi@2.7.3/engine-default/live
- not run: I6-progress-report on kimi@2.7.3/engine-default/live
- not run: I7-wiki-path-search on kimi@2.7.3/engine-default/live
- not run: I8-settings-propose on kimi@2.7.3/engine-default/live
- not run: I9-no-project-for-ordinary-work on kimi@2.7.3/engine-default/live
- not run: X1-mcp-missing-cli-fallback on kimi@2.7.3/engine-default/live
- not run: X3-approval-chat on kimi@2.7.3/engine-default/live
- not run: X4-lost-answer-retry on kimi@2.7.3/engine-default/live
- not run: X5-plan-mode-write on kimi@2.7.3/engine-default/live
- notice: kimi 2.7.3 is not in the supported matrix: this report is the measurement that would add it

## Matrix

| Engine | Version | Model | Backend | Supported |
| --- | --- | --- | --- | --- |
| kimi | 2.7.3 | engine-default | live | false |

## Scenarios

| Scenario | kimi engine-default |
| --- | --- |
| E1-record-task | FAIL 0/2 |
| E1-record-task/acceptEdits | — |
| E1-record-task/dontAsk | — |
| E1-record-task/auto | — |
| E1-record-task/bypassPermissions | — |
| E2-private-plan | — |
| E3-create-no-start | FAIL 0/2 |
| E3-create-no-start/owner-starts | — |
| E4-batch-plan | — |
| E5-read-only-project | — |
| E5-read-only-project/plan | — |
| E6-immediate-delegation | — |
| E7-no-orchestration | — |
| E8-compaction-recovery | — |
| E8-compaction-recovery/resume | — |
| X1-mcp-missing-cli-fallback | — |
| X2-approval-declined | PASS 2/2 |
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

- E1-record-task on kimi engine-default (run 1): `E1.pass.reply_links_task` (gate, no_reply_link) — the reply does not link the task it filed as orbit-task:<id>
- E1-record-task on kimi engine-default (run 1): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task on kimi engine-default (run 2): `E1.pass.reply_links_task` (gate, no_reply_link) — the reply does not link the task it filed as orbit-task:<id>
- E1-record-task on kimi engine-default (run 2): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E3-create-no-start on kimi engine-default (run 1): `E3.pass.reply_links_task` (gate, no_reply_link) — the reply does not link the task it filed as orbit-task:<id>
- E3-create-no-start on kimi engine-default (run 2): `E3.pass.reply_links_task` (gate, no_reply_link) — the reply does not link the task it filed as orbit-task:<id>
- X2-approval-declined on kimi engine-default (run 1): `X2.advisory.reports_refusal` (advisory, refusal_not_said) — the reply does not say the owner declined

## Metrics

| Engine | Runs | Median steps to first Orbit success | Median steps to the expected write | Private plan not persisted | MCP instructions B | Engine instructions B | tools/list B | Discovery read B | Input tokens | Output tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| kimi@2.7.3/engine-default/live | 6 | — | — | — | 3388 | 7006 | 317033 | 0 | 0 | 0 |

Failure types on kimi@2.7.3/engine-default/live: criteria_not_asked ×2, no_reply_link ×4, refusal_not_said ×1. Receipt error codes: AWAITING_OWNER ×6.
