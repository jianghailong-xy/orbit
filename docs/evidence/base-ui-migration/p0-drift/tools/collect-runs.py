#!/usr/bin/env python3
"""Usage: collect-runs.py <out.json>  — index of every attribution run: tree commit, Playwright argv,
per-attempt stats and failures, environment record hash, and the SHA-256 of every screenshot."""
import glob, hashlib, json, os, sys
B = '/var/tmp/p0drift'
sha = lambda p: hashlib.sha256(open(p, 'rb').read()).hexdigest()
index = {}
for run in sorted(glob.glob(f'{B}/runs/*/attempts.json')):
    d = os.path.dirname(run)
    label = os.path.basename(d)
    attempts = json.load(open(run))
    first = json.loads(open(f'{d}/output.txt').readline())
    env = f'{d}/runner/src/web/.ui-migration-results/environment.json'
    shots = {}
    for p in sorted(glob.glob(f'{d}/snapshots/*/*.png')):
        shots[p[len(d) + len('/snapshots/'):]] = sha(p)
    index[label] = {'commit': first['commit'], 'argv': first['argv'], 'started': first['started'],
                    'environmentSha256': sha(env) if os.path.exists(env) else None,
                    'attempts': [{'output': a['output'], 'project': a.get('project'), 'title': a.get('title'), 'stats': a['stats'],
                                  'failed': [[f[0], f[1], (f[2][0] if f[2] else '').replace('\u001b', '')[:300]] for f in a['failed']]} for a in attempts],
                    'screenshots': shots}
json.dump(index, open(sys.argv[1], 'w'), indent=1)
print(len(index), 'runs')
