#!/bin/bash
# mkprobe.sh <repo> <base-commit>: the probe commit — <base-commit> plus .rcp-probe/ and the probe's client.yml in
# place of .github/workflows/client.yml — built in a temporary index, with no checkout. Prints the new commit.
set -euo pipefail
repo=$1; base=$2
kit=/mnt/data/tmp/recap07-probe
cd "$repo"
export GIT_INDEX_FILE=$(mktemp /tmp/rcp-index.XXXXXX)
trap 'rm -f "$GIT_INDEX_FILE"' EXIT
git read-tree "$base"
add() {  # $1 file on disk, $2 path in the tree, $3 mode
  local blob
  blob=$(git hash-object -w "$1")
  git update-index --add --cacheinfo "$3,$blob,$2"
}
for f in Info.plist ProbeArgs.swift RcpSweep.swift project.yml stub.py README.md ios/RcpProbe.swift mac/RcpMacProbe.swift \
         mac/RcpVariants.swift base/RecapCardView.swift UITests/ProbeCase.swift UITests/RecapShotTests.swift; do
  add "$kit/.rcp-probe/$f" ".rcp-probe/$f" 100644
done
add "$kit/.rcp-probe/run.sh" ".rcp-probe/run.sh" 100755
add "$kit/client.yml" ".github/workflows/client.yml" 100644
tree=$(git write-tree)
git commit-tree "$tree" -p "$base" -m "probe: the recap card's ⋯ on iPhone and Mac (never merged)" \
  -m "The change's commit $base plus .rcp-probe/ and the probe's client.yml, which runs client.yml's own gates and photographs the recap card (docs/mocks/session-recap-display/07-last-line B)."
