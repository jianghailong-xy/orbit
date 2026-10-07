#!/usr/bin/env bash
# Usage: collect-checks.sh <evidence dir> <check>...
# Copies /var/tmp/p0d3/checks/<check> into <evidence dir>/checks/<check>, slimmed to the project's evidence-volume
# rule of 2026-10-07: command output, environment check, exit code, expected-screenshot sources, summary,
# negative-control patch and trees, report.summary.json (the Playwright report without attachment bodies,
# report-summary.py) and profile-requests.json (profile-requests.py). Failure screenshots and raw per-test JSON
# are copied only where the README cites them (cite-files.txt); the rest stays in /var/tmp/p0d3/checks.
set -euo pipefail
EV=$1; shift
S=/var/tmp/p0d3/scripts
for c in "$@"; do
  SRC=/var/tmp/p0d3/checks/$c D=$EV/checks/$c
  mkdir -p "$D"
  for f in command-output.txt environment-check.txt exit.txt sources.json summary.json patch.diff trees.json; do
    [ -f "$SRC/$f" ] && cp "$SRC/$f" "$D/$f"
  done
  [ -f "$SRC/environment-check.txt" ] || { cmp -s "$SRC/environment.json" /root/.orbit/worktrees/af6cf858-d97c-59f2-9e13-65148229cc0a/docs/evidence/base-ui-migration/p0.2/environment.json && echo "environment.json == p0.2/environment.json ($(sha256sum < "$SRC/environment.json" | cut -c1-64))" || echo "environment DIFFERENT"; } > "$D/environment-check.txt"
  python3 $S/report-summary.py "$SRC/report.json" "$D/report.summary.json" > /dev/null
  ls "$SRC"/profile-evidence/*.json > /dev/null 2>&1 && python3 $S/profile-requests.py "$D/profile-requests.json" "$SRC"/profile-evidence/*.json > /dev/null
  echo "$c: $(ls "$D" | tr '\n' ' ')"
done
# Cited files only: "<check>/<path under the check>" per line.
[ -f /var/tmp/p0d3/cite-files.txt ] && while read -r rel; do
  [ -n "$rel" ] || continue
  mkdir -p "$EV/checks/$(dirname "$rel")"; cp "/var/tmp/p0d3/checks/$rel" "$EV/checks/$rel"; echo "cited: $rel"
done < /var/tmp/p0d3/cite-files.txt
