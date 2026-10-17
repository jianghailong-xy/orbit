#!/usr/bin/env bash
# probe-run.sh TREE OUT NAME [RUNS]: ro-mechanism-probe.mjs on TREE's choices fixture, RUNS (default 3) runs each in WebKit at
# phone size, light and dark. TREE's dev server sits with the probe in a private network namespace and a memory-capped
# scope. Writes OUT/NAME-light.json and OUT/NAME-dark.json.
set -u
TREE=${1:?tree}; OUT=${2:?outdir}; NAME=${3:?name}; RUNS=${4:-3}
P=$(cd "$(dirname "$0")" && pwd)/ro-mechanism-probe.mjs
export TMPDIR=/mnt/data/tmp/34dcr9bZPPrl6TDzvXowg/tmp
mkdir -p "$OUT" "$TMPDIR"
for i in $(seq 1 60); do [ "$(free -m | awk '/Mem:/{print $7}')" -ge 4608 ] && break; sleep 30; done
echo "== $NAME: $(git -C "$TREE" rev-parse --short HEAD), edits: [$(git -C "$TREE" diff --stat HEAD -- src/web | tail -1)]"
systemd-run --scope --quiet -p MemoryMax=6G sh -c 'echo 500 > /proc/self/oom_score_adj && exec "$@"' sh unshare -n bash -c "
  ip link set lo up
  (cd $TREE/src/web && exec setsid npm run dev -- --host 127.0.0.1 --port 4191 --strictPort > /dev/null 2>&1) & server=\$!
  for i in \$(seq 1 150); do curl -s -o /dev/null http://127.0.0.1:4191/ui-migration/choices.html && break; sleep 0.2; done
  for theme in light dark; do TREE=$TREE PORT=4191 THEME=\$theme RUNS=$RUNS node $P $OUT/$NAME-\$theme.json; done
  kill -- -\$server 2>/dev/null
"
