# The session recap's native pictures — how to take them

TEMPORARY evidence probe. Nothing in this directory is ever merged into the product: it is a
throwaway app built out of the real client sources, a stub of the API, and a UI test that drives
and photographs the result. `../ci/client.yml.probe-diff` is the probe-branch copy of the CI
workflow that runs it; that copy is dropped on a throwaway branch and never merged either.

What the pictures are for: the task "Phase 2：macOS/iOS/Android 展示 recap + 用户级开关" — the macOS
and iOS session LIST's second line showing the server's rolling recap under its own label, the same
list falling back to the raw reply, a working row the recap never displaces, and the same list with
the account's "Session recaps" switch off, plus the Settings row that switch is. (Android is
another task's; this harness is macOS + iOS only.)

## What is here

```
docs/evidence/session-recap-native/
  probe-harness/          (this directory; copied to `.recap-probe/` at the repo root to run)
    NOTES.md              this file
    project.yml           XcodeGen project: RecapProbe (iOS) + RecapMacProbe (macOS) out of the real
                          ../src sources, with each UI-test bundle
    Info.plist            ATS exception for the plain-HTTP stub on 127.0.0.1
    ProbeArgs.swift       where a launch lands: the workspace's session list, or Settings
    ios/RecapProbe.swift  the iPhone shell (CompactShell) + the settings sheet, at the stub
    mac/RecapMacProbe.swift  the Mac shell (MainView), plus the app writing its own window bitmap
    UITests/ProbeCase.swift      shared helpers (launch, find, wait, scroll, picture, notes)
    UITests/RecapShotTests.swift the claims and the pictures, per platform and per mode
    stub.py               the slice of the API the list reads: 4 sessions + the account, and the
                          --recaps-off flag that answers preferences.recaps: false
    run.sh                the CI entry point: stub, two probe apps, four passes, artifact collection
    ios-shot.sh, mac-shot.sh  host fallbacks that take one picture, on a Mac with a display
  ci/
    client.yml.probe-diff the complete probe-branch client.yml: the real workflow plus
                          session-recap-shots / session-recap-publish and the dispatch input
```

## The two modes, and why the switch is the stub's flag

`--recaps-off` on `stub.py` is the whole difference: `GET /api/users/me` answers
`preferences.recaps: false` instead of carrying no `recaps` key at all. That is exactly the state
the app's own toggle writes (`UserPreferences.recaps`, absent means on), and it keeps the "switch
off" picture the same app against the same rows. The stub stamps `[recaps-on]` / `[recaps-off]`
into every line of its log, and `run.sh` starts a fresh stub per pass, so no picture can be read as
the wrong mode.

The test reads `RECAPS_OFF` (the `TEST_RUNNER_RECAPS_OFF` variable `run.sh` sets reaches the runner
with the prefix stripped, as `TEST_RUNNER_SHOTS_DIR` → `SHOTS_DIR` already does). Test and stub are
therefore decided by the same pass label — the assertions cannot claim one mode while the stub
serves the other.

## What was changed from the template (docs/evidence/source-refused-native), and why

Every file is the source-refused probe's own file, renamed and adapted; the shape (stub server +
`-orbit.instance` launch + XCUITest + app-written window bitmap + `.done-probe` marker) is kept
deliberately, because that shape is what survived a real CI run.

- **`ProbeArgs.land` no longer routes into a session.** The template's landing ended in
  `model.route(to: .session(...))`, which is what those pictures were of. The recap line lives on
  the list's rows, so this one stops at the workspace: `model.openAgent("a1")` — the sidebar row's
  own press — and the sessions load off the column's own `.task` (`AgentsModel.loadSessions`). The
  `me` read is kept although the list itself does not need it, because `me` is where
  `preferences.showRecaps` comes from: without it the row's `recaps:` argument would be the app's
  default rather than the account's, and the off pass would photograph the default.
- **`stub.py`**: the four sessions and the `--recaps-off` flag (above); an argument it does not
  know is refused rather than ignored, so a typo in `run.sh` fails the pass instead of quietly
  photographing the other mode. The source-refused fixtures (the refused SOURCE session, the
  project blocker, the task/execute press) are gone — this probe presses nothing, and the stub's
  only POST door left is the tests' own `/__reset`, which is answered (nothing here is mutable) and
  logged as `RESET`, so `writes.txt` — collected from `BODY` and the mutating verbs — stays empty
  and means what it says:
  - S1 `Recap on the session list row`, parked (AWAITING_INPUT), `recapText` +
    `recapAt` (six minutes back) + `lastAssistantText` = `Committed the row change.`;
  - S2 `Drawer shadow fix`, parked, only `lastAssistantText` = `Pushed the drawer fix.`;
  - S3 `Rebuilding the transcript page`, RUNNING with `lastToolUse` = `Bash` and the SAME
    `recapText`/`recapAt` as S1 — a row whose recap is held back by the live line, not one without a
    recap;
  - S4 `Session row spacing pass`, parked, a recap written on another day (`2026-08-06T17:38:00Z`,
    fixed), so the label's dated face is photographed too; its own reply is the off-pass fallback.
  - Also added for the Settings sheet's own `.task`s: `GET api/share-links` and
    `GET api/access-tokens` (both empty), and `api/projects`, `api/projects/sidebar`, `api/tasks`,
    `api/skills` to the empty-list set. Everything else the shell asks for that the probe did not
    think of is still a counted 404 in `not-served.txt`.
- **`UITests/ProbeCase.swift`**: `launch(until:dark:timeout:extra:_:)` gained `timeout` and `extra`
  (the launch's own arguments), and `element(_:containingAll:)` was added. The latter is what a
  claim about ONE row needs: two per-word searches answer "the recap text is on screen and the
  label is somewhere", which two different rows could satisfy between them.
- **`mac/RecapMacProbe.swift`**: the template's `WindowFit` was dropped. It existed because the
  session *console* lays itself out ~1564 points tall with the card below the fold, so the window
  had to be grown past the screen (and made borderless to get past `NSWindow.constrainFrameRect` —
  which is why the source-refused probe's XCUITest pictures of the Mac window could not be taken at
  all). A session LIST and a Settings form both live in ordinary columns that scroll themselves, so
  nothing here resizes a window: the window stays titled and visible to the UI test, and the
  app-written bitmap (`-probe.shot`) is kept beside it as the tin-opener that does not depend on the
  UI-test sandbox at all. `CardRender` (the template's `-probe.render` of the "run never started"
  card) is gone with it for the same reason: nothing here asks for it.
- **`run.sh`**: two passes per platform instead of one, one derived-data root per *platform*
  (`.dd-mac`, `.dd-ios`) so the off pass reuses the on pass's build, and a separate attachment
  export directory per pass (`attachments-<label>/`) so the second export cannot overwrite the first
  pass's manifest before it is read. The stub-readiness gate, the iPhone pick and status-bar
  override, the Mac-first order, `writes.txt` / `not-served.txt`, the `.done-probe` marker and
  `exit=$STATUS` are the template's, unchanged.
- **`ios-shot.sh` / `mac-shot.sh`**: the host fallbacks, adapted to the new app names and ports and
  to `--recaps-off` (first argument after the output path). They take one picture each, nothing is
  pressed.

## The claims the test makes (and the words are the app's)

| Claim | Where the words come from |
|---|---|
| S1's row carries `Recap · ` **and** the recap sentence **on one element**, and NOT its raw reply | `SessionLine.recapLabel` (`"Recap · \(clock)"`, the middle-dot separator byte for byte) + the stub's `recapText` |
| S1's sentence itself is on screen | `"the three states are covered by tests"`, inside the stub's `recapText` |
| S2 shows its raw reply and carries no label | the stub's `lastAssistantText` |
| S3 shows `Running Bash…` and is NOT drawn as its recap | `SessionLine.make`'s `"Running \(fmtTool(t))…"` for `lastToolUse: Bash` |
| S4's older-day recap carries the label too | the stub's `recapText` + `SessionLine.recapLabel` |
| off pass: both recapped rows fall back to their raw replies; **no** `Recap · ` anywhere; S2 and S3 unchanged | the stub's replies, and `SessionLine.make`'s `recaps:` gate |
| the Settings switch row and its hint | `SettingsCopy.sessionRecaps` / `sessionRecapsHint` via `SettingsHome.Row.recaps` |

The off pass **fails** on a stray `Recap · ` (that is the entire point of the pass); everything else
is a note beside the picture, as the template's probes do — a picture that is kept even when a claim
comes back wrong is worth more than a pass that stops at the first surprise.

The clock time in the label is the DEVICE's (`DateFormatter`, short style, and "today" is
`Calendar.isDate(inSameDayAs:)`), so the test never asserts a clock it cannot know — S1's label is
`Recap · <whatever the runner's clock said>` and S4's grows the date. On the CI runner (UTC) S1
reads `Recap · 9:36 PM`-style and S4 `Recap · Thu, Aug 6, 5:38 PM`.

## Pictures this should produce

`shots/` is the artifact (`session-recap-shots`), published to `probe/session-recap-native-results`.

| File | What it is |
|---|---|
| `ios/ios-list-with-recap.png` | iPhone, recaps on: S1 with the label + recap sentence, S2's reply, S3 `Running Bash…`, S4's dated label |
| `ios/ios-settings-session-recaps.png` | iPhone, Settings → Sessions: the "Session recaps" switch and its hint |
| `ios/ios-list-with-recaps-off.png` | iPhone, `--recaps-off`: S1 and S4 back on their raw replies, no label anywhere |
| `mac/mac-list-with-recap.png`, `mac/mac-list-with-recaps-off.png`, `mac/mac-settings-session-recaps.png` | the same three, as the UI test's own shot of the Mac window |
| `mac/mac-window-mac-*.png` | the same window written by the app itself (`-probe.shot`) — kept beside the UI test's, because either can come back empty for its own reasons |
| `tree-*.txt` | the accessibility tree of each pictured screen, beside the picture |
| `<platform>-notes.txt` | every claim above, answered (`shown` / `MISSING` / `confirmed` / `NO`) |
| `<platform>/requests-on.log`, `requests-off.log` | what each pass asked the stub, every line stamped `[recaps-on]` or `[recaps-off]` |
| `<platform>/writes.txt` | should be EMPTY: the probe reads, it never presses |
| `<platform>/not-served.txt` | the counted 404s, i.e. what the probe did not think of |
| `outcomes.txt`, `.done-probe`, `run-output.log`, `summary-*`/`tail-*` | the run's own record, as the source-refused probe collects it |

## How the human runs it

The harness is already on this branch. What has to happen on a Mac runner:

```sh
# 1. a throwaway probe branch with the workflow copy in place (never merged)
git checkout -b probe/session-recap-native
cp docs/evidence/session-recap-native/ci/client.yml.probe-diff .github/workflows/client.yml
git add .github/workflows/client.yml
git commit -m "probe: session-recap evidence run"
git push -u origin probe/session-recap-native

# 2. dispatch it (the input is what actually runs the probe)
gh workflow run client.yml --ref probe/session-recap-native -f session_recap_probe=true

# 3. watch it (the whole workflow takes both compile gates plus the ~90-minute probe job)
gh run list --workflow=client.yml --branch probe/session-recap-native --limit 3
gh run watch <run-id>

# 4a. read the pictures without a token: they are also pushed to a results branch
git fetch origin probe/session-recap-native-results
git show probe/session-recap-native-results:ios/ios-list-with-recap.png > /tmp/ios-list-with-recap.png
git show probe/session-recap-native-results:ios/ios-list-with-recaps-off.png > /tmp/ios-list-with-recaps-off.png
git show probe/session-recap-native-results:mac/mac-list-with-recap.png > /tmp/mac-list-with-recap.png

# 4b. or with a token, the whole artifact
gh run download <run-id> -n session-recap-shots -D /tmp/recap-shots
```

An ordinary dispatch (no `-f session_recap_probe=true`) compiles the branch and takes no pictures,
which is what the probe branch should be used for except while photographing.

The `macos` and `ios` compile gates still run on that dispatch, and they are the first real compile
of the feature branch's `SessionLine.label`, `UserPreferences.recaps`, the AgentsView row and the
two Settings toggles — this host has no Xcode, so nothing here has ever been compiled.

## What I could NOT verify on this host (no Xcode, no Swift, no simulator)

- **Nothing Swift was compiled.** No `xcodebuild`, no `xcodegen`, no `swift build`. The Swift files
  are renames of files that did compile in the source-refused probe, but every type name, launch
  argument and helper signature in them is unchecked. A missing import or a signature drift is the
  most likely first-CI failure, and it is cheap to fix.
- **`stub.py` IS verified**: `python3 -m py_compile` passes, and a smoke run on this host served the
  four sessions (four rows, the recap fields, the nested agent), answered `me` with
  `preferences: {"theme": "system", "recaps": false}` under `--recaps-off`, 404'd an unknown path
  into the log, and stamped the mode on every line.
- Both YAML files parse (`client.yml.probe-diff` loads with its eight jobs; `project.yml` loads),
  and `run.sh` / `ios-shot.sh` / `mac-shot.sh` pass `bash -n`.
- The workflow copy was diffed against `.github/workflows/client.yml`: the only changes are the
  header comment, the one new dispatch input, and the two new jobs. The build gates and the
  source-refused jobs are byte-for-byte the file they were copied from.

## Where the first CI run may need a fix (specific, in the order I would look)

1. **The list landing has never been photographed by this family of probes.** The template always
   routed into a session; here `ProbeArgs.land` stops at the workspace and trusts
   `AgentPanes`' own `.task` → `AgentsModel.loadSessions` → `AppModel.loadSessions` →
   `OpenListReader.read()` → `GET /api/sessions?view=open&since=`. The stub answers every spelling
   with the plain array (what a server without the delta read answers, which the reader already
   falls back from). If the launch instead sits on "Loading…" / "Select a workspace", the fix is to
   call `model.loadSessions()` (AppModel, internal) from `land` before the loop, or to set
   `model.agents?.refreshOpen` explicitly. The `missing-<name>.txt` tree written by `launch` will
   say which of the two it is.
2. **`TEST_RUNNER_RECAPS_OFF` forwarding.** If xcodebuild does not strip-and-forward that variable
   the way it does `TEST_RUNNER_SHOTS_DIR` (it should — same mechanism), the off pass would run the
   on-pass assertions against an off stub and fail with "a Recap label is drawn with the switch
   off". The fallback is a `/__mode` read on the stub (the test asks the stub itself which mode it
   serves, as `requestsLog()` already asks it for the log) — deliberately not built yet, so that the
   env-var path is what gets exercised.
3. **The accessibility shape of the second line.** `AgentSessionRow.lineText` is
   `Text(label + " ") + Text(text)` on iOS (inside a row with `.accessibilityElement(children:
   .combine)`) and its own static text on macOS (read off `value`). If SwiftUI exposes the two
   `Text`s as two elements instead of one, `holds([label, recapText])` comes back false, the note
   says `NO`, and the picture still shows the truth — the claim would then be narrowed to two
   searches (the label, the sentence) and the notes file is where that shows first.
4. **The Mac Settings scroll.** The form is the split view's middle column; I scroll at 20% of the
   window's width (`macScrollX = 0.2`) because the source list is folded away with
   `-shell.sidebarVisible NO` and the column should be the window's left third. If the picture
   lands on the wrong column or on a half-scrolled form, that one number is the fix — or, if the
   column proves unwieldy, add the production `Settings { SettingsView() }` scene to the Mac probe
   and open it with ⌘, (the real app has it; the probe does not yet). The picture is taken even when
   the switch is out of view, so a bad one is visible rather than absent.
5. **The phone's Settings sheet may need the drag** (`band()` performs it) — if the drag inside a
   sheet does something else (a sheet can swallow a vertical drag), the picture may be of the list
   under it. The recaps row is the 5th row of the first group, so it may simply be in view already.
6. **Four passes inside 90 minutes.** Two builds + four `xcodebuild test` runs. The source-refused
   probe took ~2 minutes per pass on `macos-26` plus builds, so this should fit with room to spare;
   if it does not, dropping to one mode per dispatch (the mode is already the stub's flag alone) is
   the obvious trim.
7. **The Mac UI-test screenshot of a titled window.** Believed fine (the source-refused probe lost
   its Mac XCUITest pictures only because `WindowFit` made the window borderless, and nothing here
   removes the title); the app-written `mac-window-*.png` is the picture that does not depend on it
   either way. If both are missing, `mac/recap-window-*.log` (collected into `shots/mac/`) says what
   the window server did.
8. **`project.yml` target/scheme names.** All renamed (`RecapProbe`, `RecapProbeUITests`,
   `RecapMacProbe`, `RecapMacProbeUITests`); a typo anywhere there fails at `xcodegen generate` or
   `xcodebuild -scheme` before anything is photographed. The bundle ids changed with them
   (`io.orbitd.recapprobe`, `io.orbitd.recapmacprobe`), which is what `ios-shot.sh` launches.
9. **`settingsSheet(model)` is an internal extension on `View` defined in
   `SettingsSheet.swift` under `#if os(iOS)`; the iOS probe calls it because the file that normally
   attaches it (`OrbitiOSApp.swift`) is the one the probe replaces. If a merge moves that extension,
   the probe stops compiling rather than silently photographing something else.
