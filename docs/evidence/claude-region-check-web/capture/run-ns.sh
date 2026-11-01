#!/bin/bash
# One tree's vite dev server inside a private netns, then a node script against it.
#   unshare -n /mnt/data/tmp/34pVMqv27RB2CakEffAzt/shots-kit/run-ns.sh <tree-dir> <script.mjs> [args...]
set -e
ip link set lo up
TREE=$1; shift
export TREE VPORT=5797
log=/mnt/data/tmp/34pVMqv27RB2CakEffAzt/shots-kit/vite-$(echo "$TREE" | tr '/' '_').log
(cd $TREE/src/web && exec nice /root/.orbit/worktrees/ea00e920-f8d6-543a-a3ad-d78cee336a8f/node_modules/.bin/vite --config /mnt/data/tmp/34pVMqv27RB2CakEffAzt/shots-kit/vite.mjs >"$log" 2>&1) &
V=$!
trap 'kill $V 2>/dev/null' EXIT
for i in $(seq 1 240); do
  if (echo > /dev/tcp/127.0.0.1/5797) 2>/dev/null; then break; fi
  sleep 0.5
done
cd /mnt/data/tmp/34pVMqv27RB2CakEffAzt/shots-kit && BASE=http://127.0.0.1:5797 node "$@"
