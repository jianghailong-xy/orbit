# A11 · A01 matrix rows → Android Tasks / Projects

Each row of the A01 iOS matrix (comment 34ZdN1qmQAkbScDXLMSTW on task A01) that A11 carries, mapped to the Android page
that carries it, the tests that exercise it, and what they established. Three kinds of evidence, never mixed up:

- **Unit** — JVM tests over the ported OrbitKit rules, copy parity read from the Swift sources, and the HTTP wire.
- **Fixture** — `TasksProjectsDeviceTest` on the API 36 emulator (and API 29) against `scripts/tasks-projects-fixture.py`,
  a controlled server whose final records each journey reads back. Not a deployed server.
- **Stack** — `RealStackDeviceTest` on the API 36 emulator against the isolated Orbit stack (`/var/tmp/a11-stack`: the
  apiserver built from the fixed server SHA's trees — d621e29aa, the same `src/apiserver` and `src/shared` trees as 51bbcc303 —
  its own PostgreSQL, the repo's Go runner with a stand-in engine), seeded only through the real API, signed in through the
  product's sign-in screen with the stack's test accounts (owner and member). Every write is read back from the API as the
  same account and every list is compared with what the API answers; the reads are kept beside the screenshots
  (`<journey>-readback.txt`). Not production, not a physical phone. The stack was removed after the runs; its tooling
  (setup, seeding, verification, the stand-in engine, seed ids with share tokens and test passwords redacted) and its final
  state are kept with the evidence uploads (`a11-stack-tooling/`).

App code is unchanged since 0705c23ad (`git diff 0705c23ad.. -- src/android/app/src/main src/android/core/src/main` is
empty); later commits change only device tests, scripts and docs.

## Runs

| Label | Job | Build | What | Result |
| --- | --- | --- | --- | --- |
| J-red / J-green | bgj_e9a15ad3d241 / bgj_6b78ba4d5e96 | c86cfb185 tests / 0705c23ad | `ReviewRegressionTest` (the two smaller defects: wording; fence key) | red 2/2 for the intended reasons → green |
| RG1 | bgj_b5e51ded7fae | test APK 0705c23ad on app c86cfb185 (= d621e29aa app code), then on 0705c23ad | P2-2, P2-3, P2-4 ×3 | red at the asserted defect → green |
| RG2 | bgj_c8deab71a1ef | test APK dcd4fe0cf on app c86cfb185, then on dcd4fe0cf | P2-1, P2-5, P2-6, card focus hook, created-task hook | red 5/5 at the asserted defect → green 5/5 |
| S1 | bgj_8e6f0a4c032f | 54e7da53a | stack s03, s06, s08–s13 | PASS (8) |
| S2 | bgj_653eb9b2a024 | 6e8f3435a | stack s02, s05, s07 | PASS (3) |
| S3 | bgj_8d93d1598e05 | eef116e19 | stack s11 with `orbit://` forms | PASS |
| S4 | bgj_5a87dbe3206a | 9ae822323 | stack s04 | PASS |
| S5 | bgj_993f0d5d3a51 | 089fc1bb1 | stack s01 | PASS |
| F36 | bgj_5a87dbe3206a | 9ae822323 | fixture suite, API 36 light (20 journeys) | PASS 20/20 |
| D200 | bgj_5a87dbe3206a | 9ae822323 | screens tour, dark + 200 % font | PASS (Run now ends above the comment box) |
| F29 | bgj_5a87dbe3206a | 9ae822323 | fixture suite on API 29 (Android 10, emulator-5556 started and stopped by the runner) | RESULT_F29 |
| TB | bgj_5a87dbe3206a | 9ae822323 | `TalkBackCheckTest`, TalkBack running | PASS: touch exploration on through 6 pages; no press without words; TalkBack's focus landed on Task options, Task actions, Send comment, Project actions; TalkBack's notification prompt dismissed unanswered (its permission unchanged); settings restored |

## UI-F04 · Drawer Tasks / `orbit-task` / created-task row → list and task page

| A01 entry / field group | Android page | Tests | Result |
| --- | --- | --- | --- |
| Drawer Tasks | `TaskBrowser` (Tasks branch of `MainActivity`) | Fixture `taskSearchAndLabelsKeepScopeThroughRecreation`, `screensTour`; Stack `s01_theTaskListIsTheServersList` | S5: every row of `GET /tasks/page?projectId=none` is shown |
| `orbit-task:` from a conversation, back to it with the draft kept | `TaskDetail` over the conversation (A05 stack) | Fixture `sourceConversationTaskAndProjectReturnKeepDraft` | F36, F29 |
| created-task row → task | A08 created-tasks card row (minimal hook) → `TaskDetail` | Fixture `regressionCreatedTaskRow_opensTheTask` | RG2: red on the reviewed build (no entry), green on the fix |
| scope All / list; search; filter; sort/order; Tasks/Batches; labels | `TaskBrowser` bar, chips, options menu, label sheet | Unit `TaskApiTest`, `TaskLogicTest`; Fixture `taskSearchAndLabels…`, `regressionP21_…`; Stack `s01_…` | S5: the Failed chip shows the server's failed rows; a search shows the server's matches plus the rows `/tasks/active` pins over them (Happening now, as iOS `TasksView`); the `android` label shows the server's labelled rows. RG2: a write finishing under an earlier filter no longer refills the new one (P2-1) |
| multi-select bulk run / stop / assign / delete | bulk bar + iOS confirmations | Unit `TaskApiTest`; Stack `s04_bulkDeleteLeavesNothingOnTheServer` | S4: both rows answer `GET /tasks/:id` → 404 after Delete |
| detail: comments, acceptance, schedule, prerequisites, watch | `TaskDetail` sections and sheets (`TaskEditor.kt`) | Fixture `taskDetailWritesGoThroughTheServersOwnRecord`, `regressionP23_…`; Stack `s02_taskPageWritesAreTheServersRecord` | S2: comment, acceptance criteria, runAt set then cleared, prerequisite, watch — each read back from `GET /tasks/:id` or `GET /watches`. RG1: a refused acceptance edit keeps its sheet and draft (P2-3) |
| run / delete | action row, ⋯ menu | Fixture `taskDetailWrites…`, `regressionP24_aRunPressedJustBeforeLeavingStillStarts`; Stack `s03_aRunOnTheStackRunnerThenDelete` | S1: Run on the stack's runner → task DONE; Delete → 404. RG1: a Run pressed just before leaving still starts, under one name |
| loading / failed / empty / gone; words | placeholders and banners | Unit `TaskCopyParityTest`; Fixture `anOfflineAccountWritesNothingAndAWithdrawnTaskIsNoLongerShown`; Stack `s12_anotherAccountSeesOnlyWhatTheServerGivesIt` | S1: the member sees only its own task; the owner's task (404 for the member) shows "This task is no longer available." |
| share | ⋯ → Share… (`SharePanel.kt`) | Unit `TaskCopyParityTest.shareWords` (the panel's words, read from `SharePanel.swift`) | words only; the panel is not exercised on a device (gap) |

## UI-F05 · Task options → Task lists; `orbit-list` → scope

| A01 entry / field group | Android page | Tests | Result |
| --- | --- | --- | --- |
| Task lists directory; choose a list → Tasks in its scope | `TaskListsDirectory` from the scope title | Stack `s05_taskListsDirectoryAndListLinks` | S2: the directory lists the server's lists; choosing "A11 Sprint" shows every row of `GET /tasks/page?listId=…` |
| `orbit-list:<id>`; `lists/none` is not a named list | Tasks branch `Destination.LIST` | Unit `TaskApiTest`; Stack `s05_…`, `s11_linksOpenTheirPages` | S2, S3: `orbit-list:` and `orbit://list/` open the list scope with the server's rows; `/lists/none` changes nothing |
| labels sheet | `LabelPicker` | Fixture `taskSearchAndLabels…`; Stack `s01_…` | F36; S5 |

## UI-F06 · Drawer Projects / project row / `orbit-project` → list and project page

| A01 entry / field group | Android page | Tests | Result |
| --- | --- | --- | --- |
| index → project | `ProjectsScreen` index → `ProjectDetail` | Fixture `projectIndexProgressHowItRunsAndGraph`; Stack `s06_projectIndexAndPageAreTheServersRecord` | S1: every project of `GET /projects` is listed; the page shows the server's criteria and every open item of `GET /projects/:id/open-items` |
| run settings: At most, pause | How it runs (`ProjectSettings.kt`) | Unit `ProjectDataTest`; Fixture `projectIndex…`, `aStaleSettingIsRefused…`, `regressionP24_aSettingPressed…`; Stack `s06_…` | S1: At most 2→3 (configRevision 2) → 2 (3); pausedAt set then cleared. RG1: a setting pressed just before leaving is still written (P2-4) |
| start | owner Start… sheet (owner-approved platform difference) | Fixture `theOwnerStartsAProjectNobodyAskedAbout`, `regressionP24_theOwnersStart…`; Stack `s07_theOwnerStartsAProjectNobodyAskedAbout` | S2: the server refused a project branch for a project with no repository; the sheet kept the owner's choices and showed the server's words; on main (as the refusal says) the start was recorded (`startedAt`). RG1: Cancel is disabled while the start is sent |
| blockers | Blockers section | Unit `ProjectPageTest`; Fixture `aDeliveryBlockerIsReviewedWithItsReasonRecorded`, `regressionP22_…`; Stack `s10_aServerRaisedBlockerIsResolvedWithItsReason` | S1: a server-raised HUMAN_DECISION_REQUIRED blocker resolved; the server's record carries the owner's reason. RG1: an abandoned reason does not prefill the next dialog (P2-2) |
| open coordinator | Open items → coordinator conversation | Fixture `anExceptionIsReviewed…`, `regressionFocus_…`; Stack `s08_…` | S1: the conversation the app opened is the server's coordinator session |
| record done / reopen | ⋯ menu; done door `ProjectDoneSheet` | Unit `ProjectDoneTest`; Fixture `regressionP26_…`; Stack `s13_recordAsDoneThroughTheDoneDoorThenReopen` | S1: DONE, doneBy OWNER, 2 accepted gaps; Reopen → OPEN. RG2: Record as done is `POST /projects/:id/done`, never a status PATCH (P2-6) |
| loading / gone; words | placeholders | Unit `ProjectCopyParityTest`; Fixture `aStaleSettingIsRefusedAndAWithdrawnProjectIsNoLongerShown`; Stack `s12_…` | S1: the owner's project (404 for the member) shows "This project is gone" |
| live refresh | page and list re-read on account events | Fixture `regressionP25_…` | RG2: a stream of events still lets the list read what changed (P2-5) |
| share | ⋯ → Share… (`SharePanel.kt`) | Unit `ProjectDataTest` (reads `/projects/:id/share`), `TaskCopyParityTest.shareWords` | words and the read only; the panel is not exercised on a device (gap) |

## UI-C08 · decisions the project flows deliver to the coordinator conversation

| A01 entry / field group | Android page | Tests | Result |
| --- | --- | --- | --- |
| exception (failed task) | open item → coordinator conversation onto `item:<itemId>` (minimal A08 hook) → A08 card | Fixture `anExceptionIsReviewed…`, `regressionFocus_…`; Stack `s08_anExceptionIsHandledOnItsCardInTheCoordinatorConversation` | S1: a real TASK_FAILED item handled with a note on its card; no longer open on the server. RG2: the card is brought into view |
| merge to main | open item → conversation onto `promotion:<id>` → A08 card | Stack `s09_theMergeToMainIsReviewedOnItsCard` | S1: READY → Merge → CONFIRMED → MERGED by the stack's runner |
| coordinator-asked start; coordinator question | start row → `start:<itemId>`; question card | Unit (`CardFocus` matching) | not exercised on the stack: the seed has no coordinator start request, and the question card is A08's (gap) |

## Deep links (A01 §3)

| Form | Android | Tests | Result |
| --- | --- | --- | --- |
| `orbit-task:` / `orbit-project:` / `orbit-list:` | A05 routing into the Tasks/Projects branches | Fixture (task, project); Stack `s11_linksOpenTheirPages`, `s05_…` | S3, S2 |
| `orbit://task/<id>`, `orbit://list/<id>` | A05 native deep links | Stack `s11_…` | S3 |
| same-instance `http(s)://host/tasks/<id>`, `/projects/<id>`, `/lists/<id>`; `lists/none` | A05/A06 in-app link capture | Stack `s11_…` | S3 |

## Accessibility and sizes

| Check | Tests | Result |
| --- | --- | --- |
| TalkBack running on the main pages | `TalkBackCheckTest` (labels as TalkBack composes them; TalkBack's focus put on the icon-only presses) | TB |
| 200 % font: Run now scrolls clear of the comment box | `screensTour` asserts Run now's bounds end above the comment box | D200 |
