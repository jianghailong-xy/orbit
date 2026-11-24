# Orbit agent-contract eval

Generated 2026-11-24T04:59:58Z from `dccc711c83df9fee3a41ab482594d2eb19698673` (orbit dev). Contract 1.12.0, primer 1.4.5, catalogue 1.10.0 (`586b78932900`), guide 1.1.0. Suite `643d28233e2c`, 30 scenarios.

Played without the instruction units `progress`: a measurement of those units, not a baseline.

**Gate: FAIL.** 20 runs: 2 passed, 18 failed, 0 harness errors.

- I6-progress-report | claude/claude-sonnet-5-5/live passed 0 of 10 graded runs, under 2/3
- I6-progress-report | codex/engine-default/live passed 2 of 10 graded runs, under 2/3
- not run: E1-record-task on claude@2.1.331/claude-sonnet-5-5/live
- not run: E1-record-task on codex@0.172.0/engine-default/live
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
| E1-record-task | — | — |
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
| I6-progress-report | FAIL 0/10 | FAIL 2/10 |
| I7-wiki-path-search | — | — |
| I8-settings-propose | — | — |
| I9-no-project-for-ordinary-work | — | — |

## Failed clauses

- I6-progress-report on claude claude-sonnet-5-5 (run 1): `I6.expect.progress` (gate, progress_not_reported) — no progress was reported to Orbit
- I6-progress-report on claude claude-sonnet-5-5 (run 1): `I6.advisory.each_item` (advisory, progress_once) — no progress was reported to Orbit
- I6-progress-report on claude claude-sonnet-5-5 (run 2): `I6.expect.progress` (gate, progress_not_reported) — no progress was reported to Orbit
- I6-progress-report on claude claude-sonnet-5-5 (run 2): `I6.advisory.each_item` (advisory, progress_once) — no progress was reported to Orbit
- I6-progress-report on claude claude-sonnet-5-5 (run 3): `I6.expect.progress` (gate, progress_not_reported) — no progress was reported to Orbit
- I6-progress-report on claude claude-sonnet-5-5 (run 3): `I6.advisory.each_item` (advisory, progress_once) — no progress was reported to Orbit
- I6-progress-report on claude claude-sonnet-5-5 (run 4): `I6.expect.progress` (gate, progress_not_reported) — no progress was reported to Orbit
- I6-progress-report on claude claude-sonnet-5-5 (run 4): `I6.advisory.each_item` (advisory, progress_once) — no progress was reported to Orbit
- I6-progress-report on claude claude-sonnet-5-5 (run 5): `I6.expect.progress` (gate, progress_not_reported) — no progress was reported to Orbit
- I6-progress-report on claude claude-sonnet-5-5 (run 5): `I6.advisory.each_item` (advisory, progress_once) — no progress was reported to Orbit
- I6-progress-report on claude claude-sonnet-5-5 (run 6): `I6.expect.progress` (gate, progress_not_reported) — no progress was reported to Orbit
- I6-progress-report on claude claude-sonnet-5-5 (run 6): `I6.advisory.each_item` (advisory, progress_once) — no progress was reported to Orbit
- I6-progress-report on claude claude-sonnet-5-5 (run 7): `I6.expect.progress` (gate, progress_not_reported) — no progress was reported to Orbit
- I6-progress-report on claude claude-sonnet-5-5 (run 7): `I6.advisory.each_item` (advisory, progress_once) — no progress was reported to Orbit
- I6-progress-report on claude claude-sonnet-5-5 (run 8): `I6.expect.progress` (gate, progress_not_reported) — no progress was reported to Orbit
- I6-progress-report on claude claude-sonnet-5-5 (run 8): `I6.advisory.each_item` (advisory, progress_once) — no progress was reported to Orbit
- I6-progress-report on claude claude-sonnet-5-5 (run 9): `I6.expect.progress` (gate, progress_not_reported) — no progress was reported to Orbit
- I6-progress-report on claude claude-sonnet-5-5 (run 9): `I6.advisory.each_item` (advisory, progress_once) — no progress was reported to Orbit
- I6-progress-report on claude claude-sonnet-5-5 (run 10): `I6.expect.progress` (gate, progress_not_reported) — no progress was reported to Orbit
- I6-progress-report on claude claude-sonnet-5-5 (run 10): `I6.advisory.each_item` (advisory, progress_once) — no progress was reported to Orbit
- I6-progress-report on codex engine-default (run 1): `I6.expect.progress` (gate, progress_not_reported) — no progress was reported to Orbit
- I6-progress-report on codex engine-default (run 1): `I6.advisory.each_item` (advisory, progress_once) — no progress was reported to Orbit
- I6-progress-report on codex engine-default (run 2): `I6.advisory.each_item` (advisory, progress_once) — progress was reported 1 time(s)
- I6-progress-report on codex engine-default (run 3): `I6.expect.progress` (gate, progress_not_reported) — no progress was reported to Orbit
- I6-progress-report on codex engine-default (run 3): `I6.advisory.each_item` (advisory, progress_once) — no progress was reported to Orbit
- I6-progress-report on codex engine-default (run 4): `I6.expect.progress` (gate, progress_not_reported) — no progress was reported to Orbit
- I6-progress-report on codex engine-default (run 4): `I6.advisory.each_item` (advisory, progress_once) — no progress was reported to Orbit
- I6-progress-report on codex engine-default (run 5): `I6.expect.progress` (gate, progress_not_reported) — no progress was reported to Orbit
- I6-progress-report on codex engine-default (run 5): `I6.advisory.each_item` (advisory, progress_once) — no progress was reported to Orbit
- I6-progress-report on codex engine-default (run 7): `I6.expect.progress` (gate, progress_not_reported) — no progress was reported to Orbit
- I6-progress-report on codex engine-default (run 7): `I6.advisory.each_item` (advisory, progress_once) — no progress was reported to Orbit
- I6-progress-report on codex engine-default (run 8): `I6.expect.progress` (gate, progress_not_reported) — no progress was reported to Orbit
- I6-progress-report on codex engine-default (run 8): `I6.advisory.each_item` (advisory, progress_once) — no progress was reported to Orbit
- I6-progress-report on codex engine-default (run 9): `I6.expect.progress` (gate, progress_not_reported) — no progress was reported to Orbit
- I6-progress-report on codex engine-default (run 9): `I6.advisory.each_item` (advisory, progress_once) — no progress was reported to Orbit
- I6-progress-report on codex engine-default (run 10): `I6.expect.progress` (gate, progress_not_reported) — no progress was reported to Orbit
- I6-progress-report on codex engine-default (run 10): `I6.advisory.each_item` (advisory, progress_once) — no progress was reported to Orbit

## Metrics

| Engine | Runs | Median steps to first Orbit success | Median steps to the expected write | Private plan not persisted | MCP instructions B | Engine instructions B | tools/list B | Discovery read B | Input tokens | Output tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude@2.1.331/claude-sonnet-5-5/live | 10 | 2.50 | — | — | 3388 | 7366 | 317174 | 0 | 1959216 | 12153 |
| codex@0.172.0/engine-default/live | 10 | 1.00 | 11.00 | — | 3388 | 7908 | 316861 | 0 | 460817 | 802 |

Failure types on claude@2.1.331/claude-sonnet-5-5/live: progress_not_reported ×10, progress_once ×10. Receipt error codes: none.

Failure types on codex@0.172.0/engine-default/live: progress_not_reported ×8, progress_once ×9. Receipt error codes: none.
