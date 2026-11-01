#!/bin/bash
# One tree's vite dev server inside a private netns, then a node script against it.
#   unshare -n /var/tmp/region-gate-mock/scripts/run-ns.sh <tree-dir> <script.mjs> [args...]
set -e
ip link set lo up
K=/var/tmp/region-gate-mock
TREE=$1; shift
export TREE VPORT=5797
(cd $TREE/src/web && exec nice $TREE/node_modules/.bin/vite --config $K/scripts/vite.mjs >$K/vite-$(basename $TREE).log 2>&1) &
V=$!
trap 'kill $V 2>/dev/null' EXIT
for i in $(seq 1 120); do
  if (echo > /dev/tcp/127.0.0.1/5797) 2>/dev/null; then break; fi
  sleep 0.5
done
cd $K/scripts && BASE=http://127.0.0.1:5797 node "$@"
