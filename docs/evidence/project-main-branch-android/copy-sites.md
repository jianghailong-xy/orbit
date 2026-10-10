# Android: the Main branch row, the last choice, and the copy that names the branch

Task 34cjZaBa8oeCX1YfgZC5I (project 34cjQN5ynG6eIH5A0neeu, criterion 6). Base: project tip 29c7132a7.
Design: docs/mocks/project-main-branch/02-ios.png (owner-approved 2026-10-10), Android's notes a–f.
Behaviour and sentences follow the web (`src/web/src/lib/projectStart.ts`, `MainBranchSelect.tsx`,
`StartProjectCard.tsx`, `ProjectRunSettings.tsx` and the copy sites in
`docs/evidence/project-main-branch-web/copy-sites.md` and `docs/evidence/project-main-branch-reads/copy-sites.md`).
For a project on `main` every sentence reads word for word as before: each constant keeps its
literal, and each new function, at `main`, says its constant.

## Data

| What | Where |
|---|---|
| The integration read's `repository`, `branches` (names, workspaceName, reportedAt), `lastMainBranch` (branch, repository, chosenAt), `upstreamChosenAt`; the branch a project stands on (web's `storedUpstream`) | `projects/ProjectData.kt` `ProjectMainBranch` |
| The start's initial value: this project's own choice → this account's last choice for the repository → the coordinator's suggestion → main (web's `startMainBranch`) | `ProjectPage.kt` `StartProjectCopy.startMainBranch` |
| The draft carries `upstream` (null with no repository, or when the integration read did not answer: no row) | `StartProjectCopy.Draft`, `Draft.of(settings, view)` |
| The coordinator's suggestion and the standing branch reach the card | `StartProjectCopy.request` reads `settings.upstreamRef`; `defaultSettings` carries `view.upstreamRef` as a full ref |
| The start door: `upstreamRef: refs/heads/<name>` whenever the card offered one | `StartProjectCopy.body` (owner's Start…, the sessions page's request sheet); core `ProjectStartSettings.upstreamRef` + `CardRequests` START (the conversation's card; a press with no settings of its own names none) |
| How it runs: `PATCH /projects/:id/integration {upstreamRef}` on pick, nothing when locked or unchanged | `RunSettings.mainBranchWrite` |
| The conversation's card reads the integration with the session while the project is unstarted, and is drawn with it; a failed read draws no row | core `realtime/RealtimeRest.kt` `session()` (`standing["integration"]`), `CoordinatorStartCard` |
| The sessions page's request sheet waits for the integration read too | `ProjectSettings.kt` `RequestedStartSheet` |

## Views

| Where (02-ios Android note) | What |
|---|---|
| a. Start card, under Tasks land on | `StartProjectCard.kt` `MainBranchRow`: Main branch, the value monospaced with ›, "Your last choice for <repo>" while the value is the last choice; dead with the rest when the card is stale or starting; no row without a repository. Used by `OwnerStartSheet`, `RequestedStartSheet` and `CoordinatorStartCard` (and its review sheet) |
| b. The picker | `StartProjectCard.kt` `MainBranchPicker` (reader/WorktreeBar.kt's `MergeTargetPicker` shape): title Main branch + Cancel, a field that also takes a name ("Type a branch name"), "Branches in <workspace>" (or "Type a branch name" with nothing reported), the reported branches + last choice + value once each, the value ✓, the last choice tagged "last chosen", "Use “…”" for a typed name the list lacks and that looks like a branch (the web's rule), "Tasks start from it, and the project’s work ends up on it." under the list |
| c. How it runs | `ProjectSettings.kt` `MainBranchSetting` under `LineSetting`: picked and written at once (no Save), "Tasks start from it, and the project’s work ends up on it. New projects in <repo> start with your last choice."; locked: "🔒 <branch>" and `mainBranchLocked` under it, the line's own lock sentence only for a project with no repository |
| d. The row under the title | `ProjectPage.integrationFacts`: "ahead of <branch>", "synced with <branch>" by `view.upstreamRef` |
| f. Look | TextButton rows, "✓" for the current, "🔒" for locked, Dialog for the picker |

## Copy: every Android site that said main

| Site (base line) | Before | After | Branch from |
|---|---|---|---|
| `ProjectPage.kt:912–913` `RunSettings.lineMain/lineMainHint` | Directly into main / Every merge into main asks you. | constants kept; `lineMain(main)`, `lineMainHint(main)` in the start card's line menu and button, How it runs' option and locked value, the session list's suggestion | the draft's branch / the stored branch |
| `ProjectPage.kt:915–920` `automaticHint*` | merges the branch into main… / Merging into main always asks you… directly on main… | constants kept; `automaticHint(line, main)` | stored branch |
| `ProjectPage.kt:922–933` `automaticOn*/Off*`, `automaticSays` | …merges into main… / …goes into main. | constants kept; `automaticSays(…, main)` | draft |
| `ProjectPage.kt:940,942` `mergeCheckHint`, `noMergeCheckWarning` | …again before main. / …merges into main with nothing run… | constants kept; functions of `main` (start card, How it runs, merge check editor) | draft / stored |
| `ProjectPage.kt:949` `pauseHint` | …merges into main. | constant kept; `pauseHint(main)`, `pauseFootnote(…, main)` | stored |
| `ProjectPage.kt:714–715` `mergingIntoMain`, `eachMergeIntoMain` | Merging the branch into main / Each merge into main | constants kept; `mergingInto(main)`, `eachMergeInto(main)` in `comesToYou(…, main)` | draft |
| `ProjectPage.kt:967` `lineInSentence` | directly into main | `lineInSentence(line, main)` in `requestSummary` (Open items' start row) and `undecidedLine` (the row under the title) | `startMainBranch(settings.upstreamRef, integration)` |
| `ProjectPage.kt:973` `lineLocked` | (unchanged for a project with no Main branch row) | new `mainBranchLocked(since, main)` under Main branch | stored |
| `ProjectPage.kt:74–75` overview lanes | not on main yet / On main / landed on main | `overviewCells(…, main)` | project document's `integration.upstreamRef` |
| `ProjectPage.kt:96–97` job words | Merge to main / syncing main | maps kept; `jobWords(main)`, `phaseWords(main)` in the landing row, its job list and a timed-out job's "stopped at …" | the integration view's `upstreamRef` |
| `ProjectPage.kt:211–212` `criterionWork` | not on main yet / on main | `criterionWork(c, ref, main)` | project document |
| `ProjectPage.kt:366–367` `integrationFacts` | ahead of main / synced with main | named | the view's `upstreamRef` |
| `ProjectPage.kt:1010` `ProjectMarkdown.landingWords` | on main / … not on main yet | map kept; `landingWords(main)` in Copy as Markdown | project document |
| `ProjectDone.kt:42,55,109,131` | on main / landed on main / Landed on main / …is on main: … | constants kept; `on(main)`, `landedOn(main)` in the three tallies, `landingReasonLabel(reason, main)`, the synthetic gap | project document (`ProjectDone.mainBranch`) |
| `ProjectAttention.kt:224` | Needs you · Approve merge to main | `ownerItemSays(item, main)` | `GET /projects` row's `mainBranch` |
| `cards/NeedsYou.kt:115` | Approve merge to main | `kindWord(kind, main)`; `OwnerItem.mainBranch` | `ownerItems[].mainBranch` |
| `directory/SessionProjects.kt:194` | Directly into main · Automatic on · 2 at a time | `startSuggestion(settings, main)` | `startMainBranch(settings.upstreamRef, integration)` on the sessions page |
| `directory/SessionProjects.kt` landing line | Merge to main · syncing main | `landingLine(…, main)` | `GET /projects/sidebar` row's `mainBranch` |
| core `PromotionCards.kt:48,55,57` | Merge to main / ✓ Merged into main (automatically) | constants kept; `mergeTo(main)` (both merge presses, the conversation card's title), `mergedHeading(main)`, `mergedAutomaticallyHeading(main)` | the candidate's `upstreamRef` |
| `cards/PromotionViews.kt:105,165` | Now on main | `nowOn(main)` | the candidate's `upstreamRef` |

Not changed: the wiki's anchor checks; a session's own merge target (`reader/WorktreeBar*`,
`DirectoryActions.kt`); the push kind id `approve-merge-to-main`; comments. Android has no
owner-confirmation "If you confirm" block, no task-page landing badge and no skip-merge-check card,
so the reads' other `mainBranch` fields have no Android site.

## Copy-parity tests

Android's parity tests read OrbitKit's Swift, and the iOS half of the project runs in parallel.
So the new words and every by-branch sentence are held to the web (the reference both clients
follow) by `MainBranchCopyTest`, and the Swift pins on code lines the iOS change rewrites were moved
there or cut at the call (the iOS session 1LjlqEqhttdBp2DPjlfeQb was told which, 2026-10-10 ~16:40Z):

- `StartProjectCardCopyTest`: `RunSettings.lineInSentence(settings.line` and
  `"\(decided) — \(lineSuggested) \(lineInSentence(suggested"` now stop at the call;
  `line == .main ? "directly into main"` moved to the web's `runLineInSentence`;
  `mergeCheckCommand: view?.mergeCheckCommand` without the closing parenthesis.
- `SessionProjectCopyParityTest`: the suggestion's Swift template moved to the web's
  `sessionProjects.ts` (`MainBranchCopyTest.theSessionListsSuggestionIsTheWebs`).
- `SessionLineCopyParityTest`: `promotionApproval` moved to the web's `WorkspaceView.tsx`
  (`OWNER_ITEM_APPROVE_MERGE` and `ownerItemWords`).
- `ProjectCopyParityTest.runSettingsWords`: the five new `RunSettings` words are held to the web
  rather than the Swift until OrbitKit declares them.

Every main-worded constant is still held to its Swift literal.
