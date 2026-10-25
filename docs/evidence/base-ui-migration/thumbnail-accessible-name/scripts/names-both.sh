#!/usr/bin/env bash
# names-both.sh OUT: names.mjs against both trees' builds (ref :4384, del :4383), in a private network namespace with
# each tree's vite preview, in a memory-capped scope. Writes OUT/names-ref.json and OUT/names-del.json, each with the
# tree's HEAD beside it. Stops only the two servers it started (their process groups).
set -u
V=/mnt/data/tmp/34dTUqxH5MjymjtUhs5C5/v1
S=/mnt/data/tmp/34dTUqxH5MjymjtUhs5C5/scripts
OUT=${1:?output directory}
mkdir -p "$OUT"
for t in ref del; do git -C "$V/$t" rev-parse HEAD > "$OUT/names-$t.head"; done
systemd-run --scope --quiet -p MemoryMax=6G sh -c 'echo 500 > /proc/self/oom_score_adj && exec "$@"' sh unshare -n bash -c "
  ip link set lo up
  (cd $V/ref/src/web && exec setsid npx vite preview --host 127.0.0.1 --port 4384 --strictPort > /dev/null 2>&1) & ref=\$!
  (cd $V/del/src/web && exec setsid npx vite preview --host 127.0.0.1 --port 4383 --strictPort > /dev/null 2>&1) & del=\$!
  for i in \$(seq 1 100); do curl -s -o /dev/null http://127.0.0.1:4384/ && curl -s -o /dev/null http://127.0.0.1:4383/ && break; sleep 0.2; done
  node $S/names.mjs 4384 > $OUT/names-ref.json 2> $OUT/names-ref.stderr.txt; echo \"names ref exit=\$?\"
  node $S/names.mjs 4383 > $OUT/names-del.json 2> $OUT/names-del.stderr.txt; echo \"names del exit=\$?\"
  kill -- -\$ref -\$del 2>/dev/null
"
