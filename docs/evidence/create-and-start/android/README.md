# Android: Create and start on the single-task create card

Task `34o9etf0IZ0t5oPbYGDz9`. When an agent files one task, the owner's card (`orbit_task_create`) now has a second yes,
**Create and start**. Both of these must hold for it to be offered:
- the server's forecast on the card (`input.preview`) says `needsManualStart` is 1, that is, a task nothing would start by itself;
- the server marked the card `input.acceptsStartAfterCreate: true`, which means the runner that filed it acts on the choice. An
  older runner or server leaves the mark out, and on such a card the press would only create the task.

Like every door, it is offered only while the card is pending and unexpired. It sits right after Create task and before Chat
about this. On Android every door of this card is an outlined button, so it is never the primary one. Its press posts the card's
own decision with `{"behavior":"allow","startAfterCreate":true}`, and Create task still posts `{"behavior":"allow"}`, with no
`startAfterCreate` key.

## Frames

The frames were drawn by the production `MainActivity` (sign-in, session page, transcript and the card's doors) under
Robolectric, with `GraphicsMode.NATIVE` and `decorView.draw`, on a 411 × 891 dp phone at xhdpi (822 × 1782 px). The server is
`ComposerShell`, the controlled server the app's composer tests use, so no deployed server, account or runner was involved. Each
scene has a light frame and the same frame in dark (`-dark.png`). Both cards carry `acceptsStartAfterCreate: true`, so the door
missing from scene 3 is missing because of the forecast alone.

| Frame | What it shows |
|---|---|
| `1-offered-light.png` | The card for a task in no project and with no prerequisites. The forecast row reads `1 needs a manual start` / `Nothing will trigger it`, and the doors are Create task, **Create and start**, Chat about this. |
| `2-create-and-start-pressed-light.png` | After pressing Create and start, the card reads `Allowed · recorded by the server`. The controlled server recorded `{"behavior":"allow","startAfterCreate":true}` (`1-offered-light-decision.txt`). |
| `3-not-offered-light.png` | The card a `startNow` create raises. The runner wrote a due `runAt` before asking, so the forecast reads `1 starts running within the minute`. The doors are Create task and Chat about this, with no Create and start. |
| `4-create-task-pressed-light.png` | After pressing Create task, the server recorded `{"behavior":"allow"}`, with no `startAfterCreate` key (`3-not-offered-light-decision.txt`). |

The kit asserts what each frame shows before taking it: the forecast row, whether the Create and start door exists, and the
exact body that reached `POST sessions/:id/approvals/:approvalId/decision`.

## Make them again

From the repository root, the kit (`kit/src/CreateAndStartShotsTest.kt`) is compiled into the app's unit tests by an extra init
script, so nothing under `src/android` changes:

```bash
bash src/android/gradlew -p src/android -I docs/evidence/create-and-start/android/kit/kit.gradle \
  :app:testDebugUnitTest --rerun --tests 'io.orbitd.android.cards.CreateAndStart*ShotsTest'
```

The frames, their semantics trees and the decision files land in `src/android/build/evidence/create-and-start-android/`.

## Checks

Each run used `/mnt/data/cas-android/g.sh`, which runs `src/android/gradlew -p src/android --no-daemon --max-workers=2` with
build directories on `/mnt/data` and in-process Kotlin, inside a 7 GB memory scope. All runs were on code with the amended
predicate (forecast and mark).

| Job | Command | Result |
|---|---|---|
| `bgj_392452b62512` | the kit's init script added; `:core:test --rerun --tests …CreateAndStartCardTest --tests …CardContractTest :app:testDebugUnitTest --rerun --tests …CreateAndStartCardShellTest --tests '…CreateAndStart*ShotsTest' --continue` | exit 0. `CreateAndStartCardTest` 10/10, core 23/23 in all; app 7/7 (`CreateAndStartCardShellTest` 3, and the 4 scenes that made these frames) |
| `bgj_b6a8d23bcc15` | `:core:test --rerun :app:testDebugUnitTest --rerun --continue` (no kit) | exit 0. core 296 passed, app 1925 passed; no failures, no skips |
| `bgj_5fe752f62fe0` | `:app:lintDebug` | exit 0. No errors; 43 warnings and 2 hints, none in the changed files |
