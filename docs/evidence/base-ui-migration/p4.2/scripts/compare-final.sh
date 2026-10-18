#!/usr/bin/env bash
# The delivery's screenshots on the final tip a794459b1 (final-v2.sh, runs-final/g-*) set beside the same
# runs on 822c00ff0 (formal-v2.sh, runs/f-*): whether merging origin/main 710c66e6d changed anything the
# P4.2 states, the P0 page matrix, the P4.1 spec or the P3.2 pilot draw. Same tools and classes as
# analyze-v2.sh (p3.2/compare_runs.py, p4.1/summarize.py); "reference" here is the 822c00ff0 run. Written to
# v2/compare-final. Only reads the runs.
set -u
V=/mnt/data/tmp/34Za39Feocgj42rrBYwzl/v2
C=$V/compare-final
E=/root/.orbit/worktrees/2a435fb0-2ac5-5226-839d-0b1389da291c/docs/evidence/base-ui-migration
mkdir -p "$C"
pair() {
  local name=$1 before=$2 after=$3
  python3 -I "$E/p3.2/compare_runs.py" "$before-shots" "$after-shots" "$before-out/report.json" "$after-out/report.json" "$C/$name-compare.json" > /dev/null
  python3 -I "$E/p4.1/summarize.py" "$C/$name-compare.json" > "$C/$name-summary.json"
  python3 -I "$V/scripts/beyond-clusters.py" "$C/$name-summary.json" "$before-shots" "$after-shots" > "$C/$name-beyond-clusters.txt"
  python3 -I -c "import json,sys; s=json.load(open(sys.argv[1])); print(sys.argv[2], json.dumps(s['screenshots']), 'beyond', [b['shot'] for b in s['beyond']], 'styles', len(s['styleDeltas']), 'traces', json.dumps({k: v for k, v in s['traces'].items() if k != 'differing'}))" "$C/$name-summary.json" "$name"
}
pair final-p42 "$V/runs/f-p42-del" "$V/runs-final/g-p42-del"
python3 -I "$E/p4.2/trace-semantics.py" "$V/runs/f-p42-del-out/report.json" "$V/runs-final/g-p42-del-out/report.json" > "$C/final-p42-trace-semantics.json"
pair final-p0 "$V/runs/f-p0-del" "$V/runs-final/g-p0-del"
pair final-p41 "$V/runs/f-p41-del" "$V/runs-final/g-p41-del"
pair final-pilot "$V/runs/pilot-del" "$V/runs-final/g-pilot-del"
