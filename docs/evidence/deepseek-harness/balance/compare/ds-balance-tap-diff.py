"""Compare the TAP files two run-pg-spec.sh log dirs hold, spec by spec: how many results each has and which
tests are `not ok` in both, only in the first, or only in the second. Ends SAME FAILURES or DIFFERENT FAILURES."""
import re
import sys
from pathlib import Path

RESULT = re.compile(r'^\s*(not ok|ok) \d+ - (.*?)(?: # .*)?$')


def results(path):
    out = []
    for line in path.read_text(errors='replace').splitlines():
        m = RESULT.match(line)
        if m:
            out.append((m.group(1) == 'ok', m.group(2).strip()))
    return out


a_dir, b_dir = Path(sys.argv[1]), Path(sys.argv[2])
same = True
for name in sorted({p.name for p in a_dir.glob('*.tap')} | {p.name for p in b_dir.glob('*.tap')}):
    a_file, b_file = a_dir / name, b_dir / name
    if not (a_file.exists() and b_file.exists()):
        same = False
        print(f'== {name}: only in {a_dir.name if a_file.exists() else b_dir.name}')
        continue
    a, b = results(a_file), results(b_file)
    a_fail = {n for ok, n in a if not ok}
    b_fail = {n for ok, n in b if not ok}
    print(f'== {name}: {len(a)} results in {a_dir.name}, {len(b)} in {b_dir.name}; '
          f'failing {len(a_fail)} vs {len(b_fail)}')
    for n in sorted(a_fail & b_fail):
        print(f'   not ok in both: {n}')
    for n in sorted(a_fail - b_fail):
        print(f'   not ok only in {a_dir.name}: {n}')
    for n in sorted(b_fail - a_fail):
        print(f'   not ok only in {b_dir.name}: {n}')
    if a_fail != b_fail or len(a) != len(b):
        same = False
print('SAME FAILURES' if same else 'DIFFERENT FAILURES')
