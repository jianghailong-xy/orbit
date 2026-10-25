# T8: iPhone and Mac pick the engine, then a provider it runs

Task `34cdPiDErJ3Zc2bsj7hcm`, project `34ccMg4EoSorpVooMC4kg`. The design is the owner-confirmed T0 boards iOS 1, 2, 4
and 5 in `docs/mocks/provider-engine-decoupling/` (T0 commit 7a1908198). The data comes from T3: `engine` on
sessions and tasks, `lastEngine` on workspaces, and `engines` on every `/providers` row. The Mac app draws the same
SwiftUI views; its build is checked below, its pages are not photographed.

Each PNG sets the board's "after" frame (left of a pair) beside the iPhone app on the simulator (right), at 1x, once
in light and once in dark.

| File | Screens | Board |
| --- | --- | --- |
| `ios1-infrastructure-*.png` | The overview (a key under every engine it runs on, OpenCode and DeepSeek Harness included); API keys by vendor with their engines; hpc's engines; DeepSeek Harness's page | iOS 1 ①–⑦ |
| `ios2-deepseek-key-*.png` | A DeepSeek key's page: the balance; Works with; the key (protocol, default model, endpoint); what turning it off stops | iOS 2 |
| `ios4-new-session-*.png` | The Engine sheet (DeepSeek Harness picked); the sheet with no DeepSeek key; the Provider menu under DeepSeek Harness, Claude Code and OpenCode | iOS 4 ①–⑤ |
| `ios5-session-provider-*.png` | A DeepSeek Harness session's Provider menu; a session whose key was deleted | iOS 5 ①–③ |
| `ios-more-*.png` | What the boards leave out of a frame: the page's top, the machines, the Engine sheet pulled up | iOS 1, 4 |

## How the screens were made

- The probe branch `probe/t8-engine-provider-shots` (never merged) is the delivered tree plus `t8-probe/` and a
  `client.yml` of its own, both kept here in `probe-harness/`. A push runs four jobs on GitHub: OrbitKit
  `swift test` and the OrbitApp `swift build` on macOS, the iOS app's own build, and `t8-probe/run.sh`, which builds
  the iPhone app's real shell and shared sources into a throwaway app and drives it with XCUITest on the newest
  iPhone simulator (iPhone 17 Pro). A report job pushes the pictures, the notes, the element trees and the request
  log to `probe/t8-engine-provider-shots-results`.
- The app is pointed (`-orbit.instance`) at `t8-probe/stub.py`, which serves the boards' account in the API's own
  shapes: the one T6's and T7's web captures serve (`../t6/kit/data.mjs`, `../t7/kit/data.mjs`) — three machines,
  two DeepSeek keys, Gemini, Kimi and GLM keys, a Claude subscription token, a Claude account pool, the workspace
  orbit on hpc, a DeepSeek Harness session and one whose key (`deepseek-harness`) was deleted. `POST /__set
  {"keys": "nodeepseek"}` takes the DeepSeek keys away for the second Engine sheet.
- Every screen is reached with the app's own presses: Settings → Infrastructure, hpc's row, DeepSeek Harness's row,
  a key's row; the hero's engine switch and a row of its sheet; the model chip and its Provider row (Default picked
  under Claude Code first, as board iOS 4 ④ draws it). Each test checks the words its board puts on the screen and
  fails when one is missing.
- `kit/render.mjs` renders the boards' frames with the fonts T7 used; `kit/compose.py` sets each pair side by side.
  To repeat: `node kit/render.mjs <mocks dir> <frames>`, then `python3 -I kit/compose.py <frames> <shots> <out>
  <commit>`, with the shots from the results branch's `t8-shots/ios/`. The scripts carry this worktree's absolute
  paths.

## Runs

| What | Where | Result |
| --- | --- | --- |
| The iPhone screens | Probe run #2954 ([38021734047](https://github.com/jianghailong-xy/orbit/actions/runs/38021734047)) on 4e1ecf4ea: 02ad2ad2d plus `t8-probe/` | 5 of 5 UI tests passed on an iPhone 17 Pro simulator (iOS 26.5); 32 pictures |
| OrbitKit `swift test` on macOS, the OrbitApp `swift build`, the iOS app's build | The same run; and the repo's own `client.yml`, dispatched on `probe/t8-engine-provider-gates` = 02ad2ad2d (Client CI #2955, [38021775622](https://github.com/jianghailong-xy/orbit/actions/runs/38021775622)) | 3643 tests, 5 skipped, 0 failures; both builds succeeded; font-token and navigation gates passed |
| The repo's CI | `ci.yml` dispatched on 02ad2ad2d (CI #2478, [38021773799](https://github.com/jianghailong-xy/orbit/actions/runs/38021773799)) | JavaScript (build, shared, apiserver, web), Go runner, Swift core, PostgreSQL specs 1–3 and container images all passed |
| OrbitKit on Linux (`swift:6.1` docker) | e1b585ced (the same Swift as 02ad2ad2d); T8 merged with origin/main d2405786e | 3643 tests, 5 skipped, 0 failures; 3652, 5 skipped, 0 failures (the project tip before T8: 3607, 5 skipped, 0 failures) |
| Android tests that read the Swift sources, and `ProviderEnginesTest` | 02ad2ad2d (T8 with T9 5730ff4ba) | 15 classes, 106 tests, 0 failures |
| The project's merge check, step by step | 7e35185aa (the same tree as 02ad2ad2d outside the two views 0ae7ec209 fixes and T9's Android), in a check tree on `/mnt/data` | build 0, shared 0 (438 tests), apiserver 0 (5145), web 1, go 0. Web's 1 is 22 test files whose vitest workers never started under the host's load ("Timeout waiting for worker to respond"); the 362 that ran passed (4573 tests). Those 22 files alone: 0 (486 tests). CI #2478 ran all 384 web files: 5059 tests passed |

Rounds #2919 (f93f3fe5e), #2935, #2941 and #2949 (e1b585ced) came before it: the first found the two layout bugs below,
the others the probe's own mistakes. Their results were force-pushed over; this one's are on the results branch.

## Found by the capture, fixed on this branch (0ae7ec209)

- API keys: under the new engines line, the row's `LabeledContent` ran its label wide and put a DeepSeek key's
  balance under the row. The row is laid out by hand now, its text wrapping beside the balance, as board iOS 1 ③.
- The Engine sheet cut "DeepSeek Harness" to "DeepSeek Har…" beside its model and tick on a 402-point phone. The
  engine's name keeps its width and the model gives way first.

## Where the app differs from the boards

- iOS 1: hpc's row says "3 of 4 signed in" and build-box's "2 of 4", where the board says "All signed in". In the
  boards' own data Kimi Code is not installed on either, and today's summary (`Infrastructure.summary`, the web's
  `summaryOf`) counts every engine that signs in; T6 notes the same of the web. The machine page keeps the quota bars
  under Claude Code and Codex, and DeepSeek Harness's page has no "checked … ago" (the fixture reports no check time).
- iOS 2: the section headings are the page's own style, the one "DeepSeek account balance" already had.
- iOS 4: the Engine sheet opens at its medium height, which ends at its sixth row; pulled up it shows the footer and
  "Switching is remembered as orbit's default." (`ios-more-*.png`). The model's name beside "DeepSeek Harness" can
  still shorten ("DeepSeek V…"), as it does in the board's own render at this width.
- iOS 4 ④ ⑤: an iOS menu opens down to the screen's bottom edge, so the Claude Code menu shows its keys down to
  DeepSeek 2, and OpenCode's ends with its note's first two lines. The rest are in the menu all the same: the tests
  read Z.AI (GLM) and Claude Max, and the whole note, from the element tree, which the results branch keeps beside each
  picture (`tree-menu-*.txt`). XCUITest's swipes do not scroll an iOS menu.
- iOS 5 ④: "Key deleted" and "Deleted" are in the menu's grey, not the board's orange: an iOS menu draws its items'
  subtitles in the system's colour and takes none of its own. The deleted key is named by its slug,
  `deepseek-harness`, as on the web (T7) and Android (T9): the session stores only the slug, and a deleted key is
  gone from `GET /providers/mine`, so nothing is left to name it by.
- On the Engine sheet VoiceOver reads OpenCode's row as "O, OpenCode, …": the letter tile standing in for its mark
  is read too. `ProviderMark` predates this task and is unchanged by it.
