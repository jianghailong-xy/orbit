#!/usr/bin/env bash
# Usage: round.sh <tree> <outdir>
# One official P0 round: netns-regression.sh (the unchanged P0 command in its own network namespace), then the
# profile tests' evidence.json (requests, unhandled, captures, page errors) and summarize-report.py's summary.
T=$1 OUT=$2
nice -n -10 /var/tmp/p0d3/scripts/netns-regression.sh "$T" "$OUT"
code=$?
mkdir -p "$OUT/profile-evidence"
for d in "$T"/src/web/.ui-migration-results/pages.browser.mjs-profile-*; do
  [ -f "$d/evidence.json" ] && cp "$d/evidence.json" "$OUT/profile-evidence/${d##*pages.browser.mjs-profile-}.json"
done
python3 /var/tmp/p0d3/scripts/summarize-report.py "$OUT/report.json" "$OUT/sources.json" > "$OUT/summary.json"
cmp -s "$OUT/environment.json" "$T/docs/evidence/base-ui-migration/p0.2/environment.json" && echo "environment.json == p0.2/environment.json ($(sha256sum < "$OUT/environment.json" | cut -c1-64))" > "$OUT/environment-check.txt" || echo "environment DIFFERENT" > "$OUT/environment-check.txt"
cat "$OUT/environment-check.txt"
exit $code
