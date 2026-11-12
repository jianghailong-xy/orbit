#!/bin/bash
set -e
ip link set lo up
K=/mnt/data/tmp/pdf-mock
(cd /root/.orbit/worktrees/67abea98-cec7-5593-80f0-8a0ef57346a7/src/web && exec nice -n 5 /root/.orbit/worktrees/67abea98-cec7-5593-80f0-8a0ef57346a7/node_modules/.bin/vite --config $K/vite.mjs >$K/vite.log 2>&1) &
A=$!
trap 'kill $A 2>/dev/null' EXIT
for i in $(seq 1 120); do (echo > /dev/tcp/127.0.0.1/5941) 2>/dev/null && break; sleep 0.5; done
cd $K && PLAYWRIGHT_BROWSERS_PATH=$K/pw node "$@"
