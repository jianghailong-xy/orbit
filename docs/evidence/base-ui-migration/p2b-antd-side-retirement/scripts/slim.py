#!/usr/bin/env python3
"""slim.py REPORT.json OUT.json: per-test name/status/recorded result of a probe run (no attachment bodies,
no key logs, no error contexts) — the shape the before/after comparison and the evidence keep."""
import base64, json, sys

def main(report_path, out_path):
    report = json.load(open(report_path))
    rows = []
    for suite in report.get('suites', []):
        for spec in suite.get('specs', []):
            for test in spec.get('tests', []):
                result = (test.get('results') or [{}])[-1]
                record = None
                for attachment in result.get('attachments', []):
                    if attachment.get('body'):
                        try: record = json.loads(base64.b64decode(attachment['body']))
                        except Exception: record = None
                error = result.get('error') or {}
                rows.append({'name': spec['title'], 'status': test.get('status'),
                    'target': (record or {}).get('target') or spec['title'].split(' ')[0],
                    'mode': (record or {}).get('mode'),
                    'sequence': (record or {}).get('sequence') or (spec['title'].split(' ')[1] if len(spec['title'].split(' ')) > 2 else None),
                    'result': (record or {}).get('result'),
                    'error': (error.get('message') or '').split('Error:', 1)[-1].strip().splitlines()[0] if error.get('message') else None})
    json.dump({'tests': rows}, open(out_path, 'w'), ensure_ascii=False, indent=1)
    print(f"{out_path}: {len(rows)} tests")

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
