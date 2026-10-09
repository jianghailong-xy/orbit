# A13 · Workspace, Runner and Settings management

Kotlin + Compose on Android 10–16 (minSdk 29). Android is a remote client: every page here reads and
writes the existing Orbit API with the signed-in account's own handle (A03 `AuthSession`); the phone
never hosts a Runner. Directory display and routing stay A05's; in-session model/account choice stays
A07's (A13c adds only its account rows' data model, see A13c below); notification permission and delivery stay A10's.

## Identity

| Item | Value |
| --- | --- |
| Task initial HEAD | `3cb12b3be2a38c55601786bdfa1967f60a86990a` |
| Fixed inputs (ordinary merges, unchanged) | A07 `51bbcc303cec3c64dfb217316afce9498add760d`; A10 `482b132e8c57053113f2e3fa467d02de2b809d95` (combined `afb311c3becdf940ea728fcc859d9a96cb342cbf`) |
| Run-1 snapshot restored verbatim | `1042bfbd2355ff69aaee20149bd1d73e7009f390` (Codex run, then rewritten here against the iOS sources) |
| Baseline read | iOS-compiled SwiftUI in `src/macos/OrbitApp/Sources/OrbitApp/Views` (`SettingsSheet`, `SkillsRunnersView`, `Runner*`, `AddRunnerSheet`, `AccountPauseControls`, `ProviderPoolViews`, `SettingsAdminView`, `ShareSheet`, `AgentsView` form) and OrbitKit `App/` (`SettingsHome`, `RunnerAttention`, `RunnerPageFormat`, `RunnerPageCopy`, `ProviderPoolLogic`, `SharedPoolPage`, `CodexPoolPage`, `CodexLoginPool`, `SharedPoolAdapter`, `WhoCanUseIt`, `AddPoolKey`, `CodexSignIn`, `SharePanel`, `SharedLinksList`, `AgentDefaults`, `AccountPause`) at the task's source tree; server contracts in `src/apiserver/src/{users,auth,runners,workspaces,providers,share-links,sessions}` |
| Server for the real-stack runs | `ff66e748a2b33ab336fb4ece811c18404a7d413d` of this branch: `src/apiserver` and `src/runner-go` are byte-identical to the task's initial HEAD; `src/shared` differs only by two card fixture JSON files from the inherited inputs |

The correspondence below is read from source. The behaviour was then run against an isolated real Orbit server
(see Verification). It is not an installed-iOS same-data comparison.

## Correspondence

| iOS baseline | Android | Endpoints |
| --- | --- | --- |
| Settings sheet (`SettingsHome`): avatar + name header → Edit profile; Sessions (Default permission menu, Session orchestration switch); Machines & models (Runners “N of M online”, Providers); Preferences (Notifications On/Off, Appearance menu); Account (Email, Instance host[:port], Shared links “N active”, Change password, Admin only for ADMIN); Sign out asking “Sign out?” (A13d: no server name, as iOS 6969f7840); version line | `SettingsScreen.kt` `SettingsHome`: same groups, rows and their glyphs (`SettingsHome.systemImage` drawn as app vectors), pencil badge on the avatar, row values, in-row menus/switch, confirmation; version line plus the existing A02 Build information link. “Notifications are off · Turn on” card when the device has push but alerts are off. The status and navigation bar icons follow the account’s Appearance, not the system’s (`AccountAppearance` re-applies edge-to-edge) | `GET users/me`, `PATCH users/me/preferences` (one key per write), `GET runners`, `GET share-links` |
| Edit profile card: photo menu (Photo library, Take photo, Choose file, Remove photo), round crop, Name + caption, Save profile (photo first, then name; a landed step stays), failure “Couldn’t save your photo/name — …” | `PersonalSettings.kt` `EditProfile`: same menu behind the camera-badged avatar (system photo picker / camera / documents); the crop is iOS `AvatarCropView` — pinch to zoom, drag to place, the circle always covered (`AvatarCrop` ported from OrbitKit with its tests), TalkBack Zoom in / Zoom out; 512 px JPEG on white; same steps and wording | `PUT/DELETE/GET users/me/avatar` (multipart `file`), `PATCH users/me` |
| Change password page: three fields, footer outcome / “Passwords do not match” / “At least 6 characters” | `ChangePassword` | `POST auth/change-password` (wrong password is a 400, never a sign-out) |
| Notifications page: device section; “Sent to all your devices” two switches with hints; “Always sent” list | Device section is A10’s `NotificationSettings(app.push)`; account switches and Always-sent rows here. An unconfigured FCM build reads “Unavailable”, never On | `PATCH users/me/preferences` |
| Runners list: status dot, name, slots + bar, subtitle (host · v / Offline · last seen), attention line; Edit → reorder / delete (“Remove “x”?”); Add Runner + footer; load/fail/Retry | `RunnerScreens.kt` `RunnersList`: same rows; Edit reorders by dragging the "≡" handle, as on iOS (one `reorder` on release; TalkBack Move up / Move down), and removes with a Remove button instead of the swipe (agreed exception) | `GET runners`, `GET workspaces`, `POST runners/reorder`, `DELETE runners/:id`, `GET <origin>/dl/version.json` (unauthenticated) |
| Runner page: head (status line, host line); Needs Attention (`RunnerAttention` — offline, signed out, stuck checkout → Repair, quota, disk → Set a Reserve…, can’t update itself or install folder isn’t writable → Copy Command, updates turned off, runner update failed → Update Runner Now, engine not updating → Update Engines Now); Capacity (Max Concurrent stepper, Disk gauge, Keep Free Off/10/20/50 GB); Engines (rows → engine page, Update Engines Now + relay, Refresh Model Lists, footers); Workspaces (opens the workspace’s sessions, running counts, footer); About (Name page, Hostname, Version · Latest, Last Update, Update Runner Now, Runs As, Repos Folder, Last Check-in, Registered, root footer); Rotate Token… (shown once + Copy); Remove Runner | `RunnerDetail` with `RunnerPage.kt` (a port of the three OrbitKit files); the Needs Attention rule is checked against the web/iOS case file `src/web/src/lib/runnerAttention.cases.json` (81 cases since v4) | `PATCH runners/:id` (`maxConcurrent`, `minFreeDiskMb` incl. explicit null, `displayName`), `POST runners/:id/{engine-update,refresh-models,rotate-token,self-update}`, `POST workspaces/:id/repo-cleanup`, `GET sessions/counts`, `DELETE runners/:id` |
| Engine page: version · update note; Accounts / Sign-In; per account: home, Signed in/out, quota windows or “No quota reported” — a Kimi account whose plan has none reads “No quota limit” — refused removal, Sign In / Sign In Again or pause controls; Rename… (alert), Remove (asks; Default never); Add Account (picked name, starts at once, renames once reported); Update Engines Now | `RunnerEnginePage`; Rename… and Remove are an overflow menu per account instead of long-press / swipe | `PATCH/DELETE runners/:id/accounts/:engine/:account`, `POST …/:account/pause`, `POST runners/:id/login {engine, account?, accountName?}` (Add Account signs a new one in) |
| Sign-in card (`RunnerSignInView`): pending, device code (copy), paste-back code + Submit, verifying, done, failed/try again, Cancel; 2 s polling while in flight | `RunnerSignInCard` / `SignInRelay` (same states, same ownership rule for the shared relay) | `GET/POST/DELETE runners/:id/login`, `POST runners/:id/login/code` |
| Account pause (`AccountPauseControls`): Paused · Until; Pause… sheet 1/2/4/8 h or custom 1 min–168 h, “Automatically resumes at …”; Resume Now; Change Duration… | `ManagementUi.kt` `AccountPauseControls` (shared by runner accounts and pool members) | `POST …/pause {durationMinutes: n|null}` |
| Name page: placeholder machine name, footer, saved on Done or leaving | `RunnerNamePage` (a save made while leaving runs on the process scope) | `PATCH runners/:id {displayName}` |
| Add Runner sheet: lead, macOS/Linux/Windows, command + Copy/Share, “Waiting for a new runner…” → “Runner online — … · Open”; no-browser code (auto lookup at 10 characters), name conflict → Re-register machine, success line | `AddRunnerDialog` (full-screen dialog) | `GET runners/device/:code`, `POST runners/device/:code/approve` |
| Workspace form (`AgentFormContent`, from the workspace list): Name, Effort (runtime vocabulary), Enabled, Instructions + caption, Working directory, Task runs smart selection, Environment (read only) + note, Delete agent (asks); Cancel / Done (Done saves only a change; blank instructions/path keep the value) | `WorkspaceSettings.kt`, from the workspace’s top-bar gear | `GET/PATCH/DELETE workspaces/:id` (same body as `UpdateAgentRequest`) |
| Providers: On your runners (summary), Account pools (shared first, then own; SHARED chip, line, gauge), Your API keys (label + default model; add/change on the web) | `ProviderManagement.kt` `ProvidersOverview` + `PoolLogic.kt` | `GET runners`, `GET providers`, `GET providers/pools`, `GET providers/shared-pools`, `GET providers/shared-pools/:id` |
| Claude account pool page: availability, headline + gauge, members (NEXT, status words, tightest window), pause, footer | `AccountPoolPage` | `GET providers/pools`, member pause |
| Codex pool page: head (who · people · availability, Add account / Add a key), Accounts (login rows with Sign in again / Sign out; key rows with status, money/cap, Replace / Disable / Remove), Who can use it (owner only: Just me ↔ Me and people I add, people with % share, Remove from pool, Make admin/member, Add people), rules (owner only, once shared), warning card, Delete pool / Leave pool | `CodexPoolPage` (`CodexPoolView`, `WhoCanUseIt`) | `providers/pools/:id/codex-login[ /account?fingerprint=]`, `providers/shared-pools/:id{,/keys,/keys/:id,/keys/:id/secret,/people,/people/:userId,/leave}`, `DELETE providers/pools/:id` (own) |
| Sheets: Add an account (ChatGPT / API key), Sign in with ChatGPT (consent → code → done / expired / failed / duplicate; closing gives the attempt up), Add a key (consent → form → done / duplicate) and Replace key, Share (emails, facts, own-key rule, no-key warning) | Full-screen dialogs with the same steps and words | as above |
| Share panel (`SharePanel`): Only you / Anyone with the link (turning off asks), link + Copy Link / Share Link…, Includes per kind (nested, idle, counts, risk), Updates, Expires (Never/1/7/30 days, Until/Stops working), views line | `SharingSettings.kt` `ShareResourcePanel`; page `ShareResourceSettings(api, revision, kind, id)`; dialogs: A05's session menu (`SessionSharePanel`) and, since v4, A11's task and project ⋯ → Share… (`ShareSheet` hosting `LiveSharePanel`) | `GET/PUT/DELETE {sessions,tasks,projects}/:id/share` |
| Shared links page: Active N / Paused N / Ended N, subtitle, rows (title, where line, views line), Copy Link / Share Link… / Turn off (asks), “Link turned off” / “N links turned off” | `SharingSettings` | `GET share-links`, `POST share-links/turn-off` |
| Admin (ADMIN only): list (name/email · ROLE, New user), user detail (Email, Name, Created, Role Member/Admin, Delete user), New user (Email, Name (optional), caption, Create) | `AdminSettings.kt` (list + detail route + dialog); the generated password is shown once | `GET users/me` then `GET admin/users`, `POST admin/users`, `PATCH admin/users/:id/role`, `DELETE admin/users/:id` |
| Skills | No page: `SkillsView` has no reachable entry on iPhone (not in the drawer, Settings, deep links or any section switch); skills are reachable in the composer, which is A07’s | — |

## Differences from iOS, and why

Platform exceptions were decided by the account owner on 2026-10-07T01:47:03Z (card `34bWoD8me5S1JkP7md90I`,
recorded in task comment `34bWp9aVXd8OFkCPsJSfh`): "accept the Android convention, everything else as iOS".

* Agreed exceptions: swipe actions and long-press menus are visible buttons or an overflow (⋯) menu; bottom
  sheets are full-screen dialogs.
* As iOS (no exception): Runner Edit mode reorders by dragging; the profile photo is cropped by pinching to
  zoom and dragging.
* Kept on purpose (same decision): Delete user asks first (the web asks; iOS deletes at once). Android shows
  the generated password once; iOS decodes `password` while the server sends `generatedPassword`, so it never
  shows it.
* New share links include tool output by default, as iOS and the server do (`PUT …/share {}`). A05's old
  directory dialog opened them with tool output off and turned links off without asking; its session menu
  "Share…" now hosts this panel. The reader gets a Share action in the top bar. Since v4, A11's task and project
  ⋯ → Share… host the same panel.
* iOS defects not copied — Android offers only what the server takes:
  * "Sign in again" on a pool account: iOS asks only who signed it in (`SharedPoolPage.canSignInAgain`,
    OrbitKit `SharedPoolPage.swift:201`). The server also needs an admin, or a member while the pool lets
    members add accounts (`codex-login.service.ts` `assertMayAddAccount`).
  * "Paste an OpenAI API key": iOS offers the choice to any member who may add accounts
    (`CodexPoolPage.swift:127`, `kinds` at `:221`). The server takes keys only from admins, or from members
    while "They can add their own API keys" is on (`shared-pools.service.ts` `addKey`).
  * "Leave pool": iOS offers it to everyone but the owner (`CodexPoolPage.swift:169`). The server refuses any
    admin (`shared-pools.service.ts` `leave`), so a non-creator admin sees it off, with the reason.
  * The runner Name page: iOS saves any difference from the live name when the page goes
    (`RunnerNamePage.swift:68`), which writes an untouched field back over a rename made elsewhere while the
    page was open. Android saves only what was typed, and not on rotation.
* Removed from run 1 because iOS has no such control: Settings → Skills and → Manage workspaces; workspace
  account pinning, routing-engine list, standing-grant revocation and repo-status block; pool "own key first"
  switch; people/rules/role powers for non-owner pool admins; runner Install engine / Cancel install /
  Antigravity sign-in and extra confirmations. Main's iOS has since added Antigravity sign-in (see v4, gap 12).

## Roles and states (server-decided)

| Actor / state | Behaviour |
| --- | --- |
| MEMBER vs ADMIN (account) | Same owner-scoped routes for runners, workspaces, pools and shares. Admin row and pages only when `users/me` says ADMIN; `AdminRoleGuard` re-checks every admin request; a demotion empties the page on the next read. |
| Pool owner / admin / member / contributor | Owner: people, rules, Just me, delete. Admin: add keys/accounts, remove any key, sign out any account; Leave pool is shown off with the server's reason (`leave` refuses any admin until made a member). Member: a key only while "They can add their own API keys" is on, a ChatGPT account (and Sign in again on their own) only while "They can add their own ChatGPT accounts" is on (`addKey`, `assertMayAddAccount`); manage own keys; leave. A new pool starts with both member rules on. A failed people/keys read keeps the last read with Retry; an own pool never read is not called "Just me" and cannot be deleted until read. |
| Runner offline (heartbeat > 90 s or `online:false`) | Needs Attention shows only Offline / Can’t update itself; Update/Refresh hidden; sign-in, add/remove account disabled; capacity, Keep Free, name, rename, pause stay available (server settings). |
| Account signed out / expired | “Signed out” (amber), Sign In; Needs Attention “<engine> is signed out” when a workspace runs on it. |
| Stale or failed reads | Runner pages poll (15 s page, 10 s engine page, 2 s sign-in); a failed read keeps the rows under a notice with Retry; writes always go to the server, which is authoritative. 401/403/404 clear what was shown (`PersonalRecord`). The share panel shows only the failure and Retry after any failed read, and offers no write while the account's live connection is not current (A05's `fresh && !busy`). Forms open on the server's latest record each time: a settings or runner page that has left every navigation stack forgets its saved state (`MainActivity`, A13 routes only). |

## Verification

### Unit and JVM tests (part of the project gate)

`RunnerPageTest` (the 69-case attention file, page formats, `RunnerDrag`), `PoolLogicTest` (owner / non-creator
admin / member, each with the member rules on and off), `SettingsLogicTest`, `PersonalSettingsTest`,
`PersonalAvatarTest` (OrbitKit's `AvatarCrop` tests, ported), `ManagementApiTest`, `ManagementHttpTest` (real OkHttp
and `AuthSession` against MockWebServer), and two suites over a controlled server (`ManagementFixture`):
`ManagementShellTest` drives the real `MainActivity`; `ManagementPanelTest` drives the pages themselves.

Each defect below has a test that failed on the code before its fix and passes after it, on the same input:

| Defect | Test | Red (before the fix) | Green |
| --- | --- | --- | --- |
| P2-1 a cancelled workspace edit came back; the runner Name page wrote an old draft back | `ManagementShellTest` `aCancelledWorkspaceEditIsNotThereWhenTheFormOpensAgain`, `theRunnerNamePageStartsFromTheServerAndNeverWritesAnOldDraftBack` | `bgj_8d29d54232da` (tests `9be50b397` on code `c94e1981e`) | `bgj_4eb164793b2d` (`ff66e748a`, whole unit suite) |
| P2-2 an own pool whose people/keys read failed read “Just me”; Delete understated; later failures hidden | `ManagementPanelTest` `aFailedPeopleReadKeepsWhoCanUseThePoolAndSaysItFailed`, `aPoolWhosePeopleWereNeverReadIsNotCalledJustMineAndCannotBeDeletedBlind` | `bgj_13593fad6838` | `bgj_4eb164793b2d` |
| P2-3 the share panel kept writing after a failed or stale read | `ManagementPanelTest` `aShareRefreshThatFailsStopsWritesAndOffersRetry`; `ManagementShellTest` `theSharePanelStopsWritingWhenTheDirectoryIsNoLongerCurrent` | `bgj_13593fad6838`, `bgj_8d29d54232da` | `bgj_4eb164793b2d` |
| P2-4 “Sign in again” where the server refuses it | `ManagementPanelTest` `aMemberTheRuleLeavesOutIsNotOfferedSignInAgain`; `PoolLogicTest` | `bgj_13593fad6838` | `bgj_4eb164793b2d` |
| P2-5 a key offered to a member the key rule leaves out; Leave pool offered to a non-creator admin | `ManagementPanelTest` `aMemberWhoMayAddAccountsButNotKeysIsNotOfferedAKey`, `anAdminWhoDidNotMakeThePoolIsNotOfferedALeaveTheServerRefuses`; `PoolLogicTest` role × rule matrix | `bgj_13593fad6838` | `bgj_4eb164793b2d` |
| P2-6 the status bar's icons ignored the account's appearance | `ManagementShellTest` `theStatusBarFollowsTheAccountsAppearanceNotTheSystems` | `bgj_8d29d54232da` | `bgj_4eb164793b2d` |
| Found on the real stack: an alias typed just before leaving the Name page was not saved | `ManagementShellTest` `aNameTypedOnTheRunnerNamePageIsSavedWhenThePageGoes` | `bgj_6740c558594a` | `bgj_455fa79ab5f7` (`a39266cec`, whole unit suite) |
| Found by the emulator's 200% tour: Turn off and Share Link… broken mid-word, the SHARED chip upright (a long pool name does the same at any size) | `ManagementPanelTest` `atTwiceTheFontSizeNoButtonOrChipBreaksItsWords` (native graphics, real text measurement) | `bgj_553d9de0eb12` | `bgj_b522a9ea10fd` (whole unit suite, 159 tests) |
| Review 2 (P0): a runner removed in Edit mode left its drag handle under the row that moved into its place; a drag there started on the removed id and crashed (`removeAt(-1)`) | `ManagementPanelTest` `aRemovedRowLeavesNoHandleBehindForTheNextRowsDrag` (both row orders: which of two overlapping handles is found first follows hash order); `RunnerPageTest` `aDragOnARowNotInTheOrderMovesNothing` | `bgj_5d6e194abbe6` (`IndexOutOfBoundsException: Index -1 out of bounds for length 1`) | `bgj_60e7ff7c32d2` (`938f82e7f`, whole unit suite, 162) |
| Review 2 (P3): a very long photo at full zoom asked layout for a size it cannot hold and crashed the crop dialog | `ManagementPanelTest` `aVeryLongPhotoZoomedInAllTheWayStillDraws` (30000×100) | `bgj_5d6e194abbe6` (`Can't represent a width of 265503 … in Constraints`) | `bgj_60e7ff7c32d2` |
| A Max Concurrent press followed by leaving within the 0.9 s settle was lost | `ManagementShellTest` `maxConcurrentIsSavedOnceThePressesSettle` | `bgj_14f522007f0b` (this test with the runner page of `39a838ffb`: two presses give one write, then the press followed by leaving times out) | `bgj_5820b4219a30` (`4a32b7c2a`) |

Also from review 2: a drag cut short by Edit turning off (the gesture is cancelled) no longer leaves the order it had
reached on screen (the drag is cleared in a `finally`); no test reproduced the stale order, so this rests on the
code. Rows now drop their handle and height when they leave, and a drag starts only on a row shown now.

The project gate on the final commit: run on the final commit; its job is cited in the evidence.

### Emulator over controlled HTTP (`scripts/management-device-test.sh`)

API 36 `emulator-5554` only (the script refuses any other serial and exits 75 without touching the device while
another session holds `/var/lib/orbit/android/ui.lock`). `ManagementDeviceTest` drives the real shell against a
MockWebServer inside the instrumentation: MEMBER then ADMIN, preference writes, profile, password page,
notifications, shared links turn-off, 403 recovery, sign-out confirmation, admin list/detail/role change and
demotion; workspace form, session share panel, runners list, runner offline → online with Needs Attention,
engine page, deep link `orbit://runner/<uuid>`, providers and the Codex pool page. Two tours cover the main pages
(session share, workspace form, settings home, edit profile, notifications, shared links, admin, runners list,
runner, engine page, providers, Codex pool) in the account's dark appearance and at twice the system font size,
each on a fresh activity. The TalkBack check runs last, in its own instrumentation process.

```bash
apk=src/android/app/build/outputs/apk/debug/app-debug.apk
tests=src/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
ANDROID_SERIAL=emulator-5554 bash src/android/scripts/management-device-test.sh "$apk" "$tests" src/android/build/device/<run-id>
```

The script records and restores the font scale and the accessibility settings, and stops the app before it
releases the lock. The fixture server runs inside the instrumentation process, so no `adb reverse` is set.

Run 10 on `7d141f47b` (API 36 `sdk_gphone64_x86_64`, 1080×2400; APK sha256 app `b41d3487…`, test `88dcb89b…`):
`OK (4 tests)` in 67.7 s (settings, profile and roles; workspace, runner, providers and session share; the dark tour;
the 200% tour) and the TalkBack check `OK (1 test)` in 204.6 s. Runs 5–9 (`4a32b7c2a` … `3baa9f4a2`) found the
harness problems and the defects fixed above. Run directories under `src/android/build/device/` are not committed;
captures and reports go with the evidence.

Runners list Edit on two API levels (`6e271c28b`: API 36 `emulator-5554` `OK (1 test)` in 9.9 s, API 29 `orbit-ui-api29` (Android 10, booted for the run and shut down after) `OK (1 test)` in 6.5 s; job `bgj_e3d658273b69`): `ManagementDeviceTest.runnersListRemovesARowThenReordersTheNextByDragging`
serves three runners, removes the first row with Edit left on, drags the row that moved into its place below the last,
and expects one reorder with that order and the rows standing in it.

### TalkBack, dark appearance, 200% font

TalkBack is the image's own (`/product/app/talkback/talkback.apk`), switched on for the check and back off after
it; its notification permission, which it asks for in a dialog over the app the first time it starts, is granted
for the run and put back. Its touches come from the emulated touchscreen, through the emulator console's
`event mouse` (reached from inside the emulator at 10.0.2.2 with the port and token the script passes; neither is
written to the evidence). Events injected by UiAutomation or by `input` skip the accessibility input filter, so
TalkBack never sees them (they press what is under them), and SELinux keeps the shell off the touchscreen's
device node. The instrumentation's UiAutomation is taken with `FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES`: the
default one switches TalkBack off while connected.

On settings home, the runners list, a runner, providers, the Codex pool, shared links, edit profile and the admin
list, the check walks TalkBack's swipe-right order from the page's first item, recording each stop and the words
read there, audits every reachable control for words (a bare symbol read out counts as a problem), puts TalkBack's
focus on the page's key control by touching it (photographed with TalkBack's focus box) and activates it with
TalkBack's double tap, checking the effect: Runners → the list; Controlled remote → the runner page; Increase Max
Concurrent → `PATCH runners/:id` sent; Providers → providers; Team Codex → the pool; Shared links → the list; Turn
off → its confirmation; Edit profile → the card; Choose photo → the photo menu; Admin → the users list.

Run 10: TalkBack bound with touch exploration on and the app in front. Every touch put TalkBack's focus on the
control named (TalkBack's focus box is in each capture) and every double tap had its effect. The swipe walks
stopped 18 times on settings home, 8 on the runners list, 19 on a runner page, 15 on providers, 20 on the Codex
pool (the walk stops at 20), 14 on shared links, 9 on edit profile and 7 on the admin list, each stop with its
words, and found no problem. TalkBack was switched off again after (no service enabled, touch exploration off).

Before `3baa9f4a2` the same check found 12 problems (kept in `src/android/build/device/a13-talkback-before-glyph-fix`):
TalkBack stopped on the runner head's "▣" and on each Needs Attention "!", read "›" at the end of runner and pool
rows, and read "Increase Max Concurrent, +" and "More for Team key, ⋯" because the label sat beside the glyph. The
marks are drawn only now, and each glyph button's glyph carries its label.

Observed, not this module's to change: TalkBack visits the page before the top bar (Back, Open navigation, Refresh
directory come last) and never stops on the page title. That order is the shell's Scaffold in `MainActivity.kt`
(A05's), reported to the coordinator.

Dark appearance: the twelve main pages in the account's dark appearance, with the status and navigation bar icons
following the account, not the system (P2-6). 200% font: the same pages at system font scale 2.0. Run 6 showed
Turn off one letter per line, Share Link… broken and the SHARED chip upright; fixed in `0a2653193` (red/green
above), and the run 9 captures show them whole.

### The real stack

An isolated Orbit on this HPC, built from one fixed commit (`ff66e748a`, see Identity): the apiserver on
127.0.0.1:3913 with its own PostgreSQL 16 container (tmpfs, 127.0.0.1:6313), and a real `orbit` runner built
from the same tree, run with its own `HOME`/`ORBIT_HOME`, every `ORBIT_*`/`CLAUDE*` variable unset,
`ORBIT_NO_SELFUPDATE=1` and `ORBIT_NO_ENGINE_UPDATE=1`. Nothing talks to production. The emulator reaches it by
`adb -s emulator-5554 reverse tcp:3913`. Accounts are real server accounts: `owner@a13.test` (bootstrap ADMIN),
`member@a13.test` (MEMBER), `admin2@a13.test` (ADMIN), and a shared key pool “Team keys” whose owner is the
first, with the second as member and the third as pool admin. The host scripts (`setup.sh build|db|clean`,
`run-api.sh`, `seed.mjs`, `run-runner.sh`, `live.sh`, `reset.sh`) are kept with the run evidence, outside the
repository: they hold paths of this machine.

`live.sh` holds the UI lock for the whole run and runs `ManagementLiveTest` one step at a time. Every write made
through the app is read back from the server with the acting account's own token, and each check is logged
(`checks.log`). The runner is registered by `orbit register`, whose printed device code the app approves; the
workspace and session are seeded once it is online. MockWebServer results above are supplementary to this.

The stack keeps an idle client connection 75 s, as the production gateway does (`gateway/nginx.conf` leaves
nginx's default `keepalive_timeout`); Node alone closes it after 5 s. With 5 s the app's pooled GETs failed after
any idle gap, because the shared transport does not retry them (`OkHttpTransport` `retryOnConnectionFailure(false)`,
core, already reported by D1): in live run 6 the runner page missed the runner's engine report for more than a
minute.

Live run 7 (`src/android/build/device/a13-live7-3baa9f4a2`; app `3baa9f4a2`, APK sha256 `1535f215…`, test APK
`cb1ce9b5…`; server and runner `ff66e748a`; API 36 emulator): all eight steps passed, 56 server checks, none failed.

| Step | Account(s) | Through the app, each read back from the server |
| --- | --- | --- |
| 1 | MEMBER | no Admin row, and `GET admin/users` refused (403); Default permission → Plan; Session orchestration off; Appearance Dark → System; “When a session finishes” off; name saved; new password signs in, old one refused |
| 2 | ADMIN, second ADMIN | New user: exists as MEMBER, the password shown once signs it in and is gone once dismissed; Member → Admin → Member; Delete user (asks) → gone, cannot sign in; an admin demoted elsewhere loses the Admin row and gets 403 |
| 3 | ADMIN | Add Runner → the code `orbit register` printed (`GE5KE-FUYZF`) approved from the phone → the runner is the owner's and checks in |
| 4 | ADMIN, the real runner | Name → `displayName`; Max Concurrent + → 17; Keep Free 10 GB → `10240`, then Off → null; the runner reports its engines; Claude's Default account (signed out — no credentials on this machine): a pause set through the API, then Change Duration… 4 h and Resume Now from the page, Rename… to “Stack default” and back; Add Account → the runner is asked to sign a new account in, Cancel → given up |
| 5 | ADMIN | workspace form Done → name and instructions saved; Cancel writes nothing; the form opens again on the server's record |
| 6 | ADMIN | session share: Anyone with the link → ACTIVE with tool output included; tool output off; Only you → Turn off → no link |
| 7 | pool owner, member, non-creator admin | owner turns both member rules off (new pools start with both on); member offered nothing, and the server refuses its key and ChatGPT sign-in (403); owner turns keys on; member offered a key only, adds one, leaves; non-creator admin sees Leave pool off with the reason, and the server refuses its leave (403); owner deletes the pool |
| 8 | ADMIN, the real runner | Rotate Token… shows the token once; the runner's next heartbeat and claim are refused (`401 invalid runner token` in its log); Remove Runner → gone |

Earlier live runs (1–6, `46b2ce700` … `0a2653193`) found what was fixed between them: the alias typed just
before leaving the Name page (fixed in `a39266cec`), whole-row notification switches, the A05 directory defect
(gap 8), the test's own clock (a Compose test's timers run on a virtual clock that a plain sleep never moves),
and the stack's keep-alive above.

## A01 rows for this module

From the A01 UI inventory (task `34ZaIJzDrHZwLqeK8dZC3`, comment `34ZdN1qmQAkbScDXLMSTW`; the protocol audit
`34ZdN6GJA97aROYxNDvWe` has no row of its own for these pages). “Live” is the real stack above; “fixture” is the
emulator over controlled HTTP; “JVM” is the unit/shell suites.

| A01 row | Android page | Cases | Result |
| --- | --- | --- | --- |
| UI-F02 workspace list → workspace settings | `WorkspaceSettings.kt`, from the workspace's top-bar gear: Name, Effort, Enabled, Instructions + caption, Working directory, Task runs smart selection, Environment read only + “Env editing is coming in a follow-up.”, Delete agent (asks); Cancel / Done writes only a change | Live step 5: Done saves name and instructions; Cancel writes nothing; the form opens again on the server's record. Fixture: Done is one `PATCH workspaces/:id`. JVM: a cancelled edit is gone when the form opens again | Live: pass (run 7, step 5). Fixture and JVM: pass |
| UI-F11 Settings home | `SettingsScreen.kt` `SettingsHome` | Live step 1 (MEMBER): no Admin row, and the server refuses `GET admin/users` (403); Default permission, Session orchestration, Appearance Dark → System, each read back. Fixture: groups, rows and values, sign-out confirmation, version line; dark and 200% tours; TalkBack | Live: pass (run 7, step 1). Fixture, dark, 200%, TalkBack: pass |
| UI-F12 Edit profile, crop; Change password | `PersonalSettings.kt` `EditProfile`, `PersonalPhotoDialog`, `ChangePassword` | Live step 1: the name is saved; the new password signs in and the old one is refused (then put back). JVM: OrbitKit's crop tests, save order and partial success. Fixture: both pages | Live: pass for name and password. Photo upload to the real server: gap 4 |
| UI-F13 Notifications | `NotificationsPreferences` and A10's device section | Live step 1: “When a session finishes” toggled and read back (an absent key reads as on). Fixture: the page; an unconfigured FCM build reads “Unavailable” | Live: pass (run 7, step 1). FCM delivery: A10 |
| UI-F14 Runners → runner, Name, engine; Add Runner | `RunnerScreens.kt` | Live step 3: Add Runner approves the code `orbit register` printed; the runner registers and checks in. Step 4: rename; Max Concurrent +1; Keep Free 10 GB → Off; the Claude Default account's pause changed to 4 h, then Resume Now; Rename… there and back; Add Account starts a sign-in on the runner and Cancel gives it up. Step 8: Rotate Token shows the token once and the runner is refused after it; Remove Runner. JVM: the 69 attention cases, drag reorder, Name and Max Concurrent saves. Fixture: offline → online, deep link, Refresh Model Lists | Live: pass (run 7, steps 3, 4, 8). Signed-in accounts, Repair, engine update: gaps 3 and 5 |
| UI-F15 Providers → pools | `ProviderManagement.kt`, `PoolLogic.kt` | Live step 7, the pool's real owner, admin and member: owner turns both member rules off; the member is offered nothing and the server refuses its key and its ChatGPT sign-in (403); owner turns keys on; the member is offered a key only, adds one, leaves; the non-creator admin sees Leave pool off with the reason and the server refuses its leave (403); owner deletes the pool. JVM: role × rule matrix, failed reads. Fixture: overview, Codex pool page | Live: pass (run 7, step 7). ChatGPT sign-in, Claude pools: gaps 3 and 6 |
| UI-F16 Share; Shared links | `SharingSettings.kt` `ShareResourcePanel` (session menu “Share…”), Shared links page | Live step 6: Anyone with the link → ACTIVE with tool output included; tool output off; Only you → Turn off → no link. JVM: a failed or stale read stops writes. Fixture: shared links Turn off | Live: pass (run 7, step 6). Task/project entries: A11's ⋯ → Share… host this panel since v4; fixture device case `aTaskAndAProjectShareThroughTheOneSharePanel` (gap 7) |
| UI-F17 Admin | `AdminSettings.kt` | Live step 2: New user → the generated password is shown once and signs in, and is gone once dismissed; Member → Admin → Member; Delete user (asks) → gone, cannot sign in; an admin demoted elsewhere loses the Admin row and gets 403. Fixture: list, detail, demotion | Live: pass (run 7, step 2) |
| UI-C13 profile part | Photo menu (Photo library, Take photo, Choose file, Remove photo) and the crop | JVM: crop tests. `ManagementHttpTest`: upload and removal requests (multipart `file`) against MockWebServer. TalkBack: Choose photo opens the menu | Partial: picking a photo through the system picker or camera and uploading it to the real server was not run (gap 4) |

## v4: on the project line (A11, D1)

v3 (`e6d786f93`, accepted) conflicted when it landed on `project/34ZZn8fmemArxvl2CsCFp`. v4 merges it onto that
line's tip and changes only what the combination needs; everything else stands as in v3.

| Item | Value |
| --- | --- |
| Merge `e91ba3bdc` | parents: the tip `1205d8b3d` (A11 `442721b56`, main with D1's Google sign-in `c4c1d2891`) and v3 `e6d786f93` (which carries A10 `482b132e8`); merge base `51bbcc303`. Only the three files below differ from git's own merge |
| After it | `025ce6b2c` one share panel; `73de62710` runner self-update (main's rule); `b871adf8e` D1's JVM test; `cb1aab5a8`, `02f2bbe2d` device tests; then this document |

Conflicts, resolved by hand:
- `AndroidManifest.xml`: A10's `POST_NOTIFICATIONS` and D1's Custom Tabs `<queries>`, both kept. A10's Firebase
  service and the tip's narrowed `orbit://` hosts (with `orbit://auth/google` only for D1's redirect activity)
  merged on their own.
- `MainActivity.kt`: `AccountAppearance` (A13, wraps `OrbitTheme`) → `PushNoticeHost` (A10) → `OrbitShell` with
  D1's `continueWithGoogle`; D1's activity-level `auth` (its Google callback needs it in `acceptIntent`). A11's
  Tasks/Projects branches and A13's Settings/Runner branches; A13's `SettingsScreen` replaces the tip's interim
  Settings column, as on A13's side.
- `AuthViewModel.kt`: D1's shared `signIn` runs A10's `beforeSignOut()` and the attempt check before its block,
  so the password and the Google ticket logins both get them; logout is A10's.

One share panel: A11's task and project ⋯ → Share… opened A11's own `ShareSheet`, a second implementation of
this panel. `ShareSheet` keeps its signature, title and Done and now hosts `LiveSharePanel` (this panel on the live
connection); the panel reports every answer of the server as `{link, counts}`, which A11's menu reads for “Only
you” / “Live link”. A11's duplicate body, layers, expiry, URL, `shareFailure` and the words only it used are gone.
A11's fixture link names its kind, as the server's link view does. What changes for tasks and projects: writes wait
for a fresh directory read (P2-3 above), not only a connected control stream; the expiry is a menu.

Main moved the runner baseline after the audit:
- Self-update (`f22557aff`, iOS and web): ported. The case file grew from 69 to 81 cases; Needs Attention takes the
  runner's report at its word (install folder isn't writable → Copy Command; updates turned off, with how to turn
  them on only for `ORBIT_NO_SELFUPDATE`; runner update failed → Update Runner Now, online only); About gains Last
  Update and Update Runner Now (`POST runners/:id/self-update`); a runner too old to report keeps “Can’t update itself”.
- Antigravity sign-in and several Antigravity accounts per runner (`597b5c1cf`, `712d324a8`): not ported (gap 12).

Tests the merged product changed: D1's `GoogleSignInFlowTest` and A03's `AuthFlowDeviceTest` waited for the interim
Settings column's “Signed in” (now: the account's email on Settings, and Sign out's confirmation);
`ManagementDeviceTest`'s server refused D1's public `auth/methods` (now 404, as D1 made A05's device tests answer).

| Check | Run | Result |
| --- | --- | --- |
| `scripts/verify.sh` on `025ce6b2c` | `bgj_0736270dcdfe` | red: the two failures above that the merge exposed (`RunnerPageTest` case file, `GoogleSignInFlowTest`) |
| `scripts/verify.sh` on `b871adf8e` | `bgj_0321268d0a66` | 635 local tests (core 103, app debug 266, release 266), 0 failures, 0 skips; lint 0 errors |
| API 36 on `b871adf8e` | `bgj_976a08c16053` | red: `ManagementDeviceTest` crashed on `auth/methods`; `AuthFlowDeviceTest` “Signed in”; share 2/2 |
| API 36 on `02f2bbe2d`, one hold of the UI lock | `bgj_b075922f3123` | A13 settings and workspace/runner/providers/session-share journeys 2/2 (with the self-update card and Update Runner Now); task and project share entry and A11's N3 share case 2/2; A03 auth: secure store 3, persistence 4 phases, login UI with D1's methods 404 1; A11 real stack `s01`/`s06`/`s11` 3/3 (stack at its fixed server `d621e29aa`). Font, night mode and accessibility restored, no `adb reverse` left |

## A13c: Antigravity's Google sign-in and accounts, one window per row (A01b A13-3/4/5/6/9)

Follows main's iOS commits 10e687dc5/597b5c1cf and cd8e8a41a (A13-3), 712d324a8 (A13-4), df3e91c19 and 6c6528dbb
(A13-5), 8627d8d50 (A13-6) and 93fd35e09 (A13-9). Every server field read here is on main
(`common/antigravity-readiness.ts`, `common/runner-engines.ts`, `providers/account-move-capability.ts`).

| Item | iOS | Android |
| --- | --- | --- |
| A13-6 flat plan usage | `PlanUsage.flatSnapshot` keeps `accounts` | `planUsageSnapshot` no longer drops `accounts` from a flat payload, so added accounts read their own quota |
| A13-3 Google sign-in | `RunnerPageFormat.engineStatus/signInHint/canSignIn`, `EngineAuth`, `GoogleSignInTermsView`, `PlanUsageSnapshot.rows` (buckets, `remaining`), `RunnerAttention` | `RunnerPage`: engine "Antigravity" (its update item keeps "Antigravity CLI", as web's `ENGINE_CLI_NAME`), a row even when the runner reports none, "Update runner" / "Not supported yet" with the hint, "env key"; buckets as "Weekly"/"5-hour" grouped by id, "N% remaining"; Needs Attention for Antigravity signed out and near its limit (by the share used); Providers counts it only where `googleLogin` is available. Google's terms with a "Google terms" link in the Accounts footer and on an idle Antigravity card ("Sign in with Google") |
| A13-4 accounts | `keepsAccounts` + `canAddAccount` (`antigravity-account-login/v1`), `runsOnEnvKey`, `CodexAccounts.usage/moveCapability`, composer `accountChoices` | `EngineAccounts` (engine-health quota, move capability), Add Account gated as on iOS, Default on the runner's Gemini key reads "env key · runs on your Gemini key"; the composer's account rows include Antigravity with each account's quota ("gemini-5h 4% left"), move only where the runner declares the capability, and a new session carries `antigravityAccount` |
| A13-5 one window | `PlanUsageSnapshot.bindingRow`, `engineWindows/engineNextAccount`, `CodexAccounts.toStartOn` (paused accounts wait) | `bindingRow`/`currentUsageRows`, `EngineAccounts.toStartOn`; an Engines row draws one window, and with several accounts "Next: <account>" above that account's window; the engine page keeps every window |
| A13-9 account rows | `RunnerEnginePage` phone rows, `loginExpiresLine`, `signedOutNote`, `RunnerSignInView` | Rows say only where they stand (Paused · Until, "Login expires in N days" + Renew, what signed out costs); Rename…, Sign In Again, Pause…/Resume Now + Change Duration…, Remove… are the ⋯ menu's; the sign-in card starts on the press that raised it, offers Cancel while it runs and Close otherwise, shows a device code first under "Copy Code & Open Sign-In Page", pastes a code with one Paste, and folds once the runner reports the account signed in |

Differences from iOS, intended:
- iOS's left swipe and long-press menu are the row's ⋯ menu here, as A13 already decided for removal.
- Paste reads the clipboard with the platform API, so Android 12+ shows its own "pasted from your clipboard" notice
  (coordinator's decision: accepted, not worked around). iOS's `PasteButton` asks nothing.
- Kimi's card still starts from its own button: choosing kimi.com or kimi.ai first (A13-8) is A13d's.
- Composer: A07c owns the provider chooser and the repair card (A07-4, A13-3's composer part); A13c added only the
  account data model it reuses — `ComposerCatalog.accounts/accountChoices/movesAccounts/usage`, `AccountChoice`,
  `EngineAccounts`, `RunnerPage.keepsAccounts/runsOnEnvKey/antigravityCanSignIn/signInHint`, `usageRows`/`bindingRow`.

Tests: `AntigravityAccountsTest` (iOS AntigravityGoogleClientTests and AntigravityAccountsTests, on the shared
`docs/evidence/antigravity-google-login/clients/fixtures.json`), `RunnerAccountsTest`, `RunnerPageTest`
(flat HPC payload, one window), `RunnerEnginePageTest` (Robolectric: rows, engine page, menu, sign-in card),
`ComposerAccountsTest`, `ComposerModelTest`, `AccountCopyParityTest` (the words are the Swift sources'). Device:
`ManagementDeviceTest.antigravityAccountsOneWindowAndTheSignInCard`, run by `scripts/management-device-test.sh`.

## A13d: access tokens, smart model selection, DeepSeek balance, the runners list and confirmations (A01b A13-7/8/11/13/14/15/16)

Follows main's iOS commits 90b80b42f and 86203ffb0 (A13-7), c354087cf and 9531bc1c2 (A13-8), 91316c246 (A13-11),
d3441c702/7d06bbee0 (A13-13), 9fb3ae6ee and 614a21410 (A13-14), ba95dd340/d71fe48a3, 81b2d70a4 and 6969f7840 (A13-15),
936ebbd3c and 96e1a1536 (A13-16). Every endpoint read here is on main (`auth/access-tokens.controller.ts`,
`users.controller.ts` `PATCH users/me/preferences`, `providers.controller.ts` `GET providers/mine[/:id/balance]`).

| Item | iOS | Android |
| --- | --- | --- |
| A13-7 access tokens | `AccessTokensList`, `AccessTokenRow`, `AccessTokensSettingsPage` (swipe/context menu Revoke, `orbitConfirmation`) | Settings → Account's Access tokens row ("N active"/"None") opens `AccessTokensSettings`: Active N / Revoked & expired N, the page's sentence with "New tokens are created in Settings → Access tokens on the web.", each row's name and `orbit_pat_…<hint>`, reach, expiry or the orange Never expires mark, last use; Revoke is in a working token's ⋯ menu and asks “Revoke “<name>”?” with Cancel beside it, then the list is read again. Nothing issues a token |
| A13-8 Kimi's site | `KimiSite`, `RunnerSignInView` site buttons | Already on the project line from main's Kimi project (8f2cce602, `KimiSite.kt`): the site question, kimi.com · Mainland China / kimi.ai · International with Current, `region` only where the runner can be told, the device step naming the site, "Use <other> instead", the Engines row's site. Verified against the A01b items, not redone |
| A13-11 runners list | no Edit button; `onMove`, swipe-to-delete with confirmation | No Edit/Done: a drag handle on every row (the Wiki plan's Edit sheet pattern, card 34bs0PdYUHHwiKHYn3rCp), one POST runners/reorder per drag; Remove… in the row's ⋯ menu, asked first; the row opens the runner; TalkBack's Move up / Move down always offered |
| A13-13 Providers footers | `ProvidersOverview.onYourRunnersDetail/accountPoolsDetail` | "Use subscriptions signed in on your machines." / "Several accounts under one name." |
| A13-14 smart model selection | `SettingsCopy.smartModelSelection(Hint)`, `UserPreferences.smartModelSelection`, the gates in `TaskDetailLogic`, `ComposerLogic.smartRoute`, `AgentFormContent` | Settings → Sessions' switch, glyph beside its name and the hint under it, on only for an explicit `modelRouting: true`, written alone; `LocalSmartSelection` (read with users/me by `AccountAppearance`, set at once by the switch) gates the task page (Suggested, the ✦ placeholder, the coordinator's reason, runs' ✦ tiers, would-have-picked, ⓘ) and the workspace form's Task runs |
| A13-15 confirmations | `orbitConfirmation`: an alert on a phone, Cancel beside the press | "Sign out?"; the directory's Delete permanently, folder Delete (iOS's words) and a move to another workspace in one step (End and Move or Move, iOS's message) as dialogs with Cancel; Stop watching? keeps the watch with "Keep watching"; Revoke follows the rule |
| A13-16 DeepSeek balance | `DeepSeekBalance`, `DeepSeekKeyPageView`, `AgentsModel.loadDeepSeekBalances` (side by side) | A DeepSeek key's row (matched by slug in `GET providers/mine`) ends with its total ("¥110.00 · $5.00", red when too low, orange Unavailable) and opens `DeepSeekKeyPage`: the balance first (Checking…, too low, Total per currency with the granted/topped-up bar, Updated, Refresh `?refresh=1`, Top up on DeepSeek; or Couldn't get the balance, Unknown, Last tried, Retry), the footnotes, then Runs on / Default model / Endpoint. The balances are read side by side |

Differences from iOS, intended:
- A13-11: a drag handle instead of iOS's long-press reorder, with Move up / Move down as TalkBack actions — the
  coordinator's decision, consistent with the account owner's for the Wiki plan's Edit sheet (card
  34bs0PdYUHHwiKHYn3rCp). iOS's swipe-to-delete is the row's ⋯ menu, as elsewhere in A13.
- A13-16: iOS's "Opens platform.deepseek.com/top_up in Safari." reads "… in your browser." — the coordinator's
  decision; Android opens the page in whatever browser the device uses.
- A13-15: Android's confirmations were already centred dialogs, so iOS's anchoring fixes have nothing to port.
- A13-7: Revoke is in the row's ⋯ menu (iOS's swipe and context menu).
- A13-14: the composer's ✦ chip (A11-1) is A11c's and is not on the project line at this task's start; it reads
  `LocalSmartSelection` once both are on one line.

Tests: `AccessTokensTest`, `AccessTokensLogicTest` (iOS AccessTokensListTests), `DeepSeekBalanceTest`,
`DeepSeekBalanceLogicTest` (iOS DeepSeekBalanceTests), `SmartSelectionGateTest`, `TaskLogicTest`
(runs' routes under the switch), `SettingsLogicTest`, `SettingsCopyParityTest` (every word in the Swift sources, the
browser sentence excepted), `ManagementPanelTest` (footers, runners list, sign out), `DirectoryConfirmationTest`,
`WatchScreensTest`. Device: `ManagementDeviceTest` (A13d journey and the runners list), run by
`scripts/management-device-test.sh`.

## Remaining evidence (gaps)

1. No installed-iOS same-data comparison: the correspondence is read from the iOS sources.
2. The account owner's physical phone: not touched; listed until the coordinator schedules it. Physical
   Android 10–16 phones (S1) likewise.
3. Real ChatGPT and Claude sign-ins need real credentials, so these were run only over controlled HTTP: a
   signed-in runner account (Pause… from the page, Sign In Again, quota windows, Remove of an added account), a
   ChatGPT account in a pool (Sign in again, Sign out), and the end of an engine sign-in.
4. The profile photo: picking through the system photo picker or camera and uploading to the real server.
5. On the real runner: Repair of a stuck checkout, Update Engines Now (the stack runs with
   `ORBIT_NO_ENGINE_UPDATE=1` by rule) and the outcome of Refresh Model Lists.
6. Claude account pools (there is none on the stack); FCM delivery (A10).
7. Task and project share entries (v4): run over A11's controlled fixture only, not against a real stack.
8. A05 directory defect found on the stack: a workspace whose `position` is null (every new workspace until
   `POST workspaces/reorder`) makes `DirectoryWorkspace` fail to decode, and the whole directory reads as
   unreadable. Reported to the coordinator (task comment `34bdZd75uvZBhUR8rH6t5`); the stack's seed reorders
   once as a stand-in, and the live checks say “unreadable directory” when they meet it.
9. Core transport, seen on the stack: a pooled GET fails once when the server has dropped the idle connection
   (`OkHttpTransport` `retryOnConnectionFailure(false)`), so against an origin with Node's 5 s keep-alive a page's
   poll fails until its stale connections are used up. Production's gateway keeps 75 s; already reported by D1.
10. TalkBack visits the page before the shell's top bar and never stops on the page title (`MainActivity.kt`
    Scaffold, A05's): reported, not changed here.
11. Runner self-update (v4): over controlled HTTP only (case file, JVM, emulator). No real runner reporting
    `selfUpdate` was driven, so a real Update Runner Now was not run.
12. Main's Antigravity sign-in and several Antigravity accounts per runner (`597b5c1cf`, `712d324a8`) came after the
    audit and are not ported; raised with the coordinator.
13. A10's foreground and tray device cases are not in this combination: `482b132e8` committed none; A10's harness is on
    its own branch, which merges this tip next. Here: A10's JVM suites in the gate, and on the emulator Settings →
    Notifications saying push is unavailable in this build (never “on”).
