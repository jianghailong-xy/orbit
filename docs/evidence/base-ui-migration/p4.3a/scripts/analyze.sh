#!/usr/bin/env bash
# The comparisons of the formal runs (formal.sh), written to v1/compare:
#  - <name>-compare.json: every screenshot pair (bytes equal, or differing pixels, largest channel
#    difference, clusters), computed-style deltas and traces (p3.2/compare_runs.py);
#  - <name>-summary.json: identical / antialias (<=2 per channel) / beyond, with the beyond list
#    (p4.1/summarize.py); <name>-beyond-clusters.txt: the >2-level pixels of each beyond pair, clustered
#    (p4.2/scripts/beyond-clusters.py);
#  - p43a-trace-semantics.json: the P4.3a traces step by step (p4.3a/trace-semantics.py).
# Pairs: P4.3a reference vs delivery, P0 matrix reference vs delivery; P4.1 spec, P4.2 spec and P3.2
# pilot base vs delivery. Only reads the runs.
set -u
V=/mnt/data/tmp/34Za39GvWRQ08ZmKOpFNe/v1
R=$V/runs
C=$V/compare
E=/root/.orbit/worktrees/8682ce7d-8166-5c60-8bec-942544612de2/docs/evidence/base-ui-migration
mkdir -p "$C"
pair() {
  local name=$1 ref=$2 del=$3
  python3 -I "$E/p3.2/compare_runs.py" "$R/$ref-shots" "$R/$del-shots" "$R/$ref-out/report.json" "$R/$del-out/report.json" "$C/$name-compare.json" > /dev/null
  python3 -I "$E/p4.1/summarize.py" "$C/$name-compare.json" > "$C/$name-summary.json"
  python3 -I "$E/p4.2/scripts/beyond-clusters.py" "$C/$name-summary.json" "$R/$ref-shots" "$R/$del-shots" > "$C/$name-beyond-clusters.txt"
  python3 -I -c "import json,sys; s=json.load(open(sys.argv[1])); print(sys.argv[2], json.dumps(s['screenshots']), 'tests', json.dumps(s['tests']), 'traces', json.dumps({k: v for k, v in s['traces'].items() if k != 'differing'}))" "$C/$name-summary.json" "$name"
}
pair p43a p43a-ref p43a-del
python3 -I "$E/p4.3a/trace-semantics.py" "$R/p43a-ref-out/report.json" "$R/p43a-del-out/report.json" > "$C/p43a-trace-semantics.json"
echo "trace-semantics exit $?"
pair p0 p0-ref p0-del
pair p41 p41-base p41-del
pair p42 p42-base p42-del
pair pilot pilot-base pilot-del
