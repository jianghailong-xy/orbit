#!/usr/bin/env bash
# VITE_ONLY=1 builds with the shared build and `vite build` only, without `tsc -b`.
# Usage: entry-shots.sh <tree> <p41|p42|pilot> <outdir> [playwright args] — builds <tree> as pretest:ui-migration
# does, then runs that same-commit entry (p41/p42/pilot.config.mjs) on the tree's production build with every
# screenshot written to <outdir>/shots (--update-snapshots=all), in a private network namespace.
set -uo pipefail
T=$1 E=$2 OUT=$3; shift 3
case $E in p41) CFG=p41.config.mjs V=P41;; p42) CFG=p42.config.mjs V=P42;; pilot) CFG=pilot.config.mjs V=P32;; *) echo "unknown entry"; exit 2;; esac
if [ -e "$OUT" ]; then echo "refusing: $OUT exists"; exit 2; fi
mkdir -p "$OUT"
(cd "$T" && git rev-parse HEAD && git status --short) > "$OUT/tree.txt"
if [ "${VITE_ONLY:-}" = 1 ]; then BUILD='npm run build -w @orbit/shared && cd src/web && npx vite build'; else BUILD='npm run build -w @orbit/shared && npm run build -w @orbit/web'; fi
(cd "$T" && echo "build: $BUILD" && env -u FORCE_COLOR -u PUBLIC_ORIGIN bash -c "$BUILD") > "$OUT/build.txt" 2>&1 \
 || { echo "build failed"; exit 2; }
cd "$T/src/web"
start=$(date -u +%FT%TZ)
env -u FORCE_COLOR -u PUBLIC_ORIGIN NO_COLOR=1 TMPDIR=/mnt/data/tmp/34cBi0yt6bFcSmbJFgDPj/tmp "${V}_SNAPSHOTS=$OUT/shots" "${V}_OUTPUT=$OUT/output" \
  nice -n "${NICE:--10}" unshare -n bash -c 'ip link set lo up && exec "$@"' bash npx playwright test --config "ui-migration/$CFG" --update-snapshots=all "$@" > "$OUT/output.txt" 2>&1
code=$?
cp "$T/src/web/.ui-migration-results/environment.json" "$OUT/environment.json" 2>/dev/null
echo "commit $(git -C "$T" rev-parse HEAD) entry $E exit $code start $start end $(date -u +%FT%TZ) screenshots $(find "$OUT/shots" -name '*.png' 2>/dev/null | wc -l)" | tee "$OUT/summary.txt"
tail -6 "$OUT/output.txt"
exit $code
