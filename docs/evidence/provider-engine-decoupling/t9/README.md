# T9 · Android: engine first, then a provider it runs

Task [T9](orbit-task:34cdPiEnaMzkzS596poDi), project Provider/Engine decoupling (34ccMg4EoSorpVooMC4kg). The Android client
follows the confirmed boards in [`docs/mocks/provider-engine-decoupling/`](../../../mocks/provider-engine-decoupling/) (iOS 1, 2, 4, 5
and web 6) and the server interface from T3 ([`docs/provider-engine-contract.md`](../../../provider-engine-contract.md)).

## What changed (src/android/app/src/main/kotlin/io/orbitd/android)

| Area | Change | Board |
| --- | --- | --- |
| `composer/ProviderEngines.kt` (new) | Kotlin mirror of `src/shared/src/providerEngines.ts`: `ALL_ENGINES`, `ENGINE_CLI_NAMES`, `credentialEngines`, `defaultEngineOf`, `isEngineCompatible`, `isDeepSeekKey`, `DSH_PERMISSION_MODES`; plus the client reads (`providerEngines` off GET /providers `engines`, `sessionEngine`, pools as providers). | contract §2.1 |
| `composer/ComposerData.kt`, `ComposerApi.kt` | The catalogue is asked of an engine: credentials grouped (own sign-in / OpenCode's own config, pools, keys) from each key's `engines`; DeepSeek Harness lists every DeepSeek key and has no row of its own; models, efforts, fast, slash and permission modes by engine (Harness: Default, Auto, Don't Ask); a session's key turned off or deleted says so (GET /providers/mine read only then). | iOS 4 ②, iOS 5 |
| `composer/NewSessionComposer.kt`, `SessionComposer.kt`, `ComposerModel.kt` | New session: an Engine row opens the engine list (CLI names, the model each lands on, ✓ on the current one, "Connect a DeepSeek key →" without one); the model menu is titled by the session's engine and its Provider part lists only what that engine runs. Create, switch, resume and retry send the engine with the provider; `ComposerModel` adds the session's engine to any provider written without one. | iOS 4 ①②, iOS 5 |
| `tasks/TaskDetail.kt`, `TaskApi.kt`, `TaskLogic.kt` | Task pins are Engine (Assignee's or one of six) then Provider (Engine default, account pools, keys the engine runs); moving the engine drops a credential it can't run and the model; `TaskApi.pin` writes the pair in one PATCH. | web 6 |
| `management/ProviderManagement.kt`, `DeepSeekBalance.kt` | Each API key lists the engines it runs on (`Claude Code · OpenCode · DeepSeek Harness`, `Claude Code · subscription token`), keys of one vendor together; a DeepSeek key's page shows "Works with" and the key's protocol instead of "Runs on <one engine>". | iOS 1 ③④, iOS 2 |
| `management/RunnerPage.kt`, `RunnerScreens.kt` | Engine names from `ENGINE_CLI_NAMES` (Antigravity CLI); DeepSeek Harness is an engine row saying "Uses API keys" (or why it can't run), with its own engine-page copy; workspaces counted on a sign-in only when their engine is that engine. | iOS 1 ⑤⑥⑦ |
| `wiki/WikiSettingsScreen.kt` | Maintenance offers every key Claude Code runs by the compatibility table (a DeepSeek key included). | contract §3.5 |
| `management/WorkspaceSettings.kt` | The workspace form's efforts are its next session's engine's, Harness's from its ACP catalogue. | contract §2.3 |

## Tests

Unit tests (src/android/app/src/test/kotlin/io/orbitd/android): `composer/ProviderEnginesTest.kt` (the shared spec's cases one for
one, plus parity reads of `providerEngines.ts` and `enums.ts`), `composer/ComposerModelTest.kt` (engine grouping, DSH multi-key,
Harness modes, model/effort/slash by engine, key gone, engine + provider on create/switch/resume/retry),
`composer/ComposerAccountsTest.kt`, `tasks/TaskLogicTest.kt`, `tasks/TaskApiTest.kt`, `management/SettingsLogicTest.kt`,
`management/RunnerPageTest.kt`, the DeepSeek balance tests and `wiki/WikiSettingsFixtureTest.kt`.

## Screenshots

PENDING
