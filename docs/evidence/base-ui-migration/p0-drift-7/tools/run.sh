#!/usr/bin/env bash
# Usage: run.sh <app-label> <runner> <run-label> [playwright args...]
# The P0 tests of runners/<runner> against the production build of trees/<app-label>, in a private network
# namespace (127.0.0.1:4173 is this run's alone), every screenshot written to runs/<run-label>/snapshots
# (--update-snapshots=all). Default selection: the 252-screenshot matrix (pages, states, breakpoints).
# As p0-drift-3/tools/run.sh, plus a digest of every test's evidence.json (captures, requests, unhandled,
# page errors) and the attachment-free report.summary.json.
set -uo pipefail
B=/mnt/data/tmp/34cswWfvNasFTq8kDM0Q4
export TMPDIR=$B/tmp
APP=$B/trees/$1 RUNNER_T=$B/runners/$2 LABEL=$3; shift 3
RUN=$B/runs/$LABEL
[ -f "$APP/.built" ] || { echo "$APP not built"; exit 2; }
# Resumable: a run that already finished (meta.json has its exit code) is kept, not repeated.
if [ -f "$RUN/meta.json" ] && python3 -c "import json,sys; sys.exit(0 if 'exit' in json.load(open(sys.argv[1])) else 1)" "$RUN/meta.json"; then echo "$LABEL: kept (already finished)"; exit 0; fi
rm -rf "$RUN"; mkdir -p "$RUN"
cp -al "$RUNNER_T" "$RUN/runner"
[ $# -gt 0 ] || set -- pages.browser.mjs states.browser.mjs breakpoints.browser.mjs
python3 - "$RUN" "$APP" "$RUNNER_T" "$*" <<'PY'
import json,sys,time
run,app,runner,args=sys.argv[1:]
json.dump({'app': app, 'commit': open(app+'/.commit').read().strip(), 'runner': runner, 'runnerCommit': open(runner+'/.commit').read().strip(),
           'args': args, 'started': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}, open(run+'/meta.json','w'), indent=1)
PY
unshare -n bash -c 'ip link set lo up && cd "$0/src/web" && exec env -u FORCE_COLOR -u PUBLIC_ORIGIN NO_COLOR=1 P0D7_SNAPSHOTS="$1" P0D7_OUTPUT="$2" P0D7_APP="$3" node ../../node_modules/@playwright/test/cli.js test --config ui-migration/p0d7.config.mjs --update-snapshots=all "${@:4}"' \
  "$RUN/runner" "$RUN/snapshots" "$RUN/output" "$APP/src/web" "$@" > "$RUN/output.txt" 2>&1
code=$?
cp "$RUN/runner/src/web/.ui-migration-results/environment.json" "$RUN/environment.json" 2>/dev/null
cmp -s "$RUN/environment.json" "$RUN/runner/docs/evidence/base-ui-migration/p0.2/environment.json" && env=p0.2 || env=DIFFERENT
(cd "$RUN/snapshots" 2>/dev/null && find . -name '*.png' | LC_ALL=C sort | xargs sha256sum) > "$RUN/snapshots.sha256"
python3 $B/scripts/evidence-digest.py "$RUN/output" "$RUN/evidence-digest.json" > "$RUN/evidence-digest.txt"
python3 $B/scripts/report-summary.py "$RUN/output/report.json" "$RUN/report.summary.json" > /dev/null
python3 - "$RUN" "$code" "$env" <<'PY'
import json,sys,time
run,code,env=sys.argv[1:]
m=json.load(open(run+'/meta.json')); m.update(finished=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), exit=int(code), environment=env)
try:
  s=json.load(open(run+'/output/report.json'))['stats']; m['stats']={k:s.get(k) for k in ('expected','unexpected','flaky','skipped')}
except Exception as e: m['stats']=str(e)
m['screenshots']=sum(1 for _ in open(run+'/snapshots.sha256'))
m['evidence']=json.loads(open(run+'/evidence-digest.txt').read())
json.dump(m, open(run+'/meta.json','w'), indent=1)
print(json.dumps({k:m[k] for k in ('commit','runner','args','exit','environment','stats','screenshots','evidence')}))
PY
rm -rf "$RUN/runner"
