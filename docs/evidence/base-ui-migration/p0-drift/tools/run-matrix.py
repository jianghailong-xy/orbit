#!/usr/bin/env python3
"""Usage: run-matrix.py <tree-short> <label> [--fill-only]

Runs the unchanged P0.2 screenshot scenarios (pages/states/breakpoints) from a fresh copy of the
runner template against the production build of /var/tmp/p0drift/trees/<tree-short>, writing all
252 screenshots into /var/tmp/p0drift/runs/<label>/snapshots. Each run gets its own network
namespace, so the preview server keeps the P0 origin http://127.0.0.1:4173 while other runs use
theirs. Tests that fail for a non-screenshot reason (the known getByText flake) are re-run alone
(at most 3 times each) into the same snapshot directory; every attempt's output is kept."""
import json, os, re, shutil, subprocess, sys, time

B = '/var/tmp/p0drift'
REPO = '/root/.orbit/worktrees/e65f238b-4789-5587-b24a-cf2d708322d1'
short, label = sys.argv[1], sys.argv[2]
# Optional Playwright selection after the label (a scene bisection); default: the whole P0 matrix.
selection = [a for a in sys.argv[3:] if a != '--fill-only'] or ['pages.browser.mjs', 'states.browser.mjs', 'breakpoints.browser.mjs']
tree = f'{B}/trees/{short}'
run = f'{B}/runs/{label}'
assert os.path.exists(f'{tree}/.p0drift-built'), f'{tree} is not built'
os.makedirs(run, exist_ok=True)
runner = f'{run}/runner'
if not os.path.exists(runner):
    shutil.copytree(f'{B}/runner-template', runner)
    os.symlink(f'{REPO}/node_modules', f'{runner}/node_modules')

def playwright(output, extra):
    env = {k: v for k, v in os.environ.items() if k not in ('FORCE_COLOR', 'PUBLIC_ORIGIN')}
    env.update(NO_COLOR='1', DRIFT_SNAPSHOTS=f'{run}/snapshots', DRIFT_OUTPUT=output, DRIFT_APP=f'{tree}/src/web')
    argv = ['node', 'node_modules/@playwright/test/cli.js', 'test', '--config', 'src/web/ui-migration/drift.config.mjs',
            '--update-snapshots=all', *extra]
    inner = 'ip link set lo up && exec "$@"'
    started = time.time()
    with open(f'{output}.txt', 'w') as log:
        log.write(json.dumps({'argv': argv, 'tree': tree, 'commit': subprocess.check_output(['git', '-C', tree, 'rev-parse', 'HEAD'], text=True).strip(),
                              'started': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}) + '\n')
        log.flush()
        code = subprocess.call(['unshare', '-n', 'bash', '-c', inner, 'bash', *argv], cwd=runner, env=env, stdout=log, stderr=subprocess.STDOUT)
        log.write(f'\n# exit {code} after {time.time() - started:.1f}s\n')
    return code

def failures(output):
    report = json.load(open(f'{output}/report.json'))
    failed = []
    def visit(suite):
        for spec in suite.get('specs', []):
            for test in spec['tests']:
                if test['status'] == 'unexpected':
                    errors = [e.get('message', '') for r in test['results'] for e in r.get('errors', [])]
                    failed.append((test['projectName'], spec['title'], errors))
        for child in suite.get('suites', []):
            visit(child)
    for suite in report['suites']:
        visit(suite)
    return report, failed

attempt = 0
if '--fill-only' not in sys.argv:
    playwright(f'{run}/output', selection)
    report, pending = failures(f'{run}/output')
else:
    report, pending = failures(f'{run}/output')
history = [{'output': 'output', 'stats': report['stats'], 'failed': [[p, t, [e[:300] for e in errs]] for p, t, errs in pending]}]
for round_ in range(3):
    if not pending:
        break
    still = []
    for project, title, _ in pending:
        attempt += 1
        out = f'{run}/fill-{round_}-{attempt}'
        playwright(out, ['--project', project, '-g', re.escape(title) + '$', *[a for a in selection if a.endswith('.mjs')]])
        rep, failed = failures(out)
        history.append({'output': os.path.basename(out), 'project': project, 'title': title, 'stats': rep['stats'],
                        'failed': [[p, t, [e[:300] for e in errs]] for p, t, errs in failed]})
        still += failed
    pending = still
json.dump(history, open(f'{run}/attempts.json', 'w'), indent=1)
count = sum(len(files) for _, _, files in os.walk(f'{run}/snapshots'))
print(json.dumps({'label': label, 'tree': short, 'screenshots': count, 'unresolved': [[p, t] for p, t, _ in pending],
                  'attempts': [(h['output'], h['stats'].get('expected'), h['stats'].get('unexpected'), h['stats'].get('skipped')) for h in history]}))
