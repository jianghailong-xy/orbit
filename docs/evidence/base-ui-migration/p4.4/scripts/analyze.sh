#!/usr/bin/env bash
# analyze.sh RUN: the comparisons of a formal run (formal.sh RUN), written to v1/compare-RUN: the P4.4 pair (screenshots,
# computed styles, traces, the traces step by step and the runtime AntD census) and the P0 matrix pair. Only reads the
# runs. (P4.3a's analyze6.sh, for P4.4.)
set -u
RUN=${1:?run name}
V=/mnt/data/tmp/34Za39J4QY3kDa5p2Wsau/v1
R=$V/$RUN
C=$V/compare-$RUN
E=/root/.orbit/worktrees/a8fc02e5-256c-58d5-bafe-dbd063f08987/docs/evidence/base-ui-migration
mkdir -p "$C"
pair() {
  local name=$1 ref=$2 del=$3
  python3 -I "$E/p3.2/compare_runs.py" "$R/$ref-shots" "$R/$del-shots" "$R/$ref-out/report.json" "$R/$del-out/report.json" "$C/$name-compare.json" > /dev/null
  python3 -I "$E/p4.1/summarize.py" "$C/$name-compare.json" > "$C/$name-summary.json"
  python3 -I "$E/p4.2/scripts/beyond-clusters.py" "$C/$name-summary.json" "$R/$ref-shots" "$R/$del-shots" > "$C/$name-beyond-clusters.txt"
  python3 -I -c "import json,sys; s=json.load(open(sys.argv[1])); print(sys.argv[2], json.dumps(s['screenshots']), 'tests', json.dumps(s['tests']), 'traces', json.dumps({k: v for k, v in s['traces'].items() if k != 'differing'}))" "$C/$name-summary.json" "$name"
}
pair p44 p44-ref p44-del
python3 -I "$E/p4.4/trace-semantics.py" "$R/p44-ref-out/report.json" "$R/p44-del-out/report.json" > "$C/p44-trace-semantics.json"
echo "trace-semantics exit $?"
python3 -I -c "import json,sys; d=json.load(open(sys.argv[1])); print('antd census steps', {k: v['steps'] for k, v in d['antd'].items()})" "$C/p44-trace-semantics.json"
pair p0 p0-ref p0-del
