# iOS and macOS: Create and start on the single-task create card

Task `34o9etf0IZ0t5oPbYGDz9`. When an agent files one task, the owner's card (`orbit_task_create`) now has a
second yes, **Create and start**. It sits right after Create it, in the bordered style, so Create it stays the
card's one filled answer. It is offered only when the card's input carries `acceptsStartAfterCreate: true` (the
server's word that the runner which filed it acts on the choice) and the server's forecast (`input.preview`) says
`needsManualStart` is 1, that is, a task nothing would start by itself. Its press sends the card's decision as
`{"behavior":"allow","startAfterCreate":true}`. Create it still sends `{"behavior":"allow"}`, with no
`startAfterCreate` key.

In code: OrbitKit's `Approvals.createAndStartAction`, `Approvals.offersCreateAndStart(toolName:input:)` and
`Approvals.createAndStartRequest` (`App/OrbitAskPreview.swift`), and `ApprovalDecisionRequest.startAfterCreate`
(`Models/DTOs.swift`, left out of the JSON when nil). In OrbitApp, `ToolApprovalCard` draws the button and
`ConsoleModel.decide(_:behavior:answers:remember:startAfterCreate:)` sends Create and start's body.

## Frames

These are the real iPhone `CompactShell` and Mac `MainView`, built from the shared sources on GitHub's macos-26
runner (macOS 26.6.2, Xcode 26.6; iPhone 17 Pro simulator, iOS 26.5) and pointed at `probe-harness/stub.py`.
The stub's conversation C1 waits on two cards, both marked `acceptsStartAfterCreate: true`. ap1 was filed with
startNow, so its forecast reads "1 starts running within the minute". ap2 is a task in no project with no
prerequisites: "1 needs a manual start". `probe-harness/UITests/CreateAndStartShotTests.swift` asserts each
state before its frame and fails on a missing one. It then presses each card's button and reads back from the
stub what the press sent. iPhone frames are 1206 × 2622; Mac frames are the window, 1010 × 737. Each frame is
in light and dark.

| Frame | What it shows |
| --- | --- |
| `ios-01-both-cards-light.png`, `-dark` | The tail of C1: the foot of ap1 (Create it, Chat about this) and all of ap2, whose answers stack Create it, **Create and start** right under it, then Chat about this |
| `ios-02-startnow-card-light.png`, `-dark` | After Create and start: ap2 is gone, and ap1, the card a startNow create raises, is left with Create it and Chat about this only |
| `mac-01-both-cards-light.png`, `-dark` | Both cards in the Mac window: ap1 with Create it and Chat about this, and ap2 with Create it, **Create and start** and Chat about this in one row |
| `mac-02-startnow-card-light.png`, `-dark` | After Create and start: ap1 alone ("1 pending"), with no Create and start |

What the presses sent, as the stub decoded them (keys sorted). It was the same on both platforms in both
appearances:

```
BODY /api/sessions/C1/approvals/ap2/decision {"behavior": "allow", "startAfterCreate": true}   <- Create and start
BODY /api/sessions/C1/approvals/ap1/decision {"behavior": "allow"}                              <- Create it
```

`probe-results.txt` has every line with the raw bytes beside it. Create it's carry no `startAfterCreate`.

## The run

The frames come from run [40830345204](https://github.com/jianghailong-xy/orbit/actions/runs/40830345204), push-triggered
on `probe/create-and-start-ios` at a974d3331. That commit is d63a15a5b plus this work's `src/macos` and
`probe-harness/`, with `probe-harness/ci/client.probe.yml` as `.github/workflows/client.yml`. Every job passed:

- client.yml's own gates: font tokens, navigation, macOS (OrbitKit `swift test` ran 4122 tests, 5 skipped,
  0 failures, and OrbitApp built) and the iOS simulator build;
- OrbitKit on the base commit: 4118 tests, 0 failures;
- the shots: one test per platform, each running light and then dark, passed on the iPhone and on the Mac.

An earlier run (40827181630), from before the `acceptsStartAfterCreate` amendment, passed on the iPhone. On the
Mac it lost the app on a harness query that asked every element for its value, after the press had been drawn
correctly. The harness no longer makes that query.

## Make them again

Copy `probe-harness/` to `.cas-probe/` at the repository root, because its `../src` paths are relative to
there. Then run `bash .cas-probe/run.sh` on a Mac with Xcode and XcodeGen. On CI, push a commit that carries the
harness to `probe/create-and-start-ios`, with `ci/client.probe.yml` as `.github/workflows/client.yml`. The
pictures come back as the run's `shots` artifact (`gh run download <run> -n shots`).
