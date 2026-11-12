# iOS bottom session search: search mode ends only at the X (as in Notes)

Board: `docs/mocks/ios-search-mode-like-notes/01-board.html`. Fix: `BottomSearchMode` in
`src/macos/OrbitApp/Sources/OrbitApp/Views/SessionListSearch.swift`.

Probe: `probe-harness/` (iPhone 17 Pro Max, iOS 26.5 simulator, GitHub `macos-26`), run on the
`probe/ios-search-mode` branch with `probe-harness/ci/client.probe.yml` as its `client.yml`.
Round 6, run 43217646214 at 7c3dc1c81: 5 tests, 0 failures.

| Shot | What it shows |
| --- | --- |
| `shots/scroll-a-opened.png` | search opened: field above the keyboard, X beside it |
| `shots/scroll-b-after-swipe.png` | after a scroll: keyboard down, field still open at the bottom with its X |
| `shots/tap-b-after-tap.png` | after a tap on the list's empty space: same |
| `shots/push-c-back.png` | an empty search, a session opened and back: search mode kept, no keyboard |
| `shots/query-e-back.png` | a query (`ledger`) kept across a result opened and back |
| `shots/close-b-after-x-keyboard-up.png` | the X with the keyboard up: search mode ends |
| `shots/query-f-after-x.png` | the X with a query: search mode ends, query cleared |

What the rounds measured (round 5 logged every `isPresented` write):
- With `isPresented` held by the view, iOS no longer ends search when the empty field loses focus.
- A `List` scroll does not lower the keyboard by itself; `.scrollDismissesKeyboard(.immediately)` does.
- The X is a `_UIButtonBarButton` in `FloatingBarHostingView`. With the keyboard down it writes
  `isPresented = false`; with the keyboard up it only lowers the keyboard and writes `true` twice.
  So a tap on the X (`SearchCloseTap`) ends search mode whatever iOS writes.
