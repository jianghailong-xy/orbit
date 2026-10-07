#!/usr/bin/env python3
"""Usage: per-screenshot.py <compare dir> <sources.json> <out.json> <out.md>

Every one of the 252 P0 screenshots: the layer its current expectation comes from (globalSetup's sources.json),
and its class in each same-environment comparison of this batch (same / noise / changed, with pixels and max
channel delta when not byte-identical): across the absorb (fc58e5713 -> tip), at each drill-down level, the
fixture (tip with the original tests -> tip with 5d7801e47's), and the final tip against the current expectation
with the P0 comparator's verdict."""
import json, sys
cdir, sources, out_json, out_md = sys.argv[1:5]
src = json.load(open(sources))
pairs = [('absorb', 'fc58e5713--tip.json', 'fc58e5713 → tip'),
         ('main', '422627ef7--tip.json', '422627ef7 → eee179f5d'),
         ('google', '106c25fc2-r2--98cdd37d0.json', '106c25fc2 → 98cdd37d0'),
         ('s4', '463bb277a--558a8ba1f.json', '463bb277a → 558a8ba1f'),
         ('fixture', 'tip-orig--tip-fix.json', '补固定响应前后'),
         ('expected', 'expected--tip-fix.json', '当前期望 → 补后 tip')]
data = {k: {r['file']: r for r in json.load(open(f'{cdir}/{f}'))['rows']} for k, f, _ in pairs}
files = sorted(src)
rows = []
for f in files:
    row = {'screenshot': f, 'expectedLayer': src[f]['layer']}
    for k, _, _ in pairs:
        r = data[k][f]
        row[k] = {'class': r['class'], 'differentPixels': r['differentPixels'], 'maxChannelDelta': r['maxChannelDelta'], 'p0Comparator': r['p0Comparator']}
    rows.append(row)
summary = {k: {c: sum(1 for r in rows if r[k]['class'] == c) for c in ('same', 'noise', 'changed')} for k, _, _ in pairs}
summary['expectedComparatorFails'] = [r['screenshot'] for r in rows if r['expected']['p0Comparator'] != 'match']
json.dump({'summary': summary, 'rows': rows}, open(out_json, 'w'), indent=1)
cell = lambda c: '相同' if c['class'] == 'same' else f"{'噪声' if c['class'] == 'noise' else '变化'} {c['differentPixels']}/{c['maxChannelDelta']}"
with open(out_md, 'w') as o:
    o.write('# 逐张对照（第 3 批）\n\n由 [per-screenshot.py](../tools/per-screenshot.py) 从 [compare/](../compare/) 生成。每格是同环境运行之间的结果：「相同」为逐字节相同；「噪声 n/d」「变化 n/d」为 n 个像素不同、单通道最大差 d，按 p0-drift README「Chromium 渲染噪声」分类。最后一列是 P0 比较器（`maxDiffPixels: 0`、默认 threshold）对照当前期望的结论。`09cc5760d`、`eee179f5d` 与 tip 的 `src/web`、`src/shared` 相同，用 tip 的运行（full-orig-tip）代表；`106c25fc2` 用重跑 full-orig-106c25fc2-r2（第一次运行的两张偶发截图见 README）。「补固定响应前后」是 full-orig-tip → full-fix-tip，「当前期望」是 tip-start 组装的期望。\n\n')
    o.write('| 汇总 | ' + ' | '.join(t for _, _, t in pairs) + ' |\n| --- |' + ' --- |' * len(pairs) + '\n')
    for c in ('same', 'noise', 'changed'):
        o.write(f'| {c} | ' + ' | '.join(str(summary[k][c]) for k, _, _ in pairs) + ' |\n')
    o.write(f"\nP0 比较器对照当前期望不通过的：{len(summary['expectedComparatorFails'])} 张。\n\n")
    o.write('| 截图 | 期望来源 | ' + ' | '.join(t for _, _, t in pairs) + ' | P0 比较器 |\n| --- | --- |' + ' --- |' * (len(pairs) + 1) + '\n')
    for r in rows:
        o.write(f"| {r['screenshot']} | {r['expectedLayer']} | " + ' | '.join(cell(r[k]) for k, _, _ in pairs) + f" | {'通过' if r['expected']['p0Comparator'] == 'match' else r['expected']['p0Comparator']} |\n")
print(json.dumps(summary, ensure_ascii=False))
