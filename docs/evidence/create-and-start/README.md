# Create and start in one approval: `startNow` and the card's "Create and start"

Task `34o9etf0IZ0t5oPbYGDz9`, 2026-10-29. A task filed in no project with no prerequisites starts by nothing
(`independent-task-release.pg.spec.ts` (11) keeps it that way), so the owner who approved its create card was asked a
second time to start it. One approval now covers both:

- **`startNow`** (runner): `task_create`, each `task_create_batch` item, and `orbit task create --start-now`.
  `runAt` = now goes into the body before the card is raised, so the card's forecast reads "1 starts running within
  the minute". After the create the task is started the way `task_start` starts one. A refused start never undoes the
  create: the result is the created task plus one line saying the start was deferred, and the due runAt lets the
  once-a-minute schedule scan start it. `startNow` beside an explicit `runAt` is refused before any card. A batch
  item only gets `runAt` = now, and the scan starts it.
- **"Create and start"** (single-task card, Web, iOS/macOS, Android): the decision carries `startAfterCreate: true`
  (`POST /sessions/:id/approvals/:approvalId/decision`). The server accepts it only on an allow of an
  `orbit_task_create` card, stores it in `approval.start_after_create` (migration 0456), and returns it on the runner's
  poll. The runner then does exactly what `startNow` does. The button is shown only when the card's forecast says the
  task needs a manual start (`preview.needsManualStart === 1`) and the card says its runner acts on the choice
  (`input.acceptsStartAfterCreate`, see "One refinement" below). The plain approve is unchanged.

## Evidence

| What | Where |
| --- | --- |
| End to end on an isolated stack (real apiserver, runner, web console and MCP doors; fake engine), 33/33 checks: a task filed with `startNow` (session `4HK4QFa6KqNW438AMZnJdg`) and one approved with "Create and start" (session `4iQ9kFOYQmQ0bwkEEohPeh`), a plain-approve control that stays OPEN, a batch item started by the scan, `startNow` + `runAt` refused | [`e2e/README.md`](e2e/README.md) |
| Web: the single-task card with and without the button, from the e2e run on the real console | `e2e/run/shots/A-startNow-card-no-button.png` (without), `e2e/run/shots/B-create-and-start-card-with-button.png` (with) |
| iOS/macOS: the card on iPhone and Mac, with and without the button, light and dark, from the real `CompactShell` and `MainView` on GitHub's macOS runner (probe run 40830345204), with the decision bodies read back from the stub | [`ios/README.md`](ios/README.md) |
| Android: the card on a phone, with and without the button, light and dark (Robolectric), with the decision bodies | [`android/README.md`](android/README.md) |

## Tests

New tests, by codebase, and the full suites they ran in:

| Codebase | New tests | Full suite |
| --- | --- | --- |
| runner-go | `task_start_now_test.go` (16): startNow's runAt on the card and in the create, the start after it, nothing without it, startNow + runAt refused before any card, a refused start still returning the task with the note, batch items scheduled and never started, the card's Create and start taking the same path, the job replay, the CLI door, the declaration, the tool descriptions | `go test -count=1 ./...` on `d63a15a5b`: ok |
| apiserver | `sessions/approval-start-after-create.spec.ts` (8) and `.pg.spec.ts` (5, PostgreSQL 16 with 0456): accepted on an allowed `orbit_task_create` card, refused on a deny, on other cards and on a card whose runner predates it, round trip to the runner's poll | `npm test` on `d63a15a5b`: 5705/5705 |
| web | `ApprovalPanel.createAndStart.test.tsx` (7), `api.test.ts` (decision body) | `vitest run` on `d63a15a5b`: 5774/5774 |
| OrbitKit | `OrbitAskPreviewTests` (3), `CreateCardCopyParityTests`, `ApprovalRememberParityTests` | `swift test` (swift:6.1): 4122 executed, 0 failures; probe CI: 4122, OrbitApp built for macOS and iOS |
| Android | `CreateAndStartCardTest` (10, core), `CreateAndStartCardShellTest` (3, Robolectric) | `:core:test :app:testDebugUnitTest`: 296 + 1925, 0 failures; `lintDebug` clean |

No existing test failed, so no comparison run on main was needed. One existing web assertion
(`ApprovalPanel.stale.test.tsx`) pins the exact arguments `decideApproval` is called with; it now names the new
trailing argument (`undefined` for the plain yes). The request body it sends is unchanged, as `api.test.ts` shows.

## One refinement beyond the agreed design

Runner rollouts are staged and the native apps update apart from self-hosted servers. A card filed by a runner, or
stored by a server, that predates this change would still show the button under the agreed condition alone, and the
press would be stored and ignored: the task created, nothing started, the owner believing it runs. So the runner
declares, beside the single-task card's input, that it acts on the choice (`acceptsStartAfterCreate: true`). The server
records it on the stored card (and drops any copy the asker's input carries), and accepts `startAfterCreate` only on a
card carrying it. The clients show the button only there. With current runners every single-task card carries it, so
the button appears exactly where the agreed design says.

## Commits

- `226dea2e1` feat(tasks): create and start in one approval (runner, apiserver, shared, web).
- `d63a15a5b` fix(tasks): offer "Create and start" only on a card whose runner acts on it.
