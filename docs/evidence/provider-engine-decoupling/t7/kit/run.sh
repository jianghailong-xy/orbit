#!/usr/bin/env bash
# Build this worktree's web app outside the repo, then capture (capture.mjs). usage: run.sh <out-dir> [scene…]
set -euo pipefail
out="$1"
shift
kit="$(cd "$(dirname "$0")" && pwd)"
cd /root/.orbit/worktrees/e156eb76-7d94-5654-b980-04356572c73d/src/web
git -C .. log -1 --format='tree under capture: %H %s'
git -C .. status --short | sed 's/^/uncommitted: /'
systemd-run --scope --quiet -p MemoryMax=4G -- npx vite build --outDir /mnt/data/tmp/t7/dist --emptyOutDir --logLevel warn
systemd-run --scope --quiet -p MemoryMax=4G -- node "$kit/capture.mjs" /mnt/data/tmp/t7/dist "$out" "$@"
