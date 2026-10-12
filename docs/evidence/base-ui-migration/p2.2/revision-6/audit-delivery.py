"""Verify final main absorption and the exact inputs reused from the preceding browser runs."""
import hashlib
import json
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]
PRIOR = 'baec95275814fdeb6a6530fefeb533338a426787'
UPSTREAM = '235787f548d1f49c410f69fdea8c9d27091369b6'
FINAL = 'f096a2bc73db87ffcc242a5493f567a414c9ae71'


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, text=True).strip()


def tree(ref):
    return {line.split('\t', 1)[1]: line.split('\t', 1)[0]
            for line in git('ls-tree', '-r', ref).splitlines()}


before, after, upstream = tree(PRIOR), tree(FINAL), tree(UPSTREAM)
assert git('show', '-s', '--format=%P', FINAL).split() == [PRIOR, UPSTREAM]
assert git('merge-tree', '--write-tree', PRIOR, UPSTREAM) == git('rev-parse', FINAL + '^{tree}')
delta = sorted(p for p in set(before) | set(after) if before.get(p) != after.get(p))
assert delta == sorted(git('diff', '--name-only', '1970483d2', UPSTREAM).splitlines())
assert len(delta) == 9 and all(after[p] == upstream[p] for p in delta)
assert not git('diff', '--name-only', FINAL, '--', 'src', 'scripts', 'package.json', 'package-lock.json')
preserved = [p for p in before if p.startswith('docs/evidence/base-ui-migration/')]
assert all(before[p] == after[p] for p in preserved)
inputs = ['src/web/src/components/ui', 'src/web/ui-migration', 'src/shared',
          'src/web/src/components/ToastViewport.tsx', 'src/web/src/index.css',
          'src/web/src/lib/toast.tsx', 'src/web/src/lib/toastStore.ts',
          'src/web/src/lib/toastFeed.ts', 'src/web/vite.config.ts',
          'src/web/package.json', 'package.json', 'package-lock.json']
input_trees = {p: git('rev-parse', FINAL + ':' + p) for p in inputs}
assert all(git('rev-parse', PRIOR + ':' + p) == digest for p, digest in input_trees.items())
for ref in [UPSTREAM, '18e75cfe14d0a0858c9a46e514535439c9cdf9d8',
            'd71afc686760eb4a37c84822bf1ea478dbe8fcf1', '59c439e47515f15f581a76318df0ecad6b23e53e']:
    subprocess.run(['git', 'merge-base', '--is-ancestor', ref, FINAL], cwd=ROOT, check=True)

runs = {}
for name, count in [('choices-entry', 32), ('notification-combinations', 88),
                    ('production-notifications', 8), ('delivery-production-notifications', 8)]:
    directory = HERE / name
    summary = json.loads((directory / 'summary.json').read_text())
    report = json.loads((directory / 'report.json').read_text())
    assert report['stats'] == summary['stats'] and report['stats']['expected'] == count
    assert not report['errors'] and all(report['stats'][k] == 0 for k in ['unexpected', 'flaky', 'skipped'])
    assert report['config']['workers'] == 1 and all(p['retries'] == 0 for p in report['config']['projects'])
    assert json.loads((directory / 'environment.json').read_text()) == json.loads(
        (ROOT / 'docs/evidence/base-ui-migration/p0.2/environment.json').read_text())
    assert all(len(t['results']) == 1 and t['results'][0]['status'] == 'passed' for t in summary['tests'])
    artifacts = [a for t in summary['tests'] for a in t['artifacts']]
    assert all(hashlib.sha256((directory / a['file']).read_bytes()).hexdigest() == a['sha256'] for a in artifacts)
    runs[name] = {'stats': report['stats'], 'attachmentsVerified': len(artifacts)}
for name in ['delivery-build-test', 'delivery-production-notifications']:
    check = json.loads((HERE.parent / 'checks' / ('r6-' + name + '.json')).read_text())
    assert check['commit'] == FINAL and check['exitCode'] == 0
    assert all(hashlib.sha256((ROOT / p).read_bytes()).hexdigest() == sha for p, sha in check['sourceHashes'].items())
result = {'finalTestedCommit': FINAL, 'upstream': UPSTREAM, 'parents': [PRIOR, UPSTREAM],
          'tree': git('rev-parse', FINAL + '^{tree}'), 'webTree': git('rev-parse', FINAL + ':src/web'),
          'conflicts': [], 'deltaFiles': delta, 'allDeltaBlobsEqualUpstream': True,
          'historicalEvidenceFilesUnchanged': len(preserved), 'unchangedBrowserInputs': input_trees,
          'runs': runs}
(HERE / 'delivery-audit.json').write_text(json.dumps(result, indent=2) + '\n')
(HERE / 'delivery-main-delta.patch').write_text(git('diff', PRIOR, FINAL) + '\n')
print(json.dumps(result, indent=2))
