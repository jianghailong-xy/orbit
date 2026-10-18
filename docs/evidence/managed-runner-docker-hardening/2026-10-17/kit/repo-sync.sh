#!/bin/bash
# Bring a commit under test into the bare repository the D8 test host clones from (/repo.git inside it):
#   repo-sync.sh <branch name there> <ref or commit of the shared repository>
# Fetched with some history, so that the test host can check out both the commit a deployment was installed from
# and the one it is upgraded to. Run on the HPC host.
set -euo pipefail
T=/mnt/data/tmp/34hXCWEWAgHqtrxZsMBOh
NAME="$1"; SOURCE="$2"
[ -d "$T/repo.git" ] || git init -q --bare "$T/repo.git"
COMMIT="$(git -C /root/orbit rev-parse --verify "$SOURCE^{commit}")"
git -C "$T/repo.git" fetch -q --no-tags --depth 50 file:///root/orbit "$COMMIT"
git -C "$T/repo.git" update-ref "refs/heads/$NAME" "$COMMIT"
echo "$NAME $(git -C "$T/repo.git" rev-parse "refs/heads/$NAME")"
