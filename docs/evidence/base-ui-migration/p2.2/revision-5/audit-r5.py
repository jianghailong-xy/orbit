"""Check the r5 lifecycle observations, source identity and immutable prior evidence."""
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]
PARENT = '801d41ac9b9ec33671a00190e6f3c77cee22ab94'
TESTED = '8d78a684b607094e416c18d48c8881492efa0e05'


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, text=True).strip()


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(path):
    return json.loads(path.read_text())


def save(name, data):
    (HERE / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')


def tree(revision, path):
    return dict(line.split('\t', 1)[::-1] for line in git('ls-tree', '-r', revision, '--', path).splitlines())


changed = git('diff', '--name-only', PARENT, 'HEAD', '--', 'src/web').splitlines()
assert changed == ['src/web/ui-migration/choices-lifecycle.browser.mjs', 'src/web/ui-migration/choices-scroll-observation.mjs']
assert not git('diff', 'HEAD', '--', 'src/web', 'docs/evidence')
assert not git('diff', PARENT, 'HEAD', '--', 'package.json', 'package-lock.json', 'tsconfig.base.json')
assert git('rev-parse', 'HEAD:src/web') == git('rev-parse', TESTED + ':src/web')
historical, current = tree(PARENT, 'docs/evidence'), tree('HEAD', 'docs/evidence')
assert all(current.get(path) == blob for path, blob in historical.items())
assert tree(PARENT, 'src/web/src') == tree('HEAD', 'src/web/src')
for path, detail in read(HERE / 'lifecycle-rationale.json')['sources'].items():
    assert sha(ROOT / path) == detail['sha256']
assert sha(HERE / 'coordinator-input/p22-r4-coordinator-review.zip') == '1e91b059eee392300fbc23948a55c1fa7a493b02785a4117152ccb549c5f4e7e'
(HERE / 'test-only-change.patch').write_text(git('diff', PARENT, TESTED, '--', 'src/web') + '\n')
save('source-and-history-audit.json', {
    'parent': PARENT, 'testedCommit': TESTED, 'webTree': git('rev-parse', TESTED + ':src/web'),
    'changedWebFiles': changed, 'runtimeFilesUnchanged': len(tree(PARENT, 'src/web/src')),
    'historicalEvidenceFilesUnchanged': len(historical),
    'dependencyBuildTypesAndBrowserConfigsUnchanged': True,
    'reuse': ['r3 build/test 295 files / 3661 tests and four type checks',
             'r3 toasts-entry 24/24 and production-entry 8/8', 'r2 visual/interaction evidence with original limitations'],
})

old_tests = read(HERE.parent / 'revision-4/discovery-audit.json')['tests']
listed = (HERE.parent / 'checks/r5-list-choices.txt').read_text()
matches = re.findall(r'^  \[([^]]+)\] › ([^:]+):(\d+):(\d+) › (.+)$', listed, re.M)
new_tests = [{'project': p, 'file': 'src/web/ui-migration/' + f, 'line': int(line),
              'column': int(column), 'title': title} for p, f, line, column, title in matches]
identity = lambda test: (test['project'], test['file'], test['title'])
assert len(new_tests) == 520
assert Counter(map(identity, old_tests)) == Counter(map(identity, new_tests))
save('discovery-audit.json', {'count': 520, 'sameProjectFileTitlesAsR4': True, 'tests': new_tests})

observations = {}
environment = read(HERE.parent / 'revision-4/final-entry/environment.json')
runs = {'final-entry': ('r5-final-choices-entry', 32, 16),
        'final-lifecycle-repeat': ('r5-final-lifecycle-repeat', 80, 80),
        'lifecycle-controls': ('r5-lifecycle-controls', 24, 24)}
for run, (check, count, sample_count) in runs.items():
    directory = HERE / run
    summary = read(directory / 'summary.json')
    metadata = read(HERE.parent / ('checks/' + check + '.json'))
    assert metadata['commit'] == TESTED and metadata['exitCode'] == 0
    assert all(sha(ROOT / path) == digest for path, digest in metadata['sourceHashes'].items())
    assert read(directory / 'environment.json') == environment
    assert summary['stats']['expected'] == count
    assert all(summary['stats'][key] == 0 for key in ['unexpected', 'flaky', 'skipped'])
    assert all(len(test['results']) == 1 for test in summary['tests'])
    artifacts = [artifact for test in summary['tests'] for artifact in test['artifacts']]
    assert all(sha(directory / item['file']) == item['sha256'] for item in artifacts)
    unlocks = [{'file': path.name, **read(path)} for path in sorted(directory.glob('*--scroll-unlock.json'))]
    scrolls = [{'file': path.name, **read(path)} for path in sorted(directory.glob('*--page-scroll.json'))]
    assert len(unlocks) == sample_count
    if run != 'lifecycle-controls':
        assert len(scrolls) == sample_count
        for observation in unlocks:
            assert observation['closedAfterMs'] is not None and observation['unlockedAfterMs'] is not None
            assert observation['readyAfterCloseMs'] is not None and observation['readyAfterCloseMs'] <= 100
            assert not observation['finalRead']['locked']
        for observation in scrolls:
            assert observation['after'] > observation['before']
            assert observation['input']['trusted'] and observation['movedAfterMs'] <= 250
    observations[run] = {'stats': summary['stats'], 'artifactsVerified': len(artifacts),
                         'unlocks': unlocks, 'scrolls': scrolls}

controls = observations['lifecycle-controls']
for observation in controls['unlocks']:
    mode = observation['file'].split('-control-')[1].split('--')[0]
    if mode == 'lifecycle':
        assert observation['unlockedAfterMs'] > 100
        assert observation['closedAfterMs'] > observation['unlockedAfterMs']
        assert observation['readyAfterCloseMs'] <= 100 and not observation['finalRead']['locked']
    else:
        assert observation['readyAfterCloseMs'] is None
        assert any(s['phase'] == 'close-deadline' and s['locked'] for s in observation['samples'])
for observation in controls['scrolls']:
    assert observation['input']['trusted']
    if '-retained--' in observation['file']:
        assert observation['movedAfterMs'] is None and observation['after'] == observation['before']
    else:
        assert observation['after'] > observation['before'] and observation['movedAfterMs'] <= 250
controls['lateRelease'] = [read(path) for path in (HERE / 'lifecycle-controls').glob('*--late-release.json')]
assert len(controls['lateRelease']) == 8
assert all(o['releaseAfterCloseMs'] > 100 for o in controls['lateRelease'])
save('observations.json', observations)
print(json.dumps({'runtimeFilesUnchanged': len(tree(PARENT, 'src/web/src')),
                  'historicalEvidenceFilesUnchanged': len(historical), 'discovery': 520,
                  'runs': {run: value['stats'] for run, value in observations.items()},
                  'artifactsVerified': sum(value['artifactsVerified'] for value in observations.values())}, indent=2))
