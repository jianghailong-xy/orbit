# Orbit — iOS client

A native SwiftUI client for iPhone + iPad. It is a **remote console**: view and drive sessions,
answer approvals, manage tasks/agents/skills/runners over the same REST + SSE API as the web and
macOS clients. The iOS sandbox forbids controlling a local runner (no process/launchd access), so —
unlike macOS — there is no local-runner surface here. You still need a Mac/Linux runner elsewhere.

## Structure (why this looks the way it does)

The app reuses the macOS shell's shared SwiftUI in place — **Structure B**. There is no copy of the
views: this target compiles the same `.swift` files out of `../macos/OrbitApp/Sources/OrbitApp`,
minus the macOS-only ones, plus the iOS-only files in `Sources/`.

```
src/ios/
  project.yml                 # XcodeGen spec — the checked-in source of truth for the .xcodeproj
  Sources/OrbitiOSApp.swift   # iOS @main entry (no menu-bar/Settings/Window scenes, no Sparkle)
  Support/Info.plist          # bundle keys, orbit:// URL scheme, orientations
  Support/Orbit.entitlements  # empty for now; APNs keys land in Phase E
  Support/Assets.xcassets     # AppIcon (placeholder, reuses the macOS mark) + AccentColor
  .github/workflows/ios-client.yml   # (repo root) generate + build on CI

../macos/OrbitKit             # shared cross-platform core (models, SSE, transcript reducer) — SPM dep
../macos/OrbitApp/Sources     # shared SwiftUI views + @Observable models, referenced in place
```

Cross-platform seams live in `../macos/OrbitApp/Sources/OrbitApp/Platform.swift`
(`PlatformImage`, `PlatformPasteboard`, `Color(light:dark:)`, `borderlessMenuStyle()`); the few
macOS-only touch-points in shared files are behind `#if os(macOS)`.

### Files excluded from the iOS target
Kept in sync in `project.yml`'s `excludes:` — `OrbitApp.swift` (macOS app entry), `HotKeyManager`,
`UpdaterModel` (Sparkle), `RunnerControl` + `RunnerControlPane` (launchctl), `MenuBarContent`.

## Build (requires a Mac — iOS apps can't build on Linux)

```sh
brew install xcodegen          # once
cd src/ios
xcodegen generate              # regenerate Orbit.xcodeproj after any project.yml / file change
open Orbit.xcodeproj           # ⌘R to run on a simulator
# or headless:
xcodebuild -project Orbit.xcodeproj -target Orbit -sdk iphonesimulator \
  CODE_SIGNING_ALLOWED=NO build
```

`Orbit.xcodeproj` is generated and git-ignored — edit `project.yml`, not the project. On Linux only
OrbitKit (`cd ../macos/OrbitKit && swift test`) is verifiable; the SwiftUI layer compiles on the Mac
CI job.

## Roadmap

- **B (this)** — Xcode project stands up, shared sources wired, cross-platform shims. ← done
- **C** — adaptive navigation shell (iPhone stack/tab, iPad three-column).
- **D** — iOS-native polish: pull-to-refresh, keyboard avoidance, PHPicker/`.fileImporter`, paste.
- **E** — APNs push (device-token registration + server push for "needs your reply") + icon badge.
- **F** — signing, App Store Connect, TestFlight release workflow; proper full-bleed app-icon art.
