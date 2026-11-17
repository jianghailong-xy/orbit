# Condition triggers on the Mac (evidence probe)

TEMPORARY evidence probe for task C6: macOS (project "Condition triggers"), adapted from `../../ios/probe-harness`.
It builds the Mac app's real shared sources (`src/macos/OrbitApp`, OrbitKit) and its own `MainView` with a probe entry
point (`mac/CtMacProbe.swift`, `ProbeArgs.swift`) that points the app's own `AppModel` at `stub.py` (the iOS probe's
fixture, unchanged), and `ConditionShotTests` drives the app, one launch per surface:

| Shot | Board frame | Surface |
| --- | --- | --- |
| `mac-2-task-card.png` | ② | a conversation's task create card: Starts when, the command, Today, If never |
| `mac-3-schedule-card.png` | ③ | a conversation's schedule create card: When, the re-arm and check line, the command |
| `mac-3b-widen-card.png` | ③ (§6.1) | the envelope card for a new probe command |
| `mac-4-scheduled.png` | ④ | the Scheduled timeline: Needs you with "Can't read", "Waiting for a condition" above Today |
| `mac-5-run.png` | ⑤ | a run its condition started, in the right-hand column: "Fired 03:12 · 90.4% for 10 min · Check only" |
| `mac-6a-waiting-on-you.png` | ⑥ | Waiting on you: the can't-read card and the 30-day question |
| `mac-6b-inspector.png`, `mac-6c-inspector-history.png` | ⑥ | the inspector beside the timeline: Condition, How it checks, history |
| `mac-7-task-waiting-line.png` | §6.2 | a task's page: "Waiting for: 3 or more OSDs are in" |

Every name, reading and time is made up (`stub.py`); no owner's data is read. It runs on GitHub's `macos-26` runner
from the probe branch `probe/condition-triggers-macos`, whose only client workflow is `client.probe.yml` (the harness
staged at `.ct-probe/`); the same workflow runs client.yml's macOS gate (OrbitKit `swift test`, OrbitApp
`swift build`). The results are pushed to `probe/condition-triggers-macos-results`. `compose.py` sets each picture
beside its board frame.
