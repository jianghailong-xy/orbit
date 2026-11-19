#!/bin/bash
# vite on this worktree inside a private netns, then a node script against it:  unshare -n /mnt/data/tmp/landings-chat3/run-ns.sh <script.mjs> [args]
set -e
ip link set lo up
(cd /root/.orbit/worktrees/01a1c548-51fd-7597-8625-78f9a70996c3/src/web && exec nice /root/.orbit/worktrees/01a1c548-51fd-7597-8625-78f9a70996c3/node_modules/.bin/vite --config /mnt/data/tmp/landings-chat3/vite.mjs >/mnt/data/tmp/landings-chat3/vite.log 2>&1) &
V=$!
trap 'kill $V 2>/dev/null' EXIT
for i in $(seq 1 120); do (echo > /dev/tcp/127.0.0.1/5893) 2>/dev/null && break; sleep 0.5; done
cd /mnt/data/tmp/landings-chat3 && BASE=http://127.0.0.1:5893 node "$@"
