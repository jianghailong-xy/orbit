# Android: a machine's first workspace against board 03

Task 34pLtXumbawMl6II4gUPa of project 34pLjYBjU6ILsehatEjJs. The boards are
`docs/mocks/first-workspace-in-conversation` (03 for the iPhone/Android design, 04 for the rules); the server contract is
`docs/first-workspace-contract.md`; the copy is held to `src/macos/OrbitKit/Sources/OrbitKit/App/MachineSetupCopy.swift` by
`MachineSetupCopyParityTest`.

## Screenshots (`FirstWorkspaceShotsTest`, Robolectric `GraphicsMode.NATIVE`)

| File | Scene |
| --- | --- |
| `01-setup-card.png` | Cold start with 0 workspaces and an online machine (`orbit@austin`): lands on `New session` / `orbit@austin` with the Setup Card, probing `registerDir` (`/home/orbit/code/app` · `Found · git repository · main`), folder choices, `Use This Folder`, and Step 2 (`Sign in Claude Code on orbit@austin` with `Sign In`, `Use an API Key`, `Use Codex instead`) (board 03 ②). |
| `02-drawer-set-up.png` | Drawer under `Workspaces`: `Set up orbit@austin` with the folder-plus icon in primary accent, and `New session` enabled (board 03 ①). |
| `03-setup-held.png` | Step 1 folded (`✓ Folder /home/orbit/code/app · git repository · main · Change`), Step 2 waiting for sign-in, and the first message waiting under the card (`Waiting for orbit@austin — sends once both steps are done · Withdraw`) (board 03 ②). |
| `04-created-workspace.png` | Once Step 2 completes, the held message auto-creates the workspace and session (`POST /sessions` with `assignedRunnerId` + `newWorkspace`) and opens the conversation with `Created workspace app on orbit@austin · /home/orbit/code/app` and `Rename · Settings` at the top of the transcript (board 03 ③). |

## Test verification

- `ANDROID_HOME=/opt/android-sdk bash src/android/gradlew -p src/android testDebugUnitTest`: 2,028 tests passed, 0 failures.
- `ANDROID_HOME=/opt/android-sdk bash src/android/gradlew -p src/android :core:test`: 310 tests passed, 0 failures.
- `cd src/web && VITEST_MAX_WORKERS=2 npx vitest run src/lib/runnerAttention.test.ts src/copyLanguage.test.ts`: 129 tests passed, 0 failures.
