#!/usr/bin/env python3
"""Compare two Playwright runs of the same spec: a same-commit reference tree and a delivery tree.

usage: compare_runs.py REF_SHOTS DEL_SHOTS REF_REPORT DEL_REPORT OUT_JSON

For every screenshot both runs wrote (REF_SHOTS/<project>/<name>.png): equal bytes, or the number of
differing pixels, the largest per-channel difference and the bounding boxes of the differing clusters.
For every capture both runs recorded (evidence.json `selected`): the computed-style fields that differ.
For every `trace` attachment: whether the two traces are equal, and the first differing steps.
The script only reads; it never edits an image.
"""
import base64, hashlib, json, os, sys
from PIL import Image

ref_shots, del_shots, ref_report, del_report, out_path = sys.argv[1:6]


def clusters(points):
    boxes = []
    for x, y, d in points:
        for b in boxes:
            if b[0] - 6 <= x <= b[2] + 6 and b[1] - 6 <= y <= b[3] + 6:
                b[0] = min(b[0], x); b[1] = min(b[1], y); b[2] = max(b[2], x); b[3] = max(b[3], y); b[4] += 1; b[5] = max(b[5], d)
                break
        else:
            boxes.append([x, y, x, y, 1, d])
    return [{'x': [b[0], b[2]], 'y': [b[1], b[3]], 'pixels': b[4], 'maxChannelDiff': b[5]} for b in boxes]


def compare_png(a, b):
    ha = hashlib.sha256(open(a, 'rb').read()).hexdigest()
    hb = hashlib.sha256(open(b, 'rb').read()).hexdigest()
    if ha == hb:
        return {'equal': True, 'sha256': ha}
    ia, ib = Image.open(a).convert('RGBA'), Image.open(b).convert('RGBA')
    if ia.size != ib.size:
        return {'equal': False, 'sizeRef': ia.size, 'sizeDel': ib.size}
    pa, pb = ia.load(), ib.load()
    w, h = ia.size
    points, histogram = [], {}
    for y in range(h):
        for x in range(w):
            if pa[x, y] != pb[x, y]:
                d = max(abs(pa[x, y][i] - pb[x, y][i]) for i in range(4))
                points.append((x, y, d))
                histogram[d] = histogram.get(d, 0) + 1
    return {'equal': False, 'pixels': len(points), 'maxChannelDiff': max(p[2] for p in points),
            'pixelsAtMost2': sum(v for k, v in histogram.items() if k <= 2), 'clusters': clusters(points)[:40],
            'sha256Ref': ha, 'sha256Del': hb}


def attachments(report_path):
    report = json.load(open(report_path))
    found = {}

    def walk(suite, prefix):
        for s in suite.get('suites', []):
            walk(s, prefix + [s['title']])
        for spec in suite.get('specs', []):
            for t in spec['tests']:
                for r in t['results']:
                    key = (t['projectName'], ' › '.join(prefix[1:] + [spec['title']]))
                    entry = found.setdefault(key, {'status': r['status'], 'traces': None, 'evidence': None})
                    for a in r.get('attachments', []):
                        # A failed test also attaches Playwright's own trace.zip under the name "trace".
                        if a['name'] not in ('trace', 'computed-styles-and-timings') or a.get('contentType') != 'application/json':
                            continue
                        body = base64.b64decode(a['body']).decode() if 'body' in a else (open(a['path']).read() if a.get('path') and os.path.exists(a['path']) else None)
                        if body is None:
                            continue
                        if a['name'] == 'trace':
                            entry['traces'] = json.loads(body)
                        elif a['name'] == 'computed-styles-and-timings':
                            entry['evidence'] = json.loads(body)
    for s in report['suites']:
        walk(s, [s['title']])
    return found


result = {'screenshots': {}, 'styles': {}, 'traces': {}, 'tests': {}}
for project in sorted(os.listdir(ref_shots)):
    for name in sorted(os.listdir(os.path.join(ref_shots, project))):
        a, b = os.path.join(ref_shots, project, name), os.path.join(del_shots, project, name)
        result['screenshots'][f'{project}/{name}'] = compare_png(a, b) if os.path.exists(b) else {'missingInDelivery': True}
    if os.path.isdir(os.path.join(del_shots, project)):
        for name in sorted(os.listdir(os.path.join(del_shots, project))):
            if not os.path.exists(os.path.join(ref_shots, project, name)):
                result['screenshots'][f'{project}/{name}'] = {'missingInReference': True}

ref_att, del_att = attachments(ref_report), attachments(del_report)
for key in sorted(set(ref_att) | set(del_att)):
    label = f'{key[0]} :: {key[1]}'
    r, d = ref_att.get(key), del_att.get(key)
    result['tests'][label] = {'ref': r and r['status'], 'del': d and d['status']}
    if r and d and r['traces'] is not None:
        equal = r['traces'] == d['traces']
        entry = {'equal': equal}
        if not equal:
            entry['differences'] = [{'step': rs.get('step'), 'ref': rs, 'del': ds} for rs, ds in zip(r['traces'], d['traces'] or []) if rs != ds][:20]
            if len(r['traces']) != len(d['traces'] or []):
                entry['lengths'] = [len(r['traces']), len(d['traces'] or [])]
        result['traces'][label] = entry
    if r and d and r['evidence'] and d['evidence']:
        rc = {c['name']: c for c in r['evidence'].get('captures', [])}
        dc = {c['name']: c for c in d['evidence'].get('captures', [])}
        for name in rc:
            if name not in dc:
                continue
            diffs = {}
            for sel, rv in (rc[name].get('selected') or {}).items():
                dv = (dc[name].get('selected') or {}).get(sel)
                if dv is None:
                    continue
                delta = {k: [rv.get(k), dv.get(k)] for k in rv if rv.get(k) != dv.get(k)}
                if delta:
                    diffs[sel] = delta
            result['styles'][f'{key[0]}/{name}'] = diffs

json.dump(result, open(out_path, 'w'), indent=1, sort_keys=True)
shots = result['screenshots'].values()
print('screenshots', len(result['screenshots']), 'equal', sum(1 for s in shots if s.get('equal')),
      'differ', sum(1 for s in shots if s.get('equal') is False), 'missing', sum(1 for s in shots if 'equal' not in s))
print('traces', len(result['traces']), 'equal', sum(1 for t in result['traces'].values() if t['equal']))
print('captures with style deltas', sum(1 for v in result['styles'].values() if v), 'of', len(result['styles']))
