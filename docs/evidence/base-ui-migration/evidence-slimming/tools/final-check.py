# Check the slimmed tree (HEAD) against the task's acceptance points. Usage (repository root):
#   python3 -I final-check.py <plan.json>
# Exit 0 only if every check holds.
import gzip, json, os, posixpath, re, subprocess, sys

BASE = '7732f14f82d4e6b4406d7d164c4b672f63aa0f56'
P = 'docs/evidence/base-ui-migration/'
plan = json.load(open(sys.argv[1]))
git = lambda *a: subprocess.run(['git', *a], capture_output=True, text=True, check=True).stdout
results = []


def check(name, ok, detail):
    results.append((name, ok, detail))
    print(('PASS ' if ok else 'FAIL ') + name + ': ' + detail)


def tree(ref):
    sizes = {}
    for line in git('ls-tree', '-r', '-l', ref, '--', P).splitlines():
        meta, path = line.split('\t', 1)
        sizes[path] = (int(meta.split()[3]), meta.split()[2])
    return sizes


head, base = tree('HEAD'), tree(BASE)
total = sum(s for s, _ in head.values())
check('size', total < 500_000_000, f'{total:,} bytes in {len(head):,} files (base {sum(s for s, _ in base.values()):,} bytes in {len(base):,} files)')

traces = [p for p in head if re.search(r'trace[^/]*\.zip$', p)]
check('no trace archives', not traces, f'{len(traces)} *trace*.zip files')

PROTECTED = ('p0.2/', 'p0-drift/', 'p0-drift-2/', 'p0-drift-3/', 'inventory-delta/')
def protected(rel):
    return '/' not in rel or rel.startswith(PROTECTED) or rel.split('/')[0].endswith('-accepted')

bodies = []
for p in head:
    rel = p[len(P):]
    if protected(rel) or not (p.endswith('.json') or p.endswith('.json.gz')):
        continue
    raw = subprocess.run(['git', 'cat-file', 'blob', f'HEAD:{p}'], capture_output=True, check=True).stdout
    if p.endswith('.gz'):
        raw = gzip.decompress(raw)
    if b'"body"' not in raw or b'"suites"' not in raw:
        continue
    d = json.loads(raw)
    if isinstance(d, dict) and {'config', 'suites', 'stats'} <= set(d):
        def has_body(o):
            if isinstance(o, dict):
                if isinstance(o.get('attachments'), list) and any(isinstance(a, dict) and 'body' in a for a in o['attachments']):
                    return True
                return any(has_body(v) for v in o.values())
            if isinstance(o, list):
                return any(has_body(v) for v in o)
            return False
        if has_body(d):
            bodies.append(rel)
outside_reports = [p for p in head if p.endswith('/report.json') and not protected(p[len(P):])]
check('no report with attachment bodies outside the protected directories', not bodies and not outside_reports,
      f'{len(bodies)} reports with bodies, {len(outside_reports)} report.json outside protected directories')

summaries = [p['replacement'] for p in plan if p['action'] == 'report']
missing = [s for s in summaries if P + s not in head]
check('every replaced report has its summary', not missing, f'{len(summaries) - len(missing)}/{len(summaries)} summaries present')

prot_paths = [p for p in base if protected(p[len(P):])]
changed = [p for p in prot_paths if head.get(p) != base[p]] + [p for p in head if protected(p[len(P):]) and p not in base and not p.endswith('/.gitignore')]
check('protected directories and root files unchanged', not changed,
      f'{len(prot_paths)} protected files compared by blob; {len(changed)} differ (root .gitignore is new and allowed)')

read_by_code = ['p0.2/baseline-run/summary.json', 'p0.2/environment.json', 'p0-drift/reference/registry.json', 'p0-drift/accepted/registry.json',
                'p2.3-b1/README.md', 'p3.2/README.md', 'p0-drift-2/isolation/profile-validation-b1-fix.json', 'audit-baseline.json', 'ownership.json',
                'css-ownership.json', 'routes-and-tests.md', 'component-contracts.md']
gone = [r for r in read_by_code if P + r not in head]
check('files read by src/web code present', not gone, f'{len(read_by_code) - len(gone)}/{len(read_by_code)} named files (plus every protected file above)')

# Markdown links from outside the evidence directory, resolved against HEAD
md = [f for f in git('ls-files', '*.md').split('\n') if f and not f.startswith(P)]
dangling = []; nlinks = 0
for doc in md:
    text = open(doc, encoding='utf-8', errors='replace').read()
    for m in re.finditer(r'\]\(\s*<?([^)\s>]+)>?', text):
        t = m.group(1).split('#')[0]
        if 'base-ui-migration' not in t or re.match(r'^[a-z]+:', t):
            continue
        tgt = posixpath.normpath(posixpath.join(posixpath.dirname(doc), t))
        nlinks += 1
        if tgt not in head and not any(h.startswith(tgt + '/') for h in head):
            dangling.append(f'{doc} -> {tgt}')
check('files linked from Markdown outside the evidence directory present', not dangling, f'{nlinks} links, {len(dangling)} dangling')

tops = sorted({p['rel'].split('/')[0] for p in plan if p['action'] != 'keep'})
no_note = [t for t in tops if BASE not in open(P + t + '/README.md', encoding='utf-8').read()]
check('every slimmed directory README names the full-originals commit', not no_note, f'{len(tops) - len(no_note)}/{len(tops)} top-level READMEs')

outside = [f for f in git('diff', '--name-only', '--no-renames', BASE, 'HEAD').split('\n') if f and not f.startswith(P)]
check('changes only inside docs/evidence/base-ui-migration/', not outside, f'{len(outside)} files outside')

slim = sum(s for p, (s, _) in head.items() if p.startswith(P + 'evidence-slimming/'))
check('this task\'s own evidence under 30 MB', slim < 30_000_000, f'evidence-slimming/ is {slim:,} bytes')

print(json.dumps({'head': git('rev-parse', 'HEAD').strip(), 'passed': sum(1 for _, ok, _ in results if ok), 'checks': len(results)}))
sys.exit(0 if all(ok for _, ok, _ in results) else 1)
