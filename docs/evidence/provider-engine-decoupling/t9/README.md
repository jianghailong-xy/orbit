# T9: Android follows the provider/engine split

Task `34cdPiEnaMzkzS596poDi`, project `34ccMg4EoSorpVooMC4kg`. The design is the owner-confirmed T0 boards in
`docs/mocks/provider-engine-decoupling/` (iOS 1, 2, 4 and 5; web 6 for the task pin) and the server interface from T3
(`docs/provider-engine-contract.md` §2, §3, §6). Android follows the iOS structure: the engine is picked first, and the
composer's model menu lists only the credentials that engine runs.

Revision 2 merges main as it stood after the Android composer work A07c (main `56c21bdd2`, then the project tip `c5447f6bf`).
A07c had built its composer on the earlier model, where the provider decides the engine. The merge keeps this task's model and
every A07c feature; see [Merged with A07c](#merged-with-a07c-revision-2).

## What changed (src/android/app/src/main/kotlin/io/orbitd/android)

| Area | Change | Board |
| --- | --- | --- |
| `composer/ProviderEngines.kt` (new) | Kotlin mirror of `src/shared/src/providerEngines.ts`: `ALL_ENGINES`, `ENGINE_CLI_NAMES`, `credentialEngines`, `defaultEngineOf`, `isEngineCompatible`, `isDeepSeekKey`, `DSH_PERMISSION_MODES`. Plus what a client reads: each key's `engines` from GET /providers (an older payload falls back to the key's protocol), a session's engine, and account pools read as providers. | contract §2.1 |
| `composer/ComposerData.kt`, `ComposerApi.kt` | Every question is asked of an engine. Credentials are grouped: the engine's own sign-in (or OpenCode's own configuration), then account pools, then keys. DeepSeek Harness lists every DeepSeek key and has no row of its own. Models, efforts, fast mode, slash commands and permission modes follow the engine; on Harness the modes are Default, Auto and Don't Ask only. A session whose key is turned off or deleted says so. GET /providers/mine is read only in that case. A credential this runner can't run says why and which engine page fixes it. Antigravity CLI's sign-in is offered for a Google account or a key the server confirms, and says which (A07-4). An engine the runner leaves out of its report runs nothing there. | iOS 4 ②, iOS 5 |
| `composer/NewSessionComposer.kt`, `SessionComposer.kt`, `ComposerModel.kt` | New session: an Engine row opens the engine list, with CLI names, the model each engine would start on and a ✓ on the current one. Without a DeepSeek key, Harness offers "Connect a DeepSeek key →"; an engine that can't run here says why, and its row opens the runner's page for that engine. The model menu's head says "Model and account" and, under it, the session's engine (A07-13), which stays in view as the Provider list scrolls. A sign-in with several accounts lists Automatic first, then each account with its own quota and the current one ticked; a signed-out account opens its sign-in (A07-10). Create, switch, resume and retry all send the engine with the provider; `ComposerModel` adds the session's engine to any provider written without one. | iOS 4 ①②, iOS 5 |
| `composer/ProviderChoices.kt` | A07c's reasons kept: Antigravity's ("Update runner", "Not installed", a lapsed Google sign-in) and the arrow that closes a reason. The arrow says "sign in" only where the reason is a sign-in. | iOS 4 ② |
| `reader/SessionConsole.kt` | The Antigravity repair card asks the session's engine, and its Gemini switch moves to a key that engine runs, sent with the engine. | — |
| `tasks/TaskDetail.kt`, `TaskApi.kt`, `TaskLogic.kt` | A task pins an Engine (Assignee's, or one of six) and then a Provider (Engine default, account pools, or keys the engine runs). Changing the engine drops the model, and drops a credential the new engine can't run. `TaskApi.pin` writes the pair in one PATCH. | web 6 |
| `management/ProviderManagement.kt`, `DeepSeekBalance.kt` | Each API key lists the engines it runs on (`Claude Code · OpenCode · DeepSeek Harness`, or `Claude Code · subscription token`), with one vendor's keys together. A DeepSeek key's page says "Works with" and gives the key's protocol, instead of "Runs on <one engine>". | iOS 1 ③④, iOS 2 |
| `management/RunnerPage.kt`, `RunnerScreens.kt` | Engine names come from `ENGINE_CLI_NAMES` (e.g. Antigravity CLI). DeepSeek Harness has its own engine row saying "Uses API keys", or why it can't run, and its own engine-page wording. A workspace counts toward a sign-in only when it runs on that sign-in's engine. | iOS 1 ⑤⑥⑦ |
| `wiki/WikiSettingsScreen.kt` | Wiki maintenance offers every key Claude Code runs, by the compatibility table, including DeepSeek keys. | contract §3.5 |
| `management/WorkspaceSettings.kt` | The workspace form offers the efforts of the engine its next session runs on; Harness's come from its ACP catalogue. | contract §2.3 |

## Merged with A07c (revision 2)

Conflicts in `ComposerApi`, `ComposerData`, `ComposerUsage`, `SessionComposer` and `RunnerPage` were resolved with this task's
model: the engine first, and credentials by engine compatibility. A07c's features are kept on it:

| A07c | Kept as |
| --- | --- |
| A07-7 a pool session names its account and that account's quota | `PoolAccount`, `poolAccount`, the account beside Context · Usage. Pools are read through `ProviderEngines.poolRow`, which now marks a shared pool as A07c's reader did. |
| A07-12 the auto-retry card and its Continue | unchanged (`ComposerModel.sendMessage`) |
| A07-9 the Codex reset-credit card | unchanged (`ComposerUsage`) |
| A07-4 the Antigravity repair card, Google sign-in by the runner page's rule | unchanged card; its Gemini switch reads the session's engine |
| A07-1 text and Markdown attachments | unchanged |
| A07-10 each engine's accounts, Automatic first | the sign-in group of the engine's Provider list, with ✓ on the account the draft or session is on (Default where none is named) |
| A07-13 the menu opens on the engine | the session's engine under "Model and account" |
| A07-8 Retry re-sends on the pick held here | `ComposerModel.retryIdentity`, now with the engine |
| A07-3 engine order | the Engine list in the boards' order (`ALL_ENGINES`) |
| A07-6 a key under OpenCode | the key by its own slug in OpenCode's Provider list, with a bare model |

Retired with the earlier model: the one flat provider list (`choices`, `sameRuntime`), `executingRuntime`, the title's
"→ next engine" (a session never changes engine), and `OpenCodeKeys` with its `opencode/<slug>` choices and `orbit-<slug>/` model
ids (contract §1.3, §3.3: the server stores the key and a bare model, and normalizes the old encoding on write).

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

A07c's tests that pinned the earlier model are rewritten to this one. None is deleted or skipped:

| Test | Before | Now, and why |
| --- | --- | --- |
| `ProviderChoicesTest.theEnginesComeInIosOrderThenPoolsThenKeysThenOpenCode` → `theEnginesComeInTheBoardsOrderAndEachListsItsSignInThenPoolsThenKeys` | one flat list: engines in iOS's order, then pools, keys, OpenCode | the Engine list in `ALL_ENGINES` order; each engine lists its own sign-in, pools and keys |
| `ProviderChoicesTest.aRowSaysWhyItCannotRunHere` | reasons on the flat list; OpenCode hidden until installed | the same reasons per engine, each with the engine page that fixes it; a missing OpenCode says "Not installed" like any engine |
| `ProviderChoicesTest.aSessionMovesOnlyWithinItsOwnCli` → `aSessionMovesOnlyWithinItsOwnEngine` | moves within the CLI the provider executes on | moves within the session's engine's credentials |
| `ProviderChoicesTest.theEngineTitleNamesTheCliThatExecutes` → `theEngineTitleNamesTheSessionsEngine` | the title came from the provider | the session's recorded engine (a DeepSeek key on OpenCode says OpenCode); a read without one takes its provider's; Antigravity is "Antigravity CLI" |
| `ProviderChoicesTest.theEngineTitleSaysWhereAHeldPickGoesOnlyWhenTheEngineChanges` → `aHeldPickNeverChangesTheEngineTitle` | "OpenCode → Claude Code" when a held pick changed the CLI | a held pick is a credential of the same engine |
| `ProviderChoicesTest.openCodeKeysNameTheKeyInTheModelAndThePickerChoice` → `anOpenCodeSessionOnAKeyNamesTheKeyAndABareModel` | `opencode/<slug>` choices, `orbit-<slug>/<model>` ids | the key is the provider, the model bare |
| `ProviderChoicesTest.theKeysOpenCodeMaySpendFollowItWithTheirModels` → `…FollowItsOwnConfigWithTheirModels` | keys repeated under OpenCode as choices | keys in OpenCode's Provider list by their own slug, with their own models |
| `ProviderChoicesTest.antigravityIsOfferedForAGoogleAccountOrAKeyAndSaysWhatItRunsOn` | rules on the flat list | the same A07-4 rules on Antigravity CLI's credentials; the arrow names a sign-in only for a sign-in |
| `EngineOrderTest` (both) | flat Provider rows in iOS's order; an unreported engine listed | the Engine list in the boards' order; an engine the runner leaves out of its report is not offered |
| `OpenCodeKeysTest` (both) | creates `opencode` + `orbit-deepseek/deepseek-chat`; moving to OpenCode's config is a model change | creates engine `opencode`, provider `deepseek`, model `deepseek-chat`; moving is a provider change on the same engine |
| `AutomaticAccountTest` (all three) | Claude's and Codex's accounts in one list | only the draft's engine's accounts, the current one ticked; Codex's after picking Codex in the Engine list; the spoken engine is "Claude Code" |
| `RetryProviderTest.aRetryAfterAProviderPickRunsOnThePick` | `{provider}` | `{provider, engine}` |
| `AntigravityRepairShellTest` (two cases) | the switch sent `{provider, model, effort}`; the fix was a Provider row | the switch also sends `engine`; the Engine list's Antigravity CLI row says "Update runner →" and opens its page |

`EngineTitleTest` keeps its two cases and gains one: a DeepSeek key on OpenCode's session says OpenCode. `PoolAccountTest`,
`AutoRetryCardTest`, `CodexResetCardTest`, `CodexResetTest`, `AttachmentPreviewTest`, `TextFilePreviewTest` and `AutoRetryLogicTest`
pass unchanged.

## Device journeys (src/android/app/src/androidTest)

- `composer/ComposerDeviceTest` (fixture `scripts/composer-fixture.py`): `draftAccountUsageAndProviderSwitchMatchAutomaticCreate` lists
  Codex's accounts, then moves the draft to Claude Code in the Engine list for Claude Code's, and creates with the engine;
  `a07cModelMenuEnginesAccountsAndKeys` reads the Engine list's order, Antigravity CLI's Google account and OpenCode's keys, and creates
  (opencode, deepseek, deepseek-chat); `a07cRetryCarriesTheProviderPick` also checks the engine sent; `realModelAccountQueueStopPermissionsAndRefresh`
  presses its account row through the row's click action once pressable, as its other presses do.
- `composer/ComposerStackDeviceTest` (A11's isolated stack): `s1` reads the Engine list, picks Claude Code, then reads Claude Code's,
  Codex's and OpenCode's Provider lists, and opens Antigravity CLI's page from its row.

Run on the shared API 36 emulator. The ten `ComposerDeviceTest` journeys that read the Provider list or exercise A07c's features
(new session, controls, draft account, A07c's model menu, auto-retry, continue, Antigravity repair, pool account and reset credit,
retry on a pick, text and Markdown files) pass on the APKs of `2c835ffb9`. `ComposerStackDeviceTest` ran on an isolated stack built
from this branch's own server and runner (`2c835ffb9`; `src/android/scripts/a11-stack`, port 3719): `s2`–`s6` pass there. `s1`'s
first run read Codex where it expected Claude Code, because the stack's workspace last ran Codex and a new session starts there; the
journey now picks Claude Code first, and passes on the same stack with the APKs of `7cada1bb2`.

## Screenshots

Taken on the shared API 36 emulator (`emulator-5554`, 1080×2400) with the debug APK built from the commit named in
`run-log/<commit>/identity-*.txt`. The account is the boards' own, served by `kit/fixture.py`: machine hpc, two DeepSeek keys, a GLM
key, a Claude subscription token, Gemini and Moonshot keys, and a pool of Claude accounts. `kit/ProviderEngineShotsTest.kt` drives
the real app and checks each screen as it goes, including what the fixture received: the engine travels with the provider on
every write. Each screen was taken once with the system in light mode and once in dark mode.

| File | Screen | Board |
| --- | --- | --- |
| `01-new-session-engines-*.png` | New session → Engine: six engines by CLI name, with the model each starts on; Kimi Code "Not installed →" | iOS 4 ① |
| `02-new-session-dsh-menu-*.png` | DeepSeek Harness picked: the menu's head names the engine; models, efforts and Default/Auto/Don't Ask only | iOS 4 ② |
| `03-new-session-dsh-provider-*.png` | Harness's Provider: API keys DeepSeek ✓ and DeepSeek 2; no Harness row | iOS 4 ② mark 3 |
| `04-…claude-provider-*.png`, `04b-…-end-*.png` | Claude Code's Provider: Signed in on hpc (Automatic, ✓ Default, Work, each with its quota), Account pools, API keys incl. Claude Max | iOS 4 ② mark 4 |
| `05-…opencode-provider-*.png`, `05b-…-end-*.png` | OpenCode's Provider: OpenCode's own sign-in (opencode auth), the keys it runs; "Claude Max isn't here…" | iOS 4 ② mark 5 |
| `06-new-session-no-deepseek-key-*.png` | No DeepSeek key: Harness offers "Connect a DeepSeek key →" | iOS 4 ① mark 2 |
| `07-composer-dsh-switch-*.png`, `08-composer-dsh-switched-*.png` | A Harness session switches from DeepSeek to DeepSeek 2; the head stays DeepSeek Harness | iOS 5 ① marks 1, 3 |
| `09-composer-key-deleted-*.png` | The session's key was deleted: Provider says "Key deleted"; same-engine keys fix it | iOS 5 ① mark 2 |
| `10-task-pin-engine-menu-*.png`, `11-…provider-menu-*.png`, `12-task-pinned-*.png` | Task: Engine first, then Engine default / Your DeepSeek keys; pinned DeepSeek Harness + DeepSeek 2 | web 6 ① marks 1–3 |
| `13-keys-engines-*.png` | Providers → Your API keys: every key with the engines it runs on | iOS 1 ③④ |
| `14-deepseek-key-works-with-*.png` | A DeepSeek key's page: Works with, Key (protocol, default model) | iOS 2 |
| `15-runner-engines-*.png` | The machine's engines: Antigravity CLI, DeepSeek Harness "Uses API keys" | iOS 1 ⑤ |

Revision 2 retook every screen on `2827350e5` and compared each with revision 1's (`24eebcbe2`) pixel by pixel below the
status bar (`run-log/2827350e5/pixel-compare.txt`). Only the changed ones were replaced:

- Replaced, 22 files: `02`–`05b` and `07`–`09` in both themes. The menu's head now says "Model and account" with the engine under
  it (A07-13), the "Current:" line is gone, and a sign-in's accounts carry their quota under them with ✓ on the current one: 04 now
  ticks Default. `01` and `06` in both themes: Kimi Code's "Not installed" now ends in "→", as the row opens the runner's Kimi
  Code page.
- Kept, 12 files: `13`–`15` are identical. `10`–`12` differ only in the task's relative time ("15h ago" against "16h ago").

`run-log/<commit>/` keeps each run's own record: the instrumentation output per theme, the device and APK identity, the input
hashes, the result of each journey, and the fixture's tally of what the app sent. `24eebcbe2` took the kept screens, `2827350e5`
the replaced ones.

To repeat it: build the app and test APKs with the kit's journeys compiled in (any init script that adds `kit/` to the
`androidTest` source set), then run `kit/run.sh <app.apk> <test.apk> <new dir>`. It holds `/var/lib/orbit/android/ui.lock`
for the whole run.

## Where Android differs from the boards

- Android's model menu is a dialog, not an iOS menu with a submenu. Its head says "Model and account" with the engine under it.
  The Provider part lists its groups inline, under the models, efforts and permission modes, so long lists scroll. The `*b-…-end`
  shots show where those lists end.
- Android had no new-session hero. Its Engine row sits under the workspace name and opens the engine list as a dialog. Picking
  the provider stays in the composer's model menu, as on iOS. Engine and brand marks are not drawn.
- A deleted key's own name is gone from every list the client can read, so "This session's key" shows its slug.
- Android still calls the page Settings → Providers. The Infrastructure merge (project 34aithLozDanSv6nq0IAi) covered web,
  iOS and macOS only, so the key list keeps its section title and footer.
