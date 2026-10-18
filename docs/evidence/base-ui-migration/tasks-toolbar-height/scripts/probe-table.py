#!/usr/bin/env python3
"""probe-table.py RUN.txt...: one line per TOOLBAR-PROBE record -- settled toolbar/bar geometry, then the toolbar's
resize observations in order and what the page changed after the bulk bar first appeared (mutation records by region),
plus totals of runs whose toolbar stayed shorter than the bar."""
import json, re, sys, collections

def rows(path):
    for line in open(path, encoding='utf-8', errors='replace'):
        m = re.search(r'TOOLBAR-PROBE (\S+) (\d+) (\{.*\})\s*$', line)
        if m:
            yield m.group(1), int(m.group(2)), json.loads(m.group(3))

totals = collections.Counter()
for path in sys.argv[1:]:
    print(f'## {path}')
    fails = [l.strip() for l in open(path, encoding='utf-8', errors='replace') if re.match(r'\s+\d+\) ', l) or ' failed' in l and '✘' in l]
    for project, i, r in sorted(rows(path)):
        bar, tb = r['bar'], r['toolbar']
        ev = r['events']
        insert = next((e['t'] for e in ev if e['kind'] == 'mutation' and e.get('added') and any('tasks-bulkbar' in a for a in e['added'])), None)
        frames_before = sum(1 for e in ev if e['kind'] == 'frame' and insert is not None and e['t'] < insert)
        tb_sizes = [f"{e['t']}:{e['h']}" for e in ev if e['kind'] == 'resize' and e['target'].startswith('div.tasks-toolbar')]
        bar_sizes = [f"{e['t']}:{e['h']}" for e in ev if e['kind'] == 'resize' and 'tasks-bulkbar' in e['target']]
        after = collections.Counter()
        if insert is not None:
            for e in ev:
                if e['kind'] == 'mutation' and e['t'] > insert:
                    after[f"{e['region']}:{e['type']}{'/' + e['attr'] if e.get('attr') else ''}"] += 1
        stuck = tb['h'] < bar['offsetHeight']
        totals[(project, 'stuck' if stuck else 'ok')] += 1
        print(f"{project:22} {i}  toolbar {tb['h']:5} bar {bar['offsetHeight']}/{bar['clientHeight']} ovf {bar['scrollWidth'] > bar['clientWidth']!s:5} heads {r['heads']['top']:6} body {r['body']['top']:6}  {'STUCK' if stuck else 'ok   '}"
              f"  toolbarRO {' '.join(tb_sizes)}  barRO {' '.join(bar_sizes)}  insert@{insert} afterInsert {dict(after)}")
print()
for k, v in sorted(totals.items()):
    print(k, v)
