#!/usr/bin/env bash
# ro-loop-pair.sh OUTDIR: ro-loop-probe.mjs on four choices fixtures, RUNS (default 5) runs each in WebKit at phone size,
# light and dark: the delivery and the base as they are, the delivery with a stand-in for the "Open legacy Modal" button
# the base still draws above the regions (same label, nothing behind it), and the base without that button. Scratch
# checkouts (v1/exp-del, v1/exp-base, never pushed), the fixture edits undone after each variant; each variant's dev
# server alone in a private network namespace and a memory-capped scope.
set -u
OUT=${1:?outdir}; RUNS=${RUNS:-5}
V=/mnt/data/tmp/34Za39RS6A28G7xPqMD0p/v1
WT=/root/.orbit/worktrees/05c9af49-f99c-506f-b2c2-2c26a5edc79e
P=$WT/docs/evidence/base-ui-migration/p6/scripts/ro-loop-probe.mjs
F=src/web/src/components/ui/__fixtures__/ChoicesFixture.tsx
mkdir -p "$OUT"
prepare() {
  local dir=$1 commit=$2 modules=$3
  [ -d "$dir" ] || git -C "$WT" worktree add -q --detach "$dir" "$commit"
  git -C "$dir" checkout -q --detach "$commit" && git -C "$dir" checkout -q -- .
  ln -sfn "$modules" "$dir/node_modules"
  mkdir -p "$dir/src/web/node_modules" && cp -a "$WT/src/web/node_modules/@orbit" "$WT/src/web/node_modules/@types" "$dir/src/web/node_modules/"
}
prepare $V/exp-del 6879542dc23a10a74417002810331a7e73778842 "$WT/node_modules"
prepare $V/exp-base f78e93f615fceda94eeea0c9cdd400fb44b7949e /var/tmp/p6-34Za39RS-start/node_modules
variant() {
  local name=$1 dir=$2
  for i in $(seq 1 60); do [ "$(free -m | awk '/Mem:/{print $7}')" -ge 4608 ] && break; sleep 30; done
  echo "== $name: $(git -C $dir rev-parse --short HEAD), fixture edit: [$(git -C $dir diff --stat -- $F | tail -1)]"
  systemd-run --scope --quiet -p MemoryMax=6G sh -c 'echo 500 > /proc/self/oom_score_adj && exec "$@"' sh unshare -n bash -c "
    ip link set lo up
    (cd $dir/src/web && exec setsid npm run dev -- --host 127.0.0.1 --port 4191 --strictPort > /dev/null 2>&1) & server=\$!
    for i in \$(seq 1 150); do curl -s -o /dev/null http://127.0.0.1:4191/ui-migration/choices.html && break; sleep 0.2; done
    for theme in light dark; do TREE=$dir PORT=4191 THEME=\$theme RUNS=$RUNS node $P $OUT/$name-\$theme.json; done
    kill -- -\$server 2>/dev/null
  "
  git -C $dir checkout -q -- $F
}
variant delivery $V/exp-del
sed -i 's|        <Button onClick={() => setDialog(true)}>Open Dialog</Button>|&\n        <Button>Open legacy Modal</Button>|' $V/exp-del/$F
variant delivery-with-button $V/exp-del
variant base $V/exp-base
sed -i '/<Button onClick={() => setLegacy(true)}>Open legacy Modal<\/Button>/d' $V/exp-base/$F
variant base-without-button $V/exp-base
