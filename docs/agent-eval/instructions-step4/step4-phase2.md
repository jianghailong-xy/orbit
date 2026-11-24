# Orbit agent-contract eval

Generated 2026-11-24T13:23:52Z from `2849fc9b1a` (orbit dev). Contract 1.13.0, primer 1.5.0, catalogue 1.11.0 (`b063b34e353d`), guide 1.1.0. Suite `c105926227f8`, 30 scenarios.

**Gate: FAIL.** 120 runs: 111 passed, 9 failed, 0 harness errors.

- I6-progress-report | claude/claude-sonnet-5-5/live passed 1 of 10 graded runs, under 2/3
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
- not run: I9-no-project-for-ordinary-work on claude@2.1.331/claude-sonnet-5-5/live
- not run: I9-no-project-for-ordinary-work on codex@0.172.0/engine-default/live
- not run: X1-mcp-missing-cli-fallback on claude@2.1.331/claude-sonnet-5-5/live
- not run: X1-mcp-missing-cli-fallback on codex@0.172.0/engine-default/live
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
| X2-approval-declined | PASS 10/10 | PASS 10/10 |
| X3-approval-chat | PASS 10/10 | PASS 10/10 |
| X4-lost-answer-retry | PASS 10/10 | PASS 10/10 |
| X5-plan-mode-write | PASS 10/10 | PASS 10/10 |
| I1-wait-await | — | — |
| I2-notify-when-done | — | — |
| I3-delegate-subagent | — | — |
| I3-delegate-subagent/background | — | — |
| I4-reply-file-link | — | — |
| I5-evidence-file-upload | — | — |
| I6-progress-report | FAIL 1/10 | PASS 10/10 |
| I7-wiki-path-search | — | — |
| I8-settings-propose | PASS 10/10 | PASS 10/10 |
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
- I6-progress-report on claude claude-sonnet-5-5 (run 10): `I6.expect.progress` (gate, progress_not_reported) — no progress was reported to Orbit
- I6-progress-report on claude claude-sonnet-5-5 (run 10): `I6.advisory.each_item` (advisory, progress_once) — no progress was reported to Orbit

## Metrics

| Engine | Runs | Median steps to first Orbit success | Median steps to the expected write | Private plan not persisted | MCP instructions B | Engine instructions B | tools/list B | Discovery read B | Input tokens | Output tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude@2.1.331/claude-sonnet-5-5/live | 60 | 3.00 | 3.00 | — | 3060 | 6707 | 318569 | 0 | 7807863 | 57579 |
| codex@0.172.0/engine-default/live | 60 | 1.00 | 2.00 | — | 3060 | 7427 | 318256 | 0 | 2462048 | 3280 |

Failure types on claude@2.1.331/claude-sonnet-5-5/live: progress_not_reported ×9, progress_once ×9. Receipt error codes: APPROVAL_DECLINED ×10, INVALID_ARGUMENTS ×32.

Failure types on codex@0.172.0/engine-default/live: none. Receipt error codes: APPROVAL_DECLINED ×10, SESSION_IN_PLAN_MODE ×10.
