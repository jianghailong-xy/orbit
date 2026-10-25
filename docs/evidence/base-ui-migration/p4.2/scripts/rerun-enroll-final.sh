#!/usr/bin/env bash
# A third shot of the merged tip's runs that differs from every earlier run of its own: P4.2's p42-enroll-loading in
# Chromium light phone (the loading spinner's frame on the orbit register approval page). Its test runs three more
# times on the same tree (a794459b1), each run into its own directory, as rerun-odd-final.sh did for the other two;
# then the shot's hash in every run of every round. Same isolation as final-v2.sh; outputs in runs-final/rerun-*.
set -u
V=/mnt/data/tmp/34Za39Feocgj42rrBYwzl/v2
R=$V/runs-final
DEL=$V/del
export TMPDIR=$V/tmp
gate() {
  local a; a=$(df --output=avail -BM / | tail -1 | tr -dc '0-9')
  if [ "$a" -lt 2048 ]; then echo "== STOP: / has ${a}M available (< 2 GB) $(date -u +%T)"; exit 3; fi
}
run() {
  local name=$1; shift
  gate
  { echo "argv: $*"; echo "head: $(git -C $DEL rev-parse HEAD)"; echo "started: $(date -u +%FT%TZ)"; echo; } > "$R/$name.txt"
  ( cd "$DEL/src/web" && nice -n -5 unshare -n bash -c 'ip link set lo up && exec "$@"' bash "$@" ) >> "$R/$name.txt" 2>&1
  echo "exit=$?" >> "$R/$name.txt"
  echo "== $name: $(grep -E '^\s+[0-9]+ (passed|failed|skipped)|^exit=' "$R/$name.txt" | tr -s ' ' | tr '\n' ' ')"
}
[ "$(git -C $DEL rev-parse --short=9 HEAD)" = a794459b1 ] || { echo "v2/del is not at a794459b1"; exit 2; }
for i in 1 2 3; do
  run rerun-p42-enroll-$i env P42_SNAPSHOTS=$R/rerun-p42-enroll-$i-shots P42_OUTPUT=$R/rerun-p42-enroll-$i-out \
    npx playwright test --config ui-migration/p42.config.mjs --update-snapshots=all --project chromium-light-phone -g "approving orbit register"
done
cd $V
s=chromium-light-phone/p42-enroll-loading
echo "== $s"
for f in runs-def134095/f-p42-ref runs-def134095/f-p42-del runs-bcc89c7af/f-p42-ref runs-bcc89c7af/f-p42-del killed-run-2/f-p42-ref \
         runs/f-p42-ref runs/f-p42-del runs-final/g-p42-del runs-final/rerun-p42-enroll-1 runs-final/rerun-p42-enroll-2 runs-final/rerun-p42-enroll-3; do
  [ -f "$f-shots/$s.png" ] && printf '   %-36s %s\n' "$f" "$(sha256sum "$f-shots/$s.png" | cut -c1-16)"
done
