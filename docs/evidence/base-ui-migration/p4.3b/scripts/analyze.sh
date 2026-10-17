#!/usr/bin/env bash
# The comparisons of the formal runs (formal.sh), written to compare/:
#  - <name>-compare.json: every screenshot pair (bytes equal, or differing pixels, largest channel
#    difference, clusters), computed-style deltas and traces (p3.2/compare_runs.py);
#  - <name>-summary.json: identical / antialias (<=2 per channel) / beyond, with the beyond list
#    (p4.1/summarize.py); <name>-beyond-clusters.txt: the >2-level pixels of each beyond pair, clustered;
#  - <name>-trace-semantics.json: the P4.3b traces step by step (trace-semantics.py);
#  - graph-geometry.json: the graph at 639, 641 and 1280px on both trees beside P0.2's records.
# Pairs: P4.3b cases and decision-card page reference vs delivery; P0 matrix reference vs delivery; the
# P3.2 pilot reference vs delivery; P4.1 and P4.2 cases start vs delivery. Only reads the runs.
set -u
V=/mnt/data/tmp/34blYpxEcHMAf4oafuC2W
R=$V/runs
C=$V/compare
S=$V/scripts
E=/root/.orbit/worktrees/ba9b2bbb-b78b-5991-855c-183de0d5d9e3/docs/evidence/base-ui-migration
mkdir -p "$C"
# Resumable: skipped when the formal logs (names, sizes, times) are the ones it last compared.
sig=$(ls -l --time-style=+%s "$R"/*.txt | sha1sum | cut -c1-40)
if [ "$(cat "$C/.done" 2>/dev/null)" = "$sig" ]; then echo "== analyze already done for these runs"; exit 0; fi
pair() {
  local name=$1 ref=$2 del=$3
  [ -f "$R/$ref-out/report.json" ] && [ -f "$R/$del-out/report.json" ] || { echo "$name: missing report"; return; }
  python3 -I "$E/p3.2/compare_runs.py" "$R/$ref-shots" "$R/$del-shots" "$R/$ref-out/report.json" "$R/$del-out/report.json" "$C/$name-compare.json" > /dev/null
  python3 -I "$E/p4.1/summarize.py" "$C/$name-compare.json" > "$C/$name-summary.json"
  python3 -I "$S/beyond-clusters.py" "$C/$name-summary.json" "$R/$ref-shots" "$R/$del-shots" > "$C/$name-beyond-clusters.txt"
  python3 -I -c "import json,sys; s=json.load(open(sys.argv[1])); print(sys.argv[2], json.dumps(s['screenshots']), 'tests', json.dumps({k: (len(v) if isinstance(v, list) else v) for k, v in s['tests'].items()}), 'traces', json.dumps({k: v for k, v in s['traces'].items() if k != 'differing'}))" "$C/$name-summary.json" "$name"
}
pair f-p43b f-p43b-ref f-p43b-del
python3 -I "$S/trace-semantics.py" "$R/f-p43b-ref-out/report.json" "$R/f-p43b-del-out/report.json" > "$C/f-p43b-trace-semantics.json"; echo "f-p43b trace-semantics exit $?"
pair f-cards f-cards-ref f-cards-del
python3 -I "$S/trace-semantics.py" "$R/f-cards-ref-out/report.json" "$R/f-cards-del-out/report.json" > "$C/f-cards-trace-semantics.json"; echo "f-cards trace-semantics exit $?"
pair f-p0 f-p0-ref f-p0-del
pair pilot pilot-ref pilot-del
pair f-p41 f-p41-start f-p41-del
pair f-p42 f-p42-start f-p42-del
python3 -I "$S/graph-geometry.py" "$E/p0.2/baseline-run" "$R" > "$C/graph-geometry.json"; echo "graph-geometry exit $?"
echo "$sig" > "$C/.done"
