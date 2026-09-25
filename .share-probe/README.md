# TEMPORARY — evidence probe, never merged

Task 34UozoiaJIsxCZj728bfe (T8 of the share-links project) asks for pictures of the iOS Share panel
and the ⋯ menus beside docs/mocks/share-links/07-mobile, and a Linux session cannot draw SwiftUI. This
directory lives only on the `…-shots` branch; the task branch does not carry it.

- `gen.py` cuts the real code out of the app's views: ProjectsView's `menu(_:_:)`, `readShareLink()`
  and its `.sheet(isPresented: $sharing)`; TaskDetailContent's ⋯ menu, its share-status `.task` and
  its sheet; ConsoleView's Share button, its macOS toolbar item and its sheet. `ShareSheet.swift` and
  `Platform.swift` are copied in whole. Only the pages around them are stand-ins.
- `stub_server.py` answers `GET | PUT | DELETE /api/{sessions|tasks|projects}/:id/share` with the
  mock's project (12 tasks, 29 comments, 13 runs and the coordinator, viewed 14 times, last 2h ago),
  a task whose link expires in a week, a shared session and one that is not.
- `ios/` is a throwaway iPhone app; a UI test opens each menu, presses Copy Link / Copy as Markdown,
  opens the panel, asks Access → Only you (and cancels at the question), and photographs each step.
- `mac/` opens the same ShareSheet in a real Mac window: from the session page's toolbar entry, and
  as the project menu's Share… opens it.
