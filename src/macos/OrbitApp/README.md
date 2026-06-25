# OrbitApp (Phase 1–2 — interactive console)

The SwiftUI shell on top of [`OrbitKit`](../OrbitKit).

- **Phase 1:** instance + login, an **Active** sessions sidebar (Needs-you / Running / Queued),
  and a **live transcript** (streaming text, thinking, tool cards) over SSE.
- **Phase 2:** the **composer** (text/shell, model + permission-mode pickers, attachments,
  send / queue / interrupt), the three **approval cards** (tool-permission with "allow &
  remember", AskUserQuestion form, ExitPlanMode), the **worktree bar** (changed-file count,
  diff sheet, Commit / Merge) and a **background-process tray**.
- **Phase 3 — native shell:** a **MenuBarExtra** (glanceable summary + jump into "needs you"),
  **actionable notifications** (Allow / Deny / Reply right on the banner — the killer feature:
  fire a session, close the window, get pinged to approve), a **Dock badge**, and **`orbit://`
  deep links**. Notifications are driven by a poll-to-poll diff of the Active list
  (`SessionDelta`), so they cover *all* sessions, not just the open one.
- **Phase 4 — local runner control** (the "two-in-one" native-only half): detect the runner
  this Mac hosts (`~/.orbit/config.json`), show service status, **Start / Stop / Restart** via
  `launchctl`, tail `runner.log`, show the server-side online/slots, and **enroll this Mac in
  one app** (device flow + self-approve, since we're already the signed-in user). Reached from
  the toolbar; the launchd `Process` calls are why distribution is Developer-ID, not MAS.

## Build & run (macOS only)

```bash
cd src/macos/OrbitApp
swift run            # or: open Package.swift  (Xcode → Run)
```

Requires macOS 14+ (Observation, `ContentUnavailableView`, `MenuBarExtra`). SwiftUI is an
Apple-only framework, so this target **does not build on Linux** — that's exactly why it's a
separate package from OrbitKit (whose pure logic stays Linux-CI-testable).

> ⚠️ **Verification status:** OrbitKit is unit-tested (`swift test`, green on Linux + macOS).
> This SwiftUI layer is written against the macOS 14 SDK but has **not been compiled here**
> (no macOS toolchain in this environment). Build it in Xcode/`swift run` on a Mac; expect to
> fix minor SDK nits on first compile. All non-trivial logic it relies on (SSE parsing,
> transcript reduction, session grouping, URL normalization) is in OrbitKit and *is* verified.

## Structure

```
Sources/OrbitApp/
  OrbitApp.swift        @main App + RootView (login ⇄ main switch)
  AppModel.swift        @Observable: instance, auth, Active list (4s poll), selection
  ConsoleModel.swift    @Observable: one session's SSE loop + send/approve/commit/merge actions
  Views/
    LoginView.swift     instance URL + email/password
    MainView.swift      NavigationSplitView + ActiveSidebar + SessionRow
    ConsoleView.swift   transcript (bubbles/tools/thinking) + assembles the bars below
    ComposerView.swift  input + model/permission pickers + shell toggle + send/interrupt
    ApprovalCards.swift ToolApprovalCard · QuestionCard · PlanCard (the 3 kinds)
    WorktreeBar.swift   change summary + Commit/Merge + DiffSheet + BackgroundTrayView
    MenuBarContent.swift  the menu-bar dropdown (summary + quick items)
    RunnerControlPane.swift  local-runner status/controls/log + enroll-this-Mac (sheet)
  NotificationManager.swift  UNUserNotificationCenter shell (auth, categories, post, responses)
  RunnerControl.swift   launchctl via Process + config/log IO + one-app device enrollment
```

All the tricky logic — bash remember-rule (`git commit -m x` → `Bash(git commit:*)`),
AskUserQuestion parsing, send/queue gating, multipart framing, **deep-link routing, the
poll-diff that decides what to notify, notification text/actions, the menu-bar/Dock summary,
and the runner path/config/launchctl-output/device-flow parsing** — lives in OrbitKit and is
unit-tested (**41 tests**). These views + managers are the unverified (macOS-only) shell over it.

### Phase 3 needs a real app bundle

`swift run` is fine for the window, menu bar, and Dock badge, but **`UNUserNotificationCenter`
and the `orbit://` URL scheme require a proper `.app` bundle** (bundle id, `Info.plist` with
`CFBundleURLTypes`, the notification entitlement). In-app notification *routing* (tap → intent →
action) is wired and the logic is tested, but banners won't actually deliver until this is
built as an **Xcode app target** (the Phase 5 packaging step). Until then, treat Phase 3's
delivery as code-complete-but-undelivered; its decision logic is verified.

### Deferred: global hotkey

A true system-wide "summon quick composer" hotkey needs Carbon `RegisterEventHotKey` (or an
Accessibility-permissioned event tap) — fragile glue that can't be verified here, so it's left
for the Xcode-target phase rather than shipped untested. Everything else in Phase 3 is in.

## Design notes

- **All protocol logic is in OrbitKit.** The app is views + two `@Observable` view models.
  `ConsoleModel` owns a `TranscriptReducer` and runs the reconnect loop *on the main actor*,
  so the transcript is never read cross-thread while being mutated.
- **Native auth edge:** `ConsoleModel` uses `URLSessionEventStream`, which sets the
  `Authorization` header (browsers can't, hence the web's `?access_token=`).
- **Token storage:** `KeychainTokenStore` (per-instance). The last instance URL is remembered
  in `UserDefaults`; a still-valid Keychain token skips the login screen.

## Toward production (later phases)

`swift run` launches an unbundled binary — fine for dev. Notifications, `MenuBarExtra`,
global hotkey, code-signing and notarization (Phase 3 / 5) want a real **Xcode app target**
with an `Info.plist` and entitlements. Add that target alongside this package when starting
Phase 3.
