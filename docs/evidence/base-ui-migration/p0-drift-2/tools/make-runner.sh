#!/usr/bin/env bash
# Usage: make-runner.sh <rev> <name> [tree with the same src/shared, built]
# A runner template: the P0 tests of <rev> (src/web/ui-migration) and the files their globalSetup reads
# (P0.2 environment record, baseline summary and originals, both registered layers), with Playwright
# from the shared install of the project tip's lockfile, plus p0d2.config.mjs (screenshots written to a
# scratch directory, preview server started in the tree under test).
set -euo pipefail
REPO=/root/.orbit/worktrees/a9dde6c0-7168-56e2-83f6-5744fa7e725f
B=/var/tmp/p0d2
SHA=$(git -C "$REPO" rev-parse --verify "$1^{commit}")
DIR=$B/runners/$2
rm -rf "$DIR"; mkdir -p "$DIR"
E=docs/evidence/base-ui-migration
git -C "$REPO" archive "$SHA" src/web/package.json src/web/ui-migration $E/p0.2/environment.json $E/p0.2/baseline-run/summary.json \
  $E/p0.2/screenshots $E/p0-drift/reference $E/p0-drift/accepted | tar -x -C "$DIR"
ln -s "$B/nm/f03a6e32/node_modules" "$DIR/node_modules"
# fixtures.mjs imports uuidToBase62 from @orbit/shared: the runner commit's own shared, built.
SHARED_TREE=$B/trees/${3:-${SHA:0:9}}
test "$(cat "$SHARED_TREE/.commit")" = "$(git -C "$REPO" rev-parse "$SHA")" || test "$(git -C "$REPO" rev-parse "$SHA:src/shared")" = "$(git -C "$REPO" rev-parse "$(cat "$SHARED_TREE/.commit"):src/shared")"
mkdir -p "$DIR/src/node_modules/@orbit"
cp -a "$SHARED_TREE/src/shared" "$DIR/src/shared"
ln -s "$DIR/src/shared" "$DIR/src/node_modules/@orbit/shared"
cp "$B/scripts/p0d2.config.mjs" "$DIR/src/web/ui-migration/p0d2.config.mjs"
printf '%s\n' "$SHA" > "$DIR/.commit"
echo "runner $2 = $SHA"
