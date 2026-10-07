#!/usr/bin/env python3
"""Migration cost of this batch, from git: usage cost.py <base> <head> > cost.json (run in the repository).

Lines added/removed under src/web between the two commits, by kind of change: new Orbit components,
changes to existing shared components (and their README/fixture), the business files switched, the
business stylesheet, unit tests and the browser comparison tooling; plus the .ant-* selectors the
business stylesheet had before and after. Reads only."""
import json
import re
import subprocess
import sys

base, head = sys.argv[1:3]
NEW = ('Popconfirm', 'Segmented', 'Avatar', 'Alert')


def kind(path):
    name = path.rsplit('/', 1)[-1]
    if '/ui/__fixtures__/' in path:
        return 'shared-component-fixtures'
    if '/ui-migration/' in path:
        return 'browser-comparison-tooling'
    if re.search(r'\.test\.tsx?$', path):
        return 'unit-tests'
    if '/components/ui/' in path:
        return 'new-components' if name.split('.')[0] in NEW else 'shared-component-changes'
    if path.endswith('/index.css'):
        return 'business-stylesheet'
    return 'business-files'


numstat = subprocess.check_output(['git', 'diff', '--numstat', base, head, '--', 'src/web'], text=True)
kinds = {}
for line in numstat.splitlines():
    added, removed, path = line.split('\t')
    entry = kinds.setdefault(kind(path), {'added': 0, 'removed': 0, 'files': {}})
    entry['added'] += int(added)
    entry['removed'] += int(removed)
    entry['files'][path] = [int(added), int(removed)]


def ant_selectors(ref):
    css = subprocess.check_output(['git', 'show', f'{ref}:src/web/src/index.css'], text=True)
    return len(re.findall(r'\.ant-', css))


json.dump({'base': base, 'head': head, 'kinds': kinds,
           'indexCssAntSelectorMentions': {'base': ant_selectors(base), 'head': ant_selectors(head)}},
          sys.stdout, indent=1)
print()
