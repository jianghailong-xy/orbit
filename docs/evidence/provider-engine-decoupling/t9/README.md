# T9: Android follows the provider/engine split

Task `34cdPiEnaMzkzS596poDi`, project `34ccMg4EoSorpVooMC4kg`. The design is the owner-confirmed T0 boards in
`docs/mocks/provider-engine-decoupling/` (iOS 1, 2, 4 and 5; web 6 for the task pin) and the server interface from T3
(`docs/provider-engine-contract.md` §2, §3, §6). Android follows the iOS structure: the engine is picked first, and the
composer's model menu lists only the credentials that engine runs.

## What changed (src/android/app/src/main/kotlin/io/orbitd/android)

| Area | Change | Board |
| --- | --- | --- |
| `composer/ProviderEngines.kt` (new) | Kotlin mirror of `src/shared/src/providerEngines.ts`: `ALL_ENGINES`, `ENGINE_CLI_NAMES`, `credentialEngines`, `defaultEngineOf`, `isEngineCompatible`, `isDeepSeekKey`, `DSH_PERMISSION_MODES`. Plus what a client reads: each key's `engines` from GET /providers (an older payload falls back to the key's protocol), a session's engine, and account pools read as providers. | contract §2.1 |
| `composer/ComposerData.kt`, `ComposerApi.kt` | Every question is asked of an engine. Credentials are grouped: the engine's own sign-in (or OpenCode's own configuration), then account pools, then keys. DeepSeek Harness lists every DeepSeek key and has no row of its own. Models, efforts, fast mode, slash commands and permission modes follow the engine; on Harness the modes are Default, Auto and Don't Ask only. A session whose key is turned off or deleted says so. GET /providers/mine is read only in that case. | iOS 4 ②, iOS 5 |
| `composer/NewSessionComposer.kt`, `SessionComposer.kt`, `ComposerModel.kt` | New session: an Engine row opens the engine list, with CLI names, the model each engine would start on and a ✓ on the current one. Without a DeepSeek key, Harness offers "Connect a DeepSeek key →". The model menu is titled by the session's engine. Create, switch, resume and retry all send the engine with the provider; `ComposerModel` adds the session's engine to any provider written without one. | iOS 4 ①②, iOS 5 |
| `tasks/TaskDetail.kt`, `TaskApi.kt`, `TaskLogic.kt` | A task pins an Engine (Assignee's, or one of six) and then a Provider (Engine default, account pools, or keys the engine runs). Changing the engine drops the model, and drops a credential the new engine can't run. `TaskApi.pin` writes the pair in one PATCH. | web 6 |
| `management/ProviderManagement.kt`, `DeepSeekBalance.kt` | Each API key lists the engines it runs on (`Claude Code · OpenCode · DeepSeek Harness`, or `Claude Code · subscription token`), with one vendor's keys together. A DeepSeek key's page says "Works with" and gives the key's protocol, instead of "Runs on <one engine>". | iOS 1 ③④, iOS 2 |
| `management/RunnerPage.kt`, `RunnerScreens.kt` | Engine names come from `ENGINE_CLI_NAMES` (e.g. Antigravity CLI). DeepSeek Harness has its own engine row saying "Uses API keys", or why it can't run, and its own engine-page wording. A workspace counts toward a sign-in only when it runs on that sign-in's engine. | iOS 1 ⑤⑥⑦ |
| `wiki/WikiSettingsScreen.kt` | Wiki maintenance offers every key Claude Code runs, by the compatibility table, including DeepSeek keys. | contract §3.5 |
| `management/WorkspaceSettings.kt` | The workspace form offers the efforts of the engine its next session runs on; Harness's come from its ACP catalogue. | contract §2.3 |

## Unit tests (src/android/app/src/test/kotlin/io/orbitd/android)

- `composer/ProviderEnginesTest.kt` (new): every case of `providerEngines.spec.ts`, one for one. It also reads `providerEngines.ts`
  and `enums.ts` back, so engine order, CLI names and Harness's modes can't drift.
- `composer/ComposerModelTest.kt`: engine grouping; Harness's two DeepSeek keys and no `dsh` row; Harness's three modes; models, efforts, fast
  mode and slash commands by engine; a session's key gone; the engine sent with the provider on create, switch, resume and retry.
- `composer/ComposerAccountsTest.kt`: the sign-in group is the engine's runner accounts; Harness has only DeepSeek keys.
- `tasks/TaskLogicTest.kt`, `tasks/TaskApiTest.kt`: the engine pin comes first; a provider is pinned with its engine; one PATCH with
  three-state fields.
- `management/SettingsLogicTest.kt`, `RunnerPageTest.kt`, `DeepSeekBalance*Test.kt`, `wiki/WikiSettingsFixtureTest.kt`: workspace effort by
  engine, the key engines line, vendor order, key page footer, the Harness engine row, and wiki keys by engine.

## Screenshots

Taken on the shared API 36 emulator (`emulator-5554`, 1080×2400) with the debug APK built from the commit named in
`run-log/identity-*.txt`. The account is the boards' own, served by `kit/fixture.py`: machine hpc, two DeepSeek keys, a GLM
key, a Claude subscription token, Gemini and Moonshot keys, and a pool of Claude accounts. `kit/ProviderEngineShotsTest.kt` drives
the real app and checks each screen as it goes, including what the fixture received: the engine travels with the provider on
every write. Each screen was taken once with the system in light mode and once in dark mode.

| File | Screen | Board |
| --- | --- | --- |
| `01-new-session-engines-*.png` | New session → Engine: six engines by CLI name, with the model each starts on | iOS 4 ① |
| `02-new-session-dsh-menu-*.png` | DeepSeek Harness picked: the menu is titled by the engine; models, efforts and Default/Auto/Don't Ask only | iOS 4 ② |
| `03-new-session-dsh-provider-*.png` | Harness's Provider: API keys DeepSeek ✓ and DeepSeek 2; no Harness row | iOS 4 ② mark 3 |
| `04-…claude-provider-*.png`, `04b-…-end-*.png` | Claude Code's Provider: Signed in on hpc (Automatic, Default, Work), Account pools, API keys incl. Claude Max | iOS 4 ② mark 4 |
| `05-…opencode-provider-*.png`, `05b-…-end-*.png` | OpenCode's Provider: OpenCode's own sign-in (opencode auth), the keys it runs; "Claude Max isn't here…" | iOS 4 ② mark 5 |
| `06-new-session-no-deepseek-key-*.png` | No DeepSeek key: Harness offers "Connect a DeepSeek key →" | iOS 4 ① mark 2 |
| `07-composer-dsh-switch-*.png`, `08-composer-dsh-switched-*.png` | A Harness session switches from DeepSeek to DeepSeek 2; the title stays DeepSeek Harness | iOS 5 ① marks 1, 3 |
| `09-composer-key-deleted-*.png` | The session's key was deleted: Provider says "Key deleted"; same-engine keys fix it | iOS 5 ① mark 2 |
| `10-task-pin-engine-menu-*.png`, `11-…provider-menu-*.png`, `12-task-pinned-*.png` | Task: Engine first, then Engine default / Your DeepSeek keys; pinned DeepSeek Harness + DeepSeek 2 | web 6 ① marks 1–3 |
| `13-keys-engines-*.png` | Providers → Your API keys: every key with the engines it runs on | iOS 1 ③④ |
| `14-deepseek-key-works-with-*.png` | A DeepSeek key's page: Works with, Key (protocol, default model) | iOS 2 |
| `15-runner-engines-*.png` | The machine's engines: Antigravity CLI, DeepSeek Harness "Uses API keys" | iOS 1 ⑤ |

`run-log/` keeps the run's own record: the instrumentation output per theme, the device and APK identity, the input hashes, and
the fixture's tally of what the app sent.

To repeat it: build the app and test APKs with the kit's journeys compiled in (any init script that adds `kit/` to the
`androidTest` source set), then run `kit/run.sh <app.apk> <test.apk> <new dir>`. It holds `/var/lib/orbit/android/ui.lock`
for the whole run.

## Where Android differs from the boards

- Android's model menu is a dialog, not an iOS menu with a submenu. The Provider part lists its groups inline, under the
  models, efforts and permission modes, so long lists scroll. The `*b-…-end` shots show where those lists end.
- Android had no new-session hero. Its Engine row sits under the workspace name and opens the engine list as a dialog. Picking
  the provider stays in the composer's model menu, as on iOS. Engine and brand marks are not drawn.
- A deleted key's own name is gone from every list the client can read, so "This session's key" shows its slug.
- Android still calls the page Settings → Providers. The Infrastructure merge (project 34aithLozDanSv6nq0IAi) covered web,
  iOS and macOS only, so the key list keeps its section title and footer.
