#!/usr/bin/env bash
# recheck3.sh: the checks the second sync affects, on base d580e572d (project tip) and delivery 1243db2bb, in runs3/:
# standard P0 and P4.3a's cases on both trees, the resident spec and P4.3a's probe (two rounds on the delivery, one on the
# base), the AntD owner audit, OrbitKit's TaskListCopyParityTests; then the P4.3a comparison. Steps that did not get to
# their tests (webServer start timeout, external kill) are set aside and run again, up to three attempts.
set -u
T=/mnt/data/tmp/34coPBqt8gi229cVNds0E
R=$T/runs3
mkdir -p "$R" "$T/runs3-failed"
infra() { grep -qE 'Timed out waiting [0-9]+ms from config.webServer|^exit=143' "$1"; }
for attempt in 1 2 3; do
  for f in "$R"/*.txt; do [ -f "$f" ] && infra "$f" && mv "$f" "$T/runs3-failed/$(basename "$f" .txt).$(date -u +%H%M%S).txt"; done
  "$T/scripts/final3.sh" p0
  "$T/scripts/final3.sh" p43a
  "$T/scripts/final3.sh" stats
  "$T/scripts/final3.sh" audit
  left=0; for f in "$R"/*.txt; do [ -f "$f" ] && infra "$f" && left=$((left+1)); done
  echo "== attempt $attempt: $left steps without their tests"
  [ $left -eq 0 ] && break
done
"$T/scripts/compare3.sh"
# OrbitKit's parity test on the delivery (TaskListView.tsx is the same file as on 9c86b3dfe; the build directory is reused).
if ! grep -q '^exit=' "$R/swift-tasklist.txt" 2>/dev/null; then
  src=$T/swift/src-$(git -C "$T/fix" rev-parse --short=9 HEAD)
  [ -d "$src" ] || { mkdir -p "$src" && git -C "$T/fix" archive HEAD | tar -x -C "$src"; }
  { echo "argv: delivery $(git -C "$T/fix" rev-parse HEAD) (git archive): docker swift:6.1 swift test --filter TaskListCopyParityTests"; echo "started: $(date -u +%FT%TZ)"; echo
    nice -n 5 docker run --rm --memory=4g -v "$src":/repo -v "$T/swift/build":/build -w /repo/src/macos/OrbitKit swift:6.1 \
      swift test --scratch-path /build/del --filter TaskListCopyParityTests 2>&1 | grep -vE ': warning:|^\s+[0-9]+ \||^\s+\||^\s+`-|^\s*$'; echo "exit=${PIPESTATUS[0]}"; echo "ended: $(date -u +%FT%TZ)"; } > "$R/swift-tasklist.txt"
  echo "== swift-tasklist: $(grep -E 'Executed [0-9]+ test|^exit=' "$R/swift-tasklist.txt" | tail -2 | tr '\n' ' ')"
fi
echo "== recheck3 done $(date -u +%T)"
