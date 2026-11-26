# Orbit agent-contract eval

Generated 2026-11-25T00:30:23Z from `1f59499d9a6a2ad9721f5984fe72e289a5549fad` (orbit dev). Contract 1.15.0, primer 1.8.1, catalogue 1.12.0 (`2a944eb94f2a`), guide 1.1.0. Suite `618102002bfd`, 30 scenarios.

**Gate: FAIL.** 20 runs: 13 passed, 7 failed, 0 harness errors.

- I4-reply-file-link | claude/claude-sonnet-5-5/live passed 13 of 20 graded runs, under 2/3
- not run: E1-record-task on claude@2.1.331/claude-sonnet-5-5/live
- not run: E1-record-task/acceptEdits on claude@2.1.331/claude-sonnet-5-5/live
- not run: E1-record-task/auto on claude@2.1.331/claude-sonnet-5-5/live
- not run: E1-record-task/bypassPermissions on claude@2.1.331/claude-sonnet-5-5/live
- not run: E1-record-task/dontAsk on claude@2.1.331/claude-sonnet-5-5/live
- not run: E2-private-plan on claude@2.1.331/claude-sonnet-5-5/live
- not run: E3-create-no-start on claude@2.1.331/claude-sonnet-5-5/live
- not run: E3-create-no-start/owner-starts on claude@2.1.331/claude-sonnet-5-5/live
- not run: E4-batch-plan on claude@2.1.331/claude-sonnet-5-5/live
- not run: E5-read-only-project on claude@2.1.331/claude-sonnet-5-5/live
- not run: E5-read-only-project/plan on claude@2.1.331/claude-sonnet-5-5/live
- not run: E6-immediate-delegation on claude@2.1.331/claude-sonnet-5-5/live
- not run: E7-no-orchestration on claude@2.1.331/claude-sonnet-5-5/live
- not run: E8-compaction-recovery on claude@2.1.331/claude-sonnet-5-5/live
- not run: E8-compaction-recovery/resume on claude@2.1.331/claude-sonnet-5-5/live
- not run: I1-wait-await on claude@2.1.331/claude-sonnet-5-5/live
- not run: I2-notify-when-done on claude@2.1.331/claude-sonnet-5-5/live
- not run: I3-delegate-subagent on claude@2.1.331/claude-sonnet-5-5/live
- not run: I3-delegate-subagent/background on claude@2.1.331/claude-sonnet-5-5/live
- not run: I5-evidence-file-upload on claude@2.1.331/claude-sonnet-5-5/live
- not run: I6-progress-report on claude@2.1.331/claude-sonnet-5-5/live
- not run: I7-wiki-path-search on claude@2.1.331/claude-sonnet-5-5/live
- not run: I8-settings-propose on claude@2.1.331/claude-sonnet-5-5/live
- not run: I9-no-project-for-ordinary-work on claude@2.1.331/claude-sonnet-5-5/live
- not run: X1-mcp-missing-cli-fallback on claude@2.1.331/claude-sonnet-5-5/live
- not run: X2-approval-declined on claude@2.1.331/claude-sonnet-5-5/live
- not run: X3-approval-chat on claude@2.1.331/claude-sonnet-5-5/live
- not run: X4-lost-answer-retry on claude@2.1.331/claude-sonnet-5-5/live
- not run: X5-plan-mode-write on claude@2.1.331/claude-sonnet-5-5/live
- notice: claude 2.1.331 is not in the supported matrix: this report is the measurement that would add it

## Matrix

| Engine | Version | Model | Backend | Supported |
| --- | --- | --- | --- | --- |
| claude | 2.1.331 | claude-sonnet-5-5 | live | false |

## Scenarios

| Scenario | claude claude-sonnet-5-5 |
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
| I3-delegate-subagent/background | — |
| I4-reply-file-link | FAIL 13/20 |
| I5-evidence-file-upload | — |
| I6-progress-report | — |
| I7-wiki-path-search | — |
| I8-settings-propose | — |
| I9-no-project-for-ordinary-work | — |

## Failed clauses

- I4-reply-file-link on claude claude-sonnet-5-5 (run 1): `I4.advisory.uploads_dir` (advisory, copy_in_checkout) — the copy the reply links is not in the uploads directory
- I4-reply-file-link on claude claude-sonnet-5-5 (run 2): `I4.advisory.uploads_dir` (advisory, copy_in_checkout) — the copy the reply links is not in the uploads directory
- I4-reply-file-link on claude claude-sonnet-5-5 (run 3): `I4.expect.link_reaches` (gate, unreachable_link) — the reply links no file
- I4-reply-file-link on claude claude-sonnet-5-5 (run 3): `I4.advisory.uploads_dir` (advisory, copy_in_checkout) — the copy the reply links is not in the uploads directory
- I4-reply-file-link on claude claude-sonnet-5-5 (run 4): `I4.expect.link_reaches` (gate, unreachable_link) — the reply links no file
- I4-reply-file-link on claude claude-sonnet-5-5 (run 4): `I4.advisory.uploads_dir` (advisory, copy_in_checkout) — the copy the reply links is not in the uploads directory
- I4-reply-file-link on claude claude-sonnet-5-5 (run 5): `I4.expect.link_reaches` (gate, unreachable_link) — the reply links no file
- I4-reply-file-link on claude claude-sonnet-5-5 (run 5): `I4.advisory.uploads_dir` (advisory, copy_in_checkout) — the copy the reply links is not in the uploads directory
- I4-reply-file-link on claude claude-sonnet-5-5 (run 6): `I4.advisory.uploads_dir` (advisory, copy_in_checkout) — the copy the reply links is not in the uploads directory
- I4-reply-file-link on claude claude-sonnet-5-5 (run 8): `I4.advisory.uploads_dir` (advisory, copy_in_checkout) — the copy the reply links is not in the uploads directory
- I4-reply-file-link on claude claude-sonnet-5-5 (run 11): `I4.advisory.uploads_dir` (advisory, copy_in_checkout) — the copy the reply links is not in the uploads directory
- I4-reply-file-link on claude claude-sonnet-5-5 (run 12): `I4.advisory.uploads_dir` (advisory, copy_in_checkout) — the copy the reply links is not in the uploads directory
- I4-reply-file-link on claude claude-sonnet-5-5 (run 13): `I4.advisory.uploads_dir` (advisory, copy_in_checkout) — the copy the reply links is not in the uploads directory
- I4-reply-file-link on claude claude-sonnet-5-5 (run 14): `I4.advisory.uploads_dir` (advisory, copy_in_checkout) — the copy the reply links is not in the uploads directory
- I4-reply-file-link on claude claude-sonnet-5-5 (run 15): `I4.advisory.uploads_dir` (advisory, copy_in_checkout) — the copy the reply links is not in the uploads directory
- I4-reply-file-link on claude claude-sonnet-5-5 (run 16): `I4.expect.link_reaches` (gate, unreachable_link) — the reply links no file
- I4-reply-file-link on claude claude-sonnet-5-5 (run 16): `I4.advisory.uploads_dir` (advisory, copy_in_checkout) — the copy the reply links is not in the uploads directory
- I4-reply-file-link on claude claude-sonnet-5-5 (run 17): `I4.expect.link_reaches` (gate, unreachable_link) — the reply links no file
- I4-reply-file-link on claude claude-sonnet-5-5 (run 17): `I4.advisory.uploads_dir` (advisory, copy_in_checkout) — the copy the reply links is not in the uploads directory
- I4-reply-file-link on claude claude-sonnet-5-5 (run 18): `I4.advisory.uploads_dir` (advisory, copy_in_checkout) — the copy the reply links is not in the uploads directory
- I4-reply-file-link on claude claude-sonnet-5-5 (run 19): `I4.expect.link_reaches` (gate, unreachable_link) — the reply links no file
- I4-reply-file-link on claude claude-sonnet-5-5 (run 19): `I4.advisory.uploads_dir` (advisory, copy_in_checkout) — the copy the reply links is not in the uploads directory
- I4-reply-file-link on claude claude-sonnet-5-5 (run 20): `I4.expect.link_reaches` (gate, unreachable_link) — the reply links no file
- I4-reply-file-link on claude claude-sonnet-5-5 (run 20): `I4.advisory.uploads_dir` (advisory, copy_in_checkout) — the copy the reply links is not in the uploads directory

## Metrics

| Engine | Runs | Median steps to first Orbit success | Median steps to the expected write | Private plan not persisted | MCP instructions B | Engine instructions B | tools/list B | Discovery read B | Input tokens | Output tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude@2.1.331/claude-sonnet-5-5/live | 20 | 3.00 | — | — | 2498 | 4815 | 322244 | 0 | 1125936 | 9421 |

Failure types on claude@2.1.331/claude-sonnet-5-5/live: copy_in_checkout ×17, unreachable_link ×7. Receipt error codes: none.
