# Orbit agent-contract eval

Generated 2026-11-24T23:40:33Z from `5e21b2629680f29dab9c81d06804d20fa5e977ef` (orbit dev). Contract 1.14.0, primer 1.8.0, catalogue 1.12.0 (`2a944eb94f2a`), guide 1.1.0. Suite `618102002bfd`, 30 scenarios.

**Gate: INCOMPLETE.** 20 runs: 14 passed, 6 failed, 0 harness errors.

- not run: E1-record-task on codex@0.172.0/engine-default/live
- not run: E1-record-task/acceptEdits on codex@0.172.0/engine-default/live
- not run: E1-record-task/auto on codex@0.172.0/engine-default/live
- not run: E1-record-task/bypassPermissions on codex@0.172.0/engine-default/live
- not run: E1-record-task/dontAsk on codex@0.172.0/engine-default/live
- not run: E2-private-plan on codex@0.172.0/engine-default/live
- not run: E3-create-no-start on codex@0.172.0/engine-default/live
- not run: E3-create-no-start/owner-starts on codex@0.172.0/engine-default/live
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
| I3-delegate-subagent/background | PASS 14/20 |
| I4-reply-file-link | — |
| I5-evidence-file-upload | — |
| I6-progress-report | — |
| I7-wiki-path-search | — |
| I8-settings-propose | — |
| I9-no-project-for-ordinary-work | — |

## Failed clauses

- I3-delegate-subagent/background on codex engine-default (run 1): `I3b.expect.delegate` (gate, no_delegate) — delegate was not called
- I3-delegate-subagent/background on codex engine-default (run 1): `I3b.advisory.background` (advisory, foreground_delegate) — no delegate call ran in the background
- I3-delegate-subagent/background on codex engine-default (run 4): `I3b.expect.delegate` (gate, no_delegate) — delegate was not called
- I3-delegate-subagent/background on codex engine-default (run 4): `I3b.advisory.background` (advisory, foreground_delegate) — no delegate call ran in the background
- I3-delegate-subagent/background on codex engine-default (run 7): `I3b.expect.delegate` (gate, no_delegate) — delegate was not called
- I3-delegate-subagent/background on codex engine-default (run 7): `I3b.advisory.background` (advisory, foreground_delegate) — no delegate call ran in the background
- I3-delegate-subagent/background on codex engine-default (run 13): `I3b.expect.delegate` (gate, no_delegate) — delegate was not called
- I3-delegate-subagent/background on codex engine-default (run 13): `I3b.advisory.background` (advisory, foreground_delegate) — no delegate call ran in the background
- I3-delegate-subagent/background on codex engine-default (run 14): `I3b.expect.delegate` (gate, no_delegate) — delegate was not called
- I3-delegate-subagent/background on codex engine-default (run 14): `I3b.advisory.background` (advisory, foreground_delegate) — no delegate call ran in the background
- I3-delegate-subagent/background on codex engine-default (run 20): `I3b.expect.delegate` (gate, no_delegate) — delegate was not called
- I3-delegate-subagent/background on codex engine-default (run 20): `I3b.advisory.background` (advisory, foreground_delegate) — no delegate call ran in the background

## Metrics

| Engine | Runs | Median steps to first Orbit success | Median steps to the expected write | Private plan not persisted | MCP instructions B | Engine instructions B | tools/list B | Discovery read B | Input tokens | Output tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex@0.172.0/engine-default/live | 20 | 2.00 | — | — | 2498 | 6226 | 321685 | 0 | 914381 | 2547 |

Failure types on codex@0.172.0/engine-default/live: foreground_delegate ×6, no_delegate ×6. Receipt error codes: none.
