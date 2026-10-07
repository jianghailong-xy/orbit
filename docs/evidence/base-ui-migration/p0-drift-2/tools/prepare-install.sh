#!/usr/bin/env bash
# Usage: prepare-install.sh <rev>
# One shared dependency installation per package-lock.json: the root and workspace manifests of <rev>
# and `npm ci --ignore-scripts --include=dev --include=optional` (the command scripts/worktree-overlay.sh
# uses for an isolated install), under /var/tmp/p0d2/nm/<lock blob, 8 chars>.
set -euo pipefail
REPO=/root/.orbit/worktrees/a9dde6c0-7168-56e2-83f6-5744fa7e725f
SHA=$(git -C "$REPO" rev-parse --verify "$1^{commit}")
LOCK=$(git -C "$REPO" rev-parse "$SHA:package-lock.json" | cut -c1-8)
DIR=/var/tmp/p0d2/nm/$LOCK
[ -f "$DIR/.installed" ] && { echo "$LOCK already installed"; exit 0; }
mkdir -p "$DIR"
git -C "$REPO" archive "$SHA" package.json package-lock.json src/shared/package.json src/apiserver/package.json src/web/package.json | tar -x -C "$DIR"
(cd "$DIR" && npm ci --ignore-scripts --include=dev --include=optional --no-audit --no-fund) > /var/tmp/p0d2/logs/install-$LOCK.log 2>&1
echo "$SHA" > "$DIR/.installed"
echo "$LOCK installed from $SHA"
