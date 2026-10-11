# iOS / macOS: the Main branch row, the last choice remembered, the copy named by the branch

Task 34cjZa8klRaouPcEIhw3R, project 34cjQN5ynG6eIH5A0neeu, criterion 5 ("iOS / macOS 有同样的 Main branch
行、记住上次选择的提示和标记、锁定后只读、叫分支名的文案，按 owner 认可的 iOS 设计图实现"). Design:
`docs/mocks/project-main-branch/02-ios.png` as the owner approved it on 2026-10-10 (a picker page like
the session's Merge into, and a pick in How it runs written at once). Behaviour and sentences follow
the web on the project branch (`lib/projectStart.ts`, `StartProjectCard.tsx`, `ProjectRunSettings.tsx`,
`MainBranchSelect.tsx`) and the two web copy tasks' site lists
(`docs/evidence/project-main-branch-web/copy-sites.md`, `docs/evidence/project-main-branch-reads/copy-sites.md`).

Base: project tip 29c7132a7. Commits: 64de3575b (OrbitKit models, doors and words), 150409495 (the
SwiftUI row, picker and How it runs), 829c17c86 (the rest of the native project page, merge and done
copy, by the session's helper agent, reviewed and taken whole).

## What the native clients do now

**The read and the doors (OrbitKit).**
- `ProjectIntegrationView` reads `repository`, `branches` (`ProjectBranchCandidates`: names,
  workspaceName, reportedAt), `lastMainBranch` (`ProjectLastMainBranch`: branch, repository, chosenAt)
  and `upstreamChosenAt`, each tolerantly: an older server's absence or a value this build cannot read
  costs only that field, never the integration read.
- `ProjectStartSettings.upstreamRef` (decoded, encoded, and kept by `ProjectStartSettings.parse` for the
  Project started card); `StartProjectRequestBody.upstreamRef` (sent only when the card offered a main
  branch); `UpdateProjectIntegrationRequest.upstreamRef`. `POST /projects/:id/start` and
  `PATCH /projects/:id/integration` carry them through `APIClient.startProject` /
  `updateProjectIntegration`.

**What the start card opens on** — `StartProject.mainBranch(suggested:standing:)`, web's
`startMainBranch`: the project's own choice (`upstreamChosenAt` set) → the owner's last choice for the
repository → the coordinator's suggestion → main. `StartSettingsDraft(settings, standing:)` offers a main
branch (`draft.upstream`) only for a project the integration read says has a repository; nil draws no
row and sends nothing. `StartProject.body` sends `refs/heads/<name>`.

**The row and the picker (OrbitApp).**
- Start card (`StartProjectCard`, both hosts: the coordinator's card in the conversation and the
  project page's own Start…): a Main branch row under Tasks land on, the branch in mono with a chevron,
  "Your last choice for <repo>" under it while it shows the remembered branch, dimmed and dead while
  the card is stale or starting, absent without a repository.
- `MainBranchPicker` (new, shared by both hosts): Cancel, "Main branch", a search field that doubles as
  where a name is typed ("Type a branch name"), "Branches in <workspace>" (or "Type a branch name" when
  the runner reported none), the reported branches + the remembered + the current one each once, the
  current one ticked, the remembered one tagged "last chosen", a typed name git would take offered as
  Use “…”, and the row's sentence at the foot. A half-height sheet on iPhone, a 360×420 sheet on the Mac
  (the Merge into picker's shape). Rows: `RunSettings.branchChoices`; name rule:
  `RunSettings.takesBranchName` (web's `BRANCH_NAME`).
- The conversation's card: `ConsoleModel` reads `GET /projects/:id/integration` before it delivers the
  start card, so the card never opens on main and then moves (web's card waits for the same read); a
  failed read offers no row and the start keeps the project's main branch.
- How it runs (`ProjectsView`): a Main branch setting under Tasks land on, opening the same picker; a
  pick is written at once (`RunSettings.mainBranchWrite` → `PATCH …/integration {upstreamRef}`, only
  while unlocked, only with a repository, only when it moves; a refusal raises the page's "Couldn't do
  that"). Under it: "Tasks start from it, and the project’s work ends up on it. New projects in <repo>
  start with your last choice." Once the line locks, both rows show a lock and the lock sentence moves
  under Main branch with "and its main branch" (`RunSettings.mainBranchLocked`); the line's own
  sentence stays only for a project with no row.

## The copy: every sentence that says where work goes

For a project on `main` every sentence reads word for word as before: each constant the parity tests
read (OrbitKit's of the web, Android's of the Swift) keeps its literal, beside the function that says
it of a branch. `RunSettings.mainBranchName` turns a read's null or absence into main, as web's
`mainBranchName` does.

| Native site | Says (at master) | Branch from |
|---|---|---|
| `RunSettings.lineMain(_:)`, `lineMainHint(_:)` (start card menu, How it runs options, locked label) | Directly into master / Every merge into master asks you. | the card's draft; How it runs: the stored branch (`storedMainBranch`) |
| `RunSettings.automaticHint(_:main:)`, `automaticSays(…main:)` | …merges the branch into master… / You decide … goes into master. … (5 + 2) | same |
| `RunSettings.mergeCheckHint(_:)`, `noMergeCheckWarning(_:)` (card, How it runs, merge check editor) | …again before master. / …merges into master with nothing run… | same |
| `StartProject.mergingInto(_:)`, `eachMergeInto(_:)` (Comes to you) | Merging the branch into master / Each merge into master | the card's draft |
| `RunSettings.pauseHint(_:)`, `pauseFootnote(…main:)` | …merges into master. Running tasks finish. | the stored branch |
| `RunSettings.mainBranchLocked(since:main:)` | …the line it lands on and its main branch can no longer change. Merge it into master… | the stored branch |
| `RunSettings.lineInSentence(_:main:)`, `StartProject.requestSummary(_:main:)`, `RunSettings.undecidedLine(suggested:main:)` | directly into master | Open items row and the line row: `StartProject.mainBranch(suggested:standing:)` off the page's integration read |
| `RunSettings.parts` / `line` (Project started card, the start's receipt) | Directly into master | the settings the start recorded (`upstreamRef`) |
| `ProjectPage.overviewCells(…main:)` | On master / landed on master / not on master yet | the page's integration read |
| `ProjectPage.integrationJobWords(_:)`, `integrationPhaseWords(_:)` via `landingLine`, `landingJobLines`, the job detail | Merge to master / syncing master / stopped at syncing master | the integration view's `upstreamRef` |
| `ProjectPage.integrationFacts` | 3 commits ahead of master … · synced with master 2h ago | same |
| `ProjectPage.criterionWork(…main:)`, `integrationTag` | on master / not on master yet / On master | the project document's integration settings |
| `PromotionCards.mergeTo`, `mergedHeading`, `mergedAutomaticallyHeading`, `nowOnLabel`, and every sentence naming the branch merged into (`title`, `previewTitle`, `branchLine`, `upstreamLine`, `mergingStatusLine`, `blockedLine`, `blockedByLine`, `pageTitle`, `eventLine`, `receiptLine`, `timelineTitle`) | Merge to master / ✓ Merged into master (automatically) / Now on master | `promotion.upstreamRef` (`shortRef` kept for the source branch and the comparison) |
| `OwnerConfirmations.notOn`, `noRecordOn`, `lineThenOwner`, `autoMain` (If you confirm) | Not on master yet / No record of this branch on master / … | `ifConfirmed.mainBranch` (new read field) |
| `ProjectDone` tallies, reason label, details, gaps (`on`, `landedOn`, `waitingDetail`, `needsCallDetail`, …) | landed on master / Landed on master / Goes to master after the merge check… / …is on master: … | the project document's integration settings (`ProjectDoneSubject.upstreamRef`) |
| `ProjectAttention` owner-item chip | Needs you · Approve merge to master | `GET /projects` row `mainBranch` (new) |
| `NeedsYouLogic.kindWord(…main:)` (needs-you bar, session row) | Approve merge to master | `ownerItems[].mainBranch` (new) |
| `ShareMarkdown` (Copy as Markdown) | on master / on the project branch · not on master yet | the project document's integration settings |
| `SessionProjectCopy.startSuggestion(…main:)`, `landingLine(…main:)` | Directly into master · Automatic on · 2 at a time / Merge to master · queued · 13m | the sessions page's integration read (`StartProject.mainBranch`); the sidebar row's `mainBranch` |

Web sites with no native counterpart (checked by grep of OrbitKit and OrbitApp): the task page's
landing badge and `LandTaskStatus`, the skip-merge-check approval note, the open items' "re-check of
the merge into main" lines and the agent-facing chat contexts. The public share page keeps main
(share-links design §6). Not changed: Wiki's main, a session's own merge target, machine ids
(`approve-merge-to-main`), code comments.

## Tests

OrbitKit (Linux, `swift:6.1`):
- `ProjectMainBranchTests` (21): the read's four facts and their tolerance; the initial order; the
  draft's row only with a repository; Start's `upstreamRef` (and none without a row); the settings'
  `upstreamRef` through decode, parse and the default rule; the settings band's 16 sentences word for
  word at main and naming master everywhere else (the lock sentence's added half the one allowed
  change); Comes to you, the Project started line, the request row, the undecided line, Pause; the
  picker's rows (order, once each, tick, tag, filter, Use “…”, names git refuses, no branches reported);
  the "Your last choice" note; How it runs' stored branch, sentence, lock and the write it makes.
- `ProjectMainBranchCopyParityTests` (5): the row's words declared by the web, every branch-named
  sentence against the web template (`${main}`), the order the card opens on, the picker's list rule and
  name regex, and How it runs' rules, all read off the web sources.
- `ProjectMainBranchSitesCopyParityTests` (12) and 11 site cases in the areas' own test files: each
  rest-of-page function against its web template and, at main, its constant.
- Wiring re-pins and additions: `StartProjectWiringTests`, `ProjectsWiringTests`,
  `ProjectDoneWiringTests`, `SessionProjectPageWiringTests` (the row, the picker, the console's read
  before delivery, the sheet's write, the moved lock sentence, the branch passed at each site).

Runs (`/mnt/data/mb-ios/bin/okx.sh`: `swift test` in `swift:6.1` on a copy of the tree):

| Tree | Executed | Skipped | Failed |
|---|---|---|---|
| base 29c7132a7 (`git archive`) | 3671 | 5 | 0 |
| delivery 829c17c86 | 3722 | 5 | 0 |
| delivery merged with project tip bb868f1b1 (merge tree 428087dc7) | 3722 | 5 | 0 |

No failure on any tree, so there is no main baseline to subtract.

CI (GitHub Actions, the push-triggered probe branch `probe/main-branch-native`, whose workflow is
client.yml's own jobs plus the shots; `probe-harness/client.probe.yml`):

| Run | Probe commit (on) | Gates | Shots |
|---|---|---|---|
| [38070260817](https://github.com/jianghailong-xy/orbit/actions/runs/38070260817) | 565516536 (150409495) | all green | iPhone and Mac drawn; harness lookups to fix, facts row not yet ported |
| [38072105281](https://github.com/jianghailong-xy/orbit/actions/runs/38072105281) | 733ec248d (829c17c86) | all green | iPhone 5/5; Mac 3/5 (Mac-only lookups) |
| [38073816221](https://github.com/jianghailong-xy/orbit/actions/runs/38073816221) | b1ddf3214 (829c17c86) | all green | iPhone 5/5, Mac 5/5 — the pictures below |

On run 38073816221 (macos-15, Xcode 26.3, Swift 6.2.4): `macOS (build + test)` ran OrbitKit `swift test`
on macOS (3722 tests, 5 skipped, 0 failures) and `swift build` of OrbitApp (Build complete);
`iOS (generate + build)` ended `** BUILD SUCCEEDED **`; the base commit's OrbitKit on macOS was 3671
tests, 5 skipped, 0 failures; font-tokens and nav-push passed. `shots/RESULTS.txt` and
`shots/tests.txt` are that run's own record.

## Pictures

`shots/ios` (iPhone 17 Pro simulator, iOS 26) and `shots/mac` (the Mac window, 1024×768) are run
38073816221's, taken by `probe-harness` against its stub (see its README for the four projects and
the conversation). `compare/` puts each board frame beside the iPhone picture of the same state:

| Board 02-ios.png | Comparison | What the picture shows |
|---|---|---|
| ① the coordinator's card | `compare/01-conversation-card.png` | the card in the conversation (C5): Main branch `master ›`, the coordinator's suggestion, no "last choice" line; every sentence says master |
| ⑥ the next project | `compare/06-last-choice.png` | the owner's own Start… on P2: master with "Your last choice for acme/payments-api" |
| ③ the picker | `compare/03-picker.png` | How it runs' picker on P1: Cancel, Main branch, Type a branch name, Branches in payments-api, master ticked |
| ⑦ last chosen | `compare/07-last-chosen.png` | the start card's picker: `master last chosen ✓` |
| ⑤ a typed name | `compare/05-typed.png` | `release/3.0` typed: Use “release/3.0” |
| c, changed | `compare/c-changed.png` | develop picked: the row says develop, the last-choice line is gone, the Automatic sentence says develop |
| ⑬ ⑭ ⑮ | `compare/13-automatic-off.png` | Automatic off: "…when the branch goes into develop.", "Merging the branch into develop", the merge check open "…again before develop." |
| ⑫ | `compare/12-line-menu.png` | Tasks land on's menu: Directly into develop / Every merge into develop asks you. |
| ⑧ ⑨ How it runs | `compare/08-how-it-runs.png` | P1: Directly into master, Main branch master ›, "Tasks start from it… New projects in acme/payments-api start with your last choice.", Automatic names master |
| ⑩ locked | `compare/10-locked.png` | P3: Tasks land on and Main branch both locked, the lock sentence moved under Main branch with "and its main branch" and "Merge it into master" |
| ⑪ the line row | `compare/11-facts.png` | P3's row under the title: "3 commits ahead of master at last measurement · synced with master 2h ago" |
| e, no repository | `compare/e-no-repository.png` | P4's start card: no Main branch row; the sentences say main |

Also in `shots/ios`: `ios-08-picked-develop.png` (How it runs after a pick: develop everywhere),
`ios-09-pause.png` ("Stops new tasks, wake-ups and merges into develop."), `ios-07-started-how-it-runs.png`
(P2 after Start: How it runs stands on develop), `ios-12-directly-into-develop.png` (Each merge into
develop); `shots/mac` has the Mac window for the same states.

What the presses sent, as the stub decoded them (`shots/ios/writes.txt`, `shots/mac/writes.txt`, the
same on both):
- the conversation's Start (P5): `"upstreamRef": "refs/heads/master"` with `"requestId": "I5"` — the
  suggestion, unchanged;
- the own Start… (P2): `"upstreamRef": "refs/heads/develop"`, `"line": "MAIN"`, `"automatic": false` —
  what the card showed;
- How it runs' pick (P1): `PATCH /api/projects/P1/integration {"upstreamRef": "refs/heads/develop"}` —
  the main branch alone, at once.

## Android

Android's parity tests read these Swift files as text. Every literal they hold stays. Five Swift
source lines they pinned now name the branch (the request row's and the undecided line's
`lineInSentence` calls, `lineInSentence` itself, `SessionProjectCopy.startSuggestion`, NeedsYou's merge
approval). The Android task (34cjZaBa8oeCX1YfgZC5I, delivery on `orbit/task-android-main-branch-f14658`)
moved three of those pins onto the web source, shortened the two `lineInSentence` call pins to prefixes
these lines still contain, and exempts the new Main branch words from its Swift check. Checked by
emulating its tests' `contains` checks against this branch's Swift: every pin it keeps holds, so the two
deliveries hold in either landing order. Before it lands, its five old pins read red against this Swift
(nothing runs the Android suite on this project's line or on main).
