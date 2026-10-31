# R29-11 · iOS / macOS (OrbitKit): delivery mode, the two items, the task row's observation words

Contract: `docs/project-integration-line-contract.md` §10.5 O-L1/O-L2, §10.7, §10.8, §10.9 (revision 29),
§7.1 V2, §7.6 V12/V13. The copy is R29-10's web copy word for word
(`docs/evidence/landing-observation/web`), held to the web source by OrbitKit's
`LandingObservationTests`. The OrbitApp side is pinned by `LandingObservationWiringTests`.

Every frame is the real app. The iPhone app's `CompactShell` and the Mac app's `MainView` are built from
this branch's shared sources into probe apps, pointed at `probe-harness/stub.py` and photographed by
`probe-harness/UITests/LandingObservationShotTests.swift` on a GitHub macOS runner. Each scene is shot
light and dark (`-probe.dark`). Every state a frame shows is asserted first. What a press sent is read
back from the stub's request log.

| Frame | What it shows |
| --- | --- |
| `*-start-delivery-menu-*` | The start card on a main line: the Delivery menu open, both ways in it |
| `*-start-delivery-agent-push-*` | The start card with "The agent pushes it" chosen, and its line under the row |
| `*-start-automatic-agent-push-*` | Automatic's sentence under the agent's way: "The agent pushes each task’s work to main itself.", with no "Each merge into main" under Comes to you. The start then sends `deliveryMode: AGENT_PUSH` with `line: MAIN` |
| `*-how-it-runs-agent-push-*` | How it runs on an AGENT_PUSH main line: Delivery with the agent's way chosen, and Directly into main's hint for it |
| `*-how-it-runs-automatic-agent-push-*` | Automatic's hint there: "…handles failed tasks and work not seen on main. The agent pushes each task’s work to main itself…" |
| `*-how-it-runs-project-branch-*` | How it runs on a project branch: "The agent pushes it" drawn but not offered, with why |
| `*-task-rows-*` | `Waiting to be seen on main · 9f1c2ab` and `Waiting to be seen on main` in Pending landing, `On main` in Landed |
| `*-card-landed-without-confirmation-*` | `LANDED_WITHOUT_CONFIRMATION`: headed by its kind word with the merge mark, its §10.7 title, the receipt, Accept leading |
| `*-card-landed-accepted-*` | After Accept, which went to `POST /projects/:id/open-items/:itemId/accept`: the card's receipt |
| `*-card-landing-unobserved-*` | `LANDING_UNOBSERVED` handed to the owner: its title under the hand-over heading, the detail line, Observe again among the server's doors |
| `*-observe-panel-*` | Observe again's question: "Look at the line again?", the reason being typed |
| `*-card-observing-*` | After Observe again sent its trimmed reason to `POST /projects/:id/integration/observe`: the Handling row `Observing main… — queued · asked …` and the Reason row |
| `ios-needs-you-bar-*` | The needs-you bar over the session list: "Landed without your confirmation" on its first line, "Refund service" on its second (the contract's `Landed without your confirmation · <project>`), the merge mark |
| `*-projects-list-*` | The projects list chip `Needs you · Landed without your confirmation · 2h` |
| `*-owner-confirmation-agent-pushed-*` | The owner confirmation card of an AGENT_PUSH project's task: If you confirm says `Pushed to main by the agent; Orbit records it once it sees the commit there`, and the branch row says confirming doesn’t merge it |

`*` is `ios` (iPhone simulator, 1206×2622) or `mac` (the CI Mac's screen, 1024×768). The needs-you bar
is iPhone-only: the Mac counts the same item in its menu bar, as `NeedsYouLogicTests` asserts. The Mac's
projects list column cuts the chip to "Needs you · Landed without your confirm…", as it cuts every chip
that long.

`probe-results.txt` is the run these frames come from: GitHub Actions run 40814430757 on probe commit
a145c7a53, which is b881b1e7e plus the harness. On that commit client.yml's own gates were green: macOS
(Xcode 26.3, Swift 6.2.4) ran OrbitKit `swift test` at 4118 tests with 0 failures and built OrbitApp,
and iOS built for the simulator. All 9 iPhone and 8 Mac scenes passed, light and dark. The file also
holds what each press sent, as the stub decoded it.

The first run (40808934994, on c27850491) passed on the iPhone and found a Mac crash on the
handed-over `LANDING_UNOBSERVED` card. AppKit ended the app with "needs another Update Constraints in
Window pass". On macOS the card's door rows sat side by side in one `HStack`, and the card's third door
(Observe again) left each row too narrow for the layout to settle. b881b1e7e stacks an exception card's
doors one per line on macOS, as the browser's door grid does, and `LandingObservationWiringTests` pins
it.

The probe ran from the push-triggered branch `probe/r29-11-orbitkit`, whose results went to
`probe/r29-11-orbitkit-results`. Both branches are deleted afterwards. `probe-harness/ci/client.probe.yml`
is the workflow that branch carried as `.github/workflows/client.yml`, beside client.yml's own macOS and
iOS gates on the same commit. The rest sat under `.lo-probe/`. Nothing in `probe-harness` is built by this
repository.
