# The "this run never started" card, on the iPhone and the Mac

Task [macOS/iOS：会话页与项目页的「没跑起来」卡（OrbitKit/OrbitApp）](orbit-task:34bhbWV25AdxK0Z30EHQX),
part of the family [web：把「没跑起来」画出来](orbit-task:34bhbViUOlywBK9Il6n4w)
and [被拒的开工：同一事务里把这次运行收尾](orbit-task:34bhbVgdYajslnz4aXvVA).

A run whose engine never started has no transcript, so every card the app already draws is
unreachable: the transcript's repair cards come from turns that arrived, and the status glyph can
only say `Starting` while the row still holds a claim. `SessionRunStart` (OrbitKit) is the one
surface that answers "why is nothing happening", and `SessionRunStartCardView` (OrbitApp) is its
renderer — the app's existing repair-card shell, so this is a new reason rather than a new style.

## What the clients do now

- **The card.** `SessionRunStart.card(for:)` is pure logic in OrbitKit (no SwiftUI, so the tests run
  on Linux), and the session page draws it above the composer where the two engine-repair cards
  already sit. Two tiers, one card:
  - a session whose SOURCE was refused — `sourceState == REFUSED`, which is terminal (§6.1 T8) and
    says so from its own column whatever the run's status is, which is the whole point: the bug this
    card exists for is a refused session sitting on its claim forever, reading `Starting`. The card
    carries the code, the ref and the runner's own words the server wrote down, the prose §10.1's
    `fixAction` pairs with, and `Start it again` — SR34's recovery, a NEW run on the task;
  - any other session whose engine never started, from `session.error`: the runner went offline
    (the reaper's bare `runner offline`, read into the same word as `SessionStatusGlyph` and web),
    an engine that needs a newer runner (the server's claim sentence, with the release it names read
    out of the sentence rather than carried here), an engine this machine does not have (the
    runner's own install sentence), and `Send it again`, because the conversation itself is
    resumable.
- **Not recomputed here.** `fixAction` is the server's (`source_refusal_detail.fixAction`); nothing
  in the client derives an action from a code, which is what §10.1 pairs them to prevent (SR49).
- **The words.** Every sentence that already exists is READ from where it lives: the engine repairs
  from `EngineAuth`/`DshRuntime` (which mirror web's `Transcript.tsx` cards), the offline label from
  `SessionStatusGlyph`, the claim sentences from `runner-provider-support.ts`. The one sentence new
  to Swift is a refusal's next step, and it is the server's own `dispatchRefusalNextStep`
  (`tasks/task-dispatch-refusal.ts`) — the sentence the task's comment and the coordinator's message
  already give — ported, with `SessionRunStartCopyParityTests` reading that file back.
- **An engine that already has a card keeps it.** Antigravity and DeepSeek Harness repairs are drawn
  by `AntigravityRepairCardView`/`DshRepairCardView`, which carry machinery this card does not (the
  sign-in relay, the install poll). One fact, one card: `SessionRunStart` returns nil for those.
- **The project page.** A `SOURCE_UNRESOLVED` blocker (§10.3 SR50) draws the same headline the
  refused run draws — same `fixAction`, so the page and the run cannot tell two stories — under the
  tag its owner earns, with the blocker's code and ref and one line per affected task.

## Checks

| Check | Result |
|---|---|
| `swift test`, OrbitKit, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` (the task's own acceptance command) | **exit 0**, 3312 tests, 0 failures (main's 3291 + the 21 new ones in `SessionRunStartTests` and `SessionRunStartCopyParityTests`, and the blocker case added to `ProjectPageSectionsTests`). Run on this host, macOS 27/Xcode 27 |
| the iPhone probe (`run.sh`'s iOS pass, real `CompactShell` against `stub.py`) | every assertion in `ios/…-notes.txt` passed: the card, the ref, git's own words, `BASE_REF_NOT_FOUND`, `Start it again`, `Chat about this`, `Send it again`, the project page's code+ref and task row. The press sent `POST /api/tasks/T1/execute {"triggerId":"7JFpFKW3xNQWmibqz8pFpe"}` → 201 (`ios/ios-requests.txt`), which is SR34's recovery: a NEW run on the task |
| the Mac probe, on CI — `client.yml` dispatch run [37633043197](https://github.com/jianghailong-xy/orbit/actions/runs/37633043197), `macos-26`, branch `probe/source-refused-mac-shots` at `3441f5840` | both passes `** TEST SUCCEEDED **`, 0 failures (Mac 125 s, iPhone 114 s); `capture=success` (`ci/`). Every assertion in `mac/…-notes.txt` passed: the card, the ref, git's own words, `BASE_REF_NOT_FOUND`, `Start it again`, `Chat about this`, the project page's code+ref and task row. The press the phone pass makes on `Start it again` went through on the Mac too — `POST /api/tasks/T1/execute {"triggerId":"6MAFR8WY6DQUuRoUU0nm9C"}` → 201 (`mac/writes.txt`), SR34's recovery |

## Pictures (real app UI against `stub.py`)

The probe builds the iPhone app's `CompactShell` and the Mac app's `MainView` from the real shared
sources into throwaway apps pointed at a stub, and photographs what they draw. Three sessions, all
of which produced nothing: S1 a task session whose SOURCE was refused (the project's integration
line was never created), S2 an ordinary session the reaper ended, S3 an engine this machine does not
have. All data is made up.

| Step | iPhone (`ios/`) | Mac (`mac/`) |
|---|---|---|
| the refused run: the card, with the code, the ref and git's own words | `ios-1-refused.png` | `mac-window-S1.png` |
| `Start it again` pressed — a NEW run on the task | `ios-2-start-it-again.png` | the request log (`mac/writes.txt`); `mac-window-S1.png` is written after the press |
| the runner went offline: the same card, `Send it again` | `ios-3-offline.png` | — the Mac window had not drawn it before that launch ended |
| an engine this machine does not have, in the runner's words | `ios-4-not-installed.png` | `mac-window-S3.png` |
| the project page's `SOURCE_UNRESOLVED` blocker | `ios-5-project-blocker.png` | `mac-window-project.png` |

The Mac pictures are the run's artifact — `source-refused-shots`, republished to
`probe/source-refused-mac-shots-results` because artifacts need a token to download — and they came out
of the app's own window rather than off the screen, for a reason worth writing down. The CI Mac's screen
is 1024×768 (visible frame 1024×677): the session page lays its console out ~1564 points tall — the
"this run never started" card starts at y≈900, below the window, and it is the transcript's sibling
rather than something inside a scroll view, so nothing brings it back — and a TITLED window cannot be
taller than the screen (`NSWindow.constrainFrameRect`: 1700 asked for, 677 granted, every second of run
37625558501's `mac/sr-window-S1.txt`). So the probe's window goes borderless, which that constraint does
not apply to, and `-probe.shot` writes the window's own bitmap (`CGWindowListCreateImage`, no screen
capture and no chrome): `mac/sr-window-*.txt` has the frames it went through, 1010×677 → 1024×1700, and
the size of every picture written. Two consequences are in these files rather than hidden: the UI-test
runner cannot see a borderless window (`mac/…-notes.txt`: "no window to photograph"), so the XCUITest
pictures are absent from this run — the presses and the walks are still its, and the request log is
theirs; and the offline launch's window never drew before it ended, which is why that step has no Mac
picture while the phone's five cover all three tiers.

`ios-1-refused.png` is the whole answer to the report this card came from: the page that used to
say `Starting…` forever now says `Failed`, and under the message it says why — the code, the ref
that could not be resolved and git's own sentence, then the one press that goes on.

`probe-harness/` is what ran. It is kept here rather than built by this repository;
`project.yml`'s `../src` paths are relative to the repository root, so the harness is copied to a
directory at the root before it runs, as the crossings probe's was under `.xcross-probe/`.

The Mac half runs on CI: `client.yml`'s `source-refused-shots` job (dispatch-only, behind its
`source_refused_probe` input) stages this directory at `.sr-probe/`, runs `run.sh` on a `macos-26`
runner, and uploads `.sr-probe/shots` as the `source-refused-shots` artifact; the job beside it
republishes that artifact to `probe/source-refused-mac-shots-results`. The Mac that holds the branch
has no display and no automation grant, and no token to dispatch with, so the push to
`probe/source-refused-mac-shots` is turned into the dispatch by
`.github/workflows/probe-dispatch.yml` (temporary, like the job it starts: this is the one trigger that
host has). Re-running it means pushing to that branch with the wiring changed.

## Limits

- The pictures are against a stub, not a running apiserver: they show the app's own UI and the
  request it sends. That a refusal really is written the way the stub writes it is the server's
  (`source-freeze.pg.spec.ts` / `task-dispatch-refusal-visible.pg.spec.ts`) and is not re-tested
  here; `src/apiserver` is unchanged.
- The stub serves the three columns the card reads — `sourceState`, `sourceRefusalCode`,
  `sourceRefusalDetail` — as the session row stores them. The owner-facing session read does NOT
  carry them yet (neither `sessions.service.ts`'s list projection nor `realtime.service.ts`'s
  summary selects them), so against a real server today the card's refused tier has nothing to
  read and the machine tier falls back to what `error` says. Widening that read is the one piece
  this task's family still needs on the server side.
- **The Mac pictures are of the window, at a size the screen does not have.** `mac-window-*.png` are
  the window's own pixels written by the app, 1024×1700 on a 1024×768 screen, so no window chrome or
  menu bar is in them and no `screencapture` was involved — a screen capture there could only ever
  show the top 677 of those 1700 points, which is why the picture is taken this way. The window it
  photographs is borderless (`WindowFit`, for the reason above), so a real user's window would look
  different around the edges; the session page inside it is the same one. This host still cannot take
  the Mac pictures itself — no display for `screencapture` (`could not create image from display`),
  no automation grant for the UI-test runner (`Timed out while enabling automation mode`), both TCC
  grants only the owner can give — so they come from the CI run named above, and `mac-shot.sh` takes
  them here the moment a display works.

