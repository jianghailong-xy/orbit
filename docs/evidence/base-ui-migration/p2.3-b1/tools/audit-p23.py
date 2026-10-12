#!/usr/bin/env python3
"""Usage: audit-p23.py <toasts-collected-dir> <production-collected-dir> <out.json> [baseline-toasts-dir baseline-production-dir]

Re-applies the P2.3 revision-3 audit (docs/evidence/base-ui-migration/p2.3/revision-3/audit.py) to a new
pair of runs, with the same references and the same exact comparisons (all RGBA pixels, no tolerance),
but records every result instead of stopping at the first assertion:
- settled: 24 'unchanged appearance' cases: measured geometry/styles equal to the task-start reference
  (p2.3/reference-run) before and after the overlay opens, and the with-overlay PNG pixel-equal to it;
- midpoints: the 160 reference PNGs of p2.3/revision-2/reference-motion-run pixel-equal to this run's;
- production: the notification region + 12 px of each production screenshot pixel-equal to the P0.2
  notification-error.png (full page against the task-start reference recorded as well);
- continuousMotion (24), nativeTimers (8), stationary hover JSON rules (8+8+8), stationaryArrivalPixels (8)
  against p2.3/revision-3/original-hover-run.
With a baseline pair (the same commands on the unmodified project tip), every PNG attachment of both runs
is also compared pairwise (same-commit comparison)."""
import json, math, pathlib, sys
from PIL import Image
root = pathlib.Path('/root/.orbit/worktrees/bf593adf-7724-576c-968c-fcd10880a595')
p23 = root / 'docs/evidence/base-ui-migration/p2.3'
toasts, production, out_path = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3])
base_toasts = pathlib.Path(sys.argv[4]) if len(sys.argv) > 4 else None
base_production = pathlib.Path(sys.argv[5]) if len(sys.argv) > 5 else None

def pixels(a, b, box=None):
    left, right = Image.open(a).convert('RGBA'), Image.open(b).convert('RGBA')
    if left.size != right.size: return {'sizeMismatch': [left.size, right.size]}
    if box: left, right = left.crop(box), right.crop(box)
    import numpy as np
    d = np.abs(np.asarray(left, dtype=np.int16) - np.asarray(right, dtype=np.int16)).max(axis=2)
    return {'pixels': left.width * left.height, 'differentPixels': int((d > 0).sum()), 'maxChannelDelta': int(d.max())}

out = {'toasts': str(toasts), 'production': str(production), 'summary': {}}
summary = json.loads((toasts / 'summary.json').read_text())
out['toastsStats'] = summary['stats']
out['productionStats'] = json.loads((production / 'summary.json').read_text())['stats']

settled = []
for p in sorted(toasts.glob('*unchanged-appearance--appearance.json')):
    project = p.name.split('--')[0]
    kind = next(k for k in ['Bottom-drawer', 'Drawer', 'Dialog'] if f'-in-{k}-' in p.name)
    ref = p23 / 'reference-run' / f'{project}--reference-{kind}--appearance.json'
    actual, original = json.loads(p.read_text()), json.loads(ref.read_text())
    png = p.with_name(p.name.replace('--appearance.json', '--with-overlay.png'))
    c = pixels(png, ref.with_name(ref.name.replace('--appearance.json', '--with-overlay.png'))) if png.exists() else {'missing': True}
    settled.append({'project': project, 'kind': kind, 'beforeEqual': actual['before'] == original['before'], 'afterEqual': actual['after'] == original['after'], 'png': c})
out['settled'] = settled
midpoints = []
for p in sorted((p23 / 'revision-2/reference-motion-run').glob('*.png')):
    actual = toasts / p.name
    midpoints.append({'file': p.name, 'png': pixels(p, actual) if actual.exists() else {'missing': True}})
out['midpoints'] = midpoints
prod = []
for p in sorted(production.glob('*--production-notification.png')):
    project = p.name.split('--')[0]
    geometry = json.loads(p.with_name(p.name.replace('--production-notification.png', '--notification-appearance.json')).read_text())['region']
    image = Image.open(p)
    box = [max(0, math.floor(geometry['x']) - 12), max(0, math.floor(geometry['y']) - 12), min(image.width, math.ceil(geometry['right']) + 12), min(image.height, math.ceil(geometry['bottom']) + 12)]
    old = root / 'docs/evidence/base-ui-migration/p0.2/screenshots' / project / 'notification-error.png'
    row = {'project': project, 'box': box, 'notificationAndShadowVsP02': pixels(old, p, box),
           'fullPageVsTaskStart': pixels(p23 / 'production-reference-run' / p.name, p), 'fullPageVsP02': pixels(old, p)}
    if base_production: row['fullPageVsBaseline'] = pixels(base_production / p.name, p)
    prod.append(row)
out['production'] = prod
motion = []
for p in sorted(toasts.glob('*--continuous-card-motion.json')):
    m = json.loads(p.read_text())
    changed = [s for s in m['samples'] if not s['sameNode'] or s['opacity'] != '1' or any(abs(s['card'][k] - m['before'][k]) > .1 for k in ['x', 'y', 'width', 'height'])]
    motion.append({'file': p.name, 'sampledFrames': len(m['samples']), 'changedFrames': len(changed)})
out['continuousMotion'] = motion
out['nativeTimers'] = [{'file': p.name, **json.loads(p.read_text())} for p in sorted(toasts.glob('*--native-timer.json'))]
hover = []
for p in sorted(toasts.glob('*--native-stationary-arrival.json')):
    r = json.loads(p.read_text())
    rel = p.with_name(p.name.replace('--native-stationary-arrival.json', '--native-stationary-release.json'))
    release = json.loads(rel.read_text()) if rel.exists() else None
    hover.append({'file': p.name, 'held': r['remaining'] == 1 and r['elapsedMs'] >= 6500, 'mouseover': any(e['type'] == 'mouseover' and e['inResult'] for e in r['events']),
                  'noMousemove': not any(e['type'] == 'mousemove' for e in r['events']), 'released': release is not None and release['remaining'] == 0, 'releaseRecorded': release is not None})
out['stationaryHover'] = hover
layouts = []
for p in sorted(toasts.glob('*--stationary-layout.json')):
    r = json.loads(p.read_text())
    layouts.append({'file': p.name, 'ok': (r['visibleAfterReleaseMs'], r['expiredAfterReleaseMs']) == (5999, 6000)
                    and any(e['type'] == 'mouseover' and e['inResult'] for e in r['entered']) and any(e['type'] == 'mouseover' and not e['inResult'] for e in r['left'])
                    and not any(e['type'] == 'mousemove' for e in r['entered'] + r['left'])})
out['stationaryLayout'] = layouts
out['stationaryReplacement'] = [{'file': p.name, 'ok': json.loads(p.read_text()) == {'pausedAcrossFourTransfersMs': 40800, 'replacedFeedPausedMs': 10000, 'visibleAfterReleaseMs': 5999, 'expiredAfterReleaseMs': 6000}}
                                for p in sorted(toasts.glob('*--stationary-replacement.json'))]
out['stationaryArrivalPixels'] = [{'file': p.name, 'png': pixels(p, toasts / p.name) if (toasts / p.name).exists() else {'missing': True}} for p in sorted((p23 / 'revision-3/original-hover-run').glob('*--stationary-arrival.png'))]
if base_toasts:
    pairs = []
    for p in sorted(toasts.glob('*.png')):
        b = base_toasts / p.name
        pairs.append({'file': p.name, 'png': pixels(b, p) if b.exists() else {'missingInBaseline': True}})
    out['sameCommitPngs'] = pairs
def zero(c): return c.get('differentPixels') == 0
def missing(c): return bool(c.get('missing') or c.get('missingInBaseline'))
s = out['summary']
s['settled'] = {'cases': len(settled), 'geometryAndStylesEqual': sum(r['beforeEqual'] and r['afterEqual'] for r in settled), 'pngZeroDiff': sum(zero(r['png']) for r in settled), 'notEqual': [f"{r['project']}/{r['kind']}" for r in settled if not (r['beforeEqual'] and r['afterEqual'] and zero(r['png']))]}
s['midpoints'] = {'pairs': len(midpoints), 'zeroDiff': sum(zero(r['png']) for r in midpoints), 'missing': [r['file'] for r in midpoints if missing(r['png'])], 'nonZero': [r['file'] for r in midpoints if not zero(r['png']) and not missing(r['png'])]}
s['production'] = {'cases': len(prod), 'notificationRegionZeroDiffVsP02': sum(zero(r['notificationAndShadowVsP02']) for r in prod),
                   'fullPageZeroDiffVsTaskStart': sum(zero(r['fullPageVsTaskStart']) for r in prod),
                   **({'fullPageZeroDiffVsBaseline': sum(zero(r['fullPageVsBaseline']) for r in prod)} if base_production else {})}
s['continuousMotion'] = {'cases': len(motion), 'changedFrames': sum(r['changedFrames'] for r in motion), 'sampledFrames': sum(r['sampledFrames'] for r in motion)}
s['nativeTimers'] = {'cases': len(out['nativeTimers']), 'gone': sum(r['count'] == 0 for r in out['nativeTimers'])}
s['stationaryHover'] = {'cases': len(hover), 'ok': sum(all([r['held'], r['mouseover'], r['noMousemove'], r['released']]) for r in hover)}
s['stationaryLayout'] = {'cases': len(layouts), 'ok': sum(r['ok'] for r in layouts)}
s['stationaryReplacement'] = {'cases': len(out['stationaryReplacement']), 'ok': sum(r['ok'] for r in out['stationaryReplacement'])}
s['stationaryArrivalPixels'] = {'pairs': len(out['stationaryArrivalPixels']), 'zeroDiff': sum(zero(r['png']) for r in out['stationaryArrivalPixels'])}
if base_toasts:
    s['sameCommitPngs'] = {'pairs': len(out['sameCommitPngs']), 'zeroDiff': sum(zero(r['png']) for r in out['sameCommitPngs']),
                           'different': [r['file'] for r in out['sameCommitPngs'] if not zero(r['png'])]}
out_path.write_text(json.dumps(out, indent=1) + '\n')
print(json.dumps({'toastsStats': out['toastsStats'], 'productionStats': out['productionStats'], **s}, indent=1))
