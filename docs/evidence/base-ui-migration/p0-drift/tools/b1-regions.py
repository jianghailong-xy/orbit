#!/usr/bin/env python3
# Usage: b1-regions.py <out.json> — B1 difference regions (e361ee373 -> 57f792135 runs) and, for settings-saved,
# the regions of the main change (P0.2 -> main drift reference) and of B1 on top (reference -> tip run tip-a).
import json, os, subprocess, sys
WT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../../../..'))
EV = f'{WT}/docs/evidence/base-ui-migration'
R = '/var/tmp/p0drift/runs'
def regions(a, b):
    return json.loads(subprocess.check_output(['node', f'{EV}/p0-drift/tools/regions.cjs', a, b], text=True))
B1 = ['chromium-dark-desktop/profile-validation.png', 'chromium-light-desktop/profile-validation.png', 'chromium-light-phone/profile-validation.png',
      'chromium-dark-phone/profile-validation.png', 'webkit-light-phone/profile-validation.png', 'webkit-dark-phone/profile-validation.png',
      'chromium-light-desktop/settings-saved.png', 'chromium-dark-desktop/settings-saved.png', 'chromium-light-phone/settings-saved.png', 'chromium-dark-phone/settings-saved.png']
out = {'note': 'Clusters of differing pixels (8-connected after a 6 px dilation). The toast card is at x 1118.97-1264, y 16-52 on desktop and x 123-263, y 56-92 on phones (B1-success-pill.json computedStyles); its box-shadow 0 8px 22px extends about 30 px around it.',
       'b1_e361ee373_to_57f792135': {}, 'settingsSaved_separation': {}}
for s in B1:
    out['b1_e361ee373_to_57f792135'][s] = regions(f'{R}/e361ee373/snapshots/{s}', f'{R}/57f792135/snapshots/{s}')
for p in ['chromium-light-desktop', 'chromium-dark-desktop', 'chromium-light-phone', 'chromium-dark-phone', 'webkit-light-desktop', 'webkit-dark-desktop', 'webkit-light-phone', 'webkit-dark-phone']:
    s = f'{p}/settings-saved.png'
    out['settingsSaved_separation'][s] = {
        'p02_to_mainDriftReference (A4, main 4088d37e6 / 82c7e92ff)': regions(f'{EV}/p0.2/screenshots/{s}', f'{EV}/p0-drift/reference/screenshots/{s}'),
        'mainDriftReference_to_tip (tip-a run, da13423d3)': regions(f'{EV}/p0-drift/reference/screenshots/{s}', f'{R}/tip-a/snapshots/{s}'),
    }
json.dump(out, open(sys.argv[1], 'w'), indent=1)
def boxes(d): return [(c['x'], c['y'], c['width'], c['height'], c['pixels']) for c in d['clusters'] if c['pixels'] > 20]
for s, v in out['settingsSaved_separation'].items():
    a, b = list(v.values())
    print(s, '| main:', a['pixels'], 'px y-range', (min(c[1] for c in boxes(a)), max(c[1]+c[3] for c in boxes(a))) if boxes(a) else None, '| B1 on top:', b['pixels'], 'px', boxes(b))
