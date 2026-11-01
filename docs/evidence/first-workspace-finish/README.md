# The setup card's finishing touches on web, iPhone/iPad/Mac and Android (rehearsal F1, F4, F5, F6)

Task `34pSMchIBHSRImnxiCxuk` of project `34pLjYBjU6ILsehatEjJs`. The findings are the end-to-end rehearsal's
(task `34pLtXwjTWRAHNTdIy9Kz`, comment `34pSHxeS62CTunO9mBTfi`); the server and runner half of F1 and F3 landed
before this task (`08739cf13`, `ae1f9e17b`): a machine approved a moment ago now reads `online: false`,
`lastHeartbeatAt: null`, `capabilities: []`, `engines: null` until `orbit run` first beats, and a folder check
wakes the runner.

Code: `195a1c9b3` (all three clients); `08ff62193` fixes the Apple probe harness only.

## What changed, the same on every client

| | Web (`src/web`) | OrbitKit / OrbitApp | Android |
|---|---|---|---|
| **F1** a machine never heard from is waited for | `isConnecting` (`lib/machineSetup.ts`): `online !== true && lastHeartbeatAt == null`. The card says `setupConnecting`; `setupUpdating` is only for a machine that is online and lacks `dir-probe/v1`. While the card is up the page reads `/runners` every 5 s, every 2 s while connecting (`SETUP_POLL_MS`, `SETUP_CONNECTING_POLL_MS`, an observer in `WorkspaceView`). The composer takes a first message to wait under the card while the machine connects (an offline one still says Runner offline, board 02). | `MachineSetup.isConnecting`, `refreshSeconds(for:)` (5 s / 2 s) drive `MachineDraftPage`'s loop; the card's notice reads `setupConnecting`. A draft's composer already held a message on an offline machine. | `MachineSetup.isConnecting`, `refreshMs` (5 s / 2 s) drive `MachineDraftComposer`'s loop; the card's notice reads `setupConnecting`. The composer already held a message. |
| **F4** the register suggestion survives the one slot | `FolderOptions` asks the register directory again once its question reads `idle` (replaced) and no other question of the card is `checking`, only while online (`useDirProbe`'s `again` made stable). | `DirProbeRelay.asksAgain(outcome, online:, otherWaiting:)`; `FolderOptions` bumps `registerAttempt` on it. | `DirProbeRelay.asksAgain`; `FolderOptionsSection` bumps `registerAttempt` on it. |
| **F5** the waiting line is seen whole | `RevealedOnArrival` wraps in `.msc-revealed` (`scroll-margin-bottom: 24px`, clear of the pane's 20px fade) and reveals again on any image `load` inside it. | (web only) | (web only) |
| **F6** a new folder's name is checked first | The name is asked at `<reposRoot>/<name>` once typing settles; `newFolderVerdict` / `newFolderPick`: nothing there → board's "Starts empty…", picked as a new folder; a directory → `setupNewFolderExists`, picked as that existing folder (sent as `workDir`); a file → `setupNewFolderIsFile`, Use stays off; no answer → "didn't answer. Check again". | Same rules (`MachineSetup.newFolderVerdict` / `newFolderPick`), a `newFolderQuestion` task in `FolderOptions`. The line moves under the name field (title, field, line: the web's order). | Same rules, a `newQuery` effect in `FolderOptionsSection`, the line under the field. |

## The new sentences (identical on all three clients)

Web `src/web/src/lib/machineSetupCopy.ts`, Swift `MachineSetupCopy.swift`, Kotlin `MachineSetupCopy.kt`. Parity is
held by `MachineSetupCopyParityTests` (OrbitKit reads the web file) and `MachineSetupCopyParityTest` (Android reads
the Swift file); both list the three new templates.

| Name | Sentence (`<machine>` is the machine's name) | Where it shows |
|---|---|---|
| `setupConnecting` | `Waiting for <machine> to connect. It can check folders and sign in as soon as it does.` | the card's notice while the machine has never beaten (F1) |
| `setupNewFolderExists` | `This folder already exists on <machine>. Sessions will use what’s in it.` | under A new folder when its name is a folder on the machine (F6) |
| `setupNewFolderIsFile` | `There’s already a file with this name on <machine>. Pick another name.` | under A new folder when its name is a file on the machine (F6) |

Tone follows the board's own lines (`<machine> is offline. It can’t check folders or sign in until it’s back.`,
`No such directory on <machine>.`). Unchanged sentences now also reached by F6: the board's `Starts empty. Ask for a
clone or a new project in your first message.`, and `Checking on <machine>…`, `<machine> didn’t answer. Check again`.

## Tests

| Suite | Branch | Base `ee9644088` |
|---|---|---|
| Web vitest, full (`src/web`, 4 shards, TZ Asia/Shanghai) | 455 files, **6045 tests, 0 failed** | — |
| OrbitKit `swift test`, full (docker `swift:6.1`) | **4284 tests, 5 skipped, 0 failures** | 4274, 5 skipped, 0 failures |
| OrbitKit `swift test` on macOS (client.yml gates, probe runs 41265397054 and 41267138346) | 4284 tests, 5 skipped, 0 failures | — |
| Android `:app:testDebugUnitTest` | **2040 tests, 0 failures** | 2029, 0 failures |
| Android `:core:test` | **310 tests, 0 failures** | 310, 0 failures |
| Android CI on the probe commit (`verify.sh`: test + lint + debug APK), run 41265396966 | success | — |
| OrbitApp macOS build (`swift build`; run 41267138346, job 124732179436) | `Compiling OrbitApp MachineSetupCard.swift`, `Build complete! (186.63s)` | — |
| iOS app build (xcodegen + xcodebuild; run 41267138346, job 124732179517) | `SwiftCompile … MachineSetupCard.swift`, `** BUILD SUCCEEDED **` | — |

The probe commits are the task commits plus `.fwf-probe/` and the probe's `client.yml`: round 1 `7501fd76a` on
`195a1c9b3` (gates green, shots red on two mistakes of the probe's own, see below), round 2 `fffc375c5` on
`08ff62193` (all green, `apple/gates/RESULTS.txt`). Both probe branches are deleted.

New cases: web `machineSetup.test.ts` (+6), `MachineSetupCard.test.tsx` (+13), `WorkspaceView.machineSetup.test.tsx`
(+2); OrbitKit `MachineSetupTests` (+8) and `MachineSetupWiringTests` (+2); Android `MachineSetupTest` (+8) and the
Robolectric `FirstWorkspaceShotsTest` (+3: connecting → connected on the page's own 2 s reads, the register question
asked again after a typed path takes the slot, and a new folder's name that is a folder / a file / free). Mutants
(re-ask removed, polls at 60 s, the composer rule reverted) each fail their web test.

## Real stack: the rehearsal kit

`/var/tmp/first-ws-e2e/kit` rebuilt on `195a1c9b3` (`kit/rebuild.sh`), both orders from an empty server with the real
runner over HTTP heartbeats: **sign-in-first 74/74, folder-first 87/87**. The only finding left is F2 (by design,
board rules 1 and 13). The journey was updated to the fixed behaviour (`web/kit/journey.diff` against the kit as it
ran for task `34pSMceSv1UDwUeIqIiMj`, kept at `kit.a8832bb05`): its F4/F5/F6 `finding()` calls became checks, F1 is
timed from the first heartbeat, and round 5 now expects the card to say what is at a taken name instead of failing
the session afterwards.

| Finding | Check on the real stack | Result |
|---|---|---|
| F1 | the card waits for the machine in its own words, not "is offline", not "updates itself first"; folder step closed; composer open | PASS (both runs) |
| F1 | the folder step opens within 5 s of the first heartbeat, with no reload | **1.61 s** (both runs; first beat 0.05–0.07 s after the runner started) |
| F4 | after three typed paths, the register directory is offered again (asked twice on that card) | PASS (sign-in-first) |
| F5 | the waiting line ends ≥ 20 px above the pane's edge | 24 px (777 vs 801), with the picture loaded in folder-first (it was −107 px before) |
| F6 | a name still on the disk: "This folder already exists on lab-mac. Sessions will use what’s in it.", no "Starts empty", picked as that folder, `POST /sessions` with `newWorkspace.workDir`, the session opens on the files it said were there | PASS (folder-first) |
| F6 | a name that is a file: "There’s already a file with this name on lab-mac. Pick another name.", Use off, a message sent then waits, no POST, no workspace | PASS (folder-first) |

Pictures: `web/folder-first/06-a-card-before-first-heartbeat.png` (connecting card),
`web/folder-first/33-j-new-folder-name-already-a-folder.png`, `web/folder-first/35-j-new-folder-name-is-a-file.png`,
`web/folder-first/09-c-message-waiting.png` (the waiting line with its picture),
`web/sign-in-first/27-g-typed-git-folder.png` (the register suggestion back above a typed path). Each run's
`checks.json`, `findings.txt`, `transcript.md` and `db.txt` are beside them.

## Native pictures

- **iPhone and Mac** (round 2, run 41267138346, job 124732179596, iPhone 17 Pro simulator and the macos-26 Mac;
  harness `probe-harness/`, the real shared sources against `stub.py`): `apple/iphone/f1-connecting.png`,
  `f1-connected.png`, `f6-new-folder-exists.png`, `f6-new-folder-file.png`, `f4-suggestion-back.png`, and the same
  five as `apple/mac/mac-*.png`. **4 of 4 UI tests passed on each** (`apple/gates/summary-build-ios.txt`,
  `summary-build-mac.txt`). Measured by the tests (`*-notes.txt`): the folder step opened **2.8 s** (iPhone) and
  **2.0 s** (Mac) after the stub's machine first read online, with nothing but the page's own reads; the new folder
  that is there went as `{"workDir": "/home/orbit/orbit-repos/payments"}`; the register directory was asked twice
  and offered after `/srv/shared` took the slot. `writes.txt` holds every write each app made.
  Round 1 (run 41265397054) failed its shots on the probe's own mistakes, not the app's: it looked for "A new folder"
  on a machine still connecting, which has declared no `create-workdir/v1` and so offers none; and it retyped names
  in one field, which garbled them. `08ff62193` fixed both.
- **Android emulator** (`emulator-5554`, API 36, 1080×2400, `android-kit/`, a MockWebServer slice of the contract in
  the instrumentation): `android/emulator/f1-connecting.png`, `f1-connected.png`, `f6-new-folder-exists.png`,
  `f6-new-folder-file.png`; `OK (1 test)` (`android/emulator/device-run/`). A first run without the event stream
  in the fixture drew "Reconnect to send" over the composer; the frames kept are the rerun with it.
- **Android Robolectric** (native graphics, `FirstWorkspaceShotsTest`): `android/robolectric/06-connecting.png`,
  `07-new-folder-exists.png`.

## Decisions worth a look

- A new folder whose name is already a directory is picked as that directory (`kind: existing`, `workDir`), so its
  done line says what it is (`git repository · main`) rather than "created as the session starts", and the
  workspace is not marked `autoCreateWorkDir`.
- On the web a machine still connecting no longer greys the composer: the first message waits under the card, as
  board rule 6 and the lead sentence promise and as iOS and Android already allowed. A machine that was heard from
  and went offline keeps board 02's "Runner offline".
- A machine still connecting has declared no `create-workdir/v1`, so its card offers Another folder only until it
  beats; the new folder appears with its first heartbeat.
- F7's ENOTDIR path (`working directory … is not a directory`) can no longer be reached from the card, which refuses
  a file's name first; the runner fix from `ae1f9e17b` still covers other ways in.
