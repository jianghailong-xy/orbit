#!/usr/bin/env bash
# Usage: prepare-tree.sh <rev> [label]
# A lean build tree for <rev> under /var/tmp/p0d2/trees/<label|short>: `git archive` of the files the
# Web build reads (root manifests and tsconfig.base.json, src/shared, src/web, the apiserver manifest so
# the workspace exists), the shared install for <rev>'s package-lock.json (prepare-install.sh), and
# @orbit/shared linked to THIS tree's src/shared as scripts/worktree-overlay.sh does. Then
# @orbit/shared and @orbit/web are built exactly as pretest:ui-migration does (PUBLIC_ORIGIN unset),
# and the SHA-256 of every file in the production dist is recorded.
set -euo pipefail
REPO=/root/.orbit/worktrees/a9dde6c0-7168-56e2-83f6-5744fa7e725f
B=/var/tmp/p0d2
SHA=$(git -C "$REPO" rev-parse --verify "$1^{commit}")
LABEL=${2:-${SHA:0:9}}
TREE=$B/trees/$LABEL
LOG=$B/logs/build-$LABEL.log
[ -f "$TREE/.built" ] && { echo "$LABEL already built"; exit 0; }
LOCK=$(git -C "$REPO" rev-parse "$SHA:package-lock.json" | cut -c1-8)
exec 3>&1 >"$LOG" 2>&1
trap 'echo "BUILD FAILED $LABEL (see $LOG)" >&3; tail -15 "$LOG" >&3' ERR
echo "# prepare-tree $SHA ($LABEL) lock $LOCK $(date -u +%FT%TZ)"
"$B/scripts/prepare-install.sh" "$SHA"
NM=$B/nm/$LOCK
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
