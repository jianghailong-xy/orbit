# The owner's answer to a criteria proposal, told to a task's run, says it was sent to this session

Task `34pWyIeaPCCHGAznSK97W`, the case `34pVGFQvGcjxSppunCWTK` left open (`docs/evidence/coordinator-delivery-line/`).
The change is `0e2737523`. The gates ran on `42dc74124`, which is that commit with main `4192bd06f` merged in, and the
web pictures were taken from it too. The Android pictures were taken on the tree of `354d6648d`, which adds only the
Android picture test (`git diff --stat 42dc74124 354d6648d` lists that one file). The iPhone and Mac pictures were
taken on `354d6648d` plus the probe harness.

`sendCriteriaDecisionReply` tells the answer to whichever session filed the proposal, and that can be a task's run
rather than the project's coordinator. The card the line is drawn from (`CoordinatorDeliveryCard`) now carries
`toCoordinator`, read off the project's own pointer, not the session's kind. It is true for every fact a coordinator is
told: a wake is delivered only to `project.coordinator_session_id`. For a reply, it is true only when the project the
proposal was filed on has `coordinator_session_id` naming this conversation. It is read when the runner echoes the turn
and stored with the echo. Where it is false, all three clients say `Criteria proposal rejected · Sent to this session ·
time` and open to `What this session was told`. Where it is true, nothing changed. A card without the field (echoes
stored before this, transcripts cached on disk) reads as the coordinator's, which is how it was drawn.
Contract: `docs/project-integration-line-contract.md`, revision 31.

## Server (a real PostgreSQL)

`src/apiserver/src/projects/coordinator-delivery-turn-card.pg.spec.ts`, case (6). A run of one of the project's tasks
files the proposal through the real `ProjectsService.update`. The owner refuses it through `decideCriteriaChange`. The
reply goes to the run (channel `SESSION`; no turn on the coordinator), and its card says `toCoordinator: false` on both
views of the queue and on the echo the real event ingest stores. While the project's pointer is moved to name the run,
the same reply reads `toCoordinator: true`: the pointer decides, not what kind of session it is. Cases (1) to (4) now
expect `toCoordinator: true` (three facts told to a coordinator, and the coordinator's own proposals answered). The
spec passed 8/8 on PostgreSQL 16.15 under `scripts/run-pg-spec.sh`. The unit spec `coordinator-delivery-card.spec.ts`
holds the rule against a fake database: the coordinator of this project, a conversation coordinating nothing, and the
coordinator of another project. With the server's `toCoordinator` hard-coded to `true`, that unit case fails.

## Web (a real browser)

The shipped `Transcript`, rendered by the web's own export (`buildSessionHtml`) with the shipped `index.css`, in
Chromium 1243 (playwright-core, device scale 2). The turn's words are what `criteriaDecisionReplyMessage` writes
(`probe-harness/gen-messages.cjs`). `web/reads.txt` records what each page's line and opened fold say, read off the
page.

| File | What it shows |
| --- | --- |
| `web/run-1280.png` | A task's run: `Criteria proposal rejected · Sent to this session · 10/31 07:30 PM ›`. |
| `web/run-open-1280.png` | Opened: `What this session was told`, then the words verbatim. Nothing on the page says the coordinator. |
| `web/run-390.png`, `web/run-open-390.png` | Phone width: the same two rows the delivery line always takes there. |
| `web/run-before-open-1280.png` | The same turn with a card stored before the field existed: `Sent to the coordinator` and `What the coordinator was told`, which is what every client drew for a task run before this change. |
| `web/coordinator-open-1280.png` | The coordinator's own proposal approved: `Sent to the coordinator · …`, `What the coordinator was told`, unchanged. |

`CoordinatorDeliveryLine.test.tsx` holds the same in jsdom. Drawn with the line's old markup, its task-run case fails
("expected 'Sent to the coordinator · …' to be 'Sent to this session · …'").

## iPhone and Mac (the real apps)

Photographed on GitHub's macos-26 runner from the task branch: the iPhone app's own `CompactShell` on an iPhone 17 Pro
simulator and the Mac app's own `MainView`. Each is built from the tree's sources into a throwaway app pointed at a
fixture API (`probe-harness/`) serving two conversations of one project: R1, a task's run told the owner's REJECT
(`toCoordinator: false`), and C2, the project's coordinator, told the owner's APPROVE (`toCoordinator: true`). XCUITest
found each line by its words and checked its label, then opened it with the app's own tap, photographed the line and
the sheet, and checked what the sheet says. A wrong word fails the test. The fixture's session rows are shaped the way
the server's session list shapes them: `projectId` names only the project a session coordinates, so the task's run has
none and gets no Coordinator badge. Runs, jobs and results are in `probe-results.txt`.

| File | What it shows |
| --- | --- |
| `ios/ios-01-run-line.png`, `ios/ios-01b-run-line-close.png` | The task's run on a phone: `Criteria proposal rejected`, then `Sent to this session · time` under it. |
| `ios/ios-02-run-sheet.png` | Opened: the sheet's title `What this session was told`, the line, then the words verbatim. |
| `ios/ios-03-coordinator-line.png`, `ios/ios-03b-coordinator-line-close.png` | The coordinator's reply: `Sent to the coordinator · time`, unchanged. |
| `ios/ios-04-coordinator-sheet.png` | Its sheet: `What the coordinator was told`. |
| `mac/mac-01-run-line.png`, `mac/mac-01b-run-line-close.png` | The task's run in the Mac console beside the session list. |
| `mac/mac-02-run-sheet.png` | The Mac sheet: `What this session was told`, the line, the words. |
| `mac/mac-03-coordinator-line.png`, `mac/mac-04-coordinator-sheet.png` | The coordinator's reply on the Mac, unchanged. |

The gates: `client.yml` itself, unchanged, dispatched on `probe/criteria-reply-session-gates` at `42dc74124` (run
41226063529). macOS ran OrbitKit `swift test` (4159 tests, 0 failures, the new delivery cases among them) and OrbitApp
`swift build`, which compiled `CoordinatorDeliveryLineView.swift`. iOS ran XcodeGen and `xcodebuild` for the Simulator,
which compiled `CoordinatorDeliveryLineView.swift` into the `Orbit` target: `** BUILD SUCCEEDED **`.

## Android (production composables)

`android/run-reply-line.png` and `android/run-reply-told.png`, each beside its semantics tree, are drawn by
`CoordinatorDeliveryShotsTest.theTaskRunsReply` (Robolectric, native graphics, 411 dp wide). The line reads `Criteria
proposal rejected` / `Sent to this session · time`, and the dialog it opens is headed `What this session was told`.
The test asserts that no node on either says `coordinator`. `CoordinatorDeliveryLineViewTest` also checks the line's
click label (`What this session was told`), and that the coordinator's reply still says `Sent to the coordinator` and
opens to `What the coordinator was told`. With the view's heading and click label put back to the coordinator's,
exactly those two task-run cases fail.

## Not shown, and not changed

- An echo stored before this change carries no `toCoordinator`, so a reply that already reached a task's run still
  says `Sent to the coordinator`. Nothing is backfilled. An installed client older than this change ignores the field
  and says the same.
- The accessibility hint (`Opens what this session was told`) is not in the pictures: XCUITest exposes no hint, and the
  element tree the probe wrote spells none. OrbitKit's `openHint` test holds its words, and the view's use of it
  compiled on both platforms.
- The message text, every other kind of line, and the sticky bar (`↑ From Orbit` and the sentence) are unchanged.
