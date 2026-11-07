#!/usr/bin/env bash
# Build this worktree's apiserver (src/apiserver/dist, gitignored) and the web console into a dist outside the tree.
set -euo pipefail
WT=/root/.orbit/worktrees/1ff76a3e-e1d0-52b9-a611-9b0c45796a70
OUT=${1:-/mnt/data/tmp/34tDf8/stack/dist-today}
cd "$WT"
echo "HEAD $(git rev-parse HEAD) dirty=$(git status --porcelain | wc -l)"
npm run build -w @orbit/shared >/dev/null
npm run build -w @orbit/apiserver 2>&1 | tail -3
cd src/web
rm -rf "$OUT"
PUBLIC_ORIGIN=http://127.0.0.1:2734 npx vite build --outDir "$OUT" --emptyOutDir 2>&1 | tail -4
ls -la "$OUT" | head
