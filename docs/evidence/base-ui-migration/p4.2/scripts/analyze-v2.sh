#!/usr/bin/env bash
# The comparisons of the second version's runs (formal-v2.sh), written to v2/compare:
#  - <name>-compare.json: every screenshot pair (bytes equal, or differing pixels, largest channel
#    difference, clusters), computed-style deltas and traces (p3.2/compare_runs.py);
#  - <name>-summary.json: identical / antialias (<=2 per channel) / beyond, with the beyond list
#    (p4.1/summarize.py); <name>-beyond-clusters.txt: the >2-level pixels of each beyond pair, clustered;
#  - f-p42-trace-semantics.json: the P4.2 traces step by step (p4.2/trace-semantics.py).
# Pairs: P4.2 reference vs delivery, P0 matrix reference vs delivery, P4.1 spec and P3.2 pilot start vs
# delivery. Only reads the runs.
set -u
V=/mnt/data/tmp/34Za39Feocgj42rrBYwzl/v2
R=$V/runs
C=$V/compare
E=/root/.orbit/worktrees/2a435fb0-2ac5-5226-839d-0b1389da291c/docs/evidence/base-ui-migration
mkdir -p "$C"
pair() {
  local name=$1 ref=$2 del=$3
  python3 -I "$E/p3.2/compare_runs.py" "$R/$ref-shots" "$R/$del-shots" "$R/$ref-out/report.json" "$R/$del-out/report.json" "$C/$name-compare.json" > /dev/null
  python3 -I "$E/p4.1/summarize.py" "$C/$name-compare.json" > "$C/$name-summary.json"
  python3 -I "$V/scripts/beyond-clusters.py" "$C/$name-summary.json" "$R/$ref-shots" "$R/$del-shots" > "$C/$name-beyond-clusters.txt"
  python3 -I -c "import json,sys; s=json.load(open(sys.argv[1])); print(sys.argv[2], json.dumps(s['screenshots']), 'tests', json.dumps(s['tests']), 'traces', json.dumps({k: v for k, v in s['traces'].items() if k != 'differing'}))" "$C/$name-summary.json" "$name"
}
pair f-p42 f-p42-ref f-p42-del
python3 -I "$E/p4.2/trace-semantics.py" "$R/f-p42-ref-out/report.json" "$R/f-p42-del-out/report.json" > "$C/f-p42-trace-semantics.json"
echo "trace-semantics exit $?"
pair f-p0 f-p0-ref f-p0-del
pair f-p41 f-p41-base f-p41-del
pair pilot pilot-base pilot-del
