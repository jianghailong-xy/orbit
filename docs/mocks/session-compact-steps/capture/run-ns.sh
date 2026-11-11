#!/bin/bash
# usage: unshare -n /var/tmp/compact-steps-mock/run-ns.sh <script.mjs> [args...]
set -e
ip link set lo up
K=/var/tmp/compact-steps-mock
(cd $K/today/src/web && exec nice -n 5 $K/today/node_modules/.bin/vite --config $K/vite-today.mjs >$K/vite-today.log 2>&1) &
A=$!
(cd $K/new/src/web && exec nice -n 5 $K/new/node_modules/.bin/vite --config $K/vite-new.mjs >$K/vite-new.log 2>&1) &
B=$!
trap 'kill $A $B 2>/dev/null' EXIT
for p in 5861 5862; do for i in $(seq 1 120); do (echo > /dev/tcp/127.0.0.1/$p) 2>/dev/null && break; sleep 0.5; done; done
cd $K && node "$@"
