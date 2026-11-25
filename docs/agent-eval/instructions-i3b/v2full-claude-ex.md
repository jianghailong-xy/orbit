# Orbit agent-contract eval

Generated 2026-11-25T03:53:36Z from `8534197f30d88cac4d569b496bcd8739f00de6b4` (orbit dev). Contract 1.15.0, primer 1.8.1, catalogue 1.12.0 (`6bec2474e6c0`), guide 1.1.0. Suite `618102002bfd`, 30 scenarios.

**Gate: FAIL.** 90 runs: 80 passed, 10 failed, 0 harness errors.

- E6-immediate-delegation | claude/claude-sonnet-5-5/live passed 0 of 5 graded runs, under 2/3
- E7-no-orchestration | claude/claude-sonnet-5-5/live passed 0 of 5 graded runs, under 2/3
- not run: I1-wait-await on claude@2.1.332/claude-sonnet-5-5/live
- not run: I2-notify-when-done on claude@2.1.332/claude-sonnet-5-5/live
- not run: I3-delegate-subagent on claude@2.1.332/claude-sonnet-5-5/live
- not run: I3-delegate-subagent/background on claude@2.1.332/claude-sonnet-5-5/live
- not run: I4-reply-file-link on claude@2.1.332/claude-sonnet-5-5/live
- not run: I5-evidence-file-upload on claude@2.1.332/claude-sonnet-5-5/live
- not run: I6-progress-report on claude@2.1.332/claude-sonnet-5-5/live
- not run: I7-wiki-path-search on claude@2.1.332/claude-sonnet-5-5/live
- not run: I8-settings-propose on claude@2.1.332/claude-sonnet-5-5/live
- not run: I9-no-project-for-ordinary-work on claude@2.1.332/claude-sonnet-5-5/live
- notice: claude 2.1.332 is not in the supported matrix: this report is the measurement that would add it
- notice: not applicable: E1-record-task/bypassPermissions on claude, because this runner is root, and a root runner does not offer bypassPermissions to Claude Code (permission_modes.go)
- notice: not applicable: X1-mcp-missing-cli-fallback on claude, because Claude Code runs no turn without Orbit's MCP server: the session's --permission-prompt-tool is Orbit's permission_prompt, and Claude Code 2.1.325 exits when the server that serves it did not start

## Matrix

| Engine | Version | Model | Backend | Supported |
| --- | --- | --- | --- | --- |
| claude | 2.1.332 | claude-sonnet-5-5 | live | false |

## Scenarios

| Scenario | claude claude-sonnet-5-5 |
| --- | --- |
| E1-record-task | PASS 5/5 |
| E1-record-task/acceptEdits | PASS 5/5 |
| E1-record-task/dontAsk | PASS 5/5 |
| E1-record-task/auto | PASS 5/5 |
| E1-record-task/bypassPermissions | n/a |
| E2-private-plan | PASS 5/5 |
| E3-create-no-start | PASS 5/5 |
| E3-create-no-start/owner-starts | PASS 5/5 |
| E4-batch-plan | PASS 5/5 |
| E5-read-only-project | PASS 5/5 |
| E5-read-only-project/plan | PASS 5/5 |
| E6-immediate-delegation | FAIL 0/5 |
| E7-no-orchestration | FAIL 0/5 |
| E8-compaction-recovery | PASS 5/5 |
| E8-compaction-recovery/resume | PASS 5/5 |
| X1-mcp-missing-cli-fallback | n/a |
| X2-approval-declined | PASS 5/5 |
| X3-approval-chat | PASS 5/5 |
| X4-lost-answer-retry | PASS 5/5 |
| X5-plan-mode-write | PASS 5/5 |
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

- E1-record-task on claude claude-sonnet-5-5 (run 1): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task on claude claude-sonnet-5-5 (run 2): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task on claude claude-sonnet-5-5 (run 3): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task on claude claude-sonnet-5-5 (run 4): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task on claude claude-sonnet-5-5 (run 5): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task/acceptEdits on claude claude-sonnet-5-5 (run 1): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task/acceptEdits on claude claude-sonnet-5-5 (run 2): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task/acceptEdits on claude claude-sonnet-5-5 (run 3): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task/acceptEdits on claude claude-sonnet-5-5 (run 4): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task/acceptEdits on claude claude-sonnet-5-5 (run 5): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task/dontAsk on claude claude-sonnet-5-5 (run 1): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task/dontAsk on claude claude-sonnet-5-5 (run 2): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task/dontAsk on claude claude-sonnet-5-5 (run 3): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task/dontAsk on claude claude-sonnet-5-5 (run 4): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task/dontAsk on claude claude-sonnet-5-5 (run 5): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task/auto on claude claude-sonnet-5-5 (run 1): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task/auto on claude claude-sonnet-5-5 (run 2): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task/auto on claude claude-sonnet-5-5 (run 3): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task/auto on claude claude-sonnet-5-5 (run 4): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task/auto on claude claude-sonnet-5-5 (run 5): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E6-immediate-delegation on claude claude-sonnet-5-5 (run 1): `E6.expect.start` (gate, no_delegation) — the recorded task was not started and no session was created
- E6-immediate-delegation on claude claude-sonnet-5-5 (run 1): `E6.pass.session_id` (gate, receipt_unmapped) — no start answered with a session id
- E6-immediate-delegation on claude claude-sonnet-5-5 (run 1): `E6.pass.reply_links` (gate, no_reply_link) — the reply links neither the session nor the task it started
- E6-immediate-delegation on claude claude-sonnet-5-5 (run 2): `E6.expect.start` (gate, no_delegation) — the recorded task was not started and no session was created
- E6-immediate-delegation on claude claude-sonnet-5-5 (run 2): `E6.pass.session_id` (gate, receipt_unmapped) — no start answered with a session id
- E6-immediate-delegation on claude claude-sonnet-5-5 (run 2): `E6.pass.reply_links` (gate, no_reply_link) — the reply links neither the session nor the task it started
- E6-immediate-delegation on claude claude-sonnet-5-5 (run 3): `E6.expect.start` (gate, no_delegation) — the recorded task was not started and no session was created
- E6-immediate-delegation on claude claude-sonnet-5-5 (run 3): `E6.pass.session_id` (gate, receipt_unmapped) — no start answered with a session id
- E6-immediate-delegation on claude claude-sonnet-5-5 (run 3): `E6.pass.reply_links` (gate, no_reply_link) — the reply links neither the session nor the task it started
- E6-immediate-delegation on claude claude-sonnet-5-5 (run 4): `E6.expect.start` (gate, no_delegation) — the recorded task was not started and no session was created
- E6-immediate-delegation on claude claude-sonnet-5-5 (run 4): `E6.pass.session_id` (gate, receipt_unmapped) — no start answered with a session id
- E6-immediate-delegation on claude claude-sonnet-5-5 (run 4): `E6.pass.reply_links` (gate, no_reply_link) — the reply links neither the session nor the task it started
- E6-immediate-delegation on claude claude-sonnet-5-5 (run 5): `E6.expect.start` (gate, no_delegation) — the recorded task was not started and no session was created
- E6-immediate-delegation on claude claude-sonnet-5-5 (run 5): `E6.pass.session_id` (gate, receipt_unmapped) — no start answered with a session id
- E6-immediate-delegation on claude claude-sonnet-5-5 (run 5): `E6.pass.reply_links` (gate, no_reply_link) — the reply links neither the session nor the task it started
- E7-no-orchestration on claude claude-sonnet-5-5 (run 1): `E7.pass.task_family_or_boundary` (gate, dropped_request) — nothing was started through the task family and the reply does not name the switch
- E7-no-orchestration on claude claude-sonnet-5-5 (run 2): `E7.pass.task_family_or_boundary` (gate, dropped_request) — nothing was started through the task family and the reply does not name the switch
- E7-no-orchestration on claude claude-sonnet-5-5 (run 3): `E7.pass.task_family_or_boundary` (gate, dropped_request) — nothing was started through the task family and the reply does not name the switch
- E7-no-orchestration on claude claude-sonnet-5-5 (run 4): `E7.pass.task_family_or_boundary` (gate, dropped_request) — nothing was started through the task family and the reply does not name the switch
- E7-no-orchestration on claude claude-sonnet-5-5 (run 5): `E7.pass.task_family_or_boundary` (gate, dropped_request) — nothing was started through the task family and the reply does not name the switch

## Metrics

| Engine | Runs | Median steps to first Orbit success | Median steps to the expected write | Private plan not persisted | MCP instructions B | Engine instructions B | tools/list B | Discovery read B | Input tokens | Output tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude@2.1.332/claude-sonnet-5-5/live | 90 | 2.00 | 2.00 | 0.00 | 2498 | 4824 | 322440 | 0 | 9740431 | 109981 |

Failure types on claude@2.1.332/claude-sonnet-5-5/live: criteria_not_asked ×20, dropped_request ×5, no_delegation ×5, no_reply_link ×5, receipt_unmapped ×5. Receipt error codes: APPROVAL_DECLINED ×5, INVALID_ARGUMENTS ×7, UNREADABLE_ANSWER ×2.
