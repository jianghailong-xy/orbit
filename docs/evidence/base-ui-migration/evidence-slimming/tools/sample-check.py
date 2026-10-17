# Retrieve a sample of removed files from the commit the READMEs name and check their hashes.
# Usage (repository root): python3 -I sample-check.py <removed.tsv.gz> <out.json>
# For each sampled path: `git show <BASE>:<path>` -> git blob id (must equal removed.tsv's blob) and SHA-256
# (must equal every SHA-256 the slimmed tree still records for that file, where it records one: the
# directory's attachments.summary.json, a run summary.json/artifact-index/manifest, or for a duplicate
# screenshot the kept copy's bytes).
import gzip, hashlib, json, os, random, re, subprocess, sys

BASE = '7732f14f82d4e6b4406d7d164c4b672f63aa0f56'
P = 'docs/evidence/base-ui-migration/'
rows = []
for line in gzip.open(sys.argv[1], 'rt', encoding='utf-8'):
    if line.startswith('#') or line.startswith('path\t'):
        continue
    path, size, blob, action, repl = line.rstrip('\n').split('\t')
    rows.append(dict(path=path, bytes=int(size), blob=blob, action=action, replacement=repl))

rnd = random.Random(20261007)
pick = []
def one(pred, label):
    cands = [r for r in rows if pred(r)]
    r = rnd.choice(cands); r['label'] = label; pick.append(r)
one(lambda r: r['path'].endswith('/report.json') and r['action'] == 'report' and r['bytes'] > 5_000_000, 'report.json (large, with bodies)')
one(lambda r: r['path'].endswith('/report.json') and r['action'] == 'report' and 'revision-' not in r['path'], 'report.json')
one(lambda r: r['path'].endswith('/trace.zip'), 'trace.zip')
one(lambda r: r['path'].endswith('--trace.zip'), 'trace attachment')
one(lambda r: r['action'] == 'duplicate', 'screenshot (duplicate copy)')
one(lambda r: r['action'] == 'superseded' and r['path'].endswith('.png'), 'screenshot (superseded revision)')
one(lambda r: r['action'] == 'case' and r['path'].endswith('--keyboard-window.json'), 'per-sample JSON (p2-keyboard-window)')
one(lambda r: r['action'] == 'case' and r['path'].endswith('--motion.json'), 'per-test JSON')
one(lambda r: r['action'] == 'case' and r['path'].endswith('attachments.tar.gz'), 'archive of per-test JSON')
one(lambda r: r['action'] == 'superseded' and r['path'].endswith('.json'), 'per-test JSON (superseded revision)')

kept_text = {}
def tree_records(path):
    """SHA-256 values the current tree records next to this file's name (same task directory)."""
    top = path.split('/')[0]; name = os.path.basename(path)
    found = set()
    for root, _, files in os.walk(P + top):
        for f in files:
            if not f.endswith('.json'):
                continue
            fp = os.path.join(root, f)
            t = kept_text.get(fp)
            if t is None:
                t = kept_text[fp] = open(fp, encoding='utf-8', errors='replace').read()
            if name not in t:
                continue
            for m in re.finditer(re.escape(name) + r'[^{}]{0,400}?"sha256"\s*:\s*"([0-9a-f]{64})"', t):
                found.add(m.group(1))
            for m in re.finditer(r'"sha256"\s*:\s*"([0-9a-f]{64})"[^{}]{0,400}?' + re.escape(name), t):
                found.add(m.group(1))
    return found

out = []
for r in pick:
    data = subprocess.run(['git', 'show', f"{BASE}:{P}{r['path']}"], capture_output=True, check=True).stdout
    blob = subprocess.run(['git', 'hash-object', '--stdin'], input=data, capture_output=True, check=True).stdout.decode().strip()
    sha = hashlib.sha256(data).hexdigest()
    rec = {'label': r['label'], 'path': r['path'], 'action': r['action'], 'bytes': len(data), 'sha256': sha,
           'blob': blob, 'blobMatchesManifest': blob == r['blob'], 'bytesMatchManifest': len(data) == r['bytes']}
    if r['action'] == 'case':
        s = json.load(open(P + r['replacement'], encoding='utf-8'))
        pool = s.get('files', []) + s.get('archives', [])
        hit = [e for e in pool if e['name'] == os.path.basename(r['path'])]
        rec['summarySha256'] = hit[0]['sha256'] if hit else None
        rec['matchesSummary'] = bool(hit) and hit[0]['sha256'] == sha
    if r['action'] == 'duplicate':
        kept = open(P + r['replacement'], 'rb').read()
        rec['keptCopy'] = r['replacement']
        rec['matchesKeptCopy'] = hashlib.sha256(kept).hexdigest() == sha
    recorded = tree_records(r['path'])
    rec['recordedInTree'] = sorted(recorded)
    rec['matchesTreeRecords'] = (sha in recorded) if recorded else None
    if r['action'] == 'report':
        rep = json.load(open(P + r['replacement'], encoding='utf-8'))
        orig = json.loads(data)
        def strip(o):
            if isinstance(o, dict):
                if isinstance(o.get('attachments'), list):
                    for a in o['attachments']:
                        if isinstance(a, dict): a.pop('body', None)
                for v in o.values(): strip(v)
            elif isinstance(o, list):
                for v in o: strip(v)
        strip(orig)
        rec['summary'] = r['replacement']
        rec['summaryEqualsOriginalWithoutBodies'] = rep == orig
    ok = rec['blobMatchesManifest'] and rec['bytesMatchManifest'] and rec.get('matchesSummary', True) \
        and rec.get('matchesKeptCopy', True) and rec['matchesTreeRecords'] is not False \
        and rec.get('summaryEqualsOriginalWithoutBodies', True)
    rec['ok'] = ok
    out.append(rec)
    print(('OK  ' if ok else 'FAIL'), r['label'], r['path'], sha[:16], 'tree-records:', len(recorded))
json.dump({'base': BASE, 'command': 'git show <base>:docs/evidence/base-ui-migration/<path>', 'samples': out}, open(sys.argv[2], 'w'), indent=1)
sys.exit(0 if all(r['ok'] for r in out) else 1)
