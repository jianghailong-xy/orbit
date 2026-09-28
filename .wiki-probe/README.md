# TEMPORARY — evidence probe, never merged

Task 34WLbw9n3nICzxeptldmq (criterion 10 of Orbit Wiki · phase 2) asks for iOS screenshots of the Wiki's
article pages — the home with its Contents sheet, a topic's article with a footnote's card, Browse by
category and the A–Z index — and a Linux session cannot draw SwiftUI. This directory lives only on the
`…-shots` branch; the task branch does not carry it.

- `gen.py` copies the app's real `Views/WikiView.swift`, `Views/WikiArticleView.swift` and
  `Views/Typography.swift` in whole, and cuts `ApprovalActions` out of `ApprovalCards.swift`.
- `ios/` is a throwaway iPhone app (one screen per `-screen` launch argument) over `ProbeData.json` —
  the demo site's real articles and entries, the same rows the web screenshots were drawn from — and a
  UI test that opens, scrolls and photographs each screen, pressing a footnote and a topic's chevron.
