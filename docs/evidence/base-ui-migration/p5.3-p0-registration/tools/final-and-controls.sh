#!/usr/bin/env bash
# Resumable queue (a run whose exit.txt exists is skipped), after the registration commit, one browser run at a time:
#   final-round-1, final-round-2: the unchanged P0 command on this task's worktree (clean, HEAD = registration);
#   nc-menu, nc-chip: the same command on a scratch sparse worktree at the registration commit with one CSS patch
#   appended to src/web/src/index.css and pinned by a scratch commit (never pushed or delivered).
set -u
. /mnt/data/tmp/34dTUdzY6mgNk4CGh7ZHl/tools/lib.sh
REG=${REG:?registration commit}
NC=$B/trees/nc
echo "worktree HEAD $(git -C $WT rev-parse HEAD) status [$(git -C $WT status --porcelain | wc -l)] registration $REG; $(date -u +%FT%TZ)"
test "$(git -C $WT rev-parse HEAD)" = "$REG" || { echo "worktree HEAD is not the registration commit"; exit 2; }
test -z "$(git -C $WT status --porcelain)" || { echo "worktree is not clean"; exit 2; }
for n in 1 2; do
  if [ ! -f $R/final-round-$n/exit.txt ]; then
    gate; rm -rf $R/final-round-$n
    capped bash $NETNS $WT $R/final-round-$n; echo "step final-round-$n exit $?"
  fi
done
for c in menu chip; do
  [ -f $R/nc-$c/exit.txt ] && continue
  if [ ! -d $NC ]; then
    git -C $WT worktree add --no-checkout --detach $NC $REG > /dev/null || exit 2
    git -C $NC sparse-checkout set --no-cone '/*' '!/*/' '/src/' '!/src/*/' '/src/web/' '/src/shared/' '/scripts/worktree-overlay.sh' \
      /docs/evidence/base-ui-migration/p0.2/ /docs/evidence/base-ui-migration/p0-drift/ /docs/evidence/base-ui-migration/p3.2/README.md \
      /docs/evidence/base-ui-migration/p4.1/README.md /docs/evidence/base-ui-migration/p2.3-b1/README.md \
      /docs/evidence/base-ui-migration/p0-drift-2/isolation/profile-validation-b1-fix.json \
      /docs/evidence/base-ui-migration/webkit-scroll-lock/README.md /docs/evidence/base-ui-migration/p5.3/README.md || exit 2
    ln -sfn $WT/node_modules $NC/node_modules; mkdir -p $NC/src/web/node_modules
    cp -a $WT/src/web/node_modules/@orbit $WT/src/web/node_modules/@types $NC/src/web/node_modules/
  fi
  git -C $NC checkout -q --detach $REG && git -C $NC reset -q --hard $REG || exit 2
  cat $B/tools/negative-control-$c.css >> $NC/src/web/src/index.css
  git -C $NC -c user.name=p5.3-registration-negative-control -c user.email=nc@p53reg.local commit -q -am "scratch: P5.3 accepted-layer negative control ($c), never delivered" || exit 2
  echo "nc-$c scratch commit $(git -C $NC rev-parse HEAD) on $(git -C $NC rev-parse HEAD^)"
  git -C $NC show --format= HEAD > $B/trees/nc-$c.patch.diff
  gate; rm -rf $R/nc-$c
  capped bash $NETNS $NC $R/nc-$c; echo "step nc-$c exit $?"
done
echo "queue done $(date -u +%FT%TZ)"
