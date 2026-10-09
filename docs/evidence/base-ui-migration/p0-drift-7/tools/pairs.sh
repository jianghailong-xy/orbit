#!/usr/bin/env bash
# Usage: pairs.sh <a> <b> [<a> <b> ...]
# compare.cjs for each pair of runs (run labels without full-; "expected" = the expectation assembled at the start),
# into $B/cmp/<a>__<b>.json, then one summary line per pair (compare-summary.py) and the below-threshold changes.
B=/mnt/data/tmp/34cswWfvNasFTq8kDM0Q4
snap() { case "$1" in expected) echo "$B/expected-start" ;; registered) echo "$B/expected-registered" ;; *) echo "$B/runs/full-$1/snapshots" ;; esac; }
outs=()
while [ $# -ge 2 ]; do
  o=$B/cmp/$1__$2.json; outs+=("$o")
  [ -f "$o" ] || nice -n 5 node $B/scripts/compare.cjs "$(snap $1)" "$(snap $2)" "$o" > /dev/null || exit 1
  shift 2
done
python3 $B/scripts/compare-summary.py $B/cmp/summary-last.json "${outs[@]}"
python3 - "${outs[@]}" <<'PY'
import json, sys
for p in sys.argv[1:]:
    for r in json.load(open(p))['rows']:
        if r.get('class') == 'changed' and r['p0Comparator'] == 'match':
            print('  below threshold:', p.split('/')[-1][:-5], r['file'], r['differentPixels'], 'px, channel', r['maxChannelDelta'], r['box'])
PY
