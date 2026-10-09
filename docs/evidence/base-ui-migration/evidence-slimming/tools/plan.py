# Decide, for every file of docs/evidence/base-ui-migration/ at the pre-slimming commit, what the slimming does.
# Usage (repository root): python3 -I plan.py <ls-tree listing> <links.json> <added.log> <plan.json>
#
# Actions: keep | report (replaced by a body-free summary) | trace | superseded | case (replaced by the
# directory's attachments.summary.json) | duplicate (byte-identical to a kept copy in the same task directory).
import collections, gzip, json, os, posixpath, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import classify as C

listing, links_path, added_path, out = sys.argv[1:5]
rows = C.load(listing)
by_path = {r['path']: r for r in rows}

# files individually referenced by a Markdown document (repository-wide); a superseded revision's own
# documents do not protect that revision's raw output except small figures/JSON (see below)
refs = json.load(open(links_path))
linked = collections.defaultdict(set)
for ref in refs:
    if ref['type'] == 'file':
        linked[ref['target']].add(ref['doc'])

# time each path was added (latest add wins if a path was added more than once)
added = {}
t = 0
for line in open(added_path):
    line = line.rstrip('\n')
    if line.startswith('\x01'):
        t = int(line[1:].split()[0])
    elif line:
        added[line] = max(added.get(line, 0), t)


def is_report(r):
    b = os.path.basename(r['rel'])
    if b in ('report.json', 'report.json.gz'):
        return True
    if not b.endswith('.json') or C.kind(r['rel']) == 'case-json':
        return False
    raw = open(r['path'], 'rb').read()
    try:
        d = json.loads(raw)
    except Exception:
        return False
    if not (isinstance(d, dict) and {'config', 'suites', 'stats'} <= set(d)):
        return False
    return b'"body"' in raw  # other names only when they carry attachment bodies


def summary_name(rel):
    b = os.path.basename(rel)
    if b in ('report.json', 'report.json.gz'):
        return posixpath.join(posixpath.dirname(rel), 'report.summary.json')
    return rel[:-len('.json')] + '.summary.json'


plan = []
for r in rows:
    rel, k = r['rel'], C.kind(r['rel'])
    sup = (not C.is_protected(rel)) and C.superseded(rel)
    act, why, repl = 'keep', None, None
    if C.is_protected(rel):
        why = 'protected'
    elif k == 'trace':
        act, why = 'trace', 'trace archive'
    elif (k in ('report', 'json', 'gz')) and is_report(r):
        act, why, repl = 'report', 'Playwright report: attachment bodies removed', summary_name(rel)
    elif k == 'doc':
        why = 'document or check text'
    elif k == 'json':
        why = 'summary, index or audit JSON'
    elif k == 'other':
        why = 'script, patch, log or manifest'
    elif sup:
        if k in ('image', 'case-json') and linked.get(r['path']):
            why = 'raw file individually linked from a document'
        else:
            act, why = 'superseded', 'raw output of a superseded revision'
    elif k == 'gz' and os.path.basename(rel) == 'attachments.tar.gz':
        act, why, repl = 'case', 'archive of per-test JSON attachments', posixpath.join(posixpath.dirname(rel), 'attachments.summary.json')
    elif k == 'case-json':
        if linked.get(r['path']):
            why = 'per-test JSON individually linked from a document'
        else:
            act, why, repl = 'case', 'per-test JSON attachment', posixpath.join(posixpath.dirname(rel), 'attachments.summary.json')
    elif k == 'image':
        why = 'screenshot or diff of an adopted revision'  # duplicates resolved below
    else:
        why = 'kept ' + k
    plan.append(dict(r, kind=k, action=act, reason=why, replacement=repl))

# Duplicate screenshots: within one task directory, byte-identical adopted copies keep one canonical copy.
# Canonical: a copy linked from a document (all linked copies stay), else the most recently added copy,
# ties broken by the lexicographically first path.
groups = collections.defaultdict(list)
for p in plan:
    if p['action'] == 'keep' and p['kind'] == 'image' and not C.is_protected(p['rel']) and not C.superseded(p['rel']):
        groups[(p['rel'].split('/')[0], p['blob'])].append(p)
for (top, blob), copies in groups.items():
    if len(copies) < 2:
        continue
    keep = [c for c in copies if linked.get(c['path'])]
    if not keep:
        keep = [sorted(copies, key=lambda c: (-added.get(c['path'], 0), c['path']))[0]]
    for c in copies:
        if c not in keep:
            c.update(action='duplicate', reason='byte-identical copy of a kept screenshot in the same task directory',
                     replacement=keep[0]['path'][len(C.P):])

# replacement files must not collide with existing files that stay
existing = {p['rel'] for p in plan if p['action'] == 'keep'}
for p in plan:
    if p['action'] in ('report', 'case') and p['replacement'] in existing:
        raise SystemExit(f"replacement collides with a kept file: {p['replacement']}")
reps = collections.Counter(p['replacement'] for p in plan if p['action'] == 'report')
dup = [k for k, v in reps.items() if v > 1]
if dup:
    raise SystemExit(f'two reports map to one summary: {dup}')

json.dump(plan, open(out, 'w'))
agg = collections.defaultdict(lambda: [0, 0])
for p in plan:
    agg[(p['action'], p['reason'])][0] += p['size']; agg[(p['action'], p['reason'])][1] += 1
for (a, w), (s, n) in sorted(agg.items(), key=lambda x: (x[0][0] != 'keep', -x[1][0])):
    print(f'{a:10s} {s/1e6:9.2f} MB {n:7d}  {w}')
kept = sum(p['size'] for p in plan if p['action'] == 'keep')
print('kept bytes (before new summaries/notes):', kept, 'files', sum(1 for p in plan if p['action'] == 'keep'))
