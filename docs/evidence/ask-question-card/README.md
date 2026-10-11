# Evidence: an answered agent question says what was asked and how it was answered

Design board: `docs/mocks/ask-question-card-ios/` (approved 2026-10-10). The owner chose to unfold the
card in place, to give web the same card, and to leave the Plan/Agent markdown size as it is.

## What changed

- **Folded**, the card is the record. It shows each question's opening (two lines for one question, one
  line each for several) and how the question was answered: the option picked, the words typed, or the
  reply given with Chat about this. The card no longer opens by itself.
- **Tapped**, it replays every question and option as asked, with descriptions, and ticks the pick.
- **OUTPUT** is shown only while the result cannot be read. Once read, it only repeats the replay.
- **Chat about this** comes back as the call's error. The card draws it as your reply: a grey bubble at
  the end of the row, your words in quotes, and "Replied in chat". It no longer shows a red cross and
  an ERROR panel.
- **Clipped calls.** A question card the server clipped is fetched whole while still folded.

How it is read: `src/shared/src/questionRecord.ts` (web) and
`src/macos/OrbitKit/Sources/OrbitKit/Transcript/QuestionRecords.swift` (iOS and macOS) read the result
text claude writes from Orbit's `updatedInput.answers`. Both are proved against
`src/shared/src/question-record.fixture.json`.

## Checks

| What | Result |
| --- | --- |
| `@orbit/shared` `questionRecord.spec.ts` (fixture: 17 outcomes, lines, leads, copy) | 21 passed |
| OrbitKit `swift test`, Linux `swift:6.1` (as CI's Swift core) | 3631 tests, 5 skipped (Linux perf, as on main), 0 failures |
| Web, whole suite (4 shards) | 387 files, 5095 tests, 0 failed |
| Web `tsc -b` | clean |
| macOS: OrbitKit `swift test` + OrbitApp `swift build` (macos-15, probe run 38022756625, at 4237003241) | 3633 tests, 5 skipped, 0 failures; build success |
| iOS: XcodeGen + `xcodebuild` for the simulator (probe run 38022756625) | success |
| Probe UI tests, iPhone and Mac, before and after (run 38022756625) | 6/6 on each, both trees |

## Pictures

- `web/compare-web-q*.png`: the real web `Transcript` before (main 539cca126) and after, as rendered
  and after a click on the row. The harness is `web-harness/`.
- `ios/compare-ios-*.png`: the real iPhone `CompactShell` against a stub API (probe run 38022756625).
  Columns: before (main 539cca126), after, after a tap on the row, and the lower half of the opened card.
- `mac/compare-mac-*.png`: the real Mac `MainView`, before, after, and after a click.
- The harness is `probe-harness/`, run on GitHub's macos-26.

The five conversations are the same on every client:
1. one question (the 10:14 screenshot's, word for word);
2. two questions;
3. words typed instead of an option;
4. a multi-select question;
5. a reply given with Chat about this.

What the probe found:
- **Cut-off descriptions (round 1, run 38018707522).** The iPhone replay cut each option's description
  at two lines with "…". d4dc11d89 lets every text in the replay take its whole height; rounds 2 and 3
  show it.
- **Stale row height on the Mac (round 2, run 38020631149).** An opened card kept its folded height
  while the transcript still fit the window, so the replay was clipped under the next message
  (`mac/mac-multi-select-row-height.png`, left). 4237003241 makes an opened tool card on the Mac ask
  the table behind the List to measure its row again; round 3 shows it (right).
- **Other cards.** Round 3 also clicked a folded Bash card on both trees. It opened correctly on both,
  but its output made the transcript scroll, so this probe doesn't show whether other cards had the
  stale height before. The re-measure applies to every tool card either way.
