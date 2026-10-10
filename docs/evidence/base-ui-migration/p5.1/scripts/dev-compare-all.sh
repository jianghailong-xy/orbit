#!/usr/bin/env bash
# dev-compare-all.sh NAME: compare the two trees' dev-all runs NAME (shots, styles, traces), print the summary and the
# beyond-level shots with their differing clusters.
set -u
V=/mnt/data/tmp/34Za39L1H6V82d2sobzPY/v1/dev
E=/root/.orbit/worktrees/9f22d16e-3f30-5541-a5ef-91972ffc7911/docs/evidence/base-ui-migration
n=$1; C=$V/compare-$n; mkdir -p "$C"
python3 -I "$E/p3.2/compare_runs.py" "$V/$n-devref/shots" "$V/$n-del/shots" "$V/$n-devref/out/report.json" "$V/$n-del/out/report.json" "$C/compare.json" > /dev/null
python3 -I "$E/p4.1/summarize.py" "$C/compare.json" > "$C/summary.json"
python3 -I "$E/p4.2/scripts/beyond-clusters.py" "$C/summary.json" "$V/$n-devref/shots" "$V/$n-del/shots" > "$C/beyond-clusters.txt"
python3 -I "$E/p5.1/trace-semantics.py" "$V/$n-devref/out/report.json" "$V/$n-del/out/report.json" > "$C/trace-semantics.json"; echo "trace-semantics exit $?"
python3 -I -c "import json,sys; s=json.load(open(sys.argv[1])); print(json.dumps(s['screenshots']), 'tests', json.dumps(s['tests']))" "$C/summary.json"
cat "$C/beyond-clusters.txt"
