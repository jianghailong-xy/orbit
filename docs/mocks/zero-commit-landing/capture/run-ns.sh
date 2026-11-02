#!/bin/bash
# The worktree's vite and a node script inside a private network namespace (docker veths abort
# module loads with ERR_NETWORK_CHANGED on this host).
# usage: unshare -n /var/tmp/zero-commit-mock/run-ns.sh <script.mjs> [args...]
set -e
ip link set lo up
K=/var/tmp/zero-commit-mock
W=/root/.orbit/worktrees/01a19d00-fe53-77b5-b996-8f5ce8217f56
(cd $W/src/web && exec $W/node_modules/.bin/vite --config $K/vite.config.mjs >$K/vite.log 2>&1) &
V=$!
trap 'kill $V 2>/dev/null' EXIT
for i in $(seq 1 120); do
  if (echo > /dev/tcp/127.0.0.1/5871) 2>/dev/null; then break; fi
  sleep 0.5
done
cd $K && node "$@"
