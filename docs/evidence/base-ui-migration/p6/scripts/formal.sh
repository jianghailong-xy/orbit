#!/usr/bin/env bash
# formal.sh RUN: P6's browser checks on the trees make-trees.sh laid down, written to v1/RUN:
#  - the P0 page matrix on the reference (antd's reset, ConfigProvider and App root) and on the delivery (Orbit's
#    reset and root), and a 0-pixel comparison of the delivery against the reference's screenshots;
#  - the standard P0 regression on the delivery and on the base;
#  - the six component-fixture configs on the delivery, and the same delivered specs on the base, the delivery's parent
#    (its fixtures still draw the AntD halves, under ConfigProvider/AntApp and antd's reset): the Orbit side before
#    and after P6;
#  - the batch tools' runtime census on the delivery (P4.4, P5.1, P5.2, P5.3's cases);
#  - the merge check (build and the full Vitest run) on the task worktree, and OrbitKit.
# Every step runs alone, in its own network namespace and a memory-capped scope with a raised OOM score (the runner
# is OOMPolicy=stop), after MemAvailable reaches 4.5 GB; TMPDIR and outputs are on /mnt/data. A step whose log ends
# with `exit=` is skipped, so the chain resumes where a stop left it. Stops when / has under 2 GB.
# (P5.3's formal.sh, for P6.)
set -u
RUN=${1:?run name}
T=/mnt/data/tmp/34Za39RS6A28G7xPqMD0p
V=$T/v1
R=$V/$RUN
REF=$V/ref
BASE=$V/base
DEL=$V/del
E=/root/.orbit/worktrees/05c9af49-f99c-506f-b2c2-2c26a5edc79e/docs/evidence/base-ui-migration
export TMPDIR=$V/tmp
mkdir -p "$R" "$TMPDIR"
gate() {
  local a; a=$(df --output=avail -BM / | tail -1 | tr -dc '0-9')
  if [ "$a" -lt 2048 ]; then echo "== STOP: / has ${a}M available (< 2 GB) $(date -u +%T)"; exit 3; fi
  for i in $(seq 1 60); do [ "$(free -m | awk '/Mem:/{print $7}')" -ge 4608 ] && break; sleep 30; done
}
step() {
  local name=$1 tree=$2; shift 2
  if [ -f "$R/$name.txt" ] && grep -q '^exit=' "$R/$name.txt"; then echo "== $name already done ($(grep '^exit=' "$R/$name.txt"))"; return 0; fi
  gate
  { echo "argv: $*"; echo "tree: $tree"; echo "head: $(git -C $tree rev-parse HEAD)"; echo "uncommitted:"; git -C $tree status --short -- src/web
    echo "load: $(cat /proc/loadavg)"; echo "mem: $(free -m | awk '/Mem:/{print $7}')M available"
    echo "disk: / $(df --output=avail -BM / | tail -1 | tr -d ' ') available, TMPDIR $TMPDIR"; echo "started: $(date -u +%FT%TZ)"; echo; } > "$R/$name.txt"
  echo "== $name $(date -u +%T)"
  ( cd "$tree/src/web" && systemd-run --scope --quiet -p MemoryMax=6G sh -c 'echo 500 > /proc/self/oom_score_adj && exec "$@"' sh \
      nice -n -5 unshare -n bash -c 'ip link set lo up && exec "$@"' bash "$@" ) >> "$R/$name.txt" 2>&1
  local code=$?
  { echo "exit=$code"; echo "load: $(cat /proc/loadavg)"; echo "ended: $(date -u +%FT%TZ)"; } >> "$R/$name.txt"
  grep -E "^\s+[0-9]+ (passed|failed|flaky|skipped|did not run)|Test Files|Tests |^exit=|error TS" "$R/$name.txt"
}
# The P0 page matrix pair (P3.2's p32-reference.config.mjs: screenshots read from or written to P32_SNAPSHOTS).
for t in $REF $DEL; do cp $E/p3.2/p32-reference.config.mjs $t/src/web/ui-migration/; done
step p0-ref $REF env P32_SNAPSHOTS=$R/p0-ref-shots P32_OUTPUT=$R/p0-ref-out P32_PORT=4173 npx playwright test --config ui-migration/p32-reference.config.mjs --update-snapshots=all
step p0-strict $DEL env P32_SNAPSHOTS=$R/p0-ref-shots P32_OUTPUT=$R/p0-strict-out P32_PORT=4173 npx playwright test --config ui-migration/p32-reference.config.mjs --update-snapshots=none
step p0-del $DEL env P32_SNAPSHOTS=$R/p0-del-shots P32_OUTPUT=$R/p0-del-out P32_PORT=4173 npx playwright test --config ui-migration/p32-reference.config.mjs --update-snapshots=all
rm -f $REF/src/web/ui-migration/p32-reference.config.mjs $DEL/src/web/ui-migration/p32-reference.config.mjs
# The standard P0 regression (expected screenshots: the P0.2 originals and their registered layers).
step p0-standard $DEL npx playwright test --config ui-migration/playwright.config.mjs
mkdir -p $R/p0-standard-out && cp -a $DEL/src/web/.ui-migration-results/. $R/p0-standard-out/
step p0-standard-base $BASE npx playwright test --config ui-migration/playwright.config.mjs
mkdir -p $R/p0-standard-base-out && cp -a $BASE/src/web/.ui-migration-results/. $R/p0-standard-base-out/
# The component fixtures: the delivered specs on the delivery, then the same specs on the base.
FIXTURE_SPECS=(foundation.browser.mjs controls.browser.mjs overlays.browser.mjs overlays-app-frame.browser.mjs overlays-close-hover.browser.mjs
  choices.browser.mjs choices-first-frame.browser.mjs choices-first-option.browser.mjs choices-lifecycle.browser.mjs choices-motion.browser.mjs
  choices-open-value.browser.mjs choices-submenu-geometry.browser.mjs toasts.browser.mjs composer.browser.mjs composer-checks.mjs
  composer-cost.browser.mjs composer-input.browser.mjs)
for config in foundation controls overlays choices toasts composer; do
  step fixtures-del-$config $DEL npx playwright test --config ui-migration/$config.config.mjs
  mkdir -p $R/fixtures-del-$config-out && cp -a $DEL/src/web/.$config-results/. $R/fixtures-del-$config-out/
done
if [ ! -f $R/base-specs.txt ]; then
  for f in "${FIXTURE_SPECS[@]}"; do cp $DEL/src/web/ui-migration/$f $BASE/src/web/ui-migration/$f; done
  { echo "base tree: $(git -C $BASE rev-parse HEAD), with the delivery's specs copied in:"; git -C $BASE status --short -- src/web; } > $R/base-specs.txt
fi
for config in foundation controls overlays choices toasts composer; do
  step fixtures-base-$config $BASE npx playwright test --config ui-migration/$config.config.mjs
  mkdir -p $R/fixtures-base-$config-out && cp -a $BASE/src/web/.$config-results/. $R/fixtures-base-$config-out/
done
git -C $BASE checkout -q -- src/web/ui-migration && { echo "after the runs:"; git -C $BASE status --short -- src/web; } >> $R/base-specs.txt
# The runtime census the batch tools keep ([class*="ant-"] on every step they record, the icons' anticon excepted; the
# coordinator's 2026-10-10 decision keeps it as this batch's runtime check): P4.4's, P5.1's, P5.2's and P5.3's cases on
# the delivery alone. Their screenshots are written, not compared; census.py reads every step's `antd` field.
for b in p44 p51 p52 p53; do
  B=$(echo $b | tr a-z A-Z)
  step census-$b $DEL env ${B}_SNAPSHOTS=$R/census-$b-shots ${B}_OUTPUT=$R/census-$b-out ${B}_PORT=4173 npx playwright test --config ui-migration/$b.config.mjs --update-snapshots=all
done
# The merge check on the task worktree (NVMe), as landing runs it.
WT=/root/.orbit/worktrees/05c9af49-f99c-506f-b2c2-2c26a5edc79e
step merge-check $WT bash -c "cd $WT && npm run build -w @orbit/web && npm run test -w @orbit/web"
# OrbitKit on a git archive of the delivery (swift:6.1, memory-capped): its parity tests read web sources P6 rewrote.
step orbitkit $DEL bash -c "rm -rf $V/orbitkit && mkdir -p $V/orbitkit && git -C $DEL archive HEAD | tar -x -C $V/orbitkit && docker run --rm --memory 6g -v $V/orbitkit:/repo -w /repo/src/macos/OrbitKit swift:6.1 swift test > $R/orbitkit-full.txt 2>&1; c=\$?; grep -E 'Executed|error:|failed' $R/orbitkit-full.txt | tail -20; exit \$c"
echo "== done $(date -u +%T)"
