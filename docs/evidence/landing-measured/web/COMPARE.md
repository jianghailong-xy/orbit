# Web, revision 42 part two: captures against the ruled board

Two sets of captures, both from the built `src/web/dist`:
- `real-*.png`: the **real apiserver** of this branch (merged with the project tip) on a throwaway Postgres, seeded through
  the real services; `real/` holds the rig (`setup.sh`, `run-api.sh`, `gateway.mjs`, `seed.cjs`, `capture.mjs`, `run.sh`).
  Every read is the server's and every write goes to it, and the rows it left are read back with SELECTs.
- `*-light.png` / `*-dark.png`: `rig/capture.mjs`, the repo's ui-migration fixtures with each scene's reads layered over them
  (the remaining light/dark variants, and the landing check list, whose real landing needs a runner). Board: `docs/mocks/landing-measured/` (rulings D1–D9, all "as recommended").

## ① Start card with no line (`start-no-line`; board 01 d)
Real stack (`real-start-no-line-light.png`): the request was filed with no line in a workspace whose `repo_url` is set; before
the press `project_codebase` has 0 rows for the project and `started_at` is null; the press POSTs `/api/projects/:id/start`
with `{criteriaDigest, automatic, maxConcurrentTasks, mergeCheckCommand, mergeCheckTimeoutSeconds, requestId}` and no `line`;
after it `started_at` is set and `project_codebase` still has 0 rows.
Matches: the line and landing-check rows are gone; one tinted line *Lands on the project’s branch when a task commits*;
Merge check row kept (D8); At most; Automatic. The press sends no `line` key (unit test; the rig's recorded write for
the press is in the capture log).
Differences: the card is the in-conversation card (Done when, Plan graph, Comes to you, Chat about this), not the mock's
simplified dialog; Automatic is the first row, as today's card has it, where the mock lists it last; the sentence
under Automatic and the Comes-to-you list name no branch for a request with no line ("The coordinator decides when each
task is done."); no Main branch row, as on the board.

## ② Started project with no line (`page-no-line` vs `page-with-line`; board 02 d)
Matches: no Landing card under the progress card, no Landings row; the Coordinator group then the timeline.
Differences: the real page also carries the title bar, workspace list and column chrome; I did not touch the task rows'
landing segment (the web task rows never drew the iPhone's Work · Accepted · Landing segment); the Work overview's
Landings row of the mock does not exist in the real web.

## ③ Landing check with who set it (`settings-coordinator|you|card|start|no-check`; board 03 e)
Matches: three-way switch Merge check · Command · No check; badge + `set 12m ago` under the command; the four
origins draw You / Coordinator / Approved on a card / Set at start; No check states its consequence and lists who can
set it (the mock's phone c).
Differences: the real settings block is the two-column How it runs card (the mock redrew a one-column Settings page);
the switch is the house Segmented control, not the mock's pill; the timeout row stays under Command and Merge check
and is hidden under No check; the mock's "The same field, in its other states" strip is a demonstration, not a screen.

## ④ A task's exemption (`task-exempt`; board 04 d)
Matches: the task page's Landing section carries a Landing check row with Exempt, the reason, Coordinator + `marked 20m
ago`, and Remove exemption.
Differences: the row sits under the landing facts instead of inside the mock's two-column Line/Acceptance grid, which
the real web page does not have. Real stack (`real-task-exempt-*.png`): the page is drawn from the real `GET /api/tasks/:id`,
which returns `landingCheckExempt: true` and the reason; the Coordinator badge and `marked …` come from the project's
`settingChanges`. The landing's check list (`landing-skipped-*.png`, fixture reads, the landing window) draws
`Landing check · Skipped` / `Exempt: <reason>` with the amber arrow, not a failed mark; the mock's third row *Merge check
before main · Still runs* is not drawn.

## Settings: the Delivers hints (P-M3)
The server stores the non-code mark and reads it nowhere (`UpdateProjectDto.nonCode`: accepted, stored, no effect;
`DoneState.nonCode` is always false). Both hints were false and are corrected: Code — *The default. Landing follows the
commits each task delivers.*; Not code — *A label only: Orbit no longer reads it. Landing follows the commits each task
delivers.* The control stays. Left as it was: with the mark set, this block still collapses its integration rows into a
"Landing · Off" line, and the native clients carry the old hint words — both are follow-ups, not part of this task.

## ⑤ Coordinator's change list and Revert (`changes-list`, `changes-confirm`, `changes-reverted`; board 05 e, f)
Real stack (`real-changes-*.png`): the coordinator's two cardless landing-check writes and one exemption were made through
the real services; the list is the server's `settingChanges`. One Revert press POSTed
`/api/projects/:id/setting-changes/:id/revert`; the server wrote an OWNER row naming the reverted change
(`LANDING_CHECK | OWNER | reverts … | none:true → npm run check:landing`) and `project_codebase` reads
`npm run check:landing | none false | set by OWNER`.
Matches: Setting, change (old struck → new), reason, who + when, Revert only on rows the server marks `revertible`,
`Your change · nothing to revert` on the owner's row, confirm dialog with the consequence sentence, the reverted row
reading `Reverted by you · 1m ago · coordinator needs a card for this field` with no Revert.
Differences: the list opens inline under the Settings row (`3 changes ›`) instead of as a full page, and each change is
a stacked card (the block is half-width) rather than the mock's four-column table; a task's change links to the task
(`Open task`) because the server's change record carries `taskId` but no task title.
