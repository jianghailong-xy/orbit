"""Run Playwright probes in chunks, keep each raw run in /var/tmp and a slim copy here.

usage: run-chunks.py <config> <prefix> [--project <name>[,<name>...]] [--env KEY=VALUE ...] <name>=<grep> [<name>=<grep> ...]

Each chunk runs `node node_modules/@playwright/test/cli.js test --config <config> --project <projects> --grep <grep>`
from the repository root, in its own network namespace (only lo up) at nice -10, with its results in
/var/tmp/kw2-246921c8/runs/<prefix>-<name> (the raw run: report.json with attachment bodies, traces of failures).
When it ends:
- environment.json (written by the unchanged globalSetup) is copied into the raw run;
- <prefix>-<name>/ here gets report.summary.json (every test's title, project, status, duration, retry, error
  messages and attachment names with the SHA-256 of each body, no bodies), environment.json and, for the
  keyboard-window-2 probe, samples.csv (one line per sample, see slim.py);
- checks/<prefix>-<name>.txt is the run's output and checks/<prefix>-<name>.json its command, commit, Web tree,
  times, exit code and load.
A chunk whose directory already exists is skipped, so the same command resumes after an interruption."""
import datetime
import hashlib
import json
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
RAW = Path('/var/tmp/kw2-246921c8/runs')
sys.path.insert(0, str(HERE))
from slim import slim_run  # noqa: E402

args = sys.argv[1:]
config, prefix, *rest = args
projects, env, chunks = 'chromium-dark-desktop', {}, []
while rest:
    item = rest.pop(0)
    if item == '--project':
        projects = rest.pop(0)
    elif item == '--env':
        key, value = rest.pop(0).split('=', 1)
        env[key] = value
    else:
        chunks.append(item)
now = lambda: datetime.datetime.now(datetime.timezone.utc).isoformat()
git = lambda *a: subprocess.run(['git', '-C', str(ROOT), *a], capture_output=True, text=True, check=True).stdout.strip()
for chunk in chunks:
    name, grep = chunk.split('=', 1)
    study = f'{prefix}-{name}'
    if (HERE / study).exists():
        print(study, 'already archived; skipped', flush=True)
        continue
    raw = RAW / study
    if raw.exists():
        raw.rename(raw.with_name(f'{study}-interrupted-{datetime.datetime.now():%H%M%S}'))
    project_args = ' '.join(f'--project {shlex.quote(p)}' for p in projects.split(','))
    inner = (f'ip link set lo up && NO_COLOR=1 nice -n -10 node node_modules/@playwright/test/cli.js test --config {config} '
             f'{project_args}' + (f' --grep {shlex.quote(grep)}' if grep else ''))
    command = ['unshare', '-n', 'bash', '-c', inner]
    started, load = now(), os.getloadavg()
    run = subprocess.run(command, cwd=ROOT, capture_output=True, env={**os.environ, **env, 'KW2_RESULTS': str(raw)})
    output = run.stdout + run.stderr
    ended, load_end = now(), os.getloadavg()
    shutil.copyfile(ROOT / 'src/web/.ui-migration-results/environment.json', raw / 'environment.json')
    (raw / 'output.txt').write_bytes(output)
    partial = HERE / f'{study}.partial'
    if partial.exists():
        shutil.rmtree(partial)
    stats = slim_run(raw, partial)
    (HERE / 'checks').mkdir(exist_ok=True)
    (HERE / 'checks' / f'{study}.txt').write_bytes(output)
    record = {'command': shlex.join(command), 'env': env, 'cwd': str(ROOT), 'runner': 'run-chunks.py (inside one mcp__orbit__bg_run job)',
              'commit': git('rev-parse', 'HEAD'), 'webTree': git('rev-parse', 'HEAD:src/web'),
              'dirtyWeb': git('status', '--porcelain', '--', 'src/web'), 'startedAt': started, 'endedAt': ended,
              'loadAverage': {'start': load, 'end': load_end}, 'exitCode': run.returncode,
              'outputSha256': hashlib.sha256(output).hexdigest(), 'outputBytes': len(output), 'raw': str(raw), 'stats': stats}
    partial.rename(HERE / study)
    (HERE / 'checks' / f'{study}.json').write_text(json.dumps(record, indent=1, ensure_ascii=False) + '\n')
    print(study, 'exit', run.returncode, json.dumps(stats), flush=True)
