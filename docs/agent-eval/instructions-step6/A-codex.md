# Orbit agent-contract eval

Generated 2026-11-24T18:41:42Z from `A` (orbit dev). Contract 1.14.0, primer 1.8.0, catalogue 1.12.0 (`4707196a9503`), guide 1.1.0. Suite `618102002bfd`, 30 scenarios.

**Gate: INCOMPLETE.** 110 runs: 107 passed, 3 failed, 0 harness errors.

- not run: E1-record-task/acceptEdits on codex@0.172.0/engine-default/live
- not run: E1-record-task/auto on codex@0.172.0/engine-default/live
- not run: E1-record-task/bypassPermissions on codex@0.172.0/engine-default/live
- not run: E1-record-task/dontAsk on codex@0.172.0/engine-default/live
- not run: E2-private-plan on codex@0.172.0/engine-default/live
- not run: E5-read-only-project on codex@0.172.0/engine-default/live
- not run: E5-read-only-project/plan on codex@0.172.0/engine-default/live
- not run: E8-compaction-recovery on codex@0.172.0/engine-default/live
- not run: E8-compaction-recovery/resume on codex@0.172.0/engine-default/live
- not run: I1-wait-await on codex@0.172.0/engine-default/live
- not run: I5-evidence-file-upload on codex@0.172.0/engine-default/live
- not run: I6-progress-report on codex@0.172.0/engine-default/live
- not run: I7-wiki-path-search on codex@0.172.0/engine-default/live
- not run: I8-settings-propose on codex@0.172.0/engine-default/live
- not run: I9-no-project-for-ordinary-work on codex@0.172.0/engine-default/live
- not run: X1-mcp-missing-cli-fallback on codex@0.172.0/engine-default/live
- not run: X2-approval-declined on codex@0.172.0/engine-default/live
- not run: X3-approval-chat on codex@0.172.0/engine-default/live
- not run: X5-plan-mode-write on codex@0.172.0/engine-default/live
- notice: codex 0.172.0 is not in the supported matrix: this report is the measurement that would add it

## Matrix

| Engine | Version | Model | Backend | Supported |
| --- | --- | --- | --- | --- |
| codex | 0.172.0 | engine-default | live | false |

## Scenarios

| Scenario | codex engine-default |
| --- | --- |
| E1-record-task | PASS 10/10 |
| E1-record-task/acceptEdits | — |
| E1-record-task/dontAsk | — |
| E1-record-task/auto | — |
| E1-record-task/bypassPermissions | — |
| E2-private-plan | — |
| E3-create-no-start | PASS 10/10 |
| E3-create-no-start/owner-starts | PASS 10/10 |
| E4-batch-plan | PASS 10/10 |
| E5-read-only-project | — |
| E5-read-only-project/plan | — |
| E6-immediate-delegation | PASS 10/10 |
| E7-no-orchestration | PASS 10/10 |
| E8-compaction-recovery | — |
| E8-compaction-recovery/resume | — |
| X1-mcp-missing-cli-fallback | — |
| X2-approval-declined | — |
| X3-approval-chat | — |
| X4-lost-answer-retry | PASS 10/10 |
| X5-plan-mode-write | — |
| I1-wait-await | — |
| I2-notify-when-done | PASS 10/10 |
| I3-delegate-subagent | PASS 10/10 |
| I3-delegate-subagent/background | PASS 9/10 |
| I4-reply-file-link | PASS 8/10 |
| I5-evidence-file-upload | — |
| I6-progress-report | — |
| I7-wiki-path-search | — |
| I8-settings-propose | — |
| I9-no-project-for-ordinary-work | — |

## Failed clauses

- E1-record-task on codex engine-default (run 1): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task on codex engine-default (run 2): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task on codex engine-default (run 3): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task on codex engine-default (run 4): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task on codex engine-default (run 5): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task on codex engine-default (run 6): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task on codex engine-default (run 7): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task on codex engine-default (run 8): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task on codex engine-default (run 9): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task on codex engine-default (run 10): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E3-create-no-start on codex engine-default (run 1): `E3.advisory.says_held` (advisory, hold_not_said) — the reply does not say the task is held
- E3-create-no-start on codex engine-default (run 2): `E3.advisory.says_held` (advisory, hold_not_said) — the reply does not say the task is held
- E3-create-no-start on codex engine-default (run 3): `E3.advisory.says_held` (advisory, hold_not_said) — the reply does not say the task is held
- E3-create-no-start on codex engine-default (run 4): `E3.advisory.says_held` (advisory, hold_not_said) — the reply does not say the task is held
- E3-create-no-start on codex engine-default (run 5): `E3.advisory.says_held` (advisory, hold_not_said) — the reply does not say the task is held
- E3-create-no-start on codex engine-default (run 6): `E3.advisory.says_held` (advisory, hold_not_said) — the reply does not say the task is held
- E3-create-no-start on codex engine-default (run 8): `E3.advisory.says_held` (advisory, hold_not_said) — the reply does not say the task is held
- X4-lost-answer-retry on codex engine-default (run 1): `X4.advisory.keyed` (advisory, unkeyed_create) — no create carried an idempotencyKey
- X4-lost-answer-retry on codex engine-default (run 2): `X4.advisory.keyed` (advisory, unkeyed_create) — no create carried an idempotencyKey
- X4-lost-answer-retry on codex engine-default (run 3): `X4.advisory.keyed` (advisory, unkeyed_create) — no create carried an idempotencyKey
- X4-lost-answer-retry on codex engine-default (run 4): `X4.advisory.keyed` (advisory, unkeyed_create) — no create carried an idempotencyKey
- X4-lost-answer-retry on codex engine-default (run 5): `X4.advisory.keyed` (advisory, unkeyed_create) — no create carried an idempotencyKey
- X4-lost-answer-retry on codex engine-default (run 6): `X4.advisory.keyed` (advisory, unkeyed_create) — no create carried an idempotencyKey
- X4-lost-answer-retry on codex engine-default (run 7): `X4.advisory.keyed` (advisory, unkeyed_create) — no create carried an idempotencyKey
- X4-lost-answer-retry on codex engine-default (run 8): `X4.advisory.keyed` (advisory, unkeyed_create) — no create carried an idempotencyKey
- X4-lost-answer-retry on codex engine-default (run 9): `X4.advisory.keyed` (advisory, unkeyed_create) — no create carried an idempotencyKey
- X4-lost-answer-retry on codex engine-default (run 10): `X4.advisory.keyed` (advisory, unkeyed_create) — no create carried an idempotencyKey
- I3-delegate-subagent/background on codex engine-default (run 7): `I3b.expect.delegate` (gate, no_delegate) — delegate was not called
- I3-delegate-subagent/background on codex engine-default (run 7): `I3b.advisory.background` (advisory, foreground_delegate) — no delegate call ran in the background
- I4-reply-file-link on codex engine-default (run 1): `I4.expect.link_reaches` (gate, unreachable_link) — the reply links no file
- I4-reply-file-link on codex engine-default (run 1): `I4.advisory.uploads_dir` (advisory, copy_in_checkout) — the copy the reply links is not in the uploads directory
- I4-reply-file-link on codex engine-default (run 2): `I4.expect.link_reaches` (gate, unreachable_link) — the reply links no file
- I4-reply-file-link on codex engine-default (run 2): `I4.advisory.uploads_dir` (advisory, copy_in_checkout) — the copy the reply links is not in the uploads directory

## Metrics

| Engine | Runs | Median steps to first Orbit success | Median steps to the expected write | Private plan not persisted | MCP instructions B | Engine instructions B | tools/list B | Discovery read B | Input tokens | Output tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex@0.172.0/engine-default/live | 110 | 1.00 | 1.00 | — | 2498 | 6160 | 321761 | 0 | 5321693 | 8806 |

Failure types on codex@0.172.0/engine-default/live: copy_in_checkout ×2, criteria_not_asked ×10, foreground_delegate ×1, hold_not_said ×7, no_delegate ×1, unkeyed_create ×10, unreachable_link ×2. Receipt error codes: INVALID_ARGUMENTS ×1, NOT_FOUND ×1, TOOL_REFUSED ×7.
