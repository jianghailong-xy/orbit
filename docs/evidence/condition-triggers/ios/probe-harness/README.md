# Condition triggers on iPhone (evidence probe)

TEMPORARY evidence probe for task C6: iOS (project "Condition triggers"). It builds the iPhone app's real shared sources
(`src/macos/OrbitApp`, `src/ios/Sources`, OrbitKit) with a probe entry point (`ios/CtProbe.swift`, `ProbeArgs.swift`)
that points the app's own `AppModel` at `stub.py`, and `ConditionShotTests` drives the simulator, one launch per
surface:

| Shot | Board frame | Surface |
| --- | --- | --- |
| `ios-2-task-card.png` | ② | a conversation's task create card: Starts when, the command, Today, If never |
| `ios-3-schedule-card.png` | ③ | a conversation's schedule create card: When, the re-arm and check line, the command |
| `ios-3b-widen-card.png` | ③ (§6.1) | the envelope card for a new probe command |
| `ios-4-scheduled.png` | ④ | the Scheduled page: Needs you with "Can't read", "Waiting for a condition" above Today |
| `ios-5-run.png` | ⑤ | a run its condition started: "Fired 03:12 · 90.4% for 10 min · Check only" |
| `ios-6a-waiting-on-you.png` | ⑥ | Waiting on you: the can't-read card and the 30-day question |
| `ios-6b-inspector.png`, `ios-6c-inspector-history.png` | ⑥ | the inspector's Condition and How it checks blocks, and its history |
| `ios-7-task-waiting-line.png` | §6.2 | a task's page: "Waiting for: 3 or more OSDs are in" |

Every name, reading and time is made up (`stub.py`); no owner's data is read. The stub logs every request and refuses
every write. It ran on GitHub's `macos-26` runner from the probe branch `probe/condition-triggers-ios`, whose only
client workflow is `client.probe.yml` (the harness staged at `.ct-probe/`); the pictures were pushed to
`probe/condition-triggers-ios-results`. `compose.py` sets each picture beside its board frame.
