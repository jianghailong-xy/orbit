#!/usr/bin/env python3
"""One Markdown table per web observer (t07web.mjs's web.jsonl): every change the page showed, with its picture,
the managed notice's kind and title, the composer's state, the answers on the page, and every write the page sent.

  python3 -I websummary.py WEB_DIR...
"""
import json
import sys
from pathlib import Path

for d in map(Path, sys.argv[1:]):
    print(f'\n### {d.name}\n')
    print('| UTC | Picture | Notice | Composer | Answers on the page |')
    print('| --- | --- | --- | --- | --- |')
    for line in (d / 'web.jsonl').read_text().splitlines():
        r = json.loads(line)
        if r['kind'] == 'seen':
            n = r.get('notice') or {}
            c = r.get('composer') or {}
            notice = f"{n.get('kind')}: {n.get('title')}" + (f" ({', '.join(n['actions'])})" if n.get('actions') else '') if n else '—'
            composer = (f"\"{c.get('placeholder')}\"" + (', engine offered' if c.get('hero') else '')
                        + (f", {c.get('modelChip')}" if c.get('modelChip') else '')) if c else '—'
            answers = ', '.join(a.replace('Answering: ', '') for a in r.get('answers') or []) or '—'
            print(f"| {r['at'][11:23]} | {r['shot']} | {notice} | {composer} | {answers} |")
        elif r['kind'] == 'api-write':
            print(f"| {r['at'][11:23]} | — | **{r['method']} {r['path']}** | — | — |")
        elif r['kind'] == 'act' and r['order']['kind'] in ('send', 'retry', 'goto'):
            print(f"| {r['at'][11:23]} | — | the test: {r['order']['kind']} {r['order'].get('arg', '')[:60]} | — | — |")
