# TEMPORARY evidence probe — Start this project? / Confirm the new criteria? on iOS and macOS

Task 34X0DqKHvV9ZZ1cVi6ZRt (project 34WzvgkHWbY1VwXmSPUZi, criterion 8). Lives only on the `-shots`
branch; never merged.

`gen.py` copies the real view code out of the commit under test — `ApprovalCards.swift`'s card language
and everything from "the record a confirmation leaves" to "the two cards a project's OWNER answers",
`ProjectStartedCardView.swift`, `Typography.swift`, `Platform.swift` — into a throwaway iPhone app
(`ios/`, photographed by a UI test that scrolls, opens the Tasks land on menu, picks from it and presses
Start / Confirm) and a macOS executable (`macos/`, one real window per conversation). `shared/` holds
the stand-in console — the members the cards read and press, each answered by OrbitKit's own
derivations over the mocks' data (board1-start-ios, board4-criteria-change) — and the probe's root.
