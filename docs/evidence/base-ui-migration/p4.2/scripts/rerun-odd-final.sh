#!/usr/bin/env bash
# Two shots of the merged tip's runs differ from every earlier run of theirs: the P0 matrix's projects-list in
# Chromium dark phone (3 pixels) and the pilot's share dialog in WebKit light desktop (the dependency-graph edge
# behind the dialog's mask). Their tests run three more times each on the same tree (a794459b1), each run into
# its own directory, to tell one run's variance from a change the merge brought. Same isolation as final-v2.sh;
# outputs in runs-final/rerun-*; then the hashes of the two shots in every run of every round.
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
cp $DEL/docs/evidence/base-ui-migration/p3.2/p32-reference.config.mjs $DEL/src/web/ui-migration/
for i in 1 2 3; do
  run rerun-p0-projects-$i env P32_SNAPSHOTS=$R/rerun-p0-projects-$i-shots P32_OUTPUT=$R/rerun-p0-projects-$i-out P32_PORT=4173 \
    npx playwright test --config ui-migration/p32-reference.config.mjs --update-snapshots=all --project chromium-dark-phone -g "projects"
  run rerun-pilot-share-$i env P32_SNAPSHOTS=$R/rerun-pilot-share-$i-shots P32_OUTPUT=$R/rerun-pilot-share-$i-out P32_PORT=4321 \
    npx playwright test --config ui-migration/pilot.config.mjs --update-snapshots=all --project webkit-light-desktop -g "share dialog pilot"
done
rm -f $DEL/src/web/ui-migration/p32-reference.config.mjs
cd $V
for shot in f-p0:g-p0:rerun-p0-projects:chromium-dark-phone/projects-list pilot:g-pilot:rerun-pilot-share:webkit-light-desktop/pilot-share-public \
            pilot:g-pilot:rerun-pilot-share:webkit-light-desktop/pilot-share-private; do
  IFS=: read -r a g r s <<< "$shot"
  echo "== $s"
  for f in runs-def134095/$a-ref runs-def134095/$a-base runs-def134095/$a-del runs-bcc89c7af/$a-ref runs-bcc89c7af/$a-base runs-bcc89c7af/$a-del \
           runs/$a-ref runs/$a-base runs/$a-del runs-final/$g-del runs-final/$r-1 runs-final/$r-2 runs-final/$r-3; do
    [ -f "$f-shots/$s.png" ] && printf '   %-36s %s\n' "$f" "$(sha256sum "$f-shots/$s.png" | cut -c1-16)"
  done
done
