#!/usr/bin/env python3
"""settle-compare.py BEFORE_REF BEFORE_DEL AFTER_REF AFTER_DEL > OUT.json: the P4.3b samples before and after
settled() also waited out rc-motion's classes (4af55b711, first written as 9e93fec23).

BEFORE_* are the two trees' Playwright reports of a round without it (on d1a3f6f7b), AFTER_* of the final round.
For every step whose open layers (the words of every open dialog, popup and tooltip, as trace-semantics.py reads
them) differed between the trees BEFORE, it lists the same test, environment and step AFTER: each tree's
dialogs and popups and focus at that step, and whether the two trees now agree. Only reads."""
import base64
import json
import sys


def traces(path):
    found = {}

    def walk(suite, prefix):
        for child in suite.get('suites', []):
            walk(child, prefix + [child['title']])
        for spec in suite.get('specs', []):
            for test in spec['tests']:
                for result in test['results']:
                    for attachment in result.get('attachments', []):
                        if attachment['name'] == 'trace' and 'body' in attachment:
                            found[f"{test['projectName']} :: {' › '.join(prefix[1:] + [spec['title']])}"] = json.loads(base64.b64decode(attachment['body']))
    for suite in json.load(open(path))['suites']:
        walk(suite, [suite['title']])
    return found


def layers(step):
    return sorted(text for text in (step.get('dialogs') or []) + (step.get('popups') or []) if text)


def sample(step):
    return {'dialogs': step.get('dialogs'), 'popups': step.get('popups'), 'focus': step.get('focus')}


br, bd, ar, ad = (traces(path) for path in sys.argv[1:5])
rows = []
for key in sorted(set(br) & set(bd)):
    for i, (rs, ds) in enumerate(zip(br[key], bd[key])):
        if layers(rs) == layers(ds):
            continue
        step = rs.get('step')
        after = None
        if key in ar and key in ad:
            match_r = [s for s in ar[key] if s.get('step') == step]
            match_d = [s for s in ad[key] if s.get('step') == step]
            if match_r and match_d:
                after = {'reference': sample(match_r[0]), 'delivery': sample(match_d[0]),
                         'layersAgree': layers(match_r[0]) == layers(match_d[0])}
        rows.append({'test': key, 'step': step,
                     'before': {'reference': sample(rs), 'delivery': sample(ds)},
                     'after': after})
summary = {'stepsWithLayerDifferenceBefore': len(rows),
           'agreeAfter': sum(1 for r in rows if r['after'] and r['after']['layersAgree']),
           'stillDifferAfter': sorted({f"{r['test'].split(' :: ')[1]} | {r['step']}" for r in rows if r['after'] and not r['after']['layersAgree']}),
           'missingAfter': sum(1 for r in rows if not r['after'])}
json.dump({'summary': summary, 'rows': rows}, sys.stdout, indent=1, ensure_ascii=False)
print()
