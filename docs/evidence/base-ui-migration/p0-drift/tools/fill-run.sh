#!/usr/bin/env bash
# Usage: fill-run.sh <label> <rev> — re-run, alone, the tests a run left unresolved (getByText flake),
# writing into the same snapshot directory. Keeps the earlier attempts; appends to attempts.json.
set -uo pipefail
B=/var/tmp/p0drift
LABEL=$1; REV=$2
SHORT=$(git -C /root/.orbit/worktrees/e65f238b-4789-5587-b24a-cf2d708322d1 rev-parse --short=9 "$REV")
KEEP=0; [ -f "$B/trees/$SHORT/.p0drift-built" ] && KEEP=1
"$B/scripts/prepare-tree.sh" "$SHORT" > /dev/null
python3 - "$LABEL" "$SHORT" <<'PY'
import json, re, subprocess, sys
label, short = sys.argv[1:]
B = '/var/tmp/p0drift'
log = json.load(open(f'{B}/logs/run-{label}.json'))
history = json.load(open(f'{B}/runs/{label}/attempts.json'))
unresolved = log['unresolved']
n = len(history)
for project, title in unresolved:
    for k in range(6):
        out = f'fill-late-{n}'
        n += 1
        argv = ['python3', '-c', '']  # placeholder, replaced below
        env_out = f'{B}/runs/{label}/{out}'
        code = subprocess.call(['bash', '-c', f'''
cd {B}/runs/{label}/runner && env -u FORCE_COLOR -u PUBLIC_ORIGIN NO_COLOR=1 DRIFT_SNAPSHOTS={B}/runs/{label}/snapshots DRIFT_OUTPUT={env_out} DRIFT_APP={B}/trees/{short}/src/web \
 unshare -n bash -c 'ip link set lo up && exec "$@"' bash node node_modules/@playwright/test/cli.js test --config src/web/ui-migration/drift.config.mjs --update-snapshots=all --project {project} -g '{re.escape(title)}$' pages.browser.mjs states.browser.mjs breakpoints.browser.mjs > {env_out}.txt 2>&1'''])
        rep = json.load(open(f'{env_out}/report.json'))
        history.append({'output': out, 'project': project, 'title': title, 'stats': rep['stats'], 'failed': [] if rep['stats']['unexpected'] == 0 else [[project, title, ['see ' + out + '.txt']]]})
        if rep['stats']['unexpected'] == 0:
            break
json.dump(history, open(f'{B}/runs/{label}/attempts.json', 'w'), indent=1)
import glob, os
count = len(glob.glob(f'{B}/runs/{label}/snapshots/*/*.png'))
log['screenshots'] = count
log['unresolved'] = [u for u in unresolved if not any(h.get('project') == u[0] and h.get('title') == u[1] and h['stats']['unexpected'] == 0 for h in history)]
log['attempts'] = [(h['output'], h['stats'].get('expected'), h['stats'].get('unexpected'), h['stats'].get('skipped')) for h in history]
json.dump(log, open(f'{B}/logs/run-{label}.json', 'w'))
print(label, count, log['unresolved'])
PY
[ "$KEEP" = 1 ] || git -C /root/.orbit/worktrees/e65f238b-4789-5587-b24a-cf2d708322d1 worktree remove --force "$B/trees/$SHORT"
