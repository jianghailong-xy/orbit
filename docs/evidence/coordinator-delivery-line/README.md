# A fact Orbit tells a session is one line

Task `34pVGFQvGcjxSppunCWTK`; design `docs/mocks/coordinator-delivery-line/` (approved 2026-10-31).

## Web (real browser)

Each shot is the shipped `Transcript` rendered by the web's own export (`buildSessionHtml` in
`src/web/src/lib/sessionExport.tsx`) with the shipped `src/web/src/index.css`, opened in Chromium 1243
(playwright-core, device scale 2). The turn is an evidence delivery whose words are what
`buildCoordinatorDeliveryMessage` writes, followed by the coordinator's reply.

| File | What it shows |
| --- | --- |
| `web/before-1280.png`, `web/before-390.png` | The same turn with no `coordinatorDelivery` card: the owner's blue bubble, as every delivery was drawn before this change. |
| `web/after-1280.png` | With the card: one line, `Evidence revision 1 submitted: <task> · Sent to the coordinator · 11:30 AM ›`. The sentence ends in an ellipsis; the time is whole. |
| `web/after-open-1280.png` | The line opened: `What the coordinator was told`, the words verbatim, `Its task ↗`. |
| `web/after-390.png` | Phone width: two rows, the sentence first, `Sent to the coordinator · 11:30 AM` under it. |
| `web/after-undelivered-1280.png` | An echo with `delivery: failed`: `The session has not confirmed it received this.`, and no `Put back in the composer`. |
| `web/after-dark-1280.png` | Dark theme. |
| `web/after-counted-1280.png` | A short sentence (`All 9 criteria landed, Done held back`): a compact, centred pill. |

Measured in the same pages (line, sentence and time boxes): at 1280 px the line is 840 px wide, the sentence
is truncated and the time is whole on the same row; at 390 px the time sits below the sentence, both
starting after the arrow; the page has one owner bubble (the owner's own question), not two.

Not shown here, because the export draws neither: the queued state (dashed, `Queued for next turn` and
`Cancel`) and the sticky bar (`↑ From Orbit` and the sentence). Both are held by tests:
`QueuedUserTurn.test.tsx` and `WorkspaceView.stickyWake.test.tsx`.

## iPhone and Mac (the real apps)

Photographed on GitHub's macos-26 runner (Xcode 26.6) from the task branch merged with main: the iPhone
app's own `CompactShell` on an iPhone 17 Pro simulator (iOS 26.5), and the Mac app's own `MainView` on
macOS 26.6.2, each built from the tree's sources into a throwaway app pointed at a fixture API whose turns
were written by the apiserver's `buildCoordinatorDeliveryMessage` (`probe-harness/`). XCUITest found each
line by its words, opened it with the app's own tap and checked what it says before taking the picture.
The run, every job's result, the toolchains and the lines showing `CoordinatorDeliveryLineView.swift`,
`UserTurnRow.swift` and `ConsoleView.swift` compiled for both platforms are in `probe-results.txt`.

| File | What it shows |
| --- | --- |
| `ios/ios-01-line.png`, `ios/ios-01b-the-line-close.png` | The line on a phone: two rows (402 × 57 pt), the sentence cut short on the first, `Sent to the coordinator · 12:02 AM` on the second. |
| `ios/ios-02-sheet.png` | Opened: `What the coordinator was told`, the line's words, then the words the coordinator read, verbatim. |
| `ios/ios-02b-sheet-its-task.png` | The end of that sheet: `Its task ↗`. |
| `ios/ios-03-queued.png`, `ios/ios-03b-queued-close.png` | Still on the queue: the same line, dashed, with `Queued` and `Cancel` under it. |
| `ios/ios-04-undelivered.png` | An echo the session never confirmed: `The session has not confirmed it received this.`, and no `Put back in the composer`. |
| `ios/ios-05-sticky.png`, `ios/ios-05b-sticky-close.png` | Scrolled past the line: the top capsule reads `↑ From Orbit` and the sentence, not `Your question`. |
| `ios/ios-05c-sticky-pressed.png` | That capsule pressed: the transcript is back at the line. |
| `mac/mac-01-line.png`, `mac/mac-01b-the-line-close.png` | The Mac console beside the session list, where the line is 322 pt wide: two rows, as on a phone. |
| `mac/mac-01c-line-wide.png`, `mac/mac-01d-the-line-wide-close.png` | The source list folded away (645 pt): one row, the sentence cut short, the time whole. |
| `mac/mac-02-sheet.png` | The Mac sheet: `What the coordinator was told` and the words verbatim; `Its task ↗` was found in the same sheet, below the fold. |

What the probe found: the second run's Mac picture had the line on one row in that 322 pt console, with the
sentence cut to its first letter (`E · Sent to the coordinator · …`). `CoordinatorDeliveryLineView` now takes
the phone's two rows wherever one row cannot keep 160 pt of the sentence beside the whole time (88bc396fb).
The pictures above are from the run after that fix.

## Android (production composables)

`android/phone-line.png` and `android/sticky-header.png`, each beside its semantics tree, are drawn by
`CoordinatorDeliveryShotsTest` (Robolectric, native graphics, 411 dp wide) with the reader's own composables:
the line's two rows, their bounds asserted (the time under the sentence, both from the same edge), and the
reader's capsule once the line is scrolled past, `↑ From Orbit` and the sentence, with no `Your question`.
Run again on the branch merged with main, the test drew the sticky header pixel for pixel the same, and the
line the same apart from its time, which the test sets to an hour before the clock.
