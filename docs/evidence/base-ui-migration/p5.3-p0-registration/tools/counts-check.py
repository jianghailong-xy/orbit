#!/usr/bin/env python3
"""Usage: counts-check.py <repo> <run dir>...

The expectation counts of each P0 run (the assembly line it printed and the layers in its sources.json) against the
registries: main drift references in reference/registry.json, accepted entries in accepted/registry.json by the
decision they cite, and the P5.3 rows of the p0-drift README's accepted list."""
import collections, json, re, sys
repo, *runs = sys.argv[1:]
ev = f'{repo}/docs/evidence/base-ui-migration'
reference = json.load(open(f'{ev}/p0-drift/reference/registry.json'))['screenshots']
accepted = json.load(open(f'{ev}/p0-drift/accepted/registry.json'))['screenshots']
by_decision = collections.Counter(e['decision']['taskId'] for e in accepted)
over = collections.Counter(e['replaces']['layer'] for e in accepted)
print(f'reference/registry.json: {len(reference)} main drift references')
print(f'accepted/registry.json: {len(accepted)} entries, by decision {dict(by_decision)}, replacing {dict(over)}')
expect = (252 - len(reference) - over['p0.2'], len(reference) - over['p0-drift'], len(accepted))
print(f'expected assembly: {expect[0]} P0.2 originals, {expect[1]} main drift references, {expect[2]} accepted migration differences')
readme = open(f'{ev}/p0-drift/README.md', encoding='utf-8').read()
row = next(l for l in readme.split('\n') if l.startswith('| P5.3（'))
print('README accepted-list row for P5.3: entries column =', row.split('|')[3].strip())
ok = True
for run in runs:
    out = open(f'{run}/command-output.txt', encoding='utf-8').read()
    m = re.search(r'P0 expected screenshots: (\d+) P0\.2 originals, (\d+) main drift references, (\d+) accepted migration differences\.', out)
    layers = collections.Counter(v['layer'] for v in json.load(open(f'{run}/sources.json')).values())
    got = tuple(map(int, m.groups()))
    same = got == expect == (layers['p0.2'], layers['p0-drift'], layers['accepted'])
    ok &= same
    print(f'{run}: printed {got}, sources.json {dict(layers)}: {"consistent" if same else "MISMATCH"}')
sys.exit(0 if ok else 1)
