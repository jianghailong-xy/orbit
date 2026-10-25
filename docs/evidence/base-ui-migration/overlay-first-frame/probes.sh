#!/usr/bin/env bash
# The evidence probes, against a dev server of each tree started here (fix 14400, reference 14401): painted frames
# (Chromium begin-frame control) and the owner's scroll while opening.
# usage: probes.sh <out dir>   (run inside the queue's network namespace)
set -u
B=/mnt/data/tmp/overlay-first-frame-34brok
out=$1; mkdir -p "$out"
P=docs/evidence/base-ui-migration/overlay-first-frame
(cd $B/run/src/web && exec npx vite --host 127.0.0.1 --port 14400 --strictPort > "$out/vite-fix.log" 2>&1) &
fix=$!
(cd $B/ref/src/web && exec npx vite --host 127.0.0.1 --port 14401 --strictPort > "$out/vite-ref.log" 2>&1) &
ref=$!
for port in 14400 14401; do for i in $(seq 60); do curl -sf -o /dev/null http://127.0.0.1:$port/ui-migration/choices.html && break; sleep 1; done; done
cd $B/run
code=0
run() { echo "\$ $*"; "$@" || code=1; }
for tree in ref:14401 fix:14400; do
  run node $P/painted.mjs ${tree#*:} ${tree%%:*} "$out/painted" desktop 'multiple@owner=dialog' 'attachment@owner=dialog' 'multiple@' 'attachment@' 'expiry@owner=dialog&anchor=right!'
  run node $P/painted.mjs ${tree#*:} ${tree%%:*} "$out/painted" phone 'multiple@owner=dialog' 'attachment@owner=dialog'
done
for env in 'chromium desktop' 'webkit desktop' 'chromium phone' 'webkit phone'; do
  set -- $env
  run node $P/scroll-jump.mjs "$out/scroll-jump-$1-$2.json" $1 $2 ref=14401 fix=14400 -- 'expiry@owner=dialog&anchor=right' 'multiple@owner=dialog&anchor=right' \
    'attachment@owner=dialog&anchor=right' 'expiry@owner=dialog' 'attachment@owner=dialog' 'expiry@owner=drawer'
done
kill $fix $ref 2>/dev/null; wait 2>/dev/null
exit $code
