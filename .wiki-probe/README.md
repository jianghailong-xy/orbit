# TEMPORARY — evidence probe, never merged

Task 34WV3yRVED4vASZH9pM4I (criterion 8 of Orbit Wiki · phase 2, every run) asks for iOS screenshots, and
a Linux session cannot draw SwiftUI. This directory lives only on the `…-shots` branch; the task branch
does not carry it.

- `gen.py` copies the app's real `Views/WikiView.swift`, `Views/WikiArticleView.swift` and
  `Views/Typography.swift` in whole, cuts `ApprovalActions` out of `ApprovalCards.swift`, and cuts the
  pure run page out of `WikiRunView.swift` (the screen that reads AppModel stays behind).
- `make_data.py` writes `ios/Sources/ProbeData.swift`: the reads shaped as the server answers them —
  the rows the web phone screenshots are drawn from. Review holds nothing, so every run is read by its
  own id (`GET /api/wiki/changesets/:id`).
- `ios/` is a throwaway iPhone app (one screen per `-screen` launch argument) and a UI test that opens,
  scrolls and photographs each screen.
