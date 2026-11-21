# Drag a session row onto a folder — macOS visual evidence

Feature under test: `orbit/task-drag-a-session-onto-a-folder-to-mov-d20b34` at
`96c00c6cd23d3478ba3c404bdaefc2bf1327a7f0` (`src/macos/OrbitApp/Sources/OrbitApp/Views/SessionFolderDrop.swift`,
wired in `AgentsView.swift` `folderRow`/`sessionRow` and `SessionFolderPage.swift`).

These PNGs were taken by `OrbitAppTests/DragFolderShotsTests.swift` on a branch that is **not** the
feature branch (`probe/drag-folder-macos-shots-96c00c6`, one commit on top of `96c00c6cd2`). The
harness hosts the real `MainView` (three-column Mac shell, toast host included) in a titled
`NSWindow` via `NSHostingView`, against a local stub control plane (`stub.py` in this folder) — no
real Orbit server, no owner account, no Keychain, no installed-app defaults.

## Frames

| File | What it shows |
| --- | --- |
| `01-folder-row-highlight-while-dragging.png` | "Design docs" folder row lit with the indigo rounded highlight while the dragged row ("Drag evidence run") is dimmed at 50%. |
| `02-moved-toast-and-folder-count.png` | After the drop: toast `Moved to “Design docs”` (subtitle "Drag evidence run"), the row gone from the root list, and the Design docs count changed 1 → 2. |
| `03a-folder-page-head-highlight-no-folder.png` | On the folder page, the toolbar back button and the "Design docs / orbit" title both lit as the No Folder drop target, the dragged row dimmed. |
| `03b-moved-out-toast.png` | After dropping there: toast `Moved out of “Design docs”` and the row gone from the folder's list (only "Refactor the session move panel" remains). |
| `04a-list-scrolled-down-folders-out-of-view.png` | Setup for auto-scroll: the list scrolled to its bottom (21 rows), folders out of view. |
| `04b-autoscrolled-to-folders.png` | After holding the pointer at the list's top edge: the real 60 Hz timer scrolled the list back to the folders (clip origin y 150 → −40), and the folder under the pointer is lit. |
| `05-coordinator-row-over-folder-no-highlight.png` | The project/coordinator row ("Folder drag evidence") and the folder rows with nothing lit and nothing moved; a coordinator row is never a drag source (`SessionFolderDrag.draggable == false`). |

## What was real and what was simulated

This Mac has **no Accessibility and no Screen-Recording permission**
(`AXIsProcessTrusted() == false`; `screencapture` fails with "could not create image from display"),
so a real mouse drag and a real screen capture are both impossible here. There were **no real
mouse drags**. Within the running app:

* **Real:** the views, the folder/session rows, the highlight and dimming, the toast host and its
  text/dwell, `AppModel.moveSession` (the delegate's own call), the POST `/api/sessions/:id/move`
  it makes, the folder counts, the folder-page toolbar, and the auto-scroll timer/`edgeScrollStep`
  scrolling the real `NSScrollView`.
* **Simulated:** (a) the pointer state — `NSEvent.pressedMouseButtons` and `NSEvent.mouseLocation`
  are swizzled for the whole test process, because `SessionDragState`'s timer ends any drag whose
  button is up (without it the hover is cleared in the first tick); (b) pickup and hover — the
  harness sets `SessionDragState.begin(session)` and `hover = Target(folderID:)`, exactly what the
  drop delegate's `dropEntered` sets, and calls `AppModel.moveSession(...)` instead of
  `performDrop` (whose `DropInfo` cannot be constructed outside a system drag).

Nothing in the product was stubbed beyond its HTTP source: the app's real `MainView` is what is
drawn, and the AppModel is the app's own, signed in against the stub.

## Probe-branch-only source changes (harness, not the feature)

* `Sources/OrbitApp/Views/DragShotsProbe.swift` (new) — a weak registry so the harness can reach the
  private `@State` `SessionDragState` each list/page puts on screen.
* `AgentsView.swift` (`folderRow`) and `SessionFolderPage.swift` (`list`) — one `.onAppear` line each,
  registering that state.
* `AppModel.swift` — `init(tokenStore:)` with a default, so the harness can pass
  `InMemoryTokenStore()`. This was necessary: the first attempt with the real `KeychainTokenStore`
  blocked forever inside `SecItemCopyMatching` (this Mac answers no Keychain authorization prompt).
* `Tests/OrbitAppTests/DragFolderShotsTests.swift` (new) — the harness.

The feature itself is untouched: the highlight, the delegate and `moveSession` are `96c00c6cd2`'s.

## Reproduce

```sh
cd src/macos/OrbitApp
python3 ../../../drag-folder-macos-shots/stub.py 8765 /tmp/dragstub.log &   # from the repo root
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
export DRAG_STUB_URL=http://127.0.0.1:8765 DRAG_SHOTS_OUT=/tmp/drag-shots
swift test --filter DragFolderShotsTests
```

## Things that did not work / worth knowing

* No screen recording and no synthetic mouse input on this Mac (see above) — hence the harness.
* While building the harness, two capture artefacts were fixed rather than reported as bugs: the
  window needed to be key for the sidebar list to render, and scrolling had to go through the
  `NSTableView` (`scrollRowToVisible`) instead of moving the clip view directly, which left the
  virtualised rows blank.
* The feature itself behaved correctly in every state captured; no missing highlight, toast,
  count change or auto-scroll was observed.
