#!/usr/bin/env python3
"""Summarise this task's runs from their logs, for runs.txt beside this file.

    python3 runs.py <scratch dir>   (here: /mnt/data/tmp/34dXwqJALj5g5fLAoF50e)

Reads: api-unit-{base,delivery}.log (apiserver `npm test`), pg-{base,delivery,base-new-spec}.log
(scripts/run-pg-spec.sh) with the heads chainA.log / chainB.log printed before each run,
web/{base,delivery}-web-*-of-4.json (src/web vitest, 4 shards a tree) with web.log / chainB.log,
ok-{base,delivery}.{log,commit} (OrbitKit `swift test` in swift:6.1) and go-delivery.log (runner-go).
"""
import glob
import json
import re
import sys

S = sys.argv[1]
HEX = r'([0-9a-f]{40})'


def text(name):
    with open(f'{S}/{name}', encoding='utf-8', errors='replace') as f:
        return f.read()


def first(pattern, body, default='?'):
    m = re.search(pattern, body, re.M)
    return m.group(1) if m else default


def last(pattern, body, default='?'):
    found = re.findall(pattern, body, re.M)
    return found[-1] if found else default


# In the order they ran: a later run of the same step replaced the earlier one's log or report.
chains = text('chainA.log') + text('chainB.log')

print('== apiserver unit (cd src/apiserver && rm -rf build && npm test)')
for tree in ('base', 'delivery'):
    body = text(f'api-unit-{tree}.log')
    head = first(r'^head=' + HEX, body)
    tests, passed, failed = (first(r'^ℹ ' + k + r' (\d+)', body) for k in ('tests', 'pass', 'fail'))
    print(f'{tree:9s} head={head} tests={tests} pass={passed} fail={failed} {first(r"^(exit=\d+)", body)}')

print('\n== pg specs (scripts/run-pg-spec.sh), base vs delivery, spec by spec')
SPEC = re.compile(r'^==== (\S+) tests=(\d+) pass=(\d+) fail=(\d+) skipped=(\d+)', re.M)


def specs(name):
    return {m.group(1): tuple(int(x) for x in m.groups()[1:]) for m in SPEC.finditer(text(name))}


def show(r):
    return 'not run' if r is None else f'{r[1]}/{r[0]} pass, {r[2]} fail, {r[3]} skip'


for label in ('base', 'delivery', 'base-new-spec'):
    head = last(r'^pg-' + label + r': head=' + HEX, chains)
    print(f'pg-{label}: head={head} {first(r"^==> (PostgreSQL .*)$", text(f"pg-{label}.log"))}')
base, delivery = specs('pg-base.log'), specs('pg-delivery.log')
red = {'base': 0, 'delivery': 0}
for spec in sorted(set(base) | set(delivery)):
    b, d = base.get(spec), delivery.get(spec)
    red['base'] += bool(b and (b[2] or b[3]))
    red['delivery'] += bool(d and (d[2] or d[3]))
    mark = '' if (b and d and b[2:] == d[2:] == (0, 0)) else '   <--'
    print(f'  {spec:52s} base {show(b):26s} delivery {show(d)}{mark}')
print(f"specs with a red: base {red['base']}, delivery {red['delivery']}")
for spec, r in specs('pg-base-new-spec.log').items():
    print(f'base tree, the delivery\'s copy of {spec}: {show(r)}')

print('\n== src/web vitest (npx vitest run --maxWorkers=2, 4 shards a tree)')
webs = text('web.log') + text('chainB.log')
for tree in ('base', 'delivery'):
    totals = dict(files=0, tests=0, passed=0, failed=0, skipped=0)
    failing = []
    for path in sorted(glob.glob(f'{S}/web/{tree}-web-*-of-4.json')):
        with open(path, encoding='utf-8') as f:
            report = json.load(f)
        totals['files'] += len(report['testResults'])
        totals['tests'] += report['numTotalTests']
        totals['passed'] += report['numPassedTests']
        totals['failed'] += report['numFailedTests']
        totals['skipped'] += report['numPendingTests'] + report.get('numTodoTests', 0)
        failing += [r['name'] for r in report['testResults'] if r['status'] == 'failed']
    heads = sorted({last(r'^== ' + tree + f' shard {i}/4: ' + r'\S+ head=' + HEX, webs) for i in range(1, 5)})
    counts = ', '.join(f'{k} {v}' for k, v in totals.items())
    print(f"{tree:9s} head={','.join(heads)} {counts}; failing files: {', '.join(failing) or 'none'}")

print('\n== OrbitKit swift test (swift:6.1, ok-run.sh)')
for tree in ('base', 'delivery'):
    runs = re.findall(r'Executed (\d+) tests, with (\d+) tests? skipped and (\d+) failures?', text(f'ok-{tree}.log'))
    tests, skipped, failures = runs[-1]
    commit = text(f'ok-{tree}.commit').strip()
    print(f'{tree:9s} commit={commit} tests={tests} skipped={skipped} failures={failures}')

print("\n== runner-go (go vet ./... && go test -count=1 ./... -skip the merge check's two)")
body = text('go-delivery.log')
results = ' '.join(re.findall(r'^((?:ok|FAIL)\s+orbit\s+\S+)', body, re.M)) or '?'
# chainB.sh refuses to start unless the worktree is at the delivery commit, and runs this last.
head = last(r'^pg-delivery: head=' + HEX, text('chainB.log'))
print(f"delivery head={head} {results} {first(r'^(go-delivery exit=\d+)', body)};"
      f" '--- FAIL:' lines: {len(re.findall(r'--- FAIL:', body))}")
