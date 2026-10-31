# The owner's answer is the question's own card, grey once answered — iOS and macOS

Task [iOS/macOS: the owner's answer is the question's own card, grey once answered](orbit-task:34nGWN2Poh34ku8ad93Ud):
the Apple clients' mirror of the web change on main (4d68b90ee, landed in bfc8b6399). The design the owner
approved on 2026-10-27 is `docs/mocks/owner-answer-sent-card/merged.html` (m1-one-card.png, m2-queued-details.png)
and `tone.html` (t1-before-after.png, option 1); the web as built is in `docs/mocks/owner-answer-sent-card/built/`.
The code is the commit `feat(apple): the owner's answer is the question's own card, grey once answered`
(7f8e3ecf0 on the task branch).

## What changed

OrbitKit holds the rules and OrbitApp draws them; the iOS app compiles the same OrbitApp views, so both
clients change together.

- **One card.** The turn that hands the owner's answer to the coordinator (`ownerAnswer`, kind
  `COORDINATOR_QUESTION`) is drawn as the question's Answered card wherever the conversation holds that
  question's ended record: the records it draws, else the open-items read's `closedQuestions`
  (`ConsoleModel.answeredQuestions`, `CoordinatorQuestions.held`), compared by item in one spelling
  (`OwnerAnswer.itemKey`, the web's `answeredItemKey`). `TranscriptRows.build` then leaves the record out at
  the moment it was answered, for a turn echoed, accepted or still on the queue (`OwnerAnswer.handedOver`,
  the web's `answersHandedOver`).
- **States.** Waiting on the queue: dashed, with "Queued — the coordinator reads it when its current turn
  ends" (`CoordinatorQuestions.queuedForCoordinator`, held to the web's `QUEUED_FOR_COORDINATOR` in
  `OwnerItemCardsTests`) and no Cancel. Unconfirmed: "The session has not confirmed it received this."
  View details folds "What the coordinator was told" at the foot of the sheet, with the words verbatim and
  whatever delivery appended (`ConsoleModel.questionTold`).
- **Unchanged.** A Not yet… to a request to record the project done (`DONE_REQUEST`), and a question whose
  record the conversation does not hold, keep the line "Sent to the coordinator · 11:41 ›".
- **Colour.** The answered card leaves the blue for the app's neutral grey frame — the one the queued
  evidence card wears, this client's counterpart of the web's neutral frame — with a grey chip and the answer
  ticked green. The open question card stays blue, and so does the sheet's ticked option, as on the web.

## How it was checked

- **OrbitKit `swift test`** in docker `swift:6.1` (CI's Swift core job) on 7f8e3ecf0: 4090 tests, 5 skipped
  (the PerfBaseline tests, which always skip on Linux), 0 failures. New: `OwnerAnswerTests` (seven cases
  under "the question's own card"), `OwnerAnswerCopyParityTests.testTheWebDrawsTheQuestionsOwnCardWhereItHoldsTheRecord`
  (the rule held to `OwnerAnswerLine.tsx`, `lib/ownerAnswer.ts` and `WorkspaceView.tsx`),
  `OwnerAnswerCardWiringTests` (the view half, read from source), and the `QUEUED_FOR_COORDINATOR` pair;
  `CoordinatorQuestionRecordTests` follows the record view's new call.
- **Client CI**: the unchanged `client.yml`, dispatched once on `probe/owner-answer-card-gates` (= 7f8e3ecf0),
  run [40542095261](https://github.com/jianghailong-xy/orbit/actions/runs/40542095261): macOS (OrbitKit
  `swift test` + OrbitApp `swift build`), iOS (XcodeGen + Simulator build), font tokens and navigation all
  passed.
- **iPhone**: run [40541849876](https://github.com/jianghailong-xy/orbit/actions/runs/40541849876) on
  `macos-26`, iPhone 17 Pro simulator: the real app's `CompactShell` and shared views against a fixture API
  (`probe-harness/`), seven UI tests, 0 failures (`probe-results.txt`). Each test fails, rather than notes,
  when the app draws a second card, a card where the line should be, the line where the card should be, a
  Cancel on the queued card, or the told words before the fold is opened; the app made no writes.
- **Android** reads five lines of `OwnerAnswer.swift` (`OwnerAnswerCopyParityTest.kt`); that file only
  gained lines, and all five are still there.

## Pictures

| File | What it shows | Web counterpart |
|---|---|---|
| `board-web-vs-iphone.png` | The three acceptance states, the web as built on the left, the iPhone on the right | `built/1`, `built/3`, `built/4` |
| `ios-1-one-card.png`, `ios-1b-the-card.png` | The coordinator was idle: one grey Answered card where the line used to be, between the coordinator's message and its reply; no "Sent to the coordinator" | `built/1-one-card.png` |
| `ios-2-queued.png`, `ios-2b-the-queued-card.png` | The coordinator was busy: the card waits at the tail, dashed, with the Queued line; no Cancel | `built/3-queued.png` |
| `ios-3a-details-folded.png` | View details: the question, its options with the answer ticked, "What the coordinator was told" folded, the footer | — |
| `ios-3-details.png` | The fold opened: the words the coordinator was told, verbatim, above "Answered by you · 11:52 / Delivered to the current coordinator" | `built/4-details.png` |
| `ios-4-not-yet-line.png` | A Not yet… to a done request keeps the line | — |
| `ios-5-unheld-line.png` | A question whose record the read does not carry keeps the line | — |
| `ios-6-unconfirmed.png` | The session has not confirmed it received the answer: the card says so | — |
| `ios-7-one-card-dark.png` | The card in the dark | `built/5-dark.png` |

## Where it differs from the web

- The fold is SwiftUI's `DisclosureGroup`, the control the app's other "What the … was told" folds use (the
  exception card's and the task card's). On iOS it draws this heading in the tint, light blue, where the
  web's summary is grey. Grey is a one-word change (`.foregroundStyle(Color.secondary)`) if it is wanted.
- The record's times are the receipts' fixed 24-hour clock ("11:52"), the web's follow the browser
  ("11:52 AM"), as they did before this change.
- What reads as unconfirmed is the row's existing rule for every card, the line included: a delivery that
  failed, or a turn drained undelivered. The web also counts a delivery its runner reported `unconfirmed`.
  This change does not touch that rule.
- The probe's conversation is the board's sample, rebuilt from the screenshots (the web's capture fixture
  is not in the repo): the question, its options and the times are the same, the turns around them are
  shorter, and the busy coordinator shows its running turn through the composer's stop button rather than
  "Working for 35m".
- The Mac app was compiled in CI (the macOS job) but not photographed.
- In `ios-3-details.png` the probe's scroll helper noted that the words never fitted its 120–680 pt band:
  the sheet had reached its end, with the words whole above the pinned footer.

## Reproducing the pictures

`probe-harness/` is `.oac-probe/` as it ran, plus `client.probe.yml`, the probe branch's workflow. Copy the
harness to the repository root as `.oac-probe/` and run `run.sh` on a Mac with Xcode and XcodeGen, or push
it as the probe branch was pushed: `probe/owner-answer-card` (2d1ad74ff) is 7f8e3ecf0 plus the harness, with
`client.probe.yml` as `.github/workflows/client.yml`. The results branch is
`probe/owner-answer-card-results` (310c05cc4). All data in the fixture is made up.
