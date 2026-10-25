#!/usr/bin/env bash
# repeat-run.sh TREE PROJECT GREP N NAME: one P5.1 case repeated N times on a tree (del | devref), output under
# v1/dev/NAME. For probing an intermittent observation, not for the record.
set -u
V=/mnt/data/tmp/34Za39L1H6V82d2sobzPY/v1
WT=/root/.orbit/worktrees/9f22d16e-3f30-5541-a5ef-91972ffc7911
tree=$1; project=$2; grep=$3; n=$4; name=$5
dir=$WT; [ "$tree" = del ] || dir=$V/$tree
export TMPDIR=$V/tmp
out=$V/dev/$name
rm -rf "$out"; mkdir -p "$out"
cd "$dir/src/web"
/mnt/data/tmp/34Za39L1H6V82d2sobzPY/scripts/capped.sh 6G unshare -n bash -c 'ip link set lo up && exec "$@"' bash \
  env P51_SNAPSHOTS="$out/shots" P51_OUTPUT="$out/out" npx playwright test --config ui-migration/p51.config.mjs --project "$project" \
  --grep "$grep" --repeat-each "$n" --update-snapshots=all > "$out/log.txt" 2>&1
echo "exit=$?"
grep -E "^\s+[0-9]+ (passed|failed|flaky|skipped)" "$out/log.txt"
python3 - "$out/out/report.json" <<'PY'
import base64, json, sys
def walk(suite):
    for child in suite.get('suites', []): yield from walk(child)
    for spec in suite.get('specs', []):
        for test in spec['tests']:
            for result in test['results']:
                for a in result.get('attachments', []):
                    if a['name'] == 'trace' and 'body' in a:
                        yield json.loads(base64.b64decode(a['body']))
for i, steps in enumerate(t for s in json.load(open(sys.argv[1]))['suites'] for t in walk(s)):
    esc = [s for s in steps if s['step'] == 'escape']
    print(i, [(s['step'], len(s.get('popovers') or []), s['focus']) for s in esc])
PY
