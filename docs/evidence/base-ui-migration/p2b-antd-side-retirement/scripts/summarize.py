#!/usr/bin/env python3
"""summarize.py REPORT.json [REPORT2.json...]: the per-test status and recorded result of the kw2 probe runs.

The probe attaches one JSON record per sample; the result string is what the case recorded (what ran, which
popups are shown, where focus is). Printing these lets two runs be compared test by test.
  python3 summarize.py --failed A.json            # the failing test names, one per line
  python3 summarize.py --compare A.json B.json    # tests whose status or result differs between A and B
  python3 summarize.py --targets A.json           # per-target counts by status
"""
import base64
import json
import sys
from collections import Counter, defaultdict


def load(path):
    report = json.load(open(path))
    tests = {}
    for suite in report.get('suites', []):
        for spec in suite.get('specs', []):
            for test in spec.get('tests', []):
                result = (test.get('results') or [{}])[-1]
                record = None
                for attachment in result.get('attachments', []):
                    if attachment.get('body'):
                        try:
                            record = json.loads(base64.b64decode(attachment['body']))
                        except Exception:
                            record = None
                tests[spec['title']] = {
                    'status': test.get('status'),
                    'target': (record or {}).get('target') or spec['title'].split(' ')[0],
                    'mode': (record or {}).get('mode'),
                    'result': (record or {}).get('result'),
                    'error': (result.get('error') or {}).get('message', '').splitlines()[0] if result.get('error') else None,
                }
    return tests


def main(argv):
    if argv[0] == '--failed':
        tests = load(argv[1])
        for name in sorted(tests):
            if tests[name]['status'] != 'expected':
                print(name)
        return 0
    if argv[0] == '--targets':
        tests = load(argv[1])
        counts = defaultdict(Counter)
        for name, test in tests.items():
            counts[test['target']][test['status']] += 1
        for target in sorted(counts):
            print(target, dict(counts[target]))
        return 0
    if argv[0] == '--compare':
        a, b = load(argv[1]), load(argv[2])
        only_a = sorted(set(a) - set(b))
        only_b = sorted(set(b) - set(a))
        diff = []
        for name in sorted(set(a) & set(b)):
            if a[name]['status'] != b[name]['status']:
                diff.append((name, f"status {a[name]['status']} -> {b[name]['status']}"))
            elif a[name]['result'] != b[name]['result']:
                diff.append((name, f"result\n    A: {a[name]['result']}\n    B: {b[name]['result']}"))
        print(f"tests: A={len(a)} B={len(b)}; only in A: {len(only_a)}, only in B: {len(only_b)}, differing: {len(diff)}")
        for name in only_a:
            print(f"ONLY-A {name}")
        for name in only_b:
            print(f"ONLY-B {name}")
        for name, what in diff:
            print(f"DIFF {name}: {what}")
        return 0
    print(__doc__)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
