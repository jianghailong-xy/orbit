# Orbit agent-contract eval

Generated 2026-11-24T19:03:10Z from `D` (orbit dev). Contract 1.14.0, primer 1.8.0, catalogue 1.12.0 (`2a944eb94f2a`), guide 1.1.0. Suite `618102002bfd`, 30 scenarios.

**Gate: FAIL.** 110 runs: 83 passed, 27 failed, 0 harness errors.

- E6-immediate-delegation | claude/claude-sonnet-5-5/live passed 0 of 10 graded runs, under 2/3
- E7-no-orchestration | claude/claude-sonnet-5-5/live passed 0 of 10 graded runs, under 2/3
- I4-reply-file-link | claude/claude-sonnet-5-5/live passed 3 of 10 graded runs, under 2/3
- not run: E1-record-task/acceptEdits on claude@2.1.331/claude-sonnet-5-5/live
- not run: E1-record-task/auto on claude@2.1.331/claude-sonnet-5-5/live
- not run: E1-record-task/bypassPermissions on claude@2.1.331/claude-sonnet-5-5/live
- not run: E1-record-task/dontAsk on claude@2.1.331/claude-sonnet-5-5/live
- not run: E2-private-plan on claude@2.1.331/claude-sonnet-5-5/live
- not run: E5-read-only-project on claude@2.1.331/claude-sonnet-5-5/live
- not run: E5-read-only-project/plan on claude@2.1.331/claude-sonnet-5-5/live
- not run: E8-compaction-recovery on claude@2.1.331/claude-sonnet-5-5/live
- not run: E8-compaction-recovery/resume on claude@2.1.331/claude-sonnet-5-5/live
- not run: I1-wait-await on claude@2.1.331/claude-sonnet-5-5/live
- not run: I5-evidence-file-upload on claude@2.1.331/claude-sonnet-5-5/live
- not run: I6-progress-report on claude@2.1.331/claude-sonnet-5-5/live
- not run: I7-wiki-path-search on claude@2.1.331/claude-sonnet-5-5/live
- not run: I8-settings-propose on claude@2.1.331/claude-sonnet-5-5/live
- not run: I9-no-project-for-ordinary-work on claude@2.1.331/claude-sonnet-5-5/live
- not run: X1-mcp-missing-cli-fallback on claude@2.1.331/claude-sonnet-5-5/live
- not run: X2-approval-declined on claude@2.1.331/claude-sonnet-5-5/live
- not run: X3-approval-chat on claude@2.1.331/claude-sonnet-5-5/live
- not run: X5-plan-mode-write on claude@2.1.331/claude-sonnet-5-5/live
- notice: claude 2.1.331 is not in the supported matrix: this report is the measurement that would add it

## Matrix

| Engine | Version | Model | Backend | Supported |
| --- | --- | --- | --- | --- |
| claude | 2.1.331 | claude-sonnet-5-5 | live | false |

## Scenarios

| Scenario | claude claude-sonnet-5-5 |
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
| E6-immediate-delegation | FAIL 0/10 |
| E7-no-orchestration | FAIL 0/10 |
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
| I3-delegate-subagent/background | PASS 10/10 |
| I4-reply-file-link | FAIL 3/10 |
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
- E1-record-task on claude claude-sonnet-5-5 (run 6): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task on claude claude-sonnet-5-5 (run 7): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task on claude claude-sonnet-5-5 (run 8): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task on claude claude-sonnet-5-5 (run 9): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task on claude claude-sonnet-5-5 (run 10): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
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
- E6-immediate-delegation on claude claude-sonnet-5-5 (run 6): `E6.expect.start` (gate, no_delegation) — the recorded task was not started and no session was created
- E6-immediate-delegation on claude claude-sonnet-5-5 (run 6): `E6.pass.session_id` (gate, receipt_unmapped) — no start answered with a session id
- E6-immediate-delegation on claude claude-sonnet-5-5 (run 6): `E6.pass.reply_links` (gate, no_reply_link) — the reply links neither the session nor the task it started
- E6-immediate-delegation on claude claude-sonnet-5-5 (run 7): `E6.expect.start` (gate, no_delegation) — the recorded task was not started and no session was created
- E6-immediate-delegation on claude claude-sonnet-5-5 (run 7): `E6.pass.session_id` (gate, receipt_unmapped) — no start answered with a session id
- E6-immediate-delegation on claude claude-sonnet-5-5 (run 7): `E6.pass.reply_links` (gate, no_reply_link) — the reply links neither the session nor the task it started
- E6-immediate-delegation on claude claude-sonnet-5-5 (run 8): `E6.expect.start` (gate, no_delegation) — the recorded task was not started and no session was created
- E6-immediate-delegation on claude claude-sonnet-5-5 (run 8): `E6.pass.session_id` (gate, receipt_unmapped) — no start answered with a session id
- E6-immediate-delegation on claude claude-sonnet-5-5 (run 8): `E6.pass.reply_links` (gate, no_reply_link) — the reply links neither the session nor the task it started
- E6-immediate-delegation on claude claude-sonnet-5-5 (run 9): `E6.expect.start` (gate, no_delegation) — the recorded task was not started and no session was created
- E6-immediate-delegation on claude claude-sonnet-5-5 (run 9): `E6.pass.session_id` (gate, receipt_unmapped) — no start answered with a session id
- E6-immediate-delegation on claude claude-sonnet-5-5 (run 9): `E6.pass.reply_links` (gate, no_reply_link) — the reply links neither the session nor the task it started
- E6-immediate-delegation on claude claude-sonnet-5-5 (run 10): `E6.expect.start` (gate, no_delegation) — the recorded task was not started and no session was created
- E6-immediate-delegation on claude claude-sonnet-5-5 (run 10): `E6.pass.session_id` (gate, receipt_unmapped) — no start answered with a session id
- E6-immediate-delegation on claude claude-sonnet-5-5 (run 10): `E6.pass.reply_links` (gate, no_reply_link) — the reply links neither the session nor the task it started
- E7-no-orchestration on claude claude-sonnet-5-5 (run 1): `E7.pass.task_family_or_boundary` (gate, dropped_request) — nothing was started through the task family and the reply does not name the switch
- E7-no-orchestration on claude claude-sonnet-5-5 (run 2): `E7.pass.task_family_or_boundary` (gate, dropped_request) — nothing was started through the task family and the reply does not name the switch
- E7-no-orchestration on claude claude-sonnet-5-5 (run 3): `E7.pass.task_family_or_boundary` (gate, dropped_request) — nothing was started through the task family and the reply does not name the switch
- E7-no-orchestration on claude claude-sonnet-5-5 (run 4): `E7.pass.task_family_or_boundary` (gate, dropped_request) — nothing was started through the task family and the reply does not name the switch
- E7-no-orchestration on claude claude-sonnet-5-5 (run 5): `E7.pass.task_family_or_boundary` (gate, dropped_request) — nothing was started through the task family and the reply does not name the switch
- E7-no-orchestration on claude claude-sonnet-5-5 (run 6): `E7.pass.task_family_or_boundary` (gate, dropped_request) — nothing was started through the task family and the reply does not name the switch
- E7-no-orchestration on claude claude-sonnet-5-5 (run 7): `E7.pass.task_family_or_boundary` (gate, dropped_request) — nothing was started through the task family and the reply does not name the switch
- E7-no-orchestration on claude claude-sonnet-5-5 (run 8): `E7.pass.task_family_or_boundary` (gate, dropped_request) — nothing was started through the task family and the reply does not name the switch
- E7-no-orchestration on claude claude-sonnet-5-5 (run 9): `E7.pass.task_family_or_boundary` (gate, dropped_request) — nothing was started through the task family and the reply does not name the switch
- E7-no-orchestration on claude claude-sonnet-5-5 (run 10): `E7.pass.task_family_or_boundary` (gate, dropped_request) — nothing was started through the task family and the reply does not name the switch
- I4-reply-file-link on claude claude-sonnet-5-5 (run 1): `I4.advisory.uploads_dir` (advisory, copy_in_checkout) — the copy the reply links is not in the uploads directory
- I4-reply-file-link on claude claude-sonnet-5-5 (run 2): `I4.expect.link_reaches` (gate, unreachable_link) — the reply links no file
- I4-reply-file-link on claude claude-sonnet-5-5 (run 2): `I4.advisory.uploads_dir` (advisory, copy_in_checkout) — the copy the reply links is not in the uploads directory
- I4-reply-file-link on claude claude-sonnet-5-5 (run 3): `I4.expect.link_reaches` (gate, unreachable_link) — the reply links no file
- I4-reply-file-link on claude claude-sonnet-5-5 (run 3): `I4.advisory.uploads_dir` (advisory, copy_in_checkout) — the copy the reply links is not in the uploads directory
- I4-reply-file-link on claude claude-sonnet-5-5 (run 4): `I4.advisory.uploads_dir` (advisory, copy_in_checkout) — the copy the reply links is not in the uploads directory
- I4-reply-file-link on claude claude-sonnet-5-5 (run 5): `I4.expect.link_reaches` (gate, unreachable_link) — the reply links no file
- I4-reply-file-link on claude claude-sonnet-5-5 (run 5): `I4.advisory.uploads_dir` (advisory, copy_in_checkout) — the copy the reply links is not in the uploads directory
- I4-reply-file-link on claude claude-sonnet-5-5 (run 6): `I4.expect.link_reaches` (gate, unreachable_link) — the reply links no file
- I4-reply-file-link on claude claude-sonnet-5-5 (run 6): `I4.advisory.uploads_dir` (advisory, copy_in_checkout) — the copy the reply links is not in the uploads directory
- I4-reply-file-link on claude claude-sonnet-5-5 (run 7): `I4.expect.link_reaches` (gate, unreachable_link) — the reply links no file
- I4-reply-file-link on claude claude-sonnet-5-5 (run 7): `I4.advisory.uploads_dir` (advisory, copy_in_checkout) — the copy the reply links is not in the uploads directory
- I4-reply-file-link on claude claude-sonnet-5-5 (run 8): `I4.expect.link_reaches` (gate, unreachable_link) — the reply links no file
- I4-reply-file-link on claude claude-sonnet-5-5 (run 8): `I4.advisory.uploads_dir` (advisory, copy_in_checkout) — the copy the reply links is not in the uploads directory
- I4-reply-file-link on claude claude-sonnet-5-5 (run 9): `I4.advisory.uploads_dir` (advisory, copy_in_checkout) — the copy the reply links is not in the uploads directory
- I4-reply-file-link on claude claude-sonnet-5-5 (run 10): `I4.expect.link_reaches` (gate, unreachable_link) — the reply links no file
- I4-reply-file-link on claude claude-sonnet-5-5 (run 10): `I4.advisory.uploads_dir` (advisory, copy_in_checkout) — the copy the reply links is not in the uploads directory

## Metrics

| Engine | Runs | Median steps to first Orbit success | Median steps to the expected write | Private plan not persisted | MCP instructions B | Engine instructions B | tools/list B | Discovery read B | Input tokens | Output tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude@2.1.331/claude-sonnet-5-5/live | 110 | 2.00 | 2.00 | — | 2498 | 5401 | 321998 | 0 | 9096134 | 93212 |

Failure types on claude@2.1.331/claude-sonnet-5-5/live: copy_in_checkout ×10, criteria_not_asked ×10, dropped_request ×10, no_delegation ×10, no_reply_link ×10, receipt_unmapped ×10, unreachable_link ×7. Receipt error codes: INVALID_ARGUMENTS ×2.
