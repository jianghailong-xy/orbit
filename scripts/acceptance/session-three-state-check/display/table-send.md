| case | fields | send: web / apple / android | wait over: web / apple / android | state word: web / apple / android | task-run label: web / apple / android | disagree on | explained |
|---|---|---|---|---|---|---|---|
| status PENDING (queued) | new | SEND / SEND / turns | false / false / false | Queued / Queued / Queued | Queued / Queued / Queued | - |  |
| status PENDING (queued) | absent | SEND / SEND / turns | false / false / false | Queued / Queued / Queued | Queued / Queued / Queued | - |  |
| status RUNNING | new | SEND / SEND / turns | false / false / false | Running / Running / Running | Running / Running / Running | - |  |
| status RUNNING | absent | SEND / SEND / turns | false / false / false | Running / Running / Running | Running / Running / Running | - |  |
| status AWAITING_INPUT (held idle) | new | SEND / SEND / turns | false / false / false | Idle / Idle / Idle | Idle / Idle / Idle | - |  |
| status AWAITING_INPUT (held idle) | absent | SEND / SEND / turns | false / false / false | Waiting for your reply / Waiting for your reply / Waiting for your reply | Awaiting reply / Awaiting reply / Awaiting reply | - |  |
| status INTERRUPTED (held, stopped turn) | new | SEND / SEND / turns | false / false / false | Idle / Idle / Idle | Idle · Interrupted / Idle · Interrupted / Idle · Interrupted | - |  |
| status INTERRUPTED (held, stopped turn) | absent | SEND / SEND / turns | false / false / false | Interrupted / Interrupted / Interrupted | Interrupted / Interrupted / Interrupted | - |  |
| status SUCCEEDED (task run finished) | new | RESUME / RESUME / resume | true / true / true | Idle / Idle / Idle | Idle · Finished / Idle · Finished / Idle · Finished | - |  |
| status SUCCEEDED (task run finished) | absent | RESUME / RESUME / turns | true / true / true | Finished / Succeeded / Succeeded | Finished / Finished / Finished | SEND,WORD | defect F1: Android posts /turns to a released session; the server answers SESSION_ENDED (sessions.service.ts:7882); accepted, older server only (F3, F4, F6): WORD |
| status FAILED (released by a failed turn) | new | RESUME / RESUME / resume | true / true / true | Idle / Idle / Idle | Idle · Failed / Idle · Failed / Idle · Failed | - |  |
| status FAILED (released by a failed turn) | absent | RESUME / RESUME / turns | true / true / true | Failed / Failed / Failed | Failed / Failed / Failed | SEND | defect F1: Android posts /turns to a released session; the server answers SESSION_ENDED (sessions.service.ts:7882) |
| status CANCELLED (released by End) | new | RESUME / RESUME / resume | true / true / true | Idle / Idle / Idle | Idle · Ended / Idle · Ended / Idle · Ended | - |  |
| status CANCELLED (released by End) | absent | RESUME / RESUME / turns | true / true / true | Ended / Ended / Ended | Ended / Ended / Ended | SEND | defect F1: Android posts /turns to a released session; the server answers SESSION_ENDED (sessions.service.ts:7882) |
| running a job with no turn | new | SEND / SEND / turns | false / false / false | Running / Running / Running | Running · Background / Running · Background / Running · Background | - |  |
| running a job with no turn | absent | SEND / SEND / turns | false / false / false | Background process running / Background process running / Background process running | Awaiting reply / Awaiting reply / Awaiting reply | - |  |
| waiting on an approval | new | SEND / SEND / turns | false / false / false | Running / Running / Running | Running · Needs you / Running · Needs you / Running · Needs you | - |  |
| waiting on an approval | absent | SEND / SEND / turns | false / false / false | Waiting for approval / Waiting for approval / Waiting for approval | Running / Running / Running | - |  |
| on hold (queued, account paused) | new | SEND / SEND / turns | false / false / false | Queued / Queued / Queued | Queued · On hold / Queued · On hold / Queued · On hold | - |  |
| on hold (queued, account paused) | absent | SEND / SEND / turns | false / false / false | Queued / Queued / Queued | Queued / Queued / Queued | - |  |
| ended, runner never confirmed | new | RESUME / RESUME / resume | true / true / true | Idle / Idle / Idle | Idle · Ended / Idle · Ended / Idle · Ended | - |  |
| ended, runner never confirmed | absent | RESUME / RESUME / turns | true / true / true | Failed / Failed / Failed | Failed / Failed / Failed | SEND | defect F1: Android posts /turns to a released session; the server answers SESSION_ENDED (sessions.service.ts:7882) |
| old plain row stored SUCCEEDED | new | RESUME / RESUME / resume | true / true / true | Idle / Idle / Idle | Idle · Ended / Idle · Ended / Idle · Ended | - |  |
| old plain row stored SUCCEEDED | absent | RESUME / RESUME / turns | true / true / true | Finished / Succeeded / Succeeded | Finished / Finished / Finished | SEND,WORD | defect F1: Android posts /turns to a released session; the server answers SESSION_ENDED (sessions.service.ts:7882); accepted, older server only (F3, F4, F6): WORD |
| ending after an interrupted turn | new | BLOCK / BLOCK / ERR ENDING | false / false / false | Idle / Idle / Idle | Idle · Interrupted / Idle · Interrupted / Idle · Interrupted | - |  |
| ending after an interrupted turn | absent | CREATE / BLOCK / ERR ENDING | true / false / false | Ended / Ended / Ended | Ended / Ended / Ended | SEND,WAIT | accepted, older server only (F3, F4, F6): SEND,WAIT |
| parked, engine started its own turn | new | SEND / SEND / turns | false / false / false | Running / Running / Running | Running / Running / Running | - |  |
| parked, engine started its own turn | absent | SEND / SEND / turns | false / false / false | Waiting for your reply / Waiting for your reply / Waiting for your reply | Awaiting reply / Awaiting reply / Awaiting reply | - |  |
| parked, sub-agent running | new | SEND / SEND / turns | false / false / false | Running / Running / Running | Running / Running / Running | - |  |
| parked, sub-agent running | absent | SEND / SEND / turns | false / false / false | Running Agent / Running Agent / Running Agent | Awaiting reply / Awaiting reply / Awaiting reply | - |  |
| parked, will wake (watch or wake-up) | new | SEND / SEND / turns | false / false / false | Idle / Idle / Idle | Idle · Will resume / Idle · Will resume / Idle · Will resume | - |  |
| parked, will wake (watch or wake-up) | absent | SEND / SEND / turns | false / false / false | Waiting to resume / Waiting to resume / Waiting to resume | Awaiting reply / Awaiting reply / Awaiting reply | - |  |
| unknown status, no capabilities, held | new | SEND / SEND / turns | false / false / false | Idle / Idle / Idle | Idle / Idle / Idle | - |  |
| unknown status, no capabilities, held | absent | RESUME / SEND / resume | true / false / false | Ended / Ended / Ended | Ended / Ended / — | SEND,WAIT,RUN | accepted, older server only (F3, F4, F6): SEND,WAIT,RUN |
| unknown status, no capabilities, released | new | RESUME / RESUME / resume | true / true / true | Idle / Idle / Idle | Idle · Ended / Idle · Ended / Idle · Ended | - |  |
| unknown status, no capabilities, released | absent | RESUME / SEND / resume | true / false / false | Ended / Ended / Ended | Ended / Ended / — | SEND,WAIT,RUN | accepted, older server only (F3, F4, F6): SEND,WAIT,RUN |
