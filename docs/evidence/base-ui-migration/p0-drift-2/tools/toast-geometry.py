#!/usr/bin/env python3
"""Usage: toast-geometry.py <run label> -> JSON {project/<shot>.png: geometry} from the
b1-state.diag.mjs attachments in that run's report.json (notification column, cards, host, inline style)."""
import base64, json, sys
report = json.load(open(f'/var/tmp/p0d2/runs/{sys.argv[1]}/output/report.json'))
out = {}
def walk(suite):
    for spec in suite.get('specs', []):
        for test in spec['tests']:
            for result in test['results']:
                for a in result.get('attachments', []):
                    if not a['name'].endswith('-b1-state') or 'body' not in a: continue
                    d = json.loads(base64.b64decode(a['body']))
                    dom = d['dom']
                    out[f"{test['projectName']}/{d['screenshot']}.png"] = {
                        'section': dom['section']['rect'] if dom.get('section') else None,
                        'inlineStyle': dom['section'].get('inlineStyle') if dom.get('section') else None,
                        'host': (dom['host']['tag'] + '.' + (dom['host']['className'] or '')) if dom.get('host') else None,
                        'cards': [{'className': c['className'], 'rect': c['rect'], 'willChange': c['style']['willChange']} for c in dom.get('cards', [])],
                    }
    for child in suite.get('suites', []): walk(child)
for s in report['suites']: walk(s)
print(json.dumps(dict(sorted(out.items())), indent=1))
