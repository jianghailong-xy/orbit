#!/usr/bin/env bash
# Usage: prepare-tree.sh <rev> [label]
# A lean build tree for <rev> under $B/trees/<label|short>, as p0-drift-3/tools/prepare-tree.sh:
# `git archive` of the files the Web build reads (root manifests and tsconfig.base.json, src/shared,
# src/web, the apiserver manifest so the workspace exists), with dependencies from the isolated install in
# $B/wt/base (npm ci --offline --ignore-scripts --include=dev --include=optional of the same
# package-lock.json; the script refuses a <rev> with another lockfile), and @orbit/shared linked to THIS
# tree's src/shared. Then @orbit/shared and @orbit/web are built exactly as pretest:ui-migration does
# (PUBLIC_ORIGIN unset), and the SHA-256 of every production dist file is recorded.
set -euo pipefail
REPO=/root/.orbit/worktrees/29948cd5-4699-56fe-be2f-3864e2bd39a6
B=/mnt/data/tmp/34dI9lY63LC7ZEZHbJ4bG
export TMPDIR=$B/tmp
SHA=$(git -C "$REPO" rev-parse --verify "$1^{commit}")
LABEL=${2:-${SHA:0:9}}
TREE=$B/trees/$LABEL
LOG=$B/logs/build-$LABEL.log
[ -f "$TREE/.built" ] && { echo "$LABEL already built"; exit 0; }
# Batch 8: two lanes may reach the same tree; the second waits for the first one's build instead of starting its own.
if ! mkdir "$TREE.lock" 2>/dev/null; then
  for _ in $(seq 120); do [ -f "$TREE/.built" ] && { echo "$LABEL built by another lane"; exit 0; }; sleep 5; done
  echo "$LABEL: another lane's build did not finish"; exit 3
fi
trap 'rmdir "$TREE.lock"' EXIT
LOCK=$(git -C "$REPO" rev-parse "$SHA:package-lock.json")
INSTALLED=$(git -C "$B/wt/base" rev-parse "HEAD:package-lock.json")
[ "$LOCK" = "$INSTALLED" ] || { echo "$SHA has lockfile $LOCK, the shared install is $INSTALLED"; exit 2; }
NM=$B/wt/base
exec 3>&1 >"$LOG" 2>&1
trap 'echo "BUILD FAILED $LABEL (see $LOG)" >&3; tail -15 "$LOG" >&3' ERR
echo "# prepare-tree $SHA ($LABEL) lock ${LOCK:0:8} $(date -u +%FT%TZ)"
rm -rf "$TREE"; mkdir -p "$TREE"
git -C "$REPO" archive "$SHA" package.json package-lock.json tsconfig.base.json src/shared src/web src/apiserver/package.json | tar -x -C "$TREE"
printf '%s\n' "$SHA" > "$TREE/.commit"
printf 'src/web %s\nsrc/shared %s\n' "$(git -C "$REPO" rev-parse "$SHA:src/web")" "$(git -C "$REPO" rev-parse "$SHA:src/shared")" > "$TREE/.trees"
ln -s "$NM/node_modules" "$TREE/node_modules"
mkdir -p "$TREE/src/node_modules/@orbit" "$TREE/src/web/node_modules/@orbit"
ln -s "$TREE/src/shared" "$TREE/src/node_modules/@orbit/shared"
for d in "$NM/src/web/node_modules"/* "$NM/src/web/node_modules"/.[!.]*; do
  [ -e "$d" ] || continue
  case "$(basename "$d")" in .vite|.vite-temp|@orbit) continue ;; esac
  ln -s "$d" "$TREE/src/web/node_modules/$(basename "$d")"
done
ln -s "$TREE/src/shared" "$TREE/src/web/node_modules/@orbit/shared"
cd "$TREE"
env -u PUBLIC_ORIGIN npm run build -w @orbit/shared
(cd src/web && node -e "const r=require.resolve('@orbit/shared'); if(!r.startsWith(process.argv[1])) {console.error('@orbit/shared resolves to '+r); process.exit(1)} console.log('@orbit/shared -> '+r)" "$TREE/")
env -u PUBLIC_ORIGIN npm run build -w @orbit/web
(cd src/web/dist && find . -type f | LC_ALL=C sort | xargs sha256sum) > "$B/dists/$LABEL.sha256"
echo "dist digest: $(sha256sum < "$B/dists/$LABEL.sha256" | cut -c1-64)"
touch "$TREE/.built"
echo "$LABEL ($SHA) built: $(tail -1 "$LOG")" >&3
