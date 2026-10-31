# A fact Orbit tells a session is one line (web, real browser)

Task `34pVGFQvGcjxSppunCWTK`; design `docs/mocks/coordinator-delivery-line/` (approved 2026-10-31).

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
