#!/bin/bash
# Run the worktree's vite and a node script inside a private network namespace: on this host Chromium
# aborts module loads with ERR_NETWORK_CHANGED whenever a docker veth comes or goes.
# usage: unshare -n /mnt/data/wmb/kit/run-ns.sh <script.mjs> [args...]
set -e
ip link set lo up
K=/mnt/data/wmb/kit
W=/root/.orbit/worktrees/afe31010-6ea1-5a82-a79c-06e2e13cda3c
(cd $W/src/web && exec $W/node_modules/.bin/vite --config $K/vite.mjs >$K/vite.log 2>&1) &
V=$!
trap 'kill $V 2>/dev/null' EXIT
for i in $(seq 1 120); do
  if (echo > /dev/tcp/127.0.0.1/5662) 2>/dev/null; then break; fi
  sleep 0.5
done
cd $K && node "$@"
