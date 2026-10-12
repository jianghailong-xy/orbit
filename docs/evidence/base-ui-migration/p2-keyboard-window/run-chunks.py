"""Run a Chromium probe in chunks that survive a runner drain.

usage: run-chunks.py <tree> <config> <results> <prefix> <name>=<grep> [<name>=<grep> ...]

Each chunk runs `node node_modules/@playwright/test/cli.js test --config <config> --project chromium-dark-desktop
--grep <grep>` in <tree>, in its own network namespace at nice -10, and is archived as soon as it ends:
- the run's environment.json is copied next to its report, and src/web/ui-migration/collect-choice-evidence.mjs
  (unchanged) writes it to <prefix>-<name> in this directory (--diagnostic when a test failed), first as
  <prefix>-<name>.partial, renamed only when complete;
- its output goes to checks/<prefix>-<name>.txt, and its command, tree, commit, Web tree, times and exit code to
  checks/<prefix>-<name>.json.
A chunk whose directory already exists is skipped, so after a drain the same command resumes with the next chunk.
Playwright writes its JSON report only when a run ends; this is why a drained single run loses every sample."""
import datetime
import hashlib
import json
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
tree, config, results, prefix, *chunks = sys.argv[1:]
tree = Path(tree)
now = lambda: datetime.datetime.now(datetime.timezone.utc).isoformat()
git = lambda *args: subprocess.run(['git', '-C', str(tree), *args], capture_output=True, text=True, check=True).stdout.strip()
for chunk in chunks:
    name, grep = chunk.split('=', 1)
    study = f'{prefix}-{name}'
    if (HERE / study).exists():
        print(study, 'already archived; skipped', flush=True)
        continue
    for leftover in (HERE / 'checks' / f'{study}.json', HERE / 'checks' / f'{study}.txt'):
        if leftover.exists():  # a drain hit this chunk after its record began: keep that output, run it again
            leftover.rename(leftover.with_name(f'{leftover.stem}-drained-{datetime.datetime.now():%H%M%S}{leftover.suffix}'))
    inner = (f'ip link set lo up && NO_COLOR=1 nice -n -10 node node_modules/@playwright/test/cli.js test --config {config} '
             f'--project chromium-dark-desktop --grep {shlex.quote(grep)}')
    command = ['unshare', '-n', 'bash', '-c', inner]
    started = now()
    run = subprocess.run(command, cwd=tree, capture_output=True)
    output = run.stdout + run.stderr
    (HERE / 'checks' / f'{study}.txt').write_bytes(output)
    out = tree / results
    shutil.copyfile(tree / 'src/web/.ui-migration-results/environment.json', out / 'environment.json')
    partial = HERE / f'{study}.partial'
    if partial.exists():
        shutil.rmtree(partial)
    collect = ['node', str(ROOT / 'src/web/ui-migration/collect-choice-evidence.mjs'), str(partial), f'--from={out}']
    archived = subprocess.run(collect + (['--diagnostic'] if run.returncode else []), capture_output=True, text=True)
    if archived.returncode:
        raise SystemExit(f'{study}: archiving failed: {archived.stderr}')
    record = {'command': shlex.join(command), 'cwd': str(tree), 'runner': 'run-chunks.py (inside one mcp__orbit__bg_run job)',
              'commit': git('rev-parse', 'HEAD'), 'webTree': git('rev-parse', 'HEAD:src/web'), 'startedAt': started, 'endedAt': now(),
              'exitCode': run.returncode, 'outputSha256': hashlib.sha256(output).hexdigest(), 'outputBytes': len(output),
              'archive': archived.stdout.strip().replace(f'{study}.partial', study)}
    partial.rename(HERE / study)
    (HERE / 'checks' / f'{study}.json').write_text(json.dumps(record, indent=1, ensure_ascii=False) + '\n')
    print(study, 'exit', run.returncode, record['archive'][:200], flush=True)
