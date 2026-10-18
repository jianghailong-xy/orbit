#!/usr/bin/env python3
"""results-lines.py [ROOT]: the numbers the README's results table and conclusion quote, read from a round's runs/ and
compare/ (ROOT defaults to the current round, /mnt/data/tmp/34blYpxEcHMAf4oafuC2W): each run's Playwright or vitest counts
and exit code, each comparison's screenshot classes and trace totals, and the P4.3b traces' step and semantic counts."""
import json, os, re, sys
root = sys.argv[1] if len(sys.argv) > 1 else '/mnt/data/tmp/34blYpxEcHMAf4oafuC2W'
runs = ['f-p43b-ref', 'f-p43b-del', 'f-cards-ref', 'f-cards-del', 'f-p0-ref', 'f-p0-strict', 'f-p0-del', 'f-p0-standard',
        'f-p0-standard-start', 'pilot-ref', 'pilot-del', 'c-merge', 'u-related', 'c-overlays', 'c-controls', 'c-choices',
        'f-p41-start', 'f-p41-del', 'f-p42-start', 'f-p42-del']
strip = lambda s: re.sub(r'\x1b\[[0-9;]*m', '', s)
for name in runs:
    path = os.path.join(root, 'runs', f'{name}.txt')
    if not os.path.exists(path):
        print(f'{name}: no log'); continue
    text = strip(open(path, encoding='utf-8', errors='replace').read())
    counts = {k: int(n) for n, k in re.findall(r'^\s+(\d+) (passed|failed|flaky|skipped|did not run)', text, flags=re.M)}
    files = re.findall(r'Test Files\s+(.+?)\n', text)
    tests = re.findall(r'^\s+Tests\s+(.+?)\n', text, flags=re.M)
    code = re.findall(r'^exit=(\d+)', text, flags=re.M)
    dur = re.findall(r'^\s+\d+ passed \(([^)]+)\)', text, flags=re.M)
    started = re.findall(r'^started: (\S+)', text, flags=re.M)
    ended = re.findall(r'^ended: (\S+)', text, flags=re.M)
    mem = re.findall(r'^mem: (\d+)M available', text, flags=re.M)
    print(f'{name}: {counts or ""} files={files} tests={tests} exit={code} dur={dur} {started[:1]}..{ended[:1]} mem={mem}')
print()
for name in ('f-p43b', 'f-cards', 'f-p0', 'pilot', 'f-p41', 'f-p42'):
    path = os.path.join(root, 'compare', f'{name}-summary.json')
    if not os.path.exists(path):
        print(f'{name}: no summary'); continue
    s = json.load(open(path))
    t = s.get('traces', {})
    print(f"{name}: shots {s['screenshots']} tests {{{', '.join(f'{k}: {v}' for k, v in s['tests'].items() if not isinstance(v, list))}}}"
          f" traces {{{', '.join(f'{k}: {(len(v) if isinstance(v, (list, dict)) else v)}' for k, v in t.items())}}}")
for name in ('f-p43b', 'f-cards'):
    path = os.path.join(root, 'compare', f'{name}-trace-semantics.json')
    if not os.path.exists(path):
        continue
    d = json.load(open(path))
    print(f"{name} trace-semantics: tests {d['tests']} steps {d['steps']} semantic {len(d['semantic'])} "
          f"presentation {len(d['presentation']) if isinstance(d['presentation'], (list, dict)) else d['presentation']}")
