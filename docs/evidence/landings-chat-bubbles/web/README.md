# Web — the Landings window drawn as a chat (option C, bubbles)

Owner 2026-11-02, board `docs/mocks/landings-chat-bubbles/` (option C, every recommended pick). The
board draws an iPhone; the web window follows the same rules.

The pictures are the built console (`vite build` of this tree) in Chromium, 1440 × 1000 CSS px at 2×
(`f-phone` at 390 × 844), the clock frozen at 2026-11-02 10:20 Asia/Shanghai, the shell's own REST
fixtures (`src/web/ui-migration`) for sign-in and the sidebar, and the project's reads served by
`kit/capture.mjs`. Every instant in the data is relative to that frozen clock. All project, task,
runner and commit names are example data: T1, T2 and T4 landed yesterday at 22:11, 23:07 and 23:25,
each merged into main two to four minutes later (`1 task · automatically`); T3 landed today at 00:19
and merged the same minute; T5 waits for a decision (checks failed, exit 1 after 3m 52s, handed to the
coordinator); T6 is checking (6m 12s of 30m, usually ~9m).

| Picture (light / dark) | Board part | What it shows |
|---|---|---|
| `light-a-bottom.png` / `dark-a-bottom.png` | 02 d, 01 b | The window as it opens, at its bottom. `Today` chip, then T3's group: one avatar beside `T3 sudo hints name the binary’s real path` (✓ Landed · 00:19) and its `Merged into main` (⇢ 91fd6b2 · 1 task · automatically · 00:19). The `Now` chip in the brand's ink and tint, then one group with the avatar whose column holds today's two cards unchanged, across the column with no gutter: T5's `Not landed` card with Open Coordinator / Open Task, T6's checking card with its clock, budget bar and liveness. The footer is the composer's card: `Orbit runs these landings — **nothing to type here.**`, then `Decisions: the coordinator` and an `Open coordinator` button with the person icon where Send stands. No input. |
| `light-b-history.png` / `dark-b-history.png` | 01 b | Scrolled up with the wheel: the `Yesterday` chip and its three groups (T1 + merge, T2 + merge, T4 + merge), one avatar each, top-aligned with the group's first bubble; each bubble hugs its words and leaves the right gutter; then the `Today` chip and T3's group. What is cut off at the bottom fades into the footer, as the conversation fades into its composer. |
| `light-c-open.png` / `dark-c-open.png` | 03 e | T3's bubble pressed: its record opens under the bubble, across the column's full width, on the quiet panel a person's bubble opens its ⊕ note on. The record is today's: `Generation 1`, its five timed lines with their marks, `Log ›`, then `Open Task ›` and `Open Source Session ›`. |
| `light-d-menu.png` / `dark-d-menu.png` | 03 f | The ⋯ that shows beside a hovered bubble, in its gutter, pressed on T3: the landing's own menu, unchanged — Open Task, Open Source Session, Open Coordinator. A right-click on the bubble opens the same menu. |
| `light-e-focused.png` / `dark-e-focused.png` | 03 f ③ | `/sessions/<T2's id>`, the address every `Open landing ›` opens: the window scrolled to T2, opened to its record, and T2's bubble outlined in the brand's blue (the outline lasts about 1.5 s; the picture is taken 0.45 s after the window is placed). |
| `light-f-phone.png` / `dark-f-phone.png` | not a board frame | The same window on a 390 px phone, scrolled up: the long names wrap whole inside their bubbles (`T1 install.sh: keep one orbit binary per` / `account`), and the bubbles stop at the 44 px gutter. On this width the footer's first line and `Decisions: the coordinator` take two lines each beside the button. |

A card's task name wraps now, on all three clients: the column beside the avatar is narrower, and the board draws a long name wrapping
(02 d). At desktop width nothing moves; `f-phone`'s cards are taller for it (`report.json`: T5's and T6's names went from `cut: true` to
`cut: false`).

## What `report.json` measured

`report.json` holds, per frame, what the window drew: the chips (text, ink, fill, centred), each
group's avatar count and box, each entry's words, foot and bubble box, the gutter each bubble leaves,
which entry is open and outlined (and the outlined bubble's ring), the record panel's look, the menu's
rows, the footer's lines, and every fixture call the console left unhandled. Across all 12 frames:

- every group draws exactly one avatar; Yesterday holds 2 + 2 + 2 bubbles, Today 2, Now 2 cards;
- every chip is centred over its section;
- no bubble's words are cut short (`cut: 0`), and every bubble leaves at least the 44 px gutter (416 px
  and more on the desktop frames, exactly 44 px on the phone, where the bubbles reach their width);
- the record panel spans the column and is filled like `.chat-user-wrap > .chat-injected-panel`, read
  off a probe of the same built stylesheet;
- the footer's computed corners, rim, surface and shadow equal a probe `.composer-box`'s, in both
  themes, and the footer holds no input;
- `e-focused`'s outlined bubble wears `0 0 0 2px` of the brand's blue (`rgb(51, 112, 255)` light,
  `rgb(91, 140, 255)` dark);
- no page error and no unhandled fixture call.

## Run

```bash
npm ci && npm run build -w @orbit/shared                                  # once
bash docs/evidence/landings-chat-bubbles/web/kit/run.sh [outDir]           # every frame, light and dark
FRAMES_ONLY=c-open,d-menu THEMES=dark bash docs/evidence/landings-chat-bubbles/web/kit/run.sh /tmp/out
```

The script builds this tree's web app into `/tmp/lcb-web-shots/dist` (delete it afterwards) and
photographs inside a private network namespace (`unshare -n`), with
`FONTCONFIG_FILE=/mnt/data/pe-mock/fonts.conf`. With no `outDir` it writes into this directory.

## Notes

- The waiting card's failure line reads `Task acceptance exited 1 (expected 0) on the combined tree ·
  nothing was pushed`: that is today's card copy for a failed check, kept as it is.
- The day chips stand in the flow, as the board and the native windows draw them; the web's old
  full-width day heads were sticky, and a sticky chip would sit over bubbles of the same fill.
- The window's scroller now ends in the same 20 px fade the conversation's transcript uses above its
  composer, so a landing cut off at the bottom dissolves into the footer card instead of being sliced
  above it. At the bottom, where the window opens, nothing stands in the fade.
