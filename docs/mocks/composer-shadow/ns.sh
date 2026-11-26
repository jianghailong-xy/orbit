#!/bin/bash
# unshare -n so Docker veth churn can't abort module loads: preview this tree's build, then shoot.
ip link set lo up
DIR=$(cd "$(dirname "$0")" && pwd)
cd "$DIR/../../../src/web"
../../node_modules/.bin/vite preview --port 4199 --strictPort >/mnt/tmp/cs-shot/pv.log 2>&1 &
PV=$!
node -e "const t=Date.now();(async function f(){try{await fetch('http://localhost:4199/');process.exit(0)}catch{if(Date.now()-t>30000)process.exit(1);setTimeout(f,300)}})()"
node "$DIR/capture.mjs" "${1:-/mnt/tmp/cs-shot/out}"
kill $PV
