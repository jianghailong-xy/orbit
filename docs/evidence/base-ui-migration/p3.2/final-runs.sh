#!/usr/bin/env bash
# The recorded P3.2 runs, one group per call: bash final-runs.sh <group>.
# Every step goes through run-check.py (argv, cwd, HEAD, uncommitted paths, source hashes, exit code
# and the full output under checks/); a step that fails does not stop its group, the group's exit
# status says whether any did. REF is the same-commit reference tree: the project tip with only the
# pilot spec files and the configs below copied into src/web/ui-migration (see README).
set -u
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../../.." && pwd)
REF=${REF:-/var/tmp/p32-ref}
OUT=${OUT:-/var/tmp/p32-final}
mkdir -p "$OUT"
status=0
check() { python3 "$here/run-check.py" "$@" || status=1; }
ref() { ROOT="$REF" python3 "$here/run-check.py" "$@" || status=1; }
cd "$repo"

case "${1:?group}" in
  pilot)
    # Each tree's preview serves its own fresh build. Both serve on the same port, one after the
    # other, so absolute URLs (the share link) are equal.
    ref ref-build bash -c "npm run build -w @orbit/shared && npm run build -w @orbit/web"
    check build bash -c "npm run build -w @orbit/shared && npm run build -w @orbit/web"
    ref ref-pilot bash -c "cd src/web && P32_SNAPSHOTS=$OUT/ref-pilot-shots P32_OUTPUT=$OUT/ref-pilot P32_PORT=4291 npx playwright test -c ui-migration/pilot.config.mjs ui-migration/pilot.browser.mjs --update-snapshots=all"
    check pilot bash -c "cd src/web && P32_SNAPSHOTS=$OUT/pilot-shots P32_OUTPUT=$OUT/pilot P32_PORT=4291 npx playwright test -c ui-migration/pilot.config.mjs ui-migration/pilot.browser.mjs --update-snapshots=all"
    check pilot-compare python3 "$here/compare_runs.py" "$OUT/ref-pilot-shots" "$OUT/pilot-shots" "$OUT/ref-pilot/report.json" "$OUT/pilot/report.json" "$here/pilot-compare.json"
    ;;
  pilot-delivery)
    # The delivery half again after a later code change; the reference run above stays valid while
    # the reference tree and the spec are unchanged. ${2} names the rerun (build-2, pilot-2, ...);
    # ${3}, if given, the pilot-both round whose reference run it is compared with.
    n=${2:?rerun number}
    r=${3:+-$3}
    check build-$n bash -c "npm run build -w @orbit/shared && npm run build -w @orbit/web"
    check pilot-$n bash -c "cd src/web && P32_SNAPSHOTS=$OUT/pilot-shots-$n P32_OUTPUT=$OUT/pilot-$n P32_PORT=4291 npx playwright test -c ui-migration/pilot.config.mjs ui-migration/pilot.browser.mjs --update-snapshots=all"
    check pilot-compare-$n python3 "$here/compare_runs.py" "$OUT/ref-pilot-shots$r" "$OUT/pilot-shots-$n" "$OUT/ref-pilot$r/report.json" "$OUT/pilot-$n/report.json" "$here/pilot-compare-$n.json"
    ;;
  pilot-pair)
    # Two delivery runs side by side, $2 then $3: what the later commit changed in the pilot itself.
    check "pilot-$3-vs-$2" python3 "$here/compare_runs.py" "$OUT/pilot-shots-$2" "$OUT/pilot-shots-$3" "$OUT/pilot-$2/report.json" "$OUT/pilot-$3/report.json" "$here/pilot-$3-vs-$2.json"
    ;;
  pilot-both)
    # Both pilot halves again after a spec change; the reference tree's copy of the spec must match.
    n=${2:?rerun number}
    ref ref-pilot-$n bash -c "cd src/web && P32_SNAPSHOTS=$OUT/ref-pilot-shots-$n P32_OUTPUT=$OUT/ref-pilot-$n P32_PORT=4291 npx playwright test -c ui-migration/pilot.config.mjs ui-migration/pilot.browser.mjs --update-snapshots=all"
    check build-$n bash -c "npm run build -w @orbit/shared && npm run build -w @orbit/web"
    check pilot-$n bash -c "cd src/web && P32_SNAPSHOTS=$OUT/pilot-shots-$n P32_OUTPUT=$OUT/pilot-$n P32_PORT=4291 npx playwright test -c ui-migration/pilot.config.mjs ui-migration/pilot.browser.mjs --update-snapshots=all"
    check pilot-compare-$n python3 "$here/compare_runs.py" "$OUT/ref-pilot-shots-$n" "$OUT/pilot-shots-$n" "$OUT/ref-pilot-$n/report.json" "$OUT/pilot-$n/report.json" "$here/pilot-compare-$n.json"
    ;;
  p0)
    # P0 page matrix: the reference tree writes the screenshots, the delivery is compared with them.
    ref ref-p0 bash -c "cd src/web && P32_SNAPSHOTS=$OUT/p0-shots P32_OUTPUT=$OUT/ref-p0 P32_PORT=4292 npx playwright test -c ui-migration/p32-reference.config.mjs --update-snapshots=all"
    check p0-vs-tip bash -c "cp $here/p32-reference.config.mjs src/web/ui-migration/p32-reference.config.mjs && cd src/web && P32_SNAPSHOTS=$OUT/p0-shots P32_OUTPUT=$OUT/p0 P32_PORT=4292 npx playwright test -c ui-migration/p32-reference.config.mjs --update-snapshots=none; s=\$?; rm -f ui-migration/p32-reference.config.mjs; exit \$s"
    ;;
  p0-classify)
    # p0-vs-tip stops each test at its first differing shot. The task scenario's shots are taken again
    # whole on the delivery and compared like the pilot's; the one reference flake is run again.
    mkdir -p "$OUT/p0-ref-task-shots"
    for d in "$OUT"/p0-shots/*/; do p=$(basename "$d"); mkdir -p "$OUT/p0-ref-task-shots/$p"; cp "$d"task-*.png "$OUT/p0-ref-task-shots/$p/"; done
    check p0-task-shots bash -c "cp $here/p32-reference.config.mjs src/web/ui-migration/p32-reference.config.mjs && cd src/web && P32_SNAPSHOTS=$OUT/p0-del-task-shots P32_OUTPUT=$OUT/p0-del-task P32_PORT=4292 npx playwright test -c ui-migration/p32-reference.config.mjs ui-migration/pages.browser.mjs -g 'task\$' --update-snapshots=all; s=\$?; rm -f ui-migration/p32-reference.config.mjs; exit \$s"
    check p0-task-compare python3 "$here/compare_runs.py" "$OUT/p0-ref-task-shots" "$OUT/p0-del-task-shots" "$OUT/ref-p0/report.json" "$OUT/p0-del-task/report.json" "$here/p0-task-compare.json"
    ref ref-p0-settings bash -c "cd src/web && P32_SNAPSHOTS=$OUT/p0-shots P32_OUTPUT=$OUT/ref-p0-settings P32_PORT=4292 npx playwright test -c ui-migration/p32-reference.config.mjs ui-migration/pages.browser.mjs -g 'settings\$' --project webkit-dark-desktop --update-snapshots=all"
    check p0-settings bash -c "cp $here/p32-reference.config.mjs src/web/ui-migration/p32-reference.config.mjs && cd src/web && P32_SNAPSHOTS=$OUT/p0-shots P32_OUTPUT=$OUT/p0-settings P32_PORT=4292 npx playwright test -c ui-migration/p32-reference.config.mjs ui-migration/pages.browser.mjs -g 'settings\$' --project webkit-dark-desktop --update-snapshots=none; s=\$?; rm -f ui-migration/p32-reference.config.mjs; exit \$s"
    ;;
  p0-classify-2)
    # The comparison again after compare_runs.py learned to skip Playwright's binary trace.zip, and the
    # settings scenario's known intermittent (two "Setting saved" toasts at once) given another run.
    check p0-task-compare-2 python3 "$here/compare_runs.py" "$OUT/p0-ref-task-shots" "$OUT/p0-del-task-shots" "$OUT/ref-p0/report.json" "$OUT/p0-del-task/report.json" "$here/p0-task-compare.json"
    check p0-settings-2 bash -c "cp $here/p32-reference.config.mjs src/web/ui-migration/p32-reference.config.mjs && cd src/web && P32_SNAPSHOTS=$OUT/p0-shots P32_OUTPUT=$OUT/p0-settings-2 P32_PORT=4292 npx playwright test -c ui-migration/p32-reference.config.mjs ui-migration/pages.browser.mjs -g 'settings\$' --project webkit-dark-desktop --update-snapshots=none; s=\$?; rm -f ui-migration/p32-reference.config.mjs; exit \$s"
    ;;
  p0-delivery)
    # The delivery half of the P0 comparison again after a later code change (the tip's screenshots in
    # p0-shots stay valid): strict, then the task scenario's shots taken whole and classified.
    n=${2:?rerun number}
    check p0-vs-tip-$n bash -c "cp $here/p32-reference.config.mjs src/web/ui-migration/p32-reference.config.mjs && cd src/web && P32_SNAPSHOTS=$OUT/p0-shots P32_OUTPUT=$OUT/p0-$n P32_PORT=4292 npx playwright test -c ui-migration/p32-reference.config.mjs --update-snapshots=none; s=\$?; rm -f ui-migration/p32-reference.config.mjs; exit \$s"
    check p0-task-shots-$n bash -c "cp $here/p32-reference.config.mjs src/web/ui-migration/p32-reference.config.mjs && cd src/web && P32_SNAPSHOTS=$OUT/p0-del-task-shots-$n P32_OUTPUT=$OUT/p0-del-task-$n P32_PORT=4292 npx playwright test -c ui-migration/p32-reference.config.mjs ui-migration/pages.browser.mjs -g 'task\$' --update-snapshots=all; s=\$?; rm -f ui-migration/p32-reference.config.mjs; exit \$s"
    check p0-task-compare-$((n + 1)) python3 "$here/compare_runs.py" "$OUT/p0-ref-task-shots" "$OUT/p0-del-task-shots-$n" "$OUT/ref-p0/report.json" "$OUT/p0-del-task-$n/report.json" "$here/p0-task-compare-$n.json"
    ;;
  p0-rerun)
    # One P0 test again against the tip's screenshots: $2 names the record, $3 the scenario, $4 the
    # environment (the settings/profile scenarios' known intermittent: their toast text also matches
    # the screen-reader live region for a moment).
    check "$2" bash -c "cp $here/p32-reference.config.mjs src/web/ui-migration/p32-reference.config.mjs && cd src/web && P32_SNAPSHOTS=$OUT/p0-shots P32_OUTPUT=$OUT/$2 P32_PORT=4292 npx playwright test -c ui-migration/p32-reference.config.mjs ui-migration/pages.browser.mjs -g '$3\$' --project $4 --update-snapshots=none; s=\$?; rm -f ui-migration/p32-reference.config.mjs; exit \$s"
    ;;
  regressions)
    # The P1–P3.1 component matrices and the review dialogs, each on a port of its own.
    port=4301
    for suite in foundation controls overlays choices composer toasts; do
      check "$suite-regression" bash -c "cd src/web && P32_BASE_CONFIG=$suite.config.mjs P32_PORT=$port P32_OUTPUT=$OUT/$suite npx playwright test -c ui-migration/port.config.mjs"
      port=$((port + 1))
    done
    cp "$here/port.config.mjs" "$REF/src/web/ui-migration/port.config.mjs"
    ref ref-reviews bash -c "cd src/web && P32_BASE_CONFIG=reviews.config.mjs P32_PORT=4310 P32_OUTPUT=$OUT/ref-reviews npx playwright test -c ui-migration/port.config.mjs"
    check reviews bash -c "cd src/web && P32_BASE_CONFIG=reviews.config.mjs P32_PORT=4310 P32_OUTPUT=$OUT/reviews npx playwright test -c ui-migration/port.config.mjs"
    ;;
  regressions-rest)
    # The suites the first regressions run did not reach on the final code, after the composer
    # fixture regained its AntD sample's width rule.
    check composer-regression bash -c "cd src/web && P32_BASE_CONFIG=composer.config.mjs P32_PORT=4305 P32_OUTPUT=$OUT/composer npx playwright test -c ui-migration/port.config.mjs"
    check toasts-regression bash -c "cd src/web && P32_BASE_CONFIG=toasts.config.mjs P32_PORT=4306 P32_OUTPUT=$OUT/toasts npx playwright test -c ui-migration/port.config.mjs"
    cp "$here/port.config.mjs" "$REF/src/web/ui-migration/port.config.mjs"
    ref ref-reviews bash -c "cd src/web && P32_BASE_CONFIG=reviews.config.mjs P32_PORT=4310 P32_OUTPUT=$OUT/ref-reviews npx playwright test -c ui-migration/port.config.mjs"
    check reviews bash -c "cd src/web && P32_BASE_CONFIG=reviews.config.mjs P32_PORT=4310 P32_OUTPUT=$OUT/reviews npx playwright test -c ui-migration/port.config.mjs"
    ;;
  reviews-compare)
    # The review dialogs (Orbit Dialog in production since P2.1): geometry and screenshots, tip vs delivery.
    check "${2:-reviews-compare}" bash -c "python3 $here/attachments-compare.py $OUT/ref-reviews/report.json $OUT/reviews/report.json > $here/reviews-compare.json"
    ;;
  reviews-delivery)
    # The review dialogs' delivery half again after a later code change; the tip's run stays valid.
    n=${2:?rerun number}
    check reviews-$n bash -c "cd src/web && P32_BASE_CONFIG=reviews.config.mjs P32_PORT=4310 P32_OUTPUT=$OUT/reviews-$n npx playwright test -c ui-migration/port.config.mjs"
    check reviews-compare-$n bash -c "python3 $here/attachments-compare.py $OUT/ref-reviews/report.json $OUT/reviews-$n/report.json > $here/reviews-compare-$n.json"
    ;;
  regressions-again)
    # The P1–P3.1 component matrices again on a later commit; $2 names the round.
    n=${2:?round}
    port=4301
    for suite in foundation controls overlays choices composer toasts; do
      check "$suite-regression-$n" bash -c "cd src/web && P32_BASE_CONFIG=$suite.config.mjs P32_PORT=$port P32_OUTPUT=$OUT/$suite-$n npx playwright test -c ui-migration/port.config.mjs"
      port=$((port + 1))
    done
    ;;
  motion-repeat)
    # The WebKit motion samples that once timed out waiting for their entrance animation, repeated on
    # the tip and on the delivery: is the timeout the change's, or the test's on this host?
    ref ref-motion-repeat bash -c "cd src/web && P32_BASE_CONFIG=choices.config.mjs P32_PORT=4332 P32_OUTPUT=$OUT/ref-motion-repeat npx playwright test -c ui-migration/port.config.mjs ui-migration/choices-motion.browser.mjs -g 'normal (top|flipped) entrance and exit motion matches (expiry|search|multiple)' --project webkit-light-desktop --project webkit-light-phone --repeat-each 8"
    check motion-repeat bash -c "cd src/web && P32_BASE_CONFIG=choices.config.mjs P32_PORT=4332 P32_OUTPUT=$OUT/motion-repeat npx playwright test -c ui-migration/port.config.mjs ui-migration/choices-motion.browser.mjs -g 'normal (top|flipped) entrance and exit motion matches (expiry|search|multiple)' --project webkit-light-desktop --project webkit-light-phone --repeat-each 8"
    ;;
  suite-rerun)
    # One test of a component matrix again: $2 names the record, $3 the suite (its config prefix), $4 a
    # title pattern, $5 the environment. For runs whose fixture never mounted because the host's
    # network churn aborted Vite's module loads (net::ERR_NETWORK_CHANGED in the trace).
    check "$2" bash -c "cd src/web && P32_BASE_CONFIG=$3.config.mjs P32_PORT=4330 P32_OUTPUT=$OUT/$2 npx playwright test -c ui-migration/port.config.mjs -g '$4' --project $5"
    ;;
  suite-repeat)
    # One test of a component matrix repeated on the tip and on the delivery: $2 names the records, $3
    # the suite (its config prefix), $4 a title pattern, $5 the environment, $6 the repeat count. For a
    # failure that looks like a timing race: does the tip lose the same race?
    cp "$here/port.config.mjs" "$REF/src/web/ui-migration/port.config.mjs"
    ref "ref-$2" bash -c "cd src/web && P32_BASE_CONFIG=$3.config.mjs P32_PORT=4331 P32_OUTPUT=$OUT/ref-$2 npx playwright test -c ui-migration/port.config.mjs -g '$4' --project $5 --repeat-each $6"
    check "$2" bash -c "cd src/web && P32_BASE_CONFIG=$3.config.mjs P32_PORT=4331 P32_OUTPUT=$OUT/$2 npx playwright test -c ui-migration/port.config.mjs -g '$4' --project $5 --repeat-each $6"
    ;;
  regression-suite)
    # One component matrix again on its own, with nothing else of this batch running: $2 names the
    # round, $3 the suite.
    check "$3-regression-$2" bash -c "cd src/web && P32_BASE_CONFIG=$3.config.mjs P32_PORT=4304 P32_OUTPUT=$OUT/$3-$2 npx playwright test -c ui-migration/port.config.mjs"
    ;;
  orbitkit)
    # OrbitKit's Swift tests, whose copy-parity and wiring tests read the web sources this batch
    # changed, on the tip and on the delivery (git archive copies, swift:6.1 image), and the cases
    # each tree fails.
    check orbitkit-tip bash "$here/orbitkit-run.sh" da13423d3 "$OUT/orbitkit-tip"
    check orbitkit bash "$here/orbitkit-run.sh" HEAD "$OUT/orbitkit"
    check orbitkit-compare bash -c "python3 $here/orbitkit-compare.py $here/checks/orbitkit-tip.txt $here/checks/orbitkit.txt > $here/orbitkit-compare.json"
    ;;
  orbitkit-again)
    # OrbitKit on the delivery again after a later commit, compared with the tip's run above.
    n=${2:?round}
    check orbitkit-$n bash "$here/orbitkit-run.sh" HEAD "$OUT/orbitkit-$n"
    check orbitkit-compare-$n bash -c "python3 $here/orbitkit-compare.py $here/checks/orbitkit-tip.txt $here/checks/orbitkit-$n.txt > $here/orbitkit-compare-$n.json"
    ;;
  bundle-again)
    # The delivery's initial JS/CSS again after a later commit (dist/ as the last build left it).
    n=${2:?round}
    check bundle-size-$n python3 docs/evidence/base-ui-migration/p3.1/bundle-size.py "tip=$REF/src/web/dist" delivered=src/web/dist
    check sourcemap-build-$n bash -c "cd src/web && npx vite build --sourcemap --outDir $OUT/sm-delivered-$n --emptyOutDir"
    check bundle-composition-$n bash -c "python3 $here/bundle-composition.py tip=$OUT/sm-tip delivered=$OUT/sm-delivered-$n > $here/bundle-composition-$n.json"
    ;;
  merge)
    # $2, if given, names a later round (merge-check-2, ...).
    check merge-check${2:+-$2} bash -c "npm run build -w @orbit/shared && npm run build -w @orbit/web && npm run test -w @orbit/web"
    ;;
  measure)
    check bundle-size python3 docs/evidence/base-ui-migration/p3.1/bundle-size.py "tip=$REF/src/web/dist" delivered=src/web/dist
    ref ref-antd-audit bash -c "node src/web/scripts/audit-antd.mjs --json > $OUT/antd-audit-tip.json"
    check antd-audit bash -c "node src/web/scripts/audit-antd.mjs --json > $OUT/antd-audit-delivered.json"
    check inventory-closure bash -c "python3 $here/inventory-closure.py $OUT/antd-audit-tip.json $OUT/antd-audit-delivered.json > $here/inventory-closure.json"
    ref ref-performance bash -c "cd src/web && P32_SNAPSHOTS=$OUT/ref-perf-shots P32_OUTPUT=$OUT/ref-perf P32_PORT=4291 npx playwright test -c ui-migration/pilot.config.mjs ui-migration/pilot-performance.browser.mjs --project chromium-light-desktop"
    check performance bash -c "cd src/web && P32_SNAPSHOTS=$OUT/perf-shots P32_OUTPUT=$OUT/perf P32_PORT=4291 npx playwright test -c ui-migration/pilot.config.mjs ui-migration/pilot-performance.browser.mjs --project chromium-light-desktop"
    check performance-compare bash -c "python3 $here/perf-compare.py $OUT/ref-perf $OUT/perf > $here/perf-compare.json"
    ;;
  measure-quiet)
    # The same-scenario timings again with no other run of this batch on the machine, under reduced
    # motion (as the pilot runs) and under the default motion setting (motion.config.mjs): the replaced
    # popups animate under both, the Orbit ones only under the default. $2 names the round.
    n=${2:?round}
    cp "$here/motion.config.mjs" "$REF/src/web/ui-migration/motion.config.mjs"
    ref ref-performance-$n bash -c "cd src/web && P32_SNAPSHOTS=$OUT/ref-perf-shots-$n P32_OUTPUT=$OUT/ref-perf-$n P32_PORT=4291 npx playwright test -c ui-migration/pilot.config.mjs ui-migration/pilot-performance.browser.mjs --project chromium-light-desktop"
    check performance-$n bash -c "cd src/web && P32_SNAPSHOTS=$OUT/perf-shots-$n P32_OUTPUT=$OUT/perf-$n P32_PORT=4291 npx playwright test -c ui-migration/pilot.config.mjs ui-migration/pilot-performance.browser.mjs --project chromium-light-desktop"
    ref ref-performance-motion-$n bash -c "cd src/web && P32_SNAPSHOTS=$OUT/ref-perf-motion-shots-$n P32_OUTPUT=$OUT/ref-perf-motion-$n P32_PORT=4291 npx playwright test -c ui-migration/motion.config.mjs ui-migration/pilot-performance.browser.mjs --project chromium-light-desktop"
    check performance-motion-$n bash -c "cp $here/motion.config.mjs src/web/ui-migration/motion.config.mjs && cd src/web && P32_SNAPSHOTS=$OUT/perf-motion-shots-$n P32_OUTPUT=$OUT/perf-motion-$n P32_PORT=4291 npx playwright test -c ui-migration/motion.config.mjs ui-migration/pilot-performance.browser.mjs --project chromium-light-desktop; s=\$?; rm -f ui-migration/motion.config.mjs; exit \$s"
    check performance-compare-$n bash -c "python3 $here/perf-compare.py $OUT/ref-perf-$n $OUT/perf-$n > $here/perf-compare-$n.json"
    check performance-motion-compare-$n bash -c "python3 $here/perf-compare.py $OUT/ref-perf-motion-$n $OUT/perf-motion-$n > $here/perf-compare-motion-$n.json"
    ;;
  bundle-composition)
    # Where the initial JS of each tree comes from: both trees built again with source maps into
    # separate directories (the delivered dist/ is left as built), every byte attributed by package.
    ref ref-sourcemap-build bash -c "cd src/web && npx vite build --sourcemap --outDir $OUT/sm-tip --emptyOutDir"
    check sourcemap-build bash -c "cd src/web && npx vite build --sourcemap --outDir $OUT/sm-delivered --emptyOutDir"
    check bundle-composition bash -c "python3 $here/bundle-composition.py tip=$OUT/sm-tip delivered=$OUT/sm-delivered > $here/bundle-composition.json"
    ;;
  merged-check)
    # Round 2 (README "第 2 轮：合入 main"): the project's merge check on the merged tree. $2 names the
    # round (r2, ...).
    check ${2:?round}-merge-check bash -c "npm run build -w @orbit/web && npm run test -w @orbit/web"
    ;;
  merged-scope)
    # Round 2: merge-scope.py on the commit under test against $3 (main, or the project tip merged with
    # main), recorded. $2 names the round.
    n=${2:?round}
    check $n-merge-scope bash -c "python3 $here/merge-scope.py da13423d3 b24209077 ${3:?base} HEAD --round2 src/web/ui-migration/pilot.browser.mjs src/web/ui-migration/pilot-fixtures.mjs src/web/src/pages/RunnerDetailPage.antigravityAccount.test.tsx > $here/$n-merge-scope.json"
    ;;
  merged-pilot)
    # Round 2: every pilot case on both trees again. REF is then main as merged (the tree the merge would
    # be without this batch) with the pilot specs copied in; both are built afresh. $2 names the round.
    n=${2:?round}
    ref $n-ref-build bash -c "npm run build -w @orbit/shared && npm run build -w @orbit/web"
    check $n-build bash -c "npm run build -w @orbit/shared && npm run build -w @orbit/web"
    ref $n-ref-pilot bash -c "cd src/web && P32_SNAPSHOTS=$OUT/$n-ref-pilot-shots P32_OUTPUT=$OUT/$n-ref-pilot P32_PORT=4291 npx playwright test -c ui-migration/pilot.config.mjs ui-migration/pilot.browser.mjs --update-snapshots=all"
    check $n-pilot bash -c "cd src/web && P32_SNAPSHOTS=$OUT/$n-pilot-shots P32_OUTPUT=$OUT/$n-pilot P32_PORT=4291 npx playwright test -c ui-migration/pilot.config.mjs ui-migration/pilot.browser.mjs --update-snapshots=all"
    check $n-pilot-compare python3 "$here/compare_runs.py" "$OUT/$n-ref-pilot-shots" "$OUT/$n-pilot-shots" "$OUT/$n-ref-pilot/report.json" "$OUT/$n-pilot/report.json" "$here/$n-pilot-compare.json"
    check $n-pilot-summary bash -c "python3 $here/summarize-compare.py $here/$n-pilot-compare.json > $here/$n-pilot-summary.json"
    ;;
  merged-noise)
    # Round 2: the reference run of merged-pilot again, compared with the first (as reference-noise).
    n=${2:?round}
    ref $n-ref-pilot-again bash -c "cd src/web && P32_SNAPSHOTS=$OUT/$n-ref-pilot-again-shots P32_OUTPUT=$OUT/$n-ref-pilot-again P32_PORT=4291 npx playwright test -c ui-migration/pilot.config.mjs ui-migration/pilot.browser.mjs --update-snapshots=all"
    check $n-reference-noise python3 "$here/compare_runs.py" "$OUT/$n-ref-pilot-shots" "$OUT/$n-ref-pilot-again-shots" "$OUT/$n-ref-pilot/report.json" "$OUT/$n-ref-pilot-again/report.json" "$here/$n-reference-noise-compare.json"
    check $n-reference-noise-summary bash -c "python3 $here/summarize-compare.py $here/$n-reference-noise-compare.json > $here/$n-reference-noise-summary.json"
    ;;
  merged-orbitkit)
    # Round 2: OrbitKit on the main commit merged in ($3) and on the delivery; main's own failures are
    # the baseline.
    n=${2:?round}
    check $n-orbitkit-main bash "$here/orbitkit-run.sh" "${3:?main commit}" "$OUT/$n-orbitkit-main"
    check $n-orbitkit bash "$here/orbitkit-run.sh" HEAD "$OUT/$n-orbitkit"
    check $n-orbitkit-compare bash -c "python3 $here/orbitkit-compare.py $here/checks/$n-orbitkit-main.txt $here/checks/$n-orbitkit.txt > $here/$n-orbitkit-compare.json"
    ;;
  merged-again)
    # Round 2, after main moved past the main commit the comparison was made on: $2 names the round, $3
    # the main commit merged in now, $4 and $5 copies of the delivery's and the reference's dist/ that
    # the comparison served. The merge check and the merge scope on the new merge, then both trees'
    # builds (REF checked out at $3 beforehand) compared with what the comparison served: equal files
    # mean the pilot runs above stand for the new merge as they are.
    n=${2:?round}; m=${3:?main commit}
    check $n-merge-check bash -c "npm run build -w @orbit/web && npm run test -w @orbit/web"
    check $n-merge-scope bash -c "python3 $here/merge-scope.py da13423d3 b24209077 $m HEAD --round2 src/web/ui-migration/pilot.browser.mjs src/web/ui-migration/pilot-fixtures.mjs src/web/src/pages/RunnerDetailPage.antigravityAccount.test.tsx > $here/$n-merge-scope.json"
    check $n-dist-compare diff -r "${4:?delivery dist copy}" src/web/dist
    ref $n-ref-build bash -c "npm run build -w @orbit/shared && npm run build -w @orbit/web"
    ref $n-ref-dist-compare diff -r "${5:?reference dist copy}" src/web/dist
    ;;
  merged-regressions)
    # Round 2: the P1–P3.1 component matrices on the merged delivery (each fixture compares its AntD
    # sample with the Orbit component itself), and the review dialogs on REF (main) and the delivery,
    # compared. $2 names the round.
    n=${2:?round}
    port=4301
    for suite in foundation controls overlays choices composer toasts; do
      check "$n-$suite-regression" bash -c "cd src/web && P32_BASE_CONFIG=$suite.config.mjs P32_PORT=$port P32_OUTPUT=$OUT/$n-$suite npx playwright test -c ui-migration/port.config.mjs"
      port=$((port + 1))
    done
    cp "$here/port.config.mjs" "$REF/src/web/ui-migration/port.config.mjs"
    ref $n-ref-reviews bash -c "cd src/web && P32_BASE_CONFIG=reviews.config.mjs P32_PORT=4310 P32_OUTPUT=$OUT/$n-ref-reviews npx playwright test -c ui-migration/port.config.mjs"
    check $n-reviews bash -c "cd src/web && P32_BASE_CONFIG=reviews.config.mjs P32_PORT=4310 P32_OUTPUT=$OUT/$n-reviews npx playwright test -c ui-migration/port.config.mjs"
    check $n-reviews-compare bash -c "python3 $here/attachments-compare.py $OUT/$n-ref-reviews/report.json $OUT/$n-reviews/report.json > $here/$n-reviews-compare.json"
    ;;
  merged-p0)
    # Round 2: the P0 page matrix, REF (main) writing the screenshots and the delivery compared with them
    # at 0 pixels; then the task scenario's shots taken whole on the delivery and classified like the
    # pilot's (as the p0 and p0-classify groups). $2 names the round.
    n=${2:?round}
    cp "$here/p32-reference.config.mjs" "$REF/src/web/ui-migration/p32-reference.config.mjs"
    ref $n-ref-p0 bash -c "cd src/web && P32_SNAPSHOTS=$OUT/$n-p0-shots P32_OUTPUT=$OUT/$n-ref-p0 P32_PORT=4292 npx playwright test -c ui-migration/p32-reference.config.mjs --update-snapshots=all"
    check $n-p0-vs-main bash -c "cp $here/p32-reference.config.mjs src/web/ui-migration/p32-reference.config.mjs && cd src/web && P32_SNAPSHOTS=$OUT/$n-p0-shots P32_OUTPUT=$OUT/$n-p0 P32_PORT=4292 npx playwright test -c ui-migration/p32-reference.config.mjs --update-snapshots=none; s=\$?; rm -f ui-migration/p32-reference.config.mjs; exit \$s"
    mkdir -p "$OUT/$n-p0-ref-task-shots"
    for d in "$OUT/$n-p0-shots"/*/; do p=$(basename "$d"); mkdir -p "$OUT/$n-p0-ref-task-shots/$p"; cp "$d"task-*.png "$OUT/$n-p0-ref-task-shots/$p/"; done
    check $n-p0-task-shots bash -c "cp $here/p32-reference.config.mjs src/web/ui-migration/p32-reference.config.mjs && cd src/web && P32_SNAPSHOTS=$OUT/$n-p0-del-task-shots P32_OUTPUT=$OUT/$n-p0-del-task P32_PORT=4292 npx playwright test -c ui-migration/p32-reference.config.mjs ui-migration/pages.browser.mjs -g 'task\$' --update-snapshots=all; s=\$?; rm -f ui-migration/p32-reference.config.mjs; exit \$s"
    check $n-p0-task-compare python3 "$here/compare_runs.py" "$OUT/$n-p0-ref-task-shots" "$OUT/$n-p0-del-task-shots" "$OUT/$n-ref-p0/report.json" "$OUT/$n-p0-del-task/report.json" "$here/$n-p0-task-compare.json"
    check $n-p0-task-summary bash -c "python3 $here/summarize-compare.py $here/$n-p0-task-compare.json > $here/$n-p0-task-summary.json"
    ;;
  merged-p0-rerun)
    # Round 2: one P0 scenario again in one environment, REF writing its screenshots into the round's set
    # and the delivery compared with them: $2 names the round, $3 the scenario, $4 the environment, $5 an
    # optional attempt suffix. For the settings and profile scenarios' known intermittent (the saved
    # toast's text also matches the screen-reader live region for a moment), which stops a run before it
    # writes the scenario's later screenshots.
    n=${2:?round}; a=${5:+-$5}
    ref "$n-ref-p0-$3-$4$a" bash -c "cd src/web && P32_SNAPSHOTS=$OUT/$n-p0-shots P32_OUTPUT=$OUT/$n-ref-p0-$3-$4$a P32_PORT=4292 npx playwright test -c ui-migration/p32-reference.config.mjs ui-migration/pages.browser.mjs -g '$3\$' --project $4 --update-snapshots=all"
    check "$n-p0-$3-$4$a" bash -c "cp $here/p32-reference.config.mjs src/web/ui-migration/p32-reference.config.mjs && cd src/web && P32_SNAPSHOTS=$OUT/$n-p0-shots P32_OUTPUT=$OUT/$n-p0-$3-$4$a P32_PORT=4292 npx playwright test -c ui-migration/p32-reference.config.mjs ui-migration/pages.browser.mjs -g '$3\$' --project $4 --update-snapshots=none; s=\$?; rm -f ui-migration/p32-reference.config.mjs; exit \$s"
    ;;
  *) echo "unknown group $1" >&2; exit 2 ;;
esac
exit $status
