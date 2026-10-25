#!/usr/bin/env python3
"""The values root.css's link reset and .orbit-app read, against the tokens the replaced App root's link reset and text
resolved to, in both themes. The replaced side is read off the reference's runtime records (runtime-probe.mjs: the
`.css-var-*` rule the library injected on the root), the Orbit side off the delivery's stylesheets (foundation.css's
and index.css's :root and :root[data-theme='dark'] blocks).

usage: link-tokens.py RUNTIME_DIR FOUNDATION_CSS INDEX_CSS > link-tokens.json
"""
import json
import re
import sys

runtime, foundation, index = sys.argv[1:4]
PAIRS = [  # (the library's token, the Orbit variable root.css or .orbit-app reads, where)
    ('--ant-color-link', '--orbit-control-primary', 'a'), ('--ant-color-link-hover', '--orbit-control-link-hover', 'a:hover'),
    ('--ant-color-link-active', '--orbit-control-primary-active', 'a:active'),
    ('--ant-color-primary-border', '--orbit-focus-color', 'a:focus-visible outline colour'),
    ('--ant-line-width-focus', '--orbit-focus-width', 'a:focus-visible outline width'),
    ('--ant-color-text-disabled', '--orbit-control-disabled-text', 'a[disabled]'), ('--ant-color-text', '--text-1', '.orbit-app colour'),
]
LITERALS = [('--ant-link-decoration', 'none'), ('--ant-link-hover-decoration', 'none'), ('--ant-link-focus-decoration', 'none'),
            ('--ant-motion-duration-slow', '0.3s'), ('--ant-font-size', '14px'), ('--ant-line-height', '1.5714285714285714')]


def blocks(path):
    text = open(path).read()
    out = {}
    for theme, selector in (('light', r':root\s*\{'), ('dark', r":root\[data-theme='dark'\]\s*\{")):
        start = re.search(selector, text).end()
        body = text[start:text.index('}', start)]
        out[theme] = dict(re.findall(r'(--[\w-]+)\s*:\s*([^;]+);', body))
    return out


def norm(value):
    return re.sub(r'\s+', '', value.strip().lower())


orbit = {theme: {**blocks(index)[theme], **blocks(foundation)[theme]} for theme in ('light', 'dark')}
report = {}
for theme in ('light', 'dark'):
    record = json.load(open(f'{runtime}/ref-chromium-{theme}-desktop.json'))
    ant = {}
    for sheet in record['routes']['projects']['sheets']:
        for rule in sheet['rules']:
            if rule.startswith('.css-var-'):
                ant.update(re.findall(r'(--ant-[\w-]+)\s*:\s*([^;]+);', rule))
    light = orbit['light']
    rows = []
    for token, variable, where in PAIRS:
        value = orbit[theme].get(variable, light.get(variable))  # the dark block inherits what it does not set
        rows.append({'where': where, 'replaced': f'{token}: {ant[token]}', 'orbit': f'{variable}: {value}', 'equal': norm(ant[token]) == norm(value)})
    for token, literal in LITERALS:
        rows.append({'where': 'root.css / AppRoot literal', 'replaced': f'{token}: {ant[token]}', 'orbit': literal, 'equal': norm(ant[token]) == norm(literal)})
    report[theme] = rows
report['allEqual'] = all(row['equal'] for theme in ('light', 'dark') for row in report[theme])
print(json.dumps(report, indent=1, ensure_ascii=False))
sys.exit(0 if report['allEqual'] else 1)
