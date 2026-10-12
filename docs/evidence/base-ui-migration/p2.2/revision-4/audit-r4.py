"""Audit this revision's scope, discovery, original observations and preserved history."""
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]
PARENT = '489941cf0942f71edad00ecbc14d5a53aeb5da0b'
TESTED = '2bd040fe3bc642cdb53460539146e25eb4e8aad2'


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, text=True).strip()


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(path):
    return json.loads(path.read_text())


def save(name, value):
    (HERE / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def tree(revision, path):
    return dict(line.split('\t', 1)[::-1] for line in git('ls-tree', '-r', revision, '--', path).splitlines())


changed = git('diff', '--name-only', PARENT, 'HEAD', '--', 'src/web').splitlines()
assert changed == ['src/web/ui-migration/choices-lifecycle.browser.mjs', 'src/web/ui-migration/choices-scroll-observation.mjs']
assert not git('diff', 'HEAD', '--', 'src/web', 'docs/evidence')
assert not git('diff', PARENT, 'HEAD', '--', 'package.json', 'package-lock.json', 'tsconfig.base.json')
assert git('rev-parse', 'HEAD:src/web') == git('rev-parse', TESTED + ':src/web')
historical = tree(PARENT, 'docs/evidence')
current = tree('HEAD', 'docs/evidence')
assert all(current.get(path) == blob for path, blob in historical.items())
assert tree(PARENT, 'src/web/src') == tree('HEAD', 'src/web/src')
dependency = ROOT / 'node_modules/@base-ui/utils/useScrollLock.mjs'
coordinator = read(HERE / 'coordinator-input/coordinator-scroll-trace-review.json')
assert sha(dependency) == coordinator['librarySha256']
assert sha(HERE / 'coordinator-input/p22-r3-coordinator-review.zip') == 'fc73b225948d6f5a18a635b8d7f77703fd41adf31c78b61674c608fb038dfbdf'
assert sha(ROOT / changed[1]) == sha(HERE / 'scroll-observation-final.mjs')
for name, digest in read(HERE / 'diagnostic-inputs.json')['probeSha256'].items():
    assert sha(HERE / name) == digest
patch = git('diff', PARENT, TESTED, '--', 'src/web')
(HERE / 'test-only-change.patch').write_text(patch + '\n')
save('source-and-history-audit.json', {
    'parent': PARENT, 'testedCommit': TESTED, 'testedWebTree': git('rev-parse', TESTED + ':src/web'),
    'changedWebFiles': changed, 'runtimeFilesUnchanged': len(tree(PARENT, 'src/web/src')),
    'historicalEvidenceFilesUnchanged': len(historical),
    'packageLockBuildTypesVitePlaywrightConfigsUnchanged': True,
    'baseUiScrollLockSha256': sha(dependency),
    'testHelperMatchesSuccessfulUnmodifiedRuntimeProbe': True,
    'reuse': ['r3-build-and-test: 295 files / 3661 tests', 'r3-fixture-types: four checks',
             'r3 toasts-entry 24/24 and production-entry 8/8', 'r2 visual/interaction evidence, with original limitations'],
})

old_discovery = read(HERE.parent / 'revision-3/discovery-audit.json')['choices']['tests']
listed = (HERE.parent / 'checks/r4-list-choices.txt').read_text()
matches = re.findall(r'^  \[([^]]+)\] › ([^:]+):(\d+):(\d+) › (.+)$', listed, re.M)
new_discovery = [{'project': p, 'file': 'src/web/ui-migration/' + f, 'line': int(line),
                  'column': int(column), 'title': title} for p, f, line, column, title in matches]
identity = lambda test: (test['project'], test['file'], test['title'])
assert len(new_discovery) == 520
assert Counter(map(identity, old_discovery)) == Counter(map(identity, new_discovery))
save('discovery-audit.json', {'count': 520, 'sameProjectFileTitlesAsR3': True, 'tests': new_discovery})

observations = {}
environment = read(HERE.parent / 'revision-3/choices-entry-first/environment.json')
runs = {'diagnosis-first': (12, 4), 'diagnosis-native-input': (16, 0),
        'final-entry': (32, 0), 'final-reduced-repeat': (40, 0),
        'negative-control-first': (8, 8), 'negative-control-standard': (16, 0)}
for run, (passed, failed) in runs.items():
    directory = HERE / run
    summary = read(directory / 'summary.json')
    assert read(directory / 'environment.json') == environment
    assert summary['stats']['expected'] == passed and summary['stats']['unexpected'] == failed
    assert summary['stats']['skipped'] == 0 and summary['stats']['flaky'] == 0
    assert all(len(test['results']) == 1 for test in summary['tests'])
    artifacts = [artifact for test in summary['tests'] for artifact in test['artifacts']]
    assert all(sha(directory / artifact['file']) == artifact['sha256'] for artifact in artifacts)
    unlocks = [{'file': path.name, **read(path)} for path in sorted(directory.glob('*--scroll-unlock.json'))]
    scrolls = [{'file': path.name, **read(path)} for path in sorted(directory.glob('*--page-scroll.json'))]
    for observation in unlocks:
        assert observation['unlockedAfterMs'] is not None and observation['unlockedAfterMs'] <= 100
        assert not observation['finalRead']['locked']
    for observation in scrolls:
        assert observation['after'] > observation['before']
        assert observation['movedAfterMs'] is not None and observation['movedAfterMs'] <= 250
    if run.startswith('final-'):
        assert len(unlocks) == len(scrolls) == (16 if run == 'final-entry' else 40)
        assert all(o['input']['trusted'] and o['input']['kind'] in ['wheel', 'PageDown'] for o in scrolls)
    observations[run] = {'stats': summary['stats'], 'artifactsVerified': len(artifacts),
                         'unlocks': unlocks, 'scrolls': scrolls}

controls = HERE / 'negative-control-standard'
rejected = [read(path) for path in controls.glob('*--rejected-unlock.json')]
blocked = [read(path) for path in controls.glob('*--blocked-scroll.json')]
late = [read(path) for path in controls.glob('*--late-release.json')]
assert len(rejected) == 16 and len(blocked) == len(late) == 8
assert all(o['unlockedAfterMs'] is None and o['finalRead']['locked'] for o in rejected)
assert all(o['movedAfterMs'] is None and o['before'] == o['after'] and o['input']['trusted'] for o in blocked)
assert all(o['actualReleaseAfterMs'] > 100 for o in late)
observations['negative-control-standard'].update(rejected=rejected, blocked=blocked, late=late)
save('observations.json', observations)
print(json.dumps({'runtimeFilesUnchanged': len(tree(PARENT, 'src/web/src')),
                  'historicalEvidenceFilesUnchanged': len(historical), 'discovery': 520,
                  'runs': {run: value['stats'] for run, value in observations.items()},
                  'artifactsVerified': sum(value['artifactsVerified'] for value in observations.values())}, indent=2))
