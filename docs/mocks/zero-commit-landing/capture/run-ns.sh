#!/bin/bash
# The worktree's vite and a node script inside a private network namespace (docker veths abort
# module loads with ERR_NETWORK_CHANGED on this host).
# usage: unshare -n /var/tmp/zero-commit-mock/run-ns.sh <script.mjs> [args...]
set -e
ip link set lo up
K=/var/tmp/zero-commit-mock
W=/root/.orbit/worktrees/1c275d44-d415-5572-8505-0da4e243125e
(cd $W/src/web && exec $W/node_modules/.bin/vite --config $K/vite.config.mjs >$K/vite.log 2>&1) &
V=$!
trap 'kill $V 2>/dev/null' EXIT
for i in $(seq 1 120); do
  if (echo > /dev/tcp/127.0.0.1/5871) 2>/dev/null; then break; fi
  sleep 0.5
done
cd $K && node "$@"
