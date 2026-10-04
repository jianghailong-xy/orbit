"""Prepare original production code with this revision's fixed animation capture."""
import pathlib, shutil, subprocess, sys
here = pathlib.Path(__file__).resolve().parent
root = here.parents[4]
dest = pathlib.Path(sys.argv[1]).resolve()
subprocess.run([sys.executable, str(here.parent/'prepare-reference.py'), str(dest)], check=True)
tests = root/'src/web/ui-migration/toasts-lifecycle.browser.mjs'
# The task-start notification is painted but excluded from the modal AX tree.
# Only this pixel/motion reference uses the owned DOM locator. All current-code
# accessibility and keyboard assertions continue to use the accessible region.
text = tests.read_text().replace("page.getByRole('region', { name: 'Notifications', exact: true })", "page.locator('.toast-viewport')")
web = dest/'src/web/ui-migration'
shutil.copy2(root/'src/web/src/components/ui/__fixtures__/ToastsFixture.tsx', dest/'src/web/src/components/ui/__fixtures__/ToastsFixture.tsx')
(web/'reference-lifecycle.browser.mjs').write_text(text)
config = (web/'reference.config.mjs').read_text().replace('reference.browser.mjs', 'reference-lifecycle.browser.mjs').replace('.toasts-results', '.lifecycle-results').replace('4178', '14380')
(web/'reference-lifecycle.config.mjs').write_text(config)
print(dest)
