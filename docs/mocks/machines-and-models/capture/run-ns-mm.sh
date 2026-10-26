#!/bin/bash
# One tree's vite dev server inside a private netns, then a node script against it (the tree's own vite).
#   unshare -n /var/tmp/infra-focus-mock/mm/run-ns-mm.sh <tree-dir> <script.mjs> [args...]
set -e
ip link set lo up
K=/var/tmp/infra-focus-mock
TREE=$1; shift
export TREE VPORT=5793
(cd $TREE/src/web && exec nice $TREE/node_modules/.bin/vite --config $K/mm/vite-mm.mjs >$K/mm/vite-$(basename $TREE).log 2>&1) &
V=$!
trap 'kill $V 2>/dev/null' EXIT
for i in $(seq 1 120); do
  if (echo > /dev/tcp/127.0.0.1/5793) 2>/dev/null; then break; fi
  sleep 0.5
done
cd $K && BASE=http://127.0.0.1:5793 node "$@"
