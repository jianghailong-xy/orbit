# Android: a machine's first workspace in conversation, emulator screens against board 03

Task `34pLtXumbawMl6II4gUPa` of project `34pLjYBjU6ILsehatEjJs`. The design boards are
`docs/mocks/first-workspace-in-conversation` (`03-iphone` for the mobile layout, `04-rules` for the 12 rules);
the server contract is `docs/first-workspace-contract.md`; the copy parity sources are `src/macos/OrbitKit`
and `src/web` (`MachineSetupCopyParityTest` and `RunnerPageTest` read the Swift and TypeScript sources directly).

- `compare/`: board 03's frames beside the real Android app captured on `emulator-5554` (API 36, 1080×2400).
- `01-setup-card.png`, `01b-setup-card-no-key.png`, `02-drawer-set-up.png`, `03-setup-held.png`,
  `04-created-workspace.png`, `05-machine-page.png`: raw 1080×2400 screenshots from `emulator-5554`.
- `kit/` and `device-run/`: the reproducible emulator harness (`kit.gradle`, `FirstWorkspaceDeviceShotsTest.kt`,
  `run.sh`) and its device/instrumentation logs from the shared host emulator (`orbit-android-emulator.service`,
  holding `/var/lib/orbit/android/ui.lock`).

## What the pictures are

Every frame is captured from the real `:app` debug build on `emulator-5554` against a controlled `MockWebServer`
slice of `docs/first-workspace-contract.md` (§2 and §3). The account has one online machine (`orbit@austin`)
with `registerDir = "/home/orbit/code/app"`, `reposRoot = "/home/orbit/orbit-repos"`, `capabilities = ["dir-probe/v1", "create-workdir/v1"]`,
both `claude` and `codex` installed and signed out, and 0 workspaces at the start of the flow.

| File | Side-by-side comparison | Scene |
| --- | --- | --- |
| `01-setup-card.png` | `compare/01-setup-card.png` (`compare/android-card.png`) | Cold-start landing on `orbit@austin`'s new session page with an enabled Claude API key (`deepseek`) on the account (board 03 ②). |
| `01b-setup-card-no-key.png` | `compare/01b-setup-card-no-key.png` | The same setup card when `GET /api/providers` returns `[]` (0 API keys on the account): `Use an API Key` is omitted. |
| `02-drawer-set-up.png` | `compare/02-drawer-set-up.png` (`compare/android-drawer.png`) | The navigation drawer's `Set up orbit@austin` row under `Workspaces`, with `New session` enabled (board 03 ①). |
| `03-setup-held.png` | `compare/03-setup-held.png` (`compare/android-held.png`) | Step 1 folded (`Folder /home/orbit/code/app · Change`) and the first message waiting under the card with `Waiting for orbit@austin — sends once both steps are done` and `Withdraw` (board 01 ② / rule 6). |
| `04-created-workspace.png` | `compare/04-created-workspace.png` (`compare/android-created.png`) | After Step 2 completes, the waiting message sends automatically with `newWorkspace: {"workDir": "/home/orbit/code/app"}` and opens the conversation with `Created workspace app on orbit@austin · /home/orbit/code/app` and `Rename · Settings` (board 03 ③ / rule 8). |
| `05-machine-page.png` | `compare/05-machine-page.png` (`compare/android-machine-page.png`) | `orbit@austin`'s machine page under `Settings → Machines & models`: empty `Workspaces` card with `No workspaces on orbit@austin yet. Start a session and pick the folder it works in as you go.` + `Start a session`, and no `"Add or change workspaces on the web."` footer (rule 12). |

## When Android draws "Use an API Key"

- **Android's rule (`MachineSetup.firstKey` in `NewSessionComposer.kt` and `MachineSetupCard.kt`)**:
  Android follows the exact same rule as iOS (`MachineSetup.swift`, rule 5 of board 04): `"Use an API Key"` is drawn
  **only** when `keyToUse != null` — that is, when the account has an enabled API key or account pool in `GET /api/providers`
  (or `/api/providers/pools`, `/api/providers/shared-pools`) that can run on that machine for the selected engine or
  another installed engine. Unlike the web client, Android has no inline form on the setup card to paste or create a new
  provider key, so when the account has no compatible key (`keyToUse == null`), `"Use an API Key"` is not drawn.
- **What keys the scenario has, and why**:
  - In `01-setup-card.png` (and `03-setup-held.png`), the stub's `GET /api/providers` returns one enabled provider key
    (`id: "prov-deepseek"`, `slug: "deepseek"`, `hasApiKey: true`, `enabled: true`, `engines: ["claude"]`). We include
    this key in `01-setup-card.png` for two reasons: (1) Board 03 frame ② explicitly draws `Sign In` and `Use an API Key`
    side by side, and (2) the same continuous test flow taps `Use an API Key` in Step 2 to verify that completing both
    steps automatically dispatches `POST /api/sessions` with `engine: "claude"`, `provider: "deepseek"`, and
    `newWorkspace: {"workDir": "/home/orbit/code/app"}`.
  - In `01b-setup-card-no-key.png`, `GET /api/providers` returns `[]` (0 keys on the account), proving on the emulator
    that Android omits `"Use an API Key"` and shows only `Sign In` and `Use Codex instead` when no key can run on the
    machine (matching iOS's `iphone/01-card.png` vs `iphone/18-sign-in-and-key.png`).

## Test suites and verification

| Suite | Command | Result |
| --- | --- | --- |
| OrbitKit `swift test` (full suite in Docker `swift:6.1`) | `docker run --rm --memory=6g -v "$PWD":/w:ro -v /mnt/data/fw-android-orbitkit/sb:/sb -w /w/src/macos/OrbitKit swift:6.1 swift test --scratch-path /sb` | `Executed 4274 tests, with 5 tests skipped and 0 failures (0 unexpected) in 29.723 (29.723) seconds` (vs `main`'s 4254 baseline in `docs/evidence/first-workspace-native/README.md`) |
| Web `vitest` (full suite) | `cd src/web && VITEST_MAX_WORKERS=2 npx vitest run` | `455 passed (455)` test files, `6024 passed (6024)` tests, 0 failures |
| Android `:app:testDebugUnitTest` (full suite) | `ANDROID_HOME=/opt/android-sdk bash src/android/gradlew -p src/android testDebugUnitTest` | `2028 tests completed, 0 failures` (includes 71 tests in `MachineSetupCopyParityTest`, `MachineSetupTest`, `RunnerPageTest`, `FirstWorkspaceShotsTest`) |
| Android `:core:test` (full suite) | `ANDROID_HOME=/opt/android-sdk bash src/android/gradlew -p src/android :core:test` | `310 tests completed, 0 failures` |
| Android emulator (`emulator-5554`, API 36, 1080×2400) | `bash docs/evidence/first-workspace-android/kit/run.sh src/android/app/build/outputs/apk/debug/app-debug.apk src/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk docs/evidence/first-workspace-android/device-run` | `OK (1 test)` |

## Differences from board 03

The board is hand-drawn from iPhone measurements and first-draft copy; Android uses Material 3 (`MainActivity`,
`NewSessionComposer`, `SessionReader`, `SessionComposer`, `RunnerPage`) and the landed web/Swift copy.

| Frame | Board 03 | Real app (Android) | Why |
| --- | --- | --- | --- |
| Drawer (`02-drawer-set-up.png`) | A `⊕` glyph on `Set up orbit@austin`, floating bottom `New session` pill and gear disc | `ic_folder_add` (`folder-plus` vector) on `Set up orbit@austin`, Material 3 `ModalDrawerSheet` with `New session` pill and `Settings` row below `Workspaces` | Android's drawer (`MainActivity.kt`) places `New session` and `Settings` in the navigation column rather than a floating iOS bottom bar; `ic_folder_add` matches the web's `FolderAddOutlined` and iOS's `folder.badge.plus`. |
| Card, paths (`01-setup-card.png`, `03-setup-held.png`, `04-created-workspace.png`) | `~/code/app` | `/home/orbit/code/app` | The contract's `DirProbe.path` and `runner.registerDir` are absolute paths returned by the runner; web and iOS show the same absolute path so the user sees the exact directory being granted access. |
| Card, copy (`01-setup-card.png`) | First-draft strings (`Another folder…`, `Ask for a clone in your first message.`, `…signed in on that machine.`, `Nothing is created until you send.`) | Landed web/Swift sentences (`Another folder on orbit@austin`, `Starts empty. Ask for a clone or a new project in your first message.`, `…and spend its subscription.`, `Nothing is created until you send. You can rename the workspace or change these later.`) | The task specifies iOS/macOS and web as the copy source of truth; `MachineSetupCopyParityTest` enforces byte-for-byte parity with `MachineSetupCopy.swift`. |
| Card, Step 2 (`01-setup-card.png` vs `01b-setup-card-no-key.png`) | `Use an API Key` always drawn in the mockup | Drawn only when `MachineSetup.firstKey(...) != null` (`01-setup-card.png` with `deepseek`; omitted in `01b-setup-card-no-key.png` with `providers = []`) | Rule 5 says "when the account has a key that can run". Native clients do not have an inline key-creation form on the card, so with 0 keys nothing is offered. |
| Held message (`03-setup-held.png`) | Board 01 shows Step 2 mid-paste (`Open the sign-in page` + code input) while the message waits | Shows Step 1 folded (`Folder /home/orbit/code/app · Change`) and Step 2 ready for `Sign In` / `Use an API Key` above the waiting user bubble and `Waiting for orbit@austin — sends once both steps are done · Withdraw` | Captures the waiting message state right after Step 1 is confirmed and before Step 2 is chosen; clicking `Use an API Key` immediately triggers the auto-send into scene `04-created-workspace.png`. |
| Conversation (`04-created-workspace.png`) | Hamburger + session title (`Fix the flaky login test` / `app · orbit@austin`), bubble user turn, `Working for 1m`, `Reply…` / `Default` | Android `SessionReader` top bar (`Back`, `⋮`, drawer hamburger, refresh), full-width `You` / `Assistant` cards with `Copy message`, and `SessionComposer` (`Context: 0 tokens · Usage`, `Message...`, `+`, `claude-opus-5-5`, `Send`) | Android's `SessionReader` and `SessionComposer` use Android's established conversation chrome while placing `CreatedWorkspaceLineView` (`Created workspace app on orbit@austin · /home/orbit/code/app` + `Rename · Settings`) as the first item of the transcript `LazyColumn`. |
| Machine page (`05-machine-page.png`) | Board 03's "Today" frame showed `No workspaces on this runner yet.` and `"Tap a workspace to open its sessions. Add or change workspaces on the web."` | Capacity card + `Engines` card + `Workspaces` card with `No workspaces on orbit@austin yet. Start a session and pick the folder it works in as you go.` and a `Start a session` button; the `"on the web"` footer is removed | Board 03's top-right frame illustrated the old dead-end state being replaced; rule 12 of board 04 replaces it with `Start a session` and removes `"Add or change workspaces on the web."` across Android, Swift, and web. |

## Gaps not established by this evidence

1. **Controlled HTTP stub instead of a live `apiserver` + `runner-go` deployment**: Both `FirstWorkspaceDeviceShotsTest` (on `emulator-5554`) and `FirstWorkspaceShotsTest` (Robolectric) run against an in-process `MockWebServer` / fake transport implementing `docs/first-workspace-contract.md` rather than a live `apiserver` and `runner-go` daemon over a real network.
2. **Attachments on a waiting first message**: Preserving and restoring file attachments on `Hold` / `Withdraw` and forwarding them when both steps complete is covered by unit tests in `MachineSetupTest`, not driven through the Android system document picker on the emulator.
3. **Interactive CLI OAuth / device-code sign-in relay inside `RunnerSignInCard`**: The setup card embeds the existing `RunnerSignInCard`, and `FirstWorkspaceDeviceShotsTest` completes Step 2 via `Use an API Key` (while `FirstWorkspaceShotsTest` also covers engine sign-in state transitions), rather than driving a live browser OAuth round-trip against an external `claude` or `codex` CLI binary.
4. **Shared API 36 emulator rather than a physical handset**: The device screenshots were captured on the host's shared `emulator-5554` (sdk_gphone64_x86_64, Android 16 / API 36, 1080×2400) rather than a physical phone.
