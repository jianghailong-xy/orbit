#!/usr/bin/env bash
# runtime-pair.sh OUTDIR: runtime-probe.mjs on the reference's and the delivery's builds (v1/ref :4374, v1/del :4373)
# in all 8 P0 environments, in a private network namespace with each tree's vite preview. Stops only the two
# servers it started (their process groups).
set -u
OUT=${1:?outdir}
V=/mnt/data/tmp/34Za39RS6A28G7xPqMD0p/v1
P=/root/.orbit/worktrees/05c9af49-f99c-506f-b2c2-2c26a5edc79e/docs/evidence/base-ui-migration/p6/scripts/runtime-probe.mjs
mkdir -p "$OUT"
systemd-run --scope --quiet -p MemoryMax=6G sh -c 'echo 500 > /proc/self/oom_score_adj && exec "$@"' sh unshare -n bash -c "
  ip link set lo up
  (cd $V/ref/src/web && exec setsid npx vite preview --host 127.0.0.1 --port 4374 --strictPort > /dev/null 2>&1) & ref=\$!
  (cd $V/del/src/web && exec setsid npx vite preview --host 127.0.0.1 --port 4373 --strictPort > /dev/null 2>&1) & del=\$!
  for i in \$(seq 1 100); do curl -s -o /dev/null http://127.0.0.1:4374/ && curl -s -o /dev/null http://127.0.0.1:4373/ && break; sleep 0.2; done
  for browser in chromium webkit; do for theme in light dark; do for size in desktop phone; do
    TREE=$V/ref PORT=4374 BROWSER=\$browser THEME=\$theme SIZE=\$size node $P $OUT/ref-\$browser-\$theme-\$size.json
    TREE=$V/del PORT=4373 BROWSER=\$browser THEME=\$theme SIZE=\$size node $P $OUT/del-\$browser-\$theme-\$size.json
  done; done; done
  kill -- -\$ref -\$del 2>/dev/null
"
echo "exit=$?"
