# OrbitApp — the macOS SwiftUI shell

The SwiftUI shell on top of [`OrbitKit`](../OrbitKit). Shipped as a signed + notarized
Developer-ID DMG with Sparkle auto-update (`.github/workflows/release.yml`).

**The iOS app compiles these same sources.** `src/ios/project.yml` pulls
`Sources/OrbitApp` in wholesale and excludes only the macOS-only files (see below), so a change
here is a change to both clients — and the CI compile gate runs both.

## What's in it

- **Console** — live transcript over SSE (streaming text, thinking, tool cards, images), the
  composer (text/shell, model + permission-mode + effort pickers, attachments, send / queue /
  interrupt), the three **approval cards** (tool-permission with "allow & remember",
  AskUserQuestion form, ExitPlanMode), the **worktree bar** (changed-file count, diff sheet,
  Commit / Merge) and a **background-process tray**.
- **Native shell** — a **MenuBarExtra** (glanceable summary + jump into "needs you"),
  **actionable notifications** (Allow / Deny / Reply right on the banner — the killer feature:
  fire a session, close the window, get pinged to approve), a **Dock badge**, **`orbit://`
  deep links**, and a global hotkey.
- **Local runner control** (the native-only half): detect the runner this Mac hosts
  (`~/.orbit/config.json`), show service status, **Start / Stop / Restart** via `launchctl`,
  tail `runner.log`, show the server-side online/slots, and **enroll this Mac in one app**
  (device flow + self-approve, since we're already the signed-in user). The launchd `Process`
  calls are why distribution is Developer-ID, not MAS.
- **The rest of the product** — agents, tasks, skills, runners, providers, admin, session tags,
  ⌘K cross-session search, share sheet, and settings, so the app isn't a console-only companion.

Notifications are driven by a diff of the session list (`SessionDelta`), so they cover *all*
sessions, not just the open one. The list itself is kept fresh by the user-level control-plane
stream (`GET /api/events`), with polling as the fallback when that stream is down — see
`docs/realtime-control-plane-stream.md`.

## Build & run (macOS only)

```bash
cd src/macos/OrbitApp
swift run            # or: open Package.swift  (Xcode → Run)
```

Requires macOS 14+ (Observation, `ContentUnavailableView`, `MenuBarExtra`). SwiftUI is an
Apple-only framework, so this target **does not build on Linux** — that's exactly why it's a
separate package from OrbitKit (whose pure logic stays Linux-CI-testable).

`swift run` launches an *unbundled* binary: fine for the window, menu bar and Dock badge, but
`UNUserNotificationCenter` and the `orbit://` URL scheme need a real `.app` bundle (bundle id,
`Info.plist` with `CFBundleURLTypes`, the notification entitlement). Use the packaged build
(`scripts/build-dmg.sh` / the release workflow) when testing banners or deep links.

## Verification

- **OrbitKit** — `swift test`, green on Linux and macOS; that's where the load-bearing logic
  lives (see its README for why `App/` exists).
- **This layer** — compiled by the `macos` job in `.github/workflows/client.yml`
  (`swift build`) and by the `ios` job via `xcodebuild`, both on pull requests. There are no
  unit tests here by design: anything worth asserting is pushed down into `OrbitKit/App/`.
  A macOS-runner job is 10× billing, so the gates run on PRs and manual dispatch, not on
  every branch push — a branch that only ever gets pushed has *not* been compiled.

## Structure

```
Sources/OrbitApp/
  OrbitApp.swift          @main App + RootView (macOS-only; iOS has its own entry)
  AppModel.swift          @Observable: instance, auth, session lists, control-plane stream, selection
  ConsoleModel.swift      @Observable: one session's SSE loop + send/approve/commit/merge actions
  ConsoleRegistry.swift   per-instance console cache (+ on-disk transcript store), so switching
                          sessions rehydrates instead of rebuilding and replaying from seq 0
  AgentsModel · TasksModel · RunnersModel · AdminModel · WorktreeModel   the other surfaces
  AttachmentImageStore.swift  fetch + cache attachment images
  NotificationManager.swift   UNUserNotificationCenter shell (auth, categories, post, responses)
  RunnerControl.swift     launchctl via Process + config/log IO + one-app device enrollment  [macOS]
  HotKeyManager.swift     global hotkey  [macOS]
  UpdaterModel.swift      Sparkle  [macOS]
  Platform.swift          the cross-platform seam (PlatformImage, PlatformPasteboard, Color(light:dark:), …)
  Views/
    Typography.swift      the ONLY file allowed to hold fixed font sizes (CI enforces this)
    LoginView · MainView · CompactShell        shells: split-view (macOS/iPad) and compact (iPhone)
    Console/              ConsoleView · MessageBubbles · ToolCards · attachments · image viewer ·
                          link detection · selectable text
    ComposerView · ApprovalCards · WorktreeBar · MarkdownView · ToastHost
    AgentsView · TasksView · SkillsRunnersView · SettingsAdminView · SessionSearchView ·
    SessionTagViews · SessionRowActions · ShareSheet · AgentIdentity · BrandMarks
    MenuBarContent.swift · RunnerControlPane.swift    [macOS]
```

Files marked `[macOS]` are the ones `src/ios/project.yml` excludes. **Adding a file here adds it
to the iOS target automatically** — that's the point of Structure B, but it also means a new file
using a macOS-only API breaks the iOS build; put it behind `#if os(macOS)` or add it to the
exclude list.

## Design notes

- **All protocol logic is in OrbitKit.** The app is views + `@Observable` view models.
  `ConsoleModel` owns a `TranscriptReducer` and runs the reconnect loop *on the main actor*,
  so the transcript is never read cross-thread while being mutated.
- **Native auth edge:** `ConsoleModel` uses `URLSessionEventStream`, which sets the
  `Authorization` header (browsers can't, hence the web's `?access_token=`).
- **Token storage:** `KeychainTokenStore` (per-instance). The last instance URL is remembered
  in `UserDefaults`; a still-valid Keychain token skips the login screen, and an expired access
  token is refreshed rather than bouncing the user to login.
- **Typography:** pick a `Font.orbit*` token by role, never a raw size. The tokens fork per
  platform (iOS tracks Dynamic Type; macOS pins the denser desktop ramp), which is why the CI
  `font-tokens` job hard-fails on a bare `system(size:)` outside `Views/Typography.swift`.
