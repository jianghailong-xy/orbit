#!/usr/bin/env bash
# Usage: round.sh <tree> <outdir>
# One official P0 round: netns-regression.sh (the unchanged P0 command in its own network namespace), then
# every test's evidence.json digest (captures, requests, unhandled, page errors), the summary of the report,
# the attachment-free report.summary.json and the environment check. As p0-drift-3/tools/round.sh.
B=/mnt/data/tmp/34dI9lY63LC7ZEZHbJ4bG
export TMPDIR=$B/tmp
T=$1 OUT=$2
nice -n -10 $B/scripts/netns-regression.sh "$T" "$OUT"
code=$?
python3 $B/scripts/evidence-digest.py "$T/src/web/.ui-migration-results" "$OUT/evidence-digest.json"
python3 $B/scripts/summarize-report.py "$OUT/report.json" "$OUT/sources.json" > "$OUT/summary.json"
python3 $B/scripts/report-summary.py "$OUT/report.json" "$OUT/report.summary.json"
cmp -s "$OUT/environment.json" "$T/docs/evidence/base-ui-migration/p0.2/environment.json" && echo "environment.json == p0.2/environment.json ($(sha256sum < "$OUT/environment.json" | cut -c1-64))" > "$OUT/environment-check.txt" || echo "environment DIFFERENT" > "$OUT/environment-check.txt"
cat "$OUT/environment-check.txt"
# The full results directory (evidence.json, traces) of this round, kept on /mnt/data until the judgment.
rm -rf "$OUT/results" && cp -a "$T/src/web/.ui-migration-results" "$OUT/results"
python3 -c "import json,sys; s=json.load(open(sys.argv[1])); print(json.dumps({'stats': s['stats'], 'passed': s['passed'], 'expectedFailures': s['expectedFailures'], 'skipped': s['skipped'], 'unexpected': [(u['project'], u['test'], u['screenshot'], u['differentPixels'], (u['error'] or '')[:70]) for u in s['unexpected']]}, indent=1))" "$OUT/summary.json"
exit $code
