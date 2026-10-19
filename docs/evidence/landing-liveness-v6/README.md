# Landing liveness (contract §7.2 V6) — client evidence

Screenshots of the six landing surfaces once the server sends the V6 fields (`liveness`, `check`,
`claim`, `round`, `stepStartedAt`, `outputMovedAt`, `progressProtocol`, `typicalMs`), against the
owner-approved board `docs/mocks/landing-session/v4/` (04, 05, 06, 07).

| state | head, right slot | head, detail line |
|---|---|---|
| LIVE | `1m 50s of 60m` | `checking · claim 1 · round 1 of 3 · output 6s ago` |
| QUIET | `1m 50s of 60m` | `checking · claim 1 · round 1 of 3 · no output for 14m · within its 60m budget` |
| SILENT | `6m 0s of 60m` (frozen at the last report) | `checking · claim 1 · round 1 of 3 · no word from runner wikova for 4m` |
| LEGACY | `12m 0s of 60m` | `checking · claim 1 · round 1 of 3 · reports only between steps` |
| LEASE_EXPIRED | `Timed out` | `No report for 23m · limit 10m` |
| merge check (LIVE) | `1m 50s of 60m` | `checking · usually ~18m · claim 1 · round 1 of 3 · output 6s ago` |
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

## No macOS/iOS screenshot

This session runs on Linux; there is no Mac or simulator here. The Swift half is held by
`ProjectLandingHeadTests`, `ProjectPageTests` (head, card and job rows), `ProjectLandingCardTests`,
`SessionProjectLandingLineTests` and the copy-parity suites, all run under swift:6.1 in Docker. The
view itself (`ProjectLandingHead`, `ProjectLandingCardView`, `ProjectMergeCardView`) compiles only on
macOS, as on main; the strings they draw are the tested model values above.
