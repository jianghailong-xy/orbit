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

## The card becomes a footnote (2026-10-27, board 05-quiet, option A)

The owner said the card read as something floating over the conversation and got in the way. Board
`docs/mocks/session-recap-display/05-quiet` put that down to three things: it was the only filled, rounded block in the
transcript; it had the composer's shape and sat right on the composer; and its text was as bright as the reply. He picked
option A, with Refresh shown only on hover.

What changed, on all four clients (web `SessionRecapCard` and `.chat-recap*`, Mac/iOS `RecapCardView`, Android
`RecapCardView`):

- No fill, border or corners. The card is one paragraph flush with the reply's left edge, and the head (glyph, **Recap**,
  `· time`) runs into the recap.
- The paragraph uses the list line's own size and color: web 13px `--text-2` (as `.session-preview`), Mac 13pt and iOS 15pt
  secondary, Android `bodyMedium` in `onSurfaceVariant`.
- Refresh sits beside the first line. On Mac and web it shows under the pointer, on keyboard focus and while a refresh
  runs; otherwise it is hidden in place, so the words never move. iPhone, iPad, Android and hover-less web screens always
  show it.
- Unchanged: when the card shows and when it steps aside, the refresh call and its four notices, all copy, and Settings.

`quiet/capture.mjs` takes before (HEAD) and after (this change) shots from two vite builds of the app over the ui-migration
fixtures. `quiet/report.json` holds what it measured:

| | Before | After |
|---|---|---|
| Fill, corners | grey 12%, 12px | none, 0 |
| Height, desktop / phone | 88 / 110 px | 40 / 60 px |
| Text left edge (reply's at 633) | 645 | 633 |
| Text | 14px `--text-1` | 13px `--text-2` |
| Refresh opacity: rest / hover / keyboard focus / phone | 1 / 1 / 1 / 1 | 0 / 1 / 1 (`:focus-visible`) / 1 |

Checks:

- Web vitest: `SessionRecapCard` 9, `WorkspaceView.recapRow` 6, `indexCss` 2 and `copyLanguage` 2 tests, 19/19 green.
  `tsc --noEmit` is clean.
- Android `testDebugUnitTest`, 11/11 green: `RecapCardViewTest` (3), `RecapCardTest` (6) and `SessionRecapShotsTest` (2).
  `RecapCardViewTest` adds a check that the first line's middle is the 48dp Refresh button's middle (24dp).
- Swift: `swiftc -parse` in `swift:6.1` only. SwiftUI builds on macOS alone, and `client.yml` has not run on this change.

## × hides a recap (2026-11-01, board 06-hide)

The owner asked for a way to close the recap. He chose an × in the conversation: it hides that recap in that conversation, on
that device, until the server writes a newer one, and the list row keeps it. Following board
`docs/mocks/session-recap-display/06-hide`, he took both recommendations: on Mac and web the × shows with ↻ (under the pointer,
on keyboard focus, while a refresh runs), and there is no undo.

What changed on all four clients:

- **The ×.** It sits beside ↻ in the same grey, named `Hide recap` for the pointer's help and for screen readers. That is the
  one new word, and it is held across clients by the copy-parity tests (web ↔ OrbitKit ↔ Android). iPhone, iPad, Android and
  hover-less web screens always show it, as they do ↻.
- **What is remembered.** The hidden recap's write time (`recapAt`), or its words when a recap came with no time
  (`recapHideKey` / `RecapCard.hideKey`). The key is kept per session on this device: localStorage
  `orbit.recap.hidden.<id>` on web, UserDefaults on Mac and iOS, and the `orbit.recaps` SharedPreferences on Android. The card
  is not drawn while the stored key equals the current recap's key, so a newer recap shows again.
- **Unchanged:** the list row, when the card shows and steps aside, Refresh, and the Session recaps switch.

`hide/capture-hide.mjs` shoots two vite builds (HEAD and the change) over the ui-migration fixtures. `hide/report.json` holds
what it read on each scene:

| Scene | Card | ↻ × opacity | List line |
|---|---|---|---|
| before, hover | shown, ↻ only | 1 | the recap |
| after, rest | shown | 0 | the recap |
| after, hover / keyboard focus on × | shown | 1 | the recap |
| after, × clicked | gone; `orbit.recap.hidden.<id>` = the recap's `recapAt` | — | the recap |
| after, opened with that key stored | gone | — | the recap |
| after, a newer recap (another `recapAt`) | shown, the new words | 0 | the new recap |
| after, phone (no hover) | shown | 1 | the recap |

Checks:

- Web vitest, full suite: 455 files, 6019/6019 green, including the new cases. `SessionRecapCard` checks that × is named
  `Hide recap` and asks the server nothing. `WorkspaceView.recapRow` checks that × hides the card while the list row keeps the
  recap, that a reopen with the stored key stays hidden, and that a newer recap is drawn. `tsc --noEmit` is clean.
- OrbitKit `swift test` in `swift:6.1`: 4158 tests, 0 failures. `RecapCardTests` covers the hide rule (timed and untimed) and
  the `hide` word against the web file.
- Android `testDebugUnitTest`, 13/13 green: `RecapCardTest` (7, with the hide rule and the 7-word parity with RecapCard.swift),
  `RecapCardViewTest` (4, where × reaches `onHide` and does not refresh), and `SessionRecapShotsTest` (2).
- Mac and iOS views (`RecapCardView`, the `ConsoleView` wiring): `swiftc -parse` only. They compile on macOS through
  `client.yml`.

## One ⋯ at the end of the last line (2026-11-02, board 07-last-line, option B)

The owner, from an iPhone: the recap's two buttons took too much room. Beside the first line and always shown on a phone, ↻ and
× held a column down the whole card: 58 pt of a 408 pt line on an iPhone Pro Max, 96 dp of 380 on Android. Board
`docs/mocks/session-recap-display/07-last-line` offered three ways. The owner chose B, over the board's recommended A: one ⋯ at
the end of the recap's last line, opening a menu. The board's other question, whether Mac and web follow, went unanswered; they
do, as the board recommended, and the owner was told so.

What changed on all four clients (web `SessionRecapCard` and `.chat-recap*`, Mac/iOS `RecapCardView`, Android `RecapCardView`):

- **One ⋯** (⋮ on Android, as its other menus are), named `Recap actions`: the one new word, held across clients by the
  copy-parity tests. Its menu holds `Refresh recap` and `Hide recap`, the words those two buttons were named by.
- **The words run the full width.** The ⋯ takes its place at the end of the last line, centred on it. A last line with no room
  for it gives it a line of its own on web and Android; on Mac and iOS the last word comes down with it.
- **Shown** as before: under the pointer, on keyboard focus and while a refresh runs on Mac and web, plus while its menu is open
  on web; always on a phone or a hover-less screen. While a refresh runs it spins and cannot be pressed.
- **Android's card** loses the 13 dp it kept over its first line to centre that line on a 48 dp button. The button now hangs past
  the card.
- **Unchanged:** what Refresh and Hide do, when the card shows and steps aside, the list row, the Session recaps switch.

Pictures (sample recaps, not the owner's):

| Client | Picture | Shows |
|---|---|---|
| iPhone | `last-line/apple/iphone-long.png`, `-medium`, `-english`, `-long-dark` | The real `CompactShell` on a Pro Max (440 pt), against a stub. Words to the line's end, the ⋯ at the last line's end. |
| iPhone | `last-line/apple/iphone-menu.png`, `iphone-hidden.png` | The ⋯ pressed; then Hide recap pressed, and the card gone. |
| iPhone | `last-line/apple/iphone-sweep-cjk.png`, `-latin` | The real card at eleven lengths across a line's end. |
| Mac | `last-line/apple/mac-before-hover.png` | Main's ↻ ×, under the pointer, in the same console (4 lines). |
| Mac | `last-line/apple/mac-rest.png`, `mac-hover.png`, `mac-menu.png`, `mac-hidden.png` | The real `MainView`: at rest nothing beside the words (3 lines), under the pointer the ⋯, pressed its menu, then the card gone. |
| Web | `last-line/web/*.png`, `report.json` | Two themes and a 390 px touch phone, from `vite build` over the ui-migration fixtures (`capture-last-line.mjs`; see `hide/` for the design before). |
| Android | `last-line/android/*.png` | The real `RecapCardView` under Robolectric's native graphics, 412 dp wide: long, medium (⋮ on a line of its own), short, refreshing. How: `RecapCardShotsTest.kt.txt`. Android's menu is not pictured; it is a popup window, which that picture leaves out. |

Measured:

| | Result |
|---|---|
| The ⋯ on the last line, at its end | Asserted from the frames on iPhone and Mac; web's middle is 0.1 px from the last line's (`report.json`), for every scene. |
| Words never under the ⋯ | Eleven lengths, ideographs and Latin, every row read off the pictures (`scripts/sweep_gaps.py`, `apple/*-gaps.txt`): smallest gap 14.7 pt on iPhone, 21 pt on Mac. Past the boundary the last word moves down with the ⋯. |
| Mac at rest | The ⋯'s place has 0 pixels off the background (31 under the pointer), and no pixel of the words differs between rest and hover. Web: opacity 0 at rest, 1 under the pointer and while the pointer is in its open menu. |
| Screen reader's view | On the iPhone and Mac the accessibility tree holds a control named `Recap actions`, on the Mac at rest and under the pointer, in the real console. Main's ↻ × were absent at rest. |
| Tap target | iPhone (`apple/iphone-tap-distances.txt`): opens at 12 pt up, down, left and right of the ⋯'s middle, and at 15 pt up; 15 pt down and 20 pt up or down do not. Its frame is 30 by 32 pt. Android: real touches at each edge of the button, inside the reader's own list, open the menu. |

Two wrong turns the probe caught, in `last-line/probe-harness/RECORD.md` with all ten rounds: the Mac's tree did not hold the ⋯ (fixed by
0.001 opacity at rest; a first diagnosis was false, and reverted), and on the iPhone only 18 of the label's 32 pt answered a tap
(fixed by removing a negative padding that iOS's `Menu` does not honour).

Checks:

- Client gates on the final code (run 41384415837): `macOS (build + test)` with OrbitKit 4338 tests and 0 failures, `iOS
  (generate + build)`, the font-token audit and the navigation gate.
- iPhone on the final code: run 41384415837, seven of eight tests green; `test5` (the menu and Hide) stopped on the probe's own note.
  Run 41387638931 ran `test5` three times with that note fixed: twice green, once red before reaching the ⋯, on a cold
  simulator's launch. Both runs read red on GitHub for those reasons.
- Mac on the final code, run 41384415837: five tests green.
- Android: `RecapCardViewTest` 6 + `RecapCardTest` 7, 13/13, local. Android CI green on the final code (41384415918).
- Web: `SessionRecapCard`, `WorkspaceView.recapRow`, `indexCss` and `copyLanguage`, 22 tests under UTC and the first two under
  Asia/Shanghai; `tsc` clean. Full CI (41364261886, web suite included) green on 06d2f6dda; web has not changed since.

Not established:

- No screen reader was run. That the tree holds the ⋯ is what is shown, not that VoiceOver or TalkBack reads and presses it. On
  the Mac at rest it has `allowsHitTesting(false)`, and whether an accessibility press opens it then is untested.
- Why the real console's list keeps a Menu at opacity 0 out of the tree under the pointer, when a plain list does not. At 0.001
  the question no longer arises.
- Android was not run on a device or emulator, and its pictures use Robolectric's graphics.
- The Mac's tree reports the empty image a line above where it is drawn in one boundary row (`apple/mac-sweep-latin-row-4.png`); the
  picture is right.

