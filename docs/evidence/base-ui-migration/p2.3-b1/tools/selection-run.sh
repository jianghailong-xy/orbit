#!/usr/bin/env bash
# Usage: race-run.sh <tree-label> <run-label> [playwright args] — the animation-race diagnosis
# (toasts-race.diag.mjs, toasts configuration) on trees/<tree-label>, in its own network namespace.
B=/var/tmp/p23b1; T=$B/trees/$1; OUT=$B/runs/$2; shift 2
mkdir -p "$OUT"; cp "$B/scripts/toasts-selection.diag.mjs" "$B/scripts/selection.config.mjs" "$T/src/web/ui-migration/"
export B1_OUTPUT=$OUT/output
{ echo "# tree $T commit $(git -C "$T" rev-parse HEAD)"; unshare -n bash -c 'ip link set lo up && cd "$0/src/web" && exec env -u FORCE_COLOR NO_COLOR=1 node ../../node_modules/@playwright/test/cli.js test --config ui-migration/selection.config.mjs "$@"' "$T" "$@"; echo "# exit $?"; } > "$OUT/output.txt" 2>&1
python3 - "$OUT" <<'PY'
import base64, json, sys
out = sys.argv[1]; r = json.load(open(f'{out}/output/report.json')); rows = []
def visit(s):
    for sp in s.get('specs', []):
        for t in sp['tests']:
            for res in t['results']:
                for a in res.get('attachments', []):
                    if a['name'] == 'selection': rows.append({'project': t['projectName'], 'status': res['status'], **json.loads(base64.b64decode(a['body']))})
    for c in s.get('suites', []): visit(c)
for s in r['suites']: visit(s)
json.dump(rows, open(f'{out}/selection.json', 'w'), indent=1)
for x in rows: print(f"{x['project']:24} {x['where']:24} selected differs {x['selectedDiffers']!s:5}  cleared == before {x['clearedEqualsBefore']!s:5}  +500ms == before {x['laterEqualsBefore']!s:5}")
PY
