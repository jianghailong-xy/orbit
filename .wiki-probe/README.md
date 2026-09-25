# TEMPORARY — evidence probe, never merged

Task 34UuATXITdpa10srM1WgK (T10 of Orbit Wiki · phase 1) asks for iOS screenshots of the Wiki beside
mocks 06–09, and a Linux session cannot draw SwiftUI. This directory lives only on the `…-shots`
branch; the task branch does not carry it.

- `gen.py` copies the app's real `Views/WikiView.swift` (the home page, the entry page and Review) and
  `Views/Typography.swift` in whole, cuts `ApprovalActions` out of `ApprovalCards.swift`, and cuts the
  drawer's work rows — Projects, Tasks and the new Wiki row, with the pill, metrics and surfaces they
  draw on — out of `CompactShell.swift` into `ios/DrawerProbe.swift.in`. The OrbitKit test fixtures
  (`WikiTestFixtures.swift`) are the data: the same reads the Swift tests decode.
- `ios/` is a throwaway iPhone app (one screen per `-screen` launch argument) and a UI test that opens,
  scrolls and photographs each screen, opening the space picker, the entry's ⋯ menu and Review's
  Reject menu, and paging Review to its RETIRE and web-derived AMEND cards.
