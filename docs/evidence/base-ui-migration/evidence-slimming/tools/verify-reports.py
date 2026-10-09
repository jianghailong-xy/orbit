# Every Playwright report the plan replaced: the summary in the working tree must equal the original at the
# pre-slimming commit with attachments[].body removed, and nothing else; also count tests and results.
import gzip, json, subprocess, sys

BASE = '7732f14f82d4e6b4406d7d164c4b672f63aa0f56'
P = 'docs/evidence/base-ui-migration/'
plan = [p for p in json.load(open(sys.argv[1])) if p['action'] == 'report']


def strip(o):
    n = 0
    if isinstance(o, dict):
        if isinstance(o.get('attachments'), list):
            for a in o['attachments']:
                if isinstance(a, dict) and 'body' in a:
                    del a['body']; n += 1
        for v in o.values():
            n += strip(v)
    elif isinstance(o, list):
        for v in o:
            n += strip(v)
    return n


def tests(o, acc):
    if isinstance(o, dict):
        if 'projectName' in o and 'results' in o:
            acc.append((o['projectName'], o.get('status'), len(o['results'])))
        for v in o.values():
            tests(v, acc)
    elif isinstance(o, list):
        for v in o:
            tests(v, acc)
    return acc


bad = 0; bodies = 0; ntests = 0
for p in plan:
    raw = subprocess.run(['git', 'cat-file', 'blob', f"{BASE}:{p['path']}"], capture_output=True, check=True).stdout
    if p['path'].endswith('.gz'):
        raw = gzip.decompress(raw)
    orig = json.loads(raw)
    bodies += strip(orig)
    summ = json.load(open(P + p['replacement'], encoding='utf-8'))
    if orig != summ:
        bad += 1; print('MISMATCH', p['rel'])
    t = tests(summ, [])
    ntests += len(t)
print(f'reports {len(plan)} mismatches {bad} bodies removed {bodies} tests kept {ntests}')
if len(sys.argv) > 2:
    json.dump({'reports': len(plan), 'mismatches': bad, 'bodies': bodies, 'tests': ntests}, open(sys.argv[2], 'w'))
sys.exit(1 if bad else 0)
