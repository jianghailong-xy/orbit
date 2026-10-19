#!/usr/bin/env bash
# emu-pair.sh: the scripted emulator pass (emu-steps.mjs) on each tree in turn, each from a fresh Chrome. Needs both
# previews (4383 delivery, 4384 reference) and /var/lib/orbit/android/ui.lock held for the session.
set -u
cd /mnt/data/tmp/34Za39Ov1yysHZaYL6wgJ/android
for tree in del ref; do
  rm -rf run/$tree; mkdir -p run/$tree
  node emu-server.mjs $tree 4391 > run/$tree/server.log 2>&1 &
  pid=$!
  for i in $(seq 1 90); do grep -q READY run/$tree/server.log && break; sleep 1; done
  head -3 run/$tree/server.log
  curl -s --max-time 900 -X POST --data-binary "$PWD/emu-steps.mjs" http://127.0.0.1:4391/run; echo
  curl -s --max-time 30 -X POST http://127.0.0.1:4391/quit > /dev/null; wait $pid
done
