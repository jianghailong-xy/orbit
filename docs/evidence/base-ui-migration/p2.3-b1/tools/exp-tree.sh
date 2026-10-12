#!/usr/bin/env bash
# Usage: exp-tree.sh <label> <patch-command...> — scratch tree of the project tip 77233e226 with an experiment patch, built.
set -euo pipefail
REPO=/root/.orbit/worktrees/bf593adf-7724-576c-968c-fcd10880a595
B=/var/tmp/p23b1
LABEL=$1; shift
TREE=$B/trees/$LABEL
LOG=$B/logs/build-$LABEL.log
{
  [ -d "$TREE" ] || git -C "$REPO" worktree add --detach "$TREE" 77233e226b4e8a96d38517a4a68329052d5f04d6
  git -C "$TREE" checkout -- src/web/src
  "$@" "$TREE"
  git -C "$TREE" diff -- src/web/src > "$B/logs/exp-$LABEL.diff"
  [ -e "$TREE/node_modules" ] || (cd "$TREE" && bash scripts/worktree-overlay.sh)
  (cd "$TREE" && env -u PUBLIC_ORIGIN npm run build -w @orbit/shared && env -u PUBLIC_ORIGIN npm run build -w @orbit/web)
  touch "$TREE/.b1-built"
} > "$LOG" 2>&1 || { echo "BUILD FAILED $LABEL"; tail -20 "$LOG"; exit 1; }
echo "$LABEL built ($(wc -l < "$B/logs/exp-$LABEL.diff") diff lines)"
