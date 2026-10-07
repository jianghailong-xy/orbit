#!/usr/bin/env python3
"""Close this batch's entries in the P0.1 inventory, from two runs of src/web/scripts/audit-antd.mjs.

usage: inventory-closure.py BEFORE.json AFTER.json > inventory-closure.json

BEFORE is the audit of the same-commit reference tree (the batch's starting point), AFTER the audit
of the delivery. For every file this batch owns or touched, it reports the antd imports and the
audit's hit kinds before and after, and for the whole scan the counts that moved. The pinned P0.1
baseline (audit-baseline.json, ownership.json) is not rewritten: this file is the batch's record.
"""
import json
import sys

before, after = (json.load(open(path)) for path in sys.argv[1:3])
OWNED = {
    # ownership.json phase P3.2
    'src/web/src/components/TaskDetailPanel.tsx': 'P3.2',
    'src/web/src/components/ShareModal.tsx': 'P3.2',
    'src/web/src/components/TaskInputs.tsx': 'P3.2',
    # ownership.json phase P4.2, named in this task's scope ("AccountSelect 等直接依赖")
    'src/web/src/components/AccountSelect.tsx': 'P4.2 → P3.2 (task scope)',
}


def by_path(report):
    return {entry['path']: entry for entry in report['files']}


def summary(entry):
    if entry is None:
        return None
    antd = sorted({binding['imported'] for imp in entry.get('imports', []) if imp['module'] == 'antd'
                   for binding in imp.get('bindings', [])})
    kinds = {}
    for hit in entry.get('hits', []):
        kinds[hit['kind']] = kinds.get(hit['kind'], 0) + 1
    return {'antdImports': antd, 'hitKinds': kinds}


b, a = by_path(before), by_path(after)
files = {}
for path in sorted(set(b) | set(a)):
    sb, sa = summary(b.get(path)), summary(a.get(path))
    if path in OWNED or sb != sa:
        files[path] = {'owner': OWNED.get(path), 'before': sb, 'after': sa}
result = {
    'before': before['baseline'], 'after': after['baseline'],
    'counts': {key: [before['counts'][key], after['counts'][key]] for key in before['counts'] if key != 'hitLines'},
    'hitLines': {key: [before['counts']['hitLines'].get(key, 0), after['counts']['hitLines'].get(key, 0)]
                 for key in sorted(set(before['counts']['hitLines']) | set(after['counts']['hitLines']))},
    'files': files,
}
json.dump(result, sys.stdout, indent=1, ensure_ascii=False)
print()
