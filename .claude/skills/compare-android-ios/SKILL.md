---
name: compare-android-ios
description: Compare one Orbit page on Android and iOS end to end. Screenshot it on the Android emulator (Pixel 10 Pro display) and on the iOS Simulator (iPhone 17 Pro, on the Mac mini, by DeepSeek V4.1 Flash), in light and dark, then report every difference element by element with pixel-measured colours. Use when someone asks whether an Android page matches iOS, wants the two platforms compared, wants "the differences from iOS" found or fixed, or wants side-by-side screenshots of both clients.
---

# Compare a page on Android and iOS

iOS is the reference for layout; a `docs/mocks/*` board overrides both. This skill runs the whole comparison. The
`client-screenshots` skill (`.claude/skills/client-screenshots/SKILL.md`) explains each platform's harness in depth: read
it when a step here fails.

**What you get:** four PNGs (each platform in light and dark), a table of every element, and a short list of real
differences. Don't change product code during a comparison unless the person asked for fixes.

## 0. Settle the inputs (a minute, before anything runs)

| Input | Example (the new session page) | How to find it |
|---|---|---|
| Android journey | `newSessionUsesWorkspaceDraftAndNavigatesAfterCreation` | `rg -n '@Test fun' src/android/app/src/androidTest/kotlin/io/orbitd/android/composer/ComposerDeviceTest.kt` |
| Android capture | `new-session-draft` | the `capture("…")` in that journey. If the page has none, add one line once the page has settled (client-screenshots A0) |
| iOS landing flag | `-probe.draft` | `-probe.session S1`, `-probe.list` and `-probe.machine runner\|claude` exist. Anything else gets a branch in ProbeArgs (client-screenshots B2) |
| iOS "drawn" words | `Runs in:` (the place pill's label) | words on the page that only show once it has loaded |
| Hand-back branch | `probe/compare-new-session` | `probe/compare-<page>`, deleted at step 3 |

**iOS shows the Mac's HEAD.** The Mac SubAgent builds whatever the Mac's checkout holds and cannot see this one. If the
iOS side has changed and isn't on the Mac yet, say so in the report, or get it pushed and checked out there first. Android
always shows this checkout, uncommitted changes included.

## 1. Start iOS first (it is the slow side, ~15–25 min)

```bash
bash .claude/skills/compare-android-ios/ios-brief.sh -probe.draft "Runs in:" probe/compare-new-session > /tmp/ios-brief.txt
```

Send the brief to the Mac with Orbit's `delegate`. Load it with ToolSearch `select:mcp__orbit__delegate` if it's
deferred. Pass `workspace: "orbit-macos"`, `model: "deepseek-flash"`, `background: true` and `size: "M"`, with the
contents of `/tmp/ios-brief.txt` as `prompt`, word for word. Check the Mac can run it first if you like:
`provider_list(workspace: "orbit-macos")` should show `deepseek` × `claude` usable.

## 2. Android meanwhile

```bash
bash .claude/skills/compare-android-ios/android-shots.sh newSessionUsesWorkspaceDraftAndNavigatesAfterCreation <uploads dir>
```

Run it with `bg_run` (kind `job`, `wakeOnExit: true`) and end the turn. Don't poll. It builds both APKs under a 6 GB cap,
boots the shared emulator if it is down, and runs the journey at 1280×2856 / 480 dpi, light then dark. It retries once on
"process failed to attach". Each run prints `SHOTS <mode> <dir> exit=<n>`, and the PNGs are in `<dir>/a07-composer/`.

- **A failed journey can still have the shot you need:** the capture is taken before later steps fail. Look for
  `<capture>.png` before rerunning. Then find out whether the failure is yours: device journeys aren't run by any gate, so a
  stale string can come from main. Check the failing line against `git log -S` on the product string.
- `BUILD_FAILED … looks OOM-killed`: the host ran out of memory, not your code. Wait for other Gradle builds
  (`pgrep -fa '[G]radleWrapperMain'`) and run it again.
- Never stop or restart `orbit-android-emulator.service`, and never `adb kill-server`: other tasks share the device.

## 3. Bring iOS back

When the SubAgent's result arrives, run:

```bash
bash .claude/skills/compare-android-ios/fetch-ios-shots.sh probe/compare-new-session <uploads dir>/ios-<page>
```

The script copies `ios-shot.png`, `ios-shot-dark.png` and `tree.txt`, then deletes the branch. Check both PNGs are
1206×2622 (`file *.png`). If the SubAgent ended with no result or was interrupted, resume it with `delegate(resume: <runId>)`
and don't start a second one.

## 4. Compare

Open all four PNGs with the Read tool. Then go top to bottom and fill one row per element: status/nav bar (title,
alignment, buttons), page header, main content (order, alignment, type size and weight, icons, spacing), empty state, the
composer (pills, gauge, send, placeholder), whether the keyboard is up, and the backgrounds behind each layer.

Settle colours, outlines and shadows with numbers, not by eye:

```bash
python3 .claude/skills/compare-android-ios/sample.py ios-shot-dark.png 600,1250 400,1530      # page, card
python3 .claude/skills/compare-android-ios/sample.py <android png> 640,1300 400,1690
python3 .claude/skills/compare-android-ios/sample.py ios-shot.png --ink 860,1540,1010,1660 '#fbfbfb'   # is there an outline at all?
```

The same element sits at different pixels on each side. Find it on each image first. A colour that differs by a few
units (`#fdfdfe` vs `#ffffff`) reads as the same. A tint (`#242b33` vs `#1a1a1a`) or an outline one side has and the other
doesn't is a real difference.

Sort each row into one of four kinds:
- **Same.**
- **Platform convention**, which stays: Material back arrow vs iOS chevron, left vs centred title, status bar, keyboard
  design, system font.
- **Test data**, not UI: the two fixtures differ. Android has workspace "Composer fixture", Codex, Fixture One and Default.
  iOS has orbit-develop, Claude Code, Opus 5.5 and Auto.
- **Real difference.** Say which file draws it on each side if you can (`rg` the words on the Android side, and look at
  the iOS view the probe lands on). Say whether it's this page's alone or shared, such as the theme or the composer,
  because a shared fix changes every page that uses it.

## 5. Report

The four PNGs as links (`[iOS light](path)`, …), the table, then the real differences in order of how visible they are.
Also give the Mac HEAD the iOS shots came from and the Android `sha=`/`dirty=` from `a07-composer/identity.txt`. Ask
before fixing a shared difference. When fixing, rerun only step 2 for Android, plus the unit tests of the code you
touched, and compare against the same iOS shots.
