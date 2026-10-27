# A project's landings in one Landings window — web, iOS/macOS, Android

Task `34nGbUykKeP4geymwZYB8`. Owner decision 2026-10-27: a project's landings are read in one
window, Merged into main included; plan A (the window only — server, contract §2.9 data,
`landingSessionId` and `session_get` unchanged, no new endpoint); settled landings are all kept.
Board: `docs/mocks/landings-one-window/` (frames a/b, c/d, e, f, g). Rules: contract
`docs/project-integration-line-contract.md` §2.9 LS6, the entrance table, the `promotions/merged`
paragraph of §3.6, and Appendix B revision 28.

| Directory | Client | What is there |
|---|---|---|
| `web/` | Web console | Browser frames b, d, e, f (by address and from the Landing card's `Open landing ›`), g — light and dark — the capture kit, and what each frame drew (`report.json`). |
| `native/` | iOS / macOS | The iPhone frames b, d, e, f, g and one macOS window, from the real apps built on GitHub's macOS runners against a stub (`native/probe-harness/`), with the run's macOS and iOS gates. |
| `android/` | Android | Emulator frames b, d, e, f, g, the kit that took them, and the `verify.sh` result. |

## What changed, in all three clients

1. **Project sessions page.** The Landings group (one row per landing, a 24-hour window and an
   `Earlier · N landed · N nothing to land` fold) is one **Landings** row in the same place, under
   Coordinator and above the day sections. Its mark follows the most urgent landing (✕ something
   waits for a decision, the blue ring something is in flight, ✓ otherwise); its right-hand time is
   the longest wait, or how long ago the last landing settled; its line counts
   `N waiting for a decision · N in flight · N landed · N merged into main today` (a zero is left out,
   all zero is `Nothing landed today`); a project that never had a landing has no row. The whole row
   opens the project's Landings window at its bottom. The page timeline draws sessions only — no
   Merged into main row.
2. **The Landings window** (web `/projects/<id>/landings`; iPhone a page pushed over the project's
   sessions page; iPad a sheet; macOS the console pane of a landing's id; Android its own page): the
   old landing page's shell (`Landings`, `Run by Orbit · <project>`, a ⋯ with Open Coordinator and
   Open Project, the read-only footer `Orbit runs these landings — nothing to type here.` /
   `Decisions: the coordinator · Open coordinator ›`, no composer). Settled landings by the session
   list's own day sections, oldest first, one row each, all kept; a merge into main is one row with
   its round's landing session (joined by `landingSessionId`) and opens in place to its receipt and
   its round's record; landings in hand are the old page's status cards under `Now` (a waiting one
   with Open Coordinator / Open Task, a timed-out one with its Retry / Re-run the check / Abandon), the
   only part that polls. A row or a card opens in place to its record; a long press (web: its ⋯ or a
   right-click) shows the old page's ⋯ rows with the same gates.
3. **Every entrance.** A LANDING session id opens its project's window on that landing — scrolled to,
   opened and outlined for about 1.5 s — at the one place each client opens a session (web
   `/sessions/<id>` in `WorkspaceView`, iOS/macOS the console of `orbit-session:` /
   `openFromConversation(.session)`, Android `SessionDestination`), so the Landing card and jobs list's
   `Open landing ›`, the merge check row, the receipt, the X-E5 card, the coordinator card's
   OPEN_LANDING, the task page's Landing section, the source session's landing label and
   `orbit-session:` links all reach it.
4. **Removed:** the Landings group, its fold and 24-hour window (`landingGroup`,
   `LANDINGS_SETTLED_WINDOW_MS`, `SessionProjectLandings.group` / `earlierLine` /
   `landingsSettledWindow`, the Kotlin counterparts), the page timeline's merge rows, and the single
   landing page's own header and footer; the copy-parity tests in all three clients follow.

## Checks

| Check | Result |
|---|---|
| Web `vitest`, under `TZ=UTC` and under `TZ=Asia/Shanghai` | 436 files, 5707 tests passed in each |
| OrbitKit `swift test` in the `swift:6.1` image | 4077 tests, 5 skipped, 0 failures |
| macOS and iOS on GitHub (`native/README.md`) | the Mac app and OrbitKit (4077 tests, 0 failures), the iOS build, the navigation and font-token gates, and the probe's 4 UI tests all passed |
| Android `src/android/scripts/verify.sh` (`android/README.md`) | 4008 local tests passed, lint and assemble passed |
| The merge check under `TZ=Asia/Shanghai`: root build, `@orbit/shared`, `@orbit/apiserver`, `@orbit/web`, runner-go `go vet` and `go test` | every step exit 0 (apiserver 5579 tests) |

The apiserver's provenance census (`project-provenance-epoch.spec.ts`, SC7) names the web files that read a landing attempt's
`sourceSessionId`; its two entries follow the page's rename to `ProjectLandingsWindow.tsx`.

## What the window cannot read

`GET /projects/:id/promotions/merged` answers the newest 20 merges (`MERGED_RECORD_LIMIT`). Every
round of merging since landing sessions shipped (2026-10-19) has its own landing session, which the
window lists in full from `GET /sessions?projectId=&includeLanding=1`; such a round past the newest 20
records keeps its row, titled Merged into main, and opens to what its own landing view holds. Only a
merge **older than landing sessions and past the newest 20** cannot be read — the same limit the old
project page timeline had. The server is unchanged (plan A).
