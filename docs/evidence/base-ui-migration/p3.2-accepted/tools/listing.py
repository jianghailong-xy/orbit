#!/usr/bin/env python3
"""Usage: listing.py <compare dir> <sources.json> <p3.2 r2c-p0-task-compare.json> <out.json> <out.md>

The per-screenshot table of this registration, from the compare.cjs outputs in <compare dir>:
  exp-vs-before.json    current expectation (the tip's assembly, sources.json) -> before original (fffcdb532)
  exp-vs-after.json     current expectation -> after original (2925958ae, the tip)
  before-vs-after.json  before -> after original
  before-vs-p32.json    before -> 066d3dd30 (P3.2 landed, before the main absorption fc12b3063)
  p32-vs-after.json     066d3dd30 -> after (the main absorption and the drift batch 2 merge)
  r2cref-vs-before.json P3.2 evidence r2c-p0-task-reference-shots -> before original
  r2cdel-vs-after.json  P3.2 evidence r2c-p0-task-delivery -> after original
Rows: every task-scenario screenshot (pages.browser.mjs `task`, 5 x 8 projects) and the two breakpoint
screenshots that open the share dialog (breakpoint-599/601-dialog, 4 desktop projects each), plus every
other screenshot whose after original fails the P0 comparator against the current expectation or changed
from the before original beyond noise (p0-drift README「Chromium 渲染噪声」). Beside each row: what P3.2's
second evidence revision measured for the same screenshot (r2c-p0-task-compare.json, its AntD reference
760287474 against its delivery e3ba1c923). A row is attributed to P3.2 when 066d3dd30 already shows the
change and 066d3dd30 -> after does not change it further, and registrable when, in addition, it is a task
screenshot, fails the P0 comparator now, its before original reproduces the current expectation and its
after original differs from the before original under the P0 comparator (register-accepted.cjs refuses
anything else). Reads only."""
import json, os, sys

cdir, sources_path, r2c_path, out_json, out_md = sys.argv[1:6]
sources = json.load(open(sources_path))
r2c = json.load(open(r2c_path))['screenshots']
load = lambda name: {r['file']: r for r in json.load(open(os.path.join(cdir, name)))['rows']}
exp_before, exp_after, before_after = load('exp-vs-before.json'), load('exp-vs-after.json'), load('before-vs-after.json')
before_p32, p32_after = load('before-vs-p32.json'), load('p32-vs-after.json')
ref_before, del_after = load('r2cref-vs-before.json'), load('r2cdel-vs-after.json')

TASK = ['task-detail', 'task-action-hover', 'task-action-focus', 'task-action-menu', 'task-share-dialog']
projects = sorted({f.split('/')[0] for f in exp_after})
task_rows = [f'{p}/{n}.png' for p in projects for n in TASK]
dialog_rows = [f'{p}/breakpoint-{w}-dialog.png' for p in projects if p.endswith('-desktop') for w in (599, 601)]
other = sorted(f for f, r in exp_after.items() if f not in task_rows and f not in dialog_rows
               and (r.get('missing') or r['p0Comparator'] != 'match' or before_after.get(f, {}).get('class') == 'changed'))

def pair(r):
    if not r: return None
    if r.get('missing'): return {'missing': True}
    return {k: r[k] for k in ('bytesEqual', 'differentPixels', 'maxChannelDelta', 'box', 'p0Comparator', 'class') if k in r}

rows = []
for f in task_rows + dialog_rows + other:
    src = sources.get(f, {})
    ea, eb, ba = exp_after.get(f), exp_before.get(f), before_after.get(f)
    row = {'screenshot': f, 'scope': 'task' if f in task_rows else 'breakpoint-dialog' if f in dialog_rows else 'other',
           'expectation': {'layer': src.get('layer'), 'sha256': src.get('sha256'), 'mainCommits': src.get('mainCommits')},
           'before': {'sha256': (ba or {}).get('sha256A'), 'vsExpectation': pair(eb)},
           'after': {'sha256': (ba or {}).get('sha256B'), 'vsExpectation': pair(ea), 'vsBefore': pair(ba)},
           'p32Only': {'beforeToP32': pair(before_p32.get(f)), 'p32ToAfter': pair(p32_after.get(f))},
           'p32Evidence': {'r2cCompare': {k: v for k, v in r2c[f].items() if k in ('equal', 'pixels', 'pixelsAtMost2', 'maxChannelDiff')} if f in r2c else None,
                           'r2cReferenceVsBefore': pair(ref_before.get(f)), 'r2cDeliveryVsAfter': pair(del_after.get(f))}}
    failsNow = bool(ea) and not ea.get('missing') and ea['p0Comparator'] != 'match'
    beforeReproduces = bool(eb) and not eb.get('missing') and eb['p0Comparator'] == 'match'
    afterDiffers = bool(ba) and not ba.get('missing') and ba['p0Comparator'] != 'match'
    bp, pa = before_p32.get(f), p32_after.get(f)
    attributed = bool(bp) and not bp.get('missing') and bp['class'] == 'changed' and bool(pa) and not pa.get('missing') and pa['class'] != 'changed'
    row['failsP0ComparatorNow'] = failsNow
    row['attributedToP32'] = attributed
    row['registrable'] = row['scope'] == 'task' and failsNow and beforeReproduces and afterDiffers and attributed
    rows.append(row)

json.dump({'rows': rows}, open(out_json, 'w'), indent=1, ensure_ascii=False)
fmt = lambda p: '—' if not p else 'missing' if p.get('missing') else 'identical' if p['bytesEqual'] else f"{p['differentPixels']} px / Δ{p['maxChannelDelta']} / {'fails' if p['p0Comparator'] != 'match' else 'passes'}"
with open(out_md, 'w') as md:
    md.write('| 截图 | 当前期望 | before 对当前期望 | after 对当前期望 | after 对 before | before → 066d3dd30 | 066d3dd30 → after | P3.2 第 2 版 r2c 对照 | P3.2 r2c 交付 → after | 可登记 |\n')
    md.write('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n')
    for r in rows:
        e = r['p32Evidence']['r2cCompare']
        r2 = '—' if not e else 'identical' if e.get('equal') else f"{e['pixels']} px / Δ{e['maxChannelDiff']}"
        md.write(f"| {r['screenshot']} | {r['expectation']['layer']} | {fmt(r['before']['vsExpectation'])} | {fmt(r['after']['vsExpectation'])} | {fmt(r['after']['vsBefore'])} | "
                 f"{fmt(r['p32Only']['beforeToP32'])} | {fmt(r['p32Only']['p32ToAfter'])} | {r2} | {fmt(r['p32Evidence']['r2cDeliveryVsAfter'])} | {'是' if r['registrable'] else '否'} |\n")
print(json.dumps({'rows': len(rows), 'failingNow': [r['screenshot'] for r in rows if r['failsP0ComparatorNow']],
                  'attributedToP32': [r['screenshot'] for r in rows if r['attributedToP32']],
                  'registrable': [r['screenshot'] for r in rows if r['registrable']], 'other': other}, indent=1))
