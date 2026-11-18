# Condition triggers on Android: board frames 2 to 6 (task C6: Android)

Each sheet sets the board frame (`docs/mocks/condition-triggers/01-board.png`), the iPhone's picture of the same frame
(`../ios/shots/`) and the Android app's, side by side. The Android pictures are drawn by the production composables in
Robolectric NATIVE graphics on a 411×891 dp phone (`src/android/app/src/test/kotlin/io/orbitd/android/schedule/ConditionShotsTest.kt`),
over the real wire: a loopback server holding the iOS probe's made-up data (`../ios/probe-harness/stub.py`), read through
`AuthSession`, `ScheduleApi`, `ScheduledStore` and `OwnerRequestStore` as the app reads it, in Asia/Shanghai. Each test checks
the board's words on screen before it takes its picture.

| Sheet | What it shows |
| --- | --- |
| `frame-2-task-create-card.png` | the task create card: "Create task that starts on a condition?", Starts when (the condition, how it is checked, the command), Today, If never |
| `frame-3-schedule-create-card.png` | the schedule create card's When lines and command; the card for a new probe command (Now / Asked, both verbatim, "Keep the approved command") |
| `frame-4-scheduled-page.png` | "Waiting for a condition" above Today, each row's newest reading and its age, the gauge, "Can't read" under Needs you |
| `frame-5-run-header.png` | a run its condition started: "Fired 03:12 · 90.4% for 10 min · Check only" in place of a planned time, and its report |
| `frame-6-waiting-and-inspector.png` | Waiting on you (the can't-read card with Pause / Look into it, the 30-day question with Keep waiting / Stop); the inspector's Condition and How it checks blocks and its Fired / Ready again history |

`shots/` holds the raw Android pictures, each with its semantics tree, and `shots/extra-task-waiting-line.png`, the task's
waiting line ("Waiting for: 3 or more OSDs are in", "2 in · 3 min ago"). Rebuild the sheets with
`python3 compose.py docs/mocks/condition-triggers docs/evidence/condition-triggers/ios/shots docs/evidence/condition-triggers/android/shots docs/evidence/condition-triggers/android`.

Pushes: a condition that cannot be read rings as the new `condition` kind (apiserver `notifyCondition`), now in
`PushMessage.kt`'s kinds and its `when`, on the needs-you channel; a firing rings as its run's `schedule` FINDING. Both are
samples of `src/shared/src/android-push.fixture.json` (`condition-unknown`, `schedule-finding`), pinned to the real sends by
`push.service.spec.ts`, parsed by `ConditionPushTest` and posted as notifications by `PushNotificationsTest`.

Where Android differs from the board, as the iPhone does:
- the inspector's reading says "checked 1 min ago" without the board's "raw used": the condition's read carries no name for what is measured;
- the inspector's section is titled "Condition": the schedule's name is the sheet's own title above it;
- the task create card shows the condition's three lines inside the existing task card; Runs in, May and Costs are not on the task card;
- the Waiting on you cards carry the server's own words ("Can't read: Root disk below 5%");
- the inspector history lists the made-up data in time order, so "Created" (four days ago, after the 03:12 firing) sits between Ready again and Fired.
