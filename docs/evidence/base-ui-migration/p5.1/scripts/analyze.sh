#!/usr/bin/env bash
# analyze.sh RUN: the comparisons of a formal run (formal.sh RUN), written to v1/compare-RUN: the P5.1 pair (screenshots,
# computed styles, traces, the traces step by step and the runtime AntD census) and the P0 matrix pair. Only reads the
# runs. (P4.4's analyze.sh, for P5.1.)
set -u
RUN=${1:?run name}
V=/mnt/data/tmp/34Za39L1H6V82d2sobzPY/v1
R=$V/$RUN
C=$V/compare-$RUN
E=$(cd "$(dirname "$0")/../.." && pwd)
mkdir -p "$C"
pair() {
  local name=$1 ref=$2 del=$3
  python3 -I "$E/p3.2/compare_runs.py" "$R/$ref-shots" "$R/$del-shots" "$R/$ref-out/report.json" "$R/$del-out/report.json" "$C/$name-compare.json" > /dev/null
  python3 -I "$E/p4.1/summarize.py" "$C/$name-compare.json" > "$C/$name-summary.json"
  python3 -I "$E/p4.2/scripts/beyond-clusters.py" "$C/$name-summary.json" "$R/$ref-shots" "$R/$del-shots" > "$C/$name-beyond-clusters.txt"
  python3 -I -c "import json,sys; s=json.load(open(sys.argv[1])); print(sys.argv[2], json.dumps(s['screenshots']), 'tests', json.dumps(s['tests']), 'traces', json.dumps({k: v for k, v in s['traces'].items() if k != 'differing'}))" "$C/$name-summary.json" "$name"
}
pair p51 p51-ref p51-del
python3 -I "$E/p5.1/trace-semantics.py" "$R/p51-ref-out/report.json" "$R/p51-del-out/report.json" > "$C/p51-trace-semantics.json"
echo "trace-semantics exit $?"
python3 -I -c "import json,sys; d=json.load(open(sys.argv[1])); print('antd census', {k: (v['steps'], v['classes']) for k, v in d['antd'].items()})" "$C/p51-trace-semantics.json"
pair p0 p0-ref p0-del
# A case rerun on both trees after it failed in one of them (p51-rerun.sh): its pair, compared as the main pair is.
for ref in "$R"/p51-rerun-ref-*-out; do
  [ -d "$ref" ] || continue
  env=${ref#$R/p51-rerun-ref-}; env=${env%-out}
  pair "p51-rerun-$env" "p51-rerun-ref-$env" "p51-rerun-del-$env"
  python3 -I "$E/p5.1/trace-semantics.py" "$ref/report.json" "$R/p51-rerun-del-$env-out/report.json" > "$C/p51-rerun-$env-trace-semantics.json"
  echo "rerun $env trace-semantics exit $?"
done
