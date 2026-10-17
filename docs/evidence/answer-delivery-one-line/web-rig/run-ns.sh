#!/bin/bash
# The worktree's vite and a node script inside a private network namespace: on this host Chromium
# aborts module loads with ERR_NETWORK_CHANGED whenever a docker veth comes or goes.
# usage: unshare -n /mnt/data/eb1d-web-shots/run-ns.sh <script.mjs> [args...]
set -e
ip link set lo up
K=/mnt/data/eb1d-web-shots
W=/root/.orbit/worktrees/eb1d9354-6df5-55cf-a6cc-28e45786a362
(cd $W/src/web && exec $W/node_modules/.bin/vite --config $K/vite.config.mjs >$K/vite.log 2>&1) &
V=$!
trap 'kill $V 2>/dev/null' EXIT
for i in $(seq 1 120); do
  if (echo > /dev/tcp/127.0.0.1/5763) 2>/dev/null; then break; fi
  sleep 0.5
done
cd $K && node "$@"
