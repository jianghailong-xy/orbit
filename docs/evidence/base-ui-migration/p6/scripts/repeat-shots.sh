#!/usr/bin/env bash
# repeat-shots.sh RUN: the delivered fixture cases whose screenshots differed between base and delivery yet matched on two
# delivery runs, for a state caught while a transition ran (a field's border while its popup leaves, a hovered trigger,
# a button just clicked): each run --repeat-each 4 on the delivery and on the base (the delivery's spec files), in the
# projects where they differed, so a screenshot that moves between runs of one tree is told from one that differs
# between the trees. Logs and JSON reports in v1/RUN/repeat-shots; the base's spec files are put back afterwards.
set -u
RUN=${1:?run name}
T=/mnt/data/tmp/34Za39RS6A28G7xPqMD0p
V=$T/v1
R=$V/$RUN/repeat-shots
export TMPDIR=$V/tmp
mkdir -p "$R"
CASES=(
  "choices|normal bottom entrance and exit motion of [a-z]+ stays in view|chromium-dark-phone chromium-light-desktop chromium-light-phone chromium-dark-desktop webkit-light-desktop webkit-light-phone webkit-dark-phone"
  "toasts|exit keeps its own native progress through modal transfers with no-preference motion|webkit-dark-desktop"
)
for f in choices-motion.browser.mjs toasts-promotion.browser.mjs; do cp $V/del/src/web/ui-migration/$f $V/base/src/web/ui-migration/$f; done
for tree in del base; do
  for item in "${CASES[@]}"; do
    IFS='|' read -r config title projects <<< "$item"
    name=$tree-$config
    for i in $(seq 1 60); do [ "$(free -m | awk '/Mem:/{print $7}')" -ge 4608 ] && break; sleep 30; done
    args=(); for p in $projects; do args+=(--project "$p"); done
    { echo "tree: $V/$tree"; echo "head: $(git -C $V/$tree rev-parse HEAD)"; echo "case: $config / $title / $projects x4"; echo "load: $(cat /proc/loadavg)"; echo "started: $(date -u +%FT%TZ)"; echo; } > "$R/$name.txt"
    ( cd $V/$tree/src/web && rm -rf .$config-results && systemd-run --scope --quiet -p MemoryMax=6G sh -c 'echo 500 > /proc/self/oom_score_adj && exec "$@"' sh \
        unshare -n bash -c 'ip link set lo up && exec "$@"' bash npx playwright test --config ui-migration/$config.config.mjs "${args[@]}" -g "$title" --repeat-each 4 ) >> "$R/$name.txt" 2>&1
    echo "exit=$?" >> "$R/$name.txt"
    cp $V/$tree/src/web/.$config-results/report.json "$R/$name.report.json" 2>/dev/null
    echo "== $name: $(grep -E '^\s+[0-9]+ (passed|failed|flaky)' "$R/$name.txt" | tr -s ' ' | tr '\n' ' ')"
  done
done
git -C $V/base checkout -q -- src/web/ui-migration
echo "base spec files restored: [$(git -C $V/base status --short -- src/web/ui-migration | tr '\n' ' ')]"
# Per (test, project, screenshot): how many distinct images each tree drew over its runs, and whether the trees share one.
python3 -I - "$R" <<'PY'
import base64, hashlib, json, sys
from collections import defaultdict
r = sys.argv[1]
for config in ('choices', 'toasts'):
    seen = defaultdict(lambda: {'del': set(), 'base': set()})
    for tree in ('del', 'base'):
        report = json.load(open(f'{r}/{tree}-{config}.report.json'))
        def walk(suite, file):
            file = suite.get('file', file)
            for child in suite.get('suites', []): walk(child, file)
            for spec in suite.get('specs', []):
                for test in spec['tests']:
                    for result in test['results']:
                        for a in result.get('attachments', []):
                            if a.get('contentType') == 'image/png' and a.get('body'):
                                seen[(spec['title'], test['projectName'], a['name'])][tree].add(hashlib.sha1(base64.b64decode(a['body'])).hexdigest())
        for suite in report['suites']: walk(suite, suite.get('file'))
    rows = sorted(seen.items())
    moving = sum(1 for _, s in rows if len(s['del']) > 1 or len(s['base']) > 1)
    shared = sum(1 for _, s in rows if s['del'] & s['base'])
    print(f'== {config}: {len(rows)} screenshots; moving within a tree: {moving}; an image both trees drew: {shared}; '
          f'one fixed image per tree, different: {sum(1 for _, s in rows if len(s["del"]) == len(s["base"]) == 1 and not (s["del"] & s["base"]))}')
    for (title, project, name), s in rows:
        if len(s['del']) == len(s['base']) == 1 and not (s['del'] & s['base']): print(f'   fixed and different: {title[:70]} › {project} › {name}')
PY
