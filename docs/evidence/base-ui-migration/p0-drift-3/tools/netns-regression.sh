#!/usr/bin/env bash
# Usage: netns-regression.sh <tree> <outdir> [playwright args]
# The unchanged P0 command `NO_COLOR=1 npm run test:ui-migration -w @orbit/web` in <tree>, inside its own
# network namespace (so 127.0.0.1:4173 is private to this run), then keeps the report, environment,
# expected-screenshot sources and the failure attachments. Same as p0-drift/tools/netns-regression.sh.
TREE=$1 OUT=$2; shift 2
mkdir -p "$OUT"
{ echo "# tree $TREE commit $(git -C "$TREE" rev-parse HEAD) status: $(git -C "$TREE" status --porcelain | tr '\n' ' ')"; echo "# argv: NO_COLOR=1 npm run test:ui-migration -w @orbit/web ${*:+-- $*}"; echo "# started $(date -u +%FT%TZ)"; } > "$OUT/command-output.txt"
unshare -n bash -c 'ip link set lo up && cd "$0" && NO_COLOR=1 npm run test:ui-migration -w @orbit/web -- "$@"' "$TREE" "$@" >> "$OUT/command-output.txt" 2>&1
code=$?
echo "# finished $(date -u +%FT%TZ) exit $code" >> "$OUT/command-output.txt"
for f in report.json environment.json expected-screenshots/sources.json; do cp "$TREE/src/web/.ui-migration-results/$f" "$OUT/" 2>/dev/null; done
(cd "$TREE/src/web/.ui-migration-results" && for d in */; do for f in "$d"*-actual.png "$d"*-diff.png "$d"*-expected.png "$d"error-context.md; do [ -f "$f" ] && mkdir -p "$OUT/failures/$d" && cp "$f" "$OUT/failures/$d"; done; done)
echo "exit $code" | tee "$OUT/exit.txt"
exit $code
