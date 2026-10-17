#!/usr/bin/env python3
"""Compare runtime-probe.mjs records of the reference (ref-*.json) and the delivery (del-*.json) in DIR.

usage: analyze-runtime.py DIR > runtime-compare.json

Per environment and route:
- rules: the style rules in effect only in one tree (by rule text, counted), grouped by the sheet that holds them;
- census: the component library's classes drawn in each tree;
- root: the element under #root in each, and whether its text styles are equal;
- elements: whether both trees drew the same elements (labels in document order) and, element by element, which
  boxes or computed styles differ.
"""
import json
import os
import re
import sys
from collections import Counter

d = sys.argv[1]
envs = sorted(f[4:-5] for f in os.listdir(d) if f.startswith('ref-') and f.endswith('.json'))
report = {'environments': {}, 'totals': Counter()}
rule_union = {'onlyRef': Counter(), 'onlyDel': Counter()}
for env in envs:
    ref = json.load(open(os.path.join(d, f'ref-{env}.json')))
    dl = json.load(open(os.path.join(d, f'del-{env}.json')))
    routes = {}
    for name, r in ref['routes'].items():
        x = dl['routes'][name]
        def rules(side):
            c = Counter()
            for sheet in side['sheets']:
                for rule in sheet['rules']:
                    c[(sheet['owner'], rule)] += 1
            return c
        cr, cd = rules(r), rules(x)
        def text(c):  # a rule held by two sheets counts twice
            out = Counter()
            for (owner, rule), n in c.items():
                out[rule] += n
            return out
        tr, td = text(cr), text(cd)
        only_ref = tr - td
        only_del = td - tr
        owners_ref = Counter(owner for (owner, rule), n in cr.items() if rule in only_ref for _ in range(n))
        owners_del = Counter(owner for (owner, rule), n in cd.items() if rule in only_del for _ in range(n))
        for rule, n in only_ref.items(): rule_union['onlyRef'][rule] += n
        for rule, n in only_del.items(): rule_union['onlyDel'][rule] += n
        # The replaced root also carries cssinjs's hash class (css-…), which the probe does not strip; and React's
        # generated ids (_r_N_, base-ui-_r_N_) run one apart, the replaced App having taken one more useId.
        norm = lambda label: '.'.join(part for part in re.sub(r'#[^.]*_r_\w+?_[^.]*', '', label).split('.')
                                      if part and not re.match(r'^css-[\w-]+$', part))
        labels_r = [norm(e[0]) for e in r['elements']]
        labels_d = [norm(e[0]) for e in x['elements']]
        same_dom = labels_r == labels_d
        diffs = []
        kinds = Counter()
        if same_dom:
            for i, (er, ed) in enumerate(zip(r['elements'], x['elements'])):
                box = er[1] != ed[1]
                props = {k: [er[2][k], ed[2][k]] for k in er[2] if er[2][k] != ed[2][k]}
                if box or props:
                    diffs.append({'index': i, 'label': labels_r[i], 'box': [er[1], ed[1]] if box else None, 'props': props})
                    for key, (a, b) in props.items():
                        kinds[f'{key}: {a} -> {b}' if key in ('lineHeight', 'textDecorationLine') else f'{key} on {labels_r[i][:60]}: {a} -> {b}'] += 1
                    if box: kinds['box'] += 1
        root_equal = (r['root'] or {}).get('style') == (x['root'] or {}).get('style')
        routes[name] = {
            'rulesOnlyRef': sum(only_ref.values()), 'rulesOnlyDel': sum(only_del.values()),
            'ownersOnlyRef': dict(owners_ref), 'ownersOnlyDel': dict(owners_del),
            'census': {'ref': r['census'], 'del': x['census']},
            'root': {'ref': (r['root'] or {}).get('className'), 'del': (x['root'] or {}).get('className'), 'textStylesEqual': root_equal,
                     'differs': {k: [r['root']['style'][k], x['root']['style'][k]] for k in r['root']['style'] if r['root']['style'][k] != x['root']['style'][k]} if not root_equal else {}},
            'htmlBodyEqual': r['html'] == x['html'] and r['body'] == x['body'],
            'elements': {'ref': len(labels_r), 'del': len(labels_d), 'sameDom': same_dom,
                         'firstDomDifference': next((i for i, (a, b) in enumerate(zip(labels_r, labels_d)) if a != b), None) if not same_dom else None,
                         'differing': len(diffs), 'kinds': dict(kinds.most_common()), 'sample': diffs[:12]},
            'errors': {'ref': r['errors'], 'del': x['errors']},
        }
        report['totals']['routes'] += 1
        report['totals']['elementsCompared'] += len(labels_r) if same_dom else 0
        report['totals']['elementsDiffering'] += len(diffs)
        report['totals']['routesWithDomDifference'] += 0 if same_dom else 1
        report['totals']['routesWithRootDifference'] += 0 if root_equal else 1
        report['totals']['routesWithCensusRef'] += 1 if r['census'] else 0
        report['totals']['routesWithCensusDel'] += 1 if x['census'] else 0
    report['environments'][env] = routes
report['totals'] = dict(report['totals'])
report['rulesOnlyRef'] = [{'rule': rule[:300], 'count': n} for rule, n in rule_union['onlyRef'].most_common()]
report['rulesOnlyDel'] = [{'rule': rule[:300], 'count': n} for rule, n in rule_union['onlyDel'].most_common()]
print(json.dumps(report, indent=1, ensure_ascii=False))
