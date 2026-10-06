"""Preserve the first audit and verify the final open-state source and evidence."""
from pathlib import Path
import hashlib
import json
import subprocess

here = Path(__file__).resolve().parent
root = here.parents[4]
destination = here / 'integrity-final.json'
if destination.exists():
    raise SystemExit('Retained evidence is never overwritten.')
original = json.loads((here / 'artifact-index.json').read_text())
for name, digest in original.items():
    assert hashlib.sha256((here / name).read_bytes()).hexdigest() == digest, name
previous = json.loads((here / 'integrity.json').read_text())
assert previous['validatedCases'] == 520
earlier_commit = previous['finalSourceCommit']
capture = json.loads((here.parent / 'checks/r2-open-state-final.json').read_text())
assert capture['exitCode'] == 0
runtime_commit = capture['commit']
assert runtime_commit == '3f3a297374204e7764f77ecdd9715503fcc02187'
assert set(subprocess.check_output(['git', 'diff', '--name-only', earlier_commit, runtime_commit], cwd=root, text=True).splitlines()) == {
    'src/web/src/components/ui/Select.css', 'src/web/src/components/ui/Select.tsx', 'src/web/ui-migration/choices-open-value.browser.mjs'}
for file, digest in capture['sourceHashes'].items():
    assert hashlib.sha256((root / file).read_bytes()).hexdigest() == digest, file
for name in ['r2-final-open-build', 'r2-final-open-types']:
    check = json.loads((here.parent / 'checks' / (name + '.json')).read_text())
    assert check['exitCode'] == 0 and check['commit'] == runtime_commit
    for file, digest in check['sourceHashes'].items():
        assert hashlib.sha256((root / file).read_bytes()).hexdigest() == digest, file
summary = json.loads((here / 'open-state-final/summary.json').read_text())
assert summary['stats']['expected'] == 112 and not any(summary['stats'][key] for key in ['unexpected', 'skipped', 'flaky'])
artifacts = 0
for test in summary['tests']:
    assert test['status'] == 'expected'
    for item in test['artifacts']:
        file = here / 'open-state-final' / item['file']
        assert hashlib.sha256(file.read_bytes()).hexdigest() == item['sha256'], file
        artifacts += 1
        if file.name.endswith('--open-value.json'):
            measurements = json.loads(file.read_text())
            assert measurements['orbit'] == measurements['antd']
            assert measurements['orbit']['open'][0]['opacity'] == .25
            label = lambda row: {key: row[key] for key in ['text', 'color', 'fontSize', 'fontWeight', 'opacity']}
            assert label(measurements['orbit']['closed'][0]) == label(measurements['orbit']['restored'][0])
            for key in ['controlBorderColor', 'controlBoxShadow']:
                assert measurements['orbit']['open'][0][key] == measurements['orbit']['restored'][0][key]
for directory in ['open-value-settled', 'open-border-before']:
    data = json.loads((here / directory / 'summary.json').read_text())
    for test in data['tests']:
        for item in test['artifacts']:
            file = here / directory / item['file']
            assert hashlib.sha256(file.read_bytes()).hexdigest() == item['sha256'], file
            artifacts += 1
pixels = json.loads((here / 'pixel-audit-final-state.json').read_text())
assert len(pixels['pairs']) == 304
assert sum(row['old'].startswith('open-state-final/') and row['old'].endswith('-open-value.png') for row in pixels['pairs']) == 24
audit = {'runtimeCommit': runtime_commit, 'earlierRuntimeCommit': earlier_commit, 'validatedCases': previous['validatedCases'],
    'preservedOriginalIndexedFiles': len(original), 'preservedManifestReferences': previous['verifiedManifestArtifacts'],
    'additionalVerifiedArtifacts': artifacts, 'unchangedHistoricalFiles': previous['unchangedHistoricalFiles'],
    'finalOpenStateStats': summary['stats'], 'pixelSummary': pixels['summary'],
    'limits': ['The 520 distinct cases were validated across the documented full and targeted runs, not a single final all-green run.']}
destination.write_text(json.dumps(audit, indent=2) + '\n')
index = {str(file.relative_to(here)): hashlib.sha256(file.read_bytes()).hexdigest()
    for file in sorted(here.rglob('*')) if file.is_file() and file.name not in ['README.md', 'tool-call-refs.json', 'artifact-index-final.json']}
(here / 'artifact-index-final.json').write_text(json.dumps(index, indent=2) + '\n')
print(json.dumps({**audit, 'finalIndexedFiles': len(index)}, indent=2))
