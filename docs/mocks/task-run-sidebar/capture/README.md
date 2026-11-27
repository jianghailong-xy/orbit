# 02-real.png: the task run sidebar on the real page

`capture.mjs` serves a `vite build` of `src/web` on the ui-migration fixture API (`src/web/ui-migration/fixtures.mjs`)
and opens a task run conversation whose task is Failed, Running, Needs you or Done, at a 1720 px window. Nothing is
pressed: the column opens by itself (D2 = B). A fifth frame, Failed at 1500 px, presses the Task badge and shows the
overlay below the 1640 px docking width. `compose.mjs` crops the matching frames out of `../01-board.html` and lays
each beside its real shot.

    (cd src/shared && npx tsc -p tsconfig.json)
    (cd src/web && node ../../node_modules/vite/bin/vite.js build --outDir /var/tmp/trs-web/dist)
    node capture.mjs <worktree> /var/tmp/trs-web/dist /var/tmp/trs-web/shots 1720
    node compose.mjs <worktree> /var/tmp/trs-web/shots docs/mocks/task-run-sidebar/02-real.png 420 1640

Fonts: `FONTCONFIG_FILE=/var/tmp/nwf-cap/fonts.conf` (Inter, Noto Sans SC). Sample data, not real tasks.
