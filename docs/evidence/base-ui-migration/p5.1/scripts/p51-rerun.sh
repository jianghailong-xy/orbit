#!/usr/bin/env bash
# p51-rerun.sh RUN: every P5.1 case that failed in RUN's p51-ref or p51-del step, run again on both trees in the same
# environment (one Playwright run per tree and environment, --project and --grep), shots and reports under
# RUN/p51-rerun-<tree>-<environment>-{shots,out}, logs as RUN/p51-rerun-<tree>-<environment>.txt. A rerun whose log ends
# with exit= is skipped. Same isolation as formal.sh. (P4.4's p44-rerun.sh, for P5.1.)
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
RUN=${1:?run name}
T=/mnt/data/tmp/34Za39L1H6V82d2sobzPY
V=$T/v1
R=$V/$RUN
export TMPDIR=$V/tmp
python3 - "$R" > "$R/p51-rerun-plan.txt" <<'PY'
import json, re, sys
R = sys.argv[1]
failed = {}
for tree in ('ref', 'del'):
    report = json.load(open(f'{R}/p51-{tree}-out/report.json'))
    def walk(suite):
        for child in suite.get('suites', []): yield from walk(child)
        for spec in suite.get('specs', []):
            for test in spec['tests']:
                if any(result['status'] not in ('passed', 'skipped') for result in test['results']):
                    yield test['projectName'], spec['title']
    for s in report['suites']:
        for project, title in walk(s):
            failed.setdefault(project, set()).add(title)
for project, titles in sorted(failed.items()):
    print(project + '\t' + '|'.join(re.escape(t) for t in sorted(titles)))
PY
cat "$R/p51-rerun-plan.txt"
while IFS=$'\t' read -r project grep; do
  for tree in ref del; do
    name=p51-rerun-$tree-$project
    if [ -f "$R/$name.txt" ] && grep -q '^exit=' "$R/$name.txt"; then echo "== $name already done"; continue; fi
    { echo "argv: --project $project --grep $grep"; echo "tree: $V/$tree"; echo "head: $(git -C $V/$tree rev-parse HEAD)"
      echo "load: $(cat /proc/loadavg)"; echo "started: $(date -u +%FT%TZ)"; echo; } > "$R/$name.txt"
    ( cd "$V/$tree/src/web" && "$HERE/capped.sh" 6G nice -n -5 unshare -n bash -c 'ip link set lo up && exec "$@"' bash \
        env P51_SNAPSHOTS="$R/$name-shots" P51_OUTPUT="$R/$name-out" npx playwright test --config ui-migration/p51.config.mjs \
        --project "$project" --grep "$grep" --update-snapshots=all ) >> "$R/$name.txt" 2>&1
    code=$?
    { echo "exit=$code"; echo "load: $(cat /proc/loadavg)"; echo "ended: $(date -u +%FT%TZ)"; } >> "$R/$name.txt"
    echo "== $name exit=$code"; grep -E "^\s+[0-9]+ (passed|failed|flaky)" "$R/$name.txt"
  done
done < "$R/p51-rerun-plan.txt"
