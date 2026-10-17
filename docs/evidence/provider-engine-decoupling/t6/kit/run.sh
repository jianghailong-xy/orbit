#!/usr/bin/env bash
# Build this worktree's web app outside the repo, then capture (capture.mjs). usage: run.sh <out-dir>
set -euo pipefail
out="$1"
cd /root/.orbit/worktrees/bb16742c-7745-5a29-83ab-f4bde58a11b0/src/web
git -C .. log -1 --format='tree under capture: %H %s' 
git -C .. status --short | sed 's/^/uncommitted: /'
systemd-run --scope --quiet -p MemoryMax=4G -- npx vite build --outDir /mnt/data/tmp/t6/dist --emptyOutDir --logLevel warn
cd /mnt/data/tmp/t6/kit
systemd-run --scope --quiet -p MemoryMax=4G -- node capture.mjs /mnt/data/tmp/t6/dist "$out"
