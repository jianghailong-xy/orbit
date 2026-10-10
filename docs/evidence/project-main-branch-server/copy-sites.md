# The server's own sentences about a merge into main, named by the project's main branch

Task 34daHfCzzJONUJ0lZCLhN (project 34cjQN5ynG6eIH5A0neeu, criterion 4). Base: project tip
c8fb80c1b, whose tree is main 2265bb138's. Delivery: 34a752370 (code and tests). This file is added on
top of it and changes nothing else.

The web's own sentences were done by 34cjZa1LTksTyhej32E6v (`../project-main-branch-web/copy-sites.md`)
and 34dXwqJALj5g5fLAoF50e (`../project-main-branch-reads/copy-sites.md`). This list covers the
sentences the apiserver writes itself and a client prints as they are.

## How the list was made

- The task's start: `git grep -nE "(into|to|on|reach(es)?|syncing) main\b" -- src/apiserver/src` at the
  base: 410 lines, 138 of them outside spec files.
- A wider sweep at the base, case-insensitive, so it also catches "Merge to main", "On main" and a
  "main" at the head of a continued string: `git grep -niE "\bmain\b" -- 'src/apiserver/src/*.ts'
  ':!*.spec.ts' ':!*fixtures*'`, without comment lines and `function main()` entry points: 158 lines.
- Each hit was read where it is, then followed to whoever reads it: which route or card carries it, and
  which client draws that field and on which screen.
- `git grep` reads every file. Plain `grep` takes `project-open-item.ts` and `integration-job-relay.ts`
  for binary and prints no line of them.

The branch is always the project's binding, `project_codebase.upstream_ref` without `refs/heads/`
(`mainBranchOf`, or `branchName` on the same column). A project with no binding says main. For a project
on main, every sentence below reads byte for byte as before.

## Changed: shown to the account owner

| # | Base (c8fb80c1b) → delivery (34a752370) | Before → after | Where a client shows it |
|---|---|---|---|
| 1 | `projects/project-task-integration.ts:106` → `:109` | 'a check of the merge into main' → `` `a check of the merge into ${main}` ``, in "Waiting to land: … is running on this branch first" | `landTask.blockingReason.summary`, on `GET /tasks/:id` (`integration`), the project's task rows, and `GET /projects/:id/integration` (`landTasks[]`). **Web:** the task page (`TaskDetailPanel.tsx:1523` → `LandTaskStatus.tsx:136`), the project page's landing rows (`ProjectIntegrationLine.tsx:189` → `LandTaskStatus`), and the merge card's "Blocked by" row (`lib/projectMerge.ts:175`, drawn by `ProjectPromotionCard.tsx:483` and `ProjectMergeStrip.tsx:142`). **iOS/macOS:** the merge card's "Blocked by" row in the coordinator conversation (`OwnerItemCards.swift:531`, fed by `ConsoleModel.swift:4129`). **Android:** none. |
| 2 | `projects/project-task-integration.ts:107` → `:110` | 'the merge into main' → `` `the merge into ${main}` ``, same sentence | Same as 1. |
| 3 | `projects/project-integration-job.ts:467` → `:474` (`integrationItemTitle`) | 'merging the project branch into main' → `` `merging the project branch into ${mainBranch ?? 'main'}` ``, in "Merge conflict: …", "Checks failed on the combined tree: …" and "Integration error: …" | The title of the open item a promotion's failed check or merge opens. It is written once, at `runner-api/integration-job-relay.ts:984`, with the branch read at `:973–976`. **Web:** the project page's Open items row (`ProjectProgressStatus.tsx:1653`) and the exception card in the coordinator conversation (`OpenItemDeliveryCard.tsx:197`). **iOS/macOS:** the project page's open item (`ProjectsView.swift:863`), the conversation's card (`OpenItemDeliveryCardView.swift:58`), and the notification for an item that became the owner's (`push/owner-item-alert.ts`, whose ESCALATED body is the item title, sent over APNs). **Android:** the project page's open item (`ProjectsScreen.kt:782`), and the transcript's sticky line and card (`StickyQuestions.kt:68`, `TranscriptCardView.kt:50`). Items opened before the change keep the title they were stored with. |
| 4 | `projects/project-integration-line.ts:851` → `:851` | 'To change it, merge the project branch into main or abandon it first.' → `` `To change it, merge the project branch into ${branchName(row.upstreamRef)} or abandon it first.` `` | The 409 `INTEGRATION_LINE_LOCKED` from `PATCH /projects/:id/integration` (and `PATCH /projects/:id`'s `integration`). How it runs prints the server's message on a refused Save. **Web:** `ProjectRunSettings.tsx:490`. **iOS/macOS:** `ProjectsModel.swift:300–305` → "Not saved — <server message>." (`APIClient.failureReason`). **Android:** `ProjectsScreen.kt:461,576` → `failureReason`. It is reached when the line starts between drawing How it runs and pressing Save, since a started line is drawn read-only. |

Reachability of 1 and 2: a task's landing waits on a promotion job only when the two share a serial key
(`integrationSerialKey`). A check serialises on `#check:<project>`, which no landing shares, so 1 is not
reached today. A merge serialises on the upstream ref, which a landing shares only when it lands on that
same ref. Both are changed, since they are one table.

## Changed: served for the owner, though no client draws them today

| # | Base → delivery | Before → after |
|---|---|---|
| 5 | `projects/project-open-item.ts:389` → `:394` | 'Nothing on the project branch reaches main until this check passes — …' → `` `… reaches ${main} until …` `` |
| 6 | `:401` → `:406` | `` `${actor} must decide whether this promotion reaches main — …` `` → `` `… reaches ${main} — …` `` |
| 7 | `:414` → `:419` | 'The project branch cannot reach main until this promotion conflict is repaired — …' → `` `… reach ${main} until …` `` |
| 8 | `:417` → `:422` | 'The project branch cannot reach main until this check finishes — …' → `` `… reach ${main} until …` `` |
| 9 | `:419` → `:424` | 'The project branch cannot reach main until this integration is repaired — …' → `` `… reach ${main} until …` `` |

These are an open item's next step (`openItemRequiredAction`, branch `row.mainBranch`, `:386`). They are
served as `requiredAction` on `GET /projects/:id/open-items` (the branch is read once,
`project-open-item.service.ts:2720`, and passed at `:2802`) and on the delivery card recorded beside a
coordinator's turn (`readOpenItemDeliveryCard`, `project-open-item.ts:2090–2096,2150`, read by
`sessions/turn-cards.ts:73`).

The code comment says the three clients render this field. None does today:
- **Web:** no component reads it. `lib/openItemDelivery.ts` leaves it out when it parses the card.
- **iOS/macOS:** `ProjectOpenItemRow` and `OpenItemDelivery` don't decode it.
- **Android:** the open item row draws the title and detail line (`ProjectsScreen.kt:782`), and
  `TranscriptCardView.kt:50`'s field list leaves it out.

They are changed anyway: the task names them, and the field is the API's next-step sentence, meant to
be printed as it is. A client that starts drawing it gets the right branch.

## Not changed, and why

Agent-only: prompts, and refusals only an agent's call can receive.

| Base (c8fb80c1b) | What it is |
|---|---|
| `projects/coordinator-opening.ts:84,153` | The coordinator's opening prompt. |
| `projects/coordinator-judgment-opening.ts:225–255,716–734,752–769,819–830` | The judgment turn's prompt and its tallies. |
| `projects/project-open-item.ts:1558` (`failureClassLines`), `:1672` (`promotionNextStep`) | The "From Orbit · exception item" message delivered to the coordinator (built at `:1909`). The clients draw the delivery's card (title, files, check, landing), not this prose. |
| `projects/project-started.ts:350` | `projectPausedMessage`, the pause notification to the coordinator. |
| `projects/project-promotion.ts:131` | `promotionPrincipalRefusal`: the 403 an agent session gets when it tries to decide a merge. |
| `projects/project-done-request.ts:300–316,395` | `doneReadiness` findings. The REFUSE ones are the 409 `DONE_REQUEST_NOT_READY` that `project_request_done` (coordinator only) receives. The WARN ones are returned to it and stored as the request's `warnings`, which no client reads. |
| `projects/project-start-request.ts:278–281,297` | The start request's ready check. REFUSE answers `project_request_start`. The WARN `START_NO_MERGE_CHECK` is stored as `warnings`, which OrbitKit decodes (`StartProject.swift:198`) but no view draws ("The ready check's warnings are the coordinator's and are not drawn", `ApprovalCards.swift:2640`); the web sends none (`StartProjectCard.tsx:994`); Android doesn't read it. |
| `projects/project-open-item.service.ts:850` | `requestStart`'s 400, for `project_request_start`. |
| `projects/project-integration-retry.ts:126,272,281,284,314` | `integration_retry` and skip-merge-check refusals. The owner-side doors that reach them (`/tasks/:taskId/integration/retry`, `/promotions/:promotionId/integration/retry`, `/tasks/:taskId/integration/skip-merge-check`) are called by no client. |
| `tasks/task-codeless.ts:99,119` | Refusals of a codeless declaration. No client sends `codeless`. |

Fields no client reads:

| Base | What it is |
|---|---|
| `projects/project-open-item.ts:301` | `ownerItemNeed`'s 'Approve merge to main', the `need` on a session's owner items. Clients word owner items by `kind`. |
| `projects/project-promotion.ts:195,199,214,217` | Why a clean check is not merged by itself (`automaticConfirmationRefusal`, `automaticAuthorizationRefusal`). Used as a yes/no (`project-promotion.service.ts:1130`, `owner-confirmation-if-confirmed.ts:128`), and written only to the server log when an automatic merge is handed back (`integration-job-relay.ts:226`). |

Unreachable from the three clients:

| Base | Why |
|---|---|
| `projects/project-integration-line.ts:794`, `projects/project-acceptance.service.ts:499` | 400s for line MAIN with a project branch name. The start cards send `projectBranchName` only with PROJECT_BRANCH (web `StartProjectCard.tsx:208,930`, OrbitKit `StartProject.swift:648`, Android `CardRequests.kt:63`), and How it runs never sends one. |
| `projects/project-open-item.service.ts:1864–1865` | The owner's Retry on a timed-out job says this only for a job that is not a task's landing. Every client offers Retry only where the server's `retryable` says so (web `LandingJobsSheet.tsx:125`, OrbitApp `ProjectLandingJobsSheet.swift:86`, Android `ProjectPage.kt:151`), and `retryable` is set only for a task's landing (`project-integration-line.ts`, `retryable: timedOut && row.kind === 'LAND_TASK'`). |
| `projects/project-integration-line.ts:996–1000` | `repositoryUnknown` on the start door. It is thrown only for a project with no binding, which says main by the rule. |

The public share page: `share-links/public-project.ts` and the web's shared project page still say
"on main". `docs/share-links-design.md` §6 keeps branch names from visitors, and the public payload
carries no branch.

Not about a project's main branch: the wiki's `origin/main` (`wiki/*`, `wiki-worker/*`), a session's own
merge target (`sessions/session-move.ts:269`), `refs/heads/main` given as an example of a full ref
(`projects/dto.ts:209,516,545`), the `'MAIN'` line value, comments, test fixtures, and census notes.

## Tests

`src/apiserver/src/projects/project-main-branch-sentences.spec.ts` (unit, 7 tests). Each "before" is
copied from the base source, and each branch is passed through a cast, so the file also compiles on base.
Each sentence has one test at master and one at main, null and absent, so on base the master tests fail
and the others pass:

- 5–9: "an open item's next step names the project's main branch" / "… reads as before on main, and with
  no repository bound".
- 1–2: "a landing waiting behind the merge says which branch the merge goes into" / "… reads as before on
  main, and with no repository bound" (with null; a landing behind another landing or another job reads
  the same on every branch).
- 3: "the item a failed merge opens is titled with the project's main branch" / "… is titled as before on
  main, and with no repository bound", for CONFLICT, CHECK_FAILED and ERROR × CHECK_PROMOTION and
  LAND_PROMOTION. A task's own landing keeps its task title.
- "the next steps that say nothing about the merge are the same on every branch".

`src/apiserver/src/projects/project-main-branch-sentences.pg.spec.ts` (pg, 14 cases, the production
wiring over one client):

- (1) master and main × CHECK_FAILED, CONFLICT, ERROR, reported through the relay: the item's title (3),
  and its next step on the open items read and on the card (5, 7, 9).
- (2) master, main and no repository × the five shapes: the next step on the read and on the card (5–9).
- (3) master and main: the 409's message (4).
- (4) master and main: the merge approval's next step (6), then a task's landing queued behind the
  running merge, read through `TasksService.get` (2). The landing's serial key is set by hand, since no
  door queues a landing on that ref today.

Existing pins are untouched and still green: `open-item-required-action.spec.ts` (the approved copy at
main), `project-task-integration.spec.ts` (`/the merge into main is running on this branch first/`), and
`project-integration-retry.spec.ts` (fixture titles). No OrbitKit or Android test reads any of the six
changed files (`OpenItemDeliveryTests.swift` names `project-open-item.ts` in a comment only), and none
of the changed sentences appears anywhere under `src/macos` or `src/android`. So no native test or
product code changed.

## Runs

All on HPC (runner workstation-gpu). Base: c8fb80c1b (main 2265bb138's tree), with only the two new
spec files copied in. Delivery: 34a752370. Each run is a background job of this task's session, and its
output starts with the tree it ran on (`git rev-parse HEAD`, `git status --short`).

- **apiserver unit** (`rm -rf build && npm test`): delivery 5167/5167 (`bgj_2795aaac8fdb`); base 5164/5167
  (`bgj_830c743c0886`). The 3 base failures are exactly the new master tests. The other 4 new tests, which
  hold main, null and absent to the base wording, pass on base. Compared test by test
  (`bgj_99fd66184e5c`, `compare-unit-runs.py`): nothing passes on base and fails on the delivery. The
  census specs in the unit suite (`common/db-write-inventory.spec.ts`, `auth/pat-route-coverage.spec.ts`,
  `auth/tenant-isolation-census.spec.ts`) pass on both. The change adds no write, route, table or
  migration for them to count.
- **pg specs** (`bash scripts/run-pg-spec.sh $(cat related-pg-specs.txt)`): 60 specs, the list beside this
  file. It is every pg spec that calls a changed path (the open items read, the delivery card, the relay's
  job results, `configureProjectIntegration`, or the task integration read through `tasks.get`,
  `taskPage`, `landTask` or `blockingReason`), plus both tenant-isolation census specs and the three
  main-branch specs. Delivery: 60/60 green, 2035 tests (`bgj_67028a95d896`). Base: 59 green, and the new
  spec at 7/14 (`bgj_c2a07708b6e9`): its six master cases and their parent fail, and its seven main and
  no-repository cases pass. Spec by spec (`bgj_37adc769033b`, `/var/tmp/pg-red-green-kit/compare-pg-runs.py`):
  59 green on both, 1 red on base and green on the delivery (the new spec), 0 regressions.
  `tenant-isolation` is 811/811 and `tenant-isolation-runner` 717/717 on both.
- **OrbitKit** `swift test` (swift:6.1, `/mnt/data/wmb/ok-run.sh` on a `git archive` copy of each tree):
  base 3671 tests, 5 skipped, 0 failures (`bgj_b316a9387758`); delivery 3671 tests, 5 skipped, 0
  failures (`bgj_e03939163d2a`).
