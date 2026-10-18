# T6: the Infrastructure page after the provider/engine split (web)

Task `34cdPi9L702OkhoX4ia35`, project `34ccMg4EoSorpVooMC4kg`. The design is the owner-confirmed T0 boards in
`docs/mocks/provider-engine-decoupling/` (commit 7a1908198, confirmed 2026-10-09 10:47Z, choice A on all three
open points). The data comes from T3: `engines` on every `/providers/mine` row, and
`GET /providers/mine/:id/usage`.

Each PNG puts the board (left) next to the real web console (right), at 1x, once in light and once in dark.

| File | Screen | Board |
| --- | --- | --- |
| `00-page-*.png` | The whole `/infrastructure` page, at half size | 1 ① |
| `01-overview-*.png` | What your agents can run on: six engines, a key under every engine it runs on | 1 ① mark 1 |
| `02-machines-*.png` | Machines: DeepSeek Harness is the last row of a machine's card | 1 ① mark 2 |
| `03-keys-*.png` | API keys under their vendors, the engines of each key, balances kept | 1 ① mark 3 |
| `04-gallery-*.png` | The gallery: vendors only, by vendor name, counted by vendor | 1 ① mark 4 |
| `05-dsh-states-*.png` | DeepSeek Harness on hpc, old-mac, build-box and mac-studio, and the two Not set up cards | 1 ② |
| `06-connect-*.png` | Connect DeepSeek, reached at the retired `/providers/new/deepseek-harness` | 2 ② |
| `07-edit-*.png` | A DeepSeek key's page, with what uses it on each engine (choice A) | 3 ① and ② A |
| `08-dialogs-*.png` | Turning a key off, and deleting it: what uses it, engine by engine | 3 ② A |
| `09-refused-*.png` | An endpoint change the server refuses (`PROVIDER_DIALECT_IN_USE`), in its words | 3 ③ |

`capture-log.txt` is the capture run's own log: every shot, the texts read off the page, and the writes it sent.

## How the screens were made

- `kit/run.sh` builds this branch's web app with `vite build` (no dev server) and runs `kit/capture.mjs`. The capture
  script serves the build from a small Node server and drives Playwright's Chromium 1.63. It signs in through the
  repo's `src/web/ui-migration/fixtures.mjs` and answers the Infrastructure reads from `kit/data.mjs`: the boards'
  account (three machines, two DeepSeek keys, Gemini, Kimi and GLM keys, a Claude subscription token, a pool), in
  the shapes T3 serves.
- The same browser renders the board HTML, with the same fonts (Inter and Noto Sans SC through
  `/mnt/data/pe-mock/fonts.conf`), and takes the matching element of each board's frame.
- `kit/compare.py` sets each pair side by side.

To repeat: `kit/run.sh <out>`, then `python3 -I kit/compare.py <out> <dir> <commit>`. The scripts carry this
worktree's absolute paths.

## Where the page differs from the boards

- The confirmation dialogs are the house `ConfirmDialog`: its orange "!" mark and Orbit's danger button, where the
  board drew a triangle. The words are the board's.
- Machine cards keep rows and notes the board left out: the Google terms note under Antigravity CLI, the
  `opencode auth login` note, the reset time under a quota. The folded cards' summaries ("1 of 3 signed in") are
  today's `summaryOf` reading the fixture's machines.
- The edit page says "You already have one DeepSeek key", because the account has two DeepSeek keys. That line is
  today's behaviour for a vendor with several keys.
- On Connect DeepSeek, "Connecting sends one tiny test request first" appears once a key is typed, and Connect is
  disabled until then. Both are today's behaviour.
- Advanced shows the model list as today's read-only text, not as a box.
- Board 3's edit frame draws Works with without usage. Choice A adds the counts to each row, so the page shows them.
