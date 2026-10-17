# A watched task's run session folds into that task's row

Task 34hIEi97xkVk0S4TDo5D8, the client half of design A on the board
`docs/mocks/watching-session-into-tasks/` (7cf74c6ea). The server half (eb3fb67fa) gives every
SESSION watch target `targetTask`, the task its session runs. Above the composer and in the
session's watching words, a session target that carries one now counts as a target on that task:

- Its eye goes on the task's row in the Tasks card. A task created elsewhere joins as an
  `elsewhere` row, named by its own title and pill.
- It no longer keeps a Watching strip, so a wait on tasks and their runs has none.
- An unchecked wait's line moves to the top of the opened Tasks list, and its eyes turn orange.
- The header word and the session list row count a task and its run session as one target, and
  name the one target left.

A session that runs no task (a child from `session_create`) stays in the Watching strip as before.
A server older than eb3fb67fa sends no `targetTask`, and everything reads as it did. Condition
sentences, the Following page, a watch's detail and the Followed by and Following relations still
say the watches as they were made.

## Pictures

Each `compare-*.png` puts the board's frame (re-rendered from `board.html` at 7cf74c6ea) on the
left and the real web page on the right.

| Picture | Board part | What the real page shows |
| --- | --- | --- |
| `compare-1-today.png` | ① today | Main before this change: a Watching strip for the run session, and the task's eye in Tasks |
| `compare-2-folded.png` | ② folded | This change: no Watching strip; Tasks reads `👁 1 · 1 running · 1/2 done` |
| `compare-3-opened.png` | ③ opened | The Tasks card opened: the task's row with one eye, first |
| `compare-4-elsewhere.png` | case a | A run of a task created elsewhere: before, a Watching strip named `Task: …`; after, an `elsewhere` row named by the task, with the task's pill |
| `compare-5-unchecked.png` | case b | The run-session watch unchecked for 12 minutes: orange eyes, and `Not checked for 12m — the resume may be late.` at the top of the opened list |
| `compare-6-words.png` | case c | The list row: `Watching 2 targets · 2 running · 0/2 done` → `Watching Android: tapping a notification opens the session it names`. The header: `Watching 2 targets` → `Watching 1 target` |
| `compare-7-child.png` | option A | A child session that runs no task: the Watching strip, the same before and after |

`web/` holds the real frames at 2x, and `web/words.json` the row and header text as the page drew
them.

## How the pictures were taken

`scripts/capture.mjs` serves two static builds of the web app (`vite build`): one from main
eb3fb67fa, one from this change. It opens the session page in Chromium (Playwright 1.63, 1280×900,
2x, en-US, UTC, Inter and Noto Sans SC). The page reads the repo's ui-migration fixtures
(`src/web/ui-migration/fixtures.mjs`) with the date fixed at 2026-09-28T12:00Z. Routes answer
`/api/watches`, the session, its transcript and `/api/sessions/:id/created-tasks` with the board's
sample data:

- a task_await on T, *Android: tapping a notification opens the session it names*;
- a session_await on T's run session, carrying `targetTask`, as the server sends it since eb3fb67fa;
- T and a done task, *Android: unread-reply badge on the session list*, created here.

Each scenario runs in a fresh browser. The real frames leave out the board's Background processes
tray and branch bar, which this change does not touch. `scripts/board-crops.mjs` cuts the board's
frames out of `board.html`, and `scripts/compose.mjs` lays them out side by side. The scripts are
kept as they ran, with the session worktree's and scratch paths in them.
