#!/usr/bin/env bash
# Production build of one tree's web package (vite alone; the type check is the merge check's).
set -uo pipefail
tree=$1
cd "$tree/src/web"
echo "== build $tree HEAD $(git -C "$tree" rev-parse --short HEAD) $(date -u +%T) load $(cut -d' ' -f1 /proc/loadavg)"
/mnt/data/tmp/34Za39L1H6V82d2sobzPY/scripts/capped.sh 4G npx vite build 2>&1 | tail -3
echo "== exit ${PIPESTATUS[0]} $(date -u +%T)"
