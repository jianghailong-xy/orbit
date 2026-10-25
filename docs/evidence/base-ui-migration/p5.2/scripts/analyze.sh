#!/usr/bin/env bash
# analyze.sh RUN [WT]: the comparisons of a formal run (formal.sh RUN), written to v1/compare-RUN: the P5.2 pair
# (screenshots, computed styles, traces, the traces field by field and the runtime AntD census) and the P0 matrix pair.
# Only reads the runs. (P4.4's analyze.sh, for P5.2.)
set -u
RUN=${1:?run name}
V=/mnt/data/tmp/34Za39Mm04q5p66pqUTtj/v1
R=$V/$RUN
C=$V/compare-$RUN
E=/root/.orbit/worktrees/6d689aae-2d33-526f-af1f-826adf954c6d/docs/evidence/base-ui-migration
mkdir -p "$C"
pair() {
  local name=$1 ref=$2 del=$3
  python3 -I "$E/p3.2/compare_runs.py" "$R/$ref-shots" "$R/$del-shots" "$R/$ref-out/report.json" "$R/$del-out/report.json" "$C/$name-compare.json" > /dev/null
  python3 -I "$E/p4.1/summarize.py" "$C/$name-compare.json" > "$C/$name-summary.json"
  python3 -I "$E/p4.2/scripts/beyond-clusters.py" "$C/$name-summary.json" "$R/$ref-shots" "$R/$del-shots" > "$C/$name-beyond-clusters.txt"
  python3 -I -c "import json,sys; s=json.load(open(sys.argv[1])); print(sys.argv[2], json.dumps(s['screenshots']), 'tests', json.dumps({k: (len(v) if isinstance(v, list) else v) for k, v in s['tests'].items()}), 'traces', json.dumps({k: v for k, v in s['traces'].items() if k != 'differing'}))" "$C/$name-summary.json" "$name"
}
pair p52 p52-ref p52-del
python3 -I "$E/p5.2/scripts/trace-semantics.py" "$R/p52-ref-out/report.json" "$R/p52-del-out/report.json" > "$C/p52-trace-semantics.json"
echo "trace-semantics exit $?"
python3 -I -c "import json,sys; d=json.load(open(sys.argv[1])); print('steps', d['steps'], 'semantic differences', len(d['semantic']), 'missing', len(d['missing']), 'antd', {k: (v['steps'], v['classes']) for k, v in d['antd'].items()}, 'viewer names differing', d['presentation']['viewerName']['differing'])" "$C/p52-trace-semantics.json"
[ -f "$R/p0-ref-out/report.json" ] && pair p0 p0-ref p0-del
