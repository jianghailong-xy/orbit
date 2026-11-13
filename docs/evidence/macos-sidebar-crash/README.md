# The macOS sidebar after beta.242: one snapshot per area, one stored selection

Task [Rebuild the macOS sidebar so the beta.242 selection crash cannot happen](orbit-task:34wfVfF54HP5alSOq5CEw),
project [macOS list update safety](orbit-project:34wfOs8ywkHU1ge9iRmjn).

The owner's beta.242 build (`v0.1.2-beta.242`, commit `3299e485a`) crashed on 2026-11-13 at
11:14:58 — EXC_BREAKPOINT, NSGenericException from `-[NSLayoutConstraint setActive:]` under
SwiftUI's `OutlineListCoordinator` -> `NSOutlineView reloadItem:`, inside
`withSelectionUpdateGuard` — when they clicked the Wiki row. Three earlier crashes had the same
shape and were each fixed only at the crash site (`b4315daed`, `cdf409abe`, `ef0cf6d70`; the last
one is this repository's `d05b9f0e8`, the Workspaces row list).

## The crash's tree

`v0.1.2-beta.242` is `3299e485a` (2026-11-13 10:39 +0800). Current `origin/main` is `72aeac1ec`,
whose `Views/MainView.swift` differs from beta.242's by three lines. The sidebar there is the real
one: the work rows, the Workspaces group, the open projects, and one computed selection.

Before (beta.242/current main, `Views/MainView.swift`, `struct SectionSidebar`):

- `ForEach(AppSection.workSections) { section in if section != .wiki || model.wiki?.shown == true {
  sectionRow(section) } }` — an `if` in the List's ForEach decides whether the Wiki row exists, and
  `sectionRow` removed a zero count with its own `if waiting > 0`.
- `OwnerRequestInboxEntry()`.
- `Section(AppSection.agents.title, isExpanded: $workspacesExpanded) { workspaceRows(...) }` — this
  part was already one flat `ForEach(AgentListLogic.sidebarRows(...))`, one view per row
  (ef0cf6d70's shape).
- `if !openProjects.isEmpty { Section(isExpanded: $projectsExpanded) { ForEach(openProjects) { ... }
  } }`.
- `selection` was a computed `Binding<SidebarSelection?>` over `machineDraftRunnerID`,
  `projectSessionsColumn`, `selectedAgentID` and `selectedSection`. Its setter ran
  `model.selectedSection`, `openWorkspace`, `model.openMachineDraft` and
  `model.openProjectSessions(id, inColumn: true)` synchronously while the List applied the
  selection; `selectedSection`'s own setter runs `wiki.open(fromWorkspace:)` and
  `tasks.setSectionActive`, so one click wrote two more observable models inside the outline
  view's update.

After (this branch):

- `AgentListLogic.sidebarSections` returns the work rows as one array: the Wiki row is dropped
  there from the server's answer (`wiki:`), and every row carries the drawer's waiting count (0 is
  drawn hidden, not removed). `SectionSidebar` draws it with one `ForEach(sections) { row in
  sectionRow(row) }` and a fixed `HStack` per row.
- `AgentListLogic.sidebarRows` stays the one flat array it already was for the Workspaces group
  (workspaces, Set up rows, or one placeholder), one `ForEach`.
- `AgentListLogic.sidebarProjects` returns the open projects as one array with the drawer's mark
  (`ProjectDrawerMark`); one `ForEach(projects) { row in projectRow(row) }`. The group itself is
  still conditional — a group is not a row.
- `SectionSidebar` holds ONE stored `@State var selection: SidebarSelection?`. The navigation it
  asks for runs in `.onChange(of: selection)` after the List's update: `model.selectedSection`,
  `openWorkspace`, `model.openMachineDraft`, `model.openProjectSessions(id, inColumn: true)`. A
  second `.onChange(of: modelSelection, initial: true)` keeps deep links, ⌘N and notifications in
  step; a stored `applied` value stops a re-sync from re-running the actions.
- Every main feature is kept: the two `@AppStorage` groups and their expansion, the workspace
  settings sheet and its right-click menu, the ⌘1…⌘9 hints while ⌘ is held, the amber counts, the
  workspace rows and their state marks, the open-project rows and the folder column, the
  task-over-page behaviour, the search toolbar button and the footer.
- `SidebarSelection` and its mapping moved to OrbitKit (`SidebarLogic`), with tests for the stored
  value <-> section / agent / machine / project / nil.

`WikiWiringTests` (the source-text pin at `:501`) and `ProjectsWiringTests`'
`testTheMacSidebarIsTheDrawersRail` pinned the old shape (`if section != .wiki || …`,
`ForEach(AppSection.workSections)`, `ForEach(openProjects)`). They now pin the snapshot rows, the
Wiki answer as data, and the post-update `.onChange`, because the shape really changed.

## How the run was driven

`probe-harness/` builds the REAL macOS app from the shared sources (the probe replaces only
`OrbitApp.swift`, so it can drive the process from inside), points it at `stub.py` — a fake Orbit
server whose workspaces, machines, sessions, projects and wiki spaces keep changing (a workspace
joins and leaves a machine every 0.1 s, a machine with no workspace appears and disappears, an
agents read takes 0.2–0.8 s so a reload is in flight under the clicks, the Wiki section drops out
and comes back every fourth churn, and a control stream sends `agent.changed` every 0.3 s) — and
selects every row of the sidebar 200 times, never waiting for a reload to settle.

**Why the driver is inside the app.** `xcodebuild`'s UI-test runner refuses to initialise on this
Mac: *"The test runner failed to initialize for UI testing. (Underlying Error: Timed out while
enabling automation mode.)"* — `automationmodetool status` says Automation Mode is disabled and
requires the user's authentication. The session also refuses to make a launchd-started app active
(`NSApp.isActive == false`, `window.isKeyWindow == false`) and CGEvent posting is denied
(`CGPreflightPostEventAccess() == false`), so posted mouse events are swallowed as the activation
click. The driver therefore calls AppKit's row selection (`NSTableView.selectRowIndexes`), which
posts the same selection-change notification SwiftUI's list coordinator reads and runs the same
model side effects (the stub's request log shows it: selecting Wiki reads `/api/wiki/spaces` and
`/api/wiki/spaces/w1/docs`, selecting Tasks reads `/api/tasks/page`, and so on). This is a
scripted click at the selection layer, not a WindowServer click. `MODE=ui` keeps the XCUITest
driver (`UITests/SidebarClickDriverTests.swift`) for a host whose Automation Mode is enabled; the
owner was asked to enable it, and it did not arrive during this run.

The app is launched into the logged-in user's Aqua session with a temporary LaunchAgent
(`launchctl bootstrap gui/$UID`), because the runner's own job has no WindowServer connection
(`!cgsConnection`) and a `WindowGroup` scene is never instantiated there; the probe therefore
creates the window with `NSHostingController` over the real `MainView`.

## Results

Run settings for both sides: `CLICKS=200 GAP=100 CHURN=0.1 WIKI_FLICKER=1
AGENT_DELAY_MIN=0.2 AGENT_DELAY_MAX=0.8`.

| Check | Result |
|---|---|
| `swift test`, OrbitKit, under the CI-like locale (AppleLocale=en_US, TZ=UTC; restored to en_CN afterwards) | **exit 0**, 4979 executed, 0 failures (5 skipped by design). The host's own locale (en_CN/Asia-Shanghai) makes the suite's fixed-timestamp formatting tests fail (24-hour or shifted times); that is the locale, not the change, and the tree is otherwise green under it too except those formatting assertions. |
| `xcodebuild` for macOS — scheme OrbitApp, Release, arm64 | **`** BUILD SUCCEEDED **`**, exit 0 (`macos-xcodebuild.txt`) |
| `xcodebuild` for the iOS Simulator — XcodeGen, Release, `CODE_SIGNING_ALLOWED=NO` | **`** BUILD SUCCEEDED **`**, exit 0 (`ios-xcodebuild.txt`) |
| control — 200 clicks on the beta.242 tree (`v0.1.2-beta.242` `3299e485a`, clean app sources; this is the build that crashed for the owner) | `DRIVER_DONE clicked=200 skipped=0 alive=true`; no new `Orbit*.ips`; the screen shows the real beta.242 rail (Projects, Tasks, Wiki, Workspaces, Projects 1). **The control did not reproduce the owner's crash.** |
| fixed — 200 clicks, same driver, same changing-data server, head `72aeac1ec` + this change | `DRIVER_DONE clicked=200 skipped=0 alive=true`; the app stayed in the foreground through the run; `reports-new.txt` is empty (no `Orbit*.ips` newer than the run start); `window.png` shows the ported rail drawing the same rows, workspaces, Set up row and open project as beta.242. |

## Not covered

- The control did not reproduce the beta.242 crash. The owner hit it once; the selection-layer
  driver (the only click path this session allows) does not force it, so the control is evidence
  that the harness runs the crashing UI, not that it can provoke the race.
- The owner's own `.ips` was not symbolicated here (it lives in the HPC session uploads).
