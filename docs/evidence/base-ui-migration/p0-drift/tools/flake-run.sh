#!/usr/bin/env bash
# Usage: flake-run.sh <tree-short> <label> <scenarios: original|fixed> <playwright args...>
set -uo pipefail
B=/var/tmp/p0drift
REPO=/root/.orbit/worktrees/e65f238b-4789-5587-b24a-cf2d708322d1
SHORT=$1 LABEL=$2 VARIANT=$3; shift 3
RUN=$B/flake-runs/$LABEL
mkdir -p "$RUN"
cp -r "$B/runner-template" "$RUN/runner"
ln -s "$REPO/node_modules" "$RUN/runner/node_modules"
cp "$B/flake/announce-duplicate.browser.mjs" "$B/flake/toast-geometry.browser.mjs" "$B/flake/flake.config.mjs" "$RUN/runner/src/web/ui-migration/"
[ "$VARIANT" = fixed ] && cp "$REPO/src/web/ui-migration/page-scenarios.mjs" "$RUN/runner/src/web/ui-migration/page-scenarios.mjs"
sha256sum "$RUN"/runner/src/web/ui-migration/*.mjs > "$RUN/sources.sha256"
cd "$RUN/runner"
env -u FORCE_COLOR -u PUBLIC_ORIGIN NO_COLOR=1 DRIFT_SNAPSHOTS="$RUN/snapshots" DRIFT_OUTPUT="$RUN/output" DRIFT_APP="$B/trees/$SHORT/src/web" \
  unshare -n bash -c 'ip link set lo up && exec "$@"' bash node node_modules/@playwright/test/cli.js test --config src/web/ui-migration/flake.config.mjs "$@" > "$RUN/output.txt" 2>&1
code=$?
echo "# exit $code" >> "$RUN/output.txt"
python3 -c "
import json,sys
r=json.load(open('$RUN/output/report.json'))
fails=[]
def visit(s):
    for sp in s.get('specs',[]):
        for t in sp['tests']:
            for res in t['results']:
                if res['status'] not in ('passed','skipped'):
                    fails.append((t['projectName'], sp['title'], (res.get('errors') or [{}])[0].get('message','').split('\n')[2:4]))
    for c in s.get('suites',[]): visit(c)
[visit(s) for s in r['suites']]
print(json.dumps({'label':'$LABEL','exit':$code,'stats':r['stats'],'failedResults':len(fails),'failures':fails[:40]}))
" | tee "$RUN/summary.json"
