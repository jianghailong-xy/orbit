# Evidence: every landing row is the merged line's own row

Design board: `docs/mocks/project-merge-check-row/01-check-row.{html,png}` (owner picked ② on
2026-10-11, asked the Landing card's head to follow — 「②，Landing 卡的头跟着换」 — and then the
two hosts still drawing the old compact row: 「Jobs 列表和项目列表也一起换」).

## What changed

The merge check's live card (`ProjectMergeCardView`, the `.checking` shape) and the Landing card
(`ProjectLandingCard`, landed earlier the same day) now wear the timeline's **Merged into main**
row's anatomy, so the check and the merge it becomes are one shape instead of a card collapsing
into a row:

- **Head** — the mark in a 30pt (web 28px) circle: the ring spinning while the job runs, still and
  grey while it waits its turn or the app cannot read the server, a warning triangle when the server
  judged the runner silent. The word in the body size. The **live clock at the right** (tabular
  digits, brand while running) — the one number on the row that moves. One line under both: the
  state, what the job waited for a runner, and the freshness — `checking · updated 2m ago`,
  `checking · waited 1m 20s · updated just now`.
- A timed-out job has no clock left that moves: **`Timed out` takes the right slot** and the line
  says `No report for 110m · limit 10m`. An older server's silence is said once (`No report for 5m`,
  never `No report · No report for 5m`).
- **No chevron.** The whole row is the press, exactly as the merged line's whole row opens its
  receipt. The wording moved from three labelled facts (`Elapsed …`, `Waited …`, `Updated …`) into
  the one line; `landed` gains the word `waited` and nothing else.
- The two cards read one composition on each end — `ProjectPage.landingHead`
  (`src/macos/OrbitKit/Sources/OrbitKit/App/ProjectPage.swift`) and `landingHead` +
  `LandingHead` (`src/web/src/components/ProjectPanoramaHeader.tsx`) — so a card can never word a job
  differently from the row beside it.

**Every** host now draws the head, and the old compact row is gone from both ends:

- the merge check card's live row and the Landing card's head (the first round);
- the jobs list's rows (`ProjectLandingJobsSheet` / `LandingJobsSheet`) — the head, then the task
  it lands, then what happened to it, with Retry where the server takes one;
- the Work overview's landing on the project page — the native one now draws the same **card** the
  browser already drew there (`ProjectLandingCardView`, one read, one shape, one set of words).
  On the project's own page there is no second door, so `onOpenProject` is nil there and a server
  that lists no jobs draws the card as a read, exactly as the browser does;
- `ProjectLandingRow` / `LandingRow`, the `.project-landing*` styles and the `Waited` label they
  alone used are removed — one row component per end, one anatomy.

## Checks

| What | Result |
| --- | --- |
| OrbitKit `swift test` (docker `swift:6.1`, repo mounted) | 3736 tests, 5 skipped, **0 failures** |
| Web `npx vitest run --maxWorkers=2` | **5262 passed**, 0 failed (190 s) |
| `npx tsc -b` (web) | exit 0 |
| copy guard (`copyLanguage.test.ts`) | 2 passed |
| `npm run docs:check` | 32 files, 0 issues |

(Both suites were run in full on this change's final tree, after the last edit.)

## Web — the real console

Recipe: `/var/tmp/mchk-web` — this worktree's vite (`:5763`) inside `unshare -n`, Playwright from the
worktree's own `node_modules`, the repo's `ui-migration` fixtures with `page.route('**/api/**')`
layering the project, its members and its integration read on top. `capture.mjs <outDir> <state>`;
states `merge-check` (the owner's 9:17 screen), `checking`, `jobs`, `timed-out`, `project-page`, and
any of them again with `-dark`. Shots are in `web/`.

| Shot | What it is |
| --- | --- |
| `merge-check-card.png` | the merge check row: `Merge check` / `2m 40s` / `checking · updated just now` |
| `checking-card.png` | the Landing card, in flight |
| `jobs-card.png` | `Landing 2 jobs`, the lead's clocks in the head |
| `timed-out-card.png` | the amber card: `Timed out` at the right, `No report for 11m · limit 10m` |
| `project-page-card.png` | the same card inside Work overview |
| `jobs-list.png` | the jobs list, opened from the card's press: a row per job, the head then the task |
| `merge-check-dark-card.png`, `checking-dark-card.png` | the same two heads in the dark theme (every ink is a token) |

## Native

This host has no macOS/Xcode and no Mac runner, so no iOS/macOS screenshot exists (the same limit the
Landing card's evidence states). What stands in for it: the OrbitKit suite above — including
`ProjectLandingHeadTests` (the board's six states, one test each), the card and wiring tests, and
`ProjectPageSectionsCopyParityTests` pinning `landingHead` and `waited` to the web's — plus this
item-by-item comparison against board ②/⑤: head = `ProjectLandingHead` (30pt circle, `LandingRing`
at 15pt with its own Reduce-Motion rule, or the triangle), word at `.body` semibold, clock at
`.orbitListSubtitle` semibold tabular in the ink the ring wears, one `.orbitListSubtitle` line under
both; no chevron; both cards read `ProjectPage.LandingHead` from the read's own fields. The SwiftUI
drawing itself compiles only on a Mac and is unverified here.
