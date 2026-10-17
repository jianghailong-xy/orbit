#!/usr/bin/env bash
# Copy what README.md cites from the scratch runs (/var/tmp/p4.1-293463) into this directory: run logs,
# Playwright reports with attachment bodies removed (p0-drift-3/tools/report-summary.py), comparisons,
# the P4.1 traces, the cited screenshots and the probe outputs. Raw runs stay in /var/tmp until judged.
set -eu
S=/var/tmp/p4.1-293463
R=$S/runs
C=$S/compare
E=$(cd "$(dirname "$0")/.." && pwd)
SUMMARY="python3 -I $E/../p0-drift-3/tools/report-summary.py"
rm -rf "$E/runs" "$E/compare" "$E/traces" "$E/shots" "$E/admin-signin" "$E/frames" "$E/isolation"
mkdir -p "$E/runs" "$E/compare" "$E/traces" "$E/shots" "$E/admin-signin" "$E/frames" "$E/isolation"

# Run logs (argv, HEAD and uncommitted paths are at the top of those written by checks/followup/final).
for n in f-p0-ref f-p0-strict f-p0-del f-p0-standard f-p0-standard-2 f-p41-ref f-p41-del \
         c-overlays c-choices c-merge pilot-tip pilot-final pilot-final2 pilot-rerun pilot-rerun2 rep-ref-1 rep-del-1 rep-ref-2 rep-del-2 \
         n-ref-1 n-del-1 n-ref-2 n-del-2 r1-ref r1-ref2 iso-force0 iso-force1; do
  cp "$R/$n.log" "$E/runs/$n.txt"   # the repository ignores *.log
done
# Reports without attachment bodies. f-p0-standard's own report.json was overwritten by a later
# `--list` run in the same tree; f-p0-standard-2 repeats that regression with its report kept.
for n in f-p0-ref f-p0-strict f-p0-del f-p0-standard-2 f-p41-ref f-p41-del pilot-tip pilot-final pilot-final2 pilot-rerun pilot-rerun2 \
         rep-ref-1 rep-del-1 rep-ref-2 rep-del-2 n-ref-1 n-del-1 n-ref-2 n-del-2 r1-ref r1-ref2 iso-force0 iso-force1; do
  $SUMMARY "$R/$n-out/report.json" "$E/runs/$n.report.summary.json" > /dev/null
done
$SUMMARY "$R/c-overlays-report.json" "$E/runs/c-overlays.report.summary.json" > /dev/null
$SUMMARY "$R/c-choices-report.json" "$E/runs/c-choices.report.summary.json" > /dev/null
cp "$R/f-p0-standard-2-out/expected-sources.json" "$E/runs/f-p0-standard-2.expected-sources.json"

# Comparisons and the P4.1 traces.
cp "$C"/f-p41-compare.json "$C"/f-p41-summary.json "$C"/f-p41-trace-semantics.txt "$C"/f-p0-compare.json "$C"/f-p0-summary.json \
   "$C"/admin-signin-compare.json "$C"/pilot-final2-compare.json "$C"/pilot-final2-summary.json "$C"/pilot-final-summary.json \
   "$C"/pilot-rerun2-vs-tip.json "$C"/repeats.json "$E/compare/"
python3 -I "$E/extract-traces.py" "$R/f-p41-ref-out/report.json" "$E/traces/f-p41-ref.json"
python3 -I "$E/extract-traces.py" "$R/f-p41-del-out/report.json" "$E/traces/f-p41-del.json"

# Screenshots: every beyond-level pair, the standard P0 failures, and the delivery's P4.1 states in two environments.
python3 -I - "$C/f-p41-summary.json" "$R/f-p41-ref-shots" "$R/f-p41-del-shots" "$E/shots/p41-beyond" \
             "$C/f-p0-summary.json" "$R/f-p0-ref-shots" "$R/f-p0-del-shots" "$E/shots/p0-beyond" <<'PY'
import json, os, shutil, sys
args = sys.argv[1:]
for summary, ref, dele, out in (args[0:4], args[4:8]):
    for item in json.load(open(summary))['beyond']:
        env, name = item['shot'].split('/')
        os.makedirs(f'{out}/{env}', exist_ok=True)
        stem = name[:-4]
        shutil.copy(f'{ref}/{env}/{name}', f'{out}/{env}/{stem}.reference.png')
        shutil.copy(f'{dele}/{env}/{name}', f'{out}/{env}/{stem}.delivery.png')
PY
for env in webkit-light-phone webkit-dark-phone; do
  mkdir -p "$E/shots/p0-standard/$env"
  cp "$R/f-p0-standard-out/pages.browser.mjs-profile-$env"/profile-validation-{expected,actual,diff}.png "$E/shots/p0-standard/$env/"
done
for env in chromium-light-desktop webkit-dark-phone; do
  mkdir -p "$E/shots/p41-delivery/$env"
  cp "$R/f-p41-del-shots/$env"/*.png "$E/shots/p41-delivery/$env/"
done

# Admin → Sign-in: geometry for all 8 environments, screenshots for two.
for side in ref del; do
  for env in $(ls "$R/admin-signin-$side"); do
    mkdir -p "$E/admin-signin/$env"
    cp "$R/admin-signin-$side/$env/admin-signin.json" "$E/admin-signin/$env/$side.json"
  done
  for env in chromium-light-desktop webkit-light-phone; do
    cp "$R/admin-signin-$side/$env/admin-signin.png" "$E/admin-signin/$env/$side.png"
  done
done

# Probe outputs: the WebKit phone notice, and the first frames of floating layers in dialogs.
cp "$R/toast-reference.json" "$E/toast-root-cause/reference.json"
cp "$R/toast-delivery.json" "$E/toast-root-cause/delivery.json"
cp "$R"/frames-*.json "$E/frames/"

# The isolation spec and config as run (absolute paths are this worktree's).
cp "$S/isolation/isolation.config.mjs" "$S/isolation/isolation.browser.mjs" "$E/isolation/"
cp "$R/iso-force0.log" "$E/isolation/run-as-is.txt"
cp "$R/iso-force1.log" "$E/isolation/run-forced-read.txt"

# Scripts as run.
cp "$S/scripts/formal-runs.sh" "$S/scripts/checks.sh" "$S/scripts/followup.sh" "$S/scripts/final.sh" "$S/scripts/pilot-port.sh" "$S/scripts/pilot-rerun2.sh" "$S/scripts/noise-repeat.sh" \
   "$S/scripts/make-reference.sh" "$S/scripts/admin-signin-shots.mjs" "$S/scripts/probe.mjs" "$S/scripts/probe-scenarios.mjs" "$E/scripts/"
du -sh "$E"
