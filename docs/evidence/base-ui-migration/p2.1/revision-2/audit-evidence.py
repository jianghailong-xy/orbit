"""Check recorded artifact bytes, actual comparisons and untouched P0 baselines."""
import collections
import hashlib
import json
import pathlib
import subprocess

root = pathlib.Path(__file__).resolve().parent
repository = root.parents[4]
source_commit = 'e3f53d40246c005aac7c3e1060f0734d38afbb47'

def read(path):
    return json.loads(path.read_text())

def sha(data):
    return hashlib.sha256(data).hexdigest()

def artifacts(directory):
    summary = read(directory / 'summary.json')
    entries = [item for test in summary['tests'] for item in test['artifacts']]
    for item in entries:
        assert sha((directory / item['file']).read_bytes()) == item['sha256'], item['file']
    return {'count': len(entries), 'allHashesMatch': True,
            'types': dict(collections.Counter(pathlib.Path(item['file']).suffix for item in entries)),
            'stats': summary['stats']}

report = {'sourceCommit': source_commit, 'revision2': artifacts(root / 'overlays-run'),
          'revision1': artifacts(root.parent / 'overlays-complete')}
baseline = read(root.parent / 'checks/baseline-screenshot-hashes.json')
for item in baseline['files']:
    original = subprocess.check_output(['git', 'show', baseline['referenceCommit'] + ':' + item['path']], cwd=repository)
    assert sha(original) == item['sha256'] == sha((repository / item['path']).read_bytes()), item['path']
report['p0Baselines'] = {'referenceCommit': baseline['referenceCommit'], 'count': len(baseline['files']), 'allUnchanged': True}
report['appearance'] = []
for path in sorted((root / 'overlays-run').glob('*--appearance.json')):
    data = read(path)
    for kind, sample in data.items():
        assert sample['ant'] == sample['orbit'], (path.name, kind)
    report['appearance'].append({'project': path.name.split('--')[0],
        'allFourSurfacesEqual': True,
        'rightDrawerSeparators': data['right drawer']['orbit']['separators'],
        'bottomDrawerSeparators': data['bottom drawer']['orbit']['separators'],
        'bottomInputStates': data['bottom drawer']['orbit']['inputStates']})
pixels = read(root / 'pixel-comparison.json')
locations = collections.Counter()
rows = []
for pair in pixels['pairs']:
    locations.update(pair['differenceLocations'])
    rows.extend(pair.get('separatorRows', []))
report['pixelComparison'] = {key: value for key, value in pixels.items() if key != 'pairs'}
report['pixelComparison'].update({'differenceLocations': dict(locations),
    'maxChannelDelta': max(pair['maxChannelDelta'] for pair in pixels['pairs']),
    'separatorRows': len(rows), 'separatorChangedPixels': sum(row['changedPixels'] for row in rows)})
report['controlsRegression'] = read(root / 'controls-regression/report.json')['stats']
report['checks'] = {name: read(root / 'checks' / (name + '.json'))['exitCode']
                    for name in ['overlays-revision-2', 'controls-regression', 'fixture-types', 'boundary-and-theme', 'web-build']}
changed_files = subprocess.check_output(['git', 'diff-tree', '--no-commit-id', '--name-only', '-r', source_commit], cwd=repository, text=True).splitlines()
report['sourceFiles'] = []
for name in changed_files:
    committed = subprocess.check_output(['git', 'show', source_commit + ':' + name], cwd=repository)
    current = (repository / name).read_bytes()
    assert committed == current, name
    report['sourceFiles'].append({'path': name, 'sha256': sha(current)})
(root / 'audit.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({key: value for key, value in report.items() if key not in ['appearance', 'sourceFiles']}, indent=2))
