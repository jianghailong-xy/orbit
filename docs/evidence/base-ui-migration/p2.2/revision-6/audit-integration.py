"""Verify the merge's ancestry and byte-preserving reuse of both deliveries."""
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[5]
HERE = Path(__file__).resolve().parent
REFS = {
    'acceptedP22': 'd71afc686760eb4a37c84822bf1ea478dbe8fcf1',
    'notificationDelivery': '59c439e47515f15f581a76318df0ecad6b23e53e',
    'notificationRuntime': 'd6d32fe69a8e331b199f08022979d95d0fc1eb94',
    'project': '18e75cfe14d0a0858c9a46e514535439c9cdf9d8',
    'upstream': 'd22b276cccbac66b672e25944be0317d6df420eb',
    'combined': 'f5fc726d43ebf80fe60c04b6508e8de73643cbbd',
}


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, text=True).strip()


def tree(ref):
    entries = {}
    for line in git('ls-tree', '-r', ref).splitlines():
        meta, path = line.split('\t', 1)
        entries[path] = meta
    return entries


combined = tree(REFS['combined'])
parents = git('show', '-s', '--format=%P', REFS['combined']).split()
assert parents == [REFS['acceptedP22'], REFS['notificationDelivery']]
ancestors = {}
for name, ref in REFS.items():
    ancestors[name] = subprocess.run(['git', 'merge-base', '--is-ancestor', ref,
                                     REFS['combined']], cwd=ROOT).returncode == 0
assert all(ancestors.values())
preview = git('merge-tree', '--write-tree', *parents)
assert preview == git('rev-parse', REFS['combined'] + '^{tree}')
report = {'refs': REFS, 'parents': parents, 'ancestors': ancestors,
          'tree': preview, 'webTree': git('rev-parse', REFS['combined'] + ':src/web'),
          'conflicts': [], 'manualResolutions': [], 'parentsAudit': {}}
for name, other in [('acceptedP22', 'notificationDelivery'),
                    ('notificationDelivery', 'acceptedP22')]:
    source = tree(REFS[name])
    opposite = tree(REFS[other])
    history = [p for p in source if p.startswith('docs/evidence/base-ui-migration/')]
    assert all(combined.get(p) == source[p] for p in history)
    delta = sorted(p for p in set(source) | set(combined) if source.get(p) != combined.get(p))
    # Every changed blob is already present in the other accepted delivery; no new implementation.
    assert all(combined.get(p) == opposite.get(p) for p in delta)
    runtime = [p for p in delta if not p.startswith('docs/evidence/')]
    report['parentsAudit'][name] = {
        'historicalFilesUnchanged': len(history), 'totalDeltaFiles': len(delta),
        'allChangedBlobsEqualOtherParent': True,
        'nonEvidenceDelta': [{'path': p, 'before': source.get(p), 'after': combined.get(p)} for p in runtime],
    }
    (HERE / ('from-' + name + '.name-status.txt')).write_text(
        git('diff', '--name-status', REFS[name], REFS['combined']) + '\n')
    (HERE / ('from-' + name + '.source.patch')).write_text(
        git('diff', REFS[name], REFS['combined'], '--', '.', ':!docs/evidence') + '\n')

prior = tree(REFS['acceptedP22'])
choice_files = [p for p in prior if p.startswith('src/web/src/components/ui/')
                or p.startswith('src/web/ui-migration/choices')]
assert all(combined.get(p) == prior[p] for p in choice_files)
notify = tree(REFS['notificationDelivery'])
notify_files = [p for p in notify if p.startswith('src/web/ui-migration/toasts')
                or p in ['src/web/src/components/ToastViewport.tsx', 'src/web/src/index.css',
                         'src/web/src/lib/toast.test.tsx']]
assert all(combined.get(p) == notify[p] for p in notify_files)
runtime = tree(REFS['notificationRuntime'])
notify_docs = [p for p in set(runtime) | set(notify) if runtime.get(p) != notify.get(p)]
assert len(notify_docs) == 2701
assert all(p.startswith('docs/evidence/base-ui-migration/p2-promotion-toast/')
           and p not in runtime for p in notify_docs)
for path in ['package.json', 'package-lock.json', 'src/web/package.json',
             'src/web/.gitignore', 'src/web/ui-migration/playwright.config.mjs']:
    assert combined[path] == prior[path]
report.update(unchangedP22ComponentAndChoiceFiles=len(choice_files),
              unchangedNotificationFiles=len(notify_files),
              notificationArchiveOnlyAddedFiles=len(notify_docs),
              p22ScriptsDependenciesAndDiscoveryConfigsPreserved=True)
(HERE / 'integration-audit.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
