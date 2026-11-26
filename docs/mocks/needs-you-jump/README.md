# Needs-you row → where you act (web), 2026-11-26

Board: `01-board-light.png` (parts 1–3 as separate PNGs). Frames are real web console shots of main
over fixtures, not hand-drawn.

Rebuild:
1. `bash scripts/worktree-overlay.sh`, then `cd src/web && npx vite build --outDir /mnt/tmp/nyj-mock/dist-today`.
2. Fonts (Inter, Noto Sans SC, JetBrains Mono TTFs) in `/mnt/tmp/nyj-mock/fonts`, see `capture/fonts.conf`.
3. `FONTCONFIG_FILE=capture/fonts.conf unshare -n bash -c "ip link set lo up && node capture/capture.mjs <out>"`, copy the PNGs and `marks.json` into `shots/`.
4. `python3 -I capture/board.py "$PWD"` then `THEMES=light FONTCONFIG_FILE=capture/fonts.conf node render.mjs 01-board`.
