"""Audit the upstream advancement received during final validation."""
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[5]
HERE = Path(__file__).resolve().parent
BEFORE = 'f5fc726d43ebf80fe60c04b6508e8de73643cbbd'
UPSTREAM_BEFORE = 'd22b276cccbac66b672e25944be0317d6df420eb'
UPSTREAM = '1970483d2da30c17372c681958a44d1b3da77694'
FINAL = 'baec95275814fdeb6a6530fefeb533338a426787'


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, text=True).strip()


def tree(ref):
    return {line.split('\t', 1)[1]: line.split('\t', 1)[0]
            for line in git('ls-tree', '-r', ref).splitlines()}


before, after, upstream = tree(BEFORE), tree(FINAL), tree(UPSTREAM)
parents = git('show', '-s', '--format=%P', FINAL).split()
assert parents == [BEFORE, UPSTREAM]
assert git('merge-tree', '--write-tree', *parents) == git('rev-parse', FINAL + '^{tree}')
delta = sorted(p for p in set(before) | set(after) if before.get(p) != after.get(p))
assert delta == sorted(git('diff', '--name-only', UPSTREAM_BEFORE, UPSTREAM).splitlines())
assert all(after.get(p) == upstream.get(p) for p in delta if p != 'src/web/src/index.css')
# CSS is the sole overlapping file: retain both complete, disjoint additions via Git's clean merge.
assert git('diff', '--numstat', BEFORE, FINAL, '--', 'src/web/src/index.css') == '90\t0\tsrc/web/src/index.css'
fixed = [p for p in before if p.startswith('src/web/src/components/ui/')
         or p.startswith('src/web/ui-migration/')
         or p in ['package.json', 'package-lock.json', 'src/web/package.json',
                  'src/web/.gitignore', 'src/web/src/components/ToastViewport.tsx']]
assert all(before[p] == after.get(p) for p in fixed)
history = [p for p in before if p.startswith('docs/evidence/base-ui-migration/')]
assert all(before[p] == after.get(p) for p in history)
ancestors = {}
for ref in [UPSTREAM, '18e75cfe14d0a0858c9a46e514535439c9cdf9d8',
            'd71afc686760eb4a37c84822bf1ea478dbe8fcf1',
            '59c439e47515f15f581a76318df0ecad6b23e53e']:
    ancestors[ref] = subprocess.run(['git', 'merge-base', '--is-ancestor', ref, FINAL], cwd=ROOT).returncode == 0
assert all(ancestors.values())
report = {'before': BEFORE, 'previousUpstream': UPSTREAM_BEFORE, 'upstream': UPSTREAM,
          'finalTestedCommit': FINAL, 'parents': parents, 'ancestors': ancestors,
          'tree': git('rev-parse', FINAL + '^{tree}'), 'webTree': git('rev-parse', FINAL + ':src/web'),
          'conflicts': [], 'manualResolutions': [], 'deltaFiles': delta,
          'allNonCssDeltaBlobsEqualUpstream': True,
          'css': 'Clean Git merge: only 90 upstream session-project declarations added; notification CSS retained.',
          'unchangedComponentsFixturesConfigsDependencies': len(fixed),
          'unchangedHistoricalEvidenceFiles': len(history)}
(HERE / 'upstream-audit.json').write_text(json.dumps(report, indent=2) + '\n')
(HERE / 'upstream-delta.source.patch').write_text(git('diff', BEFORE, FINAL, '--', '.', ':!docs/evidence') + '\n')
(HERE / 'upstream-delta.name-status.txt').write_text(git('diff', '--name-status', BEFORE, FINAL) + '\n')
print(json.dumps({k: v for k, v in report.items() if k != 'deltaFiles'}, indent=2))
