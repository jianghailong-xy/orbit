# R29-12 · Android: delivery mode, the two items, the task row's observation words

Contract: `docs/project-integration-line-contract.md` §10.5 (O-L1/O-L2), §10.7, §10.8, §10.9 (revision 29), §4.7 H1, §7.1 V2,
§7.6 V12/V13. Copy: R29-10's web implementation, word for word (`LandingObservationCopyTest` holds every new word to the web source).

Every frame is drawn by the production composables under Robolectric's native graphics, light and dark, 2x
(`w411dp-h1100dp-xhdpi`): the cards, the start card and How it runs standalone, and the project page, its Open items sheet and the
projects list over the shell's controlled server (`ProjectShell`). The items, tasks and commits are the web evidence rig's
(`../web/rig/capture.mjs`). A menu's or a sheet's window is drawn over the page it opened on. Each frame's semantics tree — the
words it drew — is beside it as `<frame>-semantics.txt`.

Reproduce (from the repository root, with the Android SDK set up as for the unit tests):

```
src/android/gradlew -p src/android :app:testDebugUnitTest --tests 'io.orbitd.android.LandingObservation*Shots*'
```

The frames are written to `src/android/build/evidence/landing-observation-android/` and copied here.

| Frame | What it shows |
| --- | --- |
| `start-agent-push-*` | The start card on a main line, Delivery set to "The agent pushes it": its hint, the Automatic sentence without "Each merge into main still asks you", and no "Each merge into main" under Comes to you |
| `start-delivery-menu-*` | The Delivery menu open: both ways, each with what it means, the chosen one ticked |
| `start-project-branch-*` | The start card on a project branch: Delivery stays on "Orbit lands it", not offered, with why (the door's 409 `DELIVERY_MODE_NEEDS_MAIN_LINE`) |
| `settings-agent-push-*` | How it runs on a started main line: the line and the main branch locked, the delivery mode not; the agent pushes, in Automatic's own words |
| `settings-project-branch-*` | How it runs on a project branch: "The agent pushes it" drawn and not offered, with the same reason |
| `card-landed-without-confirmation-*` | `LANDED_WITHOUT_CONFIRMATION`: its kind word and the merge mark, its §10.7 title, Accept leading, the receipt line, no Mark as handled |
| `card-landing-unobserved-*` | `LANDING_UNOBSERVED` handed to the owner: the hand-over heading, the §10.7 title under it, Observe again among the doors, and Handling `Observing main… — running · asked 2m ago` with its reason |
| `observe-panel-*` | Observe again asking for the reason the door requires: `Look at the line again?`, what it does, `Why look again?` |
| `card-observe-failing-*` | `IE:observe`, the owner's: Observe again its one, leading door |
| `needs-you-bar-*` | The cross-conversation bar for the fifth owner item: `Landed without your confirmation` over the project, with the merge mark |
| `task-rows-*` | `Waiting to be seen on main · 9f1c2ab` (frozen commit) and `Waiting to be seen on main` (not frozen yet) in Pending landing, the task waiting on them, and `On main` in Landed |
| `open-items-*` | Open items: the owner's `Not on main yet: …` with Handling `Observing main… — running`, `Reached main without your confirmation: …`, and the coordinator's `Not on main yet: …` (`— queued`) and `Integration error: observing main` |
| `projects-list-*` | The projects list chip `Needs you · Landed without your confirmation · 2h` (the row's counts are the fixture's) |

Not here: the owner confirmation card's `AGENT_PUSHED`. Android has no "If you confirm" rows like the web's and OrbitKit's — its
card lists `ifConfirmed` as plain fields, so `landing` reads as its raw value for every mode (`LINE_THEN_OWNER` and `AUTO_MAIN`
too), and wording one value alone would not make it the web's preview.
