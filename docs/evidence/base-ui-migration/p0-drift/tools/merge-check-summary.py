#!/usr/bin/env python3
"""Usage: merge-check-summary.py <bg job output> <job id> <exit code> <commit> <out.json> <out.txt>

Keeps the result lines of the project merge check (tsc/vite build and the Vitest summary) as JSON, and a
filtered copy of the output: the build section whole, and the Vitest result and summary lines without the
console output that passing tests print (the complete output stays with the Orbit job)."""
import json, re, sys
src, job, code, commit, out_json, out_txt = sys.argv[1:]
text = re.sub(r'\x1b\[[0-9;]*m', '', open(src, encoding='utf-8', errors='replace').read())
lines = text.splitlines()
# The build section is kept whole; from the Vitest section only result and summary lines are kept (test
# files, nested test names, failures and the totals), not the console output tests print while passing.
result = ('✓', '×', '❯', '↓', 'FAIL', 'Error', 'RUN', 'Test Files', 'Tests ', 'Start at', 'Duration', '⎯')
kept, in_tests = [], False
for line in lines:
    if line.startswith('> vitest run'):
        in_tests = True
        kept.append(line)
        continue
    if not in_tests or line.strip().startswith(result):
        kept.append(line)
pick = lambda pattern: [l.strip() for l in lines if re.search(pattern, l)]
summary = {
    'job': job, 'command': 'npm run build -w @orbit/web && npm run test -w @orbit/web', 'exitCode': int(code), 'commit': commit,
    'build': pick(r'^> tsc -b && vite build|built in'),
    'vitest': pick(r'^\s*(Test Files|Tests|Start at|Duration)\s'),
    'failedTests': pick(r'^\s*(×|FAIL)\s'),
}
json.dump(summary, open(out_json, 'w'), indent=1, ensure_ascii=False)
open(out_txt, 'w').write('\n'.join(kept) + '\n')
print(json.dumps(summary, indent=1, ensure_ascii=False))
