#!/usr/bin/env python3
"""Usage: archive-run.py <run-dir> <dest> [--report] [--attachments]
Copies a run's record into the evidence tree: command output, exit code, environment, collect summary
(every test's status and artifact SHA-256), and each failed test's error-context.md. --report adds the
raw Playwright JSON report; --attachments adds every collected attachment."""
import json, pathlib, shutil, sys
run, dest = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]); flags = set(sys.argv[3:])
dest.mkdir(parents=True, exist_ok=True)
for name in ['command-output.txt', 'exit.txt', 'environment.json', 'collect.json']:
    if (run / name).exists(): shutil.copy2(run / name, dest / name)
if (run / 'collected/summary.json').exists(): shutil.copy2(run / 'collected/summary.json', dest / 'summary.json')
failures = []
for ctx in sorted((run / 'results').glob('*/error-context.md')):
    (dest / 'failures').mkdir(exist_ok=True)
    shutil.copy2(ctx, dest / 'failures' / f'{ctx.parent.name}.error-context.md')
    failures.append(ctx.parent.name)
if '--report' in flags and (run / 'results/report.json').exists(): shutil.copy2(run / 'results/report.json', dest / 'report.json')
if '--attachments' in flags and (run / 'collected').exists():
    shutil.copytree(run / 'collected', dest / 'attachments', dirs_exist_ok=True)
print(json.dumps({'dest': str(dest), 'failures': failures, 'flags': sorted(flags)}))
