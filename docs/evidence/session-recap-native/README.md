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
| iOS | `ios/ios-list-with-recap.png` | `Running Bash…` (blue) · `Recap · 9:56 PM Moved the recap onto the session li…` (muted label, then the recap) · `Pushed the drawer fix.` (no recap) · under **2–7 days ago**, `Recap · Thu, Aug 6, 5:38 PM Tightened the second li…` (the dated label) |
| iOS | `ios/ios-list-with-recaps-off.png` | `--recaps-off`: `Committed the row change.` and `Adjusted the row spacing.` back in the recap rows' place, no `Recap · ` anywhere, the live row untouched |
| iOS | `ios/ios-settings-session-recaps.png` | the Settings sheet: **Session recaps** with its hint under it, the switch on, after Suggested replies |
| macOS | `mac/mac-list-with-recap.png`, `mac/mac-list-with-recaps-off.png` | the same two lists in the Mac window (the summary column), `Select a session` beside them |
| macOS | `mac/mac-settings-session-recaps.png` | Settings → Session defaults: **Session recaps**, its hint, the switch on |
| macOS | `mac/mac-window-mac-*.png` | the window written by the app itself (`-probe.shot`), kept beside the UI test's own shot |

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

The run's own record — `run-output.log`, the per-pass `summary-`/`tail-` files, `outcomes.txt`
(`capture=success`, the run URL, the sha), the runner's display geometry and clock, and `.done-probe`
(`exit=0`) — is in `ci/` and beside the pictures.

Two things the first dispatch found, both fixed before the run whose pictures are here (it is that
run's `ci/outcomes.txt` these files carry): the iPhone's Settings launch trapped in
`EnvironmentValues.subscript.getter` because the probe applied `.environment(model)` to the shell and
then attached `.settingsSheet(model)` outside it, while the real `RootView` hosts the sheet inside
the environment scope; and both passes of a platform write one shots directory, so the notes say
which pass wrote them (`…-on-notes.txt` / `…-off-notes.txt`).

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
| web suite (`npx vitest run`, `src/web`) | **4968 passed, 2 failed — both `WorkspaceView.taskRunHandoff` timing out at 60 s on a box at load average 123, neither about this change.** That file alone is **6/6 green** on a re-run, and the three files this change touches (`WorkspaceView.recapRow`, `WorkspaceView.sessionLine`, `SettingsPage`) are **38/38 green** on a fresh run |
| root build (`npm run build`) | **exit 0** — shared + apiserver (tsc) + web (tsc + vite) |
| OrbitKit (`swift test`, swift:6.1 container) | **3595 tests, 0 failures** (5 skipped are the environment-dependent ones) |
| Android (`:core:test`, `:app:testDebugUnitTest`, `:app:assembleDebug`) | **1078 app unit tests, 0 failures**, `BUILD SUCCESSFUL` — the APK at `src/android/app/build/outputs/apk/debug/app-debug.apk`, the three shots below written by the same run |
| CI `macos` gate (OrbitKit `swift test` + OrbitApp `swift build`, macos-15) | **success** — runs [37995783036](https://github.com/jianghailong-xy/orbit/actions/runs/37995783036) and [37997894305](https://github.com/jianghailong-xy/orbit/actions/runs/37997894305); the first real compile of the Swift view changes (this host has no Xcode), plus OrbitKit's suite on the Mac |
| CI `ios` gate (`xcodegen` + `xcodebuild -destination 'generic/platform=iOS Simulator'`, macos-15) | **success** (both runs) |
| CI probe job (`session-recap-shots`, macos-26) | **success**, `capture=success`, `exit=0` — run [37997894305](https://github.com/jianghailong-xy/orbit/actions/runs/37997894305), 19m; every assertion in `ios/…-on-notes.txt` / `…-off-notes.txt` and the two Mac notes confirmed (`S1 carries the label and the recap text on one row: yes`, `S1 does NOT show its raw reply beside the label: confirmed`, `S3 is NOT drawn as its recap: confirmed`, `no Recap · label anywhere: confirmed`). `writes.txt` holds only the tests' own `POST /__reset` — the probe presses nothing — and the only 404 is `/api/auth/capabilities` (3×), counted in `not-served.txt` |

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
- The **web** client honors the same switch (`sessionLine`'s fourth argument, off the same
  `GET /users/me`) and is covered by tests (`WorkspaceView.recapRow.test.tsx`'s new case,
  `WorkspaceView.sessionLine.test.tsx`), not by a picture here: the web list's own screenshots are
  Phase 1's (`docs/evidence/session-recap-web-list/`), taken before this switch existed.
- Criterion 6's first clause — the **settle push notification** using the recap as its body — is the
  sibling task `Phase 2：settle 推送通知正文优先使用 recap` (34d0xzNVO80qiSdhrzgL0), not this one.
