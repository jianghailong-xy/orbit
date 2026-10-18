#!/usr/bin/env bash
# Usage: p0-originals.sh <tree> <outdir> [playwright args] — the P0 tests of <tree> with every screenshot
# written to <outdir>/snapshots (--update-snapshots=all), the method of
# docs/evidence/base-ui-migration/p0-drift/tools/same-commit-originals.sh: the same build as
# pretest:ui-migration, then the unchanged P0 tests and fixtures through that tree's drift.config.mjs, in a
# private network namespace (VITE_ONLY=1: shared build and `vite build` without `tsc -b`); keeps the environment record and the tree's commit and status.
set -uo pipefail
T=$1 OUT=$2; shift 2
if [ -e "$OUT" ]; then echo "refusing: $OUT exists"; exit 2; fi
mkdir -p "$OUT"
(cd "$T" && git rev-parse HEAD && git status --short) > "$OUT/tree.txt"
cp "$T/docs/evidence/base-ui-migration/p0-drift/tools/drift.config.mjs" "$T/src/web/ui-migration/drift.config.mjs"
if [ "${VITE_ONLY:-}" = 1 ]; then BUILD='npm run build -w @orbit/shared && cd src/web && npx vite build'; else BUILD='npm run build -w @orbit/shared && npm run build -w @orbit/web'; fi
(cd "$T" && echo "build: $BUILD" && env -u FORCE_COLOR -u PUBLIC_ORIGIN bash -c "$BUILD") > "$OUT/build.txt" 2>&1 \
  || { echo "build failed"; rm -f "$T/src/web/ui-migration/drift.config.mjs"; exit 2; }
(cd "$T/src/web" && find dist -type f -print0 | sort -z | xargs -0 sha256sum) > "$OUT/dist.sha256"
cd "$T/src/web"
start=$(date -u +%FT%TZ)
env -u FORCE_COLOR -u PUBLIC_ORIGIN NO_COLOR=1 TMPDIR=/mnt/data/tmp/34cBi0yt6bFcSmbJFgDPj/tmp DRIFT_SNAPSHOTS="$OUT/snapshots" DRIFT_OUTPUT="$OUT/output" DRIFT_APP="$T/src/web" \
  nice -n "${NICE:--10}" unshare -n bash -c 'ip link set lo up && exec "$@"' bash npx playwright test --config ui-migration/drift.config.mjs --update-snapshots=all "$@" > "$OUT/output.txt" 2>&1
code=$?
rm -f "$T/src/web/ui-migration/drift.config.mjs"
cp "$T/src/web/.ui-migration-results/environment.json" "$OUT/environment.json"
echo "commit $(git -C "$T" rev-parse HEAD) exit $code start $start end $(date -u +%FT%TZ) screenshots $(find "$OUT/snapshots" -name '*.png' | wc -l) environment $(sha256sum < "$OUT/environment.json" | cut -c1-64)" | tee "$OUT/summary.txt"
tail -4 "$OUT/output.txt"
exit $code
