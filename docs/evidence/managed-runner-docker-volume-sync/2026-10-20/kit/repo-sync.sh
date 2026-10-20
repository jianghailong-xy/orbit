#!/bin/bash
# Bring a commit under test into the bare repository the D10 test host clones from (/repo.git inside it), on the HPC host:
#   repo-sync.sh <branch name there> <ref or commit of the shared repository or this worktree>
set -euo pipefail
T=/mnt/data/tmp/34ilx9dqVOKBeYZObuIjI
NAME="$1"; SOURCE="$2"; FROM="${3:-/root/orbit}"
[ -d "$T/repo.git" ] || git init -q --bare "$T/repo.git"
COMMIT="$(git -C "$FROM" rev-parse --verify "$SOURCE^{commit}")"
git -C "$T/repo.git" fetch -q --no-tags "$FROM" "$COMMIT"
git -C "$T/repo.git" update-ref "refs/heads/$NAME" "$COMMIT"
echo "$NAME $(git -C "$T/repo.git" rev-parse "refs/heads/$NAME")"
