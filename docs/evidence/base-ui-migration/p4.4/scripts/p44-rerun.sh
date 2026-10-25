#!/usr/bin/env bash
# p44-rerun.sh RUN: every P4.4 case that failed in RUN's p44-ref or p44-del step, run again on both trees in the same
# environment (one Playwright run per tree and environment, --project and --grep), shots and reports under
# RUN/p44-rerun-<tree>-<environment>-{shots,out}, logs as RUN/p44-rerun-<tree>-<environment>.txt. A rerun whose log ends
# with exit= is skipped. Same isolation as formal.sh.
set -u
RUN=${1:?run name}
T=/mnt/data/tmp/34Za39J4QY3kDa5p2Wsau
V=$T/v1
R=$V/$RUN
export TMPDIR=$V/tmp
python3 - "$R" > "$R/p44-rerun-plan.txt" <<'PY'
import json, re, sys
R = sys.argv[1]
failed = {}
for tree in ('ref', 'del'):
    report = json.load(open(f'{R}/p44-{tree}-out/report.json'))
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
cat "$R/p44-rerun-plan.txt"
while IFS=$'\t' read -r project grep; do
  for tree in ref del; do
    name=p44-rerun-$tree-$project
    if [ -f "$R/$name.txt" ] && grep -q '^exit=' "$R/$name.txt"; then echo "== $name already done"; continue; fi
    { echo "argv: --project $project --grep $grep"; echo "tree: $V/$tree"; echo "head: $(git -C $V/$tree rev-parse HEAD)"
      echo "load: $(cat /proc/loadavg)"; echo "started: $(date -u +%FT%TZ)"; echo; } > "$R/$name.txt"
    ( cd "$V/$tree/src/web" && systemd-run --scope --quiet -p MemoryMax=6G sh -c 'echo 500 > /proc/self/oom_score_adj && exec "$@"' sh \
        nice -n -5 unshare -n bash -c 'ip link set lo up && exec "$@"' bash \
        env P44_SNAPSHOTS="$R/$name-shots" P44_OUTPUT="$R/$name-out" npx playwright test --config ui-migration/p44.config.mjs \
        --project "$project" --grep "$grep" --update-snapshots=all ) >> "$R/$name.txt" 2>&1
    code=$?
    { echo "exit=$code"; echo "load: $(cat /proc/loadavg)"; echo "ended: $(date -u +%FT%TZ)"; } >> "$R/$name.txt"
    echo "== $name exit=$code"; grep -E "^\s+[0-9]+ (passed|failed|flaky)" "$R/$name.txt"
  done
done < "$R/p44-rerun-plan.txt"
