# A runner's Default removed from Orbit on iOS / macOS: evidence

Task 34jpFWOnhGsjNrBGIKi9V, project 34jjcdca6uuW0qHCjTdKg, criterion 5: on the runner engine page,
Default offers the same Remove as the web (menu and swipe), with the same confirmation, removed state
and way back, in the web's words (`src/web/src/lib/runnerAccountCopy.ts`). The server is S1/S2/S3
(c0e3df734, c971ac1c1, a7fee52d8) and the web is dc37aa340. Their frames are in `../web/screenshots`.

## What iOS and macOS do

- **Offer it.** Default's swipe and long-press menu offer Remove while another account of that engine
  stays on the runner. An account whose removal is pending or done doesn't count, and Default alone is
  offered none (`RunnerPageFormat.offersRemove`). Default's Remove stays enabled offline, because it
  only changes Orbit's own record (`canRemove`). An added account's still needs the machine.
- **Ask first.** The question is `Remove {name}?`, and the body is `runnerDefaultRemoveDetail(runner,
  CLI)`: "Orbit stops using it on HPC. Its sign-in stays on the machine, and Codex in a terminal there
  keeps working. Workspaces set to it run on Automatic."
- **The removed state.** While the engine carries `removedDefault`, every remaining account gets its own
  line, even when only one remains. Each line has its own sign-in, windows, menu and NEXT. The section
  ends with `Default · ~/.codex isn’t used by Orbit` (renamed Defaults by their name) and Use again,
  which posts `…/default/restore`, offline too, and stays busy until the list read after it. Add
  Account follows.
- **Summaries elsewhere.** The runner page's engine row names the account that remains ("Next: Work")
  and shows its window, never Default's. NEXT and Automatic's pick use shared `accountToStartOn`'s
  `defaultRemoved` option (`CodexAccounts.toStartOn`).
- **Removing an added account while Default is removed.** The text says
  `runnerAccountRemoveDetailAutomatic`, or `runnerAccountRemoveDetailLast` when it is the last account
  Orbit uses there. It never says "run on Default". While Default is in use, an added account's question
  is the page's own, unchanged.
- **The composer.** The coordinator asked for this, outside the criterion's words.
  `CodexAccounts.onRunner` lands no pick, a pick of Default, or an unreported slot on Automatic's pick
  among the remaining accounts, unless the workspace env decides. `automaticOffered` counts a workspace
  set to Default as Automatic. `ConsoleModel.account(for:)` and `automaticOffered` pass the engine's
  `removedDefault`.

## Results

### OrbitKit `swift test` (Linux, swift:6.1 docker)

`docker run --rm --memory=6g -v <worktree>:/w:ro -v /mnt/data/i5dr-orbitkit/sb:/sb -w /w/src/macos/OrbitKit
swift:6.1 swift test --scratch-path /sb`

| tree | tests | failed |
|---|---|---|
| this branch, 30cd0288c (clean tree) | 4067 (5 skipped: PerfBaselineTests) | 0 |
| 30cd0288c merged with main 5225868c9 (S3 landed) | 4067 (5 skipped) | 0 |

New suites:
- `RunnerDefaultRemovedTests` (17): offer, offline, both questions, the removed state with one and two
  accounts, a renamed Default, NEXT and the runner row, never "run on Default".
- `RunnerAccountCopyParityTests` (3): one to one with runnerAccountCopy.ts. The two `ACCOUNT_SELECT_*`
  sentences are listed as the web's alone, because iOS has no workspace account field.
- `RunnerDefaultRemovalAPIClientTests` (3): DELETE …/default, POST …/default/restore, and the refusal.
- Three new `CodexAccountsTests` cases ported from shared planUsage.spec.ts and S3's account rule.
- `InfrastructurePageWiringTests.testDefaultIsRemovedFromOrbitAndUsedAgain`.

### client.yml on macOS and iOS

Dispatched on `probe/default-removal-ios`, which is this branch plus one probe-only commit. That commit
adds a `default_removal_probe` input and a job to `.github/workflows/client.yml`; the gate jobs are
unchanged. The command was `gh workflow run client.yml -R jianghailong-xy/orbit --ref
probe/default-removal-ios -f default_removal_probe=true`.

| run | commit | macOS (OrbitKit `swift test` + OrbitApp `swift build`) | iOS (Simulator build) | iPhone probe + OrbitApp build on its own |
|---|---|---|---|---|
| [39655820494](https://github.com/jianghailong-xy/orbit/actions/runs/39655820494) | 096149e68 (8cc07dd6a + probe) | success | success | success: 13/13 UI tests, `Build complete!` |
| [39651416510](https://github.com/jianghailong-xy/orbit/actions/runs/39651416510) | 362557d63 (30cd0288c + probe) | success | success | 12 tests: 11 passed; OrbitApp build success |

In the first run, the offline test long-pressed Work right after putting Default's menu away, and Work's
row was "Not hittable". That was a harness fault: 8cc07dd6a gives each menu a launch of its own, and
the second run's 13 pass. The product code is the same in both runs. Font tokens and Navigation passed
in both.

`probe-results/` holds the second run's own output:
- the UI tests' summary and the notes beside each picture;
- the writes the app sent (one DELETE …/codex/default after Remove was confirmed; a POST
  …/default/restore for each Use again);
- the macOS OrbitApp build's tail;
- the outcomes.

### The screens

The app's own CompactShell and Settings sheet, built from this branch's shared sources on GitHub's
`macos-26` runner (iPhone simulator, iOS 26) and driven by XCUITest against `probe-harness/stub.py`.
Downscaled from 3x to 2x. The machine is HPC, and its Codex accounts are Default, Work and Personal.

| screen | what it shows |
|---|---|
| `ios-01-default-menu-remove.png` | Default's long-press menu: Rename…, Sign In Again, Pause…, then Remove… as the danger |
| `ios-02-confirm-remove-default.png` | "Remove Default?" with the web's body; nothing sent yet |
| `ios-03-removed-two-accounts.png` | **removed state**: Work (NEXT) and Personal each with their own state and windows, then "Default · ~/.codex isn’t used by Orbit" and Use again |
| `ios-04-removed-one-account.png` | **removed state, one left**: Work as a row of its own with NEXT, then the line and Use again |
| `ios-05-runner-page-codex-next-work.png` | the runner page: Codex "Signed in, Next: Work", Work's weekly window |
| `ios-06-use-again-default-back.png` | after Use again: Default listed again |
| `ios-07-remove-personal-automatic.png` | Personal's question while Default is removed: "…run on Automatic." |
| `ios-08-remove-work-last-account.png` | the last account's question: "…Orbit uses Default there again…" |
| `ios-09-default-swipe-remove.png` | Default's swipe: Pause, and Remove outermost |
| `ios-10-default-alone-menu.png` | Default alone: no Remove… |
| `ios-11-offline-default-menu.png` | the runner offline: Default's Remove… enabled |
| `ios-12-offline-work-menu.png` | the runner offline: Work's Remove… greyed |
| `ios-13-offline-removed.png` | the removed state offline: Use again enabled (it then brought Default back) |
| `ios-14-removed-two-accounts-dark.png` | the removed state in dark |

Not photographed: the Mac. It has the same views in its own drawing, and the macOS jobs above compiled
them in both runs.

## Android parity

Android's `AccountCopyParityTest` reads RunnerPageFormat.swift and RunnerEnginePage.swift. All 30 of its
`AccountCopy` literals are still in them, checked by a script that reads them the way the test does.
The parallel Android task (34jpFWQkUfxoS2HX9X7N1) was told which literals moved and where the new
words are.
