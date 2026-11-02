# Claude region check: Android, against board 03

Evidence for task "Region check: Android" of project "Claude region check" (docs/claude-region-check-contract.md, design of
record docs/mocks/claude-region-check). Android follows the landed iOS and web tasks: their rules
(docs/evidence/claude-region-check-web/README.md, "Rules the iOS and Android tasks can follow"; docs/evidence/claude-region-check-apple/README.md)
and their words (`src/web/src/lib/claudeRegionCopy.ts`, OrbitKit's `ClaudeRegionCopy.swift`). Every picture here is the real
Android app — this branch's debug build — on the shared API 36 emulator (1080×2400, 420 dpi), driven by
`ClaudeRegionDeviceTest` over its own fixture (a MockWebServer in the instrumentation, not a deployment).

Code: one commit, `feat(android): Claude region check on the session card, machine page, pickers and list words`.

## What each surface does

| Surface | Android | Where |
| --- | --- | --- |
| Session card | Cause read off `CLAUDE_REGION_UNSUPPORTED: `, before every cause read by pattern (a machine's name can hold "offline" or an upgrade sentence). Why `Claude Code can’t use Anthropic on {machine}`; body = the §9 sentence without its code, then `Supported regions` (a link); lines `CLAUDE_REGION_UNSUPPORTED · {regionCode ?? country}` and `Checked {HH:mm, or weekday HH:mm} · Claude’s connection: {name} (no proxy \| through a proxy)`, each wrapping, never cut; presses Use another provider (filled) · Move to another machine · Check again; foot `No engine ran · your message is still here`, or `Ended · no engine ran · 0 turns` from a control plane that predates the hold. With `region` null or no longer blocked: the server's words without the code, the bare code, no check line, no Check again. A stopped turn on a failed or parked session draws no card. | core `SessionRunStart`, `ClaudeRegion`, `ClaudeRegionCopy`; app `cards/SessionRunStartCard.kt` |
| The card's presses | In a `FlowRow`, in the card's order. Use another provider lists the credentials the session's Claude Code can move to here (a dialog, as iOS lists them) and PATCHes the provider; drawn only where one exists. Move to another machine opens the session's own Move. Check again posts `/runners/:id/region-check`, then reads the runner every 2 s until `region.checkedAt` reaches the request, up to 30 s; drawn only where `region` is not null, held while the runner is offline or the check is on its way. | `SessionRunStartCard`, `SessionConsole.otherProviders` / `checkRegionAgain`, `SessionReader` |
| Provider note | A held session has nothing in flight: a pick says `Your next message uses {to}.`, never `The turn in flight finishes on {from}…` (`liveRun = !terminal && !held`) — the review of the iOS task, item 1. | `ComposerModel.switchNote` |
| Transcript | A refusal's error event draws no row, and its turn counts as answered (no "turn ended without a reply"); the stopped sentence draws without its code. Android draws no working row over a queued message, so a held one shows none. | `reader/TranscriptRows.kt` (`EngineReading`) |
| List row | `Anthropic unavailable on {machine}` in place of the row's state word; the machine is the workspace's runner (the web's `machineName(runner)`). Android's session page bar names no session (A06-18, like the iPhone's console), so the list row is where the header's words show. | `directory/DirectoryScreen.kt` `SessionRow`, `DirectorySession.regionHeld` |
| Machine page | Needs Attention: `Claude Code can’t use Anthropic here` / `Anthropic doesn’t offer Claude in {region}.` with Check Again (the `checkRegion` action drew nothing before). Claude Code row: `{version} · Region not supported` (amber), no usage and no `Next:`, Check Again in Sign In's place — a press of its own inside the row. Engines footnote: the machine note, `Supported regions`, the check line (`Checked 2m ago · …`). | `management/RunnerPage.kt`, `RunnerScreens.kt` |
| Claude Code page | Accounts kept as they are, each saying its sign-in alone: no quota line, no NEXT, no Sign In / Sign In Again / Renew, no signed-out note; Check Again in Add Account's place; the note in the footer; `Region not supported` in the head. | `RunnerScreens.kt` `RunnerEnginePage`, `AccountRow` |
| Provider menu, engine list | Under Claude Code, the engine's own sign-in, Claude pools and Anthropic-preset keys read `Region not supported` and name no fix (their press still opens the machine's Claude Code page); no Claude accounts under the sign-in, whose Provider value is its own name. The engine row greys only when no credential can run Claude Code. Claude only; a runner with no `region` lists what it lists today. | `composer/ComposerData.kt` (`ComposerCatalog`), `SessionComposer.kt` |

New words live in core's `ClaudeRegionCopy`, each held by `ClaudeRegionCopyParityTest` to the web declaration of the same name
and to OrbitKit's (plus the shared writers in `src/shared/src/claude-region-check.ts`, `dto.ts`, `claude-regions.ts`, and the web
and Swift card's feet). The attention item's two words moved from `RunnerCopy` to `ClaudeRegionCopy`, their one home now. The
runner pages say `Check Again` (title case, as board 03 and iOS draw the page's presses); the card says `Check again`, as the web,
iOS and board 03. Two web declarations have no Android surface and are named web-only in the parity test: `claudeRegionAccounts`
(a grouped head counting accounts) and `CLAUDE_REGION_DETAILS` (the new-session hero's link; Android's new session has no hero line,
its engine list says the reason).

## The device, beside board 03

`compare/` puts board 03's phone screens (cut from `03-ios-terminal.png` at (124, 404)–(909, 2107) and (1006, 404)–(1791, 2107),
the iOS kit's boxes) beside the Android ones; `device/` holds every picture of the run, each journey's `checks-*.txt` (a PASS line per
check) and the requests it made.

| Picture | What it shows |
| --- | --- |
| `compare/1-card.compare.png`, `device/1-card.png`, `compare/1b-card-close.png` | The held conversation: the card word for word, the check line on two lines, the presses in the card's order, no coded line in the transcript. |
| `device/2-card-after-check-again.png` | After Check again: the fixture logged the POST (`requests-checkAgainOnTheCard.txt`) and the check line moved to the new check (10:13 → 10:15). |
| `device/3-use-another-provider.png`, `device/3b-after-deepseek.png` | Use another provider offers DeepSeek and Local vLLM only; DeepSeek PATCHed `"provider":"deepseek","engine":"claude"` (`writes-useAnotherProvider.txt`). After the pick the composer's note reads `Your next message uses DeepSeek.` and the check line stays whole. |
| `device/4-move.png` | Move to another machine opens the session's Move. |
| `device/5-provider-menu.png` | The composer's Provider menu: On HPC ✓ Default, then DeepSeek, `Personal Max — Region not supported`, `Work — Region not supported`, Local vLLM — board 02 C's rows; no accounts, no fix arrow. |
| `device/6-session-list.png` | The list row: `Anthropic unavailable on HPC`; the two parked sessions keep their words. |
| `compare/7-machine-page.compare.png`, `compare/7b-machine-engines-note.compare.png` | HPC's page: the attention item with Check Again, Claude Code `2.1.302 · Region not supported` with Check Again, Codex (5h 12%), Kimi Code and Antigravity CLI signed in, the note and the check line. |
| `device/7c-machine-after-check-again.png` | The Claude Code row's Check Again posted, and the page read the check it asked for (`Checked just now`). |
| `device/8-claude-code-page.png` | Claude Code's page: three accounts signed in, Check Again where Add Account was, the note under them. |

Where the real screens differ from board 03, and why:

- **Presses.** The board drew Use another provider and Check again side by side, with Move to another machine under them; iOS fits
  Use another provider and Move to another machine on one row. Android's Material buttons (48 dp tall, the app's type scale) don't
  fit two of these labels in a 411 dp phone's card, so each takes its row — in the card's order, which is also its reading order.
  The board's note asks for the same card and words as the web, wrapping where they don't fit.
- **Header.** The board drew `Anthropic unavailable on HPC · Open` under the title. Android's session bar names no session since
  A06-18 (as iOS's console since 2026-10-15); the words show in the list row (6).
- **Check line.** `Checked HH:mm · Claude’s connection: mainland China (no proxy)` is the contract's copy of record (web, iOS); the
  board's line left out `Claude’s connection:`.
- **Machine page.** The attention item carries Check Again (the web runner page draws Check again for `checkRegion`; the board
  drew a chevron). The footnote is the contract's machine note and check line, not the board's shorter sketch of it, and it sits
  under the section's own Update Engines Now and Refresh Model Lists. Android's engine rows have no logos, and Capacity is the
  page's own — both as before this task.
- **Use another provider.** The web opens the composer's model menu at its Provider level; Android, like iOS, lists the same
  credentials in the card's own dialog.
- **The transcript and composer** are Android's own styles (the `You · Copy message` turn, the composer's model chip, which shows
  the model as the session stores it); nothing of them changed here.

## A runner with no region draws what it draws today

Every surface reads the runner's `region` and does nothing without a blocked one. The tests assert it surface by surface, on the
same fixtures with `region` absent and with an allowed one:

- `ClaudeRegionSurfacesTest`: the Provider rows and engine list equal today's lists (`credentials`, `engines` compared whole); the
  sign-in's Provider value is still `Automatic`; `engineStatus`, `canSignIn`, `canAddAccount`, `needsSignIn`, `accountWindows` and the
  machine's whole attention list are today's.
- `ClaudeRegionRunnerPageTest.aMachineThatReadsNoRegionDrawsWhatItDrawsToday` / `claudeCodesPageOnAMachineThatReadsNoRegionIsTodays`:
  no item, no Region not supported, no Check Again; Sign In, the usage window, the Engines footer and Add Account as before.
- `ClaudeRegionShellTest.aRunnerThatReadsNoRegionDrawsWhatItDrawsToday` and `anotherQueuedSessionStaysQueued`; core
  `ClaudeRegionTest.aRunnerThatNoLongerReadsBlockedKeepsTheServersWordsWithoutTheCode`.
- The main-baseline runs below: every existing test of the suite passes unchanged.

## Tests

Android unit suites on git archives with `kit/android.sh` (`:core:test :app:testDebugUnitTest`, CI's android.yml test step, on
the HPC runner):

| Run | Tree | Result |
| --- | --- | --- |
| main | `1f71c0fb7` — main today, whose tree is this branch's base (`74ad5249a`, the project line with the iOS task) | `:app:testDebugUnitTest` 2031 tests, `:core:test` 310 tests, 0 failures |
| main | `dabde245d` — main before the iOS task's merge, the first baseline | 2031 and 310 tests, 0 failures |
| **this branch** | **`044051810`** — also main + this branch: the trial merge with `1f71c0fb7` has the same tree | **`:app:testDebugUnitTest` 2060 tests, `:core:test` 336 tests, 0 failures**; `:app:lintDebug` 0 errors (44 warnings and 2 hints, none on a line this task changed); `:app:compileDebugAndroidTestKotlin` compiles the device journeys |

The 29 new app tests and 26 new core tests are every one of the difference; every existing test passes unchanged.

| New tests | Where | What they cover |
| --- | --- | --- |
| `ClaudeRegionTest` (17) | core | The rules (OrbitKit's `ClaudeRegionTests`, the web's `claudeRegion.test.ts`): only a blocked verdict gates; a region error by its code alone; the transcript's lines, a machine named like the stopped sentence still a refusal; held and its words; Anthropic-bound credentials; Check again's answer and timing. The card (`RunNeverStartedCard.region.test.tsx`): words, link, lines, presses and their order, proxy wording, weekday, UA-43, the place never read from the sentence, the fallback, the cause before every pattern whatever the machine is called, the ended foot, no card for a stopped turn. |
| `ClaudeRegionCopyParityTest` (9) | core | Every `ClaudeRegionCopy` word against `claudeRegionCopy.ts` and `ClaudeRegionCopy.swift`; the body against the shared refusal writer, the stopped shape against `claudeRegionStoppedError`, the code, the page and the Anthropic preset against shared; the card's feet against `RunNeverStartedCard.tsx` and `SessionRunStart.swift`; every web declaration ported or named web-only, and no Kotlin word without a counterpart. |
| `ClaudeRegionSurfacesTest` (14) | app | The Provider rows and engine list (`sessionProviderChoices.test.ts`' region block): Anthropic credentials Region not supported, other keys nothing; the region outranks Not installed and Not signed in; Claude only; null and allowed list today's rows; the engine row pickable while another credential runs it, greyed only when none can. The machine page (`RunnerEngines.claudeRegion.test.tsx`): the row's state, no usage, NEXT, sign-in or Add Account; the note and check line; null and allowed draw today's page. The transcript (`Transcript.claudeRegion.test.tsx`). A held list row. |
| `ClaudeRegionShellTest` (9) | app | The production Activity over a controlled server (Robolectric): the card on the real session page, words and presses in order, no coded line, no "ended without a reply"; the check line two lines tall at 411 dp (native graphics); Check again POSTs and reads the runner again; Use another provider lists DeepSeek and Local vLLM, PATCHes `provider` with the engine kept, and the note says `Your next message uses DeepSeek.`; Move opens Move; the Provider menu's rows; the list row; a runner with no region; another queued session stays Queued. |
| `ClaudeRegionRunnerPageTest` (5) | app | The machine page and Claude Code's page over `ManagementFixture`: the item and row with Check Again (each POSTs, the press held until the check is back), no Sign In, usage or Next, the note in place of the engines footer; the engine page's accounts with Check Again in Add Account's place; both pages unchanged without a region. |
| `ComposerModelTest.aProviderPickOnAHeldSessionSaysTheWaitingMessageRunsOnIt` (1) | app | The review's item 1: held → `Your next message uses DeepSeek.`; an ordinary queued session keeps `The turn in flight finishes on Claude Code. Your next one uses DeepSeek.` |
| `ClaudeRegionDeviceTest` (8 journeys) | androidTest | The pictures above, each with its checks (`device/checks-*.txt`): on emulator-5554, API 36, `OK (8 tests)` in 63.5 s (`device/summary.tsv`, `device/instrumentation-result.txt`), APKs built from `044051810` (`device/apks.sha256`). |

Also run: the web's `copyLanguage.test.ts` (no new Chinese literal in product code) on an archive of `044051810`: 2 tests passed.

## Running it again

- `kit/android.sh <label> <rev> [tasks…]` runs the Android unit suite on a git archive of a revision (build dirs on /mnt/data,
  a capped scope, JUnit summaries through `kit/summary.py`); `kit/dev.sh <tasks…>` runs Gradle on the working tree the same way.
- `kit/device.sh <out>` takes the shared emulator's `ui.lock` (starting the emulator only if it is down) and runs
  `ClaudeRegionDeviceTest` through `src/android/scripts/increments-device-test.sh` with the APKs `kit/dev.sh :app:assembleDebug
  :app:assembleDebugAndroidTest` built. `kit/compose.py <board> <shots> <out>` writes the comparisons and the card close-up.
- Paths in the kit are this machine's.
