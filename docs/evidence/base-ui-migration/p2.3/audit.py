"""Audit notification evidence and unchanged contracts; compare original PNG pixels."""
import hashlib, json, math, pathlib, re, subprocess
from PIL import Image
root = pathlib.Path(__file__).resolve().parents[4]
evidence = pathlib.Path(__file__).resolve().parent
baseline = '67e62c0b4028eefe2c619dac80d3fac312cea601'
sha = lambda content: hashlib.sha256(content).hexdigest()
result = {'baseline': baseline, 'unchangedRuntime': {}, 'notificationImportsAndQueries': {}, 'baselineScreenshots': [], 'attachmentCounts': {}, 'overlayAppearance': [], 'productionPixels': []}
for name in ['src/web/src/lib/toast.tsx','src/web/src/lib/toastFeed.ts','src/web/src/lib/toastStore.ts','src/web/src/main.tsx']:
    content = (root / name).read_bytes()
    assert content == subprocess.check_output(['git','show',f'{baseline}:{name}'],cwd=root)
    result['unchangedRuntime'][name] = sha(content)
for name in ['src/web/src/lib/toast.tsx','src/web/src/lib/toastFeed.ts','src/web/src/lib/toastStore.ts','src/web/src/components/ToastViewport.tsx','src/web/src/components/ui/feedbackPortal.ts','src/web/src/components/ui/Overlay.tsx']:
    text = (root / name).read_text()
    hits = re.findall(r'''(?:from\s*|import\s*)["']antd(?:/[^"']*)?["']|\.ant-(?:message|notification)|(?:querySelector|closest)\([^\n]*\.ant-''', text)
    assert not hits, (name,hits)
    result['notificationImportsAndQueries'][name] = {'hits':hits, 'sha256':sha(text.encode())}
for p in sorted((root/'docs/evidence/base-ui-migration/p0.2/screenshots').rglob('*.png')):
    rel = p.relative_to(root).as_posix()
    content = p.read_bytes()
    assert content == subprocess.check_output(['git','show',f'{baseline}:{rel}'],cwd=root)
    result['baselineScreenshots'].append({'file':rel,'sha256':sha(content)})
for directory in ['reference-run','toasts-run','overlays-regression','production-run','production-reference-run']:
    summary = json.loads((evidence/directory/'summary.json').read_text())
    count = 0
    for test in summary['tests']:
        for artifact in test['artifacts']:
            if isinstance(artifact,str): continue
            assert sha((evidence/directory/artifact['file']).read_bytes()) == artifact['sha256']
            count += 1
    result['attachmentCounts'][directory] = count

def pixels(left,right,box=None):
    a,b=Image.open(left).convert('RGBA'),Image.open(right).convert('RGBA')
    assert a.size==b.size,(left,right,a.size,b.size)
    if box:a,b=a.crop(box),b.crop(box)
    diffs=[(i,x,y) for i,(x,y) in enumerate(zip(a.getdata(),b.getdata())) if x!=y]
    return {'comparedPixels':a.width*a.height,'differentPixels':len(diffs),'maxChannelDelta':max((abs(x-y) for _,a,b in diffs for x,y in zip(a,b)),default=0)}

for current in sorted((evidence/'toasts-run').glob('*unchanged-appearance--appearance.json')):
    prefix=current.name.split('--')[0]
    kind=next(kind for kind in ['Bottom-drawer','Drawer','Dialog'] if f'-in-{kind}-' in current.name)
    reference=evidence/'reference-run'/f'{prefix}--reference-{kind}--appearance.json'
    c=json.loads(current.read_text()); r=json.loads(reference.read_text())
    assert c['before']==r['before'],current
    assert c['after']==r['after'],current
    actual=current.with_name(current.name.replace('--appearance.json','--with-overlay.png'))
    original=reference.with_name(reference.name.replace('--appearance.json','--with-overlay.png'))
    result['overlayAppearance'].append({'project':prefix,'kind':kind,'strictComputedParity':True,'png':pixels(original,actual)})
for actual in sorted((evidence/'production-run').glob('*--production-notification.png')):
    prefix=actual.name.split('--')[0]
    old=root/'docs/evidence/base-ui-migration/p0.2/screenshots'/prefix/'notification-error.png'
    geometry=json.loads(actual.with_name(actual.name.replace('--production-notification.png','--notification-appearance.json')).read_text())['region']
    a=Image.open(actual)
    # The whole PNG remains intact. Compare the notification plus 12px around it
    # for shadow; unrelated production changes outside this box are reported too.
    box=[max(0,math.floor(geometry['x'])-12),max(0,math.floor(geometry['y'])-12),min(a.width,math.ceil(geometry['right'])+12),min(a.height,math.ceil(geometry['bottom'])+12)]
    reference=evidence/'production-reference-run'/actual.name
    assert pixels(reference,actual)['differentPixels']==0,(actual,'changed from task starting tree')
    compared=pixels(old,actual,box)
    assert compared['differentPixels']==0,(actual,compared)
    result['productionPixels'].append({'project':prefix,'box':box,'notificationAndShadow':compared,'wholePage':pixels(old,actual),'wholePageAgainstTaskStart':pixels(reference,actual)})
(evidence/'audit.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'baselinePNGsUnchanged':len(result['baselineScreenshots']),'attachments':result['attachmentCounts'],'overlayPairs':result['overlayAppearance'],'production':result['productionPixels']},indent=2))
