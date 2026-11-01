# Claude region check: iOS and macOS, against board 03

Evidence for task "Region check: iOS and macOS" of project "Claude region check" (docs/claude-region-check-contract.md,
design of record docs/mocks/claude-region-check). The native side follows the landed web task's copy and rules
(docs/evidence/claude-region-check-web/README.md, "Rules the iOS and Android tasks can follow"). Every picture here is
the real iPhone app — its own `CompactShell` and Settings sheet built from this branch's sources — on an iPhone 17 Pro
simulator, fed `probe-harness/stub.py`.

Code: 9639900f7 (the feature), d43f4cf24 (no Claude accounts under a blocked sign-in in the Provider menu), f26e3b6a2
(the card's presses in the app's `FlowLayout`).

## What each surface does

| Surface | iOS and macOS | Where |
| --- | --- | --- |
| Session card | Cause read off `CLAUDE_REGION_UNSUPPORTED: `, before any cause read by pattern. Why `Claude Code can’t use Anthropic on {machine}`; body = the §9 sentence without its code, then `Supported regions`; lines `CLAUDE_REGION_UNSUPPORTED · {regionCode ?? country}` and `Checked {HH:mm, or weekday HH:mm} · Claude’s connection: {name} (no proxy \| through a proxy)`; presses Use another provider (filled) · Move to another machine · Check again; foot `No engine ran · your message is still here`, or `Ended · no engine ran · 0 turns` from a control plane that predates the hold. With `region` nil or no longer blocked: the server's words without the code, the bare code, no check line. A stopped turn on a failed or parked session draws no card. | OrbitKit `SessionRunStart`, `ClaudeRegion`, `ClaudeRegionCopy`; OrbitApp `SessionRunStartCard`, `ConsoleModel` |
| The card's presses | Wrap in the app's `FlowLayout`, in the card's order. Use another provider lists the credentials the session's Claude Code can move to here (`.orbitConfirmation`: an alert on a phone) and PATCHes the provider; drawn only where one exists. Move to another machine opens the Move panel (iOS). Check again posts `/runners/:id/region-check`, then reads the runner every 2 s until `region.checkedAt` reaches the request, up to 30 s; drawn only where `region` is not nil. | `SessionRunStartCard`, `ConsoleView.openMove`, `ConsoleModel.checkRegionAgain` |
| Transcript | A refusal draws no line, and its turn counts as answered; the stopped sentence draws without its code. No working indicator over a held message. | `TranscriptReducer.appendError`, `ConsoleModel.showWorkingIndicator` |
| List row and header | `Anthropic unavailable on {machine}` in the list row, the row's VoiceOver value, the Mac row's glyph tip and the Mac console's status bar. | `SessionLine`, `SessionHeader`, `SessionStatusGlyph`, `AgentsModel.machineName` |
| Machine page | Needs Attention: `Claude Code can’t use Anthropic here` / `Anthropic doesn’t offer Claude in {region}.` with Check Again (the `checkRegion` action, as the web runner page draws it). Claude Code row: `{version} · Region not supported` (amber), no usage and no `Next:`, Check Again in Sign In's place, a press of its own beside the row's push. Engines footnote: the machine note, `Supported regions`, the check line. | `RunnerPageFormat`, `RunnerPageParts`, `SkillsRunnersView`, `RunnersModel.checkRegion` |
| Claude Code page | Accounts kept as they are, each saying its sign-in alone: no quota line, no NEXT, no Sign In / Sign In Again / Renew, no signed-out note; Check Again in Add Account's place; the note in the footer; `Region not supported` in the head. | `RunnerEnginePage` |
| Provider menu, engine list, hero | Under Claude Code, the engine's own sign-in, Claude pools and Anthropic-preset keys read `Region not supported` and name no fix (their press still opens the machine's Claude Code page); no Claude accounts are offered under the sign-in. The engine row greys only when no credential can run Claude Code; the hero then says `Region not supported on this runner · Details`. Claude only; a runner with no `region` lists what it lists today. | `SessionProviderChoices`, `ComposerView`, `AgentIdentity`, `AgentsView` |

New words live in OrbitKit's `ClaudeRegionCopy`, each held to the web declaration of the same name in
`src/web/src/lib/claudeRegionCopy.ts` (and the shared writers in `src/shared/src/claude-region-check.ts`, `dto.ts`,
`claude-regions.ts`). `RunnerPageCopy` is untouched: its names match runnerCopy.ts one to one. The runner pages say
`Check Again` (their presses are title case, as board 03 draws it); the card says `Check again`, as the web and board 03.

## The iPhone, beside board 03

`compare/` puts board 03's phone screens (cut from `03-ios-terminal.png` at (124, 404)–(909, 2107) and (1006, 404)–
(1791, 2107)) beside the real ones; `ios/` holds every picture of the run. Shots run
[41253857258](https://github.com/jianghailong-xy/orbit/actions/runs/41253857258), probe commit 706a0d690 = f26e3b6a2 +
`.rgn-probe/`: 8 tests, 0 failures.

| Picture | What it shows |
| --- | --- |
| `compare/ios-01-card.compare.png`, `ios/ios-01-card.png`, `ios/ios-01b-card-close.png` | The held conversation: the card word for word, two rows of presses, no coded line. |
| `ios/ios-02-card-after-check-again.png` | After Check again: the stub logged the POST and the check line moved to the new check. |
| `ios/ios-03-use-another-provider.png`, `ios/ios-03b-after-deepseek.png` | Use another provider offers DeepSeek and Local vLLM only; DeepSeek PATCHed `provider: deepseek` (`ios/writes.txt`). |
| `ios/ios-04-move.png` | Move to another machine opens the Move panel. |
| `ios/ios-05-provider-menu.png` | The composer's Provider menu: On HPC Default (current), then DeepSeek, `Personal Max — Region not supported`, `Work — Region not supported`, Local vLLM — board 02 C's rows. |
| `ios/ios-06-session-list.png` | The list row: `Anthropic unavailable on HPC`. |
| `compare/ios-07-machine-page.compare.png`, `compare/ios-07b-machine-engines-note.compare.png` | HPC's page: the attention item, Claude Code `2.1.302 · Region not supported` with Check Again, Codex/Kimi Code/Antigravity CLI signed in, the footnote. |
| `ios/ios-07c-machine-after-check-again.png` | The Claude Code row's Check Again posted and stayed on HPC's page (`Checked just now`). |
| `ios/ios-08-claude-code-page.png`, `ios/ios-08b-claude-code-page-note.png` | Claude Code's page: three accounts signed in, Check Again, no Add Account, the note. |

Where the real screens differ from board 03, and why:

- **Presses.** The board drew Check again beside Use another provider. On the phone the real buttons are narrower than
  drawn, so Use another provider and Move to another machine share the first row and Check again wraps. The board's
  note asks for the same card and words as the web, wrapping where three don't fit: the presses keep the web card's
  order, which is also their reading order.
- **Header.** The board drew a title with `Anthropic unavailable on HPC · Open` under it. The iPhone console has had no
  title or status line since 2026-10-15 (owner); the words show in the list row (06) and as the row's VoiceOver value.
  The Mac console's status bar says them (`SessionHeader.subtitle`, unit-tested).
- **Check line.** `Checked 13:53 · Claude’s connection: mainland China (no proxy)` is the contract's copy of record and
  the web's; the board's line left out `Claude’s connection:`. It takes two lines on a phone.
- **Machine page.** The attention item carries Check Again (the web runner page draws Check again for `checkRegion`;
  the board drew a chevron there). The footnote is the contract's machine note and check line, not the board's
  shorter sketch of it. Capacity, Update Engines Now and Refresh Model Lists are the page's own, which the board left out.
- **Use another provider.** The web opens the composer's Provider menu at its Provider level; a SwiftUI `Menu` can't
  be opened from code, so the card's press lists the same credentials the menu offers to move to.

## Tests

| Run | Where | Result |
| --- | --- | --- |
| OrbitKit `swift test`, swift:6.1 (ci.yml's Swift core), `kit/archsuite.sh` on git archives | main aaf0ab585 | 4274 tests, 5 skipped, 0 failures |
| | main + this branch (trial merge 886d9af6c, clean) | 4315 tests, 5 skipped, 0 failures |
| | branch d43f4cf24 / f26e3b6a2 | 4315 tests, 5 skipped, 0 failures |
| client.yml, dispatched on `probe/region-check-apple-gates` = f26e3b6a2 | run [41253865283](https://github.com/jianghailong-xy/orbit/actions/runs/41253865283) | all jobs success (below) |
| ci.yml, same commit | run [41253867132](https://github.com/jianghailong-xy/orbit/actions/runs/41253867132) | all jobs success; Swift core 4315 tests, 5 skipped, 0 failures |
| android.yml, same commit | run [41253869632](https://github.com/jianghailong-xy/orbit/actions/runs/41253869632) | `:core:test` 310 and `:app:testDebugUnitTest` 1974 tests, 0 failures |
| client.yml on the feature commit 9639900f7 | run [41251746236](https://github.com/jianghailong-xy/orbit/actions/runs/41251746236) | all jobs success |

client.yml 41253865283, from its job logs:

- **macOS (build + test)**, job 124692794776: OrbitKit on macOS "Executed 4315 tests, with 5 tests skipped and 0
  failures"; OrbitApp `swift build` compiled every file this task touched ("[424/488] Compiling OrbitApp
  SessionRunStartCard.swift", "[412/465] Compiling OrbitApp SkillsRunnersView.swift", "[461/488] Compiling OrbitApp
  RunnerEnginePage.swift", ConsoleModel, ConsoleView, ComposerView, AgentsView, AgentIdentity, AgentsModel,
  RunnersModel, RunnerPageParts), "Build complete! (231.76s)".
- **iOS (generate + build)**, job 124692794670: "SwiftCompile normal arm64 …/Views/Console/SessionRunStartCard.swift",
  the same for SkillsRunnersView, RunnerEnginePage and RunnerPageParts, then "** BUILD SUCCEEDED **".

New and changed OrbitKit tests:

- `ClaudeRegionTests` (30): the rules (`claudeRegion.test.ts`), the card (`RunNeverStartedCard.region.test.tsx`: words,
  proxy, weekday, UA-43, the place never read from the sentence, the fallback, the cause before every pattern, the
  ended foot, the stopped turn), the held words in the list, header and glyph, the pickers
  (`sessionProviderChoices.test.ts`'s region block), the machine page and its note, and the transcript's lines.
- `ClaudeRegionCopyParityTests` (11; 8 new): every `ClaudeRegionCopy` word against `claudeRegionCopy.ts`, the body
  against the shared refusal writer, the stopped shape against `claudeRegionStoppedError`, the code, the page and the
  Anthropic preset against shared, the card's feet against `RunNeverStartedCard.tsx`, and every web declaration either
  ported or named web-only (`claudeRegionAccounts`).
- `WatchWiringTests.testTheHeaderRowAndGlyphAreHandedTheWatch` now also asserts the glyph is handed the machine.

Android reads some of the Swift files this task changed (`SessionLineCopyParityTest`, `AccountCopyParityTest`,
`InfrastructureCopyParityTest`, `PendingTrayCopyParityTest`, `DrawerCountTest`); android.yml above ran them green.

## Running it again

- `kit/swiftdev.sh <label>` runs OrbitKit's suite on a copy of a working tree; `kit/archsuite.sh <label> <rev>` on a git
  archive of a revision. Both keep `.build` on /mnt/data. Paths in the kit are this machine's.
- `kit/mkprobe.sh <rev> probe/region-check-apple` builds the probe commit in a temporary index and pushes it; a push
  runs `probe-harness/client.probe.yml`, whose report job pushes the pictures to `probe/region-check-apple-results`.
  `kit/compose.py <shots> <out>` cuts the card close-up and writes the comparisons. `kit/stubcheck.sh` reads the stub
  locally.
