#!/bin/bash
# swiftdev.sh <label> [swift test args...]: OrbitKit's suite in swift:6.1 (ci.yml's Swift core) on a copy of the
# working tree, with an incremental .build kept per label on /mnt/data. Output in runs/<label>.txt.
set -o pipefail
K=/mnt/data/tmp/34pVMqwUhJE0RGvrL0ziL
WT=/root/.orbit/worktrees/56867ee8-0393-5994-a045-e70534e40745
label=$1; shift
tree=$K/trees/$label
mkdir -p "$tree" "$K/build-$label" "$K/runs"
ex=(--exclude node_modules --exclude .build --exclude build --exclude dist --exclude '.gradle'
    --exclude '*.png' --exclude '*.jpg' --exclude '*.jpeg' --exclude '*.gif' --exclude '*.webp' --exclude '*.mp4' --exclude '*.mov')
rsync -a --delete "${ex[@]}" "$WT/src" "$WT/contracts" "$tree/"
rsync -a --delete "${ex[@]}" --exclude evidence "$WT/docs" "$tree/"
mkdir -p "$tree/docs/evidence"
for d in antigravity-google-login cursor-engine first-workspace-native ios-http-ip project-main-branch-reads project-main-branch-web; do
  [ -d "$WT/docs/evidence/$d" ] && rsync -a --delete "$WT/docs/evidence/$d" "$tree/docs/evidence/"
done
# card.JPEG / card.png are read by name: keep the mocks' root images.
cp -a "$WT"/docs/mocks/card.* "$tree/docs/mocks/" 2>/dev/null
echo "== $label at $(date -u +%FT%TZ): swift test $*" | tee "$K/runs/$label.txt"
docker run --rm --memory=5g --memory-swap=7g --oom-score-adj=1000 -v "$tree":/repo \
  -v "$K/build-$label":/repo/src/macos/OrbitKit/.build -w /repo/src/macos/OrbitKit swift:6.1 \
  swift test -j 4 "$@" >> "$K/runs/$label.txt" 2>&1
code=$?
echo "== exit $code at $(date -u +%FT%TZ)" | tee -a "$K/runs/$label.txt"
grep -a -E "Executed [0-9]+ tests" "$K/runs/$label.txt" | tail -2
grep -a -E "error: |: error -\[" "$K/runs/$label.txt" | head -60
exit $code
