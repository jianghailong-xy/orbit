"""Check the fixed two-parent merge without rewriting any historical evidence."""
import collections
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[5]
OUT = Path(__file__).resolve().parent
TASK = 'd5716beb168861834aed8ef22a99a5b966866322'
PROJECT = '18e75cfe14d0a0858c9a46e514535439c9cdf9d8'
BASE = '67e62c0b4028eefe2c619dac80d3fac312cea601'
MERGE = 'e1eb1d3796a6086f413a6dd57bee228c2fa59c85'
MANUAL = ['src/web/.gitignore', 'src/web/package.json', 'src/web/ui-migration/playwright.config.mjs']
README = 'src/web/src/components/ui/README.md'


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def tree(ref):
    return {path.decode(): tuple(meta.decode().split()[::2])
            for row in git('ls-tree', '-rz', ref).split(b'\0') if row
            for meta, path in [row.split(b'\t', 1)]}


def read(ref, path):
    return git('show', f'{ref}:{path}')


assert git('show', '-s', '--format=%P', MERGE).decode().strip().split() == [TASK, PROJECT]
assert git('merge-base', TASK, PROJECT).decode().strip() == BASE
base, task, project, merged = map(tree, [BASE, TASK, PROJECT, MERGE])
counts = collections.Counter()
both = []
for path in sorted(set(base) | set(task) | set(project)):
    bv, tv, pv, mv = (items.get(path) for items in [base, task, project, merged])
    if tv == pv:
        expected = tv
        counts['identicalParents'] += 1
    elif tv == bv:
        expected = pv
        counts['projectOnly'] += 1
    elif pv == bv:
        expected = tv
        counts['taskOnly'] += 1
    else:
        both.append(path)
        continue
    assert mv == expected, path
assert both == sorted(MANUAL + [README]), both
assert set(merged) == set(task) | set(project), 'Unexpected deletion/addition in merge'

ignore = 'src/web/.gitignore'
union = set(read(TASK, ignore).splitlines()) | set(read(PROJECT, ignore).splitlines())
assert set(read(MERGE, ignore).splitlines()) == union
assert len(read(MERGE, ignore).splitlines()) == len(union)
package = 'src/web/package.json'
packages = [json.loads(read(ref, package)) for ref in [TASK, PROJECT, MERGE]]
scripts = [p.pop('scripts') for p in packages]
assert packages[0] == packages[1] == packages[2], 'Dependency/metadata change'
assert all(scripts[0][key] == scripts[1][key] for key in scripts[0].keys() & scripts[1].keys())
assert scripts[2] == scripts[0] | scripts[1], 'Script lost or modified'
config = 'src/web/ui-migration/playwright.config.mjs'
texts = [read(ref, config).decode() for ref in [TASK, PROJECT, MERGE]]
assert len(set(re.sub(r'^  testIgnore:.*\n', '', text, flags=re.M) for text in texts)) == 1
assert re.search(r'^  testIgnore: (.*),$', texts[2], re.M)[1] == "['foundation*.browser.mjs', 'controls*.browser.mjs', 'overlays*.browser.mjs', 'choices*.browser.mjs', 'toasts*.browser.mjs']"
with tempfile.TemporaryDirectory() as directory:
    files = []
    for ref in [TASK, BASE, PROJECT]:
        path = Path(directory) / ref
        path.write_bytes(read(ref, README))
        files.append(str(path))
    automatic = subprocess.check_output(['git', 'merge-file', '-p', *files])
assert automatic == read(MERGE, README), 'README differs from conflict-free three-way merge'

preserved = {}
for label, ref, entries in [('task', TASK, task), ('project', PROJECT, project)]:
    history = [path for path in entries if path.startswith('docs/evidence/')]
    assert all(merged.get(path) == entries[path] for path in history)
    preserved[label] = {'parent': ref, 'historicalFiles': len(history), 'changedOrMissing': []}
    (OUT / f'diff-from-{label}-web.patch').write_bytes(git('diff', ref, MERGE, '--', 'src/web'))

r2 = 'docs/evidence/base-ui-migration/p2.2/revision-2/'
index = json.loads(read(MERGE, r2 + 'artifact-index-final.json'))
for path, digest in index.items():
    full = r2 + path
    assert full in merged, full
    assert hashlib.sha256((ROOT / full).read_bytes()).hexdigest() == digest, full
    assert git('hash-object', '--', full).decode().strip() == merged[full][1], full
logs = {path: index['reviewer/' + path] for path in [
    'choices-matrix.log', 'coordinator-choices-repeat.log', 'coordinator-edge.log']}
assert git('diff', MERGE, '--', 'src/web', 'package-lock.json', 'scripts') == b''
result = {
    'task': TASK, 'project': PROJECT, 'base': BASE, 'merge': MERGE,
    'tree': git('rev-parse', MERGE + '^{tree}').decode().strip(),
    'counts': counts, 'bothChanged': both, 'manualResolutions': MANUAL,
    'packageMetadataUnchanged': True, 'scriptsAreExactUnion': True,
    'baselineConfigOnlyTestIgnoreChanged': True, 'readmeAutomaticMergeUnmodified': True,
    'runtimeAndAssertionsPreservedFromRespectiveParents': True,
    'historicalEvidence': preserved, 'r2TrackedArtifactsVerified': len(index),
    'reviewerLogSha256': logs,
    'lockfile': {'gitBlob': merged['package-lock.json'][1],
                 'sha256': hashlib.sha256((ROOT / 'package-lock.json').read_bytes()).hexdigest()},
    'conflictBlobs': {path: {ref: entries[path][1] for ref, entries in
                           [('base', base), ('task', task), ('project', project), ('merge', merged)]}
                      for path in MANUAL},
    'unexpectedDifferences': [],
}
(OUT / 'merge-audit.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
