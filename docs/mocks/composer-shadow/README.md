# Composer shadow and edge (web), 2026-11-26

- `01-board.png`: the composer alone, three shadows (today, none, small), light/dark, idle/focused.
- `02-board.png`: the whole window. The composer's edge against the panels and the Tasks / Agents strips: today, shadow removed, and the panels' own edge (`--border-subtle` + `--panel-shadow`).
- `03-board.png`: corners after option 3 landed — composer 24 / strips 8 / panels 12 today, composer at the panel radius, everything at the panel radius (scenes `r-*` in `capture/window.mjs`, frames in `frames/corners/`).

Rebuild (after `bash scripts/worktree-overlay.sh` and `cd src/web && npx vite build`; fonts in `/mnt/tmp/band-glass-mock/fonts` and `/mnt/tmp/nyj-mock/fonts`):
1. Board 01: `unshare -n bash ns.sh` (uses `capture.mjs`), then copy the PNGs into `frames/`.
2. Board 02: `FONTCONFIG_FILE=$PWD/capture/fonts.conf unshare -n bash -c "ip link set lo up && node capture/window.mjs /mnt/tmp/cs-shot/window"` (a copy of `../right-column-window/capture/capture.mjs` with created tasks and delegate runs). Then crop into `frames/window/`: full frames at 1x, and bands of x 600–1440 and y 600–820 CSS px.
3. `node render.mjs 01-board` (or 02-board, 03-board).
