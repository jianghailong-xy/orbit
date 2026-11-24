# Orbit agent-contract eval

Generated 2026-11-24T15:21:10Z from `05fb49e208` (orbit dev). Contract 1.13.0, primer 1.6.0, catalogue 1.11.0 (`b063b34e353d`), guide 1.1.0. Suite `618102002bfd`, 30 scenarios.

**Gate: FAIL.** 40 runs: 18 passed, 22 failed, 0 harness errors.

- E6-immediate-delegation | claude/claude-sonnet-5-5/live passed 0 of 10 graded runs, under 2/3
- E7-no-orchestration | claude/claude-sonnet-5-5/live passed 0 of 10 graded runs, under 2/3
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
- not run: E8-compaction-recovery on claude@2.1.331/claude-sonnet-5-5/live
- not run: E8-compaction-recovery/resume on claude@2.1.331/claude-sonnet-5-5/live
- not run: I1-wait-await on claude@2.1.331/claude-sonnet-5-5/live
- not run: I2-notify-when-done on claude@2.1.331/claude-sonnet-5-5/live
- not run: I4-reply-file-link on claude@2.1.331/claude-sonnet-5-5/live
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
| E6-immediate-delegation | FAIL 0/10 |
| E7-no-orchestration | FAIL 0/10 |
| E8-compaction-recovery | — |
| E8-compaction-recovery/resume | — |
| X1-mcp-missing-cli-fallback | — |
| X2-approval-declined | — |
| X3-approval-chat | — |
| X4-lost-answer-retry | — |
| X5-plan-mode-write | — |
| I1-wait-await | — |
| I2-notify-when-done | — |
| I3-delegate-subagent | PASS 8/10 |
| I3-delegate-subagent/background | PASS 10/10 |
| I4-reply-file-link | — |
| I5-evidence-file-upload | — |
| I6-progress-report | — |
| I7-wiki-path-search | — |
| I8-settings-propose | — |
| I9-no-project-for-ordinary-work | — |

## Failed clauses

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
- I3-delegate-subagent on claude claude-sonnet-5-5 (run 5): `I3.expect.delegate` (gate, no_delegate) — delegate was not called
- I3-delegate-subagent on claude claude-sonnet-5-5 (run 5): `I3.must_not.builtin_subagent` (gate, builtin_subagent) — the engine's own Agent tool ran the work
- I3-delegate-subagent on claude claude-sonnet-5-5 (run 9): `I3.expect.delegate` (gate, no_delegate) — delegate was not called
- I3-delegate-subagent on claude claude-sonnet-5-5 (run 9): `I3.must_not.builtin_subagent` (gate, builtin_subagent) — the engine's own Agent tool ran the work

## Metrics

| Engine | Runs | Median steps to first Orbit success | Median steps to the expected write | Private plan not persisted | MCP instructions B | Engine instructions B | tools/list B | Discovery read B | Input tokens | Output tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude@2.1.331/claude-sonnet-5-5/live | 40 | 1.00 | — | — | 2981 | 6740 | 320349 | 0 | 2392400 | 27061 |

Failure types on claude@2.1.331/claude-sonnet-5-5/live: builtin_subagent ×2, dropped_request ×10, no_delegate ×2, no_delegation ×10, no_reply_link ×10, receipt_unmapped ×10. Receipt error codes: none.
