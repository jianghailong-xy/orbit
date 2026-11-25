# Orbit agent-contract eval

Generated 2026-11-25T00:19:05Z from `0d76239a563e13eb5ef6880d17113399582c681f` (orbit dev). Contract 1.15.0, primer 1.8.1, catalogue 1.12.0 (`2a944eb94f2a`), guide 1.1.0. Suite `618102002bfd`, 30 scenarios.

**Gate: FAIL.** 100 runs: 73 passed, 27 failed, 0 harness errors.

- I4-reply-file-link | claude/claude-sonnet-5-5/live passed 1 of 10 graded runs, under 2/3
- I6-progress-report | claude/claude-sonnet-5-5/live passed 1 of 10 graded runs, under 2/3
- I7-wiki-path-search | claude/claude-sonnet-5-5/live passed 1 of 10 graded runs, under 2/3
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
| I1-wait-await | PASS 10/10 |
| I2-notify-when-done | PASS 10/10 |
| I3-delegate-subagent | PASS 10/10 |
| I3-delegate-subagent/background | PASS 10/10 |
| I4-reply-file-link | FAIL 1/10 |
| I5-evidence-file-upload | PASS 10/10 |
| I6-progress-report | FAIL 1/10 |
| I7-wiki-path-search | FAIL 1/10 |
| I8-settings-propose | PASS 10/10 |
| I9-no-project-for-ordinary-work | PASS 10/10 |

## Failed clauses

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
- I6-progress-report on claude claude-sonnet-5-5 (run 1): `I6.expect.progress` (gate, progress_not_reported) — no progress was reported to Orbit
- I6-progress-report on claude claude-sonnet-5-5 (run 1): `I6.advisory.each_item` (advisory, progress_once) — no progress was reported to Orbit
- I6-progress-report on claude claude-sonnet-5-5 (run 2): `I6.expect.progress` (gate, progress_not_reported) — no progress was reported to Orbit
- I6-progress-report on claude claude-sonnet-5-5 (run 2): `I6.advisory.each_item` (advisory, progress_once) — no progress was reported to Orbit
- I6-progress-report on claude claude-sonnet-5-5 (run 3): `I6.expect.progress` (gate, progress_not_reported) — no progress was reported to Orbit
- I6-progress-report on claude claude-sonnet-5-5 (run 3): `I6.advisory.each_item` (advisory, progress_once) — no progress was reported to Orbit
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
- I7-wiki-path-search on claude claude-sonnet-5-5 (run 2): `I7.expect.searched_by_path` (gate, wiki_not_searched) — the file was changed with no wiki search first
- I7-wiki-path-search on claude claude-sonnet-5-5 (run 2): `I7.advisory.uses_pitfall` (advisory, pitfall_ignored) — neither the change nor the reply takes up the pitfall
- I7-wiki-path-search on claude claude-sonnet-5-5 (run 3): `I7.expect.searched_by_path` (gate, wiki_not_searched) — the file was changed with no wiki search first
- I7-wiki-path-search on claude claude-sonnet-5-5 (run 3): `I7.advisory.uses_pitfall` (advisory, pitfall_ignored) — neither the change nor the reply takes up the pitfall
- I7-wiki-path-search on claude claude-sonnet-5-5 (run 4): `I7.expect.searched_by_path` (gate, wiki_not_searched) — the file was changed with no wiki search first
- I7-wiki-path-search on claude claude-sonnet-5-5 (run 4): `I7.advisory.uses_pitfall` (advisory, pitfall_ignored) — neither the change nor the reply takes up the pitfall
- I7-wiki-path-search on claude claude-sonnet-5-5 (run 5): `I7.expect.searched_by_path` (gate, wiki_not_searched) — the file was changed with no wiki search first
- I7-wiki-path-search on claude claude-sonnet-5-5 (run 5): `I7.advisory.uses_pitfall` (advisory, pitfall_ignored) — neither the change nor the reply takes up the pitfall
- I7-wiki-path-search on claude claude-sonnet-5-5 (run 6): `I7.expect.searched_by_path` (gate, wiki_not_searched) — the file was changed with no wiki search first
- I7-wiki-path-search on claude claude-sonnet-5-5 (run 6): `I7.advisory.uses_pitfall` (advisory, pitfall_ignored) — neither the change nor the reply takes up the pitfall
- I7-wiki-path-search on claude claude-sonnet-5-5 (run 8): `I7.expect.searched_by_path` (gate, wiki_not_searched) — the file was changed with no wiki search first
- I7-wiki-path-search on claude claude-sonnet-5-5 (run 8): `I7.advisory.uses_pitfall` (advisory, pitfall_ignored) — neither the change nor the reply takes up the pitfall
- I7-wiki-path-search on claude claude-sonnet-5-5 (run 9): `I7.expect.searched_by_path` (gate, wiki_not_searched) — the file was changed with no wiki search first
- I7-wiki-path-search on claude claude-sonnet-5-5 (run 9): `I7.advisory.uses_pitfall` (advisory, pitfall_ignored) — neither the change nor the reply takes up the pitfall
- I7-wiki-path-search on claude claude-sonnet-5-5 (run 10): `I7.expect.searched_by_path` (gate, wiki_not_searched) — the file was changed with no wiki search first
- I7-wiki-path-search on claude claude-sonnet-5-5 (run 10): `I7.advisory.uses_pitfall` (advisory, pitfall_ignored) — neither the change nor the reply takes up the pitfall

## Metrics

| Engine | Runs | Median steps to first Orbit success | Median steps to the expected write | Private plan not persisted | MCP instructions B | Engine instructions B | tools/list B | Discovery read B | Input tokens | Output tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude@2.1.331/claude-sonnet-5-5/live | 100 | 2.00 | 3.00 | — | 2498 | 4821 | 322334 | 0 | 9112993 | 86498 |

Failure types on claude@2.1.331/claude-sonnet-5-5/live: copy_in_checkout ×9, pitfall_ignored ×9, progress_not_reported ×9, progress_once ×9, unreachable_link ×9, wiki_not_searched ×9. Receipt error codes: INVALID_ARGUMENTS ×5, UNREADABLE_ANSWER ×1.
