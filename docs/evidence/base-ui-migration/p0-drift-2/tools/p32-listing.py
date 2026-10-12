#!/usr/bin/env python3
"""Usage: p32-listing.py <delivery summary.json> <p32 pair json> <out.json>
The P3.2 dispositions on the delivery merge, for the registration task 34bSHg8V2p0zaRMKy7tUQ: every unexpected
test of a delivery round (screenshot it stopped at, Playwright's different pixels, the expectation's layer) with
the category of P3.2's by-design difference (p3.2/README.md「P0 页面矩阵」), and every screenshot P3.2 changed
below the comparator threshold (fffcdb532 -> 066d3dd30, same harness, compare.cjs)."""
import json, sys
summary, pairs, out = sys.argv[1:4]
s = json.load(open(summary))
rows = json.load(open(pairs))['full-maint-fffcdb532:full-maint2-066d3dd30']
category = {
    'task-action-menu.png': 'More 按钮的焦点环：旧菜单打开后焦点留在触发按钮，Orbit Menu 把焦点移入菜单（P2.2 约定）；WebKit 另有 “Share…” 地球图标底行约 30 像素（行高数值精度，P3.2「未消除的差异」第 5 条）',
    'task-share-dialog.png': '打开后按一次 Tab 的焦点位置：旧对话框先聚焦 Close、Tab 到 Access；Orbit 先聚焦对话框、Tab 到 Close',
}
failures = []
for u in s['unexpected']:
    assert u['test'] == 'task', u
    rel = f"{u['project']}/{u['screenshot']}"
    failures.append({'project': u['project'], 'test': u['test'], 'stoppedAt': u['screenshot'], 'expectedLayer': u['expectedLayer'],
                     'differentPixels': u['differentPixels'], 'fffcdb532To066d3dd30': rows.get(rel), 'p32Category': category[u['screenshot']]})
below = [{'screenshot': f, 'differentPixels': v[1], 'maxChannelDelta': v[2], 'p0Comparator': v[3]} for f, v in sorted(rows.items()) if v[0] == 'changed' and v[3] == 'match']
over = [f for f, v in sorted(rows.items()) if v[0] == 'changed' and v[3] != 'match']
json.dump({'failures': sorted(failures, key=lambda r: r['project']), 'overThresholdChangedByP32': over, 'belowThresholdChangedByP32': below}, open(out, 'w'), indent=1, ensure_ascii=False)
for r in sorted(failures, key=lambda r: r['project']): print(r['project'].ljust(24), r['stoppedAt'].ljust(22), r['differentPixels'], r['expectedLayer'])
print('below threshold:', [(b['screenshot'], b['differentPixels']) for b in below])
