# Web, revision 42 part two: captures against the ruled board

Captures: `*-light.png` and `*-dark.png` in this directory, from `rig/capture.mjs` (built `src/web/dist`, the repo's
ui-migration fixtures, each scene's reads layered over them; run `unshare -n rig/run-ns.sh`). The reads carry exactly the
fields the server's read models carry. Board: `docs/mocks/landing-measured/` (rulings D1–D9, all "as recommended").

## ① Start card with no line (`start-no-line`; board 01 d)
Matches: the line and landing-check rows are gone; one tinted line *Lands on the project’s branch when a task commits*;
Merge check row kept (D8); At most; Automatic. The press sends no `line` key (unit test; the rig's recorded write for
the press is in the capture log).
Differences: the card is the in-conversation card (Done when, Plan graph, Comes to you, Chat about this), not the mock's
simplified dialog; Automatic is the first row, as today's card has it, where the mock lists it last; the sentence
under Automatic still names main ("merges into main by itself") because that copy is not line-aware; no Main branch
row, as on the board.

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
the real web page does not have. The landing's check list showing `Landing check · Skipped` / `Exempt: <reason>` is
covered by a rendered unit test (`ProjectLandingsWindow.test.tsx`, fixture LANDING_CHECK skipped TASK_EXEMPT); a browser
capture of it was not obtained (the landing session route did not draw from the fixture reads), and the mock's third row
*Merge check before main · Still runs* is not drawn.

## ⑤ Coordinator's change list and Revert (`changes-list`, `changes-confirm`, `changes-reverted`; board 05 e, f)
Matches: Setting, change (old struck → new), reason, who + when, Revert only on rows the server marks `revertible`,
`Your change · nothing to revert` on the owner's row, confirm dialog with the consequence sentence, the reverted row
reading `Reverted by you · 1m ago · coordinator needs a card for this field` with no Revert.
Differences: the list opens inline under the Settings row (`3 changes ›`) instead of as a full page, and each change is
a stacked card (the block is half-width) rather than the mock's four-column table; a task's change links to the task
(`Open task`) because the server's change record carries `taskId` but no task title.
