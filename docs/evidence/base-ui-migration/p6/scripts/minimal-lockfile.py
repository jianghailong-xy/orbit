#!/usr/bin/env python3
"""The lockfile without antd, and nothing else changed.

usage: minimal-lockfile.py BEFORE UNINSTALLED RELOCKED OUT

BEFORE      the lockfile at the start commit;
UNINSTALLED what `npm uninstall antd -w @orbit/web` (npm 11.19.1) wrote from it;
RELOCKED    what `npm install --package-lock-only` wrote from BEFORE with no dependency changed.

npm rewrites a stale lockfile while it removes a package: on BEFORE it also drops 51 optional peer entries of
esbuild and syncs the root version, and does the same with nothing changed (RELOCKED). So the entries antd took
with it are the ones UNINSTALLED drops and RELOCKED keeps. OUT is BEFORE without exactly those entries, with
`antd` gone from src/web's dependencies, in BEFORE's order and formatting (npm's JSON, 2-space indent). The script
fails if UNINSTALLED adds or changes an entry beyond that, or if a remaining entry still depends on a removed name.
"""
import json
import sys

before_path, uninstalled_path, relocked_path, out_path = sys.argv[1:5]
before = json.load(open(before_path))
uninstalled = json.load(open(uninstalled_path))
relocked = json.load(open(relocked_path))
pb, pu, pr = before['packages'], uninstalled['packages'], relocked['packages']

normalized = {key for key in pb if key not in pr}
dropped = {key for key in pb if key not in pu}
taken = sorted(dropped - normalized)
assert not [key for key in pu if key not in pb], 'npm uninstall added entries'
changed = sorted(key for key in pu if key in pb and pu[key] != pb[key])
assert changed == ['', 'src/web'], f'npm uninstall changed more than the root and src/web: {changed}'
assert pu['src/web'] == {**pb['src/web'], 'dependencies': {k: v for k, v in pb['src/web']['dependencies'].items() if k != 'antd'}}

out = json.loads(json.dumps(before))
for key in taken:
    del out['packages'][key]
out['packages']['src/web']['dependencies'] = pu['src/web']['dependencies']

# No remaining entry may depend on a name only the removed entries provided.
name = lambda key: key.rsplit('node_modules/', 1)[-1]
remaining_names = {name(key) for key in out['packages'] if key}
removed_names = {name(key) for key in taken} - remaining_names
for key, entry in out['packages'].items():
    for section in ('dependencies', 'optionalDependencies', 'peerDependencies'):
        hit = sorted(set(entry.get(section, {})) & removed_names)
        assert not hit, f'{key} still {section} on {hit}'

with open(out_path, 'w') as handle:
    handle.write(json.dumps(out, indent=2, ensure_ascii=False) + '\n')
print(json.dumps({'removed': len(taken), 'normalizedByNpmAlone': len(normalized), 'entries': [name(key) for key in taken]}, indent=1))
