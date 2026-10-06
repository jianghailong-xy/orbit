"""Audit P2.3 revision 2 without changing any screenshot or comparison tolerance."""
import hashlib, json, math, pathlib, re, subprocess
from PIL import Image
here = pathlib.Path(__file__).resolve().parent
root = here.parents[4]
previous = here.parent
start = '67e62c0b4028eefe2c619dac80d3fac312cea601'
r1 = '0e3b3a61cadc73bda93f06985dbd866e4d1fba79'
implementation = 'ef1d367341a1ac080b74c323c0bf104bfc140cb6'
sha = lambda b: hashlib.sha256(b).hexdigest()
out = {'taskStart': start, 'revision1': r1, 'implementation': implementation, 'unchanged': {}, 'testedSources': {}, 'screenshots': [], 'attachments': {}, 'settled': [], 'midpoints': [], 'production': []}
assert not subprocess.check_output(['git', 'diff', implementation, '--', 'src/web'], cwd=root)
for name in ['src/web/src/lib/toast.tsx', 'src/web/src/lib/toastFeed.ts', 'src/web/src/lib/toastStore.ts', 'src/web/src/main.tsx', 'src/web/src/components/ui/Overlay.css', 'src/web/src/components/ui/ConfirmDialog.tsx']:
    data = (root/name).read_bytes()
    assert data == subprocess.check_output(['git', 'show', f'{start}:{name}'], cwd=root), name
    out['unchanged'][name] = sha(data)
for name in ['src/web/src/components/ui/Overlay.tsx', 'src/web/src/components/ui/feedbackPortal.ts']:
    data = (root/name).read_bytes()
    assert data == subprocess.check_output(['git', 'show', f'{r1}:{name}'], cwd=root), name
    out['unchanged'][name] = sha(data)
for name, expected in json.loads((here/'tested-sources.json').read_text()).items():
    out['testedSources'][name] = sha((root/name).read_bytes())
    assert out['testedSources'][name] == expected, name
for p in sorted((root/'docs/evidence/base-ui-migration/p0.2/screenshots').rglob('*.png')):
    name = p.relative_to(root).as_posix()
    data = p.read_bytes()
    assert data == subprocess.check_output(['git', 'show', f'{start}:{name}'], cwd=root)
    out['screenshots'].append({'file': name, 'sha256': sha(data)})
for directory in ['toasts-run', 'overlays-regression', 'production-run', 'reference-motion-run', 'coordinator-after', 'continuous-motion-after', 'original-nested-motion', 'original-confirmation-close', 'original-confirmation-open-close', 'static-raster-after']:
    summary = json.loads((here/directory/'summary.json').read_text())
    assert summary['stats']['unexpected'] == summary['stats']['skipped'] == summary['stats']['flaky'] == 0, directory
    count = 0
    for test in summary['tests']:
        assert test['status'] == 'expected', test['name']
        for a in test['artifacts']:
            assert sha((here/directory/a['file']).read_bytes()) == a['sha256']
            count += 1
    out['attachments'][directory] = {'stats': summary['stats'], 'artifacts': count}

def pixels(a, b, box=None):
    left, right = Image.open(a).convert('RGBA'), Image.open(b).convert('RGBA')
    assert left.size == right.size, (a, b, left.size, right.size)
    if box: left, right = left.crop(box), right.crop(box)
    count = sum(x != y for x, y in zip(left.get_flattened_data(), right.get_flattened_data()))
    return {'pixels': left.width*left.height, 'differentPixels': count}

for p in sorted((here/'toasts-run').glob('*unchanged-appearance--appearance.json')):
    project = p.name.split('--')[0]
    kind = next(k for k in ['Bottom-drawer', 'Drawer', 'Dialog'] if f'-in-{k}-' in p.name)
    ref = previous/'reference-run'/f'{project}--reference-{kind}--appearance.json'
    actual, original = json.loads(p.read_text()), json.loads(ref.read_text())
    assert actual['before'] == original['before'] and actual['after'] == original['after'], p
    c = pixels(p.with_name(p.name.replace('--appearance.json', '--with-overlay.png')), ref.with_name(ref.name.replace('--appearance.json', '--with-overlay.png')))
    assert c['differentPixels'] == 0, p
    out['settled'].append({'project': project, 'kind': kind, 'png': c, 'computedStylesEqual': True})
for p in sorted((here/'reference-motion-run').glob('*.png')):
    actual = here/'toasts-run'/p.name
    assert actual.exists(), p.name
    c = pixels(p, actual)
    assert c['differentPixels'] == 0, (p, c)
    out['midpoints'].append({'file': p.name, 'png': c})
for p in sorted((here/'production-run').glob('*--production-notification.png')):
    project = p.name.split('--')[0]
    geometry = json.loads(p.with_name(p.name.replace('--production-notification.png', '--notification-appearance.json')).read_text())['region']
    image = Image.open(p)
    box = [max(0, math.floor(geometry['x'])-12), max(0, math.floor(geometry['y'])-12), min(image.width, math.ceil(geometry['right'])+12), min(image.height, math.ceil(geometry['bottom'])+12)]
    old = root/'docs/evidence/base-ui-migration/p0.2/screenshots'/project/'notification-error.png'
    c = pixels(old, p, box)
    full = pixels(previous/'production-reference-run'/p.name, p)
    assert c['differentPixels'] == full['differentPixels'] == 0, p
    out['production'].append({'project': project, 'box': box, 'notificationAndShadow': c, 'fullPageAgainstTaskStart': full, 'fullPageAgainstP0': pixels(old, p)})
assert len(out['screenshots']) == 252
assert len(out['settled']) == 24
assert len(out['midpoints']) == 160
assert len(out['production']) == 8
out['continuousMotion'] = []
for p in sorted((here/'toasts-run').glob('*--continuous-card-motion.json')):
    motion = json.loads(p.read_text())
    changed = [s for s in motion['samples'] if not s['sameNode'] or s['opacity'] != '1' or
               any(abs(s['card'][key] - motion['before'][key]) > .1 for key in ['x', 'y', 'width', 'height'])]
    assert not changed, p
    out['continuousMotion'].append({'file': p.name, 'sampledFrames': len(motion['samples']), 'changedFrames': len(changed),
                                    'phases': sorted({s['phase'] for s in motion['samples']})})
assert len(out['continuousMotion']) == 24
out['nativeTimers'] = []
for p in sorted((here/'toasts-run').glob('*--native-timer.json')):
    result = json.loads(p.read_text())
    # The browser assertion checks disappearance; precise dwell boundaries are
    # covered by the clock tests, not by wall time under machine load.
    assert result['count'] == 0, p
    out['nativeTimers'].append({'file': p.name, **result})
assert len(out['nativeTimers']) == 8
files = ['src/web/src/lib/toast.tsx', 'src/web/src/lib/toastFeed.ts', 'src/web/src/lib/toastStore.ts', 'src/web/src/components/ToastViewport.tsx', 'src/web/src/components/ui/feedbackPortal.ts', 'src/web/src/components/ui/Overlay.tsx']
for name in files:
    assert not re.findall(r'''(?:from\s*|import\s*)["']antd(?:/[^"']*)?["']|\.ant-(?:message|notification)|(?:querySelector|closest)\([^\n]*\.ant-''', (root/name).read_text()), name
out['noAntDInternalDOM'] = files
(here/'audit.json').write_text(json.dumps(out, indent=2)+'\n')
print(json.dumps({'baselineImagesUnchanged': len(out['screenshots']), 'attachments': out['attachments'], 'settledPairs': len(out['settled']), 'midpointImagePairs': len(out['midpoints']), 'production': out['production']}, indent=2))
