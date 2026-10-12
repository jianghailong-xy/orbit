# Classify every file of docs/evidence/base-ui-migration/ in a `git ls-tree -r -l` listing.
# Usage: python3 -I classify.py <ls-tree listing> [--json out.json]
import json, os, re, sys, collections

P = 'docs/evidence/base-ui-migration/'
PROTECTED = ('p0.2/', 'p0-drift/', 'p0-drift-2/', 'p0-drift-3/', 'inventory-delta/')
# Superseded, not adopted evidence revisions (decision records: task_evidence_decide in the coordinators'
# transcripts; the adopted revision is the last CONFIRM). Paths are relative to the evidence root; a
# directory's top level (the first revision) is named by its run directories.
SUPERSEDED = {
    # P2.1 r1 SEND_BACK, r2 CONFIRM (revision-2/)
    'p2.1': ['checks/', 'controls-regression/', 'diagnostics/', 'foundation-regression/', 'overlays-complete/', 'overlays-run/'],
    # P2.2 r1 SEND_BACK, r2..r7 replaced, r8 CONFIRM (revision-8/)
    'p2.2': ['checks/', 'diagnostics/', 'final-surfaces/', 'full-matrix/', 'overlay-regressions/', 'submenu-repeat/',
             'revision-2/', 'revision-3/', 'revision-4/', 'revision-5/', 'revision-6/', 'revision-7/'],
    # P2.3 r1 and r2 SEND_BACK, r3 CONFIRM (revision-3/)
    'p2.3': ['checks/', 'diagnostics/', 'overlays-regression/', 'production-reference-run/', 'production-run/',
             'reference-run/', 'toasts-run/', 'revision-2/'],
}
ATTACHMENT = re.compile(r'^(chromium|webkit)-(light|dark)-(desktop|phone)--')


def is_protected(rel):
    if '/' not in rel:
        return True
    top = rel.split('/')[0]
    return rel.startswith(PROTECTED) or top.endswith('-accepted')


def superseded(rel):
    top, rest = rel.split('/', 1)
    return any(rest.startswith(p) for p in SUPERSEDED.get(top, []))


def kind(rel):
    b = os.path.basename(rel)
    ext = os.path.splitext(b)[1].lower()
    if b == 'report.json':
        return 'report'
    if b.endswith('.zip'):
        return 'trace' if 'trace' in b else 'zip'
    if ext in ('.md', '.txt'):
        return 'doc'
    if ext == '.png' or ext == '.jpeg':
        return 'image'
    if ext == '.json':
        return 'case-json' if ATTACHMENT.match(b) else 'json'
    if ext == '.gz':
        return 'gz'
    return 'other'


def load(listing):
    rows = []
    for line in open(listing):
        meta, path = line.rstrip('\n').split('\t', 1)
        mode, typ, sha, size = meta.split()
        rows.append({'path': path, 'rel': path[len(P):], 'blob': sha, 'size': int(size)})
    return rows


if __name__ == '__main__':
    rows = load(sys.argv[1])
    agg = collections.defaultdict(lambda: [0, 0])
    for r in rows:
        rel = r['rel']
        if is_protected(rel):
            cls = 'protected'
        else:
            cls = ('superseded:' if superseded(rel) else 'adopted:') + kind(rel)
        r['class'] = cls
        agg[cls][0] += r['size']; agg[cls][1] += 1
    for k, (s, n) in sorted(agg.items(), key=lambda x: -x[1][0]):
        print(f'{s/1e6:9.2f} MB {n:7d}  {k}')
    if '--json' in sys.argv:
        json.dump(rows, open(sys.argv[sys.argv.index('--json') + 1], 'w'))
