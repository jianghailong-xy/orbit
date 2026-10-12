"""Prepare task-start production sources with identical stationary-hover tests."""
import pathlib, shutil, subprocess, sys
here = pathlib.Path(__file__).resolve().parent
root = here.parents[4]
dest = pathlib.Path(sys.argv[1]).resolve()
subprocess.run([sys.executable, str(here.parent/'revision-2/prepare-reference.py'), str(dest)], check=True)
ui = dest/'src/web/ui-migration'
shutil.copy2(root/'src/web/ui-migration/toasts-hover.browser.mjs', ui/'reference-hover.browser.mjs')
config = (ui/'reference-lifecycle.config.mjs').read_text().replace('reference-lifecycle.browser.mjs', 'reference-hover.browser.mjs').replace('.lifecycle-results', '.hover-results')
(ui/'reference-hover.config.mjs').write_text(config)
print(dest)
