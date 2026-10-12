"""Verify the narrow test change, upstream merge, ancestors and original evidence."""
import hashlib
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[5]
out = Path(__file__).resolve().parent
old = 'ea9191d8165f827c83584087a59f4dfd0cfc2bcd'
fix = 'daae2304a485c77fecf179bb4e6b65552ecd29c9'
final = '9ccb09e8661bccaee1779b9eaeb2c7584b47805a'
previous_main = '235787f548d1f49c410f69fdea8c9d27091369b6'
main = '53da29cc1e799e1b5a82e98167305d9b41cc54cc'
project = '18e75cfe14d0a0858c9a46e514535439c9cdf9d8'

def git(*args):
    return subprocess.check_output(['git', *args], cwd=root, text=True).strip()

def tree(commit, path):
    return {line.split('\t', 1)[1]: line.split('\t', 1)[0] for line in git('ls-tree', '-r', commit, '--', path).splitlines()}

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

assert git('rev-list', '--parents', '-1', final).split()[1:] == [fix, main]
preview = git('merge-tree', '--write-tree', fix, main)
assert preview == git('rev-parse', final + '^{tree}')
delta = git('diff', '--name-only', fix, final).splitlines()
assert delta == git('diff', '--name-only', previous_main, main).splitlines()
assert len(delta) == 6
for path in delta:
    assert tree(final, path) == tree(main, path)
ancestors = [old, fix, main, previous_main, project,
             'd71afc686760eb4a37c84822bf1ea478dbe8fcf1', '59c439e47515f15f581a76318df0ecad6b23e53e']
for commit in ancestors:
    subprocess.run(['git', 'merge-base', '--is-ancestor', commit, 'HEAD'], cwd=root, check=True)

test = 'src/web/ui-migration/toasts.browser.mjs'
assert git('diff', '--name-only', old, fix, '--', 'src', 'scripts', 'package.json', 'package-lock.json') == test
before, after = [git('show', c + ':' + test) for c in [old, final]]
insertion = "  // AntApp's entrance can briefly have a stable hit box at opacity 0 / scale(.2).\n  // Wait for its painted, settled state before the real pointer click.\n  await expect(legacy).toHaveCSS('opacity', '1');\n  await expect(legacy).toHaveCSS('transform', 'none');\n"
assert after.count(insertion) == 1 and after.replace(insertion, '') == before
inputs = ['src/web/src/components/ui', 'src/web/src/components/ToastViewport.tsx',
          'src/web/src/lib/toast.tsx', 'src/web/src/lib/toastFeed.ts', 'src/web/src/index.css',
          'src/web/src/lib/theme.tsx', 'src/shared', 'package.json', 'package-lock.json',
          'src/web/package.json', 'src/web/vite.config.ts', 'src/web/ui-migration']
unchanged = {}
for path in inputs:
    a, b = tree(old, path), tree(final, path)
    a.pop(test, None)
    b.pop(test, None)
    assert a == b, path
    unchanged.update(a)
history = tree(old, 'docs/evidence/base-ui-migration')
current = tree('HEAD', 'docs/evidence/base-ui-migration')
assert all(current[p] == blob for p, blob in history.items())
receipt = json.loads((out / 'coordinator-input/receipt.json').read_text())
for f in receipt['files']:
    path = out / 'coordinator-input' / f['path']
    assert digest(path) == f['sha256'] and path.stat().st_size == f['bytes']

result = {'revision6': old, 'synchronizationCommit': fix, 'testedFinal': final,
          'mergeParents': [fix, main], 'previewAndActualTree': preview,
          'ancestors': ancestors, 'upstreamDelta': delta,
          'onlyOwnSourceChange': {'path': test, 'addedAssertions': 2, 'addedComments': 2, 'priorLinesUnchanged': True},
          'unchangedInputs': unchanged, 'historicalEvidenceBlobsPreserved': len(history),
          'coordinatorOriginalFilesVerified': len(receipt['files']),
          'currentRefs': {ref: git('rev-parse', ref) for ref in ['refs/heads/main', 'refs/heads/project/34ZZeq0e3IR65GVm2kAs7']}}
for tip in result['currentRefs'].values():
    subprocess.run(['git', 'merge-base', '--is-ancestor', tip, 'HEAD'], cwd=root, check=True)
(out / 'source-audit.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({k: v for k, v in result.items() if k != 'unchangedInputs'}, indent=2))
