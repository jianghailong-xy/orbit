"""Archive one finished runner-hosted (bg_run) job as checks/<name>.json/.txt; never overwrites.

Usage: python3 record-check.py <name> <jobId> <exitCode> <commit> '<command>' [note]
The exit code is the one the runner's own wait() reported through bg_output; the .txt file is the
job's original output file, byte for byte (ANSI colour codes included)."""
import datetime
import hashlib
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
RUNS = Path('/root/.orbit/runs') / ROOT.name
name, job, code, commit, command, *note = sys.argv[1:]
output = RUNS / f'{job}.output'
checks = HERE / 'checks'
checks.mkdir(exist_ok=True)
txt, record = checks / f'{name}.txt', checks / f'{name}.json'
if txt.exists() or record.exists():
    raise SystemExit(f'{name} is already recorded; pick a new name.')
data = output.read_bytes()
txt.write_bytes(data)
web_tree = subprocess.run(['git', 'rev-parse', f'{commit}:src/web'], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
entry = {'command': command, 'runner': 'mcp__orbit__bg_run', 'bgJobId': job, 'cwd': str(ROOT), 'commit': commit, 'webTree': web_tree,
         'outputLastWritten': datetime.datetime.fromtimestamp(output.stat().st_mtime, datetime.timezone.utc).isoformat(),
         'exitCode': None if code == 'null' else int(code), 'outputSha256': hashlib.sha256(data).hexdigest(), 'outputBytes': len(data)}
if note:
    entry['note'] = note[0]
record.write_text(json.dumps(entry, indent=1, ensure_ascii=False) + '\n')
print(json.dumps(entry, ensure_ascii=False))
