#!/usr/bin/env python3
"""Every assertion the fixture commit took out of src/web/ui-migration, each placed in the test it was in and classed.

usage: removed-assertions.py COMMIT > removed-assertions.json   (run from the repository root)

An assertion line holds expect( / expect.soft( / expect.poll(. Each removed one is:
- kept: the same check is still there, in the commit's added lines, once the message's ${system} / ${impl}
  prefix, the per-system selector or loop variable and a one-line for loop it moved into are set aside (the
  AntD branch of it is what went), or under the new name RENAMED gives it;
- coexistence: it was in a test that exercised the legacy components inside or around Orbit's (deleted whole);
- comparison: it compared the Orbit side with the AntD side (or with a value read from the AntD side);
- unexplained: none of these. The script exits 1 if any is.
"""
import json
import re
import subprocess
import sys

commit = sys.argv[1]
ASSERT = re.compile(r'\bexpect(?:\.soft|\.poll)?\s*\(')
COEXISTENCE = ['actual legacy modal, Popconfirm and Select work inside Orbit', 'work inside a legacy',
               'legacy host final Tab matches the AntD-only baseline', 'legacy AntApp confirmation still works',
               'body and nested portals inherit theme and preserve focus ownership', "legacy ? 'legacy Modal' : 'Dialog'"]
COMPARISON = re.compile(r"\bantd\b|\bant\b|AntD|\.ant-|legacy|reference|runs\.ant\b|'ant'|antTextareas|toEqual\(expected\)|"
                        r"samples\.orbit\[phase\]\.map|result\[capture\]|found\b|differences")

# The same check under a new name: the loop over both libraries it sat in went, and its subject was renamed.
RENAMED = {'expect(orbitTextareas, `${ant.name}: no stray textarea`).toBe(1);': 'expect(state.textareas, `${name}: no stray textarea`).toBe(1);'}

def norm(line):
    line = re.sub(r'`\$\{(?:system|impl)\} ', '`', line)
    line = re.sub(r'`\$\{(?:system|impl)\}-', '`orbit-', line)
    line = line.replace('surfaces[system]', 'SUBMENU').replace('focusRoot', 'overlay').replace('focusOwner', 'dialog')
    line = line.replace("if (system === 'orbit') ", '')
    line = re.sub(r'^\s*for \(const \w+ of [^)]*\)\) ', '', line)
    line = re.sub(r'\s+', ' ', line).strip()
    return line

def show(rev, path):
    return subprocess.run(['git', 'show', f'{rev}:{path}'], capture_output=True, text=True).stdout.split('\n')

diff = subprocess.run(['git', 'show', '--format=', '--unified=0', commit, '--', 'src/web/ui-migration'],
                      capture_output=True, text=True, check=True).stdout
removed, added = [], []
path = old_lines = None
old_no = 0
for line in diff.splitlines():
    if line.startswith('--- '):
        path = line[6:] if line != '--- /dev/null' else None
        old_lines = show(f'{commit}^', path) if path else []
    elif line.startswith('+++ '):
        continue
    elif line.startswith('@@'):
        old_no = int(re.match(r'@@ -(\d+)', line).group(1))
    elif line.startswith('-'):
        if ASSERT.search(line):
            title = next((m.group(1) for l in reversed(old_lines[:old_no]) if (m := re.search(r"\btest\((`[^`]*`|'[^']*')", l))), None)
            removed.append({'file': path.split('/')[-1], 'oldLine': old_no, 'test': title, 'line': line[1:].strip()})
        old_no += 1
    elif line.startswith('+') and ASSERT.search(line):
        added.append(norm(line[1:]))
added = set(added)
for entry in removed:
    if norm(entry['line']) in added or norm(RENAMED.get(entry['line'], '')) in added:
        entry['class'] = 'kept'
    elif entry['test'] and any(c in entry['test'] or c in (entry['test'] or '') for c in COEXISTENCE) or 'legacy ? ' in (entry['test'] or ''):
        entry['class'] = 'coexistence'
    elif COMPARISON.search(entry['line']):
        entry['class'] = 'comparison'
    else:
        entry['class'] = 'unexplained'
counts = {}
for entry in removed:
    counts[entry['class']] = counts.get(entry['class'], 0) + 1
print(json.dumps({'commit': commit, 'removed': len(removed), 'counts': counts, 'assertions': removed}, indent=1, ensure_ascii=False))
if counts.get('unexplained'):
    sys.exit(1)
