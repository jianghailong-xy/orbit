#!/usr/bin/env bash
# Resumable queues (a run whose exit.txt exists is skipped), after the registration commit. Usage:
#   final-and-controls.sh final     final-round-1, final-round-2: the unchanged P0 command on this worktree (HEAD = the
#                                   registration commit, no tracked changes), one right after the other;
#   final-and-controls.sh controls  nc-pill, nc-error-card: the same command on a scratch worktree at the registration
#                                   commit (the before tree, pointed at it) with one CSS patch appended to
#                                   src/web/src/index.css and pinned by a scratch commit (never pushed or delivered).
set -u
WT=/root/.orbit/worktrees/63507a7e-d688-5155-900e-de51850b6416
REG=${REG:?registration commit}
NETNS=$WT/docs/evidence/base-ui-migration/p0-drift-2/tools/netns-regression.sh
B=/mnt/data/tmp/34cfhmpygHQdZxRznyVH9; R=$B/runs; NC=$B/trees/before-15b7b5609
TOOLS=$WT/docs/evidence/base-ui-migration/webkit-scroll-lock-accepted/tools
REG=$(git -C $WT rev-parse "$REG")
case "${1:-}" in
final)
  echo "worktree HEAD $(git -C $WT rev-parse HEAD) tracked changes [$(git -C $WT status --porcelain --untracked-files=no | wc -l)] registration $REG; $(date -u +%FT%TZ)"
  test "$(git -C $WT rev-parse HEAD)" = "$REG" || { echo "worktree HEAD is not the registration commit"; exit 2; }
  test -z "$(git -C $WT status --porcelain --untracked-files=no)" || { echo "worktree has tracked changes"; exit 2; }
  for n in 1 2; do
    if [ ! -f $R/final-round-$n/exit.txt ]; then
      rm -rf $R/final-round-$n; bash $NETNS $WT $R/final-round-$n; echo "step final-round-$n exit $?"
    fi
    df -BM / | tail -1
  done
  ;;
controls)
  echo "scratch tree $NC, registration $REG; $(date -u +%FT%TZ)"
  for c in pill error-card; do
    [ -f $R/nc-$c/exit.txt ] && continue
    git -C $NC checkout -q --detach $REG && git -C $NC reset -q --hard $REG || exit 2
    (cd $NC && bash scripts/worktree-overlay.sh) > $B/logs/nc-overlay-$c.txt 2>&1 || { echo "overlay failed"; exit 2; }
    cat $TOOLS/negative-control-$c.css >> $NC/src/web/src/index.css
    git -C $NC -c user.name=webkit-scroll-lock-accepted-negative-control -c user.email=nc@34cfh.local commit -q -am "scratch: scroll-lock accepted-layer negative control ($c), never delivered" || exit 2
    echo "nc-$c scratch commit $(git -C $NC rev-parse HEAD) on $(git -C $NC rev-parse HEAD^)"
    git -C $NC show --format= HEAD > $B/logs/nc-$c.patch.diff
    rm -rf $R/nc-$c; bash $NETNS $NC $R/nc-$c; echo "step nc-$c exit $?"
  done
  git -C $NC checkout -q --detach $REG && git -C $NC reset -q --hard $REG
  ;;
*) echo "usage: REG=<commit> final-and-controls.sh final|controls"; exit 2 ;;
esac
echo "queue $1 done $(date -u +%FT%TZ)"
