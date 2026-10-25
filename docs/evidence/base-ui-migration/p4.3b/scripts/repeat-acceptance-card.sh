#!/usr/bin/env bash
# repeat-acceptance-card.sh N: main's WorkspaceView.acceptanceConfirmationCard.test.tsx, N runs each on the delivery (this
# task's worktree, e21fad172) and on the start tree (abc0a4cfa merged with origin/main 4085437ff, without P4.3b), one run
# at a time, alternating trees. The merge check's one red was this file's desktop start-card case (levels read before
# the dependency-graph query answers). Writes try/repeat-acceptance/<tree>-<n>.txt (OUT= another folder; TREES= which
# trees, default "del start") and prints a line per run.
set -u
V=/mnt/data/tmp/34blYpxEcHMAf4oafuC2W
N=${1:-10}
O=${OUT:-$V/try/repeat-acceptance}; mkdir -p "$O"
export TMPDIR=$V/tmp
. $V/scripts/memgate.sh
F=src/components/WorkspaceView.acceptanceConfirmationCard.test.tsx
for i in $(seq 1 "$N"); do
  for tree in ${TREES:-del start}; do
    case $tree in del) T=/root/.orbit/worktrees/ba9b2bbb-b78b-5991-855c-183de0d5d9e3 ;; start) T=$V/start ;; esac
    out=$O/$tree-$i.txt
    if [ -s "$out" ] && grep -q '^exit=' "$out"; then continue; fi
    memgate
    { echo "tree $tree $(git -C $T rev-parse --short HEAD) run $i $(date -u +%FT%TZ) load $(cut -d' ' -f1-3 /proc/loadavg)"
      (cd $T/src/web && scoped nice npx vitest run --maxWorkers=1 $F 2>&1 | sed 's/\x1b\[[0-9;]*m//g'; echo "exit=${PIPESTATUS[0]}"); } > "$out"
    echo "$tree $i: $(grep -E '^\s+Tests ' "$out" | tr -s ' ') $(grep -E '^\s+× ' "$out" | sed -E 's/^\s+× //; s/ [0-9]+ms$//' | tr '\n' ';') $(grep '^exit=' "$out")"
  done
done
