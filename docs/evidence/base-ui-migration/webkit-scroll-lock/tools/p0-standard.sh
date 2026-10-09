#!/usr/bin/env bash
# Usage: p0-standard.sh <tree> <outdir> [playwright args] — the unchanged P0 command
# `NO_COLOR=1 npm run test:ui-migration -w @orbit/web` in <tree> (pretest builds shared and web), in a
# private network namespace (as p0-drift/tools/netns-regression.sh), then keeps the report, the environment
# record, the expected-screenshot sources and the failed tests' actual/expected/diff images.
set -uo pipefail
T=$1 OUT=$2; shift 2
if [ -e "$OUT" ]; then echo "refusing: $OUT exists"; exit 2; fi
mkdir -p "$OUT"
(cd "$T" && git rev-parse HEAD && git status --short) > "$OUT/tree.txt"
start=$(date -u +%FT%TZ)
cd "$T"
env -u FORCE_COLOR -u PUBLIC_ORIGIN TMPDIR=/mnt/data/tmp/34cBi0yt6bFcSmbJFgDPj/tmp nice -n "${NICE:--10}" \
  unshare -n bash -c 'ip link set lo up && NO_COLOR=1 npm run test:ui-migration -w @orbit/web -- "$@"' bash "$@" > "$OUT/command-output.txt" 2>&1
code=$?
R=$T/src/web/.ui-migration-results
for f in report.json environment.json expected-screenshots/sources.json; do cp "$R/$f" "$OUT/" 2>/dev/null; done
(cd "$R" && find . -name '*-actual.png' -o -name '*-expected.png' -o -name '*-diff.png' | while read -r f; do mkdir -p "$OUT/failed/$(dirname "$f")"; cp "$f" "$OUT/failed/$f"; done)
echo "commit $(git -C "$T" rev-parse HEAD) exit $code start $start end $(date -u +%FT%TZ)" | tee "$OUT/summary.txt"
tail -8 "$OUT/command-output.txt"
exit $code
