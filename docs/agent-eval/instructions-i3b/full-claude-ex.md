# Orbit agent-contract eval

Generated 2026-11-25T00:10:53Z from `0d76239a563e13eb5ef6880d17113399582c681f` (orbit dev). Contract 1.15.0, primer 1.8.1, catalogue 1.12.0 (`2a944eb94f2a`), guide 1.1.0. Suite `618102002bfd`, 30 scenarios.

**Gate: FAIL.** 90 runs: 79 passed, 11 failed, 0 harness errors.

- E6-immediate-delegation | claude/claude-sonnet-5-5/live passed 0 of 5 graded runs, under 2/3
- E7-no-orchestration | claude/claude-sonnet-5-5/live passed 0 of 5 graded runs, under 2/3
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
- notice: claude 2.1.331 is not in the supported matrix: this report is the measurement that would add it
- notice: not applicable: E1-record-task/bypassPermissions on claude, because this runner is root, and a root runner does not offer bypassPermissions to Claude Code (permission_modes.go)
- notice: not applicable: X1-mcp-missing-cli-fallback on claude, because Claude Code runs no turn without Orbit's MCP server: the session's --permission-prompt-tool is Orbit's permission_prompt, and Claude Code 2.1.325 exits when the server that serves it did not start

## Matrix

| Engine | Version | Model | Backend | Supported |
| --- | --- | --- | --- | --- |
| claude | 2.1.331 | claude-sonnet-5-5 | live | false |

## Scenarios

| Scenario | claude claude-sonnet-5-5 |
| --- | --- |
| E1-record-task | PASS 5/5 |
| E1-record-task/acceptEdits | PASS 5/5 |
| E1-record-task/dontAsk | PASS 5/5 |
| E1-record-task/auto | PASS 5/5 |
| E1-record-task/bypassPermissions | n/a |
| E2-private-plan | PASS 4/5 |
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
- E2-private-plan on claude claude-sonnet-5-5 (run 1): `E2.t2.persisted` (gate, plan_not_persisted) — the plan was not written as one batch or one project
- E2-private-plan on claude claude-sonnet-5-5 (run 1): `E2.t2.edges` (gate, untracked_order) — no task of the plan depends on another
- E2-private-plan on claude claude-sonnet-5-5 (run 1): `E2.t2.reply_links` (gate, no_reply_link) — the reply links none of the tasks it filed, nor a project it created for them
- E2-private-plan on claude claude-sonnet-5-5 (run 1): `E2.advisory.every_item_persisted` (advisory, private_plan_not_persisted) — 0 of 5 planned steps became tasks
- E2-private-plan on claude claude-sonnet-5-5 (run 1): `E2.advisory.says_before_write` (advisory, unannounced_write) — no write in the turn
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
- E8-compaction-recovery on claude claude-sonnet-5-5 (run 5): `E8.advisory.reads_project` (advisory, no_reread_after_compaction) — the project was not read after the reset

## Metrics

| Engine | Runs | Median steps to first Orbit success | Median steps to the expected write | Private plan not persisted | MCP instructions B | Engine instructions B | tools/list B | Discovery read B | Input tokens | Output tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude@2.1.331/claude-sonnet-5-5/live | 90 | 2.00 | 2.00 | 0.20 | 2498 | 4821 | 322334 | 0 | 9616039 | 107050 |

Failure types on claude@2.1.331/claude-sonnet-5-5/live: criteria_not_asked ×20, dropped_request ×5, no_delegation ×5, no_reply_link ×6, no_reread_after_compaction ×1, plan_not_persisted ×1, private_plan_not_persisted ×1, receipt_unmapped ×5, unannounced_write ×1, untracked_order ×1. Receipt error codes: APPROVAL_DECLINED ×5, INVALID_ARGUMENTS ×12.
