#!/bin/bash
# archsuite.sh <label> <rev>: OrbitKit's full suite in swift:6.1 (ci.yml's Swift core) on a git archive of <rev>
# holding what the suite reads — src, contracts and docs without images and evidence, then the evidence folders
# the tests cite. Output in runs/<label>.txt.
set -o pipefail
K=/mnt/data/tmp/34pVMqwUhJE0RGvrL0ziL
WT=/root/.orbit/worktrees/56867ee8-0393-5994-a045-e70534e40745
label=$1; rev=$2
sha=$(git -C "$WT" rev-parse "$rev") || exit 2
tree=$K/trees/$label
base=(src contracts docs ':(exclude)docs/evidence')
for ext in png jpg jpeg JPEG gif webp mp4 mov; do base+=(":(exclude,glob)docs/**/*.$ext"); done
extra=()
for p in $(command grep -a -rhoE 'docs/evidence/[A-Za-z0-9_.-]+' "$WT/src/macos/OrbitKit/Tests" | sort -u); do
  [ -n "$(git -C "$WT" ls-tree -d "$sha" "$p")" ] && extra+=("$p")
done
if [ ! -f "$tree/.archived-$sha" ]; then
  rm -rf "${tree:?}"; mkdir -p "$tree"
  git -C "$WT" archive "$sha" -- "${base[@]}" | tar -x -C "$tree" || { echo "archive failed"; exit 2; }
  if [ ${#extra[@]} -gt 0 ]; then git -C "$WT" archive "$sha" -- "${extra[@]}" | tar -x -C "$tree" || exit 2; fi
  touch "$tree/.archived-$sha"
fi
mkdir -p "$K/build-$label" "$K/runs"
echo "== $label = $sha at $(date -u +%FT%TZ)" | tee "$K/runs/$label.txt"
docker run --rm --memory=5g --memory-swap=7g --oom-score-adj=1000 -v "$tree":/repo \
  -v "$K/build-$label":/repo/src/macos/OrbitKit/.build -w /repo/src/macos/OrbitKit swift:6.1 \
  swift test -j 4 >> "$K/runs/$label.txt" 2>&1
code=$?
echo "== exit $code at $(date -u +%FT%TZ)" | tee -a "$K/runs/$label.txt"
grep -a -E "Executed [0-9]+ tests" "$K/runs/$label.txt" | tail -1
grep -a -E "error: |: error -\[" "$K/runs/$label.txt" | head -40
exit $code
