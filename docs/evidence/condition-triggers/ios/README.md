# Condition triggers on iOS: board frames 2 to 6 (task C6: iOS)

Each sheet sets the board frame (`docs/mocks/condition-triggers/01-board.png`) beside the real iPhone app drawing it.
The app is built from this branch's own sources, and every name, reading and time comes from the probe's fixture
API (`probe-harness/stub.py`, made-up data).
Run: https://github.com/jianghailong-xy/orbit/actions/runs/44172865456 (8 tests, 0 failures); see `RESULTS.txt`.

| Sheet | What it shows |
| --- | --- |
| `frame-2-task-create-card.png` | the task create card: Starts when (the condition, how it is checked, the command), Today, If never |
| `frame-3-schedule-create-card.png` | the schedule create card's When lines and command; the envelope card for a new probe command |
| `frame-4-scheduled-page.png` | "Waiting for a condition" above Today, each row's newest reading and its age, the gauge, "Can't read" under Needs you |
| `frame-5-run-header.png` | a run its condition started: "Fired 03:12 · 90.4% for 10 min · Check only" in place of a planned time |
| `frame-6-waiting-and-inspector.png` | Waiting on you (the can't-read card, the 30-day question); the inspector's Condition and How it checks blocks and its Fired / Ready again history |

`shots/` holds the raw pictures, each test's notes (every board phrase checked on screen), the requests the app
made that the fixture does not serve (`not-served.txt`), and `writes.txt` (no write but the fixture's own resets).
`shots/ios-7-task-waiting-line.png` is the Tasks line ("Waiting for: 3 or more OSDs are in").

Where the iPhone differs from the board, on purpose:
- the inspector's reading says "checked 1 min ago" without the board's "raw used": the condition's read carries no
  name for what is measured;
- the inspector's Condition section is titled "Condition": the schedule's name is the panel's own title above it;
- the task create card shows only the condition's three lines (Starts when, Today, If never) inside the existing
  task card; Runs in, May and Costs are not on the task card, as before;
- the Waiting on you cards carry the server's own words ("Can't read: Root disk below 5%"), not the board's sample.
