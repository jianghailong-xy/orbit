# Android: Remove Default, its removed state and Use again

Task 34jpFWQkUfxoS2HX9X7N1 of project 34jjcdca6uuW0qHCjTdKg ("Remove a runner's Default account from
Orbit"). Frames of a runner's Codex engine page on the shared emulator (emulator-5554, API 36), from the
debug APK built at 326fa3c8c: the real product shell, pages and words. Only the REST data is scripted, by a
MockWebServer inside the instrumentation (`kit/src/RemovedDefaultShotsTest.kt`). It serves the runner
wikova the way the control plane serves it with Codex's Default removed (`usedRunnerEngines`: the
remaining accounts, `removedDefault`, the engine's sign-in and quota theirs). No deployed server, account
or runner is involved.

| Frame | What it shows |
| --- | --- |
| `screenshots/confirm-remove-default-{light,dark}.png` | Before removal: Default's ⋯ → Remove… asks the web's question, "Remove Default?" and "Orbit stops using it on wikova. Its sign-in stays on the machine, and Codex in a terminal there keeps working. Workspaces set to it run on Automatic." |
| `screenshots/removed-two-{light,dark}.png` | Default removed, Work and Personal remaining: each a row of its own with its own sign-in and quota, NEXT on Work, then "Default · ~/.codex isn’t used by Orbit" and Use again |
| `screenshots/remove-added-while-removed-{light,dark}.png` | Personal's Remove… while Default is removed: "Remove Personal?" and "Its sign-in is deleted from wikova. Workspaces set to this account run on Automatic." |
| `screenshots/removed-one-{light,dark}.png` | Work alone: still a row of its own with NEXT, then Default's line and Use again, then Add Account |
| `screenshots/used-again-{light,dark}.png` | After Use again (the restore route POSTed): Default listed again |

`device-run/` keeps the run's records: each theme's instrumentation output (`OK (1 test)`), the source
commit and status, the APKs' sha256, the emulator, and the night mode and stylus setting it restored.

To take them again, from the repository root:

```sh
src/android/gradlew -p src/android -I docs/evidence/default-account-removal/android/kit/kit.gradle \
  :app:assembleDebug :app:assembleDebugAndroidTest
bash docs/evidence/default-account-removal/android/kit/run.sh <app-debug.apk> <app-debug-androidTest.apk> <empty dir>
```

`kit.gradle` adds `kit/src` to the androidTest sources, so nothing under `src/android/app/src/androidTest`
changes. The driver holds `/var/lib/orbit/android/ui.lock` and replaces a debug install signed with
another key, as `src/android/scripts/drawer-projects-device-test.sh` does. It runs light, then dark, each
from a signed-out installation.

The words are `RunnerAccountCopy` in RunnerPage.kt, held to `src/web/src/lib/runnerAccountCopy.ts` by
`RunnerAccountCopyParityTest`.
