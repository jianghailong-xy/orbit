#!/usr/bin/env bash
# Usage: merge-check.sh <tree> <outdir>
# The project's merge check, unchanged: `npm run build -w @orbit/web && npm run test -w @orbit/web` in <tree>.
# Keeps the full output (gzip), a filtered copy (build lines and Vitest's result and summary lines) and the exit code.
export TMPDIR=/mnt/data/tmp/34cswWfvNasFTq8kDM0Q4/tmp
TREE=$1 OUT=$2
mkdir -p "$OUT"
{ echo "# tree $TREE commit $(git -C "$TREE" rev-parse HEAD) status: $(git -C "$TREE" status --porcelain | wc -l) changes"; echo "# argv: npm run build -w @orbit/web && npm run test -w @orbit/web"; echo "# started $(date -u +%FT%TZ)"; } > "$OUT/output-full.txt"
(cd "$TREE" && npm run build -w @orbit/web && npm run test -w @orbit/web) >> "$OUT/output-full.txt" 2>&1
code=$?
echo "# finished $(date -u +%FT%TZ) exit $code" >> "$OUT/output-full.txt"
sed -E 's/\x1b\[[0-9;]*m//g' "$OUT/output-full.txt" | grep -a -E '^# |^> @orbit|^> (tsc|vitest)|vite v|built in|modules transformed|chunks are larger|Test Files|^\s+Tests |Start at|Duration|FAIL' > "$OUT/output-filtered.txt"
gzip -n -f "$OUT/output-full.txt"
echo "exit $code" | tee "$OUT/exit.txt"
exit $code
