# A13 · Workspace, Runner and Settings management

Kotlin + Compose on Android 10–16 (minSdk 29). Android is a remote client: every page here reads and
writes the existing Orbit API with the signed-in account's own handle (A03 `AuthSession`); the phone
never hosts a Runner. Directory display and routing stay A05's; in-session model/account choice stays
A07's (`ComposerModel` / `ComposerData` are untouched); notification permission and delivery stay A10's.

## Identity

| Item | Value |
| --- | --- |
| Task initial HEAD | `3cb12b3be2a38c55601786bdfa1967f60a86990a` |
| Fixed inputs (ordinary merges, unchanged) | A07 `51bbcc303cec3c64dfb217316afce9498add760d`; A10 `482b132e8c57053113f2e3fa467d02de2b809d95` (combined `afb311c3becdf940ea728fcc859d9a96cb342cbf`) |
| Run-1 snapshot restored verbatim | `1042bfbd2355ff69aaee20149bd1d73e7009f390` (Codex run, then rewritten here against the iOS sources) |
| Baseline read | iOS-compiled SwiftUI in `src/macos/OrbitApp/Sources/OrbitApp/Views` (`SettingsSheet`, `SkillsRunnersView`, `Runner*`, `AddRunnerSheet`, `AccountPauseControls`, `ProviderPoolViews`, `SettingsAdminView`, `ShareSheet`, `AgentsView` form) and OrbitKit `App/` (`SettingsHome`, `RunnerAttention`, `RunnerPageFormat`, `RunnerPageCopy`, `ProviderPoolLogic`, `SharedPoolPage`, `CodexPoolPage`, `CodexLoginPool`, `SharedPoolAdapter`, `WhoCanUseIt`, `AddPoolKey`, `CodexSignIn`, `SharePanel`, `SharedLinksList`, `AgentDefaults`, `AccountPause`) at the task's source tree; server contracts in `src/apiserver/src/{users,auth,runners,workspaces,providers,share-links,sessions}` |

This is a source correspondence. It is not an installed-iOS same-data comparison and not a frozen A01 matrix.

## Correspondence

| iOS baseline | Android | Endpoints |
| --- | --- | --- |
| Settings sheet (`SettingsHome`): avatar + name header → Edit profile; Sessions (Default permission menu, Session orchestration switch); Machines & models (Runners “N of M online”, Providers); Preferences (Notifications On/Off, Appearance menu); Account (Email, Instance host[:port], Shared links “N active”, Change password, Admin only for ADMIN); Sign out asking “Sign out of <instance>?”; version line | `SettingsScreen.kt` `SettingsHome`: same groups, rows and their glyphs (`SettingsHome.systemImage` drawn as app vectors), pencil badge on the avatar, row values, in-row menus/switch, confirmation; version line plus the existing A02 Build information link. “Notifications are off · Turn on” card when the device has push but alerts are off | `GET users/me`, `PATCH users/me/preferences` (one key per write), `GET runners`, `GET share-links` |
| Edit profile card: photo menu (Photo library, Take photo, Choose file, Remove photo), round crop, Name + caption, Save profile (photo first, then name; a landed step stays), failure “Couldn’t save your photo/name — …” | `PersonalSettings.kt` `EditProfile`: same menu behind the camera-badged avatar (system photo picker / camera / documents), crop with zoom + position sliders, 512 px JPEG on white, same steps and wording | `PUT/DELETE/GET users/me/avatar` (multipart `file`), `PATCH users/me` |
| Change password page: three fields, footer outcome / “Passwords do not match” / “At least 6 characters” | `ChangePassword` | `POST auth/change-password` (wrong password is a 400, never a sign-out) |
| Notifications page: device section; “Sent to all your devices” two switches with hints; “Always sent” list | Device section is A10’s `NotificationSettings(app.push)`; account switches and Always-sent rows here. An unconfigured FCM build reads “Unavailable”, never On | `PATCH users/me/preferences` |
| Runners list: status dot, name, slots + bar, subtitle (host · v / Offline · last seen), attention line; Edit → reorder / delete (“Remove “x”?”); Add Runner + footer; load/fail/Retry | `RunnerScreens.kt` `RunnersList`: same rows; Edit shows ▲/▼ and Remove instead of drag/swipe | `GET runners`, `GET workspaces`, `POST runners/reorder`, `DELETE runners/:id`, `GET <origin>/dl/version.json` (unauthenticated) |
| Runner page: head (status line, host line); Needs Attention (`RunnerAttention` — offline, signed out, stuck checkout → Repair, quota, disk → Set a Reserve…, can’t update itself → Copy Command, engine not updating → Update Engines Now); Capacity (Max Concurrent stepper, Disk gauge, Keep Free Off/10/20/50 GB); Engines (rows → engine page, Update Engines Now + relay, Refresh Model Lists, footers); Workspaces (opens the workspace’s sessions, running counts, footer); About (Name page, Hostname, Version · Latest, Runs As, Repos Folder, Last Check-in, Registered, root footer); Rotate Token… (shown once + Copy); Remove Runner | `RunnerDetail` with `RunnerPage.kt` (a port of the three OrbitKit files); the Needs Attention rule is checked against the web/iOS case file `src/web/src/lib/runnerAttention.cases.json` (69 cases) | `PATCH runners/:id` (`maxConcurrent`, `minFreeDiskMb` incl. explicit null, `displayName`), `POST runners/:id/{engine-update,refresh-models,rotate-token}`, `POST workspaces/:id/repo-cleanup`, `GET sessions/counts`, `DELETE runners/:id` |
| Engine page: version · update note; Accounts / Sign-In; per account: home, Signed in/out, quota windows or “No quota reported”, refused removal, Sign In / Sign In Again or pause controls; Rename… (alert), Remove (asks; Default never); Add Account (picked name, starts at once, renames once reported); Update Engines Now | `RunnerEnginePage`; Rename… and Remove are an overflow menu per account instead of long-press / swipe | `PATCH/DELETE runners/:id/accounts/:engine/:account`, `POST …/:account/pause`, `POST runners/:id/login {engine, account?, accountName?}` (Add Account signs a new one in) |
| Sign-in card (`RunnerSignInView`): pending, device code (copy), paste-back code + Submit, verifying, done, failed/try again, Cancel; 2 s polling while in flight | `RunnerSignInCard` / `SignInRelay` (same states, same ownership rule for the shared relay) | `GET/POST/DELETE runners/:id/login`, `POST runners/:id/login/code` |
| Account pause (`AccountPauseControls`): Paused · Until; Pause… sheet 1/2/4/8 h or custom 1 min–168 h, “Automatically resumes at …”; Resume Now; Change Duration… | `ManagementUi.kt` `AccountPauseControls` (shared by runner accounts and pool members) | `POST …/pause {durationMinutes: n|null}` |
| Name page: placeholder machine name, footer, saved on Done or leaving | `RunnerNamePage` (a save made while leaving runs on the process scope) | `PATCH runners/:id {displayName}` |
| Add Runner sheet: lead, macOS/Linux/Windows, command + Copy/Share, “Waiting for a new runner…” → “Runner online — … · Open”; no-browser code (auto lookup at 10 characters), name conflict → Re-register machine, success line | `AddRunnerDialog` (full-screen dialog) | `GET runners/device/:code`, `POST runners/device/:code/approve` |
| Workspace form (`AgentFormContent`, from the workspace list): Name, Effort (runtime vocabulary), Enabled, Instructions + caption, Working directory, Task runs smart selection, Environment (read only) + note, Delete agent (asks); Cancel / Done (Done saves only a change; blank instructions/path keep the value) | `WorkspaceSettings.kt`, from the workspace’s top-bar gear | `GET/PATCH/DELETE workspaces/:id` (same body as `UpdateAgentRequest`) |
| Providers: On your runners (summary), Account pools (shared first, then own; SHARED chip, line, gauge), Your API keys (label + default model; add/change on the web) | `ProviderManagement.kt` `ProvidersOverview` + `PoolLogic.kt` | `GET runners`, `GET providers`, `GET providers/pools`, `GET providers/shared-pools`, `GET providers/shared-pools/:id` |
| Claude account pool page: availability, headline + gauge, members (NEXT, status words, tightest window), pause, footer | `AccountPoolPage` | `GET providers/pools`, member pause |
| Codex pool page: head (who · people · availability, Add account / Add a key), Accounts (login rows with Sign in again / Sign out; key rows with status, money/cap, Replace / Disable / Remove), Who can use it (owner only: Just me ↔ Me and people I add, people with % share, Remove from pool, Make admin/member, Add people), rules (owner only, once shared), warning card, Delete pool / Leave pool | `CodexPoolPage` (`CodexPoolView`, `WhoCanUseIt`) | `providers/pools/:id/codex-login[ /account?fingerprint=]`, `providers/shared-pools/:id{,/keys,/keys/:id,/keys/:id/secret,/people,/people/:userId,/leave}`, `DELETE providers/pools/:id` (own) |
| Sheets: Add an account (ChatGPT / API key), Sign in with ChatGPT (consent → code → done / expired / failed / duplicate; closing gives the attempt up), Add a key (consent → form → done / duplicate) and Replace key, Share (emails, facts, own-key rule, no-key warning) | Full-screen dialogs with the same steps and words | as above |
| Share panel (`SharePanel`): Only you / Anyone with the link (turning off asks), link + Copy Link / Share Link…, Includes per kind (nested, idle, counts, risk), Updates, Expires (Never/1/7/30 days, Until/Stops working), views line | `SharingSettings.kt` `ShareResourcePanel`; page `ShareResourceSettings(api, revision, kind, id)` | `GET/PUT/DELETE {sessions,tasks,projects}/:id/share` |
| Shared links page: Active N / Paused N / Ended N, subtitle, rows (title, where line, views line), Copy Link / Share Link… / Turn off (asks), “Link turned off” / “N links turned off” | `SharingSettings` | `GET share-links`, `POST share-links/turn-off` |
| Admin (ADMIN only): list (name/email · ROLE, New user), user detail (Email, Name, Created, Role Member/Admin, Delete user), New user (Email, Name (optional), caption, Create) | `AdminSettings.kt` (list + detail route + dialog); the generated password is shown once | `GET users/me` then `GET admin/users`, `POST admin/users`, `PATCH admin/users/:id/role`, `DELETE admin/users/:id` |
| Skills | No page: `SkillsView` has no reachable entry on iPhone (not in the drawer, Settings, deep links or any section switch); skills are reachable in the composer, which is A07’s | — |

## Differences from iOS, and why

* Gestures: swipe actions, long-press menus and Edit-mode drag become visible buttons or an overflow (⋯) menu; the round crop is driven by zoom/position sliders. Sheets are full-screen dialogs.
* Kept on purpose: Delete user asks first (the web asks; iOS deletes at once). Android shows the generated password, which iOS never does (it decodes `password`, the server sends `generatedPassword`).
* Session share entry points: the A05 directory’s session menu “Share…” now hosts this panel (A05’s own dialog turned links off without asking and opened new links with tool output off); the reader gets a Share action in the top bar. Task and project share entries belong to A11’s pages, which can call `ShareResourceSettings`.
* Workspace effort for a configured (non-built-in) provider offers Claude’s list; iOS narrows it to the model’s declared levels. Dispatch still coerces to the declared levels on the server.
* Removed from run 1 because iOS has no such control: Settings → Skills and → Manage workspaces; workspace account pinning, routing-engine list, standing-grant revocation and repo-status block; pool “own key first” switch; people/rules/role powers for non-owner pool admins; runner Install engine / Cancel install / Antigravity sign-in and extra confirmations.

## Roles and states (server-decided)

| Actor / state | Behaviour |
| --- | --- |
| MEMBER vs ADMIN (account) | Same owner-scoped routes for runners, workspaces, pools and shares. Admin row and pages only when `users/me` says ADMIN; `AdminRoleGuard` re-checks every admin request; a demotion empties the page on the next read. |
| Pool owner / admin / member / contributor | Owner: people, rules, Just me, delete. Admin: add keys/accounts, remove any key, sign out any account; leaving is refused by the server until demoted. Member: add per the rules, manage own keys, sign in again only own accounts, leave. |
| Runner offline (heartbeat > 90 s or `online:false`) | Needs Attention shows only Offline / Can’t update itself; Update/Refresh hidden; sign-in, add/remove account disabled; capacity, Keep Free, name, rename, pause stay available (server settings). |
| Account signed out / expired | “Signed out” (amber), Sign In; Needs Attention “<engine> is signed out” when a workspace runs on it. |
| Stale or failed reads | Runner pages poll (15 s page, 10 s engine page, 2 s sign-in); a failed read keeps the rows under a notice with Retry; writes always go to the server, which is authoritative. 401/403/404 clear what was shown (`PersonalRecord`). |

## Verification

* Unit (JVM/Robolectric, part of the project gate): `RunnerPageTest` (the 69-case file and page formats), `PoolLogicTest` (owner/admin/member gates, statuses, headlines, sign-in steps, duplicates, share/Just me words), `SettingsLogicTest`, `PersonalSettingsTest`, `PersonalAvatarTest`, `ManagementApiTest`, `ManagementHttpTest` (real OkHttp + AuthSession against MockWebServer: endpoints and bodies, unauthenticated release manifest).
* Emulator (`scripts/management-device-test.sh`, API 36 `emulator-5554` only, under `/var/lib/orbit/android/ui.lock`): `ManagementDeviceTest` drives the real shell over controlled HTTP — MEMBER then ADMIN, preference writes, profile, password page, notifications entry, shared links turn-off, 403 recovery, sign-out confirmation, admin list/detail/role change and demotion, 200% font, dark appearance; workspace form, session share panel, runners list, runner offline → online with Needs Attention, engine page, deep link `orbit://runner/<uuid>`, providers and Codex pool page. Screenshots and request logs are kept with the run.

  ```bash
  apk=src/android/app/build/outputs/apk/debug/app-debug.apk
  tests=src/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
  ANDROID_SERIAL=emulator-5554 bash src/android/scripts/management-device-test.sh "$apk" "$tests" src/android/build/device/<run-id>
  ```

  The script refuses any serial that is not `emulator-*` and exits 75 without touching the device while
  another session holds the lock. It restores the font scale and stops the app before it releases the lock.
  It records night mode before and after; the test switches only the app's own Appearance. The fixture
  server runs inside the instrumentation process, so no `adb reverse` is set.
* Emulator run 4 on `d85cb38b7` (API 36 `sdk_gphone64_x86_64`, 1080×2400) passed: `OK (2 tests)` in
  43.9 s. APK sha256: app `95733dd5…`, test `648a7994…`. Runs 1–3 on `57565a663`, `a8e15d29b` and
  `eacea99e4` also passed; their screenshots led to the fixes made between runs: a capture taken before
  the frame reached the screen, the shell title not using the runner's alias, a pool row wrapping
  mid-word, a page clock read before its data arrived, and captures taken while a page was still
  loading. The run directories under `src/android/build/device/` are not committed.

These are fixture results on an emulator. They do not establish deployed MEMBER/ADMIN accounts, a real
remote Runner’s sign-in/expiry/removal/rotation/repair outcomes, real pools/OAuth, FCM delivery,
physical Android 10–16 phones, TalkBack passes, or an installed-iOS same-data comparison.

## Remaining evidence (next steps)

1. Isolated test instance with two accounts (MEMBER, ADMIN) and a disposable remote Runner; install the
   identified iOS build and this APK; run the same pages on both and record requests/results.
2. On that Runner: sign in/out an engine account, add and remove an account, pause/resume, rotate the token
   and re-register, repair a stuck checkout, approve a device code — then restore it.
3. A Codex pool with a second account as member/contributor: keys, people, rules, leave/delete, sign-in.
4. Physical S1 phones (R-min/R-ref/R-oem), TalkBack and 200% font passes; A10 for FCM.
5. A11: call `ShareResourceSettings(api, revision, "TASK"|"PROJECT", id)` from the task and project pages.
