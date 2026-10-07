#!/usr/bin/env python3
"""What merging main into the delivery touched: usage merge-scope.py BASE BATCH MAIN MERGED (README "第 2 轮").

BASE is the project tip the batch started from, BATCH the delivered tip, MAIN the main commit merged in
(once the project line has moved as well: the merge of its tip and main, without this batch), MERGED the
commit under test. Reads git only, prints JSON and checks, exits 1 if a check fails:
- every file both sides changed carries exactly both sides' changed lines (BASE→BATCH equals MAIN→MERGED,
  BASE→MAIN equals BATCH→MERGED, as multisets of +/- lines);
- every other file the batch changed is the batch's blob, every other file main changed is main's, apart
  from the files `--round2` names (changed on purpose in round 2);
- the index.css selectors each side changed do not overlap;
- which of main's changed web sources import a module the batch changed (through components/ui's own
  imports too), and whether any ui-migration fixture or the pilot's own sources use the first class of
  a selector main's index.css changed."""
import json
import posixpath
import re
import subprocess
import sys
from collections import Counter

BASE, BATCH, MAIN, MERGED = sys.argv[1:5]
ROUND2 = set(sys.argv[sys.argv.index('--round2') + 1:]) if '--round2' in sys.argv else set()
EVIDENCE = 'docs/evidence/base-ui-migration/p3.2/'


def git(*args):
    return subprocess.check_output(['git', *args], text=True, stderr=subprocess.DEVNULL)


def changed(a, b, *paths):
    return set(git('diff', '--name-only', a, b, '--', *paths).split())


def blob(rev, path):
    try:
        return git('rev-parse', f'{rev}:{path}').strip()
    except subprocess.CalledProcessError:
        return None


def show(rev, path):
    try:
        return git('show', f'{rev}:{path}')
    except subprocess.CalledProcessError:
        return None


def lines(a, b, path):
    out = git('diff', '-U0', a, b, '--', path).splitlines()
    return Counter(l for l in out if l[:1] in '+-' and not l.startswith(('+++', '---')))


checks = []


def check(text, ok):
    checks.append({'claim': text, 'holds': bool(ok)})


batch, main = changed(BASE, BATCH), changed(BASE, MAIN)
both = sorted(batch & main)
for path in both:
    check(f'{path}: MERGED is MAIN plus exactly the batch\'s changed lines', lines(BASE, BATCH, path) == lines(MAIN, MERGED, path))
    check(f'{path}: MERGED is BATCH plus exactly main\'s changed lines', lines(BASE, MAIN, path) == lines(BATCH, MERGED, path))
batch_only = sorted(p for p in batch - main if not p.startswith(EVIDENCE))
main_only = sorted(main - batch)
batch_moved = [p for p in batch_only if blob(MERGED, p) != blob(BATCH, p)]
main_moved = [p for p in main_only if blob(MERGED, p) != blob(MAIN, p)]
check(f'the batch\'s other {len(batch_only)} files (its evidence aside) are its own blobs, but for {sorted(ROUND2 & set(batch_only))}',
      set(batch_moved) <= ROUND2)
check(f'main\'s other {len(main_only)} files are main\'s own blobs, but for {sorted(ROUND2 & set(main_only))}', set(main_moved) <= ROUND2)
check('main changed nothing under src/web/src/components/ui', not changed(BASE, MAIN, 'src/web/src/components/ui'))
harness = sorted(changed(BASE, MAIN, 'src/web/ui-migration'))
matrices = re.compile(r'src/web/ui-migration/(foundation|controls|overlays|choices|composer|toasts|reviews)[^/]*$')
check(f'under src/web/ui-migration main changed no component-matrix file (it changed {[p.rsplit("/", 1)[1] for p in harness]})',
      not any(matrices.match(p) for p in harness))


def selectors(a, b):
    found = set()
    for l in lines(a, b, 'src/web/src/index.css'):
        m = re.match(r'^[+-]\s*([^{}/*][^{}]*)\{', l)
        if m:
            found.update(s.strip() for s in m.group(1).split(',') if s.strip())
    return found


css_batch, css_main = selectors(BASE, BATCH), selectors(BASE, MAIN)
check('index.css: no selector changed by both sides', not (css_batch & css_main))
# A rule reaches only elements under (or carrying) its selector's first class, so that class is what a
# source has to use for one of main's rules to apply to it. At-rule preludes (@media, @container) carry
# no class.
anchors = {}
for s in css_main:
    if s.startswith('@'):
        continue
    first = re.search(r'\.([a-zA-Z][\w-]*)', s)
    anchors.setdefault(first.group(1) if first else s, []).append(s)
main_classes = sorted(anchors)

# Main's changed web sources that reach a module the batch changed.
batch_web = {p for p in batch if p.startswith('src/web/src/') and '.test.' not in p}


def resolve(source, spec):
    if not spec.startswith('.'):
        return None
    stem = posixpath.normpath(posixpath.join(posixpath.dirname(source), spec))
    for candidate in (stem, stem + '.tsx', stem + '.ts', stem + '/index.ts', stem + '/index.tsx'):
        if blob(MERGED, candidate):
            return candidate
    return None


def imports(path):
    text = show(MERGED, path) or ''
    return [r for r in (resolve(path, s) for s in re.findall(r"(?:from|import)\s+'([^']+)'", text)) if r]


def reach(path):
    seen, todo = set(), imports(path)
    while todo:
        dep = todo.pop()
        if dep in seen:
            continue
        seen.add(dep)
        if '/components/ui/' in dep:
            todo.extend(imports(dep))
    return seen


main_web = sorted(p for p in main if p.startswith('src/web/src/') and '.test.' not in p and re.search(r'\.(tsx?|css)$', p))
reaching = {p: sorted(reach(p) & batch_web) for p in main_web}
reaching = {p: v for p, v in reaching.items() if v}

# Which sources use the first class of a selector main's index.css changed: the component fixtures (the
# P1–P3.1 matrices and the review dialogs) and the pilot's own files.
users = {}
pilot = ['src/web/src/components/TaskDetailPanel.tsx', 'src/web/src/components/ShareModal.tsx',
         'src/web/src/components/TaskInputs.tsx', 'src/web/src/components/AccountSelect.tsx']
fixtures = [p for p in git('ls-tree', '-r', '--name-only', MERGED, 'src/web/ui-migration').split() if re.search(r'\.(tsx|html|css)$', p)]
for path in pilot + fixtures:
    text = show(MERGED, path) or ''
    hits = sorted(c for c in main_classes if re.search(rf'(?<![\w-]){re.escape(c)}(?![\w-])', text))
    if hits:
        users[path] = hits
check('no ui-migration fixture and no pilot source uses the first class of a selector main\'s index.css changed', not users)

json.dump({'commits': {'base': BASE, 'batch': BATCH, 'main': MAIN, 'merged': MERGED},
           'changedByBoth': both, 'batchOnly': len(batch_only), 'mainOnly': len(main_only),
           'movedInRound2': {'batch': batch_moved, 'main': main_moved},
           'indexCss': {'batchSelectors': sorted(css_batch), 'mainSelectors': len(css_main), 'mainAnchorClasses': main_classes},
           'mainSourcesReachingBatch': reaching, 'mainCssClassUsers': users, 'checks': checks},
          sys.stdout, indent=1, ensure_ascii=False)
print()
for c in checks:
    print(('ok    ' if c['holds'] else 'FAILS ') + c['claim'], file=sys.stderr)
sys.exit(0 if all(c['holds'] for c in checks) else 1)
