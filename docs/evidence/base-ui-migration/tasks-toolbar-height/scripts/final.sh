#!/usr/bin/env bash
# final.sh GROUP: the final checks on the rebased trees, one group per Orbit background job:
#   stats  -- repeated-run statistics: the resident spec (ui-migration/tasks-toolbar.browser.mjs, 4 fresh pages per case
#             and project) 5 rounds on the delivery and 2 on the base, and P4.3a's keys geometry probe 4 rounds on the
#             delivery and 2 on the base, interleaved so both trees see the same host conditions;
#   p43a   -- P4.3a's same-commit cases (p43a*.browser.mjs, all 8 environments, screenshots written) on the base, then on
#             the delivery; compared afterwards with P4.3a's tools;
#   p0     -- the standard P0 regression on the delivery, then on the base;
#   audit  -- audit-antd.mjs --check-owners on the delivery.
# base = origin/main 9c86b3dfe (the project line is in it), delivery = base + the fix and the resident spec. Every step
# logs argv, tree, HEAD, load and disk at the start and the exit code at the end; a step already logged with an exit
# code is not run again. Each run in its own network namespace and memory-capped scope; root-disk gate at 2 GB.
set -u
T=/mnt/data/tmp/34coPBqt8gi229cVNds0E
R=$T/runs
export TMPDIR=$T/tmp
mkdir -p "$R" "$TMPDIR"
gate() {
  local a; a=$(df --output=avail -BM / | tail -1 | tr -dc '0-9')
  if [ "$a" -lt 2048 ]; then echo "== STOP: / has ${a}M available (< 2 GB) $(date -u +%T)"; exit 3; fi
}
step() {
  local name=$1 tree=$2; shift 2
  if [ -f "$R/$name.txt" ] && grep -q '^exit=' "$R/$name.txt"; then echo "== $name already done ($(grep '^exit=' "$R/$name.txt"))"; return 0; fi
  gate
  { echo "argv: $*"; echo "tree: $tree"; echo "head: $(git -C $T/$tree rev-parse HEAD)"; echo "uncommitted:"; git -C $T/$tree status --short
    echo "load: $(cat /proc/loadavg)"; echo "memory: $(free -m | awk '/Mem:/ {print $7 " MB available"}')"; echo "disk: / $(df --output=avail -BM / | tail -1 | tr -d ' ') available, TMPDIR $TMPDIR"; echo "started: $(date -u +%FT%TZ)"; echo; } > "$R/$name.txt"
  echo "== $name $(date -u +%T)"
  ( cd "$T/$tree/src/web" && "$T/scripts/scoped.sh" nice -n -5 unshare -n bash -c 'ip link set lo up && exec "$@"' bash "$@" ) >> "$R/$name.txt" 2>&1
  local code=$?
  { echo "exit=$code"; echo "load: $(cat /proc/loadavg)"; echo "ended: $(date -u +%FT%TZ)"; } >> "$R/$name.txt"
  grep -E "^\s+[0-9]+ (passed|failed|flaky|skipped|did not run)|^exit=" "$R/$name.txt" | tr -s ' ' | tr '\n' ' '; echo
}
resident() { step resident-$1-r$2 $1 env TASKS_TOOLBAR_OUTPUT=$R/resident-$1-r$2-out npx playwright test --config ui-migration/tasks-toolbar.config.mjs; }
geom() {
  local tree=$1 n=$2
  cp "$T/probe/p43a-keys-geom-probe.browser.mjs" "$T/$tree/src/web/ui-migration/"
  step geom-$tree-final-r$n $tree env P43A_SNAPSHOTS=$R/geom-$tree-final-r$n-shots P43A_OUTPUT=$R/geom-$tree-final-r$n-out \
    npx playwright test ui-migration/p43a-keys-geom-probe.browser.mjs --config ui-migration/p43a.config.mjs --project webkit-light-desktop --project webkit-dark-desktop
  rm -f "$T/$tree/src/web/ui-migration/p43a-keys-geom-probe.browser.mjs"
}
case $1 in
  stats)
    # The base tree does not carry the resident spec: copied in for its rounds, removed after.
    for n in 1 2 3 4 5; do
      resident fix $n
      if [ $n -le 2 ]; then
        cp /root/.orbit/worktrees/cc35355c-dd74-5ffe-b8f0-f16dd56d0d48/src/web/ui-migration/tasks-toolbar.{browser,config}.mjs $T/base/src/web/ui-migration/
        resident base $n
        rm -f $T/base/src/web/ui-migration/tasks-toolbar.browser.mjs $T/base/src/web/ui-migration/tasks-toolbar.config.mjs
      fi
      [ $n -le 4 ] && geom fix $n
      [ $n -le 2 ] && geom base $n
    done ;;
  p43a)
    step p43a-base base env P43A_SNAPSHOTS=$R/p43a-base-shots P43A_OUTPUT=$R/p43a-base-out npx playwright test --config ui-migration/p43a.config.mjs --update-snapshots=all
    step p43a-fix fix env P43A_SNAPSHOTS=$R/p43a-fix-shots P43A_OUTPUT=$R/p43a-fix-out npx playwright test --config ui-migration/p43a.config.mjs --update-snapshots=all ;;
  p0)
    step p0-standard fix npx playwright test --config ui-migration/playwright.config.mjs
    mkdir -p $R/p0-standard-out && cp -a $T/fix/src/web/.ui-migration-results/. $R/p0-standard-out/
    step p0-standard-base base npx playwright test --config ui-migration/playwright.config.mjs
    mkdir -p $R/p0-standard-base-out && cp -a $T/base/src/web/.ui-migration-results/. $R/p0-standard-base-out/ ;;
  audit)
    step audit-check-owners fix bash -c 'cd ../.. && node src/web/scripts/audit-antd.mjs --check-owners' ;;
esac
echo "== $1 done $(date -u +%T)"
