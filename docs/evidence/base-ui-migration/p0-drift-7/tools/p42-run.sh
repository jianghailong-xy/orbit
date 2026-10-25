#!/usr/bin/env bash
# Usage: p42-run.sh <tree> <label>
# The P4.2 same-commit cases as the P4.2 README「复现」and P4.3b's formal.sh run them, in <tree>'s src/web:
# `P42_SNAPSHOTS=<dir> P42_OUTPUT=<dir> npx playwright test --config ui-migration/p42.config.mjs --update-snapshots=all`
# (screenshots go to a scratch directory and are compared between trees afterwards; a test passes when every step
# and assertion holds), in a private network namespace so 127.0.0.1:4173 is this run's alone. The tree must hold
# its production build (src/web/dist). Keeps the command output, exit code and the attachment-free report.
B=/mnt/data/tmp/34cswWfvNasFTq8kDM0Q4
export TMPDIR=$B/tmp
T=$1 L=$2
OUT=$B/checks/$L
rm -rf "$OUT"; mkdir -p "$OUT"
{ echo "# tree $T commit $(git -C "$T" rev-parse HEAD) status: $(git -C "$T" status --porcelain | tr '\n' ' ')"
  echo "# argv: P42_SNAPSHOTS=<dir> P42_OUTPUT=<dir> npx playwright test --config ui-migration/p42.config.mjs --update-snapshots=all"
  echo "# started $(date -u +%FT%TZ)"; } > "$OUT/command-output.txt"
unshare -n bash -c 'ip link set lo up && cd "$0/src/web" && exec env -u FORCE_COLOR NO_COLOR=1 P42_SNAPSHOTS="$1" P42_OUTPUT="$2" npx playwright test --config ui-migration/p42.config.mjs --update-snapshots=all' \
  "$T" "$OUT/shots" "$OUT/out" >> "$OUT/command-output.txt" 2>&1
code=$?
echo "# finished $(date -u +%FT%TZ) exit $code" >> "$OUT/command-output.txt"
python3 $B/scripts/report-summary.py "$OUT/out/report.json" "$OUT/report.summary.json"
python3 - "$OUT/out/report.json" <<'PY' | tee "$OUT/summary.txt"
import json, sys
r = json.load(open(sys.argv[1]))
print('stats', {k: r['stats'][k] for k in ('expected', 'unexpected', 'flaky', 'skipped')})
def visit(s, path):
    for sp in s.get('specs', []):
        for t in sp['tests']:
            if t['status'] not in ('expected', 'skipped'):
                print(t['status'], t['projectName'], '›', ' › '.join(path + [sp['title']]))
    for c in s.get('suites', []): visit(c, path + [c['title']])
for s in r['suites']: visit(s, [])
PY
echo "exit $code" | tee "$OUT/exit.txt"
exit $code
