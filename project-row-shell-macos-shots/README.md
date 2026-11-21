# Draw a project's coordinator as a session row — macOS visual evidence

Feature under test: `orbit/task-draw-a-project-s-coordinator-as-a-s-51c056-macos`
(`SessionListRow` + `SessionRow` + `SessionProjectListRow`, and the drag preview in
`SessionFolderDrop.swift`).

These PNGs were taken by `OrbitAppTests/ProjectRowShellShotsTests.swift`, a probe harness that
hosts the real `MainView` (three-column Mac shell) in a titled `NSWindow` via `NSHostingView`,
against the local stub control plane (`stub.py`) — no real Orbit server, no owner account, no
Keychain, no installed-app defaults.

The stub has, in the workspace's Open list: a **pinned project** ("Session row shell", its
coordinator pinned), a **non-pinned project** ("Project row follow-ups"), a **coordinator-less
project** ("Coordinator-less project", one TASK member and no coordinator session), two **plain
sessions** ("Pinned plain session", pinned, and "Plain session without a pin") and two **folders**
("Bug fixes", "Design docs").

## Frames

| File | What it shows |
| --- | --- |
| `before-01-session-list.png` | BEFORE, at parent commit `eae1745321`: the list with a pinned project row, a non-pinned project row, the coordinator-less project row ("No coordinator"), plain sessions (one pinned) and the folder rows. The project row is the separate `SessionProjectRowView` button, untagged in the List's selection. |
| `after-01-session-list.png` | AFTER (this branch): the same list and the same product copy, with every row drawn through the one shell. |
| `after-02-project-row-selected.png` | AFTER: the pinned project's row selected natively (`AppModel.selectedAgentSessionID = coordinator id`). Its tag is the coordinator's id, so arrow-key selection opens the coordinator in the detail column — design §4.3's arrow rule. A click still opens the project's sessions page. |
| `after-03-folder-row-lit-while-dragging.png` | AFTER: a plain session picked up (`SessionDragState.begin`) over the "Design docs" folder (`hover`), so the folder row wears the drop highlight and the source row is dimmed at 0.5. The project row is now a drag source through the same shell. |
| `after-04-drag-preview-card.png` | AFTER: `SessionDragPreview` rendered by `ImageRenderer` exactly as `onDrag(_:preview:)` gets it — the 200×~25pt card at its leading/top padding inside a 432×83pt transparent preview. |
| `after-04b-drag-preview-card-cropped.png` | The same render cropped to the card: title on one line, rounded pill, thin outline, light shadow. |
| `after-05-drag-preview-composite.png` | AFTER, code-driven composite: the lit list from (3), a pointer arrow drawn over the "Design docs" folder row, and the preview image from (4) drawn centred on the pointer — how macOS places a SwiftUI drag preview. The card's top-left therefore lands ~16pt below-right of the arrow's tip, leaving the arrow and the folder's highlight visible. |

## How the card's placement was established

Apple documents `onDrag(_:preview:)`'s preview as centred, and the task's own instruction is to
pad the preview given where macOS puts it relative to the cursor. `SessionDragPreview` pads its
leading/top edges by `cardWidth + 2×offset` / `cardHeight + 2×offset`: a preview centred on the
pointer then has the card's top-left exactly `offset` (16pt) down-right of the pointer, the same
wherever on the row the drag began. `after-05` draws the preview image that way.

**Confidence:** medium. The implementation is exact under the "preview centred on the pointer"
model; that model is Apple's documented behaviour and the task's stated model, but it was not
measured against a live drag this Mac cannot perform (no Accessibility or Screen-Recording
permission). If macOS instead anchors the preview at the grab point, the transparent padding still
keeps the card out from under the pointer but the offset would vary with where the row was
grabbed. A live drag on a Mac with input permission is the check to run.

## What was real and what was simulated

This Mac has **no Accessibility and no Screen-Recording permission** (`AXIsProcessTrusted() ==
false`; `screencapture` fails), so a real mouse drag and a real screen capture are impossible.

* **Real:** the views, all rows, the project row's selection highlight and its coordinator opening
  in the detail column, the folder highlight, the row dimming, the drag preview rendering, and the
  bitmap capture of the app's own window.
* **Simulated:** the pointer state (`NSEvent.pressedMouseButtons`/`mouseLocation` are swizzled for
  the test process, because `SessionDragState`'s 60 Hz timer ends a drag whose button is up), and
  the pickup/hover (`DragShotsProbe` + `SessionDragState.begin`/`hover`, exactly what the drop
  delegate's `dropEntered` sets). No drop or move is performed.

## Probe-branch-only source changes (harness, not the feature)

* `Sources/OrbitApp/Views/DragShotsProbe.swift` (new) — a weak registry for the lists' drag state,
  the first folder row's frame, and the fake pointer state.
* `AgentsView.swift` (`folderRow`) — registers the list's drag state and the first folder row's
  frame when it appears.
* `SessionFolderPage.swift` — registers its page's drag state when it appears.
* `AppModel.swift` — `init(tokenStore:)` with a default, so the harness can pass
  `InMemoryTokenStore()` (a Keychain read blocks the test forever on this Mac).
* `Tests/OrbitAppTests/ProjectRowShellShotsTests.swift` (new) — the harness.
* `before-harness/ProjectRowShellBeforeShotsTests.swift` — the BEFORE harness. It is not part of
  this branch's test target (the source it photographs does not exist here); to reproduce the
  BEFORE shot, put it in a worktree at `eae1745321` with the same `AppModel` `init(tokenStore:)`
  patch, copy `stub.py` above it, and run it with the same environment.

## Reproduce

```sh
cd src/macos/OrbitApp
python3 ../../../project-row-shell-macos-shots/stub.py 8765 /tmp/project-stub.log &
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
export PROJECT_STUB_URL=http://127.0.0.1:8765 PROJECT_SHOTS_OUT=/tmp/project-row-shots
swift test --filter ProjectRowShellShotsTests
```
