# Recap display: the owner's decided design, as built

The owner's 2026-10-22 decision (board `docs/mocks/session-recap-display/04-decided`):

- The session list keeps one line per row. The tag chips and the `Recap · <time>` prefix are gone, so the line is the
  recap alone.
- A conversation at rest ends in a Recap card: the recap whole, `Recap · <when>`, and Refresh recap.
- The server keeps the recap caught up with the session's last turn.

## What the pictures show

| Client | Picture | Shows |
|---|---|---|
| Web | `web/desktop-light.png`, `web/desktop-dark.png` | The built app (`vite build` of this branch) over the repo's ui-migration fixtures. Each list row's line is the sentence alone: no tag on any row, and no `Recap ·`. The running row keeps `Running Bash…`. The opened conversation ends in the Recap card (`Recap · 7:44 PM`, ↻, the recap whole) under the reply's turn foot. |
| Web | `web/phone-light.png` | The same conversation at 390 px. |
| Android | `android/list-with-recap.png` | Robolectric `SessionRecapShotsTest`: the real `DirectoryScreen`. The recap row draws the sentence alone, and neither the tag nor `Recap ·` is on it. |
| Android | `android/list-with-recaps-off.png` | The same list with Session recaps off: the raw last reply. |
| Android | `android/settings-session-recaps.png` | Settings → Sessions with the new hint. |

`web/capture.mjs` reproduces the web pictures. Build with `npx vite build --outDir /var/tmp/recap-web-dist` in `src/web`,
then run `FONTCONFIG_FILE=/mnt/data/pe-mock/fonts.conf unshare -n bash -c 'ip link set lo up && node capture.mjs <out>'`. Each
capture prints the rows' lines, how many rows mention a tag (0), and the card's text.

## Checks

- apiserver: `npm test` 5416/0, and `recap-settle.pg.spec.ts` 7/7 against PostgreSQL 16.15.
  - Case (2): a settle inside the window gets its catch-up pass. Case (6): an engine-started turn's TURN_END asks for a pass.
  - Both cases, and the publish after a late write, are red when the hook under test is removed.
- Web: vitest 428 files / 5626 tests green, and `vite build` green.
  - The step-aside test in `WorkspaceView.recapRow.test.tsx` is red without its rule.
- OrbitKit: 4071 tests, 0 failures (swift:6.1 in Docker).
- OrbitApp (iOS + macOS): `client.yml` dispatched on `probe/recap-display-3dca630`, run 40143446725. `macOS (build + test)`,
  `iOS (generate + build)`, the font-token audit and the navigation gate all succeeded.
- Android: the nine touched classes, 52 tests, 0 failures.
  - The full gate (`test lintDebug assembleDebug`) on 2a31e9e49 was BUILD SUCCESSFUL in 12m 48s.
  - app: 1773 debug + 1773 release unit tests. core: 269. 0 failures.
- Rebased onto main b0eac9110 to land. That brought in only a web sidebar feature and the 0.1.236 version bump. On the
  rebased tree: web vitest 430 files / 5640 tests green, `vite build` green, `tsc` clean. The apiserver, Swift and
  Android checks above ran on the pre-rebase tips, which carry the same changes and differ only in that base.

Not pictured: the iPhone and Mac Recap card. It is compiled by `client.yml` above, and its rule, time, notices and
words are `RecapCardTests`. No native screenshot probe was run.
