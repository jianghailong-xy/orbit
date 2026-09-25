# TEMPORARY — evidence probe, never merged

Task 34UozoN8ZCAtrykhEYa0k (T3 of the share-links project) asks for pictures of the macOS share
panel and the iOS project menu, and a Linux session cannot draw SwiftUI. This directory lives only
on the `…-shots` branch; the task branch does not carry it.

- `mac/` builds the app's real `ShareSheet.swift` and `Platform.swift` (copied in by `run.sh` at
  run time) plus ConsoleView's macOS toolbar item and the sheet it opens (cut verbatim out of
  `ConsoleView.swift` by `extract.py`) into a throwaway Mac app, points it at `stub_server.py`, and
  captures the window and its sheet for a session that is not shared (`new`) and one that is (`live`).
- `ios/` builds ProjectsView's real `menu(_:_:)` (cut verbatim out of `ProjectsView.swift` by
  `extract_menu.py`) into a throwaway iPhone app over stand-in types, and a UI test opens the menu,
  photographs it, presses Copy Link and reads the pasteboard back.
