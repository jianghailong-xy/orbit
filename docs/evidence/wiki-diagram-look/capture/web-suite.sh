#!/bin/bash
# The whole web suite in 4 shards, each in its own memory-capped scope outside the runner's cgroup; a JSON report per shard.
cd /root/.orbit/worktrees/01a1983d-edb5-76c6-ab76-80ba6672bf4f/src/web || exit 2
out=/mnt/data/tmp/wiki-diagram-look/web-suite
for n in 1 2 3 4; do
  [ -f "$out/shard-$n.json" ] && continue
  echo "== shard $n/4 at $(date -u +%T), MemAvailable $(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo) MB"
  systemd-run --scope --quiet --unit="wdl-web-$n-$$" -p MemoryMax=3G -- bash -c 'echo 900 > /proc/self/oom_score_adj; exec "$0" "$@"' \
    env TZ=UTC timeout 900 npx vitest run --maxWorkers=2 --shard="$n/4" --reporter=dot --reporter=json --outputFile.json="$out/shard-$n.json.part" > "$out/shard-$n.log" 2>&1
  echo "   exit $?"; [ -f "$out/shard-$n.json.part" ] && mv "$out/shard-$n.json.part" "$out/shard-$n.json"
done
python3 -I - "$out" <<'PY'
import json, sys, glob
tot = {'files': 0, 'tests': 0, 'passed': 0, 'failed': 0, 'skipped': 0}
fails = []
for f in sorted(glob.glob(sys.argv[1] + '/shard-*.json')):
    d = json.load(open(f))
    tot['files'] += len(d['testResults']); tot['tests'] += d['numTotalTests']; tot['passed'] += d['numPassedTests']
    tot['failed'] += d['numFailedTests']; tot['skipped'] += d['numPendingTests'] + d.get('numTodoTests', 0)
    for r in d['testResults']:
        for a in r['assertionResults']:
            if a['status'] == 'failed': fails.append(r['name'].split('/src/web/')[-1] + ' :: ' + a['fullName'])
        if r['status'] == 'failed' and not any(a['status'] == 'failed' for a in r['assertionResults']): fails.append(r['name'] + ' :: (file failed) ' + (r.get('message') or '')[:300])
print(json.dumps(tot)); print('\n'.join(fails[:40]))
PY
