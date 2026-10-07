#!/usr/bin/env bash
# Resumable queue (a run whose exit.txt exists is skipped), after the registration commit:
#   final-round-1, final-round-2: the unchanged P0 command on this worktree (clean, HEAD = registration);
#   nc-pill, nc-field-error: the same command on a scratch worktree at the registration commit with one CSS
#   patch appended to src/web/src/index.css and pinned by a scratch commit (never pushed or delivered).
set -u
WT=/root/.orbit/worktrees/9ea6fb9f-1cd9-54f7-a1c8-8ea427da353a
REG=${REG:?registration commit}
NETNS=$WT/docs/evidence/base-ui-migration/p0-drift-2/tools/netns-regression.sh
B=/var/tmp/p41acc; R=$B/runs; NC=$B/trees/nc; TOOLS=$B/tools
echo "worktree HEAD $(git -C $WT rev-parse HEAD) status [$(git -C $WT status --porcelain | wc -l)] registration $REG; $(date -u +%FT%TZ)"
test "$(git -C $WT rev-parse HEAD)" = "$REG" || { echo "worktree HEAD is not the registration commit"; exit 2; }
for n in 1 2; do
  if [ ! -f $R/final-round-$n/exit.txt ]; then
    rm -rf $R/final-round-$n; bash $NETNS $WT $R/final-round-$n; echo "step final-round-$n exit $?"
  fi
  df -h / | tail -1
done
# The scratch tree: the sparse before tree, moved and pointed at the registration commit.
if [ ! -d $NC ]; then
  git -C $WT worktree move $B/trees/before-a84bc61e7 $NC || exit 2
  git -C $NC sparse-checkout add '/docs/evidence/base-ui-migration/p4.1/README.md' || exit 2
fi
for c in pill field-error; do
  [ -f $R/nc-$c/exit.txt ] && continue
  git -C $NC checkout -q --detach $REG && git -C $NC reset -q --hard $REG || exit 2
  (cd $NC && bash scripts/worktree-overlay.sh) > $B/trees/nc-overlay-$c.txt 2>&1 || { echo "overlay failed"; exit 2; }
  cat $TOOLS/negative-control-$c.css >> $NC/src/web/src/index.css
  git -C $NC -c user.name=p4.1-accepted-negative-control -c user.email=nc@p41acc.local commit -q -am "scratch: P4.1 accepted-layer negative control ($c), never delivered" || exit 2
  echo "nc-$c scratch commit $(git -C $NC rev-parse HEAD) on $(git -C $NC rev-parse HEAD^)"
  git -C $NC show --format= HEAD > $B/trees/nc-$c.patch.diff
  rm -rf $R/nc-$c; bash $NETNS $NC $R/nc-$c; echo "step nc-$c exit $?"
  df -h / | tail -1
done
echo "queue done $(date -u +%FT%TZ)"
