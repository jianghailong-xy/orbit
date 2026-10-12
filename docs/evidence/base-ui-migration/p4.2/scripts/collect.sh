#!/usr/bin/env bash
# Copy what README.md cites from the second version's runs (/mnt/data/tmp/34Za39Feocgj42rrBYwzl/v2) into this
# directory:
#  - the fifth round (formal-v2.sh, runs/): run logs, Playwright reports with attachment bodies removed
#    (p0-drift-3/tools/report-summary.py), comparisons (analyze-v2.sh), the P4.2 traces, the cited screenshots
#    and the probe outputs;
#  - the sixth round on the merged tip (final-v2.sh, runs-final/) and its comparison with the fifth
#    (compare-final.sh);
#  - the audits, the record check and the closure on the merged tip (final/);
#  - the result lines of rounds 1-4, and, as process records, the first version (base 7e4655bc2) and the
#    original base (3aa26fb97) from the first version's evidence commit (kept locally as
#    refs/p4.2-backup/v1-evidence).
# Raw runs stay on /mnt/data until judged.
set -eu
V=/mnt/data/tmp/34Za39Feocgj42rrBYwzl/v2
R=$V/runs
G=$V/runs-final
C=$V/compare
F=$V/final
E=$(cd "$(dirname "$0")/.." && pwd)
V1=refs/p4.2-backup/v1-evidence
SUMMARY="python3 -I $E/../p0-drift-3/tools/report-summary.py"
for d in runs runs-final compare compare-final traces shots checks rename-race probes process; do rm -rf "${E:?}/$d"; mkdir -p "$E/$d"; done

# Fifth round: run logs (argv, tree, HEAD, uncommitted paths, load, disk and exit code are at the top and bottom
# of each; terminal colour codes removed), reports without attachment bodies, and the standard P0 runs'
# expectations (which layer each screenshot came from). To keep this directory under 30 MB, the reports of the
# runs that only write screenshots for a comparison (P0 matrix reference and delivery, P4.1 and pilot on both
# trees) stay on /mnt/data: their logs carry the results and compare/ carries the comparison.
log() { sed 's/\x1b\[[0-9;]*m//g' "$1" > "$2"; }
for n in f-p42-ref f-p42-del f-p0-ref f-p0-strict f-p0-del f-p0-standard f-p0-standard-base c-merge c-overlays c-controls \
         f-p41-base f-p41-del pilot-base pilot-del f-p42-repeat probe-geometry-ref probe-geometry-del rename-before rename-after; do
  log "$R/$n.txt" "$E/runs/$n.txt"
done
for n in f-p42-ref f-p42-del f-p0-strict f-p0-standard f-p0-standard-base f-p42-repeat; do
  $SUMMARY "$R/$n-out/report.json" "$E/runs/$n.report.summary.json" > /dev/null
done
for n in f-p0-standard f-p0-standard-base; do
  cp "$R/$n-out/expected-screenshots/sources.json" "$E/runs/$n.expected-sources.json"
done
$SUMMARY "$R/c-overlays-report.json" "$E/runs/c-overlays.report.summary.json" > /dev/null
$SUMMARY "$R/c-controls-report.json" "$E/runs/c-controls.report.summary.json" > /dev/null

# Sixth round, on the merged tip: run logs; the standard P0's report and expectations. (To keep this directory
# under 30 MB, the other four runs' reports stay on /mnt/data: their logs carry the results, and the comparison
# with the fifth round in compare-final/ carries their screenshots, tests and traces.)
for n in g-p0-standard g-merge g-overlays g-controls g-p41-del g-pilot-del g-p42-del g-p0-del; do
  log "$G/$n.txt" "$E/runs-final/$n.txt"
done
$SUMMARY "$G/g-p0-standard-out/report.json" "$E/runs-final/g-p0-standard.report.summary.json" > /dev/null
cp "$G/g-p0-standard-out/expected-screenshots/sources.json" "$E/runs-final/g-p0-standard.expected-sources.json"
$SUMMARY "$G/g-overlays-report.json" "$E/runs-final/g-overlays.report.summary.json" > /dev/null
$SUMMARY "$G/g-controls-report.json" "$E/runs-final/g-controls.report.summary.json" > /dev/null
# The reruns of the three shots that differed from every earlier run of theirs (rerun-odd-final.sh,
# rerun-enroll-final.sh): logs and each script's output.
for n in rerun-p0-projects-1 rerun-p0-projects-2 rerun-p0-projects-3 rerun-pilot-share-1 rerun-pilot-share-2 rerun-pilot-share-3 \
         rerun-p42-enroll-1 rerun-p42-enroll-2 rerun-p42-enroll-3; do
  log "$G/$n.txt" "$E/runs-final/$n.txt"
done
cp "$V/rerun-odd-final.out" "$E/runs-final/rerun-odd-final.txt"
cp "$V/rerun-enroll-final.out" "$E/runs-final/rerun-enroll-final.txt"

# Comparisons, and the P4.2 traces of both trees.
cp "$C"/*.json "$C"/*.txt "$E/compare/"
cp "$V"/compare-final/*-summary.json "$V"/compare-final/*-beyond-clusters.txt "$V"/compare-final/final-p42-trace-semantics.json "$E/compare-final/"
python3 -I "$V/scripts/shot-variants.py" > "$E/compare-final/shot-variants.txt"
python3 -I "$E/../p4.1/extract-traces.py" "$R/f-p42-ref-out/report.json" "$E/traces/f-p42-ref.json"
python3 -I "$E/../p4.1/extract-traces.py" "$R/f-p42-del-out/report.json" "$E/traces/f-p42-del.json"

# Screenshots: every beyond-level pair of the fifth round's comparisons (reference/start and delivery); of the
# merged tip's comparison with the fifth round, one pair for each of the three shots that differed from every
# earlier run of theirs (the rest are in compare-final/*-beyond-clusters.txt and shot-variants.txt); the standard
# P0 failures of each run, if any; the delivery's P4.2 states (every state in Chromium light desktop -- those
# already among the beyond pairs only there; on a phone, WebKit dark, the responsive tables, the DeepSeek
# balance and the users page).
python3 -I - "$V" "$E/shots" <<'PY'
import json, os, shutil, sys
v, out = sys.argv[1:3]
FIRST_TIME = {'chromium-light-phone/p42-enroll-loading.png', 'chromium-dark-phone/projects-list.png',
              'webkit-light-desktop/pilot-share-public.png'}
pairs = (('compare/f-p42', 'f-p42-beyond', 'runs/f-p42-ref', 'runs/f-p42-del', 'reference', 'delivery', None),
         ('compare/f-p0', 'f-p0-beyond', 'runs/f-p0-ref', 'runs/f-p0-del', 'reference', 'delivery', None),
         ('compare/f-p41', 'f-p41-beyond', 'runs/f-p41-base', 'runs/f-p41-del', 'start', 'delivery', None),
         ('compare/pilot', 'pilot-beyond', 'runs/pilot-base', 'runs/pilot-del', 'start', 'delivery', None),
         ('compare-final/final-p42', 'final-p42-beyond', 'runs/f-p42-del', 'runs-final/g-p42-del', '822c00ff0', 'a794459b1', FIRST_TIME),
         ('compare-final/final-p0', 'final-p0-beyond', 'runs/f-p0-del', 'runs-final/g-p0-del', '822c00ff0', 'a794459b1', FIRST_TIME),
         ('compare-final/final-pilot', 'final-pilot-beyond', 'runs/pilot-del', 'runs-final/g-pilot-del', '822c00ff0', 'a794459b1', FIRST_TIME))
for summary, name, before, after, a, b, only in pairs:
    for item in json.load(open(f'{v}/{summary}-summary.json'))['beyond']:
        if only and item['shot'] not in only: continue
        env, shot = item['shot'].split('/')
        os.makedirs(f'{out}/{name}/{env}', exist_ok=True)
        shutil.copy(f'{v}/{before}-shots/{env}/{shot}', f'{out}/{name}/{env}/{shot[:-4]}.{a}.png')
        shutil.copy(f'{v}/{after}-shots/{env}/{shot}', f'{out}/{name}/{env}/{shot[:-4]}.{b}.png')
PY
for pair in p0-standard:$R/f-p0-standard-out p0-standard-base:$R/f-p0-standard-base-out p0-standard-final:$G/g-p0-standard-out; do
  for dir in "${pair#*:}"/*/; do
    ls "$dir"*-diff.png > /dev/null 2>&1 || continue
    mkdir -p "$E/shots/${pair%%:*}/$(basename "$dir")"
    cp "$dir"*-expected.png "$dir"*-actual.png "$dir"*-diff.png "$E/shots/${pair%%:*}/$(basename "$dir")/"
  done
done
mkdir -p "$E/shots/p42-delivery/chromium-light-desktop" "$E/shots/p42-delivery/webkit-dark-phone"
for f in "$R/f-p42-del-shots/chromium-light-desktop"/*.png; do
  b=$(basename "$f" .png)
  [ -f "$E/shots/f-p42-beyond/chromium-light-desktop/$b.delivery.png" ] || cp "$f" "$E/shots/p42-delivery/chromium-light-desktop/"
done
cp "$R/f-p42-del-shots/webkit-dark-phone"/p42-{keys,users,runners,deepseek}*.png "$E/shots/p42-delivery/webkit-dark-phone/"

# Audits on the merged tip: the delivery audit the 2026-10-07c record is built from (and can be rebuilt from byte
# for byte), its summary, --check-owners with all four records and without 07c, the record check, the
# inventory's own checks, the same-commit reference's audit summary, and the closure. --check-owners prints
# JSON, then a verdict line when there are gaps: kept as two files.
cp "$F/delivery-audit.json" "$F/delivery-audit-summary.txt" "$F/verify-record-c.txt" "$F/selfcheck.txt" "$F/p01-verify.txt" "$E/checks/"
for pair in delivery:check-owners without-07c:check-owners-without-07c; do
  python3 -I -c "import json,sys; t=open(sys.argv[1]).read(); json.dump(json.loads(t[:t.rindex('}')+1]), open(sys.argv[2],'w'), indent=1); print(t[t.rindex('}')+1:].strip(), file=open(sys.argv[3],'w'))" \
    "$F/${pair#*:}.txt" "$E/checks/${pair%%:*}-check-owners.json" "$E/checks/${pair%%:*}-check-owners.verdict.txt"
done
cp "$F/ref-audit-summary.txt" "$E/checks/reference-audit-summary.txt"
cp "$F/inventory-closure.json" "$E/inventory-closure.json"

# The WebKit rename race: the original-base formal run that failed on it, and the focus probe before the fix
# (the delivery with the fix reversed) and after it.
git show "$V1:docs/evidence/base-ui-migration/p4.2/rename-race/r1-f-p42-del.txt" > "$E/rename-race/r1-f-p42-del.txt"
git show "$V1:docs/evidence/base-ui-migration/p4.2/rename-race/r1-error-context.md" > "$E/rename-race/r1-error-context.md"
cp "$R/rename-before.jsonl" "$R/rename-after.jsonl" "$E/rename-race/"
cp "$V/scripts/dev-probe/rename-probe.browser.mjs" "$V/scripts/dev-probe/rename-probe-v2.config.mjs" "$V/scripts/rename-fix-reversed.patch" "$E/rename-race/"

# Geometry probes cited by the README (scroll position and lock, scrollbar gutter, switch widths, Always allowed).
cp "$R/probe-geometry-ref.jsonl" "$R/probe-geometry-del.jsonl" "$E/probes/"
cp "$V"/scripts/dev-probe/probe-dialog-scroll.browser.mjs "$V"/scripts/dev-probe/probe-dialog-gutter.browser.mjs \
   "$V"/scripts/dev-probe/probe-switch-widths.browser.mjs "$V"/scripts/dev-probe/probe-always-allowed.browser.mjs \
   "$V"/scripts/dev-probe/probes-v2.config.mjs "$E/probes/"

# Rounds 1-4 of the second version: each run's HEAD and result lines (stopped runs have none).
{
  echo "# The second version's rounds 1-4, as run (raw runs in $V/<dir>): run, HEAD, results, exit code."
  for d in killed-run-1 killed-run-2 runs-def134095 runs-bcc89c7af killed-run-3; do
    echo "== $d"
    for f in "$V/$d"/*.txt; do
      line=$(sed 's/\x1b\[[0-9;]*m//g' "$f" | grep -aE '^\s+[0-9]+ (passed|failed|flaky|skipped|did not run)|Test Files|^\s+Tests |^exit=' | tr -s ' ' | tr '\n' ' ' || true)
      printf '%-20s %s | %s\n' "$(basename "$f" .txt)" "$(sed -n 's/^head: //p' "$f" | cut -c1-9)" "${line:-stopped before it ended}"
    done
  done
} > "$E/process/v2-rounds.txt"

# Process records from the first version's evidence commit: its README, its P4.2 comparison (counts and the
# beyond list, the trace check, the beyond clusters), its logs and its closure; and its own record of the
# original base.
mkdir -p "$E/process/v1" "$E/process/oldbase"
src=docs/evidence/base-ui-migration/p4.2
git show "$V1:$src/README.md" > "$E/process/v1/README.md"
git show "$V1:$src/compare/f-p42-summary.json" | python3 -I -c "import json,sys; s=json.load(sys.stdin); json.dump({'screenshots': s['screenshots'], 'tests': s['tests'], 'traces': {k: v for k, v in s['traces'].items() if k != 'differing'}, 'beyond': [{k: b[k] for k in ('shot', 'pixels', 'max')} for b in s['beyond']]}, open(sys.argv[1], 'w'), indent=1, ensure_ascii=False)" "$E/process/v1/f-p42-summary.json"
for f in compare/f-p42-trace-semantics.json compare/f-p42-beyond-clusters.txt inventory-closure.json runs/f-p42-ref.txt runs/f-p42-del.txt runs/f-p0-strict.txt runs/f-p0-standard.txt; do
  git show "$V1:$src/$f" > "$E/process/v1/$(basename "$f")"
done
for f in $(git ls-tree --name-only "$V1" "$src/oldbase/"); do git show "$V1:$f" > "$E/process/oldbase/$(basename "$f")"; done

# Scripts as run.
cp "$V/scripts/formal-v2.sh" "$V/scripts/make-reference-v2.sh" "$V/scripts/make-delivery-tree-v2.sh" "$V/scripts/analyze-v2.sh" \
   "$V/scripts/beyond-clusters.py" "$V/scripts/final-v2.sh" "$V/scripts/compare-final.sh" "$V/scripts/make-reference-final.sh" \
   "$V/scripts/rerun-odd-final.sh" "$V/scripts/rerun-enroll-final.sh" "$V/scripts/shot-variants.py" "$E/scripts/"
du -sh "$E"
