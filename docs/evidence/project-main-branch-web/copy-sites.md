# The project page's remaining "main" copy, by the project's main branch

Task 34cjZa1LTksTyhej32E6v (project 34cjQN5ynG6eIH5A0neeu, criterion 4). Base: project tip
7217e3402. Every line below is where `git grep -n '\bmain\b'` found "main" in a non-test
`src/web/src` source at the base (comments, fixtures and wiki excluded at the end), with what it
says now. For a project on `main` every sentence reads word for word as before: each constant that
OrbitKit's parity tests read keeps its literal declaration, and each function, at main, says it.
The branch is always taken from a read the component (or the page it sits on) already holds, and
is `main` where none carries it.

## Changed: named by the project's main branch

| Before (file:line at 7217e3402) | Now | Branch taken from |
|---|---|---|
| `components/ProjectPanoramaHeader.tsx:206` `footnote: 'not on main yet'` | `` `not on ${main} yet` `` in `integrationLanes(buckets, line, main)` | the header's integration read (`mainBranchName(integration.data?.upstreamRef)` → `ProjectPanoramaCard mainBranch`); the public share page carries none → main |
| `components/ProjectPanoramaHeader.tsx:212` `label: 'On main'`, `footnote: 'landed on main'` | `` `On ${main}` ``, `` `landed on ${main}` `` | same |
| `components/ProjectPanoramaHeader.tsx:282` `LAND_PROMOTION: 'Merge to main'` | constant kept; `jobWords(main)` says `` `Merge to ${main}` ``, used by `landingLine` / `landingJobLines` | the view they draw (`view.upstreamRef`): project page header, sessions-page landing line, merge card line |
| `components/ProjectPanoramaHeader.tsx:300` `MAIN_SYNC: 'syncing main'` (not in the task's list) | constant kept; `jobPhases(main)` says `` `syncing ${main}` ``, used by `liveLine`, `landingJobLines` ("stopped at"), `LandTaskStatus`, `promotionBlockedBy` | `view.upstreamRef`, `promotion.upstreamRef`, the integration row's `main` |
| `components/ProjectPromotionCard.tsx:79` `MERGE_TO_MAIN = 'Merge to main'` | constant kept; `mergeTo(main)`; the card's press and `ProjectMergeStrip.tsx:166`'s press say `mergeTo(mainBranchName(promotion.upstreamRef))` | `promotion.upstreamRef` |
| `components/ProjectPromotionCard.tsx:98` `MERGED_HEADING`, `:102` `MERGED_AUTOMATICALLY_HEADING` | constants kept; `mergedHeading(main)`, `mergedAutomaticallyHeading(main)` in `promotionHeading` | `promotion.upstreamRef` |
| `components/ProjectPromotionCard.tsx:169,272,359,422,425,472,530,577` and `lib/projectMerge.ts:78,115,128,187,193,198,241,255,266` `shortRef(promotion.upstreamRef)` | one way: `mainBranchName(promotion.upstreamRef)` (`shortRef` stays for `sourceRef` and the branch comparison at `projectMerge.ts:162`) | `promotion.upstreamRef` |
| `components/ProjectAcceptanceCard.tsx:199` `LANDED: 'on main'` | record kept; `landingSentence` says `` `on ${main}` `` | the project document the card reads (`integration.upstreamRef`); public page → main |
| `components/ProjectAcceptanceCard.tsx:217` `tail: 'not on main yet'` | `` tail: `not on ${main} yet` `` | same |
| `components/ProjectShareControls.tsx:42,43` `LANDED: 'on main'`, `ON_INTEGRATION_LINE: '… not on main yet'` | record kept; `landingWords(landing, main)` | the project document the page holds (`project.integration.upstreamRef`) |
| `lib/projectDone.ts:36` `WHY_NOT_DONE_ON_MAIN` | constant kept; `whyNotDoneOn(main)` in `projectWhyNotDoneTally(derivedDone, main)` | the done cards' project document (`integration.upstreamRef`) |
| `lib/projectDone.ts:44` `WHY_NOT_DONE_WAITING_DETAIL` | constant kept; `whyNotDoneWaitingDetail(main)` | same |
| `lib/projectDone.ts:45` `WHY_NOT_DONE_NEEDS_CALL_DETAIL` (not in the list) | constant kept; `whyNotDoneNeedsCallDetail(main)` | same |
| `lib/projectDone.ts:103` `landedOnMain: 'landed on main'` (not in the list) | kept; `landedOn(main)` in the three tallies | same |
| `lib/projectDone.ts:323` `default: return 'Landed on main'` (not in the list) | `` `Landed on ${main}` `` (`landingReasonLabel(reason, main)`) | same |
| `components/ProjectSettlementCard.tsx:881` `` `Orbit cannot prove this criterion is on main: ${reason}.` `` | `` `… is on ${main}: ${reason}.` `` | same |
| `components/ProjectProgressStatus.tsx:1086` `'the re-check of the merge into main'`, `:1105` `'… passed'` | `` `the re-check of the merge into ${main}` `` / `` `… passed` `` | project page: `ProjectOpenItems` reads the integration under the page's own key; coordinator conversation: WorkspaceView's promotion reads (`currentPromotion` / `mergedPromotions` `upstreamRef`) → `ItemAsCard main`; the promotion card's chat context: `promotion.upstreamRef` |
| `lib/sessionProjects.ts:88` `'Directly into main'` | `runLineMain(main)`, `main = mainBranchName(settings.upstreamRef)` by default | sessions page start row: `startMainBranch(settings.upstreamRef, integration)` (the read its landing line beside it holds) |
| `lib/projectStart.ts:539` `RUN_LINE_MAIN` in `runSettingsParts` (Project started card) | `runLineMain(mainBranchName(settings.upstreamRef))` | the settings the start recorded; `lib/projectStarted.ts` now carries their `upstreamRef` (it dropped it) |
| `lib/projectStart.ts:460` `runLineInSentence(settings.line)` in `startRequestSummary` | `runLineInSentence(settings.line, main)` | Open items' start row: `startMainBranch(settings.upstreamRef, integration)` — the branch the start card opens with |
| `components/LandTaskStatus.tsx:62` `label: 'On main'`, `:139` `… on {… 'main' …} by an existing receipt` (not in the list) | `` `On ${main}` ``, `{main}` | `ProjectIntegrationLine` passes its `mainBranchName(view.upstreamRef)` |

## Not changed, and why

| Line (at 7217e3402) | Why it still says main |
|---|---|
| `components/OwnerConfirmationCard.tsx:228,229,231,232` (`IF_CONFIRMED_*`) | Its read (`GET /tasks/:id/owner-confirmation`, `ifConfirmed`) carries no project main branch, and its host (the task's own session) reads none; the card issues no other request (its tests assert so). Main, by the task's rule. The server already judges `onMain` against the upstream, so naming it here needs the branch in `ifConfirmed`. |
| `lib/projectAttention.ts:445` `'Needs you · Approve merge to main'` | The projects list row (`ProjectListAttention`, `ProjectListIntegration`) carries no main branch. `:369` `'approve-merge-to-main'` is a key, not copy. |
| `components/WorkspaceView.tsx:1079` `OWNER_ITEM_APPROVE_MERGE` | The session row's `ownerItems` carry no main branch. |
| `components/ApprovalPanel.tsx:660` "every merge into main are checked as before" | The skip-merge-check approval's input (project/task title, command, failure, reason) names no branch. |
| `lib/sessionProjects.ts:134,137` (`JOB_WORDS` / `JOB_PHASES` in the session list's project row) | `ProjectListIntegration` carries no main branch. |
| `components/TaskDetailPanel.tsx:1188,1520` (`landingBadge`, `LandTaskStatus` on the task page) | The task read (`TaskIntegrationView`) carries none; on the project page's integration row the same component names it. |
| `components/ProjectProgressStatus.tsx` `openItemChatContext` → `itemStandingLine(row, now)` | Agent-facing chat context built from the row alone. |
| `pages/ProjectsPage.tsx:2180`, `components/ProjectIntegrationLine.tsx:135,147,157,164` | Already named by the branch (previous task). |
| `lib/projectStart.ts:166–498`, `components/ProjectRunSettings.tsx`, `components/StartProjectCard.tsx` | The settings band's 18 sentences (previous task); `runLineLocked` keeps its words for a project with no Main branch row by design. |
| `components/SessionOutputs.tsx:179–600`, `lib/sessionFolders.ts:255`, `components/WorkspaceView.tsx:3017` | A session's own merge target, not the project's main branch. |
| `lib/openItemDelivery.ts:108,109` | Fallback when a delivery's landing names no upstream; the card prints the server's `landing.upstream`. |
| `lib/wiki.ts:305,329`, `lib/wikiPlan.ts:905`, `lib/wikiReviewMode.ts:474` | Wiki anchor checks — excluded by the task. |
| Comments and JSX comments (e.g. `ProjectPromotionCard.tsx:309`, `ProjectRunSettings.tsx:398`, `WorkspaceView.tsx:10444`, `ProjectsPage.tsx:1184`) | Excluded by the task. |
| `components/ui/__fixtures__/ControlsFixture.tsx:168,169`, `ToastsFixture.tsx:29,30`, `*.fixtures.ts` | Component-gallery and test fixtures, not product copy. |

## Tests: each changed line at master, and at main as before

`src/web` vitest, new cases (all green):

| Where | Test |
|---|---|
| Work overview lanes, landing row and list (`jobWords`, `jobPhases`) | `ProjectPanoramaHeader.test.tsx` › "the project’s main branch, by name" (4) |
| Landing status badge, receipt line, "stopped while syncing" | `LandTaskStatus.test.tsx` › "where a landing’s work is, by the project’s main branch" (2); `ProjectIntegrationLine.test.tsx` › "says where a current landing’s receipt put its work on the project’s main branch" |
| Merge press, both receipt headings, rows; sessions-page merge press | `ProjectPromotionCard.test.tsx` › "the merge, by the project’s main branch" (2) |
| `lib/projectMerge.ts`, one way | `projectMerge.test.ts` › "the branch a merge goes into, named one way" (2), "says which branch a landing in front of it is syncing" |
| Re-check of the merge into main (cards, standing line, Open items row) | `ProjectProgressStatus.handling.test.tsx` › "the merge a re-check is of, by the project’s main branch" (2) |
| Start request row (Open items) | `ProjectProgressStatus.test.tsx` › "says directly into the main branch the start card opens with…" |
| Project started card | `ProjectStartedCard.test.tsx` › "says Directly into the main branch the start recorded…"; `projectStart.mainBranch.test.ts` › "the start’s own lines, by the main branch the start names" (2) |
| Sessions-page start suggestion | `sessionProjects.test.ts` › "says what a start request suggests directly into the main branch it names, main as before"; `WorkspaceView.projectSessions.test.tsx` › "says the suggestion goes directly into the main branch the start card opens with" |
| Conversation exception cards get the branch | `WorkspaceView.exceptionPlacement.test.tsx` › "hands each card the project’s main branch, off the promotion reads the pane already holds" |
| Acceptance criteria landings | `ProjectAcceptanceCard.test.tsx` › "…on where met work landed, by the project’s main branch" (2) |
| Copy as Markdown | `ProjectShareControls.test.tsx` › "Copy as Markdown, by the project’s main branch" (2) |
| Done cards: tallies, reasons, details, gaps, receipt | `ProjectDoneSettlementCard.test.tsx` › "the done cards, by the project’s main branch" (2) |

Whole `src/web` vitest, 4 shards (`--maxWorkers=2`, each in its own capped scope), the same script on
both trees: base 7217e3402 — 401 files, 5208 tests, 0 failed; delivery (tree 9e6fa256e, commit
5e0198641) — 401 files, 5235 tests, 0 failed; failing on the delivery only: none.

## OrbitKit

`swift test` in `swift:6.1` (`ok-run.sh`) on a copy of each tree: base 7217e3402 — 3671 tests, 5
skipped, 0 failures; the delivery's web change before the re-pins — 24 failures, every one a source-
line pin on a line this change rewrote (the constants they read all still match); the delivery
(tree 9e6fa256e) — 3671 tests, 5 skipped, 0 failures.

Re-pinned, test files only, each still holding that a project on main reads the same sentence at
both ends (`onMainBranch`: this end's sentence with `main` put back as `${main}`):

- `ProjectPageCopyParityTests` — the overview lanes that name main, the acceptance tail and landed
  words, and where each takes the branch.
- `ProjectDoneCopyParityTests` — the tallies (`landedOn(main)`, `whyNotDoneOn(main)`), the reason
  label's default, the gaps sentence, the receipt tally, the Why-not-done rows and details.
- `ProjectRunSettingsCopyParityTests` — the request row's `runLineInSentence(settings.line, main)` and
  where Open items takes `main` (`startMainBranch`).
- `SessionProjectCopyParityTests` — the start suggestion's `runLineMain(main)`.
- `ProjectMergeCopyParityTests` — the three sentences that read `shortRef(promotion.upstreamRef)` now
  read `mainBranchName(promotion.upstreamRef)`.

No Android test reads any file this change touches.
