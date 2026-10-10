#!/usr/bin/env bash
# collect.sh [ROUND] [EMU]: copy what p5.3/README.md cites from the runs on /mnt/data/tmp/34Za39Ov1yysHZaYL6wgJ into p5.3/
# (P5.2's collect.sh, for P5.3):
#  - the formal round's logs (terminal colour codes removed; argv, tree, HEAD, load, disk and exit at the top and bottom
#    of each): the P5.3 pair and the P0 steps; the Playwright reports read here, with attachment bodies removed
#    (p0-drift-3/tools/report-summary.py), and the standard P0 runs' expectations;
#  - the comparisons (compare_runs.py, summarize.py, beyond-clusters.py, trace-semantics.py) and both trees' P5.3 traces;
#  - sheets (sheets.py): reference | delivery | difference map: eight key states in all eight environments at half size,
#    every beyond-level P5.3 pair and the P0 session pairs cut to where they differ;
#  - the standard P0 runs' failures compared between delivery and base, the merge check and the OrbitKit run (summaries);
#  - the inventory checks (audit.sh's outputs) and the WebKit race check;
#  - the emulator pass EMU (records, side-by-side sheets, its scripts) and the scripts as run.
# Raw runs stay on /mnt/data until judged.
set -eu
T=/mnt/data/tmp/34Za39Ov1yysHZaYL6wgJ
V=$T/v1
R=${1:-f1}
EMU=${2:-$T/android/run}
at() { sed -n 's/^head: //p' "$1" | cut -c1-9; }
E=/root/.orbit/worktrees/4071e471-3592-5308-a8bb-f597b81ac833/docs/evidence/base-ui-migration/p5.3
SUMMARY="python3 -I $E/../p0-drift-3/tools/report-summary.py"
for d in runs compare traces sheets probe; do rm -rf "${E:?}/$d"; mkdir -p "$E/$d"; done
mkdir -p "$E/checks" "$E/scripts" "$E/android"
log() { sed 's/\x1b\[[0-9;]*m//g' "$1" > "$2"; }
for n in p53-ref p53-del; do log "$V/$R/$n.txt" "$E/runs/$n.txt"; $SUMMARY "$V/$R/$n-out/report.json" "$E/runs/$n.report.summary.json" > /dev/null; done
for n in p0-ref p0-strict p0-del p0-standard p0-standard-base; do log "$V/$R/$n.txt" "$E/runs/$n.txt"; done
for n in p0-strict p0-standard p0-standard-base; do $SUMMARY "$V/$R/$n-out/report.json" "$E/runs/$n.report.summary.json" > /dev/null; done
for n in p0-standard p0-standard-base; do cp "$V/$R/$n-out/expected-screenshots/sources.json" "$E/runs/$n.expected-sources.json"; done
log "$V/formal-$R.log" "$E/runs/formal-$R.log"
cp "$V/compare-$R/p53-compare.json" "$V/compare-$R/p53-summary.json" "$V/compare-$R/p53-beyond-clusters.txt" "$V/compare-$R/p53-trace-semantics.json" \
   "$V/compare-$R/p0-compare.json" "$V/compare-$R/p0-summary.json" "$V/compare-$R/p0-beyond-clusters.txt" "$E/compare/"
python3 -I "$E/../p4.1/extract-traces.py" "$V/$R/p53-ref-out/report.json" "$E/traces/p53-ref.json" > /dev/null
python3 -I "$E/../p4.1/extract-traces.py" "$V/$R/p53-del-out/report.json" "$E/traces/p53-del.json" > /dev/null
cp -r "$V/sheets-$R/key" "$V/sheets-$R/beyond" "$V/sheets-$R/p0" "$E/sheets/"
# The standard P0 failures, delivery against base.
python3 -I - "$V/$R" "$(at "$V/$R/p0-standard.txt")" "$(at "$V/$R/p0-standard-base.txt")" > "$E/checks/p0-standard-compare.txt" <<'PY'
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
                msg = re.sub(r'\x1b\[[0-9;]*m', '', msg)
                snap = re.search(r'Snapshot: (\S+)', msg)
                pixels = re.search(r'(\d+) pixels \(ratio', msg)
                out[f"{t['projectName']} :: {' › '.join(prefix[1:] + [sp['title']])}"] = f"{snap.group(1) if snap else ''} {pixels.group(1) + ' px' if pixels else ''} | {msg.strip().splitlines()[0][:100] if msg else ''}"
    for s in json.load(open(path))['suites']: walk(s, [s['title']])
    return out
d, b = fails(f'{root}/p0-standard-out/report.json'), fails(f'{root}/p0-standard-base-out/report.json')
print('# Standard P0 (ui-migration/playwright.config.mjs, expected screenshots = P0.2 originals + registered layers) on the delivery')
print(f'# {delivery} and on the base {base} (origin/main, which holds the project tip; without P5.3), round {os.path.basename(root)}.')
print(f'failing tests: delivery {len(d)}, base {len(b)}')
print()
for k in sorted(d): print('delivery', k, '|', d[k])
for k in sorted(b): print('base', k, '|', b[k])
PY
# The merge check and the OrbitKit run made after the round, on the commits they print.
{ echo "# npm run build -w @orbit/web && npm run test -w @orbit/web on the task worktree (NVMe), after round $R, at the head below."
  echo "# Build output and the Vitest summary; the full log stays at $V/merge-check-$R.log until judged."; echo
  sed 's/\x1b\[[0-9;]*m//g' "$V/merge-check-$R.log" | grep -E "^head:|^mem:|^> |vite v|built in|error TS|modules transformed|Test Files|Tests |Duration|FAIL|^exit="; } > "$E/checks/merge-check.txt"
{ echo "# docker run --rm --memory=4g --memory-swap=6g --oom-score-adj=1000 -v <v1/del>:/repo -w /repo/src/macos/OrbitKit swift:6.1 swift test -j 4 --scratch-path /repo/.swift-build"
  echo "# on the delivery checkout v1/del, after round $R. The head, and the suite's summary lines:"; echo
  grep -E "^head:" "$V/swift-$R.log"; grep -E "Executed [0-9]+ tests" "$V/swift-$R.log" | tail -2; grep -cE "error:|failed \(" "$V/swift-$R.log" | sed 's/^/error or failed lines: /'; grep -E "^exit=" "$V/swift-$R.log"; } > "$E/checks/swift.txt"
# The inventory checks (scripts/audit.sh) of the delivery and the reference.
cp "$V/checks/delivery-check-owners.json" "$E/checks/"
cp "$V/inventory-closure.json" "$E/inventory-closure.json"
cp "$V/route-closure.json" "$E/checks/route-closure.json"
cp "$V/session-route-closure.json" "$V/session-route-closure-reference.json" "$E/checks/"
# The emulator pass: both trees' records, the sheets, its scripts.
cp "$EMU/ref/record.json" "$E/android/record-ref.json"; cp "$EMU/del/record.json" "$E/android/record-del.json"
rm -rf "$E/android/sheets"; python3 -I "$T/android/emu-sheets.py" "$EMU" "$E/android/sheets"
for f in emu-server.mjs emu-steps.mjs emu-pair.sh emu-final.sh emu-sheets.py mkpinch.py pinch.sh pw.sh; do cp "$T/android/$f" "$E/android/"; done
for f in dev-build.sh dev-run.sh dev-compare.sh probe-both.sh probe.mjs probes-final.sh make-trees.sh formal.sh chain.sh analyze.sh collect.sh sheets.py trace-semantics.py webkit-repeat.sh; do cp "$T/scripts/$f" "$E/scripts/"; done
# The probes the README quotes, re-taken on the formal trees (probes-final.sh), and their scenarios.
cp "$T/probe/final/"*.txt "$E/probe/"
mkdir -p "$E/scripts/probe"; cp "$T/probe/"*.mjs "$E/scripts/probe/"
echo "collected: $(du -sh "$E" | cut -f1)"
