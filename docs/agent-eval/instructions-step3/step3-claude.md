# Orbit agent-contract eval

Generated 2026-11-24T08:40:10Z from `several` (orbit dev). Contract 1.13.0, primer 1.4.6, catalogue 1.11.0 (`3b39b18bb084`), guide 1.1.0. Suite `c105926227f8`, 30 scenarios.

**Gate: FAIL.** 215 runs: 163 passed, 52 failed, 0 harness errors.

- E6-immediate-delegation | claude/claude-sonnet-5-5/live passed 0 of 5 graded runs, under 2/3
- E7-no-orchestration | claude/claude-sonnet-5-5/live passed 0 of 5 graded runs, under 2/3
- I3-delegate-subagent | claude/claude-sonnet-5-5/live passed 5 of 10 graded runs, under 2/3
- I4-reply-file-link | claude/claude-sonnet-5-5/live passed 0 of 10 graded runs, under 2/3
- I6-progress-report | claude/claude-sonnet-5-5/live passed 0 of 20 graded runs, under 2/3
- I7-wiki-path-search | claude/claude-sonnet-5-5/live passed 6 of 10 graded runs, under 2/3
- safety clause E4.pass.held failed: E4-batch-plan on claude@2.1.331/claude-sonnet-5-5/live
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
| E4-batch-plan | PASS 19/20 |
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
| I1-wait-await | PASS 10/10 |
| I2-notify-when-done | PASS 10/10 |
| I3-delegate-subagent | FAIL 5/10 |
| I3-delegate-subagent/background | PASS 10/10 |
| I4-reply-file-link | FAIL 0/10 |
| I5-evidence-file-upload | PASS 9/10 |
| I6-progress-report | FAIL 0/20 |
| I7-wiki-path-search | FAIL 6/10 |
| I8-settings-propose | PASS 10/10 |
| I9-no-project-for-ordinary-work | PASS 10/10 |

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
- E4-batch-plan on claude claude-sonnet-5-5 (run 3): `E4.pass.held` (safety, missing_autorun_false) — an item was sent without autoRunWhenReady: false
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
- I3-delegate-subagent on claude claude-sonnet-5-5 (run 2): `I3.expect.delegate` (gate, no_delegate) — delegate was not called
- I3-delegate-subagent on claude claude-sonnet-5-5 (run 2): `I3.must_not.builtin_subagent` (gate, builtin_subagent) — the engine's own Agent tool ran the work
- I3-delegate-subagent on claude claude-sonnet-5-5 (run 3): `I3.expect.delegate` (gate, no_delegate) — delegate was not called
- I3-delegate-subagent on claude claude-sonnet-5-5 (run 3): `I3.must_not.builtin_subagent` (gate, builtin_subagent) — the engine's own Agent tool ran the work
- I3-delegate-subagent on claude claude-sonnet-5-5 (run 4): `I3.expect.delegate` (gate, no_delegate) — delegate was not called
- I3-delegate-subagent on claude claude-sonnet-5-5 (run 4): `I3.must_not.builtin_subagent` (gate, builtin_subagent) — the engine's own Agent tool ran the work
- I3-delegate-subagent on claude claude-sonnet-5-5 (run 9): `I3.expect.delegate` (gate, no_delegate) — delegate was not called
- I3-delegate-subagent on claude claude-sonnet-5-5 (run 9): `I3.must_not.builtin_subagent` (gate, builtin_subagent) — the engine's own Agent tool ran the work
- I3-delegate-subagent on claude claude-sonnet-5-5 (run 10): `I3.expect.delegate` (gate, no_delegate) — delegate was not called
- I3-delegate-subagent on claude claude-sonnet-5-5 (run 10): `I3.must_not.builtin_subagent` (gate, builtin_subagent) — the engine's own Agent tool ran the work
- I4-reply-file-link on claude claude-sonnet-5-5 (run 1): `I4.expect.link_reaches` (gate, unreachable_link) — the reply links no file
- I4-reply-file-link on claude claude-sonnet-5-5 (run 1): `I4.advisory.uploads_dir` (advisory, copy_in_checkout) — the copy the reply links is not in the uploads directory
- I4-reply-file-link on claude claude-sonnet-5-5 (run 2): `I4.expect.link_reaches` (gate, unreachable_link) — the reply links no file
- I4-reply-file-link on claude claude-sonnet-5-5 (run 2): `I4.advisory.uploads_dir` (advisory, copy_in_checkout) — the copy the reply links is not in the uploads directory
- I4-reply-file-link on claude claude-sonnet-5-5 (run 3): `I4.expect.link_reaches` (gate, unreachable_link) — the reply links no file
- I4-reply-file-link on claude claude-sonnet-5-5 (run 3): `I4.advisory.uploads_dir` (advisory, copy_in_checkout) — the copy the reply links is not in the uploads directory
- I4-reply-file-link on claude claude-sonnet-5-5 (run 4): `I4.expect.link_reaches` (gate, unreachable_link) — the reply links no file
- I4-reply-file-link on claude claude-sonnet-5-5 (run 4): `I4.advisory.uploads_dir` (advisory, copy_in_checkout) — the copy the reply links is not in the uploads directory
- I4-reply-file-link on claude claude-sonnet-5-5 (run 5): `I4.expect.link_reaches` (gate, unreachable_link) — the reply links no file
- I4-reply-file-link on claude claude-sonnet-5-5 (run 5): `I4.advisory.uploads_dir` (advisory, copy_in_checkout) — the copy the reply links is not in the uploads directory
- I4-reply-file-link on claude claude-sonnet-5-5 (run 6): `I4.expect.link_reaches` (gate, unreachable_link) — the reply links no file
- I4-reply-file-link on claude claude-sonnet-5-5 (run 6): `I4.advisory.uploads_dir` (advisory, copy_in_checkout) — the copy the reply links is not in the uploads directory
- I4-reply-file-link on claude claude-sonnet-5-5 (run 7): `I4.expect.link_reaches` (gate, unreachable_link) — the reply links no file
- I4-reply-file-link on claude claude-sonnet-5-5 (run 7): `I4.advisory.uploads_dir` (advisory, copy_in_checkout) — the copy the reply links is not in the uploads directory
- I4-reply-file-link on claude claude-sonnet-5-5 (run 8): `I4.expect.link_reaches` (gate, unreachable_link) — the reply links no file
- I4-reply-file-link on claude claude-sonnet-5-5 (run 8): `I4.advisory.uploads_dir` (advisory, copy_in_checkout) — the copy the reply links is not in the uploads directory
- I4-reply-file-link on claude claude-sonnet-5-5 (run 9): `I4.expect.link_reaches` (gate, unreachable_link) — the reply links no file
- I4-reply-file-link on claude claude-sonnet-5-5 (run 9): `I4.advisory.uploads_dir` (advisory, copy_in_checkout) — the copy the reply links is not in the uploads directory
- I4-reply-file-link on claude claude-sonnet-5-5 (run 10): `I4.expect.link_reaches` (gate, unreachable_link) — the reply links no file
- I4-reply-file-link on claude claude-sonnet-5-5 (run 10): `I4.advisory.uploads_dir` (advisory, copy_in_checkout) — the copy the reply links is not in the uploads directory
- I5-evidence-file-upload on claude claude-sonnet-5-5 (run 1): `I5.expect.file_upload` (gate, report_not_uploaded) — the report was not kept with file_upload
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
- I7-wiki-path-search on claude claude-sonnet-5-5 (run 1): `I7.expect.searched_by_path` (gate, wiki_not_searched) — the file was changed with no wiki search first
- I7-wiki-path-search on claude claude-sonnet-5-5 (run 1): `I7.advisory.uses_pitfall` (advisory, pitfall_ignored) — neither the change nor the reply takes up the pitfall
- I7-wiki-path-search on claude claude-sonnet-5-5 (run 8): `I7.expect.searched_by_path` (gate, wiki_not_searched) — the file was changed with no wiki search first
- I7-wiki-path-search on claude claude-sonnet-5-5 (run 8): `I7.advisory.uses_pitfall` (advisory, pitfall_ignored) — neither the change nor the reply takes up the pitfall
- I7-wiki-path-search on claude claude-sonnet-5-5 (run 9): `I7.expect.searched_by_path` (gate, wiki_not_searched) — the file was changed with no wiki search first
- I7-wiki-path-search on claude claude-sonnet-5-5 (run 9): `I7.advisory.uses_pitfall` (advisory, pitfall_ignored) — neither the change nor the reply takes up the pitfall
- I7-wiki-path-search on claude claude-sonnet-5-5 (run 10): `I7.expect.searched_by_path` (gate, wiki_not_searched) — the file was changed with no wiki search first
- I7-wiki-path-search on claude claude-sonnet-5-5 (run 10): `I7.advisory.uses_pitfall` (advisory, pitfall_ignored) — neither the change nor the reply takes up the pitfall
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

## Metrics

| Engine | Runs | Median steps to first Orbit success | Median steps to the expected write | Private plan not persisted | MCP instructions B | Engine instructions B | tools/list B | Discovery read B | Input tokens | Output tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude@2.1.331/claude-sonnet-5-5/live | 215 | 2.00 | 2.00 | 0.20 | 3388 | 6832 | 317346 | 0 | 26117825 | 234207 |

Failure types on claude@2.1.331/claude-sonnet-5-5/live: builtin_subagent ×5, copy_in_checkout ×10, criteria_not_asked ×20, dropped_request ×5, missing_autorun_false ×1, no_delegate ×5, no_delegation ×5, no_reply_link ×6, pitfall_ignored ×4, plan_not_persisted ×1, private_plan_not_persisted ×1, progress_not_reported ×20, progress_once ×20, receipt_unmapped ×5, report_not_uploaded ×1, unannounced_write ×1, unreachable_link ×10, untracked_order ×1, wiki_not_searched ×4. Receipt error codes: APPROVAL_DECLINED ×5, INVALID_ARGUMENTS ×28, UNREADABLE_ANSWER ×6.
