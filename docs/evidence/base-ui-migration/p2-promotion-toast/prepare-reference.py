"""Replay either recorded tip with the same private notification fixture."""
import hashlib, io, json, pathlib, shutil, subprocess, sys, tarfile
root = pathlib.Path(__file__).resolve().parents[4]
ref, destination = sys.argv[1:3]
dest = pathlib.Path(destination).resolve()
assert not dest.exists(), 'Use a new directory'
sha = subprocess.check_output(['git', 'rev-parse', ref], cwd=root, text=True).strip()
dest.mkdir()
paths = ['src/web', 'src/shared', 'package.json', 'package-lock.json', 'tsconfig.base.json']
data = subprocess.check_output(['git', 'archive', sha, *paths], cwd=root)
with tarfile.open(fileobj=io.BytesIO(data)) as archive: archive.extractall(dest, filter='data')
# Dependency versions shared by both tips are unchanged. Base UI is supplied
# only for the same private fixture when replaying main's notification source.
reference_lock = json.loads((dest/'package-lock.json').read_text())['packages']
current_lock = json.loads((root/'package-lock.json').read_text())['packages']
for name, package in reference_lock.items():
    if 'node_modules/' in name:
        assert package.get('version') == current_lock[name].get('version'), name
(dest/'node_modules').symlink_to(root/'node_modules', target_is_directory=True)
web = dest/'src/web'; nm = web/'node_modules'; nm.mkdir()
for p in (root/'src/web/node_modules').iterdir():
    if p.name in ['.vite', '.vite-temp', '@orbit']: continue
    (nm/p.name).symlink_to(p.resolve(), target_is_directory=p.is_dir())
(nm/'@orbit').mkdir(); (nm/'@orbit/shared').symlink_to(dest/'src/shared', target_is_directory=True)
ui = web/'ui-migration'; ui.mkdir(exist_ok=True)
# Fixture-only plumbing. The four notification production sources are checked
# byte-for-byte below and never replaced with another branch's implementation.
shutil.copytree(root/'src/web/src/components/ui', web/'src/components/ui', dirs_exist_ok=True)
for name in ['toasts.html', 'toasts.tsx', 'environment.mjs', 'fixtures.mjs', 'playwright.config.mjs']:
    shutil.copy2(root/'src/web/ui-migration'/name, ui/name)
source = (root/'src/web/ui-migration/toasts.browser.mjs').read_text()
source = source.replace("page.getByRole('region', { name: 'Notifications', exact: true })", "page.locator('.toast-viewport')")
# Keep only appearance checks here. main has no modal accessibility repair;
# final's unchanged full matrix separately checks the accessible role and Tab.
mixed = source[source.index("test('mixed pinned"):source.index("test('short and lifecycle")]
source = source[:source.index("test('mixed pinned")]
a = source.index('    const dismiss = region.getByRole')
b = source.index('\n  });\n}', a)
source = source[:a] + source[b:] + '\n' + mixed
(ui/'toasts-reference.browser.mjs').write_text(source)
shutil.copy2(root/'src/web/ui-migration/toasts-checks.mjs', ui/'toasts-checks.mjs')
config = (root/'src/web/ui-migration/toasts.config.mjs').read_text().replace('toasts*.browser.mjs', 'toasts-reference.browser.mjs').replace('14377', '14379')
(ui/'toasts-reference.config.mjs').write_text(config)
env = dest/'docs/evidence/base-ui-migration/p0.2'; env.mkdir(parents=True)
shutil.copy2(root/'docs/evidence/base-ui-migration/p0.2/environment.json', env/'environment.json')
checked = {}
for path in ['src/web/src/components/ToastViewport.tsx', 'src/web/src/index.css', 'src/web/src/lib/toast.tsx', 'src/web/src/lib/toastStore.ts', 'src/web/src/lib/toastFeed.ts']:
    original = subprocess.check_output(['git', 'show', f'{sha}:{path}'], cwd=root)
    assert original == (dest/path).read_bytes(), path
    checked[path] = hashlib.sha256(original).hexdigest()
(dest/'reference-source.json').write_text(json.dumps({'sourceCommit': sha, 'fixtureCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(), 'notificationSources': checked, 'fixtureSupplied': 'components/ui and toasts fixture; notification production sources untouched', 'lockedVersionsMatch': True}, indent=2)+'\n')
subprocess.run(['npm', '--prefix', str(dest/'src/shared'), 'run', 'build'], check=True, cwd=root)
print(dest)
