"""Verify final evidence and unchanged historical artifacts; write a fresh audit."""
from pathlib import Path
import hashlib
import json
import re
import subprocess
import zipfile

here = Path(__file__).resolve().parent
root = here.parents[4]
destination = here / 'integrity.json'
if destination.exists():
    raise SystemExit('Retained evidence is never overwritten.')

full = json.loads((here / 'full-matrix/report.json').read_text())
assert full['stats']['expected'] + full['stats']['unexpected'] == 496, full['stats']
assert not any(full['stats'][key] for key in ['skipped', 'flaky']), full['stats']
assert not full['errors'], full['errors']
full_summary = json.loads((here / 'full-matrix/summary.json').read_text())
motion = json.loads((here / 'final-motion/summary.json').read_text())
assert motion['stats']['expected'] == 192 and not any(motion['stats'][key] for key in ['unexpected', 'skipped', 'flaky'])
repeat = json.loads((here / 'network-repeat/summary.json').read_text())
assert repeat['stats']['expected'] == 6 and not any(repeat['stats'][key] for key in ['unexpected', 'skipped', 'flaky'])
values = json.loads((here / 'open-value-final/summary.json').read_text())
assert values['stats']['expected'] == 112 and not any(values['stats'][key] for key in ['unexpected', 'skipped', 'flaky'])
failed = [test for test in full_summary['tests'] if test['status'] != 'expected']
allowed = {f'chromium-light-phone--{kind}-matches-the-current-surface-density-and-option-states' for kind in ['account', 'search']}
observer_cases = {'webkit-light-desktop--normal-bottom-entrance-and-exit-motion-matches-search',
    'webkit-dark-phone--normal-bottom-entrance-and-exit-motion-matches-tooltip'}
assert {test['name'] for test in failed} == allowed | observer_cases
covered = {test['name'] for test in full_summary['tests'] if test['status'] == 'expected'}
covered.update(test['name'] for test in motion['tests'] if test['status'] == 'expected')
covered.update(test['name'].split('--repeat-')[0] for test in repeat['tests'] if test['status'] == 'expected')
assert len(covered) == 496 and covered == {test['name'] for test in full_summary['tests']}
covered.update(test['name'] for test in values['tests'] if test['status'] == 'expected')
assert len(covered) == 520
assert sum('dims-the-current-value' in test['name'] for test in values['tests']) == 24
for test in values['tests']:
    if 'dims-the-current-value' not in test['name']:
        continue
    file = next(here / 'open-value-final' / item['file'] for item in test['artifacts'] if item['file'].endswith('--open-value.json'))
    measurements = json.loads(file.read_text())
    assert measurements['orbit'] == measurements['antd'], file
    assert measurements['orbit']['open'][0]['opacity'] == .25, file
    assert measurements['orbit']['restored'] == measurements['orbit']['closed'], file
network_failures = {}
for test in failed:
    if test['name'] in observer_cases:
        assert any(item['name'] == test['name'] and item['status'] == 'expected' for item in motion['tests'])
        diagnostic = next(here / 'full-matrix' / a['file'] for a in test['artifacts'] if a['file'].endswith('--motion-diagnostic.json'))
        records = json.loads(diagnostic.read_text())['records']
        assert len(records) == 1 and records[0]['name'].endswith('-out')
        assert records[0]['samples'][0]['connected'] and not records[0]['samples'][-1]['connected']
        assert records[0]['samples'][0]['time'] == records[0]['duration'] / 2
        continue
    matching = [item for item in repeat['tests'] if item['name'].split('--repeat-')[0] == test['name']]
    assert len(matching) == 3 and all(item['status'] == 'expected' for item in matching), test['name']
    traces = [here / 'full-matrix' / a['file'] for a in test['artifacts'] if a['file'].endswith('.zip')]
    failed_urls = []
    for trace in traces:
        with zipfile.ZipFile(trace) as archive:
            for name in archive.namelist():
                if not name.endswith('.network'):
                    continue
                for line in archive.read(name).decode().splitlines():
                    snapshot = json.loads(line).get('snapshot', {})
                    if snapshot.get('response', {}).get('_failureText') == 'net::ERR_NETWORK_CHANGED':
                        failed_urls.append(snapshot['request']['url'])
    assert any('/src/components/ui/' in url for url in failed_urls), test['name']
    network_failures[test['name']] = failed_urls
artifacts = 0
reports = {}
recovered = {item['sha256']: here / 'flipped-search-retained' / item['file']
    for test in json.loads((here / 'flipped-search-retained/summary.json').read_text())['tests'] for item in test['artifacts']}
recovered_refs = []
for manifest in sorted(here.glob('*/summary.json')):
    data = json.loads(manifest.read_text())
    reports[manifest.parent.name] = data['stats']
    for test in data['tests']:
        for artifact in test['artifacts']:
            file = manifest.parent / artifact['file']
            if hashlib.sha256(file.read_bytes()).hexdigest() != artifact['sha256']:
                assert manifest.parent.name == 'flipped-search-diagnostic', file
                replacement = recovered[artifact['sha256']]
                assert hashlib.sha256(replacement.read_bytes()).hexdigest() == artifact['sha256'], replacement
                recovered_refs.append({'originalRef': str(file.relative_to(here)), 'recoveredRef': str(replacement.relative_to(here)), 'sha256': artifact['sha256']})
            artifacts += 1
for entry in json.loads((here / 'reviewer/traces/index.json').read_text()):
    file = here / 'reviewer/traces' / entry['file']
    assert hashlib.sha256(file.read_bytes()).hexdigest() == entry['sha256'], file

checks = ['r2-final-full-matrix', 'r2-final-motion', 'r2-network-repeat', 'r2-unit-regressions', 'r2-final-types', 'r2-production-build', 'r2-open-value-final', 'r2-final-production-build']
observer_commit = '522ac9d70cc0eb2b0862f6ab1360eb745a316bf5'
final_commit = '954396bdbac19d54cee94459274fa5983747de6f'
assert set(subprocess.check_output(['git', 'diff', '--name-only', observer_commit, final_commit], cwd=root, text=True).splitlines()) == {
    'src/web/src/components/ui/Select.css', 'src/web/ui-migration/choices-open-value.browser.mjs'}
for name in checks:
    data = json.loads((here.parent / 'checks' / (name + '.json')).read_text())
    assert data['exitCode'] == (1 if name == 'r2-final-full-matrix' else 0), name
    expected_commit = observer_commit if name in ['r2-final-motion', 'r2-network-repeat'] else 'e1905305657569086b8d103f15aa1bdd5214fb03'
    if name in ['r2-open-value-final', 'r2-final-production-build']:
        expected_commit = final_commit
    assert data['commit'] == expected_commit, name
    for file, digest in data['sourceHashes'].items():
        current = hashlib.sha256((root / file).read_bytes()).hexdigest()
        if current != digest:
            # Earlier calls retain their exact source: observer/collector repairs,
            # then two selected-label opacity rules with 112 targeted checks.
            assert expected_commit != final_commit and file in [
                'src/web/src/components/ui/Select.css',
                'src/web/ui-migration/choices-motion.browser.mjs', 'src/web/ui-migration/collect-choice-evidence.mjs'], (name, file)
            recorded = subprocess.check_output(['git', 'show', f'{expected_commit}:{file}'], cwd=root)
            assert hashlib.sha256(recorded).hexdigest() == digest, (name, file)

historical = subprocess.check_output(['git', 'ls-tree', '-r', '--format=%(objectname) %(path)',
    '43db5d2ea9f37d8ab6e246eb849b998b2ae73004', '--', 'docs/evidence/base-ui-migration/p0.1',
    'docs/evidence/base-ui-migration/p0.2', 'docs/evidence/base-ui-migration/p2.2'], cwd=root, text=True)
preserved = 0
for line in historical.splitlines():
    digest, name = line.split(' ', 1)
    if name == 'docs/evidence/base-ui-migration/p2.2/README.md':
        continue
    raw = (root / name).read_bytes()
    assert hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest() == digest, name
    preserved += 1

changed = subprocess.check_output(['git', 'diff', '--name-only', '43db5d2e'], cwd=root, text=True).splitlines()
assert all(name.startswith(('src/web/', 'docs/evidence/base-ui-migration/p2.2/')) for name in changed), changed
runtime = []
for file in sorted((root / 'src/web/src/components/ui').glob('*')):
    if file.suffix not in ['.ts', '.tsx', '.css'] or '.test.' in file.name:
        continue
    source = file.read_text()
    assert not re.search(r'''(?:from\s*|import\s*\()(['"])antd(?:/|\1)''', source), file
    if file.suffix == '.css':
        assert '.ant-' not in source, file
    runtime.append(str(file.relative_to(root)))

mobile = {}
for file in sorted((here / 'full-matrix').glob('*phone--attachment-matches*--appearance.json')):
    data = json.loads(file.read_text())
    assert data['orbit']['popup']['surface']['height'] == data['antd']['popup']['surface']['height'] == 240.953125
    assert data['orbit']['popup']['separators'] == data['antd']['popup']['separators']
    assert data['orbit']['labelStarts'] == data['antd']['labelStarts'] == [55] * 5
    for row in data['orbit']['popup']['rows']:
        assert (row['height'], row['fontSize'], row['padding'], row['borderRadius']) == (42.390625, '17px', '5px 12px', '4px')
    mobile[file.name] = {'height': 240.953125, 'fontSize': '17px', 'labelStarts': data['orbit']['labelStarts']}
assert len(mobile) == 4

audit = {'sourceCommit': 'e1905305657569086b8d103f15aa1bdd5214fb03', 'finalStats': full['stats'],
    'observerCommit': observer_commit, 'finalSourceCommit': final_commit, 'openValueStats': values['stats'],
    'motionStats': motion['stats'], 'repeatStats': repeat['stats'], 'validatedCases': len(covered),
    'networkFailures': network_failures, 'observerCasesRevalidated': sorted(observer_cases), 'recoveredOriginalManifestRefs': recovered_refs,
    'verifiedManifestArtifacts': artifacts, 'unchangedHistoricalFiles': preserved, 'checksMatchRuntimeAndRecordedTestSource': checks,
    'runtimeWithoutAntD': runtime, 'changedTrackedFiles': changed, 'mobile': mobile, 'reports': reports}
destination.write_text(json.dumps(audit, indent=2) + '\n')
index = {str(file.relative_to(here)): hashlib.sha256(file.read_bytes()).hexdigest()
    for file in sorted(here.rglob('*')) if file.is_file() and file.name not in ['README.md', 'tool-call-refs.json', 'artifact-index.json']}
(here / 'artifact-index.json').write_text(json.dumps(index, indent=2) + '\n')
print(json.dumps({'full': full['stats'], 'motion': motion['stats'], 'repeat': repeat['stats'], 'openValue': values['stats'], 'validatedCases': len(covered), 'networkFailures': network_failures,
    'recoveredOriginalManifestRefs': len(recovered_refs), 'verifiedManifestArtifacts': artifacts,
    'unchangedHistoricalFiles': preserved, 'indexedFiles': len(index), 'mobile': mobile}, indent=2))
