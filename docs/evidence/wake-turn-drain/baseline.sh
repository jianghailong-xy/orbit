#!/usr/bin/env bash
# The new specs against the baseline's production code: the six runtime files this task changed are put back to
# 1031a2052 in place (git show; the index is not touched), the new specs stay, both specs run, then the fixed files
# are copied back and the working tree's diff is compared byte for byte with the one saved before.
set -u
WT=/root/.orbit/worktrees/f960a862-b78e-5903-bcae-a51abdf9dfcb
D=/mnt/data/tmp/34pj6T76
OUT=$D/baseline
rm -rf "$OUT"; mkdir -p "$OUT"
cd "$WT" || exit 2
FILES="src/apiserver/src/runner-api/wake-turn-withdraw.ts src/apiserver/src/runner-api/scheduled-wakeup.ts src/apiserver/src/runner-api/scheduled-wakeup.worker.ts src/apiserver/src/realtime/reaper.service.ts src/apiserver/src/runner-api/runner-api.controller.ts src/apiserver/src/sessions/sessions.service.ts"
git diff --binary > "$OUT/fix.patch"
sha256sum "$OUT/fix.patch" | tee "$OUT/fix.patch.sha"
for f in $FILES; do mkdir -p "$OUT/fixed/$(dirname "$f")"; cp -p "$f" "$OUT/fixed/$f"; git show "1031a2052:$f" > "$f"; done
for f in $FILES; do git diff --quiet 1031a2052 -- "$f" && echo "baseline: $f = 1031a2052"; done
"$D/devpg.sh" build > "$OUT/build.txt" 2>&1; echo "build-exit=$?" | tee -a "$OUT/build.txt"
"$D/devpg.sh" run src/apiserver/src/runner-api/wake-turn-drain.pg.spec.ts > "$OUT/drain.txt" 2>&1; echo "drain-exit=$?" | tee -a "$OUT/drain.txt"
(cd src/apiserver && node --test --test-reporter=spec build/realtime/reaper-push-wiring.spec.js) > "$OUT/wiring.txt" 2>&1; echo "wiring-exit=$?" | tee -a "$OUT/wiring.txt"
for f in $FILES; do cp -p "$OUT/fixed/$f" "$f"; done
git diff --binary > "$OUT/fix-after.patch"
sha256sum "$OUT/fix-after.patch"
if cmp -s "$OUT/fix.patch" "$OUT/fix-after.patch"; then echo "RESTORED: the working tree's diff is byte for byte the fix again"; else echo "RESTORE MISMATCH"; fi
command grep -a -E '^\s*(✔|✖) |^ℹ (tests|pass|fail)' "$OUT/drain.txt" "$OUT/wiring.txt"
