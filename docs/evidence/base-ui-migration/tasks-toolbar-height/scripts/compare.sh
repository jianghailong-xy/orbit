#!/usr/bin/env bash
# compare.sh: P4.3a's cases, base (9c86b3dfe) against delivery (423aa3fdb), with P4.3a's own comparison tools as its
# analyze6.sh uses them: screenshots, computed styles and traces (p3.2/compare_runs.py), the byte-identical /
# anti-aliasing / beyond classes (p4.1/summarize.py), the beyond-level pixel regions (p4.2/scripts/beyond-clusters.py)
# and the traces step by step (p4.3a/trace-semantics.py). Only reads the runs; writes compare/.
set -u
T=/mnt/data/tmp/34coPBqt8gi229cVNds0E
R=$T/runs
C=$T/compare
E=/root/.orbit/worktrees/cc35355c-dd74-5ffe-b8f0-f16dd56d0d48/docs/evidence/base-ui-migration
mkdir -p "$C"
python3 -I "$E/p3.2/compare_runs.py" "$R/p43a-base-shots" "$R/p43a-fix-shots" "$R/p43a-base-out/report.json" "$R/p43a-fix-out/report.json" "$C/p43a-compare.json" > /dev/null
echo "compare_runs exit $?"
python3 -I "$E/p4.1/summarize.py" "$C/p43a-compare.json" > "$C/p43a-summary.json"
python3 -I "$E/p4.2/scripts/beyond-clusters.py" "$C/p43a-summary.json" "$R/p43a-base-shots" "$R/p43a-fix-shots" > "$C/p43a-beyond-clusters.txt"
python3 -I "$E/p4.3a/trace-semantics.py" "$R/p43a-base-out/report.json" "$R/p43a-fix-out/report.json" > "$C/p43a-trace-semantics.json"
echo "trace-semantics exit $?"
python3 -I -c "import json,sys; s=json.load(open(sys.argv[1])); print(json.dumps(s['screenshots']), 'tests', json.dumps(s['tests']), 'traces', json.dumps({k: v for k, v in s['traces'].items() if k != 'differing'}))" "$C/p43a-summary.json"
