#!/usr/bin/env bash
# trial-grep.sh NAME GREP PROJECTS...: the P4.3b spec (p43b config only), tests matching GREP, on ref and
# del with the worktree's current spec files copied in (untracked), for the given Playwright projects.
set -u
V=/mnt/data/tmp/34blYpxEcHMAf4oafuC2W
WT=/root/.orbit/worktrees/ba9b2bbb-b78b-5991-855c-183de0d5d9e3
name=$1; grep=$2; shift 2
projects=(); for p in "$@"; do projects+=(--project "$p"); done
export TMPDIR=$V/tmp
for tree in ref del; do
  cp $WT/src/web/ui-migration/p43b* $V/$tree/src/web/ui-migration/
  T=$V/try/$name-$tree; rm -rf $T
  ( cd $V/$tree/src/web && unshare -n bash -c 'ip link set lo up && exec "$@"' bash env P43B_SNAPSHOTS=$T/shots P43B_OUTPUT=$T/out P43B_PORT=4431 \
    nice npx playwright test --config ui-migration/p43b.config.mjs --update-snapshots=all -g "$grep" "${projects[@]}" --reporter=line > $T.log 2>&1 )
  echo "== $tree: $(grep -E '^\s+[0-9]+ (passed|failed|skipped|flaky)' $T.log | tr -s ' ' | tr '\n' ' ')"
done
