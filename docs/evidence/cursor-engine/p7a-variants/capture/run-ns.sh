#!/bin/bash
# The worktree's vite dev server inside a private netns, then a node script against it.
#   unshare -n /mnt/data/tmp/p7a-variants-shots/run-ns.sh <script.mjs> [args...]
set -e
ip link set lo up
K=/mnt/data/tmp/p7a-variants-shots
export TREE=/root/.orbit/worktrees/78464a5d-24b1-57a8-974b-5e0d92096ee3 VPORT=5791
(cd $TREE/src/web && exec $TREE/node_modules/.bin/vite --config $K/vite.mjs >$K/logs/vite.log 2>&1) &
V=$!
trap 'kill $V 2>/dev/null' EXIT
for i in $(seq 1 240); do
  if (echo > /dev/tcp/127.0.0.1/5791) 2>/dev/null; then break; fi
  sleep 0.5
done
cd $K && BASE=http://127.0.0.1:5791 node "$@"
