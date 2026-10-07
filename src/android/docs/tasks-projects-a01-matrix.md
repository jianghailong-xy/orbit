# A11 · A01 matrix rows → Android Tasks / Projects

Each row of the A01 iOS matrix (comment 34ZdN1qmQAkbScDXLMSTW on task A01) that A11 owns, mapped to the Android page that
carries it, the tests that exercise it, and what they established. Three kinds of evidence, never mixed up:

- **Unit** — JVM tests over the ported OrbitKit rules and the HTTP wire (no device).
- **Fixture** — `TasksProjectsDeviceTest` on the API 36 emulator against `scripts/tasks-projects-fixture.py`, a controlled
  server whose final records the test reads back; not a deployed server.
- **Stack** — `RealStackDeviceTest` on the emulator against the isolated Orbit stack (`/var/tmp/a11-stack`: the apiserver at the
  fixed server SHA's trees, its own PostgreSQL, the repo's Go runner with a stand-in engine), real accounts, every write read
  back from the server's API. Not production, not a physical phone.

Run identities and results are recorded in the task's evidence envelope (v2) and in the run directories it names.

## UI-F04 · Tasks: list and task page

| A01 entry / field group | Android page | Tests | Result |
| --- | --- | --- | --- |
| Drawer Tasks | `TaskBrowser` (Tasks branch of `MainActivity`) | Fixture `taskSearchAndLabelsKeepScopeThroughRecreation`, `screensTour`; Stack `tasksListMatchesTheServer` | see evidence |
| `orbit-task:` link from a conversation, back to it | `TaskDetail` over the session; A05 stack | Fixture `sourceConversationTaskAndProjectReturnKeepDraft`; Stack `deepLinksOpenTheirPages` | see evidence |
| created-task row → task | A08 created-tasks card row (minimal hook) → `TaskDetail` | Fixture `regressionCreatedTaskRow_opensTheTask` (red on d621e29aa, green on the fix) | see evidence |
| scope All / No list / list; search; filter; sort/order; Tasks/Batches; labels | `TaskBrowser` bar, chips, options menu, label sheet | Unit `TaskApiTest`, `TaskLogicTest`; Fixture `taskSearchAndLabelsKeepScopeThroughRecreation`, `regressionP21_…` (a write landing after the filter changed); Stack `tasksListMatchesTheServer` | see evidence |
| multi-select bulk run / stop / assign / delete | bulk bar + iOS confirmations | Unit `TaskApiTest` (batch bodies, partial refusals); Stack `bulkDeleteReadsBackGone` | see evidence |
| detail: title, description, status, assignee/provider/model/list, schedule, acceptance + command + exit code, prerequisites/graph/auto-run, inputs, attribution, watch, runs, comments | `TaskDetail` sections, sheets (`TaskEditor.kt`), `TaskInputUpload` | Fixture `taskDetailWritesGoThroughTheServersOwnRecord`, `regressionP23_…`, `regressionP24_aRunPressed…`; Stack `taskPageWritesReadBackFromTheServer` | see evidence |
| run / retry / open run / confirm done / reopen / delete / share | action row, ⋯ menu, `SharePanel.kt` | Unit `TaskApiTest` (run name + resends, reopen body, panel confirm re-read); Fixture `taskDetailWrites…`; Stack `taskPageWritesReadBackFromTheServer` | see evidence |
| loading / failed / empty / paging; words | placeholders and banners in `TaskBrowser`/`TaskDetail` | Unit `TaskCopyParityTest` (words byte-for-byte from the Swift sources); Fixture `anOfflineAccountWritesNothingAndAWithdrawnTaskIsNoLongerShown` | see evidence |

## UI-F05 · Task lists directory and `orbit-list:`

| A01 entry / field group | Android page | Tests | Result |
| --- | --- | --- | --- |
| Task options → Task lists; choose a list → Tasks in its scope | `TaskListsDirectory` dialog in `TaskBrowser` | Stack `taskListsDirectoryAndListLink` | see evidence |
| `orbit-list:<id>` → list scope; `lists/none` is not a named list | Tasks branch `Destination.LIST` | Unit `TaskApiTest` (scope rules); Stack `taskListsDirectoryAndListLink` | see evidence |
| labels sheet | `LabelPicker` | Fixture `taskSearchAndLabelsKeepScopeThroughRecreation` | see evidence |

## UI-F06 · Projects: list and project page

| A01 entry / field group | Android page | Tests | Result |
| --- | --- | --- | --- |
| Drawer Projects / project row / `orbit-project:` | `ProjectsScreen` index → `ProjectDetail` | Fixture `projectIndexProgressHowItRunsAndGraph`, `sourceConversation…`; Stack `projectPageAgainstTheServer`, `deepLinksOpenTheirPages` | see evidence |
| name, goal, criteria, progress, owner items, coordinator, tasks/DAG | page sections | Unit `ProjectPageTest`, `ProjectGraphLayoutTest`, `ProjectCopyParityTest`; Fixture `projectIndexProgressHowItRunsAndGraph` | see evidence |
| run settings: Automatic, concurrency, line/merge strategy, check command, escalation, pause | How it runs (`ProjectSettings.kt`) | Unit `ProjectDataTest` (bodies, revision fence); Fixture `projectIndex…`, `aStaleSettingIsRefused…`, `regressionP24_aSettingPressed…`; Stack `projectPageAgainstTheServer` | see evidence |
| start | owner Start… sheet (owner-approved platform difference) | Fixture `theOwnerStartsAProjectNobodyAskedAbout`, `regressionP24_theOwnersStart…`; Stack `ownerStartsAnUnstartedProject` | see evidence |
| blockers / fuse | Blockers section, Resume | Unit `ProjectPageTest`; Fixture `aDeliveryBlockerIsReviewedWithItsReasonRecorded`, `regressionP22_…` | see evidence |
| open coordinator / replace coordinator | Coordinator section | Fixture `anExceptionIsReviewedOnTheCoordinatorsCard…`, `regressionFocus_…`; Stack `exceptionReviewedOnTheCoordinatorsCard` | see evidence |
| record done / cancelled / reopen / delete / share | ⋯ menu; done door `ProjectDoneSheet` | Unit `ProjectDoneTest`; Fixture `regressionP26_…`; Stack `projectPageAgainstTheServer` | see evidence |
| loading / empty / search / failed / gone; words | placeholders | Unit `ProjectCopyParityTest`; Fixture `aStaleSettingIsRefusedAndAWithdrawnProjectIsNoLongerShown` | see evidence |

## UI-C08 · decision cards the project flows deliver to the coordinator conversation

| A01 entry / field group | Android page | Tests | Result |
| --- | --- | --- | --- |
| exception (failed task) → conversation → the item's card | Open items row → coordinator conversation opened onto `item:<itemId>` (minimal A08 hook) → A08 card | Fixture `anExceptionIsReviewedOnTheCoordinatorsCard…`, `regressionFocus_…`; Stack `exceptionReviewedOnTheCoordinatorsCard` | see evidence |
| coordinator-asked start → start card | start row Review → conversation onto `start:<itemId>` | Unit `ProjectDoneTest`/`CardFocus` matching | see evidence |
| merge to main review | open item → conversation onto `promotion:<id>` | Unit (focus address) | see evidence |

## Deep links (§3)

| Form | Android | Tests | Result |
| --- | --- | --- | --- |
| `orbit-task:` / `orbit-project:` / `orbit-list:` | A05 routing into the Tasks/Projects branches | Fixture (task, project); Stack `deepLinksOpenTheirPages` | see evidence |
| same-instance `http(s)://host/tasks/<id>`, `/projects/<id>`, `/lists/<id>` | A05/A06 in-app link capture | Stack `deepLinksOpenTheirPages` | see evidence |
