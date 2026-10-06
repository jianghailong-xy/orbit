"""Check that no index.css rule the absorbed upstream changed can match the Orbit ui components, the choices/toasts
fixtures or ToastViewport: every class in a changed selector must either be absent from those sources, or the rule
must be scoped under another class that is absent from them."""
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[5]
MERGES = [('45bb56928225bbe6d00800180ebcc73f26250fd4', '38947755e48ac979362db36f82bfcf966b527a75'),
          ('38947755e48ac979362db36f82bfcf966b527a75', '8a29e349324e7aaca83827a52148b540c118b992')]


def blob(ref, path):
    return subprocess.check_output(['git', 'show', f'{ref}:{path}'], cwd=ROOT, text=True, errors='ignore')


def sources(ref):
    paths = subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', ref, '--', 'src/web/src/components/ui',
                                     'src/web/src/components/ToastViewport.tsx', 'src/web/ui-migration'],
                                    cwd=ROOT, text=True).split()
    return '\n'.join(blob(ref, p) for p in paths if p.endswith(('.tsx', '.ts', '.css')) and 'reviews' not in p)


report = []
for before, after in MERGES:
    text = sources(after)
    used = lambda token: re.search(r'(?<![\w-])' + re.escape(token) + r'(?![\w-])', text) is not None
    diff = subprocess.check_output(['git', 'diff', '-U0', before, after, '--', 'src/web/src/index.css'], cwd=ROOT, text=True)
    selectors = sorted({line[1:].split('{')[0].strip() for line in diff.splitlines()
                        if line[:1] in '+-' and not line.startswith(('+++', '---')) and '{' in line})
    reachable = []
    for selector in selectors:
        for part in selector.split(','):
            tokens = re.findall(r'\.([A-Za-z_][\w-]*)', part)
            if tokens and all(used(t) for t in tokens):
                reachable.append(part.strip())
    report.append({'before': before, 'after': after, 'changedSelectors': len(selectors),
                   'selectorsWhoseEveryClassAppearsInThoseSources': reachable})
    assert reachable == [], reachable
(Path(__file__).resolve().parent / 'css-scope-audit.json').write_text(json.dumps(report, indent=1) + '\n')
print(json.dumps(report, indent=1))
