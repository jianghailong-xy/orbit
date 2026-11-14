# Merge repair as a row of the parking strip (web)

Owner, 2026-11-14, with a screenshot of a coordinator session whose merge-recovery panel pushed the composer
below the window: "composer 被挤到了屏幕外，另外 repair Session 是否可以在当前的停车条里进行". Option A (a row in the
strip) was picked, and the board's choices were answered "按建议":

- D1: the folded row carries the next step (Open / Merge into main / Continue repair / Reply / Resolve).
- D2: it stays folded while the repair runs or Orbit checks, and opens itself once when a result needs the owner.
- D3: web, iOS, macOS and Android follow it.

`01-board.png`: frames of the real session page (this repo's web on vite, ui-migration fixtures). ① is main, ② is the
height cap on the panel's snapshot, ③–⑥ draw the row over the same build at capture time. `kit/` regenerates them:
`FONTCONFIG_FILE=… unshare -n kit/run-ns.sh kit/capture.mjs`, then `python3 kit/board.py <out.png>` (paths inside point
at /var/tmp/rpr-mock and the session worktree; adjust them).
