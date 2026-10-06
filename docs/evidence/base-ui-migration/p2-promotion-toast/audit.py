"""Compare original PNG pixels and styles; verify source/evidence provenance."""
import hashlib, json, pathlib, subprocess, sys
from PIL import Image, ImageChops
root = pathlib.Path(__file__).resolve().parents[4]
here = pathlib.Path(__file__).resolve().parent
refs = json.loads((here/'refs.json').read_text())
run = sys.argv[1] if len(sys.argv) > 1 else 'latest-toasts-run'
output = sys.argv[2] if len(sys.argv) > 2 else 'latest-audit.json'
final = here/run
def git(*args): return subprocess.check_output(['git', *args], cwd=root)
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def pixels(a, b):
    left, right = Image.open(a).convert('RGBA'), Image.open(b).convert('RGBA')
    if left.size != right.size: return {'sizes': [left.size, right.size], 'changedPixels': None}
    diff = ImageChops.difference(left, right)
    return {'sizes': [left.size, right.size], 'changedPixels': sum(p != (0,0,0,0) for p in diff.get_flattened_data()), 'bounds': diff.convert('RGB').getbbox()}
checks = {'refs': refs, 'staticPixels': [], 'computedStyles': [], 'historyPixels': [], 'stackPixels': [], 'sourceHashes': {}, 'attachments': []}
for p in final.glob('*--with-overlay.png'):
    for side in ['main', 'project']:
        before = here/(side+'-reference')/p.name
        result = pixels(before, p)
        checks['staticPixels'].append({'source': side, 'file': p.name, **result})
        assert result['changedPixels'] == 0, (side, p.name, result)
for p in final.glob('*--appearance.json'):
    for side in ['main', 'project']:
        before = json.loads((here/(side+'-reference')/p.name).read_text())
        after = json.loads(p.read_text())
        checks['computedStyles'].append({'source': side, 'file': p.name, 'equal': before == after})
        assert before == after, (side,p.name)
for p in (here.parent/'p2.3/revision-3/toasts-run').glob('*.png'):
    current = final/p.name
    if current.exists(): checks['historyPixels'].append({'file': p.name, **pixels(p,current)})
for p in final.glob('*stack.png'):
    for side in ['main','project']:
        before = here/(side+'-stack-reference')/p.name
        if before.exists(): checks['stackPixels'].append({'source':side,'file':p.name,**pixels(before,p)})
checks['settledMainStyles'] = []
checks['compositingPixels'] = []
for p in (here/'settled-final-stack').glob('*styles.json'):
    before = json.loads((here/'settled-main-stack'/p.name).read_text())
    after = json.loads(p.read_text())
    assert len(before) == len(after)
    changes = [{k:[a[k],b[k]] for k in a if a[k] != b[k]} for a,b in zip(before,after) if a != b]
    assert all(set(c) == {'willChange'} and c['willChange'] == ['auto','transform'] for c in changes), (p.name,changes)
    checks['settledMainStyles'].append({'file':p.name,'changes':changes})
for p in (here/'settled-final-stack').glob('*.png'):
    original = here/'compositing-reference'/p.name
    result = pixels(original,p)
    styles = json.loads(p.with_name(p.stem+'-styles.json').read_text())
    cards = [s['rect'] for s in styles if 'toast' in s['class'].split()]
    image = Image.open(p)
    region = (max(0,int(min(r['left'] for r in cards))-12),max(0,int(min(r['top'] for r in cards))-12),
              min(image.width,int(max(r['right'] for r in cards))+12),min(image.height,int(max(r['bottom'] for r in cards))+12))
    a,b = Image.open(original).convert('RGBA').crop(region),image.convert('RGBA').crop(region)
    region_changes = sum(x!=(0,0,0,0) for x in ImageChops.difference(a,b).get_flattened_data())
    assert region_changes == 0, (p.name,region_changes)
    checks['compositingPixels'].append({'file':p.name,**result,'notificationAndShadowRegion':region,'notificationAndShadowChangedPixels':region_changes})
# Every old tracked evidence file (including failed traces and reproducible
# scripts), not just the selected screenshots, must match the project tip.
history = git('ls-tree','-r','--name-only',refs['project'],'--','docs/evidence/base-ui-migration').decode().splitlines()
for path in history:
    original = git('show',f"{refs['project']}:{path}")
    assert (root/path).read_bytes() == original, path
checks['historicalFilesUnchanged'] = len(history)
checks['p0OriginalScreenshotsUnchanged'] = sum(p.startswith('docs/evidence/base-ui-migration/p0.2/screenshots/') and p.endswith('.png') for p in history)
assert checks['p0OriginalScreenshotsUnchanged'] == 252
source_manifest = json.loads((here/'tested-sources.json').read_text())
for path, digest in source_manifest['files'].items():
    assert sha(root/path) == digest, path
    checks['sourceHashes'][path] = digest
for path in ['src/web/src/components/ui/Overlay.tsx','src/web/src/components/ui/feedbackPortal.ts','package-lock.json','src/web/package.json','src/web/ui-migration/playwright.config.mjs']:
    assert git('show',f"{refs['project']}:{path}") == (root/path).read_bytes(), path
checks['inheritedMainPathsUnchanged'] = not git('diff',refs['main'],'HEAD','--','src/apiserver','src/runner-go','src/shared','src/macos','src/web/src/components/WorkspaceView.tsx','src/web/src/components/WorkspaceView.commitResultMessage.test.tsx','src/web/src/lib/sessionFolders.ts','src/web/src/lib/sessionFolders.test.ts')
assert checks['inheritedMainPathsUnchanged']
checks['priorReferencesRemainValid'] = not git('diff',refs['initialMain'],refs['main'],'--','src/web','package.json','package-lock.json') and not git('diff',refs['previousValidatedCommit'],refs['finalValidatedCommit'],'--','src/web','package.json','package-lock.json')
assert checks['priorReferencesRemainValid']
for directory in [run,'main-reference','project-reference','main-stack-reference','project-stack-reference','settled-main-stack','settled-project-stack','settled-final-stack','compositing-reference']:
    summary = json.loads((here/directory/'summary.json').read_text())
    assert summary['stats']['unexpected'] == summary['stats']['skipped'] == summary['stats']['flaky'] == 0
    for test in summary['tests']:
        for a in test['artifacts']:
            assert sha(here/directory/a['file']) == a['sha256']
    checks['attachments'].append({'directory':directory,'stats':summary['stats'],'verified':sum(len(t['artifacts']) for t in summary['tests'])})
assert not (here/output).exists(), 'Use a new output name; preserve earlier audit results'
(here/output).write_text(json.dumps(checks,indent=2)+'\n')
print(json.dumps({'staticPixelPairs':len(checks['staticPixels']),'equalStylePairs':len(checks['computedStyles']),'historicalFilesUnchanged':len(history),'p0Screenshots':checks['p0OriginalScreenshotsUnchanged'],'historyPixelPairs':len(checks['historyPixels']),'historyPixelDifferences':[p for p in checks['historyPixels'] if p['changedPixels'] != 0],'stackPixelDifferences':[p for p in checks['stackPixels'] if p['changedPixels'] != 0]},indent=2))
