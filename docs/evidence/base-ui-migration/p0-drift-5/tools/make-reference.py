#!/usr/bin/env python3
"""Usage: make-reference.py <worktree> <spec.json>

Registers main drift references (p0-drift README, main drift rules 4 and 6), as p0-drift-2/tools/make-reference.py:
spec: [{"group", "change": [...], "screenshots": [rel...], "mainCommits": [sha...], "projectLine": [sha...],
        "generatedFrom": <run label of a run on mainCommits[-1]>}]
Copies each screenshot from the generation run, unprocessed, into reference/screenshots and writes its entry:
the P0.2 hash it replaces, the attributed main commits (oldest first), the generation tree (= last main commit)
and the SHA-256 of the environment record the run wrote. An existing entry for the same screenshot (rule 6)
keeps its earlier mainCommits/projectLine/change in front of the new ones, and its group."""
import hashlib, json, os, shutil, subprocess, sys
worktree, spec = sys.argv[1], sys.argv[2]
RUNS = '/mnt/data/tmp/34cFgyWHIYDslABFPloEM/runs'
EV = f'{worktree}/docs/evidence/base-ui-migration'
sha = lambda p: hashlib.sha256(open(p, 'rb').read()).hexdigest()
full = lambda r: subprocess.check_output(['git', '-C', worktree, 'rev-parse', r], text=True).strip()
p02 = {i['path'].replace('docs/evidence/base-ui-migration/p0.2/screenshots/', ''): i['sha256']
       for i in json.load(open(f'{EV}/p0.2/baseline-run/summary.json'))['images']}
env_p02 = sha(f'{EV}/p0.2/environment.json')
path = f'{EV}/p0-drift/reference/registry.json'
registry = json.load(open(path))
entries = {e['screenshot']: e for e in registry['screenshots']}
for group in json.load(open(spec)):
    label = group['generatedFrom']
    meta = json.load(open(f'{RUNS}/{label}/meta.json'))
    assert meta['exit'] is not None and meta['environment'] == 'p0.2', (label, meta)
    assert sha(f'{RUNS}/{label}/environment.json') == env_p02, f'{label} ran outside the P0.2 environment'
    mains = [full(c) for c in group['mainCommits']]
    assert meta['commit'] == mains[-1], (label, meta['commit'], mains)
    for m in mains:
        subprocess.check_call(['git', '-C', worktree, 'merge-base', '--is-ancestor', m, mains[-1]])
    for rel in group['screenshots']:
        src = f'{RUNS}/{label}/snapshots/{rel}'
        dst = f'{EV}/p0-drift/reference/screenshots/{rel}'
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(src, dst)
        old = entries.get(rel)
        keep = lambda key, new: (old[key] + [v for v in new if v not in old[key]]) if old else new
        entry = {'screenshot': rel, 'sha256': sha(dst), 'p0Baseline': p02[rel], 'mainCommits': keep('mainCommits', mains),
                 'generatedFrom': {'commit': mains[-1], 'environment': env_p02, 'run': label},
                 'projectLine': keep('projectLine', [full(c) for c in group['projectLine']]),
                 'group': old['group'] if old else group['group'], 'change': keep('change', group['change'])}
        if old and 'migrationFix' in old:
            raise SystemExit(f'{rel}: an entry with migrationFix is not re-registered by this tool')
        assert entry['mainCommits'][-1] == mains[-1]
        entries[rel] = entry
registry['screenshots'] = [entries[k] for k in sorted(entries)]
json.dump(registry, open(path, 'w'), indent=2, ensure_ascii=False)
open(path, 'a').write('\n')
print(len(registry['screenshots']), 'entries')
