#!/usr/bin/env python3
"""Usage: summarize-states.py <run-label>... -> one line per run/project/screenshot: notification host, section width
(inline/uninlined), fixed probes, card will-change and x, and in Chromium the compositor layers that paint the
notification (layers owned by the notification's nodes, or the top-layer host/backdrop) with their reasons."""
import json, sys
TOAST = ('toast', 'toast-layer', 'toast-slot', 'toast-viewport', '::backdrop')
for label in sys.argv[1:]:
    states = json.load(open(f'/var/tmp/p23b1/runs/{label}/states.json'))
    for key in sorted(states):
        st = states[key]; d = st['dom']; s = d['section'] or {}; h = d['host'] or {}
        cards = d['cards']
        line = (f"{label:16} {key:45} host={h.get('tag')}{'.'+h['className'] if h.get('className') else ''}"
                f"{'(top layer)' if h.get('popoverOpen') else ''} w={s.get('rect',{}).get('width')} inline={'Y' if s.get('inlineStyle') else 'N'}"
                f" uninlined={((s.get('uninlined') or {}).get('rect') or {}).get('width')} probes(body inset0={d['probes']['bodyInset0']['width']},"
                f" body16={d['probes']['bodyLeftRight16']['width']}, persistent={[p['width'] for p in d['probes']['persistent']]})"
                f" vp(inner={d['viewport']['innerWidth']}, client={d['viewport']['clientWidth']}, scrollW={d['viewport']['scrollWidth']}, scrollH={d['viewport']['scrollHeight']}/{d['viewport']['clientHeight']})"
                f" cards={[ (c['className'].replace('toast ','').replace('toast--',''), round(c['rect']['x'],3), round(c['rect']['width'],3), c['style']['willChange']) for c in cards]}")
        print(line)
        L = st.get('layers')
        if L and L.get('latest'):
            for l in L['latest']['layers']:
                n = l['node'] or {}
                name = (n.get('name') or '') + ('.' + n['className'] if n.get('className') else '')
                if any(t in name for t in TOAST):
                    print(f"{'':18}layer {name[:60]:60} {l['width']}x{l['height']} draws={l['drawsContent']} reasons={l['reasons']}")
