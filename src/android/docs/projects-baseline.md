# A11 Projects — implementation against the iOS baseline

A source correspondence plus controlled-fixture and emulator results, **not** a frozen iOS installation matrix or a cross-device business result. Development input is the ordinary merge `b075423118dacfb0a3c90c36b9f1aacad1feffd4` (A07 parent `51bbcc303cec3c64dfb217316afce9498add760d`); route-only checkpoint `cfe49df7a`. No composer, attachment, auth, reader or card implementation is changed by this module.

Source baseline: `src/macos/OrbitApp/Sources/OrbitApp/Views/ProjectsView.swift` (index, page, `OwnerStartProjectSheet`, `MergeCheckEditor`), `ProjectGraphView.swift`, `ProjectLandingRow.swift`, `ApprovalCards.swift` (`StartProjectCard`), `ProjectsModel.swift`; OrbitKit `ProjectAttention.swift`, `ProjectPage.swift`, `ProjectPageSections.swift`, `ProjectGraphLayout.swift`, `ProjectRunSettings.swift`, `StartProject.swift`, `CriteriaDecision.swift`, `ShareMarkdown.swift`, `APIClient.swift`.

## How the baseline is carried over

OrbitKit's project rules are ported as pure Kotlin over the server's JSON — `ProjectAttention.kt` (lanes, order, chips), `ProjectPage.kt` (`ProjectPage`, `StartProjectCopy`, `RunSettings`, `ProjectMarkdown`), `ProjectGraphLayout.kt` (folds, run expansion, layered layout with direction fit) — and held to Swift by tests: `ProjectPageTest` ports the XCTest cases of `ProjectPageTests`, `ProjectPageSectionsTests` and `ProjectRunSettingsTests`; `StartProjectTest`, `StartProjectCardCopyTest` and `StartProjectCardTest` port main's `StartProjectTests`, `StartProjectCardCopyParityTests` and the card half of `StartProjectWiringTests` (A11b); `ProjectGraphLayoutTest` ports `ProjectGraphLayoutTests`; `ProjectCopyParityTest` fails when any Android copy string is not a literal in the pinned Swift sources.

| iOS entry | Android | Contract |
| --- | --- | --- |
| `ProjectsListView` | `ProjectsScreen.kt` index | `GET /projects`; search title/goal; lanes Needs attention, Running, Ready, Waiting, Needs definition, Completed (folded, Show/Hide); each row: title + quiet age, the attention chip, lane meter + counts, the line its work lands on; failed/empty/no-match placeholders with iOS words |
| `ProjectDetailView` reads | `ProjectDetail` | Document, panorama, integration, open items, coordinator status, dependency graph, ready queue (`limit=5`), share and the loaded task window, read together; a section whose read fails keeps its last answer; refreshed on A04 invalidation (400 ms) and every 15 s while visible (graph excluded) |
| Header | Title, status chip (Not started / Open / …), task count, integration facts or the undecided line | `ProjectPage.integrationFacts`, `RunSettings.undecidedLine` |
| Open items | Needs you / With the coordinator, the start row | Server `actions`; the primary action is the first this client can carry out (Review, Answer, Resume, Open coordinator, Open task session); tapping a row opens the coordinator conversation, where A08 draws and answers the card |
| Start (asked) / Start… (own) | Start row; `OwnerStartSheet`; `CoordinatorStartCard` | Both draw main's redesigned card (`StartProjectCard.kt`, iOS `StartProjectCard`): who asked (or Nobody asked yet · no coordinator yet), the coordinator's words with More/Less, Done when, How it runs (Automatic with its sentence, the coordinator a start opens, Comes to you; Tasks land on; merge check Set/None; At most) and its note, the plan by level (Now / You, in parallel), Start with the line under it. Asked: Review opens the coordinator conversation onto its START card, pressed through A08's card actions with the request named. Own: a native sheet set by `StartProject.defaultSettings` over the seal from `GET /acceptance/confirmation`, pressing `POST /projects/:id/start` with every setting and `requestId:null`; a refusal stays on the card in the door's words |
| Work overview, landing row | Overview cells, meter, landing row (1 s clock), manual-ready and wrap-up banners | `ProjectPage.overviewCells`, `landingLine` (stale heartbeat / read freezes the clock), `manualReady`, `wrappingUp` |
| Coordinator | Pill, last active · Nth coordinator, Workspace, Wake-ups, Self-started today, dispatch note, Open/Reply + ▾ Start a new coordinator | `GET /coordinator/status`; `POST /coordinator` resolve-or-create; `POST /coordinator/replace` behind the menu and confirmed unless the conversation is finished |
| How it runs | `ProjectSettings.kt` `RunSettingsSection` (shown unless the project was never started) | Line options or the locked line; Automatic `PATCH {automatic, expectedConfigRevision}` (never `coordinatorEnabled`); At most stepper, one write 700 ms after the presses stop; merge check on its own sheet (`MergeCheckEditor`, refusal kept on the sheet); Escalate after; Pause/Resume project |
| Goal, instructions | Markdown folded with More/Less | A06 renderer |
| Task graph | `ProjectGraph.kt` inline + full screen | Server marks and prerequisite → dependent edges, settled folds and run expansion as OrbitKit; pinch/pan plus Zoom in/out; a task mark opens the task; truncation notice |
| Blockers | Open rows + resolved fold | Headline/subject/decision/paths/since; Resolve… / Review… dialog with the decision's own words, reason ≤ 2000, `POST /blockers/:id/resolve {reason}` |
| Run queue | Rows with Run / Resume list / Open session / tag | Only `runState:READY` offers Run (`POST /tasks/:id/execute`, one trigger per press, 3 resends); PAUSED resumes the list (`PATCH /task-lists/:id {paused:false, note}`) after the iOS confirmation |
| Acceptance criteria | Ordinal marks met / unmet / unanswered, work lines, held-up task links, How it's checked, first 4 + View all | `ProjectPage.criterionWork`, `criteriaDisclosure` (compact) |
| Tasks | Bands (Running, Pending landing, Ready, Waiting for landing, Blocked by level, Landed, Done / Cancelled) with tags, waits/blocks, Load more | `GET /projects/:id/tasks/page`; a refresh re-reads the loaded window from the top |
| ⋯ menu | Record as done / cancelled or Reopen; Copy Link; Share…; Copy as Markdown; Delete project (only with no tasks) | Record as done opens "Is this project done?" (`ProjectDoneSheet`, port of OrbitKit `ProjectDone`, main 7c9d0ceec) and presses `POST /projects/:id/done {criteriaDigest, acceptedGaps, requestId}` — the seal read (or the coordinator request's own), the gaps shown, the DONE_REQUEST answered or null — leaving an OWNER record a later check does not undo; Open items carry Ready to close / Record as done… rows and the header says who recorded it. A server without the `derivedDone` projection keeps the status door (`PATCH {status}`), as iOS does. Cancelled / Reopen stay `PATCH {status}`; `/projects/:id/share`; `ProjectMarkdown.project`; `DELETE` |

Refusals surface as "Couldn't do that" with OrbitKit's sentences ("These settings were not saved — …", "That start was not recorded — …", "Couldn't start the task: …"), the server's own words after the dash (`failureReason` = `APIClient.failureReason`).

## Write authority, offline, permissions

Writes use `ProjectApi` over A03's handle and A11's `FeatureWrites`: gated on the CONNECTED account stream (refused locally while it is down), named once per press, fenced for 60 s when the answer is unknown. A `403` or `404` on the project read withdraws the page: "This project is gone — It was deleted, or it belongs to another account." **Difference:** iOS withdraws on 404 and keeps the page on 403.

## Differences from the iOS baseline (deliberate, recorded)

1. **Owner's own Start… is a native sheet, not A08's card** — approved by the account owner as a platform difference (card 34bbkPvI56b7ZUi8cJjX4, 2026-10-07T05:08:28Z). The sheet draws the same start card the coordinator conversation's START card draws (A11b), carries the same words (held by `ProjectCopyParityTest` and `StartProjectCardCopyTest`) and sends the same body; exceptions, questions, merge reviews and criteria changes are answered on A08's cards in the coordinator conversation.
2. **The coordinator conversation opens onto the item's card** (iOS `focus(ownerItem:)`): the page asks A08's card host for the card by its address (`item:<itemId>`, `start:<itemId>`, `promotion:<id>`) through the minimal hook `cards/CardFocus.kt`, and the host brings it into view once drawn. A later live event may follow the transcript to its end, as the reader does.
3. **Record as done is the owner's done door** (above), following iOS/web on main (7c9d0ceec / 0f47238c1) at the coordinator's request (decision 5dshHuxUn20vj22RYT968k). The earlier statement that a status PATCH "reads back OPEN" no longer describes Android. "Not yet…" (declining a DONE_REQUEST with a note) and the "Why is this project not done?" card are not ported.
4. **403 withdraws the page**, **writes are refused locally while the account stream is down**, and the graph's **Zoom buttons** — all three approved by the account owner as platform differences (card 34bbkPvI56b7ZUi8cJjX4).

## Verification

- Unit (JVM): `ProjectDataTest` (every call's method, path, query and body, as `testEveryProjectCallHitsItsRoute`; task window re-read; offline refusal before any request; refusal words), `ProjectPageTest` (19 ported OrbitKit cases), `ProjectGraphLayoutTest` (15), `ProjectCopyParityTest` (5).
- Emulator (API 36 `emulator-5554`, controlled fixture): index → page → How it runs (At most write fenced on revision 1, Automatic writes only `automatic` + revision 2), graph full screen → task → back; stale revision 409 shown with the server's words and nothing changed; 403 withdrawal; exception open item → coordinator conversation → A08 card resolved with its note → back to the page; owner's own Start… with `requestId:null`; delivery blocker reviewed with its reason recorded. Results, logs and screenshots are in the evidence directory named in the task's evidence envelope.

## Gaps that remain

Not established: same-account installed iOS/Android/Web final state, physical GMS Android 10–16 phones, real deployed role accounts and their integration runners, FCM/release credentials, the deployed backend SHA. The fixture answers start, blockers and outages under the shared contracts; that is controlled wiring, not a business result.

## Authored paths (relative to `src/android`)

`app/src/main/kotlin/io/orbitd/android/projects/{ProjectsScreen,ProjectSettings,ProjectData,ProjectPage,ProjectAttention,ProjectGraph,ProjectGraphLayout}.kt`, the Projects branch line in `MainActivity.kt`, tests `app/src/test/kotlin/io/orbitd/android/projects/*`, and this document.
