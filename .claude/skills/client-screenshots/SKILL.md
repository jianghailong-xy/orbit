---
name: client-screenshots
description: Take screenshots of an Orbit client page on the Android emulator (Linux host, shared API 36 emulator-5554) and/or the iOS Simulator (the Mac mini, workspace orbit-macos), then compare the two platforms and list where they differ. Use whenever someone asks for emulator / simulator screenshots, wants to see a UI change on a device, or wants Android checked against iOS (iOS is the reference for layout).
---

# Client screenshots: Android emulator, iOS Simulator, and the comparison

Neither platform signs in to a real account. Each platform's real app runs against a loopback fixture server, a test walks
to the page, and the test saves a PNG plus a text dump of what was on screen.

| | Android | iOS |
|---|---|---|
| Where | Linux host with `/opt/android-sdk` (this checkout) | The Mac mini: delegate with `workspace: "orbit-macos"` (or `needs: ["os:darwin"]`) |
| Device | Pixel 10 Pro display, 1280×2856 @ 480 dpi (`A07_DISPLAY`) | iPhone 17 Pro simulator, 1206×2622 |
| Fixture | `src/android/scripts/composer-fixture.py` (started by the script) | `stub.py` of a probe harness under `docs/evidence/*/probe-harness` |
| Drives | an instrumented journey in `ComposerDeviceTest` calling `capture("<name>")` | an XCUITest calling `shot("<name>")` |
| Output | `<out>/a07-composer/<name>.png` + `<name>-ui.txt` | `<probe>/shots/<name>.png` (+ xcresult attachments) |

Model to use when delegating: `deepseek-flash` (DeepSeek V4.1 Flash). It runs on Claude Code on both machines.

**A remote (Mac) SubAgent runs on the Mac's own repo HEAD.** It doesn't see uncommitted work here, and it returns only
text. So it must upload every PNG with Orbit's `file_upload` and give back the file links. A change you want
photographed on iOS has to be pushed first. Its own edits there are thrown away, which is fine for a probe.

---

## A. Android emulator

### A0. Pick the capture

```bash
rg -n 'capture\("' src/android/app/src/androidTest/kotlin/io/orbitd/android/composer/ComposerDeviceTest.kt
```

| Page | Test | Capture |
|---|---|---|
| New session (draft) | `io.orbitd.android.composer.ComposerDeviceTest#newSessionUsesWorkspaceDraftAndNavigatesAfterCreation` | `new-session-draft`, `created-session` |

If the page has no capture yet, add one line in the journey after the page settles:
`compose.waitUntil(15000) { compose.onAllNodes(hasTestTag("…") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }` and then
`capture("my-page")`. Other `src/android/scripts/*-device-test.sh` scripts cover other areas; read each one's usage line.

### A1. Preconditions (14 GB host; the emulator is shared)

```bash
pgrep -fa '[G]radleWrapperMain' | cut -c1-120              # other builds: fine for building, not for the emulator
systemctl is-active orbit-android-emulator.service
free -g | head -2
python3 -c "import os;s=os.statvfs('/');print(s.f_bavail)"  # 0 → the emulator cannot boot: stop, report
```

The order matters: **build first, then boot the emulator.** Gradle running beside a live emulator is what OOM-kills the
emulator on this 14 GB host. Other people's Gradle builds are not a reason to wait. Cap your own build in A2 so the OOM
killer picks it before anything else.
Never stop or restart `orbit-android-emulator.service`, and never run `adb kill-server`: other tasks share the device.

### A2. Build both APKs

```bash
cd src/android
ANDROID_HOME=/opt/android-sdk systemd-run --scope --quiet -p MemoryMax=6G \
  sh -c 'echo 500 > /proc/self/oom_score_adj && exec "$@"' sh ./gradlew --no-daemon -Pkotlin.compiler.execution.strategy=in-process \
  :app:assembleDebug :app:assembleDebugAndroidTest
```

Run long commands with Orbit's `bg_run` (kind `job`, `wakeOnExit: true`). A Bash `run_in_background` is refused. Don't
write `local.properties`.

### A3. Run and collect

```bash
export ANDROID_HOME=/opt/android-sdk ANDROID_USER_HOME=/var/lib/orbit/android/user ANDROID_AVD_HOME=/var/lib/orbit/android/avd
$ANDROID_HOME/platform-tools/adb start-server 9>&- 3>&-   # before the lock, or the adb daemon inherits it
flock -w 1800 /var/lib/orbit/android/ui.lock sh -c \
  'systemctl is-active --quiet orbit-android-emulator.service || systemctl start orbit-android-emulator.service'
out=<this session's uploads dir>/android-shots-$(date -u +%Y%m%dT%H%M%SZ)   # must not exist yet
A07_DISPLAY=1280x2856@480 \
A07_TEST='io.orbitd.android.composer.ComposerDeviceTest#newSessionUsesWorkspaceDraftAndNavigatesAfterCreation' \
  bash src/android/scripts/composer-device-test.sh 36 \
  src/android/app/build/outputs/apk/debug/app-debug.apk \
  src/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk "$out"
```

- Screenshots use a Pixel 10 Pro display: `A07_DISPLAY=1280x2856@480` (427×952 dp). The SDK has no Pixel 11 Pro profile;
  the owner chose this on 2026-11-20. It sets the shared emulator's size and density for the run and puts them back after. It
  has no rounded corners or camera cutout. Without `A07_DISPLAY`, the script uses 720×1280 at 320 dpi, which the device tests
  were written for. Light mode is the default. Use `A07_NIGHT=yes` for dark and `A07_FONT_SCALE=1.3` for large text.
- `$out/result.txt` with `exit_code=0` means it passed. A failed journey still writes `<journey>-failure.png`. A name in
  `missing-captures.txt` means the system returned no screenshot under load: rerun into a new directory.

---

## B. iOS Simulator (on the Mac mini)

The iOS kit is a throwaway probe app. It is the iPhone app's real `CompactShell`, built from `src/` and pointed at a stub
server, and an XCUITest drives it. Start from `docs/evidence/claude-region-check-apple/probe-harness` (its README explains
it): one machine "HPC", workspace `a1`, providers, and a session `S1`.

### B1. Copy the harness (never commit it)

```bash
cd <repo root>                       # on the Mac: the orbit-macos workspace's checkout
git sparse-checkout add docs/evidence 2>/dev/null || true
rm -rf .shot-probe && cp -R docs/evidence/claude-region-check-apple/probe-harness .shot-probe
which xcodegen xcodebuild python3    # all three are needed
```

Its `project.yml` uses `../src` paths, so it must live at the repository root. Its scheme and project are named
`RgnProbe`, so keep those names.

### B2. Point it at the page

1. **Landing.** `ProbeArgs.land(_:)` in `.shot-probe/ProbeArgs.swift` already has `-probe.session`, `-probe.list` and
   `-probe.machine`. Add a branch for the new session page:
   ```swift
   } else if ProcessInfo.processInfo.arguments.contains("-probe.draft") {   // a flag, not a value: value() misses it last
       model.selectedAgentID = "a1"
       for _ in 0..<2 {
           model.composeWithAgent("a1")      // the app's own "New session" for this workspace
           try? await Task.sleep(for: .seconds(2))
       }
   ```
   For other pages, find the `AppModel` call the real button makes (`rg -n 'func ' src/macos/OrbitApp/Sources/OrbitApp/AppModel.swift`).
2. **Stub state.** In `.shot-probe/stub.py`, the harness's machine is region-blocked, which adds a warning line under the
   new session hero. Delete the `"region": {...}` entry from `runner()` so the page is the ordinary one. Change nothing
   else unless the page needs it.
3. **Test.** Replace `.shot-probe/UITests/RegionShotTests.swift` with a class of the same name holding one test per shot.
   `ProbeCase` gives `resetStub()`, `appears(app, words, timeout:)`, `settle(seconds)`, `shot(name)` and `write(text, file)`:
   ```swift
   import XCTest
   final class RegionShotTests: ProbeCase {
       private func open(_ args: [String], until words: String, _ name: String) -> XCUIApplication {
           resetStub()
           let app = XCUIApplication()
           app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-ApplePersistenceIgnoreState", "YES",
                                  "-probe.fresh", "-AppleLanguages", "(en)", "-AppleLocale", "en_GB"] + args
           app.launch()
           if !appears(app, words, timeout: 60) {
               write(app.debugDescription, "missing-\(name).txt")
               XCTFail("\(name): \(words) never showed")
           }
           settle(3)
           write(app.debugDescription, "\(name)-tree.txt")
           return app
       }
       func test01NewSessionLight() { _ = open(["-probe.draft"], until: "Runs in:", "new"); shot("ios-new-session-draft") }
       func test02NewSessionDark() { _ = open(["-probe.draft", "-dark"], until: "Runs in:", "new-dark"); shot("ios-new-session-draft-dark") }
   }
   ```
   Check `ProbeCase.swift` for the exact helper names before you use them, and adjust if they differ.

Known build breaks in this harness (seen 2026-11-20, Xcode 27, Mac HEAD 874fa56f4). Fix them only under `.shot-probe/`:
- `MenuBarIcon.swift` (macOS-only, needs AppKit) is newer than the harness: add it to the OrbitApp excludes in
  `.shot-probe/project.yml`. Copy the current excludes from `src/ios/project.yml`.
- IRGen crash `Global is external, but doesn't have external or weak linkage! …HeldScroll`: exclude `ConsoleView.swift` and
  `WikiChatViews.swift` from the shared sources and compile patched copies under `.shot-probe/`, with
  `TranscriptView(wikiChat:)` moved beside the view.

### B3. Run on an iPhone 17 Pro

Shots are taken on an **iPhone 17 Pro** (402×874 pt, PNGs 1206×2622), to set beside Android's Pixel 10 Pro display (A3).
The owner chose this on 2026-11-20. `run.sh` picks "the newest iPhone Pro" by itself, so pin the device in its copy: replace
the `IPHONE_UDID=$(xcrun simctl list devices available -j | python3 …)` block in `.shot-probe/run.sh` with

```bash
IPHONE_UDID=$(xcrun simctl list devices available | grep -m1 'iPhone 17 Pro (' | grep -oE '[0-9A-F-]{36}')
[ -n "$IPHONE_UDID" ] || { echo "no iPhone 17 Pro simulator: xcrun simctl list devicetypes | grep 17"; exit 1; }
```

The `(` matters: without it the pattern also matches "iPhone 17 Pro Max". Since Xcode 27, a destination given by name alone
no longer matches, so the UDID is what goes to `-destination id=…`. If no iPhone 17 Pro device exists, create one:
`xcrun simctl create "iPhone 17 Pro" com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro`. Then:

```bash
bash .shot-probe/run.sh; echo exit=$?
ls .shot-probe/shots/*.png
xcrun simctl list devices | grep "$IPHONE_UDID"     # record the device name and its iOS version
sips -g pixelWidth -g pixelHeight .shot-probe/shots/*.png   # 1206 × 2622 on an iPhone 17 Pro
```

`run.sh` serves the stub, builds and runs the tests, and copies the PNGs into `.shot-probe/shots/`. Takes ~10–20 min cold.
Build errors are in `.shot-probe/build-ios.log` (`grep -n 'error:'`). Paths the stub doesn't serve are in
`shots/not-served.txt`. If the page needs one of them, add it to `stub.py`.

### B4. Hand back from the Mac

Upload each PNG with Orbit's `file_upload` and return the links. A remote SubAgent can upload only once the server and the
Mac's runner both carry the fix from 2026-11-21. Before that it answered `PERMISSION_MODE_UNREADABLE`, and then
`session does not belong to this runner`. If `file_upload` is refused, push the files instead as a one-commit branch built with a temporary index, so
the checkout stays untouched: `GIT_INDEX_FILE=$(mktemp -u) git read-tree --empty`, then `git update-index --add --cacheinfo`
for each `git hash-object -w <file>`, `git write-tree`, `git commit-tree`, and
`git push origin <sha>:refs/heads/probe/<name>`. The caller fetches it with `git show FETCH_HEAD:<path> > <file>` and
deletes the branch when done. Return the links or the branch name, plus `git rev-parse HEAD` (the code that was
photographed). Delete `.shot-probe/` when done.

---

## C. Compare

Do this once both sets exist. iOS is the layout reference (`docs/mocks/*` boards override both).

1. Open each pair of PNGs with the Read tool. Check that every picture shows the page asked for: not blank, and not a
   sheet or the keyboard covering it.
2. Go top to bottom and fill a table with one row per element: navigation bar (title, buttons), page header, the main
   content (order, alignment, size and weight of type, icons, colour), empty state text, the bottom composer (pills, send
   button, placeholder).
   Columns: element | iOS | Android | same / different.
3. Use the text dumps (Android `<name>-ui.txt`, iOS `*-tree.txt`) to confirm the exact words, so you aren't reading
   blurry pixels.
4. Separate the differences into two kinds. **Platform convention** you keep, such as Material back arrow vs iOS chevron,
   status bar, or system fonts. **Real differences** to fix: missing or extra text, a different order, a different
   control, different wording, a different empty state. Different fixture data (the workspace name, the engine the stub
   or fixture picked, the model) is not a UI difference. Say it is fixture data.
5. Report the table, the list of real differences with file pointers where you know them, and the links to every PNG.

Don't commit. The repository changes this skill allows are a `capture(...)` line (A0) and whatever lives under
`.shot-probe/` on the Mac. Name each one in your report.
