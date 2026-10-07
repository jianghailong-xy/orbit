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
| the Mac probe | **NOT TAKEN on this host** — see below |

## Pictures (real app UI against `stub.py`)

The probe builds the iPhone app's `CompactShell` and the Mac app's `MainView` from the real shared
sources into throwaway apps pointed at a stub, and photographs what they draw. Three sessions, all
of which produced nothing: S1 a task session whose SOURCE was refused (the project's integration
line was never created), S2 an ordinary session the reaper ended, S3 an engine this machine does not
have. All data is made up.

| Step | iPhone (`ios/`) |
|---|---|
| the refused run: the card, with the code, the ref and git's own words | `ios-1-refused.png` |
| `Start it again` pressed — a NEW run on the task | `ios-2-start-it-again.png` |
| the runner went offline: the same card, `Send it again` | `ios-3-offline.png` |
| an engine this machine does not have, in the runner's words | `ios-4-not-installed.png` |
| the project page's `SOURCE_UNRESOLVED` blocker | `ios-5-project-blocker.png` |

`ios-1-refused.png` is the whole answer to the report this card came from: the page that used to
say `Starting…` forever now says `Failed`, and under the message it says why — the code, the ref
that could not be resolved and git's own sentence, then the one press that goes on.

`probe-harness/` is what ran. It is kept here rather than built by this repository;
`project.yml`'s `../src` paths are relative to the repository root, so the harness is copied to a
directory at the root before it runs, as the crossings probe's was under `.xcross-probe/`.

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
- **The Mac pictures are missing, and it is the host, not the code.** This machine has no display:
  `screencapture` answers `could not create image from display`, and the UI-test runner never gets
  automation mode (`Timed out while enabling automation mode`) — both are TCC/display grants only
  the owner can give. The Mac app itself runs and renders against the stub (its own logs show the
  session read, `S1`'s console polling, and SwiftUI laying out), and the harness is ready to take
  the Mac half two ways: `run.sh` drives it on CI exactly as the crossings probe did on
  `macos-26` runners, and `mac-shot.sh` takes it here the moment the display works. Until then the
  Mac half of the evidence is unproven; the shared view is why the iPhone's five are still
  evidence for both (the iOS target compiles `OrbitApp`'s own sources, `ConsoleView` and
  `SessionRunStartCardView` included).

