#!/usr/bin/env python3
"""Usage: make-reference.py <spec.json>

spec: [{"group", "change", "screenshots": [rel...], "mainCommits": [sha...], "projectLine": [sha...],
        "generatedFrom": <run label of a run on mainCommits[-1]>}]
Copies each registered screenshot from the generation run into the reference layer and writes
registry.json with its provenance: P0.2 hash it replaces, attributed main commits (oldest first),
the generation tree (= last main commit) and the SHA-256 of the environment record that run wrote."""
import hashlib, json, os, shutil, subprocess, sys
B = '/var/tmp/p0drift'
REPO = '/root/.orbit/worktrees/e65f238b-4789-5587-b24a-cf2d708322d1'
EV = f'{REPO}/docs/evidence/base-ui-migration'
sha = lambda p: hashlib.sha256(open(p, 'rb').read()).hexdigest()
full = lambda r: subprocess.check_output(['git', '-C', REPO, 'rev-parse', r], text=True).strip()
p02 = {i['path'].replace('docs/evidence/base-ui-migration/p0.2/screenshots/', ''): i['sha256']
       for i in json.load(open(f'{EV}/p0.2/baseline-run/summary.json'))['images']}
env_p02 = sha(f'{EV}/p0.2/environment.json')
entries = []
for group in json.load(open(sys.argv[1])):
    label = group['generatedFrom']
    run = json.load(open(f'{B}/logs/run-{label}.json'))
    commit = full(run['tree'])
    mains = [full(c) for c in group['mainCommits']]
    assert commit == mains[-1], (label, commit, mains)
    for m in mains:
        subprocess.check_call(['git', '-C', REPO, 'merge-base', '--is-ancestor', m, commit])
    env = sha(f'{B}/runs/{label}/runner/src/web/.ui-migration-results/environment.json')
    assert env == env_p02, f'{label} ran outside the P0.2 environment'
    for rel in group['screenshots']:
        src = f'{B}/runs/{label}/snapshots/{rel}'
        dst = f'{EV}/p0-drift/reference/screenshots/{rel}'
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(src, dst)
        entries.append({'screenshot': rel, 'sha256': sha(dst), 'p0Baseline': p02[rel], 'mainCommits': mains,
                        'generatedFrom': {'commit': commit, 'environment': env, 'run': label},
                        'projectLine': [full(c) for c in group['projectLine']], 'group': group['group'], 'change': group['change']})
entries.sort(key=lambda e: e['screenshot'])
registry = json.load(open(f'{EV}/p0-drift/reference/registry.json'))
registry['screenshots'] = entries
json.dump(registry, open(f'{EV}/p0-drift/reference/registry.json', 'w'), indent=2, ensure_ascii=False)
open(f'{EV}/p0-drift/reference/registry.json', 'a').write('\n')
print(len(entries), 'registered')
