# The last "main"s, named by the project's main branch: the reads and the sites

Task 34dXwqJALj5g5fLAoF50e (project 34cjQN5ynG6eIH5A0neeu, criterion 4). Base: project tip
a0891c46a (it contains main fe8d352bf). Delivery: 552009d1c. The list is the "Not changed" section
of `docs/evidence/project-main-branch-web/copy-sites.md` (task 34cjZa1LTksTyhej32E6v): the places
that still said `main` because no read they make named the project's main branch.

## The field

`mainBranch` is `project_codebase.upstream_ref` (the primary binding) without `refs/heads/`. It is null
when the project has no binding, or when the task is in no project. It is computed in one place on
the server, `mainBranchOf` (`projects/project-criterion-landing.ts:173`), or with the same fold in SQL
(`branchNameSql`). The web reads it through `mainBranchName()` (`lib/projectStart.ts`), which turns
null and absent (an older server) into `main`. Only reads change; no write path is touched.

| Read | Where the field is | Server source (552009d1c) | Shared type |
|---|---|---|---|
| `GET /tasks/:id/owner-confirmation` | `ifConfirmed.mainBranch` | `tasks/owner-confirmation-if-confirmed.ts:81,240` `readMainBranch`: the task's project → `readProjectCodebase`. Best-effort like the other four items: if the read fails, the item is left out | `OwnerConfirmationIfConfirmed.mainBranch` (`owner-confirmation.ts:82`) |
| `GET /projects` | each row's `mainBranch` | `projects.service.ts:2562` ← `readProjectListBindings` (`project-integration-line.ts:177,199`), the same `project_codebase` statement the row's `integration` already came from; `readProjectIntegrationLines` is now a wrapper over it | none for the row (web `AttentionProject.mainBranch`) |
| `GET /projects/sidebar` | each row's `mainBranch` | `projects.service.ts:2804`, same reader | none for the row (web `SidebarProject.mainBranch`) |
| `GET /sessions` and the `session.updated` summary | `ownerItems[].mainBranch` | `projects/owner-decision-signal.ts:366,394` (the owner-item read selects `project.codebases` primary), `:472` `ownerItemsForRow` | `SessionOwnerItem.mainBranch` (`project-progress.ts:1137`) |
| `GET /tasks/:id`; the project's task rows; the integration view's landings | `integration.mainBranch` | `projects/project-task-integration.ts:384` (a scalar subquery in `readTaskIntegrationViews`' one statement, evaluated once) and `:227` (every state's view carries it); `tasks/tasks.service.ts:9116` (`null` for a task in no project) | `TaskIntegrationView.mainBranch` (`project-progress.ts:329`) |
| `GET /projects/:id/open-items` | `mainBranch` | `projects/project-open-item.service.ts:2893` | `ProjectOpenItemsView.mainBranch` (`project-progress.ts:709`) |
| The skip-merge-check card (approval input) | `input.mainBranch` | `src/runner-go/mcp.go:1963,2038`: the runner writes the card from the project read it already makes, so it copies that read's `integration.upstreamRef` (already short; null with no binding) | card input, read by `ApprovalPanel` |

## Each site: before, after, and where the branch comes from

Line numbers are at base a0891c46a (before) and at the delivery (after; the web tree is the same in
47bb12b90 and 552009d1c). For a project on `main` every sentence reads word for word as before.
Constants that OrbitKit's parity tests read keep their literal declarations.

| # | Site | Before (a0891c46a) | After | Branch from |
|---|---|---|---|---|
| 1 | `components/OwnerConfirmationCard.tsx` `ifConfirmedRows` | `:228` `IF_CONFIRMED_NOT_ON_MAIN` 'Not on main yet', `:229` 'No record of this branch on main', `:231` 'Goes onto the integration line; merging into main asks you again', `:232` 'Lands on main by itself if the checks pass' | constants kept (`:229–233`); the rows say `ifConfirmedNotOn(main)`, `ifConfirmedNoRecordOn(main)` (`:303`), `ifConfirmedLineThenOwner(main)`, `ifConfirmedAutoMain(main)` (`:313`) | `mainBranchName(ifConfirmed.mainBranch)`, from the card's own read |
| 2 | `lib/projectAttention.ts` (projects list row) | `:445` `PROMOTION_APPROVAL: () => 'Needs you · Approve merge to main'` | `:448` `` (_item, main) => `Needs you · Approve merge to ${main}` ``, called at `:553` with `mainBranchName(project.mainBranch)` | `GET /projects` row |
| 3 | `components/WorkspaceView.tsx` session row (`ownerItemWord`) | `:1084` `OWNER_ITEM_APPROVE_MERGE` 'Approve merge to main', picked at `:1106` | constant kept (`:1084`, OrbitKit's `OwnerItemCardsTests` reads it); `ownerItemWords(main)` says `` `Approve merge to ${main}` `` for a merge approval; picked at `:1111` with `mainBranchName(item.mainBranch)` | the row's owner item |
| 4 | `lib/sessionProjects.ts` (the session list's project landing line) | `:140` `JOB_WORDS` ('Merge to main'), `:143` `JOB_PHASES` ('syncing main') | `:141` `jobWords(main)`, `:144` `jobPhases(main)`; `sessionProjectLandingLine(…, main)` called at `:242` with `mainBranchName(summary?.mainBranch)` | `GET /projects/sidebar` row |
| 5 | `components/TaskDetailPanel.tsx` (the task page) | `:1188` `landingBadge(q.data?.integration)` ('On main'), `:1520` `<LandTaskStatus …/>` ('Its work is on main by an existing receipt.', 'stopped while syncing main') | `:1191` `landingBadge(…, mainBranch)`, `:1523` `<LandTaskStatus … main={mainBranch} />`, where `mainBranch = mainBranchName(q.data?.integration?.mainBranch)` | `GET /tasks/:id` `integration` |
| 6 | `components/ApprovalPanel.tsx` (skip-merge-check card) | `:660` '…the next landing and every merge into main are checked as before.' | `:665` `…every merge into {input.mainBranch} are checked as before.`; `mainBranch: mainBranchName(text(obj.mainBranch))` | the card's input (runner) |
| 7 | The public share page (`pages/SharedProjectPage.tsx`: `ProjectPanoramaCard`, `projectTaskIntegrationTag`, `AcceptanceCriteriaCard`) | 'On main', 'landed on main', 'not on main yet', 'on main' | **unchanged**, see below | — |
| 8 | `components/ProjectProgressStatus.tsx` `openItemChatContext` (agent-facing) | `:1300` `` `Where it stands: ${itemStandingLine(row, now)}` `` ('…the re-check of the merge into main…') | `:1303` `itemStandingLine(row, now, main)`, with a new `main` parameter; `WorkspaceView.tsx:5387,5392` passes `main: chatMain`, `chatMain = mainBranchName(openItems.data?.mainBranch)` | `GET /projects/:id/open-items` |

## Not changed, and why

- **The public share page (7).** `docs/share-links-design.md` §6 lists what no layer of a share
  link ever shows. It names, under code, the repository address and the branch names, and it fixes
  the landing words to "on main / not on main yet / no merge receipt either way". The public
  payload is built to that rule: `share-links/public-project.ts` `PublicLanding`, and
  `integrationLine` ("Never the branch's name"). `public-project.pg.spec` plants the owner's branches
  and shows them absent. Naming the project's main branch to a visitor would break that rule, and
  only the owner can relax it. So the page still says main, and its payload carries no branch.
- **Server-written sentences that say main.** These are outside `copy-sites.md`, whose list covers
  web sources only, so they are not part of this task. Examples: the owner item's `need` for a merge
  approval, 'Approve merge to main' (`projects/project-open-item.ts:301`, which no client reads);
  the landing blocking reasons 'a check of the merge into main' and 'the merge into main'
  (`projects/project-task-integration.ts:106–107`, which the task page prints verbatim as
  `blockingReason.summary`); refusal messages (`project-integration-retry.ts:272–284`, among
  others); the done-request findings (`project-done-request.ts:300–316`); and the coordinator's own
  prompts (`coordinator-judgment-opening.ts`), which tell an agent to merge "into main".

## Tests

`src/web` vitest, new cases. Each runs at `master` and at `main`/null/absent. The `main` side uses
the base's words or constants.

| Site | Test |
|---|---|
| 1 | `OwnerConfirmationCard.test.tsx` › "If you confirm, by the project’s main branch" (2): the four leads at master, also drawn on the card; at main/null/absent the four `IF_CONFIRMED_*` constants |
| 2 | `projectAttention.test.ts` › "names the merge an approval asks for by the project’s main branch, main as before" |
| 3 | `WorkspaceView.sessionLine.test.tsx` › "names the branch a merge approval merges into, main as before" |
| 4 | `sessionProjectLanding.test.ts` › "the landing line, by the project’s main branch" (2): Merge to / syncing, through the project row and the function |
| 5 | `TaskDetailPanel.test.tsx` › "names the main branch the task read carries, where the work is and where a sync stopped": the badge, the receipt line, "stopped while syncing" |
| 6 | `ApprovalPanel.test.tsx` › "says every merge into the project’s main branch is still checked, main as before": the whole note, word for word |
| 8 | `ProjectProgressStatus.chat.test.tsx` › "names the merge being re-checked by the project’s main branch, main as before"; `WorkspaceView.exceptionPlacement.test.tsx` › "tells the coordinator a card’s merge by the main branch the open-items read names" (where the host takes it) |

Server and runner:

- `projects/project-main-branch-reads.pg.spec.ts` (new). One account with a project bound to a
  `master` repository and one with no binding. Each read is asked through the service method its
  route returns. Expected: `master`, or `null` with no repository or no project. Cases: (1) owner
  confirmation, also for a task in no project; (2) `GET /projects` and `GET /projects/sidebar`;
  (3) `GET /sessions` owner items; (4) `GET /tasks/:id`, also for a task in no project, and the
  project's task rows; (5) open items. The field is read without the shared types, so the file
  compiles on base, where it fails 6 of 6 on `undefined`.
- `sessions/open-list-version.pg.spec.ts`: the Open list's census pins each source the row shows.
  New cases: a merge approval on the coordinator's row, a repository being bound, and the main
  branch moving by raw SQL. Each must move both the list and its version. `project_codebase` was
  already a source. On base the "repository bound" case fails: the change did not reach the list.
- `projects/project-task-integration.spec.ts`: every state's view carries the row's main branch.
- `runner-go/integration_skip_merge_check_test.go`
  `TestMCPSkipMergeCheckCardNamesTheProjectsMainBranch`: the card's input carries `master`, or null
  where the project read's `upstreamRef` is null.

Updated because they pin shapes that gained the field:
- `owner-confirmation-if-confirmed.pg.spec` (`ifConfirmed`'s key set, two deepEquals: `mainBranch: null`
  for a task in no project).
- `push/push.service.spec.ts` (its hand-written open-item rows gain `project.codebases`).
- `project-task-integration.spec.ts` (its row builder gains `mainBranch`).
- OrbitKit `ProjectAttentionCopyParityTests` (the only OrbitKit red). The chip's web line moved
  from `() => '…main'` to `` (_item, main) => `…${main}` ``. The re-pin still holds that a project
  on main reads OrbitKit's sentence: `onMainBranch` puts each `main` back as `${main}`. It also pins
  where the chip takes the branch. OrbitKit and Android product code are untouched. No Android test
  reads a file this change touches.

## Runs

All on HPC (runner workstation-gpu), base a0891c46a against delivery 552009d1c. `runs.txt` beside
this file holds the numbers, spec by spec; `runs.py` wrote it from the logs.

- apiserver unit (`rm -rf build && npm test`): base 5157/5157, delivery 5158/5158 (the one new case
  is in `project-task-integration.spec.ts`). Every census spec in the unit suite passes on both:
  `db-write-inventory`, `pat-route-coverage`, `tenant-isolation-census` and the others. This change
  adds no write, route, table or migration for them to count.
- pg specs (`scripts/run-pg-spec.sh`): 54 related specs. They are every pg spec that calls a
  changed read (`list`, `listSidebar`, `readProjectIntegrationLines`, `openItems.list`,
  `confirmations.read`, `readOwnerDecision*`, `sessions.list`, `tasks.get`, `needsYouSessions`),
  plus `public-project` and both tenant-isolation census specs. Delivery: 53 green, and one red
  that base has too. Base: 3 reds:
  - `evidence-waits-for-coordinator.pg.spec` fails the same 1 of 12 on both trees. Line 727
    expects `/evidenceRevision 传 "1"/`, but main's 77e1f9585 ("the coordinator's judgment turn and
    the messages delivered to it are English") made the message say `evidenceRevision: "1"`. It is
    red on main and unrelated to this change.
  - `project-main-branch-reads.pg.spec` (the new spec, copied in) fails 6 of 6 on base, each on
    `undefined` where `master` is expected: the reads are new.
  - `open-list-version-delivery.pg.spec` (the delivery's census spec, copied in under its own name)
    fails on base at "repository bound: the change did not reach the list": the row's new source is
    new.
  - Tenant isolation is unaffected: `tenant-isolation` 811/811 and `tenant-isolation-runner` 717/717
    on both trees.
- `src/web` vitest (4 shards, `--maxWorkers=2`, each in its own capped scope): base 402 files,
  5237 tests, 0 failed; delivery 402 files, 5247 tests, 0 failed. Nothing fails on the delivery
  alone.
- OrbitKit `swift test` (`ok-run.sh`, swift:6.1): base 3671 tests, 5 skipped, 0 failures; delivery
  3671 tests, 5 skipped, 0 failures. The delivery's web change failed one case before the re-pin:
  `ProjectAttentionCopyParityTests.testOwnerItemChipsAreTheWebsOwn`, a source-line pin.
- runner-go (`go vet ./...` and the merge check's `go test ./...`, `-count=1`): delivery ok, no
  `--- FAIL:`.
- `tsc -p src/web/tsconfig.json`: clean. `tsconfig.cards-check.json` gives the 2 errors base has
  too, in `WorkspaceView.acceptanceConfirmationCard.test.tsx` and
  `WorkspaceView.promotionPlacement.test.tsx`; this change touches neither file.

The first delivery commit, 47bb12b90, read the task's main branch in `TasksService.get` with its
own statement. Its pg run turned two specs red that base passes. `project-task-integration`
(2 of 3) checks that the project's task rows, the task page and the integration view agree to the
field. `owner-confirmation-if-confirmed` (1 of 5) checks `ifConfirmed`'s key set. 552009d1c moved
the field into the read model all three share, and gave the key-set spec its new key. Both pass
there (3/3, 5/5).
