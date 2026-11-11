#!/usr/bin/env bash
# Build a probe commit: $1 base commit, harness from /mnt/data/tmp/welcome-probe/h at .wlc-probe/, and the
# harness's ci/client.probe.yml as .github/workflows/client.yml. Prints the commit id.
set -euo pipefail
BASE=$1; H=/mnt/data/tmp/welcome-probe/h
export GIT_INDEX_FILE=$(mktemp -u /mnt/data/tmp/welcome-probe/idx.XXXX)
git read-tree "$BASE"
(cd "$H" && find . -type f ! -name '*.pyc' | sed 's#^\./##') | while read -r f; do
  sha=$(git hash-object -w "$H/$f")
  mode=100644; [ -x "$H/$f" ] && mode=100755
  git update-index --add --cacheinfo "$mode,$sha,.wlc-probe/$f"
done
sha=$(git hash-object -w "$H/ci/client.probe.yml")
git update-index --cacheinfo "100644,$sha,.github/workflows/client.yml"
tree=$(git write-tree)
rm -f "$GIT_INDEX_FILE"
git commit-tree "$tree" -p "$BASE" -m "probe: welcome card shots (never merged)"
