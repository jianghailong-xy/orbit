#!/usr/bin/env bash
# red-green.sh: the unit tests this fix adds, on the source before the fix and on the delivery, into v1/unit:
#  - before: the reference tree (the delivery with the fix reverted) with the delivery's two test files written in;
#  - after: the delivery tree.
# Vitest runs only those two files, in a memory-capped scope. The reference tree is put back afterwards.
set -u
V=/mnt/data/tmp/34dTUqxH5MjymjtUhs5C5/v1
R=$V/unit
TESTS=(src/web/src/components/ui/ImagePreview.test.tsx src/web/src/components/WorkspaceView.composerThumbnail.test.tsx)
mkdir -p "$R"
delivery=$(git -C "$V/del" rev-parse HEAD)
for f in "${TESTS[@]}"; do git -C "$V/del" show "$delivery:$f" > "$V/ref/$f"; done
run() {
  local name=$1 tree=$2
  { echo "tree: $tree"; echo "head: $(git -C "$tree" rev-parse HEAD)"; echo "uncommitted:"; git -C "$tree" status --short -- src/web
    echo "source under test: $(sha256sum "$tree/src/web/src/components/ui/Image.tsx" | cut -c1-12) Image.tsx, $(grep -c 'PREVIEW_IMAGE_LABEL' "$tree/src/web/src/components/WorkspaceView.tsx") PREVIEW_IMAGE_LABEL lines in WorkspaceView.tsx"
    echo "tests: $(cd "$tree" && sha256sum "${TESTS[@]}" | cut -c1-12 | tr '\n' ' ')"; echo
    (cd "$tree/src/web" && systemd-run --scope --quiet -p MemoryMax=6G sh -c 'echo 500 > /proc/self/oom_score_adj && exec "$@"' sh \
      npx vitest run --reporter=verbose src/components/ui/ImagePreview.test.tsx src/components/WorkspaceView.composerThumbnail.test.tsx)
    echo "exit=$?"; } > "$R/$name.txt" 2>&1
  grep -E "^exit=|Test Files|Tests " "$R/$name.txt"
}
run before "$V/ref"
run after "$V/del"
git -C "$V/ref" checkout -q -- src/web/src/components/ui/ImagePreview.test.tsx
rm -f "$V/ref/src/web/src/components/WorkspaceView.composerThumbnail.test.tsx"
echo "reference restored: $(git -C "$V/ref" status --short -- src/web | wc -l) uncommitted paths under src/web"
