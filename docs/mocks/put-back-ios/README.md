# iOS: a message that never reached the engine, and Put back in the composer

Boards drawn over the iPhone 17 Pro simulator shot of the collapse-thin probe. The bubble text uses
stand-in fonts: Noto for PingFang, Nimbus for SF.

- `01-flow.png` shows the console today, the proposal, and the composer after Put back.
- `02-states.png` shows the line under a bubble in each state, today against the proposal, and the
  decisions that were open.

**Decided 2026-10-17 by the owner: as recommended.**

1. "Put back in the composer" sits in the line under the bubble, right after "Not delivered", styled
   as Withdraw and Cancel are.
2. "Couldn't confirm it was read" is said in the warning tone, as on web and Android. It offers no
   Put back: the engine may have acted on it, and putting it back invites doing the work twice.
3. A message known only from the server's receipt is drawn at the end of the tail with why it did not
   land, in the sender's words, and Put back. Put back also discards the receipt.
4. Put back is offered too for a message drained unrun when the run ended. iOS alone marks those
   "Not delivered"; web has no such case.

Code: `SteerDelivery.offersPutBack` and `failureExplanation`, and the receipt pass in
`TranscriptReducer.reconcileQueuedTurns` (OrbitKit); `ConsoleModel.putBack` and
`UserBubbleView`'s meta row (OrbitApp). Web parity: `Transcript.tsx`'s `UserBubble`,
`WorkspaceView.tsx`'s `QueuedTurnMeta` and `takeBackUndelivered`.
