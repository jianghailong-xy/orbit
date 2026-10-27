# Android: the owner's answer is the question's own card, grey once answered

The Android port of the web change 4d68b90ee (landed on main in bfc8b6399), to the design the owner
approved on 2026-10-27: `docs/mocks/owner-answer-sent-card/merged.html` (m1-one-card.png,
m2-queued-details.png) and `tone.html` (t1-before-after.png, option 1).

## What changed

In a coordinator conversation, the turn that hands the owner's answer to the coordinator (a user turn
whose payload carries `ownerAnswer`) drew one line, "Sent to the coordinator · 08:29", while the rail
under the transcript drew the Answered card for the same question. The owner reads "Answered" as "the
agent has my answer", so the conversation said it twice.

| | before | now |
| --- | --- | --- |
| the turn, when the conversation holds the question's ended record (`closedQuestions`, or an answer pressed here) | the line | that question's Answered card, in the turn's place |
| the same record in the rail | drawn | not drawn again (`AnsweredQuestions.leftToItsTurn`) |
| the turn still on the queue | the line, dashed box, Queued · Cancel | the card, dashed, saying `Queued — the coordinator reads it when its current turn ends`; no Cancel |
| delivery unconfirmed | the line plus `The session has not confirmed it received this.` | that sentence on the card |
| the words the coordinator was told | behind the line, in a dialog | folded under `What the coordinator was told` at the foot of the card's review |
| a Not yet… to a done request (`DONE_REQUEST`), a question the conversation does not hold | the line | the line, unchanged |
| the Answered card's colour | the question card's blue, dimmed | a neutral frame (the raised surface, a plain border), a grey icon box, the answer ticked green; the open question card stays blue |

Item ids are compared in one spelling (`ObjectId.canonical`), whichever each read was served, as the
web's `answeredItemKey` does: the device fixture serves the record under its public id while the turn's
card names the UUID.

## Captures (API 36 emulator, emulator-5554)

Each capture is the production app signed in to the test's own controlled HTTP fixture
(`MockWebServer` in `OwnerAnswerCardDeviceTest`), not a deployment. The sample conversation is the
board's, in English.

| state | web as built | Android | side by side |
| --- | --- | --- | --- |
| (1) one grey Answered card where the line was | `docs/mocks/owner-answer-sent-card/built/1-one-card.png` | `device/1-one-card.png` | `compare/1-one-card.png` |
| (2) queued: dashed, the Queued line, no Cancel | `built/3-queued.png` | `device/3-queued.png` | `compare/3-queued.png` |
| (3) the words the coordinator was told, in View details | `built/4-details.png` | `device/4-details.png` | `compare/4-details.png` |
| (1) in the dark theme | `built/5-dark.png` | `device/5-dark.png` | `compare/5-dark.png` |

What each journey checked is in `device-run/checks-*.txt` (38 checks, all PASS), among them: the card
is inside the turn's row, drawn once, and absent from the rail; no `Sent to the coordinator` text
anywhere; the queued line is the web's words and the queue's Cancel is gone; the review's fold opens
to the turn's words verbatim.

Where Android draws it differently from the web:
- The card's fill is Android's raised surface (`surfaceVariant`, the surface the decided evidence
  receipt is drawn on here) inside a plain border. The web's raised surface is white on a white page
  in light; in dark the two are nearly the same (#2b2b2e on the web, #292b2f here).
- Android's card head draws a tinted box with no glyph, as it did before this change; the web draws
  a `?`.
- Times are the device's 24-hour clock in its time zone (Asia/Shanghai).

## Unit tests

`gradlew test lintDebug assembleDebug` (the command `scripts/verify.sh` runs) on 7bc3184df, TZ=UTC:
3993 tests, none failed (core 283, app debug 1855, app release 1855), lint and assemble green. The
classes this change touches are listed in `device-run/gate-summary.txt`.

## How it was produced

- APKs: `:app:assembleDebug :app:assembleDebugAndroidTest` at 42748b55b, a clean tree
  (`device-run/build.txt`, `device-run/apks.sha256`).
- Device run: `INCREMENTS_CLASSES=OwnerAnswerCardDeviceTest src/android/scripts/increments-device-test.sh
  APP_APK TEST_APK OUT emulator-5554` (`device-run/summary.tsv`, `device-run/instrumentation.txt`).
- Sheets: `python3 kit/compare.py WEB_PNG ANDROID_PNG TOP BOTTOM OUT TITLE` with rows 300..1910 of
  the Android capture (the transcript) for 1, 3 and 5, and 180..2340 (the review sheet) for 4.
