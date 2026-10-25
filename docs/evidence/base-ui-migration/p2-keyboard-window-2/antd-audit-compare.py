"""Compare antd-audit.sh's reports: usage antd-audit-compare.py <scratch dir> <project tip>; prints JSON.

base -> final: every count, the declared and locked antd packages, and each file whose bytes changed, with its antd
imports (module: bindings), hit kinds and whether it blocks retirement, before and after. merged: the project tip's
--check-owners result for this branch merged into the tip (records read, unowned and pending use points, owners)."""
import hashlib
import json
import sys
from collections import Counter
from pathlib import Path

scratch, tip = Path(sys.argv[1]), sys.argv[2]
read = lambda name: json.loads((scratch / name).read_text())
base, final, owners = read('antd-audit-base.json'), read('antd-audit-final.json'), read('antd-owners-merged.json')
BLOCKING = {'antd-reference', 'ant-class', 'react19-patch', 'internal-ref'}


def view(file):
    if file is None:
        return None
    imports = {f"{item['kind']} {item['module']}": sorted(binding['imported'] for binding in item['bindings'])
               for item in file['imports']}
    return {'category': file['category'], 'sha256': file['sha256'], 'imports': imports,
            'hitKinds': dict(sorted(Counter(hit['kind'] for hit in file['hits']).items())),
            'blocksRetirement': any(item['family'] in ('antd', 'react19-patch') for item in file['imports'])
            or any(hit['kind'] in BLOCKING for hit in file['hits'])}


before = {file['path']: file for file in base['files']}
after = {file['path']: file for file in final['files']}
changed = sorted(path for path in before.keys() | after.keys()
                 if (before.get(path) or {}).get('sha256') != (after.get(path) or {}).get('sha256'))
counts = {key: {'base': base['counts'][key], 'final': final['counts'][key]} for key in base['counts'] if key != 'hitLines'}
kinds = sorted(base['counts']['hitLines'].keys() | final['counts']['hitLines'].keys())
counts['hitLines'] = {kind: {'base': base['counts']['hitLines'].get(kind, 0), 'final': final['counts']['hitLines'].get(kind, 0)}
                      for kind in kinds}
mine = set(changed)
print(json.dumps({
    'script': 'src/web/scripts/audit-antd.mjs (base and final: the branch\'s own; merged: the project tip\'s, with --check-owners)',
    'reports': {name: {'baseline': read(f'antd-audit-{name}.json')['baseline'],
                       'sha256': hashlib.sha256((scratch / f'antd-audit-{name}.json').read_bytes()).hexdigest(),
                       'path': str(scratch / f'antd-audit-{name}.json')} for name in ('base', 'final', 'merged')},
    'counts': counts,
    'countsChanged': sorted(key for key, value in counts.items() if key != 'hitLines' and value['base'] != value['final'])
    + sorted(f'hitLines.{kind}' for kind, value in counts['hitLines'].items() if value['base'] != value['final']),
    'dependenciesUnchanged': base['dependencies'] == final['dependencies'],
    'changedFiles': {path: {'base': view(before.get(path)), 'final': view(after.get(path))} for path in changed},
    'ownersOnMergedTree': {'projectTip': tip, 'records': owners['records'], 'unowned': owners['unowned'],
                           'unownedFromThisBranch': [item for item in owners['unowned'] if item['path'] in mine],
                           'pending': owners['pending'], 'owners': owners['owners']},
}, indent=1, ensure_ascii=False))
