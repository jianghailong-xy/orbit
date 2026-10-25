#!/usr/bin/env bash
# analyze.sh RUN: the comparisons of round RUN (formal.sh RUN), written to v1/compare-RUN. Only reads the runs.
#  - the P0 matrix pair, the P5.2 pair and the P5.3 attachments pair: every screenshot byte for byte (sha256), the
#    computed styles and the traces (p3.2/compare_runs.py), classed by p4.1/summarize.py;
#  - the P5.2 traces field by field (p5.2 trace-semantics.py) and the P5.3 attachments traces field by field (p5.3
#    trace-semantics.py: the composer's attachments are listed by their name, and the focus by its name);
#  - the standard P0 failures, delivery against reference;
#  - the component matrices' results (overlays, choices).
set -u
RUN=${1:?run name}
V=/mnt/data/tmp/34dTUqxH5MjymjtUhs5C5/v1
R=$V/$RUN
C=$V/compare-$RUN
E=/root/.orbit/worktrees/815e244b-5a5b-5984-96fb-3b42c31b28ff/docs/evidence/base-ui-migration
mkdir -p "$C"
pair() {
  local name=$1
  python3 -I "$E/p3.2/compare_runs.py" "$R/$name-ref-shots" "$R/$name-del-shots" "$R/$name-ref-out/report.json" "$R/$name-del-out/report.json" "$C/$name-compare.json" > /dev/null
  python3 -I "$E/p4.1/summarize.py" "$C/$name-compare.json" > "$C/$name-summary.json"
  python3 -I - "$C/$name-compare.json" "$C/$name-summary.json" "$name" "$R/$name-ref-shots" "$R/$name-del-shots" <<'PY'
import json, os, sys
compare, summary, name, ref_dir, del_dir = sys.argv[1:6]
files = lambda d: sorted(os.path.relpath(os.path.join(p, f), d) for p, _, fs in os.walk(d) for f in fs if f.endswith('.png'))
r, d = files(ref_dir), files(del_dir)
s = json.load(open(summary))
c = json.load(open(compare))
print(name, 'files ref', len(r), 'del', len(d), 'same file list', r == d, '| screenshots', json.dumps(s['screenshots']),
      '| traces differing', len([t for t in c['traces'].values() if not t['equal']]), 'of', len(c['traces']),
      '| tests', json.dumps({k: (len(v) if isinstance(v, list) else v) for k, v in s['tests'].items()}),
      '| captures with style deltas', len(s['styleDeltas']), 'of', len(c['styles']))
PY
}
pair p0
pair p52
pair p53att
python3 -I "$E/p5.2/scripts/trace-semantics.py" "$R/p52-ref-out/report.json" "$R/p52-del-out/report.json" > "$C/p52-trace-semantics.json"
echo "p52 trace-semantics exit $?"
python3 -I "$E/p5.3/scripts/trace-semantics.py" "$R/p53att-ref-out/report.json" "$R/p53att-del-out/report.json" > "$C/p53att-trace-semantics.json"
echo "p53att trace-semantics exit $?"
python3 -I - "$C/p52-trace-semantics.json" "$C/p53att-trace-semantics.json" <<'PY'
import json, sys
from collections import Counter
p52 = json.load(open(sys.argv[1]))
print('p52 traces: tests', p52['tests'], 'steps', p52['steps'], 'semantic differences', len(p52['semantic']), 'missing', len(p52['missing']),
      'viewer names differing', p52['presentation']['viewerName']['differing'])
att = json.load(open(sys.argv[2]))
print('p53att traces: tests', att['tests'], 'steps', att['steps'], 'semantic differences', len(att['semantic']), 'missing', len(att['missing']))
print('  differing fields', dict(Counter(f for s in att['semantic'] for f in s.get('fields', {}))))
values = Counter()
for s in att['semantic']:
    for field, (ref, dele) in s.get('fields', {}).items():
        values[(field, json.dumps(ref, ensure_ascii=False), json.dumps(dele, ensure_ascii=False))] += 1
for (field, ref, dele), n in sorted(values.items()):
    print(f'  {n:3d} × {field}: {ref} -> {dele}')
PY
# The standard P0 failures, delivery against reference (P5.3's comparison).
python3 -I - "$R" "$(sed -n 's/^head: //p' "$R/p0-standard.txt" | cut -c1-9)" "$(sed -n 's/^head: //p' "$R/p0-standard-base.txt" | cut -c1-9)" > "$C/p0-standard-compare.txt" <<'PY'
import json, re, sys
root, delivery, reference = sys.argv[1:4]
def fails(path):
    out = {}
    def walk(s, prefix):
        for c in s.get('suites', []): walk(c, prefix + [c['title']])
        for sp in s.get('specs', []):
            for t in sp['tests']:
                res = t['results'][-1] if t['results'] else {}
                if res.get('status') in ('passed', 'skipped', None): continue
                msg = re.sub(r'\x1b\[[0-9;]*m', '', (res.get('errors') or [{}])[0].get('message', '') or '')
                snap = re.search(r'Snapshot: (\S+)', msg)
                pixels = re.search(r'(\d+) pixels \(ratio', msg)
                out[f"{t['projectName']} :: {' › '.join(prefix[1:] + [sp['title']])}"] = f"{snap.group(1) if snap else ''} {pixels.group(1) + ' px' if pixels else ''} | {msg.strip().splitlines()[0][:100] if msg else ''}"
    for s in json.load(open(path))['suites']: walk(s, [s['title']])
    return out
d, r = fails(f'{root}/p0-standard-out/report.json'), fails(f'{root}/p0-standard-base-out/report.json')
print('# Standard P0 (ui-migration/playwright.config.mjs, expected screenshots = P0.2 originals + registered layers) on the delivery')
print(f'# {delivery} and on the reference {reference} (the delivery with the fix reverted), round {root.rsplit("/", 1)[1]}.')
print(f'failing tests: delivery {len(d)}, reference {len(r)}; same tests: {sorted(d) == sorted(r)}; same first lines: {d == r}')
print()
for k in sorted(d): print('delivery', k, '|', d[k])
for k in sorted(r): print('reference', k, '|', r[k])
PY
head -3 "$C/p0-standard-compare.txt"
# The standard P0 failures' actual screenshots, delivery against reference, byte for byte.
python3 -I - "$R/p0-standard-out" "$R/p0-standard-base-out" <<'PY'
import hashlib, os, sys
def actual(root):
    out = {}
    for p, _, fs in os.walk(root):
        for f in fs:
            if f.endswith('-actual.png'):
                out[os.path.relpath(os.path.join(p, f), root)] = hashlib.sha256(open(os.path.join(p, f), 'rb').read()).hexdigest()
    return out
d, r = actual(sys.argv[1]), actual(sys.argv[2])
print('standard P0 actual screenshots: delivery', len(d), 'reference', len(r), 'same names', sorted(d) == sorted(r),
      'byte-identical', sum(1 for k in d if r.get(k) == d[k]))
PY
for m in overlays choices; do echo "$m: $(grep -E "^\s+[0-9]+ (passed|failed|flaky|skipped|did not run)" "$R/$m.txt" | tr -s ' ' | tr '\n' ';') $(grep '^head:' "$R/$m.txt") $(grep '^exit=' "$R/$m.txt")"; done
