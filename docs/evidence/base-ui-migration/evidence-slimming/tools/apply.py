# Apply one stage of plan.json to the working tree (repository root), then stage it with git.
# Usage: python3 -I apply.py <plan.json> <stage>   stage: report | trace | superseded | case | duplicate
import collections, gzip, hashlib, io, json, os, posixpath, subprocess, sys, tarfile

BASE = '7732f14f82d4e6b4406d7d164c4b672f63aa0f56'
P = 'docs/evidence/base-ui-migration/'
plan_path, stage = sys.argv[1], sys.argv[2]
plan = [p for p in json.load(open(plan_path)) if p['action'] == stage]


def write_json(path, obj):
    with open(path, 'w', encoding='utf-8') as f:
        f.write(json.dumps(obj, ensure_ascii=False, indent=1) + '\n')


def strip_bodies(o):
    if isinstance(o, dict):
        if isinstance(o.get('attachments'), list):
            for a in o['attachments']:
                if isinstance(a, dict):
                    a.pop('body', None)
        for v in o.values():
            strip_bodies(v)
    elif isinstance(o, list):
        for v in o:
            strip_bodies(v)


def fields(raw):
    """Top-level scalar fields (and short scalar lists) of one JSON attachment."""
    try:
        d = json.loads(raw)
    except Exception:
        return None
    if not isinstance(d, dict):
        return None
    out = {}
    for k, v in d.items():
        if isinstance(v, str):
            out[k] = v if len(v) <= 200 else v[:200] + '…'
        elif v is None or isinstance(v, (bool, int, float)):
            out[k] = v
        elif isinstance(v, list) and len(v) <= 20 and all(x is None or isinstance(x, (str, bool, int, float)) for x in v):
            out[k] = v
    return out


def entry(name, raw):
    e = {'name': name, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
    f = fields(raw)
    if f:
        e['fields'] = f
    return e


removed = []
if stage == 'report':
    for p in plan:
        raw = open(p['path'], 'rb').read()
        if p['path'].endswith('.gz'):
            raw = gzip.decompress(raw)
        report = json.loads(raw)
        strip_bodies(report)
        write_json(P + p['replacement'], report)
        removed.append(p['path'])
elif stage == 'case':
    by_dir = collections.defaultdict(list)
    for p in plan:
        by_dir[posixpath.dirname(p['rel'])].append(p)
    for d, items in sorted(by_dir.items()):
        files, archives = [], []
        for p in sorted(items, key=lambda p: p['rel']):
            raw = open(p['path'], 'rb').read()
            if p['rel'].endswith('.tar.gz'):
                members = []
                with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as tar:
                    for m in tar.getmembers():
                        if m.isfile():
                            members.append(entry(m.name, tar.extractfile(m).read()))
                archives.append({'name': posixpath.basename(p['rel']), 'bytes': len(raw),
                                 'sha256': hashlib.sha256(raw).hexdigest(), 'members': members})
            else:
                files.append(entry(posixpath.basename(p['rel']), raw))
            removed.append(p['path'])
        summary = {
            'summaryOf': 'Per-test JSON attachments of this directory, removed by the evidence slimming '
                         '(docs/evidence/base-ui-migration/evidence-slimming/README.md). Each entry gives the file name, '
                         'size, SHA-256 and its top-level scalar fields; the test results are in summary.json / '
                         'report.summary.json and the numbers the conclusions use are in the README.',
            'originals': BASE,
            'retrieve': f'git show {BASE}:{P}{d}/<name>',
        }
        if files:
            summary['files'] = files
        if archives:
            summary['archives'] = archives
        write_json(P + d + '/attachments.summary.json', summary)
else:
    removed = [p['path'] for p in plan]

for path in removed:
    os.remove(path)
# stage deletions and new summaries of the evidence directory only
subprocess.run(['git', 'add', '-A', '--', P], check=True)
print(stage, 'removed files', len(removed), 'bytes', sum(p['size'] for p in plan))
