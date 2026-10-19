# Landing liveness (contract §7.2 V6) — client evidence

Screenshots of the six landing surfaces once the server sends the V6 fields (`liveness`, `check`,
`claim`, `round`, `stepStartedAt`, `outputMovedAt`, `progressProtocol`, `typicalMs`), against the
owner-approved board `docs/mocks/landing-session/v4/` (04, 05, 06, 07).

The liveness sentence leads the detail line, right after the step word, so the narrow cards (the
sessions page's Landing card and the 360 dp Android card) show it before their ellipsis — as v4 04
and 07 do. `usually ~Nm`, `claim N · round M` and the takeover follow it and are read whole on the
wider rows.

| state | head, right slot | head, detail line |
|---|---|---|
| LIVE | `1m 50s of 60m` | `checking · output 6s ago · claim 1 · round 1 of 3` |
| QUIET | `1m 50s of 60m` | `checking · no output for 14m · within its 60m budget · claim 1 · round 1 of 3` |
| SILENT | `6m 0s of 60m` (frozen at the last report) | `checking · no word from runner wikova for 4m · claim 1 · round 1 of 3` |
| LEGACY | `12m 0s of 60m` | `checking · reports only between steps · claim 1 · round 1 of 3` |
| LEASE_EXPIRED | `Timed out` | `No report for 23m · limit 10m` |
| merge check (LIVE) | `1m 50s of 60m` | `checking · output 6s ago · usually ~18m · claim 1 · round 1 of 3` |
| older server | `1m 6s` | `checking · updated just now` (word for word as before the fields existed) |

## web/

The real web console — this worktree's own vite app (`src/web`) with the repo's `ui-migration`
fixtures and the project's integration read layered over them. Captured with Playwright at 1440×1120,
2×, light theme; the command is the kit at `/var/tmp/landing-v6-web/capture.mjs` (run through its
`run-ns.sh`, one state per invocation). `project-page-card.png`, `project-legacy-card.png` and
`project-silent-card.png` are the Work overview card (surface 1) — the wide card that shows a whole
detail line, including the 12-minute legacy check saying `reports only between steps` with no
`Update unavailable` and no `Updated 12m ago`; the other `*-card.png` files are the project sessions
page's Landing card (surface 2) and merge card (surface 3). In the narrow sessions column the detail
line is ellipsized exactly as it was before (the full string is in the DOM and asserted by the
tests).

## android/

Robolectric NATIVE captures from `ProjectLandingCardViewTest.theV6LivenessReadingsAreDrawnOnTheHead`
(written under `src/android/build/evidence/a11f-landing-card/`), plus `3-timed-out.png` from that
class's timed-out case. 360dp × 640dp, xhdpi, light theme.

## ios/

The Work overview's Landing card head on the iPhone — the shared `ProjectLandingHead` the six
surfaces wear — in `ios-live.png`, `ios-silent.png`, `ios-legacy.png`, `ios-timed-out.png` and
`ios-older.png`. Taken on a GitHub macOS runner by the probe harness in `probe-harness/` (its real
`CompactShell` and shared sources, `project.yml` pointing at `../src`), with a stub serving the
project's panorama and integration reads and one reading per launch; the UI test passed and wrote
the five pictures (run `39262342506`, `run.txt`). The probe branch is throwaway and was deleted
after the run; only the harness and the pictures live here. In the narrow phone card the liveness
sentence is the part that shows — `checking · output 7s ago · claim 1 · ro…`, `checking · no word
from runner wikow…`, `checking · reports only between steps…` — exactly the v4 07 line.

## Against the v4 board

- `04-project-sessions-page` (landing card, merge check row, timed-out card): the head's mark,
  title, right-hand live number and one detail line are the captured card; the body — the task, the
  branch, `Nothing to do — it lands on its own.` — is unchanged. The board's `checking · updated
  just now` is replaced by the step/claim/liveness clauses this task specifies.
- `05-landing-session-page` legend: all five readings appear as the legend words them — LIVE's
  `output Ns ago`, QUIET's `no output for Nm · within its Nm budget`, SILENT's `no word from runner
  <name> for Nm` with the clock frozen at the last report, LEGACY's `reports only between steps`,
  and LEASE_EXPIRED as main's `Timed out` / `No report for Nm · limit Nm`.
- `06-list-chat-task`: the timed-out project row is amber words, `Merge to main · timed out · no
  report for 23m`, and lights no needs-you dot.
- `07-android`: the same anatomy on the NATIVE capture, at 360dp.

## No macOS/iOS screenshot

This session runs on Linux; there is no Mac or simulator here. The Swift half is held by
`ProjectLandingHeadTests`, `ProjectPageTests` (head, card and job rows), `ProjectLandingCardTests`,
`SessionProjectLandingLineTests` and the copy-parity suites, all run under swift:6.1 in Docker. The
view itself (`ProjectLandingHead`, `ProjectLandingCardView`, `ProjectMergeCardView`) compiles only on
macOS, as on main; the strings they draw are the tested model values above.
