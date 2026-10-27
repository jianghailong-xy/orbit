# Web — a project's landings in one Landings window

Task `34nGbUykKeP4geymwZYB8` (owner 2026-10-27, board `docs/mocks/landings-one-window/`, contract
`docs/project-integration-line-contract.md` §2.9 LS6 / §3.6, revision 28).

The pictures are the built console (`vite build` of this tree) in Chromium, 1440 × 1000 CSS px at 2×,
clock frozen at 2026-10-27 10:20 Asia/Shanghai (the board's moment), the shell's own REST fixtures
(`src/web/ui-migration`) for sign-in and the sidebar, and the project's reads served by
`kit/capture.mjs`. All project, task and runner names are example data.

| Picture (light / dark) | Board frame | What it shows |
|---|---|---|
| `light-b-project-page.png` | 01 b | The project sessions page: under Coordinator one **Landings** row — ✕ (a landing waits for a decision), `18m` (the longest wait), `1 waiting for a decision · 1 in flight · 3 landed · 1 merged into main today` over two lines — and the timeline below it with sessions only (no Merged into main row). The coordinator conversation on the right keeps its own merge receipt lines. |
| `light-d-window.png` | 02 d | The row opened the project's Landings window at `/projects/<id>/landings`: `Landings` / `Run by Orbit · Wiki server`, the ⋯ with Open Coordinator and Open Project, settled landings by the session list's day sections (`8–30 days ago` for a merge older than landing sessions, `Yesterday`, `Today` with ✓ / ◌ / ⇢ rows at their settle times), then `Now`: the waiting card (its doors Open Coordinator / Open Task) and the in-flight card (V6 clock, budget bar with the usual-duration tick, liveness). The window stands at its bottom; the footer reads `Orbit runs these landings — nothing to type here.` and `Decisions: the coordinator · Open coordinator ›`. No composer. |
| `light-e-merge-open.png` | 03 e | The Today `Merged into main` row pressed: opened in place (⌃ on its right) to the receipt — `Now on main · 2 tasks`, the tasks, `✓ Passed on the combined tree · 17m 41s`, `Landed exactly the tested tree 5e5bfca · as a merge commit` — over the round's own record (`Merge check · 1`, `Merge to main · 1`). |
| `light-f-focused.png` | 03 f | `/sessions/<landing id>` — what every Open landing ›, orbit-session link and landing label opens — draws the window on that landing: scrolled to, opened (two generations, the failed check's tail inline, `Open Task ›`, `Open Source Session ›`) and outlined (the outline lasts about 1.5 s; the picture is taken 0.45 s after it appears). |
| `light-f-entry.png` | 03 f | The same from a real entrance: the project page's Landing card `Open landing ›`, pressed, opens the window on that landing (here the card in hand), outlined and opened. |
| `light-g-card-menu.png` | 03 g | A right-click on the in-flight card: the old landing page's ⋯ rows — Open Task, Open Source Session, Open Coordinator, then `Stop Landing` with `Before the push only · nothing pushed yet`. Each card and row has the same menu on its own ⋯ (a row's shows on hover or focus). |

`report.json` holds what each frame drew (the Landings row's text, the window's days and entries,
which entry is open and outlined, the menu's rows, the footer, and that no merge row is left on the
page timeline), and every fixture call the console left unhandled (none).

## Run

```bash
bash docs/evidence/landings-one-window/web/kit/run.sh <outDir>          # every frame, light and dark
FRAMES_ONLY=f-entry bash docs/evidence/landings-one-window/web/kit/run.sh <outDir>
```

The script builds this tree's web app into `/var/tmp/lw-shots/dist` and photographs inside a private
network namespace (`unshare -n`), with `FONTCONFIG_FILE=/mnt/data/pe-mock/fonts.conf`.

## Notes

- The waiting card is today's landing status card as implemented: its head wears the grey ring and a
  grey `Not landed`, where the board draws a red ✕ — the card's look was not changed by this task.
- `GET /projects/:id/promotions/merged` answers the newest 20 merges (`MERGED_RECORD_LIMIT`). Every
  round since landing sessions (2026-10-19) has its own landing session, which the window lists in
  full; only a merge older than that **and** past the newest 20 cannot be read — the same as the old
  project page timeline. The server is unchanged (plan A).
