#!/usr/bin/env bash
# Usage: make-runner.sh <rev> <name> <built tree label with the same src/shared>
# A runner template, as p0-drift-3/tools/make-runner.sh: the P0 tests of <rev> (src/web/ui-migration) and
# the files their globalSetup reads (P0.2 environment record, baseline summary and originals, both
# registered layers, and the decision/isolation documents their entries cite), with Playwright from the
# isolated install of the same lockfile, plus p0d5.config.mjs (screenshots written to a scratch
# directory, preview server started in the tree under test).
set -euo pipefail
REPO=/root/.orbit/worktrees/a1f992c4-adcc-5b68-bd13-387124116c3d
B=/mnt/data/tmp/34cFgyWHIYDslABFPloEM
SHA=$(git -C "$REPO" rev-parse --verify "$1^{commit}")
DIR=$B/runners/$2
rm -rf "$DIR"; mkdir -p "$DIR"
E=docs/evidence/base-ui-migration
DOCS=$(git -C "$REPO" show "$SHA:$E/p0-drift/reference/registry.json" "$SHA:$E/p0-drift/accepted/registry.json" | python3 -c '
import json,sys
dec=json.JSONDecoder(); s=sys.stdin.read(); i=0; out=set()
while i < len(s):
    while i < len(s) and s[i].isspace(): i+=1
    if i >= len(s): break
    o,i=dec.raw_decode(s,i)
    for e in o["screenshots"]:
        mf=e.get("migrationFix")
        if mf: out.update([mf["decision"]["document"], mf["isolation"]])
        if "decision" in e: out.add(e["decision"]["document"])
print(" ".join("docs/evidence/base-ui-migration/"+p for p in sorted(out)))')
git -C "$REPO" archive "$SHA" src/web/package.json src/web/ui-migration $E/p0.2/environment.json $E/p0.2/baseline-run/summary.json \
  $E/p0.2/screenshots $E/p0-drift/reference $E/p0-drift/accepted $DOCS | tar -x -C "$DIR"
ln -s "$B/wt/base/node_modules" "$DIR/node_modules"
# fixtures.mjs imports uuidToBase62 from @orbit/shared: the runner commit's own shared, built.
SHARED_TREE=$B/trees/$3
test "$(git -C "$REPO" rev-parse "$SHA:src/shared")" = "$(git -C "$REPO" rev-parse "$(cat "$SHARED_TREE/.commit"):src/shared")"
mkdir -p "$DIR/src/node_modules/@orbit"
cp -a "$SHARED_TREE/src/shared" "$DIR/src/shared"
ln -s "$DIR/src/shared" "$DIR/src/node_modules/@orbit/shared"
cp "$B/scripts/p0d5.config.mjs" "$DIR/src/web/ui-migration/p0d5.config.mjs"
printf '%s\n' "$SHA" > "$DIR/.commit"
echo "runner $2 = $SHA (cited documents: $DOCS)"
