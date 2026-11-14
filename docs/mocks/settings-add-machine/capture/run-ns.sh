#!/bin/bash
# A built dist served inside a private netns, then a node script against it.  unshare -n ./run-ns.sh <dist> <script> [args]
set -e; ip link set lo up; K=/mnt/data/tmp/machines-add-mock; D=$1; shift
node $K/serve.mjs $D & V=$!; trap 'kill $V 2>/dev/null' EXIT; sleep 0.5
cd $K && BASE=http://127.0.0.1:5874 node "$@"
