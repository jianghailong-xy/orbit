# The recap on the native session lists (0418)

Evidence for task `34d0xzOZq9XnKpDNRBM0T` (project `34d0oH4R6LErqqsox7wYv`, criterion
`3Nv4RZUwixTUA4ydfXppBV`): the macOS, iOS and Android session lists show the server's rolling recap
— under its own muted `Recap · <time>` label — in place of the raw last reply; they fall back to
that reply when there is no recap (a session no pass has recapped, and the shape an
`ORBIT_RECAP_ENABLED=0` deployment serves, where the fields are null); and they draw none of it when
the account turned **Session recaps** off in Settings.

The rule is one function in four ports, each held to the others: web `sessionLine`
(`src/web/src/components/WorkspaceView.tsx`), OrbitKit `SessionLine.make(for:live:watching:recaps:now:)`
(Swift — the Mac and the phone list are the same view), Kotlin `SessionLine.make` (Android's project
rows) and Android's directory row, which draws its own two lines. The recap sits **below every live
line** — working, waiting on you, queued, a watch, a background process, a message of yours with no
answer yet — and above the raw reply only: the recap is what the server wrote about the whole
conversation, and the lines above it are what is happening now.

## What the shots show

| Client | Picture | Reads |
|---|---|---|
| Android | `android/list-with-recap.png` | `Recap · 5:57 AM Moved the recap onto the session list row; the three states are covered` (muted label, then the recap) · `Recap · Wed, Oct 7, 6:02 AM Shipped the drawer fix and re-ran the web suite.` (another day's) · `Rebased the fixtures; the suite is green.` (no recap, the raw reply) · `Running` (the live row's own state line) |
| Android | `android/list-with-recaps-off.png` | the same four rows with the switch off: `Committed the row change.` and `Pushed the drawer fix.` back in the recap rows' place, no label anywhere, the live row untouched |
| Android | `android/settings-session-recaps.png` | Settings → Sessions' **Session recaps** row, its hint under it, the switch on |
| iOS | `ios/ios-list-with-recap.png` | the phone list: the recap row, the reply-only row, `Running Bash…`, and an older-day recap whose label carries the date |
| iOS | `ios/ios-list-with-recaps-off.png` | `--recaps-off`: both recapped rows back on their raw replies, no `Recap · ` anywhere |
| iOS | `ios/ios-settings-session-recaps.png` | Settings → Sessions' switch |
| macOS | `mac/mac-list-with-recap.png`, `mac/mac-list-with-recaps-off.png`, `mac/mac-settings-session-recaps.png` | the same three, the Mac window |
| macOS | `mac/mac-window-mac-*.png` | the same window written by the app itself (`-probe.shot`), kept beside the UI test's own shot |

Each probe picture has its accessibility tree (`tree-*.txt`), the pass's notes (`*-notes.txt`, every
claim answered `shown` / `MISSING` / `confirmed` / `NO`), and the stub's request log beside it
(`requests-on.log` / `requests-off.log`, every line stamped with the mode it served).

## How they were taken

**Apple (macOS + iOS)** — `probe-harness/` builds two throwaway apps out of the real sources
(`src/macos/OrbitKit` as a package, the shared `src/macos/OrbitApp/Sources/OrbitApp` tree, and
`src/ios/Sources` minus its `@main`), points them at `stub.py` with `-orbit.instance`, and drives
them with `RecapShotTests` on a `macos-26` runner: two passes per platform, `--recaps-off` being the
whole difference between them. The stub serves four sessions (a recapped one, a reply-only one, a
RUNNING one that shares the recapped session's recap, and one recapped on another day) and the
account (`preferences.recaps` on or absent). Nothing in `probe-harness/` is ever merged; it is the
source-refused probe's shape (`docs/evidence/source-refused-native`), renamed and re-pointed.

```sh
# a throwaway branch and the workflow copy that runs the probe (never merged)
git checkout -b probe/session-recap-native
cp docs/evidence/session-recap-native/ci/client.yml.probe-diff .github/workflows/client.yml
git commit -am "probe: session-recap evidence run" && git push -u origin probe/session-recap-native
gh workflow run client.yml --ref probe/session-recap-native -f session_recap_probe=true
```

The run's own record — the build logs, `outcomes.txt`, the runner's display geometry and clock, and
`.done-probe` — is in `ci/` and beside the pictures.

**Android** — `SessionRecapShotsTest` renders the real `DirectoryScreen` and `SettingsScreen` under
Robolectric (`@GraphicsMode(NATIVE)`) over a stub `OrbitApi`, asserts each row's text, and writes the
PNGs and their semantics trees; the pictures are copied here from
`src/android/build/evidence/session-recap-android/`.

```sh
env JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ANDROID_HOME=/opt/android-sdk \
  bash src/android/gradlew -p src/android --no-daemon :app:testDebugUnitTest \
  --tests "io.orbitd.android.directory.SessionRecapShotsTest"
```

## Checks

| Check | Result |
|---|---|
| apiserver unit suite (`npm test -w @orbit/apiserver`) | **5126 pass, 0 fail** — including `users-preferences.http.spec.ts`'s new case: `recaps` is written only when sent, absent stays absent, a malformed value is refused |
| web suite (`npx vitest run`, `src/web`) | **4968 pass, 0 fail** across 379 files (two unrelated `WorkspaceView.taskRunHandoff` timeouts under a load average of 123 re-run green in isolation: 6/6) |
| root build (`npm run build`) | **exit 0** — shared + apiserver (tsc) + web (tsc + vite) |
| OrbitKit (`swift test`, swift:6.1 container) | **3595 tests, 0 failures** (5 skipped are the environment-dependent ones) |
| Android (`:core:test`, `:app:testDebugUnitTest`, `:app:assembleDebug`) | **1078 app unit tests, 0 failures**, `BUILD SUCCESSFUL` — the APK at `src/android/app/build/outputs/apk/debug/app-debug.apk`, the three shots below written by the same run |
| CI `macos` gate (OrbitKit `swift test` + OrbitApp `swift build`, macos-15) | **success** (run 37995783036) — the first real compile of the Swift view changes (this host has no Xcode), and OrbitKit's suite on the Mac |
| CI `ios` gate (`xcodegen` + `xcodebuild -destination 'generic/platform=iOS Simulator'`, macos-15) | **success** (same run) |
| CI probe job (`session-recap-shots`, macos-26) | to fill |

## Limits

- The Apple pictures are of the probe apps against a stub, not the shipped binaries against a live
  control plane: they show the real views, the real `SessionLine` and the real preference read, but
  the server behind them is `stub.py`. That the server writes `recapText`/`recapAt` at all is Phase
  1's (`recap.spec.ts`, `session-recap-delivery.pg.spec.ts`) and is not re-proved here.
- The switch is a **display** preference: the clients stop drawing the recap; the server keeps
  writing it (the deployment's own switch is `ORBIT_RECAP_ENABLED`), and the payload still carries
  it. That is the reading the task's own words ask for ("关闭后各客户端不展示 recap"), and it is what
  the DTO says.
- Android's directory row keeps its two-line shape: the state line it has always drawn
  (`Running` / `Needs you · 1` / …) stays where it is, and the recap takes the preview slot below it,
  exactly where the previous reply sat. The web rule that live state outranks the recap is
  `SessionLine`'s, which is what Android's *project* rows draw and what the whole Mac/phone list
  draws; it is asserted in `SessionLineTest` (`liveLinesOutrankTheRecap`) and photographed on the
  phone and the Mac.
