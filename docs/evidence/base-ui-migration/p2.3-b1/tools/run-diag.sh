#!/usr/bin/env bash
# Usage: run-diag.sh <app-label> <run-label> [playwright args...]
# Runs the B1 state diagnosis (b1-state.diag.mjs: the unchanged P0 settings/profile/session scenarios
# and capture) from the runner tree (project tip tests) against the production build of
# trees/<app-label>, in its own network namespace; every screenshot is written to runs/<run-label>/snapshots.
set -uo pipefail
B=/var/tmp/p23b1
RUNNER=$B/trees/tip
APP=$B/trees/$1
LABEL=$2
RUN=$B/runs/$2
shift 2
mkdir -p "$RUN"
export B1_SNAPSHOTS=$RUN/snapshots B1_OUTPUT=$RUN/output B1_APP=$APP/src/web B1_MATCH=${B1_MATCH:-b1-state.diag.mjs}
{
  echo "{\"app\": \"$APP\", \"commit\": \"$(git -C "$APP" rev-parse HEAD)\", \"dirty\": \"$(git -C "$APP" status --porcelain -- src/web/src | tr '\n' ' ')\", \"runner\": \"$(git -C "$RUNNER" rev-parse HEAD)\", \"started\": \"$(date -u +%FT%TZ)\", \"args\": \"$*\"}"
  unshare -n bash -c 'ip link set lo up && cd "$0/src/web" && exec env -u FORCE_COLOR -u PUBLIC_ORIGIN NO_COLOR=1 node ../../node_modules/@playwright/test/cli.js test --config ui-migration/b1.config.mjs --update-snapshots=all "$@"' \
    "$RUNNER" "$@"
  echo "# exit $?"
} > "$RUN/output.txt" 2>&1
code=$(tail -1 "$RUN/output.txt")
echo "$LABEL: $code; $(grep -E '^\s+[0-9]+ (passed|failed|flaky|skipped)' "$RUN/output.txt" | tr -s ' ' | tr '\n' ';')"
