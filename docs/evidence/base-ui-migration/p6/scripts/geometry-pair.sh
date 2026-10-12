#!/usr/bin/env bash
# geometry-pair.sh OUTDIR: fixture-geometry.mjs on the base's and the delivery's controls fixture (dev servers on :4185 and
# :4186, each tree's own sources and install) in all 8 environments, in a private network namespace and a memory-capped
# scope; then, per environment, whether the section's inside is the same and where the section sits on each page.
set -u
OUT=${1:?outdir}
V=/mnt/data/tmp/34Za39RS6A28G7xPqMD0p/v1
P=/root/.orbit/worktrees/05c9af49-f99c-506f-b2c2-2c26a5edc79e/docs/evidence/base-ui-migration/p6/scripts/fixture-geometry.mjs
mkdir -p "$OUT"
for i in $(seq 1 60); do [ "$(free -m | awk '/Mem:/{print $7}')" -ge 4608 ] && break; sleep 30; done
systemd-run --scope --quiet -p MemoryMax=6G sh -c 'echo 500 > /proc/self/oom_score_adj && exec "$@"' sh unshare -n bash -c "
  ip link set lo up
  (cd $V/base/src/web && exec setsid npm run dev -- --host 127.0.0.1 --port 4185 --strictPort > /dev/null 2>&1) & base=\$!
  (cd $V/del/src/web && exec setsid npm run dev -- --host 127.0.0.1 --port 4186 --strictPort > /dev/null 2>&1) & del=\$!
  for i in \$(seq 1 150); do curl -s -o /dev/null http://127.0.0.1:4185/ui-migration/controls.html && curl -s -o /dev/null http://127.0.0.1:4186/ui-migration/controls.html && break; sleep 0.2; done
  for browser in chromium webkit; do for theme in light dark; do for size in desktop phone; do
    TREE=$V/base PORT=4185 BROWSER=\$browser THEME=\$theme SIZE=\$size node $P $OUT/base-\$browser-\$theme-\$size.json
    TREE=$V/del PORT=4186 BROWSER=\$browser THEME=\$theme SIZE=\$size node $P $OUT/del-\$browser-\$theme-\$size.json
  done; done; done
  kill -- -\$base -\$del 2>/dev/null
"
echo "probe exit=$?"
python3 -I - "$OUT" <<'PY'
import json, os, sys
o = sys.argv[1]
for env in sorted(f[5:-5] for f in os.listdir(o) if f.startswith('base-')):
    b, d = (json.load(open(f'{o}/{t}-{env}.json')) for t in ('base', 'del'))
    same = b['elements'] == d['elements']
    note = ''
    if not same:
        differing = [(i, x, y) for i, (x, y) in enumerate(zip(b['elements'], d['elements'])) if x != y]
        note = f', {len(differing)} differ: ' + '; '.join(f'{i} {x} / {y}' for i, x, y in differing[:4])
    print(f"{env:24s} inside equal: {same} ({len(b['elements'])} elements{note}) | section y {b['section']['y']} -> {d['section']['y']}, height {b['section']['height']} -> {d['section']['height']}")
PY
