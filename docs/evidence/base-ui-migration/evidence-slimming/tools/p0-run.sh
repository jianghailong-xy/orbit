#!/usr/bin/env bash
# Usage: p0-run.sh <label>
# One full P0 browser regression through the normal entry (NO_COLOR=1 npm run test:ui-migration -w @orbit/web)
# in this session's worktree, inside a private network namespace (127.0.0.1:4173 is this run's alone).
# Keeps the run's report, output and environment under uploads/p0-runs/<label>/ before the next run rebuilds
# src/web/.ui-migration-results. Resumable: a finished run (meta.json with "exit") is kept, not repeated.
set -uo pipefail
REPO=/root/.orbit/worktrees/4825540a-7870-5715-ba49-c850eac0e081
OUT=/root/.orbit/uploads/4825540a-7870-5715-ba49-c850eac0e081/p0-runs/$1
if [ -f "$OUT/meta.json" ] && grep -q '"exit"' "$OUT/meta.json"; then echo "$1: kept (already finished)"; cat "$OUT/meta.json"; exit 0; fi
rm -rf "$OUT"; mkdir -p "$OUT"
cd "$REPO"
printf '{"label": "%s", "head": "%s", "srcTree": "%s", "evidenceTree": "%s", "dirty": "%s", "started": "%s"}\n' \
  "$1" "$(git rev-parse HEAD)" "$(git rev-parse HEAD:src)" "$(git rev-parse HEAD:docs/evidence/base-ui-migration)" \
  "$(git status --porcelain | wc -l)" "$(date -u +%FT%TZ)" > "$OUT/meta.start.json"
unshare -n bash -c 'ip link set lo up && cd "$0" && exec nice -n -10 env -u FORCE_COLOR -u PUBLIC_ORIGIN NO_COLOR=1 npm run test:ui-migration -w @orbit/web' \
  "$REPO" > "$OUT/output.txt" 2>&1
code=$?
R=$REPO/src/web/.ui-migration-results
cp "$R/report.json" "$OUT/report.json" 2>/dev/null
cp "$R/environment.json" "$OUT/environment.json" 2>/dev/null
cp "$R/expected-screenshots/sources.json" "$OUT/expected-sources.json" 2>/dev/null
cmp -s "$OUT/environment.json" "$REPO/docs/evidence/base-ui-migration/p0.2/environment.json" && env=p0.2 || env=DIFFERENT
python3 -I - "$OUT" "$code" "$env" <<'PY'
import json, sys, time
out, code, env = sys.argv[1:]
m = json.load(open(out + '/meta.start.json'))
m.update(finished=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), exit=int(code), environment=env)
try:
    r = json.load(open(out + '/report.json'))
    m['stats'] = {k: r['stats'].get(k) for k in ('expected', 'unexpected', 'flaky', 'skipped')}
    tests = []
    def walk(suite, path):
        for spec in suite.get('specs', []):
            for t in spec['tests']:
                tests.append({'project': t['projectName'], 'file': spec['file'], 'title': ' > '.join(path + [spec['title']]),
                              'status': t['status'], 'expectedStatus': t['expectedStatus'],
                              'results': [x['status'] for x in t['results']]})
        for s in suite.get('suites', []):
            walk(s, path + [s['title']])
    for s in r['suites']:
        walk(s, [])
    tests.sort(key=lambda t: (t['file'], t['title'], t['project']))
    json.dump(tests, open(out + '/tests.json', 'w'), indent=1)
    m['tests'] = len(tests)
    m['failed'] = [f"{t['project']} | {t['file']} | {t['title']}" for t in tests if t['status'] == 'unexpected']
except Exception as e:
    m['stats'] = 'no report: %s' % e
json.dump(m, open(out + '/meta.json', 'w'), indent=1)
print(json.dumps(m, indent=1))
PY
rm -f "$OUT/meta.start.json"
exit $code
