#!/usr/bin/env bash
# Usage: same-commit-originals.sh <tree> <outdir> <playwright selection...> — the P0 tests of <tree> with screenshots written
# to <outdir>/snapshots (--update-snapshots=all, the P3.1 same-commit method), in their own network namespace,
# after the same build as pretest:ui-migration; keeps the environment record of the run.
set -uo pipefail
WT=/root/.orbit/worktrees/1709cbc5-0883-5919-8506-836771412386
T=$1 OUT=$2; shift 2
rm -rf "$OUT"; mkdir -p "$OUT"
cp "$WT/docs/evidence/base-ui-migration/p0-drift/tools/drift.config.mjs" "$T/src/web/ui-migration/drift.config.mjs"
(cd "$T" && npm run build -w @orbit/shared && npm run build -w @orbit/web) > "$OUT/build.txt" 2>&1 || { echo "build failed"; exit 2; }
cd "$T/src/web"
env -u FORCE_COLOR -u PUBLIC_ORIGIN NO_COLOR=1 DRIFT_SNAPSHOTS="$OUT/snapshots" DRIFT_OUTPUT="$OUT/output" DRIFT_APP="$T/src/web" \
  unshare -n bash -c 'ip link set lo up && exec "$@"' bash npx playwright test --config ui-migration/drift.config.mjs --update-snapshots=all "$@" > "$OUT/output.txt" 2>&1
code=$?
cp "$T/src/web/.ui-migration-results/environment.json" "$OUT/environment.json"
echo "commit $(git -C "$T" rev-parse HEAD) exit $code screenshots $(find "$OUT/snapshots" -name '*.png' | wc -l) environment $(sha256sum < "$OUT/environment.json" | cut -c1-64)"
exit $code
