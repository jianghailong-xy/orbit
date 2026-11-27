# Orbit agent-contract eval

Generated 2026-11-24T15:22:49Z from `3d0a8ea34c` (orbit dev). Contract 1.13.0, primer 1.7.0, catalogue 1.11.0 (`b063b34e353d`), guide 1.1.0. Suite `618102002bfd`, 30 scenarios.

**Gate: INCOMPLETE.** 10 runs: 10 passed, 0 failed, 0 harness errors.

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
- not run: I4-reply-file-link on claude@2.1.331/claude-sonnet-5-5/live
- not run: I5-evidence-file-upload on claude@2.1.331/claude-sonnet-5-5/live
- not run: I6-progress-report on claude@2.1.331/claude-sonnet-5-5/live
- not run: I7-wiki-path-search on claude@2.1.331/claude-sonnet-5-5/live
- not run: I8-settings-propose on claude@2.1.331/claude-sonnet-5-5/live
- not run: I9-no-project-for-ordinary-work on claude@2.1.331/claude-sonnet-5-5/live
- not run: X3-approval-chat on claude@2.1.331/claude-sonnet-5-5/live
- not run: X4-lost-answer-retry on claude@2.1.331/claude-sonnet-5-5/live
- not run: X5-plan-mode-write on claude@2.1.331/claude-sonnet-5-5/live
- notice: claude 2.1.331 is not in the supported matrix: this report is the measurement that would add it
- notice: not applicable: X1-mcp-missing-cli-fallback on claude, because Claude Code runs no turn without Orbit's MCP server: the session's --permission-prompt-tool is Orbit's permission_prompt, and Claude Code 2.1.325 exits when the server that serves it did not start

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
| X1-mcp-missing-cli-fallback | n/a |
| X2-approval-declined | PASS 10/10 |
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

None.

## Metrics

| Engine | Runs | Median steps to first Orbit success | Median steps to the expected write | Private plan not persisted | MCP instructions B | Engine instructions B | tools/list B | Discovery read B | Input tokens | Output tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude@2.1.331/claude-sonnet-5-5/live | 10 | — | — | — | 2669 | 6132 | 318569 | 0 | 1164547 | 6791 |

Failure types on claude@2.1.331/claude-sonnet-5-5/live: none. Receipt error codes: APPROVAL_DECLINED ×10, INVALID_ARGUMENTS ×6.
