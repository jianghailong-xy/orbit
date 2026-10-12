"""Prepare a fresh copy of the task's original source with isolated Vite caches."""
import io, pathlib, shutil, subprocess, sys, tarfile
root = pathlib.Path(__file__).resolve().parents[4]
evidence = pathlib.Path(__file__).resolve().parent
baseline = '67e62c0b4028eefe2c619dac80d3fac312cea601'
dest = pathlib.Path(sys.argv[1]).resolve()
assert not dest.exists(), 'Use a new directory; existing evidence is never overwritten'
assert (root/'package-lock.json').read_bytes() == subprocess.check_output(['git','show',baseline+':package-lock.json'],cwd=root), 'Prepare dependencies matching the recorded lockfile first'
dest.mkdir()
data = subprocess.check_output(['git','archive',baseline,'src/web','src/shared','package.json','package-lock.json','tsconfig.base.json'],cwd=root)
with tarfile.open(fileobj=io.BytesIO(data)) as archive: archive.extractall(dest,filter='data')
(dest/'node_modules').symlink_to(root/'node_modules',target_is_directory=True)
web = dest/'src/web'
nm = web/'node_modules'; nm.mkdir()
for p in (root/'src/web/node_modules').iterdir():
    if p.name in ['.vite','.vite-temp','@orbit']: continue
    (nm/p.name).symlink_to(p.resolve(),target_is_directory=p.is_dir())
(nm/'@orbit').mkdir(); (nm/'@orbit/shared').symlink_to(dest/'src/shared',target_is_directory=True)
for name in ['toasts.html','toasts.tsx','feedback-production.browser.mjs']:
    shutil.copy2(root/'src/web/ui-migration'/name, web/'ui-migration'/name)
for name in ['reference.browser.mjs','reference.config.mjs','production-reference.config.mjs']:
    shutil.copy2(evidence/name,web/'ui-migration'/name)
shutil.copy2(evidence/'reference-fixture.tsx',web/'src/components/ui/__fixtures__/ToastsFixture.tsx')
env = dest/'docs/evidence/base-ui-migration/p0.2'; env.mkdir(parents=True)
shutil.copy2(root/'docs/evidence/base-ui-migration/p0.2/environment.json',env/'environment.json')
subprocess.run(['npm','--prefix',str(dest/'src/shared'),'run','build'],check=True,cwd=root)
print(dest)
