# TEMPORARY — evidence probe, never merged

Task 34WLbw7wH2Rvm3wWjft0t (criterion 8 of Orbit Wiki · phase 2) asks for iOS screenshots of the Wiki
settings, the Auto / Unreviewed / Web-derived marks with Confirm and Reject, one run with Revert run…,
and the challenge card's Re-confirm / Amend / Retire — and a Linux session cannot draw SwiftUI. This
directory lives only on the `…-shots` branch; the task branch does not carry it.

- `gen.py` copies the app's real `Views/WikiView.swift` and `Views/Typography.swift` in whole, cuts
  `ApprovalActions` out of `ApprovalCards.swift`, and cuts the pure pages out of `WikiSettingsView.swift`
  and `WikiRunView.swift` (the screens that read AppModel stay behind).
- `ios/` is a throwaway iPhone app (one screen per `-screen` launch argument) over `ProbeData.swift`
  — the same rows the web screenshots were drawn from — and a UI test that opens, scrolls and
  photographs each screen, opening the entry's Reject menu.
