#!/usr/bin/env bash
# Usage: merge-check.sh <tree> <outdir> — the project's merge check, unchanged:
#   npm run build -w @orbit/web && npm run test -w @orbit/web
# run in <tree>; keeps the full output, the commit and the exit code.
TREE=$1 OUT=$2
mkdir -p "$OUT"
{ echo "# tree $TREE commit $(git -C "$TREE" rev-parse HEAD) status: $(git -C "$TREE" status --porcelain -- src | tr '\n' ' ')"; echo "# argv: npm run build -w @orbit/web && npm run test -w @orbit/web"; echo "# started $(date -u +%FT%TZ)"; } > "$OUT/output.txt"
(cd "$TREE" && npm run build -w @orbit/web && npm run test -w @orbit/web) >> "$OUT/output.txt" 2>&1
code=$?
echo "# finished $(date -u +%FT%TZ) exit $code" >> "$OUT/output.txt"
echo "exit $code" | tee "$OUT/exit.txt"
exit $code
