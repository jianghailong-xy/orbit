#!/usr/bin/env bash
# Usage: same-commit-originals.sh <tree> <outdir> [playwright selection...]
# p0-drift/tools/same-commit-originals.sh with its paths made parameters. The P0 tests of <tree> (that
# commit's own harness, scenarios and configuration, through p0-drift/tools/drift.config.mjs) with every
# screenshot written to <outdir>/snapshots (--update-snapshots=all, the P3.1 same-commit method) and the
# preview server started in <tree>/src/web, inside a private network namespace (127.0.0.1:4173 is this
# run's alone), after the same build as pretest:ui-migration. Default selection: the 252-screenshot matrix
# (pages, states, breakpoints). Keeps the build and test output, the report, the run's environment record
# and the SHA-256 of every screenshot; meta.json says whether the environment record equals P0.2's.
set -uo pipefail
REPO=$(cd "$(dirname "$0")" && git rev-parse --show-toplevel)
T=$(cd "$1" && pwd) OUT=$2; shift 2
[ $# -gt 0 ] || set -- pages.browser.mjs states.browser.mjs breakpoints.browser.mjs
test -z "$(git -C "$T" status --porcelain --untracked-files=no)" || { echo "$T has tracked changes"; exit 2; }
rm -rf "$OUT"; mkdir -p "$OUT"
COMMIT=$(git -C "$T" rev-parse HEAD)
STARTED=$(date -u +%FT%TZ)
cp "$REPO/docs/evidence/base-ui-migration/p0-drift/tools/drift.config.mjs" "$T/src/web/ui-migration/drift.config.mjs"
(cd "$T" && npm run build -w @orbit/shared && npm run build -w @orbit/web) > "$OUT/build.txt" 2>&1 || { echo "build failed"; exit 2; }
(cd "$T/src/web/dist" && find . -type f | LC_ALL=C sort | xargs sha256sum) > "$OUT/dist.sha256"
cd "$T/src/web"
env -u FORCE_COLOR -u PUBLIC_ORIGIN NO_COLOR=1 DRIFT_SNAPSHOTS="$OUT/snapshots" DRIFT_OUTPUT="$OUT/output" DRIFT_APP="$T/src/web" \
  unshare -n bash -c 'ip link set lo up && exec "$@"' bash npx playwright test --config ui-migration/drift.config.mjs --update-snapshots=all "$@" > "$OUT/output.txt" 2>&1
code=$?
cp "$T/src/web/.ui-migration-results/environment.json" "$OUT/environment.json"
(cd "$OUT/snapshots" 2>/dev/null && find . -name '*.png' | LC_ALL=C sort | xargs sha256sum) > "$OUT/snapshots.sha256"
python3 - "$OUT" "$COMMIT" "$code" "$STARTED" "$REPO/docs/evidence/base-ui-migration/p0.2/environment.json" "$*" <<'PY'
import hashlib, json, sys, time
out, commit, code, started, p02, args = sys.argv[1:]
sha = lambda p: hashlib.sha256(open(p, 'rb').read()).hexdigest()
m = {'commit': commit, 'args': args, 'started': started, 'finished': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'exit': int(code),
     'environmentSha256': sha(out + '/environment.json'), 'environmentEqualsP02': sha(out + '/environment.json') == sha(p02),
     'screenshots': sum(1 for _ in open(out + '/snapshots.sha256'))}
try:
    s = json.load(open(out + '/output/report.json'))['stats']; m['stats'] = {k: s.get(k) for k in ('expected', 'unexpected', 'flaky', 'skipped')}
except Exception as e:
    m['stats'] = str(e)
json.dump(m, open(out + '/meta.json', 'w'), indent=1)
print(json.dumps(m))
PY
exit $code
