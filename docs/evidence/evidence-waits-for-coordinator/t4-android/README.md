# Evidence waits for a paused coordinator · Android (T4)

Task "T4 Android: the queued card and Sent to the coordinator" (34cypwEhYze74kahKea9t) in project 34cygPTQe5LPUT7tdUAzG.
The board is `docs/mocks/evidence-waits-for-coordinator/` (iPhone); Android draws the same states with its own card system,
in the coordinator conversation's "Decisions and requests", where today's evidence card is drawn.

| File | State |
| --- | --- |
| `1-waiting.png` | The coordinator is paused on Claude's weekly limit (run FAILED, `retryAt` armed). The revision waiting for it is a card titled "Waiting for the coordinator" with its submission time, the task title, "Coordinator paused · weekly limit · resets 10/12 19:00" and "It goes to the coordinator when it’s back. You can still decide now.", and one press: Decide it myself. No needs-you bar. |
| `2-decide-it-myself.png` | After Decide it myself: today's evidence card opened in place (revision, criterion, claim, what is not established, cited checks), "It gets this when it’s back. Decide here only if you don’t want to wait." under the paused line, and Confirm done / Chat about this. |
| `3-sent.png` | The coordinator is back and the revision was delivered: one line "Sent to the coordinator · {time}" where the card was, after the delivery message in the transcript. |

## How they were made

- Test: `src/android/app/src/test/kotlin/io/orbitd/android/cards/CoordinatorQueueCardTest.kt`. Robolectric (SDK 29, native
  graphics, `w411dp-h1200dp-xhdpi`) runs the production Activity, AuthSession, RealtimeStore and session reader over a
  controlled server in the same file (`CoordinatorQueueServer`): the pending read answers `waitingOnCoordinator` or
  `sentToCoordinator` in the shape T1 serves, and the coordinator's own session carries the error text and `retryAt` the
  paused line is read from. Not a deployment and not a device.
- Times are the receipt clock (`OwnerReview.receiptTime`) in the JVM's zone, Asia/Shanghai on HPC: "19:00" today,
  "10/12 19:00" on another day. The other times in the shots are relative to the moment the test ran.
- The same test asserts each state on the drawn tree, the request Confirm done posts
  (`POST tasks/:taskId/evidence/decision` with `decidingSessionId` = the coordinator conversation, the revision and
  `CONFIRM`), and that nothing of the queue is counted: no needs-you bar beside a waiting card, "1 open question" once today's
  card is beside it, and the session row's "Needs you · 1" is the server's count.
