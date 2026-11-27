#!/bin/bash
# The tree's vite dev server, then a node script against it:  unshare -n ./run.sh <tree> <out-dir>
set -e
# Run inside a private network namespace (unshare -n): this host's interfaces change under the browser
# (net::ERR_NETWORK_CHANGED) otherwise.
ip link set lo up 2>/dev/null || true
HERE=$(cd "$(dirname "$0")" && pwd)
export TREE=$1 OUT=$2 VPORT=5798
mkdir -p /var/tmp/session-phase-mock "$OUT"
(cd "$TREE/src/web" && exec nice "$TREE/node_modules/.bin/vite" --config "$HERE/vite.mjs" >/var/tmp/session-phase-mock/vite.log 2>&1) &
V=$!
trap 'kill $V 2>/dev/null' EXIT
for i in $(seq 1 240); do
  if (echo > /dev/tcp/127.0.0.1/5798) 2>/dev/null; then break; fi
  sleep 0.5
done
cd "$HERE" && BASE=http://127.0.0.1:5798 node shoot.mjs
