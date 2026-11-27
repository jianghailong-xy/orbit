# Android, as built: the Sending… / Not sent bubble

Emulator frames of the bubble in an existing session, beside the owner-confirmed board
`../04-native-parity.html` (decisions of 2026-11-27). Pixel 10 Pro display (1280×2856 @480),
API 36, light, against the composer fixture (`src/android/scripts/composer-fixture.py`), from
`ComposerDeviceTest#sendingBubbleStates` on app code `a987e29baf` (`identity.txt`, dirty=false).

| Frame | State |
| --- | --- |
| `sending.png` | Right after Send, the POST held 6 s: dimmed bubble, `Sending…` in its foot, the box empty, Send a plain disabled arrow. |
| `sent.png` | Accepted: the ordinary bubble, once; the server's `Message queued.` above the box. |
| `not-sent-unanswered.png` | POST held 25 s: at 20 s the request is ended and the foot reads `⚠ Not sent · Retry · Put back in the composer`, the 20-second reason under it. |
| `echo-replaced.png` | The fixture took that message at 25 s: its echo replaces the Not sent bubble, drawn once. |
| `refused.png` | 409 "the session has ended": the same foot, the server's reason as one red line. |
| `put-back.png` | Put back in the composer: the words back in the box, the bubble gone, nothing sent. |

## New session's first message

Same device, display and fixture, from `ComposerDeviceTest#newSessionFirstMessageSendingBubbleStates` (`identity-new-session.txt`),
beside the board `../03-new-session.html`. The bubble is top-aligned, in the engine picker's place.

| Frame | State |
| --- | --- |
| `new-session-sending.png` | POST /sessions held 6 s: dimmed bubble, `Sending…`, the box empty and Send off; the session opens on the answer. |
| `new-session-not-sent.png` | Held 25 s: at 20 s the foot reads `⚠ Not sent · Retry · Put back in the composer`. Retry resends the same `clientRequestId`; the fixture holds exactly one session per id. |
