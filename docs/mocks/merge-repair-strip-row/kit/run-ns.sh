#!/bin/bash
# vite on this worktree inside a private netns (:5811), then a node script. usage: unshare -n ./run-ns.sh <script.mjs> [args]
set -e
ip link set lo up
K=/var/tmp/rpr-mock
WT=/root/.orbit/worktrees/01a1d8e5-23c8-761d-ad9c-9170694723ee
(cd $WT/src/web && exec nice -n 5 $WT/node_modules/.bin/vite --config $K/vite.mjs >$K/vite.log 2>&1) &
A=$!
trap 'kill $A 2>/dev/null' EXIT
for i in $(seq 1 120); do (echo > /dev/tcp/127.0.0.1/5811) 2>/dev/null && break; sleep 0.5; done
cd $K && node "$@"
