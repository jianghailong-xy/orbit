# Condition triggers on macOS: board frames 2 to 6 (task C6: macOS)

Each sheet sets the board frame (`docs/mocks/condition-triggers/01-board.png`) beside the real Mac app drawing it.
The app is built from this branch's own shared sources and its own `MainView`, and every name, reading and time comes
from the probe's fixture API (`probe-harness/stub.py`, the iOS probe's fixture, made-up data).
Run: https://github.com/jianghailong-xy/orbit/actions/runs/44202426640 (8 UI tests, 0 failures; OrbitKit `swift test`
on macOS 5554 tests, 0 failures; OrbitApp `swift build` complete); see `RESULTS.txt` and `shots/`.

| Sheet | What it shows |
| --- | --- |
| `frame-2-task-create-card.png` | the task create card in a conversation: Starts when (the condition, how it is checked, the command), Today, If never |
| `frame-3-schedule-create-card.png` | the schedule create card's When lines, command, Runs in, May, Costs and Today; the envelope card for a new probe command |
| `frame-4-scheduled-page.png` | the Scheduled timeline: "Can't read" under Needs you, "Waiting for a condition" above Today with each row's newest reading and its age and the gauge |
| `frame-5-run-header.png` | a run its condition started, in the column beside the timeline: "Fired 03:12 · 90.4% for 10 min · Check only" in place of a planned time |
| `frame-6-waiting-and-inspector.png` | Waiting on you (the can't-read card, the 30-day question); the inspector beside the timeline with Condition, How it checks and the Fired / Ready again history |

`shots/` holds the raw pictures, each test's notes (55 board phrases checked on screen, none missing), the requests the
app made that the fixture does not serve (`not-served.txt`), `writes.txt` (empty: the app wrote nothing), the files of
this project's C6 work the build compiled (`compiled-mac.txt`), and the macOS gate's summaries
(`summary-orbitkit-test.txt`, `orbitkit-condition-cases.txt`: 49 ConditionDisplay/ScheduleDisplay cases passed,
`tail-orbitapp-build.txt`). `shots/mac-7-task-waiting-line.png` is the Tasks line ("Waiting for: 3 or more OSDs are in").

The Mac follows the web board's layout for Scheduled (docs/mocks/scheduled-tasks/web): the timeline is a column, and the
inspector and a run's session open in the column beside it rather than over it. Where the Mac differs from the board's
phone frames, on purpose or as the iOS evidence already notes:
- the inspector's reading says "checked 1 min ago" without the board's "raw used" (the condition's read names no metric);
- the Waiting on you cards carry the server's own words ("Can't read: Root disk below 5%");
- the run's proposal is the session's ordinary tool approval card, as on iOS.
