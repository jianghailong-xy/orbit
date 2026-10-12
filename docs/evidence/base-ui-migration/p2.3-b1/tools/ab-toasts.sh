#!/usr/bin/env bash
# Usage: ab-toasts.sh <label> <rounds> [playwright args] — runs the same toasts-matrix selection on the
# unmodified project tip (trees/tip, 77233e226) and on the fix (trees/fixab, 83d17f1ca) at the same time,
# each in its own network namespace, <rounds> times, so both see the same machine load. Each round's
# command output and JSON report are kept under runs/<label>/{tip,fix}-<n>/.
set -uo pipefail
B=/var/tmp/p23b1
LABEL=$1 ROUNDS=$2; shift 2
for n in $(seq 1 "$ROUNDS"); do
  for side in tip fixab; do
    "$B/scripts/netns-npm.sh" "$B/trees/$side" "$B/runs/$LABEL/$side-$n" .toasts-results test:ui-toasts "$@" > /dev/null &
  done
  wait
  echo "round $n: tip $(cat $B/runs/$LABEL/tip-$n/exit.txt), fix $(cat $B/runs/$LABEL/fixab-$n/exit.txt) | load $(cut -d' ' -f1-3 /proc/loadavg)"
done
python3 - "$B/runs/$LABEL" <<'PY'
import json, pathlib, sys, collections
root = pathlib.Path(sys.argv[1]); tally = collections.defaultdict(lambda: {'tip': [0, 0], 'fixab': [0, 0]})
for d in sorted(root.iterdir()):
    side = d.name.rsplit('-', 1)[0]
    r = json.loads((d / 'results/report.json').read_text())
    def visit(s):
        for sp in s.get('specs', []):
            for t in sp['tests']:
                for res in t['results']:
                    k = f"{t['projectName']} | {sp['title']}"
                    tally[k][side][0 if res['status'] == 'passed' else 1] += 1
        for c in s.get('suites', []): visit(c)
    for s in r['suites']: visit(s)
out = {k: v for k, v in sorted(tally.items())}
(root / 'tally.json').write_text(json.dumps(out, indent=1) + '\n')
tot = {side: [sum(v[side][0] for v in out.values()), sum(v[side][1] for v in out.values())] for side in ('tip', 'fixab')}
print(json.dumps({'passed/failed': tot, 'failing': {k: v for k, v in out.items() if v['tip'][1] or v['fixab'][1]}}, indent=1))
PY
