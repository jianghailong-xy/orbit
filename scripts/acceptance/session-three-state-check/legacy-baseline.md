# Legacy baseline: what each client draws with the session facts absent

Recorded from the code before any display change, by `legacyBaseline.test.ts` (web), `LegacyBaselineTests.swift` (OrbitKit) and
`LegacyBaselineTest.kt` (Android) over the 18 `newFields: false` rows of `fixture.json`. These tests compare against the
`legacy-baseline.<client>.json` files. `endReason` stays on the rows that had one: an older server sent it, and the legacy reading uses it.

| case | web icon / word | web run badge | Apple icon / word | Apple run badge | Android mark / word | Android run badge | group web / Apple / Android |
|---|---|---|---|---|---|---|---|
| status PENDING (queued) | clock-circle / Queued | Queued | clock / Queued | Queued | queued / Queued | Queued | Working / Working / Working |
| status RUNNING | loading / Running | Running | spinner / Running | Running | running / Running | Running | Working / Working / Working |
| status AWAITING_INPUT (held idle) | message / Waiting for your reply | Awaiting reply | message / Waiting for your reply | Awaiting reply | none / Waiting for your reply | Awaiting reply | - / - / - |
| status INTERRUPTED (held, stopped turn) | minus-circle / Interrupted | Interrupted | minus.circle / Interrupted | Interrupted | none / Interrupted | Interrupted | - / - / - |
| status SUCCEEDED (task run finished) | check-circle / Finished | Finished | checkmark.circle.fill / Succeeded | Finished | none / Succeeded | Finished | - / - / - |
| status FAILED (released by a failed turn) | close-circle / Failed | Failed | xmark.circle.fill / Failed | Failed | failed / Failed | Failed | Needs you / Needs you / Needs you |
| status CANCELLED (released by End) | check-circle / Ended | Ended | checkmark.circle / Ended | Ended | none / Ended | Ended | - / - / - |
| running a job with no turn | code / Background process running | Awaiting reply | terminal / Background process running | Awaiting reply | jobs / Background process running | Awaiting reply | - / - / - |
| waiting on an approval | pause-circle / Waiting for approval | Running | pause.circle / Waiting for approval | Running | needs-you / Waiting for approval | Running | Needs youWorking / Needs you / Needs youWorking |
| on hold (queued, account paused) | clock-circle / Queued | Queued | clock / Queued | Queued | queued / Queued | Queued | Working / Working / Working |
| ended, runner never confirmed | close-circle / Failed | Failed | xmark.circle.fill / Failed | Failed | failed / Failed | Failed | Needs you / Needs you / Needs you |
| old plain row stored SUCCEEDED | check-circle / Finished | Finished | checkmark.circle.fill / Succeeded | Finished | none / Succeeded | Finished | - / - / - |
| ending after an interrupted turn | check-circle / Ended | Ended | checkmark.circle / Ended | Ended | none / Ended | Ended | - / - / - |
| parked, engine started its own turn | message / Waiting for your reply | Awaiting reply | message / Waiting for your reply | Awaiting reply | none / Waiting for your reply | Awaiting reply | - / - / - |
| parked, sub-agent running | loading / Running Agent | Awaiting reply | spinner / Running Agent | Awaiting reply | running / Running Agent | Awaiting reply | - / - / - |
| parked, will wake (watch or wake-up) | eye / Waiting to resume | Awaiting reply | eye / Waiting to resume | Awaiting reply | watching / Waiting to resume | Awaiting reply | - / - / - |
| unknown status, no capabilities, held | check-circle / Ended | Ended | checkmark.circle / Ended | Ended | none / Ended | — | - / - / - |
| unknown status, no capabilities, released | check-circle / Ended | Ended | checkmark.circle / Ended | Ended | none / Ended | — | - / - / - |

## Tasks list pill (web `taskStatusLabel`; the task payload carries `queuedOnHold`)

| task | word |
|---|---|
| task running | Running |
| task queued, queuedOnHold absent | Queued |
| task queued, queuedOnHold false | Queued |
| task queued, queuedOnHold true | On hold |
| task open | Open |
| task failed | Failed |
