# T7: sessions, tasks and workspaces pick the engine, then a provider it runs (web)

Task `34cdPiBI3subOUxofeupy`, project `34ccMg4EoSorpVooMC4kg`. The design is the owner-confirmed T0 boards 4–8 in
`docs/mocks/provider-engine-decoupling/` (T0 commit 7a1908198, on the project line as bea036c3b). The data comes from
T3: `engine` on sessions and tasks, `lastEngine` on workspaces, and `engines` on every `/providers` row.

Each PNG puts the board's "after" frames (left) next to the real web console (right), one row per scene, at 1x,
once in light and once in dark.

| File | Screens | Board |
| --- | --- | --- |
| `4a-new-session-engines-*.png` | The hero's engine list (DeepSeek Harness picked); the list on an account with no DeepSeek key | 4 ① and ⑥ |
| `4b-new-session-providers-*.png` | The Provider menu under DeepSeek Harness, Claude Code and OpenCode | 4 ③ ④ ⑤ |
| `5-composer-switch-*.png` | A DeepSeek Harness session moving to DeepSeek 2; the note; the menu title; a session whose key was deleted | 5 ①–④ |
| `6-task-pin-*.png` | Engine; Provider under DeepSeek Harness; pinned; Provider under Claude Code; a pin T4 migrated | 6 ①–⑤ |
| `7-workspace-engines-*.png` | "Engines it may use" and the model line for orbit and builds | 7 ①–③ |
| `8-repair-cards-*.png` | No DeepSeek key (and the run-never-started card); DeepSeek rejected "DeepSeek 2"; Claude Code on the DeepSeek key, rejected | 8 ①–③ |

`capture-log.txt` is the capture run's own log: the tree it built, every shot, the texts read off the page, the
task-pin writes it sent, and any request the fake API left unanswered.

The capture on the merge of T6 (bd0ce46f1) matched the capture before it (528923b14) in 76 of 78 raw shots, pixel
for pixel, and in every text read off the page. The two that differ are the builds workspace's editor, light and
dark, where the text's anti-aliasing moved (no channel more than 16 of 255). So `7-workspace-engines-*.png` is
made from bd0ce46f1, and the other composites still name 528923b14. The last capture ran on the merge of the
project tip (8e3a5c008: T4, main, T6). All 78 raw shots are pixel-identical to bd0ce46f1's. Its log, the one
here, differs only in one read the fixtures now answer (`GET /api/auth/capabilities`).

## How the screens were made

- `kit/run.sh` builds this branch's web app with `vite build` (no dev server) and runs `kit/capture.mjs`. The
  capture script serves the build from a small Node server and drives Playwright's Chromium 1.63 through each scene
  by clicks: the hero's engine list, the composer's model menu and its Provider level, the task's Engine, Provider
  and Model fields, a workspace row on the runner page. It signs in through the repo's
  `src/web/ui-migration/fixtures.mjs` and answers the reads from `kit/data.mjs`: T6's account (the runner hpc, two
  DeepSeek keys, Gemini, Kimi and GLM keys, a Claude subscription token, a Claude account pool), the workspaces
  orbit (last on Claude Code with the DeepSeek key) and builds (last on DeepSeek Harness with DeepSeek 2), and one
  session or task per scene.
- The same browser renders the boards with the same fonts (Inter and Noto Sans SC through
  `/mnt/data/pe-mock/fonts.conf`) and takes each scene's "after" frame.
- `kit/compare.py` sets each pair side by side.

To repeat: `kit/run.sh <out>`, then `python3 -I kit/compare.py <out> <dir> <commit>`. The scripts carry this
worktree's absolute paths.

## Found by the capture and the review, fixed on this branch

- The task pin listed no account pools under Claude Code (board 6 ④): the panel never read them. It now reads the
  user's pools and the shared pools they are in, as the composer does
  (`TaskDetailPanel.modelRouting.test.tsx` covers it).
- The hero's engine list, 244px wide, cut "OpenCode" and "DeepSeek Harness" short beside their models. It now has
  the width board 4 ① draws.
- The OpenCode Provider menu drew the Gemini key with Antigravity's "A"; board 4 ⑤ draws Google Gemini's star. A
  Gemini key now wears Gemini's mark: T6's change to the same lines of `sessionProviderChoices.ts`, carried byte
  for byte, so the two land as one.

## Where the page differs from the boards

- Board 4 ①: the board draws a 600px pane; the console's pane fills the 1000px window, so the hero sits lower.
  Claude Code's row reads "DeepSeek V4 Pro", not "Opus 5.5". Each row previews the model of the
  credential the draft would land on, and orbit last ran Claude Code on the DeepSeek key. On the account with no
  DeepSeek key (⑥) the row reads Opus 5.5.
- Boards 4 and 5: the menus are the composer's AntD menus. The Provider level opens to the left of the model menu,
  because the chip sits at the window's right edge; the boards draw it on the right. The Claude Code menu keeps its
  Speed row, because Opus 5.5 has a fast lane. Each picture also holds the chip that opened the menu, and whatever
  of the page lies behind the box.
- Board 5 ②: the note is the composer's own line above the input. It is shown on an ended session whose task has a
  newer run going (the second session in `kit/data.mjs`), which is when it says "The turn in flight finishes on…".
  The board draws it as a hand-off strip.
- Board 5 ④: the deleted key is named by its slug, `deepseek-harness`, on a letter tile. The session stores only the
  slug, and a deleted key is gone from `GET /providers/mine`, so nothing is left to name it by. The board draws the
  key's old name.
- Board 6: Engine, Provider and Model are the house Combobox, which opens as a search field over the value. The
  Details section keeps its Start at, Created by and Created rows. In ③ the model is pinned through the Model field,
  a third write. The log lists every write: the engine (model cleared); the engine with DeepSeek 2; the model; then
  Claude Code, which keeps DeepSeek 2 because Claude Code runs it, and clears the model; then Engine default.
- Board 7: the model name is in the console's monospace, as today.
- Board 8: the generic card keeps today's quote of the runtime's message, and the re-send block under its button;
  each turn's time shows under its card. The run-never-started card, below ①, uses the same sentences.
- The fake API leaves one read unanswered: the release task's `GET /api/tasks/:id/owner-confirmation` (that task
  is not owner-confirmed).
