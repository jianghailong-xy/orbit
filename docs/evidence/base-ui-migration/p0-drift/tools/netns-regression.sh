#!/usr/bin/env bash
# Usage: netns-regression.sh <tree> <outdir> [playwright args] — the unchanged P0 command
# `NO_COLOR=1 npm run test:ui-migration -w @orbit/web` in <tree>, inside its own network namespace
# (so 127.0.0.1:4173 is free), then keeps the report, environment and expected-screenshot sources.
TREE=$1 OUT=$2; shift 2
mkdir -p "$OUT"
unshare -n bash -c 'ip link set lo up && cd "$0" && NO_COLOR=1 npm run test:ui-migration -w @orbit/web -- "$@"' "$TREE" "$@" > "$OUT/command-output.txt" 2>&1
code=$?
for f in report.json environment.json expected-screenshots/sources.json; do cp "$TREE/src/web/.ui-migration-results/$f" "$OUT/" 2>/dev/null; done
echo "exit $code" | tee "$OUT/exit.txt"
exit $code
