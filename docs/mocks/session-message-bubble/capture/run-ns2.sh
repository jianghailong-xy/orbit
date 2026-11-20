#!/bin/bash
# usage: unshare -n /var/tmp/coord-fold-mock/run-ns2.sh <script.mjs> [args...]  (vite on cur:5874, prop:5875)
set -e
ip link set lo up
K=/var/tmp/coord-fold-mock
(cd $K/cur/src/web && exec nice -n 5 $K/today/node_modules/.bin/vite --config $K/vite-cur.mjs >$K/vite-cur.log 2>&1) &
A=$!
(cd $K/prop/src/web && exec nice -n 5 $K/today/node_modules/.bin/vite --config $K/vite-prop.mjs >$K/vite-prop.log 2>&1) &
B=$!
trap 'kill $A $B 2>/dev/null' EXIT
node $K/waitports.mjs 5874 5875
cd $K && node "$@"
