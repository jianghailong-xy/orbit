#!/usr/bin/env bash
# vt-full.sh NAME: the whole web Vitest suite on the task worktree (the merge check's test half), JSON report to runs/NAME.json.
set -uo pipefail
cd /root/.orbit/worktrees/9f22d16e-3f30-5541-a5ef-91972ffc7911/src/web
out=/mnt/data/tmp/34Za39L1H6V82d2sobzPY/runs; mkdir -p "$out"
echo "== $(date -u +%FT%TZ) HEAD $(git rev-parse --short HEAD) load $(cut -d' ' -f1-3 /proc/loadavg) free $(free -m | awk '/Mem:/{print $7}')MB"
/mnt/data/tmp/34Za39L1H6V82d2sobzPY/scripts/capped.sh 5G npx vitest run --maxWorkers=2 --reporter=dot --reporter=json --outputFile.json="$out/$1.json" 2>&1 \
  | sed -r 's/\x1B\[[0-9;]*[A-Za-z]//g' | grep -vE "^(stderr|stdout) \||^Warning:|^\s*$" | tail -60
echo "== exit ${PIPESTATUS[0]} $(date -u +%FT%TZ)"
