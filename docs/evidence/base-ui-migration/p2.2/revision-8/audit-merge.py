"""Verify the r8 absorb merges: ancestry, tree equality, per-file provenance and preserved evidence."""
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[5]
HERE = Path(__file__).resolve().parent
REFS = {
    'acceptedR7': '45bb56928225bbe6d00800180ebcc73f26250fd4',
    'upstream': '6cdca5a03d7baabe124c6ea8ae387c5269ce492e',
    'upstreamFinal': 'bf12315af31d56de71229b7ffa5ebfe2219efef5',
    'project': '18e75cfe14d0a0858c9a46e514535439c9cdf9d8',
    'acceptedP22': 'd71afc686760eb4a37c84822bf1ea478dbe8fcf1',
    'notificationDelivery': '59c439e47515f15f581a76318df0ecad6b23e53e',
    'previousUpstream': '53da29cc1e799e1b5a82e98167305d9b41cc54cc',
    'merge': '38947755e48ac979362db36f82bfcf966b527a75',
    'mergeFinal': '8a29e349324e7aaca83827a52148b540c118b992',
}
OUT = HERE / 'merge-audit.json'
FIXTURE_INPUT_PREFIXES = ('src/web/src/components/ui/', 'src/web/ui-migration/')
FIXTURE_INPUT_FILES = ['package-lock.json', 'src/web/package.json', 'src/web/.gitignore', 'src/web/vite.config.ts',
                       'src/web/tsconfig.json', 'src/web/src/components/ToastViewport.tsx', 'src/web/src/lib/toast.tsx',
                       'src/web/src/lib/toastStore.ts', 'src/web/src/lib/toastFeed.ts', 'src/web/src/lib/theme.tsx']


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, text=True).strip()


def tree(ref):
    entries = {}
    for line in git('ls-tree', '-r', ref).splitlines():
        meta, path = line.split('\t', 1)
        entries[path] = meta
    return entries


def changed(a, b):
    return sorted(p for p in set(a) | set(b) if a.get(p) != b.get(p))


def change_lines(*args):
    # The +/- lines of a patch, without file headers or hunk positions.
    return [line for line in git('diff', *args).splitlines()
            if line[:1] in '+-' and not line.startswith(('+++ ', '--- '))]


def audit(merge, ours, theirs, expected_both):
    parents = git('show', '-s', '--format=%P', merge).split()
    assert parents == [ours, theirs]
    base = git('merge-base', ours, theirs)
    preview = git('merge-tree', '--write-tree', ours, theirs)
    assert preview == git('rev-parse', merge + '^{tree}')
    H, O, T, B = tree(merge), tree(ours), tree(theirs), tree(base)
    both = sorted(set(changed(B, O)) & set(changed(B, T)))
    assert both == expected_both, both
    from_theirs, from_ours = changed(O, H), changed(T, H)
    # Outside the files both sides edited, every merged blob is byte-identical to one parent.
    assert all(H.get(p) == T.get(p) for p in from_theirs if p not in both)
    assert all(H.get(p) == O.get(p) for p in from_ours if p not in both)
    merged = []
    for path in both:
        theirs_lines, ours_lines = change_lines(base, theirs, '--', path), change_lines(base, ours, '--', path)
        assert change_lines(ours, merge, '--', path) == theirs_lines
        assert change_lines(theirs, merge, '--', path) == ours_lines
        merged.append({'path': path, 'base': B[path], 'ours': O[path], 'theirs': T[path], 'merge': H[path],
                       'theirsChangeLinesKeptVerbatim': len(theirs_lines), 'oursChangeLinesKeptVerbatim': len(ours_lines)})
    history = [p for p in O if p.startswith('docs/evidence/')]
    assert all(H.get(p) == O[p] for p in history)
    inputs = [p for p in O if (p.startswith(FIXTURE_INPUT_PREFIXES) and not p.startswith('src/web/ui-migration/reviews'))
              or p in FIXTURE_INPUT_FILES]
    changed_inputs = [p for p in inputs if H.get(p) != O[p]]
    upstream_web = [p for p in from_theirs if p.startswith('src/web/')]
    return {'merge': merge, 'parents': parents, 'mergeBase': base, 'tree': preview,
            'webTree': git('rev-parse', merge + ':src/web'), 'mergeTreePreviewEqualsCommit': True,
            'conflicts': [], 'manualResolutions': [], 'filesFromUpstream': len(from_theirs),
            'webFilesFromUpstream': len(upstream_web), 'filesFromOurSide': len(from_ours),
            'everyOtherBlobEqualsOneParent': True, 'editedOnBothSides': merged,
            'historicalEvidenceUnchanged': len(history),
            'migrationEvidenceUnchanged': len([p for p in history if p.startswith('docs/evidence/base-ui-migration/')]),
            'componentFixtureNotificationConfigAndLockInputs': len(inputs), 'changedAmongThoseInputs': changed_inputs}


first = audit(REFS['merge'], REFS['acceptedR7'], REFS['upstream'],
              ['src/web/src/components/ToastViewport.tsx', 'src/web/src/index.css', 'src/web/src/lib/toast.test.tsx'])
assert first['mergeBase'] == REFS['previousUpstream'] and first['changedAmongThoseInputs'] == ['src/web/src/components/ToastViewport.tsx']
assert change_lines(REFS['acceptedR7'], REFS['merge'], '--', 'package.json') == ['-  "version": "0.1.210",', '+  "version": "0.1.213",']
second = audit(REFS['mergeFinal'], REFS['merge'], REFS['upstreamFinal'], ['src/web/src/index.css'])
assert second['mergeBase'] == REFS['upstream'] and second['changedAmongThoseInputs'] == []
assert change_lines(REFS['merge'], REFS['mergeFinal'], '--', 'package.json') == ['-  "version": "0.1.213",', '+  "version": "0.1.215",']
final = REFS['mergeFinal']
ancestors = {name: subprocess.run(['git', 'merge-base', '--is-ancestor', ref, final], cwd=ROOT).returncode == 0
             for name, ref in REFS.items()}
assert all(ancestors.values())
report = {'refs': REFS, 'finalAncestors': ancestors, 'merges': [first, second],
          'rootPackageJson': 'version 0.1.210 -> 0.1.213 -> 0.1.215, both from upstream'}
OUT.write_text(json.dumps(report, indent=2) + '\n')
(HERE / 'upstream-delta.name-status.txt').write_text(git('diff', '--name-status', REFS['acceptedR7'], final) + '\n')
(HERE / 'upstream-web-delta.patch').write_text(git('diff', REFS['acceptedR7'], final, '--', 'src/web') + '\n')
print(json.dumps([{k: m[k] for k in ['merge', 'parents', 'tree', 'filesFromUpstream', 'webFilesFromUpstream',
                                       'migrationEvidenceUnchanged', 'componentFixtureNotificationConfigAndLockInputs',
                                       'changedAmongThoseInputs']} | {'both': [b['path'] for b in m['editedOnBothSides']]}
                  for m in report['merges']], indent=1))
