#!/bin/bash
ip link set lo up
cd /root/.orbit/worktrees/01a210f8-5eb8-74b2-813e-7544d211ca50/src/web
../../node_modules/.bin/vite preview --port 4199 --strictPort >/mnt/tmp/nst-shot/pv.log 2>&1 &
PV=$!
node -e "const t=Date.now();(async function f(){try{await fetch('http://localhost:4199/');process.exit(0)}catch{if(Date.now()-t>30000)process.exit(1);setTimeout(f,300)}})()"
node /mnt/tmp/nst-shot/title.mjs /mnt/tmp/nst-shot/out
kill $PV
