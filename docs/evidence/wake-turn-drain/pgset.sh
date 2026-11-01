#!/usr/bin/env bash
# Build once, then run each named pg spec through devpg.sh, one after another; one result line per spec.
set -u
D=/mnt/data/tmp/34pj6T76
OUT="$D/pgx/${PGSET_TAG:-run}"
mkdir -p "$OUT"
"$D/devpg.sh" build > "$OUT/build.txt" 2>&1; echo "build-exit=$?" | tee -a "$OUT/build.txt"
: > "$OUT/summary.txt"
for spec in "$@"; do
  name=$(basename "$spec" .ts)
  "$D/devpg.sh" run "$spec" > "$OUT/$name.txt" 2>&1
  rc=$?
  pass=$(command grep -a -m1 -oE '^ℹ pass [0-9]+' "$OUT/$name.txt" | awk '{print $3}')
  fail=$(command grep -a -m1 -oE '^ℹ fail [0-9]+' "$OUT/$name.txt" | awk '{print $3}')
  skipped=$(command grep -a -m1 -oE '^ℹ skipped [0-9]+' "$OUT/$name.txt" | awk '{print $3}')
  echo "$name rc=$rc pass=${pass:-?} fail=${fail:-?} skipped=${skipped:-?}" | tee -a "$OUT/summary.txt"
done
