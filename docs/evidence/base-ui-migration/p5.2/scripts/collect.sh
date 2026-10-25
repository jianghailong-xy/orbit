#!/usr/bin/env bash
# collect.sh [P5.2 ROUND] [P0 ROUND] [CHECK ROUND]: copy what p5.2/README.md cites from the runs on /mnt/data/tmp/34Za39Mm04q5p66pqUTtj/v1 into p5.2/
# (P4.4's collect.sh, for P5.2):
#  - the formal round's logs (terminal colour codes removed; argv, tree, HEAD, load, disk and exit at the top and bottom
#    of each): the P5.2 pair and the P0 steps of the rounds named (f5 by default); the Playwright reports read here, with attachment bodies removed
#    (p0-drift-3/tools/report-summary.py), and the standard P0 runs' expectations;
#  - the comparisons (compare_runs.py, summarize.py, beyond-clusters.py, trace-semantics.py) and both trees' P5.2 traces;
#  - sheets (sheets.py): reference | delivery | difference map, at half size: six key states in all eight environments, and
#    every beyond-level pair with the motion case's zoom and turn beside the Chromium ones;
#  - the standard P0 runs' failures compared between delivery and base, the merge check and the OrbitKit run (summaries);
#  - the probes of the replaced and the Orbit viewer, and the scripts as run.
# Raw runs stay on /mnt/data until judged.
set -eu
T=/mnt/data/tmp/34Za39Mm04q5p66pqUTtj
V=$T/v1
P52=${1:-f5}   # the round whose P5.2 pair is cited
P0=${2:-f5}    # the round whose P0 steps are cited
CHECK=${3:-$P0}  # the round after which the merge check and the OrbitKit run were made (merge-check-ROUND.log, swift-ROUND.log)
# The trees move between rounds, so each round's commits are read from its own step logs (the `head:` line), not the trees.
at() { sed -n 's/^head: //p' "$1" | cut -c1-9; }
E=/root/.orbit/worktrees/6d689aae-2d33-526f-af1f-826adf954c6d/docs/evidence/base-ui-migration/p5.2
SUMMARY="python3 -I $E/../p0-drift-3/tools/report-summary.py"
for d in runs compare traces sheets probe; do rm -rf "${E:?}/$d"; mkdir -p "$E/$d"; done
mkdir -p "$E/checks" "$E/scripts"
log() { sed 's/\x1b\[[0-9;]*m//g' "$1" > "$2"; }
for n in p52-ref p52-del; do log "$V/$P52/$n.txt" "$E/runs/$n.txt"; $SUMMARY "$V/$P52/$n-out/report.json" "$E/runs/$n.report.summary.json" > /dev/null; done
for n in p0-ref p0-strict p0-del p0-standard p0-standard-base; do log "$V/$P0/$n.txt" "$E/runs/$n.txt"; done
for n in p0-strict p0-standard p0-standard-base; do $SUMMARY "$V/$P0/$n-out/report.json" "$E/runs/$n.report.summary.json" > /dev/null; done
for n in p0-standard p0-standard-base; do cp "$V/$P0/$n-out/expected-screenshots/sources.json" "$E/runs/$n.expected-sources.json"; done
for r in $(printf "%s\n" "$P52" "$P0" | sort -u); do log "$V/formal-$r.log" "$E/runs/formal-$r.log"; done
cp "$V/compare-$P52/p52-compare.json" "$V/compare-$P52/p52-summary.json" "$V/compare-$P52/p52-beyond-clusters.txt" "$V/compare-$P52/p52-trace-semantics.json" "$E/compare/"
cp "$V/compare-$P0/p0-compare.json" "$V/compare-$P0/p0-summary.json" "$E/compare/"
python3 -I "$E/../p4.1/extract-traces.py" "$V/$P52/p52-ref-out/report.json" "$E/traces/p52-ref.json" > /dev/null
python3 -I "$E/../p4.1/extract-traces.py" "$V/$P52/p52-del-out/report.json" "$E/traces/p52-del.json" > /dev/null
cp -r "$V/sheets-$P52/key" "$V/sheets-$P52/beyond" "$E/sheets/"
cp "$T/probe/probe1-chromium-light.txt" "$E/probe/reference-thumbnails.txt"
cp "$T/probe/probe2-chromium-light.txt" "$E/probe/reference-viewer.txt"
cp "$T/probe/probe2-del-chromium-light.txt" "$E/probe/delivery-viewer-first-draft.txt"
for f in dev-run.sh dev-compare.sh make-trees.sh formal.sh formal-p52.sh analyze.sh analyze-p52.sh collect.sh owners-list.mjs css-owners.mjs tail-probe.mjs probe1.mjs probe2.mjs probe3.mjs; do cp "$T/scripts/$f" "$E/scripts/"; done
# The standard P0 failures, delivery against base.
python3 -I - "$V/$P0" "$(at "$V/$P0/p0-standard.txt")" "$(at "$V/$P0/p0-standard-base.txt")" > "$E/checks/p0-standard-compare.txt" <<'PY'
import glob, hashlib, json, os, re, sys
root, delivery, base = sys.argv[1:4]
def fails(path):
    out = {}
    def walk(s, prefix):
        for c in s.get('suites', []): walk(c, prefix + [c['title']])
        for sp in s.get('specs', []):
            for t in sp['tests']:
                res = t['results'][-1] if t['results'] else {}
                if res.get('status') in ('passed', 'skipped', None): continue
                msg = (res.get('errors') or [{}])[0].get('message', '') or ''
                out[f"{t['projectName']} :: {' › '.join(prefix[1:] + [sp['title']])}"] = re.sub(r'\x1b\[[0-9;]*m', '', msg).strip().splitlines()[0][:120] if msg else ''
    for s in json.load(open(path))['suites']: walk(s, [s['title']])
    return out
def shots(d):
    return {os.path.relpath(p, d): hashlib.sha256(open(p, 'rb').read()).hexdigest() for p in glob.glob(f'{d}/**/*-actual.png', recursive=True)}
d, b = fails(f'{root}/p0-standard-out/report.json'), fails(f'{root}/p0-standard-base-out/report.json')
print('# Standard P0 (ui-migration/playwright.config.mjs, expected screenshots = P0.2 originals + registered layers) on the delivery')
print(f'# {delivery} and on the base {base} (the project tip synced with the same main, without P5.2), round {os.path.basename(root)}.')
print(f'failing tests: delivery {len(d)}, base {len(b)}; the same set: {set(d) == set(b)}; the same first error line: {sum(1 for k in d if b.get(k) == d[k])} of {len(d)}')
ds, bs = shots(f'{root}/p0-standard-out'), shots(f'{root}/p0-standard-base-out')
same = sorted(k for k in ds if bs.get(k) == ds[k])
print(f'failing screenshots (actual): delivery {len(ds)}, base {len(bs)}; byte-identical {len(same)} of {len(ds)}')
for k in sorted(ds):
    if bs.get(k) != ds[k]: print('  not identical:', k)
print()
for k in sorted(d): print(k, '|', d[k])
PY
# The merge check and the OrbitKit run made after round CHECK, on the commit that round's delivery ran (the job that ran
# them printed the worktree's HEAD before each); their summary lines, the full logs stay on /mnt/data.
head=$(at "$V/$CHECK/p0-standard.txt")
{ echo "# npm run build -w @orbit/web && npm run test -w @orbit/web on the task worktree (NVMe) at $head, after round $CHECK."
  echo "# Build output and the Vitest summary; the full log stays at $V/merge-check-$CHECK.log until judged."; echo
  sed 's/\x1b\[[0-9;]*m//g' "$V/merge-check-$CHECK.log" | grep -E "^> |vite v|built in|error TS|modules transformed|Test Files|Tests |Duration|FAIL|cannot contain"; } > "$E/checks/merge-check.txt"
{ echo "# docker run --rm --memory=4g --memory-swap=6g --oom-score-adj=1000 -v \$PWD:/repo -w /repo/src/macos/OrbitKit swift:6.1 swift test -j 4"
  echo "# on the task worktree at $head, after round $CHECK. The suite's summary line:"; echo
  grep -E "Executed [0-9]+ tests" "$V/swift-$CHECK.log" | tail -1; grep -cE "error:|failed \(" "$V/swift-$CHECK.log" | sed 's/^/error or failed lines: /'; } > "$E/checks/swift.txt"
echo "collected: $(du -sh "$E" | cut -f1)"
