# TEMPORARY evidence probe — never merged

iOS 26 draws a session row's `.swipeActions` as 60×47 squashed capsules (the system's slot is 60pt
wide and the ~75pt row leaves 47pt under the title). The owner picked round buttons with the title
kept underneath (mock B), which the app now draws itself on iOS 26 (`RowSwipeActions.swift`).

This probe builds the iOS app's shared sources into a throwaway app over fixture sessions and lets a
UI test photograph and drive the list on the newest iOS simulator:

- `native` — the shipped rows with the system's `.swipeActions` (the "before", and the row height to keep)
- `open` / `completed` / `trash` — the real `sessionRowActions` on each tab (the circles)
- `three` — the circles with three trailing buttons (Share / Move / Delete, as a parallel change adds)
  and every action written to an on-screen log, for the behaviour checks

`-dark` switches the appearance. Fixture titles are made up; nothing here is real data.
