# Add Runner's Deny on macOS, iOS and Android: evidence

Task 34no050naUDViWDBEtXaZ. `orbit register` asks the account owner to approve a new machine. The
native apps approve it by its code, for a machine with no browser, in the Add Runner sheet (macOS and
iOS, `AddRunnerSheet.swift`) and Android's Add runner dialog (`AddRunnerDialog`). They now deny it
too, as the web /enroll page has since 18eb9fe29, and they use that page's words. The server was
already in place: `POST /runners/device/:userCode/deny`, and the lookup's `status`, `existingLastSeenAt`,
`runnerId` and `expiresAt`.

## What the dialogs do

- **Still PENDING.** Deny sits beside Approve: the next row of the sheet's section on macOS and iOS,
  and the next button in the same row on Android. Deny posts `…/deny`. Both buttons are disabled
  while either press is in flight.
- **Denied, here or already.** After Deny, or for a lookup that answers DENIED, the dialog shows
  "Request denied", then "Nothing was added to your account. orbit register in that terminal stops
  and says the request was denied." It offers no Approve and no Deny.
- **Approved.** After Approve, or for a lookup that answers APPROVED, the dialog shows "Machine
  registered", then "<name> is on your account. Go back to the terminal — it finishes setting up by
  itself."
- **A runner of the same name.** The notice reads "\"<name>\" is already on your account". Under it
  comes "Last online <ago>." when the server sends `existingLastSeenAt`, then "Approving gives it a
  new credential and the old one stops working; its workspaces and history stay. A different computer
  with the same name? Deny, then run orbit register --name <new-name> on it." The button reads
  "Re-register", still in red.
- **A refusal.** When the server refuses a decision, for example 409 `DEVICE_ENROLLMENT_DECIDED`
  because the request was already decided the other way, its sentence shows where the dialogs
  already showed failures. The request stays open to decide.
- Nothing else changed: no countdown, no account row, no "Open machine".

## Where the words live

The new words sit in `src/web/src/lib/runnerCopy.ts`, in its Add Runner sheet section, beside the
sheet's other words. Three checks hold them in place:

- `RunnerPageCopyParityTests` (OrbitKit) holds `RunnerPageCopy` one to one with runnerCopy.ts.
- `AddRunnerCopyParityTest` (Android) holds `RunnerCopy`'s device section to runnerCopy.ts.
- `EnrollPage.test.tsx` holds runnerCopy.ts to what the /enroll page renders.

## Results

The delivery is 64d8aea99 (the change and its tests) and 5ae57b4fe (the Android dialog test presses
through semantics). The evidence commits are c768fb211 and 32342e547, plus the commit that adds this
file. CI ran on probe branches: each is a delivery commit plus one probe-only commit that adds the
`add_runner_deny_probe` input and its job to client.yml. The gate jobs are unchanged.

### OrbitKit `swift test` (Linux, swift:6.1 docker)

`docker run --rm --memory=6g -v <worktree>:/w:ro -v /mnt/data/arn-orbitkit/sb:/sb -w /w/src/macos/OrbitKit
swift:6.1 swift test --scratch-path /sb`

| tree | tests | failed |
|---|---|---|
| 32342e547 (everything but this README committed) | 4095 (5 skipped: PerfBaselineTests, which need `ORBIT_PERF=1`) | 0 |

The tests this task adds or changes:
- `RunnerDeviceEnrollmentTests` (7): PENDING with a runner of the same name and its last check-in,
  APPROVED with its runner id, DENIED, and an older server's answer without the new fields; Deny's
  route beside Approve's; a 409 `DEVICE_ENROLLMENT_DECIDED` said in the server's words; the notice
  with "Last online …" and without it; the sentences.
- `RunnerPageCopyParityTests`: its tables list the nine new declarations, held one to one with
  runnerCopy.ts.
- `InfrastructurePageWiringTests.testTheAddRunnerSheetDeniesAndSaysWhatBecameOfTheRequest` pins the
  sheet's order: approved, denied, then the notice and the two presses, each `.disabled(deciding)`.
  It also checks that the old sentences are gone, how a press settles, and the lookup's DENIED.
  `testTheAddRunnerSheetInstallsWaitsAndApproves` follows the approve line.

### Web (the copy's home)

- `npx vitest run src/pages/EnrollPage.test.tsx src/lib/runnerAttention.test.ts src/copyLanguage.test.ts`
  ran 3 files and 128 tests, all passed, on 32342e547. EnrollPage.test.tsx's new case renders
  pending, approved, denied, and the same name with and without a last check-in. It compares the
  page's text with runnerCopy.ts's declarations. runnerAttention.test.ts holds runnerCopy.ts to the
  shape the parity tests read. copyLanguage.test.ts found no new Chinese literal.
- `npx tsc -p tsconfig.json --noEmit` (src/web) is clean.

### Android

Locally, `gradlew test lintDebug assembleDebug --continue` (the android.yml gate) ran through
`/mnt/data/arn-android/g.sh`, with build dirs on /mnt/data:

| run | tree | core | app debug | app release | lint, debug APK |
|---|---|---|---|---|---|
| gate-1 | 87de800a3 + the change (64d8aea99's content) | 282 / 0 failed | 1878 / 3 failed | 1878 / 3 failed | passed |
| gate-2 | 5ae57b4fe | up to date | 1878 / 2 failed | 1878 / 0 failed | passed |
| gate-3 | 5ae57b4fe | up to date (282 / 0) | 1878 / 0 failed | up to date (1878 / 0) | passed, BUILD SUCCESSFUL |

- gate-1's three were the new `AddRunnerDialogTest` cases that pressed a button with `performClick`.
  A Compose `Dialog`'s buttons take no injected touch while the dialog settles, so those presses never
  landed. 5ae57b4fe presses through the button's semantics, as `RemoveDefaultPageTest` does.
- gate-2's two were `ProjectMergeShellTest.aMergeAlreadyMadeIsARowOfTheLandingsWindowNotOfTheTimeline`
  and `ProjectSessionsShellTest.theRowOpensTheProjectsSessionsOverTheListAndBackReturnsToIt`. This
  change touches neither test nor any code they read. Their fixture's "Quota retry" turn is 10 minutes
  old (`ProjectShellFixture.ago(10)`), and the page buckets by local day. So between 00:00 and 00:10
  local time it lands under an extra "Yesterday" heading. gate-2's debug pass ran at 00:08 +0800, and
  both tests passed in gate-1 30 minutes earlier and again in gate-3.

GitHub Android CI (android.yml, `verify.sh`: test lintDebug assembleDebug) ran on the probe branch:

| run | commit | result |
|---|---|---|
| [40719673460](https://github.com/jianghailong-xy/orbit/actions/runs/40719673460) | e6f401741 (c768fb211 + probe) | failure: 3 of 1878, the same three dialog cases as gate-1 (artifact JUnit XML) |
| [40727330685](https://github.com/jianghailong-xy/orbit/actions/runs/40727330685) | 357b7bc35 (32342e547 + probe) | success |

The Android tests this task adds or changes:
- `AddRunnerDialogTest` (5, Robolectric, on `ManagementFixture`'s new runners/device routes). PENDING
  offers Deny beside Approve, and both are disabled while Deny is held in flight. Deny posts
  `runners/device/ABCDE-FGH23/deny` and then says "Request denied" and its sentence, with no Approve.
  A DENIED or an APPROVED lookup opens on its decision and offers no press. A refused Approve or Deny
  shows the server's sentence, and both presses stay. A runner of the same name shows "Last online 3d
  ago. …" and Re-register, and approving it says "Machine registered".
- `ManagementHttpTest.denyingAMachineIsApprovesSiblingRouteAndARefusalKeepsTheServersWords` covers
  `POST /api/runners/device/ABCDE-FGH23/deny {}` over real OkHttp and a 409's message through
  `personalFailure`.
- `AddRunnerCopyParityTest` (2): RunnerCopy's device words are runnerCopy.ts's by name, the existing
  ones included. The notice is composed with "Last online …" only when the server sends a time.
- `ManagementLiveTest.step3` (a device test against a live stack that no gate runs) now waits for
  "Machine registered" instead of the old sentence.

### Client CI (client.yml) on macOS and iOS

| run | commit | macOS (OrbitKit `swift test` + OrbitApp `swift build`) | iOS (Simulator build) | iPhone probe + OrbitApp build on its own |
|---|---|---|---|---|
| [40719710970](https://github.com/jianghailong-xy/orbit/actions/runs/40719710970) | e6f401741 | success | success | 3 of 4 UI tests passed; OrbitApp build success |
| [40727375460](https://github.com/jianghailong-xy/orbit/actions/runs/40727375460) | 357b7bc35 | success (attempt 2; attempt 1 was cancelled when no macOS runner took the job) | success | 4 of 4 UI tests passed; OrbitApp build success |

The two commits have the same `src/macos`, `src/ios`, `src/web` and `.github`. In the first run, the
probe's in-flight check lost its Deny button between two queries: the stub's 6 s hold ran out while
the simulator answered them. The second run holds the decision 20 s and reads each button once.
Font tokens and Navigation passed in both runs. `ios/probe-results/` holds the second run's own
output: the UI tests' summary, the notes beside each picture, the writes the app sent and the macOS
build's tail.

## The screens

### iPhone

The app's own CompactShell, Settings sheet and Add Runner sheet, built from the shared sources at
357b7bc35 on GitHub's `macos-26` runner (iPhone simulator), driven by
`ios/probe-harness/UITests/ArdShotTests.swift` against `stub.py`. Downscaled from 3x to 2x.

| screen | what it shows |
|---|---|
| `ios/screenshots/ios-01-pending-approve-and-deny.png` | PENDING: devbox (vmi3337007), Approve, and Deny under it |
| `ios/screenshots/ios-02-deny-in-flight.png` | Deny held in flight by the stub: Approve and Deny both greyed |
| `ios/screenshots/ios-03-denied.png` | **denied**: "Request denied" and "Nothing was added to your account. orbit register in that terminal stops and says the request was denied."; no presses; one POST …/deny sent |
| `ios/screenshots/ios-04-denied-on-open.png` | a request already DENIED opens denied, with no Approve; nothing sent |
| `ios/screenshots/ios-05-denied-on-open-dark.png` | the same in dark |
| `ios/screenshots/ios-06-refused.png` | an Approve refused 409: "This registration request was denied — run `orbit register` again" in red; Approve and Deny still offered |
| `ios/screenshots/ios-07-same-name.png` | "\"devbox\" is already on your account", "Last online 3d ago. Approving gives it a new credential …", Re-register in red, Deny |
| `ios/screenshots/ios-08-approved.png` | after Re-register: "Machine registered", "devbox is on your account. Go back to the terminal — it finishes setting up by itself." |

The Mac was not photographed. It draws the same views, and the macOS jobs compiled them.

### Android

The product shell on the shared emulator (`emulator-5554`, API 36, 1080x2400), from APKs built at
5ae57b4fe, over a MockWebServer inside the instrumentation
(`android/kit/src/AddRunnerDenyShotsTest.kt`, `android/kit/run.sh`). Both the light and the dark pass
ended `OK (1 test)`, and the run's records are in `android/device-run/`. The code goes into the field
through its own SetText semantics, so no keyboard covers the frame. Each state is in
`android/screenshots/` as `android-<state>-light.png` and `android-<state>-dark.png`:

| state | what it shows |
|---|---|
| `01-pending` | PENDING: Approve and Deny side by side |
| `02-denied` | **denied** after Deny: "✕ Request denied" and the page's sentence; no presses; one POST …/deny sent |
| `03-denied-on-open` | a request already DENIED opens denied (byte for byte the same frame as 02), with no Approve; nothing sent |
| `04-refused` | an Approve refused 409: the server's sentence in red; Approve and Deny still offered |
| `05-same-name` | "\"devbox\" is already on your account", "Last online 3d ago. …", Re-register in red, Deny |
| `06-approved` | after Re-register: "✓ Machine registered" and "devbox is on your account. …" |
