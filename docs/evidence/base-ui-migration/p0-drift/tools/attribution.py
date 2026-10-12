#!/usr/bin/env python3
"""Builds the attribution table from the recorded runs and re-verifies every claim:
for each change, the run on the attributed commit's predecessor shows no change of the group's
screenshots from the range start, the attributed commit changes all of them, and the range end
renders like the attributed commit. Writes attribution.json; prints a summary."""
import json, subprocess, sys
B = '/var/tmp/p0drift'
REPO = '/root/.orbit/worktrees/e65f238b-4789-5587-b24a-cf2d708322d1'
git = lambda *a: subprocess.check_output(['git', '-C', REPO, *a], text=True).strip()
full = lambda r: git('rev-parse', r)
subj = lambda r: git('log', '-1', '--format=%s', r)
def pairdiff(a, b, only):
    return set(json.loads(subprocess.check_output(['node', f'{B}/scripts/pairdiff.cjs', a, b, only], text=True)))
tip = json.load(open(f'{B}/cp-project-line.json'))
def project_line_changes(at):
    out = set()
    for rel, steps in tip['screenshots'].items():
        for s in steps:
            if s.get('kind') == 'change' and s['at'] == at:
                out.add(rel)
    return out

CHANGES = json.load(open(sys.argv[1]))
rows = []
for c in CHANGES:
    expected = project_line_changes(c['projectLine']['run'])
    group = {rel for rel in expected if any(__import__('re').search(p, rel) for p in c['screenshotPatterns'])}
    checks = []
    for step in c['steps']:
        only = step['only']
        before = pairdiff(step['rangeStart'], step['before'], only)
        changed = pairdiff(step['before'], step['at'], only)
        after = pairdiff(step['at'], step['rangeEnd'], only)
        scope = {rel for rel in group if __import__('re').search(only, rel)}
        checks.append({'line': step['line'], 'rangeStart': step['rangeStart'], 'before': step['before'], 'at': step['at'], 'rangeEnd': step['rangeEnd'],
                       'only': only, 'unchangedBefore': not (before & scope), 'changedAt': sorted(changed & scope),
                       'missingAt': sorted(scope - changed), 'unchangedAfter': not (after & scope)})
    commits = [{'role': k, 'commit': full(v), 'subject': subj(v)} for k, v in c['commits']]
    rows.append({'id': c['id'], 'class': c['class'], 'screenshots': sorted(group), 'count': len(group),
                 'projectLine': {'commit': full(c['projectLine']['commit']), 'subject': subj(c['projectLine']['commit']), 'run': c['projectLine']['run']},
                 'commits': commits, 'description': c['description'], 'checks': checks})
    ok = all(ch['unchangedBefore'] and not ch['missingAt'] and ch['unchangedAfter'] for ch in checks)
    print(f"{c['id']}: {c['class']} {len(group)} screenshots, checks {'OK' if ok else 'FAILED'}: " + '; '.join(f"{ch['before']}->{ch['at']} changed {len(ch['changedAt'])}" + (f" MISSING {len(ch['missingAt'])}" if ch['missingAt'] else '') for ch in checks))
json.dump(rows, open(f'{B}/attribution.json', 'w'), indent=1)
