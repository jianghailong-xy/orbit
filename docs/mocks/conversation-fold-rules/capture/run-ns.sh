#!/bin/bash
# usage: unshare -rn /var/tmp/fold-rule-mock/run-ns.sh <script.mjs> [args...]  (vite on proto:5881)
set -e
ip link set lo up
K=/var/tmp/fold-rule-mock
(cd $K/proto/src/web && exec nice -n 5 /var/tmp/coord-fold-mock/today/node_modules/.bin/vite --config $K/vite-proto.mjs >$K/vite-proto.log 2>&1) &
A=$!
trap 'kill $A 2>/dev/null' EXIT
node /var/tmp/coord-fold-mock/waitports.mjs 5881
cd $K && node "$@"
