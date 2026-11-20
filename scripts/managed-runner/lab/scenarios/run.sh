#!/usr/bin/env bash
# Bring the managed-runner lab up from nothing on this machine and run one scenario on it.
#   sudo LAB_OUT=DIR run.sh SCENARIO
# SCENARIO names scenarios/SCENARIO.sh. A scenario runs with the browser switch
# (ORBIT_MANAGED_RUNNER_BROWSER_ENABLED) on, unless its file has the line `# lab-browser: off`.
# Needs, in this checkout: the shared, apiserver and web builds, and Playwright's Chromium; on the
# host: root, /dev/kvm, qemu, Docker, Go, socat, genisoimage, jq. LAB_DIR (lab.env) must be empty
# or a lab this script made. One lab per machine: nothing else may use LAB_DIR or the lab's ports.
#
# Writes to LAB_OUT: the scenario's screenshots and outputs, logs/, sessions/, checks.tsv and
# result.json ({"scenario", "sha", "result": "pass"|"fail", "checks": [...]}), and prints one line
# `SCENARIO <name>: PASS` or `SCENARIO <name>: FAIL`. Exits 0 only on PASS.
set -euo pipefail
NAME=${1:?usage: LAB_OUT=DIR run.sh SCENARIO}
FILE=$(cd "$(dirname "$0")" && pwd)/$NAME.sh
[ -f "$FILE" ] || { echo "no scenario $NAME ($FILE)" >&2; exit 2; }
. "$(dirname "$0")/common.sh"
require_root
BROWSER=on
grep -qx '# lab-browser: off' "$FILE" && BROWSER=off
SHA=$(git -C "$R" rev-parse HEAD)

finish() {
  local rc=$?
  lab_collect
  local result=pass
  { [ "$rc" = 0 ] && [ -s "$CHECKS" ] && ! grep -q '^fail' "$CHECKS"; } || result=fail
  python3 - "$CHECKS" "$OUT/result.json" "$NAME" "$SHA" "$result" "$BROWSER" "$rc" <<'PY'
import json, sys
checks = [dict(zip(('result', 'name'), line.rstrip('\n').split('\t', 1))) for line in open(sys.argv[1]) if line.strip()]
json.dump({'scenario': sys.argv[3], 'sha': sys.argv[4], 'result': sys.argv[5], 'browserSwitch': sys.argv[6],
           'exitCode': int(sys.argv[7]), 'checks': checks}, open(sys.argv[2], 'w'), indent=1)
PY
  chmod -R a+rX "$OUT"
  echo
  echo "SCENARIO $NAME: $(tr a-z A-Z <<<"$result") ($(grep -c '^pass' "$CHECKS" || true) passed, $(grep -c '^fail' "$CHECKS" || true) failed, exit $rc) at $SHA"
  [ "$result" = pass ] || exit 1
  exit 0
}
trap finish EXIT

echo "scenario $NAME at $SHA, browser switch $BROWSER, lab $LAB_DIR, output $OUT"
lab_up "$BROWSER"
step "scenario $NAME"
. "$FILE"
step "scenario $NAME ended"
