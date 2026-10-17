#!/usr/bin/env bash
# analyze-p52.sh RUN: the P5.2 pair of a formal round (formal.sh / formal-p52.sh RUN), written to v1/compare-RUN and
# v1/sheets-RUN: screenshots, computed styles and traces (compare_runs.py, summarize.py, beyond-clusters.py), the traces
# field by field (trace-semantics.py) and the side-by-side sheets (sheets.py). Only reads the runs.
set -u
RUN=${1:?run name}
V=/mnt/data/tmp/34Za39Mm04q5p66pqUTtj/v1
R=$V/$RUN
C=$V/compare-$RUN
S=$V/sheets-$RUN
E=/root/.orbit/worktrees/6d689aae-2d33-526f-af1f-826adf954c6d/docs/evidence/base-ui-migration
mkdir -p "$C"
python3 -I "$E/p3.2/compare_runs.py" "$R/p52-ref-shots" "$R/p52-del-shots" "$R/p52-ref-out/report.json" "$R/p52-del-out/report.json" "$C/p52-compare.json"
python3 -I "$E/p4.1/summarize.py" "$C/p52-compare.json" > "$C/p52-summary.json"
python3 -I "$E/p4.2/scripts/beyond-clusters.py" "$C/p52-summary.json" "$R/p52-ref-shots" "$R/p52-del-shots" > "$C/p52-beyond-clusters.txt"
python3 -I "$E/p5.2/scripts/trace-semantics.py" "$R/p52-ref-out/report.json" "$R/p52-del-out/report.json" > "$C/p52-trace-semantics.json"
echo "trace-semantics exit $?"
rm -rf "$S"
python3 -I "$E/p5.2/scripts/sheets.py" "$R/p52-ref-shots" "$R/p52-del-shots" "$S/key" p52-turn-1 p52-reply-pictures p52-viewer p52-single p52-composer-chip p52-shared-viewer
beyond=$(python3 -I -c "import json,sys; print(' '.join(sorted({b['shot'].split('/')[1][:-4] for b in json.load(open(sys.argv[1]))['beyond']})))" "$C/p52-summary.json")
python3 -I "$E/p5.2/scripts/sheets.py" "$R/p52-ref-shots" "$R/p52-del-shots" "$S/all" $beyond p52-motion-zoomed p52-motion-turned
python3 -I - "$C/p52-summary.json" "$S" <<'PY'
import json, os, shutil, sys
summary, sheets = sys.argv[1:3]
keep = {b['shot'] for b in json.load(open(summary))['beyond']}
for env in os.listdir(f'{sheets}/all'):
    for name in os.listdir(f'{sheets}/all/{env}'):
        motion = name.startswith('p52-motion-') and env.startswith('chromium')
        if f'{env}/{name}' in keep or motion:
            os.makedirs(f'{sheets}/beyond/{env}', exist_ok=True)
            shutil.copy(f'{sheets}/all/{env}/{name}', f'{sheets}/beyond/{env}/{name}')
shutil.rmtree(f'{sheets}/all')
PY
python3 -I - "$C" <<'PY'
import json, sys
from collections import Counter
c = sys.argv[1]
s = json.load(open(f'{c}/p52-summary.json'))
print('screenshots', json.dumps(s['screenshots']), 'tests', s['tests']['total'], 'not passed', s['tests']['notPassedRef'], s['tests']['notPassedDel'])
print('style deltas', sorted(s['styleDeltas']))
print('beyond by shot', dict(Counter(b['shot'].split('/')[1] for b in s['beyond'])))
d = json.load(open(f'{c}/p52-trace-semantics.json'))
print('steps', d['steps'], 'semantic differences', len(d['semantic']), 'missing', d['missing'])
print('semantic by step', dict(Counter(x.get('step') for x in d['semantic'])))
print('antd census', {k: (v['tests'], v['steps']) for k, v in d['antd'].items()}, 'viewer names differing', d['presentation']['viewerName']['differing'])
PY
